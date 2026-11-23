import type { AgentEvent, RunState } from '../../domain/models';
import type { SSEFrame } from '../../api/sse';
export function runState(value: unknown): RunState {
  const status = String(value ?? 'unknown');
  if (['started', 'in_progress'].includes(status)) return 'running';
  if (status === 'canceled') return 'cancelled';
  return ['submitting', 'submission_uncertain', 'queued', 'running', 'waiting_for_approval', 'waiting_for_clarification', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(status) ? status as RunState : 'unknown';
}
const text = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;

/**
 * 事件时间戳统一成毫秒。
 * 服务器可能发秒级（约 1e9）也可能发毫秒（约 1e12）；换算成毫秒后再和消息的
 * createdAt 比较，否则秒级工具事件会排到所有消息之前，卡片被顶到对话最上端。
 */
export function eventTimestamp(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now();
  return numeric < 1e11 ? Math.round(numeric * 1000) : Math.round(numeric);
}
export function normalizeEvent(frame: SSEFrame, runId: string, channel: 'runs' | 'sessions' | 'compat' = 'runs'): AgentEvent {
  let data: Record<string, any> = {};
  if (frame.data !== '[DONE]') { try { data = JSON.parse(frame.data); } catch { /* unknown non-JSON event */ } }
  const name = frame.event !== 'message' ? frame.event : String(data.type ?? data.event ?? 'message');
  const base: AgentEvent = { kind: 'unknown', runId: text(data.run_id) ?? runId, rawEventType: name, timestamp: eventTimestamp(data.timestamp), ...(frame.id && frame.idExplicit !== false ? { id: frame.id } : {}) };
  if (channel === 'compat') {
    const content = data.choices?.[0]?.delta?.content;
    if (typeof content === 'string') return { ...base, kind: 'text_delta', text: content };
    if (frame.data === '[DONE]' || data.choices?.[0]?.finish_reason === 'stop') return { ...base, kind: 'terminal', state: 'completed' };
    if (data.choices?.[0]?.finish_reason) return { ...base, kind: 'terminal', state: 'unknown' };
  }
  if (['message.delta', 'assistant.delta', 'text_delta', 'token'].includes(name)) return { ...base, kind: 'text_delta', text: text(data.delta) ?? text(data.text) ?? text(data.content) ?? text(data.delta?.text) ?? '' };
  if (['message.interim', 'assistant.commentary'].includes(name)) return { ...base, kind: 'commentary', text: text(data.text) ?? text(data.content), alreadyStreamed: data.already_streamed === true };
  if (['tool.started', 'tool.completed', 'tool.failed', 'tool_start', 'tool_end'].includes(name)) return { ...base, kind: ['tool.started', 'tool_start'].includes(name) ? 'tool_started' : 'tool_finished', tool: text(data.tool_name) ?? text(data.tool) ?? text(data.name) ?? 'tool', toolCallId: text(data.tool_call_id) ?? text(data.call_id), failed: name === 'tool.failed' };
  if (/approval|clarif/.test(name)) {
    // 事件本身可能就带着审批身份与选项；不带时退回 status 的 pending_controls
    const requestId = text(data.request_id) ?? text(data.prompt_id) ?? text(data.id);
    const generation = typeof data.execution_generation === 'number' ? data.execution_generation : typeof data.generation === 'number' ? data.generation : undefined;
    const choices = Array.isArray(data.choices) ? data.choices.filter((c: unknown): c is string => typeof c === 'string') : undefined;
    const prompt = text(data.prompt) ?? text(data.description) ?? text(data.command) ?? text(data.question);
    const control = requestId
      ? {
          request_id: requestId,
          execution_generation: generation ?? 0,
          type: /clarif/.test(name) ? 'clarification' : 'approval',
          prompt: prompt ?? (choices?.length ? choices.join(' / ') : '需要你的确认'),
          ...(choices && choices.length ? { choices } : {}),
        }
      : undefined;
    return { ...base, kind: 'control', ...(control ? { control } : {}) };
  }
  if (/^run\.(completed|failed|cancelled|interrupted|unknown)$/.test(name)) return { ...base, kind: 'terminal', state: runState(name.slice(4)), output: text(data.output) ?? text(data.text) };
  if (channel === 'sessions' && ['done', 'complete', 'completed'].includes(name)) return { ...base, kind: 'terminal', state: 'completed', output: text(data.output) };
  return base;
}
