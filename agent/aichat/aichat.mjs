// AI 闲聊的消息解析(2026-09-13 落地):把一条 QQ 消息里除文字以外的东西全部还原成模型看得懂的文字
//   ① @某人      → 查群名片换成「@昵称」(机器人自己被 @ → 「@你(史官)」)
//   ② 引用消息   → get_msg 取回被引的那条,摊平成「[引用 @昵称: 内容]」(它自己带图也一并识别)
//   ③ QQ 表情    → face id 查表换成「[表情:微笑]」(表见同目录 qq_faces.json)
//   ④ 图片/表情包 → 两轮对话:第 1 轮把图单独交给视觉模型识别成一句话描述,
//                  第 2 轮把描述按**原位置**拼回正文,再交给对话模型生成回复。
// 素材与结论(勿重复踩):
//   · 表情 id:OneBot face 段的 id 就是 SnowLuma 表情目录的 qSid(0=惊讶 14=微笑 5=流泪,实测对得上),
//     原始目录在 <SnowLuma>/data/sys-face-catalog.json,已导出为同目录 qq_faces.json(283 条)。
//   · 图片段形如 {type:'image',data:{url,file,sub_type,summary}};sub_type=1/7 是表情包(动画表情/商城表情),
//     url 带 rkey 会过期 → 只能即时下载,别想着存库复用;file 是图片内容 md5,可当缓存键(表情包翻来覆去就那几个)。
//   · 视觉模型 glm-4v-flash(免费)。**必须传 base64**:直接给它 QQ 的 url 会被判「图片输入格式/解析错误」;
//     而且原图常有几 MB,同样被拒 → 先用 ffmpeg 缩到长边 ≤1024 的 JPEG(几十 KB)再传,实测稳。
//     注意体积集中在**动画表情**上:实测有 12MB 的表情包,画面却只有 282x500(体积全在动画帧里),
//     所以限制按字节卡(32MB),解码内存不用担心;AI 缩放也串行做,别在这台 2GB 的共享机上并发解大图。
//   · 引用段的 id 可能是负数(实测 -1137349949),get_msg 收 int / str 都行,能取回原消息。
// 用法:
//   node aichat.mjs --selftest           # 自测:纯函数(段解析/正文渲染)+ 表情表 + 图片缩放
//   node aichat.mjs --image <路径|URL>   # 自测:视觉模型对一张图的描述
//   node aichat.mjs --render <json文件>  # 自测:真实消息(OneBot 原始消息或 inbox 条目)→ 打印模型看到的正文
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// env 一律**延迟读**:monitor.mjs 的 import 先于它自己加载 .env,模块顶层读 env 会读到 undefined
const glmKey = () => process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || '';
const visionModel = () => process.env.GLM_VISION_MODEL || 'glm-4v-flash';
const glmUrl = () => process.env.GLM_API_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const maxImages = () => Math.max(0, Number(process.env.AI_CHAT_MAX_IMAGES ?? 3));      // 单条消息最多识别几张图
const maxSide = () => Number(process.env.AI_CHAT_IMG_MAX_SIDE || 1024);                // 送模型前缩到长边不超过这个数
const imgTimeoutMs = () => Number(process.env.AI_CHAT_IMG_TIMEOUT_MS || 15000);        // 图片下载超时
const visionTimeoutMs = () => Number(process.env.AI_CHAT_VISION_TIMEOUT_MS || 30000);  // 视觉模型超时
const ffmpegBin = () => process.env.FFMPEG_BIN || 'ffmpeg';
const botIdOf = deps => String(deps?.botId || process.env.BOT_ID || '');

// ---------- QQ 表情 id → 名称 ----------
// 表来自 SnowLuma 的表情目录(SnowLuma 升级新增的表情不会自动进来,要重新导出;
// 表里没有只影响那一个表情显示成 [表情#id],不影响回复)
let faceTable = null;
export function faceLabel(id) {
  if (!faceTable) {
    faceTable = {};
    const file = process.env.QQ_FACE_CATALOG || join(__dirname, 'qq_faces.json');
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(j.packs)) {   // 直接指向 SnowLuma 的 sys-face-catalog.json 也能用
        for (const p of j.packs) {
          for (const e of p.emojis || []) {
            const sid = String(e.qSid ?? '');
            if (/^\d+$/.test(sid) && !faceTable[sid]) faceTable[sid] = String(e.qDes || '').replace(/^\//, '');
          }
        }
      } else {
        for (const [k, v] of Object.entries(j)) if (/^\d+$/.test(k)) faceTable[k] = String(v);
      }
    } catch { /* 表缺失 → 退化成 [表情#id] */ }
  }
  return faceTable[String(id)] || '';
}

// ---------- 消息段 → token ----------
// 兼容两种形态:OneBot 原始段 {type,data:{...}} 与 monitor 存进 inbox 的裁剪段 {type,...}
function normSeg(seg) {
  const type = seg?.type;
  if (!type) return null;
  const d = seg.data || seg;
  switch (type) {
    case 'text': return { kind: 'text', text: String(d.text ?? '') };
    case 'at': return { kind: 'at', qq: String(d.qq ?? '') };
    case 'face': return { kind: 'face', id: String(d.id ?? '') };
    case 'image': return { kind: 'image', url: String(d.url || ''), file: String(d.file || ''), summary: String(d.summary || ''), sub: Number(d.sub_type ?? d.sub ?? 0) };
    case 'mface': return { kind: 'image', url: String(d.url || ''), file: String(d.emoji_id || d.file || ''), summary: String(d.summary || ''), sub: 1 };
    case 'reply': return { kind: 'quote', id: String(d.id ?? '') };
    case 'video': case 'record': case 'forward': case 'json': case 'file': case 'markdown':
      return { kind: 'other', type };
    default: return { kind: 'other', type };
  }
}
export function parseSegments(segs) {
  const out = [];
  for (const s of segs || []) {
    const t = normSeg(s);
    if (t) out.push(t);
  }
  return out;
}

// 老 inbox 条目(没有 segs)的降级路径:text 里只剩 [at] / [image] 这类占位符,按占位符还原成 token。
// 拿不到 url 与 qq,所以 @ 只会显示成「@某人」、图片只会显示成「没能识别」。
export function parseLegacyText(text) {
  const out = [];
  for (const part of String(text || '').split(/(\[[a-z_]+\])/)) {
    if (!part) continue;
    const m = part.match(/^\[([a-z_]+)\]$/);
    if (!m) { out.push({ kind: 'text', text: part }); continue; }
    if (m[1] === 'at') out.push({ kind: 'at', qq: '' });
    else if (m[1] === 'image' || m[1] === 'mface') out.push({ kind: 'image', url: '', file: '', summary: '', sub: 0 });
    else if (m[1] === 'face') out.push({ kind: 'face', id: '' });
    else out.push({ kind: 'other', type: m[1] });
  }
  return out;
}

const OTHER_LABEL = { video: '[视频]', record: '[语音]', forward: '[转发消息]', json: '[分享卡片]', file: '[文件]', markdown: '[富文本]' };

// ---------- 图片:下载 → 缩放 → 视觉模型识别(第 1 轮) ----------
const descCache = new Map();   // file(md5) → 描述;表情包翻来覆去就那几个,缓存能省掉大半调用
const DESC_CACHE_MAX = 300;

let ffmpegOk = null;
function hasFfmpeg() {
  if (ffmpegOk === null) {
    try { ffmpegOk = spawnSync(ffmpegBin(), ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0; }
    catch { ffmpegOk = false; }
  }
  return ffmpegOk;
}

async function downloadImage(url) {
  if (!url) return null;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(imgTimeoutMs()) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('空内容');
  // QQ 的动画表情(表情包)动辄 3~12MB,但画面只有几百像素 —— 尺寸不是问题,下载体积才是,
  // 所以卡的是字节数;真到几十 MB 的多半是原图,直接放弃比拖垮整条回复强。
  if (buf.length > 32 * 1024 * 1024) throw new Error('图片过大(>32MB)');
  return buf;
}

const isSticker = tk => tk.sub === 1 || tk.sub === 7 || /动画表情/.test(tk.summary || '');
// 表情自带的说明(如 sub_type=7 的商城表情 summary 就是它的名字「原来是这样」),能给视觉模型当提示
const summaryHint = tk => {
  const s = String(tk.summary || '').replace(/^\[|\]$/g, '').trim();
  return s && !['图片', '动画表情', '表情'].includes(s) ? `(这个表情叫「${s}」)` : '';
};

// 缩成 JPEG:GLM-4V 收不下 3MB+ 的原图,缩到长边 ≤maxSide 只剩几十 KB,又快又稳。
// 没有 ffmpeg 时退化成「小图原样传,大图放弃」。
function shrinkToJpeg(buf) {
  if (!hasFfmpeg()) return buf.length <= 1.5 * 1024 * 1024 ? buf : null;
  const dir = join(tmpdir(), 'aichat');
  const tag = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const src = join(dir, `${tag}.img`);
  const dst = join(dir, `${tag}.jpg`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(src, buf);
    const r = spawnSync(ffmpegBin(), [
      '-y', '-loglevel', 'error', '-i', src,
      '-vf', `scale='min(${maxSide()},iw)':-2`,   // 只缩不放(小图保持原样)
      '-frames:v', '1', '-an', '-q:v', '4', dst,
    ], { timeout: 20000 });
    if (r.status !== 0 || !existsSync(dst)) return null;
    const out = readFileSync(dst);
    return out.length ? out : null;
  } catch {
    return null;
  } finally {
    for (const f of [src, dst]) { try { unlinkSync(f); } catch {} }
  }
}

async function visionDescribe(buf, seg) {
  const what = isSticker(seg) ? '一张自定义表情(表情包)' : '一张图片(可能是截图/照片/梗图)';
  const hint = summaryHint(seg);
  const ask = what.includes('表情包')
    ? `${what}${hint}。用一两句中文(60 字内)说清:画面里是什么 + 它想表达什么情绪或梗。只输出描述本身,别客套。`
    : `${what}${hint}。用一两句中文(60 字内)说清:画面里是什么;图上有文字就只挑关键的一两句读。只输出描述本身,别客套。`;
  const r = await fetch(glmUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${glmKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: visionModel(),
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: buf.toString('base64') } },
        { type: 'text', text: ask },
      ] }],
      temperature: 0.6,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(visionTimeoutMs()),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${j?.error?.message || ''}`.trim());
  // 个别视觉模型会吐 <think> 推理段,去掉只留正文
  let text = (j?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('视觉模型返回空描述');
  text = text.replace(/\s*\n\s*/g, ' ');
  // 模型嘴上答应「60 字内」,实际常写成一段;硬截,免得把正文撑爆
  return text.length > 160 ? text.slice(0, 160) + '…' : text;
}

// 识别一批图片,返回与输入等长的数组,元素为描述或 null(没识别出来)。
// 三段分开做:下载并发(只吃网络)、缩放串行(ffmpeg 解大图吃内存,这台机器只剩 ~800MB,别并发)、
// 识别并发(此时传的都是几十 KB 的 JPEG)。
async function describeImages(tokens, log = () => {}) {
  const limit = maxImages();
  const items = tokens.map((tk, i) => {
    if (i >= limit) { log(`  第 ${i + 1} 张图超出上限(限 ${limit} 张),不识别`); return null; }
    if (!glmKey()) return null;
    const ck = tk.file || tk.url;
    const hit = ck ? descCache.get(ck) : null;
    if (hit) { log(`  图片命中缓存: ${hit.slice(0, 40)}`); return { tk, ck, desc: hit }; }
    return { tk, ck };
  });

  await Promise.all(items.map(async it => {
    if (!it || it.desc) return;
    try { it.buf = await downloadImage(it.tk.url); } catch (e) { log(`  图片下载失败: ${e.message}`); }
  }));

  for (const it of items) {
    if (!it || it.desc || !it.buf) continue;
    it.jpg = shrinkToJpeg(it.buf);
    it.buf = null;   // 大 buffer 用完即弃,不等 GC
    if (!it.jpg) log('  图片缩放失败,跳过');
  }

  await Promise.all(items.map(async it => {
    if (!it || it.desc || !it.jpg) return;
    try {
      it.desc = await visionDescribe(it.jpg, it.tk);
      if (it.ck) {
        if (descCache.size >= DESC_CACHE_MAX) descCache.delete(descCache.keys().next().value);
        descCache.set(it.ck, it.desc);
      }
      log(`  图片识别(${Math.round(it.jpg.length / 1024)}KB): ${it.desc.slice(0, 50)}`);
    } catch (e) {
      log(`  图片识别失败: ${e.message}`);
    }
  }));

  return items.map(it => it?.desc || null);
}

// ---------- 引用 / @ ----------
async function fetchQuote(id, deps) {
  if (!id || !deps.getMsg) return null;
  try {
    const n = Number(id);
    const j = await deps.getMsg(Number.isFinite(n) ? n : id);
    const m = j?.data;
    if (!m || !m.message) return null;
    return { userId: String(m.user_id ?? ''), name: m.sender?.card || m.sender?.nickname || '', segs: m.message };
  } catch { return null; }
}

async function nameOf(qq, deps) {
  if (!qq) return '';
  if (qq === botIdOf(deps)) return '你(史官)';
  try { return (await deps.memberName?.(qq)) || `成员${qq}`; }
  catch { return `成员${qq}`; }
}

// ---------- 正文渲染(第 2 轮:把第 1 轮的图片描述按原位拼回) ----------
function renderToken(tk, descs, deps) {
  switch (tk.kind) {
    case 'text': return tk.text;
    case 'at': return tk.qq === botIdOf(deps) ? '@你(史官)' : (tk.name ? `@${tk.name}` : (tk.qq ? `@成员${tk.qq}` : '@某人'));
    case 'face': return `[表情${faceLabel(tk.id) ? ':' + faceLabel(tk.id) : (tk.id ? '#' + tk.id : '')}]`;
    case 'image': {
      const d = descs[tk.idx];
      const what = isSticker(tk) ? '表情包' : '图片';
      return d ? `[${what}: ${d}]` : `[${what}(没能识别)]`;
    }
    case 'quote': {
      if (!tk.inner) return '[引用(取不到)]';
      const body = tk.inner.map(t => renderToken(t, descs, deps)).join('').trim();
      return `[引用 ${tk.quoteName ? '@' + tk.quoteName + ': ' : ''}${body || '(空)'}]`;
    }
    default: return OTHER_LABEL[tk.type] || `[${tk.type}]`;
  }
}

/**
 * 一条消息 → 给模型看的正文(第 1 轮识别图片,第 2 轮拼合)。
 * @param entry inbox 条目(需 segs;老条目只有 text 时走降级解析)
 * @param deps  { memberName(qq)→昵称, getMsg(id)→OneBot 响应, botId, log }
 * @returns {Promise<string>} 形如「@小红 [表情:流泪] 这图 [图片: 一只黄色小鸡] 好看吗」
 */
export async function buildQuestion(entry, deps = {}) {
  const log = deps.log || (() => {});
  const tokens = (entry.segs && entry.segs.length) ? parseSegments(entry.segs) : parseLegacyText(entry.text);

  // 引用:先取回被引消息(只展开一层)
  for (const tk of tokens) {
    if (tk.kind !== 'quote') continue;
    const q = await fetchQuote(tk.id, deps);
    if (!q) continue;
    tk.quoteName = q.name || await nameOf(q.userId, deps);
    tk.inner = parseSegments(q.segs);
  }

  // @ → 昵称(机器人自己被 @ 固定渲染成「你(史官)」,不必查群名片)
  for (const tk of tokens) {
    if (tk.kind === 'at' && tk.qq !== botIdOf(deps)) tk.name = await nameOf(tk.qq, deps);
  }

  // 第 1 轮:正文里的图 + 被引消息里的图一起识别(共用同一个上限),编号与最后渲染的顺序一致
  const imgTokens = [];
  const collect = list => { for (const t of list) if (t.kind === 'image') { t.idx = imgTokens.length; imgTokens.push(t); } };
  collect(tokens);
  for (const tk of tokens) if (tk.inner) collect(tk.inner);
  const descs = imgTokens.length ? await describeImages(imgTokens, log) : [];

  // 第 2 轮:按原位置拼回正文
  return tokens.map(tk => renderToken(tk, descs, deps)).join('').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}

// ---------- 自测 ----------
function assert(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) process.exitCode = 1;
}

async function selftest() {
  assert(faceLabel('14') === '微笑' && faceLabel('5') === '流泪' && faceLabel('0') === '惊讶',
    `表情表: 14=${faceLabel('14')} 5=${faceLabel('5')} 0=${faceLabel('0')} 共 ${Object.keys(faceTable).length} 条`);
  assert(faceLabel('99999') === '', '表外 id 返回空(渲染成 [表情#99999])');

  const raw = [
    { type: 'reply', data: { id: '-1137349949' } },
    { type: 'at', data: { qq: '3757588606' } },
    { type: 'text', data: { text: '你看 ' } },
    { type: 'at', data: { qq: '3204936056' } },
    { type: 'face', data: { id: '5' } },
    { type: 'image', data: { url: 'https://example.com/a.png', file: 'a.png', sub_type: 1, summary: '[动画表情]' } },
    { type: 'text', data: { text: ' 这图啥意思' } },
  ];
  const tk = parseSegments(raw);
  assert(tk.map(t => t.kind).join('/') === 'quote/at/text/at/face/image/text', `段解析: ${tk.map(t => t.kind).join('/')}`);

  const deps = {
    botId: '3757588606',
    memberName: async qq => (qq === '3204936056' ? 'sayori' : ''),
    getMsg: async () => ({ data: { user_id: '2', sender: { card: '小明' }, message: [
      { type: 'text', data: { text: '这也太帅了' } },
      { type: 'image', data: { file: 'q.png', sub_type: 0 } },
    ] } }),
    log: () => {},
  };
  // 视觉模型不可用(无 key / 无 url)时图片渲染成「没能识别」,这里只校验其余部分
  const rendered = await buildQuestion({ text: 'x', segs: raw, group_id: 1 }, deps);
  console.log(`  渲染: ${rendered}`);
  assert(rendered.includes('[引用 @小明: 这也太帅了[图片(没能识别)]]'), '引用摊平 + 引用里的图一并处理');
  assert(rendered.includes('@你(史官)') && rendered.includes('@sayori'), '@ 换成昵称');
  assert(rendered.includes('[表情:流泪]'), '表情 id 换成名字');
  assert(rendered.includes('[表情包(没能识别)]'), '表情包(sub_type=1)按表情包渲染');

  // 老 inbox 条目(只有 text):认得出占位符,但拿不到 qq 与 url → @ 只能写成「@某人」
  const legacy = await buildQuestion({ text: '[at] 每日一卡[image]', segs: null }, deps);
  assert(legacy === '@某人 每日一卡[图片(没能识别)]', `老条目降级解析: ${legacy}`);

  // 紧凑形态(monitor 存进 inbox 的裁剪段)也要认得
  const compact = await buildQuestion({ segs: [
    { type: 'text', text: '来 ' }, { type: 'face', id: '14' }, { type: 'image', url: 'u', file: 'f', summary: '[动画表情]', sub: 1 },
  ] }, deps);
  assert(compact === '来 [表情:微笑][表情包(没能识别)]', `裁剪段形态: ${compact}`);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const jpg = shrinkToJpeg(png);
  assert(!!jpg && (!hasFfmpeg() || (jpg[0] === 0xff && jpg[1] === 0xd8)),
    `图片缩放: ${jpg ? `${jpg.length}B${hasFfmpeg() ? ' JPEG' : ' 原样(无 ffmpeg)'}` : '失败'}(ffmpeg=${hasFfmpeg()})`);
}

// ---------- CLI ----------
// 读 ../.env(与 monitor 同一份),CLI 自测时直连本机 OneBot(只调只读 action)
function cliEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return env;
}
async function cliDeps(groupId) {
  const env = cliEnv();
  process.env.API = process.env.API || env.API || 'http://127.0.0.1:3000/';
  process.env.API_TOKEN = process.env.API_TOKEN || env.API_TOKEN || '';
  process.env.BOT_ID = process.env.BOT_ID || env.BOT_ID || '3757588606';
  process.env.ZHIPU_API_KEY = process.env.ZHIPU_API_KEY || env.ZHIPU_API_KEY || '';
  const api = async (action, params) => (await fetch(process.env.API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  })).json();
  const cache = new Map();
  return {
    botId: process.env.BOT_ID,
    getMsg: id => api('get_msg', { message_id: id }),
    memberName: async qq => {
      if (!cache.has(qq)) {
        const j = await api('get_group_member_info', { group_id: groupId, user_id: Number(qq) }).catch(() => null);
        cache.set(qq, j?.data?.card || j?.data?.nickname || '');
      }
      return cache.get(qq);
    },
  };
}

async function main() {
  const [a, b] = process.argv.slice(2);
  if (!a || a === '--selftest') return selftest();
  if (a === '--image') {
    if (!b) { console.log('用法: node aichat.mjs --image <路径|URL>'); process.exit(1); }
    if (!glmKey()) { Object.assign(process.env, { ZHIPU_API_KEY: cliEnv().ZHIPU_API_KEY || '' }); }
    const buf = /^https?:/.test(b) ? await downloadImage(b) : readFileSync(b);
    const jpg = shrinkToJpeg(buf);
    console.log(`原图 ${(buf.length / 1024).toFixed(0)}KB → ${jpg ? `${(jpg.length / 1024).toFixed(0)}KB JPEG` : '缩放失败'}`);
    console.log('识别:', await visionDescribe(jpg || buf, { sub: 0, summary: '' }));
    return;
  }
  if (a === '--render') {
    if (!b) { console.log('用法: node aichat.mjs --render <json文件>'); process.exit(1); }
    const j = JSON.parse(readFileSync(b, 'utf8'));
    const entry = j.message ? { text: j.raw_message || '', segs: j.message, group_id: j.group_id } : j;  // OneBot 原始消息也能直接喂
    console.log(await buildQuestion(entry, { ...await cliDeps(entry.group_id), log: console.log }));
    return;
  }
  console.log('用法: node aichat.mjs [--selftest | --image <路径|URL> | --render <json文件>]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('失败:', e.message); process.exit(1); });
}
