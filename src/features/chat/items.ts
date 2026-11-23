import type { Message, ToolEvent } from '@/domain/models';
import { hasKnownTime } from '@/ui/format';

export type ChatItem =
  | { kind: 'message'; key: string; at: number; message: Message }
  | { kind: 'tool'; key: string; at: number; event: ToolEvent }
  | { kind: 'draft'; key: string; at: number; text: string };

/**
 * 合并消息、工具事件与草稿，按时间升序返回（调用方再 reverse 喂给 inverted 列表）。
 *
 * 两路时间戳不同源：消息来自 messages 接口的 timestamp，工具事件来自事件流。
 * 服务器可能一边给毫秒一边给秒，也可能完全不给时间（适配层用 0、1、2… 占位）。
 * 直接比较会让秒级事件排到所有消息之前——表现就是工具卡片孤零零顶在对话最上端。
 * 所以：不可信时间一律视为「最后」，同一时刻消息在前、卡片紧随其后。
 *
 * showTools 关闭时同时隐藏两路工具痕迹：工具事件卡片，以及 role 为 tool/system 的
 * 工具输出消息。对话正文（user/assistant）不受影响。
 */
export function buildChatItems(
  messages: Message[],
  tools: ToolEvent[],
  draft: string,
  options: { showTools?: boolean } = {},
): ChatItem[] {
  const { showTools = true } = options;
  const visible = showTools
    ? messages
    : messages.filter((message) => message.role !== 'tool' && message.role !== 'system');
  const merged: ChatItem[] = visible.map((message) => ({
    kind: 'message',
    key: `m-${message.id}`,
    at: message.createdAt,
    message,
  }));
  if (showTools) {
    for (const event of tools) {
      merged.push({ kind: 'tool', key: `t-${event.id}`, at: event.recordedAt, event });
    }
  }

  // 缺时间戳的工具事件放在最后（避免被顶到顶部）；
  // 缺时间戳的历史消息本身按服务端序号 0, 1, 2… 排列，保留其相对顺序且早于新发出的真实时间戳消息。
  const sortable = (item: ChatItem): number => {
    if (hasKnownTime(item.at)) return item.at;
    return item.kind === 'message' ? item.at : Number.MAX_SAFE_INTEGER;
  };

  merged.sort((a, b) => {
    const at = sortable(a);
    const bt = sortable(b);
    if (at !== bt) return at - bt;
    if (a.kind !== b.kind) return a.kind === 'message' ? -1 : 1;
    return 0;
  });

  if (draft.length > 0) {
    merged.push({ kind: 'draft', key: 'draft', at: Number.MAX_SAFE_INTEGER, text: draft });
  }
  return merged;
}
