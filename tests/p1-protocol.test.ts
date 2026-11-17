import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesService } from '../src/runtime/service';
import { probe } from '../src/api/capability-probe';
import { Transport } from '../src/api/transport';
import { SessionsAdapter, ModelsAdapter, RunsAdapter } from '../src/adapters/hermes/client';
import { startMockServer } from '../scripts/mock-server';
import { HermesError } from '../src/domain/errors';
import type { Repository } from '../src/domain/contracts';
import type { ServerConnection, Session, Message, Run, OutboundTurn, ToolEvent, HermesMode } from '../src/domain/models';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const idle = (signal?: AbortSignal | null) => new Response(new ReadableStream({ start(controller) { signal?.addEventListener('abort', () => controller.close(), { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } });
const vault = { get: async () => 'TOP_SECRET_KEY', set: async () => {}, remove: async () => {} };

function memory(features: Record<string, boolean> = {}, mode: HermesMode = 'native_runs') {
  const server: ServerConnection = { id: 'a', name: 'A', baseUrl: 'https://example.test/p/team', credentialRef: 'vault-a', createdAt: 1, capabilities: { mode, features, checkedAt: 1 } };
  const sessions: Session[] = [
    { serverId: 'a', id: 's', title: 'Session', updatedAt: 1 },
    { serverId: 'a', id: 't', title: '另一个 会话', updatedAt: 2 },
    { serverId: 'a', id: 'u', title: 'SESSION two', updatedAt: 3 },
  ];
  const messages: Message[] = [], turns: OutboundTurn[] = [], runs: Run[] = [], tools: ToolEvent[] = [];
  const upsert = <T>(array: T[], value: T, match: (item: T) => boolean) => { const index = array.findIndex(match); if (index < 0) array.push(value); else array[index] = value; };
  const repo: Repository = {
    init: async () => {}, listServers: async () => [server], saveServer: async () => {}, deleteServer: async () => {},
    listSessions: async id => sessions.filter(s => s.serverId === id), saveSessions: async (_id, values) => { sessions.splice(0, sessions.length, ...values); }, deleteSession: async () => {},
    listMessages: async () => [...messages], replaceMessages: async (_a, _b, values) => { messages.splice(0, messages.length, ...values); },
    saveTurn: async value => { upsert(turns, { ...value }, t => t.clientTurnId === value.clientTurnId); }, listTurns: async (id, sid) => turns.filter(t => t.serverId === id && (!sid || t.sessionId === sid)),
    saveRun: async value => { upsert(runs, { ...value }, r => r.runId === value.runId); }, listRuns: async (id, sid) => runs.filter(r => r.serverId === id && (!sid || r.sessionId === sid)),
    saveToolEvent: async value => { upsert(tools, value, t => t.id === value.id); }, listToolEvents: async (id, rid) => tools.filter(t => t.serverId === id && t.runId === rid),
    clearCache: async () => {}, getSetting: async () => null, setSetting: async () => {}, listPendingCredentialDeletes: async () => [], finishCredentialDelete: async () => {},
  };
  return { repo, server, sessions, messages, turns, runs };
}

test('probe passes feature flags through and fills missing ones from endpoint aliases without overriding false', async () => {
  const aliased = await probe('https://example.test/p/team', 'key', { fetch: async () => json({ endpoints: ['/api/sessions/{id}/fork', '/api/model/options'] }) });
  assert.equal(aliased.capabilities.features.session_fork, true);
  assert.equal(aliased.capabilities.features.model_options, true);
  const explicit = await probe('https://example.test/p/team', 'key', { fetch: async () => json({ features: { session_fork: false }, endpoints: ['/api/sessions/{id}/fork', '/api/model/options'] }) });
  assert.equal(explicit.capabilities.features.session_fork, false);
  assert.equal(explicit.capabilities.features.model_options, true);
});

test('forkSession without session_fork throws a protocol error and never sends a request', async () => {
  const { repo } = memory();
  let calls = 0;
  const service = new HermesService({ repository: repo, vault, now: () => 1, fetch: async () => { calls++; return json({}); } });
  await assert.rejects(service.forkSession('a', 's'), (error: HermesError) => error.code === 'protocol');
  assert.equal(calls, 0);
  await service.dispose();
});

test('forkSession posts to the fork path and caches the returned session', async () => {
  const { repo, sessions } = memory({ session_fork: true });
  const seen: { url: string; method?: string; body?: string }[] = [];
  const service = new HermesService({ repository: repo, vault, now: () => 1, fetch: async (url, init) => {
    seen.push({ url, method: init?.method, body: init?.body as string });
    return json({ session: { id: 'fork-1', title: '分支：Session', updated_at: 9, forked_from: 's' } });
  } });
  const forked = await service.forkSession('a', 's', '分支标题');
  assert.deepEqual(seen, [{ url: 'https://example.test/p/team/api/sessions/s/fork', method: 'POST', body: '{"title":"分支标题"}' }]);
  assert.deepEqual(forked, { serverId: 'a', id: 'fork-1', title: '分支：Session', updatedAt: 9, forkedFrom: 's' });
  assert.ok(sessions.some(s => s.id === 'fork-1' && s.forkedFrom === 's'));
  await service.dispose();
});

test('listModels 同时接受官方字符串形状与旧的对象形状', async () => {
  // 官方 build_model_options_payload：provider 用 slug，models 是字符串数组，模型标签在 pricing 里
  const official = {
    providers: [
      { slug: 'nous', label: 'Nous Research', models: ['hermes-4-405b', 'hermes-4-70b'], pricing: { 'hermes-4-405b': { input: '0.90', output: '2.70' } } },
      { slug: 'openai', label: 'OpenAI', models: ['gpt-5.1'] },
    ],
    model: 'hermes-4-405b',
    provider: 'nous',
  };
  const { repo } = memory({ model_options: true });
  const officialService = new HermesService({ repository: repo, vault, now: () => 1, fetch: async () => json(official) });
  assert.deepEqual(await officialService.listModels('a'), [
    { id: 'hermes-4-405b', provider: 'nous', providerLabel: 'Nous Research', current: true },
    { id: 'hermes-4-70b', provider: 'nous', providerLabel: 'Nous Research' },
    { id: 'gpt-5.1', provider: 'openai', providerLabel: 'OpenAI' },
  ]);
  await officialService.dispose();

  const payload = { providers: [
    { id: 'nous', models: [{ id: 'hermes-4-405b', name: 'Hermes 4 405B', context_window: 131072 }, { id: 'hermes-4-70b', label: 'Hermes 4 70B', contextWindow: 65536 }] },
    { id: 'openai', models: [{ id: 'gpt-5.1', label: 'GPT-5.1' }] },
  ] };
  const service = new HermesService({ repository: memory({ model_options: true }).repo, vault, now: () => 1, fetch: async () => json(payload) });
  assert.deepEqual(await service.listModels('a'), [
    { id: 'hermes-4-405b', provider: 'nous', label: 'Hermes 4 405B', contextWindow: 131072 },
    { id: 'hermes-4-70b', provider: 'nous', label: 'Hermes 4 70B', contextWindow: 65536 },
    { id: 'gpt-5.1', provider: 'openai', label: 'GPT-5.1' },
  ]);
  for (const shape of [{ providers: 'nope' }, { models: [{ id: 'x' }] }, { providers: [{ id: 'nous', models: 'nope' }, { models: [{ name: 'no id' }] }] }])
    assert.deepEqual(await new ModelsAdapter(new Transport('https://example.test/p/team', 'key', async () => json(shape))).options(), []);
  const off = new HermesService({ repository: memory().repo, vault, now: () => 1, fetch: async () => { assert.fail('no request without model_options'); } });
  assert.deepEqual(await off.listModels('a'), []);
  await service.dispose(); await off.dispose();
});

test('searchSessions filters the local cache case-insensitively and never touches the network', async () => {
  const { repo } = memory();
  const service = new HermesService({ repository: repo, vault, now: () => 1, fetch: async () => { assert.fail('searchSessions must not fetch'); } });
  assert.deepEqual((await service.searchSessions('a', 'session')).map(s => s.id), ['s', 'u']);
  assert.deepEqual((await service.searchSessions('a', '会话')).map(s => s.id), ['t']);
  assert.deepEqual((await service.searchSessions('a', '')).map(s => s.id), ['s', 't', 'u']);
  assert.deepEqual(await service.searchSessions('a', 'missing'), []);
  await service.dispose();
});

test('send folds model/provider into the request body only when supplied', async () => {
  const bodies: any[] = [];
  const runsFetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/runs') && init?.method === 'POST') { bodies.push(JSON.parse(init.body as string)); return json({ run_id: 'r1', status: 'running' }); }
    if (url.endsWith('/events')) return idle(init?.signal);
    if (url.endsWith('/v1/runs/r1')) return json({ run_id: 'r1', status: 'running' });
    throw new Error('unexpected');
  };
  const withOptions = new HermesService({ repository: memory().repo, vault, now: () => 1, fetch: runsFetch });
  await withOptions.send('a', 's', 'hi', { model: 'gpt-5.1', provider: 'openai' });
  await withOptions.dispose();
  assert.deepEqual(bodies[0], { input: 'hi', session_id: 's', model: 'gpt-5.1', provider: 'openai' });

  const plain = new HermesService({ repository: memory().repo, vault, now: () => 1, fetch: runsFetch });
  await plain.send('a', 's', 'hi');
  await plain.dispose();
  assert.deepEqual(bodies[1], { input: 'hi', session_id: 's' });

  const compatBodies: any[] = [];
  const compat = new HermesService({ repository: memory({ chat_completions: true }, 'openai_compat').repo, vault, now: () => 1, fetch: async (url, init) => {
    if (url.endsWith('/v1/chat/completions')) { compatBodies.push(JSON.parse(init!.body as string)); return new Response('', { headers: { 'content-type': 'text/event-stream' } }); }
    throw new Error('unexpected');
  } });
  await compat.send('a', 's', 'hi', { model: 'hermes-4-70b', provider: 'nous' });
  await compat.dispose();
  assert.equal(compatBodies[0].model, 'hermes-4-70b'); assert.equal(compatBodies[0].provider, 'nous');
  assert.deepEqual(compatBodies[0].messages, [{ role: 'user', content: 'hi' }]);
});

test('real HTTP mock contract: capability flags, fork with copied history, model options and runs echo', async () => {
  const mock = await startMockServer();
  try {
    const base = `${mock.baseUrl}/p/alpha`;
    const probed = await probe(base, 'key-alpha', { allowHttp: true, fetch });
    assert.equal(probed.capabilities.features.session_fork, true);
    assert.equal(probed.capabilities.features.model_options, true);
    const transport = new Transport(base, 'key-alpha', fetch, true);
    const sessions = new SessionsAdapter(transport, 'alpha');
    const parent = await sessions.create('原始会话');
    await sessions.stream(parent.id, JSON.stringify({ message: '第一轮' }), () => {}, new AbortController().signal);
    const forked = await sessions.fork(parent.id);
    assert.equal(forked.forkedFrom, parent.id);
    assert.equal(forked.title, '分支：原始会话');
    assert.ok((await sessions.messages(forked.id)).some(m => m.body === '第一轮'));
    // 官方形状：provider 用 slug，models 是字符串数组，当前模型由 model+provider 标出
    assert.deepEqual(await new ModelsAdapter(transport).options(), [
      { id: 'hermes-4-405b', provider: 'nous', providerLabel: 'Nous Research', current: true },
      { id: 'hermes-4-70b', provider: 'nous', providerLabel: 'Nous Research' },
      { id: 'gpt-5.1', provider: 'openai', providerLabel: 'OpenAI' },
      { id: 'gpt-5-mini', provider: 'openai', providerLabel: 'OpenAI' },
    ]);
    const runs = new RunsAdapter(transport);
    const turn: OutboundTurn = { clientTurnId: 'p1-turn', serverId: 'alpha', sessionId: parent.id, idempotencyKey: `p1-key-${Date.now()}`, requestBodyJson: JSON.stringify({ input: 'echo', session_id: parent.id, model: 'gpt-5.1', provider: 'openai' }), submissionState: 'submitting', createdAt: Date.now() };
    const run = await runs.submit(turn);
    const status = await (await fetch(`${base}/v1/runs/${run.runId}`, { headers: { Authorization: 'Bearer key-alpha' } })).json() as any;
    assert.equal(status.model, 'gpt-5.1');
    assert.equal(status.provider, 'openai');
    await sessions.delete(forked.id); await sessions.delete(parent.id);
  } finally { await mock.close(); }
});
