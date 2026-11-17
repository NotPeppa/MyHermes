/**
 * P2 冲突收尾：用户选择「以服务端为准」后，视图里的本地草稿、错误与待确认提交必须被清掉，
 * 但持久化账本（outbound_turns）不受影响——那是幂等恢复的依据。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesService } from '../src/runtime/service';
import { HermesError } from '../src/domain/errors';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { OutboundTurn, ServerConnection } from '../src/domain/models';

const server: ServerConnection = {
  id: 'srv',
  name: 'demo',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred',
  capabilities: {
    mode: 'native_runs',
    features: { run_submission: true, run_status: true, run_events_sse: true, sessions_list: true, session_messages: true, session_chat_stream: true },
    checkedAt: Date.now(),
  },
  createdAt: 0,
};

function repository(turns: OutboundTurn[]): Repository {
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

test('冲突后 acknowledge 清掉本地视图，但保留账本里的待确认提交', async () => {
  const turns: OutboundTurn[] = [];
  const fetcher = async (url: string) => {
    if (url.includes('/v1/runs')) return new Response(JSON.stringify({ error: 'conflict' }), { status: 409, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = new HermesService({ repository: repository(turns), vault, fetch: fetcher as never });

  await assert.rejects(service.send('srv', 'sess', '检查磁盘'), (error: unknown) => error instanceof HermesError && error.code === 'conflict');

  const conflicted = service.view('srv', 'sess');
  assert.equal(conflicted.error?.code, 'conflict');
  assert.ok(conflicted.submission, '应记录待确认提交');
  assert.equal(conflicted.messages.at(-1)?.body, '检查磁盘', '本地乐观消息在视图里');

  service.acknowledge('srv', 'sess');

  const cleared = service.view('srv', 'sess');
  assert.equal(cleared.error, undefined);
  assert.equal(cleared.submission, undefined);
  assert.equal(cleared.draft, '');
  // 账本不动：409 说明可能已执行，保留 uncertain 以便同键重试或人工核对
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.submissionState, 'submission_uncertain');
  await service.dispose();
});

test('acknowledge 不影响其他会话的视图', async () => {
  const service = new HermesService({ repository: repository([]), vault, fetch: (async () => new Response('{}')) as never });
  service.acknowledge('srv', 'other');
  assert.equal(service.view('srv', 'sess').draft, '');
  assert.equal(service.view('srv', 'other').draft, '');
  await service.dispose();
});
