// 卡表生成模块:ydk 文本 / 卡组码(base64 或 URL-safe base64)/ ydke:// 卡组链接 / 任意卡组分享链接
// → 官方版式 PDF 卡表(简体中文,与官方空白卡表同版式,填官方简体中文全称)。
//
// 官方赛事(巡回赛/WCQ 等)要求选手提交纸质卡表,填卡片的官方简体中文全称;
// 官方「网上卡表填写」= db.yugioh-card-cn.com 需登录的「我的牌组」打印功能,无公开 API,
// 因此生成后端调用社区「神人科技」卡表生成器(https://ygo.xyk.one/deck/,与官方同版式、
// 卡名来自官方名库,实测 42 主/12 额外/3 副 → 274KB PDF 含文本层):
//   POST /deck/generate  multipart:
//     input_type = link | ydk
//     deck_link  (link 型:卡组分享链接,如 YGOMobile 分享链接)
//     ydk_file   (ydk 型:ydk 文件,本模块先把文本/卡组码归一化成 ydk 再上传)
//     language   = sc(中文)| ja(日文)| en(英文),默认 sc
//   成功 → PDF blob;失败 → JSON { success:false, message }
//
// 零依赖(仅 node 内置 fetch/FormData/Blob);临时 PDF 输出到本目录 tmp/。
// CLI 自测:node decklist.mjs "@sample.ydk"       读本地 ydk 文件
//          node decklist.mjs "<ydk文本/base64/链接>" [--lang ja]  [--out 输出路径]

import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, 'tmp');

function cfg() { // 调用时读 env(兼容 monitor 先 import 后从 .env 注入的时序)
  return {
    api: process.env.DECK_GEN_API || 'https://ygo.xyk.one/deck/generate',
    lang: process.env.DECK_LANG || 'sc',
  };
}

// ---------- 输入分类:统一成 { kind:'link', url } | { kind:'ydk', text } ----------

// ydk 格式行判断:数字行 = 卡密(1-12 位)
function isIdLine(l) { return /^\d{1,12}$/.test(l.trim()); }
function idLines(text) { return text.split(/\r?\n/).filter(isIdLine); }

function normalizeYdk(text) {
  // 按 #main / #extra / !side 分段,产出最小化 ydk(丢弃 #created 等注释;无分段标记时整段当主卡组)
  const main = [], extra = [], side = [];
  let sec = 'main';
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^#main\b/.test(l)) { sec = 'main'; continue; }
    if (/^#extra\b/.test(l)) { sec = 'extra'; continue; }
    if (/^!side\b/.test(l)) { sec = 'side'; continue; }
    if (!isIdLine(l)) continue;
    (sec === 'main' ? main : sec === 'extra' ? extra : side).push(l);
  }
  if (!main.length && !extra.length && !side.length) return '';
  const out = ['#main', ...main];
  if (extra.length) out.push('#extra', ...extra);
  if (side.length) out.push('!side', ...side);
  return out.join('\n') + '\n';
}

function b64decode(encoded) { // 兼容 URL-safe base64
  return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// 卡组码(base64)→ ydk:常见于查卡器/客户端「复制卡组码」;base64 解出原始 ydk 文本
function classifyB64(raw) {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length < 60) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  try {
    const ydk = b64decode(compact);
    return (ydk.includes('#main') || idLines(ydk).length >= 10) ? ydk : null;
  } catch { return null; }
}

// 分类输入。返回 null = 无法识别;ydk 型返回已归一化 ydk 文本
export function classifyDeckInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // ydke://(EDOPro/YGOPro 类客户端分享链接):!分隔的 3 段 base64 = 主/额外/副
  if (/^ydke:\/\//i.test(s)) {
    try {
      const parts = s.replace(/^ydke:\/\//i, '').split('!').map(b64decode);
      const text = ['#main', idLines(parts[0] || ''),
        '#extra', idLines(parts[1] || ''),
        '!side', idLines(parts[2] || '')].join('\n');
      const ydk = normalizeYdk(text);
      return ydk ? { kind: 'ydk', text: ydk } : null;
    } catch { return null; }
  }
  // 普通 http(s) 分享链接 → 原样交给后端解析(后端支持 YGOMobile 分享链接等)
  if (/^https?:\/\//i.test(s)) return { kind: 'link', url: s };
  // 原始 ydk 文本(带 #main 段或 ≥10 行卡密)
  if (s.includes('#main') || idLines(s).length >= 10) {
    const ydk = normalizeYdk(s);
    return ydk ? { kind: 'ydk', text: ydk } : null;
  }
  // 卡组码(base64)→ ydk 文本
  const b64 = classifyB64(s);
  if (b64) return { kind: 'ydk', text: normalizeYdk(b64) };
  return null;
}

export function deckCounts(cls) { // ydk 型分区张数(便于回复时附状态);link 型返回 null
  if (cls.kind !== 'ydk') return null;
  const lines = cls.text.split(/\r?\n/);
  const counts = { main: 0, extra: 0, side: 0 };
  let sec = 'main';
  for (const l of lines) {
    if (/^#main\b/.test(l)) { sec = 'main'; continue; }
    if (/^#extra\b/.test(l)) { sec = 'extra'; continue; }
    if (/^!side\b/.test(l)) { sec = 'side'; continue; }
    if (isIdLine(l)) counts[sec]++;
  }
  return counts;
}

// ---------- 生成 PDF ----------
export async function generateDeckListPdf({ raw, lang, outPath }) {
  const c = cfg();
  const cls = classifyDeckInput(raw);
  if (!cls) throw new Error('无法识别的卡组内容:支持 ydk 文本 / 卡组码(base64)/ ydke:// 链接 / http(s) 卡组分享链接。');
  const fd = new FormData();
  if (cls.kind === 'link') {
    fd.append('input_type', 'link');
    fd.append('deck_link', cls.url);
  } else {
    fd.append('input_type', 'ydk');
    fd.append('ydk_file', new Blob([cls.text], { type: 'text/plain' }), 'deck.ydk');
  }
  fd.append('language', lang || c.lang);
  log(`生成卡表: ${cls.kind === 'link' ? `link ${cls.url.slice(0, 90)}` : `ydk ${JSON.stringify(deckCounts(cls))}`} (lang=${lang || c.lang})`);
  const res = await fetch(c.api, { method: 'POST', body: fd, signal: AbortSignal.timeout(90000) });
  const ct = res.headers.get('content-type') || '';
  let body = Buffer.alloc(0);
  if (ct.includes('application/json') || !res.ok) {
    try { body = Buffer.from(await res.arrayBuffer()); } catch {}
    let msg = '';
    try { msg = JSON.parse(body.toString('utf8')).message || ''; } catch {}
    if (msg) throw new Error(msg); // 后端中文错误信息(如「未找到主卡组信息:…」)
    throw new Error(`卡表生成失败(HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`卡表生成失败(HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5000 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('卡表生成结果异常(非 PDF),可稍后重试或改用网页 https://ygo.xyk.one/deck/');
  }
  // 落到临时目录(默认 agent/ygocard/tmp/);同时清理 3 天前的旧文件
  mkdirSync(TMP_DIR, { recursive: true });
  const path = outPath || join(TMP_DIR, `卡表_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.pdf`);
  writeFileSync(path, buf);
  pruneOld();
  return { path, bytes: buf.length, cls };
}

function pruneOld() {
  try {
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    for (const f of readdirSync(TMP_DIR)) {
      const p = join(TMP_DIR, f);
      try { if (statSync(p).mtimeMs < cutoff) rmSync(p); } catch {}
    }
  } catch {}
}

function log(msg) { console.log('[卡表]', msg); }

// ---------- CLI 自测 ----------
// 用法:node decklist.mjs "<ydk文本|卡组码|链接>" [--lang ja|en|sc] [--out 路径]
//      参数为 @文件路径 → 读文件内容作 ydk(如 node decklist.mjs @sample.ydk)
//      无参数 → 打印用法
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const args = process.argv.slice(2);
  const li = args.indexOf('--lang'), oi = args.indexOf('--out');
  const lang = li >= 0 ? args[li + 1] : undefined;
  const out = oi >= 0 ? args[oi + 1] : undefined;
  const skip = new Set(['--lang', '--out', lang, out].filter(Boolean));
  const inputArg = args.filter(a => !skip.has(a))[0];
  if (!inputArg) {
    console.log('用法:node decklist.mjs "<ydk文本|卡组码|ydke://链接|分享链接>" [--lang sc|ja|en] [--out 路径]\n'
      + '     @文件路径 → 读本地 ydk 文件\n'
      + '示例:node decklist.mjs "@sample.ydk"\n'
      + '     node decklist.mjs "@卡组.ydk" --out 卡表.pdf');
    process.exit(1);
  }
  const raw = inputArg.startsWith('@')
    ? readFileSync(resolve(inputArg.slice(1)), 'utf8')
    : inputArg;
  generateDeckListPdf({ raw, lang, outPath: out }).then(r => {
    log(`OK → ${r.path} (${(r.bytes / 1024).toFixed(0)}KB)`);
    if (r.cls.kind === 'ydk') log('分区: ' + JSON.stringify(deckCounts(r.cls)));
  }).catch(e => { console.error('✗', e.message); process.exit(1); });
}
