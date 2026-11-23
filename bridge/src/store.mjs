/**
 * 推送桥的持久层：设备、事件、投递记录。
 * 用 Node 内置的 node:sqlite，不引入第三方数据库依赖。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  server_id TEXT NOT NULL,
  server_alias TEXT,
  device_name TEXT,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  session_id TEXT,
  session_title TEXT,
  state TEXT NOT NULL,
  preview TEXT,
  ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (event_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries(device_id, delivered_at);
`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const hashSecret = (secret) => sha256(secret);

/** 定长比较，避免用 === 比较密钥。 */
export function secretMatches(secret, storedHash) {
  const a = Buffer.from(sha256(secret ?? ''), 'hex');
  const b = Buffer.from(storedHash ?? '', 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const api = {
    db,
    /** 注册设备：未传 deviceId 时分配新 ID；已存在时只允许校验通过后轮换，不允许未鉴权覆盖。 */
    registerDevice({ deviceId, platform, serverId, serverAlias, deviceName, now = Date.now(), allowOverwrite = false }) {
      const id = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : `dev_${randomBytes(9).toString('hex')}`;
      const existing = api.db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(id);
      if (existing && !allowOverwrite) {
        const error = new Error('device_already_exists');
        error.code = 'CONFLICT';
        throw error;
      }
      const secret = randomBytes(32).toString('hex');
      api.db
        .prepare(
          `INSERT INTO devices (device_id, platform, server_id, server_alias, device_name, secret_hash, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             platform = excluded.platform,
             server_id = excluded.server_id,
             server_alias = excluded.server_alias,
             device_name = excluded.device_name,
             secret_hash = excluded.secret_hash,
             last_seen_at = excluded.last_seen_at,
             revoked_at = NULL`,
        )
        .run(
          id,
          String(platform),
          String(serverId),
          typeof serverAlias === 'string' ? serverAlias : null,
          typeof deviceName === 'string' ? deviceName : null,
          hashSecret(secret),
          now,
          now,
        );
      return { deviceId: id, secret };
    },
    getDevice(deviceId) {
      return api.db.prepare('SELECT * FROM devices WHERE device_id = ? AND revoked_at IS NULL').get(deviceId) ?? null;
    },
    listDevices(serverId) {
      return serverId && serverId !== '*'
        ? api.db.prepare("SELECT * FROM devices WHERE (server_id = ? OR server_id = '*') AND revoked_at IS NULL").all(serverId)
        : api.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL').all();
    },
    revokeDevice(deviceId, now = Date.now()) {
      api.db.prepare('UPDATE devices SET revoked_at = ? WHERE device_id = ?').run(now, deviceId);
    },
    touchDevice(deviceId, now = Date.now()) {
      api.db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(now, deviceId);
    },
    /**
     * 写入事件并给该实例下所有未撤销设备建投递记录。
     * 已存在的事件直接跳过（幂等），返回是否新事件。
     */
    ingestEvent(event, now = Date.now()) {
      const inserted = api.db
        .prepare(
          `INSERT OR IGNORE INTO events (event_id, server_id, session_id, session_title, state, preview, ts, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.eventId,
          event.serverId,
          event.sessionId ?? null,
          event.sessionTitle ?? null,
          event.state,
          event.preview ?? null,
          event.ts ?? now,
          now,
        );
      if (inserted.changes === 0) return { fresh: false, pending: 0 };
      const devices = api.listDevices(event.serverId);
      const insertDelivery = api.db.prepare('INSERT OR IGNORE INTO deliveries (event_id, device_id) VALUES (?, ?)');
      for (const device of devices) insertDelivery.run(event.eventId, device.device_id);
      return { fresh: true, pending: devices.length };
    },
    /** 拉取某设备尚未投递的事件（离线补发）。 */
    pendingFor(deviceId, limit = 20) {
      return api.db
        .prepare(
          `SELECT e.* FROM deliveries d JOIN events e ON e.event_id = d.event_id
           WHERE d.device_id = ? AND d.delivered_at IS NULL
           ORDER BY e.created_at ASC LIMIT ?`,
        )
        .all(deviceId, limit);
    },
    markDelivered(eventIds, deviceId, now = Date.now()) {
      const stmt = api.db.prepare('UPDATE deliveries SET delivered_at = ? WHERE event_id = ? AND device_id = ?');
      for (const eventId of eventIds) stmt.run(now, eventId, deviceId);
    },
    stats() {
      return {
        devices: api.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL').get().n,
        events: api.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
        pending: api.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE delivered_at IS NULL').get().n,
      };
    },
    close() {
      db.close();
    },
  };
  return api;
}
