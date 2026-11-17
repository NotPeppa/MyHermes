import { useCallback, useEffect, useRef, useState } from 'react';
import { HermesError } from '@/domain/errors';
import type { ServerConnection, Skill, Toolset } from '@/domain/models';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';
import { readActiveServerId } from '@/features/settings/prefs';

export interface SkillsState {
  server: ServerConnection | null;
  /** 服务器是否声明 skills_api；false 时页面显示说明 */
  canRead: boolean;
  skills: Skill[];
  toolsets: Toolset[];
  loading: boolean;
  offline: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** 技能与工具集：只读发现，没有写操作。 */
export function useSkills(): SkillsState {
  const { repository, service } = useAppServices();
  const [server, setServer] = useState<ServerConnection | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [toolsets, setToolsets] = useState<Toolset[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const serverId = serverIdRef.current;
    if (!serverId) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const [skillList, toolsetList] = await Promise.all([
        service.listSkills(serverId),
        service.listToolsets(serverId),
      ]);
      if (serverIdRef.current !== serverId) return;
      setSkills(skillList);
      setToolsets(toolsetList);
      setOffline(false);
    } catch (loadError) {
      if (serverIdRef.current !== serverId) return;
      if (loadError instanceof HermesError && ['network', 'unavailable', 'timeout'].includes(loadError.code)) {
        setOffline(true);
      } else {
        setError(describeError(loadError));
      }
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const servers = await repository.listServers();
        const stored = await readActiveServerId(repository);
        const active = servers.find((item) => item.id === stored) ?? servers[0] ?? null;
        if (!alive) return;
        serverIdRef.current = active?.id ?? null;
        setServer(active);
        if (!active?.capabilities.features.skills_api) {
          setSkills([]);
          setToolsets([]);
          setLoading(false);
          return;
        }
        await load();
      } catch (loadError) {
        if (!alive) return;
        setError(describeError(loadError));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load, repository]);

  return {
    server,
    canRead: server?.capabilities.features.skills_api === true,
    skills,
    toolsets,
    loading,
    offline,
    error,
    refresh: load,
  };
}
