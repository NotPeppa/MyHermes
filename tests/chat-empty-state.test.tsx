/**
 * 空会话的「还没有消息」必须正着显示。
 * 聊天列表是 inverted 的，把 ListEmptyComponent 放进去会被镜像（真机实测文字左右翻转），
 * 所以空态必须渲染在列表之外——这里锁住结构，避免有人再挪回去。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppServicesProvider, configureAppServices } from '../src/composition';
import { ThemeProvider } from '../src/ui/theme';
import { HermesService } from '../src/runtime/service';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { ServerConnection } from '../src/domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import ChatScreen from '../app/(main)/chat/[serverId]/[sessionId]';

const server: ServerConnection = {
  id: 'srv-1',
  name: '演示实例',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred-1',
  capabilities: {
    mode: 'native_runs',
    features: { run_submission: true, run_status: true, run_events_sse: true, sessions_list: true, session_messages: true, session_chat_stream: true },
    checkedAt: Date.now(),
  },
  createdAt: 0,
};

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

function repository(): Repository {
  return {
    init: async () => {},
    listServers: async () => [server],
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => [{ serverId: 'srv-1', id: 'sess-1', title: '新会话', updatedAt: 0 }],
    saveSessions: async () => {},
    deleteSession: async () => {},
    listMessages: async () => [],
    replaceMessages: async () => {},
    saveTurn: async () => {},
    listTurns: async () => [],
    saveRun: async () => {},
    listRuns: async () => [],
    saveToolEvent: async () => {},
    listToolEvents: async () => [],
    clearCache: async () => {},
    getSetting: async () => null,
    setSetting: async () => {},
    listPendingCredentialDeletes: async () => [],
    finishCredentialDelete: async () => {},
  };
}

function textOf(node: unknown): string {
  return JSON.stringify(node, (key, value) => {
    if (key === '_owner' || key === '_store' || typeof value === 'function') return undefined;
    return value;
  }) ?? '';
}

test('空会话：空态渲染在 inverted 列表之外，且没有残留的翻转补偿', async () => {
  const repo = repository();
  const service = new HermesService({
    repository: repo,
    vault,
    fetch: (async () => new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never,
  });
  configureAppServices({ repository: repo, vault, service });

  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      createElement(
        SafeAreaProvider,
        null,
        createElement(ThemeProvider, null, createElement(AppServicesProvider, null, createElement(ChatScreen))),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const json = textOf(tree!.toJSON());
  assert.match(json, /还没有消息/, '空态文案应存在');
  assert.doesNotMatch(json, /scaleY/, '空态不应再依赖 scaleY 翻转补偿');
  const lists = tree!.root.findAll((node) => node.props?.inverted === true);
  assert.equal(lists.length, 0, '没有消息时不应渲染 inverted 列表');
  await act(async () => tree!.unmount());
});

test('输入区在 Android 上也必须避让键盘（edge-to-edge 下 adjustResize 不生效）', async () => {
  const repo = repository();
  const service = new HermesService({
    repository: repo,
    vault,
    fetch: (async () => new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never,
  });
  configureAppServices({ repository: repo, vault, service });

  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      createElement(
        SafeAreaProvider,
        null,
        createElement(ThemeProvider, null, createElement(AppServicesProvider, null, createElement(ChatScreen))),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const avoider = tree!.root.findAll((node) => String(node.type) === 'KeyboardAvoidingView')[0];
  assert.ok(avoider, '应渲染 KeyboardAvoidingView');
  assert.equal(avoider.props.behavior, 'padding', 'Android 也必须用 padding 顶起输入栏');
  await act(async () => tree!.unmount());
});

test('消息时间：解析官方 timestamp，缺失时不显示假时间；用户靠右、Hermes 靠左', async () => {
  const { SessionsAdapter } = await import('../src/adapters/hermes/client');
  const { Transport } = await import('../src/api/transport');
  const payload = {
    object: 'list',
    session_id: 'sess-1',
    data: [
      { id: 'm1', role: 'user', content: '晚上好', timestamp: '2026-11-17T14:39:00Z' },
      { id: 'm2', role: 'assistant', content: '晚上好呀', timestamp: 1763390340 },
      { id: 'm3', role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
      { id: 'm4', role: 'assistant', content: '旧消息', display_kind: 'hidden' },
      { id: 'm5', role: 'user', content: '没有时间戳' },
    ],
  };
  const adapter = new SessionsAdapter(
    new Transport('https://example.test', 'key', (async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })) as never),
    'srv-1',
  );
  const messages = await adapter.messages('sess-1');
  const ids = messages.map((message) => message.serverMessageId);
  assert.deepEqual(ids, ['m1', 'm2', 'm5'], '工具调用空消息与压缩脚手架消息应被过滤');
  assert.equal(messages[0]?.createdAt, Date.parse('2026-11-17T14:39:00Z'), 'ISO 时间戳应被解析');
  assert.equal(messages[1]?.createdAt, 1763390340000, '秒级时间戳应换算成毫秒');
  assert.ok((messages[2]?.createdAt ?? 0) < 1e11, '缺时间戳时用序号占位');

  const { hasKnownTime } = await import('../src/ui/format');
  assert.equal(hasKnownTime(messages[0]?.createdAt), true);
  assert.equal(hasKnownTime(messages[2]?.createdAt), false, '占位序号不能被当成真实时间');
});

test('工具输出默认折叠成一行摘要，展开后才显示全文', async () => {
  const { MessageItem } = await import('../src/ui/message-item');
  const toolMessage = {
    id: 'm-tool',
    serverId: 'srv-1',
    sessionId: 'sess-1',
    role: 'tool' as const,
    body: `<untrusted_tool_result source="web_search">\n${'x'.repeat(400)}\n第二行\n第三行`,
    createdAt: Date.now(),
  };
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      createElement(
        SafeAreaProvider,
        null,
        createElement(ThemeProvider, null, createElement(MessageItem, { message: toolMessage })),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const collapsed = textOf(tree!.toJSON());
  assert.match(collapsed, /展开 · 4 行/, '折叠时显示行数提示');
  assert.doesNotMatch(collapsed, /第二行/, '折叠时不应渲染后续行');

  const toggle = tree!.root.findAll((node) => String(node.props?.accessibilityLabel ?? '').startsWith('工具输出'))[0];
  assert.ok(toggle, '应渲染折叠卡片');
  await act(async () => {
    toggle.props.onPress?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(textOf(tree!.toJSON()), /第二行/, '展开后显示全文');
  await act(async () => tree!.unmount());
});

test('停止按钮只出现在输入栏，不重复；上游状态仅在 unknown 时显示', async () => {
  const baseRepo = repository();
  const withStop = {
    ...server,
    capabilities: { ...server.capabilities, features: { ...server.capabilities.features, run_stop: true } },
  };
  const repo = { ...baseRepo, listServers: async () => [withStop] };
  const runningRun = {
    runId: 'run-1',
    serverId: 'srv-1',
    sessionId: 'sess-1',
    clientTurnId: 't1',
    idempotencyKey: 'k1',
    requestBodyJson: '{}',
    status: 'running' as const,
    rawStatus: 'started',
    updatedAt: Date.now(),
  };
  const service = new HermesService({
    repository: { ...repo, listRuns: async () => [runningRun] },
    vault,
    fetch: (async () => new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never,
  });
  configureAppServices({ repository: { ...repo, listRuns: async () => [runningRun] }, vault, service });

  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      createElement(
        SafeAreaProvider,
        null,
        createElement(ThemeProvider, null, createElement(AppServicesProvider, null, createElement(ChatScreen))),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const stops = tree!.root
    .findAll((node) => /停止/.test(String(node.props?.accessibilityLabel ?? '')))
    .map((node) => String(node.props.accessibilityLabel));
  assert.equal(new Set(stops).size, 1, `停止入口应只有一个，实际：${stops.join(' | ')}`);
  assert.match(stops[0] ?? '', /停止当前运行/);

  const body = textOf(tree!.toJSON());
  assert.doesNotMatch(body, /上游：started/, 'running↔started 的映射差异不该显示给用户');
  await act(async () => tree!.unmount());
});
