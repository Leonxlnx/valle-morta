// Town furniture baked into the structure chunks (no extra draw calls):
// dry fountain, market stall frames, hand carts, furniture barricades and
// timber garden fences, plus the details of the hand-planned buildings
// (inn balcony and sign, town-hall clock, barn door, stairs/holes setup).
import { RNG } from '../../core/noise.js';
import { LY } from './mb.js';

const WOOD = [1.02, 0.95, 0.86], BEAM = [1.05, 1.0, 0.95], OLD = [0.86, 0.82, 0.76], STONE = [1.12, 1.1, 1.04], CHAR = [0.8, 0.8, 0.8];

// oriented box (yaw about +y in the current local frame) into mesh + collider
function obb(mb, cb, cx, cy, cz, hx, hy, hz, yaw = 0, o = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  mb.obox([cx, cy, cz], [c * hx, 0, s * hx], [0, hy, 0], [-s * hz, 0, c * hz], o);
  if (cb) {
    const P = (u, v, w) => [cx + c * u * hx - s * w * hz, cy + v * hy, cz + s * u * hx + c * w * hz];
    cb.hex([P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1)], [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)]);
  }
}

// rotate a local point about the z axis through (ax, ay) by angle a (cart pitch)
const pitch = (p, ax, ay, a) => { const x = p[0] - ax, y = p[1] - ay, c = Math.cos(a), s = Math.sin(a); return [ax + x * c - y * s, ay + x * s + y * c, p[2]]; };

function fountain(mb, cb, gl, rng) {
  const R = 1.5, n = 8, seg = 2 * R * Math.tan(Math.PI / n) * 0.5;
  const broken = rng.int(0, n - 1);
  for (let k = 0; k < n; k++) {
    const a = (k + 0.5) / n * Math.PI * 2, r = R - 0.15, x = Math.cos(a) * r, z = Math.sin(a) * r, yaw = a + Math.PI / 2;
    const top = k === broken ? 0.28 : 0.62, y0 = Math.min(gl(x, z), 0) - 0.25;
    mb.set(LY.stone_blocks, STONE);
    obb(mb, cb, x, (y0 + top) / 2, z, seg + 0.02, (top - y0) / 2, 0.15, yaw, { tile: 2, uo: k * 0.37 });
    if (k !== broken) { mb.set(LY.stone_blocks, [1.2, 1.18, 1.12]); obb(mb, null, x, top + 0.04, z, seg + 0.08, 0.045, 0.21, yaw, { tile: 2, uo: k * 0.21 }); }
    else for (let q = 0; q < 4; q++) { const rr = R + 0.3 + rng.range(0, 0.6), aa = a + rng.range(-0.3, 0.3), xx = Math.cos(aa) * rr, zz = Math.sin(aa) * rr; mb.set(LY.stone_blocks, STONE); obb(mb, null, xx, gl(xx, zz) + 0.07, zz, 0.2, 0.09, 0.13, rng.range(0, 3), { tile: 2 }); }
  }
  // dry basin floor, central pillar with bowl and finial
  mb.set(LY.stone_masonry, [0.95, 0.93, 0.88]);
  mb.abox(-R + 0.3, -0.2, -R + 0.3, R - 0.3, 0.12, R - 0.3, { tile: 3, skip: 2 });
  mb.set(LY.stone_blocks, STONE);
  obb(mb, cb, 0, 0.6, 0, 0.2, 0.6, 0.2, 0.4, { tile: 2 });
  obb(mb, cb, 0, 1.25, 0, 0.42, 0.06, 0.42, 0.4 + Math.PI / 4, { tile: 2 });
  obb(mb, null, 0, 1.42, 0, 0.12, 0.12, 0.12, 0.4, { tile: 2 });
  obb(mb, null, 0, 1.6, 0, 0.07, 0.06, 0.07, 0.4, { tile: 2 });
  mb.set(LY.rubble, [1.0, 0.98, 0.95]);
  obb(mb, null, 0.6, 0.17, -0.4, 0.25, 0.06, 0.18, 0.7, { tile: 2 });
}

function stall(mb, cb, gl, rng) {
  // local: counter along x, customer side at -z
  const post = (x, z, h) => { const y0 = gl(x, z) - 0.3; mb.set(LY.wood_beam, BEAM); obb(mb, cb, x, (y0 + h) / 2, z, 0.05, (h - y0) / 2, 0.05, 0, { tile: 2, uo: x }); };
  post(-1.22, -0.72, 2.3); post(1.22, -0.72, 2.3); post(-1.22, 0.72, 2.0); post(1.22, 0.72, 2.0);
  mb.set(LY.wood_planks, WOOD);
  obb(mb, cb, 0, 0.92, -0.45, 1.27, 0.03, 0.32, 0, { tile: 2 });
  mb.set(LY.wood_planks, OLD);
  obb(mb, cb, 0, 0.45, -0.75, 1.2, 0.45, 0.02, 0, { tile: 2, uo: 0.3 });
  // canopy frame: side rails, ridge and a couple of slats (one fallen)
  mb.set(LY.wood_beam, BEAM);
  for (const x of [-1.22, 1.22]) mb.beam([x, 2.3, -0.85], [x, 2.0, 0.85], 0.06, 0.08);
  mb.beam([-1.3, 2.3, -0.72], [1.3, 2.3, -0.72], 0.06, 0.08);
  mb.beam([-1.3, 2.0, 0.72], [1.3, 2.0, 0.72], 0.06, 0.08);
  mb.set(LY.wood_planks, WOOD);
  for (const z of [-0.35, 0.0, 0.35]) if (rng.chance(0.75)) { const y = 2.3 - (z + 0.72) / 1.44 * 0.3 + 0.06; mb.beam([-1.3, y, z], [1.3, y, z], 0.18, 0.02, { uo: z }); }
  const fx = rng.range(-0.6, 0.6); mb.beam([fx - 1.1, gl(fx - 1.1, -1.2) + 0.03, -1.25], [fx + 1.1, 0.95, -0.8], 0.18, 0.02);
  // crates under the counter
  mb.set(LY.wood_planks, OLD); obb(mb, null, 0.6, gl(0.6, 0.3) + 0.2, 0.3, 0.3, 0.2, 0.22, 0.2, { tile: 2 });
}

function cart(mb, cb, gl, rng, tipped) {
  // two-wheeled hand cart, shafts resting on the ground (local +x), axle at x = -0.5
  const ax = -0.5, ay = 0.6, a = tipped ? 0 : -0.3, P = (p) => pitch(p, ax, ay, a);
  const box = (x0, y0, z0, x1, y1, z1, col, layer = LY.wood_planks, tint = WOOD) => {
    const c = P([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]), ca = Math.cos(a), sa = Math.sin(a), hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (z1 - z0) / 2;
    mb.set(layer, tint);
    const U = [ca * hx, sa * hx, 0], V = [-sa * hy, ca * hy, 0], W = [0, 0, hz];
    mb.obox(c, U, V, W, { tile: 2, uo: x0 });
    if (col && cb) {
      const p = (u, v, w) => [c[0] + u * U[0] + v * V[0], c[1] + u * U[1] + v * V[1], c[2] + w * hz];
      cb.hex([p(-1, -1, -1), p(1, -1, -1), p(1, 1, -1), p(-1, 1, -1)], [p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)]);
    }
  };
  box(-1.5, 0.72, -0.62, 0.5, 0.78, 0.62, true);                     // bed
  for (const z of [-0.6, 0.6]) box(-1.5, 0.78, z - 0.025, 0.5, 1.08, z + 0.025, true, LY.wood_planks, OLD);
  box(-1.52, 0.78, -0.6, -1.47, 1.02, 0.6, true, LY.wood_planks, OLD);
  for (const z of [-0.42, 0.42]) { const p0 = P([-1.4, 0.68, z]), p1 = P([1.75, 0.68, z * 0.75]); mb.set(LY.wood_beam, BEAM); mb.beam(p0, p1, 0.07, 0.08); }
  // wheels: rim polygon, spokes, hub
  mb.set(LY.wood_beam, OLD);
  for (const z of [-0.78, 0.78]) {
    const n = 12, r = 0.58;
    for (let k = 0; k < n; k++) {
      const a0 = k / n * Math.PI * 2, a1 = (k + 1) / n * Math.PI * 2;
      mb.beam([ax + Math.cos(a0) * r, ay + Math.sin(a0) * r, z], [ax + Math.cos(a1) * r, ay + Math.sin(a1) * r, z], 0.06, 0.07);
    }
    for (let k = 0; k < 6; k++) { const aa = k / 6 * Math.PI; mb.beam([ax + Math.cos(aa) * r, ay + Math.sin(aa) * r, z], [ax - Math.cos(aa) * r, ay - Math.sin(aa) * r, z], 0.035, 0.035); }
    obb(mb, cb, ax, ay, z, 0.1, 0.1, 0.08);
    if (cb) cb.box(ax - 0.55, 0.02, z - 0.05, ax + 0.55, 1.15, z + 0.05);
  }
  mb.beam([ax, ay, -0.86], [ax, ay, 0.86], 0.06, 0.06);
  // load: a couple of sacks / planks
  if (!tipped) { mb.set(LY.wood_planks, OLD); const p = P([-0.7, 0.86, 0.1]); mb.obox(p, [0.5, -0.15, 0], [0.04, 0.08, 0], [0, 0, 0.25], { tile: 2 }); }
  void gl; void rng;
}

function barricade(mb, cb, gl, rng) {
  const g = (x, z) => gl(x, z);
  // wardrobe lying on its side
  mb.set(LY.wood_planks, [0.9, 0.78, 0.66]);
  obb(mb, cb, -0.75, Math.min(g(-1.7, 0), g(0.2, 0)) + 0.31, 0.05, 0.95, 0.33, 0.5, 0.03, { tile: 2 });
  mb.set(LY.wood_beam, [0.8, 0.7, 0.6]);
  for (const x of [-1.68, 0.18]) obb(mb, null, x, g(-0.75, 0) + 0.32, 0.05, 0.02, 0.35, 0.52, 0.03, { tile: 2 });
  // table on its side, legs towards the street side (+z), top as a shield
  mb.set(LY.wood_planks, WOOD);
  obb(mb, cb, 0.95, g(0.95, -0.3) + 0.42, -0.25, 0.68, 0.42, 0.025, -0.06, { tile: 2 });
  mb.set(LY.wood_beam, BEAM);
  for (const [x, y] of [[0.4, 0.12], [1.5, 0.12], [0.4, 0.74], [1.5, 0.74]]) mb.beam([x, g(x, 0) + y, -0.22], [x, g(x, 0) + y, 0.45], 0.05, 0.05);
  // a door leaf leaning against the wardrobe, loose planks, a chair
  mb.set(LY.wood_planks, OLD);
  const lean = 1.05, y0 = g(-0.9, 0.95);
  const c = [-0.9, y0 + Math.sin(lean) * 1.0, 0.95 - Math.cos(lean) * 1.0 + 0.05];
  mb.obox(c, [0.42, 0, 0], [0, Math.sin(lean) * 1.0, -Math.cos(lean) * 1.0], [0, Math.cos(lean) * 0.025, Math.sin(lean) * 0.025], { tile: 2 });
  if (cb) cb.quad([-1.32, y0, 0.98], [-0.48, y0, 0.98], [-0.48, y0 + Math.sin(lean) * 2, 0.98 - Math.cos(lean) * 2], [-1.32, y0 + Math.sin(lean) * 2, 0.98 - Math.cos(lean) * 2]);
  for (let k = 0; k < 3; k++) { const x = rng.range(-1.4, 1.4), z = rng.range(0.5, 0.9), yaw = rng.range(-0.6, 0.6); obb(mb, null, x, g(x, z) + 0.03, z, 0.7, 0.012, 0.09, yaw, { tile: 2 }); }
  mb.set(LY.wood_beam, BEAM);
  const chx = 1.4, chz = 0.55, cy = g(chx, chz);
  obb(mb, null, chx, cy + 0.22, chz, 0.2, 0.02, 0.2, 0.5, { tile: 2 });
  for (const [dx, dz] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]]) mb.beam([chx + dx, cy, chz + dz], [chx + dx, cy + 0.22, chz + dz], 0.03, 0.03);
}

function fence(mb, cb, gl, rng, L) {
  const n = Math.max(2, Math.round(L / 1.4)), x0 = -L / 2;
  mb.set(LY.wood_beam, OLD);
  for (let k = 0; k <= n; k++) { const x = x0 + L * k / n, y0 = gl(x, 0) - 0.3; if (k === 2 && rng.chance(0.4)) continue; obb(mb, cb, x, (y0 + 1.1 + gl(x, 0)) / 2, 0, 0.05, (1.1 + gl(x, 0) - y0) / 2, 0.05, 0, { tile: 2, uo: k }); }
  const brk = rng.int(0, n - 1);
  for (const y of [0.35, 0.85]) for (let k = 0; k < n; k++) {
    if (k === brk && y > 0.5) continue;
    const xa = x0 + L * k / n, xb = x0 + L * (k + 1) / n;
    mb.beam([xa, gl(xa, 0) + y, 0.07], [xb, gl(xb, 0) + y + (k === brk ? -0.3 : 0), 0.07], 0.035, 0.08);
  }
  mb.set(LY.wood_planks, [0.92, 0.86, 0.78]);
  for (let x = x0 + 0.08; x < -x0 - 0.05; x += 0.16) {
    if (rng.chance(0.18)) continue;
    const xi = Math.floor((x - x0) / (L / n)), h = xi === brk ? rng.range(0.2, 0.6) : rng.range(0.92, 1.02), g0 = gl(x, 0);
    mb.abox(x - 0.045, g0 - 0.05, 0.1, x + 0.045, g0 + h, 0.12, { axis: 'y', tile: 2, uo: x * 1.7, skip: 2 });
  }
  if (cb) cb.box(x0, -0.3, -0.06, -x0, 1.05, 0.13);
}

// street furniture from layout.cover that belongs to the structure material
export function buildTown(B, mbOf, cbWood, cbStone) {
  const L = B.layout, n = { fountain: 0, stall: 0, cart: 0, barricade: 0, fence: 0 };
  for (const c of L.cover || []) {
    if (!(c.type in n)) continue;
    const mb = mbOf(c), rng = new RNG(c.seed + 17), cs = Math.cos(c.rot), sn = Math.sin(c.rot);
    const toW = (lx, lz) => [c.x + lx * cs - lz * sn, c.z + lx * sn + lz * cs];
    let y0 = 1e9, sum = 0;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) { const p = toW(u * c.w / 2, v * c.d / 2), h = B.ground(p[0], p[1]); y0 = Math.min(y0, h); sum += h; }
    const yb = c.type === 'fountain' || c.type === 'fence' ? y0 : sum / 5 - 0.02;
    const gl = (lx, lz) => { const p = toW(lx, lz); return B.ground(p[0], p[1]) - yb; };
    mb.xf(c.x, yb, c.z, c.rot);
    const cb = c.type === 'fountain' ? cbStone : cbWood;
    cb.xf(c.x, yb, c.z, c.rot);
    if (c.type === 'fountain') fountain(mb, cb, gl, rng);
    else if (c.type === 'stall') stall(mb, cb, gl, rng);
    else if (c.type === 'cart') cart(mb, cb, gl, rng, false);
    else if (c.type === 'barricade') barricade(mb, cb, gl, rng);
    else if (c.type === 'fence') fence(mb, cb, gl, rng, c.w);
    n[c.type]++;
  }
  return n;
}

// ---------------------------------------------------------------- hand-planned buildings
export function specialCfg(b) {
  const t = 0.55, dd = b.d, w = b.w, fH = b.floorH || 2.75, H = b.floors * fH + 0.35;
  const breach = (u) => ({ u0: u - 0.56, u1: u + 0.56, v0: 0, v1: 2.18, door: true });
  const zc = 0.9, uA = dd / 2 - t - zc, uB = zc + dd / 2 - t;      // party-wall breaches (walls 2 / 3)
  // a straight stair against the -x or +x wall, running along z, with its stairwell and landing
  const stair = (x, z0, z1, h, open) => {
    const sg = Math.sign(z1 - z0), zh0 = z0 + sg * 0.75, zh1 = z1 + sg * 0.12;
    return {
      stair: { x, z0, z1, h, w: 0.95, open },
      holes: [[x - 0.62, x + 0.62, Math.min(zh0, zh1), Math.max(zh0, zh1)]],
      solids: [[x - 0.9, x + 0.9, Math.min(z1, z1 + sg * 2.0), Math.max(z1, z1 + sg * 2.0)]],
      keepS: { x, y: h, z: z1, r: 2.3 },
    };
  };
  const withStair = (cfg, s) => ({ ...cfg, stair: s.stair, holes: [...(cfg.holes || []), ...s.holes], solids: [...(cfg.solids || []), ...s.solids], keep: [...(cfg.keep || []), s.keepS] });
  switch (b.special) {
    case 'terraceA': return withStair({ og: 0.03, noPartition: true, openings: { 2: [breach(uA)] }, doors: [{ wall: 1, u: w / 2 - 1.3 }] }, stair(-w / 2 + t + 0.5, dd / 2 - t - 0.3, dd / 2 - t - 0.3 - 4.6, fH, 1));
    case 'terraceB': return { og: 0.03, noPartition: true, openings: { 2: [breach(uA)], 3: [breach(uB)] }, doors: [{ wall: 1, u: w / 2 + 0.6 }] };
    case 'terraceC': return {
      og: 0.03, noPartition: true, openings: { 2: [], 3: [breach(uB)] }, doors: [{ wall: 1, u: w / 2 + 1.6 }],
      ramp: { xb: -w / 2 + t + 0.05, xt: w / 2 - t - 0.85, z0: 1.5, z1: dd / 2 - t - 0.1, h: fH },
      holes: [[-w / 2, w / 2 - t - 0.75, 1.15, dd / 2]], solids: [[w / 2 - t - 1.0, w / 2, 0.4, dd / 2]],
      keep: [{ x: w / 2 - 1.4, y: fH, z: 2.5, r: 2.3 }],
    };
    case 'inn': {
      const ops = [];
      for (const u of [2.0, 4.6, 8.4, 11.0]) ops.push({ u0: u - 0.95, u1: u + 0.95, v0: 0, v1: 2.75, arch: 1, door: true, trim: 0.18 });
      for (const u of [2.0, 11.0]) ops.push({ u0: u - 0.48, u1: u + 0.48, v0: 3.7, v1: 5.0, frame: 1, shutter: 7 });
      for (const u of [4.6, 8.4]) ops.push({ u0: u - 0.55, u1: u + 0.55, v0: 2.8, v1: 4.95, door: true, frame: 1 });
      for (const u of [2.0, 4.6, 8.4, 11.0]) ops.push({ u0: u - 0.45, u1: u + 0.45, v0: 6.45, v1: 7.45, frame: 2, shutter: 11 });
      return withStair({
        tint: [1.13, 1.0, 0.8], partX: 0, burnt: false, openings: { 1: ops },
        blasts: [{ x: w / 2, y: 7.2, z: 2.2, r: 1.7 }, { x: -2, y: H + 0.4, z: dd / 2, r: 1.9 }, { x: -w / 2, y: 4.4, z: 2.6, r: 1.0 }],
        collapse: { x: w / 2 - 1, z: dd / 2 - 1, depth: 0.35, sigma: 2.4 },
        keep: [{ x: 0, y: 3.4, z: -dd / 2, r: 4.3 }],
        extra: (B) => innExtra(B, b),
      }, stair(-w / 2 + t + 0.5, dd / 2 - t - 0.3, dd / 2 - t - 0.3 - 4.6, fH, 1));
    }
    case 'townhall': {
      const L3 = dd - 2 * t, uc = L3 / 2, ops = [{ u0: uc - 0.8, u1: uc + 0.8, v0: 0, v1: 2.9, arch: 1, door: true, trim: 0.2 }];
      for (const u of [1.45, L3 - 1.45]) ops.push({ u0: u - 0.5, u1: u + 0.5, v0: 1.0, v1: 2.5, frame: 2 });
      for (const u of [1.45, uc, L3 - 1.45]) ops.push({ u0: u - 0.5, u1: u + 0.5, v0: fH + 1.0, v1: fH + 2.5, frame: 2, shutter: 3 });
      return withStair({
        tint: [1.12, 1.09, 1.0], partX: -1.0, burnt: false, pitch: 0.42, openings: { 3: ops }, doors: [{ wall: 0, u: w / 2 + 2.5 }],
        blasts: [{ x: w / 2, y: 5.5, z: -1.5, r: 1.6 }, { x: 2, y: 3.0, z: -dd / 2, r: 1.0 }, { x: 3.5, y: H + 0.6, z: dd / 2, r: 1.6 }],
        collapse: { x: w / 2 - 1, z: dd / 2 - 1.5, depth: 0.3, sigma: 2.4 },
        keep: [{ x: -w / 2, y: H + 0.75, z: 0, r: 1.7 }, { x: -w / 2, y: 1.5, z: 0, r: 2.0 }],
        extra: (B) => clock(B.mb, -w / 2 - 0.03, H + 0.78, 0, 0.55),
      }, stair(w / 2 - t - 0.5, -dd / 2 + t + 0.3, -dd / 2 + t + 0.3 + 5.4, fH, -1));
    }
    case 'barn': {
      const L3 = dd - 2 * t, uc = L3 / 2;
      return {
        bare: 0.85, noPartition: true, burnt: false, pitch: 0.55, og: 0.55, oe: 0.7,
        openings: { 3: [{ u0: uc - 1.5, u1: uc + 1.5, v0: 0, v1: 3.3, door: true }, { u0: uc - 0.22, u1: uc + 0.22, v0: 3.95, v1: 4.6 }], 2: [{ u0: 1.5, u1: 2.6, v0: 0, v1: 2.15, door: true }] },
        floorFn: (k, x, z, field) => k === 1 && x > 1.0 && field(x, fH + 0.2, z) < 0.2,
        keep: [{ x: -w / 2, y: 1.8, z: 0, r: 2.7 }],
        blasts: [{ x: 1.5, y: H, z: dd / 2, r: 1.6 }, { x: w / 2, y: 3.5, z: -1.5, r: 1.2 }],
        extra: (B) => {
          const mb = B.mb, xw = -w / 2 - 0.03, za = -dd / 2 + t + uc - 1.5;
          mb.set(LY.wood_planks, [0.88, 0.8, 0.7]);
          obb(mb, B.cb, xw - 0.05, 1.6, za - 0.78, 0.035, 1.55, 0.74, 0, { tile: 2 });
          mb.set(LY.wood_beam, BEAM);
          mb.abox(xw - 0.12, 3.3, -dd / 2 + t + uc - 1.75, xw + 0.04, 3.52, -dd / 2 + t + uc + 1.75, { axis: 'z', tile: 2 });
        },
      };
    }
    case 'corner': return withStair({ partX: 1.2, doors: [{ wall: 1, u: w / 2 + 1.5 }] }, stair(-w / 2 + t + 0.5, dd / 2 - t - 0.3, dd / 2 - t - 0.3 - 4.6, fH, 1));
    default: return b.id === 'terraceD' ? { og: 0.03, openings: { 3: [] } } : {};
  }
}

// clock face on a gable facing -x: plaster dial, stone ring, hour marks, hands
function clock(mb, x, y, z, r) {
  const n = 20;
  mb.set(LY.plaster_old, [1.34, 1.32, 1.25]);
  for (let k = 0; k < n; k++) {
    const a0 = k / n * Math.PI * 2, a1 = (k + 1) / n * Math.PI * 2;
    mb.tri([x - 0.02, y, z], [x - 0.02, y + Math.sin(a0) * r, z + Math.cos(a0) * r], [x - 0.02, y + Math.sin(a1) * r, z + Math.cos(a1) * r], [-1, 0, 0], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]);
  }
  mb.set(LY.stone_blocks, [1.15, 1.13, 1.07]);
  for (let k = 0; k < n; k++) {
    const am = (k + 0.5) / n * Math.PI * 2, rr = r + 0.08, hl = Math.PI * rr / n * 1.08;
    mb.obox([x - 0.03, y + Math.sin(am) * rr, z + Math.cos(am) * rr], [0, Math.cos(am) * hl, -Math.sin(am) * hl], [0, Math.sin(am) * 0.08, Math.cos(am) * 0.08], [0.05, 0, 0], { tile: 2, uo: k * 0.3 });
  }
  mb.set(LY.wood_charred, CHAR);
  for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; mb.abox(x - 0.05, y + Math.sin(a) * r * 0.86 - 0.025, z + Math.cos(a) * r * 0.86 - 0.025, x - 0.03, y + Math.sin(a) * r * 0.86 + 0.025, z + Math.cos(a) * r * 0.86 + 0.025); }
  // stopped at twenty to five
  mb.beam([x - 0.06, y, z], [x - 0.06, y - r * 0.45, z + r * 0.22], 0.05, 0.02);
  mb.beam([x - 0.07, y, z], [x - 0.07, y + r * 0.42, z - r * 0.62], 0.035, 0.02);
}

function innExtra(B, b) {
  const mb = B.mb, cb = B.cb, dd = b.d, fH = b.floorH || 2.75, z0 = -dd / 2, zo = z0 - 1.15, y = fH, rng = new RNG(b.seed + 3);
  // balcony deck on cantilevered joists with struts, posts, rails, balusters
  mb.set(LY.wood_planks, [1.0, 0.92, 0.82]);
  mb.abox(-3.4, y - 0.07, zo, 3.4, y + 0.02, z0 + 0.03, { axis: 'x', tile: 2 });
  if (cb) cb.box(-3.4, y - 0.07, zo, 3.4, y + 0.02, z0 + 0.2);
  mb.set(LY.wood_beam, BEAM);
  for (const x of [-3.25, -1.08, 1.08, 3.25]) { mb.beam([x, y - 0.14, z0 + 0.1], [x, y - 0.14, zo + 0.05], 0.13, 0.15); mb.beam([x, y - 1.05, z0 + 0.04], [x, y - 0.2, zo + 0.25], 0.11, 0.11); }
  for (let k = 0; k <= 6; k++) { const x = -3.35 + k * 6.7 / 6; mb.abox(x - 0.05, y, zo, x + 0.05, y + 1.05, zo + 0.1, { axis: 'y', tile: 2 }); }
  mb.abox(-3.42, y + 0.97, zo - 0.01, 3.42, y + 1.06, zo + 0.11, { axis: 'x', tile: 2 });
  mb.abox(-3.4, y + 0.12, zo + 0.02, 3.4, y + 0.18, zo + 0.08, { axis: 'x', tile: 2 });
  for (const x of [-3.4, 3.4]) { mb.abox(x - 0.05, y + 0.97, zo, x + 0.05, y + 1.06, z0, { axis: 'z', tile: 2 }); mb.abox(x - 0.04, y + 0.12, zo, x + 0.04, y + 0.18, z0, { axis: 'z', tile: 2 }); }
  mb.set(LY.wood_planks, [0.95, 0.88, 0.78]);
  for (let x = -3.2; x < 3.25; x += 0.2) if (!(x > 0.6 && x < 1.4 && rng.chance(0.7))) mb.abox(x - 0.025, y + 0.18, zo + 0.03, x + 0.025, y + 0.97, zo + 0.07, { axis: 'y', tile: 2, skip: 3 });
  if (cb) { cb.box(-3.45, y, zo - 0.01, 3.45, y + 1.06, zo + 0.11); cb.box(-3.45, y, zo, -3.35, y + 1.06, z0); cb.box(3.35, y, zo, 3.45, y + 1.06, z0); }
  // hanging sign on a wrought bracket at the corner
  const xs = b.w / 2 - 0.75, ys = 3.15;
  mb.set(LY.wood_charred, CHAR);
  mb.beam([xs, ys, z0], [xs, ys, z0 - 1.05], 0.05, 0.05);
  mb.beam([xs, ys - 0.5, z0], [xs, ys, z0 - 0.7], 0.035, 0.035);
  for (const zz of [-0.32, -0.92]) mb.beam([xs, ys, z0 + zz], [xs, ys - 0.2, z0 + zz], 0.015, 0.015);
  mb.set(LY.wood_planks, [1.05, 0.85, 0.6]);
  mb.abox(xs - 0.03, ys - 0.75, z0 - 0.98, xs + 0.03, ys - 0.2, z0 - 0.26, { axis: 'z', tile: 2 });
}
