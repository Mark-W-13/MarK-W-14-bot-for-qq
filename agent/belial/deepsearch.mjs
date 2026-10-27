// DeepSeek 官方 Search API(2026-10-26 接入)
// 文档:https://api-docs.deepseek.com/zh-cn/guides/search/
//   POST https://api.deepseek.com/v1/tools/search
//   { query, count, ori_question?, need_content? } → { results: [{ title,url,summary,snippet,date,... }] }
// 计费:每 1000 次成功请求 5 元(2026-11-01 前通过 DSH/Claude Code 的服务端工具调用暂免,直接调仍按次)。
// 这里只被银河皇帝模式的 web_search 工具调用;普通 AI 闲聊仍走 websearch.mjs 的老源。
import { pathToFileURL } from 'node:url';
import './../env.mjs';   // 与其它模块同规矩:先加载 agent/.env;单独 CLI 跑也拿得到 DEEPSEEK_API_KEY

const DEFAULT_URL = 'https://api.deepseek.com/v1/tools/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const apiKey = () => process.env.DEEPSEEK_API_KEY || process.env.AI_CHAT_API_KEY || '';
const searchUrl = () => process.env.DEEPSEEK_SEARCH_URL || DEFAULT_URL;
const timeoutMs = () => Math.max(3000, Number(process.env.BELIAL_SEARCH_TIMEOUT_MS || 20000));

/**
 * 调 DeepSeek 官方 Search API。
 * @returns {{ok:boolean, count?:number, provider?:string, text?:string, results?:object[], error?:string}}
 */
export async function dsSearch(query, { count = 5, oriQuestion = '', log = () => {} } = {}) {
  const q = String(query || '').trim().slice(0, 128);
  if (!q) return { ok: false, error: '搜索词为空' };
  const key = apiKey();
  if (!key) return { ok: false, error: '没配 DEEPSEEK_API_KEY,无法用 DS 官方搜索' };
  const n = Math.min(10, Math.max(1, Number(count) || 5));
  const body = { query: q, count: n, need_content: false };
  if (oriQuestion) body.ori_question = String(oriQuestion).trim().slice(0, 128);

  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(searchUrl(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs()),
      });
      const j = await r.json().catch(() => null);
      if (r.ok) {
        const results = Array.isArray(j?.results) ? j.results : [];
        if (!results.length) return { ok: true, count: 0, provider: 'deepseek', results: [], text: `搜索「${q}」没有找到结果。` };
        const lines = [`搜索「${q}」:${results.length} 条(DeepSeek 官方)`];
        results.forEach((x, i) => {
          lines.push(`${i + 1}. ${String(x.title || '').trim()}`);
          if (x.date) lines.push(`   时间: ${x.date}`);
          if (x.url) lines.push(`   链接: ${x.url}`);
          const summary = String(x.summary || x.snippet || '').replace(/\s+/g, ' ').trim();
          if (summary) lines.push(`   摘要: ${summary.slice(0, 500)}`);
        });
        return { ok: true, count: results.length, provider: 'deepseek', text: lines.join('\n'), results };
      }
      last = `HTTP ${r.status} ${j?.error?.message || j?.message || ''}`.trim();
      log(`  DS 搜索失败: ${last}`);
      // 只有 429/5xx 值得重试;其它 4xx 改请求也没用
      if (![408, 429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) {
      last = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `超时 ${timeoutMs()}ms` : (e?.message || String(e));
      log(`  DS 搜索异常: ${last}`);
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, error: last || '搜索失败' };
}

// CLI: node deepsearch.mjs "查询词" | --selftest
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    const real = globalThis.fetch;
    process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'selftest';
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [
      { title: '测试标题', url: 'https://example.com/a', summary: '测试摘要', date: '2026-10-26T00:00:00Z', snippet: 'x' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    dsSearch('测试').then(r => {
      const ok = r.ok && r.count === 1 && r.text.includes('测试标题') && r.text.includes('https://example.com/a');
      console.log(ok ? '✓ dsSearch selftest' : `✗ dsSearch selftest: ${JSON.stringify(r)}`);
      globalThis.fetch = real;
      process.exitCode = ok ? 0 : 1;
    });
  } else {
    const q = args.join(' ') || 'DeepSeek';
    dsSearch(q, { log: console.log }).then(r => {
      console.log(r.ok ? r.text : `搜索失败: ${r.error}`);
      process.exitCode = r.ok ? 0 : 1;
    });
  }
}
