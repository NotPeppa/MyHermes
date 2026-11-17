import type { Repository, CredentialVault, ProbeResult } from '../domain/contracts';
import type { ServerConnection, Session, Message, Run, ToolEvent, OutboundTurn, NetworkState, AgentEvent, ModelOption, SendOptions, Skill, Toolset, Job } from '../domain/models';
import { terminalStates } from '../domain/models';
import { HermesError } from '../domain/errors';
import { Transport, ProtocolError, type FetchLike } from '../api/transport';
import { probe } from '../api/capability-probe';
import { SessionsAdapter, RunsAdapter, CompatAdapter, ModelsAdapter, SkillsAdapter, JobsAdapter } from '../adapters/hermes/client';
import { buildCompatContent } from '../media/image';

export interface RuntimeView {
  messages: Message[]; runs: Run[]; tools: ToolEvent[]; draft: string; commentary: string[];
  network: NetworkState; error?: HermesError; submission?: OutboundTurn;
}
export interface ServiceOptions { repository: Repository; vault: CredentialVault; fetch?: FetchLike; now?: () => number; randomId?: () => string }
const CAPABILITY_TTL_MS = 15 * 60 * 1000;
const freshView = (): RuntimeView => ({ messages: [], runs: [], tools: [], draft: '', commentary: [], network: 'connected' });
const keyOf = (serverId: string, sessionId: string) => JSON.stringify([serverId, sessionId]);
const errorOf = (error: unknown): HermesError => error instanceof HermesError ? error : new HermesError('protocol', '本地数据操作失败，请重新加载核对');

/** One instance per application. Repository is the durable ledger; views never contain credentials. */
export class HermesService {
  private views = new Map<string, RuntimeView>();
  private listeners = new Map<string, Set<() => void>>();
  private locks = new Set<string>();
  private probes = new Map<string, number>();
  private streams = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private sessionCache = new Map<string, Session[]>();
  private now: () => number;
  private async cacheEnabled(): Promise<boolean> { return await this.options.repository.getSetting('cache_enabled') !== '0'; }
  private async saveSessions(serverId: string, sessions: Session[]): Promise<void> {
    this.sessionCache.set(serverId, sessions);
    if (await this.cacheEnabled()) await this.options.repository.saveSessions(serverId, sessions);
  }
  private async saveMessages(serverId: string, sessionId: string, messages: Message[]): Promise<void> {
    if (await this.cacheEnabled()) await this.options.repository.replaceMessages(serverId, sessionId, messages);
  }
  private async cachedSessions(serverId: string): Promise<Session[]> { return this.sessionCache.get(serverId) ?? (await this.cacheEnabled() ? await this.options.repository.listSessions(serverId) : []); }
  private async cachedMessages(serverId: string, sessionId: string): Promise<Message[]> { return this.views.get(keyOf(serverId, sessionId))?.messages ?? (await this.cacheEnabled() ? await this.options.repository.listMessages(serverId, sessionId) : []); }
  private id: () => string;
  constructor(private options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.randomId ?? (() => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('-')}`);
  }
  probe(baseUrl: string, key: string, options: { allowHttp?: boolean; signal?: AbortSignal } = {}): Promise<ProbeResult> { return probe(baseUrl, key, { ...options, fetch: this.options.fetch }); }
  view(serverId: string, sessionId: string): RuntimeView {
    const key = keyOf(serverId, sessionId);
    if (!this.views.has(key)) this.views.set(key, freshView());
    return this.views.get(key)!;
  }
  subscribe(serverId: string, sessionId: string, listener: () => void): () => void {
    const key = keyOf(serverId, sessionId);
    const set = this.listeners.get(key) ?? new Set(); set.add(listener); this.listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) { this.listeners.delete(key); this.detach(serverId, sessionId); } };
  }
  private patch(serverId: string, sessionId: string, patch: Partial<RuntimeView>): void {
    const key = keyOf(serverId, sessionId);
    this.views.set(key, { ...this.view(serverId, sessionId), ...patch });
    for (const listener of this.listeners.get(key) ?? []) { try { listener(); } catch { /* a view subscriber must not interrupt durable writes */ } }
  }
  private async connection(serverId: string): Promise<ServerConnection> {
    const server = (await this.options.repository.listServers()).find(s => s.id === serverId);
    if (!server) throw new ProtocolError('not_found', '服务器连接不存在');
    return server;
  }
  private async clients(serverId: string) {
    const server = await this.connection(serverId);
    const key = await this.options.vault.get(server.credentialRef);
    if (!key) throw new ProtocolError('auth', '请重新保存此服务器的密钥');
    this.refreshIfStale(server, key);
    const transport = new Transport(server.baseUrl, key, this.options.fetch, server.allowHttp);
    return { server, sessions: new SessionsAdapter(transport, serverId), runs: new RunsAdapter(transport), compat: new CompatAdapter(transport), models: new ModelsAdapter(transport), skills: new SkillsAdapter(transport), jobs: new JobsAdapter(transport) };
  }
  /**
   * 能力缓存 15 分钟。过期时后台重探一次并落库，不阻塞当前请求；失败保留旧能力，
   * 且同一实例 15 分钟内不重复探测，避免离线时每次调用都打服务器。
   */
  private refreshIfStale(server: ServerConnection, key: string): void {
    if (this.now() - server.capabilities.checkedAt < CAPABILITY_TTL_MS) return;
    const last = this.probes.get(server.id) ?? 0;
    if (this.now() - last < CAPABILITY_TTL_MS) return;
    this.probes.set(server.id, this.now());
    void this.probe(server.baseUrl, key, { allowHttp: server.allowHttp })
      .then(result => this.options.repository.saveServer({ ...server, capabilities: result.capabilities }))
      .catch(() => undefined);
  }
  private async ownedSession(serverId: string, sessionId: string): Promise<Session> {
    const session = (await this.cachedSessions(serverId)).find(s => s.id === sessionId && s.serverId === serverId);
    if (!session) throw new ProtocolError('not_found', '当前服务器没有此会话，请刷新会话列表');
    return session;
  }
  async listSessions(serverId: string, limit = 100, offset = 0): Promise<Session[]> {
    const { server, sessions } = await this.clients(serverId);
    if (server.capabilities.mode === 'openai_compat') return this.cachedSessions(serverId);
    const result = await sessions.list(limit, offset);
    const cached = await this.cachedSessions(serverId);
    await this.saveSessions(serverId, [...cached.filter(s => !result.some(v => v.id === s.id)), ...result]);
    return result;
  }
  async createSession(serverId: string, title?: string): Promise<Session> {
    const { server, sessions } = await this.clients(serverId);
    const session: Session = server.capabilities.mode === 'openai_compat' ? { serverId, id: `local-${this.id()}`, title: title ?? '新会话', updatedAt: this.now(), localOnly: true } : await sessions.create(title);
    await this.saveSessions(serverId, [...await this.cachedSessions(serverId), session]);
    return session;
  }
  async listModels(serverId: string): Promise<ModelOption[]> {
    const { server, models } = await this.clients(serverId);
    return server.capabilities.features.model_options ? models.options() : [];
  }
  /** P2 只读发现：没有 skills_api 旗标就返回 []，且不向服务器发请求。 */
  async listSkills(serverId: string): Promise<Skill[]> {
    const { server, skills } = await this.clients(serverId);
    return server.capabilities.features.skills_api ? skills.skills() : [];
  }
  async listToolsets(serverId: string): Promise<Toolset[]> {
    const { server, skills } = await this.clients(serverId);
    return server.capabilities.features.skills_api ? skills.toolsets() : [];
  }
  /** P2 任务管理：没有 jobs_admin 旗标就返回 []，且不向服务器发请求。 */
  async listJobs(serverId: string): Promise<Job[]> {
    const { server, jobs } = await this.clients(serverId);
    return server.capabilities.features.jobs_admin ? jobs.list() : [];
  }
  private async jobCommand(serverId: string, jobId: string, action: 'pause' | 'resume' | 'run' | 'remove'): Promise<void> {
    const { server, jobs } = await this.clients(serverId);
    if (!server.capabilities.features.jobs_admin) throw new ProtocolError('protocol', '服务器未开放 Jobs 管理能力');
    await jobs[action](jobId);
  }
  pauseJob(serverId: string, jobId: string): Promise<void> { return this.jobCommand(serverId, jobId, 'pause'); }
  resumeJob(serverId: string, jobId: string): Promise<void> { return this.jobCommand(serverId, jobId, 'resume'); }
  runJob(serverId: string, jobId: string): Promise<void> { return this.jobCommand(serverId, jobId, 'run'); }
  deleteJob(serverId: string, jobId: string): Promise<void> { return this.jobCommand(serverId, jobId, 'remove'); }
  async forkSession(serverId: string, sessionId: string, title?: string): Promise<Session> {
    const { server, sessions } = await this.clients(serverId);
    if (!server.capabilities.features.session_fork) throw new ProtocolError('protocol', '服务器未声明会话分支能力');
    const session = await sessions.fork(sessionId, title);
    await this.saveSessions(serverId, [...await this.cachedSessions(serverId), session]);
    return session;
  }
  /** Local cache only: never hits the network, so it stays usable offline. */
  async searchSessions(serverId: string, query: string): Promise<Session[]> {
    const sessions = await this.cachedSessions(serverId);
    const needle = query.trim().toLowerCase();
    return needle ? sessions.filter(s => s.title.toLowerCase().includes(needle)) : [...sessions];
  }
  async renameSession(serverId: string, sessionId: string, title: string): Promise<void> {
    const session = await this.ownedSession(serverId, sessionId);
    if (!session.localOnly) await (await this.clients(serverId)).sessions.rename(sessionId, title);
    await this.saveSessions(serverId, (await this.cachedSessions(serverId)).map(s => s.id === sessionId ? { ...s, title } : s));
  }
  async deleteSession(serverId: string, sessionId: string): Promise<void> {
    const session = await this.ownedSession(serverId, sessionId);
    const runs = await this.options.repository.listRuns(serverId, sessionId);
    if (runs.some(r => !terminalStates.has(r.status))) throw new ProtocolError('conflict', '请先核对或停止此会话的活动任务');
    if (!session.localOnly) await (await this.clients(serverId)).sessions.delete(sessionId);
    this.detach(serverId, sessionId);
    await this.options.repository.deleteSession(serverId, sessionId);
    this.sessionCache.set(serverId, (await this.cachedSessions(serverId)).filter(s => s.id !== sessionId));
    this.patch(serverId, sessionId, freshView());
  }
  async loadMessages(serverId: string, sessionId: string): Promise<Message[]> {
    const session = await this.ownedSession(serverId, sessionId);
    const cached = await this.cachedMessages(serverId, sessionId);
    this.patch(serverId, sessionId, { messages: cached });
    if (session.localOnly) return cached;
    const messages = await (await this.clients(serverId)).sessions.messages(sessionId);
    await this.saveMessages(serverId, sessionId, messages);
    this.patch(serverId, sessionId, { messages }); return messages;
  }
  async send(serverId: string, sessionId: string, input: string, options: SendOptions = {}): Promise<OutboundTurn> {
    // 纯图片消息允许空正文；文字与图片都为空才是空消息
    if (!input.trim() && !options.images?.length) throw new ProtocolError('protocol', '消息内容为空');
    const scope = keyOf(serverId, sessionId);
    if (this.locks.has(scope)) throw new ProtocolError('conflict', '此会话正在提交');
    this.locks.add(scope);
    try {
      const session = await this.ownedSession(serverId, sessionId);
      const clients = await this.clients(serverId);
      if (clients.server.capabilities.mode === 'unsupported') throw new ProtocolError('protocol', '服务器尚未验证聊天能力');
      const previous = await this.options.repository.listTurns(serverId, sessionId);
      if (previous.some(t => !terminalStates.has(t.submissionState))) throw new ProtocolError('conflict', '此会话有未确认或执行中的任务，请先恢复核对');
      const mode = clients.server.capabilities.mode;
      const history = mode === 'openai_compat' ? await this.cachedMessages(serverId, sessionId) : [];
      // Request-level model override applies to every mode; absent fields stay absent so the body (and its idempotency fingerprint) is unchanged.
      const override = { ...(options.model ? { model: options.model } : {}), ...(options.provider ? { provider: options.provider } : {}) };
      const images = options.images ?? [];
      // 官方文档只确认 Chat Completions 的 image_url 与 Responses 的 input_image；Runs 与 Sessions 未声明图片字段，不臆造。
      if (images.length > 0 && mode !== 'openai_compat') throw new ProtocolError('protocol', '当前模式未声明图片输入，请改用兼容模式或直接发送文字');
      const body = mode === 'native_runs'
        ? { input, ...(!session.localOnly ? { session_id: sessionId } : {}), ...override }
        // 官方示例的会话单轮字段是 input（不是 message）
        : mode === 'native_sessions'
          ? { input, ...override }
          : {
              model: clients.server.capabilities.model ?? 'hermes',
              stream: true,
              messages: [
                ...history.filter(m => m.role !== 'tool').map(m => ({ role: m.role, content: m.body })),
                { role: 'user', content: buildCompatContent(input, images) },
              ],
              ...override,
            };
      const turn: OutboundTurn = { clientTurnId: this.id(), serverId, sessionId, idempotencyKey: this.id(), requestBodyJson: JSON.stringify(body), submissionState: 'submitting', createdAt: this.now() };
      // This single durable write MUST finish before any POST; never recreate a turn during recovery.
      await this.options.repository.saveTurn(turn);
      const cached = await this.cachedMessages(serverId, sessionId);
      const optimistic: Message = { id: turn.clientTurnId, serverId, sessionId, role: 'user', body: images.length > 0 ? `${input}${input ? ' ' : ''}[${images.length} 张图片]` : input, createdAt: this.now() };
      this.patch(serverId, sessionId, { submission: turn, messages: [...cached, optimistic], draft: '', commentary: [], error: undefined });
      if (mode === 'native_runs') await this.submit(turn, clients.runs);
      else {
        const run: Run = { ...turn, runId: `local-${turn.clientTurnId}`, status: 'running', updatedAt: this.now() };
        await this.storeRun(run);
        if (mode === 'openai_compat') {
          const messages = [...history, { id: turn.clientTurnId, serverId, sessionId, role: 'user' as const, body: input, createdAt: this.now() }];
          await this.saveMessages(serverId, sessionId, messages); this.patch(serverId, sessionId, { messages });
        }
        this.startStream(run, signal => mode === 'native_sessions' ? clients.sessions.stream(sessionId, turn.requestBodyJson, e => this.enqueue(run, e), signal) : clients.compat.stream(turn.requestBodyJson, run.runId, e => this.enqueue(run, e), signal), false);
      }
      return (await this.options.repository.listTurns(serverId, sessionId)).find(t => t.clientTurnId === turn.clientTurnId)!;
    } catch (error) { const classified = errorOf(error); this.patch(serverId, sessionId, { error: classified }); throw classified; }
    finally { this.locks.delete(scope); }
  }
  private async submit(turn: OutboundTurn, adapter: RunsAdapter): Promise<void> {
    let run: Run;
    try { run = await adapter.submit(turn); }
    catch (error) {
      const classified = errorOf(error);
      // Even malformed successful responses may follow a real submission. No new key and no implicit retry.
      const rejected = ['unauthorized', 'forbidden', 'not_found'].includes(classified.code) || classified.status === 400 || classified.status === 422;
      const updated = { ...turn, submissionState: rejected ? 'failed' as const : 'submission_uncertain' as const };
      await this.options.repository.saveTurn(updated);
      this.patch(turn.serverId, turn.sessionId, { submission: updated, error: classified }); throw classified;
    }
    // Persist run identity first. If saving fails, the original pre-POST ledger still supports same-key recovery.
    await this.storeRun(run);
    this.startStream(run, signal => adapter.events(run.runId, e => this.enqueue(run, e), signal), true);
  }
  async retrySubmission(serverId: string, clientTurnId: string): Promise<void> {
    const { server, runs } = await this.clients(serverId);
    const turn = (await this.options.repository.listTurns(serverId)).find(t => t.clientTurnId === clientTurnId);
    if (!turn) throw new ProtocolError('not_found', '提交记录不存在');
    const scope = keyOf(serverId, turn.sessionId);
    if (this.locks.has(scope)) throw new ProtocolError('conflict', '提交核对正在进行');
    this.locks.add(scope);
    try {
      if (turn.runId) { await this.recover(serverId, turn.sessionId); return; }
      if (server.capabilities.mode !== 'native_runs' || !['submitting', 'submission_uncertain'].includes(turn.submissionState)) throw new ProtocolError('conflict', '此提交不支持幂等恢复');
      if (this.now() - turn.createdAt >= 24 * 60 * 60 * 1000) throw new ProtocolError('conflict', '幂等记录可能已过期，请人工核对服务器；不再自动重发');
      await this.submit(turn, runs);
    } finally { this.locks.delete(scope); }
  }
  private async storeRun(run: Run): Promise<void> {
    await this.options.repository.saveRun(run);
    const turn: OutboundTurn = { clientTurnId: run.clientTurnId, serverId: run.serverId, sessionId: run.sessionId, idempotencyKey: run.idempotencyKey, requestBodyJson: run.requestBodyJson, runId: run.runId, submissionState: run.status, createdAt: (await this.options.repository.listTurns(run.serverId, run.sessionId)).find(t => t.clientTurnId === run.clientTurnId)?.createdAt ?? this.now() };
    await this.options.repository.saveTurn(turn);
    this.patch(run.serverId, run.sessionId, { runs: await this.options.repository.listRuns(run.serverId, run.sessionId), submission: turn });
  }
  private queues = new Map<string, Promise<void>>();
  private enqueue(run: Run, event: AgentEvent): void {
    const key = keyOf(run.serverId, run.runId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    this.queues.set(key, previous.then(() => this.applyEvent(run, event)).catch(error => { this.patch(run.serverId, run.sessionId, { error: errorOf(error) }); }));
  }
  private seen = new Map<string, Set<string>>();
  private async applyEvent(run: Run, event: AgentEvent): Promise<void> {
    const scope = keyOf(run.serverId, run.runId);
    const ids = this.seen.get(scope) ?? new Set<string>(); this.seen.set(scope, ids);
    if (event.id) { if (ids.has(event.id)) return; ids.add(event.id); }
    const view = this.view(run.serverId, run.sessionId);
    if (event.kind === 'text_delta') this.patch(run.serverId, run.sessionId, { draft: view.draft + (event.text ?? '') });
    if (event.kind === 'commentary' && !event.alreadyStreamed && event.text) this.patch(run.serverId, run.sessionId, { commentary: [...view.commentary, event.text] });
    if (event.kind === 'tool_started' || event.kind === 'tool_finished') {
      const tool: ToolEvent = { id: `${scope}:${event.toolCallId ?? event.id ?? this.id()}`, serverId: run.serverId, runId: run.runId, toolName: event.tool ?? 'tool', eventType: event.kind === 'tool_started' ? 'started' : event.failed ? 'failed' : 'completed', recordedAt: event.timestamp };
      if (await this.cacheEnabled()) await this.options.repository.saveToolEvent(tool);
      const tools = view.tools.filter(t => t.id !== tool.id); tools.push(tool); this.patch(run.serverId, run.sessionId, { tools });
    }
    if (event.kind === 'terminal' || event.kind === 'control') {
      const clients = await this.clients(run.serverId);
      if (clients.server.capabilities.mode === 'native_runs') await this.reconcile(run, clients.runs);
      else if (event.kind === 'terminal') {
        const stored = (await this.options.repository.listRuns(run.serverId, run.sessionId)).find(r => r.runId === run.runId);
        if (stored && terminalStates.has(stored.status)) return;
        const updated = { ...run, status: event.state ?? 'unknown', finalOutput: event.output ?? this.view(run.serverId, run.sessionId).draft, updatedAt: this.now() };
        await this.storeRun(updated);
        if (clients.server.capabilities.mode === 'native_sessions') { await this.loadMessages(run.serverId, run.sessionId); this.patch(run.serverId, run.sessionId, { draft: '' }); }
        else {
          const messages = [...await this.options.repository.listMessages(run.serverId, run.sessionId), { id: `${run.runId}:assistant`, serverId: run.serverId, sessionId: run.sessionId, role: 'assistant' as const, body: updated.finalOutput ?? '', createdAt: this.now() }];
          await this.saveMessages(run.serverId, run.sessionId, messages); this.patch(run.serverId, run.sessionId, { messages, draft: '' });
        }
      }
    }
  }
  private startStream(run: Run, consume: (signal: AbortSignal) => Promise<void>, native: boolean): void {
    const scope = keyOf(run.serverId, run.sessionId);
    this.streams.get(scope)?.controller.abort();
    // New stream starts from an authoritative snapshot, not a guessed token offset.
    this.patch(run.serverId, run.sessionId, { network: 'connected', draft: '' });
    const controller = new AbortController();
    const task = (async () => {
      try {
        await consume(controller.signal);
        await this.queues.get(keyOf(run.serverId, run.runId));
        if (!controller.signal.aborted) {
          if (native) await this.reconcile(run, (await this.clients(run.serverId)).runs);
          else {
            const current = (await this.options.repository.listRuns(run.serverId, run.sessionId)).find(r => r.runId === run.runId);
            if (current && !terminalStates.has(current.status)) await this.storeRun({ ...current, status: 'unknown', updatedAt: this.now() });
          }
        }
      } catch (error) {
        await this.queues.get(keyOf(run.serverId, run.runId));
        if (!controller.signal.aborted) {
          this.patch(run.serverId, run.sessionId, { network: 'offline', error: errorOf(error) });
          if (!native) await this.storeRun({ ...run, status: 'unknown', updatedAt: this.now() }).catch(() => {});
        }
      } finally { if (this.streams.get(scope)?.controller === controller) this.streams.delete(scope); }
    })();
    this.streams.set(scope, { controller, task });
  }
  private async reconcile(run: Run, adapter: RunsAdapter): Promise<Run> {
    const current = await adapter.status(run);
    await this.storeRun(current);
    if (terminalStates.has(current.status)) {
      this.patch(run.serverId, run.sessionId, { draft: current.finalOutput ?? '' });
      // A history sync failure never erases an authoritative run status or output.
      try {
        const messages = await this.loadMessages(run.serverId, run.sessionId);
        if (!current.finalOutput || messages.some(m => m.role === 'assistant' && m.body === current.finalOutput)) this.patch(run.serverId, run.sessionId, { draft: '' });
      }
      catch (error) { this.patch(run.serverId, run.sessionId, { error: errorOf(error) }); }
    }
    return current;
  }
  async recover(serverId: string, sessionId?: string): Promise<void> {
    const clients = await this.clients(serverId);
    const turns = await this.options.repository.listTurns(serverId, sessionId);
    for (const turn of turns.filter(t => !t.runId && ['submitting', 'submission_uncertain'].includes(t.submissionState))) {
      const uncertain = { ...turn, submissionState: 'submission_uncertain' as const };
      await this.options.repository.saveTurn(uncertain); this.patch(serverId, turn.sessionId, { submission: uncertain });
    }
    for (const run of await this.options.repository.listRuns(serverId, sessionId)) {
      this.patch(serverId, run.sessionId, { runs: await this.options.repository.listRuns(serverId, run.sessionId), tools: await this.options.repository.listToolEvents(serverId, run.runId) });
      if (run.runId.startsWith('local-')) { if (!terminalStates.has(run.status)) await this.storeRun({ ...run, status: 'unknown', updatedAt: this.now() }); continue; }
      const scope = keyOf(serverId, run.sessionId);
      this.streams.get(scope)?.controller.abort();
      try {
        const current = await this.reconcile(run, clients.runs);
        this.patch(serverId, run.sessionId, { network: 'connected', error: undefined });
        if (!terminalStates.has(current.status) && current.status !== 'unknown') this.startStream(current, signal => clients.runs.events(current.runId, e => this.enqueue(current, e), signal), true);
      } catch (error) { this.patch(serverId, run.sessionId, { network: 'offline', error: errorOf(error) }); throw errorOf(error); }
    }
  }
  private async getRun(serverId: string, runId: string): Promise<Run> {
    const run = (await this.options.repository.listRuns(serverId)).find(r => r.runId === runId);
    if (!run) throw new ProtocolError('not_found', '任务记录不存在'); return run;
  }
  async stop(serverId: string, runId: string): Promise<void> {
    const clients = await this.clients(serverId);
    const run = await this.getRun(serverId, runId);
    if (runId.startsWith('local-') || !clients.server.capabilities.features.run_stop) throw new ProtocolError('protocol', '当前模式未提供可确认的远程停止');
    const current = await this.reconcile(run, clients.runs);
    if (terminalStates.has(current.status)) return;
    await clients.runs.control(runId, 'stop');
    await this.storeRun({ ...current, status: 'stopping', updatedAt: this.now() });
    await this.reconcile(current, clients.runs);
  }
  async respondControl(serverId: string, runId: string, requestId: string, value: string): Promise<void> {
    const clients = await this.clients(serverId);
    const current = await this.reconcile(await this.getRun(serverId, runId), clients.runs);
    const control = current.pendingControls?.find(c => c.request_id === requestId);
    if (!control) throw new ProtocolError('conflict', '待处理请求已过期，请刷新');
    const clarify = /clarif/.test(control.type);
    const flags = clients.server.capabilities.features;
    if (!(clarify ? flags.run_clarify || flags.run_clarification : flags.run_approval)) throw new ProtocolError('protocol', '服务器未声明此控制能力');
    if (!clarify && (!control.choices?.includes(value) && !['once', 'deny'].includes(value))) throw new ProtocolError('protocol', '审批选项无效');
    try { await clients.runs.control(runId, clarify ? 'clarify' : 'approval', { request_id: control.request_id, execution_generation: control.execution_generation, [clarify ? 'answer' : 'choice']: value }); }
    finally { await this.reconcile(current, clients.runs); }
  }
  async resolveUnknown(serverId: string, runId: string, confirmed: boolean): Promise<void> {
    const clients = await this.clients(serverId);
    const current = await this.reconcile(await this.getRun(serverId, runId), clients.runs);
    if (!confirmed || !clients.server.capabilities.features.run_unknown_resolution || current.status !== 'unknown' || !current.admissionId || current.executionGeneration === undefined) throw new ProtocolError('conflict', '此任务尚未满足人工确认 unknown 的条件');
    try { await clients.runs.control(runId, 'resolve-unknown', { admission_id: current.admissionId, execution_generation: current.executionGeneration }); }
    finally { await this.reconcile(current, clients.runs); }
  }
  /**
   * 用户选择「以服务端为准」后清掉视图里的本地缓冲与错误提示。
   * 只影响本地展示：不改变服务器状态，也不删账本记录；下次 recover 若仍不确定会再次提示。
   */
  acknowledge(serverId: string, sessionId: string): void {
    this.patch(serverId, sessionId, { error: undefined, draft: '', commentary: [], submission: undefined });
  }
  /** Detach only cancels local network observation, never stops the server run. */
  detach(serverId: string, sessionId: string): void { this.streams.get(keyOf(serverId, sessionId))?.controller.abort(); }
  async dispose(): Promise<void> { const streams = [...this.streams.values()]; streams.forEach(s => s.controller.abort()); await Promise.all(streams.map(s => s.task)); this.listeners.clear(); }
}
export { probe } from '../api/capability-probe';
export { HermesError } from '../domain/errors';
export type { FetchLike } from '../api/transport';
