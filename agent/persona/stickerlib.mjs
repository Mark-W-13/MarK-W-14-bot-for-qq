// 人格表情包库(通用实现):贝利亚 / 脚刷周 / 以后别的人格共用这一套。
//
// 2026-10-29 从 belial.mjs 抽出来:原来贴图库(列表、路径校验、上传校验、AI 命名元数据、
// 按标签挑图)全写在贝利亚模块里,新增脚刷周时如果照抄一遍会有两份会走样的实现。
// 这里做成工厂:每个模块传自己的目录 / 元数据文件 / 种子描述,行为与旧版完全一致。
//
// 只认 jpg/png/gif/webp(按**文件头**认,不信扩展名);上传文件加 up_ 前缀;路径穿越挡掉。
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
};

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: '.png', mime: 'image/png' };
  const head = buf.subarray(0, 12).toString('ascii');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return { ext: '.gif', mime: 'image/gif' };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  return null;
}

function safeBase(name, ext, fallbackName) {
  let s = String(name || '').trim();
  s = basename(s).replace(/\.[^.]+$/, '');
  s = s.replace(/[^\w\u4e00-\u9fa5\- ]+/g, '').trim();
  s = s.replace(/\s+/g, ' ').slice(0, 40).trim();
  return (s || fallbackName) + ext;
}

/**
 * 建一个表情包库。
 * @param {object} o
 * @param {() => string} o.dir          目录(延迟解析,自测里换 env 立刻生效)
 * @param {() => string} o.metaPath     动态元数据 JSON 路径(延迟解析)
 * @param {object} o.seedMeta           文件名 → {desc,tags,label} 的种子描述
 * @param {object} o.seedLabels         文件名 → 短名
 * @param {string} o.prefix             上传文件前缀(默认 up_)
 * @param {string} o.fallbackName       上传文件没有合法名字时的兜底
 * @param {number} o.maxBytes           单张上限
 */
export function createStickerStore({
  dir, metaPath, seedMeta = {}, seedLabels = {}, prefix = 'up_', fallbackName = 'persona', maxBytes = 5 * 1024 * 1024,
}) {
  const MAX_STICKER_BYTES = Math.max(64 * 1024, Number(maxBytes) || 5 * 1024 * 1024);
  const stickerDir = () => dir();

  function uniqueName(base) {
    const d = stickerDir();
    if (!existsSync(join(d, base))) return base;
    const ext = extname(base);
    const stem = base.slice(0, -ext.length);
    for (let i = 2; i < 1000; i++) {
      const n = `${stem}_${i}${ext}`;
      if (!existsSync(join(d, n))) return n;
    }
    return `${stem}_${Date.now().toString(36)}${ext}`;
  }

  function listStickers() {
    const d = stickerDir();
    try {
      return readdirSync(d)
        .filter(f => !f.startsWith('.') && MIME_BY_EXT[extname(f).toLowerCase()])
        .map(f => {
          const p = join(d, f);
          try {
            const st = statSync(p);
            return st.isFile() ? { name: f, size: st.size, mtime: st.mtimeMs, mime: MIME_BY_EXT[extname(f).toLowerCase()] } : null;
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    } catch { return []; }
  }

  // 动态元数据:种子图走 seedMeta,群表情/上传图由 AI 命名后写这里(运行时文件,不入库)。
  function loadStickerMeta() {
    try {
      const j = JSON.parse(readFileSync(metaPath(), 'utf8'));
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch { return {}; }
  }
  function saveStickerMetaFile(all) {
    try {
      const p = metaPath();
      writeFileSync(p + '.tmp', JSON.stringify(all, null, 1), 'utf8');
      renameSync(p + '.tmp', p);
      return true;
    } catch { return false; }
  }
  function dynamicStickerMeta(name) { return loadStickerMeta()[String(name)] || null; }

  function setStickerMeta(name, { desc = '', tags = [], label = '' } = {}) {
    const n = basename(String(name || '').trim());
    if (!stickerPath(n)) return { ok: false, message: '表情包不存在' };
    const d = String(desc || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const t = (Array.isArray(tags) ? tags : [])
      .map(x => String(x || '').replace(/[#,，]/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).slice(0, 8);
    const l = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!d && !t.length && !l) return { ok: false, message: 'desc / tags / label 至少给一个' };
    const all = loadStickerMeta();
    all[n] = {
      ...(all[n] || {}),
      ...(d ? { desc: d } : {}),
      ...(t.length ? { tags: t } : {}),
      ...(l ? { label: l } : {}),
      updatedAt: Date.now(),
    };
    if (!saveStickerMetaFile(all)) return { ok: false, message: '写表情包元数据失败' };
    return { ok: true, name: n, desc: d, tags: t, label: l };
  }

  function removeStickerMeta(name) {
    const n = String(name || '').trim();
    const all = loadStickerMeta();
    if (!all[n]) return false;
    delete all[n];
    return saveStickerMetaFile(all);
  }

  function stickerPath(name) {
    const n = String(name || '').trim();
    if (!n || n !== basename(n) || n.startsWith('.') || n.includes('..')) return null;
    if (!MIME_BY_EXT[extname(n).toLowerCase()]) return null;
    const root = resolve(stickerDir());
    const p = resolve(join(root, n));
    if (p !== join(root, n) || !p.startsWith(root + sep)) return null;
    try { return statSync(p).isFile() ? p : null; } catch { return null; }
  }

  function stickerMime(name) {
    const p = stickerPath(name);
    return p ? (MIME_BY_EXT[extname(p).toLowerCase()] || '') : '';
  }

  function stickerSegment(name) {
    const p = stickerPath(name);
    if (!p) return null;
    try { return { type: 'image', data: { file: `base64://${readFileSync(p).toString('base64')}` } }; }
    catch { return null; }
  }

  function pickSticker(rand = Math.random) {
    const list = listStickers();
    if (!list.length) return null;
    const i = Math.floor(Math.max(0, Math.min(0.999999, Number(rand()) || 0)) * list.length);
    return list[i].name;
  }

  function stickerCatalog() {
    const dyn = loadStickerMeta();
    return listStickers().map(s => ({
      ...s,
      ...(seedMeta[s.name] || { desc: '', tags: [] }),
      ...(seedLabels[s.name] ? { label: seedLabels[s.name] } : {}),
      ...(dyn[s.name] || {}),
    }));
  }

  function pickStickerForScene(scene = '', rand = Math.random) {
    const text = String(scene || '').trim().toLowerCase();
    const list = stickerCatalog();
    if (!list.length) return null;
    if (text) {
      let best = null, bestScore = 0;
      for (const s of list) {
        let score = 0;
        for (const t of (s.tags || [])) {
          const tag = String(t).toLowerCase();
          if (tag && text.includes(tag)) score += 2;
        }
        if (s.desc && text.length >= 2 && String(s.desc).toLowerCase().includes(text)) score += 1;
        if (score > bestScore) { bestScore = score; best = s.name; }
      }
      if (best) return best;
    }
    return pickSticker(rand);
  }

  function resolveSticker({ name = '', scene = '' } = {}, rand = Math.random) {
    const n = String(name || '').trim();
    if (n) {
      const direct = stickerPath(n);
      if (direct) return basename(direct);
      const low = n.replace(/\.(jpe?g|png|gif|webp)$/i, '').toLowerCase();
      const list = stickerCatalog();
      const byName = list.find(s => s.name.toLowerCase().includes(low));
      if (byName) return byName.name;
      const byTag = list.find(s => (s.tags || []).some(t => {
        const tag = String(t).toLowerCase();
        return tag === low || low.includes(tag);
      }));
      if (byTag) return byTag.name;
    }
    return pickStickerForScene(scene, rand);
  }

  function addSticker(buf, originalName = '') {
    if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, message: '空文件' };
    if (buf.length > MAX_STICKER_BYTES) {
      return { ok: false, message: `文件太大(上限 ${Math.round(MAX_STICKER_BYTES / 1024 / 1024)}MB)` };
    }
    const kind = sniffImage(buf);
    if (!kind) return { ok: false, message: '不是支持的图片格式(只收 jpg / png / gif / webp)' };
    try {
      const d = stickerDir();
      mkdirSync(d, { recursive: true });
      const base = prefix + safeBase(originalName, kind.ext, fallbackName);
      const name = uniqueName(base);
      const dst = join(d, name);
      writeFileSync(dst + '.tmp', buf);
      renameSync(dst + '.tmp', dst);
      return { ok: true, name, size: buf.length };
    } catch (e) {
      return { ok: false, message: `写入失败:${e.message}` };
    }
  }

  function addStickerAuto(buf, originalName = '群表情') {
    if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, message: '空文件' };
    if (buf.length > MAX_STICKER_BYTES) {
      return { ok: false, message: `文件太大(上限 ${Math.round(MAX_STICKER_BYTES / 1024 / 1024)}MB)` };
    }
    if (!sniffImage(buf)) return { ok: false, message: '不是支持的图片格式(只收 jpg / png / gif / webp)' };
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const d = stickerDir();
    try {
      for (const f of readdirSync(d)) {
        if (!MIME_BY_EXT[extname(f).toLowerCase()]) continue;
        try {
          const p = join(d, f);
          const st = statSync(p);
          if (!st.isFile() || st.size !== buf.length) continue;
          if (f.includes(hash)) return { ok: false, duplicate: true, name: f, message: `已存在:${f}` };
          const same = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) === hash;
          if (same) return { ok: false, duplicate: true, name: f, message: `已存在:${f}` };
        } catch { /* 单张读失败不影响别的 */ }
      }
    } catch { /* 目录不存在 → 直接新增 */ }
    const r = addSticker(buf, `${originalName}_${hash}`);
    return { ...r, duplicate: false };
  }

  function deleteSticker(name) {
    const p = stickerPath(name);
    if (!p) return { ok: false, message: '文件名不合法或文件不存在' };
    try {
      unlinkSync(p);
      removeStickerMeta(String(name));
      return { ok: true, name: String(name) };
    } catch (e) {
      return { ok: false, message: `删除失败:${e.message}` };
    }
  }

  function stickerMetaOf(name) { return seedMeta[String(name)] || null; }

  return {
    MAX_STICKER_BYTES, stickerDir,
    listStickers, stickerPath, stickerMime, stickerSegment, pickSticker,
    stickerCatalog, pickStickerForScene, resolveSticker,
    addSticker, addStickerAuto, deleteSticker,
    setStickerMeta, dynamicStickerMeta, removeStickerMeta, stickerMetaOf,
  };
}
