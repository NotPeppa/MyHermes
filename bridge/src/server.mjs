/**
 * MyHermes 推送桥。
 *
 *   Hermes 侧 agent ──POST /events（HMAC）──▶ 桥 ──WebSocket──▶ 手机 App ──▶ 本地通知
 *
 * 设计约束（对齐产品设计文档 §14.2）：
 * - 桥不持有 Hermes 的 API Key；事件由 Hermes 主机上的 agent 推送过来
 * - 通知 payload 默认不含正文，只有实例、会话、状态；需要预览时由 agent 显式开启
 * - 设备用一次性密钥鉴权，可撤销；事件按 eventId 幂等去重
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { openStore, secretMatches } from './store.mjs';
import { createPoller } from './poller.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 校验 Hermes 侧签名：X-Bridge-Signature = hex(hmac(secret, `${timestamp}.${rawBody}`))。 */
function verifySignature({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret || !timestamp || !signature) return 'missing_signature';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_WINDOW_MS) return 'stale_timestamp';
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signature).replace(/^sha256=/, ''), 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? null : 'bad_signature';
}

export function createBridge({ secret, dbPath = ':memory:', now = () => Date.now(), log = () => {} } = {}) {
  const store = openStore(dbPath);
  /** deviceId -> Set<ws> */
  const sockets = new Map();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (url.pathname === '/health' && method === 'GET') {
      return json(res, 200, { ok: true, connected: [...sockets.values()].reduce((n, set) => n + set.size, 0), ...store.stats() });
    }

    if (url.pathname === '/register' && method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: 'invalid_body' });
      }
      if (!body.platform || !body.serverId) return json(res, 400, { error: 'platform_and_serverId_required' });
      const device = store.registerDevice({
        deviceId: body.deviceId,
        platform: body.platform,
        serverId: body.serverId,
        serverAlias: body.serverAlias,
        deviceName: body.deviceName,
        now: now(),
      });
      log('register', device.deviceId, body.platform);
      return json(res, 200, device);
    }

    const revoke = /^\/register\/([^/]+)$/.exec(url.pathname);
    if (revoke && method === 'DELETE') {
      const device = store.getDevice(revoke[1]);
      const auth = bearer(req);
      if (!device || !secretMatches(auth, device.secret_hash)) return json(res, 401, { error: 'unauthorized' });
      store.revokeDevice(device.device_id, now());
      for (const socket of sockets.get(device.device_id) ?? []) socket.close(4001, 'revoked');
      sockets.delete(device.device_id);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/events' && method === 'POST') {
      // 单进程模式下桥自己轮询，不需要外部 agent，也就不需要共享密钥
      if (!secret) return json(res, 503, { error: 'external_agent_disabled' });
      const raw = await readRaw(req).catch(() => null);
      if (raw === null) return json(res, 400, { error: 'invalid_body' });
      const failure = verifySignature({
        secret,
        timestamp: req.headers['x-bridge-timestamp'],
        signature: req.headers['x-bridge-signature'],
        rawBody: raw,
        now: now(),
      });
      if (failure) return json(res, 401, { error: failure });
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
      const events = Array.isArray(body.events) ? body.events : [];
      let accepted = 0;
      let delivered = 0;
      for (const event of events) {
        if (!event?.eventId || !event?.serverId || !event?.state) continue;
        const result = store.ingestEvent(event, now());
        if (!result.fresh) continue;
        accepted += 1;
        delivered += fanout(event);
      }
      return json(res, 200, { accepted, delivered });
    }

    if (url.pathname === '/events' && method === 'GET') {
      // 轮询兜底：WebSocket 被系统掐断时，App 可以主动拉未投递事件
      const device = store.getDevice(url.searchParams.get('deviceId') ?? '');
      if (!device || !secretMatches(url.searchParams.get('secret') ?? '', device.secret_hash)) {
        return json(res, 401, { error: 'unauthorized' });
      }
      const pending = store.pendingFor(device.device_id, 20);
      store.markDelivered(pending.map((event) => event.event_id), device.device_id, now());
      store.touchDevice(device.device_id, now());
      return json(res, 200, { events: pending.map(toWire) });
    }

    return json(res, 404, { error: 'not_found' });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') return socket.destroy();
    const device = store.getDevice(url.searchParams.get('deviceId') ?? '');
    // WS 无法可靠设置自定义头，改用 query 传密钥；桥必须跑在 TLS 后面
    if (!device || !secretMatches(url.searchParams.get('secret') ?? '', device.secret_hash)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.deviceId = device.device_id;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const set = sockets.get(ws.deviceId) ?? new Set();
    set.add(ws);
    sockets.set(ws.deviceId, set);
    store.touchDevice(ws.deviceId, now());
    const pending = store.pendingFor(ws.deviceId, 20);
    ws.send(JSON.stringify({ type: 'hello', pending: pending.map(toWire) }));
    store.markDelivered(pending.map((event) => event.event_id), ws.deviceId, now());
    log('ws-open', ws.deviceId, `pending=${pending.length}`);

    ws.on('message', (raw) => {
      // 目前只支持心跳 ping，客户端也可发 {type:'ping'}
      try {
        const message = JSON.parse(String(raw));
        if (message?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: now() }));
      } catch {
        /* 忽略无法解析的帧 */
      }
    });
    ws.on('close', () => {
      set.delete(ws);
      if (!set.size) sockets.delete(ws.deviceId);
      log('ws-close', ws.deviceId);
    });
  });

  /**
   * 把事件推给该实例下所有在线设备。
   * `serverId === '*'` 表示广播（单实例部署时无需两边对齐 id）。
   */
  function fanout(event) {
    let delivered = 0;
    for (const device of store.listDevices(event.serverId === '*' ? undefined : event.serverId)) {
      const set = sockets.get(device.device_id);
      if (!set?.size) continue;
      const payload = JSON.stringify({ type: 'event', event: toWire(event) });
      for (const ws of set) {
        if (ws.readyState !== ws.OPEN) continue;
        ws.send(payload);
        delivered += 1;
      }
      store.markDelivered([event.eventId], device.device_id, now());
    }
    return delivered;
  }

  /** 供内置轮询器调用：入库并投递，行为与 /events 一致。 */
  function ingestEvents(events) {
    let accepted = 0;
    let delivered = 0;
    for (const event of events) {
      if (!event?.eventId || !event?.serverId || !event?.state) continue;
      if (!store.ingestEvent(event, now()).fresh) continue;
      accepted += 1;
      delivered += fanout(event);
    }
    return { accepted, delivered };
  }

  return {
    server,
    store,
    ingestEvents,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ port: typeof address === 'object' && address ? address.port : port });
        });
      });
    },
    close() {
      for (const set of sockets.values()) for (const ws of set) ws.close(1001, 'shutdown');
      sockets.clear();
      wss.close();
      return new Promise((resolve) => server.close(() => { store.close(); resolve(); }));
    },
  };
}

const bearer = (req) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 对外事件形状：不含任务正文，只有定位信息。
 * 同时接受数据库行（snake_case）与请求体事件（camelCase）。
 */
function toWire(row) {
  return {
    eventId: row.event_id ?? row.eventId,
    serverId: row.server_id ?? row.serverId,
    sessionId: row.session_id ?? row.sessionId ?? undefined,
    sessionTitle: row.session_title ?? row.sessionTitle ?? undefined,
    state: row.state,
    preview: row.preview ?? undefined,
    ts: row.ts,
  };
}

if (process.argv[1]?.endsWith('server.mjs')) {
  const secret = process.env.BRIDGE_SECRET;
  const hermesKey = process.env.HERMES_API_KEY;
  const statePath = process.env.STATE_PATH ?? './poller-state.json';
  if (!secret && !hermesKey) {
    console.error('需要 HERMES_API_KEY（单进程模式）或 BRIDGE_SECRET（外部 agent 模式），至少一个');
    process.exit(1);
  }
  const log = (...args) => console.log('[bridge]', ...args);
  const bridge = createBridge({ secret, dbPath: process.env.DB_PATH ?? './bridge.db', log });
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  await bridge.listen(port, host);

  let poller = null;
  if (hermesKey) {
    poller = createPoller({
      hermesBaseUrl: process.env.HERMES_BASE_URL ?? 'http://127.0.0.1:8642',
      apiKey: hermesKey,
      serverId: process.env.SERVER_ID ?? '*',
      pollMs: Number(process.env.POLL_MS ?? 5000),
      includePreview: process.env.INCLUDE_PREVIEW === '1',
      statePath,
      log,
      onEvents: (events) => {
        const result = bridge.ingestEvents(events);
        log(`推送 ${events.length} 条：入库 ${result.accepted}，在线投递 ${result.delivered}`);
      },
    });
    poller.start();
    log(`单进程模式：轮询 ${process.env.HERMES_BASE_URL ?? 'http://127.0.0.1:8642'}`);
  } else {
    log('外部 agent 模式：等待 POST /events');
  }
  log(`listening on http://${host}:${port}`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      poller?.stop();
      await bridge.close();
      process.exit(0);
    });
  }
}
