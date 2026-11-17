import { buildUrl, validateBaseUrl } from './urls';
import { HermesError, type HermesErrorCode } from '../domain/errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ErrorKind = 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limit' | 'unavailable' | 'http' | 'network' | 'tls' | 'timeout' | 'cancelled' | 'protocol';
export class ProtocolError extends HermesError {
  constructor(public kind: ErrorKind, message: string, status?: number, retryAfter?: string) {
    const code = ({ auth: 'unauthorized', rate_limit: 'rate_limited', http: 'protocol' } as const)[kind as 'auth' | 'rate_limit' | 'http'] ?? kind as HermesErrorCode;
    super(code, message, status, retryAfter);
  }
}
const labels: Partial<Record<number, [ErrorKind, string]>> = {
  401: ['auth', '鉴权失败，请检查此 Profile 的密钥'], 403: ['forbidden', '服务器禁止此操作'], 404: ['not_found', '接口或任务不存在'],
  409: ['conflict', '服务器状态已变化，请刷新核对'], 429: ['rate_limit', '请求过多，请稍后重试'], 503: ['unavailable', '服务器繁忙或正在关闭'],
};
export interface RequestOptions { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; query?: Record<string, string | number | boolean | undefined> }
export class Transport {
  readonly baseUrl: string;
  constructor(baseUrl: string, private key: string, private fetcher?: FetchLike, allowHttp = false) { this.baseUrl = validateBaseUrl(baseUrl, { allowHttp }); }
  async request<T>(path: string, options: RequestOptions = {}, consume?: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs ?? 30_000);
    try {
      const fetcher = this.fetcher ?? (await import('expo/fetch')).fetch as unknown as FetchLike;
      const response = await fetcher(buildUrl(this.baseUrl, path, options.query), {
        method: options.method ?? 'GET', body: options.body, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers, Authorization: `Bearer ${this.key}` },
      });
      if (response.redirected) throw new ProtocolError('protocol', '服务器重定向已阻止');
      if (!response.ok) {
        const [kind, message] = labels[response.status] ?? ['http', `服务器返回 HTTP ${response.status}`];
        throw new ProtocolError(kind, message, response.status, response.headers.get('Retry-After') ?? undefined);
      }
      if (consume) return await consume(response, controller.signal);
      if (response.status === 204) return undefined as T;
      try { return await response.json() as T; } catch { throw new ProtocolError('protocol', '服务器响应不是有效 JSON'); }
    } catch (error) {
      if (timedOut) throw new ProtocolError('timeout', '请求超时，提交结果可能尚未确认');
      if (controller.signal.aborted) throw new ProtocolError('cancelled', '请求已取消');
      if (error instanceof ProtocolError) throw error;
      // Never include fetch error text: native errors can contain URLs, headers or credentials.
      const tls = error instanceof Error && /certificate|ssl|tls/i.test(error.message);
      throw new ProtocolError(tls ? 'tls' : 'network', tls ? 'TLS 证书验证失败' : '网络连接中断');
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
}
