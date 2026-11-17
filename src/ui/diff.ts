/**
 * 统一 diff 解析（P2 结构化文件 diff）。
 *
 * 纯函数、不依赖 RN：输入是服务端已脱敏截断的 `ToolEvent.preview` 文本，
 * 输出结构供 ToolCard 渲染。识别失败一律返回 null，调用方回退到纯文本。
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'meta';
  text: string;
}

export interface DiffHunk {
  /** 原样的 `@@ -1,3 +1,4 @@` 头，含可选的函数上下文。 */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  /** 输入超过 DIFF_MAX_CHARS，此文件之后的内容被丢弃。 */
  truncated?: boolean;
}

/** 超长输入只解析前 20k 字符，不抛错。 */
export const DIFF_MAX_CHARS = 20_000;

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** `--- a/x\t2024-01-01` → `x`；`/dev/null` 原样保留。 */
function cleanPath(raw: string): string {
  const path = (raw.split('\t')[0] ?? '').trim();
  return path.replace(/^[ab]\//, '');
}

export function parseDiff(text: string): DiffFile[] | null {
  if (!text.trim()) return null;
  const truncated = text.length > DIFF_MAX_CHARS;
  const source = truncated ? text.slice(0, DIFF_MAX_CHARS) : text;

  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  // 按 hunk 头声明的行数消费，避免把以 `--- `/`+++ ` 开头的增删行误判成文件头
  let oldLeft = 0;
  let newLeft = 0;
  let sawHunk = false;
  let sawChange = false;
  let oldPath = '';

  const open = (path: string): DiffFile => {
    const next: DiffFile = { path, hunks: [] };
    files.push(next);
    hunk = null;
    return next;
  };

  for (const line of source.split('\n')) {
    // `\ No newline at end of file` 出现在 hunk 最后一行之后，此时行数已消费完
    if (hunk && line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line });
      continue;
    }
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const head = line[0] ?? '';
      if (head === '+') {
        hunk.lines.push({ kind: 'add', text: line.slice(1) });
        newLeft -= 1;
        sawChange = true;
        continue;
      }
      if (head === '-') {
        hunk.lines.push({ kind: 'del', text: line.slice(1) });
        oldLeft -= 1;
        sawChange = true;
        continue;
      }
      // ' ' 前缀是上下文；空行只可能来自被截断的尾部，按上下文处理
      hunk.lines.push({ kind: 'context', text: line.slice(1) });
      oldLeft -= 1;
      newLeft -= 1;
      continue;
    }
    hunk = null;

    if (line.startsWith('diff --git ')) {
      const matched = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = open(matched ? cleanPath(matched[2] ?? '') : cleanPath(line.slice('diff --git '.length)));
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = cleanPath(line.slice(4));
      const target = path === '/dev/null' ? oldPath : path;
      // `diff --git` 已经开好文件时只补精确路径，否则（裸 --- / +++）新开一个
      if (file && file.hunks.length === 0) file.path = target;
      else file = open(target);
      continue;
    }
    if (line.startsWith('@@')) {
      const matched = HUNK_HEADER.exec(line);
      oldLeft = matched ? Number(matched[1] ?? 1) : Number.POSITIVE_INFINITY;
      newLeft = matched ? Number(matched[2] ?? 1) : Number.POSITIVE_INFINITY;
      if (!file) file = open('');
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      sawHunk = true;
      continue;
    }
    // index / mode / Binary files 等 hunk 外元信息忽略
  }

  if (!sawHunk || !sawChange) return null;
  const kept = files.filter((item) => item.hunks.length > 0);
  if (kept.length === 0) return null;
  if (truncated) kept[kept.length - 1]!.truncated = true;
  return kept;
}

export function diffStats(files: DiffFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add') added += 1;
        else if (line.kind === 'del') removed += 1;
      }
    }
  }
  return { added, removed };
}
