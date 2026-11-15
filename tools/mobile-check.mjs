// Phone checks in headless Chrome with device emulation (no phone here; GPU speed is this laptop's).
//   node tools/mobile-check.mjs --load  [--dev a|b] [--throttle 4] [--q low]
//        full boot to the menu as a first-time phone visitor (mobile UA, touch, DPR), then starts a
//        game: bytes downloaded to the menu and after the start, long main-thread tasks, time to
//        menu, JS heap, and GPU memory counted from every texture / renderbuffer allocation
//   node tools/mobile-check.mjs --shots [--views street,meadow,bridge,fight] [--tiers mobile,mobileHigh,low]
//        screenshots into tools/_preview/mobile/ (low = desktop low without emulation)
//   node tools/mobile-check.mjs --caps [--list nofloat,nofloatlinear,tex2048,nohalf,nowebgl2,lose=8]
//        forces each capability fallback and screenshots what the page shows
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const URL0 = arg('url', 'http://127.0.0.1:5183/');
const OUT = 'tools/_preview/mobile';
fs.mkdirSync(OUT, { recursive: true });
const DEVS = {
  a: { width: 844, height: 390, deviceScaleFactor: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  b: { width: 915, height: 412, deviceScaleFactor: 2.625, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' },
};

// counts GPU allocations per texture / renderbuffer object (bytes of every level)
const GPU_TALLY = () => {
  const BPP = { 0x8058: 4, 0x8C43: 4, 0x881A: 8, 0x8814: 16, 0x822E: 4, 0x822D: 2, 0x822B: 2, 0x8229: 1, 0x81A6: 4, 0x88F0: 4, 0x8CAC: 4, 0x81A5: 2, 0x8051: 4, 0x8C41: 4, 0x881B: 6, 0x8815: 12, 0x8230: 8, 0x822F: 4, 0x1908: 4, 0x1907: 4, 0x1909: 1, 0x190A: 2, 0x1903: 1, 0x1902: 4 };
  const T = window.__gpuTally = { tex: new Map(), rb: new Map(), bytes() { let s = 0; for (const v of this.tex.values()) s += v.total; for (const v of this.rb.values()) s += v; return s; } };
  const P = WebGL2RenderingContext.prototype;
  const state = new WeakMap();
  const st = (gl) => { let s = state.get(gl); if (!s) state.set(gl, s = { unit: 0, bound: {}, rb: null }); return s; };
  const cur = (gl, target) => { const s = st(gl); const t = target >= 0x8515 && target <= 0x851A ? 0x8513 : target; return s.bound[s.unit + ':' + t]; };
  const rec = (tex, key, bytes) => { if (!tex) return; let e = T.tex.get(tex); if (!e) T.tex.set(tex, e = { lv: {}, total: 0 }); e.total += bytes - (e.lv[key] || 0); e.lv[key] = bytes; };
  const wrap = (name, fn) => { const o = P[name]; P[name] = function (...a) { fn.call(this, ...a); return o.apply(this, a); }; };
  wrap('activeTexture', function (u) { st(this).unit = u; });
  wrap('bindTexture', function (t, tex) { st(this).bound[st(this).unit + ':' + t] = tex; });
  wrap('bindRenderbuffer', function (t, rb) { st(this).rb = rb; });
  wrap('deleteTexture', function (tex) { T.tex.delete(tex); });
  wrap('deleteRenderbuffer', function (rb) { T.rb.delete(rb); });
  wrap('texStorage2D', function (t, lv, f, w, h) { let b = 0; for (let i = 0; i < lv; i++) b += Math.max(1, w >> i) * Math.max(1, h >> i) * (BPP[f] || 4); rec(cur(this, t), 's', b * (t === 0x8513 ? 6 : 1)); });
  wrap('texStorage3D', function (t, lv, f, w, h, d) { let b = 0; for (let i = 0; i < lv; i++) b += Math.max(1, w >> i) * Math.max(1, h >> i) * (t === 0x8C1A ? d : Math.max(1, d >> i)) * (BPP[f] || 4); rec(cur(this, t), 's', b); });
  wrap('texImage2D', function (t, l, f, ...r) { const w = typeof r[0] === 'number' ? r[0] : (r[2]?.width || r[2]?.videoWidth || 0), h = typeof r[0] === 'number' ? r[1] : (r[2]?.height || r[2]?.videoHeight || 0); rec(cur(this, t), t + ':' + l, w * h * (BPP[f] || 4)); });
  wrap('texImage3D', function (t, l, f, w, h, d) { rec(cur(this, t), 'l' + l, w * h * d * (BPP[f] || 4)); });
  wrap('generateMipmap', function (t) { const tex = cur(this, t), e = tex && T.tex.get(tex); if (e && !e.lv.s && !e.lv.mip) rec(tex, 'mip', Math.round(e.total / 3)); });
  wrap('renderbufferStorage', function (t, f, w, h) { const rb = st(this).rb; if (rb) T.rb.set(rb, w * h * (BPP[f] || 4)); });
  wrap('renderbufferStorageMultisample', function (t, s, f, w, h) { const rb = st(this).rb; if (rb) T.rb.set(rb, w * h * (BPP[f] || 4) * Math.max(1, s)); });
  // long main-thread tasks
  window.__long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch (e) { /* none */ }
};

async function launch(dev, w = 1280, h = 720) {
  const vw = dev ? dev.width : w, vh = dev ? dev.height : h;
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
    userDataDir: path.join(os.tmpdir(), 'vm-chrome-mobile-' + Date.now()),
    defaultViewport: dev ? { width: dev.width, height: dev.height, deviceScaleFactor: dev.deviceScaleFactor, isMobile: true, hasTouch: true, isLandscape: true } : { width: w, height: h, deviceScaleFactor: 1 },
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${vw},${vh}`, '--hide-scrollbars', '--mute-audio'],
  });
  const page = await browser.newPage();
  if (dev) await page.setUserAgent(dev.ua);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e).slice(0, 300)));
  await page.evaluateOnNewDocument(() => { const W = window.WebSocket; window.WebSocket = function (u, p) { if (String(p).includes('vite')) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 0 }; return new W(u, p); }; });
  await page.evaluateOnNewDocument(GPU_TALLY);
  return { browser, page, errors };
}
const frames = (page, n) => page.evaluate((n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const MB = (b) => (b / 1048576).toFixed(1);
const { acquireGpuLock } = await import('./lib/gpulock.mjs');
await acquireGpuLock();

if (arg('load')) {
  const dev = DEVS[arg('dev', 'a')], thr = Number(arg('throttle', 4));
  const { browser, page, errors } = await launch(dev);
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (thr > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: thr });
    let bytes = 0; const big = [];
    const urls = new Map();
    cdp.on('Network.responseReceived', (e) => urls.set(e.requestId, e.response.url));
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; const u = urls.get(e.requestId) || ''; if (u.includes('/assets/') && e.encodedDataLength > 1.5e6) big.push(`${u.split('/assets/')[1]} ${MB(e.encodedDataLength)}`); });
    const t0 = Date.now();
    await page.goto(`${URL0}?mobile=1${arg('q') ? '&q=' + arg('q') : ''}`, { waitUntil: 'load', timeout: 300000 });
    await page.waitForFunction('window.__vm && window.__vm.ready && window.__vm.game.state === "menu"', { timeout: 600000, polling: 500 });
    const tMenu = (Date.now() - t0) / 1000, bMenu = bytes;
    await frames(page, 30);
    const menu = await page.evaluate(() => ({ q: window.__vm.engine.qualityName, res: [window.__vm.engine.rw, window.__vm.engine.rh], out: [window.__vm.engine.outW, window.__vm.engine.outH], auto: JSON.stringify(window.__vm.game.settings?.autoQuality || null) }));
    await page.evaluate(() => { window.__vm.game.start('survival'); });
    await frames(page, 240);
    await new Promise((r) => setTimeout(r, 4000));
    const stages = await page.evaluate(() => (window.__loadStages || []).map((x, i, a) => `${x[0]} ${(((a[i + 1] ? a[i + 1][1] : performance.now()) - x[1]) / 1000).toFixed(1)}s`).join(', '));
    console.log('  stages (to the game start):', stages);
    const st = await page.evaluate(() => ({ gpu: window.__gpuTally.bytes(), long: window.__long, info: window.__vm.info() }));
    const m = await page.metrics();
    const long = st.long.filter((x) => x[1] >= 200).sort((a, b) => b[1] - a[1]);
    console.log(`load dev=${arg('dev', 'a')} cpu x${thr}: menu after ${tMenu.toFixed(1)} s, ${MB(bMenu)} MB to the menu, ${MB(bytes)} MB after starting a game`);
    console.log(`  preset ${menu.q}, internal ${menu.res.join('x')}, output ${menu.out.join('x')}, bench ${menu.auto}`);
    console.log(`  GPU memory (allocations) ${MB(st.gpu)} MB, JS heap ${MB(m.JSHeapUsedSize)} MB used / ${MB(m.JSHeapTotalSize)} MB, in game ${JSON.stringify(st.info)}`);
    console.log(`  long tasks >= 200 ms: ${long.length}, worst ${long.slice(0, 6).map((x) => x[1]).join(' ')} ms; total long-task time ${st.long.reduce((s, x) => s + x[1], 0)} ms`);
    console.log(`  files over 1.5 MB: ${big.join(', ')}`);
    if (errors.length) console.log('  errors:', errors.slice(0, 5).join(' | '));
  } finally { await browser.close(); }
}

if (arg('shots')) {
  const views = String(arg('views', 'street,meadow,bridge,fight')).split(',');
  const tiers = String(arg('tiers', 'mobile,mobileHigh,low')).split(',');
  for (const tier of tiers) {
    const desk = tier === 'low';
    const { browser, page, errors } = await launch(desk ? null : DEVS[arg('dev', 'a')]);
    try {
      await page.goto(`${URL0}?auto=1&q=${tier}${desk ? '' : '&mobile=1'}`, { waitUntil: 'load', timeout: 300000 });
      await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 600000, polling: 500 });
      for (const view of views) {
        await page.evaluate((view) => {
          const vm = window.__vm;
          if (view !== 'fight') { vm.setView(view); return; }
          // three infected coming up the street towards the camera
          vm.cam(-4, 1.7, -30, 30, 1.2, -62, true);
          const Z = vm.game.zombies;
          for (let i = 0; i < 3; i++) Z.spawn(2 + i * 1.6, -36 - i * 1.2, { runner: false, variant: i, yaw: Math.atan2(-6, 6) });
        }, view);
        await frames(page, view === 'fight' ? 40 : 24);
        const info = await page.evaluate(() => window.__vm.info());
        await page.screenshot({ path: `${OUT}/${view}_${tier}.jpg`, type: 'jpeg', quality: 85 });
        console.log(tier, view, JSON.stringify(info));
      }
      if (errors.length) console.log('  errors:', errors.slice(0, 4).join(' | '));
    } finally { await browser.close(); }
  }
}

if (arg('caps')) {
  const list = String(arg('list', 'nofloat,nofloatlinear,tex2048,nohalf,nowebgl2,lose=20')).split(',');
  for (const c of list) {
    const { browser, page, errors } = await launch(DEVS.a);
    try {
      await page.goto(`${URL0}?auto=1&mobile=1&caps=${c}`, { waitUntil: 'load', timeout: 300000 });
      await page.waitForFunction('(window.__vm && window.__vm.ready) || document.getElementById("vm-fatal")', { timeout: 600000, polling: 500 });
      if (c.startsWith('lose')) await page.waitForFunction('document.getElementById("vm-fatal")', { timeout: 120000, polling: 500 });
      else await page.evaluate(() => window.__vm && window.__vm.setView('street'));
      await frames(page, 20);
      const s = await page.evaluate(() => ({ msg: document.getElementById('vm-fatal')?.innerText.replace(/\s+/g, ' ').slice(0, 90) || '', caps: window.__vm ? JSON.stringify({ fr: window.__vm.engine.caps.floatRender, fl: window.__vm.engine.caps.floatLinear, max: window.__vm.engine.caps.maxTex, sh: window.__vm.engine.q.shadow }) : '' }));
      await page.screenshot({ path: `${OUT}/caps_${c.replace('=', '')}.jpg`, type: 'jpeg', quality: 80 });
      console.log(c.padEnd(14), s.msg || 'renders', s.caps, errors.length ? 'errors: ' + errors.slice(0, 2).join(' | ') : '');
    } finally { await browser.close(); }
  }
}
