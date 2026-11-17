import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';
import { reportFor } from '@/features/settings/report';
import { readCacheEnabled, writeCacheEnabled } from '@/features/settings/prefs';
import { copyText } from '@/ui/clipboard';
import { ConfirmDialog } from '@/ui/dialogs';
import { Banner, Button, Caption, ListRow, Screen, ScreenHeader, ScrollScreen, Section, SwitchRow } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

const CLIENT_VERSION = Constants.expoConfig?.version ?? '0.1.0';

const LICENSES: { name: string; license: string }[] = [
  { name: 'MyHermes', license: 'MIT' },
  { name: 'React Native', license: 'MIT' },
  { name: 'Expo / Expo Router', license: 'MIT' },
  { name: 'expo-sqlite', license: 'MIT' },
  { name: 'expo-secure-store', license: 'MIT' },
  { name: '@expo/vector-icons (Ionicons)', license: 'MIT' },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { repository } = useAppServices();
  const [cacheEnabled, setCacheEnabled] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void readCacheEnabled(repository)
      .then((enabled) => {
        if (alive) setCacheEnabled(enabled);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [repository]);

  const clearCache = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const servers = await repository.listServers();
      for (const server of servers) await repository.clearCache(server.id);
      setNotice('本地缓存已清除。');
    } catch (clearError) {
      setError(describeError(clearError));
    } finally {
      setBusy(false);
    }
  }, [repository]);

  const toggleCache = useCallback(
    async (next: boolean) => {
      setCacheEnabled(next);
      setError(null);
      try {
        await writeCacheEnabled(repository, next);
        if (!next) {
          const servers = await repository.listServers();
          for (const server of servers) await repository.clearCache(server.id);
          setNotice('缓存已关闭，并清除了已有本地缓存。');
        } else {
          setNotice('缓存已开启：会话与消息会缓存在本机。');
        }
      } catch (toggleError) {
        setError(describeError(toggleError));
      }
    },
    [repository],
  );

  const copyReport = useCallback(async () => {
    setError(null);
    try {
      const servers = await repository.listServers();
      copyText(reportFor(servers, CLIENT_VERSION));
      setNotice('已复制脱敏诊断报告（不含 Key、请求体、会话正文与设备标识）。');
    } catch (copyError) {
      setError(describeError(copyError));
    }
  }, [repository]);

  return (
    <Screen>
      <ScreenHeader title="设置" onBack={() => router.back()} />
      <ScrollScreen>
        {notice ? (
          <Banner tone="success" title="已完成">
            {notice}
          </Banner>
        ) : null}
        {error ? (
          <Banner tone="error" title="操作失败">
            {error}
          </Banner>
        ) : null}

        <Section title="实例">
          <ListRow
            title="实例管理"
            subtitle="编辑、删除实例；查看连接诊断"
            onPress={() => router.push('/(main)/settings/servers')}
            accessibilityLabel="实例管理"
            right={<Ionicons name="chevron-forward" size={theme.icon.sm} color={theme.colors.textMuted} />}
          />
        </Section>

        <Section title="任务与技能">
          <ListRow
            title="任务中心"
            subtitle="定时与后台任务：立即运行、暂停/恢复、删除"
            onPress={() => router.push('/(main)/jobs')}
            accessibilityLabel="任务中心"
            right={<Ionicons name="chevron-forward" size={theme.icon.sm} color={theme.colors.textMuted} />}
          />
          <ListRow
            title="技能与工具集"
            subtitle="只读查看服务器声明的 Skills 与 Toolsets"
            onPress={() => router.push('/(main)/settings/skills')}
            accessibilityLabel="技能与工具集"
            right={<Ionicons name="chevron-forward" size={theme.icon.sm} color={theme.colors.textMuted} />}
          />
        </Section>

        <Section title="隐私与本地数据">
          <SwitchRow
            label="缓存会话与消息到本机"
            description="开启后先显示本地缓存再刷新；关闭后会立即清除已有缓存，之后只显示服务器最新数据。"
            value={cacheEnabled}
            onValueChange={(next) => void toggleCache(next)}
          />
          <Button
            label="清除本地缓存"
            variant="secondary"
            icon="trash-outline"
            busy={busy}
            onPress={() => setConfirmClear(true)}
          />
          <View
            style={{
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: theme.radius.md,
              padding: theme.space.md,
              gap: theme.space.xs,
            }}
          >
            <Text style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>
              未启用 SQLCipher
            </Text>
            <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body, lineHeight: theme.font.body * 1.5 }}>
              当前构建使用 Expo SQLite 默认配置：本地数据库未启用 SQLCipher
              加密，缓存中的会话正文以明文存放在应用沙盒内。API Key 只写入系统安全存储（SecureStore），
              不进入数据库、日志与诊断报告。
            </Text>
          </View>
          <Caption>
            诊断报告复制前会自动移除 Authorization、请求体、会话正文与设备标识。
          </Caption>
          <Button
            label="复制脱敏诊断报告"
            variant="secondary"
            icon="copy-outline"
            onPress={() => void copyReport()}
          />
        </Section>

        <Section title="关于">
          <ListRow title="MyHermes" subtitle={`版本 ${CLIENT_VERSION}`} />
          <ListRow title="许可证" subtitle="MIT（详见仓库 LICENSE）" />
          <View style={{ gap: theme.space.xs }}>
            <Text style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>
              开源组件
            </Text>
            {LICENSES.map((item) => (
              <View
                key={item.name}
                style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.md }}
              >
                <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body }}>{item.name}</Text>
                <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body }}>{item.license}</Text>
              </View>
            ))}
          </View>
        </Section>
      </ScrollScreen>

      <ConfirmDialog
        visible={confirmClear}
        title="清除本地缓存"
        message="会删除本机缓存的会话、消息、运行记录与工具输出。服务器上的数据不受影响，API Key 也不会被删除。"
        confirmLabel="清除缓存"
        destructive
        busy={busy}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void clearCache();
        }}
      />
    </Screen>
  );
}
