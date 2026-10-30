# QQ 官方 Bot 通道:插件、入口与能力调研(2026-10-28)

> 只做调研,不改代码。
> 本文里的"插件"指 **腾讯 QQ 开放平台为各类 AI Agent 框架发布的 QQ 通道插件**(不是 QQ 客户端里的插件商店);"入口"指 **建 Bot、绑 Agent、进群、单聊、频道、命令面板**等用户能接触到的路径。
> 结论先行:**官方通道在 2026 年已经从"只能被 @"变成"能进群、能在群主授权后收全量消息、能主动发言、能发文件/语音/图片"的完整 IM 通道**,但仍然是**另一套产品面**(openid、无群历史、无群表情回应、5 分钟被动窗口、内容审核),不能直接替换 SnowLuma 那套"老群友"体验。

---

## 一、最近半年发生了什么(时间线)

| 日期 | 事件 | 意义 |
|---|---|---|
| 2026-03-06 | 个人用户可**扫码快创** QQ 机器人(接 OpenClaw),单 QQ 最多 5 个 | 建 Bot 从"开发者认证"降到"扫码 1 分钟" |
| 2026-04-16 | **Hermes Agent 官方合入 QQ Bot 通道** | 第一个"原生内置"QQ 通道的 Agent |
| 2026-06-06 | OpenClaw 内置插件支持**群 always 模式**(群全量消息) | 群内不再只能被 @ |
| 2026-07-01/02 | OpenClaw 通道 API 改名(`formatInboundEnvelope` → `formatAgentEnvelope`),插件需 ≥2.0.1 | 插件生态开始有兼容性门槛 |
| 2026-08-10 | 接口域名统一 `api.bot.qq.com`;新增群禁言、入群审批、自动审批;Markdown 图片校验 | 群管理能力补齐 |
| 2026-08-12 | 新增**自定义菜单**与**指令面板**接口 | Bot 资料页有了"功能入口" |
| 2026-08-14 | **`@tencent-connect/dsh-qqbot` 0.1.0** 发布 | DeepSeek Harness 的官方 QQ 插件 |
| 2026-09-03 | 群成员管理:列表/信息/批量移除/黑名单 | 群运营能力接近第三方协议端 |
| 2026-09-16 | 分享链接 `generate_url_link`;ARK 新增 picture | Bot 可以被"分享/拉人" |
| 2026-10-21 | **素材管理**(图片上传为 `qqbot-media://`,可在 Markdown 引用) | Markdown 发图不用公网 URL |
| 2026-10-26 | 群聊支持 **@全体成员**(Bot 需群管理员,每群每天 1 次) | 官方 Bot 的"公告"能力 |
| 2026-10-27 | `dsh-qqbot` 0.5.3;SnowLuma v2.2.1 | 两条线都在活跃迭代 |

> 来源:官方[变更记录](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html)、[Agent 接入](https://bot.q.qq.com/wiki/agent-qqbot/)、npm registry 时间戳、[IT之家 2026-04-16](https://m.ithome.com/html/0939789.htm)、[IT之家 2026-03-07](https://www.163.com/dy/article/KNEBQK8M0511B8LM.html)。

---

## 二、官方发布的"插件"矩阵

| 插件 / 集成 | 形态 | 维护方 | 最新版本 / 日期 | 关键能力 | 适合谁 |
|---|---|---|---|---|---|
| **`@tencent-connect/openclaw-qqbot`** | OpenClaw 通道插件(npm) | QQ 开放平台团队 | **2.0.4** | 群/私聊;群 always 模式;私聊流式;多账号;群白名单;版本自检 `/bot-version` | 用 OpenClaw 的人 |
| **`@tencent-connect/dsh-qqbot`** | DeepSeek Harness 插件(npm) | QQ 开放平台团队 | **0.5.3(2026-10-27)** | 扫码绑定;群/私聊;Markdown;图片/视频/文件;视觉理解;`send_file`;内联按钮;群历史缓冲(仅本地 10 条) | 用 dsh 的人(**本仓库所在环境**) |
| **Hermes Agent QQ 通道** | Agent 内置通道 | Nous Research / QQ 官方 | 2026-04-16 合入 | 文字/语音/图片;`hermes gateway setup` 配置 | 用 Hermes 的人 |
| **`@tencent-connect/qqbot-connector`** | 扫码绑定 SDK(npm) | QQ 开放平台团队 | 1.2.0(当前引用版本) | 控制台出二维码 → 扫码 → 返回 AppID/AppSecret;可自定义来源标识 | 第三方 Agent 平台 |
| **WorkBuddy** | 桌面端集成 | 腾讯 | — | 助理设置 →「QQ 机器人集成」→ 扫码绑定 | 办公 Agent |
| **QClaw** | 远控通道 | 腾讯 | — | 设置 → 远控通道 → QQ → 快捷绑定 | 远控/办公 |
| **LightVela** | 云端托管 Hermes | — | — | 通道 → QQ → 扫码连接 | 免安装用户 |
| **腾讯云 OpenClaw 模板** | Lighthouse 一键部署 | 腾讯云 | — | 预置镜像 + QQ 接入指引 | 想托管的人 |

几个要点:

1. **插件只是"消息通道"**,不提供智能。官方文档明确写:图片理解、语音转录、画图等能力取决于你配的模型与 Skill,不是插件本身。
2. **插件质量与兼容性开始分层**:OpenClaw 2026.7.1-2 之后,旧插件(<2.0.1)会报 `formatInboundEnvelope is not a function`;官方给出的解法是升级插件,而不是改 Agent。
3. **dsh-qqbot 是"本仓库同款"路线**:它把 dsh 的 agent loop 直接接到 QQ,支持群/私聊、Markdown、附件、按钮;但它的"群历史"只是**进程内缓冲 10 条**(`historyLimit`),不是服务端历史。这恰好印证了官方通道的硬限制(见第四节)。
4. **官方 OpenClaw 插件是开源免费的**(仓库 `tencent-connect/openclaw-qqbot`,更新日志也在仓库里);dsh 插件是 MIT。两者都不是"腾讯替你托管 Agent",而是"把你的 Agent 接到 QQ"。

---

## 三、官方"入口"矩阵(建 Bot / 绑 Agent / 用 Bot)

### 3.1 建 Bot 的两个入口

| 入口 | 地址 | 门槛 | 限制 |
|---|---|---|---|
| **扫码快创**(龙虾 Bot) | <https://q.qq.com/qqbot/openclaw/login.html> | 手机 QQ 扫码,实名 QQ | 单 QQ 最多 **5 个**;功能是"Agent 外壳",资料可后改 |
| **开放平台** | <https://q.qq.com/#/apps> | 主体认证(个人/企业) | 个人:机器人进群上限 **500**,不支持公开;企业:每个认证账号可建 10 个,同主体共用上限 50 |

- 未认证主体:只能把 Bot 加到自己**是群主/管理员**的群。
- 个人认证:进群上限 **500**,但**不能公开被使用**;企业认证:可公开。
- 官方 FAQ:**QQ 机器人进群能力已全面开放,群主可直接添加**(需最新版手机 QQ)。

### 3.2 绑 Agent 的入口

| 方式 | 操作 | 适用 |
|---|---|---|
| **扫码绑定** | Agent 端出二维码 → 手机 QQ 扫码 → 选中 Bot → 返回 AppID/Secret | OpenClaw / dsh / Hermes / WorkBuddy / QClaw / LightVela |
| **AppID + AppSecret** | 在 Agent 配置里手填 | 所有支持自定义通道的 Agent |
| **`qqbot-connector` SDK** | 第三方平台在自己的控制台出二维码 | 想做成"一键绑定"的平台 |
| **WebSocket / WebHook** | 开放平台「事件订阅与回调」二选一 | 自研服务端 |

- WebSocket:不依赖公网服务器,适合个人单机,需维护长连接。
- WebHook:推到你自己的 HTTPS 服务,适合公开服务。
- 还有 **IP 白名单**(最多 50 个 IPv4)与 **20 个内部体验号码**。

### 3.3 用 Bot 的入口(用户侧)

| 入口 | 形态 | 说明 |
|---|---|---|
| **群聊** | 群设置 → 机器人 → 添加 | 群主/管理员操作;可设"可获取群聊消息范围"与"主动发言" |
| **单聊** | QQ 消息列表直接对话 | 支持流式回复(群聊不支持) |
| **频道** | 频道机器人 | 另一套场景,表情表态只有频道支持 |
| **分享链接** | `generate_url_link`(2026-09-16) | 把 Bot 分享给别人/群 |
| **命令面板 / 自定义菜单** | Bot 资料页(2026-08-12) | 把 `/help`、查卡、每日一卡做成按钮入口 |
| **内联键盘** | 消息里的按钮 | 回调 / 指令 / 跳转;dsh 插件用它做"问答/审批" |

> 一句话:**入口已经"产品化"了**——扫码建、扫码绑、群主拉、资料页有菜单、消息里有按钮。这和三年前"填 AppID 写代码"完全不是一回事。

---

## 四、官方通道的真实能力边界(2026-10)

### 4.1 能做什么

| 能力 | 细节 |
|---|---|
| 群 @ 消息 | `GROUP_AT_MESSAGE_CREATE`;`mentions` 列表;`content` 里 @ 变 `<@openid>` |
| **群全量消息** | `GROUP_MESSAGE_CREATE`:开启"接收所有消息"后,群里每条消息都推;含 `author.member_role`(owner/admin/member)、`attachments`、`msg_elements` |
| 单聊 | `C2C_MESSAGE_CREATE`;支持**流式**回复 |
| 发送文本 / Markdown | `msg_type=0/2`;Markdown 支持代码块、表格;群聊可用 |
| 富媒体 | `msg_type=7`:图片/视频/语音/文件;先上传拿 `file_info`;语音有 `voice_wav_url` 与 **ASR 参考文本** |
| 引用回复 | 收:`message_type=103` / `message_scene.ext` 的 `ref_msg_idx`;发:`message_reference` |
| 按钮 / 菜单 / 指令面板 | 内联键盘、全局自定义菜单、指令面板管理 |
| 群管理 | 群信息、成员列表/信息、批量移除、黑名单、禁言、入群审批/自动审批、成员进出事件 |
| @全体 | 2026-10-26 起,Bot 为群管理员时每天 1 次 |
| 去重 | `msg_id` + `msg_seq`;被动回复同一 `msg_id+msg_seq` 重复会失败 |

### 4.2 不能做什么(对本 bot 致命的三条)

| 缺失 | 证据 | 影响 |
|---|---|---|
| **没有"拉群历史"接口** | 2026-10-21 的接口索引里只有发/撤回/富媒体/群管理,没有 history | 史记总结、贴吧上下文、语录回填**无法在进群后补历史**;只能从 Bot 上线那一刻开始攒 |
| **群聊没有"表情回应"** | 消息类型表:表情表态仅**频道**支持 | 搬屎点赞入库、挥手黑名单、语录负反馈**全部失效** |
| **身份是 openid,不是 QQ 号** | 事件 `author.member_openid`;成员接口也以 openid 为键 | `ADMIN_QQ`、`BOT_ID`、按 QQ 号存的状态/黑名单/统计**全部要改** |

另外还有:

- **被动回复窗口 5 分钟、同一条消息最多 5 次**;超时错误 `40034005/40034128`。
- **主动消息**:认证 60 qpm / 未认证 30 qpm;单群 20 qpm、**每天 1000 条**;超限 `40034100`。
- **文本里不允许发 URL**(错误码 `40054010`),对"上位卡组原帖链接"这类功能是硬伤(Markdown 是否放行需实测)。
- **内容审核**:`40034006 消息内容违规`;运营规范禁止色情低俗、引战、赌博等。本 bot 的"放开档"人设与搬屎内容,在官方通道上属于**随时可被封**的范畴。
- **群文件**:只能作为"文件消息"发,不是"群文件库"里的持久文件。
- **群列表**:没有"我加入了哪些群"的接口,只能靠 `GROUP_ADD_ROBOT`/`GROUP_DEL_ROBOT` 事件自己记。

---

## 五、和现有 bot 的适配度

| 现有功能 | 官方通道 | 结论 |
|---|---|---|
| @ 触发 AI 闲聊 | ✅ 文本/图/语音(ASR) | 可直接搬 |
| 查卡 / 卡图 / 每日一卡 | ✅ 文本 + 图片 | 可直接搬(链接类输出要改) |
| 环境饼图 / 上位检索 | ✅ 图片;⚠️ 原帖链接可能被 URL 规则拦 | 需实测,可能要改成"按钮/菜单" |
| 完整裁定 / 卡表 PDF | ✅ 文件消息(非群文件库) | 可用,交互略变 |
| 银河皇帝语音 | ✅ 语音消息 | 需确认 SILK/格式转换 |
| 引用解析 | ✅ 103 / `ref_msg_idx` | 可用 |
| **史记总结(最近 100 条)** | ❌ 无历史接口 | **只能"上线后攒"**,刚进群时无法总结 |
| **贴吧模式(不 @ 接话)** | ⚠️ 需群主开"全量消息 + 主动发言";有 1000/天/群额度 | 可用,但**每个群都要群主手动开** |
| **搬屎 / 语录反馈(表情)** | ❌ 群聊无表情回应 | **必须换交互**(文字投票/按钮) |
| **system 控制台(按主人 QQ)** | ⚠️ openid / `member_role` | 需要重建鉴权(openid 白名单) |
| 多群运维 | ⚠️ 无群列表接口 | 靠事件表维护 group_openid 清单 |
| 头像/昵称/群名片 | ✅ 成员信息接口 | 可用 |
| 主动推送(定时) | ✅ 1000/天/群 | 够用 |

**粗略估计:现有功能约 55%~65% 能搬,且"史记/贴吧/反馈"三大特色全部降级。** 这不是"换个协议端",而是"换一个产品面"。

---

## 六、三个可选方案

### 方案 A(推荐):双通道,SnowLuma 主力 + 官方"轻 Bot"副线

- 主 Bot 继续跑 SnowLuma(QQ 号身份、历史、表情反馈、群文件都在)。
- 另建一个官方 Bot(扫码快创即可),只挂"轻功能":@ 闲聊、查卡、每日一卡、环境饼图。
- 好处:官方通道**合规风险低**(不涉及第三方协议端,但内容违规仍会被处理)、有按钮/菜单/流式、可作为 S4(合规压力)时的逃生门;坏处:两个 Bot 两套身份,用户要分别 @。
- 成本:一个官方 Bot + 一个适配器(或直接用 `dsh-qqbot` 起一个"轻 Agent"),**1~3 天**可跑通。

### 方案 B:官方为主(不推荐,除非 S4 发生)

需要改的:
1. **身份层**:openid ↔ 内部 ID;管理员改 openid 白名单;状态文件迁移。
2. **历史层**:进群后开始缓冲;没有"补历史";史记要等攒够。
3. **反馈层**:表情回应 → 文字/按钮投票;搬屎/语录逻辑重写。
4. **发送层**:`msg_id+msg_seq`、5 分钟窗口、1000/天、URL 规则、按官方/插件上限切分长文本。
5. **群列表**:靠 `GROUP_ADD_ROBOT` 事件维护。
6. **合规层**:人设与内容全面收敛。

成本:**2~4 周**,且产品体验降级。不建议在 SnowLuma 还能用时做。

### 方案 C:零改造试用(建议本周就做)

在本机 dsh 里装官方插件,拿一个测试群试三天:

```bash
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot
npx @deepseek-ai/dsh --profile qqbot
# 首次启动扫码绑定;群里 @ 它即可
# 群全量模式:群主开权限后,在 cordis.patch.yaml 设 requireMention: false
```

这不会动现有 bot,但能**亲手验证**:官方通道的时延、图片/文件、引用、按钮、以及"没有历史"到底有多痛。试完再决定要不要做方案 A。

---

## 七、如果要做官方适配器,改造清单

| 模块 | 现状(SnowLuma/OneBot) | 官方通道 | 改法 |
|---|---|---|---|
| 鉴权 | Bearer token | AppID/Secret → `access_token` | 新增 token 刷新 |
| 收消息 | WS 事件(OneBot) | WS/WebHook(`GROUP_MESSAGE_CREATE`) | 新事件解析 |
| 身份 | `user_id`(QQ 号) | `member_openid` / `group_openid` | 全链路改键;建映射表 |
| 引用 | `reply` 段 + `get_msg` | `msg_elements` / `ref_msg_idx` | 直接读事件,无需 get_msg |
| 历史 | `get_group_msg_history` | 无 | 本地缓冲(SQLite),只增不减 |
| 发送 | `send_group_msg` | `POST /v2/groups/{openid}/messages` | `msg_id+msg_seq`、5 分钟窗口 |
| 图片 | `base64://` | 上传 `file_info` → `msg_type=7` | 先传后发 |
| 文件 | `upload_group_file` | 上传 → `msg_type=7` | 文件消息,非群文件库 |
| 语音 | `record` base64 → SILK | 上传语音 → `msg_type=7` | 需转码验证 |
| 表情反馈 | `group_msg_emoji_like` | 无 | 按钮/文字投票 |
| 群列表 | `get_group_list` | 无 | `GROUP_ADD_ROBOT` 事件表 |
| @全体 | `at qq=all` | `<qqbot-at-everyone />` | 仅管理员、1/天 |
| 限频 | 无(自己控) | 20 qpm/群、1000/天/群、5 分钟/5 次 | 发送队列 + 退避 |
| 错误 | `sendFailure` 正则 | `retcode`(40034006/40034100/40054010…) | 新错误映射 |

---

## 八、风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| **内容合规** | 运营规范禁止色情/引战/赌博;`40034006` 会直接拒发;严重会下架 | 官方 Bot 用"干净人设",搬屎/放开档只留在 SnowLuma |
| **认证与进群** | 未认证只能进自己管理的群;个人认证 500 群且不公开 | 先用快创 + 测试群;要铺开再认证 |
| **5 分钟窗口** | AI 生成慢/排队会错过 | 先回"在查",再被动补发;或转主动消息(耗额度) |
| **无历史/无表情** | 三大特色降级 | 双通道分工;不要指望官方替代 |
| **URL 限制** | 上位原帖链接可能被拦 | 改按钮/菜单/小程序卡片,或实测 Markdown |
| **openid 迁移** | 所有按 QQ 号存的数据都要迁 | 新 Bot 新数据;不要混用 |
| **插件兼容性** | OpenClaw 2026.7 破坏性变更;dsh 插件仍在 0.x | 钉版本、读 changelog、留回滚 |
| **平台依赖** | 规则/额度/接口随时可能变 | 官方通道只做"副线",不把主业务押上去 |

---

## 九、结论

1. **官方通道已经"能用"**:群全量消息、主动发言、文件/语音/图片、引用、按钮、菜单、群管理,2026 年下半年补齐得很快。
2. **但它不是 SnowLuma 的替代品**:没有群历史、没有群表情回应、openid 身份、5 分钟/1000 条额度、内容审核——这几条决定了它只能做"另一个 Bot",不能做"同一个 Bot"。
3. **最划算的动作是"零改造试用"**:用 `dsh-qqbot` 在测试群跑三天,验证时延与体验;这比任何调研都准。
4. **如果要长期双轨**:把官方通道当成协议层里的**第二个 backend**(和 SnowLuma/NapCat 并列),只挂轻功能;主 Bot 继续跑 SnowLuma。这样 S4(合规)发生时,你有一个**不依赖第三方协议端**的逃生门。

---

## 十、来源

**官方文档**
- QQ Bot 介绍与接入指南:<https://bot.q.qq.com/wiki/>
- Agent 接入(插件矩阵与扫码入口):<https://bot.q.qq.com/wiki/agent-qqbot/>
- 变更记录(2026-08 ~ 2026-10):<https://bot.q.qq.com/wiki/develop/api-v2/changelog.html>
- 消息收发概述(被动/主动/频控):<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- 消息类型(引用/表情表态/文件):<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html>
- 群消息(全量模式)事件:<https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html>
- 发送群聊消息(msg_id/msg_seq/键盘/引用):<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html>
- 接口索引(无群历史接口):<https://bot.q.qq.com/wiki/develop/api-v2/autogen/>
- 运营规范:<https://bot.q.qq.com/wiki/business/>

**插件**
- OpenClaw 官方插件:<https://github.com/tencent-connect/openclaw-qqbot>(npm `@tencent-connect/openclaw-qqbot`,2.0.4)
- DeepSeek Harness 官方插件:<https://github.com/tencent-connect/dsh-qqbot>(npm `@tencent-connect/dsh-qqbot`,0.5.3,2026-10-27)
- 第三方 Agent 扫码 SDK:`@tencent-connect/qqbot-connector`(1.2.0)

**新闻**
- Hermes 原生接入 QQ(2026-04-16):<https://m.ithome.com/html/0939789.htm>
- 个人扫码快创 / 5 个 Bot(2026-03-07,IT之家网易号):<https://www.163.com/dy/article/KNEBQK8M0511B8LM.html>
- QQ Bot 插件接入 Hermes(2026-04-16):<https://ai.zol.com.cn/1166/11660139.html>
