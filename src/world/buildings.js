// Ruined village, church and blown bridge. Everything is generated
// procedurally (see ./bld/*) and baked into a handful of world-space meshes
// that share one array-texture material.
import * as THREE from 'three';
import { Noise } from '../core/noise.js';
import { MB, CB, LY } from './bld/mb.js';
import { makeStructureMaterial } from './bld/material.js';
import { buildHouse } from './bld/house.js';
import { buildChurch } from './bld/church.js';
import { buildBridge } from './bld/bridge.js';
import { buildStoneWalls, buildDebris } from './bld/extras.js';
import { buildTown, specialCfg } from './bld/town.js';

// hand-tuned hero buildings
function heroCfg(b, B) {
  const n = B.noise;
  if (b.id === 'meadowRuin') {
    // reference 1: a tall fragment of the south wall with a window, on the knoll
    const g = (x, z, cx, cz, sx, sz) => Math.exp(-((x - cx) * (x - cx) / (2 * sx * sx) + (z - cz) * (z - cz) / (2 * sz * sz)));
    return {
      burnt: true, bare: 0.55, noRoof: true, noFloors: true, noPartition: true, debris: 1.6, blasts: [{ x: -0.3, y: 3.3, z: 3.75, r: 1.0 }],
      hbFn: (x, z) => 0.7 + 0.5 * n.n2(x * 0.5, z * 0.5) + 0.35 * n.n2(x * 1.4, z * 1.4) + 5.6 * g(x, z, -2.4, 3.6, 1.5, 1.0) + 3.2 * g(x, z, -4.6, 2.0, 0.7, 1.6) + 1.7 * g(x, z, 3.5, -3.5, 1.5, 1.0),
      openings: { 0: [{ u0: 1.75, u1: 2.7, v0: 0.95, v1: 2.25 }, { u0: 1.75, u1: 2.7, v0: 3.7, v1: 5.0 }, { u0: 6.2, u1: 7.1, v0: 0.95, v1: 2.25 }] },
      extra: (BB) => {
        const mb = BB.mb;
        mb.set(LY.wood_charred, [0.85, 0.85, 0.85]);
        mb.beam([-0.5, 0.1, 5.7], [-1.5, 3.3, 4.02], 0.16, 0.16);
        mb.beam([0.9, 0.1, 5.1], [-0.7, 2.2, 3.98], 0.14, 0.14);
        mb.set(LY.wood_beam, [0.9, 0.86, 0.8]);
        for (const x of [-3.5, -2.7, -1.5]) mb.beam([x, 2.68, 3.3], [x + 0.1, 2.55 - (x + 3.5) * 0.06, 2.1 + (x + 3.5) * 0.2], 0.1, 0.16);
        mb.beam([-3.9, 0.12, 1.2], [-1.2, 0.3, 2.4], 0.15, 0.15);
      },
    };
  }
  if (b.id === 'lookout') {
    // enterable: rubble ramp to the first floor, big broken window towards the church (reference 7)
    return {
      burnt: true, roofBias: 1.0, noPartition: true,
      collapse: { x: 4.8, z: 3.4, depth: 0.8, sigma: 2.8 },
      blasts: [{ x: 5.25, y: 6.8, z: -1.5, r: 1.3 }, { x: -2.5, y: 7.6, z: 4, r: 1.5 }, { x: -5.25, y: 4.2, z: 1.0, r: 0.9 }, { x: 2.6, y: 2.0, z: -4, r: 0.6 }],
      keep: [{ x: 0, y: 4.2, z: -4, r: 3.0 }],
      openings: { 1: [
        { u0: 4.05, u1: 6.45, v0: 3.5, v1: 5.2, frame: 1, big: true },
        { u0: 1.2, u1: 2.15, v0: 0.95, v1: 2.25, frame: 1 }, { u0: 6.9, u1: 7.94, v0: 0, v1: 2.1, door: true }, { u0: 8.6, u1: 9.5, v0: 0.95, v1: 2.25 },
        { u0: 1.2, u1: 2.15, v0: 3.7, v1: 5.0, shutter: 5 }, { u0: 8.6, u1: 9.5, v0: 3.7, v1: 5.0, frame: 2 },
        { u0: 1.2, u1: 2.15, v0: 6.45, v1: 7.45, soot: true }, { u0: 4.75, u1: 5.7, v0: 6.45, v1: 7.45, soot: true }, { u0: 8.6, u1: 9.5, v0: 6.45, v1: 7.45 },
      ] },
      floorFn: (k, x, z, field) => {
        if (k === 1) return !(x > -1.45 + 0.25 * n.n2(z * 0.9, 1.3) && z > 0.95) && Math.hypot(x - 5.25, z - 4) > 2.6 && field(x, 2.9, z) < 0.2;
        if (k === 2) return x < -2.3 + 0.9 * n.n2(z * 0.6, 3.3) && field(x, 5.6, z) < 0;
        return false;
      },
      ramp: { xb: 4.35, xt: -1.5, z0: 1.25, z1: 3.42, h: 2.75 },
    };
  }
  return b.special || b.terrace ? specialCfg(b) : {};
}

export async function build(ctx) {
  const t0 = performance.now();
  const material = ctx.testMaterial || await makeStructureMaterial(ctx);
  const chunks = new Map();
  const chunk = (key) => { let m = chunks.get(key); if (!m) { m = new MB(); chunks.set(key, m); } return m; };
  const B = {
    ctx, layout: ctx.layout, noise: new Noise(90211), ground: (x, z) => ctx.terrain.heightAt(x, z), mb: null, cb: null, baseY: 0, stones: [], tiles: [], stat: {},
    stone(x, y, z, s, rng) { this.stones.push([x, y + s * 0.25, z, s, rng.range(0, 6.283), rng.range(-0.5, 0.5), rng.range(-0.5, 0.5), rng.range(0.6, 1)]); },
    tile(x, y, z, rng) { this.tiles.push([x, y + 0.02, z, rng.range(0, 6.283), rng.range(-0.22, 0.22), rng.chance(0.3) ? Math.PI + rng.range(-0.2, 0.2) : rng.range(-0.25, 0.25), rng.chance(0.4) ? rng.range(0.4, 0.7) : 1]); },
  };
  let colTris = 0, colMeshes = 0;
  const pushCol = (name) => { const m = B.cb.mesh(name); if (m) { ctx.colliders.push(m); colTris += B.cb.tris; colMeshes++; } };
  for (const b of ctx.layout.buildings) {
    B.mb = chunk(b.kind === 'church' ? 'church' : b.x < -60 ? 'west' : b.x < 30 ? 'v0' : b.x < 80 ? 'v1' : 'v2');
    B.cb = new CB();
    try {
      if (b.kind === 'church') buildChurch(B, b); else buildHouse(B, b, heroCfg(b, B));
    } catch (e) { console.error(`[buildings] ${b.id} failed:`, e); }
    pushCol(b.id);
  }
  B.mb = chunk('west'); B.cb = new CB();
  try { buildBridge(B); } catch (e) { console.error('[buildings] bridge failed:', e); }
  pushCol('bridge');
  B.mb = chunk('walls'); B.cb = new CB();
  try { buildStoneWalls(B); } catch (e) { console.error('[buildings] stone walls failed:', e); }
  pushCol('stonewalls');
  // street furniture in the structure material, merged into the nearest chunk
  const cbW = new CB(), cbS = new CB();
  let town = null;
  try { town = buildTown(B, (c) => chunk(c.x < 30 ? 'v0' : c.x < 80 ? 'v1' : 'v2'), cbW, cbS); } catch (e) { console.error('[buildings] town furniture failed:', e); }
  for (const [cb, surf] of [[cbW, 'wood'], [cbS, 'stone']]) {
    const m = cb.mesh('town-' + surf);
    if (m) { m.userData.surface = surf; ctx.colliders.push(m); colTris += cb.tris; colMeshes++; }
  }

  const group = new THREE.Group();
  group.name = 'buildings';
  let tris = 0, verts = 0;
  const parts = [];
  for (const [key, mb] of chunks) {
    const m = mb.toMesh(material, `bld:${key}`);
    if (m) { group.add(m); tris += mb.tris; verts += mb.n; parts.push(`${key}:${Math.round(mb.tris / 1000)}k`); }
  }
  for (const im of buildDebris(B, material)) { group.add(im); tris += im.count * im.geometry.index.count / 3; }
  ctx.scene.add(group);
  const stats = { town, tris: Math.round(tris), meshes: group.children.length, stones: B.stones.length, tiles: B.tiles.length, verts, cat: B.stat, colTris, colMeshes, ms: Math.round(performance.now() - t0), missing: material.userData.missing };
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("bldstats")) console.error(`[buildings] ${JSON.stringify(stats)} ${parts.join(' ')}`);
  return { group, material, stats };
}
