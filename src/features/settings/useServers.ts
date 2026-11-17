import { useCallback, useEffect, useState } from 'react';
import { flushPendingCredentialDeletes } from '@/storage/credentials';
import type { Capabilities, ServerConnection } from '@/domain/models';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';

export interface ServersState {
  servers: ServerConnection[];
  loading: boolean;
  busyServerId: string | null;
  error: string | null;
  reload: () => Promise<void>;
  remove: (serverId: string) => Promise<void>;
  recheck: (server: ServerConnection) => Promise<Capabilities | null>;
}

/** 实例管理：列表、删除（密钥清理走待删表）、重新检测。 */
export function useServers(): ServersState {
  const { repository, vault, service } = useAppServices();
  const [servers, setServers] = useState<ServerConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setServers(await repository.listServers());
    } catch (loadError) {
      setError(describeError(loadError));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = useCallback(
    async (serverId: string) => {
      setBusyServerId(serverId);
      setError(null);
      try {
        await repository.deleteServer(serverId);
        await flushPendingCredentialDeletes(repository, vault);
        await reload();
      } catch (removeError) {
        setError(describeError(removeError));
      } finally {
        setBusyServerId(null);
      }
    },
    [reload, repository, vault],
  );

  const recheck = useCallback(
    async (server: ServerConnection): Promise<Capabilities | null> => {
      setBusyServerId(server.id);
      setError(null);
      try {
        const key = await vault.get(server.credentialRef);
        if (!key) throw new Error('该实例的 API Key 不在安全存储中，请重新添加连接');
        const result = await service.probe(server.baseUrl, key, { allowHttp: server.allowHttp });
        await repository.saveServer({ ...server, capabilities: result.capabilities });
        await reload();
        return result.capabilities;
      } catch (probeError) {
        setError(describeError(probeError));
        return null;
      } finally {
        setBusyServerId(null);
      }
    },
    [reload, repository, service, vault],
  );

  return { servers, loading, busyServerId, error, reload, remove, recheck };
}
