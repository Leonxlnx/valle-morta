// Audio: Web Audio playback of the licensed sound library listed in
// public/assets/audio/manifest.json. Every lookup is tolerant: a missing
// sound or manifest simply plays nothing.
//
// manifest.json: { "sounds": { "<name>": { "files": ["a.mp3", ...], "volume": 1, "category": "sfx"|"music"|"ambient", "loop": false } } }
import * as THREE from 'three';

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.sounds = {};
    this.loops = new Map();     // name -> { src, gain } currently sounding
    this.want = new Map();      // name -> { volume, fade } requested beds (survives until the context exists)
    this.vol = { master: 0.8, music: 0.6, sfx: 0.9 };
    this.ready = false;
    this.alias = {};
    this._fwd = new THREE.Vector3(); this._up = new THREE.Vector3(); this._pos = new THREE.Vector3();
    this._tape = null;          // film sound log (startTape / stopTape); null in normal play
  }

  async load(base = './assets/audio/') {
    this.base = base;
    try {
      const res = await fetch(`${base}manifest.json`);
      if (!res.ok) throw new Error('no manifest');
      const m = await res.json();
      for (const name in m.sounds || {}) {
        const s = m.sounds[name];
        const files = Array.isArray(s.files) ? s.files : (s.file ? [s.file] : []);
        this.sounds[name] = { ...s, key: name, files, buffers: [], bufFiles: [], loading: null };
      }
      this.ready = true;
    } catch (e) {
      console.info('[audio] no sound manifest; running silent');
    }
  }

  // exact name, else the closest relative in the library (sound sets differ slightly in naming)
  _find(name) {
    if (name in this.sounds) return this.sounds[name];
    if (name in this.alias) return this.alias[name];
    const keys = Object.keys(this.sounds), parts = name.split('_');
    const k = keys.find((x) => x.startsWith(name) || name.startsWith(x))
      || keys.find((x) => parts.every((q) => x.includes(q)))
      || (parts[0] === 'step' ? ['step_stone', 'step_gravel', 'step_grass'].find((x) => x in this.sounds) : null)
      || (parts[0] === 'bell' ? keys.find((x) => x.includes('bell') || x.includes('toll') || x.includes('chime')) : null);
    return (this.alias[name] = k ? this.sounds[k] : null);
  }

  has(name) { return !!this._find(name); }
  // the library holds a recording under exactly this name (no look-alike substitution)
  exact(name) { return name in this.sounds; }

  // one named sound, or a stand-in played at another rate until the real recording is added to the manifest
  playFirst(name, fallback, opts = {}, fallbackOpts = {}) {
    if (this.exact(name)) this.play(name, opts);
    else if (fallback) this.play(fallback, { ...opts, ...fallbackOpts });
  }

  // 0 = clear, 1 = heavily muffled (low health, death)
  setMuffle(k) {
    k = Math.max(0, Math.min(1, k));
    if (!this.ctx || !this.lp || Math.abs(k - (this._muffle ?? 0)) < 0.02) return;
    this._muffle = k;
    this.lp.frequency.setTargetAtTime(20000 * Math.pow(0.03, k), this.ctx.currentTime, 0.25);
  }

  _ensureCtx() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { this.ctx = new AC(); } catch (e) { return null; }
    this.master = this.ctx.createGain();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    // a low-pass between the mix and the limiter: closes as the player nears death
    this.lp = this.ctx.createBiquadFilter();
    this.lp.type = 'lowpass'; this.lp.frequency.value = 20000; this.lp.Q.value = 0.4;
    this.master.connect(this.lp); this.lp.connect(comp); comp.connect(this.ctx.destination);
    this.bus = { sfx: this.ctx.createGain(), music: this.ctx.createGain(), ambient: this.ctx.createGain() };
    for (const k in this.bus) this.bus[k].connect(this.master);
    this.applyVolumes(true);
    return this.ctx;
  }

  // must be called from a user gesture; starts any beds requested before the context existed
  resume() {
    const c = this._ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    for (const [name, w] of this.want) if (!this.loops.has(name)) this._startLoop(name, w.fade);
  }

  setVolumes(v) { Object.assign(this.vol, v); this.applyVolumes(); }
  applyVolumes(now = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (param, v) => { if (now) param.value = v; else param.setTargetAtTime(v, t, 0.05); };
    set(this.master.gain, this.vol.master);
    set(this.bus.sfx.gain, this.vol.sfx);
    set(this.bus.ambient.gain, this.vol.sfx * 0.9);
    set(this.bus.music.gain, this.vol.music);
  }

  _load(s) {
    if (s.loading) return s.loading;
    const c = this._ensureCtx();
    if (!c) return Promise.resolve([]);
    s.loading = Promise.all(s.files.map(async (f) => {
      try {
        const ab = await (await fetch(this.base + f)).arrayBuffer();
        return await c.decodeAudioData(ab);
      } catch (e) { return null; }
    })).then((b) => { s.bufFiles = s.files.filter((f, i) => b[i]); s.buffers = b.filter(Boolean); return s.buffers; });
    return s.loading;
  }

  // decode the short one-shots up front so the first shot is not late
  async preload(names) {
    if (!this.ready || !this.ctx) return;
    await Promise.all((names || Object.keys(this.sounds)).map((n) => this._find(n) && this._load(this._find(n))));
  }

  // v: a variant/pitch draw made earlier (the tape logs it), else drawn here as always
  _start(s, opts, panner, v) {
    const c = this.ctx;
    if (!c || !s.buffers.length) return null;
    v = v || this._variant(s, opts);
    const src = c.createBufferSource();
    src.buffer = s.buffers[v.i];
    src.loop = !!(opts.loop ?? s.loop);
    src.playbackRate.value = v.rate;
    const g = c.createGain();
    g.gain.value = (s.volume ?? 1) * (opts.volume ?? 1);
    src.connect(g);
    const bus = this.bus[s.category] || this.bus.sfx;
    if (panner) { g.connect(panner); panner.connect(bus); } else g.connect(bus);
    src.start(c.currentTime + (opts.delay ?? 0));
    return { src, gain: g };
  }

  _variant(s, opts) {
    const i = Math.floor(Math.random() * s.buffers.length);
    return { i, rate: (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * (opts.pitchVar ?? 0)), file: s.bufFiles[i] };
  }

  play(name, opts = {}) {
    const s = this._find(name);
    if (!s) return;
    const v = this._tape ? this._tapeShot(s, opts, null) : null;
    if (!this.ctx) return;
    if (s.buffers.length) this._start(s, opts, null, v); else this._load(s);
  }

  playAt(name, pos, opts = {}) {
    const s = this._find(name);
    if (!s) return;
    const v = this._tape ? this._tapeShot(s, opts, pos) : null;
    if (!this.ctx) return;
    if (!s.buffers.length) { this._load(s); return; }
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = opts.ref ?? 4; p.rolloffFactor = opts.rolloff ?? 1.1; p.maxDistance = 400;
    p.positionX.value = pos.x; p.positionY.value = pos.y + (opts.height ?? 1.2); p.positionZ.value = pos.z;
    this._start(s, opts, p, v);
  }

  // looping bed (music / ambience) with fades, controlled by name
  loop(name, volume = 1, fade = 1.5) {
    this.want.set(name, { volume, fade });
    const s = this._find(name);
    if (this._tape && s) this._tapeLoop(s, volume, fade);
    if (!s || !this.ctx) return;
    const cur = this._lget(name);
    if (cur) { cur.gain.gain.setTargetAtTime(Math.max(0.0001, (s.volume ?? 1) * volume), this.ctx.currentTime, fade / 3); return; }
    this._startLoop(name, fade);
  }

  _startLoop(name, fade = 1.5) {
    const s = this._find(name);
    if (!s || !this.ctx) return;
    this._load(s).then(() => {
      const w = this.want.get(name);
      if (!w || this.loops.has(name)) return;      // stopped again while decoding
      const h = this._start(s, { loop: true, volume: 0.0001 });
      if (!h) return;
      h.gain.gain.setTargetAtTime(Math.max(0.0001, (s.volume ?? 1) * w.volume), this.ctx.currentTime, fade / 3);
      this.loops.set(name, h);
    });
  }

  stopLoop(name, fade = 1.5) {
    this.want.delete(name);
    if (this._tape) this._tapeStop(name, fade);
    const h = this._lget(name);
    if (!h || !this.ctx) return;
    this.loops.delete(name);
    h.gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, fade / 3);
    try { h.src.stop(this.ctx.currentTime + fade * 1.6); } catch (e) { /* already stopped */ }
  }

  setLoopVolume(name, volume, tc = 0.3) {
    const w = this.want.get(name);
    if (w) w.volume = volume;
    const h = this._lget(name), s = this._find(name);
    if (this._tape && s && w) this._tapeGain(s.key, (s.volume ?? 1) * volume);
    if (h && s && this.ctx) h.gain.gain.setTargetAtTime(Math.max(0.0001, (s.volume ?? 1) * volume), this.ctx.currentTime, tc);
  }

  updateListener(camera) {
    this._cam = camera;
    if (!this.ctx) return;
    const l = this.ctx.listener;
    camera.getWorldPosition(this._pos);
    this._fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      l.positionX.value = this._pos.x; l.positionY.value = this._pos.y; l.positionZ.value = this._pos.z;
      l.forwardX.value = this._fwd.x; l.forwardY.value = this._fwd.y; l.forwardZ.value = this._fwd.z;
      l.upX.value = this._up.x; l.upY.value = this._up.y; l.upZ.value = this._up.z;
    } else {
      l.setPosition(this._pos.x, this._pos.y, this._pos.z);
      l.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
    }
  }

  // ---------------------------------------------------------------- tape
  // The film is rendered far slower than real time, so its sound is rebuilt
  // offline (cinematic/finish.mjs) from a log of every sound the game starts.
  // clockFn() returns the film time in seconds since the start of the shot.
  // Nothing here runs, and no random number is drawn differently, unless a tape is running.
  _lget(name) { return Map.prototype.get.call(this.loops, name); }

  startTape(clockFn) {
    if (this._tape) this.stopTape();
    const tp = this._tape = { clock: clockFn, events: [], ids: new Map(), last: new Map(), next: 1, seed: 0x2545f491 };
    // the tank sets its loops' pitch on the handle directly: hand out a stand-in handle that logs it
    this.loops.get = (name) => {
      const h = this._lget(name), id = tp.ids.get(name);
      if (!id || this._tape !== tp) return h;
      const real = () => this._lget(name);
      return {
        gain: h ? h.gain : null,
        src: {
          stop: (t) => real()?.src.stop(t),
          playbackRate: {
            get value() { return real()?.src.playbackRate.value ?? 1; },
            set value(v) { const r = real(); if (r) r.src.playbackRate.value = v; },
            setTargetAtTime: (v, t, tc) => { this._tapeRate(name, v); const r = real(); if (r) r.src.playbackRate.setTargetAtTime(v, t, tc); },
          },
        },
      };
    };
    for (const [name, w] of this.want) { const s = this._find(name); if (s) this._tapeLoop(s, w.volume, 0); }
  }

  stopTape() {
    const tp = this._tape;
    if (!tp) return { events: [] };
    delete this.loops.get;
    this._tape = null;
    const events = tp.events.map((e, k) => [e, k]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map((x) => x[0]);
    return JSON.parse(JSON.stringify({ events }));
  }

  _tnow() { try { const t = +this._tape.clock(); return Number.isFinite(t) ? t : 0; } catch (e) { return 0; } }
  // the tape's own random numbers (variants of sounds whose recordings are not decoded): Math.random stays untouched
  _trand() { const tp = this._tape; tp.seed = (tp.seed + 0x6d2b79f5) | 0; let x = tp.seed; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }
  _ear() {
    const c = this._cam;
    if (!c) return { ear: null, fwd: null };
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    c.getWorldPosition(p); c.getWorldQuaternion(q);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q), r = (v) => +v.toFixed(3);
    return { ear: [r(p.x), r(p.y), r(p.z)], fwd: [r(f.x), r(f.y), r(f.z)] };
  }

  // a one-shot: returns the variant/pitch draw so the real playback uses the same one
  _tapeShot(s, opts, pos) {
    const tp = this._tape;
    let v = null, file, rate;
    if (this.ctx && s.buffers.length) { v = this._variant(s, opts); file = v.file; rate = v.rate; }
    else { file = s.files[Math.floor(this._trand() * s.files.length)]; rate = (opts.rate ?? 1) * (1 + (this._trand() * 2 - 1) * (opts.pitchVar ?? 0)); }
    if (!file) return v;
    const e = { t: +(this._tnow() + (opts.delay ?? 0)).toFixed(4), id: tp.next++, name: s.key, file, gain: +((s.volume ?? 1) * (opts.volume ?? 1)).toFixed(4), rate: +rate.toFixed(4), loop: !!(opts.loop ?? s.loop), cat: s.category || 'sfx', pos: null, ...this._ear() };
    if (pos) { e.pos = [+pos.x.toFixed(3), +(pos.y + (opts.height ?? 1.2)).toFixed(3), +pos.z.toFixed(3)]; e.ref = opts.ref ?? 4; e.rolloff = opts.rolloff ?? 1.1; }
    tp.events.push(e);
    return v;
  }

  _tapeLoop(s, volume, fade) {
    const tp = this._tape, name = s.key, gain = (s.volume ?? 1) * volume;
    if (tp.ids.has(name)) { this._tapeGain(name, gain, true); return; }
    const file = (s.bufFiles.length ? s.bufFiles : s.files)[0];
    if (!file) return;
    const id = tp.next++, t = this._tnow();
    tp.ids.set(name, id); tp.last.set(id, { t, gain, rate: 1, rt: -1, pt: -1 });
    tp.events.push({ t: +t.toFixed(4), id, name, file, gain: +gain.toFixed(5), rate: 1, loop: true, cat: s.category || 'sfx', fade, pos: null, ...this._ear() });
  }

  _tapeStop(name, fade) {
    const tp = this._tape, id = tp.ids.get(name);
    if (!id) return;
    tp.ids.delete(name);
    tp.events.push({ t: +this._tnow().toFixed(4), id, stop: true, fade });
  }

  // gain and pitch of running loops change every frame: log about ten times a second, or at once on a big step
  _tapeGain(name, gain, force) {
    const tp = this._tape, id = tp.ids.get(name);
    if (!id) return;
    const l = tp.last.get(id), t = this._tnow(), db = Math.abs(20 * Math.log10(Math.max(1e-5, gain) / Math.max(1e-5, l.gain)));
    if (db < 0.25 || (!force && db < 6 && t - l.t < 0.1 && t >= l.t)) return;
    l.t = t; l.gain = gain;
    tp.events.push({ t: +t.toFixed(4), id, gain: +gain.toFixed(5) });
  }

  _tapeRate(name, rate) {
    const tp = this._tape, id = tp?.ids.get(name);
    if (!id) return;
    const l = tp.last.get(id), t = this._tnow();
    if (Math.abs(rate - l.rate) < 0.004 || (t - l.rt < 0.1 && t >= l.rt)) return;
    l.rt = t; l.rate = rate;
    tp.events.push({ t: +t.toFixed(4), id, rate: +rate.toFixed(4) });
  }

  // moving sources (helicopter, tank): the film or game may report a running loop's position about ten
  // times a second; this only logs it (with the listener), the game's sound is unchanged
  setLoopPos(name, pos) {
    const tp = this._tape, id = tp?.ids.get(name);
    if (!id || !pos) return;
    const l = tp.last.get(id), t = this._tnow();
    if (t - l.pt < 0.1 && t >= l.pt) return;
    l.pt = t;
    tp.events.push({ t: +t.toFixed(4), id, pos: [+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3)], ...this._ear() });
  }
}
