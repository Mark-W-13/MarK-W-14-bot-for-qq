// 银河皇帝模式给模型的工具定义(OpenAI / DeepSeek function calling)
//
// 2026-10-26 用户要求:
//   · 表情包不再由代码按概率发,改成模型可以调的 send_sticker,由模型自己决定发不发/发哪张;
//   · 给模型联网搜(DeepSeek 官方 Search API)和下载表情包的权限。
//
// 工具执行在 monitor.mjs 的 aiChatBelial 里(要拿到群号、发图、记账),这里只定义 schema
// 和给模型看的「表情包目录」文本。
import { stickerCatalog } from './belial.mjs';

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: {
    name, description,
    parameters: { type: 'object', properties, required },
  },
});

export const BELIAL_TOOLS = [
  fn('web_search',
    '用 DeepSeek 官方搜索查时效性事实、梗的来源或你不确定的信息。纯闲聊/算数/群里的梗不用搜,别为了显得勤快去搜。',
    {
      query: { type: 'string', description: '搜索词,1~128 字' },
      ori_question: { type: 'string', description: '用户原始问题(可选,帮助搜索理解意图)' },
    },
    ['query']),

  fn('list_stickers',
    '列出当前表情包库(文件名、描述、标签)。想发图但不知道有哪些时先调用。',
    {}, []),

  fn('send_sticker',
    '单独发一张表情包(独立成条)。想发就调用;发不发、发哪张由你决定,一次最多 2 张。可以给 name(文件名/关键词)或 scene(场景/情绪)。',
    {
      name: { type: 'string', description: '表情包文件名或关键词,如 01_quanwei.jpg / 权威 / 删了(可选)' },
      scene: { type: 'string', description: '场景或情绪,如「被叫肺雾很急」「对方夸我」(可选)' },
      cache_id: { type: 'string', description: 'tmp_pic 缓存 id(联网下载的图;可选)' },
    },
    []),

  fn('delete_sticker',
    '从当前表情包库删除一张图。只在用户明确让你删时调用;name 必须是 list_stickers 返回的准确文件名,删了不可恢复。',
    {
      name: { type: 'string', description: '要删除的表情包文件名(先用 list_stickers 确认)' },
    },
    ['name']),

  fn('search_stickers',
    '通用图片搜索:按关键词搜网上的图片/表情包,返回图片直链。不限于贝利亚或某个角色,搜什么主题都行;找到合适的再用 download_sticker 下载。',
    { query: { type: 'string', description: '图片搜索词,如「震惊 表情包」「奶龙 无语」「原神 可莉」' } },
    ['query']),

  fn('download_sticker',
    '把公网图片 URL 下载到 tmp_pic 临时缓存(≤5MB,只收 jpg/png/gif/webp),默认**不**进表情包库;下载后可用 send_sticker(cache_id) 发。只有用户明确说「存到表情包库/存进库里」时,才传 save_to_library=true。',
    {
      url: { type: 'string', description: '图片直链(http/https)' },
      name: { type: 'string', description: '保存/缓存的文件名(可选)' },
      save_to_library: { type: 'boolean', description: '默认 false=只缓存;用户明确要求入库时才 true' },
    },
    ['url']),

  fn('list_tmp_pics',
    '列出 tmp_pic 里最近联网下载的图(最多 10 张,未入库)。想发之前下载的图、或想入库时先看。',
    {}, []),

  fn('save_cached_pic',
    '把 tmp_pic 缓存里的某张图存进当前表情包库(不可逆地入库)。只在用户明确要求把这张图存到表情包库时调用。',
    {
      cache_id: { type: 'string', description: 'list_tmp_pics / download_sticker 返回的 cache id' },
    },
    ['cache_id']),

  fn('list_group_stickers',
    '列出本群最近收到的表情包(id/时间/发送者)。想存群友发的表情包但不确定是哪张时先看。不会自动下载。',
    {}, []),

  fn('save_group_sticker',
    '把本群某张表情包下载进表情包库。给 id(先 list_group_stickers);不给就存最近一张。只有你决定存时才调用,系统不会自动收。',
    {
      id: { type: 'string', description: 'list_group_stickers 返回的 id,如 s12(可选;不给存最近一张)' },
    },
    []),

  fn('name_sticker',
    '给表情包写名字/描述/标签,让 list_stickers 和 send_sticker 能认出它。name 是库里的文件名;desc 写图里是什么,label 是短名。',
    {
      name: { type: 'string', description: '表情包文件名,如 up_群表情_xxx.jpg' },
      desc: { type: 'string', description: '描述这张图是什么,1~80 字(可选)' },
      tags: { type: 'array', items: { type: 'string' }, description: '3~8 个中文标签(可选)' },
      label: { type: 'string', description: '短名,如「权威」「删了」(可选)' },
    },
    ['name']),

  fn('describe_sticker',
    '让视觉模型看一眼表情包库里的图,自动识别内容并写描述/标签。不知道某张是什么时用。',
    { name: { type: 'string', description: '表情包文件名' } },
    ['name']),

  fn('send_quote',
    '引用当前这条消息回一句(独立一条)。text 是要说的话;**正文里不要再重复引用里的同一句**,只写补充。',
    {
      text: { type: 'string', description: '引用回复的内容,1~200 字' },
      message_id: { type: 'string', description: '要引用的消息 id(可选,默认当前消息)' },
    },
    ['text']),

  fn('send_face',
    '单独发一个 QQ 表情(不是表情包图片)。face 填 QQ 表情目录里的名字或数字 id,如 doge / 微笑 / 笑哭 / 吃瓜 / 赞;不确定先 list_reactions 查名字。',
    { face: { type: 'string', description: 'QQ 表情名或数字 id,如 doge / 179 / 笑哭 / 182' } },
    ['face']),

  fn('react_message',
    '给当前消息贴一个表情回应(QQ 的“贴表情”)。emoji 用 QQ 表情目录里的名字(如 吃糖/笑哭/玫瑰/doge)、emoji 或数字 id;用户说糖就查「吃糖」,别默认笑哭;不确定先 list_reactions(query)。',
    {
      emoji: { type: 'string', description: 'QQ 表情名 / emoji / 数字 id,默认 赞' },
      message_id: { type: 'string', description: '要贴的消息 id(可选,默认当前消息)' },
    },
    []),

  fn('list_reactions',
    '从 QQ 全量表情目录里查贴表情的名字和 ID。不填 query 列前 40 个;查「糖」「笑哭」「玫瑰」等用 query 过滤。用户点名一个你不确定的表情时先查,别自己猜成笑哭。',
    {
      query: { type: 'string', description: '按名字搜,如 糖 / 笑哭 / 玫瑰;不填列前 40 个' },
    },
    []),

  fn('list_voices',
    '列出可用声源(贝利亚/可莉/老牧师/皇帝/年轻男声/女声/搞笑),并显示 WebUI 当前默认声线。想发语音但不确定用哪个声源时先调用。',
    {}, []),

  fn('send_voice',
    '在你文字回复后单独发一条语音。text 是要说的内容,短、口语、像你嘴里说出来的;voice 默认跟随 WebUI 当前声线(贝利亚/可莉/老牧师),一般别乱换。语音少发,别频繁;但决定发就正常发,一次最多 1 条。',
    {
      text: { type: 'string', description: '语音内容,1~120 字,要像口语' },
      voice: { type: 'string', description: '声源 id,默认跟随 WebUI 当前声线;可用 list_voices 查看' },
    },
    ['text']),
];

/** 普通 AI 闲聊也能用的 QQ 操作工具(引用/QQ表情/贴表情);发送与护栏和贝利亚共用 */
export const QQ_TOOLS = BELIAL_TOOLS.filter(t =>
  ['send_quote', 'send_face', 'react_message'].includes(t.function.name));

/** 普通 AI 闲聊的完整聊天工具:QQ 操作 + 看表情包库/发表情包 */
export const CHAT_TOOLS = BELIAL_TOOLS.filter(t =>
  ['send_quote', 'send_face', 'react_message', 'list_reactions', 'list_stickers', 'send_sticker'].includes(t.function.name));

/** 给 list_stickers 工具返回的目录文本(默认贝利亚库;别的人格传自己的 catalog 函数) */
export function stickerCatalogText(catalog = stickerCatalog) {
  const list = typeof catalog === 'function' ? catalog() : (catalog || []);
  if (!list.length) return '表情包库是空的,暂时没图可发。';
  return list.map((s, i) => {
    const tags = Array.isArray(s.tags) && s.tags.length ? ` [${s.tags.join('/')}]` : '';
    const label = s.label ? `【${s.label}】` : '';
    return `${i + 1}. ${s.name} — ${label}${s.desc || '无描述'}${tags}`;
  }).join('\n');
}
