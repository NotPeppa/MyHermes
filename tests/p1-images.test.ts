/**
 * 图片附件（P1，设计 §15）：
 * - 纯逻辑：尺寸限制、体积上限、data URI、Chat Completions content 数组
 * - 契约：compat 模式发 image_url；Runs/Sessions 未声明图片字段，必须拒绝而不是臆造
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesService } from '../src/runtime/service';
import { HermesError } from '../src/domain/errors';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { ImageAttachment, ServerConnection } from '../src/domain/models';
import {
  attachmentFrom,
  base64Bytes,
  buildCompatContent,
  checkAttachment,
  dataUriOf,
  formatBytes,
  isAcceptedMime,
  MAX_BYTES,
  MAX_EDGE,
  MAX_IMAGES,
  targetSize,
} from '../src/media/image';

const base64 = Buffer.from('fake-jpeg-bytes').toString('base64');

const attachment = (overrides: Partial<ImageAttachment> = {}): ImageAttachment => ({
  ...attachmentFrom(base64, { id: 'img_1', width: 800, height: 600 }),
  ...overrides,
});

test('长边限制到 1568，小图不放大', () => {
  assert.deepEqual(targetSize(4000, 3000), { width: MAX_EDGE, height: 1176 });
  assert.deepEqual(targetSize(3000, 4000), { width: 1176, height: MAX_EDGE });
  assert.deepEqual(targetSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(targetSize(0, 0), { width: MAX_EDGE, height: MAX_EDGE });
});

test('data URI 与体积估算', () => {
  assert.equal(dataUriOf('AAA'), 'data:image/jpeg;base64,AAA');
  assert.equal(base64Bytes('AAAA'), 3);
  assert.equal(base64Bytes('AAA='), 2);
  const image = attachment();
  assert.match(image.dataUri, /^data:image\/jpeg;base64,/);
  assert.ok(image.bytes > 0);
});

test('体积与数量上限给出可读拒绝原因', () => {
  assert.equal(checkAttachment(attachment(), 0), null);
  assert.match(checkAttachment(attachment({ bytes: MAX_BYTES + 1 }), 0) ?? '', /小于/);
  assert.match(checkAttachment(attachment(), MAX_IMAGES) ?? '', /最多附加/);
  assert.match(checkAttachment(attachment({ mimeType: 'application/pdf' }), 0) ?? '', /只支持图片/);
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('MIME 白名单：缺失类型放行，非图片拒绝', () => {
  assert.equal(isAcceptedMime(undefined), true);
  assert.equal(isAcceptedMime('image/HEIC'), true);
  assert.equal(isAcceptedMime('application/pdf'), false);
});

test('compat content：纯文本保持字符串，含图片时变成 parts 数组', () => {
  assert.equal(buildCompatContent('你好', undefined), '你好');
  assert.equal(buildCompatContent('你好', []), '你好');
  const parts = buildCompatContent('看图', [attachment()]) as { type: string }[];
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: 'text', text: '看图' });
  assert.equal(parts[1]?.type, 'image_url');
  const imageOnly = buildCompatContent('', [attachment()]) as { type: string }[];
  assert.equal(imageOnly.length, 1);
});

// ---- 服务层契约 ----

const server = (mode: ServerConnection['capabilities']['mode']): ServerConnection => ({
  id: 'srv',
  name: 'demo',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred',
  capabilities: { mode, features: { chat_completions: true, run_submission: true, run_status: true, run_events_sse: true, sessions_list: true, session_messages: true, session_chat_stream: true }, checkedAt: Date.now() },
  createdAt: 0,
});

function repositoryFor(target: ServerConnection): Repository {
  const servers = [target];
  const sessions = [{ serverId: 'srv', id: 'sess', title: '会话', updatedAt: 0 }];
  return {
    init: async () => {},
    listServers: async () => servers,
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => sessions,
    saveSessions: async () => {},
    deleteSession: async () => {},
    listMessages: async () => [],
    replaceMessages: async () => {},
    saveTurn: async () => {},
    listTurns: async () => [],
    saveRun: async () => {},
    listRuns: async () => [],
    saveToolEvent: async () => {},
    listToolEvents: async () => [],
    clearCache: async () => {},
    getSetting: async () => null,
    setSetting: async () => {},
    listPendingCredentialDeletes: async () => [],
    finishCredentialDelete: async () => {},
  };
}

const vault: CredentialVault = { get: async () => 'key', set: async () => {}, remove: async () => {} };

function captureFetch() {
  const bodies: { url: string; body: string }[] = [];
  const fetcher = async (url: string, init?: { body?: string }) => {
    bodies.push({ url, body: init?.body ?? '' });
    if (url.includes('/v1/chat/completions')) {
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('/v1/runs')) return new Response(JSON.stringify({ run_id: 'run_1', status: 'started' }), { status: 202, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { bodies, fetcher };
}

test('compat 模式发送图片：请求体是 text + image_url parts', async () => {
  const { bodies, fetcher } = captureFetch();
  const service = new HermesService({ repository: repositoryFor(server('openai_compat')), vault, fetch: fetcher as never });
  await service.send('srv', 'sess', '看图', { images: [attachment()] });
  const body = JSON.parse(bodies.find((item) => item.url.includes('/v1/chat/completions'))?.body ?? '{}');
  const content = body.messages.at(-1).content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: 'text', text: '看图' });
  assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/);
  await service.dispose();
});

test('compat 模式纯文字不带 parts 数组', async () => {
  const { bodies, fetcher } = captureFetch();
  const service = new HermesService({ repository: repositoryFor(server('openai_compat')), vault, fetch: fetcher as never });
  await service.send('srv', 'sess', '你好');
  const body = JSON.parse(bodies.find((item) => item.url.includes('/v1/chat/completions'))?.body ?? '{}');
  assert.equal(body.messages.at(-1).content, '你好');
  await service.dispose();
});

test('Runs 模式带图片被拒绝且不发送请求', async () => {
  const { bodies, fetcher } = captureFetch();
  const target = server('native_runs');
  delete target.capabilities.features.session_chat_stream;
  const service = new HermesService({ repository: repositoryFor(target), vault, fetch: fetcher as never });
  await assert.rejects(
    service.send('srv', 'sess', '看图', { images: [attachment()] }),
    (error: unknown) => error instanceof HermesError && error.code === 'protocol',
  );
  assert.equal(bodies.length, 0);
  await service.dispose();
});

test('Sessions 单轮使用官方字段 input', async () => {
  const { bodies, fetcher } = captureFetch();
  const service = new HermesService({ repository: repositoryFor(server('native_sessions')), vault, fetch: fetcher as never });
  await service.send('srv', 'sess', '你好');
  const call = bodies.find((item) => item.url.includes('/chat/stream'));
  assert.ok(call, '应调用 chat/stream');
  assert.deepEqual(JSON.parse(call.body), { input: '你好' });
  await service.dispose();
});

test('Runs 模式带图片改走会话流式接口（多模态 parts）', async () => {
  const { bodies, fetcher } = captureFetch();
  const target = server('native_runs');
  target.capabilities.features.session_chat_streaming = true;
  const service = new HermesService({ repository: repositoryFor(target), vault, fetch: fetcher as never });
  await service.send('srv', 'sess', '看图', { images: [attachment()] });
  const call = bodies.find((item) => item.url.includes('/chat/stream'));
  assert.ok(call, `应调用会话流式接口，实际：${bodies.map((b) => b.url).join(', ')}`);
  const body = JSON.parse(call.body);
  assert.ok(Array.isArray(body.input), 'input 应是 parts 数组');
  assert.deepEqual(body.input[0], { type: 'text', text: '看图' });
  assert.match(body.input[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.ok(!bodies.some((item) => item.url.includes('/v1/runs')), '不应再提交 Runs');
  await service.dispose();
});

test('Runs 模式纯文字仍走 Runs（保留恢复能力）', async () => {
  const { bodies, fetcher } = captureFetch();
  const target = server('native_runs');
  target.capabilities.features.session_chat_streaming = true;
  const service = new HermesService({ repository: repositoryFor(target), vault, fetch: fetcher as never });
  await service.send('srv', 'sess', '你好');
  assert.ok(bodies.some((item) => item.url.includes('/v1/runs')), '纯文字应走 Runs');
  assert.ok(!bodies.some((item) => item.url.includes('/chat/stream')));
  await service.dispose();
});

test('既没有会话流式接口也不是兼容模式时，带图片明确拒绝', async () => {
  const { bodies, fetcher } = captureFetch();
  const target = server('native_runs');
  delete target.capabilities.features.session_chat_stream;
  const service = new HermesService({ repository: repositoryFor(target), vault, fetch: fetcher as never });
  await assert.rejects(
    service.send('srv', 'sess', '看图', { images: [attachment()] }),
    (error: unknown) => error instanceof HermesError && error.code === 'protocol',
  );
  assert.equal(bodies.length, 0);
  await service.dispose();
});
