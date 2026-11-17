import { HermesError, type HermesErrorCode } from '@/domain/errors';

const MESSAGES: Record<HermesErrorCode, string> = {
  unauthorized: '鉴权失败（401）：API Key 无效或已过期',
  forbidden: '无权限（403）：该 Key 不能访问此资源',
  not_found: '资源不存在（404）：检查 Profile 路径或实例地址',
  conflict: '状态已变化（409）：已刷新最新状态，请重新确认',
  rate_limited: '请求过于频繁（429）：请稍后重试',
  unavailable: '服务器不可用（503）：请稍后重试',
  tls: 'TLS 证书校验失败：已拒绝连接，请检查证书与域名',
  network: '网络不可达：检查网络与服务器地址',
  protocol: '响应格式不符合预期：可能是版本或 Profile 不匹配',
  timeout: '请求超时：服务器未在预期时间内响应',
  cancelled: '操作已取消',
};

export function describeError(error: unknown): string {
  if (error instanceof HermesError) {
    const base = MESSAGES[error.code] ?? error.message;
    return error.retryAfter ? `${base}（建议 ${error.retryAfter} 后重试）` : base;
  }
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

export function errorCode(error: unknown): HermesErrorCode | null {
  return error instanceof HermesError ? error.code : null;
}
