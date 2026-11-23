import { useCallback, useEffect, useRef, useState } from 'react';
import { HermesError } from '@/domain/errors';
import type { ServerConnection, Session } from '@/domain/models';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';
import { readActiveServerId, readCacheEnabled, writeActiveServerId } from '@/features/settings/prefs';

export interface SessionsNotice {
  tone: 'success' | 'error';
  title?: string;
  text: string;
}

export interface SessionsState {
  servers: ServerConnection[];
  activeServer: ServerConnection | null;
  sessions: Session[];
  loading: boolean;
  refreshing: boolean;
  offline: boolean;
  error: string | null;
  /** 搜索关键词（页面保留，返回列表页时仍在） */
  query: string;
  setQuery: (next: string) => void;
  /** 搜索命中的会话；null 表示未搜索，页面用 sessions 全量 */
  matches: Session[] | null;
  notice: SessionsNotice | null;
  dismissNotice: () => void;
  selectServer: (serverId: string) => void;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  createSession: () => Promise<string | null>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string, mode: 'local' | 'server') => Promise<void>;
  forkSession: (sessionId: string, title?: string) => Promise<void>;
}

/** 输入停顿 200ms 才查，避免每敲一个字都过滤一遍缓存。 */
const SEARCH_DEBOUNCE_MS = 200;

/** 会话列表：先本地缓存后刷新；实例切换不串数据。 */
export function useSessions(): SessionsState {
  const { repository, service } = useAppServices();
  const [servers, setServers] = useState<ServerConnection[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Session[] | null>(null);
  const [notice, setNotice] = useState<SessionsNotice | null>(null);
  const activeServerIdRef = useRef<string | null>(null);

  const loadServers = useCallback(async () => {
    const list = await repository.listServers();
    setServers(list);
    const stored = await readActiveServerId(repository);
    const next = stored && list.some((server) => server.id === stored) ? stored : list[0]?.id ?? null;
    setActiveServerId(next);
    activeServerIdRef.current = next;
    return next;
  }, [repository]);

  const loadCache = useCallback(
    async (serverId: string) => {
      const cacheEnabled = await readCacheEnabled(repository);
      if (!cacheEnabled) {
        setSessions([]);
        return;
      }
      const cached = await repository.listSessions(serverId);
      if (activeServerIdRef.current === serverId) setSessions(cached);
    },
    [repository],
  );

  const refresh = useCallback(async () => {
    const serverId = activeServerIdRef.current;
    if (!serverId) return;
    setRefreshing(true);
    setError(null);
    try {
      const remote = await service.listSessions(serverId);
      if (activeServerIdRef.current !== serverId) return;
      const cacheEnabled = await readCacheEnabled(repository);
      if (cacheEnabled) await repository.saveSessions(serverId, remote);
      setSessions(remote);
      setOffline(false);
    } catch (refreshError) {
      if (activeServerIdRef.current !== serverId) return;
      if (refreshError instanceof HermesError && (refreshError.code === 'network' || refreshError.code === 'unavailable')) {
        setOffline(true);
      } else {
        setError(describeError(refreshError));
      }
    } finally {
      if (activeServerIdRef.current === serverId) setRefreshing(false);
    }
  }, [repository, service]);

  const reload = useCallback(async () => {
    try {
      const prev = activeServerIdRef.current;
      const next = await loadServers();
      if (!next) {
        setSessions([]);
        setOffline(false);
        return;
      }
      if (next !== prev) await loadCache(next);
      await refresh();
    } catch (loadError) {
      setError(describeError(loadError));
    }
  }, [loadCache, loadServers, refresh]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const serverId = await loadServers();
        if (!alive) return;
        if (serverId) await loadCache(serverId);
        if (!alive) return;
        setLoading(false);
        await refresh();
      } catch (loadError) {
        if (!alive) return;
        setError(describeError(loadError));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadCache, loadServers, refresh]);

  // 搜索：防抖后走服务层的本地缓存过滤；清空关键词即恢复全量。
  // 依赖 sessions：刷新/切换实例后缓存变了，命中结果要跟着重算。
  useEffect(() => {
    const serverId = activeServerIdRef.current;
    const trimmed = query.trim();
    if (!serverId || trimmed.length === 0) {
      setMatches(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void service.searchSessions(serverId, trimmed).then(
        (found) => {
          if (alive && activeServerIdRef.current === serverId) setMatches(found);
        },
        (searchError: unknown) => {
          if (alive) setNotice({ tone: 'error', title: '搜索失败', text: describeError(searchError) });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, service, sessions]);

  const selectServer = useCallback(
    (serverId: string) => {
      if (serverId === activeServerIdRef.current) return;
      activeServerIdRef.current = serverId;
      setActiveServerId(serverId);
      setSessions([]);
      setOffline(false);
      setError(null);
      // 换实例不保留上一个实例的搜索，避免命中结果串数据
      setQuery('');
      setMatches(null);
      void writeActiveServerId(repository, serverId).catch(() => undefined);
      void loadCache(serverId)
        .then(() => refresh())
        .catch((switchError: unknown) => {
          if (activeServerIdRef.current === serverId) setError(describeError(switchError));
        });
    },
    [loadCache, refresh, repository],
  );

  const createSession = useCallback(async (): Promise<string | null> => {
    const serverId = activeServerIdRef.current;
    if (!serverId) return null;
    setError(null);
    try {
      const created = await service.createSession(serverId);
      const remote = await service.listSessions(serverId);
      const cacheEnabled = await readCacheEnabled(repository);
      if (cacheEnabled) await repository.saveSessions(serverId, remote);
      if (activeServerIdRef.current === serverId) setSessions(remote);
      return created.id;
    } catch (createError) {
      if (activeServerIdRef.current === serverId) setError(describeError(createError));
      return null;
    }
  }, [repository, service]);

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      const serverId = activeServerIdRef.current;
      if (!serverId) return;
      setError(null);
      try {
        await service.renameSession(serverId, sessionId, title);
        if (activeServerIdRef.current === serverId) {
          setSessions((current) => current.map((session) => (session.id === sessionId ? { ...session, title } : session)));
        }
      } catch (renameError) {
        if (activeServerIdRef.current === serverId) setError(describeError(renameError));
      }
    },
    [service],
  );

  const deleteSession = useCallback(
    async (sessionId: string, mode: 'local' | 'server') => {
      const serverId = activeServerIdRef.current;
      if (!serverId) return;
      setError(null);
      try {
        if (mode === 'server') await service.deleteSession(serverId, sessionId);
        else await service.deleteLocalSession(serverId, sessionId);
        if (activeServerIdRef.current === serverId) {
          setSessions((current) => current.filter((session) => session.id !== sessionId));
        }
      } catch (deleteError) {
        if (activeServerIdRef.current === serverId) setError(describeError(deleteError));
      }
    },
    [service],
  );

  const forkSession = useCallback(
    async (sessionId: string, title?: string) => {
      const serverId = activeServerIdRef.current;
      if (!serverId) return;
      setNotice(null);
      try {
        const forked = await service.forkSession(serverId, sessionId, title);
        setNotice({ tone: 'success', text: `已创建分支会话「${forked.title || forked.id}」` });
        // 分支后列表会多一条，刷新失败不影响已经建好的会话
        await refresh();
      } catch (forkError) {
        setNotice({ tone: 'error', text: describeError(forkError) });
      }
    },
    [refresh, service],
  );

  return {
    servers,
    activeServer: servers.find((server) => server.id === activeServerId) ?? null,
    sessions,
    loading,
    refreshing,
    offline,
    error,
    query,
    setQuery,
    matches,
    notice,
    dismissNotice: () => setNotice(null),
    selectServer,
    reload,
    refresh,
    createSession,
    renameSession,
    deleteSession,
    forkSession,
  };
}
