/** Diagnostics are deliberately allow-listed: never accept request/response bodies or headers. */
export function diagnosticReport(input: { baseUrl: string; mode?: string; code?: string; status?: number; latencyMs?: number; checkedAt?: number }): string {
  let host = 'invalid';
  try { const url = new URL(input.baseUrl); host = url.hostname; } catch { /* omit invalid input */ }
  return JSON.stringify({ host, mode: input.mode, code: input.code, status: input.status, latencyMs: input.latencyMs, checkedAt: input.checkedAt }, null, 2);
}
