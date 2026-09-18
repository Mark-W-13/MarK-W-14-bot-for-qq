// QQ Agent 一体化监控终端 (console)
// 由 start.bat 在新窗口启动。功能:
//   1. WS 监听 @机器人 → 写入 inbox.jsonl (去重)
//   2. 处理队列:拉最近100条 → claude -p 生成史记体回复 → 发送 → 标记 processed
//   3. 按键控制:q = 退出(仅本进程)  Q = 退出并停 SnowLuma
// 退出时清理自身拉起的 claude 子进程(按 PID,不影响其他 claude 会话)。
//
// 用法: node monitor.mjs   (可用 DRY_RUN=1 试运行,不真正发消息)
// 配置: 下方常量或环境变量覆盖

import './env.mjs';   // ⚠ 必须第一个:下面的模块在顶层读 process.env,而 ESM 按 import 顺序求值
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { queryAndFormat, reloadCards, getCardsPath, extractZipCardJson, loadCards, formatCard, searchCards, cardImageSegment } from './ygocard/ygocard.mjs';
import { fetchCardRulings, fetchFullRulings, buildRulingsPdf } from './ygocard/rulings.mjs';
import { downloadImages } from './ygocard/download_images.mjs';
import { generateDeckListPdf, classifyDeckInput } from './ygocard/decklist.mjs';
import { pickShit, buildCardHtml, buildVideoCardHtml, pickVideoShit, renderCard, pngToSegment, appendShitVideo, addToBlacklist, removeFromShitVideos } from './shitpost/shitpost.mjs';
import { collectQuoteFromEvent, pickFeaturedQuote, backfillQuotes, searchQuotes, addToBlacklist as quoteBlacklist, removeQuoteBySeq } from './kuangshen/kuangshen.mjs';
import { buildQuestion as buildAiQuestion, buildQuestionRich as buildAiQuestionRich, faceLabel } from './aichat/aichat.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
// .env 的加载挪到了 env.mjs(第一行 import),理由见那个文件的注释 —— 顶层读 env 的模块
// (rulings / shitpost / kuangshen)必须先看到 .env,否则拿不到 CHROME_PATH / API_TOKEN。
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:3001/';
const WS_TOKEN = process.env.WS_TOKEN || process.env.SNOWLUMA_WS_TOKEN;
const API = process.env.API || 'http://127.0.0.1:3000/';
const API_TOKEN = process.env.API_TOKEN || process.env.SNOWLUMA_API_TOKEN;
if (!WS_TOKEN || !API_TOKEN) {
  console.error('缺少 OneBot token:请在 agent/.env 中设置 WS_TOKEN 与 API_TOKEN(参考 README,该文件不入库)');
  process.exit(1);
}
const BOT_ID = (process.env.BOT_ID || '3757588606').toString();
const TRIGGER_KEYWORD = process.env.TRIGGER_KEYWORD || '史记总结'; // 史记体触发词
const CARD_TRIGGER = process.env.CARD_TRIGGER || '效果';            // 查卡触发词:「效果 」后跟卡名
const CARD_IMG_TRIGGER = process.env.CARD_IMG_TRIGGER || '卡图';     // 查卡图触发词:「卡图 」后跟卡名(只发图)
const RULING_TRIGGER = process.env.RULING_TRIGGER || '裁定';         // 官方裁定触发词:「裁定 」后跟卡名(百鸽 ygocdb.com 镜像,日文原文)
const RULING_FULL_TRIGGER = process.env.RULING_FULL_TRIGGER || '完整裁定'; // 完整裁定触发词:「完整裁定 」+卡名 → 全量直接裁定打包 PDF 群文件
const DAILY_KEYWORD = process.env.DAILY_KEYWORD || '每日一卡';      // 每日一卡触发词(同 id 24h 内不换卡)
const DECK_TRIGGER = process.env.DECK_TRIGGER || '生成卡表';        // 卡表生成触发词:「生成卡表 」+ ydk文本/卡组码/分享链接 → 上传 PDF 群文件
const SHIT_TRIGGER = process.env.SHIT_TRIGGER || '随机一搬';        // 搬屎触发词:纯规则筛选,发截图
const SHIT_AI_TRIGGER = process.env.SHIT_AI_TRIGGER || '精选一搬';  // 搬屎触发词:规则粗筛 + AI 精挑
const KUANGSHEN_TRIGGER = process.env.KUANGSHEN_TRIGGER || '框神语录'; // 框神语录触发词:从精筛语录库随机抽一条
// ---------- AI 闲聊后端(2026-09-17 改:图片随消息直传、一次请求出结果) ----------
// 两套后端,AI_CHAT_PROVIDER 选;没显式指定时「有 DEEPSEEK_API_KEY 就走 deepseek,否则智谱 GLM」。
//   deepseek(默认推荐):模型自己会看图 → 图片按 data URL 直接附在消息里,**一轮出结果**
//   glm               :glm-4-flash 没有视觉,图片只能先让视觉模型认成文字再问(两轮,见 aichat.mjs)
const GLM_API_KEY = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || ''; // 智谱 key
const GLM_MODEL = process.env.GLM_MODEL || 'glm-4-flash';                       // 免费模型(实测 1~2 秒回)
const GLM_API_URL = process.env.GLM_API_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const AI_IS_DS = (process.env.AI_CHAT_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'glm')).toLowerCase() === 'deepseek';
const AI_API_KEY = AI_IS_DS ? (process.env.DEEPSEEK_API_KEY || '') : GLM_API_KEY;
const AI_API_URL = process.env.AI_CHAT_API_URL || (AI_IS_DS ? 'https://api.deepseek.com/chat/completions' : GLM_API_URL);
const AI_MODEL = process.env.AI_CHAT_MODEL || (AI_IS_DS ? 'deepseek-flash' : GLM_MODEL);
const AI_CHAT_CTX = Math.max(0, Number(process.env.AI_CHAT_CTX ?? 10));         // 附带最近 N 条群聊当上下文(0=不带;用户 2026-09-14 从 30 调小到 10)
const AI_CHAT_WEB_SEARCH = process.env.AI_CHAT_WEB_SEARCH !== '0';              // 联网搜索(默认开;=0 关)
// 智谱服务端的联网搜索工具**只对智谱有效**:deepseek 挂上它会直接 4xx,所以换后端时自动不挂。
const AI_WEB_SEARCH = AI_CHAT_WEB_SEARCH && !AI_IS_DS;
// deepseek 系默认会「思考」:实测 reasoning_effort='low' 会把 max_tokens 全烧在思考上、**正文返回空**
// ('none' 才是真关,1.1s)。闲聊要快、要短 → 默认关;想开思考设 AI_CHAT_REASONING=1。
const AI_THINK_OFF = AI_IS_DS && process.env.AI_CHAT_REASONING !== '1';
const AI_CHAT_MAX_TOKENS = Number(process.env.AI_CHAT_MAX_TOKENS || 800);       // 上限:留足思考/正文,别像 500 那样被思考吃空
const AI_CHAT_TIMEOUT_MS = Number(process.env.AI_CHAT_TIMEOUT_MS || 30000);     // 单次请求超时
const AI_CHAT_COOLDOWN_MS = Number(process.env.AI_CHAT_COOLDOWN_MS || 15000);   // 每人冷却,防连点刷屏
const AI_CHAT_MAX_CHARS = Number(process.env.AI_CHAT_MAX_CHARS || 400);         // 回复超长截断阈值
// 搬屎记忆样本库:env 优先 → 本机 memory 目录(Windows 现状)→ 仓库 data/(服务器部署位)
const SHIT_EXAMPLES_PATH = process.env.SHIT_EXAMPLES_PATH
  || (existsSync('C:/Users/hp/.claude/projects/C--Users-hp-Desktop---mc-agent/memory/shitpost-examples.md')
    ? 'C:/Users/hp/.claude/projects/C--Users-hp-Desktop---mc-agent/memory/shitpost-examples.md'
    : join(__dirname, '..', 'data', 'shitpost-examples.md'));

// ---------- 运行时功能状态(热开关总控,免重启) ----------
// 总开关:搬屎 / 框神语录(控制台 1/2 切),状态持久化 features.json,首次运行以 .env 为初值建文件
// (SHIT_ENABLED / KUANGSHEN_ENABLED env 常量只作首启初值,之后以文件+控制台为准)。
const FEAT_FILE = join(__dirname, 'features.json');
function featDefaults() {                                             // .env 初值(仅建文件时使用)
  return {
    shitpost: process.env.SHIT_ENABLED === '1',                    // 搬屎(随机一搬/精选一搬)
    kuangshen: process.env.KUANGSHEN_ENABLED === '1',              // 框神语录(回复+实时采集+回填)
    ai: process.env.AI_CHAT_ENABLED ? process.env.AI_CHAT_ENABLED === '1' : !!AI_API_KEY, // AI 闲聊(兜底;无 key 时强制关)
    updatedAt: 0,
  };
}
function loadFeatures() {
  const d = featDefaults();
  let f = null;
  try { f = JSON.parse(readFileSync(FEAT_FILE, 'utf8')); } catch { /* 缺失/损坏 → 用 .env 初值 */ }
  if (f) {
    if (typeof f.shitpost === 'boolean') d.shitpost = f.shitpost;
    if (typeof f.kuangshen === 'boolean') d.kuangshen = f.kuangshen;
    if (typeof f.ai === 'boolean') d.ai = f.ai;
  }
  if (!AI_API_KEY) d.ai = false;   // 没配 key,开了也是白开
  // 文件缺字段(老文件遇新开关)时补写一份:否则运维 WebUI 读到 undefined 会显示成 OFF,
  // 与实际运行状态不符,点开关也会对不上。
  if (!f || ['shitpost', 'kuangshen', 'ai'].some(k => typeof f[k] !== 'boolean')) {
    try {
      writeFileSync(FEAT_FILE + '.tmp', JSON.stringify({ ...d, updatedAt: Date.now() }, null, 1), 'utf8');
      renameSync(FEAT_FILE + '.tmp', FEAT_FILE);
    } catch { /* 写不了就算了,不影响运行 */ }
  }
  return d;
}
function saveFeatures() {
  FEAT.updatedAt = Date.now();
  writeFileSync(FEAT_FILE + '.tmp', JSON.stringify(FEAT, null, 1), 'utf8');
  renameSync(FEAT_FILE + '.tmp', FEAT_FILE);
}
const FEAT = loadFeatures();
const DAILY_STATE_FILE = join(__dirname, 'daily_card.json');
const INBOX = join(__dirname, 'inbox.jsonl');
const PROCESSED = join(__dirname, 'processed.jsonl');
const POLL_MS = 15000;          // 处理队列轮询间隔
const CLAUDE_TIMEOUT_MS = 120000; // claude -p 超时
const DRY_RUN = process.env.DRY_RUN === '1';
const RECONNECT_BASE_MS = 2000;
const CARDS_ZIP_URL = 'https://ygocdb.com/api/v0/cards.zip';      // 卡库更新源(百鸽)
const CARDS_MD5_URL = 'https://ygocdb.com/api/v0/cards.zip.md5';
// 百鸽服务器在海外,国内机器连它握手常要 9~16 秒,慢且偶发超时。
// Node fetch 默认连接超时只有 10 秒,正好卡在这个区间 → 必然失败。故显式放宽 + 重试。
const CARDS_FETCH_TIMEOUT_MS = Number(process.env.CARDS_FETCH_TIMEOUT_MS || 120000);
const CARDS_FETCH_TRIES = Math.max(1, Number(process.env.CARDS_FETCH_TRIES || 3));

// ---------- 工具 ----------
const C = { dim: '\x1b[90m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', reset: '\x1b[0m' };
function log(tag, msg, color = '') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`${C.dim}${t}${C.reset} ${color}${tag}${C.reset} ${msg}`);
}

// seen: WS 去重(已入过 inbox 的 @ 不重复追加)
function loadSeen() {
  const seen = new Set();
  if (!existsSync(INBOX)) return seen;
  for (const line of readFileSync(INBOX, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { seen.add(JSON.parse(line).seq); } catch {}
  }
  return seen;
}

// processedSeen: 处理循环判断(仅以 processed.jsonl 为准)
function loadProcessed() {
  const s = new Set();
  if (!existsSync(PROCESSED)) return s;
  for (const line of readFileSync(PROCESSED, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { s.add(JSON.parse(line).seq); } catch {}
  }
  return s;
}

// bot 昵称集合(纯文本 @ 识别用):启动时从登录信息拉取,昵称变更后无需改代码
let botNicknames = new Set(['测试bot.fd']);

function isMentioningBot(ev) {
  if (ev.post_type !== 'message' || ev.message_type !== 'group') return false;
  if (String(ev.user_id) === BOT_ID) return false;
  if ((ev.message || []).some(s => s.type === 'at' && String(s.data?.qq) === BOT_ID)) return true;
  if (new RegExp(`\\[CQ:at,qq=${BOT_ID}(?:,[^\\]]*)?\\]`).test(ev.raw_message || '')) return true;
  // 纯文本 @(QQ 端手动输入「@昵称」时没有 at 段,只有 text):@机器人昵称 或 @BOT_ID
  const raw = ev.raw_message || (ev.message || []).map(s => s.data?.text || '').join('');
  const nicks = [...botNicknames].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`@\\s*(?:${BOT_ID}|${nicks})`).test(raw);
}

async function api(action, params) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
  return r.json();
}

// ---------- 拉历史并精简 (复用 extract 逻辑) ----------
function nameOf(sender) {
  const card = (sender?.card || '').trim();
  const nick = (sender?.nickname || '').trim();
  return card || nick || `成员${sender?.user_id ?? '?'}`;
}

function segText(seg, names) {
  switch (seg.type) {
    case 'text': return seg.data.text;
    case 'at': return names.has(seg.data.qq) ? `@${names.get(seg.data.qq)}` : '@all';
    case 'image': return '[图]';
    case 'face': return faceLabel(seg.data.id) ? `[表情:${faceLabel(seg.data.id)}]` : '[表情]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'reply': return '[回复]';
    case 'forward': return '[转发消息]';
    default: return `[${seg.type}]`;
  }
}

async function fetchTranscript(groupId, count = 100) {
  const { data } = await api('get_group_msg_history', { group_id: groupId, count });
  const msgs = data?.messages || [];
  if (!msgs.length) return null;
  const names = new Map();
  for (const m of msgs) if (m.user_id && !names.has(m.user_id)) names.set(m.user_id, nameOf(m.sender));
  const lines = [];
  // 跨天的消息**必须带日期**:群里静半天/一天时「最近 N 条」可能整段是昨天的,只给 HH:MM 模型会当成
  // 刚刚发生(2026-09-14 实测:上下文最后几行是 09-13 的 17:19,问「现在几点了」它答「下午 5 点 19 分」
  // ——就是从那行抄的,尽管系统提示词里已写着「现在是 …11:27」)。前缀只加给非今天的消息。
  const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const t0 = dayStart(new Date());
  for (const m of msgs.reverse()) {
    if (String(m.user_id) === BOT_ID) continue;    const t = new Date(m.time * 1000);
    const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const text = (m.message || []).map(s => segText(s, names)).join('').trim();
    if (!text) continue;
    const diff = Math.round((t0 - dayStart(t)) / 86400000);   // 整天差:0=今天 1=昨天 2=前天
    const dayTag = diff <= 0 ? '' : diff === 1 ? '昨天 ' : diff === 2 ? '前天 ' : `${t.getMonth() + 1}-${t.getDate()} `;
    lines.push(`${dayTag}${hhmm} ${names.get(m.user_id) || nameOf(m.sender)}|${text}`);  }
  return { lines: lines.join('\n'), names };
}

// ---------- Claude 生成回复 ----------
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    claudeChildren.add(child.pid); // 记录,退出时清理
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      claudeChildren.delete(child.pid);
      reject(new Error('claude 超时'));
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); claudeChildren.delete(child.pid); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      claudeChildren.delete(child.pid);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude 退出码 ${code}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildPrompt(transcript, trigger) {
  const targetText = trigger.targetNames?.length
    ? `\n本次消息中@了目标成员: ${trigger.targetNames.join('、')}(依据:消息里同时@了TA,视为指定对象)。回答聚焦于 TA 的发言/梗/行为,可从记录中定位;若无明显相关内容,如实说明。`
    : '';
  return `你是 QQ 群里的"赛博史官"机器人,专以史记体文言文(如"太史公曰：")回答群友。收到群消息记录(格式 "HH:MM 昵称|内容",带「昨天/前天/M-D」前缀的不是今天的消息)和@你的问题。
规则:
- 默认情况:用一句(最多两句)文言史记体总结最近群聊,诙谐生动,浓缩梗与人物
- 若是提问(你是谁/某梗是什么/讨论什么):用文言答问,同样简洁
- 只输出回复正文,不要引号、不要"at"前缀、不要多余解释
- 太史公曰： 开头
${targetText}
群消息记录(最近100条):
${transcript}

@者: ${trigger.nickname}
@者提问: ${trigger.text.replaceAll(TRIGGER_KEYWORD, '').replace(/^\[at\]\s*/, '').trim() || '(无文字,仅@)'}`;
}

// ---------- AI 闲聊(兜底:未命中任何指令的 @ 交给 GLM 免费模型;人设=赛博史官说白话) ----------
// 与「史记总结」的分工:总结走 claude 出文言体;这里只接群友的随口 @,答白话、短。
// 消息里的 @/引用/表情/图片由 aichat.mjs 解析:图片走两轮(第 1 轮视觉模型识别 → 第 2 轮拼回正文再答)。
const aiCooldown = new Map();   // uid -> 上次触发时间戳(15s 冷却,防连点刷屏)
const AI_SYSTEM_PROMPT = `你是 QQ 群里的机器人「赛博史官」,群友 @ 你时,你就像群里一个熟人那样接话。
人设与语气:
- 自称「史官」,人设只体现在这个身份上
- 正文一律说现代白话,像群友平时聊天那样:别写文言文,别用「吾/汝/之/也/矣/哉」这类字眼,别掉书袋
- 口语、直接;别只丢一句套话,该说的信息说清楚,一般 2~3 句、150 字以内
规则:
- 下面的群聊记录供你理解上下文、梗与人称指代;记录里没有的事别编造
- 群友的消息里可能出现这些标记,那是消息本身的内容,照着理解就行:
  [表情:微笑] = 他发了个 QQ 表情;
  [图片1] / [表情包1] = 他这条消息**附的第 1 张图**(图就附在这条消息里,你直接看图理解,别去猜);
  [图片: 一段文字] = 那张图的内容(这条是旧格式的图片说明);
  [引用 @某人: …] = 他在回复(引用)那条消息;@某人 = 他在消息里 @ 了谁
- **标记只是给你理解用的**:「[图片1]」「[表情包1]」这种**占位符**别写进回复(那是给你指认附图的,不是给他看的内容);
  **发表情没问题**——想带情绪就直接打表情符号(像 😄),别写「[表情:微笑]」这种标记形式,也别每句都带
- 群聊记录里「昨天 17:19」「9-13 17:19」这种前缀表示那条消息不是今天的,别当成刚发生的事
- 只输出回复正文:不要 @ 任何人、不要引号包裹、不要「史官:」之类前缀、不要解释你的思路
- 不知道就直说不知道;群友互喷时别站队,轻松带过
- 不聊政治、色情、违法内容,被问到就岔开
- 再说一遍:全程白话,连「你是谁」这种问题也用白话答,不要文言文`;

// 提问正文:剥掉 @ 段标记(形如 [at])与多余空白(降级路径:没有 segs 的老条目 / 解析失败时用)
function aiQuestionText(entry) {
  return (entry.text || '').replace(/\[at\]/g, ' ').replace(/\s+/g, ' ').trim();
}

// @ 与引用作者 → 群昵称(先查本次已拉到的群聊记录,再查群成员接口,查不到才用「成员<qq>」;
// 群名片改名不频繁,进程内缓存够用)
const memberNames = new Map();
async function resolveMemberName(groupId, qq) {
  const key = `${groupId}:${qq}`;
  if (memberNames.has(key)) return memberNames.get(key);
  let name = '';
  try {
    const r = await api('get_group_member_info', { group_id: groupId, user_id: Number(qq) });
    name = (r?.data?.card || r?.data?.nickname || '').trim();
  } catch { /* 查不到就退兜底名 */ }
  if (name) memberNames.set(key, name);
  return name || `成员${qq}`;
}

// 联网搜索(2026-09-14 上线):glm-4-flash 免费,挂上之后是**按需搜** —— 实测同一张工具挂/不挂,
//   闲聊「这图太生草了」prompt_tokens 都是 73(没搜);问「最新禁卡表」则 73 → 5117(搜了,结果由服务端
//   直接注入提示词,不返回 tool_calls)。**别传 search_query**:传了就是每问必搜(实测连「随便聊聊」都搜,6.2s)。
//   治的是「我查了一下,你附近有一家老成都馄饨」这种凭空编 —— 挂了之后事实性问题会真去搜。
//   ⚠ 搜了也不等于对:实测问最新禁卡表,搜完仍答成「2024年1月1日」(对 2026 年明显过时)。
//   ⚠ glm-4.5-flash 挂它会返回空回复(把 max_tokens 全用在推理上),换模型时记得调大 max_tokens。
const WEB_SEARCH_TOOL = { type: 'web_search', web_search: { enable: true } };

// 「今天几号」这类问题**联网不会触发**(2026-09-14 实测):同一句话挂/不挂 tools,prompt_tokens 都是 369
//   (压根没搜),模型就直接编 —— 连问两次,一次「今天20号」一次「今天12号」。而问「最新禁卡表」确实会搜
//   (427 → 2811)。所以**不是联网坏了,是日期得自己喂**:glm-4-flash 的训练数据本就停在过去,
//   而它自认为知道今天几号,根本不会去搜。喂进去立刻就对(实测「今天9月14号,周一呢」)。
//   **每次请求现算**,别提到模块顶层算一次 —— monitor 是常驻进程,顶层那个值会停在启动那一刻,
//   过了午夜就开始骗人(本地时间,与每日一卡的 dayKey 同一套基准;服务器 TZ 已是 Asia/Shanghai)。
function nowText(ts = Date.now()) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日(星期${'日一二三四五六'[d.getDay()]})${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 带图时的额外规则(2026-09-17 实测补的):**不加这条,模型会漏掉/答错图上的关键信息** ——
// 起因:群友引用一张 394x138 的卡图说「翻译」,模型答成「能通常召唤」(卡上写的是不能通常召唤)。
// 复现与对照(同一张图、线上同款提示词):原样跑 3 次只有 1 次提到召唤限制;只把温度降到 0.3 → 0/3(没用);
// 把图放大 4 倍 → 能读对但更贵(in=1239);**只加下面这条规则 → 3/3 全对**,且不用放大(in=877)。
// 结论:关键在「让它照实读、读不清就说读不清」,不在分辨率也不在温度 —— 别再回头折腾放大。
const IMG_READ_RULE = `
- 他这条消息带了图。图上的字**照实读**:卡名、数值、召唤条件这类关键信息一律以图上写的为准;
  图上写没写「不能通常召唤」这类限制,写了就必须译出来,没写就别自己加
- 读不清就说读不清,别猜、别拿常识补;拿不准就说拿不准(群友追问时也一样,别为了顺着他改口,也别为了顶回去硬撑)`;

// 系统提示词 = 固定人设 + 当前时间。末尾「他没问就别主动报时间」是给小模型的护栏:不写这句,
// 它容易在闲聊里顺嘴报一句时间,写了之后闲聊不再带时间(实测;联网那套照旧,事实问题该搜还搜)。
const aiSystemPrompt = (hasImages = false) => `${AI_SYSTEM_PROMPT}${hasImages ? IMG_READ_RULE : ''}
- 现在是 ${nowText()}。这是你说话时的真实时间,群友问日期/时间/星期以它为准;他没问就别主动报时间`;

async function aiChat(system, userText, images = []) {
  // 退让阶梯:先按默认档跑;碰到 4xx(参数/格式不认)依次去掉「联网工具」「关思考」,最后连图一起去掉。
  // 换后端/换模型最容易踩的就是参数不认 —— 实测 deepseek 挂智谱的 web_search 工具必 4xx,
  // 有的后端不认 reasoning_effort。一个参数不能把整条闲聊弄挂。
  // 超时/网络错**不重试**:再来一轮只会把群友的等待翻倍。
  const ladder = [
    { webSearch: AI_WEB_SEARCH, thinkOff: AI_THINK_OFF, images, tag: '' },
    ...(AI_WEB_SEARCH ? [{ webSearch: false, thinkOff: AI_THINK_OFF, images, tag: '去掉联网工具' }] : []),
    ...(AI_THINK_OFF ? [{ webSearch: false, thinkOff: false, images, tag: '带上思考' }] : []),
    ...(images.length ? [{ webSearch: false, thinkOff: AI_THINK_OFF, images: [], tag: '去掉图片' }] : []),
  ];
  let lastErr;
  for (const step of ladder) {
    try {
      if (step.tag) log(`  AI 闲聊重试(${step.tag})...`, '', C.dim);
      return await aiChatOnce(system, userText, step.images, step);
    } catch (e) {
      lastErr = e;
      if (!/^HTTP 4/.test(String(e.message || ''))) throw e;
    }
  }
  throw lastErr;
}

// 图片按 OpenAI 多模态格式附在正文后面;**必须是 data URL**(data:image/jpeg;base64,...)——
// 实测传裸 base64 会被拒「Unsupported image_url format」(2026-09-17)。
function buildUserContent(text, images) {
  if (!images?.length) return text;
  return [
    { type: 'text', text },
    ...images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } })),
  ];
}

async function aiChatOnce(system, userText, images = [], opts = {}) {
  const { webSearch = AI_WEB_SEARCH, thinkOff = AI_THINK_OFF } = opts;
  const r = await fetch(AI_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: buildUserContent(userText, images) }],
      temperature: 0.8,
      max_tokens: AI_CHAT_MAX_TOKENS,
      ...(thinkOff ? { reasoning_effort: 'none' } : {}),
      ...(webSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
    }),
    signal: AbortSignal.timeout(AI_CHAT_TIMEOUT_MS),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${j?.error?.message || j?.message || ''}`.trim());
  const text = j?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${AI_MODEL} 返回空回复`);
  return text;
}

// ---------- AI 闲聊记账(2026-09-17:运维 WebUI 要按用户统计调用次数) ----------
// 口径(用户定的):**以回复发给了哪个 @用户为准** —— 所以只在「回复真的发出去」时 +1;
// 冷却跳过(压根没调模型)与失败(回了「史官一时语塞」)分开记 failed,不计入次数。
// 存 agent/aichat_stats.json(不入库),运维台读它画横向条形图。
const AICHAT_STATS_FILE = join(__dirname, 'aichat_stats.json');
function loadAiChatStats() {
  try {
    const s = JSON.parse(readFileSync(AICHAT_STATS_FILE, 'utf8'));
    if (s && typeof s === 'object' && s.users) return s;
  } catch { /* 文件缺失/损坏 → 从零开始 */ }
  return { users: {}, total: 0, updatedAt: 0 };
}
function saveAiChatStats(s) {
  s.updatedAt = Date.now();
  try {
    writeFileSync(AICHAT_STATS_FILE + '.tmp', JSON.stringify(s, null, 1), 'utf8');
    renameSync(AICHAT_STATS_FILE + '.tmp', AICHAT_STATS_FILE);
  } catch (e) { log('  AI 闲聊记账失败:', e.message, C.red); }
}
function bumpAiChatStat(entry, ok = true) {
  const s = loadAiChatStats();
  const qq = String(entry.user_id);
  const u = s.users[qq] || (s.users[qq] = { name: '', count: 0, failed: 0, last: 0 });
  if (entry.nickname) u.name = entry.nickname;          // 群名片会改,记最新的
  if (ok) { u.count = (u.count || 0) + 1; u.last = Date.now(); s.total = (s.total || 0) + 1; }
  else u.failed = (u.failed || 0) + 1;
  saveAiChatStats(s);
}

// 历史回填(启动参数 --backfill-aichat-stats [YYYY-MM-DD]):processed.jsonl 里没记「哪条是 AI 闲聊」,
// 只能按 processEntry 的分流顺序把其它触发词逐条排掉 —— 所以是**近似值**:
//   ① 开关状态未必与当时一致(比如框神语录那阵子还开着);② 触发词可能被 env 改过。
// 只为让统计页一开始就有数,别当账本。
function looksLikeAiChat(entry) {
  const text = (entry.text || '').replace(/\[at\]/g, ' ');
  if (!text.trim()) return false;
  if (isHelpRequest(text)) return false;
  if (text.includes(TRIGGER_KEYWORD)) return false;
  if (text.includes(DAILY_KEYWORD)) return false;
  if (extractCardQuery(entry, DECK_TRIGGER).triggered) return false;
  if (text.includes(KUANGSHEN_TRIGGER)) return false;
  if (text.includes(SHIT_AI_TRIGGER) || text.includes(SHIT_TRIGGER)) return false;
  if (extractCardQuery(entry, CARD_TRIGGER).triggered) return false;
  if (extractCardQuery(entry, CARD_IMG_TRIGGER).triggered) return false;
  if (text.includes(RULING_FULL_TRIGGER)) return false;
  if (extractCardQuery(entry, RULING_TRIGGER).triggered) return false;
  return true;
}
function backfillAiChatStats(since = '2026-09-13') {
  const cutoff = Math.floor(new Date(`${since}T00:00:00+08:00`).getTime() / 1000);
  const s = loadAiChatStats();
  const seen = new Set();
  let scanned = 0, added = 0;
  const lines = existsSync(PROCESSED) ? readFileSync(PROCESSED, 'utf8').split('\n') : [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (seen.has(e.seq)) continue;                       // processed.jsonl 里同一条可能有多行
    seen.add(e.seq);
    scanned++;
    if ((e.time || 0) < cutoff) continue;
    if (!looksLikeAiChat(e)) continue;
    const qq = String(e.user_id);
    const u = s.users[qq] || (s.users[qq] = { name: '', count: 0, failed: 0, last: 0 });
    if (e.nickname) u.name = e.nickname;
    u.count = (u.count || 0) + 1;
    u.last = Math.max(u.last || 0, (e.time || 0) * 1000);
    s.total = (s.total || 0) + 1;
    added++;
  }
  s.approximateSince = since;                            // 运维台据此标「(含估算)」
  saveAiChatStats(s);
  log('AI 闲聊统计回填:', `扫 ${scanned} 条 processed / 计入 ${added} 条(自 ${since} 起,近似)`, C.green);
  for (const [qq, u] of Object.entries(s.users).sort((a, b) => b[1].count - a[1].count).slice(0, 10)) {
    log('  ', `${u.name || '?'}(${qq}) ${u.count} 次`, C.dim);
  }
  process.exit(0);
}

async function processAiChat(entry) {
  const uid = String(entry.user_id);
  const last = aiCooldown.get(uid);
  if (last && Date.now() - last < AI_CHAT_COOLDOWN_MS) {
    log('  AI 闲聊冷却中,本次不回', `${Math.ceil((AI_CHAT_COOLDOWN_MS - (Date.now() - last)) / 1000)}s 后可再问`, C.dim);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  aiCooldown.set(uid, Date.now());
  let ctx = '';
  let names = null;
  if (AI_CHAT_CTX > 0) {
    try {   // 取不到上下文不致命,退化成只按这句话回答
      const { lines, names: n } = await fetchTranscript(entry.group_id, AI_CHAT_CTX);
      if (lines) ctx = `群聊记录(最近 ${AI_CHAT_CTX} 条,格式 "HH:MM 昵称|内容";带「昨天/前天/M-D」前缀的是更早的消息,不是刚发生):\n${lines}\n\n`;      names = n;
    } catch (e) {
      log('  AI 闲聊取上下文失败(改为裸答):', e.message, C.yellow);
    }
  }
  // 消息解析:@某人/引用/表情/图片 → 正文;direct 模式下图片**直接随消息发出去**,一轮出结果
  let q = aiQuestionText(entry);
  let images = [];
  try {
    const rich = await buildAiQuestionRich(entry, {
      botId: BOT_ID,
      log: m => log(' ', m, C.dim),
      getMsg: id => api('get_msg', { message_id: id }),
      memberName: qq => names?.get(Number(qq)) || resolveMemberName(entry.group_id, qq),
    });
    if (rich?.text) q = rich.text;
    images = rich?.images || [];
    if (rich && rich.mode !== 'direct') log(`  图片走 ${rich.mode} 模式`, '', C.dim);
  } catch (e) {
    log('  AI 闲聊消息解析失败(退回纯文本):', e.message, C.yellow);
  }
  q = q.replace(/@你(史官)/g, ' ').replace(/\s+/g, ' ').trim() || '(无文字,仅@)';
  log(`  ${AI_MODEL} 生成中 ...${images.length ? `(含 ${images.length} 张图,一轮出结果)` : ''}`, '', C.dim);
  try {
    let reply = await aiChat(aiSystemPrompt(images.length > 0), `${ctx}@你的人: ${entry.nickname}\nTA 的问题: ${q}`, images);
    if (reply.length > AI_CHAT_MAX_CHARS) reply = reply.slice(0, AI_CHAT_MAX_CHARS) + '……';
    log('  回复:', reply.replace(/\n/g, ' ').slice(0, 60) + (reply.length > 60 ? '...' : ''), C.green);
    await sendReply(entry, reply);
    if (!DRY_RUN) bumpAiChatStat(entry, true);            // 记账:这条回复给了谁
  } catch (e) {
    log('  AI 闲聊失败:', e.message, C.red);
    await sendReply(entry, '史官一时语塞,稍后再问。');
    if (!DRY_RUN) bumpAiChatStat(entry, false);
  }
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 卡库更新(下载 → md5 校验 → 解压 → 原子替换 → 重载) ----------
let updatingDb = false;
// 带超时与重试的 fetch:百鸽那条国际链路握手经常超过 Node 默认的 10 秒连接超时,
// 单发必失败;放宽到 CARDS_FETCH_TIMEOUT_MS 并重试几次才稳。
async function fetchWithRetry(url, label) {
  let lastErr;
  for (let i = 1; i <= CARDS_FETCH_TRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(CARDS_FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      const why = e.name === 'TimeoutError' ? `${CARDS_FETCH_TIMEOUT_MS / 1000} 秒超时` : (e.message || e);
      if (i < CARDS_FETCH_TRIES) {
        log(`  ${label}第 ${i} 次失败(${why}),2 秒后重试 ...`, '', C.yellow);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        log(`  ${label}重试 ${CARDS_FETCH_TRIES} 次均失败(${why})`, '', C.red);
      }
    }
  }
  throw lastErr;
}

async function updateCardDb() {
  if (updatingDb) { log('卡库更新进行中,忽略本次触发', '', C.yellow); return; }
  updatingDb = true;
  try {
    log('卡库更新:下载 cards.zip ...', '', C.cyan);
    const [zipRes, md5Res] = await Promise.all([
      fetchWithRetry(CARDS_ZIP_URL, '卡库下载'),
      // md5 只是参考信息,拿不到不影响更新,所以失败就咽掉
      fetch(CARDS_MD5_URL, { signal: AbortSignal.timeout(CARDS_FETCH_TIMEOUT_MS) }).catch(() => null),
    ]);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    log(`  下载完成 ${(zipBuf.length / 1048576).toFixed(2)} MB,校验中 ...`, '', C.dim);
    if (md5Res?.ok) {
      const remote = (await md5Res.text()).replace(/"/g, '').trim().toLowerCase();
      const local = createHash('md5').update(zipBuf).digest('hex');
      if (remote && local !== remote) {
        // ygocdb 的 md5 端点曾与实际 zip 不同步,仅记录,不作硬校验
        log(`  注意: 远端 md5(${remote})与下载内容不一致(服务器可能未同步),以 JSON 完整性校验为准`, '', C.yellow);
      } else {
        log('  md5 校验通过', '', C.dim);
      }
    }
    const json = extractZipCardJson(zipBuf);         // 解压出 cards.json 文本
    let count;
    try { count = Object.keys(JSON.parse(json)).length; }
    catch { throw new Error('卡库 JSON 损坏,已放弃(旧卡库不受影响)'); }
    if (count < 10000) throw new Error(`卡库数据异常(仅 ${count} 张,期望 ≥10000),已放弃`); // 防截断/错误数据
    const path = getCardsPath();
    const tmp = path + '.tmp';
    writeFileSync(tmp, json, 'utf8');
    renameSync(tmp, path);                           // 原子替换(失败不会损坏旧卡库)
    const n = reloadCards();
    log(`卡库更新完成: ${n} 张卡 → ${path}`, '', C.green);
    // 卡图同步更新:卡库文件已换新,补下载新卡/缺失卡图(已有自动跳过,增量很快)
    try {
      log('卡图更新:下载缺失卡图(跳过已有)...', '', C.cyan);
      const img = await downloadImages();
      log(`卡图更新完成: 新增 ${img.ok} 张, 失败 ${img.fail} 张, 已有 ${img.skipped} 张, 用时 ${img.elapsedSec}s`, '', C.green);
    } catch (e) {
      log('卡图更新失败:', e.message, C.red);   // 不影响卡库本身
    }
  } catch (e) {
    log('卡库更新失败:', e.message, C.red);
  } finally {
    updatingDb = false;
  }
}

// ---------- 发送回复(at 触发者 + 正文;message 可为字符串或消息段数组,如含图片段) ----------
async function sendReply(entry, message) {
  // 兼容三种形态: 字符串(文本) / 段数组(如文本+图片) / 单个段对象(如仅图片)
  const segs = Array.isArray(message)
    ? message
    : typeof message === 'string'
      ? [{ type: 'text', data: { text: '\n' + message } }]
      : [message];
  if (DRY_RUN) {
    const first = segs.find(s => s.type === 'text')?.data?.text || '(图片)';
    log(`  [DRY_RUN] 不发送: ${first.split('\n')[0].slice(0, 50)} ...`, '', C.yellow);
    return;
  }
  const r = await api('send_group_msg', {
    group_id: entry.group_id,
    message: [
      { type: 'at', data: { qq: String(entry.user_id) } },
      ...segs,
    ],
  });
  if (r.status !== 'ok') throw new Error(`发送失败: ${JSON.stringify(r).slice(0, 120)}`);
  log('  已发送', `message_id=${r.data?.message_id}`, C.green);
  return r.data?.message_id;                        // 供反馈机制关联
}

// ---------- 卡牌/卡图查询(纯本地,无 AI) ----------
// 触发:「效果 」/「卡图 」后跟卡名(须带空白,防「效果怪兽」等误触发);返回 { triggered, raw }
function extractCardQuery(entry, trigger = CARD_TRIGGER) {
  const text = (entry.text || '').replace(/\[at\]/g, ' ');   // at 段标记
  const m = text.match(new RegExp(`${trigger}[\\s　]+([\\s\\S]*)`));
  return { triggered: !!m, raw: m ? m[1].trim() : '' };
}

async function processCardQuery(entry, raw) {
  log(`  查卡「${raw}」...`, '', C.dim);
  const reply = queryAndFormat(raw, 5);
  const text = reply
    ? reply
    : `未找到与「${raw}」相关的卡牌。可试试:更完整的卡名,或用空格分隔多个关键词。`;
  log('  回复:', text.split('\n')[0] + (text.includes('\n') ? ' ...' : ''), C.green);
  await sendReply(entry, text);
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 卡图查询(与「效果」同一检索逻辑,只发对应卡图) ----------
async function processCardImageQuery(entry, raw) {
  log(`  查卡图「${raw}」...`, '', C.dim);
  const hit = searchCards(raw, 5)[0];               // 同一套多关键词 AND 打分,取最匹配
  if (!hit) {
    const text = `未找到与「${raw}」相关的卡牌。可试试:更完整的卡名,或用空格分隔多个关键词。`;
    log('  回复:', text.split('\n')[0], C.green);
    await sendReply(entry, text);
  } else {
    const img = cardImageSegment(hit);              // base64:// 图片段;无本地卡图 → 退化为文字说明
    const text = img
      ? ''
      : `「${formatCard(hit).split('\n')[0]}」暂无本地卡图,可用「${CARD_TRIGGER} 」查文字信息。`;
    log('  回复:', img ? `卡图 ${hit.id}.jpg` : text.split('\n')[0], C.green);
    await sendReply(entry, img || text);
  }
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 官方裁定(「裁定 」+卡名 → 百鸽 ygocdb.com 镜像的官方数据库 FAQ+补充说明,日文原文,卡名中文内联) ----------
const rulingCooldown = new Map();   // uid -> 上次触发时间戳(15s 冷却,防刷百鸽)
const RULING_ENTRY_MAX = 2;         // 回复条数上限(百鸽按日期倒序,前几条即最新裁定)
const RULING_ENTRY_CHARS = 1300;    // 单条 Q 或 A 的截断长度,防止超长(部分条目极长)

function formatRulingsReply(hit, r) {
  const cn = hit.cn_name || hit.sc_name || hit.md_name || hit.nwbbs_n || hit.cnocg_n || hit.en_name;
  const jp = hit.jp_name ? `(${hit.jp_name})` : '';
  const cut = (s, n) => s.length > n ? s.slice(0, n) + '…(内容过长,已节选)' : s;
  const lines = [`【裁定】${cn}${jp}`];
  if (r.entries.length) lines.push(`官方数据库相关 Q&A 共 ${r.total} 条,节选相关裁定如下:`);
  else if (r.supplement?.length) lines.push('该卡暂无相关 Q&A 条目,官方数据库补充说明如下:');
  r.entries.forEach((e, i) => {
    lines.push(`\n${i + 1}. ${e.date ? `(${e.date}) ` : ''}Q: ${cut(e.q, RULING_ENTRY_CHARS)}`);
    if (e.a) lines.push(`A: ${cut(e.a, RULING_ENTRY_CHARS)}`);
  });
  (r.supplement || []).forEach((s, i) => {
    lines.push(`\n补充说明${r.supplement.length > 1 ? ` ${i + 1}` : ''}${s.date ? `(${s.date})` : ''}:\n${cut(s.a || '', RULING_ENTRY_CHARS)}`);
  });
  return lines.join('\n');
}

async function processRulings(entry, raw) {
  const uid = String(entry.user_id);
  const last = rulingCooldown.get(uid);
  if (last && Date.now() - last < 15000) {
    await sendReply(entry, `${RULING_TRIGGER}冷却中,${Math.ceil((15000 - (Date.now() - last)) / 1000)} 秒后再试。`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  rulingCooldown.set(uid, Date.now());
  log(`  查裁定「${raw}」...`, '', C.dim);
  const hit = searchCards(raw, 5)[0];
  if (!hit) {
    const text = `未找到与「${raw}」相关的卡牌。可试试:更完整的卡名,或用空格分隔多个关键词。`;
    log('  回复:', text.split('\n')[0], C.green);
    await sendReply(entry, text);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  try {
    const r = await fetchCardRulings(hit, RULING_ENTRY_MAX);
    log(`  官裁: id=${hit.id} ${r.status} 共 ${r.total} 条${r.fromCache ? '(缓存)' : ''}`, '', C.dim);
    if (r.status === 'ok') {
      const text = formatRulingsReply(hit, r);
      log('  回复:', text.split('\n')[0] + ` +${r.entries.length}条裁定`, C.green);
      await sendReply(entry, text);
    } else if (r.status === 'no-faq') {
      await sendReply(entry, `官方数据库暂无「${formatCard(hit).split('\n')[0]}」的相关 Q&A 条目。`);
    } else if (r.status === 'unlisted') {
      await sendReply(entry, `「${formatCard(hit).split('\n')[0]}」未被官方数据库收录,查不到官方裁定。`);
    } else {
      log('  官裁失败:', r.error || '', C.red);
      await sendReply(entry, `${RULING_TRIGGER}查询失败(百鸽暂不可达),稍后再试。`);
    }
  } catch (e) {
    log('  官裁失败:', e.message, C.red);
    await sendReply(entry, `${RULING_TRIGGER}查询失败,稍后再试。`);
  }
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 完整裁定(「完整裁定 」+卡名 → 百鸽卡页该卡全部相关 Q&A+补充说明 → 多页 PDF 上传群文件) ----------
// 内容口径(用户 2026-09-08 定稿):百鸽(镜像官方库)上有啥发啥,不做直接命中过滤、不截断;
// 补充说明(卡效果补足説明)用户 2026-09-08 要求一并填充,PDF 里置于相关 Q&A 之前
const rulingFullCooldown = new Map();   // uid -> 上次触发时间戳(30s 冷却,生成+上传较耗时防刷)

async function processFullRulings(entry, raw) {
  const uid = String(entry.user_id);
  const last = rulingFullCooldown.get(uid);
  if (last && Date.now() - last < 30000) {
    await sendReply(entry, `${RULING_FULL_TRIGGER}冷却中,${Math.ceil((30000 - (Date.now() - last)) / 1000)} 秒后再试。`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  rulingFullCooldown.set(uid, Date.now());
  log(`  查完整裁定「${raw}」...`, '', C.dim);
  const hit = searchCards(raw, 5)[0];
  if (!hit) {
    const text = `未找到与「${raw}」相关的卡牌。可试试:更完整的卡名,或用空格分隔多个关键词。`;
    log('  回复:', text.split('\n')[0], C.green);
    await sendReply(entry, text);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  try {
    const full = await fetchFullRulings(hit);
    log(`  完整裁定: id=${hit.id} ${full.status} Q&A ${full.total} 条 / 补充说明 ${full.supplement?.length ?? 0} 条${full.fromCache ? '(缓存)' : ''}`, '', C.dim);
    if (full.status === 'error') throw new Error(full.error || '百鸽不可达');
    if (!full.entries.length && !full.supplement?.length) {
      await sendReply(entry, `官方数据库暂无「${formatCard(hit).split('\n')[0]}」的相关 Q&A 与补充说明,不发文件。`);
      appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
      return;
    }
    const r = await buildRulingsPdf(hit, full.entries, full.total, full.supplement ?? []);
    const cn = hit.cn_name || hit.sc_name || hit.md_name || hit.nwbbs_n || hit.cnocg_n || hit.en_name;
    await sendReply(entry, `【${cn}】的完整裁定如下`);          // 第一条消息:@提问者 + 提示语
    if (DRY_RUN) {
      log('  [DRY_RUN] 不上传群文件:', basename(r.path), C.yellow);
      appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
      return;
    }
    const name = basename(r.path);                             // 完整裁定_卡名_YYYYMMDD.pdf
    const up = await api('upload_group_file', { group_id: entry.group_id, file: r.path, name });
    if (up.status !== 'ok') throw new Error(`群文件上传失败: ${JSON.stringify(up).slice(0, 120)}`);
    log('  已上传群文件', `${name} (${(r.bytes / 1024).toFixed(0)}KB, Q&A ${full.entries.length} 条 + 补充说明 ${full.supplement?.length ?? 0} 条)`, C.green);
  } catch (e) {
    log('  完整裁定失败:', e.message, C.red);
    await sendReply(entry, '完整裁定生成失败,稍后再试。');
  }
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 每日一卡(同 id 当日重复申请返回同一张,每日 0 点刷新) ----------
// 本地时区日期字符串作为「当日」键
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function loadDailyState() {
  try { return JSON.parse(readFileSync(DAILY_STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveDailyState(st) {
  writeFileSync(DAILY_STATE_FILE + '.tmp', JSON.stringify(st), 'utf8');
  renameSync(DAILY_STATE_FILE + '.tmp', DAILY_STATE_FILE);
}
async function processDailyCard(entry) {
  const st = loadDailyState();
  const cards = loadCards();
  const uid = String(entry.user_id);
  const today = dayKey();
  const prev = st[uid];
  let cid = null;
  // 同一自然日返回同卡;过 0 点(或卡库更新后旧卡不存在) → 重抽
  if (prev && prev.day === today && cards[prev.cid]) cid = prev.cid;
  const fresh = !cid;
  if (fresh) {
    const ids = Object.keys(cards);
    cid = ids[Math.floor(Math.random() * ids.length)];
    st[uid] = { day: today, cid };
    saveDailyState(st);
  }
  const header = fresh ? '【每日一卡】今日之卡:' : '【每日一卡】今日还是这张:';
  const text = `${header}\n${formatCard(cards[cid])}`;
  const segs = [{ type: 'text', data: { text: '\n' + text } }];
  const img = cardImageSegment(cards[cid]);         // 先文字后卡图;无本地卡图则纯文字
  if (img) segs.push(img);
  log('  回复:', (fresh ? '新卡 ' : '同卡 ') + text.split('\n')[1].slice(0, 40) + (img ? ' +卡图' : ''), C.green);
  await sendReply(entry, segs);
}

// ---------- 生成卡表(ydk文本/卡组码/分享链接 → 官方版式 PDF 卡表,上传群文件) ----------
// 官方赛事(巡回赛/WCQ)要求赛前提交纸质卡表;生成后端见 ygocard/decklist.mjs
// (神人科技 https://ygo.xyk.one/deck/ 与官方空白表同版式同源底图,卡名为官方简体中文全称)。
// 回复约定(用户 2026-09-07 定调):生成并上传成功 → 不回复任何文字;失败 → 只回简短「生成失败」。
async function processDeckList(entry, raw) {
  const text = (raw || '').replace(/\[at\]/g, ' ').trim();
  if (!text) { // 只有「生成卡表 」没内容 → 一行用法
    await sendReply(entry, `${DECK_TRIGGER} + YDK文本/卡组码/分享链接`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const cls = classifyDeckInput(text);
  if (!cls) {
    await sendReply(entry, '生成失败');
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  try {
    log(`  生成卡表 PDF ...(${cls.kind === 'link' ? '链接' : 'ydk'})`, '', C.dim);
    const r = await generateDeckListPdf({ raw: text });
    if (DRY_RUN) {
      log('  [DRY_RUN] 不上传群文件:', r.path, C.yellow);
      return;
    }
    const name = `卡表_${dayKey().replace(/-/g, '')}.pdf`;
    const up = await api('upload_group_file', { group_id: entry.group_id, file: r.path, name });
    if (up.status !== 'ok') throw new Error(`群文件上传失败: ${JSON.stringify(up).slice(0, 120)}`);
    log('  已上传群文件', `${name} (${(r.bytes / 1024).toFixed(0)}KB, file_id=${up.data?.file_id})`, C.green);
    // 成功不回复文字(文件即答案)
  } catch (e) {
    log('  卡表生成失败:', e.message, C.red);
    await sendReply(entry, '生成失败');
  }
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 框神语录(从精筛语录库随机抽一条;库空则先回填) ----------
async function processKuangShen(entry) {
  let q = pickFeaturedQuote();
  if (!q) {
    log('  语录库为空,尝试回填历史 ...', '', C.dim);
    try {
      const r = await backfillQuotes(20);
      log(`  回填: 翻 ${r.pages} 页 / 新增 ${r.added} 条`, '', C.dim);
      q = pickFeaturedQuote();
    } catch (e) { log('  回填失败:', e.message, C.red); }
  }
  if (!q) {
    await sendReply(entry, '语录库还是空的,改日再来。');
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const d = q.time ? new Date(q.time * 1000).toISOString().slice(5, 16) : '';
  const text = `【框神语录】\n“${q.text}”${d ? `\n—— ${d}` : ''}`;
  log('  回复:', q.text.replace(/\n/g, ' ').slice(0, 50), C.green);
  const mid = await sendReply(entry, text);
  if (mid) rememberQuoteSent(mid, entry.group_id, q);   // 登记待挥手反馈
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 框神语录关键词检索(「框神语录 」+ 关键词,空格分隔 AND 匹配) ----------
async function processKuangShenSearch(entry, raw) {
  const kws = raw.split(/[\s　]+/).filter(Boolean);
  if (!kws.length) return processKuangShen(entry);      // 只有「框神语录 」→ 退回随机抽
  const hits = searchQuotes(kws);
  if (!hits.length) {
    await sendReply(entry, `没找到同时含「${kws.join('」「')}」的语录,换几个关键词试试。`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const q = hits[Math.floor(Math.random() * hits.length)];
  const d = q.time ? new Date(q.time * 1000).toISOString().slice(5, 16) : '';
  log('  检索命中:', `${hits.length} 条,示例: ${q.text.replace(/\n/g, ' ').slice(0, 50)}`, C.green);
  const mid = await sendReply(entry, `【框神语录】\n“${q.text}”${d ? `\n—— ${d}` : ''}`);
  if (mid) rememberQuoteSent(mid, entry.group_id, q);   // 检索结果同样支持挥手负反馈
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 随机一搬 / 精选一搬(B站热评截图,纯规则 / AI 精挑) ----------
const shitCooldown = new Map();   // uid -> 上次触发时间戳(30s 冷却防刷屏)

// 读取搬屎记忆样本库(用户投喂的优质屎),供精筛作参考成色
function loadShitExamples() {
  try {
    const text = readFileSync(SHIT_EXAMPLES_PATH, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^-\s*评论[:：]\s*(.+)$/);
      if (m && m[1].trim()) out.push(m[1].trim());
    }
    return out;
  } catch { return []; }
}

// AI 精挑:把候选列表给 claude,让它选最有梗的一条(只回序号)
function claudePickShit(candidates) {
  const list = candidates.map((x, i) =>
    `#${i} | 视频《${x.v.title.slice(0, 30)}》 | ${x.c.member?.uname || '?'} (赞${x.c.like}/回${x.c.rcount || 0}) | ${(x.c.content?.message || '').replace(/\n/g, ' ').slice(0, 90)}`
  ).join('\n');
  const examples = loadShitExamples();
  const exampleBlock = examples.length
    ? `\n参考样本(你认可的优质屎,候选的成色/风格要接近这些):
${examples.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n`
    : '';
  const prompt = `你是B站评论区"屎学家",专门挑选值得搬运的"屎"——最有梗、最逆天、最有引战乐子的评论。${exampleBlock}
候选热评(格式: #序号 | 视频 | 评论者(赞/回复) | 内容):
${list}

规则:
- 只选 1 条: 最有梗 / 最逆天 / 最有引战乐子${examples.length ? ',成色接近参考样本' : ''}
- 排除: 普通科普、纯吹捧、无信息吐槽、大段道理、粉丝向小作文
- 只回复一个序号数字,不要任何其他内容`;
  return runClaude(prompt).then(reply => {
    const m = String(reply || '').match(/\d+/);
    return m ? candidates[Number(m[0])] || null : null;
  }).catch(() => null);
}

async function processShitPost(entry, ai) {
  const uid = String(entry.user_id);
  const last = shitCooldown.get(uid);
  if (last && Date.now() - last < 30000) {
    await sendReply(entry, `${ai ? SHIT_AI_TRIGGER : SHIT_TRIGGER}冷却中,${Math.ceil((30000 - (Date.now() - last)) / 1000)} 秒后再试。`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  shitCooldown.set(uid, Date.now());
  try {
    let png, bvid = null, title = '';
    if (ai) {
      log('  抓屎(AI 精挑)...', '', C.dim);
      const shit = await pickShit('ai', claudePickShit);
      png = await renderCard(buildCardHtml(shit, '精选一搬'));   // 评论截图
      bvid = shit.v.bvid; title = shit.v.title;
      log('  回复:', `屎截图 ${png} (${shit.s.toFixed(1)}分)`, C.green);
    } else {
      log('  随机屎视频 ...', '', C.dim);
      const { v } = await pickVideoShit();                       // 源库随机抽视频
      png = await renderCard(buildVideoCardHtml(v, '随机一搬')); // 封面截图
      bvid = v.bvid; title = v.title;
      log('  回复:', `视频封面 ${v.bvid} (${v.title.slice(0, 30)})`, C.green);
    }
    const mid = await sendReply(entry, [pngToSegment(png)]);      // 只发截图(图上含全部信息)
    if (mid && bvid) rememberShitSent(mid, entry.group_id, { bvid, title });
  } catch (e) {
    log('  抓屎失败:', e.message, C.red);
    await sendReply(entry, '今日无屎可搬,改日再来。');
  }
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 搬屎反馈:表情回应点赞 ≥2 人 → 自动入库种子库 ----------
const SHIT_PENDING_FILE = join(__dirname, 'shitpost', 'pending.json');
const SHIT_VOTE_THRESHOLD = 1;                 // 不同用户点赞数达此值入库
const SHIT_FEEDBACK_WINDOW = 24 * 3600 * 1000; // 搬屎后 24h 内有效,过期清理
const SHIT_WAVE_EMOJI_ID = process.env.SHIT_WAVE_EMOJI_ID || '129'; // 👋 挥手 = 负反馈

function loadPendingShits() {
  try {
    const list = JSON.parse(readFileSync(SHIT_PENDING_FILE, 'utf8'));
    const now = Date.now();
    return Array.isArray(list) ? list.filter(p => now - p.time < SHIT_FEEDBACK_WINDOW) : [];
  } catch { return []; }
}
function savePendingShits(list) {
  writeFileSync(SHIT_PENDING_FILE + '.tmp', JSON.stringify(list), 'utf8');
  renameSync(SHIT_PENDING_FILE + '.tmp', SHIT_PENDING_FILE);
}
// 搬屎发出后记录待反馈条目
function rememberShitSent(messageId, groupId, video) {
  const pending = loadPendingShits();
  pending.push({ message_id: messageId, group_id: groupId, video, voters: [], time: Date.now() });
  savePendingShits(pending);
  log('  反馈登记:', `待点赞反馈 ${video.title.slice(0, 30)} (mid=${messageId})`, C.dim);
}

// ---------- 框神语录反馈:挥手 👋 → 语录进黑名单并从库中删除 ----------
const QUOTE_PENDING_FILE = join(__dirname, 'kuangshen', 'pending.json');
const QUOTE_FEEDBACK_WINDOW = 24 * 3600 * 1000;                 // 发出后 24h 内有效
const QUOTE_WAVE_EMOJI_ID = process.env.KUANGSHEN_WAVE_EMOJI_ID || '129'; // 👋 挥手 = 负反馈

function loadPendingQuotes() {
  try {
    const list = JSON.parse(readFileSync(QUOTE_PENDING_FILE, 'utf8'));
    const now = Date.now();
    return Array.isArray(list) ? list.filter(p => now - p.time < QUOTE_FEEDBACK_WINDOW) : [];
  } catch { return []; }
}
function savePendingQuotes(list) {
  writeFileSync(QUOTE_PENDING_FILE + '.tmp', JSON.stringify(list), 'utf8');
  renameSync(QUOTE_PENDING_FILE + '.tmp', QUOTE_PENDING_FILE);
}
// 语录发出后记录待反馈条目(DRY_RUN 不发消息,mid 为空自然不记)
function rememberQuoteSent(messageId, groupId, quote) {
  if (!messageId) return;
  const pending = loadPendingQuotes();
  pending.push({ message_id: messageId, group_id: groupId, seq: quote.seq, text: quote.text, time: Date.now() });
  savePendingQuotes(pending);
  log('  反馈登记:', `待挥手反馈「${quote.text.replace(/\n/g, ' ').slice(0, 20)}」(seq=${quote.seq})`, C.dim);
}

// WS 表情回应事件(notice_type=group_msg_emoji_like)
// 挥手 👋(emoji 129)= 负反馈 → 屎视频黑名单+移出源库 / 语录黑名单+删库;其他表情 = 搬屎正反馈投票
function handleEmojiLike(j) {
  const pid = j.message_id ?? j.message_seq;
  const uid = String(j.operator_id ?? j.user_id);
  if (!pid || String(uid) === BOT_ID) return;
  const likes = (j.likes || []).map(x => String(x.emoji_id));
  // ① 搬屎待反馈
  const pending = loadPendingShits();
  const hit = pending.find(p => p.message_id === pid || p.message_seq === pid);
  if (hit) {
    pending.splice(pending.indexOf(hit), 1);               // 无论正负反馈,先移出待反馈
    if (likes.includes(SHIT_WAVE_EMOJI_ID)) {              // 👋 负反馈
      savePendingShits(pending);
      const br = addToBlacklist(hit.video);
      const removed = removeFromShitVideos(hit.video.bvid);
      log('🖐 负反馈黑名单:', `${br}「${hit.video.title.slice(0, 30)}」${removed ? '(已移出源库)' : '(不在源库)'}`, C.red);
      return;
    }
    if (!hit.voters.includes(uid)) hit.voters.push(uid);   // 每用户一票
    if (hit.voters.length < SHIT_VOTE_THRESHOLD) { savePendingShits(pending); return; }
    savePendingShits(pending);
    const r = appendShitVideo(hit.video);
    log('📥 反馈入库:', `${r}「${hit.video.title.slice(0, 30)}」(${hit.voters.length}人点赞)`, C.green);
    return;
  }
  // ② 框神语录待反馈(挥手 = 该语录进黑名单并从语录库删除)
  if (!FEAT.kuangshen) return;   // 功能关闭/暂停,不再处理语录反馈
  const qp = loadPendingQuotes();
  const qhit = qp.find(p => p.message_id === pid || p.message_seq === pid);
  if (!qhit) return;
  qp.splice(qp.indexOf(qhit), 1);                          // 一次反馈后关闭窗口
  if (!likes.includes(QUOTE_WAVE_EMOJI_ID)) { savePendingQuotes(qp); return; }
  savePendingQuotes(qp);
  const br = quoteBlacklist(qhit.seq, qhit.text);
  const removed = removeQuoteBySeq(qhit.seq);
  log('🖐 语录黑名单:', `${br}「${qhit.text.replace(/\n/g, ' ').slice(0, 30)}」${removed ? '(已删出语录库)' : '(不在库中)'}`, C.red);
}

// ---------- 热开关面板(控制台总控,免重启) ----------
// 1/2 = 副功能总开关(搬屎/框神语录);h = 重画面板;状态持久化 features.json
function featOnText(on) {
  return `${on ? C.green : C.red}${on ? 'ON' : 'OFF'}${C.reset}`;
}
function drawFeaturePanel() {
  const line1 = `── 功能面板 ─ ${featOnText(FEAT.shitpost)} 1搬屎 | ${featOnText(FEAT.kuangshen)} 2框神语录 | ${featOnText(FEAT.ai)} 3AI闲聊`;
  const line2 = `${C.dim}  1/2/3=切开关 h=重画 q=退出 Q=退出+停SnowLuma u=更新卡库${C.reset}`;
  console.log(`\n${line1}\n${line2}`);
}
function toggleFeature(key) {
  FEAT[key] = !FEAT[key];
  saveFeatures();
  const label = key === 'shitpost' ? '搬屎' : key === 'kuangshen' ? '框神语录' : 'AI 闲聊';
  log('功能开关:', `${label} → ${FEAT[key] ? 'ON' : 'OFF'}(已持久化 features.json)`, C.cyan);
  drawFeaturePanel();
}

// ---------- 帮助(最简洁的功能介绍;以「/help」或「帮助」开头的消息触发) ----------
function isHelpRequest(text) {
  const clean = (text || '').replace(/\[at\]/g, ' ').trim();
  return /^(?:\/help|帮助)/i.test(clean);
}
function buildHelpText() {
  const shit = FEAT.shitpost
    ? `\n${SHIT_TRIGGER} — 随机搬一条史(封面截图)`   // AI 精选一搬未完善,暂不展示
    : '';
  const kuangshen = FEAT.kuangshen
    ? `\n${KUANGSHEN_TRIGGER} — 随机一条kkkm语录;\n${KUANGSHEN_TRIGGER} [关键词] — 按关键词检索语录`
    : '';
  const ai = FEAT.ai
    ? `\n\n没写指令也没关系 —— 随便 @ 我说点什么,史官直接接话(带图带表情包也认得出,引用别人的话我也看得见)。`
    : '';
  return `【赛博史官·使用说明】@我 + 以下指令即可。

${TRIGGER_KEYWORD} — 以史记体文言文总结最近群聊
${DAILY_KEYWORD} — 抽今日之卡
${DECK_TRIGGER} [卡组内容（ydk文本/卡组码/分享链接）] — 生成巡回赛PDF卡表
${CARD_TRIGGER} [卡名] — 查卡牌效果，如「${CARD_TRIGGER} 青眼白龙」
${CARD_IMG_TRIGGER} [卡名] — 查卡图，如「${CARD_IMG_TRIGGER} 青眼白龙」
${RULING_TRIGGER} [卡名] — 查官方裁定，返回部分
${RULING_FULL_TRIGGER} [卡名] — 查完整裁定${kuangshen}${shit}${ai}`;
}

// ---------- 处理单个请求 ----------
async function processEntry(entry) {
  const text = entry.text || '';
  if (isHelpRequest(text)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [帮助]`, C.cyan);
    await sendReply(entry, buildHelpText());
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  if (text.includes(TRIGGER_KEYWORD)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [史记总结]`, C.cyan);
    return processHistory(entry);
  }
  if (text.includes(DAILY_KEYWORD)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [每日一卡]`, C.cyan);
    await processDailyCard(entry);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const deckQuery = extractCardQuery(entry, DECK_TRIGGER);   // 「生成卡表 」+ ydk/卡组码/链接
  if (deckQuery.triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [生成卡表]`, C.cyan);
    await processDeckList(entry, deckQuery.raw);
    return;
  }
  if (FEAT.kuangshen && text.includes(KUANGSHEN_TRIGGER)) {
    const { triggered, raw } = extractCardQuery(entry, KUANGSHEN_TRIGGER);  // 「框神语录 」+空格 → 关键词检索
    if (triggered) {
      log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [框神语录检索: ${raw.slice(0, 30)}]`, C.cyan);
      await processKuangShenSearch(entry, raw);
    } else {
      log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [框神语录]`, C.cyan);
      await processKuangShen(entry);
    }
    return;
  }
  if (FEAT.shitpost && text.includes(SHIT_AI_TRIGGER)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [精选一搬]`, C.cyan);
    await processShitPost(entry, true);
    return;
  }
  if (FEAT.shitpost && text.includes(SHIT_TRIGGER)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [随机一搬]`, C.cyan);
    await processShitPost(entry, false);
    return;
  }
  const { triggered, raw } = extractCardQuery(entry);
  if (triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [卡牌查询]`, C.cyan);
    if (!raw) {                                   // 只有「效果 」没卡名 → 教用法
      const text = `用法:@我 然后说「${CARD_TRIGGER} 」+卡名,如「${CARD_TRIGGER} 青眼白龙」;多个关键词用空格分隔。`;
      await sendReply(entry, text);
    } else {
      await processCardQuery(entry, raw);         // 内部会写 processed
    }
    return;
  }
  const imgQuery = extractCardQuery(entry, CARD_IMG_TRIGGER);
  if (imgQuery.triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [卡图查询]`, C.cyan);
    if (!imgQuery.raw) {                          // 只有「卡图 」没卡名 → 教用法
      const text = `用法:@我 然后说「${CARD_IMG_TRIGGER} 」+卡名,如「${CARD_IMG_TRIGGER} 青眼白龙」;多个关键词用空格分隔。`;
      await sendReply(entry, text);
    } else {
      await processCardImageQuery(entry, imgQuery.raw);
    }
    return;
  }
  if (text.includes(RULING_FULL_TRIGGER)) {                     // 完整裁定(须在普通「裁定」分支前,否则被其先匹配)
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [完整裁定PDF]`, C.cyan);
    const { raw } = extractCardQuery(entry, RULING_FULL_TRIGGER);
    if (!raw) {
      const t = `用法:@我 然后说「${RULING_FULL_TRIGGER} 」+卡名,如「${RULING_FULL_TRIGGER} 增殖的G」,生成完整裁定 PDF 发到群文件。`;
      await sendReply(entry, t);
      appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    } else {
      await processFullRulings(entry, raw);
    }
    return;
  }
  const rulingQuery = extractCardQuery(entry, RULING_TRIGGER);
  if (rulingQuery.triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [裁定查询]`, C.cyan);
    if (!rulingQuery.raw) {                       // 只有「裁定 」没卡名 → 教用法
      const text = `用法:@我 然后说「${RULING_TRIGGER} 」+卡名,如「${RULING_TRIGGER} 青眼白龙」;多个关键词用空格分隔。`;
      await sendReply(entry, text);
    } else {
      await processRulings(entry, rulingQuery.raw);
    }
    return;
  }
  // 兜底:没命中任何指令的 @ → 交给 AI 闲聊(面板 3 键 / opsweb 可热关)
  if (FEAT.ai && AI_API_KEY) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [AI 闲聊]`, C.cyan);
    await processAiChat(entry);
    return;
  }
  const shitTriggers = FEAT.shitpost ? ` / "${SHIT_TRIGGER}" / "${SHIT_AI_TRIGGER}"` : '';
  log('⏭ 跳过', `seq=${entry.seq} @${entry.nickname} 无触发词("${TRIGGER_KEYWORD}" / "${DAILY_KEYWORD}"${shitTriggers} / "${CARD_TRIGGER} " / "${CARD_IMG_TRIGGER} " / "${RULING_TRIGGER} "): ${text.slice(0, 30)}`, C.dim);
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

async function processHistory(entry) {
  const { lines: transcript, names } = await fetchTranscript(entry.group_id, 100);
  if (!transcript) throw new Error('无消息历史');
  // 目标指定:把 @ 对象 qq 映射为昵称,交给 claude 聚焦
  if (entry.targets?.length) {
    entry.targetNames = entry.targets.map(q => names.get(q) || `成员${q}`);
  }
  const prompt = buildPrompt(transcript, entry);
  log('  claude 生成中 ...', '', C.dim);
  const reply = await runClaude(prompt);
  log('  回复:', reply.slice(0, 60) + (reply.length > 60 ? '...' : ''), C.green);
  await sendReply(entry, reply);
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 处理循环 ----------
async function processQueue() {
  if (processing) return;
  const pending = [];
  if (existsSync(INBOX)) {
    for (const line of readFileSync(INBOX, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (processedSeen.has(entry.seq)) continue;
      if (!(entry.text || '').trim()) {
        processedSeen.add(entry.seq); // 纯@ 无文字,忽略
        continue;
      }
      pending.push(entry);
    }
  }
  if (!pending.length) return;
  processing = true;
  for (const entry of pending.sort((a, b) => a.seq - b.seq)) {
    try {
      await processEntry(entry);
      processedSeen.add(entry.seq);
    } catch (e) {
      log('✗ 失败:', e.message, C.red);
      log('  稍后重试(不标记为已处理)', '', C.dim);
      break; // 失败即停,避免连环失败
    }
  }
  processing = false;
}

// ---------- 退出 ----------
async function shutdown(stopSnowLuma) {
  log('正在退出 ...', '', C.yellow);
  for (const pid of claudeChildren) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  try { ws?.close(); } catch {}
  if (stopSnowLuma) {
    // Windows: 按端口 3000 找进程 taskkill;Linux: env SNOWLUMA_STOP_CMD 覆盖(默认 docker stop)
    log(`停止 SnowLuma ${process.platform === 'win32' ? '(端口 3000)' : ''} ...`, '', C.yellow);
    try {
      const { execSync } = await import('node:child_process');
      const cmd = process.env.SNOWLUMA_STOP_CMD || (process.platform === 'win32'
        ? 'for /f "tokens=5" %a in (\'netstat -ano ^| findstr ":3000 .*LISTENING"\') do taskkill /PID %a /F'
        : 'docker stop snowluma');
      execSync(cmd, { shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', stdio: 'ignore' });
    } catch {}
  }
  log('已停止。再见!', '', C.green);
  process.exit(0);
}

// ---------- 键盘 ----------
const claudeChildren = new Set();
let ws = null;
let processing = false;
const seen = loadSeen();
const processedSeen = loadProcessed();

try { // 仅终端下启用按键(后台/管道运行无 tty,跳过)
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    const k = String(str || '');
    if (k === '1') toggleFeature('shitpost');      // 1 = 搬屎总开关
    else if (k === '2') toggleFeature('kuangshen');// 2 = 框神语录总开关
    else if (k === '3') toggleFeature('ai');       // 3 = AI 闲聊总开关
    else if (k === 'h' || k === 'H') drawFeaturePanel();     // h = 重画功能面板
    else if (key.name === 'q') {
      if (key.shift) shutdown(true);     // Q = 退出 + 停 SnowLuma
      else shutdown(false);              // q = 仅退出
    } else if (key.name === 'u') {
      updateCardDb();                    // u = 更新卡牌数据库
    } else if (key.ctrl && key.name === 'c') {
      shutdown(false);
    }
  });
  process.stdin.resume();
} catch {
  log('非终端模式,按键控制不可用', '', C.dim);
}

// ---------- WS 监听 ----------
// groupLastSeen: 每群最后见过的 seq,用于断线后补漏;wsWasDown: 断线标志
const groupLastSeen = new Map();
let wsWasDown = false;

// 事件 → inbox 条目(统一入口,负责 seen 去重);重复/无效返回 null
function makeEntry(j) {
  const seq = j.message_seq ?? j.message_id;
  if (!seq || seen.has(seq)) return null;
  seen.add(seq);
  // 目标指定:消息中同时@了其他人 → 收集为 targets(不含机器人自身)
  const targets = (j.message || [])
    .filter(s => s.type === 'at' && String(s.data?.qq) !== BOT_ID)
    .map(s => String(s.data.qq));
  const allText = (j.message || []).map(s => s.type === 'text' ? s.data.text : `[${s.type}]`).join('');
  // 常规消息截 200;含「生成卡表」的消息可能带完整 ydk 文本/卡组码,放宽到 8000
  const text = (allText.length > 200 && allText.includes(DECK_TRIGGER)) ? allText.slice(0, 8000) : allText.slice(0, 200);
  // 裁剪后的消息段:给 AI 闲聊还原 @某人 / 引用 / QQ 表情 / 图片用(见 aichat.mjs)。
  // text 把什么都压成 [at]/[image] 占位符,认不出是谁、哪张图,所以另存一份原始段。
  // 图片 url 带 rkey、会过期,过期就当没图(描述退化成「没能识别」,不影响其它部分)。
  const segs = (j.message || []).map(s => {
    const d = s.data || {};
    switch (s.type) {
      case 'text': return { type: 'text', text: d.text ?? '' };
      case 'at': return { type: 'at', qq: String(d.qq ?? '') };
      case 'face': return { type: 'face', id: String(d.id ?? '') };
      case 'image': return { type: 'image', url: d.url || '', file: d.file || '', summary: d.summary || '', sub: d.sub_type ?? 0 };
      case 'mface': return { type: 'mface', url: d.url || '', emoji_id: d.emoji_id || '', summary: d.summary || '' };
      case 'reply': return { type: 'reply', id: String(d.id ?? '') };
      default: return { type: s.type };
    }
  });
  return {
    seq,
    message_id: j.message_id,
    time: j.time || Math.floor(Date.now() / 1000),
    group_id: j.group_id,
    group_name: j.group_name || '',
    user_id: j.user_id,
    nickname: j.sender?.card || j.sender?.nickname || String(j.user_id),
    text,
    segs: segs.length ? segs : undefined,
    targets: targets.length ? [...new Set(targets)] : undefined,
  };
}

// 补漏:启动时与断线重连后都会执行,对每个已知群拉历史,
// 把离线期间 @bot 但没收到的消息补写 inbox(仅补 2 分钟内的,防回补旧消息刷屏)。
async function catchUpMissed() {
  const why = wsWasDown ? '断线重连' : '启动';
  wsWasDown = false;
  log(`WS ${why},补收 2 分钟内错过的 @消息 ...`, '', C.cyan);
  const groups = [...groupLastSeen.keys()];
  try { // 也覆盖从未实时收到过消息的群
    const { data } = await api('get_group_list');
    for (const g of (data || [])) {
      if (!groups.includes(g.group_id)) groups.push(g.group_id);
    }
  } catch {}
  const cutoff = Math.floor(Date.now() / 1000) - 120; // 只补最近 2 分钟
  let missed = 0;
  for (const gid of groups) {
    const lastSeq = groupLastSeen.get(gid);
    try {
      const { data } = await api('get_group_msg_history', { group_id: gid, count: 100 });
      for (const m of (data?.messages || [])) { // API 返回最新在前
        const seq = m.message_seq ?? m.message_id;
        if (lastSeq !== undefined && seq === lastSeq) break; // 已见过的最后一条,再往前都是旧的
        if ((m.time || 0) < cutoff) continue;
        if (!isMentioningBot(m)) continue;
        const entry = makeEntry(m);
        if (!entry) continue;
        appendFileSync(INBOX, JSON.stringify(entry) + '\n');
        missed++;
        log(`  ↺ 补收 [${entry.group_name || gid}] ${entry.nickname}: ${entry.text.slice(0, 40)}`, '', C.cyan);
      }
    } catch (e) {
      log(`  补漏失败 group=${gid}: ${e.message}`, '', C.red);
    }
  }
  log(`补漏完成,补收 ${missed} 条`, missed ? C.green : C.dim);
  if (missed) processQueue(); // 补收到的直接进处理队列
  if (FEAT.kuangshen) {
    // 框神语录增量回填:覆盖 monitor 离线期间漏收的发言(遇库内已知 seq 即停,通常 1-2 页)
    backfillQuotes(10).then(r => {
      if (r.added) log('框神语录回填:', `+${r.added} 条 (翻 ${r.pages} 页)`, C.dim);
    }).catch(e => log('框神语录回填失败:', e.message, C.red));
  }
}

function connect() {
  ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${WS_TOKEN}` } });
  let delay = RECONNECT_BASE_MS;
  ws.onopen = () => {
    delay = RECONNECT_BASE_MS;
    log('WS 已连接,等待 @消息 ... (q=退出 Q=退出并停SnowLuma)', '', C.green);
    catchUpMissed();
  };
  ws.onmessage = (ev) => {
    let j;
    try { j = JSON.parse(String(ev.data)); } catch { return; }
    if (j.post_type === 'notice' && j.notice_type === 'group_msg_emoji_like') {
      handleEmojiLike(j);                                 // 表情反馈:搬屎点赞→入库 / 挥手→黑名单(屎视频+框神语录)
      return;
    }
    if (j.post_type === 'message') {
      // 框神语录实时采集:在 @过滤之前捕获该群该用户的全部发言(不 @ 也入库)
      if (FEAT.kuangshen) {
        try {
          const q = collectQuoteFromEvent(j);
          if (q) log('📝 框神语录入库:', q.text.replace(/\n/g, ' ').slice(0, 40), C.dim);
        } catch (e) { log('框神语录入库失败:', e.message, C.red); }
      }
    }
    if (j.post_type !== 'message' || !isMentioningBot(j)) return;
    const seq = j.message_seq ?? j.message_id;
    if (!seq) return;
    groupLastSeen.set(j.group_id, seq);
    const entry = makeEntry(j);
    if (!entry) return;
    appendFileSync(INBOX, JSON.stringify(entry) + '\n');
    log(`★ @请求 [${entry.group_name}] ${entry.nickname}: ${entry.text.slice(0, 40)}`, '', C.cyan);
    processQueue(); // 立即处理
  };
  ws.onclose = () => {
    wsWasDown = true; // 标记断线,重连成功后触发补漏(仅 2 分钟内)
    log(`连接断开,${delay / 1000}s 后重连 ...`, '', C.yellow);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30000);
  };
  ws.onerror = (e) => log('WS 错误:', e.message || e, C.red);
}
// 启动参数 --backfill-aichat-stats [YYYY-MM-DD]:回填 AI 闲聊统计后直接退出(不连 WS)
if (process.argv.includes('--backfill-aichat-stats')) {
  backfillAiChatStats(process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)));
}

connect();

// 纯文本 @ 识别用昵称:启动时拉取当前 QQ 昵称加入集合
api('get_login_info').then(r => {
  if (r?.data?.nickname) { botNicknames.add(r.data.nickname); log('bot 昵称:', r.data.nickname, C.dim); }
}).catch(() => {});

// 定时兜底轮询(处理队列兜底)
setInterval(processQueue, POLL_MS);

// SnowLuma 健康检查:WS 可能"半死"(TCP 挂着但不推消息,onclose 不触发)。
// 60s 一次 HTTP 探测,连续 3 次失败 → 强制关闭 WS → 触发重连 + 补漏(2 分钟内)。
let apiFailStreak = 0;
setInterval(async () => {
  try {
    const r = await api('get_status');
    if (r?.status === 'ok') { apiFailStreak = 0; return; }
    throw new Error('status 异常');
  } catch {
    apiFailStreak++;
    if (apiFailStreak >= 3) {
      log('SnowLuma 无响应,强制重连 WS ...', '', C.red);
      apiFailStreak = 0;
      try { ws?.close(); } catch {}
    }
  }
}, 60000);

// 启动参数 --update-cards: 启动即更新一次卡库
if (process.argv.includes('--update-cards')) updateCardDb();

drawFeaturePanel();
log(`${DRY_RUN ? '[DRY_RUN] ' : ''}QQ Agent 监控终端启动 (bot=${BOT_ID} | ${TRIGGER_KEYWORD}=史记 | ${CARD_TRIGGER}=查卡 | ${CARD_IMG_TRIGGER}=卡图 | ${RULING_TRIGGER}=官裁 | ${RULING_FULL_TRIGGER}=裁定PDF | ${DAILY_KEYWORD}=每日一卡 | AI闲聊=${FEAT.ai ? `${AI_MODEL}${AI_WEB_SEARCH ? '+联网' : ''}(上下文 ${AI_CHAT_CTX} 条${AI_IS_DS ? ',图片直传一轮' : ',图片两轮识别'})` : 'OFF'} | 功能开关见面板 1/2/3)`, '', C.cyan);
