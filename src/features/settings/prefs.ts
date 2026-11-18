import type { Repository } from '@/domain/contracts';

import type { ThemePreference } from '@/ui/theme';

export const ACTIVE_SERVER_KEY = 'activeServerId';
export const CACHE_ENABLED_KEY = 'cacheEnabled';
export const THEME_PREFERENCE_KEY = 'themePreference';

/** 外观偏好：默认跟随系统；非法值回落 system。 */
export async function readThemePreference(repository: Repository): Promise<ThemePreference> {
  const stored = await repository.getSetting(THEME_PREFERENCE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export async function writeThemePreference(repository: Repository, preference: ThemePreference): Promise<void> {
  await repository.setSetting(THEME_PREFERENCE_KEY, preference);
}

/** 缓存开关默认开启；关闭时页面跳过本地缓存读取，并在关闭瞬间清理。 */
export async function readCacheEnabled(repository: Repository): Promise<boolean> {
  const stored = await repository.getSetting(CACHE_ENABLED_KEY);
  return stored !== 'false';
}

export async function writeCacheEnabled(repository: Repository, enabled: boolean): Promise<void> {
  await repository.setSetting(CACHE_ENABLED_KEY, enabled ? 'true' : 'false');
}

export async function readActiveServerId(repository: Repository): Promise<string | null> {
  return repository.getSetting(ACTIVE_SERVER_KEY);
}

export async function writeActiveServerId(repository: Repository, serverId: string): Promise<void> {
  await repository.setSetting(ACTIVE_SERVER_KEY, serverId);
}
