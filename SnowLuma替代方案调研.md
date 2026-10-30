# SnowLuma 替代方案与协议层重构调研

> 调研日期:2026-10-28。**本文只做调研与方案设计,不改任何代码/配置。**
> 结论基于:①本仓库现有代码(逐行核对)②各项目 2026-10 的公开状态(链接见第九节)。
> 适用范围:线上那套「Linux QQ + SnowLuma + agent/monitor」,以及 Windows 本机那套 start.bat。

---

## 一、先给结论

1. **SnowLuma 目前没有被"禁用"的迹象**,恰恰相反:上游 2026-10-27 刚发 v2.2.1,2026-10-24 发 v2.2.0,10-07 发 v1.14.22;线上跑的 v1.14.15 只是没升。所以这是**预案**,不是救火。
2. **换协议端不需要重写 bot**。全仓库对协议层的依赖只有 **8 个 action、十类消息段、1 个扩展 notice**,加上运维面的端口/日志/unit 名;这些引用一共只有 28 处。
3. **第一替代是 NapCat**:同为 NTQQ 挂钩类协议端,OneBot v11 事件模型与 SnowLuma 等价(NcatBot 的 SnowLuma 适配器甚至直接复用 NapCat 适配器的协议组件),默认端口同样是 HTTP 3000 / WS 3001,token 同样走 `Authorization: Bearer`。第二替代是 **LuckyLilliaBot(原 LLOneBot)**,代码血统不同,且同时支持 OneBot 11 与 Milky。
4. **真正会"出事"的不是协议,而是四个细节**:①消息 ID 语义(`message_seq` vs 哈希 `message_id`)导致去重/补漏/回填错位;②NapCat 无持久化,`get_msg` 只能取最近约 5000 条;③群名不在事件里;④无 sudo 服务器上的安装路径(NapCat 手动安装要改 `/opt/QQ`,SnowLuma 当年靠 ptrace 绕开了这一点)。
5. **建议路线**:现在**不迁移**;用 2~3 天做「协议端抽象 + 一致性自测」,把 NapCat 当冷备每月演练一次。触发条件出现时,十分钟级可切;真到 OneBot 生态整体死亡,再上 Milky 适配(那时才需要动 3~5 天)。

**如果只记一句话**:SnowLuma 是"可替换件",不是"地基";地基是 monitor 里那套 OneBot 形状的事件/发送逻辑,把它抽成一层薄适配,换谁都不慌。

---

## 二、SnowLuma 现状,以及"被禁用"到底指什么

### 2.1 现状(2026-10-28)

| 事实 | 数据 | 来源 |
|---|---|---|
| 上游仍在发版 | v2.2.1(2026-10-27)、v2.2.0(10-24)、v2.1.1(10-21)、v1.14.22(10-07) | GitHub Releases |
| v2 是重写线 | 要求 Node 24,新增 SDK / MCP / 结构化 API,仍保留 OneBot v11 与 WebUI(5099) | v2.0.0 发布说明 |
| 线上版本 | v1.14.15(迁移文档记录);v1 线最后一版是 v1.14.22(10-07) | `迁移Ubuntu方案.md:17` |
| 部署形态 | 免 Docker Linux 包 + 自带 Node + ptrace 注入 QQ + setcap | `迁移Ubuntu方案.md:63-90` |
| 协议面 | OneBot v11(HTTP 3000 / WS 3001)+ 私有扩展(`message_seq`、`group_name`、`message_id` 锚点翻页等) | 代码实测 + NcatBot 文档 |

### 2.2 四种"被禁用",应对完全不同

| 场景 | 具体形态 | 影响面 | 应对主线 |
|---|---|---|---|
| **S1 项目停更/下架** | 仓库被删、Release 不再更新、QQ 新版本 hook 失效 | 只影响 SnowLuma 一个后端 | 换 NapCat;今天就能做 |
| **S2 QQ 封杀 NTQQ 挂钩** | QQ 更新导致注入失效 / 腾讯开始检测 hook | **NapCat、LuckyLilliaBot、SnowLuma 全灭**(同一攻击面) | 纯协议实现(Milky 系)或官方 API;需要新适配 |
| **S3 账号被封/风控** | bot QQ 被踢下线、限制发言、封号 | 与后端无关,换谁都一样 | 账号策略(小号、降频、不私聊/不群发);现有冷却只能缓解 |
| **S4 合规/法律压力** | 第三方协议端被明令禁止 | 全生态 | 官方 QQ 机器人 API(功能大缩水)或换平台 |

> 重要:**S2 和 S3 不能靠"换 SnowLuma"解决**。本报告的重点是 S1(概率最高、代价最低),顺带给出 S2/S4 的退路。

---

## 三、系统到底依赖了协议层的什么(逐项证据)

### 3.1 传输与鉴权

```js
// agent/monitor.mjs:87-94
const WS_URL   = process.env.WS_URL   || 'ws://127.0.0.1:3001/';
const WS_TOKEN = process.env.WS_TOKEN || process.env.SNOWLUMA_WS_TOKEN;
const API      = process.env.API      || 'http://127.0.0.1:3000/';
const API_TOKEN= process.env.API_TOKEN|| process.env.SNOWLUMA_API_TOKEN;
const BOT_ID   = (process.env.BOT_ID || '3757588606').toString();
```

- WS 连接:`new WebSocket(WS_URL, { headers: { Authorization: 'Bearer …' } })`(`monitor.mjs:2839`)
- HTTP 调用:**统一入口** `POST http://127.0.0.1:3000/`,body `{action, params}`,Bearer 鉴权(`monitor.mjs:297-304`;`kuangshen.mjs:190-197` 有一份同样的实现)
- 健康检查:`get_status` 每 60s,连续 3 次失败强断 WS 触发重连(`monitor.mjs:3713-3729`)
- 关停:`SNOWLUMA_STOP_CMD`,Windows 默认按 3000 端口 taskkill(`monitor.mjs:2691-2710`)

### 3.2 用到的 8 个 action

| action | 调用点 | 用途 |
|---|---|---|
| `get_login_info` | `monitor.mjs:3706`、`opsweb.mjs:338` | 启动取昵称(纯文本 @ 识别)、运维台账号卡 |
| `get_status` | `monitor.mjs:3718` | 半死连接探测 |
| `get_group_list` | `monitor.mjs:2802`、`opsweb.mjs:236/252/269` | 补漏覆盖全部群、运维台群列表 |
| `get_group_member_info` | `monitor.mjs:352` | @ 的人不在本批记录里时补昵称 |
| `get_group_msg_history` | `monitor.mjs:380/2812`、`kuangshen.mjs:210` | 史记总结上下文、断线补漏、语录回填 |
| `get_msg` | `monitor.mjs:946/1320`、`aichat.mjs:729` | 引用消息摊平 |
| `send_group_msg` | `monitor.mjs:1068/1080/1531/1556` | 一切发送(文本/图/语音/段数组) |
| `upload_group_file` | `monitor.mjs:1705/1778/1801` | 完整裁定 PDF、卡表 PDF |

### 3.3 事件与消息段

| 类别 | 用到的字段/类型 | 位置 |
|---|---|---|
| 消息事件 | `post_type/message_type/group_id/user_id/message[]/sender.card或nickname/time` | `monitor.mjs:2846-2905` |
| 去重键 | `message_seq ?? message_id` | `monitor.mjs:2749`、`2814`、`2897` |
| 群名 | `group_name` | `monitor.mjs:2785`、`2858`、`2803` |
| 通知事件 | `notice_type=group_msg_emoji_like`:`message_id/message_seq/operator_id或user_id/likes[].emoji_id` | `monitor.mjs:2039-2074`、`2849-2851` |
| 段类型(收) | `text / at / image / face / mface / reply / video / forward / markdown / inline_keyboard` | `monitor.mjs:2768-2779`、`aichat.mjs:108-180` |
| 段类型(发) | `text / at / image(base64://) / record(base64://)` | `monitor.mjs:1520-1543`、`belial/voice.mjs:361-411` |
| 官方机器人识别 | `markdown` / `inline_keyboard` 段 + `2854xxxxxx` 号段 | `monitor.mjs:100-125` |

### 3.4 功能 → 协议能力映射

| 功能 | 依赖的协议能力 | 换后端时的风险 |
|---|---|---|
| 史记总结 / 贴吧上下文 / 框神回填 | `get_group_msg_history` + 稳定可比较的 seq + 分页锚点 | **高**:seq 语义与锚点参数是 SnowLuma 私有扩展 |
| AI 闲聊的引用解析 | `get_msg` 能取回被引消息 | **中高**:NapCat 无持久化,约 5000 条后取不到 |
| 卡图 / 每日一卡 / 饼图 / 搬屎截图 | 发送 `base64://` 图片,单条约 2MB 上限 | 低:三家都支持 |
| 银河皇帝语音 | `record` 段 base64,后端自动转 SILK | 低:三家都支持(NapCat 有原生 ffmpeg) |
| 完整裁定 / 卡表 | `upload_group_file` 本地路径 | 低:三家都支持;但路径必须对后端进程可见 |
| 搬屎/语录反馈 | 表情回应 notice + 发送返回的 `message_id` 关联 | **中**:依赖 ID 在事件与发送返回之间一致 |
| 群名显示、日志 | 事件里的 `group_name` | 低:可用 `get_group_list` 缓存补 |
| 断线补漏 | 历史消息最新在前 + 遇到 `lastSeq` 停止 | **高**:seq 类型不一致会重复入队 |

### 3.5 运维面(同样算"耦合")

| 位置 | 内容 |
|---|---|
| `start.bat:24-49` | 用 3000/5099 端口判断 SnowLuma 状态;`start "SnowLuma" cmd /c "cd tools\snowluma && node ./index.mjs"` |
| `start.bat:68-70` | `curl /get_login_info` 做登录检查 |
| `stop.bat:16-18` | 按 3000 端口 taskkill |
| `opsweb.mjs:89-95` | 五个 systemd unit 写死,含 `snowluma` |
| `opsweb.mjs:178-209` | 日志目录 `~/opt/snowluma/logs`,只认 `[Event]` / `[OneBot]` 两种行 |
| `opsweb.mjs:366-369` | 用 3000/3001 端口是否在听来显示 OneBot 状态 |
| `迁移Ubuntu方案.md:33-38,63-90,115-128` | 端口表、setcap、安装路径、systemd unit |
| `README.md:105,196,383` | 架构表、5099 WebUI 说明、"SnowLuma 不在仓库内" |
| `agent/.env` | `WS_TOKEN` / `API_TOKEN`(与 SnowLuma 的 `onebot.json` 对齐) |

> 也就是说:就算 monitor 一行不改,**运维台、启动脚本、systemd、文档**也得跟着改一轮,否则会出现"bot 活着但页面全红"。

---

## 四、候选方案矩阵(2026-10-28)

| 方案 | 类型 | 需 QQ 客户端 | 协议 | 最新版本/日期 | 无 sudo Linux | 与本仓库兼容度 | 结论 |
|---|---|---|---|---|---|---|---|
| **SnowLuma** | NTQQ 挂钩 | 是 | OneBot 11 | v2.2.1 / 10-27 | ✅(ptrace+setcap) | 基线 | 现状,继续用 |
| **NapCat** | NTQQ 挂钩 | 是 | OneBot 11 | v4.18.41 / 10-21 | ✅ AppImage(自带 QQ) | ★★★★☆ | **第一替代** |
| **LuckyLilliaBot**(原 LLOneBot) | NTQQ 挂钩 | 是 | OneBot 11 + Milky | v8.3.2 / 10-13 | ⚠️ 需实测 | ★★★★ | 第二替代/血统备份 |
| **Lagrange V2 / Lagrange.Milky** | 纯协议(C#) | 否 | **仅 Milky** | Releases 页暂无正式版(仓库活跃) | ✅ | ★★(要新适配) | 长期退路 |
| **Yogurt**(acidify) | 纯协议(Kotlin) | 否 | 仅 Milky | 文档站活跃 | ✅ | ★★ | 长期退路 |
| **AstralGocq** | 纯协议(gocq 分支) | 否 | OneBot 11 | v1.3.1-pre-8 / 2025-03 | ✅ | ★★★ | ❌ 停更 1.5 年 |
| **官方 QQ 机器人 API** | 官方 | 否 | 私有 HTTPS/WS | 持续 | ✅ | ★(要重写交互) | 只做 S4 兜底 |
| **换平台(Telegram/Discord/KOOK/飞书)** | 其他 IM | 否 | 各自 | — | ✅ | ★★(要新适配) | 极端退路 |

### 4.1 NapCat(推荐第一替代)

- **为什么最合适**:同为 NTQQ 挂钩、OneBot v11;本仓库 8 个 action 全都有;HTTP 3000 / WS 3001 是它的默认端口;token 同样走 Bearer;`base64://`、SILK、`upload_group_file`、`group_msg_emoji_like` 全支持。
- **行为差异**:群消息事件**通常不带 `group_name`**;`message_id` 是哈希正整数且 **LRU 约 5000 条**(无数据库);表情回应事件的 `message_seq` 是"扩展字段、可能为空";`get_group_msg_history` 的分页锚点是 `message_seq` 而不是 `message_id`。
- **部署**:官方 Linux 路径(手动)要改 `/opt/QQ/resources/app/package.json`(**需要 root**);无 sudo 机器走 **AppImage**(自带 QQ,`--appimage-extract-and-run` 免 FUSE),用现有 Xvfb `DISPLAY=:99` 起,WebUI 6099。
- **注意**:AppImage 自带 QQ 版本,等于把"QQ 版本"也钉住了,反而省心;但首次登录要重新扫码,且可能与现有 `~/.config/QQ` 登录态不共享。

### 4.2 LuckyLilliaBot(第二替代)

- 原 LLOneBot,仍在活跃发版(10-13 v8.3.2),**同时支持 OneBot 11 和 Milky**,并自带 WebQQ/WebUI。
- 价值在于**代码血统与 NapCat 不同**:如果某天 NapCat 被针对,它是最可能还活着的 OneBot 11 实现。
- 风险:历史包袱偏 Windows(Desktop 版),Linux 侧要实测;不建议作为第一顺位。

### 4.3 SnowLuma 自身(升级/钉版)

- 线上 v1.14.15 → **v1.14.22** 是同大版本的最后一个小版本,升级风险低,建议在演练窗口做掉(v2 是重写线,配置/产物"成套更新",要单独评估,别和"被禁用演练"混在一起)。
- 无论升不升,**把 v1.14.22 的完整包 + 对应 QQ deb + 自带 Node 留一份本地镜像**:S1 场景里最值钱的是"还能装回去"。

### 4.4 纯协议系(Lagrange V2 / Yogurt / Milky)

- **关键事实**:Lagrange 官方已明确 **V2 不再支持 OneBot 11**,V1 的 OneBot 实现也不再维护;新协议是 **Milky**。Milky 生态目前能用的实现是 Lagrange.Milky、Yogurt、LuckyLilliaBot。
- 也就是说:**"不用 QQ 客户端的 OneBot 11"这条路正在消失**。如果 S2 发生(NTQQ 挂钩被整体封杀),退路不是"再找一个 OneBot 11 后端",而是"给 monitor 加一个 Milky 适配器"。
- Milky 是强类型、HTTP/WS 的新标准,结构比 OneBot 11 清晰,但**段模型/事件模型都要重映射**,不是改几行能完成的。

### 4.5 官方 QQ 机器人 API(只适合兜底)

> 2026-10 官方通道更新很快,单独整理了一份:[QQ官方Bot插件与入口调研.md](QQ官方Bot插件与入口调研.md)。这里只留结论。

- 已补齐:群全量消息(群主开权限)、主动发言、图片/语音/文件、引用回复、按钮/菜单/指令面板、群成员管理;被动回复 **5 分钟、同一条消息最多 5 次**;主动消息 **每群每天 1000 条**。
- 仍然缺:群历史接口、群表情回应(仅频道)、QQ 号身份(openid)、群列表接口;文本里不允许 URL。
- 对本 bot 的直接影响:史记总结/贴吧上下文(要历史)、搬屎/语录反馈(要表情回应)、按主人 QQ 鉴权(要 QQ 号)三条**硬伤**;其余功能约 55%~65% 可搬。
- 结论:它是 S4 的合规兜底 + 可选"第二通道",不是 SnowLuma 的替代方案。

---

## 五、兼容性差异清单(NapCat 视角)与补丁

> 下面每一条都对应本仓库的具体代码;这就是"换后端"真正要改的东西。

| # | 差异 | SnowLuma | NapCat | 代码位置 | 影响 | 处理 |
|---|---|---|---|---|---|---|
| 1 | 消息序列号 | 事件带 `message_seq` | 事件通常**不带**,只有 `message_id`(哈希) | `monitor.mjs:2749,2814,2897` | 实时与历史算出的 seq 不一致 → 补漏重复入队、`seen` 失效 | 适配层统一:两边都取 `message_id`,或两边都取 `message_seq`;**不允许混用** |
| 2 | 历史分页锚点 | `message_id` + `reverse_order` | `message_seq` | `kuangshen.mjs:210,218` | 语录深度回填只翻到第一页(200 条) | 适配层把锚点换成 `message_seq`(历史消息对象里有) |
| 3 | 群名 | 事件带 `group_name` | 通常不带 | `monitor.mjs:2785` | 日志/补漏显示群号 | 启动拉 `get_group_list` 建缓存 + 重连刷新;事件有则优先 |
| 4 | 消息持久化 | 有本地存储,可回溯 | **无**,LRU ~5000 条 | `aichat.mjs:493-496` | 引用超过窗口的旧消息取不到 | `caps.persistentMessages=false` 时,引用先查 inbox 缓存;取不到就渲染「[引用内容不可用]」,不阻断回复 |
| 5 | 表情回应 | `operator_id` + `message_seq` | `user_id` + `message_id`,`message_seq` 可能为空 | `monitor.mjs:2039-2074` | 反馈可能认不到人/关联不上 | 适配层统一成 `{messageId, userId, emojiIds}`;`operator_id ?? user_id` |
| 6 | HTTP 入口 | 支持 `POST / {action,params}` | 文档以 `POST /{action}` 为主,通用入口需实测 | `monitor.mjs:298`、`kuangshen.mjs:191` | 若通用入口不认,所有 API 全挂 | 适配层先探测:通用入口 404 → 自动改 `POST /{action}`(body 直接 params) |
| 7 | 无 sudo 安装 | ptrace + setcap,不改 QQ | 手动安装要改 `/opt/QQ`(root) | `迁移Ubuntu方案.md:63-90` | 服务器上装不上 | 用 AppImage(自带 QQ);或让机主把 QQ 复制到 home 再改 |
| 8 | 运维面 | 5099 WebUI、`~/opt/snowluma/logs`、unit `snowluma` | 6099 WebUI、自有日志目录、unit `napcat` | `opsweb.mjs:89-95,178-209,366-369`、`start.bat`、`stop.bat` | 运维台红/日志面板空 | 全部改成 env 驱动;日志面板做"该后端不支持"降级 |
| 9 | 账号变更 | `BOT_ID` 写死环境变量 | 同上 | `monitor.mjs:95` | 换号要改代码/配置,且 @ 识别、自发过滤全依赖它 | 改成启动时 `get_login_info` 解析,env 只作兜底 |

**一句话总结这一节**:能"连上"大概 0 改动;能"跑对",上面 9 条里至少 1、2、3、5、6 要处理,约 100~200 行,集中在适配层与三处调用点。

---

## 六、重构方案

### 6.1 设计原则

1. **不重写 bot**。monitor 3700 行、功能模块十几个,全部按 OneBot 段格式写;迁到 NoneBot/Koishi 的收益抵不上风险。
2. **内部继续用 OneBot 11 作为"母语"**,只保证一个**受控子集**(下称 OB-Subset)。Milky 之类的新协议写"翻译适配器"翻进这个子集,功能模块零改动。
3. **能力位(capabilities)显式化**。后端缺什么,就让对应功能**降级**而不是崩:没持久化就缓存引用,没表情事件就关反馈,没 SILK 就不发语音。
4. **运维与协议解耦**。unit 名、端口、日志目录、WebUI 端口、停止命令全部走 env,启动脚本做"就绪探测"而不是"端口猜测"。
5. **一条命令回滚**(`BACKEND=snowluma`)。
6. **同一 QQ 号不能同时登两个协议端**(会互踢),所以冷备演练必须用测试号或维护窗口,不能"双活"。

### 6.2 目标结构

```
agent/
  protocol/
    index.mjs        # createBackend(env) → Backend;选择实现、探测能力
    onebot11.mjs     # WS/HTTP 传输 + 事件规范化 + 错误规范化(覆盖 SnowLuma/NapCat/LuckyLilliaBot)
    milky.mjs        # (T3)Milky → OB-Subset 翻译
    mock.mjs         # 回放 fixtures,离线跑 monitor 自测
    contract.mjs     # OB-Subset 定义 + 断言(开发期用)
  monitor.mjs        # 只依赖 Backend,不再直接 new WebSocket / fetch(API)
  ...
```

```
功能模块(monitor/ygocard/hs/tieba/belial/aichat)
        ↑ 只认 OB-Subset(事件/段/action)
   protocol/index.mjs  ← 能力位 + 规范化 + 降级
        ↑
  onebot11.mjs  |  milky.mjs  |  mock.mjs
        ↑
 SnowLuma / NapCat / LuckyLilliaBot / Lagrange.Milky / Yogurt
```

### 6.3 接口契约(草案)

```js
// createBackend(env) 返回:
{
  name: 'onebot11',                 // 便于日志/运维台显示
  caps: {
    messageSeqInEvent: true|false,  // 事件里是否有可靠的 message_seq
    groupNameInEvent:  true|false,
    persistentMessages:true|false,  // get_msg 能回溯多久
    emojiLike:         true|false,
    operatorIdInEmoji: true|false,
    silkRecord:        true|false,  // record 段能否直接发 mp3 base64
    fileUpload:        true|false,
    historyAnchor:     'message_id'|'message_seq',
    universalHttpEntry:true|false,  // POST / 是否支持 {action,params}
  },
  start({ onEvent, onReconnect }),  // 内部负责重连/心跳/健康检查
  stop(),
  call(action, params, { timeoutMs }),   // 统一返回 {status:'ok'|'failed', data, retcode}
  // 语义封装(内部用 call 实现;不同后端可覆写)
  sendGroup(groupId, segs, { atUserId }),
  uploadFile(groupId, filePath, name),
  history(groupId, { count, anchor }),
  getMsg(messageId),
  groupList(), member(groupId, userId), login(),
}
```

**关键点**:`call()` 保持"OneBot 形状",让现有调用点**第一阶段不用改**;`caps` 与五个语义方法才承载差异。

### 6.4 规范化规则(必须写死,否则会出隐蔽 bug)

| 项 | 规则 |
|---|---|
| `seq` | 由适配层**一次性**决定:若 `caps.messageSeqInEvent`,实时与历史都用 `message_seq`;否则两边都用 `message_id`。历史条目若带 `message_seq` 而实时没有,**必须抹掉**,否则 `seen` 永远对不上 |
| 去重兜底 | 除 `seq` 外,再存一条 10 分钟 TTL 的内容指纹 `sha1(group_id, user_id, time, text)`,防跨后端/跨重启重复 |
| `group_name` | 事件有则用;没有则查 `groupList()` 缓存(启动 + 重连 + 每小时刷新) |
| `operator_id` | `operator_id ?? user_id` |
| `at.qq` | 一律 `String()`(仓库已有此约定,保持) |
| `image` | `url` 为空但有 `file` → 调 `get_image` 换 URL;仍失败则降级为 `[图片]` |
| `reply.id` | 一律字符串;负数 ID 原样保留(aichat 已兼容) |
| 错误 | 非 2xx / 非 JSON / `status:'failed'` → 抛 `BackendError{action,retcode,message}`,保留 `sendFailure` 的"死群"正则判断 |
| 发送返回 | 统一 `{status, data:{message_id}}`;`sendReply` 只认 `status==='ok'` |

### 6.5 能力位与降级

| 能力缺失 | 降级行为 |
|---|---|
| `groupNameInEvent=false` | 群名用缓存;缓存没有则显示群号 |
| `persistentMessages=false` | 引用先查 inbox;查不到显示「[引用内容不可用]」;**不重试、不报错** |
| `emojiLike=false` | 搬屎点赞入库 / 挥手黑名单 / 语录黑名单全部关闭,面板打一行警告;其余功能不动 |
| `silkRecord=false` | 银河皇帝语音降级为文字(或 `send_voice` 工具返回"当前后端不支持") |
| `fileUpload=false` | 完整裁定/卡表改为"生成成功但无法上传",回一条文字提示 |
| `historyAnchor='message_seq'` | 语录回填锚点改用 `message_seq`,并在翻页判重时用 `message_seq` |

### 6.6 分阶段(T0~T3)

| 阶段 | 内容 | 改动面 | 工作量 | 验收 |
|---|---|---|---|---|
| **T0 冷备演练**(不改仓库) | 找一台测试机/维护窗口,装 NapCat AppImage,用现仓库 `DRY_RUN=1` 连一次;按 6.9 清单逐项打勾 | 0 行 | 0.5~1 天 | 产出一张填满的兼容性矩阵;确认 AppImage 能在无 sudo + Xvfb 下跑 |
| **T1 配置/运维解耦** | `BACKEND`/`BACKEND_UNIT`/`BACKEND_LOG_DIR`/`BACKEND_WEBUI_PORT`/`BACKEND_STOP_CMD`;opsweb 的 UNITS/日志/端口全走 env;start.bat 改成就绪探测(`get_login_info` 轮询) | `opsweb.mjs` ~80 行、`start.bat`/`stop.bat` ~40 行、文档 | 0.5~1 天 | 仍跑 SnowLuma,行为零变化;把 env 改成 napcat 后页面能正确显示"未安装/未运行" |
| **T2 适配层** | `protocol/*` + monitor 接 Backend + 9 条差异补丁 + `BOT_ID` 动态化 + 内容指纹 + 自测/回放 | 新增 ~400 行,改 monitor ~150 行、aichat/kuangshen/voice 各 10~30 行 | 2~3 天 | `BACKEND=snowluma` 全量自测通过;`BACKEND=napcat` 在测试号上跑通 6.9 清单 |
| **T3 Milky 适配**(条件触发) | `milky.mjs`:事件/段/action 映射 + 能力位 | 新增 ~500 行 | 3~5 天 | 用一个 Milky 后端(LuckyLilliaBot 或 Lagrange.Milky)跑通同一套清单 |
| **T4 多账号/多实例**(可选) | `DATA_DIR` 让 inbox/processed/features 可重定向,支持两个 monitor 进程各挂一个号 | ~50 行 | 1~2 天 | 两个实例互不污染 |

> 建议:**T0 现在做,T1+T2 排进下一个空窗,T3 等触发**。T1/T2 做完后,S1 的切换成本从"两天"降到"十分钟"。

### 6.7 关键改动点(文件:行 → 改法)

| 位置 | 现状 | 改法 |
|---|---|---|
| `monitor.mjs:87-94` | 四个常量直接读 env | 改成 `backend` 对象;`BOT_ID` 改为 `let`,登录后赋值 |
| `monitor.mjs:297-304` | `api()` 直连 HTTP 通用入口 | 委托 `backend.call()`;保留同名函数,调用点零改动 |
| `monitor.mjs:2838-2913` | 自建 WS + 重连 | `backend.start({onEvent})`;重连/心跳/补漏触发搬到后端,`onReconnect` 回调仍调 `catchUpMissed()` |
| `monitor.mjs:2748-2792` | `seq = message_seq ?? message_id` | 用 `backend.normalizeEvent()` 产出的 `seq`;补内容指纹 |
| `monitor.mjs:2796-2836` | 补漏按 `seq === lastSeq` 停 | 改为"seen 集合 + 2 分钟窗口";`lastSeq` 只作优化 |
| `monitor.mjs:1518-1562` | 直接拼 `send_group_msg` | `backend.sendGroup()`;保留 at + 空格约定 |
| `monitor.mjs:1705/1778/1801` | 直接 `upload_group_file` | `backend.uploadFile()`;失败按 caps 降级 |
| `monitor.mjs:2039-2074` | 读 `operator_id/message_seq` | 读规范化后的 `{messageId,userId,emojiIds}` |
| `monitor.mjs:3706` | `get_login_info` 只取昵称 | 同时设定 `BOT_ID`;失败则用 env 兜底并告警 |
| `monitor.mjs:3713-3729` | `get_status` 判活 | `backend.health()`(内部可换 action/心跳) |
| `aichat.mjs:493-496` | `get_msg` 失败即无引用 | 先查调用方传入的 `quotedCache`,再 `get_msg`;失败降级 |
| `kuangshen.mjs:210,218` | `message_id` 锚点 | 用 `backend.history()` 封装的锚点 |
| `opsweb.mjs:89-95` | UNITS 写死 | env 列表;没有的 unit 显示"未配置"而不是报错 |
| `opsweb.mjs:178-209` | 固定日志目录/过滤规则 | `BACKEND_LOG_DIR` + 每后端一个 filter 函数;不支持则隐藏面板 |
| `opsweb.mjs:366-369` | 3000/3001 端口 | 从 `BACKEND_HTTP_PORT`/`BACKEND_WS_PORT` 读 |
| `start.bat:24-49` | 端口 3000/5099 猜状态 | `BACKEND_START_CMD` + 轮询 `get_login_info`(最多 60s) |
| `stop.bat:16-18` | 按 3000 端口杀 | `BACKEND_STOP_CMD` |
| `迁移Ubuntu方案.md:33-38,63-90` | SnowLuma 专属 | 增加"后端无关"章节;setcap 只在 SnowLuma 分支出现 |

### 6.8 运维改动

- **systemd**:新增 `napcat.service`(User 级,`ExecStart` 指向 AppImage/launcher,`Environment=DISPLAY=:99`);`snowluma.service` 保留但 `disable`,回滚时 `enable`。
- **opsweb**:服务卡片按 env 渲染;日志面板对 NapCat 先降级("该后端不提供统一日志格式"),后续再写 filter。
- **WebUI 隧道**:5099(SnowLuma)→ 6099(NapCat);README 的"两套凭据"段落要改。
- **登录态**:AppImage 有自己的数据目录,首次要扫码;确认能与现有 `~/.config/QQ` 共存(不共享)。
- **QQ 热更新屏蔽**:`/etc/hosts` 那条对 NapCat 同样必要(它也是按 QQ build 对齐的);AppImage 自带 QQ 则天然免疫。

### 6.9 一致性自测清单(切换前必须全绿)

建议写成一个 `--backend-conformance` 脚本(只读 + 测试群,不碰线上群):

1. `get_login_info` / `get_status` 正常,`BOT_ID` 与预期一致
2. `get_group_list` 能拿到目标群,群名进缓存
3. 测试群发一条 @bot 的文本 → 事件字段齐全,`seq` 稳定,`group_name` 有值(或由群列表缓存补上)
4. 回一条「@ + 空格 + 文本」→ 客户端里 @ 真的解析成 mention
5. 发一张 1MB 以内的 `base64://` 图片 → 正常显示
6. 发一条 `record` base64 mp3 → 能转 SILK 并播放
7. `upload_group_file` 上传一个 PDF → 群文件里能看到
8. `get_group_msg_history(count=100)` → 顺序、条数、`message_seq` 符合预期
9. 对 1 分钟前的消息 `get_msg` → 成功;对 2 天前的 → 允许失败,且 bot 不崩
10. 对 bot 刚发的消息贴一个表情 → 收到 `group_msg_emoji_like`,`messageId` 与发送返回一致
11. 拔网线/重启后端 → `onReconnect` 后 `catchUpMissed` **不重复**写入 inbox(用 `wc -l` 对比)
12. `DRY_RUN=1` 影子跑 30 分钟,对比 inbox 条数与 SnowLuma 时期同群的平均值

### 6.10 回滚

1. `.env` 改回 `BACKEND=snowluma`(或直接 `systemctl --user start snowluma && restart mc-agent`)
2. 两个后端**不能同时登录同一账号**:先停 NapCat,再起 SnowLuma
3. 登录态各自独立,回滚不需要重新扫码(除非 QQ 侧已把旧登录踢掉)
4. 数据无迁移:inbox/processed/features 都是后端无关的文件

---

## 七、风险与取舍

| 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|
| **账号风控/封号** | 高频回复、主动插话、发文件/语音 | bot 直接下线,换后端无用 | 小号、降频、不私聊/不群发;贴吧模式目前**没有冷却**(用户明确要求),这是最大敞口 |
| **NTQQ 挂钩整体被封** | QQ 大版本更新 | NapCat / LuckyLilliaBot / SnowLuma 全灭 | 纯协议(Milky)适配;或官方 API;短期只能钉住 QQ 版本 |
| **NapCat 无持久化** | 消息超过 ~5000 条 | 引用/回填退化 | 引用缓存 + 降级文案;回填锚点改 `message_seq` |
| **无 sudo 装不上** | 服务器 `/opt/QQ` 属主 root | 迁移卡住 | AppImage;或请机主执行一次"复制 QQ 到 home" |
| **内存 1.9GB** | AppImage + QQ + Xvfb + monitor + opsweb | OOM | 实测;关 debug 日志;不要在这台机上跑 Docker |
| **上游停更/跑路** | GitHub 下架、作者弃坑 | 无法升级 | 本地镜像 + 钉版本;NapCat 冷备 |
| **合规/ToS** | 长期 | 项目级风险 | 官方 API 或换平台;这不是技术能解决的 |
| **迁移引入新 bug** | 适配层改动 | 线上回复异常 | T2 全量自测 + 影子跑 + 一键回滚 |

**取舍建议**:SnowLuma 现在能用、且是三条 OneBot 路线里对"无 sudo Linux"最友好的(v1 的 ptrace 方案)。**为了一个尚未发生的风险去换掉一个正在稳定工作的组件,不划算**;但为它准备一条 10 分钟可切的退路,非常划算。

---

## 八、不建议的路线

| 路线 | 为什么不建议 |
|---|---|
| 把 monitor 重写成 NoneBot/Koishi 插件 | 3700 行逻辑深度绑定 OneBot 段格式与现有数据文件;框架迁移的收益是"生态",而本 bot 不需要生态 |
| 现在就全面迁到 Milky | 后端生态还薄(Lagrange.Milky 无正式 Release),适配器是新写;等 OneBot 真的死了再动 |
| 拿官方 QQ 机器人 API 当主方案 | 没有群历史、没有表情回应、被动 5 分钟/5 次、主动 1000 条/天/群 → 史记/贴吧/反馈全废 |
| 用付费/来源不明的"托管 OneBot 端点" | 等于把 bot 的 QQ 登录态交给第三方,账号风险不可控 |
| 继续押 gocq 系(AstralGocq 等) | 最后更新 2025-03,签名服务不可靠,协议代差太大 |
| 同一账号双协议端"双活" | QQ 会互踢,必然一边掉线;只能主备切换 |

---

## 九、参考资料

**SnowLuma**
- 仓库/发布:<https://github.com/SnowLuma/SnowLuma/releases>(v2.2.1,2026-10-27;v1.14.22,2026-10-07)
- NcatBot 的 SnowLuma 适配器说明(协议层复用 NapCat 组件):<https://docs.ncatbot.xyz/guide/4g7y2mqp/>

**NapCat**
- 仓库:<https://github.com/NapNeko/NapCatQQ>(v4.18.41,2026-10-21)
- Shell 安装(Linux 一键/AppImage/手动):<https://napneko.github.io/guide/boot/Shell>
- Linux 手动安装(需改 `/opt/QQ`):<https://napneko.github.io/guide/boot/Shell-Linux-SemiAuto>
- WebUI 与 OneBot 配置(3000/3001/6099):<https://napneko.github.io/config/basic>
- 消息 ID / LRU 设计:<https://napneko.github.io/onebot/napcat>
- 事件结构(表情回应):<https://napneko.github.io/onebot/event>
- API 一览(8 个 action 均有):<https://napneko.github.io/onebot/api>

**LuckyLilliaBot / Lagrange / Milky**
- LuckyLilliaBot(原 LLOneBot,v8.3.2,2026-10-13):<https://github.com/LLOneBot/LLOneBot>
- Lagrange V2 文档(明确不再支持 OneBot 11):<https://lagrangedev.github.io/Lagrange.Doc/v2/>
- Milky 协议与实现清单:<https://milky.ntqqrev.org/>、<https://milky.ntqqrev.org/awesome>
- Yogurt(acidify):<https://github.com/LagrangeDev/acidify>

**官方 / 已停更**
- QQ 机器人消息收发规则(被动 5 分钟/5 次、主动 1000 条/天/群):<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- AstralGocq(最后发版 2025-03):<https://github.com/ProtocolScience/AstralGocq>

---

## 附录:切换 NapCat 的命令草案(仅供演练,未执行)

```bash
# 0) 前置:确认 Xvfb 在跑(:99),磁盘/内存够
# 1) 从 NapCatAppImageBuild 的 Releases 下载对应架构的 AppImage(自带 QQ,无需 root),
#    保存为 ~/opt/napcat/NapCat.AppImage;资产名以 Releases 页为准,不要照抄文件名。
mkdir -p ~/opt/napcat && cd ~/opt/napcat
chmod +x NapCat.AppImage
# 2) 停 SnowLuma(同一 QQ 号不能双开)
systemctl --user stop snowluma
# 3) 起 NapCat(用现有 Xvfb,免 xvfb-run/xauth)
DISPLAY=:99 ./NapCat.AppImage --appimage-extract-and-run
# 4) SSH 隧道进 6099 WebUI → 扫码登录 → 网络配置:
#    HTTP 服务端 127.0.0.1:3000,token = agent/.env 的 API_TOKEN
#    WS  服务端 127.0.0.1:3001,token = agent/.env 的 WS_TOKEN
# 5) 探针:get_login_info / get_group_list / get_group_msg_history
# 6) 起 monitor(先 DRY_RUN=1 影子跑 30 分钟)
cd ~/mc_agent/agent && DRY_RUN=1 node monitor.mjs
# 7) 回滚:停 NapCat → systemctl --user start snowluma → systemctl --user restart mc-agent
```
