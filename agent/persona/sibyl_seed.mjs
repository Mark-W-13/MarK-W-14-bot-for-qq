// 「西比拉」人格的初始化数据(2026-10-29)——
// 数据来源:SnowLuma 的 messages.db,群 793874011(复旦邻里交流群),用户 3080580848
// (群名片「好想光恶魔」)2026-03-14 ~ 2026-10-29 的 1670 条发言里人工提炼的**可核对事实**。
//
// 用法:
//   node agent/persona/sibyl_seed.mjs            # 写入(重复跑不会重复写,按作用域去重)
//   node agent/persona/sibyl_seed.mjs --dry-run  # 只打印将要写的内容
//   node agent/persona/sibyl_seed.mjs --show     # 打印这个人当前能看到的记忆块
//
// 作用域:**关于这个人的事实只挂 user**,不挂群 —— 他在哪个群说话都该认得他;
// 群里的公共黑话挂 group,换个人来也能用上。
import { addMemory, memoryPromptBlock, memoryStats } from './memory.mjs';

export const PERSONA = 'sibyl';
export const GROUP = '793874011';
export const USER = '3080580848';

/** @type {{text:string, kind:'fact'|'style', scope:'user'|'group', importance:number}[]} */
export const SEEDS = [
  // ---- 关于 3080580848 本人 ----
  { scope: 'user', importance: 0.9, text: '群友「好想光恶魔」的 QQ 是 3080580848,在群里主要聊游戏王,偶尔也聊生活。' },
  { scope: 'user', importance: 0.9, text: '好想光恶魔是复旦大学邯郸校区的学生,校内有电瓶车代步,常在南食二楼打牌和办赛。' },
  { scope: 'user', importance: 0.7, text: '好想光恶魔喜欢「小手坑均」的 40 卡展开卡组,讨厌 60 卡混轴和 FTK 卡组。' },
  { scope: 'user', importance: 0.7, text: '好想光恶魔常玩的卡组:磁石战士(地结界像/削手向)、码丽丝、奥义、亚特兰蒂斯。' },
  { scope: 'user', importance: 0.6, text: '好想光恶魔很讨厌「升月」卡组,认为升月内战主要拼连营能力。' },
  { scope: 'user', importance: 0.6, text: '好想光恶魔会在群里收卡、卖卡,做过单卡面交,也给人寄过快递。' },
  { scope: 'user', importance: 0.5, text: '好想光恶魔 2026 年 9 月底参与组织了南食群赛,提过瑞士轮第三轮开始有解说。' },
  { scope: 'user', importance: 0.5, text: '好想光恶魔很关注简中巡回赛和比赛环境,常分析哪些卡组会出轮。' },
  { scope: 'user', importance: 0.4, text: '好想光恶魔说话常带「我感觉/其实/我断言」,句子偏长。' },
  { scope: 'user', importance: 0.7, text: '好想光恶魔说群里有他的小号(如「框框kimi」小号);「好想光恶魔」这 id 是他自认为最豪的时候取的。' },
  { scope: 'user', importance: 0.5, text: '好想光恶魔爱预测比赛环境,说过「这周简中巡回赛必有奥义玛丽丝」这类话。' },
  { scope: 'user', importance: 0.6, text: '好想光恶魔常一起打牌/讨论构筑的群友:w13、mf、cmf、馆长、框框kimi。' },
  { scope: 'user', importance: 0.3, text: '好想光恶魔 2026-10-24 说上个月买的一大箱月饼终于吃完了。' },
  { scope: 'user', importance: 0.5, text: '好想光恶魔喜欢「小众嘉豪卡组偷环境」,会自称「小众嘉豪哥」。' },
  { scope: 'user', importance: 0.3, text: '好想光恶魔觉得游戏王比赛里的「警告」大多是逗你玩的。' },
  { scope: 'user', importance: 0.3, text: '好想光恶魔有一张碎的异画「风刀」,是朋友送的,想拿出来玩。' },
  { scope: 'user', importance: 0.3, text: '好想光恶魔玩 MD 时号很久不玩,上线常能从狼段一路连胜上狮子。' },

  // ---- 群 793874011 的公共记忆 ----
  { scope: 'group', importance: 0.6, text: '「复旦邻里交流群」里不少人聊游戏王,常约在南食二楼打牌、办群赛。' },
  { scope: 'group', importance: 0.5, text: '这个群的黑话:「升月」「野狗」「磁石」「码丽丝」「奥义」「嘉豪」。' },
  { scope: 'group', importance: 0.4, text: '群赛一般在南食二楼,人多时会在瑞士轮第三轮开始安排解说。' },
];

const scopeOf = s => (s === 'user' ? { user: USER } : { group: GROUP });
const dryRun = process.argv.includes('--dry-run');
const show = process.argv.includes('--show');

if (show) {
  const block = memoryPromptBlock(PERSONA, { scope: { group: GROUP, user: USER }, budgetChars: 1200 });
  console.log(block || '(空:这个作用域下还没有记忆)');
  console.log('\n统计:', JSON.stringify(memoryStats(PERSONA)));
  process.exit(0);
}

if (dryRun) {
  for (const s of SEEDS) console.log(`[${s.scope}] ${s.text}`);
  console.log(`\n共 ${SEEDS.length} 条(未写入)`);
  process.exit(0);
}

let added = 0, dup = 0, failed = 0;
for (const s of SEEDS) {
  const r = addMemory(PERSONA, s.text, {
    kind: s.kind || 'fact',
    scope: scopeOf(s.scope),
    importance: s.importance,
    src: 'seed:messages.db:793874011',
  });
  if (!r.ok) { failed++; console.log('✗', r.message, '|', s.text.slice(0, 30)); }
  else if (r.duplicate) dup++;
  else added++;
}
console.log(`写入完成:新增 ${added},已存在 ${dup},失败 ${failed}`);
console.log('统计:', JSON.stringify(memoryStats(PERSONA)));
console.log('这个人能看到的记忆块(前 400 字):\n' +
  memoryPromptBlock(PERSONA, { scope: { group: GROUP, user: USER }, budgetChars: 1200 }).slice(0, 400));
