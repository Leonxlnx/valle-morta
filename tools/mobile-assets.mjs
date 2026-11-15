// Builds the light asset set for phones and tablets: public/assets/m/ plus manifest.json, which maps
// each original path under public/assets/ to its reduced copy (src/engine/assets.js redirects the
// loads when MOBILE is true; anything not in the manifest, audio for example, loads as it is).
//   node tools/mobile-assets.mjs            (needs ffmpeg on the PATH; about two minutes)
// What it does:
//   tex/*.jpg              512 px (the phone tiers sample the material arrays at 512)
//   models/*.glb           images inside the GLB re-encoded: 512 px for infected, vehicles and the
//                          helicopter, 1024 px for the first-person weapons; geometry untouched
//   models/*_col_b.jpg     512 px; *_col_c.jpg maps onto the same file (one colour variant per type)
//   terrain/*_n.png        normal maps as 1024 px JPEG
//   terrain/far_h.png      far heights at every second sample (2049 -> 1025, 28 m spacing)
//   terrain/far_mesh.bin   triangles under the local terrain removed (the loader drops them anyway)
// It builds into tools/_cache/m and then swaps the folder into public/ in one step.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const SRC = path.join(ROOT, 'public/assets');
const TMP = path.join(ROOT, 'tools/_cache/m');
const DST = path.join(SRC, 'm');
const WORK = path.join(ROOT, 'tools/_cache/m-work');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const map = {};
const mk = (rel) => { const p = path.join(TMP, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };

function ff(args, input) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '4', '-y', ...args], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' ') + '\n' + r.stderr);
  return r.stdout;
}
// scales an image file to at most `max` px on its longer side (never up)
function shrink(src, dst, max, q = 3) {
  const vf = `scale='if(gte(iw,ih),min(iw,${max}),-2)':'if(gte(iw,ih),-2,min(ih,${max}))':flags=lanczos`;
  ff(['-i', src, '-vf', vf, ...(dst.endsWith('.jpg') ? ['-q:v', String(q)] : ['-compression_level', '9']), dst]);
}

// ---- material textures
for (const f of fs.readdirSync(path.join(SRC, 'tex')).filter((x) => x.endsWith('.jpg'))) {
  shrink(path.join(SRC, 'tex', f), mk(`tex/${f}`), 512);
  map[`tex/${f}`] = `tex/${f}`;
}

// ---- GLB models: re-encode the embedded images, re-pack the binary chunk
function repackGlb(buf, max) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
  const bl = buf.readUInt32LE(20 + jl), bin = buf.subarray(28 + jl, 28 + jl + bl);
  const imgOf = new Map((json.images || []).map((im, i) => [im.bufferView, im]));
  const parts = [];
  let off = 0;
  json.bufferViews.forEach((bv, i) => {
    const o = bv.byteOffset || 0;
    let data = bin.subarray(o, o + bv.byteLength);
    const im = imgOf.get(i);
    if (im && /jpeg|png/.test(im.mimeType)) {
      const ext = im.mimeType.includes('png') ? 'png' : 'jpg';
      const a = path.join(WORK, `in.${ext}`), b = path.join(WORK, `out.${ext}`);
      fs.writeFileSync(a, data);
      shrink(a, b, max, 4);
      const out = fs.readFileSync(b);
      if (out.length < data.length) data = out;
    }
    bv.byteOffset = off; bv.byteLength = data.length;
    parts.push(data);
    const pad = (4 - (data.length % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
    off += data.length + pad;
  });
  json.buffers[0].byteLength = off;
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + body.length, 8);
  jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(body.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, js, bh, body]);
}
const WEAPONS = new Set(['pistol', 'rifle', 'sniper']);
for (const f of fs.readdirSync(path.join(SRC, 'models'))) {
  const src = path.join(SRC, 'models', f), name = f.split(/[._]/)[0];
  if (f.endsWith('.glb')) {
    fs.writeFileSync(mk(`models/${f}`), repackGlb(fs.readFileSync(src), WEAPONS.has(name) ? 1024 : 512));
    map[`models/${f}`] = `models/${f}`;
  } else if (/_col_b\.jpg$/.test(f)) {
    shrink(src, mk(`models/${f}`), 512, 4);
    map[`models/${f}`] = `models/${f}`;
    map[`models/${f.replace('_col_b', '_col_c')}`] = `models/${f}`;
  }
}

// ---- terrain
const T = path.join(SRC, 'terrain');
for (const n of ['local_n', 'far_n']) {
  shrink(path.join(T, `${n}.png`), mk(`terrain/${n}.jpg`), 1024, 2);
  map[`terrain/${n}.png`] = `terrain/${n}.jpg`;
}
{
  // far heights: 16 bits in R (high byte) and G (low byte); keep every second sample
  const meta = JSON.parse(fs.readFileSync(path.join(T, 'terrain.json'), 'utf8'));
  const n = meta.far.n, m = (n - 1) / 2 + 1;
  const raw = ff(['-i', path.join(T, 'far_h.png'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (raw.length !== n * n * 3) throw new Error('far_h size');
  const out = Buffer.alloc(m * m * 3);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const s = ((j * 2) * n + i * 2) * 3, d = (j * m + i) * 3;
    out[d] = raw[s]; out[d + 1] = raw[s + 1]; out[d + 2] = 0;
  }
  ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${m}x${m}`, '-i', '-', '-compression_level', '9', mk('terrain/far_h.png')], out);
  meta.far.n = m;
  fs.writeFileSync(mk('terrain/terrain.json'), JSON.stringify(meta, null, 2));
  map['terrain/far_h.png'] = 'terrain/far_h.png';
  map['terrain/terrain.json'] = 'terrain/terrain.json';
}
{
  // far mesh without the triangles under the local square (same format: vc, tc, f32 xyz, u32 idx)
  const b = fs.readFileSync(path.join(T, 'far_mesh.bin'));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  const [vc, tc] = new Uint32Array(ab, 0, 2);
  const P = new Float32Array(ab, 8, vc * 3), I = new Uint32Array(ab, 8 + vc * 12, tc * 3);
  const inside = (v) => Math.max(Math.abs(P[v * 3]), Math.abs(P[v * 3 + 2])) < 506;
  const remap = new Int32Array(vc).fill(-1), pos = [], idx = [];
  for (let k = 0; k < tc * 3; k += 3) {
    if (inside(I[k]) && inside(I[k + 1]) && inside(I[k + 2])) continue;
    for (let e = 0; e < 3; e++) {
      const v = I[k + e];
      if (remap[v] < 0) { remap[v] = pos.length / 3; pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
      idx.push(remap[v]);
    }
  }
  const nv = pos.length / 3, nt = idx.length / 3;
  const o = Buffer.alloc(8 + nv * 12 + nt * 12);
  o.writeUInt32LE(nv, 0); o.writeUInt32LE(nt, 4);
  Buffer.from(new Float32Array(pos).buffer).copy(o, 8);
  Buffer.from(new Uint32Array(idx).buffer).copy(o, 8 + nv * 12);
  fs.writeFileSync(mk('terrain/far_mesh.bin'), o);
  map['terrain/far_mesh.bin'] = 'terrain/far_mesh.bin';
}

fs.writeFileSync(path.join(TMP, 'manifest.json'), JSON.stringify({ built: new Date().toISOString(), files: map }, null, 1));
fs.rmSync(WORK, { recursive: true, force: true });
// swap into public/ in one step
fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(TMP, DST, { recursive: true });
fs.rmSync(TMP, { recursive: true, force: true });
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
const mb = (x) => (x / 1048576).toFixed(1) + ' MB';
for (const k of ['tex', 'models', 'terrain']) console.log(k.padEnd(8), mb(size(path.join(SRC, k))), '->', mb(size(path.join(DST, k))));
console.log('files mapped:', Object.keys(map).length);
