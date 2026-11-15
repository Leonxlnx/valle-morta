// Touch controls: a floating move stick on the left half, drag-to-look on the right half, a fire
// button that keeps turning the view while held, and the buttons around it. Every finger is
// tracked by its identifier from the moment it lands until it lifts or the system cancels it, so
// move, look and fire work at the same time and a finger sliding off a button never sticks.
// Also owns fullscreen, the landscape lock and the browser gestures that must stay out of the way.
import './touch.css';
import { TOUCH, MOBILE, IOS } from '../core/device.js';

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON = {
  fire: svg('<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.2" class="dot"/>'),
  ads: svg('<path d="M3 12c2.4-4.2 5.4-6.3 9-6.3s6.6 2.1 9 6.3c-2.4 4.2-5.4 6.3-9 6.3S5.4 16.2 3 12Z"/><circle cx="12" cy="12" r="2.6"/>'),
  reload: svg('<path d="M19.2 9.5A7.6 7.6 0 1 0 19.6 14"/><path d="M19.8 4.6v5h-5"/>'),
  jump: svg('<path d="M6 13.5 12 7.5l6 6M6 18.5l6-6 6 6"/>'),
  crouch: svg('<path d="M6 5.5l6 6 6-6M6 12.5l6 6 6-6"/>'),
  roll: svg('<path d="M4.5 15.5a7.5 7.5 0 0 1 14.6-2.4"/><path d="M20.5 8.6l-1.3 4.6-4.5-1.4"/><path d="M4 19.5h16"/>'),
  bandage: svg('<rect x="3.5" y="8" width="17" height="8" rx="4" transform="rotate(-35 12 12)"/><path d="M10.6 10.6h.01M13.4 13.4h.01M13.4 10.6h.01M10.6 13.4h.01"/>'),
  pause: svg('<path d="M9 6.5v11M15 6.5v11"/>'),
  swap: svg('<path d="M4.5 9h13l-3.5-3.5M19.5 15h-13l3.5 3.5"/>'),
};
const ABILITY_CODES = ['KeyG', 'Digit4', 'Digit5'];
const PROMPT_CODES = { F: 'KeyF', Q: 'KeyQ', H: 'KeyH' };
const R_STICK = 58;           // move stick radius, CSS px (scaled with the controls)
const HOLD_PRONE = 0.38;      // s: holding crouch this long lies down
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------ fullscreen and orientation
export const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
export const canFullscreen = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
// Must run inside a user gesture (a tap's touchend or click). Locks to landscape where the browser allows it.
export function enterFullscreen() {
  const d = document.documentElement;
  const lock = () => { try { const p = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not supported */ } };
  if (isFullscreen()) { lock(); return Promise.resolve(true); }
  try {
    const r = d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' }) : d.webkitRequestFullscreen ? d.webkitRequestFullscreen() : null;
    if (r && r.then) return r.then(() => { lock(); return true; }, () => false);
    lock();
    return Promise.resolve(!!r);
  } catch (e) { return Promise.resolve(false); }
}

// Browser gestures that would fight the game: zoom, pull-to-refresh, callouts, context menu, selection.
function guardGestures() {
  const stop = (e) => { if (e.cancelable) e.preventDefault(); };
  document.addEventListener('gesturestart', stop, { passive: false });      // iOS pinch
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('dblclick', stop, { passive: false });
  // long-press callouts and selection on touch only; the desktop keeps its context menu outside the canvas
  const touchOn = () => document.body.classList.contains('touch');
  document.addEventListener('contextmenu', (e) => { if (touchOn() && !e.target.closest('input')) e.preventDefault(); });
  document.addEventListener('selectstart', (e) => { if (touchOn() && !e.target.closest('input')) e.preventDefault(); });
  // two fingers anywhere outside the game controls never zoom; a lone finger may still scroll a long list
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 && e.cancelable) e.preventDefault();
    else if (e.cancelable && !e.target.closest('.scroll, .sheet.wide, .base-body, .sheet, input')) e.preventDefault();
  }, { passive: false });
  // iOS fires a double-tap zoom on a quick second touchend
  let lastEnd = 0;
  document.addEventListener('touchend', (e) => { const t = e.timeStamp; if (t - lastEnd < 320 && e.cancelable && !e.target.closest('input, button, [data-act], [data-tc], label')) e.preventDefault(); lastEnd = t; }, { passive: false });
}

export class TouchControls {
  // handlers: pause()
  constructor(ui, settings, handlers) {
    this.ui = ui; this.settings = settings; this.h = handlers;
    this.game = null;
    this.on = false;                        // touch is the input in use (the controls are shown)
    this.st = { fwd: 0, strafe: 0, sprint: false, fire: false, ads: false, crouch: false, jump: false, reload: false };
    this.fingers = new Map();               // identifier -> record
    this.move = null; this.reloadT = 0; this.assist = 1; this.assistOn = false; this.lookV = 0;
    this.taps = 0; this.lookTotal = 0;      // counters for the tests

    this.zone = document.createElement('div');
    this.zone.className = 'tc-zone';
    this.el = document.createElement('div');
    this.el.className = 'tc';
    const b = (id, label, cls = '') => `<button type="button" class="tc-btn ${cls}" data-tc="${id}" aria-label="${label}">${ICON[id]}</button>`;
    this.el.innerHTML = `
      <div class="tc-rest"></div>
      <div class="tc-stick"><i></i><b></b></div>
      ${b('fire', 'Fire', 'tc-fire')}${b('ads', 'Aim', 'tc-ads')}${b('reload', 'Reload', 'tc-reload')}${b('jump', 'Jump', 'tc-jump')}${b('crouch', 'Crouch, hold to lie down', 'tc-crouch')}${b('roll', 'Dodge roll', 'tc-roll')}
      <button type="button" class="tc-btn tc-band" data-tc="bandage" aria-label="Use a bandage">${ICON.bandage}<em>0</em></button>
      ${b('pause', 'Pause', 'tc-pause')}`;
    this.stick = this.el.querySelector('.tc-stick'); this.knob = this.stick.querySelector('b');
    this.btn = {}; this.el.querySelectorAll('[data-tc]').forEach((e) => { this.btn[e.dataset.tc] = e; });
    this.bandNum = this.btn.bandage.querySelector('em');

    guardGestures();
    const opt = { passive: false };
    const root = ui.root;
    root.addEventListener('touchstart', (e) => this._start(e), opt);
    root.addEventListener('touchmove', (e) => this._move(e), opt);
    root.addEventListener('touchend', (e) => this._end(e, false), opt);
    root.addEventListener('touchcancel', (e) => this._end(e, true), opt);
    // whichever input was used last decides which controls show (a touch laptop, a tablet with a mouse)
    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') this.setMode(true); else if (e.pointerType === 'mouse' && !MOBILE) this.setMode(false); }, true);
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    // the first tap anywhere outside a run goes fullscreen on a phone (a browser only allows it from a gesture)
    const auto = () => { if (MOBILE && this.on && !isFullscreen() && canFullscreen() && (!this.game || this.game.state !== 'playing')) enterFullscreen(); };
    document.addEventListener('touchend', auto, true);
    document.addEventListener('click', auto, true);
    document.body.classList.toggle('mobile', MOBILE);
    document.body.classList.toggle('ios', IOS);
    this.setMode(TOUCH);
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  setMode(on) {
    on = !!on;
    if (on === this.on) return;
    this.on = on;
    if (!on) this.releaseAll();
    document.body.classList.toggle('touch', on);
    this.ui.onInputMode?.(on);
  }

  // control size: a touch larger on tablets, times the setting
  layout() {
    const big = Math.min(window.innerWidth, window.innerHeight) >= 600;
    const k = (big ? 1.2 : 1) * clamp(Number(this.settings.touchSize) || 1, 0.8, 1.3);
    document.documentElement.style.setProperty('--tk', k.toFixed(3));
    this.k = k;
  }

  get active() { return this.on && !!this.game && this.game.state === 'playing'; }

  _press(code) { const p = this.game && this.game.player; if (p && p.enabled) p.pressed.add(code); }
  _buzz(ms = 8) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* not allowed */ } }

  // ------------------------------------------------------------ touch events
  _start(e) {
    if (!this.active) return;
    let used = false;
    for (const t of e.changedTouches) {
      const tgt = t.target instanceof Element ? t.target : null;
      const ctl = tgt && tgt.closest('[data-tc]');
      const inZone = tgt && (tgt === this.zone || tgt.closest('.tc-zone'));
      if (!ctl && !inZone) continue;
      used = true;
      const f = { id: t.identifier, kind: 'look', x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, t: e.timeStamp, lt: e.timeStamp, el: ctl };
      if (ctl) this._button(ctl, f, e.timeStamp);
      else if (t.clientX < window.innerWidth * 0.45 && !this.move) {
        f.kind = 'move';
        const k = this.k, r = R_STICK * k, m = r + 10;
        f.cx = clamp(t.clientX, m, window.innerWidth * 0.5 - r); f.cy = clamp(t.clientY, m, window.innerHeight - m * 0.75);
        this.move = f;
        this.stick.classList.add('on');
        this.stick.style.transform = `translate(${f.cx.toFixed(1)}px, ${f.cy.toFixed(1)}px)`;
        this._stick(f);
      }
      this.fingers.set(t.identifier, f);
    }
    if (used && e.cancelable) e.preventDefault();       // no mouse emulation, no click, no zoom, no scroll
  }

  _button(ctl, f, now) {
    const id = ctl.dataset.tc, st = this.st;
    f.kind = 'btn'; f.btn = id;
    ctl.classList.add('down');
    this.taps++;
    if (id === 'fire') { f.kind = 'fire'; st.fire = true; return; }
    if (id === 'crouch') { f.kind = 'crouch'; f.timer = setTimeout(() => { f.timer = 0; f.held = true; this._press('KeyZ'); this._buzz(14); }, HOLD_PRONE * 1000); return; }
    if (id === 'jump') { st.jump = true; return; }
    this._buzz();
    const p = this.game.player;
    if (id === 'ads') st.ads = !st.ads;
    else if (id === 'reload') this.reloadT = 0.18;
    else if (id === 'roll') this._press('KeyV');
    else if (id === 'bandage') this._press('KeyH');
    else if (id === 'swap') this._press('KeyQ');
    else if (id === 'pause') { this.releaseAll(); this.h.pause?.(); }
    else if (id === 'ab') this._press(ABILITY_CODES[Number(ctl.dataset.i) || 0]);
    else if (id === 'prompt') {
      const g = this.game, key = ctl.dataset.key;
      if (g.interact) this._press('KeyF');
      else if (key === 'R') this.reloadT = 0.18;
      else if (PROMPT_CODES[key]) this._press(PROMPT_CODES[key]);
    }
    void p;
  }

  _move(e) {
    if (!this.fingers.size) return;
    let used = false;
    for (const t of e.changedTouches) {
      const f = this.fingers.get(t.identifier);
      if (!f) continue;
      used = true;
      const dx = t.clientX - f.lx, dy = t.clientY - f.ly, dt = Math.max(1, e.timeStamp - f.lt);
      f.lx = t.clientX; f.ly = t.clientY; f.lt = e.timeStamp;
      if (f.kind === 'move') this._stick(f);
      else if (f.kind === 'look' || f.kind === 'fire') this._look(dx, dy, dt);
    }
    if (used && e.cancelable) e.preventDefault();
  }

  _end(e, cancelled) {
    let used = false;
    for (const t of e.changedTouches) {
      const f = this.fingers.get(t.identifier);
      if (!f) continue;
      used = true;
      this.fingers.delete(t.identifier);
      this._release(f, cancelled);
    }
    if (used && e.cancelable) e.preventDefault();
  }

  _release(f, cancelled) {
    const st = this.st;
    if (f.el) f.el.classList.remove('down');
    if (f.kind === 'move') { this.move = null; st.fwd = st.strafe = 0; st.sprint = false; this.stick.classList.remove('on', 'run'); }
    else if (f.kind === 'fire') { if (![...this.fingers.values()].some((o) => o.kind === 'fire')) st.fire = false; }
    else if (f.btn === 'jump') st.jump = false;
    else if (f.kind === 'crouch') {
      if (f.timer) { clearTimeout(f.timer); f.timer = 0; }
      // a tap: out of prone, or crouch on / off
      if (!f.held && !cancelled && this.game) {
        const p = this.game.player;
        if (p.proneWanted) { this._press('KeyZ'); st.crouch = false; } else st.crouch = !st.crouch;
        this._buzz();
      }
    }
  }

  releaseAll() {
    for (const f of this.fingers.values()) { if (f.timer) clearTimeout(f.timer); f.held = true; this._release(f, true); }
    this.fingers.clear();
    const st = this.st;
    st.fwd = st.strafe = 0; st.sprint = st.fire = st.jump = st.reload = false;
    this.move = null; this.reloadT = 0;
    this.stick.classList.remove('on', 'run');
    this.el.querySelectorAll('.down').forEach((x) => x.classList.remove('down'));
    if (this.game && this.game.player) this.game.player.tlook.x = this.game.player.tlook.y = 0;
  }

  // the stick follows a thumb that runs past its edge, so a sprint never runs out of travel
  _stick(f) {
    const k = this.k, r = R_STICK * k, st = this.st;
    let dx = f.lx - f.cx, dy = f.ly - f.cy, d = Math.hypot(dx, dy);
    const lim = r * 1.25;
    if (d > lim) { const s = (d - lim) / d; f.cx += dx * s; f.cy += dy * s; dx = f.lx - f.cx; dy = f.ly - f.cy; d = lim; this.stick.style.transform = `translate(${f.cx.toFixed(1)}px, ${f.cy.toFixed(1)}px)`; }
    const dead = 0.1, m = clamp((d / r - dead) / (1 - dead), 0, 1);
    const ux = d > 0 ? dx / d : 0, uy = d > 0 ? dy / d : 0;
    st.strafe = ux * m; st.fwd = -uy * m;
    // pushed to the edge and mostly forward: sprint (aiming drops, as it does on the keyboard)
    const run = d >= r * 0.96 && -uy > 0.62;
    if (run && !st.sprint) st.ads = false;
    st.sprint = run;
    if (run) st.fwd = 1;
    this.stick.classList.toggle('run', run);
    const kd = Math.min(d, r);
    this.knob.style.transform = `translate(${(ux * kd).toFixed(1)}px, ${(uy * kd).toFixed(1)}px)`;
  }

  // thumb look: radians per CSS pixel, a little acceleration for fast flicks, slowed over an infected by the aim assist
  _look(dx, dy, dt) {
    const v = Math.hypot(dx, dy) / dt;                     // px per ms
    this.lookV += (v - this.lookV) * 0.5;
    const accel = 1 + 0.55 * clamp((this.lookV - 0.25) / 1.4, 0, 1);
    const s = 0.0052 * clamp(Number(this.settings.touchSens) || 1, 0.2, 3) * accel * this.assist;
    const p = this.game.player;
    p.touchLook(dx * s, dy * s * 0.9);
    this.lookTotal += Math.abs(dx) + Math.abs(dy);
  }

  // ------------------------------------------------------------ per frame (from UI.update while playing)
  update(game, dt) {
    this.game = game;
    const p = game.player, st = this.st;
    if (!this.on) { if (p.touch) p.touch = null; return; }
    this.reloadT = Math.max(0, this.reloadT - dt);
    st.reload = this.reloadT > 0;
    p.touch = st;
    // aim assist: the view slows a little while the reticle sits on an infected (never pulls)
    let a = 1;
    if (this.settings.aimAssist !== false && p.alive && !p.vehicle && this.fingers.size) a = this._assist(game);
    this.assist += (a - this.assist) * Math.min(1, dt * 14);
    this.assistOn = a < 1;
    // what the buttons show
    const op = game.mode === 'operation' ? game.operation : null;
    const off = !p.alive || !!(op && op.cinematic);
    if (off && this.fingers.size) this.releaseAll();
    const c = this.el.classList;
    if (c.contains('off') !== off) c.toggle('off', off);
    const veh = !!p.vehicle;
    if (c.contains('veh') !== veh) c.toggle('veh', veh);
    this.btn.ads.classList.toggle('on', st.ads);
    this.btn.crouch.classList.toggle('on', p.proneWanted || st.crouch);
    this.btn.crouch.classList.toggle('prone', p.proneWanted);
    const nb = String(p.bandages);
    if (this.bandNum.textContent !== nb) this.bandNum.textContent = nb;
    this.btn.bandage.classList.toggle('dim', p.bandages <= 0);
    if (!p.alive && st.ads) st.ads = false;
  }

  _assist(game) {
    const cam = game.engine.camera, list = game.zombies.list;
    const e = cam.matrixWorld.elements, fx = -e[8], fy = -e[9], fz = -e[10];
    const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
    let best = 1;
    for (let i = 0; i < list.length; i++) {
      const z = list[i];
      if (!z.alive || !z.pos) continue;
      const tx = z.pos.x - ox, tz = z.pos.z - oz;
      // the nearest of three points up the body (legs, chest, head) to the aim line
      for (const hgt of [0.55, 1.15, 1.65]) {
        const ty = z.pos.y + hgt - oy, d = Math.hypot(tx, ty, tz);
        if (d < 1.5 || d > 90) break;
        const along = tx * fx + ty * fy + tz * fz;
        if (along <= 0) break;
        const off = Math.sqrt(Math.max(0, d * d - along * along));   // metres from the aim line
        const reach = 0.5 + d * 0.012;                                 // the body plus a little, wider far away
        if (off < reach) best = Math.min(best, 0.58 + 0.42 * (off / reach) * (off / reach));
      }
    }
    return best;
  }
}
