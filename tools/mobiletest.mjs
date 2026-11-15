// Phone and tablet test: headless Chrome with device emulation drives the game with real touch
// events (CDP Input.dispatchTouchEvent, several fingers at once) and checks the controls, the
// screens and the layout at three landscape sizes and in portrait.
//   node tools/mobiletest.mjs [--quick]     -> tools/_preview/mobile/*.jpg and sheet.jpg, exit 1 on any FAIL
// Fullscreen and the orientation lock cannot happen headless: requestFullscreen and
// screen.orientation.lock are replaced by counters, so the test checks that a tap asks for them.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const quick = process.argv.includes('--quick');
const out = 'tools/_preview/mobile'; fs.mkdirSync(out, { recursive: true });
// runs on the phone tier a first start picks (mobile); VM_Q=q=medium for mobileHigh, VM_Q=q=high for low
const URL = (process.env.VM_URL || 'http://127.0.0.1:5183/') + '?mobile=1' + (process.env.VM_Q ? '&' + process.env.VM_Q : '');
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const SIZES = [
  { name: '844', width: 844, height: 390, deviceScaleFactor: 3 },
  { name: '915', width: 915, height: 412, deviceScaleFactor: 2.625 },
  { name: '1180', width: 1180, height: 720, deviceScaleFactor: 2 },   // tablet (kept within 1280x720 for the shared GPU)
];
const PORTRAIT = { name: 'portrait', width: 390, height: 844, deviceScaleFactor: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const shots = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };

const { acquireGpuLock } = await import('./lib/gpulock.mjs');
const release = await acquireGpuLock();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000,
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile-mobile'),
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars', '--mute-audio', '--window-size=1180,720'],
});
let page, cdp, vp;
const emulate = async (s, landscape = true) => {
  vp = s;
  await page.emulate({ userAgent: UA, viewport: { width: s.width, height: s.height, deviceScaleFactor: s.deviceScaleFactor, isMobile: true, hasTouch: true, isLandscape: landscape } });
  await sleep(500);
};
const shot = async (name) => { const f = path.join(out, `${vp.name}_${name}.jpg`); await page.screenshot({ path: f, type: 'jpeg', quality: 72 }); shots.push(f); };

// ---- fingers
const active = new Map();
const pts = () => [...active.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 6, radiusY: 6, force: 1 }));
const down = async (id, x, y) => { active.set(id, { x, y }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts() }); };
const moveTo = async (id, x, y, steps = 8, ms = 120) => {
  const p = active.get(id), x0 = p.x, y0 = p.y;
  for (let i = 1; i <= steps; i++) { p.x = x0 + ((x - x0) * i) / steps; p.y = y0 + ((y - y0) * i) / steps; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts() }); await sleep(ms / steps); }
};
// CDP: a touchEnd ends every finger; lifting one of several is a touchMove without it
const up = async (id) => { active.delete(id); await cdp.send('Input.dispatchTouchEvent', active.size ? { type: 'touchMove', touchPoints: pts() } : { type: 'touchEnd', touchPoints: [] }); };
const cancelAll = async () => { active.clear(); await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); };
const center = (sel) => page.evaluate((sel) => { const e = [...document.querySelectorAll(sel)].find((x) => x.checkVisibility()); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
const tap = async (sel, hold = 70) => { const c = await center(sel); if (!c) { console.log('  (no element', sel, ')'); return false; } await down(9, c.x, c.y); await sleep(hold); await up(9); await sleep(120); return true; };
const vm = (fn, ...a) => page.evaluate(fn, ...a);
const waitFor = (fn, ms = 8000) => page.waitForFunction(fn, { timeout: ms, polling: 100 }).then(() => true, () => false);

// ---- layout: nothing visible outside the viewport, every control at least 44 px, the page never scrolls
const layout = async (label) => {
  const r = await vm(() => {
    const W = innerWidth, H = innerHeight, over = [], small = [];
    const vis = (e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const clipped = (e) => { for (let a = e.parentElement; a && a.id !== 'ui'; a = a.parentElement) { const o = getComputedStyle(a).overflowY; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
    const name = (e) => (e.parentElement && typeof e.parentElement.className === 'string' ? e.parentElement.className.split(' ')[0] + '>' : '') + e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') + (e.dataset.act ? `[${e.dataset.act}]` : e.dataset.tc ? `[${e.dataset.tc}]` : '');
    for (const e of document.querySelectorAll('#ui *')) {
      if (e.closest('.marker, .arcs, .hurt, .loading, svg') || !vis(e)) continue;
      const b = e.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (!clipped(e) && (b.left < -1 || b.top < -1 || b.right > W + 1 || b.bottom > H + 1)) over.push(`${name(e)} ${b.left | 0},${b.top | 0},${b.right | 0},${b.bottom | 0}`);
    }
    for (const e of document.querySelectorAll('#ui button, #ui [data-act], #ui [data-tc], #ui .rows .row')) {
      if (!vis(e) || (e.matches('.prompt') && !e.classList.contains('tap'))) continue;
      const b = e.getBoundingClientRect();
      if (b.width && b.height && Math.min(b.width, b.height) < 43.5) small.push(`${name(e)} ${b.width.toFixed(0)}x${b.height.toFixed(0)}`);
    }
    const se = document.scrollingElement;
    return { over, small, scroll: se.scrollHeight > H + 1 || se.scrollWidth > W + 1 || scrollY !== 0 };
  });
  check(`${vp.name} ${label}: nothing outside the viewport`, !r.over.length && !r.scroll, r.over.slice(0, 3).join('; ') + (r.scroll ? ' page scrolls' : ''));
  check(`${vp.name} ${label}: controls at least 44 px`, !r.small.length, r.small.slice(0, 4).join('; '));
};
const shown = (sel) => vm((sel) => !!document.querySelector(sel)?.classList.contains('show'), sel);

try {
  page = await browser.newPage();
  cdp = await page.createCDPSession();
  await page.evaluateOnNewDocument(() => {
    const W = window.WebSocket; window.WebSocket = function (u, p) { if (String(p).includes('vite')) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 0 }; return new W(u, p); };
    window.__fs = 0; window.__orient = 0;
    Element.prototype.requestFullscreen = function () { window.__fs++; return Promise.resolve(); };
    try { if (screen.orientation) screen.orientation.lock = () => { window.__orient++; return Promise.resolve(); }; } catch (e) { /* */ }
    try { localStorage.removeItem('valle-morta-settings'); } catch (e) { /* */ }
  });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e.message || e).slice(0, 300)}`));
  await emulate(SIZES[0]);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready && document.querySelector(".menu.show")', { timeout: 300000, polling: 300 });
  await sleep(1500);
  check('touch mode and phone layout are on', await vm(() => document.body.classList.contains('touch') && document.body.classList.contains('mobile')));
  const tier = await vm(() => __vm.engine.qualityName);
  if (!process.env.VM_Q) check('a first start on a phone runs the mobile tier, no benchmark', tier === 'mobile', tier);
  await shot('menu'); await layout('menu');

  // ---- menus by touch
  await tap('.menu [data-act="settings"]'); await sleep(450);
  check('Settings opens by tap', await shown('.panel .rows') || await vm(() => !!document.querySelector('.panel.show .rows')));
  check('Settings shows the touch rows', await vm(() => !!document.querySelector('.panel.show [data-key="touchSens"]')?.checkVisibility() && !document.querySelector('.panel.show [data-key="sensitivity"]')?.checkVisibility()));
  const qlabels = await vm(() => [...document.querySelectorAll('.panel.show [data-key="quality"] button')].map((b) => b.textContent));
  check('quality buttons name the phone tiers', qlabels[0]?.startsWith('Phone') && qlabels[1]?.startsWith('Phone high'), qlabels.join(' / '));
  const qon = await vm(() => document.querySelector('.panel.show [data-key="quality"] button.on')?.textContent);
  if (!process.env.VM_Q) check('Settings marks the running tier', qon === 'Phone', qon);
  await shot('settings'); await layout('settings');
  check('first tap asks for fullscreen', await vm(() => window.__fs > 0), `${await vm(() => window.__fs)} requests`);
  await tap('.panel.show [data-act="back"]'); await sleep(400);
  await tap('.menu [data-act="howto"]'); await sleep(450);
  check('How to play has the touch section', await vm(() => !!document.querySelector('.panel.show .touchkeys')?.checkVisibility()));
  if (!quick) { await shot('howto'); await layout('how to play'); }
  await tap('.panel.show [data-act="back"]'); await sleep(400);

  // ---- Survival
  await tap('.menu [data-act="play"]');
  check('Survival starts from the menu', await waitFor(() => __vm.game.state === 'playing' && __vm.game.player.enabled, 15000));
  check('landscape lock requested', await vm(() => window.__orient > 0));
  await vm(() => { const g = __vm.game; g.player.damage = () => {}; g.interT = 1e9; g.zombies.clear(); });
  await sleep(1800);
  const mm = await vm(() => { const c = __vm.ui.minimap.map; if (!c) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4 * 101) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / (4 * 101)) / 3; });
  check('minimap picture is baked, not black', mm > 20, `mean ${mm.toFixed(0)}`);
  await shot('hud'); await layout('HUD');
  const W = vp.width, H = vp.height;

  // move with the stick (pushed to the edge: sprint)
  let p0 = await vm(() => ({ x: __vm.game.player.pos.x, z: __vm.game.player.pos.z }));
  await down(1, W * 0.2, H * 0.68); await moveTo(1, W * 0.2, H * 0.68 - 90, 6, 100);
  await sleep(700);
  const sprint = await vm(() => __vm.game.player.sprinting);
  await shot('stick');
  await sleep(500);
  let p1 = await vm(() => ({ x: __vm.game.player.pos.x, z: __vm.game.player.pos.z }));
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  check('stick moves the player', moved > 1.5, `${moved.toFixed(2)} m`);
  check('stick at its edge sprints', sprint);
  // look while still moving: two fingers at once
  let y0 = await vm(() => __vm.game.player.yaw);
  await down(2, W * 0.7, H * 0.4); await moveTo(2, W * 0.7 + 140, H * 0.4 + 20, 10, 200); await up(2);
  await sleep(100);
  let y1 = await vm(() => __vm.game.player.yaw);
  const stillMoving = await vm(() => __vm.game.player.input.fwd > 0.5);
  check('drag on the right turns the view', Math.abs(y1 - y0) > 0.2, `${(y1 - y0).toFixed(3)} rad`);
  check('move and look at the same time', stillMoving);
  await up(1); await sleep(200);
  check('lifting the stick stops the input', await vm(() => __vm.game.player.input.fwd === 0 && !__vm.game.ui.touch.stick.classList.contains('on')));

  // fire: rounds leave the magazine; dragging the held fire button keeps turning
  const a0 = await vm(() => __vm.game.weapon.ammo);
  const fc = await center('[data-tc="fire"]');
  y0 = await vm(() => __vm.game.player.yaw);
  await down(3, fc.x, fc.y); await sleep(700);
  await moveTo(3, fc.x - 90, fc.y - 10, 8, 200);
  const a1 = await vm(() => __vm.game.weapon.ammo);
  y1 = await vm(() => __vm.game.player.yaw);
  await shot('fire');
  await up(3); await sleep(150);
  check('holding fire empties rounds', a1 < a0, `${a0} -> ${a1}`);
  check('dragging the fire button turns the view', Math.abs(y1 - y0) > 0.1, `${(y1 - y0).toFixed(3)} rad`);
  check('fire stops when the finger lifts', await vm(() => !__vm.game.player.input.fire));

  // reload
  await tap('[data-tc="reload"]');
  const rel = await waitFor(() => __vm.game.weapon.reloading || __vm.game.weapon.ammo === __vm.game.weapon.magSize, 1500);
  check('reload button reloads', rel);
  await waitFor(() => !__vm.game.weapon.reloading, 5000);

  // weapon switch by tapping the ammunition read-out
  const w0 = await vm(() => __vm.game.weapon.id);
  await tap('.arsenal');
  const sw = await page.waitForFunction((w0) => __vm.game.weapon.id !== w0, { timeout: 2500, polling: 100 }, w0).then(() => true, () => false);
  const w1 = await vm(() => __vm.game.weapon.id);
  check('tapping the weapon switches weapon', w1 !== w0 || sw === true, `${w0} -> ${w1}`);

  // a finger staying on fire across a weapon switch, then sliding off
  await down(4, fc.x, fc.y); await sleep(200); await tap('.arsenal'); await sleep(600);
  const fireHeld = await vm(() => __vm.game.player.input.fire);
  await moveTo(4, W * 0.5, H * 0.3, 6, 100); await up(4); await sleep(100);
  check('fire held across a weapon switch, released after sliding off', fireHeld && await vm(() => !__vm.game.player.input.fire));
  // a system-cancelled touch never leaves a control stuck
  const jc = await center('[data-tc="jump"]');
  await down(5, W * 0.2, H * 0.7); await moveTo(5, W * 0.2 + 50, H * 0.7, 3, 60); await down(6, jc.x, jc.y); await sleep(80); await cancelAll(); await sleep(100);
  check('touchcancel releases every control', await vm(() => { const t = __vm.game.ui.touch.st; return t.fwd === 0 && t.strafe === 0 && !t.jump && __vm.game.ui.touch.fingers.size === 0; }));

  // crouch: tap toggles, hold lies down, tap gets up
  await tap('[data-tc="crouch"]'); await sleep(700);
  const cr = await vm(() => __vm.game.player.stance);
  await tap('[data-tc="crouch"]'); await sleep(700);
  const st2 = await vm(() => __vm.game.player.stance);
  check('crouch taps on and off', cr === 'crouch' && st2 === 'stand', `${cr}, ${st2}`);
  await tap('[data-tc="crouch"]', 600); await sleep(1600);
  const pr = await vm(() => __vm.game.player.stance);
  if (!quick) await shot('prone');
  await tap('[data-tc="crouch"]'); await sleep(1800);
  const st3 = await vm(() => __vm.game.player.stance);
  check('holding crouch lies down, a tap gets up', pr === 'prone' && st3 !== 'prone', `${pr}, ${st3}`);

  // aim toggles
  await tap('[data-tc="ads"]'); await sleep(500);
  const ads = await vm(() => __vm.game.player.adsT > 0.5);
  if (!quick) await shot('aim');
  await tap('[data-tc="ads"]'); await sleep(400);
  check('aim button toggles aiming', ads && await vm(() => __vm.game.player.adsT < 0.5));

  // roll
  const r0 = await vm(() => __vm.game.player.rolls);
  await tap('[data-tc="roll"]'); await sleep(300);
  check('roll button rolls', (await vm(() => __vm.game.player.rolls)) > r0);
  await sleep(1300);

  // jump
  await tap('[data-tc="jump"]', 120); await sleep(150);
  check('jump button jumps', await vm(() => !__vm.game.player.onGround || __vm.game.player.vel.y > 0.5));
  await sleep(800);

  // bandage
  await vm(() => { const p = __vm.game.player; p.health = 50; p.bandages = 1; });
  await tap('[data-tc="bandage"]'); await sleep(200);
  check('bandage button bandages', await vm(() => __vm.game.player.bandageT > 0 || __vm.game.player.bandages === 0));
  await sleep(1800);

  // supply crate prompt is one tappable button
  const crate = await vm(() => {
    const g = __vm.game, p = g.player;
    if (!g.supply || !g.supply.place) return 'no api';
    try { const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw); g.supply.place(p.pos.x + fx * 1.3, p.pos.z + fz * 1.3, 0, { rifle: 30, sniper: 5, bandages: 1 }); p.pitch = -0.5; return 'ok'; } catch (e) { return String(e.message); }
  });
  if (crate === 'ok') {
    const shownP = await waitFor(() => document.querySelector('.prompt.tap.on'), 2500);
    if (shownP) { await shot('prompt'); await tap('.prompt.tap'); await sleep(300); }
    check('crate prompt is a button that opens it', shownP && await vm(() => __vm.game.supply.crates.some((c) => c.opened)));
  } else console.log(`  (crate prompt not exercised: ${crate})`);

  // pause and resume
  await tap('[data-tc="pause"]'); await sleep(450);
  check('pause button pauses', await vm(() => __vm.game.state === 'paused') && await shown('.pause'));
  await shot('pause'); await layout('pause');
  await tap('.pause [data-act="settings"]'); await sleep(400);
  check('Settings opens from pause', await vm(() => !!document.querySelector('.panel.show .rows')));
  await tap('.panel.show [data-act="back"]'); await sleep(400);
  const fs0 = await vm(() => window.__fs);
  await tap('.pause [data-act="resume"]'); await sleep(400);
  check('resume continues and asks for fullscreen again', await vm(() => __vm.game.state === 'playing') && (await vm(() => window.__fs)) > fs0);

  // aim assist: an infected straight ahead slows the view
  const assist = await vm(() => {
    const g = __vm.game, p = g.player, t = g.ui.touch, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const z = g.zombies.spawn(p.pos.x + fx * 12, p.pos.z + fz * 12, { type: 'walker', aware: false });
    if (!z) return 'no spawn';
    p.pitch = 0; for (let i = 0; i < 3; i++) __vm.step(0.016);
    t.fingers.set(99, { kind: 'look' }); const a = t._assist(g); t.fingers.delete(99);
    g.zombies.clear();
    return a;
  });
  check('aim assist slows the view over an infected', typeof assist === 'number' && assist < 0.9, String(assist));

  // death screen
  await vm(() => { const p = __vm.game.player; delete p.damage; p.damage(999); });
  check('death screen appears', await waitFor(() => document.querySelector('.over.show'), 30000));
  await sleep(900); await shot('over'); await layout('death screen');
  await tap('.over [data-act="quit"]');
  await waitFor(() => document.querySelector('.menu.show'), 15000); await sleep(500);

  // ---- Operation: Base, and a run with tappable ability rings
  await vm(() => { __vm.progress.reset(); __vm.progress.grant(6000); });
  await tap('.menu [data-act="operation"]'); await sleep(900);
  check('Operation opens the Base shop', await shown('.base'));
  for (const s of ['rifle.damage', 'rifle.mag']) await tap(`.base [data-buy="${s}"]`);
  await sleep(400); await shot('base'); await layout('Base');
  await tap('.base [data-tab="abilities"]'); await sleep(300);
  await tap('.base [data-buy="ability.adrenaline"]'); await sleep(300);
  if (!quick) { await shot('base_abilities'); await layout('Base abilities'); }
  await tap('.base [data-act="deploy"]');
  const deployed = await waitFor(() => __vm.game.state === 'playing' && !__vm.game.operation.cinematic, 150000);
  check('Operation run starts after the insertion', deployed);
  if (deployed) {
    await vm(() => { const g = __vm.game; g.player.damage = () => {}; g.zombies.clear(); });
    await sleep(1200);
    await shot('op'); await layout('Operation HUD');
    const u0 = await vm(() => __vm.game.operation.abilities.map((a) => a.uses).join());
    await tap('.ab[data-tc="ab"]'); await sleep(300);
    const u1 = await vm(() => __vm.game.operation.abilities.map((a) => a.uses).join());
    check('ability ring is tappable', u0 !== u1, `${u0} -> ${u1}`);
    await tap('[data-tc="pause"]'); await sleep(400);
    await tap('.pause [data-act="quit"]'); await sleep(800);
    check('leaving the run returns to Base', await shown('.base') || await shown('.debrief'));
    if (await shown('.debrief')) { await shot('debrief'); await layout('debrief'); await tap('.debrief [data-act="base"]'); await sleep(600); }
  }
  await tap('.base [data-act="quit"]'); await waitFor(() => document.querySelector('.menu.show'), 15000); await sleep(400);

  // ---- the other sizes: menu, HUD, pause, Base
  for (const s of SIZES.slice(1)) {
    await emulate(s); await sleep(600);
    await shot('menu'); await layout('menu');
    await tap('.menu [data-act="play"]');
    await waitFor(() => __vm.game.state === 'playing', 15000);
    await vm(() => { const g = __vm.game; g.player.damage = () => {}; g.interT = 1e9; g.zombies.clear(); });
    await sleep(1500);
    const c = await center('[data-tc="fire"]'); const sz = await vm(() => document.querySelector('[data-tc="fire"]').getBoundingClientRect().width);
    check(`${s.name} fire button inside the right thumb area`, c && c.x > s.width * 0.75 && c.y > s.height * 0.55, `${c && c.x.toFixed(0)},${c && c.y.toFixed(0)} size ${sz.toFixed(0)}`);
    await shot('hud'); await layout('HUD');
    await tap('[data-tc="pause"]'); await sleep(400);
    if (!quick) { await shot('pause'); await layout('pause'); }
    await tap('.pause [data-act="quit"]'); await waitFor(() => document.querySelector('.menu.show'), 15000); await sleep(300);
    await tap('.menu [data-act="operation"]'); await sleep(700);
    await shot('base'); await layout('Base');
    await tap('.base [data-act="quit"]'); await waitFor(() => document.querySelector('.menu.show'), 15000); await sleep(300);
  }

  // ---- portrait: the rotate screen, and a run waits behind it
  await emulate(SIZES[0]);
  await tap('.menu [data-act="play"]'); await waitFor(() => __vm.game.state === 'playing', 15000); await sleep(600);
  await emulate(PORTRAIT, false); await sleep(700);
  check('portrait shows the rotate screen', await vm(() => !!document.querySelector('.rotate')?.checkVisibility()));
  check('turning upright pauses the run', await vm(() => __vm.game.state === 'paused'));
  await shot('rotate');
  await vm(() => __vm.stop());

  // ---- desktop is untouched: ?mobile=0, mouse and keyboard, no touch controls
  await page.emulate({ userAgent: (await browser.userAgent()).replace('Headless', ''), viewport: { width: 1180, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false } });
  vp = { name: 'desktop' };
  await page.goto(URL.replace('mobile=1', 'mobile=0') + '&q=low', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready && document.querySelector(".menu.show")', { timeout: 300000, polling: 300 });
  await sleep(800);
  await page.evaluate(() => { Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.getElementById('view') }); });
  await page.click('.menu [data-act="play"]');
  await waitFor(() => __vm.game.state === 'playing', 15000); await sleep(1200);
  await page.keyboard.down('KeyW'); await sleep(600);
  const dk = await vm(() => ({ touch: document.body.classList.contains('touch'), tc: !!document.querySelector('.tc')?.checkVisibility(), fwd: __vm.game.player.input.fwd, ptouch: __vm.game.player.touch }));
  await page.keyboard.up('KeyW');
  check('desktop: no touch controls, keyboard still moves', !dk.touch && !dk.tc && dk.fwd === 1 && !dk.ptouch, JSON.stringify(dk));
  await shot('hud');
  await vm(() => __vm.stop());
} catch (e) { check('test ran to the end', false, String(e.message).slice(0, 200)); }
check('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
await browser.close(); release();

if (shots.length) {
  try { execFileSync('node', ['tools/sheet.mjs', path.join(out, 'sheet.jpg'), '440', '4', ...shots], { stdio: 'inherit' }); } catch (e) { console.log('sheet failed', e.message); }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
