// House dressing: everything that makes a carved wall read as a built house. Window and door
// surrounds (sill, lintel or relieving arch, frames with mullions, glass, shutters in four
// states, plank doors, steps), wall build-up (plinth, quoins, cornice, string course, plaster
// fallen away with a real edge, cracks, broken plaster around shell holes), things fixed to the
// walls (balconies, lamps, sign brackets, plates, benches, firewood) and a dark room box behind
// the windows of the closed houses. Emitted in detail mode (mb.det = 1): the triangles go through
// the building's gravity pass and are then moved to the no-shadow detail mesh (see buildings.js).
// No colliders, except a shut door and the firewood stacks.
import { RNG } from '../../core/noise.js';
import { LY } from './mb.js';
import { wbox, FP } from './house.js';

const STONE = [1.14, 1.11, 1.04], STONE2 = [1.0, 0.97, 0.92], MAS = [1.0, 0.97, 0.92], IRON = [0.42, 0.4, 0.38], CHAR = [0.8, 0.8, 0.8];
const GLASS = [0.55, 0.66, 0.78], ZINC = [1.3, 1.3, 1.36], CRACK = [0.42, 0.4, 0.38];
const SHUT = [[0.62, 0.95, 0.72], [0.66, 0.82, 1.05], [1.0, 0.8, 0.6], [0.8, 0.9, 0.76], [0.98, 0.62, 0.52], [0.86, 0.78, 0.68], [0.72, 0.62, 0.52]];
const FRAME = [[1.28, 1.24, 1.16], [0.9, 0.74, 0.58], [1.25, 1.22, 1.15], [0.72, 0.9, 0.8]];
const BALC = [0.86, 0.7, 0.52];

export function houseStyle(b, burnt, tO, extra = {}) {
  const r = new RNG((b.seed * 7 + 13) >>> 0);
  return {
    rng: r, burnt, d: b.damage, enterable: !!b.enterable, tO,
    plinth: r.chance(0.88) ? (r.chance(0.6) ? 1 : 2) : 0, plinthH: r.range(0.42, 0.72),
    quoins: r.chance(0.45), cornice: r.chance(0.85) ? (r.chance(0.5) ? 1 : 2) : 0, string: r.chance(0.4),
    arch: r.chance(0.35), stoneDoor: r.chance(0.6), shut: r.chance(0.72), shutC: SHUT[r.int(0, SHUT.length - 1)],
    frameT: FRAME[r.int(0, FRAME.length - 1)], rd: r.range(0.15, 0.24), interior: !b.enterable && b.damage < 0.62,
    lamp: r.chance(0.4), sign: !b.enterable && r.chance(0.22), bench: r.chance(0.3), wood: r.chance(0.35), number: r.chance(0.7),
    ...extra,
  };
}

const quadW = (mb, fr, a, b, c, d, n) => {
  const P = (p) => FP(fr, p[0], p[1], p[2]);
  mb.quad(P(a), P(b), P(c), P(d), n, [a[0] / 4, -a[1] / 4], [b[0] / 4, -b[1] / 4], [c[0] / 4, -c[1] / 4], [d[0] / 4, -d[1] / 4], 1, 0, 0, true);
};
const nOut = (fr) => [fr.nx, 0, fr.nz];

// ragged ring of plaster edge (step, top, bevel) around a centre; hole = only where the wall stands
function plasterEdge(mb, fr, uc, vc, rx, ry, S, solidAt, sp, hole) {
  const R = S.rng, n = hole ? 16 : 11, pts = [], nO = nOut(fr), uvo = sp.uvo || 0, kp = (S.nPl = ((S.nPl || 0) + 1) % 4), dz = -0.004 * kp, dp = -0.006 + dz;
  for (let k = 0; k < n; k++) {
    const a = k / n * Math.PI * 2, f = 0.72 + 0.5 * R.f();
    pts.push([uc + Math.cos(a) * rx * f, vc + Math.sin(a) * ry * f]);
  }
  const ok = pts.map((p) => solidAt(p[0], p[1]) && (!hole || solidAt(uc + (p[0] - uc) * 1.35, vc + (p[1] - vc) * 1.35)));
  const out = (p, k, s) => [p[0] + (p[0] - uc) * k + Math.sign(p[0] - uc) * s, p[1] + (p[1] - vc) * k + Math.sign(p[1] - vc) * s];
  const W = (p, dep) => FP(fr, p[0], p[1], dep), UV = (p) => [(uvo + p[0]) / 4, -p[1] / 4];
  if (!hole) {
    if (ok.some((o) => !o) || !solidAt(uc, vc)) return false;
    mb.set(LY.stone_masonry, MAS);
    for (let k = 0; k < n; k++) { const p = pts[k], q = pts[(k + 1) % n]; mb.tri(W([uc, vc], dp), W(p, dp), W(q, dp), nO, UV([uc, vc]), UV(p), UV(q), 0.85); }
  }
  mb.set(0, S.tO);
  const dIn = hole ? 0.0 : dp, dF = -0.03 + dz;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    if (!ok[k] || !ok[k2]) continue;
    const p = pts[k], q = pts[k2], p1 = out(p, 0.06, 0.02), q1 = out(q, 0.06, 0.02), p2 = out(p, 0.22, 0.06), q2 = out(q, 0.22, 0.06);
    const toC = [uc - (p[0] + q[0]) / 2, vc - (p[1] + q[1]) / 2], l = Math.hypot(toC[0], toC[1]) || 1;
    const ni = [(fr.ux * toC[0]) / l, toC[1] / l, (fr.uz * toC[0]) / l];
    mb.quad(W(p, dIn), W(q, dIn), W(q, dF), W(p, dF), ni, UV(p), UV(q), UV(q), UV(p), 0.8, 0, 0, true);
    mb.quad(W(p, dF), W(q, dF), W(q1, dF), W(p1, dF), nO, UV(p), UV(q), UV(q1), UV(p1), 1, 0, 0, true);
    mb.quad(W(p1, dF), W(q1, dF), W(q2, 0.004), W(p2, 0.004), nO, UV(p1), UV(q1), UV(q2), UV(p2), 1, 0, 0, true);
  }
  return true;
}

function crack(mb, fr, u, v, du, dv, S, solidAt) {
  const R = S.rng, nO = nOut(fr);
  mb.set(LY.wood_charred, CRACK);
  let w = 0.02;
  const dc = -0.011 - 0.004 * (S.nCr = ((S.nCr || 0) + 1) % 3);   // in front of plaster patches, cracks apart from each other
  for (let s = 0; s < 4; s++) {
    const a = Math.atan2(dv, du) + R.range(-0.5, 0.5), len = R.range(0.14, 0.32), u2 = u + Math.cos(a) * len, v2 = v + Math.sin(a) * len;
    if (!solidAt(u2, v2)) break;
    const px = -Math.sin(a), py = Math.cos(a), w2 = w * 0.7;
    quadW(mb, fr, [u + px * w / 2, v + py * w / 2, dc], [u2 + px * w2 / 2, v2 + py * w2 / 2, dc], [u2 - px * w2 / 2, v2 - py * w2 / 2, dc], [u - px * w / 2, v - py * w / 2, dc], nO);
    u = u2; v = v2; w = w2;
  }
}

function leaf(mb, fr, u0, u1, v0, v1, d0, d1, tint, rot, R, rails = true) {
  mb.set(LY.wood_planks, tint);
  wbox(mb, fr, u0, u1, v0, v1, d0, d1, { rot, tile: 2, uo: R.f(), skip: 8 });
  if (!rails) return;
  mb.set(LY.wood_planks, [tint[0] * 0.85, tint[1] * 0.85, tint[2] * 0.85]);
  const h = v1 - v0, vc = (v0 + v1) / 2, uc = (u0 + u1) / 2, ca = Math.cos(rot), sa = Math.sin(rot);
  for (const f of [-0.36, 0.36]) {
    const du = -sa * f * h, dv = ca * f * h;
    wbox(mb, fr, u0 + 0.02 + du, u1 - 0.02 + du, vc + dv - 0.045, vc + dv + 0.045, d0 - 0.02, d0, { rot, tile: 2, skip: 8 });
  }
  void uc;
}

// local ground height under a wall-space point
const gAt = (S, fr, u, dep) => { const p = FP(fr, u, 0, dep); return S.gl(p[0], p[2]); };

// ---------------------------------------------------------------- one opening
export function dressOpening(B, fr, o, S, solidAt, sp) {
  const mb = B.mb, R = S.rng, t = fr.t, uc = (o.u0 + o.u1) / 2, vc = (o.v0 + o.v1) / 2, wd = o.u1 - o.u0, ht = o.v1 - o.v0, nO = nOut(fr);
  const door = o.door && o.v0 < 0.3, win = !o.door;
  const okTop = solidAt(uc, o.v1 + 0.15) && solidAt(o.u0 - 0.15, o.v1 - 0.25) && solidAt(o.u1 + 0.15, o.v1 - 0.25);
  const okBot = door || o.balc || (solidAt(uc, o.v0 - 0.15) && solidAt(o.u0 - 0.15, o.v0 + 0.25) && solidAt(o.u1 + 0.15, o.v0 + 0.25));
  const okL = solidAt(o.u0 - 0.25, vc), okR = solidAt(o.u1 + 0.25, vc);
  const burnt = S.burnt || o.soot, rd = o.big ? 0.1 : S.rd;
  mb.det = 1;
  // ---- head: stone lintel or shallow relieving arch
  if (okTop && !sp.noLintel) {
    if (win && S.arch && !o.big) {
      const c = wd + 0.3, h = 0.13, Rr = (c * c / 4 + h * h) / (2 * h), cy = o.v1 + 0.02 + h - Rr, n = 7, ph = Math.asin(c / 2 / Rr);
      mb.set(LY.stone_blocks, STONE);
      for (let k = 0; k < n; k++) {
        const a = -ph + 2 * ph * (k + 0.5) / n, rr = Rr + 0.11, bu = uc + Math.sin(a) * rr, bv = cy + Math.cos(a) * rr, hw = Rr * ph / n - 0.008;
        wbox(mb, fr, bu - hw, bu + hw, bv - 0.11, bv + 0.11, -0.025, 0.1, { rot: -a, tile: 2, uo: k * 0.31, skip: 8 });
      }
    } else if (door && !S.stoneDoor) {
      mb.set(burnt ? LY.wood_charred : LY.wood_beam, burnt ? CHAR : [1.1, 1.02, 0.92]);
      wbox(mb, fr, o.u0 - 0.28, o.u1 + 0.28, o.v1, o.v1 + 0.2, -0.04, 0.2, { tile: 2, skip: 8 });
    } else {
      mb.set(LY.stone_blocks, STONE);
      const e = door ? 0.24 : 0.16;
      wbox(mb, fr, o.u0 - e, o.u1 + e, o.v1 - 0.01, o.v1 + (door ? 0.27 : 0.2), -0.03, 0.12, { tile: 4, uo: uc * 0.3, skip: 8 });
    }
  }
  if (win && okTop && okBot) {
    // ---- sill
    if (!o.balc) { mb.set(LY.stone_blocks, STONE); wbox(mb, fr, o.u0 - 0.09, o.u1 + 0.09, o.v0 - 0.075, o.v0 + 0.014, -0.085, rd, { tile: 4, uo: uc * 0.7, skip: 8 }); }
    // ---- frame with mullion and transom, glass
    const fw = o.big ? 0.11 : 0.065, d0 = rd, d1 = rd + 0.07, vt = o.balc ? o.v0 + ht * 0.72 : o.v0 + ht * 0.66;
    mb.set(burnt ? LY.wood_charred : LY.wood_beam, burnt ? CHAR : S.frameT);
    const sk = 8 | 16 | 32;
    wbox(mb, fr, o.u0, o.u0 + fw, o.v0, o.v1, d0, d1, { vert: true, skip: sk });
    wbox(mb, fr, o.u1 - fw, o.u1, o.v0, o.v1, d0, d1, { vert: true, skip: sk });
    wbox(mb, fr, o.u0 + fw, o.u1 - fw, o.v1 - fw, o.v1, d0, d1, { skip: sk });
    wbox(mb, fr, o.u0 + fw, o.u1 - fw, o.v0, o.v0 + fw, d0, d1, { skip: sk });
    const g = R.f(), state = burnt ? (g < 0.6 ? 2 : 1) : g < 0.38 ? 0 : g < 0.78 ? 1 : 2;   // 0 intact, 1 shards, 2 empty
    const sash = !(state === 2 && R.chance(0.5));
    if (sash) {
      wbox(mb, fr, uc - fw / 2, uc + fw / 2, o.v0 + fw, o.v1 - fw, d0 + 0.01, d1 - 0.005, { vert: true, skip: sk });
      wbox(mb, fr, o.u0 + fw, o.u1 - fw, vt - fw / 2, vt + fw / 2, d0 + 0.005, d1 - 0.01, { skip: sk });
    }
    const ga = o.u0 + fw, gb = o.u1 - fw, gv0 = o.v0 + fw, gv1 = o.v1 - fw, gd = rd + 0.035;
    if (state === 0) {
      mb.set(LY.slate_dark, GLASS.map((v) => v * R.range(0.9, 1.15)));
      quadW(mb, fr, [ga, gv0, gd], [gb, gv0, gd], [gb, gv1, gd], [ga, gv1, gd], nO);
    } else if (state === 1) {
      mb.set(LY.slate_dark, GLASS);
      const panes = [[ga, uc, gv0, vt], [uc, gb, gv0, vt], [ga, uc, vt, gv1], [uc, gb, vt, gv1]];
      for (const p of panes) {
        if (R.chance(0.35)) continue;
        const cu = R.chance(0.5) ? 0 : 1, cv = R.chance(0.5) ? 0 : 1, u = p[cu], v = p[2 + cv], su = cu ? -1 : 1, sv = cv ? -1 : 1;
        const lu = (p[1] - p[0]) * R.range(0.3, 0.9), lv = (p[3] - p[2]) * R.range(0.3, 0.9);
        const P = (a, b2) => FP(fr, a, b2, gd);
        mb.tri(P(u, v), P(u + su * lu, v), P(u + su * lu * R.range(0, 0.3), v + sv * lv), nO, [0, 0], [0.1, 0], [0, 0.1]);
      }
    }
    // ---- shutters: closed, open, hanging from one hinge, gone with the pins left
    if ((o.shutter || S.shut) && !o.big && ht > 0.7) {
      const tint = burnt ? CHAR : S.shutC.map((v) => v * R.range(0.88, 1.06)), sw = wd / 2, r = R.f();
      const st = burnt ? (r < 0.5 ? 3 : 2) : r < 0.15 ? 0 : r < 0.62 ? 1 : r < 0.8 ? 2 : 3;
      if (st === 0) {
        leaf(mb, fr, o.u0 + 0.01, uc - 0.005, o.v0 + 0.01, o.v1 - 0.01, 0.02, 0.05, tint, 0, R);
        leaf(mb, fr, uc + 0.005, o.u1 - 0.01, o.v0 + 0.01, o.v1 - 0.01, 0.02, 0.05, tint, 0, R);
        o.closed = true;
      } else if (st === 3) {
        mb.set(LY.wood_charred, IRON);
        for (const u of [o.u0 - 0.06, o.u1 + 0.02]) for (const v of [o.v0 + 0.22, o.v1 - 0.22]) if (solidAt(u, v)) wbox(mb, fr, u, u + 0.04, v - 0.025, v + 0.025, -0.06, 0.02, { skip: 8 });
      } else {
        const hang = st === 2 ? (R.chance(0.5) ? 0 : 1) : -1;
        for (const side of [0, 1]) {
          const ua = side ? o.u1 + 0.02 : o.u0 - sw - 0.02, ub = side ? o.u1 + sw + 0.02 : o.u0 - 0.02;
          if (!solidAt(side ? o.u1 + sw * 0.6 : o.u0 - sw * 0.6, vc)) continue;
          if (side === hang) {
            // hangs from its upper hinge only: swung down and out of line
            const a = (side ? 1 : -1) * R.range(0.35, 0.7), hu = side ? o.u1 + 0.02 : o.u0 - 0.02, hv = o.v1 - 0.12;
            const cu0 = (side ? sw / 2 : -sw / 2), cv0 = -(ht / 2 - 0.12), ca = Math.cos(a), sa = Math.sin(a);
            const cu = hu + cu0 * ca - cv0 * sa, cv = hv + cu0 * sa + cv0 * ca;
            if (cv - ht / 2 > 0.1) leaf(mb, fr, cu - sw / 2, cu + sw / 2, cv - ht / 2 + 0.03, cv + ht / 2 - 0.03, -0.05, -0.012, tint, a, R);
          } else leaf(mb, fr, ua, ub, o.v0 - 0.02, o.v1 - 0.02, side ? -0.05 : -0.056, side ? -0.012 : -0.017, tint, side ? R.range(-0.02, 0.05) : R.range(-0.05, 0.02), R);
        }
      }
    }
    // ---- flower box on an upper sill
    if (!o.balc && !o.closed && o.v0 > 2 && R.chance(0.2)) {
      mb.set(LY.wood_planks, burnt ? CHAR : [0.85, 0.72, 0.58]);
      wbox(mb, fr, o.u0 + 0.03, o.u1 - 0.03, o.v0 + 0.014, o.v0 + 0.2, -0.24, -0.04, { tile: 2, uo: R.f(), skip: 8 });
    }
    // ---- dark room behind the window (closed houses only)
    if (S.interior && !o.closed && sp.dw && sp.dw.D > 0.8 && o.v0 < Math.min(S.H - 0.5, 1.6 * S.fH)) interiorBox(mb, fr, o, S, sp.dw.D + R.range(-0.12, 0.12), R);
  }
  // ---- doors
  if (door && !o.arch) {
    if (S.stoneDoor) {
      mb.set(LY.stone_blocks, STONE2);
      if (okL || solidAt(o.u0 - 0.25, 1.0)) wbox(mb, fr, o.u0 - 0.2, o.u0 - 0.004, -0.35, o.v1 - 0.012, -0.024, 0.12, { vert: true, tile: 4, uo: 0.3, skip: 8 });
      if (okR || solidAt(o.u1 + 0.25, 1.0)) wbox(mb, fr, o.u1 + 0.004, o.u1 + 0.2, -0.35, o.v1 - 0.012, -0.024, 0.12, { vert: true, tile: 4, uo: 0.7, skip: 8 });
    } else {
      mb.set(burnt ? LY.wood_charred : LY.wood_beam, burnt ? CHAR : [1.1, 1.02, 0.92]);
      if (okL) wbox(mb, fr, o.u0 - 0.13, o.u0 - 0.004, -0.1, o.v1, -0.04, 0.16, { vert: true, skip: 8 });
      if (okR) wbox(mb, fr, o.u1 + 0.004, o.u1 + 0.13, -0.1, o.v1, -0.04, 0.16, { vert: true, skip: 8 });
    }
    // step: top flush with the threshold, a second one when the street falls away
    const gMin = (d) => Math.min(gAt(S, fr, uc, d), gAt(S, fr, o.u0 - 0.14, d), gAt(S, fr, o.u1 + 0.14, d));
    const g0 = Math.min(gMin(-0.3), gMin(-0.42));
    if (g0 < -0.05) {
      mb.set(LY.stone_blocks, STONE2);
      // the block reaches into the ground under every corner (it hung in the air on steep streets)
      const colBox = (u0, u1, y0, y1, d0, d1) => { if (!B.cb) return; const a = FP(fr, u0, 0, d0), b = FP(fr, u1, 0, d1); B.cb.box(Math.min(a[0], b[0]), y0, Math.min(a[2], b[2]), Math.max(a[0], b[0]), y1, Math.max(a[2], b[2])); };
      wbox(mb, fr, o.u0 - 0.14, o.u1 + 0.14, Math.max(g0 - 0.25, -1.6), 0.0, -0.42, 0.06, { tile: 4, uo: uc, skip: 8 });
      colBox(o.u0 - 0.14, o.u1 + 0.14, Math.max(g0 - 0.25, -1.6), 0.0, -0.42, 0.0);
      const g1 = gAt(S, fr, uc, -0.75), g1m = Math.min(gMin(-0.42), gMin(-0.8));
      if (g1 < -0.3) { wbox(mb, fr, o.u0 - 0.08, o.u1 + 0.08, g1m - 0.2, -0.19, -0.8, -0.42, { tile: 4, uo: uc + 0.4, skip: 8 }); colBox(o.u0 - 0.08, o.u1 + 0.08, g1m - 0.2, -0.19, -0.8, -0.42); }
    }
    // plank door leaf
    const tint = burnt ? CHAR : [0.78, 0.66, 0.54].map((v) => v * R.range(0.85, 1.1)), h = o.v1 - 0.04, len = wd - 0.05, lay = burnt ? LY.wood_charred : LY.wood_planks;
    if (o.leaf === 'shut') {
      mb.set(lay, tint);
      wbox(mb, fr, o.u0 + 0.01, o.u1 - 0.01, 0.0, h, rd - 0.02, rd + 0.025, { tile: 2, uo: R.f(), skip: 8 });
      mb.set(lay, tint.map((v) => v * 0.85));
      for (const v of [0.35, h - 0.35]) wbox(mb, fr, o.u0 + 0.04, o.u1 - 0.04, v - 0.06, v + 0.06, rd - 0.045, rd - 0.02, { tile: 2, skip: 8 });
      if (B.cb) {
        const a = FP(fr, o.u0, 0, rd - 0.05), b = FP(fr, o.u1, h, rd + 0.05);
        B.cb.box(Math.min(a[0], b[0]), 0, Math.min(a[2], b[2]), Math.max(a[0], b[0]), h, Math.max(a[2], b[2]));
      }
    } else if (o.leaf === 'ajar') {
      const ang = S.enterable ? R.range(1.45, 1.65) : R.range(0.5, 1.6), hu = o.u0 + 0.03, hd = rd + 0.03;
      const dir = [fr.ux * Math.cos(ang) - fr.nx * Math.sin(ang), 0, fr.uz * Math.cos(ang) - fr.nz * Math.sin(ang)];
      const H0 = FP(fr, hu, 0, hd), C = [H0[0] + dir[0] * len / 2, h / 2 + 0.01, H0[2] + dir[2] * len / 2];
      // a leaf swung over a floorless ruin whose ground falls away would hang in the air: leave it off
      const E = [H0[0] + dir[0] * len, H0[2] + dir[2] * len];
      const sag = S.enterable ? 0 : -Math.min(S.gl(C[0], C[2]), S.gl(E[0], E[1]));
      if (sag < 0.08) {
        mb.set(lay, tint);
        mb.obox(C, [dir[0] * len / 2, 0, dir[2] * len / 2], [0, h / 2, 0], [-dir[2] * 0.022, 0, dir[0] * 0.022], { tile: 2, uo: R.f() });
        // the leaf blocks like the wall it stands against (thin box along the leaf)
        if (B.cb) B.cb.box(Math.min(H0[0], E[0]) - 0.03, 0, Math.min(H0[2], E[1]) - 0.03, Math.max(H0[0], E[0]) + 0.03, h, Math.max(H0[2], E[1]) + 0.03);
      }
    } else if (o.leaf === 'off') {
      // torn off, lying in front of the doorway
      const du = R.range(-0.6, 0.6), dd0 = R.range(-0.9, -1.6), a = R.range(-0.6, 0.6);
      const ax = [fr.ux * Math.cos(a) + fr.nx * Math.sin(a), 0, fr.uz * Math.cos(a) + fr.nz * Math.sin(a)];
      const c = FP(fr, uc + du, 0, dd0), e0 = [c[0] - ax[0] * h / 2, c[2] - ax[2] * h / 2], e1 = [c[0] + ax[0] * h / 2, c[2] + ax[2] * h / 2];
      // lies on a plane fitted to the four corners; skipped where the ground is too uneven for it
      const sx = -ax[2] * len / 2, sz = ax[0] * len / 2, gp = (f, g) => S.gl(c[0] + ax[0] * h / 2 * f + sx * g, c[2] + ax[2] * h / 2 * f + sz * g);
      const g00 = gp(-1, -1), g01 = gp(-1, 1), g10 = gp(1, -1), g11 = gp(1, 1), yc = S.gl(c[0], c[2]);
      const ym = (g00 + g01 + g10 + g11) / 4, ka = (g10 + g11 - g00 - g01) / 4, kb = (g01 + g11 - g00 - g10) / 4;
      const dev = Math.max(Math.abs(g00 - (ym - ka - kb)), Math.abs(g01 - (ym - ka + kb)), Math.abs(g10 - (ym + ka - kb)), Math.abs(g11 - (ym + ka + kb)), yc - ym);
      if (dev < 0.06 && Math.abs(ka) < 0.4 && Math.abs(kb) < 0.3) {
        mb.set(lay, tint);
        mb.obox([c[0], ym + 0.026 + Math.max(0, dev), c[2]], [ax[0] * h / 2, ka, ax[2] * h / 2], [0, 0.022, 0], [sx, kb, sz], { tile: 2 });
      }
    }
    // house number plate
    if (S.number && solidAt(o.u1 + 0.5, 1.9) && !sp.noPlate) {
      mb.set(LY.slate_dark, [0.7, 0.82, 1.08]);
      const u = o.u1 + (S.stoneDoor ? 0.32 : 0.26);
      wbox(mb, fr, u, u + 0.17, 1.82, 1.95, -0.014, 0.01, { skip: 8 });
    }
  }
  // ---- cracks from the corners of the opening
  if (S.d > 0.22 && win) {
    const ch = 0.22 + 0.4 * S.d;
    if (R.chance(ch)) crack(mb, fr, o.u0 - 0.02, o.v1 + 0.02, -0.5, 1, S, solidAt);
    if (R.chance(ch)) crack(mb, fr, o.u1 + 0.02, o.v1 + 0.02, 0.5, 1, S, solidAt);
    if (!o.balc && R.chance(ch * 0.6)) crack(mb, fr, o.u1 + 0.02, o.v0 - 0.08, 0.4, -1, S, solidAt);
  }
  mb.det = 0;
}

function interiorBox(mb, fr, o, S, D, R) {
  const t = fr.t, fy = Math.floor((o.v0 + 0.1) / S.fH) * S.fH, ua = o.u0 - 0.6, ub = o.u1 + 0.6, kb = (S.nIb = ((S.nIb || 0) + 1) % 5), yb = (fy < 0.1 ? -0.3 : fy + 0.03) + kb * 0.007, yt = fy + S.fH - 0.32 + kb * 0.011, d1 = t + D + kb * 0.009;
  const P = (u, v, d) => [u, v, d], tO = S.tO;
  mb.set(0, tO.map((v) => v * 0.7));
  quadW(mb, fr, P(ua, yb, d1), P(ub, yb, d1), P(ub, yt, d1), P(ua, yt, d1), nOut(fr));
  mb.set(0, tO.map((v) => v * 0.6));
  quadW(mb, fr, P(ua, yb, t), P(ua, yb, d1), P(ua, yt, d1), P(ua, yt, t), [fr.ux, 0, fr.uz]);
  quadW(mb, fr, P(ub, yb, d1), P(ub, yb, t), P(ub, yt, t), P(ub, yt, d1), [-fr.ux, 0, -fr.uz]);
  quadW(mb, fr, P(ua, yt, t), P(ua, yt, d1), P(ub, yt, d1), P(ub, yt, t), [0, -1, 0]);
  mb.set(LY.wood_planks, [0.6, 0.55, 0.5]);
  quadW(mb, fr, P(ua, yb, t), P(ub, yb, t), P(ub, yb, d1), P(ua, yb, d1), [0, 1, 0]);
  // a silhouette: wardrobe, table or a fallen beam
  if (o.v0 > 0.5 * S.fH) return;   // furniture silhouettes only behind ground-floor windows
  const r = R.f(), u = R.range(ua + 0.5, ub - 0.5);
  mb.set(LY.wood_planks, [0.5, 0.42, 0.36]);
  if (r < 0.4) wbox(mb, fr, u - 0.45, u + 0.45, yb, yb + 1.85, d1 - 0.5, d1, { tile: 2, skip: 8 | 1 });
  else if (r < 0.75) {
    wbox(mb, fr, u - 0.5, u + 0.5, yb + 0.72, yb + 0.77, d1 - 1.0, d1 - 0.3, { tile: 2 });
    for (const q of [-0.42, 0.42]) wbox(mb, fr, u + q - 0.03, u + q + 0.03, yb, yb + 0.72, d1 - 0.95, d1 - 0.89, { skip: 3 });
  } else mb.beam(FP(fr, u - 0.6, yb, d1 - 0.2), FP(fr, u + 0.5, yt, d1 - 0.6), 0.14, 0.16);
}

// ---------------------------------------------------------------- wall build-up and fixtures
export function dressWall(B, fr, sp, solidAt, ops) {
  const S = sp.dress, dw = sp.dw || {}, mb = B.mb, R = S.rng, L = fr.L, t = fr.t, H = S.H, gable = !!dw.gable;
  const ext = gable ? t - 0.03 : 0.033;
  const j = 0.0025 * (((Math.round(Math.atan2(fr.uz, fr.ux) / (Math.PI / 2)) % 4) + 4) % 4) + (gable ? 0.001 : 0);
  const doors = ops.filter((o) => o.v0 < 0.3);
  const free = (u, v0, v1) => !ops.some((o) => u > o.u0 - 0.06 && u < o.u1 + 0.06 && o.v0 < v1 && o.v1 > v0);
  const runs = (y, v0, v1, emit) => {
    let a = null;
    const ns = Math.max(2, Math.ceil((L + 2 * ext) / 0.2));
    for (let q = 0; q <= ns; q++) {
      const uu = -ext + (L + 2 * ext) * q / ns, ok = solidAt(Math.min(Math.max(uu, 0.06), L - 0.06), y) && free(uu, v0, v1);
      if (ok && a === null) a = uu;
      if ((!ok || q === ns) && a !== null) { const b = ok ? L + ext : uu - (L + 2 * ext) / ns + 0.02; if (b - a > 0.3) emit(Math.max(a, -ext), Math.min(b, L + ext)); a = null; }
    }
  };
  mb.det = 1;
  // plinth course with a stone cap
  if (S.plinth) {
    const ph = S.plinthH;
    runs(ph * 0.5 + 0.05, -1.2, ph + 0.1, (a, b) => {
      if (S.plinth === 1) mb.set(LY.stone_masonry, [0.92, 0.9, 0.86]); else mb.set(0, S.tO.map((v) => v * 0.8));
      wbox(mb, fr, a, b, -1.15, ph, -0.04 - j, 0.03, { tile: 4, uo: a, skip: 8 | 2 });
      mb.set(LY.stone_blocks, STONE);
      wbox(mb, fr, a, b, ph, ph + 0.07 + j, -0.06 - j, 0.03, { tile: 4, uo: a * 0.7, skip: 8 | 2 });
    });
  }
  // cornice under the eave (long walls), string course between floors (all walls)
  if (S.cornice && !gable) {
    runs(H - 0.4, H - 0.4, H + 1, (a, b) => {
      if (S.cornice === 1) mb.set(LY.stone_blocks, STONE); else mb.set(0, S.tO.map((v) => v * 1.06));
      wbox(mb, fr, a, b, H - 0.34, H - 0.2, -0.06 - j, 0.03, { tile: 4, uo: a, skip: 8 | 2 });
      wbox(mb, fr, a, b, H - 0.2, H - 0.02 + j, -0.14 - j, 0.03, { tile: 4, uo: a * 0.6, skip: 8 | 1 });
    });
  }
  if (S.string) for (let k = 1; k < S.floors; k++) {
    const y = k * S.fH;
    runs(y + 0.02, y - 0.06, y + 0.1, (a, b) => { mb.set(0, S.tO.map((v) => v * 1.07)); wbox(mb, fr, a, b, y - 0.05 - j, y + 0.09 + j, -0.045 - j, 0.03, { tile: 4, uo: a, skip: 8 }); });
  }
  // quoins at both ends
  if (S.quoins) {
    const y0 = S.plinth ? S.plinthH + 0.07 : 0.0, y1 = H - (S.cornice && !gable ? 0.36 : 0.12);
    mb.set(LY.stone_blocks, STONE);
    for (let k = 0, y = y0; y + 0.3 <= y1; k++, y += 0.32) {
      const len = (k % 2 === 0) !== gable ? 0.46 : 0.28;
      for (const end of [0, 1]) {
        const ui = end ? L - 0.15 : 0.15;
        if (!solidAt(ui, y + 0.16)) continue;
        const ua = end ? L - (gable ? -(t - 0.03) + len : len) : (gable ? -(t - 0.03) : -0.018);
        const ub = end ? L + (gable ? t - 0.03 : 0.018) : (gable ? -(t - 0.03) + len : len);
        wbox(mb, fr, ua, ub, y + 0.005 + j, y + 0.315 - j, -0.025 - j, 0.03, { tile: 4, uo: k * 0.37 + end, skip: 8 });
      }
    }
  }
  // plaster fallen away in patches; broken plaster around the shell holes
  const nP = R.int(0, 2) + (S.d > 0.35 ? 1 : 0);
  for (let k = 0, tries = 0; k < nP && tries < 8; tries++) {
    const uc = R.range(0.7, L - 0.7), vc = R.range(0.5, H - 0.6), rx = R.range(0.3, 0.75), ry = rx * R.range(0.55, 0.9);
    if (!free(uc, vc - ry - 0.3, vc + ry + 0.3) || ops.some((o) => Math.abs(uc - (o.u0 + o.u1) / 2) < (o.u1 - o.u0) / 2 + rx + 0.3 && Math.abs(vc - (o.v0 + o.v1) / 2) < (o.v1 - o.v0) / 2 + ry + 0.3)) continue;
    if (plasterEdge(mb, fr, uc, vc, rx, ry, S, solidAt, sp, false)) k++;
  }
  for (const b of S.blasts || []) {
    const dx = b.x - fr.ox, dz = b.z - fr.oz, dist = dx * fr.nx + dz * fr.nz, u = dx * fr.ux + dz * fr.uz;
    if (Math.abs(dist) > b.r * 0.85 || u < -b.r || u > L + b.r || b.y - b.r > (gable ? H + 3 : H)) continue;
    const re = Math.sqrt(Math.max(0.05, b.r * b.r - dist * dist)) * 1.45;
    plasterEdge(mb, fr, u, b.y, re, re, S, solidAt, sp, true);
  }
  // fixtures on the door wall
  const dr = doors[0];
  if (dw.doorWall && dr && !dr.arch) {
    const side = dr.u1 + 1.0 < L - 0.5 ? 1 : -1, ul = side > 0 ? dr.u1 + 0.5 : dr.u0 - 0.5;
    if (S.lamp && solidAt(ul, 2.6) && free(ul, 2.0, 3.0) && H > 3.2) {
      mb.set(LY.wood_charred, IRON);
      wbox(mb, fr, ul - 0.06, ul + 0.06, 2.45, 2.75, -0.02, 0.01, { skip: 8 });
      mb.beam(FP(fr, ul, 2.68, -0.01), FP(fr, ul, 2.72, -0.6), 0.035, 0.035);
      mb.beam(FP(fr, ul, 2.47, -0.01), FP(fr, ul, 2.7, -0.38), 0.025, 0.025);
      mb.beam(FP(fr, ul, 2.72, -0.58), FP(fr, ul, 2.5, -0.58), 0.012, 0.012);
      mb.set(LY.slate_dark, [0.5, 0.48, 0.46]);
      wbox(mb, fr, ul - 0.09, ul + 0.09, 2.24, 2.5, -0.67, -0.49, { tile: 2 });
      wbox(mb, fr, ul - 0.13, ul + 0.13, 2.5, 2.54, -0.71, -0.45, { tile: 2 });
    }
    // bench on the other side of the door, against the wall
    const bs = -side, ua = bs > 0 ? dr.u1 + 0.3 : dr.u0 - 1.75, ubn = ua + 1.45;
    if (S.bench && ua > 0.3 && ubn < L - 0.3 && solidAt(ua + 0.7, 0.5) && free(ua + 0.1, 0, 0.9) && free(ubn - 0.1, 0, 0.9)) {
      const ga = Math.min(gAt(S, fr, ua + 0.15, -0.06), gAt(S, fr, ua + 0.15, -0.38)), gb = Math.min(gAt(S, fr, ubn - 0.15, -0.06), gAt(S, fr, ubn - 0.15, -0.38)), gy = Math.max(gAt(S, fr, ua + 0.15, -0.25), gAt(S, fr, ubn - 0.15, -0.25));
      if (Math.abs(ga - gb) < 0.25) {
        mb.set(LY.wood_planks, [0.9, 0.8, 0.68]);
        wbox(mb, fr, ua, ubn, gy + 0.42, gy + 0.47, -0.42, -0.02, { tile: 2, uo: ua });
        mb.set(LY.stone_blocks, STONE2);
        for (const u of [ua + 0.15, ubn - 0.25]) wbox(mb, fr, u, u + 0.1, Math.min(ga, gb) - 0.1, gy + 0.42, -0.38, -0.06, { skip: 1 });
      }
    }
    // blade sign bracket over a ground-floor window
    const w0 = ops.find((o) => !o.door && o.v0 < 1.5 && o.v1 < 2.6);
    if (S.sign && w0) {
      const u = w0.u1 + 0.3;
      if (solidAt(u, 3.0) && free(u, 2.7, 3.2) && H > 3.6) {
        mb.set(LY.wood_charred, IRON);
        wbox(mb, fr, u - 0.05, u + 0.05, 2.8, 3.15, -0.02, 0.01, { skip: 8 });
        mb.beam(FP(fr, u, 3.08, -0.01), FP(fr, u, 3.08, -0.95), 0.03, 0.04);
        mb.beam(FP(fr, u, 2.84, -0.01), FP(fr, u, 3.07, -0.55), 0.022, 0.022);
        for (const dd of [-0.3, -0.85]) mb.beam(FP(fr, u, 3.06, dd), FP(fr, u, 2.98, dd), 0.012, 0.012);
        mb.set(LY.wood_planks, [0.82, 0.7, 0.56]);
        const tilt = R.chance(0.35) ? R.range(-0.25, 0.25) : 0;
        mb.obox(FP(fr, u, 2.74, -0.58), [-fr.nx * 0.33, tilt * 0.3, -fr.nz * 0.33], [0, 0.24, 0], [fr.ux * 0.02, 0, fr.uz * 0.02], { tile: 2 });
      }
    }
  }
  // firewood stacked under the eaves of a long wall
  if (S.wood && !gable && !dw.doorWall) {
    const len = R.range(1.4, 2.3), ua = R.range(0.6, Math.max(0.7, L - len - 0.6)), ub = ua + len;
    const gs = [ua, (ua + ub) / 2, ub].flatMap((u) => [gAt(S, fr, u, -0.05), gAt(S, fr, u, -0.46)]), gmin = Math.min(...gs), gmax = Math.max(...gs), top = gmax + R.range(0.75, 1.1);
    if (ub < L - 0.4 && gmax - gmin < 0.35 && solidAt(ua + 0.2, 0.5) && solidAt(ub - 0.2, 0.5) && free(ua, -1, top + 0.1) && free(ub, -1, top + 0.1) && free((ua + ub) / 2, -1, top + 0.1)) {
      mb.set(LY.wood_beam, [1.12, 0.96, 0.74]);
      wbox(mb, fr, ua, ub, gmin - 0.1, top, -0.46, 0.02, { tile: 1, uo: R.f(), skip: 8 });
      mb.set(LY.wood_beam, [1.0, 0.86, 0.68]);
      for (let k = 0; k < 4; k++) { const u = R.range(ua + 0.2, ub - 0.2), dd = R.range(-0.4, -0.1); mb.beam(FP(fr, u - 0.25, top + 0.055, dd), FP(fr, u + 0.25, top + 0.055, dd + R.range(-0.08, 0.08)), 0.11, 0.11); }
      for (const u of [ua - 0.04, ub - 0.02]) wbox(mb, fr, u, u + 0.06, gmin - 0.1, top + 0.05, -0.5, -0.44, { skip: 8 });
      if (B.cb) { const a = FP(fr, ua, 0, -0.46), b2 = FP(fr, ub, 0, 0.02); B.cb.box(Math.min(a[0], b2[0]), gmin - 0.1, Math.min(a[2], b2[2]), Math.max(a[0], b2[0]), top, Math.max(a[2], b2[2])); }
    }
  }
  // wooden balcony with carved boards in front of a first-floor door
  const bo = ops.find((o) => o.balc);
  if (bo) {
    const y = bo.v0 - 0.02, ua = Math.max(0.15, bo.u0 - 0.85), ub = Math.min(L - 0.15, bo.u1 + 0.85), out = 1.0;
    if (solidAt(ua + 0.2, y - 0.3) && solidAt(ub - 0.2, y - 0.3) && solidAt((ua + ub) / 2, y - 0.3)) {
      mb.set(LY.wood_planks, BALC);
      wbox(mb, fr, ua, ub, y - 0.07, y, -out, 0.06, { tile: 2 });
      mb.set(LY.wood_beam, BALC.map((v) => v * 0.95));
      for (const u of [ua + 0.12, (ua + ub) / 2, ub - 0.12]) {
        wbox(mb, fr, u - 0.07, u + 0.07, y - 0.25, y - 0.07, -out - 0.1, 0.1, { tile: 2, skip: 8 });
        mb.beam(FP(fr, u, y - 1.05, 0.0), FP(fr, u, y - 0.25, -out + 0.3), 0.1, 0.1);
      }
      wbox(mb, fr, ua, ub, y + 0.93, y + 1.0, -out, -out + 0.09, { tile: 2 });
      wbox(mb, fr, ua, ub, y + 0.08, y + 0.14, -out + 0.01, -out + 0.07, { tile: 2 });
      for (const u of [ua, ub - 0.08]) { wbox(mb, fr, u, u + 0.08, y + 0.932, y + 0.995, -out + 0.09, 0.0, { tile: 2 }); wbox(mb, fr, u, u + 0.08, y, y + 0.93, -out, -out + 0.08, { tile: 2 }); }
      mb.set(LY.wood_planks, BALC.map((v) => v * 1.08));
      const board = (u, du, d0, d1, alongU) => {
        const box = (v0, v1, hw) => alongU ? wbox(mb, fr, u - hw, u + hw, y + v0, y + v1, d0, d1, { tile: 2, skip: 3 }) : wbox(mb, fr, u, u + du, y + v0, y + v1, d0 - hw, d0 + hw, { tile: 2, skip: 3 });
        box(0.14, 0.48, 0.06); box(0.48, 0.6, 0.025); box(0.6, 0.93, 0.06);
      };
      for (let u = ua + 0.16; u < ub - 0.12; u += 0.15) board(u, 0, -out + 0.03, -out + 0.055, true);
      for (const u of [ua + 0.02, ub - 0.045]) for (let d = -out + 0.2; d < -0.1; d += 0.15) board(u, 0.025, d, d, false);
    }
  }
  mb.det = 0;
}
