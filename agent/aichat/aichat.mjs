// AI 闲聊的消息解析(2026-09-13 落地):把一条 QQ 消息里除文字以外的东西全部还原成模型看得懂的文字
//   ① @某人      → 查群名片换成「@昵称」(机器人自己被 @ → 「@你(史官)」)
//   ② 引用消息   → get_msg 取回被引的那条,摊平成「[引用 @昵称: 内容]」(它自己带图也一并识别)
//   ③ QQ 表情    → face id 查表换成「[表情:微笑]」(表见同目录 qq_faces.json)
//   ④ 图片/表情包 → 两轮对话:第 1 轮把图单独交给视觉模型(画面描述 + **图上文字逐字抄全**),
//                  第 2 轮把结果按**原位置**拼回正文,再交给对话模型生成回复。
// 素材与结论(勿重复踩):
//   · 表情 id:OneBot face 段的 id 就是 SnowLuma 表情目录的 qSid(0=惊讶 14=微笑 5=流泪,实测对得上),
//     原始目录在 <SnowLuma>/data/sys-face-catalog.json,已导出为同目录 qq_faces.json(283 条)。
//   · 图片段形如 {type:'image',data:{url,file,sub_type,summary}};sub_type=1/7 是表情包(动画表情/商城表情),
//     url 带 rkey 会过期 → 只能即时下载,别想着存库复用;file 是图片内容 md5,可当缓存键(表情包翻来覆去就那几个)。
//   · 视觉模型 glm-4v-flash(免费)。**必须传 base64**:直接给它 QQ 的 url 会被判「图片输入格式/解析错误」;
//     而且原图常有几 MB,同样被拒 → 先用 ffmpeg 转成 JPEG(几十 KB~几百 KB)再传,实测稳。
//     注意体积集中在**动画表情**上:实测有 12MB 的表情包,画面却只有 282x500(体积全在动画帧里),
//     所以限制按字节卡(32MB),解码内存不用担心;AI 转码也串行做,别在这台 2GB 的共享机上并发解大图。
//   · **长截图要切块**(2026-09-13 实测):视觉模型 max_tokens 上限就是 1024,60 行的截图整张传过去
//     只能抄到 46 行就断(标「…这一段没抄完」);按 ~800px 高切块后各块独立抄、再接缝去重,
//     覆盖率 68% → 76%,普通的十几二十行截图则是 91%~100%(剩下的是小模型本身的错字/漏行,认了)。
//     ⚠ 切块后**每块仍用同一套提示词**:一提「这是第 N/M 段、只处理这一段」,模型就只抄十来行收工。
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

// 转 JPEG **并按需切片**(用户 2026-09-13:图上的字要完整识别):
//   · GLM-4V 收不下几 MB 的原图 → 必须转 JPEG 压体积;
//   · 长截图(聊天记录那种)若整张按长边压到 ~1024,字会变小、错字猛增 ——
//     实测同一张 780x1400 的群聊截图:整张认成「外印机 / 送代 / 人人要」,
//     按 780x700 切两半后全部认对。所以**按宽度限幅、再按高度切块**,每块保持原始字号观感;
//   · 切块顺带绕开视觉模型 max_tokens=1024 的输出上限(一块抄满了还有下一块)。
// 没有 ffmpeg 时退化成「小图原样传,大图放弃」。
const maxChunks = () => Math.max(1, Number(process.env.AI_CHAT_IMG_CHUNKS || 3));   // 单张图最多切几块
// 一块多高:800px 实测能一次抄满 30 行(再高就会被 max_tokens 截断);块高与宽度上限分开设,
// 宽度用 maxSide(1024)限幅 —— 按长边限幅会把长图压小才是错的。
const chunkHeight = () => Math.max(200, Number(process.env.AI_CHAT_IMG_CHUNK_H || 800));

/** 切片方案(纯函数,便于自测):按宽度限幅后,把高度切成 ≤chunkMax 的若干块,块间留 overlap 重叠防切断行 */
export function planChunks(w, h, side = maxSide(), chunkCap = maxChunks(), chunkMax = chunkHeight()) {
  const s = Math.min(1, side / w);                       // 只缩不放
  const W = Math.max(2, Math.round(w * s / 2) * 2);
  const H = Math.max(2, Math.round(h * s / 2) * 2);
  const n = Math.min(chunkCap, Math.max(1, Math.ceil(H / chunkMax)));
  const chunkH = Math.max(2, Math.ceil(H / n / 2) * 2);
  const overlap = n > 1 ? Math.min(60, Math.max(2, Math.round(chunkH * 0.15 / 2) * 2)) : 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = i === 0 ? 0 : Math.max(0, i * chunkH - overlap);
    const hh = Math.min(H - y, chunkH + (i === 0 ? 0 : overlap));
    if (hh < 8) break;
    out.push({ W, H, y, h: hh });
  }
  return out;
}

function ffmpegRun(args) {
  try { return spawnSync(ffmpegBin(), args, { timeout: 30000 }).status === 0; }
  catch { return false; }
}
function ffprobeSize(file) {
  try {
    const r = spawnSync(process.env.FFPROBE_BIN || 'ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
    ], { timeout: 15000, encoding: 'utf8' });
    const [w, h] = String(r.stdout || '').trim().split(',').map(Number);
    return w > 0 && h > 0 ? { w, h } : null;
  } catch { return null; }
}

// 入:原图 buffer;出:待识别的 JPEG 块数组(≥1 块;空数组=放弃)
function toJpegChunks(buf) {
  if (!hasFfmpeg()) return buf.length <= 1.5 * 1024 * 1024 ? [{ buf }] : [];
  const dir = join(tmpdir(), 'aichat');
  const tag = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const src = join(dir, `${tag}.img`);
  const made = [];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(src, buf);
    const dim = ffprobeSize(src);
    const chunks = dim ? planChunks(dim.w, dim.h) : [{ W: null, H: null, y: 0, h: null }];
    const out = [];
    for (const c of chunks) {
      const dst = join(dir, `${tag}_${c.y}.jpg`);
      const vf = c.W
        ? (c.y === 0 && c.h === c.H ? `scale=${c.W}:${c.H}` : `scale=${c.W}:${c.H},crop=${c.W}:${c.h}:0:${c.y}`)
        : `scale='min(${maxSide()},iw)':-2`;   // 探测失败 → 退回整张缩一下
      if (!ffmpegRun(['-y', '-loglevel', 'error', '-i', src, '-vf', vf, '-frames:v', '1', '-an', '-q:v', '2', dst])) continue;
      if (!existsSync(dst)) continue;
      made.push(dst);
      const jpg = readFileSync(dst);
      if (jpg.length) out.push({ buf: jpg });
    }
    return out;
  } catch {
    return [];
  } finally {
    for (const f of [src, ...made]) { try { unlinkSync(f); } catch {} }
  }
}

/** 合并多块抄回来的文字:块间有重叠,按「前文后缀 == 后文前缀」去掉接缝重复 */
export function stitchText(parts) {
  let out = '';
  for (const raw of parts) {
    const t = String(raw || '').trim();
    if (!t) continue;
    if (!out) { out = t; continue; }
    let cut = 0;
    const max = Math.min(80, out.length, t.length);
    for (let n = max; n >= 8; n--) {
      if (out.slice(-n) === t.slice(0, n)) { cut = n; break; }
    }
    out += (cut ? '' : ' ') + t.slice(cut);
  }
  return out;
}

const DESC_MAX_CHARS = Number(process.env.AI_CHAT_IMG_TEXT_MAX || 1500);   // 单张图描述+抄字的硬上限

// 图上文字**逐字抄全**(用户 2026-09-13 定):截图/聊天记录/公告/梗图上的字都要完整带回去,
// 不许总结、不许「挑关键的一两句」——最早那版这么写,截图里的正文全被丢掉了。
// 输出约定:第一段是画面描述,有文字时再给一段「文字:」,由 splitVision 拆开。
// ⚠ 每一块都用**同一套**提示词,别对模型提「这是第 N/M 段、只处理这一段」——
// 实测:同一张 780x700 的图,不提分段能抄满 29 行,一提「第 1/2 段」就只抄 11 行收工。
// 分块对模型透明:它只看见一张图,照抄即可;拼接与去重由 stitchText 负责。
function visionAsk(seg) {
  const sticker = isSticker(seg);
  const what = sticker ? '一张自定义表情(表情包)' : '一张图片(可能是截图/照片/梗图,常来自群聊或网页)';
  return [
    `这是 QQ 群聊消息里插的${what}${summaryHint(seg)}。`,
    `先写画面:一两句中文说清画面里是什么${sticker ? ',以及它想表达的情绪或梗' : ''}。`,
    `再抄文字:图上**只要有文字,就一字不差地完整抄下来**(截图里的正文、聊天记录、公告、表格、梗图上的字都算),`,
    `不要总结、不要省略、不要改写、不要只挑几句,多长都照抄。确实没有文字,这一段就整个不写。`,
    ``,
    `严格按下面两段输出,不要别的内容:`,
    `画面: <描述>`,
    `文字: <逐字全文>`,
  ].join('\n');
}

// 一块图 → 视觉模型原始输出(未解析)
async function visionRaw(buf, seg) {
  const r = await fetch(glmUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${glmKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: visionModel(),
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: buf.toString('base64') } },
        { type: 'text', text: visionAsk(seg) },
      ] }],
      temperature: 0.3,          // 抄字要的是忠实,不是发挥
      max_tokens: 1024,          // 抄满:视觉模型的上限就是 1024(写 2000 直接 400:max_tokens参数非法)
    }),
    signal: AbortSignal.timeout(visionTimeoutMs()),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${j?.error?.message || ''}`.trim());
  // 个别视觉模型会吐 <think> 推理段,去掉只留正文
  let text = (j?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('视觉模型返回空描述');
  // 输出被 token 上限截断 —— 标出来,免得对话模型以为图上就这么多字
  if (j?.choices?.[0]?.finish_reason === 'length') text += '…(这一段没抄完)';
  return text;
}

/** 单张图(可能切了多块)→ 一行「描述;文字:…」;模型不按格式来时原样压成一行(内容一条不丢) */
export async function visionDescribe(chunks, seg) {
  const raws = await Promise.all(chunks.map(c => visionRaw(c.buf, seg)));
  const parts = raws.map(splitVision);
  const desc = parts[0].desc;
  const words = stitchText(parts.map(p => p.words));
  const text = words ? (desc ? `${desc};文字:${words}` : `文字:${words}`) : desc;
  // 极端图(整页小说)才截,且标明
  return text.length > DESC_MAX_CHARS ? text.slice(0, DESC_MAX_CHARS) + '…(文字过长,后面还有,已截断)' : text;
}

/** 「画面: … / 文字: …」→ { desc, words };模型不按格式来时整段当描述收下,内容不丢 */
export function splitVision(raw) {
  const text = String(raw || '').trim();
  const flat = s => s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  const m = text.match(/(?:^|\n)\s*(?:文字|文字内容|图上文字)\s*[:：]\s*([\s\S]*)$/);
  const desc = flat(m ? text.slice(0, m.index) : text).replace(/^画面\s*[:：]\s*/, '');
  const words = m ? flat(m[1]).replace(/^\(无文字\)$/, '') : '';
  return { desc, words };
}

/** 单块图(未切片)的最终文本,等价于 splitVision 的拼回形式;自测与 --image 用 */
export function formatVision(raw) {
  const { desc, words } = splitVision(raw);
  if (!words) return desc;
  return desc ? `${desc};文字:${words}` : `文字:${words}`;
}

// 识别一批图片,返回与输入等长的数组,元素为描述或 null(没识别出来)。
// 分三段做:下载并发(只吃网络)、切片串行(ffmpeg 解大图吃内存,这台机器只剩 ~800MB,别并发)、
// 识别并发(此时传的都是几十 KB 的 JPEG;长截图的各块也并行,总耗时约等于一块)。
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
    it.chunks = toJpegChunks(it.buf);
    it.buf = null;   // 大 buffer 用完即弃,不等 GC
    if (!it.chunks.length) log('  图片转码失败,跳过');
    else if (it.chunks.length > 1) log(`  长图切了 ${it.chunks.length} 块(整张的字太小,认不准)`);
  }

  await Promise.all(items.map(async it => {
    if (!it || it.desc || !it.chunks?.length) return;
    try {
      it.desc = await visionDescribe(it.chunks, it.tk);
      if (it.ck) {
        if (descCache.size >= DESC_CACHE_MAX) descCache.delete(descCache.keys().next().value);
        descCache.set(it.ck, it.desc);
      }
      const kb = Math.round(it.chunks.reduce((n, c) => n + c.buf.length, 0) / 1024);
      log(`  图片识别(${kb}KB): ${it.desc.slice(0, 50)}`);
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

  // 图上文字:模型按「画面: / 文字:」两段回,拼成一行给对话模型(文字一字不动)
  assert(formatVision('画面: 一张群聊截图\n文字: 你好\n在吗') === '一张群聊截图;文字:你好 在吗',
    `图文拼接: ${formatVision('画面: 一张群聊截图\n文字: 你好\n在吗')}`);
  assert(formatVision('画面: 一只黄猫') === '一只黄猫', `无文字时只留画面: ${formatVision('画面: 一只黄猫')}`);
  assert(formatVision('文字: 仅文字截图') === '文字:仅文字截图', `只有文字: ${formatVision('文字: 仅文字截图')}`);
  assert(formatVision('一只猫在键盘上') === '一只猫在键盘上', `模型不按格式来时原样收下: ${formatVision('一只猫在键盘上')}`);

  // 切片方案:宽 780 的长截图按宽度限幅后切块,块高不超过上限、块间有重叠
  const cs = planChunks(780, 1400, 1024, 3);
  assert(cs.length === 2 && cs.every(c => c.h <= 1024) && cs[1].y < cs[0].h,
    `切片: 780x1400 → ${cs.map(c => `${c.W}x${c.h}@y${c.y}`).join(' + ')}`);
  assert(planChunks(1200, 3000, 1024, 3).length === 3, '很高的图最多切 3 块(块内再高也保证覆盖全图)');
  assert(planChunks(800, 600, 1024, 3).length === 1, '矮图不切');
  assert(planChunks(4000, 3000, 1024, 3)[0].W === 1024, '超宽图按宽度限幅到 1024');

  // 接缝去重:后一块开头与前一串结尾重叠的部分不重复计入
  const st = stitchText(['8:00 小明|今天下午三点开会,记得带上上周的报表', '记得带上上周的报表和客户反馈清单']);
  assert(st === '8:00 小明|今天下午三点开会,记得带上上周的报表和客户反馈清单', `接缝去重: ${st}`);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const chunks = toJpegChunks(png);
  const jpg = chunks[0]?.buf;
  assert(chunks.length === 1 && !!jpg && (!hasFfmpeg() || (jpg[0] === 0xff && jpg[1] === 0xd8)),
    `图片转码: ${jpg ? `1 块 ${jpg.length}B${hasFfmpeg() ? ' JPEG' : ' 原样(无 ffmpeg)'}` : '失败'}(ffmpeg=${hasFfmpeg()})`);
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
    const chunks = toJpegChunks(buf);
    console.log(`原图 ${(buf.length / 1024).toFixed(0)}KB → ${chunks.length} 块 JPEG,共 ${(chunks.reduce((n, c) => n + c.buf.length, 0) / 1024).toFixed(0)}KB`);
    console.log('识别:', await visionDescribe(chunks, { sub: 0, summary: '' }));
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
