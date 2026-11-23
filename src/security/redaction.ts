const SECRET_PATTERNS: RegExp[] = [
  /(authorization|proxy-authorization)\s*[:=][^\n]*/gi,
  /(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /(device[_-]?id|idfv|idfa|android[_-]?id|advertising[_-]?id|imei|mac[_-]?address)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

/** 脱敏：移除 URL userinfo、Authorization、Key/Token 与长随机串。 */
export function redactText(input: string): string {
  let output = input;
  output = output.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1[已移除]@');
  output = output.replace(SECRET_PATTERNS[0]!, '$1: [已移除]');
  output = output.replace(SECRET_PATTERNS[1]!, '[已移除]');
  output = output.replace(SECRET_PATTERNS[2]!, '$1[已移除]');
  output = output.replace(SECRET_PATTERNS[3]!, '$1: [已移除]');
  output = output.replace(SECRET_PATTERNS[4]!, '[已移除]');
  return output;
}

/** Diagnostics are deliberately allow-listed: never accept request/response bodies or headers. */
export function diagnosticReport(input: { baseUrl: string; mode?: string; code?: string; status?: number; latencyMs?: number; checkedAt?: number }): string {
  let host = 'invalid';
  try { const url = new URL(input.baseUrl); host = url.hostname; } catch { /* omit invalid input */ }
  return JSON.stringify({ host, mode: input.mode, code: input.code, status: input.status, latencyMs: input.latencyMs, checkedAt: input.checkedAt }, null, 2);
}
