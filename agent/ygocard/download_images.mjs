// 下载 YGO 卡图数据库, 按官方密码 id 命名, 本地缓存
// 用法:
//   node download_images.mjs            # 全量下载(跳过已存在/续传)
//   node download_images.mjs 1000       # 只下前 1000 张(试跑)
//   模块导入: import { downloadImages } from './download_images.mjs'
//     (monitor 卡库更新后调用,只补缺失的,增量很快)
// 数据源:
//   主源 images.ygoprodeck.com/images/cards/{id}.jpg (全尺寸纯插画,老卡全)
//   回退源 cdntx.moecube.com/ygopro-super-pre/data/pics/{id}.jpg (百鸽/简中服,新卡先收录;
//     整卡带框小图,但新卡包 100267xxx 段 ygoprodeck 未收录时用它,2026-09-07 实测该段
//     官方源错配过图,moecube 内容正确)
// 回退源下载的图记入 cards_img/moecube.list 标记;下次跑时先探测官方源,官方收录后
//   自动用官方纯插画覆盖并清标记。官方源已知错配的 id 见 OFFICIAL_BROKEN(绕开官方)。
// 输出: cards_img/{id}.jpg (先写临时文件再改名,防中断留半张残图);
//       失败清单写入 cards_img/failed.log(重跑自动重试)
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, appendFileSync, rmSync } from 'node:fs';
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

// ygoprodeck 错配图:密码 id 下的图实为其他卡(2026-09-07 视觉实测 100267001=Time Wizard
// of Tomorrow、100267003=JINZO-LAYERED,均非归光系列)→ 绕开官方源,直接走回退源。
// 官方源修正后把这些 id 从本表移除即可。
const OFFICIAL_BROKEN = new Set(['100267001', '100267002', '100267003']);

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

async function fetchOne(id) {
  const dest = join(OUT, `${id}.jpg`);
  const sid = String(id);
  const isBroken = OFFICIAL_BROKEN.has(sid);
  if (isBroken && existsSync(dest) && !moeLogged.has(sid)) rmSync(dest); // 官方错图作废,待回退源重下
  const isMoe = moeLogged.has(sid);
  // 已有图且非回退源且非黑名单 → 跳过;回退源图 → 探测官方源升级(官方 404 则保留原图)
  if (existsSync(dest) && !isMoe && !isBroken) return { kind: 'skipped' };
  if (existsSync(dest) && isMoe) {
    if (isBroken) return { kind: 'skipped' };        // 黑名单:回退图即终版,不再探官方
    try {
      const from = await tryDownload(BASE, id);     // 官方已更新 → 覆盖 + 清标记
      if (from) {
        renameSync(dest + '.tmp', dest);
        moeLogged.delete(sid);
        return { kind: 'ok' };
      }
      return { kind: 'skipped' };                    // 官方仍无 → 保留回退图
    } catch { return { kind: 'skipped' }; }
  }
  for (let t = 1; t <= MAX_TRIES; t++) {
    try {
      let from;
      if (isBroken) {
        from = await tryDownload(BASE_MOE, id);      // 黑名单:直接用回退源
      } else {
        from = await tryDownload(BASE, id);          // 官方源优先
        if (!from) from = await tryDownload(BASE_MOE, id);  // 官方 404 → 回退源
      }
      if (!from) { markFail(id); return { kind: 'fail' }; }
      renameSync(dest + '.tmp', dest);               // 原子落盘:中断不会留残图
      if (from === 'moe') moeLogged.add(sid);        // 回退源图带标记,官方更新后自动覆盖
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

// 下载 cards.json 中所有缺图(已有跳过,回退源图自动探测官方升级);返回 { ok, fail, skipped, total }
export async function downloadImages(limit = Infinity) {
  mkdirSync(OUT, { recursive: true });
  const cards = JSON.parse(readFileSync(join(__dirname, 'cards.json'), 'utf8'));
  const queue = [...new Set(Object.values(cards).map(c => c.id).filter(Boolean))]
    .sort((a, b) => a - b)
    .slice(0, limit === Infinity ? undefined : limit);
  const t0 = Date.now();
  let done = 0;
  const stats = { ok: 0, fail: 0, skipped: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const r = await fetchOne(queue[cursor++]);
      stats[r.kind]++;
      if (++done % 250 === 0) {
        console.log(`[${done}/${queue.length}] ok=${stats.ok} fail=${stats.fail} skip=${stats.skipped} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveMoeList();                                // 落盘回退源标记(官方更新覆盖后清标记)
  stats.elapsedSec = ((Date.now() - t0) / 1000).toFixed(0);
  return stats;
}

// ---------- 命令行自测/独立运行 ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const limit = Number(process.argv[2]) || Infinity;
  downloadImages(limit).then(stats => {
    console.log(`\n完成: 新增 ${stats.ok} 张, 失败 ${stats.fail} 张, 已存在 ${stats.skipped} 张, 用时 ${stats.elapsedSec}s`);
    console.log(`输出目录: ${OUT}`);
    if (stats.fail) console.log(`失败清单: ${FAILED_LOG} (重跑本脚本自动重试)`);
  }).catch(e => { console.error(e); process.exit(1); });
}
