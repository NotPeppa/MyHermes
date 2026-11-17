import { Text, View } from 'react-native';
import { DIFF_MAX_CHARS, diffStats, type DiffFile, type DiffLine } from './diff';
import { useTheme } from './theme';

/** 单次渲染行数上限：超出只显示提示，避免长 diff 卡顿。 */
export const MAX_RENDER_LINES = 200;

/** 颜色不是唯一信息：增删行保留前缀字符。 */
const PREFIX: Record<DiffLine['kind'], string> = { add: '+', del: '-', context: ' ', meta: '' };

interface HunkPlan {
  header: string;
  lines: DiffLine[];
}

interface FilePlan {
  path: string;
  added: number;
  removed: number;
  truncated: boolean;
  hunks: HunkPlan[];
}

function planFiles(files: DiffFile[]): FilePlan[] {
  let budget = MAX_RENDER_LINES;
  const plans: FilePlan[] = [];
  for (const file of files) {
    const hunks: HunkPlan[] = [];
    for (const hunk of file.hunks) {
      if (budget <= 0) break;
      const lines = hunk.lines.slice(0, budget);
      budget -= lines.length;
      hunks.push({ header: hunk.header, lines });
    }
    if (hunks.length === 0) break;
    const { added, removed } = diffStats([file]);
    plans.push({ path: file.path || '（未知文件）', added, removed, truncated: file.truncated === true, hunks });
  }
  return plans;
}

function diffLineCount(files: DiffFile[]): number {
  return files.reduce((sum, file) => sum + file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0), 0);
}

/** 结构化 diff：文件名 + `+N −M` + hunk 头 + 着色行，全部用 Text（无图片）。 */
export function DiffView({ files }: { files: DiffFile[] }) {
  const theme = useTheme();
  const total = diffLineCount(files);
  const plans = planFiles(files);
  const tone: Record<DiffLine['kind'], string> = {
    add: theme.colors.success,
    del: theme.colors.danger,
    context: theme.colors.textMuted,
    meta: theme.colors.textMuted,
  };
  return (
    <View style={{ gap: theme.space.md }}>
      {plans.map((file, fileIndex) => (
        <View key={`${file.path}-${fileIndex}`} style={{ gap: theme.space.xs }}>
          <View
            accessible
            accessibilityLabel={`文件 ${file.path}，新增 ${file.added} 行，删除 ${file.removed} 行`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}
          >
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                color: theme.colors.text,
                fontSize: theme.font.caption,
                fontFamily: theme.fontFamily.mono,
                fontWeight: '600',
              }}
            >
              {file.path}
            </Text>
            <Text
              style={{
                color: theme.colors.textMuted,
                fontSize: theme.font.caption,
                fontFamily: theme.fontFamily.mono,
              }}
            >
              {`+${file.added} −${file.removed}`}
            </Text>
          </View>
          {file.hunks.map((hunk, hunkIndex) => (
            <View key={`${hunkIndex}-${hunk.header}`} style={{ gap: 1 }}>
              <Text
                style={{
                  color: theme.colors.textMuted,
                  fontSize: theme.font.code,
                  lineHeight: theme.font.code * 1.5,
                  fontFamily: theme.fontFamily.mono,
                }}
              >
                {hunk.header}
              </Text>
              {hunk.lines.map((line, lineIndex) => (
                <Text
                  key={lineIndex}
                  style={{
                    color: tone[line.kind],
                    fontSize: theme.font.code,
                    lineHeight: theme.font.code * 1.5,
                    fontFamily: theme.fontFamily.mono,
                    fontStyle: line.kind === 'meta' ? 'italic' : 'normal',
                  }}
                >
                  {PREFIX[line.kind]}
                  {line.text}
                </Text>
              ))}
            </View>
          ))}
          {file.truncated ? (
            <Text style={{ color: theme.colors.warning, fontSize: theme.font.caption }}>
              {`预览已截断（超过 ${Math.round(DIFF_MAX_CHARS / 1000)}k 字符）`}
            </Text>
          ) : null}
        </View>
      ))}
      {total > MAX_RENDER_LINES ? (
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textMuted, fontSize: theme.font.caption }}>
          {`已截断，共 ${total} 行`}
        </Text>
      ) : null}
    </View>
  );
}
