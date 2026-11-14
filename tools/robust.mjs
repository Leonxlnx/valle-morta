// Robustness pass through the real menus: survival -> death -> menu, operation -> pause -> quit,
// quality presets changed in game, several cycles; reports listeners, audio loops, GPU memory and
// scene size after each cycle (they must not grow), and every console error or warning.
//   node tools/robust.mjs [--cycles 4] [--missing]   (--missing: run with a renamed model and sound)
import puppeteer from 'puppeteer-core'; import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { acquireGpuLock } from './lib/gpulock.mjs';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const cycles = Number(arg('cycles', 4)), missing = !!arg('missing', false);
const HIDE = ['public/assets/models/pistol.glb', 'public/assets/audio/dry_fire.mp3'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await acquireGpuLock();
if (missing) for (const f of HIDE) fs.renameSync(f, f + '.hidden');
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000, userDataDir: path.join(os.tmpdir(), 'vm-chrome-robust'), args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,720'] });
const msgs = [];
try {
  const page = await b.newPage(); await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => msgs.push('pageerror ' + String(e).slice(0, 240)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.type() === 'warn') msgs.push(`${m.type()} ${m.text().slice(0, 240)}`); });
  page.on('requestfailed', (r) => msgs.push('requestfailed ' + r.url().slice(-60)));
  page.on('response', (r) => { if (r.status() >= 400) msgs.push(`http ${r.status()} ${r.url().slice(-60)}`); });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => window.__vm && window.__vm.ready && document.querySelector('.menu.show'), { timeout: 600000, polling: 500 });
  await page.evaluate(() => { Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.getElementById('view') }); __vm.progress.reset(); __vm.progress.grant(3000); });
  const cdp = await page.target().createCDPSession();
  const listeners = async () => { const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' }); const w = (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.length; const { result: d } = await cdp.send('Runtime.evaluate', { expression: 'document' }); return w + (await cdp.send('DOMDebugger.getEventListeners', { objectId: d.objectId })).listeners.length; };
  const until = (fn, t = 120000) => page.waitForFunction(fn, { timeout: t, polling: 250 });
  const snap = async (tag) => {
    const s = await page.evaluate(() => { const vm = __vm, e = vm.engine, r = e.renderer, A = vm.game.audio; let n = 0; e.scene.traverse(() => n++); return { state: vm.game.state, geo: r.info.memory.geometries, tex: r.info.memory.textures, nodes: n, loops: [...(A.want ? A.want.keys() : [])].join(','), alive: vm.game.zombies.list.length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1 }; });
    s.listeners = await listeners(); console.log(tag.padEnd(22), JSON.stringify(s));
  };
  await snap('menu');
  for (let c = 0; c < cycles; c++) {
    // survival: play, change quality in game, die, back to the menu
    await page.click('.menu [data-act="play"]'); await until(() => __vm.game.state === 'playing'); await sleep(1500);
    if (missing && c === 0) {
      const r = await page.evaluate(async () => { const g = __vm.game, w = g.weapon; w.switchTo('pistol'); for (let i = 0; i < 40; i++) await new Promise((q) => requestAnimationFrame(q)); w.ammo = 0; g.player.input.fire = true; for (let i = 0; i < 10; i++) await new Promise((q) => requestAnimationFrame(q)); g.player.input.fire = false; return { weapon: w.id, standIn: !!(w.view && w.view.standIn), visible: __vm.engine.weaponVisible }; });
      console.log('missing assets:', JSON.stringify(r));
    }
    await page.keyboard.press('KeyP'); await sleep(600);
    if (await page.$('.pause.show')) {
      await page.click('.pause [data-act="settings"]').catch(() => msgs.push('tool: no settings button in pause'));
      await sleep(500);
      const q = c % 2 ? 'low' : 'ultra';
      await page.evaluate((q) => { const root = [...document.querySelectorAll('.panel')].find((x) => x.querySelector('.rows') && x.offsetParent); const btn = root && (root.querySelector(`.seg button[data-v="${q}"]`) || root.querySelector('.seg button[data-v="medium"]')); if (btn) btn.click(); }, q);
      await sleep(1500);
      await page.evaluate(() => { const root = [...document.querySelectorAll('.panel')].find((x) => x.querySelector('.rows') && x.offsetParent); const back = root && root.querySelector('[data-act="back"]'); if (back) back.click(); });
      await sleep(500); await page.click('.pause [data-act="resume"]').catch(() => msgs.push('tool: no resume'));
    } else msgs.push('tool: P did not pause');
    await sleep(1000);
    await page.evaluate(() => { __vm.game.player.damage(999); });
    await until(() => document.querySelector('.over.show')); await sleep(800);
    await page.click('.over [data-act="quit"]'); await until(() => document.querySelector('.menu.show'));
    await snap(`c${c} after survival`);
    // operation: deploy, wait for the landing, pause, quit to the menu
    await page.click('.menu [data-act="operation"]'); await until(() => document.querySelector('.base.show')); await sleep(400);
    await page.click('.base [data-act="deploy"]');
    await until(() => __vm.game.state === 'playing' && !(__vm.game.operation && __vm.game.operation.cinematic), 300000); await sleep(1500);
    await page.keyboard.press('KeyP'); await sleep(600);
    const quit = await page.$('.pause [data-act="quit"]'); if (quit) await quit.click(); else msgs.push('tool: no quit in pause');
    await sleep(1200);
    if (await page.$('.debrief.show')) { await page.click('.debrief [data-act="base"]'); await sleep(600); }
    if (await page.$('.base.show')) { const m = await page.$('.base [data-act="quit"]'); if (m) await m.click(); }
    await until(() => document.querySelector('.menu.show')).catch(() => msgs.push('tool: not back at the menu after operation'));
    await snap(`c${c} after operation`);
  }
} finally {
  await b.close();
  if (missing) for (const f of HIDE) if (fs.existsSync(f + '.hidden')) fs.renameSync(f + '.hidden', f);
}
console.log(msgs.length ? 'messages:\n' + [...new Set(msgs)].slice(0, 20).join('\n') : 'console: clean');
