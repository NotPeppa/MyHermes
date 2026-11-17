/** 无头渲染用的 expo 模块替身。 */
import { createElement, type ReactNode } from 'react';

// @expo/vector-icons
export const Ionicons = Object.assign(
  ({ name }: { name: string; size?: number; color?: string }) => createElement('Ionicons', { name }),
  { glyphMap: {} as Record<string, number> },
);

// expo-constants
const Constants = { expoConfig: { version: '0.1.0' }, appOwnership: 'standalone' };
export default Constants;

// expo-status-bar
export function StatusBar(_props: { style?: string }) {
  return null;
}

// expo-secure-store
export const SecureStore = {
  getItemAsync: async (_key: string) => null,
  setItemAsync: async (_key: string, _value: string) => undefined,
  deleteItemAsync: async (_key: string) => undefined,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
};

// react-native-safe-area-context
export function SafeAreaProvider({ children }: { children?: ReactNode }) {
  return createElement('SafeAreaProvider', null, children);
}
export function useSafeAreaInsets() {
  return { top: 47, bottom: 34, left: 0, right: 0 };
}
export function SafeAreaView({ children }: { children?: ReactNode }) {
  return createElement('SafeAreaView', null, children);
}
