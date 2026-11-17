/**
 * 诊断报告：只允许白名单字段进入报告，并且对文本再做一次脱敏。
 * 复制前必须移除 URL userinfo、Authorization、请求体、会话正文与设备标识。
 */

export interface DiagnosticServer {
  name: string;
  host: string;
  mode: string;
  features: string[];
  lastCheckedAt: number | null;
  allowHttp: boolean;
}

export interface DiagnosticInput {
  clientVersion: string;
  generatedAt: number;
  servers: DiagnosticServer[];
  lastStatusCode?: number;
  latencyMs?: number;
  lastError?: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /(authorization|proxy-authorization)\s*[:=][^\n]*/gi,
  /(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /(device[_-]?id|idfv|idfa|android[_-]?id|advertising[_-]?id|imei|mac[_-]?address)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

export function redactText(input: string): string {
  let output = input;
  // URL userinfo：https://user:pass@host → https://[已移除]@host
  output = output.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1[已移除]@');
  output = output.replace(SECRET_PATTERNS[0]!, '$1: [已移除]');
  output = output.replace(SECRET_PATTERNS[1]!, '[已移除]');
  output = output.replace(SECRET_PATTERNS[2]!, '$1[已移除]');
  output = output.replace(SECRET_PATTERNS[3]!, '$1: [已移除]');
  output = output.replace(SECRET_PATTERNS[4]!, '[已移除]');
  return output;
}

/** 只保留主机名（含端口），丢掉 userinfo、路径、查询与片段。 */
export function hostOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch {
    return '无法解析';
  }
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return '从未检测';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function buildDiagnosticReport(input: DiagnosticInput): string {
  const lines: string[] = [
    'MyHermes 诊断报告（已脱敏：不含 Key、请求体、会话正文与设备标识）',
    `客户端版本：${input.clientVersion}`,
    `生成时间：${formatTime(input.generatedAt)}`,
  ];
  if (input.lastStatusCode !== undefined) lines.push(`HTTP 状态码：${input.lastStatusCode}`);
  if (input.latencyMs !== undefined) lines.push(`请求耗时：${input.latencyMs} ms`);
  if (input.lastError) lines.push(`最近错误：${redactText(input.lastError)}`);
  lines.push(`实例数量：${input.servers.length}`);
  input.servers.forEach((server, index) => {
    lines.push('');
    lines.push(`#${index + 1} ${redactText(server.name)}`);
    lines.push(`  域名：${server.host}`);
    lines.push(`  模式：${server.mode}`);
    lines.push(`  最近检测：${formatTime(server.lastCheckedAt)}`);
    lines.push(`  明文 HTTP：${server.allowHttp ? '已启用（开发构建）' : '未启用'}`);
    lines.push(`  能力：${server.features.length > 0 ? server.features.join('、') : '未探测到可用能力'}`);
  });
  return redactText(lines.join('\n'));
}
