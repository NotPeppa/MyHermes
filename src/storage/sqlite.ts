/**
 * 存储层入口：可注入的 SQLite 接口、版本化迁移，以及 Repository 工厂。
 *
 * 默认实现用 expo-sqlite（openDatabaseAsync('myhermes.db')）；`createRepository(db)`
 * 允许注入任意实现，node:test 用内存 SQLite 跑真实 SQL 验证隔离与迁移。
 * expo-sqlite 只在默认路径里动态 import，测试进程不会加载原生模块。
 */
import type { Repository } from '../domain/contracts';
import { createSQLiteRepository } from './repository';

export type SQLiteBindValue = string | number | null;

export interface SQLiteDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params?: SQLiteBindValue[]): Promise<void>;
  getAllAsync<T>(source: string, params?: SQLiteBindValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params?: SQLiteBindValue[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export interface Migration {
  version: number;
  statements: string[];
}

export const DATABASE_NAME = 'myhermes.db';

/**
 * schema 版本 1。所有表都带 server_id（servers 自身用 id），复合主键保证
 * 不同服务器上同 ID 的记录不会互相覆盖。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        allow_http INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT,
        capabilities_checked_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE sessions (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT,
        updated_at INTEGER,
        local_only INTEGER NOT NULL DEFAULT 0,
        snapshot_json TEXT,
        PRIMARY KEY (server_id, session_id)
      )`,
      `CREATE INDEX idx_sessions_server ON sessions(server_id, updated_at DESC)`,
      `CREATE TABLE messages (
        server_id TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        server_message_id TEXT,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        is_draft INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, id)
      )`,
      `CREATE INDEX idx_messages_session ON messages(server_id, session_id, created_at, id)`,
      `CREATE TABLE runs (
        server_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        client_turn_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_body_json TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_status TEXT,
        final_output TEXT,
        admission_id TEXT,
        execution_generation INTEGER,
        pending_controls_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, run_id)
      )`,
      `CREATE INDEX idx_runs_session ON runs(server_id, session_id, updated_at DESC)`,
      `CREATE TABLE outbound_turns (
        server_id TEXT NOT NULL,
        client_turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_body_json TEXT NOT NULL,
        run_id TEXT,
        submission_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, client_turn_id)
      )`,
      `CREATE INDEX idx_turns_session ON outbound_turns(server_id, session_id, created_at)`,
      `CREATE TABLE tool_events (
        server_id TEXT NOT NULL,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_name TEXT,
        event_type TEXT NOT NULL,
        preview TEXT,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, id)
      )`,
      `CREATE INDEX idx_tool_events_run ON tool_events(server_id, run_id, recorded_at)`,
      `CREATE INDEX idx_tool_events_recorded ON tool_events(recorded_at)`,
      `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE pending_credential_deletes (
        credential_ref TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`,
    ],
  },
];

/**
 * 按 user_version 递增执行未应用的迁移。每个版本一个事务，失败即回滚并抛出。
 * 返回迁移后的版本号。
 */
export async function migrate(
  db: SQLiteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let current = row?.user_version ?? 0;

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    // PRAGMA 不接受绑定参数，只接受本模块自带的整数版本号。
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`非法迁移版本: ${String(migration.version)}`);
    }
    await db.withTransactionAsync(async () => {
      for (const statement of migration.statements) await db.execAsync(statement);
      await db.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
    current = migration.version;
  }

  return current;
}

/** expo-sqlite 的 SQLiteDatabase 中本层用到的部分（结构化类型，避免顶层 import）。 */
interface ExpoDatabaseLike {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SQLiteBindValue[]): Promise<unknown>;
  getAllAsync<T>(source: string, params: SQLiteBindValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: SQLiteBindValue[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  withExclusiveTransactionAsync?(task: (txn: ExpoDatabaseLike) => Promise<void>): Promise<void>;
}

function adaptExpoDatabase(db: ExpoDatabaseLike): SQLiteDatabase {
  // 串行化事务，避免 expo-sqlite 并发调用 withTransactionAsync 触发嵌套事务报错
  let txQueue: Promise<void> = Promise.resolve();
  return {
    execAsync: (source) => db.execAsync(source),
    runAsync: async (source, params = []) => {
      await db.runAsync(source, params);
    },
    getAllAsync: (source, params = []) => db.getAllAsync(source, params),
    getFirstAsync: (source, params = []) => db.getFirstAsync(source, params),
    withTransactionAsync: (task) => {
      const run = txQueue.then(() => db.withTransactionAsync(task));
      txQueue = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * 创建 Repository。不传 db 时打开 expo-sqlite 的 myhermes.db 并完成迁移
 * （首次访问时惰性打开，init() 也会等它完成）。
 */
export function createRepository(db?: SQLiteDatabase): Repository {
  if (db) return createSQLiteRepository(db);

  let opened: Promise<SQLiteDatabase> | null = null;
  const open = (): Promise<SQLiteDatabase> => {
    opened ??= (async () => {
      const { openDatabaseAsync } = await import('expo-sqlite');
      const database = adaptExpoDatabase(await openDatabaseAsync(DATABASE_NAME));
      await migrate(database);
      return database;
    })().catch((error: unknown) => {
      opened = null; // 打开失败后允许下次调用重试
      throw error;
    });
    return opened;
  };

  const methods = ['execAsync', 'runAsync', 'getAllAsync', 'getFirstAsync', 'withTransactionAsync'] as const;
  const lazyDb = Object.fromEntries(
    methods.map((name) => [
      name,
      async (...args: unknown[]) => {
        const db = await open();
        const call = db[name] as (...inner: unknown[]) => Promise<unknown>;
        return call(...args);
      },
    ]),
  ) as unknown as SQLiteDatabase;

  const repository = createSQLiteRepository(lazyDb);
  return {
    ...repository,
    init: async () => {
      await open();
      await repository.init();
    },
  };
}
