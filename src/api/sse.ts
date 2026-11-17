import { ProtocolError } from './transport';
export interface SSEFrame { event: string; data: string; id?: string; retry?: number; idExplicit?: boolean }
/** Stateful SSE framing, including CR, CRLF split across chunks and persistent last-event-id. */
export class SSEParser {
  private buffer = ''; private data: string[] = []; private event = ''; private id?: string; private retry?: number; private idExplicit = false;
  constructor(private emit: (frame: SSEFrame) => void) {}
  push(chunk: string, final = false): void {
    this.buffer += chunk;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== '\r' && c !== '\n') continue;
      if (c === '\r' && i === this.buffer.length - 1 && !final) break;
      this.line(this.buffer.slice(start, i));
      if (c === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    // SSE dispatch requires a blank line; discard incomplete final events, as specified by EventSource.
    if (final) { this.buffer = ''; this.data = []; }
  }
  private line(line: string): void {
    if (!line) {
      if (this.data.length) this.emit({ event: this.event || 'message', data: this.data.join('\n'), id: this.id, retry: this.retry, idExplicit: this.idExplicit });
      this.data = []; this.event = ''; this.idExplicit = false; return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) { this.id = value; this.idExplicit = true; }
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
  }
}
export async function consumeSSE(response: Response, signal: AbortSignal, onFrame: (frame: SSEFrame) => void): Promise<void> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ProtocolError('protocol', '服务器未返回 SSE 流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser(onFrame);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!signal.aborted) { const { value, done } = await reader.read(); if (done) break; parser.push(decoder.decode(value, { stream: true })); }
    if (signal.aborted) throw new ProtocolError('cancelled', '流读取已取消');
    parser.push(decoder.decode(), true);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
