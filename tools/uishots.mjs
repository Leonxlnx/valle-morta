// Interface capture: menu, settings, how to play, Base and the HUD in both modes (boss,
// damage arcs, scoped, low health, extraction), pause and the summaries, at one viewport.
// Also times the minimap draw and A/B-benches a frame with and without it.
//   node tools/uishots.mjs --w 1280 --h 720 [--out tools/_preview/ui] [--quick]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const W = Number(arg('w', 1280)), H = Number(arg('h', 720));
const out = arg('out', 'tools/_preview/ui'); fs.mkdirSync(out, { recursive: true });
const quick = !!arg('quick', false);
const { acquireGpuLock } = await import('./lib/gpulock.mjs');
const release = await acquireGpuLock();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000,
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile-uishots'), defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio'],
});
const tag = `${W}`;
const shot = async (page, name) => { const f = path.join(out, `${tag}_${name}.jpg`); await page.screenshot({ path: f, type: 'jpeg', quality: 90 }); console.log(f); };
// freeze the world, render a few frames without simulating, grab, stay frozen
const frozen = async (page, name) => {
  await page.evaluate(async () => { const vm = __vm; window.__st = vm.game.state; vm.game.state = 'paused'; vm.start(); for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r)); vm.stop(); vm.game.state = window.__st; });
  await shot(page, name);
};
const steps = (page, n = 3) => page.evaluate((n) => { for (let i = 0; i < n; i++) __vm.step(0.016); }, n);

try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e.stack || e).slice(0, 500)}`));
  await page.goto('http://127.0.0.1:5173/?q=high', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.evaluate(() => { try { localStorage.removeItem('valle-morta-settings'); } catch (e) { /* */ } });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 240000, polling: 250 });
  await sleep(2500);
  console.log('bake ms', await page.evaluate(() => +__vm.ui.minimap.ms.toFixed(1)));
  await page.evaluate(() => { __vm.progress.reset(); });
  await shot(page, 'menu');
  await page.click('.menu [data-act="settings"]'); await sleep(500); await shot(page, 'settings');
  await page.click('.panel.show [data-act="back"]'); await sleep(400);
  if (!quick) { await page.click('.menu [data-act="howto"]'); await sleep(500); await shot(page, 'howto'); await page.click('.panel.show [data-act="back"]'); await sleep(400); }
  await page.evaluate(() => { Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.getElementById('view') }); });

  // ---- Survival
  await page.click('.menu [data-act="play"]'); await sleep(4300);
  await page.evaluate(() => {
    const vm = __vm, g = vm.game, p = g.player, Z = g.zombies; vm.stop();
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw); Z.maxActive = 99;
    for (let i = 0; i < 7; i++) { const a = i * 0.9, d = 14 + i * 6; Z.spawn(p.pos.x + Math.cos(a) * d, p.pos.z + Math.sin(a) * d, { type: 'walker', aware: false }); }
    for (let i = 0; i < 6; i++) { const a = 2.2 + i * 0.08, d = 95 + i * 9; Z.spawn(p.pos.x + Math.cos(a) * d, p.pos.z + Math.sin(a) * d, { type: 'walker', aware: false }); }
    window.__fx = [fx, fz];
  });
  await steps(page, 2); await frozen(page, 'surv');
  // boss, damage from two sides, low health
  await page.evaluate(() => {
    const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, [fx, fz] = window.__fx;
    Z.spawn(p.pos.x + fx * 38 + fz * 10, p.pos.z + fz * 38 - fx * 10, { type: 'boss', aware: false });
    vm.step(0.016);
    p.damage(8, new vm.THREE.Vector3(fz, 0, -fx)); p.damage(6, new vm.THREE.Vector3(-fx, 0, -fz));
    p.health = 21; p.regenCap = 25;
  });
  await steps(page, 3); await frozen(page, 'surv_boss_low');
  // scoped
  await page.evaluate(() => { const g = __vm.game; g.player.health = 80; g.player.regenCap = 100; g.weapon.switchTo('sniper'); __vm.start(); });
  await sleep(900); await page.mouse.move(W / 2, H / 2); await page.mouse.down({ button: 'right' }); await sleep(1400);
  await page.evaluate(() => __vm.stop());
  await shot(page, 'scoped');
  await page.mouse.up({ button: 'right' });
  // the frame-time A/B with the HUD on: the same frames with and without the minimap draw
  const perf = await page.evaluate(() => {
    const vm = __vm, mm = vm.ui.minimap, g = vm.game, draw = mm.draw.bind(mm);
    let t0 = performance.now(); for (let i = 0; i < 300; i++) draw(g); const drawMs = (performance.now() - t0) / 300;
    const bench = () => vm.bench(40);
    bench(); let on = 0, off = 0; for (let k = 0; k < 4; k++) { mm.draw = () => {}; off += bench(); mm.draw = draw; on += bench(); } const on1 = on / 4, on2 = on1, off1 = off / 4, off2 = off1;
    t0 = performance.now(); for (let i = 0; i < 300; i++) vm.ui.update(g, 0.016); const uiMs = (performance.now() - t0) / 300;
    return { drawMs: +drawMs.toFixed(3), uiUpdateMs: +uiMs.toFixed(3), frameOn: +((on1 + on2) / 2).toFixed(2), frameOff: +((off1 + off2) / 2).toFixed(2) };
  });
  console.log('perf', JSON.stringify(perf));
  await page.evaluate(() => __vm.start());
  await page.keyboard.press('KeyP'); await sleep(600); await shot(page, 'pause');
  await page.click('.pause [data-act="resume"]'); await sleep(300);
  // wait for the screens rather than for fixed times: on a loaded machine the summary comes late
  await page.evaluate(() => { __vm.game.player.damage(999); });
  await page.waitForFunction(() => document.querySelector('.over').classList.contains('show'), { timeout: 60000, polling: 200 }); await sleep(1200); await shot(page, 'over');
  await page.click('.over [data-act="quit"]');
  await page.waitForFunction(() => document.querySelector('.menu').classList.contains('show'), { timeout: 60000, polling: 200 }); await sleep(900);

  // ---- Operation: Base, then a run
  // a fresh profile, so the shots do not depend on what earlier runs bought (a maxed item has no buy button)
  await page.evaluate(() => { __vm.progress.reset(); __vm.progress.grant(5000); });
  await page.click('.menu [data-act="operation"]'); await sleep(900);
  for (const s of ['[data-buy="rifle.damage"]', '[data-buy="rifle.damage"]', '[data-buy="rifle.mag"]']) { const b = await page.$(`.base ${s}`); if (b) { await b.click(); await sleep(120); } else console.log('missing', s); }
  await sleep(900); await shot(page, 'base');
  await page.click('.base [data-tab="abilities"]'); await sleep(150);
  for (const s of ['ability.adrenaline', 'ability.jump', 'ability.tank', 'ability.mortar']) { const b = await page.$(`.base [data-buy="${s}"]`); if (b) { await b.click(); await sleep(150); } }
  await sleep(900); if (!quick) await shot(page, 'base_abilities');
  await page.click('.base [data-act="deploy"]');
  await page.waitForFunction(() => { const g = __vm.game; return g.state === 'playing' && !(g.operation && g.operation.cinematic); }, { timeout: 240000, polling: 300 }).catch(() => console.log('insertion did not finish'));
  await sleep(2500);
  await page.evaluate(() => {
    const vm = __vm, g = vm.game, p = g.player, Z = g.zombies, op = g.operation; vm.stop();
    for (let i = 0; i < 6; i++) { const a = i * 1.1, d = 12 + i * 8; Z.spawn(p.pos.x + Math.cos(a) * d, p.pos.z + Math.sin(a) * d, { type: i % 2 ? 'runner' : 'walker', aware: false }); }
    op.salvage = 1240; op.gain = 35; op.gainSeq = (op.gainSeq || 0) + 1;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), ex = new vm.THREE.Vector3(p.pos.x - fz * 70 + fx * 30, p.pos.y, p.pos.z + fx * 70 + fz * 30);
    op.extraction = { state: 'waiting', pos: ex, dist: 76, timeLeft: 24, window: 30, lz: op.lz };
    if (op.abilities[1]) op.abilities[1].cd = op.abilities[1].cooldown * 0.55;
    if (op.abilities[0]) { op.abilities[0].active = (op.abilities[0].duration || 1) * 0.6; }
    for (let i = 0; i < 2; i++) g.ui.update(g, 0.016);
  });
  await frozen(page, 'op');
  console.log('op', JSON.stringify(await page.evaluate(() => ({ abil: document.querySelectorAll('.ab').length, extract: document.querySelector('.extract').textContent, salv: document.querySelector('.salvage').textContent }))));
  await page.evaluate(() => { const op = __vm.game.operation; op.extraction = null; __vm.start(); __vm.game.player.damage(999); });
  await sleep(4500); await shot(page, 'debrief');
  await page.close();
} catch (e) { console.log('FAILED', e.message); }
console.log('errors', errors.length ? errors.slice(0, 8).join('\n') : 'none');
await browser.close(); release();
