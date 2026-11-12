// Mesh building toolkit for the ruined village (see ../buildings.js).
// Everything is baked into world space and into very few draw calls: one
// "structure" material samples array textures, the layer is a vertex attribute.
import * as THREE from 'three';

export const LAYERS = ['plaster_old', 'plaster_damaged', 'stone_masonry', 'stone_blocks', 'roof_tiles', 'wood_planks', 'wood_beam', 'wood_charred', 'rubble', 'slate_dark', 'cobblestone'];
export const LY = {};
LAYERS.forEach((n, i) => { LY[n] = i; });

const NEUTRAL = [1, 1, 1];
const OB = {};
const neg = (v) => [-v[0], -v[1], -v[2]];

export class MB {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.mat = []; this.tint = []; this.idx = [];
    this.n = 0;
    this.c = 1; this.s = 0; this.ox = 0; this.oy = 0; this.oz = 0;
    this.layer = 0; this.tr = 128; this.tg = 128; this.tb = 128;
    this.P = new Float64Array(12); this.U = new Float64Array(8); this.F = [0, 0, 0, 0]; this.S = [0, 0, 0, 0];
  }

  get tris() { return this.idx.length / 3; }

  // local frame: +X -> (cos rot, sin rot) in world xz
  xf(x = 0, y = 0, z = 0, rot = 0) { this.c = Math.cos(rot); this.s = Math.sin(rot); this.ox = x; this.oy = y; this.oz = z; return this; }

  set(layer, tint = NEUTRAL) { this.layer = layer; this.tr = tint[0] * 128; this.tg = tint[1] * 128; this.tb = tint[2] * 128; return this; }

  vert(x, y, z, nx, ny, nz, u, v, fl = 0, ao = 1, soot = 0) {
    const c = this.c, s = this.s;
    this.pos.push(this.ox + x * c - z * s, this.oy + y, this.oz + x * s + z * c);
    this.nrm.push(nx * c - nz * s, ny, nx * s + nz * c);
    this.uv.push(u, v);
    this.mat.push(this.layer, fl * 255, ao * 255, soot * 255);
    this.tint.push(this.tr, this.tg, this.tb, (y + 2) * (255 / 18));
    return this.n++;
  }

  // quad from the scratch arrays P (4 points), U (4 uvs), F (flake), S (soot)
  emit(nx, ny, nz, ao = 1, geo = false) {
    const P = this.P, U = this.U, F = this.F, S = this.S;
    const ax = P[6] - P[0], ay = P[7] - P[1], az = P[8] - P[2];
    const bx = P[9] - P[3], by = P[10] - P[4], bz = P[11] - P[5];
    const gx = ay * bz - az * by, gy = az * bx - ax * bz, gz = ax * by - ay * bx;
    const gl = Math.hypot(gx, gy, gz);
    if (gl < 1e-10) return;
    const flip = gx * nx + gy * ny + gz * nz < 0;
    if (geo) { const k = (flip ? -1 : 1) / gl; nx = gx * k; ny = gy * k; nz = gz * k; } else { const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l; }
    const i0 = this.vert(P[0], P[1], P[2], nx, ny, nz, U[0], U[1], F[0], ao, S[0]);
    const i1 = this.vert(P[3], P[4], P[5], nx, ny, nz, U[2], U[3], F[1], ao, S[1]);
    const i2 = this.vert(P[6], P[7], P[8], nx, ny, nz, U[4], U[5], F[2], ao, S[2]);
    const i3 = this.vert(P[9], P[10], P[11], nx, ny, nz, U[6], U[7], F[3], ao, S[3]);
    if (flip) this.idx.push(i0, i2, i1, i0, i3, i2); else this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  quad(a, b, c, d, n, ua, ub, uc, ud, ao = 1, fl = 0, soot = 0, geo = false) {
    const P = this.P, U = this.U;
    P[0] = a[0]; P[1] = a[1]; P[2] = a[2]; P[3] = b[0]; P[4] = b[1]; P[5] = b[2];
    P[6] = c[0]; P[7] = c[1]; P[8] = c[2]; P[9] = d[0]; P[10] = d[1]; P[11] = d[2];
    U[0] = ua[0]; U[1] = ua[1]; U[2] = ub[0]; U[3] = ub[1]; U[4] = uc[0]; U[5] = uc[1]; U[6] = ud[0]; U[7] = ud[1];
    this.F[0] = this.F[1] = this.F[2] = this.F[3] = fl;
    this.S[0] = this.S[1] = this.S[2] = this.S[3] = soot;
    this.emit(n[0], n[1], n[2], ao, geo);
  }

  // planar quad, uv in metres / tile measured along a->b (u) and a->d (v)
  quadM(a, b, c, d, n, tile = 4, uo = 0, vo = 0, ao = 1, geo = false) {
    const lu = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / tile, lv = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]) / tile;
    this.quad(a, b, c, d, n, [uo, vo], [uo + lu, vo], [uo + lu, vo + lv], [uo, vo + lv], ao, 0, 0, geo);
  }

  tri(a, b, c, n, ua, ub, uc, ao = 1) {
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
    let gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
    const gl = Math.hypot(gx, gy, gz);
    if (gl < 1e-10) return;
    const flip = gx * n[0] + gy * n[1] + gz * n[2] < 0;
    const k = (flip ? -1 : 1) / gl; gx *= k; gy *= k; gz *= k;
    const i0 = this.vert(a[0], a[1], a[2], gx, gy, gz, ua[0], ua[1], 0, ao, 0);
    const i1 = this.vert(b[0], b[1], b[2], gx, gy, gz, ub[0], ub[1], 0, ao, 0);
    const i2 = this.vert(c[0], c[1], c[2], gx, gy, gz, uc[0], uc[1], 0, ao, 0);
    if (flip) this.idx.push(i0, i2, i1); else this.idx.push(i0, i1, i2);
  }

  // oriented box: centre C, half axes U (texture u runs along it), V, W.
  // skip bits: 1 +V, 2 -V, 4 +W, 8 -W, 16 +U, 32 -U
  obox(C, U, V, W, o = OB) {
    const tile = o.tile || 2, ao = o.ao === undefined ? 1 : o.ao, uo = o.uo || 0, vo = o.vo || 0, skip = o.skip || 0;
    const lu = 2 * Math.hypot(U[0], U[1], U[2]) / tile, lv = 2 * Math.hypot(V[0], V[1], V[2]) / tile, lw = 2 * Math.hypot(W[0], W[1], W[2]) / tile;
    const pt = (a, b, c) => [C[0] + a * U[0] + b * V[0] + c * W[0], C[1] + a * U[1] + b * V[1] + c * W[1], C[2] + a * U[2] + b * V[2] + c * W[2]];
    const p = [pt(-1, -1, -1), pt(1, -1, -1), pt(1, 1, -1), pt(-1, 1, -1), pt(-1, -1, 1), pt(1, -1, 1), pt(1, 1, 1), pt(-1, 1, 1)];
    const aoB = ao * (o.aoB === undefined ? 0.75 : o.aoB);
    if (!(skip & 1)) this.quad(p[3], p[2], p[6], p[7], V, [uo, vo], [uo + lu, vo], [uo + lu, vo + lw], [uo, vo + lw], ao);
    if (!(skip & 2)) this.quad(p[0], p[1], p[5], p[4], neg(V), [uo, vo + 0.21], [uo + lu, vo + 0.21], [uo + lu, vo + 0.21 + lw], [uo, vo + 0.21 + lw], aoB);
    if (!(skip & 4)) this.quad(p[4], p[5], p[6], p[7], W, [uo, vo + 0.43], [uo + lu, vo + 0.43], [uo + lu, vo + 0.43 + lv], [uo, vo + 0.43 + lv], ao);
    if (!(skip & 8)) this.quad(p[0], p[1], p[2], p[3], neg(W), [uo, vo + 0.67], [uo + lu, vo + 0.67], [uo + lu, vo + 0.67 + lv], [uo, vo + 0.67 + lv], ao);
    if (!(skip & 16)) this.quad(p[1], p[2], p[6], p[5], U, [uo, vo], [uo + lv, vo], [uo + lv, vo + lw], [uo, vo + lw], ao);
    if (!(skip & 32)) this.quad(p[0], p[3], p[7], p[4], neg(U), [uo + 0.3, vo], [uo + 0.3 + lv, vo], [uo + 0.3 + lv, vo + lw], [uo + 0.3, vo + lw], ao);
  }

  // axis aligned box in the local frame; o.axis = texture u axis ('x' | 'y' | 'z', default longest)
  abox(x0, y0, z0, x1, y1, z1, o = OB) {
    const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (z1 - z0) / 2;
    const C = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const ax = o.axis || (hx >= hy && hx >= hz ? 'x' : hz >= hy ? 'z' : 'y');
    if (ax === 'x') this.obox(C, [hx, 0, 0], [0, hy, 0], [0, 0, hz], o);
    else if (ax === 'z') this.obox(C, [0, 0, hz], [0, hy, 0], [hx, 0, 0], o);
    else this.obox(C, [0, hy, 0], [hx, 0, 0], [0, 0, hz], o);
  }

  // timber between two points; w = horizontal width, h = depth
  beam(p0, p1, w, h, o = OB) {
    const ux = (p1[0] - p0[0]) / 2, uy = (p1[1] - p0[1]) / 2, uz = (p1[2] - p0[2]) / 2;
    if (Math.hypot(ux, uy, uz) < 1e-3) return;
    let wx = -uz, wz = ux, wl = Math.hypot(wx, wz);
    if (wl < 1e-4) { wx = 1; wz = 0; wl = 1; }
    wx *= w / 2 / wl; wz *= w / 2 / wl;
    let vx = -wz * uy, vy = wz * ux - wx * uz, vz = wx * uy;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx *= h / 2 / vl; vy *= h / 2 / vl; vz *= h / 2 / vl;
    if (o.roll) { // rotate the section about the beam axis
      const cr = Math.cos(o.roll), sr = Math.sin(o.roll), kw = (h / 2) / (w / 2), kv = (w / 2) / (h / 2);
      const nwx = wx * cr + vx * sr / kw * 1, nwy = vy * sr / kw, nwz = wz * cr + vz * sr / kw;
      const nvx = vx * cr - wx * sr * kw, nvy = vy * cr, nvz = vz * cr - wz * sr * kw;
      wx = nwx; wz = nwz; vx = nvx; vy = nvy; vz = nvz;
      this.obox([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2], [ux, uy, uz], [vx, vy, vz], [wx, nwy, wz], o);
      return;
    }
    this.obox([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2], [ux, uy, uz], [vx, vy, vz], [wx, 0, wz], o);
  }

  // Noisy rubble dome draped on the ground, in WORLD coordinates (identity xf).
  // Returns hAt(x, z): height of the heap above the ground (or -1 outside).
  mound(cx, cz, rx, rz, rot, h, ground, noise, o = OB) {
    const rings = o.rings || 4, segs = o.segs || 10, seed = o.seed || 0;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const wob = (a) => 1 + 0.18 * Math.sin(a * 2 + seed) + 0.1 * Math.sin(a * 5 + seed * 1.7);
    const bump = (x, z, rr) => h * Math.pow(Math.max(0, 1 - rr * rr), 1.2) * (0.78 + 0.4 * noise.n2(x * 0.45 + seed, z * 0.45)) + 0.05 * noise.n2(x * 2.9, z * 2.9 + seed);
    const hAt = (x, z) => {
      const dx = x - cx, dz = z - cz;
      const lx = (dx * cr + dz * sr) / rx, lz = (-dx * sr + dz * cr) / rz;
      const rr = Math.hypot(lx, lz) / wob(Math.atan2(lz, lx));
      return rr >= 1 ? -1 : bump(x, z, rr);
    };
    const pts = [[cx, ground(cx, cz) + bump(cx, cz, 0), cz]];
    for (let q = 1; q <= rings; q++) for (let k = 0; k < segs; k++) {
      const a = k / segs * Math.PI * 2, rr = q / rings, w = wob(a) * rr;
      const lx = Math.cos(a) * w * rx, lz = Math.sin(a) * w * rz;
      const x = cx + lx * cr - lz * sr, z = cz + lx * sr + lz * cr;
      pts.push([x, ground(x, z) + (q === rings ? -0.22 : bump(x, z, rr) - 0.03), z]);
    }
    const id = (q, k) => (q === 0 ? 0 : 1 + (q - 1) * segs + ((k + segs) % segs));
    const base = this.n;
    this.set(o.layer === undefined ? LY.rubble : o.layer, o.tint || NEUTRAL);
    for (let q = 0; q <= rings; q++) for (let k = 0; k < (q === 0 ? 1 : segs); k++) {
      const p = pts[id(q, k)];
      let nx = 0, ny = 1, nz = 0;
      if (q > 0) {
        const a = pts[id(q, k + 1)], b = pts[id(q, k - 1)], c = pts[id(Math.min(q + 1, rings), k)], d = pts[id(q - 1, k)];
        const tx = a[0] - b[0], ty = a[1] - b[1], tz = a[2] - b[2], ex = c[0] - d[0], ey = c[1] - d[1], ez = c[2] - d[2];
        nx = ty * ez - tz * ey; ny = tz * ex - tx * ez; nz = tx * ey - ty * ex;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      }
      this.vert(p[0], p[1], p[2], nx, ny, nz, p[0] / 4, p[2] / 4, 0, 0.72 + 0.28 * (1 - q / rings), 0);
    }
    for (let k = 0; k < segs; k++) this.idx.push(base, base + id(1, k + 1), base + id(1, k));
    for (let q = 1; q < rings; q++) for (let k = 0; k < segs; k++) {
      const a = base + id(q, k), b = base + id(q, k + 1), c = base + id(q + 1, k + 1), d = base + id(q + 1, k);
      this.idx.push(a, b, c, a, c, d);
    }
    return hAt;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    const nn = new Int8Array(this.nrm.length);
    for (let i = 0; i < nn.length; i++) nn[i] = Math.round(Math.max(-1, Math.min(1, this.nrm[i])) * 127);
    g.setAttribute('normal', new THREE.BufferAttribute(nn, 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aMat', new THREE.BufferAttribute(new Uint8ClampedArray(this.mat), 4, true));
    g.setAttribute('aTint', new THREE.BufferAttribute(new Uint8ClampedArray(this.tint), 4, true));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }

  toMesh(material, name) {
    if (!this.n) return null;
    const m = new THREE.Mesh(this.toGeometry(), material);
    m.name = name; m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrixWorld(true);
    return m;
  }
}

// ---------------------------------------------------------------- colliders
const COLLIDER_MAT = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false });

export class CB {
  constructor() { this.pos = []; this.idx = []; this.n = 0; this.c = 1; this.s = 0; this.ox = 0; this.oy = 0; this.oz = 0; }
  xf(x = 0, y = 0, z = 0, rot = 0) { this.c = Math.cos(rot); this.s = Math.sin(rot); this.ox = x; this.oy = y; this.oz = z; return this; }
  get tris() { return this.idx.length / 3; }
  p(x, y, z) { this.pos.push(this.ox + x * this.c - z * this.s, this.oy + y, this.oz + x * this.s + z * this.c); return this.n++; }
  // quad wound so that its normal points away from the point c
  quad(a, b, c2, d, c = null) {
    let flip = false;
    if (c) {
      const ax = c2[0] - a[0], ay = c2[1] - a[1], az = c2[2] - a[2], bx = d[0] - b[0], by = d[1] - b[1], bz = d[2] - b[2];
      const gx = ay * bz - az * by, gy = az * bx - ax * bz, gz = ax * by - ay * bx;
      flip = gx * (a[0] - c[0]) + gy * (a[1] - c[1]) + gz * (a[2] - c[2]) < 0;
    }
    const i0 = this.p(a[0], a[1], a[2]), i1 = this.p(b[0], b[1], b[2]), i2 = this.p(c2[0], c2[1], c2[2]), i3 = this.p(d[0], d[1], d[2]);
    if (flip) this.idx.push(i0, i2, i1, i0, i3, i2); else this.idx.push(i0, i1, i2, i0, i2, i3);
  }
  // closed hexahedron from two quads (a0..a3 and b0..b3 in the same order)
  hex(a, b) {
    const c = [0, 0, 0];
    for (let k = 0; k < 4; k++) for (let q = 0; q < 3; q++) c[q] += (a[k][q] + b[k][q]) / 8;
    this.quad(a[0], a[1], a[2], a[3], c); this.quad(b[0], b[1], b[2], b[3], c);
    for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4; this.quad(a[k], a[k2], b[k2], b[k], c); }
  }
  box(x0, y0, z0, x1, y1, z1) {
    this.hex([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  }
  mesh(name) {
    if (!this.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, COLLIDER_MAT);
    m.name = `col:${name}`; m.visible = false; m.matrixAutoUpdate = false; m.updateMatrixWorld(true);
    m.userData.collider = true;
    return m;
  }
}

// ---------------------------------------------------------------- carved slabs
// A slab is a (nu x nv) grid of cells between an outer and an inner surface
// (wall, roof plane, floor, bridge body ...). Cells are solid (0) or empty
// (code > 0); empty neighbours get an edge face whose look depends on the code.
// g = { nu, nv, po, pi (xyz per grid vertex), uv, st (per cell), fl, soot (per vertex, optional),
//       plain (per cell: may be merged with its neighbours), nO (outer normal), tEdge,
//       outer, inner: {layer, tint, ao} | null, edge(code) -> {layer, tint, ao, flake?, planar?} | null,
//       border [uLo, uHi, vLo, vHi] codes for the grid rim, faceO/faceI(i, j) optional filters, geo }
export function emitSlab(mb, g) {
  const { nu, nv, po, pi, uv, st } = g;
  const nu1 = nu + 1, nvt = nu1 * (nv + 1), fl = g.fl || null, so = g.soot || null, plain = g.plain || null, plainI = g.plainI || plain, vn = g.vn || null;
  const P = mb.P, U = mb.U, F = mb.F, S = mb.S;
  const uio = g.uvInner === undefined ? 0.37 : g.uvInner, sootI = g.sootI || 0, tE = g.tEdge || 0.1;
  const border = g.border || [0, 0, 0, 0];
  const nl = Math.hypot(g.nO[0], g.nO[1], g.nO[2]) || 1, nO = [g.nO[0] / nl, g.nO[1] / nl, g.nO[2] / nl];
  // grid vertices are shared between the faces of one side
  const mapO = new Int32Array(nvt).fill(-1), mapI = new Int32Array(nvt).fill(-1);
  const vid = (a, outer) => {
    const map = outer ? mapO : mapI;
    let k = map[a];
    if (k >= 0) return k;
    const src = outer ? po : pi, m = outer ? g.outer : g.inner, sg = outer ? 1 : -1;
    const nx = vn ? vn[a * 3] : nO[0], ny = vn ? vn[a * 3 + 1] : nO[1], nz = vn ? vn[a * 3 + 2] : nO[2];
    mb.set(m.layer, m.tint);
    k = mb.vert(src[a * 3], src[a * 3 + 1], src[a * 3 + 2], nx * sg, ny * sg, nz * sg, uv[a * 2] + (outer ? 0 : uio), uv[a * 2 + 1], fl ? fl[a] : 0, m.ao, outer ? (so ? so[a] : 0) : sootI);
    map[a] = k;
    return k;
  };
  const face = (i0, j0, i1, j1, outer) => {
    if (!(outer ? g.outer : g.inner)) return;
    const src = outer ? po : pi;
    const a = j0 * nu1 + i0, b = j0 * nu1 + i1, c = j1 * nu1 + i1, d = j1 * nu1 + i0;
    const ex = src[c * 3] - src[a * 3], ey = src[c * 3 + 1] - src[a * 3 + 1], ez = src[c * 3 + 2] - src[a * 3 + 2];
    const fx = src[d * 3] - src[b * 3], fy = src[d * 3 + 1] - src[b * 3 + 1], fz = src[d * 3 + 2] - src[b * 3 + 2];
    const gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
    if (gx * gx + gy * gy + gz * gz < 1e-18) return;
    const hx = vn ? vn[a * 3] : nO[0], hy = vn ? vn[a * 3 + 1] : nO[1], hz = vn ? vn[a * 3 + 2] : nO[2];
    const flip = (gx * hx + gy * hy + gz * hz) * (outer ? 1 : -1) < 0;
    const ia = vid(a, outer), ib = vid(b, outer), ic = vid(c, outer), id = vid(d, outer);
    if (flip) mb.idx.push(ia, ic, ib, ia, id, ic); else mb.idx.push(ia, ib, ic, ia, ic, id);
  };
  const greedy = (pl, outer, filt) => {
    const used = new Uint8Array(nu * nv);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const c = j * nu + i;
      if (st[c] !== 0 || used[c]) continue;
      if (pl && pl[c]) {
        let w = 1;
        while (i + w < nu && pl[c + w] && !used[c + w] && !st[c + w]) w++;
        let h = 1;
        grow: while (j + h < nv) {
          for (let k = 0; k < w; k++) { const q = (j + h) * nu + i + k; if (!pl[q] || used[q] || st[q]) break grow; }
          h++;
        }
        for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) used[(j + b) * nu + i + a] = 1;
        face(i, j, i + w, j + h, outer);
      } else if (!filt || filt(i, j)) face(i, j, i + 1, j + 1, outer);
    }
  };
  greedy(plain, true, g.faceO);
  greedy(plainI, false, g.faceI);
  const edge = (a, b, code, i, j, horiz, sgn) => {
    const m = g.edge(code);
    if (!m) return;
    const c0 = j * nu1 + i, c1 = c0 + 1, c2 = c0 + nu1, c3 = c2 + 1;
    let cx = 0, cy = 0, cz = 0;
    for (const q of [c0, c1, c2, c3]) { cx += po[q * 3] + pi[q * 3]; cy += po[q * 3 + 1] + pi[q * 3 + 1]; cz += po[q * 3 + 2] + pi[q * 3 + 2]; }
    P[0] = po[a * 3]; P[1] = po[a * 3 + 1]; P[2] = po[a * 3 + 2]; P[3] = po[b * 3]; P[4] = po[b * 3 + 1]; P[5] = po[b * 3 + 2];
    P[6] = pi[b * 3]; P[7] = pi[b * 3 + 1]; P[8] = pi[b * 3 + 2]; P[9] = pi[a * 3]; P[10] = pi[a * 3 + 1]; P[11] = pi[a * 3 + 2];
    const mx = (P[0] + P[3] + P[6] + P[9]) / 4 - cx / 8, my = (P[1] + P[4] + P[7] + P[10]) / 4 - cy / 8, mz = (P[2] + P[5] + P[8] + P[11]) / 4 - cz / 8;
    if (m.planar) {
      for (let k = 0; k < 4; k++) { U[k * 2] = P[k * 3] / m.planar; U[k * 2 + 1] = P[k * 3 + 2] / m.planar; }
    } else {
      const ou = horiz ? 0 : sgn * tE, ov = horiz ? sgn * tE : 0;
      U[0] = uv[a * 2]; U[1] = uv[a * 2 + 1]; U[2] = uv[b * 2]; U[3] = uv[b * 2 + 1];
      U[4] = uv[b * 2] + ou; U[5] = uv[b * 2 + 1] + ov; U[6] = uv[a * 2] + ou; U[7] = uv[a * 2 + 1] + ov;
    }
    if (m.flake !== undefined || !fl) { F[0] = F[1] = F[2] = F[3] = m.flake || 0; } else { F[0] = F[3] = fl[a]; F[1] = F[2] = fl[b]; }
    S[0] = S[1] = S[2] = S[3] = m.soot || 0;
    mb.set(m.layer, m.tint);
    mb.emit(mx, my, mz, m.ao, true);
  };
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const c = j * nu + i;
    if (st[c] !== 0) continue;
    const v00 = j * nu1 + i, v10 = v00 + 1, v01 = v00 + nu1, v11 = v01 + 1;
    let code = i > 0 ? st[c - 1] : border[0]; if (code) edge(v00, v01, code, i, j, false, -1);
    code = i < nu - 1 ? st[c + 1] : border[1]; if (code) edge(v10, v11, code, i, j, false, 1);
    code = j > 0 ? st[c - nu] : border[2]; if (code) edge(v00, v10, code, i, j, true, 1);
    code = j < nv - 1 ? st[c + nu] : border[3]; if (code) edge(v01, v11, code, i, j, true, -1);
  }
}

// collision boxes for the solid cells of a slab (greedy rectangles)
export function slabBoxes(cb, g, maxW = 1e9, pin = null) {
  const { nu, nv, po, st } = g, pi = pin || g.pi, nu1 = nu + 1;
  const used = new Uint8Array(nu * nv);
  const pt = (src, k) => [src[k * 3], src[k * 3 + 1], src[k * 3 + 2]];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const c = j * nu + i;
    if (st[c] || used[c]) continue;
    let w = 1;
    while (i + w < nu && w < maxW && !st[c + w] && !used[c + w]) w++;
    let h = 1;
    grow: while (j + h < nv) {
      for (let k = 0; k < w; k++) { const q = (j + h) * nu + i + k; if (st[q] || used[q]) break grow; }
      h++;
    }
    for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) used[(j + b) * nu + i + a] = 1;
    const a = j * nu1 + i, b = a + w, d = (j + h) * nu1 + i, e = d + w;
    cb.hex([pt(po, a), pt(po, b), pt(po, e), pt(po, d)], [pt(pi, a), pt(pi, b), pt(pi, e), pt(pi, d)]);
  }
}
