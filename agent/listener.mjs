// QQ Agent 消息监听器
// 连接 SnowLuma OneBot WebSocket (3001),检测 @机器人 的群消息,
// 写入 inbox.jsonl 供上层 Agent(Claude Code 会话)处理。
//
// 用法: node listener.mjs
// 配置: 下方常量,或环境变量覆盖

import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:3001/';
const WS_TOKEN = process.env.WS_TOKEN || 'srCU4EFf6E8Tm0x7deB3a038r6HwKBA8YRlEYxhViZg';
const BOT_ID = (process.env.BOT_ID || '3757588606').toString();
const INBOX = join(__dirname, 'inbox.jsonl');
const LOG_FILE = join(__dirname, 'listener.log');
const PID_FILE = join(__dirname, 'listener.pid');
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

// 记录自身 PID,供 start.bat / stop.bat 管理
try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
process.on('exit', () => { try { unlinkSync(PID_FILE); } catch {} });

// ---------- 工具 ----------
function log(...args) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${args.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function loadSeen() {
  const seen = new Set();
  if (existsSync(INBOX)) {
    for (const line of readFileSync(INBOX, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { seen.add(JSON.parse(line).seq); } catch {}
    }
  }
  return seen;
}

// ---------- @ 检测 ----------
function isMentioningBot(ev) {
  if (ev.post_type !== 'message' || ev.message_type !== 'group') return false;
  if (String(ev.user_id) === BOT_ID) return false; // 忽略自己
  const ats = (ev.message || []).filter(s => s.type === 'at');
  if (ats.some(s => String(s.data?.qq) === BOT_ID)) return true;
  // 兜底:解析 CQ 码
  const raw = ev.raw_message || '';
  return new RegExp(`\\[CQ:at,qq=${BOT_ID}(?:,[^\\]]*)?\\]`).test(raw);
}

// ---------- 主循环 ----------
function connect(seen) {
  log(`连接 ${WS_URL} ...`);
  const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${WS_TOKEN}` } });
  let delay = RECONNECT_BASE_MS;

  ws.onopen = () => {
    delay = RECONNECT_BASE_MS;
    log('WS 已连接,等待 @消息 ...');
  };

  ws.onmessage = (ev) => {
    let j;
    try { j = JSON.parse(String(ev.data)); } catch { return; }
    if (j.post_type !== 'message') return;

    if (isMentioningBot(j)) {
      const seq = j.message_seq ?? j.message_id;
      if (!seq || seen.has(seq)) return; // 去重
      seen.add(seq);
      const entry = {
        seq,
        message_id: j.message_id,
        time: j.time || Math.floor(Date.now() / 1000),
        group_id: j.group_id,
        group_name: j.group_name || '',
        user_id: j.user_id,
        nickname: j.sender?.card || j.sender?.nickname || String(j.user_id),
        text: (j.message || []).map(s => s.type === 'text' ? s.data.text : `[${s.type}]`).join('').slice(0, 200),
      };
      appendFileSync(INBOX, JSON.stringify(entry) + '\n');
      log(`★ 收到 @请求 [${entry.group_name}] from ${entry.nickname} (${entry.user_id}) seq=${seq}: ${entry.text.slice(0, 40)}`);
    }
  };

  ws.onclose = () => {
    log(`连接断开,${delay / 1000}s 后重连 ...`);
    setTimeout(() => connect(seen), delay);
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  };

  ws.onerror = (e) => log('WS 错误:', e.message || e);
}

// 启动
log(`QQ Agent 监听器启动 (bot=${BOT_ID})`);
connect(loadSeen());
