import { useCallback, useEffect, useState } from 'react';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';
import { fetchHealth } from './client';
import { readPushConfig, writePushConfig } from './config';
import { requestPushPermission } from './notify';
import { currentPushBridge, sharedPushBridge, unregisterPushDevice, type PushStatus } from './service';

export interface PushBridgeHook {
  enabled: boolean;
  status: PushStatus;
  bridgeUrl: string;
  error: string | null;
  setBridgeUrl: (url: string) => void;
  setEnabled: (next: boolean) => void;
  /** 调 GET /health，返回可直接展示的一行结果；可传当前草稿地址 */
  testConnection: (url?: string) => Promise<string>;
}

export function usePushBridge(): PushBridgeHook {
  const { repository, vault } = useAppServices();
  const [enabled, setEnabledState] = useState(false);
  const [bridgeUrl, setBridgeUrlState] = useState('');
  const [status, setStatus] = useState<PushStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void readPushConfig(repository)
      .then((config) => {
        if (!alive) return;
        setEnabledState(config.enabled);
        setBridgeUrlState(config.bridgeUrl);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [repository]);

  // 开关/地址变化才启停连接；连接本身是全局的，页面卸载不打断它
  useEffect(() => {
    if (!loaded) return;
    const url = bridgeUrl.trim();
    if (!enabled || !url) return;
    const bridge = sharedPushBridge({ repository, vault, baseUrl: url });
    void bridge.start().catch(() => undefined);
  }, [bridgeUrl, enabled, loaded, repository, vault]);

  // 订阅共享连接：组合根可能已经先连上了，这里只跟随状态
  useEffect(() => {
    const bridge = currentPushBridge();
    if (!bridge) return;
    setStatus(bridge.state.status);
    setError(bridge.state.error);
    return bridge.subscribe((next) => {
      setStatus(next.status);
      setError(next.error);
    });
  }, [bridgeUrl, enabled, loaded]);

  const setBridgeUrl = useCallback(
    (url: string) => {
      setBridgeUrlState(url);
      setError(null);
      void writePushConfig(repository, { bridgeUrl: url }).catch((writeError: unknown) => {
        setError(describeError(writeError));
      });
    },
    [repository],
  );

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      setError(null);
      void (async () => {
        try {
          await writePushConfig(repository, { enabled: next });
          if (next) {
            await requestPushPermission();
            return;
          }
          currentPushBridge()?.stop();
          setStatus('idle');
          await unregisterPushDevice({ repository, vault });
        } catch (toggleError) {
          setError(describeError(toggleError));
        }
      })();
    },
    [repository, vault],
  );

  const testConnection = useCallback(
    async (override?: string): Promise<string> => {
      const url = (override ?? bridgeUrl).trim();
      if (!url) return '请先填写推送桥地址';
      try {
        const health = await fetchHealth(url, (input, init) => globalThis.fetch(input, init));
        return `桥正常 · 在线设备 ${health.connected}`;
      } catch (testError) {
        const message = describeError(testError);
        setError(message);
        return `连接失败：${message}`;
      }
    },
    [bridgeUrl],
  );

  return { enabled, status, bridgeUrl, error, setBridgeUrl, setEnabled, testConnection };
}
