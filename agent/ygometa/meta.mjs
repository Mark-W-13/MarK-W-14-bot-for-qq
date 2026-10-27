// 游戏王「环境饼图」(2026-10-26 新增)
//
// 需求:在游戏王模式下,群里 @机器人 说「近期环境」/「环境 10月」这类话,回**一张带时间段
// 标记的饼图**(不 @、不多余文字)。数据来自百度贴吧「上位卡组吧」的赛事战报,按时间段
// 抓取、整理上位卡组并统计。
//
// ── 为什么要用贴吧客户端接口,而不是直接抓网页 ───────────────────────────────
// 2026-10-26 实测:从本机与服务器直连 `tieba.baidu.com/f|/p` 全部 **403**(百度对机房 IP
// 直接拦),无头 Chrome 打开也是「百度安全验证」滑块页。但**带 sign 的贴吧客户端 JSON
// 接口**(`c.tieba.baidu.com/c/f/frs/page`)可以正常返回 200/100 条/页,且 `sort_type=1`
// 是按**发帖时间倒序** —— 于是能按时间段一页页翻。sign 算法是社区公开的:
//   MD5( ASCII 升序拼接的 key=value + "tiebaclient!!!" ) 转大写。
// 这条接口只读、不需要登录 cookie,也不碰用户隐私;请求间隔 280ms,靠缓存避免重复抓。
//
// ── 缓存(需求明确要求) ──────────────────────────────────────────────────────
//   cache/pages/    原始列表页(按 pn + 小时分桶,1 小时内重复请求不再联网)
//   cache/threads.json  已抓到的帖子(按 tid 存,跨时间段复用,不会重复分析)
//   cache/periods/  某时间段的统计结果(命中就直接用,不再抓也不再画)
//   cache/charts/   该时间段的饼图 PNG
// 「先查缓存,没有才抓」就发生在 buildMetaPie() 开头:同一天重复问「近期环境」不会重新爬。
//
// ── 统计口径(踩过的坑) ──────────────────────────────────────────────────────
// 贴吧战报有两种写法,必须分开处理,否则会把**对手的卡组**当成上位:
//   ① 榜单型:「冠军：A,卡组:X / 亚军：B,卡组:Y / 四强：...」→ 逐条取卡组
//   ② 个人战报:「使用卡组:X ... 八强 对战升月 赢骰 oo」→ 只取作者自己的 X,
//      正文里的「对战XX」是**对手**,不能算进饼图。
// 所以先判断正文里有没有「榜单行」(行首名次、且不含对战/赢骰/轮次等记录词),有榜单才走 ①,
// 否则走 ②(使用卡组 → 标题里的名次+卡组 → 首行卡组)。
// 卡组名还要归一化:贴吧写法极散(魔∀丽丝/码丽斯/玛丽丝、杀旋/杀手旋律、雷火剑/雷火沸动...),
// 不归一化的话同一个卡组会被拆成好几块。RULES 的顺序就是优先级(狱神 > 烙印 > ...)。
import { chromePath } from '../env.mjs';   // ⚠ 必须第一个:CHROME_PATH 等要在顶层读取
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderMetaPie } from './pie.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = process.env.YGOMETA_CACHE_DIR || join(__dirname, 'cache');
const PAGE_DIR = join(CACHE_DIR, 'pages');
const PERIOD_DIR = join(CACHE_DIR, 'periods');
const CHART_DIR = join(CACHE_DIR, 'charts');
const PDF_DIR = join(CACHE_DIR, 'pdfs');
const POST_DIR = join(CACHE_DIR, 'postcache');
const THREADS_FILE = join(CACHE_DIR, 'threads.json');

// 版本号:改了抓取/解析/画图口径就 +1,旧缓存自动失效(不用手删文件)
const STORE_VERSION = 3;
const PARSE_VERSION = 15;   // 2026-10-28:卡组分布/图注/多玩家单行不硬拼
const PIE_VERSION = 32;     // 2026-10-28:饼图主轴/副轴改用代表卡图填充
const PDF_VERSION = 17;     // 2026-10-28:新版卡图饼图

const FORUM_KW = process.env.YGOMETA_FORUM || '上位卡组';
const PAGE_RN = Math.min(100, Math.max(20, Number(process.env.YGOMETA_PAGE_RN || 100)));
const MAX_PAGES = Math.max(4, Number(process.env.YGOMETA_MAX_PAGES || 40));
const PAGE_DELAY_MS = Math.max(0, Number(process.env.YGOMETA_PAGE_DELAY_MS || 280));
const MAX_RANGE_DAYS = Math.max(7, Number(process.env.YGOMETA_MAX_RANGE_DAYS || 210));
const MAX_THREADS = Math.max(1000, Number(process.env.YGOMETA_MAX_THREADS || 12000));
const RECENT_TTL_MS = Math.max(5 * 60e3, Number(process.env.YGOMETA_RECENT_TTL_MS || 2 * 3600e3));
const PAST_TTL_MS = Math.max(RECENT_TTL_MS, Number(process.env.YGOMETA_PAST_TTL_MS || 30 * 86400e3));
const DAY = 86400e3;

// =====================================================================================
// 时间范围
// =====================================================================================

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function ymdDash(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function md(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtRange(range) {
  const s = new Date(range.start), e = new Date(range.end - DAY);
  if (range.kind === 'month') {
    const suffix = e.getDate() !== new Date(e.getFullYear(), e.getMonth() + 1, 0).getDate() ? ` · 截至 ${md(e)}` : '';
    return `${s.getFullYear()}年${s.getMonth() + 1}月${suffix}`;
  }
  if (range.kind === 'recent') {
    return `近${range.days}天 · ${ymdDash(s)} ~ ${md(e)}`;
  }
  if (ymdDash(s) === ymdDash(e)) return ymdDash(s);
  return `${ymdDash(s)} ~ ${ymdDash(e)}`;
}
function makeRange(startDate, endInclusive, meta = {}) {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  let start = startOfDay(startDate).getTime();
  let end = addDays(startOfDay(endInclusive), 1).getTime();
  if (end > tomorrow.getTime()) end = tomorrow.getTime();
  const minStart = addDays(today, -MAX_RANGE_DAYS).getTime();
  let clamped = false;
  if (start < minStart) { start = minStart; clamped = true; }
  if (start >= end) return null;
  const range = {
    start, end,
    key: `m_${ymd(new Date(start))}_${ymd(new Date(end - DAY))}`,
    kind: meta.kind || 'range',
    days: meta.days || Math.round((end - start) / DAY),
    explicit: !!meta.explicit,
    clamped,
    startDate: new Date(start), endDate: new Date(end - DAY),
  };
  range.label = fmtRange(range) + (clamped ? ' · 已截断' : '');
  range.desc = `${ymdDash(new Date(start))} ~ ${ymdDash(new Date(end - DAY))}`;
  return range;
}
function recentRange(days, now = new Date()) {
  const end = addDays(startOfDay(now), 1);
  const start = addDays(end, -days);
  return makeRange(start, new Date(end.getTime() - DAY), { kind: 'recent', days });
}
function monthRange(year, month, { explicitYear = false, now = new Date() } = {}) {
  let y = year;
  const m = month;
  let start = new Date(y, m - 1, 1);
  const tomorrow = addDays(startOfDay(now), 1);
  if (!explicitYear && start.getTime() > tomorrow.getTime()) {
    y -= 1;
    start = new Date(y, m - 1, 1);
  }
  const end = new Date(y, m, 1);
  if (start.getTime() >= tomorrow.getTime()) return null;
  const r = makeRange(start, addDays(end, -1), { kind: 'month' });
  return r;
}
function yearRange(year, { now = new Date() } = {}) {
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  if (start.getTime() >= addDays(startOfDay(now), 1).getTime()) return null;
  return makeRange(start, end, { kind: 'range' });
}

function parseCnNum(s) {
  const t = String(s || '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (t === '十') return 10;
  if (t === '半个月') return 15;
  let n = 0;
  if (t.includes('十')) {
    const [a, b] = t.split('十');
    n = (a ? map[a] || 0 : 1) * 10 + (b ? map[b] || 0 : 0);
  } else {
    for (const ch of t) n = n * 10 + (map[ch] ?? 0);
  }
  return n || NaN;
}

function parseDateToken(tok, { defaultYear = null } = {}) {
  const t = String(tok || '').trim().replace(/[日号]$/, '');
  let m = t.match(/^(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = t.match(/^(\d{1,2})\s*[月.\-/]\s*(\d{1,2})$/);
  if (m) {
    const y = defaultYear ?? new Date().getFullYear();
    return { y, m: +m[1], d: +m[2] };
  }
  return null;
}

/**
 * 解析时间段。返回 {start,end,key,label,desc,kind,...} 或 null。
 * 支持:近期/本周/上周/本月/上月/今年/去年、近N天/周/月、今天/昨天/前天、
 *      2026年10月 / 2026-10 / 10月 / 10.1-10.7 / 9月1日到9月15日 / 2026-09-01~2026-09-15
 * end 统一为**开区间**(不含),方便和 create_time 比较。
 */
export function parseMetaRange(spec, now = new Date()) {
  let s = String(spec || '').trim()
    .replace(/^[\s:：,，、的在于是从]+/, '')
    .replace(/[\s。.!！?？]+$/, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/(?:的)?(?:饼图|环境分布|环境|分布|数据|统计)$/g, '')
    .trim();
  s = s.replace(/月份$/, '月').replace(/^[\s:：,，、]+/, '').trim();
  if (!s) return recentRange(7, now);
  if (/^(?:近期|最近|最新|当前|现在|这几天|这阵子|近来|目前)$/.test(s)) return recentRange(7, now);

  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  if (/^(?:今天|今日|当天)$/.test(s)) return makeRange(today, today, { kind: 'range' });
  if (/^(?:昨天|昨日)$/.test(s)) return makeRange(addDays(today, -1), addDays(today, -1), { kind: 'range' });
  if (/^前天$/.test(s)) return makeRange(addDays(today, -2), addDays(today, -2), { kind: 'range' });
  if (/^(?:本周|这周|这星期|本星期)$/.test(s)) {
    const offset = (today.getDay() + 6) % 7;   // 周一 = 0
    return makeRange(addDays(today, -offset), today, { kind: 'range' });
  }
  if (/^(?:上周|上星期|上个星期)$/.test(s)) {
    const offset = (today.getDay() + 6) % 7;
    const thisMonday = addDays(today, -offset);
    return makeRange(addDays(thisMonday, -7), addDays(thisMonday, -1), { kind: 'range' });
  }
  if (/^(?:本月|这个月|当月)$/.test(s)) return makeRange(new Date(today.getFullYear(), today.getMonth(), 1), today, { kind: 'range' });
  if (/^(?:上月|上个月)$/.test(s)) {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return makeRange(start, end, { kind: 'month' });
  }
  if (/^今年$/.test(s)) return makeRange(new Date(today.getFullYear(), 0, 1), today, { kind: 'range' });
  if (/^去年$/.test(s)) return yearRange(today.getFullYear() - 1, { now });

  // 近 N 天 / 周 / 月
  let m = s.match(/^(?:最近|近|过去)\s*([0-9一二三四五六七八九十两]+|半)\s*(天|日|周|个?星期|个?月)\s*(?:内|以内|之内)?$/);
  if (m) {
    const raw = m[1] === '半' ? 0.5 : parseCnNum(m[1]);
    const unit = m[2];
    if (Number.isFinite(raw) && raw > 0) {
      if (unit.includes('月')) {
        if (raw < 1) return recentRange(15, now);          // 近半个月 = 15 天
        return recentRange(Math.round(raw * 30), now);      // 近一个月 = 滚动 30 天
      }
      const days = Math.max(1, Math.round(unit.includes('周') || unit.includes('星期') ? raw * 7 : raw));
      return recentRange(days, now);
    }
  }

  // 日期区间:先试「一段日期 + 分隔符 + 另一段日期」,再试整月区间。
  // ⚠ 分隔符里的 - 只在这里用;不能一开始就把 2026-09-01 里的 - 当区间分隔符。
  let rangeRe = /^(\d{4}\s*[年.\-/]\s*\d{1,2}\s*[月.\-/]\s*\d{1,2}\s*[日号]?|\d{1,2}\s*[月.\-/]\s*\d{1,2}\s*[日号]?)\s*(?:到|至|~|～|—|–|－|-|to)\s*(\d{4}\s*[年.\-/]\s*\d{1,2}\s*[月.\-/]\s*\d{1,2}\s*[日号]?|\d{1,2}\s*[月.\-/]\s*\d{1,2}\s*[日号]?)$/i;
  let rm = s.match(rangeRe);
  if (rm) {
    const da = parseDateToken(rm[1]);
    const db = parseDateToken(rm[2], { defaultYear: da ? da.y : today.getFullYear() });
    if (da && db) {
      let sd = new Date(da.y, da.m - 1, da.d);
      let ed = new Date(db.y, db.m - 1, db.d);
      if (ed < sd) ed = new Date(db.y + 1, db.m - 1, db.d);   // 跨年区间(12.20-1.5)
      return makeRange(sd, ed, { kind: 'range', explicit: true });
    }
  }
  // 整月区间:9月到10月 / 2026年9月~2026年10月
  rangeRe = /^(\d{4}\s*年?\s*)?(\d{1,2})\s*月\s*(?:到|至|~|～|—|–|－|-)\s*(?:(\d{4})\s*年?\s*)?(\d{1,2})\s*月$/;
  rm = s.match(rangeRe);
  if (rm) {
    let sy = rm[1] ? +rm[1].replace(/\D/g, '') : today.getFullYear();
    const sm = +rm[2];
    let ey = rm[3] ? +rm[3] : sy;
    const em = +rm[4];
    let sd = new Date(sy, sm - 1, 1);
    let ed = new Date(ey, em, 0);                    // 该月最后一天
    if (ed < sd) { ey += 1; ed = new Date(ey, em, 0); }
    if (!rm[1] && sd.getTime() >= addDays(today, 1).getTime()) { sy -= 1; sd = new Date(sy, sm - 1, 1); ed = new Date(sy, em, 0); }
    return makeRange(sd, ed, { kind: 'range', explicit: true });
  }

  // 年月 / 月
  m = s.match(/^(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*月?$/);
  if (m) {
    const mm = +m[2];
    if (mm >= 1 && mm <= 12) return monthRange(+m[1], mm, { explicitYear: true, now });
  }
  m = s.match(/^(\d{1,2})\s*月$/);
  if (m) {
    const mm = +m[1];
    if (mm >= 1 && mm <= 12) return monthRange(today.getFullYear(), mm, { explicitYear: false, now });
  }
  // 单独一个 1~12 的数字,当月份(「环境 10」)
  m = s.match(/^(\d{1,2})$/);
  if (m) {
    const mm = +m[1];
    if (mm >= 1 && mm <= 12) return monthRange(today.getFullYear(), mm, { explicitYear: false, now });
  }

  // 单日
  m = s.match(/^(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[日号]?$/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (!Number.isNaN(d.getTime())) return makeRange(d, d, { kind: 'range', explicit: true });
  }
  m = s.match(/^(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[日号]?$/);
  if (m) {
    let d = new Date(today.getFullYear(), +m[1] - 1, +m[2]);
    if (d.getTime() >= tomorrow.getTime()) d = new Date(today.getFullYear() - 1, +m[1] - 1, +m[2]);
    if (!Number.isNaN(d.getTime())) return makeRange(d, d, { kind: 'range', explicit: true });
  }
  // 年份
  m = s.match(/^(\d{4})\s*年?$/);
  if (m) return yearRange(+m[1], { now });

  return null;
}

/**
 * 触发词解析。只认**整句开头**的「近期环境 / 环境 10月 / 饼图 9.1-9.15」这类写法,
 * 后面跟的时间段解析不了就返回 null(交给 AI 闲聊,避免把「环境怎么样」也当成指令)。
 */
export function parseMetaTrigger(text, now = new Date()) {
  let s = String(text || '').replace(/\[at\]/g, ' ').trim();
  s = s.replace(/^@\S+\s+/, '').replace(/^[\s:：,，、]+/, '');
  s = s.replace(/^(?:游戏王|ygopro|ocg)\s*/i, '');
  s = s.replace(/[。.!！?？]+$/, '').trim();
  // 时间段后面跟 pdf / PDF版 → 出 PDF;参数本身不参与时间段解析
  let wantPdf = false;
  if (/\s*(?:pdf|pdf版)\s*$/i.test(s)) {
    wantPdf = true;
    s = s.replace(/\s*(?:pdf|pdf版)\s*$/i, '').trim();
  }
  const re = /^(?:(最近|近期|最新|当前|现在)(?:的)?|(这周|本周|上周|上星期|本月|这个月|上月|上个月|今年|去年))?\s*(?:游戏王|ocg)?\s*(?:上位)?\s*(?:卡组)?\s*(?:环境(?:饼图|分布)?|饼图|meta)\s*[:：,，]?\s*([\s\S]*)$/i;
  const m = s.match(re);
  if (!m) return null;
  const prefix = (m[1] || m[2] || '').trim();
  let rest = (m[3] || '').trim();
  rest = rest.replace(/^(?:的|在|于)\s*/, '').replace(/[的。.!！?？]+$/, '').trim();
  const spec = rest || prefix || '';
  const range = parseMetaRange(spec, now);
  if (!range) return null;                       // 有触发词但时间段看不懂 → 不当指令
  return { triggered: true, pdf: wantPdf, trigger: (m[1] ? '近期环境' : m[2] ? `${m[2]}环境` : (s.match(/饼图|环境|meta/i) || ['环境'])[0]), spec, range };
}

/**
 * 「上位 <卡组> [时间]」检索(2026-10-26 新增)。
 * 关键词只有「上位」,不依赖「环境」。卡组名在前,时间参数在后(可省略)。
 * 返回 { triggered, deck, primary, range, query } 或 { triggered:true, error }。
 */
export function parseTopSearch(text, now = new Date()) {
  let s = String(text || '').replace(/\[at\]/g, ' ').trim();
  s = s.replace(/^(?:@\S+\s*)+/, '').trim();
  s = s.replace(/[。.!！?？]+$/, '').trim();
  const m = s.match(/^(?:查|找|搜)?\s*上位(?:卡组)?\s*[:：,，]?\s*([\s\S]+)$/);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return { triggered: true, error: '用法：上位 卡组 [时间]，例如「上位 烙印 10月」。', query: '' };

  let deckText = rest;
  let range = null;
  // 从短到长切:卡组名在前,时间在后。只接受「左边能认出卡组、右边能解析时间」的切法。
  for (let i = 1; i < rest.length; i++) {
    const d = rest.slice(0, i).trim();
    const t = rest.slice(i).trim();
    if (!d || !t) continue;
    const pd = parseDeckAxes(d);
    if (!pd.axes.length) continue;
    if (pd.coverage < 0.9 && pd.label !== d) continue;
    const r = parseMetaRange(t, now);
    if (r) { deckText = d; range = r; break; }
  }

  const parsed = parseDeckAxes(deckText);
  if (!parsed.axes.length || (parsed.coverage < 0.9 && parsed.label !== deckText)) {
    // 认不出卡组也只回这句,不能漏给闲聊 AI
    let field = deckText;
    if (field === rest) {
      for (let i = rest.length - 1; i > 0; i--) {
        const d = rest.slice(0, i).trim();
        const t = rest.slice(i).trim();
        if (d && parseMetaRange(t, now)) { field = d; break; }
      }
    }
    return { triggered: true, error: `找不到含「${field}」的上位卡组。`, query: rest };
  }
  return {
    triggered: true,
    deck: parsed.axes.join('+'),
    primary: parsed.axes[0],
    range,
    query: rest,
  };
}

// =====================================================================================
// 贴吧客户端接口(带 sign)
// =====================================================================================

const TIEBA_SALT = 'tiebaclient!!!';
const TIEBA_UA = 'bdtb for Android 12.0.0';

function md5Upper(s) {
  return crypto.createHash('md5').update(s).digest('hex').toUpperCase();
}
function signedQuery(params) {
  const p = { ...params };
  const sign = md5Upper(Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('') + TIEBA_SALT);
  return new URLSearchParams({ ...p, sign }).toString();
}
async function fetchForumPage(pn, { force = false, log = () => {} } = {}) {
  mkdirSync(PAGE_DIR, { recursive: true });
  const bucket = Math.floor(Date.now() / 3600e3);
  const cachePath = join(PAGE_DIR, `p${String(pn).padStart(3, '0')}_r${PAGE_RN}_${bucket}.json`);
  if (!force && existsSync(cachePath)) {
    try {
      const j = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (Array.isArray(j.list)) {
        log(`  贴吧第 ${pn} 页:命中 1 小时缓存(${j.list.length} 帖)`);
        return j.list;
      }
    } catch { /* 损坏就当没缓存 */ }
  }
  const base = {
    _client_id: 'wappc_176_123',
    _client_version: '12.0.0',
    _phone_imei: '000000000000000',
    from: 'tieba',
    model: 'PC',
    net_type: '1',
    timestamp: String(Math.floor(Date.now() / 1000)),
    kw: FORUM_KW,
    pn: String(pn),
    rn: String(PAGE_RN),
    sort_type: '1',          // 1 = 按发帖时间倒序(实测唯一可用的「按时间段翻」)
  };
  const url = `https://c.tieba.baidu.com/c/f/frs/page?${signedQuery(base)}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': TIEBA_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch { throw new Error(`返回不是 JSON:${txt.slice(0, 120)}`); }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (j.error_code && Number(j.error_code) !== 0) {
        throw new Error(`贴吧接口错误 ${j.error_code}:${j.error_msg || ''}`);
      }
      const list = Array.isArray(j.thread_list) ? j.thread_list : [];
      const threads = list.map(t => ({
        tid: String(t.tid || ''),
        title: String(t.title || ''),
        create: Number(t.create_time || 0),
        last: t.last_time ?? '',
        text: (Array.isArray(t.rich_abstract) ? t.rich_abstract : Array.isArray(t.abstract) ? t.abstract : [])
          .filter(x => x && (x.type === 0 || x.type === 1) && x.text)
          .map(x => String(x.text))
          .join('\n'),
      })).filter(t => t.tid && t.create);
      try {
        writeFileSync(cachePath + '.tmp', JSON.stringify({ at: Date.now(), pn, list: threads }), 'utf8');
        renameSync(cachePath + '.tmp', cachePath);
      } catch { /* 缓存写失败不影响本次 */ }
      log(`  贴吧第 ${pn} 页:${threads.length} 帖,${Date.now() - t0}ms`);
      return threads;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        const wait = 600 * attempt;
        log(`  贴吧第 ${pn} 页失败(${e.message}),${wait}ms 后重试`);
        await new Promise(res => setTimeout(res, wait));
      }
    }
  }
  throw new Error(`贴吧第 ${pn} 页抓取失败:${lastErr?.message || '未知错误'}`);
}

function prunePageCache() {
  try {
    const nowBucket = Math.floor(Date.now() / 3600e3);
    for (const f of readdirSync(PAGE_DIR)) {
      const m = f.match(/_(\d+)\.json$/);
      if (!m) continue;
      if (nowBucket - Number(m[1]) > 48) {
        try { rmSync(join(PAGE_DIR, f), { force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* 目录还不存在 */ }
}

/** 时间段结果/饼图放 60 天就清掉(缓存可重建,别让磁盘无限长) */
function prunePeriods() {
  const cutoff = Date.now() - Math.max(7, Number(process.env.YGOMETA_KEEP_CHARTS_DAYS || 60)) * DAY;
  for (const dir of [PERIOD_DIR, CHART_DIR, PDF_DIR, POST_DIR]) {
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* ignore */ }
      }
    } catch { /* 目录还不存在 */ }
  }
}

// =====================================================================================
// 战报解析
// =====================================================================================

// 卡组「轴」词典(2026-10-26 晚改):一个卡组名可能由多个轴混成(烙印光与暗、狱神耀圣……),
// 不能再只取第一个关键词。**这里的 name 是轴名/官方中文系列名**,regex 是它的各种写法。
// 顺序用于:①同长度匹配时的优先级;②颜色分配(靠前的轴更重要)。
const RULES = [
  ['狱神', /狱神/],
  ['烙印', /烙印/],
  ['闪刀姬', /闪刀/],
  ['码丽丝', /码[丽丽]?[丝斯]|玛丽丝|魔∀丽丝|艺术丽丝|码丽斯/],
  ['杀手旋律', /杀手旋律|杀旋|杀调|杀手级调整曲|^杀手$/],
  // 「盈彩月夜 / 加辉瑞月 / 加瑞辉月 / 升月」是同一套卡组的不同译名(用户 2026-10-26 指出);
  // 卡库里官方中文名是「盈彩月夜」,所以统一归到这个名下。
  ['盈彩月夜', /盈彩月夜|盈彩月|加[辉瑞]{2}月|升月|升辉月/],
  ['雷火沸动', /雷火/],
  ['雷盟', /雷盟/],
  ['巳剑', /巳剑/],
  ['白森', /白森|白森林|白鸦白森/],
  ['魔女术', /魔女术|魔女工艺/],
  ['命运英雄', /命运英雄/],
  ['异解', /异解/],
  ['三幻魔', /三幻魔/],
  ['卡通', /卡通/],
  // 「刻魔破械」不单独当一个轴:它是刻魔 + 破械的混轴,拆开才能在图里各占一块颜色
  ['刻魔', /刻魔|魔镌/],
  ['蛇眼', /蛇眼/],
  ['天杯龙', /天杯/],
  ['荷鲁斯', /荷鲁斯/],
  ['百夫长', /百夫长|百夫骑/],
  ['珠泪', /珠泪/],
  ['神碑', /神碑/],
  ['自鸣天琴', /自鸣天琴|自奏/],
  ['幻影骑士团', /幻影骑士团|^PK$/i],
  ['破械', /破械/],
  ['月光', /月光/],
  ['海皇', /海皇/],
  ['驱魔姐妹', /驱魔姐妹|救祓少女/],
  ['银河眼', /银河眼/],
  ['DDD', /^DDD$|^DD$/i],
  ['GMX', /^GMX$/i],
  ['D.D.炸药', /D\.?D\.?\s*炸药|dd炸弹|d\.d\.ダイナマイト/i],
  ['救援王牌', /救援王牌/],
  ['魔术师', /魔术师/],
  // 黑魔导=黑魔术师;「幕帘」是只带黑魔导副轴的常见记法
  ['黑魔导', /黑魔导|黑魔术师|黑魔导士|幕帘/],
  ['英雄', /英雄/],
  ['青眼白龙', /青眼|白龙/],
  ['原石', /原石/],
  ['耀圣', /耀圣/],
  ['奥艺', /奥艺|奥义|艺术(?!家)/],
  ['莫忘', /莫忘/],
  ['黯蜜', /黯蜜|黯密|味美喵|猫/],
  ['流沙', /流沙/],
  ['无冕者', /无冕者/],
  ['星骑士', /星骑士/],
  ['霍普', /霍普/],
  ['弹丸', /弹丸/],
  ['龙拳', /龙拳|龙link/i],
  ['同步士', /同步士|同调士/],
  ['列车', /列车|车车/],
  ['白银城', /白银城|拉比丽斯/],
  ['亚特兰蒂斯', /亚特兰蒂斯/],
  ['K9', /k9/i],
  ['魔镌', /魔镌/],
  ['魔弹', /魔弹/],
  ['终刻', /终刻/],
  ['神艺', /神艺/],
  ['绚岚', /绚岚|炫岚/],
  ['星宿', /星宿/],
  ['星辰', /星辰/],
  ['光与暗的仪式', /光与暗|光暗|混沌/],
  ['召唤兽', /召唤兽|召唤师/],
  ['妖精传姬', /妖精传姬|妖精之传姬/],
  ['朱罗纪', /朱罗纪/],
  ['炎王', /炎王/],
  ['伟魔', /伟魔|伟贤/],
  ['教导', /教导/],
  ['地中骇界', /地中族|地中骇界/],
  ['翼神龙', /翼神龙/],
  ['转生炎兽', /炎兽/],
  ['磁石战士', /磁石/],
  ['恐龙', /恐龙/],
  ['魔法师均', /魔法师均/],
  ['混沌道化', /道化/],
  ['归光', /归光/],
  ['电子龙', /电子龙/],
  ['六武众', /六武众/],
  ['星因士', /星因士/],
  ['海皇水精鳞', /水精鳞/],
  ['蓟花', /蓟花/],
  ['罪宝', /罪宝/],
  ['勇者', /勇者/],
];
const KNOWN_EN = new Set(['DDD', 'DD', 'GMX', 'PK', 'K9', 'RB', 'R.B.', 'ABC']);
const NOISE_RE = /冠军|亚军|四强|八强|十六强|优胜|使用|卡组|构筑|比赛|参赛|人数|选手|战报|卡牌|店赛|积分|轮|骰|先攻|后攻|排名|上位|环境|淘汰|瑞士|决赛|半决|进4|进八|单淘|冠亚|如下|合计|共计|分布|图[一二三四五]|省流|欢迎|感谢|规则|赛制|奖品|时间|地点|地址|k社|可乐妹/;
const BAD_CHAR_RE = /[\d，,。；;：:！!？?（）()【】\[\]「」《》\/\\|*#@+~]/;
const SENTENCE_RE = /[了吗呢吧啊是在有没就都也很太我你他她它们]/;

function cleanText(s) {
  return String(s || '')
    .replace(/\[图片\]/g, ' ')
    .replace(/image_emoticon/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[【】\[\]「」]/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/\u3000/g, ' ')
    .trim();
}
function stripRecord(s) {
  let x = String(s || '').trim();
  x = x.replace(/(?:赢骰|输骰|先攻|后攻|让先|投骰|决胜)[a-zA-Z]*.*$/, '');
  x = x.replace(/(?:^|\s+)(?:[oOxX]{2,}|[oOxX]{1,3})\s*$/, '');   // 只删「空格 + oo/xox」这种战绩尾巴,别把 GMX 的 X 删了
  x = x.replace(/\s*\d{1,3}\s*人.*$/, '');
  x = x.replace(/^[\d.、]+/, '');
  x = x.replace(/[（(].*?[）)]/g, '');
  x = x.replace(/[*＊]/g, '');
  return x.trim();
}

/**
 * 把一个卡组名拆成「轴」列表。
 * 返回 { axes, label, matched }。例:
 *   烙印光与暗       → axes ['烙印','光与暗的仪式'], label '烙印光与暗的仪式'
 *   狱神艺术耀圣     → axes ['狱神','奥艺','耀圣'],   label '狱神奥艺耀圣'
 *   刻魔破械         → axes ['刻魔','破械'],           label '刻魔破械'
 *   升月             → axes ['盈彩月夜'],              label '盈彩月夜'
 * 最多保留全部轴(混轴按 1/轴数 分摊,少一个轴总数就不对了);label 只用于旧接口/日志。
 */
const AXIS_MATCHERS = RULES.map(([name, re], order) => ({
  name, order,
  re: new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'),
}));

export function parseDeckAxes(raw) {
  let s = stripRecord(raw)
    .replace(/^[:：，,、.\s]+/, '')
    .replace(/[。；;，,、\s]+$/, '')
    .replace(/\s+/g, ' ');
  if (!s) return { axes: [], label: '', matched: false };
  s = s.replace(/^(?:使用)?卡组[:：]?\s*/, '');

  // 找出所有轴别名;按「长别名优先」贪心取不重叠的(艺术丽丝→码丽丝,不会被拆成 奥艺+丽丝)
  const found = [];
  for (const { name, re, order } of AXIS_MATCHERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (!m[0]) { re.lastIndex++; continue; }
      found.push({ name, start: m.index, end: m.index + m[0].length, len: m[0].length, order });
    }
  }
  found.sort((a, b) => b.len - a.len || a.start - b.start || a.order - b.order);
  const chosen = [];
  for (const m of found) {
    if (chosen.some(x => m.start < x.end && m.end > x.start)) continue;
    chosen.push(m);
  }
  chosen.sort((a, b) => a.start - b.start || b.len - a.len);
  const axes = [];
  for (const m of chosen) if (!axes.includes(m.name)) axes.push(m.name);
  // 「幕帘猫/幕帘黯蜜」:猫是黯蜜,幕帘只是黑魔导副轴,主卡组仍是黯蜜
  if (axes.includes('黯蜜') && axes[0] !== '黯蜜' && /幕帘|猫/.test(s)) {
    axes.splice(axes.indexOf('黯蜜'), 1);
    axes.unshift('黯蜜');
  }

  // 覆盖率:整段是否基本由卡组轴组成。检索「上位 烙印真的强」时不能因为含「烙印」就触发
  const covered = new Array(s.length).fill(false);
  for (const m of chosen) for (let i = m.start; i < m.end; i++) covered[i] = true;
  let totalChars = 0, leftover = 0;
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) continue;
    totalChars++;
    if (!covered[i]) leftover++;
  }
  const coverage = totalChars ? Math.max(0, Math.min(1, (totalChars - leftover) / totalChars)) : 0;

  if (!axes.length) {
    // 纯英文卡组(DDD/GMX/R.B. 等)走精确白名单,避免把玩家名当成卡组
    if (s.length <= 8 && /^[A-Za-z.]+$/.test(s) && KNOWN_EN.has(s)) {
      return { axes: [s], label: s, matched: true, coverage: 1 };
    }
    return { axes: [], label: '', matched: false, coverage: 0 };
  }
  return { axes, label: axes.join(''), matched: true, coverage };
}

/** 兼容旧调用:只关心「归一化后的展示名」时用它;同时带上 axes 供混轴统计。 */
export function canonicalDeck(raw) {
  const r = parseDeckAxes(raw);
  return { name: r.label, label: r.label, axes: r.axes, matched: r.matched };
}

const ROLE_SRC = '冠军|亚军|四强|八强|十六强|优胜|一位|二位|三位|四位';
const ROLE_RE = new RegExp(`(${ROLE_SRC}|(?<=^|[\\s，,、；;])(冠|亚)(?=[\\s，,、:：]|$))`, 'g');
const ROLE_MAX = { 冠军: 3, 优胜: 3, 一位: 3, 冠: 3, 亚军: 3, 二位: 3, 亚: 3, 四强: 4, 三位: 2, 四位: 2, 八强: 8, 十六强: 16 };
const LOG_RE = /对战|VS|vs |赢骰|输骰|先攻|后攻|第一轮|第二轮|第三轮|第四轮|第五轮|瑞士轮|淘汰赛|[rRmM]\d|[oOxX]{2,}|打(?![磨])|轮空|轮\s*\d|\d\s*[-:：]\s*\d/;

function splitMulti(s) {
  return s.split(/\s+和\s+|和(?=[\u4e00-\u9fa5]{2,})|\s*[\/／＋+]\s*/).map(x => x.trim()).filter(Boolean);
}

function parseRoleList(text) {
  const t = cleanText(text);
  const marks = [];
  let m;
  ROLE_RE.lastIndex = 0;
  while ((m = ROLE_RE.exec(t))) marks.push({ role: m[1], idx: m.index, end: ROLE_RE.lastIndex });
  if (!marks.length) return [];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const role = marks[i].role.replace(/^冠$/, '冠军').replace(/^亚$/, '亚军');
    let seg = t.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].idx : t.length);
    // 「卡组分布：A1 B2 ...」「出轮卡组：...」是参赛统计,不是这一名的卡组
    seg = seg.split(/(?:卡组)?(?:分布|统计|数量)|出轮卡组|环境分布|上位卡组如下|赛制\s*[:：]/)[0];
    // 「4轮出八强」「十六强卡组」不是名次,是赛制/统计描述
    const before = t.slice(Math.max(0, marks[i].idx - 4), marks[i].idx);
    const head = seg.replace(/^\s*[:：]?\s*/, '');
    if (/(?:出|进)$/.test(before) || /^(?:卡组|分布|统计|出轮|如下)/.test(head)) continue;
    // 一行里多个「玩家：卡组」时当前解析不可靠,不要硬拼成一套卡组
    if ((head.match(/[:：]/g) || []).length >= 2 && !head.includes('\n')) continue;
    // 这是战报里的对手/记录段,不是榜单 → 跳过(否则会把对手卡组算成上位)
    if (/^\s*(?:VS|vs|对战|打|赢骰|输骰)/.test(seg)) continue;
    const decks = [];
    const deckPart = seg.match(/(?:使用)?卡组\s*(?!分布|统计|数量|如下)[:：]?\s*([^，,。；;\n]+)/);
    if (deckPart) {
      for (const part of splitMulti(deckPart[1])) { const c = canonicalDeck(part); if (c.name) decks.push(c); }
    }
    if (!decks.length) {
      const groups = seg.split(/[，,、；;\n]+/).map(x => x.trim()).filter(Boolean);
      const seen = new Set();
      for (const g of groups) {
        if (decks.length >= (ROLE_MAX[role] || 1)) break;
        if (/^(?:卡组)?(?:分布|统计|数量)|上位卡组如下/.test(g)) continue;
        const pm = g.match(/^([^（(]{2,20})[（(]([^）)]{2,30})[）)]/);
        if (pm) {
          const outside = canonicalDeck(pm[1]);
          if (outside.matched) { if (!seen.has(outside.name)) { seen.add(outside.name); decks.push(outside); } continue; }
          const inside = canonicalDeck(pm[2]);
          if (inside.matched) { if (!seen.has(inside.name)) { seen.add(inside.name); decks.push(inside); } continue; }
        }
        for (const tok of g.split(/\s+/).filter(Boolean)) {
          if (decks.length >= (ROLE_MAX[role] || 1)) break;
          for (const part of splitMulti(tok)) {
            const c = canonicalDeck(part);
            if (c.name && !seen.has(c.name)) { seen.add(c.name); decks.push(c); }
          }
        }
      }
    }
    for (const d of decks) out.push({ role, ...d });
  }
  return out;
}

function roleNorm(r) { return r === '冠' ? '冠军' : r === '亚' ? '亚军' : r; }

function parseTitleRole(title) {
  const t = cleanText(title).replace(/\s+/g, ' ');
  const useDeckTitle = t.match(/使用卡组[:：]?\s*([^\s，,。；;]{2,20})/);
  let m = t.match(/\d+\s*人\s*(冠军|冠|亚军|亚|四强|八强|4强|8强)\s*([^\s，,。；;]{2,20})/);
  if (m) return { role: roleNorm(m[1].replace('4强', '四强').replace('8强', '八强')), ...canonicalDeck(m[2]) };
  m = t.match(/(冠军|亚军|四强|八强|优胜)\s*[:：，,]?\s*([^\s，,。；;]{2,20})/);
  if (m) return { role: roleNorm(m[1]), ...canonicalDeck(m[2]) };
  m = t.match(/\d+\s*人\s*([^\s，,。；;]{2,20}?)\s*(冠军|冠|亚军|亚|四强|八强|4强|8强)(?:$|\s)/);
  if (m) return { role: roleNorm(m[2].replace('4强', '四强').replace('8强', '八强')), ...canonicalDeck(m[1]) };
  // 单字「冠/亚」:逐个位置试,后面能认出卡组才算(例:10.24北京泛亚冠原石白龙)
  for (const mm of t.matchAll(/冠(?!军)/g)) {
    const c = canonicalDeck(t.slice(mm.index + 1, mm.index + 21));
    if (c.matched) return { role: '冠军', ...c };
  }
  for (const mm of t.matchAll(/亚(?!军|冠)/g)) {
    const c = canonicalDeck(t.slice(mm.index + 1, mm.index + 21));
    if (c.matched) return { role: '亚军', ...c };
  }
  // 标题写了「使用卡组」但排名在别处:至少别把亚军记成冠军
  if (useDeckTitle) {
    const r = t.match(/(冠军|亚军|四强|八强|十六强|优胜)/);
    return { role: r ? roleNorm(r[1]) : '上位', ...canonicalDeck(useDeckTitle[1]) };
  }
  return { role: '', name: '', matched: false };
}

function resultLines(body) {
  const out = [];
  for (const line of body.split(/\n/)) {
    const l = line.trim();
    if (!l || LOG_RE.test(l)) continue;
    if (/^(冠军|亚军|四强|八强|十六强|优胜|一位|二位|三位|四位|冠|亚)(?=\s|[:：，,、]|$)/.test(l)) out.push(l);
    else {
      const roles = l.match(new RegExp(ROLE_SRC, 'g')) || [];
      if (roles.length >= 2) out.push(l);
    }
  }
  return out;
}
function listScore(body) {
  let n = 0;
  for (const l of resultLines(body)) {
    const roles = l.match(new RegExp(ROLE_SRC, 'g')) || [];
    n += Math.max(1, roles.length);
  }
  return n;
}

/**
 * 单条帖子 → 上位列表。只返回**认得出的卡组**;认不出的(玩家名、碎话)直接丢,
 * 免得饼图里出现「鑫宇」「分了」这种块。
 */
export function analyzeThread(thread) {
  const title = cleanText(thread.title || '');
  // 图注里常重复一遍「图6: 冠军 烙印」;统计只看正文榜单,避免同一条记录出现两次
  const body = cleanText(thread.text || '').replace(/图\s*\d+\s*[:：][\s\S]*?(?=图\s*\d+\s*[:：]|$)/g, ' ');
  const tr = parseTitleRole(title);
  const firstLine = body.split(/\n/).map(x => x.trim()).filter(Boolean)[0] || '';
  const useDeck = body.match(/(?:使用)?卡组\s*(?!分布|统计|数量|如下)[:：]?\s*([^\n，,。；;]{2,30})/);
  // 单卡组战报的名次有时不写标题,写在正文前几行(如「135人7轮出16 亚军」)
  const bodyHead = body.split(/\n/).slice(0, 6).join('\n');
  const bodyRole = (bodyHead.match(/(冠军|亚军|四强|八强|十六强|优胜)/) || [])[1] || '';
  const role = tr.role || bodyRole || '上位';
  const score = listScore(body);
  const list = parseRoleList(body);
  const matched = list.filter(x => x.matched);

  let entries = [];
  let mode = 'none';
  if (score >= 2 && matched.length) { entries = matched; mode = 'list'; }
  else if (useDeck && !/^[（(]|合计|如下|分布/.test(useDeck[1].trim())) {
    const parts = splitMulti(useDeck[1]).map(p => canonicalDeck(p)).filter(c => c.name);
    if (parts.length) { entries = parts.map(c => ({ role, ...c })); mode = 'report'; }
  }
  if (!entries.length && tr.name) { entries = [{ ...tr }]; mode = 'title'; }
  if (!entries.length && score >= 1 && matched.length) { entries = matched; mode = 'list'; }
  if (!entries.length && firstLine && !LOG_RE.test(firstLine)) {
    const c = canonicalDeck(firstLine);
    if (c.name) { entries = [{ role, ...c }]; mode = 'report'; }
  }
  if (entries.length > 24) return [];            // 明显解析炸了(一帖 24 个上位),宁可不计
  // 兜底:整段卡组分布被当成一套卡组时会有 8~20 个轴/超长名字;宁可不计
  const clean = [];
  for (const e of entries) {
    const axes = Array.isArray(e.axes) ? e.axes : [];
    const name = String(e.name || '');
    if (axes.length > 6 || name.length > 30) continue;
    clean.push(e);
  }
  return clean;
}

const COMP_TITLE_RE = /(杯|赛|CS|战报|积分|巡回|WCQ|YCS|店赛|周赛|月赛|冠|上位|人)/;
const COMP_EXCLUDE_RE = /上周饼|本周饼|饼图|收集上位|汇总|统计|环境分布|搬运|合集|上位精选/;
const NONCOMP_RE = /收卡|出售|交易|求|讨论|怎么|为什么|如何|请问|咨询|找组织|有没有|盘点|回忆|吐槽|节奏/;

export function isCompetitionThread(thread) {
  const title = String(thread.title || '');
  if (COMP_EXCLUDE_RE.test(title)) return false;
  if (!COMP_TITLE_RE.test(title)) return false;
  if (NONCOMP_RE.test(title) && !/杯|赛|战报/.test(title)) return false;
  return true;
}

// =====================================================================================
// 本地缓存(帖子 / 时间段)
// =====================================================================================

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', JSON.stringify(obj), 'utf8');
  renameSync(path + '.tmp', path);
}
function ensureDirs() {
  for (const d of [CACHE_DIR, PAGE_DIR, PERIOD_DIR, CHART_DIR, PDF_DIR, POST_DIR]) mkdirSync(d, { recursive: true });
}

function loadStore() {
  const j = readJson(THREADS_FILE, null);
  if (j && j.v === STORE_VERSION && j.threads && typeof j.threads === 'object') {
    if (j.parseVersion === PARSE_VERSION) return j;
    // 解析口径变了:把缓存里的帖子重新分析一遍(不联网)。
    // ⚠ 非赛事帖必须继续留空,否则「讨论贴」里的卡组名会混进饼图。
    for (const t of Object.values(j.threads)) t.entries = isCompetitionThread(t) ? analyzeThread(t) : [];
    j.parseVersion = PARSE_VERSION;
    return j;
  }
  return { v: STORE_VERSION, parseVersion: PARSE_VERSION, updatedAt: Date.now(), threads: {} };
}
function saveStore(store) {
  const list = Object.values(store.threads).sort((a, b) => (b.create || 0) - (a.create || 0));
  const cutoff = Date.now() - 400 * DAY;
  const keep = list.filter(t => (t.create || 0) * 1000 >= cutoff).slice(0, MAX_THREADS);
  store.threads = Object.fromEntries(keep.map(t => [t.tid, t]));
  store.updatedAt = Date.now();
  writeJsonAtomic(THREADS_FILE, store);
}

async function crawlRange(range, { force = false, log = () => {} } = {}) {
  const found = new Map();
  let truncated = false;
  let stopped = false;
  for (let pn = 0; pn <= MAX_PAGES; pn++) {
    let list;
    try {
      list = await fetchForumPage(pn, { force, log });
    } catch (e) {
      if (found.size) { log(`  第 ${pn} 页失败,已有 ${found.size} 条,继续用已有的:${e.message}`); truncated = true; stopped = true; break; }
      throw e;
    }
    if (!list.length) { stopped = true; break; }
    let pageMax = 0;
    let added = 0;
    for (const t of list) {
      pageMax = Math.max(pageMax, t.create);
      if (t.create >= range.start / 1000 && t.create < range.end / 1000) {
        if (!found.has(t.tid)) { found.set(t.tid, t); added++; }
      }
    }
    log(`  第 ${pn} 页:${list.length} 帖,落在区间 ${added} 条(累计 ${found.size})`);
    if (pageMax < range.start / 1000) { stopped = true; break; }
    if (pn > 0 && PAGE_DELAY_MS) await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
  }
  if (!stopped) truncated = true;                 // 翻到上限还没走到区间起点 → 数据不全
  return { threads: [...found.values()], truncated };
}

function periodFile(key) { return join(PERIOD_DIR, `${key}.json`); }
function chartFile(key) { return join(CHART_DIR, `${key}.png`); }

function cacheFresh(period, range) {
  if (!period?.builtAt) return false;
  const now = Date.now();
  const ttl = range.end > now - DAY ? RECENT_TTL_MS : PAST_TTL_MS;
  return now - period.builtAt < ttl;
}

// =====================================================================================
// 主流程
// =====================================================================================

// 同一个比赛经常有「个人战报 + 完整战报」两个帖子;标题去掉日期/名次/人数后做近似,
// 用来避免同一副上位被记两次。只用于统计聚合,不改原始 threads。
function eventTitleKey(title) {
  return String(title || '')
    .replace(/20\d{2}\s*[.\-/年]\s*/g, ' ')
    .replace(/\d{1,2}\s*[.\-/月]\s*\d{1,2}\s*日?/g, ' ')
    .replace(/[【】\[\]（）()「」《》]/g, '')
    .replace(/(?:冠军|亚军|四强|八强|十六强|上位|战报|比赛|锦标赛|积分赛|店赛)/g, '')
    .replace(/\d+\s*人/g, ' ')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .trim();
}
function sameEventKey(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  return min >= 4 && (a.includes(b) || b.includes(a));
}

function aggregate(records) {
  // 一个卡组只算 1 副:混轴先选「全局出现次数最多的轴」当主轴,其余进副轴桶。
  // 例:原石白龙 2 + 白龙 1 → 白龙 3(纯1 + 原石2),不会拆成原石2 + 白龙1。
  const items = [];
  const seenEvents = new Set();   // 同一场比赛只算一次「赛事」
  const seenEntries = new Map();  // 比赛+名次+卡组 → 已见过的标题 key,防同场双帖
  let posts = 0;
  let entries = 0;
  for (const t of records) {
    const list = t.entries || [];
    if (!list.length) continue;
    const day = eventDateFromTitle(t.title, t.create);
    const ek = eventTitleKey(t.title);
    const eventKey = `${day}|${ek}`;
    if (!seenEvents.has(eventKey)) { seenEvents.add(eventKey); posts++; }
    for (const e of list) {
      const axes = (Array.isArray(e?.axes) && e.axes.length ? e.axes : [e?.name]).filter(Boolean);
      if (!axes.length) continue;
      const sig = `${day}|${e.role || ''}|${e.name || axes[0]}`;
      const prev = seenEntries.get(sig) || [];
      // 只把「个人单帖」和另一份榜单视为同一条重复;两份完整榜单可能是不同选手同卡组同名次
      if (prev.some(x => x.size === 1 && sameEventKey(x.ek, ek)) || (list.length === 1 && prev.some(x => sameEventKey(x.ek, ek)))) continue;
      prev.push({ ek, size: list.length });
      seenEntries.set(sig, prev);
      items.push({ axes, role: e.role || '', name: e.name || axes[0] });
      entries++;
    }
  }

  // 先统计每个轴在全部样本里的出现次数,再决定混轴的主轴
  const axisOcc = new Map();
  for (const it of items) for (const a of it.axes) axisOcc.set(a, (axisOcc.get(a) || 0) + 1);
  const groups = new Map();       // 主轴 → { name, num, decks: axes[][] }
  for (const it of items) {
    let primary = it.axes[0];
    for (const a of it.axes) {
      if ((axisOcc.get(a) || 0) > (axisOcc.get(primary) || 0)) primary = a;
    }
    const ordered = [primary, ...it.axes.filter(a => a !== primary)];
    let g = groups.get(primary);
    if (!g) { g = { name: primary, num: 0, decks: [] }; groups.set(primary, g); }
    g.num++;
    g.decks.push(ordered);
  }

  const list = [...groups.values()].map(g => {
    let pure = 0;
    const bmap = new Map();
    const primarySize = axisOcc.get(g.name) || g.num;
    for (const axes of g.decks) {
      if (axes.length === 1) { pure++; continue; }
      // 只考虑总占比比本轴小的副轴;更大的轴已经有自己的整块,避免重复
      const cands = axes.slice(1).filter(a => (axisOcc.get(a) || 0) < primarySize);
      let pick = null;
      for (const a of cands) {
        if (!pick || (axisOcc.get(a) || 0) > (axisOcc.get(pick) || 0)) pick = a;
      }
      const bucket = pick || '其他混轴';
      bmap.set(bucket, (bmap.get(bucket) || 0) + 1);
    }
    const buckets = [...bmap.entries()]
      .map(([name, count]) => ({ name, count, share: count / g.num }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
    return { name: g.name, num: g.num, pure, buckets };
  }).sort((a, b) => b.num - a.num || a.name.localeCompare(b.name, 'zh'));
  return { list, posts, entries, unique: list.length };
}

/**
 * 生成/读取某个时间段的环境饼图。
 * @param {object} range parseMetaRange 的返回值
 * @param {{force?:boolean,log?:(s:string)=>void}} [opts]
 * @returns {Promise<{pngPath:string,range:object,stats:object,cached:boolean,truncated:boolean}>}
 */
export async function buildMetaPie(range, opts = {}) {
  if (!range) throw new Error('时间段为空');
  const { force = false, log = () => {} } = opts;
  ensureDirs();
  prunePageCache();
  prunePeriods();

  const key = range.key;
  const pfile = periodFile(key);
  const png = chartFile(key);
  const cached = readJson(pfile, null);
  if (!force && cached?.v === PIE_VERSION && cached?.parseVersion === PARSE_VERSION
    && cached?.key === key && existsSync(png) && cacheFresh(cached, range)) {
    log(`命中缓存:${range.label}(${basename(png)})`);
    return { pngPath: png, range, stats: cached.stats, cached: true, truncated: !!cached.truncated, builtAt: cached.builtAt };
  }

  const store = loadStore();
  log(`缓存未命中,开始抓取「${range.desc}」...`);
  let truncated = false;
  let updated = false;
  try {
    const { threads, truncated: tr } = await crawlRange(range, { force, log });
    truncated = tr;
    for (const t of threads) {
      const old = store.threads[t.tid];
      if (old && old.text === t.text && old.title === t.title && old.parseVersion === PARSE_VERSION) continue;
      const rec = { ...t, url: `https://tieba.baidu.com/p/${t.tid}`, parseVersion: PARSE_VERSION, at: Date.now() };
      rec.entries = isCompetitionThread(rec) ? analyzeThread(rec) : [];
      store.threads[t.tid] = rec;
      updated = true;
    }
    saveStore(store);
    // 抓取更新完记录库后跑一次同卡异名自检(不参与日常查询)
    if (updated) {
      try { await auditDeckAliases(store, { log }); } catch (e) { log(`  别名自检跳过:${e.message}`); }
    }
  } catch (e) {
    if (cached && existsSync(png)) {
      log(`抓取失败,改用旧缓存:${e.message}`);
      return { pngPath: png, range, stats: cached.stats, cached: true, truncated: !!cached.truncated, builtAt: cached.builtAt };
    }
    throw e;
  }

  const records = [];
  for (const t of Object.values(store.threads)) {
    if (!t?.entries?.length) continue;
    if (t.create * 1000 >= range.start && t.create * 1000 < range.end) records.push(t);
  }
  const stats = aggregate(records);
  log(`区间内 ${stats.posts} 场赛事,${stats.entries} 副上位,${stats.unique} 个主轴`);

  const chart = await renderMetaPie({
    range, counts: stats.list, axisCount: stats.unique,
    totalPosts: stats.posts, totalEntries: stats.entries,
    truncated, outPath: png, log,
  });

  const period = {
    v: PIE_VERSION,
    parseVersion: PARSE_VERSION,
    key,
    start: range.start,
    end: range.end,
    label: range.label,
    desc: range.desc,
    builtAt: Date.now(),
    stats,
    truncated,
    chart: basename(png),
    chartBytes: chart.bytes,
  };
  writeJsonAtomic(pfile, period);
  return { pngPath: png, range, stats, cached: false, truncated, builtAt: period.builtAt };
}

// ---------- PDF 报告(饼图 + 三栏详细上位记录,2026-10-26) ----------

function pdfEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pdfEntryText(e) {
  const name = String(e?.name || e?.label || '').trim();
  if (!name) return '';
  const role = e?.role && e.role !== '上位' ? `${e.role} ` : '';
  return role + name;
}
function buildPdfHtml({ range, piePath, stats, records }) {
  const png = readFileSync(piePath).toString('base64');
  const byDay = new Map();
  for (const r of records) {
    const d = new Date(r.create * 1000);
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }
  let cols = '';
  for (const [day, list] of byDay) {
    cols += `<div class="day">${day}</div>`;
    for (const r of list) {
      const entries = (r.entries || []).map(pdfEntryText).filter(Boolean);
      if (!entries.length) continue;
      const title = cleanText(r.title || '').replace(/\s+/g, ' ').trim() || '(无标题)';
      cols += `<div class="event"><div class="etitle">${pdfEsc(title)}</div><div class="elist">${entries.map(pdfEsc).join('<br>')}</div></div>`;
    }
  }
  let summary = '';
  for (const c of stats.list) {
    let label = `${pdfEsc(c.name)} <b>${c.num}</b>`;
    if (c.buckets?.length) {
      const named = c.buckets.filter(b => b.name !== '其他混轴');
      const top = named.slice(0, 2);
      const otherCount = c.buckets.reduce((s, b) => s + (top.includes(b) ? 0 : b.count), 0);
      const bits = [`纯 ${c.pure}`, ...top.map(b => `${pdfEsc(b.name)} ${b.count}`)];
      if (otherCount > 0) bits.push(`其他混轴 ${otherCount}`);
      label += ` <em>（${bits.join(' + ')}）</em>`;
    }
    summary += `<div class="srow"><span class="sname">${label}</span></div>`;
  }
  const title = cleanText(range.desc || '').replace(/\s+/g, ' ').trim();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${pdfEsc(title)} 上位卡组环境</title><style>
    @page{size:A4;margin:9mm 8mm 10mm}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{font-family:"Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei","PingFang SC",sans-serif;color:#222}
    .pie{display:block;max-width:100%;max-height:135mm;width:auto;height:auto;margin:0 auto 2.5mm}
    .summary h2{font-size:14pt;margin:0 0 1mm}
    .summary .ssub{font-size:8.2pt;color:#666;margin:0 0 2.5mm;line-height:1.32}
    .scols{column-count:3;column-gap:6mm;column-fill:balance;font-size:8.6pt;line-height:1.3}
    .srow{break-inside:avoid;page-break-inside:avoid;margin:0 0 0.9mm}
    .sname{display:block}
    .sname b{font-weight:700}
    .sname em{font-style:normal;color:#666;font-size:8pt}
    .appendix{break-before:page;page-break-before:always}
    .appendix h2{font-size:15pt;margin:0 0 1.5mm}
    .appendix .sub{font-size:9pt;color:#666;margin:0 0 4mm}
    .cols{column-count:3;column-gap:6mm;column-fill:auto;font-size:9.4pt;line-height:1.48}
    .day{font-size:10.4pt;font-weight:700;margin:0 0 1.2mm;break-after:avoid;page-break-after:avoid}
    .event{break-inside:avoid;page-break-inside:avoid;margin:0 0 2.2mm}
    .etitle{font-weight:700;font-size:9.5pt;line-height:1.35;margin-bottom:0.4mm}
    .elist{font-size:9.1pt;color:#333}
  </style></head><body>
    <img class="pie" src="data:image/png;base64,${png}" alt="环境饼图">
    <section class="summary">
      <h2>上位卡组数量</h2>
      <div class="ssub">按主轴计,一副只归一个主轴;括号内 = 纯 + 各副轴桶,相加等于该主轴总数;比本轴大的副轴已有自己的整块,不重复列 · 共 ${stats.entries} 副 / ${stats.unique} 个主轴</div>
      <div class="scols">${summary}</div>
    </section>
    <section class="appendix">
      <h2>附录 · 详细上位记录</h2>
      <div class="sub">${pdfEsc(range.desc)} · ${stats.posts} 场赛事 / ${stats.entries} 副上位 / ${stats.unique} 个主轴 · 混轴显著时才在图外圈标副轴,文字记录保留原始卡组名</div>
      <div class="cols">${cols}</div>
    </section>
  </body></html>`;
}

/** HTML → PDF(Chrome/Edge headless --print-to-pdf) */
function renderPdf(html, pdfPath, log = () => {}) {
  return new Promise((resolve, reject) => {
    mkdirSync(PDF_DIR, { recursive: true });
    const tmpDir = join(CACHE_DIR, 'html');
    mkdirSync(tmpDir, { recursive: true });
    const stamp = `${process.pid}_${Date.now()}`;
    const htmlPath = join(tmpDir, `report_${stamp}.html`);
    const profile = join(tmpDir, `pdfprof_${stamp}`);
    writeFileSync(htmlPath, html, 'utf8');
    const chrome = chromePath();
    if (!chrome || (!existsSync(chrome) && !/^[a-zA-Z0-9_-]+$/.test(chrome))) {
      return reject(new Error(`找不到无头浏览器:${chrome || '(空)'}(可设 CHROME_PATH)`));
    }
    try { rmSync(pdfPath, { force: true }); } catch { /* ignore */ }
    const headless = process.platform === 'win32' ? '--headless' : '--headless=new';
    const args = [
      headless,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=5000',
      `file://${htmlPath.replace(/\\/g, '/')}`,
    ];
    const child = spawn(chrome, args, { windowsHide: true, stdio: 'ignore' });
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(htmlPath, { force: true }); } catch { /* ignore */ }
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(reject, new Error(`PDF 生成超时(90s):${chrome}`));
    }, 90000);
    child.on('error', e => finish(reject, new Error(`无头浏览器启动失败:${e.message}(CHROME_PATH=${chrome})`)));
    child.on('exit', code => {
      if (!existsSync(pdfPath)) return finish(reject, new Error(`PDF 生成失败(exit ${code})`));
      const sz = statSync(pdfPath).size;
      if (sz < 4096) return finish(reject, new Error(`PDF 文件异常小(${sz} B)`));
      log(`  PDF 已渲染:${(sz / 1024 / 1024).toFixed(2)} MB`);
      finish(resolve);
    });
  });
}

/**
 * 生成「饼图 + 三栏详细上位记录」PDF(用户 2026-10-26 要求:时间段后加 pdf 参数)。
 * 复用饼图缓存;PDF 缓存在 cache/pdfs/,比 PNG 新就直接用。
 */
export async function buildMetaPdf(range, opts = {}) {
  if (!range) throw new Error('时间段为空');
  const { force = false, log = () => {} } = opts;
  ensureDirs();
  prunePeriods();
  const pie = await buildMetaPie(range, { force, log });
  const pdfPath = join(PDF_DIR, `${range.key}_v${PDF_VERSION}.pdf`);
  if (!force && existsSync(pdfPath) && existsSync(pie.pngPath)) {
    try {
      if (statSync(pdfPath).mtimeMs >= statSync(pie.pngPath).mtimeMs) {
        log(`命中 PDF 缓存:${basename(pdfPath)}`);
        return { ...pie, pdfPath, cached: true };
      }
    } catch { /* 重新生成 */ }
  }
  const store = loadStore();
  const records = [];
  for (const t of Object.values(store.threads)) {
    if (!t?.entries?.length) continue;
    if (t.create * 1000 < range.start || t.create * 1000 >= range.end) continue;
    records.push(t);
  }
  records.sort((a, b) => a.create - b.create);
  log(`  PDF 记录:${records.length} 帖 ...`);
  const html = buildPdfHtml({ range, piePath: pie.pngPath, stats: pie.stats, records });
  await renderPdf(html, pdfPath, log);
  return { ...pie, pdfPath, cached: false, records: records.length };
}

// ---------- 「上位 卡组 [时间]」检索:本地找链接 + 原帖抓构筑图(2026-10-26) ----------

/** 从标题里取赛事日期(【10.24】/10.24/2026.10.24),取不到就用发帖日 */
function eventDateFromTitle(title, createSec) {
  const post = new Date(createSec * 1000);
  const s = String(title || '');
  let m = s.match(/[【\[]\s*(?:(20\d{2})[./-])?(\d{1,2})[./-](\d{1,2})/);
  if (!m) m = s.match(/^\s*(?:(20\d{2})[./-])?(\d{1,2})[./-](\d{1,2})/);
  if (!m) m = s.match(/^\s*(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/);
  if (!m) return ymdDash(post);
  const y0 = m[1] ? Number(m[1]) : post.getFullYear();
  const mo = Number(m[2]);
  const day = Number(m[3]);
  let y = y0;
  // 跨年发帖:12 月底发 1 月初的赛事 / 1 月初发 12 月底的赛事
  if (!m[1]) {
    if (mo > post.getMonth() + 1 + 6) y--;
    if (mo < post.getMonth() + 1 - 6) y++;
  }
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return ymdDash(post);
  const d = new Date(y, mo - 1, day);
  if (d.getMonth() !== mo - 1 || d.getDate() !== day) return ymdDash(post);
  return ymdDash(d);
}

function normTiebaImg(src) {  let u = String(src || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  u = u.replace(/^http:\/\//i, 'https://');
  // tiebapic 对无 sign 的直链返回 238x238 占位图;imgsrc 能拿到原图
  u = u.replace(/^https?:\/\/tiebapic\.baidu\.com/i, 'https://imgsrc.baidu.com');
  return u;
}

/** 读图片像素尺寸(只处理常见 JPEG/PNG/GIF/WebP;读不出返回 null) */
function imageDims(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X' && buf.length >= 30) {
      return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (kind === 'VP8 ' && buf.length >= 30) {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

/** 过滤 238x238 贴吧占位图 / 横幅 / 太小的图 */
function looksLikeDeckImage(buf) {
  const d = imageDims(buf);
  if (!d || !d.w || !d.h) return { ok: true, dims: null };   // 读不出就不拦
  const ratio = d.w / d.h;
  if (d.w < 300 || d.h < 300) return { ok: false, dims: d, why: `尺寸太小 ${d.w}x${d.h}` };
  if (d.w * d.h < 150000) return { ok: false, dims: d, why: `面积太小 ${d.w}x${d.h}` };
  if (ratio < 0.3 || ratio > 2.6) return { ok: false, dims: d, why: `比例异常 ${ratio.toFixed(2)}` };
  return { ok: true, dims: d };
}

/** 给原帖图片打分:优先文本里明确提到卡组/构筑,其次竖图/大图;海报合影降权 */
function scoreDeckImage(im, primary, threadText) {
  const text = `${threadText || ''} ${im.postText || ''} ${im.context || ''}`;
  const label = String(im.label || '');
  const near = String(im.nearText || '');
  let score = 0;
  if (/卡组|构筑|卡表|主卡|额外|副卡|side|deck/i.test(text)) score += 5;
  if (primary && text.includes(primary)) score += 3;
  if (/冠军|亚军|四强|八强|上位|战报|比赛|锦标赛|积分赛|店赛|WCQ|regional/i.test(text)) score += 1;
  if (/海报|宣传|合影|奖品|抽奖|场地|门店|活动|广告|约战|交流/i.test(text)) score -= 2;
  if (near) {
    if (primary && near.includes(primary)) score += 8;
    if (/使用卡组|卡组[:：]|构筑|卡表|主卡|额外|side|deck/i.test(near)) score += 6;
    if (/饼图|分布|场照|环境|店|token|海报|合影|奖品|场地|活动|现场|裁判/i.test(near)) score -= 10;
  }
  if (label) {
    if (primary && label.includes(primary)) score += 10;
    if (/卡组|构筑|卡表|上位|八强|冠军|亚军|四强/i.test(label)) score += 4;
    if (/场照|环境|店|token|海报|合影|奖品|场地|活动|现场|裁判/i.test(label)) score -= 8;
  }
  const b = String(im.bsize || '').split(',').map(Number);
  if (b.length === 2 && b[0] > 0 && b[1] > 0) {
    const ratio = b[0] / b[1];
    if (ratio < 0.8) score += 2;       // 竖图更像卡组列表
    if (ratio < 0.55) score -= 4;      // 9:16 竖屏截图(比赛对阵/聊天)通常不是卡组
    if (ratio > 2.2) score -= 3;       // 横幅/海报
  }
  return score;
}

/** 抓某帖 1 楼的图片列表(带 7 天缓存);失败抛错 */
export async function fetchThreadPostImages(tid, opts = {}) {
  const { force = false, log = () => {} } = opts;
  if (!tid) throw new Error('tid 为空');
  mkdirSync(POST_DIR, { recursive: true });
  const file = join(POST_DIR, `${tid}.json`);
  if (!force) {
    const cached = readJson(file, null);
    if (cached?.v === 4 && Array.isArray(cached.images) && Date.now() - (cached.at || 0) < 7 * DAY) {
      if (!cached.images.length) throw new Error('帖子里没有图片(缓存)');
      return cached.images;
    }
  }
  const params = { kz: String(tid), pn: '1', rn: '30', lz: '1' };
  const url = `https://c.tieba.baidu.com/c/f/pb/page?${signedQuery(params)}`;
  log(`  抓原帖 ${tid} ...`);
  const r = await fetch(url, {
    headers: {
      'User-Agent': TIEBA_UA,
      Referer: 'https://tieba.baidu.com/',
      Accept: 'application/json,text/plain,*/*',
    },
  });
  if (!r.ok) throw new Error(`原帖接口 HTTP ${r.status}`);
  const j = await r.json();
  if (j.error_code && j.error_code !== 0) throw new Error(`原帖接口错误 ${j.error_code}:${j.error_msg || ''}`);
  const images = [];
  for (const p of j.post_list || []) {
    const postText = (p.content || []).filter(f => f.type === 0).map(f => f.text || '').join('\n').trim();
    let ctx = '';
    let since = '';
    for (const f of p.content || []) {
      if (f.type === 0) { ctx += (f.text || '') + ' '; since += (f.text || '') + '\n'; }
      if (f.type === 3 && f.src) {
        images.push({
          src: normTiebaImg(f.src), bsize: f.bsize || '', floor: p.floor || 0, pid: p.id || '',
          context: ctx.slice(-300), nearText: since.slice(-260), postText,
        });
        since = '';
      }
    }
  }
  images.sort((a, b) => a.floor - b.floor);
  if (!images.length) throw new Error('帖子里没有图片');
  // 帖子常用「图1: 场照 / 图6: 冠军 烙印」标图;按图片顺序把标签贴上,选图时能排除场照
  const allText = (j.post_list || []).map(p => (p.content || []).filter(f => f.type === 0).map(f => f.text || '').join('\n')).join('\n');
  const labels = [];
  const lre = /图\s*(\d+)\s*[:：]\s*([^\n图]{0,80})/g;
  let lm;
  while ((lm = lre.exec(allText))) labels[Number(lm[1])] = lm[2].trim();
  images.forEach((im, i) => { im.label = labels[i + 1] || ''; });
  writeJsonAtomic(file, { v: 4, at: Date.now(), title: j.thread?.title || '', images });
  return images;
}

/** 贴吧原图常有 1.5~3MB,OneBot 走 base64 发图会 fetch failed;超过约 1.2MB 就压到 1200px JPEG */
async function shrinkImage(buf, mime) {
  if (buf.length <= 1.2 * 1024 * 1024) return { buf, mime };
  mkdirSync(POST_DIR, { recursive: true });
  const stamp = `${process.pid}_${Date.now()}`;
  const inPath = join(POST_DIR, `src_${stamp}.img`);
  const outPath = join(POST_DIR, `out_${stamp}.jpg`);
  try {
    writeFileSync(inPath, buf);
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inPath,
      '-vf', 'scale=1200:-2:force_original_aspect_ratio=decrease',
      '-q:v', '4', '-frames:v', '1', outPath,
    ];
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('ffmpeg 超时')); }, 30000);
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
    });
    if (existsSync(outPath)) {
      const out = readFileSync(outPath);
      if (out.length > 2048 && out.length < buf.length) return { buf: out, mime: 'image/jpeg' };
    }
  } catch { /* 没 ffmpeg / 压缩失败就原图发,交给上层兜底 */ }
  finally {
    try { rmSync(inPath, { force: true }); } catch { /* ignore */ }
    try { rmSync(outPath, { force: true }); } catch { /* ignore */ }
  }
  return { buf, mime };
}

/** 下载贴吧原图(imgsrc 直链) */
export async function downloadTiebaImage(src) {
  const url = normTiebaImg(src);
  if (!url) throw new Error('图片地址为空');
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      Referer: 'https://tieba.baidu.com/',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  if (!r.ok) throw new Error(`图片 HTTP ${r.status}`);
  const mime = r.headers.get('content-type') || 'image/jpeg';
  if (!mime.startsWith('image/')) throw new Error(`图片类型不对:${mime}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2048) throw new Error(`图片太小(${buf.length} B)`);
  if (buf.length > 8 * 1024 * 1024) throw new Error(`图片太大(${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  return { ...(await shrinkImage(buf, mime)), url };
}

/** 解析识图模型返回的严格 JSON;解析不了返回 null(交给旧启发式兜底) */
function parseVisionVerdict(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = raw.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  let o = null;
  if (m) { try { o = JSON.parse(m[0]); } catch { o = null; } }
  if (!o) return null;
  const yes = v => v === true || /^(yes|true|是|1)$/i.test(String(v ?? '').trim());
  const no = v => v === false || /^(no|false|否|不是|0)$/i.test(String(v ?? '').trim());
  const isDeck = no(o.is_deck) ? false : yes(o.is_deck);
  const mr = String(o.matches ?? o.match ?? '').trim().toLowerCase();
  // 先判否定:中文「不是」里也含「是」,不能先看正关键词
  const match = /不是|不同|不匹配|否|(^|[\s"'])no|false/.test(mr) ? 'no'
    : /同一|匹配|(^|[\s"'])yes|true|^是/.test(mr) ? 'yes' : 'unsure';
  const confidence = Math.max(0, Math.min(100, Number(o.confidence) || 0));
  const deckName = String(o.deck_name || o.deck || '').trim().slice(0, 40);
  return { isDeck, deckName, match, confidence };
}

/**
 * 开放识图:不再只读图内文字,而是判断「这是不是构筑图」+「这套构筑是不是 primary」。
 * 能看卡图/卡名/主卡额外副卡布局;失败返回 null,由旧启发式兜底。
 */
async function inspectDeckImage(buf, primary) {
  const key = process.env.DEEPSEEK_API_KEY || process.env.AI_CHAT_API_KEY || '';
  if (!key) return null;
  try {
    const prep = await shrinkImage(buf, 'image/jpeg');
    const prompt = `你是游戏王 OCG 卡组构筑识别器。只判断这张图本身,不要猜。
任务:
1. 这张图是不是「卡组构筑图/卡表」?包括主卡组+额外+副卡的截图、实体卡摆拍、卡组清单。
   不是:环境饼图、比赛场照、合影、海报、奖品、聊天截图、单卡特写、二维码。
2. 如果是构筑图,根据图中卡名/卡图判断这套卡组的主轴/类型,并判断是否属于「${primary}」这个卡组(含混轴)。
   图上写了卡组名就以图上为准;没写就根据卡面判断。
3. 只输出严格 JSON,不要解释:
{"is_deck":true或false,"deck_name":"简短卡组名,没有就空字符串","matches":"yes"或"no"或"unsure","confidence":0到100}
matches 表示与「${primary}」是否同一套卡组;看不出填 "unsure"。`;
    const r = await fetch(process.env.AI_CHAT_API_URL || 'https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_CHAT_MODEL || 'deepseek-flash',
        reasoning_effort: 'none',
        max_tokens: 180,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${prep.mime};base64,${prep.buf.toString('base64')}` } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return null;
    return parseVisionVerdict(j?.choices?.[0]?.message?.content || '');
  } catch {
    return null;
  }
}

/**
 * 本地检索「以 primary 为主轴」的上位记录,按距目标时间由近到远尝试原帖图片。
 * 最多试 tries 个来源(用户要求一次问询最多重复 2 次检索)。
 */
export async function searchTopDeck(primary, range = null, opts = {}) {
  const {
    tries = Math.max(1, Number(process.env.YGOMETA_TOP_TRIES || 2)),
    log = () => {}, noImage = false, listLimit = 5,
  } = opts;
  if (!primary) return null;
  const collect = (store) => {
    const out = [];
    for (const t of Object.values(store.threads || {})) {
      if (!t?.entries?.length) continue;
      for (const e of t.entries) {
        if (e?.axes?.includes(primary)) out.push({ thread: t, entry: e, url: t.url || `https://tieba.baidu.com/p/${t.tid}` });
      }
    }
    return out;
  };
  let store = loadStore();
  let candidates = collect(store);
  const inRange = (c) => !range || (c.thread.create * 1000 >= range.start && c.thread.create * 1000 < range.end);
  if (range && !candidates.some(inRange)) {
    // 本地没有该时段的帖子 → 先按环境同一条抓取链补数据(补完再本地检索)
    log(`  本地没有「${primary}」在 ${range.label} 的记录,先抓取 ...`);
    try { await buildMetaPie(range, { log }); } catch (e) { log(`  抓取失败,继续用本地旧数据:${e.message}`); }
    store = loadStore();
    candidates = collect(store);
  }
  if (!candidates.length) return null;

  const target = range ? range.end - DAY : Date.now();
  const roleRank = r => ({ 冠军: 0, 亚军: 1, 四强: 2, 八强: 3, 十六强: 4, 三位: 5, 四位: 6, 上位: 9 }[r] ?? 8);
  const eventTs = c => Date.parse(`${eventDateFromTitle(c.thread.title, c.thread.create)}T00:00:00`);
  const within = range ? candidates.filter(inRange) : candidates;
  const pool = (within.length ? within : candidates).slice().sort((a, b) => {
    const da = Math.abs(eventTs(a) - target);
    const db = Math.abs(eventTs(b) - target);
    return da - db || roleRank(a.entry.role) - roleRank(b.entry.role) || b.thread.create - a.thread.create;
  });
  // 同一帖子多个名次只保留最靠前的一条,5 条列表要是 5 场不同的比赛
  const seenTid = new Set();
  const uniqPool = pool.filter(c => {
    if (seenTid.has(c.thread.tid)) return false;
    seenTid.add(c.thread.tid);
    return true;
  });
  const list = uniqPool.slice(0, Math.max(1, listLimit)).map(c => ({
    tid: c.thread.tid,
    entryName: c.entry.name,
    role: c.entry.role,
    date: eventDateFromTitle(c.thread.title, c.thread.create),
    deck: c.entry.name,
    title: cleanText(c.thread.title || ''),
    url: c.url,
  }));

  // 网页版只取链接列表,不抓图(省内存/时间)
  if (noImage) {
    return { ...uniqPool[0], image: null, attempts: 0, target, list };
  }

  let attempts = 0;
  const seen = new Set();
  for (const c of uniqPool) {
    if (attempts >= tries) break;
    const key = `${c.thread.tid}:${c.entry.name}:${c.entry.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attempts++;
    try {
      const imgs = await fetchThreadPostImages(c.thread.tid, { log });
      const threadText = `${c.thread.title || ''} ${c.thread.text || ''}`;
      let ranked = imgs
        .map((im, idx) => ({ im, score: scoreDeckImage(im, primary, threadText) - idx * 3 }))
        .sort((a, b) => b.score - a.score);
      // 帖子有「图N: ...」图注时,只认图注里真的提到该卡组的图;
      // 图注只有「场照 / 八强上位 / 环境分布」而没有该卡组 → 整帖跳过,换下一个来源。
      const visionOn = !!(process.env.DEEPSEEK_API_KEY || process.env.AI_CHAT_API_KEY);
      const labeled = ranked.filter(x => x.im.label);
      if (labeled.length) {
        const exact = ranked.filter(x => x.im.label && parseDeckAxes(x.im.label).axes.includes(primary));
        if (!exact.length) {
          log(`  图注里没有「${primary}」,换下一个来源 ...`);
          continue;
        }
        ranked = exact;
      } else {
        // 没「图N」标签时,看图片紧邻的正文(图注/段落):附近出现该卡组且不是饼图/场照
        const nearHits = ranked.filter(x => {
          const near = String(x.im.nearText || '');
          if (!near || !parseDeckAxes(near).axes.includes(primary)) return false;
          if (/饼图|分布|场照|环境|店|token|海报|合影|奖品|场地|活动|现场|裁判/i.test(near)) return false;
          // 一段话里列了多个名次 = 是整帖名单,不是这一张图的图注,不能拿第一张硬配
          const roles = (near.match(/冠军|亚军|四强|八强|十六强/g) || []).length;
          if (roles > 1 || /以下图片|按顺序|图片对应|名单[:：]/i.test(near)) return false;
          return true;
        });
        // 不再因为「多图/没有图注」直接放弃;交给识图逐张判断是不是对应构筑
        if (nearHits.length) ranked = nearHits;
      }
      const prepared = [];
      const maxPrep = visionOn ? 4 : 1;
      for (const { im } of ranked.slice(0, 6)) {
        if (im.label && !(primary && im.label.includes(primary))
          && /场照|环境|店|token|海报|合影|奖品|场地|活动|现场|裁判/i.test(im.label)) {
          log(`  跳过非卡组图:${im.label.slice(0, 30)} ...`);
          continue;
        }
        try {
          const image = await downloadTiebaImage(im.src);
          const check = looksLikeDeckImage(image.buf);
          if (!check.ok) {
            log(`  图片不像卡组(${check.why}),跳过 ...`);
            continue;
          }
          prepared.push({ im, image });
          if (prepared.length >= maxPrep) break;
        } catch (e) {
          log(`  图 ${im.src.slice(-40)} 下载失败:${e.message}`);
        }
      }
      if (!prepared.length) {
        log(`  帖 ${c.thread.tid} 没有可用图片,换下一个 ...`);
        continue;
      }
      if (visionOn) {
        const inspected = [];
        for (const x of prepared) {
          const v = await inspectDeckImage(x.image.buf, primary);
          inspected.push({ ...x, v });
          if (v) {
            log(`  识图 ${x.im.label || x.im.src.slice(-28)}: deck=${v.isDeck ? 'Y' : 'N'} match=${v.match} conf=${v.confidence}${v.deckName ? ` name=${v.deckName}` : ''}`);
          } else {
            log(`  识图失败 ${x.im.label || x.im.src.slice(-28)}`);
          }
        }
        const got = inspected.filter(x => x.v);
        if (!got.length) {
          log(`  识图接口不可用,不发图,换下一个来源 ...`);
          continue;
        }
        const contextHit = x => {
          const s = `${x.im.label || ''} ${x.im.nearText || ''} ${x.im.postText || ''} ${threadText}`;
          return s.includes(primary) || parseDeckAxes(s).axes.includes(primary);
        };
        const usable = got
          .filter(x => x.v.isDeck && x.v.match !== 'no'
            && (x.v.match === 'yes' || x.v.confidence >= 65 || contextHit(x)))
          .sort((a, b) => (a.v.match === 'yes' ? 0 : 1) - (b.v.match === 'yes' ? 0 : 1)
            || b.v.confidence - a.v.confidence);
        if (!usable.length) {
          log(`  识图判断都不是「${primary}」构筑,换下一个来源 ...`);
          continue;
        }
        const hit = usable[0];
        log(`  选构筑图:${hit.im.label || hit.im.src.slice(-28)} (${hit.v.deckName || primary})`);
        return {
          ...c, image: hit.image, attempts, target, list,
          eventDate: eventDateFromTitle(c.thread.title, c.thread.create),
        };
      }
      return {
        ...c, image: prepared[0].image, attempts, target, list,
        eventDate: eventDateFromTitle(c.thread.title, c.thread.create),
      };
    } catch (e) {
      log(`  帖 ${c.thread.tid} 抓取失败:${e.message}`);
    }
  }
  // 没找到可信的构筑图:退回最近来源的文字信息,不发图(用户允许)
  const fallback = uniqPool[0];
  if (!fallback) return null;
  return { ...fallback, image: null, attempts, target, list, eventDate: eventDateFromTitle(fallback.thread.title, fallback.thread.create) };
}

/** 给 monitor 用:图片消息段(base64,不依赖 SnowLuma 读本地路径) */
export function metaImageSegment(pngPath) {
  return { type: 'image', data: { file: `base64://${readFileSync(pngPath).toString('base64')}` } };
}

/**
 * 自检:把 threads.json 里提取到的卡组字段拿去本地百鸽卡库搜,同一条卡(同 id)的字段
 * 很可能是同一套卡组的不同译名(例:味美喵 / 黯蜜)。只报告,不自动改,确认后进 RULES。
 * 官方简中名优先取百鸽 sc_name。
 */
/**
 * 字段同卡异名审计。抓取更新完 threads.json 后跑一次,不参与每次查询。
 * @returns {{pending:number, normalized:number}}
 */
async function auditDeckAliases(store, { print = false, log = () => {} } = {}) {
  const { searchCards } = await import('../ygocard/ygocard.mjs');
  const counts = new Map();
  for (const t of Object.values(store.threads || {})) {
    for (const e of t.entries || []) {
      for (const a of e.axes || []) counts.set(a, (counts.get(a) || 0) + 1);
    }
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
  const groups = new Map();
  for (const [field, count] of rows) {
    let hits = [];
    try { hits = searchCards(field, 3); } catch (e) { log(`  别名自检搜索「${field}」失败:${e.message}`); continue; }
    const top = hits[0];
    if (!top?.id) continue;
    if (!groups.has(top.id)) groups.set(top.id, { card: top.sc_name || top.cn_name || top.jp_name || field, items: [] });
    groups.get(top.id).items.push({ field, count });
  }
  let pending = 0, normalized = 0;
  const lines = [];
  // 已知别名回归:百鸽里必须仍指向同一张卡
  const knownPairs = [['味美喵', '黯蜜'], ['魔镌', '刻魔']];
  let knownOk = 0;
  for (const [a, b] of knownPairs) {
    try {
      const ia = searchCards(a, 1)[0]?.id;
      const ib = searchCards(b, 1)[0]?.id;
      if (ia && ia === ib) knownOk++;
      else log(`  ⚠ 别名回归失败:${a} / ${b} 在百鸽里不是同一张卡`);
    } catch { /* 卡库不可用就不拦 */ }
  }
  lines.push(`已知别名回归:${knownOk}/${knownPairs.length}(味美喵/黯密→黯蜜,魔镌→刻魔)`);
  lines.push('');
  for (const [id, g] of groups) {
    if (g.items.length < 2) continue;
    const items = g.items.map(x => ({ ...x, canon: parseDeckAxes(x.field).axes[0] || x.field }));
    const same = new Set(items.map(x => x.canon)).size === 1;
    const official = items.find(x => String(g.card).includes(x.field))
      || items.find(x => String(g.card).includes(x.canon));
    if (same) normalized++; else pending++;
    lines.push(`同卡候选 #${id} ${g.card} ${same ? '[已归一]' : '[待确认]'}:`);
    for (const x of items) lines.push(`  ${x.field}  ${x.count}${x.canon !== x.field ? ` → ${x.canon}` : ''}`);
    lines.push(`  官方简中候选:${official?.field || '?'}`);
    lines.push('');
    if (!same) log(`  ⚠ 字段别名待确认:${items.map(x => x.field).join(' / ')} → 同卡 ${g.card}`);
    else if (official && official.canon !== official.field) log(`  ⚠ 建议改用官方简中:${official.field}(${g.card})`);
  }
  const summary = `共 ${pending} 组待确认,${normalized} 组已归一。确认后把别名并进 RULES。`;
  if (print) {
    console.log(`\n${lines.join('\n')}${summary}`);
  } else if (pending) {
    log(`  别名自检:${summary}`);
  }
  try { writeFileSync(join(CACHE_DIR, 'alias_report.txt'), `${lines.join('\n')}${summary}\n`, 'utf8'); } catch { /* ignore */ }
  return { pending, normalized };
}

async function deckAliasCheck() {
  // 用原始 threads.json(loadStore 会按 PARSE_VERSION 重解析,把已归一字段提前吃掉)
  const store = readJson(THREADS_FILE, { threads: {} }) || { threads: {} };
  await auditDeckAliases(store, { print: true });
  process.exitCode = 0;
}

export function metaCacheDir() { return CACHE_DIR; }

/** 网页自动补全用:当前记录库里出现过的轴,按次数降序 */
export function listDeckAxes(limit = 300) {
  const store = loadStore();
  const counts = new Map();
  for (const t of Object.values(store.threads || {})) {
    for (const e of t.entries || []) {
      for (const a of e.axes || []) counts.set(a, (counts.get(a) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, Math.max(1, limit))
    .map(([name, count]) => ({ name, count }));
}

// 兼容 self-test 里直接构造区间
function rangeFromDates(startStr, endStr) {
  const a = parseDateToken(startStr);
  const b = parseDateToken(endStr, { defaultYear: a?.y });
  if (!a || !b) return null;
  let sd = new Date(a.y, a.m - 1, a.d);
  let ed = new Date(b.y, b.m - 1, b.d);
  if (ed < sd) ed = new Date(b.y + 1, b.m - 1, b.d);
  return makeRange(sd, ed, { kind: 'range', explicit: true });
}

// =====================================================================================
// 自测 / CLI
// =====================================================================================

export async function metaSelftest() {
  const lines = [];
  let bad = 0;
  const ok = (c, m, extra = '') => { if (!c) bad++; lines.push(`${c ? '✓' : '✗'} ${m}${extra ? ` — ${extra}` : ''}`); };
  const now = new Date(2026, 9, 26, 17, 0, 0);   // 2026-10-26 17:00(本地)

  // ① 时间段
  const r1 = parseMetaRange('', now);
  ok(!!r1 && r1.days === 7, '空 = 近 7 天', r1 && r1.label);
  const r2 = parseMetaRange('近三天', now);
  ok(!!r2 && r2.days === 3, '近三天', r2 && r2.label);
  const r3 = parseMetaRange('10月', now);
  ok(!!r3 && r3.startDate.getMonth() === 9 && r3.startDate.getDate() === 1, '10月 = 10/1 起', r3 && r3.label);
  const r4 = parseMetaRange('2026-09', now);
  ok(!!r4 && r4.startDate.getMonth() === 8 && r4.endDate.getMonth() === 8, '2026-09 = 整月', r4 && r4.label);
  const r5 = parseMetaRange('9.1-9.15', now);
  ok(!!r5 && r5.startDate.getDate() === 1 && r5.endDate.getDate() === 15, '9.1-9.15', r5 && r5.label);
  const r6 = parseMetaRange('上周', now);
  ok(!!r6 && r6.startDate.getDay() === 1 && r6.endDate.getDay() === 0, '上周 = 周一到周日', r6 && r6.label);
  ok(parseMetaRange('环境怎么样', now) === null, '看不懂的时间段返回 null');
  ok(parseMetaRange('10月1日到10月7日', now)?.days === 7, '10月1日到10月7日 = 7 天');

  // ② 触发词
  const t1 = parseMetaTrigger('近期环境', now);
  ok(!!t1 && t1.range.days === 7, '「近期环境」触发');
  const t2 = parseMetaTrigger('环境 10月', now);
  ok(!!t2 && t2.range.startDate.getMonth() === 9, '「环境 10月」触发');
  const t3 = parseMetaTrigger('环境怎么样', now);
  ok(t3 === null, '「环境怎么样」不触发(交给 AI 闲聊)');
  const t4 = parseMetaTrigger('@测试bot.fd 环境 9.1-9.15', now);
  ok(!!t4 && t4.range.startDate.getDate() === 1, '带 @ 前缀也能触发');
  const t5 = parseMetaTrigger('游戏王环境', now);
  ok(!!t5, '「游戏王环境」触发');
  const t6 = parseMetaTrigger('环境 10月 pdf', now);
  ok(!!t6 && t6.pdf === true && t6.range.startDate.getMonth() === 9, '「环境 10月 pdf」触发且识别 PDF');
  const t7 = parseMetaTrigger('近期环境 PDF版', now);
  ok(!!t7 && t7.pdf === true, '「近期环境 PDF版」识别 PDF');
  ok(parseMetaTrigger('环境 10月', now)?.pdf === false, '不带 pdf 参数时仍是图片');
  const s1 = parseTopSearch('上位 烙印 10月', now);
  ok(!!s1 && s1.primary === '烙印' && s1.range?.startDate.getMonth() === 9, '「上位 烙印 10月」解析');
  const s2 = parseTopSearch('上位 K9 10月', now);
  ok(!!s2 && s2.primary === 'K9' && !s2.error, '「上位 K9 10月」解析');
  const s3 = parseTopSearch('上位卡组 烙印', now);
  ok(!!s3 && s3.primary === '烙印' && !s3.range, '「上位卡组 烙印」无时间解析');
  const s4 = parseTopSearch('上位 震灵 9月', now);
  ok(!!s4?.error && s4.error.includes('震灵') && !s4.primary, '不认识的卡组返回错误而不是 null', JSON.stringify(s4));
  ok(parseTopSearch('环境 10月', now) === null, '「环境」不触发上位检索');

  // ③ 卡组归一化
  const cases = [
    ['魔∀丽丝', '码丽丝'], ['码丽斯', '码丽丝'], ['杀旋', '杀手旋律'],
    ['雷火剑', '雷火沸动'], ['黑魔术光与暗', '光与暗的仪式'], ['鑫宇狱神奥艺', '狱神奥艺'],
    ['D.D.炸药一回杀', 'D.D.炸药'], ['闪刀', '闪刀姬'], ['60烙印', '烙印'],
    ['加辉瑞月', '盈彩月夜'], ['加瑞辉月', '盈彩月夜'], ['升月', '盈彩月夜'], ['盈彩月夜', '盈彩月夜'],
  ];
  for (const [raw, want] of cases) ok(canonicalDeck(raw).name === want, `归一化「${raw}」→ ${want}`, canonicalDeck(raw).name);

  // ④ 榜单 vs 个人战报
  const a = analyzeThread({
    title: '乌鲁木齐小决斗王杯2026年10月24日43人比赛战报',
    text: '冠军：康康，使用卡组：奥义狱神神艺\n亚军：Tikva，使用卡组：拟声霍普\n四强：双穹，使用卡组：升月\n四强：光之惩戒英卡洛斯，使用卡组：升月',
  });
  ok(a.map(x => x.name).join(',') === '奥艺狱神神艺,霍普,盈彩月夜,盈彩月夜', '榜单型:逐条取卡组', a.map(x => x.name).join(','));
  // 混轴:一个卡组名要拆出多个轴(不是只取第一个词)
  const ax1 = parseDeckAxes('烙印光与暗');
  ok(ax1.axes.join('|') === '烙印|光与暗的仪式', '混轴拆解:烙印光与暗', ax1.axes.join('+'));
  const ax2 = parseDeckAxes('狱神艺术耀圣');
  ok(ax2.axes.join('|') === '狱神|奥艺|耀圣', '混轴拆解:狱神艺术耀圣', ax2.axes.join('+'));
  const ax3 = parseDeckAxes('刻魔破械');
  ok(ax3.axes.join('|') === '刻魔|破械', '混轴拆解:刻魔破械', ax3.axes.join('+'));
  ok(parseDeckAxes('味美喵').axes.join('|') === '黯蜜', '别名归一:味美喵 → 黯蜜');
  ok(parseDeckAxes('黯蜜').axes.join('|') === '黯蜜', '别名归一:黯蜜', parseDeckAxes('黯蜜').axes.join('+|'));
  ok(parseDeckAxes('魔镌').axes.join('|') === '刻魔', '别名归一:魔镌 → 刻魔');
  ok(parseDeckAxes('磁石战士').axes.join('|') === '磁石战士', '磁石战士轴');
  ok(parseDeckAxes('磁石魔救').axes.includes('磁石战士'), '磁石魔救识别为磁石战士', parseDeckAxes('磁石魔救').axes.join('+'));
  ok(parseDeckAxes('混沌黑魔导').axes.join('|') === '光与暗的仪式|黑魔导', '混沌=光与暗, 黑魔导=黑魔术师', parseDeckAxes('混沌黑魔导').axes.join('+'));
  ok(parseDeckAxes('雷盟').axes.join('|') === '雷盟', '雷盟轴');
  ok(parseDeckAxes('幕帘猫').axes.join('|') === '黯蜜|黑魔导', '幕帘猫=黯蜜主卡+黑魔导副轴', parseDeckAxes('幕帘猫').axes.join('+'));
  ok(parseDeckAxes('车车FTK').axes.includes('列车'), '车车=列车', parseDeckAxes('车车FTK').axes.join('+'));
  ok(parseDeckAxes('召唤兽阿莱斯特').axes.includes('召唤兽'), '召唤兽轴');
  ok(parseDeckAxes('朱罗纪炎王').axes.join('|') === '朱罗纪|炎王', '朱罗纪/炎王拆轴', parseDeckAxes('朱罗纪炎王').axes.join('+'));
  ok(parseDeckAxes('地中族').axes.includes('地中骇界') && parseDeckAxes('翼神龙').axes.includes('翼神龙'), '地中族/翼神龙轴');
  const k1 = eventTitleKey('10.18 共青咕咕屋24人迎新杯亚军');
  const k2 = eventTitleKey('10.18 【共青】咕咕屋迎新杯24人');
  ok(sameEventKey(k1, k2), '同场不同战报标题可归并', `${k1} / ${k2}`);
  const agg = aggregate([
    { title: '10.18 共青咕咕屋24人迎新杯亚军', create: 1792000000, entries: [{ role: '亚军', name: '教导', axes: ['教导'] }] },
    { title: '10.18 【共青】咕咕屋迎新杯24人', create: 1792000000, entries: [
      { role: '亚军', name: '教导', axes: ['教导'] },
      { role: '八强', name: '烙印', axes: ['烙印'] },
    ] },
  ]);
  ok(agg.posts === 1 && agg.entries === 2, '同场个人战报+完整战报不重复计样本', JSON.stringify({ posts: agg.posts, entries: agg.entries }));
  const agg2 = aggregate([
    { title: '10.20 A赛 原石白龙', create: 1792000000, entries: [{ role: '冠军', name: '原石白龙', axes: ['原石', '白龙'] }] },
    { title: '10.21 B赛 原石白龙', create: 1792100000, entries: [{ role: '冠军', name: '原石白龙', axes: ['原石', '白龙'] }] },
    { title: '10.22 C赛 白龙', create: 1792200000, entries: [{ role: '冠军', name: '白龙', axes: ['白龙'] }] },
  ]);
  const white = agg2.list.find(x => x.name === '白龙');
  ok(white?.num === 3 && white.pure === 1 && white.buckets.some(b => b.name === '原石' && b.count === 2) && !agg2.list.some(x => x.name === '原石'),
    '混轴按全局主轴承组:原石白龙2+白龙1 → 白龙3', JSON.stringify(agg2.list));
  const agg3 = aggregate([
    { title: '10.20 伟魔教导', create: 1792000000, entries: [{ role: '冠军', name: '伟魔教导', axes: ['伟魔', '教导'] }] },
    { title: '10.21 伟魔教导', create: 1792100000, entries: [{ role: '冠军', name: '伟魔教导', axes: ['伟魔', '教导'] }] },
    { title: '10.22 教导', create: 1792200000, entries: [{ role: '冠军', name: '教导', axes: ['教导'] }] },
  ]);
  ok(agg3.list.find(x => x.name === '教导')?.num === 3 && !agg3.list.some(x => x.name === '伟魔'), '混轴不拆成两个主轴:伟魔教导 + 教导 → 教导3', JSON.stringify(agg3.list));
  const mag = analyzeThread({
    title: '10.17简中沈阳巡回赛',
    text: '10.17简中沈阳巡回赛\n使用卡组:磁石战士\n使用id:顺飞马\n135人7轮出16 亚军\nr1 输骰升月 oo',
  });
  ok(mag.length === 1 && mag[0].name === '磁石战士' && mag[0].role === '亚军', '磁石战士单卡组战报按正文亚军', mag.map(x => `${x.role}:${x.name}`).join(','));
  const dist = analyzeThread({
    title: '韩山师范学院游戏王迎新吾悦杯圆满结束',
    text: '参赛人数：18人\n冠军：erAir（杀手旋律）\n亚军：xtqhy（奥艺耀圣）\n四强：星焱（水机列车）\n四强：清与悲（妖精魔女术）\n卡组分布：杀手旋律1奥艺耀圣2狱神奥艺1烙印3三幻魔1幕帘猫1刻魔魔弹1闪刀160朋克巳剑1升月154混沌绚岚闪刀1水机列车1皇国妖精魔女术1星辰烙印1磁石战士魔救1\n上位卡组如下：',
  });
  ok(dist.length === 4 && dist.map(x => x.name).join(',') === '杀手旋律,奥艺耀圣,列车,魔女术', '卡组分布不被当成一套卡组', dist.map(x => `${x.role}:${x.name}`).join(','));
  const b = analyzeThread({
    title: '栖风营地卡牌12人冠军',
    text: '使用卡组：D.D.炸药\n第一轮 对战升月白银城 输骰 oo\n四强 对战升月 赢骰 oo\n决赛 对战归光黑魔女黑魔导 输骰 oo',
  });
  ok(b.length === 1 && b[0].name === 'D.D.炸药', '个人战报:只取作者自己的卡组', b.map(x => x.name).join(','));
  const c = analyzeThread({
    title: '广东海洋大学阳江校区第三届新星杯',
    text: '参与人数 16人\n卡组分布：莫忘x2，白鸦白森，幻影骑士团，雷火剑\n冠 炎兽 亚 炫岚 四强 莫忘 白森',
  });
  ok(c.map(x => x.name).join(',') === '转生炎兽,绚岚,莫忘,白森', '单字冠/亚 + 四强 两个卡组', c.map(x => x.name).join(','));
  const d = analyzeThread({
    title: '10.25超忆卡牌积分赛冠军命运英雄 21人',
    text: '第一轮轮空第二轮对战60烙印OXO第三轮对战道化光与暗仪式OO第四轮直接点负休息了八强对战星辰烙印XOO四强对战奥义耀圣OXO决赛投骰子胜',
  });
  ok(d.length === 1 && d[0].name === '命运英雄', '标题名次+卡组,正文对战记录不算', d.map(x => x.name).join(','));
  const e = analyzeThread({
    title: '10.26 成都XX店赛 21人 烙印 亚军',
    text: '使用卡组：烙印\n第一轮 对战升月 输骰 oo\n四强 对战刻魔 赢骰 oo',
  });
  ok(e.length === 1 && e[0].name === '烙印' && e[0].role === '亚军', '标题写亚军不能因为只有一个卡组就记冠军', e.map(x => `${x.role}:${x.name}`).join(','));
  const f = analyzeThread({
    title: '10.26 成都XX店赛 21人 烙印 冠军',
    text: '使用卡组：烙印\n第一轮 对战升月 输骰 oo',
  });
  ok(f.length === 1 && f[0].name === '烙印' && f[0].role === '冠军', '标题写冠军仍记冠军', f.map(x => `${x.role}:${x.name}`).join(','));
  const g = analyzeThread({
    title: '10.26 成都XX店赛 21人 使用卡组：烙印 亚军',
    text: '第一轮 对战升月 输骰 oo',
  });
  ok(g.length === 1 && g[0].name === '烙印' && g[0].role === '亚军', '标题同时有使用卡组和亚军', g.map(x => `${x.role}:${x.name}`).join(','));
  const v1 = parseVisionVerdict('```json\n{"is_deck":true,"deck_name":"烙印","matches":"yes","confidence":88}\n```');
  ok(v1?.isDeck && v1.match === 'yes' && v1.deckName === '烙印', '识图判定:构筑图且匹配', JSON.stringify(v1));
  const v2 = parseVisionVerdict('{"is_deck":false,"deck_name":"","matches":"no","confidence":95}');
  ok(v2?.isDeck === false && v2.match === 'no', '识图判定:不是构筑图', JSON.stringify(v2));
  const v3 = parseVisionVerdict('{"is_deck":true,"deck_name":"闪刀姬","matches":"不是","confidence":90}');
  ok(v3?.match === 'no', '识图判定:不是同一卡组(中文否定)', JSON.stringify(v3));
  const v4 = parseVisionVerdict('{"is_deck":true,"deck_name":"闪刀姬","matches":false,"confidence":90}');
  ok(v4?.match === 'no', '识图判定:布尔 false 也是不匹配', JSON.stringify(v4));

  console.log(lines.join('\n'));
  console.log(`\n${lines.length - bad}/${lines.length} 通过`);
  if (!bad) console.log(`缓存目录:${CACHE_DIR}(自测不联网、不写缓存)`);
  process.exitCode = bad ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    await metaSelftest();
  } else if (args.includes('--trigger')) {
    const i = args.indexOf('--trigger');
    const text = args.slice(i + 1).join(' ').trim();
    const r = parseMetaTrigger(text);
    console.log(r ? `触发:${r.trigger} | ${r.range.label} | ${r.range.desc} | key=${r.range.key}` : '不触发');
    process.exitCode = r ? 0 : 1;
  } else if (args.includes('--trigger-spec')) {
    const i = args.indexOf('--trigger-spec');
    const text = args.slice(i + 1).join(' ').trim();
    const r = parseMetaRange(text);
    console.log(r ? `${r.label} | ${r.desc} | key=${r.key} | start=${new Date(r.start).toISOString()} | end=${new Date(r.end).toISOString()}` : '无法解析');
    process.exitCode = r ? 0 : 1;
  } else if (args.includes('--deck-alias-check')) {
    await deckAliasCheck();
  } else if (args.includes('--top')) {
    const i = args.indexOf('--top');
    const rest = args.slice(i + 1);
    const outIdx = rest.indexOf('--out');
    const outPath = outIdx >= 0 ? rest[outIdx + 1] : undefined;
    const q = (outIdx >= 0 ? rest.filter((a, idx) => idx !== outIdx && idx !== outIdx + 1) : rest).join(' ').trim();
    const parsed = parseTopSearch(q);
    if (!parsed || parsed.error) {
      console.error(parsed?.error || '用法: node meta.mjs --top "上位 烙印 10月"');
      process.exitCode = 1;
    } else {
      try {
        const r = await searchTopDeck(parsed.primary, parsed.range, { log: m => console.log(m) });
        if (!r) { console.error('没抓取到构筑图'); process.exitCode = 1; }
        else {
          if (outPath && r.image) {
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, r.image.buf);
          }
          console.log(JSON.stringify({
            query: q, primary: parsed.primary, range: parsed.range?.label || null,
            date: r.eventDate || ymdDash(new Date(r.thread.create * 1000)),
            deck: r.entry.name, role: r.entry.role, title: cleanText(r.thread.title || ''),
            url: r.url, attempts: r.attempts,
            image: r.image ? (outPath || r.image.url) : null,
            bytes: r.image ? r.image.buf.length : 0,
            list: r.list || [],
          }, null, 2));
          process.exitCode = 0;
        }
      } catch (e) {
        console.error('检索失败:', e.stack || e.message);
        process.exitCode = 1;
      }
    }
  } else if (args.includes('--pdf')) {
    const rest = args.filter(a => !a.startsWith('--'));
    const startStr = rest[0], endStr = rest[1];
    if (!startStr || !endStr) {
      console.error('用法: node meta.mjs --pdf 2026-10-01 2026-10-26 [--out tmp.pdf] [--force]');
      process.exitCode = 1;
    } else {
      const range = rangeFromDates(startStr, endStr);
      if (!range) { console.error('日期格式不对,要 YYYY-MM-DD'); process.exitCode = 1; }
      else {
        const outIdx = args.indexOf('--out');
        const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
        const force = args.includes('--force');
        try {
          const r = await buildMetaPdf(range, { force, log: m => console.log(m) });
          if (outPath) {
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, readFileSync(r.pdfPath));
          }
          console.log(JSON.stringify({
            range: { label: range.label, desc: range.desc, key: range.key },
            posts: r.stats.posts, entries: r.stats.entries, unique: r.stats.unique,
            cached: r.cached, truncated: r.truncated, records: r.records,
            pdf: outPath || r.pdfPath,
          }, null, 2));
          process.exitCode = 0;
        } catch (e) {
          console.error('PDF 生成失败:', e.stack || e.message);
          process.exitCode = 1;
        }
      }
    }
  } else if (args.includes('--chart') || args.includes('--crawl')) {
    const chartMode = args.includes('--chart');
    const rest = args.filter(a => !a.startsWith('--'));
    const startStr = rest[0], endStr = rest[1];
    if (!startStr || !endStr) {
      console.error('用法: node meta.mjs --chart 2026-10-01 2026-10-26 [--out tmp.png] [--force]');
      process.exitCode = 1;
    } else {
      const range = rangeFromDates(startStr, endStr);
      if (!range) { console.error('日期格式不对,要 YYYY-MM-DD'); process.exitCode = 1; }
      else {
        const outIdx = args.indexOf('--out');
        const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
        const force = args.includes('--force');
        try {
          const r = await buildMetaPie(range, { force, log: m => console.log(m) });
          if (chartMode) {
            if (outPath) {
              mkdirSync(dirname(outPath), { recursive: true });
              writeFileSync(outPath, readFileSync(r.pngPath));
            }
          }
          console.log(JSON.stringify({
            range: { label: range.label, desc: range.desc, key: range.key },
            posts: r.stats.posts, entries: r.stats.entries, unique: r.stats.unique,
            cached: r.cached, truncated: r.truncated,
            png: outPath || r.pngPath,
            top: r.stats.list.slice(0, 15),
          }, null, 2));
          process.exitCode = 0;
        } catch (e) {
          console.error('生成失败:', e.stack || e.message);
          process.exitCode = 1;
        }
      }
    }
  } else {
    console.log('用法:');
    console.log('  node agent/ygometa/meta.mjs --selftest');
    console.log('  node agent/ygometa/meta.mjs --trigger "环境 10月"');
    console.log('  node agent/ygometa/meta.mjs --trigger-spec "9.1-9.15"');
    console.log('  node agent/ygometa/meta.mjs --crawl 2026-10-01 2026-10-26');
    console.log('  node agent/ygometa/meta.mjs --chart 2026-10-01 2026-10-26 [--out tmp.png] [--force]');
    console.log('  node agent/ygometa/meta.mjs --pdf 2026-10-01 2026-10-26 [--out tmp.pdf] [--force]');
    console.log('  node agent/ygometa/meta.mjs --top "上位 烙印 10月" [--out tmp.jpg]');
    console.log('  node agent/ygometa/meta.mjs --deck-alias-check   # 查同卡异名(如 味美喵/黯蜜)');
  }
}
