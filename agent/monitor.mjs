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
// 游戏王「环境饼图」(2026-10-26):@ 说「近期环境 / 环境 10月」→ 抓贴吧「上位卡组吧」按时间段
// 统计上位卡组,回一张带时间段标记的饼图。抓取/缓存/统计/画图都在 ygometa/meta.mjs。
import {
  parseMetaTrigger, buildMetaPie, buildMetaPdf, parseTopSearch, searchTopDeck,
  metaImageSegment, metaSelftest,
} from './ygometa/meta.mjs';
// 银河皇帝模式(2026-10-26):@ 时切「银河皇帝贝利亚」人格。状态/提示词/表情包库都在那个模块里,
// 这里只负责「什么时候切、什么时候用这套提示词、回复后附不附表情包」。
import {
  isOn as belialOn, setOn as belialSetOn, parseCommand as belialParseCmd, allOn as belialAll,
  systemPrompt as belialSystemPrompt, activationLine as belialActivation, againLine as belialAgain,
  offLine as belialOff, statusLine as belialStatus, resolveSticker as belialResolveSticker,
  stickerSegment as belialStickerSegment, listStickers as belialStickers,
  addSticker as belialAddSticker, statePath as belialStatePath,
  splitBelialReply, MAX_STICKERS as BELIAL_MAX_STICKERS,
  FEATURE_CN as BELIAL_CN, PERSONA_CN as BELIAL_PERSONA, MAX_TOKENS as BELIAL_MAX_TOKENS,
  TEMPERATURE as BELIAL_TEMPERATURE, MAX_REPLY as BELIAL_MAX_REPLY, REPLY_GAP_MS as BELIAL_GAP_MS,
  THINK as BELIAL_THINK,
} from './belial/belial.mjs';
import { BELIAL_TOOLS, stickerCatalogText } from './belial/tools.mjs';
import { dsSearch } from './belial/deepsearch.mjs';
import { searchStickerImages, downloadSticker as downloadStickerImage } from './belial/stickersearch.mjs';
// 贴吧模式(2026-09-28):不用 @ 就插嘴的「贴吧鱼」。状态/提示词/连发拆分都在那个模块里,
// 这里只负责「什么时候叫它」与「把回复发出去」(见本文件的 tiebaOnMessage / tiebaFire)。
import {
  isOn as tiebaOn, setOn as tiebaSetOn, parseGroupCommand as tiebaParseCmd, systemPrompt as tiebaSystemPrompt,
  splitReply as tiebaSplit, decideReply as tiebaDecide, worthReplying as tiebaWorth, buildContext as tiebaBuildContext,
  pickCount as tiebaPickCount, MIN_CHARS as TIEBA_MIN_CHARS, emojiAllowed as tiebaEmojiAllowed,  noteMessage as tiebaNote, ringOf, allOn, statePath as tiebaStatePath, AT_SUFFIX as TIEBA_AT_SUFFIX,
  FEATURE_KEY as TIEBA_KEY, FEATURE_CN as TIEBA_CN, GROUP_CMD as TIEBA_CMD,
  PROB_DEFAULT as TIEBA_PROB, PROB_AT_DEFAULT as TIEBA_AT_PROB, CTX as TIEBA_CTX, CTX_FETCH as TIEBA_CTX_FETCH,
  probOf as tiebaProbOf, probAtOf as tiebaProbAtOf, setProb as tiebaSetProb,
  MAX_REPLY as TIEBA_MAX_REPLY, MAX_CHARS as TIEBA_MAX_CHARS, MAX_TOKENS as TIEBA_MAX_TOKENS,
  TEMPERATURE as TIEBA_TEMPERATURE, PASS_IMAGES as TIEBA_IMAGES, NEW_GAP_MS as TIEBA_GAP_MS,
} from './tieba/tieba.mjs';
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

// ---------- QQ 自带机器人(官方机器人)的 @ 一律不接(2026-10-21) ----------
// 用户要求:「被入群机器人 @ 不进行回复(QQ 自带的 bot)」。这不是洁癖,线上真出过事:
//   2026-10-16 群 556920058(次世代唐人街),机器人重新进群 → Q群管家(2854196310)的欢迎语 @ 了它 →
//   它照惯例回复(所有回复都会先 @ 触发者)→ 管家回「嗨~,我是Q群管家,可以发送入群欢迎和定时消息……」
//   也 @ 它 → 又回 …… 4 秒内来回 5 轮;最后一条正好撞上「你已被移出该群」,成了 10-20 那起
//   「无限重试烧光 token」事故的毒条目。跟 QQ 自带机器人对话纯属空转:它们不是群成员,也不看回复。
// 三个判据,任一命中即当自带机器人(只看**发送者**,不按昵称 —— 昵称能改,真人也能叫「Q群管家」):
//   ① 已知官方 uin:Q群管家 2854196310 / QQ小冰 2854196306;env `BOT_IGNORE_IDS` 可追加(逗号分隔)
//   ② uin 落在腾讯官方号段 `2854xxxxxx`(10 位、2854 开头;线上「Q群管家」「是萌卡喵呢」都在里面)
//   ③ 消息里带 markdown / inline_keyboard 段 —— 只有 QQ 官方机器人有权限发这两种段
//      (线上 2854211260「是萌卡喵呢」发的就是 [at][markdown][inline_keyboard])
const BUILTIN_BOT_IDS = new Set(['2854196310', '2854196306']);
for (const id of String(process.env.BOT_IGNORE_IDS || '').split(/[,，\s]+/)) {
  const x = id.trim();
  if (x) BUILTIN_BOT_IDS.add(x);
}
const BUILTIN_BOT_ID_RE = /^2854\d{6}$/;
const BUILTIN_BOT_SEG_TYPES = new Set(['markdown', 'inline_keyboard']);
/** 这条消息是不是 QQ 自带的机器人发的。既吃 WS 事件(message 段),也吃 inbox 条目(segs)。 */
export function isQqBuiltinBot(msg) {
  const uid = String(msg?.user_id ?? '').trim();
  if (!uid || uid === BOT_ID) return false;      // 自己说的另有一条「不能自问自答」管
  if (BUILTIN_BOT_IDS.has(uid) || BUILTIN_BOT_ID_RE.test(uid)) return true;
  const segs = msg?.message || msg?.segs || [];
  return segs.some(s => BUILTIN_BOT_SEG_TYPES.has(String(s?.type ?? '')));
}
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
const META_TRIGGER = '环境';                                          // 环境饼图:近期环境 / 环境 10月 / 环境 9.1-9.15
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
const AI_CHAT_COOLDOWN_MS = Number(process.env.AI_CHAT_COOLDOWN_MS ?? 15000);   // 每人冷却,**0 = 关掉冷却**(2026-09-21 用户选了 0)
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
    tieba: process.env.TIEBA_ENABLED === '1',                      // 贴吧模式**总开关**(默认关;2026-09-28)
    tiebaGroups: {},                                              // 贴吧模式**分群**开关(群号 → true;'*' = 全部群)
    updatedAt: 0,
  };
}
// 贴吧模式的状态与 AI 闲聊**共用同一把 key**(需求第 6 条):没配 key 就两个都开不起来。
// 它的单一事实源是 agent/tieba/state.json(**每次现读**,与 modes.json / tone.json 同一套),
// features.json 里的 tieba / tiebaGroups 只是**镜像** —— 让运维台一页看得全、也方便人直接看文件。
// 写的时候两份都写(见 processTiebaSwitch),读的时候以 state.json 为准。
function syncTiebaFeature(on, groups = null) {
  if (typeof on === 'boolean') FEAT.tieba = on;
  if (groups) FEAT.tiebaGroups = groups;
  saveFeatures();
}
function loadFeatures() {
  const d = featDefaults();
  let f = null;
  try { f = JSON.parse(readFileSync(FEAT_FILE, 'utf8')); } catch { /* 缺失/损坏 → 用 .env 初值 */ }
  if (f) {
    if (typeof f.shitpost === 'boolean') d.shitpost = f.shitpost;
    if (typeof f.kuangshen === 'boolean') d.kuangshen = f.kuangshen;
    if (typeof f.ai === 'boolean') d.ai = f.ai;
    if (typeof f.tieba === 'boolean') d.tieba = f.tieba;
    if (f.tiebaGroups && typeof f.tiebaGroups === 'object') d.tiebaGroups = { ...f.tiebaGroups };
  }
  if (!AI_API_KEY) { d.ai = false; d.tieba = false; }   // 没配 key,开了也是白开(两者同一把 key)
  // 文件缺字段(老文件遇新开关)时补写一份:否则运维 WebUI 读到 undefined 会显示成 OFF,
  // 与实际运行状态不符,点开关也会对不上。
  if (!f || ['shitpost', 'kuangshen', 'ai', 'tieba'].some(k => typeof f[k] !== 'boolean') || typeof f.tiebaGroups !== 'object') {
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

// 原始判据:这条消息有没有 @ 机器人(不管发送者是谁)。拆出来是为了「带日志的忽略」
// —— WS 层要靠它认出「QQ 自带机器人 @ 了我」并打一行,而 isMentioningBot 已经把这类事件挡掉了。
function mentionsBotRaw(ev) {
  if ((ev.message || []).some(s => s.type === 'at' && String(s.data?.qq) === BOT_ID)) return true;
  if (new RegExp(`\\[CQ:at,qq=${BOT_ID}(?:,[^\\]]*)?\\]`).test(ev.raw_message || '')) return true;
  // 纯文本 @(QQ 端手动输入「@昵称」时没有 at 段,只有 text):@机器人昵称 或 @BOT_ID
  const raw = ev.raw_message || (ev.message || []).map(s => s.data?.text || '').join('');
  const nicks = [...botNicknames].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`@\\s*(?:${BOT_ID}|${nicks})`).test(raw);
}

/**
 * 统一入口:这条群消息该不该进 inbox 排队(补漏也走它)。
 * 2026-10-21 起多一道:QQ 自带机器人(群管家/入群欢迎/官方 bot)发来的 @ **不算 @** —— 不排队、不回复。
 */
function isMentioningBot(ev) {
  if (ev.post_type !== 'message' || ev.message_type !== 'group') return false;
  if (String(ev.user_id) === BOT_ID) return false;
  if (isQqBuiltinBot(ev)) return false;          // 自带机器人:一律不接,见 isQqBuiltinBot 上面的注释
  return mentionsBotRaw(ev);
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
const aiCooldown = new Map();   // uid -> 上次触发时间戳(仅在 AI_CHAT_COOLDOWN_MS > 0 时使用)

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

// 「换参数救不回来」的 4xx(2026-10-20 抽出来的):401 key 不对 / 402 余额不足 / 403 没权限 / 404 模型名不存在。
// 退让阶梯对这类错毫无作用,重试只会把 1 次失败放大成 4~5 次请求(事故里就是这么烧的)。
export function aiErrorIsPermanent(message) {
  return /^HTTP (401|402|403|404)\b/.test(String(message || ''));
}

/**
 * 闲聊调用(带「4xx 就退让」的阶梯)。
 * @param opts 透传给 aiChatOnce 的采样参数:temperature / maxTokens,以及
 *   **贴吧模式用的一组**(2026-09-28):`tools:false` + `webSearch:false` —— 一次都不联网,不必退让联网;
 *   `chatTag` 只改重试日志里的字(贴吧模式的重试别写成「AI 闲聊重试」,不然面板上分不清是谁在重试)。
 */
async function aiChat(system, userText, images = [], opts = {}) {
  const { chatTag = 'AI 闲聊', ...once } = opts;
  // 退让阶梯:先按默认档跑;碰到 4xx(参数/格式不认)依次退,最后连图一起去掉。
  // 换后端/换模型最容易踩的就是参数不认 —— 一个参数不能把整条闲聊弄挂。
  // 顺序讲究:① 去掉联网工具最可能救场(有的后端/模型不支持 function calling);
  //          ② 网页版 deepseek 支持思考模式下的工具调用,所以「不去工具、改开思考」也留一条;
  //          ③ 图片被后端拒(选了没视觉的模型)时最后去掉图,至少还能答字。
  const searchable = once.webSearch ?? AI_WEB_SEARCH;
  const ladder = [
    { ...once, webSearch: searchable, thinkOff: once.thinkOff ?? AI_THINK_OFF, images, tag: '' },
    ...(searchable ? [{ ...once, webSearch: false, images, tag: '去掉联网工具' }] : []),
    ...(searchable && AI_THINK_OFF ? [{ ...once, webSearch: true, thinkOff: false, images, tag: '联网+带思考' }] : []),
    ...(AI_THINK_OFF ? [{ ...once, webSearch: false, thinkOff: false, images, tag: '带上思考' }] : []),
    ...(images.length ? [{ ...once, webSearch: false, images: [], tag: '去掉图片' }] : []),
  ];
  let lastErr;
  for (const step of ladder) {
    try {
      if (step.tag) log(`  ${chatTag}重试(${step.tag})...`, '', C.dim);
      return await aiChatOnce(system, userText, step.images, step);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof AiHttpError) || !/^HTTP 4/.test(e.message)) throw e;
      // 401/402/403/404 是「key 不对 / 余额不足 / 没权限 / 模型名不存在」—— 退让阶梯(去工具、去思考、去图)
      // 对它们**一点救都没有**,只会把一次失败放大成 4~5 次请求。
      // 2026-10-20 事故的放大器就是这条:一轮失败打 4 个 402,整段日志里 2135 个 402 对应 6403 行重试。
      if (aiErrorIsPermanent(e.message)) {
        const hint = /^HTTP 402/.test(e.message) ? '(余额不足:去充值或换 key)' : '';
        log(`  ⚠ ${chatTag}后端拒绝 ${e.message.slice(0, 60)}${hint} 这类错换参数救不回来,不再重试`, '', C.red);
        throw e;
      }
    }
  }
  throw lastErr;
}

// ---------- 银河皇帝工具循环(2026-10-26) ----------
// 用户要求:表情包不再按概率发,改成模型能调的 send_sticker;同时给模型 DS 官方联网搜索、
// 图片搜索、下载表情包的权限。这里实现 OpenAI / DeepSeek function calling 循环:
//   模型要工具 → 本地执行(搜/挑图/下载) → 结果作为 tool 消息回填 → 模型接着写正文。
// 省钱/防刷护栏:搜索≤2、图片搜索≤2、下载≤1、一次最多安排2张表情包、工具轮数≤6。
const BELIAL_MAX_SEARCHES = Math.max(0, Number(process.env.BELIAL_MAX_SEARCHES || 2));
const BELIAL_MAX_IMAGE_SEARCHES = Math.max(0, Number(process.env.BELIAL_MAX_IMAGE_SEARCHES || 2));
const BELIAL_MAX_DOWNLOADS = Math.max(0, Number(process.env.BELIAL_MAX_DOWNLOADS || 1));
const BELIAL_SEARCH_COUNT = Math.min(10, Math.max(1, Number(process.env.BELIAL_SEARCH_COUNT || 5)));
const BELIAL_MAX_TOOL_ROUNDS = Math.max(1, Number(process.env.BELIAL_MAX_TOOL_ROUNDS || 6));

/** 单次工具循环(不带 4xx 退让;退让在 aiChatBelial 里做) */
async function runBelialToolLoop(entry, system, userText, images, allowTools, thinkOff) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: buildUserContent(userText, images) }];
  const stickers = [];
  let searches = 0, imageSearches = 0, downloads = 0;
  for (let round = 0; round < BELIAL_MAX_TOOL_ROUNDS; round++) {
    // 最后一轮不再挂工具,逼它用已有材料把正文写出来
    const withTools = allowTools && round < BELIAL_MAX_TOOL_ROUNDS - 1;
    const j = await postChat({
      model: AI_MODEL,
      messages,
      temperature: BELIAL_TEMPERATURE,
      max_tokens: BELIAL_MAX_TOKENS,
      ...(thinkOff ? { reasoning_effort: 'none' } : {}),
      ...(withTools ? { tools: BELIAL_TOOLS, tool_choice: 'auto' } : {}),
    }, '银河皇帝');
    const msg = j?.choices?.[0]?.message;
    if (!msg) throw new Error(`${AI_MODEL} 返回结构不对:${JSON.stringify(j).slice(0, 200)}`);
    const calls = (msg.tool_calls || []).filter(c => c?.function?.name);
    if (!calls.length) {
      const text = String(msg.content || '').trim();
      // 允许「只发表情包」:模型可以调完 send_sticker 后不写正文
      if (!text && !stickers.length) throw new Error(`${AI_MODEL} 返回空回复${round ? '(工具调用之后没接上话)' : ''}`);
      return { text, stickers };
    }
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    for (const c of calls) {
      const name = c.function?.name || '';
      const args = (() => { try { return JSON.parse(c.function?.arguments || '{}'); } catch { return {}; } })();
      let result = '';
      try {
        if (name === 'web_search') {
          const q = String(args.query || '').trim();
          if (searches >= BELIAL_MAX_SEARCHES) {
            result = `本次联网搜索次数已用完(${BELIAL_MAX_SEARCHES} 次),用已有材料回答。`;
          } else if (!q) {
            result = '搜索词为空,没有执行搜索。';
          } else {
            searches++;
            const r = await dsSearch(q, { count: BELIAL_SEARCH_COUNT, oriQuestion: args.ori_question || '', log });
            log('  🔎 DS搜索:', `${q} → ${r.ok ? `${r.count} 条(deepseek)` : r.error}`, r.ok ? C.dim : C.yellow);
            bumpSearchStat(r.ok, r.provider || 'deepseek');
            result = r.ok ? r.text : `搜索失败(${r.error})。没有搜到东西,按已有知识回答;不确定就直说。`;
          }
        } else if (name === 'list_stickers') {
          result = stickerCatalogText();
        } else if (name === 'send_sticker') {
          if (stickers.length >= BELIAL_MAX_STICKERS) {
            result = `本次已经安排了 ${BELIAL_MAX_STICKERS} 张表情包,别再发了。`;
          } else {
            const picked = belialResolveSticker({ name: args.name, scene: args.scene });
            if (!picked) result = '表情包库是空的,没图可发。';
            else if (stickers.includes(picked)) result = `《${picked}》已经安排过了,换一张或别发。`;
            else {
              stickers.push(picked);
              log('  🖼 安排表情包:', picked, C.dim);
              result = `已安排《${picked}》,会在文字回复后单独发。`;
            }
          }
        } else if (name === 'search_stickers') {
          const q = String(args.query || '').trim();
          if (imageSearches >= BELIAL_MAX_IMAGE_SEARCHES) {
            result = `本次图片搜索次数已用完(${BELIAL_MAX_IMAGE_SEARCHES} 次)。`;
          } else if (!q) {
            result = '图片搜索词为空。';
          } else {
            imageSearches++;
            const r = await searchStickerImages(q, { count: 6 });
            log('  🖼 搜图:', `${q} → ${r.ok ? `${r.count} 张` : r.error}`, r.ok ? C.dim : C.yellow);
            result = r.ok ? r.text : `图片搜索失败(${r.error})。`;
          }
        } else if (name === 'download_sticker') {
          const url = String(args.url || '').trim();
          if (downloads >= BELIAL_MAX_DOWNLOADS) {
            result = `本次下载次数已用完(${BELIAL_MAX_DOWNLOADS} 次)。`;
          } else if (!url) {
            result = '图片 URL 为空。';
          } else {
            downloads++;
            const r = await downloadStickerImage(url, args.name || '');
            log('  ⬇ 下载表情包:', r.ok ? `${r.name} (${Math.round(r.size / 1024)}KB)` : r.error, r.ok ? C.green : C.yellow);
            result = r.ok ? `已下载《${r.name}》,可以用 send_sticker 发它。` : `下载失败(${r.error})。`;
          }
        } else {
          result = `未知工具:${name}`;
        }
      } catch (e) {
        result = `工具执行失败:${e.message}`;
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 4000) });
    }
  }
  throw new Error(`工具调用轮数过多(${BELIAL_MAX_TOOL_ROUNDS} 轮)`);
}

/** 银河皇帝对话:带工具;碰到 4xx 依次退让(去工具 → 带思考 → 去图片) */
async function aiChatBelial(entry, system, userText, images = []) {
  const ladder = [
    { tools: true, thinkOff: !BELIAL_THINK, images, tag: '' },
    { tools: false, thinkOff: !BELIAL_THINK, images, tag: '去掉工具' },
    ...(BELIAL_THINK ? [{ tools: false, thinkOff: true, images, tag: '带上思考' }] : []),
    ...(images.length ? [{ tools: false, thinkOff: true, images: [], tag: '去掉图片' }] : []),
  ];
  let lastErr;
  for (const step of ladder) {
    try {
      if (step.tag) log(`  银河皇帝重试(${step.tag})...`, '', C.dim);
      return await runBelialToolLoop(entry, system, userText, step.images, step.tools, step.thinkOff);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof AiHttpError) || !/^HTTP 4/.test(e.message)) throw e;
      if (aiErrorIsPermanent(e.message)) throw e;
    }
  }
  throw lastErr;
}

// 图片按 OpenAI 多模态格式附在正文后面;**必须是 data URL**(data:image/jpeg;base64,...)——
// 实测传裸 base64 会被拒「Unsupported image_url format」(2026-09-17)。
function buildUserContent(text, images) {  if (!images?.length) return text;
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
 *
 * 采样参数与「挂不挂工具」现在可以按调用方覆盖(2026-09-28 加,给贴吧模式用):
 * 贴吧模式要的是**短、快、野** —— tools:false(一次都不搜)、temperature 更高、max_tokens 更小
 * (样例里贴吧鱼是短句连发,不是小作文)。注意别把 tools 与 webSearch 弄混:
 * webSearch 决定「要不要走联网退让阶梯」,tools 决定「这一路挂不挂工具」。
 */
async function aiChatOnce(system, userText, images = [], opts = {}) {
  const {
    webSearch = AI_WEB_SEARCH, thinkOff = AI_THINK_OFF, tools = webSearch,
    temperature = 0.8, maxTokens = AI_CHAT_MAX_TOKENS,
  } = opts;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: buildUserContent(userText, images) }];
  const maxSearches = tools ? AI_CHAT_MAX_SEARCHES : 0;
  let used = 0;
  for (let round = 0; ; round++) {
    // 预算用完就**停止挂工具**(不再给它搜的机会,逼它用已有材料作答)。
    // ⚠ 判据用「还能搜几次」而不是「跑了几轮」:一轮里模型可能一口气要搜 2 个词,次数照样会超;
    //   同一把尺子也用在下面执行搜索前,免得超预算的调用白花一次搜索钱。
    const withTools = used < maxSearches;
    const j = await postChat({
      model: AI_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
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
  if (belialParseCmd(text).triggered) return false;
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

// 冷却判定抽成小函数(2026-09-21):这样 `--aichat-selftest` 能**直接钉住**「0 = 关掉」这个语义,
// 不必去跑整条 processAiChat(那会真调模型、真发消息,自测里不能那么干)。
// 返回 0 = 放行(顺带记下本次时间戳);返回 >0 = 还要等多少毫秒。
function aiCooldownBlocked(uid, now = Date.now(), ms = AI_CHAT_COOLDOWN_MS) {
  if (!(ms > 0)) return 0;                        // 0(或配坏了)→ 不拦,也不记时间戳
  const last = aiCooldown.get(uid);
  if (last && now - last < ms) return ms - (now - last);
  aiCooldown.set(uid, now);
  return 0;
}

async function processAiChat(entry) {
  const uid = String(entry.user_id);
  // 银河皇帝模式:本群开着 + 有聊天 key。**必须在拼消息之前定** —— 提问正文里的「@你」
  // 称呼要跟着人格走(aichat 的 deps.botName),否则提示词里会看到「@你(史官)」这种旧身份。
  const belialPersona = belialOn(entry.group_id) && !!AI_API_KEY;
  // 冷却(2026-09-21 用户要求去掉):`AI_CHAT_COOLDOWN_MS=0` 即**彻底关闭** —— 连时间戳都不记,
  // 也就不会有「跳过时打的日志」和残留状态。默认仍是 15000(15s/人),所以想恢复只要改 .env 再重启,
  // 不用动代码(改的是启动期常量,必须重启才生效;面板 3 键只管开/关这个功能)。
  // ⚠ 关掉后没有节流:同一个人连点几下就会真调几次模型(联网时还会真搜几次),这是用户明确的取舍。
  const waitMs = aiCooldownBlocked(uid);
  if (waitMs > 0) {
    log('  AI 闲聊冷却中,本次不回', `${Math.ceil(waitMs / 1000)}s 后可再问(要关掉冷却:agent/.env 里设 AI_CHAT_COOLDOWN_MS=0)`, C.dim);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
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
      botName: belialPersona ? '贝利亚' : undefined,
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
  // 剥掉 @ 段标记(形如 [at])与多余空白 —— 只作用于**降级路径**(没有 segs 的老条目 / 解析失败时)。
  // 两条路都会被这个占位符碰到:AI 闲聊把它渲染成「@你(史官)」,贴吧模式渲染成「@你(贴吧鱼)」,
  // 两个都剥掉(以前只剥史官那个,贴吧模式下「@你(贴吧鱼)」会被当成提问正文,模型还以为是别人说的)。
  q = q.replace(/@你\((?:史官|贴吧鱼|贝利亚)\)/g, ' ').replace(/\s+/g, ' ').trim() || '(无文字,仅@)';
  // ===== 银河皇帝模式:开着就整条覆盖 @ 的回复(固定人格 + 工具调用 + 思考) =====
  // 放在贴吧模式之前:两个都开时,@ 的消息归银河皇帝;不 @ 的普通群聊仍归贴吧鱼(tiebaFire 那条路)。
  // 这条路的模型可以自己调:send_sticker(自主发表情包)、web_search(DS 官方搜索)、
  // search_stickers/download_sticker(找图/下图入库)。见 runBelialToolLoop。
  if (belialPersona) {
    log(`  ${AI_MODEL} 生成中 ...(人格:${BELIAL_PERSONA}${images.length ? `,含 ${images.length} 张图` : ''})`, '', C.dim);
    try {
      const result = await aiChatBelial(entry, belialSystemPrompt({
        now: nowText(),
        hasImages: images.length > 0,
        at: true,
        recent: belialRecent.get(String(entry.group_id)) || [],
      }), `${ctx}@你的人: ${entry.nickname}\nTA 的话: ${q}`, images);
      const head = (result.text || '(只发表情包)').replace(/\n/g, ' / ').slice(0, 80);
      log('  回复:', `${head}${result.stickers.length ? ` + 表情包 ${result.stickers.length} 张(${result.stickers.join('/')})` : ''}`, C.green);
      await sendBelialReply(entry, result.text, { stickers: result.stickers });   // 1~3 条 + 模型安排的表情包
      if (!DRY_RUN) bumpAiChatStat(entry, true);
    } catch (e) {
      log('  银河皇帝模式失败:', e.message, C.red);
      // 兜底也吞掉发不出去的错(与 AI 闲聊/贴吧模式同一条护栏,见 2026-10-20 事故)
      try { await sendReply(entry, '……卡了,等会儿。'); } catch (e2) { log('  兜底那句也发不出:', e2.message, C.red); }
      if (!DRY_RUN) bumpAiChatStat(entry, false);
    }
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  // 档位**每次请求现读**(tone.json 是热切的,运维台一点就生效;读几 KB 的 JSON 相比一次模型调用可忽略)
  const tone = getTone();
  // ===== 贴吧模式开着时,**这条 @ 的路整条被贴吧模式覆盖**(用户 2026-09-28 明确要求)=====
  // 为什么不是「再挂一段补充说明」:实测那样压不住 —— 提示词里只要还留着助手骨架(档位/工具/答疑语气),
  // 它就会滑回「我来帮你」「说吧,想聊什么」那套。所以直接把 system prompt 换掉、并在提示词里
  // 写死「你不是助手、只骂人不帮忙」(见 tieba.mjs 的 PERSONA),采样参数也换成嘴臭那一档。
  // 保留的只有:消息解析(@/引用/表情/图片)、上下文、记账、失败兜底 —— 那些是共用的管道。
  const tiebaPersona = tiebaOn(entry.group_id) && tiebaReady();
  if (tiebaPersona) {
    log(`  ${AI_MODEL} 生成中 ...(人格:${TIEBA_CN}/贴吧鱼${images.length ? `,含 ${images.length} 张图` : ''})`, '', C.dim);
    try {
      const raw = await aiChat(tiebaSystemPrompt({ now: nowText(), at: true, emoji: tiebaEmojiAllowed() }), `${ctx}@你的人: ${entry.nickname}\nTA 的问题: ${q}`, images, {
        chatTag: '贴吧模式', webSearch: false, tools: false,
        temperature: TIEBA_TEMPERATURE, maxTokens: TIEBA_MAX_TOKENS,
      });
      // 与自动接话同一套连发:随机抽这次发几条(1 条最多见)→ 拆 → 发出去(也**不 @ 触发者**)
      const want = tiebaPickCount();
      const parts = tiebaSplit(raw, { max: want });
      if (!parts.length) throw new Error('模型没说人话(空回复)');
      for (let i = 0; i < parts.length; i++) {
        if (i) await new Promise(r => setTimeout(r, TIEBA_GAP_MS));
        await sendGroupText(entry.group_id, parts[i]);
        log(`  贴吧模式连发 ${i + 1}/${parts.length}:`, parts[i], C.green);
      }
      if (!DRY_RUN) bumpAiChatStat(entry, true);
    } catch (e) {
      log('  贴吧模式(@)失败:', e.message, C.red);
      // ⚠ 兜底那句也发不出去时**必须吞掉**:2026-10-20 事故就是因为这里第二次抛出来,
      //   跳过了下面的 appendFileSync(PROCESSED) —— 那条消息于是永远不算「处理过」,被 15 秒一轮无限重试。
      try { await sendGroupText(entry.group_id, '行,你赢了,我没词了。'); } catch (e2) { log('  兜底那句也发不出:', e2.message, C.red); }
      if (!DRY_RUN) bumpAiChatStat(entry, false);
    }
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  log(`  ${AI_MODEL} 生成中 ...(档位 ${TONE_CN[tone]}${AI_WEB_SEARCH ? ',可联网' : ''}${images.length ? `,含 ${images.length} 张图` : ''})`, '', C.dim);
  try {
    let reply = await aiChat(aiSystem(images.length > 0, tone), `${ctx}@你的人: ${entry.nickname}\nTA 的问题: ${q}`, images);
    if (reply.length > AI_CHAT_MAX_CHARS) reply = reply.slice(0, AI_CHAT_MAX_CHARS) + '……';
    log('  回复:', reply.replace(/\n/g, ' ').slice(0, 60) + (reply.length > 60 ? '...' : ''), C.green);
    await sendReply(entry, reply);
    if (!DRY_RUN) bumpAiChatStat(entry, true);            // 记账:这条回复给了谁
  } catch (e) {
    log('  AI 闲聊失败:', e.message, C.red);
    // 同上:兜底提示语发失败**不能往外抛**,否则这条消息永远进不了 processed(见文件上方「事故」注释)。
    try { await sendReply(entry, '史官一时语塞,稍后再问。'); } catch (e2) { log('  兜底那句也发不出:', e2.message, C.red); }
    if (!DRY_RUN) bumpAiChatStat(entry, false);
  }
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ========== 银河皇帝模式(2026-10-26 新增) ==========
// 一句话:群里 **@机器人 说「银河皇帝」** → 本群切成「银河皇帝贝利亚」,@ 的回复全按这套人格走;
// 说「银河皇帝 关」切回。提示词、状态、表情包库都在 agent/belial/belial.mjs,这里只做接线。
//
// 与贴吧模式的优先级(两个都开时):
//   · @ 了机器人的消息 → **银河皇帝优先**(这是明确的身份切换,比贴吧的「@ 也归我管」更具体);
//   · 没 @ 的普通群聊 → 仍归贴吧鱼(银河皇帝只在 @ 时说话)。
//
// 2026-10-26 用户要求「可能回 1-3 句、表情包独立成句、符合真人发送习惯」:
//   · 文本拆成 1~3 条:第一条 @ 触发者,后续不 @,像真人补话;
//   · 表情包**只在模型调 send_sticker 时发**,单独一条,不再按概率/间隔自动发。
// 每群记最近说过的几条(防复读):下次生成时塞进系统提示词,让模型自己换说法,
// 而不是给一张固定回复表。用户 2026-10-26:「典型句式不要固定回复,也要过 ai 思考生成」。
const belialRecent = new Map();
function belialRemember(gid, lines) {
  const key = String(gid);
  const arr = belialRecent.get(key) || [];
  for (const l of lines || []) {
    const s = String(l || '').trim();
    if (s) arr.push(s);
  }
  while (arr.length > 8) arr.shift();
  belialRecent.set(key, arr);
}

/** 发一条纯图片消息(不 @ 人;表情包独立成句用) */
async function sendGroupImage(groupId, seg) {
  if (DRY_RUN) {
    log('  [DRY_RUN] 不发送(表情包): 模型安排了一张', '', C.yellow);
    return null;
  }
  if (isDeadGroup(groupId)) throw new DeadGroupError(`本群已被标记为不可发送,不再尝试: ${groupId}`);
  const r = await api('send_group_msg', { group_id: groupId, message: [seg] });
  if (r.status !== 'ok') throw sendFailure(r, groupId);
  return r.data?.message_id;
}

/**
 * 发一条银河皇帝回复:文本 1~3 条(第一条 @ 触发者,后续不 @),然后把模型通过
 * send_sticker 工具安排的表情包逐条单独发出去。模型没安排就不发图。
 * 用户 2026-10-26:「可能回复 1-3 句,表情包独立成句,符合真人发送习惯」。
 */
async function sendBelialReply(entry, text, { stickers = [] } = {}) {
  const gid = entry.group_id;
  const lines = text ? splitBelialReply(text, { max: BELIAL_MAX_REPLY }) : [];
  if (!lines.length && !stickers.length) throw new Error('模型没说人话(空回复)');
  for (let i = 0; i < lines.length; i++) {
    if (i) await new Promise(r => setTimeout(r, BELIAL_GAP_MS));
    if (i === 0) await sendReply(entry, lines[i]);      // 第一条 @ 触发者
    else await sendGroupText(gid, lines[i]);            // 后续不 @,像真人补话
    log(`  银河皇帝 ${i + 1}/${lines.length}:`, lines[i], C.green);
  }
  if (lines.length) belialRemember(gid, lines);          // 记进本群「最近说过」,防下一轮复读
  // 表情包:模型自己挑的,每条单独发;发不出去不影响文字
  for (const name of stickers.slice(0, BELIAL_MAX_STICKERS)) {
    await new Promise(r => setTimeout(r, BELIAL_GAP_MS));
    const seg = belialStickerSegment(name);
    if (!seg) { log('  银河皇帝表情包:', `${name} 已不存在,跳过`, C.yellow); continue; }
    try {
      await sendGroupImage(gid, seg);
      log('  银河皇帝表情包:', `${name}(单独一条)`, C.green);
    } catch (e) {
      log('  银河皇帝表情包发送失败:', e.message, C.yellow);
    }
  }
}

/** 启动横幅上那一段银河皇帝摘要(哪几个群开着、表情包几张) */
function belialStartupText() {
  if (!AI_API_KEY) return 'OFF(没配聊天 key)';
  const st = belialAll();
  const on = st.all ? ['全部群'] : st.groups.filter(g => g !== '*');
  return `${on.length ? on.join(',') : '全部关闭'}(表情包 ${belialStickers().length} 张,模型自主发,每次 ≤${BELIAL_MAX_STICKERS} 张)`;
}

/**
 * 群里的「银河皇帝 / 银河皇帝 开 / 银河皇帝 关」指令。
 * 激活台词是**固定的短句**(不叫模型),这样「输入关键词立刻换身份」稳定、不花钱;
 * 之后每一条 @ 才走模型(processAiChat 里的 belial 分支)。
 */
export async function processBelialSwitch(entry, cmd) {
  const gid = entry.group_id;
  const onNow = belialOn(gid);
  if (cmd.on === null) {                                   // 只喊「银河皇帝状态」→ 报状态(不带关闭提示)
    await sendReply(entry, belialStatus(onNow));
    return;
  }
  if (!cmd.on) {                                           // 关闭:任何时候都允许(不需要 key)
    const r = belialSetOn(gid, false);
    if (!r.ok) {
      await sendReply(entry, '……状态写不进去,稍后再试。');
      return;
    }
    log('  银河皇帝模式:', `${gid} → OFF`, C.green);
    await sendReply(entry, belialOff());
    return;
  }
  if (!AI_API_KEY) {
    await sendReply(entry, '……卡了,服务器没配聊天 key。');
    return;
  }
  if (!FEAT.ai) {
    await sendReply(entry, '……AI 闲聊总开关关着,开了也不回。');
    return;
  }
  if (onNow) {                                             // 已经开着:再喊一次就再登场一次
    await sendBelialReply(entry, belialAgain());
    return;
  }
  const r = belialSetOn(gid, true);
  if (!r.ok) {
    await sendReply(entry, '……状态写不进去,稍后再试。');
    return;
  }
  log('  银河皇帝模式:', `${gid} → ON(人格 ${BELIAL_PERSONA})`, C.green);
  await sendBelialReply(entry, belialActivation());
}

// ========== 贴吧模式(2026-09-28 新增,需求见 worklist-0928:功能注册名「贴吧模式」) ==========
// 一句话:开了之后**不用 @ 也会插嘴** —— 盯着群里的话,按概率接一句(还可能连发好几条),口吻照
// 测试群里那份「贴吧鱼」的聊天记录(骂人、短句、连楼、不 @ 人)。全部文案与拆分逻辑在 tieba/tieba.mjs,
// 这里只做四件事:① 实时把群消息塞进上下文缓冲 ② 判断该不该接 ③ 叫模型 ④ 连发出去。
//
// 为什么不能照搬 AI 闲聊那条路(几条关键差异,改之前先看):
//   · AI 闲聊**只处理 @ 消息**(entry 从 inbox 来);贴吧模式处理的是**没 @ 的普通群消息**,不进 inbox、
//     不写 processed.jsonl(它没有 seq 条目的概念),所以走 WS 层直接触发,与 processQueue 那条队列无关;
//   · AI 闲聊的回调 sendReply 会**先 @ 提问者**;贴吧模式**不许 @ 人**(用户明确定调),所以另走 sendGroupText;
//   · AI 闲聊要联网查证;贴吧模式把联网整个关掉(短、快、嘴臭,查证反而坏事);
//   · 用户明确说**不加冷却/限频** —— 所以这里没有 aiCooldown 那类节流,只在同一群正在生成时跳过并发。
const tiebaBusy = new Set();          // 正在生成的群(同一群同时只跑一条,避免几十条消息并发叫模型)
const tiebaInFlight = new Set();      // 正在等上下文渲染的消息 seq(渲染要下载图,慢;期间别重复触发)
let tiebaReplies = 0;                 // 本次运行接了几次话(面板/日志用,不落盘)
// 贴吧模式的「能不能跑」只看**有没有聊天 key**(需求第 6 条:与 AI 闲聊共用同一把 key)。
// ⚠ 刻意**不看 FEAT.ai**:面板 3 键关的是「@ 之后的兜底闲聊」,贴吧模式有自己的分群开关,两者不该捆在一起
//   (2026-09-28 定)。没 key 时两者都开不起来,所以 AI_API_KEY 必须查。
const tiebaReady = () => !!AI_API_KEY;

// 上下文缓冲:实时收到的每条群消息都记一份 —— 用户要的「群聊消息上下文窗口扩展」靠它,
// 比每条都去拉一次 OneBot 历史便宜得多(拉历史仍然会拉,见 tiebaContext,那是一次性补齐)。
function tiebaCollect(j) {
  const rawText = (j.message || []).map(s => s.type === 'text' ? (s.data?.text || '') : `[${s.type}]`).join('').trim();
  tiebaNote(j.group_id, {
    seq: j.message_seq ?? j.message_id,
    ts: j.time || Math.floor(Date.now() / 1000),
    uid: String(j.user_id ?? ''),
    nick: j.sender?.card || j.sender?.nickname || String(j.user_id ?? ''),
    text: rawText.slice(0, 300),
    segs: j.message || [],
  });
}

// 上下文窗口:缓冲(实时) + 一次历史拉取(补离线期间/启动前的),按 seq 去重后取最近 CTX 条。
// 拉历史失败**不影响**接话 —— 缓冲里通常已经有最近这些条(尽力而为,失败只记一行日志)。
async function tiebaContext(groupId) {
  let history = [];
  try {
    const { data } = await api('get_group_msg_history', { group_id: groupId, count: TIEBA_CTX_FETCH });
    history = (data?.messages || []).map(m => ({
      seq: m.message_seq ?? m.message_id,
      ts: m.time || 0,
      uid: String(m.user_id ?? ''),
      nick: m.sender?.card || m.sender?.nickname || String(m.user_id ?? ''),
      text: (m.message || []).map(s => segText(s, new Map())).join('').trim().slice(0, 300),
    }));
  } catch (e) {
    log('  贴吧模式拉历史失败(只用内存缓冲):', e.message, C.yellow);
  }
  return tiebaBuildContext(groupId, [...ringOf(groupId, TIEBA_CTX_FETCH), ...history], { botId: BOT_ID, n: TIEBA_CTX });
}

/**
 * 该不该接这一条。**所有「不接」的理由都写清楚**,因为线上就靠这几行日志判断行为对不对。
 * 排除项(用户 2026-09-28 定调 + 需求第 5 条):
 *   · 机器人自己的消息(一定不能接自己的话,否则自问自答)
 *   · **能进分流器的关键词消息**:那些消息正常走各功能(效果/卡图/裁定/每日一卡/史记总结/生成卡表/
 *     卡组解析/推荐/搬屎/框神语录/帮助/mode…),贴吧模式不抢;@ 了机器人的话又命中关键词 → 走功能,
 *     没命中关键词 → 交给 AI 闲聊(贴吧模式同样不抢,两条路都别打架)
 *   · 概率没过(默认 70%)
 *   · **只有「连文字带图都没有」才不接** —— 「碎话护栏」(以前 4 字以下不接)已被用户要求拆掉:
 *     现在「草」「煞笔」「?」照样掷骰子,纯表情/纯图也接(图能看懂,正好该损一句)。
 * @returns {Promise<boolean>} 是否真的开火(开火不阻塞调用方,别在 WS 回调里 await 它)
 */
export async function tiebaShouldReply(j, { rand = Math.random, log_ = true } = {}) {
  const gid = String(j.group_id);
  if (String(j.user_id) === BOT_ID) return false;                      // 自己说的
  if (isQqBuiltinBot(j)) return false;                                 // QQ 自带机器人(群管家/入群欢迎)说的——不接,2026-10-21
  // @ 了机器人的消息一律不接 —— 那些走 inbox/processQueue 那条分流器(AI 闲聊或某个功能)。
  // ⚠ 这道判断**必须在这里**(而不是只在 tiebaOnMessage 里):tiebaShouldReply 是导出的、自测也直接调它,
  //   判据集中在一处才不会出现「自测过的路」与「线上跑的路」不是同一条(2026-09-28 就在线上自测里露出来了:
  //   本机因为没配 key 提前返回,这条断言是「假过」的,线上有 key 才暴露)。
  if ((j.message || []).some(s => s.type === 'at' && String(s.data?.qq) === BOT_ID)) return false;
  if (!tiebaOn(gid) || !tiebaReady()) return false;                    // 本群没开 / 没配聊天 key
  if (isDeadGroup(gid)) return false;                                  // 本群已发不出去 → 别叫模型白花钱(2026-10-20)
  if (tiebaBusy.has(gid)) return false;                                // 上一句还在生成
  const rawText = (j.message || []).map(s => s.type === 'text' ? (s.data?.text || '') : '').join('').trim();
  const hasImage = (j.message || []).some(s => s.type === 'image' || s.type === 'mface');
  const worth = tiebaWorth({ text: rawText, hasImage });
  if (!worth.ok) return false;
  if (isKeywordMessage(j)) { if (log_) log('  ⏭ 贴吧模式跳过:', `关键词消息(走分流器)—「${rawText.slice(0, 24)}」`, C.dim); return false; }
  const at = (j.message || []).some(s => s.type === 'at' && String(s.data?.qq) === BOT_ID);
  const d = tiebaDecide({ text: rawText, hasImage }, { at, rand });   // ⚠ hasImage 要一起传,否则纯图会被二次拦掉
  if (!d.reply) { if (log_) log('  ⏭ 贴吧模式不接:', `${d.why} —「${rawText.slice(0, 24)}」`, C.dim); return false; }
  return true;
}

/**
 * 判定「这条消息会不会被别的功能接走」(= 分流器里的触发词)。
 * ⚠ 触发词改了**这里要跟着改**:漏一个,那个关键词就会被贴吧模式抢去乱骂(需求第 5 条专门写了这条)。
 * 与 backfillAiChatStats 的 looksLikeAiChat 是同一套判据(那边按 inbox 条目判、是回填统计用,不能直接复用)。
 */
export function isKeywordMessage(j) {
  const text = (j.message || []).map(s => s.type === 'text' ? (s.data?.text || '') : `[${s.type}]`).join('');
  const mode = modeOf(j.group_id);
  if (isHelpRequest(text)) return true;
  if (parseModeCommand(text).triggered) return true;
  if (belialParseCmd(text).triggered) return true;             // 「银河皇帝」自己也不接(走分流器)
  if (parseTiebaCmd(text).triggered) return true;              // 「贴吧模式 开/关」自己也不接
  if (text.includes(TRIGGER_KEYWORD)) return true;             // 史记总结
  if (text.includes(DAILY_KEYWORD)) return true;               // 每日一卡
  if (FEAT.kuangshen && text.includes(KUANGSHEN_TRIGGER)) return true;
  if (FEAT.shitpost && (text.includes(SHIT_TRIGGER) || text.includes(SHIT_AI_TRIGGER))) return true;
  if (mode === 'ygo') {
    if (parseTopSearch(text)) return true;                       // 上位卡组检索(上位 烙印 10月)
    if (parseMetaTrigger(text)) return true;                     // 环境饼图(近期环境 / 环境 10月)
    if (new RegExp(`${DECK_TRIGGER}[\\s\u3000]`).test(text)) return true;
    if (new RegExp(`${RULING_FULL_TRIGGER}[\\s\u3000]`).test(text)) return true;
    if (new RegExp(`${RULING_TRIGGER}[\\s\u3000]`).test(text)) return true;
  } else {
    if (text.includes(HS_DECK_TRIGGER)) return true;
    if (text.includes(HS_RECO_TRIGGER)) return true;
  }
  if (new RegExp(`${CARD_TRIGGER}[\\s\u3000]`).test(text)) return true;      // 效果 X(游戏王/炉石共用)
  if (new RegExp(`${CARD_IMG_TRIGGER}[\\s\u3000]`).test(text)) return true;  // 卡图 X
  return false;
}

/**
 * 开火:渲染那一条(复用 AI 闲聊的解析:@/引用/表情/图片) → 叫模型 → 把回复**按条连发**。
 * 全程不阻塞调用方(WS 消息处理只调一次、不 await),失败只打日志 —— 贴吧模式挂掉不能拖累别的功能。
 */
async function tiebaFire(j) {
  const gid = String(j.group_id);
  const uid = String(j.user_id);
  const msgs = j.message || [];
  const nick = j.sender?.card || j.sender?.nickname || uid;
  tiebaBusy.add(gid);
  const t0 = Date.now();
  try {
    const rawText = msgs.map(s => s.type === 'text' ? (s.data?.text || '') : '').join('').trim();
    log('💬 贴吧模式接话:', `[${j.group_name || gid}] ${nick}: ${rawText.slice(0, 40)}`, C.cyan);
    // ① 消息解析(与 AI 闲聊同一套):@/引用/表情/图 → 模型读得懂的正文;图直传(用户要的)
    let text = segText(msgs, new Map());
    let images = [];
    try {
      const rich = await buildAiQuestionRich(null, {
        segs: msgs,
        botId: BOT_ID,
        attachImages: TIEBA_IMAGES,        // 图直传;TIEBA_IMAGES=0 时只留 [图片] 占位(不下载)
        log: m => log(' ', m, C.dim),
        getMsg: id => api('get_msg', { message_id: id }),
        memberName: qq => resolveMemberName(gid, qq),
      });
      if (rich?.text) text = rich.text;
      images = rich?.images || [];
    } catch (e) {
      log('  贴吧模式消息解析失败(退回纯文本):', e.message, C.yellow);
    }
    // ② 上下文(内存缓冲 + 一次历史拉取)
    const ctx = await tiebaContext(gid);
    // ③ 叫模型:贴吧模式**不联网**、温度更高、上限更小(短句连发)
    // 表情这一条由**代码掷骰子**决定允不允许(约 25%,见 tieba.mjs 的 EMOJI_PROB):
    // 实测让提示词自己把握频率根本靠不住 —— 说「每两三条」它就一半带表情,说「每五条」它一条都不发。
    const sys = tiebaSystemPrompt({ now: nowText(), emoji: tiebaEmojiAllowed() });
    const user = `${ctx}\n\n[刚发出来的那条]\n${nick}: ${text}\n\n(${nick} 就是你要接话的人;直接写你要发的短句,一句一行,别 @ 任何人)`;
    const raw = await aiChat(sys, user, images, {
      chatTag: '贴吧模式', webSearch: false, tools: false,
      temperature: TIEBA_TEMPERATURE, maxTokens: TIEBA_MAX_TOKENS,
    });
    // ④ 连发:先**随机抽这次发几条**(1 条最多见,见 tieba.mjs 的 pickCount),再按这个上限拆;
    //    模型写了 3 行而这次抽中 1 条时,多出来的行会并进最后一条(并不下就丢),不会话说一半。
    const want = tiebaPickCount();
    const parts = tiebaSplit(raw, { max: want });
    if (!parts.length) { log('  贴吧模式:模型没说人话(空回复),这条不接', '', C.yellow); return; }
    for (let i = 0; i < parts.length; i++) {
      if (i) await new Promise(r => setTimeout(r, TIEBA_GAP_MS));
      await sendGroupText(j.group_id, parts[i]);
      log(`  贴吧模式连发 ${i + 1}/${parts.length}:`, parts[i], C.green);
    }
    tiebaReplies++;
    log('  贴吧模式完成:', `${parts.length} 条(抽中 ${want} 条上限),用时 ${Date.now() - t0}ms`, C.dim);
  } catch (e) {
    log('  贴吧模式失败:', e.message, C.red);      // 静默失败:群里没人 @ 它,回一句「失败」反而莫名其妙
  } finally {
    tiebaBusy.delete(gid);
  }
}

/** WS 层入口:贴吧模式的**唯一触发点**(@ 消息不进这里 —— 那些走 inbox/processQueue 那条路) */
export function tiebaOnMessage(j) {
  if (j.post_type !== 'message' || j.message_type !== 'group') return;
  if (String(j.user_id) === BOT_ID) return;
  if (isQqBuiltinBot(j)) return;                                                               // QQ 自带机器人:不进上下文、不接话
  if ((j.message || []).some(s => s.type === 'at' && String(s.data?.qq) === BOT_ID)) return;   // @ 了 → 走正常分流
  const gid = String(j.group_id);
  if (!tiebaOn(gid) || !tiebaReady()) return;
  tiebaCollect(j);                                   // 先入上下文缓冲,再判定(判定要读缓冲)
  const seq = j.message_seq ?? j.message_id;
  if (seq && tiebaInFlight.has(seq)) return;
  tiebaShouldReply(j).then(ok => {
    if (!ok) return;
    if (seq) tiebaInFlight.add(seq);
    tiebaFire(j).finally(() => { if (seq) tiebaInFlight.delete(seq); });
  }).catch(e => log('  贴吧模式判定失败:', e.message, C.red));
}

/** 群里的开关指令「贴吧模式 开 / 关」(在 processEntry 里调用;写 state.json + 镜像进 features.json) */
export function parseTiebaCmd(text) { return tiebaParseCmd(text); }

/** 启动横幅上那一段贴吧模式摘要:哪几个群开着、口径是多少(看一眼就知道线上什么状态) */
function tiebaStartupText() {
  if (!tiebaReady()) return 'OFF(没配聊天 key)';
  const st = allOn();
  const on = st.all ? ['全部群'] : st.groups.filter(g => g !== '*');
  const what = on.length ? on.join(',') : '全部关闭';
  // 概率**现读**(运维台滑杆改了就生效,不用重启)——所以横幅/群里提示都按当前值说,别报初值
  const p = Math.round(tiebaProbOf() * 100);
  return `${what}(概率 ${p}%,@ ${tiebaProbAtOf() >= 1 ? '必接' : `概率 ${Math.round(tiebaProbAtOf() * 100)}%`}且覆盖闲聊,上下文 ${TIEBA_CTX} 条,连发 ≤${TIEBA_MAX_REPLY} 条)`;
}

async function processTiebaSwitch(entry, cmd) {
  if (cmd.on === null) {
    const on = tiebaOn(entry.group_id);
    await sendReply(entry, `本群「${TIEBA_CMD}」现在是${on ? '开启' : '关闭'}。要改就发「${TIEBA_CMD} 开」或「${TIEBA_CMD} 关」。`);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  const r = tiebaSetOn(entry.group_id, cmd.on);
  if (r.ok) syncTiebaFeature(cmd.on, { ...(FEAT.tiebaGroups || {}), [String(entry.group_id)]: cmd.on });
  log('▶ 处理', `${entry.group_name} @${entry.nickname} [${TIEBA_CMD} ${cmd.on ? '开' : '关'}]`, C.cyan);
  const extra = cmd.on
    ? `本群从现在开始:群里说话**不用 @ 我**我也会接(概率约 ${Math.round(tiebaProbOf() * 100)}%,接了可能连发几条;怕吵就发「${TIEBA_CMD} 关」)。`
    : `本群「${TIEBA_CMD}」已关:以后只在你 @ 我的时候说话。`;
  await sendReply(entry, extra);
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ========== 贴吧模式 结束 ==========

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
// ⚠ 正文**不要加前置换行**(2026-09-28 用户反馈「发消息时多了一行空行」):
//   以前这里写的是 `{ text: '\n' + message }`,当时是为了让正文别跟 @ 段挤在一行 —— 但 OneBot/QQ 侧
//   已经把 at 段单独渲染,那个换行就变成了消息开头的一行空白。所有出站文本统一用 noLead() 削掉行首换行。
const noLead = s => String(s ?? '').replace(/^[\r\n]+/, '');

// ---------- 「这个群已经发不出去了」的判定与记忆(2026-10-20 事故之后加的) ----------
// 事故经过(bot 被踢出群的连锁反应,别再踩):
//   10-16 17:40 机器人被踢出群 556920058(次世代唐人街),群里最后一条 @ 消息(seq=3463161)从此**永远发不出去**。
//   而 processQueue 把任何失败都当成「临时失败」:15 秒重试一次,**每次重试都先叫一次模型、再发现发不出去**。
//   → 从 10-16 17:40 烧到 10-20,约 2.2 万轮(每轮一次 DeepSeek 调用),余额被烧干;后半程全是 402 还在空转。
// 三道护栏:
//   ① 发送返回「你已被移出该群」这类**明确不可恢复**的措辞 → 记住该 group_id,之后同群消息**连模型都不叫**,
//      直接标记已处理(见 processEntry 开头的 isDeadGroup 判断);
//   ② 同一条消息连续失败 ENTRY_MAX_FAILS 次 → 放弃并标记(见 processQueue),毒条目再也堵不住队列;
//   ③ 兜底提示语发送失败**不再往外抛**(见 processAiChat),否则那条消息永远进不了 processed。
const DEAD_GROUP_RE = /你已被移出该群|被移出该群|不在该群|不在群内|你不在本群|群不存在|该群已解散|已被踢出/;
class DeadGroupError extends Error {}
const deadGroups = new Set();                    // group_id(String) → 已确认不可发送
function isDeadGroup(gid) { return deadGroups.has(String(gid)); }
function markDeadGroup(gid, why = '') {
  const g = String(gid);
  if (deadGroups.has(g)) return;
  deadGroups.add(g);
  log('⛔ 该群已不可发送:', `${g} ${why.slice(0, 80)} —— 之后本群消息不再叫模型、直接跳过(把 bot 拉回群并重启 monitor 可恢复)`, C.red);
}
// 发送失败的统一出口:能用返回措辞判定「永久失败」就记住并抛 DeadGroupError,其余照旧抛普通 Error
function sendFailure(r, groupId) {
  const detail = JSON.stringify(r).slice(0, 160);
  if (DEAD_GROUP_RE.test(detail)) {
    markDeadGroup(groupId, detail);
    return new DeadGroupError(`发送失败(本群已不可发送,后续跳过): ${detail}`);
  }
  return new Error(`发送失败: ${detail}`);
}

async function sendReply(entry, message) {
  // 兼容三种形态: 字符串(文本) / 段数组(如文本+图片) / 单个段对象(如仅图片)
  const segs = Array.isArray(message)
    ? message
    : typeof message === 'string'
      ? [{ type: 'text', data: { text: noLead(message) } }]
      : [message];
  if (DRY_RUN) {
    const first = segs.find(s => s.type === 'text')?.data?.text || '(图片)';
    log(`  [DRY_RUN] 不发送: ${first.split('\n')[0].slice(0, 50)} ...`, '', C.yellow);
    return;
  }
  if (isDeadGroup(entry.group_id)) throw new DeadGroupError(`本群已被标记为不可发送,不再尝试: ${entry.group_id}`);
  const r = await api('send_group_msg', {
    group_id: entry.group_id,
    message: [
      { type: 'at', data: { qq: String(entry.user_id) } },
      // @ 段后补一个空格:2026-10-26 用户反馈,没有空格时 QQ 不会把 @ 真解析成 mention
      // (显示成普通文本)。空格是独立 text 段,不会进正文、也不会像换行那样多出空行。
      { type: 'text', data: { text: ' ' } },
      ...segs,
    ],
  });
  if (r.status !== 'ok') throw sendFailure(r, entry.group_id);
  log('  已发送', `message_id=${r.data?.message_id}`, C.green);
  return r.data?.message_id;                        // 供反馈机制关联
}

// ---------- 发送纯文本(不 @ 任何人;贴吧模式专用,2026-09-28) ----------
// 为什么必须另开一个:sendReply 会**先塞一个 at 段**(那是所有功能的约定:回复均 @ 触发者),
// 而贴吧模式用户明确定调「不 @ 被骂的人」—— 用 sendReply 会把每条回复都变成 @ 某人,群友被反复通知。
// 所以贴吧模式的连发走这里(同样**不加前置换行** —— 见上面 noLead 的说明)。
async function sendGroupText(groupId, text) {
  if (DRY_RUN) {
    log(`  [DRY_RUN] 不发送(贴吧模式): ${String(text).slice(0, 50)} ...`, '', C.yellow);
    return null;
  }
  if (isDeadGroup(groupId)) throw new DeadGroupError(`本群已被标记为不可发送,不再尝试: ${groupId}`);
  const r = await api('send_group_msg', {
    group_id: groupId,
    message: [{ type: 'text', data: { text: noLead(text) } }],
  });
  if (r.status !== 'ok') throw sendFailure(r, groupId);
  return r.data?.message_id;
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
  const segs = [{ type: 'text', data: { text } }];
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

// ---------- 环境饼图(2026-10-26):贴吧「上位卡组吧」按时间段统计上位卡组 ----------
// 用户要求:**只回一张带时间段标记的饼图,不 @、不多余说明**。所以这里走 sendGroupImage
// (纯图片段、不加 at 段),与其它功能「回复均 at 触发者」的约定相反(同贴吧模式/表情包)。
// 抓取与缓存都在 ygometa/meta.mjs:同时间段第二次问会直接命中缓存(不联网、不重画)。
async function processYgoMeta(entry, range, { pdf = false } = {}) {
  const t0 = Date.now();
  log('  环境饼图:', `「${range.label}」查缓存/抓取 ...${pdf ? '(要 PDF)' : ''}`, C.dim);
  try {
    if (pdf) {
      // 时间段后加 pdf → 只上传一份「饼图 + 三栏详细上位记录」PDF,不 @、不发文字
      const r = await buildMetaPdf(range, { log: m => log('   ', m, C.dim) });
      const name = `环境_${range.key.replace(/^m_/, '')}.pdf`;
      const up = await api('upload_group_file', { group_id: entry.group_id, file: r.pdfPath, name });
      if (up.status !== 'ok') throw new Error(`群文件上传失败: ${JSON.stringify(up).slice(0, 120)}`);
      const kb = (readFileSync(r.pdfPath).length / 1024).toFixed(0);
      log('  环境PDF已上传:', `${name} ${r.stats.entries} 副 / ${r.stats.posts} 场${r.cached ? ' [缓存]' : ''} ${kb}KB ${Date.now() - t0}ms`, C.green);
    } else {
      const r = await buildMetaPie(range, { log: m => log('   ', m, C.dim) });
      const seg = metaImageSegment(r.pngPath);
      await sendGroupImage(entry.group_id, seg);
      const kb = (readFileSync(r.pngPath).length / 1024).toFixed(0);
      log('  饼图已发送:', `${r.stats.entries} 副上位 / ${r.stats.posts} 场赛事 / ${r.stats.unique} 个主轴${r.cached ? ' [缓存]' : ''} ${kb}KB ${Date.now() - t0}ms`, C.green);
    }
  } catch (e) {
    // 抓取/画图/上传失败(极少数):正常路径只发图或文件,失败才补一句短文字。
    log('  环境饼图失败:', e.message, C.red);
    try { await sendGroupText(entry.group_id, pdf ? '环境PDF生成失败,稍后再试。' : '环境饼图生成失败,稍后再试。'); } catch { /* 发不出就算了 */ }
  }
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
}

// ---------- 「上位 卡组 [时间]」:本地找链接 + 抓原帖构筑图(2026-10-26) ----------
// 关键词只有「上位」,不依赖「环境」。成功时两条:第一条 时间/卡组/比赛/来源,第二条 构筑图。
async function processTopSearch(entry, q) {
  const t0 = Date.now();
  if (q.error) {
    try { await sendReply(entry, [{ type: 'text', data: { text: q.error } }]); } catch (e) { log('  上位检索提示发不出:', e.message, C.red); }
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  log('  上位检索:', `「${q.deck}」${q.range ? ` ${q.range.label}` : ' 最近'} ...`, C.dim);
  try {
    const r = await searchTopDeck(q.primary, q.range, { log: m => log('   ', m, C.dim) });
    if (!r) {
      const where = q.range ? q.range.label : '本地记录';
      await sendReply(entry, [{ type: 'text', data: { text: `没找到「${q.deck}」在${where}的上位构筑图,换个时间或卡组名再试。` } }]);
      appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
      return;
    }
    const list = Array.isArray(r.list) && r.list.length ? r.list : [{
      tid: r.thread.tid, entryName: r.entry.name, role: r.entry.role,
      date: r.eventDate || ymdDash(new Date(r.thread.create * 1000)),
      deck: r.entry.name, title: String(r.thread.title || '').replace(/\s+/g, ' ').trim(), url: r.url,
    }];
    const head = `上位「${q.deck || q.primary}」${q.range ? ` · ${q.range.label}` : ' · 最近'}（最近 ${list.length} 条）`;
    const lines = [head];
    list.forEach((x, i) => {
      const role = x.role && x.role !== '上位' ? `${x.role} · ` : '';
      lines.push(`${i + 1}. ${x.date} · ${role}${x.deck}`);
      lines.push(`   ${String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 70)}`);
      lines.push(`   ${x.url}`);
    });
    if (r.image) {
      const idx = list.findIndex(x => x.tid === r.thread.tid && x.entryName === r.entry.name && x.role === r.entry.role);
      if (idx >= 0) lines.push(`图片:第 ${idx + 1} 条`);
    } else {
      lines.push('（未找到可信的构筑图）');
    }
    const text = lines.join('\n');
    await sendReply(entry, [{ type: 'text', data: { text } }]);
    if (r.image) {
      await sendGroupImage(entry.group_id, { type: 'image', data: { file: `base64://${r.image.buf.toString('base64')}` } });
      log('  上位检索已发送:', `${r.eventDate || ''} ${r.entry.name} / ${list.length} 条 / 图片第 ${list.findIndex(x => x.tid === r.thread.tid && x.entryName === r.entry.name && x.role === r.entry.role) + 1} 条 / ${(r.image.buf.length / 1024).toFixed(0)}KB ${Date.now() - t0}ms`, C.green);
    } else {
      log('  上位检索已发送:', `${r.eventDate || ''} ${r.entry.name} / ${list.length} 条 / 仅文字(未找到可信构筑图) ${Date.now() - t0}ms`, C.green);
    }
  } catch (e) {
    log('  上位检索失败:', e.message, C.red);
    try { await sendReply(entry, [{ type: 'text', data: { text: '上位检索失败,稍后再试。' } }]); } catch { /* ignore */ }
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
  const segs = [{ type: 'text', data: { text: body } }];
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
  const segs = [{ type: 'text', data: { text } }];
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
export function buildHelpText(mode = 'ygo', groupId = '') {
  const shit = FEAT.shitpost
    ? `\n${SHIT_TRIGGER} — 随机搬一条史(封面截图)`   // AI 精选一搬未完善,暂不展示
    : '';
  const kuangshen = FEAT.kuangshen
    ? `\n${KUANGSHEN_TRIGGER} — 随机一条kkkm语录;\n${KUANGSHEN_TRIGGER} [关键词] — 按关键词检索语录`
    : '';
  const ai = FEAT.ai
    ? `\n\n没写指令也没关系 —— 随便 @ 我说点什么,史官直接接话(带图带表情包也认得出,引用别人的话我也看得见)。`
    : '';
  // ⚠ 帮助文本里**不写贴吧模式**(用户 2026-09-28 明确要求):那是运维侧/管理侧的能力,
  //   摆在群友看得见的说明书里等于教人怎么把它关掉,也显得像个待关的开关而不是「群里一个人」。
  //   (groupId 参数保留:以前这行给贴吧模式写过一段提示,现在虽然不用了,签名不改免得调用方跟着动。)
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
上位 卡组 [时间] — 查该卡组最近的上位构筑图,如「上位 烙印」「上位 烙印 10月」
${META_TRIGGER} [时间段] — 上位卡组环境饼图,如「${META_TRIGGER}」「${META_TRIGGER} 10月」「${META_TRIGGER} 9.1-9.15」;后面加 pdf 返回带三栏详细记录的 PDF
${DECK_TRIGGER} [卡组内容（ydk文本/卡组码/分享链接）] — 生成巡回赛PDF卡表
${CARD_TRIGGER} [卡名] — 查卡牌效果，如「${CARD_TRIGGER} 青眼白龙」
${CARD_IMG_TRIGGER} [卡名] — 查卡图，如「${CARD_IMG_TRIGGER} 青眼白龙」
${RULING_TRIGGER} [卡名] — 查官方裁定，返回部分
${RULING_FULL_TRIGGER} [卡名] — 查完整裁定${kuangshen}${shit}${ai}`;
}

// ---------- 处理单个请求 ----------
export async function processEntry(entry) {
  const text = entry.text || '';
  // 本群已被确认发不出去(被踢/解散)→ **直接标记已处理,连模型都不叫**。
  // 这是 2026-10-20 事故的第一道护栏:钱花在「叫模型」上,发不出去的群连叫都不该叫。
  if (isDeadGroup(entry.group_id)) {
    log('⏭ 跳过', `seq=${entry.seq} 群 ${entry.group_id} 已标记为不可发送(不叫模型)`, C.yellow);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  // QQ 自带的机器人(群管家/入群欢迎/官方 bot)发来的 @ **一律不接**(2026-10-21,判据见 isQqBuiltinBot)。
  // 这里挡的是 inbox 里已经躺着的旧条目(例如事故里那 5 条 Q群管家):不叫模型、不回话,直接标记已处理。
  if (isQqBuiltinBot(entry)) {
    log('⏭ 跳过', `seq=${entry.seq} 来自 QQ 自带机器人「${entry.nickname}」(${entry.user_id}),不回复`, C.yellow);
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  // 本群当前走哪个游戏的功能(默认游戏王);现读文件,所以运维台改完立即生效
  const mode = modeOf(entry.group_id);
  entry.mode = mode;                                // 帮助文本/日志用
  if (isHelpRequest(text)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [帮助]`, C.cyan);
    await sendReply(entry, buildHelpText(mode, entry.group_id));
    appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
    return;
  }
  // 「银河皇帝 / 银河皇帝 开|关」:切本群的隐藏人格(贝利亚)。与「mode …」「贴吧模式 …」同一类开关指令,
  // 放在分流器前段、不受本群当前开关限制(不然关掉之后就没法用关键词开回来了)。
  // 帮助文本里**不写**(用户要求),群友只能从运维台或口口相传知道。
  const belialCmd = belialParseCmd(text);
  if (belialCmd.triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [${BELIAL_CN}]`, C.cyan);
    await processBelialSwitch(entry, belialCmd);
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
  // 「贴吧模式 开 / 关」:切本群的全自动接话(状态存 tieba/state.json,与运维台同一个口子)。
  // 放在分流器最前面之一:它跟「mode …」一样是**开关类**指令,不受本群当前开关状态限制
  // (不然关掉之后就再也发不出「关」了 —— 虽然那种情况下贴吧模式本来也没在接话)。
  const tiebaCmd = parseTiebaCmd(text);
  if (tiebaCmd.triggered) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [${TIEBA_CMD}]`, C.cyan);
    await processTiebaSwitch(entry, tiebaCmd);
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
    // 「上位 烙印」/「上位 烙印 10月」→ 第一条文字(时间/卡组/比赛/来源)+ 第二条构筑图
    const top = parseTopSearch(text);
    if (top) {
      log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [上位检索:${top.deck || top.error || ''}]`, C.cyan);
      await processTopSearch(entry, top);
      return;
    }
    // 「近期环境」/「环境 10月」/「环境 9.1-9.15」→ 一张带时间段标记的上位卡组饼图。
    // 只认**整句开头**的触发词;后面的时间段解析不了就放行(「环境怎么样」仍然交给 AI 闲聊)。
    const meta = parseMetaTrigger(text);
    if (meta) {
      log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [环境饼图:${meta.range.label}${meta.pdf ? ' · PDF' : ''}]`, C.cyan);
      await processYgoMeta(entry, meta.range, { pdf: meta.pdf });
      return;
    }
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
// 失败计数(2026-10-20 加的):以前任何失败都只是「不标记、下一轮再试」——一条**永远做不完**的消息
// 就能把整个进程变成 15 秒一次的自动烧钱机(事故见 sendReply 上面的注释)。现在同一条最多试
// ENTRY_MAX_FAILS 次(默认 3,可用 env 调),到顶就放弃并标记已处理;毒条目再也堵不住队列。
const ENTRY_MAX_FAILS = Math.max(1, Number(process.env.ENTRY_MAX_FAILS || 3));
const entryFails = new Map();                 // seq → 本次进程内连续失败次数
function giveUpEntry(entry, why) {
  appendFileSync(PROCESSED, JSON.stringify(entry) + '\n');
  processedSeen.add(entry.seq);
  entryFails.delete(entry.seq);
  log('  → 放弃并标记为已处理', why, C.yellow);
}

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
      entryFails.delete(entry.seq);
    } catch (e) {
      if (e instanceof DeadGroupError) {           // 永久失败:这个群发不出去了,重试一万次也一样
        log('✗ 失败:', e.message, C.red);
        giveUpEntry(entry, '本群已不可发送,不再重试');
        continue;                                  // 继续处理后面的条目(别让一条毒消息挡住整队)
      }
      const n = (entryFails.get(entry.seq) || 0) + 1;
      entryFails.set(entry.seq, n);
      log('✗ 失败:', `${e.message}(${n}/${ENTRY_MAX_FAILS})`, C.red);
      if (n >= ENTRY_MAX_FAILS) {
        giveUpEntry(entry, `连续失败 ${n} 次,不再重试(免得 15 秒一次白烧 token;要改上限设 env ENTRY_MAX_FAILS)`);
        continue;
      }
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
    // QQ 自带机器人(群管家/入群欢迎/官方 bot)的消息一律丢在这里 —— 不写 inbox、不进贴吧/语录上下文。
    // 只在它确实 @ 了机器人的时候打一行(欢迎语平时也 @ 别人,不然面板会被刷屏)。
    // 2026-10-21 加:一整条事故链就是 Q群管家欢迎语 @ 它 → 回 @ → 管家回 @ → 又回(见 isQqBuiltinBot 注释)。
    if (j.post_type === 'message' && isQqBuiltinBot(j)) {
      if (mentionsBotRaw(j)) {
        log('⏭ 忽略 QQ 自带机器人 @', `[${j.group_name || j.group_id}] ${j.sender?.card || j.sender?.nickname || j.user_id}(${j.user_id})`, C.dim);
      }
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
      // 贴吧模式(2026-09-28):**不 @ 也接话**。同样在 @过滤之前 —— 它要的正是「没 @ 的那些话」。
      // 内部自己会把「@ 了机器人的消息」排除掉(那些归 inbox/processQueue 那条分流器)。
      try { tiebaOnMessage(j); } catch (e) { log('贴吧模式处理失败:', e.message, C.red); }
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

// ---------- 自测:处理队列的「不许无限重试」护栏(2026-10-20 加) ----------
// 事故:一条**永远发不出去**的消息(inbox 里有、processed 里没有)让 processQueue 每 15 秒重跑一次,
// 每次重跑都先叫一次模型 —— 4 天约 2.2 万次调用,余额烧干(详见 sendReply 上面那段注释)。
// 这套断言钉住三件「光读代码看不出来」的事,全离线、不联网、不发消息:
//   ① 「该群已不可发送」的措辞能认出来(真实 QQ 返回原样),而普通临时错误不会被误判成永久失败;
//   ② 认出永久失败后**记进 deadGroups**,下次同群直接跳过(processEntry 开头就是这么判的);
//   ③ 401/402/403/404 不再走退让阶梯(以前 402 会连打 4 次)。
// 用法:node monitor.mjs --queue-selftest
function queueSelftest() {
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; console.log(`${c ? '✓' : '✗'} ${m}`); };

  // ① 真实返回(线上原样,2026-10-16~20 每 15 秒出现一次)
  const real = { status: 'failed', retcode: 100, data: null,
    wording: 'send group message rejected: result=110 err=发送失败，你已被移出该群，请重新加群。' };
  const transient = { status: 'failed', retcode: 100, data: null, wording: 'send group message timeout' };
  ok(DEAD_GROUP_RE.test(JSON.stringify(real)), '被移出群的返回值 → 判为永久失败');
  ok(!DEAD_GROUP_RE.test(JSON.stringify(transient)), '普通超时/未知措辞 → 仍是临时失败(要重试)');

  // ② sendFailure 的两种出口,以及 deadGroups 的记忆
  const gid = 556920058;
  const e1 = sendFailure(real, gid);
  ok(e1 instanceof DeadGroupError, 'sendFailure(被移出的群) → DeadGroupError');
  ok(isDeadGroup(gid), `认出永久失败后记住这个群(${gid})`);
  ok(isDeadGroup(String(gid)), '群号用字符串查同样命中(内部统一 String)');
  const e2 = sendFailure(transient, 999);
  ok(!(e2 instanceof DeadGroupError) && !isDeadGroup(999), '普通失败不标记群、也不改异常类型');
  ok(isDeadGroup(gid) && !isDeadGroup(999), '两个群互不影响(只记认出来的那个)');

  // ③ 该群之后的消息在 processEntry 开头就被跳过 —— 断言「连模型都不叫」这一点:
  //    用 isDeadGroup 判据本身钉住(processEntry 第一句就是它,真跑会把条目写进 processed,这里不碰真文件)。
  ok(processEntry.toString().includes('isDeadGroup(entry.group_id)'), 'processEntry 开头有死群跳过判断(不叫模型)');

  // ④ 永久 4xx 不走退让阶梯
  ok(aiErrorIsPermanent('HTTP 402 Insufficient Balance'), '402 余额不足 → 判为永久(不再重试 4 次)');
  ok(aiErrorIsPermanent('HTTP 401 unauthorized'), '401 → 永久');
  ok(aiErrorIsPermanent('HTTP 404 model not found'), '404 → 永久');
  ok(!aiErrorIsPermanent('HTTP 400 invalid parameter'), '400 参数错 → 仍走退让阶梯(换参数可能救回来)');
  ok(!aiErrorIsPermanent('HTTP 500 bad gateway'), '500 → 不是 4xx,交给原来的逻辑');

  // ⑤ 放弃阈值本身
  ok(ENTRY_MAX_FAILS >= 1, `连续失败上限 ENTRY_MAX_FAILS=${ENTRY_MAX_FAILS}(≥1,可用 env 调)`);
  ok(typeof entryFails.get === 'function', 'entryFails 计数表就绪(processQueue 用它判「放弃」)');

  console.log(bad ? `\n✗ ${bad} 项不过` : '\n✓ 队列护栏自测全部通过');
  process.exit(bad ? 1 : 0);
}
if (process.argv.includes('--queue-selftest')) queueSelftest();

// ---------- 自测:QQ 自带机器人的 @ 一律不接(2026-10-21 加) ----------
// 钉住的都是「光读代码看不出」的事:哪些 uin/段算官方机器人、真人 @ 有没有被误伤、
// 以及 isMentioningBot(VS 入口)与 processEntry(inbox 入口)这两道真的都挡上了。
// 用法:node monitor.mjs --builtinbot-selftest(离线、不联网、不发消息)
function builtinBotSelftest() {
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; console.log(`${c ? '✓' : '✗'} ${m}`); };
  const ev = (o = {}) => ({
    post_type: 'message', message_type: 'group', group_id: 100000001, group_name: '自测群',
    user_id: 2854196310, sender: { nickname: 'Q群管家' },
    message: [{ type: 'at', data: { qq: BOT_ID } }, { type: 'text', data: { text: ' 欢迎新人！' } }],
    ...o,
  });

  // ① 判据:已知 uin / 官方号段 / 只有官方机器人才发得出的段
  ok(isQqBuiltinBot(ev()), 'Q群管家(2854196310) → 判为 QQ 自带机器人');
  ok(isQqBuiltinBot(ev({ user_id: 2854196306, sender: { nickname: 'QQ小冰' } })), 'QQ小冰(2854196306) → 自带机器人');
  ok(isQqBuiltinBot(ev({ user_id: 2854211260, sender: { nickname: '是萌卡喵呢' } })), '萌卡喵(2854211260,2854 号段) → 自带机器人');
  ok(isQqBuiltinBot(ev({ user_id: 2854196320 })), '同号段里没列出来的 uin 也按官方机器人处理(2854xxxxxx)');
  ok(isQqBuiltinBot(ev({
    user_id: 123456789,
    message: [{ type: 'at', data: { qq: BOT_ID } }, { type: 'markdown' }, { type: 'inline_keyboard' }],
  })), '带 markdown / inline_keyboard 段 → 只有 QQ 官方机器人发得出,当自带机器人');
  ok(!isQqBuiltinBot(ev({ user_id: 3344195836, sender: { nickname: 'W-13' } })), '普通群友(3344195836)不误伤');
  ok(!isQqBuiltinBot(ev({ user_id: Number(BOT_ID) })), '机器人自己不算(它由「不能自问自答」那条管)');
  ok(!isQqBuiltinBot(undefined), '空参数不炸、也不判成机器人');
  ok(BUILTIN_BOT_IDS.has('2854196310') && BUILTIN_BOT_IDS.has('2854196306'),
    `默认名单在:${[...BUILTIN_BOT_IDS].join(',')}(env BOT_IGNORE_IDS 可追加)`);

  // ② 两道入口:WS(含补漏)与 inbox 旧条目
  ok(isMentioningBot(ev()) === false, 'WS 入口:自带机器人 @ 它 → 不进 inbox(不排队、不回复)');
  ok(isMentioningBot(ev({ user_id: 3344195836, sender: { nickname: 'W-13' } })) === true, 'WS 入口:真人 @ 它 → 照常收(没有一刀切)');
  ok(isMentioningBot(ev({
    user_id: 2854196310, message: [{ type: 'text', data: { text: `@${BOT_ID} 在吗` } }],
  })) === false, 'WS 入口:自带机器人用纯文本「@昵称」@ 它也不收');
  ok(isQqBuiltinBot({ user_id: 2854196310, segs: [{ type: 'at', qq: BOT_ID }] }) === true,
    'inbox 条目形态(只有 segs)同样认得出来');
  ok(isQqBuiltinBot({ user_id: 3344195836, segs: [{ type: 'at', qq: BOT_ID }] }) === false,
    'inbox 条目形态:真人条目不误伤');
  // 与死群护栏同一手法:用源码断言钉住「processEntry 开头就挡」(真跑会写 processed,自测不碰真文件)
  ok(processEntry.toString().includes('isQqBuiltinBot(entry)'), 'processEntry 开头也挡一道(inbox 里的旧条目不会叫模型)');

  console.log(bad ? `\n✗ ${bad} 项不过` : '\n✓ QQ 自带机器人过滤自测全部通过');
  process.exit(bad ? 1 : 0);
}
if (process.argv.includes('--builtinbot-selftest')) builtinBotSelftest();

// ---------- 自测:贴吧模式(2026-09-28 加) ----------
// 钉住三件「光读代码看不出」的事,而且**不联网、不发消息、不花钱**:
//   ① 「哪些消息不接」的边界:机器人自己说的、碎话、**关键词消息**(需求第 5 条:那些正常走分流器)、
//      @ 了机器人的消息(那条走 AI 闲聊/功能,贴吧模式不抢)、没开贴吧模式的群;
//   ② 分群开关与概率语义:状态读写走真实的 state.json(指到临时文件,不碰线上那份)、rand 钉死;
//   ③ **整条出话链路**:mock 拦掉聊天请求与 OneBot 接口,喂一条普通群消息进 WS 层,验证它真的
//      「渲染上下文 → 叫模型 → 按条连发」,且发出去的段里**没有任何 @**(用户明确定调)。
// 用法:node agent/monitor.mjs --tieba-selftest
// ⚠ 「整条出话链路」要求本进程配了聊天 key(与 AI 闲聊共用 DEEPSEEK_API_KEY);本机没配就跳过并说明,
//   线上跑这条自测时会真跑(mock 掉的只是网络,不花钱)。
export async function tiebaSelftest() {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const lines = [];
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; lines.push(`${c ? '✓' : '✗'} ${m}`); };
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));

  // 状态文件:自测**不碰线上那份**,先把它指到临时目录再读写。
  // (每次调用都是现读,所以换路径立刻生效 —— 与 monitor 运行时行为一致。)
  const dir = mkdtempSync(join(tmpdir(), 'tieba-selftest-'));
  process.env.TIEBA_STATE_PATH = join(dir, 'state.json');
  const opened = tiebaSetOn(TIEBA_TEST_GROUP, true);
  ok(opened.ok && tiebaStatePath().includes('tieba-selftest-'), `状态写在临时文件里(不碰线上):${tiebaStatePath()}`);
  ok(tiebaOn(TIEBA_TEST_GROUP) === true, `测试群 ${TIEBA_TEST_GROUP} 已开(走真实的 state.json 读写)`);
  ok(tiebaOn('999999999') === false, '没开的群不上贴吧模式');
  ok(tiebaSetOn(TIEBA_TEST_GROUP2, true).on === true && tiebaOn(TIEBA_TEST_GROUP2) === true, '另一个群各记各的(分群参数)');
  ok(tiebaOn(TIEBA_TEST_GROUP) === true, '开了第二个群不影响第一个群');
  tiebaSetOn(TIEBA_TEST_GROUP2, false);
  ok(tiebaOn(TIEBA_TEST_GROUP2) === false, '关掉之后立刻不接手(现读文件,不用重启)');

  const load = (o) => {
    const e = {
      post_type: 'message', message_type: 'group', group_id: Number(TIEBA_TEST_GROUP),
      group_name: '自测群', user_id: 20001, sender: { card: '何如是' },
      message_seq: 1, message_id: 1, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: '' } }],
    };
    Object.assign(e, o);    e.raw_message = (e.message || []).map(s => s.type === 'text' ? s.data.text : `[CQ:${s.type}]`).join('');
    return e;
  };
  // ⚠ txt 只在调用方**没给** message 时才塞一条纯文本段 —— 原来写成 `{ ...o, message: [...] }`,
  //   于是调用方传的 at 段被**静默覆盖**掉:「@ 了机器人的消息不接」那条用例其实一直在测一条纯文本消息,
  //   本机(没 key,提前 return)还显示 ✓。2026-09-28 在线上自测里才露出来(命中at=false 一眼看破)。
  const txt = (t, o = {}) => {
    const e = load({ message: [{ type: 'text', data: { text: t } }], ...o });
    // hasImage 是从**段**里推出来的(与线上 tiebaShouldReply 同一口径)。⚠ 别再写先 txt() 再覆盖 message:
    // 那样推出来的 hasImage 会是 false,「纯图也接」那条用例就假红(2026-09-28 在本机/线上各栽一次)。
    e.hasImage = (e.message || []).some(s => s.type === 'image' || s.type === 'mface');
    return e;
  };
  const quiet = o => tiebaShouldReply(o, { log_: false });

  // ① 关键词消息一律不接(需求第 5 条)。**按当前环境的开关状态判**,别写死:
  //    框神语录/搬屎 关着的时候本来就不接管任何消息(它们的触发词也不该被当成关键词),
  //    炉石的「卡组解析/推荐」只在本群 mode=炉石 时才存在 —— 这两类要跟着环境走,否则本机自测必红。
  const KEYWORD_CASES = [
    ['效果 青眼白龙', '查卡'], ['卡图 白龙', '卡图'], ['每日一卡', '每日一卡'], ['史记总结', '史记'],
    ['帮助', '帮助'], ['/help', '帮助'], ['mode 炉石', '切模式'], ['生成卡表 x', '卡表'],
    ['裁定 增殖的G', '裁定'], ['完整裁定 增殖的G', '完整裁定'], ['贴吧模式 关', '贴吧模式自己'],
  ];
  for (const [t, why] of KEYWORD_CASES) ok(isKeywordMessage(txt(t)) === true, `关键词消息不接(${why}):「${t}」`);
  ok(isKeywordMessage(txt(SHIT_TRIGGER)) === FEAT.shitpost, `搬屎开着时才拦「${SHIT_TRIGGER}」(本进程 FEAT.shitpost=${FEAT.shitpost})`);
  ok(isKeywordMessage(txt(KUANGSHEN_TRIGGER)) === FEAT.kuangshen, `框神语录开着时才拦「${KUANGSHEN_TRIGGER}」`);
  // 炉石那两个触发词只在 mode=炉石 的群里存在。⚠ 别拿自测群去 setMode —— 那会**真的写 agent/modes.json**
  //   (污染线上配置)。用两个编出来的群号先设一遍,再判;收尾时删掉,不留痕迹。
  setMode(TIEBA_TEST_GROUP2, 'hs');
  ok(isKeywordMessage(txt(HS_DECK_TRIGGER, { group_id: Number(TIEBA_TEST_GROUP2) })) === true, `炉石模式下拦「${HS_DECK_TRIGGER}」`);
  ok(isKeywordMessage(txt(HS_RECO_TRIGGER, { group_id: Number(TIEBA_TEST_GROUP2) })) === true, `炉石模式下拦「${HS_RECO_TRIGGER}」`);
  setMode(TIEBA_TEST_GROUP2, 'ygo');
  ok(isKeywordMessage(txt(HS_DECK_TRIGGER, { group_id: Number(TIEBA_TEST_GROUP2) })) === false, `游戏王模式下不拦「${HS_DECK_TRIGGER}」(那是炉石专属)`);
  // 收尾:把刚才为自测写进 modes.json 的两个**编出来的群号**删掉(运维台的群列表里不该出现它们)
  try {
    const p = modesPath();
    const m = JSON.parse(readFileSync(p, 'utf8'));
    delete m[TIEBA_TEST_GROUP];
    delete m[TIEBA_TEST_GROUP2];
    writeFileSync(p + '.tmp', JSON.stringify(m, null, 2), 'utf8');
    renameSync(p + '.tmp', p);
  } catch { /* 删不掉就算了:那两个号不是真群,不影响功能,只是运维台多两行 */ }
  ok(isKeywordMessage(txt('这比玩意这么智能?')) === false, '普通吐槽不算关键词消息(该被贴吧模式接)');
  ok((await quiet(txt('效果 青眼白龙'))) === false && (await quiet(txt('每日一卡'))) === false, '走完整判定也不接关键词消息');
  // 「碎话护栏」已被用户 2026-09-28 拆掉:短话、纯表情、纯图都要照掷骰子(以前这几条断言是「不接」)。
  // ⚠ 这里用「必中」的随机数,否则 70% 会把断言变成看运气的。
  const always = () => 0.01;                        // 必中:断言「接不接」时必须钉死随机数,否则看运气
  const never = () => 0.99;
  ok(TIEBA_MIN_CHARS === 0, `碎话护栏默认关掉(TIEBA_MIN_CHARS=${TIEBA_MIN_CHARS},0 = 不按字数拦)`);
  // ⚠ 「短话/纯表情/纯图现在也接」要在**两道闸都过得了**的前提下断言:tiebaShouldReply 还会先查
  //   「有没有聊天 key」(tiebaReady),本机没配 key 时它永远返回 false —— 那正是本机第一次跑这几条时
  //   红掉的原因(不是护栏没拆)。所以:本机断言「值不值得接 + 概率判定」这两层,线上再跑一次整条链。
  ok(tiebaWorth({ text: '草' }).ok === true, '「草」这种短话算「值得接」(护栏已拆)');
  ok(tiebaWorth({ text: '煞笔' }).ok === true, '「煞笔」两个字也算值得接');
  ok(tiebaWorth({ text: '[表情:微笑]' }).ok === true, '纯表情算值得接');
  ok(tiebaWorth({ text: '[图片]', hasImage: true }).ok === true, '纯图算值得接(图能看懂,正好损一句)');
  ok(tiebaWorth({ text: '' }).ok === false, '真的什么都没有(无文字也无图)才不接');
  ok(tiebaDecide({ text: '草' }, { rand: always }).reply === true, '短话照样进概率判定并且掷中会接');
  ok(tiebaDecide({ text: '草' }, { rand: never }).reply === false, '短话也照样受 70% 概率约束(掷不中就静默)');
  if (tiebaReady()) {
    const willReply = o => tiebaShouldReply(o, { rand: always, log_: false });
    ok((await willReply(txt('草'))) === true, '线上整条链:「草」也接');
    ok((await willReply(txt('[表情:微笑]'))) === true, '线上整条链:纯表情也接');
    const imgCase = txt('', { message: [{ type: 'image', data: { url: 'u', file: 'f' } }] });
    const imgWorth = tiebaWorth({ text: '', hasImage: imgCase.hasImage });
    ok((await willReply(imgCase)) === true,
      `线上整条链:纯图也接(worth=${imgWorth.ok} 关键词=${isKeywordMessage(imgCase)} 群开着=${tiebaOn(imgCase.group_id)})`);
    ok((await willReply(txt(''))) === false, '线上整条链:真的什么都没有才不接');
  } else {
    ok(true, '跳过「线上整条链」的几条:本机没配聊天 key(tiebaReady=false),线上跑自测时会真跑');
  }
  ok((await quiet(txt('这比玩意这么智能?', { user_id: Number(BOT_ID) }))) === false, '机器人自己发的消息不接(不能自问自答)');
  ok((await quiet(txt('这比玩意这么智能?', { group_id: 999999999 }))) === false, '没开贴吧模式的群不接');
  const atCase = txt('这比玩意这么智能?', {
    message: [{ type: 'at', data: { qq: BOT_ID } }, { type: 'text', data: { text: ' 这比玩意这么智能?' } }],
  });
  // 顺带钉住「这条用例真的是 @ 消息」:helper 若是把段覆盖掉,这里会立刻现形(见 txt 的注释)
  ok(atCase.message.some(s => s.type === 'at' && String(s.data?.qq) === BOT_ID) && !isKeywordMessage(atCase),
    '构造出来的确实是「@ 了机器人且无关键词」的消息(不是纯文本)');
  ok((await quiet(atCase)) === false, '@ 了机器人的消息不接(那条走 AI 闲聊/功能分流)');

  // ② 概率:把随机数钉死,别靠运气(改的是全局 Math.random,这一段结束立刻还原)。
  // ⚠ tiebaShouldReply 还会先过「有没有聊天 key」那道闸(tiebaReady),本机没配 key 时它永远是 false ——
  //   所以这里**绕过那个闸直接测概率函数**,不然本机的自测会红一条,看着像概率坏了。
  const realRandom = Math.random;
  const decide = (t, at, r) => tiebaDecide({ text: t }, { at, rand: r });
  try {
    Math.random = () => 0.99;
    ok((await quiet(txt('这比玩意这么智能?'))) === false, '掷出 0.99 → 不接(概率 0.7)');
    Math.random = () => 0.01;
    ok(decide('这比玩意这么智能?', false, Math.random).reply === true, '掷出 0.01 → 接');
  } finally { Math.random = realRandom; }
  ok(tiebaReady() || !AI_API_KEY, `没配聊天 key 时贴吧模式整条不开(与 AI 闲聊共用同一把 key):tiebaReady=${tiebaReady()}`);
  ok(decide('这比玩意这么智能?', false, () => 0.01).reply === true, '概率判定本身照常工作(与 key 无关)');
  ok(decide('草', false, () => 0.01).reply === true, '短话照样进概率判定(护栏已拆)');
  ok(Math.abs(TIEBA_PROB - 0.7) < 1e-9, `概率的 env 初值仍是需求里的 70%(TIEBA_PROB=${TIEBA_PROB})`);
  ok(TIEBA_AT_PROB === 1, `@ 的 env 初值仍是必接(TIEBA_AT_PROB=${TIEBA_AT_PROB})`);
  // 概率现在存在 state.json 里(运维台滑杆可调),这里钉住读写与「现读生效」
  const p0 = tiebaProbOf();
  ok(tiebaSetProb({ prob: 0.33 }).prob === 0.33 && tiebaProbOf() === 0.33, '概率可写可读(滑杆走的就是这条路)');
  ok(tiebaDecide({ text: '这比玩意这么智能?' }, { rand: () => 0.4 }).reply === false
    && tiebaDecide({ text: '这比玩意这么智能?' }, { rand: () => 0.3 }).reply === true,
    '改完立刻生效:0.33 时掷 0.4 不接、掷 0.3 接(不用重启)');
  ok(tiebaSetProb({ prob: 1.5 }).prob === 1 && tiebaSetProb({ prob: -1 }).prob === 0, '越界值被夹到 0~1');
  tiebaSetProb({ prob: 0.7, probAt: 1 });
  ok(tiebaProbOf() === 0.7 && p0 === 0.7, `自测收尾把概率还原成 ${p0}`);

  // ②b 「开了贴吧模式的群里 @ 也走这套人格」(用户 2026-09-28:开了模式就覆盖闲聊)。
  //     钉的是**提示词本身**:身份前提不许留助手骨架,且必须写死「不帮忙」。
  const atPrompt = tiebaSystemPrompt({ now: 'x', at: true });
  ok(!/客服|助手|AI/.test(atPrompt.split('不是')[0] || '') , '提示词开头没有把助手/客服当前提');
  ok(/你\*\*不是\*\*助手、不是客服、不是机器人、不是 AI/.test(atPrompt), '身份前提被明确否定(不是助手/客服/机器人/AI)');
  ok(/一点忙都不许帮/.test(atPrompt) && /不给信息、不给建议/.test(atPrompt), '写死了「只骂人不帮忙」(覆盖闲聊的关键)');
  ok(/他问正事你也只回骂|就算他问的是正事/.test(atPrompt), '明确:正经问题也只回骂');
  ok(/当面 @ 你/.test(atPrompt), '@ 那条路会多一句「别切回答疑语气」');
  ok(!/当面 @ 你/.test(tiebaSystemPrompt({ now: 'x' })), '自动接话那条路不带这句(按不 @ 的口径说话)');
  ok(tiebaOn(TIEBA_TEST_GROUP) === true && tiebaReady() === !!AI_API_KEY, '「是否覆盖闲聊」的判据 = 本群开着 + 有 key');

  // ③ 整条出话链路:mock 掉聊天请求与 OneBot 接口(mock 只拦网络,不花钱;逻辑全是真的)
  const aiReady = tiebaReady();
  if (!aiReady) {
    ok(true, '跳过「整条出话链路」:本机没配 DEEPSEEK_API_KEY(正常;线上跑这条自测时会真跑)');
  }
  const realFetch = globalThis.fetch;
  const posted = [];
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u === AI_API_URL) {
      posted.push(body);
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '智能你妈了个逼\n没见过世面搁这狗叫' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/127\.0\.0\.1|localhost/.test(u)) {          // OneBot HTTP:历史 / 发送 / 群成员都在这儿拦
      if (body.action === 'send_group_msg') { sent.push(body.params); return new Response(JSON.stringify({ status: 'ok', data: { message_id: 42 } }), { status: 200 }); }
      if (body.action === 'get_group_msg_history') {
        return new Response(JSON.stringify({ status: 'ok', data: { messages: [
          { message_seq: 900, message_id: 900, time: Math.floor(Date.now() / 1000) - 60, user_id: 20002, sender: { card: '还没睡' },
            message: [{ type: 'text', data: { text: '你妈守灵呢' } }] },
        ] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'ok', data: {} }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const trigger = txt('这比玩意这么智能?', { message_seq: 777, message_id: 777 });
    const rand2 = Math.random;
    Math.random = () => 0.01;                       // 让这条路一定开火
    try {
      tiebaOnMessage(trigger);
      for (let i = 0; i < 40 && !sent.length; i++) await sleepMs(100);   // 等异步链路(渲染 + mock 模型)
      await sleepMs(1500);                                              // 等第二条连发(条间有间隔)
    } finally { Math.random = rand2; }

    if (aiReady) {
      ok(posted.length >= 1, `mock 模型被调用了(${posted.length} 次)`);
      const p = posted[0] || {};
      ok(!p.tools, '贴吧模式的请求**不带联网工具**(一次都不搜)');
      ok(p.temperature === TIEBA_TEMPERATURE, `采样温度用的是贴吧模式那档:${p.temperature}`);
      const sys = String(p.messages?.[0]?.content || '');
      ok(/贴吧鱼/.test(sys) && /脏话/.test(sys), '系统提示词是贴吧鱼那一套');
      const user = String(p.messages?.[1]?.content || '');
      ok(user.includes('这比玩意这么智能?'), '用户消息带上了触发的那句话');
      ok(user.includes('还没睡') && user.includes('你妈守灵呢'), '用户消息带上了历史上下文(窗口机制真的在工作)');
      // ⚠ 条数现在是**随机抽**的(1 条最多见),所以这里不能写死「2 条」——只断言 1..上限 之间,
      //   精确的条数与并句行为在 tieba.mjs 的自测里用钉死的随机数验(见那边的 pickCount 用例)。
      ok(sent.length >= 1 && sent.length <= TIEBA_MAX_REPLY, `连发条数落在 1..${TIEBA_MAX_REPLY} 之间(随机抽):${sent.length} 条`);
      ok(sent.every(s => (s.message || []).every(seg => seg.type === 'text')), '连发出去的全是纯文本段');
      // 2026-09-28 用户反馈「发消息时多了一行空行」:出站正文一律不许带前置换行(见 noLead)
      const leads = sent.map(s => String(s.message?.[0]?.data?.text || ''));
      ok(leads.every(t => t && !/^[\r\n]/.test(t)), `贴吧模式的连发不带前置换行:${JSON.stringify(leads.map(t => t.slice(0, 8)))}`);
      ok(sent.every(s => !(s.message || []).some(seg => seg.type === 'at')), '**回复里没有任何 @ 段**(用户明确定调)');
      ok((sent[0]?.message?.[0]?.data?.text || '').includes('智能你妈了个逼'), `第一条内容对得上:${sent[0]?.message?.[0]?.data?.text?.trim()}`);
    }
  } catch (e) {
    ok(false, `整条链路跑失败:${e.message}`);
  } finally { /* fetch 的还原挪到下面 @ 覆盖那段之后(两段共用同一个 mock) */ }

  // ③b 「开了贴吧模式的群里 @ 也走这套人格」(用户 2026-09-28:开了模式就覆盖闲聊)。
  //     这条路走的是 processAiChat(不是 tiebaFire),所以必须**单独钉一次**:
  //     否则「@ 之后又滑回史官助手口吻」这种回归没人看得见(用户就是这么发现第一版的)。
  if (aiReady) {
    try {
      posted.length = 0; sent.length = 0;
      const atEntry = {
        seq: 888, message_id: 888, time: Math.floor(Date.now() / 1000),
        group_id: Number(TIEBA_TEST_GROUP), group_name: '自测群', user_id: 20001, nickname: 'W-13',
        text: '煞笔[at]', targets: [String(BOT_ID)],
      };
      await processAiChat(atEntry);
      ok(posted.length >= 1, `@ 那条路也叫了模型(${posted.length} 次)`);
      const sys = String(posted[0]?.messages?.[0]?.content || '');
      ok(/你\*\*不是\*\*助手、不是客服、不是机器人、不是 AI/.test(sys), '@ 之后用的仍是贴吧鱼人格(没有滑回史官助手)');
      ok(!/赛博史官|档位/.test(sys), '提示词里没有史官/档位那套骨架');
      ok(/当面 @ 你/.test(sys), '@ 这条路带上了「别切回答疑语气」那句');
      ok(posted[0]?.temperature === TIEBA_TEMPERATURE && !posted[0]?.tools, `@ 这条路也用嘴臭那档采样参数(temp=${posted[0]?.temperature},不挂工具)`);
      ok(sent.length >= 1 && sent.length <= TIEBA_MAX_REPLY,
        `@ 的回复条数同样在 1..${TIEBA_MAX_REPLY} 之间且不带 @(${sent.length} 条)`);
      // 顺带钉住出站文本的通用规矩:sendGroupText / sendReply 都不许加前置换行
      ok(sent.every(s => s.message?.[0]?.data?.text && !/^[\r\n]/.test(s.message[0].data.text)),
        '@ 那条路的出站正文同样不带前置换行');
      ok(noLead('\n\n喂') === '喂' && noLead('喂') === '喂' && noLead('') === '', 'noLead 只削行首换行、不动正常正文');
    } catch (e) {
      ok(false, `@ 覆盖那一段跑失败:${e.message}`);
    }
  } else {
    ok(true, '跳过「@ 覆盖闲聊」链路:本机没配 DEEPSEEK_API_KEY(线上跑这条自测时会真跑)');
  }
  globalThis.fetch = realFetch;
  tiebaSetOn(TIEBA_TEST_GROUP, false);            // 收尾:临时文件里的开关也关掉

  console.log(lines.join('\n'));
  console.log(bad ? `\n✗ ${bad} 项不过` : '\n✓ 贴吧模式自测全部通过(mock 掉的只有网络,未发任何消息)');
  process.exitCode = bad ? 1 : 0;
}
// 自测用的测试群号(**编出来的号**,不碰任何真实群:临时状态文件里只开了它们)
export const TIEBA_TEST_GROUP = '100000001';
export const TIEBA_TEST_GROUP2 = '100000002';
if (process.argv.includes('--tieba-selftest')) tiebaSelftest();

// ---------- 自测:银河皇帝模式(2026-10-26 加) ----------
// 钉住「光读代码看不出」的几件事,不联网、不发真消息:
//   ① 群指令真的会切分群状态(临时 state.json),「银河皇帝」不会被别的功能抢走;
//   ② 激活/关闭/查状态都会回一条消息(固定台词,不叫模型、不花钱);
//   ③ 本群开着时,@ 那条路用的是贝利亚提示词 + 中二采样、不挂联网工具,回复后面会附表情包。
// 用法:node agent/monitor.mjs --belial-selftest
// ⚠ 第 ③ 条要求本进程配了聊天 key(与 AI 闲聊共用 DEEPSEEK_API_KEY);本机没配就跳过并说明。
export async function belialSelftest() {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const lines = [];
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; lines.push(`${c ? '✓' : '✗'} ${m}`); };
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));

  const dir = mkdtempSync(join(tmpdir(), 'belial-selftest-'));
  process.env.BELIAL_STATE_PATH = join(dir, 'state.json');
  process.env.BELIAL_STICKER_DIR = join(dir, 'stickers');
  process.env.BELIAL_STICKER_GAP_MS = '0';       // 自测里关掉「两次表情包间隔」,否则断言会被 60s 卡住
  const GID = '100000003';                       // 编出来的测试群号,不碰真实群

  // 放一张最小的 PNG 当表情包(和 belial.mjs 自测同一张,32x32)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANklEQVR4nO3NMQEAMAjEwKeqK6IikFoJYWHLCUjqvs6ms1qPgwEHyAFygBwgB8gBcoAcIAchH3JrAeTJv+L3AAAAAElFTkSuQmCC', 'base64');
  const added = belialAddSticker(png, 'selftest.png');
  ok(added.ok && belialStickers().length === 1, `临时表情包库里有 1 张(${added.name})`);

  // 指令:关键词消息必须被分流器认出来(否则会被贴吧模式抢走)
  const cmd = t => belialParseCmd(t);
  ok(cmd('银河皇帝').triggered && cmd('银河皇帝').on === true, '「银河皇帝」被识别为召唤');
  ok(cmd('银河皇帝模式').on === true && cmd('银河皇帝贝利亚').on === true, '「银河皇帝模式 / 银河皇帝贝利亚」也直接召唤');
  ok(cmd('银河皇帝 关').on === false, '「银河皇帝 关」被识别为关闭');
  ok(isKeywordMessage({ message: [{ type: 'text', data: { text: '银河皇帝' } }] }) === true, '银河皇帝是关键词消息(贴吧模式不抢)');
  ok(isKeywordMessage({ message: [{ type: 'text', data: { text: '银河皇帝 关' } }] }) === true, '银河皇帝 关也是关键词消息');
  // 源码级断言:分流器与 @ 分支真的接上了(只读代码看不出来有没有接线,这条能防回退)
  ok(processEntry.toString().includes('belialParseCmd(text)') && processEntry.toString().includes('processBelialSwitch'),
    'processEntry 的分流器接了「银河皇帝」');
  ok(processAiChat.toString().includes('belialPersona') && processAiChat.toString().includes('belialSystemPrompt'),
    'processAiChat 里有银河皇帝分支(提示词真的换了)');

  // 切换指令:mock 掉 OneBot 发送,验证「回消息 + 状态真的翻」
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (/127\.0\.0\.1|localhost/.test(String(url)) && body.action === 'send_group_msg') {
      sent.push(body.params);
      return new Response(JSON.stringify({ status: 'ok', data: { message_id: 7 } }), { status: 200 });
    }
    if (/127\.0\.0\.1|localhost/.test(String(url))) {
      return new Response(JSON.stringify({ status: 'ok', data: {} }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const entry = {
    seq: 999999001, message_id: 999999001, time: Math.floor(Date.now() / 1000),
    group_id: Number(GID), group_name: '自测群', user_id: 30001, nickname: '何如是',
    text: '银河皇帝',
  };
  // sendReply 会在最前面塞一个 at 段 + 一个空格段,所以正文不是 message[0] —— 别按 index 0 断言
  const msgText = p => ((p && p.message) || [])
    .filter(s => s.type === 'text' && String(s.data?.text || '').trim())
    .map(s => String(s.data.text).trim())
    .join('');
  const hasAt = p => ((p && p.message) || []).some(s => s.type === 'at' && String(s.data?.qq) === String(30001));
  const hasImage = p => ((p && p.message) || []).some(s => s.type === 'image');
  const realRandom0 = Math.random;
  try {
    Math.random = () => 0;                        // 表情包抽签必中,断言别靠运气
    ok(belialOn(GID) === false, '自测群初始是关的');
    await processBelialSwitch(entry, { on: false });
    ok(belialOn(GID) === false && sent.length === 1, '「银河皇帝 关」回一条消息、状态仍是关');
    sent.length = 0;
    await processBelialSwitch(entry, { on: null });
    ok(sent.length === 1 && /本大爷|还没开/.test(msgText(sent[0])) && !/想关|银河皇帝 关/.test(msgText(sent[0])),
      '「银河皇帝状态」只报状态,不再带关闭提示');
    sent.length = 0;
    if (!AI_API_KEY) {
      await processBelialSwitch(entry, { on: true });
      ok(belialOn(GID) === false && /没配聊天 key/.test(msgText(sent[0])), '没配聊天 key 时拒绝激活并说明原因');
    } else if (!FEAT.ai) {
      await processBelialSwitch(entry, { on: true });
      ok(belialOn(GID) === false && /AI 闲聊.*总开关/.test(msgText(sent[0])), 'AI 闲聊总开关关着时拒绝激活并说明原因');
    } else {
      await processBelialSwitch(entry, { on: true });
      ok(belialOn(GID) === true, '有 key 时「银河皇帝」真的把本群打开');
      ok(sent.length === 1 && !hasImage(sent[0]), `激活回复只发文本,表情包由模型决定(${sent.length} 条)`);
      ok(hasAt(sent[0]) && /贝利亚/.test(msgText(sent[0])), '激活第一条 @ 触发者且带身份');
    }
  } catch (e) {
    ok(false, `切换指令那段跑失败:${e.message}`);
  } finally {
    Math.random = realRandom0;
  }

  // ③ @ 那条路:真走 processAiChat,但模型与 OneBot 都被 mock 掉(不花钱)
  //    注意这里**不看 FEAT.ai**:processAiChat 是 @ 之后的兜底,调用方(processEntry)已经判过总开关;
  //    自测直接调它,是为了钉住「提示词/采样/附表情包」这三件事。
  if (!AI_API_KEY) {
    ok(true, '跳过「@ 那条路」:本机没配 DEEPSEEK_API_KEY(线上跑自测时会真跑)');
  } else {
    const posted = [];
    sent.length = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) : {};
      if (u === AI_API_URL) {
        posted.push(body);
        // 第一次:模型决定调 send_sticker;第二次:工具结果回填后写正文
        if (posted.length === 1) {
          return new Response(JSON.stringify({
            choices: [{ message: {
              role: 'assistant', content: '',
              tool_calls: [{
                id: 'call_sticker_1', type: 'function',
                function: { name: 'send_sticker', arguments: JSON.stringify({ scene: '被叫肺雾很急' }) },
              }],
            } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '删了\n这不是我' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (/127\.0\.0\.1|localhost/.test(u)) {
        if (body.action === 'send_group_msg') { sent.push(body.params); return new Response(JSON.stringify({ status: 'ok', data: { message_id: 8 } }), { status: 200 }); }
        if (body.action === 'get_group_msg_history') {
          return new Response(JSON.stringify({ status: 'ok', data: { messages: [
            { message_seq: 900, message_id: 900, time: Math.floor(Date.now() / 1000) - 60, user_id: 30002, sender: { card: '还没睡' },
              message: [{ type: 'text', data: { text: '贝利亚你个废物' } }] },
          ] } }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'ok', data: {} }), { status: 200 });
      }
      return realFetch(url, init);
    };
    const realRandom = Math.random;
    try {
      Math.random = () => 0;                    // 表情包抽签必中,断言「附了图」时别靠运气
      belialSetOn(GID, true);
      await processAiChat({
        seq: 999999002, message_id: 999999002, time: Math.floor(Date.now() / 1000),
        group_id: Number(GID), group_name: '自测群', user_id: 30001, nickname: '何如是',
        text: '你说谁废物?[at]', targets: [String(BOT_ID)],
      });
      ok(posted.length === 2, `@ 那条路叫了两次模型(工具调用 + 正文,${posted.length} 次)`);
      const p = posted[0] || {};
      const sys = String(p.messages?.[0]?.content || '');
      ok(/银河皇帝贝利亚/.test(sys) && !/赛博史官/.test(sys), '系统提示词换成了贝利亚,没有史官骨架');
      ok(/彻底忘记自己当过助手/.test(sys) && /没有「帮助用户」的职责/.test(sys), '提示词要求忘记助手身份,只当贝利亚');
      ok(/反应方向/.test(sys) && /别原样照抄/.test(sys) && /本大爷/.test(sys) && /肺雾/.test(sys), '提示词是反应方向,不是固定回复表');
      ok(/佐菲你出息了啊/.test(sys) && /还早了两万年/.test(sys), '提示词带原剧/贝利亚黄昏台词库');
      ok(Array.isArray(p.tools) && p.tools.some(t => t.function?.name === 'send_sticker')
        && p.tools.some(t => t.function?.name === 'web_search')
        && p.tools.some(t => t.function?.name === 'download_sticker'), '挂了发表情包/搜索/下载工具');
      const toolMsg = (posted[1]?.messages || []).find(m => m.role === 'tool');
      ok(/已安排/.test(String(toolMsg?.content || '')), '工具结果回填给了模型(已安排表情包)');
      ok(p.temperature === BELIAL_TEMPERATURE, `采样温度用的是银河皇帝那档:${p.temperature}`);
      ok(p.max_tokens === BELIAL_MAX_TOKENS, `max_tokens 跟着 BELIAL_MAX_TOKENS 走:${p.max_tokens}`);
      ok(BELIAL_THINK ? !('reasoning_effort' in p) : p.reasoning_effort === 'none',
        `思考模式按 BELIAL_THINK=${BELIAL_THINK} 走${BELIAL_THINK ? '(不塞 reasoning_effort=none)' : '(塞 reasoning_effort=none)'}`);
      const user = String(p.messages?.[1]?.content || '');
      ok(user.includes('你说谁废物?'), '用户消息带上了触发的那句话');
      ok(user.includes('贝利亚你个废物'), '用户消息带上了群聊上下文');
      ok(sent.length === 3, `2 句文字 + 1 条表情包 = 3 条(${sent.length} 条)`);
      ok(hasAt(sent[0]) && msgText(sent[0]) === '删了', '第一条 @ 触发者,内容是第 1 句');
      ok(!hasAt(sent[1]) && msgText(sent[1]) === '这不是我', '第二条不 @ 人,是第 2 句(像真人补话)');
      ok((sent[2]?.message || []).length === 1 && hasImage(sent[2]), '第 3 条是纯表情包,独立成句');
      ok(sent.every(s => !(((s.message || []).some(x => x.type === 'text')) && hasImage(s))), '没有任何一条把文字和表情包挤在一起');
    } catch (e) {
      ok(false, `@ 那条路跑失败:${e.message}`);
    } finally {
      Math.random = realRandom;
    }
  }

  globalThis.fetch = realFetch;
  belialSetOn(GID, false);
  console.log(lines.join('\n'));
  console.log(bad ? `\n✗ ${bad} 项不过` : '\n✓ 银河皇帝模式自测全部通过(mock 掉的只有网络,未发任何消息)');
  process.exitCode = bad ? 1 : 0;
}
if (process.argv.includes('--belial-selftest')) belialSelftest();

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

  // ④b 冷却语义(2026-09-21:用户要求去掉冷却,所以「0 = 关掉」必须真的成立)
  ok(AI_CHAT_COOLDOWN_MS === 0 || AI_CHAT_COOLDOWN_MS > 0, `冷却设置可读:${AI_CHAT_COOLDOWN_MS}ms${AI_CHAT_COOLDOWN_MS > 0 ? `(${AI_CHAT_COOLDOWN_MS / 1000}s/人)` : '(已关闭)'}`);
  const t0c = 1_800_000_000_000;
  ok(aiCooldownBlocked('u1', t0c, 0) === 0 && aiCooldownBlocked('u1', t0c + 1, 0) === 0, '冷却=0 时连续两次都放行(真·关闭)');
  ok(aiCooldownBlocked('u2', t0c, 15000) === 0, '冷却=15000 时第一次放行');
  ok(aiCooldownBlocked('u2', t0c + 5000, 15000) === 10000, '5 秒后再来被拦,且剩余时间算对');
  ok(aiCooldownBlocked('u2', t0c + 15000, 15000) === 0, '满 15 秒后放行');
  ok(aiCooldownBlocked('u3', t0c, 15000) === 0 && aiCooldownBlocked('u4', t0c, 15000) === 0, '冷却是按人各算各的(不同 uid 互不影响)');

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

// 环境饼图自测(离线:时间段解析 / 触发词 / 卡组归一化 / 榜单 vs 个人战报)
if (process.argv.includes('--ygometa-selftest')) metaSelftest();

// 环境饼图·测试群实发:node monitor.mjs --ygometa-send <群号> [触发词]
// 走完整 processEntry 分流(与群里 @ 同一条路),只是省掉 QQ 收消息那一步;
// 用来在测试群验证「真的发得出去、发的只有一张图」。不启动 WS。
if (process.argv.includes('--ygometa-send')) {
  const i = process.argv.indexOf('--ygometa-send');
  const gid = String(process.argv[i + 1] || '').trim();
  const text = process.argv.slice(i + 2).join(' ').trim() || '近期环境';
  if (!gid) {
    console.error('用法: node monitor.mjs --ygometa-send <群号> [触发词]');
    process.exitCode = 1;
  } else {
    const entry = {
      seq: Number(String(Date.now()).slice(-9)),
      group_id: gid,
      user_id: BOT_ID,
      nickname: '环境饼图自测',
      group_name: `自测群(${gid})`,
      text,
    };
    processEntry(entry)
      .then(() => { console.log(`\n✓ 已把「${text}」发到群 ${gid}`); process.exitCode = 0; })
      .catch(e => { console.error('\n✗ 发送失败:', e.stack || e.message); process.exitCode = 1; });
  }
}

// 启动参数 --backfill-aichat-stats [YYYY-MM-DD]:回填 AI 闲聊统计后直接退出(不连 WS)
if (process.argv.includes('--backfill-aichat-stats')) {
  backfillAiChatStats(process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)));
}

// 仅「直接运行」时启动服务:被别的脚本 import 进来(如临时诊断脚本)时不该连 WS、不该抢 tmux 面板。
// 自测/回填那几个参数也一并排掉 —— 它们自己 process.exit,但会让 main() 先跑起来(连 WS、打启动横幅),
// 2026-09-21 就踩到:跑 --aichat-selftest 时面板与「WS 错误」一起冒出来,看着像自测把机器人弄挂了。
const ASKIP = ['--aichat-selftest', '--selftest-at', '--backfill-aichat-stats', '--tieba-selftest', '--belial-selftest', '--queue-selftest', '--builtinbot-selftest', '--ygometa-selftest', '--ygometa-send'];
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
log(`${DRY_RUN ? '[DRY_RUN] ' : ''}QQ Agent 监控终端启动 (bot=${BOT_ID} | ${TRIGGER_KEYWORD}=史记 | ${CARD_TRIGGER}=查卡 | ${CARD_IMG_TRIGGER}=卡图 | ${RULING_TRIGGER}=官裁 | ${RULING_FULL_TRIGGER}=裁定PDF | ${DAILY_KEYWORD}=每日一卡 | ${META_TRIGGER}=环境饼图 | AI闲聊=${FEAT.ai ? `${AI_MODEL}(${TONE_CN[getTone()]},上下文 ${AI_CHAT_CTX} 条,图片直传一轮,联网=${AI_WEB_SEARCH ? searchProviderText() : '关闭'},冷却=${AI_CHAT_COOLDOWN_MS > 0 ? `${AI_CHAT_COOLDOWN_MS / 1000}s/人` : '关'})` : 'OFF'} | 贴吧模式=${tiebaStartupText()} | 银河皇帝模式=${belialStartupText()} | 功能开关见面板 1/2/3)`, '', C.cyan);
}   // ← main() 到这儿结束:进程主体只在「直接运行本文件」时执行
