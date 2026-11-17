/**
 * 压力/规模自检（设计 §16.3 的性能目标，非上游 SLA）：
 * - SSE 解析器在大量分片帧下不丢字节、不串序
 * - 2000 条消息的写入与读取保持顺序
 * 只断言正确性并打印耗时，不设硬性时间预算，避免 CI 抖动。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SSEParser, type SSEFrame } from '../src/api/sse';
import { normalizeEvent } from '../src/adapters/hermes/events';
import { createSQLiteRepository } from '../src/storage/repository';
import { migrate, type SQLiteBindValue, type SQLiteDatabase } from '../src/storage/sqlite';
import type { Message } from '../src/domain/models';

class MemoryDatabase implements SQLiteDatabase {
  readonly raw = new DatabaseSync(':memory:');
  async execAsync(source: string): Promise<void> { this.raw.exec(source); }
  async runAsync(source: string, params: SQLiteBindValue[] = []): Promise<void> { this.raw.prepare(source).run(...params); }
  async getAllAsync<T>(source: string, params: SQLiteBindValue[] = []): Promise<T[]> { return this.raw.prepare(source).all(...params) as T[]; }
  async getFirstAsync<T>(source: string, params: SQLiteBindValue[] = []): Promise<T | null> { return (this.raw.prepare(source).get(...params) ?? null) as T | null; }
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.raw.exec('BEGIN');
    try { await task(); this.raw.exec('COMMIT'); } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
}

test('SSE 解析：5000 帧按 7 字节分片，顺序与内容不丢', () => {
  const frames: SSEFrame[] = [];
  const parser = new SSEParser((frame) => frames.push(frame));
  const total = 5000;
  let wire = '';
  for (let i = 0; i < total; i++) {
    wire += `id: e${i}\nevent: message.delta\ndata: {"text":"片段${i}·中文"}\n\n`;
  }
  const started = Date.now();
  const bytes = Buffer.from(wire, 'utf8');
  const decoder = new TextDecoder();
  for (let offset = 0; offset < bytes.length; offset += 7) {
    parser.push(decoder.decode(bytes.subarray(offset, offset + 7), { stream: true }));
  }
  parser.push(decoder.decode(), true);
  const elapsed = Date.now() - started;

  assert.equal(frames.length, total);
  assert.equal(frames[0]?.id, 'e0');
  assert.equal(frames.at(-1)?.id, `e${total - 1}`);
  const events = frames.map((frame) => normalizeEvent(frame, 'run-1'));
  assert.equal(events[0]?.text, '片段0·中文');
  assert.equal(events.at(-1)?.text, `片段${total - 1}·中文`);
  assert.ok(events.every((event) => event.kind === 'text_delta'));
  console.log(`SSE 分片解析 ${total} 帧耗时 ${elapsed}ms`);
});

test('SSE 解析：keepalive 注释与多行 data 不进入正文', () => {
  const frames: SSEFrame[] = [];
  const parser = new SSEParser((frame) => frames.push(frame));
  parser.push(': keepalive\n\n');
  parser.push('event: message.delta\ndata: 第一行\ndata: 第二行\n\n');
  parser.push('data: [DONE]\n\n');
  parser.push('', true);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.data, '第一行\n第二行');
  assert.equal(frames[1]?.data, '[DONE]');
});

test('2000 条消息写入与读取保持顺序', async () => {
  const db = new MemoryDatabase();
  await migrate(db);
  const repository = createSQLiteRepository(db);
  const total = 2000;
  const messages: Message[] = Array.from({ length: total }, (_, index) => ({
    id: `m${index}`,
    serverId: 'srv',
    sessionId: 'sess',
    role: index % 2 === 0 ? 'user' : 'assistant',
    body: `第 ${index} 条消息`,
    createdAt: index,
  }));

  const writeStart = Date.now();
  await repository.replaceMessages('srv', 'sess', messages);
  const writeMs = Date.now() - writeStart;

  const readStart = Date.now();
  const loaded = await repository.listMessages('srv', 'sess');
  const readMs = Date.now() - readStart;

  assert.equal(loaded.length, total);
  assert.equal(loaded[0]?.id, 'm0');
  assert.equal(loaded.at(-1)?.id, `m${total - 1}`);
  assert.deepEqual(loaded.map((message) => message.createdAt), messages.map((message) => message.createdAt));
  console.log(`2000 条消息写入 ${writeMs}ms，读取 ${readMs}ms`);
});
