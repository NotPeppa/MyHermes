/**
 * P2 同步冲突模型（设计 §4 P2、§5.3、§8.4、§14.3）：纯逻辑，不渲染。
 * 运行：npx tsx --test tests/p2-conflict.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConflict } from '@/features/chat/conflict';

const user = { role: 'user', body: '检查磁盘', createdAt: 1 };
const assistant = { role: 'assistant', body: '磁盘使用率 42%', createdAt: 2 };
const uncertain = { submissionState: 'submission_uncertain' };
const conflictError = { code: 'conflict' };

test('无错误且无未确认提交 → 不算冲突', () => {
  assert.equal(buildConflict({ messages: [user, assistant], draft: '草稿' }), null);
});

test('409 → server_conflict：可重载，不可同键重试', () => {
  const conflict = buildConflict({ messages: [user, assistant], draft: '草稿', error: conflictError });
  assert.ok(conflict);
  assert.equal(conflict.reason, 'server_conflict');
  assert.equal(conflict.canRetry, false);
  assert.equal(conflict.canReload, true);
  assert.equal(conflict.local.draft, '草稿');
  assert.equal(conflict.local.lastUserText, '检查磁盘');
  assert.equal(conflict.server.lastUserText, '检查磁盘');
  assert.equal(conflict.server.lastAssistantText, '磁盘使用率 42%');
  assert.equal(conflict.server.messageCount, 2);
});

test('未确认提交 + 服务端已有回复 → submission_uncertain：可同键重试', () => {
  const conflict = buildConflict({ messages: [user, assistant], draft: '草稿', submission: uncertain });
  assert.ok(conflict);
  assert.equal(conflict.reason, 'submission_uncertain');
  assert.equal(conflict.canRetry, true);
  assert.equal(conflict.canReload, true);
  assert.equal(conflict.server.lastAssistantText, '磁盘使用率 42%');
});

test('未确认提交但服务端没有回复 → 不算冲突', () => {
  assert.equal(buildConflict({ messages: [user], draft: '草稿', submission: uncertain }), null);
  assert.equal(buildConflict({ messages: [], draft: '草稿', submission: uncertain }), null);
});

test('409 与未确认同时存在 → 以 server_conflict 为主，仍可同键重试', () => {
  const conflict = buildConflict({
    messages: [user, assistant],
    draft: '',
    error: conflictError,
    submission: uncertain,
  });
  assert.ok(conflict);
  assert.equal(conflict.reason, 'server_conflict');
  assert.equal(conflict.canRetry, true);
  assert.equal(conflict.canReload, true);
});

test('其它错误码不触发冲突，空视图不崩', () => {
  assert.equal(buildConflict({ messages: [user], draft: '草稿', error: { code: 'not_found' } }), null);
  assert.equal(buildConflict({ messages: [], draft: '' }), null);
});
