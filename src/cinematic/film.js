// The 45 second film: ten scripted shots rendered from the live game.
// Every shot starts from a clean, seeded state so it can be rendered on its
// own (the capture tool renders shot by shot and is resumable). A shot may
// pre-roll (`warm` seconds simulated before its first frame) so nothing looks
// frozen at the cut. First-person shots are played by a scripted shooter through
// the normal player, weapon and zombie code; the helicopter, the mortar and the
// tank run through the Operation code (Helicopter.arrive / depart, useAbility).
import * as THREE from 'three';
import { G } from '../engine/shared.js';
import { mulberry32 } from '../core/noise.js';
import { Pass } from '../engine/pass.js';
import { Abilities } from '../game/abilities.js';
import { Helicopter } from '../game/operation.js';
import { abilityItem, SLOT_KEYS } from '../game/progress.js';

const ADD_FS = /* glsl */`
uniform sampler2D tSrc;
uniform float uW;
out vec4 outColor;
void main() { outColor = vec4(texture(tSrc, vUv).rgb * uW, 1.0); }`;

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ease = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const TAU = Math.PI * 2;
const JITTER = [[0, 0], [-0.33, -0.2], [0.33, -0.2], [0, 0.36]];

export function createFilm(vm) {
  const { engine, game, terrain, world, layout } = vm;
  const cam = engine.camera;
  const p = game.player, weapon = game.weapon, zombies = game.zombies, col = game.collision, op = game.operation;
  const gy = (x, z) => terrain.heightAt(x, z);
  const street = layout.streets[0];               // main street: road (s 0) up to the church square (s ~77)
  const yawTo = (x0, z0, x1, z1) => Math.atan2(-(x1 - x0), -(z1 - z0));
  const _a = V(0, 0, 0), _b = V(0, 0, 0), _c = V(0, 0, 0), _q = {};
  let LZ = null;                                   // the square landing zone

  // ---- places
  const sx = (s, lat = 0) => { const q = street.at(s); return [q[0] - q[3] * lat, q[1] + q[2] * lat]; };
  const sp = (s, lat = 0, h = 0) => { const [x, z] = sx(s, lat); return V(x, gy(x, z) + h, z); };
  const free = (x, z, r = 0.5) => zombies.flow.walkable(x, z) && col.resolveCapsule(_c.set(x, gy(x, z) + 0.05, z), r, 1.8).lengthSq() < 1e-8;
  // nearest open ground (outside buildings) round a point
  const _hit = { point: V(0, 0, 0), normal: V(0, 0, 0) }, UP = V(0, 1, 0);
  const sky = (x, z) => !col.raycastMesh(V(x, gy(x, z) + 1.2, z), UP, 40, _hit);
  const spot = (x, z, r = 0.6, open = false) => {
    for (let ring = 0; ring < 14; ring++) {
      const n = Math.max(1, ring * 6);
      for (let k = 0; k < n; k++) { const a = (k / n) * TAU, xx = x + Math.cos(a) * ring * 0.7, zz = z + Math.sin(a) * ring * 0.7; if (free(xx, zz, r) && (!open || sky(xx, zz))) return [xx, zz]; }
    }
    return [x, z];
  };
  const spawnAt = (x, z, opts = {}) => zombies.spawn(x, z, { aware: true, type: 'walker', ...opts });
  const onStreet = (s, lat, opts = {}) => { const [x, z] = sx(s, lat); return spawnAt(x, z, opts); };

  // ---- the gun in hand, ready, with no animation running
  function arm(id, ammo) {
    const w = weapon;
    if (w.view) { w.view.scene.visible = false; if (w.view.flash) w.view.flash.visible = false; }
    w.id = id;
    if (w.view) w.view.scene.visible = true;
    const st = w.st;
    st.owned = true; st.needBolt = false; st.ammo = ammo ?? st.def.mag + st.mod.mag;
    if (Number.isFinite(st.reserve)) st.reserve = Math.max(st.reserve, 60);
    w.act = null; w.pending = null; w.cool = 0; w.trigBuf = 0; w.shotIdx = 0; w.bloom = 0; w.heat = 0; w.sinceShot = 9; w.shellAt = -1;
    w.scopeT = 0; w.scoped = false; w.bipodT = 0; w.bipodHold = 0; w.bipod = false; w.adsK = 0; w.lowerT = 0; w.sprintT = 0;
    w.visible = true;
  }

  // ---- Operation pieces: abilities fitted as in Operation.begin, ticked by the film (the run is not live)
  function equip(keys, level = 3) {
    op.phase = 'run';
    op.abilities = keys.map((key, slot) => {
      const item = abilityItem(key), a = item.ability, i = level - 1, params = {};
      for (const k in a.params) params[k] = Array.isArray(a.params[k]) ? a.params[k][i] : a.params[k];
      return { id: key, slot, key: SLOT_KEYS[slot], name: item.name, short: a.short, level, cooldown: a.cooldown[i], duration: a.duration[i], params, cd: 0, active: 0, ready: true, uses: 0 };
    });
    film.op = true;
  }
  const use = (key) => op.useAbility(op.abilities.findIndex((a) => a.id === key));
  // the helicopter on its approach to the square, `k` of the way in
  function heliIn(k) {
    const h = op.heli;
    h.arrive(LZ); h.inside = false; h.t = k; h._place(1 - k);
    film.op = true;
    return h;
  }
  // where the helicopter is when it is `k` of the way in
  const heliAt = (k) => { const h = op.heli, t = h.t; h._place(1 - k); const v = h.group.position.clone(); h._place(1 - t); return v; };

  // smoothed look target for tracking shots (state lives on the shot, reset in setup)
  const track = (o, x, y, z, rate, dt) => {
    if (!o.look) o.look = V(x, y, z); else o.look.lerp(_a.set(x, y, z), 1 - Math.exp(-rate * dt));
    return o.look;
  };
  const place = (x, h, z) => cam.position.set(x, gy(x, z) + h, z);

  // ---- scripted first-person shooter
  function shooter(cfg) {
    let target = null, burst = 0, pause = 0.2;
    const aim = V(0, 0, 0);
    const aimAt = (z) => {
      const head = z.bones && z.bones.Head;
      if (head && cfg.head && cfg.head(z)) { head.getWorldPosition(aim); aim.y += 0.05; } else aim.set(z.pos.x, z.pos.y + 1.24 * (z.scale || 1), z.pos.z);
      aim.x += z.vel.x * 0.07; aim.z += z.vel.z * 0.07;
      return aim;
    };
    const seen = (z) => !cfg.los || col.lineOfSight(p.eye, aimAt(z));
    return (dt, pl) => {
      const t = film.t;
      if (cfg.move) cfg.move(t, pl);
      if (t < (cfg.from ?? -1e9)) { pl.lookAt(cfg.rest, cfg.restRate || 2.2, dt); pl.input.ads = cfg.ads ? cfg.ads(t, 99) : false; return; }
      if (!target || !target.alive || (cfg.los && !seen(target))) {
        target = null;
        let best = 1e9;
        for (const z of zombies.list) {
          if (!z.alive || !seen(z)) continue;
          const d = z.pos.distanceTo(pl.pos);
          if (d < best && d < (cfg.reach || 90)) { best = d; target = z; }
        }
        pause = Math.max(pause, cfg.settle ?? 0.26); burst = 0;
      }
      if (!target) { pl.lookAt(cfg.rest, cfg.restRate || 2.5, dt); pl.input.ads = cfg.ads ? cfg.ads(t, 99) : false; return; }
      aimAt(target);
      pl.lookAt(aim, cfg.aimRate || 8, dt);
      const dist = target.pos.distanceTo(pl.pos);
      pl.input.ads = cfg.ads ? cfg.ads(t, dist) : dist > 7;
      pl.forward(_a); _b.copy(aim).sub(pl.eye).normalize();
      const err = Math.acos(Math.min(1, _a.dot(_b)));
      pause -= dt;
      if (t >= (cfg.fireFrom || 0) && pause <= 0 && err < (dist < 6 ? 0.08 : 0.022)) {
        pl.input.fire = true;
        burst += dt;
        if (burst > (cfg.burst || 0.24)) { burst = 0; pause = cfg.gap || 0.34; }
      }
    };
  }

  // the doorway of a house: the run of perimeter points seen from inside, on the wall nearest the street
  function doorOf(b) {
    const c = Math.cos(b.rot), s = Math.sin(b.rot), y = b.baseY + 0.75;
    const W = (lx, lz) => [b.x + lx * c - lz * s, b.z + lx * s + lz * c];
    const from = V(b.x, y, b.z), walls = [[], [], [], []];
    for (let wi = 0; wi < 4; wi++) {
      const alongX = wi < 2, L = alongX ? b.w : b.d, off = (alongX ? b.d : b.w) / 2 + 0.5, sg = wi % 2 ? -1 : 1;
      for (let u = -L / 2 + 0.3; u <= L / 2 - 0.3; u += 0.2) {
        const [x, z] = alongX ? W(u, sg * off) : W(sg * off, u);
        if (col.lineOfSight(from, _b.set(x, y, z))) walls[wi].push([x, z]);
      }
    }
    let best = null, bd = 1e9;
    walls.forEach((pts, wi) => {
      if (pts.length < 2) return;
      const m = pts.reduce((a, q) => [a[0] + q[0] / pts.length, a[1] + q[1] / pts.length], [0, 0]);
      const d = street.query(m[0], m[1], _q).d;
      if (d < bd) { bd = d; best = { x: m[0], z: m[1], wi }; }
    });
    if (!best) return null;
    const alongX = best.wi < 2, sg = best.wi % 2 ? -1 : 1;
    best.nx = alongX ? -s * sg : c * sg; best.nz = alongX ? c * sg : s * sg;     // outward
    best.depth = alongX ? b.d : b.w;
    return best;
  }

  const SHOTS = [
    {
      // 1. the helicopter comes in low over the rooftops, seen from the street below
      name: 'insert', dur: 4.5,
      setup() {
        const k0 = 0.3, h = heliIn(k0);
        const s0 = heliAt(k0), s1 = heliAt(0.86);
        const dx = s0.x - LZ.x, dz = s0.z - LZ.z, l = Math.hypot(dx, dz), ux = dx / l, uz = dz / l;
        const [x, z] = spot(LZ.x - ux * 15 + uz * 3, LZ.z - uz * 15 - ux * 3, 1.2, true); void s1;
        this.c = [x, z, ux, uz]; this.look = null;
        p.spawn(LZ.x + 30, LZ.z, 0);
        void h;
      },
      cam(u, dt) {
        const [x, z, ux, uz] = this.c, h = op.heli.group.position, k = ease(u);
        place(x - ux * 1.5 * k, 1.2 + 0.3 * k, z - uz * 1.5 * k);
        cam.lookAt(track(this, h.x, h.y + 0.6, h.z, 3, dt));
        cam.fov = 44 - 4 * k;
      },
    },
    {
      // 2. out of the open door: the village slides by, the skids touch down in the square
      name: 'door', dur: 3.0,
      setup() { heliIn(0.46); p.spawn(LZ.x + 30, LZ.z, 0); op.heli.inside = true; },
      cam() { op.heli.seatPose(cam.position, cam.quaternion); cam.fov = 64; },
    },
    {
      // 3. boots on the ground: down the main street between the terraces, rifle up, first contact
      name: 'street', dur: 4.5, warm: 0.4,
      setup() {
        const [x, z] = sx(14, 0.4), [x1, z1] = sx(36, 0);
        p.spawn(x, z, yawTo(x, z, x1, z1) + 0.6); p.enabled = true;
        arm('rifle', 30);
        for (const [s, lat] of [[32, 0.9], [35, -0.8], [30, -0.2], [38, 0.4], [41, -0.5]]) onStreet(s, lat, { speed: 1.0 });
        p.script = shooter({
          rest: sp(40, 0, 1.5), from: 1.7, restRate: 1.8, fireFrom: 2.5, aimRate: 6, burst: 0.2, gap: 0.38,
          ads: (t) => t > 1.1,
          move: (t, pl) => { pl.input.fwd = t < 2.4 ? 0.62 : 0.15; },
        });
      },
    },
    {
      // 4. rifle contact: bursts, recoil and brass until the magazine runs dry, the change on camera, runners at the end
      name: 'reload', dur: 5.0, warm: 0.25,
      setup() {
        const [x, z] = sx(30, 0.5), [x1, z1] = sx(52, 0);
        p.spawn(x, z, yawTo(x, z, x1, z1)); p.enabled = true;
        arm('rifle', 9);
        for (const [s, lat] of [[45, 0.9], [48, -0.7], [42, 0.1]]) onStreet(s, lat, { speed: 1.1 });
        for (const [s, lat] of [[58, 0.3], [61, -0.9]]) onStreet(s, lat, { type: 'runner' });
        p.script = shooter({
          rest: sp(52, 0, 1.4), fireFrom: 0.05, aimRate: 9, burst: 0.26, gap: 0.22,
          head: (zb) => zb.type === 'runner' && zb.pos.distanceTo(p.pos) < 10,
          ads: (t, d) => d > 7 && !weapon.act,
          move: (t, pl) => { if (t > 1.4 && t < 3.6) pl.input.fwd = -0.5; },
        });
      },
    },
    {
      // 5. close quarters inside a terraced house: the pistol, the doorway, runners bursting in
      name: 'house', dur: 4.5, warm: 0.2,
      setup() {
        const b = layout.buildings.find((q) => q.id === 'terraceB') || layout.buildings.find((q) => q.enterable && q.terrace);
        const d = doorOf(b);
        this.door = d;
        const bk = d.depth - 1.4, px = d.x - d.nx * bk + d.nz * 0.7, pz = d.z - d.nz * bk - d.nx * 0.7;
        p.spawn(px, pz, yawTo(px, pz, d.x, d.z)); p.enabled = true;
        p.pos.y = col.floorAt(px, b.baseY + 1.6, pz, 3);
        arm('pistol', 15);
        const out = (o, l) => [d.x + d.nx * o + d.nz * l, d.z + d.nz * o - d.nx * l];
        this.r1 = out(1.4, 0.3);
        const w1 = spot(...out(4.5, -8));
        spawnAt(w1[0], w1[1], { speed: 1.2 });
        this.r2 = out(2.2, -0.4);
        this.done = false; this.d1 = false;
        p.script = shooter({
          rest: V(d.x, b.baseY + 1.45, d.z), los: false, fireFrom: 0, aimRate: 14, burst: 0.02, gap: 0.13, settle: 0.12, reach: 14,
          ads: (t, dist) => dist > 4 && dist < 20,
        });
      },
      pre(t) {
        if (!this.d1 && t > 0.35) { this.d1 = true; spawnAt(this.r1[0], this.r1[1], { type: 'runner', yaw: yawTo(this.r1[0], this.r1[1], p.pos.x, p.pos.z) }); }
        if (!this.done && t > 1.7) { this.done = true; spawnAt(this.r2[0], this.r2[1], { type: 'runner', yaw: yawTo(this.r2[0], this.r2[1], p.pos.x, p.pos.z) }); }
      },
    },
    {
      // 6. the sniper: prone on the church steps, bipod down, the scope up, one round through two of them, the bolt
      name: 'sniper', dur: 5.5, warm: 1.8,
      setup() {
        const [x, z] = spot(...sx(79, 0.3), 0.45);
        const T = sp(50, 0);
        const yaw = yawTo(x, z, T.x, T.z), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        p.spawn(x, z, yaw); p.enabled = true; p.proneWanted = true;
        arm('sniper', 5);
        const D = Math.hypot(T.x - x, T.z - z) - 2;
        const z1 = spawnAt(x + fx * D, z + fz * D, { speed: 0.9, yaw: yaw }), z2 = spawnAt(x + fx * (D + 2.3), z + fz * (D + 2.3), { speed: 0.9, yaw: yaw });
        const [x3, z3] = sx(44, 1.1);
        const z3b = spawnAt(x3, z3, { speed: 1.1 });
        this.t1 = z1; this.t2 = z2; this.t3 = z3b;
        const aim = V(0, 0, 0);
        p.script = (dt, pl) => {
          const t = film.t, tg = t < 2.6 ? this.t1 : this.t3;
          aim.set(tg.pos.x + tg.vel.x * 0.1, tg.pos.y + 1.3, tg.pos.z + tg.vel.z * 0.1);
          if (!tg.alive && t < 2.6) aim.set(this.t2.pos.x, this.t2.pos.y + 1.2, this.t2.pos.z);
          pl.lookAt(aim, t < 0 ? 4 : 7, dt);
          pl.input.ads = (t > 0.45 && t < 2.15) || (t > 3.4 && t < 5.3);
          pl.input.fire = (t >= 1.95 && t < 2.0) || (t >= 4.65 && t < 4.7);
        };
      },
    },
    {
      // 7. the brute walks into the square, then the boss: roar, charge, slam, with the camera low on the cobbles
      name: 'boss', dur: 5.0, warm: 0.6,
      setup() {
        const [x, z] = spot(48.5, -95.5);
        const T = sp(70, 0), d = Math.hypot(T.x - x, T.z - z), ux = (T.x - x) / d, uz = (T.z - z) / d;
        p.spawn(x, z, yawTo(x, z, T.x, T.z));
        this.boss = spawnAt(x + ux * 12.5, z + uz * 12.5, { type: 'boss', yaw: yawTo(T.x, T.z, x, z) });
        this.boss.chargeCd = 99;
        const br = spot(x + ux * 9 - uz * 3, z + uz * 9 + ux * 3);
        spawnAt(br[0], br[1], { type: 'brute' });
        const c = spot(x - uz * 3.4 - ux * 2.2, z + ux * 3.4 - uz * 2.2);
        this.c = c; this.u = [ux, uz]; this.look = null; this.go = false;
      },
      pre(t) {
        p.health = 100; p.alive = true;
        const b = this.boss;
        if (!this.go && t >= -0.5) { this.go = true; b.chargeCd = 0; }
        // the charge spent, it turns on the spot and pounds the ground
        if (this.prev === 'charge' && b.state !== 'charge' && b.alive) { b.state = 'idle'; b.stateT = 0; b.slamCd = 0; b.recoverT = 0; }
        this.prev = b.state;
      },
      cam(u, dt) {
        const [x, z] = this.c, [ux, uz] = this.u, k = ease(u), b = this.boss.pos;
        place(x - ux * 0.8 * k, 0.5 + 0.1 * k, z - uz * 0.8 * k);
        cam.lookAt(track(this, b.x, b.y + 1.9, b.z, 5, dt));
        cam.fov = 50;
      },
    },
    {
      // 8. the answer: the mortar barrage lands among them in the street, the tank comes down under its chutes into the square
      name: 'answer', dur: 4.5, warm: 1.6,
      setup() {
        const [x, z] = spot(51, -97);
        const M = sp(60, 0, 0);
        p.spawn(x, z, yawTo(x, z, M.x, M.z)); p.enabled = true; weapon.visible = false;
        equip(['mortar', 'tank']);
        let i = 0;
        for (let s = 53; s < 70; s += 2.1) { onStreet(s, ((i * 7) % 5 - 2) * 0.7, { speed: 1.0 + (i % 3) * 0.1 }); i++; }
        onStreet(57, 0.4, { type: 'brute' });
        p.script = (dt, pl) => { pl.lookAt(M, 999, dt); };
        this.m = false; this.t = false; this.look = null;
        const c = spot(...sx(43, 0.7));
        this.c = c;
      },
      pre(t) {
        p.health = 100;
        if (!this.m && t >= -1.45) { this.m = true; use('mortar'); }
        if (!this.t && t >= -0.15) { this.t = true; use('tank'); weapon.visible = false; }
      },
      cam(u) {
        const [x, z] = this.c, k = ease(u), q = sx(78, 0);
        place(x + (q[0] - x) * 0.06 * k, 1.25, z + (q[1] - z) * 0.06 * k);
        cam.lookAt(q[0], gy(q[0], q[1]) + 7.5, q[1]);
        cam.fov = 54;
      },
    },
    {
      // 9. the drive: down the main street from the commander's hatch, running them over, the main gun on the boss
      name: 'drive', dur: 5.0, warm: 3.9,
      setup() {
        const [x, z] = sx(77, 0), [x1, z1] = sx(60, 0);
        p.spawn(x, z, yawTo(x, z, x1, z1)); p.enabled = true; weapon.visible = false;
        equip(['tank']);
        for (const [s, lat] of [[52, 0.3], [49, -0.5], [45, 0.6], [41, -0.2], [37, 0.8]]) onStreet(s, lat, { speed: 0.8 });
        this.boss = onStreet(24, 0, { type: 'boss' }); this.boss.chargeCd = 99;
        this.used = false;
        const look = V(0, 0, 0);
        p.script = (dt, pl) => {
          const t = film.t, tk = pl.vehicle;
          if (!tk) return;
          const s = street.query(tk.pos.x, tk.pos.z, _q).s, [ax, az] = sx(Math.max(2, s - 9), 0);
          const diff = wrap(yawTo(tk.pos.x, tk.pos.z, ax, az) - tk.yaw);
          pl.input.fwd = t > -0.4 ? (t > 2.0 && t < 2.9 ? 0.45 : 1) : 0;
          pl.input.strafe = clamp(-diff * 2.6, -1, 1);
          const b = this.boss;
          if (b.alive && t > 0.6) look.set(b.pos.x, b.pos.y + 1.6, b.pos.z);
          else { const [lx, lz] = sx(Math.max(2, s - 16), 0); look.set(lx, gy(lx, lz) + 1.3, lz); }
          pl.lookAt(look, 3.2, dt);
          pl.input.fire = b.alive && t > 1.2 && b.pos.distanceTo(tk.pos) < 24;
        };
      },
      pre(t) {
        p.health = 100;
        if (!this.used && t >= -3.85) { this.used = true; use('tank'); }
        if (t >= 0.4 && this.boss.chargeCd > 50) this.boss.chargeCd = 0;
      },
    },
    {
      // 10. quiet end: the helicopter lifts off from the square past the church tower
      name: 'leave', dur: 3.5, warm: 0.8,
      setup() {
        const h = heliIn(0.999);
        h.update(0.05);
        const [x, z] = spot(...sx(64, -0.6));
        this.c = [x, z]; this.look = null; this.gone = false;
        p.spawn(x, z, 0);
      },
      pre(t) { if (!this.gone && t >= -0.15) { this.gone = true; op.heli.depart(); } },
      cam(u, dt) {
        const [x, z] = this.c, k = ease(u), h = op.heli.group.position;
        place(x, 0.9 + 0.5 * k, z);
        cam.lookAt(track(this, h.x * 0.55 + LZ.x * 0.45, Math.min(h.y * 0.55 + (LZ.y + 4) * 0.45, LZ.y + 11), h.z * 0.55 + LZ.z * 0.45, 2.5, dt));
        cam.fov = 55;
      },
    },
  ];
  let acc = 0;
  for (const s of SHOTS) { s.start = acc; acc += s.dur; }

  const film = { shots: SHOTS, fps: 24, sub: 3, t: 0, shot: null, target: null, total: acc, hdr: false, op: false };

  // the Operation pieces the film uses, made once with a fixed seed
  function init() {
    if (LZ) return;
    const r = Math.random;
    Math.random = mulberry32(4711);
    if (!op.kit) op.kit = new Abilities(op);
    if (!op.heli) op.heli = new Helicopter(game);
    const lzs = op._lzs();
    LZ = lzs.find((l) => l.id === 'square') || lzs[0];
    Math.random = r;
  }

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
    init();
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

  // nothing of an earlier shot stays: Operation pieces, blood, particles
  function resetWorld() {
    if (op.kit) op.kit.clear();
    if (op.kit) { op.kit.time = 0; op.kit.lastWhistle = -9; op.kit.stats.crushed = 0; op.kit.stats.blastKills = 0; op.kit.stats.blastHits = 0; }
    if (op.heli) { op.heli.hide(); op.heli.time = 0; op.heli.washT = 0; }
    op.phase = 'idle'; op.abilities = []; film.op = false;
    game.timeScale = 1; p.vehicle = null;
    const fx = game.fx;
    fx.rnd = Math.random; fx.n = 0;
    fx.splatI = 0; if (fx.splats) fx.splats.count = 0;
    fx.poolI = 0; if (fx.poolMesh) fx.poolMesh.count = 0; if (fx.wetMesh) fx.wetMesh.count = 0;
    if (fx.pools) for (const q of fx.pools) q.done = true;
  }

  film.begin = (i) => {
    const s = SHOTS[i];
    init();
    film.shot = s;
    Math.random = mulberry32(9000 + i * 131);
    game.state = 'film';
    zombies.clear(); zombies.passive = false;
    resetWorld();
    p.script = null; p.enabled = false; p.health = 100; p.alive = true; p.proneWanted = false;
    p.vel.set(0, 0, 0); p.recoilPitch = 0; p.recoilYaw = 0; p.shake = 0; p.landKick = 0; p.crouch = 0; p.adsT = 0;
    weapon.reset();
    weapon.visible = false; weapon.cool = 0; weapon.burst = 0; weapon.kick = 0; weapon.kickRot = 0;
    const warm = s.warm || 0;
    film.t = -warm; engine.time = s.start - warm;
    if (s.setup) s.setup();
    // settle animation / navigation, then pre-roll so the action is already moving at the cut
    for (let k = 0; k < 8; k++) film.advance(0, false);
    const n = Math.round(warm * film.fps);
    for (let k = 0; k < n; k++) film.advance(1 / film.fps, false);
    film.t = 0; engine.time = s.start;
  };

  // one simulation step; `render` = false advances the world without drawing
  film.advance = (dt, render = true, jitter = null) => {
    const s = film.shot;
    film.t += dt;
    if (s.pre) s.pre(film.t, dt);
    game.update(dt);
    if (film.op) {
      if (op.heli && op.heli.state !== 'gone') op.heli.update(dt);
      op.kit.update(dt);
      if (op.phase === 'run') op._abilities(dt);
    }
    if (s.cam) s.cam(Math.max(0, film.t) / s.dur, dt);
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

  // SDR still of shot i at a fraction of its duration (for checking framing), with the state that matters
  film.still = (i, frac) => {
    film.begin(i);
    const dt = 1 / film.fps;
    const n = Math.max(1, Math.round(SHOTS[i].dur * frac * film.fps));
    for (let k = 0; k < n; k++) film.advance(dt, false);
    cam.clearViewOffset(); engine.weaponCamera.clearViewOffset();
    film.advance(dt, true);
    const z = zombies.list, r1 = (v) => Math.round(v * 10) / 10;
    const boss = z.find((q) => q.def && q.def.boss), tk = op.kit && op.kit.tanks[0], h = op.heli;
    const out = {
      shot: SHOTS[i].name, t: +film.t.toFixed(2), alive: z.filter((q) => q.alive).length, dead: z.filter((q) => !q.alive).length,
      wpn: weapon.visible ? `${weapon.id}${weapon.act ? ':' + weapon.act.name : ''} ${weapon.st.ammo}${weapon.scoped ? ' scoped' : ''}${weapon.bipod ? ' bipod' : ''}` : '-',
      stance: p.stance, hp: Math.round(p.health), cam: [r1(cam.position.x), r1(cam.position.y - gy(cam.position.x, cam.position.z)), r1(cam.position.z)],
    };
    if (boss) out.boss = `${Math.round(boss.health)} ${boss.state} d${r1(boss.pos.distanceTo(p.pos))}`;
    if (tk) out.tank = `${tk.state} v${r1(tk.v)} y${r1(tk.pos.y - tk.ground)} crushed${op.kit.stats.crushed} shots${tk.shots}`;
    if (film.op && op.kit) out.blasts = `${op.kit.shells.length} pending, ${op.kit.stats.blastKills} kills`;
    if (h && h.state !== 'gone') out.heli = `${h.state} t${h.t.toFixed(2)} alt${r1(h.group.position.y - LZ.y)} d${r1(h.group.position.distanceTo(cam.position))}`;
    if (i === 0 && frac < 0.5) { const sd = engine.sun.position.clone().sub(engine.sun.target ? engine.sun.target.position : _c.set(0, 0, 0)).normalize(); out.sun = [r1(sd.x), r1(sd.y), r1(sd.z)]; out.lz = [r1(LZ.x), r1(LZ.z), r1(LZ.yaw)]; }
    return out;
  };

  return film;
}
