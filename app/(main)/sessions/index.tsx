import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';
import type { Session } from '@/domain/models';
import { useSessions } from '@/features/sessions/useSessions';
import { ActionSheet, ConfirmDialog, Sheet } from '@/ui/dialogs';
import { formatRelative } from '@/ui/format';
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  IconButton,
  ListRow,
  LoadingView,
  Screen,
  ScreenHeader,
  TextField,
} from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

export default function SessionsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const sessions = useSessions();
  const [menuTarget, setMenuTarget] = useState<Session | null>(null);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [renameText, setRenameText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ session: Session; mode: 'local' | 'server' } | null>(null);
  const [creating, setCreating] = useState(false);
  const firstFocus = useRef(true);
  const { refresh: refreshSessions } = sessions;
  // 只有服务器声明 session_fork 才给分支入口，避免假按钮
  const canFork = sessions.activeServer?.capabilities.features.session_fork === true;
  const searching = sessions.query.trim().length > 0;
  const list = sessions.matches ?? sessions.sessions;

  // 从对话/设置返回时刷新列表（首次进入由 hook 自己加载）
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void refreshSessions();
    }, [refreshSessions]),
  );

  const openChat = (sessionId: string) => {
    const serverId = sessions.activeServer?.id;
    if (!serverId) return;
    router.push({ pathname: '/(main)/chat/[serverId]/[sessionId]', params: { serverId, sessionId } });
  };

  const onCreate = async () => {
    setCreating(true);
    try {
      const sessionId = await sessions.createSession();
      if (sessionId) openChat(sessionId);
    } finally {
      setCreating(false);
    }
  };

  if (sessions.loading) {
    return (
      <Screen>
        <ScreenHeader title="会话" />
        <LoadingView label="正在读取本地会话…" />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="会话"
        subtitle={sessions.activeServer ? sessions.activeServer.name : '未选择实例'}
        actions={
          <>
            <IconButton
              name="add"
              accessibilityLabel="新建会话"
              accessibilityHint="在 Hermes 服务器上创建新会话并进入对话"
              onPress={() => void onCreate()}
              disabled={!sessions.activeServer || creating}
            />
            <IconButton
              name="settings-outline"
              accessibilityLabel="设置"
              onPress={() => router.push('/(main)/settings')}
            />
          </>
        }
      />

      <View style={{ paddingVertical: theme.space.sm }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: theme.space.lg, gap: theme.space.sm }}
        >
          {sessions.servers.map((server) => (
            <Chip
              key={server.id}
              label={server.name}
              selected={server.id === sessions.activeServer?.id}
              onPress={() => sessions.selectServer(server.id)}
              accessibilityLabel={`切换到实例 ${server.name}`}
            />
          ))}
          <Chip
            label="添加实例"
            selected={false}
            onPress={() => router.push('/(onboarding)/add-server')}
            accessibilityLabel="添加实例"
          />
        </ScrollView>
      </View>

      <View style={{ paddingHorizontal: theme.space.lg, gap: theme.space.sm }}>
        <TextField
          label="搜索会话"
          placeholder="搜索会话标题"
          value={sessions.query}
          onChangeText={sessions.setQuery}
          autoCapitalize="none"
          maxLength={80}
          trailing={
            searching ? (
              <IconButton
                name="close-circle"
                accessibilityLabel="清空搜索"
                accessibilityHint="清除关键词并恢复全部会话"
                onPress={() => sessions.setQuery('')}
              />
            ) : undefined
          }
        />
        {sessions.offline ? (
          <Banner tone="warn" title="连接中断" icon="cloud-offline-outline">
            正在显示本地缓存的会话，恢复网络后下拉刷新。
          </Banner>
        ) : null}
        {sessions.error ? (
          <Banner tone="error" title="刷新失败">
            {sessions.error}
          </Banner>
        ) : null}
        {sessions.notice ? (
          <Banner
            tone={sessions.notice.tone}
            title={sessions.notice.tone === 'success' ? '分支会话已创建' : '分支会话失败'}
            action={<Button label="知道了" variant="ghost" onPress={sessions.dismissNotice} />}
          >
            {sessions.notice.text}
          </Banner>
        ) : null}
      </View>

      <FlatList
        data={list}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: theme.space.lg, paddingTop: theme.space.sm, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={sessions.refreshing}
            onRefresh={() => void sessions.refresh()}
            tintColor={theme.colors.accent}
          />
        }
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: theme.colors.border, opacity: 0.6 }} />
        )}
        ListEmptyComponent={
          searching ? (
            <EmptyState
              icon="search-outline"
              title="没有匹配的会话"
              message={`本地缓存里没有标题包含「${sessions.query.trim()}」的会话。`}
              action={
                <Button
                  label="清空搜索"
                  variant="secondary"
                  icon="close-circle-outline"
                  onPress={() => sessions.setQuery('')}
                />
              }
            />
          ) : (
            <EmptyState
              title={sessions.activeServer ? '还没有会话' : '还没有实例'}
              message={
                sessions.activeServer
                  ? '新建一个会话，或下拉刷新从服务器拉取已有会话。'
                  : '先添加一个 Hermes 实例，才能查看会话。'
              }
              action={
                sessions.activeServer ? (
                  <Button label="新建会话" icon="add" busy={creating} onPress={() => void onCreate()} />
                ) : (
                  <Button
                    label="添加实例"
                    icon="add"
                    onPress={() => router.push('/(onboarding)/add-server')}
                  />
                )
              }
            />
          )
        }
        renderItem={({ item }) => (
          <ListRow
            title={item.title || '未命名会话'}
            meta={`${formatRelative(item.updatedAt)}${item.localOnly ? ' · 仅本地缓存' : ''}${
              item.forkedFrom ? ' · 分支会话' : ''
            }`}
            onPress={() => openChat(item.id)}
            onLongPress={() => setMenuTarget(item)}
            accessibilityLabel={`会话 ${item.title || '未命名会话'}`}
            accessibilityHint="点击进入对话，长按更多操作"
            right={<Ionicons name="chevron-forward" size={theme.icon.sm} color={theme.colors.textMuted} />}
          />
        )}
      />

      <ActionSheet
        visible={menuTarget !== null}
        title={menuTarget?.title || '会话操作'}
        onClose={() => setMenuTarget(null)}
        actions={[
          {
            label: '重命名',
            icon: 'create-outline',
            onPress: () => {
              if (menuTarget) {
                setRenameTarget(menuTarget);
                setRenameText(menuTarget.title);
              }
              setMenuTarget(null);
            },
          },
          ...(canFork
            ? [
                {
                  label: '分支会话',
                  icon: 'git-branch-outline' as const,
                  onPress: () => {
                    if (menuTarget) void sessions.forkSession(menuTarget.id);
                    setMenuTarget(null);
                  },
                },
              ]
            : []),
          {
            label: '仅清理本地缓存',
            icon: 'trash-outline',
            onPress: () => {
              if (menuTarget) setDeleteTarget({ session: menuTarget, mode: 'local' });
              setMenuTarget(null);
            },
          },
          {
            label: '从 Hermes 服务器删除',
            icon: 'cloud-offline-outline',
            destructive: true,
            onPress: () => {
              if (menuTarget) setDeleteTarget({ session: menuTarget, mode: 'server' });
              setMenuTarget(null);
            },
          },
        ]}
      />

      <Sheet
        visible={renameTarget !== null}
        title="重命名会话"
        onClose={() => setRenameTarget(null)}
        footer={
          <View style={{ gap: theme.space.sm }}>
            <Button
              label="保存"
              disabled={renameText.trim().length === 0}
              onPress={() => {
                if (renameTarget) void sessions.renameSession(renameTarget.id, renameText.trim());
                setRenameTarget(null);
              }}
            />
            <Button label="取消" variant="secondary" onPress={() => setRenameTarget(null)} />
          </View>
        }
      >
        <TextField
          label="会话标题"
          value={renameText}
          onChangeText={setRenameText}
          autoCapitalize="sentences"
          maxLength={80}
        />
      </Sheet>

      <ConfirmDialog
        visible={deleteTarget !== null}
        title={deleteTarget?.mode === 'server' ? '从服务器删除会话' : '清理本地缓存'}
        message={
          deleteTarget?.mode === 'server'
            ? '会调用 Hermes 服务器删除该会话，并清理本地缓存。服务器返回失败时本地内容保持不变。此操作不可撤销。'
            : '只会删除本机缓存的消息与会话记录，服务器上的会话仍然保留。'
        }
        confirmLabel={deleteTarget?.mode === 'server' ? '从服务器删除' : '清理本地缓存'}
        destructive={deleteTarget?.mode === 'server'}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void sessions.deleteSession(deleteTarget.session.id, deleteTarget.mode);
          setDeleteTarget(null);
        }}
      />
    </Screen>
  );
}
