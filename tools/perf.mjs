// Cost attribution: for each view, toggles one thing at a time through window.__vm
// and reports the frame-time delta, plus per-module draw calls / triangles.
//   node tools/perf.mjs --views street,meadow --q high --w 1280 --h 720 [--only shadow,ao] [--pace] [--presets]
//   --pace     records 300 synced frames in the street view while the camera turns and walks
//   --presets  benches the street view on every quality preset (at --w/--h)
//   --split    per-pass GPU time (timer queries): shadow, scene by module, weapon, each post pass;
//              with --presets for all four presets, else for --q (comma list allowed)
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
// extra URL parameters for every page load, e.g. --extra "&gcache=0"
const extra = String(arg('extra', '') || '');
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
    refl: (on) => { if (on) keep.rf = e.q.reflect; e.q.reflect = on ? 0 : keep.rf; },
    aofull: (on) => { if (on) keep.af = s.aoFull; s.aoFull = on ? false : keep.af; },
    rays: (on) => { if (on) keep.ry = s.raySteps; s.raySteps = on ? Math.round(keep.ry / 2) : keep.ry; },
    scale75: (on) => { if (on) keep.rs = e.renderScale; e.renderScale = on ? 0.75 : keep.rs; e.resize(e.outW, e.outH); },
  };
  for (const k of ['terrain', 'buildings', 'props', 'water', 'grass', 'flowers', 'trees', 'impostors', 'vegsmall', 'other', 'sky']) T['hide_' + k] = (on) => hide(k, on);
  const noCast = (k, on) => { for (const o of groups[k] || []) o.traverse((c) => { if (on) { if (c.castShadow) { c.userData._cs = 1; c.castShadow = false; } } else if (c.userData._cs) { c.castShadow = true; delete c.userData._cs; } }); };
  for (const k of ['buildings', 'props', 'trees', 'vegsmall', 'other']) T['sh_' + k] = (on) => noCast(k, on);
  const info = () => { vm.step(0.016); const i = r.info.render; return { calls: i.calls, tris: i.triangles }; };
  const bench = (n) => { vm.bench(4); const a = vm.bench(n), b = vm.bench(n); return Math.min(a, b); };
  const triCount = (o) => { let t = 0; o.traverse((c) => { if (c.isMesh && c.geometry && c.visible) { const g = c.geometry; const n = (g.index ? g.index.count : g.attributes.position?.count || 0) / 3; t += n * (c.isInstancedMesh ? c.count : g.isInstancedBufferGeometry ? g.instanceCount : 1); } }); return t; };
  window.__perfOther = () => (groups.other || []).map((o) => [o.name || o.type, Math.round(triCount(o) / 1000), o.visible]).filter((x) => x[1] > 5 && x[2]);
  window.__perf = { T, groupsRaw: groups, groups:Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), info, bench, noShadow };
  return window.__perf.groups;
};

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile'),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--enable-privileged-webgl-extensions', '--enable-webgl-draft-extensions'],
});
const result = { q, W, H, views: {} };
const log = (s) => { console.log(s); fs.appendFileSync(path.join(out, 'perf.log'), s + '\n'); };
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  // no hot reload: other work saving files must not reload the page under a running test
  await page.evaluateOnNewDocument(() => { const W = window.WebSocket; window.WebSocket = function (u, p) { if (String(p).includes('vite')) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 0 }; return new W(u, p); }; });
  await page.goto(`http://127.0.0.1:5173/?q=${String(q).split(",")[0]}&auto=1${extra}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 180000, polling: 250 });
  const groups = await page.evaluate(SETUP);
  const ev = async (...a) => { for (let k = 0; ; k++) { try { return await page.evaluate(...a); } catch (e) { if (k > 3 || !/context was destroyed|navigation|__perf/.test(String(e))) throw e; log('  (page reloaded, retrying)'); await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 180000, polling: 250 }); await page.evaluate(SETUP); } } };
  log(`--- ${new Date().toISOString()} q=${q} ${W}x${H} groups ${JSON.stringify(groups)}`);
  if (arg('other', false)) log('other (name, ktris): ' + JSON.stringify(await page.evaluate(() => window.__perfOther())));
  const toggles = only || ['shadow', 'ao', 'vol', 'bloom', 'final', 'sky', 'msaa0', 'scale75', 'hide_terrain', 'hide_buildings', 'hide_props', 'hide_water', 'hide_grass', 'hide_flowers', 'hide_trees', 'hide_impostors', 'hide_vegsmall', 'hide_other', 'hide_sky', 'sh_buildings', 'sh_props', 'sh_trees', 'sh_vegsmall', 'sh_other'];
  if (!arg('pace', false) && !arg('presets', false) && !arg('split', false)) for (const view of views) {
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
    // walk (4.2 m/s, slow sweep) and run (9.6 m/s, fast turns) through each view, then a jump
    // (teleport into the view with no warm-up frames) to see the synchronous refill
    // --ab N: N rounds alternating ground cache off / on (page reloaded with gcache=0 / 1), so both
    // see the same outside load
    result.pace = {};
    const abN = Number(arg('ab', 0));
    const confs = abN ? Array.from({ length: abN }, (_, r) => [['off', '&gcache=0'], ['on', '&gcache=1']].map((c) => [...c, r])).flat() : [['', '', 0]];
    const abRows = [];
    for (const [tag, gq] of confs) {
    if (tag) {
      await page.goto(`http://127.0.0.1:5173/?q=${String(q).split(",")[0]}&auto=1${extra}${gq}`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 180000, polling: 250 });
      await page.evaluate(SETUP);
      for (let i = 0; i < 90; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    for (const view of views) for (const mode of [['walk', 0.07, 1.6, 1], ['run', 0.16, 2.6, 3]]) {
      const pace = await ev(async (view, mode) => {
        const vm = window.__vm, e = vm.engine, gl = e.gl, px = new Uint8Array(4);
        vm.setView(view);
        for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r));
        vm.stop();
        const c = e.camera, y0 = c.rotation.y;
        const f = new vm.THREE.Vector3();
        const ts = [], cpu = [], bks = [];
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < 300; i++) {
          c.rotation.y = y0 + Math.sin(i / 300 * Math.PI * 2 * mode[3]) * mode[2];
          f.set(0, 0, -1).applyQuaternion(c.quaternion); f.y = 0; f.normalize();
          c.position.addScaledVector(f, mode[1]);
          c.position.y = vm.terrain.heightAt(c.position.x, c.position.z) + 1.7;
          const bk0 = vm.terrain.cache ? vm.terrain.cache.bakes : 0;
          const t0 = performance.now();
          vm.step(1 / 60);
          const t1 = performance.now();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          ts.push(performance.now() - t0); cpu.push(t1 - t0); bks.push((vm.terrain.cache ? vm.terrain.cache.bakes : 0) - bk0);
        }
        // jump: from another view straight into this one, first 40 frames
        vm.setView(view === 'street' ? 'meadow' : 'street'); vm.step(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        vm.setView(view); vm.stop();
        const js = [];
        for (let i = 0; i < 40; i++) { const t0 = performance.now(); vm.step(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); js.push(performance.now() - t0); }
        vm.start();
        const s = [...ts].sort((a, b) => a - b);
        const worst = ts.map((t, i) => [t, i]).sort((a, b) => b[0] - a[0]).slice(0, 4).map(([t, i]) => `${t.toFixed(1)}@${i}(cpu ${cpu[i].toFixed(1)} bk ${bks[i]})`);
        const bkMed = (() => { const q = ts.filter((_, i) => bks[i] === 0).sort((a, b) => a - b); return q[q.length >> 1] || 0; })();
        return { bkMed, median: s[150], p95: s[285], p99: s[297], worst: s[299], over2x: ts.filter((t) => t > 2 * s[150]).length, cache: !!vm.terrain.cache, top: worst, jump0: js[0], jumpRest: Math.max(...js.slice(1)) };
      }, view, mode);
      log(`pace${tag ? ' [' + tag + ']' : ''} ${view} ${mode[0]}: >2x ${pace.over2x} | median ${pace.median.toFixed(2)} p95 ${pace.p95.toFixed(2)} p99 ${pace.p99.toFixed(2)} (x${(pace.p99 / pace.median).toFixed(2)}) worst ${pace.worst.toFixed(2)} (x${(pace.worst / pace.median).toFixed(2)}) | jump first ${pace.jump0.toFixed(1)} then max ${pace.jumpRest.toFixed(1)} | no-bake median ${pace.bkMed.toFixed(1)} | top ${pace.top.join(' ')}`);
      result.pace[view + '_' + mode[0] + (tag ? '_' + tag : '')] = pace;
      if (tag) abRows.push({ tag, view, mode: mode[0], ...pace });
    }
    }
    if (abRows.length) {
      log(`A/B summary q=${q} ${W}x${H} (mean over rounds; worst = max)`);
      log('view    mode cache  median   p95    p99   worst  >2x');
      for (const view of views) for (const m of ['walk', 'run']) for (const tag of ['off', 'on']) {
        const R = abRows.filter((r) => r.view === view && r.mode === m && r.tag === tag), mean = (k) => R.reduce((a, r) => a + r[k], 0) / R.length;
        log(`${view.padEnd(7)} ${m.padEnd(4)} ${tag.padEnd(4)} ${mean('median').toFixed(2).padStart(7)} ${mean('p95').toFixed(2).padStart(6)} ${mean('p99').toFixed(2).padStart(6)} ${Math.max(...R.map((r) => r.worst)).toFixed(1).padStart(6)} ${mean('over2x').toFixed(1).padStart(5)}  (cache ${R.map((r) => r.cache ? 1 : 0).join('')})`);
      }
    }
  }
  if (arg('cpu', false)) {
    // CPU-side cost per frame (no GPU sync): world updaters, terrain, sky, shadow submit, main submit, post
    const cpu = await page.evaluate(() => {
      const vm = window.__vm, e = vm.engine, r = e.renderer, acc = {};
      vm.setView('street'); vm.stop();
      const wrap = (obj, key, name) => { const f = obj[key]; obj[key] = function (...a) { const t = performance.now(); const v = f.apply(this, a); acc[name] = (acc[name] || 0) + performance.now() - t; return v; }; return () => { obj[key] = f; }; };
      const undo = [wrap(vm.terrain, 'update', 'terrain.update'), wrap(e.sky, 'update', 'sky.update'), wrap(e.post, 'render', 'post.render'), wrap(r.shadowMap, 'render', 'shadowMap.render'), wrap(r, 'render', 'renderer.render(all)'), wrap(e, 'render', 'engine.render')];
      vm.world.updaters.forEach((u, i) => { vm.world.updaters[i] = function (...a) { const t = performance.now(); u.apply(this, a); acc['updater' + i] = (acc['updater' + i] || 0) + performance.now() - t; }; vm.world.updaters[i]._o = u; });
      undo.push(wrap(vm.game.fx, 'update', 'game.fx.update'));
      const N = 120, c = e.camera;
      for (let i = 0; i < N; i++) { c.rotation.y += 0.01; const t = performance.now(); vm.step(1 / 60); acc.step = (acc.step || 0) + performance.now() - t; }
      undo.forEach((f) => f()); vm.world.updaters.forEach((u, i) => { vm.world.updaters[i] = u._o; }); vm.start();
      return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +(v / N).toFixed(2)]));
    });
    log('cpu ms/frame: ' + JSON.stringify(cpu));
  }
  if (arg('split', false)) {
    // Per-pass GPU time with EXT_disjoint_timer_query_webgl2: one running query per "label";
    // a label switch ends the running query and starts the next one, so nothing nests. Labels:
    // shadow, scene:<module> (by top-level scene group, set per draw via onBeforeRender),
    // weapon, post:<pass>, other (sky panorama, terrain updates, clears).
    const presets = arg('presets', false) ? ['low', 'medium', 'high', 'ultra'] : String(q).split(',');
    for (const p of presets) {
      await page.goto(`http://127.0.0.1:5173/?q=${p}&auto=1${extra}`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 180000, polling: 250 });
      await page.evaluate(SETUP);
      for (const view of views) {
        const r = await page.evaluate(async (view, n) => {
          const vm = window.__vm, e = vm.engine, r = e.renderer, gl = e.gl, sc = e.scene;
          const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
          vm.setView(view);
          for (let i = 0; i < 20; i++) await new Promise((res) => requestAnimationFrame(res));
          const wall = window.__perf.bench(n);
          if (!ext) return { wall, noext: true };
          vm.stop();
          const done = []; let cur = null, curQ = null;
          const setLabel = (l) => {
            if (l === cur) return;
            if (curQ) { gl.endQuery(ext.TIME_ELAPSED_EXT); done.push([cur, curQ]); curQ = null; }
            cur = l;
            if (l) { curQ = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, curQ); }
          };
          const undo = [];
          const wrap = (obj, key, fn) => { const f = obj[key]; obj[key] = function (...a) { return fn.call(this, f, a); }; undo.push(() => { obj[key] = f; }); };
          let inMain = false;
          wrap(r.shadowMap, 'render', function (f, a) { const prev = cur; setLabel('shadow'); const v = f.apply(this, a); setLabel(prev); return v; });
          wrap(r, 'render', function (f, a) {
            const main = a[1] === e.camera && !a[0].isMesh;
            const weap = a[1] === e.weaponCamera;
            inMain = main; if (weap) setLabel('weapon'); else if (main) setLabel('scene:other');
            const v = f.apply(this, a); inMain = false; if (main || weap) setLabel('other'); return v;
          });
          for (const [k, name] of Object.entries({ ao: 'ao', aoBlur: 'ao', vol: 'shafts', composite: 'composite', down: 'bloom', up: 'bloom', tone: 'tone', final: 'final' })) {
            const pass = e.post[k];
            if (!pass) continue;
            wrap(pass, 'render', function (f, a) { setLabel('post:' + name); const v = f.apply(this, a); setLabel('other'); return v; });
          }
          if (vm.terrain && vm.terrain._bake) wrap(vm.terrain, '_bake', function (f, a) { const prev = cur; setLabel('terrain:cache'); const v = f.apply(this, a); setLabel(prev); return v; });
          const cat = (o) => { for (const [k, arr] of Object.entries(window.__perf.groupsRaw)) if (arr.includes(o)) return k; return 'other'; };
          const hooked = [];
          for (const top of sc.children) {
            const c = 'scene:' + cat(top);
            top.traverse((m) => { if (m.isMesh || m.isPoints || m.isLine) { const ob = m.onBeforeRender; hooked.push([m, ob]); m.onBeforeRender = function (...a) { if (inMain) setLabel(c); return ob.apply(this, a); }; } });
          }
          gl.getParameter(ext.GPU_DISJOINT_EXT);
          for (let i = 0; i < n; i++) { setLabel('other'); vm.step(1 / 60); setLabel(null); }
          const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
          for (let k = 0; k < 200 && !gl.getQueryParameter(done[done.length - 1][1], gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((res) => setTimeout(res, 10));
          const acc = {};
          for (const [l, qq] of done) { acc[l] = (acc[l] || 0) + gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6; gl.deleteQuery(qq); }
          undo.reverse().forEach((f) => f()); for (const [m, ob] of hooked) m.onBeforeRender = ob;
          vm.start();
          const ms = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +(v / n).toFixed(2)]));
          const gpu = Object.values(ms).reduce((a, b) => a + b, 0);
          return { wall, gpu, disjoint, ms, calls: window.__perf.info().calls };
        }, view, frames);
        if (r.noext) { log(`split ${p} ${view}: wall ${r.wall.toFixed(2)} ms (no timer query extension)`); continue; }
        const rows = Object.entries(r.ms).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' | ');
        log(`split ${p.padEnd(6)} ${view.padEnd(7)} wall ${r.wall.toFixed(2)} gpu ${r.gpu.toFixed(2)}${r.disjoint ? ' DISJOINT' : ''} calls ${r.calls} :: ${rows}`);
        (result.split ||= {})[`${p}/${view}`] = r;
      }
    }
  }
  if (arg('presets', false) && !arg('split', false)) {
    for (const p of ['low', 'medium', 'high', 'ultra']) {
      // grass density and texture sizes are fixed at build time: load the page on each preset
      await page.goto(`http://127.0.0.1:5173/?q=${p}&auto=1${extra}`, { waitUntil: 'load', timeout: 120000 });
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
