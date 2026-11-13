// The infected: skinned glTF characters with a small behaviour state machine,
// flow-field navigation towards the player, per-bone hit volumes and
// animation-driven deaths.
//
// Asset contract (public/assets/models/zombie.glb): one skinned mesh, faces +Z,
// feet at y = 0, bones Hips Spine Chest Neck Head UpperArm.L/R LowerArm.L/R
// Hand.L/R UpperLeg.L/R LowerLeg.L/R Foot.L/R, clips Idle Walk Run Attack
// HitBody HitHead DeathBack DeathFront.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { enhance } from '../engine/materials.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _box = new THREE.Box3(), _id = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _qy = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const key = (s) => s.replace(/[._\s]/g, '');
const clamp = THREE.MathUtils.clamp;

// [name, boneA, boneB | null, radius, damage multiplier]
const HIT_PARTS = [
  ['head', 'Head', null, 0.13, 4.0],
  ['torso', 'Hips', 'Neck', 0.2, 1.0],
  ['armL', 'UpperArmL', 'LowerArmL', 0.075, 0.55], ['forearmL', 'LowerArmL', 'HandL', 0.065, 0.5],
  ['armR', 'UpperArmR', 'LowerArmR', 0.075, 0.55], ['forearmR', 'LowerArmR', 'HandR', 0.065, 0.5],
  ['thighL', 'UpperLegL', 'LowerLegL', 0.105, 0.7], ['shinL', 'LowerLegL', 'FootL', 0.085, 0.6],
  ['thighR', 'UpperLegR', 'LowerLegR', 0.105, 0.7], ['shinR', 'LowerLegR', 'FootR', 0.085, 0.6],
];
// the mesh switches to coarser versions with distance (metres at the default field of view)
const LOD_CELL = [0, 0.02, 0.045, 0.1];
const LOD_DIST = [3.2, 8, 20];

// ray (o, unit d) against a capsule (segment a-b, radius r); returns the ray distance or -1
function rayCapsule(o, d, a, b, r, maxT) {
  _c.subVectors(b, a);
  _d.subVectors(o, a);
  const dc = d.dot(_c), cc = _c.dot(_c), dw = d.dot(_d), cw = _c.dot(_d);
  const den = cc - dc * dc;
  const s = cc > 1e-8 ? clamp((cw - dc * dw) / (den > 1e-8 ? den : 1e-8), 0, 1) : 0;   // param on the segment
  const px = a.x + _c.x * s, py = a.y + _c.y * s, pz = a.z + _c.z * s;
  const t = (px - o.x) * d.x + (py - o.y) * d.y + (pz - o.z) * d.z;
  if (t < 0 || t > maxT + r) return -1;
  const qx = o.x + d.x * t - px, qy = o.y + d.y * t - py, qz = o.z + d.z * t - pz;
  const dist2 = qx * qx + qy * qy + qz * qz;
  if (dist2 > r * r) return -1;
  return Math.max(0, t - Math.sqrt(r * r - dist2));
}

// Vertex-clustering decimation that keeps the skinning attributes. Vertices
// merge only when they follow the same dominant bone (limbs never fuse) and lie
// on the same UV island (no triangle ever stretches across a texture seam); the
// copies left along a seam share one position and one normal, so nothing cracks.
function decimate(geo, cell) {
  const pos = geo.attributes.position, uv = geo.attributes.uv, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const n = pos.count, remap = new Uint32Array(n), keep = [], vcell = [], cells = new Map(), verts = new Map(), sum = [];
  for (let i = 0; i < n; i++) {
    let b = 0, w = -1;
    if (si && sw) for (let k = 0; k < 4; k++) { const wk = sw.getComponent(i, k); if (wk > w) { w = wk; b = si.getComponent(i, k); } }
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ck = `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)},${b}`;
    let c = cells.get(ck);
    if (c === undefined) { c = sum.length / 4; cells.set(ck, c); sum.push(0, 0, 0, 0); }
    sum[c * 4] += x; sum[c * 4 + 1] += y; sum[c * 4 + 2] += z; sum[c * 4 + 3]++;
    const vk = uv ? `${c},${Math.round(uv.getX(i) / cell)},${Math.round(uv.getY(i) / cell)}` : `${c}`;
    let r = verts.get(vk);
    if (r === undefined) { r = keep.length; verts.set(vk, r); keep.push(i); vcell.push(c); }
    remap[i] = r;
  }
  const m = keep.length;
  const out = new THREE.BufferGeometry();
  for (const name in geo.attributes) {
    const a = geo.attributes[name], sz = a.itemSize;
    const arr = name === 'skinIndex' ? new Uint16Array(m * sz) : new Float32Array(m * sz);
    for (let r = 0; r < m; r++) for (let c = 0; c < sz; c++) arr[r * sz + c] = a.getComponent(keep[r], c);
    out.setAttribute(name, new THREE.BufferAttribute(arr, sz));
  }
  const p = out.attributes.position;
  for (let r = 0; r < m; r++) { const c = vcell[r] * 4; p.setXYZ(r, sum[c] / sum[c + 3], sum[c + 1] / sum[c + 3], sum[c + 2] / sum[c + 3]); }
  const idx = geo.index, tris = (idx ? idx.count : n) / 3, outIdx = [], seen = new Set();
  for (let t = 0; t < tris; t++) {
    const a = remap[idx ? idx.getX(t * 3) : t * 3], b = remap[idx ? idx.getX(t * 3 + 1) : t * 3 + 1], c = remap[idx ? idx.getX(t * 3 + 2) : t * 3 + 2];
    if (vcell[a] === vcell[b] || vcell[b] === vcell[c] || vcell[a] === vcell[c]) continue;   // collapsed
    const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
    const k = (lo * m + mid) * m + hi;
    if (seen.has(k)) continue;
    seen.add(k);
    outIdx.push(a, b, c);
  }
  out.setIndex(outIdx);
  if (out.attributes.normal) {
    out.computeVertexNormals();
    const nrm = out.attributes.normal, acc = new Float32Array((sum.length / 4) * 3);
    for (let r = 0; r < m; r++) { const c = vcell[r] * 3; acc[c] += nrm.getX(r); acc[c + 1] += nrm.getY(r); acc[c + 2] += nrm.getZ(r); }
    for (let r = 0; r < m; r++) { const c = vcell[r] * 3, l = Math.hypot(acc[c], acc[c + 1], acc[c + 2]) || 1; nrm.setXYZ(r, acc[c] / l, acc[c + 1] / l, acc[c + 2] / l); }
  }
  return out;
}

// ---------------------------------------------------------------- navigation
const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];

export class FlowField {
  constructor(collision, layout, cx, cz, half = 190, cell = 1.5) {
    this.col = collision; this.cell = cell; this.n = Math.ceil((half * 2) / cell);
    this.x0 = cx - half; this.z0 = cz - half;
    const n = this.n;
    this.walk = new Uint8Array(n * n);     // 0 blocked, 1 walkable, 2 slow (water)
    this.dist = new Uint16Array(n * n);
    this.queue = new Int32Array(n * n);
    this.inq = new Uint8Array(n * n);
    const T = collision.terrain;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = this.x0 + (i + 0.5) * cell, z = this.z0 + (j + 0.5) * cell;
      const h = T.heightAt(x, z);
      const sl = Math.max(Math.abs(T.heightAt(x + 1, z) - T.heightAt(x - 1, z)), Math.abs(T.heightAt(x, z + 1) - T.heightAt(x, z - 1))) / 2;
      let w = sl > 0.95 ? 0 : 1;
      if (w && collision.bvh) {
        _box.min.set(x - cell * 0.45, h + 0.45, z - cell * 0.45); _box.max.set(x + cell * 0.45, h + 1.5, z + cell * 0.45);
        if (collision.bvh.intersectsBox(_box, _id)) w = 0;
      }
      if (w) { const wd = collision.waterDepth(x, z); if (wd > 1.5) w = 0; else if (wd > 0.25) w = 2; }
      this.walk[j * n + i] = w;
    }
    this.dist.fill(65535);
  }

  cellOf(x, z) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }

  // 8-connected distance field from the target (straight 2, diagonal 3, water +2)
  update(tx, tz) {
    const n = this.n, d = this.dist, q = this.queue, w = this.walk, inq = this.inq, cap = q.length;
    d.fill(65535);
    let start = this.cellOf(tx, tz);
    if (start < 0) return;
    if (!w[start]) {
      // nearest walkable cell around the target
      const si = start % n, sj = (start / n) | 0;
      let found = -1;
      for (let r = 1; r < 6 && found < 0; r++) for (let dj = -r; dj <= r && found < 0; dj++) for (let di = -r; di <= r; di++) {
        const i = si + di, j = sj + dj;
        if (i >= 0 && j >= 0 && i < n && j < n && w[j * n + i]) { found = j * n + i; break; }
      }
      if (found < 0) return;
      start = found;
    }
    let head = 0, tail = 0, count = 0;
    d[start] = 0; q[tail++] = start; count = 1; inq[start] = 1;
    while (count > 0) {
      const c = q[head++]; if (head === cap) head = 0;
      count--; inq[c] = 0;
      const cd = d[c];
      const ci = c % n, cj = (c / n) | 0;
      for (let k = 0; k < 8; k++) {
        const i = ci + DI[k], j = cj + DJ[k];
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const nb = j * n + i;
        if (!w[nb]) continue;
        if (k >= 4 && (!w[cj * n + i] || !w[j * n + ci])) continue;   // no corner cutting
        const nd = cd + (k < 4 ? 2 : 3) + (w[nb] === 2 ? 2 : 0);
        if (nd < d[nb]) {
          d[nb] = nd;
          if (!inq[nb]) { inq[nb] = 1; q[tail++] = nb; if (tail === cap) tail = 0; count++; }
        }
      }
    }
  }

  // steepest-descent direction at a position -> out (xz unit vector); false if unreachable
  dir(x, z, out) {
    const n = this.n;
    const c = this.cellOf(x, z);
    if (c < 0) return false;
    const ci = c % n, cj = (c / n) | 0;
    let best = this.dist[c], bx = 0, bz = 0;
    if (best === 0) return false;
    for (let k = 0; k < 8; k++) {
      const i = ci + DI[k], j = cj + DJ[k];
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      if (k >= 4 && (!this.walk[cj * n + i] || !this.walk[j * n + ci])) continue;
      const v = this.dist[j * n + i] + (k < 4 ? 0 : 0.9);
      if (v < best) { best = v; bx = DI[k]; bz = DJ[k]; }
    }
    if (!bx && !bz) return false;
    const l = Math.hypot(bx, bz);
    out.set(bx / l, 0, bz / l);
    return true;
  }

  walkable(x, z) { const c = this.cellOf(x, z); return c >= 0 && this.walk[c] > 0; }
  reachable(x, z) { const c = this.cellOf(x, z); return c >= 0 && this.dist[c] < 65535; }
}


// ---------------------------------------------------------------- infected types
// Everything that tells one kind from another lives here. `model` names the glTF
// (public/assets/models/<model>.glb); until that file exists the villager stands in,
// scaled to `tall` metres, widened by `bulk` and tinted. Extra clips are optional:
// `clips.run` falls back to Run, `clips.roar` and `clips.slam` to Attack.
// Convention for the boss clips: Roar lasts the charge wind-up (0.9 s), the fists of
// Slam strike the ground 0.8 s into the clip.
export const INFECTED = {
  walker: {
    name: 'Walker', model: 'zombie', tall: 0, bulk: 1, size: [0.95, 1.05], tint: null, gait: 'walk', voice: 1,
    speed: [0.9, 1.3], accel: 3, brake: 7, turn: 3.4, health: 100, bodyMult: 1, mass: 1, radius: 0.3,
    reach: 1.55, damage: [11, 17], knock: 0, attackRate: 1, flinch: 'any', slowOnHit: true,
    clips: { run: 'Run' }, corpse: 22, pool: 0.5, drop: 0.04,
  },
  runner: {
    name: 'Runner', model: 'runner', tall: 0, bulk: 0.9, size: [0.93, 1.0], tint: [1.0, 0.84, 0.78], gait: 'auto', voice: 1.15,
    speed: [4.5, 5.5], accel: 9, brake: 12, turn: 6, health: 60, bodyMult: 1, mass: 0.8, radius: 0.28,
    reach: 1.5, damage: [8, 12], knock: 0, attackRate: 1.25, flinch: 'any', slowOnHit: true, flank: true,
    clips: { run: 'Sprint' }, corpse: 18, pool: 0.42, drop: 0.04,
  },
  brute: {
    name: 'Brute', model: 'brute', tall: 2.1, bulk: 1.28, size: [0.98, 1.02], tint: [0.6, 0.58, 0.56], gait: 'auto', voice: 0.75,
    speed: [1.6, 1.6], accel: 2.2, brake: 5, turn: 2.3, health: 450, bodyMult: 0.5, mass: 4, radius: 0.46,
    reach: 2.0, damage: [26, 32], knock: 7.5, attackRate: 0.8, flinch: 'head', slowOnHit: false,
    clips: { run: 'Run' }, corpse: 26, pool: 0.75, drop: 0.3,
  },
  boss: {
    name: 'Abomination', model: 'boss', tall: 2.5, bulk: 1.3, size: [1, 1], tint: [0.5, 0.36, 0.34], gait: 'auto', voice: 0.55, boss: true,
    speed: [2.5, 2.5], accel: 4, brake: 6, turn: 2.6, health: 2600, bodyMult: 1, mass: 12, radius: 0.6,
    reach: 2.6, damage: [30, 36], knock: 8, attackRate: 0.8, flinch: 'none', slowOnHit: false,
    charge: { min: 9, max: 34, windup: 0.9, speed: 7, accel: 12, turn: 0.9, time: 3.2, damage: 38, knock: 10, cooldown: 8, recover: 1.1 },
    slam: { range: 4.6, radius: 6.5, windup: 0.8, damage: 34, knock: 7, cooldown: 6.5, recover: 0.9 },
    clips: { run: 'Run', roar: 'Roar', slam: 'Slam' }, corpse: 40, pool: 1.1, drop: 1,
  },
};
const POOL_SIZE = { zombie: 26, runner: 12, brute: 5, boss: 2 };
const CLIP_LIMITS = { Walk: [0.2, 2.4], Run: [1.5, 7], Sprint: [2.5, 9] };

async function fetchGlb(loader, name) {
  try {
    const res = await fetch(`./assets/models/${name}.glb`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return null;   // not a binary glTF
    return await loader.parseAsync(buf, './assets/models/');
  } catch (e) { return null; }
}
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------- zombies
export class Zombies {
  constructor(engine, collision, layout, fx, audio, player) {
    this.engine = engine; this.col = collision; this.layout = layout; this.fx = fx; this.audio = audio; this.player = player;
    this.list = [];
    this.sets = {};            // model name -> { template, clips, materials, tints, lods, clipSpeed, clipInfo, pool, height }
    this._none = { name: '', template: null, clips: {}, materials: [], tints: {}, lods: null, clipSpeed: { Walk: 0.45, Run: 3.4 }, clipInfo: {}, pool: [], height: 1.8 };
    this.flow = null; this.flowT = 0;
    this.kills = 0; this.slams = 0;
    this.boss = null;          // the boss in play (alive or just fallen), for the HUD
    this.onKill = null;
    this.onStuck = null;       // (zombie) => void, the director may move it
    this.maxActive = 26;
    this.passive = false;      // nobody notices the player (menu backdrop, tests)
    this.noCull = false;
    this.time = 0;
    this._frustum = new THREE.Frustum(); this._pv = new THREE.Matrix4();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), 3.2);
  }

  // the villager set under the names the rest of the code knows
  get base() { return this.sets.zombie || this._none; }
  get template() { return this.base.template; }
  get clips() { return this.base.clips; }
  get materials() { return this.base.materials; }
  get lods() { return this.base.lods; }
  get clipSpeed() { return this.base.clipSpeed; }
  get clipInfo() { return this.base.clipInfo; }
  get pool() { return this.base.pool; }

  async load() {
    const loader = new GLTFLoader();
    const names = [...new Set(Object.values(INFECTED).map((d) => d.model))];
    const gltfs = await Promise.all(names.map((nm) => fetchGlb(loader, nm)));
    names.forEach((nm, i) => { if (gltfs[i]) this.sets[nm] = this._makeSet(nm, gltfs[i]); });
    if (!this.sets.zombie) { console.info('[zombies] zombie.glb missing, using placeholder bodies'); return; }
    // build the whole pool up front so nothing is cloned or compiled mid-fight
    for (const nm in this.sets) {
      const set = this.sets[nm];
      for (let i = 0; i < (POOL_SIZE[nm] || 4); i++) { const z = this._create(set); z.root.visible = false; set.pool.push(z); }
    }
  }

  _makeSet(name, gltf) {
    const set = { name, template: gltf.scene, clips: {}, materials: [], tints: {}, lods: null, clipSpeed: { Walk: 0.45, Run: 3.4 }, clipInfo: {}, pool: [], height: 1.8 };
    for (const c of gltf.animations) set.clips[c.name] = c;
    let base = null, mesh = null, head = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !base) { base = o.material; mesh = o; } if (o.isBone && key(o.name) === 'Head') head = o; });
    if (base) {
      const variants = [base];
      if (name === 'zombie') {
        const loader = new THREE.TextureLoader();
        for (const f of ['zombie_col_b.jpg', 'zombie_col_c.jpg']) {
          const m = base.clone();
          const t = loader.load(`./assets/models/${f}`, undefined, undefined, () => {});
          t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          m.map = t;
          variants.push(m);
        }
        // tinted copies for the kinds that borrow this body (made before anything is compiled)
        for (const type in INFECTED) {
          const d = INFECTED[type];
          if (d.tint && d.model !== 'zombie') set.tints[type] = variants.map((v) => { const m = v.clone(); m.color.multiply(new THREE.Color(d.tint[0], d.tint[1], d.tint[2])); return m; });
        }
      }
      const prep = (m, i) => {
        // skin and cloth are dielectric and matte: no metal, no mirror-like sheen
        m.metalness = 0; m.metalnessMap = null;
        m.roughness = 1; m.envMapIntensity = 0.85;
        if (m.map) m.map.anisotropy = 4;
        enhance(m, { key: 'zombie' }); m.userData.variant = i;
      };
      variants.forEach(prep);
      for (const t in set.tints) set.tints[t].forEach(prep);
      set.materials = variants;
      // coarser meshes for the distance: a crowd of sub-pixel triangles is what costs frame time
      set.lods = LOD_CELL.map((cell) => (cell ? decimate(mesh.geometry, cell) : mesh.geometry));
    }
    gltf.scene.updateMatrixWorld(true);
    if (head) { const y = head.getWorldPosition(_a).y; if (y > 0.8) set.height = y + 0.2; }
    this._measureClips(gltf.scene, set);
    return set;
  }

  // Ground speed of the locomotion clips: how fast the supporting foot travels
  // backwards under the body. Playing a clip at (speed / clipSpeed) keeps the
  // feet from sliding.
  _measureClips(scene, set) {
    const bones = {};
    scene.traverse((o) => { if (o.isBone) bones[key(o.name)] = o; });
    const feet = [bones.FootL, bones.FootR];
    if (!feet[0] || !feet[1]) return;
    const mixer = new THREE.AnimationMixer(scene);
    for (const name in CLIP_LIMITS) {
      const clip = set.clips[name];
      if (!clip) continue;
      const a = mixer.clipAction(clip);
      a.play();
      const N = 120, T = clip.duration, dtS = T / N;
      const ys = [[], []], zs = [[], []];
      for (let i = 0; i <= N; i++) {
        mixer.setTime(Math.min(T * 0.9999, i * dtS));
        scene.updateMatrixWorld(true);
        for (let f = 0; f < 2; f++) { feet[f].getWorldPosition(_a); ys[f].push(_a.y); zs[f].push(_a.z); }
      }
      a.stop();
      // backward speed of whichever foot is lower (the supporting one), per sample; the median minimises slip
      const v = [];
      let range = 0, planted = 0, back = 0;
      for (let i = 0; i < N; i++) {
        const f = ys[0][i] + ys[0][i + 1] <= ys[1][i] + ys[1][i + 1] ? 0 : 1;
        v.push((zs[f][i] - zs[f][i + 1]) / dtS);
      }
      v.sort((p, q) => p - q);
      const median = v[N >> 1];
      for (let f = 0; f < 2; f++) {
        const ymin = Math.min(...ys[f]);
        range += Math.max(...zs[f]) - Math.min(...zs[f]);
        for (let i = 0; i < N; i++) if (ys[f][i] < ymin + 0.03 && ys[f][i + 1] < ymin + 0.03) { planted += dtS; back += zs[f][i] - zs[f][i + 1]; }
      }
      const stance = planted / (2 * T);
      set.clipInfo[name] = { duration: T, median, stride: range / 2, stance, strideSpeed: stance > 0.05 ? range / 2 / (stance * T) : 0 };
      // a walk always has a foot down, so the median is right; a run has flight phases, so only planted samples count
      const speed = stance >= 0.4 || planted <= 0 ? median : back / planted;
      set.clipInfo[name].speed = speed;
      if (speed >= CLIP_LIMITS[name][0] && speed <= CLIP_LIMITS[name][1]) set.clipSpeed[name] = speed;
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(scene);
    scene.updateMatrixWorld(true);
  }

  buildNav() {
    const c = this.layout.playCenter || [20, -20];
    this.flow = new FlowField(this.col, this.layout, c[0], c[1]);
  }

  _create(set) {
    const z = { root: new THREE.Group(), bones: {}, actions: {}, mixer: null, pos: new THREE.Vector3(), vel: new THREE.Vector3(), wander: new THREE.Vector3(1, 0, 0), tilt: new THREE.Quaternion(), lod: 0, set };
    if (set.template) {
      const model = SkeletonUtils.clone(set.template);
      model.traverse((o) => {
        if (o.isBone) z.bones[key(o.name)] = o;
        if (o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; z.mesh = o; }
      });
      z.root.add(model);
      z.mixer = new THREE.AnimationMixer(model);
      for (const name in set.clips) {
        const a = z.mixer.clipAction(set.clips[name]);
        if (name.startsWith('Death') || name === 'Attack' || name.startsWith('Hit') || name === 'Roar' || name === 'Slam') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
        z.actions[name] = a;
      }
    } else {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.2, 4, 10), enhance(new THREE.MeshStandardMaterial({ color: 0x555a50, roughness: 0.9 }), { key: 'zph' }));
      m.position.y = 0.9; m.castShadow = true;
      z.root.add(m); z.mesh = m;
    }
    this.engine.scene.add(z.root);
    return z;
  }

  _release(z) { z.root.visible = false; z.set.pool.push(z); if (this.boss === z) this.boss = null; }

  // frees the oldest corpse when the list is full
  _recycle() {
    let best = -1, bt = -1;
    for (let i = 0; i < this.list.length; i++) { const z = this.list[i]; if (!z.alive && z.stateT > bt) { bt = z.stateT; best = i; } }
    if (best < 0) return false;
    this._release(this.list[best]);
    this.list.splice(best, 1);
    return true;
  }

  place(z, x, zz) {
    const gy = this.col.terrain.heightAt(x, zz);
    z.pos.set(x, this.col.floorAt(x, gy + 1.0, zz, 2.2), zz);
    z.vel.set(0, 0, 0);
    z.spd = 0; z.gs = 0; z.yawV = 0; z.navX = 0; z.navZ = 0; z.losN = 0;
    z.floorY = z.pos.y; z.floorT = 0;
    z.probeX = x; z.probeZ = zz; z.probeT = 0; z.stuck = 0; z.avoidT = 0; z.losT = 0; z.direct = false;
    z.root.position.copy(z.pos);
  }

  // opts: type ('walker' | 'runner' | 'brute' | 'boss'), aware, yaw, variant, speed, healthMult (older callers: runner true / false)
  spawn(x, zz, opts = {}) {
    const type = opts.type || ((opts.runner ?? Math.random() < 0.3) ? 'runner' : 'walker');
    const def = INFECTED[type] || INFECTED.walker;
    if (this.list.length >= this.maxActive && !this._recycle()) return null;
    const own = this.sets[def.model], set = own || this.base;
    const zb = set.pool.pop() || this._create(set);
    zb.type = type; zb.def = def; zb.runner = type === 'runner'; zb.borrowed = !own;
    this.place(zb, x, zz);
    zb.yaw = opts.yaw ?? Math.random() * 6.28;
    zb.state = 'idle'; zb.stateT = 0; zb.alive = true;
    zb.maxHealth = def.health * (opts.healthMult ?? 1); zb.health = zb.maxHealth;
    zb.scale = (zb.borrowed && def.tall ? def.tall / set.height : 1) * (def.size[0] + Math.random() * (def.size[1] - def.size[0]));
    zb.bulk = zb.borrowed ? def.bulk : 1;
    zb.rad = def.radius;
    zb.root.scale.set(zb.scale * zb.bulk, zb.scale, zb.scale * zb.bulk);
    zb.speed = opts.speed ?? (def.speed[0] + Math.random() * (def.speed[1] - def.speed[0]));
    zb.aware = opts.aware ?? false;
    zb.attackHit = false; zb.attackCd = 0; zb.slow = 0; zb.groan = 2 + Math.random() * 6; zb.fade = 0; zb.corpseT = def.corpse; zb.pooled = false;
    zb.chargeCd = 2.5 + Math.random() * 2.5; zb.slamCd = 1.5; zb.chargeHit = false; zb.recoverT = 0;
    zb.side = Math.random() < 0.5 ? -1 : 1; zb.moving = false; zb.gait = '';
    zb.root.visible = true;
    zb.wander.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    zb.wanderT = 0; zb.wanderGo = false; zb.seed = Math.random() * 100;
    if (zb.mesh && zb.mesh.isSkinnedMesh && set.materials.length) {
      const pick = (zb.borrowed && set.tints[type]) || set.materials;
      zb.mesh.material = pick[(opts.variant ?? Math.floor(Math.random() * pick.length)) % pick.length];
    }
    if (zb.mixer) { zb.mixer.stopAllAction(); zb.current = null; zb.currentName = ''; this._play(zb, 'Idle', 0); zb.mixer.update(Math.random() * 2); }
    zb.root.rotation.set(0, zb.yaw, 0);
    if (def.boss) this.boss = zb;
    this.list.push(zb);
    return zb;
  }

  _play(z, name, fade = 0.22, timeScale = 1, restart = false) {
    const a = z.actions[name];
    if (!a) return;
    if (z.current === a) {
      a.timeScale = timeScale;
      if (restart) { a.reset(); a.timeScale = timeScale; a.play(); }
      return;
    }
    a.reset(); a.timeScale = timeScale; a.setEffectiveWeight(1); a.play();
    if (z.current && fade > 0) z.current.crossFadeTo(a, fade, false); else if (z.current) z.current.stop();
    z.current = a; z.currentName = name;
  }

  clear() {
    for (const z of this.list) this._release(z);
    this.list.length = 0;
    this.boss = null;
  }

  get aliveCount() { let n = 0; for (const z of this.list) if (z.alive) n++; return n; }

  // ray against one body's hit volumes -> distance (or -1); part and multiplier land in `out`
  _rayBody(z, origin, dir, maxT, out) {
    _a.set(z.pos.x, z.pos.y + 0.95 * z.scale, z.pos.z).sub(origin);
    const t = _a.dot(dir), br = 1.25 * z.scale * Math.max(1, z.bulk);
    if (t < -br || t > maxT + br) return -1;
    if (_a.lengthSq() - t * t > br * br) return -1;
    let bestT = maxT, found = false;
    if (z.mixer) {
      z.root.updateWorldMatrix(true, true);
      const rk = z.scale * z.bulk;
      for (const [part, ba, bb, r, mult] of HIT_PARTS) {
        const A = z.bones[ba]; if (!A) continue;
        A.getWorldPosition(_a);
        if (bb && z.bones[bb]) {
          z.bones[bb].getWorldPosition(_b);
          if (part === 'torso') _b.lerp(_a, 0.3);   // the capsule's cap ends at the collar, below the skull
        } else {
          // the skull sits above and slightly in front of the head joint
          _b.set(0, 0.13, 0.02).applyQuaternion(A.getWorldQuaternion(_q)).multiplyScalar(z.scale).add(_a);
          _a.lerp(_b, 0.35);
        }
        const hit = rayCapsule(origin, dir, _a, _b, r * rk, bestT);
        if (hit >= 0 && hit < bestT) { bestT = hit; found = true; out.part = part; out.mult = mult; }
      }
    } else {
      _a.set(z.pos.x, z.pos.y + 0.3, z.pos.z); _b.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
      const hit = rayCapsule(origin, dir, _a, _b, 0.3, bestT);
      if (hit >= 0 && hit < bestT) { bestT = hit; found = true; const head = origin.y + dir.y * hit > z.pos.y + 1.45; out.part = head ? 'head' : 'torso'; out.mult = head ? 4 : 1; }
    }
    return found ? bestT : -1;
  }

  // nearest zombie hit along a ray -> { zombie, part, mult, distance, point } | null
  raycast(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    const tmp = this._rb || (this._rb = {});
    for (const z of this.list) {
      if (!z.alive) continue;
      const t = this._rayBody(z, origin, dir, bestT, tmp);
      if (t >= 0 && t < bestT) { bestT = t; best = { zombie: z, part: tmp.part, mult: tmp.mult }; }
    }
    if (!best) return null;
    best.distance = bestT;
    best.point = origin.clone().addScaledVector(dir, bestT);
    return best;
  }

  // every body the ray passes through, nearest first (a bullet that keeps going)
  raycastAll(origin, dir, maxDist, max = 3) {
    const hits = [], tmp = this._rb || (this._rb = {});
    for (const z of this.list) {
      if (!z.alive) continue;
      const t = this._rayBody(z, origin, dir, maxDist, tmp);
      if (t >= 0) hits.push({ zombie: z, part: tmp.part, mult: tmp.mult, distance: t, point: origin.clone().addScaledVector(dir, t) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    if (hits.length > max) hits.length = max;
    return hits;
  }

  // returns the health actually taken
  damage(z, amount, part, dir) {
    if (!z.alive) return 0;
    const def = z.def;
    if (part !== 'head') amount *= def.bodyMult;
    z.health -= amount;
    z.aware = true;
    if (z.health <= 0) { this._kill(z, dir, part); return amount; }
    if (def.slowOnHit) z.slow = 0.5;
    const flinch = def.flinch === 'any' || (def.flinch === 'head' && part === 'head');
    if (flinch && (z.state !== 'attack' || part === 'head')) {
      z.state = 'hit'; z.stateT = 0;
      this._play(z, part === 'head' ? 'HitHead' : 'HitBody', 0.08, 1, true);
    }
    this.audio?.playAt('zombie_hurt', z.pos, { volume: 0.7, pitchVar: 0.1, rate: def.voice });
    return amount;
  }

  _kill(z, dir, part) {
    z.alive = false; z.state = 'dead'; z.stateT = 0; z.fade = 0;
    z.vel.set(0, 0, 0); z.spd = 0;
    // fall away from the shot
    const fx = Math.sin(z.yaw), fz = Math.cos(z.yaw);
    const fromFront = dir ? dir.x * fx + dir.z * fz < 0 : true;
    this._play(z, fromFront ? 'DeathBack' : 'DeathFront', 0.1, (1 + Math.random() * 0.2) / Math.max(1, z.scale), true);
    // the body settles onto the slope it dies on
    const T = this.col.terrain, gy = T.heightAt(z.pos.x, z.pos.z);
    z.hasTilt = z.pos.y - gy < 0.2;
    if (z.hasTilt) z.tilt.setFromUnitVectors(UP, T.normalAt(z.pos.x, z.pos.z, _a));
    this.kills++;
    this.audio?.playAt('zombie_death', z.pos, { volume: 0.9, pitchVar: 0.12, rate: z.def.voice });
    if (this.onKill) this.onKill(z, part);
  }

  // both a knee-high and a chest-high line to the player are free of obstacles
  _clear(z, p) {
    _a.set(z.pos.x, z.pos.y + 0.5, z.pos.z); _b.set(p.pos.x, p.pos.y + 0.5, p.pos.z);
    if (!this.col.lineOfSight(_a, _b)) return false;
    _a.y += 0.8; _b.y += 0.8;
    return this.col.lineOfSight(_a, _b);
  }

  // route direction from the flow field, blended with the cell ahead so the path bends before a corner, not on it
  _flowDir(z, out) {
    const f = this.flow;
    if (!f || !f.dir(z.pos.x, z.pos.z, _c)) return false;
    let fx = _c.x, fz = _c.z;
    if (f.dir(z.pos.x + fx * f.cell, z.pos.z + fz * f.cell, _d)) { fx += _d.x * 0.8; fz += _d.z * 0.8; }
    const l = Math.hypot(fx, fz) || 1;
    out.set(fx / l, 0, fz / l);
    return true;
  }

  _strike(z, p, dx, dz, dist, dmg, knock) {
    p.damage(dmg, _a.set(dx, 0, dz).normalize());
    if (knock > 0 && dist > 1e-3) p.knock(dx / dist, dz / dist, knock, 3);
  }

  _recover(z, time) { z.state = 'recover'; z.stateT = 0; z.recoverT = time; }

  update(dt) {
    this.time += dt;
    const p = this.player, T = this.col.terrain;
    const hunting = !this.passive && p.alive;
    this.flowT -= dt;
    if (this.flow && this.flowT <= 0 && !this.passive) { this.flow.update(p.pos.x, p.pos.z); this.flowT = 0.45; }
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    this._frustum.setFromProjectionMatrix(this._pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const camPos = cam.position;
    const fovK = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / 0.7265;
    const frame = this.engine.renderer.info.render.frame;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const z = this.list[i], def = z.def, set = z.set;
      z.stateT += dt;
      const dx = p.pos.x - z.pos.x, dz = p.pos.z - z.pos.z;
      const dist = Math.hypot(dx, dz);
      this._sphere.center.set(z.pos.x, z.pos.y + 0.9 * z.scale, z.pos.z);
      this._sphere.radius = 3.2 * z.scale;
      const seen = this.noCull || this._frustum.intersectsSphere(this._sphere);
      z.root.visible = seen;
      const camD = Math.sqrt(z.pos.distanceToSquared(camPos));
      if (set.lods && seen && z.mesh) {
        const d = (camD * fovK) / z.scale;
        let l = z.lod;
        if (z.lodLock !== undefined) l = z.lodLock;        // inspection only
        else {
          while (l < 3 && d > LOD_DIST[l] * 1.1) l++;
          while (l > 0 && d < LOD_DIST[l - 1] * 0.92) l--;
        }
        if (l !== z.lod || z.mesh.geometry !== set.lods[l]) { z.lod = l; z.mesh.geometry = set.lods[l]; }
        z.mesh.castShadow = camD < 45;
      }
      if (!z.alive) {
        if (z.stateT < 1.6) {
          const gy = T.heightAt(z.pos.x, z.pos.z);
          if (z.hasTilt) {
            z.pos.y += (gy - z.pos.y) * Math.min(1, dt * 6);
            const k = clamp(z.stateT / 1.1, 0, 1);
            z.root.quaternion.identity().slerp(z.tilt, k * k * (3 - 2 * k)).multiply(_qy.setFromAxisAngle(UP, z.yaw));
          }
          z.root.position.copy(z.pos);
        }
        // blood gathers under the torso once the body is down
        if (!z.pooled && z.stateT > 1.3) {
          z.pooled = true;
          if (def.pool > 0) {
            if (z.bones.Hips) { z.root.updateWorldMatrix(true, true); z.bones.Hips.getWorldPosition(_a); } else _a.copy(z.pos);
            if (z.hasTilt) { _a.y = T.heightAt(_a.x, _a.z); T.normalAt(_a.x, _a.z, _b); } else { _a.y = z.pos.y; _b.set(0, 1, 0); }
            if (_b.y > 0.9 && this.col.waterDepth(_a.x, _a.z) <= 0.02) z.pool = this.fx.bloodPool(_a, _b, def.pool * (0.8 + Math.random() * 0.4) * (_b.y * _b.y));
          }
        }
        if (z.stateT > z.corpseT) {
          z.fade += dt;
          z.pos.y -= dt * 0.28;
          z.root.position.y = z.pos.y;
          if (z.fade > 3.2 * Math.max(1, z.scale)) { this._release(z); this.list.splice(i, 1); continue; }
        }
        if (z.mixer && z.stateT < 5) z.mixer.update(dt);
        continue;
      }
      // awareness: sight / hearing radius
      if (!z.aware && hunting && (dist < 30 || (dist < 90 && p.input.fire && p.enabled))) { z.aware = true; if (dist < 60) this.audio?.playAt('zombie_alert', z.pos, { volume: 0.8, pitchVar: 0.12, rate: def.voice }); }
      z.groan -= dt;
      if (z.groan <= 0) { z.groan = 4 + Math.random() * 9; if (dist < 70 && !this.passive) this.audio?.playAt('zombie_idle', z.pos, { volume: 0.55, pitchVar: 0.15, rate: def.voice }); }
      z.slow = Math.max(0, z.slow - dt);
      z.avoidT -= dt; z.attackCd -= dt; z.chargeCd -= dt; z.slamCd -= dt;

      const reach = def.reach, level = Math.abs(p.pos.y - z.pos.y) < 1.6 * Math.max(1, z.scale);
      let wishX = 0, wishZ = 0, target = 0, turn = def.turn, accel = def.accel, face = false;
      const st = z.state;
      if (st === 'attack') {
        const dur = (set.clips.Attack ? set.clips.Attack.duration : 0.9) / def.attackRate;
        face = true;
        if (!z.attackHit && z.stateT > dur * 0.45) {
          z.attackHit = true;
          if (dist < reach + 0.55 && p.alive && level) this._strike(z, p, dx, dz, dist, def.damage[0] + Math.random() * (def.damage[1] - def.damage[0]), def.knock);
        }
        if (z.stateT >= dur) { z.state = 'idle'; z.stateT = 0; z.attackCd = (0.45 + Math.random() * 0.45) / def.attackRate; }
      } else if (st === 'hit') {
        if (z.stateT >= 0.38) { z.state = 'idle'; z.stateT = 0; }
      } else if (st === 'roar') {
        // the wind-up that gives a charge away
        face = true;
        if (z.stateT >= def.charge.windup) { z.state = 'charge'; z.stateT = 0; z.chargeHit = false; }
      } else if (st === 'charge') {
        // a straight run that can barely steer: side-step or roll and it thunders past
        const ch = def.charge, ahead = dx * Math.sin(z.yaw) + dz * Math.cos(z.yaw);
        if (dist > 1e-3) { wishX = dx / dist; wishZ = dz / dist; }
        target = ch.speed; turn = dist > 12 ? ch.turn : ch.turn * 0.35; accel = ch.accel;      // committed over the last metres
        if (dist < reach + 0.3 && level && p.alive && !z.chargeHit) {
          z.chargeHit = true;
          this._strike(z, p, dx, dz, dist, ch.damage, ch.knock);
          this._recover(z, ch.recover * 0.7); target = 0;
        } else if (z.stateT > ch.time || ahead < -1.5 || (z.stateT > 0.6 && z.gs < 1.2)) { this._recover(z, ch.recover); target = 0; }
      } else if (st === 'slam') {
        const sl = def.slam;
        face = z.stateT < sl.windup * 0.6;
        if (!z.attackHit && z.stateT >= sl.windup) {
          z.attackHit = true; this.slams++;
          this.fx.slam(z.pos, sl.radius);
          const nm = this.audio?.exact('boss_slam') ? 'boss_slam' : 'impact_dirt';
          this.audio?.playAt(nm, z.pos, { volume: 1.2, rate: nm === 'boss_slam' ? 1 : 0.45, ref: 12 });
          p.shake = Math.min(1.4, p.shake + 1.1 * clamp(1 - dist / 22, 0, 1));
          // the shock runs along the ground: anyone standing inside is thrown, a jump clears it
          const feet = p.pos.y - T.heightAt(p.pos.x, p.pos.z);
          if (p.alive && dist < sl.radius && level && (p.onGround || feet < 0.45)) this._strike(z, p, dx, dz, Math.max(dist, 0.1), sl.damage * (1 - 0.6 * dist / sl.radius), sl.knock);
        }
        if (z.stateT >= sl.windup + sl.recover) { z.state = 'idle'; z.stateT = 0; z.slamCd = sl.cooldown; }
      } else if (st === 'recover') {
        if (z.stateT >= z.recoverT) { z.state = 'idle'; z.stateT = 0; }
      } else if (z.aware && hunting) {
        const near = dist < reach && level;
        if (def.slam && z.slamCd <= 0 && dist < def.slam.range && level) {
          z.state = 'slam'; z.stateT = 0; z.attackHit = false;
          const c = set.clips[def.clips.slam] ? def.clips.slam : 'Attack', cd = set.clips[c] ? set.clips[c].duration : 0.9;
          this._play(z, c, 0.15, c === 'Attack' ? (cd * 0.45) / def.slam.windup : 1, true);
          this.audio?.playAt('zombie_attack', z.pos, { volume: 1, rate: def.voice });
        } else if (def.charge && z.chargeCd <= 0 && dist > def.charge.min && dist < def.charge.max && z.direct && level) {
          z.state = 'roar'; z.stateT = 0; z.chargeCd = def.charge.cooldown;
          const c = set.clips[def.clips.roar] ? def.clips.roar : 'Attack', cd = set.clips[c] ? set.clips[c].duration : 0.9;
          this._play(z, c, 0.2, c === 'Attack' ? cd / def.charge.windup : 1, true);
          const nm = this.audio?.exact('boss_roar') ? 'boss_roar' : 'zombie_alert';
          this.audio?.playAt(nm, z.pos, { volume: 1.2, rate: nm === 'boss_roar' ? 1 : 0.5, ref: 14 });
        } else if (near && z.attackCd <= 0) {
          z.state = 'attack'; z.stateT = 0; z.attackHit = false;
          this._play(z, 'Attack', 0.12, def.attackRate, true);
          this.audio?.playAt('zombie_attack', z.pos, { volume: 0.9, pitchVar: 0.1, rate: def.voice });
        } else if (near && dist < reach * 0.8) {
          z.state = 'idle'; face = true;            // gathering itself between swings
        } else {
          // walk straight at the player when the way is clear, otherwise follow the flow field
          z.losT -= dt;
          if (z.losT <= 0) {
            z.losT = 0.3 + Math.random() * 0.3;
            const clear = dist < 2.5 || (dist < 60 && z.avoidT <= 0 && this._clear(z, p));
            // two checks in a row have to agree before the route changes (no dithering at a corner)
            if (clear === z.direct) z.losN = 0; else if (++z.losN >= 2 || dist < 2.5) { z.direct = clear; z.losN = 0; }
          }
          let tx = dx, tz = dz;
          if (z.direct) {
            // packs come in on an arc and close from the side
            if (def.flank && dist > 7) { const off = Math.min(dist * 0.5, 9) * z.side; tx += (-dz / dist) * off; tz += (dx / dist) * off; }
          } else if (this._flowDir(z, _a)) { tx = _a.x; tz = _a.z; }
          const tl = Math.hypot(tx, tz) || 1, k = 1 - Math.exp(-dt * 6);
          z.navX += (tx / tl - z.navX) * k; z.navZ += (tz / tl - z.navZ) * k;
          const nl = Math.hypot(z.navX, z.navZ);
          if (nl > 1e-3) { wishX = z.navX / nl; wishZ = z.navZ / nl; }
          // ease off on the last metres so it arrives able to stop
          target = Math.min(z.speed * (z.slow > 0 ? 0.45 : 1), Math.sqrt(2 * def.brake * Math.max(0, dist - reach * 0.7)) + 0.7);
          z.state = z.speed > 2 ? 'run' : 'walk';
          // progress probe: stop pushing against something, and tell the director if it never clears
          z.probeT += dt;
          if (z.probeT >= 1.5) {
            const moved = Math.hypot(z.pos.x - z.probeX, z.pos.z - z.probeZ);
            if (moved < 0.2 * z.speed * z.probeT) z.stuck += z.probeT; else z.stuck = 0;
            z.probeX = z.pos.x; z.probeZ = z.pos.z; z.probeT = 0;
            if (z.stuck >= 1.5 && z.direct) { z.avoidT = 5; z.direct = false; z.losN = 0; }
            if (z.stuck >= 7.5) { z.stuck = 0; if (this.onStuck) this.onStuck(z); }
          }
        }
      } else {
        // idle wandering, never into a wall
        z.wanderT -= dt;
        if (z.wanderT <= 0) { z.wanderT = 3 + Math.random() * 6; z.wander.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(); z.wanderGo = Math.random() < 0.6; }
        if (z.wanderGo && this.flow && !this.flow.walkable(z.pos.x + z.wander.x * 1.8, z.pos.z + z.wander.z * 1.8)) { z.wanderGo = false; z.wanderT = Math.min(z.wanderT, 0.6 + Math.random()); }
        if (z.wanderGo) { wishX = z.wander.x; wishZ = z.wander.z; target = Math.min(z.speed, 0.8); z.state = 'walk'; } else z.state = 'idle';
      }

      // ---- locomotion: turn towards where it wants to go and move along the facing.
      // The turn rate eases in and out, speed changes by acceleration, nothing slides sideways.
      let tspd = 0;
      if (target > 0 || face) {
        const want = target > 0 ? Math.atan2(wishX, wishZ) : Math.atan2(dx, dz);
        const dy = wrapPi(want - z.yaw);
        const lim = target > 0 ? turn : def.turn * 1.5;
        z.yawV += (clamp(dy * 5, -lim, lim) - z.yawV) * (1 - Math.exp(-dt * 10));
        const stepY = z.yawV * dt;
        z.yaw += Math.abs(stepY) > Math.abs(dy) ? dy : stepY;
        if (target > 0) tspd = target * (this.col.waterDepth(z.pos.x, z.pos.z) > 0.3 ? 0.55 : 1) * clamp((Math.cos(dy) - 0.2) / 0.6, 0, 1);
      } else z.yawV *= Math.exp(-dt * 10);
      z.spd += clamp(tspd - z.spd, -def.brake * dt, accel * dt);
      const hx = Math.sin(z.yaw), hz = Math.cos(z.yaw);
      z.vel.x = hx * z.spd; z.vel.z = hz * z.spd;
      const ox = z.pos.x, oz = z.pos.z;
      z.pos.x += z.vel.x * dt; z.pos.z += z.vel.z * dt;
      const ax0 = z.pos.x, az0 = z.pos.z;
      // bodies make room for each other (the heavy give way less): a steady push, never a jump
      let sx = 0, sz = 0;
      for (const o of this.list) {
        if (o === z || !o.alive) continue;
        const ax = z.pos.x - o.pos.x, az = z.pos.z - o.pos.z, rr = z.rad + o.rad + 0.12;
        const d2 = ax * ax + az * az;
        if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2), push = (rr - d) * (o.def.mass / (z.def.mass + o.def.mass)) * Math.min(1, dt * 7); sx += (ax / d) * push; sz += (az / d) * push; }
      }
      z.pos.x += sx; z.pos.z += sz;
      // bodies do not overlap the player; the big ones are not pushed aside
      const minD = 0.42 + z.rad;
      if (dist < minD && dist > 1e-3 && p.alive && p.enabled && Math.abs(p.pos.y - z.pos.y) < 1.5) {
        const push = minD - dist, share = def.mass >= 4 ? 0 : 0.5;
        z.pos.x -= (dx / dist) * push * share; z.pos.z -= (dz / dist) * push * share;
        p.pos.x += (dx / dist) * push * (1 - share); p.pos.z += (dz / dist) * push * (1 - share);
      }
      const c = this.col.resolveCapsule(z.pos, Math.min(z.rad, 0.45), 1.7);
      if (c.lengthSq() > 0) { z.pos.x += c.x; z.pos.z += c.z; }
      z.floorT -= dt;
      if (z.floorT <= 0) { z.floorT = 0.15 + Math.random() * 0.1; z.floorY = this.col.floorAt(z.pos.x, z.pos.y + 0.6, z.pos.z, 2.5); }
      const ty = Math.max(z.floorY, T.heightAt(z.pos.x, z.pos.z));
      z.pos.y += (ty - z.pos.y) * Math.min(1, dt * 12);

      // ---- animation follows the ground actually covered along the facing, so feet stay planted
      const adv = Math.max(0, ((z.pos.x - ox - sx) * hx + (z.pos.z - oz - sz) * hz) / Math.max(dt, 1e-4));
      z.gs += (adv - z.gs) * (1 - Math.exp(-dt * 12));
      if (adv < z.spd * 0.5 && (Math.abs(z.pos.x - sx - ax0) + Math.abs(z.pos.z - sz - az0)) > 1e-6) z.spd = Math.max(adv, z.spd - 25 * dt);   // held up by something solid: stop pushing, no treadmill
      const s2 = z.state;
      if (s2 === 'walk' || s2 === 'run' || s2 === 'idle' || s2 === 'charge' || s2 === 'recover') {
        if (z.moving ? z.gs < 0.1 : z.gs > 0.26) z.moving = !z.moving;
        if (z.moving) {
          const runClip = set.clips[def.clips.run] ? def.clips.run : 'Run';
          const tsW = z.gs / ((set.clipSpeed.Walk || 0.5) * z.scale), tsR = z.gs / ((set.clipSpeed[runClip] || 3.4) * z.scale);
          // the gait whose playback rate is closer to natural, with a preference for the one already playing
          let run = false;
          if (def.gait !== 'walk' && set.clips[runClip]) {
            const cw = Math.abs(Math.log(tsW)) * (z.gait === 'Walk' ? 1 : 1.3), cr = Math.abs(Math.log(tsR)) * (z.gait === runClip ? 1 : 1.3);
            run = cr < cw;
          }
          z.gait = run ? runClip : 'Walk';
          this._play(z, z.gait, 0.25, clamp(run ? tsR : tsW, 0.3, 3.2));
        } else { z.gait = ''; this._play(z, 'Idle', 0.3); }
      }
      z.root.position.copy(z.pos);
      z.root.rotation.set(0, z.yaw, 0);
      if (z.mixer && seen) {
        const far = camD > 45;
        if (!far || (frame & 1) === (i & 1)) z.mixer.update(far ? dt * 2 : dt);
      }
    }
  }
}
