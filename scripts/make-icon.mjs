#!/usr/bin/env node
/**
 * 生成应用图标（纯 Node，无第三方依赖）。
 *
 * 设计：深色底 + 圆角对话气泡 + 两行「流式文本」+ 光标点，
 * 表达「和 Agent 流式对话」。所有形状用 4× 超采样再降采样，边缘干净。
 *
 * 用法：node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');

const COLORS = {
  bg: [15, 23, 42], // #0F172A
  bgDeep: [8, 13, 26],
  accent: [34, 197, 94], // #22C55E
  accentSoft: [74, 222, 128], // #4ADE80
  ink: [11, 18, 32], // #0B1220
};

const SS = 4; // 超采样倍数

// ---------- 画布 ----------
const canvas = (size) => ({ size, px: new Float32Array(size * size * 4) });

const blend = (c, x, y, [r, g, b], a) => {
  if (a <= 0 || x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  const srcA = Math.min(1, a);
  const dstA = c.px[i + 3];
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  c.px[i] = (r * srcA + c.px[i] * dstA * (1 - srcA)) / outA;
  c.px[i + 1] = (g * srcA + c.px[i + 1] * dstA * (1 - srcA)) / outA;
  c.px[i + 2] = (b * srcA + c.px[i + 2] * dstA * (1 - srcA)) / outA;
  c.px[i + 3] = outA;
};

/** 圆角矩形（坐标按 0..1 归一化） */
const roundRect = (c, x0, y0, x1, y1, radius, color, alpha = 1) => {
  const s = c.size;
  const [ax, ay, bx, by] = [x0 * s, y0 * s, x1 * s, y1 * s];
  const r = radius * s;
  for (let y = Math.floor(ay); y < Math.ceil(by); y += 1) {
    for (let x = Math.floor(ax); x < Math.ceil(bx); x += 1) {
      const cx = Math.min(Math.max(x + 0.5, ax + r), bx - r);
      const cy = Math.min(Math.max(y + 0.5, ay + r), by - r);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) blend(c, x, y, color, alpha);
    }
  }
};

/** 三角形（用于气泡尾巴），坐标归一化 */
const triangle = (c, p1, p2, p3, color, alpha = 1) => {
  const s = c.size;
  const pts = [p1, p2, p3].map(([x, y]) => [x * s, y * s]);
  const minX = Math.floor(Math.min(...pts.map((p) => p[0])));
  const maxX = Math.ceil(Math.max(...pts.map((p) => p[0])));
  const minY = Math.floor(Math.min(...pts.map((p) => p[1])));
  const maxY = Math.ceil(Math.max(...pts.map((p) => p[1])));
  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d1 = sign(px, py, pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
      const d2 = sign(px, py, pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
      const d3 = sign(px, py, pts[2][0], pts[2][1], pts[0][0], pts[0][1]);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) blend(c, x, y, color, alpha);
    }
  }
};

const circle = (c, cx, cy, radius, color, alpha = 1) => {
  const s = c.size;
  const [x0, y0, r] = [cx * s, cy * s, radius * s];
  for (let y = Math.floor(y0 - r); y < Math.ceil(y0 + r); y += 1) {
    for (let x = Math.floor(x0 - r); x < Math.ceil(x0 + r); x += 1) {
      const dx = x + 0.5 - x0;
      const dy = y + 0.5 - y0;
      if (dx * dx + dy * dy <= r * r) blend(c, x, y, color, alpha);
    }
  }
};

// ---------- 图形 ----------
/** 在 0..1 坐标系里画标记；scale 用于 Android 自适应图标的安全区缩放 */
const drawMark = (c, scale = 1) => {
  const t = (v) => 0.5 + (v - 0.5) * scale;
  const rect = (x0, y0, x1, y1, r, color) => roundRect(c, t(x0), t(y0), t(x1), t(y1), r * scale, color);

  // 气泡主体
  rect(0.16, 0.19, 0.84, 0.65, 0.16, COLORS.accent);
  // 气泡尾巴（左下）
  triangle(c, [t(0.27), t(0.56)], [t(0.27), t(0.75)], [t(0.45), t(0.56)], COLORS.accent);
  // 两行「文本」
  rect(0.29, 0.305, 0.71, 0.365, 0.03, COLORS.ink);
  rect(0.29, 0.435, 0.55, 0.495, 0.03, COLORS.ink);
  // 流式光标
  circle(c, t(0.615), t(0.465), 0.032 * scale, COLORS.accentSoft);
};

const background = (c) => {
  // 深色底 + 顶部轻微提亮，避免纯色发闷
  const s = c.size;
  for (let y = 0; y < s; y += 1) {
    const k = y / s;
    const color = [
      COLORS.bg[0] + (COLORS.bgDeep[0] - COLORS.bg[0]) * k,
      COLORS.bg[1] + (COLORS.bgDeep[1] - COLORS.bg[1]) * k,
      COLORS.bg[2] + (COLORS.bgDeep[2] - COLORS.bg[2]) * k,
    ];
    for (let x = 0; x < s; x += 1) blend(c, x, y, color, 1);
  }
};

// ---------- 降采样 + PNG ----------
const downsample = (c) => {
  const out = canvas(c.size / SS);
  const s = out.size;
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * c.size + (x * SS + sx)) * 4;
          const alpha = c.px[i + 3];
          r += c.px[i] * alpha;
          g += c.px[i + 1] * alpha;
          b += c.px[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const i = (y * s + x) * 4;
      out.px[i] = a > 0 ? r / a : 0;
      out.px[i + 1] = a > 0 ? g / a : 0;
      out.px[i + 2] = a > 0 ? b / a : 0;
      out.px[i + 3] = a / n;
    }
  }
  return out;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const encodePng = (c) => {
  const s = c.size;
  const raw = Buffer.alloc((s * 4 + 1) * s);
  for (let y = 0; y < s; y += 1) {
    raw[y * (s * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < s; x += 1) {
      const i = (y * s + x) * 4;
      const o = y * (s * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(Math.min(255, Math.max(0, c.px[i])));
      raw[o + 1] = Math.round(Math.min(255, Math.max(0, c.px[i + 1])));
      raw[o + 2] = Math.round(Math.min(255, Math.max(0, c.px[i + 2])));
      raw[o + 3] = Math.round(Math.min(255, Math.max(0, c.px[i + 3] * 255)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const render = ({ size, withBackground, markScale = 1 }) => {
  const c = canvas(size * SS);
  if (withBackground) background(c);
  drawMark(c, markScale);
  return encodePng(downsample(c));
};

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon.png', { size: 1024, withBackground: true }],
  // Android 自适应图标：前景只占中间 66%，四周留给系统裁切
  // 部分国产桌面会把自适应图标前景放大后再套圆形遮罩，留足余量（0.5 而非 0.66）
  ['adaptive-icon.png', { size: 1024, withBackground: false, markScale: 0.5 }],
  ['splash-icon.png', { size: 512, withBackground: false, markScale: 0.92 }],
  ['favicon.png', { size: 48, withBackground: true }],
  // 应用内展示用：透明底、紧贴标记，可放在任意卡片背景上
  ['logo-mark.png', { size: 256, withBackground: false, markScale: 1.12 }],
];
for (const [name, options] of files) {
  writeFileSync(join(OUT, name), render(options));
  console.log(`assets/${name}  ${options.size}×${options.size}`);
}
