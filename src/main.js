import '@fontsource-variable/inter';
// first: the light asset set for phones must be in place before any module starts a download
import { initAssets, assetStats } from './engine/assets.js';
import * as THREE from 'three';
import { Engine } from './engine/engine.js';
import { G } from './engine/shared.js';
import { makeNoiseTexture } from './engine/textures.js';
import { Terrain } from './world/terrain.js';
import { createLayout } from './world/layout.js';
import { buildWorld } from './world/world.js';
import { Game } from './game/game.js';
import { UI, loadSettings, saveSettings, hasSavedSettings } from './ui/ui.js';
import { Progress } from './game/progress.js';
import { Operation } from './game/operation.js';
import { createFilm } from './cinematic/film.js';
import { MOBILE } from './core/device.js';
import { installCapMask, hasWebGL2, showMessage } from './engine/caps.js';
import { enterFullscreen, isFullscreen, canFullscreen } from './ui/touch.js';

// an inline icon keeps the browser from asking the server for a favicon that does not exist (index.html normally links the real one)
if (!document.querySelector('link[rel="icon"]')) { const l = document.createElement('link'); l.rel = 'icon'; l.href = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E'; document.head.appendChild(l); }
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
// `?auto=1` is the tooling mode used for screenshots, benchmarks and the film
// renderer: no menu, free camera, everything driven through window.__vm.
const AUTO = params.has('auto');

// Named viewpoints matching the reference photographs.
const VIEWS = {
  meadow: { pos: [-72, 2.0, 122], look: [38, 16, -90] },
  wide: { pos: [-30, 2.2, 150], look: [30, 30, -120] },
  bridge: { pos: [-112, 4.4, 2], look: [40, 12, -80] },
  river: { pos: [-64, 0.4, 42], look: [20, 12, -80] },
  street: { pos: [-4, 1.7, -30], look: [44, 16, -96] },
  hill: { pos: [268, 3.2, -40], look: [40, -8, -90] },
  tank: { pos: [128, 1.3, -6], look: [60, 12, -100] },
  peaks: { pos: [0, 30, 100], look: [0, 500, -5000] },
  sky: { pos: [0, 2, 100], look: [-300, 520, -600] },
  top: { pos: [20, 420, 60], look: [20, 0, -40] },
};

async function boot() {
  const settings = loadSettings();
  // first start (no saved settings): a one-second benchmark at the end of loading picks the preset
  const firstRun = !AUTO && !params.get('q') && !hasSavedSettings();
  if (params.get('q')) settings.quality = params.get('q');
  let game = null, engine = null;
  // the player asks for raw (unaccelerated) mouse input and falls back to the plain lock
  // on touch there is no pointer lock: the same tap goes fullscreen (and landscape) instead
  const touchMode = () => document.body.classList.contains('touch');
  const lock = () => {
    if (touchMode()) { if (MOBILE) enterFullscreen(); return; }
    if (game && game.player) game.player.requestLock(); else { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not available */ } }
  };
  const applySetting = (k) => {
    if (!engine) return;
    if (k === 'quality' || k === 'renderScale' || k === 'all') {
      if (k !== 'renderScale') engine.setQuality(settings.quality);
      engine.renderScale = engine.q.scale * settings.renderScale;
      engine.resize(engine.outW, engine.outH);
    }
    if (k === 'dynamicRes' || k === 'all') {
      // tools (AUTO) measure fixed presets: the governor is off there unless ?dynres=1
      engine.dynamicRes = AUTO ? params.get('dynres') === '1' : settings.dynamicRes !== false;
      if (!engine.dynamicRes) engine.resize(engine.outW, engine.outH);   // back to the full set scale
    }
    if (k === 'grain' || k === 'all') engine.post.settings.grain = settings.grain ? 0.012 : 0;
    if (game && (k === 'master' || k === 'music' || k === 'sfx' || k === 'all')) game.audio.setVolumes({ master: settings.master, music: settings.music, sfx: settings.sfx });
  };
  const progress = new Progress();
  const ui = new UI(document.getElementById('ui'), settings, {
    play: () => { game.start('survival'); lock(); },
    operation: () => { game.toBase(); },
    deploy: () => { game.start('operation'); lock(); },
    base: () => { game.toBase(); },
    sound: (name, volume = 0.5) => { game?.audio.resume(); game?.audio.play(name, { volume }); },
    resume: () => { lock(); game.resume(); },
    quit: () => { document.exitPointerLock?.(); game.toMenu(); },
    pause: () => { document.exitPointerLock?.(); game.pause(); },
    settings: applySetting,
    click: () => { game?.audio.resume(); game?.audio.play('ui_click', { volume: 0.5 }); },
  }, progress);
  if (AUTO) document.getElementById('ui').style.display = 'none';

  // Loading display: the stage of the start-up, or the share of the expected download when that is
  // further along (on a slow connection the downloads are most of the wait), with the megabytes so far.
  let loadP = 0, loadLabel = '';
  const loadProgress = (p, label) => {
    if (label !== undefined && label !== loadLabel) (window.__loadStages ||= []).push([label, Math.round(performance.now())]);   // (stage timing for tools)
    if (label !== undefined) loadLabel = label;
    const expect = assetStats.startBytes || (assetStats.lite ? 48e6 : 125e6);
    loadP = Math.max(loadP, p ?? 0, Math.min(0.95, assetStats.bytes / expect));
    if (p === 1) { loadP = 1; clearInterval(loadTick); }
    const mb = assetStats.bytes / 1048576;
    ui.progress(loadP, loadP < 1 && mb >= 1 ? `${loadLabel} (${mb.toFixed(0)} MB)` : loadLabel);
  };
  const loadTick = setInterval(() => loadProgress(), 250);
  // capability masks for testing (?caps=), then the plain message where WebGL2 is missing
  installCapMask();
  if (!hasWebGL2()) {
    clearInterval(loadTick);
    showMessage('This browser cannot show Valle Morta', 'The game needs WebGL2, which this browser or device does not offer. A current Chrome, Safari, Firefox or Edge will run it.');
    return;
  }
  // phones and tablets load the light asset set (public/assets/m/) and start on the phone tier
  await initAssets();
  if (MOBILE && firstRun) { settings.quality = 'low'; ui.syncSettings?.(); }   // = the mobile preset (engine.resolveQuality)

  loadProgress(0.05, 'Starting renderer');
  await nextFrame();
  engine = new Engine(canvas, settings.quality);
  engine.renderScale = engine.q.scale * (AUTO ? 1 : settings.renderScale);
  G.uNoiseTex.value = makeNoiseTexture(256, 11);
  // phones: the visual viewport is what is actually on screen while the address bar comes and goes
  const portrait = () => MOBILE && window.innerHeight > window.innerWidth * 1.05;
  const resize = () => {
    const vv = MOBILE && window.visualViewport;
    const w = vv ? Math.round(vv.width) : window.innerWidth, h = vv ? Math.round(vv.height) : window.innerHeight;
    engine.resize(Math.max(320, w), Math.max(200, h));
    if (portrait() && game && game.state === 'playing') game.pause();     // turned upright: the run waits behind the rotate screen
  };
  resize();
  window.addEventListener('resize', resize);
  if (MOBILE) {
    window.visualViewport?.addEventListener('resize', resize);
    // some browsers report the new size a moment after the rotation
    window.addEventListener('orientationchange', () => { resize(); setTimeout(resize, 250); setTimeout(resize, 700); });
  }

  const layout = createLayout();
  loadProgress(0.12, 'Raising the mountains');
  const terrain = await Terrain.load(engine, (p) => loadProgress(0.12 + p * 0.3));
  engine.scene.add(terrain.group);
  loadProgress(0.45, 'Gathering clouds');
  await engine.init(nextFrame);
  const off = new Set((params.get('off') || '').split(',').filter(Boolean));
  loadProgress(0.55, 'Building the village');
  const world = await buildWorld(engine, terrain, layout, off, (p) => loadProgress(0.55 + p * 0.25));
  loadProgress(0.82, 'Waking the valley');
  game = new Game({ engine, terrain, layout, world, settings });
  await game.init((p) => loadProgress(0.82 + p * 0.12));
  // textures uploaded and shaders compiled in slices, before the first real frame
  loadProgress(0.94, 'Preparing shaders');
  await engine.prewarm(nextFrame, (p) => loadProgress(0.94 + p * 0.05));
  game.progress = progress;
  game.operation = new Operation(game, progress);
  game.ui = AUTO ? null : ui;
  // the summary screen needs the cursor back
  game.onOver = () => { document.exitPointerLock?.(); };
  applySetting('grain'); applySetting('master'); applySetting('dynamicRes');

  const setView = (name) => {
    const v = VIEWS[name] || VIEWS.meadow;
    const y = terrain.heightAt(v.pos[0], v.pos[2]) + v.pos[1];
    engine.camera.position.set(v.pos[0], y, v.pos[2]);
    engine.camera.lookAt(v.look[0], v.look[1], v.look[2]);
  };

  // Renders the street view (the most expensive hero view) on the current preset, three batches of
  // eight synced frames (about a second on the target GPU), and keeps the fastest preset expected
  // to hold 60 fps. On an unsteady (busy) machine or near a threshold it takes the lower preset.
  const autoQuality = async () => {
    const cam = engine.camera, p0 = cam.position.clone(), r0 = cam.rotation.clone();
    setView('street');
    const gl = engine.gl, px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const run = (n) => {
      sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { terrain.update(cam); for (const u of world.updaters) u(0, cam, engine.time); engine.render(0); }
      sync();
      return (performance.now() - t0) / n;
    };
    // warm-up one frame at a time: the first frames link the remaining programs (shadow depth
    // variants) and upload late textures, which on a phone would be one long stall
    for (let i = 0; i < 4; i++) { run(1); await nextFrame(); }
    const t = [];
    for (let i = 0; i < 3; i++) { t.push(run(8)); await nextFrame(); }
    t.sort((a, b) => a - b);
    // cost of each preset relative to medium at its own render scale, measured on the 780M at
    // 1920x1200 (GPU split, street; meadow agrees within 10 %); the bench runs on whatever preset was loaded
    const REL = { low: 0.68, medium: 1, high: 1.3, ultra: 1.55 };
    const ms = t[1] / (REL[engine.qualityName] || 1) / Math.max(0.5, (engine.dynScale ?? engine.renderScale) / engine.q.scale) ** 2;
    const unsure = t[2] > t[0] * 1.3;
    const m = unsure ? 0.9 : 1;   // margin: prefer the lower preset when the timing is unsteady
    // the highest preset expected to hold about 55 fps (18 ms) at the display size; never ultra
    const pick = ['high', 'medium'].find((p) => ms * REL[p] <= 18 * m) || 'low';
    cam.position.copy(p0); cam.rotation.copy(r0);
    settings.autoQuality = { pick, ms: +ms.toFixed(1), unsure };
    console.info(`[auto quality] ${ms.toFixed(1)} ms on high (batches ${t.map((x) => x.toFixed(1)).join(' ')}) -> ${pick}`);
    if (pick !== settings.quality) { settings.quality = pick; applySetting('quality'); }
    saveSettings(settings);
    ui.syncSettings?.();
  };

  // pointer lock <-> pause
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas && game.state === 'playing' && !AUTO && !touchMode()) game.pause();
  });
  canvas.addEventListener('click', () => { if (game.state === 'playing' && document.pointerLockElement !== canvas && !AUTO && !touchMode()) lock(); });
  // phones: leaving fullscreen or the app pauses the run; the next tap (Resume) goes fullscreen again
  const fsChange = () => { if (MOBILE && !AUTO && !isFullscreen() && canFullscreen() && game.state === 'playing') game.pause(); };
  document.addEventListener('fullscreenchange', fsChange);
  document.addEventListener('webkitfullscreenchange', fsChange);
  document.addEventListener('visibilitychange', () => { if (document.hidden && !AUTO && game.state === 'playing' && touchMode()) game.pause(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && game.state === 'paused') { /* browsers swallow Esc while unlocking; resume is via the button */ }
    if (e.code === 'KeyP' && game.state === 'playing') { document.exitPointerLock?.(); game.pause(); }
  });

  // free-fly inspection camera for tooling mode
  const keys = new Set();
  let drag = false;
  if (AUTO) {
    game.state = 'debug';
    setView(params.get('view') || 'meadow');
    window.addEventListener('keydown', (e) => keys.add(e.code));
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    canvas.addEventListener('mousedown', () => { drag = true; });
    window.addEventListener('mouseup', () => { drag = false; });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      engine.camera.rotation.y -= e.movementX * 0.003;
      engine.camera.rotation.x = THREE.MathUtils.clamp(engine.camera.rotation.x - e.movementY * 0.003, -1.5, 1.5);
    });
  } else {
    // phones skip it: they start on the mobile preset (set above) and step up in Settings
    if (firstRun && !MOBILE) {
      loadProgress(0.99, 'Tuning graphics');
      try { await autoQuality(); } catch (e) { console.error('[auto quality] failed:', e); }
    }
    loadProgress(1);
    game.toMenu();
  }

  const stats = { fps: 0, frames: 0, t0: performance.now() };
  const step = (dt) => {
    if (game.state === 'debug') {
      const sp = (keys.has('ShiftLeft') ? 60 : 12) * dt;
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(engine.camera.quaternion);
      const r = new THREE.Vector3(1, 0, 0).applyQuaternion(engine.camera.quaternion);
      if (keys.has('KeyW')) engine.camera.position.addScaledVector(f, sp);
      if (keys.has('KeyS')) engine.camera.position.addScaledVector(f, -sp);
      if (keys.has('KeyD')) engine.camera.position.addScaledVector(r, sp);
      if (keys.has('KeyA')) engine.camera.position.addScaledVector(r, -sp);
      game.fx.update(dt);
    } else if (game.state !== 'paused') game.update(dt);
    const wdt = game.state === 'paused' ? 0 : dt;
    terrain.update(engine.camera);
    for (const u of world.updaters) u(wdt, engine.camera, engine.time);
    engine.render(wdt);
  };
  let last = performance.now();
  let running = true;
  const frame = (now) => {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    engine.govern(now - last);   // dynamic resolution
    last = now;
    step(dt);
    stats.frames++;
    if (now - stats.t0 >= 500) { stats.fps = (stats.frames * 1000) / (now - stats.t0); stats.frames = 0; stats.t0 = now; game.fps = stats.fps; }
  };
  requestAnimationFrame(frame);
  // the minimap's aerial picture: one orthographic render once the menu scene has settled
  if (!AUTO) (async () => { for (let i = 0; i < 4; i++) await nextFrame(); ui.bakeMap(engine, layout); })();

  window.__vm = {
    engine, terrain, layout, world, game, ui, THREE, G, stats, setView, VIEWS, step, progress, operation: game.operation,
    // absolute camera; pass y as height above ground with ground=true
    cam(x, y, z, lx, ly, lz, ground = false) {
      engine.camera.position.set(x, ground ? terrain.heightAt(x, z) + y : y, z);
      engine.camera.lookAt(lx, ly, lz);
    },
    info() {
      const i = engine.renderer.info;
      return { fps: +stats.fps.toFixed(1), calls: i.render.calls, tris: i.render.triangles, res: [engine.rw, engine.rh], state: game.state };
    },
    stop() { running = false; },
    start() { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } },
    // live tuning of the cloud model: numbers or [x, y, z] arrays
    skyParams(p) {
      const sp = engine.sky.params;
      for (const k in p) { if (Array.isArray(p[k])) sp[k].set(...p[k]); else sp[k] = p[k]; }
      engine.sky.slots.clear();
      engine.sky.update(engine.time, true);
      engine.sky.updateEnvironment(engine.scene);
    },
    // GPU-bound frame time: renders n frames back to back and waits for the GPU
    bench(n = 40) {
      const gl = engine.gl;
      const px = new Uint8Array(4);
      step(0.016); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) step(0.016);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return (performance.now() - t0) / n;
    },
    ready: true,
  };
  if (AUTO) window.__vm.film = createFilm(window.__vm);
}

boot().catch((e) => {
  console.error(e);
  if (e && e.vmMessage) { showMessage(e.vmMessage[0], e.vmMessage[1]); return; }
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;color:#f88;background:#111;white-space:pre-wrap;font:13px system-ui;z-index:99';
  d.textContent = String((e && e.stack) || e);
  document.body.appendChild(d);
});
