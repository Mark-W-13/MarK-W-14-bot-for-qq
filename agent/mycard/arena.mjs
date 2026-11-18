// MC(MyCard / 萌卡)天梯查询:绑定、月战绩、分数曲线图。
//
// 数据源是 MC 官方竞技场接口 `/ygopro/arena`:
//   /user?username=...                         当前 exp / pt / 排名 / 总场次
//   /history?username=...&type=1&page=...      天梯(athletic)对局,含每局前后的 pta/ptb
//
// 线上机器在国内,`mycard.moe` 的 DNS/SNI 会被污染,直连拿不到数据;官方另一个入口
// `api.moecube.com` 是同一套接口(萌卡/MoeCube 同源),可用且稳定,所以默认走它。
// 需要改回别的官方入口时设 `MYCARD_ARENA_API` 即可。
import '../env.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { chromePath } from '../env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = (process.env.MYCARD_ARENA_API || 'https://api.moecube.com/ygopro/arena').replace(/\/+$/, '');
const BINDINGS_PATH = process.env.MYCARD_BINDINGS_PATH || join(__dirname, 'bindings.json');
const TMP_DIR = join(__dirname, '..', 'tmp_pic');
const TZ_MS = 8 * 3600 * 1000;                 // MC 的「月」按北京时间算
const PAGE_SIZE = 200;
const MAX_PAGES = 40;                          // 防极端账号把接口翻穿
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------- 小工具 ----------
const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanText = text => String(text || '')
  .replace(/\[[a-z_]+(?::[^\]]*)?\]/gi, ' ')   // [at] / [image] / [face] 段占位符
  .replace(/\u3000/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function getJson(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json,text/plain,*/*',
        Referer: 'https://mycard.moe/',
      },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j || typeof j !== 'object') throw new Error('接口返回不是 JSON 对象');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 绑定 ----------
function loadBindings() {
  try {
    const j = JSON.parse(readFileSync(BINDINGS_PATH, 'utf8'));
    if (j && typeof j === 'object' && j.users && typeof j.users === 'object') return j;
    // 兼容最朴素的 {qq: username} 写法
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const users = {};
      for (const [qq, v] of Object.entries(j)) {
        if (typeof v === 'string' && v.trim()) users[qq] = { username: v.trim(), boundAt: 0 };
      }
      return { version: 1, users };
    }
  } catch { /* 文件不存在 / 坏了都当空 */ }
  return { version: 1, users: {} };
}

function saveBindings(j) {
  mkdirSync(dirname(BINDINGS_PATH), { recursive: true });
  const tmp = `${BINDINGS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
  renameSync(tmp, BINDINGS_PATH);
}

export function getBinding(qq) {
  const b = loadBindings().users[String(qq)];
  return b && typeof b.username === 'string' && b.username.trim()
    ? { username: b.username.trim(), boundAt: Number(b.boundAt) || 0 }
    : null;
}

export function setBinding(qq, username) {
  const j = loadBindings();
  j.version = 1;
  j.users[String(qq)] = { username: String(username).trim(), boundAt: Date.now() };
  saveBindings(j);
  return j.users[String(qq)];
}

export function bindingsPath() { return BINDINGS_PATH; }

// ---------- 接口 ----------
export async function fetchUser(username) {
  const j = await getJson(`${API_BASE}/user?username=${encodeURIComponent(username)}`);
  return {
    exp: num(j.exp),
    pt: num(j.pt),
    rank: num(j.arena_rank),
    athleticAll: num(j.athletic_all),
    athleticWin: num(j.athletic_win),
    athleticLose: num(j.athletic_lose),
    athleticDraw: num(j.athletic_draw),
    entertainAll: num(j.entertain_all),
  };
}

/**
 * 拉天梯历史(只 type=1)。monthStart 给定时,按时间倒序翻页,翻到本月之前就停。
 * @returns {Promise<{rows:object[], total:number}>}
 */
export async function fetchAthleticHistory(username, { monthStart = 0 } = {}) {
  const rows = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await getJson(`${API_BASE}/history?username=${encodeURIComponent(username)}&type=1&page=${page}&page_num=${PAGE_SIZE}`);
    const list = Array.isArray(j.data) ? j.data : [];
    total = Math.max(total, num(j.total));
    rows.push(...list);
    if (list.length < PAGE_SIZE) break;
    if (monthStart) {
      let oldest = Infinity;
      for (const r of list) {
        const t = Date.parse(r.start_time);
        if (Number.isFinite(t) && t < oldest) oldest = t;
      }
      if (oldest < monthStart) break;          // 已经翻到本月以前,不用再翻
    }
    if (total && rows.length >= total) break;
  }
  return { rows, total };
}

function isRealUser(u) {
  return !!u && (u.rank > 0 || u.athleticAll > 0 || u.entertainAll > 0 || u.exp > 0 || u.pt !== 1000);
}

// ---------- 指令解析 ----------
/**
 * 按「月」解析。支持:历史 / 历史 7月 / 7月历史 / 7月 历史 / 历史7月 /
 * 2026年7月历史 / 历史 2026-07 / 历史 7月 某用户名 / 历史 某用户名 7月。
 * @returns {null|{kind:'bind'|'history', username?:string, year?:number|null, month?:number|null, hadMonth?:boolean}|{kind:'history', error:string}}
 */
export function parseArenaCommand(text) {
  const t = cleanText(text);
  if (!t || !isArenaCommandText(t)) return null;

  let m = t.match(/^绑定(?:\s+|$)([\s\S]*)$/);
  if (m) return { kind: 'bind', username: m[1].trim() };

  if (!/历史/.test(t)) return null;

  let rest = '';
  let prefixTime = '';
  if (/^历史/.test(t)) {
    rest = t.replace(/^历史/, '').trim();
  } else {
    const fm = t.match(/^((?:\d{4}\s*[年./-]\s*)?\d{1,2}\s*月|\d{4}\s*[-/.]\s*\d{1,2})\s*历史\s*([\s\S]*)$/);
    if (!fm) return null;
    prefixTime = fm[1];
    rest = fm[2].trim();
  }

  const combined = [prefixTime, rest].filter(Boolean).join(' ').trim();
  let tm = combined.match(/(?:(\d{4})\s*[年./-]\s*)?(\d{1,2})\s*月/);
  if (!tm) tm = combined.match(/(\d{4})\s*[-/.]\s*(\d{1,2})(?!\d)/);

  let year = null;
  let month = null;
  let hadMonth = false;
  let username = combined;
  if (tm) {
    hadMonth = true;
    year = tm[1] ? Number(tm[1]) : null;
    month = Number(tm[2]);
    username = combined.replace(tm[0], ' ').replace(/\s+/g, ' ').trim();
  }

  if (hadMonth && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return { kind: 'history', error: '月份不对,应该是 1 到 12 月。' };
  }
  if (year != null && (!Number.isInteger(year) || year < 2010 || year > 2100)) {
    return { kind: 'history', error: '年份不对,应该在 2010 到 2100 之间。' };
  }

  return { kind: 'history', username, year, month, hadMonth };
}

/** 这条文本是不是 MC 指令(给 WS 层判断「不用 @ 也要收」)。 */
export function isArenaCommandText(text) {
  const t = cleanText(text);
  if (!t) return false;
  if (/^绑定(?:\s|$)/.test(t)) return true;
  if (/^历史(?:\s|$|\d)/.test(t)) return true;
  if (/^(?:\d{4}\s*[年./-]\s*)?\d{1,2}\s*月\s*历史/.test(t)) return true;
  if (/^\d{4}\s*[-/.]\s*\d{1,2}\s*历史/.test(t)) return true;
  return false;
}

// ---------- 月份 ----------
function nowBeijing() {
  return new Date(Date.now() + TZ_MS);
}

function resolveRange(cmd, now = nowBeijing()) {
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth() + 1;
  let year = Number.isInteger(cmd.year) ? cmd.year : curY;
  let month = Number.isInteger(cmd.month) ? cmd.month : curM;
  // 只说「7月」且当前是 1 月时,7 月只能是去年的(未来的月份没有数据)
  if (!cmd.year && cmd.month && month > curM) year -= 1;
  const start = Date.UTC(year, month - 1, 1) - TZ_MS;
  const end = Date.UTC(year, month, 1) - TZ_MS;
  const label = year === curY ? `${month}月` : `${year}年${month}月`;
  return { year, month, start, end, label, fullLabel: `${year}年${month}月`, current: year === curY && month === curM };
}

function monthRows(rows, username, range) {
  return rows
    .filter(r => {
      const t = Date.parse(r.start_time);
      return Number.isFinite(t) && t >= range.start && t < range.end;
    })
    .filter(r => String(r.usernamea) === username || String(r.usernameb) === username)
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

function outcomeOf(row, username) {
  const a = String(row.usernamea) === username;
  const b = String(row.usernameb) === username;
  if (!a && !b) return 'skip';
  if (row.winner) {
    if (String(row.winner) === username) return 'win';
    return 'lose';
  }
  const sa = num(row.userscorea);
  const sb = num(row.userscoreb);
  const us = a ? sa : sb;
  const them = a ? sb : sa;
  if (us > them) return 'win';
  if (us < them) return 'lose';
  return 'draw';
}

function ptOf(row, username, post = true) {
  const a = String(row.usernamea) === username;
  const key = a ? (post ? 'pta' : 'pta_ex') : (post ? 'ptb' : 'ptb_ex');
  const v = Number(row[key]);
  return Number.isFinite(v) ? v : null;
}

function statsFor(rows, username, range, user) {
  const list = monthRows(rows, username, range);
  let win = 0;
  let lose = 0;
  let draw = 0;
  for (const r of list) {
    const o = outcomeOf(r, username);
    if (o === 'win') win++;
    else if (o === 'lose') lose++;
    else if (o === 'draw') draw++;
  }
  const points = [];
  if (list.length) {
    const pre = ptOf(list[0], username, false);
    if (pre != null) points.push(pre);
    for (const r of list) {
      const v = ptOf(r, username, true);
      if (v != null) points.push(v);
    }
  }
  // 「当前分数」永远取所有对局里最新的一局,不能取所选月份的最后一局
  // (查 7 月时也要显示现在的 D.P.,不是 7 月底的 D.P.)。
  let currentPt = user.pt;
  if (rows.length) {
    const latest = ptOf(rows[0], username, true);
    if (latest != null) currentPt = latest;
  }
  const monthEndPt = points.length ? points[points.length - 1] : currentPt;
  return {
    list,
    total: list.length,
    win,
    lose,
    draw,
    rate: list.length ? (win / list.length) * 100 : 0,
    points,
    currentPt,
    monthEndPt,
    rank: user.rank,
  };
}

// ---------- 折线图(纯 SVG + 无头 Chrome 截图) ----------
function chartSvg(username, range, stats) {
  const W = 760;
  const H = 440;
  const L = 66;
  const R = 58;
  const T = 84;
  const B = 52;
  const pw = W - L - R;
  const ph = H - T - B;
  const pts = stats.points.length ? stats.points : [stats.currentPt];
  const n = pts.length;
  const dataLo = Math.min(...pts);
  const dataHi = Math.max(...pts);
  // 让刻度落在 100/50/20 这种整数上,而不是 1085、1195 这种算出来的怪值。
  const niceStep = x => {
    if (!(x > 0)) return 25;
    const p = 10 ** Math.floor(Math.log10(x));
    const q = x / p;
    return (q <= 1 ? 1 : q <= 2 ? 2 : q <= 2.5 ? 2.5 : q <= 5 ? 5 : 10) * p;
  };
  let step = niceStep((dataHi - dataLo) / 5.5);
  if (!(step >= 5)) step = 5;
  let lo = Math.floor((dataLo - step * 0.02) / step) * step;
  let hi = Math.ceil((dataHi + step * 0.02) / step) * step;
  if (hi <= lo) hi = lo + step * 5;
  const tickCount = Math.max(1, Math.round((hi - lo) / step));
  const xAt = i => (n <= 1 ? L + pw / 2 : L + (i / (n - 1)) * pw);
  const yAt = v => T + ph - ((v - lo) / (hi - lo)) * ph;

  const grid = [];
  for (let i = 0; i <= tickCount; i++) {
    const v = lo + step * i;
    const y = yAt(v);
    grid.push(`<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="#ececf3" stroke-width="1"/>`);
    grid.push(`<text x="${L - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#888899">${Math.round(v)}</text>`);
  }

  const xTicks = [];
  const seen = new Set();
  for (let i = 0; i <= 6; i++) {
    const idx = Math.round(((n - 1) * i) / 6);
    if (seen.has(idx)) continue;
    seen.add(idx);
    const x = xAt(idx);
    xTicks.push(`<line x1="${x.toFixed(1)}" y1="${T + ph}" x2="${x.toFixed(1)}" y2="${T + ph + 5}" stroke="#c9c9d6"/>`);
    xTicks.push(`<text x="${x.toFixed(1)}" y="${T + ph + 21}" text-anchor="middle" font-size="11" fill="#888899">${idx === 0 ? '起始' : idx}</text>`);
  }

  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  const dotR = n > 180 ? 1.7 : n > 90 ? 2.1 : 2.6;
  const dots = pts.map((v, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="${dotR}" fill="#4032b5" stroke="#fff" stroke-width="0.55"/>`).join('');
  const lastV = pts[n - 1];
  const lastX = xAt(n - 1);
  const lastY = yAt(lastV);
  const labelX = Math.min(W - R, Math.max(L + 10, lastX - 8));
  const labelY = Math.max(T + 12, lastY - 10);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:#fff}
svg{display:block;font-family:"Noto Sans CJK SC","Noto Sans CJK",sans-serif}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="28" y="34" font-size="21" font-weight="700" fill="#20202a">${esc(username)}</text>
  <text x="28" y="59" font-size="12.5" fill="#8a8a99">${esc(range.fullLabel)} · 天梯分数走势 · ${stats.total} 场</text>
  <text x="${W - 28}" y="34" text-anchor="end" font-size="26" font-weight="700" fill="#4032b5">${stats.monthEndPt.toFixed(2)}</text>
  <text x="${W - 28}" y="55" text-anchor="end" font-size="11" fill="#9a9aab">${range.current ? '当前 D.P.' : '月末 D.P.'}</text>
  ${grid.join('\n  ')}
  ${xTicks.join('\n  ')}
  <line x1="${L}" y1="${T}" x2="${L}" y2="${T + ph}" stroke="#d8d8e2"/>
  <line x1="${L}" y1="${T + ph}" x2="${W - R}" y2="${T + ph}" stroke="#d8d8e2"/>
  <path d="${line}" fill="none" stroke="#4032b5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="#4032b5" stroke="#fff" stroke-width="1.5"/>
  <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="end" font-size="12.5" font-weight="700" fill="#4032b5">${lastV.toFixed(2)}</text>
</svg></body></html>`;
}

function runChrome(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(chromePath(), args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('截图超时')); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Chrome exit ${code}`));
    });
  });
}

export async function renderChartPng(username, range, stats) {
  mkdirSync(TMP_DIR, { recursive: true });
  const stamp = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const html = join(TMP_DIR, `mycard_${stamp}.html`);
  const png = join(TMP_DIR, `mycard_${stamp}.png`);
  const cropped = join(TMP_DIR, `mycard_${stamp}.crop.png`);
  const profile = join(TMP_DIR, `chrome_${stamp}`);
  try {
    writeFileSync(html, chartSvg(username, range, stats), 'utf8');
    await runChrome([
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--virtual-time-budget=4000',
      '--window-size=760,560',
      `--user-data-dir=${profile}`,
      `--screenshot=${png}`,
      pathToFileURL(html).href,
    ]);
    if (!existsSync(png)) throw new Error('截图没有生成文件');
    // Linux headless 一般正好 760x440;保险起见按目标高度裁一下(ffmpeg 不在就原样发)。
    const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-vf', 'crop=760:440:0:0', cropped], { timeout: 20000 });
    if (r.status === 0 && existsSync(cropped)) renameSync(cropped, png);
    return png;
  } finally {
    try { rmSync(html, { force: true }); } catch { /* ignore */ }
    try { rmSync(cropped, { force: true }); } catch { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------- 回复 ----------
function formatStats(username, range, stats) {
  const rate = stats.total ? `${stats.rate.toFixed(2)}%` : '—';
  const rank = stats.rank > 0 ? String(Math.round(stats.rank)) : '未上榜';
  return [
    username,
    `${range.label}场次：${stats.total}`,
    `${range.label}胜率：${rate}`,
    `当前分数：${stats.currentPt.toFixed(2)}`,
    `当前排名：${rank}`,
  ].join('\n');
}

function targetLabel(entry) {
  const qq = entry.targets?.[0];
  return qq ? `对方(QQ ${qq})` : '对方';
}

/**
 * 执行一条 MC 指令。所有异常都转成用户能看懂的提示,不往外抛(避免队列反复重试)。
 * @param {object} entry inbox 条目
 * @param {object} cmd parseArenaCommand 的返回值
 * @param {{sendReply:Function, log?:Function}} io
 */
export async function processArenaCommand(entry, cmd, { sendReply, log = () => {} } = {}) {
  if (!cmd || !sendReply) return;

  if (cmd.kind === 'bind') {
    const username = String(cmd.username || '').trim();
    if (!username) {
      await sendReply(entry, '用法：绑定 MC用户名\n例如：绑定 影之诗好玩');
      return;
    }
    if (username.length > 40 || /[\r\n]/.test(username)) {
      await sendReply(entry, 'MC 用户名太长或含有换行,检查一下再发。');
      return;
    }
    let user;
    try {
      user = await fetchUser(username);
    } catch (e) {
      log('MC 绑定查询失败:', e.message);
      await sendReply(entry, `查询 MC 用户失败（${e.message}），稍后再试。`);
      return;
    }
    if (!isRealUser(user)) {
      await sendReply(entry, `没查到 MC 用户「${username}」。确认一下用户名（区分大小写）再绑定。`);
      return;
    }
    setBinding(entry.user_id, username);
    log('MC 绑定:', `${entry.user_id} → ${username}`);
    await sendReply(entry, `已绑定 MC 用户名「${username}」。\n之后直接发「历史」查本月天梯，发「历史 7月」查指定月份。`);
    return;
  }

  if (cmd.kind === 'history') {
    if (cmd.error) {
      await sendReply(entry, cmd.error);
      return;
    }
    let username = String(cmd.username || '').trim();
    const targetQq = entry.targets?.[0] ? String(entry.targets[0]) : '';
    if (targetQq) {
      const b = getBinding(targetQq);
      if (!b) {
        await sendReply(entry, targetQq === String(entry.user_id)
          ? '你还没绑定 MC 用户名，发「绑定 MC用户名」先绑一下。'
          : `${targetLabel(entry)}还没绑定 MC 用户名，让他发「绑定 MC用户名」绑一下。`);
        return;
      }
      username = b.username;
    } else if (!username) {
      const b = getBinding(entry.user_id);
      if (!b) {
        await sendReply(entry, '你还没绑定 MC 用户名。\n发「绑定 MC用户名」先绑定，例如：绑定 影之诗好玩');
        return;
      }
      username = b.username;
    }

    if (!username) {
      await sendReply(entry, '要查谁？发「历史 MC用户名」，或者先「绑定 MC用户名」。');
      return;
    }
    if (username.length > 40 || /[\r\n]/.test(username)) {
      await sendReply(entry, 'MC 用户名太长或含有换行,检查一下再发。');
      return;
    }

    const range = resolveRange(cmd);
    let user;
    let hist;
    try {
      user = await fetchUser(username);
      hist = await fetchAthleticHistory(username, { monthStart: range.start });
    } catch (e) {
      log('MC 天梯查询失败:', e.message);
      await sendReply(entry, `查询 MC 天梯数据失败（${e.message}），稍后再试。`);
      return;
    }
    if (!isRealUser(user) && !hist.rows.length) {
      await sendReply(entry, `没查到 MC 用户「${username}」的天梯记录。确认一下用户名（区分大小写）。`);
      return;
    }

    const stats = statsFor(hist.rows, username, range, user);
    const text = formatStats(username, range, stats);
    const segs = [{ type: 'text', data: { text } }];
    let png = '';
    try {
      if (stats.list.length) {
        png = await renderChartPng(username, range, stats);
        segs.push({ type: 'image', data: { file: `base64://${readFileSync(png).toString('base64')}` } });
      }
    } catch (e) {
      log('MC 折线图生成失败:', e.message);
      segs[0].data.text += '\n（折线图生成失败，可稍后再试）';
    } finally {
      if (png) { try { rmSync(png, { force: true }); } catch { /* ignore */ } }
    }
    log('MC 天梯:', `${username} ${range.fullLabel} ${stats.total} 场 ${stats.win} 胜 / D.P. ${stats.currentPt.toFixed(2)} / 排名 ${stats.rank}`);
    await sendReply(entry, segs);
    return;
  }
}

// ---------- 命令行自测 ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--parse')) {
    for (const s of args.filter(a => a !== '--parse')) console.log(JSON.stringify({ text: s, cmd: parseArenaCommand(s), keyword: isArenaCommandText(s) }));
    process.exit(0);
  }
  const i = args.indexOf('--query');
  const name = i >= 0 ? args[i + 1] : '';
  const mi = args.indexOf('--month');
  const fakeEntry = { user_id: '0', targets: [], group_id: 0, nickname: 'test' };
  const cmd = mi >= 0
    ? { kind: 'history', username: name, year: null, month: Number(args[mi + 1]), hadMonth: true }
    : { kind: 'history', username: name, year: null, month: null, hadMonth: false };
  if (!name) {
    console.log('用法: node arena.mjs --query 用户名 [--month 11]');
    console.log('      node arena.mjs --parse "历史 7月" "7月历史" "绑定 foo"');
    process.exit(0);
  }
  processArenaCommand(fakeEntry, cmd, {
    sendReply: async (_e, msg) => {
      if (typeof msg === 'string') { console.log(msg); return; }
      for (const s of msg) {
        if (s.type === 'text') console.log(s.data.text);
        if (s.type === 'image') {
          const b64 = String(s.data.file).replace(/^base64:\/\//, '');
          const out = join(TMP_DIR, 'arena_cli.png');
          mkdirSync(TMP_DIR, { recursive: true });
          writeFileSync(out, Buffer.from(b64, 'base64'));
          console.log(`[image] ${out} (${Buffer.byteLength(b64, 'base64')} bytes)`);
        }
      }
    },
    log: (tag, msg) => console.error(`[${tag}] ${msg}`),
  }).catch(e => { console.error(e); process.exit(1); });
}
