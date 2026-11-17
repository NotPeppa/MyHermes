import { HermesError } from '../domain/errors';

export interface UrlPolicy { allowHttp?: boolean }

function privateHost(host: string): boolean {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || /^(fc|fd)[0-9a-f:]+$/i.test(host) || /^fe[89ab][0-9a-f:]+$/i.test(host)) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b! >= 64 && b! <= 127);
}

/** HTTP requires an explicit development opt-in AND a private/literal local host. */
export function validateBaseUrl(value: string, policy: UrlPolicy = {}): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new HermesError('protocol', '请输入完整的 HTTPS 服务器地址'); }
  if (url.username || url.password || url.hash || url.search) throw new HermesError('protocol', '服务器地址不得包含账号、密码、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp && privateHost(url.hostname))) throw new HermesError('protocol', '使用 HTTPS；开发 HTTP 仅限显式启用的私网地址');
  if (/%2f|%5c|%2e/i.test(url.pathname) || /\\/.test(value)) throw new HermesError('protocol', '服务器路径包含歧义编码');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

/** Append instead of resolving an absolute path: preserve reverse-proxy and /p/profile prefixes. */
export function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\') || /(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c/i.test(path) || /[?#]/.test(path)) throw new HermesError('protocol', 'API 路径无效');
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.toString();
}

export const segment = (value: string): string => encodeURIComponent(value);
