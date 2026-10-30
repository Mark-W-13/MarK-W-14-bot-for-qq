// SYSTEM 接口测试控制台(2026-10-28)
//
// 主人在群里发 `system <指令>` → 这段指令交给一个**带工具**的模型对话,用来测机器人对外暴露的几个接口:
//   · 联网搜索   web_search
//   · 表情包     list_stickers / send_sticker / search_stickers / download_sticker
//   · 语音       list_voices / send_voice
// 模型自己决定调哪个接口,调完用文字说结果;表情包/语音由 monitor 在文字之后单独发出去。
//
// 设计口径:
//   · `system` 是**消息分流标记**:monitor 在把消息交给模型之前就消费掉,正文里不会出现这个词。
//   · 这条通道**不套**仓库里写的人设与档位(史官/贝利亚/贴吧鱼/tone 规则都不生效)——
//     它是主人自己的测试台,提示词见 monitor.mjs 的 SYSTEM_CONSOLE_PROMPT。
//     (去掉的只是本仓库自己写的提示词;模型厂商自带的安全策略不在这里,也去不掉。)
//   · 只对 ADMIN_QQ(默认 3344195836)生效;每条写 agent/admin_audit.jsonl(不做限频)。
//   · 不接 shell、不做任意服务器操作:给模型的就是上面那几个接口,没有别的。
//
// 离线自测:node admin.mjs --selftest
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 唯一被授权的 QQ(env ADMIN_QQ 可覆盖) */
export const ADMIN_QQ = String(process.env.ADMIN_QQ || '3344195836').trim();
/** 消息分流标记(只认这一个词,大小写不敏感) */
export const ADMIN_PREFIX = 'system';
/** 可选:把控制台再收窄到这几个群(空 = 不限制群) */
const ADMIN_GROUPS = String(process.env.ADMIN_GROUPS || '')
  .split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);

const auditPath = () => process.env.ADMIN_AUDIT_PATH || join(__dirname, 'admin_audit.jsonl');
const AUDIT_MAX_BYTES = 512 * 1024;      // 超过就只留最近 500 行

/** 这个 QQ 号是不是主人 */
export function isAdminUser(uid) {
  return !!uid && String(uid) === ADMIN_QQ;
}

/** 本群在不在管理员白名单里(没配 ADMIN_GROUPS 就全放行) */
export function isAdminGroup(groupId) {
  return !ADMIN_GROUPS.length || ADMIN_GROUPS.includes(String(groupId));
}

/**
 * 解析分流标记。**只认整词**:`system` / `SYSTEM` / `system 查一下…` 算,`systemx`、中文「系统」不算。
 * @returns {null | { body: string }} null = 这条消息不是控制台指令
 */
export function parseAdminCommand(text) {
  let clean = String(text ?? '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')     // 原始 CQ 码(有些事件里没拆成段)
    .replace(/\[at\]/g, ' ')            // inbox 条目里的 @ 占位符
    .replace(/\s+/g, ' ').trim();
  // 引用时 QQ 会在正文前塞一个 `[reply]` 段(有时还有 [image]/[face] 等),不剥掉的话
  // 「引用 + system …」就不以 system 开头,会直接跳出控制台当普通聊天。先剥掉这些前置段占位符。
  clean = clean.replace(/^(?:\[(?:reply|image|mface|face|record|video|forward|json|xml|card|markdown|inline_keyboard)\]\s*)+/i, '').trim();
  const m = clean.match(/^system(?=$|\s)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { body: (m[1] || '').trim() };
}

const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));

// ---------- 审计 ----------
function rotateAuditIfBig() {
  try {
    const p = auditPath();
    if (!existsSync(p) || statSync(p).size < AUDIT_MAX_BYTES) return;
    const keep = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-500);
    writeFileSync(p + '.tmp', keep.join('\n') + '\n', 'utf8');
    renameSync(p + '.tmp', p);
  } catch { /* 审计写不动不影响执行 */ }
}

function appendAudit(entry, cmd, ok, note) {
  rotateAuditIfBig();
  try {
    appendFileSync(auditPath(), JSON.stringify({
      t: Date.now(),
      qq: String(entry.user_id ?? ''),
      group_id: String(entry.group_id ?? ''),
      group_name: entry.group_name || '',
      text: clip(cmd.body || '', 200),
      ok,
      ...(note ? { note: clip(note, 120) } : {}),
    }) + '\n');
  } catch { /* 同上 */ }
}

/** 空指令时的提示(不是命令表,只说明这条通道能测什么) */
export const USAGE = '用法:system <指令>。这条通道可以测:联网搜索 / 发/搜/下表情包 / 发语音。\n例:system 搜一下今天的游戏王禁卡表;system 发张表情包;system 用贝利亚声音说一句话。';

/**
 * 执行一条控制台指令。调用方负责鉴权(isAdminUser / isAdminGroup)。
 * @param entry  inbox 风格条目:{ group_id, group_name, user_id, nickname, … }
 * @param cmd    parseAdminCommand() 的结果
 * @param deps   { log(tag,msg), sendReply(entry,text), console(entry, text) }
 *               其中 console 由 monitor 实现:带工具跑一轮对话,并负责把文字/表情包/语音发出去。
 * @returns {Promise<boolean>} 恒为 true(这条消息已被控制台消费)
 */
export async function handleAdminCommand(entry, cmd, deps) {
  const body = String(cmd.body || '').trim();
  let ok = true;

  deps.log('▶ SYSTEM', `[${entry.group_name || entry.group_id}] ${entry.nickname}(${entry.user_id}): ${body.slice(0, 60)}`);

  try {
    if (!body) {
      await deps.sendReply(entry, USAGE);
    } else if (body.length > 4000) {
      ok = false;
      await deps.sendReply(entry, '【SYSTEM】指令太长(>4000 字),没执行。');
    } else {
      await deps.console(entry, body);          // 发消息由 console 负责(文字 + 表情包 + 语音)
    }
  } catch (e) {
    ok = false;
    deps.log('SYSTEM 执行失败', e.message);
    try { await deps.sendReply(entry, `【SYSTEM】执行失败:${clip(e.message, 120)}`); } catch { /* 回执也发不出去就算了 */ }
  } finally {
    appendAudit(entry, cmd, ok);
  }
  return true;
}

// ---------- 离线自测:node admin.mjs --selftest ----------
async function selftest() {
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; console.log(`${c ? '✓' : '✗'} ${m}`); };

  // ① 分流标记:整词、大小写、@ 占位符、CQ 码;不认 systemx / 中文「系统」/ 句中出现
  ok(parseAdminCommand('system')?.body === '', '「system」单独一条 → 空指令(回用法)');
  ok(parseAdminCommand('system 搜一下今天的禁卡表')?.body === '搜一下今天的禁卡表', 'system + 指令 → 取整段');
  ok(parseAdminCommand('  SYSTEM   发张表情包 ')?.body === '发张表情包', '大小写/多空格都认');
  ok(parseAdminCommand('[CQ:at,qq=1] system ping')?.body === 'ping', '带 CQ 码也能认');
  ok(parseAdminCommand('[at] system 来条语音')?.body === '来条语音', 'inbox 的 [at] 占位符也能认');
  ok(parseAdminCommand('[reply]system 发张表情包')?.body === '发张表情包', '引用([reply])后仍然进控制台');
  ok(parseAdminCommand('[reply][image]SYSTEM 看图')?.body === '看图', '引用+图片前缀也能认');
  ok(parseAdminCommand('[reply]随便聊两句') === null, '引用但不以 system 开头 → 照常当聊天');
  ok(parseAdminCommand('systemx 查一下') === null, 'systemx 不算(必须是整词)');
  ok(parseAdminCommand('系统 查一下') === null, '中文「系统」不算(群聊常用词)');
  ok(parseAdminCommand('随便说 system 查一下') === null, '不在开头的 system 不算');
  ok(parseAdminCommand('') === null, '空文本不算');

  // ② 鉴权只认那一个号
  ok(isAdminUser('3344195836'), '主人 QQ(字符串)放行');
  ok(isAdminUser(3344195836), '主人 QQ(number)同样放行');
  ok(!isAdminUser('3344195837'), '别的 QQ 不放行');
  ok(!isAdminUser(''), '空 user_id 不放行');

  // ③ 分发:指令原样交给 deps.console(不套命令表、不改写正文)
  process.env.ADMIN_AUDIT_PATH = join(__dirname, `admin_selftest_${process.pid}.jsonl`);
  const replies = [];
  const got = [];
  const deps = {
    log: () => {},
    sendReply: async (_e, t) => { replies.push(t); },
    console: async (_e, t) => { got.push(t); },
  };
  const entry = { group_id: 123, group_name: '测试群', user_id: ADMIN_QQ, nickname: '主人' };
  const run = async (line) => {
    replies.length = 0;
    await handleAdminCommand(entry, parseAdminCommand(line), deps);
    return replies.join('\n');
  };

  ok((await run('system 搜一下今天的游戏王禁卡表')) === '' && got.at(-1) === '搜一下今天的游戏王禁卡表',
    '指令原样交给 console(整段,不拆词)');
  ok((await run('system')).includes('system <指令>'), '空指令回一行用法');
  await run('system 用贝利亚声音说一句话');
  ok(got.at(-1) === '用贝利亚声音说一句话', '中文指令不被改写');
  const audit = (() => { try { return readFileSync(process.env.ADMIN_AUDIT_PATH, 'utf8'); } catch { return ''; } })();
  ok(audit.includes('用贝利亚声音说一句话'), '审计记下了指令原文');
  try { (await import('node:fs')).unlinkSync(process.env.ADMIN_AUDIT_PATH); } catch {}

  console.log(bad ? `\n✗ ${bad} 项不过` : '\n✓ 全部通过');
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--selftest')) selftest();
  else console.log(`用法: node admin.mjs --selftest\n(控制台:仅 ${ADMIN_QQ} 的「system …」生效)`);
}
