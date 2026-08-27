// QQ Agent 一体化监控终端 (console)
// 由 start.bat 在新窗口启动。功能:
//   1. WS 监听 @机器人 → 写入 inbox.jsonl (去重)
//   2. 处理队列:拉最近100条 → claude -p 生成史记体回复 → 发送 → 标记 processed
//   3. 按键控制:q = 退出(仅本进程)  Q = 退出并停 SnowLuma
// 退出时清理自身拉起的 claude 子进程(按 PID,不影响其他 claude 会话)。
//
// 用法: node monitor.mjs   (可用 DRY_RUN=1 试运行,不真正发消息)
// 配置: 下方常量或环境变量覆盖

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { queryAndFormat, reloadCards, getCardsPath, extractZipCardJson, loadCards, formatCard, searchCards, cardImageSegment } from './ygocard/ygocard.mjs';
import { downloadImages } from './ygocard/download_images.mjs';
import { pickShit, buildCardHtml, buildVideoCardHtml, pickVideoShit, renderCard, pngToSegment, appendShitVideo, addToBlacklist, removeFromShitVideos } from './shitpost/shitpost.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载本地 .env(含 token 等敏感配置;.env 被 .gitignore 排除,不入库)
try {
  const envText = readFileSync(join(__dirname, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// ---------- 配置 ----------
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
const DAILY_KEYWORD = process.env.DAILY_KEYWORD || '每日一卡';      // 每日一卡触发词(同 id 24h 内不换卡)
const SHIT_TRIGGER = process.env.SHIT_TRIGGER || '随机一搬';        // 搬屎触发词:纯规则筛选,发截图
const SHIT_AI_TRIGGER = process.env.SHIT_AI_TRIGGER || '精选一搬';  // 搬屎触发词:规则粗筛 + AI 精挑
const SHIT_ENABLED = process.env.SHIT_ENABLED === '1';              // 搬屎功能总开关(默认关闭,暂不上线)
const SHIT_EXAMPLES_PATH = process.env.SHIT_EXAMPLES_PATH
  || 'C:/Users/hp/.claude/projects/C--Users-hp-Desktop---mc-agent/memory/shitpost-examples.md'; // 搬屎记忆样本库
const DAILY_STATE_FILE = join(__dirname, 'daily_card.json');
const INBOX = join(__dirname, 'inbox.jsonl');
const PROCESSED = join(__dirname, 'processed.jsonl');
const POLL_MS = 15000;          // 处理队列轮询间隔
const CLAUDE_TIMEOUT_MS = 120000; // claude -p 超时
const DRY_RUN = process.env.DRY_RUN === '1';
const RECONNECT_BASE_MS = 2000;
const CARDS_ZIP_URL = 'https://ygocdb.com/api/v0/cards.zip';      // 卡库更新源(百鸽)
const CARDS_MD5_URL = 'https://ygocdb.com/api/v0/cards.zip.md5';

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
    case 'face': return '[表情]';
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
  for (const m of msgs.reverse()) {
    if (String(m.user_id) === BOT_ID) continue;
    const t = new Date(m.time * 1000);
    const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const text = (m.message || []).map(s => segText(s, names)).join('').trim();
    if (!text) continue;
    lines.push(`${hhmm} ${names.get(m.user_id) || nameOf(m.sender)}|${text}`);
  }
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
  return `你是 QQ 群里的"赛博史官"机器人,专以史记体文言文(如"太史公曰")回答群友。收到群消息记录(格式 "HH:MM 昵称|内容")和@你的问题。

规则:
- 默认情况:用一句(最多两句)文言史记体总结最近群聊,诙谐生动,浓缩梗与人物
- 若是提问(你是谁/某梗是什么/讨论什么):用文言答问,同样简洁
- 只输出回复正文,不要引号、不要"at"前缀、不要多余解释
- 太史公曰 开头
${targetText}
群消息记录(最近100条):
${transcript}

@者: ${trigger.nickname}
@者提问: ${trigger.text.replaceAll(TRIGGER_KEYWORD, '').replace(/^\[at\]\s*/, '').trim() || '(无文字,仅@)'}`;
}

// ---------- 卡库更新(下载 → md5 校验 → 解压 → 原子替换 → 重载) ----------
let updatingDb = false;
async function updateCardDb() {
  if (updatingDb) { log('卡库更新进行中,忽略本次触发', '', C.yellow); return; }
  updatingDb = true;
  try {
    log('卡库更新:下载 cards.zip ...', '', C.cyan);
    const [zipRes, md5Res] = await Promise.all([
      fetch(CARDS_ZIP_URL),
      fetch(CARDS_MD5_URL).catch(() => null),
    ]);
    if (!zipRes.ok) throw new Error(`下载失败 HTTP ${zipRes.status}`);
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
// WS 表情回应事件(notice_type=group_msg_emoji_like)
// 挥手 👋(emoji 129)= 负反馈 → 黑名单 + 移出源库;其他表情 = 正反馈投票 → 达标入库
function handleEmojiLike(j) {
  const pid = j.message_id ?? j.message_seq;
  const uid = String(j.operator_id ?? j.user_id);
  if (!pid || String(uid) === BOT_ID) return;
  const pending = loadPendingShits();
  const hit = pending.find(p => p.message_id === pid || p.message_seq === pid);
  if (!hit) return;
  pending.splice(pending.indexOf(hit), 1);               // 无论正负反馈,先移出待反馈
  const likes = (j.likes || []).map(x => String(x.emoji_id));
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
}

// ---------- 处理单个请求 ----------
async function processEntry(entry) {
  const text = entry.text || '';
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
  if (SHIT_ENABLED && text.includes(SHIT_AI_TRIGGER)) {
    log('▶ 处理', `${entry.group_name} @${entry.nickname} seq=${entry.seq} [精选一搬]`, C.cyan);
    await processShitPost(entry, true);
    return;
  }
  if (SHIT_ENABLED && text.includes(SHIT_TRIGGER)) {
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
  const shitTriggers = SHIT_ENABLED ? ` / "${SHIT_TRIGGER}" / "${SHIT_AI_TRIGGER}"` : '';
  log('⏭ 跳过', `seq=${entry.seq} @${entry.nickname} 无触发词("${TRIGGER_KEYWORD}" / "${DAILY_KEYWORD}"${shitTriggers} / "${CARD_TRIGGER} " / "${CARD_IMG_TRIGGER} "): ${text.slice(0, 30)}`, C.dim);
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
    log('停止 SnowLuma (端口 3000) ...', '', C.yellow);
    try {
      const { execSync } = await import('node:child_process');
      execSync('for /f "tokens=5" %a in (\'netstat -ano ^| findstr ":3000 .*LISTENING"\') do taskkill /PID %a /F', { shell: 'cmd.exe' });
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
    if (key.name === 'q') {
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
  return {
    seq,
    message_id: j.message_id,
    time: j.time || Math.floor(Date.now() / 1000),
    group_id: j.group_id,
    group_name: j.group_name || '',
    user_id: j.user_id,
    nickname: j.sender?.card || j.sender?.nickname || String(j.user_id),
    text: (j.message || []).map(s => s.type === 'text' ? s.data.text : `[${s.type}]`).join('').slice(0, 200),
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
    for (const g of (data || [])) if (!groups.includes(g.group_id)) groups.push(g.group_id);
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
      handleEmojiLike(j);                                 // 搬屎反馈:点赞 → 入库
      return;
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

log(`${DRY_RUN ? '[DRY_RUN] ' : ''}QQ Agent 监控终端启动 (bot=${BOT_ID} | ${TRIGGER_KEYWORD}=史记 | ${CARD_TRIGGER} 卡名=查卡 | ${CARD_IMG_TRIGGER} 卡名=查卡图 | ${DAILY_KEYWORD}=每日一卡+图 | ${SHIT_ENABLED ? `${SHIT_TRIGGER}=搬屎 | ${SHIT_AI_TRIGGER}=AI精选屎 | ` : ''}u=更新卡库)`);
