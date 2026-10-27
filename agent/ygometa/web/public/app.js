const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();

let chipDeck = '';
let busy = false;

function setDates(start, end) {
  $('start').value = start;
  $('end').value = end;
  updateNote();
}

function setPreset(name) {
  document.querySelectorAll('.quick button').forEach(b => b.classList.toggle('on', b.dataset.preset === name));
  const now = new Date();
  if (name === '7') {
    const s = new Date(now); s.setDate(s.getDate() - 6);
    setDates(ymd(s), ymd(now));
  } else if (name === 'month') {
    setDates(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, ymd(now));
  } else if (name === 'last') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0);
    setDates(ymd(s), ymd(e));
  } else if (name === 'year') {
    setDates(`${now.getFullYear()}-01-01`, ymd(now));
  }
}

function updateNote() {
  const s = $('start').value, e = $('end').value;
  if (!s || !e) { $('date-note').textContent = ''; return; }
  const days = Math.round((new Date(e) - new Date(s)) / 864e5) + 1;
  $('date-note').textContent = days > 0 ? `共 ${days} 天` : '';
}

function setChip(name) {
  chipDeck = name || '';
  $('tag-chip').hidden = !chipDeck;
  $('tag-text').textContent = chipDeck;
  if (chipDeck) $('deck').value = '';
  if (!chipDeck) $('deck').value = '';
}

function addChip() {
  const v = $('deck').value.trim();
  if (!v) return;
  setChip(v);
  $('deck').focus();
}

function roleClass(role) {
  if (!role) return '';
  if (role.includes('冠军') || role.includes('优胜')) return 'r1';
  if (role.includes('亚军')) return 'r2';
  if (role.includes('四强') || role.includes('三位') || role.includes('四位')) return 'r3';
  return '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function breakdown(c) {
  const bits = [];
  if (c.pure) bits.push(`纯 ${c.pure}`);
  for (const b of (c.buckets || []).slice(0, 3)) bits.push(`${b.name} ${b.count}`);
  if ((c.buckets || []).length > 3) bits.push('…');
  return bits.join(' · ');
}

function renderCounts(list, total) {
  $('counts').innerHTML = list.map((c, i) => {
    const pct = total ? (c.num / total * 100).toFixed(1) : '0.0';
    const detail = breakdown(c);
    return `<div class="count-row" title="${esc(detail)}">
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(c.name)}</span>
      <span class="num">${c.num}<small>${pct}%</small></span>
    </div>`;
  }).join('');
}

function renderTop(top, deckLabel) {
  const panel = $('top-panel');
  if (!top) { panel.hidden = true; return; }
  panel.hidden = false;
  const list = top.list || [];
  $('top-title').textContent = `「${deckLabel}」上位记录`;
  $('top-sub').textContent = list.length ? `按距目标时间从近到远 · 展示 ${list.length} 条` : '没有找到该卡组的上位记录';
  $('top-count').textContent = `${list.length} 条`;
  if (!list.length) {
    $('top-list').innerHTML = '<li class="top-empty">换一个时间段或确认一下卡组名试试。</li>';
    return;
  }
  $('top-list').innerHTML = list.map(x => {
    const role = x.role && x.role !== '上位' ? `<span class="role ${roleClass(x.role)}">${esc(x.role)}</span>` : '';
    return `<li class="top-item">
      <span class="top-date">${esc(x.date)}</span>
      <div class="top-main">
        <div class="top-line">${role}<span class="top-deck">${esc(x.deck)}</span></div>
        <p class="top-title" title="${esc(x.title)}">${esc(x.title)}</p>
      </div>
      <a class="top-link" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">原帖 ↗</a>
    </li>`;
  }).join('');
}

function render(data) {
  $('results').hidden = false;
  $('env-title').textContent = data.range.label;
  $('env-sub').textContent = `${data.range.desc} · 数据来源：百度贴吧「上位卡组吧」`;
  $('env-stats').innerHTML = `
    <span><b>${data.stats.entries}</b>副上位</span>
    <span><b>${data.stats.posts}</b>场赛事</span>
    <span><b>${data.stats.unique}</b>个主轴</span>
    ${data.stats.truncated ? '<span style="color:#9a5b3d">抓取触顶，数据可能不全</span>' : ''}`;
  const img = $('chart');
  img.src = data.chart;
  img.alt = `${data.range.label} 上位卡组环境饼图`;
  $('chart-cap').textContent = `${data.range.desc} · 饼图由实时抓取记录生成`;
  renderCounts(data.counts || [], data.stats.entries);
  if (data.deck && data.top) {
    renderTop(data.top, data.deck.label || data.deck.primary);
  } else {
    $('top-panel').hidden = true;
  }
  $('gen-time').textContent = `查询耗时 ${(data.ms / 1000).toFixed(1)}s`;
  const qs = new URLSearchParams({ start: data.range.start, end: data.range.end });
  if (data.deck) qs.set('deck', data.deck.query);
  history.replaceState(null, '', `?${qs.toString()}`);
}

async function query({ scroll = true } = {}) {
  if (busy) return;
  const start = $('start').value, end = $('end').value;
  const deck = chipDeck || $('deck').value.trim();
  if (!start || !end) { showError('请选择起止日期'); return; }
  if (end < start) { showError('结束日期不能早于开始日期'); return; }
  const days = Math.round((new Date(end) - new Date(start)) / 864e5) + 1;
  if (days > 210) { showError('最长只能查 210 天'); return; }

  busy = true;
  $('submit').disabled = true;
  $('submit').classList.add('busy');
  $('error').hidden = true;
  $('loading').hidden = false;
  $('results').hidden = true;
  $('loading-text').textContent = days > 45
    ? `正在抓取 ${days} 天的记录并生成饼图，第一次会久一点 ...`
    : '正在读取记录 / 抓取贴吧 / 生成饼图 ...';

  const qs = new URLSearchParams({ start, end });
  if (deck) qs.set('deck', deck);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(`/api/query?${qs.toString()}`, { signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    render(j);
    if (scroll) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError(e.name === 'AbortError' ? '查询超时，换个短一点的时间段试试。' : (e.message || '查询失败'));
  } finally {
    clearTimeout(timer);
    busy = false;
    $('submit').disabled = false;
    $('submit').classList.remove('busy');
    $('loading').hidden = true;
  }
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
  $('results').hidden = true;
}

async function loadDecks() {
  try {
    const r = await fetch('/api/decks');
    const j = await r.json();
    $('deck-list').innerHTML = (j.list || [])
      .slice(0, 200)
      .map(x => `<option value="${esc(x.name)}">${esc(x.name)} · ${x.count}</option>`)
      .join('');
  } catch { /* 自动补全失败不影响查询 */ }
}

function initFromUrl() {
  const p = new URLSearchParams(location.search);
  const s = p.get('start'), e = p.get('end'), d = p.get('deck');
  if (s && e) {
    setDates(s, e);
    document.querySelectorAll('.quick button').forEach(b => b.classList.remove('on'));
    document.querySelector('.quick button[data-preset="custom"]')?.classList.add('on');
  } else {
    setPreset('month');
  }
  if (d) setChip(d);
  return !!(s && e);
}

document.querySelectorAll('.quick button').forEach(b => {
  b.addEventListener('click', () => {
    if (b.dataset.preset === 'custom') {
      document.querySelectorAll('.quick button').forEach(x => x.classList.toggle('on', x === b));
      $('start').focus();
    } else {
      setPreset(b.dataset.preset);
    }
  });
});
['start', 'end'].forEach(id => $(id).addEventListener('change', () => {
  document.querySelectorAll('.quick button').forEach(b => b.classList.remove('on'));
  document.querySelector('.quick button[data-preset="custom"]')?.classList.add('on');
  updateNote();
}));
$('deck').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addChip(); }
});
$('tag-add').addEventListener('click', addChip);
$('tag-clear').addEventListener('click', () => setChip(''));
$('submit').addEventListener('click', query);

const hadUrl = initFromUrl();
loadDecks();
if (hadUrl) query({ scroll: false });
