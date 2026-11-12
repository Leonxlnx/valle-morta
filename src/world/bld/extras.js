// Dry-stone boundary walls along the streets and the instanced loose debris
// (stones, roof tiles) scattered by the building generators.
import * as THREE from 'three';
import { RNG } from '../../core/noise.js';
import { MB, LY, emitSlab, slabBoxes } from './mb.js';
import { jitterFlags } from './house.js';

const ROWS = [-0.5, 0, 0.36, 0.72, 1.06];

function wallRun(B, run, rng) {
  const mb = B.mb, T = B.ground, noise = B.noise, nu = run.length - 1, nv = 4, nu1 = nu + 1, nvt = nu1 * (nv + 1);
  const st = new Uint8Array(nu * nv);
  for (let i = 0; i < nu; i++) {
    const s = run[i][4], hgt = 0.62 + 0.38 * noise.n2(s * 0.13, 4.2) + 0.25 * noise.n2(s * 0.5, 1.1);
    const gap = noise.n2(s * 0.09 + 31, 8.8) > 0.56;
    st[nu + i] = gap ? 2 : 0;
    st[2 * nu + i] = gap || hgt < 0.42 ? 2 : 0;
    st[3 * nu + i] = gap || hgt < 0.66 ? 2 : 0;
  }
  const jit = jitterFlags(st, nu, nv);
  const po = new Float32Array(nvt * 3), pi = new Float32Array(nvt * 3), uv = new Float32Array(nvt * 2), vn = new Float32Array(nvt * 3);
  let ax = 0, az = 0;
  for (let v = 0; v < nvt; v++) {
    const i = v % nu1, j = (v / nu1) | 0, r = run[i];
    const g = T(r[0], r[1]);
    let y = g + ROWS[j] * (j > 1 ? 1 + 0.12 * noise.n2(r[4] * 0.7, j * 3.1) : 1);
    if (j >= 2) y += 0.07 * noise.n2(r[4] * 2.3, j * 5.7) + rng.range(-0.04, 0.04);
    if (jit[v] && j > 0) y += rng.range(-0.15, 0.06);
    const half = (j >= 3 ? 0.19 : 0.27) + (j > 0 ? 0.05 * noise.n2(r[4] * 1.9, j * 2.3) : 0);
    po[v * 3] = r[0] + r[2] * half; po[v * 3 + 1] = y; po[v * 3 + 2] = r[1] + r[3] * half;
    pi[v * 3] = r[0] - r[2] * half; pi[v * 3 + 1] = y; pi[v * 3 + 2] = r[1] - r[3] * half;
    uv[v * 2] = r[4] / 4; uv[v * 2 + 1] = -ROWS[j] / 4;
    vn[v * 3] = r[2]; vn[v * 3 + 2] = r[3];
    ax += r[2]; az += r[3];
  }
  const mW = { layer: LY.stone_masonry, tint: [1.1, 1.08, 1.03], ao: 1 }, mTop = { layer: LY.stone_masonry, tint: [1.16, 1.14, 1.08], ao: 1 };
  const g = { nu, nv, po, pi, uv, st, nO: [ax, 0, az], vn, tEdge: 0.13, outer: mW, inner: mW, edge: () => mTop, border: [2, 2, 0, 2] };
  emitSlab(mb, g);
  if (B.cb) slabBoxes(B.cb, g, 4);
  for (let i = 0; i < nu; i++) {
    let top = 0;
    for (let j = 1; j < nv; j++) if (!st[j * nu + i]) top = j;
    if (top < 1 || !rng.chance(0.7)) continue;
    const r = run[i], f = rng.f(), x = r[0] + (run[i + 1][0] - r[0]) * f + r[2] * rng.range(-0.1, 0.1), z = r[1] + (run[i + 1][1] - r[1]) * f + r[3] * rng.range(-0.1, 0.1);
    B.stone(x, T(r[0], r[1]) + ROWS[top + 1] - 0.07, z, rng.range(0.1, 0.17), rng);
  }
  for (let i = 0; i < nu; i += 2) {
    if (!rng.chance(0.5)) continue;
    const r = run[i], sd = rng.chance(0.5) ? 1 : -1, o = rng.range(0.4, 1.0);
    const x = r[0] + r[2] * sd * o, z = r[1] + r[3] * sd * o;
    B.stone(x, T(x, z), z, rng.range(0.08, 0.22), rng);
  }
}

export function buildStoneWalls(B) {
  const L = B.layout, noise = B.noise, rng = new RNG(5531), q = {};
  const paths = [...L.streets.map((p, i) => ({ p, off: 3.3, id: i })), { p: L.roads[1].path, off: 3.7, id: 9, maxS: 80 }];
  const blocked = (x, z, self) => {
    for (const b of L.buildings) if (Math.abs(x - b.x) < 18 && Math.abs(z - b.z) < 18 && L.footprintDist(b, x, z) < 1.4) return true;
    for (const o of paths) if (o.p !== self && o.p.query(x, z, q).d < 3.5) return true;
    if (L.roads[0].path.query(x, z, q).d < 3.5) return true;
    if (Math.hypot(x - 44, z + 92) < 17.5) return true;
    if (Math.hypot(x - L.church.towerX, z - L.church.towerZ) < 6) return true;
    L.river.query(x, z, q);
    return q.d < L.riverHalfWidth(q.s) + 3;
  };
  for (const o of paths) for (const side of [-1, 1]) {
    const len = Math.min(o.p.length, o.maxS || 1e9);
    let run = [];
    const flush = () => { if (run.length >= 7) wallRun(B, run, rng); run = []; };
    for (let s = 1.5; s < len - 1.5; s += 0.5) {
      const [px, pz, tx, tz] = o.p.at(s);
      const x = px - tz * side * o.off, z = pz + tx * side * o.off;
      if (noise.n2(s * 0.045 + o.id * 13.7, side * 3.3) < -0.12 || blocked(x, z, o.p)) { flush(); continue; }
      run.push([x, z, -tz * side, tx * side, s]);
      if (run.length >= 30) { const last = run[run.length - 1]; flush(); run.push(last); }
    }
    flush();
  }
}

// ---------------------------------------------------------------- instanced debris
// indexed quad between existing vertices, wound to face the hint direction
function pushQuad(g, a, b, c, d, hx, hy, hz) {
  const p = g.pos, ex = p[c * 3] - p[a * 3], ey = p[c * 3 + 1] - p[a * 3 + 1], ez = p[c * 3 + 2] - p[a * 3 + 2];
  const fx = p[d * 3] - p[b * 3], fy = p[d * 3 + 1] - p[b * 3 + 1], fz = p[d * 3 + 2] - p[b * 3 + 2];
  if ((ey * fz - ez * fy) * hx + (ez * fx - ex * fz) * hy + (ex * fy - ey * fx) * hz < 0) g.idx.push(a, c, b, a, d, c); else g.idx.push(a, b, c, a, c, d);
}
export function buildDebris(B, material) {
  const out = [], m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), eul = new THREE.Euler();
  // stone: a knocked-about block
  if (B.stones.length) {
    const g = new MB(), r = new RNG(17), p = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) p.push([sx * r.range(0.65, 1.1), sy * r.range(0.4, 0.75), sz * r.range(0.6, 1.1)]);
    const faces = [[0, 1, 3, 2, -1, 0, 0], [4, 5, 7, 6, 1, 0, 0], [0, 1, 5, 4, 0, -1, 0], [2, 3, 7, 6, 0, 1, 0], [0, 2, 6, 4, 0, 0, -1], [1, 3, 7, 5, 0, 0, 1]];
    g.set(LY.stone_masonry, [1.14, 1.12, 1.07]);
    for (const q of p) { const l = Math.hypot(q[0], q[1] * 1.6, q[2]); g.vert(q[0], q[1], q[2], q[0] / l, q[1] * 1.6 / l, q[2] / l, (q[0] + 0.4 * q[1]) * 0.05 + 0.3, (q[2] + 0.6 * q[1]) * 0.05 + 0.3, 0, q[1] < 0 ? 0.65 : 1, 0); }
    for (const f of faces) pushQuad(g, f[0], f[1], f[2], f[3], f[4], f[5], f[6]);
    const im = new THREE.InstancedMesh(g.toGeometry(), material, B.stones.length);
    B.stones.forEach((s, i) => {
      pos.set(s[0], s[1], s[2]); eul.set(s[5], s[4], s[6]); quat.setFromEuler(eul); scl.set(s[3], s[3] * s[7], s[3]);
      im.setMatrixAt(i, m4.compose(pos, quat, scl));
    });
    im.name = 'bld:stones'; im.castShadow = false; im.receiveShadow = true;
    out.push(im);
  }
  // barrel roof tile
  if (B.tiles.length) {
    const g = new MB(), R = 0.085, n = 3, L = 0.21;
    g.set(LY.roof_tiles, [1.0, 0.98, 0.98]);
    const pt = (a, z, rr) => [Math.cos(a) * rr * (z > 0 ? 0.84 : 1), Math.sin(a) * rr * (z > 0 ? 0.84 : 1) - R * 0.35, z];
    for (const side of [1, -1]) {
      const base = g.n, rr = side > 0 ? R : R - 0.013;
      for (let k = 0; k <= n; k++) {
        const a = 0.17 + (Math.PI - 0.34) * k / n, u = (3 + k / n) / 16;
        for (const z of [-L, L]) { const q = pt(a, z, rr); g.vert(q[0], q[1], q[2], Math.cos(a) * side, Math.sin(a) * side, 0, u, (z < 0 ? 0.1 : 0) + (side > 0 ? 0 : 0.1), 0, side > 0 ? 1 : 0.6, 0); }
      }
      for (let k = 0; k < n; k++) { const am = 0.17 + (Math.PI - 0.34) * (k + 0.5) / n; pushQuad(g, base + k * 2, base + k * 2 + 2, base + k * 2 + 3, base + k * 2 + 1, Math.cos(am) * side, Math.sin(am) * side, 0); }
    }
    const im = new THREE.InstancedMesh(g.toGeometry(), material, B.tiles.length);
    B.tiles.forEach((s, i) => {
      pos.set(s[0], s[1], s[2]); eul.set(s[4], s[3], s[5], 'YXZ'); quat.setFromEuler(eul); scl.set(1, 1, s[6]);
      im.setMatrixAt(i, m4.compose(pos, quat, scl));
    });
    im.name = 'bld:tiles'; im.castShadow = false; im.receiveShadow = true;
    out.push(im);
  }
  for (const im of out) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.computeBoundingBox(); im.matrixAutoUpdate = false; im.updateMatrixWorld(true); }
  return out;
}
