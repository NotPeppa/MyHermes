# Hermes Mobile：产品需求与技术设计文档

**版本**：1.0　　**状态**：开发基线　　**日期**：2026-11-17  
**目标平台**：iOS / Android　　**项目属性**：开源、自托管优先、用户自带服务器（BYO Server）

> **文档用途**：本文件同时承担 PRD、技术设计（TDD）和 MVP 验收基线。规范词“必须 / 应 / 可”分别对应强制要求、推荐要求和可选能力。接口以 2026-11-17 查阅的 Hermes Agent 官方 API Server 文档为准；第三方部署可能因版本、配置和 Profile 不同而缺少部分功能，运行时始终以能力探测结果为准。

## 1. 执行摘要

Hermes Mobile 是面向 **Nous Research Hermes Agent** 的原生移动客户端，使用户无需依赖微信、Telegram、Discord 等消息平台，就能在自己的 iPhone 或 Android 手机上与自行部署的 Hermes Agent 流式对话、查看工具执行进度、管理会话、恢复长任务并执行必要的人工审批。

产品采用 **无平台账号、客户端直连、API Key 本机保管、多实例管理** 模型：用户提供服务器 URL 和该实例的 API Key，客户端通过 HTTPS/SSE 直接连接。Hermes 是会话与执行状态的权威数据源；客户端 SQLite 只提供离线缓存和运行关联索引。需要锁屏后及时通知的用户可自行选择通知桥接服务，基础产品不依赖开发者的云服务。

**核心体验承诺**：前台真正流式；工具调用可见；切换网络/锁屏后能安全恢复状态；多服务器数据严格隔离；不上传用户密钥和聊天内容到开发者服务器。

### 1.1 项目目标与指标

| 目标 | 度量与验收标准 |
| --- | --- |
| 降低连接门槛 | 新用户在具有有效 URL / Key 时，90 秒内完成服务器连接并发送第一条消息（可用性测试目标） |
| 流式交互 | 首个 SSE 增量到达后实时呈现；不得把全量响应伪装成逐字输出 |
| 任务可追踪 | 提交成功后持久化 run_id；应用重启后可通过状态接口恢复 |
| 安全 | 不在日志、SQLite、崩溃信息、分享配置中存放明文 API Key |
| 自托管与开放 | 核心聊天功能无需厂商账户与厂商中转服务器 |
| 跨端 | iOS 与 Android 核心能力一致，原生系统差异明示 |

### 1.2 非目标

首版不开发模型推理服务，不托管 Hermes 实例，不接管第三方消息渠道历史会话，不默认提供远程端口穿透，不保证手机后台持续 SSE，不支持凭空把 Hermes 服务器上的终端命令转为手机本机操作，不建设会员或支付系统。不宣称“所有版本 Hermes 都支持相同功能”。

## 2. 用户、使用场景与核心故事

**个人用户**：家中或 VPS 上运行一个 Hermes，通过手机聊天、检查服务器、分析项目、阅读结果。  
**多实例用户**：同时管理“个人”“家庭”“工作”几个独立实例，切换时不混淆记忆、会话及运行。  
**进阶用户**：想看到终端、文件和 Web 工具调用，审批潜在危险动作，查看任务中断与恢复结果。  
**第三方自托管用户**：可以只输入自己的 URL 与 Key，不注册本产品的账号。

典型故事：

1. 作为首次使用者，我希望在一个界面填写 URL / API Key，并得到明确的连接诊断（地址不可达、证书无效、鉴权失败、服务不兼容），而不是一个笼统的“连接失败”。
2. 作为日常用户，我希望收到文字增量、工具开始/完成状态，并能从聊天返回会话列表后再次进入继续查看。
3. 作为任务发起人，我希望关闭 App 后 Hermes 仍在服务器执行，重新打开 App 后看见准确状态，而非自动重复提交任务。
4. 作为管理员，我希望在手机上看到某次工具执行需要审批，明确知道操作详情和“允许一次/拒绝”等选项。
5. 作为多实例用户，我希望每个实例有独立配置和本地缓存，删除某实例时连同密钥、安全地清理该实例的本地索引。

## 3. 产品边界与架构决策

### 3.1 三个关键决策

**D-01　BYO Server 优先**：用户自备 Hermes 服务器地址和该 Profile 对应的 API Key；默认不经过开发者中转。  
**D-02　Server 为事实来源**：Hermes 负责会话、Agent 推理、工具、任务；手机 SQLite 只缓存展示数据与提交关联状态。  
**D-03　Runs 优先，Sessions 配合**：支持 Runs 的实例，优先用 Runs 处理需要可恢复/可审批的任务；用 Sessions API 管理历史与会话；不支持 Runs 时按能力降级，不承诺同等级别的后台恢复。

### 3.2 逻辑架构

```text
┌─────────────────────────────── iOS / Android ────────────────────────────────┐
│ Expo Router UI → ViewModel / Store → Hermes Adapter → HTTP/SSE Transport    │
│                     │                   │                                    │
│             SQLite cache          Capability Matrix                         │
│                     │                   │                                    │
│            SecureStore (only API keys + secret references)                 │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ HTTPS + Bearer + SSE
                   ┌────────────┴─────────────┐
                   │ 用户的 HTTPS 反向代理或 VPN │
                   └────────────┬─────────────┘
                   ┌────────────┴─────────────┐
                   │ Hermes API Server        │
                   │ Sessions / Runs / Tools  │
                   │ Model / Skills / Memory  │
                   └──────────────────────────┘

可选（非 MVP 依赖）：Hermes 事件监听器 → 自托管通知桥接 → APNs/FCM → 手机
```

### 3.3 实例与 Profile

“服务器连接”实体由 `scheme + host + port + basePath/profilePrefix` 唯一标识，并拥有客户端生成的 `serverId`。Hermes 多 Profile 路由可以使用 `/p/<profile>/...`，且各 Profile 必须使用自己的 `API_SERVER_KEY`；客户端不可偷偷使用另一个 Profile 的密钥。Profile 前缀属于连接配置，不应在调用处硬编码。所有路径由一套 URL Builder 统一拼接，禁止因尾部斜杠丢失 `/p/...` 前缀。

## 4. 范围、优先级与里程碑

| 模块 | MVP / P0 | P1 | P2 |
| --- | --- | --- | --- |
| 连接 | URL、Key、测试、编辑/删除、实例切换 | QR 导入不含密钥 / 迁移 | 局域网发现（明确授权） |
| 聊天 | 文本、SSE、Markdown/代码、停止、错误处理 | 图片与附件预览 | 多模态扩展 |
| 会话 | 列表、创建、历史、重命名/删除（按能力） | Fork、搜索 | 同步冲突可视化 |
| Agent | 工具开始/完成、Run 状态恢复 | 审批/澄清、模型选择 | Skills、Jobs 管理 |
| 终端 | 工具输出安全展示 | 复制输出、结果折叠 | 结构化文件 diff |
| 移动体验 | 安全存储、深浅色、基础无障碍 | 语音输入、相册、分享 | Widget、快捷指令 |
| 通知 | App 前台状态 | 可选自托管推送桥 | 可选托管推送 |
| 质量 | 单元/集成/真机冒烟 | E2E 与压力测试 | 全面兼容性矩阵 |

**建议 MVP 工期**：单人熟悉 TypeScript/React Native 并使用 AI 辅助，约 2–3 周；公开发布所需安全与兼容性完善约再增加 3–5 周。这是估算，不包含 Hermes 上游变更、App Store 审核、推送基础设施成本。

## 5. 信息架构与页面说明

### 5.1 页面树

```text
启动 / 解锁
├─ 首次使用 / 添加连接
│  ├─ URL、Key、连接名称
│  └─ 验证状态 / 故障指导
├─ 主界面
│  ├─ 会话列表 + 服务器切换
│  ├─ 聊天详情
│  │  ├─ 文本、Markdown、代码块
│  │  ├─ 工具执行卡片
│  │  ├─ Run 状态 / 停止 / 重试
│  │  └─ 审批、澄清弹层
│  ├─ 任务中心（P1）
│  └─ 设置
│     ├─ 服务器管理
│     ├─ 连接诊断
│     ├─ 隐私和本地数据
│     └─ 关于 / 开源许可证
```

### 5.2 连接页交互规范

字段：`连接名称`（必填或自动生成）、`服务器 URL`（必填）、`API Key`（必填）、`高级：Profile 路径`（可选，需与 URL 设计统一）、`连接诊断`。URL 解析后禁止用户名/密码、fragment；不允许把 Key 放入 URL Query；默认仅 HTTPS（测试环境/私有网 HTTP 需用户主动打开高级选项并看到明确警示，正式公开分发版宜严格限制）。

连接诊断分层：① URL 与 TLS 校验；② `GET /v1/capabilities`；③ Bearer 鉴权；④ 读取 `/api/sessions` 或 `/v1/models` 验证可用 API；⑤ 保存非敏感元数据、Key 写 SecureStore。能力不存在时标注具体不可用项。连接失败时不能保存“连接成功”状态。按钮触发的操作均应支持取消与超时。

### 5.3 聊天详情页

消息展示区按服务器权威的会话顺序排列。前台流式增量以独立的 `draftMessage` 展示，收到最终终态及历史同步后去重合并；工具卡片独立记录工具生命周期，不把工具日志混入 Assistant 正文。长按消息：复制、选择文本、重新加载（不能直接重复危险命令）、查看执行详情。发送按钮、停止按钮互斥，网络失败时展示明确“可能已提交”状态。

### 5.4 状态文案

| 内部状态 | 中文呈现 |
| --- | --- |
| `idle` | 可发送消息 |
| `submitting` | 正在提交… |
| `queued` | 已排队 |
| `running` | Hermes 正在执行… |
| `waiting_for_approval` | 等待操作审批 |
| `waiting_for_clarification` | 等待补充信息 |
| `stopping` | 正在停止… |
| `completed` | 已完成 |
| `failed` | 执行失败 |
| `cancelled` | 已取消 |
| `interrupted` | 服务重启，任务中断 |
| `unknown` | 执行结果不确定，需要人工核对 |
| `offline`（仅客户端） | 连接中断，等待恢复 |

状态应基于服务端响应映射；未知上游状态保留原值并显示通用状态，不能擅自标为“已完成”。

## 6. Hermes 服务器部署与接入前置条件

用户的 Hermes 必须启用 API Server，配置强随机 `API_SERVER_KEY`。官方默认监听为 `127.0.0.1:8642`，推荐保留本机监听，再通过 TLS 反向代理或用户自有 WireGuard/Tailscale 等私有网络访问。**不能建议公开暴露无鉴权或明文 HTTP 的 Hermes API**：API Key 对应的工具权限可能包括执行终端命令和文件读写。

```ini
# Hermes 服务器 ~/.hermes/.env（示例）
API_SERVER_ENABLED=true
API_SERVER_KEY=<由服务器管理员生成的高熵随机密钥>
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
```

示例测试命令：

```bash
curl -fsS https://hermes.example.com/v1/capabilities -H 'Authorization: Bearer <YOUR_KEY>'
```

只有在自有设备连接时才使用实际 Key；不将密钥发送到任何在线诊断网站。反向代理需关闭 SSE 缓冲、设置适当长连接读超时，不对 `/v1/runs/*/events` 缓存、改写事件或注入压缩层异常。具体代理配置以部署环境检验为准。

## 7. API 能力探测与协议适配

### 7.1 连接检测矩阵

首次连接、手动重新检测、服务器版本变化后刷新 `GET /v1/capabilities`，解析 `features` / `endpoints`，缓存时间建议 15 分钟，接口 404 时允许尝试 `/v1/models` 的低功能降级。`/v1/models` 是 OpenAI 兼容的代理模型名发现接口，不是 Hermes 所有 Provider/Model 的详细清单；模型选择需使用 `GET /api/model/options`（可用时）。

定义客户端模式：

- `native_runs`：具备 `run_submission`、`run_status`、`run_events_sse`，支持可追踪任务；额外单独探测 `run_stop`、`run_approval`、`run_unknown_resolution` 等。
- `native_sessions`：具备 Sessions 列表、消息、SSE 单轮接口。可实现基本聊天/历史，但 POST 流断后是否可独立恢复须依据 run id 和可用 Runs 能力判断。
- `openai_compat`：有 `/v1/chat/completions`，可实现基础聊天 SSE；无法保证审批、持久化和重新连接恢复。
- `unsupported`：API 不能验证或协议未知；不继续发送任务。

**模式不是互斥 API 层级**：正常版本可同时支持 Sessions 与 Runs，UI 应组合使用。

### 7.2 API 清单（已由官方文档确认）

| 用途 | 端点 | 说明 |
| --- | --- | --- |
| 能力发现 | `GET /v1/capabilities` | 特性与端点存在性 |
| 模型基础列表 | `GET /v1/models` | OpenAI 兼容模型标识 |
| 模型扩展选择 | `GET /api/model/options` | Provider、模型、能力和价格提示 |
| Sessions | `GET/POST /api/sessions` | 列出 / 创建 |
| Sessions | `GET/PATCH/DELETE /api/sessions/{id}` | 读取 / 更名或更新 / 删除 |
| 历史 | `GET /api/sessions/{id}/messages` | 支持 `inline_images=false` 等参数 |
| 会话分支 | `POST /api/sessions/{id}/fork` | 分支会话 |
| 会话聊天 | `POST /api/sessions/{id}/chat/stream` | 单次 POST SSE |
| Runs | `POST /v1/runs` | 创建 run；支持幂等键 |
| Runs | `GET /v1/runs/{id}` | 查询状态 |
| Runs | `GET /v1/runs/{id}/events` | 订阅 SSE |
| Runs | `POST /v1/runs/{id}/stop` | 请求停止 |
| 人工确认 | `POST /v1/runs/{id}/approval` | 回应审批 |
| 澄清 | `POST /v1/runs/{id}/clarify` | 回应补充问题 |
| 异常恢复 | `POST /v1/runs/{id}/resolve-unknown` | 仅支持时显示，必须谨慎确认 |
| 兼容聊天 | `POST /v1/chat/completions` | OpenAI 式流式/非流式 |
| Skills | `GET /v1/skills`, `GET /v1/toolsets` | 只读技能与工具集 |
| Jobs | `/api/jobs` 等 | P2 定时/后台任务管理 |

### 7.3 重要限制：会话所有权

Hermes API Server 创建/拥有的会话不能直接绑定微信、Telegram、CLI/TUI/Desktop 等其他入口拥有的会话。向 Runs 提交另一个入口所属的 `session_id` 可能返回 HTTP 409 `permission_denied`。**MVP 不实现旧消息渠道历史“无缝接管”**。需要跨表面附加到正在使用的外部会话时，必须单独研究 Gateway WebSocket（例如 `prompt.submit`），列为独立研究项目而不是假设可用。

## 8. 任务提交、流式读取与恢复策略

### 8.1 推荐主路径（Runs + Sessions）

1. 选择已验证 `serverId`，读取 `apiBaseUrl` 与其 Key；确认所选 `sessionId` 属于同一个 `serverId`。
2. UI 先在 SQLite 生成本地 `clientTurnId`、随机 `Idempotency-Key` 和 `submitting` 占位项；在真正 POST 之前提交事务。
3. `POST /v1/runs`，请求体至少包含 `input`，如需续聊携带当前 API session 的 `session_id`；不要同时随意提交过期 `conversation_history`，否则会覆盖服务端历史优先级。
4. 获取 `run_id` 后立即关联并持久化；更新 `active_run`。不明网络失败时，使用**相同键和相同原始请求体**尝试安全重试，禁止生成新 Key 自动再发一次。
5. 连接 `GET /v1/runs/{run_id}/events`，增量呈现文本和工具；在前台维持接收。
6. 发生断线、App 休眠或进程重启：先 `GET /v1/runs/{run_id}` 判断状态，必要时再次订阅事件并从会话历史/最终 `output` 做权威对账。
7. 仅当状态 API 或终止事件确认 `completed` 后标记任务成功；`cancelled`、`failed`、`interrupted`、`unknown` 分别处理。

请求样例（字段以官方基本格式为准）：

```http
POST /v1/runs HTTP/1.1
Authorization: Bearer <KEY>
Content-Type: application/json
Idempotency-Key: 7def5f43-1f0e-43f5-9d6c-2ba9720a82bd

{"input":"检查当前服务器磁盘使用情况","session_id":"api-session-id"}
```

```json
{"run_id":"run_abc123","status":"started"}
```

### 8.2 幂等与重复提交规则

官方 Runs 的 `Idempotency-Key` 要求 1–255 个可见 ASCII 字符；相同 Key、相同负载的重试返回原 `run_id`（可带 `Idempotency-Replayed`），修改负载返回 `409 idempotency_key_conflict`。记录通常在**最后一次状态更新后保留 24 小时**，不能把它当成永不失效的全局 exactly-once 保证。客户端应持久化提交时的原始请求 JSON、key、创建时间和 serverId；状态不明不能用新 Key 自动“重试”，需要提示用户检查服务器状态。

### 8.3 SSE 协议设计

解析器必须支持 `event:`、`data:`、`id:`、`retry:`、空行帧分割、多行 data、UTF-8 分片、`\r\n` 和 `[DONE]` 等差异；以 `:` 开头的 keepalive 注释必须忽略，不能当作 token。Hermes 约每 10 秒可发送 SSE keepalive。解析后统一映射为客户端事件，保留 `rawEventType`、`runId`、`timestamp`，对未知事件仅日志计数（不记录原始敏感正文）。

| 事件类 | UI 行为 | 处理要点 |
| --- | --- | --- |
| `message.delta` / `assistant.delta` | 追加正文增量 | 分渠道适配，避免重复追加 |
| `message.interim` / `assistant.commentary` | 显示中途说明 | `already_streamed=true` 不重复显示 |
| `tool.started` | 新增/更新工具卡片 | 展示工具名与参数摘要，不默认展开敏感参数 |
| `tool.completed` / `tool.failed` | 标记工具结果 | 工具失败不等同整个 Run 失败 |
| `subagent.start` / `subagent.complete` | 子 Agent 进度 | P1 支持，保持父子关联 |
| `approval.request` / 澄清事件 | 打开待处理卡片 | 从状态接口获取权威 prompt identity |
| `run.completed` | 展示最终结果 | 对账服务端状态和 `output`，避免依赖纯 delta |
| `run.failed` / `run.cancelled` / `run.interrupted` | 终态区别展示 | 保留诊断信息，允许安全重新发起新任务 |

**事件去重**：如果接口提供稳定事件 `id`，以 `(serverId, runId, id)` 去重；没有则不要假设重新连接能从精确 token 偏移继续，改用最终 `output` / `GET /api/sessions/{id}/messages` 对账替换草稿。不得仅靠累计文本长度做精确去重。

### 8.4 客户端运行状态机

```text
idle → submitting → queued/running → completed
           │            ├→ waiting_for_approval → running
           │            ├→ waiting_for_clarification → running
           │            ├→ stopping → cancelled
           │            ├→ failed
           │            ├→ interrupted
           │            └→ unknown → 人工确认 / resolve-unknown（可用时）
           └→ submission_uncertain → 同键重试 / 状态核对

独立的 UI 网络状态：connected / reconnecting / offline
```

网络状态不应覆盖 Run 状态，断网不等于任务停止。并发同会话写入由服务端序列化，客户端仍应防止同一会话重复点击发送；允许不同会话并行，单实例并发限额导致的 429/503 需显示提示。

### 8.5 停止、审批、澄清与 unknown

- **停止**：调用 `POST /v1/runs/{id}/stop` 后进入 `stopping`，只有服务端确认 `cancelled` 才显示已取消；“停止请求已发送”不等同工具进程已经退出。
- **审批**：仅在能力旗标支持时提供。canonical owner 下以 `GET /v1/runs/{id}` 的 `pending_controls` 为准，提交 `request_id`、`execution_generation`、`choice`，例如 `once`/`deny`；遇到 409 表示请求过期/不匹配，刷新待处理项，不能盲目重试。
- **澄清**：`POST /v1/runs/{id}/clarify` 使用相同身份字段并附 `answer`；这不是另一个聊天推理请求。
- **unknown**：若 owner 重启造成执行结果不确定，绝不可标成失败后自动重跑。只有支持 `run_unknown_resolution` 时，且用户理解“确认丢失执行不会再完成”的含义，才可凭权威 `admission_id`、`execution_generation` 调用 `resolve-unknown`，否则提供核对与联系服务器管理员的指引。

## 9. 会话与历史同步

会话创建使用 `POST /api/sessions`，列表用分页 `limit/offset`；UI 先展示本地缓存再后台刷新。读取历史优先 `GET /api/sessions/{id}/messages?inline_images=false`，仅当用户主动查看图片才加载可用图像数据，避免移动网络传输大段 data URI。按服务端顺序与稳定消息身份（若有）对齐；上游消息结构未保证稳定 ID 时，客户端在适配层建立保守的内容/序号辅助映射，但**不作为跨版本的永久消息 ID**。

删除会话需二次确认，区分“仅清理本地缓存”和“从 Hermes 服务器删除”。后者操作成功后更新服务器列表；失败保持原内容。更名使用 `PATCH /api/sessions/{id}`。Fork 为 P1；默认不跨服务器搬迁历史，避免会话所有权误用。与微信/Telegram 的独立会话不合并。

## 10. 数据模型与本地持久化

原则：SQLite 存非敏感索引和用户可见缓存；密钥只存 SecureStore，SQLite 用 `credential_ref` 引用。任何表都用 `server_id` 隔离；定期清理已过期 SSE 临时缓存。SQLCipher 加密可做 P1 强化，但不能假定默认 Expo SQLite 已加密：必须在目标构建中主动启用并验证 cipher_version。

```sql
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  profile_path TEXT,
  capabilities_json TEXT,
  capabilities_checked_at INTEGER,
  last_connected_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  server_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT,
  updated_at INTEGER,
  snapshot_json TEXT,
  PRIMARY KEY (server_id, session_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  server_message_id TEXT,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_session ON messages(server_id, session_id, created_at);
CREATE TABLE runs (
  run_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  session_id TEXT,
  client_turn_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_body_json TEXT NOT NULL,
  status TEXT NOT NULL,
  final_output TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, run_id)
);
CREATE TABLE outbound_turns (
  client_turn_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  session_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_body_json TEXT NOT NULL,
  run_id TEXT,
  submission_state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE tool_events (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_name TEXT,
  event_type TEXT NOT NULL,
  preview TEXT,
  recorded_at INTEGER NOT NULL
);
```

`request_body_json` 只允许已清洗的任务输入，可能包含私人对话正文，因此 SQLite 本身属敏感数据，必须依赖系统文件保护并允许用户清空；生产版应评估 SQLCipher 和解锁策略。不要把高权限工具原始命令、环境变量或完整输出无限期保存在 `tool_events`。删除服务器时同一事务删除相关缓存，并异步删除 SecureStore 中的对应 Key；若删除 Key 失败应提示且重试。

## 11. 客户端模块、目录与技术栈

**选型**：React Native + Expo + TypeScript + Expo Router；`expo/fetch` 读取流，`expo-secure-store` 保管 Key，`expo-sqlite` 保存缓存；状态管理可用 Zustand；网络缓存可用 TanStack Query，但 SSE / Run 状态维护应由独立服务层掌控，避免将大段增量放入通用 Query 缓存。

```text
hermes-mobile/
├── app/
│   ├── (onboarding)/add-server.tsx
│   ├── (main)/sessions/index.tsx
│   ├── (main)/chat/[serverId]/[sessionId].tsx
│   ├── (main)/runs/index.tsx
│   ├── settings/servers.tsx
│   └── _layout.tsx
├── src/
│   ├── domain/ (models, events, status-machine, errors)
│   ├── api/ (transport, urls, auth, capability-probe)
│   ├── adapters/hermes/ (sessions, runs, chat-compat, event-normalizer)
│   ├── features/ (onboarding, chat, sessions, approvals, settings)
│   ├── storage/ (sqlite, migrations, credential-vault)
│   ├── runtime/ (submission-ledger, run-reconciler, stream-controller)
│   ├── ui/ (message, tool-card, markdown, dialogs)
│   └── security/ (redaction, transport-policy)
├── tests/ (unit, contract, e2e)
└── docs/ (protocol-matrix, security-model, release-checklist)
```

**架构规范**：UI 不直接拼接 URL，不直接读取 SecureStore，不直接解析 SSE；所有 Hermes 异构事件必须先归一化，再输入领域状态机。网络请求必须支持 `AbortController`、时间限制和异常分类。每个连接使用独立的 transport context；服务器切换时取消视图订阅，但不能在无用户确认下停止服务器上的 Run。

## 12. 关键类型与伪代码

```ts
type ServerId = string;
type HermesMode = 'native_runs' | 'native_sessions' | 'openai_compat' | 'unsupported';
type RunState = 'submitting' | 'queued' | 'running' | 'waiting_for_approval'
  | 'waiting_for_clarification' | 'stopping' | 'completed' | 'failed'
  | 'cancelled' | 'interrupted' | 'unknown' | 'submission_uncertain';

type ServerConnection = {
  id: ServerId;
  name: string;
  baseUrl: string;        // 已验证的完整 API 根，例如带 /p/team 前缀
  credentialRef: string;  // 非密钥本身
  capabilities?: Record<string, unknown>;
};

type AgentEvent =
  | { kind: 'text_delta'; runId: string; text: string }
  | { kind: 'commentary'; runId: string; text: string; alreadyStreamed?: boolean }
  | { kind: 'tool_started'; runId: string; tool: string; preview?: string }
  | { kind: 'tool_finished'; runId: string; tool: string; failed: boolean; preview?: string }
  | { kind: 'terminal'; runId: string; state: RunState; output?: string }
  | { kind: 'unknown'; runId: string; eventName: string };
```

`expo/fetch` 支持流式读取，推荐以 `TextDecoder` 的流式模式处理 UTF-8 片段。以下仅是**传输层骨架**，实际 SSE parser 必须实现前述多行、换行、注释和事件去重规则；不能直接按每次 `reader.read()` 当作一条事件。

```ts
import { fetch } from 'expo/fetch';

async function consumeEvents(url: string, key: string, signal: AbortSignal,
  onChunk: (text: string) => void) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
    onChunk(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
```

**安全实现提醒**：示例的 `key` 只能在受控服务层短时存在，不应进入组件 props、全局 Redux devtools、错误日志或持久化网络记录。`response` 的 401、403、404、409、429、503 和 TLS/网络异常应分别映射到明确 UI 文案。

## 13. 认证、网络与隐私安全

### 13.1 威胁模型

威胁包括：服务器地址伪装诱导泄露 Key、恶意/失陷的逆向代理、HTTPS 降级、终端输出中包含访问令牌、设备丢失、截屏/剪贴板泄露、调试日志外泄、过宽反向代理权限、恶意 Markdown 链接与任意 deep link 触发敏感动作。客户端无法保护用户主动输入到恶意服务器的密钥，必须在连接前显著展示域名与证书问题。

### 13.2 强制控制

1. **Key 隔离**：SecureStore 每实例一条；不进入 SQLite、URL、analytics、崩溃报告；删除服务器后删除 Key。
2. **TLS**：HTTPS 默认强制；证书无效直接拒绝；禁止“忽略证书错误”。开发测试 HTTP 需要明确的本地构建或显式高风险开关，不能悄悄启用。
3. **URL 校验**：禁止 `file:`, `javascript:`, `data:` 等 Scheme；禁止 URL userinfo，规范化端口与路径；控制 redirect，不将 Authorization 头转发到跨域跳转目标。
4. **最小数据收集**：无产品账户，无远程遥测默认开启；本地错误日志脱敏，不上传消息正文或工具输出。
5. **敏感预览**：终端和工具预览默认折叠；复制功能明确指示可能包含敏感数据；禁止在锁屏通知展示完整聊天正文。
6. **本地保护**：手机系统解锁和可选应用锁；SQLite 缓存遵循用户清除/禁用缓存设置；系统备份策略需限制密钥和高敏缓存迁移风险。
7. **导入/导出**：二维码和分享链接默认只包含 server URL、显示名，不包含 API Key；若后续支持含 Key 的导入则必须另设加密与二次确认流程。

### 13.3 SSRF 与远程连接策略

客户端直连用户指定 URL 属于用户端目标连接，并不是传统服务器端 SSRF；但仍需限制不受信任链接的自动跳转，禁止把携带 Key 的请求转发给非原始 Origin。若 P2 增加厂商云中转 / 通知桥：**桥接端会新增 SSRF 面**，必须校验目标地址、解析后的 IP 范围与 DNS 重绑定、跳转、端口、TLS，不允许未经授权扫描内网地址；桥接默认不需要知道 Hermes API Key。

### 13.4 权限与高危操作

API Key 实际上可能授权 Hermes 运行终端及文件工具。手机端不能通过“确认”按钮替代服务端审批策略。客户端所有批准只回应服务器已经创建的 `pending_controls`，并保留当前身份字段及状态校验。服务端需要独立限制工具能力、命令执行范围与暴露的网络入口。

## 14. 断线、后台任务与通知

### 14.1 纯直连默认行为

前台通过 SSE 展示进度；App 切后台或锁屏后，系统可能暂停/终止 JS 及网络连接。Hermes 任务本身在服务器继续运行（前提是上游任务被独立接收并正常执行）；App 恢复前台时，先调用 status，再恢复订阅与历史对账。**不保证锁屏时持续连接，也不保证仅靠客户端能实现实时完成通知。**

### 14.2 可选通知桥（P2）

```text
Hermes 服务器本地事件监听进程
    └─ 最小状态消息 (serverAlias, runId, state, time)
         └─ 用户自托管 Notification Bridge
              ├─ APNs → iOS
              └─ FCM  → Android
```

推送桥独立开源，默认不持有 Hermes 管理 Key；最好部署在用户服务器同侧，从本地 Unix socket/受控读取接口接收事件，而非让云桥主动登录任意 Hermes。移动端的 Push Token 在桥接端注册，支持撤销、轮换与多设备；通知 Payload 不携带任务输入、原文、工具输出、Key。用户首次开通需告知 APNs/FCM 本身是第三方通知通道。推送点开后仍需凭手机客户端 Key 向 Hermes 拉权威状态。

### 14.3 失败与恢复

- 断网：显示离线，保留 run_id，指数退避恢复；勿重新 POST 新 run。
- 身份过期 / 401：标记“需重新授权”，不泄漏旧 Key；不要无限尝试。
- 404 run：可能过期、Profile 错误或实例不同；先核对当前 serverId/profile，再查历史；不能当作 run 成功。
- 409：显示“状态已变化/冲突”，拉取新的状态与 pending_controls，避免自动重试高危操作。
- 503 + `Retry-After`：服务器繁忙或 draining，遵循重试建议；重试必须沿用原幂等身份。
- 500/解析失败：保留已保存的 run_id，提示诊断，支持导出脱敏问题报告。

## 15. 图片、文件、语音与模型选择

**图片（P1）**：官方确认 Chat Completions 支持文本与 `image_url` 数组形式（HTTPS URL 或 `data:image`），Sessions chat/stream 也支持内联图片。移动端应对图片先做尺寸、格式、大小、EXIF 元数据处理；禁止未经用户确认上传相册原图和定位信息。各接口负载格式应在 adapter 中分别实现并做契约测试。

**一般文件（P2）**：不能假定 `/v1/chat/completions` 支持任意文件上传。官方明确该端点对 `file` / `input_file` / `file_id` 及非图片 data URI 返回 `400 unsupported_content_type`。若需要 PDF、ZIP、项目文件，必须先核验 Hermes 可用的独立上传/资源能力，或明确设计额外自托管文件桥，不能把“分享文件”按钮连到虚构 API。

**语音（P1）**：优先本机系统语音转写为文本后再走当前聊天 API；音频上传/语音对话需要单独验证 Hermes 后端模型和协议。麦克风权限、录音保存、云转写开关由用户显式控制。

**模型选择（P1）**：`GET /api/model/options` 列出详细选项；`POST /v1/runs` 与 Sessions chat 支持请求级 `model`/`provider`/`model_options`。旧版或 OpenAI Chat Completions 的“仅 model 不含 provider”可能回退到默认模型，UI 必须显示实际运行结果或配置限制，不能保证选择了一定生效。

## 16. 兼容性与可观察性

### 16.1 兼容性策略

维护 `capability-contract.json` 和按版本录制的脱敏事件 Fixture。禁止通过“版本号大于 X”直接推导 API 一定存在；上游自定义分支也可能力不同。能力探测若只返回一部分字段，应按每项可用标志单独开关 UI。对未知 SSE 事件容错记录类型和次数。遇到 profile 路径独立 Key，连接编辑流程需要区分原始服务端 URL 和当前 Profile。

### 16.2 诊断页面

只展示：服务器脱敏域名、连接状态、HTTP 状态码、客户端版本、模式（Runs/Sessions/Compat）、功能旗标、最近一次成功检测时间、请求耗时区间。复制诊断报告前必须自动移除 URL userinfo、Authorization、请求正文、会话文本、原始工具输出与设备标识。

### 16.3 性能目标（非上游 SLA）

消息列表 2000 条以内滚动流畅（分页/虚拟列表）；单 run SSE 更新节流至 30–60fps 内合理批量渲染；页面退出后不泄漏 reader 与 listener；缓存大小可配置并支持一键清除。以低端 Android 真机 + 最近两代 iPhone 真机组合回归。

## 17. 测试策略与验收清单

| 类别 | 必测场景 | 通过标准 |
| --- | --- | --- |
| 连接 | 正确 URL/Key、401、TLS 无效、Profile Key 不匹配 | 明确提示，绝不泄漏 Key |
| SSE | 分片 UTF-8、多行 data、空行、keepalive、未知 event | 不丢字节、不把注释显示为正文 |
| Runs | 正常完成、工具失败、Run 失败、用户停止、Gateway 关闭 | 各终态准确，停止不提前宣告成功 |
| 恢复 | 发送中切网络、锁屏、杀进程、重启 App | 通过已保存 run_id/status 恢复，不重复提交 |
| 幂等 | 首次 POST 后丢失响应、相同 Key 重试、改动 body 重试 | 原 run 不重复执行；冲突显式提示 |
| 审批 | 当前 prompt、过期 generation、重复批准、拒绝 | 正确选择和身份校验，409 后刷新 |
| 会话 | 新建、历史、分页、改名、删除、跨服务器同 ID | 不串数据，不将 foreign session 当当前会话 |
| 兼容 | 仅 Chat Completions、缺少 Sessions/Runs | 功能降级而非崩溃；说明限制 |
| 安全 | 本地备份、日志、剪贴板、二维码、重定向 | Key 不泄漏，无跨域转发 |
| 无障碍 | 动态字体、VoiceOver/TalkBack、对比度 | 关键交互可操作 |
| 发布 | iOS/Android Release 真机包 | 首次启动、升级迁移、权限与隐私声明正常 |

### 17.1 MVP 定义完成（Definition of Done）

用户可添加至少 3 个 Hermes 实例；同一设备实例切换不串数据；有效 Key 可连接；可查看/新建 API 会话并发送文本；SSE 正确流式展示与工具卡片；能停止支持该功能的 Run；App 退出后恢复 Run 状态；失败有可理解反馈；Key 仅存安全存储；至少覆盖 iPhone 与 Android 真机端到端冒烟；关键业务与解析器有自动测试；完整 README/隐私说明/许可证随仓发布。

## 18. 工程路线图与任务拆分

### Sprint 0 — 工程底座（2–3 天）

建立 Expo/TypeScript 工程、CI、Lint/Format、导航、主题、SQLite migration、SecureStore Wrapper、HTTP 客户端、错误分类、Hermes Mock Server、开发环境文档。产出：可安装调试包与模拟连接页。

### Sprint 1 — 连接与会话（3–5 天）

完成连接表单、TLS / Auth 测试、Capabilities 发现、Profile 路径、实例列表、删除/切换、Sessions 列表/历史/创建、缓存刷新、手动诊断。产出：能浏览真实服务器数据。

### Sprint 2 — 流式对话与 Runs（4–7 天）

完成发送 ledger、Runs POST+Idempotency-Key、状态轮询、SSE Parser、text/tool/interim/terminal 适配、Markdown、停止、断线恢复与历史对账。产出：达到 MVP 的 Agent 交互能力。

### Sprint 3 — 审批与稳定性（3–5 天）

审批/澄清、unknown 流程、压力/弱网/关进程测试、错误文案、无障碍、诊断脱敏、公开仓库文档。产出：Beta 版本。

### Sprint 4 — 多模态与发布（持续迭代）

图片、模型选择、语音、兼容性矩阵、应用商店素材与隐私披露、Crash Reports 脱敏；通知桥作为独立仓库发布，避免主 App 与桥接服务强耦合。

## 19. 发布、开源与运维

建议使用 GitHub 托管源代码、Issues、Roadmap、CHANGELOG、Contributing、SECURITY.md、隐私政策。开源许可证在确定所引入依赖及是否包含上游代码后选择（如 Apache-2.0 或 MIT，须做许可证检查），不要在未核验 Hermes 上游许可证时宣称可重分发其代码。App 中注明 Hermes 是第三方开源 Agent，引导用户自行部署，避免误以为本客户端提供服务器或推理服务。

版本发布采用 SemVer，CI 至少执行 TypeScript typecheck、Lint、unit、API fixture contract tests；EAS Build 生成 iOS/Android 测试包，真机通过后才进入 TestFlight / Play 内测。更新需包含 SQLite schema migration、配置备份恢复检验和回滚说明。密钥不得写入 CI 构建产物；商店审核账号、应用签名与 Push 证书放独立 secrets 管理。

## 20. 主要风险与待确认决策

| 风险 | 影响 | 缓解 / 决策 |
| --- | --- | --- |
| Hermes 版本 API 分歧 | 部分功能不可用 | Capabilities + 适配层 + Fixture 测试 |
| 服务器地址暴露导致 Key 被盗 | 完整 Agent 控制权泄漏 | HTTPS、SecureStore、权限分层、无中转 |
| 移动系统后台断链 | 无法持续显示进度 | Runs 状态拉取 + App 恢复，不做虚假后台承诺 |
| 运行事件保留窗口有限 | 断线后增量丢失 | 最终状态 / 会话历史对账 |
| 不同入口会话所有权 | 微信历史不能直接接管 | 明确隔离；Gateway WS 另立项目 |
| 审批过期或误触 | 不安全命令执行 | 服务端身份校验 + UI 二次确认 |
| 文件上传协议缺口 | PDF/ZIP 无法直接发 | 先验证上游，之后设计独立可选桥 |
| 用户将 Hermes 暴露公网 | 被扫描与尝试窃取 | 自托管部署安全指导，建议反向代理/VPN |
| SQLCipher / 安全存储行为差异 | 本地私密信息风险 | Release 构建实测，允许清除本地历史 |
| 推送基础设施的隐私与成本 | 公共服务风险 | 不作为核心功能依赖，先做自托管桥 |

**需在开发前确定的少量问题**：项目正式名称与包 ID；最低 iOS/Android 系统版本；是否允许用户明确开启 HTTP 局域网模式；是否要求从首版启用本地数据库加密；是否希望 App Store / Google Play 正式上架。这些不影响按本文 MVP 骨架启动开发。

## 21. 附录：安全的交付验收演示

演示应使用两个用户自建 Hermes 实例 A/B（密钥不同）：

1. 添加 A，成功发现 Capabilities；添加 B，使用不同 Profile 地址/密钥；A/B 都能创建会话。
2. 在 A 发出“读取当前工作目录信息”，观察文字 SSE、工具开始、工具完成、最终状态；返回列表再进入，内容一致。
3. 网络中断 15 秒后恢复，确认未重复执行命令；如果无法恢复流，能够使用 Runs 状态/历史得出正确结果。
4. 在 A 触发需要审批的工具（服务器预先配置安全的演示审批策略），确认“拒绝”与“允许一次”分支，旧 prompt identity 不能再次批准。
5. 切换 B，验证不会出现 A 的会话、缓存与 Run；删除 B 后不再持有 B 的密钥引用。
6. 启用模拟服务端失败、503、409、401，确认各有明确状态，并能导出不包含 Key/消息正文的诊断报告。
7. 杀死 App 后重新打开，恢复活跃 Run；观察终态与历史一致。锁屏推送不属于纯直连模式的 MVP 验收项。

## 22. 参考资料与核验口径

1. Hermes Agent — API Server（官方）：https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server  
   覆盖 API Server 部署、Bearer 鉴权、Sessions、Runs、Capabilities、模型选择、Jobs、审批/澄清、Profile 路由与会话所有权。
2. Expo — Fetch / Streaming（官方）：https://docs.expo.dev/versions/latest/sdk/expo/  
   覆盖 `expo/fetch` 的流式 `response.body.getReader()`。
3. Expo — SecureStore（官方）：https://docs.expo.dev/versions/latest/sdk/securestore/  
   覆盖 iOS Keychain/Android 安全存储行为、限制与系统差异。
4. Expo — SQLite（官方）：https://docs.expo.dev/versions/latest/sdk/sqlite/  
   覆盖持久化、参数化 SQL、SQLCipher 编译开关与验证。

**核验说明**：本文中标注为“官方确认”的 Hermes HTTP API 基于 2026-11-17 当日查看的官方文档。诸如通知桥、客户端 SQLite schema、工程目录、SSE 事件归一化、性能指标和 Sprint 安排均属于**本项目建议设计**，不是 Hermes 原生承诺。实际编码时需要使用目标 Hermes 版本做一次接口契约测试，并把响应 Fixture 固化进测试仓库。
