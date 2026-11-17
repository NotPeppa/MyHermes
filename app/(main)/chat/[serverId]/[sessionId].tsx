import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ImageAttachment, Message, ModelOption, PendingControl, Run, ToolEvent } from '@/domain/models';
import { useAppServices } from '@/composition';
import { formatBytes, MAX_IMAGES } from '@/media/image';
import { useChat } from '@/features/chat/useChat';
import { describeError } from '@/features/common/errors';
import { canStopRun, isActiveRun, runStateTone, statusText } from '@/features/common/status';
import { ActionSheet, ControlSheet, DetailsSheet, Sheet } from '@/ui/dialogs';
import { copyText } from '@/ui/clipboard';
import { formatTime } from '@/ui/format';
import { DraftMessage, MessageItem } from '@/ui/message-item';
import { Banner, Button, Caption, Chip, EmptyState, ListRow, LoadingView, Screen, ScreenHeader } from '@/ui/primitives';
import { ToolCard } from '@/ui/tool-card';
import { useTheme } from '@/ui/theme';

type ChatItem =
  | { kind: 'message'; key: string; at: number; message: Message }
  | { kind: 'tool'; key: string; at: number; event: ToolEvent }
  | { kind: 'draft'; key: string; at: number; text: string };

/** 模型的 provider / 上下文窗口提示；两者都没有时返回 undefined，避免重复显示 id。 */
function modelHint(option: ModelOption): string | undefined {
  return (
    [option.provider, option.contextWindow ? `上下文 ${option.contextWindow} tokens` : undefined]
      .filter(Boolean)
      .join(' · ') || undefined
  );
}

export default function ChatScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ serverId: string; sessionId: string }>();
  const serverId = params.serverId ?? '';
  const sessionId = params.sessionId ?? '';
  const { repository, service } = useAppServices();
  const chat = useChat(serverId, sessionId);
  const [input, setInput] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [forkedFrom, setForkedFrom] = useState<string | null>(null);
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [model, setModel] = useState<ModelOption | null>(null);
  const [menuTarget, setMenuTarget] = useState<Message | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Message | null>(null);
  const [unknownTarget, setUnknownTarget] = useState<Run | null>(null);
  const [dismissedControl, setDismissedControl] = useState<string | null>(null);
  // P1 图片附件：只有 openai_compat 模式声明了图片输入，其它模式不显示入口
  const [imagesEnabled, setImagesEnabled] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [attachNotice, setAttachNotice] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [servers, sessions] = await Promise.all([
          repository.listServers(),
          repository.listSessions(serverId),
        ]);
        if (!alive) return;
        const server = servers.find((item) => item.id === serverId);
        const session = sessions.find((item) => item.id === sessionId);
        setSubtitle([server?.name, session?.title].filter(Boolean).join(' · '));
        setFeatures(server?.capabilities.features ?? {});
        setImagesEnabled(server?.capabilities.mode === 'openai_compat');
        // 分支来源：优先显示源会话标题，缓存里没有就退回 id
        const origin = session?.forkedFrom;
        setForkedFrom(origin ? sessions.find((item) => item.id === origin)?.title || origin : null);
      } catch {
        /* 标题失败不影响对话 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [repository, serverId, sessionId]);

  // 模型列表按需加载：打开弹层时才请求，失败留在弹层里重试，不影响发送
  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      setModels(await service.listModels(serverId));
    } catch (loadError) {
      setModelsError(describeError(loadError));
    } finally {
      setModelsLoading(false);
    }
  }, [serverId, service]);

  const openModels = () => {
    setModelsOpen(true);
    if (models === null && !modelsLoading) void loadModels();
  };

  const latestRun = useMemo<Run | null>(() => {
    const runs = [...chat.view.runs].sort((a, b) => b.updatedAt - a.updatedAt);
    return runs[0] ?? null;
  }, [chat.view.runs]);

  const uncertain = useMemo<{ clientTurnId: string } | null>(() => {
    if (latestRun?.status === 'submission_uncertain') return { clientTurnId: latestRun.clientTurnId };
    const submission = chat.view.submission;
    if (submission && submission.submissionState === 'submission_uncertain') {
      return { clientTurnId: submission.clientTurnId };
    }
    return null;
  }, [chat.view.submission, latestRun]);

  const pendingControl = useMemo<PendingControl | null>(() => {
    for (const run of chat.view.runs) {
      const control = run.pendingControls?.[0];
      if (control) return control;
    }
    return null;
  }, [chat.view.runs]);

  const controlRun = useMemo<Run | null>(() => {
    if (!pendingControl) return null;
    return (
      chat.view.runs.find((run) =>
        run.pendingControls?.some((control) => control.request_id === pendingControl.request_id),
      ) ?? null
    );
  }, [chat.view.runs, pendingControl]);

  const controlVisible = !!pendingControl && dismissedControl !== pendingControl.request_id;

  const items = useMemo<ChatItem[]>(() => {
    const merged: ChatItem[] = chat.view.messages.map((message) => ({
      kind: 'message',
      key: `m-${message.id}`,
      at: message.createdAt,
      message,
    }));
    for (const event of chat.view.tools) {
      merged.push({ kind: 'tool', key: `t-${event.id}`, at: event.recordedAt, event });
    }
    merged.sort((a, b) => a.at - b.at);
    if (chat.view.draft && chat.view.draft.length > 0) {
      merged.push({ kind: 'draft', key: 'draft', at: Number.MAX_SAFE_INTEGER, text: chat.view.draft });
    }
    return merged.reverse();
  }, [chat.view.draft, chat.view.messages, chat.view.tools]);

  const active = isActiveRun(latestRun?.status);
  const stopping = chat.busy === 'stop';
  const sending = chat.busy === 'send';
  // 只有服务器声明 run_stop 时才提供停止按钮，避免假按钮
  const showStop = canStopRun(latestRun?.status) && features.run_stop === true;
  const canResolveUnknown = features.run_unknown_resolution === true;
  const modelsEnabled = features.model_options === true;
  const modelName = model ? model.label || model.id : '默认模型';
  // 标题栏空间有限：chip 只显示截断后的名字，无障碍标签保留全名
  const modelLabel = modelName.length > 18 ? `${modelName.slice(0, 17)}…` : modelName;
  const network = chat.view.network;

  const atLimit = images.length >= MAX_IMAGES;
  const canSend = (input.trim().length > 0 || images.length > 0) && !sending;

  const onPick = async () => {
    if (picking || atLimit) return;
    setPicking(true);
    setAttachNotice(null);
    try {
      // 相册模块按需加载：原生模块只在用户点击时才进入模块图，无头渲染与首屏都不必加载它
      const { pickImage } = await import('@/media/picker');
      const result = await pickImage(images.length);
      if (result.kind === 'picked') setImages((prev) => [...prev, result.attachment]);
      else if (result.kind === 'denied') setAttachNotice({ tone: 'warn', text: result.message });
      else if (result.kind === 'error') setAttachNotice({ tone: 'error', text: result.message });
      // cancelled：用户主动取消，保持静默
    } catch (pickError) {
      setAttachNotice({ tone: 'error', text: describeError(pickError) });
    } finally {
      setPicking(false);
    }
  };

  const onSend = async () => {
    const text = input.trim();
    if (text.length === 0 && images.length === 0) return;
    const sentImages = images;
    // 先清空，失败再回填：避免重复点击把同一张图发两次
    setInput('');
    setImages([]);
    const options = {
      ...(model ? { model: model.id, provider: model.provider } : {}),
      ...(sentImages.length > 0 ? { images: sentImages } : {}),
    };
    const ok = await chat.send(text, Object.keys(options).length > 0 ? options : undefined);
    if (!ok) {
      setInput(text);
      setImages(sentImages);
    }
  };

  const tone = runStateTone(latestRun?.status);
  const toneColor =
    tone === 'success'
      ? theme.colors.success
      : tone === 'danger'
        ? theme.colors.danger
        : tone === 'warning'
          ? theme.colors.warning
          : tone === 'active'
            ? theme.colors.accent
            : theme.colors.textMuted;

  return (
    <Screen>
      <ScreenHeader
        title="对话"
        subtitle={subtitle || undefined}
        onBack={() => router.back()}
        actions={
          // 没有 model_options 能力就不放任何模型入口
          modelsEnabled ? (
            <Chip
              label={modelLabel}
              selected={model !== null}
              onPress={openModels}
              accessibilityLabel={`当前模型：${modelName}，点击切换`}
            />
          ) : undefined
        }
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={{ paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}>
            <View
              accessible
              accessibilityLabel={`运行状态：${statusText(latestRun?.status ?? (uncertain ? 'submission_uncertain' : 'idle'))}`}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}
            >
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor }} />
              <Text style={{ color: toneColor, fontSize: theme.font.body }}>
                {statusText(latestRun?.status ?? (uncertain ? 'submission_uncertain' : 'idle'))}
              </Text>
              {latestRun?.rawStatus && latestRun.rawStatus !== latestRun.status ? (
                <Caption>（上游：{latestRun.rawStatus}）</Caption>
              ) : null}
            </View>
            {showStop && latestRun ? (
              <Button
                label="停止"
                variant="secondary"
                icon="stop-circle-outline"
                busy={stopping}
                onPress={() => void chat.stop(latestRun.runId)}
                accessibilityHint="请求服务器停止当前运行，不会提前宣告成功"
              />
            ) : null}
          </View>

          {forkedFrom ? <Caption>分支自 {forkedFrom}</Caption> : null}

          {network !== 'connected' ? (
            <Banner tone="warn" title={network === 'offline' ? '连接中断' : '正在重连'}>
              {network === 'offline'
                ? '已保留当前 run，恢复网络后会自动对账，不会重新提交。'
                : '正在恢复与服务器的连接…'}
            </Banner>
          ) : null}

          {chat.view.error ? (
            <Banner tone="error" title="服务层错误">
              {describeError(chat.view.error)}
            </Banner>
          ) : null}

          {chat.error ? (
            <Banner
              tone="error"
              title="操作失败"
              action={<Button label="关闭提示" variant="ghost" onPress={chat.dismissError} />}
            >
              {chat.error}
            </Banner>
          ) : null}

          {pendingControl && !controlVisible ? (
            <Banner
              tone="warn"
              title={/clarif/i.test(pendingControl.type) ? '有待补充的信息' : '有待审批的操作'}
              action={
                <Button
                  label="打开处理"
                  variant="secondary"
                  onPress={() => setDismissedControl(null)}
                />
              }
            >
              {pendingControl.prompt}
            </Banner>
          ) : null}

          {uncertain ? (
            <Banner
              tone="warn"
              title="可能已提交"
              action={
                <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
                  <Button
                    label="同键重试"
                    variant="secondary"
                    busy={chat.busy === 'retry'}
                    onPress={() => void chat.retry(uncertain.clientTurnId)}
                    accessibilityHint="沿用原幂等键重试，不会重复执行"
                    style={{ flex: 1 }}
                  />
                  <Button
                    label="核对状态"
                    variant="secondary"
                    busy={chat.busy === 'recover'}
                    onPress={() => void chat.recover()}
                    style={{ flex: 1 }}
                  />
                </View>
              }
            >
              上一次提交没有拿到响应。先核对服务器状态，再决定是否重试。
            </Banner>
          ) : null}

          {latestRun?.status === 'unknown' ? (
            <Banner
              tone="warn"
              title="执行结果不确定"
              action={
                canResolveUnknown ? (
                  <Button
                    label="核对结果"
                    variant="secondary"
                    onPress={() => setUnknownTarget(latestRun)}
                  />
                ) : undefined
              }
            >
              {canResolveUnknown
                ? '服务器返回了无法识别的终态，需要人工核对后才能继续。'
                : '服务器返回了无法识别的终态，且未声明人工核对能力；请先在服务器上确认实际结果。'}
            </Banner>
          ) : null}
        </View>

        {chat.loading && chat.view.messages.length === 0 ? (
          <LoadingView label="正在加载历史消息…" />
        ) : (
          <FlatList
            data={items}
            inverted
            keyExtractor={(item) => item.key}
            contentContainerStyle={{ paddingVertical: theme.space.sm }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <View style={{ transform: [{ scaleY: -1 }] }}>
                <EmptyState
                  icon="chatbubble-ellipses-outline"
                  title="还没有消息"
                  message="输入文字开始对话。工具输出会单独显示为可折叠卡片。"
                />
              </View>
            }
            renderItem={({ item }) => {
              if (item.kind === 'tool') return <ToolCard event={item.event} />;
              if (item.kind === 'draft') return <DraftMessage text={item.text} />;
              return <MessageItem message={item.message} onLongPress={setMenuTarget} />;
            }}
          />
        )}

        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            backgroundColor: theme.colors.surface,
            paddingHorizontal: theme.space.md,
            paddingTop: theme.space.sm,
            paddingBottom: insets.bottom + theme.space.sm,
            gap: theme.space.sm,
          }}
        >
          {attachNotice ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{
                color: attachNotice.tone === 'warn' ? theme.colors.warning : theme.colors.danger,
                fontSize: theme.font.caption,
              }}
            >
              {attachNotice.text}
            </Text>
          ) : null}

          {imagesEnabled ? (
            <View style={{ gap: theme.space.xs }}>
              {images.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
                  {images.map((image, index) => (
                    <View key={image.id} style={{ gap: 2 }}>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          borderRadius: theme.radius.sm,
                          backgroundColor: theme.colors.bg,
                        }}
                      >
                        <Image
                          source={{ uri: image.dataUri }}
                          accessibilityLabel={`已选图片 ${index + 1}`}
                          style={{
                            width: 48,
                            height: 48,
                            borderRadius: theme.radius.sm,
                            backgroundColor: theme.colors.surfaceAlt,
                          }}
                        />
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`移除图片 ${index + 1}`}
                          accessibilityHint="从待发送列表移除这张图片"
                          onPress={() => setImages((prev) => prev.filter((item) => item.id !== image.id))}
                          style={({ pressed }) => ({
                            width: theme.minTouch,
                            height: theme.minTouch,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
                          })}
                        >
                          <Ionicons name="close" size={theme.icon.sm} color={theme.colors.textMuted} />
                        </Pressable>
                      </View>
                      <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
                        {image.width}×{image.height} · {formatBytes(image.bytes)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
                仅上传压缩后的副本，不含 EXIF 与定位信息
              </Text>
              {atLimit ? (
                <Text style={{ color: theme.colors.warning, fontSize: theme.font.caption }}>
                  已达上限 {MAX_IMAGES} 张，移除后可继续添加
                </Text>
              ) : null}
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.space.sm }}>
            {imagesEnabled ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="添加图片"
                accessibilityHint="从相册选择一张图片，发送前会压缩并去除元数据"
                accessibilityState={{ disabled: picking || atLimit, busy: picking }}
                disabled={picking || atLimit}
                onPress={() => void onPick()}
                style={({ pressed }) => ({
                  width: theme.minTouch,
                  height: theme.minTouch,
                  borderRadius: theme.radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
                  opacity: picking || atLimit ? 0.45 : 1,
                })}
              >
                {picking ? (
                  <ActivityIndicator size="small" color={theme.colors.textMuted} />
                ) : (
                  <Ionicons name="image-outline" size={theme.icon.md} color={theme.colors.text} />
                )}
              </Pressable>
            ) : null}
            <TextInput
              accessibilityLabel="消息输入框"
              accessibilityHint="输入要发送给 Hermes 的消息"
              value={input}
              onChangeText={setInput}
              placeholder={active ? 'Hermes 正在执行，可先输入下一条' : '输入消息…'}
              placeholderTextColor={theme.colors.textMuted}
              multiline
              editable={!sending}
              style={{
                flex: 1,
                minHeight: theme.minTouch,
                maxHeight: 132,
                paddingHorizontal: theme.space.md,
                paddingVertical: theme.space.sm,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.bg,
                color: theme.colors.text,
                fontSize: theme.font.body,
                textAlignVertical: 'center',
              }}
            />
            {showStop && latestRun ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="停止当前运行"
                accessibilityState={{ busy: stopping }}
                disabled={stopping}
                onPress={() => void chat.stop(latestRun.runId)}
                style={({ pressed }) => ({
                  width: theme.minTouch,
                  height: theme.minTouch,
                  borderRadius: theme.radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? theme.colors.surfaceAlt : theme.colors.danger,
                  opacity: stopping ? 0.5 : 1,
                })}
              >
                <Ionicons name="stop" size={theme.icon.md} color={theme.colors.onDanger} />
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="发送消息"
                accessibilityState={{ disabled: !canSend, busy: sending }}
                disabled={!canSend}
                onPress={() => void onSend()}
                style={({ pressed }) => ({
                  width: theme.minTouch,
                  height: theme.minTouch,
                  borderRadius: theme.radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? theme.colors.surfaceAlt : theme.colors.primary,
                  opacity: canSend ? 1 : 0.45,
                })}
              >
                <Ionicons name="send" size={theme.icon.md} color={theme.colors.onPrimary} />
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>

      {modelsEnabled ? (
        <Sheet visible={modelsOpen} title="选择模型" onClose={() => setModelsOpen(false)}>
          {modelsLoading ? <Caption>正在读取模型列表…</Caption> : null}
          {modelsError ? (
            <Banner
              tone="error"
              title="模型列表加载失败"
              action={<Button label="重试" variant="secondary" onPress={() => void loadModels()} />}
            >
              {modelsError}
            </Banner>
          ) : null}
          {!modelsLoading && !modelsError ? (
            <View style={{ gap: theme.space.xs }}>
              <ListRow
                title="默认模型"
                subtitle="使用服务器配置的默认模型"
                onPress={() => {
                  setModel(null);
                  setModelsOpen(false);
                }}
                accessibilityLabel="使用默认模型"
                right={
                  model === null ? (
                    <Ionicons name="checkmark" size={theme.icon.md} color={theme.colors.accent} />
                  ) : undefined
                }
              />
              {(models ?? []).map((option) => (
                <ListRow
                  key={`${option.provider ?? ''}:${option.id}`}
                  title={option.label || option.id}
                  subtitle={modelHint(option)}
                  onPress={() => {
                    setModel(option);
                    setModelsOpen(false);
                  }}
                  accessibilityLabel={`选择模型 ${option.label || option.id}`}
                  accessibilityHint={modelHint(option) ?? option.id}
                  right={
                    model?.id === option.id ? (
                      <Ionicons name="checkmark" size={theme.icon.md} color={theme.colors.accent} />
                    ) : undefined
                  }
                />
              ))}
              {(models ?? []).length === 0 ? (
                <Caption>服务器没有返回可选模型，将继续使用默认模型。</Caption>
              ) : null}
            </View>
          ) : null}
        </Sheet>
      ) : null}

      <ControlSheet
        visible={controlVisible}
        control={pendingControl}
        busy={chat.busy === 'control'}
        onClose={() => setDismissedControl(pendingControl?.request_id ?? null)}
        onRespond={(value) => {
          if (!pendingControl || !controlRun) return;
          setDismissedControl(pendingControl.request_id);
          void chat.respond(controlRun.runId, pendingControl.request_id, value);
        }}
      />

      <ActionSheet
        visible={menuTarget !== null}
        title="消息操作"
        onClose={() => setMenuTarget(null)}
        actions={[
          {
            label: '复制全文',
            icon: 'copy-outline',
            onPress: () => {
              if (menuTarget) copyText(menuTarget.body);
              setMenuTarget(null);
            },
          },
          {
            label: '查看详情',
            icon: 'information-circle-outline',
            onPress: () => {
              setDetailsTarget(menuTarget);
              setMenuTarget(null);
            },
          },
          ...(menuTarget?.role === 'user'
            ? [
                {
                  label: '重新填入输入框',
                  icon: 'arrow-undo-outline' as const,
                  onPress: () => {
                    if (menuTarget) setInput(menuTarget.body);
                    setMenuTarget(null);
                  },
                },
              ]
            : []),
        ]}
      />

      <DetailsSheet
        visible={detailsTarget !== null}
        title="消息详情"
        onClose={() => setDetailsTarget(null)}
        rows={
          detailsTarget
            ? [
                { label: '角色', value: detailsTarget.role },
                { label: '消息 ID', value: detailsTarget.id },
                { label: '服务器消息 ID', value: detailsTarget.serverMessageId ?? '无' },
                { label: '时间', value: formatTime(detailsTarget.createdAt) },
                { label: '字符数', value: String(detailsTarget.body.length) },
              ]
            : []
        }
      />

      <Sheet
        visible={unknownTarget !== null}
        title="核对执行结果"
        onClose={() => setUnknownTarget(null)}
        footer={
          <View style={{ gap: theme.space.sm }}>
            <Button
              label="确认已完成并继续"
              busy={chat.busy === 'resolve'}
              onPress={() => {
                if (unknownTarget) void chat.resolveUnknown(unknownTarget.runId, true);
                setUnknownTarget(null);
              }}
            />
            <Button label="取消" variant="secondary" onPress={() => setUnknownTarget(null)} />
          </View>
        }
      >
        <Text style={{ color: theme.colors.text, fontSize: theme.font.body, lineHeight: theme.font.body * 1.6 }}>
          服务器返回了无法识别的终态（run {unknownTarget?.runId ?? ''}）。请先在服务器上确认任务确实已经完成；确认后客户端才会向服务器提交核对结论，不会自行把它当作成功。
        </Text>
        <Text style={{ color: theme.colors.warning, fontSize: theme.font.caption }}>
          如果任务实际未完成，请不要确认——直接在服务器上处理，或保留此状态等待人工介入。
        </Text>
        {unknownTarget?.rawStatus ? <Caption>上游原始状态：{unknownTarget.rawStatus}</Caption> : null}
      </Sheet>
    </Screen>
  );
}
