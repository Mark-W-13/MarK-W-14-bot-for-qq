// 运维 WebUI —— 浏览器里看状态 / 切开关 / 重启服务 / 看日志 / 看 QQ 界面
//
// 设计要点(改之前先读这段):
//   1. 零 npm 依赖,只用 node:http / node:fs / node:child_process。
//   2. 只监听 127.0.0.1,端口由 OPSWEB_PORT 覆盖(默认 8090)。绑回环是硬编码的,
//      故意不给 env 开口子 —— 这台是共享服务器,绑 0.0.0.0 等于把重启服务的按钮
//      挂到公网上。访问一律走 SSH 隧道:
//          ssh -N -L 8090:127.0.0.1:8090 w-13@<服务器>
//   3. 要有鉴权:同机其他本地用户能连任何回环端口,而这个 UI 能重启服务。
//   4. 控制通道走 tmux send-keys 敲 monitor 自己的键盘面板,不改 monitor.mjs。
//      原因:features.json 对运行中的 monitor 是「启动时读一次」,外部改文件不生效;
//      但面板按键是活的,monitor 的 toggleFeature() 会 saveFeatures() 写回磁盘,
//      所以磁盘状态自动保持同步,且即时生效、零重启。
//   5. monitor 不写日志文件,所以日志和 WS 状态是从 tmux 面板文本里抓的。
//
// 用法: node opsweb.mjs      (端口见 OPSWEB_PORT,令牌见 .env 的 OPSWEB_TOKEN)

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync,
         openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { allModes, setMode as setGroupMode, modeOf, MODE_CN, MODES } from './modes.mjs';
import { getTone, setTone, TONES, TONE_CN, TONE_DESC, tonePath } from './aichat/tone.mjs';
// 贴吧模式(2026-09-28):分群开关与状态都在 tieba/tieba.mjs 里,本文件只画界面、写文件。
// **不走 tmux 按键**:它和游戏模式/提示词档位一样是「文件即状态」,monitor 每次用到时现读,
// 所以这里点一下立刻生效、不用重启 monitor(见下方 /api/tieba)。
import {
  allOn as tiebaAll, isOn as tiebaOn, setOn as tiebaSetOn, statePath as tiebaStatePath,
  probOf as tiebaProbOf, probAtOf as tiebaProbAtOf, setProb as tiebaSetProb,
  PROB_DEFAULT as TIEBA_PROB, PROB_AT_DEFAULT as TIEBA_AT_PROB, CTX as TIEBA_CTX, MAX_REPLY as TIEBA_MAX_REPLY,
  MAX_CHARS as TIEBA_MAX_CHARS, NEW_GAP_MS as TIEBA_GAP_MS, MIN_CHARS as TIEBA_MIN_CHARS,
} from './tieba/tieba.mjs';
// 银河皇帝模式(2026-10-26):状态、提示词、表情包库都在 belial/belial.mjs。本文件只画界面、
// 写状态文件、收发上传的图片 —— monitor 每次回复前现读 state.json / 表情包目录,点完立即生效。
import {
  allOn as belialAll, isOn as belialOn, setOn as belialSetOn, statePath as belialStatePath,
  nonAtProbOf as belialNonAtProbOf, setNonAtProb as belialSetNonAtProb, NONAT_PROB_DEFAULT as BELIAL_NONAT_PROB,
  nonAtAutoOf as belialNonAtAutoOf, setNonAtAuto as belialSetNonAtAuto,
  autoProbsOf as belialAutoProbsOf, setAutoProbs as belialSetAutoProbs,
  stickerCatalog as belialStickerCatalog,
  addSticker as belialAddSticker, deleteSticker as belialDeleteSticker,
  setStickerMeta as belialSetStickerMeta, dynamicStickerMeta as belialDynamicStickerMeta,
  stickerPath as belialStickerPath, stickerMime as belialStickerMime, stickerDir as belialStickerDir,
  MAX_STICKER_BYTES as BELIAL_MAX_STICKER, FEATURE_CN as BELIAL_CN, KEYWORD as BELIAL_KEYWORD,
  personaOf as belialPersonaOf, setPersona as belialSetPersona, PERSONA_IDS, PERSONA_LABELS,
  GROUP_CARD as BELIAL_GROUP_CARD, originalCardOf as belialOriginalCardOf,
  setOriginalCard as belialSetOriginalCard, clearOriginalCard as belialClearOriginalCard,
} from './belial/belial.mjs';
// 脚刷周模式(2026-10-29):第二个人格。表情包库/开关与贝利亚共用同一个面板,
// 这里只多读一份它的表情包目录,并在 /api/belial 里接 persona 参数。
import {
  stickerCatalog as jszStickerCatalog, addSticker as jszAddSticker, deleteSticker as jszDeleteSticker,
  setStickerMeta as jszSetStickerMeta, dynamicStickerMeta as jszDynamicStickerMeta,
  stickerPath as jszStickerPath, stickerMime as jszStickerMime, stickerDir as jszStickerDir,
  MAX_STICKER_BYTES as JSZ_MAX_STICKER, PERSONA_CN as JSZ_CN, KEYWORD as JSZ_KEYWORD,
  PERSONA_ID as JSZ_ID, GROUP_CARD as JSZ_GROUP_CARD, SEED_MEMORIES as JSZ_SEED_MEMORIES,
} from './jiaoshuazhou/jiaoshuazhou.mjs';
// 西比拉(2026-10-29 正式上线):记忆驱动人格,系统提示只有一句身份 + 记忆块。
import {
  PERSONA_ID as SIBYL_ID, PERSONA_CN as SIBYL_CN, GROUP_CARD as SIBYL_GROUP_CARD,
} from './persona/sibyl.mjs';
import {
  addMemory as personaAddMemory, deleteMemory as personaDeleteMemory, updateMemory as personaUpdateMemory,
  listMemories as personaListMemories, memoryStats,
} from './persona/memory.mjs';
import { readVoiceMode, setVoiceMode, voiceCatalog, voiceModeLabel } from './belial/voice.mjs';
import { autonameStickers } from './belial/autoname.mjs';
// ⚠ 这一行只是把 env.mjs **加载**进来 —— 它**被 import 的那一刻**就自己把 agent/.env 读进
//   process.env 了(env.mjs 文件末尾有 loadEnvFile())。所以本文件**不要再自己调一次** loadEnvFile():
//   那时 .env 的键已经在 process.env 里,再调会因为「已存在」而全部跳过、返回空数组,
//   2026-09-21 就在启动日志里打出过误导人的「agent/.env: 读入 0 个键」。要展示读了哪些键用 envLoadedKeys()。
import { envLoadedKeys } from './env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT = __dirname;

// ---------- .env ----------
// 为什么这里曾经出过事(2026-09-21 定位并修,别再抄回去):
//   本文件原先**自己手抄了一份** .env 解析,正则写作 `/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/`,
//   而本仓库的 .env 是 **CRLF** 的 —— 在 Node 24 上这条正则**一行都匹配不上**
//   (实测:`"A=1\r".match(...)` → null,`\s*$` 撞上结尾的 `\r` 会回退失败)。
//   后果:opsweb 读不到 OPSWEB_TOKEN(登录直接废)、也读不到 ZHIPU_API_KEY
//   (联网源被误判成「零 key」的 bing),而同一台机器上的 monitor(走 env.mjs)一切正常 ——
//   两个进程行为不一致,极难查。现在两边统一由 env.mjs 负责解析,别再各写一份。
const loadedEnvKeys = envLoadedKeys();

const PORT = Number(process.env.OPSWEB_PORT || 8090);
const HOST = '127.0.0.1';                       // 硬编码,理由见文件头
const SESSION = process.env.OPSWEB_TMUX_SESSION || 'mc';
const TOKEN = process.env.OPSWEB_TOKEN || '';

const FEATURES = join(AGENT, 'features.json');
const CARDS = join(AGENT, 'ygocard', 'cards.json');
const IMG_DIR = join(AGENT, 'ygocard', 'cards_img');
const AICHAT_STATS = join(AGENT, 'aichat_stats.json');   // AI 闲聊按用户记账(monitor 写,本页只读)
const SEARCH_STATS = join(AGENT, 'search_stats.json');   // 联网搜索次数记账(monitor 写,本页只读)

// AI 闲聊后端(2026-09-21 起与 monitor.mjs 同一套:**只有一条 OpenAI 兼容后端**,智谱聊天后端已删)。
// 界面文案要跟着实际配置走 —— 2026-09-17 用户指出这里还写死成 GLM,与实际不符。
// 注意:.env 是 opsweb 启动时读的,换后端后要重启 opsweb(monitor 同理)文案才更新。
const AI_MODEL_NAME = process.env.AI_CHAT_MODEL || 'deepseek-flash';
const AI_BACKEND_NAME = /deepseek/i.test(AI_MODEL_NAME) ? 'DeepSeek' : '对话模型';
// 联网:2026-09-21 从「智谱服务端注入」改成「本地 function calling 工具」,**任何后端都能搜**,
// 所以这里不再需要区分后端。文案直接说清用的哪个搜索源(文案与 monitor 的 searchProviderText 口径一致)。
const AI_SEARCH_ON = process.env.AI_CHAT_WEB_SEARCH !== '0';
const AI_SEARCH_PROVIDER = process.env.SEARCH_PROVIDER
  || (process.env.ZHIPU_API_KEY ? 'zhipu' : process.env.TAVILY_API_KEY ? 'tavily' : process.env.BOCHA_API_KEY ? 'bocha' : 'bing');
const AI_CHAT_DESC = `未命中指令的 @ 交给 ${AI_BACKEND_NAME}(${AI_MODEL_NAME}) 接话,图片直传一轮(@/引用/表情/图片都认);`
  + `联网${AI_SEARCH_ON ? `开(源:${AI_SEARCH_PROVIDER},自己判断该不该搜)` : '关'}`;

// 受管的 systemd 用户级单元(顺序即界面顺序)
const UNITS = [
  { unit: 'xvfb',     label: '虚拟显示', hint: 'Xvfb :99,QQ 的屏幕' },
  { unit: 'snowluma', label: 'SnowLuma', hint: 'QQ 协议桥接,OneBot 后端' },
  { unit: 'qq',       label: 'QQ 客户端', hint: '登录态在这里' },
  { unit: 'mc-agent', label: 'monitor',   hint: '收消息/回消息的主进程' },
  { unit: 'opsweb',   label: '本页面',     hint: '重启它会断掉当前页面' },
];

// ---------- 小工具 ----------

// 带超时的子进程调用。超时是刚需:tmux/systemctl 卡住不能把 HTTP 响应一起拖死。
// ⚠ 必须吞掉「同步抛出的 spawn 错误」:execFile 在**起不来**时会**同步 throw**
//   (实测被沙箱限制的环境里是 `spawn EPERM`,机器上没有 tmux/systemctl 时是 ENOENT)。
//   不吞的话异常会穿出 buildStatus,把整个 /api/status 打成 500 —— 页面全白,
//   而真实原因只是「这台机器上没 systemctl」。2026-09-21 在本地复现到,顺手修掉:
//   服务控制类接口本来就有 code 判断,返回 code:1 反而能给出「已停止」这种看得懂的状态。
function sh(cmd, args = [], timeout = 8000) {
  return new Promise(resolve => {
    const done = (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      out: stdout || '',
      err: stderr || '',
    });
    try {
      execFile(cmd, args, { timeout, encoding: 'utf8' }, done);
    } catch (e) {
      resolve({ code: 1, out: '', err: e.message || String(e) });
    }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 去掉 ANSI 色码,顺便去掉行尾 \r
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function countImages() {
  try { return readdirSync(IMG_DIR).filter(f => f.endsWith('.jpg')).length; } catch { return 0; }
}

// 抓 tmux 面板最近内容。-S -N 表示从历史缓冲往回取 N 行。
async function tmuxPane(historyLines = 800) {
  const r = await sh('tmux', ['capture-pane', '-p', '-S', `-${historyLines}`, '-t', SESSION], 6000);
  if (r.code !== 0) return null;
  return stripAnsi(r.out).split('\n');
}

async function tmuxHasSession() {
  const r = await sh('tmux', ['has-session', '-t', SESSION], 4000);
  return r.code === 0;
}

async function unitState(unit) {
  const [a, e] = await Promise.all([
    sh('systemctl', ['--user', 'is-active', `${unit}.service`], 4000),
    sh('systemctl', ['--user', 'is-enabled', `${unit}.service`], 4000),
  ]);
  return { active: a.out.trim() === 'active', enabled: e.out.trim() === 'enabled' };
}

async function listeningPorts() {
  const r = await sh('ss', ['-tln'], 5000);
  return r.out.split('\n').filter(l => /LISTEN/.test(l)).map(l => (l.trim().split(/\s+/)[3] || ''));
}

// 从面板文本里判定 WS 状态:取「最后一次」出现的那条状态行,因为它之后可能又断过。
function wsStateFrom(lines) {
  if (!lines) return { state: 'unknown', detail: '读不到面板(tmux 会话不在?)' };
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/WS 已连接/.test(l)) return { state: 'up', detail: l.trim() };
    if (/连接断开|强制重连 WS|WS 错误/.test(l)) return { state: 'down', detail: l.trim() };
  }
  return { state: 'unknown', detail: '暂无连接状态记录' };
}

function lastMatch(lines, re) {
  if (!lines) return '';
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return lines[i].trim();
  return '';
}

// SnowLuma 的日志:收发的 QQ 消息都在这里。
// 它的 DEBUG 级输出极吵(Bridge.Action 每次调用都打一行,占比 90%+),
// 所以默认只筛 [Event](收到的消息)与 [OneBot] 的 INFO 以上(发出的消息/异常)。
const SNOW_LOG_DIR = join(process.env.HOME || '', 'opt', 'snowluma', 'logs');

function snowlumaLogTail(maxBytes = 512 * 1024) {
  let files;
  try { files = readdirSync(SNOW_LOG_DIR).filter(f => f.endsWith('.log')).sort(); }
  catch { return null; }
  if (!files.length) return null;
  const full = join(SNOW_LOG_DIR, files[files.length - 1]);   // 文件名带日期,取最新那个
  let fd;
  try {
    fd = openSync(full, 'r');
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - maxBytes);                // 只读尾部,别把整个文件吞进内存
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return { file: files[files.length - 1], lines: buf.toString('utf8').split('\n') };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 关不掉就算了 */ } }
  }
}

function filterSnowLog(lines, mode) {
  const keep = l => {
    if (!l.trim()) return false;
    if (mode === 'all') return true;
    if (l.includes('[Event]')) return true;                                    // 收到的 QQ 消息
    return l.includes('[OneBot]') && /(INFO|WARN|ERROR)/.test(l);              // 发送/异常,滤掉 DEBUG
  };
  return lines.filter(keep).map(l => l.replace(/\s+$/, ''));
}

// 调 OneBot 拿账号信息 / 改群名片(本地回环 + 令牌)
async function onebot(action, params = {}) {
  const api = process.env.API || 'http://127.0.0.1:3000/';
  const token = process.env.API_TOKEN || process.env.SNOWLUMA_API_TOKEN || '';
  if (!token) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(api + action, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctl.signal,
    });
    clearTimeout(t);
    return await r.json();
  } catch { return null; }
}

// ---------- 分群游戏模式(游戏王 / 炉石传说,2026-09-20) ----------
// 与 monitor 共用 agent/modes.json(键=群号,值=ygo|hs);monitor 每次现读,所以这里改完立即生效。
// 顺带把群名带出来(群里 @ 过 bot 的群在 OneBot 的 get_group_list 里都有)。
async function groupsWithMode() {
  const modes = allModes();
  const nameOf = new Map();
  const j = await onebot('get_group_list');
  for (const g of (j?.data || [])) {
    if (g?.group_id) nameOf.set(String(g.group_id), g.group_name || '');
  }
  for (const gid of Object.keys(modes)) if (!nameOf.has(gid)) nameOf.set(gid, '');
  return [...nameOf.entries()]
    .map(([groupId, name]) => ({ groupId, name, mode: modeOf(groupId), cn: MODE_CN[modeOf(groupId)] }))
    .sort((a, b) => String(a.name || a.groupId).localeCompare(String(b.name || b.groupId), 'zh'));
}

// ---------- 贴吧模式(2026-09-28) ----------
// 界面用的是**同一份群列表**(get_group_list),但每群多带一个「贴吧模式开没开」。
// 开关状态读 tieba/state.json(与 monitor 同一个文件),所以这里显示的就是线上正在生效的状态。
async function groupsWithTieba() {
  const st = tiebaAll();
  const nameOf = new Map();
  const j = await onebot('get_group_list');
  for (const g of (j?.data || [])) if (g?.group_id) nameOf.set(String(g.group_id), g.group_name || '');
  // 已经开着贴吧模式、但不在群列表里的群(退群/接口拿不到)也要显示出来,否则关不掉
  for (const gid of st.groups) if (gid !== '*' && !nameOf.has(gid)) nameOf.set(gid, '');
  const rows = [...nameOf.entries()]
    .map(([groupId, name]) => ({ groupId, name, tieba: st.all ? true : tiebaOn(groupId) }))
    .sort((a, b) => Number(b.tieba) - Number(a.tieba)
      || String(a.name || a.groupId).localeCompare(String(b.name || b.groupId), 'zh'));
  return { all: st.all, groups: rows, opened: rows.filter(r => r.tieba).length, file: tiebaStatePath(), updatedAt: st.updatedAt };
}

// ---------- 人格面板(2026-10-26 银河皇帝,2026-10-29 加脚刷周后改名) ----------
// 与贴吧模式同一套群列表与开关交互:状态读 belial/state.json(monitor 用的同一个文件),
// 所以这里显示的就是线上正在生效的状态。每群在「贝利亚 / 脚刷周」里二选一;表情包库也按人格分开。
async function groupsWithBelial() {
  const st = belialAll();
  const nameOf = new Map();
  const j = await onebot('get_group_list');
  for (const g of (j?.data || [])) if (g?.group_id) nameOf.set(String(g.group_id), g.group_name || '');
  for (const gid of st.groups) if (gid !== '*' && !nameOf.has(gid)) nameOf.set(gid, '');
  const rows = [...nameOf.entries()]
    .map(([groupId, name]) => {
      const on = belialOn(groupId);
      const persona = belialPersonaOf(groupId);
      return { groupId, name, belial: on, on, persona };
    })
    .sort((a, b) => Number(b.belial) - Number(a.belial)
      || String(a.name || a.groupId).localeCompare(String(b.name || b.groupId), 'zh'));
  const opened = rows.filter(r => r.belial).length;
  const jszCount = rows.filter(r => r.belial && r.persona === JSZ_ID).length;
  return {
    all: st.all, groups: rows, opened,
    belialCount: opened - jszCount, jszCount,
    personas: st.personas || {},
    nonAtProb: st.nonAtProb, nonAtAuto: st.nonAtAuto !== false,
    autoMaxProb: st.autoMaxProb, autoMinProb: st.autoMinProb, file: belialStatePath(), updatedAt: st.updatedAt,
  };
}

/** 人格 → 群名片(群昵称) */
const PERSONA_GROUP_CARD = { belial: BELIAL_GROUP_CARD, [JSZ_ID]: JSZ_GROUP_CARD, [SIBYL_ID]: SIBYL_GROUP_CARD };
const BOT_UIN = () => String(process.env.BOT_ID || '3757588606');

/**
 * 切人格时同步群名片(2026-10-29 用户要求):
 *   贝利亚 → 「贝利亚大王」,脚刷周 → 「脚刷周」;关掉时恢复切换前的名片。
 * 第一次切之前把原名片记进 belial/state.json 的 cards,monitor 与 opsweb 共用。
 * 群名片是「尽力而为」:OneBot 失败只影响这一项,不影响开关。
 */
async function readBotGroupCard(gid) {
  // 三个来源都可能缓存,历史消息里的发送者名片最接近真实
  let hist;
  const h = await onebot('get_group_msg_history', { group_id: Number(gid), count: 20 });
  for (const m of ((h?.data?.messages) || []).slice().reverse()) {
    if (String(m.user_id) === BOT_UIN()) { hist = String(m.sender?.card ?? ''); break; }
  }
  const list = await onebot('get_group_member_list', { group_id: Number(gid) });
  const me = (list?.data || []).find(m => String(m.user_id) === BOT_UIN());
  if (hist !== undefined) return hist;
  if (me) return String(me.card ?? '');
  const info = await onebot('get_group_member_info', { group_id: Number(gid), user_id: Number(BOT_UIN()) });
  if (info?.status === 'ok') return String(info.data?.card ?? '');
  return undefined;
}
async function setBotGroupCard(gid, card) {
  let target = String(card ?? '');
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(700 * attempt);
    const r = await onebot('set_group_card', { group_id: Number(gid), user_id: Number(BOT_UIN()), card: target });
    if (r?.status !== 'ok') { lastErr = r?.wording || `retcode ${r?.retcode}`; continue; }
    await sleep(500);
    const now = await readBotGroupCard(gid);
    if (now === target) return true;
    lastErr = `回读是「${now === undefined ? '读不到' : now}」`;
    if (!target && now !== undefined) {
      const fallback = String(process.env.PERSONA_DEFAULT_CARD || 'W14').trim();
      if (fallback) { target = fallback; lastErr += ',改用默认名片兜底'; }
    }
  }
  console.log(`群名片切换失败 ${gid} → ${card || '(清空)'}: ${lastErr}`);
  return false;
}
async function applyPersonaCard(gid, persona) {
  if (!PERSONA_GROUP_CARD[persona]) return false;
  if (belialOriginalCardOf(gid) === undefined) {
    const cur = await readBotGroupCard(gid);
    if (cur !== undefined) belialSetOriginalCard(gid, cur);
  }
  return setBotGroupCard(gid, PERSONA_GROUP_CARD[persona]);
}
async function restorePersonaCard(gid) {
  const orig = belialOriginalCardOf(gid);
  if (orig === undefined) return true;
  const ok = await setBotGroupCard(gid, orig);
  if (ok) belialClearOriginalCard(gid);
  return ok;
}
// QQ 改群名片有频率限制:当场没恢复成功就隔 30s / 2min / 5min 再试(成功后记录自动清掉)
const cardRestoreTimers = new Map();
function scheduleRestoreCard(gid) {
  if (cardRestoreTimers.has(gid)) return;
  const delays = [30000, 120000, 300000];
  const tick = async (i) => {
    cardRestoreTimers.delete(gid);
    if (belialOriginalCardOf(gid) === undefined) return;
    await restorePersonaCard(gid);
    if (belialOriginalCardOf(gid) !== undefined && i + 1 < delays.length) {
      cardRestoreTimers.set(gid, setTimeout(() => tick(i + 1), delays[i + 1]));
    }
  };
  cardRestoreTimers.set(gid, setTimeout(() => tick(0), delays[0]));
}
const cardApplyTimers = new Map();
function scheduleApplyCard(gid, persona) {
  if (cardApplyTimers.has(gid)) return;
  const delays = [30000, 120000];
  const tick = async (i) => {
    cardApplyTimers.delete(gid);
    if (!belialOn(gid) || belialPersonaOf(gid) !== persona) return;
    const ok = await applyPersonaCard(gid, persona);
    if (!ok && i + 1 < delays.length) {
      cardApplyTimers.set(gid, setTimeout(() => tick(i + 1), delays[i + 1]));
    }
  };
  cardApplyTimers.set(gid, setTimeout(() => tick(0), delays[0]));
}
function stickerApiFor(persona) {
  if (persona === JSZ_ID) {
    return {
      id: JSZ_ID, cn: JSZ_CN, dir: jszStickerDir, catalog: jszStickerCatalog,
      add: jszAddSticker, remove: jszDeleteSticker, path: jszStickerPath, mime: jszStickerMime,
      setMeta: jszSetStickerMeta, dynamicMeta: jszDynamicStickerMeta,
      maxBytes: JSZ_MAX_STICKER,
    };
  }
  return {
    id: 'belial', cn: PERSONA_LABELS.belial, dir: belialStickerDir, catalog: belialStickerCatalog,
    add: belialAddSticker, remove: belialDeleteSticker, path: belialStickerPath, mime: belialStickerMime,
    setMeta: belialSetStickerMeta, dynamicMeta: belialDynamicStickerMeta,
    maxBytes: BELIAL_MAX_STICKER,
  };
}

function hostStats() {
  const num = (s, re) => { const m = String(s).match(re); return m ? Number(m[1]) : 0; };
  let load = '', memTotal = 0, memAvail = 0, uptimeS = 0;
  try { load = readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '); } catch {}
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8');
    memTotal = num(mi, /MemTotal:\s*(\d+)/);
    memAvail = num(mi, /MemAvailable:\s*(\d+)/);
  } catch {}
  try { uptimeS = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]); } catch {}
  return { load, memTotal, memAvail, uptimeS };
}

async function diskStats() {
  const r = await sh('df', ['-k', '/'], 5000);
  const line = r.out.trim().split('\n')[1] || '';
  const p = line.trim().split(/\s+/);
  return { totalKb: Number(p[1]) || 0, usedKb: Number(p[2]) || 0, availKb: Number(p[3]) || 0 };
}

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}天${h}小时`;
  if (h) return `${h}小时${m}分`;
  return `${m}分钟`;
}

// ---------- 鉴权 ----------
// 会话表放内存即可:本进程重启后旧 cookie 失效,重新登录一次,符合预期。
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function newSession() {
  const id = randomBytes(24).toString('hex');
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  return id;
}

function checkSession(cookieHeader) {
  const m = /(?:^|;\s*)ops=([a-f0-9]{48})/.exec(cookieHeader || '');
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}

function tokenMatches(given) {
  if (!TOKEN || typeof given !== 'string') return false;
  const a = Buffer.from(TOKEN), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- 各接口的数据组装 ----------

// 账号信息基本不变,但状态页每 5 秒轮询一次 —— 不缓存会把 SnowLuma 日志刷满
// (实测 get_login_info 一天被调了 897 次,全是轮询)。缓存 60 秒足够新鲜。
let acctCache = { at: 0, val: null };
async function accountInfo() {
  if (Date.now() - acctCache.at < 60000) return acctCache.val;
  acctCache = { at: Date.now(), val: await onebot('get_login_info') };
  return acctCache.val;
}

async function buildStatus() {
  const lines = await tmuxPane();
  const feat = readJson(FEATURES) || {};
  const [services, ports, disk, info] = await Promise.all([
    Promise.all(UNITS.map(async u => ({ ...u, ...(await unitState(u.unit)) }))),
    listeningPorts(),
    diskStats(),
    accountInfo(),
  ]);
  let modes = [];
  try { modes = await groupsWithMode(); } catch { modes = []; }
  let cardsMtime = null;
  try { cardsMtime = statSync(CARDS).mtime.toISOString(); } catch {}
  const cards = readJson(CARDS);
  const host = hostStats();
  // AI 闲聊各用户次数:按「回复发给了谁」统计(monitor 落盘),这里只做排序与格式化。
  // 降序;名字取最近一次的群名片,标签是「名字(QQ号)」。
  const aiStat = readJson(AICHAT_STATS) || {};
  const aiRows = Object.entries(aiStat.users || {})
    .map(([qq, u]) => ({ qq, name: (u && u.name) || `成员${qq}`, count: (u && u.count) || 0, failed: (u && u.failed) || 0, last: (u && u.last) || 0 }))
    .filter(r => r.count > 0 || r.failed > 0)
    .sort((a, b) => b.count - a.count || b.last - a.last);
  return {
    services,
    onebot: {
      ws: ports.some(p => /:(3001)$/.test(p)),
      http: ports.some(p => /:(3000)$/.test(p)),
    },
    ws: wsStateFrom(lines),
    tmux: !!lines,
    features: { shitpost: !!feat.shitpost, kuangshen: !!feat.kuangshen, ai: !!feat.ai, updatedAt: feat.updatedAt || 0 },
    // 提示词档位(2026-09-21):与 features 那套不同,**不需要敲 tmux 按键** —— monitor 每次请求现读
    // tone.json,所以这里直接写文件就即时生效(见 /api/tone)。toneAt 顺便给界面显示文件时间。
    tone: {
      current: getTone(),
      options: TONES.map(t => ({ id: t, cn: TONE_CN[t], short: TONE_DESC[t].short, long: TONE_DESC[t].long })),
      file: tonePath(),
      updatedAt: (readJson(tonePath()) || {}).updatedAt || 0,
    },
    search: {
      enabled: AI_SEARCH_ON,
      provider: AI_SEARCH_PROVIDER,
      total: (readJson(SEARCH_STATS) || {}).total || 0,
      ok: (readJson(SEARCH_STATS) || {}).ok || 0,
      failed: (readJson(SEARCH_STATS) || {}).failed || 0,
      // byDay 的键是 monitor 的 dayKey() 格式(**本地时区、不补零**:2026-9-21),不是 ISO 日期,
      // 所以这里也按本地时区拼,别用 toISOString()(那是 UTC,东八区凌晨会错到昨天去)。
      today: ((readJson(SEARCH_STATS) || {}).byDay || {})[(() => {
        const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      })()] || null,
    },
    modes,
    // 贴吧模式(2026-09-28):分群开关 + 接话概率(现读 state.json,滑杆可调)+ 其余口径
    tieba: await (async () => {
      const t = await groupsWithTieba().catch(() => ({ all: false, groups: [], opened: 0, file: tiebaStatePath(), updatedAt: 0 }));
      return { ...t, prob: tiebaProbOf(), probAt: tiebaProbAtOf(), probEnv: TIEBA_PROB, probAtEnv: TIEBA_AT_PROB,
        probRange: { min: 0, max: 1, step: 0.05 },
        ctx: TIEBA_CTX, maxReply: TIEBA_MAX_REPLY,
        maxChars: TIEBA_MAX_CHARS, gapMs: TIEBA_GAP_MS, minChars: TIEBA_MIN_CHARS };
    })(),
    // 人格面板(2026-10-26 银河皇帝,2026-10-29 加脚刷周):分群开关 + 两个人格的表情包库
    belial: await (async () => {
      const b = await groupsWithBelial().catch(() => ({ all: false, groups: [], opened: 0, file: belialStatePath(), updatedAt: 0 }));
      return {
        ...b,
        stickers: belialStickerCatalog(),
        stickersJsz: jszStickerCatalog(),
        stickerDir: belialStickerDir(),
        stickerDirJsz: jszStickerDir(),
        maxStickerBytes: BELIAL_MAX_STICKER,
        maxStickerBytesJsz: JSZ_MAX_STICKER,
        keyword: BELIAL_KEYWORD,
        keywordJsz: JSZ_KEYWORD,
        cn: BELIAL_CN,
        cnJsz: JSZ_CN,
        personas: b.personas || {},
        personaOptions: [
          { id: 'belial', cn: BELIAL_CN, short: '贝利亚', keyword: BELIAL_KEYWORD, count: belialStickerCatalog().length },
          { id: JSZ_ID, cn: JSZ_CN, short: '脚刷周', keyword: JSZ_KEYWORD, count: jszStickerCatalog().length },
          { id: SIBYL_ID, cn: SIBYL_CN, short: '西比拉', keyword: '西比拉', count: 0 },
        ],
        // 人格记忆库(2026-10-29):群聊里模型自己 add/delete,这里给面板看/删/补
        memories: {
          belial: personaListMemories('belial', { includeSeed: true }),
          [JSZ_ID]: personaListMemories(JSZ_ID, { seed: JSZ_SEED_MEMORIES, includeSeed: true }),
          [SIBYL_ID]: personaListMemories(SIBYL_ID, { includeSeed: true }),
        },
        memoryStats: {
          belial: memoryStats('belial'),
          [JSZ_ID]: memoryStats(JSZ_ID, { seed: JSZ_SEED_MEMORIES }),
          [SIBYL_ID]: memoryStats(SIBYL_ID),
        },
        nonAtProb: belialNonAtProbOf(),
        nonAtAuto: belialNonAtAutoOf(),
        autoMaxProb: belialAutoProbsOf().max,
        autoMinProb: belialAutoProbsOf().min,
        nonAtProbEnv: BELIAL_NONAT_PROB,
        probRange: { min: 0, max: 1, step: 0.05 },
        voiceMode: readVoiceMode(),
        voiceOptions: voiceCatalog()
          .filter(v => ['belial', 'klee', 'laomushi', 'young'].includes(v.id))
          .map(v => ({ id: v.id, label: v.id === 'klee' ? '可莉' : (v.id === 'laomushi' ? '老牧师' : (v.id === 'young' ? '年轻男声' : '贝利亚')), provider: v.provider })),
        // 开关能点,但「AI 闲聊总开关关了 / 没配聊天 key」时开了也不会回 —— 界面上要说清
        aiOn: !!feat.ai,
        hasKey: !!(process.env.DEEPSEEK_API_KEY || process.env.AI_CHAT_API_KEY),
      };
    })(),
    account: info?.data ? { uin: String(info.data.user_id), nickname: info.data.nickname } : null,
    cards: { mtime: cardsMtime, count: cards ? Object.keys(cards).length : 0, images: countImages() },
    host: { ...host, disk, uptimeText: fmtDuration(host.uptimeS) },
    aiChat: {
      rows: aiRows,
      total: aiStat.total || 0,
      updatedAt: aiStat.updatedAt || 0,
      approximateSince: aiStat.approximateSince || '',
    },
    lastRequest: lastMatch(lines, /★ @请求/),
    lastSend: lastMatch(lines, /已发送 message_id=/),
  };
}

// 切开关:敲对应按键,然后回读 features.json 校验是否真的翻转了。
// 不做无脑 send-keys 的原因:monitor 可能正在重启,按键会掉进虚空。
async function setFeature(key, want) {
  if (key !== 'shitpost' && key !== 'kuangshen' && key !== 'ai') return { ok: false, message: '未知开关' };
  const before = readJson(FEATURES) || {};
  if (!!before[key] === !!want) return { ok: true, changed: false, features: before };

  if (!(await tmuxHasSession())) {
    return { ok: false, message: 'tmux 会话不在,monitor 可能正在重启 —— 稍后重试' };
  }
  const keyChar = key === 'shitpost' ? '1' : key === 'kuangshen' ? '2' : '3';
  const r = await sh('tmux', ['send-keys', '-t', SESSION, keyChar], 5000);
  if (r.code !== 0) return { ok: false, message: '按键发送失败:' + (r.err || '').trim() };

  await sleep(700);                               // 等 monitor 落盘
  const after = readJson(FEATURES) || {};
  if (!!after[key] === !!want) return { ok: true, changed: true, features: after };
  return {
    ok: false,
    message: '按键已发,但 features.json 没有按预期翻转 —— 刷新看看,若没变可能是 monitor 没在监听按键',
    features: after,
  };
}

async function updateCards() {
  if (!(await tmuxHasSession())) return { ok: false, message: 'tmux 会话不在,monitor 可能正在重启' };
  const r = await sh('tmux', ['send-keys', '-t', SESSION, 'u'], 5000);
  if (r.code !== 0) return { ok: false, message: '按键发送失败:' + (r.err || '').trim() };
  return { ok: true, message: '已触发卡库更新(monitor 在后台跑,进度看日志页)' };
}

// 从面板文本判定卡库更新的结果。
// monitor 打的字是固定的(agent/monitor.mjs updateCardDb):
//   开始  卡库更新:下载 cards.zip ...
//   成功  卡库更新完成: N 张卡 → path
//   失败  卡库更新失败: <原因>
//   重入  卡库更新进行中,忽略本次触发
// 从后往前找「最后一次」出现的那条,因为它之后可能又跑过一轮。
async function updateProgress() {
  const clean = ((await tmuxPane(400)) || []).map(l => l.trim()).filter(Boolean);
  let state = 'idle', message = '';
  for (let i = clean.length - 1; i >= 0; i--) {
    const l = clean[i];
    if (/卡库更新完成:/.test(l)) { state = 'done'; message = l; break; }
    if (/卡库更新失败:/.test(l)) { state = 'failed'; message = l; break; }
    if (/卡库更新进行中/.test(l)) { state = 'busy'; message = l; break; }
    if (/卡库更新:下载/.test(l)) { state = 'running'; message = '正在下载卡库(cards.zip)...'; break; }
  }
  const lines = clean.filter(l => /卡库更新|卡图更新|下载完成|md5/.test(l)).slice(-10);
  return { state, message, running: state === 'running' || state === 'busy', lines };
}

// ---------- 前端 ----------
// 注意:为了能安全地塞进模板字符串,下面的前端 JS 一律不用反引号和 ${}。
const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>赛博史官 · 运维台</title>
<style>
:root{--bg:#f1f2f3;--card:#fff;--tx:#18191c;--mut:#9499a0;--line:#e9eaeb;--ok:#2fa84f;--bad:#e05a5a;--warn:#e6a23c;--acc:#fb7299}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 "Noto Sans CJK SC","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:12px 14px;display:flex;align-items:center;gap:10px}
header h1{font-size:15px;margin:0;flex:1;font-weight:600}
.wrap{padding:12px;display:grid;gap:12px;grid-template-columns:1fr;max-width:1200px;margin:0 auto}
@media(min-width:720px){.wrap{grid-template-columns:1fr 1fr;padding:16px;gap:14px}}
@media(min-width:1080px){.wrap{grid-template-columns:1fr 1fr 1fr}}
.card{background:var(--card);border-radius:12px;padding:14px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
.card.wide{grid-column:1/-1}
.card h2{font-size:13px;margin:0 0 10px;color:var(--mut);font-weight:600;display:flex;align-items:center;gap:6px}
.row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .k{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .sub{font-size:11px;color:var(--mut)}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--mut)}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
button{font:inherit;border:1px solid var(--line);background:#fafafa;color:var(--tx);border-radius:8px;padding:8px 12px;cursor:pointer;min-height:36px}
button:hover:not(:disabled){background:#f0f0f1}
button:disabled{opacity:.45;cursor:not-allowed}
button.pri{background:var(--acc);border-color:var(--acc);color:#fff}
button.danger{color:var(--bad);border-color:#f0c8c8}
.sw{width:52px;height:30px;border-radius:15px;background:#d8d8d9;position:relative;transition:background .15s;flex-shrink:0;cursor:pointer}
.sw.on{background:var(--ok)}
.sw i{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;transition:left .15s}
.sw.on i{left:25px}
pre{margin:0;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;max-height:340px;overflow:auto}
#log,#snowlog{padding:10px;background:#1e1f22;color:#d6d6d6;border-radius:8px}
#log .t{color:#7f848e}
#snowlog{max-height:420px}
#snowlog .t{color:#7f848e}
#snowlog .snd{color:#8fd0ff}
#login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50}
#login .box{background:var(--card);padding:22px;border-radius:14px;width:100%;max-width:340px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
input[type=password]{font:inherit;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;margin:10px 0}
.mut{color:var(--mut);font-size:12px}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;background:var(--acc)}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#333;color:#fff;padding:10px 16px;border-radius:10px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw;text-align:center;z-index:60}
#toast.show{opacity:.95}
/* 卡库更新的结果横幅:要一眼看得见,别做成一堆看不懂的灰字 */
#upbox{margin-top:10px;padding:9px 11px;border-radius:8px;background:#fafafa;border:1px solid var(--line);display:none}
#upbox.show{display:block}
#upbox.ok{background:#eef9f1;border-color:#cdead8}
#upbox.bad{background:#fdeeee;border-color:#f4cfcf}
#upbox.run{background:#fdf7e8;border-color:#f0e0bf}
#uphead{font-weight:600;font-size:13px}
#upbox.ok #uphead{color:var(--ok)}#upbox.bad #uphead{color:var(--bad)}#upbox.run #uphead{color:var(--warn)}
#upmsg{font-size:12px;color:#61666d;margin-top:3px;word-break:break-all}
#uprog{margin-top:7px;font:11px/1.55 ui-monospace,Consolas,monospace;color:var(--mut);max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all}
/* AI 闲聊各用户次数:横向条形图(降序),单行紧凑式,宽屏三列;前 20 名常显,其余折叠 */
/* 溢出坑(2026-09-17 实测:720/768/1080px 都会被顶出卡片,1080 时页面被撑出 237px):CSS Grid 的
   **网格项默认 min-width:auto**,不许折行的长群名片会把列撑得比 1fr 还宽 → 整个网格溢出。
   三处都要写:① 列用 minmax(0,1fr);② 网格项 min-width:0;③ 行自身 min-width:0 + overflow:hidden。 */
.aicols{display:grid;gap:0 20px;grid-template-columns:1fr;min-width:0}
@media(min-width:720px){.aicols{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(min-width:1080px){.aicols{grid-template-columns:repeat(3,minmax(0,1fr))}}
.aicols>*{min-width:0}
.airow{display:flex;align-items:center;gap:7px;font-size:12px;line-height:1.75;min-width:0;overflow:hidden}
/* 排名:普通名次是灰数字,前三名是金银铜圆徽 */
.airank{flex:0 0 auto;width:16px;text-align:center;font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}
.airank.top{width:18px;height:18px;line-height:18px;border-radius:50%;color:#fff;font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.18)}
.airank.r1{background:linear-gradient(135deg,#ffd85e,#d9a11a)}
.airank.r2{background:linear-gradient(135deg,#d6dbe2,#9aa3ad)}
.airank.r3{background:linear-gradient(135deg,#eaa877,#b87333)}
.ainame{flex:0 1 auto;max-width:46%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#61666d}
.aibar{flex:1;min-width:16px;height:7px;background:var(--line);border-radius:4px;overflow:hidden}
.aibar>i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#fb7299,#ffa8c3);min-width:3px}
.aicnt{flex:0 0 auto;color:var(--mut);font-size:11px;font-variant-numeric:tabular-nums}
button.mini{min-height:28px;padding:4px 10px;font-size:12px;border-radius:7px}
/* 贴吧模式的按群开关弹窗(用户要求「叠加弹窗,平时不显示」):整屏蒙层 + 中间一张卡片 */
#tbmodal{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;padding:16px;z-index:40}
#tbmodal.show{display:flex}
#tbmodal .mbox{background:var(--card);border-radius:14px;padding:16px;width:100%;max-width:520px;max-height:82vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.2)}
#tbmodal h3{font-size:15px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
.tbrow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
.tbrow:last-child{border-bottom:0}
.tbrow .tk{flex:1;min-width:0}
.tbrow .tsub{font-size:11px;color:var(--mut)}
.tbrow.all{border-bottom:1px solid var(--line);margin-bottom:4px}
/* 接话概率:一条范围滑杆 + 旁边一个能直接填数字的框(两者同步) */
.tbprob{display:flex;align-items:center;gap:10px;padding:8px 0}
.tbprob input[type=range]{flex:1;min-width:90px;accent-color:var(--acc);height:24px;margin:0}
.tbprob input[type=number]{width:64px;font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:7px;text-align:center}
.tbprob .tbpc{font-size:12px;color:var(--mut);flex:0 0 auto}
/* 银河皇帝模式(2026-10-26):主页面只露一个按钮;弹窗里是分群开关 + 折叠的表情包库 */
#blmodal{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;padding:16px;z-index:40}
#blmodal.show{display:flex}
#blmodal .mbox{background:var(--card);border-radius:14px;padding:16px;width:100%;max-width:660px;max-height:86vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.2)}
#blmodal h3{font-size:15px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
.blrow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
.blrow:last-child{border-bottom:0}
.blrow .tk{flex:1;min-width:0}
.blrow .tsub{font-size:11px;color:var(--mut)}
.blrow.all{border-bottom:1px solid var(--line);margin-bottom:4px}
.blgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
.blitem{position:relative;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#fafafa}
.blitem img{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;background:#fff;cursor:zoom-in}
.blitem .bn{font-size:10px;color:var(--mut);padding:3px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.blitem .bx{position:absolute;top:3px;right:3px;width:20px;height:20px;line-height:18px;text-align:center;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:14px;cursor:pointer;border:0;padding:0;min-height:0}
.blitem .bx:hover{background:var(--bad)}
.blupload{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
</style></head><body>

<div id="login"><div class="box">
  <h1 style="font-size:16px;margin:0 0 4px">赛博史官 · 运维台</h1>
  <div class="mut">请输入访问令牌</div>
  <input id="tk" type="password" placeholder="令牌" autocomplete="current-password">
  <button class="pri" style="width:100%" onclick="doLogin()">登录</button>
  <div id="lerr" class="mut" style="color:var(--bad);margin-top:8px"></div>
</div></div>

<header><h1>赛博史官 · 运维台</h1>
  <span id="wsdot" class="dot"></span><span id="wstx" class="mut">连接中</span>
  <button onclick="logout()" style="min-height:30px;padding:4px 10px">退出</button>
</header>

<div class="wrap" id="app">
  <div class="card"><h2>功能开关</h2><div id="feats"></div>
    <div class="mut" style="margin-top:8px">切换即时生效,不重启 bot(走 tmux 面板按键)</div></div>

  <div class="card wide"><h2>游戏模式 <span class="mut" style="font-weight:400">(按群)</span></h2>
    <div id="modes"></div>
    <div class="mut" style="margin-top:8px;font-size:11px">决定该群「效果 / 卡图 / 每日一卡 / 卡组」按哪个游戏走(默认游戏王);群友发「mode 炉石」「mode 游戏王」也能改,与此处同步。</div></div>

  <div class="card"><h2>贴吧模式 <span class="mut" style="font-weight:400">(按群)</span></h2>
    <div id="tieba"></div>
    <div style="margin-top:10px"><button onclick="openTieba()">选择群…</button>
      <span class="mut" style="margin-left:8px" id="tiebanote"></span></div>
    <div class="mut" style="margin-top:8px;font-size:11px">开了之后<strong>不用 @ 也会接话</strong>(脏话全开、短句、可连发、不 @ 人),而且 <strong>@ 它也归它管</strong>:那个群的兜底闲聊会被同一套人格覆盖(不答疑、不帮忙、只骂人)。
      <br>⚠ 默认全部关闭:只对这里点开的群生效;群友发「贴吧模式 开 / 关」也能切。</div></div>

  <div class="card"><h2>人格面板 <span class="mut" style="font-weight:400">(按群)</span></h2>
    <div id="belial"></div>
    <div style="margin-top:10px"><button onclick="openBelial()">打开控制台…</button>
      <span class="mut" style="margin-left:8px" id="belialnote"></span></div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:6px">
      <span class="mut" style="font-size:11px">默认声线</span>
      <div id="blquickvoices" style="display:flex;gap:6px"></div>
    </div>
    <div class="mut" style="margin-top:8px;font-size:11px">群友 <strong>@我 说「银河皇帝」</strong>切「银河皇帝贝利亚」,说 <strong>「脚刷周模式」</strong>切「脚刷周」(JoshuaZhou 的音译;再发「银河皇帝 关 / 脚刷周 关」切回);
      每群二选一,只改被 @ 时的口吻,不碰游戏功能。点开控制台可按群切人格、<strong>查看/删除/上传两个人的表情包</strong>。</div></div>

  <div class="card"><h2>服务</h2><div id="svcs"></div></div>

  <div class="card"><h2>账号</h2><div id="acct"></div></div>

  <div class="card"><h2>卡库</h2><div id="cards"></div>
    <div style="margin-top:10px"><button class="pri" onclick="doUpdate()">更新卡库</button>
      <span class="mut" style="margin-left:8px">联网拉卡库,随后自动补缺失卡图</span></div>
    <div id="upbox"><div id="uphead"></div><div id="upmsg"></div><pre id="uprog"></pre></div></div>

  <div class="card"><h2>主机</h2><div id="host"></div></div>

  <div class="card wide"><h2>AI 闲聊 · 提示词档位 <span class="mut" style="font-weight:400" id="tonenote"></span></h2>
    <div id="tones"></div>
    <div class="mut" style="margin-top:8px;font-size:11px">决定机器人「能聊什么」:板正档守着原来的政治/色情红线,熟人群聊档(默认)把它们放开,放开档连引战也接。<strong>点了即时生效,不用重启</strong>(monitor 每次回复前现读档位文件)。</div></div>

  <div class="card"><h2>AI 闲聊 · 联网 <span class="mut" style="font-weight:400" id="netsnote"></span></h2>
    <div id="nets"></div>
    <div class="mut" style="margin-top:8px;font-size:11px">联网是本地工具调用:模型自己判断该不该搜,搜到的标题/摘要/链接连日期一起喂回去(事实性问题才搜,纯闲聊不搜)。<br>换源/开关:agent/.env 的 AI_CHAT_WEB_SEARCH、SEARCH_PROVIDER、SEARCH_COUNT(改完重启 monitor 生效)。</div></div>

  <div class="card wide"><h2>AI 闲聊 · 各用户次数 <span class="mut" style="font-weight:400" id="ainote"></span></h2>
    <div class="aicols" id="aichat"></div>
    <div class="aicols" id="aichat2" style="display:none"></div>
    <div id="aichatmore" style="margin-top:7px"></div>
    <div class="mut" style="margin-top:6px;font-size:11px">口径:按回复实际发给谁计;冷却跳过不计,失败另标。悬停看完整名字。</div></div>

  <div class="card wide"><h2>QQ 消息日志 <span class="mut" style="font-weight:400" id="snowfile"></span>
    <label class="mut" style="margin-left:auto;font-weight:400"><input type="checkbox" id="snowall"> 全部(含调试)</label></h2>
    <pre id="snowlog"></pre></div>

  <div class="card wide"><h2>日志 <span class="mut" style="font-weight:400">(monitor 面板最近 300 行)</span>
    <label class="mut" style="margin-left:auto;font-weight:400"><input type="checkbox" id="auto" checked> 自动刷新</label></h2>
    <pre id="log"></pre></div>
</div>

<div id="toast"></div>

<!-- 贴吧模式:按群开关做成**弹窗**(用户 2026-09-28 要求:平时不占版面,点按钮才出来) -->
<div id="tbmodal"><div class="mbox">
  <h3>贴吧模式 · 按群开关 <button class="mini" style="margin-left:auto" onclick="closeTieba()">关闭</button></h3>
  <div class="mut" id="tbhint"></div>
  <div class="tbprob">
    <span class="tbpc">接话概率</span>
    <input type="range" id="tbprob" min="0" max="1" step="0.05" value="0.7"
      oninput="tbProbInput(this.value)" onchange="tbProbSave(this.value)">
    <input type="number" id="tbprobn" min="0" max="1" step="0.05" value="0.7"
      onchange="tbProbSave(this.value)">
    <span class="tbpc" id="tbprobv">70%</span>
  </div>
  <div class="mut" style="font-size:11px;margin:-2px 0 6px">滑杆/填数字<strong>立即生效</strong>(0 = 完全不自动接话,1 = 每句都接);
    直接填 0~1 的小数也认。改的是「没人 @ 我时」的概率。</div>
  <div id="tbody"></div>
  <div class="mut" style="margin-top:10px;font-size:11px">开关是<strong>每群各记各的</strong>,点了立刻生效(monitor 每次用到时现读状态文件,不用重启)。
    概率/上下文/连发条数等口径在 agent/.env(TIEBA_PROB / TIEBA_CTX / TIEBA_MAX_REPLY …),改完要重启 monitor。</div>
</div></div>

<!-- 人格面板:主页面只露一个按钮,点开才显示分群开关 + 人格选择;表情包库默认折叠 -->
<div id="blmodal"><div class="mbox">
  <h3>人格面板 <button class="mini" style="margin-left:auto" onclick="closeBelial()">关闭</button></h3>
  <div class="mut" id="blhint"></div>
  <div class="tbprob">
    <label class="tbpc" style="display:flex;align-items:center;gap:4px;white-space:nowrap">
      <input type="checkbox" id="blauto" checked onchange="blAutoSave(this.checked)"> 自动
    </label>
    <span class="tbpc">非@接话概率</span>
    <input type="range" id="blprob" min="0" max="1" step="0.05" value="0.4" disabled
      oninput="blProbInput(this.value)" onchange="blProbSave(this.value)">
    <input type="number" id="blprobn" min="0" max="1" step="0.05" value="0.4" disabled
      onchange="blProbSave(this.value)">
    <span class="tbpc" id="blprobv">自动</span>
  </div>
  <div class="tbprob">
    <span class="tbpc">自动上限</span>
    <input type="number" id="blautohi" min="0" max="100" step="1" value="35"
      onchange="blAutoLimitsSave()"> <span class="tbpc">%</span>
    <span class="tbpc">自动下限</span>
    <input type="number" id="blautolo" min="0" max="100" step="1" value="5"
      onchange="blAutoLimitsSave()"> <span class="tbpc">%</span>
    <button class="mini" onclick="blAutoLimitsSave()">保存</button>
  </div>
  <div class="mut" style="font-size:11px;margin:-2px 0 8px">自动模式默认开启:按本群最近 5 分钟消息频次平滑调整,
    低频约 <strong>35%</strong>、高频约 <strong>5%</strong>;关掉「自动」才用滑杆固定值(0 = 完全不自动接话,1 = 每句都接)。
    上面两个百分比就是 auto 的<strong>低频上限 / 高频下限</strong>,可改。</div>
  <div id="blbody"></div>
  <div class="mut" style="margin-top:8px;font-size:11px">切人格会同时改机器人在本群的<strong>群名片</strong>:贝利亚 →「贝利亚大王」,脚刷周 →「脚刷周」;关掉人格时恢复切换前的名片(第一次切之前自动记下)。</div>
  <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:10px">
    <div style="display:flex;align-items:center;gap:8px">
      <strong style="font-size:13px">默认声线</strong>
      <span class="mut" id="blvoicenote"></span>
      <div id="blvoices" style="margin-left:auto;display:flex;gap:6px"></div>
    </div>
    <div class="mut" style="margin-top:6px;font-size:11px">切换后模型调用 <code>send_voice</code> 时默认用这个声线;monitor 每次合成前现读,点一下即时生效。</div>
  </div>
  <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:10px">
    <div style="display:flex;align-items:center;gap:8px">
      <strong style="font-size:13px">记忆库</strong>
      <span class="mut" id="blmemnote"></span>
    </div>
    <div class="mut" style="margin-top:6px;font-size:11px">模型在群聊里用 <code>add_memory</code> / <code>delete_memory</code> 自己增删;这里也能补/删。内置记忆只读。</div>
    <div id="blmemlist" style="margin-top:8px"></div>
    <div class="blupload" style="margin-top:8px">
      <input id="blmemtext" placeholder="加一条记忆…" maxlength="160" style="flex:1;min-width:140px;font:inherit;padding:5px 7px;border:1px solid var(--line);border-radius:7px">
      <select id="blmemkind" style="font:inherit;padding:5px 7px;border:1px solid var(--line);border-radius:7px">
        <option value="fact">事实</option><option value="style">风格</option>
      </select>
      <button class="mini pri" onclick="addMemory()">添加</button>
      <span class="mut" id="blmemaddnote"></span>
    </div>
  </div>
  <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:10px">
    <div style="display:flex;align-items:center;gap:8px">
      <strong style="font-size:13px">表情包库</strong>
      <span class="mut" id="blstickernote"></span>
      <button class="mini" style="margin-left:auto" id="blstickerbtn" onclick="toggleStickers()">展开</button>
    </div>
    <div id="blpersontabs" style="display:flex;gap:6px;margin-top:8px"></div>
    <div id="blstickerbox" style="display:none;margin-top:10px">
      <div class="blupload">
        <button class="mini pri" onclick="document.getElementById('blfile').click()">上传表情包</button>
        <button class="mini" onclick="autonameStickers()">AI 命名未命名</button>
        <input type="file" id="blfile" accept="image/png,image/jpeg,image/gif,image/webp" multiple style="display:none"
          onchange="uploadStickers(this.files);this.value=''">
        <span class="mut" id="bluploadnote"></span>
      </div>
      <div class="blgrid" id="blgrid"></div>
    </div>
  </div>
  <div class="mut" style="margin-top:10px;font-size:11px">开关/人格是<strong>每群各记各的</strong>,点了立刻生效(monitor 每次回复前现读状态文件,不用重启)。<br>
    群里的等价指令:@我 说「银河皇帝」或「脚刷周模式」召唤,说「银河皇帝 关」/「脚刷周 关」收起;这个模式不在 /help 里。</div>
</div></div>

<script>
function h(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.className='show';clearTimeout(t._h);t._h=setTimeout(function(){t.className=''},3600)}
function doLogin(){
  var v=document.getElementById('tk').value;
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:v})})
   .then(function(r){if(!r.ok)throw new Error('令牌不对');document.getElementById('login').style.display='none';boot()})
   .catch(function(e){document.getElementById('lerr').textContent=e.message})
}
function logout(){fetch('/api/logout',{method:'POST'}).then(function(){location.reload()})}
function bar(used,total){var p=total?Math.round(used/total*100):0;return '<div class="bar"><i style="width:'+p+'%"></i></div>'}
function act(path,body,confirmMsg){
  if(confirmMsg&&!confirm(confirmMsg))return;
  var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++)bs[i].disabled=true;
  fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})
   .then(function(r){return r.json()})
   .then(function(j){toast(j.message||(j.ok?'已执行':'失败'));return tick()})
   .catch(function(e){toast('请求失败:'+e.message)})
   .finally(function(){for(var i=0;i<bs.length;i++)bs[i].disabled=false})
}
function toggle(key,cur){act('feature',{key:key,value:!cur})}
// 贴吧模式(2026-09-28):分群开关做成弹窗 —— 平时只显示「开了几个群」,点按钮才列出所有群。
// 状态来自 /api/status 的 tieba(读的就是 monitor 正在用的那份 state.json),所以显示与生效永远一致。
var tbData={groups:[],all:false,opened:0};
function openTieba(){syncProbInputs(tbData);renderTieba(true);document.getElementById('tbmodal').className='show'}
function closeTieba(){document.getElementById('tbmodal').className=''}
function setTieba(groupId,on){act('tieba',{groupId:groupId,on:on})}
// 接话概率:滑杆与数字框同步。oninput 只改显示(边拉边跳数字),onchange(松手/失焦)才发请求,
// 免得拖一次滑杆打十几个请求把 state.json 反复重写。后端写的就是 monitor 每次接话现读的那个文件。
function tbProbInput(v){document.getElementById('tbprobv').textContent=Math.round(Number(v)*100)+'%'}
function tbProbSave(v){
  var n=Number(v);
  if(!isFinite(n))return;
  n=Math.min(1,Math.max(0,n));
  tbProbInput(n);
  document.getElementById('tbprob').value=n;
  document.getElementById('tbprobn').value=n;
  act('tieba',{prob:n});
}
function syncProbInputs(t){
  if(!t||t.prob===undefined)return;
  var s=document.getElementById('tbprob'),n2=document.getElementById('tbprobn');
  if(s)s.value=t.prob;
  if(n2)n2.value=t.prob;
  tbProbInput(t.prob);
}
function tbRow(r){
  return '<div class="tbrow"><span class="tk" title="'+h(r.groupId)+'">'+h(r.name||('群 '+r.groupId))+
    '<div class="tsub">'+h(r.groupId)+(r.tieba?' · 已开启':'')+'</div></span>'+
    '<div class="sw'+(r.tieba?' on':'')+'" onclick="setTieba(\\''+r.groupId+'\\','+(r.tieba?'false':'true')+')"><i></i></div></div>';
}
function renderTieba(force){
  var t=tbData;
  document.getElementById('tiebanote').textContent = t.opened? ('已开 '+t.opened+' 个群') : '当前:全部关闭';
  var box=document.getElementById('tbody');
  if(!box||(!force&&document.getElementById('tbmodal').className!=='show'))return;
  document.getElementById('tbhint').textContent='共 '+t.groups.length+' 个群;接话概率 '+
    Math.round((t.prob||0)*100)+'%,上下文 '+(t.ctx||0)+' 条,最多连发 '+(t.maxReply||0)+' 条(每条 ≤'+(t.maxChars||0)+' 字)';
  // 概率框跟着后端当前值走(别人/另一个标签页改过也能对上)
  if(document.activeElement!==document.getElementById('tbprob')&&document.activeElement!==document.getElementById('tbprobn'))syncProbInputs(t);
  box.innerHTML='<div class="tbrow all"><span class="tk">全部群<div class="tsub">一次把下面所有群都打开/关掉</div></span>'+
    '<div class="sw'+(t.all?' on':'')+'" onclick="setTieba(\\'*\\','+(t.all?'false':'true')+')"><i></i></div></div>'+
    (t.groups.length?t.groups.map(tbRow).join(''):'<div class="mut">读不到群列表(OneBot 可能没起来)</div>');
}
// 人格面板(2026-10-29:银河皇帝 + 脚刷周):主页面只露一个「打开控制台…」按钮;
// 弹窗里是分群开关 + 每群人格选择 + 折叠的表情包库(两个人格各一个库)。
// 状态来自 /api/status 的 belial(读的就是 monitor 正在用的 state.json),所以显示与生效永远一致。
var blData={groups:[],all:false,opened:0,stickers:[],stickersJsz:[],personas:{},personaOptions:[],memories:{belial:[],jiaoshuazhou:[]},memoryStats:{belial:{dynamic:0,total:0,max:120},jiaoshuazhou:{dynamic:0,total:0,max:120}},voiceMode:'belial',voiceOptions:[],nonAtProb:0.4,nonAtAuto:true,autoMaxProb:0.35,autoMinProb:0.05}, blOpen=false, blStickersOpen=false, blStickerSig='', blStickerPersona='belial';
function openBelial(){blOpen=true;syncBlProb(blData);renderBelial(true);document.getElementById('blmodal').className='show'}
function closeBelial(){blOpen=false;document.getElementById('blmodal').className=''}
function setBelial(groupId,on){act('belial',{groupId:groupId,on:on})}
function setPersona(groupId,persona){act('belial',{groupId:groupId,persona:persona})}
function personaName(id){var o=(blData.personaOptions||[]).find(function(x){return x.id===id});return o?o.short:(id==='jiaoshuazhou'?'脚刷周':'贝利亚')}
function blProbInput(v){document.getElementById('blprobv').textContent=Math.round(Number(v)*100)+'%'}
function blProbSave(v){
  var a=document.getElementById('blauto');
  if(a&&a.checked)return;                              // 自动模式下滑杆不生效
  var n=Number(v);
  if(!isFinite(n))return;
  n=Math.min(1,Math.max(0,n));
  blProbInput(n);
  document.getElementById('blprob').value=n;
  document.getElementById('blprobn').value=n;
  act('belial',{prob:n});
}
function blAutoSave(on){
  var auto=!!on;
  var a=document.getElementById('blauto'),s=document.getElementById('blprob'),n2=document.getElementById('blprobn');
  if(a)a.checked=auto;
  if(s)s.disabled=auto;
  if(n2)n2.disabled=auto;
  document.getElementById('blprobv').textContent=auto?'自动':Math.round(Number(document.getElementById('blprobn').value||0.4)*100)+'%';
  act('belial',{auto:auto});
}
function syncBlProb(b){
  if(!b)return;
  var auto=b.nonAtAuto!==false;
  var a=document.getElementById('blauto'),s=document.getElementById('blprob'),n2=document.getElementById('blprobn');
  if(a)a.checked=auto;
  if(s){s.disabled=auto;s.value=(b.nonAtProb===undefined?0.4:b.nonAtProb);}
  if(n2){n2.disabled=auto;n2.value=(b.nonAtProb===undefined?0.4:b.nonAtProb);}
  var hi=document.getElementById('blautohi'),lo=document.getElementById('blautolo');
  if(hi)hi.value=Math.round((b.autoMaxProb===undefined?0.35:b.autoMaxProb)*100);
  if(lo)lo.value=Math.round((b.autoMinProb===undefined?0.05:b.autoMinProb)*100);
  if(auto)document.getElementById('blprobv').textContent='自动';
  else blProbInput(b.nonAtProb===undefined?0.4:b.nonAtProb);
}
function blAutoLimitsSave(){
  var hiEl=document.getElementById('blautohi'),loEl=document.getElementById('blautolo');
  var hi=Number(hiEl.value),lo=Number(loEl.value);
  if(!isFinite(hi)||!isFinite(lo)||hi<0||hi>100||lo<0||lo>100){toast('上下限要填 0~100 的百分比');return;}
  if(hi<lo){toast('自动上限不能小于下限');return;}
  act('belial',{autoMax:hi/100,autoMin:lo/100});
}
function setBelialVoice(v){
  fetch('/api/belial/voice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:v})})
   .then(function(r){return r.json()})
   .then(function(j){toast(j.message||(j.ok?'已切换':'切换失败'));return tick()})
   .catch(function(e){toast('切换失败:'+e.message)});
}
function blVoiceName(v){return v==='klee'?'可莉':v==='laomushi'?'老牧师':v==='young'?'年轻男声':'贝利亚'}
function renderVoiceSwitch(){
  var b=blData||{},cur=b.voiceMode||'belial';
  var opts=(b.voiceOptions&&b.voiceOptions.length)?b.voiceOptions:[
    {id:'belial',label:'贝利亚'},{id:'klee',label:'可莉'},{id:'laomushi',label:'老牧师'}
  ];
  var html=opts.map(function(v){
    var tip=v.provider==='mimo'?'MiMo 克隆':'Edge 回退';
    return '<button class="mini'+(cur===v.id?' pri':'')+'" title="'+h(tip)+'" onclick="setBelialVoice(\\''+v.id+'\\')">'+h(v.label)+'</button>';
  }).join('');
  ['blvoices','blquickvoices'].forEach(function(id){
    var box=document.getElementById(id);
    if(box)box.innerHTML=html;
  });
  var note=document.getElementById('blvoicenote');
  if(note)note.textContent='当前:'+blVoiceName(cur);
}
function blRow(r){
  var cur=r.persona||'belial';
  var open=!!r.belial;
  var pbtn=function(id,label){
    return '<button class="mini'+(cur===id?' pri':'')+'" style="min-height:24px;padding:1px 8px;font-size:11px" onclick="setPersona(\\''+r.groupId+'\\',\\''+id+'\\')">'+label+'</button>';
  };
  return '<div class="blrow"><span class="tk" title="'+h(r.groupId)+'">'+h(r.name||('群 '+r.groupId))+
    '<div class="tsub">'+h(r.groupId)+' · '+(open?('当前:'+personaName(cur)):'关闭(点人格即开启)')+'</div></span>'+
    '<span style="display:flex;gap:4px;align-items:center">'+pbtn('belial','贝利亚')+pbtn('jiaoshuazhou','脚刷周')+'</span>'+
    '<div class="sw'+(open?' on':'')+'" onclick="setBelial(\\''+r.groupId+'\\','+(open?'false':'true')+')"><i></i></div></div>';
}
function renderBelial(force){
  var b=blData||{groups:[]};
  var probText=b.nonAtAuto!==false?'自动':(Math.round((b.nonAtProb ?? 0.4)*100)+'%');
  var anyOn=!!(b.all||b.opened);
  var onText=b.all?'全部群开启':(b.opened?('已开 '+b.opened+' 个群'):'全部关闭');
  var note=document.getElementById('belialnote');
  if(note)note.textContent='';
  var sum=document.getElementById('belial');
  if(sum){
    var belN=b.belialCount||0, jszN=b.jszCount||0;
    sum.innerHTML='<div class="row"><span class="dot '+(anyOn?'ok':'')+'"></span><span class="k">'+onText+
      '<div class="sub">贝利亚 '+belN+' · 脚刷周 '+jszN+' · 表情包 '+((b.stickers||[]).length)+'+'+((b.stickersJsz||[]).length)+' 张 · 非@ '+probText+'</div></span></div>';
  }
  renderVoiceSwitch();
  if(!force&&!blOpen)return;
  // 概率框跟着后端当前值走(另一个标签页/群里改过也能对上)
  if(document.activeElement!==document.getElementById('blprob')
    &&document.activeElement!==document.getElementById('blprobn')
    &&document.activeElement!==document.getElementById('blautohi')
    &&document.activeElement!==document.getElementById('blautolo'))syncBlProb(b);
  var hint=document.getElementById('blhint');
  if(hint){
    var warn='';
    if(b.aiOn===false)warn=' ⚠ AI 闲聊总开关关着,开了也不会回';
    else if(b.hasKey===false)warn=' ⚠ 没配聊天 key,开了也不会回';
    hint.textContent='共 '+((b.groups||[]).length)+' 个群;已开 '+((b.opened)||0)+'(贝利亚 '+(b.belialCount||0)+' / 脚刷周 '+(b.jszCount||0)+
      ');表情包 '+((b.stickers||[]).length)+'+'+((b.stickersJsz||[]).length)+' 张;非@ '+probText+
      ';群里 @我 说「银河皇帝」或「脚刷周模式」切人格,说「银河皇帝 关 / 脚刷周 关」收起'+warn;
  }
  var box=document.getElementById('blbody');
  if(!box)return;
  box.innerHTML='<div class="blrow all"><span class="tk">全部群<div class="tsub">一次把下面所有群都打开/关掉(不改每群选的人格)</div></span>'+
    '<div class="sw'+(b.all?' on':'')+'" onclick="setBelial(\\'*\\','+(b.all?'false':'true')+')"><i></i></div></div>'+
    ((b.groups&&b.groups.length)?b.groups.map(blRow).join(''):'<div class="mut">读不到群列表(OneBot 可能没起来)</div>');
  renderPersonaTabs();
  renderMemories();
  renderStickers();
}
function fmtBytes(n){n=Number(n)||0;return n>=1048576?((n/1048576).toFixed(1)+'MB'):(Math.max(1,Math.round(n/1024))+'KB')}
function toggleStickers(){blStickersOpen=!blStickersOpen;renderStickers()}
function setStickerPersona(id){blStickerPersona=id;blStickerSig='';renderPersonaTabs();renderStickers();renderMemories()}
function memPersona(){var ids=(blData.personaOptions||[]).map(function(o){return o.id});return ids.indexOf(blStickerPersona)>=0?blStickerPersona:'belial'}
function renderMemories(){
  var box=document.getElementById('blmemlist');
  if(!box)return;
  var p=memPersona();
  var list=(blData.memories&&blData.memories[p])||[];
  var st=(blData.memoryStats&&blData.memoryStats[p])||{dynamic:0,total:list.length,max:120};
  var note=document.getElementById('blmemnote');
  if(note)note.textContent='('+personaName(p)+' · 动态 '+st.dynamic+' / 共 '+st.total+' · 上限 '+st.max+')';
  box.innerHTML=list.length?list.map(function(m){
    return '<div class="blrow"><span class="tk" style="font-size:12px;word-break:break-all">'+h(m.text)+
      '<div class="tsub">'+h(m.id)+' · '+(m.kind==='style'?'风格':'事实')+(m.seed?' · 内置只读':'')+'</div></span>'+
      (m.seed?'':'<button class="mini" title="修改这条记忆" onclick="editMemory(\\''+encodeURIComponent(m.id)+'\\',\\''+encodeURIComponent(m.text)+'\\')">改</button>'+
        '<button class="mini" title="删除这条记忆" onclick="delMemory(\\''+encodeURIComponent(m.id)+'\\')">×</button>')+'</div>';
  }).join(''):'<div class="mut" style="font-size:12px">还没有记忆。群里让 bot「记住…」,或下面手动加一条。</div>';
}
function addMemory(){
  var t=document.getElementById('blmemtext');
  var text=t?String(t.value||'').trim():'';
  if(!text){toast('先写点内容');return}
  var kind=(document.getElementById('blmemkind')||{}).value||'fact';
  var note=document.getElementById('blmemaddnote');
  if(note)note.textContent='保存中…';
  fetch('/api/persona/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({persona:memPersona(),action:'add',text:text,kind:kind})})
   .then(function(r){return r.json()})
   .then(function(j){if(j.ok&&t)t.value='';if(note)note.textContent='';toast(j.message||(j.ok?'已添加':'添加失败'));return tick()})
   .catch(function(e){if(note)note.textContent='';toast('添加失败:'+e.message)});
}
function delMemory(id){
  var mid=decodeURIComponent(id||'');
  if(!confirm('删除记忆 '+mid+' ?'))return;
  fetch('/api/persona/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({persona:memPersona(),action:'delete',id:mid})})
   .then(function(r){return r.json()})
   .then(function(j){toast(j.message||(j.ok?'已删除':'删除失败'));return tick()})
   .catch(function(e){toast('删除失败:'+e.message)});
}
function editMemory(id,oldText){
  var mid=decodeURIComponent(id||'');
  var cur=decodeURIComponent(oldText||'');
  var next=prompt('修改这条记忆(留空取消):',cur);
  if(next===null)return;
  next=String(next).trim();
  if(!next||next===cur)return;
  fetch('/api/persona/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({persona:memPersona(),action:'edit',id:mid,text:next})})
   .then(function(r){return r.json()})
   .then(function(j){toast(j.message||(j.ok?'已改好':'修改失败'));return tick()})
   .catch(function(e){toast('修改失败:'+e.message)});
}
function renderPersonaTabs(){
  var box=document.getElementById('blpersontabs');
  if(!box)return;
  var opts=(blData.personaOptions&&blData.personaOptions.length)?blData.personaOptions:[
    {id:'belial',short:'贝利亚',count:(blData.stickers||[]).length},
    {id:'jiaoshuazhou',short:'脚刷周',count:(blData.stickersJsz||[]).length}
  ];
  box.innerHTML=opts.map(function(o){
    return '<button class="mini'+(blStickerPersona===o.id?' pri':'')+'" onclick="setStickerPersona(\\''+o.id+'\\')">'+h(o.short)+
      ' <span class="mut">'+((o.count!=null)?o.count:'')+'</span></button>';
  }).join('')+'<span class="mut" style="font-size:11px;align-self:center">← 切人格看各自的图</span>';
}
function renderStickers(){
  var b=blData||{};
  var isJsz=blStickerPersona==='jiaoshuazhou';
  var list=isJsz?(b.stickersJsz||[]):(b.stickers||[]);
  var who=isJsz?'脚刷周':'贝利亚';
  var note=document.getElementById('blstickernote');
  if(note)note.textContent='('+who+' · '+list.length+' 张)';
  var btn=document.getElementById('blstickerbtn');
  if(btn)btn.textContent=blStickersOpen?'收起':'展开';
  var box=document.getElementById('blstickerbox');
  if(!box)return;
  box.style.display=blStickersOpen?'':'none';
  var up=document.getElementById('bluploadnote');
  var max=isJsz?(b.maxStickerBytesJsz||5242880):(b.maxStickerBytes||5242880);
  if(up)up.textContent='单张 ≤ '+fmtBytes(max)+',支持 jpg / png / gif / webp';
  var grid=document.getElementById('blgrid');
  if(!grid)return;
  var sig=blStickerPersona+'|'+list.map(function(s){return s.name+':'+s.size+':'+Math.round(s.mtime||0)+':'+(s.desc||'')+':'+(s.label||'')}).join('|');
  if(sig===blStickerSig&&grid.getAttribute('data-sig')===sig)return;
  blStickerSig=sig;grid.setAttribute('data-sig',sig);
  grid.innerHTML=list.length?list.map(function(s){
    // 带 mtime 做 cache-buster:表情包被替换/缩放后,浏览器不会还拿旧图
    var url='/api/belial/sticker?persona='+encodeURIComponent(blStickerPersona)+'&name='+encodeURIComponent(s.name)+'&v='+Math.round(s.mtime||0);
    var tip=s.name+' · '+fmtBytes(s.size)+(s.desc?(' · '+s.desc):'')+(s.tags&&s.tags.length?(' ['+s.tags.join('/')+']'):'');
    return '<div class="blitem"><img src="'+url+'" loading="lazy" title="'+h(tip)+
      '" onclick="window.open(this.src,\\'_blank\\')">'+
      '<div class="bn" title="'+h(tip)+'">'+h(s.label || s.desc || s.name)+'</div>'+
      '<button class="bx" title="删除" onclick="delSticker(\\''+encodeURIComponent(s.name)+'\\')">×</button></div>';
  }).join(''):'<div class="mut">'+who+'还没有表情包。点「上传表情包」加几张(建议正方形、边长 300~800px)。</div>';
}
function delSticker(name){
  var n=decodeURIComponent(name||'');
  if(!confirm('从「'+personaName(blStickerPersona)+'」表情包库删除「'+n+'」?'))return;
  fetch('/api/belial/stickers/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,persona:blStickerPersona})})
   .then(function(r){return r.json()}).then(function(j){toast(j.message||(j.ok?'已删除':'删除失败'));return tick()})
   .catch(function(e){toast('删除失败:'+e.message)});
}
function autonameStickers(){
  var note=document.getElementById('bluploadnote');
  if(note)note.textContent='AI 正在识别「'+personaName(blStickerPersona)+'」未命名的表情包…';
  fetch('/api/belial/stickers/autoname',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:5,persona:blStickerPersona})})
   .then(function(r){return r.json()})
   .then(function(j){toast(j.message||(j.ok?'AI 命名完成':'AI 命名失败'));return tick()})
   .catch(function(e){toast('AI 命名失败:'+e.message)});
}
function uploadStickers(files){
  var arr=Array.prototype.slice.call(files||[]);
  if(!arr.length)return;
  var i=0,okN=0,failN=0,isJsz=blStickerPersona==='jiaoshuazhou',max=isJsz?((blData&&blData.maxStickerBytesJsz)||5*1024*1024):((blData&&blData.maxStickerBytes)||5*1024*1024);
  var note=document.getElementById('bluploadnote');
  function next(){
    if(i>=arr.length){
      if(note)note.textContent='上传完成:成功 '+okN+' 张'+(failN?('，失败 '+failN+' 张'):'');
      tick();return;
    }
    var f=arr[i++];
    if(f.type&&!/^image\\//.test(f.type)){failN++;toast(f.name+' 不是图片');return next()}
    if(f.size>max){failN++;toast(f.name+' 超过 '+fmtBytes(max));return next()}
    if(note)note.textContent='正在上传 '+i+'/'+arr.length+' ...';
    var fr=new FileReader();
    fr.onload=function(){
      var b64=String(fr.result||'').split(',')[1]||'';
      fetch('/api/belial/stickers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.name,data:b64,persona:blStickerPersona})})
       .then(function(r){return r.json()})
       .then(function(j){if(j.ok){okN++;if(note)note.textContent='已上传「'+j.name+'」'}else{failN++;toast(j.message||'上传失败')}})
       .catch(function(e){failN++;toast('上传失败:'+e.message)})
       .then(next);
    };
    fr.onerror=function(){failN++;toast(f.name+' 读取失败');next()};
    fr.readAsDataURL(f);
  }
  next();
}
// 分群游戏模式:每群两个小按钮(游戏王/炉石),当前那个高亮;点了就走 /api/mode 直接写 modes.json。
// 不用开关样式的原因:这是「二选一」而不是开关,而且要一眼看出这群现在按哪个游戏走。
function setMode(groupId,mode){act('mode',{groupId:groupId,mode:mode})}
function modesHtml(list){
  if(!list||!list.length)return '<div class="mut">读不到群列表(OneBot 可能没起来)</div>';
  return list.map(function(g){
    var cur=g.mode||'ygo';
    var b=function(v,label){return '<button class="'+(cur===v?'pri':'')+'" style="min-height:26px;padding:2px 10px;font-size:12px" onclick="setMode(\\''+g.groupId+'\\',\\''+v+'\\')">'+label+'</button>'};
    return '<div class="row"><span class="k" title="'+h(g.groupId)+'">'+h(g.name||('群 '+g.groupId))+
      '<div class="sub">'+h(g.groupId)+'</div></span><span style="display:flex;gap:6px">'+b('ygo','游戏王')+b('hs','炉石')+'</span></div>';
  }).join('')
}
// SnowLuma 侧日志:谁在哪个群说了什么、bot 发了什么。默认只筛消息相关行,勾「全部」看原始 DEBUG。
function snowlog(){
  var all=document.getElementById('snowall').checked?'all':'event';
  fetch('/api/snowluma-log?n=200&mode='+all).then(function(r){return r.json()}).then(function(j){
    var el=document.getElementById('snowlog');
    var stick=el.scrollTop+el.clientHeight>=el.scrollHeight-40;
    document.getElementById('snowfile').textContent=j.file||'';
    el.innerHTML=(j.lines||[]).map(function(l){
      var m=l.match(/^(\d\d:\d\d:\d\d)\s+\S*\s*(.*)$/);
      var cls=/\[OneBot\].*(发送|群聊)/.test(l)?' class="snd"':'';
      return m?('<span class="t">'+h(m[1])+'</span> <span'+cls+'>'+h(m[2])+'</span>'):h(l);
    }).join('\\n');
    if(stick)el.scrollTop=el.scrollHeight;
  }).catch(function(){});
}
function tick(){
  return fetch('/api/status').then(function(r){if(r.status===401){document.getElementById('login').style.display='flex';throw new Error('未登录')}return r.json()}).then(function(s){
    var d=document.getElementById('wsdot');
    d.className='dot '+(s.ws.state==='up'?'ok':s.ws.state==='down'?'bad':'warn');
    document.getElementById('wstx').textContent=(s.ws.state==='up'?'已连接':s.ws.state==='down'?'断开':'状态未知');

    document.getElementById('feats').innerHTML=
      frow('搬屎','随机一搬 / 精选一搬',s.features.shitpost,'shitpost')+
      frow('框神语录','回复 + 实时采集 + 回填',s.features.kuangshen,'kuangshen')+
      frow('AI 闲聊','${AI_CHAT_DESC}',s.features.ai,'ai');

    document.getElementById('modes').innerHTML=modesHtml(s.modes);

    tbData=s.tieba||{groups:[],all:false,opened:0};
    renderTieba(false);

    blData=s.belial||{groups:[],all:false,opened:0,stickers:[]};
    renderBelial(false);

    renderTones(s.tone);
    renderNets(s.search);

    document.getElementById('svcs').innerHTML=s.services.map(function(v){
      return '<div class="row"><span class="dot '+(v.active?'ok':'bad')+'"></span><span class="k">'+h(v.label)+
        '<div class="sub">'+h(v.unit)+'.service · '+(v.active?'运行中':'已停止')+(v.enabled?' · 开机自启':' · 未设自启')+'</div></span>'+
        '<button onclick="act(\\'service\\',{unit:\\''+v.unit+'\\',action:\\'restart\\'},\\'重启 '+h(v.label)+'?会短暂中断它的功能。\\')">重启</button></div>'
    }).join('');

    document.getElementById('acct').innerHTML = s.account
      ? '<div class="row"><span class="k">'+h(s.account.nickname)+'<div class="sub">QQ '+h(s.account.uin)+'</div></span><span class="dot ok"></span></div>'+
        '<div class="row"><span class="k mut">OneBot<div class="sub">WS '+(s.onebot.ws?'在听':'未监听')+' · HTTP '+(s.onebot.http?'在听':'未监听')+'</div></span></div>'
      : '<div class="mut">读不到账号(OneBot 可能没起来)</div>';

    var c=s.cards;
    document.getElementById('cards').innerHTML=
      '<div class="row"><span class="k">卡牌数<div class="sub">cards.json</div></span><b>'+c.count+'</b></div>'+
      '<div class="row"><span class="k">卡图数<div class="sub">cards_img/</div></span><b>'+c.images+'</b></div>'+
      '<div class="row"><span class="k mut">卡库更新时间<div class="sub">'+(c.mtime?h(c.mtime.replace('T',' ').slice(0,19)):'未知')+'</div></span></div>';

    var H=s.host, memUsed=H.memTotal-H.memAvail;
    document.getElementById('host').innerHTML=
      '<div class="row"><span class="k">内存<div class="sub">已用 '+Math.round(memUsed/1024)+'MB / 共 '+Math.round(H.memTotal/1024)+'MB</div></span></div>'+bar(memUsed,H.memTotal)+
      '<div class="row" style="border-top:1px solid var(--line)"><span class="k">磁盘<div class="sub">已用 '+Math.round(H.disk.usedKb/1048576)+'G / 共 '+Math.round(H.disk.totalKb/1048576)+'G</div></span></div>'+bar(H.disk.usedKb,H.disk.totalKb)+
      '<div class="row" style="border-top:1px solid var(--line)"><span class="k">负载<div class="sub">1/5/15 分钟</div></span><b>'+h(H.load)+'</b></div>'+
      '<div class="row"><span class="k">已运行<div class="sub">服务器开机时长</div></span><b>'+h(H.uptimeText)+'</b></div>'+
      '<div class="row"><span class="k mut">最近请求<div class="sub">'+h(s.lastRequest||'暂无')+'</div></span></div>';
    aichatChart(s.aiChat);
    return s;
  }).catch(function(){});
}
function frow(name,desc,on,key){
  return '<div class="row"><span class="k">'+name+'<div class="sub">'+desc+'</div></span>'+
    '<div class="sw'+(on?' on':'')+'" onclick="toggle(\\''+key+'\\','+(!!on)+')"><i></i></div></div>';
}
// 提示词档位(2026-09-21):三个档画成一排按钮,当前档高亮。与游戏模式那排同一个交互思路。
// 走 /api/tone 直接写 monitor 的 tone.json —— 不需要敲 tmux 按键(monitor 每次回复前现读文件)。
function setTone(id){act('tone',{tone:id})}
function renderTones(t){
  var box=document.getElementById('tones'),note=document.getElementById('tonenote');
  if(!box||!t)return;
  var opts=t.options||[],cur=t.current;
  var cur0=null;
  for(var i=0;i<opts.length;i++){if(opts[i].id===cur)cur0=opts[i]}
  note.textContent='当前:'+(cur0?cur0.cn:cur)+(t.updatedAt?(' · 改于 '+fmtTime(t.updatedAt)):'');
  box.innerHTML=opts.map(function(o){
    return '<div class="row"><span class="k">'+h(o.cn)+
      '<div class="sub">'+h(o.long||o.short||'')+'</div></span>'+
      '<button class="'+(o.id===cur?'pri':'')+'" style="flex:0 0 auto;min-height:28px;padding:4px 14px;font-size:12px" '+
      'onclick="setTone(\\''+o.id+'\\')">'+(o.id===cur?'使用中':'切到这档')+'</button></div>';
  }).join('');
}
// 联网状态:开着就报搜索源 + 当天/累计次数,关了就直说关着(免得群友问「你不是能联网吗」时没人知道)
function renderNets(s){
  var box=document.getElementById('nets'),note=document.getElementById('netsnote');
  if(!box||!s)return;
  if(!s.enabled){note.textContent='已关闭';box.innerHTML='<div class="mut">AI_CHAT_WEB_SEARCH=0 —— 机器人不会联网,事实性问题只能凭记忆答(容易过时)。</div>';return}
  var today=s.today?('今天 '+(s.today.ok||0)+' 次'+(s.today.failed?('/ 失败 '+s.today.failed):'')):'今天还没搜过';
  note.textContent='已开启';
  box.innerHTML='<div class="row"><span class="k">搜索源<div class="sub">'+h(s.provider||'?')+'</div></span><b>'+h(s.provider||'?')+'</b></div>'+
    '<div class="row"><span class="k">搜索次数<div class="sub">'+h(today)+' · 累计成功 '+(s.ok||0)+' / 失败 '+(s.failed||0)+'</div></span><b>'+(s.total||0)+'</b></div>';
}
function fmtTime(ts){
  var d=new Date(ts),p=function(n){return (n<10?'0':'')+n};
  return (d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
// AI 闲聊各用户次数:横向条形图,次数降序。单行紧凑式;前 20 名常显、其余折叠;前三名金银铜徽章。
// 折叠状态存在 aiExpanded 里 —— tick() 每 5 秒重渲染,不存就会被自动展开。
var aiExpanded=false, aiLast=null;
var AI_TOP_N=20;
function aichatToggle(){aiExpanded=!aiExpanded;aichatChart();}
function aiRowHtml(r,i,max){
  var w=Math.max(3,Math.round(r.count/max*100));
  var label=r.name+'（'+r.qq+'）';
  var cls='airank'+(i<3?(' top r'+(i+1)):'');       // 第 1/2/3 名:金/银/铜圆徽
  return '<div class="airow"><span class="'+cls+'">'+(i+1)+'</span>'+
    '<span class="ainame" title="'+h(label)+'">'+h(label)+'</span>'+
    '<span class="aibar"><i style="width:'+w+'%"></i></span>'+
    '<span class="aicnt">'+r.count+(r.failed?(' +'+r.failed+'✗'):'')+'</span></div>';
}
function aichatChart(a){
  if(a)aiLast=a;
  var box=document.getElementById('aichat');
  if(!box)return;
  var box2=document.getElementById('aichat2'),more=document.getElementById('aichatmore'),note=document.getElementById('ainote');
  var rows=(aiLast&&aiLast.rows)||[];
  if(!rows.length){
    note.textContent='';box.innerHTML='<div class="mut">还没有记录 —— 群里 @ 机器人随便聊一句就会记在这里(AI 闲聊开关要开着)</div>';
    box2.innerHTML='';box2.style.display='none';more.innerHTML='';
    return;
  }
  note.textContent='共 '+(aiLast.total||0)+' 次'+(aiLast.updatedAt?(' · 更新于 '+fmtTime(aiLast.updatedAt)):'')+(aiLast.approximateSince?(' · 含 '+aiLast.approximateSince+' 起的估算'):'');
  var max=1;
  for(var i=0;i<rows.length;i++){if(rows[i].count>max)max=rows[i].count}
  var top=rows.slice(0,AI_TOP_N),rest=rows.slice(AI_TOP_N);
  box.innerHTML=top.map(function(r,i){return aiRowHtml(r,i,max)}).join('');
  box2.innerHTML=(rest.length&&aiExpanded)?rest.map(function(r,i){return aiRowHtml(r,i+AI_TOP_N,max)}).join(''):'';
  box2.style.display=(rest.length&&aiExpanded)?'':'none';
  more.innerHTML=rest.length?('<button class="mini" onclick="aichatToggle()">'+
    (aiExpanded?('收起,只看前 '+AI_TOP_N+' 名'):('展开其余 '+rest.length+' 人'))+'</button>'):'';
}
function logs(){
  if(!document.getElementById('auto').checked)return;
  fetch('/api/log?n=300').then(function(r){return r.json()}).then(function(j){
    var el=document.getElementById('log');
    var stick=el.scrollTop+el.clientHeight>=el.scrollHeight-40;
    el.innerHTML=j.lines.map(function(l){
      var m=l.match(/^(\\d\\d:\\d\\d:\\d\\d)\\s(.*)$/);
      return m?('<span class="t">'+h(m[1])+'</span> '+h(m[2])):h(l);
    }).join('\\n');
    if(stick)el.scrollTop=el.scrollHeight;
  }).catch(function(){});
}
var upTimer=null,upUntil=0;
var UP_MAP={done:['ok','✓ 更新完成'],failed:['bad','✗ 更新失败'],
            running:['run','⟳ 正在更新'],busy:['run','⟳ 已有更新在跑'],
            idle:['','尚无更新记录'],unknown:['','状态未知']};
function upState(j){
  var m=UP_MAP[j.state]||UP_MAP.unknown;
  document.getElementById('upbox').className='show'+(m[0]?' '+m[0]:'');
  document.getElementById('uphead').textContent=m[1];
  document.getElementById('upmsg').textContent=j.message||'';
  document.getElementById('uprog').textContent=(j.lines||[]).join('\\n');
  // 跑出结果了就停掉快轮询,别一直空转
  if(j.state==='done'||j.state==='failed'){if(upTimer){clearInterval(upTimer);upTimer=null;}}
}
function uprog(){
  return fetch('/api/update-cards/progress').then(function(r){return r.json()}).then(function(j){
    upState(j);
    if(upTimer&&Date.now()>upUntil){clearInterval(upTimer);upTimer=null;}
  }).catch(function(){});
}
function doUpdate(){
  if(!confirm('更新会联网拉取约 14MB 卡库(源站在海外,可能需要重试),随后自动补缺失卡图。期间 bot 照常回消息。确定开始?'))return;
  var bs=document.querySelectorAll('button');
  for(var i=0;i<bs.length;i++)bs[i].disabled=true;
  fetch('/api/update-cards',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
   .then(function(r){return r.json()})
   .then(function(j){
     toast(j.message||(j.ok?'已触发更新':'触发失败'));
     document.getElementById('upbox').className='show run';
     document.getElementById('uphead').textContent='⟳ 已触发,等待 monitor 开始...';
     document.getElementById('upmsg').textContent='';
     upUntil=Date.now()+300000;
     if(upTimer)clearInterval(upTimer);
     upTimer=setInterval(uprog,2000);
     setTimeout(uprog,600);
   })
   .catch(function(e){toast('请求失败:'+e.message)})
   .then(function(){for(var i=0;i<bs.length;i++)bs[i].disabled=false});
}
function boot(){
  tick();logs();snowlog();uprog();
  setInterval(tick,5000);setInterval(logs,5000);setInterval(uprog,5000);
  setInterval(snowlog,5000);
}
// 先探一下有没有登录态
fetch('/api/status').then(function(r){if(r.status!==401)document.getElementById('login').style.display='none';boot()}).catch(function(){boot()});
</script></body></html>`;

// ---------- 路由 ----------
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

function readBody(req, limit = 64 * 1024) {
  return new Promise(resolve => {
    let n = 0, chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    // 登录页本身与登录接口不需要会话
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(PAGE);
    }
    if (path === '/api/login' && req.method === 'POST') {
      const { token } = await readBody(req);
      if (!TOKEN) return json(res, 500, { message: '服务端没配 OPSWEB_TOKEN,无法登录' });
      if (!tokenMatches(token)) {
        await sleep(400);                                  // 轻微延迟,给暴力尝试加点成本
        return json(res, 401, { message: '令牌不对' });
      }
      const sid = newSession();
      res.setHeader('Set-Cookie',
        `ops=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
      return json(res, 200, { ok: true });
    }

    // 以下全要会话
    if (!checkSession(req.headers.cookie)) return json(res, 401, { message: '未登录' });

    if (path === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'ops=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (path === '/api/status' && req.method === 'GET') return json(res, 200, await buildStatus());

    if (path === '/api/log' && req.method === 'GET') {
      const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 300, 20), 3000);
      const lines = await tmuxPane(Math.max(n, 400));
      if (!lines) return json(res, 200, { lines: ['(tmux 会话不在,monitor 可能正在重启)'] });
      // 窗格比输出高时,内容在上、下方是没写过的空行 —— 从尾部取会把空行取回来,
      // 所以先把尾部空行削掉再截。中间的空行是日志本身的分隔,保留。
      const arr = lines.slice();
      while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
      return json(res, 200, { lines: arr.slice(-n) });
    }

    if (path === '/api/snowluma-log' && req.method === 'GET') {
      const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 200, 20), 2000);
      const mode = url.searchParams.get('mode') === 'all' ? 'all' : 'event';
      const t = snowlumaLogTail();
      if (!t) return json(res, 200, { lines: ['(读不到 SnowLuma 日志目录)'], mode, file: '' });
      return json(res, 200, { lines: filterSnowLog(t.lines, mode).slice(-n), mode, file: t.file });
    }

    if (path === '/api/feature' && req.method === 'POST') {
      const { key, value } = await readBody(req);
      if (key !== 'shitpost' && key !== 'kuangshen' && key !== 'ai') {
        return json(res, 400, { message: '未知开关' });     // 客户端传错了,不是后端故障
      }
      const r = await setFeature(key, !!value);
      return json(res, r.ok ? 200 : 502, r);
    }

    if (path === '/api/service' && req.method === 'POST') {
      const { unit, action } = await readBody(req);
      const allowed = new Set(['restart', 'start', 'stop']);
      if (!UNITS.some(u => u.unit === unit) || !allowed.has(action)) {
        return json(res, 400, { message: '不允许的单元或动作' });
      }
      const r = await sh('systemctl', ['--user', action, `${unit}.service`], 25000);
      const ok = r.code === 0;
      return json(res, ok ? 200 : 502, {
        ok,
        message: ok ? `已${action === 'restart' ? '重启' : action === 'start' ? '启动' : '停止'} ${unit}` : (r.err || '').trim(),
      });
    }

    if (path === '/api/tone' && req.method === 'POST') {
      // 提示词档位:直接写 tone.json(不经 tmux)—— monitor 每次回复前重读该文件,所以即时生效。
      const { tone } = await readBody(req);
      const r = setTone(String(tone || ''));
      return json(res, r.ok ? 200 : 400, {
        ok: r.ok, tone: r.tone,
        message: r.ok ? `AI 闲聊档位已切到「${TONE_CN[r.tone] || r.tone}」,下一条回复就按新档说`
          : (r.message || '档位不合法'),
        tones: { current: getTone(), options: TONES.map(t => ({ id: t, cn: TONE_CN[t], short: TONE_DESC[t].short, long: TONE_DESC[t].long })) },
      });
    }

    // 贴吧模式(2026-09-28):① 分群开关 ② 接话概率(滑杆)—— 都直接写 tieba/state.json,
    // monitor **每次用到时现读**该文件,所以点一下/拉一下立刻生效,不需要敲 tmux 按键、也不用重启。
    // 请求体:{ groupId, on } 切某个群(groupId='*' 或空 = 全部群);{ prob } / { probAt } 调概率(0~1)。
    if (path === '/api/tieba' && req.method === 'POST') {
      const { groupId, on, prob, probAt } = await readBody(req);
      const messages = [];
      if (prob !== undefined || probAt !== undefined) {
        const rp = tiebaSetProb({ prob: prob ?? null, probAt: probAt ?? null });
        messages.push(`接话概率已改为 ${Math.round(rp.prob * 100)}%(@ 时 ${Math.round(rp.probAt * 100)}%)`);
      }
      if (groupId !== undefined && on !== undefined) {
        const g = String(groupId ?? '*').trim() || '*';
        if (g !== '*' && !/^\d{4,12}$/.test(g)) return json(res, 400, { message: '群号不合法' });
        const r = tiebaSetOn(g, !!on);
        if (!r.ok) return json(res, 400, { message: r.message || '设置失败' });
        const where = g === '*' ? '全部群' : ((await groupsWithTieba().catch(() => ({ groups: [] })))
          .groups.find(x => x.groupId === g)?.name || `群 ${g}`);
        messages.push(`${where}的贴吧模式已${on ? '开启' : '关闭'}${on && g === '*' ? '(所有群都算开着)' : ''}`);
      }
      if (!messages.length) return json(res, 400, { message: '没给要改的东西(groupId/on 或 prob/probAt)' });
      return json(res, 200, { ok: true, message: messages.join(';'), tieba: await groupsWithTieba().catch(() => null) });
    }

    // 人格面板(2026-10-26 银河皇帝,2026-10-29 加脚刷周):① 分群开关 ② 每群人 格 ③ 表情包库
    // 开关/人格直接写 belial/state.json —— monitor 每次回复前现读,点一下立即生效,不用重启。
    if (path === '/api/belial' && req.method === 'POST') {
      const { groupId, on, prob, auto, autoMax, autoMin, persona } = await readBody(req);
      const messages = [];
      if (auto !== undefined) {
        if (typeof auto !== 'boolean') return json(res, 400, { message: 'auto 必须是布尔值' });
        const ra = belialSetNonAtAuto(auto);
        if (!ra.ok) return json(res, 400, { message: ra.message || '自动模式设置失败' });
        messages.push(auto ? '非@接话已切到自动模式(按群聊频次)' : '非@接话已切回滑杆固定概率');
      }
      if (autoMax !== undefined || autoMin !== undefined) {
        const rl = belialSetAutoProbs({ max: autoMax, min: autoMin });
        if (!rl.ok) return json(res, 400, { message: rl.message || '自动上下限设置失败' });
        messages.push(`自动上下限已改为 ${Math.round(rl.max * 100)}% / ${Math.round(rl.min * 100)}%`);
      }
      if (prob !== undefined) {
        const rp = belialSetNonAtProb(prob);
        if (!rp.ok) return json(res, 400, { message: rp.message || '概率设置失败' });
        messages.push(`非@接话概率已改为 ${Math.round(rp.prob * 100)}%`);
      }
      if (persona !== undefined) {
        const g = String(groupId ?? '').trim();
        if (!g) return json(res, 400, { message: '缺少 groupId' });
        if (!PERSONA_IDS.includes(persona)) return json(res, 400, { message: `未知人格:${persona}` });
        const r = belialSetPersona(g, persona);
        if (!r.ok) return json(res, 400, { message: r.message || '设置失败' });
        const cardOk = await applyPersonaCard(g, persona);
        if (!cardOk) scheduleApplyCard(g, persona);
        const where = (await groupsWithBelial().catch(() => ({ groups: [] })))
          .groups.find(x => x.groupId === g)?.name || `群 ${g}`;
        messages.push(`${where}已切到「${PERSONA_LABELS[persona] || persona}」并开启${cardOk ? ',群名片已同步' : '(群名片暂时没切成,已排队重试;QQ 对改名片有频率限制)'}`);
      } else if (groupId !== undefined && on !== undefined) {
        if (typeof on !== 'boolean') return json(res, 400, { message: '缺少 on(布尔值)' });
        const g = String(groupId ?? '*').trim() || '*';
        if (g !== '*' && !/^\d{4,12}$/.test(g)) return json(res, 400, { message: '群号不合法' });
        const r = belialSetOn(g, on);
        if (!r.ok) return json(res, 400, { message: r.message || '设置失败' });
        if (on) {
          if (g === '*') {
            const rows = (await groupsWithBelial().catch(() => ({ groups: [] }))).groups || [];
            for (const row of rows) await applyPersonaCard(row.groupId, row.persona);
          } else {
            await applyPersonaCard(g, belialPersonaOf(g));
          }
        } else if (g === '*') {
          // 全部群关闭:逐个恢复记录过的原名片(没记录过的群不动)
          for (const gid of Object.keys(belialAll().cards || {})) {
            const ok = await restorePersonaCard(gid);
            if (!ok) scheduleRestoreCard(gid);
          }
        } else {
          const ok = await restorePersonaCard(g);
          if (!ok) scheduleRestoreCard(g);
        }
        const where = g === '*' ? '全部群' : ((await groupsWithBelial().catch(() => ({ groups: [] })))
          .groups.find(x => x.groupId === g)?.name || `群 ${g}`);
        messages.push(`${where}的人格模式已${on ? '开启' : '关闭'}`);
      }
      if (!messages.length) return json(res, 400, { message: '没给要改的东西(groupId/on、persona 或 prob)' });
      return json(res, 200, {
        ok: true,
        message: messages.join(';'),
        belial: await groupsWithBelial().catch(() => null),
      });
    }
    if (path === '/api/persona/memory' && req.method === 'POST') {
      const { persona, action, text, id, kind } = await readBody(req);
      if (!PERSONA_IDS.includes(persona)) return json(res, 400, { message: `未知人格:${persona}` });
      const seed = persona === JSZ_ID ? JSZ_SEED_MEMORIES : [];
      let r;
      if (action === 'add') r = personaAddMemory(persona, text, { kind: kind || 'fact', seed });
      else if (action === 'edit') r = personaUpdateMemory(persona, id, text, { seed });
      else if (action === 'delete') r = personaDeleteMemory(persona, id, { seed });
      else return json(res, 400, { message: 'action 只能是 add / edit / delete' });
      return json(res, r.ok ? 200 : 400, {
        ...r,
        message: r.ok ? (r.duplicate ? '已经记过了' : (action === 'add' ? '已加入记忆库' : action === 'edit' ? '已改好' : '已删除')) : (r.message || '操作失败'),
        memories: personaListMemories(persona, { seed, includeSeed: true }),
      });
    }
    if (path === '/api/belial/voice' && req.method === 'POST') {
      const { voice } = await readBody(req);
      const r = setVoiceMode(voice);
      return json(res, r.ok ? 200 : 400, {
        ...r,
        voiceMode: readVoiceMode(),
        message: r.ok ? `默认声线已切到${voiceModeLabel(voice)}` : (r.message || '切换失败'),
      });
    }
    if (path === '/api/belial/stickers' && req.method === 'GET') {
      const api = stickerApiFor(url.searchParams.get('persona'));
      return json(res, 200, { ok: true, persona: api.id, stickers: api.catalog(), maxBytes: api.maxBytes });
    }
    if (path === '/api/belial/stickers' && req.method === 'POST') {
      // 上传走 JSON(base64):前端 FileReader 读成 dataURL,这里拆掉前缀再按文件头校验。
      // 12MB 的请求体上限足够 5MB 的原图(base64 约 6.7MB),再大就拒绝。
      const body = await readBody(req, 12 * 1024 * 1024);
      const api = stickerApiFor(body.persona);
      const data = String(body.data || '');
      if (!data) return json(res, 400, { message: '没有收到文件内容' });
      let buf;
      try { buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64'); }
      catch { return json(res, 400, { message: '文件内容不是合法的 base64' }); }
      const r = api.add(buf, String(body.name || ''));
      return json(res, r.ok ? 200 : 400, {
        ...r,
        persona: api.id,
        message: r.ok ? `已上传「${r.name}」` : (r.message || '上传失败'),
        stickers: api.catalog(),
      });
    }
    if (path === '/api/belial/stickers/autoname' && req.method === 'POST') {
      const body = await readBody(req);
      const api = stickerApiFor(body.persona);
      const limit = Math.min(10, Math.max(1, Number(body.limit || 5)));
      const r = await autonameStickers({ limit, force: !!body.force, stickerApi: api });
      return json(res, 200, {
        ...r,
        persona: api.id,
        stickers: api.catalog(),
        message: r.total
          ? `AI 命名:成功 ${r.done} / 失败 ${r.failed}`
          : '没有未命名的 up_ 表情包',
      });
    }
    if (path === '/api/belial/stickers/delete' && req.method === 'POST') {
      const { name, persona } = await readBody(req);
      const api = stickerApiFor(persona);
      const r = api.remove(String(name || ''));
      return json(res, r.ok ? 200 : 400, {
        ...r,
        persona: api.id,
        message: r.ok ? `已删除「${r.name}」` : (r.message || '删除失败'),
        stickers: api.catalog(),
      });
    }
    if (path === '/api/belial/sticker' && req.method === 'GET') {
      // 给运维台 <img> 用。只认该人格 stickers/ 下的图片文件,路径穿越在 stickerPath 里挡掉了。
      const api = stickerApiFor(url.searchParams.get('persona'));
      const name = url.searchParams.get('name') || '';
      const p = api.path(name);
      if (!p) return json(res, 404, { message: '没有这张表情包' });
      const mime = api.mime(name);
      let buf;
      try { buf = readFileSync(p); } catch { return json(res, 500, { message: '读取表情包失败' }); }
      res.writeHead(200, {
        'Content-Type': mime || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
    }

    if (path === '/api/mode' && req.method === 'POST') {      const { groupId, mode } = await readBody(req);
      if (!groupId || !MODES.includes(mode)) return json(res, 400, { message: '群号或模式不合法(mode 只能是 ygo / hs)' });
      const r = setGroupMode(String(groupId), mode);
      return json(res, r.ok ? 200 : 400, {
        ok: r.ok, changed: r.changed, mode: r.mode,
        message: r.ok ? (r.changed ? `群 ${groupId} 已切到${MODE_CN[mode]}` : `群 ${groupId} 本来就是${MODE_CN[mode]}`) : '设置失败',
        modes: await groupsWithMode().catch(() => []),
      });
    }

    if (path === '/api/update-cards' && req.method === 'POST') {
      const r = await updateCards();
      return json(res, r.ok ? 200 : 502, r);
    }

    if (path === '/api/update-cards/progress' && req.method === 'GET') {
      return json(res, 200, await updateProgress());
    }

    return json(res, 404, { message: '没有这个接口' });
  } catch (e) {
    return json(res, 500, { message: '服务端出错:' + (e && e.message ? e.message : String(e)) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`opsweb 运维台已启动: http://${HOST}:${PORT}`);
  console.log(`访问方式(本机开隧道): ssh -N -L ${PORT}:127.0.0.1:${PORT} <用户>@<服务器>`);
  // 把「.env 读到了几个键」打出来**只打名字不打值**(2026-09-21 起):那次 CRLF 解析事故就是
  // 「一个键都没读到」,但在界面上只表现为「登录失败 / 搜索源不对」,谁也没往 .env 上想。
  console.log(`agent/.env: 读入 ${loadedEnvKeys.length} 个键${loadedEnvKeys.length ? `(${loadedEnvKeys.join(', ')})` : '(文件不存在,或这些键已由环境变量提供)'}`);
  if (!TOKEN) console.log('⚠ 未配置 OPSWEB_TOKEN,登录会失败 —— 请在 agent/.env 里加一行');
});
