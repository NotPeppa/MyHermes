import * as SecureStore from 'expo-secure-store';
import type { CredentialVault } from '../domain/contracts';

/**
 * API Key 只存在 SecureStore，SQLite 里只留 credential_ref。
 * THIS_DEVICE_ONLY：不随 iCloud/系统备份迁移到新设备。
 */
export function createVault(): CredentialVault {
  return {
    get: (ref) => SecureStore.getItemAsync(ref),
    set: (ref, key) =>
      SecureStore.setItemAsync(ref, key, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    remove: (ref) => SecureStore.deleteItemAsync(ref),
  };
}
