/**
 * 修复 Expo prebuild 在 Android 上生成的「伪 WebP」启动图标。
 *
 * 根因：@expo/prebuild-config 的 withAndroidIcons 把文件名硬编码成
 * ic_launcher*.webp，但 @expo/image-utils（无论走 sharp 还是 jimp）实际输出的是
 * PNG 字节流（魔数 89 50 4E 47）。部分真机桌面（小米 HyperOS、华为 HarmonyOS、
 * OPPO ColorOS、vivo OriginOS 及部分 Android 13+ 主题引擎）按 .webp 扩展名调用
 * 严格 WebP 解码器时解码失败，直接回退成系统默认的绿色安卓机器人图标。
 *
 * 方案：在 android dangerous mod 链路末尾（确保晚于 withAndroidIcons 执行），
 * 扫描 res/mipmap-* 下的 ic_launcher*.webp，凡魔数为 PNG 的统一改名为 .png，
 * 让扩展名与实际字节格式完全一致；@mipmap/ic_launcher* 引用不带扩展名，天然兼容。
 */
const { withBaseMod } = require('@expo/config-plugins');
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPngFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(PNG_MAGIC.length);
    const bytesRead = fs.readSync(fd, header, 0, PNG_MAGIC.length, 0);
    return bytesRead === PNG_MAGIC.length && header.equals(PNG_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 扫描 Android res 目录下的所有 mipmap-* 密度目录，
 * 将实际内容为 PNG 的 ic_launcher*.webp 原子重命名为 .png。
 * 返回被修复的文件列表（便于日志与单测断言）。
 */
function fixFakeWebpLauncherIcons(androidResDir) {
  if (!fs.existsSync(androidResDir)) return [];
  const fixed = [];
  for (const entry of fs.readdirSync(androidResDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mipmap-')) continue;
    const dir = path.join(androidResDir, entry.name);
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith('ic_launcher') || !file.endsWith('.webp')) continue;
      const webpPath = path.join(dir, file);
      if (!isPngFile(webpPath)) continue;
      const pngPath = webpPath.replace(/\.webp$/, '.png');
      fs.renameSync(webpPath, pngPath);
      fixed.push(path.relative(androidResDir, pngPath));
    }
  }
  return fixed;
}

module.exports = function withAndroidIconFix(config) {
  return withBaseMod(config, {
    platform: 'android',
    mod: 'dangerous',
    isProvider: false,
    async action(modConfig) {
      // 先执行后续 mod（无论 withAndroidIcons 位于栈上还是栈下，都在它写完之后修复）
      const results = await modConfig.modRequest.nextMod(modConfig);
      const resDir = path.join(results.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      fixFakeWebpLauncherIcons(resDir);
      return results;
    },
  });
};

module.exports.fixFakeWebpLauncherIcons = fixFakeWebpLauncherIcons;
module.exports.isPngFile = isPngFile;
