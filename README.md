# MyHermes

面向 [Nous Research Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) 的原生移动客户端（iOS / Android）。无需微信、Telegram、Discord，直接用手机连自己的 Hermes 实例：流式对话、工具执行进度、会话管理、任务恢复与人工审批。

- 无平台账号，客户端直连，API Key 只存系统安全存储
- 多实例隔离，切换不串会话、缓存与运行记录
- Hermes 是事实来源，本地 SQLite 只做离线缓存与提交账本
- 前台真流式；工具调用可见；断网/锁屏/杀进程后可凭 `run_id` 恢复，不重复执行
- P1：会话标题搜索、会话分支（Fork）、请求级模型选择、图片附件（压缩后上传，仅兼容模式）
- P2：Skills / Toolsets 只读浏览、Jobs 管理（暂停/恢复/立即运行/删除）、工具输出的结构化 diff、本地与服务端的冲突对照
- Android 外部入口：深链 `myhermes://`、长按图标的三个快捷方式、系统分享菜单接收文本/图片

设计基线：[产品需求与技术设计 v1.0](Hermes_Mobile_产品需求与技术设计_v1.0.md)。

## 快速开始

```bash
npm install
npm run mock          # 本地 Hermes mock，默认 127.0.0.1:8642
npm start             # Expo 开发服务器
```

Mock 提供三个 Profile：

| Profile | Key | 行为 |
| --- | --- | --- |
| `/p/alpha` | `key-alpha` | 完整能力：Runs、SSE、工具事件、审批 |
| `/p/beta` | `key-beta` | 同上，独立数据，用于验证实例隔离 |
| `/p/fault` | `key-fault` | 提交返回 503 + `Retry-After`，用于验证限流/繁忙文案 |

在连接页填入 `http://127.0.0.1:8642/p/alpha` 与 `key-alpha`。事件流加 `?fragment=5` 可把每帧切成 5 字节小块，用来人工验证跨块 UTF-8 与分帧解析。模拟器访问本机需用 `10.0.2.2`（Android）或 `localhost`（iOS），并打开「允许私网明文 HTTP」开发开关；该开关只在开发构建出现。

真机调试构建：

```bash
npx expo run:ios
npx expo run:android
```

## 连接自己的 Hermes

服务器侧（`~/.hermes/.env`）：

```ini
API_SERVER_ENABLED=true
API_SERVER_KEY=<高熵随机密钥>
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
```

保留本机监听，通过 TLS 反向代理或自有 WireGuard/Tailscale 访问。反向代理需关闭 SSE 缓冲、放宽读超时，且不要缓存或改写 `/v1/runs/*/events`。API Key 对应的工具权限可能包含终端命令与文件读写，不要把它暴露在公网明文 HTTP 上。

## 目录

```text
app/                      Expo Router 页面（引导、会话、聊天、设置）
src/domain/               类型、状态机契约、错误分类
src/api/                  URL 校验、传输层、能力探测、SSE 解析
src/adapters/hermes/      Runs / Sessions / Chat Completions 适配
src/runtime/              运行服务：提交账本、事件归一化、恢复对账
src/storage/              SQLite 仓储、迁移、SecureStore 密钥库
src/features/             页面逻辑 hooks
src/ui/                   主题、基础组件、Markdown、工具卡片
src/media/                图片校验、缩放与 data URI（原生调用集中在 picker.ts）
src/features/notifications/ 推送桥客户端、重连与本地通知
bridge/                   自托管推送桥（独立 Node 服务，可单独部署）
src/features/jobs|skills/ 任务中心与技能页逻辑
src/ui/diff.ts|diff-view   统一 diff 解析与结构化渲染
scripts/mock-server.ts    本地 mock（可被测试直接启动）
docs/                     协议矩阵、安全模型、发布清单
tests/                    单元、契约与无头渲染测试（node:test + react-test-renderer）
tests/stubs/              渲染测试用的 RN / Expo 替身，仅测试生效
```

## Android 外部入口（Tasker / 快捷方式 / 分享）

深链契约（Tasker、MacroDroid、快捷指令的「打开 URL」都能用）：

| 深链 | 行为 |
| --- | --- |
| `myhermes://send?text=检查磁盘` | 选实例与最近会话，把文本预填进输入框（**不自动发送**） |
| `myhermes://send?text=…&server=<serverId>` | 指定实例；实例不存在时给出可读错误 |
| `myhermes://send?source=clipboard` | 读取剪贴板文本后预填 |
| `myhermes://chat/<serverId>/<sessionId>` | 直接进入某个会话 |
| `myhermes://sessions` / `myhermes://jobs` / `myhermes://settings` | 直达对应页面 |

长按 App 图标有三个静态快捷方式：新建会话、任务中心、发送剪贴板（由 [plugins/withAndroidShortcuts.js](plugins/withAndroidShortcuts.js) 在 prebuild 时生成 `shortcuts.xml`）。

系统分享菜单：从任何 App 分享文本或图片到 MyHermes，会落到同一个入口页——文本预填、图片按现有流程压缩后作为附件，同样不自动发送。

> 分享接收与静态快捷方式需要原生工程，因此要用 `npx expo run:android` 或 dev client；Expo Go 下这些入口不生效（深链仍然可用）。

## 通知（自托管推送桥）

锁屏也能收到任务完成提醒，全程不经过第三方推送服务：

```
Hermes 服务器 ──HMAC──▶ 你的桥（WebSocket）──▶ 手机本地通知
```

```bash
# 1. 在 VPS 上起桥
cd bridge && npm install
BRIDGE_SECRET=$(openssl rand -hex 32) PORT=8787 node src/server.mjs

# 2. 在 Hermes 主机上起事件代理
HERMES_BASE_URL=http://127.0.0.1:8642 API_SERVER_KEY=<key> \
BRIDGE_URL=https://bridge.example.com BRIDGE_SECRET=<同一个 secret> \
SERVER_ID='*' node bridge/hermes-agent.mjs
```

然后在 App 的「设置 → 通知」里填桥地址并打开开关。细节见 [bridge/README.md](bridge/README.md)。

- 桥**不持有** Hermes 的 API Key（Key 只在 Hermes 主机的代理里）
- 通知默认**不含正文**，只有实例、会话与状态；点开才拉取内容
- 长连接的固有代价：App 进程被杀就收不到，需要厂商推送才能做到「锁屏必达」

## 检查

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # node:test：SSE、URL、幂等、隔离、迁移、脱敏 + 页面无头渲染
npm run e2e           # 真实 HTTP mock + 真实 service 端到端自检
npx expo export --platform ios
npx expo export --platform android
```

## 能力与降级

客户端只按 `GET /v1/capabilities` 的 `features` 逐项开关，不按版本号推断。详见 [协议矩阵](docs/protocol-matrix.md)。

- `native_runs`：可恢复、可停止、可审批的任务路径
- `native_sessions`：单轮 SSE 聊天，断流后按历史对账
- `openai_compat`：基础聊天，无恢复与审批保证
- `unsupported`：不发送任务

## 安全

Key 只进 SecureStore（`WHEN_UNLOCKED_THIS_DEVICE_ONLY`），SQLite 只存 `credential_ref`；默认仅 HTTPS，证书无效直接拒绝，不提供忽略证书选项；请求禁止跨域重定向携带认证头；诊断报告复制前脱敏。详见 [安全模型](docs/security-model.md)。

## 首版限制

- 后台不保证持续 SSE；锁屏完成通知需自托管通知桥（未实现）
- 未启用 SQLCipher，本地库依赖系统文件保护
- 图片只在 `openai_compat` 模式可用（官方文档只确认 Chat Completions 的 `image_url`；Runs/Sessions 未声明图片字段，客户端不臆造）
- 不做 App 内语音输入：系统键盘自带的听写已经覆盖「说话→文字→发送」，再包一层原生 STT 只是重复造轮子
- 不支持任意文件上传；会话搜索只查本地缓存
- Jobs 只映射官方文档提到的已知字段（prompt / schedule / paused / 上次运行），未固定字段名的结构一律忽略
- diff 只识别 unified diff 文本；超过 200 行只渲染前 200 行并提示总数
- 不能接管微信/Telegram 等其他入口所属会话（服务端会返回 409）
- 未在真实 Hermes 实例与真机上验收前，不宣称兼容所有版本

## 许可证

见 [LICENSE](LICENSE)。Hermes Agent 是第三方开源项目，本仓库只提供客户端，不包含其服务端代码。
