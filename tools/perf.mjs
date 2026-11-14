// Cost attribution: for each view, toggles one thing at a time through window.__vm
// and reports the frame-time delta, plus per-module draw calls / triangles.
//   node tools/perf.mjs --views street,meadow --q high --w 1280 --h 720 [--only shadow,ao] [--pace] [--presets]
//   --pace     records 300 synced frames in the street view while the camera turns and walks
//   --presets  benches the street view on every quality preset (at --w/--h)
// Results go to tools/_preview/perf/perf.json and stdout (one line per toggle).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const views = String(arg('views', 'street')).split(',');
const W = Number(arg('w', 1280)), H = Number(arg('h', 720));
const q = arg('q', 'high');
const only = arg('only', '') ? String(arg('only')).split(',') : null;
const frames = Number(arg('n', 30));
const out = arg('out', 'tools/_preview/perf');
fs.mkdirSync(out, { recursive: true });
const { acquireGpuLock } = await import('./lib/gpulock.mjs');
await acquireGpuLock();

// page-side helpers, installed once
const SETUP = () => {
  const vm = window.__vm, e = vm.engine, r = e.renderer, sc = e.scene;
  vm.VIEWS.square = { pos: [44, 1.7, -78], look: [60, 8, -110] };
  const cat = (o) => {
    if (o === vm.terrain.group) return 'terrain';
    if (o === e.sky.dome) return 'sky';
    const n = o.name || '';
    if (n === 'buildings') return 'buildings';
    if (n.startsWith('props-')) return 'props';
    if (n === 'river-water') return 'water';
    if (n === 'grass-flowers') return 'flowers';
    if (n.startsWith('grass-')) return 'grass';
    if (n === 'tree-impostors') return 'impostors';
    if (n.startsWith('tree-')) return 'trees';
    if (/rock|wood|stone|bush|fern|shrub|reed|log/i.test(n)) return 'vegsmall';
    return 'other';
  };
  const groups = {};
  for (const o of sc.children) (groups[cat(o)] ||= []).push(o);
  const hide = (k, on) => { for (const o of groups[k] || []) { if (on) { o.userData._pl = o.layers.mask; o.layers.set(7); o.traverse((c) => { if (c !== o) { c.userData._pl = c.layers.mask; c.layers.set(7); } }); } else { o.traverse((c) => { if (c.userData._pl !== undefined) { c.layers.mask = c.userData._pl; delete c.userData._pl; } }); } } };
  const sm = r.shadowMap;
  const noShadow = (on) => { if (on) Object.defineProperty(sm, 'needsUpdate', { configurable: true, get: () => false, set() {} }); else { delete sm.needsUpdate; sm.needsUpdate = true; } };
  const p = e.post, s = p.settings;
  const keep = {};
  const T = {
    shadow: (on) => noShadow(on),
    ao: (on) => { s.ao = !on; },
    vol: (on) => { s.volumetric = !on; },
    bloom: (on) => { if (on) { keep.d = p.down.render; keep.u = p.up.render; p.down.render = p.up.render = () => {}; } else { p.down.render = keep.d; p.up.render = keep.u; } },
    final: (on) => { if (on) { keep.fs = s.sharpen; keep.fx = s.fxaa; s.sharpen = 0; s.fxaa = false; } else { s.sharpen = keep.fs; s.fxaa = keep.fx; } },
    sky: (on) => { if (on) { keep.su = e.sky.update; e.sky.update = () => {}; } else e.sky.update = keep.su; },
    msaa0: (on) => { if (on) keep.ms = e.q.msaa; e.q.msaa = on ? 0 : keep.ms; e.resize(e.outW, e.outH); },
    scale75: (on) => { if (on) keep.rs = e.renderScale; e.renderScale = on ? 0.75 : keep.rs; e.resize(e.outW, e.outH); },
  };
  for (const k of ['terrain', 'buildings', 'props', 'water', 'grass', 'flowers', 'trees', 'impostors', 'vegsmall', 'other', 'sky']) T['hide_' + k] = (on) => hide(k, on);
  const noCast = (k, on) => { for (const o of groups[k] || []) o.traverse((c) => { if (on) { if (c.castShadow) { c.userData._cs = 1; c.castShadow = false; } } else if (c.userData._cs) { c.castShadow = true; delete c.userData._cs; } }); };
  for (const k of ['buildings', 'props', 'trees', 'vegsmall', 'other']) T['sh_' + k] = (on) => noCast(k, on);
  const info = () => { vm.step(0.016); const i = r.info.render; return { calls: i.calls, tris: i.triangles }; };
  const bench = (n) => { vm.bench(4); const a = vm.bench(n), b = vm.bench(n); return Math.min(a, b); };
  const triCount = (o) => { let t = 0; o.traverse((c) => { if (c.isMesh && c.geometry && c.visible) { const g = c.geometry; const n = (g.index ? g.index.count : g.attributes.position?.count || 0) / 3; t += n * (c.isInstancedMesh ? c.count : g.isInstancedBufferGeometry ? g.instanceCount : 1); } }); return t; };
  window.__perfOther = () => (groups.other || []).map((o) => [o.name || o.type, Math.round(triCount(o) / 1000), o.visible]).filter((x) => x[1] > 5 && x[2]);
  window.__perf = { T, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), info, bench, noShadow };
  return window.__perf.groups;
};

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile'),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio'],
});
const result = { q, W, H, views: {} };
const log = (s) => { console.log(s); fs.appendFileSync(path.join(out, 'perf.log'), s + '\n'); };
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:5173/?q=${q}&auto=1`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 180000, polling: 250 });
  const groups = await page.evaluate(SETUP);
  const ev = async (...a) => { for (let k = 0; ; k++) { try { return await page.evaluate(...a); } catch (e) { if (k > 3 || !/context was destroyed|navigation|__perf/.test(String(e))) throw e; log('  (page reloaded, retrying)'); await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 180000, polling: 250 }); await page.evaluate(SETUP); } } };
  log(`--- ${new Date().toISOString()} q=${q} ${W}x${H} groups ${JSON.stringify(groups)}`);
  if (arg('other', false)) log('other (name, ktris): ' + JSON.stringify(await page.evaluate(() => window.__perfOther())));
  const toggles = only || ['shadow', 'ao', 'vol', 'bloom', 'final', 'sky', 'msaa0', 'scale75', 'hide_terrain', 'hide_buildings', 'hide_props', 'hide_water', 'hide_grass', 'hide_flowers', 'hide_trees', 'hide_impostors', 'hide_vegsmall', 'hide_other', 'hide_sky', 'sh_buildings', 'sh_props', 'sh_trees', 'sh_vegsmall', 'sh_other'];
  if (!arg('pace', false) && !arg('presets', false)) for (const view of views) {
    const base = await ev(async (view, n) => {
      const vm = window.__vm, P = window.__perf;
      vm.setView(view);
      for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r));
      const inf = P.info(); P.noShadow(true); const ns = P.info(); P.noShadow(false);
      return { ms: P.bench(n), ...inf, shadowCalls: inf.calls - ns.calls, shadowTris: inf.tris - ns.tris };
    }, view, frames);
    log(`${view}: base ${base.ms.toFixed(2)} ms | calls ${base.calls} tris ${(base.tris / 1e6).toFixed(2)}M | shadow pass calls ${base.shadowCalls} tris ${(base.shadowTris / 1e6).toFixed(2)}M`);
    const rows = {};
    for (const t of toggles) {
      const r = await ev((t, n) => {
        const P = window.__perf;
        // A/B/A: the machine is shared, so the reference is measured right around the variant
        const a = P.bench(n);
        P.T[t](true); const inf = P.info(); const ms = P.bench(n); P.T[t](false);
        P.info(); const b = P.bench(n);
        return { ms, ref: Math.min(a, b), spread: Math.abs(a - b), ...inf };
      }, t, frames);
      rows[t] = { ms: +r.ms.toFixed(2), dms: +(r.ref - r.ms).toFixed(2), dcalls: base.calls - r.calls, dtris: base.tris - r.tris };
      log(`  ${t.padEnd(15)} ${(-rows[t].dms).toFixed(2).padStart(6)} ms (ref ${r.ref.toFixed(1)} ±${r.spread.toFixed(1)})   calls -${rows[t].dcalls}   tris -${(rows[t].dtris / 1e3).toFixed(0)}k`);
    }
    const again = await page.evaluate((n) => window.__perf.bench(n), frames);
    log(`  (base re-run ${again.toFixed(2)} ms)`);
    result.views[view] = { base, again, rows };
  }
  if (arg('pace', false)) {
    const pace = await page.evaluate(async () => {
      const vm = window.__vm, e = vm.engine, gl = e.gl, px = new Uint8Array(4);
      vm.setView('street');
      for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r));
      vm.stop();
      const c = e.camera, y0 = c.rotation.y;
      const f = new vm.THREE.Vector3();
      const ts = [], cpu = [];
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < 300; i++) {
        c.rotation.y = y0 + Math.sin(i / 300 * Math.PI * 2) * 1.6; // sweeps 90 deg either side
        f.set(0, 0, -1).applyQuaternion(c.quaternion); f.y = 0; f.normalize();
        c.position.addScaledVector(f, 0.07);
        c.position.y = vm.terrain.heightAt(c.position.x, c.position.z) + 1.7;
        const t0 = performance.now();
        vm.step(1 / 60);
        const t1 = performance.now();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        ts.push(performance.now() - t0); cpu.push(t1 - t0);
      }
      vm.start();
      const s = [...ts].sort((a, b) => a - b);
      const worst = ts.map((t, i) => [t, i]).sort((a, b) => b[0] - a[0]).slice(0, 6).map(([t, i]) => `${t.toFixed(1)}@${i}(cpu ${cpu[i].toFixed(1)})`);
      const cs = [...cpu].sort((a, b) => a - b);
      return { cpuMedian: cs[150], cpuWorst: cs[299], median: s[150], p95: s[285], p99: s[297], worst: s[299], mean: ts.reduce((a, b) => a + b) / 300, top: worst };
    });
    log(`pace street: median ${pace.median.toFixed(2)} p95 ${pace.p95.toFixed(2)} p99 ${pace.p99.toFixed(2)} worst ${pace.worst.toFixed(2)} mean ${pace.mean.toFixed(2)} | cpu median ${pace.cpuMedian.toFixed(2)} worst ${pace.cpuWorst.toFixed(2)} | top ${pace.top.join(' ')}`);
    result.pace = pace;
  }
  if (arg('presets', false)) {
    for (const p of ['low', 'medium', 'high', 'ultra']) {
      // grass density and texture sizes are fixed at build time: load the page on each preset
      await page.goto(`http://127.0.0.1:5173/?q=${p}&auto=1`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 180000, polling: 250 });
      await page.evaluate(SETUP);
      const r = await page.evaluate(async (p, n) => {
        const vm = window.__vm;
        vm.setView('street');
        for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
        const inf = window.__perf.info(); const ms = window.__perf.bench(n);
        return { ms, ...inf };
      }, p, frames);
      log(`preset ${p.padEnd(7)} ${r.ms.toFixed(2)} ms | calls ${r.calls} tris ${(r.tris / 1e6).toFixed(2)}M`);
    }
  }
  fs.writeFileSync(path.join(out, 'perf.json'), JSON.stringify(result, null, 1));
  if (errors.length) log('--- errors:\n' + [...new Set(errors)].slice(0, 8).join('\n'));
} finally {
  await browser.close();
}
