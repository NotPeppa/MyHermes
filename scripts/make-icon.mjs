#!/usr/bin/env node
/**
 * 生成 MyHermes 全套应用图标与品牌矢量源（纯 Node，无第三方依赖）。
 *
 * 设计概念：「赫尔墨斯之翼 H」（Winged H + AI Spark）
 * - 左右对称的几何飞翼与建筑感 H 立柱融合，体现 Hermes（信使之神）的速度与直连；
 * - 中央微拱横梁赋予向上飞升的动势与层次感；
 * - 翼冠中央的四芒星火（AI Spark）代表自主推理与流式响应的 Agent 核心；
 * - 配色严格对齐 src/ui/theme.tsx：深邃午夜蓝底（#0B1120 / #0F172A）+ 翡翠薄荷绿渐变（#6EE7B7 → #22C55E → #059669）。
 *
 * 使用解析 SDF（有向距离场）+ 4× 超采样抗锯齿，边缘锐利、小尺寸清晰、支持纯色单色剪影。
 *
 * 用法：node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');

const SS = 4; // 4× 超采样

// ---------- 颜色工具 ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const mixColor = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];

const PALETTE = {
  bgTop: [22, 34, 58], // #16223A
  bgMid: [11, 17, 32], // #0B1120 (theme.dark.colors.bg)
  bgCorner: [5, 9, 20], // #050914
  aura: [34, 197, 94], // #22C55E
  auraCyan: [16, 185, 129], // #10B981
  mintBright: [167, 243, 208], // #A7F3D0
  emeraldLight: [74, 222, 128], // #4ADE80
  emeraldMain: [34, 197, 94], // #22C55E
  emeraldDeep: [16, 185, 129], // #10B981
  emeraldShadow: [5, 150, 105], // #059669
  sparkCore: [240, 253, 244], // #F0FDF4
  sparkEdge: [110, 231, 183], // #6EE7B7
  white: [255, 255, 255],
};

// ---------- 解析 SDF 图元 ----------
/** 点到多边形（顺时针或逆时针均可）的有向距离：内部为负、外部为正 */
const sdPolygon = (px, py, pts) => {
  let d = Infinity;
  let s = 1;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const ex = xj - xi;
    const ey = yj - yi;
    const wx = px - xi;
    const wy = py - yi;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= yi;
    const c2 = py < yj;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
};

/** 圆角多边形 SDF（向内缩进 r 再向外膨出 r，使尖角圆润且外轮廓不膨胀） */
const sdRoundedPoly = (px, py, pts, r) => sdPolygon(px, py, pts) - r;

/** 四芒星（超椭圆 / Astroid 变体）SDF，用于 AI Spark */
const sdFourPointStar = (px, py, cx, cy, rx, ry, power = 0.56) => {
  const ax = Math.abs(px - cx) / rx;
  const ay = Math.abs(py - cy) / ry;
  const val = Math.pow(ax + 1e-6, power) + Math.pow(ay + 1e-6, power);
  // 近似欧氏距离，供抗锯齿使用
  const f = Math.pow(val, 1 / power) - 1;
  return f * Math.min(rx, ry) * 0.55;
};

/** 镜像多边形（关于 x = 0.5 对称） */
const mirrorX = (pts) => pts.map(([x, y]) => [1 - x, y]);

// ---------- 品牌几何定义（归一化 0..1 坐标系） ----------
// 所有多边形坐标已经考虑圆角半径 r 的外扩，保证最终视觉外框严格落在 [0.11..0.89] × [0.16..0.84]

const R_WING = 0.024;
const R_PILLAR = 0.026;
const R_BAR = 0.022;

// 左侧立柱 + 主翼合并为单一流畅轮廓（彻底消除肩部台阶，顶缘沿 23° 凌厉展翼）
const LEFT_WINGED_PILLAR = [
  [0.132, 0.252], // 上翼尖（前缘最高点）
  [0.376, 0.348], // 立柱内肩（平滑直连，无台阶）
  [0.376, 0.784], // 立柱内底
  [0.340, 0.784], // 底部斜切起点
  [0.292, 0.732], // 立柱外底斜切收锋
  [0.292, 0.418], // 主翼下缘与立柱交汇
  [0.194, 0.372], // 主翼尾缘转折（流线羽翼收束）
];
const RIGHT_WINGED_PILLAR = mirrorX(LEFT_WINGED_PILLAR);

// 左侧副翼（下翼羽：与主翼尾缘严格平行，留出清晰斜向负空间通道，48px 仍分明）
const LEFT_LOWER_WING = [
  [0.184, 0.456],
  [0.330, 0.518],
  [0.330, 0.594],
  [0.232, 0.548],
];
const RIGHT_LOWER_WING = mirrorX(LEFT_LOWER_WING);

// 中央飞翼横梁（微拱上升的 V/Chevron 桥，呼应展翅动势，把左右立柱连成清晰的 H）
const CROSSBAR = [
  [0.358, 0.562],
  [0.5, 0.506],
  [0.642, 0.562],
  [0.642, 0.646],
  [0.5, 0.592],
  [0.358, 0.646],
];

// 翼冠中央 AI Spark（饱满的四芒星火，兼顾 1024px 精致度与 48px 清晰度）
const SPARK = { cx: 0.5, cy: 0.272, rx: 0.088, ry: 0.100, power: 0.67 };

// ---------- 像素画布 ----------
const canvas = (size) => ({ size, px: new Float32Array(size * size * 4) });

const blendAt = (c, idx, [r, g, b], a) => {
  if (a <= 0) return;
  const srcA = Math.min(1, a);
  const dstA = c.px[idx + 3];
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  c.px[idx] = (r * srcA + c.px[idx] * dstA * (1 - srcA)) / outA;
  c.px[idx + 1] = (g * srcA + c.px[idx + 1] * dstA * (1 - srcA)) / outA;
  c.px[idx + 2] = (b * srcA + c.px[idx + 2] * dstA * (1 - srcA)) / outA;
  c.px[idx + 3] = outA;
};

/** 渲染单像素（x, y 为 0..1 坐标，aa 为抗锯齿半宽） */
const evalBackground = (u, v) => {
  // 垂直主梯度：顶部微亮深海军蓝 → 底部深黑蓝
  const base = mixColor(PALETTE.bgTop, PALETTE.bgMid, smoothstep(0.0, 0.62, v));
  // 四角微压暗，聚焦中心
  const dx = u - 0.5;
  const dy = v - 0.5;
  const distCenter = Math.hypot(dx, dy);
  let col = mixColor(base, PALETTE.bgCorner, smoothstep(0.28, 0.78, distCenter));

  // 中心翡翠微光（克制、通透，避免荧光塑料感）
  const glowDist = Math.hypot(u - 0.5, (v - 0.46) * 1.08);
  const glow = Math.exp(-glowDist * glowDist * 7.2) * 0.24;
  col = mixColor(col, PALETTE.aura, glow);

  // 翼冠上方一丝极淡的薄荷星辉
  const sparkGlow = Math.exp(-((u - 0.5) ** 2 + (v - 0.275) ** 2) * 26) * 0.18;
  col = mixColor(col, PALETTE.mintBright, sparkGlow);

  // 极细微的装饰同心轨道弧（仅 4% 不透明度，增加现代工具感而不抢主形）
  const ringDist = Math.abs(distCenter - 0.415);
  const ring = (1 - smoothstep(0.0, 0.0045, ringDist)) * 0.055 * (1 - smoothstep(0.35, 0.85, v));
  col = mixColor(col, PALETTE.mintBright, ring);

  return col;
};

/** 计算标志图形颜色与透明度（支持全彩渐变与纯白单色模式） */
const evalMark = (u, v, aa, monochrome, withShadow) => {
  // 1. 组合主体 SDF（一体化飞翼立柱 + 副翼 + 横梁 + 星火）
  const dMainL = sdRoundedPoly(u, v, LEFT_WINGED_PILLAR, R_PILLAR);
  const dMainR = sdRoundedPoly(u, v, RIGHT_WINGED_PILLAR, R_PILLAR);
  const dLowerL = sdRoundedPoly(u, v, LEFT_LOWER_WING, R_WING);
  const dLowerR = sdRoundedPoly(u, v, RIGHT_LOWER_WING, R_WING);
  const dBar = sdRoundedPoly(u, v, CROSSBAR, R_BAR);
  const dSpark = sdFourPointStar(u, v, SPARK.cx, SPARK.cy, SPARK.rx, SPARK.ry, SPARK.power);

  const dFront = Math.min(dMainL, dMainR);
  const dLower = Math.min(dLowerL, dLowerR);
  const dAll = Math.min(dFront, dLower, dBar, dSpark);

  if (monochrome) {
    // Android 13+ Material You 单色主题图标：纯白剪影，利用负空间天然清晰
    const cov = 1 - smoothstep(-aa, aa, dAll);
    return { r: 255, g: 255, b: 255, a: cov };
  }

  let outR = 0;
  let outG = 0;
  let outB = 0;
  let outA = 0;
  const over = (col, a) => {
    if (a <= 0) return;
    const srcA = clamp(a, 0, 1);
    const nextA = srcA + outA * (1 - srcA);
    if (nextA <= 0) return;
    outR = (col[0] * srcA + outR * outA * (1 - srcA)) / nextA;
    outG = (col[1] * srcA + outG * outA * (1 - srcA)) / nextA;
    outB = (col[2] * srcA + outB * outA * (1 - srcA)) / nextA;
    outA = nextA;
  };

  // 柔和底层投影（仅带背景时绘制，增强立体浮起感）
  if (withShadow) {
    const dShadow = Math.min(
      sdRoundedPoly(u, v - 0.022, LEFT_WINGED_PILLAR, R_PILLAR),
      sdRoundedPoly(u, v - 0.022, RIGHT_WINGED_PILLAR, R_PILLAR),
      sdRoundedPoly(u, v - 0.022, LEFT_LOWER_WING, R_WING),
      sdRoundedPoly(u, v - 0.022, RIGHT_LOWER_WING, R_WING),
      sdRoundedPoly(u, v - 0.022, CROSSBAR, R_BAR),
    );
    const shadowAlpha = (1 - smoothstep(-0.01, 0.055, dShadow)) * 0.44;
    over([2, 6, 16], shadowAlpha);
  }

  // 2. 横梁（承托于双柱之间的结构桥梁，中心高光、两端微沉以拉开前后层次）
  const covBar = 1 - smoothstep(-aa, aa, dBar);
  if (covBar > 0) {
    const centerLift = 1 - smoothstep(0.0, 0.16, Math.abs(u - 0.5));
    const topEdge = 1 - smoothstep(0.5, 0.65, v);
    let barCol = mixColor(PALETTE.emeraldShadow, PALETTE.emeraldMain, 0.35 + centerLift * 0.58);
    barCol = mixColor(barCol, PALETTE.emeraldLight, topEdge * 0.42 * centerLift);
    const rim = (1 - smoothstep(0.0, 0.016, Math.abs(dBar))) * topEdge * 0.24;
    barCol = mixColor(barCol, PALETTE.mintBright, rim);
    over(barCol, covBar);
  }

  // 3. 副翼（沉稳翡翠绿，与主翼拉开纵深层次）
  const covLower = 1 - smoothstep(-aa, aa, dLower);
  if (covLower > 0) {
    const tipT = smoothstep(0.16, 0.36, Math.abs(u - 0.5));
    let lowCol = mixColor(PALETTE.emeraldShadow, PALETTE.emeraldDeep, 0.52);
    lowCol = mixColor(lowCol, PALETTE.emeraldMain, tipT * 0.85);
    over(lowCol, covLower);
  }

  // 4. 一体化飞翼立柱（饱和度均衡，深色与浅色背景上都具备高对比度与雕塑感）
  const covFront = 1 - smoothstep(-aa, aa, dFront);
  if (covFront > 0) {
    const yT = smoothstep(0.21, 0.82, v);
    // 顶部亮翡翠 #4ADE80 → 中部标志绿 #22C55E → 底部深祖母绿 #059669
    let frontCol =
      yT < 0.42
        ? mixColor(PALETTE.emeraldLight, PALETTE.emeraldMain, yT / 0.42)
        : mixColor(PALETTE.emeraldMain, PALETTE.emeraldShadow, (yT - 0.42) / 0.58);

    // 翼尖前缘微提亮，强化「展翅加速」视觉焦点
    const wingTipBoost = smoothstep(0.16, 0.38, Math.abs(u - 0.5)) * (1 - smoothstep(0.22, 0.44, v));
    frontCol = mixColor(frontCol, PALETTE.mintBright, wingTipBoost * 0.32);

    // 顶部内缘细高光，大尺寸更显精致
    const innerHighlight = (1 - smoothstep(-0.012, 0.0, dFront)) * (1 - smoothstep(0.2, 0.58, v)) * 0.24;
    frontCol = mixColor(frontCol, PALETTE.sparkCore, innerHighlight);

    over(frontCol, covFront);
  }

  // 5. 翼冠四芒星火（AI Spark：深底上发亮、浅底上轮廓同样清晰）
  const covSpark = 1 - smoothstep(-aa, aa, dSpark);
  if (covSpark > 0) {
    const rNorm = Math.hypot((u - SPARK.cx) / SPARK.rx, (v - SPARK.cy) / SPARK.ry);
    const sparkCore = withShadow ? PALETTE.sparkCore : PALETTE.mintBright;
    const sparkEdge = withShadow ? PALETTE.sparkEdge : PALETTE.emeraldMain;
    const sparkCol = mixColor(sparkCore, sparkEdge, smoothstep(0.06, 0.78, rNorm));
    over(sparkCol, covSpark);
  }

  return { r: outR, g: outG, b: outB, a: outA };
};

// ---------- 渲染与降采样 ----------
const renderCanvas = ({ size, withBackground, markScale = 1, monochrome = false }) => {
  const hi = size * SS;
  const c = canvas(hi);
  // 抗锯齿半宽（在归一化 mark 坐标下约 0.75 个高分像素）
  const aa = 0.75 / (hi * markScale);

  for (let y = 0; y < hi; y += 1) {
    const ny = (y + 0.5) / hi;
    const mv = 0.5 + (ny - 0.5) / markScale;
    for (let x = 0; x < hi; x += 1) {
      const nx = (x + 0.5) / hi;
      const mu = 0.5 + (nx - 0.5) / markScale;
      const idx = (y * hi + x) * 4;

      if (withBackground) {
        const bg = evalBackground(nx, ny);
        c.px[idx] = bg[0];
        c.px[idx + 1] = bg[1];
        c.px[idx + 2] = bg[2];
        c.px[idx + 3] = 1;
      }

      // 仅在标志包围盒内求值，提速约 2×
      if (mu >= 0.04 && mu <= 0.96 && mv >= 0.08 && mv <= 0.92) {
        const m = evalMark(mu, mv, aa, monochrome, withBackground);
        if (m.a > 0) blendAt(c, idx, [m.r, m.g, m.b], m.a);
      }
    }
  }

  return downsample(c);
};

const downsample = (c) => {
  const out = canvas(c.size / SS);
  const s = out.size;
  const n = SS * SS;
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
      const i = (y * s + x) * 4;
      out.px[i] = a > 0 ? r / a : 0;
      out.px[i + 1] = a > 0 ? g / a : 0;
      out.px[i + 2] = a > 0 ? b / a : 0;
      out.px[i + 3] = a / n;
    }
  }
  return out;
};

// ---------- PNG 编码 ----------
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
    raw[y * (s * 4 + 1)] = 0;
    for (let x = 0; x < s; x += 1) {
      const i = (y * s + x) * 4;
      const o = y * (s * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(clamp(c.px[i], 0, 255));
      raw[o + 1] = Math.round(clamp(c.px[i + 1], 0, 255));
      raw[o + 2] = Math.round(clamp(c.px[i + 2], 0, 255));
      raw[o + 3] = Math.round(clamp(c.px[i + 3] * 255, 0, 255));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// ---------- 同步导出矢量 SVG 源（便于 README / 文档 / 外部设计复用） ----------
const polyToSvgPath = (pts, size = 1024) => {
  const coords = pts.map(([x, y]) => `${(x * size).toFixed(1)},${(y * size).toFixed(1)}`);
  return `M ${coords[0]} L ${coords.slice(1).join(' L ')} Z`;
};

const buildSvg = () => {
  const S = 1024;
  const sw = (r) => (r * 2 * S).toFixed(1);
  const cx = (SPARK.cx * S).toFixed(1);
  const cy = (SPARK.cy * S).toFixed(1);
  const rx = (SPARK.rx * S).toFixed(1);
  const ry = (SPARK.ry * S).toFixed(1);
  // 四芒星三次贝塞尔近似
  const k = 0.22;
  const sx = SPARK.cx * S;
  const sy = SPARK.cy * S;
  const srx = SPARK.rx * S;
  const sry = SPARK.ry * S;
  const sparkPath = [
    `M ${sx.toFixed(1)} ${(sy - sry).toFixed(1)}`,
    `C ${(sx + srx * k).toFixed(1)} ${(sy - sry * k).toFixed(1)} ${(sx + srx * k).toFixed(1)} ${(sy - sry * k).toFixed(1)} ${(sx + srx).toFixed(1)} ${sy.toFixed(1)}`,
    `C ${(sx + srx * k).toFixed(1)} ${(sy + sry * k).toFixed(1)} ${(sx + srx * k).toFixed(1)} ${(sy + sry * k).toFixed(1)} ${sx.toFixed(1)} ${(sy + sry).toFixed(1)}`,
    `C ${(sx - srx * k).toFixed(1)} ${(sy + sry * k).toFixed(1)} ${(sx - srx * k).toFixed(1)} ${(sy + sry * k).toFixed(1)} ${(sx - srx).toFixed(1)} ${sy.toFixed(1)}`,
    `C ${(sx - srx * k).toFixed(1)} ${(sy - sry * k).toFixed(1)} ${(sx - srx * k).toFixed(1)} ${(sy - sry * k).toFixed(1)} ${sx.toFixed(1)} ${(sy - sry).toFixed(1)} Z`,
  ].join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="35%" r="72%">
      <stop offset="0%" stop-color="#16223A"/>
      <stop offset="58%" stop-color="#0B1120"/>
      <stop offset="100%" stop-color="#050914"/>
    </radialGradient>
    <radialGradient id="auraGrad" cx="50%" cy="46%" r="38%">
      <stop offset="0%" stop-color="#22C55E" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="#22C55E" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="wingFront" x1="50%" y1="20%" x2="50%" y2="82%">
      <stop offset="0%" stop-color="#6EE7B7"/>
      <stop offset="42%" stop-color="#22C55E"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
    <linearGradient id="wingLower" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#22C55E"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
    <linearGradient id="barGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#059669"/>
      <stop offset="50%" stop-color="#34D399"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
    <radialGradient id="sparkGrad" cx="50%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#F0FDF4"/>
      <stop offset="100%" stop-color="#6EE7B7"/>
    </radialGradient>
  </defs>
  <rect width="${S}" height="${S}" rx="224" fill="url(#bgGrad)"/>
  <rect width="${S}" height="${S}" rx="224" fill="url(#auraGrad)"/>
  <circle cx="512" cy="512" r="425" fill="none" stroke="#A7F3D0" stroke-opacity="0.06" stroke-width="4"/>
  <!-- Crossbar -->
  <path d="${polyToSvgPath(CROSSBAR, S)}" fill="url(#barGrad)" stroke="url(#barGrad)" stroke-width="${sw(R_BAR)}" stroke-linejoin="round"/>
  <!-- Lower wings -->
  <path d="${polyToSvgPath(LEFT_LOWER_WING, S)}" fill="url(#wingLower)" stroke="url(#wingLower)" stroke-width="${sw(R_WING)}" stroke-linejoin="round"/>
  <path d="${polyToSvgPath(RIGHT_LOWER_WING, S)}" fill="url(#wingLower)" stroke="url(#wingLower)" stroke-width="${sw(R_WING)}" stroke-linejoin="round"/>
  <!-- Unified winged H pillars -->
  <g fill="url(#wingFront)" stroke="url(#wingFront)" stroke-linejoin="round">
    <path d="${polyToSvgPath(LEFT_WINGED_PILLAR, S)}" stroke-width="${sw(R_PILLAR)}"/>
    <path d="${polyToSvgPath(RIGHT_WINGED_PILLAR, S)}" stroke-width="${sw(R_PILLAR)}"/>
  </g>
  <!-- AI Spark -->
  <path d="${sparkPath}" fill="url(#sparkGrad)" data-center="${cx},${cy}" data-radii="${rx},${ry}"/>
</svg>
`;
};

// ---------- 生成全套资源 ----------
mkdirSync(OUT, { recursive: true });
const files = [
  ['icon.png', { size: 1024, withBackground: true, markScale: 0.94 }],
  // Android 自适应图标：翼尖距中心半径 0.477，108dp 视口 66dp 圆形安全半径 0.3055；
  // 取 0.56 使翼尖落在 0.267 半径内，既饱满又有足够留白抵御国产桌面二次放大裁切
  ['adaptive-icon.png', { size: 1024, withBackground: false, markScale: 0.56 }],
  // Android 13+ Material You 单色主题图标
  ['monochrome-icon.png', { size: 1024, withBackground: false, markScale: 0.56, monochrome: true }],
  ['splash-icon.png', { size: 512, withBackground: false, markScale: 0.88 }],
  ['favicon.png', { size: 48, withBackground: true, markScale: 1.0 }],
  // 应用内/文档透明底标识
  ['logo-mark.png', { size: 256, withBackground: false, markScale: 1.08 }],
];

for (const [name, options] of files) {
  const buf = encodePng(renderCanvas(options));
  writeFileSync(join(OUT, name), buf);
  console.log(`assets/${name}  ${options.size}×${options.size}  (${(buf.length / 1024).toFixed(1)} KB)`);
}

writeFileSync(join(OUT, 'logo.svg'), buildSvg());
console.log('assets/logo.svg  vector master');
