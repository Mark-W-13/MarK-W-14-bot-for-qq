// 「西比拉」人格(2026-10-29 正式上线)—— 记忆驱动:system prompt 只有一句身份 + 长期记忆块,没有人设。
//
// 由来:先用「记忆测试」人格验证了 memory.mjs 的作用域/召回/预算,上线时定名「西比拉」——
// 它不认识你,除非记忆里有你;它也不扮演谁,所有「性格」都来自记忆库(用户档案、群黑话、游戏王常识)。
// 想改它的说话方式就改记忆(kind=style),不要往这里加提示词,否则分不清是「记住了」还是「设定」。
//
// 注册:monitor.mjs 的 PERSONA_SPECS.sibyl + belial.mjs 的 PERSONA_IDS + opsweb 下拉。
// 开关:与其它人格共用 belial/state.json,`personas[群号] = "sibyl"` 即在该群启用。
import { memoryPromptBlock, addMemory } from './memory.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const PERSONA_ID = 'sibyl';
export const PERSONA_CN = '西比拉';
export const KEYWORD = '西比拉';
/** 切到该人格时的群名片;可用 env 覆盖,设为空串则不改名片。 */
export const GROUP_CARD = process.env.SIBYL_GROUP_CARD ?? '西比拉';
export const MAX_REPLY = Math.max(1, Number(process.env.SIBYL_MAX_REPLY || 2));
export const MAX_CHARS = Math.max(20, Number(process.env.SIBYL_MAX_CHARS || 60));
export const REPLY_GAP_MS = Math.max(0, Number(process.env.SIBYL_REPLY_GAP_MS ?? 500));
export const MAX_STICKERS = Math.max(0, Number(process.env.SIBYL_MAX_STICKERS || 1));

/** 身份只有一句,其余全靠记忆块;记忆为空时也要能报名字。 */
export const IDENTITY = '你叫「西比拉」,在这个群里聊天。';

/**
 * @param {{scope?:{group?:string,user?:string}, query?:string}} opts
 *   query:本轮消息,用来给「群/全局」记忆做关键词排序(用户档案始终注入)。
 */
export function systemPrompt({ scope = null, query = '' } = {}) {
  const block = memoryPromptBlock(PERSONA_ID, { scope, query, budgetChars: 2400 });
  return block ? `${IDENTITY}\n\n${block}` : IDENTITY;
}

export function activationLine() { return '西比拉上线。'; }
export function againLine() { return '西比拉已经在岗。'; }
export function offLine() { return '西比拉下线。'; }
export function statusLine(on) { return on ? '西比拉在岗。' : '西比拉没上线。'; }

// ---------- 自测 ----------
function selftest() {
  const chunks = [];
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; chunks.push(`${c ? '✓' : '✗'} ${m}`); };
  const tmp = join(process.env.TEMP || process.env.TMPDIR || '/tmp', `sibyl-${process.pid}-${Date.now()}`, 'memory.jsonl');
  process.env.PERSONA_MEMORY_PATH = tmp;

  const scope = { group: '793874011', user: '3080580848' };
  const empty = systemPrompt({ scope });
  ok(empty === IDENTITY && /西比拉/.test(empty), '没有记忆时只剩一句身份(不崩)');

  addMemory(PERSONA_ID, '这个人叫「好想光恶魔」,喜欢在群里发短句', { scope, importance: 0.9, src: 'msg:1' });
  addMemory(PERSONA_ID, '他问过「蒸馏我吗」', { scope, importance: 0.6, src: 'msg:2' });
  addMemory(PERSONA_ID, '别用书面语', { kind: 'style', scope, importance: 0.8 });
  addMemory(PERSONA_ID, '别人的秘密', { scope: { group: '793874011', user: '999' } });

  const p = systemPrompt({ scope });
  ok(/好想光恶魔/.test(p) && /蒸馏我吗/.test(p), '记忆进了 system prompt');
  ok(/别用书面语/.test(p), '风格记忆进提示词');
  ok(!/别人的秘密/.test(p), '别人的记忆不串台');
  ok(/西比拉/.test(p) && !/贝利亚|脚刷周|扮演/.test(p), '只有西比拉这一句身份,没有别的人设');
  ok(p.length <= 1300, `记忆块有预算(${p.length} 字符)`);

  const other = systemPrompt({ scope: { group: '793874011', user: '1' } });
  ok(!/好想光恶魔/.test(other), '换个人就看不到');

  console.log(chunks.join('\n'));
  console.log(`\n${chunks.length - bad}/${chunks.length} 通过`);
  process.exitCode = bad ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) selftest();
