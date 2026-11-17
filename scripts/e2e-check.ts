/**
 * 端到端自检：真实 HTTP mock + 真实 HermesService + 内存仓储。
 * 运行：npx tsx scripts/e2e-check.ts
 */
import { startMockServer } from './mock-server';
import { HermesService } from '../src/runtime/service';
import { createRepository } from '../src/storage/sqlite';
import type { CredentialVault, Repository } from '../src/domain/contracts';

// 端到端：真实 HTTP mock + 真实 service + 内存仓储
const memory = (): Repository => {
  const servers: any[] = []; const sessions: any[] = []; const msgs: any[] = []; const runs: any[] = []; const turns: any[] = []; const tools: any[] = []; const settings = new Map<string,string>();
  return {
    init: async () => {}, listServers: async () => servers, saveServer: async (s) => { servers.push(s); },
    deleteServer: async () => {}, listSessions: async (id) => sessions.filter(s => s.serverId === id),
    saveSessions: async (id, list) => { for (const s of list) sessions.push(s); }, deleteSession: async () => {},
    listMessages: async (a, b) => msgs.filter(m => m.serverId === a && m.sessionId === b),
    replaceMessages: async (a, b, list) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].serverId === a && msgs[i].sessionId === b) msgs.splice(i, 1); msgs.push(...list); },
    saveTurn: async (t) => { turns.push(t); }, listTurns: async (s, x) => turns.filter(t => t.serverId === s && (!x || t.sessionId === x)),
    saveRun: async (r) => { runs.push(r); }, listRuns: async (s, x) => runs.filter(r => r.serverId === s && (!x || r.sessionId === x)),
    saveToolEvent: async (t) => { tools.push(t); }, listToolEvents: async (s, r) => tools.filter(t => t.serverId === s && t.runId === r),
    clearCache: async () => {}, getSetting: async (k) => settings.get(k) ?? null, setSetting: async (k, v) => { settings.set(k, v); },
    listPendingCredentialDeletes: async () => [], finishCredentialDelete: async () => {},
  };
};
const vault = (keys: Map<string,string>): CredentialVault => ({ get: async (r) => keys.get(r) ?? null, set: async (r, k) => { keys.set(r, k); }, remove: async (r) => { keys.delete(r); } });

async function main() {
  const mock = await startMockServer(0);
  const repo = memory();
  const keys = new Map<string,string>([['cred-a', 'key-alpha']]);
  const service = new HermesService({ repository: repo, vault: vault(keys), fetch: (async (u: any, i: any) => globalThis.fetch(u, i)) as any });

  const probe = await service.probe(`${mock.baseUrl}/p/alpha`, 'key-alpha', { allowHttp: true });
  console.log('mode:', probe.capabilities.mode);
  await repo.saveServer({ id: 'a', name: 'A', baseUrl: `${mock.baseUrl}/p/alpha`, credentialRef: 'cred-a', capabilities: probe.capabilities, allowHttp: true, createdAt: Date.now() });
  const session = await service.createSession('a', '演示');
  console.log('session:', session.id);
  await service.send('a', session.id, '检查磁盘');
  await new Promise((r) => setTimeout(r, 2500));
  const view = service.view('a', session.id);
  console.log('run status:', view.runs.at(-1)?.status, '| draft:', JSON.stringify(view.draft.slice(0, 20)), '| tools:', view.tools.length);
  const messages = await repo.listMessages('a', session.id);
  console.log('history roles:', messages.map((m) => m.role).join(','));
  await service.dispose();
  await mock.close();
  if (view.runs.at(-1)?.status !== 'completed') throw new Error('run did not complete');
  if (!messages.some((m) => m.role === 'assistant')) throw new Error('assistant message missing');
  console.log('E2E OK');

}
void main();
