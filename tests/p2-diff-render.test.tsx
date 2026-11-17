/**
 * P2 结构化文件 diff 渲染：工具卡片识别 diff 后结构化展示，识别失败保持纯文本。
 * 运行：npx tsx --tsconfig tests/tsconfig.render.json --test tests/p2-diff-render.test.tsx
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
import type { Run, ServerConnection, Session, ToolEvent } from '../src/domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import ChatScreen from '../app/(main)/chat/[serverId]/[sessionId]';

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

const session: Session = { serverId: 'srv-1', id: 'sess-1', title: '磁盘检查', updatedAt: Date.now() };

const run: Run = {
  runId: 'local-1',
  serverId: 'srv-1',
  sessionId: 'sess-1',
  clientTurnId: 'turn-1',
  idempotencyKey: 'idem-1',
  requestBodyJson: '{}',
  status: 'completed',
  updatedAt: Date.now(),
};

const server: ServerConnection = {
  id: 'srv-1',
  name: '演示实例',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred-1',
  capabilities: {
    mode: 'native_runs',
    features: { run_submission: true, run_status: true, run_events_sse: true },
    checkedAt: Date.now(),
  },
  createdAt: 0,
};

const DIFF_PREVIEW = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-const x = 1;',
  '+const x = 2;',
].join('\n');

function toolEvent(preview: string): ToolEvent {
  return {
    id: 'tool-1',
    serverId: 'srv-1',
    runId: 'local-1',
    toolName: 'Bash',
    eventType: 'completed',
    preview,
    recordedAt: Date.now(),
  };
}

function memoryRepository(event: ToolEvent): Repository {
  return {
    init: async () => {},
    listServers: async () => [server],
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => [session],
    saveSessions: async () => {},
    deleteSession: async () => {},
    listMessages: async () => [
      { id: 'm1', serverId: 'srv-1', sessionId: 'sess-1', role: 'user' as const, body: '改一下常量', createdAt: 1 },
    ],
    replaceMessages: async () => {},
    saveTurn: async () => {},
    listTurns: async () => [],
    saveRun: async () => {},
    listRuns: async () => [run],
    saveToolEvent: async () => {},
    listToolEvents: async () => [event],
    clearCache: async () => {},
    getSetting: async () => null,
    setSetting: async () => {},
    listPendingCredentialDeletes: async () => [],
    finishCredentialDelete: async () => {},
  };
}

const fakeFetch = async (url: string) => {
  const body = url.includes('/messages') ? { messages: [{ role: 'user', content: '改一下常量' }] } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

function install(preview: string) {
  const repository = memoryRepository(toolEvent(preview));
  const service = new HermesService({ repository, vault, fetch: fakeFetch as never });
  configureAppServices({ repository, vault, service });
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

function firstByLabel(tree: ReturnType<typeof create>, label: string) {
  const [node] = tree.root.findAll((item) => item.props?.accessibilityLabel === label);
  assert.ok(node, `找不到 accessibilityLabel=${label} 的元素`);
  return node;
}

async function toggle(tree: ReturnType<typeof create>) {
  await act(async () => {
    firstByLabel(tree, '工具 Bash，执行完成').props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test('diff 预览渲染文件名与 +1/−1 统计', async () => {
  install(DIFF_PREVIEW);
  const tree = await render(createElement(ChatScreen));
  await toggle(tree);
  const json = textOf(tree.toJSON());
  assert.match(json, /src\/app\.ts/, '缺少文件名');
  assert.match(json, /\+1 −1/, '缺少 +1 −1 统计');
  assert.match(json, /@@ -1,2 \+1,2 @@/, '缺少 hunk 头');
  assert.ok(
    tree.root.findAll((node) => node.props?.accessibilityLabel === '文件 src/app.ts，新增 1 行，删除 1 行').length > 0,
    '缺少 diff 容器的无障碍标签',
  );
  await act(async () => tree.unmount());
});

test('非 diff 预览保持纯文本', async () => {
  install('构建成功，用时 3.2s');
  const tree = await render(createElement(ChatScreen));
  await toggle(tree);
  const json = textOf(tree.toJSON());
  assert.match(json, /构建成功，用时 3\.2s/, '纯文本预览应原样展示');
  assert.doesNotMatch(json, /新增 1 行/, '普通文本不应被当成 diff');
  await act(async () => tree.unmount());
});

test('超过 200 行只渲染上限并提示总行数', async () => {
  const body = Array.from({ length: 260 }, (_, index) => `+第 ${index} 行`).join('\n');
  install(['--- a/big.txt', '+++ b/big.txt', '@@ -1,1 +1,260 @@', body].join('\n'));
  const tree = await render(createElement(ChatScreen));
  await toggle(tree);
  const json = textOf(tree.toJSON());
  assert.match(json, /已截断，共 260 行/, '缺少截断提示');
  assert.doesNotMatch(json, /第 259 行/, '超出上限的行不应渲染');
  await act(async () => tree.unmount());
});

test('展开后可以折叠回去', async () => {
  install(DIFF_PREVIEW);
  const tree = await render(createElement(ChatScreen));
  await toggle(tree);
  assert.match(textOf(tree.toJSON()), /src\/app\.ts/);
  await toggle(tree);
  assert.doesNotMatch(textOf(tree.toJSON()), /src\/app\.ts/, '折叠后不应再渲染 diff');
  await act(async () => tree.unmount());
});
