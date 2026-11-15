// Phone start-up and first-minute run in an emulated phone (844x390, Android UA, touch).
//   node tools/phonestart.mjs [--minute] [--profile]
//     THROTTLE=4 (default) CPU slowdown during loading and the start of a run
//     --profile  prints the functions with the most self time during loading
//     --minute   then plays 60 s of Survival with real touch input (unthrottled), a screenshot
//                every 10 s (tools/_preview/mobile/minute_*.jpg), frame times and the render scale
// Times: page open -> menu, the longest main-thread task while loading, Start -> playing.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const minute = process.argv.includes('--minute'), profile = process.argv.includes('--profile');
const RATE = Number(process.env.THROTTLE || 4);
const out = 'tools/_preview/mobile'; fs.mkdirSync(out, { recursive: true });
const URL = (process.env.VM_URL || 'http://127.0.0.1:5183/') + '?mobile=1' + (process.env.VM_Q ? '&' + process.env.VM_Q : '');
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const W = 844, H = 390;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const { acquireGpuLock } = await import('./lib/gpulock.mjs');
const release = await acquireGpuLock();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000,
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile-phonestart'),
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars', '--autoplay-policy=user-gesture-required', `--window-size=${W},${H}`],
});
let code = 0;
try {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await page.emulate({ userAgent: UA, viewport: { width: W, height: H, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: true } });
  await page.evaluateOnNewDocument(() => {
    window.__long = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch (e) { /* */ }
    Element.prototype.requestFullscreen = function () { return Promise.resolve(); };
    try { if (screen.orientation) screen.orientation.lock = () => Promise.resolve(); } catch (e) { /* */ }
    try { localStorage.removeItem('valle-morta-settings'); } catch (e) { /* */ }
  });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); else if (/auto quality|\[assets\]/.test(m.text())) console.log('  page:', m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e.message || e).slice(0, 300)}`));
  const vm = (fn, ...a) => page.evaluate(fn, ...a);
  const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  const tapAt = async (x, y) => { await touch('touchStart', [{ x, y, id: 30 }]); await sleep(70); await touch('touchEnd', []); await sleep(100); };
  const center = (sel) => vm((sel) => { const e = [...document.querySelectorAll(sel)].find((x) => x.checkVisibility()); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
  if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 2000 }); await cdp.send('Profiler.start'); }
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction('window.__vm && window.__vm.ready && document.querySelector(".menu.show")', { timeout: 900000, polling: 500 });
  const tMenu = (Date.now() - t0) / 1000;
  if (profile) {
    const { profile: p } = await cdp.send('Profiler.stop');
    const self = new Map(), dt = p.timeDeltas, byId = new Map(p.nodes.map((n) => [n.id, n]));
    p.samples.forEach((id, i) => { const n = byId.get(id), f = n.callFrame; const k = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000); });
    console.log('top self time while loading (ms, throttled):');
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 28)) console.log(`  ${v.toFixed(0).padStart(6)}  ${k}`);
  }
  const load = await vm(() => ({ long: window.__long.slice(), q: __vm.engine.qualityName, st: window.__loadStages || [] }));
  const stageAt = (t) => { let n = 'page'; for (const [l, s] of load.st) if (s <= t) n = l; return n; };
  console.log('stages: ' + load.st.map(([l, s], i) => `${l} ${(((load.st[i + 1]?.[1] ?? s) - s) / 1000).toFixed(1)} s`).join(', '));
  console.log('tasks over 1 s: ' + load.long.filter((x) => x[1] > 1000).map((x) => `${x[1]} ms in ${stageAt(x[0])}`).join(', '));
  const lmax = Math.max(0, ...load.long.map((x) => x[1]));
  console.log(`menu after ${tMenu.toFixed(1)} s at ${RATE}x, preset ${load.q}, longest task ${lmax} ms, tasks over 1 s: ${load.long.filter((x) => x[1] > 1000).map((x) => x[1]).join(' ') || 'none'}`);

  await sleep(1500);
  const mm = await vm(() => { const c = __vm.ui.minimap.map; if (!c) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4 * 101) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / (4 * 101)) / 3; });
  console.log(`minimap mean brightness ${mm.toFixed(0)} (black is under 20), float targets ${await vm(() => __vm.engine.caps.floatRender)}`);
  // Start (a real tap), throttled
  const n0 = await vm(() => window.__long.length);
  const pc = await center('.menu [data-act="play"]');
  const t1 = Date.now();
  await tapAt(pc.x, pc.y);
  await page.waitForFunction(() => __vm.game.state === 'playing', { timeout: 300000, polling: 100 });
  const tPlay = (Date.now() - t1) / 1000;
  await sleep(3000);
  const st = await vm((n0) => ({ long: window.__long.slice(n0), audio: __vm.game.audio.ctx && __vm.game.audio.ctx.state }), n0);
  console.log(`Start -> playing ${tPlay.toFixed(1)} s, then 3 s: longest task ${Math.max(0, ...st.long.map((x) => x[1]))} ms (${st.long.filter((x) => x[1] > 1000).length} over 1 s), audio ${st.audio}`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  if (minute) {
    // frame recorder; the infected come in the normal waves
    await vm(() => {
      const g = __vm.game; g.player.damage = () => {};
      window.__ft = []; window.__sc = []; let last = performance.now();
      const f = (t) => { window.__ft.push(t - last); last = t; if (window.__ftOn) requestAnimationFrame(f); };
      window.__ftOn = true; requestAnimationFrame(f);
      window.__scT = setInterval(() => window.__sc.push(+(__vm.engine.dynScale ?? __vm.engine.renderScale).toFixed(2)), 1000);
    });
    const fire = await center('[data-tc="fire"]'), rel = await center('[data-tc="reload"]'), arse = await center('.arsenal');
    const sx = W * 0.2, sy = H * 0.68;
    const shots0 = await vm(() => ({ ...__vm.game.stats }));
    const tStart = Date.now();
    let k = 0, nextShot = 0;
    while (Date.now() - tStart < 60000) {
      const el = (Date.now() - tStart) / 1000;
      if (el >= nextShot) { await page.screenshot({ path: path.join(out, `minute_${String(nextShot).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 70 }); nextShot += 10; }
      // the player's aim: turn toward the nearest standing infected (what a thumb on the look side does)
      const aim = await vm(() => {
        const g = __vm.game, p = g.player.pos; let best = null, bd = 1e9;
        for (const z of g.zombies.list) { if (!z.alive) continue; const q = z.pos || z.root?.position || z.mesh?.position; if (!q) continue; const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < bd) { bd = d; best = q; } }
        if (!best || bd > 45) return null;
        const yaw = Math.atan2(-(best.x - p.x), -(best.z - p.z));
        let d = yaw - g.player.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
        return { d, dist: bd };
      });
      const stick = k % 3 !== 2;
      // move with the stick (left thumb) and look with the right thumb at the same time
      await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
      if (stick) await touch('touchMove', [{ x: sx + (k % 2 ? 30 : -30), y: sy - 60, id: 1 }]);
      const lx = W * 0.68, ly = H * 0.42;
      const dx = aim ? Math.max(-260, Math.min(260, -aim.d / 0.006)) : (k % 2 ? 120 : -120);
      await touch('touchMove', [{ x: sx, y: sy - (stick ? 60 : 0), id: 1 }, { x: lx, y: ly, id: 2 }]);
      for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: sx, y: sy - (stick ? 60 : 0), id: 1 }, { x: lx + (dx * i) / 6, y: ly, id: 2 }]); await sleep(25); }
      await touch('touchMove', [{ x: sx, y: sy - (stick ? 60 : 0), id: 1 }]);
      if (aim) {   // fine aim directly, then hold fire
        await vm(() => { const g = __vm.game, p = g.player.pos; let best = null, bd = 1e9; for (const z of g.zombies.list) { if (!z.alive) continue; const q = z.pos || z.root?.position; if (!q) continue; const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < bd) { bd = d; best = q; } } if (best) { g.player.yaw = Math.atan2(-(best.x - p.x), -(best.z - p.z)); g.player.pitch = Math.atan2((best.y ?? p.y) + 1.2 - (p.y + 1.6), bd); } });
        await touch('touchMove', [{ x: sx, y: sy - (stick ? 60 : 0), id: 1 }, { x: fire.x, y: fire.y, id: 3 }]);
        await sleep(700);
      } else await sleep(600);
      await touch('touchEnd', []);
      if (k % 9 === 4) await tapAt(rel.x, rel.y);
      if (k % 13 === 8) await tapAt(arse.x, arse.y);
      k++;
    }
    await page.screenshot({ path: path.join(out, 'minute_60.jpg'), type: 'jpeg', quality: 70 });
    const r = await vm((s0) => { window.__ftOn = false; clearInterval(window.__scT); const ft = window.__ft.slice(5).sort((a, b) => a - b); const g = __vm.game;
      return { frames: ft.length, med: ft[ft.length >> 1], p95: ft[Math.floor(ft.length * 0.95)], max: ft[ft.length - 1], over1s: ft.filter((x) => x > 1000).length, over100: ft.filter((x) => x > 100).length, sc: window.__sc, wave: g.wave, alive: g.zombies.aliveCount, shots: g.stats.shots - s0.shots, hits: g.stats.hits - s0.hits, kills: g.stats.kills - s0.kills, audio: g.audio.ctx && g.audio.ctx.state, q: __vm.engine.qualityName, out: [__vm.engine.outW, __vm.engine.outH] }; }, shots0);
    console.log(`minute: ${r.frames} frames, median ${r.med.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(0)} ms, >100 ms: ${r.over100}, >1 s: ${r.over1s}; preset ${r.q} ${r.out.join('x')}`);
    console.log(`scale per second: ${r.sc.join(' ')}`);
    console.log(`wave ${r.wave}, alive ${r.alive}, shots ${r.shots}, hits ${r.hits}, kills ${r.kills}, audio ${r.audio}`);
    if (r.over1s || !r.hits) code = 1;
    await vm(() => __vm.stop && __vm.stop());
  }
} catch (e) { console.log('FAIL run:', String(e.message).slice(0, 300)); code = 1; }
console.log(errors.length ? `console errors: ${errors.slice(0, 4).join(' | ')}` : 'console clean');
await browser.close(); release();
process.exit(errors.length ? 1 : code);
