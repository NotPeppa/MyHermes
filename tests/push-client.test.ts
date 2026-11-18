/**
 * 推送桥纯逻辑测试：退避序列、通知内容、WS 帧解析、配置往返。
 * 运行：npx tsx --test tests/push-client.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readPushConfig, writePushConfig, DEFAULT_PUSH_SERVER_ID } from '../src/features/notifications/config';
import {
  eventToNotification,
  parseBridgeMessage,
  reconnectDelay,
  type BridgeEvent,
} from '../src/features/notifications/client';
import type { Repository } from '../src/domain/contracts';

const fixed = (value: number) => () => value;

test('reconnectDelay 指数退避并在 30s 封顶', () => {
  const delays = [0, 1, 2, 3, 4, 5, 6, 9].map((attempt) => reconnectDelay(attempt, fixed(0.5)));
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('reconnectDelay 抖动落在 ±20% 内', () => {
  for (const attempt of [0, 1, 2, 3, 4, 5]) {
    const base = Math.min(30000, 1000 * 2 ** attempt);
    const low = reconnectDelay(attempt, fixed(0));
    const high = reconnectDelay(attempt, fixed(1));
    assert.equal(low, Math.round(base * 0.8), `attempt ${attempt} 下界`);
    assert.equal(high, Math.round(base * 1.2), `attempt ${attempt} 上界`);
  }
  // 负尝试号不产生小于 1s 的间隔
  assert.equal(reconnectDelay(-3, fixed(0.5)), 1000);
});

const baseEvent: BridgeEvent = {
  eventId: '*:sess_1:msg_2',
  serverId: '*',
  sessionId: 'sess_1',
  sessionTitle: '磁盘检查',
  state: 'completed',
  ts: 1763390340000,
};

test('eventToNotification 不带 preview 时只说「有新回复」', () => {
  const content = eventToNotification(baseEvent);
  assert.equal(content.body, '「磁盘检查」有新回复');
  assert.match(content.title, /磁盘检查/);
  assert.match(content.title, /已完成/);
  assert.deepEqual(content.data, { serverId: '*', sessionId: 'sess_1' });
  assert.doesNotMatch(JSON.stringify(content), /preview/);
});

test('eventToNotification 有 preview 时正文用 preview', () => {
  const content = eventToNotification({ ...baseEvent, preview: '磁盘已清理 2.1GB' });
  assert.equal(content.body, '磁盘已清理 2.1GB');
  assert.deepEqual(content.data, { serverId: '*', sessionId: 'sess_1' });
});

test('eventToNotification 无会话标题与未知状态也能出内容', () => {
  const content = eventToNotification({ eventId: 'e1', serverId: 'shanghai', state: 'weird', ts: 1 });
  assert.equal(content.body, '「会话」有新回复');
  assert.match(content.title, /weird/);
  assert.deepEqual(content.data, { serverId: 'shanghai' });
});

test('parseBridgeMessage 解析 hello / event / unknown', () => {
  const hello = parseBridgeMessage(JSON.stringify({ type: 'hello', pending: [baseEvent] }));
  assert.equal(hello.kind, 'hello');
  assert.ok(hello.kind === 'hello');
  assert.equal(hello.pending.length, 1);
  assert.equal(hello.pending[0]?.eventId, '*:sess_1:msg_2');

  const event = parseBridgeMessage(JSON.stringify({ type: 'event', event: baseEvent }));
  assert.equal(event.kind, 'event');
  assert.ok(event.kind === 'event');
  assert.equal(event.event.sessionTitle, '磁盘检查');

  assert.deepEqual(parseBridgeMessage(JSON.stringify({ type: 'pong', ts: 1 })), { kind: 'unknown' });
  assert.deepEqual(parseBridgeMessage(JSON.stringify({ type: 'event' })), { kind: 'unknown' });
});

test('parseBridgeMessage 非法 JSON 返回 unknown 而不是抛错', () => {
  assert.deepEqual(parseBridgeMessage('{not json'), { kind: 'unknown' });
  assert.deepEqual(parseBridgeMessage(''), { kind: 'unknown' });
  assert.deepEqual(parseBridgeMessage(null), { kind: 'unknown' });
  assert.deepEqual(parseBridgeMessage(42), { kind: 'unknown' });
});

test('parseBridgeMessage 过滤 hello 里不合规的事件', () => {
  const message = parseBridgeMessage({
    type: 'hello',
    pending: [baseEvent, { eventId: 'x' }, null],
  });
  assert.ok(message.kind === 'hello');
  assert.equal(message.pending.length, 1);
});

function memoryRepository(): { repository: Repository; settings: Map<string, string> } {
  const settings = new Map<string, string>();
  const repository = {
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
      settings.set(key, value);
    },
  } as unknown as Repository;
  return { repository, settings };
}

test('readPushConfig 默认值：关闭、serverId 为广播 *', async () => {
  const { repository } = memoryRepository();
  const config = await readPushConfig(repository);
  assert.deepEqual(config, {
    bridgeUrl: '',
    enabled: false,
    deviceId: null,
    serverId: DEFAULT_PUSH_SERVER_ID,
    serverAlias: null,
  });
  assert.equal(DEFAULT_PUSH_SERVER_ID, '*');
});

test('writePushConfig / readPushConfig 往返', async () => {
  const { repository, settings } = memoryRepository();
  await writePushConfig(repository, {
    bridgeUrl: ' https://bridge.example.com ',
    enabled: true,
    deviceId: 'dev-1',
    serverId: 'shanghai',
    serverAlias: '上海',
  });
  assert.deepEqual(await readPushConfig(repository), {
    bridgeUrl: 'https://bridge.example.com',
    enabled: true,
    deviceId: 'dev-1',
    serverId: 'shanghai',
    serverAlias: '上海',
  });
  // 只写 patch 里的键，其余保持不变
  await writePushConfig(repository, { enabled: false });
  const after = await readPushConfig(repository);
  assert.equal(after.enabled, false);
  assert.equal(after.bridgeUrl, 'https://bridge.example.com');
  assert.equal(settings.get('push.enabled'), 'false');

  // deviceId 置空 → 读回 null；serverId 置空 → 回到广播
  await writePushConfig(repository, { deviceId: null, serverId: '' });
  const cleared = await readPushConfig(repository);
  assert.equal(cleared.deviceId, null);
  assert.equal(cleared.serverId, '*');
});
