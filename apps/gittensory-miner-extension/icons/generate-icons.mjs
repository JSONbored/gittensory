import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

// Deterministic generator for the extension's icon set (#4862). Chrome MV3 requires raster (PNG) icons, and this
// repo commits generated artifacts alongside a script that reproduces them rather than opaque binaries -- so the
// committed icons/icon-*.png are the output of this file. Pure Node (only node:zlib for PNG DEFLATE), no external
// deps. Regenerate with `npm run miner:extension:icons`.
//
// The mark is the extension's own brand: a mint "loop" ring (LoopOver) on a dark rounded-square tile, matching the
// opportunity badge's palette in styles.css (#7ee7bc on #111317). Rendered with 4x4 supersampling so the corners
// and ring stay crisp even at 16px, with alpha-weighted downsampling to avoid a dark edge halo.

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const DARK = [0x11, 0x13, 0x17];
const MINT = [0x7e, 0xe7, 0xbc];

function insideRoundedRect(x, y, min, max, radius) {
  if (x < min || x > max || y < min || y > max) return false;
  const innerMin = min + radius;
  const innerMax = max - radius;
  const cornerX = x < innerMin ? innerMin : x > innerMax ? innerMax : null;
  const cornerY = y < innerMin ? innerMin : y > innerMax ? innerMax : null;
  if (cornerX === null || cornerY === null) return true; // on an edge band, not a corner
  return Math.hypot(x - cornerX, y - cornerY) <= radius;
}

/** Straight (non-premultiplied) RGBA for a single sample point in pixel space. */
function sampleAt(x, y, size) {
  const margin = size * 0.06;
  const radius = size * 0.22;
  if (!insideRoundedRect(x, y, margin, size - margin, radius)) return [0, 0, 0, 0];
  const center = size / 2;
  const dist = Math.hypot(x - center, y - center);
  if (dist >= size * 0.19 && dist <= size * 0.34) return [MINT[0], MINT[1], MINT[2], 255];
  return [DARK[0], DARK[1], DARK[2], 255];
}

/** Render one size to a raw RGBA pixel buffer with supersampled, alpha-weighted anti-aliasing. */
function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const [r, g, b, a] = sampleAt(px + (sx + 0.5) * step, py + (sy + 0.5) * step, size);
          rSum += r * a;
          gSum += g * a;
          bSum += b * a;
          aSum += a;
        }
      }
      const offset = (py * size + px) * 4;
      // Alpha-weighted color so edge pixels blend toward the covered color, not toward black.
      pixels[offset] = aSum > 0 ? Math.round(rSum / aSum) : 0;
      pixels[offset + 1] = aSum > 0 ? Math.round(gSum / aSum) : 0;
      pixels[offset + 2] = aSum > 0 ? Math.round(bSum / aSum) : 0;
      pixels[offset + 3] = Math.round(aSum / samplesPerPixel);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(HERE, { recursive: true });
for (const size of SIZES) {
  const outPath = resolve(HERE, `icon-${size}.png`);
  writeFileSync(outPath, encodePng(size, renderRgba(size)));
  console.log(`wrote ${outPath.replace(`${resolve(HERE, "../../..")}/`, "")}`);
}
