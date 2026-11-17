import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CredentialVault, Repository } from '@/domain/contracts';
import { flushPendingCredentialDeletes } from '@/storage/credentials';
import { createRepository } from '@/storage/sqlite';
import { createVault } from '@/storage/vault';
import { HermesService } from '@/runtime/service';
import { describeError } from '@/features/common/errors';

export interface AppServices {
  repository: Repository;
  vault: CredentialVault;
  service: HermesService;
}

let singleton: AppServices | null = null;

/** 单例装配：UI 只拿到接口，不直接接触 SecureStore / SSE / URL 拼接。 */
export function appServices(): AppServices {
  if (!singleton) {
    const repository = createRepository();
    const vault = createVault();
    singleton = { repository, vault, service: new HermesService({ repository, vault }) };
  }
  return singleton;
}

/** 仅测试用：注入替身服务，避免拉起真实 SQLite / SecureStore。 */
export function configureAppServices(services: AppServices | null): void {
  singleton = services;
  initPromise = null;
}

const ServicesContext = createContext<AppServices | null>(null);

export function AppServicesProvider({ children }: { children: ReactNode }) {
  const value = appServices();
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useAppServices(): AppServices {
  const value = useContext(ServicesContext);
  if (!value) throw new Error('AppServicesProvider 未挂载');
  return value;
}

let initPromise: Promise<void> | null = null;

function startInit(services: AppServices): Promise<void> {
  initPromise ??= (async () => {
    await services.repository.init();
    // 待删密钥的清理失败不能阻塞启动，下次进入设置页会继续重试
    await flushPendingCredentialDeletes(services.repository, services.vault).catch(() => undefined);
  })().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

export interface AppInitState {
  ready: boolean;
  error: string | null;
  retry: () => void;
}

export function useAppInit(): AppInitState {
  const services = useAppServices();
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({ ready: false, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ ready: false, error: null });
    startInit(services).then(
      () => {
        if (alive) setState({ ready: true, error: null });
      },
      (error: unknown) => {
        if (alive) setState({ ready: false, error: describeError(error) });
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt, services]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, retry };
}
