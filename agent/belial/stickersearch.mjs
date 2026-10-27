// 贝利亚表情包:图片搜索(360 图片接口)+ 从公网 URL 下载进库
//
// 为什么图片搜索不走 DeepSeek 官方 Search:DS Search 返回的是网页结果,不是可直接下载的图片 URL;
// 模型要「找一张新表情包」得先拿到图片直链,所以这里用 360 图片搜索补这一层。
// 文字/事实搜索仍走 deepsearch.mjs 的 DeepSeek 官方 Search。
//
// 下载权限的护栏:
//   · 只允许 http/https、公网 host(拒绝 localhost/内网/链路本地,防 SSRF)
//   · 单张 ≤ BELIAL_STICKER_MAX_BYTES(默认 5MB)
//   · 不信 Content-Type,addSticker 按文件头只认 jpg/png/gif/webp
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addSticker, MAX_STICKER_BYTES } from './belial.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const IMG_SEARCH = 'https://image.so.com/j';
const timeoutMs = () => Math.max(3000, Number(process.env.BELIAL_DOWNLOAD_TIMEOUT_MS || 20000));

/** 内网/本机/链路本地 host 一律拒绝(SSRF 护栏) */
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata') return true;
  if (h === '::1' || h === '0.0.0.0' || h.startsWith('::ffff:')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(h)) return true;
  return false;
}

/** 搜贝利亚表情包图片(360 图片),返回图片直链,交给模型挑 */
export async function searchStickerImages(query, { count = 6, timeout = 20000 } = {}) {
  const q = String(query || '').trim().slice(0, 60);
  if (!q) return { ok: false, error: '搜索词为空' };
  const url = `${IMG_SEARCH}?q=${encodeURIComponent(q)}&src=srp&sn=0&pn=30`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://image.so.com/' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return { ok: false, error: `图片搜索 HTTP ${r.status}` };
    const j = await r.json().catch(() => null);
    const list = Array.isArray(j?.list) ? j.list : [];
    const out = [];
    for (const x of list) {
      const u = String(x.img || x.thumb || x.thumb_bak || '').trim();
      if (!/^https?:\/\//i.test(u)) continue;
      const w = Number(x.width) || 0, h = Number(x.height) || 0;
      if (w && h && (w < 200 || h < 200)) continue;       // 太小的多半是图标
      out.push({
        title: String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        url: u, width: w, height: h,
        page: String(x.link || ''),
      });
      if (out.length >= Math.max(1, Math.min(10, count))) break;
    }
    if (!out.length) return { ok: true, count: 0, text: `图片搜索「${q}」没有找到可用的图。`, results: [] };
    const lines = [`图片搜索「${q}」:${out.length} 张`];
    out.forEach((x, i) => lines.push(`${i + 1}. ${x.title || '(无标题)'} ${x.width}x${x.height}\n   ${x.url}`));
    return { ok: true, count: out.length, text: lines.join('\n'), results: out };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' ? '图片搜索超时' : (e?.message || String(e)) };
  }
}

/**
 * 从公网图片 URL 下载一张图,存进表情包库。
 * @returns {{ok:boolean, name?:string, size?:number, error?:string, message?:string}}
 */
export async function downloadSticker(rawUrl, name = '') {
  let u;
  try { u = new URL(String(rawUrl || '').trim()); }
  catch { return { ok: false, error: 'URL 不合法' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http/https' };
  if (u.username || u.password) return { ok: false, error: 'URL 不能带用户名/密码' };
  if (isPrivateHost(u.hostname)) return { ok: false, error: '不允许下载内网/本机地址' };

  let last = '';
  // 有的图床挑 Referer;先按图片搜索的来源试,再试 B 站,最后空 Referer
  for (const ref of ['https://image.so.com/', 'https://www.bilibili.com/', '']) {
    try {
      const r = await fetch(u, {
        headers: { 'User-Agent': UA, ...(ref ? { Referer: ref } : {}) },
        signal: AbortSignal.timeout(timeoutMs()),
        redirect: 'follow',
      });
      if (!r.ok) {
        last = `HTTP ${r.status}`;
        if ([401, 403, 404, 410].includes(r.status)) continue;   // 换 Referer 再试
        break;
      }
      const declared = Number(r.headers.get('content-length') || 0);
      if (declared > MAX_STICKER_BYTES + 1024 * 1024) return { ok: false, error: `图片太大(${Math.round(declared / 1024 / 1024)}MB)` };
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) { last = '空内容'; continue; }
      if (buf.length > MAX_STICKER_BYTES) return { ok: false, error: `图片太大(上限 ${Math.round(MAX_STICKER_BYTES / 1024 / 1024)}MB)` };
      const guessed = basename(u.pathname || '') || '搜到的表情包';
      const r2 = addSticker(buf, String(name || '').trim() || guessed);
      return r2.ok ? { ok: true, name: r2.name, size: r2.size } : { ok: false, error: r2.message || '保存失败' };
    } catch (e) {
      last = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `超时 ${timeoutMs()}ms` : (e?.message || String(e));
    }
  }
  return { ok: false, error: last || '下载失败' };
}

// CLI: node stickersearch.mjs "查询词" | --selftest
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    const checks = [
      [isPrivateHost('127.0.0.1') === true, '内网 127 被拒'],
      [isPrivateHost('192.168.1.2') === true, '内网 192.168 被拒'],
      [isPrivateHost('10.0.0.1') === true, '内网 10 被拒'],
      [isPrivateHost('example.com') === false, '公网域名放行'],
    ];
    Promise.resolve(downloadSticker('http://127.0.0.1/x.jpg')).then(r => {
      checks.push([r.ok === false, '下载本机地址被拒']);
      for (const [ok, m] of checks) console.log(`${ok ? '✓' : '✗'} ${m}`);
      process.exitCode = checks.every(x => x[0]) ? 0 : 1;
    });
  } else {
    const q = args.join(' ') || '贝利亚表情包';
    searchStickerImages(q, { count: 6 }).then(r => {
      console.log(r.ok ? r.text : `图片搜索失败: ${r.error}`);
      process.exitCode = r.ok ? 0 : 1;
    });
  }
}
