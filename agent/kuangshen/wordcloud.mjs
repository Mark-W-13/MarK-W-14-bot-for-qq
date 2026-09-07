// 框神语录词云:精筛语录 → jieba 分词统计 → 螺旋碰撞布局 → SVG → Edge 截图 PNG
// 用法:
//   node wordcloud.mjs               # 生成 wordcloud.png(默认滤笑声/感叹词,聚焦话题)
//   node wordcloud.mjs --keep-laughs # 保留 哈哈/卧槽/牛逼 等个人特征词
// 依赖: python + jieba(本地安装),Edge headless 截图(与屎图渲染同管线)
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadQuotes, filterFeatured, loadBlacklist } from './kuangshen.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TMP = join(__dirname, 'tmp');
const TEXTS_PATH = join(__dirname, 'tmp', 'wordcloud_texts.txt');
const FREQ_PATH = join(__dirname, 'tmp', 'wordcloud_freq.json');
const HTML_PATH = join(__dirname, 'tmp', 'wordcloud.html');
const PNG_PATH = join(__dirname, 'wordcloud.png');
const KEEP_LAUGHS = process.argv.includes('--keep-laughs');

const W = 1600, H = 1200, MARGIN = 48;          // 画布与边距
const MAX_SIZE = 116, MIN_SIZE = 20;            // 字号范围
const TOP_N = 60;                               // 进云词数
// 词频 → 颜色(sequential blue,暗→亮 对应 大→小;validate_palette --ordinal 校验通过)
const TIERS = ['#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
const N_TIERS = TIERS.length;

// ---------- 中文文本度量(无 DOM,按字宽估算) ----------
function measure(w, fs) {
  let wpx = 0;
  for (const ch of w) {
    const code = ch.codePointAt(0);
    if (code > 0x2e7f) wpx += 1.0;          // CJK/全角
    else if (/[a-zA-Z0-9]/.test(ch)) wpx += 0.56;
    else if (ch === ' ') wpx += 0.33;
    else wpx += 0.8;
  }
  return { w: wpx * fs + fs * 0.22, h: fs * 1.28 };
}

// ---------- 螺旋布局(中心向外,碰撞检测) ----------
function layout(words) {
  const placed = [];
  const overlap = (x, y, w, h) => placed.some(b =>
    x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y);
  const cx = W / 2, cy = H / 2;
  const out = [];
  for (const item of words) {
    const { w, h } = measure(item.word, item.size);
    const pad = 6;
    let placedBox = null;
    const maxR = Math.hypot(W, H) / 2;
    const maxA = (maxR - 6) / 2.3;                        // 半径增长 2.3/rad,螺旋覆盖整幅画布
    for (let a = 0; a < maxA; a += 0.12) {
      const r = 6 + a * 2.3;
      if (r > maxR) break;
      const x = cx + r * Math.cos(a) - w / 2;
      const y = cy + r * Math.sin(a) - h / 2;
      if (x < MARGIN || y < MARGIN || x + w > W - MARGIN || y + h > H - MARGIN) continue;
      if (overlap(x - pad, y - pad, w + pad * 2, h + pad * 2)) continue;
      placedBox = { x, y, w, h };
      break;
    }
    if (!placedBox) continue;               // 放不下就跳过
    placed.push(placedBox);
    out.push({ ...item, box: placedBox });
  }
  return out;
}

// ---------- 生成 SVG ----------
function buildSvg(items, totalQuotes) {
  const els = [];
  for (const it of items) {
    const tier = N_TIERS - 1 - Math.min(N_TIERS - 1, Math.floor(it.rank / items.length * N_TIERS)); // 大词=深阶
    const bold = it.size >= 48 ? ' font-weight="600"' : '';
    const x = it.box.x + it.box.w / 2, y = it.box.y + it.box.h / 2;
    els.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="${it.size}" fill="${TIERS[tier]}"${bold}>${esc(it.word)}</text>`);
  }
  const today = new Date().toISOString().slice(0, 10);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#fcfcfb}
  </style></head><body>
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Microsoft YaHei,'微软雅黑',Segoe UI,sans-serif">
    <rect width="100%" height="100%" fill="#fcfcfb"/>
    ${els.join('\n    ')}
    <text x="${W / 2}" y="${H - 24}" text-anchor="middle" font-size="15" fill="#898781" font-family="Segoe UI,sans-serif">框神语录 · 词云 · ${totalQuotes} 条 · ${today}</text>
  </svg></body></html>`;
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- Edge 截图(与屎图渲染同管线) ----------
function shot(htmlPath, pngPath) {
  return new Promise((resolve, reject) => {
    const url = `file:///${htmlPath.replace(/\\/g, '/')}`;
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run',
      '--run-all-compositor-stages-before-draw', '--virtual-time-budget=8000',
      `--window-size=${W},${H}`,
      `--screenshot=${pngPath}`,
      `--user-data-dir=${join(TMP, 'edge_prof')}`,
      url,
    ];
    const child = spawn(EDGE, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Edge 启动失败: ${e.message}`)); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (!existsSync(pngPath)) return reject(new Error(`截图失败(exit ${code})`));
      resolve(pngPath);
    });
  });
}

// ---------- 主流程 ----------
async function main() {
  // 1. 精筛语录 → 文本文件(黑名单跳过,与抽语录口径一致)
  const blacked = new Set(loadBlacklist().map(x => x.seq));
  const quotes = filterFeatured(loadQuotes()).filter(q => !blacked.has(q.seq));
  const texts = [...new Set(quotes.map(q => q.text.replace(/\[[^\]]*\]/g, '').replace(/\s*\n+\s*/g, ' ').trim()))].filter(Boolean);
  mkdirSync(TMP, { recursive: true });
  writeFileSync(TEXTS_PATH, texts.join('\n'), 'utf8');

  // 2. jieba 分词统计
  const seg = spawn('python', [join(__dirname, 'wordcloud_seg.py'), TEXTS_PATH, FREQ_PATH, KEEP_LAUGHS ? '1' : '0'], { windowsHide: true });
  await new Promise((res, rej) => { seg.on('exit', c => (c === 0 ? res() : rej(new Error(`分词失败 exit ${c}`)))); seg.on('error', rej); });
  const freq = JSON.parse(readFileSync(FREQ_PATH, 'utf8')).slice(0, TOP_N);
  console.log(`语录 ${texts.length} 条 / 词 ${freq.length} 个 / 词频区间 ${freq[0]?.n ?? 0} ~ ${freq[freq.length - 1]?.n ?? 0}`);

  // 3. 布局 + SVG + 截图
  // 长词加权排名:中文 4+ 字 ×2.2 / 3 字 ×1.25,让「耀圣卡通」「磁石战士」类短语上浮;
  // 纯 ASCII 词(link/combo 等)不加权,按原频排
  const wlen = w => [...w].length;
  const hasCjk = w => /[一-鿿]/.test(w);
  const score = ({ w, n }) => n * (!hasCjk(w) ? 1.0 : wlen(w) >= 4 ? 2.2 : wlen(w) === 3 ? 1.25 : 1.0);
  const top = freq.sort((a, b) => score(b) - score(a)).slice(0, TOP_N);
  const nMax = top[0].n, nMin = top[top.length - 1].n;
  const words = top.map(({ w, n }, i) => {
    const f = Math.max(0.04, (n - nMin) / (nMax - nMin));
    return { word: w, n, rank: i, size: Math.round(MIN_SIZE + (MAX_SIZE - MIN_SIZE) * Math.sqrt(f)) };
  });
  const placed = layout(words);
  console.log(`布局完成: ${placed.length}/${words.length} 词放入`);
  writeFileSync(HTML_PATH, buildSvg(placed, quotes.length), 'utf8');
  const png = await shot(HTML_PATH, PNG_PATH);
  console.log('词云图:', png);
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
