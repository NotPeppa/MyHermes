/**
 * Android 长按图标的静态快捷方式（App Shortcuts）。
 *
 * 只做两件事：往 AndroidManifest 的 <application> 里挂 meta-data，并生成
 * res/xml/shortcuts.xml 与对应字符串资源。不写任何 Kotlin——快捷方式本身就是
 * 一个 VIEW intent，指向 App 的 MainActivity，由深链路由接管。
 */
const { withAndroidManifest, withDangerousMod, withStringsXml, AndroidConfig } = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const SHORTCUTS_RESOURCE = 'shortcuts';

/**
 * 快捷方式定义：id、标签、深链。改这里就够了。
 * 注意：<shortcut> 没有 android:rank 属性（排序只能靠 ShortcutManager.setRank），
 * 写进 XML 会直接导致 aapt 链接失败。
 */
const SHORTCUTS = [
  {
    id: 'new_session',
    shortLabel: '新建会话',
    longLabel: '在 Hermes 上新建会话',
    schemePath: 'sessions',
  },
  {
    id: 'jobs',
    shortLabel: '任务中心',
    longLabel: '查看定时与后台任务',
    schemePath: 'jobs',
  },
  {
    id: 'send_clipboard',
    shortLabel: '发送剪贴板',
    longLabel: '把剪贴板内容发给 Hermes',
    schemePath: 'send?source=clipboard',
  },
];

const stringName = (id, kind) => `shortcut_${id}_${kind}`;

/** 纯函数：生成 shortcuts.xml，便于单测。 */
function buildShortcutsXml({ packageName, scheme, shortcuts = SHORTCUTS }) {
  const entries = shortcuts
    .map(
      (shortcut) => `  <shortcut
    android:shortcutId="${shortcut.id}"
    android:enabled="true"
    android:icon="@mipmap/ic_launcher"
    android:shortcutShortLabel="@string/${stringName(shortcut.id, 'short')}"
    android:shortcutLongLabel="@string/${stringName(shortcut.id, 'long')}">
    <intent
      android:action="android.intent.action.VIEW"
      android:targetPackage="${packageName}"
      android:targetClass="${packageName}.MainActivity"
      android:data="${scheme}://${shortcut.schemePath}" />
    <categories android:name="android.shortcut.conversation" />
  </shortcut>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${entries}
</shortcuts>
`;
}

module.exports = function withAndroidShortcuts(config, options = {}) {
  const shortcuts = options.shortcuts ?? SHORTCUTS;
  const scheme = options.scheme ?? config.scheme ?? 'myhermes';

  config = withStringsXml(config, (mod) => {
    // resources 是对象（{ string: [...] }），不是数组
    const resources = mod.modResults.resources ?? (mod.modResults.resources = {});
    const strings = resources.string ?? (resources.string = []);
    for (const shortcut of shortcuts) {
      for (const [kind, value] of [['short', shortcut.shortLabel], ['long', shortcut.longLabel]]) {
        const name = stringName(shortcut.id, kind);
        const existing = strings.find((item) => item.$?.name === name);
        if (existing) existing._ = value;
        else strings.push({ $: { name }, _: value });
      }
    }
    return mod;
  });

  config = withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application['meta-data'] = application['meta-data'] ?? [];
    const name = 'android.app.shortcuts';
    const existing = application['meta-data'].find((item) => item.$['android:name'] === name);
    const entry = { $: { 'android:name': name, 'android:resource': `@xml/${SHORTCUTS_RESOURCE}` } };
    if (existing) Object.assign(existing, entry);
    else application['meta-data'].push(entry);
    return mod;
  });

  config = withDangerousMod(config, [
    'android',
    async (mod) => {
      const packageName = mod.android?.package;
      if (!packageName) return mod;
      const resDir = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(path.join(resDir, `${SHORTCUTS_RESOURCE}.xml`), buildShortcutsXml({ packageName, scheme, shortcuts }));
      return mod;
    },
  ]);

  return config;
};

module.exports.buildShortcutsXml = buildShortcutsXml;
module.exports.SHORTCUTS = SHORTCUTS;
