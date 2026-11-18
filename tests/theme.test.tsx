/**
 * 外观偏好：跟随系统 / 强制浅色 / 强制深色。
 * 深色主题必须在系统为浅色时也能生效（用户手动选择）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getThemePreference, resolveTheme, setThemePreference, themes } from '../src/ui/theme';

test('跟随系统：按系统配色选择主题', () => {
  assert.equal(resolveTheme('system', 'dark').scheme, 'dark');
  assert.equal(resolveTheme('system', 'light').scheme, 'light');
  assert.equal(resolveTheme('system', null).scheme, 'light', '系统未报告时回落浅色');
});

test('强制偏好覆盖系统配色', () => {
  assert.equal(resolveTheme('dark', 'light').scheme, 'dark', '系统浅色时仍能强制深色');
  assert.equal(resolveTheme('light', 'dark').scheme, 'light');
  assert.equal(resolveTheme('dark', 'light').colors.bg, themes.dark.colors.bg);
});

test('深色主题的正文与背景对比度足够（WCAG AA）', () => {
  const luminance = (hex: string): number => {
    const value = hex.replace('#', '');
    const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const { colors } = themes.dark;
  assert.ok(contrast(colors.text, colors.bg) >= 4.5, `正文对比度不足：${contrast(colors.text, colors.bg).toFixed(2)}`);
  assert.ok(contrast(colors.text, colors.surface) >= 4.5);
  assert.ok(contrast(colors.textMuted, colors.bg) >= 3, '次要文字至少 3:1');
});

test('偏好 store：写入后读取一致，重复写入不抖动', () => {
  setThemePreference('dark');
  assert.equal(getThemePreference(), 'dark');
  setThemePreference('dark');
  assert.equal(getThemePreference(), 'dark');
  setThemePreference('system');
  assert.equal(getThemePreference(), 'system');
});
