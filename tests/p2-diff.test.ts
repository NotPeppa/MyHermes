/**
 * P2 结构化文件 diff：纯解析逻辑（node:test，无 RN 依赖）。
 * 运行：npx tsx --test tests/p2-diff.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DIFF_MAX_CHARS, diffStats, parseDiff } from '../src/ui/diff';

const SINGLE = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  " import a from 'a';",
  '-const x = 1;',
  '+const x = 2;',
  '+const y = 3;',
  ' export default x;',
].join('\n');

test('单文件 diff 解析出路径、hunk 头与行类型', () => {
  const files = parseDiff(SINGLE);
  assert.ok(files, '应识别为 diff');
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, 'src/app.ts');
  assert.equal(files[0]!.hunks.length, 1);
  assert.equal(files[0]!.hunks[0]!.header, '@@ -1,3 +1,4 @@');
  assert.deepEqual(
    files[0]!.hunks[0]!.lines.map((line) => line.kind),
    ['context', 'del', 'add', 'add', 'context'],
  );
  assert.equal(files[0]!.hunks[0]!.lines[1]!.text, 'const x = 1;');
});

test('diffStats 统计新增与删除行数', () => {
  const files = parseDiff(SINGLE);
  assert.ok(files);
  assert.deepEqual(diffStats(files), { added: 2, removed: 1 });
});

test('diff --git 多文件：每个文件各自带 hunk', () => {
  const text = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old a',
    '+new a',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old b',
    '+new b',
  ].join('\n');
  const files = parseDiff(text);
  assert.ok(files);
  assert.deepEqual(files.map((file) => file.path), ['a.txt', 'b.txt']);
  assert.equal(files[0]!.hunks[0]!.header, '@@ -1 +1 @@');
  assert.deepEqual(diffStats(files), { added: 2, removed: 2 });
});

test('\\ No newline at end of file 记为 meta 行，不计入统计', () => {
  const text = [
    '--- a/x',
    '+++ b/x',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '\\ No newline at end of file',
  ].join('\n');
  const files = parseDiff(text);
  assert.ok(files);
  const lines = files[0]!.hunks[0]!.lines;
  assert.equal(lines[lines.length - 1]!.kind, 'meta');
  assert.equal(lines[lines.length - 1]!.text, '\\ No newline at end of file');
  assert.deepEqual(diffStats(files), { added: 1, removed: 1 });
});

test('hunk 内以 --- / +++ 开头的增删行不被误判为文件头', () => {
  const text = ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '--- 分隔线', '+++ 分隔线', ' end'].join('\n');
  const files = parseDiff(text);
  assert.ok(files);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, 'x');
  assert.deepEqual(
    files[0]!.hunks[0]!.lines.map((line) => line.kind),
    ['del', 'add', 'context'],
  );
});

test('空输入与非 diff 文本返回 null', () => {
  assert.equal(parseDiff(''), null);
  assert.equal(parseDiff('   \n  '), null);
  assert.equal(parseDiff('构建成功，用时 3.2s'), null);
  assert.equal(parseDiff('+ 只是加号开头的普通日志\n- 减号也一样'), null);
});

test('只有 @@ 没有 +/- 行返回 null（无法确认是 diff）', () => {
  const text = ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' one', ' two'].join('\n');
  assert.equal(parseDiff(text), null);
});

test('超过 20k 字符只解析前 20k 并标记 truncated，不抛错', () => {
  const body = Array.from({ length: 1200 }, (_, index) => `+第 ${index} 行内容填充填充填充`).join('\n');
  const text = ['--- a/big.txt', '+++ b/big.txt', '@@ -1,1200 +1,1200 @@', body].join('\n');
  assert.ok(text.length > DIFF_MAX_CHARS);
  const files = parseDiff(text);
  assert.ok(files);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.truncated, true);
  const parsed = files[0]!.hunks[0]!.lines.length;
  assert.ok(parsed > 0 && parsed < 1200, `应只解析一部分，实际 ${parsed} 行`);
});

test('未截断时不带 truncated 标记', () => {
  const files = parseDiff(SINGLE);
  assert.ok(files);
  assert.equal(files[0]!.truncated, undefined);
});
