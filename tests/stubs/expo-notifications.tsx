/**
 * 无头渲染用的 expo-notifications 替身：只记录调用，不触碰原生模块。
 * 通过 tests/tsconfig.render.json 的 paths 映射，仅影响测试，不影响应用构建。
 */
export const scheduled: { content: unknown; trigger: unknown }[] = [];

export const handlers: unknown[] = [];

export const responseListeners = new Set<(response: unknown) => void>();

export async function requestPermissionsAsync() {
  return { granted: true, status: 'granted' };
}

export async function scheduleNotificationAsync(request: { content: unknown; trigger: unknown }) {
  scheduled.push(request);
  return `stub-${scheduled.length}`;
}

export function addNotificationResponseReceivedListener(listener: (response: unknown) => void) {
  responseListeners.add(listener);
  return {
    remove() {
      responseListeners.delete(listener);
    },
  };
}

export function setNotificationHandler(handler: unknown) {
  handlers.push(handler);
}
