import type { Message, Session, Run, OutboundTurn, AgentEvent, ModelOption } from '../../domain/models';
import { Transport, ProtocolError, type RequestOptions } from '../../api/transport';
import { segment } from '../../api/urls';
import { consumeSSE } from '../../api/sse';
import { normalizeEvent, runState } from './events';
const rows = (value: any, field: string): any[] => { const result = Array.isArray(value) ? value : value?.[field] ?? value?.data; if (!Array.isArray(result)) throw new ProtocolError('protocol', '服务器列表响应格式错误'); return result; };
export class SessionsAdapter {
  constructor(private transport: Transport, private serverId: string) {}
  private session(value: any): Session { if (!value || !(value.id ?? value.session_id)) throw new ProtocolError('protocol', '会话缺少标识'); return { serverId: this.serverId, id: String(value.id ?? value.session_id), title: String(value.title ?? value.name ?? '新会话'), updatedAt: Number(value.updated_at ?? Date.now()) }; }
  async list(limit = 100, offset = 0): Promise<Session[]> { return rows(await this.transport.request('api/sessions', { query: { limit, offset } }), 'sessions').map(v => this.session(v)); }
  async create(title?: string): Promise<Session> { const value = await this.transport.request<any>('api/sessions', { method: 'POST', body: JSON.stringify(title ? { title } : {}) }); return this.session(value.session ?? value); }
  async fork(id: string, title?: string): Promise<Session> {
    const value = await this.transport.request<any>(`api/sessions/${segment(id)}/fork`, { method: 'POST', body: JSON.stringify(title ? { title } : {}) });
    const raw = value?.session ?? value;
    return { ...this.session(raw), forkedFrom: String(raw.forked_from ?? raw.parent_id ?? id) };
  }
  async rename(id: string, title: string): Promise<void> { await this.transport.request(`api/sessions/${segment(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }); }
  async delete(id: string): Promise<void> { await this.transport.request(`api/sessions/${segment(id)}`, { method: 'DELETE' }); }
  async messages(id: string): Promise<Message[]> {
    return rows(await this.transport.request(`api/sessions/${segment(id)}/messages`, { query: { inline_images: false } }), 'messages').map((value, index) => ({
      id: `${this.serverId}:${id}:${value.id ?? value.message_id ?? index}`, serverId: this.serverId, sessionId: id,
      serverMessageId: value.id ?? value.message_id, role: ['user', 'assistant', 'system', 'tool'].includes(value.role) ? value.role : 'assistant',
      body: typeof value.content === 'string' ? value.content : typeof value.body === 'string' ? value.body : Array.isArray(value.content) ? value.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : '', createdAt: Number(value.created_at ?? index),
    }));
  }
  async stream(id: string, body: string, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    await this.transport.request(`api/sessions/${segment(id)}/chat/stream`, { method: 'POST', body, signal, timeoutMs: 3_600_000, headers: { Accept: 'text/event-stream' } }, (response, abort) => consumeSSE(response, abort, frame => onEvent(normalizeEvent(frame, id, 'sessions'))));
  }
}
export class RunsAdapter {
  constructor(private transport: Transport) {}
  async submit(turn: OutboundTurn, signal?: AbortSignal): Promise<Run> {
    if (!/^[\x21-\x7e]{1,255}$/.test(turn.idempotencyKey)) throw new ProtocolError('protocol', '幂等键格式无效');
    const value = await this.transport.request<any>('v1/runs', { method: 'POST', body: turn.requestBodyJson, headers: { 'Idempotency-Key': turn.idempotencyKey }, signal });
    const id = value?.run_id ?? value?.id;
    if (typeof id !== 'string' || !id) throw new ProtocolError('protocol', '提交响应缺少 run_id，需核对提交状态');
    return this.map(value, { ...turn, runId: id, status: 'unknown', updatedAt: Date.now() });
  }
  private map(value: any, original: Run): Run {
    if (!value || typeof value !== 'object') throw new ProtocolError('protocol', '任务响应格式错误');
    return { ...original, status: runState(value.status), rawStatus: String(value.status ?? 'unknown'), sessionId: value.session_id ?? original.sessionId, finalOutput: typeof value.output === 'string' ? value.output : undefined, pendingControls: Array.isArray(value.pending_controls) ? value.pending_controls : [], admissionId: value.admission_id, executionGeneration: value.execution_generation, updatedAt: Date.now() };
  }
  async status(run: Run): Promise<Run> { return this.map(await this.transport.request(`v1/runs/${segment(run.runId)}`), run); }
  async control(id: string, action: 'stop' | 'approval' | 'clarify' | 'resolve-unknown', body = {}): Promise<void> { await this.transport.request(`v1/runs/${segment(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) }); }
  async events(id: string, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    await this.transport.request(`v1/runs/${segment(id)}/events`, { signal, timeoutMs: 3_600_000, headers: { Accept: 'text/event-stream' } }, (response, abort) => consumeSSE(response, abort, frame => onEvent(normalizeEvent(frame, id))));
  }
}
export class ModelsAdapter {
  constructor(private transport: Transport) {}
  /** Flat list from `{providers:[{id,models:[{id,...}]}]}`; unknown shapes yield [] instead of throwing. */
  async options(): Promise<ModelOption[]> {
    const value = await this.transport.request<any>('api/model/options');
    const providers = Array.isArray(value?.providers) ? value.providers : Array.isArray(value?.data) ? value.data : [];
    const options: ModelOption[] = [];
    for (const provider of providers) {
      if (!Array.isArray(provider?.models)) continue;
      for (const model of provider.models) {
        if (typeof model?.id !== 'string' || !model.id) continue;
        const label = model.label ?? model.name, context = model.context_window ?? model.contextWindow;
        options.push({ id: model.id, ...(typeof provider.id === 'string' ? { provider: provider.id } : {}), ...(typeof label === 'string' ? { label } : {}), ...(typeof context === 'number' ? { contextWindow: context } : {}) });
      }
    }
    return options;
  }
}
export class CompatAdapter {
  constructor(private transport: Transport) {}
  async stream(body: string, id: string, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    await this.transport.request('v1/chat/completions', { method: 'POST', body, signal, timeoutMs: 3_600_000, headers: { Accept: 'text/event-stream' } } satisfies RequestOptions, (response, abort) => consumeSSE(response, abort, frame => onEvent(normalizeEvent(frame, id, 'compat'))));
  }
}
