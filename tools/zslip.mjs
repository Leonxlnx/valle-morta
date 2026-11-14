// Planted-foot slip per infected type and gait: each foot counts as planted while it is
// within 2 cm of its own lowest point (in body space); slip = its ground travel then.
//   node tools/zslip.mjs
import puppeteer from 'puppeteer-core'; import os from 'node:os'; import path from 'node:path';
import { acquireGpuLock } from './lib/gpulock.mjs';
await acquireGpuLock();
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile'), args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
try {
  const page = await b.newPage();
  await page.goto('http://127.0.0.1:5173/?q=low&auto=1', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 240000, polling: 250 });
  const r = await page.evaluate(() => {
    const vm = __vm, g = vm.game, Z = g.zombies, p = g.player, T = vm.THREE; vm.stop(); g.start();
    const GAIT = { walker: [1.0, 3.0, 4.2], runner: [1.5, 3.4, 5.2], brute: [1.6, 3.2, 4.4], boss: [2.2, 6.6, 7.6] }, out = {};
    for (const type in GAIT) for (const sp of GAIT[type]) {
      g.interT = 1e9; g.queue = 0; g.queueList = []; g.cleared = true; Z.clear(); Z.noCull = true; p.spawn(40, -90, 0);
      const z = Z.spawn(8, -46, { type, aware: true, speed: sp }); z.chargeCd = 999; z.slamCd = 999; z.alertT = -1;
      const feet = [z.bones.FootL, z.bones.FootR], w = new T.Vector3();
      const run = (n, each) => { for (let i = 0; i < n; i++) { vm.cam(z.pos.x + 3, z.pos.y + 1.5, z.pos.z + 3, z.pos.x, z.pos.y + 1, z.pos.z); g.update(1 / 60); p.health = p.maxHealth; z.root.updateWorldMatrix(true, true); each && each(); } };
      const ymin = [1e9, 1e9];
      run(150, () => feet.forEach((f, k) => { ymin[k] = Math.min(ymin[k], z.root.worldToLocal(f.getWorldPosition(w)).y); }));
      const prev = [null, null]; let slip = 0, st = 0, gs = 0, n = 0;
      run(150, () => {
        feet.forEach((f, k) => { f.getWorldPosition(w); const y = z.root.worldToLocal(w.clone()).y, down = y < ymin[k] + 0.02 * z.scale; if (down && prev[k]) { slip += Math.hypot(w.x - prev[k].x, w.z - prev[k].z); st += 1 / 60; } prev[k] = down ? { x: w.x, z: w.z } : null; });
        gs += z.gs; n++;
      });
      out[`${type}@${sp}`] = `${z.currentName} rate ${z.rate.toFixed(2)} v ${(gs / n).toFixed(2)} slip ${(100 * slip / st / (gs / n)).toFixed(1)}% (${st.toFixed(1)} s planted)`;
    }
    return out;
  });
  for (const k in r) console.log(k.padEnd(12), r[k]);
} finally { await b.close(); }
