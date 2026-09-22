// 炉石传说模块(2026-09-20 新增):卡牌检索 / 卡图 / 每日一卡 / 卡组代码解析 / 环境推荐
//
// 数据源(实测,服务器在国内腾讯云):
//   · 卡牌数据 HearthstoneJSON:`https://api.hearthstonejson.com/v1/latest/zhCN/cards.json`
//     实测 HTTP 200 / 9.6MB / 2.0s(last-modified 2026-09-16),36022 条(含不可收集的衍生卡、酒馆战棋、
//     佣兵等),其中 collectible 8170 条。**全字段**:id/dbfId/name/text/type/rarity/cardClass/classes/
//     set/cost/attack/health/durability/armor/mechanics/spellSchool/race/races/flavor/artist/elite/
//     runeCost/overload/spellDamage/collectible/isMiniSet/hideStats/collectionText …(没有图片字段,图靠拼 URL)
//   · 卡图:`https://art.hearthstonejson.com/v1/render/latest/zhCN/512x/<id>.png`(实测 206 + image/png)
//     另有 256x / 以及 `v1/256x/<id>.jpg`(纯原画,无卡框)。缺图回退 `kh.fantast.art`(待实测)。
//   · 卡牌 id 是字符串(如 TOY_330 / EX1_561),dbfId 是数字 → 卡组代码里存的是 **dbfId**,要反查。
//
// 检索口径与游戏王模块(ygocard.mjs)保持一致:**空格分隔多关键词 AND**,每个关键词须命中卡名,
// 打分:整名相等 > 关键词完全相等 > 前缀 > 包含。差异:炉石**可收集卡重名很多**(6646 个卡名里 1280 个
// 有重名,同名不同版本/不同 dbfId),所以优先返回 collectible 的那张,再按 set 新旧兜底。
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HS_DATA_DIR || join(__dirname, 'data');
const CARDS_PATH = process.env.HS_CARDS_PATH || join(DATA_DIR, 'cards.zhCN.json');
const IMG_DIR = process.env.HS_IMG_DIR || join(__dirname, 'cards_img');
const CARDS_URL = process.env.HS_CARDS_URL || 'https://api.hearthstonejson.com/v1/latest/zhCN/cards.json';
const IMG_BASE = process.env.HS_IMG_BASE || 'https://art.hearthstonejson.com/v1';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const IMG_CACHE_MAX = Number(process.env.HS_IMG_CACHE_MAX || 1500);   // 本地卡图张数上限

let cards = null;        // 全量数组
let byId = null;         // id -> card
let byDbf = null;        // dbfId -> card
let nameIdx = null;      // 小写卡名 -> card[](已按「可收集优先、新版本优先」排序)

// ---------------- 卡牌数据 ----------------

export function loadCards() {
  if (cards) return cards;
  if (!existsSync(CARDS_PATH)) throw new Error(`炉石卡库不存在: ${CARDS_PATH}(跑 node hs.mjs --update-cards 下载)`);
  cards = JSON.parse(readFileSync(CARDS_PATH, 'utf8'));
  byId = new Map();
  byDbf = new Map();
  nameIdx = new Map();
  for (const c of cards) {
    if (c.id) byId.set(c.id, c);
    if (c.dbfId) byDbf.set(Number(c.dbfId), c);
  }
  // 同名多版本:可收集的排前面;同为可收集则比 set(字符串编码,新版本字典序不保证,但可收集优先级已够用)
  for (const c of cards) {
    const n = (c.name || '').trim().toLowerCase();
    if (!n) continue;
    let arr = nameIdx.get(n);
    if (!arr) nameIdx.set(n, arr = []);
    arr.push(c);
  }
  for (const arr of nameIdx.values()) {
    arr.sort((a, b) => (b.collectible ? 1 : 0) - (a.collectible ? 1 : 0) || (b.dbfId || 0) - (a.dbfId || 0));
  }
  return cards;
}

export function cardCount() {
  loadCards();
  return cards.filter(c => c.collectible).length;
}
export function totalCount() {
  loadCards();
  return cards.length;
}
export function getCardsPath() { return CARDS_PATH; }
export function reloadCards() {
  cards = byId = byDbf = nameIdx = null;
  return cardCount();
}
export function cardById(id) { loadCards(); return byId.get(id) || null; }
export function cardByDbf(dbfId) { loadCards(); return byDbf.get(Number(dbfId)) || null; }

/** 随机一张可收集卡(每日一卡用);pool 可传子集 */
export function randomCard(pool = null) {
  loadCards();
  const list = pool || cards.filter(c => c.collectible && c.name && c.type !== 'ENCHANTMENT');
  return list[Math.floor(Math.random() * list.length)];
}

// ---------------- 检索 ----------------

const NAME_HIT = (c, kw) => (c.name || '').toLowerCase().includes(kw);

function score(c, kws, rawLower) {
  const n = (c.name || '').toLowerCase();
  let s = 0;
  if (n === rawLower) s += 200;
  if (c.collectible) s += 30;                     // 可收集卡优先(同名多版本时先给玩家真正能用的那张)
  if (!c.collectible && c.type === 'ENCHANTMENT') s -= 40;   // 法术生成的「附魔」不参与展示
  for (const kw of kws) {
    if (n === kw) s += 40;
    else if (n.startsWith(kw)) s += 10;
    else if (n.includes(kw)) s += 3;
  }
  return s;
}

/** 多关键词 AND 检索;返回候选卡(默认 5 张,已按相关度排序) */
export function searchCards(rawQuery, limit = 5) {
  loadCards();
  const q = String(rawQuery || '').trim();
  if (!q) return [];
  // 兼容玩家习惯:全角空格、连续空格
  const kws = q.split(/[\s　]+/).filter(Boolean).map(k => k.toLowerCase());
  const rawLower = q.replace(/[\s　]+/g, '').toLowerCase();
  let pool = cards.filter(c => c.name);
  for (const kw of kws) {
    pool = pool.filter(c => NAME_HIT(c, kw));
    if (!pool.length) return [];
  }
  pool.sort((a, b) => score(b, kws, rawLower) - score(a, kws, rawLower));
  return pool.slice(0, limit);
}

// ---------------- 格式化 ----------------

const TYPE_CN = {
  MINION: '随从', SPELL: '法术', WEAPON: '武器', HERO: '英雄', HERO_POWER: '英雄技能',
  LOCATION: '地标', ENCHANTMENT: '附魔', BATTLEGROUND_SPELL: '酒馆法术', BATTLEGROUND_MINION: '酒馆随从',
};
export const CLASS_CN = {
  NEUTRAL: '中立', DRUID: '德鲁伊', HUNTER: '猎人', MAGE: '法师', PALADIN: '圣骑士', PRIEST: '牧师',
  ROGUE: '潜行者', SHAMAN: '萨满祭司', WARLOCK: '术士', WARRIOR: '战士', DEMONHUNTER: '恶魔猎手',
  DEATHKNIGHT: '死亡骑士', DREAM: '梦境', WHIZBANG: '威兹班',
};
const RARITY_CN = { FREE: '免费', COMMON: '普通', RARE: '稀有', EPIC: '史诗', LEGENDARY: '传说' };
const RACE_CN = {
  BEAST: '野兽', DEMON: '恶魔', DRAGON: '龙', ELEMENTAL: '元素', MECHANICAL: '机械', MURLOC: '鱼人',
  PIRATE: '海盗', TOTEM: '图腾', UNDEAD: '亡灵', QUILBOAR: '野猪人', NAGA: '纳迦', DRAENEI: '德莱尼',
  ALL: '全部', DRAKONID: '龙', GNOME: '侏儒', HIGHLANDER: '高岭牛头人', NIGHTELF: '暗夜精灵',
  ORC: '兽人', TAUREN: '牛头人', TROLL: '巨魔', WORGEN: '狼人', GOBLIN: '地精', BLOODELF: '血精灵',
  SCOURGE: '天灾', VULPERA: '狐人', HUMAN: '人类', DWARF: '矮人', OLD_GOD: '古神', PANDAREN: '熊猫人',
};
const SCHOOL_CN = {
  ARCANE: '奥术', FIRE: '火焰', FROST: '冰霜', NATURE: '自然', HOLY: '神圣', SHADOW: '暗影',
  FEL: '邪能', PHYSICAL: '物理',
};

/** 卡牌效果文本:去掉 <b>/<i> 标记与 $#@ 等占位符,换行压成空格 */
export function cleanText(t) {
  return String(t || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[#$@]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function statLine(c) {
  const parts = [];
  if (c.type === 'MINION' || c.type === 'LOCATION' || c.type === 'BATTLEGROUND_MINION') {
    if (typeof c.attack === 'number' || typeof c.health === 'number') parts.push(`${c.attack ?? '?'}/${c.health ?? '?'}`);
  } else if (c.type === 'WEAPON') {
    parts.push(`${c.attack ?? '?'}/${c.durability ?? '?'}`);
  } else if (c.type === 'HERO') {
    if (c.armor) parts.push(`护甲 ${c.armor}`);
    if (c.health) parts.push(`生命 ${c.health}`);
  }
  if (c.spellDamage) parts.push(`法术伤害+${c.spellDamage}`);
  if (c.overload) parts.push(`过载(${c.overload})`);
  return parts.join(' ');
}

/** 单卡完整文本(与游戏王 formatCard 的版式对齐:名字行 / 属性行 / 数值行 / 效果) */
export function formatCard(c, opts = {}) {
  if (!c) return '';
  const cls = c.classes?.length ? c.classes.map(x => CLASS_CN[x] || x).join('/') : (CLASS_CN[c.cardClass] || c.cardClass || '');
  const type = TYPE_CN[c.type] || c.type || '';
  const race = c.races?.length ? c.races.map(x => RACE_CN[x] || x).join('/') : (RACE_CN[c.race] || c.race || '');
  const school = SCHOOL_CN[c.spellSchool] || c.spellSchool || '';
  const head = [`${c.name}${c.collectible ? '' : '(不可收集)'}`];
  const attrs = [cls, type].filter(Boolean).join('|');
  const tags = [race, school, RARITY_CN[c.rarity] || c.rarity || ''].filter(Boolean).join('/');
  const line2 = [attrs, tags].filter(Boolean).join(' ');
  if (line2) line2 !== 'undefined' && head.push(line2);
  const stats = statLine(c);
  const cost = typeof c.cost === 'number' ? `[${c.cost}费]` : '';
  if (cost || stats) head.push(`${cost}${cost && stats ? ' ' : ''}${stats}`.trim());
  if (c.runeCost) {
    const r = Object.entries(c.runeCost).filter(([, v]) => v > 0).map(([k, v]) => `${({ blood: '鲜血', frost: '冰霜', unholy: '邪恶' })[k]}×${v}`).join(' ');
    if (r) head.push(`符文: ${r}`);
  }
  const body = cleanText(c.text) || cleanText(c.collectionText);
  if (body) head.push(body.length > 400 ? body.slice(0, 400) + '…' : body);
  return head.join('\n');
}

/** 列表行(多结果时) */
export function formatLine(c) {
  const cls = CLASS_CN[c.cardClass] || c.cardClass || '';
  const type = TYPE_CN[c.type] || c.type || '';
  const stats = statLine(c);
  return `${c.name} ${[cls, type, typeof c.cost === 'number' ? `${c.cost}费` : '', stats].filter(Boolean).join(' ')}`.trim();
}

/** 查询并格式化(取最匹配一张);无结果返回 null */
export function queryAndFormat(rawQuery, limit = 5) {
  const hits = searchCards(rawQuery, limit);
  if (!hits.length) return null;
  return formatCard(hits[0]);
}

// ---------------- 卡图 ----------------
// 本地缓存 + 按需下载:炉石卡图是 PNG(512x,约 200~400KB),全量 8000+ 张太大,所以**用到才下**,
// 缓存目录按上限 LRU 清理(按 atime 最旧删)。OneBot 用 base64:// 直接发,不需要 SnowLuma 读本地文件。

function imgPath(id) { return join(IMG_DIR, `${id}.png`); }
export function cardImagePath(id) {
  const p = imgPath(id);
  return existsSync(p) ? p : null;
}

function trimImgCache() {
  try {
    const files = readdirSync(IMG_DIR).filter(f => f.endsWith('.png'))
      .map(f => { const p = join(IMG_DIR, f); return { p, t: statSync(p).mtimeMs }; })
      .sort((a, b) => a.t - b.t);
    while (files.length > IMG_CACHE_MAX) { try { unlinkSync(files.shift().p); } catch { break; } }
  } catch { /* 目录不存在等,忽略 */ }
}

/** 本地有就返回路径,否则下载(失败返回 null)。落盘先写 .tmp 再 rename,避免半张图 */
export async function fetchCardImage(id) {
  if (!id) return null;
  const p = imgPath(id);
  if (existsSync(p)) return p;
  const size = process.env.HS_IMG_SIZE || '512x';
  const urls = [
    `${IMG_BASE}/render/latest/zhCN/${size}/${id}.png`,
    `${IMG_BASE}/render/latest/zhCN/256x/${id}.png`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000) continue;                 // 太小多半是错误页
      mkdirSync(IMG_DIR, { recursive: true });
      const tmp = p + '.' + process.pid + '.tmp';
      writeFileSync(tmp, buf);
      renameSync(tmp, p);
      trimImgCache();
      return p;
    } catch { /* 换下一个源 */ }
  }
  return null;
}

/** OneBot 图片段(base64://);图取不到返回 null */
export function imageSegmentOf(path) {
  if (!path) return null;
  try { return { type: 'image', data: { file: `base64://${readFileSync(path).toString('base64')}` } }; }
  catch { return null; }
}

// ---------------- 卡组代码(deckstring)解析 ----------------
// 格式(权威实现:HearthSim/deckstrings 的 src/index.ts 与 python-hearthstone/deckstrings.py,已核对源码):
//   base64 → 字节流:
//     [0] 固定 0(保留位,单字节)
//     varint 版本(必须 1)
//     varint 格式(1=狂野 2=标准 3=经典 4=幻变)
//     varint 英雄数 + N 个 varint 英雄 dbfId
//     —— 卡牌段**不是一张一条,而是按张数分成三组**,每组先 varint 条目数,再逐条读:
//          组1(1 张):每条 1 个 varint = dbfId     —— 2 张的位标记在这里**不存在**
//          组2(2 张):每条 1 个 varint = dbfId
//          组3(N 张):每条 2 个 varint = dbfId, 张数
//        ⚠ 我第一版按「每条都是 (dbfId<<1|奇偶)」解,结果整段错位(实测 7 条真实卡组代码全部解出
//          「6 条目 8 张 + 12 条备牌」这种荒谬结果)—— 位标记是**别的野实现**的写法,官方不是这样。
//     备牌段:1 个字节的标志(1=有 / 0=无),有则同样按三组读,每条为 dbfId[, 张数], ownerDbfId
export function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    if (pos.i >= buf.length) throw new Error('卡组代码不完整');
    b = buf[pos.i++];
    result |= (b & 0x7f) << shift;
    shift += 7;
    if (shift > 35) throw new Error('卡组代码异常(变长整数过长)');
  } while (b & 0x80);
  return result >>> 0;
}

const FORMAT_CN = { 1: '狂野', 2: '标准', 3: '经典', 4: '幻变' };

/** 解卡组代码 → { format, formatName, heroes:[dbfId], cards:[{dbfId,count}], sideboard:[{dbfId,count,owner}] } */
export function decodeDeckstring(code) {
  const s = String(code || '').trim().replace(/\s+/g, '');
  if (!s) throw new Error('空卡组代码');
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) throw new Error('卡组代码含非法字符');
  const buf = Buffer.from(s, 'base64');
  if (buf.length < 6) throw new Error('卡组代码太短');
  const pos = { i: 0 };
  if (buf[pos.i++] !== 0) throw new Error('不是有效的卡组代码(保留位非 0)');
  const version = readVarint(buf, pos);
  if (version !== 1) throw new Error(`不支持的卡组代码版本: ${version}`);
  const format = readVarint(buf, pos);
  if (!FORMAT_CN[format]) throw new Error(`不支持的格式: ${format}`);
  const heroCount = readVarint(buf, pos);
  if (heroCount < 1 || heroCount > 12) throw new Error('卡组代码异常(英雄数不合理)');
  const heroes = [];
  for (let i = 0; i < heroCount; i++) heroes.push(readVarint(buf, pos));

  // 三组:1 张 / 2 张 / N 张(N 张那条多带一个张数 varint)
  const readGroups = (withOwner) => {
    const out = [];
    for (const count of [1, 2, 0]) {
      const n = readVarint(buf, pos);
      if (n > 60) throw new Error('卡组代码异常(条目数过多)');
      for (let i = 0; i < n; i++) {
        const dbfId = readVarint(buf, pos);
        const c = count || readVarint(buf, pos);
        const item = { dbfId, count: c };
        if (withOwner) item.owner = readVarint(buf, pos);
        if (c < 1 || c > 30) throw new Error(`卡组代码异常(单卡张数 ${c})`);
        out.push(item);
      }
    }
    return out;
  };
  const cardList = readGroups(false);
  let sideboard = [];
  if (pos.i < buf.length) {
    const flag = buf[pos.i++];
    if (flag === 1) sideboard = readGroups(true);
  }
  return { format, formatName: FORMAT_CN[format], heroes, cards: cardList, sideboard };
}

/** 从任意文本里抠出卡组代码(玩家可能把「AAE...」粘在一句话里) */
export function extractDeckstring(text) {
  const m = String(text || '').match(/\b(AAE[A-Za-z0-9+/=]{20,}|[A-Za-z0-9+/]{40,}={0,2})/);
  return m ? m[1] : '';
}

/** 解出来的卡组 → 文本卡表(含职业/格式/张数/费用曲线);未知 dbfId 如实标出 */
export function formatDeckList(decoded, opts = {}) {
  const cls = new Map();       // 类别 → 张数
  const rows = [];
  let mainCount = 0, sideCount = 0;
  const items = [
    ...decoded.cards.map(x => ({ ...x, slot: 'main' })),
    ...(decoded.sideboard || []).map(x => ({ ...x, slot: 'side', ownerName: cardByDbf(x.owner)?.name || '' })),
  ];
  for (const it of items) {
    const c = cardByDbf(it.dbfId);
    rows.push({ card: c, dbfId: it.dbfId, count: it.count, slot: it.slot, ownerName: it.ownerName });
    if (it.slot === 'main') mainCount += it.count; else sideCount += it.count;
    if (c) {
      const k = c.cardClass || 'NEUTRAL';
      cls.set(k, (cls.get(k) || 0) + it.count);
    }
  }
  // 主职业:非中立张数最多者;英雄 dbfId 也参与判定
  const heroNames = decoded.heroes.map(id => cardByDbf(id)?.name).filter(Boolean);
  let mainClass = [...cls.entries()].filter(([k]) => k !== 'NEUTRAL').sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!mainClass && decoded.heroes.length) mainClass = cardByDbf(decoded.heroes[0])?.cardClass;
  const lines = [];
  const totalTag = sideCount ? `${mainCount} 张 + 备牌 ${sideCount} 张` : `${mainCount} 张`;
  lines.push(`【卡组解析】${CLASS_CN[mainClass] || mainClass || '未知职业'} · ${decoded.formatName} · 共 ${totalTag}`);
  if (heroNames.length) lines.push(`英雄: ${heroNames.join('、')}`);
  // 费用曲线只算主牌(备牌是特殊体系的牌,混进来会把曲线带偏)
  const curve = new Array(8).fill(0);
  for (const r of rows) { if (r.slot !== 'main') continue; const c = r.card; if (c && typeof c.cost === 'number') curve[Math.min(7, c.cost)] += r.count; }
  if (curve.some(n => n)) {
    lines.push('曲线(按卡面费用): ' + curve.map((n, i) => `${i === 7 ? '7+' : i}费${n}`).filter((_, i) => curve[i] > 0).join(' '));
  }
  // 按费用升序排,未知的放最后
  const sorted = rows.sort((a, b) => {
    if (a.slot !== b.slot) return a.slot === 'main' ? -1 : 1;
    const ca = a.card?.cost ?? 99, cb = b.card?.cost ?? 99;
    return ca - cb || (a.card?.name || '').localeCompare(b.card?.name || '');
  });
  for (const r of sorted) {
    const label = r.card ? `${r.card.name}${typeof r.card.cost === 'number' ? `(${r.card.cost})` : ''}` : `未知卡#${r.dbfId}`;
    lines.push(`${r.count}× ${label}${r.slot === 'side' ? `  [备牌${r.ownerName ? ` · ${r.ownerName}` : ''}]` : ''}`);
  }
  return lines.join('\n');
}

/** 主牌张数(判断这套是不是「完整可打的卡组」;metastats 上有些条目只列几张关键牌) */
export function mainDeckSize(decoded) {
  return (decoded?.cards || []).reduce((n, x) => n + x.count, 0);
}

// ---------------- 自测 ----------------
// 卡组代码解码是本模块唯一「错了就全错」的地方(靠位数与 varint 对齐),所以自测里做**编码→解码往返**:
// 用已知 dbfId 构造一副卡组,编码成 deckstring 再解回来,断言英雄、张数(三组)、备牌段都对得上。
// 编码器只存在于自测里(线上只解不编),严格照权威实现 HearthSim/deckstrings 的 src/index.ts 写。
export function writeVarint(out, value) {
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
}
export function encodeDeckstring({ format = 2, heroes = [], cards = [], sideboard = [] }) {
  const out = [];
  out.push(0);                       // 保留位(单字节 0)
  writeVarint(out, 1);               // 版本
  writeVarint(out, format);
  writeVarint(out, heroes.length);
  for (const h of [...heroes].sort((a, b) => a - b)) writeVarint(out, h);
  const groups = c => [[c.filter(x => x.count === 1), 1], [c.filter(x => x.count === 2), 2], [c.filter(x => x.count > 2), 0]];
  for (const [list, count] of groups(cards)) {
    writeVarint(out, list.length);
    for (const it of [...list].sort((a, b) => a.dbfId - b.dbfId)) {
      writeVarint(out, it.dbfId);
      if (count === 0) writeVarint(out, it.count);
    }
  }
  if (sideboard.length) {
    out.push(1);
    for (const [list, count] of groups(sideboard)) {
      writeVarint(out, list.length);
      for (const it of [...list].sort((a, b) => a.owner - b.owner || a.dbfId - b.dbfId)) {
        writeVarint(out, it.dbfId);
        if (count === 0) writeVarint(out, it.count);
        writeVarint(out, it.owner);
      }
    }
  } else {
    out.push(0);
  }
  return Buffer.from(out).toString('base64');
}

export async function selftest() {
  let bad = 0;
  const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) bad++; };

  // 用卡库里真实存在的 dbfId 造卡组,断言解码后能反查到卡名
  loadCards();
  const pool = cards.filter(c => c.collectible && c.type === 'MINION' && typeof c.cost === 'number' && c.dbfId);
  const heroes = ['HUNTER', 'MAGE'].map(cl => cards.find(c => c.type === 'HERO' && c.cardClass === cl && c.collectible)?.dbfId).filter(Boolean);
  const main = pool.slice(0, 15).map((c, i) => ({ dbfId: c.dbfId, count: i < 10 ? 2 : 1 }));
  const side = pool.slice(20, 23).map(c => ({ dbfId: c.dbfId, count: 1, owner: heroes[0] }));
  const code = encodeDeckstring({ format: 1, heroes, cards: main, sideboard: side });
  const dec = decodeDeckstring(code);
  const sameSet = (a, b, key) => JSON.stringify([...a].sort((x, y) => x[key] - y[key])) === JSON.stringify([...b].sort((x, y) => x[key] - y[key]));
  ok(dec.format === 1 && dec.formatName === '狂野', `格式解析: format=${dec.format} ${dec.formatName}`);
  ok(sameSet(dec.heroes.map(d => ({ dbfId: d })), heroes.map(d => ({ dbfId: d })), 'dbfId'), `英雄 dbfId 还原: ${dec.heroes} vs ${heroes}`);
  ok(sameSet(dec.cards, main, 'dbfId') && dec.cards.reduce((n, x) => n + x.count, 0) === main.reduce((n, x) => n + x.count, 0),
    `单卡(1张/2张/多张三组)还原: ${dec.cards.length} 条,总 ${dec.cards.reduce((n, x) => n + x.count, 0)} 张`);
  ok(sameSet(dec.sideboard, side, 'dbfId') && dec.sideboard.every(x => x.owner === side[0].owner),
    `备牌段(含 owner)还原: ${dec.sideboard.length} 条,owner=${dec.sideboard[0]?.owner}`);
  const list = formatDeckList(dec);
  ok(list.includes('狂野') && /1×|2×/.test(list), `卡表渲染: 首行「${list.split('\n')[0]}」`);
  ok(!/未知卡#/.test(list), '所有 dbfId 都能反查到卡(没有「未知卡」)');
  ok(list.includes('[备牌'), '备牌行标了 [备牌]');

  // 非法输入必须报错而不是静默出垃圾
  for (const [bad_, why] of [['', '空串'], ['AAAA', '无效 base64'], ['aGVsbG8=', '随便一段文本']]) {
    let threw = false;
    try { decodeDeckstring(bad_); } catch { threw = true; }
    ok(threw, `非法输入报错(${why})`);
  }

  // 检索:空格分隔多关键词 AND、可收集优先
  const hits = searchCards('火球 术');
  ok(hits.length > 0 && hits[0].name.includes('火球'), `多关键词检索「火球 术」→ ${hits[0]?.name}`);
  ok(searchCards('这张卡不存在xyz').length === 0, '无结果时返回空数组');
  ok(!!cardById('EX1_561') && cardById('EX1_561').name.includes('阿莱克'), `按 id 反查: EX1_561 → ${cardById('EX1_561')?.name}`);
  ok(cleanText('<b>战吼：</b>造成$3点伤害。') === '战吼：造成3点伤害。', `效果文本清理: ${cleanText('<b>战吼：</b>造成$3点伤害。')}`);

  console.log(bad ? `\n✗ ${bad} 项不过` : '\n✓ 全部通过');
  return bad;
}

// ---------------- 卡库更新 ----------------
export async function updateHsCards({ log = () => {} } = {}) {
  log(`下载炉石卡库: ${CARDS_URL} ...`);
  const r = await fetch(CARDS_URL, { headers: UA, signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`下载内容过小(${buf.length}B),可能不是卡库`);
  const arr = JSON.parse(buf.toString('utf8'));
  if (!Array.isArray(arr) || arr.length < 10000) throw new Error(`卡库校验失败(条数 ${arr?.length})`);
  const collectible = arr.filter(c => c.collectible).length;
  if (collectible < 3000) throw new Error(`卡库校验失败(可收集卡仅 ${collectible})`);
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CARDS_PATH + '.tmp';
  writeFileSync(tmp, buf);
  renameSync(tmp, CARDS_PATH);
  reloadCards();
  log(`炉石卡库更新完成: 共 ${arr.length} 条 / 可收集 ${collectible} 张 → ${CARDS_PATH}`);
  return { total: arr.length, collectible };
}

// ---------------- CLI 自测 ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const has = k => argv.includes(k);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  try {
    if (has('--update-cards')) { await updateHsCards({ log: console.log }); process.exit(0); }
    if (has('--selftest')) { process.exit((await selftest()) ? 1 : 0); }
    if (has('--deck')) {
      const code = val('--deck') || argv.find(a => /^[A-Za-z0-9+/=]{20,}$/.test(a)) || '';
      const d = decodeDeckstring(code);
      console.log(JSON.stringify({ format: d.format, formatName: d.formatName, heroes: d.heroes, entries: d.cards.length, total: d.cards.reduce((n, x) => n + x.count, 0), sideboard: d.sideboard.length }));
      console.log('\n' + formatDeckList(d));
      process.exit(0);
    }
    console.log(`炉石卡库: ${CARDS_PATH}`);
    console.log(`  总计 ${totalCount()} 条 / 可收集 ${cardCount()} 张`);
    const q = argv.filter(a => !a.startsWith('--')).join(' ');
    if (has('--update')) { await updateHsCards({ log: console.log }); process.exit(0); }
    if (q) {
      const hits = searchCards(q, 8);
      console.log(`查询「${q}」→ ${hits.length} 结果:`);
      hits.forEach((c, i) => console.log(i === 0 ? `\n--- #1 ---\n${formatCard(c)}` : `\n${i + 1}. ${formatLine(c)}`));
      if (!hits.length) console.log('  (无结果)');
      const img = await fetchCardImage(hits[0]?.id);
      console.log(`\n卡图: ${img || '(取不到)'}`);
    }
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}
