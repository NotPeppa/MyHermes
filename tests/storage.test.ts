import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, test } from 'node:test';
import type { Repository } from '../src/domain/contracts';
import type { Message, Run, ServerConnection, Session, ToolEvent } from '../src/domain/models';
import { flushPendingCredentialDeletes } from '../src/storage/credentials';
import { createSQLiteRepository, TOOL_EVENT_TTL_MS, TOOL_PREVIEW_MAX } from '../src/storage/repository';
import { migrate, MIGRATIONS, type SQLiteBindValue, type SQLiteDatabase } from '../src/storage/sqlite';

/** 内存 SQLite 假实现：接口与 expo-sqlite 一致，但跑的是真实 SQL。 */
class MemoryDatabase implements SQLiteDatabase {
  readonly raw = new DatabaseSync(':memory:');

  async execAsync(source: string): Promise<void> {
    this.raw.exec(source);
  }

  async runAsync(source: string, params: SQLiteBindValue[] = []): Promise<void> {
    this.raw.prepare(source).run(...params);
  }

  async getAllAsync<T>(source: string, params: SQLiteBindValue[] = []): Promise<T[]> {
    return this.raw.prepare(source).all(...params) as T[];
  }

  async getFirstAsync<T>(source: string, params: SQLiteBindValue[] = []): Promise<T | null> {
    return (this.raw.prepare(source).get(...params) ?? null) as T | null;
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.raw.exec('BEGIN');
    try {
      await task();
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

const NOW = 1_700_000_000_000;

function server(id: string): ServerConnection {
  return {
    id,
    name: `hermes-${id}`,
    baseUrl: `https://${id}.example.com/api`,
    credentialRef: `cred-${id}`,
    capabilities: { mode: 'native_runs', features: { runs: true }, checkedAt: NOW, model: 'hermes-3' },
    createdAt: NOW,
    allowHttp: false,
  };
}

function session(serverId: string, id: string): Session {
  return { serverId, id, title: `会话 ${id}`, updatedAt: NOW };
}

function message(serverId: string, sessionId: string, id: string, createdAt: number, body = id): Message {
  return { id, serverId, sessionId, role: 'user', body, createdAt };
}

function run(serverId: string, sessionId: string, runId: string): Run {
  return {
    runId,
    serverId,
    sessionId,
    clientTurnId: `turn-${runId}`,
    idempotencyKey: `idem-${runId}`,
    requestBodyJson: '{"input":"hi"}',
    status: 'waiting_for_approval',
    rawStatus: 'waiting',
    finalOutput: 'done',
    admissionId: `adm-${runId}`,
    executionGeneration: 3,
    pendingControls: [{ request_id: 'r1', execution_generation: 3, type: 'approval', prompt: '允许执行？', choices: ['yes'] }],
    updatedAt: NOW,
  };
}

function toolEvent(serverId: string, runId: string, id: string, recordedAt: number, preview?: string): ToolEvent {
  return { id, serverId, runId, toolName: 'shell', eventType: 'tool_finished', preview, recordedAt };
}

let db: MemoryDatabase;
let repo: Repository;

beforeEach(async () => {
  db = new MemoryDatabase();
  repo = createSQLiteRepository(db, () => NOW);
  await repo.init();
});

describe('迁移', () => {
  test('init 建立 schema 并写入 user_version', async () => {
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assert.equal(row?.user_version, MIGRATIONS.length);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    for (const table of [
      'messages', 'outbound_turns', 'pending_credential_deletes',
      'runs', 'servers', 'sessions', 'settings', 'tool_events',
    ]) {
      assert.ok(names.includes(table), `缺少表 ${table}`);
    }
  });

  test('重复 init 不重放迁移、不清数据', async () => {
    await repo.saveServer(server('a'));
    await repo.init();
    assert.equal((await repo.listServers()).length, 1);
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    assert.equal(row?.user_version, MIGRATIONS.length);
  });

  test('多版本迁移按序执行且只跑未应用的版本', async () => {
    const fresh = new MemoryDatabase();
    const applied: number[] = [];
    const list = [
      { version: 1, statements: ['CREATE TABLE t1 (id INTEGER)'] },
      { version: 3, statements: ['CREATE TABLE t3 (id INTEGER)'] },
      { version: 2, statements: ['CREATE TABLE t2 (id INTEGER)'] },
    ];
    assert.equal(await migrate(fresh, list), 3);
    for (const version of [1, 2, 3]) {
      const table = await fresh.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = 't${version}'`);
      assert.ok(table, `v${version} 未执行`);
      applied.push(version);
    }
    assert.deepEqual(applied, [1, 2, 3]);
    // 已是最新版本：再跑一次不重复建表（会因表已存在而报错，这里应静默跳过）。
    assert.equal(await migrate(fresh, list), 3);
  });

  test('非法版本号被拒绝', async () => {
    await assert.rejects(
      () => migrate(new MemoryDatabase(), [{ version: 1.5, statements: [] }]),
      /非法迁移版本/,
    );
  });
});

describe('servers', () => {
  test('保存后可按 createdAt 读回完整字段（含 capabilities/credentialRef）', async () => {
    await repo.saveServer(server('a'));
    const [saved] = await repo.listServers();
    assert.ok(saved);
    assert.equal(saved.name, 'hermes-a');
    assert.equal(saved.credentialRef, 'cred-a');
    assert.equal(saved.createdAt, NOW);
    assert.equal(saved.capabilities.mode, 'native_runs');
    assert.equal(saved.capabilities.model, 'hermes-3');
    assert.equal(saved.capabilities.checkedAt, NOW);
    assert.equal(saved.allowHttp, false);
  });

  test('upsert 更新能力探测结果但保留 createdAt', async () => {
    await repo.saveServer(server('a'));
    await repo.saveServer({ ...server('a'), name: '改名', capabilities: { mode: 'openai_compat', features: {}, checkedAt: NOW + 5 } });
    const servers = await repo.listServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, '改名');
    assert.equal(servers[0]?.createdAt, NOW);
    assert.equal(servers[0]?.capabilities.mode, 'openai_compat');
    assert.equal(servers[0]?.capabilities.checkedAt, NOW + 5);
  });

  test('SQLite 里不出现密钥本体', async () => {
    await repo.saveServer(server('a'));
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM servers');
    assert.equal(JSON.stringify(rows).includes('sk-secret'), false);
    assert.equal(rows[0]?.credential_ref, 'cred-a');
  });
});

describe('server_id 隔离', () => {
  test('同 session_id / message_id 在两个服务器上互不可见', async () => {
    await repo.saveServer(server('a'));
    await repo.saveServer(server('b'));
    await repo.saveSessions('a', [session('a', 's1')]);
    await repo.saveSessions('b', [session('b', 's1')]);
    await repo.replaceMessages('a', 's1', [message('a', 's1', 'm1', NOW, '来自 A')]);
    await repo.replaceMessages('b', 's1', [message('b', 's1', 'm1', NOW, '来自 B')]);

    assert.deepEqual((await repo.listMessages('a', 's1')).map((m) => m.body), ['来自 A']);
    assert.deepEqual((await repo.listMessages('b', 's1')).map((m) => m.body), ['来自 B']);
    assert.deepEqual((await repo.listSessions('a')).map((s) => s.serverId), ['a']);
    assert.deepEqual((await repo.listSessions('b')).map((s) => s.serverId), ['b']);
  });

  test('替换 A 的消息不影响 B，runs/turns/tool_events 同样隔离', async () => {
    await repo.replaceMessages('a', 's1', [message('a', 's1', 'm1', NOW)]);
    await repo.replaceMessages('b', 's1', [message('b', 's1', 'm1', NOW)]);
    await repo.replaceMessages('a', 's1', []);
    assert.equal((await repo.listMessages('a', 's1')).length, 0);
    assert.equal((await repo.listMessages('b', 's1')).length, 1);

    await repo.saveRun(run('a', 's1', 'r1'));
    await repo.saveRun(run('b', 's1', 'r1'));
    assert.deepEqual((await repo.listRuns('a')).map((r) => r.serverId), ['a']);
    assert.equal((await repo.listRuns('b', 's1'))[0]?.runId, 'r1');

    await repo.saveTurn({ clientTurnId: 't1', serverId: 'a', sessionId: 's1', idempotencyKey: 'k', requestBodyJson: '{}', submissionState: 'queued', createdAt: NOW });
    await repo.saveTurn({ clientTurnId: 't1', serverId: 'b', sessionId: 's1', idempotencyKey: 'k', requestBodyJson: '{}', submissionState: 'running', createdAt: NOW });
    assert.equal((await repo.listTurns('a'))[0]?.submissionState, 'queued');
    assert.equal((await repo.listTurns('b'))[0]?.submissionState, 'running');

    await repo.saveToolEvent(toolEvent('a', 'r1', 'e1', NOW, 'A 的输出'));
    await repo.saveToolEvent(toolEvent('b', 'r1', 'e1', NOW, 'B 的输出'));
    assert.deepEqual((await repo.listToolEvents('a', 'r1')).map((e) => e.preview), ['A 的输出']);
    assert.deepEqual((await repo.listToolEvents('b', 'r1')).map((e) => e.preview), ['B 的输出']);
  });

  test('deleteServer 只清目标服务器并登记待删密钥', async () => {
    await repo.saveServer(server('a'));
    await repo.saveServer(server('b'));
    await repo.saveSessions('a', [session('a', 's1')]);
    await repo.saveSessions('b', [session('b', 's1')]);
    await repo.replaceMessages('a', 's1', [message('a', 's1', 'm1', NOW)]);
    await repo.replaceMessages('b', 's1', [message('b', 's1', 'm1', NOW)]);
    await repo.saveRun(run('a', 's1', 'r1'));
    await repo.saveToolEvent(toolEvent('a', 'r1', 'e1', NOW, 'x'));

    await repo.deleteServer('a');

    assert.deepEqual((await repo.listServers()).map((s) => s.id), ['b']);
    assert.equal((await repo.listSessions('a')).length, 0);
    assert.equal((await repo.listMessages('a', 's1')).length, 0);
    assert.equal((await repo.listRuns('a')).length, 0);
    assert.equal((await repo.listToolEvents('a', 'r1')).length, 0);
    assert.equal((await repo.listMessages('b', 's1')).length, 1);
    assert.deepEqual(await repo.listPendingCredentialDeletes(), ['cred-a']);
  });

  test('clearCache 清缓存但保留服务器与设置', async () => {
    await repo.saveServer(server('a'));
    await repo.setSetting('theme', 'dark');
    await repo.saveSessions('a', [session('a', 's1')]);
    await repo.replaceMessages('a', 's1', [message('a', 's1', 'm1', NOW)]);
    await repo.saveRun(run('a', 's1', 'r1'));
    await repo.saveToolEvent(toolEvent('a', 'r1', 'e1', NOW, 'x'));

    await repo.clearCache('a');

    assert.equal((await repo.listSessions('a')).length, 0);
    assert.equal((await repo.listMessages('a', 's1')).length, 0);
    assert.equal((await repo.listRuns('a')).length, 0);
    assert.equal((await repo.listToolEvents('a', 'r1')).length, 0);
    assert.equal((await repo.listServers()).length, 1);
    assert.equal(await repo.getSetting('theme'), 'dark');
  });
});

describe('messages', () => {
  test('replaceMessages 覆盖旧内容并按 created_at 排序', async () => {
    await repo.replaceMessages('a', 's1', [message('a', 's1', 'old', NOW)]);
    await repo.replaceMessages('a', 's1', [
      message('a', 's1', 'm3', NOW + 30, '第三'),
      message('a', 's1', 'm1', NOW + 10, '第一'),
      message('a', 's1', 'm2', NOW + 20, '第二'),
    ]);
    const list = await repo.listMessages('a', 's1');
    assert.deepEqual(list.map((m) => m.body), ['第一', '第二', '第三']);
    assert.deepEqual(list.map((m) => m.id), ['m1', 'm2', 'm3']);
  });

  test('replaceMessages 失败时整体回滚，旧消息不丢', async () => {
    await repo.replaceMessages('a', 's1', [message('a', 's1', 'keep', NOW, '保留')]);
    const broken = { ...message('a', 's1', 'bad', NOW + 1), role: null } as unknown as Message;
    await assert.rejects(() => repo.replaceMessages('a', 's1', [message('a', 's1', 'new', NOW + 2), broken]));
    const list = await repo.listMessages('a', 's1');
    assert.deepEqual(list.map((m) => m.id), ['keep']);
  });

  test('消息正文按参数化 SQL 原样保存', async () => {
    const body = "'; DROP TABLE messages; --";
    await repo.replaceMessages('a', 's1', [message('a', 's1', 'm1', NOW, body)]);
    assert.equal((await repo.listMessages('a', 's1'))[0]?.body, body);
    assert.equal((await repo.listMessages('a', 's1')).length, 1);
  });

  test('deleteSession 连带清理该会话消息/运行/发送记录', async () => {
    await repo.saveSessions('a', [session('a', 's1'), session('a', 's2')]);
    await repo.replaceMessages('a', 's1', [message('a', 's1', 'm1', NOW)]);
    await repo.replaceMessages('a', 's2', [message('a', 's2', 'm2', NOW)]);
    await repo.saveRun(run('a', 's1', 'r1'));
    await repo.deleteSession('a', 's1');
    assert.deepEqual((await repo.listSessions('a')).map((s) => s.id), ['s2']);
    assert.equal((await repo.listMessages('a', 's1')).length, 0);
    assert.equal((await repo.listMessages('a', 's2')).length, 1);
    assert.equal((await repo.listRuns('a', 's1')).length, 0);
  });
});

describe('runs 与 turns', () => {
  test('run 的 pendingControls/admissionId 往返一致，upsert 更新状态', async () => {
    await repo.saveRun(run('a', 's1', 'r1'));
    const [saved] = await repo.listRuns('a', 's1');
    assert.ok(saved);
    assert.equal(saved.status, 'waiting_for_approval');
    assert.equal(saved.admissionId, 'adm-r1');
    assert.equal(saved.executionGeneration, 3);
    assert.equal(saved.pendingControls?.[0]?.prompt, '允许执行？');
    assert.deepEqual(saved.pendingControls?.[0]?.choices, ['yes']);

    await repo.saveRun({ ...run('a', 's1', 'r1'), status: 'completed', pendingControls: undefined, updatedAt: NOW + 10 });
    const [updated] = await repo.listRuns('a', 's1');
    assert.equal(updated?.status, 'completed');
    assert.equal(updated?.pendingControls, undefined);
    assert.equal((await repo.listRuns('a')).length, 1);
  });

  test('turn 记录幂等键与提交状态，可按会话过滤', async () => {
    await repo.saveTurn({ clientTurnId: 't1', serverId: 'a', sessionId: 's1', idempotencyKey: 'idem-1', requestBodyJson: '{"input":"hi"}', submissionState: 'submitting', createdAt: NOW });
    await repo.saveTurn({ clientTurnId: 't2', serverId: 'a', sessionId: 's2', idempotencyKey: 'idem-2', requestBodyJson: '{}', submissionState: 'queued', createdAt: NOW + 1 });
    await repo.saveTurn({ clientTurnId: 't1', serverId: 'a', sessionId: 's1', idempotencyKey: 'idem-1', requestBodyJson: '{"input":"hi"}', runId: 'r1', submissionState: 'queued', createdAt: NOW });

    const all = await repo.listTurns('a');
    assert.equal(all.length, 2);
    const [latest] = all;
    assert.equal(latest?.clientTurnId, 't2');
    const [t1] = await repo.listTurns('a', 's1');
    assert.equal(t1?.runId, 'r1');
    assert.equal(t1?.submissionState, 'queued');
    assert.equal(t1?.idempotencyKey, 'idem-1');
  });
});

describe('tool_events 预览与过期', () => {
  test('预览按 TOOL_PREVIEW_MAX 截断', async () => {
    const long = 'x'.repeat(TOOL_PREVIEW_MAX + 200);
    await repo.saveToolEvent(toolEvent('a', 'r1', 'e1', NOW, long));
    const [saved] = await repo.listToolEvents('a', 'r1');
    assert.equal(saved?.preview?.length, TOOL_PREVIEW_MAX);
  });

  test('超过 TTL 的事件在下次写入时清理', async () => {
    await repo.saveToolEvent(toolEvent('a', 'r1', 'old', NOW - TOOL_EVENT_TTL_MS - 1, '过期'));
    await repo.saveToolEvent(toolEvent('a', 'r1', 'fresh', NOW, '新鲜'));
    const list = await repo.listToolEvents('a', 'r1');
    assert.deepEqual(list.map((e) => e.id), ['fresh']);
  });
});

describe('settings', () => {
  test('读写与覆盖', async () => {
    assert.equal(await repo.getSetting('missing'), null);
    await repo.setSetting('cache.enabled', '1');
    assert.equal(await repo.getSetting('cache.enabled'), '1');
    await repo.setSetting('cache.enabled', '0');
    assert.equal(await repo.getSetting('cache.enabled'), '0');
  });
});

describe('待删密钥重试', () => {
  test('删除失败的引用保留在待删表，重试成功后清除', async () => {
    await repo.saveServer(server('a'));
    await repo.deleteServer('a');

    const store = new Map<string, string>([['cred-a', 'sk-secret']]);
    let failing = true;
    const vault = {
      get: async (ref: string) => store.get(ref) ?? null,
      set: async (ref: string, key: string) => void store.set(ref, key),
      remove: async (ref: string) => {
        if (failing) throw new Error('keychain 暂不可用');
        store.delete(ref);
      },
    };

    const first = await flushPendingCredentialDeletes(repo, vault);
    assert.deepEqual(first, { removed: [], failed: ['cred-a'] });
    assert.deepEqual(await repo.listPendingCredentialDeletes(), ['cred-a']);
    assert.equal(store.get('cred-a'), 'sk-secret');

    failing = false;
    const second = await flushPendingCredentialDeletes(repo, vault);
    assert.deepEqual(second, { removed: ['cred-a'], failed: [] });
    assert.deepEqual(await repo.listPendingCredentialDeletes(), []);
    assert.equal(store.has('cred-a'), false);
  });

  test('finishCredentialDelete 幂等', async () => {
    await repo.saveServer(server('a'));
    await repo.deleteServer('a');
    await repo.finishCredentialDelete('cred-a');
    await repo.finishCredentialDelete('cred-a');
    assert.deepEqual(await repo.listPendingCredentialDeletes(), []);
  });
});
