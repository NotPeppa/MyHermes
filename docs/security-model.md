# 安全模型

## 威胁与对策

| 威胁 | 对策 |
| --- | --- |
| 服务器地址伪装骗取 Key | 连接前显著展示域名；TLS 校验失败直接拒绝，不提供“忽略证书” |
| HTTPS 降级 | 默认仅 HTTPS；仅开发构建可显式开启私网/回环 HTTP，并带高风险警示 |
| Key 泄漏到日志/备份/崩溃报告 | Key 只存 SecureStore；SQLite 仅存 `credential_ref`；日志与诊断报告脱敏 |
| 跨域重定向带走认证头 | 请求使用 `redirect: 'error'`，认证头不随跳转转发 |
| URL 注入 | 拒绝 `file:`/`javascript:`/`data:`、userinfo、fragment；Key 不进 query |
| 工具输出含敏感信息 | 预览默认折叠、截断、定期清理；复制时提示可能含敏感数据 |
| 设备丢失 | 依赖系统解锁与文件保护；SQLite 未启用 SQLCipher（首版明确限制） |
| 恶意 Markdown 链接 | 只打开 http/https，且不在应用内自动执行 |

## 密钥生命周期

1. 连接保存：先写 SecureStore，再写 SQLite 元数据；任一步失败则回滚并提示。
2. 编辑：地址或 Profile 变更视为新连接身份，旧缓存不并入。
3. 轮换 Key：更新 SecureStore 后重新探测能力；不确定提交不再自动重试。
4. 删除实例：同一事务删除该 `server_id` 的缓存，并把 `credential_ref` 写入待删队列；删除失败保留队列并重试。

## 权限边界

API Key 可能授权终端与文件工具。手机端的“允许一次”只是回应服务端已创建的 `pending_controls`，不替代服务端审批策略；服务端仍需自行限制工具能力与网络暴露面。

## 本地数据

- 敏感数据：SQLite 中的会话正文、`request_body_json`、工具预览。
- 用户可清除缓存；清除不影响服务器数据。
- 诊断报告复制前移除 Authorization、请求正文、会话文本、工具原始输出与设备标识。
