// Operation: the run-based mode. A helicopter sets the player down, the waves escalate without
// end, kills and cleared waves earn salvage, and after every fifth cleared wave the helicopter
// comes back for half a minute. Extracting banks everything plus a bonus, dying banks half.
// The profile's upgrades reach the game through the hooks on the player and the weapons.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { enhance } from '../engine/materials.js';
import { INFECTED } from './zombies.js';
import { SLOT_KEYS, stockBuild, abilityItem } from './progress.js';
import { Abilities } from './abilities.js';

export const SALVAGE = { walker: 5, runner: 7, brute: 25, boss: 150, head: 1.5, wave: [20, 10] };   // per kill; per cleared wave: 20 + 10 * wave
export const EXTRACT = { every: 5, window: 30, bonus: 0.25, keep: 0.5, reach: 5.5, board: 0.9, ride: 3.2 };
export const INSERT = { out: 0.9, wait: 1.2, firstWave: 4 };
// each wave beyond the first: more of them, tougher, and the walkers and runners a little quicker
export const CURVE = { count: 0.12, health: 0.05, walker: 0.04, walkerMax: 0.6, runner: 0.015, runnerMax: 0.2 };
const REGEN = { delay: 5, rate: 5 };      // the player's own figures (player.js); "second wind" shortens the wait
const BURN_TIME = 4;
// Flight paths, measured from the landing zone: D metres out, H metres up, curving C metres to the side, flown in T seconds
// (slack: extra seconds where roofs stand close and it has to hover and sink straight down). vmax: fastest climb or descent.
const PATH = { in: { D: 170, H: 34, C: 45, T: 7, slack: 1 }, far: { D: 320, H: 55, C: 70, T: 10, slack: 3 }, out: { D: 380, H: 60, C: 80, T: 12, slack: 4 }, vmax: 7.5 };
// room a landing zone needs: free radius at blade height (the rotor measures 6 m) and at body height, and a lane for the tail boom
const ROOM = { rotor: 7, body: 4.8, tail: 10.2 };
// step: grid of the search round the nominal point; best: take the most open spot in reach instead of the first that will do
const LZ = [
  { id: 'meadow', name: 'the meadow south of the river', x: -52, z: 104, look: [38, -90], search: 45, step: 3, best: false },
  { id: 'square', name: 'the village square', x: 44, z: -92, look: [56, -100], search: 9, step: 1, best: true },
];
const N = 128;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3(), _cp = new THREE.Vector3();
const _q = new THREE.Quaternion(), _cq = new THREE.Quaternion(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const TAU = Math.PI * 2, RAD = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

// highest thing under a point: ground, roof, wall or trunk
function topAt(game, x, z, hit) {
  const y = game.terrain.heightAt(x, z);
  const h = game.collision.raycastMesh(_b.set(x, y + 70, z), DOWN, 70, hit);
  return h ? Math.max(y, y + 70 - h.distance) : y;
}

// ---------------------------------------------------------------- helicopter
// A utility helicopter built from lofted sections: olive drab, no markings. Origin on the ground
// under the rotor mast, nose along -Z, +X to starboard; the cabin doors are open on both sides.

// skin over a row of cross-sections [z, half width, half height, centre y, squareness]
function loft(st, { seg = 22, a0 = -Math.PI / 2, a1 = Math.PI * 1.5, grow = 1, caps = true } = {}) {
  const pos = [], uv = [], idx = [], cols = seg + 1, full = a1 - a0 > TAU - 1e-4;
  const ring = (s, j, out) => {
    const a = a0 + (a1 - a0) * (j / seg), c = Math.cos(a), sn = Math.sin(a), e = 2 / s[4];
    out.push(Math.sign(c) * Math.pow(Math.abs(c), e) * s[1] * grow, s[3] + Math.sign(sn) * Math.pow(Math.abs(sn), e) * s[2] * grow, s[0]);
  };
  for (const s of st) for (let j = 0; j < cols; j++) { ring(s, j, pos); uv.push(s[0] * 0.35, (j / seg) * 2.5); }
  for (let i = 0; i < st.length - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const cap = (s, front) => {
    const base = pos.length / 3;
    pos.push(0, s[3], s[0]); uv.push(0, 0);
    for (let j = 0; j < cols; j++) { ring(s, j, pos); uv.push(pos[pos.length - 3] * 0.35, pos[pos.length - 2] * 0.35); }
    for (let j = 0; j < seg; j++) { if (front) idx.push(base, base + 2 + j, base + 1 + j); else idx.push(base, base + 1 + j, base + 2 + j); }
  };
  if (full && caps) { cap(st[0], true); cap(st[st.length - 1], false); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g.toNonIndexed();
}
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const tube = (ax, ay, az, bx, by, bz, r, seg = 8) => {
  const d = _b.set(bx - ax, by - ay, bz - az), len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.applyQuaternion(_q.setFromUnitVectors(UP, d.normalize()));
  return g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
};
const merge = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));

// painted aluminium: weathered olive, panel seams and rivet rows
function hullTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  let s = 77;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  g.fillStyle = '#4c5234'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(${rnd() < 0.55 ? '22,26,12' : '128,132,92'},${0.025 + rnd() * 0.05})`; g.fillRect(rnd() * 256 - 20, rnd() * 256 - 10, 10 + rnd() * 50, 4 + rnd() * 28); }
  g.fillStyle = 'rgba(16,18,9,0.5)';
  for (const v of [0, 64, 128, 192]) { g.fillRect(v, 0, 1, 256); g.fillRect(0, v, 256, 1); }
  g.fillStyle = 'rgba(14,16,8,0.42)';
  for (let x = 8; x < 256; x += 16) for (const v of [0, 64, 128, 192]) { g.fillRect(x, v + 4, 1.5, 1.5); g.fillRect(v + 4, x, 1.5, 1.5); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
// what a turning rotor looks like: a faint disc with the two blades smeared round it and a ring where the painted tips run
function discTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const cg = g.createConicGradient(0, 128, 128);
  for (let i = 0; i <= 48; i++) cg.addColorStop(i / 48, `rgba(24,26,23,${(0.15 + 0.4 * Math.pow(0.5 + 0.5 * Math.cos((i / 48) * TAU * 2), 4)).toFixed(3)})`);
  g.fillStyle = cg; g.beginPath(); g.arc(128, 128, 127, 0, TAU); g.fill();
  const rg = g.createRadialGradient(128, 128, 0, 128, 128, 127);
  rg.addColorStop(0, 'rgba(0,0,0,1)'); rg.addColorStop(0.9, 'rgba(0,0,0,1)'); rg.addColorStop(0.97, 'rgba(0,0,0,0.7)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalCompositeOperation = 'destination-in'; g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
  g.globalCompositeOperation = 'source-over'; g.strokeStyle = 'rgba(188,164,84,0.3)'; g.lineWidth = 3;
  g.beginPath(); g.arc(128, 128, 120, 0, TAU); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Helicopter {
  constructor(game) {
    this.game = game;
    this.state = 'gone';        // gone | in | ground | out
    this.t = 0; this.T = 7; this.time = 0; this.sign = -1; this.P = PATH.in; this.ys = null; this.wv = 0;
    this.lz = null; this.box = null; this.hold = false; this.inside = false; this.washT = 0;
    this.seat = new THREE.Vector3(0.15, 1.66, 0.1);       // eye of someone sitting on the cabin floor, looking out of the starboard door
    this._hit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
    this._build();
  }

  _build() {
    const mk = (opts, key) => enhance(new THREE.MeshStandardMaterial(opts), { key });
    const NOSE = [[-4.25, 0.16, 0.14, 1.16, 2], [-4.05, 0.56, 0.42, 1.2, 2.2], [-3.6, 0.9, 0.66, 1.3, 2.5], [-3.0, 1.08, 0.82, 1.45, 2.8], [-2.3, 1.15, 0.86, 1.56, 3.2], [-0.9, 1.15, 0.86, 1.56, 3.6]];
    const REAR = [[1.0, 1.15, 0.86, 1.56, 3.6], [1.9, 1.0, 0.8, 1.62, 3], [2.9, 0.62, 0.62, 1.8, 2.4], [3.7, 0.36, 0.4, 1.95, 2], [8.6, 0.15, 0.17, 2.2, 2]];
    const COWL = [[-0.75, 0.3, 0.1, 2.48, 2.5], [-0.2, 0.52, 0.3, 2.62, 2.8], [1.6, 0.55, 0.32, 2.66, 2.8], [2.7, 0.4, 0.24, 2.62, 2.5], [3.3, 0.18, 0.1, 2.46, 2]];
    const DOOR = [[-2.25, 1.15, 0.86, 1.56, 3.2], [-1.15, 1.15, 0.86, 1.56, 3.6]];
    const fin = new THREE.ExtrudeGeometry(new THREE.Shape([[7.6, 2.3], [8.75, 3.8], [9.1, 3.8], [8.85, 2.05], [8.3, 2.05]].map((p) => new THREE.Vector2(p[0], p[1]))), { depth: 0.07, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(0.035, 0, 0);
    const hull = merge([
      loft(NOSE), loft(REAR), loft(COWL), fin,
      box(2.3, 0.16, 1.9, 0, 0.78, 0.05),            // cabin floor
      box(2.3, 0.2, 1.9, 0, 2.32, 0.05),             // cabin roof
      box(2.6, 0.05, 0.45, 0, 2.08, 6.3),            // stabiliser
    ]);
    // a lighter lining inside the cabin, so the floor, the roof and the bulkheads read against each other in the shade
    const lining = merge([box(2.24, 0.02, 1.86, 0, 0.87, 0.05), box(2.24, 0.02, 1.86, 0, 2.21, 0.05), box(2.2, 1.32, 0.02, 0, 1.54, -0.885), box(2.2, 1.32, 0.02, 0, 1.54, 0.985)]);
    const glass = merge([
      loft(NOSE.slice(1, 5), { a0: 24 * RAD, a1: 84 * RAD, grow: 1.012, seg: 8 }), loft(NOSE.slice(1, 5), { a0: 96 * RAD, a1: 156 * RAD, grow: 1.012, seg: 8 }),     // windscreen halves
      loft(NOSE.slice(1, 4), { a0: 208 * RAD, a1: 252 * RAD, grow: 1.012, seg: 6 }), loft(NOSE.slice(1, 4), { a0: 288 * RAD, a1: 332 * RAD, grow: 1.012, seg: 6 }),   // chin windows
      loft(DOOR, { a0: -14 * RAD, a1: 20 * RAD, grow: 1.012, seg: 5 }), loft(DOOR, { a0: 160 * RAD, a1: 194 * RAD, grow: 1.012, seg: 5 }),                           // cockpit doors
    ]);
    const metal = [
      tube(0, 2.9, 0.35, 0, 3.44, 0.35, 0.06), new THREE.CylinderGeometry(0.2, 0.2, 0.1, 12).translate(0, 3.46, 0.35), tube(-0.9, 3.36, 0.35, 0.9, 3.36, 0.35, 0.015),   // mast, hub, stabiliser bar
      tube(0, 2.62, 3.1, 0, 2.74, 3.55, 0.15), tube(0.04, 3.05, 8.72, -0.22, 3.05, 8.72, 0.05), tube(0, 2.03, 8.25, 0, 1.55, 8.8, 0.02),                               // exhaust, tail gearbox, tail skid
    ];
    for (const s of [-1, 1]) {
      metal.push(tube(s * 1.12, 0.04, -2.3, s * 1.12, 0.04, 1.9, 0.04), tube(s * 1.12, 0.04, -2.3, s * 1.12, 0.3, -2.72, 0.04));       // skid and its toe
      metal.push(tube(s * 1.12, 0.04, -1.3, s * 0.66, 0.74, -1.3, 0.035), tube(s * 1.12, 0.04, 1.15, s * 0.66, 0.74, 1.15, 0.035));    // cross tubes
      metal.push(tube(s * 1.06, 2.14, -0.82, s * 1.06, 2.14, 0.92, 0.018), tube(s * 1.08, 0.9, -0.86, s * 1.08, 2.2, -0.86, 0.02));    // grab rail, door post handle
    }
    const disc = mk({ map: discTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6, metalness: 0 }, 'heli-rotor');
    const g = this.group = new THREE.Group();
    const add = (geo, mat, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; m.receiveShadow = shadow; g.add(m); return m; };
    add(hull, mk({ map: hullTexture(), roughness: 0.74, metalness: 0.12 }, 'heli-hull'));
    add(lining, mk({ color: 0x80856f, roughness: 0.92, metalness: 0 }, 'heli-lining'));
    add(glass, mk({ color: 0x0b1013, roughness: 0.1, metalness: 0.85 }, 'heli-glass'));
    add(merge(metal), mk({ color: 0x1c1e1f, roughness: 0.5, metalness: 0.8 }, 'heli-metal'));
    this.rotor = add(new THREE.RingGeometry(0.22, 6, 56, 1).rotateX(-Math.PI / 2), disc, false);
    this.rotor.position.set(0, 3.47, 0.35);
    this.tail = add(new THREE.RingGeometry(0.06, 1.25, 28, 1).rotateY(Math.PI / 2), disc, false);
    this.tail.position.set(-0.22, 3.05, 8.72);
    this.rotor.renderOrder = this.tail.renderOrder = 910;      // after the sky dome: it is drawn late and paints over anything that leaves no depth
  }

  _top(x, z) { return topAt(this.game, x, z, this._hit); }

  // where the path is at w (0 at the landing zone, 1 at the far end), on the ground plane; below wv it hangs over the zone
  _xz(lz, w, sign, P, out, wv = 0) {
    const wh = wv > 0 ? Math.max(0, (w - wv) / (1 - wv)) : w;
    const d = P.D * (1 - wv) * Math.pow(wh, 1.9), o = P.C * wh * wh * wh;
    return out.set(lz.x + sign * lz.fx * d + lz.rx * o, 0, lz.z + sign * lz.fz * d + lz.rz * o);
  }

  // Heights along a path and how it is flown. Over open ground it is one long curve down to the skids.
  // With roofs under the blade tips it comes to a hover above them (hv metres up) and sinks straight down for the first wv of the path.
  _profile(lz, sign, P) {
    const ys = new Float32Array(N + 1), req = new Float32Array(N + 1);
    const over = (x, z) => {
      let body = lz.y, tips = lz.y;
      for (const l of [0, -1.6, 1.6]) body = Math.max(body, this._top(x + lz.rx * l, z + lz.rz * l));
      for (const l of [-3.5, 3.5, -6.3, 6.3]) tips = Math.max(tips, this._top(x + lz.rx * l, z + lz.rz * l));
      return Math.max(body, tips - 2.5);          // the rotor turns three and a half metres above the skids
    };
    let hv = 0;
    for (const d of [3, 4.5, 6]) hv = Math.max(hv, over(lz.x + sign * lz.fx * d, lz.z + sign * lz.fz * d) + 0.8 - lz.y);
    if (hv < 2.5) hv = 0;
    const T = P.T + (hv ? P.slack : 0), iv = hv ? Math.ceil(clamp((hv / 4 + 0.6) / T, 0, 0.45) * N) : 0, wv = iv / N;
    for (let i = iv + 1; i <= N; i++) {
      const w = i / N, wh = (w - wv) / (1 - wv);
      this._xz(lz, w, sign, P, _a, wv);
      const x = _a.x, z = _a.z, d = Math.hypot(x - lz.x, z - lz.z);
      req[i] = Math.max(lz.y + hv, d < 2.5 ? lz.y : over(x, z) + 3 * smooth((d - 2.5) / 8) + 9 * smooth((d - 9) / 36));
      ys[i] = Math.max(lz.y + hv + P.H * Math.pow(wh, 1.35), req[i]);
    }
    // it climbs and sinks no faster than vmax
    const L = (PATH.vmax * T) / N;
    ys[iv] = lz.y + hv;
    for (let i = iv + 1; i <= N; i++) ys[i] = Math.max(ys[i], ys[i - 1] - L);
    for (let i = N - 1; i > iv; i--) ys[i] = Math.max(ys[i], ys[i + 1] - L);
    for (let i = iv + 1; i < N; i++) req[i] = ys[i];
    for (let pass = 0; pass < 4; pass++) {
      let prev = ys[iv];
      for (let i = iv + 1; i < N; i++) { const cur = ys[i]; ys[i] = Math.max(req[i], (prev + 2 * cur + ys[i + 1]) / 4); prev = cur; }
    }
    // the hover and the vertical part underneath it
    const top = iv < N ? Math.max(lz.y + hv, ys[iv + 1] - L) : lz.y + hv;
    for (let i = 0; i <= iv; i++) ys[i] = lz.y + (iv ? (top - lz.y) * smooth(i / iv) : 0);
    return { ys, T, wv };
  }

  _place(w) {
    const lz = this.lz, P = this.P, sign = this.sign, g = this.group, wv = this.wv;
    w = clamp(w, 0, 1);
    const wh = wv > 0 ? Math.max(0, (w - wv) / (1 - wv)) : w;
    this._xz(lz, w, sign, P, _a, wv);
    const f = w * N, i = Math.min(N - 1, Math.floor(f)), y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * (f - i);
    // it turns to starboard all the way in (and again on the way out), banked into the turn; nose up as it slows, down as it gathers speed
    const turn = Math.atan2(3 * P.C * wh * wh, 1.9 * P.D * (1 - wv) * Math.pow(wh, 0.9) + 1e-4);
    const pitch = sign < 0 ? (wh > 0.75 ? -0.05 * smooth((wh - 0.75) / 0.25) : 0.17 * Math.sin((Math.PI * wh) / 0.75)) : -0.05 * smooth(wh / 0.6) - 0.11 * Math.sin(Math.PI * Math.min(1, wh / 0.6));
    g.position.set(_a.x, y + Math.sin(this.time * 2.1) * 0.03 * Math.min(1, w * 6), _a.z);
    g.quaternion.setFromEuler(_e.set(pitch, lz.yaw - sign * turn, -0.26 * Math.pow(wh, 0.9), 'YXZ'));
    const settle = w / Math.max(0.15, wv);
    if (settle < 1) g.quaternion.slerp(lz.quat, 1 - settle);       // the skids settle onto the slope
  }

  _fly(key, sign) {
    const lz = this.lz, P = this.P = PATH[key];
    const pr = lz.prof[key] || (lz.prof[key] = this._profile(lz, sign, P));
    this.sign = sign; this.ys = pr.ys; this.wv = pr.wv; this.T = pr.T; this.t = 0;
  }

  arrive(lz, far = false) {
    this.hide();
    this.lz = lz; this.hold = false;
    this._fly(far ? 'far' : 'in', -1);
    this.state = 'in';
    this.game.engine.scene.add(this.group);
    this._place(1);
    this.game.audio.loop('heli_loop', 0.0001, 0.4);
  }

  _land() {
    const lz = this.lz;
    this.state = 'ground'; this.t = 1;
    this.group.position.set(lz.x, lz.y, lz.z);
    this.group.quaternion.copy(lz.quat);
    // the fuselage is solid while it stands there
    this.box = this.game.collision.addBox({ x: lz.x + lz.fx * 1.1, y: lz.y - 0.1, z: lz.z + lz.fz * 1.1, hx: 1.2, hz: 3.2, h: 2.5, yaw: lz.yaw, surface: 'metal' });
  }

  // hold: it never reaches the end of the path (someone is looking out of the door)
  depart(hold = false) {
    if (this.state !== 'ground') return false;
    this._unbox();
    this._fly('out', 1);
    this.hold = hold;
    if (hold) this.T *= 1.5;
    this.state = 'out';
    return true;
  }

  _unbox() { if (this.box) { this.game.collision.removeBox(this.box); this.box = null; } }

  hide() {
    if (this.state === 'gone') return;
    this._unbox();
    this.game.engine.scene.remove(this.group);
    this.state = 'gone'; this.inside = false; this.hold = false;
    this.game.audio.stopLoop('heli_loop', 0.8);
  }

  update(dt) {
    if (this.state === 'gone') return;
    const g = this.game, pos = this.group.position;
    this.time += dt;
    this.rotor.rotation.y -= dt * 12.5; this.tail.rotation.x += dt * 27;
    if (this.state === 'in') {
      this.t += dt / this.T;
      if (this.t >= 1) this._land(); else this._place(1 - this.t);
    } else if (this.state === 'out') {
      this.t += dt / this.T;
      if (this.hold) this._place(1 - Math.exp(-2.2 * this.t));
      else if (this.t >= 1) { this.hide(); return; }
      else this._place(this.t);
    }
    // rotor wash lifts dust off dry ground
    const alt = pos.y - this.lz.y;
    if (alt < 9) {
      this.washT -= dt * (this.state === 'ground' ? 7 : 18) * (1 - alt / 9);
      while (this.washT < 0) {
        this.washT += 1;
        const a = Math.random() * TAU, r = 3 + Math.random() * 4.5, c = Math.cos(a), s = Math.sin(a), x = pos.x + c * r, z = pos.z + s * r, v = 3 + Math.random() * 2.5;
        if (g.collision.waterDepth(x, z) > 0) continue;
        g.fx.spawn({ x, y: g.terrain.heightAt(x, z) + 0.1, z, vx: c * v, vy: 0.3 + Math.random() * 0.5, vz: s * v, size: 0.35, grow: 1.5, life: 0.9 + Math.random() * 0.5, drag: 1.6, r: 0.5, g: 0.46, b: 0.38, a: 0.06 });
      }
    }
    const d = g.engine.camera.position.distanceTo(pos);
    g.audio.setLoopVolume('heli_loop', this.inside ? 0.85 : Math.min(0.85, 1.15 / (1 + Math.pow(d / 24, 1.7))), 0.25);
  }

  // the view from the cabin floor through the open starboard door
  seatPose(pos, quat) {
    const g = this.group, t = this.time;
    g.updateMatrixWorld(true);
    pos.copy(this.seat).applyMatrix4(g.matrixWorld);
    pos.y += Math.sin(t * 47) * 0.0025;
    _e.set(-0.05 + Math.sin(t * 0.9) * 0.012 + Math.sin(t * 39) * 0.0015, -Math.PI / 2 + 0.1 + Math.sin(t * 0.53) * 0.04, 0, 'YXZ');
    quat.copy(g.quaternion).multiply(_q.setFromEuler(_e));
  }
}

// ---------------------------------------------------------------- operation
export class Operation {
  constructor(game, progress) {
    this.game = game; this.progress = progress;
    this.phase = 'idle';             // idle | insertion | run | boarding | riding
    this.build = stockBuild();
    // The loadout for this run, one object per equipped ability:
    //   { id, slot (0..2), key ('G' | '4' | '5'), name, short, level (1..3), cooldown, duration, params,
    //     cd (seconds until ready), active (seconds still running), ready, uses }
    // Cooldown runs from the moment of use. The effect is whatever registerAbility(id, ...) plugged in.
    this.abilities = [];
    this.effects = {};
    this.salvage = 0; this.gain = 0; this.gainSeq = 0;      // gathered this run; the last amount and a counter for the HUD
    this.cleared = 0; this.startWave = 1;
    this.fresh = false;              // no wave of this run has started yet: the director counts down whoever is still wandering about
    this.extraction = null;          // while the helicopter is on its way or waiting: { state: 'inbound' | 'waiting', pos, dist, timeLeft, window, lz }
    this.heli = null; this.lz = null; this.lzs = null; this.nextLz = null;
    this.riding = false; this.outT = 0; this.leaveT = 0; this.boardT = 0; this.rideT = 0;
    this.burning = new Map();
    this._from = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this._hit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
    game.on('wave', () => { this.fresh = false; })
      .on('kill', (z, part) => this._onKill(z, part))
      .on('waveCleared', (wave) => this._onCleared(wave))
      .on('crate', (crate) => this._onCrate(crate))
      .on('crateOpened', (crate, got) => this._onCrateOpened(crate, got))
      .on('hit', (h, def, st) => { if (this.phase === 'run' && st && st.mod.burn > 0 && h.zombie && h.zombie.alive) this.burning.set(h.zombie, { t: BURN_TIME, dps: st.mod.burn, puff: 0 }); });
  }

  get active() { return this.phase !== 'idle'; }
  // the helicopter has the camera: no HUD, no input
  get cinematic() { return this.phase === 'insertion' || this.phase === 'boarding' || this.phase === 'riding'; }

  // plug an ability in: { start(ab, game) -> false to refuse, update(ab, dt, game), end(ab, game) }
  registerAbility(id, impl) { this.effects[id] = impl; return this; }

  // ---- kit: the profile's upgrades for an Operation run, the stock kit for anything else
  prepare(mode) {
    this.stop();
    const b = this.build = mode === 'operation' ? this.progress.build() : stockBuild();
    const p = this.game.player, w = this.game.weapon, m = b.player;
    Object.assign(p.mods, { maxHealth: m.maxHealth, armour: m.armour, sprint: m.sprint, heal: m.heal, bandageMax: m.bandageMax, fall: m.fall });
    for (const id in b.weapon) {
      const s = w.state[id], k = b.weapon[id];
      if (!s) continue;
      Object.assign(s.mod, { damage: k.damage, mag: k.mag, reload: k.reload, recoil: k.recoil, bodies: k.bodies, pellets: k.pellets, burn: k.burn });
      w.setOwned(id, !!k.owned);
    }
  }

  // called by game.start once the world is reset: load up and fly in
  begin() {
    const g = this.game, p = g.player, b = this.build;
    if (!this.kit) this.kit = new Abilities(this);          // the ability effects, fitted on the first run
    this.salvage = 0; this.gain = 0; this.gainSeq = 0; this.cleared = 0; this.extraction = null; this.riding = false; this.outT = 0;
    for (const id in b.weapon) { const s = g.weapon.state[id]; if (s && Number.isFinite(s.reserve)) s.reserve = Math.round(s.def.reserve * b.weapon[id].reserve); }
    p.bandages = Math.min(p.bandageMax, 1 + b.run.bandages);
    this.startWave = b.run.startWave;
    g.wave = this.startWave - 1; g.cleared = true; g.interT = 1e9; this.fresh = true;          // the director waits for the hand-over
    this.abilities = [];
    this.progress.loadout.forEach((key, slot) => {
      const item = key ? abilityItem(key) : null, level = item ? this.progress.level(item.id) : 0;
      if (!level) return;
      const a = item.ability, i = level - 1, params = {};
      for (const k in a.params) params[k] = Array.isArray(a.params[k]) ? a.params[k][i] : a.params[k];
      this.abilities.push({ id: key, slot, key: SLOT_KEYS[slot], name: item.name, short: a.short, level, cooldown: a.cooldown[i], duration: a.duration[i], params, cd: 0, active: 0, ready: true, uses: 0 });
    });
    const lz = this.lz = this._pickLz();
    // nobody stands where the helicopter comes down
    for (const z of g.zombies.list) {
      const dx = z.pos.x - lz.x, dz = z.pos.z - lz.z, d = Math.hypot(dx, dz);
      if (d > 20) continue;
      for (let k = 0; k < 8; k++) {
        const a = Math.atan2(dz, dx) + k * 0.785, r = 26 + Math.random() * 8, x = lz.x + Math.cos(a) * r, zz = lz.z + Math.sin(a) * r;
        if (g.zombies.flow.walkable(x, zz)) { g.zombies.place(z, x, zz); break; }
      }
    }
    this.heli = this.heli || new Helicopter(g);
    this.heli.arrive(lz);
    this.heli.inside = true;
    this.phase = 'insertion';
    p.enabled = false; g.weapon.visible = false; g.zombies.passive = true;
    this.heli.seatPose(g.engine.camera.position, g.engine.camera.quaternion);
    g.ui?.toast('Insertion', `Landing zone: ${lz.name}`);
  }

  // nothing of the run stays in the world (menu, Base, the next start)
  stop() {
    this._endAbilities(); this.burning.clear(); this.extraction = null; this.phase = 'idle'; this.riding = false;
    if (this.kit) this.kit.clear();
    if (this.heli) this.heli.hide();
  }

  // the run is over: 'extract' banks everything plus the bonus, 'death' and 'abandon' bank half
  finish(outcome) {
    const g = this.game, s = g.stats, out = outcome === 'extract';
    const earned = Math.round(this.salvage);
    const banked = out ? Math.round(earned * (1 + EXTRACT.bonus + this.build.run.bonus)) : Math.floor(earned * EXTRACT.keep);
    const rec = this.progress.recordRun({ outcome, wave: g.wave, cleared: this.cleared, kills: s.kills, earned, banked });
    this._endAbilities(); this.burning.clear(); this.extraction = null;
    if (this.kit) this.kit.settle();
    this.riding = out && this.phase === 'riding';
    this.phase = 'idle';
    return { mode: 'operation', outcome, wave: g.wave, cleared: this.cleared, kills: s.kills, headshots: s.headshots, accuracy: s.shots ? Math.round((100 * s.hits) / s.shots) : 0, time: g.playTime, earned, banked, balance: rec.balance, record: rec.record };
  }

  // ---- landing zones: level, dry, open ground with room for the rotor and the tail
  // nearest wall, trunk or prop at height h above a point, looking in n directions out to len
  _free(x, y, z, h, len, n) {
    const col = this.game.collision;
    let m = len;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU, r = col.raycastMesh(_a.set(x, y + h, z), _b.set(Math.cos(a), 0, Math.sin(a)), len, this._hit);
      if (r && r.distance < m) m = r.distance;
    }
    return m;
  }

  // the free radius at blade height where the helicopter could stand, 0 where it cannot
  _spot(x, z) {
    const g = this.game, col = g.collision, T = g.terrain;
    if (!g.zombies.flow.walkable(x, z) || col.waterDepth(x, z) > 0 || T.normalAt(x, z, _n).y < 0.996) return 0;
    const y = T.heightAt(x, z);
    for (let k = 0; k < 8; k++) {
      const c = Math.cos(k * 0.7854), s = Math.sin(k * 0.7854);
      if (Math.abs(T.heightAt(x + c * 2, z + s * 2) - y) > 0.16 || Math.abs(T.heightAt(x + c * 6, z + s * 6) - y) > 1.1 || col.waterDepth(x + c * 6, z + s * 6) > 0) return 0;
    }
    if (this._free(x, y, z, 1.1, ROOM.body, 16) < ROOM.body) return 0;
    for (let k = 0; k < 9; k++) {                 // nothing overhead
      const r = k ? 4.5 : 0, a = k * 0.7854;
      if (col.raycastMesh(_a.set(x + Math.cos(a) * r, y + 45, z + Math.sin(a) * r), DOWN, 44.5, this._hit)) return 0;
    }
    const free = this._free(x, y, z, 3.4, 12, 48);
    return free >= ROOM.rotor ? free : 0;
  }

  // Which way it stands: the tail boom needs a lane, the player needs room to step out to starboard, the way in
  // and out should be as open as the place allows, and otherwise the open door faces what there is to see.
  _heading(def, x, y, z) {
    const g = this.game, col = g.collision, f = g.zombies.flow, T = g.terrain;
    const want = Math.atan2(-(def.look[1] - z), def.look[0] - x);
    let best = null, bs = 1e9;
    for (let k = 0; k < 24; k++) {
      const off = (k % 2 ? -1 : 1) * Math.ceil(k / 2) * (Math.PI / 12), yaw = want + off;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const ex = x + rx * 2.7, ez = z + rz * 2.7;
      if (!f.walkable(ex, ez) || col.resolveCapsule(_a.set(ex, T.heightAt(ex, ez) + 0.05, ez), 0.5, 1.8).lengthSq() > 1e-8) continue;
      let ok = true, high = 0;
      for (const h of [2.1, 3.7]) for (const s of [-0.17, 0, 0.17]) {
        const c = Math.cos(s), sn = Math.sin(s);
        if (col.raycastMesh(_a.set(x, y + h, z), _b.set(-fx * c + fz * sn, 0, -fx * sn - fz * c), ROOM.tail, this._hit)) ok = false;
      }
      if (!ok) continue;
      for (const d of [10, 16, 23, 31, 40]) for (const l of [-7, 0, 7]) for (const s of [-1, 1]) high = Math.max(high, topAt(g, x + s * fx * d + rx * l, z + s * fz * d + rz * l, this._hit) - y);
      const score = high + Math.abs(off) * 1.5;
      if (score < bs) { bs = score; best = yaw; }
    }
    return best;
  }

  _lzAt(def, x, z, yaw) {
    const T = this.game.terrain, y = T.heightAt(x, z), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    return {
      id: def.id, name: def.name, x, y, z, yaw, fx: -Math.sin(yaw), fz: -Math.cos(yaw), rx, rz,
      exit: { x: x + rx * 2.7, z: z + rz * 2.7 }, exitYaw: yaw - Math.PI / 2 + 0.1,
      quat: new THREE.Quaternion().setFromUnitVectors(UP, T.normalAt(x, z, _n)).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw)),
      prof: {},
    };
  }

  _lzs() {
    if (this.lzs) return this.lzs;
    const T = this.game.terrain;
    this.lzs = [];
    for (const def of LZ) {
      let best = null, room = 0;
      for (let ring = 0; ring * def.step <= def.search && !(best && (!def.best || room >= 12)); ring++) {
        const n = ring ? ring * 6 : 1;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU + ring * 0.7, x = def.x + Math.cos(a) * ring * def.step, z = def.z + Math.sin(a) * ring * def.step;
          const free = this._spot(x, z);
          if (free <= room) continue;
          const yaw = this._heading(def, x, T.heightAt(x, z), z);
          if (yaw === null) continue;
          best = this._lzAt(def, x, z, yaw); room = free;
          if (!def.best) break;
        }
      }
      if (best) { best.room = room; this.lzs.push(best); }
    }
    if (!this.lzs.length) this.lzs.push(this._lzAt(LZ[0], LZ[0].x, LZ[0].z, Math.atan2(-(LZ[0].look[1] - LZ[0].z), LZ[0].look[0] - LZ[0].x)));
    return this.lzs;
  }

  _pickLz() {
    const all = this._lzs(), want = this.nextLz ? all.find((l) => l.id === this.nextLz) : null;
    this.nextLz = null;
    return want || all[Math.floor(Math.random() * all.length)];
  }

  // ---- the wave director's hooks: the Survival composer with a steeper curve
  compose(n) {
    const c = this.game._compose(n);
    const bosses = c.list.filter((t) => t === 'boss').length;
    const extra = Math.round((c.list.length - bosses) * CURVE.count * (n - 1));
    for (let i = 0; i < extra; i++) {
      const r = Math.random(), type = n >= 6 && r < 0.08 ? 'brute' : r < Math.min(0.5, 0.15 + n * 0.03) ? 'runner' : 'walker';
      c.list.splice(bosses + Math.floor(Math.random() * (c.list.length - bosses + 1)), 0, type);
    }
    if (c.kind === 'mixed') c.text = `${c.list.length} infected approaching`;
    return c;
  }

  spawnOpts(type) {
    const n = this.game.wave, def = INFECTED[type], o = { healthMult: 1 + CURVE.health * (n - 1) };
    if (def && (type === 'walker' || type === 'runner')) {
      const k = 1 + Math.min(CURVE[type + 'Max'], CURVE[type] * (n - 1));
      o.speed = (def.speed[0] + Math.random() * (def.speed[1] - def.speed[0])) * k;
    }
    return o;
  }

  // ---- salvage
  _earn(n) {
    const v = Math.max(1, Math.round(n * this.build.run.salvage));
    this.salvage += v; this.gain = v; this.gainSeq++;
    return v;
  }

  _onKill(z, part) {
    this.burning.delete(z);
    if (this.phase !== 'run') return;
    this._earn((SALVAGE[z.type] ?? SALVAGE.walker) * (part === 'head' ? SALVAGE.head : 1));
  }

  _onCleared(wave) {
    if (this.phase !== 'run') return;
    this.cleared++;
    const v = this._earn(SALVAGE.wave[0] + SALVAGE.wave[1] * wave);
    if (wave % EXTRACT.every === 0) this._callExtraction(v);
    else this.game.ui?.toast('Wave cleared', `${v} salvage · the helicopter returns after wave ${Math.ceil((wave + 1) / EXTRACT.every) * EXTRACT.every}`);
  }

  _onCrate(crate) {
    if (!this.active || !crate) return;
    const k = this.build.run.crates;
    crate.loot.rifle = Math.round(crate.loot.rifle * k); crate.loot.sniper = Math.round(crate.loot.sniper * k);
  }

  // extended reserve: what did not fit under the stock limit fits under the extended one
  _onCrateOpened(crate, got) {
    if (!this.active) return;
    for (const id of ['rifle', 'sniper']) {
      const s = this.game.weapon.state[id], k = this.build.weapon[id].reserve, rest = (crate.loot[id] || 0) - (got[id] || 0);
      if (s && s.owned && k > 1 && rest > 0) s.reserve = Math.min(Math.round(s.def.reserveMax * k), s.reserve + rest);
    }
  }

  // ---- extraction
  _callExtraction(v) {
    const g = this.game, p = g.player;
    let lz = null, bd = 1e9;
    for (const l of this._lzs()) { const d = Math.hypot(l.x - p.pos.x, l.z - p.pos.z); if (d < bd) { bd = d; lz = l; } }
    const window = EXTRACT.window + this.build.run.window;
    this.heli.arrive(lz, true);
    this.extraction = { state: 'inbound', pos: new THREE.Vector3(lz.x, lz.y, lz.z), dist: bd, timeLeft: window, window, lz };
    g.interT = 1e9;                                                  // the next wave waits until it has left
    g.audio.play('heli_distant', { volume: 0.7 });
    g.ui?.toast('Wave cleared', `${v} salvage · the helicopter is inbound to ${lz.name}`);
  }

  _extraction(dt) {
    const g = this.game, p = g.player, ex = this.extraction, heli = this.heli;
    if (!ex) return;
    ex.dist = Math.hypot(ex.pos.x - p.pos.x, ex.pos.z - p.pos.z);
    if (ex.state === 'inbound') {
      if (heli.state === 'ground') { ex.state = 'waiting'; g.ui?.toast('Extraction', `The helicopter waits ${ex.window} seconds: board it, or stay and fight on`); }
      return;
    }
    ex.timeLeft -= dt;
    if (p.alive && ex.dist < EXTRACT.reach && !g.interact) {
      g.interact = { kind: 'extract', key: 'F', text: 'Board the helicopter and extract' };
      if (p.input.interact) { this._board(); return; }
    }
    if (ex.timeLeft <= 0) {
      this.extraction = null;
      heli.depart();
      g.interT = 6;
      g.ui?.toast('The helicopter has left', `Next pickup after wave ${g.wave + EXTRACT.every}`);
    }
  }

  _board() {
    const g = this.game, cam = g.engine.camera;
    this.phase = 'boarding'; this.boardT = 0; this.extraction = null;
    g.interact = null;
    g.player.enabled = false; g.weapon.visible = false; g.zombies.passive = true;
    this._from.pos.copy(cam.position); this._from.quat.copy(cam.quaternion);
    this.heli.inside = true;
    this._endAbilities();
  }

  // ---- abilities: timers and input here, effects plugged in from outside
  useAbility(slot) {
    const g = this.game, ab = this.abilities.find((a) => a.slot === slot);
    if (!ab || this.phase !== 'run') return false;
    if (!ab.ready) { g.audio.play('ui_error', { volume: 0.3 }); return false; }
    const fx = this.effects[ab.id];
    if (!fx || !fx.start) { g.ui?.toast(ab.name, 'Not fitted yet'); return false; }
    if (fx.start(ab, g) === false) return false;
    ab.active = ab.duration; ab.cd = ab.cooldown; ab.ready = false; ab.uses++;
    g.emit('ability', ab);
    return true;
  }

  _abilities(dt) {
    const g = this.game, p = g.player;
    for (const ab of this.abilities) {
      if (ab.active > 0) {
        const fx = this.effects[ab.id];
        ab.active = Math.max(0, ab.active - dt);
        if (fx && fx.update) fx.update(ab, dt, g);
        if (ab.active === 0 && fx && fx.end) fx.end(ab, g);
      }
      if (ab.cd > 0) ab.cd = Math.max(0, ab.cd - dt);
      ab.ready = ab.cd === 0 && ab.active === 0;
    }
    if (p.alive && p.input.ability) this.useAbility(p.input.ability - 1);
  }

  _endAbilities() {
    for (const ab of this.abilities) {
      if (ab.active > 0) { const fx = this.effects[ab.id]; ab.active = 0; if (fx && fx.end) fx.end(ab, this.game); }
    }
  }

  // incendiary rounds: whoever was hit keeps burning
  _burn(dt) {
    const g = this.game;
    for (const [z, b] of this.burning) {
      if (!z.alive) { this.burning.delete(z); continue; }
      b.t -= dt; b.puff -= dt;
      z.health -= b.dps * dt;
      if (b.puff <= 0) {
        b.puff = 0.16;
        const x = z.pos.x + (Math.random() - 0.5) * 0.4, y = z.pos.y + 0.7 + Math.random() * 0.8, zz = z.pos.z + (Math.random() - 0.5) * 0.4;
        g.fx.spawn({ x, y, z: zz, vy: 0.9 + Math.random() * 0.5, size: 0.07 + Math.random() * 0.05, grow: -0.05, life: 0.35 + Math.random() * 0.2, r: 1.8, g: 0.75, b: 0.18, a: 0.85, add: true });
        g.fx.wisp(_a.set(x, y + 0.2, zz));
      }
      if (z.health <= 0) { this.burning.delete(z); g.zombies.damage(z, 1, 'body', null); } else if (b.t <= 0) this.burning.delete(z);
    }
  }

  // second wind: the segment starts to refill before the player's own five seconds are up
  _regen(dt) {
    const p = this.game.player, k = this.build.player.regenDelay, quiet = p.time - p.lastDamage;
    if (k < 1 && p.alive && quiet > REGEN.delay * k && quiet <= REGEN.delay && p.health < p.regenCap) p.health = Math.min(p.regenCap, p.health + REGEN.rate * p.mods.heal * dt);
  }

  // every frame of an Operation run, after the player, the weapon and the infected
  update(dt) {
    const g = this.game, p = g.player, cam = g.engine.camera, heli = this.heli, lz = this.lz;
    if (!heli || this.phase === 'idle') return;
    heli.update(dt * g.timeScale);
    if (this.kit) this.kit.update(dt);
    if (this.phase === 'insertion') {
      if (heli.state !== 'ground') { heli.seatPose(cam.position, cam.quaternion); p.pos.copy(heli.group.position); return; }
      if (this.outT === 0) {
        // skids down: out of the starboard door
        p.spawn(lz.exit.x, lz.exit.z, lz.exitYaw);
        p.bandages = Math.min(p.bandageMax, 1 + this.build.run.bandages);
        heli.seatPose(cam.position, cam.quaternion);
        this.outT = 1e-6;
        return;
      }
      this.outT += dt;
      heli.seatPose(_cp, _cq);
      const k = smooth(this.outT / INSERT.out);
      cam.position.lerpVectors(_cp, cam.position, k); cam.quaternion.slerpQuaternions(_cq, cam.quaternion, k);
      if (this.outT >= INSERT.out) {
        this.phase = 'run';
        p.enabled = true; g.weapon.visible = true; g.zombies.passive = false; heli.inside = false;
        g.interT = INSERT.firstWave; this.leaveT = INSERT.wait;
        g.ui?.toast(this.startWave > 1 ? `Wave ${this.startWave} is close` : 'On the ground', `Hold out. The helicopter returns after wave ${Math.ceil(this.startWave / EXTRACT.every) * EXTRACT.every}`);
      }
    } else if (this.phase === 'run') {
      if (heli.state === 'ground' && !this.extraction) { this.leaveT -= dt; if (this.leaveT <= 0) heli.depart(); }
      this._extraction(dt);
      if (this.phase !== 'run') return;
      this._burn(dt); this._regen(dt); this._abilities(dt);
    } else if (this.phase === 'boarding') {
      this.boardT += dt;
      heli.seatPose(_cp, _cq);
      const k = smooth(this.boardT / EXTRACT.board);
      cam.position.lerpVectors(this._from.pos, _cp, k); cam.quaternion.slerpQuaternions(this._from.quat, _cq, k);
      if (this.boardT >= EXTRACT.board) { this.phase = 'riding'; this.rideT = 0; heli.depart(true); }
    } else if (this.phase === 'riding') {
      heli.seatPose(cam.position, cam.quaternion);
      this.rideT += dt;
      if (this.rideT >= EXTRACT.ride) g.endRun('extract');
    }
  }

  // behind the debrief: the helicopter carries on (with the camera, after an extraction)
  after(dt) {
    const heli = this.heli;
    if (!heli || heli.state === 'gone') return;
    heli.update(dt);
    if (this.riding) heli.seatPose(this.game.engine.camera.position, this.game.engine.camera.quaternion);
  }
}
