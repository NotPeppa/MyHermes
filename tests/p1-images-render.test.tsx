/**
 * P1 图片附件渲染测试：入口按模式开关、隐私提示。
 * 运行：npx tsx --tsconfig tests/tsconfig.render.json --test tests/p1-images-render.test.tsx
 *
 * 注意：react-native 替身没有 Image 组件，且不改替身；因此这里不预置已选图片，
 * 只断言按钮与文案（预览条的缩略图需要真实 Image，留给真机回归）。
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
import type { HermesMode, ServerConnection, Session } from '../src/domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import ChatScreen from '../app/(main)/chat/[serverId]/[sessionId]';

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

const session: Session = { serverId: 'srv-1', id: 'sess-1', title: '磁盘检查', updatedAt: Date.now() };

function makeServer(mode: HermesMode): ServerConnection {
  return {
    id: 'srv-1',
    name: '演示实例',
    baseUrl: 'https://hermes.example.com',
    credentialRef: 'cred-1',
    capabilities: {
      mode,
      features: { sessions_list: true, session_messages: true },
      checkedAt: Date.now(),
    },
    createdAt: 0,
  };
}

function memoryRepository(server: ServerConnection): Repository {
  return {
    init: async () => {},
    listServers: async () => [server],
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => [session],
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

const fakeFetch = async (url: string) => {
  const body = url.includes('/api/sessions/') && url.includes('/messages')
    ? { messages: [{ role: 'user', content: '检查磁盘' }] }
    : url.includes('/api/sessions')
      ? { sessions: [{ id: 'sess-1', title: '磁盘检查', updated_at: Date.now() }] }
      : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

function install(mode: HermesMode) {
  const repository = memoryRepository(makeServer(mode));
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

async function render() {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      createElement(
        SafeAreaProvider,
        null,
        createElement(ThemeProvider, null, createElement(AppServicesProvider, null, createElement(ChatScreen))),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return tree!;
}

function findByLabel(tree: ReturnType<typeof create>, label: string) {
  return tree.root.findAll((node) => node.props?.accessibilityLabel === label);
}

test('openai_compat 模式渲染出「添加图片」按钮', async () => {
  install('openai_compat');
  const tree = await render();
  assert.ok(findByLabel(tree, '添加图片').length > 0, '缺少图片附件按钮');
  await act(async () => tree.unmount());
});

test('native_runs 模式不渲染图片入口，也没有禁用占位', async () => {
  install('native_runs');
  const tree = await render();
  assert.equal(findByLabel(tree, '添加图片').length, 0, '非兼容模式不应出现图片按钮');
  const json = textOf(tree.toJSON());
  assert.doesNotMatch(json, /添加图片/);
  assert.doesNotMatch(json, /添加图片/, '没有会话流式接口时不应出现图片入口');
  await act(async () => tree.unmount());
});

test('openai_compat 模式渲染图片入口（隐私提示已移除）', async () => {
  install('openai_compat');
  const tree = await render();
  // 隐私提示已按需求移除；压缩与去元数据仍由 picker 的 accessibilityHint 说明
  assert.match(textOf(tree.toJSON()), /添加图片/);
  await act(async () => tree.unmount());
});
