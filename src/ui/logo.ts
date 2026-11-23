/**
 * 应用图标与透明底品牌标识资源。Metro 会把 require('*.png') 变成资源 id；
 * Node 测试环境没有图片 loader，require 会抛错，因此这里兜底为 null，
 * 让引导页和「关于」页在测试里跳过图片而不是崩掉。
 */
export const appIcon: number | null = (() => {
  try {
    return require('../../assets/icon.png') as number;
  } catch {
    return null;
  }
})();

export const logoMark: number | null = (() => {
  try {
    return require('../../assets/logo-mark.png') as number;
  } catch {
    return null;
  }
})();
