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

7. **AI 闲聊(兜底)**:群里 **@机器人 但没写任何指令**时,把最近 10 条群聊当上下文,交给对话模型接话——群里人都叫它「赛博史官」,但**正文说白话**、回复简短(超过 400 字截断)。**后端只剩一套(2026-09-21 起)**:OpenAI 兼容的 `/chat/completions`,默认 **DeepSeek**(`deepseek-flash`,会看图 → 图片一轮直传),换任何兼容服务只改 `AI_CHAT_API_URL` / `AI_CHAT_MODEL`;**原来的「智谱 GLM 聊天后端」整块删了**(它唯一的好处是免费,代价是把图片识别与联网都绑死在智谱身上)。key 取 `agent/.env` 的 `DEEPSEEK_API_KEY`(或 `AI_CHAT_API_KEY`),**没配 key 时该功能启动即强制关闭**。每人 15s 冷却防连点刷屏(2026-09-21 已按用户要求**关掉**:服务器 `.env` 里 `AI_CHAT_COOLDOWN_MS=0`;代码保留这个开关,非 0 就恢复原行为),群聊记录拉不到时退化成只按这一句回答。**面板 `3` 键 / 运维 WebUI 可即时开关**。

    **提示词档位(2026-09-21 新增,可热切)**:原本提示词里写死「不聊政治、色情、违法内容,被问到就岔开」「群友互喷时别站队」,在成人 QQ 群里显得板正、爱岔话。现在拆成**三档**,运维台「AI 闲聊 · 提示词档位」卡片一点即换(写 `agent/aichat/tone.json`,monitor **每次回复前重读**,不用重启、也不用敲 tmux 按键):**板正档 `strict`**(原版红线一句不碰,适合有陌生人的群)/ **熟人群聊档 `loose`(默认)**(荤的素的、政治吐槽都接得住,但不主动拱火、不被当枪使去对喷;时效性事实仍不许拿记忆糊弄,该搜就搜)/ **放开档 `wild`**(连「别主动挑事/别站队」也去掉,群里要吵就陪着吵)。三档共用的硬约束只剩**功能性**那几条:说白话、只输出正文、图表别编、不知道就说不知道(编出来的卡表/日期会让群友当真)。档位与文案的唯一出处是 `agent/aichat/tone.mjs`,opsweb 只 import 它来画界面。

    **联网搜索(2026-09-21 重写成真正的工具调用)**:旧路子是「给智谱后端挂它家的 `web_search` 工具,服务端自己去搜、把结果注入提示词」——**只对智谱有效**(deepseek 挂上必 4xx)、而且搜没搜看不见。现在改成标准 **OpenAI function calling**:我们**自己定义** `web_search` 函数、**自己执行搜索**、把标题/摘要/**发布日期与来源链接**当 tool 消息喂回去,**任何后端都能用**,而且每次搜索都在 monitor 面板上打一行(搜了什么、几家源、几条结果)。模型自己判断该不该搜:纯闲聊、算数、群里的梗**不搜**;涉及最新禁卡表/新闻/价格/比分/没底的数字日期才搜。单次回复最多搜 `AI_CHAT_MAX_SEARCHES`(默认 2)次,到顶就摘掉工具逼它用已有材料作答。搜索源(见 `agent/aichat/websearch.mjs`)**默认 `zhipu`**——用 `ZHIPU_API_KEY` 调智谱的 **Web Search API**(那只是搜索服务,和「拿智谱当聊天模型」是两回事,所以智谱聊天后端删了它还在;实测搜「游戏王 2026年7月 禁卡表」1.4 秒回 6 条、带官方公告日期),key 换/加别家见下方 env;`bing` 是**零 key 兜底**(抓 cn.bing.com 的 HTML,质量明显差:实测搜「游戏王 禁卡表」回的是「4399小游戏/Steam」这类大词泛化结果,只当应急)。**搜到了不等于对**:同一次结果里新旧卡表页面会同时出现,所以日期与链接一并给模型,提示词里也写了「拿不准就说『查到的说法是 …』」——照旧别当权威。

    **日期/时间不是搜出来的,是喂进去的**(2026-09-14 实测保留):问「今天几号」根本不会触发联网,不喂就编——同一句话连问两次答成「今天20号」和「今天12号」;所以系统提示词里**每次请求现算**一句「现在是 X 年 X 月 X 日(星期X)HH:MM」(常驻进程,不能在模块顶层算一次),并注明「以它为准、没问别主动报时间」。同理**群聊记录里非今天的消息带「昨天/前天/M-D」前缀**:否则模型把昨天的当成刚发生(实测问「现在几点了」,它从上下文里抄了昨天的 17:19)。

    **消息解析(2026-09-13 新增;图片 2026-09-17 改成一轮;@ 渲染 2026-09-20 修)**:群友发来的消息不再只认纯文字,消息里夹的 **@某人 / 引用(回复某条消息)/ QQ 表情 / 图片与表情包** 都会还原成模型读得懂的正文(模块 `agent/aichat/aichat.mjs`):@ 换成群昵称;引用用 `get_msg` 取回被引消息摊平成「[引用 @某人: 内容]」;**QQ 表情** 按 id 查表换成「[表情:微笑]」(表 `agent/aichat/qq_faces.json`,283 条,导出自 SnowLuma 的表情目录);**图片/表情包默认「直传」**——图经 ffmpeg 等比缩到长边 ≤1600 并转 JPEG,**按 data URL 直接附在消息里交给对话模型**,正文里只留 `[图片1]`/`[表情包2]` 占位,**一次请求就出结果**(`AI_CHAT_IMAGE_MODE=direct`,默认)。切回 `describe` 才是老的两轮:第 1 轮把图单独交给视觉模型(`glm-4v-flash`,免费)识别、**图上的文字逐字完整抄下来**,第 2 轮把结果**按原位置**拼回正文再交给对话模型。所以「发张图 @ 机器人问这是啥」「回复某个表情包再吐槽」「帮我看看这张截图写了啥」都能接住。**直传实测比两轮又多又准**:550x207 的小字卡面直读就能读对(老路那套「小图放大 4 倍」不必了),780x1400 的中文长截图抄回 432 字、glm 两轮只有 360 字(后者撞在自己 1024 的输出上限上);图片 token 按**像素面积**分档(实测):≤26 万像素 ≈185、768² ≈383、~100 万(1024² / 780x1400)≈612~683、≥230 万封顶 ≈995,所以「塞进 1600x1600」既保字又不加钱。**老路(describe)的细节**:图片先下载再经 ffmpeg 转 JPEG(QQ 的动画表情动辄 3~12MB,直接传会被视觉模型判格式错),**长边不到 800px 的小图先 LANCZOS 放大 4 倍**(卡面/文字条这类小图里的字只有十来像素,直传模型不是「认不出」而是照着想象往下编 —— 实测一张 550x207 的卡面效果文本被整段编造成另一张卡,放大后才读得出真实内容),**长截图按 ~800px 高切块**分别识别再接缝去重(视觉模型单次输出上限 1024 token,整张长图会抄一半就断)。两条路都:单条消息最多 3 张、识别结果按图片 md5 缓存;某张图取不到或转码失败只影响它自己(正文显示成「没能识别」)或整条退回纯文字,不影响回复。**特别长的图、以及生僻专有名词(卡名/人名)仍可能抄不全或认错,别当权威文本用。**CLI 自测 `node aichat.mjs --selftest | --image <路径|URL> | --render <消息json>`。

    **@ 提及渲染(2026-09-20 修,踩得很深的坑)**:此前群聊上下文里的 @ **一律变成「@all」**——包括 @机器人自己。根因是**键类型不一致**:`get_group_msg_history` 给的 `user_id` 是 **number**,而消息段里 `at.data.qq` 是 **string**(线上实测:发言者 `user_id: 2186220790`,段里 `qq: "2186220790"`),`names` 表按 number 建、按原样查 → 永远查不中,于是全部落到兜底分支 `'@all'`。现在四类分得清:**@某人 → `@真实群昵称`**(表键统一 `String`)、**@全体成员 → `@全体成员`**(`qq: 'all'`,不再当成人,也不进 `targets`)、**@机器人自己 → `@你(史官)`**(与 aichat 口径一致,提问正文里仍会被剥掉)、**查不到名字 → `@成员<qq>`**(绝不写 `@all`)。被 @ 的人若**没在本批记录里发过言**,会额外批量问一次群成员接口(单批最多 12 人)把真昵称回填进名单,尽力而为、失败不影响正文。修的是群聊记录(`agent/monitor.mjs` 的 `segText`/`atText`/`fetchTranscript`),**AI 闲聊上下文与「史记总结」共用这条路**,两处一起好。自测:`node monitor.mjs --selftest-at`(钉住「谁在 @ 谁」,含 number/string 两种键、@全体、@自己、查不到名字等用例)。

**卡库更新**:monitor 控制台按 `u` 手动更新;或启动参数 `node monitor.mjs --update-cards` 启动即更新。流程:下载 cards.zip → 校验(JSON 完整性+卡数阈值,md5 仅参考) → 解压 → 原子替换 → 内存重载 → **自动同步下载缺失卡图**(跳过已有,增量很快),失败不影响旧卡库。也可单独跑 `node agent/ygocard/download_images.mjs` 补卡图。

8. **炉石传说系列(2026-09-20 新增)**:整个炉石功能**由分群模式开关控制**——群里 @机器人 说「**mode 炉石**」切到炉石(说「mode 游戏王」切回),**默认游戏王**(老行为不变)。状态存 `agent/modes.json`,**键是群号**(`{"793874011": "hs"}`),**每个群各记各的**,一次设置后一直沿用;opsweb 运维台有「游戏模式」卡片可直接点(与群里发指令等价、即时生效)。**只影响游戏王/炉石相关功能**——史记总结、AI 闲聊、搬屎、框神语录**都与模式无关,照旧**。「mode」也可以写成「模式」。

    **炉石四个功能**(与游戏王那套对称,触发词故意重叠,按模式分流):

    | 功能 | 用法 | 回复 |
    |---|---|---|
    | 卡牌检索 | `效果 火球术`(可用「卡图 火球术」只看图) | 卡牌信息(职业/类型/费用/攻防/效果,中文卡名) **+ 卡图** |
    | 卡组解析 | `卡组解析 ` + 卡组代码(游戏里「复制卡组代码」那串 `AAE…`) | 中文卡表:格式、职业、英雄、费用曲线、每张卡的名称与张数(备牌单列) |
    | 每日一卡 | `每日一卡` | 同游戏王规则:**同一人同一自然日同一张,过 0 点换卡**(状态 `agent/hs_daily_card.json`,与游戏王那份分开存),先文字后卡图 |
    | 环境热门构筑 | `推荐 标准 猎人` / `推荐 狂野 圣契骑`(职业可用简称:猎/法/术/贼/骑/牧/萨/战/瞎/德/死骑) | **两条**:①构筑内容+胜率+环境使用率+场样本(卡表逐张列)②**只有一串纯净卡组代码**(不带卡组名/卡名,方便直接复制导入) |

    **数据源与踩坑(实测定论,别重复试)**:
    - **卡牌库**:HearthstoneJSON 的 `api.hearthstonejson.com/v1/latest/zhCN/cards.json`(实测 200/9.6MB/2s,36022 条,中文卡名全)。卡图按需下载并本地缓存(`agent/hs/cards_img/{id}.png`,LRU 上限 1500 张),源 `art.hearthstonejson.com/v1/render/latest/zhCN/512x/<id>.png`。更新卡库:`node agent/hs/hs.mjs --update-cards`。
    - **卡组代码**:纯本地自写解码器(`agent/hs/hs.mjs`,零依赖,格式对齐 HearthSim/deckstrings 官方实现)。**踩过的坑**:卡牌段不是「一条一张卡」,而是按 **1 张 / 2 张 / N 张分三组**(每组各自先读条目数,只有第三组才多读一个张数),备牌段前面还有一个**标志字节**;第一版按「(dbfId<<1|奇偶)」解,7 条真实卡组代码**全部解错**(解出「6 条目 8 张 + 12 条备牌」这种荒谬结果)。解码器用**编码→解码往返**+ 7 条真实代码验证过(标准 30 张、狂野 40 张雷纳索尔、备牌段都过),自测 `node agent/hs/hs.mjs --selftest`。
    - **环境数据(推荐)**:主源 **Firestone 静态 CDN**(`static.zerotoheroes.com/api/constructed/stats/decks/<format>/<rank>/<period>/overview-from-hourly.gz.json`),实测 200:标准 0.99MB/1s、**狂野 0.66MB/1.2s**,每条含 `decklist`(卡组代码)+ `winrate` + `totalGames`,**使用率 = totalGames / dataPoints**(实测两边闭合)。默认取 `all/last-patch`(全分段、样本最大);文件名带 `.gz` 但**是明文 JSON,别 gunzip**。体系中文名来自 `static.firestoneapp.com/data/i18n/zhCN.json` 的 `archetype` 字典(缺中文的回退英文)。缓存 1h(`agent/hs/data/hs_meta.json`,每职业每格式只留前 20 套,~140KB),**bot 从不干等海外请求**。
    - **抓不到时的两级兜底**:① `hearthstone-decks.net` 的 WordPress REST(境内可达、标准+狂野都有完整代码,**但只有战绩 Score、没有胜率/使用率**,回复里如实标未知);② `metastats.net` 抓 HTML(**只有标准**,但带 `#Games`/`#Win Rate`)。全失败才退回旧缓存并标「时效已过」。手动刷新:`node agent/hs/hs_meta.mjs --refresh [standard|wild|both]`,看库 `--stats`;从文章页补卡组:`node agent/hs/hs_meta_refresh.mjs <文章URL> [--dry]`。
    - **实测走不通的源**(省得再试):hsguru.com / api.hsguru.com / d0nkey.top(DNS 污染 + 连接超时)、hsreplay.net(`/meta/` 纯前端渲染、`/api/v1/*` 全 404)、api.firestoneapp.com(403)、hearthstonetopdecks / vicioussyndicate / hearthpwn(403)、tempostorm(维护中)、NGA(403)、旅法师营地的 api 路径(404)。

> **开发中(默认关闭)**:搬屎功能(随机一搬 = 屎视频源库随机发封面截图;精选一搬 = 规则粗筛 + AI 精筛评论截图)代码在 `agent/shitpost/`,monitor 已接线但需 env `SHIT_ENABLED=1` 才启用,默认不上线。

## 系统组成

| 组件 | 位置 | 说明 |
|---|---|---|
| SnowLuma (OneBot 后端) | `tools/snowluma/` | QQ 协议层,HTTP 端口 3000 / WS 端口 3001 |
| 监控终端(一体化) | `agent/monitor.mjs` | WS 收 @ → 写 inbox → 分流处理(史记/查卡/每日一卡/框神语录/AI 闲聊) → 发送;15s 兜底轮询、断线补收(2 分钟窗)、心跳自愈 |
| 卡牌查询模块 | `agent/ygocard/ygocard.mjs` | 纯本地卡库查询(14,260 张) |
| 炉石模块 | `agent/hs/hs.mjs` | 炉石卡库(36,022 条/可收集 8,170)/检索/卡图按需缓存/**卡组代码解码器**;CLI `--selftest / --update-cards / --deck <代码>` |
| 炉石环境数据 | `agent/hs/hs_meta.mjs` | 环境热门构筑(Firestone 主源 + 两级兜底)、按职业/体系查询、使用率换算;CLI `--refresh / --stats / <查询>` |
| 炉石卡组入库 | `agent/hs/hs_meta_refresh.mjs` | 从文章页抠卡组代码入库(解码校验+去重);CLI `<URL…> [--dry]` |
| 分群游戏模式 | `agent/modes.mjs` | `agent/modes.json`(群号→ygo/hs),monitor 与 opsweb 共用;CLI 无参看表、`<群号> [模式]` 读/写 |
| 框神语录模块 | `agent/kuangshen/kuangshen.mjs` | 语录库(quotes.json)+ 历史回填 + 实时采集 + 精筛 + 随机抽取;CLI 自测 `node kuangshen.mjs [--backfill|--dump|--dump-raw]` |
| AI 闲聊消息解析 | `agent/aichat/aichat.mjs` | @/引用/QQ 表情/图片 → 模型读得懂的正文(**图片默认直传,一轮出结果**;`describe` 模式为两轮识别 → 拼回正文);CLI 自测 `node aichat.mjs [--selftest|--image|--render]` |
| AI 闲聊提示词 | `agent/aichat/tone.mjs` | 人设 + 三档位(板正/熟人群聊/放开)文案与 `tone.json` 读写;**唯一出处**,opsweb 只 import 它;CLI 自测 `node tone.mjs --selftest` |
| AI 闲聊联网 | `agent/aichat/websearch.mjs` | `web_search` 工具定义 + 本地搜索执行(智谱 Web Search / Tavily / 博查 / Bing 兜底),结果带日期与链接;CLI 自测 `node websearch.mjs --selftest "查询词"` |
| AI 闲聊自检 | `agent/monitor.mjs --aichat-selftest [--mock\|--live]` | 离线查配置与提示词 / `--mock` 不花钱验联网循环 / `--live` 真调模型 |
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
| **游戏模式(按群)** | 每个群一行、两个按钮(游戏王 / 炉石),点一下就切 —— 直接读写 `agent/modes.json`(**不走 tmux 按键**,monitor 每次用到时现读,所以即时生效),与群里发「mode 炉石 / mode 游戏王」完全等价。默认游戏王 |
| **AI 闲聊 · 提示词档位** | 三个档位(板正 / 熟人群聊 / 放开)一行一个按钮,显示当前档与改动时间。走 `/api/tone` **直接写 `agent/aichat/tone.json`**(同样不走 tmux 按键:monitor 每次回复前重读文件),点了**下一条回复就按新档说话** |
| **AI 闲聊 · 联网** | 显示联网开关、当前搜索源、今天与累计搜索次数(成功/失败)。数据由 monitor 写在 `agent/search_stats.json`(不入库)。换源或关联网要改 `agent/.env` 后重启 monitor |
| 服务 | 看 5 个服务(xvfb/SnowLuma/QQ/monitor/opsweb)运行与自启状态,可单独重启 |
| 账号 | QQ 昵称与 UIN、OneBot 两个端口是否在听 |
| **AI 闲聊 · 各用户次数** | 横向条形图、次数降序,标签是「名字（QQ号）」。口径:**以回复实际发给了哪个 @用户为准**(冷却跳过与失败不计入次数,失败单独标出);数据由 monitor 写在 `agent/aichat_stats.json`(不入库),页面每 5 秒随之刷新。历史可用 `node monitor.mjs --backfill-aichat-stats [YYYY-MM-DD]` 回填(默认自 2026-09-13,即 AI 闲聊上线日) |
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

能干什么:看状态 / 切搬屎·框神语录·AI 闲聊开关 / **切 AI 闲聊提示词档位、看联网源与搜索次数** / 重启服务 / 更新卡库 / 看 QQ 截图 / 看日志。

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
    ├── opsweb.mjs         # 运维 WebUI(看状态 / 切开关 / 切分群游戏模式 / 重启服务)
    ├── modes.mjs          # 分群游戏模式(群号→游戏王/炉石),monitor 与 opsweb 共用
    ├── .env               # token 等敏感配置(不入库)
    ├── features.json      # 功能开关持久化(不入库)
    ├── modes.json         # 分群游戏模式持久化(不入库)
    ├── daily_card.json    # 游戏王每日一卡当日状态(不入库)
    ├── hs_daily_card.json # 炉石每日一卡当日状态(不入库)
    ├── search_stats.json  # 联网搜索次数记账(不入库)
    ├── inbox.jsonl        # @请求 队列(不入库)
    ├── processed.jsonl    # 已处理记录(不入库)
    ├── aichat/            # AI 闲聊:@/引用/表情/图片→正文、提示词档位、联网搜索工具、表情 id 名称表
    │   ├── aichat.mjs         # 消息解析(@/引用/表情/图片 → 正文;自测 --selftest)
    │   ├── tone.mjs           # 提示词 + 三档位(板正/熟人群聊/放开)与 tone.json 读写(自测 --selftest)
    │   ├── tone.json          # 当前档位(不入库;运维台「提示词档位」卡片写它)
    │   ├── websearch.mjs      # 联网搜索工具(智谱 Web Search / Tavily / 博查 / Bing 兜底;自测 --selftest)
    │   └── qq_faces.json      # QQ 表情 id → 名称表
    ├── env.mjs            # 加载 .env(必须第一个 import,见文件内注释)
    ├── hs/                # 炉石:卡库 / 检索 / 卡图 / 卡组代码 / 环境推荐
    │   ├── hs.mjs             # 卡库+检索+卡图+deckstring 解码(自测 --selftest)
    │   ├── hs_meta.mjs        # 环境热门构筑(Firestone + 兜底)、使用率换算
    │   ├── hs_meta_refresh.mjs# 从文章页抠卡组代码入库
    │   ├── data/              # cards.zhCN.json(9.6MB)/ hs_meta.json(不入库)
    │   └── cards_img/         # 炉石卡图按需缓存(不入库)
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
- **功能开关热控**(`agent/features.json` 不入库):三档副功能总开关(搬屎/框神语录/AI 闲聊),控制台即时切换免重启,原子写持久化。**monitor 控制台按键**:`1`/`2`/`3` = 切搬屎/框神语录/AI 闲聊总开关,`h` = 重画面板,`u` = 更新卡库,`q` = 退出,`Q` = 退出+停 SnowLuma。**服务器上也可用运维 WebUI 切**(见上文,它切的就是同一套按键,所以两条路径的状态天然一致)。首次运行时以 env 初值(`SHIT_ENABLED`/`KUANGSHEN_ENABLED`/`AI_CHAT_ENABLED`)建文件,**之后以文件为准,改 env 不再生效**(删文件即重置回 env 初值);**运行中直接改 `features.json` 文件不生效**,要走按键或 WebUI。AI 闲聊还有一个例外:**没配聊天 key(`DEEPSEEK_API_KEY` 或 `AI_CHAT_API_KEY`)时启动即强制关闭**,配了 key 再开才有效。
- **AI 闲聊后端(2026-09-21 只剩一套)**:OpenAI 兼容 `/chat/completions`。`DEEPSEEK_API_KEY`(或 `AI_CHAT_API_KEY`)、`AI_CHAT_API_URL`(默认 `https://api.deepseek.com/chat/completions`)、`AI_CHAT_MODEL`(默认 `deepseek-flash`;注意「关思考」是按模型名判断的 —— 只有名字里带 deepseek 才自动塞 `reasoning_effort`)/ `AI_CHAT_REASONING`(deepseek 系**默认关思考**:实测 `reasoning_effort='low'` 会把 max_tokens 全烧在思考上、**正文返回空**,想开思考设 `1`)/ `AI_CHAT_MAX_TOKENS`(上限,默认 800)/ `AI_CHAT_CTX`(附带上下文条数,默认 10,0=不带)/ `AI_CHAT_TIMEOUT_MS`(默认 30000)/ `AI_CHAT_COOLDOWN_MS`(每人冷却,**默认 15000;设 `0` = 彻底关掉冷却**,2026-09-21 用户选了 0 —— 关掉后没有节流:同一个人连点几下就会真调几次模型、联网时真搜几次;想恢复改成毫秒数即可,不用动代码,但改的是启动期常量,**必须重启 monitor 才生效**)/ `AI_CHAT_MAX_CHARS`(回复截断字数,默认 400)/ `AI_CHAT_ENABLED`(首启初值)。**`AI_CHAT_PROVIDER` 与 `GLM_*` 已废弃**(旧的「智谱聊天后端」2026-09-21 删掉了;`ZHIPU_API_KEY` 仍要留着,它现在只服务两件事:**联网搜索**的默认源,以及 `describe` 识图那条老路)。**参数退让**:碰到 4xx 时按「去掉联网工具 → 联网+带思考 → 带上思考 → 去掉图片」依次退让重试,**超时/网络错不重试**(重来一轮只会让群友多等一倍)。
- **AI 闲聊提示词档位(2026-09-21)**:`AI_CHAT_TONE`(`strict` 板正 / `loose` 熟人群聊 / `wild` 放开)**只在首次建 `agent/aichat/tone.json` 时作初值**,之后以文件为准 —— 平时不用改 env,直接在**运维台「AI 闲聊 · 提示词档位」卡片**上点(即时生效,monitor 每次回复前重读该文件)。档位文字与说明的唯一出处是 `agent/aichat/tone.mjs`。
- **AI 闲聊联网搜索(2026-09-21 改成工具调用)**:`AI_CHAT_WEB_SEARCH`(默认开;`0` 关掉)/ `AI_CHAT_MAX_SEARCHES`(单次回复最多搜几次,默认 2,到顶摘掉工具)/ `SEARCH_PROVIDER`(`zhipu` | `tavily` | `bocha` | `bing`;不填则「配了哪家 key 用哪家」,全没有时退到 `bing`)/ `SEARCH_ENGINE`(智谱引擎,默认 `search_std`,要更好质量可设 `search_pro`)/ key:`ZHIPU_API_KEY`(默认源,复用现有的)、`TAVILY_API_KEY`、`BOCHA_API_KEY`;`bing` 零 key 兜底(质量差,**只当应急**)/ `SEARCH_COUNT`(取几条,默认 6;闲聊路径内部还会压到 ≤5)/ `SEARCH_MAX_CHARS`(单条摘要上限,默认 1200)/ `SEARCH_TOTAL_CHARS`(喂回模型的总上限,默认 6000)/ `SEARCH_TIMEOUT_MS`(单家源超时,默认 15000)。自测:`node agent/aichat/websearch.mjs --selftest "查询词"`(会真搜一次)。
- **AI 闲聊自检**:`node monitor.mjs --aichat-selftest`(离线:查后端地址/档位/提示词/联网工具/记账,**不花钱**;没配聊天 key 也能跑)/ `--mock`(**不花钱、不用 key** 验整条联网循环:拦截聊天请求造假响应,喂一个 `web_search` tool_call 进去,验证「要搜 → 真搜 → 结果回填 → 摘掉工具收尾」以及 messages 里 assistant/tool 两条有没有拼对)/ `--live` 真调一次模型(需聊天 key),验证端到端。
- **AI 闲聊·图片**:`AI_CHAT_IMAGE_MODE`(`direct` 直传一轮,默认 | `describe` 两轮识别)/ `AI_CHAT_IMG_SEND_SIDE`(直传时长边上限,默认 1600;实测图片 token 按像素面积分档、≥230 万封顶 ≈995,所以这个值不必调大)/ `AI_CHAT_MAX_IMAGES`(单条消息最多几张,默认 3)。**仅 `describe` 老路生效**:`GLM_VISION_MODEL`(默认 `glm-4v-flash` —— 那条路仍走智谱的**视觉模型**,只有它用 `ZHIPU_API_KEY`;聊天模型与它无关)/ `AI_CHAT_IMG_MAX_SIDE`(宽度限幅,默认 1024)/ `AI_CHAT_IMG_CHUNK_H`(长截图切块高度,默认 800)/ `AI_CHAT_IMG_CHUNKS`(单张最多切几块,默认 3)/ `AI_CHAT_IMG_UP_TRIGGER`(小图判定阈值,默认 800)/ `AI_CHAT_IMG_UP_FACTOR`(小图放大倍数,默认 4)/ `AI_CHAT_IMG_UP_SIDE`(放大后长边封顶,默认 2400)/ `AI_CHAT_IMG_TEXT_MAX`(单张描述+抄字上限,默认 1500 字)/ `AI_CHAT_VISION_TIMEOUT_MS`(默认 30000)。两条路共用:`AI_CHAT_IMG_TIMEOUT_MS`(图片下载超时,默认 15000)/ `FFMPEG_BIN`、`FFPROBE_BIN`(默认 `ffmpeg` / `ffprobe`;没有 ffmpeg 时直传退化成「jpg/png 原样传,大图与 gif/webp 放弃」)/ `QQ_FACE_CATALOG`(表情表路径,默认 `agent/aichat/qq_faces.json`,也可直接指向 SnowLuma 的 `data/sys-face-catalog.json`)。
- **卡图库**:`agent/ygocard/cards_img/` 不入库(约 2GB,14218 张,可重建)。`node agent/ygocard/download_images.mjs` 全量下载/续传(跳过已存在,失败清单 `cards_img/failed.log` 重跑自动重试)。

## 注意事项

- 修改 `agent/.env` / SnowLuma 配置后需重启才生效;功能开关走控制台面板或 `features.json`,即时生效无需重启
- QQ 掉线时:用 `stop.bat`(选 Y)停后端 → 重新打开 QQNT 登录 → `start.bat`
- 机器人只响应**群聊中 @它**的消息(私聊与其他消息不处理);无触发词的 @ 消息交给 **AI 闲聊**兜底接话(可用面板 `3` 键关掉,关掉后恢复为忽略)
- **@+「史记总结」** → 史记体总结(触发词可用环境变量 `TRIGGER_KEYWORD` 覆盖);**@+「效果 」+卡名** → 本地卡牌查询(触发词可用 `CARD_TRIGGER` 覆盖,必须后跟空白);**@+「裁定 」+卡名** → 官方裁定(触发词可用 `RULING_TRIGGER` 覆盖,必须后跟空白);**@+「框神语录」** → 抽一条框神语录(触发词可用 `KUANGSHEN_TRIGGER` 覆盖)
- 卡牌查询支持中/日/英文名与别名(简中官方名、MD 译名等),多关键词空格分隔 AND 匹配
- 回复均 at 触发者
