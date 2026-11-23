import { Platform } from 'react-native';
import type { FetchLike } from '@/api/transport';
import type { CredentialVault, Repository } from '@/domain/contracts';
import { describeError } from '@/features/common/errors';
import {
  bridgeSocketUrl,
  parseBridgeMessage,
  reconnectDelay,
  registerDevice,
  unregisterDevice,
  type BridgeEvent,
  type BridgePlatform,
} from './client';
import { DEFAULT_PUSH_SERVER_ID, pushSecretRef, readPushConfig, writePushConfig } from './config';

export type PushStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface PushBridgeState {
  status: PushStatus;
  error: string | null;
}

/** 只依赖 WebSocket 的最小面：RN 的全局 WebSocket 与测试替身都满足。 */
export interface SocketLike {
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
}

export type SocketCtor = new (url: string) => SocketLike;

export interface PushBridgeDeps {
  repository: Repository;
  vault: CredentialVault;
  baseUrl: string;
  fetchImpl?: FetchLike;
  socket?: SocketCtor;
  random?: () => number;
  platform?: BridgePlatform;
  /** WS 一直不开就重连，避免状态永远停在「连接中」。 */
  connectTimeoutMs?: number;
}

const CONNECT_TIMEOUT_MS = 15_000;

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function platformOf(): BridgePlatform {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

/**
 * 一条到自托管桥的长连接。连接失败只更新状态，不抛给 UI，也不阻塞 App 启动。
 * 事件与状态都用订阅分发：组合根和设置页可以同时观察同一个实例。
 */
export class PushBridge {
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private running = false;
  private sessionGen = 0;
  private reusedCredential = false;
  private current: PushBridgeState = { status: 'idle', error: null };
  private stateListeners = new Set<(state: PushBridgeState) => void>();
  private eventListeners = new Set<(event: BridgeEvent) => void>();

  constructor(private deps: PushBridgeDeps) {}

  get baseUrl(): string {
    return this.deps.baseUrl;
  }

  get state(): PushBridgeState {
    return this.current;
  }

  subscribe(listener: (state: PushBridgeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = ++this.sessionGen;
    this.attempt = 0;
    await this.open(gen);
  }

  stop(): void {
    this.running = false;
    this.sessionGen += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.drop();
    this.attempt = 0;
    this.setState('idle', null);
  }
  private setState(status: PushStatus, error: string | null): void {
    this.current = { status, error };
    for (const listener of [...this.stateListeners]) {
      try {
        listener(this.current);
      } catch {
        /* 订阅方异常不能打断连接 */
      }
    }
  }

  private emit(event: BridgeEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
        /* 投递失败不影响后续事件 */
      }
    }
  }

  /** 先注册拿设备密钥（本地没有时），再连 WS。 */
  private async open(gen: number): Promise<void> {
    try {
      const credential = await this.credential();
      if (!this.running || this.sessionGen !== gen) return;
      this.connect(credential, gen);
    } catch (error) {
      if (!this.running || this.sessionGen !== gen) return;
      this.setState('error', describeError(error));
      this.scheduleReconnect(gen);
    }
  }

  private async credential(): Promise<{ deviceId: string; secret: string }> {
    const config = await readPushConfig(this.deps.repository);
    if (config.deviceId) {
      const secret = await this.deps.vault.get(pushSecretRef(config.deviceId));
      if (secret) {
        this.reusedCredential = true;
        return { deviceId: config.deviceId, secret };
      }
    }
    this.reusedCredential = false;
    const registered = await registerDevice(
      {
        baseUrl: this.deps.baseUrl,
        platform: this.deps.platform ?? platformOf(),
        serverId: config.serverId || DEFAULT_PUSH_SERVER_ID,
        ...(config.serverAlias ? { serverAlias: config.serverAlias } : {}),
      },
      this.deps.fetchImpl ?? defaultFetch,
    );
    await this.deps.vault.set(pushSecretRef(registered.deviceId), registered.secret);
    await writePushConfig(this.deps.repository, { deviceId: registered.deviceId });
    return registered;
  }

  private async invalidateCredential(): Promise<void> {
    const config = await readPushConfig(this.deps.repository).catch(() => null);
    if (!config?.deviceId) return;
    await this.deps.vault.remove(pushSecretRef(config.deviceId)).catch(() => undefined);
    await writePushConfig(this.deps.repository, { deviceId: null }).catch(() => undefined);
  }

  private connect(credential: { deviceId: string; secret: string }, gen: number): void {
    this.drop();
    const Ctor = this.deps.socket ?? (globalThis.WebSocket as unknown as SocketCtor | undefined);
    if (!Ctor) {
      this.setState('error', '当前运行环境没有 WebSocket');
      this.scheduleReconnect(gen);
      return;
    }
    this.setState('connecting', null);
    let socket: SocketLike;
    try {
      socket = new Ctor(bridgeSocketUrl(this.deps.baseUrl, credential.deviceId, credential.secret));
    } catch (error) {
      this.setState('error', describeError(error));
      this.scheduleReconnect(gen);
      return;
    }
    this.socket = socket;
    let opened = false;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (!this.running || this.sessionGen !== gen || this.socket !== socket || this.current.status === 'connected') return;
      this.drop();
      this.setState('error', '推送桥连接超时');
      this.scheduleReconnect(gen);
    }, this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      if (this.socket !== socket || this.sessionGen !== gen) return;
      opened = true;
      this.reusedCredential = false;
      this.clearConnectTimer();
      this.attempt = 0;
      this.setState('connected', null);
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket || this.sessionGen !== gen) return;
      this.receive(message.data);
    };
    // onerror 之后浏览器/RN 一定会给 onclose，重连只在 onclose 里做，避免双重重连
    socket.onerror = () => undefined;
    socket.onclose = () => {
      this.clearConnectTimer();
      if (this.socket !== socket || this.sessionGen !== gen) return;
      this.socket = null;
      this.setState('error', '推送连接已断开');
      // 若复用了旧设备凭据但握手从未成功（例如换桥地址、桥重装或被撤销返回 401），清空旧凭据后重注册
      if (!opened && this.reusedCredential) {
        this.reusedCredential = false;
        void this.invalidateCredential().finally(() => {
          if (this.running && this.sessionGen === gen) this.scheduleReconnect(gen);
        });
        return;
      }
      this.scheduleReconnect(gen);
    };
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private receive(raw: unknown): void {
    const message = parseBridgeMessage(raw);
    if (message.kind === 'event') this.emit(message.event);
    else if (message.kind === 'hello') for (const event of message.pending) this.emit(event);
  }

  private scheduleReconnect(gen: number): void {
    if (!this.running || this.sessionGen !== gen || this.timer) return;
    const delay = reconnectDelay(this.attempt, this.deps.random);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || this.sessionGen !== gen) return;
      void this.open(gen);
    }, delay);
  }

  private drop(): void {
    this.clearConnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* 已关闭 */
    }
  }
}

let shared: PushBridge | null = null;
const sharedEventListeners = new Set<(event: BridgeEvent) => void>();

/** 注册全局推送事件监听：无论共享桥何时创建或切换地址重建，都会自动转发事件。 */
export function onSharedPushEvent(listener: (event: BridgeEvent) => void): () => void {
  sharedEventListeners.add(listener);
  return () => {
    sharedEventListeners.delete(listener);
  };
}

/** 整个 App 只保留一条推送连接：组合根与设置页共用同一个实例。 */
export function sharedPushBridge(deps: PushBridgeDeps): PushBridge {
  if (shared && shared.baseUrl !== deps.baseUrl) {
    shared.stop();
    shared = null;
  }
  if (!shared) {
    const instance = new PushBridge(deps);
    instance.onEvent((event) => {
      for (const listener of [...sharedEventListeners]) {
        try {
          listener(event);
        } catch {
          /* 投递失败不影响后续监听 */
        }
      }
    });
    shared = instance;
  }
  return shared;
}

export function currentPushBridge(): PushBridge | null {
  return shared;
}

export function stopSharedPushBridge(): void {
  shared?.stop();
}

/** 关闭开关时撤销设备：桥会立刻断掉这条连接，密钥也从 SecureStore 删掉。 */
export async function unregisterPushDevice(deps: {
  repository: Repository;
  vault: CredentialVault;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const config = await readPushConfig(deps.repository);
  if (!config.deviceId) return;
  const ref = pushSecretRef(config.deviceId);
  const secret = await deps.vault.get(ref).catch(() => null);
  if (secret && config.bridgeUrl) {
    await unregisterDevice(
      { baseUrl: config.bridgeUrl, deviceId: config.deviceId, secret },
      deps.fetchImpl ?? defaultFetch,
    ).catch(() => undefined);
  }
  await deps.vault.remove(ref).catch(() => undefined);
  await writePushConfig(deps.repository, { deviceId: null });
}
