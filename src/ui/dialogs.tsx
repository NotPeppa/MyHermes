import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PendingControl } from '@/domain/models';
import { Button, IconButton, TextField, type IconName } from './primitives';
import { useTheme } from './theme';

export function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭弹层" onPress={onClose} style={{ flex: 1 }} />
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radius.lg,
            borderTopRightRadius: theme.radius.lg,
            paddingBottom: insets.bottom + theme.space.md,
            maxHeight: '85%',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space.sm,
              paddingLeft: theme.space.lg,
              paddingRight: theme.space.sm,
              paddingTop: theme.space.sm,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{ flex: 1, color: theme.colors.text, fontSize: theme.font.title, fontWeight: '700' }}
            >
              {title}
            </Text>
            <IconButton name="close" accessibilityLabel="关闭" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.md }}>
            {children}
          </ScrollView>
          {footer ? <View style={{ paddingHorizontal: theme.space.lg, gap: theme.space.sm }}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

export interface SheetAction {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  onPress: () => void;
}

export function ActionSheet({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean;
  title: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <View style={{ gap: theme.space.xs }}>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={action.onPress}
            style={({ pressed }) => ({
              minHeight: theme.minTouch,
              paddingHorizontal: theme.space.md,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space.md,
              borderRadius: theme.radius.sm,
              backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
            })}
          >
            {action.icon ? (
              <Ionicons
                name={action.icon}
                size={theme.icon.md}
                color={action.destructive ? theme.colors.danger : theme.colors.text}
              />
            ) : null}
            <Text
              style={{
                color: action.destructive ? theme.colors.danger : theme.colors.text,
                fontSize: theme.font.body,
              }}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
        <Button label="取消" variant="secondary" onPress={onClose} />
      </View>
    </Sheet>
  );
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} title={title} onClose={onCancel}>
      <Text style={{ color: theme.colors.text, fontSize: theme.font.body, lineHeight: theme.font.body * 1.6 }}>
        {message}
      </Text>
      <View style={{ gap: theme.space.sm }}>
        <Button
          label={confirmLabel}
          variant={destructive ? 'danger' : 'primary'}
          busy={busy}
          onPress={onConfirm}
        />
        <Button label={cancelLabel} variant="secondary" onPress={onCancel} />
      </View>
    </Sheet>
  );
}

export function ControlSheet({
  visible,
  control,
  busy,
  onRespond,
  onClose,
}: {
  visible: boolean;
  control: PendingControl | null;
  busy: boolean;
  onRespond: (value: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [answer, setAnswer] = useState('');
  if (!control) return null;
  const clarification = /clarif/i.test(control.type);
  const options =
    control.choices && control.choices.length > 0
      ? control.choices.map((choice) => ({ label: choice, value: choice }))
      : [
          { label: '批准（仅本次）', value: 'once' },
          { label: '拒绝', value: 'deny' },
        ];
  return (
    <Sheet
      visible={visible}
      title={clarification ? '需要补充信息' : '等待操作审批'}
      onClose={onClose}
    >
      <Text selectable style={{ color: theme.colors.text, fontSize: theme.font.body, lineHeight: theme.font.body * 1.6 }}>
        {control.prompt}
      </Text>
      <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
        请求 {control.request_id} · 执行代次 {control.execution_generation}
      </Text>
      {clarification ? (
        <TextField
          label="补充信息"
          value={answer}
          onChangeText={setAnswer}
          multiline
          autoCapitalize="sentences"
          placeholder="输入要回复给 Hermes 的内容"
        />
      ) : null}
      <View style={{ gap: theme.space.sm }}>
        {clarification ? (
          <Button
            label="提交答案"
            busy={busy}
            disabled={answer.trim().length === 0}
            onPress={() => onRespond(answer.trim())}
          />
        ) : (
          options.map((option) => (
            <Button
              key={option.value}
              label={option.label}
              variant={option.value === 'deny' ? 'secondary' : 'primary'}
              busy={busy}
              onPress={() => onRespond(option.value)}
            />
          ))
        )}
        <Button label="稍后处理" variant="ghost" onPress={onClose} />
      </View>
    </Sheet>
  );
}

export function DetailsSheet({
  visible,
  title,
  rows,
  onClose,
}: {
  visible: boolean;
  title: string;
  rows: { label: string; value: string }[];
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <View style={{ gap: theme.space.md }}>
        {rows.map((row) => (
          <View key={row.label} style={{ gap: 2 }}>
            <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>{row.label}</Text>
            <Text
              selectable
              style={{
                color: theme.colors.text,
                fontSize: theme.font.body,
                fontFamily: theme.fontFamily.mono,
                lineHeight: theme.font.body * 1.5,
              }}
            >
              {row.value}
            </Text>
          </View>
        ))}
      </View>
    </Sheet>
  );
}
