import type { CredentialVault, Repository } from '../domain/contracts';

export interface CredentialDeleteSweep {
  removed: string[];
  failed: string[];
}

/**
 * 重试删除待删密钥：deleteServer 只把 credential_ref 写进本地待删表，密钥本体在这里删。
 * 失败项保留在待删表里，下次调用（启动、进入设置页、手动重试）继续处理。
 */
export async function flushPendingCredentialDeletes(
  repository: Repository,
  vault: CredentialVault,
): Promise<CredentialDeleteSweep> {
  const removed: string[] = [];
  const failed: string[] = [];

  const pending = await repository.listPendingCredentialDeletes();
  for (const ref of pending) {
    try {
      await vault.remove(ref);
      await repository.finishCredentialDelete(ref);
      removed.push(ref);
    } catch {
      failed.push(ref);
    }
  }

  return { removed, failed };
}
