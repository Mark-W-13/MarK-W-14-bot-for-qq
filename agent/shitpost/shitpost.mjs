// 随机一搬: B站热门视频热评 → 硬排除 → 引战/逆天评分 → 加权随机选一条屎
// 数据源(纯 HTTP,零依赖):
//   B站热门视频 https://api.bilibili.com/x/web-interface/popular?ps=50
//   B站热评     https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&sort=2
// 输出: HTML 卡片 → Edge headless 截图 → base64 PNG
// 用法:
//   node shitpost.mjs              # 自测:抓候选+评分+打印选中(不截图)
//   node shitpost.mjs --image      # 自测:含截图,输出 png 路径
//   node shitpost.mjs --dump       # 打印候选池评分明细(调词表用)
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const TMP = join(__dirname, 'tmp');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const POPULAR_CACHE_TTL = 10 * 60 * 1000;   // 热门列表缓存 10 分钟
const REPLY_CACHE_TTL = 5 * 60 * 1000;      // 单视频热评缓存 5 分钟

let popularCache = null;
const replyCache = new Map();

// ---------- 抓取 ----------
async function fetchJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// 屎视频源库(用户投喂的 b23.tv 清单,随机一搬从这里抽)
const SHIT_VIDEOS_PATH = process.env.SHIT_VIDEOS_PATH
  || 'C:/Users/hp/.claude/projects/C--Users-hp-Desktop---mc-agent/memory/shitpost-videos.md';
// 黑名单(挥手负反馈;随机一搬过滤,不从源库抽取)
const SHIT_BLACKLIST_PATH = process.env.SHIT_BLACKLIST_PATH
  || 'C:/Users/hp/.claude/projects/C--Users-hp-Desktop---mc-agent/memory/shitpost-blacklist.md';

export function loadShitVideos() {
  try {
    const text = readFileSync(SHIT_VIDEOS_PATH, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^-\s*视频[:：]\s*(.+?)\s*\|\s*(b23\.tv\/\w+)\s*$/);
      if (m) out.push({ title: m[1].trim(), url: `https://${m[2]}` });
    }
    return out;
  } catch { return []; }
}

// 反馈入库:把搬得好的视频追加进屎视频源库(最上面),去重(BV 或标题已在库则跳过)
// 返回 'added' | 'duplicate' | 'error'
export function appendShitVideo({ bvid, title }) {
  try {
    const b = String(bvid || '');
    const t = String(title || '').trim();
    const short = `b23.tv/${b}`;
    const text = readFileSync(SHIT_VIDEOS_PATH, 'utf8');
    if (b && text.includes(short)) return 'duplicate';
    if (t && text.includes(t.slice(0, 15))) return 'duplicate';
    const line = `- 视频: ${t || b} | ${short}`;
    const lines = text.split('\n');
    const firstIdx = lines.findIndex(l => l.startsWith('- 视频:'));
    if (firstIdx >= 0) lines.splice(firstIdx, 0, line);
    else lines.push('', line);
    writeFileSync(SHIT_VIDEOS_PATH, lines.join('\n'), 'utf8');
    return 'added';
  } catch (e) { return 'error'; }
}

// ---------- 源库 LRU 记忆(返回屎时:近期刚返回过的源库视频不返,优先返最久没被返回的) ----------
const SEED_MEMORY_PATH = process.env.SEED_MEMORY_PATH || join(__dirname, 'seed_memory.json');
const SEED_MEMORY_RECENT_MS = Number(process.env.SEED_MEMORY_RECENT_MS || 24 * 3600 * 1000); // 近期窗口,默认 24h
const SHIT_LIB_CHANCE = Number(process.env.SHIT_LIB_CHANCE || 0.02);   // 源库 LRU 通道触发概率(默认 2%,0=永不——逻辑上尽量不搬源库)

export function loadSeedMemory() {
  try { return JSON.parse(readFileSync(SEED_MEMORY_PATH, 'utf8')); } catch { return {}; }
}
function saveSeedMemory(mem) {
  writeFileSync(SEED_MEMORY_PATH + '.tmp', JSON.stringify(mem, null, 1), 'utf8');
  renameSync(SEED_MEMORY_PATH + '.tmp', SEED_MEMORY_PATH);
}

// 记录刚被返回的源库视频(lastReturned/次数),顺手清掉已不在源库的旧记忆
function rememberReturned(v, aliveBvids) {
  const mem = loadSeedMemory();
  const alive = new Set(aliveBvids);
  for (const k of Object.keys(mem)) if (!alive.has(k)) delete mem[k];
  const prev = mem[v.bvid] || {};
  mem[v.bvid] = { lastReturned: Date.now(), count: (prev.count || 0) + 1, title: v.title.slice(0, 40) };
  saveSeedMemory(mem);
}

// 从「近期未返回」的源库候选中挑一条:越久没被返回权重越高(72h 封顶);没用过的等同满窗口
function pickLibraryVideo(eligible, mem) {
  const now = Date.now();
  const scored = eligible.map(s => {
    const m = mem[s.bvid];
    const hours = m ? (now - m.lastReturned) / 3600000 : SEED_MEMORY_RECENT_MS / 3600000;
    const w = (0.5 + Math.min(hours, 72)) * (0.8 + Math.random() * 0.4);
    return { s, w };
  });
  const total = scored.reduce((a, x) => a + x.w, 0);
  let r = Math.random() * total;
  for (const x of scored) { r -= x.w; if (r <= 0) return x.s; }
  return scored[scored.length - 1].s;
}

// ---------- 黑名单(挥手负反馈) ----------
export function loadBlacklist() {
  try {
    const text = readFileSync(SHIT_BLACKLIST_PATH, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^-\s*视频[:：]\s*(.+?)\s*\|\s*(b23\.tv\/(\w+))\s*$/);
      if (m) out.push({ title: m[1].trim(), bvid: m[3], url: `https://${m[2]}` });
    }
    return out;
  } catch { return []; }
}

const isBlacklisted = bvid => loadBlacklist().some(x => x.bvid === String(bvid));

// 负反馈入库(黑名单,去重);返回 'added' | 'duplicate' | 'error'
export function addToBlacklist({ bvid, title }) {
  try {
    const b = String(bvid || '');
    const short = `b23.tv/${b}`;
    const text = readFileSync(SHIT_BLACKLIST_PATH, 'utf8');
    if (b && text.includes(short)) return 'duplicate';
    const line = `- 视频: ${title || b} | ${short}`;
    const lines = text.split('\n');
    const firstIdx = lines.findIndex(l => l.startsWith('- 视频:'));
    if (firstIdx >= 0) lines.splice(firstIdx, 0, line);
    else lines.push('', line);
    writeFileSync(SHIT_BLACKLIST_PATH, lines.join('\n'), 'utf8');
    return 'added';
  } catch (e) { return 'error'; }
}

// 从屎视频源库移除指定 bvid 的条目(负反馈后不再当种子);返回是否移除
export function removeFromShitVideos(bvid) {
  try {
    const short = `b23.tv/${String(bvid)}`;
    const text = readFileSync(SHIT_VIDEOS_PATH, 'utf8');
    if (!text.includes(short)) return false;
    writeFileSync(SHIT_VIDEOS_PATH, text.split('\n').filter(l => !l.includes(short)).join('\n'), 'utf8');
    return true;
  } catch { return false; }
}

// b23.tv 短链 → BV id(跟随重定向,从最终 URL 提取)
export async function resolveBvid(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  const finalUrl = r.url || '';
  const m = finalUrl.match(/\/video\/(BV[\w]+)/);
  if (!m) throw new Error(`无法解析短链: ${url}`);
  return m[1];
}

// BV id → 视频详情(B站 view API)
export async function fetchVideoDetail(bvid) {
  const j = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (j.code !== 0) throw new Error(`B站视频 API: ${j.message || j.code}`);
  const d = j.data;
  return {
    bvid: d.bvid,
    title: d.title,
    pic: d.pic.replace(/^http:/, 'https:'),
    owner: d.owner?.name || 'UP主',
    tname: d.tname || '',
    view: d.stat?.view || 0,
    danmaku: d.stat?.danmaku || 0,
  };
}

// 随机一搬(主动爬取):源库随机抽 3 个种子视频 → 并行爬各自相关视频(同类抽象,高浓度)
// → 相关+热门 加权随机;另设源库 LRU 通道:近期未返回的源库视频按「多久没返」加权直接出镜
// (源库视频不混入爬取池,只在 LRU 通道出现;爬取失败/池过小时用 popular 池保底)
export async function pickVideoShit() {
  const black = loadBlacklist();
  const blacked = new Set(black.map(x => x.bvid));
  // 种子:源库随机,黑名单跳过;最多尝试 6 个源库条目,全黑则无种子
  const srcVideos = loadShitVideos().sort(() => Math.random() - 0.5);
  // 一次并行解析全部源库 BV,构成排除集:源库只作爬取源,任何路径都不直接出镜
  const resolvedSrc = (await Promise.all(srcVideos.map(async s => {
    try { return { ...s, bvid: await resolveBvid(s.url) }; } catch { return null; }
  }))).filter(Boolean);
  const srcSet = new Set(resolvedSrc.map(s => s.bvid));
  // 种子:源库随机 3 个(黑名单跳过),只作爬取源
  const seeds = [];
  for (const s of resolvedSrc) {
    if (seeds.length >= 3) break;
    if (blacked.has(s.bvid)) { console.log(`  黑名单跳过种子: ${s.title}`); continue; }
    seeds.push(s);
  }
  const pool = [];
  if (seeds.length) {
    // 种子只作为爬取源,不直接进爬取池(源库视频的出镜走下方 LRU 通道)
    await Promise.all(seeds.map(async s => {
      try {
        const rel = await fetchRelated(s.bvid);
        for (const v of rel) {
          if ((v.stat?.view || 0) < MIN_VIEW) continue; // 播放量下限(0 播放低质视频)
          if (isNotShit(v)) continue;               // 砍掉广告/资讯/攻略杂鱼
          if (blacked.has(v.bvid)) continue;        // 黑名单不推荐
          if (srcSet.has(v.bvid)) continue;         // 源库视频不直接出镜(相关池会带回其他种子)
          const s = videoShitScore(v);
          if (s < 8) continue;                      // 无梗特征的低分杂鱼不进池
          pool.push({ kind: 'rel', v, w: 5 + s });
        }
      } catch (e) { /* 单个种子失败不影响整体 */ }
    }));
  }
  if (pool.length < 20) {                          // 保底:相关爬取不足时混入热门池
    for (const v of await fetchPopularPool()) {
      if ((v.stat?.view || 0) < MIN_VIEW) continue;
      if (blacked.has(v.bvid)) continue;
      if (srcSet.has(v.bvid)) continue;             // 源库视频走 LRU 通道,不进爬取池
      const s = videoShitScore(v);
      if (s < 8) continue;
      pool.push({ kind: 'rank', v, w: 5 + s });
    }
  }
  // 源库 LRU 通道:逻辑上尽量不搬源库(主通道=爬取池),仅小概率(SHIT_LIB_CHANCE,默认 2%)触发;
  // 触发时:近期(默认 24h)刚返回过的源库视频不返,其余按「多久没被返回」加权选最久未返的
  const mem = loadSeedMemory();
  const now = Date.now();
  const eligible = resolvedSrc.filter(s =>
    !blacked.has(s.bvid)
    && !(mem[s.bvid] && now - mem[s.bvid].lastReturned < SEED_MEMORY_RECENT_MS)
  );
  if (eligible.length && Math.random() < SHIT_LIB_CHANCE) {
    try {
      const libPick = pickLibraryVideo(eligible, mem);
      const v = await fetchVideoDetail(libPick.bvid);
      rememberReturned(libPick, resolvedSrc.map(s => s.bvid));
      console.log(`  源库 LRU 通道: ${libPick.title.slice(0, 40)} (${v.bvid})`);
      return { v: { ...v, fromSource: libPick.title } };
    } catch (e) { console.log(`  源库通道失败,回退爬取池: ${e.message}`); }
  }
  if (!pool.length) throw new Error('无屎视频可搬');
  const total = pool.reduce((a, x) => a + x.w, 0);
  let r = Math.random() * total;
  let pick = pool[0];
  for (const x of pool) { r -= x.w; if (r <= 0) { pick = x; break; } }
  return { v: pick.v };
}

export async function fetchPopular() {
  if (popularCache && Date.now() - popularCache.t < POPULAR_CACHE_TTL) return popularCache.list;
  const j = await fetchJson('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1');
  if (j.code !== 0) throw new Error(`B站 API: ${j.message || j.code}`);
  popularCache = { t: Date.now(), list: j.data.list };
  return popularCache.list;
}

// 爬取池:popular 多页(1~5 页)合并去重,约 250 条,缓存 10 分钟
let poolCache = null;
const POOL_PAGES = 5;
export async function fetchPopularPool() {
  if (poolCache && Date.now() - poolCache.t < POPULAR_CACHE_TTL) return poolCache.list;
  const seen = new Set();
  const pool = [];
  for (let pn = 1; pn <= POOL_PAGES; pn++) {
    try {
      const j = await fetchJson(`https://api.bilibili.com/x/web-interface/popular?ps=50&pn=${pn}`);
      for (const v of (j.data?.list || [])) {
        if (seen.has(v.aid)) continue;
        seen.add(v.aid);
        pool.push(v);
      }
    } catch {}
  }
  if (!pool.length) throw new Error('B站热门池抓取失败');
  poolCache = { t: Date.now(), list: pool };
  return pool;
}

// 视频屎度评分(标题梗词 + 分区 + 弹幕密度 + 播放量共识)
function videoShitScore(v) {
  let s = Math.random() * 5;                    // 扰动,保证多样性
  if (CHAOS_TITLE.test(v.title)) s += 10;       // 标题自带逆天味
  if (CHAOS_TID.has(v.tid)) s += 6;             // 乐子分区(鬼畜/搞笑/日常/小剧场/生活/游戏)
  if (v.stat?.danmaku && v.stat?.view) {
    if (v.stat.danmaku / v.stat.view > 0.001) s += 6;   // 弹幕区在玩梗
  }
  if (v.stat?.view > 1000000) s += 3;           // 百万播放 ≈ 大众共识乐子
  return s;
}

// 非屎硬排除(资讯/广告/攻略/引流标题,相关池里的杂鱼)
const NOT_SHIT_TITLE = /推荐|选购|指南|测评|评测|教程|攻略|合集|全集|解说|爆料|上线|最新|盘点|汇总|解析|围观|求三连|点赞收藏|辟谣|科普|速看|年货节|带货/;
const isNotShit = v => NOT_SHIT_TITLE.test(v.title || '');
const MIN_VIEW = Number(process.env.SHIT_MIN_VIEW || 1000); // 播放量下限,滤掉 0 播放低质视频

// 相关视频(同类抽象内容,屎浓度高);按 bvid 缓存 5 分钟
const relatedCache = new Map();
const RELATED_CACHE_TTL = 5 * 60 * 1000;
export async function fetchRelated(bvid) {
  const hit = relatedCache.get(bvid);
  if (hit && Date.now() - hit.t < RELATED_CACHE_TTL) return hit.list;
  const j = await fetchJson(`https://api.bilibili.com/x/web-interface/archive/related?bvid=${bvid}`);
  if (j.code !== 0) throw new Error(`B站相关视频 API: ${j.message || j.code}`);
  const list = j.data || [];
  relatedCache.set(bvid, { t: Date.now(), list });
  return list;
}

export async function fetchComments(aid) {
  const hit = replyCache.get(aid);
  if (hit && Date.now() - hit.t < REPLY_CACHE_TTL) return hit.list;
  const j = await fetchJson(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&ps=20`);
  if (j.code !== 0) throw new Error(`B站评论 API: ${j.message || j.code}`);
  const list = j.data.replies || [];
  replyCache.set(aid, { t: Date.now(), list });
  return list;
}

// ---------- 视频挑选(逆天分区/标题加权) ----------
// 逆天视频更容易出逆天评论;标题含逆天词或属乐子分区 → 优先被选中
const CHAOS_TID = new Set([21, 85, 119, 138, 160, 155, 171, 4, 114, 182]); // 日常/小剧场/鬼畜/搞笑/生活/单机/游戏
const CHAOS_TITLE = /逆天|离谱|反转|震惊|案件|吐槽|避雷|翻车|塌房|自爆|抽象|乐子|整活|搞笑|抄袭|缝合|绷不住|蚌埠|笑死|猎奇|深夜|无语|求求|删评|对线|开撕|互撕|疑似|爆料/;

function pickVideos(list, n = 5) {
  const scored = list.map(v => {
    let s = 0;
    if (CHAOS_TITLE.test(v.title)) s += 12;
    if (CHAOS_TID.has(v.tid)) s += 6;
    if (v.stat?.danmaku && v.stat?.view) {
      const density = v.stat.danmaku / v.stat.view;   // 弹幕密度高 = 弹幕区在玩梗
      if (density > 0.001) s += 6;
    }
    s += Math.random() * 6;                            // 随机扰动,保证多样性
    return { v, s };
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, n).map(x => x.v);
}

// ---------- 硬排除(一票否决) ----------
const BLOCK_PATTERNS = [
  // 开盒/人肉(绝不搬:泄露真实身份信息)
  /(红薯|小红书|抖音|微博|快手|闲鱼|贴吧)[\s\S]{0,10}(?:id|号|账号|主页)|人肉|开盒|扒出|身份证|真实姓名|家庭住址|手机号|公司名|老板账号|微信号|企鹅号/,
  // 广告/引流
  /加\s*[Vv]|VX|微信|私信我|私聊|链接自取|代做|代刷|收徒|兼职|返利|扫码|点我头像|橱窗|商品链接/,
  // 纯表情/纯语气/无实质内容(零汉字: 「！！！！！」「6666」「yyds」)
  /^[^一-龥]+$/,
  // 纯语气词/单字刷屏(「哈哈哈哈哈」「就这就这就这」「绷不住了」)
  /^(?:哈|嘿|嘻|呵|啊|乐|笑|6|就这){2,}[~～!！。.、]?$/,
  /^(?:绷不住|蚌埠住|笑死|泪目|绝了|离谱|逆天|好活|典|孝|乐了|难绷)[~～!！。.、]*$/,
  // 纯吹捧/无信息(「这是XX发过最牛的彩蛋」「太棒了」)
  /(?:最(?:牛|强|顶|好|佳|神)|天花板|吹爆|直接封神|YYDS|yyds|太(?:棒|强|好|牛|喜欢)了|好(?:活|图|耶|耶|厉害))[~～!！。.]?$/,
  // 粉丝安利/小作文(「去电影院看的」「第一次看」「刷了N遍」)
  /去电影院|第一次看|刷了.{0,4}遍|已三连|投币了|爷青回|泪目了|我的青春|从{0,3}(?:高中|初中|大学).{0,8}追到|每(?:天|周).{0,8}(?:看|刷)/,
  // 长篇大道理(「关于…我的观点是」「我觉得应该」)
  /^关于|我的观点是|我觉得(?:应该|就是)|说白了|本质上/,
  // 删评/屏蔽标记残留
  /该评论涉嫌|已编辑|评论被屏蔽/,
];

function blocked(c) {
  const msg = c.content?.message || '';
  if (msg.length < 6 || msg.length > 120) return true;
  return BLOCK_PATTERNS.some(p => p.test(msg));
}

// ---------- 引战/逆天/梗 评分(非 AI 版的核心) ----------
// 每个命中项 +3~4 分;回复数(引战必吵)+赞(社区认可)另行加分
const SCORE_PATTERNS = [
  // 反问/质问(杠精起手式)
  { p: /[？?]{2,}|吗[？?]|是吧|难道|凭什么|真以为|不是.{0,8}[？?]|就这|也配|配吗|至于吗|有必要吗|谁在|什么时候.{0,6}[？?]/, w: 5 },
  // 阴阳怪气/嘲讽
  { p: /也就|而已|你说是吧|懂的都懂|孝|典|急了|破防|绷不住|蚌埠|乐了|笑死|哭死|抽象|逆天|离谱|震惊|贵物|典中典|乐子人|差不多得了|急了急了/, w: 5 },
  // 攻击/对立(抄/缝合/水军/饭圈…)
  { p: /抄|缝合|换皮|割韭菜|带节奏|水军|营销号|饭圈|孝子|双标|恰饭|洗地|脑瘫|脑残|睿智|沙口|送马|烂钱|恰米/, w: 5 },
  // 争议话题(性别/婚恋/生育/阶级)
  { p: /男的|女的|男人|女人|男宝|女权|彩礼|生孩子|怀孕|外遇|出轨|舔狗|龟男|捞女|小三|渣男|渣女|富哥|穷人|打工人|资本家|牛马/, w: 4 },
  // 拉踩/对比
  { p: /完爆|吊打|秒杀|薄纱|不如|比不上|碰瓷|对标/, w: 4 },
  // 玩梗句式
  { p: /了属于是|天又黑|这不是.{0,10}[？?]|居然|竟然|还可以这样|这都行|怎么做到的/, w: 3 },
  // 第二人称直接开火(「你也没上科隆」「你箭头叔叔」)
  { p: /你(?:也|就|真|这|那|们|叔|姨|妈|爹|大爷|看看|不是)/, w: 3 },
  // 语气词密度(感叹号/问号多)
  { p: /[！!]{2,}|[？?]{2,}/, w: 2 },
];

function scoreComment(c) {
  const msg = c.content?.message || '';
  let s = 0;
  for (const { p, w } of SCORE_PATTERNS) if (p.test(msg)) s += w;
  const like = c.like || 0;
  const rcount = c.rcount || 0;
  s += Math.min(like / 200, 1) * 6;                    // 高赞 ≈ 社区投票认可
  if (rcount >= 20) s += 12;                           // 引战必吵:高回复强信号
  else if (rcount >= 8) s += 8;
  else if (rcount >= 3) s += 4;
  if (msg.length >= 10 && msg.length <= 90) s += 2;    // 适中长度更有信息量
  return s;
}

// 加权随机(分数高的更可能被选中,但不保证,保证随机性)
function weightedPick(scored) {
  const total = scored.reduce((a, x) => a + x.s, 0);
  let r = Math.random() * total;
  for (const x of scored) { r -= x.s; if (r <= 0) return x; }
  return scored[scored.length - 1];
}

// ---------- 主流程: 选一条屎 ----------
// mode: 'random' = 纯规则加权随机 / 'ai' = 规则粗筛后交给 claude 精挑
export async function pickShit(mode = 'random', claudePick = null) {
  const list = await fetchPopular();
  const videos = pickVideos(list, 5);
  const candidates = [];
  for (const v of videos) {
    let reps;
    try { reps = await fetchComments(v.aid); } catch { continue; }
    const scored = [];
    for (const c of reps) {
      if (blocked(c)) continue;
      const s = scoreComment(c);
      if (s >= 8) scored.push({ c, v, s });
    }
    scored.sort((a, b) => b.s - a.s);
    candidates.push(...scored.slice(0, 6));           // 每视频最多 6 条,防单个高争议视频垄断
  }
  if (!candidates.length) throw new Error('本轮无屎可搬');
  if (mode === 'ai' && claudePick) {
    const chosen = await claudePick(candidates);       // 由调用方提供 claude 精挑函数
    if (chosen) return chosen;
    return weightedPick(candidates);                   // AI 失效时优雅降级为规则随机
  }
  return weightedPick(candidates);
}

// ---------- 截图渲染: HTML → Edge headless → base64 PNG ----------
const fmt = n => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n));

export function buildCardHtml(shit, badge = '随机一搬') {
  const { c, v } = shit;
  const msg = (c.content?.message || '').replace(/\n+/g, '\n');
  const like = fmt(c.like || 0);
  const view = fmt(v.stat?.view || 0);
  const nick = c.member?.uname || '神秘网友';
  const avatar = (c.member?.avatar || '').replace(/^http:/, 'https:');
  const lines = Math.ceil(msg.length / 36);            // 宽 620 内边距 40 ≈ 580px,16px 字 ≈ 36 字/行
  const H = 150 + lines * 26 + 60;                     // 标题区 + 正文 + 底部,行高 26
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return {
    width: 620, height: H,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f1f2f3;font-family:"Microsoft YaHei",sans-serif;width:620px;color:#18191c}
.card{background:#fff;margin:10px;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.video{display:flex;gap:10px;padding:14px;border-bottom:1px solid #eee}
.video .cover{width:96px;height:60px;object-fit:cover;border-radius:6px;background:#e5e6e7;flex-shrink:0}
.video .info{flex:1;min-width:0}
.video .title{font-size:14px;font-weight:bold;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.video .meta{font-size:11px;color:#9499a0;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.comment{display:flex;gap:12px;padding:14px 14px 10px}
.avatar{width:44px;height:44px;border-radius:50%;background:#e8eef7;flex-shrink:0;font-size:22px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover}
.cbody{flex:1;min-width:0}
.nick{font-size:12px;color:#9499a0;display:flex;gap:8px;align-items:center}
.nick .uname{color:#61666d;font-weight:bold;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.content{font-size:15px;line-height:26px;margin-top:6px;white-space:pre-wrap;word-break:break-all}
.like{font-size:11px;color:#c0c4cc;margin-top:8px;display:flex;align-items:center;gap:4px}
.footer{padding:10px 14px;font-size:11px;color:#9499a0;border-top:1px solid #f4f4f5;display:flex;justify-content:space-between}
.badge{color:#fb7299;font-weight:bold}
.link{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head><body><div class="card">
<div class="video"><img class="cover" src="${esc(v.pic)}" alt=""><div class="info">
<div class="title">${esc(v.title)}</div>
<div class="meta">${esc(v.owner?.name || 'UP主')} · ${view}播放 · ${esc(v.bvid)}</div></div></div>
<div class="comment"><div class="avatar"><img src="${esc(avatar)}" alt=""></div><div class="cbody">
<div class="nick"><span class="uname">${esc(nick)}</span><span>${like} 赞</span></div>
<div class="content">${esc(msg)}</div>
<div class="like">💬 ${fmt(c.rcount || 0)} 回复</div></div></div>
<div class="footer"><span class="badge">【${badge}】</span><span class="link">b23.tv/${v.bvid}</span></div>
</div></body></html>`,
  };
}

// 视频封面卡片(随机一搬:封面大图 + 标题 + UP主 + 链接)
export function buildVideoCardHtml(v, badge = '随机一搬') {
  const view = fmt(v.stat?.view || v.view || 0);   // 爬取池字段是 stat.view,详情 API 是 view
  const owner = typeof v.owner === 'string' ? v.owner : (v.owner?.name || 'UP主');
  const title = v.fromSource && v.fromSource !== v.title ? `${v.title}\n(源:${v.fromSource})` : v.title;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const width = 620;
  const height = 380 + 96 + 46;                     // 封面 350 + 标题区 + 底栏
  return {
    width, height,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f1f2f3;font-family:"Microsoft YaHei",sans-serif;width:${width}px;color:#18191c}
.card{background:#fff;margin:10px;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.cover{width:100%;height:350px;object-fit:cover;display:block;background:#e5e6e7}
.info{padding:12px 14px}
.title{font-size:15px;font-weight:bold;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{font-size:12px;color:#9499a0;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.footer{padding:10px 14px;font-size:11px;color:#9499a0;border-top:1px solid #f4f4f5;display:flex;justify-content:space-between}
.badge{color:#fb7299;font-weight:bold}
.link{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head><body><div class="card">
<img class="cover" src="${esc(v.pic)}" alt="">
<div class="info"><div class="title">${esc(title)}</div>
<div class="meta">${esc(owner)} · ${view}播放 · ${esc(v.bvid)}${v.tname ? ' · ' + esc(v.tname) : ''}</div></div>
<div class="footer"><span class="badge">【${badge}】</span><span class="link">b23.tv/${v.bvid}</span></div>
</div></body></html>`,
  };
}

// Edge headless 截图 → 返回 PNG 绝对路径
export function renderCard(card) {
  const { html, width, height } = card;
  mkdirSync(TMP, { recursive: true });
  const htmlPath = join(TMP, 'card.html');
  const pngPath = join(TMP, 'card.png');
  writeFileSync(htmlPath, html, 'utf8');
  return new Promise((resolve, reject) => {
    const url = `file:///${htmlPath.replace(/\\/g, '/')}`;
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run',
      '--run-all-compositor-stages-before-draw', '--virtual-time-budget=8000',
      `--window-size=${width},${height}`,
      `--screenshot=${pngPath}`,
      `--user-data-dir=${join(TMP, 'edge_prof')}`,
      url,
    ];
    const child = spawn(EDGE, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Edge 启动失败: ${e.message}`)); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (!existsSync(pngPath)) return reject(new Error(`截图失败(exit ${code})`));
      resolve(pngPath);
    });
  });
}

export function pngToSegment(pngPath) {
  const b64 = readFileSync(pngPath).toString('base64');
  return { type: 'image', data: { file: `base64://${b64}` } };
}

// ---------- 命令行自测 ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv[2] || '';
  (async () => {
    if (flag === '--seed-memory') {
      const mem = loadSeedMemory();
      const entries = Object.entries(mem).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      if (!entries.length) { console.log('源库记忆为空(还没有源库视频被返回过)'); return; }
      console.log(`源库 LRU 记忆 ${entries.length} 条(旧→新,窗口 ${SEED_MEMORY_RECENT_MS / 3600000}h,窗口内不返):`);
      for (const [bvid, m] of entries) {
        console.log(`  ${new Date(m.lastReturned).toLocaleString('zh-CN', { hour12: false })} | x${m.count} | ${bvid} | ${(m.title || '').slice(0, 40)}`);
      }
      return;
    }
    const list = await fetchPopular();
    const videos = pickVideos(list, 5);
    console.log(`热门 ${list.length} 条,选中视频:`);
    for (const v of videos) console.log(`  [${v.tname}] ${v.title.slice(0, 50)}`);
    if (flag === '--dump') {
      for (const v of videos) {
        const reps = await fetchComments(v.aid);
        console.log(`\n「${v.title.slice(0, 45)}」热评 ${reps.length} 条,过滤后:`);
        for (const c of reps) {
          if (blocked(c)) continue;
          const s = scoreComment(c);
          if (s >= 8) console.log(`  +${String(s).padStart(3)} [赞${c.like} 回${c.rcount} ${(c.content?.message || '').length}字] ${(c.content?.message || '').replace(/\n/g, ' ').slice(0, 60)}`);
        }
      }
      return;
    }
    if (flag === '--video') {
      const { v } = await pickVideoShit();
      console.log(`选中屎视频${v.fromSource ? '[源库]' : '[爬取]'}: ${v.title} (${v.bvid})`);
      const png = await renderCard(buildVideoCardHtml(v));
      console.log(`  截图: ${png}`);
      return;
    }
    const shit = await pickShit('random');
    console.log(`\n选中屎: ${shit.s} 分`);
    console.log(`  视频: ${shit.v.title}`);
    console.log(`  评论: ${shit.c.content?.message}`);
    if (flag === '--image') {
      const png = await renderCard(buildCardHtml(shit));
      console.log(`  截图: ${png}`);
    }
  })().catch(e => { console.error('错误:', e.message); process.exit(1); });
}
