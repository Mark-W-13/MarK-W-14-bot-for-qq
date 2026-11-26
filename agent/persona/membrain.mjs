// 人格记忆架构(2026-11-26)—— 每个人格一套、结构完全相同的四层记忆。
//
// 参考 Anthropic《The components of agent memory》的层级与「做梦(dreaming)」思路:
//   ① 转录(transcripts):群聊记录,monitor 现取(fetchTranscript),本模块不存;
//   ② 记忆笔记(notes):模型在会话里用 add_memory 写 + 离线从记录里提炼;
//      存 agent/persona/mem/<人格>/notes.jsonl(见 persona/memory.mjs);
//   ③ 记忆表示(profile/wiki):每个群一份「群档案」,离线做梦时维护;
//      存 agent/persona/mem/<人格>/profiles/<群号>.json;
//   ④ 注入层(injected):每次回复只带**很小**的一块 —— 群档案摘要 + 这个人的笔记 + 风格 + 索引,
//      细节靠 list_memories 现查。注入层保持小,是论文里反复强调的(大了反而降低遵从)。
//
// 「做梦」做四件事(对应论文里的 dreaming):
//   · 校准:笔记跟群聊记录冲突/过时 → 以记录为准改写或删掉(论文的 Mt. Moon 教训);
//   · 合并:零散笔记合并成一条更清楚的,别让库无限膨胀;
//   · 补充:记录里反复出现、以后用得上的稳定信息写成新笔记;
//   · 沉淀:把长期结论写进「群档案」,并给一个 ≤120 字的 summary 供每次注入。
//
// 触发:每条群消息只计数(不逐条存);到量/到点才异步跑一次,绝不阻塞聊天。
// 成本护栏:每群「摘要」≥30 分钟一次、「做梦」≥90 分钟一次;都只在人格开着的群里跑。
//
// 人格独立:所有路径都带 personaId;删/备份一个人格不会碰到别人。人格模块只需要:
//   systemPrompt() 里调 personaMemoryBlock(id, {seed, scope, query});
//   monitor 里把消息计数转给 membrainOnMessage(id, gid, name);工具循环用 MEMORY_TOOLS。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  addMemory, deleteMemory, listMemories, memoryPromptBlock, memoryStats, updateMemory, MAX_MEMORY_CHARS,
} from './memory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const safeId = s => String(s || '').replace(/[^\w.-]+/g, '_').slice(0, 64) || '_';

/** 人格数据根(与 memory.mjs 共用 PERSONA_MEM_DIR;测试时换掉即隔离) */
export const memRoot = () => process.env.PERSONA_MEM_DIR || join(__dirname, 'mem');
export const personaDataDir = personaId => join(memRoot(), safeId(personaId));
export const profilePathOf = (personaId, groupId) => join(personaDataDir(personaId), 'profiles', safeId(groupId) + '.json');
const dreamStatePathOf = personaId => join(personaDataDir(personaId), 'dream_state.json');

// ---------- 可调参数(env 是启动期常量,改完重启 monitor 生效) ----------
const CAPTURE_EVERY = Math.max(20, num(process.env.PERSONA_MEMORY_EVERY, 100));          // 每 N 条消息提炼一次
const CAPTURE_MIN_MS = Math.max(60_000, num(process.env.PERSONA_MEMORY_MIN_MS, 30 * 60_000));
const CAPTURE_STALE_MS = Math.max(CAPTURE_MIN_MS, num(process.env.PERSONA_MEMORY_STALE_MS, 6 * 3600_000));
const CAPTURE_CTX = Math.max(40, num(process.env.PERSONA_MEMORY_CTX, 120));
const CAPTURE_MAX_NOTES = Math.max(1, num(process.env.PERSONA_MEMORY_NOTES, 3));
const NOTE_MAX = Math.min(MAX_MEMORY_CHARS, Math.max(60, num(process.env.PERSONA_MEMORY_NOTE_CHARS, 200)));

const DREAM_EVERY = Math.max(30, num(process.env.PERSONA_DREAM_EVERY, 120));             // 每 N 条消息醒一次
const DREAM_MIN_MS = Math.max(60_000, num(process.env.PERSONA_DREAM_MIN_MS, 90 * 60_000));
const DREAM_STALE_MS = Math.max(DREAM_MIN_MS, num(process.env.PERSONA_DREAM_STALE_MS, 6 * 3600_000));
const DREAM_CTX = Math.max(60, num(process.env.PERSONA_DREAM_CTX, 150));
const DREAM_MIN_NOTES = Math.max(0, num(process.env.PERSONA_DREAM_MIN_NOTES, 0));
const PROFILE_MAX = Math.max(200, num(process.env.PERSONA_PROFILE_CHARS, 1200));
const PROFILE_SUMMARY_MAX = Math.max(40, num(process.env.PERSONA_PROFILE_SUMMARY_CHARS, 120));
const DREAM_MAX_ADDS = Math.max(0, num(process.env.PERSONA_DREAM_MAX_ADDS, 5));
const DREAM_MAX_FIX = Math.max(0, num(process.env.PERSONA_DREAM_MAX_FIX, 5));
const DREAM_MAX_MERGE = Math.max(0, num(process.env.PERSONA_DREAM_MAX_MERGE, 2));
const DREAM_MAX_DROP = Math.max(0, num(process.env.PERSONA_DREAM_MAX_DROP, 10));
const DREAM_INPUT_NOTES = Math.max(10, num(process.env.PERSONA_DREAM_INPUT_NOTES, 60));
const GROUP_NOTE_CAP = Math.max(20, num(process.env.PERSONA_GROUP_NOTE_CAP, 80));
const USER_NOTE_CAP = Math.max(3, num(process.env.PERSONA_USER_NOTE_CAP, 8));

/** monitor 注入的依赖(不在本模块 import monitor,避免循环依赖) */
let deps = { fetchTranscript: null, postChat: null, model: '', personaNameOf: id => id, log: () => {} };
export function configureMembrain(d) {
  deps = { ...deps, ...(d || {}) };
}
/** 人格显示名(日志/提示词用);没注入就退回 id,绝不抛错。 */
const pnameOf = id => { try { return deps.personaNameOf?.(id) || id; } catch { return id; } };

// ---------- 群档案(profile/wiki) ----------
function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + '.tmp', JSON.stringify(obj, null, 1), 'utf8');
  renameSync(p + '.tmp', p);
}

export function profileOf(personaId, groupId) {
  const gid = String(groupId || '').trim();
  if (!gid) return null;
  const p = profilePathOf(personaId, gid);
  const j = readJson(p);
  if (!j || typeof j !== 'object' || typeof j.text !== 'string') return null;
  return {
    group: gid,
    name: String(j.name || ''),
    summary: String(j.summary || '').slice(0, PROFILE_SUMMARY_MAX),
    text: String(j.text || '').slice(0, PROFILE_MAX),
    updatedAt: Number(j.updatedAt) || 0,
  };
}

function saveProfile(personaId, groupId, { summary = '', text = '', name = '' } = {}) {
  const gid = String(groupId || '').trim();
  const t = String(text || '').trim().slice(0, PROFILE_MAX);
  if (!gid || !t) return false;
  const old = profileOf(personaId, gid);
  const s = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, PROFILE_SUMMARY_MAX);
  if (old && old.text === t && old.summary === s && old.name === String(name || old.name || '')) return false;
  writeJsonAtomic(profilePathOf(personaId, gid), {
    v: 1,
    group: gid,
    name: String(name || old?.name || '').slice(0, 60),
    summary: s || (old?.summary || ''),
    text: t,
    updatedAt: Date.now(),
  });
  return true;
}

// ---------- 注入层 ----------
// 结构对每个人格完全一致:一句总原则 → 群档案(摘要)→ 这个人的记忆/风格/本群细节 → 索引。
// 详细内容由 memoryPromptBlock 负责(混合检索 + 字符预算),这里只在前面加「群档案摘要」。
export function personaMemoryBlock(personaId, { seed = [], scope = null, query = '', budgetChars } = {}) {
  const id = String(personaId || '').trim();
  if (!id) return '';
  const gid = scope?.group ? String(scope.group) : '';
  const prof = gid ? profileOf(id, gid) : null;
  const notes = memoryPromptBlock(id, { seed, scope, query, budgetChars });
  if (!prof?.summary && !notes) return '';
  const parts = [];
  if (prof?.summary) {
    parts.push(`【这个群的档案】长期沉淀;与当前对话冲突时,以当前对话为准。\n${prof.summary}`);
  }
  if (notes) parts.push(notes);
  return parts.join('\n\n');
}

// ---------- 计数与触发 ----------
const pending = new Map();                 // `${persona}|${gid}` -> 未处理消息数
const busy = new Set();                    // 同一人格+群同时只跑一个任务
const keyOf = (id, gid) => `${id}|${gid}`;

function loadDreamState(personaId) {
  const j = readJson(dreamStatePathOf(personaId), null);
  return j && typeof j === 'object' && j.groups && typeof j.groups === 'object' ? j : { v: 1, groups: {} };
}
function saveDreamState(personaId, st) {
  try { writeJsonAtomic(dreamStatePathOf(personaId), { v: 1, groups: st.groups || {} }); } catch { /* 写不了只影响节流,不影响记忆 */ }
}
/** 记录一次任务时间(用于节流);失败也不回滚 —— 宁可少跑,别把模型调用打成连环 */
function markDone(personaId, gid, kind) {
  const st = loadDreamState(personaId);
  const rec = st.groups[gid] || (st.groups[gid] = {});
  rec[`${kind}At`] = Date.now();
  saveDreamState(personaId, st);
}
function lastAt(personaId, gid, kind) {
  const st = loadDreamState(personaId);
  return Number(st.groups?.[gid]?.[`${kind}At`] || 0);
}

/**
 * 群消息入口:**只计数**,到量/到点才异步跑;返回的 Promise 可被调用方 catch。
 * 调用方必须确认「本群人格开着、有聊天 key、AI 闲聊总开关开着」再调。
 */
export async function membrainOnMessage(personaId, groupId, groupName = '') {
  const id = String(personaId || '').trim();
  const gid = String(groupId || '').trim();
  if (!id || !gid || !deps.postChat || !deps.fetchTranscript) return;
  if (String(process.env.PERSONA_MEMORY_ENABLED || '1') === '0') return;
  const k = keyOf(id, gid);
  const n = (pending.get(k) || 0) + 1;
  pending.set(k, n);
  const now = Date.now();

  const capDue = n >= CAPTURE_EVERY || (n >= 20 && now - lastAt(id, gid, 'capture') >= CAPTURE_STALE_MS);
  const dreamDue = n >= DREAM_EVERY || (n >= 20 && now - lastAt(id, gid, 'dream') >= DREAM_STALE_MS);
  if (!capDue && !dreamDue) return;
  if (busy.has(k)) return;
  busy.add(k);
  try {
    if (dreamDue && now - lastAt(id, gid, 'dream') >= DREAM_MIN_MS) {
      await dreamGroup(id, gid, { name: groupName });
      pending.set(k, 0);
    } else if (capDue && now - lastAt(id, gid, 'capture') >= CAPTURE_MIN_MS) {
      await captureGroup(id, gid);
      pending.set(k, 0);
    }
  } catch (e) {
    deps.log(`  🧠 ${id} 记忆任务失败:${e.message}`, 'yellow');
  } finally {
    busy.delete(k);
  }
}

// ---------- 解析模型输出 ----------
function parseJsonObject(raw) {
  const s = String(raw || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

// 机器人自身相关的「记忆」不算群记忆(2026-11-26 用户明确):史官/霸总这种自称、被要求扮演的人设、
// 拿 DeepSeek/提示词/投喂小说开的玩笑,都不该进群档案或事实笔记。提示词里已经写了规则,
// 这里再做一道兜底过滤 —— 只拦「明显在说机器人」的句子,正常的 AI 话题(昇腾/股价/黎曼)不受影响。
const BOT_META_RE = /(?:史官|霸总|机器人|bot).{0,24}(?:自称|人设|性格|口癖|扮演|要求|设定)|(?:deepseek).{0,16}(?:霸总|小说|文风|训练数据|投喂)|被投喂.{0,10}(?:小说|语料)/i;
function looksLikeBotMeta(s) { return BOT_META_RE.test(String(s || '')); }
/** 机器人相关的玩笑不是不能记,但要标成 joke,并在文本前写清「玩笑」——注入时单独一段,不当事实/人设。 */
function jokeify(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  return /^[（(]玩笑[）)]/.test(t) ? t : `（玩笑）${t}`;
}
/** 群档案里的机器人玩笑不删,挪到档案末尾单独的「玩笑/梗」段,并逐行标「玩笑」。 */
function sanitizeProfile(text) {
  const keep = [], jokes = [];
  for (const line of String(text || '').split('\n')) {
    if (!looksLikeBotMeta(line)) { keep.push(line); continue; }
    const clean = line.replace(/^\s*[-*]\s*/, '').replace(/^[（(]玩笑[）)]\s*/, '').trim();
    if (clean) jokes.push(clean);
  }
  if (jokes.length) {
    keep.push('', '玩笑/梗（是玩笑,不是事实,也不是人设;可以接梗,别当真）:');
    for (const j of jokes) keep.push(`- （玩笑）${j}`);
  }
  return keep.join('\n').trim();
}

// ---------- ① 提炼(每 100 条消息,1~3 条新笔记) ----------
export async function captureGroup(personaId, groupId) {
  const id = String(personaId || '').trim();
  const gid = String(groupId || '').trim();
  if (!deps.postChat || !deps.fetchTranscript) return 0;
  const tr = await deps.fetchTranscript(gid, CAPTURE_CTX, { botName: pnameOf(id), includeBot: false });
  const transcript = String(tr?.lines || '').slice(0, 6000);
  if (!transcript) return 0;
  let existing = [];
  try {
    existing = listMemories(id, { scope: { group: gid } }).slice(0, 30).map(e => e.text);
  } catch { /* 读不到已有记忆就不带 */ }
  const sys = `你在为群聊机器人整理「${pnameOf(id)}」的长期记忆。看最近的群聊,只提炼 1~${CAPTURE_MAX_NOTES} 条以后聊天真正用得上的。
原则:
- 只记稳定的:群友的固定梗/外号/关系、反复聊的话题、群里确认过的事实。
- 不记一次性闲聊、临时情绪、某一局的具体结果、隐私/敏感信息、别人明确不想被记的事。
- **玩笑/梗/反串可以记,但要标成 kind=joke,并在文本前写「（玩笑）」**——包括群友拿机器人/模型/提示词/训练数据开的玩笑。
  机器人自己的身份/自称/人设不要写成 fact;要记就记成 joke,让人一眼看出这是玩笑。
- 每条一句话,≤${NOTE_MAX} 字,客观写法;没有值得记的就输出 {"notes":[]}。
- kind: fact=事实/群友/梗;style=用户明确要求的说话风格调整(只有用户明确要求才记);joke=群里反复玩的玩笑/梗。
只输出 JSON:{"notes":[{"kind":"fact","text":"...","importance":0.5}]}`;
  const user = `${existing.length ? `已有记忆(不要重复):\n${existing.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n` : ''}群聊:\n${transcript}\n\n只输出 JSON。`;
  const r = await deps.postChat({
    model: deps.model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 500,
    reasoning_effort: 'none',
  }, `${id}记忆提炼`);
  const obj = parseJsonObject(r?.choices?.[0]?.message?.content);
  const arr = Array.isArray(obj?.notes) ? obj.notes : Array.isArray(obj?.memories) ? obj.memories : [];
  let added = 0;
  for (const x of arr.slice(0, CAPTURE_MAX_NOTES)) {
    const raw = clip(x?.text, NOTE_MAX);
    if (!raw) continue;
    const meta = looksLikeBotMeta(raw);
    const text = meta ? clip(jokeify(raw), NOTE_MAX) : raw;
    const rr = addMemory(id, text, {
      kind: meta ? 'joke' : (x?.kind === 'style' ? 'style' : 'fact'),
      scope: { group: gid },
      importance: Math.min(1, Math.max(0, Number(x?.importance) || 0.5)),
      src: 'auto-summary',
    });
    if (rr.ok && !rr.duplicate) {
      added++;
      deps.log(`  🧠 ${id} 记忆提炼:${text.slice(0, 60)}`, 'dim');
    }
  }
  markDone(id, gid, 'capture');
  deps.log(`  🧠 ${id} 记忆提炼:新增 ${added} 条(群 ${gid})`, 'dim');
  return added;
}

// ---------- ② 做梦(档案 + 校准 + 合并 + 补充) ----------
function noteLine(e) {
  const age = Math.floor((Date.now() - (e.createdAt || 0)) / 86400000);
  const scope = e.scope?.user ? `人${e.scope.user}` : e.scope?.group ? '群' : '全局';
  return `- ${e.id} | ${scope} | ${age <= 0 ? '今天' : age + '天前'} | 重要度 ${(e.importance ?? 0.5).toFixed(2)} | ${e.text}`;
}

export async function dreamGroup(personaId, groupId, { name = '', force = false } = {}) {
  const id = String(personaId || '').trim();
  const gid = String(groupId || '').trim();
  if (!id || !gid || !deps.postChat || !deps.fetchTranscript) return { ok: false, message: '依赖未注入' };
  const tr = await deps.fetchTranscript(gid, DREAM_CTX, { botName: pnameOf(id), includeBot: true });
  const transcript = String(tr?.lines || '').slice(0, 9000);
  if (!transcript) return { ok: false, message: '没有群聊记录' };
  const prof = profileOf(id, gid);
  if (!force) {
    const fresh = (listMemories(id, { includeSeed: false }) || []).filter(e => String(e.scope?.group || '') === gid).length;
    if (fresh < DREAM_MIN_NOTES && !prof) return { ok: false, message: '没有可整理的记忆' };
  }
  const notes = (listMemories(id, { includeSeed: false }) || [])
    .filter(e => String(e.scope?.group || '') === gid)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, DREAM_INPUT_NOTES);
  const noteText = notes.length ? notes.map(noteLine).join('\n') : '(空)';
  const sys = `你是群聊机器人「${pnameOf(id)}」的长期记忆整理器,现在做一次离线整理(做梦)。
材料:群聊记录(真实发生的事,可能有错别字/复读)、你现有的群档案、你现有的记忆笔记(带 id)。

要做四件事:
1. 群档案 profile:写这个群的长期档案,给以后的自己看。只写记录里能确认、以后聊天用得上的:
   群是干什么的、常驻成员怎么称呼/关系、群友之间的固定梗/黑话、群规矩/雷区、最近一段的大事。
   **常驻成员只写真人;机器人自己(脚刷周)不是群成员,不要写进成员名单。**
   不写一次性玩笑和流水账;≤${PROFILE_MAX} 字。summary 是**一句话摘要(≤${PROFILE_SUMMARY_MAX} 字)**,
   会每次带进上下文,写最关键的定位(群性质 + 谁常驻)。
2. 校准:笔记和群聊记录冲突/明显过时时,以记录为准。单条改写放 fix(id + 新文本);
   彻底没用/记错的放 drop。不要因为旧就一律删,只删真的过时/错的。
   如果现有档案里混进了下面的「不该写」内容,校准的时候把它删掉。
3. 合并:几条零散笔记能合成一条更清楚的(同类事件/同一个人)→ merge(ids ≥2 + 新文本,≤${DREAM_MAX_MERGE} 组)。
   合并是让记忆变少变清楚,不是换个说法再存一遍。
4. 补充:记录里反复出现、以后用得上的稳定信息 → add(≤${DREAM_MAX_ADDS} 条,每条 ≤${NOTE_MAX} 字)。
   关于某个人的私事 scope=user 并给 user(QQ 号);群共有的 scope=group。
   一次性的、纯复读的、别人的隐私别记。

**玩笑怎么记(2026-11-26 用户明确)**:
- 玩笑/梗可以写进群档案,但要放在末尾单独的「玩笑/梗(不是事实,也不是人设)」一段,每条前面标「（玩笑）」。
- 机器人相关的玩笑(史官/霸总/互指 bot/DeepSeek 被投喂小说)也可以记,但必须写成「群友拿它开玩笑」,不能写成机器人的身份或人设;
  换一个机器人/换一个人设就不成立的内容,一律归到玩笑段。
- 机器人(脚刷周)自己不是群成员,不要写进常驻成员名单。
- 群友对机器人提的使用要求(怎么骂人、发表情包、@ 谁、存图备注)——那是 style 笔记,不是群档案。
- summary 不写玩笑/机器人梗,只写群性质和常驻真人。
别人的私事不要写进群档案,也不要在群里主动说出来。不确定就保持原样(keep),不要编。

只输出 JSON:
{"summary":"…","profile":"…","add":[{"text":"…","kind":"fact","scope":"group","user":"","importance":0.5}],"fix":[{"id":"…","text":"…"}],"merge":[{"ids":["…","…"],"text":"…"}],"drop":["…"]}`;
  const user = `【群】${name || ''}(${gid})\n【现在】${new Date().toLocaleString('zh-CN', { hour12: false })}\n\n`
    + `【现有群档案】\n${prof?.text || '(空)'}\n\n【现有笔记】\n${noteText}\n\n【群聊记录】\n${transcript}\n\n只输出 JSON。`;
  const r = await deps.postChat({
    model: deps.model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 1600,
    reasoning_effort: 'none',
  }, `${id}做梦`);
  const obj = parseJsonObject(r?.choices?.[0]?.message?.content);
  if (!obj) {
    markDone(id, gid, 'dream');
    return { ok: false, message: '模型没给出合法 JSON' };
  }

  const valid = new Set(notes.map(e => e.id));
  const summary0 = clip(obj.summary, PROFILE_SUMMARY_MAX);
  const summary = looksLikeBotMeta(summary0) ? '' : summary0;       // 摘要里不许出现机器人自己的梗
  const profile = sanitizeProfile(String(obj.profile || '').trim().slice(0, PROFILE_MAX));
  const profSaved = profile ? saveProfile(id, gid, { summary, text: profile, name }) : false;

  let added = 0, fixed = 0, merged = 0, dropped = 0;
  // 先 fix(单条改写),再 add,再 merge,最后 drop —— 顺序不影响 id 合法性,但便于日志核对。
  for (const x of (Array.isArray(obj.fix) ? obj.fix : []).slice(0, DREAM_MAX_FIX)) {
    const mid = String(x?.id || '');
    const text = clip(x?.text, NOTE_MAX);
    if (!valid.has(mid) || !text || looksLikeBotMeta(text)) continue;
    const rr = updateMemory(id, mid, text);
    if (rr.ok) fixed++;
  }
  for (const x of (Array.isArray(obj.add) ? obj.add : []).slice(0, DREAM_MAX_ADDS)) {
    const raw = clip(x?.text, NOTE_MAX);
    if (!raw) continue;
    const meta = looksLikeBotMeta(raw);
    const text = meta ? clip(jokeify(raw), NOTE_MAX) : raw;
    const isUser = x?.scope === 'user' && /^\d{4,15}$/.test(String(x?.user || ''));
    const scope = isUser ? { group: gid, user: String(x.user) } : { group: gid };
    const rr = addMemory(id, text, {
      kind: meta ? 'joke' : (x?.kind === 'style' ? 'style' : 'fact'),
      scope,
      importance: Math.min(1, Math.max(0, Number(x?.importance) || 0.5)),
      src: meta ? 'dream-joke' : 'dream',
    });
    if (rr.ok && !rr.duplicate) added++;
  }
  for (const x of (Array.isArray(obj.merge) ? obj.merge : []).slice(0, DREAM_MAX_MERGE)) {
    const ids = [...new Set((Array.isArray(x?.ids) ? x.ids : []).map(String).filter(i => valid.has(i)))];
    const raw = clip(x?.text, NOTE_MAX);
    if (ids.length < 2 || !raw) continue;
    const meta = looksLikeBotMeta(raw);
    const text = meta ? clip(jokeify(raw), NOTE_MAX) : raw;
    const rr = addMemory(id, text, { kind: meta ? 'joke' : 'fact', scope: { group: gid }, importance: 0.6, src: meta ? 'dream-joke' : 'dream-merged' });
    if (!rr.ok) continue;
    for (const mid of ids) {
      const d = deleteMemory(id, mid);
      if (d.ok) merged++;
    }
  }
  for (const mid of (Array.isArray(obj.drop) ? obj.drop : []).slice(0, DREAM_MAX_DROP)) {
    if (!valid.has(String(mid))) continue;
    if (deleteMemory(id, String(mid)).ok) dropped++;
  }

  pruneNotes(id, gid);
  markDone(id, gid, 'dream');
  deps.log(`  🧠 ${id} 做梦[${name || gid}]:档案 ${profile.length} 字${profSaved ? '(更新)' : ''},`
    + `新增 ${added},改写 ${fixed},合并 ${merged},删除 ${dropped}`, 'dim');
  return { ok: true, profile: profile.length, added, fixed, merged, dropped };
}

/** 控制容量:每群只留最近/最重要的自动笔记;每人每个群的个人笔记只留最近几条。 */
function pruneNotes(personaId, groupId) {
  try {
    const gid = String(groupId);
    const auto = src => src === 'auto-summary' || src === 'auto-consolidated' || src === 'dream' || src === 'dream-merged';
    const all = listMemories(personaId, { includeSeed: false }).filter(e => String(e.scope?.group || '') === gid);
    const groupNotes = all.filter(e => !e.scope?.user && auto(e.src)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const e of groupNotes.slice(GROUP_NOTE_CAP)) deleteMemory(personaId, e.id);
    const byUser = new Map();
    for (const e of all.filter(e => e.scope?.user && auto(e.src))) {
      const arr = byUser.get(e.scope.user) || [];
      arr.push(e);
      byUser.set(e.scope.user, arr);
    }
    for (const arr of byUser.values()) {
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const e of arr.slice(USER_NOTE_CAP)) deleteMemory(personaId, e.id);
    }
  } catch { /* 裁剪失败不影响本次做梦 */ }
}

// ---------- CLI / 自测 ----------
async function selftest() {
  const chunks = [];
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; chunks.push(`${c ? '✓' : '✗'} ${m}`); };
  const root = join(process.env.TEMP || process.env.TMPDIR || '/tmp', `membrain-${process.pid}-${Date.now()}`);
  process.env.PERSONA_MEM_DIR = join(root, 'mem');
  delete process.env.PERSONA_MEMORY_PATH;

  const P = 'tester', G = 'g1';
  const scope = { group: G, user: 'u1' };
  addMemory(P, '甲喜欢磁石卡组', { scope: { group: G }, importance: 0.8, src: 'auto-summary' });
  addMemory(P, '乙是群主', { scope: { group: G }, importance: 0.7, src: 'auto-summary' });
  addMemory(P, '旧说法:甲在杭州', { scope: { group: G }, importance: 0.5, src: 'auto-summary' });

  const block0 = personaMemoryBlock(P, { scope, query: '磁石' });
  ok(/甲喜欢磁石卡组/.test(block0), '注入块带本群笔记');
  ok(!/群档案/.test(block0), '还没有档案时不硬造');

  // 假模型 / 假转录:校准 + 合并 + 补充 + 档案
  const notes = listMemories(P, { scope: { group: G } });
  const idOld = notes.find(e => /杭州/.test(e.text)).id;
  const idA = notes.find(e => /甲喜欢/.test(e.text)).id;
  const idB = notes.find(e => /乙是群主/.test(e.text)).id;
  let calls = 0;
  configureMembrain({
    model: 'mock',
    personaNameOf: () => '测试人格',
    fetchTranscript: async () => ({ lines: '12:00 甲|我搬到上海了\n12:01 乙|欢迎\n12:02 甲|以后别记杭州了' }),
    postChat: async () => {
      calls++;
      if (calls === 1) {
        return { choices: [{ message: { content: JSON.stringify({
          summary: '游戏王群,甲和乙常驻',
          profile: '# 群档案\n- 游戏王群\n- 甲(磁石)、乙(群主)\n- 机器人自称史官,群友要求当霸总',
          add: [
            { text: '甲现在在上海', scope: 'group', kind: 'fact', importance: 0.8 },
            { text: '群友拿DeepSeek被投喂霸总小说开玩笑', scope: 'group', kind: 'fact', importance: 0.5 },
          ],
          fix: [{ id: idOld, text: '甲搬到上海了' }],
          merge: [{ ids: [idA, idB], text: '甲喜欢磁石,乙是群主' }],
          drop: [],
        }) } }] };
      }
      return { choices: [{ message: { content: '{"notes":[{"kind":"fact","text":"群里常聊磁石","importance":0.6}]}' } }] };
    },
    log: () => {},
  });
  markDone(P, G, 'capture');   // 让 capture 不抢在 dream 前
  const dr = await dreamGroup(P, G, { name: '测试群', force: true });
  ok(dr.ok && dr.added === 2 && dr.fixed === 1 && dr.dropped === 0, `做梦:新增 ${dr.added}、改写 ${dr.fixed}`);
  ok(profileOf(P, G)?.summary === '游戏王群,甲和乙常驻', '群档案摘要写进去');
  ok(/玩笑\/梗/.test(profileOf(P, G)?.text || '') && /（玩笑）/.test(profileOf(P, G)?.text || ''),
    '机器人玩笑没丢,但在档案里单独标成「玩笑/梗」');
  const jokeNote = listMemories(P, { scope: { group: G } }).find(e => e.kind === 'joke');
  ok(!!jokeNote && /^（玩笑）/.test(jokeNote.text), '机器人玩笑记成 joke,并带「（玩笑）」前缀');
  ok(/上海/.test(listMemories(P, { scope: { group: G } }).map(e => e.text).join('|')), '冲突笔记按记录校准');
  ok(!listMemories(P, { scope: { group: G } }).some(e => /杭州/.test(e.text)), '旧说法被改写,不残留');
  ok(listMemories(P, { scope: { group: G } }).some(e => /甲喜欢磁石,乙是群主/.test(e.text)), '两条旧笔记合并成一条');

  const block = personaMemoryBlock(P, { scope, query: '甲' });
  ok(/【这个群的档案】/.test(block) && /游戏王群,甲和乙常驻/.test(block), '注入块 = 档案摘要 + 笔记');
  ok(/【群里的玩笑\/梗/.test(block), '玩笑单独成段注入(不当事实/人设)');
  ok(block.length < 1600, `注入块有预算(${block.length} 字符)`);

  const st = memoryStats(P);
  ok(st.dynamic >= 3, `统计动态条数 ${st.dynamic}`);
  ok(existsSync(profilePathOf(P, G)), '群档案落在该人格自己的目录');
  ok(existsSync(dreamStatePathOf(P)), '做梦节流状态落在该人格目录');

  console.log(chunks.join('\n'));
  console.log(`\n${chunks.length - bad}/${chunks.length} 通过`);
  process.exitCode = bad ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--selftest') || process.argv.length === 2) {
    selftest().catch(e => { console.error(e); process.exitCode = 1; });
  }
}
