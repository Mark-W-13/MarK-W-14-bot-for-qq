// 长期记忆库的手工管理 CLI(2026-10-29)——
// 给运维用:不启动 bot、不开面板,直接在服务器上查/加/改/删某个群的记忆。
//
// 存储是 `agent/persona/memory.jsonl`(只追加事件),所以这里的「改」是追加一条 upd 事件、
// 「删」是追加一条 del 事件——不会真正抹掉历史,出问题能反查。
//
// 用法(默认人格 sibyl):
//   node agent/persona/memory_cli.mjs list                       # 全部
//   node agent/persona/memory_cli.mjs list --user 3080580848     # 只看某人的
//   node agent/persona/memory_cli.mjs list --group 793874011 --kind fact
//   node agent/persona/memory_cli.mjs list --query 升月           # 关键词
//   node agent/persona/memory_cli.mjs show --user 3080580848 --group 793874011   # 看他能看到的提示词块
//   node agent/persona/memory_cli.mjs add --text "…" --group 793874011 --importance 0.6
//   node agent/persona/memory_cli.mjs edit --id mxxxx --text "…"
//   node agent/persona/memory_cli.mjs rm --id mxxxx
//   node agent/persona/memory_cli.mjs reject --text "…"          # 立墓碑,以后不许再记
//   node agent/persona/memory_cli.mjs rename --from old --to new
//   node agent/persona/memory_cli.mjs stats
//   node agent/persona/memory_cli.mjs --selftest
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  listMemories, addMemory, updateMemory, deleteMemory, rejectMemory,
  renamePersona, memoryPromptBlock, memoryStats,
} from './memory.mjs';

const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : '';
};
const has = name => argv.includes(`--${name}`);
const PERSONA = flag('persona') || 'sibyl';
const SCOPE = (() => {
  const group = flag('group');
  const user = flag('user');
  return group || user ? { ...(group ? { group } : {}), ...(user ? { user } : {}) } : null;
})();

function fmtScope(e) {
  if (!e.scope) return '全局';
  const parts = [];
  if (e.scope.group) parts.push(`群${e.scope.group}`);
  if (e.scope.user) parts.push(`人${e.scope.user}`);
  return parts.join('/');
}
function age(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d <= 0 ? '今天' : `${d}天前`;
}
function need(v, msg) {
  if (!v) { console.error(`缺参数:${msg}`); process.exit(2); }
  return v;
}

const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';

function cmdList() {
  const query = flag('query');
  const kind = flag('kind');
  const all = has('all');
  const list = listMemories(PERSONA, { scope: all ? null : SCOPE, query, kind, includeSeed: true });
  if (!list.length) { console.log('(没有匹配的记忆)'); return; }
  console.log(`人格 ${PERSONA} · ${list.length} 条${SCOPE ? ` · 过滤 ${fmtScope({ scope: SCOPE })}` : ''}\n`);
  for (const e of list) {
    console.log(`${e.id}  [${e.kind}]${e.seed ? ' [内置]' : ''}  {${fmtScope(e)}}  ${age(e.updatedAt || e.createdAt)}`);
    console.log(`  ${e.text}`);
  }
}

function cmdShow() {
  const block = memoryPromptBlock(PERSONA, { scope: SCOPE, budgetChars: Number(flag('budget') || 2400) });
  console.log(block || '(空:这个作用域下没有记忆)');
  console.log('\n统计:', JSON.stringify(memoryStats(PERSONA)));
}

function cmdAdd() {
  const text = need(flag('text'), '--text');
  const r = addMemory(PERSONA, text, {
    kind: flag('kind') || 'fact',
    scope: SCOPE,
    importance: Number(flag('importance') || 0.6),
    src: 'cli',
  });
  console.log(r.ok ? `✓ ${r.duplicate ? '已存在' : '已添加'} ${r.entry?.id || ''} ${r.entry?.text || ''}` : `✗ ${r.message}`);
  process.exitCode = r.ok ? 0 : 1;
}

function cmdEdit() {
  const id = need(flag('id'), '--id');
  const text = need(flag('text'), '--text');
  const r = updateMemory(PERSONA, id, text);
  console.log(r.ok ? `✓ 已改 ${id} → ${text}` : `✗ ${r.message}`);
  process.exitCode = r.ok ? 0 : 1;
}

function cmdRm() {
  const id = need(flag('id'), '--id');
  const r = deleteMemory(PERSONA, id);
  console.log(r.ok ? `✓ 已删 ${id}(${r.entry?.text?.slice(0, 40) || ''})` : `✗ ${r.message}`);
  process.exitCode = r.ok ? 0 : 1;
}

function cmdReject() {
  const text = need(flag('text'), '--text');
  const r = rejectMemory(PERSONA, text);
  console.log(r.ok ? `✓ 已立墓碑:${text}` : `✗ ${r.message}`);
  process.exitCode = r.ok ? 0 : 1;
}

function cmdRename() {
  const from = need(flag('from'), '--from');
  const to = need(flag('to'), '--to');
  const r = renamePersona(from, to);
  console.log(r.ok ? `✓ ${from} → ${to}(${r.moved ?? '-'} 条)` : `✗ ${r.message}`);
  process.exitCode = r.ok ? 0 : 1;
}

function cmdStats() {
  console.log(JSON.stringify(memoryStats(PERSONA), null, 2));
}

// ---------- 自测 ----------
function selftest() {
  const tmp = join(process.env.TEMP || process.env.TMPDIR || '/tmp', `mem-cli-${process.pid}-${Date.now()}`, 'memory.jsonl');
  process.env.PERSONA_MEMORY_PATH = tmp;
  const chunks = [];
  let bad = 0;
  const ok = (c, m) => { if (!c) bad++; chunks.push(`${c ? '✓' : '✗'} ${m}`); };

  const a = addMemory('sibyl', '张三喜欢磁石卡组', { scope: { group: 'g1', user: 'u1' }, importance: 0.8 });
  ok(a.ok && a.entry.id, '加一条');
  const l1 = listMemories('sibyl', { scope: { group: 'g1', user: 'u1' } });
  ok(l1.length === 1 && /磁石/.test(l1[0].text), '按作用域列出来');
  const up = updateMemory('sibyl', a.entry.id, '张三喜欢磁石和码丽丝');
  ok(up.ok && /码丽丝/.test(listMemories('sibyl', { scope: { group: 'g1', user: 'u1' } })[0].text), '改一条');
  const de = deleteMemory('sibyl', a.entry.id);
  ok(de.ok && listMemories('sibyl', { scope: { group: 'g1', user: 'u1' } }).length === 0, '删一条');
  const rj = rejectMemory('sibyl', '张三开保时捷');
  const again = addMemory('sibyl', '张三开保时捷', { scope: { group: 'g1', user: 'u1' } });
  ok(rj.ok && again.ok === false, '墓碑拦住重新写入');
  const mv = renamePersona('sibyl', 'sibyl2');
  ok(mv.ok && listMemories('sibyl2').length === 0, '改名后源人格清空(墓碑不算动态记忆)');

  console.log(chunks.join('\n'));
  console.log(`\n${chunks.length - bad}/${chunks.length} 通过`);
  process.exitCode = bad ? 1 : 0;
}

if (has('selftest')) selftest();
else if (cmd === 'list') cmdList();
else if (cmd === 'show') cmdShow();
else if (cmd === 'add') cmdAdd();
else if (cmd === 'edit') cmdEdit();
else if (cmd === 'rm') cmdRm();
else if (cmd === 'reject') cmdReject();
else if (cmd === 'rename') cmdRename();
else if (cmd === 'stats') cmdStats();
else {
  console.error('未知命令。可用:list / show / add / edit / rm / reject / rename / stats / --selftest');
  process.exit(2);
}
