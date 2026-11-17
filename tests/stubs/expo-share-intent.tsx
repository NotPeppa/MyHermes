/** 无头渲染用的 expo-share-intent 替身：不触发任何原生分享逻辑。 */
import { createElement, type ReactNode } from 'react';

export interface ShareIntent {
  text?: string;
  webUrl?: string | null;
  files?: { path: string; mimeType?: string; fileName?: string; size?: number }[];
  meta?: Record<string, string>;
}

export interface ShareIntentState {
  hasShareIntent: boolean;
  shareIntent: ShareIntent;
  resetShareIntent: () => void;
  error: string | null;
}

const empty: ShareIntentState = {
  hasShareIntent: false,
  shareIntent: {},
  resetShareIntent: () => undefined,
  error: null,
};

export function useShareIntent(): ShareIntentState {
  return empty;
}

export function useShareIntentContext(): ShareIntentState {
  return empty;
}

export function ShareIntentProvider({ children }: { children?: ReactNode }) {
  return createElement('ShareIntentProvider', null, children);
}
