// First-person player controller: walking, sprinting, jumping, crouching,
// prone, dodge roll, wading, capsule collision, fall damage, segmented health,
// bandages and camera motion. Input can be replaced by a script (used by the
// cinematic director and the play-test) through `player.script`.
import * as THREE from 'three';

const RADIUS = 0.34;
const H_STAND = 1.8, H_CROUCH = 1.18, H_PRONE = 0.7, H_ROLL = 0.95;
const EYE_STAND = 1.68, EYE_CROUCH = 1.06, EYE_PRONE = 0.35;
const FLOAT = 1.3;   // water deeper than this carries the player
const STEP = 0.45;   // tallest ledge the player walks onto without jumping
const SEGMENT = 25;  // health regenerates only to the top of the current segment
const REGEN_DELAY = 5, REGEN_RATE = 5;
export const ROLL = { time: 0.6, dist: 4.5, cooldown: 1.2 };
export const FALL = { safe: 3.5, lethal: 14, rollWindow: 0.3 };
export const BANDAGE = { heal: 35, time: 1.6, max: 3 };
// Mouse look: an event that turns the view faster than `suspect` and several times faster than
// everything around it is held back until the next event confirms it; nothing turns faster than `impossible`.
export const LOOK = { suspect: 14, ratio: 6, impossible: 150 };   // rad/s

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _wish = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _pre = new THREE.Vector3(), _try = new THREE.Vector3(), _c2 = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const D2R = Math.PI / 180;

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
    // permanent upgrades (Operation mode) scale these; Survival leaves them alone
    this.mods = { maxHealth: 100, armour: 0, sprint: 1, heal: 1, bandageMax: BANDAGE.max, fall: 1 };
    this.health = 100; this.alive = true; this.regenCap = 100;
    this.bandages = 1; this.bandageT = 0; this.bandaging = 0;
    this.h = H_STAND; this.crouch = 0; this.prone = 0; this.stance = 'stand'; this.proneWanted = false; this.blocked = false; this.fromRoll = false;
    this.rollT = 0; this.rollCd = 0; this.rollBuf = 0; this.rolling = false; this.rolls = 0;
    this.rollDir = new THREE.Vector3(0, 0, -1); this.rollSide = 0; this.rollFwd = 1;
    this.fallTop = 0; this.fallPend = 0; this.fallPendT = 0; this.lastFall = null; this.knockT = 0;
    this.input = { fwd: 0, strafe: 0, sprint: false, jump: false, crouch: false, fire: false, ads: false, reload: false, prone: false, roll: false, bandage: false, interact: false, next: false, slot: 0, ability: 0 };
    this.script = null;         // (dt, player) => partial input / look
    this.enabled = false;
    this.bobT = 0; this.bob = new THREE.Vector2(); this.bobSuppress = 0;
    this.landKick = 0; this.shake = 0; this.fireShake = 0; this.recoilPitch = 0; this.recoilYaw = 0;
    this.swayPitch = 0; this.swayYaw = 0; this.hitKickR = 0; this.hitKickP = 0;
    this.speed = 0; this.moving = false; this.sprinting = false; this.inWater = 0; this.swimming = false; this.boundary = 0;
    this.stepAcc = 0; this.onStep = null; this.onLand = null; this.onHurt = null; this.onDeath = null; this.onRoll = null; this.onBandage = null;
    // view: the weapon sets the aim zoom each frame
    this.fov = 72; this.fovTarget = 72; this.fovKick = 0; this.zoomK = 1;
    this.adsT = 0; this.adsRate = 11; this.noAim = false; this.aimZoom = 1.3; this.scopeFov = 0; this.scopeT = 0;
    this.lastDamage = -99; this.time = 0;
    this.hits = []; this.damageArcs = [];
    this.stepT = 0; this.stepLift = 0;
    this.eye = new THREE.Vector3();
    this.keys = new Set(); this.pressed = new Set();
    this.mouseDown = [false, false, false];
    this.mouse = { ax: 0, ay: 0, lastT: -1, env: 0, held: null, heldFrames: 0, events: 0, rejected: 0, vx: 0, vy: 0, vT: -1e9 };
    this.rawInput = null;       // true once the browser granted unaccelerated mouse input
    this._bind();
  }

  get maxHealth() { return this.mods.maxHealth; }
  get bandageMax() { return this.mods.bandageMax; }

  _bind() {
    const k = this.keys;
    window.addEventListener('keydown', (e) => {
      if (!e.repeat) { k.add(e.code); if (this.enabled) this.pressed.add(e.code); }
      if (this.enabled && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => k.delete(e.code));
    window.addEventListener('blur', () => { k.clear(); this.pressed.clear(); this.mouseDown = [false, false, false]; this._resetMouse(); });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || this.script || !this.alive || document.pointerLockElement !== this.engine.canvas) return;
      this.mouseMove(e.movementX || 0, e.movementY || 0, e.timeStamp);
    });
    document.addEventListener('pointerlockchange', () => this._resetMouse());
    this.engine.canvas.addEventListener('mousedown', (e) => { this.mouseDown[e.button] = true; });
    window.addEventListener('mouseup', (e) => { this.mouseDown[e.button] = false; });
    this.engine.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------ mouse look
  // Asks for raw mouse input: without it Windows applies pointer acceleration to every delta and the
  // browser re-centres a hidden cursor, which now and then reports one huge bogus movement.
  requestLock() {
    const c = this.engine.canvas;
    const plain = () => { try { const r = c.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* not available */ } };
    if (this.rawInput === false) { plain(); return; }
    try {
      const r = c.requestPointerLock({ unadjustedMovement: true });
      if (r && r.then) r.then(() => { this.rawInput = true; }, (err) => { if (err && err.name === 'NotSupportedError') { this.rawInput = false; plain(); } });
    } catch (e) { this.rawInput = false; plain(); }
  }

  _resetMouse() { const m = this.mouse; m.ax = m.ay = 0; m.lastT = -1; m.env = 0; m.held = null; m.vx = m.vy = 0; m.vT = -1e9; }

  // radians per mouse count at the current zoom (the view turns slower through a scope)
  lookScale() { return 0.0022 * this.settings.sensitivity * this.zoomK; }

  // One mouse event (counts, time stamp in ms). Deltas are only accumulated here; the view turns once per frame.
  mouseMove(dx, dy, t) {
    const m = this.mouse;
    m.events++;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const span = m.lastT < 0 ? 16 : clamp(t - m.lastT, 4, 250);   // ms this event covers
    m.lastT = t;
    const rate = (Math.hypot(dx, dy) * this.lookScale()) / (span / 1000);
    m.env *= Math.exp(-span / 150);
    if (m.held) {
      // the event after a suspicious one decides: real motion carries on in the same direction
      const h = m.held; m.held = null;
      if (h.dx * dx + h.dy * dy > 0 && rate >= h.rate * 0.25) this._take(h.dx, h.dy, h.span, h.rate, h.t); else this._bogus(h.span, h.t);
    }
    if (rate > LOOK.impossible) { this._bogus(span, t); return; }
    if (rate > LOOK.suspect && rate > m.env * LOOK.ratio) { m.held = { dx, dy, rate, span, t }; m.heldFrames = 0; return; }
    this._take(dx, dy, span, rate, t);
  }

  _take(dx, dy, span, rate, t) {
    const m = this.mouse;
    m.ax += dx; m.ay += dy;
    m.env = Math.max(m.env, rate);
    m.vx = dx / span; m.vy = dy / span; m.vT = t;
  }

  // a bogus event still covered real time: the view carries on at the speed of the motion around it
  _bogus(span, t) {
    const m = this.mouse;
    m.rejected++;
    if (t - m.vT < 60) { m.ax += m.vx * span; m.ay += m.vy * span; }
  }

  _applyLook() {
    const m = this.mouse;
    if (m.held && ++m.heldFrames > 3) { m.held = null; m.rejected++; }   // nothing followed it: an isolated spike
    if (m.ax === 0 && m.ay === 0) return;
    const s = this.lookScale();
    this.yaw -= m.ax * s;
    this.pitch = clamp(this.pitch - m.ay * s * (this.settings.invertY ? -1 : 1), -1.5, 1.5);
    m.ax = m.ay = 0;
  }

  // ------------------------------------------------------------ state
  spawn(x, z, yaw = 0) {
    const gy = this.col.terrain.heightAt(x, z);
    this.pos.set(x, this.col.floorAt(x, gy + 1.2, z, 2.4), z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.health = this.maxHealth; this.alive = true; this.regenCap = this.maxHealth;
    this.onGround = true; this.adsT = 0; this.scopeT = 0;
    this.h = H_STAND; this.crouch = 0; this.prone = 0; this.stance = 'stand'; this.proneWanted = false; this.blocked = false; this.fromRoll = false;
    this.rollT = 0; this.rollCd = 0; this.rollBuf = 0; this.rolling = false;
    this.fallTop = this.pos.y; this.fallPend = 0; this.lastFall = null; this.knockT = 0; this.boost = false; this.vehicle = null;
    this.bandageT = 0; this.bandaging = 0;
    this.recoilPitch = this.recoilYaw = 0; this.swayPitch = this.swayYaw = 0; this.shake = 0; this.fireShake = 0; this.landKick = 0; this.fovKick = 0;
    this.hitKickR = this.hitKickP = 0; this.bobSuppress = 0;
    this.lastDamage = -99; this.stepAcc = 0; this.bob.set(0, 0);
    this.hits.length = 0; this.damageArcs.length = 0;
    this.fov = clamp(this.settings.fov, 60, 110); this.zoomK = 1;
    this.mouseDown = [false, false, false]; this.pressed.clear(); this._resetMouse();
    this.eye.set(this.pos.x, this.pos.y + EYE_STAND, this.pos.z);
  }

  // fromDir: the direction the blow travels (attacker -> player), or null (fall)
  damage(amount, fromDir, kind = 'hit') {
    if (!this.alive || !(amount > 0) || this.vehicle) return;
    if (kind !== 'fall') amount *= 1 - clamp(this.mods.armour, 0, 0.9);
    this.health = Math.max(0, this.health - amount);
    this.lastDamage = this.time;
    this.shake = Math.min(1.2, this.shake + amount * 0.035);
    const hit = { x: 0, z: 0, t: this.time, amount, kind };
    if (fromDir) {
      const l = Math.hypot(fromDir.x, fromDir.z) || 1;
      hit.x = -fromDir.x / l; hit.z = -fromDir.z / l;                       // unit vector towards the source
      const side = hit.x * Math.cos(this.yaw) - hit.z * Math.sin(this.yaw);   // + = from the right
      const front = -hit.x * Math.sin(this.yaw) - hit.z * Math.cos(this.yaw);
      const k = Math.min(1, amount / 30);
      this.hitKickR += side * 0.07 * k; this.hitKickP += front * 0.05 * k;
    } else this.hitKickP -= Math.min(0.12, amount * 0.003);
    this.hits.push(hit);
    if (this.hits.length > 6) this.hits.shift();
    if (this.onHurt) this.onHurt(amount, fromDir, kind);
    if (this.health <= 0) { this.alive = false; this.bandageT = 0; this.fallPend = 0; if (this.onDeath) this.onDeath(); }
  }

  // thrown back by a heavy blow
  knock(dx, dz, speed, up = 2.5) {
    if (!this.alive) return;
    this.vel.x += dx * speed; this.vel.z += dz * speed;
    this.vel.y = Math.max(this.vel.y, up);
    this.onGround = false; this.knockT = 0.45;
  }

  // damage for a drop in metres: nothing below the safe height, lethal at the top of the range
  fallDamage(drop) {
    const k = (drop - FALL.safe) / (FALL.lethal - FALL.safe);
    return k <= 0 ? 0 : Math.min(1, Math.pow(k, 1.15)) * 100 * this.mods.fall;
  }

  canRoll() { return this.alive && this.onGround && !this.swimming && this.rollT <= 0 && this.rollCd <= 0 && this.prone < 0.5 && this.inWater < 0.6; }

  _startRoll() {
    const i = this.input;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0).addScaledVector(_fwd, i.fwd).addScaledVector(_right, i.strafe);
    if (_wish.lengthSq() < 0.01) _wish.copy(_fwd); else _wish.normalize();
    this.rollDir.copy(_wish);
    this.rollSide = _wish.dot(_right); this.rollFwd = _wish.dot(_fwd);
    this.rollT = ROLL.time; this.rollCd = ROLL.time + ROLL.cooldown; this.rollBuf = 0;
    this.proneWanted = false; this.bandageT = 0; this.fromRoll = true;
    if (this.fallPend > 0) { this.fallPend = 0; if (this.lastFall) this.lastFall.rolled = true; }   // rolled out of the landing: the second half never lands
    this.rolls++;
    if (this.onRoll) this.onRoll();
  }

  _readInput(dt) {
    const i = this.input;
    i.prone = i.roll = i.bandage = i.interact = i.next = false; i.slot = 0; i.ability = 0;
    if (this.script) {
      i.fwd = 0; i.strafe = 0; i.sprint = false; i.jump = false; i.crouch = false; i.fire = false; i.ads = false; i.reload = false;
      this.pressed.clear();
      this.script(dt, this);
      return;
    }
    const k = this.keys, pr = this.pressed;
    const locked = document.pointerLockElement === this.engine.canvas;
    i.fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    i.strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    i.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    i.jump = k.has('Space');
    i.crouch = k.has('ControlLeft') || k.has('KeyC');
    i.fire = locked && this.mouseDown[0];
    i.ads = locked && this.mouseDown[2];
    i.reload = k.has('KeyR');
    i.prone = pr.has('KeyZ'); i.roll = pr.has('KeyV'); i.bandage = pr.has('KeyH'); i.interact = pr.has('KeyF'); i.next = pr.has('KeyQ');
    i.slot = pr.has('Digit1') ? 1 : pr.has('Digit2') ? 2 : pr.has('Digit3') ? 3 : 0;
    i.ability = pr.has('KeyG') ? 1 : pr.has('Digit4') ? 2 : pr.has('Digit5') ? 3 : 0;
    pr.clear();
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

  // would a body this tall fit here? (ceilings, beams, overhangs)
  _room(h) {
    const c = this.col.resolveCapsule(this.pos, RADIUS, h, _c2);
    return c.y > -0.004 && c.x * c.x + c.z * c.z < 1e-4;
  }

  // crouch is held, prone toggles; standing up needs headroom
  _stance(dt, i, alive) {
    if (i.prone && alive && !this.rolling && !this.swimming) this.proneWanted = !this.proneWanted;
    let jump = i.jump;
    if (this.proneWanted && (jump || this.swimming)) { this.proneWanted = false; jump = false; }   // getting up comes before jumping
    if (this.prone > 0.05) jump = false;
    let want = H_STAND;
    if (this.rolling) want = H_ROLL; else if (this.proneWanted) want = H_PRONE; else if (i.crouch && !this.swimming) want = H_CROUCH;
    if (!alive) want = this.h;
    const down = want < this.h;
    const low = this.h < H_CROUCH - 1e-3 || (down && this.h <= H_CROUCH + 1e-3);
    const rate = this.rolling || this.fromRoll ? 4.5 : low ? (down ? 1.3 : 1.0) : 3.4;
    this.blocked = false;
    if (down) this.h = Math.max(want, this.h - rate * dt);
    else if (want > this.h) {
      const nh = Math.min(want, this.h + rate * dt);
      if (this._room(nh + 0.03)) this.h = nh; else this.blocked = true;
    }
    if (!this.rolling && this.h >= H_CROUCH) this.fromRoll = false;
    if (this.h >= H_CROUCH) { this.crouch = (H_STAND - this.h) / (H_STAND - H_CROUCH); this.prone = 0; } else { this.crouch = 1; this.prone = (H_CROUCH - this.h) / (H_CROUCH - H_PRONE); }
    this.stance = this.prone > 0.6 ? 'prone' : this.crouch > 0.5 ? 'crouch' : 'stand';
    return jump;
  }

  update(dt) {
    this.time += dt;
    this.stepT = Math.max(0, this.stepT - dt);
    if (!this.enabled) { this.mouse.ax = this.mouse.ay = 0; this._applyCamera(dt); return; }
    this._readInput(dt);
    this._applyLook();
    // mounted (the Operation tank): the vehicle takes the input and owns the camera
    if (this.vehicle) { this.vehicle.drive(dt, this); return; }
    const i = this.input;
    const alive = this.alive;

    // health regenerates after a few quiet seconds, and only to the top of the current segment
    this.regenCap = Math.min(this.maxHealth, Math.ceil((this.health - 1e-6) / SEGMENT) * SEGMENT);
    if (alive && this.time - this.lastDamage > REGEN_DELAY && this.health < this.regenCap) this.health = Math.min(this.regenCap, this.health + REGEN_RATE * this.mods.heal * dt);
    // the second half of a hard landing arrives unless a roll took it
    if (this.fallPend > 0) { this.fallPendT -= dt; if (this.fallPendT <= 0) { const d = this.fallPend; this.fallPend = 0; this.damage(d, null, 'fall'); } }

    const depth = this.col.waterDepth(this.pos.x, this.pos.z);
    const floatY = depth > FLOAT ? this.col.terrain.heightAt(this.pos.x, this.pos.z) + depth - FLOAT : -1e9;
    this.inWater = clamp(depth / 0.9, 0, 1);

    // dodge roll (a press shortly before touching down is remembered: the landing roll)
    this.rollCd = Math.max(0, this.rollCd - dt);
    this.knockT = Math.max(0, this.knockT - dt);
    this.rollBuf = i.roll ? FALL.rollWindow : Math.max(0, this.rollBuf - dt);
    if (this.rollBuf > 0 && this.canRoll()) this._startRoll();
    if (this.rollT > 0) this.rollT = Math.max(0, this.rollT - dt);
    this.rolling = this.rollT > 0;

    // bandage
    if (i.bandage && alive && this.bandages > 0 && this.bandageT <= 0 && this.health < this.maxHealth - 0.5 && !this.rolling) { this.bandageT = 1e-6; if (this.onBandage) this.onBandage('start'); }
    if (this.bandageT > 0) {
      this.bandageT += dt * this.mods.heal;
      if (this.bandageT >= BANDAGE.time) {
        this.bandageT = 0; this.bandages--;
        this.health = Math.min(this.maxHealth, this.health + BANDAGE.heal);
        if (this.onBandage) this.onBandage('done');
      }
    }
    this.bandaging = this.bandageT > 0 ? this.bandageT / BANDAGE.time : 0;

    const jump = this._stance(dt, i, alive);
    const busy = this.rolling || this.bandageT > 0;
    const wantSprint = i.sprint && i.fwd > 0 && !i.ads && !i.fire && this.crouch < 0.3 && alive && !busy;
    this.sprinting = wantSprint && this.onGround;
    let maxSpeed = wantSprint ? 6.1 * this.mods.sprint : 3.5;
    if (i.ads && !busy) maxSpeed = 2.1;
    if (this.bandageT > 0) maxSpeed = Math.min(maxSpeed, 2.2);
    maxSpeed *= 1 - 0.5 * this.crouch;
    if (this.prone > 0) maxSpeed = lerp(maxSpeed, i.ads ? 0.55 : 0.9, this.prone);
    maxSpeed *= 1 - 0.5 * this.inWater;
    if (!alive) maxSpeed = 0;

    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0).addScaledVector(_fwd, i.fwd).addScaledVector(_right, i.strafe);
    if (_wish.lengthSq() > 1) _wish.normalize();
    _wish.multiplyScalar(maxSpeed);

    if (this.rolling && alive) {
      // fast out of the start, easing to a walk: 4.5 m in 0.6 s
      const u = 1 - this.rollT / ROLL.time;
      const sp = (ROLL.dist / (ROLL.time * 0.7)) * (1 - 0.6 * u) * (1 - 0.45 * this.inWater);
      this.vel.x = this.rollDir.x * sp; this.vel.z = this.rollDir.z * sp;
    } else {
      const accel = this.onGround ? (this.knockT > 0 ? 2 : 14) : this.boost ? 0.12 : 2.2;      // a jump-pack leap keeps its momentum
      const k = 1 - Math.exp(-accel * dt);
      this.vel.x += (_wish.x - this.vel.x) * k;
      this.vel.z += (_wish.z - this.vel.z) * k;
    }
    this.vel.y -= 22 * dt;
    if (jump && this.onGround && alive && this.crouch < 0.5 && !this.swimming && !busy) { this.vel.y = 6.4 * (1 - 0.35 * this.inWater); this.onGround = false; }

    // integrate in sub-steps so fast motion cannot tunnel through thin walls
    const steps = Math.max(1, Math.ceil((this.vel.length() * dt) / 0.2));
    const sdt = dt / steps;
    const h = this.h;
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
    if (grounded && !this.onGround && !swim) {
      const drop = this.boost ? 0 : this.fallTop - this.pos.y;          // the jump pack brakes its own landing
      if (preVy < -3.5) {
        this.landKick = Math.min(1, -preVy / 12);
        if (this.onLand) this.onLand(-preVy, drop);
      }
      const dmg = this.fallDamage(drop) * (1 - 0.7 * clamp(depth / 1.2, 0, 1));
      if (dmg > 0 && alive) {
        this.lastFall = { drop, damage: dmg, rolled: false };
        this.onGround = true;
        if (this.rollBuf > 0 && this.canRoll()) { this._startRoll(); this.lastFall.rolled = true; this.damage(dmg * 0.5, null, 'fall'); } else {
          this.damage(dmg * 0.5, null, 'fall');
          if (this.alive) { this.fallPend = dmg * 0.5; this.fallPendT = FALL.rollWindow; }
        }
      }
    }
    if (grounded || swim) { this.fallTop = this.pos.y; this.boost = false; } else this.fallTop = Math.max(this.fallTop, this.pos.y);
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
    this.boundary = clamp((r - (lim - 25)) / 25, 0, 1);

    // footsteps & bob
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.moving = this.speed > (this.prone > 0.5 ? 0.3 : 0.6) && this.onGround && !this.rolling;
    if (this.moving) {
      const stride = this.prone > 0.5 ? 0.8 : this.sprinting ? 2.25 : 1.55;
      this.bobT += (this.speed / stride) * dt;
      this.stepAcc += (this.speed / stride) * dt;
      if (this.stepAcc >= 0.5) {
        this.stepAcc -= 0.5;
        if (this.onStep) this.onStep(this.inWater > 0.15 ? 'water' : this.col.groundSurface(this.pos.x, this.pos.z), this.sprinting, this.stance);
      }
    } else this.stepAcc = 0.25;

    const aim = i.ads && alive && !this.sprinting && !busy && !this.noAim;
    this.adsT += ((aim ? 1 : 0) - this.adsT) * Math.min(1, dt * this.adsRate);
    this._applyCamera(dt);
  }

  _applyCamera(dt) {
    const cam = this.engine.camera;
    const t = this.time;
    this.bobSuppress *= Math.exp(-dt * 5);
    const crawl = this.prone > 0.5;
    const amp = (this.moving ? Math.min(1, this.speed / (crawl ? 0.9 : 3.5)) : 0) * (1 - 0.8 * Math.min(1, this.bobSuppress));
    const a = this.bobT * Math.PI * 2;
    const tx = Math.sin(a) * (crawl ? 0.03 : 0.022) * amp * (1 - 0.7 * this.adsT), ty = -Math.abs(Math.cos(a)) * (crawl ? 0.016 : 0.034) * amp * (1 - 0.6 * this.adsT);
    this.bob.x += (tx - this.bob.x) * Math.min(1, dt * 12);
    this.bob.y += (ty - this.bob.y) * Math.min(1, dt * 12);
    this.landKick *= Math.exp(-dt * 7);
    this.shake *= Math.exp(-dt * 5.5);
    this.fireShake *= Math.exp(-dt * 22);
    this.fovKick *= Math.exp(-dt * 18);
    this.hitKickR *= Math.exp(-dt * 9); this.hitKickP *= Math.exp(-dt * 9);
    const down = this.alive ? 0 : Math.min(1, (this.time - this.lastDamage) * 1.6);
    this.stepLift *= Math.exp(-dt * 11);
    // eye height follows the body: standing, crouched, prone
    let eyeH = this.h >= H_CROUCH ? lerp(EYE_STAND, EYE_CROUCH, this.crouch) : lerp(EYE_CROUCH, EYE_PRONE, this.prone);
    // dodge roll: the head goes down and round the shoulder, the view dips and tilts but never flips
    let rollTilt = 0, rollPitch = 0;
    if (this.rollT > 0) {
      const bell = Math.sin(Math.PI * (1 - this.rollT / ROLL.time));
      eyeH = Math.min(eyeH, lerp(EYE_STAND, 0.62, bell) + (eyeH - EYE_STAND) * (1 - bell));
      rollTilt = -bell * (0.42 * this.rollSide + 0.14 * this.rollFwd);
      rollPitch = -bell * 0.34 * this.rollFwd;
    }
    eyeH = Math.max(0.2, eyeH - this.landKick * 0.14 * (eyeH / EYE_STAND) - (eyeH - 0.2) * 0.86 * down * (2 - down)) + this.stepLift;
    this.eye.set(this.pos.x, this.pos.y + eyeH + this.bob.y, this.pos.z);
    cam.position.copy(this.eye);
    const sh = this.shake, fs = this.fireShake;
    const roll = this.bob.x * 0.35 + Math.sin(t * 31) * sh * 0.012 + Math.sin(t * 83) * fs * 0.004 + rollTilt + this.hitKickR + (this.alive ? 0 : 0.5 * Math.min(1, (this.time - this.lastDamage) * 1.4));
    cam.rotation.set(
      this.pitch + this.recoilPitch + this.swayPitch + Math.sin(t * 37) * sh * 0.016 + Math.sin(t * 71) * fs * 0.0035 - this.landKick * 0.035 + rollPitch + this.hitKickP,
      this.yaw + this.recoilYaw + this.swayYaw + Math.cos(t * 29) * sh * 0.016 + Math.cos(t * 67) * fs * 0.003 + this.bob.x * 0.25,
      roll, 'YXZ');
    // field of view: the setting, narrowed by the weapon's aim zoom or its scope, widened a touch by sprint and each shot
    const base = clamp(this.settings.fov, 60, 110);
    const tb = Math.tan(base * D2R / 2);
    let tf = tb / Math.pow(this.aimZoom, this.adsT);
    if (this.scopeFov > 0 && this.scopeT > 0) tf = Math.exp(lerp(Math.log(tf), Math.log(Math.tan(this.scopeFov * D2R / 2)), this.scopeT));
    const zoom = tf / tb;
    this.fovTarget = 2 * Math.atan(tf) / D2R + (this.sprinting ? 5 : 0) * zoom;
    this.fov += (this.fovTarget - this.fov) * Math.min(1, dt * (this.scopeFov > 0 ? 24 : 13));
    this.zoomK = Math.min(1, Math.tan(this.fov * D2R / 2) / tb);
    const view = this.fov + this.fovKick * zoom;      // each shot punches the picture out for an instant
    if (Math.abs(cam.fov - view) > 0.01) { cam.fov = view; cam.updateProjectionMatrix(); }
    // where the recent blows came from, relative to the view (0 = ahead, + = right)
    const arcs = this.damageArcs;
    arcs.length = 0;
    for (let k = this.hits.length - 1; k >= 0; k--) {
      const hh = this.hits[k], age = this.time - hh.t;
      if (age > 1.6) { this.hits.splice(k, 1); continue; }
      const none = hh.x === 0 && hh.z === 0;
      arcs.push({ angle: none ? 0 : Math.atan2(hh.x * Math.cos(this.yaw) - hh.z * Math.sin(this.yaw), -hh.x * Math.sin(this.yaw) - hh.z * Math.cos(this.yaw)), age, life: 1.6, strength: clamp(hh.amount / 25, 0.3, 1), directional: !none, kind: hh.kind });
    }
  }

  forward(out = new THREE.Vector3()) {
    const p = this.pitch + this.recoilPitch + this.swayPitch, y = this.yaw + this.recoilYaw + this.swayYaw;
    return out.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
  }
}
