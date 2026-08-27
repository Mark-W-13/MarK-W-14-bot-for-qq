// 下载 YGO 卡图数据库 (ygoprodeck, 按官方密码 id 命名, 本地缓存)
// 用法:
//   node download_images.mjs            # 全量下载(跳过已存在/续传)
//   node download_images.mjs 1000       # 只下前 1000 张(试跑)
//   模块导入: import { downloadImages } from './download_images.mjs'
//     (monitor 卡库更新后调用,只补缺失的,增量很快)
// 数据源: https://images.ygoprodeck.com/images/cards/{id}.jpg (全尺寸)
// 输出: cards_img/{id}.jpg (先写临时文件再改名,防中断留半张残图);
//       失败清单写入 cards_img/failed.log(重跑自动重试)
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'cards_img');
const FAILED_LOG = join(OUT, 'failed.log');
const BASE = 'https://images.ygoprodeck.com/images/cards';
const CONCURRENCY = 16;
const MAX_TRIES = 3;

// 本次会话已记录的失败 id(避免重跑时 failed.log 重复行)
const failedLogged = new Set(existsSync(FAILED_LOG)
  ? readFileSync(FAILED_LOG, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  : []);

async function fetchOne(id) {
  const dest = join(OUT, `${id}.jpg`);
  if (existsSync(dest)) return { kind: 'skipped' };
  for (let t = 1; t <= MAX_TRIES; t++) {
    try {
      const r = await fetch(`${BASE}/${id}.jpg`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status === 404) { markFail(id); return { kind: 'fail' }; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(dest + '.tmp', Buffer.from(await r.arrayBuffer()));
      renameSync(dest + '.tmp', dest);            // 原子落盘:中断不会留残图
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

// 下载 cards.json 中所有缺图(跳过已有);返回 { ok, fail, skipped, total }
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
