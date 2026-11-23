import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { Repository } from '@/domain/contracts';
import { readActiveServerId } from '@/features/settings/prefs';
import { eventToNotification, type BridgeEvent } from './client';

/**
 * 前台由 SSE 实时展示，通知只在 App 不在前台时出现。
 * 所有 expo-notifications 调用都吞掉异常：Expo Go / 无原生模块时静默降级。
 */
export async function deliverPushNotification(event: BridgeEvent): Promise<void> {
  if (AppState.currentState === 'active') return;
  try {
    await Notifications.scheduleNotificationAsync({ content: eventToNotification(event), trigger: null });
  } catch {
    /* 缺原生模块或系统拒绝：不打扰用户 */
  }
}

export async function requestPushPermission(): Promise<boolean> {
  try {
    const result = await Notifications.requestPermissionsAsync();
    return result.granted === true;
  } catch {
    return false;
  }
}

function installHandler(): void {
  try {
    // 前台不弹横幅：presentation 交给 SSE，系统通知只在后台出现
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  } catch {
    /* 缺原生模块 */
  }
}

async function resolveServerId(repository: Repository | undefined, rawServerId: string): Promise<string | null> {
  if (!repository) return rawServerId === '*' ? null : rawServerId;
  const servers = await repository.listServers().catch(() => []);
  if (rawServerId !== '*' && servers.some((s) => s.id === rawServerId)) return rawServerId;
  const active = await readActiveServerId(repository).catch(() => null);
  if (active && servers.some((s) => s.id === active)) return active;
  return servers[0]?.id ?? null;
}

/** 点通知 → 直接进对应会话。挂在组合根上，全 App 只注册一次（支持冷启动与通配 serverId）。 */
export function useNotificationTaps(repository?: Repository, ready = true): void {
  const router = useRouter();
  const handledIdRef = useRef<string | null>(null);

  useEffect(() => {
    installHandler();
    if (!ready) return;
    let alive = true;
    const handleResponse = async (response: Notifications.NotificationResponse | null | undefined) => {
      if (!alive || !response) return;
      const identifier = response.notification?.request?.identifier ?? null;
      if (identifier && handledIdRef.current === identifier) return;
      const data = response.notification?.request?.content?.data as
        { serverId?: unknown; sessionId?: unknown } | undefined;
      const rawServerId = typeof data?.serverId === 'string' ? data.serverId : null;
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : null;
      if (!rawServerId || !sessionId) return;
      const serverId = await resolveServerId(repository, rawServerId);
      if (!alive || !serverId) return;
      if (identifier) handledIdRef.current = identifier;
      router.push({ pathname: '/(main)/chat/[serverId]/[sessionId]', params: { serverId, sessionId } });
    };

    let subscription: { remove(): void } | null = null;
    try {
      subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        void handleResponse(response);
      });
      // 冷启动时从系统拉取触发启动的那条通知点击
      const getLast = (Notifications as { getLastNotificationResponseAsync?: () => Promise<Notifications.NotificationResponse | null> })
        .getLastNotificationResponseAsync;
      if (typeof getLast === 'function') {
        void getLast().then(handleResponse).catch(() => undefined);
      }
    } catch {
      /* 缺原生模块：点通知回落为普通启动 */
    }
    return () => {
      alive = false;
      try {
        subscription?.remove();
      } catch {
        /* 已移除 */
      }
    };
  }, [ready, repository, router]);
}
