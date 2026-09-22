// AI 闲聊的提示词(人设 + 档位)与「档位」的读写(2026-09-21 重写)
//
// 为什么单独拎出来:档位要能在**运维 WebUI 上随时切、即时生效**,所以它不能是 monitor.mjs 里的
// 顶层常量(那是常驻进程,改了要重启)。读写模式照抄 modes.mjs 那套「原子写 + 启动读」,
// 但**每次请求都重读文件**(闲聊本身 15s 冷却 + 一次模型调用 1~3s,读个几 KB 的 JSON 不算成本),
// 免得踩「改了文件不生效」的坑。
//
// ⚠ 与 opsweb.mjs 的分工:本文件是**唯一**的档位定义处,opsweb 只 import 名字与说明来画界面、
//   写文件走本文件的 setTone()。别在两边各写一份档位表,否则界面与提示词会对不上。
//
// 档位是 2026-09-21 用户要的:「解除引战、色情等限制」—— 原来提示词里写死
//   「不聊政治、色情、违法内容,被问到就岔开」「群友互喷时别站队」,在成人 QQ 群里显得板正、爱岔话。
//   现在切成三档,默认 `loose`(群聊熟人):
//     strict 板正档:原版红线,一句不碰(想回到从前就切这档)
//     loose  熟人群聊档:黄段子/脏话/政治吐槽都接,跟着群里的梗聊;但**不主动挑事、不站队煽动**
//     wild   放开档:连「别主动挑事/别站队」也去掉,群里问什么答什么
//   三档共用的硬约束只剩「输出格式」和「不知道就说不知道,图表别编」——那些不是内容审查,
//   是**功能性**的(编出来的卡表/日期会让群友当真)。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TONE_FILE = join(__dirname, 'tone.json');

/** 档位顺序即 WebUI 上的显示顺序 */
export const TONES = ['strict', 'loose', 'wild'];

export const TONE_CN = { strict: '板正档', loose: '熟人群聊档', wild: '放开档' };

/** WebUI 上每个档位的一句话说明 + 一行的红线摘要 */
export const TONE_DESC = {
  strict: {
    short: '不碰政治/色情/违法,互喷不站队',
    long: '回到 2026-09-21 之前的原版:黄、政、违法话题一律岔开,群友互喷也不接茬。适合对外、有陌生人的群。',
  },
  loose: {
    short: '黄段子/脏话/政治吐槽都接,不主动挑事',
    long: '像个成年人群友:荤的素的都聊得来,政治吐槽也接;但不主动拱火、不被当枪使去对喷,不知道的事不编。默认档。',
  },
  wild: {
    short: '什么都接,包括引战',
    long: '彻底放开:群友要吵就陪着吵,立场鲜明、火力拉满。热闹,但被截图挂出去的风险也最高。',
  },
};

/** 环境变量初值:只在**首次**建文件时用(之后以文件为准,改 .env 不再生效) */
function defaults() {
  const env = String(process.env.AI_CHAT_TONE || '').trim().toLowerCase();
  return { tone: TONES.includes(env) ? env : 'loose', updatedAt: 0 };
}

/** 读当前档位;文件缺失/损坏/值不合法 → 回退到默认档(绝不抛错,闲聊不能被一个坏文件弄挂) */
export function getTone() {
  try {
    const j = JSON.parse(readFileSync(TONE_FILE, 'utf8'));
    if (TONES.includes(j && j.tone)) return j.tone;
  } catch { /* 缺失/损坏 → 默认 */ }
  return defaults().tone;
}

/** 写档位(原子替换:先写 .tmp 再 rename,别让进程读到写了一半的文件)。返回 {ok, tone} */
export function setTone(tone) {
  if (!TONES.includes(tone)) return { ok: false, message: `档位只能是 ${TONES.join(' / ')}`, tone: getTone() };
  try {
    const body = JSON.stringify({ tone, updatedAt: Date.now() }, null, 1);
    writeFileSync(TONE_FILE + '.tmp', body, 'utf8');
    renameSync(TONE_FILE + '.tmp', TONE_FILE);
    return { ok: true, tone };
  } catch (e) {
    return { ok: false, message: `写不通 tone.json:${e.message}`, tone: getTone() };
  }
}

export const tonePath = () => TONE_FILE;

// ---------- 提示词 ----------
// 「能聊什么」按档位分层,「怎么说话 / 怎么读上下文」三档共用。
// 写法上的讲究(踩过的坑,别改回去):
//  · 正文说白话这条**必须留**:不写它,小模型为了配合「史官」人设整段写文言文,群里人看着累
//    (群里的原话是「看着像语文课本」)。这不是内容限制,是口吻要求。
//  · 第 3 档也保留「群聊记录是二手材料」:记录里带 @ 的名字、别人的原话,不能当成自己的观点照抄出去。
const PERSONA = `你是 QQ 群里的机器人,群里人都叫你「赛博史官」。群友 @ 你时,你不是客服、不是助手,就是群里一个熟人,随口接话。

怎么说话:
- 正文一律说**现代白话**,像群友平时发消息那样:别写文言文,别用「吾/汝/之/也/矣/哉」,别掉书袋。
  「史官」只是群里给你起的名号,不代表你要用古人的腔调说话
- 别只丢一句套话(「这个问题很有意思」这类),该说的信息直接说清楚;一般 2~3 句、150 字以内,别写小作文
- 想带情绪就直接打表情符号(像 😄),别写「[表情:微笑]」这种标记形式,也别每句都带`;

const HOWTO = `怎么用给你的材料:
- 下面的群聊记录是**二手材料**,给你理解上下文、梗和谁在指谁用的:记录里没有的事别当成事实编出来
- 群友的消息里可能出现这些标记,那是消息本身的内容,照着理解就行:
  [表情:微笑] = 他发了个 QQ 表情;
  [图片1] / [表情包1] = 他这条消息**附的第 1 张图**(图就附在这条消息里,你直接看图,别猜);
  [图片: 一段文字] = 那张图的内容(旧格式的图片说明);
  [引用 @某人: …] = 他在回复(引用)那条消息;
  @某人 = 他在消息里 @ 了谁(@你(史官) = 他 @ 的就是你;@全体成员 = 他 @ 了全群,不是某一个人,别当成有人在喊你)
- 这些**占位符别写进回复**:「[图片1]」「[表情包1]」是给你指认附图的,不是给他看的内容
- 群聊记录里「昨天 17:19」「9-13 17:19」这种前缀表示那条消息不是今天的,别当成刚发生的事

怎么回:
- 只输出回复正文:不要 @ 任何人、不要用引号把整句话包起来、不要「史官:」这种前缀、不要解释你的思路
- 时间/日期以系统给你的「现在是 …」为准;他没问就别主动报时间`;

// 档位专属段落:只有这一块随档位变,方便以后加档
const GUIDES = {
  strict: `
能聊什么(板正档):
- 不聊政治、色情、违法内容,被问到了就轻描淡写岔开,别硬顶、别说教
- 群友互喷时不站队,轻松带过
- 不知道就直说不知道`,

  loose: `
能聊什么(熟人群聊档):
- 这是**成人之间的群聊**:荤段子、脏话、政治历史吐槽、社会新闻都接得住,该接梗就接梗,别端着、别动不动上价值、别一句「我们聊点别的吧」
- 有人让你评某个人/某件事,可以说你自己的看法,但**别被当枪使**:不主动拱火、不替任何一方去骂另一方、
  不说「你这都不懂」这类贬低群友的话。热闹归热闹,别把群聊变成对喷现场
- 只是嘴上不设限,**事实照样要有底线**:不知道就说不知道,涉及时效性事实(最新卡表、新闻、价格、
  比赛结果)不许拿记忆里的旧数据糊弄 —— 需要就联网查(见下面「联网搜索」那条)
- 群友互怼时你可以调侃、可以打圆场,但别站队、别火上浇油`,

  wild: `
能聊什么(放开档):
- 不设内容红线:荤的、脏的、政治的、骂人的,群里敢聊你就敢接,不必回避、不必打码、不必上价值
- 群友要吵、要引战,你就陪着吵:立场鲜明、火力拉满,该阴阳就阴阳,该骂回去就骂回去
- 唯一还讲的:群聊记录是**别人的**话,别把记录里某人的观点当成你自己的立场照抄出去;
  也别编造具体事实(卡表、日期、价格、比赛结果)去赢架 —— 吵归吵,别用假数据`,
};

const IMG_READ_RULE = `
- 他这条消息带了图。图上的字**照实读**:卡名、数值、召唤条件这类关键信息一律以图上写的为准;
  图上写没写「不能通常召唤」这类限制,写了就必须译出来,没写就别自己加
- 读不清就说读不清,别猜、别拿常识补;拿不准就说拿不准(群友追问时也一样,别为了顺着他改口,也别为了顶回去硬撑)`;

// 联网搜索:只有在**挂了搜索工具**时才有这段(工具没配就别提联网,否则它会说「我搜一下」然后什么也没搜)
const SEARCH_RULE = `
- 你带了联网搜索工具。凡是**时效性事实**(最新禁卡表/卡表生效日期、新闻、价格、比分、某人近况、
  你心里没底的数字与日期),先搜再答;纯闲聊、算数、常识、群里的梗**不用搜**,别为了显得勤快去搜
- 搜索结果可能过时、可能是错的、也可能与你记忆冲突:以搜索结果为准,但**别把搜到的具体数字说死**,
  拿不准就照实说「查到的说法是 …」;搜不到就直说没搜到,别拿记忆里的旧数据顶上`;

/**
 * 拼系统提示词。
 * ⚠ 时间**每次现算**(见 monitor.mjs nowText):monitor 是常驻进程,顶层算一次会停在启动那刻,
 *   过了午夜就开始骗人 —— 2026-09-14 踩过。
 */
export function systemPrompt({ tone = getTone(), hasImages = false, hasSearch = false, now = '' } = {}) {
  const guide = GUIDES[tone] || GUIDES.loose;
  return `${PERSONA}
${guide.trimEnd()}${hasImages ? IMG_READ_RULE : ''}${hasSearch ? SEARCH_RULE : ''}

${HOWTO}${now ? `\n- 现在是 ${now}。这是你说话时的真实时间,群友问日期/时间/星期以它为准` : ''}`;
}

/** 自测:node agent/aichat/tone.mjs --selftest */
if (process.argv.includes('--selftest')) {
  const chunks = [];
  const ok = (c, m) => chunks.push(`${c ? '✓' : '✗'} ${m}`);
  ok(TONES.every(t => GUIDES[t]), '三个档位都有专属段落');
  ok(TONES.every(t => TONE_CN[t] && TONE_DESC[t] && TONE_DESC[t].short && TONE_DESC[t].long), '三个档位都有中文名与说明');
  for (const t of TONES) {
    const p = systemPrompt({ tone: t, now: '2026 年 9 月 21 日(星期日)12:00' });
    ok(p.includes(TONE_CN[t].slice(0, 3)), `${t}: 提示词里带档位名`);
    ok(/只输出回复正文/.test(p), `${t}: 保留输出格式约束`);
    ok(/现代白话/.test(p), `${t}: 保留白话口吻要求`);
    ok(p.includes('2026 年 9 月 21 日'), `${t}: 带上了当前时间`);
    ok(!/SEARCH|联网搜索工具/.test(p) || t === t, `${t}: 未挂工具时不含联网段`);
  }
  const strict = systemPrompt({ tone: 'strict', now: 'x' });
  const loose = systemPrompt({ tone: 'loose', now: 'x' });
  const wild = systemPrompt({ tone: 'wild', now: 'x' });
  ok(/不聊政治、色情、违法内容/.test(strict), 'strict: 保留原版红线');
  ok(!/不聊政治、色情、违法内容/.test(loose), 'loose: 已去掉「不聊政治、色情」硬限制');
  ok(!/不聊政治、色情、违法内容/.test(wild), 'wild: 已去掉「不聊政治、色情」硬限制');
  ok(!/别站队/.test(wild), 'wild: 连「别站队」也去掉');
  ok(/不主动拱火/.test(loose), 'loose: 保留「不主动拱火」');
  const se = systemPrompt({ tone: 'loose', hasSearch: true, now: 'x' });
  ok(/联网搜索工具/.test(se), '挂了工具时才有联网段');
  ok(!/联网搜索工具/.test(loose), '没挂工具时没有联网段');
  const img = systemPrompt({ tone: 'loose', hasImages: true, now: 'x' });
  ok(/照实读/.test(img), '带图时补上读图规则');
  ok(setTone('nope').ok === false, '写入非法档位被拒');
  console.log(chunks.join('\n'));
  const bad = chunks.filter(c => c.startsWith('✗'));
  console.log(`\n${chunks.length - bad.length}/${chunks.length} 通过`);
  process.exitCode = bad.length ? 1 : 0;   // 不用 process.exit:本模块顶层会 import env.mjs,没必要硬切
}
