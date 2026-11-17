# 协议矩阵

客户端不按版本号推断能力，只按 `GET /v1/capabilities` 的 `features` 逐项开关；探测结果缓存 15 分钟，404 时降级探测 `/v1/models` 与 Sessions。

| 能力旗标 | 客户端行为 | 缺失时 |
| --- | --- | --- |
| `run_submission` + `run_status` + `run_events_sse` | 使用 Runs 主路径，可恢复任务 | 降级到 Sessions 单轮流或 Chat Completions |
| `run_stop` | 显示停止按钮 | 隐藏停止，仅提示在服务器侧处理 |
| `run_approval` | 展示审批卡片，提交 `request_id` + `execution_generation` + `choice` | 不展示审批入口 |
| `run_clarify` | 展示澄清输入框 | 不展示澄清入口 |
| `run_unknown_resolution` | 二次确认后调用 `resolve-unknown` | 仅展示核对指引 |
| `sessions` | 会话列表、历史、更名、删除 | 仅本地缓存视图 |
| `session_fork` | 长按菜单显示「分支会话」 | 隐藏分支入口 |
| `model_options` | 聊天页显示模型选择 chip，按请求下发 `model`/`provider` | 不显示模型入口，使用服务器默认模型 |
| `chat_completions` | Compat 模式单轮流，无恢复保证 | 模式判定为 `unsupported` |

## 端点使用

| 用途 | 端点 | 备注 |
| --- | --- | --- |
| 能力 | `GET /v1/capabilities` | 权威能力来源 |
| 会话 | `GET/POST /api/sessions` | 分页 `limit/offset` |
| 历史 | `GET /api/sessions/{id}/messages?inline_images=false` | 不拉取内联图片 |
| 提交 | `POST /v1/runs` | 必带 `Idempotency-Key` |
| 状态 | `GET /v1/runs/{id}` | 恢复时的权威状态与 `pending_controls` |
| 事件 | `GET /v1/runs/{id}/events` | SSE，10 秒 keepalive 注释 |
| 停止 | `POST /v1/runs/{id}/stop` | 只有服务端确认才显示已取消 |
| 审批/澄清 | `POST /v1/runs/{id}/approval`、`/clarify` | 409 表示身份过期，需刷新 |
| 兼容 | `POST /v1/chat/completions` | OpenAI 格式，无幂等保证 |
| 分支 | `POST /api/sessions/{id}/fork` | P1，需 `session_fork` |
| 模型 | `GET /api/model/options` | P1，需 `model_options`；结果扁平化为 provider+model |

## SSE 归一化

解析器支持跨块 UTF-8、`\r\n`、多行 `data:`、`event:`/`id:`/`retry:`、空行分帧、`:` 注释与 `[DONE]`。事件映射：

| 上游事件 | 客户端事件 |
| --- | --- |
| `message.delta` / `assistant.delta` | `text_delta` |
| `message.interim` / `assistant.commentary` | `commentary` |
| `tool.started` | `tool_started` |
| `tool.completed` / `tool.failed` | `tool_finished` |
| `approval.request` / 澄清 | `control` |
| `run.completed` / `run.failed` / `run.cancelled` / `run.interrupted` | `terminal` |
| 其他 | `unknown`（仅计数，不记录正文） |

有稳定事件 `id` 时按 `(serverId, runId, id)` 去重；否则重连后重建草稿，以最终 `output` 或会话历史对账，不按文本长度猜测。

## P1 行为说明

- **会话搜索**：只在本地缓存内按标题做大小写不敏感匹配，不发网络请求；空查询恢复全量。服务端搜索接口未在官方文档确认，因此不臆造参数。
- **会话分支**：成功后新会话写入缓存并刷新列表；服务器对非自有会话会返回 404/409，客户端原样提示。
- **模型选择**：`GET /api/model/options` 结构不认识时返回空数组而不是报错；选中后只在**后续发送**时带 `model`/`provider`，不改变已提交任务的账本，也不保证服务器一定采用（上游可能回退默认模型）。

## 图片输入（P1）

官方文档只确认两处图片负载，客户端严格按此实现，不臆造字段：

| 模式 | 负载 | 状态 |
| --- | --- | --- |
| `openai_compat` | `messages[].content` 为 `text` + `image_url`（`data:image/jpeg;base64,...`）数组 | 已实现 |
| `native_sessions` | 文档称 chat/stream 支持内联图片，但未给出字段名 | 不发送图片，仅文字 |
| `native_runs` | 文档只描述 `input` 字符串 | 不发送图片，仅文字 |

客户端处理：相册选择 → 长边限制 1568px → JPEG 重编码（丢弃 EXIF/定位）→ 单张 ≤3MB、最多 4 张 → data URI。非图片 `data:` 会被服务器以 `400 unsupported_content_type` 拒绝，客户端在本地先拦。

会话单轮字段按官方示例使用 `input`（不是 `message`）。

## 幂等与恢复

- 提交前事务写入 `clientTurnId`、原始请求 JSON、幂等 Key。
- 响应丢失进入 `submission_uncertain`：只允许相同 Key + 相同 body 重试，服务端返回 `Idempotency-Replayed` 视为同一次执行。
- 修改 body 或换 Key 可能重复执行，客户端不自动这么做。
- 恢复顺序：持久化 run → `GET /v1/runs/{id}` → 必要时订阅事件 → 历史/最终 output 对账。
