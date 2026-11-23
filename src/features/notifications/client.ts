import type { FetchLike } from '@/api/transport';

/** 桥的每个 HTTP 调用都带超时：桥挂了不能把设置页卡住。 */
export const BRIDGE_TIMEOUT_MS = 10_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;

export type BridgePlatform = 'android' | 'ios';

/** 桥投递的事件形状（不含任务正文，preview 需 agent 显式开启）。 */
export interface BridgeEvent {
  eventId: string;
  serverId: string;
  sessionId?: string;
  sessionTitle?: string;
  state: string;
  preview?: string;
  ts: number;
}

export interface RegisterInput {
  baseUrl: string;
  platform: BridgePlatform;
  serverId: string;
  serverAlias?: string;
  deviceName?: string;
}

export interface DeviceCredential {
  deviceId: string;
  secret: string;
}

export interface BridgeHealth {
  ok: boolean;
  connected: number;
  devices: number;
  events: number;
  pending: number;
}

export interface NotificationContent {
  title: string;
  body: string;
  data: { serverId: string; sessionId?: string };
}

const trimSlash = (baseUrl: string) => baseUrl.replace(/\/+$/, '');

async function call(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`推送桥返回 ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function registerDevice(input: RegisterInput, fetchImpl: FetchLike): Promise<DeviceCredential> {
  const response = await call(fetchImpl, `${trimSlash(input.baseUrl)}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      platform: input.platform,
      serverId: input.serverId,
      ...(input.serverAlias ? { serverAlias: input.serverAlias } : {}),
      ...(input.deviceName ? { deviceName: input.deviceName } : {}),
    }),
  });
  const parsed = (await response.json()) as Partial<DeviceCredential>;
  if (!parsed.deviceId || !parsed.secret) throw new Error('推送桥注册响应缺少 deviceId 或 secret');
  return { deviceId: parsed.deviceId, secret: parsed.secret };
}

export async function unregisterDevice(
  input: { baseUrl: string; deviceId: string; secret: string },
  fetchImpl: FetchLike,
): Promise<void> {
  await call(fetchImpl, `${trimSlash(input.baseUrl)}/register/${encodeURIComponent(input.deviceId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${input.secret}`, Accept: 'application/json' },
  });
}

export async function fetchHealth(baseUrl: string, fetchImpl: FetchLike): Promise<BridgeHealth> {
  const response = await call(fetchImpl, `${trimSlash(baseUrl)}/health`, { headers: { Accept: 'application/json' } });
  const parsed = (await response.json()) as Partial<BridgeHealth>;
  return {
    ok: parsed.ok === true,
    connected: Number(parsed.connected ?? 0),
    devices: Number(parsed.devices ?? 0),
    events: Number(parsed.events ?? 0),
    pending: Number(parsed.pending ?? 0),
  };
}

/** 指数退避：1s、2s、4s、8s、16s、30s 封顶，带 ±20% 抖动。 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, Math.floor(attempt)));
  return Math.round(step * (0.8 + random() * 0.4));
}

const STATE_LABELS: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  error: '失败',
  cancelled: '已取消',
  paused: '已暂停',
  running: '运行中',
  pending: '等待中',
  waiting: '等待中',
  unknown: '状态未知',
};

/**
 * 默认不带正文：只有 agent 显式开启 INCLUDE_PREVIEW 时事件里才有 preview。
 * 通知只暴露实例、会话与状态，正文要用户点开 App 才看。
 */
export function eventToNotification(event: BridgeEvent): NotificationContent {
  const session = event.sessionTitle ?? '会话';
  const state = STATE_LABELS[event.state] ?? event.state;
  const preview = event.preview?.trim();
  return {
    title: `${session} · ${state}`,
    body: preview ? preview : `「${session}」有新回复`,
    data: { serverId: event.serverId, ...(event.sessionId ? { sessionId: event.sessionId } : {}) },
  };
}

export type BridgeMessage =
  | { kind: 'hello'; pending: BridgeEvent[] }
  | { kind: 'event'; event: BridgeEvent }
  | { kind: 'unknown' };

function isEvent(value: unknown): value is BridgeEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<BridgeEvent>;
  return typeof event.eventId === 'string' && typeof event.serverId === 'string' && typeof event.state === 'string';
}

/** 非法 JSON 与未知帧一律 unknown，绝不抛错打断长连接。 */
export function parseBridgeMessage(raw: unknown): BridgeMessage {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: 'unknown' };
    }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unknown' };
  const message = parsed as { type?: unknown; pending?: unknown; event?: unknown };
  if (message.type === 'hello') {
    return { kind: 'hello', pending: Array.isArray(message.pending) ? message.pending.filter(isEvent) : [] };
  }
  if (message.type === 'event' && isEvent(message.event)) return { kind: 'event', event: message.event };
  return { kind: 'unknown' };
}

/** WS 无法可靠设置自定义头，密钥走 query——桥必须跑在 TLS 后面。 */
export function bridgeSocketUrl(baseUrl: string, deviceId: string, secret: string): string {
  const base = trimSlash(baseUrl).replace(/^http/i, 'ws');
  return `${base}/ws?deviceId=${encodeURIComponent(deviceId)}&secret=${encodeURIComponent(secret)}`;
}
