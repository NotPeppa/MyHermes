/**
 * 无头渲染冒烟：用替身 RN/Expo 模块真实渲染每个页面，捕获渲染期崩溃。
 * 运行：npx tsx --tsconfig tests/tsconfig.render.json --test tests/render.test.tsx
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { act, create } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppServicesProvider, configureAppServices } from '../src/composition';
import { ThemeProvider } from '../src/ui/theme';
import { HermesService } from '../src/runtime/service';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { ServerConnection } from '../src/domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import AddServer from '../app/(onboarding)/add-server';
import SessionsScreen from '../app/(main)/sessions/index';
import ChatScreen from '../app/(main)/chat/[serverId]/[sessionId]';
import ServersScreen from '../app/(main)/settings/servers';
import SettingsScreen from '../app/(main)/settings/index';
import Index from '../app/index';
import RootLayout from '../app/_layout';

const server: ServerConnection = {
  id: 'srv-1',
  name: '演示实例',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred-1',
  capabilities: {
    mode: 'native_runs',
    features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_approval: true, sessions_list: true, session_messages: true, session_chat_stream: true },
    checkedAt: Date.now(),
  },
  createdAt: 0,
};

function memoryRepository(withServer = true): Repository {
  const servers = withServer ? [server] : [];
  return {
    init: async () => {},
    listServers: async () => servers,
    saveServer: async (next) => {
      const index = servers.findIndex((item) => item.id === next.id);
      if (index >= 0) servers[index] = next;
      else servers.push(next);
    },
    deleteServer: async () => {},
    listSessions: async () => [{ serverId: 'srv-1', id: 'sess-1', title: '磁盘检查', updatedAt: Date.now() }],
    saveSessions: async () => {},
    deleteSession: async () => {},
    listMessages: async () => [
      { id: 'm1', serverId: 'srv-1', sessionId: 'sess-1', role: 'user' as const, body: '检查磁盘', createdAt: 1 },
      { id: 'm2', serverId: 'srv-1', sessionId: 'sess-1', role: 'assistant' as const, body: '**完成**\n\n```bash\ndf -h\n```', createdAt: 2 },
    ],
    replaceMessages: async () => {},
    saveTurn: async () => {},
    listTurns: async () => [],
    saveRun: async () => {},
    listRuns: async () => [{
      runId: 'run-1', serverId: 'srv-1', sessionId: 'sess-1', clientTurnId: 't1', idempotencyKey: 'k1',
      requestBodyJson: '{"input":"检查磁盘"}', status: 'running' as const, updatedAt: Date.now(),
      pendingControls: [{ request_id: 'req-1', execution_generation: 1, type: 'approval', prompt: '允许执行 rm -rf /tmp/demo ?', choices: ['once', 'deny'] }],
    }],
    saveToolEvent: async () => {},
    listToolEvents: async () => [{ id: 'tool-1', serverId: 'srv-1', runId: 'run-1', toolName: 'terminal', eventType: 'completed', preview: 'df -h', recordedAt: 3 }],
    clearCache: async () => {},
    getSetting: async () => null,
    setSetting: async () => {},
    listPendingCredentialDeletes: async () => [],
    finishCredentialDelete: async () => {},
  };
}

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

// 按端点返回结构正确的响应，避免渲染期把 fixture 错误当成真实协议错误
const fakeFetch = async (url: string) => {
  const body = url.includes('/api/sessions/') && url.includes('/messages')
    ? { messages: [{ role: 'user', content: '检查磁盘' }, { role: 'assistant', content: '磁盘使用率 40%' }] }
    : url.includes('/api/sessions')
      ? { sessions: [{ id: 'sess-1', title: '磁盘检查', updated_at: Date.now() }] }
      : url.includes('/v1/runs/')
        ? { run_id: 'run-1', status: 'running', session_id: 'sess-1', output: '', pending_controls: [{ request_id: 'req-1', execution_generation: 1, type: 'approval', prompt: '允许执行 rm -rf /tmp/demo ?', choices: ['once', 'deny'] }] }
        : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

function install(withServer = true) {
  const repository = memoryRepository(withServer);
  const service = new HermesService({ repository, vault, fetch: fakeFetch as never });
  configureAppServices({ repository, vault, service });
  return { repository, service };
}

/** props 里可能带 React 元素（如 refreshControl），直接 stringify 会循环引用。 */
function textOf(node: unknown): string {
  return JSON.stringify(node, (key, value) => {
    if (key === '_owner' || key === '_store' || typeof value === 'function') return undefined;
    return value;
  }) ?? '';
}

async function render(element: ComponentType | ReturnType<typeof createElement>) {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      createElement(
        SafeAreaProvider,
        null,
        createElement(ThemeProvider, null, createElement(AppServicesProvider, null, element as never)),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return tree!;
}

const screens: Array<[string, ComponentType]> = [
  ['连接页', AddServer],
  ['会话列表', SessionsScreen],
  ['聊天详情', ChatScreen],
  ['服务器管理', ServersScreen],
  ['设置', SettingsScreen],
  ['入口分流', Index],
  ['根布局', RootLayout],
];

for (const [name, Screen] of screens) {
  test(`渲染不崩溃：${name}`, async () => {
    install();
    const tree = await render(createElement(Screen));
    const json = textOf(tree.toJSON());
    assert.ok(json.length > 0, `${name} 渲染结果为空`);
    await act(async () => tree.unmount());
  });
}

test('无实例时连接页显示表单字段', async () => {
  install(false);
  const tree = await render(createElement(AddServer));
  const json = textOf(tree.toJSON());
  assert.match(json, /服务器 URL|连接名称|API Key/);
  await act(async () => tree.unmount());
});

test('聊天页展示审批卡片与工具卡片', async () => {
  install();
  const tree = await render(createElement(ChatScreen));
  const json = textOf(tree.toJSON());
  assert.match(json, /等待操作审批|允许执行/);
  assert.match(json, /terminal|df -h/);
  await act(async () => tree.unmount());
});

test('空闲会话显示"可发送消息"而不是未知状态', async () => {
  const repository = memoryRepository();
  const idleRepository: Repository = { ...repository, listRuns: async () => [] };
  const service = new HermesService({ repository: idleRepository, vault, fetch: fakeFetch as never });
  configureAppServices({ repository: idleRepository, vault, service });
  const tree = await render(createElement(ChatScreen));
  const json = textOf(tree.toJSON());
  assert.match(json, /可发送消息/);
  assert.doesNotMatch(json, /未知状态：idle/);
  await act(async () => tree.unmount());
});

test('设置页明确本地库未启用 SQLCipher', async () => {
  install();
  const tree = await render(createElement(SettingsScreen));
  const json = textOf(tree.toJSON());
  assert.match(json, /SQLCipher/);
  await act(async () => tree.unmount());
});

test('会话列表展示缓存标题与实例名', async () => {
  install();
  const tree = await render(createElement(SessionsScreen));
  const json = textOf(tree.toJSON());
  assert.match(json, /磁盘检查|演示实例/);
  await act(async () => tree.unmount());
});

test('标记渲染完成后不残留服务订阅', async () => {
  const { service } = install();
  const tree = await render(createElement(ChatScreen));
  await act(async () => tree.unmount());
  // 卸载后再次触发视图变更不应抛错（订阅已释放）
  await act(async () => {
    service.detach('srv-1', 'sess-1');
  });
});
