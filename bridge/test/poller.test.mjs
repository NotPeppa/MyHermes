/**
 * 轮询器：只推 assistant 最终回复、同一消息不重复推、无 id 时用内容指纹兜底。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoller, isNotifiable, messageFingerprint, previewOf } from '../src/poller.mjs';

const fakeFetch = (sessions, messagesBySession) => async (url) => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/api/sessions?')) return json({ sessions });
  const match = /\/api\/sessions\/([^/]+)\/messages/.exec(url);
  if (match) return json({ messages: messagesBySession[decodeURIComponent(match[1])] ?? [] });
  return new Response('{}', { status: 404 });
};

test('只推 assistant 有正文的消息，同一轮和跨轮都不重复', async () => {
  const sessions = [{ id: 'sess-1', title: '磁盘检查' }];
  const messages = {
    'sess-1': [
      { id: 'm1', role: 'user', content: '检查磁盘' },
      { id: 'm2', role: 'assistant', content: '磁盘使用率 40%', timestamp: 1763390340000 },
      { id: 'm3', role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      { id: 'm4', role: 'assistant', content: '压缩前缀', display_kind: 'hidden' },
    ],
  };
  const batches = [];
  const poller = createPoller({
    apiKey: 'key',
    fetchImpl: fakeFetch(sessions, messages),
    onEvents: async (events) => batches.push(events),
    serverId: 'srv-1',
  });

  const first = await poller.tick();
  assert.equal(first.length, 1, '只有一条可通知消息');
  assert.deepEqual({ ...first[0], ts: 0 }, {
    eventId: 'srv-1:sess-1:m2',
    serverId: 'srv-1',
    sessionId: 'sess-1',
    sessionTitle: '磁盘检查',
    state: 'completed',
    ts: 0,
  });

  const second = await poller.tick();
  assert.equal(second.length, 0, '同一消息不重复推送');
  assert.equal(batches.length, 1, '没有新事件时不调用回调');
});

test('没有 id 时用内容指纹，稳定且可去重', () => {
  const message = { role: 'assistant', content: '你好', timestamp: 1763390340000 };
  const a = messageFingerprint(message);
  const b = messageFingerprint({ ...message });
  assert.equal(a, b);
  assert.notEqual(a, messageFingerprint({ ...message, content: '你好呀' }));
});

test('preview 默认关闭，开启后截断到 60 字', () => {
  const message = { role: 'assistant', content: 'x'.repeat(200) };
  assert.equal(previewOf(message, false), undefined);
  assert.equal(previewOf(message, true)?.length, 61);
});

test('isNotifiable 排除工具消息与压缩脚手架', () => {
  assert.equal(isNotifiable({ role: 'assistant', content: 'ok' }), true);
  assert.equal(isNotifiable({ role: 'user', content: 'ok' }), false);
  assert.equal(isNotifiable({ role: 'assistant', content: '  ' }), false);
  assert.equal(isNotifiable({ role: 'assistant', content: 'ok', display_kind: 'hidden' }), false);
});

test('Hermes 不可达时 tick 抛错但状态可继续使用', async () => {
  const poller = createPoller({
    apiKey: 'key',
    fetchImpl: async () => new Response('boom', { status: 500 }),
    onEvents: async () => assert.fail('不应调用'),
  });
  await assert.rejects(poller.tick(), /sessions 500/);
});
