# whale-bot

基于 [AI Companion Kit](https://github.com/pinganbbOvO/ai-companion-kit) 的 `packages/companion` 修改的 QQ AI 机器人，通过 OneBot 11 连接 SnowLuma、NapCat 等网关，直接请求兼容 Chat Completions 的模型接口。

本项目不依赖 DSH，与 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 是不同实现。QQ 客户端和网关需独立安装，不包含在源码仓库内。

## 能力

- 角色卡、按人保存的记忆、对话记录与日记。
- 私聊与群聊唤醒策略、分条发送和发送限速。
- 模型 `remember` 工具调用；图片输入需要模型支持视觉。
- 可选的主动私聊，示例配置默认关闭。

## 本机运行

需要 Node.js 22 或更高版本，以及已登录 QQ 的 OneBot 11 网关。

```sh
npm ci
cp app/config.example.json app/config.json
cp app/role.example.md app/role.md
```

编辑 `app/config.json`，填写模型地址、模型名称、API Key、自己的 QQ 号和 OneBot 地址及令牌。

```sh
npm run check
npm start
```

注意：当前代码会自动同意好友申请和群邀请；群聊唤醒设置不等于访问白名单。使用前请确认这一行为符合自己的需求。

## 离线验证

```sh
npm run selftest
```

测试只连接本机模拟服务，使用示例角色卡和独立 `data-mock` 目录，不调用真实模型或 QQ。

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
