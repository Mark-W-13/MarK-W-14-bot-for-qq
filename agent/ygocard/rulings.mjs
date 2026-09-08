// 官方裁定查询(2026-09-08 落地;2026-09-08 换源百鸽,触发词「裁定 」)
// 数据源: 百鸽 ygocdb.com —— KONAMI 官方 OCG 数据库 FAQ 的中文镜像站
//   卡详情页 https://ygocdb.com/card/<卡密码>#faq 服务端直出该卡全部相关 Q&A,单页全量
// 调研结论(勿重复):
//   ① 官网 db.yugioh-card.com 的 FAQ 仅日文原文、无官方译本;百鸽镜像正文同为日文原文,
//      但句中卡名被渲染成中文链接(剥链接后文字即中文卡名),读起来比官网原文友好;
//      「AI翻译」按钮需自配 API key、「百度翻译」跳站外,均不适用 bot,勿再去找站内译文。
//   ② 百鸽该卡 FAQ 列表与官网「相关 Q&A」同集(实测 增殖的G 两站均 35 条),同样混有
//      不直接提该卡的泛用判例(连锁处理/无效系等),必须过滤,勿改回全量直发(聊天版)。
//   ③ 同页另含「数据库补充说明」(锚 #supplement,与 FAQ 同 <div class="row faq"> 但分列):
//      即官网的卡效果补足説明,条目为 .qa.supplement(ul/li 分节,li.about 是【节标题】,
//      li→换行提取),.info 内日期链接 href="/card/<密码>#supplement";无题目标题,
//      解析靠 class 区分,勿与 FAQ 混淆。补充说明按用户 2026-09-08 要求一并填充进
//      聊天版「裁定」与「完整裁定 PDF」(缓存 v:2 起含 supplement 字段)。
//   ④ qabox 结构: FAQ 条目 .qa.title 短问 / .qa.question 完整问(题干) / .qa.answer 完整答,
//      .info 内 <a href="/faq/<fid>">2026-06-01</a> = 日期 + 官网 fid(fid 与官网一致);
//      页面按日期倒序排列(新裁定在前)。FAQ 区从 <div class="row faq"> 起到卡包区
//      <ul class="packs"> 为止(补充说明列也在这段内)。
//   ⑤ 直接命中判定:题干 HTML 里出现 <a href="/card/<主卡密码>"> —— 百鸽对提及的卡必做
//      链接,等价官网「问句含该卡日文名」过滤,且无视译名变体,更准。
//   ⑥ 本地卡库 cards.json 的 id 字段 = 卡密码(增殖的G=23434538 / 青眼白龙=89631139),
//      直接拼卡页 URL,免检索;id=0(无密码的动画卡等)→ 百鸽无卡页,unlisted。
// 缓存: agent/ygocard/faq_cache.json(默认 24h TTL,不频繁打扰百鸽)。键前缀 bg_<密码> /
//   bgfull_<密码>,条目带 v:2 版本标记(缺 v 或版本旧视为失效,防旧结构顶掉新字段);
//   加载时自动清理旧版(官网源)遗留键。
// 用法:
//   node rulings.mjs "增殖的G"      # 自测:中文卡名 → 拉取并打印裁定条目
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { searchCards } from './ygocard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9' };
const BASE = 'https://ygocdb.com';
const CACHE_FILE = join(__dirname, 'faq_cache.json');
const CACHE_TTL_MS = Number(process.env.RULINGS_CACHE_TTL_MS || 24 * 3600 * 1000); // 裁定缓存 24h(官方条目带更新日,变化不频繁)
const FETCH_TIMEOUT_MS = 20000; // 卡页最大 ~560KB,比官网页大,给 20s

const dec = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
// HTML 片段 → 文本:<br> 换行,其余标签剥掉(标签内文字保留,如中文卡名链接)
function htmlToText(html) {
  return dec(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function loadCache() {
  let cache = {};
  try { cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch {}
  // 清理非本版键(官网源遗留的 <cid> / full_<cid>),避免旧数据混用、文件膨胀
  for (const k of Object.keys(cache)) {
    if (!/^(bg|bgfull)_\d+$/.test(k)) delete cache[k];
  }
  return cache;
}
function saveCache(cache) {
  mkdirSync(__dirname, { recursive: true });
  writeFileSync(CACHE_FILE + '.tmp', JSON.stringify(cache), 'utf8');
  renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
}

async function getText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

// 从卡页 HTML 里切出 FAQ 区(从 <div class="row faq"> 到卡包区 <ul class="packs">)
function sliceFaqRegion(html) {
  const start = html.indexOf('class="row faq"');
  if (start < 0) return '';
  let end = html.indexOf('<ul class="packs"', start);
  if (end < 0) end = Math.min(html.length, start + 1500000); // 结构变了就给个保底长度
  return html.slice(start, end);
}

// 取 qabox 内某段(.qa title / question / answer / supplement),无嵌套 div 直接非贪婪到 </div>
function grabQa(box, cls) {
  const m = box.match(new RegExp(`<div class="qa ${cls}"[^>]*>([\\s\\S]*?)<\\/div>`));
  return m ? m[1] : '';
}

// 补充说明是 ul/li 分节(节标题 li.about 带【】),li/p 结束处转行再走通用剥标签
function supToText(html) {
  return htmlToText(html.replace(/<\/(?:li|p)>/gi, '\n'));
}

/**
 * 解析百鸽卡页的 FAQ + 数据库补充说明(同一 <div class="row faq"> 内分列,切片一次覆盖)。
 * @param {string} html 卡页整页 HTML
 * @param {string|number} cardId 主卡密码(拼 /card/<密码> 链接判定直接命中)
 * @returns {{total:number, entries:Array<{fid:string, date:string, q:string, a:string|null, direct:boolean}>,
 *            supplement:Array<{date:string, a:string}>}}
 *   entries 按页面顺序 = 日期倒序(新裁定在前);direct=题干直接提到主卡;supplement 为空数组=该卡无补充说明
 */
function parseCardPage(html, cardId) {
  const seg = sliceFaqRegion(html);
  if (!seg) return { total: 0, entries: [], supplement: [] };
  const entries = [];
  const supplement = [];
  const parts = seg.split('<div class="qabox').slice(1); // 首段是区头,不要
  for (const box of parts) {
    const supHtml = grabQa(box, 'supplement');
    if (supHtml) {  // 数据库补充说明(.qa.supplement;与 FAQ 无题目标题可混淆,靠 class 区分)
      const dateM = box.match(/href="\/card\/\d+#supplement"[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\//);
      supplement.push({ date: dateM ? dateM[1] : '', a: supToText(supHtml) || null });
      continue;
    }
    const titleHtml = grabQa(box, 'title');
    const questionHtml = grabQa(box, 'question') || titleHtml; // 结构异常时退短问
    const q = htmlToText(questionHtml);
    if (!q) continue;    // 译名表等其它 qabox 无题目,跳过
    const fidM = box.match(/href="\/faq\/(\d+)"/);
    const dateM = box.match(/href="\/faq\/\d+"[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\//);
    const a = htmlToText(grabQa(box, 'answer')) || null;
    entries.push({
      fid: fidM ? fidM[1] : '',
      date: dateM ? dateM[1] : '',
      q,
      a,
      direct: questionHtml.includes(`href="/card/${cardId}"`) || titleHtml.includes(`href="/card/${cardId}"`),
    });
  }
  return { total: entries.length, entries, supplement };
}

/**
 * 拉一张卡的裁定(百鸽镜像官方数据库 FAQ + 数据库补充说明),带 24h 缓存。
 * @param {{id:number, cid:number, cn_name?:string, jp_name?:string}} card 卡对象(来自 cards.json)
 * @param {number} max 返回条目上限(默认 2;页面按日期倒序,取前几即最新裁定)
 * @returns {{status:'ok'|'no-faq'|'unlisted'|'error', total:number, entries:Array,
 *            supplement:Array, url:string, error?:string}}
 *   ok      → entries 有内容
 *   no-faq  → 该卡无 Q&A 条目
 *   unlisted→ 卡无密码 id(百鸽无卡页,如无密码的动画卡)
 *   error   → 网络/解析失败(可稍后重试)
 */
export async function fetchCardRulings(card, max = 2) {
  const url = `${BASE}/card/${card.id}#faq`;
  if (!card.id) return { status: 'unlisted', total: 0, entries: [], supplement: [], url: '' };
  const cache = loadCache();
  const hit = cache[`bg_${card.id}`];
  if (hit && hit.v === 2 && Date.now() - hit.t < CACHE_TTL_MS) {
    return { ...hit, url, fromCache: true };
  }
  try {
    const { total, entries, supplement } = parseCardPage(await getText(`${BASE}/card/${card.id}`), card.id);
    // 直接命中(题干含主卡链接)优先,不足用泛用相关条目补位 —— 勿改回纯顺序取前 N
    const matched = entries.filter(e => e.direct);
    const take = [];
    for (const e of [...matched, ...entries]) { if (take.length >= max) break; if (!take.includes(e)) take.push(e); }
    const out = { status: total === 0 && !supplement.length ? 'no-faq' : 'ok', total, entries: take, supplement, url, v: 2, t: Date.now() };
    cache[`bg_${card.id}`] = out;   // 无条目的卡也缓存(避免每次查都打百鸽)
    saveCache(cache);
    return { ...out, fromCache: false };
  } catch (e) {
    return { status: 'error', total: 0, entries: [], supplement: [], url, error: e.message };
  }
}

// ---------- 完整裁定 PDF(该卡全部相关 Q&A,Q/A 完整不截断) ----------
// 渲染: HTML → Edge/Chrome headless --print-to-pdf(自动多页分页,中文字体本机现成)
const PDF_EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// 拉取该卡完整裁定(供 PDF):百鸽卡页 FAQ 区「有啥发啥」——全部条目
// (含泛用相关判例,不做直接命中过滤;用户 2026-09-08 定稿:官网上有就全发)。
// 单页全量,无需翻页;同页的「数据库补充说明」一并返回(用户 2026-09-08:也要填充)。
// 独立缓存键 bgfull_<密码>(加载时旧版 full_<cid> 键已被清)。
export async function fetchFullRulings(card) {
  const url = `${BASE}/card/${card.id}#faq`;
  if (!card.id) return { status: 'unlisted', total: 0, entries: [], supplement: [], url: '' };
  const cache = loadCache();
  const key = `bgfull_${card.id}`;
  const hit = cache[key];
  if (hit && hit.v === 2 && Date.now() - hit.t < CACHE_TTL_MS) return { ...hit, url, fromCache: true };
  try {
    const { total, entries, supplement } = parseCardPage(await getText(`${BASE}/card/${card.id}`), card.id);
    const out = { status: entries.length || supplement.length ? 'ok' : 'no-faq', total, entries, supplement, url, v: 2, t: Date.now() };
    cache[key] = out; saveCache(cache);
    return { ...out, fromCache: false };
  } catch (e) {
    return { status: 'error', total: 0, entries: [], supplement: [], url, error: e.message };
  }
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rulingsHtml(card, entries, total, supplement = [], truncated = false) {
  const cn = card.cn_name || card.sc_name || card.md_name || card.nwbbs_n || card.cnocg_n || card.en_name;
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const supRows = supplement.map((s, i) => `
  <div class="entry">
    <div class="no">${supplement.length > 1 ? `说明 ${i + 1}.` : ''}${s.date ? ` <span class="date">${s.date}</span>` : ''}</div>
    <div class="a">${escHtml(s.a).replace(/\n/g, '<br>')}</div>
  </div>`).join('\n');
  const rows = entries.map((e, i) => `
  <div class="entry">
    <div class="no">${i + 1}.${e.date ? ` <span class="date">${e.date}</span>` : ''}</div>
    <div class="q">${escHtml(e.q)}</div>
    <div class="a">${escHtml(e.a).replace(/\n/g, '<br>')}</div>
  </div>`).join('\n');
  const parts = [];
  if (total) parts.push(`相关 Q&A 共 ${total} 条`);
  if (supplement.length) parts.push(`数据库补充说明 ${supplement.length} 条`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 14mm 12mm; }
  body { font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; font-size: 10.5pt; line-height: 1.6; color: #18191c; }
  h1 { font-size: 15pt; margin: 0 0 4px; }
  .meta { color: #666; font-size: 9pt; margin-bottom: 16px; }
  .sec { font-size: 10.5pt; margin: 14px 0 6px; padding-bottom: 3px; border-bottom: 2px solid #333; font-weight: 700; }
  .entry { margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px solid #ddd; }
  .entry:last-child { border-bottom: none; }
  .no { color: #888; font-size: 9pt; margin-bottom: 2px; }
  .date { color: #aaa; }
  .q { font-weight: 600; margin-bottom: 4px; }
  .a { white-space: normal; word-break: break-word; }
  </style></head><body>
  <h1>${escHtml(cn)}${card.jp_name ? `(${escHtml(card.jp_name)})` : ''} 完整裁定</h1>
  <div class="meta">官方数据库${parts.join(' · ')} · 全部收录如下 · ${today}${truncated ? ' · (超翻页上限,尾部未收录)' : ''}</div>
  ${supplement.length ? `<div class="sec">数据库补充说明</div>${supRows}` : ''}
  ${entries.length ? `<div class="sec">相关 Q&A</div>${rows}` : ''}
  </body></html>`;
}

// 清理 tmp/ 下 3 天前的完整裁定 PDF(避免长期堆积)
function sweepOldPdf() {
  const dir = join(__dirname, 'tmp');
  try {
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    for (const f of readdirSync(dir)) {
      if (!/^完整裁定_.*\.pdf$/.test(f)) continue;
      const p = join(dir, f);
      if (existsSync(p) && statSafe(p) < cutoff) { try { unlinkSync(p); } catch {} }
    }
  } catch {}
}
function statSafe(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

/**
 * 生成完整裁定多页 PDF(Q&A + 数据库补充说明)。
 * @returns {Promise<{path:string, bytes:number}>} 成功;失败 throw
 */
export async function buildRulingsPdf(card, entries, total, supplement = [], truncated = false) {
  const safeName = (card.cn_name || card.sc_name || '卡').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30);
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const tmpDir = join(__dirname, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  sweepOldPdf();
  const htmlPath = join(tmpDir, `rulings_${card.id}.html`);
  const pdfPath = join(tmpDir, `完整裁定_${safeName}_${ymd}.pdf`);
  writeFileSync(htmlPath, rulingsHtml(card, entries, total, supplement, truncated), 'utf8');
  await new Promise((resolve, reject) => {
    const url = `file:///${htmlPath.replace(/\\/g, '/')}`;
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      '--virtual-time-budget=8000',
      `--user-data-dir=${join(tmpDir, 'edge_pdf_prof')}`,
      url,
    ];
    const child = spawn(PDF_EDGE, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Edge 启动失败: ${e.message}`)); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (!existsSync(pdfPath)) return reject(new Error(`PDF 生成失败(exit ${code})`));
      resolve(pdfPath);
    });
  });
  return { path: pdfPath, bytes: readFileSync(pdfPath).length };
}

// ---------- 命令行自测: node rulings.mjs "卡名" [--pdf] ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2];
  const wantPdf = process.argv.includes('--pdf');
  if (!name) { console.log('用法: node rulings.mjs "中文卡名" [--pdf]'); process.exit(1); }
  const hit = searchCards(name, 5)[0];
  if (!hit) { console.log(`未找到卡「${name}」`); process.exit(1); }
  const label = `${hit.cn_name || hit.sc_name || hit.name}(${hit.jp_name || '?'})`;
  if (wantPdf) {
    const full = await fetchFullRulings(hit);
    console.log(`完整裁定 ${label} → ${full.status}${full.fromCache ? ' (缓存)' : ''} Q&A ${full.total} 条 / 补充说明 ${full.supplement?.length ?? 0} 条`);
    if (full.entries.length || full.supplement?.length) {
      const { path, bytes } = await buildRulingsPdf(hit, full.entries, full.total, full.supplement ?? []);
      console.log(`PDF: ${path} (${(bytes / 1024).toFixed(0)} KB, Q&A ${full.entries.length} 条 + 补充说明 ${full.supplement?.length ?? 0} 条)`);
    } else if (full.error) console.log('失败:', full.error);
    else console.log('(该卡无相关 Q&A 条目,也无补充说明)');
    process.exit(0);
  }
  const r = await fetchCardRulings(hit, 2);
  console.log(`【裁定】${label} → ${r.status}${r.fromCache ? ' (缓存)' : ''}${r.total ? ` 共 ${r.total} 条` : ''}${r.supplement?.length ? ` / 补充说明 ${r.supplement.length} 条` : ''}`);
  if (r.entries?.length || r.supplement?.length) {
    r.entries.forEach((e, i) => {
      console.log(`\n── ${i + 1}. (${e.date}) fid=${e.fid}${e.direct !== undefined && e.direct ? ' [直接命中]' : ' [补位]'}`);
      console.log(`Q: ${e.q.slice(0, 300)}${e.q.length > 300 ? '…' : ''}`);
      if (e.a) console.log(`A: ${e.a.slice(0, 600)}${e.a.length > 600 ? '…' : ''}`);
    });
    (r.supplement ?? []).forEach((s, i) => {
      console.log(`\n── 补充说明 ${i + 1}.${s.date ? ` (${s.date})` : ''}`);
      console.log(`${s.a.slice(0, 800)}${s.a.length > 800 ? '…' : ''}`);
    });
    console.log(`\n来源: 百鸽 ${r.url}`);
  } else if (r.error) console.log('失败:', r.error);
  else console.log('(该卡暂无相关 Q&A 条目,也无补充说明)');
}
