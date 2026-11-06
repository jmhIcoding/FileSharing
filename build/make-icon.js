'use strict';
/**
 * 生成应用图标（PNG），无需任何图像库。
 * 用法：node build/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 圆角矩形覆盖率（带 1px 抗锯齿） */
function roundRectCoverage(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, Math.min(1, r - d + 0.5));
}

/** 点到线段的距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx;
  const ey = y1 + t * dy;
  return Math.hypot(px - ex, py - ey);
}

function drawIcon(size) {
  const S = size;
  const rgba = Buffer.alloc(S * S * 4, 0);
  const scale = S / 256;

  const put = (x, y, r, g, b, a) => {
    if (a <= 0) return;
    const i = (y * S + x) * 4;
    const src = a;
    const dst = rgba[i + 3] / 255;
    const outA = src + dst * (1 - src);
    if (outA <= 0) return;
    rgba[i] = Math.round((r * src + rgba[i] * dst * (1 - src)) / outA);
    rgba[i + 1] = Math.round((g * src + rgba[i + 1] * dst * (1 - src)) / outA);
    rgba[i + 2] = Math.round((b * src + rgba[i + 2] * dst * (1 - src)) / outA);
    rgba[i + 3] = Math.round(outA * 255);
  };

  const radius = 56 * scale;
  // 背景渐变（左上到右下）
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cov = roundRectCoverage(x + 0.5, y + 0.5, S, S, radius);
      if (cov <= 0) continue;
      const t = (x / S) * 0.45 + (y / S) * 0.55;
      const r = Math.round(37 + t * (79 - 37));
      const g = Math.round(99 + t * (70 - 99));
      const b = Math.round(235 + t * (229 - 235));
      put(x, y, r, g, b, cov);
    }
  }

  // 白色同步箭头（上 arrow 指向右上，下 arrow 指向左下）
  const cxp = S / 2;
  const lw = 13 * scale;

  // 上方弧形：从 (70,120) 到 (186,104)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let a = 0;

      // 上面一条横线
      const d1 = distToSegment(px, py, 82 * scale, 108 * scale, 170 * scale, 108 * scale);
      a = Math.max(a, Math.max(0, Math.min(1, lw / 2 - d1 + 0.5)));

      // 上面的箭头头部（向右上）
      const d2 = distToSegment(px, py, 170 * scale, 108 * scale, 182 * scale, 84 * scale);
      const d3 = distToSegment(px, py, 170 * scale, 108 * scale, 140 * scale, 92 * scale);
      a = Math.max(a, Math.max(0, Math.min(1, lw / 2 - Math.min(d2, d3) + 0.5)));

      // 下面一条横线
      const d4 = distToSegment(px, py, 86 * scale, 148 * scale, 174 * scale, 148 * scale);
      a = Math.max(a, Math.max(0, Math.min(1, lw / 2 - d4 + 0.5)));

      // 下面的箭头头部（向左下）
      const d5 = distToSegment(px, py, 86 * scale, 148 * scale, 74 * scale, 172 * scale);
      const d6 = distToSegment(px, py, 86 * scale, 148 * scale, 116 * scale, 164 * scale);
      a = Math.max(a, Math.max(0, Math.min(1, lw / 2 - Math.min(d5, d6) + 0.5)));

      if (a > 0) put(x, y, 255, 255, 255, a * 0.97);
    }
  }

  return encodePng(S, S, rgba);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const big = drawIcon(256);
fs.writeFileSync(path.join(outDir, 'icon.png'), big);
fs.writeFileSync(path.join(outDir, 'tray.png'), drawIcon(32));

// ICO 容器可以直接内嵌 PNG 数据（Vista+ 支持）
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0;                    // 256px
entry[1] = 0;                    // 256px
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4);       // planes
entry.writeUInt16LE(32, 6);      // bit count
entry.writeUInt32LE(big.length, 8);
entry.writeUInt32LE(22, 12);     // 数据偏移
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, entry, big]));

console.log('图标已生成：assets/icon.png, assets/tray.png, assets/icon.ico');
