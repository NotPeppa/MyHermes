/**
 * /v1/skills 挂掉时 /v1/toolsets 往往还能用（实测 Hermes 0.22.5 就是这种状态：
 * skills 因 find_all_skills(include_editorial=…) 抛 TypeError 返回 500，toolsets 200）。
 * 页面必须分别报错、分别展示，不能一起丢。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesService } from '../src/runtime/service';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { ServerConnection } from '../src/domain/models';

const server: ServerConnection = {
  id: 'srv',
  name: 'demo',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred',
  capabilities: { mode: 'native_runs', features: { skills_api: true }, checkedAt: Date.now() },
  createdAt: 0,
};

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

function repository(): Repository {
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

test('skills 500 时 toolsets 仍能读到，两个错误互不影响', async () => {
  const service = new HermesService({
    repository: repository(),
    vault,
    fetch: (async (url: string) => {
      if (url.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ error: { message: 'Failed to enumerate skills' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([{ name: 'terminal', label: '终端', enabled: true, configured: true, tools: ['run_command'] }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never,
  });

  const [skillsResult, toolsetsResult] = await Promise.allSettled([
    service.listSkills('srv'),
    service.listToolsets('srv'),
  ]);
  assert.equal(skillsResult.status, 'rejected');
  assert.equal(toolsetsResult.status, 'fulfilled');
  assert.equal((toolsetsResult as PromiseFulfilledResult<{ name: string }[]>).value[0]?.name, 'terminal');
  await service.dispose();
});
