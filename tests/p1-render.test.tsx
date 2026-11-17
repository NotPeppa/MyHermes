/**
 * P1 界面能力渲染测试：搜索、会话分支、模型选择、分支来源提示。
 * 运行：npx tsx --tsconfig tests/tsconfig.render.json --test tests/p1-render.test.tsx
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
import type { ServerConnection, Session } from '../src/domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import SessionsScreen from '../app/(main)/sessions/index';
import ChatScreen from '../app/(main)/chat/[serverId]/[sessionId]';

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

const session: Session = { serverId: 'srv-1', id: 'sess-1', title: '磁盘检查', updatedAt: Date.now() };

function makeServer(features: Record<string, boolean>): ServerConnection {
  return {
    id: 'srv-1',
    name: '演示实例',
    baseUrl: 'https://hermes.example.com',
    credentialRef: 'cred-1',
    capabilities: {
      mode: 'native_runs',
      features: {
        run_submission: true,
        run_status: true,
        run_events_sse: true,
        sessions_list: true,
        session_messages: true,
        ...features,
      },
      checkedAt: Date.now(),
    },
    createdAt: 0,
  };
}

function memoryRepository(server: ServerConnection, sessions: Session[]): Repository {
  return {
    init: async () => {},
    listServers: async () => [server],
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => sessions,
    saveSessions: async () => {},
    deleteSession: async () => {},
    listMessages: async () => [
      { id: 'm1', serverId: 'srv-1', sessionId: 'sess-1', role: 'user' as const, body: '检查磁盘', createdAt: 1 },
    ],
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

// 只覆盖渲染期会走到的端点；P1 能力本身由页面能力旗标驱动
const fakeFetch = async (url: string) => {
  const body = url.includes('/api/sessions/') && url.includes('/messages')
    ? { messages: [{ role: 'user', content: '检查磁盘' }] }
    : url.includes('/api/sessions')
      ? { sessions: [{ id: 'sess-1', title: '磁盘检查', updated_at: Date.now() }] }
      : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

function install(options: { features?: Record<string, boolean>; sessions?: Session[] } = {}) {
  const repository = memoryRepository(makeServer(options.features ?? {}), options.sessions ?? [session]);
  const service = new HermesService({ repository, vault, fetch: fakeFetch as never });
  configureAppServices({ repository, vault, service });
  return { repository, service };
}

/** props 里可能带 React 元素，直接 stringify 会循环引用。 */
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

function findByLabel(tree: ReturnType<typeof create>, label: string) {
  return tree.root.findAll((node) => node.props?.accessibilityLabel === label);
}

function firstByLabel(tree: ReturnType<typeof create>, label: string) {
  const [node] = findByLabel(tree, label);
  assert.ok(node, `找不到 accessibilityLabel=${label} 的元素`);
  return node;
}

function findLabelsStartingWith(tree: ReturnType<typeof create>, prefix: string) {
  return tree.root.findAll(
    (node) => typeof node.props?.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith(prefix),
  );
}

test('会话列表渲染搜索框（accessibilityLabel=搜索会话）', async () => {
  install();
  const tree = await render(createElement(SessionsScreen));
  assert.ok(findByLabel(tree, '搜索会话').length > 0, '缺少搜索框');
  await act(async () => tree.unmount());
});

test('搜索无命中显示空态并可清空恢复全量', async () => {
  install();
  const tree = await render(createElement(SessionsScreen));
  const input = firstByLabel(tree, '搜索会话');
  await act(async () => {
    input.props.onChangeText('不存在的标题');
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  // 200ms 防抖 + 一次本地缓存查询，再单独 act 一次让结果落盘
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  let json = textOf(tree.toJSON());
  assert.match(json, /没有匹配的会话/);
  assert.ok(findByLabel(tree, '清空搜索').length > 0, '空态缺少清空按钮');

  await act(async () => {
    firstByLabel(tree, '清空搜索').props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  json = textOf(tree.toJSON());
  assert.doesNotMatch(json, /没有匹配的会话/);
  assert.match(json, /磁盘检查/, '清空后应恢复全量列表');
  await act(async () => tree.unmount());
});

test('session_fork 能力存在时菜单有「分支会话」', async () => {
  install({ features: { session_fork: true } });
  const tree = await render(createElement(SessionsScreen));
  assert.match(textOf(tree.toJSON()), /分支会话/);
  await act(async () => tree.unmount());
});

test('session_fork 能力缺失时菜单没有「分支会话」', async () => {
  install();
  const tree = await render(createElement(SessionsScreen));
  assert.doesNotMatch(textOf(tree.toJSON()), /分支会话/);
  await act(async () => tree.unmount());
});

test('model_options 能力存在时聊天页显示模型 chip', async () => {
  install({ features: { model_options: true } });
  const tree = await render(createElement(ChatScreen));
  assert.ok(
    findByLabel(tree, '当前模型：默认模型，点击切换').length > 0,
    '缺少模型 chip（默认应显示「默认模型」）',
  );
  await act(async () => tree.unmount());
});

test('model_options 能力缺失时聊天页没有模型入口', async () => {
  install();
  const tree = await render(createElement(ChatScreen));
  assert.equal(findLabelsStartingWith(tree, '当前模型：').length, 0, '不应出现模型 chip');
  assert.doesNotMatch(textOf(tree.toJSON()), /默认模型/);
  await act(async () => tree.unmount());
});

test('分支来源会话显示「分支自」提示', async () => {
  install({ sessions: [{ ...session, forkedFrom: 'sess-0' }] });
  const tree = await render(createElement(ChatScreen));
  const json = textOf(tree.toJSON());
  assert.match(json, /分支自/);
  assert.match(json, /sess-0/);
  await act(async () => tree.unmount());
});

test('普通会话不显示「分支自」提示', async () => {
  install();
  const tree = await render(createElement(ChatScreen));
  assert.doesNotMatch(textOf(tree.toJSON()), /分支自/);
  await act(async () => tree.unmount());
});

test('模型抽屉按提供商分组，组头带数量', async () => {
  const repository = memoryRepository(makeServer({ model_options: true }), [{ serverId: 'srv-1', id: 'sess-1', title: '会话', updatedAt: 1 }]);
  const service = new HermesService({
    repository,
    vault,
    fetch: (async (url: string) => {
      if (url.includes('/api/model/options')) {
        return new Response(JSON.stringify({
          providers: [
            { slug: 'codex', label: 'Codex', models: ['gpt-6.1-sol', 'gpt-5.6-luna'] },
            { slug: 'nous', label: 'Nous Research', models: ['hermes-4-405b'] },
          ],
          model: 'gpt-6.1-sol',
          provider: 'codex',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never,
  });
  configureAppServices({ repository, vault, service });

  const tree = await render(createElement(ChatScreen));
  const chip = tree.root.findAll((node) => String(node.props?.accessibilityLabel ?? '').startsWith('当前模型'))[0];
  assert.ok(chip, '应渲染模型 chip');
  await act(async () => {
    chip.props.onPress?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const body = textOf(tree.toJSON());
  assert.match(body, /Codex（2）/, '应有 codex 组头');
  assert.match(body, /Nous Research（1）/, '应有 nous 组头');

  // 默认只展开包含当前模型（gpt-6.1-sol）的 codex 组，nous 组收起
  const headerNodes = tree.root.findAll((node) => /个模型，已(展开|折叠)/.test(String(node.props?.accessibilityLabel ?? '')));
  // 同一个可访问容器可能被组件与宿主节点各匹配一次，按标签去重
  const headers = [...new Map(headerNodes.map((node) => [String(node.props.accessibilityLabel), node])).values()];
  assert.equal(headers.length, 2, `两个组头都应可折叠，实际：${headers.map((node) => node.props.accessibilityLabel).join(' | ')}`);
  const codexHeader = headers.find((node) => String(node.props.accessibilityLabel).startsWith('Codex'));
  const nousHeader = headers.find((node) => String(node.props.accessibilityLabel).startsWith('Nous Research'));
  assert.equal(codexHeader?.props.accessibilityState?.expanded, true, 'codex 组默认展开');
  assert.equal(nousHeader?.props.accessibilityState?.expanded, false, 'nous 组默认收起');
  assert.doesNotMatch(body, /hermes-4-405b/, '收起的组不应渲染模型行');

  // 展开 nous 组后应出现它的模型
  await act(async () => {
    nousHeader?.props.onPress?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(textOf(tree.toJSON()), /hermes-4-405b/, '展开后应显示模型行');
  await act(async () => tree.unmount());
});
