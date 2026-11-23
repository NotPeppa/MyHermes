import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { HermesError } from '@/domain/errors';
import type { SendOptions } from '@/domain/models';
import type { HermesService } from '@/runtime/service';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';

export type ChatView = ReturnType<HermesService['view']>;

export type ChatBusy = 'send' | 'stop' | 'retry' | 'recover' | 'control' | 'resolve';

export interface ChatState {
  view: ChatView;
  loading: boolean;
  busy: ChatBusy | null;
  error: string | null;
  refresh: () => Promise<void>;
  send: (text: string, options?: SendOptions) => Promise<boolean>;
  stop: (runId: string) => Promise<void>;
  retry: (clientTurnId: string) => Promise<void>;
  recover: () => Promise<void>;
  respond: (runId: string, requestId: string, value: string) => Promise<void>;
  resolveUnknown: (runId: string, confirmed: boolean) => Promise<void>;
  dismissError: () => void;
}

/** 聊天页逻辑：订阅视图、卸载即退订，所有网络动作都经服务层。 */
export function useChat(serverId: string, sessionId: string): ChatState {
  const { service } = useAppServices();
  const [view, setView] = useState<ChatView>(() => service.view(serverId, sessionId));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ChatBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const sync = useCallback(() => {
    setView(service.view(serverId, sessionId));
  }, [serverId, service, sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    sync();
    const unsubscribe = service.subscribe(serverId, sessionId, sync);
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [serverId, service, sessionId, sync]);

  useEffect(() => {
    let alive = true;
    void service
      .loadMessages(serverId, sessionId)
      .then(async () => {
        if (!alive) return;
        sync();
        // 进入会话先按持久化 run_id 核对服务端状态，再恢复订阅；不重复提交
        await service.recover(serverId, sessionId);
      })
      .catch((loadError: unknown) => {
        if (alive) setError(describeError(loadError));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [serverId, service, sessionId, sync]);

  // 回到前台：先查服务端状态再恢复订阅，不重新提交任务（设计 14.1）
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void service
        .recover(serverId, sessionId)
        .then(() => {
          if (mountedRef.current) sync();
        })
        .catch((recoverError: unknown) => {
          if (mountedRef.current) setError(describeError(recoverError));
        });
    });
    return () => subscription.remove();
  }, [serverId, service, sessionId, sync]);

  const run = useCallback(
    async (kind: ChatBusy, action: () => Promise<unknown>): Promise<void> => {
      setBusy(kind);
      setError(null);
      try {
        await action();
      } catch (actionError) {
        if (actionError instanceof HermesError && actionError.code === 'conflict') {
          // 409：状态已变化，先拉最新状态与 pending_controls，不自动重试高危操作
          setError(describeError(actionError));
          if (mountedRef.current) {
            try {
              await service.recover(serverId, sessionId);
            } catch {
              /* 恢复失败保留原始 409 提示 */
            }
          }
        } else {
          setError(describeError(actionError));
        }
      } finally {
        if (mountedRef.current) {
          setBusy(null);
          sync();
        }
      }
    },
    [serverId, service, sessionId, sync],
  );

  const refresh = useCallback(async () => {
    await run('recover', () => service.loadMessages(serverId, sessionId));
  }, [run, serverId, service, sessionId]);

  const send = useCallback(
    async (text: string, options?: SendOptions): Promise<boolean> => {
      const trimmed = text.trim();
      const images = options?.images ?? [];
      // 有图片时允许空正文（纯图片消息）；无图片时仍要求非空文字
      if (trimmed.length === 0 && images.length === 0) return false;
      let ok = true;
      await run('send', async () => {
        try {
          await service.send(serverId, sessionId, trimmed, options);
        } catch (sendError) {
          ok = false;
          throw sendError;
        }
      });
      return ok;
    },
    [run, serverId, service, sessionId],
  );

  const stop = useCallback(
    (runId: string) => run('stop', () => service.stop(serverId, runId)),
    [run, serverId, service],
  );

  const retry = useCallback(
    (clientTurnId: string) => run('retry', () => service.retrySubmission(serverId, clientTurnId)),
    [run, serverId, service],
  );

  const recover = useCallback(
    () => run('recover', () => service.recover(serverId, sessionId)),
    [run, serverId, service, sessionId],
  );

  const respond = useCallback(
    (runId: string, requestId: string, value: string) =>
      run('control', () => service.respondControl(serverId, runId, requestId, value)),
    [run, serverId, service],
  );

  const resolveUnknown = useCallback(
    (runId: string, confirmed: boolean) => run('resolve', () => service.resolveUnknown(serverId, runId, confirmed)),
    [run, serverId, service],
  );

  return {
    view,
    loading,
    busy,
    error,
    refresh,
    send,
    stop,
    retry,
    recover,
    respond,
    resolveUnknown,
    dismissError: () => setError(null),
  };
}
