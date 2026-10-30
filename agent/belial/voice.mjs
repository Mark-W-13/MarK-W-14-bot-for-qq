// 贝利亚模式的语音接口(2026-10-27)
//
// 调研结论:
//   · Fish Audio 有现成的贝利亚声源(如 1aa6ac8870a14950ba4159fed7dab9a9),但服务端网络连不上
//     fish.audio / api.fish.audio(超时),且正式 API 需要 key;所以只把 Fish 作为可选项预留。
//   · Microsoft Edge TTS 在线合成可用、免 key、中文男声够低沉;服务端已装 edge-tts 7.3.1。
//     默认 belial 声源 = Edge zh-CN-YunjianNeural 压低音高/放慢,作为贝利亚声源的替代。
//   · 已验证:Edge 合成 MP3 → OneBot record(base64) → SnowLuma 自动转 SILK → QQ 语音发送成功。
//
// 给模型的接口在 tools.mjs(list_voices / send_voice);模型自己选 voice + 说 text。
import './../env.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.BELIAL_VOICE_CACHE_DIR || join(__dirname, 'voice_cache');
export const MAX_VOICE_CHARS = Math.max(1, Number(process.env.BELIAL_VOICE_MAX_CHARS || 120));
export const MAX_VOICE_BYTES = Math.max(64 * 1024, Number(process.env.BELIAL_VOICE_MAX_BYTES || 5 * 1024 * 1024));
export const MAX_VOICES = Math.max(1, Number(process.env.BELIAL_MAX_VOICES || 1));
export const VOICE_TIMEOUT_MS = Math.max(5000, Number(process.env.BELIAL_VOICE_TIMEOUT_MS || 30000));

const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const MIMO_KEY = () => process.env.MIMO_API_KEY || '';
const MIMO_BASE = () => (process.env.MIMO_TTS_BASE_URL || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
const MIMO_MODEL = () => process.env.MIMO_TTS_MODEL || 'mimo-v2.5-tts-voiceclone';
const MIMO_REF = () => process.env.MIMO_BELIAL_REF || join(__dirname, 'voice_ref', 'belial_zh.mp3');
const MIMO_INSTRUCTION = () => process.env.MIMO_BELIAL_INSTRUCTION || '低沉、沙哑、阴冷、傲慢,像银河皇帝贝利亚在群里嘲弄人;语速偏慢,句尾带一点不屑。';
const MIMO_KLEE_REF = () => process.env.MIMO_KLEE_REF || join(__dirname, 'voice_ref', 'klee_zh.mp3');
const MIMO_KLEE_INSTRUCTION = () => process.env.MIMO_KLEE_INSTRUCTION || '可莉(原神):稚嫩、活泼、天真、有点小得意;语速轻快,句尾上扬,像在跟人炫耀。';
const MIMO_LAOMUSHI_REF = () => process.env.MIMO_LAOMUSHI_REF || join(__dirname, 'voice_ref', 'laomushi_ref.wav');
const MIMO_LAOMUSHI_INSTRUCTION = () => process.env.MIMO_LAOMUSHI_INSTRUCTION || '老牧师(红肠口音):东北哈尔滨中年男声,略沙哑、慢悠悠、像在唠嗑,带点抽象和一本正经的幽默。';
const MIMO_TIMEOUT_MS = () => Math.max(10000, Number(process.env.MIMO_TTS_TIMEOUT_MS || 60000));
const mimoReadyFor = (v) => !!MIMO_KEY() && !!v?.mimo?.ref && existsSync(v.mimo.ref);
const VOICE_STATE_PATH = () => process.env.BELIAL_VOICE_STATE_PATH || join(__dirname, 'voice_state.json');
export const VOICE_MODES = ['belial', 'klee', 'laomushi'];
const FISH_KEY = () => process.env.FISH_AUDIO_API_KEY || '';
const FISH_BASE = () => (process.env.FISH_AUDIO_BASE_URL || 'https://api.fish.audio').replace(/\/+$/, '');
const FISH_MODEL = () => process.env.FISH_AUDIO_MODEL || 'speech-1.1';
const FISH_BELIAL = () => process.env.FISH_AUDIO_BELIAL_MODEL || '1aa6ac8870a14950ba4159fed7dab9a9';

// Edge 的中文声源。belial 用 Yunjian(成熟男声)压 -12Hz、放慢 8%,听起来最像低沉反派。
// 其余声源给模型在反串/整活时选;平时应该用 belial。
const VOICES = [
  {
    id: 'belial', label: '贝利亚(默认·MiMo 克隆)', provider: 'auto',
    desc: 'MiMo voiceclone 优先(用贝利亚参考音频);没配 key 时回退 Edge 低沉男声',
    edge: { voice: 'zh-CN-YunjianNeural', rate: '-8%', pitch: '-12Hz' },
    mimo: { model: MIMO_MODEL(), ref: MIMO_REF(), instruction: MIMO_INSTRUCTION() },
    fish: { reference: FISH_BELIAL() },
  },
  {
    id: 'belial_edge', label: '贝利亚(Edge 清楚)', provider: 'edge',
    desc: 'Edge 低沉男声,比默认清楚一点;觉得默认太闷时用',
    edge: { voice: 'zh-CN-YunjianNeural', rate: '-4%', pitch: '-8Hz' },
  },
  {
    id: 'belial_natural', label: '贝利亚(自然版)', provider: 'edge',
    desc: '之前那版:Yunxi 自然、接近聊天;不像原声,但顺耳',
    edge: { voice: 'zh-CN-YunxiNeural', rate: '-2%', pitch: '-3Hz' },
  },
  {
    id: 'klee', label: '可莉(原神)', provider: 'auto',
    desc: '可莉音色:稚嫩、活泼、天真;MiMo 用可莉参考音频克隆,没配时回退 Edge 童声',
    edge: { voice: 'zh-CN-XiaoyiNeural', rate: '+4%', pitch: '+10Hz' },
    mimo: { model: MIMO_MODEL(), ref: MIMO_KLEE_REF(), instruction: MIMO_KLEE_INSTRUCTION() },
  },
  {
    id: 'laomushi', label: '老牧师(红肠口音)', provider: 'auto',
    desc: 'B站老牧师红肠口音:东北中年男声、略沙哑、慢悠悠、抽象;MiMo 克隆,没配时回退 Edge 低沉男声',
    edge: { voice: 'zh-CN-YunjianNeural', rate: '-2%', pitch: '-4Hz' },
    mimo: { model: MIMO_MODEL(), ref: MIMO_LAOMUSHI_REF(), instruction: MIMO_LAOMUSHI_INSTRUCTION() },
  },
  {
    id: 'emperor', label: '皇帝/旁白', provider: 'edge',
    desc: '新闻腔、端正、有权威感;适合摆皇帝架子、念原剧台词',
    edge: { voice: 'zh-CN-YunyangNeural', rate: '-6%', pitch: '-8Hz' },
  },
  {
    id: 'young', label: '年轻男声', provider: 'edge',
    desc: '年轻、轻快、带点阴阳怪气;适合嘲讽/装傻',
    edge: { voice: 'zh-CN-YunxiNeural', rate: '-2%', pitch: '-4Hz' },
  },
  {
    id: 'female', label: '女声', provider: 'edge',
    desc: '女声;反串、整活、装无辜时用',
    edge: { voice: 'zh-CN-XiaoxiaoNeural', rate: '-2%', pitch: '+0Hz' },
  },
  {
    id: 'funny', label: '东北女声', provider: 'edge',
    desc: '东北口音、搞笑;纯整活时用',
    edge: { voice: 'zh-CN-liaoning-XiaobeiNeural', rate: '-2%', pitch: '+0Hz' },
  },
];

/** 声源目录(给 list_voices 工具/CLI) */
export function voiceCatalog() {
  return VOICES.map(v => ({
    id: v.id, label: v.label, desc: v.desc,
    provider: v.provider === 'auto'
      ? (mimoReadyFor(v) ? 'mimo' : (v.id === 'belial' && FISH_KEY() ? 'fish' : 'edge'))
      : v.provider,
    available: true,
  }));
}

export function voiceCatalogText() {
  const belial = VOICES.find(v => v.id === 'belial');
  const klee = VOICES.find(v => v.id === 'klee');
  const laomushi = VOICES.find(v => v.id === 'laomushi');
  const status = [];
  if (mimoReadyFor(belial)) status.push('MiMo 贝利亚已配置');
  if (mimoReadyFor(klee)) status.push('MiMo 可莉已配置');
  if (mimoReadyFor(laomushi)) status.push('MiMo 老牧师已配置');
  if (FISH_KEY()) status.push('Fish 已配置');
  if (!status.length) status.push('MiMo/Fish 未配置,当前 Edge 替代');
  return `当前默认声线:${voiceModeLabel(readVoiceMode())}\n可用声源:\n` + VOICES.map(v => {
    const extra = v.provider === 'auto' ? `(${status.join('; ')})` : '';
    return `- ${v.id}: ${v.label} — ${v.desc}${extra}`;
  }).join('\n');
}

/** 把模型给的 voice id 解析成实际配置;未知 id 回落到 belial */
export function resolveVoice(id = 'belial') {
  const key = String(id || '').trim().toLowerCase();
  const base = VOICES.find(v => v.id === key) || VOICES[0];
  const provider = base.provider === 'auto'
    ? (mimoReadyFor(base) ? 'mimo' : (base.id === 'belial' && FISH_KEY() ? 'fish' : 'edge'))
    : base.provider;
  return { ...base, provider };
}

/** 当前默认声线(WebUI 按钮/模型 send_voice 默认都用它);每次现读,两个进程共享 */
export function readVoiceMode() {
  try {
    const j = JSON.parse(readFileSync(VOICE_STATE_PATH(), 'utf8'));
    const v = String(j?.voice || '').toLowerCase();
    if (VOICE_MODES.includes(v)) return v;
  } catch { /* 没有/坏了 → 默认贝利亚 */ }
  return 'belial';
}

export function voiceModeLabel(mode = readVoiceMode()) {
  return mode === 'klee' ? '可莉' : mode === 'laomushi' ? '老牧师' : '贝利亚';
}

/** 切换默认声线;返回 {ok, voice, message} */
export function setVoiceMode(mode) {
  const v = String(mode || '').trim().toLowerCase();
  if (!VOICE_MODES.includes(v)) return { ok: false, message: '声线只能是 belial / klee / laomushi' };
  try {
    const p = VOICE_STATE_PATH();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p + '.tmp', JSON.stringify({ voice: v, updatedAt: Date.now() }, null, 2), 'utf8');
    renameSync(p + '.tmp', p);
    return { ok: true, voice: v, message: `默认声线已切到${voiceModeLabel(v)}` };
  } catch (e) {
    return { ok: false, message: `写声线状态失败:${e.message}` };
  }
}

/** 给 TTS 的文本做轻量清理:去 markdown/链接,补句末标点(有标点才有自然停顿/落调) */
function normalizeSpeech(text) {
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\.{3,}/g, '…')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (!/[。！？!?…]$/.test(s)) s += '。';
  return s.slice(0, MAX_VOICE_CHARS);
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let err = '';
    let done = false;
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill('SIGKILL'); } catch {}
      reject(new Error(`语音合成超时(${timeoutMs}ms)`));
    }, timeoutMs);
    p.stderr.on('data', d => { err += String(d); });
    p.on('error', e => {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(new Error(`语音合成启动失败:${e.message}`));
    });
    p.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`语音合成失败(exit ${code}):${err.slice(-300)}`));
    });
  });
}

/** Edge TTS:python3 -m edge_tts → mp3 */
async function edgeTTS(text, v, out) {
  if (!v.edge) throw new Error('这个声源没有 Edge 配置');
  await run(PYTHON, [
    '-m', 'edge_tts',
    '--voice', v.edge.voice,
    `--rate=${v.edge.rate}`,
    `--pitch=${v.edge.pitch}`,
    '--volume=+0%',
    '--text', text,
    '--write-media', out,
  ], VOICE_TIMEOUT_MS);
  if (!existsSync(out) || statSync(out).size < 1024) throw new Error('Edge TTS 没有产出有效音频');
}

/** MiMo 云端 voiceclone:几秒参考音频 + 目标文本 → mp3(免费额度,需 MIMO_API_KEY) */
async function mimoTTS(text, v, out) {
  if (!MIMO_KEY()) throw new Error('没配 MIMO_API_KEY');
  const ref = v.mimo?.ref || MIMO_REF();
  if (!existsSync(ref)) throw new Error(`贝利亚参考音频不存在:${ref}`);
  const refBuf = readFileSync(ref);
  // 文档:参考音频 base64 ≤10MB,只收 mp3/wav
  if (refBuf.length > 7.5 * 1024 * 1024) throw new Error('参考音频太大(MiMo 限 base64 ≤10MB)');
  const refExt = extname(ref).toLowerCase();
  if (!['.mp3', '.wav'].includes(refExt)) throw new Error('MiMo 参考音频只支持 mp3/wav');
  const mime = refExt === '.wav' ? 'audio/wav' : 'audio/mpeg';
  const body = {
    model: v.mimo?.model || MIMO_MODEL(),
    messages: [
      { role: 'user', content: v.mimo?.instruction || MIMO_INSTRUCTION() },
      { role: 'assistant', content: text },
    ],
    audio: {
      format: 'mp3',
      voice: `data:${mime};base64,${refBuf.toString('base64')}`,
    },
  };
  const r = await fetch(`${MIMO_BASE()}/chat/completions`, {
    method: 'POST',
    headers: { 'api-key': MIMO_KEY(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MIMO_TIMEOUT_MS()),
  });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`MiMo HTTP ${r.status} ${detail.slice(0, 200)}`.trim());
  }
  if (ct.startsWith('audio/')) {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) throw new Error('MiMo 返回的音频为空');
    if (buf.length > MAX_VOICE_BYTES) throw new Error('MiMo 返回的音频太大');
    writeFileSync(out, buf);
    return;
  }
  const j = await r.json().catch(() => null);
  let data = j?.choices?.[0]?.message?.audio?.data;
  if (!data) throw new Error(`MiMo 没返回音频:${JSON.stringify(j).slice(0, 240)}`);
  if (String(data).startsWith('data:')) data = String(data).split(',', 2)[1] || '';
  const buf = Buffer.from(String(data), 'base64');
  if (buf.length < 1024) throw new Error('MiMo 返回的音频为空');
  if (buf.length > MAX_VOICE_BYTES) throw new Error('MiMo 返回的音频太大');
  writeFileSync(out, buf);
}

/** Fish Audio(可选):需要 FISH_AUDIO_API_KEY,且服务器能访问 fish.audio */
async function fishTTS(text, v, out) {
  if (!FISH_KEY()) throw new Error('没配 FISH_AUDIO_API_KEY');
  const body = {
    text,
    reference_id: v.fish?.reference || FISH_BELIAL(),
    format: 'mp3',
    mp3_bitrate: 128,
    latency: 'normal',
  };
  const r = await fetch(`${FISH_BASE()}/v1/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FISH_KEY()}`,
      'Content-Type': 'application/json',
      model: FISH_MODEL(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Fish HTTP ${r.status} ${detail.slice(0, 160)}`.trim());
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1024) throw new Error('Fish 返回的音频为空');
  if (buf.length > MAX_VOICE_BYTES) throw new Error('Fish 返回的音频太大');
  writeFileSync(out, buf);
}

/**
 * 合成一条语音,带本地缓存(同一句话 + 同一音色只合成一次)。
 * @returns {{ok:boolean, path?:string, voice?:string, label?:string, provider?:string, cached?:boolean, size?:number, error?:string}}
 */
export async function synthesizeVoice(text, voiceId = 'belial', { log = () => {} } = {}) {
  const clean = normalizeSpeech(text);
  if (!clean) return { ok: false, error: '语音文本为空' };
  const v = resolveVoice(voiceId);
  // 缓存 key 带上音色/语速/音高/参考音频:改默认声源或换参考音频后不会误用旧音频
  const refSig = v.mimo?.ref && existsSync(v.mimo.ref) ? `${v.mimo.ref}:${statSync(v.mimo.ref).mtimeMs}` : '';
  const sig = `${v.id}|${v.provider}|${v.edge?.voice || ''}|${v.edge?.rate || ''}|${v.edge?.pitch || ''}|${v.mimo?.model || ''}|${refSig}|${v.mimo?.instruction || ''}|${clean}`;
  const hash = createHash('sha256').update(sig).digest('hex').slice(0, 32);
  let out = join(CACHE_DIR, `${hash}.mp3`);
  try {
    if (existsSync(out) && statSync(out).size > 1024) {
      return { ok: true, path: out, voice: v.id, label: v.label, provider: v.provider, cached: true, size: statSync(out).size };
    }
  } catch { /* 缓存坏了就重合成 */ }
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { return { ok: false, error: `缓存目录创建失败:${e.message}` }; }

  let provider = v.provider;
  // MiMo/Fish 失败回退 Edge 时用独立缓存文件:以后 key 修好不会误用「MiMo key 下缓存的 Edge 音频」
  const fallbackEdge = async () => {
    provider = 'edge';
    const ehash = createHash('sha256').update(`${sig}|edge-fallback`).digest('hex').slice(0, 32);
    out = join(CACHE_DIR, `${ehash}.mp3`);
    try {
      if (existsSync(out) && statSync(out).size > 1024) return;
    } catch {}
    await edgeTTS(clean, v, out);
  };
  try {
    if (provider === 'mimo') {
      try {
        await mimoTTS(clean, v, out);
      } catch (e) {
        log('  MiMo 语音失败,回退 Edge:', e.message);
        await fallbackEdge();
      }
    } else if (provider === 'fish') {
      try {
        await fishTTS(clean, v, out);
      } catch (e) {
        log('  Fish 语音失败,回退 Edge:', e.message);
        await fallbackEdge();
      }
    } else {
      await edgeTTS(clean, v, out);
    }
  } catch (e) {
    try { if (existsSync(out)) unlinkSync(out); } catch {}
    return { ok: false, error: e.message || String(e) };
  }
  let size = 0;
  try { size = statSync(out).size; } catch {}
  if (!size) return { ok: false, error: '合成后没有音频文件' };
  if (size > MAX_VOICE_BYTES) return { ok: false, error: `音频太大(${Math.round(size / 1024 / 1024)}MB)` };
  return { ok: true, path: out, voice: v.id, label: v.label, provider, cached: false, size };
}

/** 音频文件 → OneBot record 段(base64;SnowLuma 会自己转 SILK) */
export function voiceSegment(path) {
  try {
    const buf = readFileSync(path);
    if (!buf.length || buf.length > MAX_VOICE_BYTES) return null;
    return { type: 'record', data: { file: `base64://${buf.toString('base64')}` } };
  } catch {
    return null;
  }
}

// CLI: node voice.mjs --voices | --say "本大爷来了" [--voice belial] | --selftest
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--voices')) {
    console.log(voiceCatalogText());
  } else if (args.includes('--selftest')) {
    const checks = [];
    const add = (ok, msg) => { checks.push([ok, msg]); console.log(`${ok ? '✓' : '✗'} ${msg}`); };
    add(voiceCatalog().some(v => v.id === 'belial'), '声源目录有 belial');
    add(resolveVoice('belial').edge.voice === 'zh-CN-YunjianNeural', 'belial 默认映射回低沉 Yunjian 声');
    add(resolveVoice('belial_edge').edge.rate === '-4%', 'belial_edge 清楚版可用');
    add(resolveVoice('belial_natural').edge.voice === 'zh-CN-YunxiNeural', 'belial_natural 自然版可选');
    add(voiceCatalog().some(v => v.id === 'klee') && resolveVoice('klee').edge.voice === 'zh-CN-XiaoyiNeural',
      '可莉声源存在,Edge 回退用 Xiaoyi 童声');
    add(voiceCatalog().some(v => v.id === 'laomushi') && resolveVoice('laomushi').edge.voice === 'zh-CN-YunjianNeural',
      '老牧师声源存在,Edge 回退用 Yunjian');
    add(VOICE_MODES.includes('belial') && VOICE_MODES.includes('klee') && VOICE_MODES.includes('laomushi'),
      '声线模式有贝利亚/可莉/老牧师');
    const hadMimo = process.env.MIMO_API_KEY;
    process.env.MIMO_API_KEY = 'selftest';
    add(resolveVoice('belial').provider === 'mimo', '配了 MIMO_API_KEY 后贝利亚优先 MiMo voiceclone');
    add(resolveVoice('klee').provider === 'mimo', '可莉参考音频就位时也走 MiMo voiceclone');
    add(resolveVoice('laomushi').provider === 'mimo', '老牧师参考音频就位时也走 MiMo voiceclone');
    if (hadMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = hadMimo;
    const oldStatePath = process.env.BELIAL_VOICE_STATE_PATH;
    const tmpState = join(__dirname, `voice-state-selftest-${process.pid}.json`);
    process.env.BELIAL_VOICE_STATE_PATH = tmpState;
    const setKlee = setVoiceMode('klee');
    add(setKlee.ok && readVoiceMode() === 'klee' && voiceModeLabel() === '可莉', 'WebUI 声线状态可切到可莉');
    const setLao = setVoiceMode('laomushi');
    add(setLao.ok && readVoiceMode() === 'laomushi' && voiceModeLabel() === '老牧师', 'WebUI 声线状态可切到老牧师');
    setVoiceMode('belial');
    add(readVoiceMode() === 'belial' && voiceModeLabel() === '贝利亚', '声线状态可切回贝利亚');
    try { unlinkSync(tmpState); } catch {}
    if (oldStatePath === undefined) delete process.env.BELIAL_VOICE_STATE_PATH; else process.env.BELIAL_VOICE_STATE_PATH = oldStatePath;
    add(resolveVoice('emperor').id === 'emperor' && resolveVoice('emperor').provider === 'edge', 'emperor 声源可用');
    const tmp = join(__dirname, `voice-selftest-${process.pid}.mp3`);
    writeFileSync(tmp, Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'binary'));
    const seg = voiceSegment(tmp);
    add(!!seg && seg.type === 'record' && seg.data.file.startsWith('base64://'), '音频能转成 OneBot record 段');
    try { unlinkSync(tmp); } catch {}
    add(MAX_VOICES >= 1 && MAX_VOICE_CHARS >= 10, `一次最多 ${MAX_VOICES} 条、每条 ≤${MAX_VOICE_CHARS} 字`);
    process.exitCode = checks.every(c => c[0]) ? 0 : 1;
  } else {
    const si = args.indexOf('--say');
    const textParts = [];
    if (si >= 0) {
      for (const a of args.slice(si + 1)) {
        if (a.startsWith('--')) break;
        textParts.push(a);
      }
    }
    const text = textParts.join(' ') || '本大爷来了。';
    const vi = args.indexOf('--voice');
    const voice = vi >= 0 ? args[vi + 1] : 'belial';
    synthesizeVoice(text, voice, { log: console.log }).then(r => {
      console.log(r.ok ? `OK ${r.voice}(${r.provider}) ${r.size} bytes ${r.path}` : `FAIL ${r.error}`);
      process.exitCode = r.ok ? 0 : 1;
    });
  }
}
