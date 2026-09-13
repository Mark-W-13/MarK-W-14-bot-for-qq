# QQ Agent(赛博史官)

QQ 机器人「测试bot.fd」(QQ 3757588606)的自动回复系统,两个功能:

1. **史记总结**:群里 **@机器人 且消息含「史记总结」** 时,拉取该群最近 100 条消息,用**史记体文言文**总结/回答(走 Claude,无头生成)。
2. **卡牌查询**:**@机器人 + 「效果 」+卡名**(触发词「效果」后须带空格,防「效果怪兽」等误触发;如 `@机器人 效果 青眼白龙` 或 `@机器人 效果 青眼 白龙` 空格分隔多关键词 AND 查询)时,从**本地卡库**查询并输出**最匹配的一张**的卡牌信息(中文名/日文名/类型/星级/攻防/效果文本)。纯本地运行,不依赖 AI。卡库来自百鸽 ygocdb 全量数据(14260 张,2026-08 更新)。@消息可识别真 @ 或纯文本「@昵称」。
3. **卡图查询**:**@机器人 + 「卡图 」+卡名**,检索逻辑与「效果」完全相同(多关键词空格分隔 AND,取最匹配一张),但**只发送该卡的卡图**(图片段,base64 直发)。卡图数据库来自 ygoprodeck 全量图片,按官方密码 id 存于 `agent/ygocard/cards_img/{id}.jpg`,由 `agent/ygocard/download_images.mjs` 下载(可重跑续传,失败清单 `cards_img/failed.log`)。
4. **每日一卡**:群里 **@机器人 且消息含「每日一卡」** 时,从卡库随机抽一张卡回复完整信息,**先文字后卡图**; **同一 QQ 同一自然日内重复申请返回同一张卡,每日 0 点刷新换卡**(状态持久化于 `agent/daily_card.json`)。
5. **框神语录**:持续追踪「框神」(QQ 3080580848,群昵称「回归光恶魔」)在**复旦邻里交流群 (793874011)** 的发言,建本地语录库(初建于 2026-08-28,3 个月 1486 条)。**@机器人 且消息含「框神语录」** 时,从**精筛后**的语录中随机抽一条回复。采集双通道:WS 实时监听(该群该用户所有发言,无需 @)+ 启动/重连时增量回填历史(遇库内已知消息即停,离线期间漏收的自动补上)。

    **精筛规则**(`agent/kuangshen/kuangshen.mjs` 的 `isFeatured`,读时过滤即时生效):删除**无个人特征、低信息量**的发言——纯表情/纯段标记、纯敷衍填充(嗯嗯/。。。)、正经应答(好的/没问题/可以/收到/好吧好吧/对啊对啊 等,含尾缀与重复形式)、超短且无语气词(？/来/秒杀/笑死);**保留**带语气词与个人特征的发言(哈哈/艹/卧槽/为啥啊/牛逼啊/啊啊啊/诶/哎 等)。
6. **官方裁定**:**@机器人 + 「裁定 」+卡名**(如 `@机器人 裁定 增殖的G`)时,从**百鸽**(ygocdb.com,KONAMI 官方 OCG 数据库 FAQ 的中文镜像站)拉取该卡**相关 Q&A 裁定 + 数据库补充说明**(用户 2026-09-08 要求补充说明一并填充;补充说明=官方对卡效果的分节解说),**日文原文**(官方 FAQ 无中文译本,百鸽正文同为日文,仅把句中卡名渲染成中文,读起来更友好)。检索桥梁:本地卡库的 id 字段 = 卡密码,直接拼卡页 `ygocdb.com/card/<密码>#faq` 取该卡**全部相关 Q&A**(单页全量,按日期倒序)与同页 `#supplement` 区的补充说明,**优先挑出题干直接提到该卡的判例**(题干含该卡卡页链接;百鸽的「相关」列表同样含大量泛用判例,直接取前几条会对不上卡),不足时补位其它相关条目,回复 2 条 Q&A + 补充说明,**回复不含任何链接**(官网深链无会话会跳主页、2026-09-08 实测后用户定稿去掉;换百鸽源后用户 2026-09-08 再次定稿:仍不附链接)。结果按卡缓存 24h(`agent/ygocard/faq_cache.json`,不入库,缓存带版本号 v2),每用户 15s 冷却防刷。模块:`agent/ygocard/rulings.mjs`,CLI 自测 `node rulings.mjs "增殖的G"`。无卡名 → 教用法;卡无密码 id(动画卡等)→ 如实说明。

    **完整裁定 PDF**(2026-09-08 新增,触发词「完整裁定 」+卡名,env `RULING_FULL_TRIGGER`):拉取该卡**百鸽卡页上的全部相关 Q&A + 数据库补充说明,有啥发啥**(含泛用相关判例,不做直接命中过滤、不截断;百鸽单页全量,无翻页截断问题),PDF 内**补充说明置于相关 Q&A 之前**,HTML → Edge headless `--print-to-pdf` 自动分页生成多页 PDF(文件名 `完整裁定_卡名_YYYYMMDD.pdf`,写 `agent/ygocard/tmp/` 已 gitignore,3 天自动清),**先回一条 @+「【卡名】的完整裁定如下」,再上传群文件**(upload_group_file,与生成卡表同通道);每用户 30s 冷却。CLI 自测 `node rulings.mjs "增殖的G" --pdf`。缓存独立键 `bgfull_<密码>`。无任何相关 Q&A 与补充说明 → 回说明不发文件;失败 → 回「完整裁定生成失败」。

7. **AI 闲聊(兜底)**:群里 **@机器人 但没写任何指令**时,把最近 30 条群聊当上下文,交给**智谱 GLM 免费模型**(`glm-4-flash`,实测 1~2 秒回)以「赛博史官」人设接话——**自称史官、偶尔带点古风口吻,但正文说白话**,回复简短(超过 400 字截断)。key 取 `agent/.env` 的 `ZHIPU_API_KEY`,**没配 key 时该功能自动关闭**;每人 15s 冷却防连点刷屏,群聊记录拉不到时退化成只按这一句回答。**面板 `3` 键 / 运维 WebUI 可即时刻开关**。

    **消息解析(2026-09-13 新增)**:群友发来的消息不再只认纯文字,消息里夹的 **@某人 / 引用(回复某条消息)/ QQ 表情 / 图片与表情包** 都会还原成模型读得懂的正文(模块 `agent/aichat/aichat.mjs`):@ 换成群昵称;引用用 `get_msg` 取回被引消息摊平成「[引用 @某人: 内容]」;**QQ 表情** 按 id 查表换成「[表情:微笑]」(表 `agent/aichat/qq_faces.json`,283 条,导出自 SnowLuma 的表情目录);**图片/表情包走两轮对话** —— 第 1 轮把图单独交给视觉模型(`glm-4v-flash`,免费)识别成一句话描述,第 2 轮把描述**按原位置**拼回正文再交给对话模型。所以「发张图 @ 机器人问这是啥」「回复某个表情包再吐槽」都能接住。图片先下载再经 ffmpeg 缩到长边 ≤1024 的 JPEG(QQ 的动画表情动辄 3~12MB,直接传会被视觉模型判格式错),单条消息最多识别 3 张、识别结果按图片 md5 缓存;某张图取不到或识别失败只影响它自己(显示成「没能识别」),不影响整条回复。CLI 自测 `node aichat.mjs --selftest | --image <路径|URL> | --render <消息json>`。

**卡库更新**:monitor 控制台按 `u` 手动更新;或启动参数 `node monitor.mjs --update-cards` 启动即更新。流程:下载 cards.zip → 校验(JSON 完整性+卡数阈值,md5 仅参考) → 解压 → 原子替换 → 内存重载 → **自动同步下载缺失卡图**(跳过已有,增量很快),失败不影响旧卡库。也可单独跑 `node agent/ygocard/download_images.mjs` 补卡图。

> **开发中(默认关闭)**:搬屎功能(随机一搬 = 屎视频源库随机发封面截图;精选一搬 = 规则粗筛 + AI 精筛评论截图)代码在 `agent/shitpost/`,monitor 已接线但需 env `SHIT_ENABLED=1` 才启用,默认不上线。

## 系统组成

| 组件 | 位置 | 说明 |
|---|---|---|
| SnowLuma (OneBot 后端) | `tools/snowluma/` | QQ 协议层,HTTP 端口 3000 / WS 端口 3001 |
| 监控终端(一体化) | `agent/monitor.mjs` | WS 收 @ → 写 inbox → 分流处理(史记/查卡/每日一卡/框神语录/AI 闲聊) → 发送;15s 兜底轮询、断线补收(2 分钟窗)、心跳自愈 |
| 卡牌查询模块 | `agent/ygocard/ygocard.mjs` | 纯本地卡库查询(14,260 张) |
| 框神语录模块 | `agent/kuangshen/kuangshen.mjs` | 语录库(quotes.json)+ 历史回填 + 实时采集 + 精筛 + 随机抽取;CLI 自测 `node kuangshen.mjs [--backfill|--dump|--dump-raw]` |
| AI 闲聊消息解析 | `agent/aichat/aichat.mjs` | @/引用/QQ 表情/图片 → 模型读得懂的正文(图片走两轮:视觉识别 → 拼回正文);CLI 自测 `node aichat.mjs [--selftest|--image|--render]` |
| 一键启动 | `start.bat` | 检测/启动 SnowLuma + 打开 monitor 窗口 |
| 一键停止 | `stop.bat` | 停止 monitor(可选停 SnowLuma) |
| 运维台入口 | `webui.bat` | 开 SSH 隧道 + 浏览器打开线上运维 WebUI(8090;本机 Windows 用) |

## start.bat — 启动(双击即可)

依次执行:

1. **检查 SnowLuma**:已在运行则跳过;未运行则自动启动并等待就绪(最多 60 秒)。**保证只启动一个实例**:若 WebUI 端口 5099 已就绪(说明上一个实例还在启动),只等待不重复拉起——两个 SnowLuma 实例同时启动会互踢,表现为窗口启动后闪退、旧实例无声消失(2026-09-09 排查)
2. **打开 monitor 控制台**(`monitor.mjs`,WS 收 @;已在运行则跳过)
3. **显示 QQ 登录状态**(确认机器人在线)

适用场景:电脑重启后、SnowLuma 或监听器挂了之后,一键恢复整套服务。

> ⚠️ 启动注意:冷启动(QQ 刚开/刚重登)时 SnowLuma 要等 QQ 登录完成才能收编 hook,实测需 ~35s;**先开 QQ、确认登录好,再双击 start.bat,期间不要重复双击**。

## stop.bat — 停止(双击即可)

1. **停止 monitor**(按进程命令行匹配,不依赖 pid 文件)
2. **询问**「是否同时停止 SnowLuma 后端」,输入 `Y` 停止 / `N` 仅停 monitor

适用场景:要下线机器人时;SnowLuma 需要重启(改配置、QQ 掉线重登)时。

## 运维 WebUI(opsweb.mjs —— 服务器端)

浏览器里看状态、切开关、重启服务、看日志、看 QQ 收发消息,免去敲命令。**这是服务器(Linux)侧的运维入口**;Windows 本机仍用 `start.bat` / `stop.bat`。

```bash
# 本机开一条隧道(别关,关了就断):
ssh -N -L 8090:127.0.0.1:8090 <用户>@<服务器>
# 然后浏览器打开:
http://127.0.0.1:8090
```

首次访问要输**访问令牌**,存在服务器 `agent/.env` 的 `OPSWEB_TOKEN`(该文件不入库)。取法:`ssh <用户>@<服务器> "grep OPSWEB_TOKEN ~/mc_agent/agent/.env"`。

| 模块 | 能做什么 |
|---|---|
| 功能开关 | 切「搬屎」「框神语录」「AI 闲聊」,**即时生效不重启**(走 monitor 的 tmux 面板按键,切完回读 `features.json` 校验) |
| 服务 | 看 5 个服务(xvfb/SnowLuma/QQ/monitor/opsweb)运行与自启状态,可单独重启 |
| 账号 | QQ 昵称与 UIN、OneBot 两个端口是否在听 |
| 卡库 | 卡牌数 / 卡图数 / 更新时间,一键更新卡库(二次确认,后台跑,进度看日志页) |
| 主机 | 内存 / 磁盘 / 负载 / 开机时长 |
| QQ 消息日志 | **SnowLuma 侧的收发记录**:谁在哪个群说了什么、bot 发了什么(默认滤掉调试噪声,可勾选看原始日志) |
| 日志 | monitor 面板最近若干行,5 秒自动刷新 |

**安全姿态**:只监听 `127.0.0.1`,公网零暴露(绑回环是代码里写死的,不给配置项);登录令牌 + `HttpOnly` / `SameSite=Strict` 会话 cookie —— 这台服务器可能不是独占的,同机其他用户能连本地端口,所以鉴权不能省。

**依赖**:`tmux` 会话名默认 `mc`(可用 `OPSWEB_TMUX_SESSION` 覆盖),端口默认 `8090`(可用 `OPSWEB_PORT` 覆盖)。

## webui.bat — 运维台(双击即可)

> 机器人线上跑在 Ubuntu 服务器(见 `迁移Ubuntu方案.md`),运维 WebUI(`opsweb`,端口 8090)只绑服务器的 `127.0.0.1`,所以本机要看得先开 SSH 隧道。本脚本就是这一步的一键化(服务器端那套用 ssh 命令行开隧道也可以,见上一节)。

1. **开 SSH 隧道**:本机 `127.0.0.1:8090` → 服务器 `127.0.0.1:8090`(最小化的 `OpsWeb Tunnel` 窗口;已在跑则跳过)
2. **等 WebUI 就绪**(轮询端口 + 试连,最多 ~25 秒)
3. **打开浏览器** `http://127.0.0.1:8090` —— 首次要输令牌(服务器 `~/mc_agent/agent/.env` 的 `OPSWEB_TOKEN`,浏览器可记住)

能干什么:看状态 / 切搬屎·框神语录·AI 闲聊开关 / 重启服务 / 更新卡库 / 看 QQ 截图 / 看日志。

**关隧道**:关掉那个最小化窗口,或跑 `webui.bat /stop`。

> 免密登录靠本机 `~/.ssh/id_ed25519` 的公钥已装到服务器 `w-13` 的 `authorized_keys`(2026-09-12 装好)。换机器或公钥失效时,脚本会提示找不到私钥,隧道窗口里则直接报 `Permission denied`。
> SnowLuma 自己的 WebUI(5099,QQ 账号状态/配置)本脚本不开,要用手动:`ssh -N -L 5099:127.0.0.1:5099 w-13@192.144.153.94`。

## 完整工作流

```
日常运行(无需操作)
  服务器:systemd --user 五个 unit(xvfb/snowluma/qq/mc-agent/opsweb)常驻
          mc-agent 在 tmux 会话 mc 里跑 monitor,收 @消息后立即分流处理并回复
本机 Windows:start.bat 起 SnowLuma + monitor(本机那一套,机器人线上在服务器)

恢复运行(机器重启后)
  服务器:重启后自动起(linger 已开);要手动时 systemctl --user restart mc-agent
  本机:先开 QQ,确认登录完成 → 双击 start.bat(只双击一次,冷启动约需 40 秒)
```

## 目录结构

```
mc_agent/
├── start.bat              # 一键启动(Windows)
├── stop.bat               # 一键停止(Windows)
├── webui.bat              # 运维台入口:开 SSH 隧道 + 打开线上 WebUI(Windows)
├── README.md
├── .mcp.example.json      # MCP 配置样例(实际配置为 .mcp.json,不入库)
├── data/                  # 屎样本 / 屎源库 / 黑名单(随仓库走的默认副本)
└── agent/
    ├── monitor.mjs        # 主进程:连 OneBot,收 @ 消息并回复
    ├── opsweb.mjs         # 运维 WebUI(看状态 / 切开关 / 重启服务)
    ├── .env               # token 等敏感配置(不入库)
    ├── features.json      # 功能开关持久化(不入库)
    ├── daily_card.json    # 每日一卡当日状态(不入库)
    ├── inbox.jsonl        # @请求 队列(不入库)
    ├── processed.jsonl    # 已处理记录(不入库)
    ├── aichat/            # AI 闲聊消息解析(@/引用/表情/图片→正文)+ 表情 id 名称表
    ├── env.mjs            # 加载 .env(必须第一个 import,见文件内注释)
    ├── kuangshen/         # 框神语录:采集 / 回填
    ├── shitpost/          # 搬屎:随机一搬 / 精选一搬
    └── ygocard/           # 卡牌:效果查询 / 卡图 / 卡库 / 裁定 / 卡表
```

> SnowLuma(OneBot 后端)不在此仓库内:Windows 端放 `tools/snowluma/`,服务器端独立部署。

## 配置(敏感信息不入库)

- **`agent/.env`**(被 `.gitignore` 排除):OneBot token,格式:
  ```
  WS_TOKEN=ws 端口 token
  API_TOKEN=http 端口 token
  ```
  缺失时 monitor 启动会报错退出;`start.bat` 的登录检测也从该文件读取。
- **`.mcp.json`**(被 `.gitignore` 排除):Claude Code MCP 配置,参考 `.mcp.example.json` 创建。
- 环境变量可覆盖:WS_URL / API / WS_TOKEN / API_TOKEN / TRIGGER_KEYWORD / CARD_TRIGGER / CARD_IMG_TRIGGER / RULING_TRIGGER / RULING_FULL_TRIGGER / DAILY_KEYWORD / BOT_ID / DRY_RUN。裁定相关:`RULINGS_CACHE_TTL_MS`(缓存时长,默认 24h)。
- **框神语录**(`agent/kuangshen/quotes.json` 不入库):`KUANGSHEN_TRIGGER`(触发词,默认「框神语录」)/ `KUANGSHEN_GROUP`(群号,默认 793874011)/ `KUANGSHEN_TARGET`(目标 QQ,默认 3080580848)/ `KUANGSHEN_MAX_PAGES`(回填翻页上限,200 条/页)。`node agent/kuangshen/kuangshen.mjs --backfill` 可手动补全历史。
- **卡库**:`agent/ygocard/cards.json` 不入库(约 14MB,可重建)。monitor 窗口按 `u`、运维 WebUI 的「更新卡库」、或 `node monitor.mjs --update-cards` 联网更新。卡库源(百鸽)在海外,国内机器连它握手常要 9~16 秒,而 Node `fetch` 默认连接超时只有 10 秒 —— 所以更新走「重试 + 放宽超时」:出问题时可用 `CARDS_FETCH_TIMEOUT_MS`(默认 120000)与 `CARDS_FETCH_TRIES`(默认 3)调。
- **功能开关热控**(`agent/features.json` 不入库):三档副功能总开关(搬屎/框神语录/AI 闲聊),控制台即时切换免重启,原子写持久化。**monitor 控制台按键**:`1`/`2`/`3` = 切搬屎/框神语录/AI 闲聊总开关,`h` = 重画面板,`u` = 更新卡库,`q` = 退出,`Q` = 退出+停 SnowLuma。**服务器上也可用运维 WebUI 切**(见上文,它切的就是同一套按键,所以两条路径的状态天然一致)。首次运行时以 env 初值(`SHIT_ENABLED`/`KUANGSHEN_ENABLED`/`AI_CHAT_ENABLED`)建文件,**之后以文件为准,改 env 不再生效**(删文件即重置回 env 初值);**运行中直接改 `features.json` 文件不生效**,要走按键或 WebUI。AI 闲聊还有一个例外:**没配 `ZHIPU_API_KEY` 时启动即强制关闭**,配了 key 再开才有效。
- **AI 闲聊**(走智谱 GLM,需 `agent/.env` 的 `ZHIPU_API_KEY`):`GLM_MODEL`(默认 `glm-4-flash`,免费)/ `AI_CHAT_CTX`(附带上下文条数,默认 30,0=不带)/ `AI_CHAT_TIMEOUT_MS`(默认 30000)/ `AI_CHAT_COOLDOWN_MS`(每人冷却,默认 15000)/ `AI_CHAT_MAX_CHARS`(回复截断字数,默认 400)。
- **AI 闲聊·图片识别**(2026-09-13):`GLM_VISION_MODEL`(视觉模型,默认 `glm-4v-flash`,免费)/ `AI_CHAT_MAX_IMAGES`(单条消息最多识别几张,默认 3,超出只显示「没能识别」)/ `AI_CHAT_IMG_MAX_SIDE`(送模型前缩到长边不超过多少像素,默认 1024)/ `AI_CHAT_IMG_TIMEOUT_MS`(图片下载超时,默认 15000)/ `AI_CHAT_VISION_TIMEOUT_MS`(视觉模型超时,默认 30000)/ `FFMPEG_BIN`(默认 `ffmpeg`;没有 ffmpeg 时退化成「小图原样传、大图放弃」)/ `QQ_FACE_CATALOG`(表情表的路径,默认 `agent/aichat/qq_faces.json`,也可直接指向 SnowLuma 的 `data/sys-face-catalog.json`)。
- **卡图库**:`agent/ygocard/cards_img/` 不入库(约 2GB,14218 张,可重建)。`node agent/ygocard/download_images.mjs` 全量下载/续传(跳过已存在,失败清单 `cards_img/failed.log` 重跑自动重试)。

## 注意事项

- 修改 `agent/.env` / SnowLuma 配置后需重启才生效;功能开关走控制台面板或 `features.json`,即时生效无需重启
- QQ 掉线时:用 `stop.bat`(选 Y)停后端 → 重新打开 QQNT 登录 → `start.bat`
- 机器人只响应**群聊中 @它**的消息(私聊与其他消息不处理);无触发词的 @ 消息交给 **AI 闲聊**兜底接话(可用面板 `3` 键关掉,关掉后恢复为忽略)
- **@+「史记总结」** → 史记体总结(触发词可用环境变量 `TRIGGER_KEYWORD` 覆盖);**@+「效果 」+卡名** → 本地卡牌查询(触发词可用 `CARD_TRIGGER` 覆盖,必须后跟空白);**@+「裁定 」+卡名** → 官方裁定(触发词可用 `RULING_TRIGGER` 覆盖,必须后跟空白);**@+「框神语录」** → 抽一条框神语录(触发词可用 `KUANGSHEN_TRIGGER` 覆盖)
- 卡牌查询支持中/日/英文名与别名(简中官方名、MD 译名等),多关键词空格分隔 AND 匹配
- 回复均 at 触发者
