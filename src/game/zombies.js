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
        // stand on the floor where there is one (house floors sit up to ~0.6 m above the ground)
        const f = collision.floorAt(x, h + 0.75, z, 0.85), y = f > h && f - h < 0.6 ? f : h;
        _box.min.set(x - cell * 0.45, y + 0.45, z - cell * 0.45); _box.max.set(x + cell * 0.45, y + 1.5, z + cell * 0.45);
        if (collision.bvh.intersectsBox(_box, _id)) w = 0;
      }
      if (w) { const wd = collision.waterDepth(x, z); if (wd > 1.5) w = 0; else if (wd > 0.25) w = 2; }
      this.walk[j * n + i] = w;
    }
    // doorways (~1 m) are narrower than a cell: open a line of cells straight through each one
    for (const b of (layout && layout.buildings) || []) for (const d of b.doors || []) {
      if (d.w < 0.9) continue;
      for (let t = -1.8; t <= 1.81; t += 0.3) { const c = this.cellOf(d.x + d.nx * t, d.z + d.nz * t); if (c >= 0 && !this.walk[c]) this.walk[c] = 1; }
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
// scaled to `tall` metres, widened by `bulk` and tinted. Those three apply to the
// stand-in only: a delivered model is used exactly as authored.
// `gaits`: ground speed (m/s) at which each locomotion clip keeps the stance foot planted
// (playback is scaled from these). `albedo`: extra colour maps <model>_col_<x>.jpg.
// Boss clips: Roar lasts the charge wind-up (0.9 s), the fists of Slam strike the ground 0.8 s in.
export const INFECTED = {
  walker: {
    name: 'Walker', model: 'zombie', tall: 0, bulk: 1, size: [0.95, 1.05], tint: null, voice: 1, albedo: ['b', 'c'],
    gaits: { Walk: 1.0, Run: 3.0, Sprint: 4.2 }, lunge: 2.6,
    speed: [0.9, 1.3], accel: 3, brake: 7, turn: 3.4, health: 100, bodyMult: 1, mass: 1, radius: 0.3,
    reach: 1.55, damage: [11, 17], knock: 0, attackRate: 1, flinch: 'any', slowOnHit: true,
    clips: {}, corpse: 22, pool: 0.5, drop: 0.04,
  },
  runner: {
    name: 'Runner', model: 'runner', tall: 0, bulk: 0.9, size: [0.95, 1.03], tint: [1.0, 0.84, 0.78], voice: 1.15, albedo: ['b'],
    gaits: { Walk: 1.5, Run: 3.4, Sprint: 5.2 },
    speed: [4.5, 5.5], accel: 7, brake: 10, turn: 5, health: 60, bodyMult: 1, mass: 0.8, radius: 0.28,
    reach: 1.5, damage: [8, 12], knock: 0, attackRate: 1.25, flinch: 'any', slowOnHit: true, flank: true,
    clips: {}, corpse: 18, pool: 0.42, drop: 0.04,
  },
  brute: {
    name: 'Brute', model: 'brute', tall: 2.1, bulk: 1.28, size: [0.98, 1.02], tint: [0.6, 0.58, 0.56], voice: 0.75, albedo: ['b'],
    gaits: { Walk: 1.6, Run: 3.2, Sprint: 4.4 }, shove: true,
    speed: [1.5, 1.7], accel: 2.2, brake: 5, turn: 2.3, health: 450, bodyMult: 0.5, mass: 4, radius: 0.46,
    reach: 2.0, damage: [26, 32], knock: 7.5, attackRate: 0.8, flinch: 'head', slowOnHit: false,
    clips: {}, corpse: 26, pool: 0.75, drop: 0.3,
  },
  boss: {
    name: 'Abomination', model: 'boss', tall: 2.5, bulk: 1.3, size: [1, 1], tint: [0.5, 0.36, 0.34], voice: 0.55, boss: true, albedo: ['b'],
    gaits: { Walk: 2.2, Run: 6.6, Sprint: 7.6 },
    speed: [2.4, 2.6], accel: 4, brake: 6, turn: 2.6, health: 2600, bodyMult: 1, mass: 12, radius: 0.6,
    reach: 2.6, damage: [30, 36], knock: 8, attackRate: 0.8, flinch: 'none', slowOnHit: false,
    charge: { min: 9, max: 34, windup: 0.9, speed: 7, accel: 9, turn: 0.9, time: 3.2, damage: 38, knock: 10, cooldown: 8, recover: 1.3 },
    slam: { range: 4.6, radius: 6.5, windup: 0.8, damage: 34, knock: 7, cooldown: 6.5, recover: 1.0 },
    clips: { roar: 'Roar', slam: 'Slam' }, corpse: 40, pool: 1.1, drop: 1,
  },
};
const LOCO = ['Walk', 'Run', 'Sprint'], LOCO_ALL = ['Idle', 'Walk', 'Run', 'Sprint'];
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
    this._none = { name: '', template: null, clips: {}, materials: [], tints: {}, lods: null, clipSpeed: { ...INFECTED.walker.gaits }, gaits: INFECTED.walker.gaits, phase0: {}, clipInfo: {}, pool: [], height: 1.8 };
    this.flow = null; this.flowT = 0;
    this.kills = 0; this.slams = 0;
    this.boss = null;          // the boss in play (alive or just fallen), for the HUD
    this.onKill = null;
    this.onStuck = null;       // (zombie) => void, the director may move it
    this.maxActive = 26;
    this.passive = false;      // nobody notices the player (menu backdrop, tests)
    this.noCull = false;
    this.animAll = false;      // inspection: every body animated every step, whatever the distance (zslip)
    this.prof = null;          // inspection: {} collects milliseconds per update section (zslip --perf)
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
    const own = Object.values(INFECTED).find((d) => d.model === name) || INFECTED.walker;
    const set = { name, template: gltf.scene, clips: {}, materials: [], tints: {}, lods: null, clipSpeed: { ...own.gaits }, gaits: own.gaits, phase0: {}, clipInfo: {}, pool: [], height: 1.8 };
    for (const c of gltf.animations) set.clips[c.name] = c;
    let base = null, mesh = null, head = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !base) { base = o.material; mesh = o; } if (o.isBone && key(o.name) === 'Head') head = o; });
    if (base) {
      const variants = [base];
      const loader = new THREE.TextureLoader();
      for (const f of (own.albedo || []).map((x) => `${name}_col_${x}.jpg`)) {
        {
          const m = base.clone();
          const t = loader.load(`./assets/models/${f}`, undefined, undefined, () => {});
          t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          m.map = t;
          variants.push(m);
        }
      }
      if (name === 'zombie') {
        // tinted copies for the kinds that borrow this body (made before anything is compiled)
        for (const type in INFECTED) {
          const d = INFECTED[type];
          if (d.tint && d.model !== 'zombie') set.tints[type] = variants.map((v) => { const m = v.clone(); m.color.multiply(new THREE.Color(d.tint[0], d.tint[1], d.tint[2])); return m; });
        }
      }
      const prep = (m, i) => {
        // skin and cloth are dielectric and matte: no metal, no mirror-like sheen
        m.metalness = 0; m.metalnessMap = null;
        m.roughness = 1; m.envMapIntensity = 1.15;
        m.color.multiplyScalar(1.25);   // the delivered albedos are dark; lift them to sit in the scene's light
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
      let lead = -1e9;
      for (let i = 0; i <= N; i++) {
        mixer.setTime(Math.min(T * 0.9999, i * dtS));
        scene.updateMatrixWorld(true);
        for (let f = 0; f < 2; f++) { feet[f].getWorldPosition(_a); ys[f].push(_a.y); zs[f].push(_a.z); }
        if (i < N && zs[0][i] - zs[1][i] > lead) { lead = zs[0][i] - zs[1][i]; set.phase0[name] = i / N; }
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
      set.clipInfo[name].speed = speed;      // measured; playback uses the authored set.gaits
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
    const z = { root: new THREE.Group(), bones: {}, actions: {}, mixer: null, pos: new THREE.Vector3(), vel: new THREE.Vector3(), wander: new THREE.Vector3(1, 0, 0), tilt: new THREE.Quaternion(), lod: 0, set, lw: { Idle: 1, Walk: 0, Run: 0, Sprint: 0 } };
    z.root.rotation.order = 'YXZ';    // yaw, then pitch and lean about the body's own axes
    if (set.template) {
      const model = SkeletonUtils.clone(set.template);
      model.traverse((o) => {
        if (o.isBone) z.bones[key(o.name)] = o;
        if (o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; z.mesh = o; }
      });
      z.root.add(model);
      // a hidden body (pooled, or outside the view) keeps its bones as they are: no world matrices
      // for a skeleton nobody draws (hit volumes and blood ask for them with updateWorldMatrix)
      const upd = z.root.updateMatrixWorld;
      z.root.updateMatrixWorld = function (force) { if (this.visible) upd.call(this, force); };
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
    z.wet = false; z.clrOk = false; z.clrN = 0; z.clrX = x; z.clrY = z.pos.y; z.clrZ = zz;
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
    zb.gaits = own ? def.gaits : set.gaits;
    zb.alertT = def.boss ? 0.35 : -1; zb.entry = false; zb.hitDur = 0.4; zb.third = 3; zb.shoveT = 0; zb.dripT = 1; zb.lungeT = 0; zb.lungeCd = 2 + Math.random() * 3;
    zb.kickX = 0; zb.kickZ = 0; zb.twist = 0; zb.recoil = 0; zb.lean = 0; zb.pitch = 0; zb.gsPrev = 0; zb.look = 0; zb.lookW = 0; zb.animAcc = 0; zb.deathYaw = 0;
    zb.loco = 'Idle'; zb.gait = ''; zb.lastGait = 'Walk'; zb.rate = 0; zb.phase = Math.random();
    if (zb.mesh && zb.mesh.isSkinnedMesh && set.materials.length) {
      const pick = (zb.borrowed && set.tints[type]) || set.materials;
      zb.mesh.material = pick[(opts.variant ?? Math.floor(Math.random() * pick.length)) % pick.length];
    }
    if (zb.mixer) {
      zb.mixer.stopAllAction(); zb.over = null; zb.overOld = null; zb.overW = 0; zb.overOldW = 0; zb.overOn = false;
      for (const n of LOCO_ALL) zb.lw[n] = n === 'Idle' ? 1 : 0;
      const idle = zb.actions.Idle;
      if (idle) { idle.reset(); idle.setEffectiveWeight(1); idle.play(); idle.time = Math.random() * idle.getClip().duration; }
      zb.current = idle || null; zb.currentName = 'Idle';
      zb.mixer.update(0);
    }
    zb.root.rotation.set(0, zb.yaw, 0);
    if (def.boss) this.boss = zb;
    this.list.push(zb);
    return zb;
  }

  // A one-shot clip (attack, hit, death, roar, slam) laid over the locomotion at `weight`;
  // it fades in over `fade`, plays, and (unless it is a death) fades back out at its end.
  _play(z, name, fade = 0.15, timeScale = 1, restart = true, weight = 1) {
    const a = z.actions[name];
    if (!a || !z.mixer) return;
    if (z.over === a && !restart) { a.timeScale = timeScale; return; }
    if (z.over && z.over !== a) {
      if (z.overOld && z.overOld !== a) z.overOld.stop();
      z.overOld = z.over; z.overOldW = z.overW; z.overW = 0;
    }
    if (z.overOld === a) { z.overOld = null; z.overOldW = 0; }
    if (z.over !== a) z.overW = 0;
    a.reset(); a.timeScale = timeScale; a.setEffectiveWeight(z.overW); a.play();
    z.over = a; z.overName = name; z.overMax = weight; z.overIn = Math.max(0.03, fade); z.overOn = true; z.overHold = name.startsWith('Death');
    if (weight >= 0.5) { z.current = a; z.currentName = name; }
  }

  // Locomotion: Walk / Run / Sprint chosen by ground speed with hysteresis, all three on
  // one shared phase (aligned at the left foot's forward contact) so a blend never scissors
  // the legs, played at the rate that keeps the stance foot planted.
  _gait(z, v, dt) {
    const g = z.gaits, s = z.scale, A = z.actions;
    let w = z.loco;
    if (w === 'Idle') { if (v > 0.25 * g.Walk * s) w = z.lastGait === 'Walk' || v < g.Walk * s ? 'Walk' : z.lastGait; } else if (v < 0.1 * g.Walk * s) w = 'Idle';
    if (w !== 'Idle') {
      const wr = Math.sqrt(g.Walk * g.Run) * s, rs = Math.sqrt(g.Run * g.Sprint) * s;
      // up-shift before the next clip's own speed (boss Run 6.6 / Sprint 7.6 sit closer than 8 %)
      if (w === 'Walk' && A.Run && v > Math.min(wr * 1.08, g.Run * s * 0.97)) w = 'Run';
      if (w === 'Run' && A.Sprint && v > Math.min(rs * 1.08, g.Sprint * s * 0.97)) w = 'Sprint';
      if (w === 'Sprint' && v < rs * 0.92) w = 'Run';
      if (w === 'Run' && v < wr * 0.92) w = 'Walk';
      if (!A[w]) w = 'Walk';
      z.lastGait = w;
    }
    z.loco = w; z.gait = w === 'Idle' ? '' : w;
    const D = z.lastGait, a = A[D];
    z.rate = clamp(v / (g[D] * s), 0, 1.8);
    if (a) z.phase = (z.phase + (dt * z.rate) / a.getClip().duration) % 1;
  }

  // weights for this step (dt may cover several frames for far bodies), then the mixer
  _animate(z, dt, near) {
    const A = z.actions, o = z.over;
    if (o) {
      const dur = o.getClip().duration;
      if (z.overOn && !z.overHold && o.time >= dur - 0.2 * Math.abs(o.timeScale)) z.overOn = false;
      if (z.overOn) z.overW = Math.min(z.overMax, z.overW + (dt / z.overIn) * z.overMax);
      else { z.overW -= dt / 0.22; if (z.overW <= 0) { o.stop(); z.over = null; z.overW = 0; } }
    }
    if (z.overOld) { z.overOldW -= dt / 0.15; if (z.overOldW <= 0) { z.overOld.stop(); z.overOld = null; z.overOldW = 0; } }
    const k = dt / 0.25;
    let sum = 0;
    for (const n of LOCO_ALL) { const w = z.lw[n], t = n === z.loco ? 1 : 0; z.lw[n] = w < t ? Math.min(t, w + k) : Math.max(t, w - k); if (A[n]) sum += z.lw[n]; }
    let ov = (z.over ? z.overW : 0) + (z.overOld ? z.overOldW : 0);
    const norm = ov > 1 ? 1 / ov : 1;
    const base = Math.max(0, 1 - ov * norm);
    const D = A[z.lastGait], rn = D ? z.rate / D.getClip().duration : 0;
    for (const n of LOCO_ALL) {
      const a = A[n];
      if (!a) continue;
      const w = sum > 0 ? (z.lw[n] / sum) * base : 0;
      if (w > 1e-3) {
        if (!a.isScheduled()) { a.reset(); a.play(); if (n === 'Idle') a.time = Math.random() * a.getClip().duration; }
        a.setEffectiveWeight(w);
        if (n !== 'Idle') { const du = a.getClip().duration; a.timeScale = rn * du; a.time = ((((z.phase + (z.set.phase0[n] || 0) - rn * dt) % 1) + 1) % 1) * du; }
      } else if (a.isScheduled()) a.stop();
    }
    if (z.over) z.over.setEffectiveWeight(z.overW * norm);
    if (z.overOld) z.overOld.setEffectiveWeight(z.overOldW * norm);
    z.mixer.update(dt);
    if (z.over && z.overW >= 0.5) { z.current = z.over; z.currentName = z.overName; } else if (A[z.loco]) { z.current = A[z.loco]; z.currentName = z.loco; }
    if (!near || !z.alive) return;
    // small procedural layers on top: torso twist from a hit, the head looking about
    const ch = z.bones.Chest || z.bones.Spine;
    if (ch && Math.abs(z.twist) > 0.01) ch.rotateY(z.twist);
    if (z.bones.Neck && z.lookW > 0.01) z.bones.Neck.rotateY(z.look * z.lookW);
  }

  // a hit reaction scaled by strength `s` (0..1) and turned by the side the shot came from
  _flinch(z, dx, dz, s, head) {
    const hx = Math.sin(z.yaw), hz = Math.cos(z.yaw);
    z.twist = clamp(z.twist + (dz * hx - dx * hz) * s * 0.7, -0.6, 0.6);
    z.recoil = clamp(z.recoil + (dx * hx + dz * hz) * s, -1, 1);
    const kick = (1.6 * s) / Math.sqrt(z.def.mass);
    z.kickX += dx * kick; z.kickZ += dz * kick;
    const name = head && z.actions.HitHead ? 'HitHead' : 'HitBody';
    if (s > 0.5) { z.state = 'hit'; z.stateT = 0; z.hitDur = 0.28 + 0.4 * s; this._play(z, name, 0.06, 1.2 - 0.35 * s, true, 1); }
    else this._play(z, name, 0.08, 1.25, true, 0.3 + s * 0.6);
  }

  // noticed the player: a start and a turn (the boss roars)
  _startle(z) {
    z.alertT = -1; z.stateT = 0;
    if (z.def.boss) {
      const c = z.actions.Roar ? 'Roar' : 'Attack';
      z.state = 'roar'; z.entry = true; this._play(z, c, 0.2, 1, true);
      const nm = this.audio?.exact('boss_roar') ? 'boss_roar' : 'zombie_alert';
      this.audio?.playAt(nm, z.pos, { volume: 1.2, rate: nm === 'boss_roar' ? 1 : 0.5, ref: 14 });
      return;
    }
    z.state = 'startle'; z.hitDur = z.type === 'runner' ? 0.4 : 0.6 + Math.random() * 0.3;
    this._play(z, 'HitHead', 0.1, 0.8, true, 0.45);
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
    if (part === 'head' && def.health <= 100) amount = Math.max(amount, z.health);   // a head shot drops the light ones outright
    z.health -= amount;
    z.aware = true; z.alertT = -1;
    if (z.health <= 0) { this._kill(z, dir, part); return amount; }
    if (def.slowOnHit) z.slow = 0.5;
    const dx = dir ? dir.x : 0, dz = dir ? dir.z : 0, l = Math.hypot(dx, dz) || 1;
    const s = clamp(amount / (z.maxHealth * 0.35), 0.15, 1);
    const busy = z.state === 'roar' || z.state === 'slam' || z.state === 'charge';
    if (def.boss) {
      // staggers each time its health drops through a third
      const third = Math.ceil((z.health / z.maxHealth) * 3 - 1e-6);
      if (third < z.third) {
        z.third = third; z.state = 'stagger'; z.stateT = 0; z.hitDur = 1.6; z.chargeCd = Math.max(z.chargeCd, 2.5);
        this._play(z, 'HitBody', 0.12, 0.55, true, 1);
        this.audio?.playAt(this.audio?.exact('boss_roar') ? 'boss_roar' : 'zombie_hurt', z.pos, { volume: 1, rate: 0.8, ref: 12 });
      } else z.twist = clamp(z.twist + (dz * Math.sin(z.yaw) - dx * Math.cos(z.yaw)) / l * 0.12, -0.3, 0.3);
    } else {
      const flinch = def.flinch === 'any' || (def.flinch === 'head' && part === 'head');
      if (flinch && !busy && (z.state !== 'attack' || part === 'head')) this._flinch(z, dx / l, dz / l, s, part === 'head');
      else { z.twist = clamp(z.twist + (dz * Math.sin(z.yaw) - dx * Math.cos(z.yaw)) / l * s * 0.4, -0.4, 0.4); z.recoil += ((dx * Math.sin(z.yaw) + dz * Math.cos(z.yaw)) / l) * s * 0.4; }
    }
    this.audio?.playAt('zombie_hurt', z.pos, { volume: 0.7, pitchVar: 0.1, rate: def.voice });
    return amount;
  }

  _kill(z, dir, part) {
    const hx = Math.sin(z.yaw), hz = Math.cos(z.yaw);
    let dx = dir ? dir.x : -hx, dz = dir ? dir.z : -hz;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const fromFront = dx * hx + dz * hz < 0;
    // a body running flat out folds forwards whatever hit it; otherwise it goes down along the shot
    const pitching = z.spd > 0.55 * z.gaits.Run * z.scale && fromFront;
    const back = fromFront && !pitching;
    z.deathYaw = pitching ? 0 : clamp(wrapPi((back ? Math.atan2(-dx, -dz) : Math.atan2(dx, dz)) - z.yaw), -0.75, 0.75);
    const push = (part === 'head' ? 0.7 : 1.2) / Math.sqrt(z.def.mass);
    z.kickX = z.vel.x * 0.55 + dx * push; z.kickZ = z.vel.z * 0.55 + dz * push;
    z.alive = false; z.state = 'dead'; z.stateT = 0; z.fade = 0;
    z.vel.set(0, 0, 0); z.spd = 0; z.twist = 0; z.lookW = 0; z.loco = 'Idle';
    this._play(z, back ? 'DeathBack' : 'DeathFront', 0.1, ((part === 'head' ? 1.15 : 1) * (0.95 + Math.random() * 0.15)) / Math.max(1, z.scale), true);
    // the body settles onto the slope under where it will lie (a plane through four samples)
    const T = this.col.terrain, gy = T.heightAt(z.pos.x, z.pos.z);
    z.hasTilt = z.pos.y - gy < 0.2;
    if (z.hasTilt) {
      const yw = z.yaw + z.deathYaw, fx = Math.sin(yw) * (back ? -1 : 1), fz = Math.cos(yw) * (back ? -1 : 1);
      const cx = z.pos.x + fx * 0.8 * z.scale + z.kickX * 0.25, cz = z.pos.z + fz * 0.8 * z.scale + z.kickZ * 0.25, L = 0.8 * z.scale, W = 0.35 * z.scale;
      const gL = (T.heightAt(cx + fx * L, cz + fz * L) - T.heightAt(cx - fx * L, cz - fz * L)) / (2 * L);
      const gW = (T.heightAt(cx - fz * W, cz + fx * W) - T.heightAt(cx + fz * W, cz - fx * W)) / (2 * W);
      _a.set(-(gL * fx - gW * fz), 1, -(gL * fz + gW * fx)).normalize();
      z.tilt.setFromUnitVectors(UP, _a);
    }
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

  // Nothing solid within a margin around the body (a cheap box query on the collider BVH and the
  // box colliders) means the exact capsule test cannot push it this step, nor until it has moved
  // that margin; next to geometry the exact test runs every step and the query waits a while.
  _contactFree(z) {
    const M = 0.35, p = z.pos;
    if (z.clrOk && Math.abs(p.x - z.clrX) < M && Math.abs(p.z - z.clrZ) < M && Math.abs(p.y - z.clrY) < M) return true;
    z.clrOk = false;
    if (--z.clrN > 0) return false;
    const r = Math.min(z.rad, 0.45) + M, col = this.col;
    // from just above the soles: the floor it stands on never pushes it sideways
    _box.min.set(p.x - r, p.y + 0.15, p.z - r); _box.max.set(p.x + r, p.y + 1.7 + M, p.z + r);
    let hit = !!(col.bvh && col.bvh.intersectsBox(_box, _id));
    if (!hit && col.boxes) for (const b of col.boxes) {
      if (p.y - M >= b.y + b.h || p.y + 1.7 + M <= b.y) continue;
      const R = r + Math.abs(b.hx) + Math.abs(b.hz);
      if (Math.abs(p.x - b.x) < R && Math.abs(p.z - b.z) < R) { hit = true; break; }
    }
    if (hit) { z.clrN = 12; return false; }
    z.clrOk = true; z.clrX = p.x; z.clrY = p.y; z.clrZ = p.z;
    return true;
  }

  _recover(z, time) { z.state = 'recover'; z.stateT = 0; z.recoverT = time; if (z.def.boss) this._play(z, 'HitBody', 0.25, 0.45, true, 0.5); }

  update(dt) {
    this.time += dt;
    const p = this.player, T = this.col.terrain;
    const hunting = !this.passive && p.alive;
    // inspection: Zombies.prof = {} collects milliseconds per section (zslip --perf)
    const P = this.prof;
    let tp = P ? performance.now() : 0;
    const lap = P ? (k) => { const t = performance.now(); P[k] = (P[k] || 0) + t - tp; tp = t; } : null;
    this.flowT -= dt;
    if (this.flow && this.flowT <= 0 && !this.passive) { this.flow.update(p.pos.x, p.pos.z); this.flowT = 0.45; }
    if (lap) lap('flowField');
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    this._frustum.setFromProjectionMatrix(this._pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const camPos = cam.position;
    const fovK = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / 0.7265;
    const frame = (this._tick = (this._tick || 0) + 1);   // own counter: throttling must not depend on rendering
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
        z.mesh.castShadow = camD < 28;
      }
      if (lap) lap('cullLod');
      if (!z.alive) {
        if (z.stateT < 2) {
          // momentum carries the body on a little; it turns into the fall and settles onto the slope
          if (z.kickX || z.kickZ) {
            z.pos.x += z.kickX * dt; z.pos.z += z.kickZ * dt;
            const kd = Math.exp(-dt * 4); z.kickX *= kd; z.kickZ *= kd;
            if (Math.abs(z.kickX) + Math.abs(z.kickZ) < 0.01) z.kickX = z.kickZ = 0;
            const c = this.col.resolveCapsule(z.pos, 0.3, 1.0);
            if (c.lengthSq() > 0) { z.pos.x += c.x; z.pos.z += c.z; z.kickX *= 0.5; z.kickZ *= 0.5; }
          }
          if (z.deathYaw) { const st = z.deathYaw * Math.min(1, dt * 7); z.yaw += st; z.deathYaw -= st; if (Math.abs(z.deathYaw) < 1e-3) z.deathYaw = 0; }
          const gy = T.heightAt(z.pos.x, z.pos.z);
          if (z.hasTilt) {
            z.pos.y += (gy - z.pos.y) * Math.min(1, dt * 6);
            const k = clamp(z.stateT / 1.1, 0, 1);
            z.root.quaternion.identity().slerp(z.tilt, k * k * (3 - 2 * k)).multiply(_qy.setFromAxisAngle(UP, z.yaw));
          } else z.root.rotation.set(0, z.yaw, 0);
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
          // taken away where nobody is looking; only a body kept in view for very long sinks away
          if (!seen || camD > 70) { this._release(z); this.list.splice(i, 1); continue; }
          if (z.stateT > z.corpseT * 2.5) {
            z.fade += dt; z.pos.y -= dt * 0.12; z.root.position.y = z.pos.y;
            if (z.fade > 6 * Math.max(1, z.scale)) { this._release(z); this.list.splice(i, 1); continue; }
          }
        }
        if (z.mixer && z.stateT < 5) this._animate(z, dt, false);
        if (lap) lap('dead');
        continue;
      }
      // awareness: sight / hearing radius
      if (!z.aware && hunting && (dist < 30 || (dist < 90 && p.input.fire && p.enabled))) { z.aware = true; z.alertT = Math.min(0.5, dist * 0.015) + Math.random() * 0.3; if (dist < 60) { if (z.type === 'brute' && this.audio?.exact('brute_growl')) this.audio.playAt('brute_growl', z.pos, { volume: 1, pitchVar: 0.08, ref: 8 }); else this.audio?.playAt('zombie_alert', z.pos, { volume: 0.8, pitchVar: 0.12, rate: def.voice }); } }
      z.groan -= dt;
      if (z.groan <= 0) { z.groan = 4 + Math.random() * 9; if (dist < 70 && !this.passive) {
        const a = this.audio;
        if (z.type === 'runner' && a?.exact('zombie_run')) a.playAt('zombie_run', z.pos, { volume: 0.65, pitchVar: 0.1 });
        else if (z.type === 'brute' && a?.exact('brute_growl')) a.playAt('brute_growl', z.pos, { volume: 0.8, pitchVar: 0.1, ref: 7 });
        else a?.playAt('zombie_idle', z.pos, { volume: 0.55, pitchVar: 0.15, rate: def.voice });
      } }
      z.slow = Math.max(0, z.slow - dt); z.shoveT -= dt;
      // the wounded bleed
      if (z.health < z.maxHealth * 0.6 && seen && camD < 35) {
        z.dripT -= dt;
        if (z.dripT <= 0) {
          z.dripT = 0.2 + (z.health / z.maxHealth) * 1.3 + Math.random() * 0.4;
          if (z.bones.Hips) z.bones.Hips.getWorldPosition(_a); else _a.set(z.pos.x, z.pos.y + 1, z.pos.z);
          this.fx.drip?.(_a, z.pos.y);
        }
      }
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
      } else if (st === 'hit' || st === 'startle' || st === 'stagger') {
        face = st === 'startle';
        if (z.stateT >= z.hitDur) { z.state = 'idle'; z.stateT = 0; }
      } else if (st === 'roar') {
        // the wind-up that gives a charge away, or the bellow on entry
        face = true;
        if (z.stateT >= (def.charge ? def.charge.windup : 0.9)) {
          if (z.entry || !def.charge) { z.entry = false; z.state = 'idle'; z.stateT = 0; } else { z.state = 'charge'; z.stateT = 0; z.chargeHit = false; }
        }
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
      } else if (z.aware && hunting && z.alertT > 0) {
        // a beat before it reacts (the far ones later), then the start and the turn
        z.alertT -= dt; z.state = 'idle';
        if (z.alertT <= 0) this._startle(z);
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
            // packs swing wide and weave as they come, so they are hard to line up
            if (def.flank && dist > 6) { const off = Math.min(dist * 0.5, 9) * z.side + Math.sin(this.time * 1.3 + z.seed) * Math.min(2.5, dist * 0.2); tx += (-dz / dist) * off; tz += (dx / dist) * off; }
          } else if (this._flowDir(z, _a)) { tx = _a.x; tz = _a.z; }
          const tl = Math.hypot(tx, tz) || 1, k = 1 - Math.exp(-dt * 6);
          z.navX += (tx / tl - z.navX) * k; z.navZ += (tz / tl - z.navZ) * k;
          const nl = Math.hypot(z.navX, z.navZ);
          if (nl > 1e-3) { wishX = z.navX / nl; wishZ = z.navZ / nl; }
          // ease off on the last metres so it arrives able to stop
          // a walker that gets close lunges the last metres
          z.lungeT -= dt; z.lungeCd -= dt;
          if (def.lunge && z.lungeCd <= 0 && z.direct && dist < 3.8 && dist > reach + 0.4) { z.lungeT = 0.8; z.lungeCd = 5 + Math.random() * 4; }
          const top = z.lungeT > 0 ? def.lunge : z.speed * (z.slow > 0 ? 0.45 : 1);
          target = Math.min(top, Math.sqrt(2 * def.brake * Math.max(0, dist - reach * 0.7)) + 0.7);
          z.state = target > 2 ? 'run' : 'walk';
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
        if (z.wanderGo) { wishX = z.wander.x; wishZ = z.wander.z; target = Math.min(z.speed, 0.6 * z.gaits.Walk * z.scale); z.state = 'walk'; } else z.state = 'idle';
      }
      // before it notices anything the head drifts about
      const lookOn = !z.aware && (z.state === 'idle' || z.state === 'walk') ? 1 : 0;
      z.lookW += (lookOn - z.lookW) * Math.min(1, dt * 2);
      z.look = Math.sin(this.time * 0.43 + z.seed) * 0.7 * Math.max(0, Math.sin(this.time * 0.17 + z.seed * 1.7) + 0.3);

      if (lap) lap('think');
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
        if (target > 0) tspd = target * (z.wet ? 0.55 : 1) * clamp((Math.cos(dy) - 0.2) / 0.6, 0, 1);
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
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2), push = (rr - d) * (o.def.mass / (z.def.mass + o.def.mass)) * Math.min(1, dt * 7); sx += (ax / d) * push; sz += (az / d) * push;
          // a brute on the move shoulders the small ones out of its way
          if (def.shove && z.spd > 0.8 && o.def.mass < 2 && o.shoveT <= 0 && o.state !== 'attack') { o.shoveT = 1.6; o.aware = true; o.alertT = -1; this._flinch(o, -ax / d, -az / d, 0.6, false); }
        }
      }
      if (z.kickX || z.kickZ) {
        sx += z.kickX * dt; sz += z.kickZ * dt;
        const kd = Math.exp(-dt * 6); z.kickX *= kd; z.kickZ *= kd;
        if (Math.abs(z.kickX) + Math.abs(z.kickZ) < 0.01) z.kickX = z.kickZ = 0;
      }
      z.pos.x += sx; z.pos.z += sz;
      if (lap) lap('steerCrowd');
      // bodies do not overlap the player; the big ones are not pushed aside
      const minD = 0.42 + z.rad;
      if (dist < minD && dist > 1e-3 && p.alive && p.enabled && Math.abs(p.pos.y - z.pos.y) < 1.5) {
        const push = minD - dist, share = def.mass >= 4 ? 0 : 0.5;
        z.pos.x -= (dx / dist) * push * share; z.pos.z -= (dz / dist) * push * share;
        p.pos.x += (dx / dist) * push * (1 - share); p.pos.z += (dz / dist) * push * (1 - share);
      }
      if (!this._contactFree(z)) {
        const c = this.col.resolveCapsule(z.pos, Math.min(z.rad, 0.45), 1.7);
        if (c.lengthSq() > 0) { z.pos.x += c.x; z.pos.z += c.z; }
      }
      z.floorT -= dt;
      if (z.floorT <= 0) { z.floorT = 0.15 + Math.random() * 0.1; z.floorY = this.col.floorAt(z.pos.x, z.pos.y + 0.6, z.pos.z, 2.5); z.wet = this.col.waterDepth(z.pos.x, z.pos.z) > 0.3; }
      const ty = Math.max(z.floorY, T.heightAt(z.pos.x, z.pos.z));
      z.pos.y += (ty - z.pos.y) * Math.min(1, dt * 12);
      if (lap) lap('collide');

      // ---- animation follows the ground actually covered along the facing, so feet stay planted
      const adv = Math.max(0, ((z.pos.x - ox - sx) * hx + (z.pos.z - oz - sz) * hz) / Math.max(dt, 1e-4));
      z.gs += (adv - z.gs) * (1 - Math.exp(-dt * 12));
      if (adv < z.spd * 0.5 && (Math.abs(z.pos.x - sx - ax0) + Math.abs(z.pos.z - sz - az0)) > 1e-6) z.spd = Math.max(adv, z.spd - 25 * dt);   // held up by something solid: stop pushing, no treadmill
      // turning on the spot is done in small steps, never a pirouette on frozen legs
      const busy = z.state === 'attack' || z.state === 'slam' || z.state === 'roar';
      const v = Math.max(z.gs, busy ? 0 : Math.min(Math.abs(z.yawV) * 0.4, 0.45 * z.gaits.Walk) * z.scale);
      this._gait(z, v, dt);
      // lean into turns, a little forward when gathering speed and back when braking; recoil from hits
      const acc = clamp((z.gs - z.gsPrev) / Math.max(dt, 1e-4), -8, 8); z.gsPrev = z.gs;
      z.lean += (clamp(-z.yawV * z.gs * 0.045, -0.15, 0.15) - z.lean) * (1 - Math.exp(-dt * 6));
      z.pitch += (clamp(acc * 0.01, -0.05, 0.06) - z.pitch) * (1 - Math.exp(-dt * 4));
      const rk = Math.exp(-dt * 5); z.recoil *= rk; z.twist *= rk;
      z.root.position.copy(z.pos);
      z.root.rotation.set(z.pitch + z.recoil * 0.13, z.yaw, z.lean);
      if (z.mixer) z.animAcc = Math.min(0.25, z.animAcc + dt);
      if (z.mixer && seen) {
        // small on screen: animated less often (the accumulated time keeps them in step); the
        // apparent distance follows the zoom, and fast movers step one rate finer
        const ad = camD * fovK;
        let every = this.animAll ? 1 : ad < 12 ? 1 : ad < 30 ? 2 : ad < 55 ? 3 : 4;
        if (every > 1 && z.gs > 2.5) every--;
        if (every === 1 || (frame + i) % every === 0) { if (lap) lap('gaitLean'); this._animate(z, z.animAcc, camD < 22); z.animAcc = 0; if (lap) lap('mixer'); }
      }
      if (lap) lap('gaitLean');
    }
  }
}
