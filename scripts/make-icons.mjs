#!/usr/bin/env node
/**
 * Generates Fillie's PNG icons — no binary assets checked in, no image
 * dependency. Draws a rounded square with the brand gradient, a document glyph
 * and the Fillie sparkle, then encodes the RGBA buffer to PNG with node:zlib.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'assets');

/* ----------------------------------------------------------- PNG encoding */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- rasteriser */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle (negative inside). */
function sdRoundRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * Signed distance to a four-point sparkle: an astroid with exponent < 2 gives
 * the concave diamond used by the brand mark (2 = circle, 1 = hard diamond).
 */
function sdSparkle(x, y, cx, cy, radius, exponent = 1.35) {
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  return (dx ** exponent + dy ** exponent) ** (1 / exponent) - radius;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 32; // design grid is 32 x 32
  const aa = Math.max(0.55, s * 0.9); // anti-alias width in px

  const blend = (x, y, [r, g, b], a) => {
    if (a <= 0) return;
    const idx = (y * size + x) * 4;
    const prevA = rgba[idx + 3] / 255;
    const outA = a + prevA * (1 - a);
    if (outA <= 0) return;
    rgba[idx] = Math.round((r * a + rgba[idx] * prevA * (1 - a)) / outA);
    rgba[idx + 1] = Math.round((g * a + rgba[idx + 1] * prevA * (1 - a)) / outA);
    rgba[idx + 2] = Math.round((b * a + rgba[idx + 2] * prevA * (1 - a)) / outA);
    rgba[idx + 3] = Math.round(outA * 255);
  };

  // Layer 1 — rounded square with the brand gradient.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = sdRoundRect(x + 0.5, y + 0.5, size / 2, size / 2, size / 2, size / 2, 8.2 * s);
      const alpha = clamp01(0.5 - d / aa);
      if (alpha <= 0) continue;
      const t = clamp01((x / size) * 0.5 + (y / size) * 0.5);
      blend(x, y, [lerp(88, 244, t), lerp(80, 128, t), lerp(214, 200, t)], alpha);
    }
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Layer 2 — document body.
      const docD = sdRoundRect(px, py, 12.6 * s, 16.6 * s, 5.6 * s, 6.9 * s, 1.7 * s);
      const docA = clamp01(0.5 - docD / aa);
      if (docA > 0) blend(x, y, [255, 255, 255], docA * 0.97);

      // Layer 3 — two soft text rules inside the document (skipped at 16px).
      if (size >= 32 && docD < -0.3 * s) {
        for (const [ruleY, ruleX, ruleHalfW] of [
          [13.9, 11.9, 2.5 * s],
          [17.3, 11.9, 2.5 * s],
        ]) {
          const ruleD = sdRoundRect(px, py, ruleX * s + ruleHalfW, ruleY * s, ruleHalfW, 0.62 * s, 0.62 * s);
          const ruleA = clamp01(0.5 - ruleD / (aa * 0.8)) * 0.68;
          if (ruleA > 0) blend(x, y, [116, 100, 226], ruleA);
        }
      }

      // Layer 4 — check mark inside the document.
      const checkA = clamp01(0.5 - sdCheck(px, py, 15.1 * s, 20.1 * s, 2.5 * s) / aa);
      if (checkA > 0 && docD < -0.2 * s) blend(x, y, [93, 82, 216], checkA * 0.92);

      // Layer 5 — the Fillie sparkle.
      const sparkA = clamp01(0.5 - sdSparkle(px, py, 23.9 * s, 8.6 * s, 7.4 * s, 0.62) / aa);
      if (sparkA > 0) {
        const t = clamp01((x + y) / (2 * size));
        blend(x, y, [lerp(126, 255, t), lerp(102, 246, t), lerp(255, 224, t)], sparkA);
        // Soft halo so the sparkle reads on the light half of the gradient too.
        const halo = clamp01(0.5 - sdSparkle(px, py, 23.9 * s, 8.6 * s, 7.6 * s, 1.08) / aa);
        if (halo > 0) blend(x, y, [255, 255, 255], halo * 0.16);
      }
    }
  }

  return encodePng(size, size, rgba);
}

/** Distance to a two-segment polyline (the check mark). */
function sdCheck(x, y, cx, cy, scale) {
  const a = [cx - 1.5 * scale, cy - 0.1 * scale];
  const b = [cx - 0.45 * scale, cy + 0.85 * scale];
  const c = [cx + 1.7 * scale, cy - 1.1 * scale];
  return Math.min(sdSegment(x, y, a, b), sdSegment(x, y, b, c));
}

function sdSegment(px, py, a, b) {
  const pax = px - a[0];
  const pay = py - a[1];
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const denominator = bax * bax + bay * bay;
  const h = denominator === 0 ? 0 : clamp01((pax * bax + pay * bay) / denominator);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = renderIcon(size);
    await writeFile(path.join(outDir, `icon-${size}.png`), png);
    console.log(`  icon-${String(size).padStart(3)}.png  ${(png.length / 1024).toFixed(2)} kB`);
  }
}

await main();