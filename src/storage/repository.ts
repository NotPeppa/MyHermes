import type { Repository } from '../domain/contracts';
import type {
  Capabilities,
  Message,
  OutboundTurn,
  PendingControl,
  Run,
  RunState,
  ServerConnection,
  Session,
  ToolEvent,
} from '../domain/models';
import { migrate, type SQLiteBindValue, type SQLiteDatabase } from './sqlite';

/** 工具预览落库上限：避免把大段终端输出长期留在 SQLite 里。 */
export const TOOL_PREVIEW_MAX = 500;
/** 工具事件保留时长，超过即在写入时清理。 */
export const TOOL_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FALLBACK_CAPABILITIES: Capabilities = { mode: 'unsupported', features: {}, checkedAt: 0 };

interface ServerRow {
  id: string;
  display_name: string;
  base_url: string;
  credential_ref: string;
  allow_http: number;
  capabilities_json: string | null;
  capabilities_checked_at: number | null;
  created_at: number;
}

interface SessionRow {
  server_id: string;
  session_id: string;
  title: string | null;
  updated_at: number | null;
  local_only: number;
  snapshot_json: string | null;
}

interface MessageRow {
  server_id: string;
  id: string;
  session_id: string;
  server_message_id: string | null;
  role: string;
  body: string;
  created_at: number;
}

interface TurnRow {
  server_id: string;
  client_turn_id: string;
  session_id: string;
  idempotency_key: string;
  request_body_json: string;
  run_id: string | null;
  submission_state: string;
  created_at: number;
}

interface RunRow {
  server_id: string;
  run_id: string;
  session_id: string;
  client_turn_id: string;
  idempotency_key: string;
  request_body_json: string;
  status: string;
  raw_status: string | null;
  final_output: string | null;
  admission_id: string | null;
  execution_generation: number | null;
  pending_controls_json: string | null;
  updated_at: number;
}

interface ToolEventRow {
  server_id: string;
  id: string;
  run_id: string;
  tool_name: string | null;
  event_type: string;
  preview: string | null;
  recorded_at: number;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toServer(row: ServerRow): ServerConnection {
  const capabilities = parseJson<Capabilities>(row.capabilities_json) ?? FALLBACK_CAPABILITIES;
  return {
    id: row.id,
    name: row.display_name,
    baseUrl: row.base_url,
    credentialRef: row.credential_ref,
    capabilities: { ...capabilities, checkedAt: row.capabilities_checked_at ?? capabilities.checkedAt },
    createdAt: row.created_at,
    allowHttp: row.allow_http === 1,
  };
}

function toSession(row: SessionRow): Session {
  return {
    serverId: row.server_id,
    id: row.session_id,
    title: row.title ?? '',
    updatedAt: row.updated_at ?? 0,
    localOnly: row.local_only === 1,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    serverId: row.server_id,
    sessionId: row.session_id,
    role: row.role as Message['role'],
    body: row.body,
    createdAt: row.created_at,
    serverMessageId: row.server_message_id ?? undefined,
  };
}

function toTurn(row: TurnRow): OutboundTurn {
  return {
    clientTurnId: row.client_turn_id,
    serverId: row.server_id,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    requestBodyJson: row.request_body_json,
    runId: row.run_id ?? undefined,
    submissionState: row.submission_state as RunState,
    createdAt: row.created_at,
  };
}

function toRun(row: RunRow): Run {
  return {
    runId: row.run_id,
    serverId: row.server_id,
    sessionId: row.session_id,
    clientTurnId: row.client_turn_id,
    idempotencyKey: row.idempotency_key,
    requestBodyJson: row.request_body_json,
    status: row.status as RunState,
    rawStatus: row.raw_status ?? undefined,
    finalOutput: row.final_output ?? undefined,
    admissionId: row.admission_id ?? undefined,
    executionGeneration: row.execution_generation ?? undefined,
    pendingControls: parseJson<PendingControl[]>(row.pending_controls_json) ?? undefined,
    updatedAt: row.updated_at,
  };
}

function toToolEvent(row: ToolEventRow): ToolEvent {
  return {
    id: row.id,
    serverId: row.server_id,
    runId: row.run_id,
    toolName: row.tool_name ?? '',
    eventType: row.event_type,
    preview: row.preview ?? undefined,
    recordedAt: row.recorded_at,
  };
}

/** 只保留前 TOOL_PREVIEW_MAX 个字符，其余丢弃（不落库、不拼接省略号以外的内容）。 */
export function truncatePreview(preview: string | undefined): string | null {
  if (preview === undefined) return null;
  return preview.length > TOOL_PREVIEW_MAX ? preview.slice(0, TOOL_PREVIEW_MAX) : preview;
}

/**
 * Repository 的 SQLite 实现。所有语句都参数化，且每条查询都带 server_id 约束；
 * 跨服务器同 ID 的数据不会互相覆盖或读出。app 侧请用 sqlite.ts 的 createRepository()。
 */
export function createSQLiteRepository(
  db: SQLiteDatabase,
  now: () => number = Date.now,
): Repository {
  const serverScoped = (serverId: string): SQLiteBindValue[] => [serverId];

  async function deleteServerRows(serverId: string): Promise<void> {
    for (const table of ['messages', 'sessions', 'runs', 'outbound_turns', 'tool_events']) {
      await db.runAsync(`DELETE FROM ${table} WHERE server_id = ?`, serverScoped(serverId));
    }
  }

  return {
    async init() {
      await migrate(db);
    },

    async listServers() {
      const rows = await db.getAllAsync<ServerRow>(
        'SELECT * FROM servers ORDER BY created_at ASC, id ASC',
      );
      return rows.map(toServer);
    },

    async saveServer(server) {
      await db.runAsync(
        `INSERT INTO servers (
          id, display_name, base_url, credential_ref, allow_http,
          capabilities_json, capabilities_checked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          base_url = excluded.base_url,
          credential_ref = excluded.credential_ref,
          allow_http = excluded.allow_http,
          capabilities_json = excluded.capabilities_json,
          capabilities_checked_at = excluded.capabilities_checked_at`,
        [
          server.id,
          server.name,
          server.baseUrl,
          server.credentialRef,
          server.allowHttp === true ? 1 : 0,
          JSON.stringify(server.capabilities),
          server.capabilities.checkedAt,
          server.createdAt,
        ],
      );
    },

    async deleteServer(serverId) {
      await db.withTransactionAsync(async () => {
        const row = await db.getFirstAsync<{ credential_ref: string }>(
          'SELECT credential_ref FROM servers WHERE id = ?',
          serverScoped(serverId),
        );
        await deleteServerRows(serverId);
        await db.runAsync('DELETE FROM servers WHERE id = ?', serverScoped(serverId));
        if (row) {
          // 只登记引用，密钥本体由 CredentialVault 异步删除并重试。
          await db.runAsync(
            'INSERT OR IGNORE INTO pending_credential_deletes (credential_ref, created_at) VALUES (?, ?)',
            [row.credential_ref, now()],
          );
        }
      });
    },

    async listSessions(serverId) {
      const rows = await db.getAllAsync<SessionRow>(
        'SELECT * FROM sessions WHERE server_id = ? ORDER BY updated_at DESC, session_id ASC',
        serverScoped(serverId),
      );
      return rows.map(toSession);
    },

    async saveSessions(serverId, sessions) {
      await db.withTransactionAsync(async () => {
        for (const session of sessions) {
          await db.runAsync(
            `INSERT INTO sessions (server_id, session_id, title, updated_at, local_only, snapshot_json)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(server_id, session_id) DO UPDATE SET
               title = excluded.title,
               updated_at = excluded.updated_at,
               local_only = excluded.local_only,
               snapshot_json = excluded.snapshot_json`,
            [
              serverId,
              session.id,
              session.title,
              session.updatedAt,
              session.localOnly === true ? 1 : 0,
              null,
            ],
          );
        }
      });
    },

    async deleteSession(serverId, sessionId) {
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM sessions WHERE server_id = ? AND session_id = ?', [
          serverId,
          sessionId,
        ]);
        await db.runAsync('DELETE FROM messages WHERE server_id = ? AND session_id = ?', [
          serverId,
          sessionId,
        ]);
        await db.runAsync('DELETE FROM runs WHERE server_id = ? AND session_id = ?', [
          serverId,
          sessionId,
        ]);
        await db.runAsync('DELETE FROM outbound_turns WHERE server_id = ? AND session_id = ?', [
          serverId,
          sessionId,
        ]);
      });
    },

    async listMessages(serverId, sessionId) {
      const rows = await db.getAllAsync<MessageRow>(
        `SELECT server_id, id, session_id, server_message_id, role, body, created_at
         FROM messages WHERE server_id = ? AND session_id = ?
         ORDER BY created_at ASC, id ASC`,
        [serverId, sessionId],
      );
      return rows.map(toMessage);
    },

    async replaceMessages(serverId, sessionId, messages) {
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM messages WHERE server_id = ? AND session_id = ?', [
          serverId,
          sessionId,
        ]);
        for (const message of messages) {
          await db.runAsync(
            `INSERT INTO messages (server_id, id, session_id, server_message_id, role, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              serverId,
              message.id,
              sessionId,
              message.serverMessageId ?? null,
              message.role,
              message.body,
              message.createdAt,
            ],
          );
        }
      });
    },

    async saveTurn(turn) {
      await db.runAsync(
        `INSERT INTO outbound_turns (
          server_id, client_turn_id, session_id, idempotency_key,
          request_body_json, run_id, submission_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, client_turn_id) DO UPDATE SET
          run_id = excluded.run_id,
          submission_state = excluded.submission_state`,
        [
          turn.serverId,
          turn.clientTurnId,
          turn.sessionId,
          turn.idempotencyKey,
          turn.requestBodyJson,
          turn.runId ?? null,
          turn.submissionState,
          turn.createdAt,
        ],
      );
    },

    async listTurns(serverId, sessionId) {
      const rows = sessionId === undefined
        ? await db.getAllAsync<TurnRow>(
            'SELECT * FROM outbound_turns WHERE server_id = ? ORDER BY created_at DESC, client_turn_id ASC',
            serverScoped(serverId),
          )
        : await db.getAllAsync<TurnRow>(
            `SELECT * FROM outbound_turns WHERE server_id = ? AND session_id = ?
             ORDER BY created_at DESC, client_turn_id ASC`,
            [serverId, sessionId],
          );
      return rows.map(toTurn);
    },

    async saveRun(run) {
      await db.runAsync(
        `INSERT INTO runs (
          server_id, run_id, session_id, client_turn_id, idempotency_key, request_body_json,
          status, raw_status, final_output, admission_id, execution_generation,
          pending_controls_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, run_id) DO UPDATE SET
          status = excluded.status,
          raw_status = excluded.raw_status,
          final_output = excluded.final_output,
          admission_id = excluded.admission_id,
          execution_generation = excluded.execution_generation,
          pending_controls_json = excluded.pending_controls_json,
          updated_at = excluded.updated_at`,
        [
          run.serverId,
          run.runId,
          run.sessionId,
          run.clientTurnId,
          run.idempotencyKey,
          run.requestBodyJson,
          run.status,
          run.rawStatus ?? null,
          run.finalOutput ?? null,
          run.admissionId ?? null,
          run.executionGeneration ?? null,
          run.pendingControls === undefined ? null : JSON.stringify(run.pendingControls),
          run.updatedAt,
        ],
      );
    },

    async listRuns(serverId, sessionId) {
      const rows = sessionId === undefined
        ? await db.getAllAsync<RunRow>(
            'SELECT * FROM runs WHERE server_id = ? ORDER BY updated_at DESC, run_id ASC',
            serverScoped(serverId),
          )
        : await db.getAllAsync<RunRow>(
            `SELECT * FROM runs WHERE server_id = ? AND session_id = ?
             ORDER BY updated_at DESC, run_id ASC`,
            [serverId, sessionId],
          );
      return rows.map(toRun);
    },

    async saveToolEvent(event) {
      const cutoff = now() - TOOL_EVENT_TTL_MS;
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM tool_events WHERE recorded_at < ?', [cutoff]);
        await db.runAsync(
          `INSERT INTO tool_events (server_id, id, run_id, tool_name, event_type, preview, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(server_id, id) DO UPDATE SET
             event_type = excluded.event_type,
             preview = excluded.preview,
             recorded_at = excluded.recorded_at`,
          [
            event.serverId,
            event.id,
            event.runId,
            event.toolName,
            event.eventType,
            truncatePreview(event.preview),
            event.recordedAt,
          ],
        );
      });
    },

    async listToolEvents(serverId, runId) {
      const rows = await db.getAllAsync<ToolEventRow>(
        `SELECT * FROM tool_events WHERE server_id = ? AND run_id = ?
         ORDER BY recorded_at ASC, id ASC`,
        [serverId, runId],
      );
      return rows.map(toToolEvent);
    },

    async clearCache(serverId) {
      await db.withTransactionAsync(async () => {
        await deleteServerRows(serverId);
        await db.runAsync('DELETE FROM tool_events WHERE recorded_at < ?', [now() - TOOL_EVENT_TTL_MS]);
      });
    },

    async getSetting(key) {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM settings WHERE key = ?',
        [key],
      );
      return row?.value ?? null;
    },

    async setSetting(key, value) {
      await db.runAsync(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    },

    async listPendingCredentialDeletes() {
      const rows = await db.getAllAsync<{ credential_ref: string }>(
        'SELECT credential_ref FROM pending_credential_deletes ORDER BY created_at ASC, credential_ref ASC',
      );
      return rows.map((row) => row.credential_ref);
    },

    async finishCredentialDelete(ref) {
      await db.runAsync('DELETE FROM pending_credential_deletes WHERE credential_ref = ?', [ref]);
    },
  };
}
