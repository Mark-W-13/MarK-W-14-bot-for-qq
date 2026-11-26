// MC 超先行卡（萌卡先行卡库）合并 —— 让卡库比百鸽早一步
// ---------------------------------------------------------------------------
// 百鸽（ygocdb.com）只收录**官方 DB 已更新**的卡，新卡通常要等到发售日（例：RV02 2026-11-21
// 发售的鬼计新卡，11-19 时百鸽 cards.zip 里一张都没有）。萌卡的「超先行卡」公布即收录，
// 数据+卡图都在 moecube CDN 上：
//   列表 https://cdntx.moecube.com/ygopro-super-pre/data/test-release-v2.json
//   卡图 https://cdntx.moecube.com/ygopro-super-pre/data/pics/{id}.jpg
//   （卡图这条 download_images.mjs 早就接了：1e8 段只走 moecube 回退源）
// 所以每次「更新卡库」时，把萌卡先行库里**百鸽还没有**的卡并进 cards.json；
// 等百鸽正式收录同名卡后，先行条目自动移除，不会出现重复。
//
// 字段映射：萌卡只有 id(临时密码 1xxxxxxxx) / name(中文名) / desc / overallString，
// 这里补成和百鸽 cards.json 同构的结构（cn_name + text.types/desc），搜索、格式化、
// 随机卡、卡图下载都不需要改。
const SUPER_PRE_URL = 'https://cdntx.moecube.com/ygopro-super-pre/data/test-release-v2.json';
const SUPER_PRE_TIMEOUT_MS = Number(process.env.SUPER_PRE_TIMEOUT_MS || 30000);

// 判定「同一张卡」用的名称字段（与 ygocard.mjs 的 NAME_FIELDS 对齐）
const NAME_FIELDS = ['cn_name', 'sc_name', 'md_name', 'nwbbs_n', 'cnocg_n', 'jp_name', 'en_name'];

const norm = s => String(s ?? '').trim().toLowerCase();

// 拉萌卡超先行卡列表。失败就抛错，由调用方决定「不影响百鸽卡库」地继续。
export async function fetchSuperPreCards({ timeoutMs = SUPER_PRE_TIMEOUT_MS } = {}) {
  const res = await fetch(SUPER_PRE_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('超先行卡列表格式异常（不是非空数组）');
  return arr;
}

// 萌卡的 overallString 用两个空格分隔「种类行」和「等级/攻守行」，百鸽的
// text.types 用换行分隔（formatCard 直接打印），这里统一成换行。
//   "[怪兽|效果] 恶魔/暗  [★1] 300/200" -> "[怪兽|效果] 恶魔/暗\n[★1] 300/200"
export function superPreTypes(overall) {
  return String(overall ?? '').trim().replace(/\s{2,}/g, '\n');
}

// 把萌卡先行卡并进百鸽卡库对象（原地修改）。返回 { added, removed, total }。
//   - 先摘掉上一轮并入的先行条目（src==='superpre'），保证 desc/名称跟着萌卡更新；
//   - 再补入「百鸽还没有同名卡」的条目；
//   - 百鸽已收录同名卡的，不再补 —— 等价于先行条目自动退场。
export function mergeSuperPre(cards, list) {
  const officialNames = new Set();
  for (const c of Object.values(cards)) {
    if (!c || c.src === 'superpre') continue;
    for (const f of NAME_FIELDS) {
      const n = norm(c[f]);
      if (n) officialNames.add(n);
    }
  }

  let removed = 0;
  for (const [cid, c] of Object.entries(cards)) {
    if (c && c.src === 'superpre') { delete cards[cid]; removed++; }
  }

  let added = 0;
  for (const it of list) {
    const id = Number(it?.id);
    const name = String(it?.name ?? '').trim();
    if (!Number.isFinite(id) || id <= 0 || !name) continue;
    if (cards[String(id)]) continue;              // 同一密码已在（理论上不会和百鸽撞）
    if (officialNames.has(norm(name))) continue;  // 百鸽已正式收录 → 用百鸽那份，不重复
    cards[String(id)] = {
      cid: id,
      id,
      cn_name: name,
      text: {
        types: superPreTypes(it.overallString),
        pdesc: '',
        desc: String(it?.desc ?? '').replace(/\r\n/g, '\n').trim(),
      },
      data: { ot: 0, setcode: 0, type: 0, atk: 0, def: 0, level: 0, race: 0, attribute: 0 },
      src: 'superpre',                            // 标记来源：面板/排查用，合并时据此清理
    };
    added++;
  }

  return { added, removed, total: Object.keys(cards).length };
}

// 卡库里现在有多少张「超先行卡」
export function superPreCount(cards) {
  let n = 0;
  for (const c of Object.values(cards)) if (c && c.src === 'superpre') n++;
  return n;
}
