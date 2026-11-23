import { Ionicons } from '@expo/vector-icons';
import { useCanGoBack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Text, View } from 'react-native';
import { useAppServices } from '@/composition';
import type { ServerConnection } from '@/domain/models';
import { useAddServer, type DiagnosticStage } from '@/features/onboarding/useAddServer';
import { modeLabel } from '@/features/common/status';
import { appIcon } from '@/ui/logo';
import {
  Badge,
  Banner,
  Button,
  Caption,
  Divider,
  IconButton,
  LoadingView,
  Screen,
  ScreenHeader,
  ScrollScreen,
  Section,
  SwitchRow,
  TextField,
} from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

export default function AddServerScreen() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { repository } = useAppServices();
  const params = useLocalSearchParams<{ serverId?: string }>();
  const [existing, setExisting] = useState<ServerConnection | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(!!params.serverId);

  useEffect(() => {
    if (!params.serverId) return;
    let alive = true;
    repository
      .listServers()
      .then((servers) => {
        if (alive) setExisting(servers.find((server) => server.id === params.serverId) ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoadingExisting(false);
      });
    return () => {
      alive = false;
    };
  }, [params.serverId, repository]);

  const close = () => {
    if (canGoBack) router.back();
    else router.replace('/(main)/sessions');
  };

  if (loadingExisting) {
    return (
      <Screen>
        <LoadingView label="正在读取实例…" />
      </Screen>
    );
  }

  return <AddServerForm existing={existing} onClose={close} editing={!!params.serverId} />;
}

function AddServerForm({
  existing,
  editing,
  onClose,
}: {
  existing: ServerConnection | null;
  editing: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const state = useAddServer(existing);
  const [advanced, setAdvanced] = useState(false);

  const onSave = async () => {
    const server = await state.save();
    if (!server) return;
    if (editing) onClose();
    else router.replace('/(main)/sessions');
  };

  return (
    <Screen>
      <ScreenHeader
        title={editing ? '编辑连接' : '添加连接'}
        subtitle={editing ? existing?.name : 'Hermes 实例'}
        onBack={onClose}
      />
      <ScrollScreen>
        {!editing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.md, paddingHorizontal: theme.space.xs }}>
            {appIcon === null ? null : (
              <Image
                source={appIcon}
                accessibilityLabel="MyHermes 应用图标"
                style={{ width: 48, height: 48, borderRadius: theme.radius.md }}
              />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: theme.colors.text, fontSize: theme.font.title - 1, fontWeight: '700' }}>
                连接到你的 Hermes
              </Text>
              <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
                填入实例地址与 API Key，四步诊断通过后自动保存。
              </Text>
            </View>
          </View>
        ) : null}

        <Section title="连接信息">
          <TextField
            label="连接名称"
            value={state.name}
            onChangeText={state.setName}
            placeholder="例如：家里服务器"
            autoCapitalize="sentences"
            helper="留空则自动使用域名作为名称"
            maxLength={60}
          />
          <TextField
            label="服务器 URL"
            value={state.url}
            onChangeText={state.setUrl}
            placeholder="https://hermes.example.com"
            keyboardType="url"
            autoComplete="url"
            textContentType="URL"
            helper="只允许 HTTPS；地址中不得包含账号、密码、查询参数或片段"
          />
          <TextField
            label="API Key"
            value={state.apiKey}
            onChangeText={state.setApiKey}
            placeholder="粘贴 Hermes API Key"
            secure={!state.showKey}
            autoComplete="off"
            helper="Key 只写入系统安全存储，不进入日志、缓存与诊断报告"
            trailing={
              <IconButton
                name={state.showKey ? 'eye-off-outline' : 'eye-outline'}
                accessibilityLabel={state.showKey ? '隐藏 API Key' : '显示 API Key'}
                onPress={state.toggleKey}
                color={theme.colors.textMuted}
              />
            }
          />
        </Section>

        <Section title="高级">
          <Button
            label={advanced ? '收起高级选项' : '展开高级选项'}
            variant="secondary"
            icon={advanced ? 'chevron-up' : 'chevron-down'}
            onPress={() => setAdvanced((value) => !value)}
          />
          {advanced ? (
            <View style={{ gap: theme.space.lg }}>
              <TextField
                label="Profile 路径（可选）"
                value={state.profilePath}
                onChangeText={state.setProfilePath}
                placeholder="p/team"
                helper="会作为服务器地址的路径前缀，例如 https://host/p/team"
              />
              {__DEV__ ? (
                <View style={{ gap: theme.space.sm }}>
                  <SwitchRow
                    label="允许私网明文 HTTP（高风险）"
                    description="仅开发构建可用。开启后 API Key 会以明文经过网络，可能被同一网络内的他人截获。"
                    value={state.allowHttp}
                    onValueChange={state.setAllowHttp}
                  />
                  {state.allowHttp ? (
                    <Banner tone="warn" title="已允许明文 HTTP">
                      仅对 localhost 或私网地址生效，且只在当前开发构建中可用；正式使用请改用 HTTPS。
                    </Banner>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}
        </Section>

        <Section title="连接诊断" description="按 URL 与 TLS、能力探测、鉴权、可用 API 四层逐项检查；失败不会保存任何成功状态。">
          <View style={{ gap: theme.space.sm }}>
            {state.stages.map((stage, index) => (
              <View key={stage.id} style={{ gap: theme.space.sm }}>
                {index > 0 ? <Divider /> : null}
                <StageRow stage={stage} />
              </View>
            ))}
          </View>
          {state.stale ? (
            <Banner tone="warn" title="参数已修改">
              连接参数在上次诊断后发生了变化，保存前会自动重新诊断。
            </Banner>
          ) : null}
          {state.latencyMs !== null ? <Caption>探测耗时 {state.latencyMs} ms</Caption> : null}
          {state.capabilities ? (
            <Caption>
              模式 {modeLabel(state.capabilities.mode)} · 检测于{' '}
              {new Date(state.capabilities.checkedAt).toLocaleString()}
            </Caption>
          ) : null}
          <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
            <Button
              label={state.capabilities ? '重新诊断' : '开始诊断'}
              variant="secondary"
              icon="pulse-outline"
              busy={state.probing}
              onPress={() => void state.probe()}
              style={{ flex: 1 }}
            />
            {state.probing ? (
              <Button label="取消" variant="ghost" onPress={state.cancel} style={{ flex: 1 }} />
            ) : null}
          </View>
        </Section>

        {state.error ? (
          <Banner tone="error" title="连接未通过">
            {state.error}
          </Banner>
        ) : null}

        <View style={{ gap: theme.space.sm }}>
          <Button
            label={editing ? '保存修改' : '保存连接'}
            icon="checkmark"
            busy={state.saving}
            disabled={!state.canSubmit}
            onPress={() => void onSave()}
            accessibilityHint="先完成诊断再保存；诊断未通过时不会保存"
          />
          <Button label="取消" variant="secondary" onPress={onClose} />
        </View>
      </ScrollScreen>
    </Screen>
  );
}

const STAGE_STATUS_LABEL: Record<DiagnosticStage['status'], string> = {
  pending: '待检测',
  running: '检测中',
  ok: '通过',
  fail: '失败',
  skipped: '未执行',
};

function StageRow({ stage }: { stage: DiagnosticStage }) {
  const theme = useTheme();
  const tint =
    stage.status === 'ok'
      ? theme.colors.success
      : stage.status === 'fail'
        ? theme.colors.danger
        : stage.status === 'running'
          ? theme.colors.accent
          : theme.colors.textMuted;
  const badgeTone =
    stage.status === 'ok'
      ? 'success'
      : stage.status === 'fail'
        ? 'danger'
        : stage.status === 'running'
          ? 'accent'
          : 'neutral';
  return (
    <View
      accessible
      accessibilityLabel={`${stage.label}，${STAGE_STATUS_LABEL[stage.status]}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}
    >
      <View style={{ width: theme.icon.md, height: theme.icon.md, alignItems: 'center', justifyContent: 'center' }}>
        {stage.status === 'running' ? (
          <ActivityIndicator size="small" color={theme.colors.accent} />
        ) : (
          <Ionicons
            name={
              stage.status === 'ok'
                ? 'checkmark-circle'
                : stage.status === 'fail'
                  ? 'close-circle'
                  : 'ellipse-outline'
            }
            size={theme.icon.md}
            color={tint}
          />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '500' }}>{stage.label}</Text>
        {stage.detail ? (
          <Text style={{ color: tint, fontSize: theme.font.caption, lineHeight: theme.font.caption * 1.45 }}>
            {stage.detail}
          </Text>
        ) : null}
      </View>
      <Badge label={STAGE_STATUS_LABEL[stage.status]} tone={badgeTone} />
    </View>
  );
}
