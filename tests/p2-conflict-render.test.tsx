/**
 * P2 同步冲突可视化渲染测试（设计 §4 P2、§5.3、§14.3）：
 * 409 / 「可能已提交且服务端已有回复」→ 顶部「查看差异」入口，点击打开对照弹层；
 * 未确认提交但服务端没有回复时不出现冲突入口（保持原有提示）。
 * 运行：npx tsx --tsconfig tests/tsconfig.render.json --test tests/p2-conflict-render.test.tsx
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
import type { OutboundTurn, ServerConnection, Session } from '../src/domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import ChatScreen from '../app/(main)/chat/[serverId]/[sessionId]';

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

const session: Session = { serverId: 'srv-1', id: 'sess-1', title: '磁盘检查', updatedAt: Date.now() };

const server: ServerConnection = {
  id: 'srv-1',
  name: '演示实例',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred-1',
  capabilities: {
    mode: 'native_runs',
    features: { run_submission: true, run_status: true, run_events_sse: true, sessions_list: true, session_messages: true },
    checkedAt: Date.now(),
  },
  createdAt: 0,
};

/** 一条没拿到服务端确认的提交记录：recover 会把它标成 submission_uncertain，send 会因此抛 409。 */
const pendingTurn: OutboundTurn = {
  clientTurnId: 'turn-1',
  serverId: 'srv-1',
  sessionId: 'sess-1',
  idempotencyKey: 'key-1',
  requestBodyJson: '{"input":"检查磁盘"}',
  submissionState: 'submitting',
  createdAt: Date.now(),
};

type RawMessage = { role: string; content: string };

function memoryRepository(turns: OutboundTurn[]): Repository {
  return {
    init: async () => {},
    listServers: async () => [server],
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => [session],
    saveSessions: async () => {},
    deleteSession: async () => {},
    listMessages: async () => [],
    replaceMessages: async () => {},
    saveTurn: async () => {},
    listTurns: async () => turns,
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

function install(options: { messages: RawMessage[]; turns?: OutboundTurn[] }) {
  const repository = memoryRepository(options.turns ?? []);
  const fakeFetch = async (url: string) => {
    const body = url.includes('/messages') ? { messages: options.messages } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = new HermesService({ repository, vault, fetch: fakeFetch as never });
  configureAppServices({ repository, vault, service });
  return { service };
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

async function press(tree: ReturnType<typeof create>, label: string) {
  const node = firstByLabel(tree, label);
  await act(async () => {
    node.props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test('409 时出现「查看差异」，点击后弹层给出两种处理方式', async () => {
  const { service } = install({ messages: [{ role: 'user', content: '检查磁盘' }], turns: [pendingTurn] });
  const tree = await render(createElement(ChatScreen));
  // 只有未确认提交、服务端没有回复：还不算冲突
  assert.equal(findByLabel(tree, '查看差异').length, 0, '没有服务端回复时不应出现冲突入口');

  // 服务层在提交时发现未确认的记录而抛 409，视图带上 conflict 错误
  await act(async () => {
    await service.send('srv-1', 'sess-1', '再查一次').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(findByLabel(tree, '查看差异').length > 0, '409 时缺少「查看差异」入口');
  assert.match(textOf(tree.toJSON()), /本地与服务端不一致/);

  await press(tree, '查看差异');
  assert.ok(findByLabel(tree, '以服务端为准（丢弃本地草稿）').length > 0, '弹层缺少「以服务端为准」');
  assert.ok(findByLabel(tree, '同键重试提交').length > 0, '弹层缺少「同键重试提交」');
  assert.doesNotMatch(textOf(tree.toJSON()), /本地与服务端不一致/, '弹层打开后不应重复显示冲突文案');

  await act(async () => tree.unmount());
});

test('未确认提交且服务端已有回复时出现冲突入口', async () => {
  install({
    messages: [
      { role: 'user', content: '检查磁盘' },
      { role: 'assistant', content: '磁盘使用率 42%' },
    ],
    turns: [pendingTurn],
  });
  const tree = await render(createElement(ChatScreen));
  assert.ok(findByLabel(tree, '查看差异').length > 0, '可能已执行时缺少「查看差异」入口');
  const json = textOf(tree.toJSON());
  assert.match(json, /可能已提交，需要核对/);
  // 旧的「可能已提交」双按钮横幅被冲突入口取代，避免同一件事出现两个入口
  assert.equal(findByLabel(tree, '核对状态').length, 0, '不应同时保留旧横幅的按钮');

  await press(tree, '查看差异');
  assert.match(textOf(tree.toJSON()), /磁盘使用率 42%/, '弹层应展示服务端最新回复');
  assert.ok(findByLabel(tree, '同键重试提交').length > 0, '弹层缺少「同键重试提交」');

  await act(async () => tree.unmount());
});

test('未确认提交但服务端没有回复时不出现冲突入口，保留原有提示', async () => {
  install({ messages: [{ role: 'user', content: '检查磁盘' }], turns: [pendingTurn] });
  const tree = await render(createElement(ChatScreen));
  assert.equal(findByLabel(tree, '查看差异').length, 0, '不应出现冲突入口');
  assert.doesNotMatch(textOf(tree.toJSON()), /同步差异/);
  assert.ok(findByLabel(tree, '同键重试').length > 0, '应保留原有的「同键重试」提示');
  await act(async () => tree.unmount());
});
