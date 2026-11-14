// View-model capture: starts a Survival run, drives the player by script with
// deterministic 1/60 s steps and photographs each weapon in its key states,
// then builds one contact sheet per weapon.
//   node tools/vmshots.mjs [--weapons rifle,pistol,sniper] [--tag after] [--out tools/_preview/vm] [--eval "js"]
//   --seq Reload,ReloadEmpty,Fire[,BoltCycle] [--frames 14]: instead of the key states, film each clip as an evenly spaced
//   frame sequence (Fire: the first 0.3 s frame by frame) -> seq_<weapon>_<clip>.jpg, to review hands and parts in game
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? def : process.argv[i + 1]; };
const W = 1280, H = 720;
const weapons = String(arg('weapons', 'rifle,pistol,sniper')).split(',');
const tag = arg('tag', 'now');
const out = path.join(arg('out', 'tools/_preview/vm'), tag);
const extra = arg('eval', '');
const seq = arg('seq', '') ? String(arg('seq', '')).split(',') : null, nF = +arg('frames', 14);
fs.mkdirSync(out, { recursive: true });
const { acquireGpuLock } = await import('./lib/gpulock.mjs');
await acquireGpuLock();

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', protocolTimeout: 600000,
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile-vmshots'),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio'],
});
const errors = [];
try {
  const page = await browser.newPage();
  // no hot reload: other work saving files must not reload the page under a running test
  await page.evaluateOnNewDocument(() => { const W = window.WebSocket; window.WebSocket = function (u, p) { if (String(p).includes('vite')) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 0 }; return new W(u, p); }; });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 400)}`));
  await page.goto('http://127.0.0.1:5173/?q=high&auto=1', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready && window.__vm.game.weapon.views.rifle', { timeout: 180000, polling: 250 });
  await page.evaluate(() => {
    const vm = window.__vm, g = vm.game, p = g.player;
    vm.stop();
    window.__in = {};
    window.__vs = {
      run(sec) { for (let i = 0, n = Math.round(sec * 60); i < n; i++) vm.step(1 / 60); },
      setup(id) {
        if (g.state !== 'playing' || !p.alive) g.start('survival');
        g.interT = 1e9; g.queue = 0; g.queueList = []; g.cleared = true; g.zombies.clear(); g.settings.fov = 80;
        p.spawn(-58, 96, -0.55); p.pitch = -0.02; p.enabled = true; p.health = p.maxHealth;
        window.__in = {};
        p.script = (dt, pl) => { Object.assign(pl.input, window.__in); window.__in.prone = false; window.__in.slot = 0; };
        const w = g.weapon; w.reset();
        if (w.id !== id) { window.__in.slot = w.state[id].def.slot; }
        this.run(1.6);
        for (const k in w.state) { const s = w.state[k]; s.ammo = s.def.mag; s.reserve = Number.isFinite(s.reserve) ? s.def.reserveMax : s.reserve; }
      },
      // screen position (NDC) of a view-model node through the weapon camera
      ndc(name) {
        const w = g.weapon, n = w.nodes[name], wc = vm.engine.weaponCamera;
        if (!n) return null;
        const v = n.getWorldPosition(new vm.THREE.Vector3()); vm.engine.camera.worldToLocal(v);
        const z = v.z; v.applyMatrix4(wc.projectionMatrix);
        return [+v.x.toFixed(3), +v.y.toFixed(3), +(-z).toFixed(3)];
      },
    };
  });
  if (extra) await page.evaluate(extra);
  const snap = async (file) => { await page.screenshot({ path: file, type: 'jpeg', quality: 88 }); return file; };
  for (const id of weapons) {
    const files = [];
    const S = async (name, js) => { await page.evaluate(`{ ${js} }`); files.push(await snap(path.join(out, `${id}_${files.length}_${name}.jpg`))); };
    await page.evaluate((id) => window.__vs.setup(id), id);
    if (seq) {
      for (const clip of seq) {
        const sf = [];
        await page.evaluate((clip) => { const w = window.__vm.game.weapon; window.__in = {}; window.__vs.run(1.0); w.ammo = clip === 'ReloadEmpty' ? 0 : clip === 'Reload' ? 2 : w.ammo;
          window.__in = clip.startsWith('Reload') ? { reload: true } : { fire: true }; window.__vm.step(1 / 60); window.__in = {}; }, clip);
        const dur = await page.evaluate(() => { const a = window.__vm.game.weapon.act; return a ? a.dur : 0.3; });
        const dt = clip === 'Fire' ? 1 / 60 : dur / (nF - 1);
        for (let i = 0; i < nF; i++) {
          const f = path.join(out, `seq_${id}_${clip}_${String(i).padStart(2, '0')}.jpg`);
          await page.screenshot({ path: f, type: 'jpeg', quality: 85, clip: { x: 0, y: 0, width: W, height: H } }); sf.push(f);
          await page.evaluate((d) => window.__vs.run(d), dt);
        }
        const sheet = path.join(out, `seq_${id}_${clip}.jpg`);
        execFileSync('node', ['tools/sheet.mjs', sheet, '400', '4', ...sf], { stdio: 'ignore' });
        console.log(id, clip, '->', sheet, '| events', await page.evaluate(() => window.__vm.game.weapon.eventLog.slice(-6).join(' ')));
      }
      continue;
    }
    const diag = await page.evaluate(() => { const w = window.__vm.game.weapon, vs = window.__vs; return { id: w.id, fov: window.__vm.engine.weaponCamera.fov, hip: w.view.hip.toArray().map((x) => +x.toFixed(3)), ads: w.view.ads.toArray().map((x) => +x.toFixed(3)), tilt: +w.view.adsTilt.toFixed(4), rear: vs.ndc('SightRear'), front: vs.ndc('SightFront'), muzzle: vs.ndc('Muzzle'), eye: vs.ndc('ScopeEye'), env: +window.__vm.engine.scene.environmentIntensity.toFixed(3), clips: Object.keys(w.view.clips) }; });
    console.log('hip', JSON.stringify(diag));
    await S('hip', 'window.__vs.run(0.3)');
    await S('walk', 'window.__in = { fwd: 1 }; window.__vs.run(1.15)');
    await S('sprint', 'window.__in = { fwd: 1, sprint: true }; window.__vs.run(1.2)');
    console.log('sprint', JSON.stringify(await page.evaluate(() => ({ grip: window.__vs.ndc('Weapon'), muzzle: window.__vs.ndc('Muzzle'), rear: window.__vs.ndc('SightRear') }))));
    await S('aim', 'window.__in = {}; window.__vs.run(0.6); window.__in = { ads: true }; window.__vs.run(1.0)');
    const ad = await page.evaluate(() => { const vs = window.__vs; return { rear: vs.ndc('SightRear'), front: vs.ndc('SightFront'), eye: vs.ndc('ScopeEye') }; });
    console.log('ads', JSON.stringify(ad));
    // zero check: one aimed shot at the scene, its hit point projected through the world camera vs. the sights on screen
    console.log('zero', JSON.stringify(await page.evaluate(() => { const vm = window.__vm, w = vm.game.weapon, vs = window.__vs, cam = vm.engine.camera, prev = w.onShoot; let hp = null;
      w.onShoot = (o, d, def, st) => { const r = prev ? prev(o, d, def, st) : null; hp = (r && r.point) ? r.point.clone() : o.clone().addScaledVector(d, 50); return r; };
      window.__in = { ads: true, fire: true }; vm.step(1 / 60); window.__in = { ads: true }; w.onShoot = prev;
      const v = hp ? hp.clone().project(cam) : null; return { hit: v && [+v.x.toFixed(4), +v.y.toFixed(4)], rear: vs.ndc('SightRear'), front: vs.ndc('SightFront') }; })));
    await page.evaluate(() => window.__vs.run(0.8));
    if (id === 'sniper') {
      await S('scopeBolt', 'window.__in = { ads: true, fire: true }; window.__vm.step(1/60); window.__in = { ads: true }; window.__vs.run(0.4)');
      await S('bolt1', 'window.__in = {}; window.__vs.run(1.5); window.__in = { fire: true }; window.__vm.step(1/60); window.__in = {}; window.__vs.run(0.42)');
      await S('bolt2', 'window.__vs.run(0.3)');
    }
    await S('flash', 'window.__in = {}; window.__vs.run(0.8); window.__in = { fire: true }; window.__vm.step(1/60); window.__in = {}');
    await S('reload1', `window.__vs.run(1.2); const w = window.__vm.game.weapon; w.ammo = 2; window.__in = { reload: true }; window.__vm.step(1/60); window.__in = {}; window.__vs.run(w.act ? w.act.dur * 0.22 : 0)`);
    await S('reload2', 'const a = window.__vm.game.weapon.act; window.__vs.run(a ? a.dur * 0.28 : 0)');
    await S('reload3', 'const a = window.__vm.game.weapon.act; window.__vs.run(a ? a.dur * 0.3 : 0)');
    if (id === 'sniper') {
      await S('deploy1', 'window.__vs.run(2); window.__in = { prone: true }; window.__vm.step(1/60); window.__in = {}; const w = window.__vm.game.weapon; for (let i = 0; i < 400 && !(w.bipodClipT >= 0.3 && w.bipodClipT < 1); i++) window.__vm.step(1/60)');
      await S('deploy2', 'window.__vs.run(0.12)');
      await S('prone', 'window.__vs.run(2.2)');
      await S('bipodAim', 'window.__in = { ads: true }; window.__vs.run(1.2); window.__in = {}');
    }
    const sheet = path.join(out, `sheet_${id}.jpg`);
    execFileSync('node', ['tools/sheet.mjs', sheet, '640', '3', ...files], { stdio: 'ignore' });
    console.log(id, '->', sheet, '| events', await page.evaluate(() => window.__vm.game.weapon.eventLog.slice(-8).join(' ')));
  }
} finally {
  await browser.close();
}
if (errors.length) console.log('--- console:\n' + [...new Set(errors)].slice(0, 10).join('\n'));
