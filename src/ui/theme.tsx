import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';

export type ThemeScheme = 'light' | 'dark';

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
  danger: string;
  onDanger: string;
  warning: string;
  success: string;
  codeBg: string;
  codeText: string;
  scrim: string;
}

const light: ThemeColors = {
  bg: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF2F7',
  border: '#CBD5E1',
  text: '#0F172A',
  textMuted: '#475569',
  primary: '#1E293B',
  onPrimary: '#FFFFFF',
  accent: '#15803D',
  danger: '#B91C1C',
  onDanger: '#FFFFFF',
  warning: '#B45309',
  success: '#15803D',
  codeBg: '#EEF2F7',
  codeText: '#0F172A',
  scrim: 'rgba(15,23,42,0.55)',
};

const dark: ThemeColors = {
  bg: '#0F172A',
  surface: '#1B2436',
  surfaceAlt: '#273449',
  border: '#475569',
  text: '#F8FAFC',
  textMuted: '#CBD5E1',
  primary: '#22C55E',
  onPrimary: '#052E16',
  accent: '#4ADE80',
  danger: '#F87171',
  onDanger: '#450A0A',
  warning: '#FBBF24',
  success: '#4ADE80',
  codeBg: '#0B1220',
  codeText: '#E2E8F0',
  scrim: 'rgba(2,6,23,0.7)',
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
  font: { caption: 14, body: 16, title: 20, heading: 26, code: 15 },
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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const theme = useMemo(() => (scheme === 'dark' ? themes.dark : themes.light), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
