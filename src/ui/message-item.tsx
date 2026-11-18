import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Message } from '@/domain/models';
import { formatTime, hasKnownTime } from './format';
import { Markdown } from './markdown';
import { useTheme } from './theme';

/** 工具输出默认只显示一行摘要，展开后最多渲染这么多行，避免一条结果铺满整屏。 */
const TOOL_PREVIEW_CHARS = 120;
const TOOL_MAX_LINES = 40;

const ROLE_LABEL: Record<Message['role'], string> = {
  user: '你',
  assistant: 'Hermes',
  system: '系统',
  tool: '工具输出',
};

/**
 * 工具输出/系统消息：默认折叠成一行摘要。
 * Hermes 的 tool 消息常常是整段 JSON 或网页正文，直接铺开会把对话淹没。
 */
function CollapsibleOutput({
  message,
  header,
  tone,
  onLongPress,
}: {
  message: Message;
  header: string;
  tone: 'tool' | 'system';
  onLongPress?: (message: Message) => void;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const lines = message.body.split('\n');
  const preview = (lines[0] ?? '').slice(0, TOOL_PREVIEW_CHARS);
  const shown = expanded ? lines.slice(0, TOOL_MAX_LINES).join('\n') : preview;
  const truncated = lines.length > TOOL_MAX_LINES;
  const bodyStyle = {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.font.code,
    lineHeight: theme.font.code * 1.5,
    color: theme.colors.textMuted,
  } as const;

  return (
    <View style={{ paddingVertical: theme.space.sm, paddingHorizontal: theme.space.md }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${ROLE_LABEL[tone]}，${expanded ? '已展开' : '已折叠'}`}
        accessibilityHint={expanded ? '点击收起' : '点击展开完整内容'}
        onPress={() => setExpanded((value) => !value)}
        onLongPress={onLongPress ? () => onLongPress(message) : undefined}
        delayLongPress={400}
        style={({ pressed }) => ({
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.md,
          backgroundColor: pressed ? theme.colors.surfaceAlt : theme.colors.surface,
          padding: theme.space.md,
          gap: theme.space.xs,
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}>
          <Text style={{ flex: 1, color: theme.colors.textMuted, fontSize: theme.font.caption }}>{header}</Text>
          <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
            {expanded ? '收起' : `展开 · ${lines.length} 行`}
          </Text>
        </View>
        <Text numberOfLines={expanded ? undefined : 1} style={bodyStyle}>
          {shown}
        </Text>
        {expanded && truncated ? (
          <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
            {`已截断，共 ${lines.length} 行`}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

/**
 * 消息行：用户消息靠右带气泡，Hermes 消息靠左无气泡（靠留白区分）。
 * 服务器没给时间戳时不显示时间，避免把占位序号渲染成 1970-01-01 08:00。
 */
export function MessageItem({
  message,
  onLongPress,
}: {
  message: Message;
  onLongPress?: (message: Message) => void;
}) {
  const theme = useTheme();
  const isUser = message.role === 'user';
  const isPlain = message.role === 'system' || message.role === 'tool';
  const header = hasKnownTime(message.createdAt)
    ? `${ROLE_LABEL[message.role]}，${formatTime(message.createdAt)}`
    : ROLE_LABEL[message.role];

  if (isPlain) {
    return (
      <CollapsibleOutput
        message={message}
        header={header}
        tone={message.role === 'tool' ? 'tool' : 'system'}
        onLongPress={onLongPress}
      />
    );
  }

  const body = isUser ? (
    <Text
      style={{
        color: theme.colors.text,
        fontSize: theme.font.body,
        lineHeight: theme.font.body * 1.6,
        textAlign: 'right',
      }}
    >
      {message.body}
    </Text>
  ) : (
    <Markdown text={message.body} />
  );

  return (
    <View
      style={{
        paddingVertical: theme.space.sm,
        paddingHorizontal: theme.space.md,
        alignItems: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${ROLE_LABEL[message.role]}的消息`}
        accessibilityHint="长按可复制或查看详情"
        onLongPress={onLongPress ? () => onLongPress(message) : undefined}
        delayLongPress={400}
        style={({ pressed }) => ({
          minHeight: theme.minTouch,
          justifyContent: 'center',
          gap: theme.space.xs,
          maxWidth: isUser ? '88%' : '100%',
          paddingVertical: theme.space.sm,
          paddingHorizontal: 0,
          borderRadius: theme.radius.md,
          // 用户消息不加气泡底色，只靠右对齐区分；按下时给一点反馈
          backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
        })}
      >
        <Text
          style={{
            color: theme.colors.textMuted,
            fontSize: theme.font.caption,
            textAlign: isUser ? 'right' : 'left',
          }}
        >
          {header}
        </Text>
        {body}
      </Pressable>
    </View>
  );
}

export function DraftMessage({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel="Hermes 正在输出"
      style={{
        paddingVertical: theme.space.sm,
        paddingHorizontal: theme.space.md,
        gap: theme.space.xs,
        alignItems: 'flex-start',
      }}
    >
      <Text style={{ color: theme.colors.accent, fontSize: theme.font.caption }}>Hermes，正在输出…</Text>
      <Markdown text={text} />
    </View>
  );
}
