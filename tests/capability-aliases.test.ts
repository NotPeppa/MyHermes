/**
 * 旗标命名兼容：同一个能力在不同 Hermes 版本用过不同名字。
 * 实测 0.22.5 广告 run_approval_response / skills_api，且不广告 jobs_admin 却存在 /api/jobs。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { probe } from '../src/api/capability-probe';
import { HermesService } from '../src/runtime/service';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { ServerConnection } from '../src/domain/models';

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

function server(features: Record<string, boolean>, endpoints?: Record<string, unknown>): ServerConnection {
  return {
    id: 'srv',
    name: 'demo',
    baseUrl: 'https://hermes.example.com',
    credentialRef: 'cred',
    capabilities: { mode: 'native_runs', features, endpoints, checkedAt: Date.now() },
    createdAt: 0,
  };
}

const pendingRun = {
  runId: 'run_1',
  serverId: 'srv',
  sessionId: 'sess',
  clientTurnId: 'turn_1',
  idempotencyKey: 'key_1',
  requestBodyJson: '{}',
  status: 'waiting_for_approval' as const,
  updatedAt: 0,
};

function repository(target: ServerConnection): Repository {
  return {
    init: async () => {},
    listServers: async () => [target],
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
    listRuns: async () => [pendingRun],
    saveToolEvent: async () => {},
    listToolEvents: async () => [],
    clearCache: async () => {},
    getSetting: async () => null,
    setSetting: async () => {},
    listPendingCredentialDeletes: async () => [],
    finishCredentialDelete: async () => {},
  };
}

const jsonFetch = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as never;

test('endpoints 里出现 /v1/skills 与 /api/jobs 时补出对应旗标', async () => {
  const result = await probe('https://hermes.example.com', 'key', {
    fetch: jsonFetch({
      features: { run_submission: true, run_status: true, run_events_sse: true },
      endpoints: ['/v1/skills', '/api/jobs', '/v1/runs/{id}/approval'],
    }),
  });
  assert.equal(result.capabilities.features.skills_api, true);
  assert.equal(result.capabilities.features.jobs_admin, true);
  assert.equal(result.capabilities.features.run_approval, true);
});

test('显式 false 不会被 endpoints 覆盖', async () => {
  const result = await probe('https://hermes.example.com', 'key', {
    fetch: jsonFetch({ features: { skills_api: false }, endpoints: ['/v1/skills'] }),
  });
  assert.equal(result.capabilities.features.skills_api, false);
});

test('0.22.5 的 run_approval_response 也能通过审批门控', async () => {
  const calls: string[] = [];
  const service = new HermesService({
    repository: repository(server({ run_approval_response: true })),
    vault,
    fetch: (async (url: string) => {
      calls.push(url);
      if (url.includes('/v1/runs/')) {
        return new Response(JSON.stringify({
          run_id: 'run_1',
          status: 'waiting_for_approval',
          pending_controls: [{ request_id: 'req_1', execution_generation: 2, type: 'approval', prompt: '允许执行？', choices: ['once', 'deny'] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never,
  });
  await service.respondControl('srv', 'run_1', 'req_1', 'once');
  assert.ok(calls.some((url) => url.endsWith('/v1/runs/run_1/approval')), `应调用 approval 端点，实际：${calls.join(', ')}`);
  await service.dispose();
});

test('只有 run_approval 的旧版本同样可用', async () => {
  const service = new HermesService({
    repository: repository(server({ run_approval: true })),
    vault,
    fetch: (async () => new Response(JSON.stringify({
      run_id: 'run_1',
      status: 'waiting_for_approval',
      pending_controls: [{ request_id: 'req_1', execution_generation: 1, type: 'approval', prompt: '允许？', choices: ['once'] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as never,
  });
  await service.respondControl('srv', 'run_1', 'req_1', 'once');
  await service.dispose();
});

test('既没有 run_approval 也没有 run_approval_response 时明确拒绝', async () => {
  const service = new HermesService({
    repository: repository(server({})),
    vault,
    fetch: (async () => new Response(JSON.stringify({
      run_id: 'run_1',
      status: 'waiting_for_approval',
      pending_controls: [{ request_id: 'req_1', execution_generation: 1, type: 'approval', prompt: '允许？', choices: ['once'] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as never,
  });
  await assert.rejects(service.respondControl('srv', 'run_1', 'req_1', 'once'), /未声明此控制能力/);
  await service.dispose();
});

test('jobs_api / jobs_admin 任一旗标都能让任务中心工作', async () => {
  // 端点别名在探测阶段就会补出 jobs_admin，因此这里只验证服务层接受的旗标名
  for (const target of [server({ jobs_api: true }), server({ jobs_admin: true })]) {
    const service = new HermesService({
      repository: repository(target),
      vault,
      fetch: (async () => new Response(JSON.stringify({ jobs: [{ id: 'job_1', prompt: '每天检查磁盘', schedule: '0 8 * * *' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never,
    });
    const jobs = await service.listJobs('srv');
    assert.equal(jobs.length, 1, `应读到任务，实际 ${jobs.length}`);
    await service.dispose();
  }
});
