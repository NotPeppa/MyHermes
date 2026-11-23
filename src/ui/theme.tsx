import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';

export type ThemeScheme = 'light' | 'dark';
/** 用户偏好：跟随系统 / 强制浅色 / 强制深色 */
export type ThemePreference = 'system' | ThemeScheme;

/** 语义色 token：组件里不出现裸 hex。 */
export interface ThemeColors {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  accent: string;
  accentSoft: string;
  danger: string;
  onDanger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  success: string;
  successSoft: string;
  userBubble: string;
  codeBg: string;
  codeText: string;
  scrim: string;
}

const light: ThemeColors = {
  bg: '#F4F6F9',
  surface: '#FFFFFF',
  surfaceAlt: '#EDF1F6',
  border: '#E2E8F0',
  text: '#0F172A',
  textMuted: '#64748B',
  primary: '#0F172A',
  onPrimary: '#FFFFFF',
  accent: '#15803D',
  accentSoft: '#DCFCE7',
  danger: '#DC2626',
  onDanger: '#FFFFFF',
  dangerSoft: '#FEE2E2',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  success: '#15803D',
  successSoft: '#DCFCE7',
  userBubble: '#E2E8F0',
  codeBg: '#F1F5F9',
  codeText: '#0F172A',
  scrim: 'rgba(15,23,42,0.52)',
};

const dark: ThemeColors = {
  bg: '#0B1120',
  surface: '#151E31',
  surfaceAlt: '#1E293B',
  border: '#283548',
  text: '#F8FAFC',
  textMuted: '#94A3B8',
  primary: '#22C55E',
  onPrimary: '#052E16',
  accent: '#4ADE80',
  accentSoft: 'rgba(34,197,94,0.16)',
  danger: '#F87171',
  onDanger: '#450A0A',
  dangerSoft: 'rgba(248,113,113,0.16)',
  warning: '#FBBF24',
  warningSoft: 'rgba(251,191,36,0.16)',
  success: '#4ADE80',
  successSoft: 'rgba(74,222,128,0.16)',
  userBubble: '#1E293B',
  codeBg: '#090E1A',
  codeText: '#E2E8F0',
  scrim: 'rgba(2,6,23,0.72)',
};

export interface Theme {
  scheme: ThemeScheme;
  colors: ThemeColors;
  space: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number };
  radius: { sm: number; md: number; lg: number; pill: number };
  /** 正文 16；caption 仅用于元信息，不承载正文。 */
  font: { caption: number; body: number; title: number; heading: number; code: number };
  fontFamily: { sans: string | undefined; mono: string };
  icon: { sm: number; md: number; lg: number };
  minTouch: number;
}

const shared = {
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  font: { caption: 13, body: 15.5, title: 19, heading: 25, code: 14 },
  fontFamily: {
    sans: Platform.select({ ios: 'System', android: 'sans-serif', default: undefined }),
    mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) as string,
  },
  icon: { sm: 18, md: 22, lg: 28 },
  minTouch: 48,
} as const;

export const themes: Record<ThemeScheme, Theme> = {
  light: { scheme: 'light', colors: light, ...shared },
  dark: { scheme: 'dark', colors: dark, ...shared },
};

const ThemeContext = createContext<Theme>(themes.light);

/**
 * 偏好放在模块级小 store 里：ThemeProvider 在 AppServicesProvider 之外，
 * 拿不到 repository，由设置页/启动同步器写入，Provider 只负责订阅。
 */
let preference: ThemePreference = 'system';
const listeners = new Set<() => void>();

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  if (preference === next) return;
  preference = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 订阅方异常不能影响主题切换 */
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 纯函数：偏好 + 系统配色 → 实际使用的主题。 */
export function resolveTheme(pref: ThemePreference, systemScheme: ThemeScheme | null | undefined): Theme {
  const scheme: ThemeScheme = pref === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : pref;
  return themes[scheme];
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const pref = useSyncExternalStore(subscribe, getThemePreference, getThemePreference);
  const theme = useMemo(() => resolveTheme(pref, systemScheme), [pref, systemScheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/** 设置页用：读写偏好并立即生效。 */
export function useThemePreference(): { preference: ThemePreference; setPreference: (next: ThemePreference) => void } {
  const current = useSyncExternalStore(subscribe, getThemePreference, getThemePreference);
  const setPreference = useCallback((next: ThemePreference) => setThemePreference(next), []);
  return { preference: current, setPreference };
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
