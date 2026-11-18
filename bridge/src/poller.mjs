/**
 * Hermes 事件轮询器。
 *
 * 两种运行方式共用这一份逻辑：
 *  - 单进程模式：桥自己调它（只配 HERMES_API_KEY，不需要额外部署 agent）
 *  - 双进程模式：hermes-agent.mjs 调它，再把事件 POST 给远端的桥
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const defaultState = () => ({ seen: new Set() });

/** 已通知过的消息 id，重启后不重复提醒。 */
export function loadState(statePath) {
  if (!statePath) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return { seen: new Set(Array.isArray(parsed.seen) ? parsed.seen : []) };
  } catch {
    return defaultState();
  }
}

export function saveState(state, statePath) {
  if (!statePath) return;
  try {
    writeFileSync(statePath, JSON.stringify({ seen: [...state.seen].slice(-2000) }));
  } catch {
    /* 状态写失败只影响去重，不影响推送 */
  }
}

/** 只关心 assistant 的最终回复；工具/系统消息与压缩脚手架不提醒。 */
export function isNotifiable(message) {
  return (
    message?.role === 'assistant' &&
    message?.display_kind !== 'hidden' &&
    String(message?.content ?? '').trim().length > 0
  );
}

export function messageFingerprint(message) {
  return String(
    message?.id ??
      message?.message_id ??
      createHash('sha1')
        .update(`${message?.role ?? ''}|${message?.timestamp ?? ''}|${String(message?.content ?? '')}`)
        .digest('hex')
        .slice(0, 16),
  );
}

export function previewOf(message, enabled) {
  if (!enabled) return undefined;
  const text = String(message.content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function createPoller({
  hermesBaseUrl = 'http://127.0.0.1:8642',
  apiKey,
  serverId = '*',
  pollMs = 5000,
  includePreview = false,
  sessionLimit = 20,
  statePath,
  onEvents,
  log = () => {},
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('缺少 Hermes API Key');
  const state = loadState(statePath);
  let timer = null;
  let running = false;

  const request = (path) =>
    fetchImpl(`${hermesBaseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

  async function listSessions() {
    const res = await request(`/api/sessions?limit=${Number(sessionLimit)}`);
    if (!res.ok) throw new Error(`sessions ${res.status}`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.sessions ?? body.data ?? []);
    return rows
      .map((row) => ({ id: String(row.id ?? row.session_id ?? ''), title: String(row.title ?? row.name ?? '会话') }))
      .filter((row) => row.id);
  }

  async function listMessages(sessionId) {
    const res = await request(`/api/sessions/${encodeURIComponent(sessionId)}/messages?inline_images=false&limit=20`);
    if (!res.ok) throw new Error(`messages ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : (body.data ?? body.messages ?? []);
  }

  /** 跑一轮，返回本轮新产生的事件（已去重）。 */
  async function tick() {
    const events = [];
    for (const session of await listSessions()) {
      let messages;
      try {
        messages = await listMessages(session.id);
      } catch {
        continue;
      }
      for (const message of messages) {
        if (!isNotifiable(message)) continue;
        const messageId = messageFingerprint(message);
        const eventId = `${serverId}:${session.id}:${messageId}`;
        if (state.seen.has(eventId)) continue;
        state.seen.add(eventId);
        const preview = previewOf(message, includePreview);
        events.push({
          eventId,
          serverId,
          sessionId: session.id,
          sessionTitle: session.title,
          state: 'completed',
          ts: Number(message.timestamp ?? Date.now()) || Date.now(),
          ...(preview ? { preview } : {}),
        });
      }
    }
    saveState(state, statePath);
    if (events.length) await onEvents(events);
    return events;
  }

  return {
    tick,
    start() {
      if (running) return;
      running = true;
      const loop = async () => {
        if (!running) return;
        try {
          await tick();
        } catch (error) {
          log('poller error:', error.message);
        }
        timer = setTimeout(loop, pollMs);
      };
      void loop();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      saveState(state, statePath);
    },
    get seenCount() {
      return state.seen.size;
    },
  };
}
