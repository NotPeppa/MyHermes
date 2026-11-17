export type HermesErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'unavailable' | 'tls' | 'network' | 'protocol' | 'timeout' | 'cancelled';
export class HermesError extends Error {
  constructor(public code: HermesErrorCode, message: string, public status?: number, public retryAfter?: string) { super(message); this.name = 'HermesError'; }
}
