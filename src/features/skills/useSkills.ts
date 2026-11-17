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
  /** 仅技能列表失败（工具集可能仍然可用） */
  skillsError: string | null;
  /** 仅工具集失败 */
  toolsetsError: string | null;
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
  const [canRead, setCanRead] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [toolsetsError, setToolsetsError] = useState<string | null>(null);
  const serverIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const serverId = serverIdRef.current;
    if (!serverId) {
      setLoading(false);
      return;
    }
    setError(null);
    setSkillsError(null);
    // 两个接口分开加载：/v1/skills 挂掉时 /v1/toolsets 往往仍然可用，不能一起丢
    const [skillResult, toolsetResult] = await Promise.allSettled([
      service.listSkills(serverId),
      service.listToolsets(serverId),
    ]);
    if (serverIdRef.current !== serverId) return;

    const failures = [skillResult, toolsetResult].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const offlineFailure = failures.find(
      (result) => result.reason instanceof HermesError && ['network', 'timeout'].includes(result.reason.code),
    );

    if (skillResult.status === 'fulfilled') setSkills(skillResult.value);
    if (toolsetResult.status === 'fulfilled') setToolsets(toolsetResult.value);

    if (offlineFailure) {
      setOffline(true);
    } else {
      setOffline(false);
      if (skillResult.status === 'rejected') setSkillsError(describeError(skillResult.reason));
      if (toolsetResult.status === 'rejected') setToolsetsError(describeError(toolsetResult.reason));
      if (failures.length > 0 && skillResult.status !== 'rejected') setError(describeError(failures[0]!.reason));
    }
    setLoading(false);
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
        // 旗标只是提示：缺失时由服务层实际探一次端点再决定
        if (!active) {
          setSkills([]);
          setToolsets([]);
          setLoading(false);
          return;
        }
        if (!(await service.canReadSkills(active.id))) {
          if (!alive) return;
          setCanRead(false);
          setSkills([]);
          setToolsets([]);
          setLoading(false);
          return;
        }
        if (!alive) return;
        setCanRead(true);
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
  }, [load, repository, service]);

  return {
    server,
    canRead,
    skills,
    toolsets,
    loading,
    offline,
    error,
    skillsError,
    toolsetsError,
    refresh: load,
  };
}
