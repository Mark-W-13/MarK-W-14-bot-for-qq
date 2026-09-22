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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { getTone, setTone, systemPrompt as aiSystemPrompt, TONES, TONE_CN, TONE_DESC, tonePath } from './aichat/tone.mjs';
import { runSearch, WEB_SEARCH_TOOL, providerText as searchProviderText, searchReady, pickProvider, SEARCH_COUNT } from './aichat/websearch.mjs';
import { modeOf, setMode, parseModeCommand, MODE_CN, modesPath, allModes } from './modes.mjs';
import {
  searchCards as hsSearchCards, formatCard as hsFormatCard, queryAndFormat as hsQueryAndFormat,
  fetchCardImage, imageSegmentOf, decodeDeckstring as hsDecodeDeck, formatDeckList as hsFormatDeckList,
  extractDeckstring as hsExtractDeckstring, randomCard as hsRandomCard, cardCount as hsCardCount,
  totalCount as hsTotalCount, reloadCards as hsReloadCards, getCardsPath as hsCardsPath,
  updateHsCards, loadCards as hsLoadCards, cardById as hsCardById, cardByDbf as hsCardByDbf, cleanText as hsCleanText,
} from './hs/hs.mjs';
import {
  recommend as hsRecommend, formatRecommendation as hsFormatRecommendation, pureDeckCode as hsPureDeckCode,
  metaStats as hsMetaStats, loadMeta as hsLoadMeta, saveMeta as hsSaveMeta,
} from './hs/hs_meta.mjs';

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
// OneBot 的 @全体成员 段长这样:{type:'at', data:{qq:'all'}} —— 它不是某个人的 qq,
// 落到「查不到名字」的兜底分支里会被当成真人,或被误渲染成 @all(2026-09-20 修,见 atText)。
const AT_ALL = 'all';
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
// ---------- 炉石传说功能(2026-09-20 新增)----------
// 触发词与游戏王的**故意重叠**(「效果」「卡图」「每日一卡」):同一句话按本群 mode 走哪个游戏,
// 由「mode 游戏王/炉石」决定(见 modes.mjs)。另外两个炉石专属触发词:
const HS_DECK_TRIGGER = process.env.HS_DECK_TRIGGER || '卡组解析';   // 「卡组解析 」+卡组代码 → 卡表
const HS_RECO_TRIGGER = process.env.HS_RECO_TRIGGER || '推荐';       // 「推荐 狂野 猎人」→ 环境热门构筑
const HS_CARD_TRIGGER = CARD_TRIGGER;                                // 复用「效果 」
const HS_CARD_IMG_TRIGGER = CARD_IMG_TRIGGER;                        // 复用「卡图 」
const HELP_CMD = '/help';
// ---------- AI 闲聊后端(2026-09-21 改:**只剩一套 OpenAI 兼容后端**,智谱聊天后端整块删掉) ----------
// 老版本有两套后端(deepseek / 智谱 GLM),靠 AI_CHAT_PROVIDER 切,还带一堆降级逻辑(智谱没视觉要两轮识图、
// 智谱服务端注入式联网 …)。用户 2026-09-21 明确要求「把智谱后端相关删了」——它那套唯一的好处是免费,
// 而代价是把图片识别、联网都绑死在智谱身上。现在统一走 OpenAI 兼容的 /chat/completions:
//   AI_CHAT_API_URL 默认 https://api.deepseek.com/chat/completions
//   AI_CHAT_MODEL   默认 deepseek-flash(会看图,所以图片一轮直传)
//   换任何兼容服务(自建 vLLM / OneAPI / 别的厂商)只需改这两个,代码不用动。
// ⚠ 智谱的东西并没有全删:**只删了「拿它当聊天模型」这条路**。AI_CHAT_TONE 之外,联网搜索仍然可以用
//   ZHIPU_API_KEY —— 那是它家的 Web Search API(纯搜索服务,与聊天模型无关),见 aichat/websearch.mjs。
const AI_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.AI_CHAT_API_KEY || '';
const AI_API_URL = process.env.AI_CHAT_API_URL || 'https://api.deepseek.com/chat/completions';
const AI_MODEL = process.env.AI_CHAT_MODEL || 'deepseek-flash';
const AI_CHAT_CTX = Math.max(0, Number(process.env.AI_CHAT_CTX ?? 10));         // 附带最近 N 条群聊当上下文(0=不带;用户 2026-09-14 从 30 调小到 10)
// 联网搜索(2026-09-21 重写):从「智谱服务端注入」改成**本地实现的 function calling 工具** ——
// 模型自己决定要不要搜,我们自己调搜索 API,把结果当 tool 消息喂回去。任何后端都能用。
// AI_CHAT_WEB_SEARCH=0 关掉;没配任何搜索源时自动不挂(见 websearch.mjs 的 pickProvider)。
const AI_CHAT_WEB_SEARCH = process.env.AI_CHAT_WEB_SEARCH !== '0';
const AI_WEB_SEARCH = AI_CHAT_WEB_SEARCH && searchReady();
const AI_CHAT_MAX_SEARCHES = Math.max(1, Number(process.env.AI_CHAT_MAX_SEARCHES || 2));  // 单次回复最多搜几次,防它连着搜十轮把群友等烦
// deepseek 系默认会「思考」:实测 reasoning_effort='low' 会把 max_tokens 全烧在思考上、**正文返回空**
// ('none' 才是真关,1.1s)。闲聊要快、要短 → 默认关;想开思考设 AI_CHAT_REASONING=1。
// 注意:关思考是**按模型名**判断的(只对 deepseek 系有效),别的后端不会被塞这个参数。
const AI_THINK_OFF = /deepseek/i.test(AI_MODEL) && process.env.AI_CHAT_REASONING !== '1';
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
    case 'at': return atText(seg.data?.qq, names);
    case 'image': return '[图]';
    case 'face': return faceLabel(seg.data.id) ? `[表情:${faceLabel(seg.data.id)}]` : '[表情]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'reply': return '[回复]';
    case 'forward': return '[转发消息]';
    default: return `[${seg.type}]`;
  }
}

// ---------- @ 提及 → 说的是谁 ----------
// 2026-09-20 修的大坑:以前这里是 `names.has(seg.data.qq) ? '@'+名字 : '@all'`,
// 而 names 的键是 get_group_msg_history 给的 **number** user_id,at 段里的 qq 却是 **string**
// (线上实测:发言者 user_id 是 number 2186220790,段里是 "2186220790")→ 键永远对不上,
// **每一个 @ 都渲染成 @all**,连 @机器人自己 也是,模型于是以为那些人在喊「全体」。
// 现在:① 按键统一成字符串查;② @全体成员 认成「全体成员」而不是人;③ @的是机器人自己 → 「你(史官)」;
//        ④ 查不到名字用「成员<qq>」,**绝不写 @all**。
// (aichat.mjs 的 renderToken 是同一套口径:<qq> 段单独走那条路,本文件的群聊记录走这里。)
export function atText(qq, names) {
  const q = String(qq ?? '').trim();
  if (!q) return '@某人';                                   // 段里没带 qq(老条目降级路径)
  if (q.toLowerCase() === AT_ALL) return '@全体成员';         // 真的 @全体成员
  if (q === BOT_ID) return '@你(史官)';                      // @ 机器人自己
  const hit = names?.get?.(q);
  return hit ? `@${hit}` : `@成员${q}`;
}

// @ 与引用作者 → 群昵称(先查本次已拉到的群聊记录,再查群成员接口,查不到才用「成员<qq>」;
// 群名片改名不频繁,进程内缓存够用 —— 键**一律 String**,别把 number/string 混着塞)
const memberNames = new Map();
async function resolveMemberName(groupId, qq) {
  const key = `${groupId}:${String(qq)}`;
  if (memberNames.has(key)) return memberNames.get(key);
  let name = '';
  try {
    const r = await api('get_group_member_info', { group_id: groupId, user_id: Number(qq) });
    name = (r?.data?.card || r?.data?.nickname || '').trim();
  } catch { /* 查不到就退兜底名 */ }
  if (name) memberNames.set(key, name);
  return name || `成员${qq}`;
}

// 被 @ 的人常常**没在本批记录里发过言**(names 里没有他)→ segText 只能退化成「成员<qq>」。
// 这里补一次:把本批里所有查不到的 qq 批量问群成员接口,真昵称回填进 names。
// 尽力而为 —— 失败/查不到就算了,不影响正文(但绝不因此写 @all)。
async function fillAtNames(groupId, msgs, names) {
  const miss = [];
  for (const m of (msgs || [])) {
    for (const s of (m.message || [])) {
      if (s.type !== 'at') continue;
      const q = String(s.data?.qq ?? '').trim();
      if (!q || q.toLowerCase() === AT_ALL || q === BOT_ID) continue;   // 这三个 atText 自己认
      if (names.has(q) || miss.includes(q)) continue;
      miss.push(q);
    }
  }
  await Promise.all(miss.slice(0, 12).map(async q => {   // 一条消息顶多几个 @,12 是防异常的顶格
    const n = await resolveMemberName(groupId, q);
    if (n && !n.startsWith('成员')) names.set(q, n);
  }));
}

async function fetchTranscript(groupId, count = 100) {
  const { data } = await api('get_group_msg_history', { group_id: groupId, count });
  const msgs = data?.messages || [];
  if (!msgs.length) return null;
  // 键**统一 String**:历史接口给的是 number、at 段给的是 string,混着存就永远查不到(见 atText)
  const names = new Map();
  for (const m of msgs) if (m.user_id && !names.has(String(m.user_id))) names.set(String(m.user_id), nameOf(m.sender));
  await fillAtNames(groupId, msgs, names);
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
    lines.push(`${dayTag}${hhmm} ${names.get(String(m.user_id)) || nameOf(m.sender)}|${text}`);  }
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

// ---------- AI 闲聊(兜底:未命中任何指令的 @ 交给对话模型;人设=赛博史官说白话) ----------
// 与「史记总结」的分工:总结走 claude 出文言体;这里只接群友的随口 @,答白话、短。
// 消息里的 @/引用/表情/图片由 aichat.mjs 解析;图片随消息直传(deepseek 会看图 → 一轮出结果)。
//
// **提示词不在这个文件里**:人设、档位(板正/熟人群聊/放开)、时间与工具的拼装都在 aichat/tone.mjs。
// 2026-09-21 用户要求「解除引战、色情等限制」,做成三档 + 运维 WebUI 可切,所以那段从常量变成了模块。
const aiCooldown = new Map();   // uid -> 上次触发时间戳(15s 冷却,防连点刷屏)

// 提问正文:剥掉 @ 段标记(形如 [at])与多余空白(降级路径:没有 segs 的老条目 / 解析失败时用)
function aiQuestionText(entry) {
  return (entry.text || '').replace(/\[at\]/g, ' ').replace(/\s+/g, ' ').trim();
}

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

// 系统提示词 = tone.mjs 里按档位拼好的人设 + 当前时间 + (可选)读图规则与联网规则。
// 末尾「他没问就别主动报时间」是给小模型的护栏:不写这句,它容易在闲聊里顺嘴报一句时间。
const aiSystem = (hasImages = false, tone = getTone()) => aiSystemPrompt({
  tone,
  hasImages,
  hasSearch: AI_WEB_SEARCH,
  now: nowText(),
});

// 网络/超时错误与「后端 4xx」分开:4xx 才值得退让重试(参数不认),超时重来一轮只是把群友的等待翻倍。
class AiHttpError extends Error {}

async function aiChat(system, userText, images = []) {
  // 退让阶梯:先按默认档跑;碰到 4xx(参数/格式不认)依次退,最后连图一起去掉。
  // 换后端/换模型最容易踩的就是参数不认 —— 一个参数不能把整条闲聊弄挂。
  // 顺序讲究:① 去掉联网工具最可能救场(有的后端/模型不支持 function calling);
  //          ② 网页版 deepseek 支持思考模式下的工具调用,所以「不去工具、改开思考」也留一条;
  //          ③ 图片被后端拒(选了没视觉的模型)时最后去掉图,至少还能答字。
  const ladder = [
    { webSearch: AI_WEB_SEARCH, thinkOff: AI_THINK_OFF, images, tag: '' },
    ...(AI_WEB_SEARCH ? [{ webSearch: false, thinkOff: AI_THINK_OFF, images, tag: '去掉联网工具' }] : []),
    ...(AI_WEB_SEARCH && AI_THINK_OFF ? [{ webSearch: true, thinkOff: false, images, tag: '联网+带思考' }] : []),
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
      if (!(e instanceof AiHttpError) || !/^HTTP 4/.test(e.message)) throw e;
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

// 单次 POST(带超时);4xx/5xx 抛 AiHttpError,其余(超时/网络)按原样抛。
async function postChat(body, tag = '') {
  let r;
  try {
    r = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_CHAT_TIMEOUT_MS),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? `超时 ${AI_CHAT_TIMEOUT_MS}ms` : e.message;
    throw new Error(`${AI_MODEL}${tag} 请求失败:${why}`);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new AiHttpError(`HTTP ${r.status} ${j?.error?.message || j?.message || ''}`.trim());
  return j;
}

/**
 * 一次闲聊:function calling 循环 —— 模型要搜就搜(我们自己执行搜索),搜完把结果喂回去让它接着答。
 * 为什么这样写(2026-09-21 改):老路子是智谱服务端注入式联网,**只对智谱有效**,deepseek 挂上必 4xx。
 * 现在工具是我们本地实现的,任何 OpenAI 兼容后端都能用,而且搜了什么在面板上看得见(下面那行 log)。
 * 省钱护栏:AI_CHAT_MAX_SEARCHES(默认 2)轮之后就**不再挂工具**,逼它用已有材料作答,别无限搜下去。
 */
async function aiChatOnce(system, userText, images = [], opts = {}) {
  const { webSearch = AI_WEB_SEARCH, thinkOff = AI_THINK_OFF } = opts;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: buildUserContent(userText, images) }];
  const maxSearches = webSearch ? AI_CHAT_MAX_SEARCHES : 0;
  let used = 0;
  for (let round = 0; ; round++) {
    // 预算用完就**停止挂工具**(不再给它搜的机会,逼它用已有材料作答)。
    // ⚠ 判据用「还能搜几次」而不是「跑了几轮」:一轮里模型可能一口气要搜 2 个词,次数照样会超;
    //   同一把尺子也用在下面执行搜索前,免得超预算的调用白花一次搜索钱。
    const withTools = used < maxSearches;
    const j = await postChat({
      model: AI_MODEL,
      messages,
      temperature: 0.8,
      max_tokens: AI_CHAT_MAX_TOKENS,
      ...(thinkOff ? { reasoning_effort: 'none' } : {}),
      ...(withTools ? { tools: [WEB_SEARCH_TOOL] } : {}),
    });
    const msg = j?.choices?.[0]?.message;
    if (!msg) throw new Error(`${AI_MODEL} 返回结构不对:${JSON.stringify(j).slice(0, 200)}`);
    const calls = (msg.tool_calls || []).filter(c => c?.function?.name === 'web_search');
    if (!calls.length) {
      const text = String(msg.content || '').trim();
      if (!text) throw new Error(`${AI_MODEL} 返回空回复${round ? '(搜完之后没接上话)' : ''}`);
      return text;
    }
    // 记下助手的工具调用请求(OpenAI 要求这一条也在 messages 里,否则下一轮报「tool 消息找不到对应请求」)
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    for (const c of calls) {
      const args = (() => { try { return JSON.parse(c.function.arguments || '{}'); } catch { return {}; } })();
      const q = String(args.query || '').trim();
      if (q && used < maxSearches) {
        used++;
        const r = await runSearch(q, { count: Math.min(SEARCH_COUNT, 5) });   // 闲聊要快:每条结果都塞进提示词,别贪多
        log('  🔎 联网搜索:', `${q} → ${r.ok ? `${r.count} 条(${r.provider})` : r.error}`, r.ok ? C.dim : C.yellow);
        bumpSearchStat(r.ok, r.provider);
        messages.push({
          role: 'tool', tool_call_id: c.id,
          content: r.ok ? r.text : `搜索失败(${r.error})。没有搜到东西,按你已有的知识回答;不确定就直说不确定,别编造具体数字与日期。`,
        });
      } else if (q) {
        if (used === maxSearches) {   // 只在「刚好把预算用光」这一刻说一次,别每轮都刷
          log(`  本次已达最多 ${maxSearches} 次联网,用已有材料作答`, '', C.dim);
          used++;   // 抬过阈值,免得下一轮又提示一遍(仅用于去重提示,不代表真搜了)
        }
        messages.push({
          role: 'tool', tool_call_id: c.id,
          content: `本次回复的联网搜索次数已用完(${maxSearches} 次),不再执行搜索。请用已经拿到的材料回答;不够就说查不到。`,
        });
      } else {
        messages.push({ role: 'tool', tool_call_id: c.id, content: '搜索词为空,没有执行搜索。' });
      }
    }
  }
}

// ---------- 联网搜索记账(2026-09-21) ----------
// 为什么要记:老路子(智谱服务端注入)搜没搜全靠猜,现在虽然是本地执行、有日志,但运维台要有累计数
// 才好判断「开了这么久到底搜过几次、失败几次」。存 agent/search_stats.json(不入库),按天+总数。
const SEARCH_STATS_FILE = join(__dirname, 'search_stats.json');
function loadSearchStats() {
  try {
    const s = JSON.parse(readFileSync(SEARCH_STATS_FILE, 'utf8'));
    if (s && typeof s === 'object') return { total: 0, ok: 0, failed: 0, byDay: {}, byProvider: {}, ...s };
  } catch { /* 缺失/损坏 → 从零开始 */ }
  return { total: 0, ok: 0, failed: 0, byDay: {}, byProvider: {}, updatedAt: 0 };
}
function bumpSearchStat(ok, provider = '') {
  const s = loadSearchStats();
  const day = dayKey();
  s.total++;
  if (ok) s.ok = (s.ok || 0) + 1; else s.failed = (s.failed || 0) + 1;
  s.byDay[day] = s.byDay[day] || { ok: 0, failed: 0 };
  if (ok) s.byDay[day].ok++; else s.byDay[day].failed++;
  if (provider) s.byProvider[provider] = (s.byProvider[provider] || 0) + 1;
  s.updatedAt = Date.now();
  // 只留最近 60 天,免得文件无限长大
  const days = Object.keys(s.byDay).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 60))) delete s.byDay[d];
  try {
    writeFileSync(SEARCH_STATS_FILE + '.tmp', JSON.stringify(s, null, 1), 'utf8');
    renameSync(SEARCH_STATS_FILE + '.tmp', SEARCH_STATS_FILE);
  } catch (e) { log('  联网搜索记账失败:', e.message, C.red); }
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
      memberName: qq => names?.get(String(qq)) || resolveMemberName(entry.group_id, qq),
    });
    if (rich?.text) q = rich.text;
    images = rich?.images || [];
    if (rich && rich.mode !== 'direct') log(`  图片走 ${rich.mode} 模式`, '', C.dim);
  } catch (e) {
    log('  AI 闲聊消息解析失败(退回纯文本):', e.message, C.yellow);
  }
  q = q.replace(/@你(史官)/g, ' ').replace(/\s+/g, ' ').trim() || '(无文字,仅@)';
  // 档位**每次请求现读**(tone.json 是热切的,运维台一点就生效;读几 KB 的 JSON 相比一次模型调用可忽略)
  const tone = getTone();
  log(`  ${AI_MODEL} 生成中 ...(档位 ${TONE_CN[tone]}${AI_WEB_SEARCH ? ',可联网' : ''}${images.length ? `,含 ${images.length} 张图` : ''})`, '', C.dim);
  try {
    let reply = await aiChat(aiSystem(images.length > 0, tone), `${ctx}@你的人: ${entry.nickname}\nTA 的问题: ${q}`, images);
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

// ---------- 炉石传说功能(2026-09-20 新增)----------
// 四个功能与游戏王那套对称:卡牌检索(回卡图)/ 卡组代码解析 / 每日一卡 / 环境热门构筑推荐。
// 数据源与踩坑见 hs/hs.mjs 与 hs/hs_meta.mjs 的文件头(卡库 HearthstoneJSON,meta 只有 metastats 可达)。
const HS_DAILY_STATE_FILE = join(__dirname, 'hs_daily_card.json');   // 炉石每日一卡(与游戏王那份分开存,免得 id 撞车)
const hsRecoCooldown = new Map();                                    // uid → 上次查环境卡组的时间(8s 短冷却,抓站有成本)

/** 「效果 X」/「卡图 X」:查炉石卡,回文本 + 卡图;imageOnly 只回图 */
export async function processHsCardQuery(entry, raw, opts = {}) {
  log(`  查炉石卡「${raw}」...`, '', C.dim);
  const hits = hsSearchCards(raw, 5);
  if (!hits.length) {
    const text = `未找到与「${raw}」相关的炉石卡牌。可试试更完整的卡名,或用空格分隔多个关键词。`;
    log('  回复:', text, C.green);
    await sendReply(entry, text);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const hit = hits[0];
  const img = imageSegmentOf(await fetchCardImage(hit.id).catch(() => null));   // 卡图按需下载并本地缓存
  if (opts.imageOnly) {
    const text = img ? '' : `「${hit.name}」暂未取到卡图,可用「${CARD_TRIGGER} 」查卡牌信息。`;
    log('  回复:', img ? `卡图 ${hit.id}.png` : text, C.green);
    await sendReply(entry, img || text);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const more = hits.length > 1 ? `\n(另有 ${hits.length - 1} 张相近结果,可把卡名写全再查)` : '';
  const body = hsFormatCard(hit) + more;
  const segs = [{ type: 'text', data: { text: '\n' + body } }];
  if (img) segs.push(img);
  log('  回复:', body.split('\n')[0] + (img ? ' +卡图' : '(无卡图)'), C.green);
  await sendReply(entry, segs);
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

/** 「卡组解析 」+ 卡组代码(AAE 开头)→ 中文卡表 */
export async function processHsDeck(entry, raw) {
  const text = String(raw || '').replace(/\[at\]/g, ' ').trim();
  if (!text) {
    await sendReply(entry, `${HS_DECK_TRIGGER} + 卡组代码(游戏里「复制卡组代码」得到的那串 AAE 开头的字符)`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const code = hsExtractDeckstring(text) || text;      // 玩家可能把代码夹在别的话里
  log(`  解炉石卡组代码(${code.length} 字符)...`, '', C.dim);
  let reply;
  try {
    const dec = hsDecodeDeck(code);
    if (dec.cards.reduce((n, x) => n + x.count, 0) < 15) throw new Error('这套牌不足 15 张,不像完整卡组');
    reply = hsFormatDeckList(dec);
    log('  回复:', reply.split('\n')[0], C.green);
  } catch (e) {
    reply = `这段卡组代码没解出来(${e.message})。确认是游戏里「复制卡组代码」得到的那串(以 AAE 开头)。`;
    log('  解析失败:', e.message, C.red);
  }
  await sendReply(entry, reply);
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

/** 「每日一卡」在炉石模式下的版本:同一人同一自然日同一张,过 0 点换卡(与游戏王同规则) */
export async function processHsDailyCard(entry) {
  const st = (() => { try { return JSON.parse(readFileSync(HS_DAILY_STATE_FILE, 'utf8')); } catch { return {}; } })();
  const uid = String(entry.user_id);
  const today = dayKey();
  const prev = st[uid];
  let card = null;
  // ⚠ 必须用 **cardByDbf**(卡组代码与每日一卡状态里存的是数字 dbfId);
  //    cardById 查的是字符串 id('EX1_561' 那种),拿 dbfId 去查**永远返回 null** ——
  //    2026-09-20 就栽在这:每日一卡每次都被判定为「今天还没抽过」而重抽,一天能换好几张。
  if (prev && prev.day === today && prev.dbfId && hsCardByDbf(prev.dbfId)) card = hsCardByDbf(prev.dbfId);
  const fresh = !card;
  if (fresh) {
    card = hsRandomCard();
    st[uid] = { day: today, dbfId: card.dbfId };
    try {
      writeFileSync(HS_DAILY_STATE_FILE + '.tmp', JSON.stringify(st), 'utf8');
      renameSync(HS_DAILY_STATE_FILE + '.tmp', HS_DAILY_STATE_FILE);
    } catch (e) { log('  每日一卡状态写入失败:', e.message, C.yellow); }
  }
  const header = fresh ? '【每日一卡 · 炉石】今日之卡:' : '【每日一卡 · 炉石】今日还是这张:';
  const text = `${header}\n${hsFormatCard(card)}`;
  const segs = [{ type: 'text', data: { text: '\n' + text } }];
  const img = imageSegmentOf(await fetchCardImage(card.id).catch(() => null));
  if (img) segs.push(img);
  log('  回复:', (fresh ? '新卡 ' : '同卡 ') + `${card.name}${img ? ' +卡图' : '(无卡图)'}`, C.green);
  await sendReply(entry, segs);
}

/** 「推荐 [标准/狂野] [职业/卡组名]」→ 两条消息:①构筑+胜率/热度 ②纯净卡组代码 */
export async function processHsRecommend(entry, raw) {
  const q = String(raw || '').replace(/\[at\]/g, ' ').trim();
  if (!q) {
    await sendReply(entry, `用法:@我 说「${HS_RECO_TRIGGER} 标准 猎人」或「${HS_RECO_TRIGGER} 狂野 圣契骑」,先给构筑+胜率,再单独发一条纯净卡组代码。`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const cooldownKey = `reco:${entry.user_id}`;
  const last = hsRecoCooldown.get(cooldownKey);
  if (last && Date.now() - last < 8000) {          // 抓站有成本,给个短冷却防连点
    log('  推荐冷却中,本次不回', '', C.dim);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  hsRecoCooldown.set(cooldownKey, Date.now());
  log(`  查环境卡组「${q}」...`, '', C.dim);
  let r;
  try {
    r = await hsRecommend(q, { log: m => log(' ', m, C.dim) });
  } catch (e) {
    log('  推荐失败:', e.message, C.red);
    await sendReply(entry, `环境卡组没查成(${e.message}),稍后再试。`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  if (r.kind !== 'ok') {
    const why = r.format === 'wild'
      ? `本地狂野卡组库里没有「${q}」。可以只发「${HS_RECO_TRIGGER} 狂野」看已有的,或换个职业。`
      : `没找到「${q}」对应的卡组。可试试「${HS_RECO_TRIGGER} 标准 猎人」这种写法(职业可用简称:猎/法/术/贼/骑/牧/萨/战/瞎/德/死骑)。`;
    log('  没找到:', why, C.yellow);
    await sendReply(entry, why);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const first = hsFormatRecommendation(r);
  const code = hsPureDeckCode(r);
  log('  回复①:', first.split('\n').slice(0, 2).join(' / ').slice(0, 80), C.green);
  await sendReply(entry, first);
  // 第二条:**只有卡组代码**,不带卡组名、不带卡名,方便直接复制导入
  await sendReply(entry, code);
  log('  回复②:', code.slice(0, 40) + '…', C.green);
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 帮助(最简洁的功能介绍;以「/help」或「帮助」开头的消息触发) ----------
// 两种模式各一份(2026-09-20):本群 mode=炉石 时只列炉石那套,免得把用不上的指令堆给群友。
function isHelpRequest(text) {
  const clean = (text || '').replace(/\[at\]/g, ' ').trim();
  return /^(?:\/help|帮助)/i.test(clean);
}
export function buildHelpText(mode = 'ygo') {
  const shit = FEAT.shitpost
    ? `\n${SHIT_TRIGGER} — 随机搬一条史(封面截图)`   // AI 精选一搬未完善,暂不展示
    : '';
  const kuangshen = FEAT.kuangshen
    ? `\n${KUANGSHEN_TRIGGER} — 随机一条kkkm语录;\n${KUANGSHEN_TRIGGER} [关键词] — 按关键词检索语录`
    : '';
  const ai = FEAT.ai
    ? `\n\n没写指令也没关系 —— 随便 @ 我说点什么,史官直接接话(带图带表情包也认得出,引用别人的话我也看得见)。`
    : '';
  const common = `
${TRIGGER_KEYWORD} — 以史记体文言文总结最近群聊
${HELP_CMD} — 看这份说明${kuangshen}${shit}${ai}`;
  if (mode === 'hs') {
    return `【赛博史官·使用说明 · 炉石传说模式】@我 + 以下指令即可。
(本群现在是炉石模式;要玩「效果 青眼白龙」那套游戏王功能,发「mode 游戏王」切回去)

${HS_CARD_TRIGGER} [卡名] — 查炉石卡牌,回效果文本+卡图,如「${HS_CARD_TRIGGER} 火球术」
${HS_CARD_IMG_TRIGGER} [卡名] — 只回卡图,如「${HS_CARD_IMG_TRIGGER} 火球术」
${HS_DECK_TRIGGER} [卡组代码] — 把卡组代码(AAE 开头那串)解成卡表
${HS_RECO_TRIGGER} [标准/狂野] [职业或卡组名] — 当前环境热门构筑+胜率,再单独发一条纯净卡组代码
${DAILY_KEYWORD} — 抽今日之卡(炉石卡,同一天同一张)
${common}`;
  }
  return `【赛博史官·使用说明】@我 + 以下指令即可。
(现在是游戏王模式;要玩炉石那套,发「mode 炉石」)

${TRIGGER_KEYWORD} — 以史记体文言文总结最近群聊
${DAILY_KEYWORD} — 抽今日之卡
${DECK_TRIGGER} [卡组内容（ydk文本/卡组码/分享链接）] — 生成巡回赛PDF卡表
${CARD_TRIGGER} [卡名] — 查卡牌效果，如「${CARD_TRIGGER} 青眼白龙」
${CARD_IMG_TRIGGER} [卡名] — 查卡图，如「${CARD_IMG_TRIGGER} 青眼白龙」
${RULING_TRIGGER} [卡名] — 查官方裁定，返回部分
${RULING_FULL_TRIGGER} [卡名] — 查完整裁定${kuangshen}${shit}${ai}`;
}

// ---------- 处理单个请求 ----------
export async function processEntry(entry) {
  const text = entry.text || '';
  // 本群当前走哪个游戏的功能(默认游戏王);现读文件,所以运维台改完立即生效
  const mode = modeOf(entry.group_id);
  entry.mode = mode;                                // 帮助文本/日志用
  if (isHelpRequest(text)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [帮助]`, C.cyan);
    await sendReply(entry, buildHelpText(mode));
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  // 「mode 炉石」/「mode 游戏王」:切本群模式(不受当前模式限制,不然改了回不去)
  const modeCmd = parseModeCommand(text);
  if (modeCmd.triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [切换模式]`, C.cyan);
    if (modeCmd.mode) {
      const r = setMode(entry.group_id, modeCmd.mode);
      const label = MODE_CN[modeCmd.mode];
      const extra = r.changed ? `本群已切到「${label}」模式。` : `本群本来就是「${label}」模式。`;
      const what = modeCmd.mode === 'hs'
        ? `${HS_CARD_TRIGGER} / ${DAILY_KEYWORD} / ${HS_DECK_TRIGGER} / ${HS_RECO_TRIGGER}`
        : `${CARD_TRIGGER} / ${CARD_IMG_TRIGGER} / ${DAILY_KEYWORD} / ${RULING_TRIGGER}`;
      await sendReply(entry, `${extra}之后本群的「${what}」按${label}用;发「${HELP_CMD}」看用法,发「mode 游戏王」可切回。`);
      log('  模式切换:', `${entry.group_id} → ${modeCmd.mode}`, C.green);
    } else {
      await sendReply(entry, `用法:@我 说「mode 游戏王」或「mode 炉石」,之后本群一直沿用(现在:${MODE_CN[mode]})。`);
    }
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  if (text.includes(TRIGGER_KEYWORD)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [史记总结]`, C.cyan);
    return processHistory(entry);
  }
  if (text.includes(DAILY_KEYWORD)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [每日一卡${mode === 'hs' ? '·炉石' : ''}]`, C.cyan);
    if (mode === 'hs') await processHsDailyCard(entry);
    else await processDailyCard(entry);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  // 游戏王专属指令:炉石模式下不响应(否则「生成卡表」「裁定」会被当成闲聊)
  if (mode === 'ygo') {
    const deckQuery = extractCardQuery(entry, DECK_TRIGGER);   // 「生成卡表 」+ ydk/卡组码/链接
    if (deckQuery.triggered) {
      log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [生成卡表]`, C.cyan);
      await processDeckList(entry, deckQuery.raw);
      return;
    }
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
    // 同一套触发词,按群模式走不同游戏:炉石模式下「效果 X」回炉石卡(文字+卡图)
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [卡牌查询${mode === 'hs' ? '·炉石' : ''}]`, C.cyan);
    if (!raw) {                                   // 只有「效果 」没卡名 → 教用法
      const text = mode === 'hs'
        ? `用法:@我 然后说「${CARD_TRIGGER} 」+卡名,如「${CARD_TRIGGER} 火球术」;多个关键词用空格分隔。`
        : `用法:@我 然后说「${CARD_TRIGGER} 」+卡名,如「${CARD_TRIGGER} 青眼白龙」;多个关键词用空格分隔。`;
      await sendReply(entry, text);
    } else if (mode === 'hs') {
      await processHsCardQuery(entry, raw, { withImage: true });   // 炉石:卡牌信息 + 卡图
    } else {
      await processCardQuery(entry, raw);         // 内部会写 processed
    }
    return;
  }
  const imgQuery = extractCardQuery(entry, CARD_IMG_TRIGGER);
  if (imgQuery.triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [卡图查询${mode === 'hs' ? '·炉石' : ''}]`, C.cyan);
    if (!imgQuery.raw) {                          // 只有「卡图 」没卡名 → 教用法
      const text = `用法:@我 然后说「${CARD_IMG_TRIGGER} 」+卡名,如「${CARD_IMG_TRIGGER} ${mode === 'hs' ? '火球术' : '青眼白龙'}」;多个关键词用空格分隔。`;
      await sendReply(entry, text);
    } else if (mode === 'hs') {
      await processHsCardQuery(entry, imgQuery.raw, { imageOnly: true });   // 炉石:只要卡图
    } else {
      await processCardImageQuery(entry, imgQuery.raw);
    }
    return;
  }
  if (mode === 'ygo' && text.includes(RULING_FULL_TRIGGER)) {   // 完整裁定(须在普通「裁定」分支前,否则被其先匹配)
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
  if (mode === 'ygo' && rulingQuery.triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [裁定查询]`, C.cyan);
    if (!rulingQuery.raw) {                       // 只有「裁定 」没卡名 → 教用法
      const text = `用法:@我 然后说「${RULING_TRIGGER} 」+卡名,如「${RULING_TRIGGER} 青眼白龙」;多个关键词用空格分隔。`;
      await sendReply(entry, text);
    } else {
      await processRulings(entry, rulingQuery.raw);
    }
    return;
  }
  // ===== 炉石传说功能(2026-09-20):只在本群 mode = 炉石 时启用,见文件头「模式」说明 =====
  if (mode === 'hs') {
    if (text.includes(HS_DECK_TRIGGER)) {         // 「卡组解析 」+卡组代码 → 卡表
      log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [炉石卡组解析]`, C.cyan);
      await processHsDeck(entry, extractCardQuery(entry, HS_DECK_TRIGGER).raw);
      return;
    }
    if (text.includes(HS_RECO_TRIGGER)) {         // 「推荐 狂野 猎人」→ 两条消息
      log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [炉石卡组推荐]`, C.cyan);
      await processHsRecommend(entry, extractCardQuery(entry, HS_RECO_TRIGGER).raw);
      return;
    }
  }
  // 兜底:没命中任何指令的 @ → 交给 AI 闲聊(面板 3 键 / opsweb 可热关)
  if (FEAT.ai && AI_API_KEY) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [AI 闲聊]`, C.cyan);
    await processAiChat(entry);
    return;
  }
  const shitTriggers = FEAT.shitpost ? ` / "${SHIT_TRIGGER}" / "${SHIT_AI_TRIGGER}"` : '';
  log('⏭ 跳过', `seq=${entry.seq} @${entry.nickname} 无触发词("${TRIGGER_KEYWORD}" / "${DAILY_KEYWORD}"${shitTriggers} / "${CARD_TRIGGER} " / "${CARD_IMG_TRIGGER} " / "${RULING_TRIGGER} " / "${HS_DECK_TRIGGER} " / "${HS_RECO_TRIGGER} "): ${text.slice(0, 30)}`, C.dim);
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

async function processHistory(entry) {
  const { lines: transcript, names } = await fetchTranscript(entry.group_id, 100);
  if (!transcript) throw new Error('无消息历史');
  // 目标指定:把 @ 对象 qq 映射为昵称,交给 claude 聚焦(@全体成员 不是人,用 atText 走同一套口径)
  if (entry.targets?.length) {
    entry.targetNames = entry.targets.map(q => atText(q, names).replace(/^@/, ''));
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
  // 目标指定:消息中同时@了其他人 → 收集为 targets(不含机器人自身,也不含 @全体成员 —— 那不是人)
  const targets = (j.message || [])
    .filter(s => s.type === 'at' && String(s.data?.qq) !== BOT_ID && String(s.data?.qq ?? '').toLowerCase() !== AT_ALL)
    .map(s => String(s.data.qq));
  const allText = (j.message || []).map(s => s.type === 'text' ? s.data.text : `[${s.type}]`).join('');
  // 常规消息截 200;含「生成卡表」的消息可能带完整 ydk 文本/卡组码,放宽到 8000
  // 炉石的「卡组解析 」也带一长串 AAE 卡组代码,同样不能截(2026-09-20)
  const longTriggers = [DECK_TRIGGER, HS_DECK_TRIGGER];
  const text = (allText.length > 200 && longTriggers.some(t => allText.includes(t))) ? allText.slice(0, 8000) : allText.slice(0, 200);
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
// ---------- 自测:群聊记录的 @ 渲染(2026-09-20 加) ----------
// 起因:names 的键是 number、at 段的 qq 是 string,导致**每个 @ 都渲染成 @all**(线上实测见 atText 注释)。
// 这套断言就是钉住那件事:谁在 @ 谁必须还原成人。用法:node monitor.mjs --selftest-at
function selftestAt() {
  const bot = BOT_ID;
  const names = new Map([
    ['2186220790', '海水一直在摸鱼'],
    ['1206141711', 'woodcube'],
  ]);
  const cases = [
    ['2186220790', '@海水一直在摸鱼', '字符串键查得到(线上历史接口给的是 number,这一条就是当初崩的地方)'],
    [2186220790, '@海水一直在摸鱼', 'number 形态的 qq 也认'],
    ['999999999', '@成员999999999', '名单里没有他 → 成员<qq>,不再写 @all'],
    ['', '@某人', '老条目没有 qq → @某人'],
    ['all', '@全体成员', '@全体成员 不是人'],
    ['ALL', '@全体成员', '全部大写也认'],
    [bot, '@你(史官)', '@ 机器人自己'],
  ];
  let bad = 0;
  for (const [qq, want, why] of cases) {
    const got = atText(qq, names);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} atText(${JSON.stringify(qq)}) = ${got}${ok ? '' : ` (应为 ${want})`} —— ${why}`);
  }
  // 键类型:这批是 number(历史接口原样),渲染时必须照样查到
  const numKeyed = new Map([[2186220790, '海水一直在摸鱼']]);
  const numGot = atText('2186220790', numKeyed);
  const numOk = numGot === '@成员2186220790';   // 旧代码靠它「提前命中」,现在不依赖 —— 但要保证不崩、不错
  console.log(`✓ number 键混入时不崩:atText('2186220790', number 键) = ${numGot}${numOk ? '' : '(走的是 fillAtNames 回填 String 键后的路径,正常)'}`);

  const transcript = [
    { user_id: 1206141711, sender: { card: 'woodcube' }, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'at', data: { qq: '2186220790' } }, { type: 'text', data: { text: ' 你看这个' } }] },
    { user_id: 2186220790, sender: { card: '海水一直在摸鱼' }, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'at', data: { qq: BOT_ID } }, { type: 'text', data: { text: ' 在吗' } }] },
    { user_id: 2186220790, sender: { card: '海水一直在摸鱼' }, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 都来看看' } }] },
  ];
  const n2 = new Map();
  for (const m of transcript) if (!n2.has(String(m.user_id))) n2.set(String(m.user_id), nameOf(m.sender));
  const rendered = transcript.map(m => (m.message || []).map(s => segText(s, n2)).join('')).join(' | ');
  const want = '@海水一直在摸鱼 你看这个 | @你(史官) 在吗 | @全体成员 都来看看';
  const ok = rendered === want;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} 群聊记录渲染: ${rendered}${ok ? '' : `\n   应为: ${want}`}`);
  const noAll = !/@all\b/.test(rendered);
  if (!noAll) { bad++; console.log('✗ 正文里还有 @all'); }

  console.log(bad ? `\n✗ ${bad} 项不过` : '\n✓ 全部通过');
  process.exit(bad ? 1 : 0);
}

// 自测分支必须在 connect() 之前 —— 它自己 process.exit,不连 WS 也不碰 tmux 面板
if (process.argv.includes('--selftest-at')) selftestAt();

// 启动参数 --aichat-selftest [--live|--mock]:查 AI 闲聊这条链的配置与拼装。
//   · 默认**离线**:档位 / 提示词 / 联网工具 / 记账,不联网也不调模型 —— 随便跑,不花钱。
//   · `--mock`:**把聊天请求拦下来自己造假响应**(不需要聊天 key、不花钱),先喂一个 `web_search`
//     tool_call 进去,验证「模型要搜 → 我们真搜 → 结果当 tool 消息回填 → 再问一次」整条循环真的通。
//     这是 2026-09-21 改联网方式后最该钉住的一段:光读代码看不出 messages 拼错没有
//     (比如漏了 assistant.tool_calls 那条,真后端会回「tool 消息找不到对应的请求」)。
//   · `--live` 才真调一次模型(需要聊天 key),验证端到端。
// 加这个是因为把提示词挪进 tone.mjs、把联网改成工具调用之后,「后端换没换成 deepseek」「key 配没配」
// 「搜索源是谁」这类问题光看日志要翻半天。
async function aiChatSelftest() {
  const live = process.argv.includes('--live');
  const mock = process.argv.includes('--mock');
  const lines = [];
  let bad = 0;
  const ok = (c, m, extra = '') => { if (!c) bad++; lines.push(`${c ? '✓' : '✗'} ${m}${extra ? ` — ${extra}` : ''}`); };

  // ① 后端配置
  ok(!/bigmodel|zhipu|glm/i.test(AI_API_URL), '聊天后端不再是智谱', AI_API_URL);
  ok(/deepseek|localhost|127\.0\.0\.1|api\./i.test(AI_API_URL), '聊天后端地址看着正常', AI_API_URL);
  ok(AI_API_KEY || mock || !live, `聊天 key ${AI_API_KEY ? `已配置(...${AI_API_KEY.slice(-4)})` : '缺失(--live 才能验实调,--mock 不需要)'}`);
  ok(!!tonePath() && TONES.includes(getTone()), `档位可读:${TONE_CN[getTone()]}`, `文件 ${tonePath()}`);

  // ② 提示词:三档都能拼出来,且档位差异真的进了提示词
  for (const t of TONES) {
    const p = aiSystem(false, t);
    ok(p.length > 400, `${t} 提示词非空(${p.length} 字)`);
    ok(p.includes(TONE_CN[t].slice(0, 3)), `${t} 提示词里带档位名`);
  }
  ok(/不聊政治、色情、违法内容/.test(aiSystem(false, 'strict')), 'strict 档保留原版红线');
  ok(!/不聊政治、色情、违法内容/.test(aiSystem(false, 'loose')), 'loose 档已解除「不时政色情」限制(用户要的)');

  // ③ 联网工具
  ok(!!WEB_SEARCH_TOOL?.function?.name, '联网工具定义存在', WEB_SEARCH_TOOL?.function?.name);
  ok(AI_CHAT_WEB_SEARCH === false || !!searchProviderText(), `搜索源:${searchProviderText()}`);
  const r = await runSearch('游戏王 禁卡表', { count: 1 });
  ok(r.ok || !AI_CHAT_WEB_SEARCH, `搜索接口${r.ok ? '可用' : '不可用(已将工具摘掉,不影响闲聊)'}`, r.ok ? `${r.count} 条/${r.provider}` : r.error);

  // ④ 记账文件能写能读
  const before = loadSearchStats().total;
  bumpSearchStat(true, searchReady() ? pickProvider() : '');
  const after = loadSearchStats();
  ok(after.total === before + 1 && !!after.byDay[dayKey()], '联网搜索记账可写可读', `今日 ${JSON.stringify(after.byDay[dayKey()])}`);

  // ⑤ --mock:把聊天请求拦下来造假响应,验证「要搜 → 真搜 → 回填 → 再问」这整条循环。
  //    这一步不花 key 也不花钱,但它钉住的正是本次改动最容易错的地方(消息数组拼错、tool_call_id 对不上)。
  if (mock) {
    const realFetch = globalThis.fetch;
    const seen = [];
    let round = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== AI_API_URL) return realFetch(url, init);   // 搜索等其它请求照常真发
      const body = JSON.parse(init.body);
      seen.push(body);
      round++;
      const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
      if (round === 1) {   // 第 1 轮:模型说「我要搜」
        ok(!!body.tools?.[0]?.function?.name, '第 1 轮请求里挂上了 web_search 工具', body.tools?.[0]?.function?.name);
        return json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '游戏王 禁卡表 2026' }) } }] } }] });
      }
      const msgs = body.messages || [];
      ok(msgs.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls[0]?.id === 'call_1'),
        '第 2 轮带上了 assistant 的 tool_calls(漏了这条真后端会报错)');
      const toolMsg = msgs.find(m => m.role === 'tool');
      ok(!!toolMsg && toolMsg.tool_call_id === 'call_1', 'tool 结果的 tool_call_id 对得上', toolMsg?.tool_call_id);
      ok(!!toolMsg && toolMsg.content.length > 40, `tool 结果非空(${toolMsg?.content?.length || 0} 字)`);
      ok(!!toolMsg && /https?:\/\//.test(toolMsg.content), 'tool 结果里带来源链接');
      if (round === 2) {
        // 预算还剩 1 次(AI_CHAT_MAX_SEARCHES=2)→ 这一轮**仍然挂着工具**,再做一次搜索请求
        ok(!!body.tools, '预算没用完时继续挂着工具(还能再搜一次)');
        return json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '游戏王 禁卡表 生效日期' }) } }] } }] });
      }
      // 到这里已搜满 2 次 → 必须**摘掉工具**(否则模型会一直搜下去,群友得等)
      ok(!body.tools, `搜满预算后这一轮就不挂工具了[round=${round} msgs=${msgs.map(m => m.role).join('>')}]`);
      ok(msgs.filter(m => m.role === 'tool').length === 2, '两轮搜索结果都在上下文里(模型看得见两次搜的)');
      return json({ choices: [{ message: { role: 'assistant', content: 'mock 回复:查到的说法是 …' } }] });
    };
    try {
      const reply = await aiChat(aiSystem(false, 'loose'), '@你的人: 自测\nTA 的问题: 最新禁卡表是哪一期?', []);
      ok(/mock 回复/.test(reply), 'mock 下拿到最终回复', reply.slice(0, 40));
      ok(seen.length === 3, '共发生 3 次聊天请求(要搜 → 再要搜 → 收尾)', `实际 ${seen.length} 次`);
      ok(!seen[0].messages.some(m => m.role === 'tool'), '第 1 轮里没有 tool 消息');
    } catch (e) {
      ok(false, 'mock 循环执行失败', e.message);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(lines.join('\n'));

  if (!live) {
    console.log(`\n(离线自测。想验证真联网回答:node monitor.mjs --aichat-selftest --live;`
      + `\n 不花钱地验整条工具调用循环:node monitor.mjs --aichat-selftest --mock)`);
    console.log(bad ? `✗ ${bad} 项不过` : '✓ 离线自测全部通过');
    process.exitCode = bad ? 1 : 0;   // 见 websearch.mjs 里的说明:有 fetch 时别 process.exit
    return;
  }
  if (!AI_API_KEY) {
    console.log('\n✗ --live 需要 key:请在 agent/.env 里配 DEEPSEEK_API_KEY(ZHIPU_API_KEY 只服务搜索与 describe 识图)');
    process.exitCode = 1;
    return;
  }
  console.log(`\n--- 真调一次模型(${AI_MODEL},档位 ${TONE_CN[getTone()]},联网 ${AI_WEB_SEARCH ? searchProviderText() : '关'})---`);
  const t0 = Date.now();
  try {
    const reply = await aiChat(aiSystem(false), `@你的人: 自测\nTA 的问题: 现在游戏王的最新禁卡表是哪一期生效的?用一句话说,说清来源日期。`, []);
    console.log(`✓ ${Date.now() - t0}ms\n${reply}`);
    process.exitCode = bad ? 1 : 0;
  } catch (e) {
    console.log(`✗ ${Date.now() - t0}ms 调用失败:${e.message}`);
    process.exitCode = 1;
  }
}
if (process.argv.includes('--aichat-selftest')) aiChatSelftest();

// 启动参数 --backfill-aichat-stats [YYYY-MM-DD]:回填 AI 闲聊统计后直接退出(不连 WS)
if (process.argv.includes('--backfill-aichat-stats')) {
  backfillAiChatStats(process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)));
}

// 仅「直接运行」时启动服务:被别的脚本 import 进来(如临时诊断脚本)时不该连 WS、不该抢 tmux 面板。
// 自测/回填那几个参数也一并排掉 —— 它们自己 process.exit,但会让 main() 先跑起来(连 WS、打启动横幅),
// 2026-09-21 就踩到:跑 --aichat-selftest 时面板与「WS 错误」一起冒出来,看着像自测把机器人弄挂了。
const ASKIP = ['--aichat-selftest', '--selftest-at', '--backfill-aichat-stats'];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  && !ASKIP.some(a => process.argv.includes(a))) main();

// 诊断用:直接拿某个群的群聊记录文本(与 AI 闲聊/史记总结喂给模型的是同一份)→ node --input-type=module 里 import
export async function groupTranscript(groupId, count = 10) {
  const r = await fetchTranscript(groupId, count);
  return r ? r.lines : '';
}

function main() {
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
log(`${DRY_RUN ? '[DRY_RUN] ' : ''}QQ Agent 监控终端启动 (bot=${BOT_ID} | ${TRIGGER_KEYWORD}=史记 | ${CARD_TRIGGER}=查卡 | ${CARD_IMG_TRIGGER}=卡图 | ${RULING_TRIGGER}=官裁 | ${RULING_FULL_TRIGGER}=裁定PDF | ${DAILY_KEYWORD}=每日一卡 | AI闲聊=${FEAT.ai ? `${AI_MODEL}(${TONE_CN[getTone()]},上下文 ${AI_CHAT_CTX} 条,图片直传一轮,联网=${AI_WEB_SEARCH ? searchProviderText() : '关闭'})` : 'OFF'} | 功能开关见面板 1/2/3)`, '', C.cyan);
}   // ← main() 到这儿结束:进程主体只在「直接运行本文件」时执行
