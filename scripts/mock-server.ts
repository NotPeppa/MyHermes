/**
 * Local Hermes mock server for development and contract tests.
 * Binds 127.0.0.1 only. Profiles: /p/alpha, /p/beta (separate keys).
 * Fault profile: /p/fault returns 503 + Retry-After on run submission.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

type Status = 'queued' | 'running' | 'waiting_for_approval' | 'completed' | 'cancelled' | 'failed';
interface Run {
  id: string;
  profile: string;
  sessionId: string;
  input: string;
  status: Status;
  output: string;
  generation: number;
  model?: string;
  provider?: string;
  approvalRequested?: boolean;
  pending?: { request_id: string; execution_generation: number; type: string; prompt: string; choices: string[] };
  listeners: Set<(event: string, data: unknown, id?: string) => void>;
  timer?: NodeJS.Timeout;
}

const KEYS: Record<string, string> = { alpha: 'key-alpha', beta: 'key-beta', fault: 'key-fault' };
const sessions = new Map<string, { id: string; profile: string; title: string; updatedAt: number }>();
const messages = new Map<string, { role: string; content: string; created_at: number }[]>();
const runs = new Map<string, Run>();
const idempotency = new Map<string, string>();

interface Job {
  id: string;
  profile: string;
  prompt: string;
  schedule: string;
  skills: string[];
  provider: string;
  delivery_target: string;
  paused: boolean;
  last_status: string;
  last_run_at: number;
}
const jobs = new Map<string, Job>();
/** 预置几条真实感任务，让 GET /api/jobs 一上手就有内容。 */
for (const [profile, prompt, schedule, paused] of [
  ['alpha', '每天早上汇总服务器磁盘与容器状态，异常时发到 Telegram', '0 8 * * *', false],
  ['alpha', '每周一整理上周未完成的任务清单并生成摘要', '0 9 * * 1', true],
  ['beta', '每小时检查备份任务结果，失败就重试一次', '0 * * * *', false],
] as const) {
  const id = `job_${profile}_${jobs.size + 1}`;
  jobs.set(`${profile}:${id}`, {
    id, profile, prompt, schedule, skills: ['terminal', 'filesystem'], provider: 'nous', delivery_target: 'telegram',
    paused, last_status: paused ? 'paused' : 'completed', last_run_at: Date.now() - (jobs.size + 1) * 3_600_000,
  });
}
const jobView = (job: Job) => ({
  id: job.id, prompt: job.prompt, schedule: job.schedule, skills: job.skills, provider: job.provider,
  delivery_target: job.delivery_target, paused: job.paused, last_status: job.last_status, last_run_at: job.last_run_at,
});

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
};
const sseHead = (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
};
const frame = (event: string, data: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function auth(req: IncomingMessage, profile: string): boolean {
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${KEYS[profile]}`;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function emit(run: Run, event: string, data: unknown, id?: string) {
  for (const listener of run.listeners) listener(event, data, id);
}

function advance(run: Run) {
  const words = ['已', '收到', '任务', '：', run.input, '。', '正在', '检查', '服务器', '状态', '…'];
  let index = 0;
  run.status = 'running';
  emit(run, 'run.started', { run_id: run.id, status: 'running' });
  const tick = setInterval(() => {
    if (run.status === 'cancelled') return clearInterval(tick);
    if (index < 4) {
      const text = words[index] ?? '';
      run.output += text;
      emit(run, 'message.delta', { run_id: run.id, text }, `evt-${index}`);
      index += 1;
      return;
    }
    clearInterval(tick);
    emit(run, 'tool.started', { run_id: run.id, tool: 'terminal', call_id: 'call_1', preview: 'df -h' });
    setTimeout(() => {
      emit(run, 'tool.completed', { run_id: run.id, tool: 'terminal', call_id: 'call_1', preview: 'Filesystem 40% used' });
      if (run.input.includes('approve') && !run.approvalRequested) {
        run.approvalRequested = true;
        run.status = 'waiting_for_approval';
        run.pending = {
          request_id: randomUUID(),
          execution_generation: run.generation,
          type: 'approval',
          prompt: '允许执行 rm -rf /tmp/demo ?',
          choices: ['once', 'deny'],
        };
        emit(run, 'approval.request', { run_id: run.id, pending_controls: [run.pending] });
        return;
      }
      finish(run, 'completed', `${run.output} 检查完成，磁盘使用率 40%。`);
    }, 300);
  }, 120);
}

function finish(run: Run, status: Status, output?: string) {
  const wasTerminal = run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed';
  run.status = status;
  if (output !== undefined) run.output = output;
  run.pending = undefined;
  if (!wasTerminal && status === 'completed') {
    messages.get(`${run.profile}:${run.sessionId}`)?.push({ role: 'assistant', content: run.output, created_at: Date.now() });
  }
  const name = status === 'completed' ? 'run.completed' : status === 'cancelled' ? 'run.cancelled' : 'run.failed';
  emit(run, name, { run_id: run.id, status, output: run.output });
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const profileMatch = /^\/p\/([a-z]+)/.exec(url.pathname);
  const profile = profileMatch?.[1] ?? 'alpha';
  const path = profileMatch ? url.pathname.slice(profileMatch[0].length) || '/' : url.pathname;
  const method = req.method ?? 'GET';

  if (!KEYS[profile]) return json(res, 404, { error: 'unknown_profile' });
  if (path === '/v1/capabilities' && method === 'GET') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, {
      object: 'hermes.api_server.capabilities',
      platform: 'hermes-agent',
      model: 'hermes-agent',
      auth: { type: 'bearer', required: true },
      features: {
        chat_completions: true,
        run_submission: true,
        run_status: true,
        run_events_sse: true,
        run_stop: true,
        run_approval: true,
        run_clarify: true,
        run_unknown_resolution: true,
        sessions: true,
        sessions_list: true,
        session_messages: true,
        session_chat_stream: true,
        session_fork: true,
        model_options: true,
        tool_progress_events: true,
        skills_api: true,
        jobs_admin: true,
      },
    });
  }
  if (path === '/v1/models' && method === 'GET') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { object: 'list', data: [{ id: 'hermes-agent', object: 'model' }] });
  }
  if (path === '/api/model/options' && method === 'GET') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    // 与官方 build_model_options_payload 一致：provider 用 slug，models 是字符串数组
    return json(res, 200, {
      providers: [
        {
          slug: 'nous',
          label: 'Nous Research',
          authenticated: true,
          is_current: true,
          models: ['hermes-4-405b', 'hermes-4-70b'],
          total_models: 2,
          pricing: { 'hermes-4-405b': { input: '0.90', output: '2.70' }, 'hermes-4-70b': { input: '0.20', output: '0.60' } },
        },
        {
          slug: 'openai',
          label: 'OpenAI',
          authenticated: true,
          models: ['gpt-5.1', 'gpt-5-mini'],
          total_models: 2,
          pricing: { 'gpt-5.1': { input: '1.25', output: '10.00' } },
        },
      ],
      model: 'hermes-4-405b',
      provider: 'nous',
    });
  }

  if (path === '/v1/skills' && method === 'GET') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, [
      { name: 'disk-triage', description: '按顺序检查磁盘、inode 与容器日志，给出可执行结论', category: 'ops' },
      { name: 'release-notes', description: '从 git 历史整理发布说明，按影响面分组', category: 'writing' },
      { name: 'sql-review', description: '审查 SQL 的索引使用与锁范围，标注风险点', category: 'code' },
    ]);
  }
  if (path === '/v1/toolsets' && method === 'GET') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, [
      { name: 'terminal', label: '终端', description: '在服务器上执行 shell 命令', enabled: true, configured: true, tools: ['run_command', 'read_output', 'kill_process'] },
      { name: 'filesystem', label: '文件系统', description: '读写服务器文件', enabled: true, configured: true, tools: ['read_file', 'write_file', 'list_dir'] },
      { name: 'web', label: '网页', description: '抓取与搜索网页内容', enabled: false, configured: false, tools: ['fetch_url', 'search'] },
      { name: 'memory', label: '记忆', description: '长期记忆读写', enabled: true, configured: false, tools: [] },
    ]);
  }
  if (path === '/api/jobs' && method === 'GET') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    if (profile === 'fault') return json(res, 503, { error: 'draining' }, { 'retry-after': '2' });
    const list = [...jobs.values()].filter((job) => job.profile === profile).sort((a, b) => b.last_run_at - a.last_run_at);
    return json(res, 200, { jobs: list.map(jobView), total: list.length });
  }
  if (path === '/api/jobs' && method === 'POST') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    if (profile === 'fault') return json(res, 503, { error: 'draining' }, { 'retry-after': '2' });
    const payload = await body(req);
    const id = `job_${randomUUID().slice(0, 8)}`;
    const job: Job = {
      id, profile, prompt: String(payload.prompt ?? ''), schedule: String(payload.schedule ?? 'manual'),
      skills: Array.isArray(payload.skills) ? payload.skills.map(String) : [], provider: String(payload.provider ?? 'default'),
      delivery_target: String(payload.delivery_target ?? 'none'), paused: false, last_status: 'never', last_run_at: Date.now(),
    };
    jobs.set(`${profile}:${id}`, job);
    return json(res, 201, { job: jobView(job) });
  }
  const jobMatch = /^\/api\/jobs\/([^/]+)(\/pause|\/resume|\/run)?$/.exec(path);
  if (jobMatch) {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    if (profile === 'fault') return json(res, 503, { error: 'draining' }, { 'retry-after': '2' });
    const key = `${profile}:${jobMatch[1]}`;
    const job = jobs.get(key);
    if (!job) return json(res, 404, { error: 'not_found' });
    const sub = jobMatch[2];
    if (!sub && method === 'GET') return json(res, 200, { job: jobView(job) });
    if (!sub && method === 'PATCH') {
      const payload = await body(req);
      if (typeof payload.prompt === 'string') job.prompt = payload.prompt;
      if (typeof payload.schedule === 'string') job.schedule = payload.schedule;
      if (typeof payload.paused === 'boolean') job.paused = payload.paused;
      return json(res, 200, { job: jobView(job) });
    }
    if (!sub && method === 'DELETE') {
      jobs.delete(key);
      return json(res, 200, { deleted: true, job_id: job.id });
    }
    if (sub === '/pause' && method === 'POST') {
      job.paused = true; job.last_status = 'paused';
      return json(res, 200, { job_id: job.id, paused: true });
    }
    if (sub === '/resume' && method === 'POST') {
      job.paused = false; job.last_status = 'resumed';
      return json(res, 200, { job_id: job.id, paused: false });
    }
    if (sub === '/run' && method === 'POST') {
      job.last_status = 'started'; job.last_run_at = Date.now();
      return json(res, 202, { status: 'started', job_id: job.id });
    }
  }
  if (path === '/api/sessions' && method === 'GET') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    const list = [...sessions.values()].filter((s) => s.profile === profile).sort((a, b) => b.updatedAt - a.updatedAt);
    return json(res, 200, { sessions: list, total: list.length });
  }
  if (path === '/api/sessions' && method === 'POST') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    const payload = await body(req);
    const id = `sess_${randomUUID().slice(0, 8)}`;
    const session = { id, profile, title: String(payload.title ?? '新会话'), updatedAt: Date.now() };
    sessions.set(`${profile}:${id}`, session);
    messages.set(`${profile}:${id}`, []);
    return json(res, 201, { session });
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)(\/messages|\/chat\/stream|\/fork)?$/.exec(path);
  if (sessionMatch) {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    const key = `${profile}:${sessionMatch[1]}`;
    const session = sessions.get(key);
    if (!session) return json(res, 404, { error: 'not_found' });
    const sub = sessionMatch[2];
    if (sub === '/messages' && method === 'GET') return json(res, 200, { messages: messages.get(key) ?? [] });
    if (sub === '/fork' && method === 'POST') {
      const payload = await body(req);
      const id = `sess_${randomUUID().slice(0, 8)}`;
      const forked = { id, profile, title: String(payload.title ?? `分支：${session.title}`), updatedAt: Date.now() };
      sessions.set(`${profile}:${id}`, forked);
      messages.set(`${profile}:${id}`, [...(messages.get(key) ?? [])]);
      return json(res, 201, { session: { ...forked, forked_from: session.id } });
    }
    if (sub === '/chat/stream' && method === 'POST') {
      const payload = await body(req);
      const input = String(payload.input ?? payload.message ?? '');
      messages.get(key)?.push({ role: 'user', content: input, created_at: Date.now() });
      sseHead(res);
      const reply = `会话流回复：${input}`;
      for (const [i, piece] of [...reply].entries()) {
        res.write(frame('message.delta', { text: piece, session_id: session.id }, `chunk-${i}`));
        await new Promise((r) => setTimeout(r, 15));
      }
      messages.get(key)?.push({ role: 'assistant', content: reply, created_at: Date.now() });
      res.write(frame('run.completed', { status: 'completed', session_id: session.id, output: reply, ...(payload.model ? { model: payload.model } : {}), ...(payload.provider ? { provider: payload.provider } : {}) }));
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (!sub && method === 'GET') return json(res, 200, { session });
    if (!sub && method === 'PATCH') {
      const payload = await body(req);
      session.title = String(payload.title ?? session.title);
      session.updatedAt = Date.now();
      return json(res, 200, { session });
    }
    if (!sub && method === 'DELETE') {
      sessions.delete(key);
      messages.delete(key);
      return json(res, 200, { deleted: true });
    }
  }
  if (path === '/v1/runs' && method === 'POST') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    if (profile === 'fault') return json(res, 503, { error: 'draining' }, { 'retry-after': '2' });
    const payload = await body(req);
    const idem = String(req.headers['idempotency-key'] ?? '');
    if (!idem) return json(res, 400, { error: 'idempotency_key_required' });
    const fingerprint = `${profile}:${JSON.stringify(payload)}`;
    const existing = idempotency.get(`${profile}:${idem}`);
    if (existing) {
      const run = runs.get(existing);
      if (!run || run.profile !== profile) return json(res, 409, { error: 'idempotency_key_conflict' });
      if (idempotency.get(`${profile}:${idem}:fp`) !== fingerprint) return json(res, 409, { error: 'idempotency_key_conflict' });
      res.setHeader('idempotency-replayed', 'true');
      return json(res, 200, { run_id: run.id, status: run.status, ...(run.model ? { model: run.model } : {}), ...(run.provider ? { provider: run.provider } : {}) });
    }
    const sessionId = String(payload.session_id ?? '');
    const session = sessions.get(`${profile}:${sessionId}`);
    if (!session) return json(res, 409, { error: 'permission_denied' });
    const run: Run = {
      id: `run_${randomUUID().slice(0, 8)}`,
      profile,
      sessionId,
      input: String(payload.input ?? ''),
      status: 'queued',
      output: '',
      generation: 1,
      ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      ...(typeof payload.provider === 'string' ? { provider: payload.provider } : {}),
      listeners: new Set(),
    };
    runs.set(run.id, run);
    idempotency.set(`${profile}:${idem}`, run.id);
    idempotency.set(`${profile}:${idem}:fp`, fingerprint);
    messages.get(`${profile}:${sessionId}`)?.push({ role: 'user', content: run.input, created_at: Date.now() });
    setTimeout(() => advance(run), 200);
    return json(res, 202, { run_id: run.id, status: 'started', ...(run.model ? { model: run.model } : {}), ...(run.provider ? { provider: run.provider } : {}) });
  }
  const runMatch = /^\/v1\/runs\/([^/]+)(\/events|\/stop|\/approval|\/clarify|\/resolve-unknown)?$/.exec(path);
  if (runMatch) {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    const run = runs.get(runMatch[1] ?? '');
    if (!run || run.profile !== profile) return json(res, 404, { error: 'not_found' });
    const sub = runMatch[2];
    if (!sub && method === 'GET') {
      return json(res, 200, {
        run_id: run.id,
        status: run.status,
        session_id: run.sessionId,
        output: run.output,
        pending_controls: run.pending ? [run.pending] : [],
        admission_id: run.id,
        execution_generation: run.generation,
        ...(run.model ? { model: run.model } : {}),
        ...(run.provider ? { provider: run.provider } : {}),
      });
    }
    if (sub === '/events' && method === 'GET') {
      sseHead(res);
      // ?fragment=N 把每帧切成 N 字节小块，用于人工验证跨块 UTF-8 与分帧解析
      const fragment = Number(url.searchParams.get('fragment') ?? 0);
      const write = (text: string) => {
        if (!fragment || fragment < 1) return res.write(text);
        const bytes = Buffer.from(text, 'utf8');
        let offset = 0;
        const flush = () => {
          while (offset < bytes.length) {
            res.write(bytes.subarray(offset, offset + fragment));
            offset += fragment;
          }
        };
        flush();
      };
      const send = (event: string, data: unknown, id?: string) => write(frame(event, data, id));
      run.listeners.add(send);
      if (run.status === 'completed') send('run.completed', { run_id: run.id, status: 'completed', output: run.output });
      if (run.pending) send('approval.request', { run_id: run.id, pending_controls: [run.pending] });
      const keepalive = setInterval(() => write(': keepalive\n\n'), 10_000);
      req.on('close', () => {
        clearInterval(keepalive);
        run.listeners.delete(send);
      });
      return;
    }
    if (sub === '/stop' && method === 'POST') {
      finish(run, 'cancelled');
      return json(res, 202, { run_id: run.id, status: 'cancelled' });
    }
    if ((sub === '/approval' || sub === '/clarify') && method === 'POST') {
      const payload = await body(req);
      if (!run.pending) return json(res, 409, { error: 'no_pending_control' });
      if (payload.request_id !== run.pending.request_id || payload.execution_generation !== run.generation) {
        return json(res, 409, { error: 'control_stale' });
      }
      const choice = String(payload.choice ?? payload.answer ?? '');
      run.pending = undefined;
      run.generation += 1;
      if (choice === 'deny') {
        finish(run, 'failed', '用户拒绝执行，任务终止。');
      } else {
        advance(run);
      }
      return json(res, 200, { run_id: run.id, status: run.status });
    }
    if (sub === '/resolve-unknown' && method === 'POST') {
      return json(res, 200, { run_id: run.id, status: run.status });
    }
  }
  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!auth(req, profile)) return json(res, 401, { error: 'unauthorized' });
    const payload = await body(req);
    // content 可能是字符串，也可能是 text + image_url 数组（官方文档确认的图片负载）
    const last = (payload.messages as { content: unknown }[] | undefined)?.at(-1)?.content;
    const parts = Array.isArray(last) ? (last as { type?: string; text?: string; image_url?: { url?: string } }[]) : [];
    const textPart = Array.isArray(last) ? parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ') : String(last ?? '');
    const images = parts.filter((part) => part.type === 'image_url' && typeof part.image_url?.url === 'string');
    const badImage = images.find((part) => !/^data:image\/(jpeg|png|webp);base64,/.test(part.image_url?.url ?? ''));
    if (badImage) return json(res, 400, { error: 'unsupported_content_type' });
    const text = `兼容模式回复：${textPart}${images.length ? `（含 ${images.length} 张图片）` : ''}`;
    if (!payload.stream) {
      return json(res, 200, {
        id: `chatcmpl-${randomUUID().slice(0, 8)}`,
        object: 'chat.completion',
        model: 'hermes-agent',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      });
    }
    sseHead(res);
    for (const [i, piece] of [...text].entries()) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      if (i === 2) res.write(frame('hermes.tool.progress', { tool: 'terminal', status: 'started' }));
      await new Promise((r) => setTimeout(r, 20));
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  json(res, 404, { error: 'not_found', path });
});

export function startMockServer(port = 0): Promise<{ baseUrl: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({
        baseUrl: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1]?.endsWith('mock-server.ts')) {
  const port = Number(process.env.PORT ?? 8642);
  void startMockServer(port).then(({ baseUrl }) => {
    console.log(`Hermes mock on ${baseUrl}`);
    console.log('profiles: /p/alpha (key-alpha), /p/beta (key-beta), /p/fault (key-fault → 503)');
  });
}
