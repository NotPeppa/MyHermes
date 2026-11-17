/**
 * 错误可诊断性：HTTP 失败必须能看出「哪个接口 + 什么状态」，
 * 否则用户只会看到笼统的「资源不存在」，无法区分是地址错、代理没转发还是版本不支持。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtocolError } from '../src/api/transport';
import { HermesService } from '../src/runtime/service';
import { describeError } from '../src/features/common/errors';
import type { CredentialVault, Repository } from '../src/domain/contracts';
import type { ServerConnection } from '../src/domain/models';

const server: ServerConnection = {
  id: 'srv',
  name: 'demo',
  baseUrl: 'https://hermes.example.com',
  credentialRef: 'cred',
  capabilities: {
    mode: 'native_runs',
    features: { run_submission: true, run_status: true, run_events_sse: true, skills_api: true, jobs_admin: true },
    checkedAt: Date.now(),
  },
  createdAt: 0,
};

function repository(): Repository {
  return {
    init: async () => {},
    listServers: async () => [server],
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async () => [],
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

test('404 会带上方法与路径，便于判断是哪个接口', async () => {
  const service = new HermesService({
    repository: repository(),
    vault,
    fetch: (async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } })) as never,
  });
  await assert.rejects(service.listSkills('srv'), (error: unknown) => {
    const text = describeError(error);
    assert.match(text, /资源不存在（404）/);
    assert.match(text, /GET v1\/skills → HTTP 404/, `应指出具体接口，实际：${text}`);
    return true;
  });
  await service.dispose();
});

test('Jobs 命令失败同样带路径', async () => {
  const service = new HermesService({
    repository: repository(),
    vault,
    fetch: (async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })) as never,
  });
  await assert.rejects(service.pauseJob('srv', 'job_1'), (error: unknown) => {
    const text = describeError(error);
    assert.match(text, /无权限（403）/);
    assert.match(text, /POST api\/jobs\/job_1\/pause → HTTP 403/);
    return true;
  });
  await service.dispose();
});

test('500 归类为服务器错误，而不是「响应格式不符合预期」或 503', () => {
  const text = describeError(new ProtocolError('server', '服务器内部错误（GET v1/skills → HTTP 500）', 500));
  assert.match(text, /服务器内部错误/);
  assert.doesNotMatch(text, /响应格式不符合预期/);
  assert.doesNotMatch(text, /503/, '500 不应显示成 503');
  assert.match(text, /GET v1\/skills → HTTP 500/);
});

test('网络错误不额外拼路径，避免暴露主机信息', () => {
  const text = describeError(new ProtocolError('network', '网络连接中断'));
  assert.equal(text, '网络不可达：检查网络与服务器地址');
});

test('503 保留 Retry-After 建议', () => {
  const text = describeError(new ProtocolError('unavailable', '服务器繁忙或正在关闭（POST v1/runs → HTTP 503）', 503, '2'));
  assert.match(text, /服务器不可用（503）/);
  assert.match(text, /POST v1\/runs → HTTP 503/);
  assert.match(text, /建议 2 后重试/);
});

test('500 会把服务端错误信息带进提示（Hermes 的 {"error":{"message":…}}）', async () => {
  const service = new HermesService({
    repository: repository(),
    vault,
    fetch: (async () => new Response(
      JSON.stringify({ error: { message: 'Failed to enumerate skills', type: 'server_error', param: null, code: null } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )) as never,
  });
  await assert.rejects(service.listSkills('srv'), (error: unknown) => {
    const text = describeError(error);
    assert.match(text, /Failed to enumerate skills/, `应包含服务端原因，实际：${text}`);
    assert.match(text, /GET v1\/skills → HTTP 500/);
    return true;
  });
  await service.dispose();
});
