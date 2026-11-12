// First-person rifle: view-model placement (sway, bob, sprint and aim poses),
// firing with recoil, bolt cycling, muzzle flash, shell ejection and a fully
// procedural reload animation.
//
// Asset contract (public/assets/models/rifle.glb, metres, +Y up, barrel along -Z):
//   nodes  Rifle (static parts), Bolt, Magazine, Trigger, HandR, HandL
//   empties Muzzle, Eject, SightRear, SightFront, GripL, MagGrip, BoltGrip
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { enhance } from '../engine/materials.js';

const HIP = new THREE.Vector3(0.082, -0.118, -0.235);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const ss = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function setLayer(obj, layer) { obj.traverse((o) => o.layers.set(layer)); }

export class Weapon {
  constructor(engine, player, fx, audio) {
    this.engine = engine; this.player = player; this.fx = fx; this.audio = audio;
    this.root = new THREE.Group();      // follows the camera
    this.rig = new THREE.Group();       // animated pose
    this.root.add(this.rig);
    engine.camera.add(this.root);
    this.magSize = 30; this.ammo = 30; this.reserve = 120;
    this.fireInterval = 60 / 600;
    this.cool = 0; this.reloading = false; this.reloadT = 0; this._filled = false; this._rs = 0;
    this.kick = 0; this.kickRot = 0; this.kickYaw = 0; this.kickRoll = 0;
    this.boltT = 1; this.flashT = 1; this.dryT = 0;
    this.swayX = 0; this.swayY = 0; this.lastYaw = 0; this.lastPitch = 0;
    this.sprintT = 0; this.adsK = 0; this.deadT = 0; this.time = 0; this.shots = 0; this.burst = 0;
    this.onShoot = null;   // (origin, dir) => hit | null  (the game resolves zombies + world)
    this.nodes = {};
    this.ads = new THREE.Vector3(0, -0.06, -0.2);
    this.adsTilt = 0;
    this.flash = null; this.light = null;
    this._visible = true;
    this.isPlaceholder = false;
  }

  get visible() { return this._visible; }
  set visible(v) {
    this._visible = !!v;
    this.root.visible = this._visible;
    this.engine.weaponVisible = this._visible;
    if (!v) { if (this.flash) this.flash.visible = false; if (this.light) this.light.intensity = 0; }
  }

  reset() {
    this.ammo = this.magSize; this.reserve = 120;
    this.reloading = false; this.reloadT = 0; this._filled = false; this._rs = 0;
    this.cool = 0; this.burst = 0; this.kick = this.kickRot = this.kickYaw = this.kickRoll = 0;
    this.sprintT = 0; this.adsK = 0; this.deadT = 0; this.flashT = 1; this.boltT = 1;
  }

  async load() {
    let scene = null;
    try {
      const gltf = await new GLTFLoader().loadAsync('./assets/models/rifle.glb');
      scene = gltf.scene;
    } catch (e) {
      console.info('[weapon] rifle.glb missing, using placeholder');
    }
    if (!scene) { scene = this._placeholder(); this.isPlaceholder = true; }
    scene.traverse((o) => {
      this.nodes[o.name.replace(/[._\s]/g, '')] = o;
      if (o.isMesh) {
        o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true;
        if (o.material && !o.material.userData.vm) { enhance(o.material, { key: 'vm-' + o.material.uuid, noFog: true }); o.material.userData.vm = true; o.material.envMapIntensity = 1.0; }
      }
    });
    this.rig.add(scene);
    this.model = scene;
    const n = this.nodes;
    this.rest = {};
    for (const k of ['Bolt', 'Magazine', 'HandL', 'HandR', 'Trigger']) if (n[k]) this.rest[k] = { p: n[k].position.clone(), q: n[k].quaternion.clone() };
    // aim pose: put the rear sight on the optical axis and level the sight line
    if (n.SightRear && n.SightFront) {
      const r = n.SightRear.getWorldPosition(new THREE.Vector3()); this.rig.worldToLocal(r);
      const f = n.SightFront.getWorldPosition(new THREE.Vector3()); this.rig.worldToLocal(f);
      this.adsTilt = -Math.atan2(f.y - r.y, -(f.z - r.z));
      // where the rear sight ends up once the rig is tilted about its origin
      const c = Math.cos(this.adsTilt), s = Math.sin(this.adsTilt);
      const ry = r.y * c - r.z * s, rz = r.y * s + r.z * c;
      this.ads.set(-r.x, -ry, -0.17 - rz);
    }
    this._makeFlash();
    setLayer(this.root, 1);
    this.visible = this._visible;
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

  _makeFlash() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.translate(128, 128);
    let s = 977;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const core = g.createRadialGradient(0, 0, 0, 0, 0, 60);
    core.addColorStop(0, 'rgba(255,250,235,1)'); core.addColorStop(0.3, 'rgba(255,205,120,0.85)'); core.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = core; g.beginPath(); g.arc(0, 0, 60, 0, 6.283); g.fill();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * 6.283 + rnd() * 0.5, len = 60 + rnd() * 62, w = 7 + rnd() * 12;
      const grad = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
      grad.addColorStop(0, 'rgba(255,235,190,0.9)'); grad.addColorStop(1, 'rgba(255,110,20,0)');
      g.fillStyle = grad;
      g.beginPath(); g.moveTo(Math.cos(a + 1.57) * w, Math.sin(a + 1.57) * w); g.lineTo(Math.cos(a) * len, Math.sin(a) * len); g.lineTo(Math.cos(a - 1.57) * w, Math.sin(a - 1.57) * w); g.closePath(); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide, toneMapped: false, color: new THREE.Color(9, 7.5, 5) });
    const flash = new THREE.Group();
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), mat);
    const sideA = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.17), mat); sideA.rotation.y = Math.PI / 2; sideA.position.z = -0.12;
    const sideB = sideA.clone(); sideB.rotation.set(0, Math.PI / 2, Math.PI / 2);
    flash.add(front, sideA, sideB);
    flash.traverse((o) => { o.frustumCulled = false; });
    flash.visible = false; flash.renderOrder = 60;
    (this.nodes.Muzzle || this.rig).add(flash);
    this.flash = flash;
    this.light = new THREE.PointLight(0xffb060, 0, 14, 1.6);
    this.light.layers.enableAll();
    this.engine.scene.add(this.light);
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

  canFire() { return !this.reloading && this.cool <= 0 && this.sprintT < 0.35 && this.player.alive; }

  startReload() {
    if (this.reloading || this.ammo >= this.magSize || this.reserve <= 0) return;
    this.reloading = true; this.reloadT = 0; this._rs = 0; this._filled = false;
  }

  fire() {
    const p = this.player, cam = this.engine.camera;
    if (this.ammo <= 0) {
      if (this.dryT <= 0) { this.audio?.play('dry_fire', { volume: 0.7 }); this.dryT = 0.3; }
      this.startReload();
      return;
    }
    this.ammo--; this.shots++; this.burst++;
    this.cool = Math.max(this.cool, -1 / 30) + this.fireInterval;   // carry the remainder: the rate stays 600 rpm at any frame rate
    const ads = p.adsT;
    const spread = THREE.MathUtils.lerp(0.014, 0.0016, ads) * (1 + Math.min(4, this.burst) * 0.22) * (p.moving ? 1.5 : 1) * (p.onGround ? 1 : 2.5);
    // the bullet leaves along the exact view axis, so it lands under the crosshair
    cam.updateMatrixWorld();
    const dir = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * spread;
    _v2.set(Math.cos(a) * r, Math.sin(a) * r, 0).applyQuaternion(cam.quaternion);
    dir.add(_v2).normalize();
    const origin = cam.getWorldPosition(new THREE.Vector3());
    if (this.onShoot) this.onShoot(origin, dir.clone());
    // recoil: view kick + model kick
    const k = THREE.MathUtils.lerp(1, 0.62, ads);
    p.recoilPitch += (0.0105 + Math.random() * 0.004) * k;
    p.recoilYaw += (Math.random() - 0.42) * 0.0085 * k;
    p.pitch = Math.min(1.5, p.pitch + 0.0032 * k);
    this.kick += 1; this.kickRot += 1; this.kickYaw += (Math.random() - 0.5) * 2; this.kickRoll += (Math.random() - 0.5) * 2;
    this.boltT = 0; this.flashT = 0;
    this.flash.rotation.z = Math.random() * 6.283;
    this.flash.scale.setScalar(0.75 + Math.random() * 0.6);
    // world-space effects
    const mw = this.nodeWorld('Muzzle');
    this.fx.muzzleSmoke(mw, dir);
    this.light.position.copy(mw).addScaledVector(dir, 0.25);
    const ew = this.nodeWorld('Eject');
    const right = _v2.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0);
    const vel = right.clone().multiplyScalar(2.6 + Math.random() * 1.2).addScaledVector(up, 1.7 + Math.random() * 0.9).addScaledVector(dir, -0.6 + Math.random() * 0.8);
    vel.add(p.vel);
    this.fx.casing(ew, vel);
    this.audio?.play('rifle_shot', { volume: 1.0, pitchVar: 0.035 });
    if (this.ammo === 0) this.audio?.play('dry_fire', { volume: 0.35, delay: 0.06 });
  }

  update(dt) {
    this.time += dt;
    const p = this.player, i = p.input;
    this.cool -= dt; this.dryT -= dt;
    if (!i.fire) this.burst = Math.max(0, this.burst - dt * 9);
    if (p.enabled && p.alive) {
      if (i.reload) this.startReload();
      if (i.fire && this.canFire()) this.fire();
    }
    this._animate(dt);
  }

  _animate(dt) {
    const p = this.player, n = this.nodes, t = this.time;
    this.adsK += ((this.reloading ? 0 : p.adsT) - this.adsK) * Math.min(1, dt * 16);
    const ads = this.adsK;
    this.sprintT += ((p.sprinting && !this.reloading ? 1 : 0) - this.sprintT) * Math.min(1, dt * 8);
    this.deadT += ((p.alive ? 0 : 1) - this.deadT) * Math.min(1, dt * 3.5);
    // springs
    this.kick *= Math.exp(-dt * 16); this.kickRot *= Math.exp(-dt * 13); this.kickYaw *= Math.exp(-dt * 12); this.kickRoll *= Math.exp(-dt * 10);
    // inertia sway from view rotation
    let dy = p.yaw - this.lastYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const dp = p.pitch - this.lastPitch;
    this.lastYaw = p.yaw; this.lastPitch = p.pitch;
    this.swayX += (THREE.MathUtils.clamp(dy * 2.2, -0.06, 0.06) - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (THREE.MathUtils.clamp(dp * 2.2, -0.05, 0.05) - this.swayY) * Math.min(1, dt * 9);
    const hipK = 1 - ads;
    const breath = Math.sin(t * 1.3) * 0.0016 + Math.sin(t * 0.7) * 0.001;
    const amp = p.moving ? Math.min(1, p.speed / 3.5) : 0;
    const bobX = Math.sin(p.bobT * Math.PI * 2) * 0.0075 * amp * (0.25 + 0.75 * hipK) * (1 + this.sprintT);
    const bobY = Math.abs(Math.cos(p.bobT * Math.PI * 2)) * -0.0085 * amp * (0.25 + 0.75 * hipK) * (1 + this.sprintT);

    const pos = this.rig.position, rot = _e.set(0, 0, 0);
    pos.copy(HIP).lerp(this.ads, ads);
    pos.x += bobX + this.swayX * 0.35 * (0.3 + 0.7 * hipK);
    pos.y += bobY + breath * (0.3 + hipK) - this.swayY * 0.3 - p.landKick * 0.02;
    pos.z += this.kick * 0.028 * (1 - 0.35 * ads);
    rot.x = this.kickRot * 0.022 * (1 - 0.45 * ads) + this.swayY * 0.7 * hipK + this.adsTilt * ads - 0.012 * hipK;
    rot.y = this.kickYaw * 0.006 + this.swayX * 0.9 * (0.25 + 0.75 * hipK) + 0.018 * hipK;
    rot.z = this.kickRoll * 0.012 + bobX * 2.2 - this.swayX * 1.2 * (0.25 + 0.75 * hipK);
    // sprint pose: muzzle down and across the body
    const sp = this.sprintT;
    pos.x -= 0.035 * sp; pos.y -= 0.045 * sp; pos.z += 0.04 * sp;
    rot.x -= 0.34 * sp; rot.y += 0.62 * sp; rot.z += 0.22 * sp;
    // the rifle sinks out of view when the player goes down
    const dd = this.deadT;
    pos.y -= 0.22 * dd; rot.x -= 0.7 * dd; rot.z += 0.5 * dd;

    // bolt carrier
    this.boltT += dt;
    if (n.Bolt && this.rest.Bolt) {
      const b = this.boltT < 0.022 ? this.boltT / 0.022 : Math.max(0, 1 - (this.boltT - 0.022) / 0.05);
      n.Bolt.position.copy(this.rest.Bolt.p); n.Bolt.position.z += 0.085 * b;
    }
    if (n.Trigger && this.rest.Trigger) { n.Trigger.quaternion.copy(this.rest.Trigger.q); if (p.input.fire) n.Trigger.rotateX(-0.25); }

    // reload
    if (this.reloading) {
      this.reloadT += dt;
      const r = this.reloadT;
      const tilt = ss(0, 0.32, r) * (1 - ss(2.3, 2.75, r));
      pos.x += 0.02 * tilt; pos.y += 0.03 * tilt; pos.z += 0.03 * tilt;
      rot.z += 0.55 * tilt; rot.x += 0.2 * tilt; rot.y -= 0.12 * tilt;
      const out = ss(0.38, 0.62, r) * (1 - ss(1.28, 1.62, r));          // magazine out of the well
      const gone = ss(0.6, 0.85, r) * (1 - ss(1.1, 1.3, r));            // hand + magazine below the frame
      const rack = ss(1.95, 2.08, r) * (1 - ss(2.12, 2.26, r));
      const toMag = ss(0.08, 0.34, r) * (1 - ss(1.68, 1.9, r));
      const toBolt = ss(1.72, 1.94, r) * (1 - ss(2.3, 2.6, r));
      if (n.Magazine && this.rest.Magazine) {
        n.Magazine.position.copy(this.rest.Magazine.p);
        n.Magazine.quaternion.copy(this.rest.Magazine.q);
        n.Magazine.position.y -= 0.16 * out + 0.45 * gone;
        n.Magazine.position.z += 0.05 * out;
        n.Magazine.rotateX(0.35 * out);
      }
      if (n.HandL && this.rest.HandL) {
        const h = n.HandL;
        h.position.copy(this.rest.HandL.p); h.quaternion.copy(this.rest.HandL.q);
        const mg = n.MagGrip, bg = n.BoltGrip, gl = n.GripL;
        if (mg && gl) {
          // offset of the hand relative to its grip frame is preserved
          _v.copy(mg.position).sub(gl.position);
          h.position.addScaledVector(_v, toMag);
          h.position.y -= (0.16 * out + 0.45 * gone) * toMag; h.position.z += 0.05 * out * toMag;
          _q.copy(mg.quaternion).multiply(gl.quaternion.clone().invert());
          h.quaternion.slerp(_q.multiply(this.rest.HandL.q), toMag);
        }
        if (bg && gl) {
          _v.copy(bg.position).sub(gl.position);
          h.position.addScaledVector(_v, toBolt);
          h.position.z += 0.085 * rack * toBolt;
        }
      }
      if (n.Bolt && this.rest.Bolt) n.Bolt.position.z = this.rest.Bolt.p.z + 0.085 * rack;
      const cue = (time, id, name, vol = 0.8) => { if (r >= time && this._rs < id) { this._rs = id; this.audio?.play(name, { volume: vol }); } };
      cue(0.42, 1, 'mag_out'); cue(1.5, 2, 'mag_in'); cue(1.98, 3, 'bolt_rack');
      if (r >= 1.5 && !this._filled) {
        this._filled = true;
        const need = this.magSize - this.ammo, take = Math.min(need, this.reserve);
        this.ammo += take; this.reserve -= take;
      }
      if (r >= 2.75) { this.reloading = false; this._filled = false; }
    } else {
      for (const k of ['Magazine', 'HandL']) if (n[k] && this.rest[k]) { n[k].position.copy(this.rest[k].p); n[k].quaternion.copy(this.rest[k].q); }
    }

    this.rig.rotation.copy(rot);
    // muzzle flash
    this.flashT += dt;
    const on = this.flashT < 0.045 && this._visible;
    if (this.flash) this.flash.visible = on;
    if (this.light) this.light.intensity = on ? 55 * (1 - this.flashT / 0.045) + 12 : 0;
    this.root.visible = this._visible;
    this.engine.weaponVisible = this._visible;
  }
}
