import type { ProbeResult } from '../domain/contracts';
import type { Capabilities } from '../domain/models';
import { Transport, ProtocolError, type FetchLike } from './transport';
export async function probe(baseUrl: string, key: string, options: { allowHttp?: boolean; signal?: AbortSignal; fetch?: FetchLike } = {}): Promise<ProbeResult> {
  const start = Date.now();
  const transport = new Transport(baseUrl, key, options.fetch, options.allowHttp);
  const features: Record<string, boolean> = {};
  let endpoints: Record<string, unknown> = {};
  let model: string | undefined;
  try {
    const payload = await transport.request<any>('v1/capabilities', { signal: options.signal });
    if (!payload || typeof payload !== 'object') throw new ProtocolError('protocol', '能力响应格式错误');
    if (Array.isArray(payload.features)) for (const item of payload.features) if (typeof item === 'string') features[item] = true;
    else if (item && typeof item.name === 'string') features[item.name] = item.enabled === true;
    if (payload.features && !Array.isArray(payload.features)) for (const [name, enabled] of Object.entries(payload.features)) features[name] = enabled === true || (typeof enabled === 'object' && enabled !== null && (enabled as any).enabled === true);
    if (payload.endpoints && typeof payload.endpoints === 'object') endpoints = payload.endpoints;
  } catch (error) {
    if (!(error instanceof ProtocolError) || error.status !== 404) throw error;
    const result = await transport.request<any>('v1/models', { signal: options.signal });
    if (!Array.isArray(result?.data)) throw new ProtocolError('protocol', '服务器未提供可识别的模型接口');
    model = result.data[0]?.id;
    features.chat_completions = true;
  }
  const endpoint = (path: string): boolean => Array.isArray(endpoints) ? endpoints.some((v: any) => v === path || v?.path === path) : endpoints[path] === true || typeof endpoints[path] === 'object' && endpoints[path] !== null;
  // Explicit feature flags win; endpoint declarations can fill missing flags, never override false.
  const aliases: Record<string, string> = { run_submission: '/v1/runs', run_status: '/v1/runs/{id}', run_events_sse: '/v1/runs/{id}/events', sessions_list: '/api/sessions', session_messages: '/api/sessions/{id}/messages', session_chat_stream: '/api/sessions/{id}/chat/stream', session_fork: '/api/sessions/{id}/fork', model_options: '/api/model/options', chat_completions: '/v1/chat/completions' };
  for (const [name, path] of Object.entries(aliases)) if (!(name in features) && endpoint(path)) features[name] = true;
  const runs = ['run_submission', 'run_status', 'run_events_sse'].every(name => features[name]);
  const sessions = !!(features.sessions_list && features.session_messages && features.session_chat_stream);
  const capabilities: Capabilities = { mode: runs ? 'native_runs' : sessions ? 'native_sessions' : features.chat_completions ? 'openai_compat' : 'unsupported', features, endpoints, checkedAt: Date.now(), ...(model ? { model } : {}) };
  return { capabilities, latencyMs: Date.now() - start };
}
