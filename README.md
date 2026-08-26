# QQ Agent(赛博史官)

QQ 机器人「测试bot.fd」(QQ 3757588606)的自动回复系统,两个功能:

1. **史记总结**:群里 **@机器人 且消息含「史记总结」** 时,拉取该群最近 100 条消息,用**史记体文言文**总结/回答(走 Claude,无头生成)。
2. **卡牌查询**:**@机器人 + 「效果 」+卡名**(触发词「效果」后须带空格,防「效果怪兽」等误触发;如 `@机器人 效果 青眼白龙` 或 `@机器人 效果 青眼 白龙` 空格分隔多关键词 AND 查询)时,从**本地卡库**查询并输出**最匹配的一张**的卡牌信息(中文名/日文名/类型/星级/攻防/效果文本)。纯本地运行,不依赖 AI。卡库来自百鸽 ygocdb 全量数据(14260 张,2026-08 更新)。@消息可识别真 @ 或纯文本「@昵称」。
3. **每日一卡**:群里 **@机器人 且消息含「每日一卡」** 时,从卡库随机抽一张卡回复完整信息;**同一 QQ 24 小时内重复申请返回同一张卡**(状态持久化于 `agent/daily_card.json`)。

**卡库更新**:monitor 控制台按 `u` 手动更新;或启动参数 `node monitor.mjs --update-cards` 启动即更新。流程:下载 cards.zip → 校验(JSON 完整性+卡数阈值,md5 仅参考) → 解压 → 原子替换 → 内存重载,失败不影响旧卡库。

## 系统组成

| 组件 | 位置 | 说明 |
|---|---|---|
| SnowLuma (OneBot 后端) | `tools/snowluma/` | QQ 协议层,HTTP 端口 3000 / WS 端口 3001 |
| 监控终端(一体化) | `agent/monitor.mjs` | WS 收 @ → 写 inbox → 分流处理(史记/查卡/每日一卡) → 发送;15s 兜底轮询、断线补收(2 分钟窗)、心跳自愈 |
| 卡牌查询模块 | `agent/ygocard/ygocard.mjs` | 纯本地卡库查询(14,260 张) |
| 一键启动 | `start.bat` | 检测/启动 SnowLuma + 打开 monitor 窗口 |
| 一键停止 | `stop.bat` | 停止 monitor(可选停 SnowLuma) |

## start.bat — 启动(双击即可)

依次执行:

1. **检查 SnowLuma**:已在运行则跳过;未运行则自动启动并等待就绪(最多 60 秒)
2. **检查消息监听器**:已在运行则跳过;未运行则后台启动 `listener.mjs` 并记录 pid
3. **显示 QQ 登录状态**(确认机器人在线)

适用场景:电脑重启后、SnowLuma 或监听器挂了之后,一键恢复整套服务。

## stop.bat — 停止(双击即可)

1. **停止消息监听器**(通过进程匹配,即使没有 pid 文件也能停)
2. **询问**「是否同时停止 SnowLuma 后端」,输入 `Y` 停止 / `N` 仅停监听器

适用场景:要下线机器人时;SnowLuma 需要重启(改配置、QQ 掉线重登)时。

## 完整工作流

```
日常运行(无需操作)
  start.bat ──→ SnowLuma + 监听器 常驻
                Claude Code 会话每分钟轮询 inbox,自动回复

恢复运行(机器重启后)
  1. 双击 start.bat
  2. 打开 Claude Code 会话,输入:恢复 QQ Agent 轮询
```

## 目录结构

```
mc_agent/
├── start.bat          # 一键启动
├── stop.bat           # 一键停止
├── README.md
├── .mcp.json          # MCP 配置(端口/令牌)
├── agent/
│   ├── listener.mjs   # 消息监听器
│   ├── extract.mjs    # 群历史提取器
│   ├── inbox.jsonl    # @请求 队列
│   ├── processed.jsonl# 已处理记录
│   ├── listener.log   # 监听器日志
│   └── run.bat        # 仅启动监听器
└── tools/snowluma/    # OneBot 后端
```

## 配置(敏感信息不入库)

- **`agent/.env`**(被 `.gitignore` 排除):OneBot token,格式:
  ```
  WS_TOKEN=ws 端口 token
  API_TOKEN=http 端口 token
  ```
  缺失时 monitor 启动会报错退出;`start.bat` 的登录检测也从该文件读取。
- **`.mcp.json`**(被 `.gitignore` 排除):Claude Code MCP 配置,参考 `.mcp.example.json` 创建。
- 环境变量可覆盖:WS_URL / API / WS_TOKEN / API_TOKEN / TRIGGER_KEYWORD / CARD_TRIGGER / DAILY_KEYWORD / BOT_ID / DRY_RUN。
- **卡库**:`agent/ygocard/cards.json` 不入库(约 14MB,可重建)。monitor 窗口按 `u` 或 `node monitor.mjs --update-cards` 联网更新。

## 注意事项

- 修改任何配置后需用 `stop.bat` 重启 SnowLuma 才生效
- QQ 掉线时:用 `stop.bat`(选 Y)停后端 → 重新打开 QQNT 登录 → `start.bat`
- 机器人只响应**群聊中 @它**的消息(私聊与其他消息不处理);无触发词的 @ 消息忽略
- **@+「史记总结」** → 史记体总结(触发词可用环境变量 `TRIGGER_KEYWORD` 覆盖);**@+「效果 」+卡名** → 本地卡牌查询(触发词可用 `CARD_TRIGGER` 覆盖,必须后跟空白)
- 卡牌查询支持中/日/英文名与别名(简中官方名、MD 译名等),多关键词空格分隔 AND 匹配
- 回复均 at 触发者
