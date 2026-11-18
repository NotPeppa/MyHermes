# MyHermes 推送桥

自托管推送桥：让 Hermes 的任务完成、后台子代理结果在**手机锁屏时**也能通知到你，而不经过任何第三方推送服务。

```
Hermes 服务器                   你的 VPS                        手机
┌──────────────┐   HMAC    ┌──────────────┐   WebSocket   ┌──────────┐
│ hermes-agent │ ────────▶ │    bridge    │ ────────────▶ │ MyHermes │
│ （本机轮询）  │  HTTPS    │  SQLite 队列  │               │ 本地通知  │
└──────────────┘           └──────────────┘               └──────────┘
```

## 为什么是长连接，不是系统推送

- **FCM** 依赖 Google 服务，国行 ROM 通常没有 GMS，且国内网络不通
- **厂商推送**（魅族/华为/小米…）是系统级通道，App 不运行也能收，但每家要单独申请、绑定包名与签名
- **WebSocket 长连**不依赖任何厂商，代价是 App 进程被杀就断

本桥先实现长连（自托管、零外部依赖）。以后要接厂商通道，只需在桥的发送端加一个 adapter，App 侧不用改。

## 组成

| 文件 | 作用 |
| --- | --- |
| `src/server.mjs` | 桥本体：注册、事件接收、WebSocket 投递、离线补发 |
| `src/store.mjs` | SQLite 持久层（设备、事件、投递记录），用 Node 内置 `node:sqlite` |
| `src/poller.mjs` | 轮询 Hermes、去重、生成事件（单进程与双进程共用）
| `hermes-agent.mjs` | 可选：独立轮询代理（双进程模式才需要） |

## 快速开始（单进程，推荐）

只需要一个进程、一条命令：

```bash
cd bridge && npm install

HERMES_API_KEY=<你的 API_SERVER_KEY> \
HERMES_BASE_URL=http://127.0.0.1:8642 \
SERVER_ID='*' \
node src/server.mjs
```

桥自己会去轮询 Hermes，把「有新回复」推给已注册的设备。**不需要额外部署 agent，也不需要 BRIDGE_SECRET。**

用 Docker 更省事：

```bash
cp .env.example .env    # 填 HERMES_API_KEY
docker compose up -d
```

反代只需要转发一个路径（WebSocket 记得透传 Upgrade）：

```nginx
location /push/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

App 里填 `https://你的域名/push`。

## 双进程模式（可选）

只有不想把 Hermes Key 放进桥进程时才需要。

### 1. 起桥（在你的 VPS 上）

```bash
cd bridge
npm install
BRIDGE_SECRET=$(openssl rand -hex 32) DB_PATH=./bridge.db PORT=8787 node src/server.mjs
```

建议放在 Caddy/nginx 后面走 TLS——WebSocket 的密钥走 query 参数，必须加密传输。

### 2. 起 Hermes 侧代理（在 Hermes 主机上）

```bash
cd bridge
HERMES_BASE_URL=http://127.0.0.1:8642 \
API_SERVER_KEY=<你的 API_SERVER_KEY> \
BRIDGE_URL=https://bridge.example.com \
BRIDGE_SECRET=<与桥相同的 secret> \
SERVER_ID='*' \
node hermes-agent.mjs
```

`SERVER_ID='*'` 表示广播给所有已注册设备；多实例部署时两边填同一个标识（如 `shanghai`）以隔离。

systemd 单元示例：

```ini
[Unit]
Description=MyHermes push agent
After=network-online.target

[Service]
WorkingDirectory=/opt/myhermes/bridge
Environment=HERMES_BASE_URL=http://127.0.0.1:8642
Environment=API_SERVER_KEY=...
Environment=BRIDGE_URL=https://bridge.example.com
Environment=BRIDGE_SECRET=...
Environment=SERVER_ID=*
ExecStart=/usr/bin/node hermes-agent.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

### 3. 在 App 里启用

设置 → 通知 → 填桥地址 → 打开开关。App 会：

1. 申请通知权限
2. `POST /register` 拿设备 id 与一次性密钥（密钥存 SecureStore）
3. 连 `GET /ws`，收到事件就发本地通知
4. 点通知 → 直接进对应会话

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/register` | 设备注册，返回 `{deviceId, secret}`；同 id 重复注册会轮换密钥 |
| `DELETE` | `/register/{deviceId}` | 撤销设备（`Authorization: Bearer <secret>`） |
| `POST` | `/events` | Hermes 侧推送事件，需 `X-Bridge-Timestamp` + `X-Bridge-Signature` |
| `GET` | `/events?deviceId=&secret=` | 轮询兜底，返回并消费未投递事件 |
| `GET` | `/ws?deviceId=&secret=` | WebSocket，首帧 `hello`（含离线补发），之后 `event` |
| `GET` | `/health` | `{ok, connected, devices, events, pending}` |

事件形状（**不含任务正文**）：

```json
{ "eventId": "*:sess_1:msg_2", "serverId": "*", "sessionId": "sess_1",
  "sessionTitle": "磁盘检查", "state": "completed", "ts": 1763390340000 }
```

`preview` 字段只有 agent 显式开启 `INCLUDE_PREVIEW=1` 时才会出现，默认关闭（设计文档 §14.2：通知不携带原文）。

## 安全

- 桥**不持有** Hermes 的 API Key；Key 只在 Hermes 主机上的 agent 里
- Hermes → 桥用 HMAC-SHA256 + 5 分钟时间窗，防重放
- 设备密钥一次性、可撤销；撤销后在线连接立即断开
- 事件按 `eventId` 幂等去重，重复投递不会重复通知
- 桥的日志只记设备 id 与状态码，不记事件正文

## 测试

```bash
cd bridge && npm test
```

覆盖：注册、签名校验（缺失/错误/过期）、在线投递、幂等、离线补发、轮询兜底、错误密钥握手失败、撤销后断连、实例隔离、广播、轮询去重与内容指纹。

## 已知限制

- App 进程被杀后长连接断开，收不到通知——这是长连方案的固有代价
- 没有厂商通道时，需要把 App 加入系统「后台运行白名单」以减少被清理
- 单实例部署用 `SERVER_ID=*`；多实例必须两边对齐标识，否则事件投不到设备
