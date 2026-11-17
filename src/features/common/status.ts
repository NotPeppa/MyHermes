import { statusLabels, type HermesMode, type RunState } from '@/domain/models';

/** 未知上游状态保留原值，绝不擅自映射成"已完成"。 */
export function statusText(state: string | undefined | null): string {
  if (!state) return '状态未知';
  // idle 是纯客户端状态（设计 5.4），不属于 RunState 联合，需单独映射
  if (state === 'idle') return '可发送消息';
  const known = (statusLabels as Record<string, string>)[state];
  return known ?? `未知状态：${state}`;
}

const ACTIVE: ReadonlySet<string> = new Set([
  'submitting',
  'submission_uncertain',
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_clarification',
  'stopping',
]);

export function isActiveRun(state: string | undefined | null): boolean {
  return !!state && ACTIVE.has(state);
}

export function isTerminalRun(state: string | undefined | null): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted';
}

export function canStopRun(state: string | undefined | null): boolean {
  return state === 'queued' || state === 'running' || state === 'waiting_for_approval' || state === 'waiting_for_clarification';
}

export function modeLabel(mode: HermesMode | string | undefined): string {
  switch (mode) {
    case 'native_runs':
      return 'Runs';
    case 'native_sessions':
      return 'Sessions';
    case 'openai_compat':
      return 'Chat Completions 兼容';
    case 'unsupported':
      return '不支持';
    default:
      return '未检测';
  }
}

const FEATURE_LABEL: Record<string, string> = {
  run_submission: 'Run 提交',
  run_status: 'Run 状态',
  run_events_sse: 'Run 事件流',
  sessions_list: '会话列表',
  session_messages: '会话历史',
  session_chat_stream: '会话流式对话',
  chat_completions: 'Chat Completions',
};

export function featureLabel(name: string): string {
  return FEATURE_LABEL[name] ?? name;
}

export function enabledFeatures(features: Record<string, boolean> | undefined): string[] {
  if (!features) return [];
  return Object.entries(features)
    .filter(([, enabled]) => enabled)
    .map(([name]) => featureLabel(name));
}

export function runStateTone(state: string | undefined | null): 'neutral' | 'active' | 'success' | 'danger' | 'warning' {
  if (!state) return 'neutral';
  if (state === 'completed') return 'success';
  if (state === 'failed' || state === 'interrupted') return 'danger';
  if (state === 'unknown' || state === 'submission_uncertain' || state === 'cancelled') return 'warning';
  if (state === 'idle') return 'neutral';
  return 'active';
}

export type { RunState };
