import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateBaseUrl } from '@/api/urls';
import { HermesError } from '@/domain/errors';
import type { Capabilities, ServerConnection } from '@/domain/models';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';
import { enabledFeatures, modeLabel } from '@/features/common/status';
import { hostOf } from '@/features/settings/diagnostics';

export type StageId = 'url' | 'capabilities' | 'auth' | 'api';
export type StageStatus = 'pending' | 'running' | 'ok' | 'fail';

export interface DiagnosticStage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail?: string;
}

const STAGE_LABELS: Record<StageId, string> = {
  url: '① URL 与 TLS',
  capabilities: '② 能力探测',
  auth: '③ Bearer 鉴权',
  api: '④ 可用 API',
};

const STAGE_ORDER: StageId[] = ['url', 'capabilities', 'auth', 'api'];

const PROBE_TIMEOUT_MS = 15_000;

export function newServerId(): string {
  return `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function credentialRefFor(serverId: string): string {
  return `hermes.cred.${serverId}`;
}

/** Profile 路径作为 base URL 的路径前缀（/p/team），与反代前缀保持同一套规范化。 */
export function composeBaseUrl(rawUrl: string, profilePath: string, allowHttp: boolean): string {
  const base = validateBaseUrl(rawUrl, { allowHttp });
  const path = profilePath.trim().replace(/^\/+|\/+$/g, '');
  if (!path) return base;
  return validateBaseUrl(`${base}/${path}`, { allowHttp });
}

function initialStages(): DiagnosticStage[] {
  return STAGE_ORDER.map((id) => ({ id, label: STAGE_LABELS[id], status: 'pending' }));
}

function stageForError(error: unknown): StageId {
  if (!(error instanceof HermesError)) return 'capabilities';
  switch (error.code) {
    case 'tls':
    case 'network':
    case 'timeout':
      return 'url';
    case 'unauthorized':
    case 'forbidden':
      return 'auth';
    default:
      return 'capabilities';
  }
}

export interface AddServerState {
  name: string;
  setName: (value: string) => void;
  url: string;
  setUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  profilePath: string;
  setProfilePath: (value: string) => void;
  allowHttp: boolean;
  setAllowHttp: (value: boolean) => void;
  showKey: boolean;
  toggleKey: () => void;
  stages: DiagnosticStage[];
  probing: boolean;
  saving: boolean;
  error: string | null;
  capabilities: Capabilities | null;
  latencyMs: number | null;
  canSubmit: boolean;
  stale: boolean;
  probe: () => Promise<Capabilities | null>;
  cancel: () => void;
  save: () => Promise<ServerConnection | null>;
}

/** 连接页逻辑：分层诊断、可取消、失败绝不写成功状态。 */
export function useAddServer(existing?: ServerConnection | null): AddServerState {
  const { repository, vault, service } = useAppServices();
  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [profilePath, setProfilePath] = useState('');
  const [allowHttp, setAllowHttp] = useState(existing?.allowHttp ?? false);
  const [showKey, setShowKey] = useState(false);
  const [stages, setStages] = useState<DiagnosticStage[]>(initialStages);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(existing?.capabilities ?? null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [probedSignature, setProbedSignature] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const existingCredentialRef = existing?.credentialRef;
  useEffect(() => {
    if (!existingCredentialRef) return;
    let alive = true;
    void vault
      .get(existingCredentialRef)
      .then((stored) => {
        if (alive && stored) setApiKey(stored);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [existingCredentialRef, vault]);

  // 任何连接参数变化都会让上一次诊断结论失效，保存前必须重新诊断
  const signature = `${url}\u0000${profilePath}\u0000${allowHttp}\u0000${apiKey}`;
  const stale = capabilities !== null && probedSignature !== signature;

  const updateStage = useCallback((id: StageId, next: Partial<DiagnosticStage>) => {
    setStages((current) => current.map((stage) => (stage.id === id ? { ...stage, ...next } : stage)));
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setProbing(false);
  }, []);

  const probe = useCallback(async (): Promise<Capabilities | null> => {
    setError(null);
    setCapabilities(null);
    setLatencyMs(null);
    setStages(initialStages());

    let baseUrl: string;
    try {
      baseUrl = composeBaseUrl(url, profilePath, allowHttp);
      updateStage('url', {
        status: 'ok',
        detail: `主机 ${hostOf(baseUrl)} · ${baseUrl.startsWith('https:') ? 'HTTPS' : '明文 HTTP（开发）'}`,
      });
    } catch (validationError) {
      updateStage('url', { status: 'fail', detail: describeError(validationError) });
      setError(describeError(validationError));
      return null;
    }

    if (apiKey.trim().length === 0) {
      updateStage('auth', { status: 'fail', detail: 'API Key 为空' });
      setError('请输入 API Key');
      return null;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setProbing(true);
    updateStage('capabilities', { status: 'running' });
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const result = await service.probe(baseUrl, apiKey.trim(), { allowHttp, signal: controller.signal });
      if (!mountedRef.current) return null;
      const features = enabledFeatures(result.capabilities.features);
      updateStage('capabilities', { status: 'ok', detail: `模式 ${modeLabel(result.capabilities.mode)}` });
      updateStage('auth', { status: 'ok', detail: 'Bearer 鉴权通过' });
      updateStage('api', {
        status: features.length > 0 ? 'ok' : 'fail',
        detail: features.length > 0 ? features.join('、') : '未探测到可用 API，功能将受限',
      });
      setCapabilities(result.capabilities);
      setLatencyMs(result.latencyMs);
      setProbedSignature(`${url}\u0000${profilePath}\u0000${allowHttp}\u0000${apiKey}`);
      return result.capabilities;
    } catch (probeError) {
      if (!mountedRef.current) return null;
      const aborted = controller.signal.aborted;
      const message = aborted ? `请求超时（${PROBE_TIMEOUT_MS / 1000}s）或已取消` : describeError(probeError);
      const stage = aborted ? 'capabilities' : stageForError(probeError);
      updateStage(stage, { status: 'fail', detail: message });
      setError(message);
      return null;
    } finally {
      clearTimeout(timer);
      if (mountedRef.current) setProbing(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [allowHttp, apiKey, profilePath, service, updateStage, url]);

  const save = useCallback(async (): Promise<ServerConnection | null> => {
    setError(null);
    const confirmed = capabilities && !stale ? capabilities : await probe();
    if (!confirmed) return null;
    let baseUrl: string;
    try {
      baseUrl = composeBaseUrl(url, profilePath, allowHttp);
    } catch (validationError) {
      setError(describeError(validationError));
      return null;
    }
    const id = existing?.id ?? newServerId();
    const credentialRef = existing?.credentialRef ?? credentialRefFor(id);
    const server: ServerConnection = {
      id,
      name: name.trim().length > 0 ? name.trim() : hostOf(baseUrl),
      baseUrl,
      credentialRef,
      capabilities: confirmed,
      createdAt: existing?.createdAt ?? Date.now(),
      allowHttp,
    };
    setSaving(true);
    try {
      await vault.set(credentialRef, apiKey.trim());
      try {
        await repository.saveServer(server);
      } catch (writeError) {
        // 元数据写失败就撤销刚写入的密钥，避免留下无主凭据
        if (!existing) await vault.remove(credentialRef).catch(() => undefined);
        throw writeError;
      }
      // 地址/Profile 变化等于换了连接身份，旧缓存不能并入新实例
      if (existing && existing.baseUrl !== baseUrl) await repository.clearCache(id);
      return server;
    } catch (saveError) {
      setError(describeError(saveError));
      return null;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [allowHttp, apiKey, capabilities, existing, name, probe, profilePath, repository, stale, url, vault]);

  const canSubmit = useMemo(
    () => url.trim().length > 0 && apiKey.trim().length > 0 && !probing && !saving,
    [apiKey, probing, saving, url],
  );

  return {
    name,
    setName,
    url,
    setUrl,
    apiKey,
    setApiKey,
    profilePath,
    setProfilePath,
    allowHttp,
    setAllowHttp,
    showKey,
    toggleKey: () => setShowKey((value) => !value),
    stages,
    probing,
    saving,
    error,
    capabilities,
    latencyMs,
    canSubmit,
    stale,
    probe,
    cancel,
    save,
  };
}
