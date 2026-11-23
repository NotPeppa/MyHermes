import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { ToolEvent } from '@/domain/models';
import { copyText } from './clipboard';
import { parseDiff } from './diff';
import { DiffView } from './diff-view';
import { formatTime, hasKnownTime } from './format';
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
  const completed = event.eventType === 'completed';
  const started = event.eventType === 'started';
  const tint = failed
    ? theme.colors.danger
    : completed
      ? theme.colors.success
      : started
        ? theme.colors.accent
        : theme.colors.textMuted;
  const badgeBg = failed
    ? theme.colors.dangerSoft
    : completed
      ? theme.colors.successSoft
      : started
        ? theme.colors.accentSoft
        : theme.colors.surfaceAlt;
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
          gap: theme.space.sm + 2,
          backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
        })}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            backgroundColor: badgeBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={failed ? 'alert-circle-outline' : completed ? 'checkmark-circle-outline' : 'construct-outline'}
            size={17}
            color={tint}
          />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.text,
              fontSize: theme.font.code,
              fontFamily: theme.fontFamily.mono,
              fontWeight: '600',
            }}
          >
            {event.toolName}
          </Text>
          <Text numberOfLines={1} style={{ color: tint, fontSize: theme.font.caption - 1, fontWeight: '600' }}>
            {hasKnownTime(event.recordedAt)
              ? `${toolEventLabel(event.eventType)} · ${formatTime(event.recordedAt)}`
              : toolEventLabel(event.eventType)}
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
