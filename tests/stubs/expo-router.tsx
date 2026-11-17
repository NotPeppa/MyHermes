/** 无头渲染用的 expo-router 替身。 */
import { createElement, type ReactNode } from 'react';

export const router = {
  push: (_href: unknown) => undefined,
  replace: (_href: unknown) => undefined,
  back: () => undefined,
  navigate: (_href: unknown) => undefined,
  setParams: (_params: unknown) => undefined,
};

export function useRouter() {
  return router;
}

export function useLocalSearchParams<T = Record<string, string>>(): T {
  return { serverId: 'srv-1', sessionId: 'sess-1' } as unknown as T;
}

export function useFocusEffect(_effect: () => void | (() => void)) {
  // 测试中不触发聚焦副作用，避免渲染期发起网络请求
}

export function useCanGoBack() {
  return true;
}

export function useSegments() {
  return [] as string[];
}

export function Redirect(_props: { href: unknown }) {
  return null;
}

export function Link({ children }: { children?: ReactNode }) {
  return createElement('Link', null, children);
}

function StackShell({ children }: { children?: ReactNode }) {
  return createElement('Stack', null, children);
}
export const Stack = Object.assign(StackShell, { Screen: StackShell, Protected: StackShell });

export const Tabs = Object.assign(StackShell, { Screen: StackShell });

export type Href = string;
