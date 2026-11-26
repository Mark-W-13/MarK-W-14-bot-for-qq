# 工作流约定（给后续 agent）

## 默认只改服务器端

- 生产环境是 Ubuntu 服务器 `w-13@192.144.153.94`，代码目录 `~/mc_agent`，Node 路径 `/home/w-13/opt/node/bin/node`。
- **一般只改服务器端，不改用户本地 `C:\Users\hp\Desktop\牌\mc_agent` 的代码。**
  - 本地仓库只作参考/查看；不要在本地改完再同步，除非用户明确要求。
  - 需要改代码时，直接 SSH 到服务器，用 heredoc / patch / sed 修改 `~/mc_agent/...`。
- 更新流程（**2026-11-26 起：更新前必须先停 monitor，并确认没有游离的 monitor 进程**）：
  1. 备份：`tar czf ~/backups/mc_agent_code_$(date +%Y%m%d_%H%M%S).tgz -C ~/mc_agent <改动文件>`
  2. **停 monitor**：`systemctl --user stop mc-agent`（只停 monitor，**不要停 snowluma / qq**）
  3. **确认真的停了**：`ps -eo pid,args | grep 'agent/monitor.mjs' | grep -v grep` 必须没有输出。
     - 手动跑过 `node monitor.mjs ...` 的进程不属于 systemd，`systemctl stop` 杀不到，会继续连 WS 回话；
       发现就 `kill <pid>`。自测参数（`--persona-selftest` 等）已加进 ASKIP，正常情况下不会再误启 main。
  4. 改文件 / 拷贝
  5. 语法检查：`/home/w-13/opt/node/bin/node --check <改动文件>`
  6. 起 monitor：`systemctl --user start mc-agent`（snowluma / qq 保持不动；它们本来就在跑）
  7. 验证：`systemctl --user is-active mc-agent opsweb snowluma qq`，必要时看 `tmux capture-pane -p -t mc` 或 `journalctl --user -u mc-agent`
- 不要覆盖服务器上的运行态文件：
  - `agent/persona/kit/state.json`（人格开关/名片/概率）
  - `agent/persona/mem/<人格>/notes.jsonl`、`profiles/<群号>.json`、`dream_state.json`（每个人格独立的记忆）
  - `agent/persona/kit/sticker_meta.json`、`agent/jiaoshuazhou/sticker_meta.json`
  - `agent/persona/kit/stickers/up_*`、`agent/jiaoshuazhou/stickers/up_*`
  - `agent/ygocard/cards.json`（服务器版本比本地新）
  - `agent/ygocard/cards_img/`（服务器有 2.3G 卡图，本地没有）

## 当前功能背景（2026-11-26）

- 人格：**脚刷周**、**W14**（W14 由原「西比拉」改名，记忆驱动、一句身份 + 记忆块）。贝利亚/西比拉已从注册表、群指令、面板移除；
  共用工具库在 `agent/persona/kit/`（分群开关/名片/概率/表情包库/回复拆分，原 `belial/` 迁入并改名）。
- 群 `793874011`：人格 = W14，`state.json` 的 `autoReply['793874011'] = false`（不 @ 也自动接话关掉；@ 仍正常回）。
- 人格记忆架构（`agent/persona/membrain.mjs`）：每个人格一套独立目录、结构相同：
  1. 转录（群聊记录，不落盘）→ 2. 笔记 `notes.jsonl`（模型 `add_memory` + 每 100 条消息提炼）→
  3. 群档案 `profiles/<群号>.json`（做梦时按记录校准/沉淀）→ 4. 注入层（每次回复前 ≤700 字：档案摘要 + 相关笔记）。
  - 做梦：每群 ≥90 分钟一次、≥120 条消息或 6 小时过期触发；做四件事：校准（与记录冲突以记录为准）、合并、补充、写档案。
  - **玩笑/梗可以记，但要分辨**：用 `kind=joke` 存，注入时单独一段【群里的玩笑/梗】，并写明「是玩笑，不是事实，也不是你要扮演的人设」。
    机器人相关的玩笑（史官/霸总/互指 bot/DeepSeek 被投喂小说）也归到玩笑段，不能写成事实或机器人人设；机器人不算群成员。
  - 手动补跑：`node agent/monitor.mjs --persona-dream <人格id> <群号>`（会真调模型）。
  - 阈值环境变量见 `membrain.mjs` 顶部 `PERSONA_*`。
- 记忆检索仍是混合检索（关键词 + 中文 2-gram 模糊 + 重要度/新近度/作用域）；`PERSONA_MEMORY_RETRIEVAL=legacy` 可回退。
- 独立贴表情：`state.json` 的 `reactProb`，命中后由模型判断是否贴 笑哭/棒棒糖/鲸鱼，最多 3 个。
- 卡牌工具：`search_ygo_card` / `send_ygo_card_image` / `send_random_ygo_card`，本地卡库和卡图。
- 运维台 WebUI（`opsweb`，`http://127.0.0.1:8090`）已改成站内书签页：概览 / 人格 / 记忆 / 闲聊 / 系统 / 日志。
  「记忆」页有可折叠的每人格文件层级图和原文链接（`/api/mem/file?path=...`，只允许读 `agent/persona/mem` 下的文件）。

## 回复习惯

- 中文、简洁；先给结论。
- 不暴露 AI 身份；不主动解释功能/梗的来源。
- 用户说“改服务器端”时，直接部署并验证，不要只改本地。
