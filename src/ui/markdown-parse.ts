/** 纯解析逻辑，无 React Native 依赖，便于在 node:test 中直接验证。 */
/**
 * 极简 Markdown：只处理代码块、标题、列表、引用、段落，以及行内 code/bold/italic/link。
 * 链接不导航（避免恶意 Markdown 触发 deep link），只作为可选中文本展示。
 */
export type MdBlock =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'para'; text: string };

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = line.match(FENCE);
    if (fence) {
      const lang = (fence[1] ?? '').trim();
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        buffer.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过收尾围栏；流式未闭合时直接结束
      blocks.push({ kind: 'code', lang, text: buffer.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        buffer.push((lines[i] ?? '').match(QUOTE)?.[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'quote', text: buffer.join('\n') });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const match = ordered ? current.match(ORDERED) : current.match(BULLET);
        if (!match) break;
        items.push(match[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const buffer: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (current.trim() === '' || FENCE.test(current) || HEADING.test(current) || QUOTE.test(current) || BULLET.test(current) || ORDERED.test(current)) break;
      buffer.push(current);
      i += 1;
    }
    blocks.push({ kind: 'para', text: buffer.join('\n') });
  }
  return blocks;
}

