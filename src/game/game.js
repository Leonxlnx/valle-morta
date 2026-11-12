// Game: ties player, weapon, zombies, effects, audio and UI together and runs
// the wave director.
import * as THREE from 'three';
import { Collision } from './collision.js';
import { Player } from './player.js';
import { FX } from './fx.js';
import { Weapon } from './weapon.js';
import { Zombies } from './zombies.js';
import { AudioSystem } from './audio.js';

const _v = new THREE.Vector3(), _f = new THREE.Vector3();
const SPAWN = [-58, 96, -0.55];   // southern meadow, looking across the river at the village

export class Game {
  constructor({ engine, terrain, layout, world, settings }) {
    this.engine = engine; this.terrain = terrain; this.layout = layout; this.world = world; this.settings = settings;
    this.state = 'menu';       // menu | playing | paused | over | film
    this.ui = null;
    this.wave = 0; this.queue = 0; this.spawnT = 0; this.interT = 0; this.time = 0; this.playTime = 0;
    this.stats = { kills: 0, headshots: 0, shots: 0, hits: 0 };
    this.menuT = 0; this.overT = 0; this.strayT = 0; this.cleared = false; this.crowT = 8;
    this.onOver = null;        // called once when the summary screen comes up
  }

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
    onProgress(1);
    this.weapon.visible = false;

    this.weapon.onShoot = (origin, dir) => this.shoot(origin, dir);
    this.player.onStep = (surface, sprint) => {
      const s = { grass: 'step_grass', dirt: 'step_grass', gravel: 'step_gravel', stone: 'step_stone', wood: 'step_wood', water: 'step_water' }[surface] || 'step_grass';
      this.audio.play(s, { volume: sprint ? 0.55 : 0.38, pitchVar: 0.08 });
      if (surface === 'gravel' || surface === 'dirt') this.fx.footDust(this.player.pos.x, this.player.pos.y, this.player.pos.z);
    };
    this.player.onLand = (v) => this.audio.play('step_grass', { volume: Math.min(1, v / 8), rate: 0.8 });
    this.player.onHurt = () => this.ui?.hurt();
    this.player.onDeath = () => { this.audio.play('player_death', { volume: 1 }); this.overT = 0; };
    this.zombies.onKill = (z, part) => { this.stats.kills++; if (part === 'head') this.stats.headshots++; };
    this.zombies.onStuck = (z) => this._relocate(z);
    this.fx.onCasingLand = (p) => this.audio.playAt('shell_drop', p, { volume: 0.35, pitchVar: 0.15, ref: 1.5, height: 0 });
  }

  shoot(origin, dir) {
    this.stats.shots++;
    const zh = this.zombies.raycast(origin, dir, 500);
    const wh = this.collision.raycast(origin, dir, zh ? zh.distance : 700, this._hit || (this._hit = {}));
    if (zh && (!wh || zh.distance <= wh.distance)) {
      this.stats.hits++;
      const dmg = 36 * zh.mult * (zh.distance > 120 ? 0.8 : 1);
      const before = zh.zombie.alive;
      this.zombies.damage(zh.zombie, dmg, zh.part, dir);
      this.fx.blood(zh.point, dir);
      this.audio.playAt('impact_flesh', zh.point, { volume: 0.8, pitchVar: 0.1, ref: 6 });
      this.ui?.hitMarker(before && !zh.zombie.alive, zh.part === 'head');
      zh.surface = 'flesh';
      return zh;
    }
    if (wh) {
      this.fx.impact(wh.point, wh.normal, wh.surface, dir);
      const name = { stone: 'impact_stone', wood: 'impact_wood', metal: 'impact_metal', water: 'impact_water' }[wh.surface] || 'impact_dirt';
      this.audio.playAt(name, wh.point, { volume: 0.7, pitchVar: 0.12, ref: 5 });
    }
    return wh;
  }

  // ------------------------------------------------------------ flow
  start() {
    const p = this.player;
    this.audio.resume();
    this.audio.preload(['rifle_shot', 'dry_fire', 'mag_out', 'mag_in', 'bolt_rack', 'impact_flesh', 'impact_dirt', 'impact_stone', 'step_grass', 'step_gravel', 'zombie_idle', 'zombie_alert', 'zombie_attack', 'zombie_death', 'zombie_hurt', 'bell_toll', 'shell_drop']);
    this.zombies.clear();
    this.zombies.passive = false;
    p.spawn(SPAWN[0], SPAWN[1], SPAWN[2]);
    p.enabled = true;
    this.weapon.reset();
    this.weapon.visible = true;
    this.wave = 0; this.queue = 0; this.interT = 3.5; this.playTime = 0; this.overT = 0; this.cleared = false;
    this.stats = { kills: 0, headshots: 0, shots: 0, hits: 0 };
    this.state = 'playing';
    this.audio.stopLoop('music_menu', 2); this.audio.stopLoop('music_over', 1);
    this.audio.loop('amb_wind', 0.6); this.audio.loop('amb_river', 0.0); this.audio.loop('music_combat', 0.0, 3);
    // a few wanderers so the village is never empty; the first bell wakes them
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * 6.28, r = 12 + Math.random() * 40;
      const x = 46 + Math.cos(a) * r, z = -84 + Math.sin(a) * r;
      if (this.zombies.flow.walkable(x, z)) this.zombies.spawn(x, z, { runner: false });
    }
    this.ui?.setState('playing');
  }

  toMenu() {
    this.state = 'menu';
    this.player.enabled = false; this.weapon.visible = false;
    this.zombies.clear();
    // a handful of infected drift across the meadow behind the menu
    this.zombies.passive = true;
    for (let i = 0; i < 4; i++) {
      const x = -52 + (Math.random() - 0.5) * 34 + i * 4, z = 82 + (Math.random() - 0.5) * 22 - i * 5;
      if (this.zombies.flow.walkable(x, z)) this.zombies.spawn(x, z, { runner: false });
    }
    for (const n of ['amb_river', 'music_combat', 'music_over']) this.audio.stopLoop(n, 1.5);
    this.audio.loop('amb_wind', 0.5); this.audio.loop('music_menu', 0.8, 3);
    this.ui?.setState('menu');
  }

  pause() { if (this.state === 'playing') { this.state = 'paused'; this.ui?.setState('paused'); } }
  resume() { if (this.state === 'paused') { this.state = 'playing'; this.ui?.setState('playing'); } }

  _nextWave() {
    this.wave++;
    this.queue = 5 + this.wave * 4;
    this.spawnT = 1.5;
    this.cleared = false;
    this.weapon.reserve = Math.min(240, this.weapon.reserve + 60 + this.wave * 10);
    this.player.health = Math.min(100, this.player.health + 30);
    for (const z of this.zombies.list) if (z.alive) z.aware = true;
    this.audio.play('bell_toll', { volume: 0.9 });
    this.ui?.toast(`Wave ${this.wave}`, `${this.queue} infected approaching`);
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

  // a walkable, reachable point the player is not looking at
  _spawnPoint() {
    const p = this.player, f = this.zombies.flow;
    const c = this.layout.playCenter || [20, -20];
    const inField = f.cellOf(p.pos.x, p.pos.z) >= 0;
    let fallback = null, fd = 0;
    for (let tries = 0; tries < 48; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 32 + Math.random() * 44;
      let x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
      // pull spawn points towards the village so they pour out of the ruins
      if (Math.random() < 0.5) { x = THREE.MathUtils.lerp(x, 50, 0.3); z = THREE.MathUtils.lerp(z, -88, 0.3); }
      if (Math.hypot(x - c[0], z - c[1]) > (this.layout.playRadius || 330) - 20) continue;
      const d = Math.hypot(x - p.pos.x, z - p.pos.z);
      if (d < 30) continue;
      if (!f.walkable(x, z) || (inField && !f.reachable(x, z))) continue;
      const y = this.terrain.heightAt(x, z);
      if (!this._visible(x, y + 1.6, z) && !this._visible(x, y + 0.5, z)) return [x, z];
      if (d > fd) { fd = d; fallback = [x, z]; }
    }
    return fd > 72 ? fallback : null;
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
            const s = alive < cap ? this._spawnPoint() : null;
            if (s && zombies.spawn(s[0], s[1], { aware: true, runner: Math.random() < Math.min(0.6, 0.2 + this.wave * 0.08) })) {
              this.queue--;
              this.spawnT = Math.max(0.35, 1.5 - this.wave * 0.12) * (0.6 + Math.random() * 0.8);
            } else this.spawnT = 0.3;
          }
        } else if (alive === 0 || this.wave === 0) {
          if (this.wave > 0 && !this.cleared) { this.cleared = true; this.ui?.toast('Wave cleared', 'The next wave is gathering'); }
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
        // river loudness by proximity, combat music by threat
        const rd = this.layout.river.query(p.pos.x, p.pos.z, this._q || (this._q = {})).d;
        this.audio.setLoopVolume('amb_river', THREE.MathUtils.clamp(1 - rd / 70, 0, 1) * 0.9, 0.6);
        let threat = 0;
        for (const z of zombies.list) if (z.alive && z.aware) threat += z.pos.distanceToSquared(p.pos) < 45 * 45 ? 1 : 0.3;
        this.audio.setLoopVolume('music_combat', THREE.MathUtils.clamp(threat / 5, 0, 1) * 0.8, 1.5);
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
