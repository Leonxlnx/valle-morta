// Three-arch stone bridge with the middle span blown out.
import { RNG, smoothstep, mix } from '../../core/noise.js';
import { LY, emitSlab } from './mb.js';
import { lines, domeCollider, keepConnected, jitterFlags } from './house.js';

// randomly rotated box (fallen ashlar block / slab)
function rbox(mb, x, y, z, sx, sy, sz, rng, tiltMax = 0.5) {
  const yaw = rng.range(0, 6.283), tilt = rng.range(-tiltMax, tiltMax), roll = rng.range(-tiltMax, tiltMax);
  const ct = Math.cos(tilt), U = [Math.cos(yaw) * ct, Math.sin(tilt), Math.sin(yaw) * ct], Wv = [-Math.sin(yaw), 0, Math.cos(yaw)];
  const V = [Wv[1] * U[2] - Wv[2] * U[1], Wv[2] * U[0] - Wv[0] * U[2], Wv[0] * U[1] - Wv[1] * U[0]];
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const V2 = [V[0] * cr + Wv[0] * sr, V[1] * cr + Wv[1] * sr, V[2] * cr + Wv[2] * sr], W2 = [Wv[0] * cr - V[0] * sr, Wv[1] * cr - V[1] * sr, Wv[2] * cr - V[2] * sr];
  mb.obox([x, y, z], [U[0] * sx, U[1] * sx, U[2] * sx], [V2[0] * sy, V2[1] * sy, V2[2] * sy], [W2[0] * sz, W2[1] * sz, W2[2] * sz], { tile: 4, uo: rng.f(), vo: rng.f(), aoB: 0.6 });
}

export function buildBridge(B) {
  const br = B.layout.bridge, mb = B.mb, cb = B.cb, T = B.ground, rng = new RNG(7741), noise = B.noise;
  const c = Math.cos(br.rot), s = Math.sin(br.rot);
  const W = (lx, lz) => [br.x + lx * c - lz * s, br.z + lx * s + lz * c];
  const gnd = (lx, lz) => { const p = W(lx, lz); return T(p[0], p[1]); };
  mb.xf(br.x, 0, br.z, br.rot); cb.xf(br.x, 0, br.z, br.rot);
  const Lh = br.length / 2, hw = br.width / 2;
  const S = 7.4, Pw = 2.2, a = S / 2, arches = [-(S + Pw), 0, S + Pw], deckC = br.deckY;
  const deck = (x) => {
    const e = x < 0 ? br.westY : br.eastY;
    const y = mix(e + 0.04, deckC, smoothstep(Lh - 1.5, 12.5, Math.abs(x)));
    return Math.max(y, gnd(x, 0) + 0.1, gnd(x, 1.9) + 0.06, gnd(x, -1.9) + 0.06);
  };
  const ySpr = 0.55, yCrown = deckC - 0.85, rise = Math.min(yCrown - ySpr, a), R = (a * a + rise * rise) / (2 * rise), yc = yCrown - R;
  const inArch = (x) => { for (const xa of arches) if (Math.abs(x - xa) < a) return xa; return null; };
  const bottom = (x) => {
    const xa = inArch(x);
    if (xa !== null) return yc + Math.sqrt(Math.max(0, R * R - (x - xa) * (x - xa)));
    return Math.min(gnd(x, 0), gnd(x, hw), gnd(x, -hw)) - 1.2;
  };
  const xb = [-Lh, Lh];
  for (const xa of arches) for (const sg of [-1, 1]) for (const off of [-0.02, 0.02, 0.15, 0.45, 0.9]) xb.push(xa + sg * (a - off));
  const xs = lines(xb, 0.45), nu = xs.length - 1, nu1 = nu + 1, nJ = 7, nvt = nu1 * (nJ + 1);
  const yt = xs.map(deck), yb = xs.map((x, i) => Math.min(bottom(x), yt[i] - 0.35));
  const ypos = (i, j) => yb[i] + (yt[i] - yb[i]) * j / nJ;

  // damage: the charge went off under the crown of the middle arch
  const by = yCrown + 0.2;
  const fld = (x, y, z) => {
    let v = 1 - Math.hypot(x + 0.2, (y - by) * 0.8, z * 0.3) / 5.0;
    v = Math.max(v, 1 - Math.hypot(x - 5.3, y - 3.7, (z + 1.2) * 0.6) / 2.0);
    return v + 0.2 * noise.n3(x * 0.45 + 7, y * 0.45, z * 0.45) + 0.1 * noise.n3(x * 1.3, y * 1.3, z * 1.3 + 4);
  };
  const zs = [-hw, -0.85, 0.85, hw], sts = [];
  for (let k = 0; k < 3; k++) {
    const st = new Uint8Array(nu * nJ), zc = (zs[k] + zs[k + 1]) / 2;
    for (let j = 0; j < nJ; j++) for (let i = 0; i < nu; i++) {
      const x = (xs[i] + xs[i + 1]) / 2, y = (ypos(i, j) + ypos(i + 1, j) + ypos(i, j + 1) + ypos(i + 1, j + 1)) / 4;
      st[j * nu + i] = fld(x, y, zc) > 0 ? 2 : 0;
    }
    keepConnected(st, nu, nJ, (i, j) => j === 0 && inArch((xs[i] + xs[i + 1]) / 2) === null);
    sts.push(st);
  }
  const mSide = { layer: LY.stone_masonry, tint: [1.02, 1.0, 0.96], ao: 1 }, mDeck = { layer: LY.cobblestone, tint: [1, 1, 1], ao: 1, planar: 4 };
  const mSoff = { layer: LY.stone_blocks, tint: [0.9, 0.88, 0.85], ao: 0.55 }, mBrk = { layer: LY.stone_masonry, tint: [1.12, 1.08, 1.02], ao: 0.85 };
  for (let k = 0; k < 3; k++) {
    const st = sts[k], jit = jitterFlags(st, nu, nJ);
    const po = new Float32Array(nvt * 3), pi = new Float32Array(nvt * 3), uv = new Float32Array(nvt * 2);
    for (let v = 0; v < nvt; v++) {
      const i = v % nu1, j = (v / nu1) | 0;
      let x = xs[i], y = ypos(i, j), x2 = x, y2 = y;
      if (jit[v]) { x += rng.range(-0.16, 0.16); y += rng.range(-0.13, 0.13); x2 += rng.range(-0.16, 0.16); y2 += rng.range(-0.13, 0.13); }
      po[v * 3] = x; po[v * 3 + 1] = y; po[v * 3 + 2] = zs[k + 1];
      pi[v * 3] = x2; pi[v * 3 + 1] = y2; pi[v * 3 + 2] = zs[k];
      uv[v * 2] = xs[i] / 4; uv[v * 2 + 1] = -ypos(i, j) / 4;
    }
    emitSlab(mb, {
      nu, nv: nJ, po, pi, uv, st, nO: [0, 0, 1], tEdge: (zs[k + 1] - zs[k]) / 4, outer: mSide, inner: mSide,
      faceO: (i, j) => k === 2 || sts[k + 1][j * nu + i] !== 0, faceI: (i, j) => k === 0 || sts[k - 1][j * nu + i] !== 0,
      edge: (code) => (code === 3 ? mDeck : code === 4 ? mSoff : mBrk), border: [0, 0, 4, 3],
    });
  }
  // voussoir rings
  mb.set(LY.stone_blocks, [1.12, 1.1, 1.05]);
  const nA = 18, ph0 = Math.asin(Math.min(1, a / R));
  for (const xa of arches) for (const sg of [1, -1]) {
    const z = sg * (hw + 0.05);
    const pin = (p) => [xa + R * Math.sin(p), yc + R * Math.cos(p), z];
    const pout = (p) => { const x = xa + (R + 0.42) * Math.sin(p); return [x, Math.min(yc + (R + 0.42) * Math.cos(p), deck(x) - 0.06), z]; };
    for (let q = 0; q < nA; q++) {
      const p0 = -ph0 + 2 * ph0 * q / nA, p1 = -ph0 + 2 * ph0 * (q + 1) / nA, mp = pin((p0 + p1) / 2);
      if (fld(mp[0], mp[1] + 0.2, sg * hw * 0.8) > -0.06) continue;
      mb.quad(pin(p0), pin(p1), pout(p1), pout(p0), [0, 0, sg], [0, R * p0 / 4], [0, R * p1 / 4], [0.105, R * p1 / 4], [0.105, R * p0 / 4], 1);
    }
  }
  // cutwaters on the piers
  mb.set(LY.stone_blocks, [1.0, 0.98, 0.94]);
  for (const xp of [-(a + Pw / 2), a + Pw / 2]) for (const sg of [1, -1]) {
    if (fld(xp, 1.6, sg * (hw + 0.6)) > -0.12) continue;
    const y0 = Math.min(gnd(xp, sg * (hw + 1)), gnd(xp, sg * hw)) - 1.2, y1 = ySpr + 1.0, hx = Pw / 2 + 0.05;
    const A = [xp - hx, sg * hw], Bp = [xp + hx, sg * hw], C = [xp, sg * (hw + 1.5)], at = (p, y) => [p[0], y, p[1]];
    mb.quadM(at(A, y1), at(C, y1), at(C, y0), at(A, y0), [-1, 0, sg], 4, 0, 0, 0.9, true);
    mb.quadM(at(C, y1), at(Bp, y1), at(Bp, y0), at(C, y0), [1, 0, sg], 4, 0.5, 0, 0.9, true);
    const apex = [xp, y1 + 0.9, sg * hw];
    mb.tri(at(A, y1), at(C, y1), apex, [-0.5, 1, sg], [0, 0], [0.45, 0], [0.2, 0.3]);
    mb.tri(at(C, y1), at(Bp, y1), apex, [0.5, 1, sg], [0.45, 0], [0.9, 0], [0.7, 0.3]);
  }
  // parapets
  const mPar = { layer: LY.stone_masonry, tint: [1.06, 1.04, 1.0], ao: 1 }, mCope = { layer: LY.stone_blocks, tint: [1.1, 1.08, 1.03], ao: 1 };
  const parSolid = [];
  for (const sg of [1, -1]) {
    const nv = 2, st = new Uint8Array(nu * nv), sk = sg > 0 ? 2 : 0, n2 = nu1 * (nv + 1);
    for (let i = 0; i < nu; i++) {
      const x = (xs[i] + xs[i + 1]) / 2;
      const gone = Math.abs(x) > Lh - 2.5 || sts[sk][(nJ - 1) * nu + i] !== 0 || fld(x, deck(x) + 0.5, sg * hw) > -0.1 || noise.n2(x * 0.2 + sg * 5, 3.1) > 0.55;
      st[i] = gone ? 2 : 0;
      st[nu + i] = gone || noise.n2(x * 0.6 + sg * 9, 7.7) > 0.4 ? 2 : 0;
    }
    const jit = jitterFlags(st, nu, nv);
    const po = new Float32Array(n2 * 3), pi = new Float32Array(n2 * 3), uv = new Float32Array(n2 * 2);
    for (let v = 0; v < n2; v++) {
      const i = v % nu1, j = (v / nu1) | 0;
      let x = xs[i], y = yt[i] + j * 0.45;
      if (jit[v] && j > 0) { x += rng.range(-0.15, 0.15); y += rng.range(-0.18, 0.08); }
      po[v * 3] = x; po[v * 3 + 1] = y; po[v * 3 + 2] = sg * hw;
      pi[v * 3] = x; pi[v * 3 + 1] = y; pi[v * 3 + 2] = sg * (hw - 0.42);
      uv[v * 2] = xs[i] / 4 + 0.3; uv[v * 2 + 1] = -y / 4;
    }
    emitSlab(mb, { nu, nv, po, pi, uv, st, nO: [0, 0, sg], tEdge: 0.105, outer: mPar, inner: mPar, edge: () => mCope, border: [2, 2, 0, 2] });
    parSolid.push(st);
  }
  // colliders: deck, spandrel faces, parapets, break faces
  for (let i = 0; i < nu; i++) {
    const x0 = xs[i], x1 = xs[i + 1], top = (k, ii) => sts[k][(nJ - 1) * nu + ii] === 0;
    if (top(1, i)) cb.quad([x0, yt[i], -hw], [x1, yt[i + 1], -hw], [x1, yt[i + 1], hw], [x0, yt[i], hw]);
    for (const [k, sg] of [[2, 1], [0, -1]]) {
      let j0 = -1, j1 = -1;
      for (let j = 0; j < nJ; j++) if (!sts[k][j * nu + i]) { if (j0 < 0) j0 = j; j1 = j; }
      if (j0 < 0) continue;
      const par = parSolid[sg > 0 ? 0 : 1][i] === 0 ? 0.9 : 0, z = sg * hw, zi = sg * (hw - 0.42);
      cb.quad([x0, ypos(i, j0), z], [x1, ypos(i + 1, j0), z], [x1, ypos(i + 1, j1 + 1) + par, z], [x0, ypos(i, j1 + 1) + par, z]);
      if (par) cb.quad([x0, yt[i], zi], [x1, yt[i + 1], zi], [x1, yt[i + 1] + 0.9, zi], [x0, yt[i] + 0.9, zi]);
    }
    if (i > 0 && top(1, i) !== top(1, i - 1)) cb.quad([x0, yb[i], -hw], [x0, yb[i], hw], [x0, yt[i], hw], [x0, yt[i], -hw]);
  }

  // the fallen span: a heap of rubble and squared blocks in the river
  mb.xf(); cb.xf();
  const hc = W(0.5, 0.5);
  const hAt = mb.mound(hc[0], hc[1], 7.0, 6.0, br.rot, 2.5, T, noise, { seed: 3.3, segs: 16, rings: 5, tint: [1.06, 1.04, 1.0] });
  domeCollider(cb, hc[0], hc[1], 5.2, hAt, T);
  for (let k = 0; k < 90; k++) {
    const aa = rng.range(0, 6.283), rr = Math.sqrt(rng.f()) * 0.95, lx = Math.cos(aa) * rr * 6.6, lz = Math.sin(aa) * rr * 5.6;
    const x = hc[0] + lx * c - lz * s, z = hc[1] + lx * s + lz * c, hh = hAt(x, z);
    if (hh < 0.04) continue;
    const big = k < 5, sx = big ? rng.range(0.9, 1.4) : rng.range(0.22, 0.55), sy = big ? rng.range(0.2, 0.3) : rng.range(0.13, 0.28), sz = big ? rng.range(0.55, 0.9) : rng.range(0.16, 0.36);
    mb.set(rng.chance(0.55) ? LY.stone_blocks : LY.stone_masonry, [rng.range(0.95, 1.15), rng.range(0.95, 1.12), rng.range(0.92, 1.06)]);
    rbox(mb, x, T(x, z) + hh + sy * 0.6, z, sx, sy, sz, rng, big ? 0.45 : 0.6);
  }
  for (let k = 0; k < 170; k++) {
    const aa = rng.range(0, 6.283), rr = Math.sqrt(rng.f()) * 1.05, lx = Math.cos(aa) * rr * 7, lz = Math.sin(aa) * rr * 6;
    const x = hc[0] + lx * c - lz * s, z = hc[1] + lx * s + lz * c, hh = Math.max(0, hAt(x, z));
    B.stone(x, T(x, z) + hh, z, rng.range(0.14, 0.42), rng);
  }
}
