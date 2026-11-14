// Planted-foot slip per infected type and gait, from ground truth: one infected walks in a
// straight line along the main street at an authored gait speed, the game is stepped at
// 1/60 s (__vm.step) and the world positions of both foot bones are logged every frame.
// Per frame the support foot is the lower one (height above the ground under it), counted
// only while it is near its own lowest height (a run's flight phase has no support).
// slip = horizontal distance the support foot moves while supporting / distance the body
// travels over the same frames.  A planted foot is a plateau in world position: 0 %.
//   node tools/zslip.mjs [--types walker,boss] [--trace walker@1] [--out file.csv]
import puppeteer from 'puppeteer-core'; import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { acquireGpuLock } from './lib/gpulock.mjs';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const types = String(arg('types', 'walker,runner,brute,boss')).split(',');
const trace = arg('trace', ''), outCsv = arg('out', 'tools/_preview/zcap/slip_trace.csv');
await acquireGpuLock();
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile'), args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const errors = [];
try {
  const page = await b.newPage();
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:5173/?q=low&auto=1', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 240000, polling: 250 });
  const GAIT = { walker: [1.0, 3.0, 4.2], runner: [1.5, 3.4, 5.2], brute: [1.6, 3.2, 4.4], boss: [2.2, 6.6, 7.6] };
  const rows = [];
  // --perf: CPU of Zombies.update and of a whole rendered frame with 20 and 40 hunting infected
  // in front of the player (the playtest's layout), each measured twice, the lower kept
  if (process.argv.includes('--perf')) {
    const r = await page.evaluate(() => {
      const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, out = {};
      Z.maxActive = 40; Z.animAll = false;
      vm.stop(); if (g.state !== 'playing') g.start();
      const hold = () => { g.interT = 1e9; g.queue = 0; g.queueList = []; g.cleared = true; };
      const T = vm.THREE, d = new T.Vector3(14, 0, -18).normalize(), C = new T.Vector3(8 + d.x, 0, -46 + d.z);
      const zu = Z.update.bind(Z); let zt = 0; Z.update = (dt) => { const t = performance.now(); zu(dt); zt += performance.now() - t; };
      const sim = (n) => { for (let i = 0; i < n; i++) { g.update(1 / 60); p.health = p.maxHealth; if (g.state !== 'playing') g.state = 'playing'; } };
      const cpu = (n) => { zt = 0; const t = performance.now(); sim(n); return [(performance.now() - t) / n, zt / n]; };
      const frame = (n) => { zt = 0; const t = performance.now(); for (let i = 0; i < n; i++) { vm.step(1 / 60); p.health = p.maxHealth; } return [(performance.now() - t) / n, zt / n]; };
      for (const N of [0, 20, 40]) {
        Z.clear(); hold(); p.spawn(C.x - d.x * 3, C.z - d.z * 3, Math.atan2(-d.x, -d.z)); p.script = (dt, pl) => { pl.health = 100; };
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
        for (let i = 0; i < N; i++) {
          const row = (i / 5) | 0, k = (i % 5) - 2, dd = 8 + row * 4.5 + Math.random(), side = k * dd * 0.24 + (Math.random() - 0.5);
          Z.spawn(p.pos.x + fx * dd - fz * side, p.pos.z + fz * dd + fx * side, { type: i % 3 === 0 ? 'runner' : 'walker', aware: true, yaw: Math.atan2(-fx, -fz) });
        }
        sim(48);
        const best = [1e9, 1e9, 1e9, 1e9], prof = {};
        for (let rep = 0; rep < 2; rep++) {
          const [c, zc] = cpu(120);
          Z.prof = {}; cpu(60); const pr = Z.prof; Z.prof = null;
          const [f, zf] = frame(60);
          if (zc < best[1]) { for (const k in pr) prof[k] = +(pr[k] / 60).toFixed(3); }
          best[0] = Math.min(best[0], c); best[1] = Math.min(best[1], zc); best[2] = Math.min(best[2], f); best[3] = Math.min(best[3], zf);
        }
        out[N] = { alive: Z.aliveCount, updateMs: +best[0].toFixed(3), zombiesUpdateMs: +best[1].toFixed(3), frameMs: +best[2].toFixed(2), prof };
      }
      for (const N of [20, 40]) { out[N].frameAddedMs = +(out[N].frameMs - out[0].frameMs).toFixed(2); }
      return out;
    });
    for (const k in r) console.log(`${k} infected`.padEnd(12), JSON.stringify(r[k]));
  }
  for (const type of (process.argv.includes('--perf') ? [] : types)) for (const sp of GAIT[type]) {
    const want = trace === `${type}@${sp}`;
    const r = await page.evaluate((type, sp, want) => {
      const vm = __vm, g = vm.game, Z = g.zombies, p = g.player, T = vm.THREE, H = (x, z) => vm.terrain.heightAt(x, z);
      vm.stop(); if (g.state !== 'playing') g.start();
      g.interT = 1e9; g.queue = 0; g.queueList = []; g.cleared = true; Z.clear(); Z.noCull = true; Z.passive = false;
      Z.animAll = true;   // the camera follows the player 70 m ahead: measure the clip at the full (near) animation rate
      const d = new T.Vector3(14, 0, -18).normalize(), C = new T.Vector3(8 + d.x * 9, 0, -46 + d.z * 9);
      const step = () => { vm.step(1 / 60); p.health = p.maxHealth; if (g.state !== 'playing') g.state = 'playing'; };
      p.spawn(C.x + d.x * 70, C.z + d.z * 70, 0); p.script = () => {};
      const warm = Math.max(2, sp / 2.5 + 1.2), back = sp * warm + 0.5;
      const z = Z.spawn(C.x - d.x * back, C.z - d.z * back, { type, aware: true, yaw: Math.atan2(d.x, d.z), speed: sp });
      z.def = { ...z.def, flank: false, lunge: 0 }; z.chargeCd = 1e9; z.slamCd = 1e9; z.alertT = -1; z.direct = true; z.losT = 1e9;
      const feet = [z.bones.FootL, z.bones.FootR], w = new T.Vector3();
      const cam = () => vm.cam(z.pos.x - d.z * 4, z.pos.y + 1.4, z.pos.z + d.x * 4, z.pos.x, z.pos.y + 0.9, z.pos.z);
      for (let i = 0; i < Math.round(warm * 60); i++) { cam(); step(); }
      const D = z.actions[z.lastGait], cyc = D.getClip().duration / Math.max(0.05, z.rate);
      const N = Math.max(90, Math.round(cyc * 2 * 60) + 2), F = [];
      let gs = 0;
      for (let i = 0; i < N; i++) {
        cam(); step(); z.root.updateWorldMatrix(true, true);
        const fr = { bx: z.pos.x, bz: z.pos.z };
        feet.forEach((f, k) => { f.getWorldPosition(w); fr['x' + k] = w.x; fr['z' + k] = w.z; fr['h' + k] = w.y - H(w.x, w.z); });
        if (want) Object.assign(fr, { t: D.time, ts: D.timeScale, wt: D.getEffectiveWeight(), ph: z.phase, rate: z.rate, nm: z.currentName });
        F.push(fr); gs += z.gs;
      }
      // the ground-truth measure
      const hmin = [Math.min(...F.map((f) => f.h0)), Math.min(...F.map((f) => f.h1))], tol = 0.03 * z.scale;
      let slip = 0, body = 0, sup = 0;
      for (let i = 1; i < N; i++) {
        const a = F[i - 1], c = F[i];
        const k = c.h0 <= c.h1 ? 0 : 1, kp = a.h0 <= a.h1 ? 0 : 1;
        if (k !== kp || c['h' + k] > hmin[k] + tol || a['h' + k] > hmin[k] + tol) continue;
        slip += Math.hypot(c['x' + k] - a['x' + k], c['z' + k] - a['z' + k]);
        body += Math.hypot(c.bx - a.bx, c.bz - a.bz); sup++;
      }
      return { clip: z.currentName, rate: +z.rate.toFixed(2), v: +(gs / N).toFixed(2), cyc: +cyc.toFixed(2), slip: body > 0 ? (100 * slip) / body : -1, supS: sup / 60, N, frames: want ? F : null };
    }, type, sp, want);
    if (r.frames) {
      const k = Object.keys(r.frames[0]);
      fs.writeFileSync(outCsv, [k.join(','), ...r.frames.map((f) => k.map((c) => (typeof f[c] === 'number' ? +f[c].toFixed(4) : f[c])).join(','))].join('\n'));
    }
    rows.push(`${`${type}@${sp}`.padEnd(12)} ${r.clip.padEnd(6)} rate ${r.rate.toFixed(2)} v ${r.v.toFixed(2)} cycle ${r.cyc}s  slip ${r.slip.toFixed(1).padStart(5)}%  (support ${r.supS.toFixed(2)} s of ${(r.N / 60).toFixed(2)})`);
    console.log(rows[rows.length - 1]);
  }
} finally { await b.close(); }
if (errors.length) console.log('console:\n' + [...new Set(errors)].slice(0, 8).join('\n'));
