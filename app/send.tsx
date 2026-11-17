/**
 * 外部入口统一落地页：myhermes://send?text=…&server=…&source=clipboard
 *
 * 只负责「选实例 + 选会话 + 把内容交给聊天页」，不自动发送——
 * 外部来源的内容必须先让用户看到并确认，避免深链被用来偷偷派活。
 */
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';
import { normalizeIntentText, peekPendingIntent, setPendingIntent } from '@/features/intents/pending';
import { resolveTarget } from '@/features/intents/send-intent';
import { readActiveServerId } from '@/features/settings/prefs';
import { readClipboardText } from '@/ui/clipboard';
import { Button, LoadingView, Screen, ScreenHeader } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

export default function SendIntentScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { repository } = useAppServices();
  const params = useLocalSearchParams<{ text?: string; server?: string; source?: string }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const fromClipboard = params.source === 'clipboard';
        // 分享进来的内容由根布局写进 pending，这里取出来一起交给聊天页
        const shared = params.source === 'share' ? peekPendingIntent() : null;
        const text = normalizeIntentText(fromClipboard ? await readClipboardText() : shared?.text ?? params.text);
        const activeServerId = await readActiveServerId(repository);
        const { result } = await resolveTarget(repository, { serverId: params.server, activeServerId });
        if (!alive) return;

        if (result.kind === 'no_server') {
          setError('还没有添加任何 Hermes 实例。请先在连接页添加实例，再来使用外部入口。');
          return;
        }
        if (result.kind === 'unknown_server') {
          setError(`找不到实例 ${result.serverId}。请检查深链里的 server 参数，或先在设置里添加该实例。`);
          return;
        }
        if (!text && !shared?.imageUri) {
          setError(fromClipboard ? '剪贴板里没有可用文本。' : '这次外部入口没有带上文本或图片。');
          return;
        }

        setPendingIntent({
          source: fromClipboard ? 'clipboard' : shared ? 'share' : 'deeplink',
          text,
          imageUri: shared?.imageUri,
          serverId: result.serverId,
        });
        router.replace({
          pathname: '/(main)/chat/[serverId]/[sessionId]',
          params: { serverId: result.serverId, sessionId: result.sessionId ?? '' },
        });
      } catch (error_) {
        if (alive) setError(describeError(error_));
      }
    })();
    return () => {
      alive = false;
    };
  }, [params.server, params.source, params.text, repository, router]);

  if (!error) {
    return (
      <Screen>
        <LoadingView label="正在准备外部内容…" />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="外部入口" onBack={() => router.replace('/(main)/sessions')} />
      <View style={{ padding: theme.space.lg, gap: theme.space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}>
          <Ionicons name="alert-circle-outline" size={theme.icon.md} color={theme.colors.warning} />
          <Text style={{ flex: 1, color: theme.colors.text, fontSize: theme.font.body }} accessibilityRole="alert">
            {error}
          </Text>
        </View>
        <Button label="返回会话列表" variant="secondary" onPress={() => router.replace('/(main)/sessions')} />
      </View>
    </Screen>
  );
}
