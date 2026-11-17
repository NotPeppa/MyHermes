import { Text, View } from 'react-native';
import type { Conflict } from '@/features/chat/conflict';
import { Sheet } from './dialogs';
import { formatTime } from './format';
import { Banner, Button, Caption } from './primitives';
import { useTheme } from './theme';

/**
 * 同步冲突对照弹层（设计 §4 P2、§5.3、§14.3）。
 * 上下对照「本地未确认内容」与「服务端最新历史」，让用户显式选择保留哪一边。
 * 只提供同键重试，绝不提供「用新 Key 重新发送」——那会重复执行。
 */
export function ConflictSheet({
  conflict,
  serverAt,
  busy = false,
  error,
  onReload,
  onRetry,
  onDismiss,
}: {
  conflict: Conflict;
  /** 服务端最后一条消息的时间，用于说明「服务端历史有多新」 */
  serverAt?: number;
  busy?: boolean;
  error?: string | null;
  onReload: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const body = {
    color: theme.colors.text,
    fontSize: theme.font.body,
    lineHeight: theme.font.body * 1.6,
  } as const;

  return (
    <Sheet
      visible
      title="同步差异"
      onClose={onDismiss}
      footer={
        <View style={{ gap: theme.space.sm }}>
          <Button
            label="以服务端为准（丢弃本地草稿）"
            variant={conflict.canRetry ? 'secondary' : 'primary'}
            icon="cloud-download-outline"
            busy={busy && !conflict.canRetry}
            onPress={onReload}
            accessibilityHint="丢弃本地未确认的内容，重新读取服务端历史"
          />
          {conflict.canRetry ? (
            <Button
              label="同键重试提交"
              variant="primary"
              icon="refresh-outline"
              busy={busy}
              onPress={onRetry}
              accessibilityHint="沿用原幂等键重试，不会重复执行；过期或冲突时在弹层内显示原因"
            />
          ) : null}
          <Button
            label="稍后处理"
            variant="ghost"
            icon="time-outline"
            onPress={onDismiss}
            accessibilityHint="关闭弹层，顶部保留可重新打开的入口"
          />
        </View>
      }
    >
      <Text style={body}>
        {conflict.reason === 'server_conflict'
          ? '服务端拒绝了这次操作（409），本地和服务端的会话状态不一致。下面是两边的实际内容，请选择保留哪一边。'
          : '上一次提交没有拿到服务端确认，但服务端已经有新的回复，说明任务可能已经执行。下面是两边的实际内容，请选择保留哪一边。'}
      </Text>

      <Banner tone="warn" title="本地未确认内容">
        <View style={{ gap: theme.space.xs }}>
          <Caption>来源：本机草稿 · 尚未被服务端确认</Caption>
          {conflict.local.lastUserText ? (
            <View style={{ gap: 2 }}>
              <Caption>最后一条本地用户消息</Caption>
              <Text selectable style={body}>
                {conflict.local.lastUserText}
              </Text>
            </View>
          ) : null}
          <View style={{ gap: 2 }}>
            <Caption>未确认的正文</Caption>
            <Text selectable style={body}>
              {conflict.local.draft.trim().length > 0 ? conflict.local.draft : '（没有未确认的正文）'}
            </Text>
          </View>
        </View>
      </Banner>

      <Banner tone="info" title="服务端最新历史">
        <View style={{ gap: theme.space.xs }}>
          <Caption>
            来源：服务端 · 共 {conflict.server.messageCount} 条消息
            {serverAt ? ` · 最后一条 ${formatTime(serverAt)}` : ''}
          </Caption>
          {conflict.server.lastUserText ? (
            <View style={{ gap: 2 }}>
              <Caption>最后一条用户消息</Caption>
              <Text selectable style={body}>
                {conflict.server.lastUserText}
              </Text>
            </View>
          ) : null}
          <View style={{ gap: 2 }}>
            <Caption>最后一条助手回复</Caption>
            <Text selectable style={body}>
              {conflict.server.lastAssistantText ?? '（服务端还没有助手回复）'}
            </Text>
          </View>
        </View>
      </Banner>

      {error ? (
        <Banner tone="error" title="操作失败">
          {error}
        </Banner>
      ) : null}

      <Caption>重试沿用原幂等键；不会用新 Key 重新发送，避免任务重复执行。</Caption>
    </Sheet>
  );
}
