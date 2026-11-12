// First-person player controller: walking, sprinting, jumping, crouching,
// wading, capsule collision, camera motion. Input can be replaced by a script
// (used by the cinematic director and the play-test) through `player.script`.
import * as THREE from 'three';

const RADIUS = 0.34, HEIGHT = 1.8;
const FLOAT = 1.3;   // water deeper than this carries the player
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _wish = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _pre = new THREE.Vector3(), _try = new THREE.Vector3(), _c2 = new THREE.Vector3();
const STEP = 0.45;   // tallest ledge the player walks onto without jumping

export class Player {
  constructor(engine, collision, layout, settings) {
    this.engine = engine;
    this.col = collision;
    this.layout = layout;
    this.settings = settings;
    this.pos = new THREE.Vector3(-40, 0, 120);
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.onGround = true;
    this.crouch = 0;
    this.health = 100; this.alive = true;
    this.input = { fwd: 0, strafe: 0, sprint: false, jump: false, crouch: false, fire: false, ads: false, reload: false };
    this.script = null;         // (dt, player) => partial input / look
    this.enabled = false;
    this.bobT = 0; this.bob = new THREE.Vector2();
    this.landKick = 0; this.shake = 0; this.recoilPitch = 0; this.recoilYaw = 0;
    this.speed = 0; this.moving = false; this.sprinting = false; this.inWater = 0; this.swimming = false; this.boundary = 0;
    this.stepAcc = 0; this.onStep = null; this.onLand = null; this.onHurt = null; this.onDeath = null;
    this.fov = 72; this.fovTarget = 72; this.adsT = 0;
    this.lastDamage = -99; this.time = 0;
    this.stepT = 0; this.stepLift = 0;
    this.eye = new THREE.Vector3();
    this.keys = new Set();
    this.mouseDown = [false, false, false];
    this._bind();
  }

  _bind() {
    const k = this.keys;
    window.addEventListener('keydown', (e) => { if (!e.repeat) k.add(e.code); if (this.enabled && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault(); });
    window.addEventListener('keyup', (e) => k.delete(e.code));
    window.addEventListener('blur', () => { k.clear(); this.mouseDown = [false, false, false]; });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || this.script || !this.alive || document.pointerLockElement !== this.engine.canvas) return;
      const s = 0.0022 * this.settings.sensitivity * (1 - 0.45 * this.adsT);
      this.yaw -= e.movementX * s;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * s * (this.settings.invertY ? -1 : 1), -1.5, 1.5);
    });
    this.engine.canvas.addEventListener('mousedown', (e) => { this.mouseDown[e.button] = true; });
    window.addEventListener('mouseup', (e) => { this.mouseDown[e.button] = false; });
    this.engine.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  spawn(x, z, yaw = 0) {
    const gy = this.col.terrain.heightAt(x, z);
    this.pos.set(x, this.col.floorAt(x, gy + 1.2, z, 2.4), z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.health = 100; this.alive = true;
    this.onGround = true; this.crouch = 0; this.adsT = 0;
    this.recoilPitch = this.recoilYaw = 0; this.shake = 0; this.landKick = 0;
    this.lastDamage = -99; this.stepAcc = 0; this.bob.set(0, 0);
    this.fov = this.settings.fov;
    this.mouseDown = [false, false, false];
    this.eye.set(this.pos.x, this.pos.y + 1.68, this.pos.z);
  }

  damage(amount, fromDir) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.lastDamage = this.time;
    this.shake = Math.min(1.2, this.shake + amount * 0.035);
    if (this.onHurt) this.onHurt(amount, fromDir);
    if (this.health <= 0) { this.alive = false; if (this.onDeath) this.onDeath(); }
  }

  _readInput(dt) {
    const i = this.input;
    if (this.script) {
      i.fwd = 0; i.strafe = 0; i.sprint = false; i.jump = false; i.crouch = false; i.fire = false; i.ads = false; i.reload = false;
      this.script(dt, this);
      return;
    }
    const k = this.keys;
    const locked = document.pointerLockElement === this.engine.canvas;
    i.fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    i.strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    i.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    i.jump = k.has('Space');
    i.crouch = k.has('ControlLeft') || k.has('KeyC');
    i.fire = locked && this.mouseDown[0];
    i.ads = locked && this.mouseDown[2];
    i.reload = k.has('KeyR');
  }

  // Aim the view at a world position with a smoothing rate (for scripts).
  lookAt(target, rate, dt) {
    _tmp.subVectors(target, this.eye);
    const yaw = Math.atan2(-_tmp.x, -_tmp.z);
    const pitch = Math.atan2(_tmp.y, Math.hypot(_tmp.x, _tmp.z));
    const k = rate >= 999 ? 1 : 1 - Math.exp(-rate * dt);
    let dy = yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * k;
    this.pitch += (pitch - this.pitch) * k;
  }

  // A low obstacle in the way (kerb, stair, sill, rubble): rise onto it instead of stopping.
  _stepUp(c, len, sdt, h, alive) {
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (Math.abs(c.y / len) >= 0.55 || !this.onGround || this.vel.y > 0.5 || hs < 0.4 || !alive) return false;
    const ax = _pre.x + (this.vel.x / hs) * (RADIUS + 0.05), az = _pre.z + (this.vel.z / hs) * (RADIUS + 0.05);
    const f = this.col.floorAt(ax, _pre.y + STEP - 0.6, az, STEP - 0.55);
    if (f <= _pre.y + 0.05 || f > _pre.y + STEP + 0.01) return false;
    _try.set(_pre.x + this.vel.x * sdt, f + 0.01, _pre.z + this.vel.z * sdt);
    if (this.col.resolveCapsule(_try, RADIUS, h, _c2).lengthSq() > 1e-8) return false;
    this.stepLift = Math.max(-0.6, this.stepLift - (_try.y - _pre.y));
    this.pos.copy(_try);
    this.stepT = 0.3;
    if (this.vel.y < 0) this.vel.y = 0;
    return true;
  }

  update(dt) {
    this.time += dt;
    this.stepT = Math.max(0, this.stepT - dt);
    if (!this.enabled) { this._applyCamera(dt); return; }
    this._readInput(dt);
    const i = this.input;
    const alive = this.alive;

    // regeneration after a few quiet seconds
    if (alive && this.time - this.lastDamage > 6 && this.health < 100) this.health = Math.min(100, this.health + 7 * dt);

    const depth = this.col.waterDepth(this.pos.x, this.pos.z);
    const floatY = depth > FLOAT ? this.col.terrain.heightAt(this.pos.x, this.pos.z) + depth - FLOAT : -1e9;
    this.inWater = THREE.MathUtils.clamp(depth / 0.9, 0, 1);
    this.crouch += ((i.crouch && alive && !this.swimming ? 1 : 0) - this.crouch) * Math.min(1, dt * 9);
    const wantSprint = i.sprint && i.fwd > 0 && !i.ads && !i.fire && this.crouch < 0.3 && alive;
    this.sprinting = wantSprint && this.onGround;
    let maxSpeed = wantSprint ? 6.1 : 3.5;
    if (i.ads) maxSpeed = 2.1;
    maxSpeed *= 1 - 0.5 * this.crouch;
    maxSpeed *= 1 - 0.5 * this.inWater;
    if (!alive) maxSpeed = 0;

    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0).addScaledVector(_fwd, i.fwd).addScaledVector(_right, i.strafe);
    if (_wish.lengthSq() > 1) _wish.normalize();
    _wish.multiplyScalar(maxSpeed);

    const accel = this.onGround ? 14 : 2.2;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x += (_wish.x - this.vel.x) * k;
    this.vel.z += (_wish.z - this.vel.z) * k;
    this.vel.y -= 22 * dt;
    if (i.jump && this.onGround && alive && this.crouch < 0.5 && !this.swimming) { this.vel.y = 6.4 * (1 - 0.35 * this.inWater); this.onGround = false; }

    // integrate in sub-steps so fast motion cannot tunnel through thin walls
    const steps = Math.max(1, Math.ceil((this.vel.length() * dt) / 0.2));
    const sdt = dt / steps;
    const h = HEIGHT - 0.62 * this.crouch;
    let grounded = false, swim = false;
    const preVy = this.vel.y;
    for (let s = 0; s < steps; s++) {
      _pre.copy(this.pos);
      this.pos.addScaledVector(this.vel, sdt);
      const c = this.col.resolveCapsule(this.pos, RADIUS, h);
      const len = c.length();
      if (len > 1e-6 && !this._stepUp(c, len, sdt, h, alive)) {
        this.pos.add(c);
        if (c.y / len > 0.55) { grounded = true; if (this.vel.y < 0) this.vel.y = 0; } else if (c.y / len < -0.5 && this.vel.y > 0) this.vel.y = 0;
        // remove velocity into the wall
        _tmp.copy(c).multiplyScalar(1 / len);
        const vn = this.vel.dot(_tmp);
        if (vn < 0 && Math.abs(_tmp.y) < 0.55) this.vel.addScaledVector(_tmp, -vn);
      }
      const gy = this.col.terrain.heightAt(this.pos.x, this.pos.z);
      if (this.pos.y <= gy + 0.02) {
        this.pos.y = gy;
        if (this.vel.y < 0) this.vel.y = 0;
        grounded = true;
      } else if (this.stepT > 0) {
        grounded = true;                     // settling onto a step: no snapping back down
      } else if (this.onGround && this.vel.y <= 0 && this.pos.y - gy < 0.35 && !grounded) {
        // stick to the ground when walking downhill
        this.stepLift = Math.min(0.5, this.stepLift + (this.pos.y - gy));
        this.pos.y = gy; grounded = true; this.vel.y = 0;
      }
      // deep water carries the body: head stays above the surface
      if (this.pos.y < floatY) {
        this.pos.y += (floatY - this.pos.y) * Math.min(1, sdt * 10);
        if (this.vel.y < 0) this.vel.y = 0;
        grounded = true; swim = true;
      }
    }
    this.swimming = swim;
    if (grounded && !this.onGround && preVy < -3.5 && !swim) {
      this.landKick = Math.min(1, -preVy / 12);
      if (this.onLand) this.onLand(-preVy);
      if (preVy < -15) this.damage((-preVy - 15) * 6);
    }
    this.onGround = grounded;

    // soft world boundary
    const cx = this.layout.playCenter ? this.layout.playCenter[0] : 20, cz = this.layout.playCenter ? this.layout.playCenter[1] : -20;
    const dx = this.pos.x - cx, dz = this.pos.z - cz;
    const r = Math.hypot(dx, dz), lim = this.layout.playRadius || 330;
    if (r > lim) {
      const push = (r - lim) * 4 * dt;
      this.pos.x -= (dx / r) * push; this.pos.z -= (dz / r) * push;
      this.vel.x -= (dx / r) * 30 * dt; this.vel.z -= (dz / r) * 30 * dt;
    }
    this.boundary = THREE.MathUtils.clamp((r - (lim - 25)) / 25, 0, 1);

    // footsteps & bob
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.moving = this.speed > 0.6 && this.onGround;
    if (this.moving) {
      const stride = this.sprinting ? 2.25 : 1.55;
      this.bobT += (this.speed / stride) * dt;
      this.stepAcc += (this.speed / stride) * dt;
      if (this.stepAcc >= 0.5) {
        this.stepAcc -= 0.5;
        if (this.onStep) this.onStep(this.inWater > 0.15 ? 'water' : this.col.groundSurface(this.pos.x, this.pos.z), this.sprinting);
      }
    } else this.stepAcc = 0.25;

    this.adsT += ((i.ads && alive && !this.sprinting ? 1 : 0) - this.adsT) * Math.min(1, dt * 11);
    this._applyCamera(dt);
  }

  _applyCamera(dt) {
    const cam = this.engine.camera;
    const amp = this.moving ? Math.min(1, this.speed / 3.5) : 0;
    const a = this.bobT * Math.PI * 2;
    const tx = Math.sin(a) * 0.022 * amp * (1 - 0.7 * this.adsT), ty = -Math.abs(Math.cos(a)) * 0.034 * amp * (1 - 0.6 * this.adsT);
    this.bob.x += (tx - this.bob.x) * Math.min(1, dt * 12);
    this.bob.y += (ty - this.bob.y) * Math.min(1, dt * 12);
    this.landKick *= Math.exp(-dt * 7);
    this.shake *= Math.exp(-dt * 5.5);
    // recoil recovers towards zero (the weapon adds impulses)
    this.recoilPitch *= Math.exp(-dt * 6.5);
    this.recoilYaw *= Math.exp(-dt * 6.5);
    const down = this.alive ? 0 : Math.min(1, (this.time - this.lastDamage) * 1.6);
    this.stepLift *= Math.exp(-dt * 11);
    const eyeH = 1.68 - 0.62 * this.crouch - this.landKick * 0.14 - 1.25 * down * (2 - down) + this.stepLift;
    this.eye.set(this.pos.x, this.pos.y + eyeH + this.bob.y, this.pos.z);
    cam.position.copy(this.eye);
    const t = this.time;
    const sh = this.shake;
    const roll = this.bob.x * 0.35 + Math.sin(t * 31) * sh * 0.012 + (this.alive ? 0 : 0.5 * Math.min(1, (this.time - this.lastDamage) * 1.4));
    cam.rotation.set(
      this.pitch + this.recoilPitch + Math.sin(t * 37) * sh * 0.016 - this.landKick * 0.035,
      this.yaw + this.recoilYaw + Math.cos(t * 29) * sh * 0.016 + this.bob.x * 0.25,
      roll, 'YXZ');
    const sprintFov = this.sprinting ? 5 : 0;
    this.fovTarget = this.settings.fov + sprintFov - 22 * this.adsT;
    this.fov += (this.fovTarget - this.fov) * Math.min(1, dt * 12);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  forward(out = new THREE.Vector3()) {
    const p = this.pitch + this.recoilPitch, y = this.yaw + this.recoilYaw;
    return out.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
  }
}
