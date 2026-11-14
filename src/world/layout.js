// World layout for Valle Morta. Pure data + math (no three.js) so that the
// offline terrain baker and the runtime agree on every river bend, road,
// building plot and shell crater.
//
// Axes: +X east, +Z south, +Y up. The valley is looked at from the southern
// meadow towards the north, where the twin peaks stand.

import { Noise, RNG, smoothstep, clamp, saturate, mix } from '../core/noise.js';

export const WORLD = {
  size: 1024,          // local detailed terrain covers [-512, 512]^2
  half: 512,
  playRadius: 330,     // soft boundary for the player
  playCenter: [20, -20],
  farSize: 28672,      // far terrain extent (m)
  seed: 20261,
};

// ---------------------------------------------------------------- paths
function catmullRom(ctrl, perSeg) {
  const pts = [];
  const n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(n - 1, i + 2)];
    for (let j = 0; j < perSeg; j++) {
      const t = j / perSeg, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const z = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      pts.push([x, z]);
    }
  }
  pts.push(ctrl[n - 1].slice());
  return pts;
}

export class Path {
  constructor(ctrl, perSeg = 20) {
    this.ctrl = ctrl;
    this.pts = catmullRom(ctrl, perSeg);
    const n = this.pts.length;
    this.cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(this.pts[i][0] - this.pts[i - 1][0], this.pts[i][1] - this.pts[i - 1][1]);
    }
    this.length = this.cum[n - 1];
    this.bb = [1e9, 1e9, -1e9, -1e9];
    for (const p of this.pts) {
      this.bb[0] = Math.min(this.bb[0], p[0]); this.bb[1] = Math.min(this.bb[1], p[1]);
      this.bb[2] = Math.max(this.bb[2], p[0]); this.bb[3] = Math.max(this.bb[3], p[1]);
    }
    // exact nearest-segment acceleration grid
    this.g0 = -720; this.gs = 24; this.gn = 60;
    this.cells = new Array(this.gn * this.gn);
    const diag = this.gs * 0.7072;
    for (let cz = 0; cz < this.gn; cz++) {
      for (let cx = 0; cx < this.gn; cx++) {
        const mx = this.g0 + (cx + 0.5) * this.gs, mz = this.g0 + (cz + 0.5) * this.gs;
        let best = 1e18;
        const ds = new Float64Array(n - 1);
        for (let i = 0; i < n - 1; i++) {
          ds[i] = this._segDist(i, mx, mz, null);
          if (ds[i] < best) best = ds[i];
        }
        const lim = best + 2 * diag + 0.01;
        const list = [];
        for (let i = 0; i < n - 1; i++) if (ds[i] <= lim) list.push(i);
        this.cells[cz * this.gn + cx] = list;
      }
    }
  }

  _segDist(i, x, z, out) {
    const a = this.pts[i], b = this.pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + dx * t, pz = a[1] + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (out) {
      out.d = d;
      out.s = this.cum[i] + Math.sqrt(l2) * t;
      out.side = (dx * (z - a[1]) - dz * (x - a[0])) >= 0 ? 1 : -1; // +1 = right of flow direction
      out.px = px; out.pz = pz;
      const l = Math.sqrt(l2) || 1;
      out.tx = dx / l; out.tz = dz / l;
    }
    return d;
  }

  // nearest point query -> {d, s, side, px, pz, tx, tz}
  query(x, z, out = {}) {
    const cx = Math.floor((x - this.g0) / this.gs), cz = Math.floor((z - this.g0) / this.gs);
    let best = 1e18, bi = 0;
    if (cx >= 0 && cz >= 0 && cx < this.gn && cz < this.gn) {
      const list = this.cells[cz * this.gn + cx];
      for (let k = 0; k < list.length; k++) {
        const d = this._segDist(list[k], x, z, null);
        if (d < best) { best = d; bi = list[k]; }
      }
    } else {
      // far outside: everything that depends on this distance has saturated
      if (x < this.bb[0] - 700 || x > this.bb[2] + 700 || z < this.bb[1] - 700 || z > this.bb[3] + 700) {
        out.d = 1e4; out.s = 0; out.side = 1; out.px = x; out.pz = z; out.tx = 1; out.tz = 0;
        return out;
      }
      for (let i = 0; i < this.pts.length - 1; i++) {
        const d = this._segDist(i, x, z, null);
        if (d < best) { best = d; bi = i; }
      }
    }
    this._segDist(bi, x, z, out);
    return out;
  }

  // point at arclength s -> [x, z, tx, tz]
  at(s) {
    s = clamp(s, 0, this.length);
    let lo = 0, hi = this.pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const a = this.pts[lo], b = this.pts[hi];
    const l = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / l;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / l, (b[1] - a[1]) / l];
  }
}

// ---------------------------------------------------------------- helpers
function obbCorners(b, grow = 0) {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const hw = b.w / 2 + grow, hd = b.d / 2 + grow;
  // local +X -> (c, s) in world xz, local +Z -> (-s, c)
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [b.x + lx * c - lz * s, b.z + lx * s + lz * c]);
}
function obbOverlap(a, b, grow = 0) {
  const A = obbCorners(a, grow), B = obbCorners(b, grow);
  for (const poly of [A, B]) {
    for (let i = 0; i < 2; i++) {
      const p = poly[i], q = poly[i + 1];
      const nx = q[1] - p[1], nz = -(q[0] - p[0]);
      let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
      for (const v of A) { const d = v[0] * nx + v[1] * nz; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const v of B) { const d = v[0] * nx + v[1] * nz; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}
// signed-ish distance from point to building footprint (negative inside)
export function footprintDist(b, x, z) {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const dx = x - b.x, dz = z - b.z;
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  const qx = Math.abs(lx) - b.w / 2, qz = Math.abs(lz) - b.d / 2;
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0);
}

// ---------------------------------------------------------------- layout
export function createLayout() {
  const noise = new Noise(WORLD.seed);
  const noiseB = new Noise(WORLD.seed + 77);
  const rng = new RNG(WORLD.seed + 5);

  // River: enters from the north-west, bends under the bridge, then runs east
  // between the southern meadow and the village.
  const river = new Path([
    [-2300, -4300], [-1500, -2900], [-900, -1800], [-560, -1100],
    [-380, -700], [-330, -560], [-290, -430], [-235, -310], [-175, -200], [-125, -110],
    [-94, -40], [-72, 14], [-36, 52], [28, 70], [108, 68], [200, 84], [300, 118], [420, 168], [600, 232], [760, 280],
    [1050, 400], [1500, 640], [2200, 1000], [3200, 1600],
  ], 22);
  const bridgeQ = river.query(-81, -12);
  const sBridge = bridgeQ.s;
  const bridge = {
    x: bridgeQ.px, z: bridgeQ.pz,
    // deck direction = perpendicular to the flow
    dirx: bridgeQ.tz, dirz: -bridgeQ.tx,
    length: 58, width: 5.2, deckY: 0,
  };
  if (bridge.dirx < 0) { bridge.dirx *= -1; bridge.dirz *= -1; } // points towards the village (east)
  bridge.rot = Math.atan2(bridge.dirz, bridge.dirx);
  const bEast = [bridge.x + bridge.dirx * bridge.length / 2, bridge.z + bridge.dirz * bridge.length / 2];
  const bWest = [bridge.x - bridge.dirx * bridge.length / 2, bridge.z - bridge.dirz * bridge.length / 2];

  // Road: meadow track -> bridge -> along the southern edge of the village
  // (the wrecked tank sits on it) -> up the eastern hill to the watchtower.
  const roadWest = new Path([
    [-230, 150], [-185, 110], [-150, 62], [-128, 24], [bWest[0] - bridge.dirx * 14, bWest[1] - bridge.dirz * 14], [bWest[0] + bridge.dirx * 2, bWest[1] + bridge.dirz * 2],
  ], 16);
  const roadEast = new Path([
    [bEast[0] - bridge.dirx * 2, bEast[1] - bridge.dirz * 2], [bEast[0] + bridge.dirx * 14, bEast[1] + bridge.dirz * 14],
    [-8, -30], [30, -24], [76, -16], [122, -12], [165, -16], [205, -32], [238, -58], [262, -88], [300, -100], [352, -92], [420, -110],
  ], 16);
  // village streets (cobbled)
  const streets = [
    new Path([[-8, -30], [8, -46], [22, -64], [34, -80], [40, -90]], 10),            // main street up to the church square
    new Path([[40, -90], [66, -72], [92, -62], [112, -46], [122, -12]], 10),         // east street back down to the road
    new Path([[40, -90], [30, -110], [34, -134], [48, -156]], 10),                   // north lane
    new Path([[58, -18], [60, -44], [66, -72]], 10),                                 // short lane from the road
  ];

  const tank = { x: 121, z: -11.5, rot: -0.22 };
  const tower = { x: 262, z: -62 };       // wooden watchtower on the hill spur
  const church = { kind: 'church', x: 70, z: -103, rot: 0.06, w: 25, d: 11.5, towerSize: 5.6 };
  church.towerX = church.x - Math.cos(church.rot) * (church.w / 2 + 1.4) + Math.sin(church.rot) * (-(church.d / 2 - 2.2));
  church.towerZ = church.z - Math.sin(church.rot) * (church.w / 2 + 1.4) - Math.cos(church.rot) * (-(church.d / 2 - 2.2));

  const waterLevel = (s) => -0.0052 * (s - sBridge);
  const planeLevel = (x, z) => -0.0052 * ((x - bridge.x) * 0.735 + (z - bridge.z) * 0.678);
  const riverHalfWidth = (s) => 10.5 + 3.2 * noise.n2(s * 0.011, 3.7) + 1.6 * noise.n2(s * 0.045, 9.1);

  // ------------------------------------------------------------ buildings
  const buildings = [];
  const mkHouse = (x, z, rot, w, d, floors, damage, extra = {}) => ({
    kind: 'house', x, z, rot, w, d, floors, floorH: 2.75, damage, seed: Math.floor(rng.f() * 1e9), ...extra,
  });
  // Hand placed hero buildings
  const churchBody = { ...church, id: 'church', floors: 1, damage: 0.25, seed: 4242 };
  buildings.push(churchBody);
  // the ruin in the meadow whose broken wall frames the first reference image
  buildings.push(mkHouse(-108, 92, 0.35, 9.5, 7.5, 2, 0.93, { id: 'meadowRuin', hero: true }));
  // the look-out house at the south-west corner of the village (interior shot)
  buildings.push(mkHouse(-6, -52, 0.92, 10.5, 8, 3, 0.45, { id: 'lookout', hero: true, enterable: true }));
  // lone farm ruin on the eastern slope
  buildings.push(mkHouse(196, -96, -0.3, 10, 7.5, 2, 0.8, { id: 'slopeRuin' }));
  buildings.push(mkHouse(168, -58, 0.2, 7, 6, 1, 0.75, { id: 'slopeShed' }));

  // the church square stays open: nothing within ~12 m of its centre
  const SQ = { x: 44, z: -92, r: 12 };
  const siteOk = (b, grow = 0.8, streetD = 2.2, skip = null) => {
    for (const o of buildings) if (o !== skip && obbOverlap(b, o, grow)) return false;
    if (footprintDist(b, SQ.x, SQ.z) < SQ.r) return false;
    if (footprintDist(b, 15, -55) < 2.6) return false;          // survival start
    // keep streets and the road clear
    const q = {};
    for (const p of [...streets, roadEast]) {
      const cs = obbCorners(b, 0.2);
      for (const c of [...cs, [b.x, b.z]]) { if (p.query(c[0], c[1], q).d < streetD) return false; }
      // sample edges
      for (let i = 0; i < 4; i++) {
        const a = cs[i], c2 = cs[(i + 1) % 4];
        for (let t = 0.125; t < 1; t += 0.125) {
          if (p.query(a[0] + (c2[0] - a[0]) * t, a[1] + (c2[1] - a[1]) * t, q).d < streetD) return false;
        }
      }
    }
    if (river.query(b.x, b.z, q).d < 26) return false;
    return true;
  };
  const tryPlace = (b) => {
    if (!siteOk(b)) return false;
    buildings.push(b);
    return true;
  };

  // ---- hand-planned town core (placed before the random fill so the fill packs around it).
  // Frontage helper: a house on street `si` at arclength s, side +-1, front wall (local -z,
  // wall 1) facing the street at `front` metres from the centreline. With `gable` the
  // building turns end-on: local +x points away from the street and the gable (wall 3) faces it.
  let seedK = 9100;
  const frontage = (si, s, side, w, d, floors, damage, extra = {}, o = {}) => {
    const st = streets[si];
    for (const ds of [0, 1.5, -1.5, 3, -3, 4.5, -4.5]) {
      const [px, pz, tx, tz] = st.at(s + ds);
      const nx = -tz * side, nz = tx * side, front = o.front || 2.9;
      const depth = o.gable ? w : d, rot = o.gable ? Math.atan2(nz, nx) : Math.atan2(tz, tx) + (side < 0 ? Math.PI : 0);
      const b = { kind: 'house', x: px + nx * (front + depth / 2), z: pz + nz * (front + depth / 2), rot, w, d, floors, floorH: 2.75, damage, seed: seedK++ * 7919, ...extra };
      if (siteOk(b, 0.4, 2.6)) { buildings.push(b); return b; }
    }
    return null;
  };
  // terrace of narrow houses sharing party walls (0.06 m apart), along a straight line
  const terrace = (si, s, side, ws, d, floorsList, dmg, extras) => {
    const st = streets[si], total = ws.reduce((a, b) => a + b, 0) + 0.06 * (ws.length - 1);
    for (const ds of [0, 2, -2, 4, -4, 6]) {
      const [px, pz, tx, tz] = st.at(s + ds + total / 2);
      const nx = -tz * side, nz = tx * side, rot = Math.atan2(tz, tx) + (side < 0 ? Math.PI : 0);
      const ux = Math.cos(rot), uz = Math.sin(rot);
      let off = -total / 2;
      const row = ws.map((w, i) => {
        const c = off + w / 2; off += w + 0.06;
        return { kind: 'house', x: px + nx * (3.0 + d / 2) + ux * c, z: pz + nz * (3.0 + d / 2) + uz * c, rot, w, d, floors: floorsList[i], floorH: 2.75, damage: dmg[i], seed: seedK++ * 7919, terrace: true, ...(extras[i] || {}) };
      });
      if (row.every((b) => siteOk(b, 0.4, 2.6))) { buildings.push(...row); return row; }
    }
    return [];
  };
  // inn with a ground-floor arcade and a timber balcony, on the square's south side
  frontage(1, 15, 1, 13, 9.5, 3, 0.34, { id: 'inn', enterable: true, special: 'inn' });
  // town hall / school: gable with the clock towards the north lane, opposite the church
  frontage(2, 13, -1, 12, 9, 2, 0.4, { id: 'townhall', enterable: true, special: 'townhall', floorH: 3.3 }, { gable: true });
  // stone barn with a cart doorway in its gable, on the short lane
  frontage(3, 13, 1, 11, 8.2, 1, 0.5, { id: 'barn', enterable: true, special: 'barn', floorH: 4.2 }, { gable: true });
  // row of narrow terraced houses on the main street, knocked through at ground level
  terrace(0, 31, -1, [6.4, 5.4, 7.8, 5.8], 8.6, [3, 3, 2, 3], [0.38, 0.45, 0.5, 0.7],
    [{ id: 'terraceA', enterable: true, special: 'terraceA' }, { id: 'terraceB', enterable: true, special: 'terraceB' }, { id: 'terraceC', enterable: true, special: 'terraceC' }, { id: 'terraceD' }]);
  // corner house on the east street: enterable, stairs, overlooking the lane junction
  for (const s of [33, 40, 26, 47, 20]) if (frontage(1, s, -1, 9.4, 8.2, 2, 0.42, { id: 'corner', enterable: true, special: 'corner' })) break;
  // houses lining the streets
  streets.forEach((st, si) => {
    for (const side of [-1, 1]) {
      let s = 4 + rng.range(0, 4);
      while (s < st.length - 3) {
        const w = rng.range(7.5, 12.5), d = rng.range(6.5, 9.5);
        const [px, pz, tx, tz] = st.at(s + w / 2);
        const setback = 2.7 + rng.range(0, 0.9) + d / 2;
        // normal to the street
        const nx = -tz * side, nz = tx * side;
        const b = mkHouse(px + nx * setback, pz + nz * setback, Math.atan2(tz, tx) + rng.range(-0.06, 0.06), w, d,
          rng.chance(0.35) ? 3 : 2, clamp(rng.range(0.25, 0.8) + (si === 0 ? -0.05 : 0.05), 0.2, 0.85));
        if (rng.chance(0.93) && siteOk(b, 0.35, 2.5)) buildings.push(b);
        s += w + rng.range(0.3, 1.8);
      }
    }
  });
  // a second row / scattered outbuildings to thicken the silhouette
  for (let i = 0; i < 60; i++) {
    const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.f()) * 78;
    const x = 52 + Math.cos(a) * r * 1.15, z = -92 + Math.sin(a) * r * 0.85;
    const b = mkHouse(x, z, rng.range(-0.5, 0.5) + (rng.chance(0.5) ? Math.PI / 2 : 0), rng.range(6.5, 11), rng.range(6, 8.5), rng.chance(0.25) ? 3 : 2, rng.range(0.3, 0.9));
    tryPlace(b);
  }
  // infill: close the street fronts, leaving only a few bomb gaps
  {
    const rf = new RNG(WORLD.seed + 919);
    let added = 0;
    const order = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1], [3, 1], [3, -1]];
    for (const [si, side] of order) {
      const st = streets[si];
      let s = 3;
      while (s < st.length - 5 && added < 16) {
        const w0 = rf.range(6.2, 9.5), d = rf.range(7, 9.2), floors = rf.chance(0.4) ? 3 : 2, damage = rf.range(0.3, 0.85), seed = Math.floor(rf.f() * 1e9), jr = rf.range(-0.04, 0.04);
        let ok = null;
        for (const w of [w0, 6.0, 5.0]) {
          const [px, pz, tx, tz] = st.at(s + w / 2);
          const nx = -tz * side, nz = tx * side;
          for (const dd of [d, 6.4]) {
            const setback = 2.8 + dd / 2;
            const b = { kind: 'house', x: px + nx * setback, z: pz + nz * setback, rot: Math.atan2(tz, tx) + (side < 0 ? Math.PI : 0) + jr, w, d: dd, floors, floorH: 2.75, damage, seed, infill: true };
            if (siteOk(b, 0.3, 2.6)) { ok = b; break; }
          }
          if (ok) break;
        }
        if (ok) { buildings.push(ok); added++; s += ok.w + rf.range(0.4, 1.2) + (rf.chance(0.12) ? rf.range(5, 8) : 0); } else s += 1;
      }
    }
  }
  buildings.forEach((b, i) => { if (!b.id) b.id = 'house' + i; });

  // ------------------------------------------------------------ base height
  const q0 = {}, q1 = {};
  function baseHeight(x, z) {
    const q = river.query(x, z, q0);
    const d = q.d;
    const lvl = mix(waterLevel(q.s), planeLevel(x, z), smoothstep(180, 420, d));
    const hw = riverHalfWidth(q.s);
    // flood plain rising gently away from the banks, then a broad U-shaped valley
    const fp = Math.max(0, d - hw - 4);
    let h = lvl + 1.15 + 1.9 * (1 - Math.exp(-fp / 55)) + 0.00030 * Math.pow(clamp(d - 150, 0, 480), 2);
    // broad undulation of the meadow
    h += 1.3 * noise.fbm2(x * 0.0085, z * 0.0085, 3) + 0.35 * noise.fbm2(x * 0.031 + 40, z * 0.031, 3);
    // village mound
    h += 4.2 * Math.exp(-((x - 52) * (x - 52) + (z + 92) * (z + 92)) / (2 * 74 * 74));
    // knoll with the ruined wall in the south-west meadow
    h += 3.4 * Math.exp(-((x + 108) * (x + 108) + (z - 94) * (z - 94)) / (2 * 30 * 30));
    // eastern hill carrying the forest and the watchtower
    const warp = 46 * noise.fbm2(x * 0.0042 + 9, z * 0.0042 - 4, 3);
    const e = saturate((x - 132 + 0.22 * (z + 40) + warp) / 360);
    const eh = e * e * (3 - 2 * e);
    h += 118 * Math.pow(eh, 1.25) + 14 * eh * noise.fbm2(x * 0.011, z * 0.011 + 70, 4) + 5.5 * eh * noiseB.ridged2(x * 0.02, z * 0.02, 3);
    // spur under the watchtower
    h += 9 * Math.exp(-((x - tower.x) * (x - tower.x) + (z - tower.z) * (z - tower.z)) / (2 * 34 * 34));
    // western slope beyond the river
    const wsl = saturate((-x - 250 + 0.3 * (z + 100) + warp) / 380);
    h += 90 * wsl * wsl + 8 * wsl * noise.fbm2(x * 0.012 + 5, z * 0.012, 4);
    // southern rise that closes the meadow
    const ssl = saturate((z - 250) / 380);
    h += 46 * ssl * ssl;
    return h;
  }

  buildings.forEach((b) => {
    // pad level: lowest corner so that the uphill side digs in slightly
    const cs = obbCorners(b, 0);
    let lo = 1e9, hi = -1e9;
    for (const c of [...cs, [b.x, b.z]]) { const h = baseHeight(c[0], c[1]); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    b.baseY = lo * 0.65 + hi * 0.35;
  });
  church.baseY = churchBody.baseY;

  // road profile (low-pass of the base terrain along the centreline)
  function roadProfile(path) {
    const n = Math.ceil(path.length / 2) + 1;
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = path.at(i * 2); raw[i] = baseHeight(p[0], p[1]); }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, w = 0;
      for (let k = -6; k <= 6; k++) { const j = clamp(i + k, 0, n - 1); const ww = 1 - Math.abs(k) / 7; s += raw[j] * ww; w += ww; }
      out[i] = s / w;
    }
    return (s) => { const f = clamp(s / 2, 0, n - 1.001); const i = Math.floor(f); return mix(out[i], out[i + 1], f - i); };
  }
  const roads = [roadWest, roadEast].map((p) => ({ path: p, prof: roadProfile(p), halfWidth: 2.5 }));
  const streetRoads = streets.map((p) => ({ path: p, prof: roadProfile(p), halfWidth: 2.3, street: true }));
  const allRoads = [...roads, ...streetRoads];
  bridge.deckY = Math.max(roads[0].prof(roadWest.length), roads[1].prof(0)) + 2.6;
  bridge.westY = roads[0].prof(roadWest.length);
  bridge.eastY = roads[1].prof(0);

  // ------------------------------------------------------------ craters
  const craters = [];
  const craterOk = (x, z, r) => {
    const q = {};
    if (river.query(x, z, q).d < riverHalfWidth(q.s) + r + 5) return false;
    for (const b of buildings) if (footprintDist(b, x, z) < r + 2.5) return false;
    for (const c of craters) if (Math.hypot(c.x - x, c.z - z) < (c.r + r) * 1.15) return false;
    if (Math.hypot(x - tank.x, z - tank.z) < r + 7) return false;
    return true;
  };
  const addCraters = (count, cx, cz, rx, rz, rmin, rmax) => {
    let tries = 0;
    while (count > 0 && tries++ < 4000) {
      const a = rng.range(0, Math.PI * 2), rr = Math.sqrt(rng.f());
      const x = cx + Math.cos(a) * rr * rx, z = cz + Math.sin(a) * rr * rz;
      const r = rmin + (rmax - rmin) * Math.pow(rng.f(), 2.2);
      if (!craterOk(x, z, r)) continue;
      const onRoad = allRoads.some((rd) => rd.path.query(x, z, {}).d < r + 1.5);
      if (onRoad && rng.chance(0.75)) continue;
      craters.push({ x, z, r, depth: r * rng.range(0.26, 0.36), rim: r * rng.range(0.06, 0.1), water: rng.chance(r > 2.6 ? 0.75 : 0.3), seed: rng.f() * 1000 });
      count--;
    }
  };
  addCraters(34, -20, 135, 190, 80, 1.5, 5.2);   // southern meadow
  addCraters(26, 120, 10, 130, 45, 1.4, 4.8);    // between road and river, around the tank
  addCraters(22, 50, -90, 130, 95, 1.3, 4.2);    // in and around the village
  addCraters(14, 220, -90, 70, 70, 1.5, 4.0);    // slope below the watchtower
  addCraters(8, -170, 30, 60, 80, 1.6, 4.5);     // west bank

  // ------------------------------------------------------------ street cover & furniture
  // Oriented footprints { type, x, z, rot, w (along local x), d } in the same convention as
  // buildings. Placed along the street edges (a >= 3.8 m lane stays open), in bomb gaps and
  // around the square; never on a building, crater, the square's centre or the start point.
  const cover = [];
  {
    const rc = new RNG(WORLD.seed + 4321), q = {};
    const coverOk = (c, sqR = 12.5, minD = 1.9) => {
      const pts = [...obbCorners(c, 0), [c.x, c.z]];
      for (const b of buildings) { if (Math.abs(b.x - c.x) > 30 || Math.abs(b.z - c.z) > 30) continue; if (obbOverlap(c, b, 0.04)) return false; }
      for (const o of cover) if (obbOverlap(c, o, 0.3)) return false;
      for (const p of pts) {
        if (Math.hypot(p[0] - SQ.x, p[1] - SQ.z) < sqR) return false;
        if (Math.hypot(p[0] - 15, p[1] + 55) < 3.5) return false;
        for (const st of streets) if (st.query(p[0], p[1], q).d < minD) return false;
        if (roadEast.query(p[0], p[1], q).d < 3.6) return false;
        for (const cr of craters) if (Math.hypot(p[0] - cr.x, p[1] - cr.z) < cr.r * 1.3 + 0.3) return false;
        if (river.query(p[0], p[1], q).d < 24) return false;
      }
      if (Math.hypot(c.x - tank.x, c.z - tank.z) < 9) return false;
      if (Math.hypot(c.x - church.towerX, c.z - church.towerZ) < 6) return false;
      return true;
    };
    const SIZE = { bags: [3.2, 0.72], barrels: [1.5, 1.3], crates: [2.0, 1.0], cart: [3.0, 1.45], barricade: [3.4, 1.2], truck: [5.9, 2.1], lamp: [0.45, 0.45], fence: [5.5, 0.3], stall: [2.6, 1.7] };
    const along = (type, si, s, side, offs, extra = {}) => {
      const st = streets[si], [w, d] = SIZE[type];
      for (const ds of [0, 1.2, -1.2, 2.4, -2.4]) for (const o of offs) {
        if (s + ds < 2 || s + ds > st.length - 2) continue;
        const [px, pz, tx, tz] = st.at(s + ds), off = o + d / 2;
        const c = { type, x: px - tz * side * off, z: pz + tx * side * off, rot: Math.atan2(tz, tx) + (side < 0 ? Math.PI : 0) + (extra.jr ? rc.range(-extra.jr, extra.jr) : 0), w, d, seed: Math.floor(rc.f() * 1e6) };
        if (coverOk(c, extra.sqR, extra.minD)) { cover.push(c); return c; }
      }
      return null;
    };
    const cycles = [
      ['bags', 'barrels', 'barricade', 'crates', 'cart', 'bags', 'crates'],
      ['truck', 'bags', 'crates', 'barrels', 'cart', 'barricade', 'bags'],
      ['cart', 'barrels', 'bags', 'crates', 'barricade'],
      ['barricade', 'crates', 'truck', 'barrels', 'bags'],
    ];
    let trucks = 0;
    streets.forEach((st, si) => {
      let s = 4 + si * 1.7, k = 0, side = si % 2 ? 1 : -1;
      while (s < st.length - 3) {
        let type = cycles[si][k % cycles[si].length];
        if (type === 'truck' && trucks >= 2) type = 'crates';
        const c = along(type, si, s, side, type === 'truck' ? [2.0, 2.4] : [1.95, 2.2, 2.6, 3.2], { jr: type === 'bags' || type === 'truck' ? 0.05 : 0.25 });
        if (c) { if (type === 'truck') trucks++; k++; side = -side; s += rc.range(6, 10); } else s += 2;
      }
      // lamp posts on the street edge, roughly every 22 m, alternating sides
      for (let s2 = 9, sd = 1; s2 < st.length - 3; s2 += 30, sd = -sd) along('lamp', si, s2, sd, [2.0, 2.3], { minD: 1.9 });
      // timber garden fences on the frontage line where a house is missing
      for (let s2 = 6; s2 < st.length - 6; s2 += 2) for (const sd of [-1, 1]) if (cover.filter((c) => c.type === 'fence').length < 3 * (si + 1) && rc.chance(0.5) && along('fence', si, s2, sd, [3.1], { minD: 2.6, jr: 0.03 })) s2 += 6;
    });
    // around the church square: a dry fountain off to the north-west, a few market stall frames, lamps
    for (const [x, z] of [[47.5, -103.8], [46.5, -105], [33, -101]]) { const c = { type: 'fountain', x, z, rot: 0.3, w: 3.1, d: 3.1, seed: 7 }; if (coverOk(c, 11)) { cover.push(c); break; } }
    for (let a = 0; a < 6.283; a += 0.26) {
      if (cover.filter((c) => c.type === 'stall').length >= 4) break;
      const r = 13.2, x = SQ.x + Math.cos(a) * r, z = SQ.z + Math.sin(a) * r;
      const c = { type: 'stall', x, z, rot: a + Math.PI / 2, w: 2.6, d: 1.7, seed: Math.floor(rc.f() * 1e6) };
      if (coverOk(c, 11.2, 2.6)) cover.push(c);
    }
    for (const a of [0.9, 2.6, 4.2, 5.6]) { const x = SQ.x + Math.cos(a) * 12.2, z = SQ.z + Math.sin(a) * 12.2, c = { type: 'lamp', x, z, rot: a, w: 0.45, d: 0.45, seed: 1 }; if (coverOk(c, 11, 2.2)) cover.push(c); }
  }

  // ------------------------------------------------------------ final height
  // Returns terrain height; if `m` is given, also fills surface masks.
  function designHeight(x, z, m) {
    const bh = baseHeight(x, z);
    let h = bh;
    const q = river.query(x, z, q0);
    const hw = riverHalfWidth(q.s);
    const wl = waterLevel(q.s);
    // small-scale relief
    const micro = 0.16 * noise.fbm2(x * 0.11, z * 0.11, 3) + 0.045 * noiseB.fbm2(x * 0.47, z * 0.47, 2);
    let microK = 1;
    let road = 0, cobble = 0, mud = 0, rubble = 0, bed = 0, wet = 0;

    // roads & streets
    for (const rd of allRoads) {
      const bb = rd.path.bb;
      if (x < bb[0] - 9 || x > bb[2] + 9 || z < bb[1] - 9 || z > bb[3] + 9) continue;
      const rq = rd.path.query(x, z, q1);
      if (rq.d > rd.halfWidth + 5) continue;
      const k = smoothstep(rd.halfWidth + 3.2, rd.halfWidth - 0.4, rq.d);
      let target = rd.prof(rq.s) - 0.06;
      // crown + wheel ruts on the dirt road
      const lat = rq.d;
      if (!rd.street) {
        const rut = Math.exp(-Math.pow((lat - 0.95) / 0.28, 2));
        target -= 0.07 * rut * (0.6 + 0.4 * noise.n2(rq.s * 0.15, 2.2));
        wet = Math.max(wet, rut * k * saturate(0.25 + 1.6 * noise.n2(rq.s * 0.045, 7.7)));
      }
      h = mix(h, target, k);
      microK = Math.min(microK, 1 - 0.75 * k);
      const edge = smoothstep(rd.halfWidth + 0.9, rd.halfWidth - 0.7, rq.d + 0.8 * noise.n2(x * 0.22, z * 0.22));
      if (rd.street) cobble = Math.max(cobble, edge); else road = Math.max(road, edge);
    }
    // church square
    {
      const dsq = Math.hypot(x - 44, z + 92);
      const k = smoothstep(17, 11, dsq + 2 * noise.n2(x * 0.15, z * 0.15));
      cobble = Math.max(cobble, k);
      microK = Math.min(microK, 1 - 0.7 * k);
    }

    // building pads + rubble aprons
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (Math.abs(x - b.x) > 30 || Math.abs(z - b.z) > 30) continue;
      const fd = footprintDist(b, x, z);
      if (fd < 7) {
        const k = smoothstep(4.2, 0.4, fd);
        h = mix(h, b.baseY, k);
        microK = Math.min(microK, 1 - 0.8 * k);
        const apron = smoothstep(2.2 + 4.2 * b.damage, 0.0, fd + 1.4 * noise.n2(x * 0.3 + i, z * 0.3));
        rubble = Math.max(rubble, apron * (0.35 + 0.65 * b.damage));
        // collapsed-wall debris cones against the outside of heavily damaged buildings
        if (fd > -0.6) h += b.damage * 0.55 * smoothstep(3.0, 0.2, fd) * saturate(0.4 + noise.n2(x * 0.21 + i * 3, z * 0.21));
      }
    }

    // craters
    for (let i = 0; i < craters.length; i++) {
      const c = craters[i];
      const dx = x - c.x, dz = z - c.z;
      const lim = c.r * 2.1;
      if (Math.abs(dx) > lim || Math.abs(dz) > lim) continue;
      const ang = Math.atan2(dz, dx);
      const wob = 1 + 0.13 * Math.sin(ang * 3 + c.seed) + 0.07 * Math.sin(ang * 7 + c.seed * 2.3);
      const t = Math.hypot(dx, dz) / (c.r * wob);
      if (t > 2.1) continue;
      const bowl = t < 1 ? -c.depth * Math.pow(1 - t * t, 1.35) : 0;
      const rim = c.rim * Math.exp(-Math.pow((t - 1.06) / 0.3, 2));
      h += bowl + rim;
      microK = Math.min(microK, 0.5 + 0.5 * saturate(t - 0.6));
      mud = Math.max(mud, smoothstep(1.55, 0.85, t + 0.25 * noise.n2(x * 0.5, z * 0.5)));
      if (c.water) wet = Math.max(wet, smoothstep(0.62, 0.38, t));
    }

    // trampled bare earth patches and track to the meadow ruin
    const bare = smoothstep(0.42, 0.7, noise.fbm2(x * 0.021 + 13, z * 0.021 - 6, 4) * 0.5 + 0.5 + 0.25 * rubble);
    mud = Math.max(mud, bare * 0.7);

    h += micro * microK;

    // river channel
    const d = q.d;
    if (d < hw + 7) {
      const u = d / hw;
      const depth = 1.05 + 0.5 * noise.n2(q.s * 0.02, 5.5) + 0.25 * noise.n2(x * 0.09, z * 0.09);
      // gravel bars: shallow shoals on alternating sides
      const bar = saturate(0.5 + 0.9 * noise.n2(q.s * 0.013 + q.side * 3.1, q.side * 1.7)) * smoothstep(0.25, 0.95, u);
      let hb = wl - depth * Math.pow(saturate(1 - u * u), 0.7) * (1 - 0.8 * bar) + 0.34 * bar;
      hb += 0.14 * noise.fbm2(x * 0.33, z * 0.33, 2) + 0.07 * noiseB.n2(x * 0.9, z * 0.9);
      const k = smoothstep(hw + 6.5, hw + 0.5, d);
      h = mix(h, Math.min(h, hb + 0.9 * (1 - k)), k);
      bed = smoothstep(hw + 4.2, hw + 0.6, d + 1.2 * noise.n2(x * 0.17, z * 0.17));
      mud = Math.max(mud * (1 - bed), 0.6 * smoothstep(hw + 7, hw + 3, d) * (1 - bed));
    }

    if (m) {
      const slopeForest = saturate((bh - 22) / 18);
      m.road = road * (1 - bed);
      m.cobble = cobble * (1 - road);
      m.mud = saturate(mud * (1 - road) * (1 - cobble));
      m.rubble = rubble;
      m.bed = bed;
      m.wet = wet;
      m.forest = slopeForest;
      m.waterLevel = wl;
      m.riverDist = d - hw;
    }
    return h;
  }

  return {
    playCenter: WORLD.playCenter, playRadius: WORLD.playRadius,
    noise, noiseB, river, sBridge, bridge, roads, streets, streetRoads, allRoads, tank, tower, church, buildings, craters, cover,
    waterLevel, riverHalfWidth, baseHeight, designHeight, obbCorners, footprintDist,
  };
}
