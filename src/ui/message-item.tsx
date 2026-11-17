import { Pressable, Text, View } from 'react-native';
import type { Message } from '@/domain/models';
import { formatTime } from './format';
import { Markdown } from './markdown';
import { useTheme } from './theme';

const ROLE_LABEL: Record<Message['role'], string> = {
  user: '你',
  assistant: 'Hermes',
  system: '系统',
  tool: '工具输出',
};

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
  const header = `${ROLE_LABEL[message.role]}，${formatTime(message.createdAt)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ROLE_LABEL[message.role]}的消息`}
      accessibilityHint="长按可复制或查看详情"
      onLongPress={onLongPress ? () => onLongPress(message) : undefined}
      delayLongPress={400}
      style={({ pressed }) => ({
        minHeight: theme.minTouch,
        justifyContent: 'center',
        paddingVertical: theme.space.sm,
        paddingHorizontal: theme.space.md,
        borderRadius: theme.radius.md,
        backgroundColor: isUser ? theme.colors.surfaceAlt : pressed ? theme.colors.surfaceAlt : 'transparent',
        gap: theme.space.xs,
      })}
    >
      <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>{header}</Text>
      {isPlain ? (
        <Text
          style={{
            fontFamily: theme.fontFamily.mono,
            fontSize: theme.font.code,
            lineHeight: theme.font.code * 1.5,
            color: theme.colors.textMuted,
          }}
        >
          {message.body}
        </Text>
      ) : isUser ? (
        <Text style={{ color: theme.colors.text, fontSize: theme.font.body, lineHeight: theme.font.body * 1.6 }}>
          {message.body}
        </Text>
      ) : (
        <Markdown text={message.body} />
      )}
    </Pressable>
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
      }}
    >
      <Text style={{ color: theme.colors.accent, fontSize: theme.font.caption }}>Hermes，正在输出…</Text>
      <Markdown text={text} />
    </View>
  );
}
