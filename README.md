# whale-bot

基于 [AI Companion Kit](https://github.com/pinganbbOvO/ai-companion-kit) 的 `packages/companion` 修改的 QQ AI 机器人，通过 OneBot 11 连接 SnowLuma、NapCat 等网关，使用内嵌 Pi SDK 管理 QQ 会话并请求兼容 Chat Completions 的模型接口。

本项目不依赖 DSH，与 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 是不同实现。QQ 客户端和网关需独立安装，不包含在源码仓库内。

## 能力

- 角色卡、按人保存的记忆、对话记录与日记。
- 私聊与群聊唤醒策略、分条发送和发送限速。
- 模型 `remember` 工具调用；图片输入需要模型支持视觉。
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

私聊默认单独使用 `app/role.private.md`（温柔、自然、有一点俏皮），群聊继续使用 `roleCard` 指定的原卡。可通过 `privateRoleCard` 指定私聊卡路径；不配置时使用程序自带卡，主动私聊也采用该语气。固定回答规则同步区分私聊，避免原群聊卡的顶嘴、1~10字限制混入私聊。两张卡不叠加，不迁移历史或记忆；旧历史中的语气不是新私聊的人设要求。Docker 镜像包含默认私聊卡，修改它后需重建镜像；自定义文件需额外挂载。

私聊卡根据本项目的小鲸鱼身份重写，侧重具体场景示例、温和的互动方式与自然的关系边界。编写时参考了 [自然一对一角色提示词的编写方法](https://github.com/Yuimi-chaya/llm-rp-role-prompt-authoring) 的设计讨论，没有导入其 Skill 或第三方恋爱角色卡。

希望采用 qq-bridge 作者的小鲸鱼人格时，可用 `cp app/role.qqbridge.md app/role.md` 替换示例角色卡。这份改编保留上游人格与语气，移除了当前程序不支持的搜索和自主等待操作；没有加入管理员绝对服从、固定黏人或吃醋设定。来源和原始 MIT 声明见 `THIRD_PARTY_NOTICES.md`。

```sh
npm run check
npm start
```

好友申请和群邀请由管理员在手机或桌面 QQ 中手动处理，机器人仅记录申请事件。群聊唤醒设置不等于访问白名单。

## 离线验证

```sh
npm run selftest
```

测试只连接本机模拟服务，使用示例角色卡和临时数据目录，不调用真实模型或 QQ。`npm test` 另行验证会话恢复、隔离、记忆工具和已读水位。

## Pi 上下文与 QQ 工具接入

`engine` 默认 `pi`；设置为 `legacy` 可切回原有直接请求实现。正常 QQ 回合启用 `qq_get_unread_messages`、`qq_get_recent_messages`、`qq_social_state`、`qq_send_message`、`qq_mark_read`，默认再启用三个 `qq_memory_*` 工具；不加载 shell、文件、扩展、MCP 或项目指令。日记和主动消息等 `record=false` 的独立生成继续使用原接口，不写进 Pi 会话；成功主动发出的消息会进入私聊消息状态库。

`dataDir/pi/sessions/` 按 QQ 会话保存历史，`dataDir/conversations/` 保存每会话最近 100 条消息、去重 ID 和已读水位。缓存不是完整的 QQ 历史归档；单条文本截到 4000 字符，未读快照约 12000 字符预算，超出时标注 `partial`，模型可用读取工具继续分页。被缓存淘汰的消息会报告 `droppedBeforeSeq`，不会假装仍有完整记录。

普通 assistant 文字不自动发到 QQ；只有 `qq_send_message` 才发送，字符串一条、数组多条，每轮最多4条，复用拟人化间隔和 Guard 限速。工具绑定当前会话，不接受其他会话 key。相同工具调用 ID 幂等，同轮相同发送内容也不重复执行。部分失败返回已经成功的部分，并禁止本轮盲目重发及确认已读；不保证网络不确定情况下跨进程的 exactly-once 投递。

读取和发言都不自动清空未读。模型最后调用 `qq_mark_read` 并显式提交安全水位，水位不能超过本轮实际展示的连续消息范围；也可以选择不发言直接确认已读。模型没确认就保持未读，不做程序兜底清空。确认后本轮不再允许发送；后到但尚未展示的消息继续未读。水位算法和工具协议改编自 qq-bridge，来源和 MIT 许可见 `THIRD_PARTY_NOTICES.md`。

通过 Pi 的 `finishTurn` 钩子，在显式已读确认成功、同批工具全部执行完成且无错误后直接结束回合，省去额外的模型收尾请求。工具结果照常保存，下一轮仍会恢复；不会伪造一条 assistant 收尾消息。仅发送成功或仅执行读取工具不会提前终止。若模型同批提出“发送 + 确认”且执行成功，可以一轮模型请求完成；分开提出就继续按需请求，不保证每次只调用一次。

固定角色规则进入系统提示；当轮状态、人物记忆和消息快照进入当轮用户上下文。Pi 路径不再自动拼接其他会话的共享对话流。旧人物账本缺少来源范围，因此第一阶段仅在私聊注入，群聊暂不注入；原有账本保留不迁移。

模型调用全局串行，收到的常规聊天回合也串行处理；每轮结束释放 Pi session，只保留共享模型 runtime。失败与超时不会自动重发 QQ 消息。SDK 自动上下文压缩已开启，但尚未完成真实长对话压缩质量验证。示例的 `pi.contextWindow` 是请求预算配置，需按模型供应商能力调整，不是自动探测的上限。

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
