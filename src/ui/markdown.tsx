import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { copyText } from './clipboard';
import { parseMarkdown } from './markdown-parse';
import { useTheme } from './theme';

const INLINE = /(`[^`]*`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g;

function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > index) nodes.push(text.slice(index, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith('`')) {
      nodes.push(<InlineCode key={key} text={token.slice(1, -1)} />);
    } else if (token.startsWith('**')) {
      nodes.push(
        <Text key={key} style={{ fontWeight: '700' }}>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith('*')) {
      nodes.push(
        <Text key={key} style={{ fontStyle: 'italic' }}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      const label = token.slice(1, token.indexOf(']'));
      nodes.push(<LinkText key={key} label={label} />);
    }
    index = match.index + token.length;
  }
  if (index < text.length) nodes.push(text.slice(index));
  return nodes;
}

function InlineCode({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text
      style={{
        fontFamily: theme.fontFamily.mono,
        fontSize: theme.font.code,
        color: theme.colors.codeText,
        backgroundColor: theme.colors.codeBg,
      }}
    >
      {text}
    </Text>
  );
}

function LinkText({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <Text style={{ color: theme.colors.accent, textDecorationLine: 'underline' }}>{label}</Text>
  );
}

export function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.codeBg,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: theme.space.md,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Text style={{ flex: 1, color: theme.colors.textMuted, fontSize: theme.font.caption }}>
          {lang && lang.length > 0 ? lang : '代码'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? '已复制代码' : '复制代码'}
          onPress={() => {
            copyText(text);
            setCopied(true);
          }}
          style={({ pressed }) => ({
            width: theme.minTouch,
            height: theme.minTouch,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? theme.colors.surfaceAlt : 'transparent',
          })}
        >
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={theme.icon.sm}
            color={theme.colors.textMuted}
          />
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: theme.space.md }}>
        <Text
          selectable
          style={{
            fontFamily: theme.fontFamily.mono,
            fontSize: theme.font.code,
            lineHeight: theme.font.code * 1.5,
            color: theme.colors.codeText,
          }}
        >
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

export function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  const blocks = parseMarkdown(text);
  return (
    <View style={{ gap: theme.space.sm }}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case 'code':
            return <CodeBlock key={key} text={block.text} lang={block.lang} />;
          case 'heading':
            return (
              <Text
                key={key}
                accessibilityRole="header"
                style={{
                  color: theme.colors.text,
                  fontSize: block.level <= 2 ? theme.font.title : theme.font.body,
                  fontWeight: '700',
                }}
              >
                {inlineNodes(block.text, key)}
              </Text>
            );
          case 'list':
            return (
              <View key={key} style={{ gap: theme.space.xs }}>
                {block.items.map((item, itemIndex) => (
                  <View key={`${key}-${itemIndex}`} style={{ flexDirection: 'row', gap: theme.space.sm }}>
                    <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body }}>
                      {block.ordered ? `${itemIndex + 1}.` : '•'}
                    </Text>
                    <Text style={{ flex: 1, color: theme.colors.text, fontSize: theme.font.body, lineHeight: theme.font.body * 1.6 }}>
                      {inlineNodes(item, `${key}-${itemIndex}`)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View
                key={key}
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: theme.colors.border,
                  paddingLeft: theme.space.md,
                }}
              >
                <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body, lineHeight: theme.font.body * 1.6 }}>
                  {inlineNodes(block.text, key)}
                </Text>
              </View>
            );
          default:
            return (
              <Text
                key={key}
                style={{ color: theme.colors.text, fontSize: theme.font.body, lineHeight: theme.font.body * 1.6 }}
              >
                {inlineNodes(block.text, key)}
              </Text>
            );
        }
      })}
    </View>
  );
}
