// Tape test: a short scripted game session in headless Chrome (dev server on :5183)
// that exercises the sound tape (audio.startTape / stopTape) and writes the events in
// the film contract's shape, for the mixer to be tried before the film exists.
//   node cinematic/audio/tape-test.mjs [--out cinematic/out/test_events.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireGpuLock } from '../../tools/lib/gpulock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const out = arg('out', 'cinematic/out/test_events.json');
const url = arg('url', 'http://127.0.0.1:5183/');
const release = await acquireGpuLock(4 * 3600e3);   // wait for the GPU however long it takes; never run beside another GPU job
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', protocolTimeout: 600000,
  userDataDir: path.join(os.tmpdir(), 'vm-chrome-profile-tape'),
  defaultViewport: { width: 640, height: 360, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=640,360', '--mute-audio'],
});
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await page.evaluateOnNewDocument(() => { const W = window.WebSocket; window.WebSocket = function (u, p) { if (String(p).includes('vite')) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 0 }; return new W(u, p); }; });
  await page.goto(`${url}?q=low&auto=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__vm && window.__vm.ready', { timeout: 520000, polling: 500 });
  const res = await page.evaluate(async () => {
    const vm = window.__vm, g = vm.game, p = g.player, Z = g.zombies, T = vm.THREE, w = g.weapon, A = g.audio;
    vm.stop();
    if (g.state !== 'playing' || !p.alive) g.start();
    Z.clear(); g.interT = 1e9; g.queue = 0; g.queueList = []; g.cleared = true;
    p.spawn(-58, 96, -0.55); p.enabled = true; w.reset();
    await A.preload?.();
    let t = 0;
    const I = { fire: false, rapid: false, n: 0, reload: false, slot: 0, aim: null };
    p.script = (dt, pl) => { if (I.aim) pl.lookAt(I.aim, 999, dt); pl.input.fire = I.fire || (I.rapid && (I.n++ % 8) < 2); pl.input.reload = I.reload; if (I.slot) { pl.input.slot = I.slot; I.slot = 0; } };
    const sim = (sec, each) => { const dt = 1 / 60; for (let i = 0, n = Math.round(sec / dt); i < n; i++) { g.update(dt); t += dt; p.health = p.maxHealth; each?.(); } };
    const ahead = (d, side = 0) => { const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw); return new T.Vector3(p.pos.x + fx * d - fz * side, p.pos.y + 1.2, p.pos.z + fz * d + fx * side); };
    sim(0.3);
    I.aim = ahead(30, 3);
    const shots = [];
    // shot 1: rifle burst, reload, a second burst
    t = 0; A.startTape(() => t);
    sim(0.5); I.fire = true; sim(1.2); I.fire = false; sim(0.3);
    w.ammo = Math.min(w.ammo, 3); I.reload = true; sim(0.05); I.reload = false; sim(3.2);
    I.fire = true; sim(0.6); I.fire = false; sim(0.4);
    shots.push({ name: 'test_rifle', duration: +t.toFixed(4), ...A.stopTape() });
    // shot 2: pistol, a helicopter loop passing (test of the loop/position path), an infected attacks
    t = 0; A.startTape(() => t);
    I.slot = 2; sim(1.0);
    A.loop('heli_loop', 0.0001, 0.4);
    const z = Z.spawn(p.pos.x - Math.sin(p.yaw) * 7, p.pos.z - Math.cos(p.yaw) * 7, { runner: true, yaw: p.yaw + Math.PI });
    let k = 0;
    const heli = () => { const a = -1 + (k++ / 60) * 0.25; const hp = ahead(40 * Math.cos(a), 60 * Math.sin(a)); hp.y += 25; A.setLoopVolume('heli_loop', Math.min(0.85, 1.15 / (1 + Math.pow(hp.distanceTo(p.pos) / 24, 1.7))), 0.25); A.setLoopPos('heli_loop', hp); };
    I.aim = null; sim(2.5, heli);
    I.aim = ahead(20, -2); I.rapid = true; sim(1.6, heli); I.rapid = false; sim(1.2, heli);
    shots.push({ name: 'test_pistol_heli', duration: +t.toFixed(4), ...A.stopTape(), zombieAlive: !!z?.alive });
    A.stopLoop('heli_loop', 0.5);
    return { shots, ctx: A.ctx ? A.ctx.state : 'none', weapon: w.id };
  });
  let start = 0;
  const film = { fps: 30, shots: res.shots.map((s) => { const r = { name: s.name, start: +start.toFixed(4), duration: s.duration, events: s.events }; start += s.duration; return r; }) };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(film));
  const count = (ev) => Object.entries(ev.filter((e) => e.name).reduce((m, e) => ((m[e.name] = (m[e.name] || 0) + 1), m), {})).map(([k, v]) => `${k}:${v}`).join(' ');
  for (const s of film.shots) console.log(`${s.name} ${s.duration}s events=${s.events.length} starts: ${count(s.events)} | updates=${s.events.filter((e) => !e.name).length}`);
  console.log(`ctx=${res.ctx} weapon=${res.weapon} errors=${errs.length} ${errs.slice(0, 2).join(' | ')}`);
  console.log('sample:', JSON.stringify(film.shots[1].events.find((e) => e.pos && e.name)), JSON.stringify(film.shots[1].events.find((e) => e.pos && !e.name)));
} finally {
  await browser.close();
  release();
}
