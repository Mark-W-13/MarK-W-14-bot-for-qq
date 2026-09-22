// 联网搜索(本地工具,2026-09-21 落地):给 AI 闲聊挂一个**真会执行的**搜索函数
//
// 为什么重写成这样(别改回去):
//   2026-09-14 的老路子是「给智谱后端挂它家的 web_search 工具,服务端自己去搜、把结果注入提示词」。
//   这条路有两个死结:① **只对智谱有效** —— 换成 deepseek 挂上这个工具直接 4xx;
//   ② 搜没搜、搜到什么都看不见,出问题只能靠猜(当时是靠 prompt_tokens 从 369 跳到 2811 来"证明"它搜了)。
//   现在改成标准 OpenAI function calling:我们**自己定义** `web_search` 函数、自己执行搜索、
//   把搜到的结果当 tool 消息喂回去。任何后端(deepseek / 任何 OpenAI 兼容的服务)都能用,
//   而且每次搜索都在 monitor 面板上打一行日志 —— 搜了什么、几家源、几条结果,一眼可见。
//
// 搜索源(实测于 2026-09-21):
//   zhipu  ⭐ 推荐,也是默认:https://open.bigmodel.cn/api/paas/v4/web_search,
//          用现有的 ZHIPU_API_KEY 即可(它只是搜索服务,**不要求用智谱的聊天模型**)。
//          实测搜「游戏王 2026年1月 禁卡表」能拿到 2026-06-25 的官方卡表公告(带日期),数据新鲜。
//   tavily :https://api.tavily.com/search,为 LLM 设计的检索,质量好;国内需能连通,要单独申请 key。
//   bocha  :https://api.bochaai.com/v1/web-search,国内直连,要单独申请 key。
//   bing   :**零 key 兜底**,抓 cn.bing.com 的 HTML。⚠ 质量明显差:实测搜「游戏王 禁卡表 2026年1月」
//          返回的却是「4399小游戏 / Steam / TapTap」这类大词泛化结果 —— 只当 key 全没配时的应急,
//          别指望它查得准(所以它排在最后,且要 SEARCH_PROVIDER=bing 或前面几家都没 key 时才会用)。
//
// 用哪个:SEARCH_PROVIDER 指定(zhipu/tavily/bocha/bing);不指定就按「配了哪家的 key」自动选,
// 一家 key 都没有时退回 bing。key:ZHIPU_API_KEY / TAVILY_API_KEY / BOCHA_API_KEY(都在 agent/.env)。
//
// ⚠ 搜到了不等于对(2026-09-21 实测仍在):同一句话搜「最新禁卡表」,结果里既有 2026-07 的新表,
//   也可能混进旧表页面。所以把结果原样给模型时**必须带发布日期与来源链接**,让模型(和群友)能自己判断,
//   别在代码里替它选"最权威的那条"。提示词里也写了「拿不准就说查到的说法是 …」。
import '../env.mjs';   // ⚠ 必须第一个:SEARCH_PROVIDER / *_API_KEY 都在 agent/.env 里,下面顶层就要读
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本模块不读写任何本地文件;__dirname 留着是给以后加「搜索结果缓存」时用的
const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname;

// ---------- 配置 ----------
export const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 15000);  // 单家源的超时
export const SEARCH_COUNT = Math.min(Math.max(Number(process.env.SEARCH_COUNT || 6), 1), 20);  // 取几条
export const SEARCH_MAX_CHARS = Number(process.env.SEARCH_MAX_CHARS || 1200);     // 单条摘要上限
export const SEARCH_TOTAL_CHARS = Number(process.env.SEARCH_TOTAL_CHARS || 6000); // 喂回模型的总上限

const KEYS = {
  zhipu: process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || '',
  tavily: process.env.TAVILY_API_KEY || '',
  bocha: process.env.BOCHA_API_KEY || '',
};

/** 选源:SEARCH_PROVIDER 显式指定 > 有 key 的第一家(按推荐顺序)> bing 兜底 */
export function pickProvider() {
  const want = String(process.env.SEARCH_PROVIDER || '').trim().toLowerCase();
  if (want) {
    if (want === 'bing') return 'bing';
    if (KEYS[want]) return want;
    return null;   // 显式指定了却没配 key → 不静默换源,让调用方把「没配 key」说出来
  }
  for (const p of ['zhipu', 'tavily', 'bocha']) if (KEYS[p]) return p;
  return 'bing';
}

/** 当前是否具备联网能力(没 key 也能用 bing 兜底,所以几乎总是 true;显式指定却没 key 时才是 false) */
export function searchReady() {
  return !!pickProvider();
}

/** 给 WebUI / 启动日志用的一句话(不含 key) */
export function providerText() {
  const p = pickProvider();
  if (!p) return `未配置(SEARCH_PROVIDER=${process.env.SEARCH_PROVIDER} 但没有对应 key)`;
  return p + (p === 'bing' ? '(零 key,质量差)' : '');
}

// ---------- HTML 小工具 ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', hellip: '…', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–' };
function decodeEnt(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e] !== undefined ? ENT[e] : m;
  });
}
function stripTags(s) {
  return decodeEnt(String(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

// ---------- 各家源 ----------
async function fetchJson(url, init, tag) {
  let r;
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`${tag} 连不上(${e.name === 'TimeoutError' ? `超时 ${SEARCH_TIMEOUT_MS}ms` : e.message})`);
  }
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* 非 JSON,下面按 status 报错 */ }
  if (!r.ok) throw new Error(`${tag} HTTP ${r.status} ${(j && (j.message || j.error?.message)) || txt.slice(0, 120)}`.trim());
  if (!j) throw new Error(`${tag} 返回的不是 JSON:${txt.slice(0, 120)}`);
  return j;
}

// 各源统一返回 [{title, url, snippet, date, site}]
async function searchZhipu(q, count) {
  const j = await fetchJson('https://open.bigmodel.cn/api/paas/v4/web_search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEYS.zhipu}`, 'Content-Type': 'application/json' },
    // search_std = 标准版引擎(便宜);要更好质量可设 SEARCH_ENGINE=search_pro
    body: JSON.stringify({ search_engine: process.env.SEARCH_ENGINE || 'search_std', search_query: q, count }),
  }, '智谱搜索');
  const list = j.search_result || j.data || [];
  return list.map(it => ({
    title: it.title, url: it.link, snippet: it.content, date: it.publish_date, site: it.media,
  }));
}

async function searchTavily(q, count) {
  const j = await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: KEYS.tavily, query: q, max_results: count, search_depth: 'basic', include_answer: false }),
  }, 'Tavily');
  return (j.results || []).map(it => ({ title: it.title, url: it.url, snippet: it.content, date: it.published_date, site: '' }));
}

async function searchBocha(q, count) {
  const j = await fetchJson('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEYS.bocha}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, count, summary: true }),
  }, '博查');
  const list = j?.data?.webPages?.value || j?.webPages?.value || [];
  return list.map(it => ({ title: it.name, url: it.url, snippet: it.summary || it.snippet, date: it.datePublished || it.dateLastCrawled, site: it.siteName }));
}

/**
 * 零 key 兜底:抓 cn.bing.com 的结果页。**质量差**(大词会泛化),只应急。
 * 解析方式写死成 b_algo 块 —— 2026-09-21 实测:每条结果的 <h2><a href> 是标题+链接,
 * 摘要在 <p> 或 .b_caption 里,cite 是显示的域名。Bing 改版就会失效,所以它只是兜底。
 */
async function searchBing(q, count) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&ensearch=0&count=${Math.max(count, 10)}`;
  let r;
  try {
    r = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Bing 抓取失败(${e.name === 'TimeoutError' ? `超时 ${SEARCH_TIMEOUT_MS}ms` : e.message})`);
  }
  if (!r.ok) throw new Error(`Bing HTTP ${r.status}`);
  const html = await r.text();
  const out = [];
  for (const block of html.split(/<li class="b_algo"/i).slice(1)) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = stripTags(a[2]);
    const link = decodeEnt(a[1]);
    if (!title || !/^https?:/i.test(link)) continue;
    const cap = block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = stripTags(cap ? cap[1] : (p ? p[1] : ''));
    out.push({ title, url: link, snippet, date: '', site: '' });
    if (out.length >= count) break;
  }
  if (!out.length) throw new Error('Bing 页面里没解析出结果(改版了?换个源)');
  return out;
}

const ENGINES = { zhipu: searchZhipu, tavily: searchTavily, bocha: searchBocha, bing: searchBing };

/**
 * 执行一次搜索。返回 {ok, provider, query, count, text, results, error}
 * **不抛错**:搜索失败不该把整条闲聊弄挂 —— 返回 ok:false + 说明,由调用方喂给模型「没搜到」。
 */
export async function runSearch(query, { count = SEARCH_COUNT, provider } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  if (!q) return { ok: false, provider: '', query: '', count: 0, text: '', results: [], error: '搜索词是空的' };
  const p = provider || pickProvider();
  if (provider && !ENGINES[provider]) {
    return { ok: false, provider, query: q, count: 0, text: '', results: [], error: `不认识的搜索源「${provider}」(可选 ${Object.keys(ENGINES).join(' / ')})` };
  }
  if (!p || !ENGINES[p]) {
    return { ok: false, provider: p || '', query: q, count: 0, text: '', results: [], error: `没配置搜索源(SEARCH_PROVIDER=${process.env.SEARCH_PROVIDER || '(空)'} 且没有可用的 API key)` };
  }
  try {
    const results = await ENGINES[p](q, Math.min(Math.max(count, 1), 20));
    const clean = results.filter(r => r.title && r.url).slice(0, count);
    if (!clean.length) return { ok: false, provider: p, query: q, count: 0, text: '', results: [], error: '没搜到结果' };
    return { ok: true, provider: p, query: q, count: clean.length, text: formatResults(q, clean), results: clean, error: '' };
  } catch (e) {
    return { ok: false, provider: p, query: q, count: 0, text: '', results: [], error: e.message };
  }
}

/**
 * 把结果拼成给模型看的纯文本。**必须带日期和来源链接**:
 * 模型要靠日期判断新旧(实测同一个查询里新旧卡表页面会同时出现),群友要靠链接自己核实。
 */
export function formatResults(query, results) {
  const head = `搜索「${query}」的结果(${results.length} 条,来自网络,可能过时或不准):`;
  let total = head.length;
  const parts = [];
  results.forEach((r, i) => {
    let snip = stripTags(r.snippet || '');
    if (snip.length > SEARCH_MAX_CHARS) snip = snip.slice(0, SEARCH_MAX_CHARS) + '…';
    const meta = [r.date ? `日期 ${r.date}` : '', r.site ? `来源 ${r.site}` : ''].filter(Boolean).join(' | ');
    const line = `${i + 1}. ${stripTags(r.title)}${meta ? `\n   ${meta}` : ''}\n   ${r.url}${snip ? `\n   ${snip}` : ''}`;
    if (total + line.length > SEARCH_TOTAL_CHARS) return;   // 超预算就丢尾部,别把整段提示词撑爆
    total += line.length;
    parts.push(line);
  });
  return [head, ...parts].join('\n');
}

// 给 chat completions 的 tools 参数用(标准 OpenAI function 格式,deepseek / 绝大多数兼容后端都认)
export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '联网搜索。用于时效性/事实性问题:最新禁卡表与卡表生效日期、新闻、价格、比分、人物近况,'
      + '以及你记忆里没底的具体数字与日期。纯闲聊、算数、常识、群里的梗不要用。一次给一个查询词,可多次调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词,像在搜索引擎里输入那样,例如「游戏王 2026年7月 禁卡表」' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

/** 自测:node agent/aichat/websearch.mjs --selftest [查询词] */
if (process.argv.includes('--selftest')) {
  const argv = process.argv.slice(2);
  const q = argv.find(a => !a.startsWith('--')) || '游戏王 2026年 禁卡表';
  const lines = [];
  const ok = (c, m) => lines.push(`${c ? '✓' : '✗'} ${m}`);

  ok(!!pickProvider(), `选源:${providerText()}`);
  ok(/required|"query"/.test(JSON.stringify(WEB_SEARCH_TOOL)), '工具定义是可用的 function 格式');
  const fmt = formatResults('x', [{ title: '<b>标题</b>', url: 'https://a.com', snippet: 'a&amp;b <i>c</i>', date: '2026-01-01', site: '站' }]);
  ok(fmt.includes('标题') && !fmt.includes('<b>'), '标题去标签');
  ok(fmt.includes('a&b c'), 'HTML 实体转义 + 去标签');
  ok(fmt.includes('2026-01-01') && fmt.includes('https://a.com'), '带日期与链接');
  const empty = await runSearch('   ');
  ok(empty.ok === false && /空/.test(empty.error), '空查询被拒且不抛错');
  const bad = await runSearch('x', { provider: 'nope' });
  ok(bad.ok === false && /不认识的搜索源/.test(bad.error), '未知源返回失败而不是抛错');

  console.log(lines.join('\n'));
  console.log(`\n--- 实搜:${q}(源 ${providerText()})---`);
  const t0 = Date.now();
  const r = await runSearch(q);
  console.log(r.ok
    ? `✓ ${Date.now() - t0}ms ${r.count} 条\n${r.text.slice(0, 900)}`
    : `✗ ${Date.now() - t0}ms ${r.error}`);
  const bad2 = lines.filter(l => l.startsWith('✗')).length + (r.ok ? 0 : 1);
  console.log(`\n${lines.length - lines.filter(l => l.startsWith('✗')).length}/${lines.length} 通过${r.ok ? '' : '(实搜失败,见上)'}`);
  // ⚠ 这里**不能** process.exit:本自测里有 fetch(undici),边收尾边 exit 会在 Windows/Node 24 上
  //   抛 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`,看着像自测崩了。
  //   设 exitCode 让事件循环自己排空即可(undici 的连接会自己关掉)。
  process.exitCode = bad2 ? 1 : 0;
}
