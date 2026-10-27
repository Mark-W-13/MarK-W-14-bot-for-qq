// 上位卡组 · 网页版查询(2026-10-27)
// 轻量 Node HTTP 服务:环境饼图 + 卡组上位链接列表;复用 bot 的 meta.mjs 抓取/缓存。
// 由 nginx 的 onelegocg.top(80) 反代到 127.0.0.1:8080。
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMetaRange, parseDeckAxes, buildMetaPie, searchTopDeck, listDeckAxes, metaCacheDir,
} from '../meta.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Math.max(1024, Number(process.env.YGOWEB_PORT || 8080));
const HOST = process.env.YGOWEB_HOST || '127.0.0.1';
const CHART_DIR = join(metaCacheDir(), 'charts');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// 所有需要抓取/画图的请求串行,避免两个 Chrome + 两份 store 同时吃内存
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const lastHit = new Map(); // ip -> ts, 简单限流
function rateLimited(ip) {
  const now = Date.now();
  const last = lastHit.get(ip) || 0;
  if (now - last < 1500) return true;
  lastHit.set(ip, now);
  if (lastHit.size > 500) {
    for (const [k, v] of lastHit) if (now - v > 60000) lastHit.delete(k);
  }
  return false;
}

let deckCache = { at: 0, list: [] };
function decks() {
  if (Date.now() - deckCache.at < 10 * 60e3 && deckCache.list.length) return deckCache.list;
  const list = listDeckAxes(300);
  deckCache = { at: Date.now(), list };
  return list;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function staticFile(res, rel, cache = 'public, max-age=300') {
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return false;
  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache,
  });
  createReadStream(file).pipe(res);
  return true;
}

function chartFile(res, key) {
  if (!/^[A-Za-z0-9_]+$/.test(key)) return false;
  const file = join(CHART_DIR, `${key}.png`);
  if (!existsSync(file)) return false;
  const st = statSync(file);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=60',
    'Content-Length': st.size,
  });
  createReadStream(file).pipe(res);
  return true;
}

function parseYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function handleQuery(req, res, url) {
  const ip = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '');
  if (rateLimited(ip)) return json(res, 429, { error: '请求太快了,缓一下再试。' });
  const start = url.searchParams.get('start') || '';
  const end = url.searchParams.get('end') || '';
  const deckRaw = (url.searchParams.get('deck') || '').trim().slice(0, 30);
  const sd = parseYmd(start);
  const ed = parseYmd(end);
  if (!sd || !ed) return json(res, 400, { error: '起止日期格式应为 YYYY-MM-DD' });
  if (ed < sd) return json(res, 400, { error: '结束日期不能早于开始日期' });
  const range = parseMetaRange(`${start}~${end}`);
  if (!range) return json(res, 400, { error: '时间段超出可查询范围(最长 210 天)' });

  let primary = '', deckLabel = '';
  if (deckRaw) {
    const parsed = parseDeckAxes(deckRaw);
    if (!parsed.axes.length) return json(res, 400, { error: `没认出卡组「${deckRaw}」` });
    primary = parsed.axes[0];
    deckLabel = parsed.axes.join(' + ');
  }

  const t0 = Date.now();
  try {
    const result = await serial(async () => {
      log('query', JSON.stringify({ start, end, deck: deckRaw, ip }));
      const chart = await buildMetaPie(range, { log: m => log(' meta', m) });
      let top = null;
      if (primary) {
        top = await searchTopDeck(primary, range, {
          noImage: true, listLimit: 20, log: m => log(' top', m),
        });
      }
      const st = statSync(chart.pngPath);
      return {
        range: { start, end, label: range.label, desc: range.desc, key: range.key },
        stats: {
          posts: chart.stats.posts,
          entries: chart.stats.entries,
          unique: chart.stats.unique,
          truncated: !!chart.truncated,
        },
        counts: chart.stats.list,
        chart: `/api/chart/${range.key}.png?v=${st.mtimeMs}`,
        deck: primary ? { query: deckRaw, label: deckLabel, primary } : null,
        top: top ? { count: top.list.length, list: top.list } : null,
        ms: Date.now() - t0,
      };
    });
    json(res, 200, result);
  } catch (e) {
    log('query failed', e.stack || e.message);
    json(res, 500, { error: e.message || '查询失败' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: process.uptime(), rss: process.memoryUsage().rss });
    }
    if (req.method === 'GET' && url.pathname === '/api/decks') {
      return json(res, 200, { list: decks() });
    }
    if (req.method === 'GET' && url.pathname === '/api/query') {
      return await handleQuery(req, res, url);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/chart/')) {
      const key = url.pathname.slice('/api/chart/'.length).replace(/\.png$/, '');
      if (chartFile(res, key)) return;
      return json(res, 404, { error: '图表不存在' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (staticFile(res, 'index.html', 'no-store')) return;
    }
    if (req.method === 'GET' && staticFile(res, url.pathname.replace(/^\//, ''))) return;
    json(res, 404, { error: 'Not Found' });
  } catch (e) {
    log('server error', e.stack || e.message);
    if (!res.headersSent) json(res, 500, { error: '服务器错误' });
  }
});

server.requestTimeout = 180000;
server.headersTimeout = 185000;
server.listen(PORT, HOST, () => log(`ygoweb listening http://${HOST}:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutdown', sig);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
