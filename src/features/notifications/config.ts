import type { Repository } from '@/domain/contracts';

export const PUSH_BRIDGE_URL_KEY = 'push.bridgeUrl';
export const PUSH_ENABLED_KEY = 'push.enabled';
export const PUSH_DEVICE_ID_KEY = 'push.deviceId';
export const PUSH_SERVER_ID_KEY = 'push.serverId';
export const PUSH_SERVER_ALIAS_KEY = 'push.serverAlias';

/** 桥的广播语义：serverId 为 * 时接收所有实例的事件。 */
export const DEFAULT_PUSH_SERVER_ID = '*';

export interface PushConfig {
  bridgeUrl: string;
  enabled: boolean;
  deviceId: string | null;
  serverId: string;
  serverAlias: string | null;
}

/** 设备密钥只进 SecureStore：ref 由 deviceId 派生，SQLite 与日志里都不出现密钥。 */
export function pushSecretRef(deviceId: string): string {
  return `hermes.push.secret.${deviceId}`;
}

export async function readPushConfig(repository: Repository): Promise<PushConfig> {
  const [bridgeUrl, enabled, deviceId, serverId, serverAlias] = await Promise.all([
    repository.getSetting(PUSH_BRIDGE_URL_KEY),
    repository.getSetting(PUSH_ENABLED_KEY),
    repository.getSetting(PUSH_DEVICE_ID_KEY),
    repository.getSetting(PUSH_SERVER_ID_KEY),
    repository.getSetting(PUSH_SERVER_ALIAS_KEY),
  ]);
  return {
    bridgeUrl: bridgeUrl?.trim() ?? '',
    enabled: enabled === 'true',
    deviceId: deviceId || null,
    serverId: serverId?.trim() || DEFAULT_PUSH_SERVER_ID,
    serverAlias: serverAlias || null,
  };
}

export async function writePushConfig(repository: Repository, patch: Partial<PushConfig>): Promise<void> {
  const writes: [string, string][] = [];
  if (patch.bridgeUrl !== undefined) writes.push([PUSH_BRIDGE_URL_KEY, patch.bridgeUrl.trim()]);
  if (patch.enabled !== undefined) writes.push([PUSH_ENABLED_KEY, patch.enabled ? 'true' : 'false']);
  if (patch.deviceId !== undefined) writes.push([PUSH_DEVICE_ID_KEY, patch.deviceId ?? '']);
  if (patch.serverId !== undefined) writes.push([PUSH_SERVER_ID_KEY, patch.serverId.trim() || DEFAULT_PUSH_SERVER_ID]);
  if (patch.serverAlias !== undefined) writes.push([PUSH_SERVER_ALIAS_KEY, patch.serverAlias ?? '']);
  await Promise.all(writes.map(([key, value]) => repository.setSetting(key, value)));
}
