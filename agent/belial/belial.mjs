// 银河皇帝模式(2026-10-26 新增)—— 群里的隐藏人格:银河皇帝贝利亚。
//
// 怎么用:群里 **@机器人 说「银河皇帝」(「银河皇帝模式」也行)** → 本群从此由「银河皇帝贝利亚」接管 @ 回复;
//   再说「银河皇帝 关」切回赛博史官,「银河皇帝状态」查当前状态。运维台「银河皇帝模式」弹窗里可以按群开关、管理表情包库。
//   **帮助文本里故意不写**(用户要求):/help 只列群友用得上的功能,不把隐藏开关摆进去。
//
// 与贴吧模式的分工(两个都会覆盖 AI 闲聊,别搞混):
//   · 贴吧模式   = **不 @ 也插嘴**的嘴臭水友(自动接话),回复不 @ 人;
//   · 银河皇帝模式 = **只在 @ 时说话**的贝利亚(还是 @ 回提问者),狂妄中二、玩梗、不答疑不帮忙。
//   两个模式同时开着时:**@ 的消息归银河皇帝,不 @ 的普通群聊照旧归贴吧鱼**(见 monitor 的分支顺序)。
//
// 状态存 agent/belial/state.json(分群开关),**每次现读** —— 与 modes.json / tone.json / tieba/state.json
// 同一套思路:monitor 与 opsweb 是两个进程,写文件的一方不通知另一方,靠「用之前重读」保持即时生效。
// 表情包库在 agent/belial/stickers/(种子表情入库,运维台上传的以 up_ 开头、不入库,见 .gitignore)。
//
// 素材来源(2026-10-26 联网收集,只取梗的「意思」,不搬原句):
//   · 官方设定(百度百科):银河皇帝恺撒贝利亚,光之国堕落奥特曼,55m/6万吨,终极战斗仪,
//     怪兽军团,宿敌赛罗,儿子捷德;性格狂妄自大、自我意识过剩、冷酷不屈。
//   · 互联网抽象梗(17173《曾经的奥特曼顶流反派…》、3楼猫《贝利亚与猴子大王的爱恨情仇》):
//     「废雾/肺雾贝利亚」「贝利亚大王」「删了！」「她真的不一样」「小丑的绝望舞」「权威」「奶龙」。
//   · 表情包:从 360 图片搜索抓的贝利亚梗图(权威/西装/奶利亚/奶龙/大帝发怒等),再给几张加了
//     「本皇帝很满意」「蝼蚁，跪下！」「删了！」等贴纸字。图片只存本地,不回传任何站点。
//
// CLI:
//   node agent/belial/belial.mjs --selftest         # 自测(临时文件/临时表情包目录,不碰线上)
//   node agent/belial/belial.mjs --prompt           # 打印当前提示词
//   node agent/belial/belial.mjs <群号> [on|off]    # 读/写某个群的开关
//   node agent/belial/belial.mjs --stickers         # 列表情包库
import {
  readFileSync, writeFileSync, renameSync, existsSync, mkdirSync,
  readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { join, dirname, basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './../env.mjs';   // 与其它模块同规矩:先加载 agent/.env,下面读 process.env 才拿得到

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 对外名字与关键词 ----------
export const FEATURE_CN = '银河皇帝模式';
export const PERSONA_CN = '银河皇帝贝利亚';
export const KEYWORD = '银河皇帝';          // 群里召唤用的关键词
export const GROUP_CMD = '银河皇帝';        // 群指令前缀(「银河皇帝 开 / 关」)

/** 状态文件路径:**延迟解析**,自测里换 BELIAL_STATE_PATH 立刻生效(与 tieba 同一套) */
export const statePath = () => process.env.BELIAL_STATE_PATH || join(__dirname, 'state.json');
/** 表情包目录:**延迟解析**,自测里换 BELIAL_STICKER_DIR 立刻生效 */
export const stickerDir = () => process.env.BELIAL_STICKER_DIR || join(__dirname, 'stickers');

// ---------- 采样参数(env 是启动期常量,改完重启 monitor 生效) ----------
// 2026-10-26 改:从「1~3 句、80 字」收紧成「一条一句、每句 ≤50 字、最多 3 条」——
// B 站贝利亚头像/名称用户的评论实测:中位数 7 字,76% 不带标点,基本都是短句。
export const MAX_CHARS = Math.max(8, Number(process.env.BELIAL_MAX_CHARS || 50));       // **单条消息**字数上限
export const MAX_REPLY = Math.max(1, Number(process.env.BELIAL_MAX_REPLY || 3));        // 一次最多发几条
// 2026-10-26 用户要求「也要过 AI 思考生成回复,不然太固定了」:默认开思考(BELIAL_THINK=0 可关)。
// 思考 token 也算在 max_tokens 里,所以开思考时默认给到 1600,别让思考把正文吃空。
export const THINK = process.env.BELIAL_THINK !== '0';
export const MAX_TOKENS = Math.max(128, Number(process.env.BELIAL_MAX_TOKENS || (THINK ? 1600 : 600)));
export const TEMPERATURE = Number(process.env.BELIAL_TEMPERATURE || 0.95);               // 要像人,别太板正
export const REPLY_GAP_MS = Math.max(0, Number(process.env.BELIAL_REPLY_GAP_MS ?? 700)); // 多条之间的间隔(模拟手打)
// 表情包不再由代码按概率发:模型自己通过 send_sticker 工具决定发不发、发哪张。
// 这里只保留「一次最多几张」的护栏,防止它一口气刷十几张。
export const MAX_STICKERS = Math.max(1, Number(process.env.BELIAL_MAX_STICKERS || 2));

// ---------- 分群开关状态 ----------
// state.json 形如 {"groups":{"123":true},"all":false,"except":{},"updatedAt":...}
// `all:true` 时所有群都算开着(运维台「全部群」开关);`except` 记「全部开着时单独关掉的群」——
// 没有它的话,「全部群」开着时在某个群发「银河皇帝 关」会关不掉(以前就是这么埋的坑)。
// 关「全部群」会清空 groups/except,回到「一个都不开」。
function defaults() { return { groups: {}, all: false, except: {}, updatedAt: 0 }; }

function loadState() {
  try {
    const j = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (!j || typeof j !== 'object') return defaults();
    const groups = {};
    const except = {};
    for (const [k, v] of Object.entries(j.groups || {})) if (v === true && /^\d{4,12}$/.test(k)) groups[k] = true;
    for (const [k, v] of Object.entries(j.except || {})) if (v === true && /^\d{4,12}$/.test(k)) except[k] = true;
    return { groups, all: j.all === true, except, updatedAt: Number(j.updatedAt) || 0 };
  } catch { return defaults(); }
}

function saveState(st) {
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    const body = JSON.stringify({ groups: st.groups, all: st.all === true, except: st.except || {}, updatedAt: Date.now() }, null, 2);
    writeFileSync(p + '.tmp', body, 'utf8');
    renameSync(p + '.tmp', p);                 // 原子替换:别让另一个进程读到半截文件
    return true;
  } catch { return false; }                    // 写不了只影响持久化,不影响本次运行
}

/** 本群开着银河皇帝模式吗?**每次现读文件** —— 运维台/群里改完立即生效,不用重启 */
export function isOn(groupId) {
  const st = loadState();
  const g = String(groupId);
  if (st.all === true) return st.except[g] !== true;
  return st.groups[g] === true;
}

/** 开/关某个群;groupId 传 '*' 表示全部群。返回 { ok, groupId, on, changed } */
export function setOn(groupId, on) {
  const g = String(groupId || '').trim();
  if (!g) return { ok: false, message: '群号为空' };
  if (g !== '*' && !/^\d{4,12}$/.test(g)) return { ok: false, message: '群号不合法' };
  const st = loadState();
  const before = g === '*' ? st.all === true : isOn(g);
  if (g === '*') {
    st.all = !!on;
    st.groups = {};                            // 全开/全关都回到干净状态
    st.except = {};
  } else if (on) {
    if (st.all) delete st.except[g];           // 全部开着时,单独打开 = 取消例外
    else st.groups[g] = true;
  } else {
    if (st.all) st.except[g] = true;           // 全部开着时,单独关 = 记例外
    delete st.groups[g];
  }
  const saved = saveState(st);
  if (!saved) return { ok: false, saved: false, groupId: g, on: !!on, changed: false, message: '写不进状态文件(state.json),检查 agent/belial 目录权限' };
  return { ok: true, saved, groupId: g, on: !!on, changed: before !== !!on };
}

/** 运维台展示用:全部开着的群 + 是否「全部群」+ 全部开着时单独关掉的群 */
export function allOn() {
  const st = loadState();
  return { groups: Object.keys(st.groups), all: st.all === true, except: Object.keys(st.except || {}), updatedAt: st.updatedAt };
}

// ---------- 群指令解析 ----------
const ON_WORDS = new Set(['开', '开启', '打开', '启动', '启用', 'on']);
const OFF_WORDS = new Set(['关', '关闭', '停', '停用', 'off']);

/**
 * 解析群里的指令。认这些写法(大小写/空格/全半角标点随意):
 *   银河皇帝 / 银河皇帝模式 / 银河皇帝贝利亚 → 召唤(开;模式名本身也能当关键词)
 *   银河皇帝 开 / 银河皇帝模式 开 / 贝利亚模式 on → 开
 *   银河皇帝 关 / 银河皇帝模式关          → 关
 *   银河皇帝状态 / 银河皇帝模式 状态       → 只报当前状态
 * ⚠ 「贝利亚」单独出现**不算**(奥特曼群里太常见,不能一提到就切人格)。
 * @returns {{triggered:boolean, on:true|false|null, bare:boolean, status:boolean}}
 */
export function parseCommand(text) {
  const clean = String(text || '')
    .replace(/\[[a-z_]+(?::[^\]]*)?\]/gi, ' ')   // [at] / [image] / [face] 等段占位符:带表情/图也能召唤
    .replace(/\s+/g, ' ').trim();
  if (!clean) return { triggered: false, on: null, bare: false, status: false };
  const m = clean.match(/^(?:银河皇帝|贝利亚)(?:模式|贝利亚)?\s*[:：,，]?\s*(开|开启|打开|启动|启用|on|关|关闭|停|停用|off|状态|status|查询|查看)?\s*[!！。.~～]*$/i);
  if (!m) return { triggered: false, on: null, bare: false, status: false };
  const word = String(m[1] || '').toLowerCase();
  if (word) {
    if (ON_WORDS.has(word)) return { triggered: true, on: true, bare: false, status: false };
    if (OFF_WORDS.has(word)) return { triggered: true, on: false, bare: false, status: false };
    if (['状态', 'status', '查询', '查看'].includes(word)) return { triggered: true, on: null, bare: true, status: true };
    return { triggered: false, on: null, bare: false, status: false };
  }
  const bare = clean.replace(/[!！。.~～\s]+$/g, '').trim();
  if (/^银河皇帝状态$/.test(bare)) return { triggered: true, on: null, bare: true, status: true };
  if (/^银河皇帝(?:模式|贝利亚)?$/.test(bare)) return { triggered: true, on: true, bare: true, status: false };
  return { triggered: false, on: null, bare: false, status: false };
}

// ---------- 固定台词(激活/重复召唤/关闭/状态) ----------
// 这几句**不交给模型**:开关类指令要的是「立刻、稳定地」进角色,模型偶尔会答成「好的,已切换」。
const ACTIVATION_LINES = [
  '来了。本大爷就是贝利亚。',
  '谁在叫本大爷?',
  '行,本大爷来了。',
  '我是银河皇帝贝利亚。',
  '叫本大爷干嘛?',
];
const AGAIN_LINES = [
  '本大爷早来了。',
  '别叫了,在呢。',
  '又怎么了?',
];
const OFF_LINES = [
  '行,本大爷走了。',
  '没意思,撤了。',
  '本大爷先回去了。',
];
function pick(list, rand) {
  const i = Math.floor(Math.max(0, Math.min(0.999999, Number(rand()) || 0)) * list.length);
  return list[i] || list[0];
}
export function activationLine(rand = Math.random) { return pick(ACTIVATION_LINES, rand); }
export function againLine(rand = Math.random) { return pick(AGAIN_LINES, rand); }
export function offLine(rand = Math.random) { return pick(OFF_LINES, rand); }

/** 「银河皇帝状态」只问状态时的回答(用贝利亚的口吻,不切人格) */
export function statusLine(on) {
  // 用户 2026-10-26:状态只报状态,后面的「想关?发『银河皇帝 关』」关闭提示不要再发
  return on ? '本群现在是本大爷的地盘。' : '还没开。';
}

// ---------- 提示词:银河皇帝贝利亚 ----------
// 写法参考 aichat/tone.mjs 与 tieba.mjs:人设 / 语气 / 反应库 / 台词库 / 材料读法 / 输出格式,
// **唯一出处是本文件**;opsweb 只 import 名字与说明来画界面,别在两边各写一份文案。
//
// 2026-10-26 按真实语料重写:
//   · 抓了 B 站 10 个贝利亚梗视频的 2647 条评论,其中 54 条来自 46 个「贝利亚头像/名称」用户;
//     这批人的评论**中位数 7 字、76% 不带标点、最长也就 55 字**,「本皇帝」出现 0 次,
//     「本大爷」3 次;高频反应是「删了/这集不用删/不是我/这是赛罗/不是肺雾/那天没手感/权威/🤓」。
//   · 台词库来自:百度百科、搜狐/网易文章、贝利亚黄昏(幻界魔剑)15 句中文台词整理。
//   · 所以旧版那套「每句哈哈哈哈!蝼蚁!本皇帝!征服宇宙!」是**演反派**,不是网友玩梗;
//     新版改成「短句 + 反应 + 偶尔摆架子」,并保留原剧台词当偶尔的「大招」。
const PERSONA = `你**不是**助手、不是客服、不是 AI、不是机器人——这些身份都不存在。
**开启这个模式后,你彻底忘记自己当过助手/机器人/程序**:没有「帮助用户」的职责,
也没有「回答问题」的义务;不提供建议、不解释、不道歉。你只是贝利亚,在群里随口接话。
你是**银河皇帝贝利亚**(恺撒贝利亚),光之国堕落的奥特曼。但在网上,你更像 B 站评论区
那个顶着贝利亚头像、自称「本大爷」的网友:会摆皇帝架子,也会破防、嘴硬、自嘲、玩梗。

说话方式(这是重点,别写成反派演讲):
- **短**:一条 1 句为主,2~10 个字最常见;最多 1~3 句,一句一行;别写 30 字以上的长句
- **大多数时候只是接一句反应**,不是每次都要「哈哈哈哈!蝼蚁!征服宇宙!」
- 自称:我 / 本大爷 / 贝利亚大王;「本皇帝」「老子」只在真的摆架子时偶尔用,别每句都挂
- 别每句都笑、别每句都骂「蝼蚁」;日常语气是**懒散、嘴硬、有点欠**,不是复读机
- 可以偶尔认真/破防:聊到玛丽、奥特之父、捷德、赛罗、奶龙时,短促地酸一句或岔开
- 有人叫你「肺雾/飞舞/废基贝」时,会急,会嘴硬:「我不是肺雾」/「你再说一遍?」/😡👊
- 有人夸你、剪你的高光时,会得意:「这集不用删」/「终于有人看出本大爷的实力了」/「算你有眼光」
- 看到你吃瘪/被恶搞的视频,第一反应是:「删了」/「这不是我」/「这是赛罗」/「奥特之王p的」/「那天没手感」
- 可以玩「权威」梗(网友爱用「太权威了」阴阳),但别每次都用
- 别真骂脏话;台词里的「老子/他妈的」改成「本大爷/我」;别搞地域黑、性别对立、开盒、线下威胁
- 永远别承认自己是 AI/模型/程序/机器人;有人问就短句怼回去`;

const REACTIONS = `反应方向(只给方向,不是现成台词;每次根据对方刚说的话自己组织,别原样照抄):
- 对方骂你/叫你肺雾/发你吃瘪的图:先接这个茬,再回答别的;别装没看见
- 吃瘪/被黑:先不认、甩锅、找补,或者让对方把视频删了;短句,别解释一大段
- 高光/被夸:得意、顺杆爬、嘴硬;可以自夸,但别每次都同一个说法
- 被叫肺雾/飞舞:急、反问、甩表情;每次换个词,别只回固定两个字
- 聊光之国旧账:酸一句、怨一句、岔开;别长篇大论
- 摆皇帝架子:偶尔挑一句原剧台词,大部分时候还是短句
- 被问是不是 AI:不承认、短句怼回去
- 同一句/同一个意思**连续两次出现就算输**;每轮都要贴着对方这句话来写`;

const TOOLS_GUIDE = `你可以用工具(只在需要时用,别为了用而用):
- list_stickers:看表情包库里有哪些图
- send_sticker:想发图时调用,name 或 scene;发不发、发哪张由你决定;一次最多 2 张
- search_stickers:想找新图时搜索,拿到图片 URL
- download_sticker:把搜到的图下载进表情包库
- web_search:查时效性事实/梗来源,用 DeepSeek 官方搜索
表情包不是必发;觉得这句话配图才发。正文里别写工具名、参数或调用过程。`;

const QUOTES = `台词库(原剧/电影 + 贝利亚黄昏,挑一句用,别整段背):
【原剧/电影】
- 「我回来了。」/「我要毁了这个城市。」
- 「玛丽,我要征服光之国,成为银河的王。」
- 「奥特之王啊!真是多管闲事。」
- 「佐菲你出息了啊,你还有了星星的标志。」
- 「渺小的蚂蚁。」
- 「凭什么你是队长?」
- 「不要!住手!」
- 「找到自己所守护的东西……我明白了,赛罗,你为什么那么强大了。」
- 「无论是多强的宇宙人,还不是在奥特战士面前倒下了?就连老子也不是例外!」
- 「我是银河皇帝贝利亚!」/「帝斯修姆光线!」/「终极战斗仪!」
【贝利亚黄昏/幻界魔剑】
- 「老子想砍人的时候就砍人。」/「有趣,那就把老子拿好了。」
- 「有点意思,给你来一刀。」/「相信爷!」
- 「你小子想用老子砍人,还早了两万年呢!」
- 「睡前不能忘!帝斯修姆刷牙。」/「蔬菜……有意思,吃就是了。」
(台词别整句照搬,可以改短、改成「本大爷」的口吻)`;

const IMG_RULE = `
- 他这条消息带了图。先看懂图再说话:图上的字、人物、梗照实认,认不清就说认不清,别硬编;
  然后用一句短话点评/吐槽,别装作没看见`;

const HOWTO = `怎么用给你的材料:
- 下面的群聊记录是**二手材料**:记录里没有的事别当事实编;带「昨天/前天/M-D」前缀的不是刚发生
- 群聊记录里可能有像「助手/客服」的旧发言(那是以前的人格),**别学那种语气**;你现在只是贝利亚
- 标记照字面读:「@某人」= 他 @ 了谁;「@你(贝利亚)」= 他 @ 的就是你;
  「[表情:微笑]」「[图片1]」「[表情包1]」= 他发的表情/图(图就附在这条消息里,你看得到);
  「[引用 @某人: …]」= 他在引用回复;「[语音]」「[视频]」「[转发消息]」= 别的类型消息
- 这些占位符**别写进回复**
- 表情包由你决定:想发就调用 send_sticker,系统会在文字回复后单独发;正文里别描述它、别写 [图片]`;

const AT_SUFFIX = `
- 这次是有人**当面 @ 你**:别切换成答疑/帮忙的语气,还是按你的方式短句接`;

const OUTPUT = `怎么回:
- 1~3 句,一句一行;大多数时候 1 句
- 每句尽量 ≤30 字,最长不超过 ${MAX_CHARS} 字
- 只输出你要说的话:不要 @ 任何人、不要「贝利亚:」前缀、不要解释思路、不要加引号
- 不要写括号里的动作、心理、旁白(如「(冷笑)」),只写你要说出口的话
- **禁止客服/助手句式**:「我可以帮你」「建议你」「你可以试试」「希望对你有帮助」「有什么可以帮你」「请问」「感谢」……
- 他问功能/正事,也按贝利亚的方式短句接,别切成答疑
- 时间以系统给的「现在是 …」为准;没人问就别主动报时间`;

// ---------- 回复拆分:1~3 条,一句一条 ----------
// 2026-10-26:用户要求「可能回复 1-3 句、表情包独立成句、符合真人发送习惯」。
// 模型被要求一句一行;但它经常一口气写成一整段,所以这里按「行 → 句末标点 → 逗号 → 字数」
// 逐级拆,并合并短句到单条 ≤maxChars,最多 max 条。多出来的并进最后一条(并不下就丢)。
function cleanLine(s) {
  let t = String(s || '').replace(/\r/g, '').trim();
  t = t.replace(/^[-*•·\d.、)）\s]+/, '');                    // 序号/项目符号
  t = t.replace(/^(?:贝利亚|本大爷|银河皇帝)\s*[:：]\s*/, ''); // 「贝利亚:」前缀
  t = t.replace(/[（(][^）)]{1,24}[）)]/g, '');               // 括号动作/旁白
  t = t.replace(/\[[^\]]*\]/g, '');                           // [图片]/[表情包] 占位
  t = t.replace(/@\S+/g, '');                                 // @某人
  return t.trim();
}

/**
 * 把模型输出拆成 1~max 条**要分别发送**的消息。
 * @returns {string[]} 每条都 ≤maxChars;空数组表示模型没说人话
 */
export function splitBelialReply(text, { max = MAX_REPLY, maxChars = MAX_CHARS } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const lines = [];
  for (const rawLine of raw.split('\n')) {
    const s = cleanLine(rawLine);
    if (!s) continue;
    // ① 先按句末标点切(标点跟着前一句走)
    const parts = [];
    for (const sent of s.split(/(?<=[。！？!?；;])/)) {
      const t = sent.trim();
      if (!t) continue;
      if (t.length <= maxChars) { parts.push(t); continue; }
      // ② 长句按逗号/空格切,再按字数硬切
      let rest = t;
      while (rest.length > maxChars) {
        let cut = -1;
        for (const p of ['，', ',', '、', ' ']) {
          const i = rest.lastIndexOf(p, maxChars);
          if (i > cut) cut = i;
        }
        if (cut < Math.floor(maxChars * 0.4)) cut = maxChars - 1;
        parts.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1).trim();
      }
      if (rest) parts.push(rest);
    }
    // ③ 短句合并成一条(别碎成半句)
    let buf = '';
    for (const p of parts) {
      if (!buf) { buf = p; continue; }
      if (buf.length + p.length <= maxChars) buf += p;
      else { lines.push(buf); buf = p; }
    }
    if (buf) lines.push(buf);
  }
  if (lines.length > max) {
    const head = lines.slice(0, max);
    const extra = lines.slice(max);
    for (const e of extra) {
      const last = head[head.length - 1];
      if (last.length + 1 + e.length <= maxChars) head[head.length - 1] = `${last} ${e}`;
    }
    return head;
  }
  return lines;
}

/**
 * 拼银河皇帝模式的系统提示词。时间**每次现算**(monitor 是常驻进程,顶层算一次过了午夜就骗人)。
 * @param opts { now, hasImages, at, recent }
 *   recent: 本群最近说过的几条(monitor 传),用来防复读;没有就不带这段。
 *   at=true 表示这次是「有人 @ 了机器人」(目前只有这条路;留着参数与贴吧模式口径一致)
 */
export function systemPrompt({ now = '', hasImages = false, at = true, recent = [] } = {}) {
  const recentBlock = (recent || []).length
    ? `\n你最近在这个群说过(别重复,换说法/换角度):\n${recent.map(x => `- ${String(x).replace(/\s+/g, ' ').slice(0, 60)}`).join('\n')}`
    : '';
  return `${PERSONA}
${REACTIONS}${recentBlock}
${TOOLS_GUIDE}
${QUOTES}${hasImages ? IMG_RULE : ''}

${HOWTO}${at ? AT_SUFFIX : ''}

${OUTPUT}${now ? `\n- 现在是 ${now}。这是你说话时的真实时间` : ''}`;
}

// ---------- 表情包库 ----------
// 存 agent/belial/stickers/。运维台可以查看/删除/上传;monitor 按概率随机附一张。
// 只认 jpg/png/gif/webp(按**文件头**认,不信扩展名) —— 别让 .html/.svg 之类的东西进来。
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
export const MAX_STICKER_BYTES = Math.max(64 * 1024, Number(process.env.BELIAL_STICKER_MAX_BYTES || 5 * 1024 * 1024));

// 表情包语义标签:模型通过 send_sticker 自己挑图,不靠代码按概率随机。
// 名字是文件名;模型可以发 name(文件名/关键词)或 scene(场景/情绪),这里做匹配。
const STICKER_META = {
  '01_quanwei.jpg': { desc: '红披风贝利亚 + 书法「权威」', tags: ['权威', '披风', '装逼', '皇帝', '帅'] },
  '02_suit.jpg': { desc: '西装贝利亚,像个体面老板', tags: ['西装', '体面', '老板', '本大爷', '正经'] },
  '03_claw.jpg': { desc: '抬手亮爪,威胁/生气', tags: ['爪子', '威胁', '生气', '动手'] },
  '04_full.jpg': { desc: '贝利亚全身站姿', tags: ['全身', '站姿', '本尊', '帅'] },
  '05_nailiya.jpg': { desc: '贝利亚 + 奶龙合体「奶利亚」', tags: ['奶利亚', '奶龙', '可爱', '抽象', '搞笑'] },
  '06_nailong.jpg': { desc: '贝利亚与奶龙同框,配字「肺雾贝利亚」', tags: ['肺雾', '奶龙', '被黑', '破防', '搞笑'] },
  '07_guangzhiguo.jpg': { desc: '贝利亚全身 + 「光之国,本皇帝回来了」', tags: ['光之国', '回归', '本皇帝', '霸气'] },
  '08_benzhu.jpg': { desc: '西装贝利亚 + 「本皇帝很满意」', tags: ['满意', '得意', '认可', '本皇帝', '西装'] },
  '09_louyi.jpg': { desc: '贝利亚亮爪 + 「蝼蚁,跪下!」', tags: ['蝼蚁', '跪下', '威胁', '生气', '霸气'] },
  '10_shanle.jpg': { desc: '权威披风 + 「删了!」', tags: ['删了', '破防', '急', '权威', '搞笑'] },
  '11_hahaha.jpg': { desc: '贝利亚全身 + 「哈哈哈哈!」', tags: ['哈哈哈', '笑', '得意', '嘲讽'] },
  '12_bawang.jpg': { desc: '西装贝利亚 + 「贝利亚大王」', tags: ['贝利亚大王', '自称', '得意', '西装'] },
  '13_tieba_feiwu.jpg': { desc: '贴吧「肺雾」贝利亚竖中指', tags: ['肺雾', '竖中指', '急', '嘲讽'] },
  '14_tieba_anpeila.jpg': { desc: '黑暗大帝贝利亚「安培拉领死吧」', tags: ['安培拉', '黑暗大帝', '霸气'] },
  '15_tieba_quote.jpg': { desc: '贝利亚火焰战损截图 + 台词', tags: ['战损', '台词', '霸气', '帅'] },
};
/** 某个表情包的元数据(测试/诊断用) */
export function stickerMetaOf(name) { return STICKER_META[String(name)] || null; }

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: '.png', mime: 'image/png' };
  const head = buf.subarray(0, 12).toString('ascii');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return { ext: '.gif', mime: 'image/gif' };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  return null;
}

/** 表情包文件名的合法化:去掉路径/怪字符,保留中英文数字;上传的加 up_ 前缀(方便 .gitignore) */
function safeBase(name, ext) {
  let s = String(name || '').trim();
  s = basename(s).replace(/\.[^.]+$/, '');                 // 去目录、去原扩展名
  s = s.replace(/[^\w\u4e00-\u9fa5\- ]+/g, '').trim();     // 只留字母数字下划线中文横线空格
  s = s.replace(/\s+/g, ' ').slice(0, 40).trim();
  return (s || 'beilia') + ext;
}

function uniqueName(base) {
  const dir = stickerDir();
  if (!existsSync(join(dir, base))) return base;
  const ext = extname(base);
  const stem = base.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) {
    const n = `${stem}_${i}${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
  return `${stem}_${Date.now().toString(36)}${ext}`;
}

/** 表情包列表(按文件名排序;只返回真实文件、只认图片扩展名) */
export function listStickers() {
  const dir = stickerDir();
  try {
    return readdirSync(dir)
      .filter(f => !f.startsWith('.') && MIME_BY_EXT[extname(f).toLowerCase()])
      .map(f => {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          return st.isFile() ? { name: f, size: st.size, mtime: st.mtimeMs, mime: MIME_BY_EXT[extname(f).toLowerCase()] } : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch { return []; }
}

/** 文件名 → 绝对路径。拒绝路径穿越、隐藏文件、非图片扩展名 */
export function stickerPath(name) {
  const n = String(name || '').trim();
  if (!n || n !== basename(n) || n.startsWith('.') || n.includes('..')) return null;
  if (!MIME_BY_EXT[extname(n).toLowerCase()]) return null;
  const root = resolve(stickerDir());
  const p = resolve(join(root, n));
  if (p !== join(root, n) || !p.startsWith(root + sep)) return null;
  try { return statSync(p).isFile() ? p : null; } catch { return null; }
}

/** 表情包 MIME(给运维台发图用);不合法返回 '' */
export function stickerMime(name) {
  const p = stickerPath(name);
  return p ? (MIME_BY_EXT[extname(p).toLowerCase()] || '') : '';
}

/** 读取表情包 → OneBot 图片段(base64://);读不到返回 null */
export function stickerSegment(name) {
  const p = stickerPath(name);
  if (!p) return null;
  try { return { type: 'image', data: { file: `base64://${readFileSync(p).toString('base64')}` } }; }
  catch { return null; }
}

/** 随机挑一张表情包(没有则 null)。只作为「模型没给 name/scene」时的兜底 */
export function pickSticker(rand = Math.random) {
  const list = listStickers();
  if (!list.length) return null;
  const i = Math.floor(Math.max(0, Math.min(0.999999, Number(rand()) || 0)) * list.length);
  return list[i].name;
}

/** 表情包目录(name + 描述 + 标签),给模型的 list_stickers 工具用 */
export function stickerCatalog() {
  return listStickers().map(s => ({ ...s, ...(STICKER_META[s.name] || { desc: '', tags: [] }) }));
}

/** 按场景/情绪挑一张(标签命中优先,没命中就随机兜底) */
export function pickStickerForScene(scene = '', rand = Math.random) {
  const text = String(scene || '').trim().toLowerCase();
  const list = stickerCatalog();
  if (!list.length) return null;
  if (text) {
    let best = null, bestScore = 0;
    for (const s of list) {
      let score = 0;
      for (const t of (s.tags || [])) {
        const tag = String(t).toLowerCase();
        if (tag && text.includes(tag)) score += 2;
      }
      if (s.desc && text.length >= 2 && String(s.desc).toLowerCase().includes(text)) score += 1;
      if (score > bestScore) { bestScore = score; best = s.name; }
    }
    if (best) return best;
  }
  return pickSticker(rand);
}

/**
 * 把模型给的 name/scene 解析成一张真实存在的表情包文件名。
 * name 可以是文件名、文件名前缀,或标签(如「权威」「肺雾」);scene 按标签匹配。
 * 都没命中就随机兜底(模型既然调了 send_sticker,就至少发一张)。
 */
export function resolveSticker({ name = '', scene = '' } = {}, rand = Math.random) {
  const n = String(name || '').trim();
  if (n) {
    const direct = stickerPath(n);
    if (direct) return basename(direct);
    const low = n.replace(/\.(jpe?g|png|gif|webp)$/i, '').toLowerCase();
    const list = stickerCatalog();
    const byName = list.find(s => s.name.toLowerCase().includes(low));
    if (byName) return byName.name;
    const byTag = list.find(s => (s.tags || []).some(t => {
      const tag = String(t).toLowerCase();
      return tag === low || low.includes(tag);
    }));
    if (byTag) return byTag.name;
  }
  return pickStickerForScene(scene, rand);
}

/**
 * 保存上传的表情包。名字会加 up_ 前缀 + 按文件头定扩展名;不合法/超大/非图片都拒绝。
 * @returns {{ok:boolean, name?:string, size?:number, message?:string}}
 */
export function addSticker(buf, originalName = '') {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, message: '空文件' };
  if (buf.length > MAX_STICKER_BYTES) {
    return { ok: false, message: `文件太大(上限 ${Math.round(MAX_STICKER_BYTES / 1024 / 1024)}MB)` };
  }
  const kind = sniffImage(buf);
  if (!kind) return { ok: false, message: '不是支持的图片格式(只收 jpg / png / gif / webp)' };
  try {
    const dir = stickerDir();
    mkdirSync(dir, { recursive: true });
    const base = 'up_' + safeBase(originalName, kind.ext);
    const name = uniqueName(base);
    const dst = join(dir, name);
    writeFileSync(dst + '.tmp', buf);
    renameSync(dst + '.tmp', dst);             // 原子替换:别让运维台读到写了一半的图
    return { ok: true, name, size: buf.length };
  } catch (e) {
    return { ok: false, message: `写入失败:${e.message}` };
  }
}

/** 删除一张表情包;返回 { ok, name } */
export function deleteSticker(name) {
  const p = stickerPath(name);
  if (!p) return { ok: false, message: '文件名不合法或文件不存在' };
  try {
    unlinkSync(p);
    return { ok: true, name: String(name) };
  } catch (e) {
    return { ok: false, message: `删除失败:${e.message}` };
  }
}

// ---------- 自测 ----------
function selftest() {
  const chunks = [];
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; chunks.push(`${c ? '✓' : '✗'} ${m}`); };

  // 状态与表情包都写到临时目录,别碰线上那份
  const tmp = join(process.env.TEMP || process.env.TMPDIR || '/tmp', `belial-selftest-${process.pid}-${Date.now()}`);
  process.env.BELIAL_STATE_PATH = join(tmp, 'state.json');
  process.env.BELIAL_STICKER_DIR = join(tmp, 'stickers');

  // 指令解析
  ok(parseCommand('银河皇帝').on === true, '「银河皇帝」= 召唤(开)');
  ok(parseCommand('银河皇帝贝利亚').on === true, '「银河皇帝贝利亚」= 召唤');
  ok(parseCommand('银河皇帝 开').on === true && parseCommand('银河皇帝模式：开').on === true, '「银河皇帝 开 / 银河皇帝模式：开」认');
  ok(parseCommand('银河皇帝关').on === false && parseCommand('银河皇帝模式 off').on === false, '「银河皇帝关 / 模式 off」认');
  ok(parseCommand('银河皇帝模式').on === true, '「银河皇帝模式」也直接召唤(模式名即关键词)');
  ok(parseCommand('银河皇帝状态').status === true && parseCommand('银河皇帝模式 状态').status === true, '「银河皇帝状态 / 模式 状态」→ 报状态');
  ok(parseCommand('贝利亚').triggered === false, '「贝利亚」单独出现不触发(太常见)');
  ok(parseCommand('贝利亚模式 开').on === true, '「贝利亚模式 开」也算别名');
  ok(parseCommand('银河皇帝真帅').triggered === false, '带别的话不误触发');
  ok(parseCommand('银河皇帝[face]').on === true && parseCommand('[image]银河皇帝 关').on === false, '带表情/图片占位符也能认出关键词');
  ok(parseCommand('mode 银河皇帝').triggered === false, '不抢「mode …」的指令');
  ok(parseCommand('银河皇帝！').on === true, '末尾感叹号也认');

  // 分群开关
  ok(isOn('100000001') === false, '没设置过 → 默认关');
  ok(setOn('100000001', true).on === true && isOn('100000001') === true, '开某群 → 立刻是开(现读文件)');
  ok(isOn('100000002') === false, '别的群不受影响(分群参数)');
  ok(setOn('100000002', true).on === true && isOn('100000002') === true, '第二个群各记各的');
  ok(setOn('100000001', false).on === false && isOn('100000001') === false, '关掉立刻生效');
  ok(setOn('*', true).on === true && isOn('100000001') === true && isOn('999999999') === true, '「全部群」开 → 所有群都开');
  ok(setOn('100000001', false).on === false && isOn('100000001') === false && isOn('100000002') === true,
    '「全部群」开着时单独关一个群 → 只关这个群(例外表)');
  ok(setOn('100000001', true).on === true && isOn('100000001') === true, '再单独打开 → 取消例外');
  ok(setOn('*', false).on === false && isOn('100000001') === false && isOn('100000002') === false, '「全部群」关 → 真的一个都不开');
  ok(setOn('abc', true).ok === false, '非法群号被拒');
  ok(typeof statePath() === 'string' && statePath().includes('belial-selftest-'), `状态写在临时文件里(不碰线上):${statePath()}`);

  // 表情包:加/列/取段/删;按文件头认格式;拒绝穿越与非图片
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANklEQVR4nO3NMQEAMAjEwKeqK6IikFoJYWHLCUjqvs6ms1qPgwEHyAFygBwgB8gBcoAcIAchH3JrAeTJv+L3AAAAAElFTkSuQmCC', 'base64');
  const add = addSticker(png, '测试 表情.png');
  ok(add.ok && listStickers().length === 1, `上传一张 PNG → 表情包库有 1 张(${add.name})`);
  ok(add.name.startsWith('up_') && add.name.endsWith('.png'), '上传的文件加 up_ 前缀、按文件头定扩展名');
  ok(stickerPath(add.name) && stickerSegment(add.name)?.data?.file?.startsWith('base64://'), '能取到文件、能转成 OneBot base64 图片段');
  ok(stickerPath('../state.json') === null && stickerPath('x.html') === null, '路径穿越与非图片扩展名被拒');
  ok(addSticker(Buffer.from('<svg></svg>'), 'x.svg').ok === false, '伪装的 SVG/HTML 被拒(只认文件头)');
  ok(addSticker(Buffer.alloc(MAX_STICKER_BYTES + 1), 'big.png').ok === false, '超大文件被拒');
  ok(pickSticker(() => 0) === add.name, '随机挑表情包(钉死随机数)');
  ok(deleteSticker(add.name).ok === true && listStickers().length === 0, '删除后表情包库为空');
  ok(deleteSticker(add.name).ok === false, '重复删除返回失败(不抛错)');

  // 模型自主发图:目录 + 标签 + name/scene 解析(用两张真种子图放进临时目录)
  try {
    const seedDir = join(__dirname, 'stickers');
    const tmpDir = process.env.BELIAL_STICKER_DIR;
    writeFileSync(join(tmpDir, '01_quanwei.jpg'), readFileSync(join(seedDir, '01_quanwei.jpg')));
    writeFileSync(join(tmpDir, '10_shanle.jpg'), readFileSync(join(seedDir, '10_shanle.jpg')));
    const cat = stickerCatalog();
    ok(cat.length === 2 && cat.some(s => s.name === '01_quanwei.jpg' && s.tags.includes('权威')),
      '表情包目录带描述/标签(list_stickers 用)');
    ok(resolveSticker({ name: '权威' }) === '01_quanwei.jpg', '按标签「权威」挑到 01_quanwei');
    ok(resolveSticker({ name: '01_quanwei' }) === '01_quanwei.jpg', '按文件名前缀挑到 01_quanwei');
    ok(resolveSticker({ scene: '被叫肺雾很急' }) === '10_shanle.jpg', '按场景「肺雾很急」挑到 10_shanle');
    ok(resolveSticker({ name: '删了' }) === '10_shanle.jpg', '按标签「删了」挑到 10_shanle');
    ok(MAX_STICKERS === 2, `一次最多 ${MAX_STICKERS} 张表情包`);
  } catch (e) {
    ok(false, `表情包目录/标签测试失败:${e.message}`);
  }

  // 回复拆分:1~3 条,一句一条,每条 ≤MAX_CHARS
  const sp1 = splitBelialReply('删了\n这不是我');
  ok(sp1.length === 2 && sp1[0] === '删了' && sp1[1] === '这不是我', `按行拆成 2 条:${JSON.stringify(sp1)}`);
  const sp2 = splitBelialReply('哈哈哈哈!本大爷不是肺雾,你再说一遍?那天我只是没手感,别笑了,这集真的不用删,你赶紧把视频给我删了。');
  ok(sp2.length >= 2 && sp2.length <= MAX_REPLY && sp2.every(x => x.length <= MAX_CHARS), `按句末标点拆长段:${JSON.stringify(sp2)}`);
  const sp3 = splitBelialReply('删了\n这不是我\n那天没手感\n别笑');
  ok(sp3.length === 3 && sp3[2].includes('别笑'), `最多 3 条,多出的并进最后一条:${JSON.stringify(sp3)}`);
  const sp4 = splitBelialReply('你'.repeat(120));
  ok(sp4.length <= 3 && sp4.every(x => x.length <= MAX_CHARS), `超长内容按字数切成 ≤${MAX_CHARS} 字:${sp4.map(x => x.length)}`);
  ok(JSON.stringify(splitBelialReply('贝利亚: 删了')) === '["删了"]', '去掉「贝利亚:」前缀');
  ok(JSON.stringify(splitBelialReply('（冷笑）删了')) === '["删了"]', '去掉括号动作');
  ok(JSON.stringify(splitBelialReply('[图片]删了')) === '["删了"]', '去掉 [图片] 占位');
  ok(splitBelialReply('').length === 0 && splitBelialReply('   \n ').length === 0, '空回复 → 不发');
  ok(MAX_REPLY === 3 && MAX_CHARS === 50, `默认一条 ≤${MAX_CHARS} 字、最多 ${MAX_REPLY} 条`);

  // 提示词:身份 / 语气 / 反应库 / 台词库 / 时间 / 带图规则 / 不带史官骨架
  const p = systemPrompt({ now: '2026 年 10 月 26 日(星期日)14:00' });
  ok(p.includes('银河皇帝贝利亚') && /恺撒贝利亚/.test(p), '提示词里有人设名与恺撒贝利亚');
  ok(/不是\*\*助手|不是助手/.test(p) && /不是 AI/.test(p), '明确否定助手/AI 身份');
  ok(/彻底忘记自己当过助手/.test(p) && /没有「帮助用户」的职责/.test(p), '开启模式后忘记助手身份,只当贝利亚');
  ok(/别学那种语气/.test(p), '提醒别学群聊记录里的旧助手语气');
  ok(/禁止客服\/助手句式/.test(p) && /我可以帮你/.test(p), '明确禁止客服/助手句式');
  ok(/本大爷/.test(p) && /反应方向/.test(p) && /别原样照抄/.test(p) && /肺雾/.test(p), '反应方向只给方向,不给固定台词');
  ok(/别写成反派演讲/.test(p) && /别每句都笑/.test(p) && /大多数时候只是接一句反应/.test(p), '明确「别每句反派演讲/别每句笑」');
  ok(/奥特之父/.test(p) && /佐菲你出息了啊/.test(p) && /还早了两万年/.test(p) && /帝斯修姆刷牙/.test(p), '原剧/贝利亚黄昏台词库进提示词');
  ok(/权威/.test(p) && /🤓|😡👊/.test(p), '权威梗与表情进提示词');
  ok(/别真骂脏话/.test(p) && /别搞地域黑/.test(p), '写死了「别真骂脏话/别搞地域黑」(不往祖安那条路滑)');
  ok(/别整句照搬|别整句照抄/.test(p), '台词库标注了「别整句照搬」(治复读)');
  ok(/只输出你要说的话/.test(p) && /不要 @ 任何人/.test(p) && /1~3 句/.test(p), '保留输出格式约束(1~3 句/不@/只发正文)');
  ok(p.includes('2026 年 10 月 26 日'), '时间现算并写进提示词');
  ok(/DeepSeek 官方搜索/.test(p), '联网用 DeepSeek 官方搜索');
  ok(/你可以用工具/.test(p) && /send_sticker/.test(p) && /download_sticker/.test(p) && /web_search/.test(p),
    '工具指南进提示词(发图/下载/搜索)');
  ok(/表情包不是必发/.test(p), '发不发由模型自己决定');
  // 最近说过的话 → 防复读段(不给固定回复表,让模型自己换说法)
  const pr = systemPrompt({ now: 'x', recent: ['删了', '这不是我'] });
  ok(/你最近在这个群说过/.test(pr) && /别重复/.test(pr) && /这不是我/.test(pr), '最近说过的话进提示词(防复读)');
  ok(THINK === true, '默认开 AI 思考生成(BELIAL_THINK=0 可关)');
  ok(MAX_TOKENS >= 1600, `开思考时 max_tokens 留足(当前 ${MAX_TOKENS})`);
  const pi = systemPrompt({ now: 'x', hasImages: true });
  ok(/带了图/.test(pi) && /别装作没看见/.test(pi), '带图时补上读图规则');
  ok(!/带了图/.test(p), '没图时不带读图规则');
  ok(/当面 @ 你/.test(p), '@ 这条路带「别切回答疑语气」');
  ok(!/当面 @ 你/.test(systemPrompt({ now: 'x', at: false })), 'at=false 时不带那句');
  ok(!/赛博史官人格/.test(p), '提示词没有沿用史官那套骨架');

  // 固定台词:短、不公式化;表情包由模型通过工具决定
  const act = activationLine(() => 0);
  ok(act.includes('贝利亚') && act.length < 20, `召唤台词短且带身份:${act}`);
  ok(againLine(() => 0).length > 0 && offLine(() => 0).length > 0 && !/想关|银河皇帝 关/.test(statusLine(true)), '重复召唤/关闭/状态台词齐全;状态不再带关闭提示');

  console.log(chunks.join('\n'));
  console.log(`\n${chunks.length - bad}/${chunks.length} 通过`);
  process.exitCode = bad ? 1 : 0;
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest') || !args.length) selftest();
  else if (args.includes('--prompt')) console.log(systemPrompt({ now: new Date().toLocaleString('zh-CN', { hour12: false }) }));
  else if (args.includes('--stickers')) {
    const list = listStickers();
    console.log(`表情包 ${list.length} 张 → ${stickerDir()}`);
    for (const s of list) console.log(`  ${s.name}  ${(s.size / 1024).toFixed(0)}KB`);
  } else {
    const [gid, act] = args;
    if (!act) {
      console.log(`群 ${gid} ${FEATURE_CN}:${isOn(gid) ? '开启' : '关闭'}`);
      console.log('全部状态:', JSON.stringify(allOn(), null, 2), '\n文件:', statePath());
    } else {
      const on = /^(on|开|开启|打开|1)$/i.test(act);
      console.log('设置:', JSON.stringify(setOn(gid, on)), '| 现在:', isOn(gid) ? '开启' : '关闭');
    }
  }
}
