import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { useAppServices } from '@/composition';
import { describeError } from '@/features/common/errors';
import { usePushBridge } from '@/features/notifications/usePushBridge';
import { reportFor } from '@/features/settings/report';
import { readCacheEnabled, readShowToolCalls, readThemePreference, writeCacheEnabled, writeShowToolCalls, writeThemePreference } from '@/features/settings/prefs';
import { copyText } from '@/ui/clipboard';
import { ConfirmDialog } from '@/ui/dialogs';
import {
  Badge,
  Banner,
  Button,
  Caption,
  Divider,
  ListRow,
  Screen,
  ScreenHeader,
  ScrollScreen,
  Section,
  SegmentedControl,
  SwitchRow,
  TextField,
  type BadgeTone,
} from '@/ui/primitives';
import { appIcon } from '@/ui/logo';
import { useTheme, useThemePreference, type ThemePreference } from '@/ui/theme';

const CLIENT_VERSION = Constants.expoConfig?.version ?? '0.1.0';

const THEME_OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'system', label: '跟随系统', hint: '随手机深色模式自动切换' },
  { value: 'light', label: '浅色', hint: '始终使用浅色主题' },
  { value: 'dark', label: '深色', hint: '始终使用深色主题' },
];

const LICENSES: { name: string; license: string }[] = [
  { name: 'MyHermes', license: 'MIT' },
  { name: 'React Native', license: 'MIT' },
  { name: 'Expo / Expo Router', license: 'MIT' },
  { name: 'expo-sqlite', license: 'MIT' },
  { name: 'expo-secure-store', license: 'MIT' },
  { name: '@expo/vector-icons (Ionicons)', license: 'MIT' },
];

/** 状态行只有四种说法，避免把内部状态名暴露给用户。 */
function pushStatusLine(enabled: boolean, bridgeUrl: string, status: string, error: string | null): string {
  if (!enabled || !bridgeUrl.trim()) return '未启用';
  if (status === 'connected') return '已连接';
  if (status === 'error') return `连接失败：${error ?? '原因未知'}`;
  return '连接中';
}

function pushStatusTone(enabled: boolean, bridgeUrl: string, status: string): BadgeTone {
  if (!enabled || !bridgeUrl.trim()) return 'neutral';
  if (status === 'connected') return 'success';
  if (status === 'error') return 'danger';
  return 'warn';
}

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { repository, service } = useAppServices();
  const { preference: themePreference, setPreference: applyThemePreference } = useThemePreference();
  const push = usePushBridge();
  const [cacheEnabled, setCacheEnabled] = useState(true);
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 地址输入用本地草稿：失焦才提交，避免每敲一个字就重连一次
  const [bridgeDraft, setBridgeDraft] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    setBridgeDraft(push.bridgeUrl);
  }, [push.bridgeUrl]);

  // 启动时把已保存的外观偏好灌进主题 store（Provider 在 AppServicesProvider 之外，读不到 repository）
  useEffect(() => {
    let alive = true;
    void readThemePreference(repository)
      .then((stored) => {
        if (alive) applyThemePreference(stored);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [applyThemePreference, repository]);

  const chooseTheme = useCallback(
    async (next: ThemePreference) => {
      applyThemePreference(next);
      try {
        await writeThemePreference(repository, next);
      } catch (themeError) {
        setError(describeError(themeError));
      }
    },
    [applyThemePreference, repository],
  );

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

  useEffect(() => {
    let alive = true;
    void readShowToolCalls(repository)
      .then((enabled) => {
        if (alive) setShowToolCalls(enabled);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [repository]);

  const toggleShowToolCalls = useCallback(
    async (next: boolean) => {
      setShowToolCalls(next);
      setError(null);
      try {
        await writeShowToolCalls(repository, next);
      } catch (toggleError) {
        // 写失败就退回原值，避免开关显示与实际行为不一致
        setShowToolCalls(!next);
        setError(describeError(toggleError));
      }
    },
    [repository],
  );

  const clearCache = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const servers = await repository.listServers();
      for (const server of servers) await repository.clearCache(server.id);
      service.clearMemoryCache();
      setNotice('本地缓存已清除。');
    } catch (clearError) {
      setError(describeError(clearError));
    } finally {
      setBusy(false);
    }
  }, [repository, service]);

  const toggleCache = useCallback(
    async (next: boolean) => {
      setCacheEnabled(next);
      setError(null);
      try {
        await writeCacheEnabled(repository, next);
        if (!next) {
          const servers = await repository.listServers();
          for (const server of servers) await repository.clearCache(server.id);
          service.clearMemoryCache();
          setNotice('缓存已关闭，并清除了已有本地缓存。');
        } else {
          setNotice('缓存已开启：会话与消息会缓存在本机。');
        }
      } catch (toggleError) {
        setCacheEnabled(!next);
        setError(describeError(toggleError));
      }
    },
    [repository, service],
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

        <Section title="外观">
          <SegmentedControl
            options={THEME_OPTIONS}
            value={themePreference}
            onChange={(next) => void chooseTheme(next)}
            accessibilityPrefix="外观"
          />
          <Caption>跟随系统时会随手机的深色模式自动切换；强制选项只影响本应用。</Caption>
        </Section>

        <Section title="会话">
          <SwitchRow
            label="显示工具调用"
            description="在会话里显示每步工具调用与工具输出（工具名、状态、返回内容）。关闭后只保留你和模型的对话正文，工具事件仍会记录，重新打开即可查看。"
            value={showToolCalls}
            onValueChange={(next) => void toggleShowToolCalls(next)}
          />
        </Section>

        <Section title="通知">
          <SwitchRow
            label="启用推送通知"
            description="App 在后台或锁屏时，通过你自己部署的推送桥接收任务完成提醒。"
            value={push.enabled}
            onValueChange={push.setEnabled}
          />
          <Divider />
          <TextField
            label="推送桥地址"
            value={bridgeDraft}
            onChangeText={setBridgeDraft}
            onBlur={() => push.setBridgeUrl(bridgeDraft)}
            placeholder="https://bridge.example.com"
            keyboardType="url"
            autoComplete="url"
            textContentType="URL"
            helper="填自托管桥的 HTTPS 地址；WebSocket 密钥走 query，必须走 TLS。"
            accessibilityHint="例如 https://bridge.example.com"
          />
          <View
            accessible
            accessibilityLabel={`推送状态：${pushStatusLine(push.enabled, push.bridgeUrl, push.status, push.error)}`}
            accessibilityLiveRegion="polite"
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm }}
          >
            <Badge
              dot
              tone={pushStatusTone(push.enabled, push.bridgeUrl, push.status)}
              label={`状态：${pushStatusLine(push.enabled, push.bridgeUrl, push.status, push.error)}`}
            />
          </View>
          <Button
            label="测试连接"
            variant="secondary"
            icon="pulse-outline"
            busy={testing}
            onPress={() => {
              setTesting(true);
              setTestResult(null);
              void push.testConnection(bridgeDraft).then((result) => {
                setTestResult(result);
                setTesting(false);
              });
            }}
            accessibilityLabel="测试推送桥连接"
            accessibilityHint="请求桥的 /health，确认地址与网络可达"
          />
          {testResult ? <Caption>{testResult}</Caption> : null}
          <Caption>通知只包含实例、会话与状态；正文需要点开 App 查看。桥由你自己部署。</Caption>
        </Section>

        <Section title="实例">
          <ListRow
            leading={
              <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: theme.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="server-outline" size={17} color={theme.colors.text} />
              </View>
            }
            title="实例管理"
            subtitle="编辑、删除实例；查看连接诊断"
            onPress={() => router.push('/(main)/settings/servers')}
            accessibilityLabel="实例管理"
            right={<Ionicons name="chevron-forward" size={theme.icon.sm} color={theme.colors.textMuted} />}
          />
        </Section>

        <Section title="任务与技能">
          <ListRow
            leading={
              <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: theme.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="time-outline" size={17} color={theme.colors.text} />
              </View>
            }
            title="任务中心"
            subtitle="定时与后台任务：立即运行、暂停/恢复、删除"
            onPress={() => router.push('/(main)/jobs')}
            accessibilityLabel="任务中心"
            right={<Ionicons name="chevron-forward" size={theme.icon.sm} color={theme.colors.textMuted} />}
          />
          <Divider />
          <ListRow
            leading={
              <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: theme.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="construct-outline" size={17} color={theme.colors.text} />
              </View>
            }
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
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceAlt,
              padding: theme.space.md,
              gap: theme.space.xs,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xs + 2 }}>
              <Ionicons name="shield-checkmark-outline" size={17} color={theme.colors.textMuted} />
              <Text style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>
                未启用 SQLCipher
              </Text>
            </View>
            <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption, lineHeight: theme.font.caption * 1.55 }}>
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
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.md }}>
            {appIcon === null ? null : (
              <Image
                source={appIcon}
                accessibilityLabel="MyHermes 应用图标"
                style={{ width: 52, height: 52, borderRadius: theme.radius.md }}
              />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '700' }}>MyHermes</Text>
              <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
                {`版本 ${CLIENT_VERSION} · Hermes Agent 移动客户端 · MIT`}
              </Text>
            </View>
          </View>
          <Divider />
          <View style={{ gap: theme.space.xs }}>
            <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption, fontWeight: '700' }}>
              开源组件
            </Text>
            {LICENSES.map((item) => (
              <View
                key={item.name}
                style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.md }}
              >
                <Text style={{ color: theme.colors.text, fontSize: theme.font.caption }}>{item.name}</Text>
                <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>{item.license}</Text>
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
