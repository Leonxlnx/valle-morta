// The 45 second film: eight scripted shots rendered from the live game.
// Every shot starts from a clean, seeded state so it can be rendered on its
// own (the capture tool renders shot by shot and is resumable). First-person
// shots are played by a scripted shooter through the normal player, weapon
// and zombie code – nothing in them is faked.
import * as THREE from 'three';
import { G } from '../engine/shared.js';
import { mulberry32 } from '../core/noise.js';
import { Pass } from '../engine/pass.js';

const ADD_FS = /* glsl */`
uniform sampler2D tSrc;
uniform float uW;
out vec4 outColor;
void main() { outColor = vec4(texture(tSrc, vUv).rgb * uW, 1.0); }`;

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ease = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const JITTER = [[0, 0], [-0.33, -0.2], [0.33, -0.2], [0, 0.36]];

export function createFilm(vm) {
  const { engine, game, terrain, world, layout } = vm;
  const cam = engine.camera;
  const p = game.player, weapon = game.weapon, zombies = game.zombies;
  const gy = (x, z) => terrain.heightAt(x, z);
  const street = layout.streets[0];
  const road = layout.roads[1].path;
  const ch = layout.church;
  const tower = V(ch.towerX, gy(ch.towerX, ch.towerZ) + 15, ch.towerZ);
  const yawTo = (x0, z0, x1, z1) => Math.atan2(-(x1 - x0), -(z1 - z0));
  const _a = V(0, 0, 0), _b = V(0, 0, 0);

  // free camera: positions are [x, height above ground, z]
  const dolly = (a, b, look, fov) => (u) => {
    const k = ease(u);
    const x = a[0] + (b[0] - a[0]) * k, z = a[2] + (b[2] - a[2]) * k;
    cam.position.set(x, gy(x, z) + a[1] + (b[1] - a[1]) * k, z);
    cam.lookAt(look[0], look[1], look[2]);
    cam.fov = fov;
  };
  const onStreet = (s, lat, opts = {}) => { const q = street.at(s); return zombies.spawn(q[0] - q[3] * lat, q[1] + q[2] * lat, { aware: true, runner: false, ...opts }); };
  const onRoad = (s, lat, opts = {}) => { const q = road.at(s); return zombies.spawn(q[0] - q[3] * lat, q[1] + q[2] * lat, { aware: true, runner: false, ...opts }); };

  // scripted first-person shooter
  function shooter(cfg) {
    let target = null, burst = 0, pause = 0.2;
    const aim = V(0, 0, 0);
    return (dt, pl) => {
      const t = film.t;
      if (cfg.move) cfg.move(t, pl);
      if (!target || !target.alive) {
        target = null;
        let best = 1e9;
        for (const z of zombies.list) {
          if (!z.alive) continue;
          const d = z.pos.distanceTo(pl.pos);
          if (d < best) { best = d; target = z; }
        }
        pause = Math.max(pause, 0.26); burst = 0;
      }
      if (!target) { pl.lookAt(cfg.rest, 2.5, dt); return; }
      const head = target.bones && target.bones.Head;
      if (head && cfg.head && cfg.head(target)) { head.getWorldPosition(aim); aim.y += 0.05; } else aim.set(target.pos.x, target.pos.y + 1.24 * (target.scale || 1), target.pos.z);
      aim.x += target.vel.x * 0.07; aim.z += target.vel.z * 0.07;
      pl.lookAt(aim, cfg.aimRate || 8, dt);
      const dist = target.pos.distanceTo(pl.pos);
      pl.input.ads = cfg.ads ? cfg.ads(t, dist) : dist > 7;
      pl.forward(_a); _b.copy(aim).sub(pl.eye).normalize();
      const err = Math.acos(Math.min(1, _a.dot(_b)));
      pause -= dt;
      if (t >= (cfg.fireFrom || 0) && pause <= 0 && err < (dist < 6 ? 0.07 : 0.02)) {
        pl.input.fire = true;
        burst += dt;
        if (burst > (cfg.burst || 0.24)) { burst = 0; pause = cfg.gap || 0.34; }
      }
    };
  }

  const SHOTS = [
    { name: 'meadow', dur: 5.5, cam: dolly([-80, 1.15, 131], [-70, 2.05, 120], [38, 16, -90], 52) },
    { name: 'bridge', dur: 4.5, cam: dolly([-117, 5.3, 6], [-107, 4.3, -1], [40, 11, -80], 55) },
    { name: 'valley', dur: 4.0, cam: dolly([273, 4.6, -35], [263, 3.3, -44], [40, -8, -90], 50) },
    { name: 'tank', dur: 4.0, cam: dolly([131.5, 1.55, -2.5], [127.5, 1.35, -5.5], [60, 12, -100], 48) },
    {
      name: 'street', dur: 4.0, cam: dolly([-6.5, 1.55, -27], [-0.5, 1.7, -36], [44, 15, -96], 44),
      setup() {
        p.pos.set(-8, gy(-8, -26), -26);
        for (const [s, lat] of [[30, 0.6], [36, -0.9], [43, 0.2], [50, 1.0], [56, -0.5], [63, 0.4]]) onStreet(s, lat, { speed: 0.9 });
      },
    },
    {
      name: 'contact', dur: 11.0,
      setup() {
        p.spawn(-6.5, -31, yawTo(-6.5, -31, 9, -47)); p.enabled = true; weapon.visible = true;
        weapon.ammo = 30; weapon.reserve = 90;
        for (const [s, lat] of [[17, 0.5], [21, -1.0], [26, 0.9], [31, -0.3], [37, 0.8], [44, -0.7]]) onStreet(s, lat, { speed: 1.0 });
        this.spawned = false;
        p.script = shooter({
          rest: V(22, gy(22, -64) + 1.5, -64), fireFrom: 2.5, aimRate: 7, burst: 0.22, gap: 0.42,
          head: (z) => z.runner,
          ads: (t) => t > 1.9,
          move: (t, pl) => { if (t < 2.3) pl.input.fwd = 0.7; },
        });
      },
      pre(t) {
        if (!this.spawned && t > 5.5) { this.spawned = true; onStreet(38, 1.2, { runner: true }); onStreet(42, -1.2, { runner: true }); }
      },
    },
    {
      name: 'reload', dur: 7.0,
      setup() {
        p.spawn(1.5, -40, yawTo(1.5, -40, 22, -64)); p.enabled = true; weapon.visible = true;
        weapon.ammo = 5; weapon.reserve = 90;
        for (const [s, lat] of [[21, 0.4], [24, -0.9], [27, 1.0]]) onStreet(s, lat, { speed: 1.1 });
        for (const [s, lat] of [[33, 0.8], [37, -0.8], [42, 0.1]]) onStreet(s, lat, { runner: true });
        p.script = shooter({
          rest: V(22, gy(22, -64) + 1.4, -64), fireFrom: 0.25, aimRate: 10, burst: 0.5, gap: 0.16,
          head: (z) => z.runner && z.pos.distanceTo(p.pos) < 9,
          ads: () => false,
          move: (t, pl) => { if (t > 1.0 && t < 4.0) pl.input.fwd = -0.75; },
        });
      },
    },
    {
      name: 'horde', dur: 5.0,
      setup() {
        const q = road.at(4);
        p.pos.set(q[0], gy(q[0], q[1]), q[1]);
        let i = 0;
        for (let s = 34; s < 96; s += 3.6) { onRoad(s, ((i * 7) % 5 - 2) * 0.8, { runner: i % 3 === 2 && s > 50 }); i++; }
      },
      cam(u) {
        const k = ease(u);
        const q = road.at(27 - 5 * k);
        cam.position.set(q[0] + 1.2, gy(q[0], q[1]) + 0.95 + 0.5 * k, q[1] + 1.6);
        const r = road.at(64);
        cam.lookAt((r[0] + tower.x) * 0.5, gy(r[0], r[1]) + 5.5, (r[1] + tower.z) * 0.5);
        cam.fov = 40;
      },
    },
  ];
  let acc = 0;
  for (const s of SHOTS) { s.start = acc; acc += s.dur; }

  const film = { shots: SHOTS, fps: 24, sub: 3, t: 0, shot: null, target: null, total: acc, hdr: false };

  // quality overrides for the offline renderer, e.g. { msaa: 0, volScale: 3, shadow: 2048 }
  film.retune = (over = {}) => {
    Object.assign(engine.q, over);
    if (over.shadow) {
      engine.sun.shadow.mapSize.set(over.shadow, over.shadow);
      if (engine.sun.shadow.map) { engine.sun.shadow.map.dispose(); engine.sun.shadow.map = null; }
    }
    engine.renderScale = 1;
    engine.resize(engine.outW, engine.outH);
  };

  // average milliseconds per sub-frame: scene render, float read-back, 16-bit conversion
  film.bench = (n = 3) => {
    const gl = engine.gl, w = engine.rw, h = engine.rh, px = new Float32Array(4);
    let tr = 0, td = 0, tc = 0;
    for (let i = 0; i <= n; i++) {
      const t0 = performance.now();
      film.advance(1 / 72, true, JITTER[i % 3]);
      engine.renderer.setRenderTarget(film.target);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
      const t1 = performance.now();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, film.f32);
      engine.renderer.setRenderTarget(null);
      const t2 = performance.now();
      const src = film.f32, dst = film.u16, m = w * h;
      for (let k = 0, a = 0, b = 0; k < m; k++, a += 4, b += 3) { dst[b] = src[a] * 65535; dst[b + 1] = src[a + 1] * 65535; dst[b + 2] = src[a + 2] * 65535; }
      const t3 = performance.now();
      if (i > 0) { tr += t1 - t0; td += t2 - t1; tc += t3 - t2; }
    }
    return { render: Math.round(tr / n), read: Math.round(td / n), convert: Math.round(tc / n) };
  };

  film.prepare = (w, h, hdr, over = null) => {
    vm.stop();
    engine.syncSky = true;
    game.ui = null;
    if (w && h) {
      engine.q.msaa = Math.min(engine.q.msaa, 2);
      engine.renderScale = 1;
      engine.resize(w, h);
      if (over) film.retune(over);
    }
    film.hdr = !!hdr;
    const ps = engine.post.settings;
    if (hdr) {
      ps.mode = 3; ps.peak = 4.0; ps.paperWhite = 203;
      const rt = () => new THREE.WebGLRenderTarget(engine.rw, engine.rh, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      film.target = rt();   // one tone-mapped PQ sub-frame
      film.acc = rt();      // average of the sub-frames of one output frame
      film.addPass = new Pass(ADD_FS, { tSrc: { value: null }, uW: { value: 1 } }, { blending: THREE.AdditiveBlending });
      film.f32 = new Float32Array(engine.rw * engine.rh * 4);
      film.u16 = new Uint16Array(engine.rw * engine.rh * 3);
      film.yuv = new Uint16Array((engine.rw * engine.rh * 3) / 2);
    } else { ps.mode = 0; film.target = null; }
    return { w: engine.rw, h: engine.rh, shots: SHOTS.map((s) => ({ name: s.name, frames: Math.round(s.dur * film.fps) })) };
  };

  film.begin = (i) => {
    const s = SHOTS[i];
    film.shot = s; film.t = 0;
    Math.random = mulberry32(9000 + i * 131);
    game.state = 'film';
    zombies.clear();
    game.fx.n = 0;
    p.script = null; p.enabled = false; p.health = 100; p.alive = true;
    p.vel.set(0, 0, 0); p.recoilPitch = 0; p.recoilYaw = 0; p.shake = 0; p.landKick = 0; p.crouch = 0; p.adsT = 0;
    weapon.visible = false; weapon.reloading = false; weapon.cool = 0; weapon.burst = 0; weapon.kick = 0; weapon.kickRot = 0;
    engine.time = s.start;
    if (s.setup) s.setup();
    // settle animation / navigation before the first visible frame
    for (let k = 0; k < 8; k++) film.advance(0, false);
    film.t = 0; engine.time = s.start;
  };

  // one simulation step; `render` = false advances the world without drawing
  film.advance = (dt, render = true, jitter = null) => {
    const s = film.shot;
    film.t += dt;
    if (s.pre) s.pre(film.t, dt);
    game.update(dt);
    if (s.cam) s.cam(film.t / s.dur);
    // fade in at the very start of the film, fade out at its end
    const T = s.start + film.t;
    engine.post.settings.fade = Math.min(ease(T / 1.4), ease((film.total - T) / 1.6));
    if (jitter) {
      cam.setViewOffset(engine.outW, engine.outH, jitter[0], jitter[1], engine.outW, engine.outH);
      engine.weaponCamera.setViewOffset(engine.outW, engine.outH, jitter[0], jitter[1], engine.outW, engine.outH);
    } else { cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld(true);
    if (!render) { engine.time += dt; G.uTime.value = engine.time; return; }
    terrain.update(cam);
    for (const u of world.updaters) u(dt, cam, engine.time);
    engine.render(dt, film.target);
  };

  // Renders output frame f of the current shot: `sub` jittered sub-frames,
  // each read back as 16-bit PQ RGB and posted to the encoder.
  // The sub-frames are averaged on the GPU, read back once and converted here
  // to planar 10-bit BT.2020 Y'CbCr 4:2:0 (limited range), which the encoder
  // takes as is.
  film.frame = async (f, url) => {
    const dt = 1 / (film.fps * film.sub);
    const r = engine.renderer, gl = engine.gl, w = engine.rw, h = engine.rh;
    r.setRenderTarget(film.acc); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    film.addPass.uniforms.uW.value = 1 / film.sub;
    for (let k = 0; k < film.sub; k++) {
      film.advance(dt, true, JITTER[k % JITTER.length]);
      film.addPass.uniforms.tSrc.value = film.target.texture;
      film.addPass.render(r, film.acc);
    }
    r.setRenderTarget(film.acc);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, film.f32);
    r.setRenderTarget(null);
    const src = film.f32, out = film.yuv;
    const W2 = w >> 1, H2 = h >> 1, U0 = w * h, V0 = U0 + W2 * H2;
    for (let by = 0; by < H2; by++) {
      // GL rows run bottom-up, video rows top-down
      const g0 = (h - 1 - 2 * by) * w * 4, g1 = (h - 2 - 2 * by) * w * 4;
      const y0 = 2 * by * w, y1 = y0 + w;
      for (let bx = 0; bx < W2; bx++) {
        const x = 2 * bx, a = g0 + x * 4, b = g1 + x * 4;
        const r0 = src[a], G0 = src[a + 1], b0 = src[a + 2], r1 = src[a + 4], G1 = src[a + 5], b1 = src[a + 6];
        const r2 = src[b], G2 = src[b + 1], b2 = src[b + 2], r3 = src[b + 4], G3 = src[b + 5], b3 = src[b + 6];
        const Y0 = 0.2627 * r0 + 0.678 * G0 + 0.0593 * b0, Y1 = 0.2627 * r1 + 0.678 * G1 + 0.0593 * b1;
        const Y2 = 0.2627 * r2 + 0.678 * G2 + 0.0593 * b2, Y3 = 0.2627 * r3 + 0.678 * G3 + 0.0593 * b3;
        out[y0 + x] = 64.5 + 876 * (Y0 > 1 ? 1 : Y0); out[y0 + x + 1] = 64.5 + 876 * (Y1 > 1 ? 1 : Y1);
        out[y1 + x] = 64.5 + 876 * (Y2 > 1 ? 1 : Y2); out[y1 + x + 1] = 64.5 + 876 * (Y3 > 1 ? 1 : Y3);
        const cb = (b0 + b1 + b2 + b3 - Y0 - Y1 - Y2 - Y3) * 0.25 / 1.8814;
        const cr = (r0 + r1 + r2 + r3 - Y0 - Y1 - Y2 - Y3) * 0.25 / 1.4746;
        out[U0 + by * W2 + bx] = 512.5 + 896 * cb;
        out[V0 + by * W2 + bx] = 512.5 + 896 * cr;
      }
    }
    const res = await fetch(url, { method: 'POST', body: out });
    if (!res.ok) throw new Error('encoder refused frame');
    return true;
  };

  // SDR still of shot i at a fraction of its duration (for checking framing)
  film.still = (i, frac) => {
    film.begin(i);
    const dt = 1 / film.fps;
    const n = Math.max(1, Math.round(SHOTS[i].dur * frac * film.fps));
    for (let k = 0; k < n; k++) film.advance(dt, false);
    cam.clearViewOffset(); engine.weaponCamera.clearViewOffset();
    film.advance(dt, true);
    const z = zombies.list;
    return { shot: SHOTS[i].name, t: +film.t.toFixed(2), zombies: z.length, alive: z.filter((q) => q.alive).length, ammo: weapon.ammo, health: Math.round(p.health) };
  };

  return film;
}
