// Game: ties player, weapons, infected, effects, audio and UI together and runs
// Survival mode: the wave director, supply crates and bandage drops.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Collision } from './collision.js';
import { Player } from './player.js';
import { FX } from './fx.js';
import { Weapon } from './weapon.js';
import { Zombies, INFECTED } from './zombies.js';
import { AudioSystem } from './audio.js';
import { enhance } from '../engine/materials.js';

const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _n = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
// street positions inside the village to start from (first one that is free), looking at the church tower
const START = [[15, -55], [11.5, -50.5], [18.5, -59.5], [25, -68], [4, -42]];
export const CRATE = { rifle: 90, sniper: 10, bandages: 2, reach: 2.3, size: [0.95, 0.52, 0.6] };

// ---------------------------------------------------------------- supplies
// Crates and dropped bandage rolls. Built from boxes here; a crate is a solid obstacle.
class Supply {
  constructor(engine, collision, terrain, zombies) {
    this.engine = engine; this.col = collision; this.terrain = terrain; this.zombies = zombies;
    this.crates = []; this.pickups = []; this.free = [];
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    let s = 31;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    g.fillStyle = '#7a6144'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5; i++) { g.fillStyle = `rgb(${112 + rnd() * 26 | 0},${88 + rnd() * 20 | 0},${58 + rnd() * 16 | 0})`; g.fillRect(0, i * 51.2 + 1, 256, 49.5); }
    for (let i = 0; i < 420; i++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '40,28,16' : '170,140,100'},${0.05 + rnd() * 0.1})`; g.fillRect(rnd() * 256, rnd() * 256, 20 + rnd() * 90, 1); }
    g.fillStyle = 'rgba(232,226,210,0.5)'; g.fillRect(104, 92, 48, 14); g.fillRect(121, 75, 14, 48);          // stencilled mark
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const mk = (opts, key) => enhance(new THREE.MeshStandardMaterial(opts), { key });
    this.mat = {
      wood: mk({ map: tex, roughness: 0.86, metalness: 0 }, 'crate-wood'),
      steel: mk({ color: 0x2c2e30, roughness: 0.55, metalness: 0.85 }, 'crate-steel'),
      tin: mk({ color: 0x4a5236, roughness: 0.6, metalness: 0.35 }, 'crate-tin'),
      cloth: mk({ color: 0xd9d4c6, roughness: 0.95, metalness: 0 }, 'crate-cloth'),
    };
    const boxes = (list) => mergeGeometries(list.map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z)));
    const [W, H, D] = CRATE.size, t = 0.03;
    this.geo = {
      body: boxes([[W, t, D, 0, t / 2, 0], [W, H - t, t, 0, H / 2, D / 2 - t / 2], [W, H - t, t, 0, H / 2, -D / 2 + t / 2], [t, H - t, D - 2 * t, W / 2 - t / 2, H / 2, 0], [t, H - t, D - 2 * t, -W / 2 + t / 2, H / 2, 0]]),
      bands: boxes([[0.05, H - 0.02, 0.006, 0.3, H / 2, D / 2 + 0.003], [0.05, H - 0.02, 0.006, -0.3, H / 2, D / 2 + 0.003], [0.05, H - 0.02, 0.006, 0.3, H / 2, -D / 2 - 0.003], [0.05, H - 0.02, 0.006, -0.3, H / 2, -D / 2 - 0.003]]),
      lid: boxes([[W + 0.02, t, D + 0.02, 0, t / 2, D / 2]]),
      lidBands: boxes([[0.05, 0.006, D + 0.02, 0.3, t + 0.003, D / 2], [0.05, 0.006, D + 0.02, -0.3, t + 0.003, D / 2]]),
      tins: boxes([[0.3, 0.16, 0.2, 0.22, t + 0.08, -0.02], [0.3, 0.16, 0.2, -0.2, t + 0.08, 0.04]]),
      rolls: boxes([[0.14, 0.06, 0.1, 0, t + 0.03, 0.16]]),
      roll: new THREE.CylinderGeometry(0.036, 0.036, 0.075, 12).rotateZ(Math.PI / 2),
    };
  }

  // a crate standing on the ground at (x, z)
  place(x, z, yaw, loot) {
    const T = this.terrain, y = T.heightAt(x, z);
    const group = new THREE.Group(), lid = new THREE.Group();
    const add = (geo, mat, parent = group) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
    add(this.geo.body, this.mat.wood); add(this.geo.bands, this.mat.steel);
    const cargo = [add(this.geo.tins, this.mat.tin), add(this.geo.rolls, this.mat.cloth)];
    add(this.geo.lid, this.mat.wood, lid); add(this.geo.lidBands, this.mat.steel, lid);
    lid.position.set(0, CRATE.size[1], -CRATE.size[2] / 2);
    group.add(lid);
    // it sits flat on the slope, a finger deep in the turf
    group.position.set(x, y - 0.012, z);
    group.quaternion.setFromUnitVectors(UP, T.normalAt(x, z, _n)).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
    this.engine.scene.add(group);
    const crate = { group, lid, cargo, pos: new THREE.Vector3(x, y, z), yaw, opened: false, openT: 0, loot, cell: -1, walk: 1 };
    crate.box = this.col.addBox({ x, y: y - 0.02, z, hx: CRATE.size[0] / 2, hz: CRATE.size[2] / 2, h: CRATE.size[1] + 0.03, yaw, surface: 'wood' });
    // the infected walk round it
    const f = this.zombies.flow;
    if (f) { crate.cell = f.cellOf(x, z); if (crate.cell >= 0) { crate.walk = f.walk[crate.cell]; f.walk[crate.cell] = 0; } }
    this.crates.push(crate);
    return crate;
  }

  remove(crate) {
    const i = this.crates.indexOf(crate);
    if (i < 0) return;
    this.crates.splice(i, 1);
    this.engine.scene.remove(crate.group);
    this.col.removeBox(crate.box);
    if (crate.cell >= 0 && this.zombies.flow) this.zombies.flow.walk[crate.cell] = crate.walk;
  }

  open(crate) { crate.opened = true; for (const m of crate.cargo) m.visible = false; }

  // a bandage roll lying where something fell
  drop(x, y, z) {
    if (this.pickups.length >= 6) this._take(this.pickups[0]);
    const mesh = this.free.pop() || new THREE.Mesh(this.geo.roll, this.mat.cloth);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const fy = this.col.floorAt(x, y + 0.5, z, 2);
    mesh.position.set(x, fy + 0.036, z);
    mesh.rotation.set(0, Math.random() * 6.283, 0);
    this.engine.scene.add(mesh);
    const pk = { mesh, pos: mesh.position, kind: 'bandage', t: 0 };
    this.pickups.push(pk);
    return pk;
  }

  _take(pk) {
    const i = this.pickups.indexOf(pk);
    if (i >= 0) this.pickups.splice(i, 1);
    this.engine.scene.remove(pk.mesh);
    this.free.push(pk.mesh);
  }

  update(dt, player, onPick) {
    for (const c of this.crates) if (c.opened && c.openT < 1) { c.openT = Math.min(1, c.openT + dt / 0.5); const k = c.openT; c.lid.rotation.x = -1.9 * k * k * (3 - 2 * k); }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      pk.t += dt;
      if (pk.t > 45) { this._take(pk); continue; }
      if (player.alive && player.bandages < player.bandageMax && Math.hypot(pk.pos.x - player.pos.x, pk.pos.z - player.pos.z) < 1.1 && Math.abs(pk.pos.y - player.pos.y) < 1.6) { this._take(pk); onPick(pk); }
    }
  }

  clear() {
    while (this.crates.length) this.remove(this.crates[0]);
    while (this.pickups.length) this._take(this.pickups[0]);
  }
}

// ---------------------------------------------------------------- game
export class Game {
  constructor({ engine, terrain, layout, world, settings }) {
    this.engine = engine; this.terrain = terrain; this.layout = layout; this.world = world; this.settings = settings;
    this.state = 'menu';       // menu | playing | paused | over | film
    this.mode = 'survival';
    this.ui = null;
    this.wave = 0; this.waveKind = ''; this.queue = 0; this.queueList = []; this.spawnT = 0; this.interT = 0; this.time = 0; this.playTime = 0;
    this.stats = { kills: 0, headshots: 0, shots: 0, hits: 0 };
    this.menuT = 0; this.overT = 0; this.strayT = 0; this.cleared = false; this.crowT = 8;
    this.interact = null;      // what F would do right now: { kind, key, text }
    this.lastSpawn = null; this.packN = 0;
    this.onOver = null;        // called once when the summary screen comes up
    this._on = {};
    this._boss = { name: '', health: 0, maxHealth: 1, frac: 0, state: '', pos: null };
  }

  // events for the HUD and the other modes: wave, waveCleared, kill, hurt, death, crate, crateOpened, pickup, bossSpawn, bossDown
  on(name, fn) { (this._on[name] || (this._on[name] = [])).push(fn); return this; }
  emit(name, ...args) { const l = this._on[name]; if (l) for (const fn of l) fn(...args); }

  async init(onProgress = () => {}) {
    const { engine, terrain, layout, world } = this;
    this.collision = new Collision(terrain, layout);
    this.collision.build(world.colliders);
    onProgress(0.2);
    this.audio = new AudioSystem();
    await this.audio.load();
    this.player = new Player(engine, this.collision, layout, this.settings);
    this.fx = new FX(engine, this.collision);
    this.weapon = new Weapon(engine, this.player, this.fx, this.audio);
    this.zombies = new Zombies(engine, this.collision, layout, this.fx, this.audio, this.player);
    await Promise.all([this.weapon.load(), this.zombies.load()]);
    onProgress(0.7);
    this.zombies.buildNav();
    this.supply = new Supply(engine, this.collision, terrain, this.zombies);
    onProgress(1);
    this.weapon.visible = false;

    this.weapon.onShoot = (origin, dir, def, st) => this.shoot(origin, dir, def, st);
    this.player.onStep = (surface, sprint, stance) => {
      const s = { grass: 'step_grass', dirt: 'step_grass', gravel: 'step_gravel', stone: 'step_stone', wood: 'step_wood', water: 'step_water' }[surface] || 'step_grass';
      this.audio.play(s, { volume: stance === 'prone' ? 0.2 : stance === 'crouch' ? 0.24 : sprint ? 0.55 : 0.38, pitchVar: 0.08, rate: stance === 'prone' ? 0.8 : 1 });
      if (surface === 'gravel' || surface === 'dirt') this.fx.footDust(this.player.pos.x, this.player.pos.y, this.player.pos.z);
    };
    this.player.onLand = (v) => this.audio.play('step_grass', { volume: Math.min(1, v / 8), rate: 0.8 });
    this.player.onRoll = () => { this.audio.play('step_grass', { volume: 0.6, rate: 0.7 }); this.fx.footDust(this.player.pos.x, this.player.pos.y, this.player.pos.z); };
    this.player.onBandage = (phase) => { if (phase === 'start') this.audio.playFirst('bandage', null, { volume: 0.7 }); };
    this.player.onHurt = (amount, dir, kind) => { this.audio.play('player_hurt', { volume: kind === 'fall' ? 0.7 : 0.9 }); this.ui?.hurt(amount, dir); this.emit('hurt', amount, kind); };
    this.player.onDeath = () => { this.audio.play('player_death', { volume: 1 }); this.overT = 0; this.emit('death'); };
    this.zombies.onKill = (z, part) => {
      this.stats.kills++;
      if (part === 'head') this.stats.headshots++;
      // now and then one of them was carrying a bandage
      if (this.state === 'playing' && Math.random() < z.def.drop) { this.supply.drop(z.pos.x, z.pos.y, z.pos.z); if (z.def.boss) this.supply.drop(z.pos.x + 0.6, z.pos.y, z.pos.z + 0.4); }
      if (z.def.boss) { this.ui?.toast(`${z.def.name} down`, 'The valley is quiet for a moment'); this.emit('bossDown', z); }
      this.emit('kill', z, part, this.weapon.id);
    };
    this.zombies.onStuck = (z) => this._relocate(z);
    this.fx.onCasingLand = (p) => this.audio.playAt('shell_drop', p, { volume: 0.35, pitchVar: 0.15, ref: 1.5, height: 0 });
  }

  // the boss in play, for the health bar (null when there is none)
  get boss() {
    const z = this.zombies ? this.zombies.boss : null;
    if (!z || !z.alive) return null;
    const b = this._boss;
    b.name = z.def.name; b.health = Math.max(0, z.health); b.maxHealth = z.maxHealth; b.frac = clamp(z.health / z.maxHealth, 0, 1); b.state = z.state; b.pos = z.pos;
    return b;
  }

  // One bullet: bodies first (the sniper's goes on through up to three), then the world behind them.
  // Returns the nearest thing hit: { point, distance, surface, end } (+ zombie, part for a body).
  shoot(origin, dir, def = this.weapon.def, st = this.weapon.st) {
    this.stats.shots++;
    const mod = st ? st.mod : null, k = def.calibre;
    const bodies = def.bodies + (mod ? mod.bodies : 0);
    let hits, wh;
    if (bodies > 1) {
      wh = this.collision.raycast(origin, dir, 700, this._hit || (this._hit = {}));
      hits = this.zombies.raycastAll(origin, dir, wh ? wh.distance : 500, bodies);
    } else {
      const zh = this.zombies.raycast(origin, dir, 500);
      wh = this.collision.raycast(origin, dir, zh ? zh.distance : 700, this._hit || (this._hit = {}));
      hits = zh && (!wh || zh.distance <= wh.distance) ? [zh] : [];
    }
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i], z = h.zombie;
      const fall = def.falloff ? lerp(1, def.falloff[2], clamp((h.distance - def.falloff[0]) / (def.falloff[1] - def.falloff[0]), 0, 1)) : 1;
      const dmg = def.damage * (mod ? mod.damage : 1) * (h.part === 'head' ? def.head : h.mult) * fall * Math.pow(0.8, i);
      const was = z.alive;
      h.dealt = this.zombies.damage(z, dmg, h.part, dir);
      h.killed = was && !z.alive; h.surface = 'flesh';
      this.fx.blood(h.point, dir, k);
      this._bloodBehind(h.point, dir, k);
      this.audio.playAt('impact_flesh', h.point, { volume: 0.8, pitchVar: 0.1, ref: 6 });
      this.ui?.hitMarker(h.killed, h.part === 'head');
    }
    if (hits.length) this.stats.hits++;
    const stopped = hits.length >= bodies || (hits.length && bodies === 1);
    if (wh && !stopped) {
      this.fx.impact(wh.point, wh.normal, wh.surface, dir, k);
      const name = { stone: 'impact_stone', wood: 'impact_wood', metal: 'impact_metal', water: 'impact_water' }[wh.surface] || 'impact_dirt';
      this.audio.playAt(name, wh.point, { volume: 0.7 * Math.sqrt(k), pitchVar: 0.12, ref: 5 });
    }
    const first = hits.length ? hits[0] : wh;
    if (first) { first.end = stopped ? hits[hits.length - 1].point : (wh ? wh.point : null); first.hits = hits; }
    return first;
  }

  // what the bullet carries out of the body: spatter on the wall or ground behind it, drops underneath
  _bloodBehind(point, dir, k) {
    const sk = Math.sqrt(k), col = this.collision;
    _v.copy(point).addScaledVector(dir, 0.2);
    const h = col.raycast(_v, dir, 4.5 * sk, this._bh || (this._bh = {}));
    if (h && h.surface !== 'water') this.fx.bloodSplat(h.point, h.normal, (0.45 + Math.random() * 0.35) * sk * (1 - 0.1 * h.distance));
    if (!h || Math.random() < 0.5) {
      const g = col.raycast(point, DOWN, 3, this._bh);
      if (g && g.surface !== 'water') this.fx.bloodSplat(g.point, g.normal, (0.22 + Math.random() * 0.22) * sk);
    }
  }

  // ------------------------------------------------------------ flow
  _startPoint() {
    const ch = this.layout.church, f = this.zombies.flow;
    let s = START[0];
    for (const c of START) {
      const y = this.terrain.heightAt(c[0], c[1]);
      if ((!f || f.walkable(c[0], c[1])) && this.collision.resolveCapsule(_v.set(c[0], y + 0.05, c[1]), 0.6, 1.8).lengthSq() < 1e-8) { s = c; break; }
    }
    const tx = ch ? ch.towerX : 56, tz = ch ? ch.towerZ : -100;
    return [s[0], s[1], Math.atan2(-(tx - s[0]), -(tz - s[1]))];
  }

  start() {
    const p = this.player;
    this.audio.resume();
    this.audio.setMuffle(0);
    this.audio.preload(['rifle_shot', 'dry_fire', 'mag_out', 'mag_in', 'bolt_rack', 'impact_flesh', 'impact_dirt', 'impact_stone', 'step_grass', 'step_gravel', 'zombie_idle', 'zombie_alert', 'zombie_attack', 'zombie_death', 'zombie_hurt', 'bell_toll', 'shell_drop', 'player_hurt']);
    this.zombies.clear();
    this.zombies.passive = false;
    this.supply.clear();
    const s = this._startPoint();
    p.spawn(s[0], s[1], s[2]);
    p.bandages = 1;
    p.enabled = true;
    this.weapon.reset();
    this.weapon.visible = true;
    this.wave = 0; this.waveKind = ''; this.queue = 0; this.queueList = []; this.interT = 3.5; this.playTime = 0; this.overT = 0; this.cleared = false; this.interact = null; this.lastSpawn = null;
    this.stats = { kills: 0, headshots: 0, shots: 0, hits: 0 };
    this.state = 'playing';
    this.audio.stopLoop('music_menu', 2); this.audio.stopLoop('music_over', 1);
    this.audio.loop('amb_wind', 0.6); this.audio.loop('amb_river', 0.0); this.audio.loop('music_combat', 0.0, 3);
    // a few wanderers so the village is never empty (well away from the player); the first bell wakes them
    for (let i = 0, n = 0; i < 30 && n < 5; i++) {
      const a = Math.random() * 6.28, r = 12 + Math.random() * 40;
      const x = 46 + Math.cos(a) * r, z = -84 + Math.sin(a) * r;
      if (Math.hypot(x - p.pos.x, z - p.pos.z) > 34 && this.zombies.flow.walkable(x, z)) { this.zombies.spawn(x, z, { type: 'walker' }); n++; }
    }
    this.ui?.setState('playing');
  }

  toMenu() {
    this.state = 'menu';
    this.player.enabled = false; this.weapon.visible = false;
    this.zombies.clear();
    this.supply.clear();
    this.audio.setMuffle(0);
    // a handful of infected drift across the meadow behind the menu
    this.zombies.passive = true;
    for (let i = 0; i < 4; i++) {
      const x = -52 + (Math.random() - 0.5) * 34 + i * 4, z = 82 + (Math.random() - 0.5) * 22 - i * 5;
      if (this.zombies.flow.walkable(x, z)) this.zombies.spawn(x, z, { type: 'walker' });
    }
    for (const n of ['amb_river', 'music_combat', 'music_over']) this.audio.stopLoop(n, 1.5);
    this.audio.loop('amb_wind', 0.5); this.audio.loop('music_menu', 0.8, 3);
    this.ui?.setState('menu');
  }

  pause() { if (this.state === 'playing') { this.state = 'paused'; this.ui?.setState('paused'); } }
  resume() { if (this.state === 'paused') { this.state = 'playing'; this.ui?.setState('playing'); } }

  // Who comes in wave n, in spawn order. Every fifth wave brings the boss; in between
  // a runner pack (n = 3, 8, ...) and a brute escort (n = 4, 9, ...) break up the mixed waves.
  _compose(n) {
    const list = [];
    const push = (type, count) => { for (let i = 0; i < Math.round(count); i++) list.push(type); };
    const shuffle = (from) => { for (let i = list.length - 1; i > from; i--) { const j = from + Math.floor(Math.random() * (i - from + 1)); const t = list[i]; list[i] = list[j]; list[j] = t; } };
    let kind = 'mixed', text = '';
    if (n % 5 === 0) {
      kind = 'boss'; text = 'Something far bigger is coming with them';
      push('boss', 1 + Math.floor(n / 15)); push('brute', Math.floor(n / 5)); push('runner', 3 + n * 0.5); push('walker', 4 + n);
      shuffle(1 + Math.floor(n / 15));
    } else if (n % 5 === 3) {
      kind = 'pack'; text = 'A pack of runners, and they are fast';
      push('runner', 6 + n * 2); push('walker', n);
    } else if (n % 5 === 4) {
      kind = 'escort'; text = 'Brutes among them: body shots barely slow them';
      push('brute', 1 + Math.floor(n / 4)); push('walker', 6 + n * 2); push('runner', n);
      shuffle(0);
    } else {
      const total = 6 + n * 3, runners = n >= 2 ? Math.round(total * Math.min(0.4, 0.1 + n * 0.05)) : 0, brutes = n >= 6 ? Math.floor((n - 4) / 2) : 0;
      push('walker', total - runners - brutes); push('runner', runners); push('brute', brutes);
      shuffle(0);
    }
    return { kind, text: text || `${list.length} infected approaching`, list };
  }

  _nextWave() {
    this.wave++;
    const c = this._compose(this.wave);
    this.waveKind = c.kind;
    this.queueList = c.list.reverse();      // taken from the end
    this.queue = this.queueList.length;
    this.spawnT = 1.5;
    this.cleared = false; this.packN = 0; this.lastSpawn = null;
    for (const z of this.zombies.list) if (z.alive) z.aware = true;
    this.audio.play('bell_toll', { volume: 0.9 });
    this.ui?.toast(`Wave ${this.wave}`, c.text);
    this.emit('wave', this.wave, c.kind, this.queue);
  }

  // can the player currently see a point? (inside the view cone and not hidden by terrain or walls)
  _visible(x, y, z) {
    const p = this.player;
    _v.set(x, y, z).sub(p.eye);
    const d = _v.length();
    if (d < 1) return true;
    _v.multiplyScalar(1 / d);
    if (_v.dot(p.forward(_f)) < 0.4) return false;
    return !this.collision.raycast(p.eye, _v, d - 0.6, this._vis || (this._vis = {}));
  }

  // a walkable, reachable point the player is not looking at (the slow kinds start closer in)
  _spawnPoint(close = false) {
    const p = this.player, f = this.zombies.flow;
    const c = this.layout.playCenter || [20, -20];
    const inField = f.cellOf(p.pos.x, p.pos.z) >= 0;
    let fallback = null, fd = 0;
    for (let tries = 0; tries < 48; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = close ? 24 + Math.random() * 30 : 32 + Math.random() * 44;
      let x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
      // pull spawn points towards the village so they pour out of the ruins
      if (Math.random() < 0.5) { x = THREE.MathUtils.lerp(x, 50, 0.3); z = THREE.MathUtils.lerp(z, -88, 0.3); }
      if (Math.hypot(x - c[0], z - c[1]) > (this.layout.playRadius || 330) - 20) continue;
      const d = Math.hypot(x - p.pos.x, z - p.pos.z);
      if (d < (close ? 22 : 30)) continue;
      if (!f.walkable(x, z) || (inField && !f.reachable(x, z))) continue;
      const y = this.terrain.heightAt(x, z);
      if (!this._visible(x, y + 1.6, z) && !this._visible(x, y + 0.5, z)) return [x, z];
      if (d > fd) { fd = d; fallback = [x, z]; }
    }
    return fd > 72 ? fallback : null;
  }

  // the next of a pack comes out where the last one did
  _packPoint() {
    const l = this.lastSpawn, f = this.zombies.flow;
    if (!l || l.type !== 'runner' || this.playTime - l.t > 2.5 || this.packN >= 4) return null;
    const x = l.x + (Math.random() - 0.5) * 3, z = l.z + (Math.random() - 0.5) * 3;
    if (!f.walkable(x, z) || !f.reachable(x, z)) return null;
    const y = this.terrain.heightAt(x, z);
    return this._visible(x, y + 1.6, z) || this._visible(x, y + 0.5, z) ? null : [x, z];
  }

  // move a stuck or stray zombie to a fresh spawn point, but never while it is in view
  _relocate(z) {
    if (this._visible(z.pos.x, z.pos.y + 1.2, z.pos.z)) return false;
    const s = this._spawnPoint();
    if (!s) return false;
    this.zombies.place(z, s[0], s[1]);
    z.aware = true;
    return true;
  }

  // open, level, dry ground a short walk from the player, out of sight if possible
  _cratePoint() {
    const p = this.player, f = this.zombies.flow, T = this.terrain, col = this.collision;
    let best = null, bs = -1e9;
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * 6.283, r = 9 + Math.random() * 15;
      const x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
      const c = f.cellOf(x, z);
      if (c < 0 || f.walk[c] !== 1 || !f.reachable(x, z)) continue;
      let open = true;
      for (let k = 0; k < 8 && open; k++) open = f.walkable(x + Math.round(Math.cos(k * 0.7854)) * f.cell, z + Math.round(Math.sin(k * 0.7854)) * f.cell);
      if (!open || T.normalAt(x, z, _n).y < 0.985 || col.waterDepth(x, z) > 0) continue;
      const y = T.heightAt(x, z);
      if (col.floorAt(x, y + 6, z, 7) > y + 0.05) continue;                                   // under a roof or on a floor
      if (col.resolveCapsule(_v.set(x, y + 0.05, z), 0.8, 1.7).lengthSq() > 1e-8) continue;   // too close to a wall or prop
      if (this.supply.crates.some((o) => Math.hypot(o.pos.x - x, o.pos.z - z) < 4)) continue;
      const score = (this._visible(x, y + 0.4, z) ? 0 : 10) - Math.abs(r - 14) * 0.2;
      if (score > bs) { bs = score; best = [x, z]; }
    }
    return best;
  }

  _dropCrate() {
    // crates already emptied are cleared away once nobody is looking (never more than three stand around)
    for (const c of [...this.supply.crates]) if (c.opened && (this.supply.crates.length >= 3 || !this._visible(c.pos.x, c.pos.y + 0.3, c.pos.z))) this.supply.remove(c);
    const s = this._cratePoint();
    if (!s) return null;
    const crate = this.supply.place(s[0], s[1], Math.random() * 6.283, { rifle: CRATE.rifle, sniper: CRATE.sniper, bandages: CRATE.bandages });
    this.emit('crate', crate);
    return crate;
  }

  _openCrate(crate) {
    const p = this.player, w = this.weapon, l = crate.loot;
    this.supply.open(crate);
    const got = { rifle: w.give('rifle', l.rifle), sniper: w.give('sniper', l.sniper), bandages: Math.max(0, Math.min(l.bandages, p.bandageMax - p.bandages)) };
    p.bandages += got.bandages;
    this.audio.playFirst('crate_open', 'mag_in', { volume: 0.8 }, { rate: 0.75 });
    const parts = [];
    if (got.rifle) parts.push(`${got.rifle} rifle rounds`);
    if (got.sniper) parts.push(`${got.sniper} sniper rounds`);
    if (got.bandages) parts.push(got.bandages === 1 ? '1 bandage' : `${got.bandages} bandages`);
    this.ui?.toast('Supplies', parts.length ? parts.join(' · ') : 'Nothing more you can carry');
    this.emit('crateOpened', crate, got);
    return got;
  }

  update(dt) {
    this.time += dt;
    const { player: p, zombies, weapon } = this;
    if (this.state === 'playing' || this.state === 'film') {
      if (this.state === 'playing') {
        this.playTime += dt;
        // wave director
        const alive = zombies.aliveCount;
        if (this.queue > 0) {
          this.spawnT -= dt;
          if (this.spawnT <= 0) {
            const cap = Math.min(zombies.maxActive - 2, 7 + this.wave * 2);
            const type = this.queueList.length ? this.queueList[this.queueList.length - 1] : 'walker';
            const pack = type === 'runner' ? this._packPoint() : null;
            const s = alive < cap ? pack || this._spawnPoint(type === 'walker' || type === 'brute') : null;
            const z = s ? zombies.spawn(s[0], s[1], { aware: true, type }) : null;
            if (z) {
              this.queueList.pop(); this.queue--;
              this.packN = pack ? this.packN + 1 : 1;
              this.lastSpawn = { x: s[0], z: s[1], type, t: this.playTime };
              const pace = Math.max(0.35, 1.5 - this.wave * 0.12) * (0.6 + Math.random() * 0.8);
              this.spawnT = type === 'runner' ? (this.packN >= 4 ? 2.5 + pace : 0.3) : pace;
              if (z.def.boss) { this.ui?.toast(z.def.name, 'It charges in a straight line and pounds the ground: keep moving'); this.emit('bossSpawn', z); }
            } else this.spawnT = 0.3;
          }
        } else if (alive === 0 || this.wave === 0) {
          if (this.wave > 0 && !this.cleared) {
            this.cleared = true;
            const crate = this._dropCrate();
            this.interT = crate ? 14 : 7;
            this.ui?.toast('Wave cleared', crate ? 'A supply crate is close by' : 'The next wave is gathering');
            this.emit('waveCleared', this.wave, crate);
          }
          this.interT -= dt;
          if (this.interT <= 0) { this._nextWave(); this.interT = 7; }
        } else {
          // the last of a wave must not hide at the far end of the valley
          this.strayT -= dt;
          if (this.strayT <= 0) {
            this.strayT = 2;
            for (const z of zombies.list) {
              if (!z.alive) continue;
              z.aware = true;
              if (Math.hypot(z.pos.x - p.pos.x, z.pos.z - p.pos.z) > 95) this._relocate(z);
            }
          }
        }
        // river loudness by proximity, combat music by threat, the world goes dull when badly hurt
        const rd = this.layout.river.query(p.pos.x, p.pos.z, this._q || (this._q = {})).d;
        this.audio.setLoopVolume('amb_river', THREE.MathUtils.clamp(1 - rd / 70, 0, 1) * 0.9, 0.6);
        let threat = 0;
        for (const z of zombies.list) if (z.alive && z.aware) threat += (z.pos.distanceToSquared(p.pos) < 45 * 45 ? 1 : 0.3) * (z.def.boss ? 4 : 1);
        this.audio.setLoopVolume('music_combat', THREE.MathUtils.clamp(threat / 5, 0, 1) * 0.8, 1.5);
        this.audio.setMuffle(p.alive ? clamp((35 - p.health) / 35, 0, 1) * 0.8 : 1);
        if (!p.alive) {
          this.overT += dt;
          if (this.overT > 2.6) {
            this.state = 'over'; weapon.visible = false;
            this.audio.stopLoop('music_combat', 1.5);
            const mo = this.audio.sounds.music_over;
            if (mo) { if (mo.loop) this.audio.loop('music_over', 0.7, 2); else this.audio.play('music_over', { volume: 0.8 }); }
            this.ui?.setState('over', this.summary());
            if (this.onOver) this.onOver();
          }
        }
      }
      p.update(dt);
      weapon.update(dt);
      zombies.update(dt);
      this.fx.update(dt);
      this.supply.update(dt, p, (pk) => { p.bandages++; this.ui?.toast('Bandage', `${p.bandages} of ${p.bandageMax} carried`); this.emit('pickup', pk); });
      // what F would do: the nearest unopened crate in reach and roughly ahead
      this.interact = null;
      if (this.state === 'playing' && p.alive) {
        p.forward(_f);
        for (const c of this.supply.crates) {
          if (c.opened) continue;
          const dx = c.pos.x - p.pos.x, dz = c.pos.z - p.pos.z, d = Math.hypot(dx, dz);
          if (d < CRATE.reach && Math.abs(c.pos.y - p.pos.y) < 1.5 && (d < 0.6 || (dx * _f.x + dz * _f.z) / d > 0.2)) { this.interact = { kind: 'crate', key: 'F', text: 'Open the supply crate', crate: c }; break; }
        }
        if (this.interact && p.input.interact) { this._openCrate(this.interact.crate); this.interact = null; }
      }
    } else if (this.state === 'menu') {
      // slow drift across the meadow towards the village
      this.menuT += dt;
      const t = this.menuT;
      const cam = this.engine.camera;
      const x = -74 + Math.sin(t * 0.021) * 22, z = 124 + Math.cos(t * 0.017) * 9;
      cam.position.set(x, this.terrain.heightAt(x, z) + 2.1 + Math.sin(t * 0.05) * 0.25, z);
      cam.lookAt(34 + Math.sin(t * 0.013) * 10, 17, -92);
      if (cam.fov !== 58) { cam.fov = 58; cam.updateProjectionMatrix(); }
      zombies.update(dt);
      this.fx.update(dt);
    } else if (this.state === 'over') {
      zombies.update(dt); this.fx.update(dt); p.update(dt);
    }
    // crows somewhere up the valley, now and then
    this.crowT -= dt;
    if (this.crowT <= 0) {
      this.crowT = 16 + Math.random() * 30;
      const cr = this.audio.sounds.amb_crows;
      if (cr && !cr.loop && this.state !== 'paused') this.audio.play('amb_crows', { volume: 0.3, pitchVar: 0.05 });
      else if (cr && cr.loop) this.audio.loop('amb_crows', 0.3);
    }
    this.audio.updateListener(this.engine.camera);
    this.ui?.update(this, dt);
  }

  summary() {
    const s = this.stats;
    return { wave: this.wave, kills: s.kills, headshots: s.headshots, accuracy: s.shots ? Math.round((100 * s.hits) / s.shots) : 0, time: this.playTime };
  }
}

export { INFECTED };
