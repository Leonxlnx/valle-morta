// Infected capture: spawns each type on the main street and grabs a contact sheet per type
// (idle, alert, walk, run/sprint, attack, hit, both deaths, blood pool; boss roar/charge/slam)
// plus a side-on 8-frame strip of every locomotion clip while it walks across the view,
// and measures planted-foot slip.  Deterministic: the game is stepped at 1/60 s.
//   node tools/zcap.mjs --types walker,runner,brute,boss --tag after --out tools/_preview/zcap
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { acquireGpuLock } from './lib/gpulock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const types = String(arg('types', 'walker,runner,brute,boss')).split(',');
const tag = arg('tag', 'cap'), out = arg('out', 'tools/_preview/zcap'), q = arg('q', 'high');
const W = 1280, H = 720;
fs.mkdirSync(out, { recursive: true });
await acquireGpuLock();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile'), defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio'],
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 300)}`));
  const boot = async () => {
  await page.goto(`http://127.0.0.1:5173/?q=${q}&auto=1`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 240000, polling: 250 });
  await page.evaluate(() => {
    const vm = window.__vm, g = vm.game, T = vm.THREE, Z = g.zombies, p = g.player;
    vm.stop(); g.start();
    for (const el of document.body.querySelectorAll('body > *')) if (el.tagName !== 'CANVAS' && !el.querySelector('canvas') && el.tagName !== 'SCRIPT') el.style.visibility = 'hidden';
    const A = [8, -46], d = new T.Vector3(14, 0, -18).normalize(), n = new T.Vector3(-d.z, 0, d.x);
    const C = new T.Vector3(A[0] + d.x, 0, A[1] + d.z);
    const H = (x, z) => vm.terrain.heightAt(x, z);
    const S = window.zc = {
      d, n, C,
      hold() { g.interT = 1e9; g.queue = 0; g.queueList = []; g.cleared = true; },
      sim(sec, each) { const k = Math.round(sec * 60); for (let i = 0; i < k; i++) { vm.step(1 / 60); p.health = p.maxHealth; if (g.state !== 'playing') g.state = 'playing'; if (each && each(1 / 60) === false) return; } },
      reset() { if (g.state !== 'playing') g.start(); Z.clear(); S.hold(); Z.passive = true; Z.noCull = true; p.spawn(C.x - d.x * 3, C.z - d.z * 3, Math.atan2(-d.x, -d.z) + Math.PI); p.enabled = true; p.script = () => {}; try { g.weapon.root.visible = false; } catch (e) { /**/ } S.sim(0.1); },
      // three of a type at 4, 10, 25 m down the street, facing the camera
      trio(type, opt = {}) {
        S.reset();
        return [[4, -0.9], [10, 1.0], [25, 0]].map(([r, s]) => { const x = C.x + d.x * r + n.x * s, z = C.z + d.z * r + n.z * s; const zb = Z.spawn(x, z, { type, yaw: Math.atan2(-d.x, -d.z), variant: Math.round(r) % 3, ...opt }); zb.wanderT = 1e9; zb.wanderGo = false; return zb; });
      },
      camMain() { vm.cam(C.x, H(C.x, C.z) + 1.65, C.z, C.x + d.x * 10, H(C.x + d.x * 10, C.z + d.z * 10) + 1.0, C.z + d.z * 10); },
      camSide(m, dist) { vm.cam(m.x + n.x * dist, H(m.x + n.x * dist, m.z + n.z * dist) + 1.0, m.z + n.z * dist, m.x, H(m.x, m.z) + 0.95, m.z); },
      // screen position of a world point (for crops)
      scr(v) { const c = vm.engine.camera; c.updateMatrixWorld(); const s = v.clone().project(c); return [(s.x * 0.5 + 0.5) * innerWidth, (0.5 - s.y * 0.5) * innerHeight]; },
    };
    return true;
  });
  };
  await boot();
  const snap = async (file, clip) => {
    await page.evaluate(async () => { const vm = window.__vm; vm.game.state = 'paused'; vm.start(); for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r)); vm.stop(); vm.game.state = 'playing'; });
    await page.screenshot({ path: file, type: 'jpeg', quality: 88, ...(clip ? { clip } : {}) });
    return file;
  };
  const GAIT = { walker: [1.0, 3.0, 4.2], runner: [1.5, 3.4, 5.2], brute: [1.6, 3.2, 4.4], boss: [2.2, 6.6, 7.6] };
  const report = {};
  for (let ti = 0, tries = 0; ti < types.length; ti++) {
    const type = types[ti];
    try {
    const tiles = [], strip = [];
    const T = (nm) => path.join(out, `${type}_${nm}_${tag}.jpg`);
    // ---- idle
    let info = await page.evaluate((type) => { const zs = zc.trio(type); zc.sim(1.5); zc.camMain(); const z = zs[0], hy = z.bones.Head ? z.bones.Head.getWorldPosition(new __vm.THREE.Vector3()).y - z.pos.y + 0.2 * z.scale : 0; return { height: +hy.toFixed(2), scale: +z.scale.toFixed(2), bulk: z.bulk, mat: z.mesh.material.userData.variant, set: z.set.name, borrowed: z.borrowed, rough: z.mesh.material.roughness, color: z.mesh.material.color.getHexString() }; }, type);
    tiles.push(await snap(T('a_idle')));
    // ---- alert: the player is noticed
    await page.evaluate(() => { const Z = __vm.game.zombies; Z.passive = false; zc.sim(0.45); zc.camMain(); });
    tiles.push(await snap(T('b_alert')));
    // ---- walk and run/sprint towards the camera
    for (const [nm, sp] of [['c_walk', GAIT[type][0]], ['d_fast', GAIT[type][type === 'boss' ? 1 : 2]]]) {
      await page.evaluate((type, sp) => { const zs = zc.trio(type, { aware: true }); const p = __vm.game.player; for (const z of zs) { z.speed = sp; z.chargeCd = 999; z.slamCd = 999; const b = (z.pos.clone().sub(zc.C)).length(); z.pos.addScaledVector(zc.d, sp * 1.6); z.root.position.copy(z.pos); } __vm.game.zombies.passive = false; zc.sim(1.6); zc.camMain(); }, type, sp);
      tiles.push(await snap(T(nm)));
    }
    // ---- attack, hit
    await page.evaluate((type) => { const Z = __vm.game.zombies; const zs = zc.trio(type); zc.sim(0.5); for (const z of zs) { z.state = 'attack'; z.stateT = 0; z.attackHit = true; Z._play(z, 'Attack', 0.12, z.def.attackRate, true); } zc.sim(0.42); zc.camMain(); }, type);
    tiles.push(await snap(T('e_attack')));
    await page.evaluate((type) => { const Z = __vm.game.zombies; const zs = zc.trio(type); zc.sim(0.5); for (const z of zs) { const dir = z.pos.clone().sub(zc.C).setY(0).normalize(); Z.damage(z, 1, z.type === 'brute' ? 'head' : 'torso', dir); } zc.sim(0.16); zc.camMain(); }, type);
    tiles.push(await snap(T('f_hit')));
    // ---- deaths: shot from the camera (falls backwards) and from behind (falls forwards)
    for (const [nm, back] of [['g_deathBack', 1], ['h_deathFront', -1]]) {
      await page.evaluate((type, back) => { const Z = __vm.game.zombies; const zs = zc.trio(type); zc.sim(0.4); for (const z of zs) { const dir = z.pos.clone().sub(zc.C).setY(0).normalize().multiplyScalar(back); z.health = 1; Z.damage(z, 1e6, 'torso', dir); } zc.sim(4); zc.camMain(); }, type, back);
      tiles.push(await snap(T(nm)));
    }
    // ---- corpse and pool, close and from above
    await page.evaluate(() => { zc.sim(7); const z = __vm.game.zombies.list[0]; const P = z.pos, v = zc.C; __vm.cam(P.x - zc.d.x * 2.4 + zc.n.x * 1.2, z.pos.y + 2.4, P.z - zc.d.z * 2.4 + zc.n.z * 1.2, P.x, z.pos.y + 0.1, P.z); });
    tiles.push(await snap(T('i_pool')));
    if (type === 'boss') {
      await page.evaluate(() => { const Z = __vm.game.zombies; const [z] = zc.trio('boss'); for (const o of Z.list.slice(1)) o.root.visible = false; Z.list.length = 1; z.pos.addScaledVector(zc.d, 10); z.root.position.copy(z.pos); zc.sim(0.3); z.aware = true; Z.passive = false; z.state = 'roar'; z.stateT = 0; z.chargeCd = 99; z.slamCd = 99; const c = z.def.clips.roar; Z._play(z, z.set.clips[c] ? c : 'Attack', 0.2, 1, true); zc.sim(0.5); zc.camMain(); });
      tiles.push(await snap(T('j_roar')));
      await page.evaluate(() => { zc.sim(0.4 + 0.7); zc.camMain(); });
      tiles.push(await snap(T('k_charge')));
      await page.evaluate(() => { const Z = __vm.game.zombies; const [z] = zc.trio('boss'); for (const o of Z.list.slice(1)) o.root.visible = false; Z.list.length = 1; z.pos.addScaledVector(zc.d, 2); z.root.position.copy(z.pos); zc.sim(0.3); z.aware = true; z.chargeCd = 99; z.slamCd = 0; Z.passive = false; zc.sim(0.9); zc.camMain(); return z.state; });
      tiles.push(await snap(T('l_slam')));
    }
    // ---- side-on strips: 8 frames over one gait cycle while it walks across, plus slip
    report[type] = { ...info, gait: {} };
    for (const [ci, sp] of GAIT[type].entries()) {
      const r = await page.evaluate((type, sp) => {
        const vm = __vm, Z = vm.game.zombies, p = vm.game.player, THREE = vm.THREE, H = (x, z) => vm.terrain.heightAt(x, z);
        zc.reset(); Z.passive = false;
        const m = zc.C.clone().addScaledVector(zc.d, 8);
        p.spawn(m.x + zc.d.x * 60, m.z + zc.d.z * 60, 0);
        const warm = Math.max(2.2, sp / 2.2 + 1.2), back = sp * warm * 0.92 + 0.6;
        const z = Z.spawn(m.x - zc.d.x * back, m.z - zc.d.z * back, { type, aware: true, yaw: Math.atan2(zc.d.x, zc.d.z), speed: sp });
        z.chargeCd = 999; z.slamCd = 999; z.direct = true;
        const fl = z.bones.FootL, fr = z.bones.FootR, a = new THREE.Vector3(), b = new THREE.Vector3();
        let ymin = 1e9, prev = null, slip = 0, st = 0, gs = 0, gn = 0;
        const meas = () => {
          z.root.updateWorldMatrix(true, true); fl.getWorldPosition(a); fr.getWorldPosition(b);
          const ha = a.y - H(a.x, a.z), hb = b.y - H(b.x, b.z); ymin = Math.min(ymin, ha, hb);
          const f = ha < hb ? 0 : 1, P = f ? b : a, down = Math.min(ha, hb) < ymin + 0.03 * z.scale;
          if (prev && prev.f === f && down && prev.down) { slip += Math.hypot(P.x - prev.x, P.z - prev.z); st += 1 / 60; }
          prev = { f, x: P.x, z: P.z, down }; gs += z.gs; gn++;
        };
        zc.sim(warm * 0.5); ymin = 1e9; zc.sim(warm * 0.5, meas);
        const cyc = z.current ? z.current.getClip().duration / Math.max(0.05, Math.abs(z.current.timeScale)) : 1;
        return { cyc, clip: z.currentName, rate: +(z.current ? z.current.timeScale : 0).toFixed(2), gs: +(gs / gn).toFixed(2), slip: slip / Math.max(st, 1e-3), st, mx: m.x, mz: m.z };
      }, type, sp);
      const frames = [];
      for (let k = 0; k < 8; k++) {
        const crop = await page.evaluate((cyc, k) => {
          const vm = __vm, z = vm.game.zombies.list[0];
          if (k) zc.sim(cyc / 8);
          const at = z.pos.clone(); zc.camSide(at, 3.4 * Math.max(1, z.scale * (z.set.height / 1.8)));
          const [x, y] = zc.scr(at.clone().setY(at.y + 0.9 * z.set.height / 1.8));
          return { x, y, name: z.currentName };
        }, r.cyc, k);
        const s = 640;
        frames.push(await snap(T(`s${ci}_${k}`), { x: Math.max(0, Math.min(W - s, crop.x - s / 2)), y: 40, width: s, height: s }));
      }
      strip.push(...frames);
      report[type].gait[sp] = { clip: r.clip, rate: r.rate, groundSpeed: r.gs, slipMps: +r.slip.toFixed(3), slipPct: +((100 * r.slip) / Math.max(0.1, r.gs)).toFixed(1), plantedS: +r.st.toFixed(1) };
    }
    const cols = tiles.length > 9 ? 4 : 3;
    const top = path.join(out, `_${type}_top.jpg`), bot = path.join(out, `_${type}_bot.jpg`), sheet = path.join(out, `sheet_${type}_${tag}.jpg`);
    execFileSync('node', ['tools/sheet.mjs', top, String(1280 / cols), String(cols), ...tiles]);
    execFileSync('node', ['tools/sheet.mjs', bot, '160', '8', ...strip]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', top, '-i', bot, '-filter_complex', '[0:v]scale=1280:-2[a];[1:v]scale=1280:-2[b];[a][b]vstack=inputs=2', '-q:v', '3', sheet]);
    console.log(type, JSON.stringify(report[type]), '->', sheet);
    } catch (e) {
      if (++tries > 4 || !/context|navigat|detached/i.test(String(e))) throw e;
      console.log(`${type}: page reloaded (${String(e.message).slice(0, 60)}), retrying`); ti--;
      await new Promise((r) => setTimeout(r, 20000)); await boot();
    }
  }
} finally {
  await browser.close();
}
if (errors.length) console.log('console:\n' + [...new Set(errors)].slice(0, 10).join('\n'));
