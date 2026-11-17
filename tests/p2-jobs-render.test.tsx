/**
 * P2 界面能力渲染测试：任务中心列表与操作、无 jobs_admin 时的说明、技能页条目。
 * 运行：npx tsx --tsconfig tests/tsconfig.render.json --test tests/p2-jobs-render.test.tsx
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

import JobsScreen from '../app/(main)/jobs/index';
import SkillsScreen from '../app/(main)/settings/skills';

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

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

function memoryRepository(server: ServerConnection): Repository {
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
    getSetting: async () => null,
    setSetting: async () => {},
    listPendingCredentialDeletes: async () => [],
    finishCredentialDelete: async () => {},
  };
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

const fakeFetch = async (url: string) => {
  if (url.endsWith('/v1/skills')) {
    return json([
      { name: 'disk-triage', description: '按顺序检查磁盘与容器日志', category: 'ops' },
      { name: 'release-notes', description: '整理发布说明', category: 'writing' },
    ]);
  }
  if (url.endsWith('/v1/toolsets')) {
    return json([
      { name: 'terminal', label: '终端', description: '执行 shell 命令', enabled: true, configured: true, tools: ['run_command', 'kill_process'] },
      { name: 'web', label: '网页', description: '抓取网页', enabled: false, configured: false, tools: [] },
    ]);
  }
  if (url.includes('/api/jobs')) {
    return json({
      jobs: [
        { id: 'job-1', prompt: '每天汇总服务器磁盘状态', schedule: '0 8 * * *', paused: false, last_status: 'completed', last_run_at: Date.now() - 60_000 },
        { id: 'job-2', prompt: '每周整理未完成任务清单', schedule: '0 9 * * 1', paused: true, last_status: 'paused' },
      ],
    });
  }
  return json({});
};

function install(features: Record<string, boolean>, options: { missingEndpoints?: boolean } = {}) {
  const calls: { url: string; method: string }[] = [];
  const repository = memoryRepository(makeServer(features));
  const service = new HermesService({
    repository,
    vault,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      // 旗标缺失时客户端会实际探端点；用 404 表示服务器确实没有这些接口
      if (options.missingEndpoints && (url.endsWith('/v1/skills') || url.includes('/api/jobs'))) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return fakeFetch(url);
    }) as never,
  });
  configureAppServices({ repository, vault, service });
  return { repository, service, calls };
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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

/** 替身组件与宿主节点都会带同一份 props，按标签去重后再计数。 */
function uniqueLabels(tree: ReturnType<typeof create>, prefix: string): string[] {
  return [...new Set(findLabelsStartingWith(tree, prefix).map((node) => node.props.accessibilityLabel as string))];
}

function styleOf(node: ReturnType<typeof create>['root']): Record<string, number> {
  const style = node.props?.style;
  return (typeof style === 'function' ? style({ pressed: false }) : style) as Record<string, number>;
}

test('jobs_admin 存在时任务中心渲染任务、调度、状态与三个操作按钮', async () => {
  install({ jobs_admin: true });
  const tree = await render(createElement(JobsScreen));
  const body = textOf(tree.toJSON());
  assert.match(body, /每天汇总服务器磁盘状态/);
  assert.match(body, /0 8 \* \* \*/);
  assert.match(body, /启用中/);
  assert.match(body, /已暂停/);
  assert.match(body, /上次运行：completed/);
  assert.equal(uniqueLabels(tree, '立即运行任务 ').length, 2, '每条任务一个立即运行按钮');
  assert.equal(uniqueLabels(tree, '暂停任务 ').length, 1);
  assert.equal(uniqueLabels(tree, '恢复任务 ').length, 1);
  assert.equal(uniqueLabels(tree, '删除任务 ').length, 2);
  // 48dp 触控目标：图标按钮的命中区不小于 minTouch
  const runStyle = findLabelsStartingWith(tree, '立即运行任务 ')
    .map((node) => styleOf(node as never))
    .find((style) => style && (style.height || style.minHeight));
  assert.ok(runStyle && (runStyle.height ?? 0) >= 48, `触控目标应 ≥48dp，实际 ${JSON.stringify(runStyle)}`);
  await act(async () => tree.unmount());
});

test('点「立即运行」发出 POST /api/jobs/{id}/run 并刷新列表', async () => {
  const { calls } = install({ jobs_admin: true });
  const tree = await render(createElement(JobsScreen));
  calls.length = 0;
  await act(async () => {
    firstByLabel(tree, '立即运行任务 每天汇总服务器磁盘状态').props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.deepEqual(
    calls.filter((call) => call.method === 'POST').map((call) => call.url),
    ['https://hermes.example.com/api/jobs/job-1/run'],
  );
  assert.ok(calls.some((call) => call.method === 'GET' && call.url.endsWith('/api/jobs')), '命令成功后应重新拉列表');
  await act(async () => tree.unmount());
});

test('删除需二次确认：确认后才 DELETE', async () => {
  const { calls } = install({ jobs_admin: true });
  const tree = await render(createElement(JobsScreen));
  assert.ok(findByLabel(tree, '删除任务 每周整理未完成任务清单').length > 0);
  calls.length = 0;
  await act(async () => {
    firstByLabel(tree, '删除任务 每周整理未完成任务清单').props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0, '仅点删除图标不应直接删除');
  await act(async () => {
    firstByLabel(tree, '删除任务').props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE').map((call) => call.url),
    ['https://hermes.example.com/api/jobs/job-2'],
  );
  await act(async () => tree.unmount());
});

test('端点不存在时任务中心显示说明而不是空列表', async () => {
  install({}, { missingEndpoints: true });
  const tree = await render(createElement(JobsScreen));
  const body = textOf(tree.toJSON());
  assert.match(body, /此服务器未开放 Jobs 管理/);
  assert.doesNotMatch(body, /每天汇总服务器磁盘状态/);
  assert.equal(findLabelsStartingWith(tree, '立即运行任务 ').length, 0);
  await act(async () => tree.unmount());
});

test('skills_api 存在时技能页渲染技能与工具集条目', async () => {
  install({ skills_api: true });
  const tree = await render(createElement(SkillsScreen));
  const body = textOf(tree.toJSON());
  assert.match(body, /disk-triage/);
  assert.match(body, /分类：ops/);
  assert.match(body, /终端/);
  assert.match(body, /2 个工具/);
  assert.match(body, /未启用/);
  assert.ok(findByLabel(tree, '技能 disk-triage').length > 0);
  assert.ok(findByLabel(tree, '工具集 terminal').length > 0);

  // 展开工具集看工具名
  assert.doesNotMatch(body, /run_command/);
  await act(async () => {
    firstByLabel(tree, '工具集 terminal').props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(textOf(tree.toJSON()), /run_command/);
  await act(async () => tree.unmount());
});

test('端点不存在时技能页显示说明', async () => {
  install({}, { missingEndpoints: true });
  const tree = await render(createElement(SkillsScreen));
  const body = textOf(tree.toJSON());
  assert.match(body, /此服务器未开放 Skills 接口/);
  assert.doesNotMatch(body, /disk-triage/);
  await act(async () => tree.unmount());
});

test('skills 500 但 toolsets 正常：分别提示并照常显示工具集', async () => {
  const repository = memoryRepository(makeServer({ skills_api: true }));
  const service = new HermesService({
    repository,
    vault,
    fetch: (async (url: string) => {
      if (url.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ error: { message: 'Failed to enumerate skills' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return json([{ name: 'terminal', label: '终端', enabled: true, configured: true, tools: ['run_command'] }]);
    }) as never,
  });
  configureAppServices({ repository, vault, service });

  const tree = await render(createElement(SkillsScreen));
  const body = textOf(tree.toJSON());
  assert.match(body, /技能列表读取失败/);
  assert.match(body, /Failed to enumerate skills/, '横幅里要显示服务端原因');
  assert.match(body, /工具集仍然可用/);
  assert.match(body, /terminal/, '工具集条目应照常渲染');
  await act(async () => tree.unmount());
});
