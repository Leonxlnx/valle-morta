// Hero props: T-54/55 style tank wreck, wooden watchtower, barbed wire and a
// few war relics. Everything is generated procedurally: a small mesh builder
// (bevelled prisms, lathes, tubes) writes merged geometry with a per-vertex
// mask (ao, paint, kind, dirt); the rust shader projects the tiling PBR set
// triplanar in object space and uses the mask for paint flakes, dirt and moss.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { enhance } from '../engine/materials.js';
import { loadPBR, loadTexture } from '../engine/textures.js';

const V3 = THREE.Vector3, M4 = THREE.Matrix4, PI = Math.PI, TAU = PI * 2;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const _p = new V3(), _q = new THREE.Quaternion(), _s = new V3(), _e = new THREE.Euler(), _n3 = new THREE.Matrix3();
const TR = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) => new M4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(s, s, s));
const mul = (...ms) => ms.reduce((a, b) => a.clone().multiply(b));
const rect = (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
const rectH = (x0, y0, x1, y1) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];           // clockwise = hole
const UP = new V3(0, 1, 0);
// matrix with local +Z running a -> b, origin at the midpoint
function frame(a, b, up = UP) {
  const z = new V3().subVectors(b, a), len = z.length(); z.normalize();
  const x = new V3().crossVectors(up, z); if (x.lengthSq() < 1e-6) x.set(1, 0, 0); x.normalize();
  const y = new V3().crossVectors(z, x);
  return { m: new M4().makeBasis(x, y, z).setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), len };
}

// ---------------------------------------------------------------- geometry primitives
// All return { V, T }: V = flat [x,y,z, nx,ny,nz, u,v, ao] per vertex, T = triangle indices.
function xf(g, m) {
  const V = g.V.slice(), e = m.elements, n = _n3.getNormalMatrix(m).elements, flip = m.determinant() < 0;
  for (let i = 0; i < V.length; i += 9) {
    const x = V[i], y = V[i + 1], z = V[i + 2], a = V[i + 3], b = V[i + 4], c = V[i + 5];
    V[i] = e[0] * x + e[4] * y + e[8] * z + e[12]; V[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; V[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const nx = n[0] * a + n[3] * b + n[6] * c, ny = n[1] * a + n[4] * b + n[7] * c, nz = n[2] * a + n[5] * b + n[8] * c, l = Math.hypot(nx, ny, nz) || 1;
    V[i + 3] = nx / l; V[i + 4] = ny / l; V[i + 5] = nz / l;
  }
  let T = g.T;
  if (flip) { T = T.slice(); for (let i = 0; i < T.length; i += 3) { const t = T[i + 1]; T[i + 1] = T[i + 2]; T[i + 2] = t; } }
  return { V, T };
}
function cat(list) {
  const V = [], T = [];
  for (const g of list) { const b = V.length / 9; for (let i = 0; i < g.V.length; i++) V.push(g.V[i]); for (let i = 0; i < g.T.length; i++) T.push(g.T[i] + b); }
  return { V, T };
}

// Prism: 2D profile (CCW, in XY) extruded along Z (centred), bevelled edges
// with face-weighted normals, optional holes (clockwise rings, unbevelled).
function prismGeo(pts, depth, b = 0, o = {}) {
  const V = [], T = [], hz = depth / 2, sc = Math.cos((o.smooth ?? 30) * PI / 180);
  const vt = (x, y, z, nx, ny, nz, u, v) => (V.push(x, y, z, nx, ny, nz, u, v, 1), V.length / 9 - 1);
  const cF = [], cK = [], c2 = [], rings = [];
  const capPt = (x, y) => { c2.push(new THREE.Vector2(x, y)); cF.push(vt(x, y, hz, 0, 0, 1, x, y)); cK.push(vt(x, y, -hz, 0, 0, -1, x, y)); return c2.length - 1; };
  [pts, ...(o.holes || [])].forEach((ring, ri) => {
    const N = ring.length, bb0 = ri ? 0 : b, zw = hz - bb0, ed = [], co = [], list = [];
    for (let i = 0; i < N; i++) { const a = ring[i], c = ring[(i + 1) % N], dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy) || 1e-9; ed.push([dx / l, dy / l, l]); }
    for (let i = 0; i < N; i++) {
      const p = ring[i], e0 = ed[(i + N - 1) % N], e1 = ed[i], n0x = e0[1], n0y = -e0[0], n1x = e1[1], n1y = -e1[0];
      if (n0x * n1x + n0y * n1y >= sc) {
        let nx = n0x + n1x, ny = n0y + n1y; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
        const A = { x: p[0], y: p[1], nx, ny }; A.c = capPt(p[0] - nx * bb0, p[1] - ny * bb0); list.push(A.c);
        co.push({ A, B: A, bb: 0 });
      } else {
        const bb = Math.min(bb0, e0[2] * 0.45, e1[2] * 0.45);
        const A = { x: p[0] - e0[0] * bb, y: p[1] - e0[1] * bb, nx: n0x, ny: n0y }, B = { x: p[0] + e1[0] * bb, y: p[1] + e1[1] * bb, nx: n1x, ny: n1y };
        A.c = capPt(A.x - n0x * bb0, A.y - n0y * bb0); list.push(A.c);
        if (bb > 0) { B.c = capPt(B.x - n1x * bb0, B.y - n1y * bb0); list.push(B.c); } else B.c = A.c;
        co.push({ A, B, bb });
      }
    }
    rings.push(list);
    let s = 0;
    for (let i = 0; i < N; i++) {
      const c0 = co[i], c1 = co[(i + 1) % N], L = ed[i][2], P0 = c0.B, P1 = c1.A;
      const f0 = vt(P0.x, P0.y, zw, P0.nx, P0.ny, 0, s, zw), k0 = vt(P0.x, P0.y, -zw, P0.nx, P0.ny, 0, s, -zw);
      const f1 = vt(P1.x, P1.y, zw, P1.nx, P1.ny, 0, s + L, zw), k1 = vt(P1.x, P1.y, -zw, P1.nx, P1.ny, 0, s + L, -zw);
      T.push(f0, k1, f1, f0, k0, k1);
      c0.sf = f0; c0.sk = k0; c1.ef = f1; c1.ek = k1;
      if (bb0 > 0) { T.push(f0, f1, cF[P1.c], f0, cF[P1.c], cF[P0.c]); T.push(k0, cK[P1.c], k1, k0, cK[P0.c], cK[P1.c]); }
      s += L;
    }
    for (const c of co) if (c.bb > 0) {
      T.push(c.ef, c.sk, c.sf, c.ef, c.ek, c.sk);
      T.push(c.ef, c.sf, cF[c.B.c], c.ef, cF[c.B.c], cF[c.A.c]); T.push(c.ek, cK[c.B.c], c.sk, c.ek, cK[c.A.c], cK[c.B.c]);
    }
  });
  const faces = THREE.ShapeUtils.triangulateShape(rings[0].map((i) => c2[i]), rings.slice(1).map((r) => r.map((i) => c2[i])));
  const order = rings.flat();
  for (const f of faces) {
    const a = order[f[0]], q = order[f[1]], c = order[f[2]];
    const ar = (c2[q].x - c2[a].x) * (c2[c].y - c2[a].y) - (c2[q].y - c2[a].y) * (c2[c].x - c2[a].x);
    if (ar >= 0) T.push(cF[a], cF[q], cF[c], cK[a], cK[c], cK[q]); else T.push(cF[a], cF[c], cF[q], cK[a], cK[q], cK[c]);
  }
  return { V, T };
}
const boxG = (w, h, d, b = 0) => prismGeo(rect(w, h), d, b);
// thin curved sheet: arc band (CCW polygon) for mudguards
function arcBand(r, t, a0, a1, n) {
  const o = [], i = [];
  for (let k = 0; k <= n; k++) { const a = lerp(a0, a1, k / n); o.push([r * Math.cos(a), r * Math.sin(a)]); i.push([(r - t) * Math.cos(a), (r - t) * Math.sin(a)]); }
  return [...o, ...i.reverse()];
}

// Lathe around +Y. prof = [[r, h, ao?], ...] ordered counter-clockwise in the (r,h) half plane.
function latheGeo(prof, seg, o = {}) {
  const V = [], T = [], n = prof.length, sc = Math.cos((o.smooth ?? 40) * PI / 180), a0 = o.a0 ?? 0, a1 = o.a1 ?? TAU, sn = [];
  for (let i = 0; i < n - 1; i++) { const dr = prof[i + 1][0] - prof[i][0], dh = prof[i + 1][1] - prof[i][1], l = Math.hypot(dr, dh) || 1e-9; sn.push([dh / l, -dr / l]); }
  const nrm = (i, k) => {
    if (k < 0 || k >= n - 1) return sn[i];
    if (sn[i][0] * sn[k][0] + sn[i][1] * sn[k][1] < sc) return sn[i];
    const x = sn[i][0] + sn[k][0], y = sn[i][1] + sn[k][1], l = Math.hypot(x, y) || 1; return [x / l, y / l];
  };
  let len = 0;
  for (let i = 0; i < n - 1; i++) {
    const p0 = prof[i], p1 = prof[i + 1], n0 = nrm(i, i - 1), n1 = nrm(i, i + 1), base = V.length / 9, l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), rm = Math.max(p0[0], p1[0]);
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (a1 - a0) * k / seg, c = Math.cos(a), s = Math.sin(a);
      V.push(p0[0] * c, p0[1], p0[0] * s, n0[0] * c, n0[1], n0[0] * s, a * rm, len, p0[2] ?? 1);
      V.push(p1[0] * c, p1[1], p1[0] * s, n1[0] * c, n1[1], n1[0] * s, a * rm, len + l, p1[2] ?? 1);
    }
    for (let k = 0; k < seg; k++) { const v00 = base + k * 2, v10 = v00 + 1, v01 = v00 + 2, v11 = v00 + 3; if (p0[0] > 1e-6) T.push(v00, v10, v01); if (p1[0] > 1e-6) T.push(v01, v10, v11); }
    len += l;
  }
  return { V, T };
}

// Tube swept along a polyline of Vector3 (parallel transport frames).
function tubeGeo(pts, rad, sides = 6, o = {}) {
  const V = [], T = [], n = pts.length, closed = !!o.closed, t = new V3(), N = new V3(), B = new V3(), pv = new V3();
  const tan = (i) => { const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]; return t.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize(); };
  tan(0); N.set(0, 1, 0); if (Math.abs(t.y) > 0.9) N.set(1, 0, 0);
  let len = 0; const rings = closed ? n + 1 : n;
  for (let i = 0; i < rings; i++) {
    const p = pts[i % n]; tan(i % n); N.addScaledVector(t, -N.dot(t)).normalize(); B.crossVectors(t, N);
    if (i > 0) len += Math.hypot(p.x - pv.x, p.y - pv.y, p.z - pv.z); pv.set(p.x, p.y, p.z);
    const r = rad * (o.rf ? o.rf(i % n) : 1);
    for (let k = 0; k < sides; k++) { const a = k / sides * TAU, c = Math.cos(a), s = Math.sin(a), nx = N.x * c + B.x * s, ny = N.y * c + B.y * s, nz = N.z * c + B.z * s; V.push(p.x + nx * r, p.y + ny * r, p.z + nz * r, nx, ny, nz, a * rad, len, 1); }
    if (i > 0) { const b0 = (i - 1) * sides, b1 = i * sides; for (let k = 0; k < sides; k++) { const k1 = (k + 1) % sides; T.push(b0 + k, b0 + k1, b1 + k, b0 + k1, b1 + k1, b1 + k); } }
  }
  if (!closed && o.caps !== false) {
    for (const end of [0, 1]) {
      const i = end ? n - 1 : 0, p = pts[i], sg = end ? 1 : -1, c = V.length / 9, b0 = i * sides; tan(i);
      V.push(p.x, p.y, p.z, t.x * sg, t.y * sg, t.z * sg, 0, 0, 1);
      for (let k = 0; k < sides; k++) { const k1 = (k + 1) % sides; if (end) T.push(c, b0 + k, b0 + k1); else T.push(c, b0 + k1, b0 + k); }
    }
  }
  return { V, T };
}

// ---------------------------------------------------------------- mesh builder
class MB {
  constructor(seed = 1, uvs = 0.5, swap = false) { this.p = []; this.n = []; this.u = []; this.m = []; this.i = []; this.np = 0; this.rnd = mulberry(seed); this.uvs = uvs; this.swap = swap; }
  add(g, m, mask = [1, 0.5, 0, 0]) {
    const t = m ? xf(g, m) : g, V = t.V, T = t.T, b = this.np, uo = this.rnd() * 3.7, vo = this.rnd() * 5.3, s = this.uvs;
    for (let i = 0; i < V.length; i += 9) {
      this.p.push(V[i], V[i + 1], V[i + 2]); this.n.push(V[i + 3], V[i + 4], V[i + 5]);
      if (this.swap) this.u.push(V[i + 7] * s + uo, V[i + 6] * s + vo); else this.u.push(V[i + 6] * s + uo, V[i + 7] * s + vo);
      this.m.push(mask[0] * V[i + 8], mask[1], mask[2], mask[3]);
    }
    for (let i = 0; i < T.length; i++) this.i.push(T[i] + b);
    this.np += V.length / 9;
  }
  get tris() { return this.i.length / 3; }
  geometry() {
    const g = new THREE.BufferGeometry(), mk = new Uint8Array(this.m.length);
    for (let i = 0; i < mk.length; i++) mk[i] = Math.round(clamp(this.m[i]) * 255);
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('aMask', new THREE.BufferAttribute(mk, 4, true));
    g.setIndex(this.i);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

// Cheap baked occlusion: hemisphere rays against analytic occluders
// (boxes [x0,y0,z0,x1,y1,z1], spheres [x,y,z,r], ground plane) written into mask.x; dirt into mask.w.
function bakeAO(mb, boxes, sph, gy) {
  const P = mb.p, N = mb.n, M = mb.m, maxD = 0.85, dirs = [[0, 0, 1, 1]], cand = [];
  for (let k = 0; k < 6; k++) { const a = k * PI / 3 + 0.3; dirs.push([0.8 * Math.cos(a), 0.8 * Math.sin(a), 0.6, 0.6]); }
  for (let v = 0; v < mb.np; v++) {
    const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2], ox = P[v * 3] + nx * 0.025, oy = P[v * 3 + 1] + ny * 0.025, oz = P[v * 3 + 2] + nz * 0.025;
    let tx, ty, tz; if (Math.abs(ny) < 0.9) { tx = -nz; ty = 0; tz = nx; } else { tx = 0; ty = nz; tz = -ny; }
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    cand.length = 0;
    for (const b of boxes) if (ox > b[0] - maxD && ox < b[3] + maxD && oy > b[1] - maxD && oy < b[4] + maxD && oz > b[2] - maxD && oz < b[5] + maxD && !(ox > b[0] && ox < b[3] && oy > b[1] && oy < b[4] && oz > b[2] && oz < b[5])) cand.push(b);
    let occ = 0, ws = 0;
    for (const d of dirs) {
      const dx = tx * d[0] + bx * d[1] + nx * d[2], dy = ty * d[0] + by * d[1] + ny * d[2], dz = tz * d[0] + bz * d[1] + nz * d[2];
      let th = maxD;
      if (dy < -1e-3 && oy > gy) th = Math.min(th, (gy - oy) / dy);
      const ix = 1 / (Math.abs(dx) < 1e-6 ? 1e-6 : dx), iy = 1 / (Math.abs(dy) < 1e-6 ? 1e-6 : dy), iz = 1 / (Math.abs(dz) < 1e-6 ? 1e-6 : dz);
      for (const b of cand) {
        let t0 = 0, t1 = th, a = (b[0] - ox) * ix, c = (b[3] - ox) * ix;
        if (a > c) { const s = a; a = c; c = s; } if (a > t0) t0 = a; if (c < t1) t1 = c;
        a = (b[1] - oy) * iy; c = (b[4] - oy) * iy; if (a > c) { const s = a; a = c; c = s; } if (a > t0) t0 = a; if (c < t1) t1 = c;
        a = (b[2] - oz) * iz; c = (b[5] - oz) * iz; if (a > c) { const s = a; a = c; c = s; } if (a > t0) t0 = a; if (c < t1) t1 = c;
        if (t0 <= t1) th = t0;
      }
      for (const s of sph) {
        const cx = ox - s[0], cy = oy - s[1], cz = oz - s[2], bq = cx * dx + cy * dy + cz * dz, cc = cx * cx + cy * cy + cz * cz - s[3] * s[3];
        if (cc > 0) { const disc = bq * bq - cc; if (disc > 0) { const t = -bq - Math.sqrt(disc); if (t > 0 && t < th) th = t; } }
      }
      occ += d[3] * (1 - th / maxD); ws += d[3];
    }
    const ao = 1 - 0.92 * occ / ws;
    M[v * 4] *= ao;
    M[v * 4 + 3] = clamp(Math.max(M[v * 4 + 3], sstep(0.85, 0.08, P[v * 3 + 1]) * 0.6) + (1 - ao) * 0.3);
  }
}

// ---------------------------------------------------------------- materials
const VPARS = /* glsl */`attribute vec4 aMask; varying vec4 ppM; varying vec3 ppP; varying vec3 ppN;`;
const VBEGIN = /* glsl */`ppM = aMask; ppP = position; ppN = normal;`;
const FPARS = /* glsl */`
uniform sampler2D ppCol; uniform sampler2D ppNrm; uniform sampler2D ppArh; uniform sampler2D ppMsk;
uniform mat3 normalMatrix;
uniform vec4 ppK;      // x uv scale, y normal strength, z roughness scale
uniform vec3 ppPaint;
varying vec4 ppM; varying vec3 ppP; varying vec3 ppN;
float ppAO;
vec4 ppTri(sampler2D t, vec3 q, vec3 w, vec3 dx, vec3 dy) {
  vec4 c = vec4(0.0);
  if (w.x > 0.004) c += textureGrad(t, q.zy, dx.zy, dy.zy) * w.x;
  if (w.y > 0.004) c += textureGrad(t, q.xz, dx.xz, dy.xz) * w.y;
  if (w.z > 0.004) c += textureGrad(t, q.xy, dx.xy, dy.xy) * w.z;
  return c;
}
`;
const SURF = /* glsl */`
{
  vec3 gN = normalize(ppN);
  vec3 bw = pow(abs(gN), vec3(5.0)); bw /= (bw.x + bw.y + bw.z);
  vec3 q = ppP * ppK.x;
  vec3 qdx = dFdx(q), qdy = dFdy(q);
  vec3 col = ppTri(ppCol, q, bw, qdx, qdy).rgb;
  vec3 arh = ppTri(ppArh, q, bw, qdx, qdy).rgb;
  float mac = ppTri(ppArh, q * 0.21 + 0.37, bw, qdx * 0.21, qdy * 0.21).b;
  float hgt = arh.b, ao = ppM.x, cav = 1.0 - ao, dirt = ppM.w;
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  float rough = arh.g;
  float upf = smoothstep(0.3, 0.85, gN.y);
#ifdef PP_RUST
  float pm = ppTri(ppMsk, q, bw, qdx, qdy).r;
  float paint = ppM.y, kind = ppM.z;
  float var2 = ppTri(ppArh, q * 0.43 + 0.71, bw, qdx * 0.43, qdy * 0.43).b;
  float kp = smoothstep(0.5, 0.62, paint + (mac - 0.55) * 2.4);
  vec3 rustC = vec3(0.27, 0.105, 0.038) * (0.4 + 1.2 * hgt);
  col = mix(col, col * vec3(2.0, 1.2, 0.72) + vec3(0.02, 0.006, 0.0), smoothstep(0.52, 0.72, var2) * 0.7 * (1.0 - pm));
  col = mix(col, rustC * (0.7 + 0.6 * var2), pm * (1.0 - kp));
  float pc = pm * kp;
  col = mix(col, ppPaint * (0.5 + 1.0 * hgt), pc * 0.85);
  rough = mix(rough, rough * 0.8, pc);
  float sidef = 1.0 - abs(gN.y);
  float stk = texture2D(ppArh, vec2((ppP.x + ppP.z) * 1.9, ppP.y * 0.13)).b;
  float sA = sidef * smoothstep(0.58, 0.8, stk) * (0.35 + 0.65 * pc);
  col = mix(col, rustC * 0.75, sA * 0.8);
  float trk = 1.0 - smoothstep(0.0, 0.25, abs(kind - 0.5));
  col = mix(col, vec3(0.075, 0.05, 0.036) * (0.5 + 1.1 * hgt), trk * 0.75);
  float rub = smoothstep(0.75, 0.95, kind);
  col = mix(col, vec3(0.034, 0.032, 0.03) + 0.05 * hgt, rub);
  rough = mix(rough, 0.82 + 0.1 * hgt, rub);
#else
  col = (0.42 + 1.6 * lum) * ppPaint;
#endif
  float dA = clamp(dirt * 1.25 + cav * 0.6 - hgt * 0.6 - 0.12 + (mac - 0.55) * 0.5, 0.0, 1.0);
  col = mix(col, vec3(0.10, 0.082, 0.06) * (0.6 + 0.7 * mac), dA * 0.85);
  float mA = upf * smoothstep(0.68, 0.82, mac * 0.6 + cav * 0.9 + (1.0 - hgt) * 0.2 + dirt * 0.25);
  col = mix(col, vec3(0.06, 0.085, 0.022) * (0.5 + 1.2 * hgt), mA * 0.85);
  rough = mix(rough, 0.95, max(dA, mA) * 0.9);
  col *= 0.32 + 0.68 * ao;
  diffuseColor.rgb = col;
  roughnessFactor = clamp(rough * ppK.z, 0.06, 1.0);
  metalnessFactor = 0.0;
  ppAO = arh.r * (0.25 + 0.75 * ao);
  float ns = ppK.y * (1.0 - 0.6 * max(dA, mA));
  vec3 oN = vec3(0.0);
  if (bw.x > 0.004) { vec3 tn = textureGrad(ppNrm, q.zy, qdx.zy, qdy.zy).xyz * 2.0 - 1.0; oN += vec3(abs(tn.z) * gN.x, tn.y * ns + gN.y, tn.x * ns + gN.z) * bw.x; }
  if (bw.y > 0.004) { vec3 tn = textureGrad(ppNrm, q.xz, qdx.xz, qdy.xz).xyz * 2.0 - 1.0; oN += vec3(tn.x * ns + gN.x, abs(tn.z) * gN.y, tn.y * ns + gN.z) * bw.y; }
  if (bw.z > 0.004) { vec3 tn = textureGrad(ppNrm, q.xy, qdx.xy, qdy.xy).xyz * 2.0 - 1.0; oN += vec3(tn.xy * ns + gN.xy, abs(tn.z) * gN.z) * bw.z; }
  oN = normalize(oN);
  normal = normalize(normalMatrix * oN);
}`;
const WOODSURF = /* glsl */`
{
  float wl = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(wl) * vec3(1.03, 1.0, 0.95) * 1.3, ppM.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.095, 0.035) * (0.4 + 5.0 * wl), ppM.w * 0.7);
  diffuseColor.rgb *= 0.3 + 0.7 * ppM.x;
  ppAO = 0.3 + 0.7 * ppM.x;
}`;
function triMat(key, tex, o = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  return enhance(m, {
    key, vertexPars: VPARS, vertexBegin: VBEGIN, fragmentPars: (o.rust ? '#define PP_RUST\n' : '') + FPARS, surface: SURF, ao: 'ppAO',
    uniforms: {
      ppCol: { value: tex.map }, ppNrm: { value: tex.normalMap }, ppArh: { value: tex.arh }, ppMsk: { value: o.mask || tex.arh },
      ppK: { value: new THREE.Vector4(o.scale ?? 0.5, o.ns ?? 1, o.rough ?? 0.9, 0) }, ppPaint: { value: new THREE.Color().setRGB(...(o.paint || [0.2, 0.23, 0.12])) },
    },
  });
}
function woodMat(key, tex) {
  const m = new THREE.MeshStandardMaterial({ map: tex.map, normalMap: tex.normalMap, aoMap: tex.arh, roughnessMap: tex.arh, roughness: 1, metalness: 0 });
  return enhance(m, { key, vertexPars: VPARS, vertexBegin: VBEGIN, fragmentPars: 'varying vec4 ppM; float ppAO;', surface: WOODSURF, ao: 'ppAO' });
}

// ---------------------------------------------------------------- tank wreck
// Local frame: +X forward, +Y up, +Z right, ground at y = 0.
const ST = (paint, ao = 1, dirt = 0) => [ao, paint * 0.86, 0, dirt];
function buildTank(mb, col, colCyl) {
  const rnd = mb.rnd, RUB = [1, 0, 1, 0.1], TRK = [0.85, 0, 0.5, 0.3], DARK = [0.1, 0, 0.5, 0.3];
  const tube = (m, arr, rad, sides, mask, o) => mb.add(tubeGeo(arr.map((a) => { const v = new V3(a[0], a[1], a[2] || 0); return m ? v.applyMatrix4(m) : v; }), rad, sides, o), null, mask);
  const seam = (a, b) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.035), pts = [];
    for (let i = 0; i <= n; i++) pts.push([lerp(a[0], b[0], i / n) + (rnd() - 0.5) * 0.003, lerp(a[1], b[1], i / n) + (rnd() - 0.5) * 0.003, lerp(a[2], b[2], i / n) + (rnd() - 0.5) * 0.003]);
    const rr = pts.map(() => 0.6 + rnd() * 0.8); tube(null, pts, 0.008, 4, ST(0.15, 0.85), { rf: (i) => rr[i], caps: false });
  };
  const eye = tubeGeo(Array.from({ length: 12 }, (_, i) => new V3(0.042 * Math.cos(i / 12 * TAU), 0.03 + 0.042 * Math.sin(i / 12 * TAU), 0)), 0.011, 5, { closed: true });

  // ---- hull
  mb.add(prismGeo([[-2.72, 0.45], [2.52, 0.45], [3.02, 0.8], [2.18, 1.24], [-1.25, 1.24], [-2.95, 1.14], [-3.0, 0.78]], 1.96, 0.014), null, ST(0.8));
  for (const s of [-1, 1]) {
    seam([3.02, 0.8, s * 0.975], [2.18, 1.24, s * 0.975]); seam([2.18, 1.24, s * 0.975], [-1.25, 1.24, s * 0.975]); seam([-1.25, 1.24, s * 0.975], [-2.95, 1.14, s * 0.975]);
    mb.add(eye, TR(1.95, 1.235, s * 0.86, 0, PI / 2, 0), ST(0.3)); mb.add(eye, TR(-2.7, 1.15, s * 0.86, 0, PI / 2, 0), ST(0.3));
  }
  seam([2.18, 1.24, -0.97], [2.18, 1.24, 0.97]); seam([3.02, 0.8, -0.97], [3.02, 0.8, 0.97]); seam([-2.95, 1.14, -0.97], [-2.95, 1.14, 0.97]);
  // fenders: thin band following the track top, curved mudguard at the front
  const fo = [[-3.14, 0.84], [-3.07, 1.0]];
  for (let x = -2.7; x <= 2.5; x += 0.4) fo.push([x, 1.0 + (rnd() - 0.5) * 0.016]);
  for (let a = 75; a >= 10; a -= 13) fo.push([2.52 + 0.43 * Math.cos(a * PI / 180), 0.585 + 0.43 * Math.sin(a * PI / 180)]);
  const fi = fo.map((p, i) => { const a = fo[Math.max(0, i - 1)], c = fo[Math.min(fo.length - 1, i + 1)], dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy); return [p[0] + dy / l * 0.02, p[1] - dx / l * 0.02]; });
  const fend = prismGeo([...fi, ...fo.slice().reverse()], 0.69, 0.004, { smooth: 35 });
  for (const s of [1, -1]) mb.add(fend, TR(0, 0, 1.325 * s), ST(0.7, 0.95));
  // glacis: splash board, tow hooks, headlight with guard
  const GL = new M4().makeBasis(new V3(0.886, -0.464, 0), new V3(0.464, 0.886, 0), new V3(0, 0, 1)).setPosition(2.6, 1.02, 0);
  for (const s of [-1, 1]) {
    mb.add(boxG(0.016, 0.075, 1.0, 0.003), mul(GL, TR(-0.12, 0.037, s * 0.49, 0, s * 0.16, 0)), ST(0.5));
    mb.add(boxG(0.14, 0.03, 0.1, 0.006), mul(GL, TR(0.3, 0.012, s * 0.7)), ST(0.4));
    tube(GL, [[0.3, 0.02, s * 0.7], [0.3, 0.07, s * 0.7], [0.325, 0.1, s * 0.7], [0.37, 0.105, s * 0.7], [0.4, 0.08, s * 0.7], [0.4, 0.06, s * 0.7]], 0.02, 6, ST(0.25));
    tube(null, [[2.31, 1.15, 0.66 + s * 0.07], [2.31, 1.37, 0.66 + s * 0.07], [2.44, 1.385, 0.66 + s * 0.07], [2.54, 1.3, 0.66 + s * 0.07], [2.57, 1.05, 0.66 + s * 0.07]], 0.007, 5, ST(0.3));
  }
  tube(null, [[2.45, 1.38, 0.55], [2.45, 1.385, 0.77]], 0.007, 5, ST(0.3));
  mb.add(latheGeo([[0, 0], [0.07, 0, 0.7], [0.085, 0.03], [0.085, 0.11], [0.078, 0.112], [0.07, 0.09, 0.2], [0, 0.085, 0.04]], 14), TR(2.37, 1.25, 0.66, 0, 0, -PI / 2), ST(0.5));
  // driver's hatch and periscopes
  mb.add(boxG(0.5, 0.03, 0.44, 0.012), TR(1.72, 1.252, -0.52), ST(0.7));
  for (const z of [-0.4, -0.64]) mb.add(boxG(0.07, 0.05, 0.13, 0.006), TR(2.05, 1.262, z), ST(0.6));
  // engine deck: access plate with bolts, radiator grille
  const D = TR(-2.1, 1.19, 0, 0, 0, 0.0588), bolt = latheGeo([[0.013, 0], [0.013, 0.009], [0, 0.012]], 6);
  mb.add(boxG(0.72, 0.02, 1.5, 0.008), mul(D, TR(0.42, 0.01, 0)), ST(0.75));
  for (const x of [-0.32, 0.32]) for (let z = -0.68; z <= 0.69; z += 0.17) mb.add(bolt, mul(D, TR(0.42 + x, 0.02, z)), ST(0.2));
  mb.add(boxG(0.56, 0.03, 1.66, 0.006), mul(D, TR(-0.42, 0.012, 0)), ST(0.6));
  mb.add(boxG(0.5, 0.012, 1.56), mul(D, TR(-0.42, 0.028, 0)), DARK);
  for (let k = 0; k < 8; k++) mb.add(boxG(0.05, 0.008, 1.56), mul(D, TR(-0.42 + (k - 3.5) * 0.062, 0.044, 0, 0, 0, 0.45)), ST(0.4, 0.8));
  // rear fuel drums on cradles (one has fallen off behind the tank)
  const drum = latheGeo([[0, -0.45], [0.27, -0.45], [0.29, -0.435], [0.29, -0.17], [0.302, -0.155], [0.302, -0.145], [0.29, -0.13], [0.29, 0.13], [0.302, 0.145], [0.302, 0.155], [0.29, 0.17], [0.29, 0.435], [0.27, 0.45], [0, 0.45]], 24, { smooth: 50 });
  mb.add(drum, TR(-3.33, 0.98, -0.5, PI / 2, 0, 0), ST(0.75));
  const DF = mul(TR(-4.3, 0.29, 0.95, 0, 0.6, 0), TR(0, 0, 0, PI / 2, 0, 0));
  mb.add(drum, DF, ST(0.6, 1, 0.3));
  for (const zc of [-0.5, 0.5]) for (const dz of [-0.28, 0.28]) {
    const pts = [[-2.97, 1.1, zc + dz]]; for (let a = 30; a >= -210; a -= 20) pts.push([-3.33 + 0.305 * Math.cos(a * PI / 180), 0.98 + 0.305 * Math.sin(a * PI / 180), zc + dz]);
    tube(null, pts, 0.013, 5, ST(0.3));
  }
  // right fender: flat fuel cells with straps, fuel line
  [[1.32, 0, 0], [0.22, 0.02, 0], [-0.98, -0.07, 0.03]].forEach(([x, ry, dy], i) => {
    const m = TR(x, 1.12 + dy, 1.365, 0, ry, i === 2 ? 0.05 : 0);
    mb.add(boxG(0.96, 0.19, 0.5, 0.028), m, ST(0.8));
    for (const sx of [-0.3, 0.3]) mb.add(boxG(0.04, 0.2, 0.515, 0.004), mul(m, TR(sx, 0.002, 0)), ST(0.3, 0.9));
    for (const sz of [-0.1, 0.1]) mb.add(boxG(0.7, 0.012, 0.05, 0.005), mul(m, TR(0, 0.098, sz)), ST(0.7));
    mb.add(latheGeo([[0, 0], [0.045, 0], [0.045, 0.03], [0.03, 0.04], [0, 0.04]], 10), mul(m, TR(0.36, 0.095, -0.17)), ST(0.2));
  });
  tube(null, Array.from({ length: 17 }, (_, i) => [1.75 - i * 0.2, 1.245 + Math.sin(i * 1.3) * 0.012, 1.1 + Math.sin(i * 0.7) * 0.012]), 0.011, 5, ST(0.2));
  // left fender: stowage boxes and exhaust
  [[1.2, 1.1, 0.26, 0], [-0.15, 0.85, 0.22, 0.2]].forEach(([x, w, h, open]) => {
    mb.add(boxG(w, h, 0.52, 0.015), TR(x, 1.02 + h / 2, -1.36), ST(0.8));
    mb.add(boxG(w + 0.03, 0.022, 0.55, 0.008), mul(TR(x, 1.02 + h + 0.008, -1.36 + 0.275), TR(0, 0, 0, open, 0, 0), TR(0, 0, -0.275)), ST(0.75));
    for (const sx of [-0.3, 0.3]) mb.add(boxG(0.03, 0.07, 0.014, 0.003), TR(x + sx * w, 1.02 + h - 0.05, -1.36 - 0.265), ST(0.2));
  });
  mb.add(boxG(0.55, 0.15, 0.4, 0.02), TR(-1.45, 1.095, -1.33), ST(0.3));
  for (let k = 0; k < 3; k++) mb.add(boxG(0.42, 0.022, 0.02), TR(-1.45, 1.06 + k * 0.035, -1.535), DARK);
  // tow cable along the left roof edge
  tube(null, Array.from({ length: 24 }, (_, i) => { const x = 2.0 - i * 0.19; return [x, (x > -1.25 ? 1.24 : 1.24 + (x + 1.25) * 0.0588) + 0.016, -0.8 + Math.sin(x * 3.1) * 0.035]; }), 0.014, 6, ST(0.05, 0.9));

  // ---- running gear
  const WX = [1.78, 0.86, 0.02, -0.82, -1.66], WR = 0.425, WY = 0.445;
  const tyre = latheGeo([[0.335, 0.062, 0.7], [0.393, 0.062, 0.8], [0.405, 0.076], [0.405, 0.21], [0.393, 0.223], [0.335, 0.223]], 28);
  const disc = latheGeo([[0.335, 0.214, 0.9], [0.31, 0.204, 0.85], [0.288, 0.165, 0.7], [0.15, 0.142, 0.5], [0.125, 0.165, 0.55], [0.12, 0.236, 0.9], [0.096, 0.262], [0, 0.268]], 28);
  const wparts = [disc, latheGeo([[0.07, 0.066, 0.3], [0.335, 0.066, 0.45]], 20)];
  for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; wparts.push(xf(boxG(0.17, 0.05, 0.035, 0.006), TR(0.215 * Math.cos(a), 0.168, 0.215 * Math.sin(a), 0, -a, 0))); }
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; wparts.push(xf(boxG(0.022, 0.014, 0.022), TR(0.07 * Math.cos(a), 0.268, 0.07 * Math.sin(a), 0, -a, 0))); }
  const wheelSteel = cat(wparts), MIR = new M4().makeScale(1, -1, 1), axle = latheGeo([[0.07, -0.42, 0.3], [0.07, 0.07, 0.3]], 8);
  const sparts = [latheGeo([[0.09, -0.19, 0.4], [0.2, -0.19, 0.5], [0.2, 0.17, 0.7], [0.13, 0.225], [0, 0.235]], 20)];
  for (const h of [-0.115, 0.115]) {
    sparts.push(xf(latheGeo([[0.2, -0.016], [0.27, -0.016], [0.283, 0], [0.27, 0.016], [0.2, 0.016]], 26), TR(0, h, 0)));
    for (let k = 0; k < 13; k++) { const a = k / 13 * TAU; sparts.push(xf(boxG(0.07, 0.03, 0.05), TR(0.3 * Math.cos(a), h, 0.3 * Math.sin(a), 0, -a, 0))); }
  }
  const sprk = cat(sparts);
  const iparts = [latheGeo([[0.07, 0.05, 0.4], [0.236, 0.05, 0.5], [0.25, 0.062], [0.25, 0.2], [0.236, 0.214], [0.212, 0.2, 0.8], [0.19, 0.152, 0.6], [0.1, 0.132, 0.5], [0.085, 0.16, 0.6], [0.08, 0.23], [0, 0.236]], 24)];
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; iparts.push(xf(boxG(0.1, 0.04, 0.03, 0.005), TR(0.145 * Math.cos(a), 0.155, 0.145 * Math.sin(a), 0, -a, 0))); }
  const idl = cat(iparts);
  const link = cat([boxG(0.118, 0.034, 0.56, 0.005), prismGeo([[-0.03, 0.016], [0.03, 0.016], [0.017, 0.04], [-0.017, 0.04]], 0.5, 0),
    xf(boxG(0.137, 0.03, 0.036), TR(0, 0.004, 0.264)), xf(boxG(0.137, 0.03, 0.036), TR(0, 0.004, -0.264)),
    prismGeo([[-0.036, -0.016], [-0.012, -0.078], [0.012, -0.078], [0.036, -0.016]], 0.05, 0)]);
  const track = (side, broken) => {
    const C = broken ? [{ x: 4.15, y: WY - WR, r: 0 }, { x: WX[4], y: WY, r: WR }, { x: -2.56, y: 0.67, r: 0.32, top: true }, { x: 1.9, y: WY + WR + 0.004, r: 0 }]
      : [{ x: WX[0], y: WY, r: WR }, { x: WX[4], y: WY, r: WR }, { x: -2.56, y: 0.67, r: 0.32, top: true }, { x: 2.46, y: 0.6, r: 0.27 }];
    const closed = !broken, n = C.length, segs = closed ? n : n - 1, tg = [], pts = [];
    for (let i = 0; i < segs; i++) {
      const a = C[i], b = C[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy), ph = Math.atan2(dy, dx) + Math.acos(clamp((a.r - b.r) / dist, -1, 1)), nx = Math.cos(ph), ny = Math.sin(ph);
      tg.push({ ax: a.x + a.r * nx, ay: a.y + a.r * ny, bx: b.x + b.r * nx, by: b.y + b.r * ny, ang: ph });
    }
    for (let i = 0; i < segs; i++) {
      const c = C[i], t = tg[i];
      if (closed || i > 0) {
        const a0 = tg[(i - 1 + segs) % segs].ang, d = (((a0 - t.ang) % TAU) + TAU) % TAU, st = Math.max(1, Math.ceil(d * c.r / 0.01));
        for (let k = 0; k < st; k++) { const a = a0 - d * k / st; pts.push({ x: c.x + c.r * Math.cos(a), y: c.y + c.r * Math.sin(a) }); }
      }
      const L = Math.hypot(t.bx - t.ax, t.by - t.ay), st = Math.max(1, Math.ceil(L / 0.01));
      for (let k = 0; k < st; k++) pts.push({ x: lerp(t.ax, t.bx, k / st), y: lerp(t.ay, t.by, k / st), top: !!c.top, f: k / st, L });
    }
    if (!closed) pts.push({ x: tg[segs - 1].bx, y: tg[segs - 1].by });
    for (const p of pts) if (p.top) {
      let env = 0; for (const wx of WX) { const d = Math.abs(p.x - wx); if (d < WR) env = Math.max(env, WY + Math.sqrt(WR * WR - d * d)); }
      const w = sstep(0, 0.55, p.f * p.L) * sstep(0, 0.4, (1 - p.f) * p.L); p.y = lerp(p.y, Math.min(p.y, Math.max(env, WY + WR - 0.03) + 0.004), w);
    }
    for (let it = 0; it < 4; it++) for (let i = 1; i < pts.length - 1; i++) if (pts[i].top) pts[i].y = (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4;
    const zc = side * 1.345, P3 = pts.map((p) => new V3(p.x, p.y, zc + (broken && p.y < 0.1 && p.x > 2.0 ? side * 0.4 * ((p.x - 2.0) / 2.15) ** 2 : 0)));
    const cum = [0]; for (let i = 1; i < P3.length; i++) cum.push(cum[i - 1] + P3[i].distanceTo(P3[i - 1]));
    const total = cum[cum.length - 1], cnt = closed ? Math.round(total / 0.137) : Math.floor(total / 0.137), pitch = closed ? total / cnt : 0.137, out = [];
    let j = 0;
    for (let k = 0; k < cnt; k++) { const d = k * pitch + (closed ? 0 : 0.06); while (j < P3.length - 2 && cum[j + 1] < d) j++; out.push(new V3().lerpVectors(P3[j], P3[j + 1], clamp((d - cum[j]) / ((cum[j + 1] - cum[j]) || 1)))); }
    for (let k = 0; k < cnt; k++) {
      const a = out[closed ? (k - 1 + cnt) % cnt : Math.max(0, k - 1)], b = out[closed ? (k + 1) % cnt : Math.min(cnt - 1, k + 1)];
      const t = new V3().subVectors(b, a).normalize(), o2 = new V3(0, 0, 1).cross(t).normalize(), w = new V3().crossVectors(t, o2);
      mb.add(link, new M4().makeBasis(t, o2, w).setPosition(out[k]), TRK);
    }
  };
  for (const s of [1, -1]) {
    for (const x of WX) {
      const W = mul(TR(x, WY, 1.345 * s, s * PI / 2, 0, 0), TR(0, 0, 0, 0, rnd() * TAU, 0)), Wi = mul(W, MIR);
      mb.add(tyre, W, RUB); mb.add(wheelSteel, W, ST(0.3, 0.9)); mb.add(tyre, Wi, [0.55, 0, 1, 0.2]); mb.add(wheelSteel, Wi, ST(0.2, 0.5)); mb.add(axle, W, ST(0, 0.35));
    }
    const SP = TR(-2.56, 0.67, 1.345 * s, s * PI / 2, 0, 0), ID = TR(2.46, 0.6, 1.345 * s, s * PI / 2, 0, 0);
    mb.add(sprk, SP, ST(0.1, 0.8)); mb.add(idl, ID, ST(0.25, 0.85)); mb.add(idl, mul(ID, MIR), ST(0.2, 0.5)); mb.add(axle, ID, ST(0, 0.35));
    track(s, s < 0);
  }

  for (let k = 0; k < 5; k++) mb.add(link, mul(GL, TR(0.2, 0.047, (k - 2) * 0.137, 0, PI / 2, 0), TR(0, 0, 0, PI, 0, 0)), TRK);   // spare links on the glacis
  // ---- turret (traversed to the right, gun drooping)
  const TT = TR(0.3, 1.255, 0, 0, -0.18, 0);
  const DP = [[0.955, 0, 0.45], [1.03, 0.06, 0.8], [1.06, 0.17], [1.045, 0.3], [0.985, 0.44], [0.87, 0.575], [0.69, 0.685], [0.45, 0.76], [0.2, 0.795], [0, 0.8]];
  const domeH = (r) => { for (let i = 2; i < DP.length - 1; i++) if (r <= DP[i][0] && r >= DP[i + 1][0]) return lerp(DP[i][1], DP[i + 1][1], (DP[i][0] - r) / (DP[i][0] - DP[i + 1][0])); return 0.8; };
  const domeR = (h) => { for (let i = 2; i < DP.length - 1; i++) if (h >= DP[i][1] && h <= DP[i + 1][1]) return lerp(DP[i][0], DP[i + 1][0], (h - DP[i][1]) / (DP[i + 1][1] - DP[i][1])); return 1.0; };
  const onDome = (a, h, off = 0) => { const r = domeR(h) + off, x = r * Math.cos(a), z = r * Math.sin(a); return [x > 0 ? x * 1.12 : x, h, z * 0.97]; };
  const dome = latheGeo(DP, 56, { smooth: 70 });
  for (let i = 0; i < dome.V.length; i += 9) { if (dome.V[i] > 0) dome.V[i] *= 1.12; dome.V[i + 2] *= 0.97; }
  mb.add(dome, TT, ST(0.85));
  mb.add(boxG(0.14, 0.07, 0.1, 0.008), mul(TT, TR(0.62, 0.735, -0.3)), ST(0.6));
  mb.add(latheGeo([[1.0, 0, 0.6], [1.0, 0.03, 0.6], [0.95, 0.045, 0.5]], 40), TR(0.3, 1.24, 0), ST(0.4));
  const ring = (r, h, rad, mask, n = 64) => {
    const pts = []; for (let i = 0; i < n; i++) { const a = i / n * TAU, x = r * Math.cos(a), z = r * Math.sin(a); pts.push([(x > 0 ? x * 1.12 : x) + (rnd() - 0.5) * 0.004, h + (rnd() - 0.5) * 0.004, z * 0.97]); }
    const rr = pts.map(() => 0.65 + rnd() * 0.7); tube(TT, pts, rad, 4, mask, { closed: true, rf: (i) => rr[i] });
  };
  ring(0.985, 0.012, 0.012, ST(0.2, 0.6)); ring(0.66, 0.699, 0.008, ST(0.2, 0.9), 48);
  for (const a of [0.66, -0.66, 2.6, -2.6]) { const p = onDome(a, 0.6); mb.add(eye, mul(TT, TR(p[0], p[1] - 0.012, p[2], 0, -a, 0)), ST(0.3)); }
  for (const s of [-1, 1]) {   // grab rails
    const pts = []; for (let d = 50; d <= 140; d += 6) pts.push(onDome(s * d * PI / 180, 0.47, d === 50 || d === 140 ? -0.01 : 0.065));
    tube(TT, pts, 0.013, 6, ST(0.35));
    for (const d of [80, 110]) tube(TT, [onDome(s * d * PI / 180, 0.47, -0.01), onDome(s * d * PI / 180, 0.47, 0.065)], 0.011, 5, ST(0.35), { caps: false });
  }
  // gun: mantlet collar, barrel with fume extractor near the muzzle
  const GF = mul(TT, TR(1.0, 0.37, 0, 0, 0, -0.05)), AX = TR(0, 0, 0, 0, 0, -PI / 2);
  mb.add(latheGeo([[0, -0.2], [0.27, -0.2, 0.6], [0.285, 0.0, 0.7], [0.24, 0.16], [0.17, 0.25], [0.14, 0.38], [0.12, 0.4]], 20, { smooth: 50 }), mul(GF, AX), ST(0.6));
  mb.add(latheGeo([[0.112, 0.25], [0.112, 0.75], [0.102, 0.8], [0.095, 2.2], [0.088, 3.55], [0.092, 3.57], [0.122, 3.6], [0.128, 3.64], [0.128, 4.08], [0.122, 4.12], [0.092, 4.15], [0.085, 4.16], [0.083, 4.5], [0.091, 4.51], [0.091, 4.58], [0.08, 4.59], [0.052, 4.59, 0.5], [0.052, 4.2, 0.05], [0, 4.2, 0.02]], 20, { smooth: 35 }), mul(GF, AX), ST(0.55));
  // searchlight housing on a bracket
  mb.add(latheGeo([[0, 0], [0.1, 0, 0.8], [0.14, 0.04], [0.145, 0.17], [0.135, 0.17], [0.13, 0.06, 0.2], [0, 0.05, 0.05]], 16), mul(TT, TR(1.0, 0.57, 0.46), AX), ST(0.5));
  mb.add(boxG(0.22, 0.03, 0.12, 0.005), mul(TT, TR(0.98, 0.45, 0.46)), ST(0.4));
  // commander's cupola with the hatch standing open, loader's hatch closed, ventilator
  const cx = -0.18, cz = -0.5, cy = 0.72;
  mb.add(latheGeo([[0.37, 0, 0.6], [0.375, 0.05], [0.365, 0.15], [0.335, 0.2], [0.29, 0.2], [0.285, 0.1, 0.25], [0, 0.1, 0.03]], 28), mul(TT, TR(cx, cy, cz)), ST(0.7));
  for (const d of [-50, -17, 17, 50]) mb.add(boxG(0.05, 0.05, 0.12, 0.005), mul(TT, TR(cx, cy + 0.11, cz), TR(0, 0, 0, 0, -d * PI / 180, 0), TR(0.37, 0, 0)), ST(0.4));
  const lid = latheGeo([[0, -0.016, 0.5], [0.27, -0.016, 0.55], [0.275, -0.002, 0.7], [0.31, -0.002], [0.312, 0.014], [0.29, 0.024], [0.12, 0.036], [0, 0.038]], 28);
  const LM = mul(TT, TR(cx + 0.335, cy + 0.2, cz), TR(0, 0, 0, 0, 0, -1.75), TR(-0.325, 0, 0));
  mb.add(lid, LM, ST(0.65));
  tube(LM, [[-0.09, -0.016, 0], [-0.09, -0.055, 0], [0.09, -0.055, 0], [0.09, -0.016, 0]], 0.008, 5, ST(0.2));
  mb.add(boxG(0.06, 0.05, 0.22, 0.008), mul(TT, TR(cx + 0.35, cy + 0.2, cz)), ST(0.4));
  mb.add(latheGeo([[0.335, 0, 0.6], [0.34, 0.04], [0.31, 0.055], [0, 0.055]], 24), mul(TT, TR(-0.22, 0.715, 0.48)), ST(0.7));
  mb.add(lid, mul(TT, TR(-0.22, 0.786, 0.48)), ST(0.7));
  mb.add(boxG(0.06, 0.04, 0.2, 0.008), mul(TT, TR(-0.22 + 0.33, 0.775, 0.48)), ST(0.4));
  mb.add(latheGeo([[0.14, 0, 0.6], [0.15, 0.03], [0.13, 0.07], [0.07, 0.095], [0, 0.1]], 16), mul(TT, TR(0.45, 0.735, 0.28)), ST(0.7));
  mb.add(latheGeo([[0.035, 0], [0.03, 0.09], [0, 0.09]], 8), mul(TT, TR(-0.62, domeH(0.64) - 0.01, -0.12)), ST(0.3));

  // ---- colliders (tank local)
  col(TR(0, 0.5, 0), 6.2, 1.0, 3.34); col(TR(-0.4, 1.1, 0), 5.2, 0.3, 2.0); col(mul(GL, TR(0, -0.04, 0)), 0.95, 0.08, 1.96);
  for (const s of [-1, 1]) col(TR(0.2, 1.15, s * 1.36), 3.3, 0.28, 0.6);
  colCyl(mul(TT, TR(0.05, 0.4, 0)), 1.08, 0.8); col(mul(GF, TR(2.45, 0, 0)), 4.4, 0.26, 0.26);
  col(mul(TT, TR(cx + 0.39, cy + 0.5, cz)), 0.1, 0.62, 0.62); col(TR(-3.33, 0.98, -0.5), 0.6, 0.6, 0.92); col(DF, 0.6, 0.92, 0.6);
  // occluders for the AO bake
  return {
    boxes: [[-2.98, 0.45, -0.98, 2.3, 1.24, 0.98], [2.3, 0.5, -0.98, 2.85, 0.95, 0.98], [-3.1, 0.985, 0.98, 2.6, 1.02, 1.67], [-3.1, 0.985, -1.67, 2.6, 1.02, -0.98],
      [-2.9, 0, 1.04, 2.75, 0.89, 1.65], [-2.9, 0, -1.65, 2.75, 0.89, -1.04], [0.84, 1.02, 1.115, 1.8, 1.215, 1.615], [-0.26, 1.02, 1.115, 0.7, 1.215, 1.615], [-1.46, 0.98, 1.115, -0.5, 1.2, 1.615],
      [0.65, 1.02, -1.62, 1.75, 1.28, -1.1], [-0.575, 1.02, -1.62, 0.275, 1.24, -1.1], [-1.725, 1.02, -1.53, -1.175, 1.17, -1.13], [-3.63, 0.68, -0.95, -3.03, 1.28, -0.05]],
    spheres: [[0.33, 1.3, 0, 1.0]],
  };
}

// ---------------------------------------------------------------- watchtower
// Local frame: origin on the ground under the tower centre; gh(x, z) = ground height relative to it.
function buildTower(wb, wp, gh, col) {
  const rnd = wb.rnd, H = 9, b0 = 2.35, b1 = 1.4, half = (y) => lerp(b0, b1, y / H);
  const WB = [1, 0.72, 0, 0.1], WP = [1, 0.55, 0, 0.08];
  const beam = (bld, a, b, w, h, bev, mask, up) => { const f = frame(a, b, up); bld.add(prismGeo(rect(w, h), f.len, bev), f.m, mask); return f; };
  const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]], P = (c, y) => new V3(c[0] * half(y), y, c[1] * half(y));
  for (const c of C) { const f = beam(wb, P(c, gh(c[0] * b0, c[1] * b0) - 0.4), P(c, H - 0.02), 0.22, 0.22, 0.01, WB); col(f.m, 0.26, 0.26, f.len); }
  const LV = [0.7, 3.4, 6.1, 8.55];
  for (let k = 0; k < 4; k++) {
    const c0 = C[k], c1 = C[(k + 1) % 4], n = new V3((c0[0] + c1[0]) / 2, 0, (c0[1] + c1[1]) / 2), Q = (c, y, o) => P(c, y).addScaledVector(n, o);
    LV.forEach((y, li) => {
      beam(wb, Q(c0, y, 0.16), Q(c1, y, 0.16), 0.1, 0.15, 0.006, WB);
      if (li < 3) {
        const y1 = LV[li + 1];
        if (rnd() > 0.12) beam(wb, Q(c0, y + 0.12, 0.14), Q(c1, y1 - 0.12, 0.14), 0.13, 0.055, 0.005, WB, n);
        if (rnd() > 0.12) beam(wb, Q(c1, y + 0.12, 0.2), Q(c0, y1 - 0.12, 0.2), 0.13, 0.055, 0.005, WB, n);
      }
    });
  }
  // platform: bearers, joists, planks (two missing, hatch for the ladder)
  for (const s of [-1, 1]) beam(wb, new V3(-1.95, H - 0.11, s * b1), new V3(1.95, H - 0.11, s * b1), 0.18, 0.22, 0.008, WB);
  for (let x = -1.8; x <= 1.81; x += 0.6) beam(wb, new V3(x, H + 0.07, -1.9), new V3(x, H + 0.07, 1.9), 0.07, 0.14, 0.004, WB);
  let pi = 0;
  for (let z = -1.85; z <= 1.86; z += 0.195, pi++) {
    if (pi === 4 || pi === 12) continue;
    const y = H + 0.158, e0 = -1.9 - rnd() * 0.05, e1 = 1.9 + rnd() * 0.05;
    const pl = (xa, xb) => beam(wp, new V3(xa, y + (rnd() - 0.5) * 0.006, z), new V3(xb, y + (rnd() - 0.5) * 0.012, z), 0.18, 0.035, 0.004, WP);
    if (z > 1.22) { pl(e0, -0.62); pl(0.06, e1); } else pl(e0, e1);
  }
  col(TR(0, H + 0.03, 0), 3.9, 0.3, 3.9);
  // cabin: posts, half walls of horizontal boards, rails, top plates
  const y0 = H + 0.176, cw = 1.72;
  for (const c of C) beam(wb, new V3(c[0] * cw, y0, c[1] * cw), new V3(c[0] * cw, y0 + 2.1, c[1] * cw), 0.11, 0.11, 0.006, WB);
  for (let k = 0; k < 4; k++) {
    const c0 = C[k], c1 = C[(k + 1) % 4], n = new V3((c0[0] + c1[0]) / 2, 0, (c0[1] + c1[1]) / 2);
    const A = new V3(c0[0] * cw, 0, c0[1] * cw).addScaledVector(n, 0.07), B = new V3(c1[0] * cw, 0, c1[1] * cw).addScaledVector(n, 0.07);
    const seg = (bld, ta, tb, y, w, th, mask, drop = 0, up = n) => beam(bld, new V3().lerpVectors(A, B, ta).setY(y), new V3().lerpVectors(A, B, tb).setY(y - drop), w, th, 0.004, mask, up);
    for (let j = 0; j < 4; j++) {
      const y = y0 + 0.14 + j * 0.245, r = rnd(); if (r < 0.1) continue;
      const drop = r < 0.2 ? 0.3 : 0;
      if (k === 2) { seg(wp, 0, 0.48, y, 0.225, 0.024, WP); seg(wp, 0.68, 1, y, 0.225, 0.024, WP, drop); } else seg(wp, 0, 1, y, 0.225, 0.024, WP, drop);
    }
    if (k === 2) { seg(wb, 0, 0.48, y0 + 1.06, 0.07, 0.08, WB, 0, UP); seg(wb, 0.68, 1, y0 + 1.06, 0.07, 0.08, WB, 0, UP); } else seg(wb, 0, 1, y0 + 1.06, 0.07, 0.08, WB, 0, UP);
    seg(wb, -0.03, 1.03, y0 + 2.15, 0.12, 0.12, WB, 0, UP);
    col(frame(A.clone().setY(y0 + 0.55), B.clone().setY(y0 + 0.55)).m, 0.1, 1.1, 3.5);
    // hip roof face (boards from the texture, a few missing) and hip batten
    const e = 2.25, ye = y0 + 2.2, rh = 1.25, sl = Math.hypot(e, rh), t = new V3(n.z, 0, -n.x), u = new V3(-n.x * e, rh, -n.z * e).normalize(), w = new V3().crossVectors(t, u);
    const holes = k === 0 ? [rectH(0.3, 0.45, 0.56, 1.5)] : k === 2 ? [rectH(-0.9, 0.3, -0.62, 1.2), rectH(0.1, 0.9, 0.36, 1.7)] : [];
    wp.add(prismGeo([[-e, 0], [e, 0], [0, sl]], 0.03, 0, { holes }), new M4().makeBasis(t, u, w).setPosition(n.x * e, ye, n.z * e), WP);
    beam(wb, new V3(c0[0] * e, ye + 0.03, c0[1] * e), new V3(0, ye + rh + 0.05, 0), 0.09, 0.06, 0.004, WB);
    beam(wb, new V3(c0[0] * cw, y0 + 2.2, c0[1] * cw), new V3(0, ye + rh - 0.1, 0), 0.07, 0.1, 0.004, WB);
  }
  col(TR(0, y0 + 2.5, 0), 3.6, 0.5, 3.6);
  // ladder on the +Z face
  const lz = (y) => half(y) + 0.3, yl = gh(-0.3, b0 + 0.3) - 0.2;
  for (const s of [-1, 1]) beam(wb, new V3(-0.28 + s * 0.23, yl, lz(yl)), new V3(-0.28 + s * 0.23, H + 1.25, lz(H + 1.25)), 0.045, 0.075, 0.004, WB);
  for (let y = 0.35; y < H + 1.0; y += 0.31) if (rnd() > 0.1) beam(wb, new V3(-0.51, y, lz(y)), new V3(-0.05, y, lz(y)), 0.032, 0.032, 0, WB);
  col(frame(new V3(-0.28, yl, lz(yl)), new V3(-0.28, H + 1.2, lz(H + 1.2))).m, 0.5, 0.1, H + 1.2 - yl);
}

// ---------------------------------------------------------------- barbed wire (world coordinates)
const RUNS = [
  [[-83, 128.5], [-79.5, 125], [-76, 121.6], [-72.6, 118.3], [-69.3, 116.1], [-65.5, 114.6], [-61.5, 113.9], [-57.5, 114.4]],
  [[-52, 131], [-49.2, 133.2], [-46.5, 135], [-43.6, 137.2]],
  [[-92, 101.5], [-88.2, 100], [-84.3, 98.2], [-80.5, 97]],
  [[103, -7.6], [99, -7.9], [95.2, -8.4], [91.5, -8.2]],
];
function buildWire(mb, hAt, runs, col) {
  const rnd = mb.rnd, RUST = [1, 0, 0, 0.1], holes = [];
  for (let k = 0; k < 7; k++) { const cy = 0.2 + k * 0.17, h = []; for (let j = 0; j < 8; j++) { const a = -j / 8 * TAU; h.push([0.021 * Math.cos(a), cy + 0.021 * Math.sin(a)]); } holes.push(h); }
  // perforated angle-iron picket: flat web with holes plus a plain flange
  const picket = cat([prismGeo([[-0.055, -0.35], [0.055, -0.35], [0.055, 1.38], [0, 1.47], [-0.055, 1.38]], 0.008, 0, { holes, smooth: 50 }), xf(boxG(0.008, 1.73, 0.055), TR(-0.051, 0.515, 0.0315))]);
  const barb = cat([tubeGeo([new V3(-0.007, -0.023, -0.005), new V3(0.007, 0.023, 0.005)], 0.003, 3, { caps: false }), tubeGeo([new V3(-0.023, 0.007, 0.005), new V3(0.023, -0.007, -0.005)], 0.003, 3, { caps: false })]);
  const wire = (pts) => {
    if (pts.length < 3) return;
    mb.add(tubeGeo(pts, 0.0048, 3, { caps: false }), null, RUST);
    for (let i = 1; i < pts.length - 1; i += 2) mb.add(barb, mul(frame(pts[i - 1], pts[i + 1]).m, TR(0, 0, 0, 0, 0, rnd() * TAU)), RUST);
  };
  const strand = (a, b, sag, tEnd = 1) => {
    const n = Math.max(4, Math.ceil(a.distanceTo(b) / 0.065)), pts = [], ph = rnd() * 9;
    for (let i = 0; i <= n * tEnd; i++) {
      const t = i / n, p = new V3().lerpVectors(a, b, t);
      p.y -= sag * 4 * t * (1 - t) + (tEnd < 1 ? t * t * 2.2 : 0) - Math.sin(t * 31 + ph) * 0.008;
      p.x += Math.sin(t * 23 + ph) * 0.012 + Math.sin(t * 7 + ph * 2) * 0.03 * Math.min(1, sag * 3); p.z += Math.cos(t * 19 + ph) * 0.012;
      const g = hAt(p.x, p.z) + 0.012; if (p.y < g) p.y = g + Math.abs(Math.sin(t * 40 + ph)) * 0.03;
      pts.push(p);
    }
    wire(pts);
  };
  for (const run of runs) {
    const tops = [];
    for (const [x, z] of run) {
      const fallen = rnd() < 0.14, lean = fallen ? 1.0 + rnd() * 0.35 : 0.08 + rnd() * 0.4, la = rnd() * TAU;
      const m = mul(TR(x, hAt(x, z) - (fallen ? 0.25 : 0), z), new M4().makeRotationAxis(new V3(Math.cos(la), 0, Math.sin(la)), lean), TR(0, 0, 0, 0, rnd() * TAU, 0));
      mb.add(picket, m, [1, 0, 0, 0.15]);
      tops.push([0.45, 0.85, 1.27].map((h) => new V3(0, h, 0.006).applyMatrix4(m)));
      col(mul(m, TR(0, 0.7, 0)), 0.1, 1.5, 0.05);
    }
    for (let i = 0; i < run.length - 1; i++) for (let k = 0; k < 3; k++) {
      const r = rnd(); if (r < 0.18) continue;
      if (r < 0.36) strand(tops[i][k], tops[i + 1][k], 0.5, 0.35 + rnd() * 0.3); else strand(tops[i][k], tops[i + 1][k], 0.06 + rnd() * rnd() * 0.5);
    }
  }
  const coil = (x, z, dir, L, r) => {
    const pts = [], dx = Math.cos(dir), dz = Math.sin(dir);
    for (let i = 0; i <= 120; i++) { const t = i / 120, th = t * TAU * 5.5, px = x + dx * L * t - dz * r * Math.cos(th), pz = z + dz * L * t + dx * r * Math.cos(th); pts.push(new V3(px, hAt(px, pz) + 0.02 + r * 0.7 * (1 + Math.sin(th)) * (0.6 + 0.4 * Math.sin(t * 5)), pz)); }
    wire(pts);
  };
  for (const c of runs.coils || []) coil(...c);
}

// ---------------------------------------------------------------- burnt-out truck chassis (local: +X forward)
function buildTruck(mb, M, col) {
  const R0 = [0.95, 0.04, 0, 0.1], SOOT = [0.8, 0, 0.5, 0.1], PNT = [1, 0.45, 0, 0];
  const A = (g, m, k = R0) => mb.add(g, mul(M, m), k);
  const tube = (arr, rad, sides, k = R0, o) => mb.add(tubeGeo(arr.map((a) => new V3(a[0], a[1], a[2]).applyMatrix4(M)), rad, sides, o), null, k);
  for (const s of [-1, 1]) {
    A(boxG(5.6, 0.2, 0.07, 0.006), TR(0, 0.62, s * 0.42)); A(boxG(3.1, 0.08, 0.06, 0.004), TR(-1.3, 0.83, s * 0.98));
    A(boxG(1.15, 0.045, 0.07, 0.004), TR(1.9, 0.44, s * 0.5)); A(boxG(1.25, 0.06, 0.07, 0.004), TR(-1.6, 0.46, s * 0.5));
    A(prismGeo(arcBand(0.42, 0.012, 0.25, PI - 0.25, 10), 0.3, 0, { smooth: 40 }), TR(1.9, 0.3, s * 0.95), PNT);
    tube([[1.22, 1.56, s * 0.94], [1.2, 1.86, s * 0.94], [-0.1, 1.86, s * 0.94], [-0.12, 0.8, s * 0.94]], 0.02, 5, SOOT);
  }
  for (const x of [-2.6, -1.9, -1.0, -0.1, 1.1, 2.6]) A(boxG(0.08, 0.14, 0.84, 0.004), TR(x, 0.62, 0));
  for (let x = -2.75; x < 0.2; x += 0.48) A(boxG(0.06, 0.07, 2.0, 0.004), TR(x, 0.76, 0));
  A(boxG(0.09, 0.09, 1.9, 0.012), TR(1.9, 0.3, 0)); A(boxG(0.13, 0.13, 1.85, 0.02), TR(-1.6, 0.3, 0));
  A(latheGeo([[0, -0.17], [0.11, -0.15], [0.17, -0.06], [0.17, 0.06], [0.11, 0.15], [0, 0.17]], 14, { smooth: 60 }), TR(-1.6, 0.3, 0.1, 0, 0, PI / 2));
  const rim = latheGeo([[0.09, -0.08, 0.5], [0.25, -0.08, 0.6], [0.262, -0.11], [0.29, -0.11], [0.29, -0.095], [0.268, -0.07], [0.268, 0.07], [0.29, 0.095], [0.29, 0.11], [0.262, 0.11], [0.25, 0.05, 0.7], [0.13, 0.02, 0.5], [0.11, 0.06], [0, 0.07]], 20);
  for (const [x, z] of [[1.9, 0.95], [1.9, -0.95], [-1.6, 0.86], [-1.6, 1.09]]) A(rim, TR(x, 0.3, z, Math.sign(z) * PI / 2, 0, 0));
  A(boxG(0.8, 0.46, 0.5, 0.03), TR(1.75, 0.98, 0), SOOT); A(boxG(0.7, 0.1, 0.36, 0.02), TR(1.75, 1.26, 0), SOOT);
  A(latheGeo([[0, 0], [0.2, 0], [0.2, 0.03], [0, 0.03]], 12), TR(2.2, 1.0, 0, 0, 0, -PI / 2), SOOT);
  A(prismGeo(rect(0.74, 0.62), 0.07, 0, { holes: [rectH(-0.31, -0.25, 0.31, 0.25)] }), TR(2.5, 0.98, 0, 0, PI / 2, 0));
  A(boxG(1.35, 0.03, 1.9, 0.005), TR(0.55, 0.78, 0), SOOT); A(boxG(0.03, 0.78, 1.9, 0.005), TR(1.22, 1.17, 0), SOOT);
  A(prismGeo(rect(1.9, 1.05), 0.03, 0, { holes: [rectH(-0.6, 0.05, 0.6, 0.4)] }), TR(-0.12, 1.32, 0, 0, PI / 2, 0), SOOT);
  A(boxG(1.36, 0.025, 1.94, 0.008), TR(0.55, 1.87, 0, 0, 0, 0.05), PNT);
  tube([[1.2, 1.56, -0.94], [1.2, 1.56, 0.94]], 0.018, 5, SOOT); tube([[1.2, 1.1, -0.45], [0.82, 1.38, -0.45]], 0.016, 5, SOOT);
  tube(Array.from({ length: 14 }, (_, i) => { const a = i / 14 * TAU; return [0.8 + 0.2 * Math.sin(a) * 0.593, 1.4 + 0.2 * Math.sin(a) * 0.805, -0.45 + 0.2 * Math.cos(a)]; }), 0.012, 5, SOOT, { closed: true });
  tube([[-0.2, 0.83, -0.98], [-0.2, 1.6, -0.98], [-0.2, 1.6, 0.98], [-0.2, 0.83, 0.98]], 0.022, 5);
  col(mul(M, TR(-0.2, 0.5, 0)), 5.6, 1.0, 2.0); col(mul(M, TR(0.55, 1.4, 0)), 1.4, 1.0, 1.95);
}

// ---------------------------------------------------------------- ammo crate (boards with cleats), sandbags, grass tufts
function buildCrate(wp, M, open, col) {
  const K = [1, 0.3, 0, 0.5], L = 0.95, Hh = 0.3, W = 0.4, t = 0.018, A = (g, m) => wp.add(g, mul(M, m), K);
  const side = prismGeo(rect(t, 0.145), L, 0.003), end = prismGeo(rect(t, 0.145), W - 2 * t, 0.003), flat = prismGeo(rect(0.196, 0.016), L, 0.003), cleat = prismGeo(rect(0.05, 0.016), W, 0.003), batt = prismGeo(rect(t, 0.045), Hh, 0.003);
  for (const y of [0.0745, 0.2255]) for (const s of [-1, 1]) { A(side, TR(0, y, s * (W / 2 - t / 2), 0, PI / 2, 0)); A(end, TR(s * (L / 2 - t / 2), y, 0)); }
  for (const s of [-1, 1]) { A(flat, TR(0, 0.008, s * 0.099, 0, PI / 2, 0)); for (const z of [-0.12, 0.12]) A(batt, TR(s * (L / 2 + t / 2), Hh / 2, z, -PI / 2, 0, 0)); }
  const lidM = open ? mul(TR(0.05, 0.16, W / 2 + 0.13), TR(0, 0, 0, 1.15, 0, 0)) : TR(0, Hh + 0.008, 0, 0, (wp.rnd() - 0.5) * 0.06, 0);
  for (const s of [-1, 1]) { A(flat, mul(lidM, TR(0, 0, s * 0.099, 0, PI / 2, 0))); A(cleat, mul(lidM, TR(s * 0.3, 0.016, 0))); }
  col(mul(M, TR(0, Hh / 2, 0)), L, Hh, W);
}
// squashed superellipsoid sack (y = thin axis) with analytic normals
function bagGeo(rnd, A = 0.32, B = 0.09, C = 0.17) {
  const V = [], T = [], nu = 14, nv = 7, e = 0.6, pw = (t, k) => Math.sign(t) * Math.abs(t) ** k, p1 = rnd() * 6, p2 = rnd() * 6, sq = 0.85 + rnd() * 0.3;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu * TAU, v = (j / nv - 0.5) * PI, cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
    const x = A * pw(cv, e) * pw(cu, e), z = C * pw(cv, e) * pw(su, e); let y = B * sq * pw(sv, e) * (1 + 0.1 * Math.sin(x * 9 + p1) + 0.07 * Math.sin(z * 15 + p2)); if (y < 0) y *= 0.75;
    const nx = pw(cv, 2 - e) * pw(cu, 2 - e) / A, ny = pw(sv, 2 - e) / (B * sq), nz = pw(cv, 2 - e) * pw(su, 2 - e) / C, l = Math.hypot(nx, ny, nz) || 1;
    V.push(x, y, z, nx / l, ny / l, nz / l, u * 0.2, v * 0.2, 0.75 + 0.25 * clamp(sv + 0.6));
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + nu + 1; if (j > 0) T.push(a, b, a + 1); if (j < nv - 1) T.push(a + 1, b, b + 1); }
  return { V, T };
}
function buildBags(mb, hAt, cx, cz, face, col) {
  const rnd = mb.rnd, R = 2.4;
  for (let c = 0; c < 4; c++) {
    const cnt = [9, 8, 7, 4][c];
    for (let k = 0; k < cnt; k++) {
      if (c >= 2 && rnd() < 0.3) continue;
      const a = face + (k - (cnt - 1) / 2 + (c === 3 ? 1.5 : 0)) * 0.27 + (rnd() - 0.5) * 0.03, r = R + (rnd() - 0.5) * 0.08, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      mb.add(bagGeo(rnd), mul(TR(x, hAt(x, z) + 0.07 + c * 0.145, z, 0, -(a + PI / 2) + (rnd() - 0.5) * 0.3, 0), TR(0, 0, 0, (rnd() - 0.5) * 0.16, 0, (rnd() - 0.5) * 0.12)), [1 - (3 - c) * 0.06, 0, 0, 0.3 - c * 0.08]);
    }
  }
  for (let k = 0; k < 7; k++) { const a = face + (rnd() - 0.5) * 2.4, r = R + 0.5 + rnd() * 1.2, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r; mb.add(bagGeo(rnd), mul(TR(x, hAt(x, z) + 0.06, z, 0, rnd() * TAU, 0), TR(0, 0, 0, (rnd() - 0.5) * 0.3, 0, (rnd() - 0.5) * 0.3)), [0.9, 0, 0, 0.4]); }
  for (let k = -2; k <= 2; k++) { const a = face + k * 0.46, x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R; col(TR(x, hAt(x, z) + 0.27, z, 0, -(a + PI / 2), 0), 1.15, 0.55, 0.4); }
}
function buildTufts(spots, hAt, rnd) {
  const p = [], n = [], c = [], idx = [];
  for (const [sx, sz, cnt, hh] of spots) for (let b = 0; b < cnt; b++) {
    const a = rnd() * TAU, r = Math.sqrt(rnd()) * 0.17, bx = sx + Math.cos(a) * r, bz = sz + Math.sin(a) * r, by = hAt(bx, bz) - 0.02;
    const da = rnd() * TAU, dx = Math.cos(da), dz = Math.sin(da), h = hh * (0.55 + rnd() * 0.7), lean = 0.15 + rnd() * 0.5, w = 0.012 + rnd() * 0.012, tint = 0.75 + rnd() * 0.5, dry = rnd() < 0.2 ? 0.6 : 0;
    const base = p.length / 3;
    for (let k = 0; k < 4; k++) {
      const t = k / 3, off = lean * t * t * h, y = by + h * t * (1 - 0.18 * t), hw = w * (1 - t * 0.9) + 0.0012;
      for (const s of [-1, 1]) {
        p.push(bx + dx * off - dz * hw * s, y, bz + dz * off + dx * hw * s); n.push(0, 1, 0);
        c.push(lerp(lerp(0.035, 0.16, t), 0.3, dry * t) * tint, lerp(lerp(0.06, 0.22, t), 0.26, dry * t) * tint, lerp(lerp(0.015, 0.06, t), 0.12, dry * t) * tint);
      }
    }
    for (let k = 0; k < 3; k++) { const v = base + k * 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  g.setIndex(idx); g.computeBoundingSphere();
  return g;
}

// node self-test (geometry only): node -e "import('./src/world/props.js').then(m=>console.log(m._selftest()))"
export function _selftest() {
  const out = {}, noop = () => {}, bad = (b) => b.p.some((v) => !Number.isFinite(v)) || b.n.some((v) => !Number.isFinite(v));
  let mb = new MB(11); const occ = buildTank(mb, noop, noop); bakeAO(mb, occ.boxes, occ.spheres, 0.03); mb.geometry(); out.tank = [mb.tris, bad(mb)];
  const wb = new MB(21, 0.5, true), wp = new MB(22); buildTower(wb, wp, () => 0, noop); out.tower = [wb.tris, wp.tris, bad(wb), bad(wp)];
  mb = new MB(31); buildWire(mb, () => 0, RUNS, noop); out.wire = [mb.tris, bad(mb)];
  mb = new MB(41); buildTruck(mb, new M4(), noop); out.truck = [mb.tris, bad(mb)];
  mb = new MB(51); buildCrate(mb, new M4(), true, noop); out.crate = [mb.tris, bad(mb)];
  mb = new MB(61); buildBags(mb, () => 0, 0, 0, 0, noop); out.bags = [mb.tris, bad(mb)];
  out.tufts = buildTufts([[0, 0, 9, 0.4]], () => 0, mulberry(3)).index.count / 3;
  return out;
}

// ---------------------------------------------------------------- module entry
export async function build(ctx) {
  const { scene, terrain, layout } = ctx, aniso = ctx.quality?.aniso ?? 8, hAt = (x, z) => terrain.heightAt(x, z);
  if (typeof window !== 'undefined') window.__propsH = hAt;      // lets the screenshot tool aim at ground-relative targets
  const rustT = loadPBR('rust_metal', { aniso }), beamT = loadPBR('wood_beam', { aniso }), plankT = loadPBR('wood_planks', { aniso }), concT = loadPBR('concrete_old', { aniso });
  const maskT = loadTexture('./assets/tex/rust_metal_mask.jpg', { aniso });
  // the triplanar shader takes ~19 samples per pixel: keep anisotropy low on everything but the albedo
  rustT.map.anisotropy = Math.min(4, aniso); rustT.normalMap.anisotropy = Math.min(2, aniso); rustT.arh.anisotropy = 1; maskT.anisotropy = 1;
  concT.map.anisotropy = Math.min(4, aniso); concT.normalMap.anisotropy = Math.min(2, aniso); concT.arh.anisotropy = 1;
  for (const t of [beamT, plankT]) { t.normalMap.anisotropy = Math.min(4, aniso); t.arh.anisotropy = Math.min(2, aniso); }
  const all = [rustT, beamT, plankT, concT].flatMap((t) => [t.map, t.normalMap, t.arh]).concat(maskT);
  await new Promise((res) => { const t0 = performance.now(), tick = () => (all.every((t) => t.image && t.image.width) || performance.now() - t0 > 12000 ? res() : setTimeout(tick, 40)); tick(); });
  const rustM = triMat('props-rust', rustT, { rust: true, mask: maskT, scale: 0.68, ns: 1.5, rough: 0.92, paint: [0.19, 0.2, 0.09] });
  const bagM = triMat('props-bag', concT, { scale: 1.1, rough: 1.0, ns: 1.3, paint: [0.44, 0.39, 0.28] });
  const beamM = woodMat('props-beam', beamT), plankM = woodMat('props-plank', plankT);
  const tuftM = enhance(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 }), { key: 'props-tuft', surface: 'normal = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));' });
  const cols = { metal: [], wood: [], stone: [] }, stats = {}, meshes = [], rnd = mulberry(77), spots = [];
  const col = (kind, m, w, h, d) => cols[kind].push(new THREE.BoxGeometry(w, h, d).applyMatrix4(m));
  const put = (name, geo, mat, m, shadow = true) => {
    const me = new THREE.Mesh(geo, mat); me.name = `props-${name}`;
    if (m) { me.matrix.copy(m); me.matrixAutoUpdate = false; }
    me.castShadow = shadow; me.receiveShadow = true; me.updateMatrixWorld(true); scene.add(me); meshes.push(me); stats[name] = geo.index.count / 3;
    return me;
  };
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`[props] ${name} failed:`, e); } };
  // rigid placement fitted to the terrain under a footprint
  const place = (x, z, yaw, fp) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), W = (lx, lz) => { const wx = x + c * lx + s * lz, wz = z - s * lx + c * lz; return new V3(wx, hAt(wx, wz), wz); };
    const a = W(fp[0], fp[1]), b = W(fp[0], -fp[1]), d = W(-fp[0], fp[1]), e = W(-fp[0], -fp[1]);
    const n = new V3().subVectors(a, e).cross(new V3().subVectors(b, d)).normalize(); if (n.y < 0) n.negate();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, n).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
    return new M4().compose(new V3(x, (a.y + b.y + d.y + e.y) / 4, z), q, new V3(1, 1, 1));
  };
  const spot = (M, lx, lz, cnt, h) => { const v = new V3(lx, 0, lz).applyMatrix4(M); spots.push([v.x, v.z, Math.round(cnt), h]); };

  let TM = null;
  safe('tank', () => {
    const T = layout.tank;
    TM = place(T.x, T.z, PI / 2 - (T.rot || 0), [2.3, 1.35]).multiply(TR(0, -0.035, 0));
    const mb = new MB(11);
    const occ = buildTank(mb, (m, w, h, d) => col('metal', mul(TM, m), w, h, d), (m, r, h) => cols.metal.push(new THREE.CylinderGeometry(r, r, h, 10).applyMatrix4(mul(TM, m))));
    bakeAO(mb, occ.boxes, occ.spheres, 0.03);
    put('tank', mb.geometry(), rustM, TM);
    for (let x = -3.3; x <= 3.2; x += 0.3) for (const s of [-1, 1]) if (rnd() < 0.8) spot(TM, x + rnd() * 0.2, s * (1.7 + rnd() * rnd() * 0.5), 9 + rnd() * 9, 0.32 + rnd() * 0.33);
    for (let z = -1.5; z <= 1.5; z += 0.3) { spot(TM, -3.25 - rnd() * 0.4, z, 8, 0.35); if (rnd() < 0.5) spot(TM, 3.1 + rnd() * 0.4, z, 6, 0.3); }
  });
  safe('tower', () => {
    const T = layout.tower, yaw = 0.35, y0 = hAt(T.x, T.z), M = mul(TR(T.x, y0, T.z, 0, yaw, 0), TR(0, 0, 0, 0.012, 0, 0.016));
    const c = Math.cos(yaw), s = Math.sin(yaw), gh = (lx, lz) => hAt(T.x + c * lx + s * lz, T.z - s * lx + c * lz) - y0;
    const wb = new MB(21, 0.5, true), wp = new MB(22, 0.5, false);
    buildTower(wb, wp, gh, (m, w, h, d) => col('wood', mul(M, m), w, h, d));
    for (const b of [wb, wp]) for (let v = 0; v < b.np; v++) b.m[v * 4 + 3] = Math.max(b.m[v * 4 + 3], sstep(2.6, 0.1, b.p[v * 3 + 1]) * 0.5);
    put('tower-beams', wb.geometry(), beamM, M); put('tower-planks', wp.geometry(), plankM, M);
  });
  safe('wire', () => {
    const a = new MB(31), b = new MB(32), cw = (m, w, h, d) => col('metal', m, w, h, d);
    buildWire(a, hAt, Object.assign(RUNS.slice(0, 3), { coils: [[-71.5, 117.2, -0.6, 2.6, 0.3]] }), cw); buildWire(b, hAt, Object.assign(RUNS.slice(3), { coils: [[96.5, -7.4, 0.1, 2.2, 0.28]] }), cw);
    put('wire-meadow', a.geometry(), rustM); put('wire-road', b.geometry(), rustM);
  });
  safe('relics', () => {
    const T = layout.tank, mb = new MB(41), wp = new MB(42, 0.5, false);
    const KM = place(T.x + 20, T.z + 2.6, 0.3, [2.4, 0.9]).multiply(TR(0, -0.02, 0, -0.06, 0, -0.02));
    buildTruck(mb, KM, (m, w, h, d) => col('metal', m, w, h, d));
    for (let x = -2.8; x <= 2.8; x += 0.35) for (const s of [-1, 1]) if (rnd() < 0.6) spot(KM, x, s * (1.1 + rnd() * 0.3), 6 + rnd() * 5, 0.3 + rnd() * 0.25);
    put('truck', mb.geometry(), rustM);
    if (TM) {
      [[-1.2, 3.4, 0.3, 0, false], [-2.1, 4.0, 1.25, 0, true], [-1.15, 3.42, 0.55, 0.316, false], [-0.1, 4.5, -0.5, 0, false]].forEach(([lx, lz, yaw, dy, open]) => {
        const v = new V3(lx, 0, lz).applyMatrix4(TM);
        buildCrate(wp, TR(v.x, hAt(v.x, v.z) + dy, v.z, 0, yaw, 0), open, (m, w, h, d) => col('wood', m, w, h, d));
      });
      put('crates', wp.geometry(), plankM);
    }
  });
  safe('sandbags', () => {
    const b = layout.bridge; if (!b) return;
    const ex = b.x + b.dirx * (b.length / 2 + 9), ez = b.z + b.dirz * (b.length / 2 + 9), cx = ex - b.dirz * 3.4, cz = ez + b.dirx * 3.4, mb = new MB(61);
    buildBags(mb, hAt, cx, cz, Math.atan2(-b.dirz, -b.dirx), (m, w, h, d) => col('stone', m, w, h, d));
    put('sandbags', mb.geometry(), bagM);
    stats.bagsAt = [Math.round(cx), Math.round(cz)];
  });
  safe('tufts', () => { if (spots.length) put('tufts', buildTufts(spots, hAt, rnd), tuftM, null, false); });

  for (const k in cols) if (cols[k].length) {
    const cm = new THREE.Mesh(mergeGeometries(cols[k]), new THREE.MeshBasicMaterial({ visible: false }));
    cm.userData.surface = k; cm.name = `collider-props-${k}`; cm.updateMatrixWorld(true); ctx.colliders.push(cm);
  }
  stats.colliders = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.length]));
  if (typeof window !== 'undefined') window.__props = stats;
  console.info('[props] triangles', JSON.stringify(stats));
  return { meshes, stats };
}
