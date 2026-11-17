import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBaseUrl, buildUrl } from '../src/api/urls';
import { Transport } from '../src/api/transport';
import { SSEParser, consumeSSE } from '../src/api/sse';
import { normalizeEvent } from '../src/adapters/hermes/events';
import { probe } from '../src/api/capability-probe';
import { HermesService } from '../src/runtime/service';
import { SessionsAdapter, RunsAdapter, CompatAdapter } from '../src/adapters/hermes/client';
import { startMockServer } from '../scripts/mock-server';
import { HermesError } from '../src/domain/errors';
import type { Repository } from '../src/domain/contracts';
import type { ServerConnection, OutboundTurn, Run, Message, Session, ToolEvent } from '../src/domain/models';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const server: ServerConnection = { id: 'a', name: 'A', baseUrl: 'https://example.test/p/team', credentialRef: 'vault-a', createdAt: 1, capabilities: { mode: 'native_runs', features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_approval: true }, checkedAt: 1 } };
function memory() {
  const turns: OutboundTurn[] = [], runs: Run[] = [], sessions: Session[] = [{ serverId: 'a', id: 's', title: 'Session', updatedAt: 1 }], messages: Message[] = [], tools: ToolEvent[] = [];
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
  return { repo, turns, runs, sessions, messages, tools };
}
const vault = { get: async () => 'TOP_SECRET_KEY', set: async () => {}, remove: async () => {} };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('URL policy rejects ambiguous or credential-bearing targets and preserves profile', () => {
  assert.equal(buildUrl(validateBaseUrl('https://host.test/base/p/team/'), '/v1/runs', { limit: 5 }), 'https://host.test/base/p/team/v1/runs?limit=5');
  assert.equal(validateBaseUrl('http://192.168.1.2:8642/p/dev', { allowHttp: true }), 'http://192.168.1.2:8642/p/dev');
  for (const url of ['http://192.168.1.2', 'http://public.test', 'https://a:b@host.test', 'https://host.test?key=x', 'https://host.test/#x', 'file:///tmp/a']) assert.throws(() => validateBaseUrl(url, { allowHttp: url === 'http://public.test' }));
  assert.throws(() => buildUrl('https://host.test/p/team', '../escape'));
  assert.throws(() => buildUrl('https://host.test/p/team', '//evil.test'));
});

test('transport isolates bearer, disables redirects and classifies without secret errors', async () => {
  const transport = new Transport(server.baseUrl, 'TOP_SECRET_KEY', async (url, options) => {
    assert.equal(url, 'https://example.test/p/team/v1/runs'); assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer TOP_SECRET_KEY');
    return json({ secret: 'TOP_SECRET_KEY' }, 401);
  });
  await assert.rejects(transport.request('v1/runs'), (error: HermesError) => error.code === 'unauthorized' && !error.message.includes('TOP_SECRET'));
  await assert.rejects(new Transport(server.baseUrl, 'secret', async () => { throw new Error('certificate TOP_SECRET_KEY'); }).request('x'), (error: HermesError) => error.code === 'tls' && !error.message.includes('TOP_SECRET'));
  for (const [status, code] of [[403, 'forbidden'], [404, 'not_found'], [409, 'conflict'], [429, 'rate_limited'], [503, 'unavailable']] as const) await assert.rejects(new Transport(server.baseUrl, 'secret', async () => json({}, status)).request('x'), (error: HermesError) => error.code === code);
});

test('transport cancellation and deadline propagate through stream consumption', async () => {
  const fetcher = async (_url: string, options?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => { if (options?.signal?.aborted) reject(new Error('aborted')); else options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  await assert.rejects(new Transport(server.baseUrl, 'secret', fetcher).request('x', { timeoutMs: 5 }), (error: HermesError) => error.code === 'timeout');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new Transport(server.baseUrl, 'secret', fetcher).request('x', { signal: controller.signal }), (error: HermesError) => error.code === 'cancelled');
});

test('SSE parser supports comments, fields, multiline, CRLF splits and UTF-8 byte splits', async () => {
  const frames: any[] = [];
  const parser = new SSEParser(frame => frames.push(frame));
  for (const part of [':ping\r', '\nid: 7\r\nevent: assistant.delta\r\nretry: 1000\r\ndata: one\r', '\ndata: two\r\n\r', '\n']) parser.push(part);
  assert.deepEqual(frames, [{ event: 'assistant.delta', data: 'one\ntwo', id: '7', retry: 1000, idExplicit: true }]);
  const bytes = new TextEncoder().encode('event: message.delta\ndata: {"text":"你好🦄"}\n\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const collected: string[] = [];
  await consumeSSE(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), new AbortController().signal, frame => collected.push(frame.data));
  assert.deepEqual(collected, ['{"text":"你好🦄"}', '[DONE]']);
  parser.push('data: incomplete', true); assert.equal(frames.length, 1);
});

test('normalizer distinguishes tools, commentary, terminals and unknown content', () => {
  assert.equal(normalizeEvent({ event: 'tool.failed', data: '{"name":"shell"}' }, 'r').kind, 'tool_finished');
  assert.equal(normalizeEvent({ event: 'tool.failed', data: '{}' }, 'r').state, undefined);
  assert.equal(normalizeEvent({ event: 'assistant.commentary', data: '{"text":"x","already_streamed":true}' }, 'r').alreadyStreamed, true);
  assert.equal(normalizeEvent({ event: 'message', data: '[DONE]' }, 'r', 'runs').kind, 'unknown');
  assert.equal(normalizeEvent({ event: 'message', data: '[DONE]' }, 'r', 'compat').state, 'completed');
  assert.equal(normalizeEvent({ event: 'secret.unknown', data: '{"secret":"value"}' }, 'r').text, undefined);
});

test('probe uses explicit features, tolerates 404 fallback only, and returns latency', async () => {
  const native = await probe(server.baseUrl, 'key', { fetch: async () => json({ features: ['run_submission', 'run_status', 'run_events_sse', 'run_stop'] }) });
  assert.equal(native.capabilities.mode, 'native_runs'); assert.equal(native.capabilities.features.run_approval, undefined); assert.ok(native.latencyMs >= 0);
  let calls = 0;
  const compat = await probe(server.baseUrl, 'key', { fetch: async () => ++calls === 1 ? json({}, 404) : json({ data: [{ id: 'hermes' }] }) });
  assert.equal(compat.capabilities.mode, 'openai_compat'); assert.equal(compat.capabilities.model, 'hermes');
  calls = 0;
  await assert.rejects(probe(server.baseUrl, 'key', { fetch: async () => { calls++; return json({}, 401); } })); assert.equal(calls, 1);
});

test('ledger persists before POST, lost response requires explicit same-body/key retry, recovery never submits', async () => {
  const { repo, turns, runs } = memory();
  const sent: { body: string; key: string }[] = [];
  let attempt = 0, ids = 0;
  const service = new HermesService({ repository: repo, vault, randomId: () => `id-${++ids}`, fetch: async (url, init) => {
    if (url.endsWith('/v1/runs') && init?.method === 'POST') {
      assert.equal(turns.length, 1); sent.push({ body: init.body as string, key: new Headers(init.headers).get('Idempotency-Key')! });
      if (++attempt === 1) throw new Error('connection reset with TOP_SECRET_KEY');
      return json({ run_id: 'r1', status: 'running' });
    }
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } });
    if (url.endsWith('/v1/runs/r1')) return json({ run_id: 'r1', status: 'running' });
    throw new Error('unexpected');
  } });
  await assert.rejects(service.send('a', 's', 'do work'), (error: HermesError) => error.code === 'network');
  assert.equal(turns[0]!.submissionState, 'submission_uncertain');
  await service.recover('a', 's'); assert.equal(sent.length, 1);
  await assert.rejects(service.send('a', 's', 'do work'), (error: HermesError) => error.code === 'conflict');
  await service.retrySubmission('a', turns[0]!.clientTurnId);
  assert.deepEqual(sent[0], sent[1]); assert.equal(runs[0]!.runId, 'r1');
  assert.ok(!JSON.stringify(service.view('a', 's')).includes('TOP_SECRET_KEY'));
  await service.dispose();
});

test('terminal status and history override draft; tool failure does not fail the run', async () => {
  const { repo, runs } = memory(); let ids = 0;
  const service = new HermesService({ repository: repo, vault, randomId: () => `id-${++ids}`, fetch: async (url, init) => {
    if (url.endsWith('/v1/runs') && init?.method === 'POST') return json({ run_id: 'r2', status: 'running' });
    if (url.endsWith('/events')) return new Response('id: e1\nevent: message.delta\ndata: {"text":"draft"}\n\nid: e1\nevent: message.delta\ndata: {"text":"draft"}\n\nid: e2\nevent: tool.failed\ndata: {"tool_name":"shell","tool_call_id":"t1"}\n\nevent: run.completed\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    if (url.endsWith('/v1/runs/r2')) return json({ run_id: 'r2', status: 'completed', output: 'authoritative' });
    if (url.includes('/messages?')) return json({ messages: [{ id: 'm1', role: 'assistant', content: 'authoritative' }] });
    throw new Error('unexpected');
  } });
  await service.send('a', 's', 'hello');
  for (let i = 0; i < 100 && runs[0]?.status !== 'completed'; i++) await tick();
  for (let i = 0; i < 100 && !service.view('a', 's').messages.some(m => m.body === 'authoritative'); i++) await tick();
  assert.equal(runs[0]!.status, 'completed'); assert.equal(service.view('a', 's').draft, ''); assert.equal(service.view('a', 's').messages[0]!.body, 'authoritative'); assert.equal(service.view('a', 's').tools[0]!.eventType, 'failed');
  await service.dispose();
});

test('stop waits for server truth and controls send freshly fetched identity; 409 refreshes', async () => {
  const { repo, turns, runs } = memory();
  const turn: OutboundTurn = { clientTurnId: 't', serverId: 'a', sessionId: 's', idempotencyKey: 'key', requestBodyJson: '{"input":"x"}', runId: 'r', submissionState: 'running', createdAt: Date.now() };
  turns.push(turn); runs.push({ ...turn, runId: 'r', status: 'running', updatedAt: 1 });
  const bodies: any[] = []; let statusCalls = 0;
  const service = new HermesService({ repository: repo, vault, fetch: async (url, init) => {
    if (url.endsWith('/stop')) return json({ status: 'cancelled' });
    if (url.endsWith('/approval')) { bodies.push(JSON.parse(init!.body as string)); return json({}, 409); }
    if (url.endsWith('/v1/runs/r')) { statusCalls++; return json({ status: 'waiting_for_approval', pending_controls: [{ request_id: 'p', execution_generation: 7, type: 'approval', prompt: 'Run?', choices: ['once', 'deny'] }] }); }
    throw new Error('unexpected');
  } });
  await service.stop('a', 'r'); assert.equal(runs[0]!.status, 'waiting_for_approval');
  await assert.rejects(service.respondControl('a', 'r', 'p', 'once'), (error: HermesError) => error.code === 'conflict');
  assert.deepEqual(bodies, [{ request_id: 'p', execution_generation: 7, choice: 'once' }]); assert.ok(statusCalls >= 4);
  await service.dispose();
});

test('real HTTP mock contract: profile auth, sessions, idempotent runs, SSE, stop and compatibility', async () => {
  const mock = await startMockServer();
  try {
    const base = `${mock.baseUrl}/p/alpha`;
    const result = await probe(base, 'key-alpha', { allowHttp: true, fetch });
    assert.equal(result.capabilities.mode, 'native_runs');
    await assert.rejects(probe(base, 'key-beta', { allowHttp: true, fetch }), (error: HermesError) => error.code === 'unauthorized');
    const transport = new Transport(base, 'key-alpha', fetch, true);
    const sessions = new SessionsAdapter(transport, 'alpha');
    const session = await sessions.create('Contract');
    assert.ok((await sessions.list()).some(s => s.id === session.id));
    await sessions.rename(session.id, 'Renamed');
    const adapter = new RunsAdapter(transport);
    const turn: OutboundTurn = { clientTurnId: 'http-turn', serverId: 'alpha', sessionId: session.id, idempotencyKey: `http-key-${Date.now()}`, requestBodyJson: JSON.stringify({ input: 'contract', session_id: session.id }), submissionState: 'submitting', createdAt: Date.now() };
    const run = await adapter.submit(turn);
    assert.equal((await adapter.submit(turn)).runId, run.runId);
    await assert.rejects(adapter.submit({ ...turn, requestBodyJson: JSON.stringify({ input: 'changed', session_id: session.id }) }), (error: HermesError) => error.code === 'conflict');
    const events: any[] = [];
    const controller = new AbortController();
    let stopping = false;
    const observation = adapter.events(run.runId, event => { events.push(event); if (event.kind === 'text_delta' && !stopping) { stopping = true; void adapter.control(run.runId, 'stop'); } if (event.kind === 'terminal') controller.abort(); }, controller.signal).catch(error => { assert.equal(error.code, 'cancelled'); });
    await observation;
    assert.equal((await adapter.status(run)).status, 'cancelled');
    assert.ok(events.some(e => e.state === 'cancelled'));
    const beta = new RunsAdapter(new Transport(`${mock.baseUrl}/p/beta`, 'key-beta', fetch, true));
    await assert.rejects(beta.status(run), (error: HermesError) => error.code === 'not_found');
    const sessionEvents: any[] = [];
    await sessions.stream(session.id, JSON.stringify({ message: 'Hi' }), event => sessionEvents.push(event), new AbortController().signal);
    assert.ok(sessionEvents.some(e => e.kind === 'terminal' && e.state === 'completed'));
    assert.ok((await sessions.messages(session.id)).some(m => m.role === 'assistant'));
    const compatEvents: any[] = [];
    await new CompatAdapter(transport).stream(JSON.stringify({ model: 'hermes-agent', stream: true, messages: [{ role: 'user', content: 'Hi' }] }), 'compat', event => compatEvents.push(event), new AbortController().signal);
    assert.ok(compatEvents.some(e => e.kind === 'text_delta')); assert.ok(compatEvents.some(e => e.kind === 'terminal'));
    const fault = new RunsAdapter(new Transport(`${mock.baseUrl}/p/fault`, 'key-fault', fetch, true));
    await assert.rejects(fault.submit(turn), (error: HermesError) => error.code === 'unavailable' && error.retryAfter === '2');
    await sessions.delete(session.id);
  } finally { await mock.close(); }
});

test('cache disabled skips sessions/messages/tools writes but retains submission ledger', async () => {
  const { repo, turns, runs } = memory();
  repo.getSetting = async () => '0';
  repo.saveSessions = async () => { assert.fail('sessions cache written'); };
  repo.replaceMessages = async () => { assert.fail('messages cache written'); };
  repo.saveToolEvent = async () => { assert.fail('tool cache written'); };
  let ids = 0;
  const service = new HermesService({ repository: repo, vault, randomId: () => `cache-${++ids}`, fetch: async (url, init) => {
    if (url.endsWith('/api/sessions') && init?.method === 'POST') return json({ id: 'new-session', title: 'New' });
    if (url.endsWith('/v1/runs') && init?.method === 'POST') return json({ run_id: 'cache-run', status: 'running' });
    if (url.endsWith('/events')) return new Response('event: tool.started\ndata: {"tool_name":"shell"}\n\nevent: run.completed\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    if (url.endsWith('/v1/runs/cache-run')) return json({ status: 'completed', output: 'done' });
    if (url.includes('/messages?')) return json({ messages: [{ role: 'assistant', content: 'done' }] });
    throw new Error('unexpected');
  } });
  const session = await service.createSession('a');
  await service.send('a', session.id, 'do it');
  for (let i = 0; i < 100 && runs[0]?.status !== 'completed'; i++) await tick();
  assert.equal(turns[0]?.submissionState, 'completed'); assert.equal(runs[0]?.status, 'completed');
  assert.ok(!service.view('a', session.id).error);
  await service.dispose();
});

test('expired idempotency never posts and cross-server session is rejected', async () => {
  const { repo, turns } = memory();
  turns.push({ clientTurnId: 'old', serverId: 'a', sessionId: 's', idempotencyKey: 'old', requestBodyJson: '{}', submissionState: 'submission_uncertain', createdAt: 0 });
  let posts = 0;
  // 只统计 run 提交；能力缓存过期时的后台重探不算新提交
  const service = new HermesService({ repository: repo, vault, now: () => 86_400_001, fetch: async (url: string) => { if (url.includes('/v1/runs') && !url.includes('/v1/runs/')) posts++; return json({}); } });
  await assert.rejects(service.retrySubmission('a', 'old'), (error: HermesError) => error.code === 'conflict');
  await assert.rejects(service.send('a', 'foreign-session', 'x'), (error: HermesError) => error.code === 'not_found'); assert.equal(posts, 0);
});
