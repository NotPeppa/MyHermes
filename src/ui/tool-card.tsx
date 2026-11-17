import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { ToolEvent } from '@/domain/models';
import { copyText } from './clipboard';
import { parseDiff } from './diff';
import { DiffView } from './diff-view';
import { formatTime } from './format';
import { useTheme } from './theme';

const EVENT_LABEL: Record<string, string> = {
  started: '开始执行',
  completed: '执行完成',
  failed: '执行失败',
};

export function toolEventLabel(eventType: string): string {
  return EVENT_LABEL[eventType] ?? `未知事件：${eventType}`;
}

export function ToolCard({ event }: { event: ToolEvent }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  // P2：识别统一 diff 就结构化渲染，识别失败保持纯文本（服务端契约不变）
  const diff = useMemo(() => (event.preview ? parseDiff(event.preview) : null), [event.preview]);
  const failed = event.eventType === 'failed';
  const tint = failed ? theme.colors.danger : theme.colors.textMuted;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surface,
        marginHorizontal: theme.space.md,
        marginVertical: theme.space.xs,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`工具 ${event.toolName}，${toolEventLabel(event.eventType)}`}
        accessibilityHint={expanded ? '收起工具详情' : '展开工具详情'}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({
          minHeight: theme.minTouch,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.sm,
          backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
        })}
      >
        <Ionicons
          name={failed ? 'alert-circle-outline' : 'construct-outline'}
          size={theme.icon.sm}
          color={tint}
        />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>
            {event.toolName}
          </Text>
          <Text numberOfLines={1} style={{ color: tint, fontSize: theme.font.caption }}>
            {toolEventLabel(event.eventType)} · {formatTime(event.recordedAt)}
          </Text>
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={theme.icon.sm}
          color={theme.colors.textMuted}
        />
      </Pressable>
      {expanded ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: theme.space.md }}>
            <Text style={{ flex: 1, color: theme.colors.textMuted, fontSize: theme.font.caption }}>
              输出预览（可能含敏感内容）
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="复制工具输出"
              onPress={() => copyText(event.preview ?? '')}
              style={({ pressed }) => ({
                width: theme.minTouch,
                height: theme.minTouch,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
              })}
            >
              <Ionicons name="copy-outline" size={theme.icon.sm} color={theme.colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: theme.space.md, paddingTop: 0 }}>
            {diff ? (
              <DiffView files={diff} />
            ) : (
              <Text
                selectable
                style={{
                  fontFamily: theme.fontFamily.mono,
                  fontSize: theme.font.code,
                  lineHeight: theme.font.code * 1.5,
                  color: theme.colors.textMuted,
                }}
              >
                {event.preview ?? '无输出预览'}
              </Text>
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
