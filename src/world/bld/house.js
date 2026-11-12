// Ruined house generator: thick carved walls with real openings, gabled tile
// roofs with exposed rafters, partial timber floors, rubble.
import { RNG, saturate, smoothstep, clamp } from '../../core/noise.js';
import { LY, emitSlab, slabBoxes } from './mb.js';

const MAS_T = [1.06, 1.03, 0.98], LINTEL_T = [1.12, 1.1, 1.05], TRIM_T = [1.15, 1.13, 1.08];
const WOOD_T = [1.05, 1.0, 0.95], CHAR_T = [0.8, 0.8, 0.8], UNDER_T = [0.72, 0.68, 0.62], RUB_T = [1.04, 1.02, 0.98];
const PLASTER = [[1.08, 1.0, 0.86], [1.1, 1.07, 1.0], [1.12, 0.98, 0.78], [1.1, 0.94, 0.84], [0.98, 0.96, 0.92], [1.05, 1.0, 0.86], [1.14, 1.05, 0.9]];
const SHUTTER = [[0.7, 1.0, 0.8], [0.75, 0.9, 1.05], [1.0, 0.85, 0.7], [0.85, 0.95, 0.85]];

// sorted break points subdivided into cells of about `cell`
export function lines(breaks, cell) {
  const b = [...breaks].sort((x, y) => x - y);
  const out = [b[0]];
  for (let k = 1; k < b.length; k++) {
    const a = out[out.length - 1], e = b[k];
    if (e - a < 0.03) continue;
    const n = Math.max(1, Math.round((e - a) / cell));
    for (let q = 1; q <= n; q++) out.push(a + (e - a) * q / n);
  }
  return out;
}

// Damage field in building space: > 0 = destroyed. Blast spheres, a collapsed
// corner (walls broken down from the top) and noise for ragged edges.
export function makeField(o) {
  const { noise, H } = o, blasts = o.blasts || [], keep = o.keep || null, amp = o.amp === undefined ? 0.5 : o.amp;
  const sx = (o.seed % 977) * 0.37, rag = o.rag === undefined ? 0.6 : o.rag, col = o.collapse || null;
  const hb = o.hbFn || ((x, z) => {
    let h = H * 1.2 + 1.0;
    if (col) { const dx = x - col.x, dz = z - col.z; h -= H * col.depth * Math.exp(-(dx * dx + dz * dz) / (2 * col.sigma * col.sigma)); }
    return h + rag * (1.5 * noise.n2(x * 0.33 + sx, z * 0.33) + 0.6 * noise.n2(x * 1.1, z * 1.1 + sx));
  });
  const f = (x, y, z) => {
    let v = (y - hb(x, z)) / 1.3;
    for (let k = 0; k < blasts.length; k++) {
      const b = blasts[k], w = 1 - Math.hypot(x - b.x, y - b.y, z - b.z) / b.r;
      if (w > v) v = w;
    }
    v += amp * (0.5 * noise.n3(x * 0.8 + sx, y * 0.8, z * 0.8) + 0.24 * noise.n3(x * 2.3, y * 2.3 + sx, z * 2.3));
    if (keep) for (const k of keep) { const d = Math.hypot(x - k.x, y - k.y, z - k.z); if (d < k.r) v -= (1 - d / k.r) * 4; }
    return v;
  };
  f.hb = hb;
  return f;
}

export function mkFrame(ax, az, bx, bz, nx, nz, t) {
  const L = Math.hypot(bx - ax, bz - az);
  return { ox: ax, oz: az, ux: (bx - ax) / L, uz: (bz - az) / L, nx, nz, L, t };
}
export const FP = (fr, u, y, dep) => [fr.ox + fr.ux * u - fr.nx * dep, y, fr.oz + fr.uz * u - fr.nz * dep];

// box in wall space: u along the wall, v up, depth into the wall (negative = proud of the face)
export function wbox(mb, fr, u0, u1, v0, v1, d0, d1, o = {}) {
  const C = FP(fr, (u0 + u1) / 2, (v0 + v1) / 2, (d0 + d1) / 2);
  const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2, hd = (d1 - d0) / 2;
  const a = o.rot || 0, ca = Math.cos(a), sa = Math.sin(a);
  const A1 = [fr.ux * ca * hu, sa * hu, fr.uz * ca * hu], A2 = [-fr.ux * sa * hv, ca * hv, -fr.uz * sa * hv], A3 = [fr.nx * hd, 0, fr.nz * hd];
  if (o.vert) mb.obox(C, A2, A1, A3, o); else mb.obox(C, A1, A2, A3, o);
}

// round-arched / circular opening: fills the corners between the rectangular
// hole of the wall grid and the curve, plus the soffit and a stone trim ring
export function archFill(B, fr, o, tO, tI, uvo) {
  const mb = B.mb, t = fr.t, r = (o.u1 - o.u0) / 2, uc = (o.u0 + o.u1) / 2;
  const full = o.arch === 2, cy = full ? (o.v0 + o.v1) / 2 : o.v1 - r;
  const n = full ? 24 : 12, a1 = full ? Math.PI * 2 : Math.PI;
  const nrm = [fr.nx, 0, fr.nz], nin = [-fr.nx, 0, -fr.nz], tw = o.trim || 0.2;
  const pt = (a, k, dep) => {
    const cs = Math.cos(a), sn = Math.sin(a);
    const m = k === 0 ? 1 : k === 1 ? 1 / Math.max(Math.abs(cs), Math.abs(sn)) : 1 + tw / r;
    const u = uc + r * cs * m, y = cy + r * sn * m;
    return [FP(fr, u, y, dep), [(uvo + u) / 4, -y / 4]];
  };
  for (let k = 0; k < n; k++) {
    const A = a1 * k / n, Bn = a1 * (k + 1) / n, mid = (A + Bn) / 2;
    const c0 = pt(A, 0, 0), c1 = pt(Bn, 0, 0), b0 = pt(A, 1, 0), b1 = pt(Bn, 1, 0);
    mb.set(0, tO); mb.quad(c0[0], c1[0], b1[0], b0[0], nrm, c0[1], c1[1], b1[1], b0[1], 1);
    const ci0 = pt(A, 0, t), ci1 = pt(Bn, 0, t), bi0 = pt(A, 1, t), bi1 = pt(Bn, 1, t);
    mb.set(0, tI); mb.quad(ci0[0], ci1[0], bi1[0], bi0[0], nin, ci0[1], ci1[1], bi1[1], bi0[1], 0.5);
    const sn = [-fr.ux * Math.cos(mid), -Math.sin(mid), -fr.uz * Math.cos(mid)];
    mb.set(0, tO); mb.quad(c0[0], c1[0], ci1[0], ci0[0], sn, c0[1], c1[1], [c1[1][0], c1[1][1] + t / 4], [c0[1][0], c0[1][1] + t / 4], 0.7);
    if (o.trim) {
      const d0 = pt(A, 0, -0.04), d1 = pt(Bn, 0, -0.04), e0 = pt(A, 2, -0.04), e1 = pt(Bn, 2, -0.04);
      const s0 = r * A / 4, s1 = r * Bn / 4;
      mb.set(LY.stone_blocks, TRIM_T); mb.quad(d0[0], d1[0], e1[0], e0[0], nrm, [0.02, s0], [0.02, s1], [0.02 + tw / 4, s1], [0.02 + tw / 4, s0], 1);
      mb.quad(d0[0], d1[0], c1[0], c0[0], sn, [0, s0], [0, s1], [0.02, s1], [0.02, s0], 0.8);
    }
  }
}

// ---------------------------------------------------------------- wall
// sp: { y0, eave, top(u)?, openings[], field, cell, bare, tO, tI, aoO, aoI, sootI, uvo, ends[2], rng, noCollide, noLintel }
export function buildWall(B, fr, sp) {
  const mb = B.mb, L = fr.L, t = fr.t, cell = sp.cell || 0.4, ops = sp.openings || [], field = sp.field, rng = sp.rng;
  const ub = [0, L], vb = [sp.y0, 0, sp.eave];
  for (const o of ops) { ub.push(o.u0, o.u1); vb.push(o.v0, o.v1); }
  const us = lines(ub, cell), vs = lines(vb, cell);
  const nu = us.length - 1, jE = vs.length - 1, nu1 = nu + 1;
  const tops = new Float32Array(nu1);
  let maxTop = sp.eave;
  for (let i = 0; i <= nu; i++) { tops[i] = sp.top ? Math.max(sp.eave, sp.top(us[i])) : sp.eave; if (tops[i] > maxTop) maxTop = tops[i]; }
  const nG = sp.top ? Math.max(1, Math.ceil((maxTop - sp.eave) / cell)) : 0;
  const nv = jE + nG, nvt = (nv + 1) * nu1;
  const vu = new Float32Array(nvt), vy = new Float32Array(nvt);
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const k = j * nu1 + i;
    vu[k] = us[i];
    vy[k] = j <= jE ? vs[j] : sp.eave + (j - jE) / nG * (tops[i] - sp.eave);
  }
  const st = new Uint8Array(nu * nv), mid = t * 0.5;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * nu1 + i, c = j * nu + i;
    const uc = (us[i] + us[i + 1]) / 2, yc = (vy[a] + vy[a + 1] + vy[a + nu1] + vy[a + nu1 + 1]) / 4;
    if (j >= jE && (vy[a + nu1] - vy[a]) + (vy[a + nu1 + 1] - vy[a + 1]) < 0.06) { st[c] = 7; continue; }
    let s = 0;
    for (const o of ops) if (uc > o.u0 && uc < o.u1 && yc > o.v0 && yc < o.v1) { s = 1; break; }
    if (!s && yc > 0.05 && field(fr.ox + fr.ux * uc - fr.nx * mid, yc, fr.oz + fr.uz * uc - fr.nz * mid) > 0) s = 2;
    st[c] = s;
  }
  // no one-cell spikes, nothing floating
  for (let pass = 0; pass < 2; pass++) for (let j = 2; j < nv; j++) for (let i = 0; i < nu; i++) {
    const c = j * nu + i;
    if (st[c]) continue;
    const l = i > 0 ? st[c - 1] : 0, r = i < nu - 1 ? st[c + 1] : 0;
    if ((l === 2 || l === 7) && (r === 2 || r === 7)) st[c] = 2;
  }
  const reach = new Uint8Array(nu * nv), stack = [];
  for (let i = 0; i < nu; i++) if (!st[i]) { reach[i] = 1; stack.push(i); }
  while (stack.length) {
    const c = stack.pop(), i = c % nu, j = (c / nu) | 0;
    if (i > 0 && !st[c - 1] && !reach[c - 1]) { reach[c - 1] = 1; stack.push(c - 1); }
    if (i < nu - 1 && !st[c + 1] && !reach[c + 1]) { reach[c + 1] = 1; stack.push(c + 1); }
    if (j > 0 && !st[c - nu] && !reach[c - nu]) { reach[c - nu] = 1; stack.push(c - nu); }
    if (j < nv - 1 && !st[c + nu] && !reach[c + nu]) { reach[c + nu] = 1; stack.push(c + nu); }
  }
  for (let c = 0; c < nu * nv; c++) if (!st[c] && !reach[c]) st[c] = 2;

  // per vertex masks
  const fl = new Float32Array(nvt), jit = new Uint8Array(nvt), bare = sp.bare || 0;
  const sootOps = ops.filter((o) => o.soot);
  const so = sootOps.length ? new Float32Array(nvt) : null;
  for (let k = 0; k < nvt; k++) {
    const u = vu[k], y = vy[k];
    fl[k] = y > -0.3 ? saturate(bare + smoothstep(-0.85, 0.05, field(fr.ox + fr.ux * u - fr.nx * mid, y, fr.oz + fr.uz * u - fr.nz * mid))) : bare;
    if (so) {
      let s = 0;
      for (const o of sootOps) {
        const dy = y - o.v1;
        if (dy < -0.35 || dy > 2.4) continue;
        const dx = Math.max(0, Math.abs(u - (o.u0 + o.u1) / 2) - (o.u1 - o.u0) / 2);
        s = Math.max(s, saturate(1 - dx / 0.55) * (dy < 0 ? 0.55 : 1 - dy / 2.4) * 0.95);
      }
      so[k] = s;
    }
  }
  for (let j = 1; j <= nv; j++) for (let i = 1; i < nu; i++) {
    let brk = false, opn = false;
    for (let dj = -1; dj <= 0; dj++) for (let di = -1; di <= 0; di++) {
      const cj = j + dj, ci = i + di;
      if (cj >= nv) continue;
      const s = st[cj * nu + ci];
      if (s === 2) brk = true; else if (s === 1) opn = true;
    }
    if (brk && !opn) jit[j * nu1 + i] = 1;
  }
  const po = new Float32Array(nvt * 3), pi = new Float32Array(nvt * 3), uv = new Float32Array(nvt * 2), uvo = sp.uvo || 0;
  for (let k = 0; k < nvt; k++) {
    let u = vu[k], y = vy[k], u2 = u, y2 = y;
    if (jit[k]) { const a = 0.33 * cell; u += rng.range(-a, a); y += rng.range(-a, a); u2 = u + rng.range(-a, a) * 0.8; y2 = y + rng.range(-a, a) * 0.8; }
    po[k * 3] = fr.ox + fr.ux * u; po[k * 3 + 1] = y; po[k * 3 + 2] = fr.oz + fr.uz * u;
    pi[k * 3] = fr.ox + fr.ux * u2 - fr.nx * t; pi[k * 3 + 1] = y2; pi[k * 3 + 2] = fr.oz + fr.uz * u2 - fr.nz * t;
    uv[k * 2] = (uvo + vu[k]) / 4; uv[k * 2 + 1] = -vy[k] / 4;
  }
  for (let k = 0; k < nvt; k++) if (fl[k] < 0.1) fl[k] = 0;
  const plain = new Uint8Array(nu * nv), plainI = new Uint8Array(nu * nv);
  for (let j = 0; j < jE; j++) for (let i = 0; i < nu; i++) {
    const c = j * nu + i;
    if (st[c]) continue;
    const a = j * nu1 + i, b = a + 1, d = a + nu1, e = d + 1;
    if (jit[a] || jit[b] || jit[d] || jit[e]) continue;
    plainI[c] = 1;
    if (fl[a] + fl[b] + fl[d] + fl[e] === 0 && (!so || so[a] + so[b] + so[d] + so[e] === 0)) plain[c] = 1;
  }
  const tO = sp.tO, tI = sp.tI || tO;
  const lay0 = sp.layer || 0;
  const mRev = { layer: lay0, tint: tO, ao: 0.72 }, mBrk = { layer: LY.stone_masonry, tint: MAS_T, ao: 0.9, flake: 0 }, mEnd = { layer: lay0, tint: tO, ao: 1 };
  const g = {
    nu, nv, po, pi, uv, st, fl, soot: so, plain, plainI, nO: [fr.nx, 0, fr.nz], tEdge: t / 4, sootI: sp.sootI || 0,
    outer: { layer: lay0, tint: tO, ao: sp.aoO === undefined ? 1 : sp.aoO }, inner: { layer: 0, tint: tI, ao: sp.aoI === undefined ? 0.5 : sp.aoI },
    edge: (c) => (c === 1 ? mRev : c === 6 ? mEnd : mBrk), border: [sp.ends ? sp.ends[0] : 2, sp.ends ? sp.ends[1] : 2, 0, 2],
  };
  emitSlab(mb, g);
  if (B.cb && !sp.noCollide) slabBoxes(B.cb, g);

  // ---- dressings
  const solidAt = (u, y) => {
    if (u <= 0 || u >= L || y >= sp.eave) return false;
    let i = 0, j = 0;
    while (i < nu - 1 && us[i + 1] <= u) i++;
    while (j < jE - 1 && vs[j + 1] <= y) j++;
    return st[j * nu + i] === 0;
  };
  for (const o of ops) {
    if (o.arch) { archFill(B, fr, o, tO, tI, uvo); continue; }
    const uc = (o.u0 + o.u1) / 2, vc = (o.v0 + o.v1) / 2;
    const okTop = solidAt(uc, o.v1 + 0.15) && solidAt(o.u0 - 0.15, o.v1 - 0.25) && solidAt(o.u1 + 0.15, o.v1 - 0.25);
    const okBot = o.door ? true : solidAt(uc, o.v0 - 0.15) && solidAt(o.u0 - 0.15, o.v0 + 0.25) && solidAt(o.u1 + 0.15, o.v0 + 0.25);
    if (okTop && !sp.noLintel) { mb.set(LY.stone_blocks, LINTEL_T); wbox(mb, fr, o.u0 - 0.2, o.u1 + 0.2, o.v1 - 0.02, o.v1 + 0.21, -0.03, 0.2, { tile: 4, skip: 8, uo: uc * 0.3 }); }
    if (okBot && !o.door && !sp.noLintel) { mb.set(LY.stone_blocks, LINTEL_T); wbox(mb, fr, o.u0 - 0.09, o.u1 + 0.09, o.v0 - 0.09, o.v0 + 0.025, -0.07, 0.24, { tile: 4, skip: 8, uo: uc * 0.7 }); }
    if (o.frame && okTop && okBot) {
      const fw = o.big ? 0.11 : 0.06, d0 = 0.1, d1 = o.big ? 0.24 : 0.19;
      mb.set(o.soot ? LY.wood_charred : LY.wood_beam, o.soot ? CHAR_T : [1.25, 1.2, 1.12]);
      wbox(mb, fr, o.u0, o.u0 + fw, o.v0, o.v1, d0, d1, { vert: true, skip: 48 });
      wbox(mb, fr, o.u1 - fw, o.u1, o.v0, o.v1, d0, d1, { vert: true, skip: 48 });
      wbox(mb, fr, o.u0 + fw, o.u1 - fw, o.v1 - fw, o.v1, d0, d1, { skip: 48 });
      wbox(mb, fr, o.u0 + fw, o.u1 - fw, o.v0, o.v0 + fw, d0, d1, { skip: 48 });
      if (o.big || o.frame > 1) wbox(mb, fr, uc - fw / 2, uc + fw / 2, o.v0 + fw, o.v1 - fw, d0, d1, { vert: true, skip: 48 });
      if (o.big) {
        mb.set(LY.wood_planks, [1.05, 1.0, 0.92]);
        wbox(mb, fr, o.u0 - 0.12, o.u1 + 0.12, o.v0 - 0.05, o.v0, -0.05, t + 0.16, { tile: 2 });
      }
    }
    if (o.shutter && okTop && okBot) {
      const sw = (o.u1 - o.u0) / 2, tint = SHUTTER[(o.shutter >> 2) % SHUTTER.length];
      mb.set(LY.wood_planks, tint);
      if ((o.shutter & 1) && solidAt(o.u0 - sw * 0.6, vc)) wbox(mb, fr, o.u0 - sw - 0.03, o.u0 - 0.03, o.v0 - 0.03, o.v1 - 0.03, -0.075, -0.04, { rot: rng.range(-0.1, 0.03), tile: 2, uo: rng.f() });
      if ((o.shutter & 2) && solidAt(o.u1 + sw * 0.6, vc)) wbox(mb, fr, o.u1 + 0.03, o.u1 + sw + 0.03, o.v0 - 0.03, o.v1 - 0.03, -0.075, -0.04, { rot: rng.range(-0.03, 0.14), tile: 2, uo: rng.f() });
    }
  }
  return { st, us, vs, nu, nv, jE, solidAt, grid: g };
}

// flood fill helper: keeps solid cells connected to a seed
export function keepConnected(st, nu, nv, isSeed) {
  const reach = new Uint8Array(nu * nv), stack = [];
  for (let c = 0; c < nu * nv; c++) if (!st[c] && isSeed(c % nu, (c / nu) | 0)) { reach[c] = 1; stack.push(c); }
  while (stack.length) {
    const c = stack.pop(), i = c % nu, j = (c / nu) | 0;
    if (i > 0 && !st[c - 1] && !reach[c - 1]) { reach[c - 1] = 1; stack.push(c - 1); }
    if (i < nu - 1 && !st[c + 1] && !reach[c + 1]) { reach[c + 1] = 1; stack.push(c + 1); }
    if (j > 0 && !st[c - nu] && !reach[c - nu]) { reach[c - nu] = 1; stack.push(c - nu); }
    if (j < nv - 1 && !st[c + nu] && !reach[c + nu]) { reach[c + nu] = 1; stack.push(c + nu); }
  }
  let n = 0;
  for (let c = 0; c < nu * nv; c++) { if (!st[c] && !reach[c]) st[c] = 2; if (!st[c]) n++; }
  return n;
}
export function jitterFlags(st, nu, nv) {
  const nu1 = nu + 1, jit = new Uint8Array(nu1 * (nv + 1));
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    for (let dj = -1; dj <= 0; dj++) for (let di = -1; di <= 0; di++) {
      const cj = j + dj, ci = i + di;
      if (cj < 0 || ci < 0 || cj >= nv || ci >= nu) continue;
      if (st[cj * nu + ci] === 2) jit[j * nu1 + i] = 1;
    }
  }
  return jit;
}
function plainCells(st, jit, nu, nv) {
  const nu1 = nu + 1, plain = new Uint8Array(nu * nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * nu1 + i;
    if (!st[j * nu + i] && !jit[a] && !jit[a + 1] && !jit[a + nu1] && !jit[a + nu1 + 1]) plain[j * nu + i] = 1;
  }
  return plain;
}
// emits contiguous runs of a sampled predicate as beams
function beamRuns(mb, K, ok, pt, w, h, layerOf) {
  let run = -1;
  for (let k = 0; k <= K; k++) {
    const good = k < K && ok(k);
    if (good && run < 0) run = k;
    if (!good && run >= 0) {
      const lay = layerOf((run + k) / 2);
      mb.set(lay, lay === LY.wood_charred ? CHAR_T : WOOD_T);
      mb.beam(pt(run), pt(k), w, h, { skip: run === 0 && k === K ? 48 : 0, uo: run * 0.37 + w * 3 });
      run = -1;
    }
  }
}

const sp0 = () => 0;
// ---------------------------------------------------------------- roof
// R: { w, d, eave, pitch, field, roofF, rng, tint, burnt, uvo, og, oe }
export function buildRoof(B, R) {
  const mb = B.mb, { w, d, eave, pitch, field, roofF, rng } = R;
  const og = R.og === undefined ? 0.35 : R.og, oe = R.oe === undefined ? 0.5 : R.oe, th = 0.09;
  const tanp = Math.tan(pitch), cosp = Math.cos(pitch), sinp = Math.sin(pitch);
  const ridgeY = eave + d / 2 * tanp, Ls = (d / 2 + oe) / cosp;
  const us = lines([-w / 2 - og, w / 2 + og], 0.5), nu = us.length - 1, nu1 = nu + 1;
  const nv = Math.ceil(Ls / 0.4), nvt = (nv + 1) * nu1;
  const yU = (z) => eave + (d / 2 - Math.abs(z)) * tanp;
  const vd = new Float32Array(nv + 1);
  for (let j = 0; j <= nv; j++) vd[j] = Math.min(j * 0.4, Ls);
  const top = [null, null];
  const mEdge = { layer: LY.roof_tiles, tint: [R.tint[0] * 0.8, R.tint[1] * 0.78, R.tint[2] * 0.78], ao: 0.8 };
  for (let si = 0; si < 2; si++) {
    const s = si ? -1 : 1;
    const zAt = (dist) => s * (d / 2 + oe - dist * cosp);
    const st = new Uint8Array(nu * nv);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const x = (us[i] + us[i + 1]) / 2, z = zAt((vd[j] + vd[j + 1]) / 2);
      st[j * nu + i] = roofF(x, yU(z), z) > 0 ? 2 : 0;
    }
    keepConnected(st, nu, nv, (i, j) => {
      const x = (us[i] + us[i + 1]) / 2, z = zAt((vd[j] + vd[j + 1]) / 2);
      if (Math.abs(Math.abs(z) - (d / 2 - 0.25)) < 0.45 && Math.abs(x) < w / 2) return field(x, eave - 0.3, s * (d / 2 - 0.25)) < 0;
      if (Math.abs(Math.abs(x) - (w / 2 - 0.25)) < 0.5 && Math.abs(z) < d / 2) return field(Math.sign(x) * (w / 2 - 0.25), yU(z) - 0.4, z) < 0;
      return false;
    });
    const jit = jitterFlags(st, nu, nv), plain = plainCells(st, jit, nu, nv);
    const po = new Float32Array(nvt * 3), pi = new Float32Array(nvt * 3), uv = new Float32Array(nvt * 2);
    for (let k = 0; k < nvt; k++) {
      const i = k % nu1, j = (k / nu1) | 0;
      let x = us[i], dist = vd[j], drop = 0.035 * B.noise.n2(x * 0.45 + R.uvo, dist * 0.45 + si * 7);
      if (jit[k]) { x += rng.range(-0.15, 0.15); dist += rng.range(-0.14, 0.14); drop -= rng.range(0, 0.24); }
      const z = zAt(dist), y = yU(z) + drop;
      po[k * 3] = x; po[k * 3 + 1] = y + th / cosp; po[k * 3 + 2] = z;
      pi[k * 3] = x; pi[k * 3 + 1] = y; pi[k * 3 + 2] = z;
      uv[k * 2] = (R.uvo + us[i]) / 4; uv[k * 2 + 1] = -vd[j] / 4;
    }
    emitSlab(mb, {
      nu, nv, po, pi, uv, st, plain, nO: [0, cosp, s * sinp], tEdge: th / 4,
      outer: { layer: LY.roof_tiles, tint: R.tint, ao: 1 }, inner: { layer: LY.wood_planks, tint: R.burnt ? [0.4, 0.38, 0.36] : UNDER_T, ao: 0.5 },
      edge: () => mEdge, border: [5, 5, 5, 5],
    });
    top[si] = st.subarray((nv - 1) * nu, nv * nu);
  }
  // ridge cap
  mb.set(LY.roof_tiles, [R.tint[0] * 0.92, R.tint[1] * 0.9, R.tint[2] * 0.9]);
  const ry = ridgeY + th / cosp;
  let run = -1;
  for (let i = 0; i <= nu; i++) {
    const ok = i < nu && !top[0][i] && !top[1][i];
    if (ok && run < 0) run = i;
    if (!ok && run >= 0) { mb.abox(us[run], ry - 0.05, -0.13, us[i], ry + 0.08, 0.13, { axis: 'x', tile: 4, skip: 2 }); run = -1; }
  }
  // chimney
  if (R.chimney) {
    const cx = R.chimney[0], cz = R.chimney[1], y0 = yU(cz) - 0.3, y1 = ridgeY + 0.7;
    if (roofF(cx, yU(cz), cz) < -0.25) {
      mb.set(sp0(R), R.chimTint || [1, 1, 1]);
      mb.abox(cx - 0.28, y0, cz - 0.28, cx + 0.28, y1, cz + 0.28, { axis: 'y', tile: 4, skip: 48, uo: cx });
      mb.set(LY.stone_blocks, LINTEL_T);
      mb.abox(cx - 0.36, y1, cz - 0.36, cx + 0.36, y1 + 0.07, cz + 0.36, { tile: 4 });
      mb.abox(cx - 0.2, y1 + 0.07, cz - 0.2, cx + 0.2, y1 + 0.24, cz + 0.2, { tile: 4, skip: 2 });
    }
  }
  // rafters, purlins, tie beams
  const charAt = (x, y, z) => (R.burnt && roofF(x, y, z) > -0.3 ? LY.wood_charred : LY.wood_beam);
  const nR = Math.max(2, Math.round((w - 0.8) / 0.95)), K = 7;
  for (let r = 0; r <= nR; r++) {
    const x = -w / 2 + 0.4 + (w - 0.8) * r / nR;
    for (const s of [1, -1]) {
      const zAt = (dist) => s * (d / 2 + oe - dist * cosp);
      const pt = (k) => { const z = zAt(Math.max(0.06, Ls * k / K)); return [x, yU(z) - 0.075, z]; };
      beamRuns(mb, K, (k) => { const z = zAt(Ls * (k + 0.5) / K); return roofF(x, yU(z), z) < 0.55; }, pt, 0.1, 0.13,
        (km) => { const z = zAt(Ls * km / K); return charAt(x, yU(z), z); });
    }
  }
  const nP = Math.max(2, Math.round(w / 1.1));
  for (const pz of [0, d / 4 + 0.1, -(d / 4 + 0.1)]) {
    const y = yU(pz) - 0.24;
    beamRuns(mb, nP, (k) => roofF(-w / 2 + 0.3 + (w - 0.6) * (k + 0.5) / nP, y, pz) < 0.8, (k) => [-w / 2 + 0.3 + (w - 0.6) * k / nP, y, pz], 0.14, 0.18,
      (km) => charAt(-w / 2 + 0.3 + (w - 0.6) * km / nP, y, pz));
  }
  const nT = Math.max(1, Math.round(w / 2.8) - 1);
  for (let k = 1; k <= nT; k++) {
    const x = -w / 2 + w * k / (nT + 1) + rng.range(-0.25, 0.25);
    if (field(x, eave - 0.3, d / 2 - 0.25) < 0 && field(x, eave - 0.3, -(d / 2 - 0.25)) < 0 && field(x, eave, 0) < 0.7) {
      const lay = charAt(x, eave, 0);
      mb.set(lay, lay === LY.wood_charred ? CHAR_T : WOOD_T);
      mb.beam([x, eave - 0.12, -d / 2 + 0.15], [x, eave - 0.12, d / 2 - 0.15], 0.17, 0.2, { uo: x });
    }
  }
}

// ---------------------------------------------------------------- floor
// F: { x0, x1, z0, z1, y, solid(x, z), wallOk(x, z), joist(x, z), burnt, rng, collide }
export function buildFloor(B, F) {
  const mb = B.mb, rng = F.rng, xs = lines([F.x0, F.x1], 0.5), zs = lines([F.z0, F.z1], 0.5);
  const nu = xs.length - 1, nv = zs.length - 1, nu1 = nu + 1, nvt = nu1 * (nv + 1);
  const st = new Uint8Array(nu * nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) st[j * nu + i] = F.solid((xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2) ? 0 : 2;
  const n = keepConnected(st, nu, nv, (i, j) => (i === 0 || j === 0 || i === nu - 1 || j === nv - 1) && F.wallOk((xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2));
  if (n) {
    const jit = jitterFlags(st, nu, nv), plain = plainCells(st, jit, nu, nv);
    const po = new Float32Array(nvt * 3), pi = new Float32Array(nvt * 3), pc = new Float32Array(nvt * 3), uv = new Float32Array(nvt * 2);
    for (let k = 0; k < nvt; k++) {
      const i = k % nu1, j = (k / nu1) | 0;
      let x = xs[i], z = zs[j], y = F.y;
      const onRim = i === 0 || j === 0 || i === nu || j === nv;
      if (jit[k] && !onRim) { x += rng.range(-0.17, 0.17); z += rng.range(-0.17, 0.17); y -= rng.range(0, 0.09); }
      po[k * 3] = x; po[k * 3 + 1] = y; po[k * 3 + 2] = z;
      pi[k * 3] = x; pi[k * 3 + 1] = y - 0.05; pi[k * 3 + 2] = z;
      pc[k * 3] = xs[i]; pc[k * 3 + 1] = F.y - 0.24; pc[k * 3 + 2] = zs[j];
      uv[k * 2] = zs[j] / 2; uv[k * 2 + 1] = xs[i] / 2;
    }
    const tint = F.burnt ? [0.62, 0.58, 0.55] : [0.95, 0.9, 0.84];
    const mE = { layer: LY.wood_planks, tint: [0.6, 0.56, 0.52], ao: 0.6 };
    const g = {
      nu, nv, po, pi, uv, st, plain, nO: [0, 1, 0], tEdge: 0.03,
      outer: { layer: LY.wood_planks, tint, ao: 0.62 }, inner: { layer: LY.wood_planks, tint: [0.55, 0.52, 0.48], ao: 0.42 },
      edge: () => mE, border: [0, 0, 0, 0], sootI: F.burnt ? 0.22 : 0,
    };
    emitSlab(mb, g);
    if (F.collide && B.cb) slabBoxes(B.cb, g, 1e9, pc);
  }
  const K = Math.max(2, Math.round((F.z1 - F.z0) / 1.1)), y = F.y - 0.05 - 0.085;
  for (let x = F.x0 + 0.4; x < F.x1 - 0.2; x += 0.85) {
    beamRuns(mb, K, (k) => F.joist(x, F.z0 + (F.z1 - F.z0) * (k + 0.5) / K), (k) => [x, y, F.z0 - 0.1 + (F.z1 - F.z0 + 0.2) * k / K], 0.09, 0.17,
      () => (F.burnt ? LY.wood_charred : LY.wood_beam));
  }
}

// ---------------------------------------------------------------- rubble & debris
export function domeCollider(cb, cx, cz, R, hAt, ground) {
  const segs = 6, ring = [0.5, 0.95], pts = [[cx, ground(cx, cz) + Math.max(0, hAt(cx, cz)), cz]];
  for (const rr of ring) for (let k = 0; k < segs; k++) {
    const a = k / segs * Math.PI * 2, x = cx + Math.cos(a) * R * rr, z = cz + Math.sin(a) * R * rr;
    pts.push([x, ground(x, z) + (rr > 0.9 ? -0.25 : Math.max(0, hAt(x, z)) * 0.9), z]);
  }
  for (let k = 0; k < segs; k++) {
    const k2 = (k + 1) % segs;
    cb.quad(pts[0], pts[1 + k2], pts[1 + k], pts[1 + k]);
    cb.quad(pts[1 + k], pts[1 + k2], pts[1 + segs + k2], pts[1 + segs + k]);
  }
}

export function houseRubble(B, b, cfg, field, W, rng, H, hasRoof) {
  const mb = B.mb, d = b.damage, T = B.ground, w = b.w, dd = b.d;
  mb.xf();
  const heap = (lx, lz, rx, rz, h, rot = 0) => {
    const p = W(lx, lz);
    const hAt = mb.mound(p[0], p[1], rx, rz, b.rot + rot, h, T, B.noise, { seed: rng.range(0, 60), segs: rx > 2.2 ? 14 : 10, rings: rx > 2.2 ? 4 : 3, tint: RUB_T });
    const n = Math.round(rx * rz * 1.6);
    for (let k = 0; k < n; k++) {
      const a = rng.range(0, 6.283), r = Math.sqrt(rng.f()) * 0.9, x = p[0] + Math.cos(a) * r * rx, z = p[1] + Math.sin(a) * r * rz;
      const hh = hAt(x, z);
      if (hh < 0.03) continue;
      if (rng.chance(hasRoof ? 0.4 : 0.15)) B.tile(x, T(x, z) + hh + 0.03, z, rng); else B.stone(x, T(x, z) + hh, z, rng.range(0.09, 0.3) * (1 + 0.5 * h), rng);
    }
    if (h > 0.75 && B.cb) { B.cb.xf(); domeCollider(B.cb, p[0], p[1], Math.min(rx, rz) * 0.85, hAt, T); B.cb.xf(b.x, b.baseY, b.z, b.rot); }
  };
  const col = cfg.collapse;
  if (col && d > 0.35) {
    const rx = clamp(col.sigma * 1.0, 2.2, 5);
    heap(clamp(col.x, -w / 2 + 0.6, w / 2 - 0.6), clamp(col.z, -dd / 2 + 0.6, dd / 2 - 0.6), rx, rx * rng.range(0.65, 0.9), 0.3 + 1.1 * saturate((d - 0.3) / 0.6), rng.range(0, 3));
  }
  // heaps at the foot of broken stretches of wall
  const per = 2 * (w + dd), step = 2.3;
  for (let s = rng.range(0, step); s < per; s += step) {
    let x, z, nx, nz;
    if (s < w) { x = -w / 2 + s; z = dd / 2; nx = 0; nz = 1; } else if (s < w + dd) { x = w / 2; z = dd / 2 - (s - w); nx = 1; nz = 0; } else if (s < 2 * w + dd) { x = w / 2 - (s - w - dd); z = -dd / 2; nx = 0; nz = -1; } else { x = -w / 2; z = -dd / 2 + (s - 2 * w - dd); nx = -1; nz = 0; }
    const hbv = field.hb(x - nx * 0.3, z - nz * 0.3), low = hbv < H * 0.62 || field(x - nx * 0.3, 1.6, z - nz * 0.3) > 0;
    if (!low) continue;
    const sev = saturate(1 - hbv / H) * 0.6 + 0.35;
    if (rng.chance(0.7)) heap(x + nx * rng.range(0.5, 1.1), z + nz * rng.range(0.5, 1.1), rng.range(1.5, 2.6), rng.range(1.0, 1.6), sev * rng.range(0.32, 0.58), Math.atan2(nx, nz) + 1.57);
    if (rng.chance(0.45)) heap(x - nx * rng.range(0.9, 1.5), z - nz * rng.range(0.9, 1.5), rng.range(1.3, 2.2), rng.range(1.0, 1.5), sev * rng.range(0.28, 0.5), rng.range(0, 3));
  }
  // loose stones, tiles and timbers around the building
  const around = (spread) => {
    const s = rng.range(0, per), o = rng.gauss() * spread;
    let x, z;
    if (s < w) { x = -w / 2 + s; z = dd / 2 + o; } else if (s < w + dd) { x = w / 2 + o; z = dd / 2 - (s - w); } else if (s < 2 * w + dd) { x = w / 2 - (s - w - dd); z = -dd / 2 - o; } else { x = -w / 2 - o; z = -dd / 2 + (s - 2 * w - dd); }
    return W(x, z);
  };
  const nS = Math.round((12 + 55 * d) * (cfg.debris || 1));
  for (let k = 0; k < nS; k++) { const p = around(1.5); B.stone(p[0], T(p[0], p[1]), p[1], 0.07 + 0.22 * Math.pow(rng.f(), 2.2), rng); }
  const nT = hasRoof || d < 0.9 ? Math.round((8 + 34 * d) * (cfg.debris || 1)) : 6;
  for (let k = 0; k < nT; k++) { const p = around(1.2); B.tile(p[0], T(p[0], p[1]) + 0.03, p[1], rng); }
  const nB = Math.round(1 + 4 * d);
  for (let k = 0; k < nB; k++) {
    const p = around(1.6), a = rng.range(0, 6.283), len = rng.range(0.6, 1.6), y = T(p[0], p[1]) + 0.07, lay = cfg.burnt && rng.chance(0.7) ? LY.wood_charred : LY.wood_beam;
    mb.set(lay, lay === LY.wood_charred ? CHAR_T : WOOD_T);
    mb.beam([p[0] - Math.cos(a) * len, y + rng.range(0, 0.1), p[1] - Math.sin(a) * len], [p[0] + Math.cos(a) * len, y + rng.range(0, 0.45), p[1] + Math.sin(a) * len], 0.13, 0.12, { uo: k * 0.7 });
  }
  mb.xf(b.x, b.baseY, b.z, b.rot);
}

// walkable rubble ramp (local space) up to a floor
function buildRamp(B, r, W, rng) {
  const mb = B.mb, n = 12, m = 4, T = B.ground;
  const P = (i, j) => {
    const k = i / n, x = r.xb + (r.xt - r.xb) * k, z = r.z0 + (r.z1 - r.z0) * j / m;
    return [x, r.h * k - (i === 0 ? 0.12 : 0) + 0.1 * B.noise.n2(x * 1.1, z * 1.1) * Math.sin(k * Math.PI), z];
  };
  mb.set(LY.rubble, RUB_T);
  const uvOf = (p) => [p[0] / 4, p[2] / 4];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      mb.quad(a, b, c, d, [0, 1, 0], uvOf(a), uvOf(b), uvOf(c), uvOf(d), 0.85, 0, 0, true);
    }
    // talus on the open side
    const a = P(i, 0), b = P(i + 1, 0), sgn = Math.sign(r.z0 - r.z1);
    const tb = (p) => p[2] + sgn * (0.35 + p[1] * 0.95 + 0.3 * B.noise.n2(p[0] * 0.9, 7.7));
    const a2 = [a[0], -0.15, tb(a)], b2 = [b[0], -0.15, tb(b)];
    mb.quad(a, b, b2, a2, [0, 0.5, sgn], uvOf(a), uvOf(b), [b2[0] / 4, b2[2] / 4 + sgn * b[1] / 4], [a2[0] / 4, a2[2] / 4 + sgn * a[1] / 4], 0.75, 0, 0, true);
    for (let q = 0; q < 3; q++) {
      const fx = rng.f(), fz = rng.f(), x = a[0] + (b[0] - a[0]) * fx, z = r.z0 + (r.z1 - r.z0) * fz, y = a[1] + (b[1] - a[1]) * fx;
      const p = W(x, z);
      B.stone(p[0], B.baseY + y, p[1], rng.range(0.07, 0.2), rng);
    }
  }
  for (let q = 0; q < 10; q++) {
    const k = rng.range(0.1, 0.95), x = r.xb + (r.xt - r.xb) * k, y = r.h * k, sgn = Math.sign(r.z0 - r.z1), f = rng.range(0.15, 0.9);
    const z = r.z0 + sgn * (0.2 + y * 0.95) * f, sx = rng.range(0.18, 0.4), a = rng.range(0, 3.14);
    mb.set(rng.chance(0.5) ? LY.stone_masonry : LY.stone_blocks, MAS_T);
    mb.obox([x, y * (1 - f) + 0.05, z], [Math.cos(a) * sx, 0.1, Math.sin(a) * sx], [0, rng.range(0.1, 0.2), 0.03], [-Math.sin(a) * sx * 0.6, 0, Math.cos(a) * sx * 0.6], { tile: 4, uo: q * 0.3 });
  }
  const e0 = P(n, 0), e1 = P(n, m);
  mb.quad(e0, e1, [e1[0], -0.1, e1[2]], [e0[0], -0.1, e0[2]], [Math.sign(r.xt - r.xb), 0, 0], [0, 0], [0.5, 0], [0.5, 0.7], [0, 0.7], 0.6, 0, 0, true);
  if (B.cb) {
    const sl = r.h / (r.xb - r.xt), xs = r.xb + (r.xb > r.xt ? 0.5 : -0.5);
    B.cb.quad([xs, -sl * Math.abs(xs - r.xb), r.z0], [r.xt, r.h, r.z0], [r.xt, r.h, r.z1], [xs, -sl * Math.abs(xs - r.xb), r.z1]);
    const xe = r.xt + (r.xt < r.xb ? -0.45 : 0.45);
    B.cb.quad([r.xt, r.h, r.z0], [xe, r.h, r.z0], [xe, r.h, r.z1], [r.xt, r.h, r.z1]);
  }
  void T;
}

// ---------------------------------------------------------------- house
export function buildHouse(B, b, cfg = {}) {
  const rng = new RNG(b.seed), d = b.damage, w = b.w, dd = b.d, t = 0.55, floors = b.floors, fH = b.floorH || 2.75;
  const H = floors * fH + 0.35, pitch = cfg.pitch || 0.4 + rng.range(-0.04, 0.05), tanp = Math.tan(pitch);
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const W = (lx, lz) => [b.x + lx * c - lz * s, b.z + lx * s + lz * c];
  const mb = B.mb;
  mb.xf(b.x, b.baseY, b.z, b.rot);
  if (B.cb) B.cb.xf(b.x, b.baseY, b.z, b.rot);
  B.baseY = b.baseY;
  const burnt = cfg.burnt === undefined ? rng.chance(0.25 + 0.4 * d) : cfg.burnt;
  // --- damage
  let collapse = cfg.collapse;
  if (collapse === undefined) {
    const a = rng.range(0, 6.283), e = rng.range(0.6, 1.1);
    collapse = { x: Math.cos(a) * w / 2 * e, z: Math.sin(a) * dd / 2 * e, depth: Math.max(0, d - 0.3) * 2.2, sigma: (0.2 + 0.45 * d) * w };
  }
  let blasts = cfg.blasts;
  if (!blasts) {
    blasts = [];
    const nb = Math.round(1 + d * 5 + rng.range(0, 2));
    for (let k = 0; k < nb; k++) {
      const sd = rng.int(0, 3), u = rng.range(-0.5, 0.5);
      const x = sd < 2 ? u * w : (sd === 2 ? w / 2 : -w / 2), z = sd < 2 ? (sd === 0 ? dd / 2 : -dd / 2) : u * dd;
      blasts.push({ x, y: rng.range(0.8, H + 1.2), z, r: 0.8 + rng.range(0, 1.5) * (0.5 + d) });
    }
  }
  const field = makeField({ noise: B.noise, H, seed: b.seed, blasts, collapse, keep: cfg.keep, hbFn: cfg.hbFn, rag: 0.3 + d });
  const sx = (b.seed % 613) * 0.71, rb = (d - 0.72) * 2.2 + (cfg.roofBias || 0);
  const roofF = (x, y, z) => Math.max(field(x, y - 0.8, z) + 0.35, 1.6 * B.noise.fbm2(x * 0.22 + sx, z * 0.22, 3) + rb);
  const cfgCopy = { ...cfg, collapse, burnt };

  let tm = mb.tris;
  const mark = (k) => { B.stat[k] = (B.stat[k] || 0) + mb.tris - tm; tm = mb.tris; };
  // --- walls
  const tO = PLASTER[rng.int(0, PLASTER.length - 1)].map((v) => v * rng.range(0.94, 1.04));
  const tI = [tO[0] * 0.9, tO[1] * 0.9, tO[2] * 0.9];
  // which wall faces the nearest street -> door
  let best = 1e9, dxs = 0, dzs = 1;
  const q = {};
  for (const p of [...B.layout.streets, ...B.layout.roads.map((r) => r.path)]) { p.query(b.x, b.z, q); if (q.d < best) { best = q.d; dxs = q.px - b.x; dzs = q.pz - b.z; } }
  const lx = dxs * c + dzs * s, lz = -dxs * s + dzs * c;
  const doorWall = Math.abs(lz) / dd >= Math.abs(lx) / w ? (lz > 0 ? 0 : 1) : (lx > 0 ? 2 : 3);
  const mkOps = (L, gable, wi) => {
    if (cfg.openings && cfg.openings[wi]) return cfg.openings[wi];
    const ops = [], n = gable ? (L > 5.6 && rng.chance(0.7) ? 2 : 1) : Math.max(1, Math.floor((L - 1.0) / 2.5));
    const cols = [];
    for (let k = 0; k < n; k++) cols.push({ uc: L * (k + 0.5) / n + rng.range(-0.25, 0.25), wd: rng.range(0.82, 1.0) });
    const dc = wi === doorWall ? rng.int(0, n - 1) : -1;
    if (dc >= 0) cols[dc].wd = 1.04;
    for (let k = 0; k < n; k++) for (let f = 0; f < floors; f++) {
      const cc = cols[k], fy = f * fH;
      if (f === 0 && k === dc) { ops.push({ u0: cc.uc - 0.52, u1: cc.uc + 0.52, v0: 0, v1: 2.1, door: true, soot: burnt && rng.chance(0.4) }); continue; }
      if (!rng.chance(gable ? 0.62 : 0.9)) continue;
      const hh = f === 2 ? 1.0 : 1.3;
      ops.push({ u0: cc.uc - cc.wd / 2, u1: cc.uc + cc.wd / 2, v0: fy + 0.95, v1: fy + 0.95 + hh, frame: rng.chance(0.4) ? rng.int(1, 2) : 0, shutter: rng.chance(0.3) ? rng.int(1, 15) : 0, soot: burnt && rng.chance(0.55) });
    }
    return ops;
  };
  const yRoof = (z) => H + (dd / 2 - Math.abs(z)) * tanp;
  const frames = [
    mkFrame(-w / 2, dd / 2, w / 2, dd / 2, 0, 1, t), mkFrame(w / 2, -dd / 2, -w / 2, -dd / 2, 0, -1, t),
    mkFrame(w / 2, dd / 2 - t, w / 2, -dd / 2 + t, 1, 0, t), mkFrame(-w / 2, -dd / 2 + t, -w / 2, dd / 2 - t, -1, 0, t),
  ];
  const base = { y0: -1.2, eave: H, field, bare: cfg.bare || 0, tO, tI, sootI: burnt ? 0.45 : 0, rng };
  for (let wi = 0; wi < 4; wi++) {
    const fr = frames[wi], gable = wi >= 2;
    buildWall(B, fr, {
      ...base, openings: mkOps(fr.L, gable, wi), uvo: rng.range(0, 40), ends: gable ? [2, 2] : [6, 6],
      top: gable ? (u) => yRoof(fr.oz + fr.uz * u) : null,
    });
  }
  // interior partition
  if (w > 8.6 && d < 0.78 && !cfg.noPartition) {
    const px = rng.range(-0.18, 0.18) * w, fr = mkFrame(px, -dd / 2 + t, px, dd / 2 - t, 1, 0, 0.28), ops = [];
    for (let f = 0; f < floors; f++) { const u = rng.range(1.2, fr.L - 1.2); ops.push({ u0: u - 0.5, u1: u + 0.5, v0: f * fH, v1: f * fH + 2.05, door: true }); }
    buildWall(B, fr, { ...base, y0: -0.3, openings: ops, uvo: rng.range(0, 40), tO: tI, tI, aoO: 0.5, ends: [0, 0], top: (u) => yRoof(fr.oz + fr.uz * u) - 0.1, noLintel: true, cell: 0.45 });
  }
  mark('walls');
  // --- floors
  if (!cfg.noFloors) {
    const x0 = -w / 2 + t, x1 = w / 2 - t, z0 = -dd / 2 + t, z1 = dd / 2 - t;
    const wallOk = (y) => (x, z) => {
      const ex = Math.min(x - x0, x1 - x) < 0.6, ez = Math.min(z - z0, z1 - z) < 0.6;
      const wx = ex ? (x - x0 < x1 - x ? -w / 2 + 0.27 : w / 2 - 0.27) : x, wz = ez && !ex ? (z - z0 < z1 - z ? -dd / 2 + 0.27 : dd / 2 - 0.27) : z;
      return field(wx, y - 0.2, wz) < 0;
    };
    for (let k = 1; k <= floors; k++) {
      const y = k * fH, attic = k === floors;
      if (attic && (cfg.floorFn ? false : !(d < 0.55 && rng.chance(0.6)))) continue;
      const fo = (d - 0.6) * 1.6 + (attic ? 0.3 : 0);
      const solid = cfg.floorFn ? (x, z) => cfg.floorFn(k, x, z, field) : (x, z) => Math.max(field(x, y + 0.3, z) + 0.3, 1.3 * B.noise.fbm2(x * 0.3 + sx + k * 3.1, z * 0.3, 3) + fo) < 0;
      buildFloor(B, { x0, x1, z0, z1, y, solid, wallOk: wallOk(y), joist: (x, z) => solid(x, z) || field(x, y, z) < (cfg.floorFn ? 0.5 : -0.1), burnt, rng, collide: !!b.enterable });
    }
  }
  mark('floors');
  // --- roof
  const hasRoof = !cfg.noRoof && d < 0.86;
  if (hasRoof) {
    const rt = rng.range(0.86, 1.08);
    buildRoof(B, { w, d: dd, eave: H, pitch, field, roofF, rng, burnt, uvo: rng.range(0, 40), chimTint: tO,
      chimney: rng.chance(0.75) ? [rng.range(-0.3, 0.3) * w, (rng.chance(0.5) ? 1 : -1) * dd * rng.range(0.12, 0.3)] : null, tint: [rt * rng.range(0.96, 1.06), rt, rt * rng.range(0.94, 1.02)] });
  }
  mark('roof');
  if (cfg.ramp) buildRamp(B, cfg.ramp, W, rng);
  if (cfg.extra) cfg.extra(B, b, field, W, rng);
  houseRubble(B, b, cfgCopy, field, W, rng, H, hasRoof);
  mark('rubble');
  return { field, H };
}
