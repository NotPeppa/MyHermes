import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusText, isActiveRun, canStopRun, modeLabel, enabledFeatures } from '@/features/common/status';
import { buildDiagnosticReport, hostOf, redactText } from '@/features/settings/diagnostics';
import { formatDateTime, formatRelative, formatTime } from '@/ui/format';
import { parseMarkdown } from '@/ui/markdown-parse';

test('parseMarkdown：代码块、标题、列表、引用与段落', () => {
  const blocks = parseMarkdown(
    ['# 标题', '', '普通段落', '第二行', '', '- 一', '- 二', '', '1. 甲', '2. 乙', '', '> 引用', '', '```ts', 'const a = 1;', '```'].join('\n'),
  );
  assert.deepEqual(blocks[0], { kind: 'heading', level: 1, text: '标题' });
  assert.deepEqual(blocks[1], { kind: 'para', text: '普通段落\n第二行' });
  assert.deepEqual(blocks[2], { kind: 'list', ordered: false, items: ['一', '二'] });
  assert.deepEqual(blocks[3], { kind: 'list', ordered: true, items: ['甲', '乙'] });
  assert.deepEqual(blocks[4], { kind: 'quote', text: '引用' });
  assert.deepEqual(blocks[5], { kind: 'code', lang: 'ts', text: 'const a = 1;' });
});

test('parseMarkdown：流式未闭合围栏不丢内容', () => {
  const blocks = parseMarkdown('```js\nlet x = 1\nlet y = 2');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { kind: 'code', lang: 'js', text: 'let x = 1\nlet y = 2' });
});

test('redactText：移除 Authorization、Key、URL userinfo 与长令牌', () => {
  const raw = [
    'Authorization: Bearer sk-live-abcdef123456',
    'apiKey=super-secret-value',
    'url https://user:pass@hermes.example.com/path',
    'deviceId: 1234-5678',
    'token abcdefghijklmnopqrstuvwxyz0123456789',
  ].join('\n');
  const redacted = redactText(raw);
  for (const secret of ['sk-live-abcdef123456', 'super-secret-value', 'user:pass', '1234-5678', 'abcdefghijklmnopqrstuvwxyz0123456789']) {
    assert.equal(redacted.includes(secret), false, `未脱敏：${secret}`);
  }
  assert.ok(redacted.includes('hermes.example.com'));
});

test('buildDiagnosticReport：只含白名单字段，且再次脱敏', () => {
  const report = buildDiagnosticReport({
    clientVersion: '0.1.0',
    generatedAt: 1_700_000_000_000,
    servers: [
      {
        name: '家里 Bearer sk-abcdef1234567890',
        host: 'hermes.example.com',
        mode: 'Runs',
        features: ['Run 提交'],
        lastCheckedAt: 1_700_000_000_000,
        allowHttp: false,
      },
    ],
  });
  assert.ok(report.includes('hermes.example.com'));
  assert.ok(report.includes('Runs'));
  assert.equal(report.includes('sk-abcdef1234567890'), false);
  assert.equal(report.includes('Authorization'), false);
  assert.ok(report.includes('未启用'));
});

test('hostOf：只保留主机名', () => {
  assert.equal(hostOf('https://user:pass@hermes.example.com:8443/p/team'), 'hermes.example.com:8443');
  assert.equal(hostOf('not a url'), '无法解析');
});

test('statusText：已知状态用中文文案，未知状态保留原值', () => {
  assert.equal(statusText('running'), 'Hermes 正在执行…');
  assert.equal(statusText(undefined), '状态未知');
  assert.equal(statusText('weird_upstream_state'), '未知状态：weird_upstream_state');
});

test('运行状态判定：活动态与可停止态', () => {
  assert.equal(isActiveRun('running'), true);
  assert.equal(isActiveRun('completed'), false);
  assert.equal(canStopRun('queued'), true);
  assert.equal(canStopRun('completed'), false);
  assert.equal(canStopRun('unknown'), false);
});

test('能力与模式文案', () => {
  assert.equal(modeLabel('native_runs'), 'Runs');
  assert.equal(modeLabel(undefined), '未检测');
  assert.deepEqual(
    enabledFeatures({ run_submission: true, run_status: false, chat_completions: true }),
    ['Run 提交', 'Chat Completions'],
  );
});

test('时间格式：相对时间在 7 天后回落为日期', () => {
  const now = new Date('2024-05-10T12:00:00Z').getTime();
  assert.equal(formatRelative(now - 30_000, now), '刚刚');
  assert.equal(formatRelative(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(formatRelative(now - 3 * 3_600_000, now), '3 小时前');
  assert.equal(formatRelative(now - 30 * 86_400_000, now), formatDateTime(now - 30 * 86_400_000));
  assert.match(formatTime(now), /^\d{2}:\d{2}$/);
});
