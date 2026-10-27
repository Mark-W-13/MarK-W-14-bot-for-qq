// 环境饼图渲染器(2026-10-26 新增;当晚按用户反馈重做)
//
// 这版的口径(用户 2026-10-26 晚明确):
//   · 混轴占比用**弧度**表示:一个卡组按轴数均分到各轴(烙印光与暗 → 烙印 0.5 + 光与暗 0.5),
//     每个轴只有一种颜色,不再用外圈径向色带/多色块;
//   · **不放图例**:饼图放大居中,卡组名直接外引标注;
//   · 只露 6~7 个卡组(某个占比特别大时更少),其余合并为「其他」;
//   · 样本数量放右上角。
// 输出仍是 SVG → Chrome headless 截图 PNG(中文由系统字体处理)。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from '../env.mjs';
import { cardArtFor } from './cardart.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = process.env.YGOMETA_TMP_DIR || join(__dirname, 'cache', 'html');

// 最多 7 个卡组 + 其他,所以只需要 7 种高区分度颜色 + 1 个灰
const PALETTE = ['#3e6fa6', '#c46f4d', '#5b9b7f', '#d0a142', '#a96a8b', '#7c8b4b', '#6b5a8e'];
const OTHERS_COLOR = '#c3beb0';
const MIX_OTHER_COLOR = '#b7a78f';   // 没进前 7 的混轴统一用暖沙色,不再额外上色

const PAPER = '#f4f1e8';
const INK = '#25251f';
const MUTED = '#8c8676';
const HAIR = '#ddd7c7';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtPct(n, total) {
  if (!total) return '0.0';
  return ((n / total) * 100).toFixed(1);
}
function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? size : size * 0.56;
  return Math.ceil(w);
}

/**
 * 选「露几个」:占比集中就少露,分散就多露(最多 7 个)。
 * 阈值按用户要求:6~7 个是常态,出现特别大的块时减到 5/4/3 个。
 */
export function pickShowCount(list, total) {
  if (!list.length || !total) return 0;
  const top = list[0].num / total;
  if (top >= 0.5) return 3;
  if (top >= 0.35) return 4;
  if (top >= 0.25) return 5;
  if (top >= 0.18) return 6;
  return 7;
}

/** 排序后取前 N 个 + 「其他」;N 由占比集中度决定 */
export function sliceCounts(counts) {
  const list = [...counts].filter(c => c && c.num > 0).sort((a, b) => b.num - a.num || String(a.name).localeCompare(String(b.name), 'zh'));
  const total = list.reduce((s, c) => s + c.num, 0);
  const n = Math.min(list.length, pickShowCount(list, total));
  if (list.length <= n) return { slices: list.map(c => ({ ...c })), total };
  const shown = list.slice(0, n).map(c => ({ ...c }));
  const rest = list.slice(n);
  const num = rest.reduce((s, c) => s + c.num, 0);
  if (num > 0) shown.push({ name: '其他', num, isOthers: true });
  return { slices: shown, total };
}

function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function sectorPath(cx, cy, r, a0, a1) {
  if (a1 - a0 >= 359.999) {
    const p1 = polar(cx, cy, r, a0), p2 = polar(cx, cy, r, a0 + 180);
    return [`M ${cx} ${cy}`, `L ${p1.x} ${p1.y}`, `A ${r} ${r} 0 1 1 ${p2.x} ${p2.y}`, `A ${r} ${r} 0 1 1 ${p1.x} ${p1.y}`, 'Z'].join(' ');
  }
  const p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return [`M ${cx} ${cy}`, `L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`, `A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`, 'Z'].join(' ');
}
/** 采样扇区/圆环的包围盒和近似中心,给单张卡图定位 */
function arcBox(cx, cy, rOut, rIn, a0, a1) {
  const pts = [];
  if (!rIn) pts.push({ x: cx, y: cy });
  const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / 10));
  for (let i = 0; i <= n; i++) {
    const deg = a0 + (a1 - a0) * i / n;
    pts.push(polar(cx, cy, rOut, deg));
    if (rIn) pts.push(polar(cx, cy, rIn, deg));
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sx = 0, sy = 0;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    sx += p.x; sy += p.y;
  }
  return { x: sx / pts.length, y: sy / pts.length, w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY };
}

function bandPath(cx, cy, rOut, rIn, a0, a1) {  if (a1 - a0 >= 359.999) {
    const o1 = polar(cx, cy, rOut, a0), o2 = polar(cx, cy, rOut, a0 + 180);
    const i1 = polar(cx, cy, rIn, a0), i2 = polar(cx, cy, rIn, a0 + 180);
    return [
      `M ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
      `A ${rOut} ${rOut} 0 1 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)}`,
      `A ${rOut} ${rOut} 0 1 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
      'Z',
      `M ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
      `A ${rIn} ${rIn} 0 1 0 ${i2.x.toFixed(2)} ${i2.y.toFixed(2)}`,
      `A ${rIn} ${rIn} 0 1 0 ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
      'Z',
    ].join(' ');
  }
  const p0o = polar(cx, cy, rOut, a0), p1o = polar(cx, cy, rOut, a1);
  const p1i = polar(cx, cy, rIn, a1), p0i = polar(cx, cy, rIn, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${p0o.x.toFixed(2)} ${p0o.y.toFixed(2)}`,
    `A ${rOut} ${rOut} 0 ${large} 1 ${p1o.x.toFixed(2)} ${p1o.y.toFixed(2)}`,
    `L ${p1i.x.toFixed(2)} ${p1i.y.toFixed(2)}`,
    `A ${rIn} ${rIn} 0 ${large} 0 ${p0i.x.toFixed(2)} ${p0i.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

/**
 * 生成一张环境饼图 PNG。
 * @param {object} opt
 * @param {{start:number,end:number,label:string}} opt.range
 * @param {Array<{name:string,num:number}>} opt.counts  轴占比(num 可以是小数,总和 = 副数)
 * @param {number} [opt.totalPosts]
 * @param {number} [opt.axisCount]
 * @param {number} [opt.totalEntries]
 * @param {boolean} [opt.truncated]
 * @param {string} opt.outPath
 * @param {(s:string)=>void} [opt.log]
 */
export async function renderMetaPie(opt) {
  const { range, counts, totalPosts = 0, axisCount = 0, truncated = false, outPath, log = () => {} } = opt;
  const { slices, total } = sliceCounts(counts);
  const totalEntries = opt.totalEntries || total;

  // 只给「露出来的 7 个主轴」分配颜色;没露的混轴统一暖沙色,避免颜色爆炸
  const colorMap = new Map();
  slices.forEach((s, i) => { if (!s.isOthers) colorMap.set(s.name, PALETTE[i % PALETTE.length]); });
  const colorOf = name => colorMap.get(name) || MIX_OTHER_COLOR;
  const topNames = new Set(slices.filter(x => !x.isOthers).map(x => x.name));

  // 主轴 + 真正会画出来的副轴才去找代表图;其他/其他混轴保持纯色
  const needArt = new Set(slices.filter(s => !s.isOthers).map(s => s.name));
  for (const s of slices) {
    if (s.isOthers || !Array.isArray(s.buckets)) continue;
    for (const b of s.buckets) {
      if (b.name === '其他混轴' || !b.count) continue;
      if (b.share >= 0.40 || (topNames.has(b.name) && b.share >= 0.10)) needArt.add(b.name);
    }
  }
  const arts = new Map();
  await Promise.all([...needArt].map(async name => {
    try {
      const a = await cardArtFor(name);
      if (a) arts.set(name, a);
    } catch { /* 单张失败不影响饼图 */ }
  }));
  if (arts.size) log(`  卡组代表图:${arts.size}/${needArt.size} 张`);

  let pseq = 0;
  const clipDefs = [];
  const clipFor = (d) => {
    const id = `clip${++pseq}`;
    clipDefs.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`);
    return id;
  };

  const W = 1360;
  const H = 1020;
  // Linux headless Chrome 的 --window-size 高度含 88px 浏览器 UI(实测);Windows Edge 没有。
  const EXTRA_H = process.platform === 'win32' ? 0 : Math.max(0, Number(process.env.YGOMETA_CHROME_EXTRA_HEIGHT ?? 88));
  const BODY_H = H + EXTRA_H;

  // 副轴外圈从 44px 加厚到 64px(向内约 45%),让卡图更明显
  const cx = 680, cy = 555, r = 310, rBody = r - 64;

  const bg = `
    <defs>
      <radialGradient id="paper" cx="34%" cy="30%" r="82%">
        <stop offset="0%" stop-color="#fbf9f3"/>
        <stop offset="60%" stop-color="#f5f1e7"/>
        <stop offset="100%" stop-color="#ece6d8"/>
      </radialGradient>
      <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
        <circle cx="1.2" cy="1.2" r="1.1" fill="#cfc7b4" opacity="0.32"/>
      </pattern>
      <filter id="blur" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="34"/>
      </filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#paper)"/>
    <rect width="${W}" height="${H}" fill="url(#dots)"/>
    <circle cx="${cx}" cy="${cy + 10}" r="${r + 42}" fill="#e2dac6" opacity="0.55" filter="url(#blur)"/>`;

  const header = `
    <rect x="64" y="44" width="5" height="20" rx="2.5" fill="#c97b5a"/>
    <text x="80" y="61" fill="${MUTED}" font-size="13" font-weight="700" letter-spacing="3">YU-GI-OH! OCG · META SNAPSHOT</text>
    <text x="64" y="116" fill="${INK}" font-size="46" font-weight="800" letter-spacing="-0.5">上位卡组环境</text>
    <rect x="64" y="138" width="${Math.min(760, textWidth(range.label, 18) + 44)}" height="40" rx="20" fill="#ffffff" stroke="${HAIR}"/>
    <text x="86" y="164" fill="#54503f" font-size="18" font-weight="600">${esc(range.label)}</text>
    <rect x="64" y="190" width="${textWidth('数据来源 · 百度贴吧「上位卡组吧」', 13) + 34}" height="28" rx="14" fill="#ece6d8"/>
    <circle cx="82" cy="204" r="3.2" fill="#c97b5a"/>
    <text x="93" y="209" fill="#6f6a5c" font-size="13">数据来源 · 百度贴吧 <tspan fill="#8a6f4e" font-weight="700">「上位卡组吧」</tspan></text>
    <text x="1296" y="100" text-anchor="end" fill="${INK}" font-size="62" font-weight="800" letter-spacing="-1">${totalEntries}</text>
    <text x="1296" y="128" text-anchor="end" fill="${MUTED}" font-size="15" font-weight="600">副上位样本</text>
    <text x="1296" y="156" text-anchor="end" fill="${MUTED}" font-size="14">${totalPosts} 场赛事 · ${axisCount} 个主轴</text>`;

  let chart = '';
  if (!slices.length) {
    chart = `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#e9e3d4" stroke="#cfc7b4" stroke-width="2" stroke-dasharray="10 12"/>
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#54503f" font-size="34" font-weight="800">暂无数据</text>
      <text x="${cx}" y="${cy + 34}" text-anchor="middle" fill="${MUTED}" font-size="16">该时段没有可识别的上位战报</text>
      <text x="${cx}" y="${cy + 74}" text-anchor="middle" fill="${MUTED}" font-size="14">试试「环境 10月」或「近期环境」</text>`;
  } else {
    let a = 0;
    const items = [];
    const subs = [];
    slices.forEach((s, i) => {
      const full = total ? s.num / total * 360 : 0;
      const a0 = a, a1 = a + full;
      a = a1;
      const bodyColor = s.isOthers ? OTHERS_COLOR : colorOf(s.name);
      const bodyPath = sectorPath(cx, cy, r, a0, a1);
      const art = s.isOthers ? null : arts.get(s.name);
      // 主轴:单张代表图,按扇区包围盒铺一块,不重复平铺
      if (art) {
        const box = arcBox(cx, cy, r, 0, a0, a1);
        const size = Math.min(360, Math.max(220, Math.max(box.w, box.h) * 1.05));
        const clip = clipFor(bodyPath);
        chart += `<path d="${bodyPath}" fill="${bodyColor}" stroke="none"/>`;
        // 单张图,中心对准扇区质心;控制尺寸,避免放大到糊
        chart += `<image href="${art.dataUri}" x="${box.x - size / 2}" y="${box.y - size / 2}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>`;
        chart += `<path d="${bodyPath}" fill="${bodyColor}" opacity="0.14" stroke="none"/>`;
        chart += `<path d="${bodyPath}" fill="none" stroke="${PAPER}" stroke-width="2.4" stroke-linejoin="round"/>`;
      } else {
        chart += `<path d="${bodyPath}" fill="${bodyColor}" stroke="${PAPER}" stroke-width="2.4" stroke-linejoin="round"/>`;
      }

      // 只在外圈(rBody..r)叠「显著混轴」的弧段:
      // 占本块 ≥40%,或者本身是露出来的大主轴且在本块 ≥10%;其余混轴不体现颜色。
      if (!s.isOthers && Array.isArray(s.buckets)) {
        const picks = s.buckets
          .filter(b => b.name !== '其他混轴' && b.count > 0)
          .filter(b => b.share >= 0.40 || (topNames.has(b.name) && b.share >= 0.10));
        let pa = a0;
        for (const b of picks) {
          const span = (a1 - a0) * b.share;
          if (span <= 0) continue;
          const color = topNames.has(b.name) ? colorOf(b.name) : MIX_OTHER_COLOR;
          const band = bandPath(cx, cy, r, rBody, pa, pa + span);
          const subArt = arts.get(b.name);
          if (subArt) {
            const mid = pa + span / 2;
            const c = polar(cx, cy, (r + rBody) / 2, mid);
            const clip = clipFor(band);
            chart += `<path d="${band}" fill="${color}" fill-rule="evenodd" stroke="none"/>`;
            // 副轴不缩图:直接按原图 256px 盖在弧段上,裁掉多余部分
            chart += `<image href="${subArt.dataUri}" x="${c.x - 128}" y="${c.y - 128}" width="256" height="256" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>`;
            chart += `<path d="${band}" fill="${color}" opacity="0.10" fill-rule="evenodd" stroke="none"/>`;
          } else {
            chart += `<path d="${band}" fill="${color}" fill-rule="evenodd" stroke="none"/>`;
          }
          chart += `<path d="${band}" fill="none" stroke="${PAPER}" stroke-width="1.2" fill-rule="evenodd"/>`;
          // 副轴小色块单独引一条线,标签写成「+ 副轴名」
          subs.push({ kind: 'sub', text: `+ ${b.name}`, color, mid: pa + span / 2, share: b.share });
          pa += span;
        }
      }

      // 组边界只画径向短线(不画整圈)
      const rr0 = polar(cx, cy, rBody, a0), rr1 = polar(cx, cy, r, a0);
      chart += `<line x1="${rr0.x.toFixed(1)}" y1="${rr0.y.toFixed(1)}" x2="${rr1.x.toFixed(1)}" y2="${rr1.y.toFixed(1)}" stroke="${PAPER}" stroke-width="2"/>`;

      const mid = (a0 + a1) / 2;
      const pct = total ? s.num / total * 100 : 0;
      const side = Math.cos((mid - 90) * Math.PI / 180) >= 0 ? 1 : -1;
      const yRaw = cy + Math.sin((mid - 90) * Math.PI / 180) * (r + 58);
      items.push({ kind: 'main', s, color: bodyColor, mid, pct, side, y: yRaw, text: s.name });
    });

    // 副轴标签与主轴标签一起排,避免重叠
    for (const sub of subs) {
      sub.side = Math.cos((sub.mid - 90) * Math.PI / 180) >= 0 ? 1 : -1;
      sub.y = cy + Math.sin((sub.mid - 90) * Math.PI / 180) * (r + 58);
      items.push(sub);
    }

    // 外引标签:主轴和副轴一起按 y 排开,避免重叠
    const gap = 36;
    const labelTop = 250, labelBottom = 930;
    for (const side of [-1, 1]) {
      const arr = items.filter(x => x.side === side).sort((p, q) => p.y - q.y);
      for (const it of arr) it.y = Math.max(labelTop, Math.min(labelBottom, it.y));
      for (let i = 1; i < arr.length; i++) {
        if (arr[i].y < arr[i - 1].y + gap) arr[i].y = arr[i - 1].y + gap;
      }
      const over = arr.length ? arr[arr.length - 1].y - labelBottom : 0;
      if (over > 0) for (const it of arr) it.y -= over;
      const under = arr.length ? labelTop - arr[0].y : 0;
      if (under > 0) for (const it of arr) it.y += under;
    }

    const labelX = cx + r + 100;
    items.forEach(it => {
      const x = it.side > 0 ? labelX : cx - r - 100;
      const p0 = polar(cx, cy, r + 4, it.mid);
      const p1 = { x: cx + it.side * (r + 44), y: it.y };
      const p2 = { x: x - it.side * 10, y: it.y };
      chart += `<polyline points="${p0.x.toFixed(1)},${p0.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}" fill="none" stroke="#b8b0a0" stroke-width="1.2"/>`;
      chart += `<circle cx="${p0.x.toFixed(1)}" cy="${p0.y.toFixed(1)}" r="2.6" fill="${it.color}"/>`;
      if (it.kind === 'sub') {
        // 副轴小色块单独一条引线:只写「+ 副轴名」,浅色小字
        chart += `<text x="${x}" y="${it.y}" text-anchor="${it.side > 0 ? 'start' : 'end'}" dominant-baseline="central" fill="${MUTED}" font-size="15" font-weight="600">${esc(it.text)}</text>`;
      } else {
        const nameSize = textWidth(it.text, 21) > 250 ? 16 : 21;
        chart += `<text x="${x}" y="${it.y}" text-anchor="${it.side > 0 ? 'start' : 'end'}" dominant-baseline="central" fill="${INK}" font-size="${nameSize}" font-weight="700">${esc(it.text)}<tspan fill="${MUTED}" font-size="15" font-weight="500">  ${fmtPct(it.s.num, total)}%</tspan></text>`;
      }
    });
  }

  const note = truncated ? '⚠ 抓取页数达到上限,数据可能不全 · ' : '';
  const footer = `
    <line x1="64" y1="${H - 44}" x2="${W - 64}" y2="${H - 44}" stroke="${HAIR}" stroke-width="1"/>
    <text x="64" y="${H - 18}" fill="#8c8676" font-size="14">${note}数据来源:百度贴吧 <tspan fill="#6f6a5c" font-weight="700">「上位卡组吧」</tspan> · 按冠军 / 亚军 / 四强 / 八强统计 · 混轴显著时才显示外圈弧段(≥本块40%,或大主轴≥10%),样本不重复 · 生成于 ${fmtDate(Date.now())}</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Noto Sans CJK SC','Source Han Sans SC','Microsoft YaHei','PingFang SC',sans-serif">
    ${bg}
    ${clipDefs.length ? `<defs>${clipDefs.join('')}</defs>` : ''}
    <g>${chart}</g>
    ${header}
    ${footer}
  </svg>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background-color:#eee9db;
      background-image:radial-gradient(circle at 1.2px 1.2px, #cfc7b4 1.1px, transparent 1.3px);
      background-size:22px 22px;width:${W}px;height:${BODY_H}px;overflow:hidden}
    svg{display:block}
  </style></head><body>${svg}</body></html>`;

  mkdirSync(TMP_DIR, { recursive: true });
  pruneTmp();
  mkdirSync(dirname(outPath), { recursive: true });
  const stamp = `${process.pid}_${Date.now()}`;
  const htmlPath = join(TMP_DIR, `pie_${stamp}.html`);
  const profile = join(TMP_DIR, `prof_${stamp}`);
  writeFileSync(htmlPath, html, 'utf8');
  if (process.env.YGOMETA_KEEP_HTML === '1') {
    try { writeFileSync(join(TMP_DIR, 'last.html'), html, 'utf8'); } catch { /* ignore */ }
  }
  try {
    await screenshot(htmlPath, outPath, W, BODY_H, profile, log);
  } finally {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉就留着,下次 sweep 清 */ }
    try { rmSync(htmlPath, { force: true }); } catch { /* 同上 */ }
  }
  const bytes = statSync(outPath).size;
  return { path: outPath, width: W, height: H, bytes };
}

/** 清掉 1 天前的临时 HTML / Chrome 配置目录 */
function pruneTmp() {
  try {
    const cutoff = Date.now() - 86400e3;
    for (const name of readdirSync(TMP_DIR)) {
      const p = join(TMP_DIR, name);
      try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* 目录不存在 */ }
}

/** 调 headless Chrome 截图。失败时抛错,由调用方决定怎么兜底。 */
function screenshot(htmlPath, outPath, W, H, profile, log = () => {}) {
  return new Promise((resolve, reject) => {
    const chrome = chromePath();
    if (!chrome || (!existsSync(chrome) && !/^[a-zA-Z0-9_-]+$/.test(chrome))) {
      return reject(new Error(`找不到无头浏览器:${chrome || '(空)'}(可设 CHROME_PATH)`));
    }
    try { rmSync(outPath, { force: true }); } catch { /* ignore */ }
    const headless = process.platform === 'win32' ? '--headless' : '--headless=new';
    // 1x 是为了 OneBot 发图:卡图填充后 PNG 熵更高,1.5x 会到 ~2MB 发不出去
    const scale = Math.min(2, Math.max(1, Number(process.env.YGOMETA_SCALE || 1)));
    const args = [
      headless,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--force-device-scale-factor=${scale}`,
      `--window-size=${W},${H}`,
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=3500',
      '--allow-file-access-from-files',
      `--screenshot=${outPath}`,
      `file://${htmlPath.replace(/\\/g, '/')}`,
    ];
    const child = spawn(chrome, args, { windowsHide: true, stdio: 'ignore' });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`无头浏览器截图超时(60s):${chrome}`));
    }, 60000);
    child.on('error', e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`无头浏览器启动失败:${e.message}(CHROME_PATH=${chrome})`));
    });
    child.on('exit', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!existsSync(outPath)) return reject(new Error(`截图失败(exit ${code}):没有生成 PNG`));
      const sz = statSync(outPath).size;
      if (sz < 2048) return reject(new Error(`截图文件异常小(${sz} B),可能页面没渲染出来`));
      log(`  饼图已渲染:${W}x${H} @${scale}x, ${(sz / 1024).toFixed(0)} KB`);
      resolve();
    });
  });
}
