import type { ServerConnection } from '@/domain/models';
import { enabledFeatures, modeLabel } from '@/features/common/status';
import { buildDiagnosticReport, hostOf } from './diagnostics';

/** 白名单字段拼装：只有域名、模式、能力、时间会进入报告。 */
export function reportFor(servers: ServerConnection[], clientVersion: string): string {
  return buildDiagnosticReport({
    clientVersion,
    generatedAt: Date.now(),
    servers: servers.map((server) => ({
      name: server.name,
      host: hostOf(server.baseUrl),
      mode: modeLabel(server.capabilities?.mode),
      features: enabledFeatures(server.capabilities?.features),
      lastCheckedAt: server.capabilities?.checkedAt ?? null,
      allowHttp: server.allowHttp === true,
    })),
  });
}
