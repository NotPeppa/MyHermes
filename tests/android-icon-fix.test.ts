import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fixFakeWebpLauncherIcons, isPngFile } = require('../plugins/withAndroidIconFix') as {
  fixFakeWebpLauncherIcons: (resDir: string) => string[];
  isPngFile: (filePath: string) => boolean;
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP_BYTES = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');

test('伪 WebP（PNG 字节流）的 ic_launcher*.webp 会被重命名为 .png 且不留重复文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myhermes-icon-fix-'));
  try {
    const xxxhdpi = path.join(tmp, 'mipmap-xxxhdpi');
    const anydpi = path.join(tmp, 'mipmap-anydpi-v26');
    fs.mkdirSync(xxxhdpi, { recursive: true });
    fs.mkdirSync(anydpi, { recursive: true });

    fs.writeFileSync(path.join(xxxhdpi, 'ic_launcher.webp'), PNG_BYTES);
    fs.writeFileSync(path.join(xxxhdpi, 'ic_launcher_foreground.webp'), PNG_BYTES);
    fs.writeFileSync(path.join(xxxhdpi, 'ic_launcher_round.webp'), PNG_BYTES);
    fs.writeFileSync(path.join(xxxhdpi, 'ic_launcher_monochrome.webp'), PNG_BYTES);
    fs.writeFileSync(path.join(xxxhdpi, 'other.webp'), PNG_BYTES);
    fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'), '<adaptive-icon/>');

    const fixed = fixFakeWebpLauncherIcons(tmp);
    assert.equal(fixed.length, 4);
    for (const base of ['ic_launcher', 'ic_launcher_foreground', 'ic_launcher_round', 'ic_launcher_monochrome']) {
      assert.equal(fs.existsSync(path.join(xxxhdpi, `${base}.webp`)), false, `${base}.webp 不应残留`);
      assert.equal(fs.existsSync(path.join(xxxhdpi, `${base}.png`)), true, `${base}.png 应存在`);
      assert.equal(isPngFile(path.join(xxxhdpi, `${base}.png`)), true);
    }
    assert.equal(fs.existsSync(path.join(xxxhdpi, 'other.webp')), true, '非启动图标不受影响');
    assert.equal(fs.existsSync(path.join(anydpi, 'ic_launcher.xml')), true, 'adaptive-icon XML 不受影响');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('真正的 WebP 文件保持原扩展名不变', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myhermes-icon-fix-webp-'));
  try {
    const mdpi = path.join(tmp, 'mipmap-mdpi');
    fs.mkdirSync(mdpi, { recursive: true });
    const target = path.join(mdpi, 'ic_launcher.webp');
    fs.writeFileSync(target, WEBP_BYTES);

    const fixed = fixFakeWebpLauncherIcons(tmp);
    assert.deepEqual(fixed, []);
    assert.equal(fs.existsSync(target), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
