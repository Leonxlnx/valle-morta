// The 45 second film: eight scripted shots rendered from the live game.
// Every shot starts from a clean, seeded state so it can be rendered on its
// own (the capture tool renders shot by shot and is resumable). First-person
// shots are played by a scripted shooter through the normal player, weapon
// and zombie code – nothing in them is faked.
import * as THREE from 'three';
import { G } from '../engine/shared.js';
import { mulberry32 } from '../core/noise.js';

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

  film.prepare = (w, h, hdr) => {
    vm.stop();
    engine.syncSky = true;
    game.ui = null;
    if (w && h) {
      engine.q.msaa = Math.min(engine.q.msaa, 2);
      engine.renderScale = 1;
      engine.resize(w, h);
    }
    film.hdr = !!hdr;
    const ps = engine.post.settings;
    if (hdr) {
      ps.mode = 3; ps.peak = 4.0; ps.paperWhite = 203;
      film.target = new THREE.WebGLRenderTarget(engine.rw, engine.rh, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
      film.f32 = new Float32Array(engine.rw * engine.rh * 4);
      film.u16 = new Uint16Array(engine.rw * engine.rh * 3);
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
  film.frame = async (f, url) => {
    const dt = 1 / (film.fps * film.sub);
    const gl = engine.gl, w = engine.rw, h = engine.rh;
    for (let k = 0; k < film.sub; k++) {
      film.advance(dt, true, JITTER[k % JITTER.length]);
      engine.renderer.setRenderTarget(film.target);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, film.f32);
      engine.renderer.setRenderTarget(null);
      const src = film.f32, dst = film.u16, n = w * h;
      for (let i = 0, a = 0, b = 0; i < n; i++, a += 4, b += 3) {
        const r = src[a] * 65535 + 0.5, g = src[a + 1] * 65535 + 0.5, bl = src[a + 2] * 65535 + 0.5;
        dst[b] = r > 65535 ? 65535 : r; dst[b + 1] = g > 65535 ? 65535 : g; dst[b + 2] = bl > 65535 ? 65535 : bl;
      }
      const res = await fetch(url, { method: 'POST', body: dst });
      if (!res.ok) throw new Error('encoder refused frame');
    }
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
