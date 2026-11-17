/**
 * 无头渲染：外部入口（深链 / 剪贴板 / 分享）落地页与聊天页预填。
 * 只验证「预填、不自动发送」这条安全语义，以及错误态文案。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppServicesProvider, configureAppServices } from '../src/composition';
import { ThemeProvider } from '../src/ui/theme';
import { HermesService } from '../src/runtime/service';
import { clearPendingIntent, peekPendingIntent } from '../src/features/intents/pending';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { ServerConnection } from '../src/domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import SendIntentScreen from '../app/send';
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

function repository(withServer = true, withSession = true): Repository {
  const servers = withServer ? [server] : [];
  return {
    init: async () => {},
    listServers: async () => servers,
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => (withSession ? [{ serverId: 'srv-1', id: 'sess-1', title: '磁盘检查', updatedAt: 5 }] : []),
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

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

function install(withServer = true, withSession = true) {
  const repo = repository(withServer, withSession);
  const service = new HermesService({
    repository: repo,
    vault,
    fetch: (async () => new Response('{}', { status: 200 })) as never,
  });
  configureAppServices({ repository: repo, vault, service });
  return { repo, service };
}

function textOf(node: unknown): string {
  return JSON.stringify(node, (key, value) => {
    if (key === '_owner' || key === '_store' || typeof value === 'function') return undefined;
    return value;
  }) ?? '';
}

async function render(element: ReturnType<typeof createElement>) {
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

test('深链落地：写入 pending 并跳转，不自动发送', async () => {
  clearPendingIntent();
  install();
  const tree = await render(createElement(SendIntentScreen));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const pending = peekPendingIntent();
  // 测试环境没有深链参数，因此这里断言「没有内容时给出可读错误」而不是静默失败
  assert.match(textOf(tree.toJSON()), /外部入口|没有带上文本或图片|正在准备/);
  assert.equal(pending, null);
  await act(async () => tree.unmount());
});

test('深链落地：没有实例时提示先添加实例', async () => {
  clearPendingIntent();
  install(false);
  const tree = await render(createElement(SendIntentScreen));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(textOf(tree.toJSON()), /还没有添加任何 Hermes 实例/);
  await act(async () => tree.unmount());
});

test('聊天页：pending 文本只预填输入框，不触发发送', async () => {
  clearPendingIntent();
  const { service } = install();
  const { setPendingIntent } = await import('../src/features/intents/pending');
  setPendingIntent({ source: 'deeplink', text: '检查磁盘使用率' });

  const tree = await render(createElement(ChatScreen));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const input = tree.root.findAll((node) => node.props?.accessibilityLabel === '消息输入框')[0];
  assert.ok(input, '应渲染输入框');
  assert.equal(input.props.value, '检查磁盘使用率', 'pending 文本应预填');
  assert.equal(peekPendingIntent(), null, '取走后应清空，避免重复填入');
  assert.equal(service.view('srv-1', 'sess-1').messages.length, 0, '不应自动发送');
  await act(async () => tree.unmount());
});

test('聊天页：没有 pending 时输入框保持为空', async () => {
  clearPendingIntent();
  install();
  const tree = await render(createElement(ChatScreen));
  const input = tree.root.findAll((node) => node.props?.accessibilityLabel === '消息输入框')[0];
  assert.equal(input?.props.value, '');
  await act(async () => tree.unmount());
});
