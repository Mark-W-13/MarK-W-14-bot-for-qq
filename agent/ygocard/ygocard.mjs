// 游戏王本地卡牌查询模块 (纯本地,无 AI,无网络)
// 数据源: 百鸽 ygocdb.com /api/v0/cards.zip 全量卡库 (cards.json, ~14k 张, 含中文/日文/英文名+效果)
// 用法:
//   import { searchCards, formatCard } from './ygocard.mjs';
//   searchCards('青眼白龙')          -> 单关键词
//   searchCards('青眼 白龙')          -> 空格分隔多关键词 AND 查询
//   命令行自测: node ygocard.mjs "关键词..."
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARDS_PATH = process.env.YGOCARDS_PATH || join(__dirname, 'cards.json');
const IMG_DIR = process.env.YGOCARD_IMG_DIR || join(__dirname, 'cards_img'); // 卡图目录(按官方密码 id 命名的 jpg)

// 可搜索的名称字段(别名也算:简中官方名、MD名、NWBBS译名等)
const NAME_FIELDS = ['cn_name', 'sc_name', 'md_name', 'nwbbs_n', 'cnocg_n', 'jp_name', 'jp_ruby', 'en_name'];

let cards = null;   // { cid: card }
let nameIndex = null; // 小写名称 -> Set<cid>

export function loadCards() {
  if (cards) return cards;
  if (!existsSync(CARDS_PATH)) throw new Error(`卡库不存在: ${CARDS_PATH} (请放入 ygocdb cards.json)`);
  cards = JSON.parse(readFileSync(CARDS_PATH, 'utf8'));
  nameIndex = new Map();
  for (const [cid, c] of Object.entries(cards)) {
    for (const f of NAME_FIELDS) {
      const n = c[f];
      if (!n) continue;
      const key = n.toLowerCase();
      let s = nameIndex.get(key);
      if (!s) nameIndex.set(key, s = new Set());
      s.add(cid);
    }
  }
  return cards;
}

export function cardCount() {
  loadCards();
  return Object.keys(cards).length;
}

export function getCardsPath() { return CARDS_PATH; }

// ---------- 卡图 ----------
// 本地卡图文件路径(不存在返回 null)。卡无官方密码(id=0)或无图文件时无卡图。
export function cardImagePath(c) {
  if (!c?.id) return null;
  const p = join(IMG_DIR, `${c.id}.jpg`);
  return existsSync(p) ? p : null;
}

// 构造 OneBot 图片消息段(base64://,无需 SnowLuma 读本地路径);无本地卡图返回 null
export function cardImageSegment(c) {
  const p = cardImagePath(c);
  if (!p) return null;
  return { type: 'image', data: { file: `base64://${readFileSync(p).toString('base64')}` } };
}

// 重载卡库(卡库文件被更新后调用)
export function reloadCards() {
  cards = null;
  nameIndex = null;
  return cardCount();
}

// ---------- 最小 zip 解压(零依赖,仅用于卡库更新) ----------
// 从 central directory 解析,支持 store(0)/deflate(8);定位 cards.json 并返回其 UTF-8 文本。
export function extractZipCardJson(zipBuf) {
  // EOCD (PK\x05\x06): 从尾部 22 字节起,允许 zip 注释(最长 64KB)
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 22 - 65536); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 格式错误: 找不到 EOCD');
  const cdOffset = zipBuf.readUInt32LE(eocd + 16);
  const cdSize = zipBuf.readUInt32LE(eocd + 12);
  const entries = [];
  for (let p = cdOffset, end = cdOffset + cdSize; p < end;) {
    if (zipBuf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 格式错误: 中央目录损坏');
    const nlen = zipBuf.readUInt16LE(p + 28), elen = zipBuf.readUInt16LE(p + 30), clen = zipBuf.readUInt16LE(p + 32);
    entries.push({
      name: zipBuf.toString('utf8', p + 46, p + 46 + nlen),
      method: zipBuf.readUInt16LE(p + 10),
      csize: zipBuf.readUInt32LE(p + 20),
      usize: zipBuf.readUInt32LE(p + 24),
      lho: zipBuf.readUInt32LE(p + 42),
    });
    p += 46 + nlen + elen + clen;
  }
  const entry = entries.find(e => e.name.endsWith('cards.json'));
  if (!entry) throw new Error(`zip 中找不到 cards.json(内有: ${entries.map(e => e.name).join(', ') || '空'})`);
  const lh = entry.lho;
  if (zipBuf.readUInt32LE(lh) !== 0x04034b50) throw new Error('zip 格式错误: local header 损坏');
  const dataStart = lh + 30 + zipBuf.readUInt16LE(lh + 26) + zipBuf.readUInt16LE(lh + 28);
  const raw = zipBuf.subarray(dataStart, dataStart + entry.csize);
  const out = entry.method === 0 ? raw
    : entry.method === 8 ? inflateRawSync(raw)
    : (() => { throw new Error(`不支持的压缩方法: ${entry.method}`); })();
  if (out.length !== entry.usize) throw new Error(`zip 解压大小不符(期望 ${entry.usize},实际 ${out.length})`);
  return out.toString('utf8');
}

function cardNames(c) {
  return NAME_FIELDS.map(f => c[f]).filter(Boolean);
}

// 相关性打分: 整体精确 > 名称精确=关键词 > 前缀 > 包含
function score(c, kws, rawLower) {
  const names = cardNames(c).map(n => n.toLowerCase());
  let s = 0;
  if (names.some(n => n === rawLower)) s += 200;           // 名称整体等于查询串
  for (const kw of kws) {
    for (const n of names) {
      if (n === kw) s += 40;
      else if (n.startsWith(kw)) s += 10;
      else if (n.includes(kw)) s += 3;
    }
  }
  return s;
}

// 多关键词 AND 搜索: 每个关键词必须命中同一张卡的任一名称
export function searchCards(rawQuery, limit = 5) {
  loadCards();
  const kws = (rawQuery || '').trim().split(/\s+/).filter(Boolean);
  if (!kws.length) return [];
  const rawLower = rawQuery.trim().toLowerCase();
  let pool = Object.values(cards);
  for (const kw of kws) {
    const lk = kw.toLowerCase();
    pool = pool.filter(c => cardNames(c).some(n => n.toLowerCase().includes(lk)));
    if (!pool.length) return [];   // 某关键词无命中,整体无结果
  }
  pool.sort((a, b) => score(b, kws, rawLower) - score(a, kws, rawLower));
  return pool.slice(0, limit);
}

const MAX_DESC = 400; // 效果文本单段上限,防刷屏

// 单卡完整格式(用户示例):
//   青眼白龙（青眼の白龍）
//   [怪兽|通常] 龙/光
//   [★8] 3000/2500
//   以高攻击力著称的传说之龙。...
export function formatCard(c) {
  const cn = c.cn_name || c.sc_name || c.md_name || c.nwbbs_n || c.cnocg_n || c.en_name;
  const jp = c.jp_name ? `（${c.jp_name}）` : '';
  const lines = [`${cn}${jp}`];
  if (c.text?.types) lines.push(c.text.types);
  if (c.text?.pdesc) lines.push(`【灵摆效果】${c.text.pdesc}`);
  if (c.text?.desc) {
    const d = c.text.desc;
    lines.push(d.length > MAX_DESC ? d.slice(0, MAX_DESC) + '…' : d);
  }
  return lines.join('\n');
}

// 列表行(多结果时): 名称 + 种类行
function formatLine(c, i) {
  const cn = c.cn_name || c.sc_name || c.md_name || c.nwbbs_n || c.cnocg_n || c.en_name;
  const jp = c.jp_name ? `（${c.jp_name}）` : '';
  const types = (c.text?.types || '').split('\n')[0];
  return `${i}. ${cn}${jp}${types ? ' ' + types : ''}`;
}

// 查询并格式化回复正文(只给第一个最相关的结果)
export function queryAndFormat(rawQuery, limit = 5) {
  const hits = searchCards(rawQuery, limit);
  if (!hits.length) return null;
  return formatCard(hits[0]);
}

// ---------- 命令行自测 ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const q = process.argv.slice(2).join(' ');
  try {
    console.log(`卡库共 ${cardCount()} 张`);
    const hits = searchCards(q, 8);
    console.log(`查询「${q}」→ ${hits.length} 结果:`);
    hits.forEach((c, i) => {
      console.log(`\n--- #${i + 1} ---`);
      console.log(i === 0 ? formatCard(c) : formatLine(c, i + 1));
    });
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}
