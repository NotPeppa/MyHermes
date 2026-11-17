import type { AgentEvent, RunState } from '../../domain/models';
import type { SSEFrame } from '../../api/sse';
export function runState(value: unknown): RunState {
  const status = String(value ?? 'unknown');
  if (['started', 'in_progress'].includes(status)) return 'running';
  if (status === 'canceled') return 'cancelled';
  return ['submitting', 'submission_uncertain', 'queued', 'running', 'waiting_for_approval', 'waiting_for_clarification', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(status) ? status as RunState : 'unknown';
}
const text = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
export function normalizeEvent(frame: SSEFrame, runId: string, channel: 'runs' | 'sessions' | 'compat' = 'runs'): AgentEvent {
  let data: Record<string, any> = {};
  if (frame.data !== '[DONE]') { try { data = JSON.parse(frame.data); } catch { /* unknown non-JSON event */ } }
  const name = frame.event !== 'message' ? frame.event : String(data.type ?? data.event ?? 'message');
  const base: AgentEvent = { kind: 'unknown', runId: text(data.run_id) ?? runId, rawEventType: name, timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(), ...(frame.id && frame.idExplicit !== false ? { id: frame.id } : {}) };
  if (channel === 'compat') {
    const content = data.choices?.[0]?.delta?.content;
    if (typeof content === 'string') return { ...base, kind: 'text_delta', text: content };
    if (frame.data === '[DONE]' || data.choices?.[0]?.finish_reason === 'stop') return { ...base, kind: 'terminal', state: 'completed' };
    if (data.choices?.[0]?.finish_reason) return { ...base, kind: 'terminal', state: 'unknown' };
  }
  if (['message.delta', 'assistant.delta', 'text_delta', 'token'].includes(name)) return { ...base, kind: 'text_delta', text: text(data.delta) ?? text(data.text) ?? text(data.content) ?? text(data.delta?.text) ?? '' };
  if (['message.interim', 'assistant.commentary'].includes(name)) return { ...base, kind: 'commentary', text: text(data.text) ?? text(data.content), alreadyStreamed: data.already_streamed === true };
  if (['tool.started', 'tool.completed', 'tool.failed', 'tool_start', 'tool_end'].includes(name)) return { ...base, kind: ['tool.started', 'tool_start'].includes(name) ? 'tool_started' : 'tool_finished', tool: text(data.tool_name) ?? text(data.tool) ?? text(data.name) ?? 'tool', toolCallId: text(data.tool_call_id) ?? text(data.call_id), failed: name === 'tool.failed' };
  if (/approval|clarif/.test(name)) return { ...base, kind: 'control' };
  if (/^run\.(completed|failed|cancelled|interrupted|unknown)$/.test(name)) return { ...base, kind: 'terminal', state: runState(name.slice(4)), output: text(data.output) ?? text(data.text) };
  if (channel === 'sessions' && ['done', 'complete', 'completed'].includes(name)) return { ...base, kind: 'terminal', state: 'completed', output: text(data.output) };
  return base;
}
