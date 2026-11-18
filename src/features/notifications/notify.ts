import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
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

/** 点通知 → 直接进对应会话。挂在组合根上，全 App 只注册一次。 */
export function useNotificationTaps(): void {
  const router = useRouter();
  useEffect(() => {
    installHandler();
    let subscription: { remove(): void } | null = null;
    try {
      subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response?.notification?.request?.content?.data as
          { serverId?: unknown; sessionId?: unknown } | undefined;
        const serverId = typeof data?.serverId === 'string' ? data.serverId : null;
        const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : null;
        if (!serverId || !sessionId) return;
        router.push({ pathname: '/(main)/chat/[serverId]/[sessionId]', params: { serverId, sessionId } });
      });
    } catch {
      /* 缺原生模块：点通知回落为普通启动 */
    }
    return () => {
      try {
        subscription?.remove();
      } catch {
        /* 已移除 */
      }
    };
  }, [router]);
}
