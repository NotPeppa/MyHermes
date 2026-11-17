/**
 * 连接诊断的分层执行：第 ① 步失败后必须立刻停手，不能继续往下探测，
 * 也不能留下永远转圈的「检测中」。
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import AddServerScreen from '../app/(onboarding)/add-server';

const saves: string[] = [];

function repository(): Repository {
  return {
    init: async () => {},
    listServers: async () => [],
    saveServer: async (server) => {
      saves.push(server.id);
    },
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
    getSetting: async () => null,
    setSetting: async () => {},
    listPendingCredentialDeletes: async () => [],
    finishCredentialDelete: async () => {},
  };
}

const vault: CredentialVault = { get: async () => null, set: async () => {}, remove: async () => {} };

const calls: string[] = [];

function install(fetcher: (url: string) => Promise<Response>) {
  const repo = repository();
  const service = new HermesService({
    repository: repo,
    vault,
    fetch: (async (url: string) => {
      calls.push(url);
      return fetcher(url);
    }) as never,
  });
  configureAppServices({ repository: repo, vault, service });
}

async function mount() {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      createElement(
        SafeAreaProvider,
        null,
        createElement(ThemeProvider, null, createElement(AppServicesProvider, null, createElement(AddServerScreen))),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return tree!;
}

function field(tree: ReturnType<typeof create>, label: string) {
  const matches = tree.root.findAll((node) => node.props?.accessibilityLabel === label || node.props?.label === label);
  return matches[0];
}

async function fillAndProbe(tree: ReturnType<typeof create>, url: string, key: string) {
  const urlField = field(tree, '服务器 URL');
  const keyField = field(tree, 'API Key');
  await act(async () => {
    urlField?.props.onChangeText?.(url);
    keyField?.props.onChangeText?.(key);
  });
  const button = tree.root.findAll((node) => node.props?.label === '开始诊断' || node.props?.label === '重新诊断')[0];
  assert.ok(button, '应能找到诊断按钮');
  await act(async () => {
    button.props.onPress?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

function stageLabels(tree: ReturnType<typeof create>): string[] {
  const labels = tree.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string' && /^[①②③④]/.test(node.props.accessibilityLabel))
    .map((node) => node.props.accessibilityLabel as string);
  // 同一个可访问容器可能被宿主与包装节点各匹配一次，按标签去重
  return [...new Set(labels)];
}

test('主机不可达：只发一次请求，后续阶段标记为未执行', async () => {
  calls.length = 0;
  install(async () => {
    throw new TypeError('Network request failed');
  });
  const tree = await mount();
  await fillAndProbe(tree, 'https://unreachable.example.com', 'key');

  assert.equal(calls.length, 1, '第一步失败后不应再发任何请求');
  assert.match(calls[0] ?? '', /\/v1\/capabilities$/, '唯一的请求就是能力探测本身');

  const labels = stageLabels(tree);
  assert.equal(labels.length, 4, `应有四层诊断，实际：${labels.join(' | ')}`);
  assert.match(labels[0] ?? '', /① URL 与 TLS，失败/);
  for (const label of labels.slice(1)) {
    assert.match(label, /未执行/, `第 ① 步失败后其余阶段应为未执行，实际：${label}`);
  }
  assert.ok(!labels.some((label) => /检测中/.test(label)), '不应残留转圈的「检测中」');

  // 诊断未通过时点保存：会重新诊断，但绝不能写入实例
  saves.length = 0;
  // 路由参数 stub 会带上 serverId，页面因此按「编辑」渲染按钮文案
  const save = tree.root.findAll((node) => /^保存/.test(String(node.props?.accessibilityLabel ?? '')))[0];
  assert.ok(save, '应能找到保存按钮');
  await act(async () => {
    save.props.onPress?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(saves.length, 0, '诊断未通过时不得保存实例');
  assert.equal(calls.length, 2, '保存会重新诊断一次，仍只有能力探测请求');
  await act(async () => tree.unmount());
});

test('URL 非法：一个请求都不发，四层全部未执行', async () => {
  calls.length = 0;
  install(async () => new Response('{}', { status: 200 }));
  const tree = await mount();
  await fillAndProbe(tree, 'http://public.example.com', 'key');

  assert.equal(calls.length, 0, 'URL 策略不通过时不应发请求');
  const labels = stageLabels(tree);
  assert.match(labels[0] ?? '', /失败/);
  for (const label of labels.slice(1)) assert.match(label, /未执行/);
  await act(async () => tree.unmount());
});

test('鉴权失败：停在第三步，第四步未执行', async () => {
  calls.length = 0;
  install(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }));
  const tree = await mount();
  await fillAndProbe(tree, 'https://hermes.example.com', 'bad-key');

  assert.equal(calls.length, 1);
  const labels = stageLabels(tree);
  assert.match(labels[0] ?? '', /通过/);
  assert.match(labels[1] ?? '', /失败/, '401 时能力信息也没拿到，应标红而不是留空');
  assert.match(labels[2] ?? '', /失败/, '401 应落在鉴权阶段');
  assert.match(labels[3] ?? '', /未执行/);
  await act(async () => tree.unmount());
});
