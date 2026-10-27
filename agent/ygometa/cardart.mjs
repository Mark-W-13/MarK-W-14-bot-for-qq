// 饼图卡组代表图(2026-10-28)
// 用百鸽 CDN 的「中间插画」纯净卡面: cdn.233.momobako.com/ygopro/pics/{id}.jpg!art
// 不是本地 cards_img 里带边框的整卡图。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchCards } from '../ygocard/ygocard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, 'cache', 'cardart');
const MAP_FILE = join(CACHE_DIR, 'map.json');
const CDN = 'https://cdn.233.momobako.com/ygopro/pics';

let memo = null; // axis -> { id, mime, dataUri, card }
let map = null;

function ensure() {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!map) {
    try { map = JSON.parse(readFileSync(MAP_FILE, 'utf8')); } catch { map = {}; }
    let changed = false;
    for (const [axis, rec] of Object.entries(map || {})) {
      if (rec?.id && !rec.file) { rec.file = `${rec.id}.${rec.ext || 'webp'}`; changed = true; }
    }
    if (changed) saveMap();
  }
  if (!memo) memo = new Map();
}
function saveMap() {
  try { writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), 'utf8'); } catch { /* ignore */ }
}
function extOf(mime) {
  if (/jpeg|jpg/i.test(mime)) return 'jpg';
  if (/png/i.test(mime)) return 'png';
  if (/webp/i.test(mime)) return 'webp';
  return 'img';
}

async function downloadArt(id) {
  ensure();
  const cached = Object.values(map).find(x => String(x.id) === String(id));
  if (cached) {
    const p = join(CACHE_DIR, cached.file || `${id}.${cached.ext || 'webp'}`);
    if (existsSync(p) && statSync(p).size >= 1024) {
      return { id, mime: cached.mime || 'image/webp', file: cached.file || `${id}.${cached.ext || 'webp'}`, buf: readFileSync(p) };
    }
  }
  const url = `${CDN}/${id}.jpg!art`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ygometa/1.0)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1024) return null;
  const mime = String(r.headers.get('content-type') || 'image/webp').split(';')[0];
  const ext = extOf(mime);
  const file = `${id}.${ext}`;
  try { writeFileSync(join(CACHE_DIR, file), buf); } catch { /* ignore */ }
  return { id, mime, ext, file, buf };
}

/**
 * 取一个卡组轴的代表卡插画(data URI)。优先缓存;失败返回 null(饼图退回纯色)。
 * 只走百鸽 CDN 的 !art 中间图,保证无卡片边框。
 */
export async function cardArtFor(axis) {
  if (!axis || /其他/.test(axis)) return null;
  ensure();
  if (memo.has(axis)) return memo.get(axis);
  const task = (async () => {
    // 对应表优先:手动改 map.json 的 id/file 后直接复用,不再被搜索覆盖
    const mapped = map[axis];
    if (mapped?.id && mapped.file) {
      const p = join(CACHE_DIR, mapped.file);
      if (existsSync(p) && statSync(p).size >= 1024) {
        const rec = {
          id: mapped.id,
          mime: mapped.mime || 'image/webp',
          card: mapped.card || axis,
          dataUri: `data:${mapped.mime || 'image/webp'};base64,${readFileSync(p).toString('base64')}`,
        };
        memo.set(axis, rec);
        return rec;
      }
    }
    let hits = [];
    try { hits = searchCards(axis, 8); } catch { return null; }
    for (const c of hits) {
      if (!c?.id) continue;
      try {
        const img = await downloadArt(c.id);
        if (!img) continue;
        const rec = {
          id: c.id,
          mime: img.mime,
          card: c.sc_name || c.cn_name || c.jp_name || axis,
          dataUri: `data:${img.mime};base64,${img.buf.toString('base64')}`,
        };
        memo.set(axis, rec);
        if (!map[axis] || String(map[axis].id) !== String(c.id)) {
          map[axis] = { id: c.id, card: rec.card, file: img.file || `${c.id}.${img.ext || 'webp'}`, mime: img.mime, ext: img.ext || extOf(img.mime) };
          saveMap();
        }
        return rec;
      } catch { /* 换下一张 */ }
    }
    memo.set(axis, null);
    return null;
  })();
  memo.set(axis, task);
  const out = await task;
  memo.set(axis, out);
  return out;
}

/** 字段 → 代表图 的本地对应表(图片文件在 cache/cardart 下) */
export function cardArtTable() {
  ensure();
  return { ...map };
}
