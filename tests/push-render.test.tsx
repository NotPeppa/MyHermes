/**
 * 设置页「通知」分区渲染测试：分区、开关、地址输入、未启用状态行。
 * 运行：npx tsx --tsconfig tests/tsconfig.render.json --test tests/push-render.test.tsx
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { act, create } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppServicesProvider, configureAppServices } from '../src/composition';
import { ThemeProvider } from '../src/ui/theme';
import { HermesService } from '../src/runtime/service';
import { PushBridge, type SocketLike } from '../src/features/notifications/service';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { ServerConnection } from '../src/domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import SettingsScreen from '../app/(main)/settings/index';

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

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

function memoryRepository(settings: Map<string, string>): Repository {
  return {
    init: async () => {},
    listServers: async () => [server],
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => [],
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
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
      settings.set(key, value);
    },
    listPendingCredentialDeletes: async () => [],
    finishCredentialDelete: async () => {},
  };
}

function install(settings: Map<string, string> = new Map()) {
  const repository = memoryRepository(settings);
  const calls: string[] = [];
  const service = new HermesService({
    repository,
    vault,
    fetch: (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never,
  });
  configureAppServices({ repository, vault, service });
  return { repository, calls };
}

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
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return tree!;
}

function firstByLabel(tree: ReturnType<typeof create>, label: string) {
  const [node] = tree.root.findAll((item) => item.props?.accessibilityLabel === label);
  assert.ok(node, `找不到 accessibilityLabel=${label} 的元素`);
  return node;
}

test('设置页渲染「通知」分区、开关与地址输入', async () => {
  install();
  const tree = await render(createElement(SettingsScreen));
  const body = textOf(tree.toJSON());
  assert.match(body, /通知/);
  assert.match(body, /启用推送通知/);
  assert.match(body, /推送桥地址/);
  assert.match(body, /https:\/\/bridge\.example\.com/, '地址输入应带示例占位符');
  assert.match(body, /通知只包含实例、会话与状态；正文需要点开 App 查看。桥由你自己部署。/);

  const toggle = firstByLabel(tree, '启用推送通知');
  assert.equal(toggle.props.accessibilityRole, 'switch');
  assert.equal(toggle.props.accessibilityState?.checked, false);
  assert.ok(firstByLabel(tree, '推送桥地址'), '地址输入应有 accessibilityLabel');
  assert.ok(firstByLabel(tree, '测试推送桥连接'), '测试连接按钮应可访问');
  await act(async () => tree.unmount());
});

test('关闭状态下状态行显示「未启用」', async () => {
  install();
  const tree = await render(createElement(SettingsScreen));
  const body = textOf(tree.toJSON());
  assert.match(body, /状态：未启用/);
  assert.doesNotMatch(body, /已连接/);
  await act(async () => tree.unmount());
});

test('已保存地址但开关关闭时仍显示「未启用」，地址回填到输入框', async () => {
  install(new Map([['push.bridgeUrl', 'https://bridge.example.com'], ['push.enabled', 'false']]));
  const tree = await render(createElement(SettingsScreen));
  const body = textOf(tree.toJSON());
  assert.match(body, /状态：未启用/);
  const input = firstByLabel(tree, '推送桥地址');
  assert.equal(input.props.value, 'https://bridge.example.com');
  await act(async () => tree.unmount());
});

test('通知分区排在「外观」之后', async () => {
  install();
  const tree = await render(createElement(SettingsScreen));
  const body = textOf(tree.toJSON());
  const appearance = body.indexOf('外观');
  const notifications = body.indexOf('启用推送通知');
  assert.ok(appearance >= 0 && notifications > appearance, '「通知」分区应在「外观」之后');
  await act(async () => tree.unmount());
});

/* ---------------------------------------------------------------- 连接状态机 */

class FakeSocket implements SocketLike {
  static created: FakeSocket[] = [];
  static onNext: ((socket: FakeSocket) => void) | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.created.push(this);
    FakeSocket.onNext?.(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  push(data: unknown) {
    this.onmessage?.({ data });
  }
  drop() {
    this.onclose?.();
  }
}

function bridgeFixture(random: () => number) {
  const settings = new Map<string, string>([['push.bridgeUrl', 'https://bridge.example.com']]);
  const repository = memoryRepository(settings);
  const secrets = new Map<string, string>();
  const bridgeVault: CredentialVault = {
    get: async (ref: string) => secrets.get(ref) ?? null,
    set: async (ref: string, key: string) => {
      secrets.set(ref, key);
    },
    remove: async (ref: string) => {
      secrets.delete(ref);
    },
  };
  const requests: string[] = [];
  const fetchImpl = (async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify({ deviceId: 'dev-1', secret: 's3cret' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as never;
  FakeSocket.created = [];
  FakeSocket.onNext = null;
  const bridge = new PushBridge({
    repository,
    vault: bridgeVault,
    baseUrl: 'https://bridge.example.com',
    fetchImpl,
    socket: FakeSocket,
    random,
    platform: 'ios',
  });
  return { bridge, repository, secrets, requests };
}

test('PushBridge：先注册再连 WS，hello 补发与实时事件走同一回调', async () => {
  const { bridge, secrets, requests } = bridgeFixture(() => 0.5);
  const events: string[] = [];
  bridge.onEvent((event) => events.push(event.eventId));
  await bridge.start();

  assert.deepEqual(requests, ['https://bridge.example.com/register']);
  assert.equal(secrets.get('hermes.push.secret.dev-1'), 's3cret', '密钥只进 vault');
  const [socket] = FakeSocket.created;
  assert.ok(socket, '应建立一条 WS 连接');
  assert.equal(socket.url, 'wss://bridge.example.com/ws?deviceId=dev-1&secret=s3cret');
  assert.equal(bridge.state.status, 'connecting');

  socket.open();
  assert.equal(bridge.state.status, 'connected');

  socket.push(JSON.stringify({ type: 'hello', pending: [{ eventId: 'a', serverId: '*', state: 'completed', ts: 1 }] }));
  socket.push(JSON.stringify({ type: 'event', event: { eventId: 'b', serverId: '*', state: 'failed', ts: 2 } }));
  socket.push('{broken');
  assert.deepEqual(events, ['a', 'b'], 'hello.pending 与 event 都投递，坏帧被忽略');

  bridge.stop();
  assert.equal(bridge.state.status, 'idle');
  assert.equal(socket.closed, true);
});

test('PushBridge：断线后按退避重连', async () => {
  // random 0 → 首次退避 1000ms × 0.8 = 800ms
  const { bridge } = bridgeFixture(() => 0);
  await bridge.start();
  const first = FakeSocket.created[0];
  assert.ok(first);
  first.open();
  const next = new Promise<FakeSocket>((resolve) => {
    FakeSocket.onNext = resolve;
  });
  first.drop();
  assert.equal(bridge.state.status, 'error');
  const second = await next;
  assert.notEqual(second, first, '应新建一条连接');
  assert.equal(bridge.state.status, 'connecting');
  bridge.stop();
});
