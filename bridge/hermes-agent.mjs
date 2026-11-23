#!/usr/bin/env node
/**
 * 独立的 Hermes 事件代理（双进程模式）。
 *
 * 只有当你不想把 Hermes Key 放进桥进程时才需要它：
 * 它在 Hermes 主机上用 Key 轮询，把**不含正文**的事件 POST 给远端的桥。
 *
 * 单机部署请直接用桥的内置轮询：HERMES_API_KEY=... node src/server.mjs
 *
 * 用法：
 *   HERMES_BASE_URL=http://127.0.0.1:8642 \
 *   API_SERVER_KEY=<key> \
 *   BRIDGE_URL=https://bridge.example.com \
 *   BRIDGE_SECRET=<secret> \
 *   node hermes-agent.mjs
 */
import { createHmac } from 'node:crypto';
import { createPoller } from './src/poller.mjs';

const {
  HERMES_BASE_URL = 'http://127.0.0.1:8642',
  API_SERVER_KEY,
  BRIDGE_URL,
  BRIDGE_SECRET,
  SERVER_ID = '*',
  POLL_MS = '5000',
  INCLUDE_PREVIEW = '0',
  STATE_PATH = './hermes-agent-state.json',
  SESSION_LIMIT = '20',
} = process.env;

if (!API_SERVER_KEY) throw new Error('缺少 API_SERVER_KEY');
if (!BRIDGE_URL) throw new Error('缺少 BRIDGE_URL');
if (!BRIDGE_SECRET) throw new Error('缺少 BRIDGE_SECRET');

async function pushEvents(events) {
  const raw = JSON.stringify({ events });
  const ts = String(Date.now());
  const signature = createHmac('sha256', BRIDGE_SECRET).update(`${ts}.${raw}`).digest('hex');
  const res = await fetch(`${BRIDGE_URL.replace(/\/+$/, '')}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-timestamp': ts, 'x-bridge-signature': signature },
    body: raw,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}: ${await res.text()}`);
  const result = await res.json();
  console.log(`[agent] 推送 ${events.length} 条，桥接受 ${result?.accepted ?? 0}，在线投递 ${result?.delivered ?? 0}`);
}

const poller = createPoller({
  hermesBaseUrl: HERMES_BASE_URL,
  apiKey: API_SERVER_KEY,
  serverId: SERVER_ID,
  pollMs: Number(POLL_MS),
  includePreview: INCLUDE_PREVIEW === '1',
  sessionLimit: Number(SESSION_LIMIT),
  statePath: STATE_PATH,
  onEvents: pushEvents,
  log: (...args) => console.error('[agent]', ...args),
});

console.log(
  `[agent] 监听 ${HERMES_BASE_URL} → ${BRIDGE_URL}（间隔 ${POLL_MS}ms，预览 ${INCLUDE_PREVIEW === '1' ? '开' : '关'}）`,
);
poller.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    poller.stop();
    process.exit(0);
  });
}
