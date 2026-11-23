import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';

export type IconName = keyof typeof Ionicons.glyphMap;

/* ------------------------------------------------------------------ 布局 */

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[{ flex: 1, backgroundColor: colors.bg }, style]}>{children}</View>;
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  actions,
}: {
  title: string;
  /** 字符串走默认样式；需要彩色圆点等自定义内容时传节点 */
  subtitle?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + theme.space.sm,
        paddingBottom: theme.space.sm,
        paddingHorizontal: theme.space.lg,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.sm,
      }}
    >
      {onBack ? (
        <IconButton name="chevron-back" accessibilityLabel="返回" onPress={onBack} />
      ) : null}
      <View style={{ flex: 1 }}>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: theme.colors.text, fontSize: theme.font.title, fontWeight: '700' }}
        >
          {title}
        </Text>
        {typeof subtitle === 'string' ? (
          <Text numberOfLines={1} style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
            {subtitle}
          </Text>
        ) : (
          subtitle ?? null
        )}
      </View>
      {actions}
    </View>
  );
}

export function ScrollScreen({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        padding: theme.space.lg,
        paddingBottom: insets.bottom + theme.space.xxl,
        gap: theme.space.lg,
      }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {children}
      {footer}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.border,
          padding: theme.space.lg,
          gap: theme.space.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Divider() {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }} />;
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';

export function Badge({
  label,
  tone = 'neutral',
  dot = false,
  mono = false,
}: {
  label: string;
  tone?: BadgeTone;
  dot?: boolean;
  mono?: boolean;
}) {
  const theme = useTheme();
  const palette: Record<BadgeTone, { bg: string; fg: string }> = {
    neutral: { bg: theme.colors.surfaceAlt, fg: theme.colors.textMuted },
    accent: { bg: theme.colors.accentSoft, fg: theme.colors.accent },
    success: { bg: theme.colors.successSoft, fg: theme.colors.success },
    warn: { bg: theme.colors.warningSoft, fg: theme.colors.warning },
    danger: { bg: theme.colors.dangerSoft, fg: theme.colors.danger },
  };
  const colors = palette[tone];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: theme.space.sm + 2,
        paddingVertical: 4,
        borderRadius: theme.radius.pill,
        backgroundColor: colors.bg,
        alignSelf: 'flex-start',
      }}
    >
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.fg }} /> : null}
      <Text
        numberOfLines={1}
        style={{
          color: colors.fg,
          fontSize: theme.font.caption,
          fontWeight: '600',
          ...(mono ? { fontFamily: theme.fontFamily.mono } : {}),
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityPrefix,
}: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (next: T) => void;
  accessibilityPrefix?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        padding: 3,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surfaceAlt,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 3,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={
              accessibilityPrefix
                ? `${accessibilityPrefix}：${option.label}${selected ? '，已选中' : ''}`
                : `${option.label}${selected ? '，已选中' : ''}`
            }
            accessibilityHint={option.hint}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 38,
              borderRadius: theme.radius.sm + 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: theme.space.sm,
              backgroundColor: selected ? theme.colors.primary : 'transparent',
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              style={{
                color: selected ? theme.colors.onPrimary : theme.colors.textMuted,
                fontSize: theme.font.caption + 1,
                fontWeight: selected ? '700' : '600',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Section({
  title,
  children,
  description,
  card = true,
}: {
  title: string;
  children: ReactNode;
  description?: string;
  card?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.sm }}>
      <View style={{ paddingHorizontal: theme.space.xs, gap: 2 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.textMuted,
            fontSize: theme.font.caption,
            fontWeight: '700',
            letterSpacing: 0.4,
          }}
        >
          {title}
        </Text>
        {description ? (
          <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption, lineHeight: theme.font.caption * 1.5 }}>
            {description}
          </Text>
        ) : null}
      </View>
      {card ? <Card>{children}</Card> : <View style={{ gap: theme.space.md }}>{children}</View>}
    </View>
  );
}

/* ------------------------------------------------------------------ 按钮 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.primary, fg: colors.onPrimary, border: colors.primary },
    secondary: { bg: colors.surface, fg: colors.text, border: colors.border },
    ghost: { bg: 'transparent', fg: colors.text, border: 'transparent' },
    danger: { bg: colors.danger, fg: colors.onDanger, border: colors.danger },
  };
  const tone = palette[variant];
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: theme.minTouch - 2,
          minWidth: theme.minTouch,
          paddingHorizontal: theme.space.lg,
          borderRadius: theme.radius.md,
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: tone.border,
          backgroundColor:
            pressed && (variant === 'secondary' || variant === 'ghost') ? colors.surfaceAlt : tone.bg,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space.sm,
          opacity: disabled ? 0.45 : pressed && (variant === 'primary' || variant === 'danger') ? 0.84 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tone.fg} />
      ) : icon ? (
        <Ionicons name={icon} size={theme.icon.md} color={tone.fg} />
      ) : null}
      <Text style={{ color: tone.fg, fontSize: theme.font.body, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  name,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  color,
  disabled = false,
  size,
}: {
  name: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  color?: string;
  disabled?: boolean;
  size?: number;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: theme.minTouch,
        height: theme.minTouch,
        borderRadius: theme.radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Ionicons name={name} size={size ?? theme.icon.md} color={color ?? theme.colors.text} />
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
  icon,
  dot = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  icon?: IconName;
  dot?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: theme.space.md + 2,
        borderRadius: theme.radius.pill,
        borderWidth: 1,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: selected ? theme.colors.primary : pressed ? theme.colors.surfaceAlt : theme.colors.surface,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        opacity: pressed && selected ? 0.85 : 1,
      })}
    >
      {dot ? (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: selected ? theme.colors.onPrimary : theme.colors.accent,
          }}
        />
      ) : null}
      {icon ? (
        <Ionicons
          name={icon}
          size={15}
          color={selected ? theme.colors.onPrimary : theme.colors.textMuted}
        />
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          color: selected ? theme.colors.onPrimary : theme.colors.text,
          fontSize: theme.font.caption + 1,
          fontWeight: selected ? '700' : '500',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ 表单 */

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  secure = false,
  error,
  helper,
  trailing,
  multiline = false,
  keyboardType,
  autoCapitalize = 'none',
  autoComplete,
  textContentType,
  onBlur,
  editable = true,
  accessibilityHint,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  secure?: boolean;
  error?: string;
  helper?: string;
  trailing?: ReactNode;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoComplete?: 'off' | 'url' | 'password' | 'username';
  textContentType?: 'URL' | 'password' | 'username' | 'none';
  onBlur?: () => void;
  editable?: boolean;
  accessibilityHint?: string;
  maxLength?: number;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.xs }}>
      <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption, fontWeight: '600' }}>{label}</Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: error ? theme.colors.danger : theme.colors.border,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surface,
          paddingRight: trailing ? theme.space.xs : 0,
        }}
      >
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={accessibilityHint}
          value={value}
          onChangeText={onChangeText}
          onBlur={onBlur}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          secureTextEntry={secure}
          multiline={multiline}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          autoComplete={autoComplete}
          textContentType={textContentType}
          editable={editable}
          maxLength={maxLength}
          style={{
            flex: 1,
            minHeight: theme.minTouch,
            paddingHorizontal: theme.space.md,
            paddingVertical: theme.space.sm,
            color: theme.colors.text,
            fontSize: theme.font.body,
            fontFamily: theme.fontFamily.sans,
            textAlignVertical: multiline ? 'top' : 'center',
          }}
        />
        {trailing}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.danger, fontSize: theme.font.caption }}>
          {error}
        </Text>
      ) : helper ? (
        <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>{helper}</Text>
      ) : null}
    </View>
  );
}

export function SwitchRow({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => ({
        minHeight: theme.minTouch,
        paddingVertical: theme.space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.md,
        backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>{label}</Text>
        {description ? (
          <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption, lineHeight: theme.font.caption * 1.5 }}>
            {description}
          </Text>
        ) : null}
      </View>
      <View
        style={{
          width: 48,
          height: 28,
          borderRadius: theme.radius.pill,
          backgroundColor: value ? theme.colors.primary : theme.colors.border,
          padding: 2,
          alignItems: value ? 'flex-end' : 'flex-start',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: theme.radius.pill,
            backgroundColor: value ? theme.colors.onPrimary : theme.colors.surface,
          }}
        />
      </View>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ 反馈 */

export type BannerTone = 'info' | 'warn' | 'error' | 'success';

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  icon,
}: {
  tone?: BannerTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
}) {
  const theme = useTheme();
  const tint: Record<BannerTone, { fg: string; bg: string }> = {
    info: { fg: theme.colors.accent, bg: theme.colors.accentSoft },
    warn: { fg: theme.colors.warning, bg: theme.colors.warningSoft },
    error: { fg: theme.colors.danger, bg: theme.colors.dangerSoft },
    success: { fg: theme.colors.success, bg: theme.colors.successSoft },
  };
  const glyph: Record<BannerTone, IconName> = {
    info: 'information-circle-outline',
    warn: 'warning-outline',
    error: 'alert-circle-outline',
    success: 'checkmark-circle-outline',
  };
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderRadius: theme.radius.md,
        backgroundColor: tint[tone].bg,
        padding: theme.space.md,
        gap: theme.space.xs,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}>
        <Ionicons name={icon ?? glyph[tone]} size={theme.icon.sm + 2} color={tint[tone].fg} />
        {title ? (
          <Text style={{ flex: 1, color: theme.colors.text, fontSize: theme.font.body, fontWeight: '700' }}>{title}</Text>
        ) : null}
      </View>
      {typeof children === 'string' ? (
        <Text style={{ color: theme.colors.text, fontSize: theme.font.caption + 1, lineHeight: (theme.font.caption + 1) * 1.5, opacity: 0.88 }}>
          {children}
        </Text>
      ) : (
        children
      )}
      {action ? <View style={{ marginTop: theme.space.xs }}>{action}</View> : null}
    </View>
  );
}

export function LoadingView({ label = '加载中…' }: { label?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.space.md, padding: theme.space.xl }}>
      <ActivityIndicator color={theme.colors.accent} />
      <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body }}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  icon = 'chatbubbles-outline',
  title,
  message,
  action,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', gap: theme.space.md, padding: theme.space.xl }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: theme.colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={theme.icon.lg} color={theme.colors.textMuted} />
      </View>
      <Text style={{ color: theme.colors.text, fontSize: theme.font.title - 2, fontWeight: '700', textAlign: 'center' }}>
        {title}
      </Text>
      {message ? (
        <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body, textAlign: 'center', lineHeight: theme.font.body * 1.5, maxWidth: 300 }}>
          {message}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

export function ListRow({
  title,
  subtitle,
  meta,
  onPress,
  onLongPress,
  right,
  accessibilityLabel,
  accessibilityHint,
  leading,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  right?: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  leading?: ReactNode;
}) {
  const theme = useTheme();
  const content = (
    <>
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
            {subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text numberOfLines={1} style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
            {meta}
          </Text>
        ) : null}
      </View>
      {right}
    </>
  );
  if (!onPress && !onLongPress) {
    return (
      <View style={{ minHeight: theme.minTouch, paddingVertical: theme.space.md, flexDirection: 'row', alignItems: 'center', gap: theme.space.md }}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={({ pressed }) => ({
        minHeight: theme.minTouch,
        paddingVertical: theme.space.md,
        paddingHorizontal: theme.space.xs,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.md,
        backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
        borderRadius: theme.radius.sm,
      })}
    >
      {content}
    </Pressable>
  );
}

export function Caption({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>{children}</Text>;
}
