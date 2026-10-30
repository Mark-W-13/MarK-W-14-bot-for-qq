// 「西比拉」人格的游戏王常识库(2026-10-29)——
// 数据来源:
//   ① 本仓库 `agent/ygometa/cache/threads.json`(上位卡组吧最近 30 天 771 帖 / 372 份构筑)统计出的
//      上位卡组与主轴频次;② 帖子正文里的打法/战报描述;③ `agent/ygocard/cards.json` 核对卡名。
// B 站教程页有验证码抓不了,所以卡组理解以贴吧战报与卡表统计为准,只写能核对的部分。
//
// 作用域:挂 group(793874011),因为这是那个群的共同话题;不挂 user。
// 用法:
//   node agent/persona/sibyl_ygo_seed.mjs            # 写入(去重)
//   node agent/persona/sibyl_ygo_seed.mjs --dry-run  # 只打印
//   node agent/persona/sibyl_ygo_seed.mjs --show     # 打印当前记忆块
import { addMemory, memoryPromptBlock, memoryStats } from './memory.mjs';

export const PERSONA = 'sibyl';
export const GROUP = '793874011';

export const SEEDS = [
  '2026-10 上位卡组吧的常见上位卡组:盈彩月夜、光与暗的仪式、闪刀姬、狱神/奥艺/耀圣、码丽丝、烙印、黯蜜、三幻魔、异解、磁石战士。',
  '盈彩月夜是近期最常上位的卡组之一,多数是 60 卡构筑,本家卡有「盈彩月夜之帐/雅/翼」。',
  '光与暗的仪式在 10 月表后从 beat 转向 60 卡展爆/封锁,常混烙印、黑魔术、圣徒。',
  '狱神/奥艺/耀圣是混轴卡组,典型终场是削手 + 超兽 + 加速小夜。',
  '狱神的一个常见 combo:水银兽吸素材调度神殿守卫者,创狱神解放道化 link2,道化洗手牌,四花拉墓地神殿和奥艺拳头,不吃坑能削光手牌。',
  '码丽丝是电子界连接卡组,靠除外赚资源,起手常靠白兔、柴郡猫、睡鼠这些本家下级。',
  '磁石战士是地属性岩石,靠「积木龙」攀 link、用「总剑司令 加特姆士」削手,先攻也能做地结界像封锁。',
  '闪刀姬是中速 beat,靠魔法卡和墓地资源打消耗,先攻做场面压制。',
  '烙印是融合系卡组,常和「光与暗的仪式」混轴。',
  '异解随机性大,展开和后攻是两套思路,新手要分开学。',
  'D.D.炸药是 FTK/一回杀 卡组,先攻不交互直接赢。',
  '60 卡构筑多是展爆/混轴(群里叫「野狗」),40 卡多是「小手坑均」。',
  '常见手坑:灰流丽、增殖的G、无限泡影、墓穴的指名者、效果遮蒙者、小丑与锁鸟、尼比鲁。',
  '比赛术语:瑞士轮、出轮、side、赢骰/输骰、BO1/BO3、削手、FTK、阻抗;先攻做场压死,后攻靠手坑打断再突破。',
  '上位卡组吧的战报格式:「XX 人 N 轮出 M」,后面列冠军/亚军/四强以及各自卡组名。',
];

const dryRun = process.argv.includes('--dry-run');
const show = process.argv.includes('--show');

if (show) {
  console.log(memoryPromptBlock(PERSONA, { scope: { group: GROUP, user: '3080580848' }, budgetChars: 2400 }) || '(空)');
  console.log('\n统计:', JSON.stringify(memoryStats(PERSONA)));
  process.exit(0);
}
if (dryRun) {
  for (const s of SEEDS) console.log('[group]', s);
  console.log(`\n共 ${SEEDS.length} 条(未写入)`);
  process.exit(0);
}

let added = 0, dup = 0, failed = 0;
for (const text of SEEDS) {
  const r = addMemory(PERSONA, text, {
    kind: 'fact', scope: { group: GROUP }, importance: 0.5, src: 'seed:ygometa/threads.json',
  });
  if (!r.ok) { failed++; console.log('✗', r.message, '|', text.slice(0, 30)); }
  else if (r.duplicate) dup++;
  else added++;
}
console.log(`写入完成:新增 ${added},已存在 ${dup},失败 ${failed}`);
console.log('统计:', JSON.stringify(memoryStats(PERSONA)));
