/**
 * 桥的契约测试：注册、HMAC、幂等、在线投递、离线补发、撤销。
 * 运行：npm test（在 bridge/ 下）
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.mjs';

const SECRET = 'test-bridge-secret';

async function start() {
  const bridge = createBridge({ secret: SECRET });
  const { port } = await bridge.listen(0);
  return { bridge, base: `http://127.0.0.1:${port}` };
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const signed = (body) => {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const signature = createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
  return { raw, headers: { 'x-bridge-timestamp': ts, 'x-bridge-signature': signature } };
};

async function register(base, serverId = 'srv-1') {
  const res = await post(base, '/register', { platform: 'android', serverId, serverAlias: '上海' });
  assert.equal(res.status, 200);
  return res.json();
}

function openSocket(base, device) {
  const url = `${base.replace('http', 'ws')}/ws?deviceId=${encodeURIComponent(device.deviceId)}&secret=${device.secret}`;
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

const waitFor = async (predicate, timeoutMs = 2000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

test('注册返回设备 id 与一次性密钥，健康检查统计设备数', async () => {
  const { bridge, base } = await start();
  try {
    const device = await register(base);
    assert.match(device.deviceId, /^dev_/);
    assert.ok(device.secret.length >= 32);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.devices, 1);
    assert.equal(health.connected, 0);
  } finally {
    await bridge.close();
  }
});

test('未签名或签名错误的 /events 一律拒绝', async () => {
  const { bridge, base } = await start();
  try {
    const body = { events: [{ eventId: 'e1', serverId: 'srv-1', state: 'completed' }] };
    assert.equal((await post(base, '/events', body)).status, 401);

    const { raw } = signed(body);
    const wrong = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-timestamp': String(Date.now()), 'x-bridge-signature': 'deadbeef' },
      body: raw,
    });
    assert.equal(wrong.status, 401);

    // 过期时间戳同样拒绝
    const staleTs = String(Date.now() - 10 * 60 * 1000);
    const staleSig = createHmac('sha256', SECRET).update(`${staleTs}.${raw}`).digest('hex');
    const stale = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-timestamp': staleTs, 'x-bridge-signature': staleSig },
      body: raw,
    });
    assert.equal(stale.status, 401);
  } finally {
    await bridge.close();
  }
});

test('在线设备通过 WebSocket 收到事件，重复 eventId 不重复投递', async () => {
  const { bridge, base } = await start();
  try {
    const device = await register(base);
    const { messages } = await openSocket(base, device);
    assert.ok(await waitFor(() => messages.some((m) => m.type === 'hello')));

    const event = { eventId: 'evt-1', serverId: 'srv-1', sessionId: 'sess-1', sessionTitle: '磁盘检查', state: 'completed', ts: Date.now() };
    const { raw, headers } = signed({ events: [event] });
    const first = await (await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })).json();
    assert.deepEqual(first, { accepted: 1, delivered: 1 });
    assert.ok(await waitFor(() => messages.some((m) => m.type === 'event' && m.event.eventId === 'evt-1')));

    const replay = await (await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })).json();
    assert.deepEqual(replay, { accepted: 0, delivered: 0 }, '同一 eventId 幂等');
  } finally {
    await bridge.close();
  }
});

test('离线设备重连后补发未投递事件', async () => {
  const { bridge, base } = await start();
  try {
    const device = await register(base);
    const event = { eventId: 'evt-offline', serverId: 'srv-1', sessionId: 'sess-2', state: 'completed', ts: Date.now() };
    const { raw, headers } = signed({ events: [event] });
    const result = await (await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })).json();
    assert.deepEqual(result, { accepted: 1, delivered: 0 }, '没有在线连接时只入库');

    const { messages } = await openSocket(base, device);
    assert.ok(await waitFor(() => messages.some((m) => m.type === 'hello' && m.pending.length === 1)));
    assert.equal(messages.find((m) => m.type === 'hello').pending[0].eventId, 'evt-offline');
  } finally {
    await bridge.close();
  }
});

test('轮询兜底接口返回并消费未投递事件', async () => {
  const { bridge, base } = await start();
  try {
    const device = await register(base);
    const event = { eventId: 'evt-poll', serverId: 'srv-1', sessionId: 'sess-3', state: 'failed', ts: Date.now() };
    const { raw, headers } = signed({ events: [event] });
    await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });

    const first = await (await fetch(`${base}/events?deviceId=${device.deviceId}&secret=${device.secret}`)).json();
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].state, 'failed');

    const second = await (await fetch(`${base}/events?deviceId=${device.deviceId}&secret=${device.secret}`)).json();
    assert.equal(second.events.length, 0, '已投递的事件不再返回');
  } finally {
    await bridge.close();
  }
});

test('密钥错误无法建立 WebSocket；撤销后连接被关闭', async () => {
  const { bridge, base } = await start();
  try {
    const device = await register(base);
    const badUrl = `${base.replace('http', 'ws')}/ws?deviceId=${device.deviceId}&secret=wrong`;
    const bad = new WebSocket(badUrl);
    const failed = await new Promise((resolve) => {
      bad.once('error', () => resolve(true));
      bad.once('open', () => resolve(false));
    });
    assert.equal(failed, true, '错误密钥应握手失败');

    const { ws } = await openSocket(base, device);
    const closed = new Promise((resolve) => ws.once('close', () => resolve(true)));
    const res = await fetch(`${base}/register/${device.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${device.secret}` },
    });
    assert.equal(res.status, 200);
    assert.equal(await closed, true, '撤销后在线连接应被关闭');
  } finally {
    await bridge.close();
  }
});

test('事件只投递给同一实例的设备', async () => {
  const { bridge, base } = await start();
  try {
    const a = await register(base, 'srv-a');
    const b = await register(base, 'srv-b');
    const socketA = await openSocket(base, a);
    const socketB = await openSocket(base, b);
    await waitFor(() => socketA.messages.length && socketB.messages.length);

    const event = { eventId: 'evt-iso', serverId: 'srv-a', state: 'completed', ts: Date.now() };
    const { raw, headers } = signed({ events: [event] });
    const result = await (await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })).json();
    assert.equal(result.delivered, 1);
    assert.ok(await waitFor(() => socketA.messages.some((m) => m.type === 'event')));
    assert.equal(socketB.messages.filter((m) => m.type === 'event').length, 0, '另一个实例不应收到');
  } finally {
    await bridge.close();
  }
});

test('serverId 为 * 时广播给所有实例的设备', async () => {
  const { bridge, base } = await start();
  try {
    const a = await register(base, 'srv-a');
    const b = await register(base, 'srv-b');
    const socketA = await openSocket(base, a);
    const socketB = await openSocket(base, b);
    await waitFor(() => socketA.messages.length && socketB.messages.length);

    const event = { eventId: 'evt-broadcast', serverId: '*', state: 'completed', ts: Date.now() };
    const { raw, headers } = signed({ events: [event] });
    const result = await (await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })).json();
    assert.equal(result.delivered, 2);
    assert.ok(await waitFor(() => socketA.messages.some((m) => m.type === 'event')));
    assert.ok(await waitFor(() => socketB.messages.some((m) => m.type === 'event')));
  } finally {
    await bridge.close();
  }
});
