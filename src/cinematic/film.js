// The 45 second film, 30 fps: eight scenes rendered from the live game.
// Every scene starts from a clean, seeded state so it can be rendered on its
// own (the capture tool renders scene by scene and is resumable). A scene may
// pre-roll (`warm` seconds simulated before its first frame) so nothing looks
// frozen at the cut. The first-person scenes are played by a scripted player
// through the normal player, weapon and zombie code; its eyes and hands follow
// a human aim model (aimer below): a reaction delay, a damped spring that
// speeds up, slows down, overshoots a flick and settles, lag and wander while
// tracking, recoil pulled down during a burst, bursts released when the aim is
// close enough, and some shots that go wide on purpose. Three short outside
// shots (the boss, the tank drop, the helicopter) are cut into scenes 6 to 8.
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
// the title, drawn over the finished (display-encoded) picture: white is paper white in PQ or SDR
const TITLE_FS = /* glsl */`
uniform sampler2D tTitle;
uniform float uA;
uniform float uWhite;
out vec4 outColor;
void main() { vec4 c = texture(tTitle, vUv); outColor = vec4(c.rgb * uWhite, c.a * uA); }`;

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ease = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const TAU = Math.PI * 2;
const JITTERS = { 1: [[0, 0]], 2: [[-0.25, 0.12], [0.25, -0.12]], 3: [[0, 0], [-0.33, -0.2], [0.33, -0.2]], 4: [[0, 0], [-0.33, -0.2], [0.33, -0.2], [0, 0.36]] };

export function createFilm(vm) {
  const { engine, game, terrain, world, layout } = vm;
  const cam = engine.camera;
  const p = game.player, weapon = game.weapon, zombies = game.zombies, col = game.collision, op = game.operation;
  const gy = (x, z) => terrain.heightAt(x, z);
  const street = layout.streets[0];               // main street: road (s 0) up to the church square (s ~77)
  const yawTo = (x0, z0, x1, z1) => Math.atan2(-(x1 - x0), -(z1 - z0));
  const _a = V(0, 0, 0), _b = V(0, 0, 0), _c = V(0, 0, 0), _d = V(0, 0, 0), _q = {};
  const _qa = new THREE.Quaternion(), _pa = V(0, 0, 0);
  let LZ = null, LZM = null;                       // the square and the meadow landing zones

  // ---- places
  const sx = (s, lat = 0) => { const q = street.at(s); return [q[0] - q[3] * lat, q[1] + q[2] * lat]; };
  const sp = (s, lat = 0, h = 0) => { const [x, z] = sx(s, lat); return V(x, gy(x, z) + h, z); };
  const free = (x, z, r = 0.5) => zombies.flow.walkable(x, z) && col.resolveCapsule(_c.set(x, gy(x, z) + 0.05, z), r, 1.8).lengthSq() < 1e-8;
  const _hit = { point: V(0, 0, 0), normal: V(0, 0, 0) }, UP = V(0, 1, 0);
  const sky = (x, z) => !col.raycastMesh(V(x, gy(x, z) + 1.2, z), UP, 40, _hit);
  // nearest open ground round a point
  const spot = (x, z, r = 0.6, open = false) => {
    for (let ring = 0; ring < 14; ring++) {
      const n = Math.max(1, ring * 6);
      for (let k = 0; k < n; k++) { const a = (k / n) * TAU, xx = x + Math.cos(a) * ring * 0.7, zz = z + Math.sin(a) * ring * 0.7; if (free(xx, zz, r) && (!open || sky(xx, zz))) return [xx, zz]; }
    }
    return [x, z];
  };
  const spawnAt = (x, z, opts = {}) => zombies.spawn(x, z, { aware: true, type: 'walker', ...opts });
  const onStreet = (s, lat, opts = {}) => { const [x, z] = sx(s, lat); return spawnAt(x, z, opts); };
  const place = (x, h, z) => cam.position.set(x, gy(x, z) + h, z);
  const track = (o, x, y, z, rate, dt) => {
    if (!o.look) o.look = V(x, y, z); else o.look.lerp(_a.set(x, y, z), 1 - Math.exp(-rate * dt));
    return o.look;
  };
  const head = (z, out) => { const h = z.bones && z.bones.Head; if (h) { h.getWorldPosition(out); out.y += 0.04; } else out.set(z.pos.x, z.pos.y + 1.62 * (z.scale || 1), z.pos.z); return out; };
  const chest = (z, out) => out.set(z.pos.x, z.pos.y + 1.22 * (z.scale || 1), z.pos.z);

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
  const own = (...ids) => { for (const id of ids) { const s = weapon.state[id]; s.owned = true; s.needBolt = false; if (Number.isFinite(s.reserve)) s.reserve = Math.max(s.reserve, 60); } };

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
  // the helicopter on its way in to `lz`, touching down `land` seconds from now
  function heliIn(lz, land) {
    const h = op.heli;
    h.arrive(lz); h.inside = false;
    h.t = clamp(1 - land / h.T, 0, 0.999); h._place(1 - h.t);
    film.op = true;
    return h;
  }

  // ---- the scripted player's eyes: a human aim model
  // Two damped springs (yaw, pitch) chase a goal that is itself smoothed, so the
  // view accelerates and decelerates and never jumps. A new target waits for a
  // reaction delay; a big turn uses a lighter damping and overshoots a little.
  function aimer(seed, o = {}) {
    const R = mulberry32(seed);
    const A = {
      R, key: null, react: 0, fy: 0, fp: 0, vy: 0, vp: 0, w: o.w || 11, zeta: 0.75, init: false, fresh: false, wNext: o.w || 11,
      amp: o.amp ?? 0.0055, ampAds: o.ampAds ?? 0.0028, breath: o.breath ?? 0.0016, comp: o.comp ?? 0.75, ph: [R() * 9, R() * 9, R() * 9, R() * 9], err: 1,
    };
    // look at something new: `w` is the speed of the move (rad/s of the spring)
    A.to = (key, w = A.w) => { if (key === A.key) return; A.key = key; A.react = (o.react0 ?? 0.15) + (o.react1 ?? 0.15) * R(); A.wNext = w; A.fresh = true; };
    A.step = (dt, pl, point, ads = false) => {
      if (!A.init) { A.init = true; A.fy = pl.yaw; A.fp = pl.pitch; A.react = 0; A.fresh = true; }
      if (dt <= 0) return;
      const t = film.t + film.shot.start;
      _d.subVectors(point, pl.eye);
      let gyaw = Math.atan2(-_d.x, -_d.z), gp = Math.atan2(_d.y, Math.hypot(_d.x, _d.z));
      const amp = ads ? A.ampAds : A.amp;
      gyaw += amp * (0.6 * Math.sin(0.9 * t + A.ph[0]) + 0.4 * Math.sin(2.3 * t + A.ph[1]));
      gp += amp * 0.8 * (0.6 * Math.sin(0.7 * t + A.ph[2]) + 0.4 * Math.sin(1.9 * t + A.ph[3])) + A.breath * Math.sin(1.55 * t);
      gp -= A.comp * pl.recoilPitch;                     // the hands pull the climb back down
      if (A.react > 0) A.react -= dt;
      else {
        if (A.fresh) {
          A.fresh = false;
          const turn = Math.hypot(wrap(gyaw - pl.yaw), gp - pl.pitch);
          A.zeta = turn > 0.25 ? 0.6 : 0.78; A.w = A.wNext * (turn > 0.8 ? 0.85 : 1);
        }
        const k = 1 - Math.exp(-dt * 15);
        A.fy += wrap(gyaw - A.fy) * k; A.fp += (gp - A.fp) * k;
      }
      const w = A.w, z = A.zeta, ey = wrap(A.fy - pl.yaw), ep = A.fp - pl.pitch;
      A.vy += (w * w * ey - 2 * z * w * A.vy) * dt; A.vp += (w * w * ep - 2 * z * w * A.vp) * dt;
      pl.yaw = wrap(pl.yaw + A.vy * dt); pl.pitch = clamp(pl.pitch + A.vp * dt, -1.4, 1.4);
      pl.forward(_a); _b.copy(point).sub(pl.eye).normalize();
      A.err = Math.acos(Math.min(1, _a.dot(_b)));
      A.speed = Math.hypot(A.vy, A.vp);
    };
    return A;
  }

  // walk in a world direction whatever the eyes do (the body follows the legs, the view the eyes)
  const walk = (pl, dx, dz, speed) => {
    const l = Math.hypot(dx, dz) || 1, fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw), rx = Math.cos(pl.yaw), rz = -Math.sin(pl.yaw);
    pl.input.fwd = clamp((dx * fx + dz * fz) / l * speed, -1, 1); pl.input.strafe = clamp((dx * rx + dz * rz) / l * speed, -1, 1);
  };
  const walkTo = (pl, x, z, speed, stop = 0.3) => { const dx = x - pl.pos.x, dz = z - pl.pos.z; if (Math.hypot(dx, dz) > stop) walk(pl, dx, dz, speed); };

  // ---- the scripted shooter: picks a target, aims with the aim model, fires bursts, taps or single rounds
  function gunner(cfg) {
    const A = cfg.A;
    let target = null, firing = false, shots0 = 0, burstN = 0, pause = cfg.pause0 ?? 0, part = 'chest', miss = V(0, 0, 0), confirm = 0, lastTap = -9;
    const aim = V(0, 0, 0);
    const point = (z) => { (part === 'head' ? head : chest)(z, aim); return aim.add(miss); };
    const visible = (z) => !cfg.los || col.lineOfSight(p.eye, chest(z, _c));
    const newBurst = (z, d) => {
      const R = A.R;
      part = (cfg.head ? cfg.head(z, d) : R() < (cfg.headP ?? 0.25)) ? 'head' : 'chest';
      const wide = !cfg.noMiss && R() < (cfg.missP ?? 0.16);
      if (wide) { const a = R() * TAU, m = (part === 'head' ? 0.32 : 0.55) + R() * 0.25; miss.set(Math.cos(a) * m, Math.sin(a) * m * 0.6, Math.sin(a) * m * 0.4); } else miss.set(0, 0, 0);
      const far = d > (cfg.far ?? 26);
      burstN = cfg.mode === 'auto' ? (far ? 1 + Math.floor(R() * 2) : 3 + Math.floor(R() * 4)) : 1;
    };
    const run = (dt, pl) => {
      const t = film.t;
      if (cfg.move) cfg.move(t, pl);
      if (cfg.extra && cfg.extra(t, pl, dt)) return;
      // the target: the current one until it is down, then the nearest seen one
      if (target && (!target.alive || !visible(target))) { target = null; confirm = 0.08 + A.R() * 0.12; }
      if (confirm > 0) { confirm -= dt; }
      if (!target && confirm <= 0 && t >= (cfg.from ?? -1e9)) {
        let best = 1e9;
        for (const z of zombies.list) {
          if (!z.alive || (cfg.skip && cfg.skip(z)) || !visible(z)) continue;
          const d = z.pos.distanceTo(pl.pos) * (cfg.prefer ? cfg.prefer(z) : 1);
          if (d < best && d < (cfg.reach || 90)) { best = d; target = z; }
        }
        if (target) { A.to(target, cfg.w); newBurst(target, target.pos.distanceTo(pl.pos)); firing = false; pause = Math.max(pause, 0.05); }
      }
      if (!target) {
        const rest = typeof cfg.rest === 'function' ? cfg.rest(t) : cfg.rest;
        A.to(rest.key || 'rest', cfg.restW || 6);
        A.step(dt, pl, rest.p || rest, false);
        pl.input.ads = cfg.ads ? cfg.ads(t, 99) : false;
        firing = false;
        if (cfg.reload !== false && weapon.st.ammo < weapon.magSize * (cfg.topUp ?? 0) && !weapon.act) pl.input.reload = true;
        return;
      }
      const dist = target.pos.distanceTo(pl.pos);
      pl.input.ads = cfg.ads ? cfg.ads(t, dist) : dist > 9;
      A.step(dt, pl, point(target), pl.input.ads);
      if (weapon.st.ammo === 0 && !weapon.act) { pl.input.reload = true; firing = false; return; }
      if (t < (cfg.fireFrom ?? 0) || weapon.act || (cfg.hold && cfg.hold(t))) { firing = false; return; }
      const tol = clamp((part === 'head' ? 0.13 : 0.24) / Math.max(1, dist), 0.0035, 0.1) * (cfg.tolK || 1);
      if (pause > 0) { pause -= dt; return; }
      if (cfg.mode === 'auto') {
        if (firing) {
          pl.input.fire = true;
          if (weapon.shots - shots0 >= burstN || A.err > tol * 5) { firing = false; pl.input.fire = false; pause = (cfg.gap ?? 0.16) + A.R() * 0.2; newBurst(target, dist); }
        } else if (A.err < tol && A.speed < 2.5) { firing = true; shots0 = weapon.shots; pl.input.fire = true; }
      } else if (A.err < tol && A.speed < (cfg.mode === 'single' ? 0.08 : 1.5) && t - lastTap > (cfg.tap ?? 0.2)) {
        pl.input.fire = true; lastTap = t; pause = (cfg.gap ?? 0.12) + A.R() * 0.12; newBurst(target, dist);
      }
    };
    run.target = () => target;
    return run;
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
      const d = Math.min(...layout.streets.map((st) => st.query(m[0], m[1], _q).d));
      if (d < bd) { bd = d; best = { x: m[0], z: m[1], wi }; }
    });
    if (!best) return null;
    const alongX = best.wi < 2, sg = best.wi % 2 ? -1 : 1;
    best.nx = alongX ? -s * sg : c * sg; best.nz = alongX ? c * sg : s * sg;     // outward
    best.depth = alongX ? b.d : b.w;
    return best;
  }

  const bridge = layout.bridge;
  const bWest = [bridge.x - bridge.dirx * bridge.length / 2, bridge.z - bridge.dirz * bridge.length / 2];

  const SHOTS = [
    {
      // 1. in the open cabin over the valley, river and village sliding by, down onto the meadow, out, the rifle comes up
      name: 'heli', dur: 4.5, warm: 0.3,
      setup() {
        const h = heliIn(LZM, 3.0 + 0.3); h.inside = true;
        p.spawn(LZM.x + 40, LZM.z, 0);
        own('rifle', 'pistol', 'sniper');
        this.landT = null; this.drawn = false;
        const tw = V(layout.church.towerX, gy(layout.church.towerX, layout.church.towerZ) + 6, layout.church.towerZ);
        this.A = aimer(101, { w: 6 });
        this.tw = tw;
      },
      pre(t) {
        const h = op.heli;
        if (this.landT === null && h.state === 'ground') {
          this.landT = t;
          const e = LZM.exit || { x: LZM.x + 3, z: LZM.z };
          p.spawn(e.x, e.z, LZM.exitYaw ?? yawTo(e.x, e.z, this.tw.x, this.tw.z)); p.enabled = true;
          arm('rifle', 30); weapon.visible = false;
          const A = this.A, tw = this.tw;
          p.script = (dt, pl) => {
            const u = film.t - this.landT;
            if (u > 0.25) walk(pl, -Math.sin(pl.yaw), -Math.cos(pl.yaw), u < 0.9 ? 0.8 : 0.55);
            A.to('village', 4.5); A.step(dt, pl, tw, false);
          };
        }
        if (this.landT !== null && !this.drawn && t > this.landT + 0.35) { this.drawn = true; weapon.visible = true; weapon._start('Draw'); }
      },
      cam() {
        const h = op.heli;
        if (this.landT === null) { h.seatPose(cam.position, cam.quaternion); cam.fov = 66; return; }
        // out of the door: from the seat to the player's eyes
        const k = ease((film.t - this.landT - 0.1) / 0.85);
        h.seatPose(_pa, _qa);
        cam.position.lerpVectors(_pa, cam.position, k); cam.quaternion.slerpQuaternions(_qa, cam.quaternion, k);
        weapon.visible = this.drawn;
      },
    },
    {
      // 2. the meadow by the bridge: they climb up from the river bank, short aimed bursts, one in the head, brass
      name: 'meadow', dur: 5.5, warm: 0.45,
      setup() {
        const dx = bridge.dirx, dz = bridge.dirz, lx = -dz, lz = dx;      // along the deck, and across it (along the river)
        const P = spot(bWest[0] - dx * 15 + lx * 3, bWest[1] - dz * 15 + lz * 3, 0.5);
        const look = V(bWest[0] - dx * 2 + lx * 9, 0, bWest[1] - dz * 2 + lz * 9); look.y = gy(look.x, look.z) + 1.2;
        p.spawn(P[0], P[1], yawTo(P[0], P[1], look.x, look.z)); p.enabled = true;
        arm('rifle', 30);
        const at = (a, b) => spot(bWest[0] + dx * a + lx * b, bWest[1] + dz * a + lz * b, 0.4);
        const zs = [[-3, 10, 0.95], [-1, 14, 1.0], [-4, 4.5, 1.05], [2, 18, 0.9], [-2, -6, 1.1], [6, 1, 0.9]];
        this.first = null;
        zs.forEach(([a, b, s], k) => { const [x, z] = at(a, b); const zb = spawnAt(x, z, { speed: s }); if (!k) this.first = zb; });
        const A = aimer(202, { w: 10 });
        p.pitch = -0.02;
        p.script = gunner({
          A, mode: 'auto', rest: look, fireFrom: 0.15, far: 24, los: true,
          head: (z) => z === this.first, missP: 0.08, tolK: 0.8,
          ads: (t, d) => d > 8,
          move: (t, pl) => { if (t > 2.8) walk(pl, dx, dz, 0.25); },
        });
      },
    },
    {
      // 3. the main street: runners round a corner, hip fire, a dodge roll, over the sights, empty, a full reload backing away
      name: 'street', dur: 6.5, warm: 0.5,
      setup() {
        const [x, z] = sx(16, 0.3), [x1, z1] = sx(34, 0);
        p.spawn(x, z, yawTo(x, z, x1, z1)); p.enabled = true;
        arm('rifle', 21);
        onStreet(23.5, -0.4, { speed: 1.25 }); onStreet(25.5, 0.55, { speed: 1.1 });
        onStreet(44, 0.2, { speed: 1.0 });
        // round a corner: an opening off the street not seen from where the player stands
        const eye = V(x, gy(x, z) + 1.6, z);
        this.c = null;
        for (const s of [33, 35, 37, 31, 39, 41, 29]) {
          for (const lat of [7, -7, 9, -9, 6, -6, 11, -11]) {
            const [cx, cz] = sx(s, lat); const [sx2, sz2] = sx(s, 0);
            if (!free(cx, cz, 0.4)) continue;
            if (col.lineOfSight(eye, _b.set(cx, gy(cx, cz) + 1.3, cz))) continue;
            if (!col.lineOfSight(_c.set(cx, gy(cx, cz) + 1.3, cz), _b.set(sx2, gy(sx2, sz2) + 1.3, sz2))) continue;
            this.c = [cx, cz, s]; break;
          }
          if (this.c) break;
        }
        if (!this.c) { const [cx, cz] = sx(52, 0); this.c = [cx, cz, 52]; }
        this.run = 0; this.rolled = false;
        const A = aimer(303, { w: 12 });
        const fwd = [x1 - x, z1 - z];
        p.script = gunner({
          A, mode: 'auto', rest: sp(34, 0, 1.4), fireFrom: 0.1, far: 30, reach: 40,
          head: (zb, d) => zb.type === 'runner' && d > 8 && A.R() < 0.5, missP: 0.1, tolK: 0.8,
          prefer: (zb) => (zb.type === 'runner' ? 0.6 : 1),
          ads: (t, d) => t > 2.75 && !weapon.act && !p.rolling,
          extra: (t, pl) => {
            // the roll: once a runner is close, sideways to the left
            const near = zombies.list.find((q) => q.alive && q.type === 'runner' && q.pos.distanceTo(pl.pos) < 5.5);
            if (!this.rolled && t > 1.6 && (near || t > 2.5)) { this.rolled = true; pl.input.roll = true; pl.input.strafe = -1; pl.input.fwd = -0.2; return true; }
            return false;
          },
          move: (t, pl) => {
            if (t < 1.4) walk(pl, fwd[0], fwd[1], 0.45);
            else if (weapon.reloading || (weapon.st.ammo === 0)) walk(pl, -fwd[0], -fwd[1], 0.6);
          },
        });
      },
      pre(t) {
        p.health = 100;
        if (this.run < 2 && t > 0.55 + this.run * 0.35) {
          const [cx, cz] = this.c, k = this.run++;
          spawnAt(cx + k * 0.6, cz - k * 0.5, { type: 'runner' });
        }
      },
    },
    {
      // 4. into the house with the pistol: the switch, the doorway, the dark room under the broken roof, one from the side, slide back, quick reload
      name: 'house', dur: 5.5, warm: 0.25,
      setup() {
        const b = layout.buildings.find((q) => q.id === film.houseId) || layout.buildings.find((q) => q.id === 'barn') || layout.buildings.find((q) => q.enterable);
        const d = doorOf(b);
        this.d = d; this.b = b;
        const ox = d.x + d.nx * 2.4, oz = d.z + d.nz * 2.4;
        p.spawn(ox, oz, yawTo(ox, oz, d.x, d.z)); p.enabled = true;
        arm('rifle', 24); own('pistol');
        weapon.state.pistol.ammo = 5;
        this.sw = false; this.z1 = null; this.z2 = null;
        const inX = d.x - d.nx * 3.2, inZ = d.z - d.nz * 3.2, fy = b.baseY + 1.5;
        this.inP = [inX, inZ];
        const A = aimer(404, { w: 13, react0: 0.16, react1: 0.1 });
        p.script = gunner({
          A, mode: 'tap', rest: (t) => (t < 2.9 ? V(d.x - d.nx * 6, fy, d.z - d.nz * 6) : V(d.x - d.nx * 4 + d.nz * 2, fy + 0.4, d.z - d.nz * 4 - d.nx * 2)),
          los: true, reach: 12, fireFrom: 0.6, tap: 0.19, gap: 0.06, headP: 0.2, missP: 0.12,
          ads: (t, dist) => dist > 3.2, reload: true,
          move: (t, pl) => { if (t < 2.6) walkTo(pl, inX, inZ, 0.75); },
        });
      },
      pre(t) {
        p.health = 100;
        if (!this.sw && t > -0.2) { this.sw = true; weapon.switchTo('pistol'); }
        const d = this.d, b = this.b;
        // one waits in the dark beside the door and goes for the player as he passes
        if (!this.z1 && t > 1.35) {
          const ein = V(this.inP[0], b.baseY + 1.5, this.inP[1]), eout = V(d.x + d.nx * 2.4, b.baseY + 1.5, d.z + d.nz * 2.4);
          let sx2 = d.x - d.nx * 2.2 - d.nz * 2.7, sz2 = d.z - d.nz * 2.2 + d.nx * 2.7;
          found: for (const dep of [1.8, 2.6, 1.2, 3.2]) for (const sd of [2.8, -2.8, 2.2, -2.2, 3.5, -3.5]) {
            const cx = d.x - d.nx * dep - d.nz * sd, cz = d.z - d.nz * dep + d.nx * sd, c = V(cx, b.baseY + 1.3, cz);
            if (col.lineOfSight(ein, c) && !col.lineOfSight(eout, c) && col.lineOfSight(V(d.x - d.nx * 0.5, b.baseY + 1.3, d.z - d.nz * 0.5), c)) { sx2 = cx; sz2 = cz; break found; }
          }
          this.z1 = spawnAt(sx2, sz2, { speed: 1.3, yaw: yawTo(sx2, sz2, p.pos.x, p.pos.z) });
          this.z1.pos.y = col.floorAt(sx2, b.baseY + 1.2, sz2, 3);
        }
        // and one more in the doorway behind as the magazine goes in
        if (!this.z2 && t > 3.5) {
          const x = d.x + d.nx * 2.5, z = d.z + d.nz * 2.5;
          this.z2 = spawnAt(x, z, { speed: 1.2, yaw: yawTo(x, z, p.pos.x, p.pos.z) });
        }
      },
    },
    {
      // 5. the inn balcony: down prone, the bipod, the scope, one round through two of them, the bolt, the brute's head
      name: 'balcony', dur: 6.0, warm: 0.3,
      setup() {
        const b = layout.buildings.find((q) => q.id === 'inn');
        const c = Math.cos(b.rot), s = Math.sin(b.rot), W = (lx, lz) => [b.x + lx * c - lz * s, b.z + lx * s + lz * c];
        const fH = b.floorH || 2.75;
        const lane = (e, yy, dd) => {
          const ddx = -Math.sin(yy), ddz = -Math.cos(yy), rx = -ddz * 0.3, rz = ddx * 0.3, tx = e.x + ddx * dd, tz = e.z + ddz * dd, ty = gy(tx, tz) + 1.1;
          for (const k of [-1, 0, 1]) if (!col.lineOfSight(_c.set(e.x + ddx * 0.9 + rx * k, e.y, e.z + ddz * 0.9 + rz * k), _b.set(tx + rx * k, ty, tz + rz * k))) return false;
          return free(tx, tz, 0.4);
        };
        let x = 0, z = 0, ox = 0, oz = 0, yaw0 = 0, bestS = -1e9;
        for (const lx of [0.56, -0.56, 1.68, -1.68]) {      // between the balusters
          const [x1, z1] = W(lx, -b.d / 2 - 0.62), [ox1, oz1] = W(lx, -b.d / 2 - 10), e = V(x1, col.floorAt(x1, b.baseY + fH + 1.2, z1, 3) + 0.42, z1);
          if (!x) { x = x1; z = z1; ox = ox1; oz = oz1; yaw0 = yawTo(x1, z1, ox1, oz1); }
          for (let a = -0.5; a <= 0.51; a += 0.05) {
            const yy = yawTo(x1, z1, ox1, oz1) + a;
            let far = 0;
            for (const dd of [42, 36, 30, 25, 20]) if (lane(e, yy, dd) && lane(e, yy + 0.12, dd) && lane(e, yy - 0.12, dd)) { far = dd; break; }
            const sc = far - Math.abs(a) * 3;
            if (far && sc > bestS) { bestS = sc; yaw0 = yy; x = x1; z = z1; ox = ox1; oz = oz1; }
          }
        }
        const dx = -Math.sin(yaw0), dz = -Math.cos(yaw0);
        p.spawn(x, z, yaw0); p.enabled = true;
        p.pos.y = col.floorAt(x, b.baseY + fH + 1.2, z, 3);
        arm('sniper', 5);
        const eye = V(x, p.pos.y + 1.5, z);
        let D = 30, P1 = null;
        for (const dd of [30, 27, 33, 24, 36, 21]) {
          const [tx, tz] = spot(x + dx * dd, z + dz * dd, 0.45);
          if (col.lineOfSight(eye, _b.set(tx, gy(tx, tz) + 1.2, tz))) { P1 = [tx, tz]; D = dd; break; }
        }
        if (!P1) P1 = [x + dx * D, z + dz * D];
        const bx = P1[0] - x, bz = P1[1] - z, bl = Math.hypot(bx, bz);
        const t1 = spawnAt(P1[0], P1[1], { speed: 0.55, yaw: yawTo(P1[0], P1[1], x, z), healthMult: 1 });
        const t2 = spawnAt(P1[0] + bx / bl * 1.7, P1[1] + bz / bl * 1.7, { speed: 0.55, yaw: yawTo(P1[0], P1[1], x, z) });
        const ba = 0.035, br = spot(x + (dx * Math.cos(ba) - dz * Math.sin(ba)) * (D + 9), z + (dz * Math.cos(ba) + dx * Math.sin(ba)) * (D + 9), 0.6);
        const brute = spawnAt(br[0], br[1], { type: 'brute', speed: 1.0, yaw: yawTo(br[0], br[1], x, z) });
        for (const [a, r] of [[-0.5, D + 10], [0.25, D + 14]]) { const q = spot(x + (dx * Math.cos(a) - dz * Math.sin(a)) * r, z + (dz * Math.cos(a) + dx * Math.sin(a)) * r, 0.4); spawnAt(q[0], q[1], { speed: 0.9 }); }
        this.t1 = t1; this.t2 = t2; this.brute = brute; this.down = false; film.shootSkip = 1.0; void ox; void oz;
        const A = aimer(505, { w: 7, amp: 0.002, ampAds: 0.0009, breath: 0.0007, react0: 0.2 });
        const aim = V(0, 0, 0);
        let shot1 = false, shot2 = false, steady = 0;
        p.script = (dt, pl) => {
          const t = film.t;
          if (t < 0.1 && !this.down) { this.down = true; pl.input.prone = true; }
          let tg = null;
          if (t < 1.2) { A.to('rest', 4); aim.set(P1[0], gy(P1[0], P1[1]) + 1.0, P1[1]); }
          else if (!shot1 || t < 3.5) { tg = this.t1.alive ? this.t1 : this.t2; A.to(tg, 6); chest(tg, aim); }
          else { tg = this.brute; A.to(tg, 7); head(tg, aim); }
          A.step(dt, pl, aim, weapon.scoped);
          pl.input.ads = t > 1.15 && weapon.bipod;
          if (weapon.scoped && !weapon.act && A.err < (t > 3.5 ? 0.009 : 0.0045) && A.speed < 0.2) steady += dt; else steady = 0;
          if (tg && steady > 0.18) {
            if (!shot1 && t > 2.1) { shot1 = true; pl.input.fire = true; }
            else if (shot1 && !shot2 && t > 4.0 && tg === this.brute) { shot2 = true; pl.input.fire = true; }
          }
        };
      },
      pre() { p.health = 100; },
    },
    {
      // 6. the bell, the boss round the church (outside, from low down), sustained fire, the charge, adrenaline
      name: 'boss', dur: 6.0, warm: 0.5, cut: 1.5,
      setup() {
        const ch = layout.church, c = Math.cos(ch.rot), s = Math.sin(ch.rot), W = (lx, lz) => [ch.x + lx * c - lz * s, ch.z + lx * s + lz * c];
        const [kx0, kz0] = W(-ch.w / 2 - 2, (((LZ.x - ch.x) * -s + (LZ.z - ch.z) * c) > 0 ? -1 : 1) * (ch.d / 2 + 1.5));
        const [px, pz] = spot(kx0 + (LZ.x - kx0) * 0.75, kz0 + (LZ.z - kz0) * 0.75, 0.5);
        // the far side of the church from the player, near its west end
        const sideZ = ((px - ch.x) * -s + (pz - ch.z) * c) > 0 ? -1 : 1;
        const [bx, bz] = spot(...W(-ch.w / 2 + 2.0, sideZ * (ch.d / 2 + 2.6)), 0.7);
        const [kx, kz] = W(-ch.w / 2 - 2, sideZ * (ch.d / 2 + 1.5));               // the corner it comes round
        this.corner = [kx, kz];
        p.spawn(px, pz, yawTo(px, pz, kx, kz)); p.enabled = true;
        arm('rifle', 30);
        equip(['adrenaline']);
        this.boss = spawnAt(bx, bz, { type: 'boss', yaw: yawTo(bx, bz, kx, kz), speed: 2.5 });
        this.boss.chargeCd = 2.6;
        // the outside camera: low on the cobbles, the corner and the player's side both in view
        const ux = kx - px, uz = kz - pz, ul = Math.hypot(ux, uz);
        this.c = spot(px + uz / ul * 5 - ux / ul * 1.5, pz - ux / ul * 5 - uz / ul * 1.5, 0.3);
        this.look = null; this.rang = false; this.adr = 0;
        const A = aimer(606, { w: 10 });
        p.script = gunner({
          A, mode: 'auto', rest: V(kx, gy(kx, kz) + 2.2, kz), fireFrom: 1.75, far: 40, reach: 60, gap: 0.12,
          headP: 0.3, missP: 0.12, ads: (t, d) => t > 1.6 && d > 21,
          move: (t, pl) => { if (t > 3.2) walk(pl, -Math.sin(pl.yaw), -Math.cos(pl.yaw), -0.55); },
        });
        weapon.visible = false;
      },
      pre(t) {
        p.health = 100; p.alive = true;
        const b = this.boss;
        if (b.alive && b.health < 900) b.health = 900;
        if (!this.rang && t >= -0.45) { this.rang = true; game.audio.play('bell_toll', { volume: 0.9 }); }
        weapon.visible = t >= this.cut;
        if (!this.adr && t >= 3.55) { this.adr = 1; use('adrenaline'); }
        if (this.adr === 1 && t >= 5.0) { this.adr = 2; op.kit.tsTarget = 1; }
      },
      cam(u, dt) {
        if (film.t >= this.cut) return;
        const [x, z] = this.c, b = this.boss.pos, k = ease(film.t / this.cut);
        place(x, 0.55 + 0.08 * k, z);
        const seen = col.lineOfSight(p.eye, _c.set(b.x, b.y + 2.0, b.z)), [kx, kz] = this.corner;
        if (seen) cam.lookAt(track(this, b.x, b.y + 1.9, b.z, 4, dt)); else cam.lookAt(track(this, kx, gy(kx, kz) + 2.2, kz, 4, dt));
        cam.fov = 30 - 3 * k;
      },
    },
    {
      // 7. the tank on its chutes onto the square (wide), climbing in, down the street over them, the main gun on the boss
      name: 'tank', dur: 6.0, warm: 1.4, cut: 1.5,
      setup() {
        const [px, pz] = spot(LZ.x + 9, LZ.z - 4, 0.5);
        const [hx, hz] = sx(74, 0);
        p.spawn(px, pz, yawTo(px, pz, hx, hz)); p.enabled = true; weapon.visible = false;
        equip(['tank']);
        this.ds = op.kit._dropSpot() || { x: hx, z: hz, yaw: p.yaw };
        let i = 0;
        for (let s = 44; s < 66; s += 3.2) { onStreet(s, ((i * 7) % 5 - 2) * 0.55, { speed: 0.9 + (i % 3) * 0.12 }); i++; }
        this.boss = onStreet(36, 0.2, { type: 'boss' }); this.boss.chargeCd = 99; this.boss.health = 2200;
        // the wide view: across the square, low, the drop spot and the sky above it
        const ds = this.ds, vx = ds.x - px, vz = ds.z - pz, vl = Math.hypot(vx, vz);
        this.c = spot(ds.x - vz / vl * 19 - vx / vl * 6, ds.z + vx / vl * 19 - vz / vl * 6, 0.4, true);
        this.used = false; this.mounted = false; this.look = null;
        const A = aimer(707, { w: 4.5, amp: 0.003 });
        const look = V(0, 0, 0);
        p.script = (dt, pl) => {
          const t = film.t, tk = pl.vehicle;
          if (!tk) { A.to('tank', 5); A.step(dt, pl, _b.set(ds.x, gy(ds.x, ds.z) + 1.2, ds.z), false); return; }
          const s = street.query(tk.pos.x, tk.pos.z, _q).s, [ax, az] = sx(Math.max(2, s - 10), 0);
          const diff = wrap(yawTo(tk.pos.x, tk.pos.z, ax, az) - tk.yaw);
          pl.input.fwd = t > 2.3 ? (t > 4.2 && t < 4.9 ? 0.4 : 1) : 0;
          pl.input.strafe = clamp(-diff * 2.6, -1, 1);
          const b = this.boss;
          if (b.alive && t > 3.2) { A.to(b, 5); look.set(b.pos.x, b.pos.y + 1.5, b.pos.z); } else { const [lx, lz] = sx(Math.max(2, s - 16), 0); A.to('road', 4); look.set(lx, gy(lx, lz) + 1.4, lz); }
          A.step(dt, pl, look, false);
          pl.input.fire = b.alive && tk.shots < 1 && t > 4.35 && A.err < 0.02;
        };
      },
      pre(t) {
        p.health = 100;
        if (!this.used && t >= -1.3) { this.used = true; use('tank'); }
        const tk = op.kit.tanks[0];
        // it waits on the ground for the cut, then the player climbs in
        if (tk && tk.state === 'settle' && t < this.cut + 0.05) tk.t2 = Math.min(tk.t2, 0.3);
      },
      cam(u, dt) {
        if (film.t >= this.cut) return;
        const [x, z] = this.c, ds = this.ds, tk = op.kit.tanks[0], k = ease(film.t / this.cut);
        place(x, 1.3 + 0.2 * k, z);
        const ty = tk ? tk.pos.y + 1.5 : gy(ds.x, ds.z) + 8;
        cam.lookAt(track(this, ds.x, Math.max(gy(ds.x, ds.z) + 3.5, ty * 0.55 + (gy(ds.x, ds.z) + 3.5) * 0.45), ds.z, 3, dt));
        cam.fov = 50;
      },
    },
    {
      // 8. the helicopter over the church tower against the sun, boarding, the climb above the village, the title
      name: 'extract', dur: 5.0, warm: 0.4, cut: 2.0,
      setup() {
        const h = heliIn(LZ, 2.1 + 0.4);
        const [px, pz] = spot(LZ.x - LZ.fx * 6 + 4, LZ.z - LZ.fz * 6, 0.5);
        p.spawn(px, pz, yawTo(px, pz, LZ.x, LZ.z)); p.enabled = true;
        arm('rifle', 22); weapon.visible = false;
        const ch = layout.church;
        this.tw = V(ch.towerX, gy(ch.towerX, ch.towerZ) + 16, ch.towerZ);
        // the outside camera: on the line from the sun through the tower, low on the square
        const sd = engine.sun.position.clone().normalize(), l = Math.hypot(sd.x, sd.z) || 1;
        const tx = ch.towerX - LZ.x, tz = ch.towerZ - LZ.z, tl = Math.hypot(tx, tz);
        this.c = spot(LZ.x - tx / tl * 9 + tz / tl * 4, LZ.z - tz / tl * 9 - tx / tl * 4, 0.4, true); void sd; void l;
        this.look = null; this.boardT = null; this.gone = false;
        const A = aimer(808, { w: 5 });
        p.script = (dt, pl) => {
          A.to('heli', 5); A.step(dt, pl, _b.copy(h.group.position).add(_c.set(0, 1.2, 0)), false);
          if (film.t > this.cut - 0.3) walkTo(pl, LZ.exit ? LZ.exit.x : LZ.x, LZ.exit ? LZ.exit.z : LZ.z, 0.9, 1.0);
        };
        film.title = 0;
      },
      pre(t) {
        p.health = 100;
        weapon.visible = t >= this.cut && this.boardT === null;
        if (this.boardT === null && t >= 3.0) {
          this.boardT = t; op.heli.inside = true; weapon.visible = false; p.enabled = false;
          this.from = { pos: cam.position.clone(), quat: cam.quaternion.clone() };
        }
        if (this.boardT !== null && !this.gone && t >= this.boardT + 0.75) { this.gone = true; op.heli.depart(true); }
        film.title = ease((t - 3.55) / 0.7) * (1 - ease((t - 4.8) / 0.2));
      },
      cam(u, dt) {
        const h = op.heli;
        if (film.t < this.cut) {
          const [x, z] = this.c, g = h.group.position, k = ease(film.t / this.cut);
          place(x, 1.1 + 0.3 * k, z);
          cam.lookAt(track(this, g.x * 0.6 + this.tw.x * 0.4, g.y * 0.6 + this.tw.y * 0.4, g.z * 0.6 + this.tw.z * 0.4, 3, dt));
          cam.fov = 46;
          return;
        }
        if (this.boardT === null) return;
        const k = ease((film.t - this.boardT) / 0.9);
        h.seatPose(_pa, _qa);
        cam.position.lerpVectors(this.from.pos, _pa, k); cam.quaternion.slerpQuaternions(this.from.quat, _qa, k);
        cam.fov = 66;
      },
    },
  ];
  let acc = 0;
  for (const s of SHOTS) { s.start = acc; acc += s.dur; }

  const film = { shots: SHOTS, fps: 30, sub: 3, t: 0, shot: null, target: null, total: acc, hdr: false, op: false, title: 0, trace: null, stats: null };

  // the Operation pieces the film uses, made once with a fixed seed
  function init() {
    if (LZ) return;
    const r = Math.random;
    Math.random = mulberry32(4711);
    if (!op.kit) op.kit = new Abilities(op);
    if (!op.heli) op.heli = new Helicopter(game);
    const lzs = op._lzs();
    LZ = lzs.find((l) => l.id === 'square') || lzs[0];
    LZM = lzs.find((l) => l.id === 'meadow') || lzs[0];
    Math.random = r;
    // film-only: a round fired from the balcony starts past the rail's collision box (the scope looks between the balusters)
    const shoot = game.shoot.bind(game);
    game.shoot = (o, d, def, st) => (film.shootSkip && game.state === 'film' ? shoot(o.clone().addScaledVector(d, film.shootSkip), d, def, st) : shoot(o, d, def, st));
    game.on('hit', (h) => { if (film.stats) { film.stats.bodies++; if (h.part === 'head') film.stats.heads++; } });
  }

  // quality overrides for the offline renderer, e.g. { aoFull: 1, reflect: 1, shadowRange: 200 }
  film.retune = (over = {}) => {
    Object.assign(engine.q, over);
    if (over.shadow) {
      engine.sun.shadow.mapSize.set(over.shadow, over.shadow);
      if (engine.sun.shadow.map) { engine.sun.shadow.map.dispose(); engine.sun.shadow.map = null; }
    }
    engine.dynamicRes = false;
    engine.renderScale = 1;
    engine.resize(engine.outW, engine.outH);
  };

  // average milliseconds per sub-frame: scene render and float read-back
  film.bench = (n = 3) => {
    const gl = engine.gl, w = engine.rw, h = engine.rh, px = new Float32Array(4), J = JITTERS[3];
    let tr = 0, td = 0;
    for (let i = 0; i <= n; i++) {
      const t0 = performance.now();
      film.advance(1 / 90, true, J[i % 3]);
      engine.renderer.setRenderTarget(film.target);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
      const t1 = performance.now();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, film.f32);
      engine.renderer.setRenderTarget(null);
      const t2 = performance.now();
      if (i > 0) { tr += t1 - t0; td += t2 - t1; }
    }
    return { render: Math.round(tr / n), read: Math.round(td / n) };
  };

  // the title as a texture: one small line of Inter
  async function titleTexture(w, h) {
    try { await document.fonts.load(`500 ${Math.round(h * 0.034)}px Inter`); } catch (e) { /* the fallback sans-serif will do */ }
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `500 ${Math.round(h * 0.034)}px Inter, "Segoe UI", Arial, sans-serif`;
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = h * 0.012; g.fillStyle = '#ffffff';
    if ('letterSpacing' in g) g.letterSpacing = `${(h * 0.034 * 0.01).toFixed(1)}px`;
    g.fillText('Valle Morta', w / 2, h * 0.62);
    const t = new THREE.CanvasTexture(cv);
    t.flipY = true; t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
    return t;
  }

  // mode: 'hdr' (PQ / BT.2020, 10 bit) or 'sdr' (BT.709, 8 bit); w = 0 keeps the window (stills)
  film.prepare = async (w, h, mode, over = null) => {
    vm.stop();
    engine.syncSky = true;
    game.ui = null;
    init();
    engine.dynamicRes = false;
    if (w && h) {
      engine.renderScale = 1;
      engine.resize(w, h);
      if (over) film.retune(over); else film.retune({});
    }
    film.hdr = mode === 'hdr';
    film.mode = mode || 'screen';
    const ps = engine.post.settings;
    if (w && h) {
      ps.mode = film.hdr ? 3 : 0; ps.peak = 4.0; ps.paperWhite = 203;
      const rt = () => new THREE.WebGLRenderTarget(engine.rw, engine.rh, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      film.target = rt();   // one finished sub-frame (PQ or sRGB code values)
      film.acc = rt();      // the average of the sub-frames of one output frame
      film.addPass = new Pass(ADD_FS, { tSrc: { value: null }, uW: { value: 1 } }, { blending: THREE.AdditiveBlending });
      film.titlePass = new Pass(TITLE_FS, { tTitle: { value: await titleTexture(engine.rw, engine.rh) }, uA: { value: 0 }, uWhite: { value: film.hdr ? 0.58 : 0.95 } }, { blending: THREE.NormalBlending });
      film.f32 = new Float32Array(engine.rw * engine.rh * 4);
      film.yuv = film.hdr ? new Uint16Array((engine.rw * engine.rh * 3) / 2) : new Uint8Array((engine.rw * engine.rh * 3) / 2);
    } else { ps.mode = 0; film.target = null; }
    return { w: engine.rw, h: engine.rh, fps: film.fps, shots: SHOTS.map((s) => ({ name: s.name, start: s.start, duration: s.dur, frames: Math.round(s.dur * film.fps) })) };
  };

  // nothing of an earlier shot stays: Operation pieces, blood, particles
  function resetWorld() {
    if (op.kit) op.kit.clear();
    if (op.kit) { op.kit.time = 0; op.kit.lastWhistle = -9; op.kit.stats.crushed = 0; op.kit.stats.blastKills = 0; op.kit.stats.blastHits = 0; op.kit.tsTarget = 1; op.kit.ts = 1; }
    if (op.heli) { op.heli.hide(); op.heli.time = 0; op.heli.washT = 0; }
    op.phase = 'idle'; op.abilities = []; film.op = false;
    game.timeScale = 1; p.vehicle = null; game.pulse = 0;
    const fx = game.fx;
    fx.rnd = Math.random; fx.n = 0;
    fx.splatI = 0; if (fx.splats) fx.splats.count = 0;
    fx.poolI = 0; if (fx.poolMesh) fx.poolMesh.count = 0; if (fx.wetMesh) fx.wetMesh.count = 0;
    if (fx.pools) for (const q of fx.pools) q.done = true;
  }

  // tape: true starts the game's sound tape for this shot (clock: film time since the shot's first frame)
  film.begin = (i, tape = false) => {
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
    film.title = 0; film.shootSkip = 0; film.trace = film.tracing ? [] : null;
    game.stats.shots = 0; game.stats.hits = 0; film.stats = { bodies: 0, heads: 0 };
    const warm = s.warm || 0;
    film.t = -warm; engine.time = s.start - warm;
    film.taping = false;
    if (tape && game.audio && typeof game.audio.startTape === 'function') { game.audio.startTape(() => film.t); film.taping = true; }
    if (s.setup) s.setup();
    // settle animation / navigation, then pre-roll so the action is already moving at the cut
    for (let k = 0; k < 8; k++) film.advance(0, false);
    const n = Math.round(warm * film.fps);
    for (let k = 0; k < n; k++) film.advance(1 / film.fps, false);
    film.t = 0; engine.time = s.start;
    if (film.trace) film.trace.length = 0;
  };
  film.endTape = () => {
    if (!film.taping) return null;
    film.taping = false;
    try { return game.audio.stopTape(); } catch (e) { return null; }
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
    // moving sound sources for the tape (the recorder keeps about ten a second)
    if (film.taping && game.audio.setLoopPos) {
      if (op.heli && op.heli.state !== 'gone') game.audio.setLoopPos('heli_loop', op.heli.group.position);
      const tk = op.kit && op.kit.tanks[0];
      if (tk) { game.audio.setLoopPos('tank_engine', tk.pos); game.audio.setLoopPos('tank_tracks', tk.pos); }
    }
    if (film.trace && dt > 0) film.trace.push([+film.t.toFixed(4), +p.yaw.toFixed(5), +p.pitch.toFixed(5), +(p.recoilPitch + p.swayPitch).toFixed(5), weapon.shots]);
    // fade in at the very start of the film, fade out at its end
    const T = s.start + film.t;
    engine.post.settings.fade = Math.min(ease(T / 1.0), ease((film.total - T) / 1.2));
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

  // Renders output frame f of the current shot: `sub` jittered sub-frames averaged
  // on the GPU, the title drawn over, read back once and converted here to planar
  // Y'CbCr 4:2:0 (limited range): 10-bit BT.2020 for HDR, 8-bit BT.709 for SDR.
  film.frame = async (f, url) => {
    const dt = 1 / (film.fps * film.sub), J = JITTERS[film.sub] || JITTERS[3];
    const r = engine.renderer, gl = engine.gl, w = engine.rw, h = engine.rh;
    r.setRenderTarget(film.acc); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    film.addPass.uniforms.uW.value = 1 / film.sub;
    for (let k = 0; k < film.sub; k++) {
      film.advance(dt, true, J[k % J.length]);
      film.addPass.uniforms.tSrc.value = film.target.texture;
      film.addPass.render(r, film.acc);
    }
    if (film.title > 0.001) { film.titlePass.uniforms.uA.value = film.title; film.titlePass.render(r, film.acc); }
    r.setRenderTarget(film.acc);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, film.f32);
    r.setRenderTarget(null);
    const src = film.f32, out = film.yuv, hdr = film.hdr;
    const kr = hdr ? 0.2627 : 0.2126, kg = hdr ? 0.678 : 0.7152, kb = hdr ? 0.0593 : 0.0722, db = hdr ? 1.8814 : 1.8556, dr = hdr ? 1.4746 : 1.5748;
    const y0f = hdr ? 64.5 : 16.5, ys = hdr ? 876 : 219, c0 = hdr ? 512.5 : 128.5, cs = hdr ? 896 : 224;
    const W2 = w >> 1, H2 = h >> 1, U0 = w * h, V0 = U0 + W2 * H2;
    const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    for (let by = 0; by < H2; by++) {
      // GL rows run bottom-up, video rows top-down
      const g0 = (h - 1 - 2 * by) * w * 4, g1 = (h - 2 - 2 * by) * w * 4;
      const yA = 2 * by * w, yB = yA + w;
      for (let bx = 0; bx < W2; bx++) {
        const x = 2 * bx, a = g0 + x * 4, b = g1 + x * 4;
        const r0 = cl(src[a]), G0 = cl(src[a + 1]), b0 = cl(src[a + 2]), r1 = cl(src[a + 4]), G1 = cl(src[a + 5]), b1 = cl(src[a + 6]);
        const r2 = cl(src[b]), G2 = cl(src[b + 1]), b2 = cl(src[b + 2]), r3 = cl(src[b + 4]), G3 = cl(src[b + 5]), b3 = cl(src[b + 6]);
        const Y0 = kr * r0 + kg * G0 + kb * b0, Y1 = kr * r1 + kg * G1 + kb * b1, Y2 = kr * r2 + kg * G2 + kb * b2, Y3 = kr * r3 + kg * G3 + kb * b3;
        out[yA + x] = y0f + ys * Y0; out[yA + x + 1] = y0f + ys * Y1;
        out[yB + x] = y0f + ys * Y2; out[yB + x + 1] = y0f + ys * Y3;
        out[U0 + by * W2 + bx] = c0 + cs * (b0 + b1 + b2 + b3 - Y0 - Y1 - Y2 - Y3) * 0.25 / db;
        out[V0 + by * W2 + bx] = c0 + cs * (r0 + r1 + r2 + r3 - Y0 - Y1 - Y2 - Y3) * 0.25 / dr;
      }
    }
    const res = await fetch(url, { method: 'POST', body: out });
    if (!res.ok) throw new Error('encoder refused frame');
    return true;
  };

  // the state that matters, for the logs
  function state(i) {
    const z = zombies.list, r1 = (v) => Math.round(v * 10) / 10;
    const boss = z.find((q) => q.def && q.def.boss), tk = op.kit && op.kit.tanks[0], h = op.heli;
    const out = {
      shot: SHOTS[i].name, t: +film.t.toFixed(2), alive: z.filter((q) => q.alive).length, dead: z.filter((q) => !q.alive).length,
      wpn: weapon.visible ? `${weapon.id}${weapon.act ? ':' + weapon.act.name : ''} ${weapon.st.ammo}${weapon.scoped ? ' scoped' : ''}${weapon.bipod ? ' bipod' : ''}` : '-',
      stance: p.stance, cam: [r1(cam.position.x), r1(cam.position.y - gy(cam.position.x, cam.position.z)), r1(cam.position.z)],
      fired: game.stats.shots, hit: game.stats.hits, heads: film.stats.heads,
    };
    if (boss) out.boss = `${Math.round(boss.health)} ${boss.state} d${r1(boss.pos.distanceTo(p.pos))}`;
    if (tk) out.tank = `${tk.state} y${r1(tk.pos.y - tk.ground)} crushed${op.kit.stats.crushed} shots${tk.shots}`;
    if (h && h.state !== 'gone') out.heli = `${h.state} t${h.t.toFixed(2)} d${r1(h.group.position.distanceTo(cam.position))}`;
    if (game.timeScale < 0.99) out.ts = +game.timeScale.toFixed(2);
    return out;
  }
  film.state = state;

  // where things are: the landing zones, the sun, and how much sky each enterable house shows from its ground floor
  film.survey = () => {
    init();
    const r1 = (v) => Math.round(v * 10) / 10, sd = engine.sun.position.clone().normalize();
    const houses = layout.buildings.filter((b) => b.enterable).map((b) => {
      let open = 0, n = 0; const c = Math.cos(b.rot), s = Math.sin(b.rot);
      for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) { const lx = i / 7 * b.w, lz = j / 7 * b.d; n++; if (!col.raycastMesh(V(b.x + lx * c - lz * s, (b.baseY || 0) + 1.2, b.z + lx * s + lz * c), UP, 40, _hit)) open++; }
      return `${b.id}:${open}/${n} f${b.floors}`;
    });
    return { lz: [LZ, LZM].map((l) => `${l.id} ${r1(l.x)},${r1(l.z)} T${op.heli.T ? r1(op.heli.T) : '?'} exit${l.exit ? 1 : 0}`), sun: [r1(sd.x), r1(sd.y), r1(sd.z)], houses: houses.join(' '), tape: typeof game.audio.startTape };
  };

  // SDR still of shot i at a fraction of its duration (for checking framing); simulated with the render's step
  film.still = (i, frac, sub = 2) => {
    film.begin(i);
    const dt = 1 / (film.fps * sub);
    const n = Math.max(1, Math.round(SHOTS[i].dur * frac * film.fps * sub));
    for (let k = 0; k < n; k++) film.advance(dt, false);
    cam.clearViewOffset(); engine.weaponCamera.clearViewOffset();
    film.advance(0, true);
    return state(i);
  };

  // the aim trace of shot i: [t, yaw, pitch, recoil+sway, rounds fired] at the render's step, no drawing
  film.traceShot = (i, sub = 2) => {
    film.tracing = true;
    film.begin(i);
    const dt = 1 / (film.fps * sub), n = Math.round(SHOTS[i].dur * film.fps * sub);
    for (let k = 0; k < n; k++) film.advance(dt, false);
    film.tracing = false;
    return { trace: film.trace, state: state(i) };
  };

  return film;
}
