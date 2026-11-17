import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { ServerConnection } from '@/domain/models';
import { enabledFeatures, modeLabel } from '@/features/common/status';
import { hostOf } from '@/features/settings/diagnostics';
import { reportFor } from '@/features/settings/report';
import { useServers } from '@/features/settings/useServers';
import { copyText } from '@/ui/clipboard';
import { ConfirmDialog } from '@/ui/dialogs';
import { formatDateTime } from '@/ui/format';
import {
  Banner,
  Button,
  Caption,
  IconButton,
  ListRow,
  LoadingView,
  Screen,
  ScreenHeader,
  Section,
} from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

const CLIENT_VERSION = Constants.expoConfig?.version ?? '0.1.0';

export default function ServersScreen() {
  const theme = useTheme();
  const router = useRouter();
  const state = useServers();
  const [deleteTarget, setDeleteTarget] = useState<ServerConnection | null>(null);
  const [copied, setCopied] = useState(false);
  const firstFocus = useRef(true);
  const { reload } = state;

  // 编辑页返回后重新读取实例
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void reload();
    }, [reload]),
  );

  const onCopyReport = () => {
    copyText(reportFor(state.servers, CLIENT_VERSION));
    setCopied(true);
  };

  return (
    <Screen>
      <ScreenHeader
        title="实例管理"
        subtitle={`${state.servers.length} 个实例`}
        onBack={() => router.back()}
        actions={
          <IconButton
            name="add"
            accessibilityLabel="添加实例"
            onPress={() => router.push('/(onboarding)/add-server')}
          />
        }
      />

      {state.loading ? (
        <LoadingView label="正在读取实例…" />
      ) : (
        <FlatList
          data={state.servers}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: theme.space.lg, gap: theme.space.md }}
          ListHeaderComponent={
            <View style={{ gap: theme.space.md }}>
              {state.error ? (
                <Banner tone="error" title="操作失败">
                  {state.error}
                </Banner>
              ) : null}
              {state.servers.length === 0 ? (
                <Banner tone="info" title="还没有实例">
                  添加一个 Hermes 实例后即可查看会话与发送消息。
                </Banner>
              ) : null}
            </View>
          }
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.colors.border }} />}
          renderItem={({ item }) => (
            <View style={{ gap: theme.space.xs }}>
              <ListRow
                title={item.name}
                subtitle={`${hostOf(item.baseUrl)} · ${modeLabel(item.capabilities?.mode)}`}
                meta={`最近检测：${item.capabilities?.checkedAt ? formatDateTime(item.capabilities.checkedAt) : '从未检测'}${
                  item.allowHttp ? ' · 明文 HTTP（开发）' : ''
                }`}
                onPress={() =>
                  router.push({ pathname: '/(onboarding)/add-server', params: { serverId: item.id } })
                }
                accessibilityLabel={`实例 ${item.name}`}
                accessibilityHint="点击编辑，右侧按钮可重新检测或删除"
                right={
                  <View style={{ flexDirection: 'row' }}>
                    <IconButton
                      name="pulse-outline"
                      accessibilityLabel={`重新检测 ${item.name}`}
                      onPress={() => void state.recheck(item)}
                      disabled={state.busyServerId === item.id}
                      color={theme.colors.textMuted}
                    />
                    <IconButton
                      name="trash-outline"
                      accessibilityLabel={`删除 ${item.name}`}
                      onPress={() => setDeleteTarget(item)}
                      color={theme.colors.danger}
                    />
                  </View>
                }
              />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs }}>
                {enabledFeatures(item.capabilities?.features).length > 0 ? (
                  enabledFeatures(item.capabilities?.features).map((feature) => (
                    <Text
                      key={feature}
                      style={{
                        color: theme.colors.textMuted,
                        fontSize: theme.font.caption,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                        borderRadius: theme.radius.sm,
                        paddingHorizontal: theme.space.sm,
                        paddingVertical: 2,
                      }}
                    >
                      {feature}
                    </Text>
                  ))
                ) : (
                  <Caption>未探测到可用能力</Caption>
                )}
              </View>
            </View>
          )}
          ListFooterComponent={
            <View style={{ marginTop: theme.space.xl, gap: theme.space.md }}>
              <Section
                title="连接诊断"
                description="诊断只展示脱敏域名、状态、模式、能力与最近检测时间；复制报告前会自动移除 Key、请求体、会话正文与设备标识。"
              >
                <Button
                  label={copied ? '已复制脱敏报告' : '复制脱敏诊断报告'}
                  variant="secondary"
                  icon={copied ? 'checkmark' : 'copy-outline'}
                  onPress={onCopyReport}
                />
                {state.servers.length > 0 ? (
                  <View style={{ gap: theme.space.sm }}>
                    {state.servers.map((server) => (
                      <View key={server.id} style={{ gap: 2 }}>
                        <Text style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>
                          {server.name}
                        </Text>
                        <Caption>
                          {hostOf(server.baseUrl)} · {modeLabel(server.capabilities?.mode)} ·{' '}
                          {server.capabilities?.checkedAt
                            ? formatDateTime(server.capabilities.checkedAt)
                            : '从未检测'}
                        </Caption>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Section>
            </View>
          }
        />
      )}

      <ConfirmDialog
        visible={deleteTarget !== null}
        title="删除实例"
        message={`删除「${deleteTarget?.name ?? ''}」会同时删除系统安全存储中的 API Key 和本地缓存（会话、消息、运行记录）。服务器上的会话不会被删除。`}
        confirmLabel="删除实例"
        destructive
        busy={deleteTarget ? state.busyServerId === deleteTarget.id : false}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void state.remove(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </Screen>
  );
}
