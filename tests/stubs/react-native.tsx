/**
 * 无头渲染用的 react-native 替身：只实现本仓库实际用到的符号。
 * 通过 tests/tsconfig.render.json 的 paths 映射，仅影响测试，不影响应用构建。
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';

type Props = Record<string, any>;

const host = (name: string) => {
  const Component = ({ children, ...props }: Props & { children?: ReactNode }) =>
    createElement(name, props, children);
  Component.displayName = name;
  return Component;
};

export const View = host('View');
export const Text = host('Text');
export const ScrollView = host('ScrollView');
export const TextInput = host('TextInput');
export const Pressable = host('Pressable');
export const KeyboardAvoidingView = host('KeyboardAvoidingView');
export const ActivityIndicator = host('ActivityIndicator');
export const RefreshControl = host('RefreshControl');
export const Modal = host('Modal');
export const Switch = host('Switch');
export const Image = host('Image');

export function FlatList({ data, renderItem, ListEmptyComponent, ListHeaderComponent, ListFooterComponent, ...props }: Props) {
  const items = Array.isArray(data) ? data : [];
  const empty = typeof ListEmptyComponent === 'function'
    ? createElement(ListEmptyComponent)
    : ListEmptyComponent ?? null;
  return createElement(
    'FlatList',
    props,
    items.length === 0
      ? empty
      : items.map((item: unknown, index: number) =>
          createElement('Item', { key: `item-${index}` }, renderItem?.({ item, index }))),
    ListHeaderComponent ?? null,
    ListFooterComponent ?? null,
  );
}

export const StyleSheet = {
  hairlineWidth: 1,
  create: <T,>(styles: T): T => styles,
  flatten: (style: unknown) => style,
  absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
};

export const Platform = { OS: 'ios', select: (options: Props) => options.ios ?? options.default };

const listeners = new Set<(state: string) => void>();
export const AppState = {
  currentState: 'active',
  addEventListener: (_type: string, listener: (state: string) => void) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
};

export const Clipboard = {
  setString: (_value: string) => undefined,
  getString: async () => '',
};

export function useColorScheme() {
  return 'light';
}

const AlertContext = createContext<null>(null);
export const __AlertContext = AlertContext;
export const useAlertContext = () => useContext(AlertContext);

export const Alert = { alert: (_title: string, _message?: string, _buttons?: unknown) => undefined };

export const Linking = {
  openURL: async (_url: string) => undefined,
  canOpenURL: async (_url: string) => true,
};

export const Dimensions = { get: () => ({ width: 390, height: 844 }) };

export const LayoutAnimation = { configureNext: () => undefined, Presets: { easeInEaseOut: {} } };

export default {
  View, Text, ScrollView, TextInput, Pressable, KeyboardAvoidingView, ActivityIndicator,
  RefreshControl, Modal, Switch, Image, FlatList, StyleSheet, Platform, AppState, Clipboard,
  useColorScheme, Alert, Linking, Dimensions, LayoutAnimation,
};
