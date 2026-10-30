// 表情包批量 AI 命名:给 up_* 里还没有动态描述/标签的图跑视觉模型,写进 sticker_meta.json。
// 用法:
//   node agent/belial/autoname.mjs [--limit 5] [--force]
//   POST /api/belial/stickers/autoname {limit, force}  (WebUI「AI 命名未命名」按钮)
import './../env.mjs';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  stickerCatalog, stickerPath, stickerMime, dynamicStickerMeta, setStickerMeta,
} from './belial.mjs';

const KEY = () => process.env.DEEPSEEK_API_KEY || process.env.AI_CHAT_API_KEY || '';
const URL = () => process.env.AI_CHAT_API_URL || 'https://api.deepseek.com/chat/completions';
const MODEL = () => process.env.AI_CHAT_MODEL || 'deepseek-flash';
const TIMEOUT_MS = () => Math.max(10000, Number(process.env.BELIAL_STICKER_AUTONAME_TIMEOUT_MS || 45000));

// 默认贝利亚库;脚刷周等其它人格调用时传自己的 stickerApi(与 monitor 的 STICKER_API 同形)。
const BELIAL_STICKER_API = {
  catalog: stickerCatalog, path: stickerPath, mime: stickerMime,
  dynamicMeta: dynamicStickerMeta, setMeta: setStickerMeta,
};

const PROMPT = '看这张表情包,只输出 JSON:{"name":"不超过12字的中文短名","desc":"不超过30字的中文描述","tags":["3-5个中文标签"]}。不要输出别的。';

function parseCaption(content) {
  const m = String(content || '').match(/\{[\s\S]*?\}/);
  if (!m) throw new Error('视觉模型没返回 JSON');
  let obj;
  try { obj = JSON.parse(m[0]); } catch { throw new Error('视觉模型 JSON 解析失败'); }
  const desc = String(obj.desc || obj.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const tags = (Array.isArray(obj.tags) ? obj.tags : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 8);
  const label = String(obj.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!desc && !tags.length && !label) throw new Error('视觉模型没给出描述');
  return { desc, tags, label };
}

/** 让视觉模型看一张库里的表情包,写 desc/tags/label;已有描述时默认跳过 */
export async function captionSticker(name, { force = false, log = () => {}, stickerApi = BELIAL_STICKER_API } = {}) {
  const n = basename(String(name || '').trim());
  const p = stickerApi.path(n);
  if (!p) return { ok: false, name: n, error: '表情包不存在' };
  if (!force) {
    const m = stickerApi.dynamicMeta(n);
    if (m && m.desc) return { ok: true, name: n, ...m, cached: true };
  }
  if (!KEY()) return { ok: false, name: n, error: '没配聊天 key,无法识别' };
  const buf = readFileSync(p);
  if (buf.length > 2 * 1024 * 1024) return { ok: false, name: n, error: '图片超过 2MB,自动识别跳过' };
  const mime = stickerApi.mime(n) || 'image/jpeg';
  const body = (noThink) => ({
    model: MODEL(),
    messages: [
      { role: 'system', content: '你是表情包标注器。只输出 JSON,不要解释。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 300,
    ...(noThink ? { reasoning_effort: 'none' } : {}),
  });
  let last = '';
  for (const noThink of [true, false]) {
    let r;
    try {
      r = await fetch(URL(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body(noThink)),
        signal: AbortSignal.timeout(TIMEOUT_MS()),
      });
    } catch (e) {
      last = e?.name === 'TimeoutError' ? `超时 ${TIMEOUT_MS()}ms` : (e?.message || String(e));
      continue;
    }
    if (!r.ok) {
      last = `HTTP ${r.status}`;
      if (r.status >= 400 && r.status < 500 && noThink) continue;
      break;
    }
    const j = await r.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content;
    try {
      const meta = parseCaption(content);
      const saved = stickerApi.setMeta(n, meta);
      if (!saved.ok) return { ok: false, name: n, error: saved.message };
      log(`  🏷 ${n} → ${meta.label || meta.desc}`);
      return { ok: true, name: n, ...meta, cached: false };
    } catch (e) {
      last = e.message;
      break;
    }
  }
  return { ok: false, name: n, error: last || '识别失败' };
}

/** 批量命名 up_*;默认只跑没有动态描述的,limit 最多 10。stickerApi 可换人格库 */
export async function autonameStickers({ limit = 5, force = false, log = () => {}, stickerApi = BELIAL_STICKER_API } = {}) {
  const max = Math.min(10, Math.max(1, Number(limit) || 5));
  const targets = stickerApi.catalog()
    .filter(s => s.name.startsWith('up_'))
    .filter(s => force || !stickerApi.dynamicMeta(s.name)?.desc)
    .slice(0, max);
  let done = 0, failed = 0;
  const results = [];
  for (const s of targets) {
    const r = await captionSticker(s.name, { force, log, stickerApi });
    if (r.ok) done++; else failed++;
    results.push(r);
  }
  return { ok: true, total: targets.length, done, failed, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : 5;
  const force = args.includes('--force');
  autonameStickers({ limit, force, log: console.log })
    .then(r => {
      console.log(JSON.stringify({ total: r.total, done: r.done, failed: r.failed }));
      for (const x of r.results) if (!x.ok) console.log(`✗ ${x.name}: ${x.error}`);
      process.exitCode = r.failed ? 1 : 0;
    })
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
