// 炉石「环境热门卡组推荐」模块(2026-09-20 新增):按 标准/狂野 + 职业/卡组名 找当前热门构筑。
//
// ── 数据源实测定论(服务器在国内腾讯云,别重复试)──
//   ⭐ 主源 **Firestone 静态 CDN**(从 firestoneapp.com 的前端 bundle 里反查出来的,实测全通):
//        `https://static.zerotoheroes.com/api/constructed/stats/decks/<format>/<rank>/<period>/overview-from-hourly.gz.json`
//        · format: standard | wild            (⚠ **狂野也有**,这是它比别家强的关键)
//        · rank:   legend | top-2000-legend | competitive | legend-diamond | diamond | platinum | bronze-gold | all
//        · period: last-patch | past-3 | past-7 | past-20 | current-season
//        实测(2026-09-20,国内):standard/legend/last-patch → 200 / 0.99MB / 1.0s / 1074 套;
//                                  wild/legend/last-patch     → 200 / 0.66MB / 1.2s / 752 套;
//                                  standard/all/past-7        → 200 / 1.53MB / 0.6s / 1563 套。
//        返回 JSON 顶层:lastUpdated / rankBracket / timePeriod / format / **dataPoints** / **deckStats[]**
//        deckStats 单条:`{ archetypeName, archetypeId, playerClass, decklist, winrate(0~1), totalGames, totalWins,
//                          heroCardIds[], cardVariations{} }`
//        → **卡组代码直接就有**(`decklist`),胜率 `winrate`,使用率 = `totalGames / dataPoints`(实测两边闭合:
//          sum(totalGames) === dataPoints)。文件名虽带 `.gz.json`,但**是明文 JSON,别去 gunzip**(实测会报头错误)。
//        · 体系中文名:`https://static.firestoneapp.com/data/i18n/zhCN.json`(200/0.24MB)顶层 `archetype` 字典
//          (attack-druid=口德);该字典**部分 slug 缺中文**(实测 55 个里缺 7 个)→ 缺失回退英文 slug 并做个可读化。
//        · 同步前端的 `all-time` 会被改写成 `past-20`;这里 period/rank 都可用 env 覆盖。
//   ⚪ 备源 **metastats.net**(HTML 抓取,只有标准、无使用率):11 个职业页
//        `https://metastats.net/hearthstone/class/decks/<Class>/`,页面里 `data-clipboard-text` 带完整卡组代码,
//        旁边有 `#Games: N` / `#Win Rate: xx.xx%`。**只在 Firestone 失败时兜底**,抓到的会写进本地库。
//   ❌ 实测走不通(别重复试):hsguru.com / api.hsguru.com / d0nkey.top(DNS 污染 + 连接超时)、
//        hsreplay.net(/meta/ 纯前端渲染,HTML 里无卡组代码;/api/v1/* 全 404)、api.firestoneapp.com(403)、
//        hearthstonetopdecks / vicioussyndicate / hearthpwn(403)、tempostorm(维护中)、hs.178.com(拒连)、
//        bbs.nga.cn(403)、iyingdi 的 api 路径(404)、公共 CORS 代理(全灭)。
//
// ── 缓存策略 ──
//   抓一次落盘 `hs/data/hs_meta.json`(只留每职业每条**按场次排序的前 N 套**,默认 20,免得文件太大),
//   默认 1h 内直接用缓存;过期重抓,抓失败退回旧缓存(回复里会标「旧缓存」)。bot 从不直接等海外请求。
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeDeckstring, formatDeckList, CLASS_CN, cardByDbf, loadCards, mainDeckSize } from './hs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HS_DATA_DIR || join(__dirname, 'data');
const META_PATH = process.env.HS_META_PATH || join(DATA_DIR, 'hs_meta.json');
const CACHE_TTL_MS = Number(process.env.HS_META_CACHE_TTL_MS || 60 * 60 * 1000);          // 缓存 1h
const KEEP_PER_CLASS = Math.max(1, Number(process.env.HS_META_KEEP || 20));               // 每个职业每格式留几套
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Referer: 'https://www.firestoneapp.com/' };
const FS_BASE = process.env.HS_FS_BASE || 'https://static.zerotoheroes.com/api/constructed/stats/decks';
const FS_I18N = process.env.HS_FS_I18N || 'https://static.firestoneapp.com/data/i18n/zhCN.json';
const FS_RANK = process.env.HS_META_RANK || 'all';           // 全分段(样本最大,职业覆盖全);可切 legend / diamond / top-2000-legend
const FS_PERIOD = process.env.HS_META_PERIOD || 'last-patch';
const SITE = process.env.HS_META_SITE || 'https://metastats.net';

// 职业:中英文双向(玩家说「猎人」「猎」或「Hunter」都要认)
export const CLASSES = ['DeathKnight', 'DemonHunter', 'Druid', 'Hunter', 'Mage', 'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior'];
const CLASS_ALIAS = {                    // 玩家习惯叫法 → 内部职业名(含常见简称)
  死亡骑士: 'DeathKnight', 死骑: 'DeathKnight', dk: 'DeathKnight',
  恶魔猎手: 'DemonHunter', 瞎: 'DemonHunter', 恶魔猎: 'DemonHunter', dh: 'DemonHunter',
  德鲁伊: 'Druid', 德: 'Druid', 小德: 'Druid',
  猎人: 'Hunter', 猎: 'Hunter', 雷克萨: 'Hunter',
  法师: 'Mage', 法: 'Mage', 法爷: 'Mage',
  圣骑士: 'Paladin', 圣骑: 'Paladin', 骑: 'Paladin', 骑士: 'Paladin', 乌瑟尔: 'Paladin',
  牧师: 'Priest', 牧: 'Priest', 安度因: 'Priest',
  潜行者: 'Rogue', 盗贼: 'Rogue', 贼: 'Rogue', 潜行: 'Rogue',
  萨满: 'Shaman', 萨满祭司: 'Shaman', 萨: 'Shaman',
  术士: 'Warlock', 术: 'Warlock', 古尔丹: 'Warlock',
  战士: 'Warrior', 战: 'Warrior', 加尔鲁什: 'Warrior',
};
export function classKey(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  for (const c of CLASSES) if (c.toLowerCase() === lower) return c;
  if (CLASS_ALIAS[s]) return CLASS_ALIAS[s];
  if (CLASS_ALIAS[lower]) return CLASS_ALIAS[lower];
  return '';
}
export const classCn = k => CLASS_CN[k] || CLASS_CN[String(k || '').toUpperCase()] || k || '';
// 职业比较**一律大写**(踩过:上游给 'Warlock',卡库里是 'WARLOCK',直接 === 永远不相等)
const sameClass = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();

// 格式:狂野/标准(含常见别名)
export function formatKey(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  if (/^(标准|标准模式|standard|std)$/.test(s)) return 'standard';
  if (/^(狂野|狂野模式|wild)$/.test(s)) return 'wild';
  return '';
}

// ---------------- 本地库 ----------------
export function loadMeta() {
  try {
    const j = JSON.parse(readFileSync(META_PATH, 'utf8'));
    if (!j || typeof j !== 'object') return emptyMeta();
    j.standard = j.standard || {};
    j.wild = j.wild || {};
    return j;
  } catch { return emptyMeta(existsSync(META_PATH) ? '解析失败' : '文件不存在'); }
}
const emptyMeta = (error = '') => ({ standard: {}, wild: {}, updatedAt: 0, error });
export function saveMeta(obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = META_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  renameSync(tmp, META_PATH);
}
export function metaPath() { return META_PATH; }
const flatten = (bucket, format) => Object.entries(bucket || {}).flatMap(([ck, list]) => (list || []).map(d => ({ ...d, classKey: ck, format })));

// ---------------- 主源:Firestone 静态 CDN ----------------
/** 把英文 slug 做得像个名字:quest-priest → Quest Priest;已有中文名的直接用中文名 */
export function prettySlug(slug) {
  return String(slug || '').split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
async function fetchJson(url, timeoutMs = 40000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(await r.text());      // ⚠ 名字带 .gz 但是明文,别 gunzip
}
/** 体系中文名字典(拿不到就只用英文) */
async function fetchArchetypeNames(log) {
  try {
    const j = await fetchJson(FS_I18N);
    return j?.archetype && typeof j.archetype === 'object' ? j.archetype : {};
  } catch (e) { log(`  体系中文名字典取不到(${e.message}),卡组名用英文`); return {}; }
}

/** 抓一个格式的环境数据 → { byClass, count, dataPoints, lastUpdated } */
export async function fetchFormat(format, { log = () => {}, rank = FS_RANK, period = FS_PERIOD } = {}) {
  const url = `${FS_BASE}/${format}/${rank}/${period}/overview-from-hourly.gz.json`;
  log(`  抓取 ${format === 'wild' ? '狂野' : '标准'} 环境数据: ${url}`);
  const j = await fetchJson(url);
  const stats = j?.deckStats;
  if (!Array.isArray(stats) || !stats.length) throw new Error('返回里没有 deckStats(接口结构可能变了)');
  const dict = await fetchArchetypeNames(log);
  const dataPoints = Number(j.dataPoints) || stats.reduce((n, d) => n + (d.totalGames || 0), 0);
  const byClass = {};
  let kept = 0, dropped = 0;
  for (const d of stats) {
    const code = String(d.decklist || '');
    if (!code) continue;
    const cls = classKey(d.playerClass) || String(d.playerClass || '').toUpperCase();
    if (!cls) continue;
    // 只收完整卡组(上游偶有只有几张关键牌的条目)+ 代码必须能解开
    let size = 0;
    try { size = mainDeckSize(decodeDeckstring(code)); } catch { dropped++; continue; }
    if (size < 25) { dropped++; continue; }
    const name = dict[d.archetypeName] || prettySlug(d.archetypeName);
    (byClass[cls] = byClass[cls] || []).push({
      archetype: name,
      slug: d.archetypeName || '',
      code,
      winrate: d.winrate != null ? Number(d.winrate) * 100 : 0,   // 上游是 0~1 小数,这里统一成百分比
      games: Number(d.totalGames) || 0,
      total: size,
      source: 'Firestone',
      sourceFormat: format,
    });
    kept++;
  }
  // 每职业按场次排序,只留前 N 套(文件别太大)
  for (const k of Object.keys(byClass)) {
    byClass[k].sort((a, b) => b.games - a.games || b.winrate - a.winrate);
    byClass[k] = byClass[k].slice(0, KEEP_PER_CLASS);
  }
  log(`  解析: ${format} ${kept} 套(丢弃 ${dropped} 套不完整/解不开),${Object.keys(byClass).length} 个职业;样本 ${dataPoints} 场;更新于 ${j.lastUpdated || '?'}`);
  return { byClass, count: kept, dataPoints, lastUpdated: j.lastUpdated || '', rank: j.rankBracket || rank, period: j.timePeriod || period };
}

// ---------------- 备源:metastats(只有标准;HTML) ----------------
function unescapeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}
/** 解析一个 metastats 职业页 → 卡组数组(只留完整卡组) */
export function parseClassPage(html) {
  const out = [];
  for (const m of String(html).matchAll(/<div class='decklist'>([\s\S]*?)data-clipboard-text="([\s\S]*?)"/g)) {
    const body = m[1];
    const title = unescapeHtml((body.match(/<a href='\/hearthstone\/deck\/(\d+)\/'[^>]*>([\s\S]*?)<\/a>/)?.[2] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const games = Number((body.match(/#Games:\s*([\d,]+)/) || [])[1]?.replace(/,/g, '') || 0);
    const winrate = Number((body.match(/#Win Rate:\s*([\d.]+)%/) || [])[1] || 0);
    const code = (unescapeHtml(m[2]).match(/\b(AAE[A-Za-z0-9+/=]{20,})/) || [])[1] || '';
    const archetype = title.replace(/#\d+\s*$/, '').trim();
    if (!archetype || !code) continue;
    let size = 0;                                       // 该站有「只列几张关键牌」的条目,主牌 <25 张直接丢
    try { size = mainDeckSize(decodeDeckstring(code)); } catch { continue; }
    if (size < 25) continue;
    out.push({ archetype, code, winrate, games, total: size, source: 'MetaStats' });
  }
  return out;
}
// ---------------- 备源 2:hearthstone-decks.net(WordPress REST,境内可达) ----------------
// 实测 URL:`https://hearthstone-decks.net/wp-json/wp/v2/posts?per_page=N&_fields=date,link,title,content&categories=<id>`
// (2026-09-20 实测:标准-战士 5 帖/10 条代码/2.8s;狂野-术士 5 帖/11 条;代码在 `content.rendered` 里,
//  正则 `AAE[A-Za-z0-9+/=]{40,}`,**必须带 `=` 补齐**,否则整条解码会报版本错/被截断)。
// 分类 id(实测):标准总 3 / 狂野总 13;标准职业 Druid 4 Hunter 5 Mage 6 Paladin 7 Priest 8 Rogue 9
// Shaman 10 Warlock 11 Warrior 12 DH 212;狂野职业在标准基础上 +10(Druid 14 … Warrior 22,DH 213)。
// **它只给「战绩 Score」(在标题里),没有全环境胜率/使用率** —— 所以胜率标为未知,不编。
const HSD_CAT = {
  standard: { 3: 'ALL', 4: 'DRUID', 5: 'HUNTER', 6: 'MAGE', 7: 'PALADIN', 8: 'PRIEST', 9: 'ROGUE', 10: 'SHAMAN', 11: 'WARLOCK', 12: 'WARRIOR', 212: 'DEMONHUNTER' },
  wild: { 13: 'ALL', 14: 'DRUID', 15: 'HUNTER', 16: 'MAGE', 17: 'PALADIN', 18: 'PRIEST', 19: 'ROGUE', 20: 'SHAMAN', 21: 'WARLOCK', 22: 'WARRIOR', 213: 'DEMONHUNTER' },
};
async function fetchHearthstoneDecks(format, { log = () => {}, perPage = 12 } = {}) {
  const url = `https://hearthstone-decks.net/wp-json/wp/v2/posts?per_page=${perPage}&_fields=date,link,title,content&categories=${format === 'wild' ? 13 : 3}`;
  log(`  抓取 ${format === 'wild' ? '狂野' : '标准'} 社区卡组(hearthstone-decks.net): ${url}`);
  const posts = await fetchJson(url, 35000);
  if (!Array.isArray(posts) || !posts.length) throw new Error('posts 为空');
  const byClass = {};
  let kept = 0, dropped = 0;
  for (const p of posts) {
    const html = String(p.content?.rendered || '');
    // 一帖里可能既有完整代码又有被截断的片段 → 取最长的那条
    const codes = (html.match(/AAE[A-Za-z0-9+/=]{40,}/g) || []).sort((a, b) => b.length - a.length);
    const code = codes[0];
    if (!code) { dropped++; continue; }
    let dec, size;
    try { dec = decodeDeckstring(code); size = mainDeckSize(dec); } catch { dropped++; continue; }
    if (size < 25) { dropped++; continue; }
    const title = String(p.title?.rendered || '').replace(/<[^>]+>/g, '').trim();
    // 标题形如「Dragon Warrior #6 Legend - Naithlol (Score: 6-0)」→ 名字取 # 之前那段
    const archetype = (title.split('#')[0] || title).replace(/[-–|].*$/, '').trim() || '社区卡组';
    const score = (title.match(/Score:\s*([\d-]+)/i) || [])[1] || '';
    const hero = dec.heroes.map(h => cardByDbf(h)).find(Boolean);
    const cls = (hero?.cardClass || [...new Set(dec.cards.map(c => cardByDbf(c.dbfId)?.cardClass).filter(k => k && k !== 'NEUTRAL'))][0] || 'NEUTRAL').toUpperCase();
    (byClass[cls] = byClass[cls] || []).push({
      archetype, slug: '', code, winrate: 0, games: 0, total: size,
      score, source: 'hearthstone-decks', sourceUrl: p.link || '',
    });
    kept++;
  }
  if (!kept) throw new Error('没解析出完整卡组');
  for (const k of Object.keys(byClass)) byClass[k] = byClass[k].slice(0, KEEP_PER_CLASS);
  log(`  解析: ${kept} 套(丢弃 ${dropped}),${Object.keys(byClass).length} 个职业(该源没有胜率/使用率,回复里会标未知)`);
  return { byClass, count: kept, dataPoints: 0, lastUpdated: '', rank: 'community', period: 'recent' };
}

async function fetchMetastats(format, { log = () => {} } = {}) {
  if (format === 'wild') throw new Error('metastats 只有标准数据(狂野页是标准页的副本)');
  const byClass = {};
  let kept = 0;
  const failed = [];
  for (const key of CLASSES) {
    try {
      const html = await (await fetch(`${SITE}/hearthstone/class/decks/${key}/`, { headers: UA, signal: AbortSignal.timeout(25000) })).text();
      const decks = parseClassPage(html);
      if (!decks.length) { failed.push(classCn(key)); continue; }
      byClass[key.toUpperCase()] = decks.sort((a, b) => b.games - a.games).slice(0, KEEP_PER_CLASS);
      kept += byClass[key.toUpperCase()].length;
    } catch (e) { failed.push(`${classCn(key)}(${e.message})`); }
  }
  if (!kept) throw new Error(`metastats 也没抓到(${failed.slice(0, 3).join('、')})`);
  log(`  metastats 兜底: ${kept} 套,${failed.length ? `部分职业失败(${failed.length})` : '全部成功'}`);
  return { byClass, count: kept, dataPoints: 0, lastUpdated: '', rank: 'all', period: 'last-4-days' };
}

// ---------------- 对外:取库 ----------------
/**
 * 取某格式的卡组库:缓存新鲜就直接用;过期重抓(主源 Firestone → 备源 metastats),
 * 全失败则退回旧缓存并标 stale。
 * @returns {Promise<{format, decks, source, updatedAt, warning}>}
 */
export async function getMetaDecks(format = 'standard', { log = () => {}, force = false } = {}) {
  const db = loadMeta();
  const stamp = format === 'wild' ? db.wildUpdatedAt : db.standardUpdatedAt;
  const local = flatten(db[format], format);
  const fresh = stamp && Date.now() - stamp < CACHE_TTL_MS;
  if (fresh && !force && local.length) {
    return { format, decks: local, source: db[format + 'Source'] || 'cache', updatedAt: stamp, dataPoints: db[format + 'DataPoints'] || 0, warning: '' };
  }
  let r = null, warning = '';
  try {
    r = await fetchFormat(format, { log });
    db[format] = r.byClass;
    db[format + 'UpdatedAt'] = Date.now();
    db[format + 'Source'] = `Firestone(${r.rank}/${r.period})`;
    db[format + 'DataPoints'] = r.dataPoints;
    db[format + 'SourceUpdatedAt'] = r.lastUpdated;
    db.wildUpdatedAt = db.wildUpdatedAt || 0;            // 兼容旧字段
    saveMeta(db);
    log(`  ${format} 环境库已更新: ${r.count} 套 → ${META_PATH}`);
    return { format, decks: flatten(r.byClass, format), source: 'Firestone', updatedAt: Date.now(), dataPoints: r.dataPoints, warning: '' };
  } catch (e) {
    log(`  ${format} 主源(Firestone)失败: ${e.message}`, '', C_red());
    warning = `Firestone 抓取失败(${e.message})`;
  }
  // 兜底一:hearthstone-decks.net(境内可达、标准+狂野都有代码,但没有胜率/使用率)
  for (const [name, fn] of [['hearthstone-decks', fetchHearthstoneDecks], ['metastats', fetchMetastats]]) {
    try {
      r = await fn(format, { log });
      db[format] = r.byClass;
      db[format + 'UpdatedAt'] = Date.now();
      db[format + 'Source'] = `${name}(兜底)`;
      db[format + 'DataPoints'] = r.dataPoints || 0;
      db[format + 'SourceUpdatedAt'] = r.lastUpdated || '';
      if (format === 'wild') db.wildUpdatedAt = Date.now();
      saveMeta(db);
      return { format, decks: flatten(r.byClass, format), source: `${name}(兜底)`, updatedAt: Date.now(), dataPoints: 0, warning };
    } catch (e2) { warning += `;${name} 也没成(${e2.message})`; }
  }
  if (local.length) {
    return { format, decks: local, source: 'stale', updatedAt: stamp, dataPoints: db[format + 'DataPoints'] || 0, warning: `${warning};用的是 ${stamp ? new Date(stamp).toLocaleString('zh-CN') : '未知时间'} 的旧缓存` };
  }
  return { format, decks: [], source: 'none', updatedAt: 0, dataPoints: 0, warning };
}
const C_red = () => '';   // monitor 的配色在那边;这里留空,避免模块间耦合

// ---------------- 对外:查询 ----------------
/**
 * 按「格式 + 职业 + 关键词」挑热门卡组。
 * 关键词可空(给该职业最热的一套);给了就按体系名匹配(中英文都试),匹配不到再退回该职业最热。
 * @returns {Promise<{kind:'ok'|'none'|'noclass', deck?, classKey?, format, usage?, source, warning}>}
 */
export async function recommend(query, { log = () => {} } = {}) {
  loadCards();
  const parts = String(query || '').trim().split(/[\s　,，、]+/).filter(Boolean);
  let format = '', classK = '';
  const rest = [];
  for (const p of parts) {
    if (!format && formatKey(p)) { format = formatKey(p); continue; }
    if (!classK && classKey(p)) { classK = classKey(p); continue; }
    rest.push(p);
  }
  format = format || 'standard';
  const meta = await getMetaDecks(format, { log });
  const kw = rest.join(' ').toLowerCase();

  let pool = meta.decks;
  if (classK) pool = pool.filter(d => sameClass(d.classKey, classK));
  if (kw) {
    const hit = pool.filter(d => (d.archetype || '').toLowerCase().includes(kw)
      || (d.slug || '').toLowerCase().includes(kw)
      || (classCn(d.classKey) || '').includes(kw));
    if (hit.length) pool = hit;
    else if (!classK) return { kind: 'none', format, meta, kw };
    // 给了职业但体系名没命中 → 退回该职业最热的那套
  }
  if (!pool.length) return { kind: classK ? 'none' : 'noclass', format, classKey: classK, meta, kw };

  const sameKlass = meta.decks.filter(d => sameClass(d.classKey, pool[0].classKey));
  // 使用率:**该职业内**的场次占比(全环境口径在 dataPoints 里,回复里两个都给)
  const classGames = sameKlass.reduce((n, d) => n + (d.games || 0), 0);
  const sorted = [...pool].sort((a, b) => (b.games || 0) - (a.games || 0) || (b.winrate || 0) - (a.winrate || 0));
  const deck = sorted[0];
  return {
    kind: 'ok', deck, classKey: deck.classKey, format,
    usage: classGames ? deck.games / classGames : 0,
    globalUsage: meta.dataPoints ? deck.games / meta.dataPoints : 0,
    source: meta.source, warning: meta.warning, updatedAt: meta.updatedAt,
    dataPoints: meta.dataPoints, alternatives: sorted.slice(1, 6),
  };
}

/** 第一条消息:构筑内容 + 胜率/使用率(拆卡组代码 → 卡表) */
export function formatRecommendation(r) {
  const d = r.deck;
  if (!d) return '';
  const fmtCn = r.format === 'wild' ? '狂野' : '标准';
  const lines = [`【${classCn(d.classKey)} · ${fmtCn}】${d.archetype}`];
  const bits = [];
  if (d.winrate) bits.push(`胜率 ${d.winrate.toFixed(1)}%`);
  if (r.globalUsage) bits.push(`环境使用率 ${(r.globalUsage * 100).toFixed(1)}%`);
  else if (r.usage) bits.push(`该职业内占比 ${(r.usage * 100).toFixed(1)}%`);
  if (d.games) bits.push(`${d.games} 场样本`);
  lines.push(bits.length ? bits.join(' · ') : '胜率/使用率: 该格式暂无可靠数据');
  const when = r.updatedAt ? new Date(r.updatedAt).toLocaleDateString('zh-CN') : '';
  const src = d.source || (r.source === 'stale' ? '旧缓存' : r.source || '');
  lines.push(`数据来源: ${src}${when ? `(${when} 更新)` : ''}${r.source === 'stale' ? ',时效已过' : ''}`);
  if (r.warning) lines.push(`提示: ${r.warning}`);
  if (r.alternatives?.length) {
    // 同一体系常有多个微调版本(名字一样、胜率不同)→ 按名字去重,只报「同职业其它体系」
    const seen = new Set([d.archetype]);
    const uniq = [];
    for (const a of r.alternatives) {
      if (seen.has(a.archetype)) continue;
      seen.add(a.archetype);
      uniq.push(a);
      if (uniq.length >= 3) break;
    }
    if (uniq.length) lines.push(`同职业其它热门: ${uniq.map(a => `${a.archetype}(${a.winrate ? a.winrate.toFixed(0) + '%' : '?'})`).join('、')}`);
  }
  try {
    lines.push('', formatDeckList(decodeDeckstring(d.code)));
  } catch (e) {
    lines.push('', `(这套的卡组代码本地解不开: ${e.message})`);
  }
  lines.push('', '卡组代码见下一条消息。');
  return lines.join('\n');
}

/** 第二条消息:**纯净卡组代码**(不带卡组名、不带卡名,直接可导入) */
export function pureDeckCode(r) {
  return String(r?.deck?.code || '').trim();
}

/** 本地库统计(运维台/CLI 用) */
export function metaStats() {
  const db = loadMeta();
  const count = o => Object.values(o || {}).reduce((n, l) => n + (l?.length || 0), 0);
  return {
    standard: count(db.standard), wild: count(db.wild),
    standardUpdatedAt: db.standardUpdatedAt || 0, wildUpdatedAt: db.wildUpdatedAt || 0,
    standardSource: db.standardSource || '', wildSource: db.wildSource || '',
    standardSourceUpdatedAt: db.standardSourceUpdatedAt || '', wildSourceUpdatedAt: db.wildSourceUpdatedAt || '',
    path: META_PATH,
  };
}

// ---------------- CLI ----------------
// node hs_meta.mjs --refresh [standard|wild|both]   抓一遍存库(默认 both)
// node hs_meta.mjs 狂野 猎人                          试一次推荐(打印两条消息)
// node hs_meta.mjs --stats                           看库里有什么
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes('--stats') || argv.includes('--dump')) {
      const db = loadMeta(), s = metaStats();
      const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN') : '从未';
      console.log('库文件:', META_PATH);
      console.log(`标准 ${s.standard} 套 | 更新 ${fmt(s.standardUpdatedAt)} | 源 ${s.standardSource} | 上游更新于 ${s.standardSourceUpdatedAt || '?'}`);
      console.log(`狂野 ${s.wild} 套 | 更新 ${fmt(s.wildUpdatedAt)} | 源 ${s.wildSource} | 上游更新于 ${s.wildSourceUpdatedAt || '?'}`);
      for (const [k, list] of Object.entries(db.standard || {})) console.log(`  [标准] ${classCn(k)}: ${list.map(d => `${d.archetype}(${d.winrate?.toFixed?.(0)}%/${d.games})`).join('、')}`);
      for (const [k, list] of Object.entries(db.wild || {})) console.log(`  [狂野] ${classCn(k)}: ${list.map(d => `${d.archetype}(${d.winrate?.toFixed?.(0)}%/${d.games})`).join('、')}`);
      process.exit(0);
    }
    if (argv.includes('--refresh')) {
      const which = ['standard', 'wild', 'both'].find(a => argv.includes(a)) || 'both';
      const fmts = which === 'both' ? ['standard', 'wild'] : [which];
      const db = loadMeta();
      for (const f of fmts) {
        const r = await fetchFormat(f, { log: console.log });
        db[f] = r.byClass;
        db[f + 'UpdatedAt'] = Date.now();
        db[f + 'Source'] = `Firestone(${r.rank}/${r.period})`;
        db[f + 'DataPoints'] = r.dataPoints;
        db[f + 'SourceUpdatedAt'] = r.lastUpdated;
        if (f === 'wild') db.wildUpdatedAt = Date.now();
      }
      saveMeta(db);
      console.log('\n已写库:', META_PATH);
      process.exit(0);
    }
    const q = argv.filter(a => !a.startsWith('--')).join(' ');
    if (!q) { console.log('用法: node hs_meta.mjs --refresh [standard|wild|both] | --stats | <查询,如「狂野 猎人」>'); process.exit(1); }
    const t0 = Date.now();
    const r = await recommend(q, { log: console.log });
    console.log(`\n查询「${q}」→ kind=${r.kind} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (r.kind === 'ok') {
      console.log('\n--- 第一条 ---\n' + formatRecommendation(r));
      console.log('\n--- 第二条(纯净卡组代码) ---\n' + pureDeckCode(r));
    } else {
      console.log('没找到;可选职业:', CLASSES.map(classCn).join(' '));
    }
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}
