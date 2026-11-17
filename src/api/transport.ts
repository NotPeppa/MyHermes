import { buildUrl, validateBaseUrl } from './urls';
import { HermesError, type HermesErrorCode } from '../domain/errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ErrorKind = 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limit' | 'unavailable' | 'request' | 'server' | 'http' | 'network' | 'tls' | 'timeout' | 'cancelled' | 'protocol';
export class ProtocolError extends HermesError {
  constructor(public kind: ErrorKind, message: string, status?: number, retryAfter?: string) {
    const mapped = ({
      auth: 'unauthorized', rate_limit: 'rate_limited', http: 'protocol', request: 'protocol', server: 'server_error',
    } as const)[kind as 'auth' | 'rate_limit' | 'http' | 'request' | 'server'];
    const code = mapped ?? kind as HermesErrorCode;
    super(code, message, status, retryAfter);
  }
}
const labels: Partial<Record<number, [ErrorKind, string]>> = {
  400: ['request', '请求参数被服务器拒绝'], 401: ['auth', '鉴权失败，请检查此 Profile 的密钥'],
  403: ['forbidden', '服务器禁止此操作'], 404: ['not_found', '接口或任务不存在'],
  405: ['request', '该接口不接受此请求方法'], 409: ['conflict', '服务器状态已变化，请刷新核对'],
  415: ['request', '服务器不接受此内容类型'], 429: ['rate_limit', '请求过多，请稍后重试'],
  500: ['server', '服务器内部错误'], 502: ['server', '网关错误（上游返回异常）'],
  503: ['unavailable', '服务器繁忙或正在关闭'], 504: ['server', '网关超时'],
};
/** 读取服务端错误体里的可读信息（Hermes 用 {"error":{"message":...}}），截断且不含凭据。 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown; detail?: unknown };
    const candidate = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    return typeof candidate === 'string' ? candidate.slice(0, 200) : '';
  } catch {
    return '';
  }
}
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
        // 带上方法与相对路径（不含主机与凭据），否则用户无法判断是哪个接口失败
        const where = `${options.method ?? 'GET'} ${path} → HTTP ${response.status}`;
        const serverMessage = await readErrorMessage(response);
        // 服务端给了具体原因就用它，避免「服务器内部错误：服务器内部错误：…」这种重复
        throw new ProtocolError(
          kind,
          `${serverMessage || message}（${where}）`,
          response.status,
          response.headers.get('Retry-After') ?? undefined,
        );
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
