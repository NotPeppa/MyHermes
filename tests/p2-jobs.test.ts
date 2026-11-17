/**
 * P2 Skills / Jobs：能力门控、解析容错、命令路径与真实 HTTP 契约。
 * 运行：npx tsx --test tests/p2-jobs.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesService } from '../src/runtime/service';
import { Transport } from '../src/api/transport';
import { SkillsAdapter, JobsAdapter } from '../src/adapters/hermes/client';
import { startMockServer } from '../scripts/mock-server';
import { HermesError } from '../src/domain/errors';
import type { Repository } from '../src/domain/contracts';
import type { ServerConnection, HermesMode } from '../src/domain/models';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const vault = {
  get: async (ref: string) => (ref === 'vault-fault' ? 'key-fault' : 'key-alpha'),
  set: async () => {},
  remove: async () => {},
};

function memory(features: Record<string, boolean> = {}, mode: HermesMode = 'native_runs', baseUrl = 'https://example.test/p/team') {
  const server: ServerConnection = {
    id: 'a', name: 'A', baseUrl, credentialRef: 'vault-a', createdAt: 1,
    capabilities: { mode, features, checkedAt: 1 }, allowHttp: baseUrl.startsWith('http://'),
  };
  const fault: ServerConnection = {
    id: 'fault', name: 'Fault', baseUrl: baseUrl.replace(/\/p\/[a-z]+$/, '/p/fault'), credentialRef: 'vault-fault', createdAt: 1,
    capabilities: { mode, features, checkedAt: 1 }, allowHttp: true,
  };
  const repo: Repository = {
    init: async () => {}, listServers: async () => [server, fault], saveServer: async () => {}, deleteServer: async () => {},
    listSessions: async () => [], saveSessions: async () => {}, deleteSession: async () => {},
    listMessages: async () => [], replaceMessages: async () => {},
    saveTurn: async () => {}, listTurns: async () => [],
    saveRun: async () => {}, listRuns: async () => [],
    saveToolEvent: async () => {}, listToolEvents: async () => [],
    clearCache: async () => {}, getSetting: async () => null, setSetting: async () => {},
    listPendingCredentialDeletes: async () => [], finishCredentialDelete: async () => {},
  };
  return { repo, server, fault };
}

test('无 skills_api / jobs_admin 时返回 [] 且不发任何请求', async () => {
  const { repo } = memory();
  let calls = 0;
  const service = new HermesService({ repository: repo, vault, now: () => 1, fetch: async () => { calls++; return json({}); } });
  assert.deepEqual(await service.listSkills('a'), []);
  assert.deepEqual(await service.listToolsets('a'), []);
  assert.deepEqual(await service.listJobs('a'), []);
  for (const run of [
    () => service.pauseJob('a', 'job-1'),
    () => service.resumeJob('a', 'job-1'),
    () => service.runJob('a', 'job-1'),
    () => service.deleteJob('a', 'job-1'),
  ]) {
    await assert.rejects(run(), (error: HermesError) => error.code === 'protocol');
  }
  assert.equal(calls, 0);
  await service.dispose();
});

test('有 skills_api / jobs_admin 时解析已知字段，命令打到正确 URL 与方法', async () => {
  const { repo } = memory({ skills_api: true, jobs_admin: true });
  const seen: { url: string; method: string }[] = [];
  const service = new HermesService({ repository: repo, vault, now: () => 1, fetch: async (url, init) => {
    seen.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/v1/skills')) return json([
      { name: 'disk-triage', description: '检查磁盘', category: 'ops' },
      { description: '没有名字的条目应被忽略' },
    ]);
    if (url.endsWith('/v1/toolsets')) return json([
      { name: 'terminal', label: '终端', description: '执行命令', enabled: true, configured: false, tools: ['run_command', 7, 'kill_process'] },
    ]);
    if (url.endsWith('/api/jobs')) return json({ jobs: [
      { id: 'job-1', prompt: '每天汇总磁盘', schedule: '0 8 * * *', paused: true, last_status: 'completed', last_run_at: 1_700_000_000_000, skills: ['terminal'], delivery_target: 'telegram' },
      { job_id: 'job-2', prompt: '每周整理清单', last_run_at: '2026-11-17T08:00:00Z' },
      { prompt: '没有 id 的条目应被忽略' },
    ] });
    return json({});
  } });

  assert.deepEqual(await service.listSkills('a'), [{ name: 'disk-triage', description: '检查磁盘', category: 'ops' }]);
  assert.deepEqual(await service.listToolsets('a'), [
    { name: 'terminal', label: '终端', description: '执行命令', enabled: true, configured: false, tools: ['run_command', 'kill_process'] },
  ]);
  assert.deepEqual(await service.listJobs('a'), [
    { id: 'job-1', prompt: '每天汇总磁盘', schedule: '0 8 * * *', paused: true, lastStatus: 'completed', lastRunAt: 1_700_000_000_000 },
    { id: 'job-2', prompt: '每周整理清单', lastRunAt: Date.parse('2026-11-17T08:00:00Z') },
  ]);

  seen.length = 0;
  await service.pauseJob('a', 'job-1');
  await service.resumeJob('a', 'job-1');
  await service.runJob('a', 'job 1');
  await service.deleteJob('a', 'job-1');
  assert.deepEqual(seen, [
    { url: 'https://example.test/p/team/api/jobs/job-1/pause', method: 'POST' },
    { url: 'https://example.test/p/team/api/jobs/job-1/resume', method: 'POST' },
    { url: 'https://example.test/p/team/api/jobs/job%201/run', method: 'POST' },
    { url: 'https://example.test/p/team/api/jobs/job-1', method: 'DELETE' },
  ]);
  await service.dispose();
});

test('结构不认识时适配器返回 [] 而不是抛错', async () => {
  const adapter = (payload: unknown) => new Transport('https://example.test/p/team', 'key', async () => json(payload));
  for (const shape of [{ skills: 'nope' }, { data: [{ description: 'no name' }] }, 'string', null, [{}], { skills: [{ name: '  ' }] }]) {
    assert.deepEqual(await new SkillsAdapter(adapter(shape)).skills(), []);
  }
  for (const shape of [{ toolsets: 1 }, { data: [{ label: 'no name' }] }, [], { toolsets: [{ name: 'x', tools: 'nope' }] }]) {
    const toolsets = await new SkillsAdapter(adapter(shape)).toolsets();
    assert.ok(toolsets.every((toolset) => Array.isArray(toolset.tools) || toolset.tools === undefined));
  }
  for (const shape of [{ jobs: 'nope' }, { data: [{ prompt: 'no id' }] }, null, 42, { jobs: [{}] }]) {
    assert.deepEqual(await new JobsAdapter(adapter(shape)).list(), []);
  }
});

test('真实 HTTP 契约：skills / toolsets / jobs 全流程', async () => {
  const mock = await startMockServer();
  try {
    const base = `${mock.baseUrl}/p/alpha`;
    const { repo } = memory({ skills_api: true, jobs_admin: true }, 'native_runs', base);
    const service = new HermesService({ repository: repo, vault, now: () => Date.now(), fetch });

    const skills = await service.listSkills('a');
    assert.deepEqual(skills[0], {
      name: 'disk-triage',
      description: '按顺序检查磁盘、inode 与容器日志，给出可执行结论',
      category: 'ops',
    });
    const toolsets = await service.listToolsets('a');
    const terminal = toolsets.find((toolset) => toolset.name === 'terminal');
    assert.equal(terminal?.label, '终端');
    assert.equal(terminal?.enabled, true);
    assert.ok(terminal?.tools?.includes('run_command'));

    const seeded = await service.listJobs('a');
    assert.ok(seeded.length >= 2, '预置任务应可读');
    assert.ok(seeded.every((job) => typeof job.id === 'string' && job.id.length > 0));

    const created = (await (await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-alpha', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '契约测试任务', schedule: '*/5 * * * *', skills: ['terminal'], provider: 'nous', delivery_target: 'telegram' }),
    })).json()) as { job: { id: string } };
    const jobId = created.job.id;
    assert.ok((await service.listJobs('a')).some((job) => job.id === jobId && job.prompt === '契约测试任务'));

    const read = async () =>
      (await (await fetch(`${base}/api/jobs/${jobId}`, { headers: { Authorization: 'Bearer key-alpha' } })).json()) as {
        job: { paused: boolean; last_status: string; schedule: string };
      };

    await service.runJob('a', jobId);
    assert.equal((await read()).job.last_status, 'started');
    await service.pauseJob('a', jobId);
    assert.equal((await read()).job.paused, true);
    await service.resumeJob('a', jobId);
    assert.equal((await read()).job.paused, false);

    await fetch(`${base}/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer key-alpha', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '0 7 * * *' }),
    });
    assert.equal((await read()).job.schedule, '0 7 * * *');

    await service.deleteJob('a', jobId);
    assert.equal((await service.listJobs('a')).some((job) => job.id === jobId), false);
    await service.dispose();
  } finally {
    await mock.close();
  }
});

test('fault profile 的 jobs 端点返回 503，服务层抛 unavailable 而不是空列表', async () => {
  const mock = await startMockServer();
  try {
    const { repo } = memory({ skills_api: true, jobs_admin: true }, 'native_runs', `${mock.baseUrl}/p/alpha`);
    const service = new HermesService({ repository: repo, vault, now: () => Date.now(), fetch });
    await assert.rejects(service.listJobs('fault'), (error: HermesError) => error.code === 'unavailable' && error.status === 503);
    await assert.rejects(service.pauseJob('fault', 'job-1'), (error: HermesError) => error.code === 'unavailable');
    await service.dispose();
  } finally {
    await mock.close();
  }
});
