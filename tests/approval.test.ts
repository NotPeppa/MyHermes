/**
 * 审批：不同 Hermes 版本把待处理项放在两个地方——
 *  - canonical 控制：`GET /v1/runs/{id}` 的 `pending_controls`
 *  - 事件式：`approval.request` 事件自带 request_id / choices / prompt
 * 客户端必须两条路都认，否则「有审批但点不了」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEvent } from '../src/adapters/hermes/events';
import { HermesService } from '../src/runtime/service';
import { HermesError } from '../src/domain/errors';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { OutboundTurn, Run, ServerConnection } from '../src/domain/models';

const frame = (event: string, data: Record<string, unknown>) => ({
  event,
  data: JSON.stringify(data),
  id: undefined,
});

test('approval.request 事件自带身份时归一化成 control 载荷', () => {
  const normalized = normalizeEvent(
    frame('approval.request', {
      run_id: 'run-1',
      request_id: 'req-9',
      execution_generation: 3,
      prompt: '允许执行 rm -rf /tmp/demo ?',
      choices: ['once', 'deny'],
    }),
    'run-1',
  );
  assert.equal(normalized.kind, 'control');
  assert.equal(normalized.control?.request_id, 'req-9');
  assert.equal(normalized.control?.execution_generation, 3);
  assert.deepEqual(normalized.control?.choices, ['once', 'deny']);
  assert.match(normalized.control?.prompt ?? '', /rm -rf/);
});

test('approval.request 没有 request_id 时不伪造控制项', () => {
  const normalized = normalizeEvent(frame('approval.request', { run_id: 'run-1' }), 'run-1');
  assert.equal(normalized.kind, 'control');
  assert.equal(normalized.control, undefined);
});

test('clarify.request 归为澄清类型', () => {
  const normalized = normalizeEvent(frame('clarify.request', { request_id: 'req-1', prompt: '用哪个模型？' }), 'run-1');
  assert.equal(normalized.control?.type, 'clarification');
});

// ---- 服务层：status 不返回 pending_controls 时，靠事件也能审批 ----

const server: ServerConnection = {
  id: 'srv',
  name: 'demo',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred',
  capabilities: {
    mode: 'native_runs',
    features: { run_submission: true, run_status: true, run_events_sse: true, run_approval_response: true },
    checkedAt: Date.now(),
  },
  createdAt: 0,
};

function repository(turns: OutboundTurn[], runs: Run[]): Repository {
  return {
    init: async () => {},
    listServers: async () => [server],
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => [{ serverId: 'srv', id: 'sess', title: '会话', updatedAt: 0 }],
    saveSessions: async () => {},
    deleteSession: async () => {},
    listMessages: async () => [],
    replaceMessages: async () => {},
    saveTurn: async (turn) => {
      const index = turns.findIndex((item) => item.clientTurnId === turn.clientTurnId);
      if (index >= 0) turns[index] = turn;
      else turns.push(turn);
    },
    listTurns: async () => turns,
    saveRun: async (run) => {
      const index = runs.findIndex((item) => item.runId === run.runId);
      if (index >= 0) runs[index] = run;
      else runs.push(run);
    },
    listRuns: async () => runs,
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

/** 一次提交：SSE 先给 approval.request，再保持连接；status 不带 pending_controls。 */
function fetcher(calls: { url: string; body: string }[]) {
  return async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/v1/runs')) {
      calls.push({ url, body: init?.body ?? '' });
      return new Response(JSON.stringify({ run_id: 'run-1', status: 'started' }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/v1/runs/run-1/events')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: approval.request\ndata: ${JSON.stringify({ run_id: 'run-1', request_id: 'req-1', execution_generation: 4, prompt: '允许执行？', choices: ['once', 'deny'] })}\n\n`,
            ),
          );
          // 事件发完就关流，否则 startStream 的读循环不会结束
          setTimeout(() => controller.close(), 10);
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.endsWith('/v1/runs/run-1')) {
      // 关键：status 里没有 pending_controls
      return new Response(JSON.stringify({ run_id: 'run-1', status: 'waiting_for_approval', output: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/v1/runs/run-1/approval')) {
      calls.push({ url, body: init?.body ?? '' });
      return new Response(JSON.stringify({ run_id: 'run-1', status: 'running' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('status 不含 pending_controls 时，事件里的审批身份仍可提交', async () => {
  const calls: { url: string; body: string }[] = [];
  const turns: OutboundTurn[] = [];
  const runs: Run[] = [];
  const service = new HermesService({ repository: repository(turns, runs), vault, fetch: fetcher(calls) as never });

  await service.send('srv', 'sess', '删掉 /tmp/demo');
  for (let i = 0; i < 20 && !service.view('srv', 'sess').runs.some((run) => run.pendingControls?.length); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const view = service.view('srv', 'sess');
  const control = view.runs.flatMap((run) => run.pendingControls ?? [])[0];
  assert.ok(control, '事件里的审批应落到视图');
  assert.equal(control.request_id, 'req-1');

  await service.respondControl('srv', 'run-1', 'req-1', 'once');
  const approvalCall = calls.find((call) => call.url.includes('/approval'));
  assert.ok(approvalCall, '应调用审批接口');
  const body = JSON.parse(approvalCall.body);
  assert.equal(body.request_id, 'req-1');
  assert.equal(body.choice, 'once');
  assert.equal(body.execution_generation, 4, '事件给了 generation 就带上');
  await service.dispose();
});

test('既没有 status 也没有事件的审批身份时，明确报错而不是静默失败', async () => {
  const calls: { url: string; body: string }[] = [];
  const runs: Run[] = [
    { runId: 'run-1', serverId: 'srv', sessionId: 'sess', clientTurnId: 't1', idempotencyKey: 'k1', requestBodyJson: '{}', status: 'waiting_for_approval', updatedAt: 0 },
  ];
  const service = new HermesService({
    repository: repository([], runs),
    vault,
    fetch: (async () => new Response(JSON.stringify({ run_id: 'run-1', status: 'waiting_for_approval' }), { status: 200, headers: { 'content-type': 'application/json' } })) as never,
  });
  await assert.rejects(service.respondControl('srv', 'run-1', 'req-x', 'once'), (error: unknown) => error instanceof HermesError && error.code === 'conflict');
  assert.equal(calls.length, 0, '没有身份时不应发请求');
  await service.dispose();
});

test('事件没带代次时，用 run 级 execution_generation 一起提交', async () => {
  const calls: { url: string; body: string }[] = [];
  const runs: Run[] = [
    {
      runId: 'run-1',
      serverId: 'srv',
      sessionId: 'sess',
      clientTurnId: 't1',
      idempotencyKey: 'k1',
      requestBodyJson: '{}',
      status: 'waiting_for_approval',
      updatedAt: 0,
      // 事件带来的控制项没有代次（0 表示未知）
      pendingControls: [{ request_id: 'req-1', execution_generation: 0, type: 'approval', prompt: '允许？', choices: ['once', 'deny'] }],
      executionGeneration: 7,
    },
  ];
  const service = new HermesService({
    repository: repository([], runs),
    vault,
    fetch: (async (url: string, init?: { body?: string }) => {
      if (url.includes('/approval')) {
        calls.push({ url, body: init?.body ?? '' });
        return new Response(JSON.stringify({ run_id: 'run-1', status: 'running' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // status 不带 pending_controls，只带 run 级代次
      return new Response(JSON.stringify({ run_id: 'run-1', status: 'waiting_for_approval', execution_generation: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as never,
  });

  await service.respondControl('srv', 'run-1', 'req-1', 'once');
  const body = JSON.parse(calls[0]!.body);
  assert.equal(body.execution_generation, 7, '必须带上 run 级代次，否则服务器回 400 invalid_params');
  assert.equal(body.choice, 'once');
  await service.dispose();
});

test('400 归类为「参数被拒绝」而不是「响应格式不符合预期」', async () => {
  const { ProtocolError } = await import('../src/api/transport');
  const { describeError } = await import('../src/features/common/errors');
  const text = describeError(new ProtocolError('request', 'invalid_params（POST v1/runs/x/approval → HTTP 400）', 400));
  assert.match(text, /请求被服务器拒绝/);
  assert.doesNotMatch(text, /响应格式不符合预期/);
  assert.match(text, /invalid_params/);
});
