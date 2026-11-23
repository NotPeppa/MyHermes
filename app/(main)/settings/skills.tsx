import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { Skill, Toolset } from '@/domain/models';
import { useSkills } from '@/features/skills/useSkills';
import {
  Badge,
  Banner,
  Button,
  Card,
  Divider,
  EmptyState,
  ListRow,
  LoadingView,
  Screen,
  ScreenHeader,
} from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

type Row =
  | { key: string; kind: 'header'; title: string; description: string }
  | { key: string; kind: 'skill'; skill: Skill }
  | { key: string; kind: 'toolset'; toolset: Toolset };

export default function SkillsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const skills = useSkills();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const header = <ScreenHeader title="技能与工具集" subtitle={skills.server?.name} onBack={() => router.back()} />;

  if (skills.loading) {
    return (
      <Screen>
        {header}
        <LoadingView label="正在读取技能…" />
      </Screen>
    );
  }

  const rows: Row[] = [];
  if (skills.skills.length > 0) {
    rows.push({ key: 'header-skills', kind: 'header', title: `技能（${skills.skills.length}）`, description: '服务器声明的只读技能清单。' });
    for (const skill of skills.skills) rows.push({ key: `skill-${skill.name}`, kind: 'skill', skill });
  }
  if (skills.toolsets.length > 0) {
    rows.push({ key: 'header-toolsets', kind: 'header', title: `工具集（${skills.toolsets.length}）`, description: '点击展开查看工具名。' });
    for (const toolset of skills.toolsets) rows.push({ key: `toolset-${toolset.name}`, kind: 'toolset', toolset });
  }

  const notices = (
    <>
      {skills.offline ? (
        <Banner tone="warn" title="连接中断" icon="cloud-offline-outline">
          无法读取服务器上的技能与工具集。
        </Banner>
      ) : null}
      {skills.skillsError ? (
        <Banner
          tone="error"
          title="技能列表读取失败"
          action={<Button label="重试" variant="ghost" onPress={() => void skills.refresh()} />}
        >
          <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body, lineHeight: theme.font.body * 1.5 }}>
            {skills.skillsError}
            {skills.toolsets.length > 0 ? '\n工具集仍然可用，已照常显示。' : ''}
          </Text>
        </Banner>
      ) : null}
      {skills.toolsetsError ? (
        <Banner
          tone="error"
          title="工具集读取失败"
          action={<Button label="重试" variant="ghost" onPress={() => void skills.refresh()} />}
        >
          <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.body, lineHeight: theme.font.body * 1.5 }}>
            {skills.toolsetsError}
            {skills.skills.length > 0 ? '\n技能列表仍然可用，已照常显示。' : ''}
          </Text>
        </Banner>
      ) : null}
      {skills.error ? (
        <Banner
          tone="error"
          title="读取失败"
          action={<Button label="重试" variant="ghost" onPress={() => void skills.refresh()} />}
        >
          {skills.error}
        </Banner>
      ) : null}
    </>
  );

  if (!skills.server) {
    return (
      <Screen>
        {header}
        <EmptyState
          icon="server-outline"
          title="还没有实例"
          message="先添加一个 Hermes 实例，才能查看它声明的技能与工具集。"
        />
      </Screen>
    );
  }

  if (!skills.canRead) {
    return (
      <Screen>
        {header}
        <View style={{ padding: theme.space.lg }}>
          <Banner tone="info" title="此服务器未开放 Skills 接口">
            当前实例的能力探测结果里没有 skills_api 旗标，因此不显示技能与工具集。升级 Hermes 或在设置里重新检测连接后再试。
          </Banner>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      {header}
      <FlatList
        data={rows}
        extraData={expanded}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ padding: theme.space.lg, gap: theme.space.sm, flexGrow: 1 }}
        ListHeaderComponent={notices}
        ListEmptyComponent={
          <EmptyState
            icon="construct-outline"
            title={skills.skillsError || skills.toolsetsError ? '没有可显示的条目' : '没有声明技能或工具集'}
            message={
              skills.skillsError || skills.toolsetsError
                ? '读取失败的接口见上方提示；可以点「重试」，或先看服务器端日志。'
                : '此实例的 /v1/skills 与 /v1/toolsets 都返回空列表。'
            }
          />
        }
        renderItem={({ item }) => {
          if (item.kind === 'header') {
            return (
              <View style={{ gap: 2, paddingTop: theme.space.sm }}>
                <Text
                  accessibilityRole="header"
                  style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '700' }}
                >
                  {item.title}
                </Text>
                <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>{item.description}</Text>
              </View>
            );
          }
          if (item.kind === 'skill') {
            return (
              <Card style={{ paddingVertical: theme.space.xs, paddingHorizontal: theme.space.md }}>
                <ListRow
                  title={item.skill.name}
                  subtitle={item.skill.description}
                  meta={item.skill.category ? `分类：${item.skill.category}` : undefined}
                  accessibilityLabel={`技能 ${item.skill.name}`}
                />
              </Card>
            );
          }
          const tools = item.toolset.tools ?? [];
          const open = expanded[item.toolset.name] === true;
          return (
            <Card style={{ paddingVertical: theme.space.xs, paddingHorizontal: theme.space.md, gap: theme.space.xs }}>
              <ListRow
                title={item.toolset.label || item.toolset.name}
                subtitle={item.toolset.description}
                meta={`${item.toolset.enabled === false ? '未启用' : '已启用'} · ${
                  item.toolset.configured === false ? '未配置' : '已配置'
                } · ${tools.length} 个工具`}
                accessibilityLabel={`工具集 ${item.toolset.name}`}
                accessibilityHint={tools.length > 0 ? '点击展开或收起工具名' : '此工具集没有工具'}
                onPress={
                  tools.length > 0
                    ? () => setExpanded((current) => ({ ...current, [item.toolset.name]: !open }))
                    : undefined
                }
                right={
                  tools.length > 0 ? (
                    <Ionicons
                      name={open ? 'chevron-up' : 'chevron-down'}
                      size={theme.icon.sm}
                      color={theme.colors.textMuted}
                    />
                  ) : undefined
                }
              />
              {open ? (
                <>
                  <Divider />
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs, paddingVertical: theme.space.sm }}>
                    {tools.map((tool) => (
                      <Badge key={tool} label={tool} mono tone="neutral" />
                    ))}
                  </View>
                </>
              ) : null}
            </Card>
          );
        }}
      />
    </Screen>
  );
}
