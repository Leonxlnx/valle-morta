// First-person weapons: three data-driven firearms on one view-model rig.
// Firing (recoil patterns, spread, muzzle flash, brass, smoke), reloads, bolt
// cycling, holster / draw, the sniper scope and the bipod all run off one action
// clock, so a model with authored clips and a model without behave the same.
//
// View-model contract (docs/DESIGN.md): public/assets/models/<id>.glb, metres,
// +Y up, barrel along -Z, moving parts as named nodes, empties Muzzle, Eject,
// SightRear, SightFront (sniper: ScopeEye), clips Idle Fire Reload ReloadEmpty
// Draw Holster Sprint (sniper: BoltCycle, BipodDeploy) and an optional sidecar
// <id>.anim.json with durations and events (mag_out, mag_in, bolt_back,
// bolt_forward, slide_release, ammo, shell). Clips play through an
// AnimationMixer; sway, bob, aim offset and recoil are layered on the root.
// A model without clips is animated procedurally, and a missing model is
// replaced by the rifle with that weapon's own timings and stats.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { enhance } from '../engine/materials.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const PARTS = ['Bolt', 'Magazine', 'HandL', 'HandR', 'Trigger', 'Slide', 'Hammer', 'BoltHandle', 'Selector', 'BipodL', 'BipodR'];
const LOOPS = new Set(['Idle', 'Sprint']);

export const WEAPON_ORDER = ['rifle', 'pistol', 'sniper'];
// recoil: the view climbs v0 -> v1 rad per shot (time constant `tau` shots) and drifts sideways in a
// fixed left / right rhythm; it holds while firing and recovers once the trigger rests.
export const WEAPONS = {
  rifle: {
    id: 'rifle', name: 'AK rifle', slot: 1, mode: 'auto', interval: 60 / 600, mag: 30, reserve: 120, reserveMax: 240,
    damage: 36, head: 4, falloff: [60, 150, 0.6], bodies: 1, calibre: 1,
    times: { Reload: 2.4, ReloadEmpty: 3.0, Draw: 0.45, Holster: 0.3 },
    events: {
      Reload: [[0.5, 'mag_out'], [1.5, 'mag_in'], [1.5, 'ammo']],
      ReloadEmpty: [[0.5, 'mag_out'], [1.5, 'mag_in'], [1.5, 'ammo'], [2.25, 'bolt_back'], [2.5, 'bolt_forward']],
    },
    // view-model framing: grip position in camera space (m), base rotation [pitch up, yaw inward, cant] (rad),
    // weapon-camera field of view at the hip and aimed (deg), eye to rear sight when aimed (m), extra sprint offset [y, z, pitch]
    pose: { rot: [0.05, 0.07, 0.05], fov: 54, adsFov: 46, eye: 0.25, sprint: [-0.03, 0.02, -0.12] },
    hip: [0.115, -0.148, -0.235], zoom: 1.35, scopeFov: 0, adsRate: 11, sway: 0.0014,
    spread: { hip: 0.0115, ads: 0.0012, bloom: 0.0018, bloomMax: 0.012, recover: 6, move: 0.012, air: 0.03 },
    recoil: { v0: 0.0095, v1: 0.003, tau: 4.5, h0: 0.0006, h: 0.0026, hStart: 3, hPeriod: 8, jit: 0.1, hJit: 0.0006, ads: 0.7, hold: 0.16, recover: 7, max: 0.17 },
    flash: { star: 0.22, tongue: [0.36, 0.1], jets: 0, light: 55 },
    shot: { sound: 'rifle_shot', rate: 1, volume: 1 },
    casing: { scale: [1, 1], vel: [3.6, 1.9, 1.1], spin: 46 },
    kick: 1, shake: 0.45, fovPunch: 0.5, smoke: 1, tracer: false,
  },
  pistol: {
    id: 'pistol', name: '9 mm pistol', slot: 2, mode: 'semi', interval: 0.11, mag: 15, reserve: Infinity, reserveMax: Infinity,
    damage: 26, head: 3.5, falloff: [25, 70, 0.5], bodies: 1, calibre: 0.7,
    times: { Reload: 1.7, ReloadEmpty: 2.1, Draw: 0.3, Holster: 0.3 },
    events: {
      Reload: [[0.35, 'mag_out'], [1.1, 'mag_in'], [1.1, 'ammo']],
      ReloadEmpty: [[0.35, 'mag_out'], [1.1, 'mag_in'], [1.1, 'ammo'], [1.7, 'slide_release']],
    },
    pose: { rot: [0.06, 0.12, 0.04], fov: 52, adsFov: 46, eye: 0.3, sprint: [-0.02, 0.0, 0.0] },
    hip: [0.062, -0.122, -0.27], zoom: 1.2, scopeFov: 0, adsRate: 15, sway: 0.0018,
    spread: { hip: 0.009, ads: 0.0022, bloom: 0.0042, bloomMax: 0.016, recover: 7, move: 0.008, air: 0.03 },
    recoil: { v0: 0.016, v1: 0.02, tau: 3, h0: 0.001, h: 0, hStart: 0, hPeriod: 8, jit: 0.12, hJit: 0.003, ads: 0.75, hold: 0.2, recover: 9, max: 0.2 },
    flash: { star: 0.1, tongue: [0.15, 0.06], jets: 0, light: 30 },
    shot: { sound: 'pistol_shot', rate: 1.32, volume: 0.75 },
    casing: { scale: [0.87, 0.49], vel: [2.4, 2.3, -0.5], spin: 55 },
    kick: 1.25, shake: 0.3, fovPunch: 0.3, smoke: 0.6, tracer: false,
  },
  sniper: {
    id: 'sniper', name: 'Bolt-action rifle', slot: 3, mode: 'bolt', interval: 0, mag: 5, reserve: 20, reserveMax: 40,
    damage: 220, head: 3, falloff: null, bodies: 3, calibre: 1.8,
    times: { Reload: 3.2, BoltCycle: 1.1, Draw: 0.45, Holster: 0.3 },
    events: {
      Reload: [[0.3, 'bolt_back'], [0.9, 'mag_out'], [2.0, 'mag_in'], [2.0, 'ammo'], [2.75, 'bolt_forward']],
      BoltCycle: [[0.28, 'bolt_back'], [0.36, 'shell'], [0.72, 'bolt_forward']],
    },
    pose: { rot: [0.03, 0.06, 0.05], fov: 54, adsFov: 50, eye: 0.085, sprint: [-0.03, 0.02, -0.08] },
    hip: [0.122, -0.168, -0.2], zoom: 1.15, scopeFov: 10, adsRate: 7.5, sway: 0.0078, bipod: true,
    spread: { hip: 0.04, ads: 0.00012, bloom: 0, bloomMax: 0, recover: 6, move: 0.03, air: 0.06 },
    recoil: { v0: 0.06, v1: 0.06, tau: 1, h0: 0, h: 0, hStart: 0, hPeriod: 8, jit: 0.08, hJit: 0.012, ads: 0.8, hold: 0.12, recover: 3.2, max: 0.2 },
    flash: { star: 0.24, tongue: [0.5, 0.13], jets: 0.13, light: 85 },
    shot: { sound: 'sniper_shot', rate: 0.72, volume: 1.15 },
    casing: { scale: [1.06, 1.31], vel: [1.7, 1.3, -0.4], spin: 22 },
    kick: 2.4, shake: 1.1, fovPunch: 1.6, smoke: 1.8, tracer: true,
  },
};

// view kick of shot number n in a burst -> [up, right] in radians (before stance and aim scaling)
export function recoilStep(rc, n, rnd = Math.random) {
  const v = rc.v1 + (rc.v0 - rc.v1) * Math.exp(-n / rc.tau);
  let h = rc.h0;
  const u = (n - rc.hStart) / rc.hPeriod;
  if (rc.h && u >= 0) { const seg = Math.floor(u); h = rc.h * Math.sin(Math.PI * (u - seg + 0.5 / rc.hPeriod)) * (seg % 2 === 0 ? 1 : -1); }
  return [v * (1 + (rnd() - 0.5) * 2 * rc.jit), h + (rnd() - 0.5) * 2 * rc.hJit];
}

function setLayer(obj, layer) { obj.traverse((o) => o.layers.set(layer)); }

async function fetchGlb(loader, id) {
  try {
    const res = await fetch(`./assets/models/${id}.glb`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return null;   // not a binary glTF (the dev server answers a missing file with the page)
    return await loader.parseAsync(buf, './assets/models/');
  } catch (e) { return null; }
}
async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const txt = (await res.text()).trim();
    return txt.startsWith('{') ? JSON.parse(txt) : null;
  } catch (e) { return null; }
}

const SCOPE_VS = /* glsl */`
varying vec2 vP;
void main() { vP = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const SCOPE_FS = /* glsl */`
uniform float uAspect; uniform float uAlpha; uniform float uPx; uniform float uSolid; uniform vec2 uOff;
varying vec2 vP;
void main() {
  vec2 p = vec2(vP.x * uAspect, vP.y);
  const float R = 0.86;
  float rim = length(p);
  float tube = smoothstep(R - 0.005, R + 0.005, rim);                  // the inside wall of the tube
  float pupil = smoothstep(R * 0.8, R * 1.04, length(p - uOff));        // the exit pupil slides off-axis when the eye moves
  if (uSolid > 0.5) { if (max(tube, pupil) < 0.985 || uAlpha < 0.6) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float dark = max(max(tube, pupil), 0.32 * smoothstep(R * 0.55, R, rim));
  // duplex reticle: fine cross with mil dots in the middle, heavy posts towards the edge
  vec2 a = abs(p);
  float fine = uPx * 0.8, heavy = uPx * 3.0;
  float lines = max(1.0 - smoothstep(fine, fine + uPx, a.y), 1.0 - smoothstep(fine, fine + uPx, a.x));
  float posts = max((1.0 - smoothstep(heavy, heavy + uPx, a.y)) * step(R * 0.42, a.x), (1.0 - smoothstep(heavy, heavy + uPx, a.x)) * step(R * 0.42, a.y) * step(p.y, 0.0));
  float dots = 0.0;
  for (int i = 1; i <= 4; i++) {
    float d = float(i) * R * 0.085;
    float m = min(min(length(p - vec2(d, 0.0)), length(p + vec2(d, 0.0))), min(length(p - vec2(0.0, d)), length(p + vec2(0.0, d))));
    dots = max(dots, 1.0 - smoothstep(uPx * 2.0, uPx * 3.0, m));
  }
  float ret = max(max(lines, posts), dots) * 0.92 * (1.0 - tube);
  float alpha = max(dark, ret) * uAlpha;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(vec3(0.0), alpha);
}`;

export class Weapon {
  constructor(engine, player, fx, audio) {
    this.engine = engine; this.player = player; this.fx = fx; this.audio = audio;
    this.root = new THREE.Group();      // follows the camera
    this.rig = new THREE.Group();       // animated pose
    this.root.add(this.rig);
    engine.camera.add(this.root);
    this.views = {};                    // id -> view-model
    this.state = {};                    // id -> ammunition, ownership, upgrade multipliers
    for (const id of WEAPON_ORDER) {
      const def = WEAPONS[id];
      this.state[id] = { id, def, ammo: def.mag, reserve: def.reserve, owned: true, needBolt: false, mod: { damage: 1, mag: 0, reload: 1, recoil: 1, bodies: 0, pellets: 1 } };
    }
    this.id = 'rifle'; this.pending = null; this.act = null;
    this.cool = 0; this.dryT = 0; this.trigBuf = 0; this._trig = false; this.sinceShot = 9;
    this.shotIdx = 0; this.burst = 0; this.bloom = 0; this.spread = 0; this.heat = 0; this.wispT = 0;
    this.kick = 0; this.kickRot = 0; this.kickYaw = 0; this.kickRoll = 0;
    this.fireT = 1; this.flashN = 0; this.shellAt = -1;
    this.swayX = 0; this.swayY = 0; this.lastYaw = 0; this.lastPitch = 0; this.swayA = 0;
    this.sprintT = 0; this.adsK = 0; this.deadT = 0; this.lowerT = 0; this.lowerB = 0; this.time = 0; this.shots = 0;
    this.scopeT = 0; this.scoped = false; this.bipodT = 0; this.bipodHold = 0; this.bipod = false;
    this.onShoot = null;   // (origin, dir, def, state) => hit | null  (the game resolves zombies + world)
    this.eventLog = [];
    this.light = null; this.scope = null;
    this._visible = true;
    this.isPlaceholder = false;
    this._end = new THREE.Vector3();
  }

  // ---- what the HUD and the rest of the game read
  get st() { return this.state[this.id]; }
  get def() { return WEAPONS[this.id]; }
  get view() { return this.views[this.id]; }
  get name() { return this.def.name; }
  get ammo() { return this.st.ammo; }
  set ammo(v) { this.st.ammo = v; }
  get reserve() { return this.st.reserve; }
  set reserve(v) { this.st.reserve = v; }
  get magSize() { return this.def.mag + this.st.mod.mag; }
  get reloading() { return !!this.act && this.act.name.startsWith('Reload'); }
  get reloadT() { return this.reloading ? this.act.t : 0; }
  get switching() { return !!this.act && (this.act.name === 'Holster' || this.act.name === 'Draw'); }
  get ready() { return !this.act && this.lowerT < 0.3; }
  get busy() { return !!this.act; }
  get nodes() { return this.view ? this.view.nodes : {}; }
  get model() { return this.view ? this.view.scene : null; }
  get ads() { return this.view.ads; }
  get adsTilt() { return this.view.adsTilt; }
  get flash() { return this.view ? this.view.flash : null; }
  inventory() { return WEAPON_ORDER.map((id) => { const s = this.state[id]; return { id, name: s.def.name, slot: s.def.slot, ammo: s.ammo, reserve: s.reserve, mag: s.def.mag + s.mod.mag, owned: s.owned, active: id === this.id }; }); }

  get visible() { return this._visible; }
  set visible(v) {
    this._visible = !!v;
    this.root.visible = this._visible;
    this.engine.weaponVisible = this._visible;
    if (!v) { if (this.flash) this.flash.visible = false; if (this.light) this.light.intensity = 0; }
  }

  reset() {
    for (const id of WEAPON_ORDER) { const s = this.state[id]; s.ammo = s.def.mag + s.mod.mag; s.reserve = s.def.reserve; s.needBolt = false; }
    if (this.view) this.view.scene.visible = false;
    this.id = this.state.rifle.owned ? 'rifle' : 'pistol';
    if (this.view) this.view.scene.visible = true;
    this.act = null; this.pending = null; this.cool = 0; this.trigBuf = 0; this.sinceShot = 9;
    this.shotIdx = 0; this.burst = 0; this.bloom = 0; this.heat = 0;
    this.kick = this.kickRot = this.kickYaw = this.kickRoll = 0;
    this.sprintT = 0; this.adsK = 0; this.deadT = 0; this.lowerT = 0; this.lowerB = 0; this.flashN = 0; this.fireT = 1; this.shellAt = -1;
    this.scopeT = 0; this.scoped = false; this.bipodT = 0; this.bipodHold = 0; this.bipod = false;
  }

  // adds reserve ammunition, returns how many rounds fitted
  give(id, rounds) {
    const s = this.state[id];
    if (!s || !Number.isFinite(s.reserve)) return 0;
    const add = Math.max(0, Math.min(rounds, s.def.reserveMax - s.reserve));
    s.reserve += add;
    return add;
  }

  setOwned(id, owned) { if (this.state[id]) this.state[id].owned = !!owned; }

  // ------------------------------------------------------------ loading
  async load() {
    const loader = new GLTFLoader();
    const src = {};
    await Promise.all(WEAPON_ORDER.map(async (id) => {
      const g = await fetchGlb(loader, id);
      if (g) src[id] = { scene: g.scene, animations: g.animations || [], anim: await fetchJson(`./assets/models/${id}.anim.json`) };
    }));
    if (!src.rifle) console.info('[weapon] rifle.glb missing, using placeholder');
    this.isPlaceholder = !src.rifle;
    this._base = src.rifle || { scene: this._placeholder(), animations: [], anim: null };
    for (const id of WEAPON_ORDER) this.adopt(id, id !== 'rifle' ? src[id] : null);
    this._flashLight();
    this._makeScope();
    setLayer(this.root, 1);
    this.visible = this._visible;
  }

  // Installs a view-model for a weapon: a loaded glTF ({ scene, animations, anim }) or, with nothing given,
  // the rifle model standing in with that weapon's own timings.
  adopt(id, src) {
    const old = this.views[id];
    if (old) { if (old.mixer) old.mixer.stopAllAction(); this.rig.remove(old.scene); }
    const own = !!src;
    if (!src) src = { scene: SkeletonUtils.clone(this._base.scene), animations: this._base.animations, anim: this._base.anim };
    const view = this._makeView(id, src, !own && id !== 'rifle');
    this.views[id] = view;
    view.scene.visible = id === this.id;
    setLayer(view.scene, 1);
    return view;
  }

  _makeView(id, src, standIn) {
    const def = WEAPONS[id];
    const view = { id, def, scene: src.scene, nodes: {}, rest: {}, standIn, mixer: null, actions: {}, clips: {}, anim: src.anim || null, over: null, overW: 0, fireDur: 0, bipodPose: null, ads: new THREE.Vector3(0, -0.06, -0.2), adsTilt: 0, hip: new THREE.Vector3().fromArray(def.hip), flash: null, spin: null };
    src.scene.traverse((o) => {
      view.nodes[o.name.replace(/[._\s]/g, '')] = o;
      if (o.isMesh) {
        o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true;
        if (o.material && !o.material.userData.vm) { enhance(o.material, { key: 'vm-' + o.material.uuid, noFog: true }); o.material.userData.vm = true; o.material.envMapIntensity = 1.25; }
      }
    });
    const n = view.nodes;
    if (n.Casing) n.Casing.visible = false;
    this.rig.add(src.scene);
    for (const k of PARTS) if (n[k]) view.rest[k] = { p: n[k].position.clone(), q: n[k].quaternion.clone() };
    // aim pose in rig space: the scope's ocular in front of the eye, or the rear sight on the optical axis with the sight line level
    // (measured in the pose the Idle clip holds the weapon in, which need not be the bind pose)
    const idle = (src.animations || []).find((c) => c.name === 'Idle');
    let poser = null;
    if (idle) { poser = new THREE.AnimationMixer(src.scene); poser.clipAction(idle).play(); poser.update(0); }
    this.rig.updateWorldMatrix(true, true);
    const local = (node) => this.rig.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
    if (n.ScopeEye && def.scopeFov) {
      const e = local(n.ScopeEye);
      view.ads.set(-e.x, -e.y, -def.pose.eye - e.z);
    } else if (n.SightRear && n.SightFront) {
      const r = local(n.SightRear), f = local(n.SightFront);
      view.adsTilt = -Math.atan2(f.y - r.y, -(f.z - r.z));
      const c = Math.cos(view.adsTilt), s = Math.sin(view.adsTilt);
      const ry = r.y * c - r.z * s, rz = r.y * s + r.z * c;   // where the rear sight ends up once the rig is tilted about its origin
      view.ads.set(-r.x, -ry, -def.pose.eye - rz);
    }
    if (poser) { poser.stopAllAction(); poser.uncacheRoot(src.scene); }
    if (src.animations && src.animations.length) {
      view.mixer = new THREE.AnimationMixer(src.scene);
      for (const c of src.animations) {
        const a = view.mixer.clipAction(c);
        view.clips[c.name] = c; view.actions[c.name] = a;
        if (LOOPS.has(c.name)) { a.play(); a.setEffectiveWeight(c.name === 'Idle' ? 1 : 0); } else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      }
      if (view.clips.Fire) view.fireDur = view.clips.Fire.duration;
      // the deployed bipod pose is the last frame of its clip; the legs are then held there whatever else plays
      if (view.clips.BipodDeploy && (n.BipodL || n.BipodR)) {
        const a = view.actions.BipodDeploy;
        a.reset(); a.paused = true; a.play(); a.time = view.clips.BipodDeploy.duration - 1e-4;
        view.mixer.update(0);
        view.bipodPose = ['BipodL', 'BipodR'].filter((k) => n[k]).map((k) => ({ node: n[k], p: n[k].position.clone(), q: n[k].quaternion.clone() }));
        a.stop();
      }
    }
    this._makeFlash(view);
    return view;
  }

  _placeholder() {
    const g = new THREE.Group(); g.name = 'Rifle';
    const steel = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.5, metalness: 0.9 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a3418, roughness: 0.6 });
    const box = (name, w, h, d, x, y, z, m, parent = g) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.name = name; o.position.set(x, y, z); parent.add(o); return o; };
    box('Receiver', 0.035, 0.06, 0.26, 0, 0, -0.05, steel);
    box('Barrel', 0.016, 0.016, 0.42, 0, 0.012, -0.38, steel);
    box('Handguard', 0.042, 0.05, 0.2, 0, 0.0, -0.27, wood);
    box('Stock', 0.036, 0.09, 0.26, 0, -0.03, 0.2, wood);
    box('Grip', 0.03, 0.09, 0.04, 0, -0.07, 0.03, wood);
    box('Magazine', 0.026, 0.17, 0.06, 0, -0.11, -0.07, steel);
    box('Bolt', 0.012, 0.014, 0.06, 0.024, 0.02, -0.06, steel);
    box('RearSightL', 0.004, 0.014, 0.006, -0.006, 0.037, 0.02, steel);
    box('RearSightR', 0.004, 0.014, 0.006, 0.006, 0.037, 0.02, steel);
    box('FrontSightPost', 0.003, 0.03, 0.004, 0, 0.035, -0.55, steel);
    const e = (name, x, y, z) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); g.add(o); };
    e('Muzzle', 0, 0.012, -0.6); e('Eject', 0.02, 0.025, -0.05); e('SightRear', 0, 0.046, 0.02); e('SightFront', 0, 0.046, -0.55);
    return g;
  }

  // ------------------------------------------------------------ muzzle flash
  // A hot pin-point with a few thin spikes seen from behind, and a tapering tongue of flame along the barrel.
  _flashAssets() {
    if (this._fa) return this._fa;
    let s = 977;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const tex = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
    const star = tex(256, 256, (g) => {
      g.translate(128, 128);
      const core = g.createRadialGradient(0, 0, 0, 0, 0, 26);
      core.addColorStop(0, 'rgba(255,252,240,1)'); core.addColorStop(0.45, 'rgba(255,214,140,0.7)'); core.addColorStop(1, 'rgba(255,130,40,0)');
      g.fillStyle = core; g.beginPath(); g.arc(0, 0, 26, 0, 6.283); g.fill();
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 6.283 + rnd() * 0.6, len = 58 + rnd() * 66, w = 3 + rnd() * 4.5;
        const grad = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
        grad.addColorStop(0, 'rgba(255,240,205,0.95)'); grad.addColorStop(0.5, 'rgba(255,170,70,0.5)'); grad.addColorStop(1, 'rgba(255,100,20,0)');
        g.fillStyle = grad;
        g.beginPath(); g.moveTo(Math.cos(a + 1.57) * w, Math.sin(a + 1.57) * w); g.lineTo(Math.cos(a) * len, Math.sin(a) * len); g.lineTo(Math.cos(a - 1.57) * w, Math.sin(a - 1.57) * w); g.closePath(); g.fill();
      }
    });
    const tongue = tex(128, 256, (g) => {
      g.filter = 'blur(1.5px)';
      const grad = g.createLinearGradient(0, 250, 0, 8);
      grad.addColorStop(0, 'rgba(255,252,236,1)'); grad.addColorStop(0.3, 'rgba(255,208,120,0.9)'); grad.addColorStop(0.7, 'rgba(255,140,50,0.5)'); grad.addColorStop(1, 'rgba(255,90,20,0)');
      g.fillStyle = grad;
      g.beginPath(); g.moveTo(57, 252); g.bezierCurveTo(30, 215, 26, 170, 44, 120); g.bezierCurveTo(52, 80, 60, 40, 64, 6); g.bezierCurveTo(68, 40, 76, 80, 84, 120); g.bezierCurveTo(102, 170, 98, 215, 71, 252); g.closePath(); g.fill();
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) { const x = 40 + rnd() * 48, y0 = 150 + rnd() * 60, y1 = 20 + rnd() * 70; g.strokeStyle = 'rgba(255,190,100,0.35)'; g.lineWidth = 2 + rnd() * 3; g.beginPath(); g.moveTo(x, y0); g.lineTo(64 + (x - 64) * 0.4, y1); g.stroke(); }
    });
    const mk = (map) => new THREE.MeshBasicMaterial({ map, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide, toneMapped: false, color: new THREE.Color(9, 7.5, 5) });
    return (this._fa = { star: mk(star), tongue: mk(tongue) });
  }

  _makeFlash(view) {
    const f = view.def.flash, A = this._flashAssets();
    const flash = new THREE.Group(), spin = new THREE.Group();
    const star = new THREE.Mesh(new THREE.PlaneGeometry(f.star, f.star), A.star);
    star.position.z = -0.02;
    const tg = new THREE.PlaneGeometry(f.tongue[1], f.tongue[0]);
    tg.translate(0, f.tongue[0] / 2, 0); tg.rotateX(-Math.PI / 2);      // base at the muzzle, tip down-range
    const t1 = new THREE.Mesh(tg, A.tongue), t2 = new THREE.Mesh(tg, A.tongue);
    t2.rotation.z = Math.PI / 2;
    spin.add(star, t1, t2);
    flash.add(spin);
    if (f.jets) {
      // gas thrown sideways by a muzzle brake
      const jg = new THREE.PlaneGeometry(f.jets * 0.3, f.jets);
      jg.translate(0, f.jets / 2, 0);
      for (const sgn of [1, -1]) { const j = new THREE.Mesh(jg, A.tongue); j.rotation.z = -sgn * Math.PI / 2; j.position.z = -0.03; flash.add(j); }
    }
    flash.traverse((o) => { o.frustumCulled = false; o.renderOrder = 60; });
    flash.visible = false;
    (view.nodes.Muzzle || view.scene).add(flash);
    view.flash = flash; view.spin = spin; view.star = star;
  }

  _flashLight() {
    this.light = new THREE.PointLight(0xffb060, 0, 14, 1.6);
    this.light.layers.enableAll();
    this.engine.scene.add(this.light);
    // view-model only (layer 1): a soft key over the left shoulder and a cool rim from ahead, following the camera,
    // so steel, wood and cloth read in shade as well as in sun; both scale with the scene's sun
    const mk = (color) => { const l = new THREE.DirectionalLight(color, 0); l.layers.set(1); this.engine.scene.add(l, l.target); return l; };
    this.fill = mk(0xfff1e0); this.rim = mk(0xcfdcff);
  }

  _lightRig() {
    const cam = this.engine.camera, sun = this.engine.sun;
    const day = sun ? Math.min(1.4, sun.intensity / 8.5) : 1;
    const place = (l, x, y, z, k) => {
      l.target.position.copy(cam.position);
      l.position.set(x, y, z).applyQuaternion(cam.quaternion).add(cam.position);
      l.intensity = k * (0.25 + 0.75 * day);
    };
    place(this.fill, -0.7, 0.9, 0.6, 1.5);
    place(this.rim, 0.6, 0.5, -1.0, 1.1);
  }

  // ------------------------------------------------------------ scope
  // The scoped view is the world camera at the scope's field of view behind a mask drawn with the
  // view-model: the dark tube, the exit pupil that slides when the eye moves, and the reticle.
  _makeScope() {
    const geo = new THREE.PlaneGeometry(2, 2);
    const mk = (solid) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: SCOPE_VS, fragmentShader: SCOPE_FS, transparent: !solid, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: solid,
        uniforms: { uAspect: { value: 16 / 9 }, uAlpha: { value: 0 }, uPx: { value: 2 / 720 }, uSolid: { value: solid ? 1 : 0 }, uOff: { value: new THREE.Vector2() } },
      });
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false; mesh.renderOrder = solid ? 98 : 99; mesh.visible = false;
      this.root.add(mesh);
      return mesh;
    };
    this.scope = mk(false); this.scopeSolid = mk(true);
  }

  // A point given in view-model camera space -> world position that projects
  // to the same pixel through the world camera.
  viewToWorld(local, out = new THREE.Vector3()) {
    const wc = this.engine.weaponCamera, cam = this.engine.camera;
    const depth = -local.z;
    out.copy(local).applyMatrix4(wc.projectionMatrix);          // NDC of the weapon camera
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    out.set(out.x * t * cam.aspect * depth, out.y * t * depth, -depth).applyMatrix4(cam.matrixWorld);
    return out;
  }

  nodeWorld(name, out = new THREE.Vector3()) {
    const n = this.nodes[name];
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    if (!n) return out.copy(cam.position);
    n.getWorldPosition(out);
    cam.worldToLocal(out);
    return this.viewToWorld(out, out);
  }

  // ------------------------------------------------------------ actions
  // duration, events and clip of a named action for the weapon in hand
  _clipInfo(name) {
    const view = this.view, def = this.def;
    if (name === 'ReloadEmpty' && !def.times.ReloadEmpty && (view.standIn || !view.clips.ReloadEmpty)) name = 'Reload';
    const clip = view.clips[name] ? name : (name === 'ReloadEmpty' && view.clips.Reload ? 'Reload' : null);
    const side = view.anim && view.anim.clips ? view.anim.clips[name] : null;
    const clipDur = clip ? view.clips[clip].duration : 0;
    let dur, events;
    if (view.standIn) {
      // someone else's model: this weapon's own timing, the borrowed clip stretched to fit
      dur = def.times[name] ?? (clipDur || 0.5);
      const sd = side ? (side.duration || clipDur || dur) : dur;
      events = side && side.events ? side.events.map((e) => ({ t: (e.t * dur) / sd, name: e.name })) : (def.events[name] || []).map(([t, n]) => ({ t, name: n }));
    } else {
      dur = (side && side.duration) || clipDur || def.times[name] || 0.5;
      events = side && side.events ? side.events.map((e) => ({ t: e.t, name: e.name })) : (def.events[name] || []).map(([t, n]) => ({ t: (t * dur) / (def.times[name] || dur), name: n }));
    }
    events.sort((a, b) => a.t - b.t);
    // a bolt gun throws the case at the end of the rearward stroke, never before the bolt moves
    const bb = events.find((e) => e.name === 'bolt_back'), sh = events.find((e) => e.name === 'shell');
    if (bb && sh && sh.t < bb.t + 0.03) { sh.t = bb.t + 0.03; events.sort((a, b) => a.t - b.t); }
    return { name, dur, events, clip };
  }

  _start(name, onDone) {
    const info = this._clipInfo(name);
    this.act = { name: info.name, t: 0, dur: info.dur, events: info.events, ei: 0, clip: info.clip, onDone, speed: info.name.startsWith('Reload') ? this.st.mod.reload : 1, filled: false };
    return this.act;
  }

  _runAction(dt) {
    const a = this.act;
    if (!a) return;
    a.t += dt * a.speed;
    while (a.ei < a.events.length && a.events[a.ei].t <= a.t) this._event(a.events[a.ei++].name, a);
    if (a.t >= a.dur) {
      if (this.act === a) this.act = null;
      if (a.onDone) a.onDone(a);
    }
  }

  _event(name, a) {
    const au = this.audio;
    this.eventLog.push(`${a ? a.name : 'Fire'}:${name}`);
    if (this.eventLog.length > 24) this.eventLog.shift();
    const pistol = this.id === 'pistol', sniper = this.id === 'sniper';
    if (name === 'mag_out') (pistol ? au?.playFirst('pistol_mag_out', 'mag_out', { volume: 0.8, pitchVar: 0.03 }, { rate: 1.15 }) : au?.play('mag_out', { volume: 0.8 }));
    else if (name === 'mag_in') (pistol ? au?.playFirst('pistol_mag_in', 'mag_in', { volume: 0.8, pitchVar: 0.03 }, { rate: 1.15 }) : au?.play('mag_in', { volume: 0.8 }));
    else if (name === 'bolt_back') (sniper ? au?.playFirst('bolt_back', 'bolt_rack', { volume: 0.8, pitchVar: 0.03 }) : au?.play('bolt_rack', { volume: 0.8 }));
    else if (name === 'bolt_forward') { if (au?.exact('bolt_forward')) au.play('bolt_forward', { volume: 0.8, pitchVar: sniper ? 0.03 : 0 }); }
    else if (name === 'slide_release') au?.playFirst('slide_release', 'bolt_rack', { volume: 0.7 }, { rate: 1.35 });
    else if (name === 'ammo') this._fill(a);
    else if (name === 'shell') this._eject();
  }

  // the magazine is full from here
  _fill(a) {
    const st = this.st;
    if (a) a.filled = true;
    const take = Math.min(this.magSize - st.ammo, st.reserve);
    if (take <= 0) return;
    st.ammo += take;
    if (Number.isFinite(st.reserve)) st.reserve -= take;
  }

  _eject() {
    const p = this.player, cam = this.engine.camera, c = this.def.casing, r = Math.random;
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion), fwd = _v2.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const vel = _v3.set(0, 0, 0).addScaledVector(right, c.vel[0] * (0.8 + r() * 0.4)).addScaledVector(fwd, c.vel[2] + (r() - 0.5) * 0.8);
    vel.y += c.vel[1] * (0.8 + r() * 0.4);
    vel.add(p.vel);
    this.fx.casing(this.nodeWorld('Eject'), vel, { scale: c.scale, spin: c.spin });
  }

  canFire() {
    const p = this.player;
    return !this.act && this.cool <= 0 && this.sprintT < 0.35 && this.lowerT < 0.3 && p.alive && !p.rolling && p.bandageT <= 0;
  }

  startReload() {
    const st = this.st;
    if (this.act || st.ammo >= this.magSize || st.reserve <= 0) return false;
    this._start(st.ammo === 0 ? 'ReloadEmpty' : 'Reload', (a) => { if (!a.filled) this._fill(a); });
    return true;
  }

  // holster what is in hand, then draw the other weapon
  switchTo(id) {
    const s = this.state[id];
    if (!s || !s.owned) return false;
    const holstering = !!this.act && this.act.name === 'Holster';
    if (holstering) { this.pending = id; return true; }
    if (id === this.id) return false;
    if (this.act && this.act.name === 'BoltCycle') this.st.needBolt = true;     // the next round still has to be chambered
    this.pending = id;
    this.audio?.play('weapon_switch', { volume: 0.6, pitchVar: 0.05 });
    this._start('Holster', () => this._swap());
    return true;
  }

  next() {
    const owned = WEAPON_ORDER.filter((id) => this.state[id].owned);
    if (owned.length < 2) return false;
    const cur = this.act && this.act.name === 'Holster' && this.pending ? this.pending : this.id;
    return this.switchTo(owned[(owned.indexOf(cur) + 1) % owned.length]);
  }

  _swap() {
    const id = this.pending;
    this.pending = null;
    if (id && id !== this.id) {
      this.view.scene.visible = false;
      if (this.view.flash) this.view.flash.visible = false;
      this.id = id;
      this.view.scene.visible = true;
      this.bloom = 0; this.shotIdx = 0; this.flashN = 0; this.cool = 0; this.fireT = 1; this.heat = 0;
    }
    this._start('Draw', () => { if (this.st.needBolt) { this.st.needBolt = false; this._start('BoltCycle'); } });
  }

  // cone half-angle of the next shot, radians
  _spreadNow() {
    const p = this.player, s = this.def.spread;
    const aim = this.def.scopeFov ? this.scopeT : p.adsT;
    let v = lerp(s.hip, s.ads, aim) * lerp(1, 0.8, p.crouch) * lerp(1, 0.6, p.prone);
    v += this.bloom + s.move * Math.min(1, p.speed / 6) * lerp(1, 0.5, aim) + (p.onGround ? 0 : s.air);
    return v;
  }

  fire() {
    const p = this.player, cam = this.engine.camera, st = this.st, def = this.def, view = this.view;
    if (st.ammo <= 0) {
      if (this.dryT <= 0) { this.audio?.play('dry_fire', { volume: 0.7 }); this.dryT = 0.3; }
      this.startReload();
      return;
    }
    st.ammo--; this.shots++;
    this.cool = Math.max(this.cool, -1 / 30) + def.interval;   // carry the remainder: the rate holds at any frame rate
    const n = Math.floor(this.shotIdx);
    this.shotIdx += 1; this.burst = this.shotIdx; this.sinceShot = 0;
    const ads = p.adsT;
    const spread = this._spreadNow();
    // the bullet leaves along the exact view axis, so it lands under the crosshair
    cam.updateMatrixWorld();
    const origin = cam.getWorldPosition(new THREE.Vector3());
    let first = null, dir0 = null;
    for (let k = 0; k < (st.mod.pellets || 1); k++) {
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * (spread + (k ? 0.007 : 0));
      dir.add(_v2.set(Math.cos(a) * r, Math.sin(a) * r, 0).applyQuaternion(cam.quaternion)).normalize();
      const hit = this.onShoot ? this.onShoot(origin, dir, def, st) : null;
      if (!k) { first = hit; dir0 = dir; }
    }
    // recoil: the pattern moves the aim, a short kick moves the model and the picture
    const [rv, rh] = recoilStep(def.recoil, n);
    const k = lerp(1, def.recoil.ads, ads) * lerp(1, 0.85, p.crouch) * lerp(1, 0.6, p.prone) * lerp(1, 0.45, this.bipodT) * st.mod.recoil;
    p.recoilPitch = Math.min(def.recoil.max, p.recoilPitch + rv * k * 0.8);
    p.pitch = Math.min(1.5, p.pitch + rv * k * 0.2);
    p.recoilYaw += rh * k;
    this.kick += def.kick; this.kickRot += def.kick; this.kickYaw += (Math.random() - 0.5) * 2 * def.kick; this.kickRoll += (Math.random() - 0.5) * 2 * def.kick;
    p.fireShake = Math.min(2.5, p.fireShake + def.shake);
    p.fovKick = Math.min(3, p.fovKick + def.fovPunch);
    p.bobSuppress = 1;
    this.bloom = Math.min(def.spread.bloomMax, this.bloom + def.spread.bloom * lerp(1, 0.45, ads));
    this.heat = Math.min(14, this.heat + def.smoke);
    // flash: two frames, never the same twice
    this.fireT = 0; this.flashN = 2;
    view.spin.rotation.z = Math.random() * 6.283;
    view.flash.scale.setScalar(0.8 + Math.random() * 0.45);
    view.flash.scale.z *= 0.7 + Math.random() * 0.6;
    // world-space effects
    const mw = this.scoped ? _v.copy(origin).addScaledVector(dir0, 1.4).addScaledVector(_v3.set(0, 1, 0).applyQuaternion(cam.quaternion), -0.05) : this.nodeWorld('Muzzle', _v);
    this.fx.muzzleSmoke(mw, dir0, def.smoke);
    this.light.position.copy(mw).addScaledVector(dir0, 0.25);
    if (def.tracer) this.fx.tracer(mw, first && first.end ? first.end : this._end.copy(origin).addScaledVector(dir0, 400));
    // brass: self-loaders throw it at once (or where the Fire clip says), a bolt gun when the bolt comes back
    if (def.mode !== 'bolt') {
      const ev = !view.standIn && view.anim && view.anim.clips && view.anim.clips.Fire && (view.anim.clips.Fire.events || []).find((e) => e.name === 'shell');
      if (ev && ev.t > 0.001) this.shellAt = ev.t; else this._eject();
    }
    this.audio?.playFirst(def.shot.sound, 'rifle_shot', { volume: def.shot.volume, pitchVar: 0.035 }, { rate: def.shot.rate });
    if (st.ammo === 0 && def.mode !== 'bolt') this.audio?.play('dry_fire', { volume: 0.35, delay: 0.06 });
    if (def.mode === 'bolt') this._start('BoltCycle');
  }

  update(dt) {
    this.time += dt;
    const p = this.player, i = p.input, def = this.def;
    this.cool -= dt; this.dryT -= dt; this.sinceShot += dt;
    if (p.enabled && p.alive) {
      if (i.slot) this.switchTo(WEAPON_ORDER[i.slot - 1]); else if (i.next) this.next();
      if (i.reload) this.startReload();
      // self-loaders and bolt guns fire once per pull; a pull just before the gun is ready still counts
      if (i.fire && !this._trig) this.trigBuf = 0.14; else this.trigBuf -= dt;
      const want = this.def.mode === 'auto' ? i.fire : this.trigBuf > 0;
      if (want && this.canFire()) { this.trigBuf = 0; this.fire(); }
    }
    this._trig = i.fire;
    this._runAction(dt);
    if (this.shellAt >= 0 && this.fireT + dt >= this.shellAt) { this.shellAt = -1; this._eject(); }
    // recoil holds while the trigger is working and settles afterwards; the pattern starts over
    const rc = this.def.recoil;
    if (this.sinceShot > rc.hold) { const k = Math.exp(-dt * rc.recover); p.recoilPitch *= k; p.recoilYaw *= k; }
    if (this.sinceShot > Math.max(0.2, def.interval + 0.1)) this.shotIdx = Math.max(0, this.shotIdx - dt * 45);
    this.burst = this.shotIdx;
    this.bloom *= Math.exp(-dt * this.def.spread.recover);
    this.heat = Math.max(0, this.heat - dt * 1.6);
    this._aim(dt);
    this.spread = this._spreadNow();
    this._animate(dt);
    // a hot barrel smokes for a moment after a burst
    if (this.heat > 3 && this.sinceShot > 0.25 && this._visible && !this.scoped && this.lowerT < 0.5) {
      this.wispT -= dt;
      if (this.wispT <= 0) { this.wispT = 0.05 + 0.5 / this.heat; this.fx.wisp(this.nodeWorld('Muzzle', _v)); }
    }
  }

  // zoom, scope, bipod and the unsteadiness of the aim
  _aim(dt) {
    const p = this.player, def = this.def, act = this.act;
    p.aimZoom = def.zoom; p.adsRate = def.adsRate; p.scopeFov = def.scopeFov || 0;
    p.noAim = !!act && act.name !== 'BoltCycle';
    const wantScope = def.scopeFov > 0 && this.adsK > 0.8 && !p.noAim && this._visible && p.alive;
    this.scopeT = clamp(this.scopeT + (wantScope ? 1 : -1) * dt * 9, 0, 1);
    p.scopeT = this.scopeT; this.scoped = this.scopeT > 0.5;
    // the bipod goes down when the shooter lies still
    const still = !!def.bipod && p.prone > 0.95 && p.speed < 0.2 && !this.switching && p.alive;
    this.bipodHold = still ? this.bipodHold + dt : 0;
    this.bipodT = clamp(this.bipodT + (still && this.bipodHold > 0.2 ? 1 : -1) * dt / 0.45, 0, 1);
    this.bipod = this.bipodT > 0.99;
    // aim sway: strong standing, small crouched, close to nothing prone on the bipod; worse on the move
    const amp = def.sway * p.adsT * lerp(1, 0.36, p.crouch) * lerp(1, 0.36, p.prone) * lerp(1, 0.2, this.bipodT) * (1 + Math.min(1, p.speed / 2) * 1.5);
    this.swayA += (amp - this.swayA) * Math.min(1, dt * 6);
    const t = this.time, A = this.swayA;
    let sy = A * (0.62 * Math.sin(0.83 * t + 1.1) + 0.28 * Math.sin(2.17 * t + 0.3) + 0.1 * Math.sin(5.3 * t));
    let sp = A * (0.5 * Math.sin(1.07 * t) + 0.24 * Math.sin(2.63 * t + 2.0) + 0.08 * Math.sin(4.7 * t + 0.7) + 0.3 * Math.sin(1.55 * t + 0.4));
    if (act && act.name === 'BoltCycle' && this.scopeT > 0) {
      // working the bolt jostles the picture
      const u = act.t / act.dur, b = Math.sin(Math.PI * u) * this.scopeT;
      sp += b * 0.0042 * Math.sin(u * 9.4); sy -= b * 0.003 * Math.sin(u * 6.3);
    }
    p.swayYaw = sy; p.swayPitch = sp;
  }

  _animate(dt) {
    const p = this.player, view = this.view, def = this.def, n = view.nodes, t = this.time, act = this.act, R = view.rest;
    this.adsK += ((act && act.name !== 'BoltCycle' ? 0 : p.adsT) - this.adsK) * Math.min(1, dt * 16);
    const ads = this.adsK;
    this.sprintT += ((p.sprinting && !act ? 1 : 0) - this.sprintT) * Math.min(1, dt * 8);
    this.deadT += ((p.alive ? 0 : 1) - this.deadT) * Math.min(1, dt * 3.5);
    // springs
    this.kick *= Math.exp(-dt * 16); this.kickRot *= Math.exp(-dt * 13); this.kickYaw *= Math.exp(-dt * 12); this.kickRoll *= Math.exp(-dt * 10);
    // inertia sway from view rotation
    let dy = p.yaw - this.lastYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const dp = p.pitch - this.lastPitch;
    this.lastYaw = p.yaw; this.lastPitch = p.pitch;
    this.swayX += (clamp(dy * 2.2, -0.06, 0.06) - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (clamp(dp * 2.2, -0.05, 0.05) - this.swayY) * Math.min(1, dt * 9);
    const hipK = 1 - ads;
    const breath = (Math.sin(t * 1.3) * 0.0016 + Math.sin(t * 0.7) * 0.001) * (1 - 0.8 * this.bipodT);
    // the weapon steadies while it fires: no walking bob under recoil
    const amp = (p.moving ? Math.min(1, p.speed / 3.5) : 0) * (1 - 0.8 * Math.min(1, p.bobSuppress));
    const bobX = Math.sin(p.bobT * Math.PI * 2) * 0.0075 * amp * (0.25 + 0.75 * hipK) * (1 + this.sprintT);
    const bobY = Math.abs(Math.cos(p.bobT * Math.PI * 2)) * -0.0085 * amp * (0.25 + 0.75 * hipK) * (1 + this.sprintT);

    // ---- authored clips: one one-shot clip over the idle / sprint loops
    const A = view.actions;
    let over = null, overT = 0;
    if (view.mixer) {
      if (act && act.clip && A[act.clip]) { over = act.clip; overT = (act.t / act.dur) * view.clips[over].duration; }
      else if (A.Fire && this.fireT < view.fireDur && !(view.standIn && def.mode === 'bolt')) { over = 'Fire'; overT = this.fireT; }     // every shot starts it again
      if (over !== view.over) {
        if (view.over && A[view.over]) A[view.over].stop();
        view.over = over; view.overW = over === 'Fire' ? 1 : 0;
        if (over) { const a = A[over]; a.reset(); a.paused = true; a.play(); }
      }
      view.overW = over ? Math.min(1, view.overW + dt / 0.07) : 0;
      const w = view.overW;
      if (over) { A[over].time = Math.min(overT, view.clips[over].duration - 1e-4); A[over].setEffectiveWeight(Math.max(w, 1e-3)); }
      const spW = A.Sprint ? this.sprintT : 0;
      if (A.Idle) A.Idle.setEffectiveWeight(Math.max(1e-4, (1 - w) * (1 - spW)));
      if (A.Sprint) A.Sprint.setEffectiveWeight((1 - w) * spW);
      view.mixer.update(dt);
    }
    const procSwap = !(act && act.clip), procSprint = !A.Sprint;

    // lowered out of the way: holstering, drawing, bandaging, rolling
    let lowT = 0;
    if (act && procSwap) { if (act.name === 'Holster') lowT = ss(0, 1, act.t / act.dur); else if (act.name === 'Draw') lowT = 1 - ss(0, 1, act.t / act.dur); }
    this.lowerB += ((p.bandageT > 0 || p.rolling ? 1 : 0) - this.lowerB) * Math.min(1, dt * 10);
    const low = Math.max(lowT, this.lowerB);
    this.lowerT = low;

    const pos = this.rig.position, rot = _e.set(0, 0, 0);
    pos.copy(view.hip).lerp(view.ads, ads);
    pos.x += bobX + this.swayX * 0.35 * (0.3 + 0.7 * hipK);
    pos.y += bobY + breath * (0.3 + hipK) - this.swayY * 0.3 - p.landKick * 0.02;
    pos.z += this.kick * 0.028 * (1 - 0.35 * ads);
    const P = def.pose;
    // recoil: the weapon is driven back into the shoulder and its muzzle climbs in the hands
    pos.y += this.kickRot * 0.0035 * (1 - 0.6 * ads);
    rot.x = this.kickRot * 0.03 * (1 - 0.5 * ads) + this.swayY * 0.7 * hipK + view.adsTilt * ads + P.rot[0] * hipK;
    rot.y = this.kickYaw * 0.006 + this.swayX * 0.9 * (0.25 + 0.75 * hipK) + P.rot[1] * hipK;
    rot.z = this.kickRoll * 0.012 + bobX * 2.2 - this.swayX * 1.2 * (0.25 + 0.75 * hipK) + P.rot[2] * hipK;
    // sprint pose: muzzle down and across the body (a model with a Sprint clip brings its own, trimmed per weapon)
    const sp = procSprint ? this.sprintT : 0;
    pos.x -= 0.035 * sp; pos.y -= 0.045 * sp; pos.z += 0.04 * sp;
    rot.x -= 0.34 * sp; rot.y += 0.62 * sp; rot.z += 0.22 * sp;
    // working the bolt from the hip: the rifle rolls onto its left side and comes up so the hand on the bolt is seen
    if (act && act.name === 'BoltCycle' && act.clip) {
      const u = act.t / act.dur, b = ss(0, 0.16, u) * (1 - ss(0.78, 1, u)) * hipK;
      pos.x -= 0.025 * b; pos.y += 0.04 * b; pos.z += 0.01 * b; rot.z += 0.32 * b; rot.x += 0.06 * b; rot.y -= 0.05 * b;
    }
    if (!procSprint) { pos.y += P.sprint[0] * this.sprintT; pos.z += P.sprint[1] * this.sprintT; rot.x += P.sprint[2] * this.sprintT; }
    // weapon-camera field of view: each weapon framed on its own, a touch tighter when aimed
    const wc = this.engine.weaponCamera, fov = lerp(P.fov, P.adsFov, ads);
    if (Math.abs(wc.fov - fov) > 1e-3) { wc.fov = fov; wc.updateProjectionMatrix(); }
    if (this.fill) this._lightRig();
    // lying down the weapon rests lower and canted
    const pr = p.prone * hipK * (1 - this.bipodT);
    pos.y -= 0.012 * pr; rot.z += 0.1 * pr;
    pos.y -= 0.27 * low; pos.z += 0.05 * low; rot.x -= 0.85 * low; rot.z += 0.25 * low;
    // the weapon sinks out of view when the player goes down
    const dd = this.deadT;
    pos.y -= 0.22 * dd; rot.x -= 0.7 * dd; rot.z += 0.5 * dd;

    this.fireT += dt;
    if (!view.mixer) {
      // ---- no clips: the moving parts are animated here
      for (const k of PARTS) if (n[k] && R[k]) { n[k].position.copy(R[k].p); n[k].quaternion.copy(R[k].q); }
      if (n.Bolt && R.Bolt && def.mode !== 'bolt') {
        const b = this.fireT < 0.022 ? this.fireT / 0.022 : Math.max(0, 1 - (this.fireT - 0.022) / 0.05);
        n.Bolt.position.z += 0.085 * b;
      }
      if (n.Slide && R.Slide) { const b = this.fireT < 0.02 ? this.fireT / 0.02 : Math.max(0, 1 - (this.fireT - 0.02) / 0.045); n.Slide.position.z += 0.04 * b; }
      if (n.Trigger && R.Trigger && p.input.fire) n.Trigger.rotateX(-0.25);
      if (act && act.name.startsWith('Reload')) this._procReload(view, act, pos, rot);
      else if (act && act.name === 'BoltCycle') this._procBolt(view, act, pos, rot);
    } else if (act && !act.clip) {
      // the model has no clip for this action (a borrowed model): move the parts by hand over its idle pose
      if (act.name.startsWith('Reload')) this._procReload(view, act, pos, rot); else if (act.name === 'BoltCycle') this._procBolt(view, act, pos, rot);
    }
    // bipod legs: held in the deployed pose of their clip
    if (view.bipodPose && this.bipodT > 0) for (const b of view.bipodPose) { b.node.position.lerp(b.p, this.bipodT); b.node.quaternion.slerp(b.q, this.bipodT); }

    this.rig.rotation.copy(rot);
    // scope: the mask replaces the model once the eye is behind the glass
    const scoped = this.scopeT > 0.02 && this._visible;
    this.rig.visible = this.scopeT < 0.45;
    if (this.scope) {
      this.scope.visible = this.scopeSolid.visible = scoped;
      if (scoped) {
        const e = this.engine;
        for (const m of [this.scope, this.scopeSolid]) {
          const u = m.material.uniforms;
          u.uAspect.value = e.camera.aspect; u.uPx.value = 2 / Math.max(1, e.rh || 720);
          u.uAlpha.value = ss(0.1, 0.9, this.scopeT);
          u.uOff.value.set(this.kickYaw * 0.03 + p.bob.x * 2.5 + p.swayYaw * 6, -this.kick * 0.1 - p.landKick * 0.25 + p.swayPitch * 6);
        }
      }
    }
    // muzzle flash: full on the frame of the shot, a fading tongue on the next, then gone
    const on = this.flashN > 0 && this._visible && this.rig.visible;
    if (view.flash) {
      view.flash.visible = on;
      if (on) { view.star.visible = this.flashN === 2; if (this.flashN === 1) view.flash.scale.multiplyScalar(0.62); }
    }
    if (this.light) this.light.intensity = this.flashN > 0 && this._visible ? def.flash.light * (this.flashN === 2 ? 1 : 0.35) : 0;
    if (this.flashN > 0) this.flashN--;
    this.root.visible = this._visible;
    this.engine.weaponVisible = this._visible;
  }

  // magazine change on a model without clips, timed by the action's events
  _procReload(view, act, pos, rot) {
    const n = view.nodes, R = view.rest, r = act.t, D = act.dur;
    const at = (name, def) => { const e = act.events.find((x) => x.name === name); return e ? e.t : def; };
    const tO = at('mag_out', D * 0.2), tI = at('mag_in', D * 0.62), tB = at('bolt_back', at('slide_release', -1));
    const tilt = ss(0, 0.3, r) * (1 - ss(D - 0.45, D - 0.04, r));
    pos.x += 0.02 * tilt; pos.y += 0.03 * tilt; pos.z += 0.03 * tilt;
    rot.z += 0.55 * tilt; rot.x += 0.2 * tilt; rot.y -= 0.12 * tilt;
    const out = ss(tO - 0.06, tO + 0.18, r) * (1 - ss(tI - 0.24, tI + 0.06, r));           // magazine out of the well
    const gone = ss(tO + 0.14, tO + 0.4, r) * (1 - ss(tI - 0.44, tI - 0.2, r));            // hand + magazine below the frame
    const toMag = ss(0.06, Math.max(0.12, tO - 0.1), r) * (1 - ss(tI + 0.12, tI + 0.34, r));
    const rack = tB > 0 ? ss(tB - 0.04, tB + 0.09, r) * (1 - ss(tB + 0.13, tB + 0.27, r)) : 0;
    const toBolt = tB > 0 ? ss(tB - 0.3, tB - 0.07, r) * (1 - ss(tB + 0.3, tB + 0.55, r)) : 0;
    if (n.Magazine && R.Magazine) {
      n.Magazine.position.y -= 0.16 * out + 0.45 * gone;
      n.Magazine.position.z += 0.05 * out;
      n.Magazine.rotateX(0.35 * out);
    }
    if (n.HandL && R.HandL) {
      const h = n.HandL, mg = n.MagGrip, bg = n.BoltGrip, gl = n.GripL;
      if (mg && gl) {
        // offset of the hand relative to its grip frame is preserved
        _v.copy(mg.position).sub(gl.position);
        h.position.addScaledVector(_v, toMag);
        h.position.y -= (0.16 * out + 0.45 * gone) * toMag; h.position.z += 0.05 * out * toMag;
        _q.copy(mg.quaternion).multiply(gl.quaternion.clone().invert());
        h.quaternion.slerp(_q.multiply(R.HandL.q), toMag);
      }
      if (bg && gl) {
        _v.copy(bg.position).sub(gl.position);
        h.position.addScaledVector(_v, toBolt);
        h.position.z += 0.085 * rack * toBolt;
      }
    }
    if (n.Bolt && R.Bolt) n.Bolt.position.z = R.Bolt.p.z + 0.085 * rack;
    if (n.Slide && R.Slide) n.Slide.position.z = R.Slide.p.z + 0.04 * rack;
  }

  // working a bolt by hand on a model without clips
  _procBolt(view, act, pos, rot) {
    const n = view.nodes, R = view.rest, r = act.t, D = act.dur;
    const at = (name, def) => { const e = act.events.find((x) => x.name === name); return e ? e.t : def; };
    const tB = at('bolt_back', D * 0.25), tF = at('bolt_forward', D * 0.65);
    const tilt = ss(0, 0.16, r) * (1 - ss(D - 0.3, D - 0.02, r));
    pos.y -= 0.012 * tilt; rot.z += 0.2 * tilt; rot.x += 0.05 * tilt; rot.y -= 0.04 * tilt;
    const back = ss(tB - 0.1, tB + 0.04, r) * (1 - ss(tF - 0.1, tF + 0.05, r));
    const reach = ss(0.02, Math.max(0.08, tB - 0.1), r) * (1 - ss(tF + 0.06, tF + 0.3, r));
    const bolt = n.BoltHandle || n.Bolt, rb = R.BoltHandle || R.Bolt;
    if (bolt && rb) bolt.position.z = rb.p.z + 0.085 * back;
    if (n.HandL && R.HandL && n.BoltGrip && n.GripL) {
      _v.copy(n.BoltGrip.position).sub(n.GripL.position);
      n.HandL.position.addScaledVector(_v, reach);
      n.HandL.position.z += 0.085 * back * reach;
    }
  }
}
