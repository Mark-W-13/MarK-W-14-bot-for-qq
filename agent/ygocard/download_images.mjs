// 下载 YGO 卡图数据库, 按官方密码 id 命名, 本地缓存
// 用法:
//   node download_images.mjs            # 全量下载(跳过已存在/续传)
//   node download_images.mjs 1000       # 只下前 1000 张(试跑)
//   node download_images.mjs --repair   # 只重下「最后 200 张(按 cid)」, 修历史错图(先删后下, 不跳过)
//   node download_images.mjs --repair 500   # 同上, 窗口改成最后 500 张
//   node download_images.mjs --audit    # 只体检不下载: 报覆盖/错图风险清单
//   模块导入: import { downloadImages } from './download_images.mjs'
//     (monitor 卡库更新后调用,只补缺失的,增量很快)
// 数据源:
//   主源 images.ygoprodeck.com/images/cards/{id}.jpg (全尺寸纯插画,老卡全)
//   回退源 cdntx.moecube.com/ygopro-super-pre/data/pics/{id}.jpg (百鸽/简中服,新卡先收录;
//     整卡带框小图,但新卡包 ygoprodeck 未收录时用它)
// 回退源下载的图记入 cards_img/moecube.list 标记;下次跑时先探测官方源,官方收录后
//   自动用官方纯插画覆盖并清标记。官方源已知错配的 id 见 officialUntrusted()。
// 输出: cards_img/{id}.jpg (先写临时文件再改名,防中断留半张残图);
//       失败清单写入 cards_img/failed.log(重跑自动重试)
//
// ---------- 新密码段(1xxxxxxxx)错图事故 2026-09-28 ----------
// 用户报「卡库对、卡图不对」:例如 cid=23568「超越神明的仆人-青眼究极龙」(密码 100268004)
// 查出来的是 Toon Page-Flip。实测根因:
//   1) ygoprodeck 图库对 1 亿段密码根本认不出, 却**不返回 404 而是返回另一张卡的图**
//      (100268001=Toon Black Luster Soldier / 100268002=Toon Harpie Lady / ...
//      100268010=Eternal Chaos, 全是 100268xxx 段被撞成 Toon·Chaos 系列);
//   2) 它的 API 也查不到这些密码(cardinfo.php?id=100268004 → 400 或返回别的卡),
//      所以「官方源 404 才回退」这条老逻辑永远拦不住这种「200 但图错」的情况。
// 现在的规则:id >= 1e8(新密码段 100268xxx / 101306xxx / 100262xxx 等)一律**只信回退源**,
//   官方源直接跳过, 宁可暂时没图也不发错图。
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'cards_img');
const FAILED_LOG = join(OUT, 'failed.log');
const MOE_LIST = join(OUT, 'moecube.list');       // 回退源下载的 id(官方更新后可覆盖)
const BASE = 'https://images.ygoprodeck.com/images/cards';
const BASE_MOE = 'https://cdntx.moecube.com/ygopro-super-pre/data/pics';
const CONCURRENCY = 16;
const MAX_TRIES = 3;
const MIN_VALID_BYTES = 1024;   // 小于 1KB 的 jpg 一律当残图重下

// 官方源错配图:密码 id 下的图实为其他卡。见文件头「新密码段错图事故」。
// 历史条目(100267xxx, 2026-09-07 视觉实测)已不在现版卡库里,保留以防回滚。
const OFFICIAL_BROKEN = new Set([
  '100267001', '100267002', '100267003',
  // 2026-09-28 实测(100268xxx 段全段错图):
  '100268001', '100268002', '100268003', '100268004', '100268005',
  '100268006', '100268007', '100268008', '100268010',
]);

// 官方源(纯插画)对这个密码是否可信
function officialUntrusted(id) {
  const sid = String(id);
  if (OFFICIAL_BROKEN.has(sid)) return true;      // 实测错配
  if (Number(id) >= 1e8) return true;             // 1 亿段:官方源会给错图,一律走回退源
  return false;
}

// 本次会话已记录的失败 id(避免重跑时 failed.log 重复行)
const failedLogged = new Set(existsSync(FAILED_LOG)
  ? readFileSync(FAILED_LOG, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  : []);

// 回退源下载标记(读一次,结束时整体写回)
let moeLogged = new Set(existsSync(MOE_LIST)
  ? readFileSync(MOE_LIST, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  : []);
function saveMoeList() {
  writeFileSync(MOE_LIST, [...moeLogged].join('\n') + (moeLogged.size ? '\n' : ''), 'utf8');
}

// 下载到 dest+'.tmp',成功返回 'official'|'moe' 标识来源;404 返回 null;其他错误 throw
async function tryDownload(base, id) {
  const r = await fetch(`${base}/${id}.jpg`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  writeFileSync(join(OUT, `${id}.jpg`) + '.tmp', Buffer.from(await r.arrayBuffer()));
  return base === BASE_MOE ? 'moe' : 'official';
}

async function fetchOne(id, { force = false } = {}) {
  const dest = join(OUT, `${id}.jpg`);
  const sid = String(id);
  const untrusted = officialUntrusted(id);
  const isMoe = moeLogged.has(sid);
  // 不可信 id 的现存图若不是回退源来的(老版本用官方源下过错图)→ 作废重下
  if (untrusted && existsSync(dest) && !isMoe) rmSync(dest);
  // 半张残图(空文件/几百字节)按缺图处理, 顺便重下
  if (existsSync(dest) && statSync(dest).size < MIN_VALID_BYTES) rmSync(dest);
  // 已有图且来源可信 → 跳过;回退源图 → 探测官方源升级(官方 404 则保留原图)
  if (existsSync(dest) && !force) {
    if (!isMoe) return { kind: 'skipped' };      // 官方图且来源可信
    if (untrusted) return { kind: 'skipped' };   // 不可信 id:回退图即终版,不再探官方
    try {
      const from = await tryDownload(BASE, id);  // 官方已更新 → 覆盖 + 清标记
      if (from) {
        renameSync(dest + '.tmp', dest);
        moeLogged.delete(sid);
        return { kind: 'ok' };
      }
      return { kind: 'skipped' };                // 官方仍无 → 保留回退图
    } catch { return { kind: 'skipped' }; }
  }
  if (force) rmSync(dest, { force: true });      // --repair:先删再下, 修掉历史错图
  for (let t = 1; t <= MAX_TRIES; t++) {
    try {
      let from;
      if (untrusted) {
        from = await tryDownload(BASE_MOE, id);      // 不可信:只用回退源
      } else {
        from = await tryDownload(BASE, id);          // 官方源优先
        if (!from) from = await tryDownload(BASE_MOE, id);  // 官方 404 → 回退源
      }
      if (!from) { markFail(id); return { kind: 'fail' }; }
      renameSync(dest + '.tmp', dest);               // 原子落盘:中断不会留残图
      if (from === 'moe') moeLogged.add(sid);        // 回退源图带标记,官方更新后自动覆盖
      else moeLogged.delete(sid);
      return { kind: 'ok' };
    } catch (e) {
      if (t === MAX_TRIES) markFail(id);
      else await new Promise(r => setTimeout(r, 1000 * t)); // 退避重试
    }
  }
  return { kind: 'fail' };
}

function markFail(id) {
  if (failedLogged.has(String(id))) return;
  failedLogged.add(String(id));
  appendFileSync(FAILED_LOG, `${id}\n`);
}

// 本地这张卡的图是否可用(存在且不是残图)
function imageOk(id) {
  const p = join(OUT, `${id}.jpg`);
  return existsSync(p) && statSync(p).size >= MIN_VALID_BYTES;
}

// cards.json 里全部有密码的 id(按密码升序,去重)
function allIds(cards) {
  return [...new Set(Object.values(cards).map(c => c.id).filter(Boolean))].sort((a, b) => a - b);
}

// cards.json 里最后 n 张(按 cid 排序,即最新收录的新卡)
function lastIds(cards, n) {
  return Object.values(cards).sort((a, b) => a.cid - b.cid).slice(-n).map(c => c.id).filter(Boolean);
}

// 并发跑一批 id
async function runQueue(queue, { force = false, quiet = false } = {}) {
  const t0 = Date.now();
  let done = 0;
  const stats = { ok: 0, fail: 0, skipped: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const r = await fetchOne(queue[cursor++], { force });
      stats[r.kind]++;
      if (!quiet && ++done % 250 === 0) {
        console.log(`[${done}/${queue.length}] ok=${stats.ok} fail=${stats.fail} skip=${stats.skipped} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveMoeList();
  stats.elapsedSec = ((Date.now() - t0) / 1000).toFixed(0);
  return stats;
}

function readCards() {
  return JSON.parse(readFileSync(join(__dirname, 'cards.json'), 'utf8'));
}

// 下载 cards.json 中所有缺图(已有跳过,回退源图自动探测官方升级);返回 { ok, fail, skipped, total }
export async function downloadImages(limit = Infinity) {
  mkdirSync(OUT, { recursive: true });
  const queue = allIds(readCards());
  return runQueue(limit === Infinity ? queue : queue.slice(0, limit));
}

// 重下最后 n 张卡(按 cid)的图, 强制覆盖已有文件 —— 用来修历史错图。
// 新密码段(1 亿段)错图事故后跑一次;以后再出现错图也用它。
export async function repairImages(n = 200) {
  mkdirSync(OUT, { recursive: true });
  const queue = lastIds(readCards(), n);
  console.log(`修复模式: 重下最后 ${queue.length} 张卡(cid 最大的 ${n} 张)的卡图, 不跳过已存在`);
  return runQueue(queue, { force: true });
}

// 体检: 报卡图覆盖情况 + 错图风险清单(不联网,只看本地文件与来源标记)
export function auditImages() {
  const cards = readCards();
  const byId = new Map();
  for (const c of Object.values(cards)) {
    if (!c.id) { byId.set(`cid:${c.cid}`, { noId: true, card: c }); continue; }
    const cur = byId.get(c.id);
    byId.set(c.id, { card: c, cid: Math.max(cur?.cid || 0, c.cid) });
  }
  let total = 0, have = 0, untrustedHave = 0;
  const missing = [], risky = [], noIdCards = [];
  for (const [key, v] of byId) {
    if (v.noId) { noIdCards.push(v.card); continue; }
    total++;
    const exists = imageOk(key);
    if (exists) {
      have++;
      // 新密码段/黑名单 id:图只该来自回退源;没有回退标记 = 疑似官方错图
      if (officialUntrusted(key) && !moeLogged.has(String(key))) {
        untrustedHave++;
        risky.push({ id: key, cid: v.cid, name: v.card.cn_name || v.card.jp_name });
      }
    } else missing.push({ id: key, cid: v.cid, name: v.card.cn_name || v.card.jp_name });
  }
  return { total, have, missing, risky, untrustedHave, noIdCards };
}

// ---------- 命令行自测/独立运行 ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const show = (list, head = 20) => {
    list.slice(0, head).forEach(x => console.log(`  ${String(x.cid).padStart(5)} ${String(x.id).padStart(10)} ${x.name || ''}`));
    if (list.length > head) console.log(`  ...(共 ${list.length} 条)`);
  };
  try {
    if (args.includes('--audit')) {
      mkdirSync(OUT, { recursive: true });
      const a = auditImages();
      console.log(`卡图体检: 卡库 ${a.total} 张有密码的卡, 本地有图 ${a.have} 张, 缺图 ${a.missing.length} 张`);
      console.log(`免错图保险: 新密码段/黑名单 id 中有图但来源可疑的 ${a.untrustedHave} 张(应为 0);` +
        `无密码 id 的卡 ${a.noIdCards.length} 张(官方无卡图,正常)`);
      if (a.risky.length) { console.log('疑似错图(跑 --repair 或全量重跑即可修):'); show(a.risky); }
      if (a.missing.length) { console.log('缺图(跑全量下载补):'); show(a.missing); }
    } else if (args.includes('--repair')) {
      const n = Number(args[args.indexOf('--repair') + 1]) || 200;
      const stats = await repairImages(n);
      console.log(`\n修复完成: 重下 ${stats.ok} 张, 失败 ${stats.fail} 张, 跳过 ${stats.skipped} 张, 用时 ${stats.elapsedSec}s`);
      console.log(`输出目录: ${OUT}`);
      if (stats.fail) console.log(`失败清单: ${FAILED_LOG} (重跑本脚本自动重试)`);
    } else {
      const limit = Number(args[0]) || Infinity;
      const stats = await downloadImages(limit);
      console.log(`\n完成: 新增 ${stats.ok} 张, 失败 ${stats.fail} 张, 已存在 ${stats.skipped} 张, 用时 ${stats.elapsedSec}s`);
      console.log(`输出目录: ${OUT}`);
      if (stats.fail) console.log(`失败清单: ${FAILED_LOG} (重跑本脚本自动重试)`);
    }
  } catch (e) { console.error(e); process.exit(1); }
}
