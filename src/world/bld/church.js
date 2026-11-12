// Parish church with the landmark bell tower (white plaster shaft, paired
// belfry arches, steep slate spire).
import { RNG } from '../../core/noise.js';
import { LY } from './mb.js';
import { makeField, mkFrame, buildWall, buildRoof, houseRubble } from './house.js';

export function buildChurch(B, b) {
  const rng = new RNG(b.seed), mb = B.mb, w = b.w, d = b.d, t = 0.8, eave = 8.6, pitch = 0.5, tanp = Math.tan(pitch);
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const W = (lx, lz) => [b.x + lx * c - lz * s, b.z + lx * s + lz * c];
  mb.xf(b.x, b.baseY, b.z, b.rot);
  if (B.cb) B.cb.xf(b.x, b.baseY, b.z, b.rot);
  B.baseY = b.baseY;
  const tO = [1.1, 1.07, 1.0], tI = [0.98, 0.95, 0.9];
  const blasts = [
    { x: 3.5, y: 5.6, z: d / 2, r: 1.25 }, { x: -4.5, y: 2.8, z: d / 2, r: 0.9 }, { x: 8.5, y: 7.0, z: d / 2, r: 0.7 },
    { x: -w / 2, y: 5.2, z: -3.9, r: 0.75 }, { x: -w / 2, y: 2.0, z: -4.5, r: 0.5 }, { x: 5, y: eave + 2.4, z: 2.2, r: 2.6 }, { x: -6, y: 4, z: -d / 2, r: 1.1 },
  ];
  const field = makeField({ noise: B.noise, H: eave + 3.5, seed: b.seed, blasts, collapse: null, rag: 0.25, amp: 0.45 });
  const roofF = (x, y, z) => Math.max(field(x, y - 0.5, z) + 0.25, 1.6 * B.noise.fbm2(x * 0.2 + 3.3, z * 0.2, 3) - 0.66);
  const yRoof = (z) => eave + (d / 2 - Math.abs(z)) * tanp;
  const base = { layer: 11, y0: -1.5, eave, field, tO, tI, rng, cell: 0.45, noLintel: true, aoI: 0.45 };
  const side = (L) => {
    const ops = [];
    for (let k = 0; k < 4; k++) { const uc = L * (k + 0.5) / 4; ops.push({ u0: uc - 0.65, u1: uc + 0.65, v0: 3.6, v1: 6.9, arch: 1, trim: 0.2 }); }
    return ops;
  };
  buildWall(B, mkFrame(-w / 2, d / 2, w / 2, d / 2, 0, 1, t), { ...base, openings: side(w), uvo: 3, ends: [6, 6] });
  buildWall(B, mkFrame(w / 2, -d / 2, -w / 2, -d / 2, 0, -1, t), { ...base, openings: side(w), uvo: 17, ends: [6, 6] });
  // west front (faces the square): arched door and oculus; east gable: small oculus
  const frW = mkFrame(-w / 2, -d / 2 + t, -w / 2, d / 2 - t, -1, 0, t), frE = mkFrame(w / 2, d / 2 - t, w / 2, -d / 2 + t, 1, 0, t);
  const du = 2.9;
  buildWall(B, frW, {
    ...base, uvo: 31, ends: [2, 2], top: (u) => yRoof(frW.oz + frW.uz * u),
    openings: [{ u0: du - 1.05, u1: du + 1.05, v0: 0, v1: 3.7, arch: 1, trim: 0.26 }, { u0: du - 0.85, u1: du + 0.85, v0: 6.1, v1: 7.8, arch: 2, trim: 0.22 }],
  });
  buildWall(B, frE, {
    ...base, uvo: 44, ends: [2, 2], top: (u) => yRoof(frE.oz + frE.uz * u),
    openings: [{ u0: frE.L / 2 - 0.6, u1: frE.L / 2 + 0.6, v0: 6.9, v1: 8.1, arch: 2, trim: 0.2 }],
  });
  buildRoof(B, { w, d, eave, pitch, field, roofF, rng, burnt: false, uvo: 5, tint: [0.98, 0.95, 0.95], og: 0.4, oe: 0.55 });

  // ---------------- bell tower at the south-west corner
  const hs = b.towerSize / 2, tx = -(w / 2 + 1.4), tz = d / 2 - 2.2, tt = 0.75, Ht = 27;
  const tb = [{ x: tx - 0.5, y: 14, z: tz + hs, r: 0.6 }, { x: tx + 1.2, y: 19, z: tz + hs, r: 0.45 }, { x: tx - hs, y: 9.5, z: tz + 0.6, r: 0.6 },
    { x: tx - hs, y: 17.5, z: tz - 1, r: 0.4 }, { x: tx + 1.5, y: 6.5, z: tz + hs, r: 0.5 }, { x: tx - hs, y: 23.6, z: tz + 1.9, r: 0.5 }];
  const tf = makeField({ noise: B.noise, H: Ht + 12, seed: 99, blasts: tb, collapse: null, rag: 0, amp: 0.35 });
  const tbase = { layer: 11, y0: -2.5, eave: Ht, field: tf, tO: [1.2, 1.19, 1.16], tI: [0.8, 0.8, 0.78], rng, cell: 0.5, noLintel: true, aoI: 0.4 };
  const belfry = (L) => { const m = L / 2; return [{ u0: m - 1.25, u1: m - 0.3, v0: 21.7, v1: 24.9, arch: 1, trim: 0.16 }, { u0: m + 0.3, u1: m + 1.25, v0: 21.7, v1: 24.9, arch: 1, trim: 0.16 }]; };
  const slits = (L) => [6.2, 12.2, 17.4].map((y) => ({ u0: L / 2 - 0.22, u1: L / 2 + 0.22, v0: y, v1: y + 1.15 }));
  const tfr = [
    mkFrame(tx - hs, tz + hs, tx + hs, tz + hs, 0, 1, tt), mkFrame(tx + hs, tz - hs, tx - hs, tz - hs, 0, -1, tt),
    mkFrame(tx + hs, tz + hs - tt, tx + hs, tz - hs + tt, 1, 0, tt), mkFrame(tx - hs, tz - hs + tt, tx - hs, tz + hs - tt, -1, 0, tt),
  ];
  tfr.forEach((fr, i) => buildWall(B, fr, { ...tbase, openings: [...belfry(fr.L), ...(i === 0 || i === 3 ? slits(fr.L) : [])], uvo: 50 + i * 9, ends: i < 2 ? [6, 6] : [2, 2] }));
  // string courses, cornice
  mb.set(LY.stone_blocks, [1.2, 1.18, 1.14]);
  const ring = (y0, y1, out) => {
    const a = hs + out;
    mb.abox(tx - a, y0, tz + hs - 0.05, tx + a, y1, tz + a, { axis: 'x', tile: 4 });
    mb.abox(tx - a, y0, tz - a, tx + a, y1, tz - hs + 0.05, { axis: 'x', tile: 4 });
    mb.abox(tx + hs - 0.05, y0, tz - hs, tx + a, y1, tz + hs, { axis: 'z', tile: 4 });
    mb.abox(tx - a, y0, tz - hs, tx - hs + 0.05, y1, tz + hs, { axis: 'z', tile: 4 });
  };
  ring(8.2, 8.46, 0.1); ring(15.0, 15.26, 0.1); ring(20.9, 21.22, 0.15); ring(25.55, 25.75, 0.08);
  mb.abox(tx - hs - 0.24, Ht, tz - hs - 0.24, tx + hs + 0.24, Ht + 0.38, tz + hs + 0.24, { axis: 'x', tile: 4 });
  // belfry floor, bell
  mb.set(LY.wood_planks, [0.8, 0.76, 0.7]);
  mb.abox(tx - hs + tt, 21.35, tz - hs + tt, tx + hs - tt, 21.5, tz + hs - tt, { ao: 0.5 });
  mb.set(LY.wood_beam, [0.9, 0.85, 0.8]);
  mb.beam([tx - hs + tt, 24.25, tz], [tx + hs - tt, 24.25, tz], 0.22, 0.26, { ao: 0.6 });
  const prof = [[0.05, 24.1], [0.2, 24.05], [0.3, 23.8], [0.36, 23.35], [0.47, 23.0], [0.62, 22.8]];
  mb.set(LY.slate_dark, [1.5, 1.25, 0.8]);
  for (let k = 0; k < prof.length - 1; k++) for (let q = 0; q < 8; q++) {
    const a0 = q / 8 * 6.2832, a1 = (q + 1) / 8 * 6.2832, am = (a0 + a1) / 2;
    const p = (r, a) => [tx + r[0] * Math.cos(a), r[1], tz + r[0] * Math.sin(a)];
    mb.quad(p(prof[k], a0), p(prof[k], a1), p(prof[k + 1], a1), p(prof[k + 1], a0), [Math.cos(am), 0.3, Math.sin(am)], [q * 0.1, k * 0.1], [q * 0.1 + 0.1, k * 0.1], [q * 0.1 + 0.1, k * 0.1 + 0.1], [q * 0.1, k * 0.1 + 0.1], 0.6, 0, 0, true);
  }
  // spire: flared octagonal pyramid in dark slate
  const y0s = Ht + 0.38, R0 = 3.3, y1s = y0s + 1.1, R1 = 2.5, yA = y0s + 9.3, RA = 0.07, s8 = Math.sin(Math.PI / 8), c8 = Math.cos(Math.PI / 8);
  mb.set(LY.slate_dark, [1.0, 1.0, 1.03]);
  const sp = (r, y, a) => [tx + r * Math.cos(a), y, tz + r * Math.sin(a)];
  for (let k = 0; k < 8; k++) {
    const a0 = (k - 0.5) * Math.PI / 4, a1 = (k + 0.5) * Math.PI / 4, am = k * Math.PI / 4, n = [Math.cos(am), 0.4, Math.sin(am)], uo = k * 1.37;
    const seg = (ra, ya, rb, yb, vo) => {
      const wa = 2 * ra * s8, wb = 2 * rb * s8, sl = Math.hypot((ra - rb) * c8, yb - ya);
      mb.quad(sp(ra, ya, a0), sp(ra, ya, a1), sp(rb, yb, a1), sp(rb, yb, a0), n, [uo - wa / 4, vo], [uo + wa / 4, vo], [uo + wb / 4, vo - sl / 2], [uo - wb / 4, vo - sl / 2], 1, 0, 0, true);
      return vo - sl / 2;
    };
    seg(R1, y1s, RA, yA, seg(R0, y0s, R1, y1s, 0));
    // eave underside
    mb.quad(sp(R0, y0s, a0), sp(R0, y0s, a1), sp(R0 - 0.9, y0s + 0.02, a1), sp(R0 - 0.9, y0s + 0.02, a0), [0, -1, 0], [0, 0], [0.5, 0], [0.5, 0.4], [0, 0.4], 0.5);
  }
  // cross
  mb.set(LY.slate_dark, [0.55, 0.55, 0.55]);
  mb.abox(tx - 0.06, yA - 0.15, tz - 0.06, tx + 0.06, yA + 1.9, tz + 0.06, { axis: 'y' });
  mb.abox(tx - 0.55, yA + 1.2, tz - 0.05, tx + 0.55, yA + 1.32, tz + 0.05, { axis: 'x' });
  mb.abox(tx - 0.16, yA - 0.1, tz - 0.16, tx + 0.16, yA + 0.22, tz + 0.16);

  houseRubble(B, b, { collapse: null, debris: 0.8 }, field, W, rng, eave, true);
}
