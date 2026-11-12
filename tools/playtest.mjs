// Automated play-test: drives the real game in headless Chrome (real GPU) and
// reports numbers for movement, collision, weapon, zombies, waves, UI flow and
// performance. Screenshots and two contact sheets land in --out.
//   node tools/playtest.mjs                      everything
//   node tools/playtest.mjs --only game          scripted gameplay only (auto mode, deterministic stepping)
//   node tools/playtest.mjs --only ui            menu / settings / HUD / pause / summary flow only
//   --waves 3   waves the bot must clear        --q high   quality preset      --out dir
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const W = 1280, H = 720;
const q = arg('q', 'high');
const out = arg('out', 'tools/_preview/playtest');
const only = String(arg('only', 'game,ui')).split(',');
const url = arg('url', 'http://127.0.0.1:5173/');
const nWaves = Number(arg('waves', 3));
fs.mkdirSync(out, { recursive: true });
const { acquireGpuLock } = await import('./lib/gpulock.mjs');
const release = await acquireGpuLock();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const shots = { game: [], weapon: [], ui: [] };

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 900000,
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile-playtest'),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio'],
});

async function open(query, tag) {
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || t === 'warn') errors.push(`[${tag}:${t}] ${m.text()}`.slice(0, 500)); });
  page.on('pageerror', (e) => errors.push(`[${tag}:pageerror] ${String((e && e.stack) || e).slice(0, 700)}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`[${tag}:http ${r.status()}] ${r.url()}`.slice(0, 300)); });
  await page.goto(`${url}?${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  return page;
}
async function section(page, name, fn, ...args) {
  try {
    const r = await page.evaluate(fn, ...args);
    console.log(`## ${name}: ${JSON.stringify(r)}`);
    return r;
  } catch (e) { console.log(`## ${name}: FAILED ${String((e && e.message) || e).slice(0, 1200)}`); return null; }
}
// render the frozen game for a few frames, grab it, freeze again
async function shotGame(page, name, group = 'game') {
  try {
    await page.evaluate(async () => { const vm = window.__vm; window.__ptState = vm.game.state; vm.game.state = 'paused'; vm.start(); for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r)); });
    const file = path.join(out, `${name}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
    await page.evaluate(() => { const vm = window.__vm; vm.stop(); vm.game.state = window.__ptState; });
    shots[group].push(file);
  } catch (e) { console.log(`shot ${name} failed: ${e.message}`); }
}
async function shotUi(page, name) {
  const file = path.join(out, `ui_${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
  shots.ui.push(file);
}

// ------------------------------------------------------------------ page-side helpers
const LIB = () => {
  const vm = window.__vm, g = vm.game, T = vm.THREE, p = g.player, terr = vm.terrain, Z = g.zombies;
  const r2 = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(d) : v);
  const pt = window.pt = {
    r2, god: false,
    sim(sec, dt = 1 / 60, each) {
      const n = Math.round(sec / dt);
      for (let i = 0; i < n; i++) { g.update(dt); if (pt.god && p.alive) p.health = 100; if (each && each((i + 1) * dt, dt) === false) return (i + 1) * dt; }
      return sec;
    },
    hold() { g.interT = 1e9; g.queue = 0; },
    reset(x = -58, z = 96, yaw = -0.55) {
      if (g.state !== 'playing' || !p.alive) g.start();
      Z.clear(); Z.passive = false; Z.noCull = false; pt.hold(); pt.god = false;
      p.spawn(x, z, yaw); p.enabled = true; p.script = () => {};
      g.weapon.reset(); pt.sim(0.25);
    },
    above() { return p.pos.y - terr.heightAt(p.pos.x, p.pos.z); },
    xz(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); },
    arr(v) { return [r2(v.x), r2(v.y), r2(v.z)]; },
    still(z) { z.wanderT = 1e9; z.wanderGo = false; },
  };
  return true;
};

const S_ASSETS = () => {
  const g = __vm.game, Z = g.zombies, w = g.weapon, c = g.collision, r2 = pt.r2;
  const names = ['stone', 'wood', 'metal', 'dirt', 'grass', 'gravel', 'water', 'flesh'];
  const sh = {}; for (const s of c.surf || []) sh[names[s]] = (sh[names[s]] || 0) + 1;
  const info = {}; for (const k in Z.clipInfo) { const i = Z.clipInfo[k]; info[k] = { dur: r2(i.duration), median: r2(i.median), strideSpeed: r2(i.strideSpeed), stride: r2(i.stride), stance: r2(i.stance) }; }
  const m = Z.materials[0];
  return { zombieModel: !!Z.template, clips: Object.keys(Z.clips).join(','), clipSpeed: { Walk: r2(Z.clipSpeed.Walk), Run: r2(Z.clipSpeed.Run) }, clipInfo: info, pool: Z.pool.length, materials: Z.materials.length, mat: m && { rough: m.roughness, metal: m.metalness, roughMap: !!m.roughnessMap, normalMap: !!m.normalMap, ao: !!m.aoMap }, rifle: w.isPlaceholder ? 'placeholder' : 'glb', rifleInfo: (() => { const T = __vm.THREE; w.rig.position.set(0, 0, 0); w.rig.rotation.set(0, 0, 0); w.root.updateWorldMatrix(true, true); const inv = w.rig.matrixWorld.clone().invert(); const loc = (n) => pt.arr(n.getWorldPosition(new T.Vector3()).applyMatrix4(inv)); const bb = new T.Box3().setFromObject(w.model).applyMatrix4(inv); const o = { min: pt.arr(bb.min), max: pt.arr(bb.max), meshes: 0 }; w.model.traverse((x) => { if (x.isMesh) o.meshes++; }); for (const k of ['Muzzle', 'Eject', 'SightRear', 'SightFront', 'GripL', 'MagGrip', 'BoltGrip', 'Bolt', 'Magazine', 'HandL', 'HandR', 'Trigger']) if (w.nodes[k]) o[k] = loc(w.nodes[k]); return o; })(), rifleNodes: Object.keys(w.nodes).join(','), ads: pt.arr(w.ads), adsTilt: r2(w.adsTilt, 4), colliderTris: c.triangles, surfaces: sh, flowN: Z.flow.n, sounds: Object.keys(g.audio.sounds).length };
};

const S_PLAYER = () => {
  const vm = __vm, g = vm.game, p = g.player, col = g.collision, terr = vm.terrain, T = vm.THREE, { r2 } = pt;
  const o = {};
  pt.reset();
  o.spawn = { pos: pt.arr(p.pos), above: r2(pt.above(), 3), depth: r2(col.waterDepth(p.pos.x, p.pos.z)), surface: col.groundSurface(p.pos.x, p.pos.z) };
  let minAbove = 1e9; const track = () => { minAbove = Math.min(minAbove, pt.above()); };
  let a = p.pos.clone(); pt.sim(1, 1 / 60, track); o.idleDrift = r2(pt.xz(a, p.pos), 3);
  const run = (script, warm, sec) => { p.script = script; pt.sim(warm, 1 / 60, track); a = p.pos.clone(); pt.sim(sec, 1 / 60, track); return r2(pt.xz(a, p.pos) / sec); };
  o.walk = run((dt, pl) => { pl.input.fwd = 1; }, 0.8, 2);
  o.sprint = run((dt, pl) => { pl.input.fwd = 1; pl.input.sprint = true; }, 0.8, 2);
  o.strafe = run((dt, pl) => { pl.input.strafe = 1; }, 0.8, 1.5);
  o.crouchWalk = run((dt, pl) => { pl.input.fwd = 1; pl.input.crouch = true; }, 0.8, 1.5);
  o.crouchEye = r2(p.eye.y - p.pos.y);
  o.adsWalk = run((dt, pl) => { pl.input.fwd = 1; pl.input.ads = true; }, 0.8, 1.5);
  p.script = () => {}; pt.sim(0.9, 1 / 60, track);
  o.standEye = r2(p.eye.y - p.pos.y);
  pt.reset(); let first = true, maxH = 0, air = 0; const y0 = p.pos.y;
  p.script = (dt, pl) => { if (first) { pl.input.jump = true; first = false; } };
  pt.sim(1.5, 1 / 60, (t, dt) => { maxH = Math.max(maxH, p.pos.y - y0); if (!p.onGround) air += dt; track(); });
  o.jump = { height: r2(maxH), air: r2(air), landed: p.onGround };

  // ledges: a 0.3 m platform is walked onto, a 0.85 m one blocks until it is jumped
  {
    const mk = (hgt, d) => { const x = -58 + 0.5227 * d, z = 96 - 0.8525 * d; const m = new T.Mesh(new T.BoxGeometry(3, hgt, 3)); m.position.set(x, terr.heightAt(x, z) + hgt / 2 - 0.05, z); m.rotation.y = -0.55; m.userData.surface = "wood"; m.updateMatrixWorld(true); return m; };
    const lo = mk(0.3, 6), hi = mk(0.85, 12), topOf = (m) => m.position.y + m.geometry.parameters.height / 2;
    col.build([...vm.world.colliders, lo, hi]);
    pt.reset();
    p.script = (dt, pl) => { pl.input.fwd = 1; };
    let onLow = false; pt.sim(2.2, 1 / 60, () => { if (Math.abs(p.pos.y - topOf(lo)) < 0.04 && p.onGround) onLow = true; track(); });
    pt.sim(2.5, 1 / 60, track);
    const gap = pt.xz(p.pos, hi.position), blocked = gap > 1.7 && gap < 2.3 && p.pos.y < topOf(hi) - 0.4;
    p.script = (dt, pl) => { pl.input.fwd = 1; pl.input.jump = true; };
    let onHigh = false; pt.sim(2.5, 1 / 60, () => { if (Math.abs(p.pos.y - topOf(hi)) < 0.04 && p.onGround) onHigh = true; });
    o.ledges = { steppedOnto30cm: onLow, blockedBy85cm: blocked, gapToBox: r2(gap), jumpedOnto85cm: onHigh };
    col.build(vm.world.colliders);
  }

  // nearest wall around the street viewpoint: walk into it
  const s = vm.VIEWS.street.pos, ox = s[0], oz = s[2], oy = terr.heightAt(ox, oz) + 1.0;
  const ray = new T.Ray(); let best = null;
  for (let k = 0; k < 48; k++) {
    const an = (k / 48) * 6.2832; ray.origin.set(ox, oy, oz); ray.direction.set(Math.sin(an), 0, Math.cos(an));
    const h = col.bvh.raycastFirst(ray, T.DoubleSide, 0, 70);
    if (h && h.distance > 5 && (!best || h.distance < best.d)) best = { d: h.distance, pt: h.point.clone(), dir: ray.direction.clone() };
  }
  if (best) {
    pt.reset(ox, oz, 0);
    const tgt = best.pt.clone();
    p.script = (dt, pl) => { tgt.y = pl.eye.y; pl.lookAt(tgt, 999, dt); pl.input.fwd = 1; };
    pt.sim(best.d / 3.4 + 3, 1 / 60, track);
    const rem = new T.Vector3().subVectors(best.pt, p.pos); rem.y = 0;
    o.wall = { dist: r2(best.d), remaining: r2(rem.length()), through: rem.dot(best.dir) < 0, speedAtEnd: r2(p.speed), above: r2(pt.above()) };
    window.__ptWall = { x: p.pos.x - best.dir.x * 3.2, z: p.pos.z - best.dir.z * 3.2, tx: best.pt.x, ty: best.pt.y, tz: best.pt.z };
  } else o.wall = 'no wall found';

  // across the bridge
  const b = vm.layout.bridge, L = b.length;
  const sx = b.x - b.dirx * (L / 2 + 10), sz = b.z - b.dirz * (L / 2 + 10);
  const end = new T.Vector3(b.x + b.dirx * (L / 2 + 10), 0, b.z + b.dirz * (L / 2 + 10));
  const prof = [];
  for (let u = -L / 2 - 12; u <= L / 2 + 12.01; u += 4) { const x = b.x + b.dirx * u, z = b.z + b.dirz * u; prof.push(`${Math.round(u)}:${r2(col.floorAt(x, 60, z, 90), 1)}/${r2(terr.heightAt(x, z), 1)}`); }
  o.bridgeProfile = prof.join(' ');
  pt.reset(sx, sz, 0); p.pos.y = col.floorAt(sx, 60, sz, 90);
  let yMid = null, dMid = 1e9, lastTop = null; const along = () => r2((p.pos.x - b.x) * b.dirx + (p.pos.z - b.z) * b.dirz, 1);
  p.script = (dt, pl) => { end.y = pl.eye.y; pl.lookAt(end, 999, dt); pl.input.fwd = 1; pl.input.sprint = true; };
  const tb = pt.sim((L + 20) / 5 + 8, 1 / 60, () => { if (p.pos.y > col.floorAt(p.pos.x, 60, p.pos.z, 90) - 0.3) lastTop = along(); const d = Math.hypot(p.pos.x - b.x, p.pos.z - b.z); if (d < dMid) { dMid = d; yMid = p.pos.y; } track(); return pt.xz(p.pos, end) > 1.5; });
  o.bridge = { length: r2(L), deckY: r2(b.deckY), yMid: r2(yMid), bedMid: r2(terr.heightAt(b.x, b.z)), depthMid: r2(col.waterDepth(b.x, b.z)), offAxis: r2(dMid), reached: pt.xz(p.pos, end) < 2.5, time: r2(tb), onTopUntil: lastTop, endAt: along(), endY: r2(p.pos.y), endSpeed: r2(p.speed) };

  // wading across the river
  const tq = vm.layout.river.query(b.x - b.dirz * 55, b.z + b.dirx * 55, {});
  const nx = tq.tz, nz = -tq.tx, hw = vm.layout.riverHalfWidth(tq.s);
  pt.reset(tq.px - nx * (hw + 8), tq.pz - nz * (hw + 8), 0);
  const endR = new T.Vector3(tq.px + nx * (hw + 8), 0, tq.pz + nz * (hw + 8));
  let maxDepth = 0, maxIn = 0, minEye = 1e9, swam = false;
  p.script = (dt, pl) => { endR.y = pl.eye.y; pl.lookAt(endR, 999, dt); pl.input.fwd = 1; };
  const tr = pt.sim((2 * hw + 16) / 1.5 + 8, 1 / 60, () => {
    const d = col.waterDepth(p.pos.x, p.pos.z);
    if (d > 0) { maxDepth = Math.max(maxDepth, d); minEye = Math.min(minEye, p.eye.y - (terr.heightAt(p.pos.x, p.pos.z) + d)); }
    maxIn = Math.max(maxIn, p.inWater); swam = swam || p.swimming; track();
    return pt.xz(p.pos, endR) > 1.5;
  });
  o.river = { halfWidth: r2(hw), maxDepth: r2(maxDepth), inWater: r2(maxIn), swam, minEyeOverWater: r2(minEye), crossed: pt.xz(p.pos, endR) < 2.5, time: r2(tr) };
  o.minAboveGround = r2(minAbove, 3);
  pt.reset();
  return o;
};

const S_WEAPON = () => {
  const vm = __vm, g = vm.game, p = g.player, w = g.weapon, T = vm.THREE, cam = vm.engine.camera, terr = vm.terrain, { r2 } = pt;
  const o = {};
  pt.reset();
  const hits = []; const orig = g.shoot;
  g.shoot = function (origin, dir) {
    const h = orig.call(g, origin, dir);
    const f = new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    hits.push(h ? { s: h.surface, d: h.distance, ang: Math.acos(Math.min(1, f.dot(h.point.clone().sub(origin).normalize()))) * 1000 } : null);
    return h;
  };
  const tx = p.pos.x + 0.52 * 30, tz = p.pos.z - 0.85 * 30;
  const tgt = new T.Vector3(tx, terr.heightAt(tx, tz), tz);
  let fireN = 0, ads = false, fire = false, reload = false;
  p.script = (dt, pl) => { pl.lookAt(tgt, 999, dt); pl.input.ads = ads; pl.input.fire = fire || fireN-- > 0; pl.input.reload = reload; };
  pt.sim(0.3); fireN = 1; pt.sim(0.3);
  o.hip = hits.map((h) => h && { s: h.s, d: r2(h.d), mrad: r2(h.ang, 1) }); o.hipAmmo = w.ammo;
  hits.length = 0; ads = true; pt.sim(0.6);
  o.ads = { adsT: r2(p.adsT), fov: r2(cam.fov, 1), rig: pt.arr(w.rig.position) };
  fire = true; pt.sim(1.0);
  o.auto1s = { shots: hits.length, ammo: w.ammo, maxMrad: r2(Math.max(...hits.map((h) => (h ? h.ang : 0))), 1), misses: hits.filter((h) => !h).length, surfaces: [...new Set(hits.map((h) => h && h.s))].join(',') };
  let tStart = null, tEnd = null;
  pt.sim(9, 1 / 60, (tt) => { if (w.reloading && tStart === null) tStart = tt; if (tStart !== null && !w.reloading) { tEnd = tt; return false; } });
  o.reload = { emptyAfter: r2(tStart), duration: r2(tEnd - tStart), ammo: w.ammo, reserve: w.reserve, shotsBefore: hits.length };
  fire = false; pt.sim(0.3);
  w.ammo = 12; w.reserve = 7; reload = true; pt.sim(0.1); reload = false; pt.sim(3.2);
  o.partialReload = { ammo: w.ammo, reserve: w.reserve };
  w.ammo = 0; w.reserve = 0; hits.length = 0; fire = true; pt.sim(0.5);
  o.empty = { shots: hits.length, reloading: w.reloading };
  fire = false; w.reset();
  // sprinting lowers the rifle and holds fire until it is back up
  hits.length = 0; let sprint = true;
  p.script = (dt, pl) => { pl.input.fwd = 1; pl.input.sprint = sprint; pl.input.fire = fire; };
  pt.sim(1.0); o.sprintPose = r2(w.sprintT); fire = true; pt.sim(0.05); const s0 = hits.length; pt.sim(0.6);
  o.sprintFire = { shotsInFirst50ms: s0, shotsAfter: hits.length };
  o.fx = { particles: g.fx.n, casings: g.fx.casings.count, decalsTotal: g.fx.decalI };
  g.shoot = orig;
  return o;
};

const S_SURFACES = () => {
  const vm = __vm, g = vm.game, col = g.collision, T = vm.THREE, terr = vm.terrain, { r2 } = pt;
  const names = ['stone', 'wood', 'metal', 'dirt', 'grass', 'gravel', 'water', 'flesh'];
  const o = {}; const posA = col.geometry.attributes.position.array; const nTri = col.surf.length;
  const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), n = new T.Vector3(), cen = new T.Vector3(), org = new T.Vector3(), dir = new T.Vector3();
  const shootAt = () => { const n0 = g.fx.n, d0 = g.fx.decalI; const h = g.shoot(org.clone(), dir.clone()); return h ? `${h.surface} d${r2(h.distance)} +${g.fx.n - n0}p +${g.fx.decalI - d0}decal` : null; };
  for (const want of ['stone', 'wood', 'metal']) {
    const si = names.indexOf(want); let res = null, tries = 0;
    for (let t = 0; t < nTri && !res && tries < 600; t += 13) {
      if (col.surf[t] !== si) continue;
      a.fromArray(posA, t * 9); b.fromArray(posA, t * 9 + 3); c.fromArray(posA, t * 9 + 6);
      n.subVectors(b, a).cross(cen.subVectors(c, a)); if (n.length() / 2 < 0.1) continue; n.normalize();
      cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      tries++;
      for (const sgn of [1, -1]) {
        org.copy(cen).addScaledVector(n, 3 * sgn); dir.copy(n).multiplyScalar(-sgn);
        if (org.y < terr.heightAt(org.x, org.z) + 0.3) continue;
        const pre = col.raycast(org, dir, 6, {});
        if (pre && Math.abs(pre.distance - 3) < 0.05 && pre.surface === want) { res = shootAt(); break; }
      }
    }
    o[want] = res || 'none reachable';
  }
  const found = {};
  for (let x = -160; x < 200; x += 4) for (let z = -200; z < 160; z += 4) { const s = col.groundSurface(x, z); if (!found[s]) found[s] = [x, z]; }
  for (const s in found) {
    const [x, z] = found[s]; const h = terr.heightAt(x, z);
    org.set(x, h + Math.max(0, col.waterDepth(x, z)) + 3, z); dir.set(0.05, -1, 0).normalize();
    if (col.floorAt(x, h + 30, z, 40) > h + 0.05) { o['ground_' + s] = 'covered'; continue; }
    o['ground_' + s] = shootAt();
  }
  return o;
};

// three variants standing in front of the player (for the close-up)
const S_LINEUP = () => {
  const g = __vm.game, p = g.player, Z = g.zombies, T = __vm.THREE;
  pt.reset(); Z.passive = true; Z.noCull = true;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const zs = [];
  for (let i = 0; i < 3; i++) {
    const side = (i - 1) * 0.95, d = 2.7 + Math.abs(i - 1) * 0.25;
    const z = Z.spawn(p.pos.x + fx * d - fz * side, p.pos.z + fz * d + fx * side, { runner: false, variant: i, yaw: Math.atan2(-fx, -fz) + (i - 1) * 0.35 });
    pt.still(z); zs.push(z);
  }
  const tgt = new T.Vector3();
  p.script = (dt, pl) => { zs[1].root.updateWorldMatrix(true, true); zs[1].bones.Chest ? zs[1].bones.Chest.getWorldPosition(tgt) : tgt.copy(zs[1].pos).setY(zs[1].pos.y + 1.2); pl.lookAt(tgt, 999, dt); };
  pt.sim(1.2);
  return { list: Z.list.length, variants: zs.map((z) => z.mesh.material.userData.variant) };
};

const S_ZOMBIE = () => {
  const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, T = vm.THREE, terr = vm.terrain, { r2 } = pt; const o = {};
  pt.reset(); Z.passive = true; Z.noCull = true;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const mk = (d, side, variant, yaw) => { const z = Z.spawn(p.pos.x + fx * d - fz * side, p.pos.z + fz * d + fx * side, { runner: false, variant, yaw }); pt.still(z); return z; };
  const wp = (z, name) => { z.root.updateWorldMatrix(true, true); return z.bones[name].getWorldPosition(new T.Vector3()); };
  const gAt = (v) => r2(v.y - terr.heightAt(v.x, v.z));
  const z = mk(8, 0, 0, Math.atan2(-fx, -fz)); pt.sim(0.5);
  z.mesh.computeBoundingBox(); const bb = z.mesh.boundingBox;
  o.model = { scale: r2(z.scale), height: r2((bb.max.y - bb.min.y) * z.scale), headJoint: gAt(wp(z, 'Head')), hips: gAt(wp(z, 'Hips')), foot: gAt(wp(z, 'FootL')), rootOverGround: r2(z.pos.y - terr.heightAt(z.pos.x, z.pos.z), 3) };
  const aim = (v) => { const org = p.eye.clone(); const h = Z.raycast(org, v.clone().sub(org).normalize(), 200); return h ? h.part : null; };
  const skull = wp(z, 'Head'); skull.y += 0.1 * z.scale;
  o.parts = {
    skull: aim(skull), chest: aim(wp(z, 'Chest')), hips: aim(wp(z, 'Hips')), shinL: aim(wp(z, 'LowerLegL').lerp(wp(z, 'FootL'), 0.5)), thighR: aim(wp(z, 'UpperLegR').lerp(wp(z, 'LowerLegR'), 0.5)),
    forearmR: aim(wp(z, 'LowerArmR').lerp(wp(z, 'HandR'), 0.5)), aboveHead: aim(skull.clone().setY(skull.y + 0.32)), beside: aim(wp(z, 'Hips').add(new T.Vector3(-fz * 0.8, 0.25, fx * 0.8))),
  };
  let fireN = 0, target = () => wp(z, 'Chest');
  p.script = (dt, pl) => { pl.lookAt(target(), 999, dt); pl.input.ads = true; pl.input.fire = fireN-- > 0; };
  pt.sim(0.6);
  fireN = 1; pt.sim(0.05); o.body1 = { health: z.health, state: z.state, clip: z.currentName }; pt.sim(0.6);
  fireN = 1; pt.sim(0.6); o.body2 = { health: z.health }; fireN = 1; pt.sim(0.1);
  o.body3 = { alive: z.alive, clip: z.currentName, kills: g.stats.kills };
  const corpse = (zz) => ({ hips: gAt(wp(zz, 'Hips')), head: gAt(wp(zz, 'Head')), chest: gAt(wp(zz, 'Chest')), foot: gAt(wp(zz, 'FootL')), groundNy: r2(terr.normalAt(zz.pos.x, zz.pos.z).y, 3) });
  const z2 = mk(7, 2.2, 1, Math.atan2(-fx, -fz)); pt.sim(0.4);
  target = () => { const h = wp(z2, 'Head'); h.y += 0.09; return h; };
  pt.sim(0.4); fireN = 1; pt.sim(0.1);
  o.headshot = { alive: z2.alive, clip: z2.currentName, headshots: g.stats.headshots };
  const z3 = mk(7, -2.2, 2, Math.atan2(fx, fz)); pt.sim(0.4);
  target = () => { const h = wp(z3, 'Head'); h.y += 0.09; return h; };
  pt.sim(0.4); fireN = 1; pt.sim(0.1);
  o.backshot = { alive: z3.alive, clip: z3.currentName };
  pt.sim(3.4);
  o.corpseBack = corpse(z2); o.corpseFront = corpse(z3); o.corpseBody = corpse(z);
  // stand over the bodies for the screenshot
  const mid = z2.pos.clone().add(z.pos).multiplyScalar(0.5);
  p.spawn(mid.x - fx * 3.4, mid.z - fz * 3.4, p.yaw);
  p.script = (dt, pl) => { pl.lookAt(mid, 999, dt); };
  pt.sim(0.4);
  return o;
};

const S_NAV = () => {
  const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, T = vm.THREE, terr = vm.terrain, col = g.collision, { r2 } = pt; const o = {};
  const s = vm.VIEWS.street.pos;
  pt.reset(s[0], s[2], 0); Z.noCull = true; pt.god = true;
  Z.flow.update(p.pos.x, p.pos.z);
  const f = Z.flow; let cand = null; const e0 = new T.Vector3(p.pos.x, p.pos.y + 1.3, p.pos.z), e1 = new T.Vector3();
  for (const ratio of [1.4, 1.2, 1.05]) {
    for (let t = 0; t < 5000 && !cand; t++) {
      const a = Math.random() * 6.283, r = 20 + Math.random() * 28; const x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
      const c = f.cellOf(x, z); if (c < 0 || f.walk[c] !== 1 || f.dist[c] === 65535) continue;
      const path = (f.dist[c] / 2) * f.cell; if (path < r * ratio) continue;
      if (col.lineOfSight(e0, e1.set(x, terr.heightAt(x, z) + 1.3, z))) continue;
      cand = { x, z, r, path };
    }
  }
  if (!cand) return { error: 'no hidden spawn found near the street' };
  o.route = { straight: r2(cand.r), path: r2(cand.path) };
  let stuck = 0; const os = Z.onStuck; Z.onStuck = () => { stuck++; };
  const A = new T.Vector3(), B = new T.Vector3();
  const chase = (runner) => {
    const z = Z.spawn(cand.x, cand.z, { runner, aware: true }); if (!z) return 'spawn failed';
    let prev = null, slip = 0, st = 0, travel = 0, lx = z.pos.x, lz = z.pos.z, flowT = 0;
    const fl = z.bones.FootL, fr = z.bones.FootR;
    pt.god = true;
    const t = pt.sim((cand.path / z.speed) * 2.5 + 15, 1 / 60, (tt, dt) => {
      travel += Math.hypot(z.pos.x - lx, z.pos.z - lz); lx = z.pos.x; lz = z.pos.z;
      if (!z.direct) flowT += dt;
      if (fl && (z.state === 'walk' || z.state === 'run')) {
        z.root.updateWorldMatrix(true, true); fl.getWorldPosition(A); fr.getWorldPosition(B);
        const ha = A.y - terr.heightAt(A.x, A.z), hb = B.y - terr.heightAt(B.x, B.z);
        const foot = ha < hb ? 0 : 1; const P = foot ? B : A; const down = Math.min(ha, hb) < 0.135 * z.scale;   // ankle within ~3 cm of its lowest: the foot is on the ground
        if (prev && prev.foot === foot && down && prev.down) { slip += Math.hypot(P.x - prev.x, P.z - prev.z); st += dt; }
        prev = { foot, x: P.x, z: P.z, down };
      } else prev = null;
      return pt.xz(z.pos, p.pos) > 1.6;
    });
    const res = { speed: r2(z.speed), time: r2(t), travel: r2(travel), avgSpeed: r2(travel / t), reached: pt.xz(z.pos, p.pos) <= 1.7, flowShare: r2(flowT / t), plantedTime: r2(st, 1), plantedFootSlip: r2(slip / Math.max(st, 1e-3), 3), slipPct: r2((100 * slip) / Math.max(st, 1e-3) / z.speed, 1), clip: z.currentName };
    pt.god = false; p.health = 100; const h0 = p.health; let firstHit = null;
    pt.sim(5, 1 / 60, (tt) => { if (firstHit === null && p.health < h0) firstHit = tt; });
    res.attack = { firstHitAfter: r2(firstHit), dmgIn5s: r2(h0 - p.health, 0), state: z.state, dist: r2(pt.xz(z.pos, p.pos)) };
    pt.god = true; p.health = 100; Z.clear();
    return res;
  };
  o.runner = chase(true); o.walker = chase(false); o.stuckEvents = stuck;
  Z.onStuck = os;
  // death and restart
  pt.god = false; p.health = 100; p.script = () => {};
  for (let i = 0, n = 0; i < 200 && n < 3; i++) { const x = p.pos.x + (Math.random() - 0.5) * 14, z = p.pos.z + (Math.random() - 0.5) * 14; if (f.walkable(x, z) && f.reachable(x, z) && Math.hypot(x - p.pos.x, z - p.pos.z) > 3) { Z.spawn(x, z, { runner: true, aware: true }); n++; } }
  let tDead = null, tOver = null;
  pt.sim(90, 1 / 60, (tt) => { if (tDead === null && !p.alive) tDead = tt; if (g.state === 'over') { tOver = tt; return false; } });
  o.death = { diedAfter: r2(tDead), summaryAfter: r2(tOver - tDead), state: g.state, weaponVisible: g.weapon.root.visible || vm.engine.weaponVisible, eyeHeight: r2(p.eye.y - p.pos.y), summary: g.summary() };
  pt.sim(1);
  g.start();
  o.restart = { state: g.state, alive: p.alive, health: p.health, zombies: Z.list.length, ammo: g.weapon.ammo, wave: g.wave, weaponVisible: g.weapon.root.visible };
  return o;
};

const S_WAVES = (args) => {
  const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, T = vm.THREE, { r2 } = pt;
  pt.reset(); g.start(); pt.god = true; const wanderers = Z.list.length;
  const waves = [], spawns = []; let relocated = 0, shotsFired = 0;
  const nw = g._nextWave; g._nextWave = function () { nw.call(g); waves.push({ wave: g.wave, t: r2(g.playTime, 1), queue: g.queue, reserve: g.weapon.reserve, kills: g.stats.kills }); };
  const sp = Z.spawn; Z.spawn = function (x, z, opts) { const r = sp.call(Z, x, z, opts); if (r && opts && opts.aware) spawns.push({ w: g.wave, d: Math.hypot(x - p.pos.x, z - p.pos.z), vis: g._visible(x, r.pos.y + 1.6, z) || g._visible(x, r.pos.y + 0.5, z), runner: r.runner }); return r; };
  const rl = g._relocate; g._relocate = function (z) { const ok = rl.call(g, z); if (ok) relocated++; return ok; };
  const tmp = new T.Vector3(), fw = new T.Vector3(), f2 = new T.Vector3();
  p.script = (dt, pl) => {
    let best = null, bd = 1e9;
    for (const z of Z.list) { if (!z.alive) continue; const d = z.pos.distanceTo(pl.pos); if (d < bd) { bd = d; best = z; } }
    if (g.weapon.ammo === 0) pl.input.reload = true;
    if (!best) return;
    if (best.bones.Head) { best.root.updateWorldMatrix(true, true); best.bones.Head.getWorldPosition(tmp); tmp.y += 0.07; } else tmp.set(best.pos.x, best.pos.y + 1.55, best.pos.z);
    pl.lookAt(tmp, 16, dt);
    if (bd > 75) return;
    pl.input.ads = bd > 10;
    const err = Math.acos(Math.min(1, pl.forward(f2).dot(fw.copy(tmp).sub(pl.eye).normalize())));
    if (err < Math.min(0.2, 0.1 / bd) && g.collision.lineOfSight(pl.eye, tmp)) { pl.input.fire = true; shotsFired++; }
    if (bd < 6) pl.input.fwd = -1;
  };
  const cleared = []; let last = false, maxAlive = 0, minHealthSeen = 100;
  const t0 = performance.now();
  const simT = pt.sim(args.maxTime, 1 / 30, () => {
    const alive = Z.aliveCount; maxAlive = Math.max(maxAlive, alive);
    const cl = g.wave > 0 && g.queue === 0 && alive === 0; if (cl && !last) cleared.push({ wave: g.wave, t: r2(g.playTime, 1) }); last = cl;
    return g.wave <= args.waves;
  });
  const ms = performance.now() - t0;
  g._nextWave = nw; Z.spawn = sp; g._relocate = rl;
  const per = {};
  for (const s of spawns) { const k = 'w' + s.w; const e = per[k] || (per[k] = { n: 0, minD: 1e9, sumD: 0, visible: 0, runners: 0 }); e.n++; e.minD = Math.min(e.minD, s.d); e.sumD += s.d; if (s.vis) e.visible++; if (s.runner) e.runners++; }
  for (const k in per) { per[k].minD = r2(per[k].minD, 0); per[k].meanD = r2(per[k].sumD / per[k].n, 0); delete per[k].sumD; }
  return { wanderers, waves, cleared, spawns: per, stats: g.stats, summary: g.summary(), maxAlive, relocated, simSeconds: r2(simT, 0), msPerUpdate: r2(ms / (simT * 30), 2), list: Z.list.length, pool: Z.pool.length, reachedWave: g.wave };
};

const S_PERF_SETUP = () => {
  const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, { r2 } = pt;
  pt.reset(); pt.god = true;
  p.script = (dt, pl) => { pl.health = 100; };
  const cpu = (n) => { const t = performance.now(); for (let i = 0; i < n; i++) g.update(1 / 60); return (performance.now() - t) / n; };
  const base = vm.bench(40), cpu0 = cpu(120), info0 = vm.info();
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  for (let i = 0; i < 20; i++) {
    const row = (i / 5) | 0, k = (i % 5) - 2, d = 8 + row * 4.5 + Math.random(), side = k * d * 0.24 + (Math.random() - 0.5);
    Z.spawn(p.pos.x + fx * d - fz * side, p.pos.z + fz * d + fx * side, { runner: i % 3 === 0, aware: true, yaw: Math.atan2(-fx, -fz) });
  }
  pt.sim(0.8);
  window.__ptPerf = { base, cpu0, cpu, calls0: info0.calls, tris0: info0.tris };
  return { baseMs: r2(base), cpuUpdateMs0: r2(cpu0, 3), alive: Z.aliveCount };
};
const S_PERF = () => {
  const vm = __vm, g = vm.game, Z = g.zombies, T = vm.THREE, { r2 } = pt, b = window.__ptPerf;
  const lod = [0, 0, 0, 0]; for (const z of Z.list) lod[z.lod | 0]++;
  const with20 = vm.bench(40), info = vm.info();
  // render cost in isolation: the same frozen frame with and without the zombies drawn (twice, to see the noise)
  const st = g.state; g.state = 'paused';
  const show = (v) => Z.list.forEach((z) => { z.root.visible = v; });
  const r1 = vm.bench(40); show(false); const r0 = vm.bench(40); show(true); const r1b = vm.bench(40); show(false); const r0b = vm.bench(40); show(true);
  g.state = st;
  const renderOnly = (r1 + r1b) / 2, renderNone = (r0 + r0b) / 2;
  const visible = Z.list.filter((z) => z.root.visible).length;
  const cpu20 = b.cpu(120);
  return { lod, lodTris: (Z.lods || []).map((x) => x.index.count / 3), frozenWith: [r2(r1), r2(r1b)], frozenWithout: [r2(r0), r2(r0b)], zombieRenderMs: r2(renderOnly - renderNone), zombieCpuMs: r2(cpu20 - b.cpu0), zombieTotalMs: r2(renderOnly - renderNone + cpu20 - b.cpu0), baseMs: r2(b.base), with20Ms: r2(with20), addedMs: r2(with20 - b.base), cpuUpdateMs0: r2(b.cpu0, 3), cpuUpdateMs20: r2(cpu20, 3), visible, alive: Z.aliveCount, calls: [b.calls0, info.calls], tris: [b.tris0, info.tris] };
};

// ------------------------------------------------------------------ run
try {
  if (only.includes('game')) {
    const page = await open(`q=${q}&auto=1`, 'game');
    await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 240000, polling: 250 });
    console.log('GPU:', await page.evaluate(() => { const gl = window.__vm.engine.gl; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }));
    await page.evaluate(() => { window.__vm.stop(); });
    await page.evaluate(LIB);
    await section(page, 'assets', S_ASSETS);
    await section(page, 'player', S_PLAYER);
    await shotGame(page, 'spawn', 'weapon');
    await section(page, 'weapon', S_WEAPON);
    await section(page, 'surfaces', S_SURFACES);
    // aiming down the sights, mid-shot
    await section(page, 'ads-shot', () => {
      const g = __vm.game, p = g.player, T = __vm.THREE, terr = __vm.terrain; pt.reset();
      const tx = p.pos.x + 0.52 * 40, tz = p.pos.z - 0.85 * 40; const tgt = new T.Vector3(tx, terr.heightAt(tx, tz) + 1, tz);
      let fire = false; p.script = (dt, pl) => { pl.lookAt(tgt, 999, dt); pl.input.ads = true; pl.input.fire = fire; };
      pt.sim(0.7); fire = true; g.update(1 / 60);
      return { flash: g.weapon.flash.visible, light: pt.r2(g.weapon.light.intensity), ammo: g.weapon.ammo };
    });
    await shotGame(page, 'ads_fire', 'weapon');
    await section(page, 'w-ads', () => {
      const g = __vm.game, p = g.player, T = __vm.THREE, terr = __vm.terrain; pt.reset();
      const tx = p.pos.x + 0.52 * 40, tz = p.pos.z - 0.85 * 40; const tgt = new T.Vector3(tx, terr.heightAt(tx, tz) + 1, tz);
      p.script = (dt, pl) => { pl.lookAt(tgt, 999, dt); pl.input.ads = true; };
      pt.sim(0.8); return { rig: pt.arr(g.weapon.rig.position), rotX: pt.r2(g.weapon.rig.rotation.x, 4) };
    });
    await shotGame(page, 'w_ads', 'weapon');
    await section(page, 'w-reload', () => {
      const g = __vm.game, p = g.player; pt.reset(); g.weapon.ammo = 5; let rl = true;
      p.script = (dt, pl) => { pl.input.reload = rl; rl = false; };
      pt.sim(1.0); return { reloading: g.weapon.reloading, t: pt.r2(g.weapon.reloadT) };
    });
    await shotGame(page, 'w_reload', 'weapon');
    await section(page, 'w-sprint', () => {
      const p = __vm.game.player; pt.reset(); p.script = (dt, pl) => { pl.input.fwd = 1; pl.input.sprint = true; };
      pt.sim(1.0); return { sprintT: pt.r2(__vm.game.weapon.sprintT) };
    });
    await shotGame(page, 'w_sprint', 'weapon');
    // hip fire against the wall found by the collision test
    await section(page, 'wall-shots', () => {
      const g = __vm.game, p = g.player, T = __vm.THREE, wl = window.__ptWall; if (!wl) return 'no wall';
      pt.reset(wl.x, wl.z, 0); const tgt = new T.Vector3(wl.tx, wl.ty + 0.5, wl.tz); const d0 = g.fx.decalI;
      let fire = true; p.script = (dt, pl) => { pl.lookAt(tgt, 999, dt); pl.input.fire = fire; };
      pt.sim(0.8); return { decals: g.fx.decalI - d0, particles: g.fx.n, flash: g.weapon.flash.visible };
    });
    await shotGame(page, 'wall_impacts');
    await section(page, 'lineup', S_LINEUP);
    await shotGame(page, 'zombies_close');
    // the four levels of detail side by side at 3 m (0 = full mesh on the left)
    await section(page, 'lods', () => {
      const g = __vm.game, p = g.player, Z = g.zombies, T = __vm.THREE;
      pt.reset(); Z.passive = true; Z.noCull = true;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), zs = [];
      for (let i = 0; i < 4; i++) { const side = (i - 1.5) * 0.95; const z = Z.spawn(p.pos.x + fx * 3 - fz * side, p.pos.z + fz * 3 + fx * side, { runner: false, variant: i % 3, yaw: Math.atan2(-fx, -fz) }); pt.still(z); z.lodLock = i; zs.push(z); }
      const tgt = new T.Vector3(p.pos.x + fx * 3, p.pos.y + 1.15, p.pos.z + fz * 3);
      p.script = (dt, pl) => { pl.lookAt(tgt, 999, dt); };
      pt.sim(1.0);
      const r = { tris: zs.map((z) => z.mesh.geometry.index.count / 3), verts: zs.map((z) => z.mesh.geometry.attributes.position.count), tangents: !!zs[0].mesh.geometry.attributes.tangent };
      zs.forEach((z) => { delete z.lodLock; });
      return r;
    });
    await shotGame(page, 'lods');
    await section(page, 'zombie', S_ZOMBIE);
    await shotGame(page, 'corpses');
    await section(page, 'nav', S_NAV);
    await section(page, 'waves', S_WAVES, { waves: nWaves, maxTime: 900 });
    await section(page, 'perf-setup', S_PERF_SETUP);
    await shotGame(page, 'horde');
    await section(page, 'perf', S_PERF);
    await page.close();
  }

  if (only.includes('ui')) {
    const page = await open(`q=${q}`, 'ui');
    await page.evaluate(() => { try { localStorage.removeItem('valle-morta-settings'); } catch (e) { /* */ } });
    await sleep(900);
    await shotUi(page, 'loading');
    await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 240000, polling: 250 });
    await sleep(1800);
    const st = () => page.evaluate(() => ({ ui: __vm.ui.state, game: __vm.game.state, shown: [...document.querySelectorAll('.screen.show')].map((e) => e.className.replace('screen', '').replace('show', '').trim()).join('+'), hud: document.querySelector('.hud').classList.contains('show') }));
    const step = async (name) => console.log(`## ui ${name}: ${JSON.stringify(await st())}`);
    await step('menu'); await shotUi(page, 'menu');
    console.log('## ui menu-scene: ' + JSON.stringify(await page.evaluate(() => ({ zombies: __vm.game.zombies.list.length, weapon: __vm.engine.weaponVisible, fps: __vm.info().fps }))));
    await page.click('.menu [data-act="settings"]'); await sleep(700);
    const settings = await page.evaluate(async () => {
      const vm = __vm, e = vm.engine, o = {};
      const root = [...document.querySelectorAll('.panel')].find((x) => x.querySelector('.rows'));
      const range = (k, v) => { const el = root.querySelector(`input[data-key="${k}"]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      const snap = () => ({ quality: vm.game.settings.quality, shadow: e.q.shadow, scale: +e.renderScale.toFixed(3), res: [e.rw, e.rh], grain: e.post.settings.grain, fov: vm.game.settings.fov, sens: vm.game.settings.sensitivity, vol: { ...vm.game.audio.vol }, fps: vm.game.settings.showFps });
      const wait = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); };
      o.before = snap();
      root.querySelector('.seg button[data-v="medium"]').click();
      range('renderScale', 0.75); range('fov', 85); range('sensitivity', 1.5); range('master', 0.5); range('music', 0.3); range('sfx', 0.4);
      root.querySelector('input[data-key="grain"]').click(); root.querySelector('input[data-key="showFps"]').click();
      await wait(); o.changed = snap(); o.stored = localStorage.getItem('valle-morta-settings');
      root.querySelector('.row span').click(); await wait(); o.afterLabelClick = vm.game.settings.quality;
      root.querySelector('.seg button[data-v="high"]').click();
      range('renderScale', 1); range('fov', 72); range('sensitivity', 1); range('master', 0.8); range('music', 0.55); range('sfx', 0.9);
      root.querySelector('input[data-key="grain"]').click(); root.querySelector('input[data-key="showFps"]').click();
      await wait(); o.restored = snap();
      return o;
    });
    console.log('## ui settings: ' + JSON.stringify(settings));
    await sleep(500); await shotUi(page, 'settings');
    await page.click('.panel.show [data-act="back"]'); await sleep(500); await step('back-to-menu');
    await page.click('.menu [data-act="howto"]'); await sleep(700); await shotUi(page, 'howto');
    await page.click('.panel.show [data-act="back"]'); await sleep(500);
    // headless Chrome has no pointer lock: pretend it was granted so the real input path runs
    await page.evaluate(() => { Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.getElementById('view') }); });
    await page.click('.menu [data-act="play"]'); await sleep(600); await step('play');
    const p0 = await page.evaluate(() => __vm.game.player.pos.toArray());
    await page.keyboard.down('KeyW'); await sleep(1200); await page.keyboard.up('KeyW');
    await page.mouse.move(640, 360); await page.mouse.down(); await sleep(450); await page.mouse.up();
    await sleep(2300);
    console.log('## ui hud: ' + JSON.stringify(await page.evaluate((p0) => { const g = __vm.game, p = g.player; return { movedByKeys: +Math.hypot(p.pos.x - p0[0], p.pos.z - p0[2]).toFixed(2), ammoAfterMouseFire: g.weapon.ammo, wave: g.wave, toast: document.querySelector('.toast').textContent.trim(), status: document.querySelector('.status').textContent, prompt: document.querySelector('.prompt').textContent, hp: document.querySelector('.hp-num').textContent, zombies: g.zombies.list.length, fps: __vm.info().fps }; }, p0)));
    await shotUi(page, 'hud');
    await page.keyboard.press('KeyP'); await sleep(800); await step('pause'); await shotUi(page, 'pause');
    await page.click('.pause [data-act="settings"]'); await sleep(600);
    await page.click('.panel.show [data-act="back"]'); await sleep(600); await step('pause-settings-back');
    await page.click('.pause [data-act="resume"]'); await sleep(500); await step('resume');
    await page.evaluate(() => { __vm.game.player.damage(999); }); await sleep(3600); await step('death'); await shotUi(page, 'over');
    await page.click('.over [data-act="play"]'); await sleep(700); await step('try-again');
    await page.evaluate(() => { __vm.game.player.damage(999); }); await sleep(3500);
    await page.click('.over [data-act="quit"]'); await sleep(900); await step('quit-to-menu');
    console.log('## ui end: ' + JSON.stringify(await page.evaluate(() => ({ weapon: __vm.engine.weaponVisible, playerEnabled: __vm.game.player.enabled, menuZombies: __vm.game.zombies.list.length, loops: [...__vm.game.audio.want.keys()].join(','), audio: (() => { const a = __vm.game.audio; const used = 'rifle_shot dry_fire mag_out mag_in bolt_rack impact_flesh impact_dirt impact_stone impact_wood impact_metal impact_water step_grass step_gravel step_stone step_wood step_water zombie_idle zombie_alert zombie_attack zombie_death zombie_hurt bell_toll shell_drop player_hurt player_death ui_click amb_wind amb_river music_menu music_combat'.split(' '); return { ctx: a.ctx ? a.ctx.state : 'none', missingNames: used.filter((n) => !a.sounds[n]).join(','), resolved: used.filter((n) => !a.sounds[n]).map((n) => { const s = a._find(n); return n + '->' + (s ? Object.keys(a.sounds).find((k) => a.sounds[k] === s) : 'none'); }).join(','), decoded: Object.keys(a.sounds).filter((n) => a.sounds[n].buffers.length).length, undecodable: Object.keys(a.sounds).filter((n) => a.sounds[n].loading && !a.sounds[n].buffers.length).join(','), playing: [...a.loops.keys()].join(','), flags: ['amb_crows', 'music_over'].map((n) => n + ':' + (a.sounds[n] ? (a.sounds[n].loop ? 'loop' : 'once') + '/' + a.sounds[n].category : 'none')).join(',') }; })() }))));
    await page.evaluate(() => { try { localStorage.removeItem('valle-morta-settings'); } catch (e) { /* */ } });
    await page.close();
  }
} catch (e) {
  console.log('PLAYTEST ABORTED:', String((e && e.stack) || e).slice(0, 1500));
} finally {
  await browser.close();
  release();
}
const uniq = [...new Set(errors)];
console.log(uniq.length ? `--- console (${uniq.length}):\n` + uniq.slice(0, 20).join('\n') : '--- console: clean');
for (const [name, files] of Object.entries(shots)) {
  if (!files.length) continue;
  const file = path.join(out, `sheet_${name}.jpg`);
  try { execFileSync(process.execPath, ['tools/sheet.mjs', file, '640', '2', ...files], { stdio: 'pipe' }); console.log('sheet:', file); } catch (e) { console.log('sheet failed:', String(e.message).slice(0, 300)); }
}
