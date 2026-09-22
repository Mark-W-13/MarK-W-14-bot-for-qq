// 分群「游戏模式」状态(2026-09-20 新增):决定 @ 机器人时走游戏王功能还是炉石功能。
//
//   用法:群里 @机器人 说「mode 炉石」/「mode 游戏王」→ 该群从此走对应游戏的功能,
//   直到再改。**默认游戏王**(老行为不变)。
//   存储:agent/modes.json,键是**群号**,值是 'ygo' | 'hs'(题目要求「群号+参数」)。
//   只影响游戏王/炉石相关的功能(查卡/卡图/每日一卡/卡组/裁定/推荐),
//   史记总结、AI 闲聊、搬屎、框神语录**不受影响**。
//
// 为什么不做成持久化在 monitor 内存里:opsweb(运维台)要能改,而它是**另一个进程**;
// 各进程都直接读写这个 JSON,monitor 每次用到时现读(文件很小,读一次几微秒),
// 所以 webui 改完立即生效,不需要通知 monitor、也不需要重启。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODES_PATH = process.env.MODES_PATH || join(__dirname, 'modes.json');

export const MODES = ['ygo', 'hs'];          // ygo=游戏王(默认) hs=炉石传说
export const MODE_CN = { ygo: '游戏王', hs: '炉石传说' };
export const DEFAULT_MODE = 'ygo';

/** 从任意输入认模式:支持 炉石/炉石传说/hs/hearthstone、游戏王/ygo/ygopro */
export function parseMode(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  if (/^(炉石|炉石传说|hs|hearthstone|hearthstone|hs\.?)$/.test(s)) return 'hs';
  if (/^(游戏王|ygopro|ygo|ocg|yu-?gi-?oh|yugioh|游戏王ocg)$/.test(s)) return 'ygo';
  return '';
}

function loadAll() {
  try {
    const j = JSON.parse(readFileSync(MODES_PATH, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function saveAll(obj) {
  try {
    mkdirSync(dirname(MODES_PATH), { recursive: true });
    writeFileSync(MODES_PATH + '.tmp', JSON.stringify(obj, null, 2), 'utf8');
    renameSync(MODES_PATH + '.tmp', MODES_PATH);
  } catch { /* 写失败不影响本次运行(退回内存里的判断,只是下次启动丢改动) */ }
}

/** 该群的模式(未设置 → 默认游戏王)。**每次现读文件**,webui 改完立即生效 */
export function modeOf(groupId) {
  const all = loadAll();
  const v = all[String(groupId)];
  return MODES.includes(v) ? v : DEFAULT_MODE;
}

/** 设置某群模式;返回 { ok, mode, changed } */
export function setMode(groupId, mode) {
  if (!MODES.includes(mode)) return { ok: false, mode: '', changed: false };
  const all = loadAll();
  const before = MODES.includes(all[String(groupId)]) ? all[String(groupId)] : DEFAULT_MODE;
  all[String(groupId)] = mode;
  all.updatedAt = Date.now();
  saveAll(all);
  return { ok: true, mode, changed: before !== mode };
}

/** 全部群 → 模式(运维台展示用;含 updatedAt 元数据) */
export function allModes() {
  const all = loadAll();
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === 'updatedAt') continue;
    if (MODES.includes(v)) out[k] = v;
  }
  return out;
}

export function modesPath() { return MODES_PATH; }

/**
 * 解析「mode …」指令。
 * 认这些写法(大小写、空格随意):`mode 炉石`、`mode 游戏王`、`mode炉石`、`模式 炉石`、`模式炉石`。
 * @returns {{triggered:boolean, mode:'ygo'|'hs'|''}}
 */
export function parseModeCommand(text) {
  const clean = String(text || '').replace(/\[at\]/g, ' ').trim();
  const m = clean.match(/^(?:mode|模式)\s*[:：]?\s*(\S*)/i);
  if (!m) return { triggered: false, mode: '' };
  return { triggered: true, mode: parseMode(m[1]) };
}

// CLI 自测:node modes.mjs [群号] [模式]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [gid, md] = process.argv.slice(2);
  if (!gid) {
    console.log('当前模式表:', JSON.stringify(allModes(), null, 2), '\n文件:', modesPath());
  } else if (!md) {
    console.log(`群 ${gid} → ${MODE_CN[modeOf(gid)]}(${modeOf(gid)})`);
  } else {
    console.log('设置:', JSON.stringify(setMode(gid, parseMode(md) || md)), '| 现在:', modeOf(gid));
  }
}
