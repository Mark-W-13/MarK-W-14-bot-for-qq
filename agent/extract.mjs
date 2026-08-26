// 群消息历史提取器:拉取最近 N 条群消息,输出精简文本行(供 LLM 总结)
// 用法: node extract.mjs <group_id> [count]
// 输出格式: 每行 "HH:MM 昵称|内容" ;图片/表情/其他段简化为 [图]/[表情]/[类型]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API = 'http://127.0.0.1:3000/';
const TOKEN = 'AAy3wZovwET73dmAy9UgwxjIiY2ZwQAArjeqspJ1ehg';
const BOT_ID = '3757588606';

const groupId = process.argv[2];
const count = Number(process.argv[3] || 100);
if (!groupId) { console.error('用法: node extract.mjs <group_id> [count]'); process.exit(1); }

// 昵称:群名片优先
function nameOf(sender) {
  const card = (sender?.card || '').trim();
  const nick = (sender?.nickname || '').trim();
  return card || nick || `成员${sender?.user_id ?? '?'}`;
}

function segText(seg, ctx) {
  switch (seg.type) {
    case 'text': return seg.data.text;
    case 'at': return ctx.nickOf(seg.data.qq) ? `@${ctx.nickOf(seg.data.qq)}` : '@all';
    case 'image': return '[图]';
    case 'face': return '[表情]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'reply': return '[回复]';
    case 'forward': return '[转发消息]';
    default: return `[${seg.type}]`;
  }
}

// 预取本批出现过的 user_id → 昵称映射
const resp = await fetch(API, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'get_group_msg_history', params: { group_id: Number(groupId), count } }),
});
const { data } = await resp.json();
const msgs = data?.messages || [];
if (!msgs.length) { console.error('未获取到消息:', JSON.stringify(data).slice(0, 200)); process.exit(1); }

const names = new Map();
for (const m of msgs) if (m.user_id && !names.has(m.user_id)) names.set(m.user_id, nameOf(m.sender));

for (const m of msgs.reverse()) { // 时间正序输出
  if (String(m.user_id) === BOT_ID) continue; // 跳过机器人自己
  const t = new Date(m.time * 1000);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const nick = names.get(m.user_id) || nameOf(m.sender);
  const text = (m.message || []).map(s => segText(s, { nickOf: q => names.get(q) })).join('').trim();
  if (!text) continue;
  console.log(`${hhmm} ${nick}|${text}`);
}
