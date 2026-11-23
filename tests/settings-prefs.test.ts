/**
 * 设置偏好：显示工具调用开关的读写与默认值。
 * 运行：npx tsx --test tests/settings-prefs.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Repository } from '../src/domain/contracts';
import {
  CACHE_ENABLED_KEY,
  SHOW_TOOL_CALLS_KEY,
  readCacheEnabled,
  readShowToolCalls,
  readThemePreference,
  writeCacheEnabled,
  writeShowToolCalls,
  writeThemePreference,
} from '../src/features/settings/prefs';

/** 只实现 getSetting / setSetting 的最小桩，偏好函数只碰这两个方法。 */
function stubRepository(initial: Record<string, string> = {}): Repository {
  const settings = new Map(Object.entries(initial));
  return {
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
      settings.set(key, value);
    },
  } as unknown as Repository;
}

test('显示工具调用默认开启', async () => {
  assert.equal(await readShowToolCalls(stubRepository()), true);
});

test('显示工具调用可读回写入的值', async () => {
  const repository = stubRepository();
  await writeShowToolCalls(repository, false);
  assert.equal(await readShowToolCalls(repository), false);

  await writeShowToolCalls(repository, true);
  assert.equal(await readShowToolCalls(repository), true);
});

test('只有显式 false 才关闭，其它脏值按开启处理', async () => {
  assert.equal(await readShowToolCalls(stubRepository({ [SHOW_TOOL_CALLS_KEY]: 'false' })), false);
  for (const dirty of ['', '0', 'no', 'null', 'undefined']) {
    assert.equal(
      await readShowToolCalls(stubRepository({ [SHOW_TOOL_CALLS_KEY]: dirty })),
      true,
      `脏值 ${JSON.stringify(dirty)} 应视为开启`,
    );
  }
});

test('开关与缓存、主题偏好互不影响', async () => {
  const repository = stubRepository();
  await writeShowToolCalls(repository, false);
  await writeCacheEnabled(repository, false);
  await writeThemePreference(repository, 'dark');

  assert.equal(await readShowToolCalls(repository), false);
  assert.equal(await readCacheEnabled(repository), false);
  assert.equal(await readThemePreference(repository), 'dark');

  // 恢复开关不应连带改掉其它偏好
  await writeShowToolCalls(repository, true);
  assert.equal(await readCacheEnabled(repository), false);
  assert.equal(await readThemePreference(repository), 'dark');
  assert.equal(await repository.getSetting(CACHE_ENABLED_KEY), 'false');
});
