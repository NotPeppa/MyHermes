/**
 * 外部入口（深链 / 分享 / 快捷方式）落到哪个实例和会话。
 * 纯逻辑，便于单测：不读 SecureStore、不发请求，只做选择与校验。
 */
import type { Repository } from '@/domain/contracts';
import type { Session } from '@/domain/models';

export interface ResolveInput {
  /** 深链里显式指定的实例 */
  serverId?: string;
  /** 当前激活实例（来自本地设置） */
  activeServerId?: string | null;
}

export type ResolveResult =
  /** sessionId 为 null 表示该实例还没有会话，调用方需要新建 */
  | { kind: 'ok'; serverId: string; sessionId: string | null }
  | { kind: 'no_server' }
  | { kind: 'unknown_server'; serverId: string };

/**
 * 选择顺序：显式 serverId（必须存在）→ 当前激活实例 → 第一个实例。
 * 会话选择：该实例最近更新的缓存会话；没有会话时返回最近会话为空，由调用方决定是否新建。
 */
export async function resolveTarget(
  repository: Repository,
  input: ResolveInput,
): Promise<{ result: ResolveResult; session?: Session }> {
  const servers = await repository.listServers();
  if (servers.length === 0) return { result: { kind: 'no_server' } };

  let serverId: string | undefined;
  if (input.serverId) {
    if (!servers.some((server) => server.id === input.serverId)) {
      return { result: { kind: 'unknown_server', serverId: input.serverId } };
    }
    serverId = input.serverId;
  } else if (input.activeServerId && servers.some((server) => server.id === input.activeServerId)) {
    serverId = input.activeServerId;
  } else {
    serverId = servers[0]?.id;
  }
  if (!serverId) return { result: { kind: 'no_server' } };

  const sessions = await repository.listSessions(serverId);
  const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return { result: { kind: 'ok', serverId, sessionId: latest?.id ?? null }, session: latest };
}
