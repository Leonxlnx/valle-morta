// Automated play-test: drives the real game in headless Chrome (real GPU) and
// reports numbers for movement, collision, weapon, zombies, waves, UI flow and
// performance. Screenshots and two contact sheets land in --out.
//   node tools/playtest.mjs                      everything
//   node tools/playtest.mjs --only game          scripted gameplay only (auto mode, deterministic stepping)
//   node tools/playtest.mjs --only ui            menu / settings / HUD / pause / summary flow only
//   node tools/playtest.mjs --only operation     Operation mode: menu, Base, insertion, waves, salvage, extraction, death, saved profile
//   --waves 3   waves the bot must clear        --q high   quality preset      --out dir
//   --sec turn,fov,move,arms,feel,infected,blood,survival,core,nav,waves,perf   only these groups of the game run
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
const only = String(arg('only', 'game,ui,operation')).split(',');
const url = arg('url', 'http://127.0.0.1:5173/');
const nWaves = Number(arg('waves', 3));
const secs = arg('sec', '') ? String(arg('sec', '')).split(',') : null;
const run = (name) => !secs || secs.includes(name);
fs.mkdirSync(out, { recursive: true });
const { acquireGpuLock } = await import('./lib/gpulock.mjs');
const release = await acquireGpuLock();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const shots = { game: [], weapon: [], new: [], ui: [], op: [], ab: [] };

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
      for (let i = 0; i < n; i++) { g.update(dt); if (pt.god && p.alive) p.health = p.maxHealth; if (each && each((i + 1) * dt, dt) === false) return (i + 1) * dt; }
      return sec;
    },
    hold() { g.interT = 1e9; g.queue = 0; g.queueList = []; g.cleared = true; },
    reset(x = -58, z = 96, yaw = -0.55) {
      if (g.state !== 'playing' || !p.alive) g.start();
      Z.clear(); Z.passive = false; Z.noCull = false; pt.hold(); pt.god = false; g.supply.clear(); g.settings.fov = 72; p.keys.clear();
      p.spawn(x, z, yaw); p.enabled = true; p.script = () => {};
      p.bandages = 1; g.weapon.reset(); pt.sim(0.25);
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
  // the middle span is blown out by design (bld/bridge.js): the deck ends ~7 m either side of the
  // centre over a 5 m drop onto the rubble heap, and the far break face is a 4 m wall. A player
  // who runs over the edge must be able to wade out beside the bridge and reach the far bank, so
  // when the run stalls below the deck the bot steps out sideways past the bridge's flank first.
  let stallT = 0, detour = null, route = 'deck', h0 = p.health; const tgt = new T.Vector3();
  p.script = (dt, pl) => {
    if (!detour && pl.speed < 0.5 && pl.pos.y < b.deckY - 2) {
      stallT += dt;
      if (stallT > 0.8) { const u = along() + 1.5, off = b.width / 2 + 4; detour = new T.Vector3(b.x + b.dirx * u - b.dirz * off, 0, b.z + b.dirz * u + b.dirx * off); route = 'through the gap, wading out beside the bridge'; }
    } else if (!detour) stallT = 0;
    if (detour && pt.xz(pl.pos, detour) < 1.2) detour = false;
    tgt.copy(detour || end); tgt.y = pl.eye.y; pl.lookAt(tgt, 999, dt); pl.input.fwd = 1; pl.input.sprint = true;
  };
  const tb = pt.sim((L + 20) / 5 + 20, 1 / 60, () => { if (p.pos.y > col.floorAt(p.pos.x, 60, p.pos.z, 90) - 0.3) lastTop = along(); const d = Math.hypot(p.pos.x - b.x, p.pos.z - b.z); if (d < dMid) { dMid = d; yMid = p.pos.y; } track(); return pt.xz(p.pos, end) > 1.5; });
  o.bridge = { length: r2(L), deckY: r2(b.deckY), yMid: r2(yMid), bedMid: r2(terr.heightAt(b.x, b.z)), depthMid: r2(col.waterDepth(b.x, b.z)), offAxis: r2(dMid), reached: pt.xz(p.pos, end) < 2.5, route, healthLost: r2(h0 - p.health), time: r2(tb), onTopUntil: lastTop, endAt: along(), endY: r2(p.pos.y), endSpeed: r2(p.speed) };

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
  g.shoot = function (origin, dir, ...rest) {
    const h = orig.call(g, origin, dir, ...rest);
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
    let travel = 0, lx = z.pos.x, lz = z.pos.z, flowT = 0;
    const fl = z.bones.FootL, fr = z.bones.FootR, F = [];
    pt.god = true;
    // foot slip as tools/zslip.mjs measures it: animate this infected at the full (near) rate
    // although the camera stays with the player, log both feet per frame, and count only frames
    // where the lower foot stays the support foot within 3 cm of its own lowest height
    const animAll = Z.animAll; Z.animAll = true;
    const t = pt.sim((cand.path / z.speed) * 2.5 + 15, 1 / 60, (tt, dt) => {
      travel += Math.hypot(z.pos.x - lx, z.pos.z - lz); lx = z.pos.x; lz = z.pos.z;
      if (!z.direct) flowT += dt;
      if (fl && (z.state === 'walk' || z.state === 'run')) {
        z.root.updateWorldMatrix(true, true); fl.getWorldPosition(A); fr.getWorldPosition(B);
        F.push({ bx: z.pos.x, bz: z.pos.z, x0: A.x, z0: A.z, h0: A.y - terr.heightAt(A.x, A.z), x1: B.x, z1: B.z, h1: B.y - terr.heightAt(B.x, B.z) });
      } else F.push(null);
      return pt.xz(z.pos, p.pos) > 1.6;
    });
    Z.animAll = animAll;
    const live = F.filter(Boolean), tol = 0.03 * z.scale;
    const hmin = live.length ? [Math.min(...live.map((f) => f.h0)), Math.min(...live.map((f) => f.h1))] : [0, 0];
    let slip = 0, body = 0, sup = 0;
    for (let i = 1; i < F.length; i++) {
      const a = F[i - 1], c = F[i]; if (!a || !c) continue;
      const k = c.h0 <= c.h1 ? 0 : 1, kp = a.h0 <= a.h1 ? 0 : 1;
      if (k !== kp || c['h' + k] > hmin[k] + tol || a['h' + k] > hmin[k] + tol) continue;
      slip += Math.hypot(c['x' + k] - a['x' + k], c['z' + k] - a['z' + k]); body += Math.hypot(c.bx - a.bx, c.bz - a.bz); sup++;
    }
    const res = { speed: r2(z.speed), time: r2(t), travel: r2(travel), avgSpeed: r2(travel / t), reached: pt.xz(z.pos, p.pos) <= 1.7, flowShare: r2(flowT / t), supportTime: r2(sup / 60, 1), slipPct: body > 0 ? r2((100 * slip) / body, 1) : null, clip: z.currentName };
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
  const waves = [], spawns = []; let relocated = 0, shotsFired = 0, tick = 0, pistolShots = 0;
  const nw = g._nextWave; g._nextWave = function () { nw.call(g); waves.push({ wave: g.wave, kind: g.waveKind, t: r2(g.playTime, 1), queue: g.queue, rifleReserve: g.weapon.state.rifle.reserve, kills: g.stats.kills }); };
  const sp = Z.spawn; Z.spawn = function (x, z, opts) { const r = sp.call(Z, x, z, opts); if (r && opts && opts.aware) spawns.push({ w: g.wave, d: Math.hypot(x - p.pos.x, z - p.pos.z), vis: g._visible(x, r.pos.y + 1.6, z) || g._visible(x, r.pos.y + 0.5, z), runner: r.runner, type: r.type }); return r; };
  const rl = g._relocate; g._relocate = function (z) { const ok = rl.call(g, z); if (ok) relocated++; return ok; };
  const tmp = new T.Vector3(), fw = new T.Vector3(), f2 = new T.Vector3();
  p.script = (dt, pl) => {
    let best = null, bd = 1e9;
    for (const z of Z.list) { if (!z.alive) continue; const d = z.pos.distanceTo(pl.pos); if (d < bd) { bd = d; best = z; } }
    if (g.weapon.ammo === 0) { if (g.weapon.reserve > 0) pl.input.reload = true; else if (g.weapon.id === 'rifle') pl.input.slot = 2; }
    if (!best) return;
    if (best.bones.Head) { best.root.updateWorldMatrix(true, true); best.bones.Head.getWorldPosition(tmp); tmp.y += 0.07; } else tmp.set(best.pos.x, best.pos.y + 1.55, best.pos.z);
    pl.lookAt(tmp, 16, dt);
    if (bd > 75) return;
    pl.input.ads = bd > 10;
    const err = Math.acos(Math.min(1, pl.forward(f2).dot(fw.copy(tmp).sub(pl.eye).normalize())));
    if (err < Math.min(0.2, 0.1 / bd) && g.collision.lineOfSight(pl.eye, tmp)) { pl.input.fire = g.weapon.def.mode === 'auto' || (tick++ & 1) === 0; shotsFired++; if (g.weapon.id === 'pistol') pistolShots++; }
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
  for (const s of spawns) { const k = 'w' + s.w; const e = per[k] || (per[k] = { n: 0, minD: 1e9, sumD: 0, visible: 0 }); e.n++; e.minD = Math.min(e.minD, s.d); e.sumD += s.d; if (s.vis) e.visible++; e[s.type] = (e[s.type] || 0) + 1; }
  for (const k in per) { per[k].minD = r2(per[k].minD, 0); per[k].meanD = r2(per[k].sumD / per[k].n, 0); delete per[k].sumD; }
  return { wanderers, waves, cleared, spawns: per, stats: g.stats, summary: g.summary(), maxAlive, relocated, simSeconds: r2(simT, 0), msPerUpdate: r2(ms / (simT * 30), 2), list: Z.list.length, pool: Z.pool.length, reachedWave: g.wave, weaponAtEnd: g.weapon.id, pistolTriggerPulls: pistolShots, cratesStanding: g.supply.crates.length, playerAt: pt.arr(p.pos) };
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

// ------------------------------------------------------------------ iteration 2: look, movement, weapons, infected, blood, survival
// Mouse look through the real event path (pointer lock is pretended, time stamps are set by hand).
const S_TURN = async () => {
  const vm = __vm, g = vm.game, p = g.player, T = vm.THREE, cam = vm.engine.camera, gl = vm.engine.gl, { r2 } = pt; const o = {};
  pt.reset(15, -55, 0);
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => vm.engine.canvas });
  p.script = null; p.keys.clear(); p.mouseDown = [false, false, false];
  const e = new T.Euler(0, 0, 0, 'YXZ');
  const camYaw = () => { cam.updateMatrixWorld(); e.setFromQuaternion(cam.quaternion, 'YXZ'); return e.y; };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)), deg = 57.2958;
  let clock = 1000;
  const send = (dx, dy = 0, ms = 1000 / 60) => { clock += ms; const ev = new MouseEvent('mousemove', { movementX: dx, movementY: dy }); Object.defineProperty(ev, 'timeStamp', { value: clock }); document.dispatchEvent(ev); };
  const s = p.lookScale();
  pt.sim(0.4);
  // 1. a fast sweep right, then left (peak about 1500 degrees per second): the camera must follow count for count
  let yaw0 = p.yaw, sum = 0, maxErr = 0, maxStep = 0, prev = camYaw(), rej = p.mouse.rejected;
  for (let k = 0; k < 240; k++) {
    const c = Math.round(200 * Math.sin(Math.PI * k / 120) ** 2) * (k < 120 ? 1 : -1);
    send(c); sum += c; g.update(1 / 60);
    const y = camYaw(); maxErr = Math.max(maxErr, Math.abs(wrap(y - (yaw0 - sum * s)))); maxStep = Math.max(maxStep, Math.abs(wrap(y - prev))); prev = y;
  }
  o.sweep = { events: 240, peakDegPerSec: r2(200 * s * 60 * deg, 0), maxErrDeg: +(maxErr * deg).toFixed(6), largestFrameStepDeg: r2(maxStep * deg), largestInputStepDeg: r2(200 * s * deg), rejected: p.mouse.rejected - rej };
  // 2. a flick at full speed from rest
  pt.sim(0.4); yaw0 = p.yaw; sum = 0; rej = p.mouse.rejected; let behind = 0;
  for (const c of [0, 0, 420, 440, 430, 380, 200, 60, 0, 0]) { send(c); sum += c; g.update(1 / 60); if (Math.abs(wrap(camYaw() - (yaw0 - sum * s))) > 1e-6) behind++; }
  o.flick = { totalDeg: r2(sum * s * deg), finalErrDeg: +(Math.abs(wrap(camYaw() - (yaw0 - sum * s))) * deg).toFixed(6), framesBehind: behind, rejected: p.mouse.rejected - rej };
  // 3. single bogus events inside a steady turn (what the accelerated, re-centred cursor path produces)
  pt.sim(0.4); yaw0 = p.yaw; sum = 0; rej = p.mouse.rejected; let raw = 0; maxErr = 0;
  const spikes = { 30: 4000, 60: -2500, 90: 900 };
  for (let k = 0; k < 120; k++) {
    const c = spikes[k] ?? 60;
    send(c); sum += 60; raw += c; g.update(1 / 60);
    if (k > 92 || !(k % 30 < 2)) maxErr = Math.max(maxErr, Math.abs(wrap(camYaw() - (yaw0 - sum * s))));
  }
  o.spikes = { injected: 3, rejected: p.mouse.rejected - rej, turnedDeg: r2((yaw0 - p.yaw) * deg), cleanTurnDeg: r2(sum * s * deg), errDeg: +(maxErr * deg).toFixed(4), unfilteredWouldTurnDeg: r2(raw * s * deg) };
  // 4. walking and firing while turning: bob and recoil move the picture a little, the aim itself stays exact
  pt.sim(0.6); yaw0 = p.yaw; sum = 0; let dev = 0; p.keys.add('KeyW'); p.mouseDown[0] = true;
  for (let k = 0; k < 120; k++) { const c = Math.round(120 * Math.sin(Math.PI * k / 60)); send(c); sum += c; g.update(1 / 60); dev = Math.max(dev, Math.abs(wrap(camYaw() - p.yaw))); }
  p.keys.clear(); p.mouseDown[0] = false;
  o.walkAndFire = { aimErrDeg: +(Math.abs(wrap(p.yaw - (yaw0 - sum * s))) * deg).toFixed(6), pictureOffsetMaxDeg: r2(dev * deg), shots: 30 - g.weapon.ammo };
  // 5. frame time standing still and turning fast, same place (GPU-synced per frame)
  pt.sim(1.0);
  const px = new Uint8Array(4);
  const run = (turn) => { const ts = []; for (let k = 0; k < 60; k++) { if (turn) send(turn); const t0 = performance.now(); vm.step(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return `${r2(ts[30], 1)} / ${r2(ts[56], 1)} / ${r2(ts[59], 1)}`; };
  run(0);
  o.frameMsMedianP95Max = { still: run(0), turning540: run(160), still2: run(0), turning1700: run(500) };
  delete document.pointerLockElement;
  // 6. the lock asks for raw mouse input and falls back when the browser has none
  const cv = vm.engine.canvas, calls = [];
  const fake = (ok) => (opt) => { calls.push(opt ? JSON.stringify(opt) : 'plain'); return opt && opt.unadjustedMovement && !ok ? Promise.reject(Object.assign(new Error('no raw input'), { name: 'NotSupportedError' })) : Promise.resolve(); };
  cv.requestPointerLock = fake(false); p.rawInput = null; p.requestLock(); await new Promise((r) => setTimeout(r, 30));
  const unsupported = { calls: calls.join(' > '), rawInput: p.rawInput };
  calls.length = 0; cv.requestPointerLock = fake(true); p.rawInput = null; p.requestLock(); await new Promise((r) => setTimeout(r, 30));
  o.lock = { unsupported, supported: { calls: calls.join(' > '), rawInput: p.rawInput } };
  delete cv.requestPointerLock; p.rawInput = null;
  p.script = () => {};
  return o;
};

const S_FOV = () => {
  const vm = __vm, g = vm.game, p = g.player, cam = vm.engine.camera, wc = vm.engine.weaponCamera, { r2 } = pt; const o = {};
  pt.reset();
  for (const f of [60, 72, 110, 140]) {
    g.settings.fov = f; p.script = () => {}; pt.sim(0.8); const hip = cam.fov;
    p.script = (dt, pl) => { pl.input.ads = true; }; pt.sim(0.9);
    o['set' + f] = { camera: r2(hip, 1), aiming: r2(cam.fov, 1), weaponCamera: wc.fov, lookScaleAiming: r2(p.lookScale() / (0.0022 * g.settings.sensitivity), 3) };
  }
  g.settings.fov = 72; p.script = () => {}; pt.sim(0.6);
  return o;
};

const S_MOVE = () => {
  const vm = __vm, g = vm.game, p = g.player, col = g.collision, terr = vm.terrain, T = vm.THREE, cam = vm.engine.camera, { r2 } = pt; const o = {};
  // ---- falls: nothing below 3.5 m, lethal about 14 m, a roll within 0.3 s of landing halves it
  const fall = (H, rollAt) => {
    pt.reset(); p.script = () => {};
    p.pos.y += H; p.fallTop = p.pos.y; p.onGround = false; p.vel.set(0, 0, 0);
    const tLand = Math.sqrt(2 * H / 22); let t = 0, pressed = false;
    p.script = (dt, pl) => { if (rollAt !== null && !pressed && t >= tLand + rollAt) { pl.input.roll = true; pressed = true; } };
    pt.sim(tLand + 1.3, 1 / 120, (tt) => { t = tt; });
    return `${r2(100 - p.health, 1)}${p.alive ? '' : ' dead'}${p.lastFall && p.lastFall.rolled ? ' rolled' : ''}`;
  };
  o.fallDamage = { m3: fall(3, null), m4: fall(4, null), m6: fall(6, null), m8: fall(8, null), m11: fall(11, null), m14: fall(14.2, null), m8_rollBefore: fall(8, -0.2), m8_rollAfter: fall(8, 0.15), m8_rollTooLate: fall(8, 0.5), m14_roll: fall(14.2, -0.1) };
  // ---- dodge roll
  pt.reset(); let press = false, strafe = 0, fwd = 1;
  p.script = (dt, pl) => { pl.input.fwd = fwd; pl.input.strafe = strafe; if (press) { pl.input.roll = true; press = false; } };
  pt.sim(1.0); const a0 = p.pos.clone(); press = true;
  let tRoll = 0, minEye = 9, maxTilt = 0, maxPitch = 0, started = false, endPos = null, canFire = false;
  pt.sim(1.0, 1 / 120, (tt, dt) => { if (p.rolling) { started = true; tRoll += dt; minEye = Math.min(minEye, p.eye.y - p.pos.y); maxTilt = Math.max(maxTilt, Math.abs(cam.rotation.z)); maxPitch = Math.max(maxPitch, Math.abs(cam.rotation.x - p.pitch)); canFire = canFire || g.weapon.canFire(); } else if (started && !endPos) endPos = p.pos.clone(); });
  o.roll = { time: r2(tRoll), dist: r2(pt.xz(a0, endPos || p.pos)), lowestEye: r2(minEye), maxTiltDeg: r2(maxTilt * 57.3, 1), maxDipDeg: r2(maxPitch * 57.3, 1), canFireDuring: canFire };
  const n0 = p.rolls; press = true; pt.sim(0.4); const early = p.rolls - n0; pt.sim(0.6); press = true; pt.sim(0.3);
  o.roll.cooldown = { pressAt1sIgnored: early === 0, pressAt2sAccepted: p.rolls - n0 === 1 };
  pt.sim(2.4); fwd = 0; strafe = 1; pt.sim(0.6); press = true; let tilt = 0; pt.sim(0.7, 1 / 120, () => { if (Math.abs(cam.rotation.z) > Math.abs(tilt)) tilt = cam.rotation.z; });
  o.roll.rightRollTiltDeg = r2(tilt * 57.3, 1);
  // ---- prone
  pt.reset(); let toggle = true, jump = false, crouch = false; fwd = 0;
  p.script = (dt, pl) => { if (toggle) { pl.input.prone = true; toggle = false; } pl.input.fwd = fwd; pl.input.jump = jump; pl.input.crouch = crouch; };
  let tDown = null; pt.sim(1.5, 1 / 60, (tt) => { if (tDown === null && p.prone > 0.99) tDown = tt; });
  o.prone = { eye: r2(p.eye.y - p.pos.y), stance: p.stance, downAfter: r2(tDown) };
  fwd = 1; pt.sim(0.6); let a = p.pos.clone(); pt.sim(2); o.prone.crawl = r2(pt.xz(a, p.pos) / 2); fwd = 0;
  jump = true; pt.sim(0.05); jump = false; let tUp = null, air = false; pt.sim(1.5, 1 / 60, (tt) => { air = air || !p.onGround; if (tUp === null && p.h > 1.79) tUp = tt; });
  o.prone.spaceStandsUp = { stance: p.stance, eye: r2(p.eye.y - p.pos.y), upAfter: r2(tUp), jumped: air };
  // ---- ceilings: a slab 1.0 m over the ground and one at 1.45 m; standing up needs the room
  {
    const at = (d) => [-58 + 0.5227 * d, 96 - 0.8525 * d], along = () => r2((p.pos.x + 58) * 0.5227 - (p.pos.z - 96) * 0.8525, 1), eye = () => r2(p.eye.y - p.pos.y);
    const mk = (clear, d) => { const [x, z] = at(d); const m = new T.Mesh(new T.BoxGeometry(5, 0.3, 4)); m.position.set(x, terr.heightAt(x, z) + clear + 0.15, z); m.rotation.y = -0.55; m.userData.surface = 'stone'; m.updateMatrixWorld(true); return m; };
    col.build([...vm.world.colliders, mk(1.0, 6), mk(1.45, 16)]);
    pt.reset(...at(2.6), -0.55); toggle = true; fwd = 0; jump = false; crouch = false;
    p.script = (dt, pl) => { if (toggle) { pl.input.prone = true; toggle = false; } pl.input.fwd = fwd; pl.input.jump = jump; pl.input.crouch = crouch; };
    pt.sim(1.2); fwd = 1; pt.sim(3.9); fwd = 0;
    const under = { at: along(), eye: eye() };
    toggle = true; pt.sim(1.5); const tried = { eye: eye(), bodyHeight: r2(p.h), blocked: p.blocked };
    jump = true; pt.sim(0.3); jump = false; const hop = { bodyHeight: r2(p.h), onGround: p.onGround };
    fwd = 1; pt.sim(2.6); fwd = 0; pt.sim(0.8);
    o.crawlSpace1m = { under, standUpTried: tried, jumpTried: hop, out: { at: along(), eye: eye(), stance: p.stance } };
    crouch = true; fwd = 1; pt.sim(Math.max(0.5, (16 - along()) / 1.75 + 0.2)); fwd = 0;
    const underB = { at: along(), eye: eye() };
    crouch = false; pt.sim(1.0); const rel = { eye: eye(), bodyHeight: r2(p.h), blocked: p.blocked };
    fwd = 1; pt.sim(2.2); fwd = 0; pt.sim(0.6);
    o.lowCeiling145 = { under: underB, crouchReleased: rel, out: { at: along(), eye: eye(), stance: p.stance } };
    col.build(vm.world.colliders);
  }
  // ---- health: four segments, regeneration stops at the top of the segment, bandages
  pt.reset(); p.script = () => {}; p.bandages = 2;
  p.damage(40, new T.Vector3(1, 0, 0)); const h1 = p.health; pt.sim(4.5); const h1b = p.health; pt.sim(8); const h2 = p.health, cap2 = p.regenCap;
  p.damage(25, null); const h3 = p.health; pt.sim(9); const h4 = p.health;
  let b = true; p.script = (dt, pl) => { if (b) { pl.input.bandage = true; b = false; } };
  pt.sim(1.0); const mid = { progress: r2(p.bandaging), health: r2(p.health, 0), canFire: g.weapon.canFire(), weaponLowered: r2(g.weapon.lowerT) };
  pt.sim(0.8); const after1 = { health: r2(p.health, 0), bandages: p.bandages };
  b = true; pt.sim(1.8); const after2 = { health: r2(p.health, 0), bandages: p.bandages };
  b = true; pt.sim(0.3); const none = p.bandaging;
  o.health = { after40: h1, at4_5s: r2(h1b, 1), regeneratedTo: r2(h2, 1), cap: cap2, after25more: h3, staysAt: r2(h4, 1), bandageMid: mid, afterBandage: after1, afterSecond: after2, atFullHealthIgnored: none === 0, max: p.bandageMax };
  // ---- where the damage came from, for the HUD arcs (0 = ahead, + = right)
  pt.reset(); p.script = () => {}; pt.sim(0.1);
  const right = new T.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
  p.damage(10, right.clone().negate()); pt.sim(0.05); const a1 = p.damageArcs[0].angle;
  p.yaw -= Math.PI / 2; pt.sim(0.05); const a2 = p.damageArcs[0].angle;
  p.damage(10, new T.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw))); pt.sim(0.05); const a3 = p.damageArcs[0].angle;
  p.damage(5, null, 'fall'); pt.sim(0.05);
  o.damageArcs = { attackerOnTheRightDeg: r2(a1 * 57.3, 0), afterTurningToFaceItDeg: r2(a2 * 57.3, 0), fromBehindDeg: r2(Math.abs(a3) * 57.3, 0), count: p.damageArcs.length, fallIsDirectional: p.damageArcs[0].directional, fields: Object.keys(p.damageArcs[0]).join(',') };
  pt.sim(2); o.damageArcs.afterTwoSeconds = p.damageArcs.length;
  pt.reset();
  return o;
};

const S_ARMS = () => {
  const vm = __vm, g = vm.game, p = g.player, w = g.weapon, T = vm.THREE, cam = vm.engine.camera, terr = vm.terrain, Z = g.zombies, fx = g.fx, { r2 } = pt; const o = {};
  pt.reset(); Z.passive = true; Z.noCull = true;
  const shots = []; const orig = g.shoot;
  g.shoot = function (...a) { const h = orig.apply(g, a); shots.push({ t: w.time, id: w.id, h }); return h; };
  const fX = -Math.sin(p.yaw), fZ = -Math.cos(p.yaw);
  const far = new T.Vector3(p.pos.x + fX * 60, 0, p.pos.z + fZ * 60); far.y = terr.heightAt(far.x, far.z) + 2;
  const I = { fire: false, press: 0, rapid: false, ads: false, reload: false, slot: 0, next: false, prone: false, crouch: false, fwd: 0, aim: far, n: 0 };
  p.script = (dt, pl) => {
    if (I.aim) pl.lookAt(typeof I.aim === 'function' ? I.aim() : I.aim, 999, dt);
    pl.input.fire = I.fire || I.press-- > 0 || (I.rapid && (I.n++ & 1) === 0);
    pl.input.ads = I.ads; pl.input.reload = I.reload; pl.input.crouch = I.crouch; pl.input.fwd = I.fwd;
    if (I.slot) { pl.input.slot = I.slot; I.slot = 0; }
    if (I.next) { pl.input.next = true; I.next = false; }
    if (I.prone) { pl.input.prone = true; I.prone = false; }
  };
  const until = (cond, max = 6, dt = 1 / 120) => { let t = max; pt.sim(max, dt, (tt) => { if (cond()) { t = tt; return false; } }); return t; };
  const take = (slot, id) => { I.slot = slot; until(() => w.id === id && w.ready, 3); pt.sim(0.2); };
  pt.sim(0.3);
  o.table = w.inventory().map((s) => { const d = w.state[s.id].def, v = w.views[s.id]; return `${s.id}: ${d.mode}, mag ${s.mag}, reserve ${Number.isFinite(s.reserve) ? s.reserve : 'unlimited'}, ${d.damage} x${d.head} head, model ${v.standIn ? 'rifle stand-in' : 'own'} ${v.mixer ? 'with clips' : 'procedural'}`; });
  // switching: holster 0.3 s, then draw (0.45 s, pistol 0.3 s); the trigger does nothing in between
  const swap = (trigger, to) => { const n0 = shots.length; trigger(); I.fire = true; const a = until(() => w.id === to, 3), b = until(() => w.ready, 3); const blocked = shots.length - n0; I.fire = false; pt.sim(0.3); return { holster: r2(a), total: r2(a + b), shotsWhileSwitching: blocked }; };
  o.switch = { key2_pistol: swap(() => { I.slot = 2; }, 'pistol'), keyQ_sniper: swap(() => { I.next = true; }, 'sniper'), keyQ_rifle: swap(() => { I.next = true; }, 'rifle') };
  I.slot = 1; pt.sim(0.1); o.switch.sameSlotIgnored = !w.switching;
  const burst = (sec) => { const n0 = shots.length; I.fire = true; pt.sim(sec, 1 / 120); I.fire = false; return shots.length - n0; };
  const reload = () => { const a0 = w.ammo; I.reload = true; pt.sim(0.02, 1 / 120); I.reload = false; const name = w.act ? w.act.name : 'none'; let fill = null; const t = until(() => { if (fill === null && w.ammo > a0) fill = w.act ? w.act.t : -1; return !w.reloading; }, 6); return { clip: name, time: r2(t + 0.02), magazineFullAt: r2(fill), ammo: w.ammo, reserve: Number.isFinite(w.reserve) ? w.reserve : 'unlimited' }; };
  // rifle: automatic, 600 rounds a minute
  w.reset(); pt.sim(0.3); const tr0 = fx.tracerN;
  o.rifle = { shotsIn1s: burst(1.0), tracers: fx.tracerN - tr0 };
  pt.sim(0.5); o.rifle.reload = reload(); w.ammo = 0; o.rifle.reloadEmpty = reload(); o.rifle.events = w.eventLog.slice(-5).join(' ');
  // pistol: one shot per pull, unlimited reserve
  take(2, 'pistol');
  o.pistol = { shotsTriggerHeld1s: burst(1.0) };
  pt.sim(0.3); let n1 = shots.length; I.rapid = true; pt.sim(1.0, 1 / 120); I.rapid = false; o.pistol.shotsRapidPulls1s = shots.length - n1;
  pt.sim(0.4); o.pistol.reload = reload(); w.ammo = 0; o.pistol.reloadEmpty = reload(); o.pistol.events = w.eventLog.slice(-4).join(' ');
  // sniper: bolt action, 1.1 s cycle, the case leaves when the bolt comes back, a faint trace
  take(3, 'sniper');
  const c0 = fx.caseI, tr1 = fx.tracerN; n1 = shots.length; I.press = 2; pt.sim(0.05, 1 / 120); const tShell = until(() => fx.caseI > c0, 2);
  o.sniper = { shots: shots.length - n1, caseEjectedAfter: r2(tShell + 0.05), boltEvents: w.eventLog.slice(-2).join(' ') };
  pt.sim(1.2); n1 = shots.length; I.rapid = true; pt.sim(3.4, 1 / 120); I.rapid = false; o.sniper.shotsIn3_4s = shots.length - n1; o.sniper.tracers = fx.tracerN - tr1; o.sniper.ammoLeft = w.ammo;
  pt.sim(1.3); o.sniper.reload = reload();
  // each weapon keeps its own ammunition
  w.reset(); pt.sim(0.3); burst(0.45); const rifleLeft = w.ammo; take(2, 'pistol'); I.press = 2; pt.sim(0.3); const pistolLeft = w.ammo; take(1, 'rifle');
  o.ownAmmo = { rifleBeforeAfter: [rifleLeft, w.ammo], pistol: [pistolLeft, w.state.pistol.ammo], sniper: w.state.sniper.ammo };
  // recoil: a climb that eases off, a sideways drift in a fixed rhythm; the same twice, and it resets
  const pattern = () => { w.reset(); I.aim = null; pt.sim(1.0); const path = []; let n = shots.length; I.fire = true; pt.sim(1.52, 1 / 120, () => { if (shots.length > n) { n = shots.length; path.push([p.recoilPitch * 1000, p.recoilYaw * 1000]); } }); I.fire = false; const tReset = until(() => p.recoilPitch < 0.003 && w.shotIdx === 0, 3); I.aim = far; return { path, tReset }; };
  const A = pattern(), B = pattern();
  const colOf = (P, k) => P.path.map((v) => v[k]);
  const corr = (x, y) => { const n = Math.min(x.length, y.length), mx = x.slice(0, n).reduce((a, b) => a + b) / n, my = y.slice(0, n).reduce((a, b) => a + b) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
  const inc = colOf(A, 0).map((v, i, a) => (i ? v - a[i - 1] : v));
  o.recoil = { shots: A.path.length, climbMrad: A.path.map((v) => r2(v[0], 1)).join(' '), driftMrad: A.path.map((v) => r2(v[1], 1)).join(' '), firstStepMrad: r2(inc[0], 1), lastStepMrad: r2(inc[inc.length - 1], 1), sameTwiceClimb: r2(corr(colOf(A, 0), colOf(B, 0)), 3), sameTwiceDrift: r2(corr(colOf(A, 1), colOf(B, 1)), 3), resetAfter: r2(A.tReset) };
  // spread: the cone opens with fire and with movement
  w.reset(); pt.sim(0.6); const sp = {}; sp.hip = w.spread; I.ads = true; pt.sim(0.6); sp.aiming = w.spread; I.ads = false; pt.sim(0.4);
  burst(0.65); sp.hipAfter7Shots = w.spread; pt.sim(1.2); sp.recovered = w.spread;
  I.fwd = 1; I.aim = null; pt.sim(1.0); sp.walking = w.spread; I.fwd = 0; I.crouch = true; pt.sim(0.8); sp.crouched = w.spread; I.crouch = false; pt.sim(0.5);
  o.spreadMrad = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, r2(v * 1000, 2)]));
  // sniper scope: the world at 10 degrees behind a reticle and a dark surround; sway by stance
  take(3, 'sniper'); pt.sim(0.3);
  const hipFov = cam.fov; I.ads = true; const tScope = until(() => w.scoped && Math.abs(cam.fov - 10) < 0.3, 3); pt.sim(0.5);
  const e = new T.Euler(0, 0, 0, 'YXZ');
  const sway = (sec) => { const ys = [], ps = []; pt.sim(sec, 1 / 60, () => { cam.updateMatrixWorld(); e.setFromQuaternion(cam.quaternion, 'YXZ'); ys.push(e.y); ps.push(e.x); }); const sd = (a) => { const m = a.reduce((x, y) => x + y) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); }; const pp = (a) => Math.max(...a) - Math.min(...a); return { rmsMrad: r2(Math.hypot(sd(ys), sd(ps)) * 1000, 2), swingPercentOfView: r2((100 * Math.max(pp(ys), pp(ps))) / ((cam.fov * Math.PI) / 180), 1) }; };
  o.scope = { hipFov: r2(hipFov, 1), scopedFov: r2(cam.fov, 1), time: r2(tScope), maskDrawn: w.scope.visible && w.scopeSolid.visible, modelHidden: !w.rig.visible, weaponCameraFov: vm.engine.weaponCamera.fov, lookScale: r2(p.lookScale() / (0.0022 * g.settings.sensitivity), 3), spreadMrad: r2(w.spread * 1000, 3), hudShouldHideCrosshair: w.scoped };
  o.sway = { standing: sway(8) };
  I.crouch = true; pt.sim(1.0); o.sway.crouched = sway(8); I.crouch = false;
  I.prone = true; pt.sim(2.4); o.sway.proneOnBipod = sway(8); o.sway.bipodDown = w.bipod; o.sway.proneEye = r2(p.eye.y - p.pos.y);
  I.fwd = 1; pt.sim(0.8); o.sway.bipodWhileCrawling = w.bipod; I.fwd = 0;
  I.prone = true; I.ads = false; pt.sim(1.6);
  // penetration: four in a row, the sniper's bullet stops in the third
  const row = (n, d0) => { const zs = []; for (let i = 0; i < n; i++) { const d = d0 + i * 1.3; const z = Z.spawn(p.pos.x + fX * d, p.pos.z + fZ * d, { type: 'walker', yaw: Math.atan2(-fX, -fZ), variant: i % 3 }); pt.still(z); zs.push(z); } return zs; };
  const chest = (z) => { z.root.updateWorldMatrix(true, true); return z.bones.Chest.getWorldPosition(new T.Vector3()); };
  const head = (z) => { z.root.updateWorldMatrix(true, true); const h = z.bones.Head.getWorldPosition(new T.Vector3()); h.y += 0.09; return h; };
  const dealt = () => { const l = shots[shots.length - 1], hs = l && l.h && l.h.hits; return hs && hs.length ? hs.map((h) => `${h.part} ${r2(h.dealt, 0)}`).join(', ') : 'miss'; };
  let zs = row(4, 12); pt.sim(0.5); I.aim = () => chest(zs[0]); I.ads = true; until(() => w.scoped, 3); pt.sim(0.6);
  I.press = 2; pt.sim(0.3);
  o.pierce = { sniper: zs.map((z) => (z.alive ? r2(z.health, 0) : 'dead')).join(' / '), dealt: dealt() };
  Z.clear(); I.ads = false; take(1, 'rifle'); zs = row(3, 12); pt.sim(0.4); I.aim = () => chest(zs[0]); I.ads = true; pt.sim(0.6); I.press = 2; pt.sim(0.3);
  o.pierce.rifle = zs.map((z) => r2(z.health, 0)).join(' / ');
  o.damage = { rifleBody: dealt() };
  I.ads = false; take(2, 'pistol'); I.ads = true; pt.sim(0.5); I.press = 2; pt.sim(0.3); o.damage.pistolBody = dealt();
  I.aim = () => head(zs[0]); pt.sim(0.4); I.press = 2; pt.sim(0.3); o.damage.pistolHead = dealt();
  I.ads = false; take(1, 'rifle'); I.aim = () => head(zs[1]); I.ads = true; pt.sim(0.6); I.press = 2; pt.sim(0.3); o.damage.rifleHead = dealt();
  I.ads = false; I.aim = far; pt.sim(0.3);
  // falloff beyond 60 m: a body 105 m away takes 80 % from the rifle
  Z.clear(); const zf = row(1, 10)[0]; pt.sim(0.3);
  { const c = chest(zf), d = new T.Vector3(fX, -0.35, fZ).normalize(), org = c.clone().addScaledVector(d, -105), st = w.state.rifle; const hf = orig.call(g, org, d, st.def, st); o.falloff105m = hf && hf.zombie ? { part: hf.part, share: r2(hf.dealt / (36 * (hf.part === 'head' ? 4 : hf.mult)), 2), dist: r2(hf.distance, 0) } : 'missed'; }
  Z.clear();
  // view-model contract: a model with clips and a sidecar drives draw, fire, shell, reload and the refill
  {
    const scene = new T.Group(), mat = new T.MeshStandardMaterial({ color: 0x222222 });
    const node = (name, x, y, z, parent = scene, mesh = null) => { const n = mesh ? new T.Mesh(new T.BoxGeometry(...mesh), mat) : new T.Object3D(); n.name = name; n.position.set(x, y, z); parent.add(n); return n; };
    const wp = node('Weapon', 0, 0, 0);
    node('Frame', 0, 0, 0, wp, [0.03, 0.12, 0.18]); node('Slide', 0, 0.05, -0.02, wp, [0.028, 0.03, 0.2]); node('Magazine', 0, -0.05, 0.02, wp, [0.022, 0.1, 0.04]); node('Trigger', 0, -0.01, -0.01, wp, [0.006, 0.02, 0.01]);
    node('Muzzle', 0, 0.05, -0.12, wp); node('Eject', 0.012, 0.06, -0.02, wp); node('SightRear', 0, 0.07, 0.06, wp); node('SightFront', 0, 0.07, -0.1, wp);
    const V = (name, times, vals) => new T.VectorKeyframeTrack(name + '.position', times, vals);
    const mag = (D) => V('Magazine', [0, 0.4, 1.0, D], [0, -0.05, 0.02, 0, -0.25, 0.02, 0, -0.25, 0.02, 0, -0.05, 0.02]);
    const anims = [
      new T.AnimationClip('Idle', 2, [V('Trigger', [0, 2], [0, -0.01, -0.01, 0, -0.01, -0.01])]),
      new T.AnimationClip('Fire', 0.12, [V('Slide', [0, 0.03, 0.12], [0, 0.05, -0.02, 0, 0.05, 0.02, 0, 0.05, -0.02])]),
      new T.AnimationClip('Reload', 1.7, [mag(1.7)]), new T.AnimationClip('ReloadEmpty', 2.1, [mag(2.1)]),
      new T.AnimationClip('Draw', 0.3, [V('Weapon', [0, 0.3], [0, -0.3, 0, 0, 0, 0])]), new T.AnimationClip('Holster', 0.3, [V('Weapon', [0, 0.3], [0, 0, 0, 0, -0.3, 0])]),
      new T.AnimationClip('Sprint', 0.8, [V('Weapon', [0, 0.4, 0.8], [0, 0, 0, 0.02, -0.02, 0, 0, 0, 0])]),
    ];
    const rl = [{ t: 0.3, name: 'mag_out' }, { t: 1.2, name: 'mag_in' }, { t: 1.25, name: 'ammo' }];
    const anim = { clips: { Reload: { duration: 1.7, events: rl }, ReloadEmpty: { duration: 2.1, events: [...rl, { t: 1.8, name: 'slide_release' }] }, Fire: { duration: 0.12, events: [{ t: 0.03, name: 'shell' }] } } };
    w.reset(); pt.sim(0.2); w.adopt('pistol', { scene, animations: anims, anim });
    const nodes = w.views.pistol.nodes; let lowMax = 0, drawY = 0; I.slot = 2;
    until(() => { if (w.id === 'pistol') { lowMax = Math.max(lowMax, w.lowerT); drawY = Math.min(drawY, nodes.Weapon.position.y); } return w.id === 'pistol' && w.ready; }, 3);
    pt.sim(0.3); const cc = fx.caseI; I.press = 2; let slideMax = -1, shellFrame = null, fr = 0;
    pt.sim(0.15, 1 / 120, () => { fr++; slideMax = Math.max(slideMax, nodes.Slide.position.z); if (shellFrame === null && fx.caseI > cc) shellFrame = fr; });
    w.ammo = 9; I.reload = true; pt.sim(0.02, 1 / 120); I.reload = false; let magMin = 0, fill = null;
    const tR = until(() => { magMin = Math.min(magMin, nodes.Magazine.position.y); if (fill === null && w.ammo === 15) fill = w.act ? w.act.t : -1; return !w.reloading; }, 4);
    o.clipDriven = { mixer: !!w.views.pistol.mixer, drawClipLiftsWeaponFrom: r2(drawY, 2), proceduralLowerDuringDraw: r2(lowMax, 2), slideTravelCm: r2((slideMax + 0.02) * 100, 1), caseOnFrame: shellFrame, reloadTime: r2(tR + 0.02), magazineDropCm: r2(-(magMin + 0.05) * 100, 0), magazineFullAt: r2(fill), events: w.eventLog.slice(-3).join(' ') };
    take(1, 'rifle'); w.adopt('pistol', null); o.clipDriven.standInRestored = w.views.pistol.standIn;
  }
  g.shoot = orig; w.reset(); Z.clear();
  return o;
};

// scoped view of an infected down the street (for the screenshot)
const S_VIEW_SCOPE = () => {
  const vm = __vm, g = vm.game, p = g.player, w = g.weapon, Z = g.zombies, T = vm.THREE;
  g.start(); pt.hold(); Z.clear(); Z.passive = true; Z.noCull = true; pt.god = false;
  const fX = -Math.sin(p.yaw), fZ = -Math.cos(p.yaw);
  let z = null;
  for (const d of [36, 32, 28, 24, 20]) { const x = p.pos.x + fX * d, zz = p.pos.z + fZ * d; if (Z.flow.walkable(x, zz)) { z = Z.spawn(x, zz, { type: 'walker', yaw: Math.atan2(-fX, -fZ), variant: 1 }); pt.still(z); break; } }
  let slot = 3; const tgt = new T.Vector3();
  p.script = (dt, pl) => { if (z) { z.root.updateWorldMatrix(true, true); z.bones.Chest.getWorldPosition(tgt); pl.lookAt(tgt, 999, dt); } pl.input.ads = true; if (slot) { pl.input.slot = slot; slot = 0; } };
  pt.sim(2.4);
  return { scoped: w.scoped, fov: pt.r2(vm.engine.camera.fov, 1), infectedAt: z ? pt.r2(pt.xz(z.pos, p.pos), 0) : null, start: pt.arr(p.pos) };
};
const S_VIEW_PRONE = () => {
  const g = __vm.game, p = g.player, w = g.weapon; let prone = true;
  p.script = (dt, pl) => { if (prone) { pl.input.prone = true; prone = false; } };
  pt.sim(2.2);
  return { stance: p.stance, eye: pt.r2(p.eye.y - p.pos.y), bipod: w.bipod, weapon: w.id };
};
const S_VIEW_FIRE = (id) => {
  const vm = __vm, g = vm.game, p = g.player, w = g.weapon, T = vm.THREE;
  g.start(); pt.hold(); g.zombies.clear();
  const far = new T.Vector3(p.pos.x - Math.sin(p.yaw) * 40, p.eye.y + 1, p.pos.z - Math.cos(p.yaw) * 40);
  let slot = { rifle: 1, pistol: 2, sniper: 3 }[id], fire = false;
  p.script = (dt, pl) => { pl.lookAt(far, 999, dt); if (slot) { pl.input.slot = slot; slot = 0; } pl.input.fire = fire; };
  pt.sim(1.6); fire = true; g.update(1 / 60);
  return { weapon: w.id, flash: w.flash.visible, light: Math.round(w.light.intensity) };
};

const S_FEEL = () => {
  const vm = __vm, g = vm.game, p = g.player, w = g.weapon, T = vm.THREE, cam = vm.engine.camera, terr = vm.terrain, fx = g.fx, col = g.collision, { r2 } = pt; const o = {};
  pt.reset();
  const fX = -Math.sin(p.yaw), fZ = -Math.cos(p.yaw);
  const far = new T.Vector3(p.pos.x + fX * 60, 0, p.pos.z + fZ * 60); far.y = terr.heightAt(far.x, far.z) + 2;
  const sky = far.clone(); sky.y += 70;
  const I = { fire: false, press: 0, slot: 0, fwd: 0, aim: far };
  p.script = (dt, pl) => { if (I.aim) pl.lookAt(I.aim, 999, dt); pl.input.fire = I.fire || I.press-- > 0; pl.input.fwd = I.fwd; if (I.slot) { pl.input.slot = I.slot; I.slot = 0; } };
  const take = (slot, id) => { I.slot = slot; pt.sim(3, 1 / 120, () => !(w.id === id && w.ready)); pt.sim(0.3); };
  const ALL = [['rifle', 1], ['pistol', 2], ['sniper', 3]];
  pt.sim(0.4);
  // muzzle flash: bright for one frame, a fading tongue on the second, then gone (light per 60 fps frame)
  o.flash = {};
  for (const [id, slot] of ALL) {
    take(slot, id);
    const seq = []; I.press = 2;
    for (let k = 0; k < 6; k++) { g.update(1 / 60); seq.push(w.flash.visible ? Math.round(w.light.intensity) : 0); }
    const f = w.def.flash;
    o.flash[id] = { lightPerFrame: seq.join(' '), framesLit: seq.filter((v) => v > 0).length, starCm: Math.round(f.star * 100), tongueCm: Math.round(f.tongue[0] * 100), sideJets: !!f.jets };
    pt.sim(1.3);
  }
  // brass: one case from each weapon, followed until it lies still
  o.brass = {};
  const right = new T.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
  for (const [id, slot] of ALL) {
    take(slot, id);
    const c0 = fx.caseI; I.press = 2; let c = null, start = null, t0 = 0, tLand = null, tRest = null;
    pt.sim(6, 1 / 120, (tt) => { if (!c && fx.caseI > c0) { c = fx.cs[c0 % fx.caseMax]; start = c.p.clone(); t0 = tt; } if (c) { if (tLand === null && c.bounces > 0) tLand = tt - t0; if (c.rest) { tRest = tt - t0; return false; } } });
    if (c) { const d = c.p.clone().sub(start); o.brass[id] = { leavesAfter: r2(t0), riseCm: r2((c.peak - start.y) * 100, 0), firstBounceAfter: r2(tLand), atRestAfter: r2(tRest), bounces: c.bounces, metresRight: r2(d.dot(right)), metresForward: r2(d.x * fX + d.z * fZ), aboveFloorMm: r2((c.p.y - col.floorAt(c.p.x, c.p.y + 0.3, c.p.z, 2)) * 1000, 1), size: `${r2(c.s.x)} x ${r2(c.s.z)}` }; } else o.brass[id] = 'no case';
    pt.sim(1.2);
  }
  // smoke: a puff with each shot, and a hot barrel keeps smoking after a burst
  take(1, 'rifle'); I.aim = sky; w.ammo = 30; pt.sim(2.6); const pn0 = fx.n; I.press = 2; g.update(1 / 60); const perShot = fx.n - pn0; pt.sim(2.6);
  I.fire = true; pt.sim(1.2); I.fire = false; pt.sim(0.3); let wisps = 0, lastN = fx.n; const heat0 = w.heat; pt.sim(2.0, 1 / 60, () => { if (fx.n > lastN) wisps += fx.n - lastN; lastN = fx.n; });
  o.smoke = { particlesPerShot: perShot, heatAfter12Rounds: r2(heat0, 1), wispsInNext2s: wisps };
  // impact scaled by calibre: the same patch of ground
  const gp = new T.Vector3(p.pos.x + fX * 9, 0, p.pos.z + fZ * 9); gp.y = terr.heightAt(gp.x, gp.z);
  o.impactParticles = {};
  for (const id of ['pistol', 'rifle', 'sniper']) { pt.sim(2.6); const n0 = fx.n, d = gp.clone().sub(p.eye).normalize(); const h = g.shoot(p.eye.clone(), d, w.state[id].def, w.state[id]); o.impactParticles[id] = `${fx.n - n0} on ${h && h.surface}`; }
  // the walking bob is held down while firing
  w.ammo = 30; I.fwd = 1; pt.sim(1.0); let b0 = 0; pt.sim(1.5, 1 / 60, () => { b0 = Math.max(b0, Math.abs(p.bob.y)); });
  I.fire = true; pt.sim(0.4); let b1 = 0; pt.sim(1.5, 1 / 60, () => { b1 = Math.max(b1, Math.abs(p.bob.y)); }); I.fire = false; I.fwd = 0;
  o.bobMm = { walking: r2(b0 * 1000, 1), walkingAndFiring: r2(b1 * 1000, 1) };
  // screen shake and field-of-view punch settle fast (per weapon, from the hip)
  o.punch = {};
  for (const [id, slot] of ALL) {
    pt.sim(1.0); take(slot, id); pt.sim(0.5);
    const f0 = cam.fov; I.press = 2; let peak = 0, tFov = null, sh = 0, tSh = null;
    pt.sim(1.0, 1 / 120, (tt) => { const d = cam.fov - f0; peak = Math.max(peak, d); sh = Math.max(sh, p.fireShake); if (tFov === null && tt > 0.04 && Math.abs(d) < 0.03) tFov = tt; if (tSh === null && tt > 0.02 && p.fireShake < 0.05) tSh = tt; });
    o.punch[id] = { fovPeakDeg: r2(peak), fovSettledAfter: r2(tFov), shakePeak: r2(sh), shakeSettledAfter: r2(tSh), firstKickMrad: r2(w.def.recoil.v0 * 1000, 1) };
  }
  take(1, 'rifle'); w.reset();
  return o;
};

const S_INFECTED = () => {
  const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, T = vm.THREE, terr = vm.terrain, col = g.collision, fx = g.fx, { r2 } = pt; const o = {};
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const ahead = () => [-Math.sin(p.yaw), -Math.cos(p.yaw)];
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y) / a.length : 0);
  o.models = { loaded: Object.keys(Z.sets).join(','), clipSpeed: Object.fromEntries(Object.entries(Z.clipSpeed).map(([k, v]) => [k, r2(v)])), height: r2(Z.base.height) };
  o.types = {};
  for (const type of ['walker', 'runner', 'brute', 'boss']) {
    pt.reset(); Z.noCull = true; pt.god = true; p.script = () => {};
    const [fX, fZ] = ahead();
    // 34 m out and facing away: it has to turn round, get going and come in
    const z = Z.spawn(p.pos.x + fX * 34, p.pos.z + fZ * 34, { type, aware: true, yaw: Math.atan2(fX, fZ) });
    z.chargeCd = 999; z.slamCd = 999;
    const top = z.speed, steady = [], rate = [];
    let latMax = 0, wMax = 0, t90 = null, tTurn = null, flips = 0, lastSign = 0, clipChanges = 0, lastClip = z.currentName, px = z.pos.x, pz = z.pos.z, vPrev = 0, accMax = 0;
    pt.sim(7, 1 / 60, (tt, dt) => {
      const dx = z.pos.x - px, dz = z.pos.z - pz; px = z.pos.x; pz = z.pos.z;
      const hx = Math.sin(z.yaw), hz = Math.cos(z.yaw), v = Math.hypot(dx, dz) / dt;
      latMax = Math.max(latMax, Math.abs(dx * hz - dz * hx) / dt); wMax = Math.max(wMax, Math.abs(z.yawV)); accMax = Math.max(accMax, (v - vPrev) / dt); vPrev = v;
      if (t90 === null && v >= top * 0.9) t90 = tt;
      if (tTurn === null && Math.abs(wrap(Math.atan2(p.pos.x - z.pos.x, p.pos.z - z.pos.z) - z.yaw)) < 0.35) tTurn = tt;
      const sg = Math.sign(z.yawV); if (Math.abs(z.yawV) > 0.3 && sg !== lastSign) { if (lastSign) flips++; lastSign = sg; }
      if (z.currentName !== lastClip) { clipChanges++; lastClip = z.currentName; }
      if (tt > 3.5 && tt < 5.5 && (z.state === 'walk' || z.state === 'run')) { steady.push(v); rate.push(z.current ? z.current.timeScale : 0); }
    });
    z.root.updateWorldMatrix(true, true);
    o.types[type] = { name: z.def.name, model: z.set.name + (z.borrowed ? ' stand-in' : ''), heightM: r2((z.bones.Head ? z.bones.Head.getWorldPosition(new T.Vector3()).y - z.pos.y : 0) + 0.2 * z.scale), health: z.maxHealth, speed: r2(top), steadySpeed: r2(mean(steady)), at90pctAfter: r2(t90), facingPlayerAfter: r2(tTurn), maxTurnDegPerSec: r2(wMax * 57.3, 0), maxAccel: r2(accMax, 1), maxSideSlip: r2(latMax, 3), turnReversals: flips, clip: z.gait || z.currentName, clipRate: r2(mean(rate)), clipChanges };
    Z.clear();
  }
  // brute: body shots do half, its blow throws the player back
  {
    pt.reset(); pt.god = false; p.script = () => {}; Z.noCull = true; const [fX, fZ] = ahead();
    const z = Z.spawn(p.pos.x + fX * 2.2, p.pos.z + fZ * 2.2, { type: 'brute', aware: true, yaw: Math.atan2(-fX, -fZ) });
    const d = new T.Vector3(fX, 0, fZ), body = Z.damage(z, 36, 'torso', d), headShot = Z.damage(z, 144, 'head', d);
    const h0 = p.health, p0 = p.pos.clone(); let vPeak = 0, tHit = null;
    pt.sim(5, 1 / 60, (tt) => { if (tHit === null && p.health < h0) tHit = tt; vPeak = Math.max(vPeak, Math.hypot(p.vel.x, p.vel.z)); return tHit === null || tt < tHit + 1.0; });
    o.brute = { bodyShotOf36Takes: body, headShotOf144Takes: headShot, healthLeft: r2(z.health, 0), firstBlowAfter: r2(tHit), blowDamage: r2(h0 - p.health, 0), playerThrownM: r2(pt.xz(p0, p.pos)), playerPeakSpeed: r2(vPeak, 1) };
    Z.clear();
  }
  // boss: wind-up and charge, ground slam, health for the HUD
  const boss = (dist, sec, setup, script) => {
    pt.reset(); pt.god = false; Z.noCull = true; const [fX, fZ] = ahead();
    const z = Z.spawn(p.pos.x + fX * dist, p.pos.z + fZ * dist, { type: 'boss', aware: true, yaw: Math.atan2(-fX, -fZ) });
    setup(z);
    const seq = [], h0 = p.health, s0 = Z.slams; let last = '', vmax = 0, px = z.pos.x, pz = z.pos.z, pn = fx.n, dust = 0, hud = null;
    p.script = (dt, pl) => script(dt, pl, z);
    pt.sim(sec, 1 / 60, (tt, dt) => {
      if (z.state !== last) { last = z.state; if (seq.length < 10) seq.push(`${last} ${tt.toFixed(1)}`); }
      if (z.state === 'charge') vmax = Math.max(vmax, Math.hypot(z.pos.x - px, z.pos.z - pz) / dt);
      px = z.pos.x; pz = z.pos.z;
      if (Z.slams > s0 && !dust) dust = fx.n - pn;
      pn = fx.n; if (!hud && g.boss) hud = { ...g.boss, pos: undefined };
    });
    const res = { states: seq.join(', '), chargeTopSpeed: r2(vmax, 1), playerLost: r2(h0 - p.health, 0), slams: Z.slams - s0, slamDust: dust, hud: hud && `${hud.name} ${hud.health}/${hud.maxHealth}` };
    Z.clear();
    return res;
  };
  o.boss = {
    charge: boss(20, 6.5, (z) => { z.chargeCd = 0.3; z.slamCd = 999; }, () => {}),
    chargeRolledAside: boss(20, 6.5, (z) => { z.chargeCd = 0.3; z.slamCd = 999; }, (dt, pl, z) => { if (z.state === 'charge' && pt.xz(z.pos, pl.pos) < 9) { pl.input.strafe = 1; pl.input.roll = pl.rollT <= 0 && pl.rollCd <= 0; } }),
    slam: boss(4, 3.5, (z) => { z.chargeCd = 999; z.slamCd = 0.2; }, () => {}),
    slamJumped: boss(4, 3.5, (z) => { z.chargeCd = 999; z.slamCd = 0.2; }, (dt, pl, z) => { pl.input.jump = z.state === 'slam' && z.stateT > 0.5 && z.stateT < 0.62; }),
  };
  // held up by a wall the route does not know about: no jitter, no spinning, no walking on the spot
  {
    pt.reset(); pt.god = true; Z.noCull = true; p.script = () => {}; const [fX, fZ] = ahead();
    const wx = p.pos.x + fX * 10, wz = p.pos.z + fZ * 10;
    const wall = new T.Mesh(new T.BoxGeometry(9, 3, 0.6)); wall.position.set(wx, terr.heightAt(wx, wz) + 1.3, wz); wall.rotation.y = p.yaw; wall.userData.surface = 'stone'; wall.updateMatrixWorld(true);
    col.build([...vm.world.colliders, wall]);
    const os = Z.onStuck; Z.onStuck = () => {};
    const res = {};
    for (const type of ['walker', 'runner']) {
      const z = Z.spawn(p.pos.x + fX * 15, p.pos.z + fZ * 15, { type, aware: true, yaw: Math.atan2(-fX, -fZ) });
      pt.sim(type === 'walker' ? 5 : 2.5);
      let yawTravel = 0, ly = z.yaw, clipCh = 0, lc = z.currentName, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, spdMax = 0;
      pt.sim(4, 1 / 60, () => { yawTravel += Math.abs(wrap(z.yaw - ly)); ly = z.yaw; if (z.currentName !== lc) { clipCh++; lc = z.currentName; } minX = Math.min(minX, z.pos.x); maxX = Math.max(maxX, z.pos.x); minZ = Math.min(minZ, z.pos.z); maxZ = Math.max(maxZ, z.pos.z); spdMax = Math.max(spdMax, z.spd); });
      res[type] = { gapToWallM: r2(Math.abs((z.pos.x - wx) * fX + (z.pos.z - wz) * fZ) - 0.3), yawTravelDeg: r2(yawTravel * 57.3, 1), clipChanges: clipCh, clip: z.currentName, movedCm: r2(Math.hypot(maxX - minX, maxZ - minZ) * 100, 1), maxSpeed: r2(spdMax, 2) };
      Z.clear();
    }
    o.blockedFor4s = res;
    Z.onStuck = os; col.build(vm.world.colliders);
  }
  // a crowd closing on the player: nobody overlaps, nobody twitches
  {
    pt.reset(); pt.god = true; Z.noCull = true; p.script = () => {}; const [fX, fZ] = ahead();
    for (let i = 0; i < 14; i++) { const a = (i / 14) * 6.283, r = 9 + (i % 3); Z.spawn(p.pos.x + Math.cos(a) * r, p.pos.z + Math.sin(a) * r, { type: i % 4 === 0 ? 'runner' : 'walker', aware: true }); }
    pt.sim(10);
    let minGap = 9, turn = 0, n = 0; const ly = Z.list.map((z) => z.yaw);
    pt.sim(3, 1 / 60, () => { Z.list.forEach((z, i) => { turn += Math.abs(wrap(z.yaw - ly[i])); ly[i] = z.yaw; n++; for (let j = i + 1; j < Z.list.length; j++) minGap = Math.min(minGap, pt.xz(z.pos, Z.list[j].pos)); }); });
    o.crowd = { infected: Z.list.length, closestCentresM: r2(minGap), meanTurnDegPerSec: r2((turn / n) * 60 * 57.3, 1), nearestToPlayerM: r2(Math.min(...Z.list.map((z) => pt.xz(z.pos, p.pos)))), states: [...new Set(Z.list.map((z) => z.state))].join(',') };
    Z.clear();
  }
  return o;
};

// the four kinds side by side (for the screenshot)
const S_TYPES = () => {
  const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, T = vm.THREE;
  pt.reset(); Z.passive = true; Z.noCull = true;
  const fX = -Math.sin(p.yaw), fZ = -Math.cos(p.yaw), zs = [];
  ['walker', 'runner', 'brute', 'boss'].forEach((type, i) => { const side = (i - 1.5) * 1.7, d = 7; const z = Z.spawn(p.pos.x + fX * d - fZ * side, p.pos.z + fZ * d + fX * side, { type, yaw: Math.atan2(-fX, -fZ), variant: i % 3 }); pt.still(z); zs.push(z); });
  const tgt = new T.Vector3(p.pos.x + fX * 7, p.pos.y + 1.35, p.pos.z + fZ * 7);
  p.script = (dt, pl) => { pl.lookAt(tgt, 999, dt); };
  pt.sim(1.0);
  return zs.map((z) => `${z.type} x${pt.r2(z.scale)} bulk ${pt.r2(z.bulk)} hp ${z.maxHealth}`);
};

const S_BLOOD = () => {
  const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, T = vm.THREE, terr = vm.terrain, col = g.collision, fx = g.fx, { r2 } = pt; const o = {};
  pt.reset(); Z.passive = true; Z.noCull = true;
  const fX = -Math.sin(p.yaw), fZ = -Math.cos(p.yaw);
  const wx = p.pos.x + fX * 9.5, wz = p.pos.z + fZ * 9.5;
  const wall = new T.Mesh(new T.BoxGeometry(5, 3.2, 0.5), new T.MeshStandardMaterial({ color: 0x8c8983, roughness: 0.92 }));
  wall.position.set(wx, terr.heightAt(wx, wz) + 1.5, wz); wall.rotation.y = p.yaw; wall.userData.surface = 'stone'; wall.updateMatrixWorld(true);
  vm.engine.scene.add(wall); window.__ptBloodWall = wall;
  col.build([...vm.world.colliders, wall]);
  const mk = (d, side) => { const z = Z.spawn(p.pos.x + fX * d - fZ * side, p.pos.z + fZ * d + fX * side, { type: 'walker', yaw: Math.atan2(-fX, -fZ), variant: 0 }); pt.still(z); return z; };
  const chest = (z) => { z.root.updateWorldMatrix(true, true); return z.bones.Chest.getWorldPosition(new T.Vector3()); };
  const z1 = mk(7.6, 0); pt.sim(0.5);
  let aim = () => chest(z1), press = 0, ads = true;
  p.script = (dt, pl) => { pl.lookAt(aim(), 999, dt); pl.input.ads = ads; pl.input.fire = press-- > 0; };
  pt.sim(0.6);
  const m = new T.Matrix4(), v = new T.Vector3();
  const where = (from) => { const out = []; for (let i = from; i < fx.splatI; i++) { fx.splats.getMatrixAt(i % fx.splatMax, m); v.setFromMatrixPosition(m); out.push(`${r2((v.x - p.pos.x) * fX + (v.z - p.pos.z) * fZ, 1)} m ahead, ${r2(v.y - terr.heightAt(v.x, v.z), 2)} m up`); } return out; };
  let s0 = fx.splatI; press = 2; pt.sim(0.25);
  o.wallBehindTheHit = { wallFaceAt: 9.25, splats: where(s0), healthLeft: z1.health };
  // nothing behind this one: the spatter falls to the ground; the third round kills, and a pool spreads
  const z2 = mk(7.6, 4.2); pt.sim(0.4); aim = () => chest(z2); pt.sim(0.5); s0 = fx.splatI;
  for (let k = 0; k < 3; k++) { press = 2; pt.sim(0.6); }
  o.openGround = { shots: 3, splats: where(s0), alive: z2.alive };
  pt.sim(1.6); const r1 = z2.pool ? z2.pool.r : null; pt.sim(8); const r8 = z2.pool ? z2.pool.r : null;
  o.pool = { started: !!z2.pool, radiusAfter3s: r2(r1), radiusAfter11s: r2(r8), full: z2.pool ? r2(z2.pool.max) : null, underTheBody: z2.pool ? r2(pt.xz(z2.pool.p, z2.pos)) : null };
  // stand beside the body with the wall in view (for the screenshot)
  const ox = p.pos.x, oz = p.pos.z, at = (d, s, h) => new T.Vector3(ox + fX * d - fZ * s, terr.heightAt(ox + fX * d - fZ * s, oz + fZ * d + fX * s) + h, oz + fZ * d + fX * s);
  const mid = at(8.3, 2.2, 0.55), cam0 = at(5.0, 5.6, 0);
  p.spawn(cam0.x, cam0.z, p.yaw); aim = () => mid; ads = false; pt.sim(0.6);
  return o;
};
const S_BLOOD_END = () => {
  const vm = __vm, g = vm.game, p = g.player, T = vm.THREE, fx = g.fx, { r2 } = pt;
  // caps: both buffers wrap, the cost of one more splat
  const n = new T.Vector3(0, 1, 0), q = new T.Vector3(p.pos.x + Math.sin(p.yaw) * 30, p.pos.y, p.pos.z + Math.cos(p.yaw) * 30);
  const t0 = performance.now(); for (let i = 0; i < 400; i++) fx.bloodSplat(q, n, 0.3); const us = ((performance.now() - t0) * 1000) / 400;
  for (let i = 0; i < 50; i++) fx.bloodPool(q, n, 0.5);
  const t1 = performance.now(); for (let i = 0; i < 200; i++) fx.update(1 / 60); const upd = (performance.now() - t1) / 200;
  if (window.__ptBloodWall) { vm.engine.scene.remove(window.__ptBloodWall); window.__ptBloodWall = null; }
  g.collision.build(vm.world.colliders); g.zombies.clear();
  return { splatsDrawn: fx.splats.count, splatCap: fx.splatMax, poolsDrawn: fx.poolMesh.count, poolCap: fx.poolMax, microsecPerSplat: r2(us, 1), fxUpdateMsWith20GrowingPools: r2(upd, 3), decalCap: fx.decalMax, casingCap: fx.caseMax };
};

const S_SURVIVAL_A = () => {
  const vm = __vm, g = vm.game, p = g.player, w = g.weapon, Z = g.zombies, T = vm.THREE, terr = vm.terrain, col = g.collision, L = vm.layout, { r2 } = pt; const o = {};
  g.start(); p.script = () => {}; pt.god = false; pt.sim(0.6);      // one route update, so reachability is known
  const ch = L.church, toX = ch.towerX - p.pos.x, toZ = ch.towerZ - p.pos.z, tl = Math.hypot(toX, toZ);
  const fX = -Math.sin(p.yaw), fZ = -Math.cos(p.yaw);
  o.start = { pos: pt.arr(p.pos), onStreetM: r2(L.streets[0].query(p.pos.x, p.pos.z, {}).d), surface: col.groundSurface(p.pos.x, p.pos.z), walkable: Z.flow.walkable(p.pos.x, p.pos.z), aboveGround: r2(pt.above(), 3), offChurchTowerDeg: r2(Math.acos(Math.min(1, (fX * toX + fZ * toZ) / tl)) * 57.3, 1), towerAtM: r2(tl, 0), towerInSight: col.lineOfSight(p.eye, new T.Vector3(ch.towerX, p.eye.y + 14, ch.towerZ)), wanderers: Z.list.length, nearestWandererM: r2(Math.min(...Z.list.map((z) => pt.xz(z.pos, p.pos))), 0), weapon: w.id, bandages: p.bandages, firstWaveIn: g.interT };
  const count = (list) => { const c = {}; for (const t of list) c[t] = (c[t] || 0) + 1; return ['walker', 'runner', 'brute', 'boss'].filter((t) => c[t]).map((t) => `${c[t]} ${t}`).join(' + '); };
  o.waves = {}; for (let n = 1; n <= 10; n++) { const c = g._compose(n); o.waves['w' + n] = `${c.kind}: ${count(c.list)}`; }
  // a cleared wave leaves a crate
  Z.clear(); g.wave = 1; g.waveKind = 'mixed'; g.queue = 0; g.queueList = []; g.cleared = false; g.interT = 5;
  const events = []; g.on('waveCleared', (n, c) => events.push(`waveCleared ${n} ${c ? 'crate' : 'none'}`)); g.on('crate', () => events.push('crate')); g.on('crateOpened', (c, got) => events.push(`crateOpened ${JSON.stringify(got)}`)); g.on('pickup', () => events.push('pickup')); g.on('wave', (n, k, q) => events.push(`wave ${n} ${k} ${q}`)); g.on('bossSpawn', (z) => events.push(`bossSpawn ${z.def.name}`)); g.on('kill', (z, part, id) => events.push(`kill ${z.type} ${part} ${id}`));
  window.__ptEvents = events;
  pt.sim(0.3);
  const c = g.supply.crates[0];
  if (!c) return { ...o, crate: 'none placed' };
  o.crate = { distance: r2(pt.xz(c.pos, p.pos), 1), restsOnGroundCm: r2((c.group.position.y - terr.heightAt(c.pos.x, c.pos.z)) * 100, 1), slopeNy: r2(terr.normalAt(c.pos.x, c.pos.z, new T.Vector3()).y, 3), outOfSightWhenPlaced: !g._visible(c.pos.x, c.pos.y + 0.4, c.pos.z), routeCellBlocked: Z.flow.walk[c.cell] === 0, nextWaveIn: r2(g.interT, 1) };
  g.interT = 1e9;
  // walk straight at it: it is solid
  const side = new T.Vector3(Math.cos(c.yaw), 0, -Math.sin(c.yaw));
  const from = [c.pos.x + side.z * 2.0, c.pos.z - side.x * 2.0];           // from the long side
  p.spawn(from[0], from[1], 0);
  const tgt = c.pos.clone(); let fwd = 1;
  p.script = (dt, pl) => { tgt.y = pl.eye.y - 0.9; pl.lookAt(tgt, 999, dt); pl.input.fwd = fwd; };
  pt.sim(2.5); fwd = 0; pt.sim(0.3);
  o.crate.walkedInto = { stopsAtM: r2(pt.xz(p.pos, c.pos)), speed: r2(p.speed), prompt: g.interact ? `${g.interact.key} · ${g.interact.text}` : null };
  const h = g.shoot(p.eye.clone(), c.pos.clone().setY(c.pos.y + 0.25).sub(p.eye).normalize());
  o.crate.bulletHits = h && h.surface;
  return o;
};
const S_SURVIVAL_B = () => {
  const vm = __vm, g = vm.game, p = g.player, w = g.weapon, Z = g.zombies, T = vm.THREE, { r2 } = pt; const o = {};
  const c = g.supply.crates[0];
  if (!c) return 'no crate';
  w.state.rifle.reserve = 60; w.state.sniper.reserve = 5; p.bandages = 0;
  let use = true; const tgt = c.pos.clone();
  p.script = (dt, pl) => { tgt.y = pl.eye.y - 0.9; pl.lookAt(tgt, 999, dt); if (use) { pl.input.interact = true; use = false; } };
  pt.sim(0.1); const first = { rifleReserve: w.state.rifle.reserve, sniperReserve: w.state.sniper.reserve, bandages: p.bandages, opened: c.opened };
  pt.sim(0.7); use = true; pt.sim(0.2);
  o.opened = { ...first, lidDeg: r2(c.lid.rotation.x * 57.3, 0), cargoGone: c.cargo.every((m) => !m.visible), secondPressDoesNothing: w.state.rifle.reserve === first.rifleReserve, promptAfter: g.interact };
  // jump onto it
  let jump = true, fwd = 1; p.script = (dt, pl) => { tgt.y = pl.eye.y; pl.lookAt(tgt, 999, dt); pl.input.fwd = fwd; pl.input.jump = jump; };
  let top = false; pt.sim(1.6, 1 / 60, () => { if (p.onGround && p.pos.y > c.pos.y + 0.35 && pt.xz(p.pos, c.pos) < 0.5) top = true; });
  o.standsOnTheCrate = top;
  // a dropped bandage is picked up by walking over it
  { const s = g._startPoint(); p.spawn(s[0], s[1], s[2]); } p.bandages = 1; p.script = () => {};
  const aX = -Math.sin(p.yaw), aZ = -Math.cos(p.yaw);
  const pk = g.supply.drop(p.pos.x + aX * 3, p.pos.y, p.pos.z + aZ * 3); const drop = { restsOnGroundCm: r2((pk.pos.y - vm.terrain.heightAt(pk.pos.x, pk.pos.z)) * 100, 1) };
  p.script = (dt, pl) => { pl.input.fwd = 1; }; pt.sim(1.4);
  o.pickup = { ...drop, bandages: p.bandages, left: g.supply.pickups.length };
  p.bandages = p.bandageMax; g.supply.drop(p.pos.x + aX * 2, p.pos.y, p.pos.z + aZ * 2); pt.sim(1.2); o.pickup.leftLyingWhenFull = g.supply.pickups.length === 1;
  // the next wave, then a boss wave
  p.script = () => {}; pt.god = true; g.interT = 0.2; pt.sim(0.4);
  o.nextWave = { wave: g.wave, kind: g.waveKind, queued: g.queue };
  Z.clear(); g.wave = 4; g.queue = 0; g.queueList = []; g.cleared = true; g.interT = 0.1;
  let tBoss = null; pt.sim(12, 1 / 30, (tt) => { if (g.boss) { tBoss = tt; return false; } });
  const b = g.boss;
  o.bossWave = { wave: g.wave, kind: g.waveKind, bossAfter: r2(tBoss), hud: b && { name: b.name, health: b.health, maxHealth: b.maxHealth, frac: b.frac }, spawnedAtM: b ? r2(pt.xz(b.pos, p.pos), 0) : null };
  if (b) { const z = Z.boss; Z.damage(z, 1300, 'head', new T.Vector3(1, 0, 0)); const half = g.boss ? g.boss.frac : null; Z.damage(z, 5000, 'head', new T.Vector3(1, 0, 0)); o.bossWave.afterHalf = r2(half, 2); o.bossWave.afterKill = g.boss; pt.sim(0.2); o.bossWave.drops = g.supply.pickups.length; }
  o.events = (window.__ptEvents || []).filter((e) => !e.startsWith('kill walker') && !e.startsWith('kill runner')).slice(0, 14);
  Z.clear(); g.supply.clear();
  return o;
};

// a kill against a house wall on the cobbles (for the screenshot: spatter on the wall, pool on the street)
const S_BLOOD_VILLAGE = () => {
  const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, T = vm.THREE, col = g.collision, fx = g.fx, { r2 } = pt;
  g.start(); pt.hold(); Z.clear(); Z.passive = true; Z.noCull = true; pt.god = true;
  const o0 = new T.Vector3(p.pos.x, p.pos.y + 1.2, p.pos.z), ray = new T.Ray(); let best = null;
  for (let k = 0; k < 64; k++) { const a = (k / 64) * 6.2832; ray.origin.copy(o0); ray.direction.set(Math.sin(a), 0, Math.cos(a)); const h = col.bvh.raycastFirst(ray, T.DoubleSide, 0, 40); if (h && h.distance > 8 && Math.abs(h.face.normal.y) < 0.3 && (!best || h.distance < best.d)) best = { d: h.distance, dir: ray.direction.clone(), pt: h.point.clone() }; }
  if (!best) return 'no wall near the start';
  const z = Z.spawn(best.pt.x - best.dir.x * 1.6, best.pt.z - best.dir.z * 1.6, { type: 'walker', yaw: Math.atan2(-best.dir.x, -best.dir.z), variant: 2 }); pt.still(z);
  p.spawn(best.pt.x - best.dir.x * 6.5, best.pt.z - best.dir.z * 6.5, 0);
  const tgt = new T.Vector3(); let press = 0, low = false;
  p.script = (dt, pl) => { if (!low) { z.root.updateWorldMatrix(true, true); z.bones.Chest.getWorldPosition(tgt); } pl.lookAt(tgt, 999, dt); pl.input.ads = !low; pl.input.fire = press-- > 0; };
  pt.sim(0.8); const s0 = fx.splatI;
  for (let k = 0; k < 3; k++) { press = 2; pt.sim(0.6); }
  pt.sim(9);
  low = true; tgt.set((z.pos.x + best.pt.x) / 2, z.pos.y + 0.7, (z.pos.z + best.pt.z) / 2); pt.sim(0.6);
  return { wallAt: r2(best.d), splats: fx.splatI - s0, pool: z.pool ? r2(z.pool.r) : null, ground: col.groundSurface(z.pos.x, z.pos.z), alive: z.alive };
};

// ------------------------------------------------------------------ run
// ------------------------------------------------------------------ Operation mode (the real page, stepped through code)
const S_OP_BASE = () => {
  const vm = __vm, g = vm.game, P = vm.progress, cat = P.catalogue, per = {};
  for (const i of cat) per[i.tab] = (per[i.tab] || 0) + 1;
  return { state: g.state, baseShown: document.querySelector('.base').classList.contains('show'), loops: [...g.audio.want.keys()].join(','), entries: cat.length, levels: cat.reduce((s, i) => s + i.levels, 0), perTab: per, cardsShown: document.querySelectorAll('.base .card').length, bank: document.querySelector('.base .bank b').textContent };
};
// the first seconds of the flight in
const S_OP_INSERT_A = () => {
  const vm = __vm, g = vm.game, op = g.operation, p = g.player, h = op.heli, { r2 } = pt;
  const o = { state: g.state, mode: g.mode, phase: op.phase, lz: op.lz.id, lzs: op._lzs().map((l) => `${l.id}@${r2(l.x, 0)},${r2(l.z, 0)} room ${r2(l.room, 1)} heading ${r2(l.yaw * 57.3, 0)}`), flight: { seconds: h.T, hover: r2(h.wv * h.T, 1) }, playerEnabled: p.enabled, weaponVisible: g.weapon.visible, wave: g.wave,
    kit: { rifleDamage: r2(g.weapon.state.rifle.mod.damage), rifleMag: g.weapon.magSize, sniper: g.weapon.state.sniper.owned, maxHealth: p.maxHealth, abilities: op.abilities.map((a) => `${a.key}:${a.id}`) } };
  const q = window.__ptOp = { minClear: 1e9, maxSpeed: 0, prev: h.group.position.clone(), t: 0 };
  window.__ptTrack = (t, dt) => { const hp = h.group.position; if (h.state === 'in') { if (Math.hypot(hp.x - op.lz.x, hp.z - op.lz.z) > 9) q.minClear = Math.min(q.minClear, hp.y - h._top(hp.x, hp.z)); q.maxSpeed = Math.max(q.maxSpeed, hp.distanceTo(q.prev) / dt); } q.prev.copy(hp); q.t += dt; };
  pt.sim(3.4, 1 / 60, window.__ptTrack);
  o.at34 = { alt: r2(h.group.position.y - op.lz.y, 1), toLz: r2(Math.hypot(h.group.position.x - op.lz.x, h.group.position.z - op.lz.z), 0), camFromHeli: r2(vm.engine.camera.position.distanceTo(h.group.position)), hudHidden: document.querySelector('.hud').classList.contains('cine') };
  return o;
};
// touch-down, hand-over, and the helicopter leaving
const S_OP_INSERT_B = () => {
  const vm = __vm, g = vm.game, op = g.operation, p = g.player, h = op.heli, { r2 } = pt, q = window.__ptOp;
  p.script = () => {};
  pt.sim(8, 1 / 60, (t, dt) => { window.__ptTrack(t, dt); return op.phase !== 'run'; });
  const hp = h.group.position;
  const o = { controlAfter: r2(q.t), minOverGroundAndRoofs: r2(q.minClear, 1), maxSpeed: r2(q.maxSpeed, 1), phase: op.phase, playerEnabled: p.enabled, weaponVisible: g.weapon.visible, playerAbove: r2(pt.above()), fromExit: r2(Math.hypot(p.pos.x - op.lz.exit.x, p.pos.z - op.lz.exit.z)), heli: h.state, skidsAboveGround: r2(hp.y - vm.terrain.heightAt(hp.x, hp.z)), solid: !!h.box, health: p.health, bandages: p.bandages, firstWaveIn: r2(g.interT, 1), hudHidden: document.querySelector('.hud').classList.contains('cine') };
  const tgt = new vm.THREE.Vector3();
  p.script = (dt, pl) => { tgt.copy(hp); tgt.y += 1.6; pl.lookAt(tgt, 12, dt); };
  pt.hold(); pt.sim(3.4);
  o.leaving = { heli: h.state, alt: r2(hp.y - op.lz.y, 1), dist: r2(hp.distanceTo(p.pos), 0), solid: !!h.box };
  return o;
};
const S_OP_WAVES = (args) => {
  const vm = __vm, g = vm.game, op = g.operation, p = g.player, Z = g.zombies, T = vm.THREE, { r2 } = pt;
  pt.god = true; g.interT = 1; g.cleared = true;
  const waves = [], types = {}; let hm = 1, tick = 0;
  const nw = g._nextWave; g._nextWave = function () { nw.call(g); waves.push({ wave: g.wave, kind: g.waveKind, queue: g.queue, survivalWouldBe: g._compose(g.wave).list.length, salvage: Math.round(op.salvage) }); };
  const sp = Z.spawn; Z.spawn = function (x, z, o2) { const r = sp.call(Z, x, z, o2); if (r && o2 && o2.aware) { types[r.type] = (types[r.type] || 0) + 1; hm = Math.max(hm, o2.healthMult || 1); } return r; };
  const tmp = new T.Vector3(), fw = new T.Vector3(), f2 = new T.Vector3();
  p.script = (dt, pl) => {
    let best = null, bd = 1e9;
    for (const z of Z.list) { if (!z.alive) continue; const d = z.pos.distanceTo(pl.pos); if (d < bd) { bd = d; best = z; } }
    if (g.weapon.ammo === 0) { if (g.weapon.reserve > 0) pl.input.reload = true; else if (g.weapon.id === 'rifle') pl.input.slot = 2; }
    if (!best) return;
    if (best.bones.Head) { best.root.updateWorldMatrix(true, true); best.bones.Head.getWorldPosition(tmp); tmp.y += 0.07; } else tmp.set(best.pos.x, best.pos.y + 1.55, best.pos.z);
    pl.lookAt(tmp, 16, dt);
    if (bd > 75) return;
    pl.input.ads = bd > 10;
    const err = Math.acos(Math.min(1, pl.forward(f2).dot(fw.copy(tmp).sub(pl.eye).normalize())));
    if (err < Math.min(0.2, 0.1 / bd) && g.collision.lineOfSight(pl.eye, tmp)) pl.input.fire = g.weapon.def.mode === 'auto' || (tick++ & 1) === 0;
    if (bd < 6) pl.input.fwd = -1;
  };
  const simT = pt.sim(args.maxTime, 1 / 30, () => op.cleared < args.waves);
  g._nextWave = nw; Z.spawn = sp;
  return { waves, cleared: op.cleared, kills: g.stats.kills, headshots: g.stats.headshots, salvage: Math.round(op.salvage), hudSalvage: document.querySelector('.salvage b').textContent, hudStatus: document.querySelector('.status').textContent, spawned: types, healthMult: r2(hm), simSeconds: r2(simT, 0), heli: op.heli.state, crates: g.supply.crates.length, extraction: !!op.extraction };
};
// fast forward to the fifth cleared wave; the helicopter comes back and waits
const S_OP_EXTRACT_A = () => {
  const vm = __vm, g = vm.game, op = g.operation, p = g.player, Z = g.zombies, T = vm.THREE, { r2 } = pt;
  const dir = new T.Vector3(1, 0, 0), s0 = Math.round(op.salvage);
  p.script = () => {}; pt.god = true;
  let boss = false;
  const t = pt.sim(600, 1 / 30, () => {
    if (Z.boss) boss = true;
    if (!op.extraction) { g.interT = Math.min(g.interT, 0.4); g.spawnT = Math.min(g.spawnT, 0.05); for (const z of [...Z.list]) if (z.alive) Z.damage(z, 1e6, 'head', dir); }
    return !op.extraction;
  });
  const ex = op.extraction, h = op.heli;
  const o = { simSeconds: r2(t, 0), wave: g.wave, cleared: op.cleared, boss, salvageBefore: s0, salvage: Math.round(op.salvage), state0: ex && ex.state, lz: ex && ex.lz.id, nextWaveHeld: g.interT > 1e6 };
  if (!ex) return o;
  let minOver = 1e9;
  const tIn = pt.sim(15, 1 / 60, () => { const hp = h.group.position; if (h.state === 'in' && Math.hypot(hp.x - ex.lz.x, hp.z - ex.lz.z) > 9) minOver = Math.min(minOver, hp.y - h._top(hp.x, hp.z)); return ex.state !== 'waiting'; });
  Object.assign(o, { inboundSeconds: r2(tIn, 1), minOverGroundAndRoofs: r2(minOver, 1), state: ex.state, window: ex.window, heli: h.state });
  const lz = ex.lz, tgt = new T.Vector3();
  p.spawn(lz.exit.x + lz.rx * 12 - lz.fx * 5, lz.exit.z + lz.rz * 12 - lz.fz * 5, 0);
  p.script = (dt, pl) => { tgt.copy(h.group.position); tgt.y += 1.7; pl.lookAt(tgt, 999, dt); };
  pt.sim(1.5);
  o.hud = { marker: document.querySelector('.marker.lz span').textContent, markerOn: document.querySelector('.marker.lz').classList.contains('on'), salvage: document.querySelector('.salvage b').textContent, timeLeft: r2(ex.timeLeft, 1), dist: r2(ex.dist, 1), prompt: document.querySelector('.prompt').textContent };
  return o;
};
// up to the door, F, lift-off, debrief
const S_OP_EXTRACT_B = () => {
  const vm = __vm, g = vm.game, op = g.operation, p = g.player, P = vm.progress, { r2 } = pt;
  const lz = op.heli.lz, bank0 = P.salvage, earned = Math.round(op.salvage);
  p.spawn(lz.exit.x, lz.exit.z, lz.exitYaw + Math.PI); p.script = () => {}; pt.sim(0.2);
  const o = { prompt: g.interact && g.interact.text, hudPrompt: document.querySelector('.prompt').textContent, timeLeft: r2(op.extraction.timeLeft, 1) };
  let press = true; p.script = (dt, pl) => { pl.input.interact = press; press = false; };
  const t = pt.sim(8, 1 / 60, () => g.state === 'playing');
  const s = g.lastSummary || {};
  return Object.assign(o, { secondsToDebrief: r2(t, 1), state: g.state, outcome: s.outcome, wave: s.wave, cleared: s.cleared, kills: s.kills, earned: s.earned, banked: s.banked, expectedBanked: Math.round(earned * 1.25), bankGain: P.salvage - bank0, bestWave: P.data.best.wave, runs: P.data.history.length, debriefShown: document.querySelector('.debrief').classList.contains('show'), title: document.querySelector('.debrief h2').textContent, playerEnabled: p.enabled, heli: op.heli.state, heliAlt: r2(op.heli.group.position.y - lz.y, 1) });
};
const S_OP_SQUARE = () => {
  const vm = __vm, g = vm.game, op = g.operation, h = op.heli, { r2 } = pt;
  const q = window.__ptSq = { minOver: 1e9 };
  pt.sim(4.4, 1 / 60, () => { const hp = h.group.position; if (h.state === 'in' && Math.hypot(hp.x - op.lz.x, hp.z - op.lz.z) > 9) q.minOver = Math.min(q.minOver, hp.y - h._top(hp.x, hp.z)); });
  return { lz: op.lz.id, flightSeconds: h.T, hoverSeconds: r2(h.wv * h.T, 1), phase: op.phase, alt: r2(h.group.position.y - op.lz.y, 1), toLz: r2(Math.hypot(h.group.position.x - op.lz.x, h.group.position.z - op.lz.z), 0) };
};
const S_OP_DEATH = () => {
  const vm = __vm, g = vm.game, op = g.operation, p = g.player, Z = g.zombies, T = vm.THREE, h = op.heli, { r2 } = pt, q = window.__ptSq;
  p.script = () => {};
  pt.sim(8, 1 / 60, () => { const hp = h.group.position; if (h.state === 'in' && Math.hypot(hp.x - op.lz.x, hp.z - op.lz.z) > 9) q.minOver = Math.min(q.minOver, hp.y - h._top(hp.x, hp.z)); return op.phase !== 'run'; });
  pt.hold();
  const o = { phase: op.phase, minOverGroundAndRoofs: r2(q.minOver, 1), playerAbove: r2(pt.above()), playerFree: g.collision.resolveCapsule(p.pos.clone().setY(p.pos.y + 0.05), 0.35, 1.8).lengthSq() < 1e-8 };
  // three walkers: two head shots and one body shot
  const dir = new T.Vector3(1, 0, 0), zs = [];
  for (let i = 0; i < 3; i++) { const z = Z.spawn(p.pos.x + 9 + i * 1.5, p.pos.z + 6, { type: 'walker', aware: true }); if (z) zs.push(z); }
  zs.forEach((z, i) => Z.damage(z, 1e5, i < 2 ? 'head' : 'body', dir));
  o.salvage = Math.round(op.salvage); o.expectedSalvage = 8 + 8 + 5;
  const bank0 = vm.progress.salvage;
  p.damage(999);
  const t = pt.sim(6, 1 / 60, () => g.state === 'playing');
  const s = g.lastSummary || {};
  return Object.assign(o, { secondsToDebrief: r2(t, 1), state: g.state, outcome: s.outcome, earned: s.earned, banked: s.banked, bankGain: vm.progress.salvage - bank0, phaseAfter: op.phase });
};
const S_OP_PERSIST = (before) => {
  const P = __vm.progress, C = P.constructor, mem = (s) => ({ getItem: () => s, setItem() {} });
  const tolerant = ['{not json', 'null', '[]', '"x"', '{"v":99,"salvage":"lots","levels":{"rifle.damage":99,"nope":3,"body.health":-2},"loadout":["tank","adrenaline","adrenaline",7],"history":"x","best":null}']
    .map((s) => { try { const q = new C(mem(s)); return `${q.salvage}/${q.level('rifle.damage')}/${q.level('body.health')}/${q.loadout.join('|')}`; } catch (e) { return 'THROWS ' + e.message; } });
  return { salvageKept: P.salvage === before.salvage, salvage: P.salvage, levelsKept: JSON.stringify(P.data.levels) === before.levels, levels: P.data.levels, loadout: P.loadout, runs: P.data.totals.runs, history: P.data.history.map((h) => `${h.outcome}:w${h.wave}:+${h.banked}`), bestWave: P.data.best.wave, version: P.data.v, storedBytes: (localStorage.getItem('valle-morta-profile') || '').length, tolerant };
};
// the run after the reload carries the purchases; Survival afterwards is stock again
const S_OP_NEXT = () => {
  const vm = __vm, g = vm.game, op = g.operation, p = g.player, w = g.weapon, Z = g.zombies, T = vm.THREE, { r2 } = pt;
  p.script = () => {};
  const o = { rifleDamage: r2(w.state.rifle.mod.damage), rifleMag: w.magSize, burn: w.state.rifle.mod.burn, sniperOwned: w.state.sniper.owned, maxHealth: p.maxHealth, abilities: op.abilities.map((a) => `${a.key}:${a.id} L${a.level} cd${a.cooldown} dur${a.duration}`) };
  pt.sim(9.5, 1 / 60, () => op.phase !== 'run'); pt.hold(); Z.passive = true;
  o.health = p.health;
  const z = Z.spawn(p.pos.x - Math.sin(p.yaw) * 8, p.pos.z - Math.cos(p.yaw) * 8, { type: 'walker' }); pt.still(z);
  const tgt = new T.Vector3(); let fire = false, ab = 0;
  p.script = (dt, pl) => { tgt.set(z.pos.x, z.pos.y + 1.15, z.pos.z); pl.lookAt(tgt, 999, dt); pl.input.ads = true; pl.input.fire = fire; pl.input.ability = ab; ab = 0; };
  pt.sim(0.9); const h0 = z.health; fire = true; g.update(1 / 60); fire = false; const h1 = z.health; pt.sim(4.4);
  o.shot = { dealt: r2(h0 - h1, 1), stockWouldBe: 36, burnedAfterwards: r2(h1 - z.health, 1), alive: z.alive };
  // an ability with nothing plugged in does nothing; with an effect it runs and cools down
  const a = op.abilities[0];
  if (a) {
    ab = a.slot + 1; pt.sim(0.1); o.unfitted = { cd: a.cd, uses: a.uses };
    let started = 0, ended = 0; op.registerAbility(a.id, { start() { started++; }, end() { ended++; } });
    ab = a.slot + 1; pt.sim(0.1);
    o.used = { started, cd: r2(a.cd, 1), active: r2(a.active, 1), ready: a.ready, rings: document.querySelectorAll('.abil .ab').length, ringLive: document.querySelector('.abil .ab').classList.contains('live') };
    pt.sim(a.duration + 0.3); o.afterwards = { ended, active: a.active, cd: r2(a.cd, 1) };
    delete op.effects[a.id];
  }
  g.toMenu(); g.start('survival'); p.script = () => {}; pt.sim(0.3);
  o.survival = { mode: g.mode, rifleDamage: w.state.rifle.mod.damage, rifleMag: w.magSize, burn: w.state.rifle.mod.burn, sniperOwned: w.state.sniper.owned, maxHealth: p.maxHealth, phase: op.phase, heli: op.heli.state, playerEnabled: p.enabled, hudOp: document.querySelector('.hud').classList.contains('op'), wave: g.wave };
  g.toMenu();
  return o;
};

try {
  if (only.includes('game')) {
    const page = await open(`q=${q}&auto=1`, 'game');
    await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 240000, polling: 250 });
    console.log('GPU:', await page.evaluate(() => { const gl = window.__vm.engine.gl; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }));
    await page.evaluate(() => { window.__vm.stop(); });
    await page.evaluate(LIB);
    await section(page, 'assets', S_ASSETS);
    if (run('turn')) await section(page, 'turn', S_TURN);
    if (run('fov')) await section(page, 'fov', S_FOV);
    if (run('move')) await section(page, 'movement', S_MOVE);
    if (run('arms')) {
      await section(page, 'arms', S_ARMS);
      await section(page, 'view-scope', S_VIEW_SCOPE); await shotGame(page, 'scope', 'new');
      await section(page, 'view-prone', S_VIEW_PRONE); await shotGame(page, 'prone_bipod', 'new');
      await section(page, 'view-fire-rifle', S_VIEW_FIRE, 'rifle'); await shotGame(page, 'flash_rifle', 'new');
      await section(page, 'view-fire-sniper', S_VIEW_FIRE, 'sniper'); await shotGame(page, 'flash_sniper', 'new');
    }
    if (run('feel')) await section(page, 'feel', S_FEEL);
    if (run('infected')) { await section(page, 'infected', S_INFECTED); await section(page, 'types', S_TYPES); await shotGame(page, 'types', 'new'); }
    if (run('blood')) { await section(page, 'blood', S_BLOOD); await shotGame(page, 'blood', 'new'); await section(page, 'blood-caps', S_BLOOD_END); await section(page, 'blood-village', S_BLOOD_VILLAGE); await shotGame(page, 'blood_village', 'new'); }
    if (run('survival')) { await section(page, 'survival', S_SURVIVAL_A); await shotGame(page, 'crate', 'new'); await section(page, 'supplies', S_SURVIVAL_B); }
    if (run('core')) {
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
    }
    if (run('nav')) await section(page, 'nav', S_NAV);
    if (run('waves')) await section(page, 'waves', S_WAVES, { waves: nWaves, maxTime: 900 });
    if (run('perf')) {
      await section(page, 'perf-setup', S_PERF_SETUP);
      await shotGame(page, 'horde');
      await section(page, 'perf', S_PERF);
    }
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
      range('renderScale', 0.75); range('fov', 110); range('sensitivity', 1.5); range('master', 0.5); range('music', 0.3); range('sfx', 0.4);
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
    // real mouse events through the browser: 200 px to the right
    const yaw0 = await page.evaluate(() => __vm.game.player.yaw);
    await page.mouse.move(840, 360, { steps: 20 }); await sleep(300);
    console.log('## ui mouse-turn: ' + JSON.stringify(await page.evaluate((y0) => { const p = __vm.game.player; return { turnedRad: +(y0 - p.yaw).toFixed(4), expectedRad: +(200 * p.lookScale()).toFixed(4), events: p.mouse.events, rejected: p.mouse.rejected }; }, yaw0)));
    await sleep(2300);
    console.log('## ui hud: ' + JSON.stringify(await page.evaluate((p0) => { const g = __vm.game, p = g.player; return { movedByKeys: +Math.hypot(p.pos.x - p0[0], p.pos.z - p0[2]).toFixed(2), ammoAfterMouseFire: g.weapon.ammo, wave: g.wave, toast: document.querySelector('.toast').textContent.trim(), status: document.querySelector('.status').textContent, prompt: document.querySelector('.prompt').textContent, hp: document.querySelector('.hp-num').textContent, segments: document.querySelectorAll('.hp b').length, bandages: document.querySelector('.band').textContent, weapon: document.querySelector('.wname').textContent, reserve: document.querySelector('.res').textContent, fovMax: document.querySelector('input[data-key="fov"]').max, zombies: g.zombies.list.length, fps: __vm.info().fps }; }, p0)));
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

  if (only.includes('operation')) {
    const page = await open(`q=${q}`, 'op');
    const ready = async () => { await page.waitForFunction('window.__vm && window.__vm.ready && window.__vm.game.state === "menu"', { timeout: 240000, polling: 250 }); await page.evaluate(LIB); };
    const say = async (name, fn, ...a) => { try { console.log(`## op ${name}: ` + JSON.stringify(await page.evaluate(fn, ...a))); } catch (e) { console.log(`## op ${name}: FAILED ${String((e && e.message) || e).slice(0, 600)}`); } };
    const shot = async (name) => { const file = path.join(out, `op_${name}.jpg`); await page.screenshot({ path: file, type: 'jpeg', quality: 88 }); shots.op.push(file); };
    // the stepped game stands still: render it as it is for a few frames, grab it, freeze again
    const shotWorld = async (name) => {
      await page.evaluate(async () => { const vm = window.__vm; window.__ptState = vm.game.state; vm.game.state = 'paused'; vm.start(); for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r)); });
      await shot(name);
      await page.evaluate(() => { const vm = window.__vm; vm.stop(); vm.game.state = window.__ptState; });
    };
    const click = async (sel, wait = 150) => { await page.click(sel); await sleep(wait); };
    const deploy = async (lz) => {
      // headless Chrome has no pointer lock: pretend it was granted, then take the clock away from the page
      await page.evaluate((lz) => { Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.getElementById('view') }); __vm.operation.nextLz = lz; }, lz);
      await page.click('.base [data-act="deploy"]');
      await page.evaluate(() => { __vm.stop(); });
      await sleep(700);        // the Base screen fades out in real time
    };
    await ready();
    await page.evaluate(() => { __vm.progress.reset(); });
    await sleep(1500);
    await say('menu', () => [...document.querySelectorAll('.menu .mode')].map((b) => `${b.dataset.act}: ${b.querySelector('strong').textContent} / ${b.querySelector('span').textContent}`));
    await shot('menu');
    await click('.menu [data-act="operation"]', 900);
    await section(page, 'op base', S_OP_BASE);
    await click('.base [data-buy="rifle.damage"]');                       // nothing in the bank yet: refused
    await say('refused', () => ({ level: __vm.progress.level('rifle.damage'), salvage: __vm.progress.salvage }));
    await page.evaluate(() => { __vm.progress.grant(4000); });
    for (const id of ['rifle.damage', 'rifle.damage', 'rifle.mag', 'rifle.fire']) await click(`.base [data-buy="${id}"]`);
    await click('.base [data-group="sniper"]'); await click('.base [data-buy="sniper.unlock"]'); await click('.base [data-group="rifle"]', 1200);
    await shot('base_weapons');
    await click('.base [data-tab="body"]'); await click('.base [data-buy="body.health"]');
    await click('.base [data-tab="abilities"]'); await click('.base [data-buy="ability.adrenaline"]'); await click('.base [data-buy="ability.jump"]', 1200);
    await shot('base_abilities');
    await say('purchases', () => { const P = __vm.progress; return { salvage: P.salvage, levels: P.data.levels, loadout: P.loadout, bank: document.querySelector('.base .bank b').textContent, slots: [...document.querySelectorAll('.base .slot span')].map((s) => s.textContent) }; });

    await deploy('meadow');
    await section(page, 'op insertion', S_OP_INSERT_A); await shotWorld('insertion');
    await section(page, 'op hand-over', S_OP_INSERT_B); await shotWorld('heli_leaves');
    await section(page, 'op waves', S_OP_WAVES, { waves: 2, maxTime: 400 });
    await section(page, 'op extraction', S_OP_EXTRACT_A); await shotWorld('extraction');
    await section(page, 'op board', S_OP_EXTRACT_B);
    await page.evaluate(() => { __vm.start(); }); await sleep(1000); await shot('debrief');
    await click('.debrief [data-act="base"]', 700); await click('.base [data-tab="run"]', 500);
    await say('base after extraction', () => ({ state: __vm.game.state, bank: document.querySelector('.base .bank b').textContent, salvage: __vm.progress.salvage, runs: [...document.querySelectorAll('.base .runs li')].map((l) => l.textContent), heli: __vm.operation.heli.state, loops: [...__vm.game.audio.want.keys()].join(',') }));
    await shot('base_run');

    await deploy('square');
    await section(page, 'op second approach', S_OP_SQUARE); await shotWorld('insertion_2');
    await section(page, 'op death', S_OP_DEATH);
    await page.evaluate(() => { __vm.start(); }); await sleep(900);
    await say('debrief after death', () => ({ shown: document.querySelector('.debrief').classList.contains('show'), title: document.querySelector('.debrief h2').textContent, rows: [...document.querySelectorAll('.debrief .stats div')].map((d) => d.textContent.trim().replace(/\s+/g, ' ')) }));
    await click('.debrief [data-act="base"]', 600);
    const before = await page.evaluate(() => ({ state: __vm.game.state, salvage: __vm.progress.salvage, levels: JSON.stringify(__vm.progress.data.levels) }));
    console.log('## op base after death: ' + JSON.stringify(before));

    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await section(page, 'op saved profile', S_OP_PERSIST, before);
    await click('.menu [data-act="operation"]', 700);
    await deploy('meadow');
    await section(page, 'op next run', S_OP_NEXT);
    await page.evaluate(() => { __vm.progress.reset(); });
    await page.close();
  }

  // ---- Operation abilities: each one used in a stepped run, its effect measured, one picture each
  if (only.includes('abilities')) {
    const page = await open(`q=${q}`, 'ab');
    await page.waitForFunction('window.__vm && window.__vm.ready && window.__vm.game.state === "menu"', { timeout: 240000, polling: 250 });
    await page.evaluate(LIB);
    await page.evaluate(() => { Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.getElementById('view') }); __vm.stop(); });
    const shotAb = async (name) => {
      await page.evaluate(async () => { const vm = window.__vm; window.__ptState = vm.game.state; vm.game.state = 'paused'; vm.start(); for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r)); });
      const file = path.join(out, `ab_${name}.jpg`); await page.screenshot({ path: file, type: 'jpeg', quality: 88 }); shots.ab.push(file);
      await page.evaluate(() => { const vm = window.__vm; vm.stop(); vm.game.state = window.__ptState; });
    };
    await section(page, 'ab setup', () => {
      const vm = __vm, g = vm.game, op = g.operation, p = g.player, P = vm.progress, { r2 } = pt;
      op.nextLz = 'meadow'; g.start('operation');
      const t = pt.sim(25, 1 / 30, () => op.phase !== 'run');
      pt.hold(); g.zombies.clear(); p.script = () => {};
      window.__ab = (key, level) => {
        const item = P.item('ability.' + key), a = item.ability, i = level - 1, params = {};
        for (const k in a.params) params[k] = Array.isArray(a.params[k]) ? a.params[k][i] : a.params[k];
        const ab = { id: key, slot: 0, key: 'G', name: item.name, short: a.short, level, cooldown: a.cooldown[i], duration: a.duration[i], params, cd: 0, active: 0, ready: true, uses: 0 };
        op._endAbilities(); op.abilities = [ab];
        return ab;
      };
      return { phase: op.phase, flyIn: r2(t, 1), kit: !!op.kit, pos: pt.arr(p.pos) };
    });
    await section(page, 'ab tank drop', () => {
      const vm = __vm, g = vm.game, op = g.operation, p = g.player, kit = op.kit, { r2 } = pt;
      const ab = __ab('tank', 3); p.pitch = 0.04;
      const used = op.useAbility(0), t = kit.tanks[kit.tanks.length - 1];
      if (!used || !t) return { used, refused: true, pos: pt.arr(p.pos) };
      window.__tank = t; window.__tankAb = ab;
      let tSlam = null, lastV = 0, prevY = t.pos.y;
      pt.sim(3.5, 1 / 60, (tt, dt) => { if (t.state === 'drop' && t.root.visible) lastV = (prevY - t.pos.y) / dt; prevY = t.pos.y; if (tSlam === null && t.state !== 'drop') { tSlam = tt; return false; } });
      pt.sim(0.15);
      return { used, toSpot: r2(Math.hypot(t.pos.x - p.pos.x, t.pos.z - p.pos.z), 1), slamAt: r2(tSlam), touchdownSpeed: r2(lastV, 1), state: t.state, driveTimeKept: r2(ab.active, 1), playerHealth: p.health };
    });
    await shotAb('tank_drop');
    await section(page, 'ab tank drive', () => {
      const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, t = window.__tank, { r2 } = pt;
      if (!t) return 'no tank';
      pt.sim(1.5, 1 / 60, () => t.state !== 'drive');
      const o = { state: t.state, mounted: p.vehicle === t, weaponHidden: !g.weapon.visible, eyeAboveGround: r2(g.engine.camera.position.y - vm.terrain.heightAt(t.pos.x, t.pos.z)) };
      const fx = t.fwdX, fz = t.fwdZ, rx = Math.cos(t.yaw), rz = -Math.sin(t.yaw);
      Z.passive = true;
      const at = (d, l, type = 'walker') => { const z = Z.spawn(t.pos.x + fx * d + rx * l, t.pos.z + fz * d + rz * l, { type }); if (z) pt.still(z); return z; };
      const inPath = [at(11, 0), at(15, -1.1), at(19, 1.2), at(23, 0.4, 'runner')].filter(Boolean), aside = at(17, 4.2);
      const x0 = t.pos.x, z0 = t.pos.z;
      let vmax = 0, pmin = 0, pmax = 0;
      p.yaw = t.yaw; p.pitch = -0.05;
      p.script = (dt, pl) => { pl.input.fwd = 1; };
      pt.sim(4.5, 1 / 60, () => { vmax = Math.max(vmax, Math.abs(t.v)); pmin = Math.min(pmin, t.pitch); pmax = Math.max(pmax, t.pitch); });
      o.drive = { dist: r2(Math.hypot(t.pos.x - x0, t.pos.z - z0), 1), vmax: r2(vmax, 1), crushed: `${inPath.filter((z) => !z.alive).length}/${inPath.length}`, asideAlive: aside ? aside.alive : null, pitchDeg: [r2(pmin * 57.3, 1), r2(pmax * 57.3, 1)], treads: op_t(), invulnerable: p.health === p.maxHealth };
      function op_t() { return g.operation.kit.treads.count; }
      p.script = (dt, pl) => { pl.input.fwd = t.v > 0.3 ? -1 : 0; };
      const tb = pt.sim(4, 1 / 60, () => Math.abs(t.v) > 0.3);
      const y0 = t.yaw, pp = t.pos.clone();
      p.script = (dt, pl) => { pl.input.fwd = 0; pl.input.strafe = 1; };
      pt.sim(2.5);
      o.brake = r2(tb, 2);
      o.pivot = { turnedDeg: r2((y0 - t.yaw) * 57.3, 0), moved: r2(Math.hypot(t.pos.x - pp.x, t.pos.z - pp.z), 2), rateDegS: r2(-t.w * 57.3, 0) };
      p.script = (dt, pl) => { pl.input.strafe = 0; };
      pt.sim(0.6);
      // a wall across the way: the hull stops at it
      { const T = vm.THREE, col = g.collision, wx = t.pos.x + t.fwdX * 12, wz = t.pos.z + t.fwdZ * 12;
        const wall = new T.Mesh(new T.BoxGeometry(12, 3, 0.6), new T.MeshStandardMaterial({ color: 0x8c8983 }));
        wall.position.set(wx, vm.terrain.heightAt(wx, wz) + 1.2, wz); wall.rotation.y = t.yaw; wall.userData.surface = 'stone'; wall.updateMatrixWorld(true);
        vm.engine.scene.add(wall); col.build([...vm.world.colliders, wall]);
        p.script = (dt, pl) => { pl.input.fwd = 1; };
        let vpk = 0; pt.sim(3.2, 1 / 60, () => { vpk = Math.max(vpk, t.v); });
        o.wall = { frontGap: r2((wx - t.pos.x) * t.fwdX + (wz - t.pos.z) * t.fwdZ - 0.3 - 3.4, 2), speedAtWall: r2(t.v, 2), peak: r2(vpk, 1), stillDriving: t.state };
        vm.engine.scene.remove(wall); col.build(vm.world.colliders); p.script = () => {}; }
      // the main gun at an infected 30 m ahead
      p.script = (dt, pl) => { pl.input.fwd = -1; }; pt.sim(1.5); p.script = () => {}; pt.sim(0.5);
      const z = Z.spawn(t.pos.x + t.fwdX * 30, t.pos.z + t.fwdZ * 30, { type: 'walker' });
      if (z) pt.still(z);
      const aimAt = z.pos.clone(); aimAt.y += 0.9;
      p.script = (dt, pl) => pl.lookAt(aimAt, 999, dt);
      const laidAfter = pt.sim(4, 1 / 60, (tt) => tt < 0.3 || !t.laid);
      pt.sim(0.1);
      const k0 = g.operation.kit.stats.blastKills, sh0 = t.shots, pv0 = t.pv;
      p.script = (dt, pl) => { pl.lookAt(aimAt, 999, dt); pl.input.fire = true; };
      pt.sim(1 / 60); p.script = () => {};
      o.gun = { laidAfter: r2(laidAfter, 2), fired: t.shots - sh0, recoil: r2(t.recoil, 2), hullKick: r2(t.pv - pv0, 2), reload: r2(t.reload, 1), target: z ? z.alive : null, blast: g.operation.kit.stats.lastBlast, zAt: pt.arr(z.pos), aimP: pt.arr(t.aimP), tank: pt.arr(t.pos), tYaw: r2(t.tYaw, 3), gP: r2(t.gPitch, 3), pYaw: r2(p.yaw - t.yaw, 3), pPitch: r2(p.pitch, 3) };
      pt.sim(0.12);
      return o;
    });
    await shotAb('tank_gun');
    await section(page, 'ab tank end', () => {
      const vm = __vm, g = vm.game, p = g.player, T = vm.THREE, col = g.collision, t = window.__tank, ab = window.__tankAb, kit = g.operation.kit, { r2 } = pt;
      if (!t) return 'no tank';
      const o = {};
      const tEnd = pt.sim(16, 1 / 30, () => p.vehicle === t);
      o.dismount = { after: r2(tEnd, 1), state: t.state, gap: r2(Math.hypot(p.pos.x - t.pos.x, p.pos.z - t.pos.z), 2), solid: !!t.box, weapon: g.weapon.visible, onGround: p.onGround, abActive: ab.active };
      const pv = p.pos.clone();
      p.yaw = t.yaw + Math.PI * 0.5;
      p.script = (dt, pl) => { pl.input.fwd = 1; };
      pt.sim(3); p.script = () => {};
      o.walkedAway = r2(Math.hypot(p.pos.x - pv.x, p.pos.z - pv.z), 1);
      let leftAt = null;
      const tg = pt.sim(60, 1 / 30, (tt) => { if (leftAt === null && t.state === 'leave') leftAt = tt; return kit.tanks.includes(t); });
      o.leave = { startedAfter: r2(leftAt, 1), removedAfter: r2(tg, 1), tanks: kit.tanks.length, engineLoop: g.audio.want.has('tank_engine'), lastDist: r2(Math.hypot(p.pos.x - t.pos.x, p.pos.z - t.pos.z), 0) };
      return o;
    });
    await section(page, 'ab mortar', () => {
      const vm = __vm, g = vm.game, op = g.operation, p = g.player, Z = g.zombies, kit = op.kit, { r2 } = pt;
      Z.clear(); Z.passive = true; p.health = p.maxHealth;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), mx = p.pos.x + fx * 30, mz = p.pos.z + fz * 30;
      const tgt = new vm.THREE.Vector3(mx, vm.terrain.heightAt(mx, mz), mz);
      p.script = (dt, pl) => pl.lookAt(tgt, 999, dt); pt.sim(0.3);
      __ab('mortar', 3);
      const zs = [];
      for (let i = 0; i < 11; i++) { const a = i * 2.4, r = i < 8 ? 0.8 + i * 0.75 : 17 + i; const z = Z.spawn(mx + Math.cos(a) * r, mz + Math.sin(a) * r, { type: 'walker' }); if (z) { pt.still(z); zs.push(z); } }
      const used = op.useAbility(0), mark = kit.marks[kit.marks.length - 1];
      window.__mortar = { zs, impacts: kit.shells.map((s) => s.pos.clone()), h0: p.health, k0: kit.stats.blastKills, R: 5.5 };
      pt.sim(3.25);
      return { used, markErr: mark ? r2(mark.pos.distanceTo(tgt), 2) : null, shells: window.__mortar.impacts.length, landedSoFar: window.__mortar.impacts.length - kit.shells.length };
    });
    await shotAb('mortar');
    await section(page, 'ab mortar sky', () => { const vm = __vm, p = __vm.game.player, k = __vm.game.operation.kit; const m = k.marks[0] ? k.marks[0].pos.clone() : null; if (m) { m.y += 16; p.script = (dt, pl) => pl.lookAt(m, 999, dt); } pt.sim(0.9); p.script = () => {}; return { particles: __vm.game.fx.n }; });
    await shotAb('mortar_sky');
    await section(page, 'ab mortar end', () => {
      const vm = __vm, g = vm.game, p = g.player, kit = g.operation.kit, m = window.__mortar, { r2 } = pt;
      pt.sim(5);
      const near = (z) => Math.min(...m.impacts.map((q) => Math.hypot(q.x - z.pos.x, q.z - z.pos.z)));
      const inside = m.zs.filter((z) => near(z) < m.R - 0.5), outside = m.zs.filter((z) => near(z) > m.R + 0.3);
      const o = { insideRadius: `${inside.filter((z) => !z.alive || z.health < z.maxHealth).length}/${inside.length} hit, ${inside.filter((z) => !z.alive).length} dead`, outsideUntouched: `${outside.filter((z) => z.alive && z.health >= z.maxHealth).length}/${outside.length}`, kills: kit.stats.blastKills - m.k0, playerAt30m: r2(m.h0 - p.health, 1), scorches: kit.scorches.count, particles: g.fx.n };
      // a shell at 3 m from the player: it hurts, a little
      const h1 = p.health; kit.explode(new vm.THREE.Vector3(p.pos.x + 3, vm.terrain.heightAt(p.pos.x + 3, p.pos.z), p.pos.z), { radius: 5.5, damage: 420, player: 0.08 });
      o.playerAt3m = r2(h1 - p.health, 1); pt.sim(2); p.health = p.maxHealth;
      return o;
    });
    await section(page, 'ab sentry', () => {
      const vm = __vm, g = vm.game, op = g.operation, p = g.player, Z = g.zombies, kit = op.kit, { r2 } = pt;
      Z.clear(); Z.passive = true; p.script = () => {}; p.pitch = -0.1;
      __ab('sentry', 1);
      const used = op.useAbility(0), s = kit.sentries[kit.sentries.length - 1];
      window.__sentry = s;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      window.__sz = [[12, -5], [16, 3], [20, -1], [25, 6]].map(([d, l]) => { const z = Z.spawn(p.pos.x + fx * d + rx * l, p.pos.z + fz * d + rz * l, { type: 'walker' }); if (z) pt.still(z); return z; }).filter(Boolean);
      pt.sim(1.3);
      p.yaw -= 0.42; p.pitch = -0.2;
      const st = s.state;
      const t = pt.sim(4, 1 / 60, () => s.shots < 4);
      return { used, stateAfter13: st, firstShotsAfter: r2(t + 1.3, 2), gap: r2(Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z), 2) };
    });
    await shotAb('sentry');
    await section(page, 'ab sentry result', () => {
      const vm = __vm, g = vm.game, op = g.operation, p = g.player, Z = g.zombies, T = vm.THREE, col = g.collision, kit = op.kit, { r2 } = pt;
      let s = window.__sentry;
      pt.sim(10);
      const o = { kills: s.kills, shots: s.shots, dead: `${window.__sz.filter((z) => !z.alive).length}/${window.__sz.length}` };
      op._endAbilities(); pt.sim(1.2);
      o.afterEnd = s.state;
      // the wall: the only infected stands behind it
      Z.clear(); p.yaw += 1.2; pt.sim(0.1);
      __ab('sentry', 1); op.useAbility(0); s = kit.sentries[kit.sentries.length - 1];
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), wx = s.pos.x + fx * 5, wz = s.pos.z + fz * 5;
      const wall = new T.Mesh(new T.BoxGeometry(7, 3.4, 0.5), new T.MeshStandardMaterial({ color: 0x8c8983 }));
      wall.position.set(wx, vm.terrain.heightAt(wx, wz) + 1.5, wz); wall.rotation.y = p.yaw; wall.userData.surface = 'stone'; wall.updateMatrixWorld(true);
      vm.engine.scene.add(wall); col.build([...vm.world.colliders, wall]);
      const z = Z.spawn(s.pos.x + fx * 10, s.pos.z + fz * 10, { type: 'walker' }); pt.still(z);
      pt.sim(5);
      o.wall = { shots: s.shots, targetHealth: z.health, target: s.target ? 'locked' : 'none' };
      vm.engine.scene.remove(wall); col.build(vm.world.colliders);
      pt.sim(4);
      o.wallRemoved = { shots: s.shots, targetHealth: r2(z.health, 0), alive: z.alive };
      op._endAbilities(); pt.sim(1.2);
      return o;
    });
    await section(page, 'ab adrenaline', () => {
      const vm = __vm, g = vm.game, op = g.operation, p = g.player, Z = g.zombies, kit = op.kit, post = vm.engine.post.settings, { r2 } = pt;
      Z.clear(); Z.passive = false; pt.god = true;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      for (let i = 0; i < 3; i++) Z.spawn(p.pos.x + fx * (22 + i * 3) + i * 2 - 2, p.pos.z + fz * (22 + i * 3), { type: 'runner', aware: true });
      p.pitch = 0;
      const sat0 = post.saturation;
      __ab('adrenaline', 1);
      const used = op.useAbility(0);
      pt.sim(0.8);
      const t0 = Z.time, x0 = p.pos.clone();
      p.script = (dt, pl) => { pl.input.fwd = 1; };
      pt.sim(1); p.script = () => {};
      return { used, timeScale: r2(g.timeScale, 3), worldSecondsPerSecond: r2(Z.time - t0, 2), playerMetresPerSecond: r2(Math.hypot(p.pos.x - x0.x, p.pos.z - x0.z), 2), saturation: [r2(sat0), r2(post.saturation)], vignette: r2(post.vignette), heartbeat: g.audio.want.has('heartbeat'), pulse: r2(g.pulse) };
    });
    await shotAb('adrenaline');
    await section(page, 'ab adrenaline end', () => {
      const vm = __vm, g = vm.game, kit = g.operation.kit, post = vm.engine.post.settings, { r2 } = pt;
      pt.sim(6); pt.god = false; g.zombies.clear();
      return { timeScale: g.timeScale, restored: kit.post0 === null, saturation: r2(post.saturation), vignette: r2(post.vignette), pulse: g.pulse };
    });
    await section(page, 'ab jump', () => {
      const vm = __vm, g = vm.game, op = g.operation, p = g.player, kit = op.kit, { r2 } = pt;
      p.health = p.maxHealth; p.pitch = 0;
      __ab('jump', 3);
      p.script = (dt, pl) => { pl.input.fwd = 1; }; pt.sim(0.5);
      const used = op.useAbility(0);
      p.script = (dt, pl) => { pl.input.fwd = 1; pl.pitch = -1.0; };
      pt.sim(0.22);
      return { used, vy: r2(p.vel.y, 1), vh: r2(Math.hypot(p.vel.x, p.vel.z), 1), above: r2(pt.above()) };
    });
    await shotAb('jump');
    await section(page, 'ab jump land', () => {
      const vm = __vm, g = vm.game, p = g.player, kit = g.operation.kit, { r2 } = pt;
      pt.sim(3, 1 / 60, () => !kit.stats.jump.landed);
      p.script = () => {};
      const j = kit.stats.jump;
      return { apex: r2(j.apex - j.y0), dist: r2(j.dist, 1), health: [j.health, j.healthAfter], wouldHurtWithoutPack: r2(p.fallDamage(j.apex - j.y0), 1), boostCleared: !p.boost };
    });
    await section(page, 'ab hud + quit', () => {
      const vm = __vm, g = vm.game, p = g.player;
      p.mods.maxHealth = 125; p.health = 110; g.ui.update(g, 0.016);
      const segs = document.querySelectorAll('.hud .hp b').length, fill = [...document.querySelectorAll('.hud .hp i')].map((i) => i.style.transform);
      p.mods.maxHealth = 100; p.health = 100; g.ui.update(g, 0.016);
      const back = document.querySelectorAll('.hud .hp b').length;
      g.pause(); g.toMenu();
      return { segmentsAt125: segs, fill, segmentsAt100: back, stateAfterQuit: g.state, timeScale: g.timeScale, tanks: g.operation.kit.tanks.length };
    });
    await page.evaluate(() => { __vm.progress.reset(); });
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
  try { execFileSync(process.execPath, ['tools/sheet.mjs', file, '640', name === 'op' || name === 'ab' ? '3' : '2', ...files], { stdio: 'pipe' }); console.log('sheet:', file); } catch (e) { console.log('sheet failed:', String(e.message).slice(0, 300)); }
}
