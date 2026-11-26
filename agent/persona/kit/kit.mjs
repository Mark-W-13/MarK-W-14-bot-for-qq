// 人格共用工具库 kit(2026-11-26 从 agent/belial/belial.mjs 迁入并改名)。
//
// 这里只放**所有人格共用**的机制:分群开关、人格选择、群名片、接话概率、贴表情概率、
// 表情包库(上传/去重/标签/挑图)、回复拆分。人格身份(提示词/关键词/台词)在各自的
// agent/persona/<id>.mjs;记忆也按人格独立存(agent/persona/mem/<id>/,见 persona/membrain.mjs)。
//
// 状态仍存本目录的 state.json,**每次现读** —— 与 modes.json / tone.json / tieba/state.json 同一套:
// monitor 与 opsweb 是两个进程,写文件的一方不通知另一方,靠「用之前重读」保持即时生效。
// 表情包库在 agent/persona/kit/stickers/(种子表情入库,运维台上传的以 up_ 开头、不入库,见 .gitignore)。
//
// CLI:
//   node agent/persona/kit/kit.mjs --selftest         # 自测(临时文件/临时表情包目录,不碰线上)
//   node agent/persona/kit/kit.mjs <群号> [on|off]    # 读/写某个群的开关
//   node agent/persona/kit/kit.mjs --stickers         # 列表情包库
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createStickerStore } from './../stickerlib.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './../../env.mjs';   // 与其它模块同规矩:先加载 agent/.env,下面读 process.env 才拿得到

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 状态文件路径:**延迟解析**,自测里换 BELIAL_STATE_PATH 立刻生效(与 tieba 同一套) */
export const statePath = () => process.env.BELIAL_STATE_PATH || join(__dirname, 'state.json');
/** 表情包目录:**延迟解析**,自测里换 BELIAL_STICKER_DIR 立刻生效 */
export const stickerDir = () => process.env.BELIAL_STICKER_DIR || join(__dirname, 'stickers');

/** 非 @ 接话概率的初始默认值(实际值存 state.json,WebUI 滑杆可改,不用重启) */
export const NONAT_PROB_DEFAULT = Math.min(1, Math.max(0, Number(process.env.BELIAL_NONAT_PROB ?? 0.4)));

/** 独立「只贴表情不说话」触发概率(2026-10-30 用户要求;实际值存 state.json) */
export const REACT_PROB_DEFAULT = Math.min(1, Math.max(0, Number(process.env.PERSONA_REACT_PROB ?? 0.06)));

/** auto 模式概率上下限的初始默认值(实际值存 state.json,WebUI 可编辑) */
export const AUTO_MAX_PROB_DEFAULT = Math.min(1, Math.max(0, Number(process.env.BELIAL_AUTO_LOW_PROB ?? 0.35)));  // 低频上限
export const AUTO_MIN_PROB_DEFAULT = Math.min(1, Math.max(0, Number(process.env.BELIAL_AUTO_HIGH_PROB ?? 0.05))); // 高频下限

// ---------- 采样参数(env 是启动期常量,改完重启 monitor 生效) ----------
// 2026-10-26 改:从「1~3 句、80 字」收紧成「一条一句、最多 3 条」——
// B 站贝利亚头像/名称用户的评论实测:中位数 7 字,76% 不带标点,基本都是短句。
// 2026-10-29:字数只作目标,**不再按字数/逗号硬切**;长句原样一条发。
export const MAX_CHARS = Math.max(8, Number(process.env.BELIAL_MAX_CHARS || 50));       // 目标长度(不硬切)
export const MAX_REPLY = Math.max(1, Number(process.env.BELIAL_MAX_REPLY || 3));        // 一次最多发几条
// 2026-10-26 用户要求「也要过 AI 思考生成回复,不然太固定了」:默认开思考(BELIAL_THINK=0 可关)。
// 思考 token 也算在 max_tokens 里,所以开思考时默认给到 1600,别让思考把正文吃空。
export const THINK = process.env.BELIAL_THINK !== '0';
export const MAX_TOKENS = Math.max(128, Number(process.env.BELIAL_MAX_TOKENS || (THINK ? 1600 : 600)));
export const TEMPERATURE = Number(process.env.BELIAL_TEMPERATURE || 0.95);               // 要像人,别太板正
export const REPLY_GAP_MS = Math.max(0, Number(process.env.BELIAL_REPLY_GAP_MS ?? 700)); // 多条之间的间隔(模拟手打)
// 表情包不再由代码按概率发:模型自己通过 send_sticker 工具决定发不发、发哪张。
// 这里只保留「一次最多几张」的护栏,防止它一口气刷十几张。
export const MAX_STICKERS = Math.max(1, Number(process.env.BELIAL_MAX_STICKERS || 2));

// ---------- 分群开关状态 ----------
// state.json 形如 {"groups":{"123":true},"all":false,"except":{},"nonAtProb":0.4,"updatedAt":...}
// `all:true` 时所有群都算开着(运维台「全部群」开关);`except` 记「全部开着时单独关掉的群」——
// 没有它的话,「全部群」开着时在某个群发「人格 关」会关不掉(以前就是这么埋的坑)。
// `nonAtProb` 是「没人 @ 我时接话概率」,WebUI 滑杆直接改这里,monitor 每次现读。
// 人格 id(2026-11-26):不再有 belial;每个群用 `personas[群号]` 记一个 id,不记就是默认人格。
export const DEFAULT_PERSONA = 'jiaoshuazhou';
export const PERSONA_IDS = ['jiaoshuazhou', 'W14'];
export const PERSONA_LABELS = { jiaoshuazhou: '脚刷周', W14: 'W14' };

function defaults() { return { groups: {}, all: false, except: {}, personas: {}, cards: {}, autoReply: {}, nonAtProb: NONAT_PROB_DEFAULT, reactProb: REACT_PROB_DEFAULT, nonAtAuto: true, autoMaxProb: AUTO_MAX_PROB_DEFAULT, autoMinProb: AUTO_MIN_PROB_DEFAULT, updatedAt: 0 }; }

function loadState() {
  try {
    const j = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (!j || typeof j !== 'object') return defaults();
    const groups = {};
    const except = {};
    for (const [k, v] of Object.entries(j.groups || {})) if (v === true && /^\d{4,12}$/.test(k)) groups[k] = true;
    for (const [k, v] of Object.entries(j.except || {})) if (v === true && /^\d{4,12}$/.test(k)) except[k] = true;
    const personas = {};
    for (const [k, v] of Object.entries(j.personas || {})) if (/^\d{4,12}$/.test(k) && PERSONA_IDS.includes(v)) personas[k] = v;
    // 切人格前的群名片:关掉人格时恢复。空字符串也是合法值(清空名片),所以用「键是否存在」判断。
    const cards = {};
    for (const [k, v] of Object.entries(j.cards || {})) if (/^\d{4,12}$/.test(k) && typeof v === 'string') cards[k] = v;
    // 只记「关掉自动接话」的群(false);没有这个键 = 照常按概率自动接话。
    const autoReply = {};
    for (const [k, v] of Object.entries(j.autoReply || {})) if (/^\d{4,12}$/.test(k) && v === false) autoReply[k] = false;
    const rawProb = j.nonAtProb === undefined ? NONAT_PROB_DEFAULT : Number(j.nonAtProb);
    const nonAtProb = Number.isFinite(rawProb) ? Math.min(1, Math.max(0, rawProb)) : NONAT_PROB_DEFAULT;
    const rawReact = j.reactProb === undefined ? REACT_PROB_DEFAULT : Number(j.reactProb);
    const reactProb = Number.isFinite(rawReact) ? Math.min(1, Math.max(0, rawReact)) : REACT_PROB_DEFAULT;
    const rawMax = j.autoMaxProb === undefined ? AUTO_MAX_PROB_DEFAULT : Number(j.autoMaxProb);
    const rawMin = j.autoMinProb === undefined ? AUTO_MIN_PROB_DEFAULT : Number(j.autoMinProb);
    const autoMaxProb = Number.isFinite(rawMax) ? Math.min(1, Math.max(0, rawMax)) : AUTO_MAX_PROB_DEFAULT;
    const autoMinProb = Number.isFinite(rawMin) ? Math.min(1, Math.max(0, rawMin)) : AUTO_MIN_PROB_DEFAULT;
    return { groups, all: j.all === true, except, personas, cards, autoReply, nonAtProb, reactProb, nonAtAuto: j.nonAtAuto !== false, autoMaxProb, autoMinProb, updatedAt: Number(j.updatedAt) || 0 };
  } catch { return defaults(); }
}

function saveState(st) {
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    const prob = Number.isFinite(Number(st.nonAtProb)) ? Math.min(1, Math.max(0, Number(st.nonAtProb))) : NONAT_PROB_DEFAULT;
    const react = Number.isFinite(Number(st.reactProb)) ? Math.min(1, Math.max(0, Number(st.reactProb))) : REACT_PROB_DEFAULT;
    const autoMax = Number.isFinite(Number(st.autoMaxProb)) ? Math.min(1, Math.max(0, Number(st.autoMaxProb))) : AUTO_MAX_PROB_DEFAULT;
    const autoMin = Number.isFinite(Number(st.autoMinProb)) ? Math.min(1, Math.max(0, Number(st.autoMinProb))) : AUTO_MIN_PROB_DEFAULT;
    const body = JSON.stringify({ groups: st.groups, all: st.all === true, except: st.except || {}, personas: st.personas || {}, cards: st.cards || {}, autoReply: st.autoReply || {}, nonAtProb: prob, reactProb: react, nonAtAuto: st.nonAtAuto !== false, autoMaxProb: autoMax, autoMinProb: autoMin, updatedAt: Date.now() }, null, 2);
    writeFileSync(p + '.tmp', body, 'utf8');
    renameSync(p + '.tmp', p);                 // 原子替换:别让另一个进程读到半截文件
    return true;
  } catch { return false; }                    // 写不了只影响持久化,不影响本次运行
}

/** 本群开着人格模式吗?**每次现读文件** —— 运维台/群里改完立即生效,不用重启 */
export function isOn(groupId) {
  const st = loadState();
  const g = String(groupId);
  if (st.all === true) return st.except[g] !== true;
  return st.groups[g] === true;
}

/** 开/关某个群;groupId 传 '*' 表示全部群。返回 { ok, groupId, on, changed } */
export function setOn(groupId, on) {
  const g = String(groupId || '').trim();
  if (!g) return { ok: false, message: '群号为空' };
  if (g !== '*' && !/^\d{4,12}$/.test(g)) return { ok: false, message: '群号不合法' };
  const st = loadState();
  const before = g === '*' ? st.all === true : isOn(g);
  if (g === '*') {
    st.all = !!on;
    st.groups = {};                            // 全开/全关都回到干净状态
    st.except = {};
  } else if (on) {
    if (st.all) delete st.except[g];           // 全部开着时,单独打开 = 取消例外
    else st.groups[g] = true;
  } else {
    if (st.all) st.except[g] = true;           // 全部开着时,单独关 = 记例外
    delete st.groups[g];
  }
  const saved = saveState(st);
  if (!saved) return { ok: false, saved: false, groupId: g, on: !!on, changed: false, message: '写不进状态文件(state.json),检查 agent/persona/kit 目录权限' };
  return { ok: true, saved, groupId: g, on: !!on, changed: before !== !!on };
}

/** 运维台展示用:全部开着的群 + 是否「全部群」+ 全部开着时单独关掉的群 + 非@接话概率 + 每群人格 */
export function allOn() {
  const st = loadState();
  return { groups: Object.keys(st.groups), all: st.all === true, except: Object.keys(st.except || {}), personas: st.personas || {}, cards: st.cards || {}, autoReply: st.autoReply || {}, nonAtProb: st.nonAtProb, reactProb: st.reactProb, nonAtAuto: st.nonAtAuto !== false, autoMaxProb: st.autoMaxProb, autoMinProb: st.autoMinProb, updatedAt: st.updatedAt };
}

/** 本群用哪个人格(未设置 → 默认人格)。**每次现读文件** */
export function personaOf(groupId) {
  const st = loadState();
  const v = st.personas[String(groupId)];
  return PERSONA_IDS.includes(v) ? v : DEFAULT_PERSONA;
}

/**
 * 本群允许「没人 @ 也自动接话」吗(2026-11-26:按群单独关)。
 * 默认 true;state.autoReply[群] === false 才关。@ 回复不受影响。
 */
export function autoReplyOf(groupId) {
  return loadState().autoReply[String(groupId)] !== false;
}

/** 单独开/关某个群的自动接话(不动机器人是否在群里说话,@ 照常回) */
export function setAutoReply(groupId, on) {
  const g = String(groupId || '').trim();
  if (!/^\d{4,12}$/.test(g)) return { ok: false, message: '群号不合法' };
  const st = loadState();
  if (on) delete st.autoReply[g];
  else st.autoReply[g] = false;
  if (!saveState(st)) return { ok: false, message: '写不进状态文件(state.json)' };
  return { ok: true, groupId: g, autoReply: !!on };
}

/**
 * 设置本群人格,并顺带把群打开(点人格按钮 = 启用这个群)。
 * 群号 '*' 不支持(全部群只切开关,不统一切人格);人格 id 不合法直接拒。
 */
export function setPersona(groupId, persona) {
  const g = String(groupId || '').trim();
  if (!g || g === '*' || !/^\d{4,12}$/.test(g)) return { ok: false, message: '群号不合法' };
  if (!PERSONA_IDS.includes(persona)) return { ok: false, message: `未知人格:${persona}` };
  const st = loadState();
  st.personas[g] = persona;
  if (st.all) delete st.except[g];
  else st.groups[g] = true;
  if (!saveState(st)) return { ok: false, message: '写不进状态文件(state.json),检查 agent/persona/kit 目录权限' };
  return { ok: true, groupId: g, persona, on: true };
}

/** 切人格前的群名片(没记过 → undefined;空字符串表示「当时没有名片」) */
export function originalCardOf(groupId) {
  const st = loadState();
  const g = String(groupId);
  return Object.prototype.hasOwnProperty.call(st.cards, g) ? st.cards[g] : undefined;
}

/** 记下切人格前的群名片(只在第一次切人格时写,别被后面的人格名片覆盖) */
export function setOriginalCard(groupId, card) {
  const g = String(groupId || '').trim();
  if (!/^\d{4,12}$/.test(g)) return { ok: false, message: '群号不合法' };
  const st = loadState();
  if (Object.prototype.hasOwnProperty.call(st.cards, g)) return { ok: true, groupId: g, card: st.cards[g], kept: true };
  st.cards[g] = String(card ?? '');
  if (!saveState(st)) return { ok: false, message: '写不进状态文件(state.json)' };
  return { ok: true, groupId: g, card: st.cards[g], kept: false };
}

/** 恢复完原名片后清掉记录 */
export function clearOriginalCard(groupId) {
  const g = String(groupId || '').trim();
  const st = loadState();
  if (!Object.prototype.hasOwnProperty.call(st.cards, g)) return { ok: true, changed: false };
  delete st.cards[g];
  if (!saveState(st)) return { ok: false, message: '写不进状态文件(state.json)' };
  return { ok: true, changed: true };
}

/** 非 @ 接话概率(每次现读 state.json,滑杆改完立即生效) */
export function nonAtProbOf() { return loadState().nonAtProb; }

/** 改非 @ 接话概率;0~1,返回 { ok, prob } */
export function setNonAtProb(prob) {
  const n = Number(prob);
  if (!Number.isFinite(n)) return { ok: false, message: '概率必须是 0~1 的数字' };
  const v = Math.min(1, Math.max(0, n));
  const st = loadState();
  st.nonAtProb = v;
  if (!saveState(st)) return { ok: false, message: '写不进状态文件(state.json),检查 agent/persona/kit 目录权限' };
  return { ok: true, prob: v };
}

/** 独立「只贴表情不说话」的触发概率(每次现读 state.json) */
export function reactProbOf() { return loadState().reactProb; }

/** 改独立贴表情概率;0~1,返回 { ok, prob } */
export function setReactProb(prob) {
  const n = Number(prob);
  if (!Number.isFinite(n)) return { ok: false, message: '概率必须是 0~1 的数字' };
  const v = Math.min(1, Math.max(0, n));
  const st = loadState();
  st.reactProb = v;
  if (!saveState(st)) return { ok: false, message: '写不进状态文件(state.json),检查 agent/persona/kit 目录权限' };
  return { ok: true, prob: v };
}

/** 非 @ 接话概率是否用「按群聊频次自动」模式(默认开;关掉才用滑杆固定值) */
export function nonAtAutoOf() { return loadState().nonAtAuto !== false; }

/** 开/关自动模式;返回 { ok, auto } */
export function setNonAtAuto(on) {
  const st = loadState();
  st.nonAtAuto = !!on;
  if (!saveState(st)) return { ok: false, message: '写不进状态文件(state.json),检查 agent/persona/kit 目录权限' };
  return { ok: true, auto: st.nonAtAuto };
}

/** auto 模式的概率上下限:{ max=低频上限, min=高频下限 } */
export function autoProbsOf() {
  const st = loadState();
  return { max: st.autoMaxProb, min: st.autoMinProb };
}

/** 改 auto 上下限;可只传一个,0~1,上限必须 ≥ 下限 */
export function setAutoProbs({ max, min } = {}) {
  const st = loadState();
  const a = max === undefined ? st.autoMaxProb : Number(max);
  const b = min === undefined ? st.autoMinProb : Number(min);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > 1 || b < 0 || b > 1) {
    return { ok: false, message: 'auto 上下限必须是 0~1 的数字' };
  }
  if (a < b) return { ok: false, message: '低频上限不能小于高频下限' };
  st.autoMaxProb = a;
  st.autoMinProb = b;
  if (!saveState(st)) return { ok: false, message: '写不进状态文件(state.json),检查 agent/persona/kit 目录权限' };
  return { ok: true, max: a, min: b };
}

// ---------- 回复拆分:1~3 条,一句一条 ----------
// 2026-10-26:用户要求「可能回复 1-3 句、表情包独立成句、符合真人发送习惯」。
// 模型被要求一句一行;但它经常一口气写成一整段,所以这里按「行 → 句末标点 → 逗号 → 字数」
// 逐级拆,并合并短句到单条 ≤maxChars,最多 max 条。多出来的并进最后一条(并不下就丢)。
function cleanLine(s, names = []) {
  let t = String(s || '').replace(/\r/g, '').trim();
  // QQ 是纯文本,不渲染 Markdown:模型爱写的 **加粗**、*斜体*、`代码`、# 标题、> 引用都要去掉,
  // 只留文字。**必须先于列表符号处理**:否则开头的 `**` 会被当成项目符号吃掉一个星号。
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/\*\*/g, '');                                   // 落单的 ** 也清掉
  t = t.replace(/^(?:[-*•·]\s*|\d+[.、)）]\s*)/, '');          // 项目符号 / 序号(「11张」这种数字开头要保留)
  if (names.length) {
    const prefix = names.map(n => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    t = t.replace(new RegExp(`^(?:${prefix})\\s*[:：]\\s*`), ''); // 「人格名:」前缀
  }
  t = t.replace(/[（(][^）)]{1,24}[）)]/g, '');               // 括号动作/旁白
  t = t.replace(/\[[^\]]*\]/g, '');                           // [图片]/[表情包] 占位
  t = t.replace(/@\S+/g, '');                                 // @某人
  return t.trim();
}

/**
 * 把模型输出拆成 1~max 条**要分别发送**的消息。
 * 2026-10-29 用户要求:不要把长句硬拆。只按**换行**分条,
 * 句号、逗号、顿号、空格和字数都**不再切**;一个长句就原样发一条。
 * @param {{max?:number,names?:string[]}} opts names 是「xxx:」前缀要剥掉的人格名
 * @returns {string[]} 空数组表示模型没说人话
 */
export function splitReply(text, { max = MAX_REPLY, names } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const lines = [];
  for (const rawLine of raw.split('\n')) {
    const s = cleanLine(rawLine, names);
    if (s) lines.push(s);
  }
  if (lines.length > max) {
    // 超条数也不硬切句子:前 max-1 条原样,剩下的用空格并进最后一条
    const head = lines.slice(0, max - 1);
    head.push(lines.slice(max - 1).join(' '));
    return head;
  }
  return lines;
}
/** 旧名兼容(脚刷周模块曾 import 这个名字);新代码用 splitReply。 */
export const splitBelialReply = splitReply;

// ---------- 表情包库 ----------
// 通用贴图库(列表/上传校验/元数据/按标签挑图)在 ../stickerlib.mjs;
// 这里只填共用表情包目录、运行时元数据路径与种子描述。人格只是共用这套图,不再拥有它。
const STICKER_META = {
  '01_quanwei.jpg': { desc: '红披风贝利亚 + 书法「权威」', tags: ['权威', '披风', '装逼', '皇帝', '帅'] },
  '02_suit.jpg': { desc: '西装贝利亚,像个体面老板', tags: ['西装', '体面', '老板', '本大爷', '正经'] },
  '03_claw.jpg': { desc: '抬手亮爪,威胁/生气', tags: ['爪子', '威胁', '生气', '动手'] },
  '04_full.jpg': { desc: '贝利亚全身站姿', tags: ['全身', '站姿', '本尊', '帅'] },
  '05_nailiya.jpg': { desc: '贝利亚 + 奶龙合体「奶利亚」', tags: ['奶利亚', '奶龙', '可爱', '抽象', '搞笑'] },
  '06_nailong.jpg': { desc: '贝利亚与奶龙同框,配字「肺雾贝利亚」', tags: ['肺雾', '奶龙', '被黑', '破防', '搞笑'] },
  '07_guangzhiguo.jpg': { desc: '贝利亚全身 + 「光之国,本皇帝回来了」', tags: ['光之国', '回归', '本皇帝', '霸气'] },
  '08_benzhu.jpg': { desc: '西装贝利亚 + 「本皇帝很满意」', tags: ['满意', '得意', '认可', '本皇帝', '西装'] },
  '09_louyi.jpg': { desc: '贝利亚亮爪 + 「蝼蚁,跪下!」', tags: ['蝼蚁', '跪下', '威胁', '生气', '霸气'] },
  '10_shanle.jpg': { desc: '权威披风 + 「删了!」', tags: ['删了', '破防', '急', '权威', '搞笑'] },
  '11_hahaha.jpg': { desc: '贝利亚全身 + 「哈哈哈哈!」', tags: ['哈哈哈', '笑', '得意', '嘲讽'] },
  '12_bawang.jpg': { desc: '西装贝利亚 + 「贝利亚大王」', tags: ['贝利亚大王', '自称', '得意', '西装'] },
  '13_tieba_feiwu.jpg': { desc: '贴吧「肺雾」贝利亚竖中指', tags: ['肺雾', '竖中指', '急', '嘲讽'] },
  '14_tieba_anpeila.jpg': { desc: '黑暗大帝贝利亚「安培拉领死吧」', tags: ['安培拉', '黑暗大帝', '霸气'] },
  '15_tieba_quote.jpg': { desc: '贝利亚火焰战损截图 + 台词', tags: ['战损', '台词', '霸气', '帅'] },
};

// 种子表情的短名(WebUI 显示 / list_stickers 用);动态 AI 命名可覆盖
const SEED_LABELS = {
  '01_quanwei.jpg': '权威',
  '02_suit.jpg': '西装',
  '03_claw.jpg': '亮爪',
  '04_full.jpg': '全身',
  '05_nailiya.jpg': '奶利亚',
  '06_nailong.jpg': '肺雾',
  '07_guangzhiguo.jpg': '光之国',
  '08_benzhu.jpg': '满意',
  '09_louyi.jpg': '蝼蚁',
  '10_shanle.jpg': '删了',
  '11_hahaha.jpg': '哈哈哈',
  '12_bawang.jpg': '大王',
  '13_tieba_feiwu.jpg': '肺雾',
  '14_tieba_anpeila.jpg': '安培拉',
  '15_tieba_quote.jpg': '战损',
};

const store = createStickerStore({
  dir: stickerDir,
  metaPath: () => process.env.BELIAL_STICKER_META_PATH || join(__dirname, 'sticker_meta.json'),
  seedMeta: STICKER_META,
  seedLabels: SEED_LABELS,
  prefix: 'up_',
  fallbackName: 'beilia',
  maxBytes: Math.max(64 * 1024, Number(process.env.BELIAL_STICKER_MAX_BYTES || 5 * 1024 * 1024)),
});

export const MAX_STICKER_BYTES = store.MAX_STICKER_BYTES;
export const listStickers = store.listStickers;
export const stickerPath = store.stickerPath;
export const stickerMime = store.stickerMime;
export const stickerSegment = store.stickerSegment;
export const pickSticker = store.pickSticker;
export const stickerCatalog = store.stickerCatalog;
export const pickStickerForScene = store.pickStickerForScene;
export const resolveSticker = store.resolveSticker;
export const addSticker = store.addSticker;
export const addStickerAuto = store.addStickerAuto;
export const deleteSticker = store.deleteSticker;
export const setStickerMeta = store.setStickerMeta;
export const dynamicStickerMeta = store.dynamicStickerMeta;
export const removeStickerMeta = store.removeStickerMeta;
export const stickerMetaOf = store.stickerMetaOf;

// ---------- 自测 ----------
// 只测「共用机制」:开关 / 人格 / 自动接话 / 概率 / 群名片 / 表情包 / 回复拆分。
// 人格提示词的老测试已随人格模块迁走,别再加回这里。
function selftest() {
  const chunks = [];
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; chunks.push((c ? '✓ ' : '✗ ') + m); };

  const tmp = join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'kit-selftest-' + process.pid + '-' + Date.now());
  process.env.BELIAL_STATE_PATH = join(tmp, 'state.json');
  process.env.BELIAL_STICKER_DIR = join(tmp, 'stickers');
  process.env.BELIAL_STICKER_META_PATH = join(tmp, 'sticker_meta.json');

  // 分群开关
  ok(isOn('100000001') === false, '没设置过 → 默认关');
  ok(setOn('100000001', true).on === true && isOn('100000001') === true, '开某群 → 立刻是开(现读文件)');
  ok(isOn('100000002') === false, '别的群不受影响(分群参数)');
  ok(setOn('*', true).on === true && isOn('100000009') === true, '「全部群」开 → 所有群都开');
  ok(setOn('100000001', false).on === false && isOn('100000001') === false && isOn('100000002') === true,
    '「全部群」开着时单独关一个群 → 只关这个群(例外表)');
  ok(setOn('*', false).on === false && isOn('100000001') === false && isOn('100000002') === false, '「全部群」关 → 真的一个都不开');
  ok(setOn('abc', true).ok === false, '非法群号被拒');

  // 人格选择(2026-11-26:belial/sibyl 已移除,只剩脚刷周 + W14)
  ok(personaOf('100000001') === DEFAULT_PERSONA && DEFAULT_PERSONA === 'jiaoshuazhou', '没设置过人格 → 默认脚刷周');
  const pp = setPersona('100000001', 'W14');
  ok(pp.ok && personaOf('100000001') === 'W14' && isOn('100000001') === true, '切到 W14 → 现读生效,并顺带把群打开');
  ok(personaOf('100000002') === DEFAULT_PERSONA, '人格是分群参数,别的群不受影响');
  ok(setPersona('abc', 'jiaoshuazhou').ok === false && setPersona('100000001', 'nope').ok === false,
    '非法群号 / 未知人格被拒');
  ok(setOn('100000001', false).on === false && personaOf('100000001') === 'W14', '关掉后保留上次人格');

  // 按群的「自动接话」开关(2026-11-26:群 793874011 单独关)
  ok(autoReplyOf('100000003') === true, '自动接话默认开');
  const ar = setAutoReply('100000003', false);
  ok(ar.ok && autoReplyOf('100000003') === false && allOn().autoReply['100000003'] === false, '按群关掉自动接话');
  ok(setAutoReply('100000003', true).ok && autoReplyOf('100000003') === true && allOn().autoReply['100000003'] === undefined,
    '再打开 → 从 state.json 里删掉这条,不残留 false');
  ok(setAutoReply('abc', false).ok === false, '非法群号被拒');

  // 概率
  ok(Math.abs(nonAtProbOf() - NONAT_PROB_DEFAULT) < 1e-9, '非@接话概率默认 ' + Math.round(NONAT_PROB_DEFAULT * 100) + '%');
  const probSet = setNonAtProb(0.25);
  ok(probSet.ok && nonAtProbOf() === 0.25 && allOn().nonAtProb === 0.25, '滑杆改的非@概率写进 state.json 并立即读到');
  ok(setNonAtProb(2).prob === 1 && setNonAtProb(-1).prob === 0, '非@概率夹在 0~1');
  ok(nonAtAutoOf() === true, '非@接话自动模式默认开启');
  ok(setNonAtAuto(false).ok && nonAtAutoOf() === false && allOn().nonAtAuto === false, '关掉自动模式后读 state.json 生效');
  setNonAtAuto(true);
  const autoDefaults = autoProbsOf();
  ok(Math.abs(autoDefaults.max - AUTO_MAX_PROB_DEFAULT) < 1e-9 && Math.abs(autoDefaults.min - AUTO_MIN_PROB_DEFAULT) < 1e-9,
    'auto 模式有默认上下限');
  const autoSet = setAutoProbs({ max: 0.5, min: 0.1 });
  ok(autoSet.ok && Math.abs(autoProbsOf().max - 0.5) < 1e-9 && Math.abs(allOn().autoMinProb - 0.1) < 1e-9,
    'WebUI 改 auto 上下限写进 state.json 并立即读到');
  ok(setAutoProbs({ max: 0.01, min: 0.2 }).ok === false, '低频上限小于高频下限被拒');
  setAutoProbs({ max: AUTO_MAX_PROB_DEFAULT, min: AUTO_MIN_PROB_DEFAULT });
  setNonAtProb(NONAT_PROB_DEFAULT);
  ok(Math.abs(reactProbOf() - REACT_PROB_DEFAULT) < 1e-9, '独立贴表情概率默认 ' + Math.round(REACT_PROB_DEFAULT * 100) + '%');
  ok(setReactProb(0.12).ok && reactProbOf() === 0.12 && allOn().reactProb === 0.12, 'WebUI 改独立贴表情概率立即生效');
  ok(setReactProb(2).prob === 1 && setReactProb(-1).prob === 0, '贴表情概率夹在 0~1');
  setReactProb(REACT_PROB_DEFAULT);

  // 群名片(切人格前记下、关人格时恢复)
  ok(originalCardOf('100000004') === undefined, '没记过群名片 → undefined');
  ok(setOriginalCard('100000004', '原名片').ok && originalCardOf('100000004') === '原名片', '记下切人格前的群名片');
  ok(clearOriginalCard('100000004').ok && originalCardOf('100000004') === undefined, '恢复完清掉记录');
  ok(setOriginalCard('abc', 'x').ok === false, '非法群号被拒');

  // 表情包:加/列/取段/删;按文件头认格式;拒绝穿越与非图片
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANklEQVR4nO3NMQEAMAjEwKeqK6IikFoJYWHLCUjqvs6ms1qPgwEHyAFygBwgB8gBcoAcIAchH3JrAeTJv+L3AAAAAElFTkSuQmCC', 'base64');
  const add = addSticker(png, '测试 表情.png');
  ok(add.ok && listStickers().length === 1, '上传一张 PNG → 表情包库有 1 张(' + add.name + ')');
  ok(add.name.startsWith('up_') && add.name.endsWith('.png'), '上传的文件加 up_ 前缀、按文件头定扩展名');
  ok(stickerPath(add.name) && stickerSegment(add.name)?.data?.file?.startsWith('base64://'), '能取到文件、能转成 OneBot base64 图片段');
  ok(stickerPath('../state.json') === null && stickerPath('x.html') === null, '路径穿越与非图片扩展名被拒');
  ok(addSticker(Buffer.from('<svg></svg>'), 'x.svg').ok === false, '伪装的 SVG/HTML 被拒(只认文件头)');
  ok(addSticker(Buffer.alloc(MAX_STICKER_BYTES + 1), 'big.png').ok === false, '超大文件被拒');
  ok(pickSticker(() => 0) === add.name, '随机挑表情包(钉死随机数)');
  ok(deleteSticker(add.name).ok === true && listStickers().length === 0, '删除后表情包库为空');

  // 目录/标签(用两张真种子图放进临时目录)
  try {
    const seedDir = join(__dirname, 'stickers');
    const tmpDir = process.env.BELIAL_STICKER_DIR;
    writeFileSync(join(tmpDir, '01_quanwei.jpg'), readFileSync(join(seedDir, '01_quanwei.jpg')));
    writeFileSync(join(tmpDir, '10_shanle.jpg'), readFileSync(join(seedDir, '10_shanle.jpg')));
    const cat = stickerCatalog();
    ok(cat.length === 2 && cat.some(s => s.name === '01_quanwei.jpg' && s.tags.includes('权威')),
      '表情包目录带描述/标签(list_stickers 用)');
    ok(resolveSticker({ name: '权威' }) === '01_quanwei.jpg', '按标签「权威」挑到 01_quanwei');
    ok(resolveSticker({ name: '01_quanwei' }) === '01_quanwei.jpg', '按文件名前缀挑到 01_quanwei');
    ok(resolveSticker({ scene: '被叫肺雾很急' }) === '10_shanle.jpg', '按场景挑到 10_shanle');
    const cat2 = stickerCatalog();
    ok(cat2.length === 2 && cat2.every(s => s.desc && s.tags.length), '每张都有描述/标签');
  } catch (e) {
    ok(false, '表情包目录/标签测试失败:' + e.message);
  }

  // 回复拆分:只按行拆,长句不硬切
  const sp1 = splitReply('删了\n这不是我');
  ok(sp1.length === 2 && sp1[0] === '删了' && sp1[1] === '这不是我', '按行拆成 2 条:' + JSON.stringify(sp1));
  const sp2Text = '一个很长的句子,里面有几个逗号,也有句号。但还是要原样发一条,不按标点切。';
  const sp2 = splitReply(sp2Text);
  ok(sp2.length === 1 && sp2[0] === sp2Text, '一个长段原样一条,不按标点/字数切');
  const sp3 = splitReply('删了\n这不是我\n那天没手感\n别笑');
  ok(sp3.length === 3 && sp3[2].includes('别笑'), '最多 3 条,多出的并进最后一条:' + JSON.stringify(sp3));
  ok(JSON.stringify(splitReply('W14: 删了', { names: ['W14'] })) === '["删了"]', '去掉「人格名:」前缀');
  ok(JSON.stringify(splitReply('（冷笑）删了')) === '["删了"]', '去掉括号动作');
  ok(JSON.stringify(splitReply('[图片]删了')) === '["删了"]', '去掉 [图片] 占位');
  ok(JSON.stringify(splitReply('**重点** 是这样')) === '["重点 是这样"]', '去掉 Markdown 加粗');
  ok(JSON.stringify(splitReply('### 标题')) === '["标题"]', '去掉 Markdown 标题');
  ok(JSON.stringify(splitReply('- 第一条')) === '["第一条"]', '去掉列表符号');
  ok(splitReply('').length === 0 && splitReply('   \n ').length === 0, '空回复 → 不发');

  console.log(chunks.join('\n'));
  console.log('\n' + (chunks.length - bad) + '/' + chunks.length + ' 通过');
  process.exitCode = bad ? 1 : 0;
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest') || !args.length) selftest();
  else if (args.includes('--stickers')) {
    const list = listStickers();
    console.log('表情包 ' + list.length + ' 张 → ' + stickerDir());
    for (const s of list) console.log('  ' + s.name + '  ' + (s.size / 1024).toFixed(0) + 'KB');
  } else {
    const [gid, act] = args;
    if (act === undefined) {
      console.log('全部状态:', JSON.stringify(allOn(), null, 2), '\n文件:', statePath());
    } else {
      const on = /^(on|开|开启|打开|1)$/i.test(act);
      console.log('设置:', JSON.stringify(setOn(gid, on)), '| 现在:', isOn(gid) ? '开启' : '关闭');
    }
  }
}

