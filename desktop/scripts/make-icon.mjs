// Writes icon-source.png (1024×1024) for `tauri icon`: the brand's closing dot on a dark rounded
// square. Plain zlib + PNG chunks, so the client needs no image tooling.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const size = 1024, radius = 220, inset = 64;
const dot = { x: 512, y: 512, r: 190 };
const pixels = Buffer.alloc(size * size * 4);
// Coverage of a shape at one pixel, sampled 4×4 for smooth edges.
const cover = inside => { let n = 0; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(i / 4 + 0.125, j / 4 + 0.125)) n++; return n / 16; };
const inRounded = (x, y) => {
  const lo = inset, hi = size - inset, cx = Math.min(Math.max(x, lo + radius), hi - radius), cy = Math.min(Math.max(y, lo + radius), hi - radius);
  return x >= lo && x <= hi && y >= lo && y <= hi && (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const square = cover((dx, dy) => inRounded(x + dx, y + dy));
  if (!square) continue;
  const mark = cover((dx, dy) => (x + dx - dot.x) ** 2 + (y + dy - dot.y) ** 2 <= dot.r ** 2);
  const ink = [29, 29, 27], paper = [246, 245, 241], i = (y * size + x) * 4;
  for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(ink[c] * (1 - mark) + paper[c] * mark);
  pixels[i + 3] = Math.round(255 * square);
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const rows = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icon-source.png');
fs.writeFileSync(out, png);
console.log('wrote', out);
