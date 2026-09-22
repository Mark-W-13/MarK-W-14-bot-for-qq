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

// 调 OneBot 拿账号信息(本地回环 + 令牌)
async function onebot(action) {
  const api = process.env.API || 'http://127.0.0.1:3000/';
  const token = process.env.API_TOKEN || process.env.SNOWLUMA_API_TOKEN || '';
  if (!token) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(api + action, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
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

    if (path === '/api/mode' && req.method === 'POST') {
      const { groupId, mode } = await readBody(req);
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
