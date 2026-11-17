import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesService } from '../src/runtime/service';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { Capabilities, ServerConnection } from '../src/domain/models';

const capabilities = (checkedAt: number): Capabilities => ({
  mode: 'native_runs',
  features: { run_submission: true, run_status: true, run_events_sse: true, sessions_list: true },
  checkedAt,
});

function fakeRepository(server: ServerConnection): Repository & { servers: ServerConnection[] } {
  const servers = [server];
  return {
    servers,
    init: async () => {},
    listServers: async () => servers,
    saveServer: async (next) => {
      const index = servers.findIndex((item) => item.id === next.id);
      if (index >= 0) servers[index] = next;
      else servers.push(next);
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

const vault: CredentialVault = {
  get: async () => 'key',
  set: async () => {},
  remove: async () => {},
};

const baseServer = (checkedAt: number): ServerConnection => ({
  id: 'srv',
  name: 'demo',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred',
  capabilities: capabilities(checkedAt),
  createdAt: 0,
});

const calls: string[] = [];
const fetcher = async (input: string) => {
  calls.push(input);
  const body = input.includes('capabilities')
    ? { features: { run_submission: true, run_status: true, run_events_sse: true } }
    : { sessions: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('能力缓存未过期时不重探', async () => {
  calls.length = 0;
  const repository = fakeRepository(baseServer(Date.now()));
  const service = new HermesService({ repository, vault, fetch: fetcher });
  await service.listSessions('srv');
  assert.equal(calls.filter((url) => url.includes('capabilities')).length, 0);
});

test('能力缓存过期时后台重探并落库', async () => {
  calls.length = 0;
  const stale = Date.now() - 16 * 60 * 1000;
  const repository = fakeRepository(baseServer(stale));
  const service = new HermesService({ repository, vault, fetch: fetcher });
  await service.listSessions('srv');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.filter((url) => url.includes('capabilities')).length, 1);
  assert.ok(repository.servers[0]!.capabilities.checkedAt > stale);
});

test('同一实例 15 分钟内不重复探测（离线不打服务器）', async () => {
  calls.length = 0;
  const stale = Date.now() - 16 * 60 * 1000;
  const repository = fakeRepository(baseServer(stale));
  const failing = async (input: string) => {
    calls.push(input);
    throw new Error('offline');
  };
  const service = new HermesService({ repository, vault, fetch: failing as never });
  await service.listSessions('srv').catch(() => undefined);
  await service.listSessions('srv').catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.filter((url) => url.includes('capabilities')).length, 1);
});
