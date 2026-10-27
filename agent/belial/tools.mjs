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
    '在你文字回复后单独发一张表情包。想发就调用;发不发、发哪张由你决定,一次最多 2 张。可以给 name(文件名/关键词)或 scene(场景/情绪)。',
    {
      name: { type: 'string', description: '表情包文件名或关键词,如 01_quanwei.jpg / 权威 / 删了(可选)' },
      scene: { type: 'string', description: '场景或情绪,如「被叫肺雾很急」「对方夸我」(可选)' },
    },
    []),

  fn('search_stickers',
    '搜索网上的贝利亚表情包图片,返回图片直链。找到合适的再用 download_sticker 下载。',
    { query: { type: 'string', description: '图片搜索词,如「贝利亚表情包 删了」' } },
    ['query']),

  fn('download_sticker',
    '把公网图片 URL 下载进表情包库(≤5MB,只收 jpg/png/gif/webp)。下载后可用 send_sticker 发送。',
    {
      url: { type: 'string', description: '图片直链(http/https)' },
      name: { type: 'string', description: '保存的文件名(可选)' },
    },
    ['url']),
];

/** 给 list_stickers 工具返回的目录文本 */
export function stickerCatalogText() {
  const list = stickerCatalog();
  if (!list.length) return '表情包库是空的,暂时没图可发。';
  return list.map((s, i) => {
    const tags = Array.isArray(s.tags) && s.tags.length ? ` [${s.tags.join('/')}]` : '';
    return `${i + 1}. ${s.name} — ${s.desc || '无描述'}${tags}`;
  }).join('\n');
}
