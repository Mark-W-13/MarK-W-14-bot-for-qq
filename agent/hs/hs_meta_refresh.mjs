// 炉石卡组库更新工具(2026-09-20 新增):
//   ① `node hs_meta_refresh.mjs --standard`  重新抓标准(metastats.net,11 个职业页)
//   ② `node hs_meta_refresh.mjs --from <URL> [<URL> …] [--format wild|standard] [--dry]`
//        从文章页(如 17173 的「狂野卡组推荐」)抠出卡组代码并入库 —— 狂野没有稳定的在线源,
//        只能靠这种文章页补,所以做成一条命令,以后看到新文章直接跑。
//   ③ `node hs_meta_refresh.mjs --stats`     看库里现有多少套
//
// 入库规则:
//   · 逐条**解码验证**(解不开、张数离谱、有未知卡的直接丢掉并报出来,别让坏数据进库)
//   · 按卡组代码去重(同一套在多篇文章里出现只留一条,保留首次入库的来源)
//   · 职业用卡组里的英雄卡判定;流派名尽力从文章标题/上下文猜,猜不到就叫「狂野·<职业>」
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeDeckstring, cardByDbf, formatDeckList, loadCards, CLASS_CN } from './hs.mjs';
import { loadMeta, saveMeta, getMetaDecks, metaPath, classCn } from './hs_meta.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };

/** 校验一条卡组代码:解码 → 张数合理 → 卡名基本认得出。失败抛错,附带原因 */
export function validateDeck(code) {
  const dec = decodeDeckstring(code);
  const main = dec.cards.reduce((n, x) => n + x.count, 0);
  const unknown = dec.cards.filter(x => !cardByDbf(x.dbfId)).length;
  if (main < 15 || main > 45) throw new Error(`张数不合理(${main})`);
  // 文章里的「狂野卡组」常引用刚上线的新卡,而本地卡库是上次同步的快照 → 允许少量查不到,
  // 但超过三分之一就说明卡库太旧或代码不是合法卡组,直接丢(2026-09-20 实测:某套 42 张里 11 张未知)
  if (unknown > Math.max(3, main * 0.34)) throw new Error(`有 ${unknown}/${main} 张卡库里查不到(卡库可能太旧)`);
  const hero = dec.heroes.map(h => cardByDbf(h)).find(Boolean);
  const cls = hero?.cardClass || [...new Set(dec.cards.map(c => cardByDbf(c.dbfId)?.cardClass).filter(k => k && k !== 'NEUTRAL'))][0] || 'NEUTRAL';
  return { dec, total: main, unknown, classKey: cls, heroName: hero?.name || '', format: dec.formatName };
}

/** 从 HTML 里抠卡组代码,并尽力给每条配一个名字(附近的小标题/加粗文字) */
export function extractDecksFromHtml(html, { limit = 40 } = {}) {
  const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const out = [];
  const seen = new Set();
  // 无用的「名字」候选:文章里的套话(卡组代码:、卡组简析、核心卡牌分析…)
  const JUNK = /(卡组代码|卡组简析|卡组分析|卡牌分析|核心卡牌|导语|前言|代码[:：]?|复制|点击|查看|更多|总结|攻略|作者|编辑|来源|分享|评论|原文|返回|首页|上一页|下一页)/;
  const clean = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/[《》【】\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const pick = (cands) => {
    // 排除套话与「句子里的一截」:含这些标点的多半是正文,不是卡组名
    const ok = cands.map(clean).filter(s => s.length >= 2 && s.length <= 14 && !JUNK.test(s)
      && !/[。，、；：！？…—～·|()（）/\\“”"']/.test(s) && /[\u4e00-\u9fa5A-Za-z]/.test(s));
    return ok.find(s => /[\u4e00-\u9fa5]/.test(s)) || ok[0] || '';
  };
  for (const m of text.matchAll(/\b(AAE[A-Za-z0-9+/=]{20,})/g)) {
    const code = m[1];
    if (seen.has(code)) continue;
    seen.add(code);
    // 名字:代码**前面**最近的标题/加粗(文章常见「XXX卡组:」),拿不到再看**后面**紧挨的标题
    const before = text.slice(Math.max(0, m.index - 2500), m.index);
    const after = text.slice(m.index + code.length, m.index + code.length + 800);
    const grabspans = seg => [...seg.matchAll(/(?:<h[1-5][^>]*>([\s\S]{2,80}?)<\/h[1-5]>|<(?:strong|b|p|div)[^>]*>([\s\S]{2,60}?)<\/(?:strong|b|p|div)>)/g)]
      .map(x => x[1] || x[2] || '');
    const title = clean((text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '');
    const name = pick(grabspans(before).reverse()) || pick(grabspans(after)) || '';
    out.push({ code, name, articleTitle: title });
    if (out.length >= limit) break;
  }
  return out;
}

/** 把一条卡组写进库(format: wild|standard);返回 'added' | 'duplicate' | 抛错 */
export function addDeck(db, { code, archetype, format = 'wild', source = '', winrate = 0, games = 0 }) {
  const v = validateDeck(code);
  const bucket = format === 'wild' ? (db.wild = db.wild || {}) : (db.standard = db.standard || {});
  // 去重:全库范围内同一段代码只留一条
  for (const group of Object.values(bucket)) {
    if ((group || []).some(d => d.code === code)) return 'duplicate';
  }
  const list = bucket[v.classKey] = bucket[v.classKey] || [];
  list.push({
    archetype: archetype || `${format === 'wild' ? '狂野' : '标准'}·${classCn(v.classKey)}`,
    title: archetype || '', code, winrate, games,
    source: source || '人工', sourceUrl: source.startsWith('http') ? source : '',
    heroName: v.heroName, total: v.total, addedAt: Date.now(),
  });
  if (format === 'wild') db.wildUpdatedAt = Date.now();
  return 'added';
}

async function fetchText(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ---------------- CLI ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const urls = argv.filter(a => /^https?:\/\//.test(a));
  const format = val('--format') === 'standard' ? 'standard' : 'wild';
  const dry = argv.includes('--dry');
  try {
    loadCards();
    const db = loadMeta();

    if (argv.includes('--stats')) {
      const count = o => Object.values(o || {}).reduce((n, l) => n + (l?.length || 0), 0);
      console.log('库文件:', metaPath());
      console.log(`标准 ${count(db.standard)} 套(更新 ${db.standardUpdatedAt ? new Date(db.standardUpdatedAt).toLocaleString('zh-CN') : '从未'})`);
      console.log(`狂野 ${count(db.wild)} 套(更新 ${db.wildUpdatedAt ? new Date(db.wildUpdatedAt).toLocaleString('zh-CN') : '从未'})`);
      for (const [ck, list] of Object.entries(db.wild || {})) console.log(`  [狂野] ${classCn(ck)}: ${list.map(d => d.archetype).join('、')}`);
      process.exit(0);
    }

    if (argv.includes('--standard')) {
      const r = await getMetaDecks('standard', { log: console.log, force: true });
      console.log(`\n标准库刷新: ${r.decks.length} 套${r.warning ? ' 警告:' + r.warning : ''}`);
      process.exit(0);
    }

    if (!urls.length) {
      console.log('用法:');
      console.log('  node hs_meta_refresh.mjs --standard                      # 重抓标准(metastats.net)');
      console.log('  node hs_meta_refresh.mjs --stats                          # 看库');
      console.log('  node hs_meta_refresh.mjs <URL> [<URL>…] [--format wild]   # 从文章页抠卡组代码入狂野库');
      console.log('  加 --dry 只试跑不写盘');
      process.exit(1);
    }

    let added = 0, dup = 0, bad = 0;
    for (const url of urls) {
      let html;
      try { html = await fetchText(url); } catch (e) { console.log(`✗ 取不到 ${url}: ${e.message}`); continue; }
      const found = extractDecksFromHtml(html);
      console.log(`\n${url}\n  抠出 ${found.length} 条卡组代码`);
      for (const f of found) {
        try {
          const v = validateDeck(f.code);
          const arche = (f.name || '').replace(/\s+/g, ' ').slice(0, 30);
          const r = dry ? 'dry' : addDeck(db, { code: f.code, archetype: arche, format, source: url });
          if (r === 'duplicate') { dup++; console.log(`  = 已存在  ${classCn(v.classKey)} ${arche || v.heroName}`); }
          else { added++; console.log(`  + ${classCn(v.classKey)} ${arche || v.heroName}(${v.total} 张) ${f.code.slice(0, 20)}…`); }
        } catch (e) {
          bad++;
          console.log(`  ✗ 丢弃(${e.message}): ${f.code.slice(0, 24)}…`);
        }
      }
    }
    if (!dry && added) {
      saveMeta(db);
      console.log(`\n入库完成: 新增 ${added} 套 / 重复 ${dup} / 丢弃 ${bad} → ${metaPath()}`);
    } else {
      console.log(`\n(--dry 未写盘) 可入库 ${added} / 重复 ${dup} / 丢弃 ${bad}`);
    }
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}
