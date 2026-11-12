// Bakes all terrain data for Valle Morta:
//   far_h.png      2049^2 height of the whole 28 km mountain range (16 bit packed in RG)
//   far_n.png      far normal (RG = xz) + flow/gully factor (B)
//   far_mesh.bin   adaptive (RTIN) triangle mesh of the far terrain
//   local_h.png    2049^2 height of the playable valley, 0.5 m grid (16 bit in RG)
//   local_n.png    local normal (RG) + cavity (B)
//   mask_a/b/c.png surface masks
//   terrain.json   decode ranges
// Run: node tools/bake-terrain.mjs
import fs from 'node:fs';
import { createLayout, WORLD } from '../src/world/layout.js';
import { Noise, smoothstep, clamp, saturate, mix, mulberry32 } from '../src/core/noise.js';
import { writePNG } from './lib/png.mjs';

const OUT = 'public/assets/terrain';
fs.mkdirSync(OUT, { recursive: true });
const L = createLayout();
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

// ------------------------------------------------------------------ far field
const FN = 2049;
const FS = WORLD.farSize;
const FC = FS / (FN - 1);
const far = new Float32Array(FN * FN);
const nz = new Noise(991), nz2 = new Noise(417), nz3 = new Noise(73);

const massifs = [
  // cx, cz, sx, sz, amplitude
  [-2900, -5300, 2300, 1900, 2150],  // left twin
  [2700, -5500, 2100, 1800, 2350],   // right twin
  [200, -11000, 3600, 2300, 2500],   // distant wall seen through the notch
  [-5400, -1500, 2000, 3600, 1750],  // western wall
  [3900, -1100, 1900, 3200, 1500],   // eastern ridge above the hill
  [5600, 4400, 2800, 2800, 1300],
  [-4900, 4900, 2800, 2800, 1450],
  [600, 9500, 4500, 2600, 1250],     // southern closure
  [-9000, -8000, 3200, 3200, 2300],
  [9000, -8500, 3200, 3200, 2400],
  [-10500, 2500, 3000, 4000, 1900],
  [10500, 3000, 3000, 4000, 1900],
];
const summits = [
  // x, z, radius, extra height
  [-2500, -5150, 2700, 1250],
  [-3600, -5900, 2000, 700],
  [2350, -5300, 2500, 1350],
  [3300, -6100, 2100, 900],
  [-5600, -2300, 2200, 800],
  [4300, -1900, 2000, 650],
];
const axis = [0.735, 0.678];
const qf = {};
function mountains(x, z) {
  const wx = x + 950 * nz.fbm2(x / 5200 + 3.1, z / 5200 - 1.7, 3);
  const wz = z + 950 * nz.fbm2(x / 5200 - 8.2, z / 5200 + 4.4, 3);
  let U = 0;
  for (const m of massifs) {
    const dx = (wx - m[0]) / m[2], dz = (wz - m[1]) / m[3];
    U += m[4] * Math.exp(-0.5 * (dx * dx + dz * dz));
  }
  U += 700 * smoothstep(7000, 12500, Math.hypot(x, z));
  const R = nz.ridged2(wx / 3900, wz / 3900, 8, 2.07, 0.53, 0.55);
  const R2 = nz2.ridged2(wx / 1250 + 5, wz / 1250, 6, 2.1, 0.5, 0.35);
  let h = U * (0.2 + 1.0 * R) + U * 0.13 * R2;
  for (const p of summits) {
    const d = Math.hypot(wx - p[0], wz - p[1]) / p[2];
    if (d < 1) h += p[3] * Math.pow(1 - d, 1.6) * (0.55 + 0.7 * R);
  }
  // foothill texture
  h += 60 * saturate(U / 500) * nz3.fbm2(x / 700, z / 700, 4);
  return h;
}
function farBase(x, z) {
  const along = x * axis[0] + z * axis[1], across = -x * axis[1] + z * axis[0];
  const r = Math.hypot(along * 0.5, across);
  // keep the river's valley open up- and downstream
  const rd = L.river.query(x, z, qf).d;
  const mask = smoothstep(620, 2500, r) * smoothstep(260, 2100, rd);
  let h = L.baseHeight(x, z) + mask * mountains(x, z) * 0.5;
  // Dolomite-style banded cliffs high up
  const k = 0.22 * smoothstep(900, 1500, h) * saturate(0.5 + nz3.n2(x / 1700, z / 1700));
  if (k > 0) {
    const step = 260;
    const off = 0.7 * nz2.n2(x / 1100, z / 1100);
    const t = h / step + off;
    const f = t - Math.floor(t);
    const ht = (Math.floor(t) + smoothstep(0.45, 0.95, f) - off) * step;
    h = mix(h, ht, k);
  }
  return h;
}
// The eroded range is expensive, so it is cached; pass --far to rebuild it.
const CACHE = 'tools/_cache';
fs.mkdirSync(CACHE, { recursive: true });
const useCache = !process.argv.includes('--far') && fs.existsSync(`${CACHE}/far.f32`) && fs.existsSync(`${CACHE}/flow.f32`);
let flow;
if (useCache) {
  log('far: using cached eroded range (pass --far to rebuild)');
  far.set(new Float32Array(fs.readFileSync(`${CACHE}/far.f32`).buffer.slice(0, FN * FN * 4)));
  flow = new Float32Array(fs.readFileSync(`${CACHE}/flow.f32`).buffer.slice(0, FN * FN * 4));
} else {
log('far: evaluating base');
for (let j = 0; j < FN; j++) {
  const z = -FS / 2 + j * FC;
  for (let i = 0; i < FN; i++) far[j * FN + i] = farBase(-FS / 2 + i * FC, z);
}

// droplet erosion on normalised heights
function erode(map, N, drops, seed, maskFn) {
  const rnd = mulberry32(seed);
  const flow = new Float32Array(N * N);
  const radius = 3;
  const bo = [], bw = [];
  let wsum = 0;
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    const d = Math.hypot(x, y);
    if (d < radius) { const w = 1 - d / radius; bo.push(y * N + x); bw.push(w); wsum += w; }
  }
  const brushOff = new Int32Array(bo), brushW = new Float32Array(bw.map((w) => w / wsum));
  const nb = brushOff.length;
  const inertia = 0.06, capF = 5.5, minCap = 0.008, erodeSpeed = 0.32, depositSpeed = 0.28, evap = 0.012, gravity = 4, life = 40;
  for (let it = 0; it < drops; it++) {
    let px = rnd() * (N - 3) + 1, py = rnd() * (N - 3) + 1;
    let dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
    for (let l = 0; l < life; l++) {
      const nx = Math.floor(px), ny = Math.floor(py);
      const ox = px - nx, oy = py - ny;
      const idx = ny * N + nx;
      const hNW = map[idx], hNE = map[idx + 1], hSW = map[idx + N], hSE = map[idx + N + 1];
      const gx = (hNE - hNW) * (1 - oy) + (hSE - hSW) * oy;
      const gy = (hSW - hNW) * (1 - ox) + (hSE - hNE) * ox;
      const h = hNW * (1 - ox) * (1 - oy) + hNE * ox * (1 - oy) + hSW * (1 - ox) * oy + hSE * ox * oy;
      dx = dx * inertia - gx * (1 - inertia);
      dy = dy * inertia - gy * (1 - inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) break;
      dx /= len; dy /= len;
      px += dx; py += dy;
      if (px < 4 || px >= N - 5 || py < 4 || py >= N - 5) break;
      const mx = Math.floor(px), my = Math.floor(py);
      const ux = px - mx, uy = py - my;
      const i2 = my * N + mx;
      const nh = map[i2] * (1 - ux) * (1 - uy) + map[i2 + 1] * ux * (1 - uy) + map[i2 + N] * (1 - ux) * uy + map[i2 + N + 1] * ux * uy;
      const dh = nh - h;
      const m = maskFn[idx];
      flow[idx] += water;
      const cap = Math.max(-dh * speed * water * capF, minCap);
      if (sed > cap || dh > 0) {
        const amt = (dh > 0 ? Math.min(dh, sed) : (sed - cap) * depositSpeed) * m;
        sed -= amt;
        map[idx] += amt * (1 - ox) * (1 - oy); map[idx + 1] += amt * ox * (1 - oy);
        map[idx + N] += amt * (1 - ox) * oy; map[idx + N + 1] += amt * ox * oy;
      } else {
        const amt = Math.min((cap - sed) * erodeSpeed, -dh) * m;
        for (let b = 0; b < nb; b++) {
          const bi = idx + brushOff[b];
          const we = amt * brushW[b];
          const de = map[bi] < we ? map[bi] : we;
          map[bi] -= de; sed += de;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * gravity));
      water *= 1 - evap;
    }
  }
  return flow;
}
const HN = 700; // height normalisation for the erosion solver
let fmin = 1e9;
for (let i = 0; i < far.length; i++) fmin = Math.min(fmin, far[i]);
const eroMask = new Float32Array(FN * FN);
for (let j = 0; j < FN; j++) for (let i = 0; i < FN; i++) {
  const x = -FS / 2 + i * FC, z = -FS / 2 + j * FC;
  eroMask[j * FN + i] = smoothstep(750, 1500, Math.hypot(x, z));
}
const orig = far.slice();
for (let i = 0; i < far.length; i++) far[i] = (far[i] - fmin) / HN;
const drops = Number(process.env.DROPS || 1800000);
log(`far: eroding (${drops} droplets)`);
flow = erode(far, FN, drops, 4711, eroMask);
for (let i = 0; i < far.length; i++) far[i] = mix(orig[i], far[i] * HN + fmin, eroMask[i]);

// gentle talus pass to soften single-cell spikes left by the solver
{
  const tmp = far.slice();
  for (let j = 1; j < FN - 1; j++) for (let i = 1; i < FN - 1; i++) {
    const k = j * FN + i;
    const avg = (tmp[k - 1] + tmp[k + 1] + tmp[k - FN] + tmp[k + FN]) * 0.25;
    const d = tmp[k] - avg;
    if (Math.abs(d) > 9) far[k] = mix(tmp[k], avg, 0.6 * eroMask[k]);
  }
}
fs.writeFileSync(`${CACHE}/far.f32`, Buffer.from(far.buffer));
fs.writeFileSync(`${CACHE}/flow.f32`, Buffer.from(flow.buffer));
} // end !useCache
let farMin = 1e9, farMax = -1e9;
for (let i = 0; i < far.length; i++) { farMin = Math.min(farMin, far[i]); farMax = Math.max(farMax, far[i]); }
log(`far: range ${farMin.toFixed(1)} .. ${farMax.toFixed(1)} m`);

function pack16(arr, n, lo, hi) {
  const out = new Uint8Array(n * n * 3);
  for (let i = 0; i < n * n; i++) {
    const v = Math.round(saturate((arr[i] - lo) / (hi - lo)) * 65535);
    out[i * 3] = v >> 8; out[i * 3 + 1] = v & 255; out[i * 3 + 2] = 0;
  }
  return out;
}
writePNG(`${OUT}/far_h.png`, FN, FN, 3, pack16(far, FN, farMin, farMax));

// far normal + flow
{
  const N = 2048;
  const out = new Uint8Array(N * N * 3);
  let fmax = 0;
  const lf = new Float32Array(FN * FN);
  for (let i = 0; i < lf.length; i++) { lf[i] = Math.log(1 + flow[i]); fmax = Math.max(fmax, lf[i]); }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(FN - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(FN - 1, j + 1);
    const dx = (far[j * FN + i1] - far[j * FN + i0]) / ((i1 - i0) * FC);
    const dz = (far[j1 * FN + i] - far[j0 * FN + i]) / ((j1 - j0) * FC);
    const l = Math.hypot(dx, 1, dz);
    const k = (j * N + i) * 3;
    out[k] = Math.round((-dx / l * 0.5 + 0.5) * 255);
    out[k + 1] = Math.round((-dz / l * 0.5 + 0.5) * 255);
    // blur flow a little (3x3)
    let f = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) f += lf[clamp(j + b, 0, FN - 1) * FN + clamp(i + a, 0, FN - 1)];
    out[k + 2] = Math.round(saturate(f / 9 / (fmax * 0.55)) * 255);
  }
  writePNG(`${OUT}/far_n.png`, N, N, 3, out);
}

const farSample = (x, z) => {
  // Catmull-Rom bicubic
  const fx = clamp((x + FS / 2) / FC, 1, FN - 3), fz = clamp((z + FS / 2) / FC, 1, FN - 3);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const w = (t) => [(-t + 2 * t * t - t * t * t) / 2, (2 - 5 * t * t + 3 * t * t * t) / 2, (t + 4 * t * t - 3 * t * t * t) / 2, (-t * t + t * t * t) / 2];
  const wx = w(tx), wz = w(tz);
  let s = 0;
  for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) s += far[(iz - 1 + b) * FN + (ix - 1 + a)] * wx[a] * wz[b];
  return s;
};

// ------------------------------------------------------------------ local field
const LN = 2049, LS = WORLD.size, LC = LS / (LN - 1);
const local = new Float32Array(LN * LN);
const MN = 2048;
const maskA = new Uint8Array(MN * MN * 3), maskB = new Uint8Array(MN * MN * 3), maskC = new Uint8Array(MN * MN * 3);
log('local: evaluating design height + masks');
const m = {};
for (let j = 0; j < LN; j++) {
  const z = -LS / 2 + j * LC;
  for (let i = 0; i < LN; i++) {
    const x = -LS / 2 + i * LC;
    let h = L.designHeight(x, z, m);
    const k = smoothstep(430, 506, Math.max(Math.abs(x), Math.abs(z)));
    if (k > 0) h = mix(h, farSample(x, z), k);
    local[j * LN + i] = h;
    if (i < MN && j < MN) {
      const p = (j * MN + i) * 3;
      maskA[p] = Math.round(saturate(m.road) * 255); maskA[p + 1] = Math.round(saturate(m.mud) * 255); maskA[p + 2] = Math.round(saturate(m.rubble) * 255);
      maskB[p] = Math.round(saturate(m.bed) * 255); maskB[p + 1] = Math.round(saturate(m.cobble) * 255); maskB[p + 2] = Math.round(saturate(m.wet) * 255);
      maskC[p] = Math.round(saturate(m.forest) * 255);
      maskC[p + 1] = Math.round(saturate(0.5 + m.riverDist / 60) * 255);
      maskC[p + 2] = 0;
    }
  }
}
let locMin = 1e9, locMax = -1e9;
for (let i = 0; i < local.length; i++) { locMin = Math.min(locMin, local[i]); locMax = Math.max(locMax, local[i]); }
log(`local: range ${locMin.toFixed(2)} .. ${locMax.toFixed(2)} m`);
// make the far map agree with the local one inside the local square (coarsely)
for (let j = 0; j < FN; j++) for (let i = 0; i < FN; i++) {
  const x = -FS / 2 + i * FC, z = -FS / 2 + j * FC;
  if (Math.abs(x) <= LS / 2 && Math.abs(z) <= LS / 2) {
    const li = Math.round((x + LS / 2) / LC), lj = Math.round((z + LS / 2) / LC);
    far[j * FN + i] = local[lj * LN + li];
  }
}
writePNG(`${OUT}/local_h.png`, LN, LN, 3, pack16(local, LN, locMin, locMax));
writePNG(`${OUT}/mask_a.png`, MN, MN, 3, maskA);
writePNG(`${OUT}/mask_b.png`, MN, MN, 3, maskB);
writePNG(`${OUT}/mask_c.png`, MN, MN, 3, maskC);
{
  const out = new Uint8Array(MN * MN * 3);
  for (let j = 0; j < MN; j++) for (let i = 0; i < MN; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(LN - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(LN - 1, j + 1);
    const c = local[j * LN + i];
    const dx = (local[j * LN + i1] - local[j * LN + i0]) / ((i1 - i0) * LC);
    const dz = (local[j1 * LN + i] - local[j0 * LN + i]) / ((j1 - j0) * LC);
    const l = Math.hypot(dx, 1, dz);
    // cavity: laplacian over a ~2 m footprint
    const r = 4;
    const a = local[j * LN + Math.min(LN - 1, i + r)] + local[j * LN + Math.max(0, i - r)] + local[Math.min(LN - 1, j + r) * LN + i] + local[Math.max(0, j - r) * LN + i];
    const cav = saturate(0.5 + (a * 0.25 - c) * 0.9);
    const k = (j * MN + i) * 3;
    out[k] = Math.round((-dx / l * 0.5 + 0.5) * 255);
    out[k + 1] = Math.round((-dz / l * 0.5 + 0.5) * 255);
    out[k + 2] = Math.round(cav * 255);
  }
  writePNG(`${OUT}/local_n.png`, MN, MN, 3, out);
}

// ------------------------------------------------------------------ far mesh (RTIN)
log('far mesh: building error map');
{
  const size = FN, tile = FN - 1;
  const numTriangles = tile * tile * 2 - 2;
  const numParent = numTriangles - tile * tile;
  const coords = new Uint16Array(numTriangles * 4);
  for (let i = 0; i < numTriangles; i++) {
    let id = i + 2;
    let ax = 0, ay = 0, bx = 0, by = 0, cx = 0, cy = 0;
    if (id & 1) { bx = by = cx = tile; } else { ax = ay = cy = tile; }
    while ((id >>= 1) > 1) {
      const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
      if (id & 1) { bx = ax; by = ay; ax = cx; ay = cy; } else { ax = bx; ay = by; bx = cx; by = cy; }
      cx = mx; cy = my;
    }
    const k = i * 4;
    coords[k] = ax; coords[k + 1] = ay; coords[k + 2] = bx; coords[k + 3] = by;
  }
  const errScale = Number(process.env.FAR_ERR || 2.0);
  // allowed error grows with distance from the playable area; the border ring
  // around the local terrain is kept tight so both meshes agree there.
  const tol = (gx, gy) => {
    const x = -FS / 2 + gx * FC, z = -FS / 2 + gy * FC;
    const c = Math.max(Math.abs(x), Math.abs(z));
    if (c < 440) return 60;
    if (c < 640) return 0.6;
    const d = Math.hypot(x, z);
    // the northern sector holds the hero peaks: keep it sharper
    const hero = z < -1500 && Math.abs(x) < 6500 ? 0.62 : 1.0;
    return Math.max(1.5, d * 0.00105 * hero) * errScale;
  };
  const errors = new Float32Array(size * size);
  for (let i = numTriangles - 1; i >= 0; i--) {
    const k = i * 4;
    const ax = coords[k], ay = coords[k + 1], bx = coords[k + 2], by = coords[k + 3];
    const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
    const cx = mx + my - ay, cy = my + ax - mx;
    const interp = (far[ay * size + ax] + far[by * size + bx]) / 2;
    const mid = my * size + mx;
    const e = Math.abs(interp - far[mid]) / tol(mx, my);
    if (e > errors[mid]) errors[mid] = e;
    if (i < numParent) {
      const lc = ((ay + cy) >> 1) * size + ((ax + cx) >> 1);
      const rc = ((by + cy) >> 1) * size + ((bx + cx) >> 1);
      if (errors[lc] > errors[mid]) errors[mid] = errors[lc];
      if (errors[rc] > errors[mid]) errors[mid] = errors[rc];
    }
  }
  const vmap = new Uint32Array(size * size);
  const verts = [], tris = [];
  const vid = (x, y) => {
    const k = y * size + x;
    if (vmap[k] === 0) {
      verts.push(-FS / 2 + x * FC, far[k], -FS / 2 + y * FC);
      vmap[k] = verts.length / 3;
    }
    return vmap[k] - 1;
  };
  const stack = [[0, 0, tile, tile, tile, 0], [tile, tile, 0, 0, 0, tile]];
  while (stack.length) {
    const [ax, ay, bx, by, cx, cy] = stack.pop();
    const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
    if (Math.abs(ax - cx) + Math.abs(ay - cy) > 1 && errors[my * size + mx] > 1) {
      stack.push([cx, cy, ax, ay, mx, my], [bx, by, cx, cy, mx, my]);
    } else {
      tris.push(vid(ax, ay), vid(bx, by), vid(cx, cy));
    }
  }
  const vc = verts.length / 3, tc = tris.length / 3;
  log(`far mesh: ${vc} verts, ${tc} tris`);
  const buf = Buffer.alloc(8 + vc * 12 + tc * 12);
  buf.writeUInt32LE(vc, 0); buf.writeUInt32LE(tc, 4);
  Buffer.from(new Float32Array(verts).buffer).copy(buf, 8);
  Buffer.from(new Uint32Array(tris).buffer).copy(buf, 8 + vc * 12);
  fs.writeFileSync(`${OUT}/far_mesh.bin`, buf);
}

fs.writeFileSync(`${OUT}/terrain.json`, JSON.stringify({
  local: { n: LN, size: LS, min: locMin, max: locMax },
  far: { n: FN, size: FS, min: farMin, max: farMax },
}, null, 2));
log('done');
