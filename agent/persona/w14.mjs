// 「W14」人格(2026-11-26 由西比拉改名,id 定为 W14)—— 记忆驱动:system prompt 只有一句身份 +
// 长期记忆块,没有人设。
//
// 由来:先用「记忆测试」人格验证了 memory.mjs 的作用域/召回/预算,上线时叫「西比拉」;2026-11-26
// 用户要求删掉测试人格、把 id 定为 W14,设定不变 —— 它不认识你,除非记忆里有你;它不扮演谁,
// 所有「性格」都来自记忆库(用户档案、群黑话、游戏王常识)。想改说话方式就改记忆(kind=style),
// 不要往这里加提示词,否则分不清是「记住了」还是「设定」。
//
// 记忆结构与脚刷周完全一样(见 persona/membrain.mjs):独立目录、群档案、做梦、注入层。
// 注册:monitor.mjs 的 PERSONA_SPECS.W14 + kit.mjs 的 PERSONA_IDS + opsweb 下拉。
// 开关:与其它人格共用 kit/state.json,`personas[群号] = "W14"` 即在该群启用;
//       群 793874011 另外在 state.json 的 autoReply 里关了「不 @ 也自动接话」。
import { personaMemoryBlock } from './membrain.mjs';
import { addMemory, deleteMemory, listMemories } from './memory.mjs';
import { pathToFileURL } from 'node:url';

export const PERSONA_ID = 'W14';
export const PERSONA_CN = 'W14';
export const KEYWORD = 'W14';
/** 切到该人格时的群名片;可用 env 覆盖,设为空串则不改名片。 */
export const GROUP_CARD = process.env.W14_GROUP_CARD ?? 'W14';
export const MAX_REPLY = Math.max(1, Number(process.env.W14_MAX_REPLY || 2));
export const MAX_CHARS = Math.max(20, Number(process.env.W14_MAX_CHARS || 60));
export const REPLY_GAP_MS = Math.max(0, Number(process.env.W14_REPLY_GAP_MS ?? 500));
export const MAX_STICKERS = Math.max(0, Number(process.env.W14_MAX_STICKERS || 1));

/** 身份只有一句,其余全靠记忆块;记忆为空时也要能报名字。 */
export const IDENTITY = '你叫「W14」,在这个群里聊天。';

// 输出格式(功能性约束,不是人设):QQ 消息是纯文本,不渲染 Markdown。
// 不写这段时,模型(尤其 DeepSeek)默认爱用 **加粗**、# 标题、- 列表,发到群里就是一串星号。
const OUTPUT = `怎么回(QQ 是纯文本,不是 Markdown):
- 只输出回复正文;不要用 **加粗**、# 标题、- 列表、\`代码\`、> 引用这些标记
- 不要写「W14:」前缀、不要用引号把整句包起来、不要解释思路
- 一两句说完,能短就短;别写小作文`;

// 查证(功能性约束):游戏王卡名/效果/combo/裁定、时效性事实靠训练数据很容易编。
// W14 没有脚刷周那套详细工具指南,这里必须写清楚「先查再答」,否则它会凭记忆瞎编 combo。
const RESEARCH = `查证(游戏王/时效性事实):
- 卡名、卡牌效果、裁定、禁卡表、combo 这类问题,**不要凭记忆答**:
  先用 search_ygo_card 查本地卡库的卡面效果;combo 里有多张卡就**一次列出来分别查**(同一轮可以多次调用),
  同一张卡只查一次;查完就答,别反复查同一张。
- 本地卡库没有、或要最新裁定/禁卡表/新卡,用 web_search 查;搜索结果和记忆冲突时以查到的为准。
- 讲 combo 要按查到的卡面效果一步步推;有一张查不到、或效果对不上,就直接说「这张我查不到/不确定」,别硬编。
- **不知道标准展开/最新 combo 是正常的**:卡面效果能查,展开路线查不到。可以说明「这条线我不确定」并只给卡面事实,不要为了显得懂而硬编步骤。
- 日期、数字、卡名拿不准就先查;查不到就说查不到。`;

/**
 * @param {{scope?:{group?:string,user?:string}, query?:string}} opts
 *   query:本轮消息,用来给「群/全局」记忆做关键词排序(用户档案始终注入)。
 */
export function systemPrompt({ scope = null, query = '' } = {}) {
  const block = personaMemoryBlock(PERSONA_ID, { scope, query, budgetChars: 1600 });
  return `${IDENTITY}\n\n${OUTPUT}\n\n${RESEARCH}${block ? `\n\n${block}` : ''}`;
}

export function activationLine() { return 'W14 上线。'; }
export function againLine() { return 'W14 已经在岗。'; }
export function offLine() { return 'W14 下线。'; }
export function statusLine(on) { return on ? 'W14 在岗。' : 'W14 没上线。'; }

// ---------- 自测 ----------
function selftest() {
  const chunks = [];
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; chunks.push(`${c ? '✓' : '✗'} ${m}`); };
  process.env.PERSONA_MEM_DIR = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/w14-${process.pid}-${Date.now()}`;
  delete process.env.PERSONA_MEMORY_PATH;

  const scope = { group: '793874011', user: '3080580848' };
  const empty = systemPrompt({ scope });
  ok(empty.includes(IDENTITY) && /纯文本/.test(empty), '没有记忆时只剩身份 + 输出格式(不崩)');

  addMemory(PERSONA_ID, '这个人叫「好想光恶魔」,喜欢在群里发短句', { scope, importance: 0.9, src: 'msg:1' });
  addMemory(PERSONA_ID, '他问过「蒸馏我吗」', { scope, importance: 0.6, src: 'msg:2' });
  addMemory(PERSONA_ID, '别用书面语', { kind: 'style', scope, importance: 0.8 });
  addMemory(PERSONA_ID, '别人的秘密', { scope: { group: '793874011', user: '999' } });

  const p = systemPrompt({ scope });
  ok(/好想光恶魔/.test(p) && /蒸馏我吗/.test(p), '记忆进了 system prompt');
  ok(/别用书面语/.test(p), '风格记忆进提示词');
  ok(/纯文本,不是 Markdown/.test(p) && /不要用 \*\*加粗\*\*/.test(p), '写死「QQ 纯文本、不要 Markdown」');
  ok(/search_ygo_card/.test(p) && /web_search/.test(p) && /别硬编/.test(p), '写死「游戏王先查卡库/联网,别瞎编」');
  ok(!/别人的秘密/.test(p), '别人的记忆不串台');
  ok(/W14/.test(p) && !/贝利亚|脚刷周|西比拉|扮演/.test(p), '只有 W14 这一句身份,没有别的人设');
  ok(p.length <= 1900, `记忆块有预算(${p.length} 字符)`);

  const other = systemPrompt({ scope: { group: '793874011', user: '1' } });
  ok(!/好想光恶魔/.test(other), '换个人就看不到');
  ok(listMemories(PERSONA_ID, { scope }).length >= 3, '按作用域取到自己的记忆');
  ok(deleteMemory(PERSONA_ID, listMemories(PERSONA_ID, { scope }).find(e => /蒸馏/.test(e.text)).id).ok, '可删记忆');

  console.log(chunks.join('\n'));
  console.log(`\n${chunks.length - bad}/${chunks.length} 通过`);
  process.exitCode = bad ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) selftest();
