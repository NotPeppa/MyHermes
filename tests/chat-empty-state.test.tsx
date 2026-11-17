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
