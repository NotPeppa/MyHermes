import { useCallback, useEffect, useRef, useState } from 'react';
import { HermesError } from '@/domain/errors';
import type { Job, ServerConnection } from '@/domain/models';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';
import { readActiveServerId } from '@/features/settings/prefs';

export interface JobsState {
  server: ServerConnection | null;
  /** 服务器是否声明 jobs_admin；false 时页面显示说明而不是空列表 */
  canManage: boolean;
  jobs: Job[];
  loading: boolean;
  refreshing: boolean;
  offline: boolean;
  error: string | null;
  busyJobId: string | null;
  refresh: () => Promise<void>;
  run: (jobId: string) => Promise<void>;
  togglePause: (job: Job) => Promise<void>;
  remove: (jobId: string) => Promise<void>;
}

// 只有真正的网络问题才算「连接中断」；5xx 属于服务器错误，要显示具体状态
const offlineCodes = new Set(['network', 'timeout']);

/** 任务中心：只读列表 + 立即运行 / 暂停恢复 / 删除，全部以服务器为准，不做本地乐观状态。 */
export function useJobs(): JobsState {
  const { repository, service } = useAppServices();
  const [server, setServer] = useState<ServerConnection | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const serverIdRef = useRef<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const serverId = serverIdRef.current;
      if (!serverId) {
        setLoading(false);
        return;
      }
      if (mode === 'refresh') setRefreshing(true);
      setError(null);
      try {
        const list = await service.listJobs(serverId);
        if (serverIdRef.current !== serverId) return;
        setJobs(list);
        setOffline(false);
      } catch (loadError) {
        if (serverIdRef.current !== serverId) return;
        if (loadError instanceof HermesError && offlineCodes.has(loadError.code)) setOffline(true);
        else setError(describeError(loadError));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [service],
  );

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
        // 旗标只是提示：缺失时由服务层实际探一次 /api/jobs 再决定
        if (!active) {
          setJobs([]);
          setLoading(false);
          return;
        }
        if (!(await service.canManageJobs(active.id))) {
          if (!alive) return;
          setCanManage(false);
          setJobs([]);
          setLoading(false);
          return;
        }
        if (!alive) return;
        setCanManage(true);
        await load('initial');
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

  const command = useCallback(
    async (jobId: string, action: 'pause' | 'resume' | 'run' | 'delete') => {
      const serverId = serverIdRef.current;
      if (!serverId) return;
      setBusyJobId(jobId);
      setError(null);
      try {
        if (action === 'pause') await service.pauseJob(serverId, jobId);
        else if (action === 'resume') await service.resumeJob(serverId, jobId);
        else if (action === 'run') await service.runJob(serverId, jobId);
        else await service.deleteJob(serverId, jobId);
        await load('refresh');
      } catch (commandError) {
        if (commandError instanceof HermesError && offlineCodes.has(commandError.code)) setOffline(true);
        else setError(describeError(commandError));
      } finally {
        setBusyJobId(null);
      }
    },
    [load, service],
  );

  return {
    server,
    canManage,
    jobs,
    loading,
    refreshing,
    offline,
    error,
    busyJobId,
    refresh: () => load('refresh'),
    run: (jobId) => command(jobId, 'run'),
    togglePause: (job) => command(job.id, job.paused ? 'resume' : 'pause'),
    remove: (jobId) => command(jobId, 'delete'),
  };
}
