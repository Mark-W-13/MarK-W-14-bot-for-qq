# QQ Agent(赛博史官)

QQ 机器人「测试bot.fd」(QQ 3757588606)的自动回复系统,两个功能:

1. **史记总结**:群里 **@机器人 且消息含「史记总结」** 时,拉取该群最近 100 条消息,用**史记体文言文**总结/回答(走 Claude,无头生成)。
2. **卡牌查询**:**@机器人 + 「效果 」+卡名**(触发词「效果」后须带空格,防「效果怪兽」等误触发;如 `@机器人 效果 青眼白龙` 或 `@机器人 效果 青眼 白龙` 空格分隔多关键词 AND 查询)时,从**本地卡库**查询并输出**最匹配的一张**的卡牌信息(中文名/日文名/类型/星级/攻防/效果文本)。纯本地运行,不依赖 AI。卡库来自百鸽 ygocdb 全量数据(14260 张,2026-08 更新)。@消息可识别真 @ 或纯文本「@昵称」。
3. **卡图查询**:**@机器人 + 「卡图 」+卡名**,检索逻辑与「效果」完全相同(多关键词空格分隔 AND,取最匹配一张),但**只发送该卡的卡图**(图片段,base64 直发)。卡图数据库来自 ygoprodeck 全量图片,按官方密码 id 存于 `agent/ygocard/cards_img/{id}.jpg`,由 `agent/ygocard/download_images.mjs` 下载(可重跑续传,失败清单 `cards_img/failed.log`)。
4. **每日一卡**:群里 **@机器人 且消息含「每日一卡」** 时,从卡库随机抽一张卡回复完整信息,**先文字后卡图**; **同一 QQ 同一自然日内重复申请返回同一张卡,每日 0 点刷新换卡**(状态持久化于 `agent/daily_card.json`)。
5. **框神语录**:持续追踪「框神」(QQ 3080580848,群昵称「回归光恶魔」)在**复旦邻里交流群 (793874011)** 的发言,建本地语录库(初建于 2026-08-28,3 个月 1486 条)。**@机器人 且消息含「框神语录」** 时,从**精筛后**的语录中随机抽一条回复。采集双通道:WS 实时监听(该群该用户所有发言,无需 @)+ 启动/重连时增量回填历史(遇库内已知消息即停,离线期间漏收的自动补上)。

    **精筛规则**(`agent/kuangshen/kuangshen.mjs` 的 `isFeatured`,读时过滤即时生效):删除**无个人特征、低信息量**的发言——纯表情/纯段标记、纯敷衍填充(嗯嗯/。。。)、正经应答(好的/没问题/可以/收到/好吧好吧/对啊对啊 等,含尾缀与重复形式)、超短且无语气词(？/来/秒杀/笑死);**保留**带语气词与个人特征的发言(哈哈/艹/卧槽/为啥啊/牛逼啊/啊啊啊/诶/哎 等)。

**卡库更新**:monitor 控制台按 `u` 手动更新;或启动参数 `node monitor.mjs --update-cards` 启动即更新。流程:下载 cards.zip → 校验(JSON 完整性+卡数阈值,md5 仅参考) → 解压 → 原子替换 → 内存重载 → **自动同步下载缺失卡图**(跳过已有,增量很快),失败不影响旧卡库。也可单独跑 `node agent/ygocard/download_images.mjs` 补卡图。

> **开发中(默认关闭)**:搬屎功能(随机一搬 = 屎视频源库随机发封面截图;精选一搬 = 规则粗筛 + AI 精筛评论截图)代码在 `agent/shitpost/`,monitor 已接线但需 env `SHIT_ENABLED=1` 才启用,默认不上线。

## 系统组成

| 组件 | 位置 | 说明 |
|---|---|---|
| SnowLuma (OneBot 后端) | `tools/snowluma/` | QQ 协议层,HTTP 端口 3000 / WS 端口 3001 |
| 监控终端(一体化) | `agent/monitor.mjs` | WS 收 @ → 写 inbox → 分流处理(史记/查卡/每日一卡/框神语录) → 发送;15s 兜底轮询、断线补收(2 分钟窗)、心跳自愈 |
| 卡牌查询模块 | `agent/ygocard/ygocard.mjs` | 纯本地卡库查询(14,260 张) |
| 框神语录模块 | `agent/kuangshen/kuangshen.mjs` | 语录库(quotes.json)+ 历史回填 + 实时采集 + 精筛 + 随机抽取;CLI 自测 `node kuangshen.mjs [--backfill|--dump|--dump-raw]` |
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
- 环境变量可覆盖:WS_URL / API / WS_TOKEN / API_TOKEN / TRIGGER_KEYWORD / CARD_TRIGGER / CARD_IMG_TRIGGER / DAILY_KEYWORD / BOT_ID / DRY_RUN。
- **框神语录**(`agent/kuangshen/quotes.json` 不入库):`KUANGSHEN_TRIGGER`(触发词,默认「框神语录」)/ `KUANGSHEN_GROUP`(群号,默认 793874011)/ `KUANGSHEN_TARGET`(目标 QQ,默认 3080580848)/ `KUANGSHEN_MAX_PAGES`(回填翻页上限,200 条/页)。`node agent/kuangshen/kuangshen.mjs --backfill` 可手动补全历史。
- **卡库**:`agent/ygocard/cards.json` 不入库(约 14MB,可重建)。monitor 窗口按 `u` 或 `node monitor.mjs --update-cards` 联网更新。
- **功能开关热控**(`agent/features.json` 不入库):两档副功能总开关(搬屎/框神语录),控制台即时切换免重启,原子写持久化。**monitor 控制台按键**:`1`/`2` = 切搬屎/框神语录总开关,`h` = 重画面板,`u` = 更新卡库,`q` = 退出,`Q` = 退出+停 SnowLuma。首次运行时以 env 初值(`SHIT_ENABLED`/`KUANGSHEN_ENABLED`)建文件,**之后以文件为准,改 env 不再生效**(删文件即重置回 env 初值)。
- **卡图库**:`agent/ygocard/cards_img/` 不入库(约 2GB,14218 张,可重建)。`node agent/ygocard/download_images.mjs` 全量下载/续传(跳过已存在,失败清单 `cards_img/failed.log` 重跑自动重试)。

## 注意事项

- 修改 `agent/.env` / SnowLuma 配置后需重启才生效;功能开关走控制台面板或 `features.json`,即时生效无需重启
- QQ 掉线时:用 `stop.bat`(选 Y)停后端 → 重新打开 QQNT 登录 → `start.bat`
- 机器人只响应**群聊中 @它**的消息(私聊与其他消息不处理);无触发词的 @ 消息忽略
- **@+「史记总结」** → 史记体总结(触发词可用环境变量 `TRIGGER_KEYWORD` 覆盖);**@+「效果 」+卡名** → 本地卡牌查询(触发词可用 `CARD_TRIGGER` 覆盖,必须后跟空白);**@+「框神语录」** → 抽一条框神语录(触发词可用 `KUANGSHEN_TRIGGER` 覆盖)
- 卡牌查询支持中/日/英文名与别名(简中官方名、MD 译名等),多关键词空格分隔 AND 匹配
- 回复均 at 触发者
