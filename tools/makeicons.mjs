// App icons for the web app manifest and the iOS home screen, drawn by code (no image library):
// a dark tile with the valley's two peaks in off-white over a brass horizon line.
//   node tools/makeicons.mjs   -> public/icons/*.png
import fs from 'node:fs';
import zlib from 'node:zlib';

const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// shapes in unit coordinates (0..1, y down); `pad` shrinks the art for the maskable safe zone
const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const BG = [10, 11, 11], INK = [236, 235, 230], ACC = [212, 189, 136], DIM = [52, 54, 52];
function sample(u, v, pad, round) {
  // rounded tile (transparent corners) or full bleed
  if (round) { const r = 0.2, cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r); if (Math.hypot(u - cx, v - cy) > r) return null; }
  const s = 1 - 2 * pad, x = (u - pad) / s, y = (v - pad) / s;
  const far = [[0.08, 0.7], [0.3, 0.42], [0.42, 0.52], [0.62, 0.3], [0.92, 0.7]];
  const near = [[0.08, 0.7], [0.36, 0.36], [0.5, 0.5], [0.64, 0.34], [0.92, 0.7]];
  if (y > 0.735 && y < 0.765 && x > 0.08 && x < 0.92) return ACC;          // horizon line
  if (inPoly(x, y, near)) return y < 0.47 ? INK : [128, 128, 122];
  if (inPoly(x, y, far)) return DIM;
  return BG;
}
function draw(size, pad, round) {
  const buf = Buffer.alloc(size * size * 4), N = 4;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
      const c = sample((px + (sx + 0.5) / N) / size, (py + (sy + 0.5) / N) / size, pad, round);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = (py * size + px) * 4, n = N * N;
    buf[o] = a ? r / a : 0; buf[o + 1] = a ? g / a : 0; buf[o + 2] = a ? b / a : 0; buf[o + 3] = Math.round((a / n) * 255);
  }
  return png(size, size, buf);
}

fs.mkdirSync('public/icons', { recursive: true });
const out = [['icon-192.png', 192, 0.06, true], ['icon-512.png', 512, 0.06, true], ['icon-maskable-512.png', 512, 0.16, false], ['apple-touch-icon.png', 180, 0.08, false]];
for (const [name, size, pad, round] of out) { fs.writeFileSync(`public/icons/${name}`, draw(size, pad, round)); console.log(`public/icons/${name}`); }
