import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apps', 'extension', 'public', 'icon');

const BACKGROUND = [0x4f, 0x46, 0xe5];
const GLYPH = [0xff, 0xff, 0xff];
const SIZES = [16, 32, 48, 128];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function inRoundedRect(x, y, left, top, right, bottom, radius) {
  const halfWidth = (right - left) / 2;
  const halfHeight = (bottom - top) / 2;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const qx = Math.abs(x - centerX) - (halfWidth - radius);
  const qy = Math.abs(y - centerY) - (halfHeight - radius);
  if (qx <= 0 && qy <= 0) return true;
  const dx = Math.max(qx, 0);
  const dy = Math.max(qy, 0);
  return dx * dx + dy * dy <= radius * radius;
}

function inRect(x, y, left, top, right, bottom) {
  return x >= left && x <= right && y >= top && y <= bottom;
}

function inGlyph(x, y) {
  return (
    inRect(x, y, 0.34, 0.19, 0.42, 0.45) ||
    inRect(x, y, 0.58, 0.19, 0.66, 0.45) ||
    inRoundedRect(x, y, 0.27, 0.38, 0.73, 0.62, 0.07) ||
    inRect(x, y, 0.46, 0.62, 0.54, 0.8)
  );
}

function renderIcon(size) {
  const samples = 8;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgCoverage = 0;
      let glyphCoverage = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          if (inGlyph(px, py)) {
            glyphCoverage += 1;
          } else if (inRoundedRect(px, py, 0, 0, 1, 1, 0.22)) {
            bgCoverage += 1;
          }
        }
      }

      const total = glyphCoverage + bgCoverage;
      const offset = (y * size + x) * 4;
      if (total === 0) {
        pixels[offset + 3] = 0;
        continue;
      }

      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          (BACKGROUND[channel] * bgCoverage + GLYPH[channel] * glyphCoverage) / total,
        );
      }
      pixels[offset + 3] = Math.round((total / (samples * samples)) * 255);
    }
  }

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`Wrote ${path.relative(root, file)}`);
}
