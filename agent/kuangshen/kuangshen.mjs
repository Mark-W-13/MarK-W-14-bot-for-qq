// 框神语录:追踪指定用户(框神)在指定群的发言 → 语录库 → 精筛 → 随机抽取
//  - 历史回填 backfillQuotes(): get_group_msg_history 分页(count=200)顺序翻页,
//    首次全量深挖(翻到历史尽头/上限),增量时遇到库内已知 seq 即停
//  - 实时采集 collectQuoteFromEvent(j): monitor WS 收到该群该用户消息直接入库
//  - 精筛 filterFeatured(): 删「好的/没问题」类无个人特征、低信息量发言;
//    保留带语气词等有个人特征的发言
//  - 抽取 pickFeaturedQuote(): 从精筛库随机抽一条
//  - 黑名单(挥手负反馈): 被 👋 差评的语录 seq 进 blacklist.json,
//    pickFeaturedQuote/mergeQuotes 均跳过(不再抽中、回填/采集不再收)
// 数据: agent/kuangshen/quotes.json — [{seq, time, text}] 按 seq 升序
//       agent/kuangshen/blacklist.json — [{seq, time, text}] 挥手负反馈
// 用法:
//   node kuangshen.mjs               # 统计 + 随机抽一条示例
//   node kuangshen.mjs --backfill    # 回填历史(增量合并,翻到尽头/上限)
//   node kuangshen.mjs --dump        # 打印精筛后全部语录(带序号)
//   node kuangshen.mjs --dump-raw    # 打印原始全部(未精筛)
//   node kuangshen.mjs --dump-blacklist  # 打印黑名单语录
// 配置: KUANGSHEN_GROUP / KUANGSHEN_TARGET / KUANGSHEN_MAX_PAGES(env 可覆盖)

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载 .env(与 monitor 同款;含 API_TOKEN 等,不入库)
try {
  const envText = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const GROUP_ID = process.env.KUANGSHEN_GROUP || '793874011';          // 复旦邻里交流群
const TARGET_UID = process.env.KUANGSHEN_TARGET || '3080580848';       // 框神 QQ
const MAX_PAGES = Number(process.env.KUANGSHEN_MAX_PAGES || 200);      // 回填翻页上限(200 条/页)
const API = process.env.API || 'http://127.0.0.1:3000/';
const API_TOKEN = process.env.API_TOKEN || process.env.SNOWLUMA_API_TOKEN;
const QUOTES_PATH = join(__dirname, 'quotes.json');
const BLACKLIST_PATH = join(__dirname, 'blacklist.json');

// ---------- 黑名单读写(挥手负反馈;与被删语录同结构,原子写入) ----------
export function loadBlacklist() {
  try {
    const list = JSON.parse(readFileSync(BLACKLIST_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function saveBlacklist(list) {
  writeFileSync(BLACKLIST_PATH + '.tmp', JSON.stringify(list, null, 1), 'utf8');
  renameSync(BLACKLIST_PATH + '.tmp', BLACKLIST_PATH);
}
const blackSeqSet = () => new Set(loadBlacklist().map(x => x.seq));

// 加入黑名单(按 seq 去重);返回 'added' | 'duplicate'
export function addToBlacklist(seq, text) {
  const list = loadBlacklist();
  if (list.some(x => x.seq === seq)) return 'duplicate';
  list.push({ seq, time: Math.floor(Date.now() / 1000), text });
  saveBlacklist(list);
  return 'added';
}

// 从语录库物理删除指定 seq(挥手负反馈=删掉);返回是否删除
export function removeQuoteBySeq(seq) {
  const list = loadQuotes();
  const next = list.filter(q => q.seq !== seq);
  if (next.length === list.length) return false;
  saveQuotes(next);
  return true;
}

// ---------- 语录库读写(全部发言,按 seq 升序;原子写入) ----------
export function loadQuotes() {
  try {
    const list = JSON.parse(readFileSync(QUOTES_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function saveQuotes(list) {
  writeFileSync(QUOTES_PATH + '.tmp', JSON.stringify(list, null, 1), 'utf8');
  renameSync(QUOTES_PATH + '.tmp', QUOTES_PATH);
}

// 合并新发言:按 seq 去重 + 相同文本只留最早一条,按 seq 升序
// 黑名单 seq 直接跳过(挥手差评过的语录不再被回填/采集收进来)
// 返回新增条数
function mergeQuotes(list, fresh) {
  const knownSeq = new Set(list.map(q => q.seq));
  const knownText = new Set(list.map(q => q.text));
  const blacked = blackSeqSet();
  let added = 0;
  for (const q of fresh) {
    if (knownSeq.has(q.seq) || knownText.has(q.text) || blacked.has(q.seq)) continue;
    knownSeq.add(q.seq); knownText.add(q.text);
    list.push(q); added++;
  }
  list.sort((a, b) => a.seq - b.seq);
  return added;
}

// ---------- 消息文本提取(只取 text 段;纯图/表情等无文本消息跳过) ----------
function msgText(j) {
  const segs = j?.message || [];
  if (!segs.length && j?.raw_message) return String(j.raw_message).trim();
  return segs.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();
}

// ---------- 精筛(删无个人特征、低信息量发言;保留语气词等个人特征) ----------
// 纯表情/无文字
const EMOJI_ONLY = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s~～。.!！?？…]+$/u;
// 纯敷衍尾缀/填充(嗯嗯 / 。。。 / ～ 等,无应答核也无内容)
const FILLER_ONLY = /^[的了吧嘛嗯哦噢欧克~～。.!！？?…\s]+$/;
// 特别正经的应答短句(整体形态:「6」「nb」「1」等)
const ACK_RE = /^(好的?|没问题|可以|行|嗯|哦|噢|欧克|okk?|OK|收到|知道了|明白|了解|对|是|确实|当然|妥|好耶|牛|nb|NB|6|666|1|？|!|。|\.)$/i;
// 应答核:剥掉尾缀后只剩应答词重复 → 删(好的吧 / 好吧好吧 / 可以可以 / 收到收到 / 对啊对啊 …)
const ACK_CORE = /^(好|可以|行|对|是|收到|没问题|明白|了解|确实|当然|牛|nb|6|ok|okk|欧克){1,4}$/i;
const SUFFIX_STRIP = /[的了吧嘛嗯哦噢欧克~～。.!！…\s]/g;
// 应答词+啊 单位重复(对啊对啊 / 好啊 / 行啊;「啊啊啊」类感叹不受影响)
const ACK_WITH_A = /^((好|可以|行|对|是|收到|没问题|明白|了解|确实|当然|牛|nb|6|ok|okk|欧克)啊){1,4}$/i;
// 语气词/个人特征信号(出现即倾向保留;含单字感叹 艹/草/淦/耶 等)
const PARTICLE = /[啊呀吧呢嘛哦噢诶哎唉哟呗嘿嚯哇呕呸啧嘞咯啦哒惹咧哈哇艹草淦靠耶嗨呜嘻]/;
// 两字内的特殊感叹(不进 PARTICLE 但明显有个人特征):卧槽/我艹 等
const SHORT_KEEP = /^(卧槽|我艹|我靠|我超|沃日)$/;

export function isFeatured(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (EMOJI_ONLY.test(t)) return false;                    // 纯表情
  if (!t.replace(/\[[^\]]*\]/g, '').trim()) return false;  // 纯段标记(如 [图][表情])
  if (ACK_RE.test(t)) return false;                        // 6/nb/好的 等单形态应答
  if (FILLER_ONLY.test(t)) return false;                   // 嗯嗯/。。。 等纯填充
  if (ACK_CORE.test(t.replace(SUFFIX_STRIP, ''))) return false;  // 应答词重复(好的吧/好吧好吧)
  if (ACK_WITH_A.test(t)) return false;                    // 应答词+啊(对啊对啊/好啊)
  if (t.length <= 2 && !SHORT_KEEP.test(t) && !PARTICLE.test(t)) return false;  // 超短且无个人特征:「?」「来」「笑死」
  return true;                                             // 其余保留(有语气词或有信息量)
}

export function filterFeatured(list) {
  return list.filter(q => isFeatured(q.text));
}

// ---------- 随机抽取(从精筛库;黑名单跳过) ----------
export function pickFeaturedQuote() {
  const blacked = blackSeqSet();
  const featured = filterFeatured(loadQuotes()).filter(q => !blacked.has(q.seq));
  if (!featured.length) return null;
  return featured[Math.floor(Math.random() * featured.length)];
}

export function getStats() {
  const all = loadQuotes();
  return { total: all.length, featured: filterFeatured(all).length, blacklisted: loadBlacklist().length, file: QUOTES_PATH };
}

// ---------- 关键词检索(「框神语录 」+ 关键词,空格分隔 AND 匹配) ----------
// 子串匹配,ASCII 不分大小写;走精筛+黑名单口径;返回命中列表(seq 升序)
export function searchQuotes(keywords) {
  const kws = (keywords || []).map(k => String(k).toLowerCase()).filter(Boolean);
  if (!kws.length) return [];
  const blacked = blackSeqSet();
  return filterFeatured(loadQuotes())
    .filter(q => !blacked.has(q.seq))
    .filter(q => {
      const t = q.text.toLowerCase();
      return kws.every(k => t.includes(k));
    });
}

// ---------- 实时采集(monitor WS 事件;同群同用户才收) ----------
// 返回 { added, text } 或 null(非目标/无文本/重复)
export function collectQuoteFromEvent(j) {
  if (j?.post_type !== 'message') return null;
  if (String(j.group_id) !== GROUP_ID || String(j.user_id) !== TARGET_UID) return null;
  const seq = j.message_seq ?? j.message_id;
  if (!seq) return null;
  const text = msgText(j);
  if (!text) return null;
  const list = loadQuotes();
  const added = mergeQuotes(list, [{ seq, time: j.time || Math.floor(Date.now() / 1000), text }]);
  if (!added) return null;
  saveQuotes(list);
  return { added, text };
}

// ---------- 历史回填(分页拉取合并;增量时遇已知 seq 即停) ----------
async function api(action, params) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
  return r.json();
}

// 回填历史:从最新往前翻,count=200/页;增量模式遇库内已知 seq 即停(说明已覆盖停机间隙);
// 首次深挖(库为空)则一直翻到历史尽头或 maxPages 上限。
// 返回 { pages, added, scanned }
export async function backfillQuotes(maxPages = MAX_PAGES) {
  if (!API_TOKEN) throw new Error('缺少 API_TOKEN(agent/.env)');
  const list = loadQuotes();
  const knownSeq = new Set(list.map(q => q.seq));
  let anchor = 0;
  let pages = 0, added = 0, scanned = 0, emptyStreak = 0, lastOldestSeq = null;
  const fresh = [];
  for (let p = 1; p <= maxPages; p++) {
    const j = await api('get_group_msg_history', { group_id: GROUP_ID, message_id: anchor, count: 200, reverse_order: true });
    const msgs = j.data?.messages || [];
    if (!msgs.length) { emptyStreak++; if (emptyStreak >= 2) break; continue; }
    emptyStreak = 0;
    pages++;
    const oldest = msgs.reduce((a, b) => (a.time <= b.time ? a : b));
    if (oldest.message_seq === lastOldestSeq) break;       // 锚点不再前进,翻不动了
    lastOldestSeq = oldest.message_seq;
    anchor = oldest.message_id;
    let hitKnown = false;
    for (const m of msgs) {
      if (String(m.user_id) !== TARGET_UID) continue;
      const seq = m.message_seq ?? m.message_id;
      if (knownSeq.has(seq)) { hitKnown = true; continue; }
      const text = msgText(m);
      if (!text) continue;
      fresh.push({ seq, time: m.time || 0, text });
    }
    scanned += msgs.length;
    if (hitKnown) break;                                   // 已到库内已知消息,更旧的都在库里
  }
  added = mergeQuotes(list, fresh);
  if (added) saveQuotes(list);
  return { pages, added, scanned };
}

// ---------- CLI 自测 ----------
const isCli = (() => {
  try { return fileURLToPath(import.meta.url).toLowerCase() === process.argv[1]?.toLowerCase(); } catch { return false; }
})();

if (isCli) {
  const arg = process.argv[2] || '';
  if (arg === '--backfill') {
    backfillQuotes().then(r => {
      console.log(`回填完成: 翻 ${r.pages} 页 / 扫 ${r.scanned} 条 / 新增 ${r.added} 条`);
      const s = getStats();
      console.log(`语录库: 共 ${s.total} 条, 精筛后 ${s.featured} 条 → ${s.file}`);
    }).catch(e => { console.error('回填失败:', e.message); process.exit(1); });
  } else if (arg === '--dump' || arg === '--dump-raw') {
    const list = arg === '--dump' ? filterFeatured(loadQuotes()) : loadQuotes();
    list.forEach((q, i) => {
      const d = q.time ? new Date(q.time * 1000).toISOString().slice(5, 16) : '????';
      console.log(`${String(i + 1).padStart(3)} | ${d} | ${q.text.replace(/\n/g, '⏎')}`);
    });
    console.log(`\n共 ${list.length} 条(${arg === '--dump' ? '精筛后' : '原始'})`);
  } else if (arg === '--dump-blacklist') {
    const list = loadBlacklist();
    list.forEach((q, i) => {
      const d = q.time ? new Date(q.time * 1000).toISOString().slice(5, 16) : '????';
      console.log(`${String(i + 1).padStart(3)} | ${d} | seq=${q.seq} | ${q.text.replace(/\n/g, '⏎')}`);
    });
    console.log(`\n黑名单共 ${list.length} 条`);
  } else {
    const s = getStats();
    console.log(`语录库: 共 ${s.total} 条, 精筛后 ${s.featured} 条${s.blacklisted ? `, 黑名单 ${s.blacklisted} 条` : ''}`);
    const q = pickFeaturedQuote();
    if (q) {
      const d = q.time ? new Date(q.time * 1000).toISOString().slice(5, 16) : '';
      console.log(`示例抽取 [${d}]: ${q.text}`);
    } else {
      console.log('库为空,先跑 node kuangshen.mjs --backfill 回填历史');
    }
  }
}
