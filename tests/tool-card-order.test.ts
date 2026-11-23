/**
 * 回归：工具卡片不能因为时间戳单位不一致而被顶到对话最上端。
 *
 * 故障现场：web_extract 卡片孤零零显示在整段对话最顶部（「执行完成 · 02:37」），
 * 下面才是正常排列的工具输出气泡。
 * 根因：消息用 messages 接口的 timestamp（毫秒），工具事件用事件流的 timestamp；
 * 服务器发秒级时两者差 1000 倍，工具事件排到所有消息之前，倒序渲染后就成了置顶卡片。
 *
 * 运行：npx tsx --test tests/tool-card-order.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatItems } from '../src/features/chat/items';
import { eventTimestamp } from '../src/adapters/hermes/events';
import type { Message, ToolEvent } from '../src/domain/models';

/** 2026-11-19 15:22 的毫秒时间戳，用真实量级避免和占位序号混淆。 */
const T0 = 1_763_532_120_000;

const messages: Message[] = [
  { id: 'm1', serverId: 'srv-1', sessionId: 'sess-1', role: 'user', body: '自部署的 flash 有搜索能力吗', createdAt: T0 },
  { id: 'm2', serverId: 'srv-1', sessionId: 'sess-1', role: 'assistant', body: '可以接，但只自部署', createdAt: T0 + 60_000 },
];

function tool(recordedAt: number): ToolEvent {
  return {
    id: 'tool-1',
    serverId: 'srv-1',
    runId: 'local-1',
    toolName: 'web_extract',
    eventType: 'completed',
    preview: '<untrusted_tool_result source="web_extract">',
    recordedAt,
  };
}

/** 升序结果里工具卡片的索引。 */
function toolIndex(items: ReturnType<typeof buildChatItems>): number {
  const index = items.findIndex((item) => item.kind === 'tool');
  assert.ok(index >= 0, '工具卡片应存在于列表中');
  return index;
}

test('eventTimestamp 把秒级时间戳换算成毫秒', () => {
  assert.equal(eventTimestamp(T0 / 1000), T0);
  assert.equal(eventTimestamp(T0), T0);
  assert.equal(eventTimestamp('1763532120'), T0);
  // 缺失/非法时退回当前时间，而不是 0（0 会被排到最前面）
  assert.ok(eventTimestamp(undefined) > 1e11);
  assert.ok(eventTimestamp(0) > 1e11);
  assert.ok(eventTimestamp('not-a-date') > 1e11);
});

test('秒级工具事件不会被顶到对话最上端', () => {
  // 服务器发秒级时间戳，实际发生在最后一条消息之后
  const items = buildChatItems(messages, [tool(T0 / 1000 + 90)], '');
  const index = toolIndex(items);
  assert.equal(index, items.length - 1, '工具卡片应排在最后一条消息之后');
});

test('秒级时间戳未归一化时会暴露为置顶卡片', () => {
  // 不复现修复、直接按原始秒级值排序，卡片会被甩到最前面——这正是线上看到的现象
  const raw = [T0, T0 + 60_000, T0 / 1000 + 90];
  const sorted = [...raw].sort((a, b) => a - b);
  assert.equal(sorted[0], T0 / 1000 + 90, '未归一化的秒级值确实排在最前');
});

test('缺少可信时间戳的工具事件也留在消息之后', () => {
  const items = buildChatItems(messages, [tool(0)], '');
  assert.equal(toolIndex(items), items.length - 1);
});

test('工具事件确实更早时仍按时间排到前面', () => {
  const items = buildChatItems(messages, [tool(T0 - 30_000)], '');
  assert.equal(toolIndex(items), 0);
});

test('同一时刻消息在前、工具卡片紧随其后', () => {
  const items = buildChatItems(messages, [tool(T0)], '');
  const toolAt = toolIndex(items);
  const messageAt = items.findIndex((item) => item.kind === 'message' && item.message.id === 'm1');
  assert.ok(toolAt > messageAt, '同时刻卡片不应插到该条消息上方');
});

test('草稿永远排在最后', () => {
  const items = buildChatItems(messages, [tool(T0 / 1000 + 90)], '正在输出');
  const draft = items.at(-1);
  assert.equal(draft?.kind, 'draft');
});

test('草稿为空时不插入草稿行', () => {
  const items = buildChatItems(messages, [], '');
  assert.ok(items.every((item) => item.kind !== 'draft'));
});

// ── 设置开关：显示工具调用 ────────────────────────────────────────────────

test('showTools=false 时不产出工具卡片，且不影响消息顺序', () => {
  const items = buildChatItems(messages, [tool(T0 / 1000 + 90)], '', { showTools: false });
  assert.ok(items.every((item) => item.kind !== 'tool'), '关闭后不应有工具卡片');
  assert.deepEqual(
    items.map((item) => item.kind),
    ['message', 'message'],
    '消息保持原顺序',
  );
});

test('showTools 默认开启', () => {
  const items = buildChatItems(messages, [tool(T0 + 90_000)], '');
  assert.ok(items.some((item) => item.kind === 'tool'));
});

test('关闭开关后草稿仍然存在', () => {
  const items = buildChatItems(messages, [tool(T0)], '输出中', { showTools: false });
  assert.equal(items.at(-1)?.kind, 'draft');
});

/** 工具输出消息（role=tool）与系统消息（role=system）。 */
const toolOutputMessages: Message[] = [
  ...messages,
  { id: 'o1', serverId: 'srv-1', sessionId: 'sess-1', role: 'tool', body: '<untrusted_tool_result source="web_extract">', createdAt: T0 + 30_000 },
  { id: 'o2', serverId: 'srv-1', sessionId: 'sess-1', role: 'system', body: '{"status":"ok"}', createdAt: T0 + 40_000 },
];

test('关闭开关时连工具输出消息一起隐藏', () => {
  const items = buildChatItems(toolOutputMessages, [tool(T0 + 90_000)], '', { showTools: false });
  assert.ok(
    items.every((item) => item.kind === 'message' && item.message.role !== 'tool' && item.message.role !== 'system'),
    '工具输出与系统消息都应被隐藏',
  );
  assert.deepEqual(
    items.map((item) => (item.kind === 'message' ? item.message.role : item.kind)),
    ['user', 'assistant'],
    '只保留对话正文',
  );
});

test('开启开关时工具输出消息正常显示', () => {
  const items = buildChatItems(toolOutputMessages, [tool(T0 + 90_000)], '', { showTools: true });
  const roles = items.filter((item) => item.kind === 'message').map((item) => item.message.role);
  // 顺序由时间戳决定（m2 在 T0+60s，晚于两条工具输出），这里只校验集合
  assert.deepEqual([...roles].sort(), ['assistant', 'system', 'tool', 'user']);
  assert.ok(items.some((item) => item.kind === 'tool'));
});
