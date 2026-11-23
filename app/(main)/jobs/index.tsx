import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import type { Job } from '@/domain/models';
import { useJobs } from '@/features/jobs/useJobs';
import { ConfirmDialog } from '@/ui/dialogs';
import { formatRelative } from '@/ui/format';
import {
  Badge,
  Banner,
  Button,
  Card,
  Divider,
  EmptyState,
  IconButton,
  LoadingView,
  Screen,
  ScreenHeader,
} from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

const labelOf = (job: Job) => job.prompt?.trim() || job.id;

export default function JobsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const jobs = useJobs();
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);

  const header = <ScreenHeader title="任务中心" subtitle={jobs.server?.name} onBack={() => router.back()} />;

  if (jobs.loading) {
    return (
      <Screen>
        {header}
        <LoadingView label="正在读取任务…" />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}

      {jobs.offline ? (
        <View style={{ paddingHorizontal: theme.space.lg, paddingTop: theme.space.md }}>
          <Banner tone="warn" title="连接中断" icon="cloud-offline-outline">
            无法读取服务器上的任务，恢复网络后下拉刷新。
          </Banner>
        </View>
      ) : null}
      {jobs.error ? (
        <View style={{ paddingHorizontal: theme.space.lg, paddingTop: theme.space.md }}>
          <Banner tone="error" title="操作失败" action={<Button label="重试" variant="ghost" onPress={() => void jobs.refresh()} />}>
            {jobs.error}
          </Banner>
        </View>
      ) : null}

      {!jobs.server ? (
        <EmptyState
          icon="server-outline"
          title="还没有实例"
          message="先添加一个 Hermes 实例，才能查看它的定时任务。"
          action={<Button label="添加实例" icon="add" onPress={() => router.push('/(onboarding)/add-server')} />}
        />
      ) : !jobs.canManage ? (
        <EmptyState
          icon="lock-closed-outline"
          title="此服务器未开放 Jobs 管理"
          message="当前实例的能力探测结果里没有 jobs_admin 旗标，因此不显示任务列表。升级 Hermes 或在设置里重新检测连接后再试。"
        />
      ) : (
        <FlatList
          data={jobs.jobs}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: theme.space.lg, gap: theme.space.md, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={jobs.refreshing}
              onRefresh={() => void jobs.refresh()}
              tintColor={theme.colors.accent}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="time-outline"
              title="还没有任务"
              message="这个实例上还没有定时或后台任务。任务需要在 Hermes 服务器上创建。"
            />
          }
          renderItem={({ item }) => {
            const label = labelOf(item);
            const busy = jobs.busyJobId === item.id;
            return (
              <Card style={{ gap: theme.space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.sm }}>
                  <Text
                    numberOfLines={2}
                    style={{ flex: 1, color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600', lineHeight: theme.font.body * 1.45 }}
                  >
                    {label}
                  </Text>
                  <Badge
                    dot
                    tone={item.paused ? 'warn' : 'success'}
                    label={item.paused ? '已暂停' : '启用中'}
                  />
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.sm }}>
                  <Badge mono label={`调度：${item.schedule ?? '未声明'}`} tone="neutral" />
                  <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
                    {`上次运行：${item.lastStatus ?? '未知'}${
                      item.lastRunAt ? ` · ${formatRelative(item.lastRunAt)}` : ''
                    }`}
                  </Text>
                </View>
                <Divider />
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.xs }}>
                  <IconButton
                    name="flash-outline"
                    accessibilityLabel={`立即运行任务 ${label}`}
                    accessibilityHint="让服务器马上执行一次此任务"
                    color={theme.colors.accent}
                    disabled={busy}
                    onPress={() => void jobs.run(item.id)}
                  />
                  <IconButton
                    name={item.paused ? 'play-outline' : 'pause-outline'}
                    accessibilityLabel={item.paused ? `恢复任务 ${label}` : `暂停任务 ${label}`}
                    accessibilityHint={item.paused ? '恢复调度' : '停止按计划执行'}
                    disabled={busy}
                    onPress={() => void jobs.togglePause(item)}
                  />
                  <IconButton
                    name="trash-outline"
                    accessibilityLabel={`删除任务 ${label}`}
                    accessibilityHint="从服务器删除此任务，需二次确认"
                    color={theme.colors.danger}
                    disabled={busy}
                    onPress={() => setDeleteTarget(item)}
                  />
                </View>
              </Card>
            );
          }}
        />
      )}

      <ConfirmDialog
        visible={deleteTarget !== null}
        title="删除任务"
        message={`会调用 Hermes 服务器删除任务「${deleteTarget ? labelOf(deleteTarget) : ''}」。此操作不可撤销，服务器返回失败时任务保持不变。`}
        confirmLabel="删除任务"
        destructive
        busy={jobs.busyJobId !== null}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void jobs.remove(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </Screen>
  );
}
