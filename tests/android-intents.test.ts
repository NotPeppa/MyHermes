/**
 * Android 外部入口：深链解析、目标选择、pending 交接、快捷方式 XML。
 * 这些是「Tasker / 快捷方式 / 分享菜单」能驱动 App 的契约，必须可测。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShortcutsXml, SHORTCUTS } from '../plugins/withAndroidShortcuts.js';
import {
  clearPendingIntent,
  MAX_INTENT_TEXT,
  normalizeIntentText,
  peekPendingIntent,
  setPendingIntent,
  takePendingIntent,
} from '../src/features/intents/pending';
import { resolveTarget } from '../src/features/intents/send-intent';
import type { Repository } from '../src/domain/contracts';
import type { ServerConnection, Session } from '../src/domain/models';

const server = (id: string): ServerConnection => ({
  id,
  name: id,
  baseUrl: `https://${id}.example.com`,
  credentialRef: `cred-${id}`,
  capabilities: { mode: 'native_runs', features: {}, checkedAt: 0 },
  createdAt: 0,
});

function repository(servers: ServerConnection[], sessions: Session[] = []): Repository {
  return {
    init: async () => {},
    listServers: async () => servers,
    saveServer: async () => {},
    deleteServer: async () => {},
    listSessions: async (serverId) => sessions.filter((item) => item.serverId === serverId),
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

const session = (serverId: string, id: string, updatedAt: number): Session => ({ serverId, id, title: id, updatedAt });

test('pending intent：取走即清空，避免重复填入', () => {
  clearPendingIntent();
  assert.equal(peekPendingIntent(), null);
  setPendingIntent({ source: 'deeplink', text: '检查磁盘' });
  assert.equal(peekPendingIntent()?.text, '检查磁盘');
  assert.equal(takePendingIntent()?.text, '检查磁盘');
  assert.equal(takePendingIntent(), null);
});

test('外部文本：去首尾空白、统一换行、超长截断', () => {
  assert.equal(normalizeIntentText('  你好  '), '你好');
  assert.equal(normalizeIntentText('a\r\nb'), 'a\nb');
  assert.equal(normalizeIntentText('   '), undefined);
  assert.equal(normalizeIntentText(undefined), undefined);
  const long = 'x'.repeat(MAX_INTENT_TEXT + 100);
  assert.equal(normalizeIntentText(long)?.length, MAX_INTENT_TEXT);
});

test('目标选择：显式 server 优先，其次激活实例，最后第一个', async () => {
  const repo = repository([server('a'), server('b')], [session('a', 's-old', 1), session('a', 's-new', 9), session('b', 's-b', 5)]);

  const explicit = await resolveTarget(repo, { serverId: 'b', activeServerId: 'a' });
  assert.deepEqual(explicit.result, { kind: 'ok', serverId: 'b', sessionId: 's-b' });

  const active = await resolveTarget(repo, { activeServerId: 'a' });
  assert.deepEqual(active.result, { kind: 'ok', serverId: 'a', sessionId: 's-new' }, '应选最近更新的会话');

  const fallback = await resolveTarget(repo, { activeServerId: 'missing' });
  assert.deepEqual(fallback.result, { kind: 'ok', serverId: 'a', sessionId: 's-new' });
});

test('目标选择：无实例、未知实例、无会话三种边界', async () => {
  assert.deepEqual((await resolveTarget(repository([]), {})).result, { kind: 'no_server' });
  assert.deepEqual((await resolveTarget(repository([server('a')]), { serverId: 'zzz' })).result, {
    kind: 'unknown_server',
    serverId: 'zzz',
  });
  const noSessions = await resolveTarget(repository([server('a')]), {});
  assert.deepEqual(noSessions.result, { kind: 'ok', serverId: 'a', sessionId: null }, '无会话时应交给调用方新建');
});

test('快捷方式 XML：三个入口、包名与深链正确', () => {
  const xml = buildShortcutsXml({ packageName: 'dev.myhermes.mobile', scheme: 'myhermes' });
  assert.equal(SHORTCUTS.length, 3);
  for (const shortcut of SHORTCUTS) {
    assert.match(xml, new RegExp(`android:shortcutId="${shortcut.id}"`));
    assert.match(xml, new RegExp(`android:data="myhermes://${shortcut.schemePath.replace('?', '\\?')}"`));
  }
  assert.match(xml, /android:targetPackage="dev\.myhermes\.mobile"/);
  assert.match(xml, /android:targetClass="dev\.myhermes\.mobile\.MainActivity"/);
  assert.match(xml, /android:action="android\.intent\.action\.VIEW"/);
  assert.match(xml, /<shortcuts xmlns:android="http:\/\/schemas\.android\.com\/apk\/res\/android">/);
});

test('快捷方式 XML：自定义 scheme 与空列表', () => {
  const custom = buildShortcutsXml({ packageName: 'com.example.app', scheme: 'demo', shortcuts: [SHORTCUTS[0]!] });
  assert.match(custom, /com\.example\.app/);
  assert.match(custom, /android:data="demo:\/\/sessions"/);

  const empty = buildShortcutsXml({ packageName: 'com.example.app', scheme: 'demo', shortcuts: [] });
  assert.doesNotMatch(empty, /<shortcut /);
});
