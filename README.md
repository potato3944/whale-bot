# whale-bot

基于 [AI Companion Kit](https://github.com/pinganbbOvO/ai-companion-kit) 的 `packages/companion` 修改的 QQ AI 机器人，通过 OneBot 11 连接 SnowLuma、NapCat 等网关，使用内嵌 Pi SDK 管理 QQ 会话并请求兼容 Chat Completions 的模型接口。

本项目不依赖 DSH，与 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 是不同实现。QQ 客户端和网关需独立安装，不包含在源码仓库内。

## 能力

- 角色卡、按人保存的记忆、对话记录与日记。
- 私聊与群聊唤醒策略、分条发送和发送限速。
- 模型 `remember` 工具调用；图片输入需要模型支持视觉。
- 群聊/私聊可主动联网搜索网络梗、热点和事实，读取公开网页；不建立长期梗词库。
- 可选的主动私聊，示例配置默认关闭。
- 每个私聊/群聊独立的 Pi 会话文件，重启后恢复；近期消息先缓存再判断唤醒。

## 本机运行

需要 Node.js 22.19.0 或更高版本，以及已登录 QQ 的 OneBot 11 网关。

```sh
npm ci
cp app/config.example.json app/config.json
cp app/role.example.md app/role.md
```

编辑 `app/config.json`，填写模型地址、模型名称、API Key、自己的 QQ 号和 OneBot 地址及令牌。

`ownerIds` 配置 owner QQ 号，`ownerNames` 配置对应昵称，例如 `"ownerNames": { "2303463055": "土豆只应天上有" }`。群聊、私聊及主动私聊都会获得平台确认的 owner 身份；只按消息发送者QQ号识别，昵称、自称和聊天记忆不能改写身份。只在群聊中对owner使用温柔、认真配合的态度特例；其他群友保留原来的傲娇、叛逆、嘴硬和顶嘴。所有私聊及主动私聊保持原来的温柔、可爱、自然风格，不按owner身份区别语气。账号关系不自动授予小号owner权限或群聊特例，工具权限不因此增加。

私聊默认单独使用 `app/role.private.md`（对所有私聊对象温柔、自然、有一点俏皮），群聊继续使用 `roleCard` 指定的原卡。可通过 `privateRoleCard` 指定私聊卡路径；不配置时使用程序自带卡，主动私聊也采用该语气。固定回答规则同步区分私聊，避免原群聊卡的顶嘴、1~10字限制混入私聊。两张卡不叠加，不迁移历史或记忆；旧历史中的语气不是新私聊的人设要求。Docker 镜像包含默认私聊卡，修改它后需重建镜像；自定义文件需额外挂载。

私聊卡根据本项目的小鲸鱼身份重写，侧重具体场景示例、温和的互动方式与自然的关系边界。编写时参考了 [自然一对一角色提示词的编写方法](https://github.com/Yuimi-chaya/llm-rp-role-prompt-authoring) 的设计讨论，没有导入其 Skill 或第三方恋爱角色卡。

希望采用 qq-bridge 作者的小鲸鱼人格时，可用 `cp app/role.qqbridge.md app/role.md` 替换示例角色卡。这份改编保留上游人格与语气，联网行为由运行时工具说明提供，移除了当前程序不支持的自主等待操作；没有加入管理员绝对服从、固定黏人或吃醋设定。来源和原始 MIT 声明见 `THIRD_PARTY_NOTICES.md`。

```sh
npm run check
npm start
```

好友申请和群邀请由管理员在手机或桌面 QQ 中手动处理，机器人仅记录申请事件。群聊唤醒设置不等于访问白名单。

## 群聊触发与消息收集

普通群友通过 @机器人或命中 `keywords` 触发，`ownerIds` 中的主人任何发言都触发。
首次触发后等待 6 秒；这期间同群所有人的文字、图片和表情包均进入这一批，保留发送顺序和作者。
普通消息只加入，不改变截止时间；每新增一条触发消息，原截止时间延后 1 秒，
同一条同时命中多个条件也只延长一次。收集从首次触发算起最长 10 秒，不再按 6 条消息提前发送。
这些是收集等待时间，模型生成、排队和发送另需时间。不同群各自计时，私聊沿用原先的合并逻辑。

`wake.groupWindowMs`、`wake.groupExtensionMs`、`wake.groupMaxWindowMs` 分别控制初始等待、
触发延时和最长等待，默认值为 `6000`、`1000`、`10000`。旧的 `groupAtOnly` 和 `probability`
字段仍可读取，但群聊不再据此启用随机插话、名字匹配或问句触发；触发词统一使用 `keywords`。
截止后开始处理本批；生成期间若有新的触发消息，则独立收集下一批。

QQ 小黄脸转为具体名称，例如 `[表情:狗头]`。收藏和转发的图片表情包走图片输入，保留
`summary`、`emoji_id` 等信息，链接失效时可通过合法表情 ID 尝试 QQ 表情 CDN。
GIF 等支持的动画均匀抽取最多 9 帧，按从左到右、从上到下的时间顺序拼图后交给视觉模型。
每批沿用最多 3 张图片附件的限制，超过会明确提示模型未读取；图片下载或解码失败也会提示，
不让模型猜测。是否能识别仍取决于后端模型的视觉能力。

## 联网搜索

默认启用 `web_search` / `web_fetch`，支持 Pi 和 legacy 引擎。用户要求搜索、遇到新梗或实时信息时，模型可主动查询并阅读相关页面，再通过原有 QQ 工具回复。仍遵循原来的唤醒规则，不扫描每条群消息，不维护群内梗词库。普通会话记录仍按原有机制保存。

仅使用 Tavily Search API，固定 `basic` 搜索、关闭自动参数升级，不调用额外的回答模型；中文查询设置中文和中国地区优先。接口说明：[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)。

```json
"web": {
  "enabled": true,
  "provider": "tavily",
  "apiKeyEnv": "TAVILY_API_KEY"
}
```

Key 通过 `TAVILY_API_KEY` 环境变量或本机配置的 `web.apiKey` 提供。`app/config.json` 被 Git 忽略，不要将真实 Key 写入示例配置。搜索凭据不复用聊天中转站的密钥。修改配置后重启 bot 生效，`web.enabled: false` 关闭联网。搜索失败直接报告，不切换其他服务；没有长期群内梗词库。

Tavily 免费方案每月1000 credits，basic每次1 credit；账户额度与收费以[官方说明](https://docs.tavily.com/documentation/api-credits)为准。程序不修改订阅、不自动升级搜索深度。

可用 `npm run search:check` 对六个固定问题做实网检查（会消耗API额度）。结果写入被Git忽略的 `logs/search-check-*.json` / `.md`，记录耗时、来源和用量；不调用聊天模型、不发送QQ消息，不将“返回非空”等同于正确。历史对比报告仍保留于本机日志目录。

每轮最多搜索两次、读取两页，累计网络等待预算 25 秒；搜索缓存五分钟，只保存于进程内。网页不执行脚本、不携带登录 Cookie，正文最多返回 12000 字符，登录页面或动态页面可能无法读取。所有跳转重新校验目标地址，禁止本机/内网访问；针对 TUN 代理返回的 `198.18/15` 合成 DNS 地址，会向固定的 Cloudflare HTTPS DNS 服务复查域名，再校验并固定连接公网 IP。真实内网 DNS 答案不会被此复查放行。

## 离线验证

```sh
npm run selftest
```

测试只连接本机模拟服务，使用示例角色卡和临时数据目录，不调用真实模型或 QQ。`npm test` 另行验证会话恢复、隔离、记忆工具和已读水位。

## 全局账号与人物关系

`globalRelationships` 默认开启，数据位于 `dataDir/relationships.json`。只跨会话共享账号归属、昵称、同学/朋友/同事/亲属等结构化关系；普通私聊原文和本会话记忆不会因为该功能变成全局记忆。叙事日记仍是独立功能，不自动生成。

Pi聊天提供 `qq_relationship_query` / `qq_relationship_upsert` / `qq_relationship_remove`。有明确来源才记录，不从网页、玩笑、假设和转述中认证身份。普通人的关系是自述，大小号对应默认待确认；owner确认的账号对应才参与关联查询。关联只扩大人物关系的检索，不扩大私聊历史、其他本地记忆或owner权限。工具返回的全局数据不包含私聊原文或引用摘录。

已确认关系不能由其他账号改写；普通人只能撤回自己的未确认自述。来源必须是当前会话已展示消息，关系主体由实际发送者确定，不能让模型任意指定别人的QQ。昵称/目标QQ/具体关系需在原话中出现，或明确匹配平台配置的owner昵称；缺少信息先澄清。明显玩笑/假设关键词会阻止写入，模型还会被要求识别矛盾和荒谬内容。这些机制减少误记，但不能保证识别所有谎言，所以自述与已确认状态始终分开。

最多300条有效关系和20条删除归档，普通账号最多保留20条未确认关系；每轮人物关系与会话记忆合计最多4次修改，支持有限版本与删除，避免逐句记流水账。可用 `globalRelationships: false` 关闭共享关系功能。

## Pi 上下文与 QQ 工具接入

`engine` 默认 `pi`；设置为 `legacy` 可切回原有直接请求实现。正常 QQ 回合启用 `qq_get_unread_messages`、`qq_get_recent_messages`、`qq_social_state`、`qq_send_message`、`qq_mark_read`，默认再启用三个 `qq_memory_*` 工具；不加载 shell、文件、扩展、MCP 或项目指令。日记和主动消息等 `record=false` 的独立生成继续使用原接口，不写进 Pi 会话；成功主动发出的消息会进入私聊消息状态库。

`dataDir/pi/sessions/` 按 QQ 会话保存历史，`dataDir/conversations/` 保存每会话最近 100 条消息、去重 ID 和已读水位。缓存不是完整的 QQ 历史归档；单条文本截到 4000 字符，未读快照约 12000 字符预算，超出时标注 `partial`，模型可用读取工具继续分页。被缓存淘汰的消息会报告 `droppedBeforeSeq`，不会假装仍有完整记录。

消息库另存每条消息最多3个图片地址/表情标识引用，随消息淘汰，不把地址加入模型快照或工具文本。群友先独立发图、随后 @ 触发回复时，会从本轮快照已展示的未读消息补取图片，与当前批次去重、按消息顺序合并，每轮仍最多读取3张。不会自动重传已读图片、快照预算外的图片或其他会话的图片。旧缓存只有 `hasImages` 标记，无法恢复未保存的图片地址；QQ 图片地址过期仍可能读取失败。

普通 assistant 文字不自动发到 QQ；只有 `qq_send_message` 才发送，字符串一条、数组多条，每轮最多4条，复用拟人化间隔和 Guard 限速。工具绑定当前会话，不接受其他会话 key。相同工具调用 ID 幂等，同轮相同发送内容也不重复执行。部分失败返回已经成功的部分，并禁止本轮盲目重发及确认已读；不保证网络不确定情况下跨进程的 exactly-once 投递。

读取和发言都不自动清空未读。模型最后调用 `qq_mark_read` 并显式提交安全水位，水位不能超过本轮实际展示的连续消息范围；也可以选择不发言直接确认已读。模型没确认就保持未读，不做程序兜底清空。确认后本轮不再允许发送；后到但尚未展示的消息继续未读。水位算法和工具协议改编自 qq-bridge，来源和 MIT 许可见 `THIRD_PARTY_NOTICES.md`。

通过 Pi 的 `finishTurn` 钩子，在显式已读确认成功、同批工具全部执行完成且无错误后直接结束回合，省去额外的模型收尾请求。工具结果照常保存，下一轮仍会恢复；不会伪造一条 assistant 收尾消息。仅发送成功或仅执行读取工具不会提前终止。若模型同批提出“发送 + 确认”且执行成功，可以一轮模型请求完成；分开提出就继续按需请求，不保证每次只调用一次。

固定角色规则进入系统提示；当轮状态、人物记忆和消息快照进入当轮用户上下文。Pi 路径不再自动拼接其他会话的共享对话流。旧人物账本缺少来源范围，因此第一阶段仅在私聊注入，群聊暂不注入；原有账本保留不迁移。

模型调用全局串行，收到的常规聊天回合也串行处理；每轮结束释放 Pi session，只保留共享模型 runtime。失败与超时不会自动重发 QQ 消息。SDK 自动上下文压缩已开启，但尚未完成真实长对话压缩质量验证。示例的 `pi.contextWindow` 是请求预算配置，需按模型供应商能力调整，不是自动探测的上限。

群聊默认在 Pi 估算的上下文超过 `pi.groupCompactAtTokens`（16384）时提前生成摘要，保留约 `pi.groupKeepRecentTokens`（4096）个 token 的近期原文；旧会话恢复后也使用此策略。原始 JSONL 与结构化记忆不删除，私聊仍沿用原压缩参数。实现保留模型窗口，通过增加 `reserveTokens` 提前压缩；小窗口模型仍至少预留8192个 token，因此实际触发点可能更低。这是压缩触发门槛，并非整次请求的硬上限：人设、工具、当轮输入及摘要仍会占用 token，摘要调用也消耗 token。两个群聊参数须为正整数，近期保留量小于压缩门槛；修改后需重启生效。

当前未接入长时间等待、AI 修改唤醒条件，也未调整云端容器限制。2GB 服务器容量仍需部署前测量，不能根据本机短测试保证。

### 轻量场合记忆

默认 `socialMemory: true`，在 `dataDir/social-memory/` 按私聊/群聊分别保存 JSON；没有新增依赖、向量数据库、本地 embedding 模型或后台整理进程。保留作者的 `activeTopic`、`pendingThought`、`memberImpression` 分类与格式，增加 `fact`、`event`，不依赖其他记忆框架。

模型使用 `qq_memory_upsert` 新增或按 ID 更新、`qq_memory_query` 关键词查询、`qq_memory_remove` 按 ID 删除。新模式不再向模型暴露旧 `remember`，避免两个写入入口重复记账；旧人物账本只在私聊继续提供历史参考，不迁移、不覆盖。新模式也停止将每轮前40字符拼接成旧人物话题，常规对话日志仍保存。设 `socialMemory: false` 可退回原 `remember` 路径，新的记忆文件保留但不再注入。

每条记忆携带真实来源会话、消息序号/ID、发送者、时间和短原文。人物事实只能引用本人已展示的消息；模型仍可能理解错误，来源记录只是便于核查。按 ID 更正保留最近3个旧版本，删除先在有界文件里留删除标记，旧版本不进入自动召回。身份、来源和跨会话限制由代码检查，语义真实性不能仅靠参数校验保证。

每会话最多100条有效记录和20条归档，每条最多300字符；每轮最多4次记忆变更。默认事实不按时间过期（仍受容量上限约束）、经历90天、话题24小时、待说想法2小时、主观印象30天，工具可指定有效小时数。查询即时过滤过期项，不需要定时器。容量淘汰、有限归档不等于永久可恢复历史。

每次自动注入相关/近期记忆及当前话题、想法，总长最多3500字符；查询工具最多20条、6000字符。检索是简单关键词及中文二字片段匹配，没有向量语义召回，对改写和同义词的识别有限。待说想法只在以后被唤醒时提供，不会自动定时发送。不同群之间、群与私聊之间不自动共享这些新记忆；更复杂的跨场合人物资料后续再做。

## Docker 云端运行

```sh
cp .env.example .env
cp app/config.example.json app/config.json
cp app/role.example.md app/role.md
mkdir -p app/data gateway-data/config qq-config qq-data
sudo chown -R 1000:1000 app/data
sudo chown 1000:1000 app/config.json
chmod 600 app/config.json
```

在 `app/config.json` 中填写模型配置，将 `onebot.httpUrl` 设为 `http://snowluma:3000`，`onebot.wsUrl` 设为 `ws://snowluma:3001`。按 [SnowLuma 配置文档](https://snowluma.github.io/zh/docs/guide/configuration)准备 `gateway-data/config/onebot.json`：HTTP 3000 与 WebSocket 3001、消息格式 `array`，两者令牌均与机器人配置一致。

```sh
docker compose up -d --build snowluma
# 完成 QQ 扫码登录后启动机器人
docker compose up -d --build whale-bot
```

默认管理端口仅发布在服务器本机。通过 SSH 隧道访问（`YOUR_SERVER` 换成 SSH 别名）：

```sh
ssh -N -L 16081:127.0.0.1:6081 -L 15099:127.0.0.1:5099 YOUR_SERVER
```

- QQ 桌面：`http://127.0.0.1:16081/`
- SnowLuma 管理界面：`http://127.0.0.1:15099/`

容器自动重启、轮转日志。Compose 为小内存服务器设置了容器内存上限；实际容量应通过运行测试确认。SnowLuma 按官方要求获得容器内 ptrace 权限。

## 用 Git 更新服务器

部署、重启或回滚前须获得用户针对本次操作的明确确认；修改和测试授权不代表上线授权。人设、权限或记忆可见范围变更需先确认方向。

服务器先按上面的结构部署到 `/opt/whale-stack`。本机修改、提交并推送源码：

```sh
git add app/src
git commit -m "Describe the change"
git push
bash scripts/deploy.sh YOUR_SERVER
```

部署脚本传送当前提交的源码快照，通过 SSH 更新服务器，再重建和重启 whale-bot。服务器无需连接 GitHub；SnowLuma 不随机器人代码更新重启。配置、真实角色卡和记忆不在 Git 中，不会被源码快照覆盖。只修改配置或角色卡时，单独同步对应文件并重启 whale-bot。

## 来源与许可

采用 MIT 许可，保留 AI Companion Kit contributors 的原始版权声明。角色、记忆、唤醒、发送及日记等模块来源于该上游 companion 包，并有本地修改；本仓库另有发送限速、主动消息、记忆工具及图片处理等扩展。代码比对无法确定每项改动的最初作者，Git 历史从此仓库建立时开始记录。

网关、QQ 客户端和模型服务各自适用其许可与服务条款。真实 API Key、QQ 登录数据、聊天记录和个人角色卡应保存在仓库之外。
