import '@fontsource-variable/inter';
import * as THREE from 'three';
import { Engine } from './engine/engine.js';
import { G } from './engine/shared.js';
import { makeNoiseTexture } from './engine/textures.js';
import { Terrain } from './world/terrain.js';
import { createLayout } from './world/layout.js';
import { buildWorld } from './world/world.js';
import { Game } from './game/game.js';
import { UI, loadSettings } from './ui/ui.js';
import { createFilm } from './cinematic/film.js';

// an inline icon keeps the browser from asking the server for a favicon that does not exist
{ const l = document.createElement('link'); l.rel = 'icon'; l.href = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E'; document.head.appendChild(l); }
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
  if (params.get('q')) settings.quality = params.get('q');
  let game = null, engine = null;
  const lock = () => { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not available */ } };
  const applySetting = (k) => {
    if (!engine) return;
    if (k === 'quality' || k === 'renderScale' || k === 'all') {
      if (k !== 'renderScale') engine.setQuality(settings.quality);
      engine.renderScale = engine.q.scale * settings.renderScale;
      engine.resize(engine.outW, engine.outH);
    }
    if (k === 'grain' || k === 'all') engine.post.settings.grain = settings.grain ? 0.012 : 0;
    if (game && (k === 'master' || k === 'music' || k === 'sfx' || k === 'all')) game.audio.setVolumes({ master: settings.master, music: settings.music, sfx: settings.sfx });
  };
  const ui = new UI(document.getElementById('ui'), settings, {
    play: () => { game.start(); lock(); },
    resume: () => { lock(); game.resume(); },
    quit: () => { document.exitPointerLock?.(); game.toMenu(); },
    settings: applySetting,
    click: () => { game?.audio.resume(); game?.audio.play('ui_click', { volume: 0.5 }); },
  });
  if (AUTO) document.getElementById('ui').style.display = 'none';

  ui.progress(0.05, 'Starting renderer');
  await nextFrame();
  engine = new Engine(canvas, settings.quality);
  engine.renderScale = engine.q.scale * (AUTO ? 1 : settings.renderScale);
  G.uNoiseTex.value = makeNoiseTexture(256, 11);
  const resize = () => engine.resize(Math.max(320, window.innerWidth), Math.max(200, window.innerHeight));
  resize();
  window.addEventListener('resize', resize);

  const layout = createLayout();
  ui.progress(0.12, 'Raising the mountains');
  const terrain = await Terrain.load(engine, (p) => ui.progress(0.12 + p * 0.3));
  engine.scene.add(terrain.group);
  ui.progress(0.45, 'Gathering clouds');
  await engine.init(nextFrame);
  const off = new Set((params.get('off') || '').split(',').filter(Boolean));
  ui.progress(0.55, 'Building the village');
  const world = await buildWorld(engine, terrain, layout, off, (p) => ui.progress(0.55 + p * 0.25));
  ui.progress(0.82, 'Waking the valley');
  game = new Game({ engine, terrain, layout, world, settings });
  await game.init((p) => ui.progress(0.82 + p * 0.16));
  game.ui = AUTO ? null : ui;
  // the summary screen needs the cursor back
  game.onOver = () => { document.exitPointerLock?.(); };
  applySetting('grain'); applySetting('master');

  const setView = (name) => {
    const v = VIEWS[name] || VIEWS.meadow;
    const y = terrain.heightAt(v.pos[0], v.pos[2]) + v.pos[1];
    engine.camera.position.set(v.pos[0], y, v.pos[2]);
    engine.camera.lookAt(v.look[0], v.look[1], v.look[2]);
  };

  // pointer lock <-> pause
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas && game.state === 'playing' && !AUTO) game.pause();
  });
  canvas.addEventListener('click', () => { if (game.state === 'playing' && document.pointerLockElement !== canvas && !AUTO) lock(); });
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
    ui.progress(1);
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
    last = now;
    step(dt);
    stats.frames++;
    if (now - stats.t0 >= 500) { stats.fps = (stats.frames * 1000) / (now - stats.t0); stats.frames = 0; stats.t0 = now; game.fps = stats.fps; }
  };
  requestAnimationFrame(frame);

  window.__vm = {
    engine, terrain, layout, world, game, ui, THREE, G, stats, setView, VIEWS, step,
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
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;color:#f88;background:#111;white-space:pre-wrap;font:13px system-ui;z-index:99';
  d.textContent = String((e && e.stack) || e);
  document.body.appendChild(d);
});
