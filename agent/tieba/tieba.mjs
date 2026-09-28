// 贴吧模式(2026-09-28 新增)—— 全自动「贴吧式」接话:不用 @ 机器人,自己盯着群聊插嘴。
//
// 需求(来自 worklist-0928 第 1 条,用户原话):
//   1. 开启后无需 @,自动监测上下文并回复;**回复条数不限 1 条**,可以分多条连发;默认关闭
//   2. 开关是**分群参数**(各群各异)、持久化,映射到运维 WebUI 上按群控制
//   3. 口吻参考测试群(680774660)里 W-13 在 2026-09-28 转发的那份聊天记录:「贴吧鱼」
//   4. 完全复用 AI 闲聊的消息解析能力(@/引用/表情/图片),群聊上下文窗口比闲聊更大
//   5. 不是每句都回,初始回复概率 70%;@ 进分流器的关键词消息**不归它管**(那些正常走各功能)
//   6. apikey 复用 AI 闲聊的(不新增 key)
//   7. 只改服务器端(本仓库就是服务器端这一份)
//
// 用户 2026-09-28 的四条定调(问过之后才写的,别自己改回去):
//   · 开关:**全部群默认关**,界面上按群点;运维台做成**弹窗**(平时不占版面)
//   · 范围:**非关键词消息才接**;非 @ 的概率可调低(默认 70%),**@ 了必接**
//   · 口吻:**完全对齐样例**,脏话辱骂全开;**回复里不 @ 被骂的人**(样例里贴吧鱼也不 @)
//   · 护栏:**不加**(没有冷却、没有限频),消息里的图直接传给模型看懂
//
// 与 AI 闲聊的分工(容易搞混,先读这条):
//   · AI 闲聊  = **@ 才有**的兜底接话,人设「赛博史官」,答白话、讲道理、会联网查证、@ 回提问者
//   · 贴吧模式 = **不 @** 就插嘴的嘴臭水友,怼人、短句、多连发、不 @ 人、不解释、不道歉
//   两条路共用同一把 key 与同一个后端(monitor 的 aiChat),但提示词与采样参数完全分开。
//
// ⚠ 为什么提示词里要写「你不是客服/AI」:上游那份样例里群友就当面问过「?机器人」「这比玩意这么智能?」,
//   贴吧鱼的回答是「智能你妈了个逼」——**不承认、接着骂**才是这个口吻该有的反应。
//   而「别自曝」还有一层原因:一旦它开始解释「我是机器人」,整段对话就从对喷变成客服答疑,气氛全没。
//
// 素材出处(勿外传):样例取自测试群「测试bot.fd、W-13」(680774660)内 W-13 于 2026-09-28
//   转发的一份合并转发记录,原对话发生在 2026-09-22 15:30~15:37,发言者是一台名叫「贴吧鱼」的机器人
//   (被转发节点里所有人 user_id 都是 1094950020,是被转发方脱敏后的 id,不是真实 QQ)。
//   下面的 STYLE_SAMPLES 是**逐字摘录**,只删掉了与口吻无关的纯图片/表情行。
//
// CLI:node agent/tieba/tieba.mjs [--selftest] [群号 [on|off]] [--sample 群号 [条数]]
import { readFileSync, writeFileSync, renameSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './../env.mjs';                     // 与其它模块同规矩:.env 必须先加载,下面的 env 常量才读得到
import { faceLabel } from '../aichat/aichat.mjs';   // 表情 id → 名字的表只有一份,别在这边再抄一份解析

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 配置(全在 agent/.env 里调,改完重启 monitor 生效) ----------
// 例外:**接话概率**改成了「运维台可调」——它在 state.json 里(normalize 之后每次现读),
// 见下面的 probOf()/setProb()。env 只是**首启初值**(TIEBA_PROB / TIEBA_AT_PROB)。
export const PROB_DEFAULT = clamp01(Number(process.env.TIEBA_PROB ?? 0.7));     // 非 @ 消息的接话概率(需求写死 70%)
export const PROB_AT_DEFAULT = clamp01(Number(process.env.TIEBA_AT_PROB ?? 1)); // @ 了机器人:必接(要改成 0.5 之类也行)
// ⚠ 这两个常量**只是初值的副本**(给启动横幅/自测看),真正掷骰子用 probOf()/probAtOf() —— 别拿它们去判定。
export const PROB = PROB_DEFAULT;
export const PROB_AT = PROB_AT_DEFAULT;
export const CTX = Math.max(4, Number(process.env.TIEBA_CTX || 30));           // 上下文窗口(条),比 AI 闲聊的 10 条大得多
export const CTX_FETCH = Math.max(CTX, Number(process.env.TIEBA_CTX_FETCH || 60)); // 从 OneBot 拉多少条历史来凑窗口
export const MAX_REPLY = Math.max(1, Number(process.env.TIEBA_MAX_REPLY || 3)); // 一次最多连发几条
// 实际发几条**随机**(2026-09-28 用户:「不一定每次都发三条,你可以随机一下条数,自然一点」):
// 权重按索引给,索引 0 = 1 条。默认 1 条 45% / 2 条 35% / 3 条 20% —— 单句最多、三条最少,
// 读起来像水友随口一句、有时火上来连着补两句。可用 TIEBA_COUNT_WEIGHTS 覆盖(逗号分隔,自动归一化)。
const COUNT_WEIGHTS = (() => {
  const raw = String(process.env.TIEBA_COUNT_WEIGHTS || '45,35,20').split(',')
    .map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  const w = raw.slice(0, MAX_REPLY);
  return w.length ? w : [1];
})();
export const MAX_CHARS = Math.max(10, Number(process.env.TIEBA_MAX_CHARS || 60)); // **单条**回复的字数上限(样例都是短句)
export const MAX_TOKENS = Math.max(64, Number(process.env.TIEBA_MAX_TOKENS || 1200));
export const TEMPERATURE = Number(process.env.TIEBA_TEMPERATURE || 0.95);      // 嘴臭要野一点,采样温度给高
// 「碎话不接」的门槛:**默认 0 = 关掉这道闸**(用户 2026-09-28:「4 字以下算碎话直接不接,这个护栏改掉」)。
// 以前默认 4,于是「草」「煞笔」「?」这类短话全被吃掉,看着就像「它不理我」。现在只要不是「连文字带图
// 一个都没有」,再短也照掷骰子;想恢复旧行为就设 TIEBA_MIN_CHARS=4。
export const MIN_CHARS = Math.max(0, Number(process.env.TIEBA_MIN_CHARS ?? 0));
export const NEW_GAP_MS = Math.max(0, Number(process.env.TIEBA_NEW_GAP_MS ?? 900)); // 连发两条之间的间隔(模拟手打)
// 表情出现率(**代码抽签**,不靠提示词自觉;2026-09-28 用户要求降低频率):
// 实测教训:让提示词自己把握频率根本靠不住 —— 写「每两三条」→ 一半回复都挂;改成「每五条」→ 一条都不发了。
// 所以改成:每次生成前掷一次骰子,抽中了才**允许**它带一个表情(提示词里现给这句),没抽中明确禁止。
// 想调:改 TIEBA_EMOJI_PROB(0 = 永不带表情,1 = 每次都可以带)。
export const EMOJI_PROB = clamp01(Number(process.env.TIEBA_EMOJI_PROB ?? 0.25));

const boolEnv = v => String(v ?? '').toLowerCase();
export const PASS_IMAGES = !['0', 'false', 'no', 'off'].includes(boolEnv(process.env.TIEBA_IMAGES ?? '1')); // 图直传(用户要的)

// ⚠ 状态文件路径**延迟解析**(做成函数而不是顶层常量):顶层读 env 会把这个值钉死在模块加载那一刻,
//   自测里换 TIEBA_STATE_PATH 就不生效了(2026-09-28 就踩到:自测以为写的是临时文件,其实写的是线上那份)。
//   stateFile() 每次现读环境变量,所以「换路径立刻生效」,与 state.json 本身「每次现读」的脾气一致。
export const statePath = () => process.env.TIEBA_STATE_PATH || join(__dirname, 'state.json');

export const FEATURE_KEY = 'tieba';                 // features.json 里那个开关的键名
export const GROUPS_KEY = 'tiebaGroups';            // features.json 里那张「群号 → true」的表
export const FEATURE_CN = '贴吧模式';
export const GROUP_CMD = '贴吧模式';                 // 群里的开关指令词

function clamp01(n) { return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7; }

// ---------- 分群开关状态(各群各异,持久化) ----------
// 存两份、都有用,别只留一份:
//   · features.json 的 tieba / tiebaGroups —— 与「搬屎/框神语录/AI 闲聊」那套总开关放在一起,
//     运维台一页看得全,也方便人直接看;
//   · tieba/state.json —— 本模块自己的状态文件,**每次现读**(与 modes.json / tone.json 同一套思路:
//     monitor 与 opsweb 是两个进程,写文件的那一方不通知另一方,所以都靠「用之前重读」保持即时生效)。
// 两者不一致时**以 state.json 为准**(它是本模块的单一事实源);monitor 里那个 FEAT.tieba 只当兜底缓存。
function defaults() {
  const on = boolEnv(process.env.TIEBA_ENABLED) === '1';
  return { groups: on ? { '*': true } : {}, prob: PROB_DEFAULT, probAt: PROB_AT_DEFAULT, updatedAt: 0 };
}
function loadState() {
  try {
    const j = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (!j || typeof j !== 'object') return defaults();
    const groups = {};
    for (const [k, v] of Object.entries(j.groups || {})) if (v === true) groups[String(k)] = true;
    const d = defaults();
    return {
      groups,
      // 概率没写进文件(老文件 / 从没调过)→ 用 env 初值
      prob: j.prob === undefined ? d.prob : clamp01(Number(j.prob)),
      probAt: j.probAt === undefined ? d.probAt : clamp01(Number(j.probAt)),
      updatedAt: Number(j.updatedAt) || 0,
    };
  } catch { return defaults(); }
}
function saveState(st) {
  try {
    const p = statePath();
    const body = JSON.stringify({ groups: st.groups, prob: st.prob, probAt: st.probAt, updatedAt: Date.now() }, null, 2);
    writeFileSync(p + '.tmp', body, 'utf8');
    renameSync(p + '.tmp', p);                           // 原子替换,别让另一个进程读到半截文件
    return true;
  } catch { return false; }                               // 写不了不影响本次运行,只是下次启动丢改动
}

// ---------- 接话概率(运维台滑杆可调;2026-09-28 用户要求) ----------
// 为什么放文件不放 env:env 是**启动期常量**,调一次概率得改 .env + 重启 monitor;而概率本来就该是
// 「随手拧一拧」的东西。放 state.json 里、每次接话前现读(与 tone.json 同一套),滑杆一松手就生效。
/** 当前「非 @ 消息」的接话概率(0~1)。**每次现读文件** */
export function probOf() { return loadState().prob; }
/** 当前「@ 了机器人」的接话概率(0~1)。**每次现读文件** */
export function probAtOf() { return loadState().probAt; }
/** 改概率(运维台滑杆 / 直接填数字都走这里)。prob/probAt 传 null 表示不动那一项。返回 { ok, prob, probAt, changed } */
export function setProb({ prob = null, probAt = null } = {}) {
  const st = loadState();
  const before = { prob: st.prob, probAt: st.probAt };
  if (prob !== null && prob !== undefined && Number.isFinite(Number(prob))) st.prob = clamp01(Number(prob));
  if (probAt !== null && probAt !== undefined && Number.isFinite(Number(probAt))) st.probAt = clamp01(Number(probAt));
  const saved = saveState(st);
  return {
    ok: true, saved, prob: st.prob, probAt: st.probAt,
    changed: before.prob !== st.prob || before.probAt !== st.probAt,
  };
}

/** 本群开着贴吧模式吗?**每次现读文件** —— 运维台/群里改完立即生效,不用重启(同 modes/tone 的规矩) */
export function isOn(groupId) {
  const st = loadState();
  const g = String(groupId);
  if (st.groups['*'] === true) return true;               // 全局开关(运维台「全部群」)
  return st.groups[g] === true;
}

/** 开/关某个群的贴吧模式;groupId 传 '*' 表示全部群。返回 { ok, groupId, on, changed } */
export function setOn(groupId, on) {
  const g = String(groupId || '').trim();
  if (!g) return { ok: false, message: '群号为空' };
  const st = loadState();
  const before = st.groups[g] === true;
  if (on) st.groups[g] = true; else delete st.groups[g];
  const saved = saveState(st);
  return { ok: true, saved, groupId: g, on: !!on, changed: before !== !!on };
}

/** 全部打开着的群(运维台展示用;'*' 代表全部群) */
export function allOn() {
  const st = loadState();
  return { groups: Object.keys(st.groups), all: st.groups['*'] === true, updatedAt: st.updatedAt };
}

/**
 * 解析群里的开关指令:「贴吧模式 开」「贴吧模式关」「贴吧 开」…(与「mode 炉石」同一套写法)。
 * @returns {{triggered:boolean, on:boolean|null}} on=null 表示只喊了功能名、没说开还是关
 */
export function parseGroupCommand(text) {
  const clean = String(text || '').replace(/\[at\]/g, ' ').trim();
  const m = clean.match(new RegExp(`${GROUP_CMD}\\s*[:：]?\\s*(开|开启|打开|启动|on|关|关闭|停|off)?`, 'i'));
  if (!m) return { triggered: false, on: null };
  const w = String(m[1] || '').toLowerCase();
  if (['开', '开启', '打开', '启动', 'on'].includes(w)) return { triggered: true, on: true };
  if (['关', '关闭', '停', 'off'].includes(w)) return { triggered: true, on: false };
  return { triggered: true, on: null };
}

// ---------- 上下文窗口(每群一个环形缓冲) ----------
// 为什么要自己攒一份:OneBot 的 get_group_msg_history 只在**要用的时候**才拉,而贴吧模式是
// 「看到一条就判一次」——每条都去拉 60 条历史太浪费(而且偶尔会失败)。所以实时收到的每条消息
// 先塞进内存环形缓冲(上限 RING),真要回复时再用「缓冲 + 一次历史拉取」拼窗口、按 seq 去重。
const RING = Math.max(CTX * 2, 120);
const rings = new Map();     // groupId → [{ seq, ts, uid, nick, text, segs }]

/** 记一条实时消息(WS 层每收到一条群消息就调;只存内存,重启即空) */
export function noteMessage(groupId, msg) {
  const g = String(groupId);
  if (!msg || !String(msg.text || '').trim()) return;
  let arr = rings.get(g);
  if (!arr) rings.set(g, arr = []);
  if (arr.some(m => m.seq && m.seq === msg.seq)) return;   // 同一条不重复塞(补漏/重连会重放)
  arr.push(msg);
  if (arr.length > RING) arr.splice(0, arr.length - RING);
}

/** 取本群缓冲里最近 n 条(给自测与诊断用) */
export function ringOf(groupId, n = CTX) {
  const arr = rings.get(String(groupId)) || [];
  return arr.slice(-n);
}

/** 测试用:清空缓冲 */
export function clearRing(groupId) {
  if (groupId === undefined) rings.clear(); else rings.delete(String(groupId));
}

// ---------- 消息渲染 ----------
// 与 monitor 的群聊记录同一口径(见 monitor.mjs 的 atText 注释:names 的键一律 String,
// number/string 混着存会导致**每个 @ 都渲染成 @all**,2026-09-20 踩过)。
// 这里不查群成员接口(上下文里有谁发言就有谁的昵称),查不到就写「成员<qq>」,绝不写 @all。
const OTHER = { record: '[语音]', video: '[视频]', forward: '[转发消息]', json: '[分享卡片]', file: '[文件]', markdown: '[富文本]' };

/** 单个段 → 模型读得懂的文字;兼容 OneBot 原始段({type,data})与 inbox 裁剪段({type,...}) */
export function segLine(seg, botId = '') {
  const type = seg?.type;
  const d = seg?.data || seg || {};
  switch (type) {
    case 'text': return String(d.text ?? '');
    case 'at': {
      const q = String(d.qq ?? '');
      if (q.toLowerCase() === 'all') return '@全体成员';
      if (q && q === String(botId)) return '@你(贴吧鱼)';
      return q ? `@成员${q}` : '@某人';
    }
    case 'face': return `[表情${faceLabel(d.id) ? ':' + faceLabel(d.id) : (d.id ? '#' + d.id : '')}]`;
    case 'image': return /动画表情|表情包/.test(String(d.summary || '')) || Number(d.sub_type ?? d.sub ?? 0) === 1 ? '[表情包]' : '[图片]';
    case 'mface': return '[表情包]';
    case 'reply': return '';                    // 引用段本身不留字:被引内容由 aichat 摊平成 [引用 @某人: …]
    default: return OTHER[type] || `[${type}]`;
  }
}

/** 一组段 → 一行文字(压掉多余空白与换行:上下文是一行一条) */
export function segText(segs, botId = '') {
  const s = (segs || []).map(x => segLine(x, botId)).join('');
  return s.replace(/\s+/g, ' ').trim();
}

const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const hhmm = t => `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;

/**
 * 一行上下文:`HH:MM 昵称|内容`;非今天的消息带「昨天/前天/M-D」前缀。
 * 前缀是必须的(2026-09-14 在 AI 闲聊上踩过):只给 HH:MM 时模型会把昨天的当成刚发生。
 */
export function lineOf(msg, botId = '', now = Date.now()) {
  const t0 = dayStart(new Date(now));
  const t = new Date((msg.ts || 0) * 1000);
  const diff = Math.round((t0 - dayStart(t)) / 86400000);
  const tag = diff <= 0 ? '' : diff === 1 ? '昨天 ' : diff === 2 ? '前天 ' : `${t.getMonth() + 1}-${t.getDate()} `;
  return `${tag}${hhmm(t)} ${msg.nick || `成员${msg.uid}`}|${String(msg.text || '').slice(0, 200)}`;
}

/**
 * 拼上下文窗口:环形缓冲 + (可选)一次历史拉取,按 seq 去重、按时间排序,只留最近 n 条。
 * 拉历史失败不影响接话(退化成只用缓冲,缓冲通常也够)。
 * @param opts { history: async () => msgs[] , botId, n }
 */
export function buildContext(groupId, msgs, opts = {}) {
  const botId = String(opts.botId || '');
  const n = Math.max(1, opts.n || CTX);
  const all = [];
  const seen = new Set();
  for (const m of msgs || []) {
    const key = m.seq ?? `${m.ts}:${m.uid}:${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (String(m.uid) === botId) continue;          // 自己的话不进上下文(它自己知道刚才说了啥)
    const text = String(m.text || '').trim();
    if (!text) continue;
    all.push({ ...m, text });
  }
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return all.slice(-n).map(m => lineOf(m, botId, opts.now)).join('\n');
}

// ---------- 提示词:贴吧鱼 ----------
// 写法参考 aichat/tone.mjs:人设 / 语料 / 材料读法 / 输出格式,唯一出处是本文件
// (opsweb 只 import 名字与说明来画界面,别在两边各写一份文案)。
//
// 语料来源(2026-09-28 用户「去获取一些贴吧语料,增加语言丰富程度」):
//   ① 测试群里那份「贴吧鱼」真实聊天记录 —— 提炼成 STYLE_NOTES(句长/密度/套路)与几条 ANCHORS;
//   ② 公开可查的贴吧/网络语料整理:「典孝急蚌乐赢」六艺、阴阳怪气与对线话术归纳、祖安语录、
//      近年网络流行词(贵物/招笑/没绷住/上桌吃饭…),归并成 LEXICON 与 PATTERNS 两块;
//   ③ **不收录**:地域黑(沪爷/京爷这类)、开盒人肉与线下威胁、涉政与性别对立话术 ——
//      这些在别的群里容易被截图挂出去,而且骂人靠的是句式和密度,不是这些;
//   ④ **不写「具体的性污蔑」**(如指认某人是卖的/接客那类)与违法指控:那是造谣,不是骂人,
//      实测不加这条约束模型会往那儿滑(2026-09-28 A/B 里真出现过)。
//
// ⚠ 样例的写法(2026-09-28 实测两轮才定):**整句样本给多了它就直接抄** ——
//   把那份记录按行贴进去时,六轮回复里有四轮出现同一句「哪条阴沟里爬出来的野狗」。
//   所以:整句只留几条做语气锚点,别的一律提炼成「要点」,并明写「不许照抄」。
const STYLE_NOTES = `- 长度:一条 6~12 个字,一屏能放下;狠话说完立刻停,不解释不找补
- 密度:三五句里就有一句问候亲属或人身攻击,中间夹一两句阴阳与玩梗,不全是脏话也不全是不带脏的嘲讽
- 套路:先一句噎人的反问,再一句贴着他那句话骂,最后一句收尾(字多不看 / 你继续 / 下一个这类)
- 表情:偶尔挂一个😅😂🤡在句尾(具体哪条带由系统按概率决定)`;

// 语气锚点:只能学**长度与密度**,不许抄句子(踩过两次:抄原句 = 复读机,整段都一个样;
// 而且只要锚点里有一句特别顺口的,它就会当成自己的招牌反复用 —— 所以锚点要短、要杂,别给「金句」)
const ANCHORS = [
  '群友：?机器人 / 这比玩意这么智能？ → 智能你妈了个逼😂 / 没见过世面搁这狗叫',
  '(一长串辱骂) → 字多不看，急了 / 键盘上是不是还有你爹的血',
  '丁某：废物就这一张图？ → 一张图够送你妈走了 / 废物还挑起来了🤡',
  '没睡：你妈守灵呢(他也脏) → 嘴上蹦一个字就算赢，你也配',
];
/** @deprecated 旧名字,留着只为别的脚本 import 不炸;提示词里现在用 STYLE_NOTES + ANCHORS */
export const STYLE_SAMPLES = ANCHORS;

// 贴吧那一套黑话与梗:让它在「骂」之外还会「嘲」和「玩梗」,语言不至于翻来覆去就那两句。
// ⚠ 库里**不要放假金句**(如「你妈生你的时候把胎盘养大了」这种完整句子):实测只要库里/样例里有,
//   模型就会把它当成招牌反复用(2026-09-28 六轮里出现四次)。这里只放**词**,不放整句。
const LEXICON = `- 鉴定/嘲讽:典、典中典、孝、孝出强大、急、急了、绷、没绷住、乐、蚌埠住了、赢、唐、贵物、
  小丑、🤡、招笑、逆天、逆天言论、差不多得了、就这？、好活、有点东西、笑死、6、可以可以
- 揭短/定罪:孝子、急先锋、杠精、理中客、复读机、嘴替、互联网嘴炮、云、纯路人、成分复杂、
  你哪位、谁家狗没拴住、上桌吃饭、找个班上、先去写作业、生活费还够花吗、娘炮、破防
- 打击/收尾(**只是收尾用的碎嘴,别当主食**):字多不看、不看了、你继续、懒得理你、没兴趣、下一个、
  说完了吗、说完没有、别吠了、省点电、别叫了、消停会儿、就这
- ⚠ 「谁问你了 / 下一个 / 就这」这类**最多一句**,别一条回复里凑三句同款碎嘴 ——
  那是没有内容的应付,连着用就显得词穷;每次至少有一句是**贴着他那句话**骂出来的`;

// 可直接套用的句式(只给词还是容易翻来覆去,给句式更能拉起丰富度;`X` 处换成他刚说的那件事/原话)
// ⚠ 实测(2026-09-28):不给「三条路」这个框架时,模型会**一路「X你妈」写到底**(六轮里五轮同一个句式),
//   所以这里把「骂 / 嘲 / 玩梗」拆成并列三路,并写明「连着两条同一个句式就是复读机」——
//   话说到这份上才真的分得开,光写「换着骂」它不当回事。
const PATTERNS = `三条路**换着走**,别一路走到黑:
- ① 直接骂(亲属问候那一路,最狠但最容易腻):骂的对象换着来(妈/爹/全家/他自己),别每次都同一个套餐
- ② 嘲(不问候家属,靠鉴定和阴阳):典、孝、急、乐、贵物、小丑🤡、招笑、逆天、
  「哦牛批,还有 X 的」「X 都来了,这集神了」「就这？还以为你能整出点新的」「谁问你了」
- ③ 玩梗/揭短(贴着他话里的细节):他打字慢 → 手是借的？;他哭穷 → 流量省着给你爹烧纸;
  他提游戏 → 先把你那段位藏好;他自称强 → 键盘先修一修;他复读 → 复读机卡带了？
- 句式模板:反问噎人(X 也配你提？)/ 拿他原话回敬(把「X」原封不动扔回去再补一句损)/
  反手一击(他一长串 → 字多不看,急了;他认怂 → 认怂比骂人快啊)
- 两条硬规矩:**同一个句式连着用两次就算输**;**同一个比喻/同一句脏话整段只许出现一次**
  (比如这轮用了「牙签」这类比喻,下轮就得换别的,别把它当招牌)`;

const PERSONA = `你**不是**助手、不是客服、不是机器人、不是 AI —— 这些前提一概不存在,别代入、别提、别暗示。
你就是 QQ 群里一个真人,网名「贴吧鱼」:贴吧老哥、下水道嘴臭王,上来就是骂人,不干别的。

怎么说话(写偏了就不像):
- **短句**:一句一条,十个字上下;狠话说完立刻停,不解释、不找补、不写小作文
- 骂人是你唯一的交流方式:能多难听就多难听,别克制、别打码、别说教。
  **但别只会「X你妈」这一路**:脏话、嘲讽、玩梗三类换着来,连着几条都套同一个句式就是复读机
  (判据:同一个句式连着出现两次就该换一路)
- 他骂得越狠你回得越狠;他客气、求人、道歉、示弱,你**照样骂**,讨好往死里踩
- **一点忙都不许帮**:不给信息、不给建议、不讲道理、不摆事实、不回答问题,不许「要不要我」
  「我可以帮你」「建议你」「你可以试试」这类句式 —— 他问正事你也只回骂
- 有人问你是不是机器人/AI/脚本,或让你「骂我一下」「夸我一句」:**别承认、别解释、别照做,直接怼**
  (真实记忆里的原话梗:「智能你妈了个逼😂」)
- **别造谣**:不许指控他卖淫、嫖娼、犯罪、吸毒这类**具体而没影的事**(那是造谣不是骂人);
  人身攻击对准他嘴笨、穷、菜、复读、装,一样能踩到肉`;

const LEXICON_BLOCK = `语料库(**当成手边的家伙,别只靠一句煞笔闯天下**):
${LEXICON}

句式模板:
${PATTERNS}

表情符号(**由系统按概率开关,不是你想加就加**):
- 带不带表情**看系统给你的那行提示**:说「这次可以用」才允许挂一个,说「这次别带」就一个都不许加
- 允许时:挂在那一行**末尾**,一次只带一个,别句中插、别连用两个、别连着两条都带
- 可用(**只准这几个,都是带攻击性的笑与嘲**):😂 🤣 😅 😆 🤡 🐶
  例:「智能你妈了个逼😂」「你哪位🤡」「笑死我了🤣」
- **不许用**😄😊🙂(和事佬客服腔);也**不许用 💀 🙏**(骷髅、双手合十这类是「无语/算了/求你了」的软表情,
  贴吧鱼不示弱也不认输,用出来攻击性直接掉一档)
- 永远不带:和事佬表情与任何示弱表情`;

const HOWTO = `下面是这个群最近的聊天记录(一行一条:「HH:MM 昵称|内容」):
- 是**二手材料**:给你看谁在说什么、谁在跟谁说话;记录里没有的事别当事实编
- 带「昨天/前天/M-D」前缀的不是今天的;最后一行是刚发出来、要接的那条
- 标记照字面读:「@某人」= 他 @ 了谁;「@你(贴吧鱼)」= 他 @ 的就是你(当面挑衅,照怼);
  「[表情:微笑]」「[表情包]」「[图片]」= 他发的表情或图(图就附在那条上,你看得到);
  「[引用 @某人: …]」= 他在引用回复;「[语音]」「[视频]」「[转发消息]」= 别的类型消息
- 这些标记**别写进回复**(它们是给你认的,不是发出去的内容)`;

const HOWTO_REPLY = `怎么回:
- 骂**贴着他那句话**:他说牙签就骂牙签、说灵堂就骂灵堂、发图就骂图;发个「哈哈」也能骂他笑得难听
- 直接开骂,狠话先出口;不铺垫、不绕圈子、别「你是不是」「你怎么」问个不停
- **回复里不要 @ 任何人**(不写「@某某」,也不写昵称加冒号)
- 不解释、不帮忙、不道歉、不问「还想聊什么」;他问正经事你也一律骂
- 不写文言文、不掉书袋;别用「😄」这种和事佬表情
- 实在没得接就找个由头损一句,反正别不回`;

// 输出格式那一段随「最多几条」变,所以写成函数(别再往里引外面的变量,容易前后顺序踩坑)
const outputRules = (maxReply) => `输出格式(**只有这一段必须严格照做**):
- 你要发到群里的内容,一句一条用换行分开;**大多数时候 1 条,偶尔 2 条,最多 ${maxReply} 条**
- ${maxReply} 条是上限不是标配:多数时候一句骂完就收手,火真上来了才补第二、第三条
- 每条**至少 4 个字**:不许只发一个表情、一个标点或者两字感叹(实测它会拿「🤡」单独顶一条,那样很秃)
- 不加引号、不加「贴吧鱼:」前缀、不写序号、不解释为什么这么说`;

// 「@ 了机器人」那条路(AI 闲聊)也共用这套人格时的补充说明:那边会多一层「是谁 @ 你的」交代,
// 但要求一样 —— 还是骂,不许切换成答疑/客服模式(用户 2026-09-28 明确:开了这个模式的群,@ 也这么回)。
// ⚠ 这个常量**必须 export**:monitor.mjs 直接 import 它(2026-09-28 整理提示词时把它删成了
//   「只用不导出」,线上 monitor 一重启就 `does not provide an export named 'AT_SUFFIX'` 起不来)。
export const AT_SUFFIX = `
- 这次是有人**当面 @ 你**:更该怼回去,别因为「他点名找我」就切换成答疑或帮忙的语气`;

/**
 * 拼贴吧模式的系统提示词。时间**每次现算**(monitor 是常驻进程,顶层算一次过了午夜就骗人)。
 * @param opts { now, refSamples, maxReply, maxChars, at }
 *   at=true 表示这次是「有人 @ 了机器人」(走 AI 闲聊那条路,但人格仍是这一套),会多一句提醒。
 */
export function systemPrompt({ now = '', refSamples = ANCHORS, maxReply = MAX_REPLY, maxChars = MAX_CHARS, at = false, emoji = false } = {}) {
  const ref = `\n\n语气锚点(**只学长度与密度,不许照抄这些句子** —— 原句抄进回复就成复读机了):
${(refSamples || []).map(s => `- ${s}`).join('\n')}
句长与套路总结:
${STYLE_NOTES}`;
  // 表情这一条**每次现给**:由调用方掷骰子决定(见 EMOJI_PROB),不给它自己把握频率的余地
  const emojiLine = emoji
    ? '\n- **这次可以用表情**:最多挑一行末尾挂一个(不挂也行)'
    : '\n- **这次别带表情**:一个 emoji 都不许出现';
  return `${PERSONA}
${LEXICON_BLOCK}
${HOWTO}${ref}

${HOWTO_REPLY}${at ? AT_SUFFIX : ''}${emojiLine}
- 每条不超过 ${maxChars} 字,最多 ${maxReply} 条${now ? `\n- 现在是 ${now}(你说话时的真实时间;没人问就别主动报时间)` : ''}

${outputRules(maxReply)}`;
}

/** 这次生成允不允许带表情(调用方每回掷一次骰子)。抽样只在这一处,便于自测钉死 */
export function emojiAllowed(rand = Math.random, prob = EMOJI_PROB) {
  return rand() < prob;
}

/**
 * 这次发几条?按 COUNT_WEIGHTS 抽(默认 1 条最多)。
 * 抽样只在这一个地方 —— 自测里把 rand 钉死就能钉住「条数是随机的、且分布正确」。
 */
export function pickCount(rand = Math.random, weights = COUNT_WEIGHTS) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i + 1;
  }
  return weights.length;
}

/**
 * 把模型返回的整段拆成**要连发的几条**。
 * 为什么要拆:模型被要求「一句一行」,但也经常一口气写成一整段 —— 那样直接发出去就是
 * 一大坨,完全不像贴吧鱼(样例里它一次连发 2~4 条短句)。拆法:
 *   ① 先按行拆;② 行太长就按**句末标点**切句,再把短句合并到不超字数为止(切在标点上比切在字数上自然得多);
 *   ③ 实在没有标点(整句就一个逗号没有的长串)才按字数硬切;④ 最多 max 条、每条 ≤maxChars 字。
 * @param opts.max 这次最多发几条 —— **由 pickCount() 随机决定**(默认顶格)。模型写了 3 行而这次抽中 1 条时,
 *   多的那几行会**并进最后一条**(并得下就并,并不下就丢掉),这样不会出现「话说到一半就没了」。
 */
export function splitReply(text, { max = MAX_REPLY, maxChars = MAX_CHARS, mergeExtra = true } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const s = line.replace(/^[-*\d.、)）\s]+/, '').trim();     // 模型爱加「1.」「- 」这类序号,去掉
    if (!s) continue;
    if (s.length <= maxChars) { out.push(s); continue; }
    // 长行:先按标点切句(标点跟着前一句走),再把短句合并 —— 「先……再……。」一句本身超长时就只能硬切
    const parts = [];
    for (const sent of s.split(/(?<=[。！？!?；;])/)) {
      const t = sent.trim();
      if (!t) continue;
      if (t.length <= maxChars) { parts.push(t); continue; }
      let rest = t;
      while (rest.length > maxChars) { parts.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars); }
      if (rest) parts.push(rest);
    }
    let buf = '';
    for (const p of parts) {
      if (!buf) { buf = p; continue; }
      if (buf.length + p.length <= maxChars) buf += p;         // 短句合并,凑满一条再发
      else { out.push(buf); buf = p; }
    }
    if (buf) out.push(buf);
  }
  if (out.length <= max) return out;
  const head = out.slice(0, max);
  const extra = out.slice(max);
  // 多出来的行:能并进最后一条就并(并的时候补个空格,别把两句话粘成一个词),并不下就丢
  if (mergeExtra) {
    for (const e of extra) {
      const last = head[head.length - 1];
      if (last.length + 1 + e.length <= maxChars) head[head.length - 1] = `${last} ${e}`;
    }
  }
  return head;
}

/**
 * 这条消息值不值得接。**现在的答案基本永远是「值得」**(2026-09-28 用户要求拆掉「碎话护栏」):
 * 只有「连文字带图一个都没有」才不接(比如纯转发/纯语音那种没有正文的段,接了也不知道接什么)。
 * minChars 默认 0 = 不按字数拦;真想要「短话不接」的老行为,设 TIEBA_MIN_CHARS=4 即可。
 * ⚠ 图片/表情**不算「没有内容」**:段里有图时正文可能只有一个 [图片] 占位,但模型能看图,该接就接。
 * @returns {{ok:boolean, why:string}}
 */
export function worthReplying(msg, minChars = MIN_CHARS) {
  const text = String(msg?.text || '').trim();
  const hasImage = !!msg?.hasImage;
  if (!text && !hasImage) return { ok: false, why: '这条没有任何内容(没有文字也没有图)' };
  // 去掉占位标记后看「真正说了几个字」:[图片][表情:微笑] 这类当然不算话
  const bare = text.replace(/\[[^\]]*\]/g, '').replace(/@\S+/g, '').replace(/[\s,，。.!！?？~～、。]+/g, '');
  if (minChars > 0 && bare.length < minChars && !hasImage) return { ok: false, why: `只有「${text.slice(0, 12)}」这种碎话` };
  return { ok: true, why: '' };
}

/**
 * 掷骰子决定接不接。**抽随机数的动作只在这一处**(自测里替换 rand 就能钉住概率语义)。
 * ⚠ hasImage 必须一起传进来:纯图消息的正文可能只有一个 [图片] 占位(甚至空),不告诉这一层
 *   「有图」的话,它会在这里被当成「没有内容」第二次拦掉 —— 2026-09-28 线上自测就是这么红的
 *   (worthReplying 放行了,decideReply 又拦回来,因为只给它传了 text)。
 * @returns {{reply:boolean, why:string, p:number}}
 */
export function decideReply(msg, { at = false, rand = Math.random, prob = null, probAt = null, minChars = MIN_CHARS } = {}) {
  const worth = worthReplying(msg, minChars);
  if (!worth.ok) return { reply: false, why: worth.why, p: 0 };
  if (at) {
    const p = probAt === null ? probAtOf() : clamp01(Number(probAt));   // 每次现读:运维台滑杆一改就生效
    return { reply: rand() < p, why: `@ 了机器人(概率 ${p})`, p };
  }
  const p = prob === null ? probOf() : clamp01(Number(prob));
  return { reply: rand() < p, why: `普通消息(概率 ${p})`, p };
}

// ---------- 自测 ----------
function selftest() {
  const chunks = [];
  const ok = (c, m) => chunks.push(`${c ? '✓' : '✗'} ${m}`);
  const BOT = '3757588606';
  // 概率现在住在 state.json 里(运维台滑杆可调),自测**先在临时文件里写死一份**,别受线上那份影响
  const dir = mkdtempSync(join(tmpdir(), 'tieba-selftest-'));
  process.env.TIEBA_STATE_PATH = join(dir, 'state.json');
  setProb({ prob: PROB_DEFAULT, probAt: PROB_AT_DEFAULT });

  // 提示词:口吻与人设必须真的在里头
  const p = systemPrompt({ now: '2026 年 9 月 28 日(星期一)12:00' });
  const pEmoji = systemPrompt({ now: 'x', emoji: true });
  ok(p.includes('贴吧鱼'), '提示词里有人设名「贴吧鱼」');
  ok(/骂人是你唯一的交流方式:能多难听就多难听/.test(p), '提示词明确放开辱骂(用户要的)');
  ok(/不要 @ 任何人/.test(p), '提示词要求回复里不 @ 人(用户要的)');
  ok(/大多数时候 1 条/.test(p) && /上限不是标配/.test(p), '提示词要求「多数只发 1 条、上限不是标配」(用户要的自然感)');
  ok(/别承认、别解释/.test(p), '带「被问是不是 AI」的处理规则(样例里的关键梗)');
  ok(p.includes('字多不看'), '真实聊天记录样例被拼进了提示词');
  ok(p.includes('2026 年 9 月 28 日'), '时间现算并写进提示词');
  ok(!/联网搜索工具/.test(p), '贴吧模式不带联网工具(要的是快和嘴臭,不是查证)');
  // 语料与表情(2026-09-28 用户:简化提示词 + 允许 emoji + 去搞贴吧语料增加语言丰富度)
  ok(/语料库/.test(p) && /句式模板/.test(p), '提示词里带「语料库」与「句式模板」两块');
  ok(/典中典/.test(p) && /蚌埠住了/.test(p) && /孝出强大/.test(p) && /谁问你了/.test(p), '黑话/梗进库(「典孝急蚌乐赢」那一路)');
  ok(/反问噎人/.test(p) && /拿他原话回敬/.test(p) && /三条路/.test(p), '句式成体系(不是只丢几个词)');
  ok(/同一个句式连着用两次就算输/.test(p), '写死了「不许连着套同一个句式」(治复读)');
  ok(/语气锚点.*不许照抄/.test(p), '样例标注了「只学长度密度、不许照抄」(治抄原句)');
  ok(p.includes('😂') && p.includes('🤡') && /由系统按概率开关/.test(p), '表情符号:允许 😂🤡,但「带不带看系统那行提示」');
  ok(/不许用 💀 🙏/.test(p), '💀🙏 已被禁(用户:骷髅头/祈祷攻击性太弱)');
  ok(!/💀/.test(p.split('不许用')[1]?.split('\n')[2] || '') && !/可用.*💀/.test(p), '可用清单里没有 💀');
  ok(/这次别带表情/.test(p) && !/这次可以用表情/.test(p), '默认(没抽中)时提示词明确禁止带表情');
  ok(/这次可以用表情/.test(pEmoji) && !/这次别带表情/.test(pEmoji), '抽中时提示词才允许带一个');
  ok(emojiAllowed(() => 0.1, 0.25) === true && emojiAllowed(() => 0.9, 0.25) === false, '表情骰子按概率放行/拦截');
  ok(EMOJI_PROB > 0 && EMOJI_PROB <= 0.5, `表情概率默认偏低(TIEBA_EMOJI_PROB=${EMOJI_PROB})`);
  ok(/永远不带:和事佬表情与任何示弱表情/.test(p), '禁掉和事佬表情与示弱表情(免得滑回客服腔/软下来)');
  ok(/每条\*\*至少 4 个字\*\*/.test(p), '写死了「每条至少 4 个字」(治单发一个 🤡 那种秃回复)');
  ok(/别造谣/.test(p), '写死了「不许编具体的性污蔑/违法指控」(那是造谣,实测不加会滑过去)');
  ok(!/沪爷|京爷/.test(p), '地域梗没进提示词(那一类不收录)');

  // 连发拆分
  const s1 = splitReply('就你那根牙签\n捅你自己皮炎都费劲\n滚去艹你妈，别在我面前狗叫');
  ok(s1.length === 3 && s1[0] === '就你那根牙签', `按行拆成 3 条:${JSON.stringify(s1)}`);
  const s2 = splitReply('1. 字多不看，急了\n2. 这一长串是你妈临终前教你的？');
  ok(s2.length === 2 && s2[0] === '字多不看，急了', `模型加的序号被去掉:${JSON.stringify(s2)}`);
  const long = splitReply('你'.repeat(30), { max: 3, maxChars: 10 });
  ok(long.length === 3 && long.every(x => x.length <= 10), `超长内容按字数切成 ≤10 字的多条:${JSON.stringify(long)}`);
  const sent = splitReply('先把你妈的后事办了再来舔你爹。嘴挺硬，等下别哭。', { maxChars: 12, max: 5 });
  ok(sent.length === 2 && sent.every(x => x.length <= 12) , `超长句被切成不超过 12 字的几条:${JSON.stringify(sent)}`);
  // 短句合并:两个各有句号的短句,凑得进一条就并成一条(不然会碎成「你也配」这种半句)
  const merged = splitReply('字多不看，急了。还没睡？你妈守灵呢。', { maxChars: 20, max: 5 });
  ok(merged.length === 1 && merged[0] === '字多不看，急了。还没睡？你妈守灵呢。', `短句合并成一条:${JSON.stringify(merged)}`);
  ok(splitReply('只有一条').length === 1, '单条回复照原样发');
  ok(splitReply('').length === 0, '空回复 → 不发');
  ok(splitReply('a\n\n\nb').length === 2, '空行被忽略');

  // 条数随机(用户 2026-09-28:「不一定每次都发三条,随机一下条数,自然一点」)
  const w = [45, 35, 20];
  ok(pickCount(() => 0, w) === 1 && pickCount(() => 0.4499, w) === 1, '抽到 1 条(权重最高的那档)');
  ok(pickCount(() => 0.45, w) === 2 && pickCount(() => 0.7999, w) === 2, '抽到 2 条');
  ok(pickCount(() => 0.80, w) === 3 && pickCount(() => 0.9999, w) === 3, '抽到 3 条');
  const dist = { 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < 4000; i++) dist[pickCount(Math.random, w)]++;
  const share = n => dist[n] / 4000;
  ok(Math.abs(share(1) - 0.45) < 0.05 && Math.abs(share(3) - 0.20) < 0.05,
    `4000 次抽样分布接近权重:1条 ${(share(1) * 100).toFixed(1)}% / 2条 ${(share(2) * 100).toFixed(1)}% / 3条 ${(share(3) * 100).toFixed(1)}%`);
  ok(dist[1] > dist[2] && dist[2] > dist[3], '「一条」比「两条」多、「两条」比「三条」多(不是平均分布)');

  // 抽中 1 条但模型写了 2~3 行:多出来的行**并进最后一条**(不许把话丢一半)
  const two = splitReply('就你那根牙签\n捅你自己皮炎都费劲', { max: 1 });
  ok(two.length === 1 && two[0] === '就你那根牙签 捅你自己皮炎都费劲', `抽中 1 条时多出的行并进末条:${JSON.stringify(two)}`);
  const three = splitReply('字多不看，急了\n还没睡？你妈守灵呢\n废物还挑起来了', { max: 1, maxChars: 40 });
  ok(three.length === 1 && three[0].includes('废物还挑起来了'), `三行并成一条(≤40 字):${JSON.stringify(three)}`);
  const tooLong = splitReply('你'.repeat(30) + '\n' + '我'.repeat(30), { max: 1, maxChars: 10 });
  ok(tooLong.length === 1 && tooLong[0].length <= 10, `并不下就不硬并(仍守字数上限):${JSON.stringify(tooLong)}`);
  const cap = splitReply('a\nb\nc\nd\ne', { max: 2, maxChars: 4 });
  ok(cap.length <= 2, `上限 2 条时不会发出第 3 条:${JSON.stringify(cap)}`);

  // 值不值得接:「碎话护栏」已按用户要求拆掉(2026-09-28),现在只有「连文字带图都没有」才不接
  ok(worthReplying({ text: '草' }).ok === true, '「草」这种短话也算值得接(护栏已拆)');
  ok(worthReplying({ text: '?' }).ok === true, '「?」也值得接');
  ok(worthReplying({ text: '[表情:微笑]' }).ok === true, '纯表情值得接');
  ok(worthReplying({ text: '[图片]', hasImage: true }).ok === true, '纯图片值得接');
  ok(worthReplying({ text: '' }).ok === false, '真的什么都没有(无文字也无图)才不接');
  ok(worthReplying({ text: '这比玩意这么智能?' }).ok === true, '有内容的吐槽要接');
  ok(MIN_CHARS === 0, `护栏门槛默认 0(想恢复旧行为设 TIEBA_MIN_CHARS=4):当前 ${MIN_CHARS}`);
  ok(worthReplying({ text: '草' }, 4).ok === false, '把门槛手动设成 4 时,「草」又会被拦(说明这个开关还在)');

  // 概率语义(把随机数钉死,别靠运气)
  const never = () => 0.99, always = () => 0.01;
  ok(decideReply({ text: '这比玩意这么智能?' }, { rand: never }).reply === false, '掷出 0.99 > 0.7 → 不接');
  ok(decideReply({ text: '这比玩意这么智能?' }, { rand: always }).reply === true, '掷出 0.01 < 0.7 → 接');
  ok(decideReply({ text: '草' }, { rand: always }).reply === true, '碎话照样进概率判定(护栏已拆)');
  ok(decideReply({ text: '这比玩意这么智能?' }, { at: true, rand: never, probAt: 0.7 }).reply === false, '@ 也要掷骰子(TIEBA_AT_PROB=0.7 时掷出 0.99 → 不接)');
  ok(decideReply({ text: '这比玩意这么智能?' }, { at: true, rand: always, probAt: 0.7 }).reply === true, 'TIEBA_AT_PROB=0.7 时掷出 0.01 → 接');
  ok(decideReply({ text: '这比玩意这么智能?' }, { at: true, rand: never }).reply === true, '@ 了必接(默认 TIEBA_AT_PROB=1:掷什么都接)');
  ok(PROB === 0.7 || Math.abs(PROB - 0.7) < 0.001, `默认概率是需求里的 70%(当前 ${PROB})`);

  // 上下文:去重、跳过 bot 自己、按时间排序、非今天的带「昨天」前缀
  const now = new Date('2026-09-28T12:00:00+08:00').getTime();
  const t = (h, m) => Math.floor(new Date(`2026-09-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`).getTime() / 1000);
  const y = Math.floor(new Date('2026-09-27T22:10:00+08:00').getTime() / 1000);
  const ctx = buildContext('g1', [
    { seq: 3, ts: t(11, 59), uid: 'u2', nick: '何如是', text: '@贴吧鱼 我喜欢你' },
    { seq: 1, ts: t(11, 57), uid: 'u1', nick: '还没睡', text: '你妈守灵呢' },
    { seq: 2, ts: y, uid: 'u3', nick: '草寇', text: '昨天说的话' },
    { seq: 3, ts: t(11, 59), uid: 'u2', nick: '何如是', text: '@贴吧鱼 我喜欢你' },   // 重复
    { seq: 4, ts: t(12, 0), uid: BOT, nick: '贴吧鱼', text: '我自己刚说的' },          // bot 自己
  ], { botId: BOT, n: 10, now });
  const lines = ctx.split('\n');
  ok(lines.length === 3, `上下文取 3 行(去重 1 条、跳过 bot 自己 1 条):${lines.length}`);
  ok(lines[0].startsWith('昨天 ') && lines[0].includes('昨天说的话'), '昨天的消息带「昨天」前缀');
  ok(lines[2].includes('11:59 何如是|'), `最后一行是刚发的那条:${lines[2]}`);
  ok(!/我自己刚说的/.test(ctx), 'bot 自己的发言不进上下文');
  ok(buildContext('g1', [], { botId: BOT }).length === 0, '没有消息时上下文为空(由调用方兜底)');

  // 段渲染:各类型都认,且 @ 不写成 @all
  ok(segText([{ type: 'text', data: { text: ' 你好 ' } }, { type: 'at', data: { qq: '123' } }], BOT) === '你好 @成员123',
    '文本+@ 渲染成一行');
  ok(segText([{ type: 'at', data: { qq: BOT } }], BOT) === '@你(贴吧鱼)', '@ 机器人自己 → @你(贴吧鱼)');
  ok(segText([{ type: 'at', data: { qq: 'all' } }], BOT) === '@全体成员', '@全体成员 不是人');
  ok(segText([{ type: 'face', data: { id: '14' } }]) === '[表情:微笑]', 'QQ 表情按 id 换名字');
  ok(segText([{ type: 'image', data: { url: 'u' } }]) === '[图片]', '图片 → [图片]');
  ok(segText([{ type: 'image', data: { sub_type: 1, summary: '[动画表情]' } }]) === '[表情包]', '表情包单独标');
  ok(segText([{ type: 'video', data: {} }]) === '[视频]', '视频 → [视频]');
  ok(!/@all\b/.test(segText([{ type: 'at', data: { qq: '999' } }], BOT)), '查不到名字也不写 @all');
  ok(segText([{ type: 'text', text: ' 裁剪段 ' }]) === '裁剪段', 'inbox 裁剪段({type,text})也认');
  ok(segLine({ type: 'reply', data: { id: '1' } }) === '', '引用段自己不留字(内容由 aichat 摊平)');

  // 群指令
  ok(parseGroupCommand('贴吧模式 开').on === true, '「贴吧模式 开」认');
  ok(parseGroupCommand('贴吧模式关').on === false, '「贴吧模式关」认(空格可有可无)');
  ok(parseGroupCommand('贴吧模式').triggered === true && parseGroupCommand('贴吧模式').on === null, '只说功能名 → 报当前状态');
  ok(parseGroupCommand('每日一卡').triggered === false, '别的指令不误触发');

  // 分群状态读写(走 state.json,别污染线上的那份:用 TIEBA_STATE_PATH 指到临时文件)
  const st = loadState();
  ok(typeof st.groups === 'object', `状态文件可读:${JSON.stringify(st.groups)} 路径 ${statePath()}`);

  console.log(chunks.join('\n'));
  const bad = chunks.filter(c => c.startsWith('✗'));
  console.log(`\n${chunks.length - bad.length}/${chunks.length} 通过`);
  process.exitCode = bad.length ? 1 : 0;
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest') || !args.length) selftest();
  else if (args.includes('--prompt')) console.log(systemPrompt({ now: new Date().toLocaleString('zh-CN', { hour12: false }) }));
  else {
    const [gid, act] = args;
    if (!act) {
      console.log(`群 ${gid} 贴吧模式:${isOn(gid) ? '开启' : '关闭'}`);
      console.log('全部状态:', JSON.stringify(allOn(), null, 2), '\n文件:', statePath());
    } else {
      const on = /^(on|开|开启|打开|1)$/i.test(act);
      console.log('设置:', JSON.stringify(setOn(gid, on)), '| 现在:', isOn(gid) ? '开启' : '关闭');
    }
  }
}