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
        this.sounds[name] = { ...s, files, buffers: [], loading: null };
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

  _ensureCtx() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { this.ctx = new AC(); } catch (e) { return null; }
    this.master = this.ctx.createGain();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(this.ctx.destination);
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
    })).then((b) => { s.buffers = b.filter(Boolean); return s.buffers; });
    return s.loading;
  }

  // decode the short one-shots up front so the first shot is not late
  async preload(names) {
    if (!this.ready || !this.ctx) return;
    await Promise.all((names || Object.keys(this.sounds)).map((n) => this._find(n) && this._load(this._find(n))));
  }

  _start(s, opts, panner) {
    const c = this.ctx;
    if (!c || !s.buffers.length) return null;
    const src = c.createBufferSource();
    src.buffer = s.buffers[Math.floor(Math.random() * s.buffers.length)];
    src.loop = !!(opts.loop ?? s.loop);
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * (opts.pitchVar ?? 0));
    const g = c.createGain();
    g.gain.value = (s.volume ?? 1) * (opts.volume ?? 1);
    src.connect(g);
    const bus = this.bus[s.category] || this.bus.sfx;
    if (panner) { g.connect(panner); panner.connect(bus); } else g.connect(bus);
    src.start(c.currentTime + (opts.delay ?? 0));
    return { src, gain: g };
  }

  play(name, opts = {}) {
    const s = this._find(name);
    if (!s || !this.ctx) return;
    if (s.buffers.length) this._start(s, opts); else this._load(s);
  }

  playAt(name, pos, opts = {}) {
    const s = this._find(name);
    if (!s || !this.ctx) return;
    if (!s.buffers.length) { this._load(s); return; }
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = opts.ref ?? 4; p.rolloffFactor = opts.rolloff ?? 1.1; p.maxDistance = 400;
    p.positionX.value = pos.x; p.positionY.value = pos.y + (opts.height ?? 1.2); p.positionZ.value = pos.z;
    this._start(s, opts, p);
  }

  // looping bed (music / ambience) with fades, controlled by name
  loop(name, volume = 1, fade = 1.5) {
    this.want.set(name, { volume, fade });
    const s = this._find(name);
    if (!s || !this.ctx) return;
    const cur = this.loops.get(name);
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
    const h = this.loops.get(name);
    if (!h || !this.ctx) return;
    this.loops.delete(name);
    h.gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, fade / 3);
    try { h.src.stop(this.ctx.currentTime + fade * 1.6); } catch (e) { /* already stopped */ }
  }

  setLoopVolume(name, volume, tc = 0.3) {
    const w = this.want.get(name);
    if (w) w.volume = volume;
    const h = this.loops.get(name), s = this._find(name);
    if (h && s && this.ctx) h.gain.gain.setTargetAtTime(Math.max(0.0001, (s.volume ?? 1) * volume), this.ctx.currentTime, tc);
  }

  updateListener(camera) {
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
}
