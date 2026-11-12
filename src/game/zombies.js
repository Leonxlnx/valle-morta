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

// ---------------------------------------------------------------- zombies
export class Zombies {
  constructor(engine, collision, layout, fx, audio, player) {
    this.engine = engine; this.col = collision; this.layout = layout; this.fx = fx; this.audio = audio; this.player = player;
    this.list = [];
    this.pool = [];
    this.template = null;
    this.clips = {}; this.materials = []; this.lods = null;
    this.clipSpeed = { Walk: 0.45, Run: 3.4 };   // ground speed of the clips at time scale 1 (measured on load)
    this.clipInfo = {};
    this.flow = null; this.flowT = 0;
    this.kills = 0;
    this.onKill = null;
    this.onStuck = null;       // (zombie) => void, the director may move it
    this.maxActive = 26;
    this.passive = false;      // nobody notices the player (menu backdrop, tests)
    this.noCull = false;
    this.time = 0;
    this._frustum = new THREE.Frustum(); this._pv = new THREE.Matrix4();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), 3.2);
  }

  async load() {
    let gltf = null;
    try {
      gltf = await new GLTFLoader().loadAsync('./assets/models/zombie.glb');
    } catch (e) {
      console.info('[zombies] zombie.glb missing, using placeholder bodies');
    }
    if (!gltf) { this.template = null; return; }
    this.template = gltf.scene;
    for (const c of gltf.animations) this.clips[c.name] = c;
    const loader = new THREE.TextureLoader();
    const mats = [];
    let base = null, mesh = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !base) { base = o.material; mesh = o; } });
    if (base) {
      mats.push(base);
      for (const f of ['zombie_col_b.jpg', 'zombie_col_c.jpg']) {
        const m = base.clone();
        const t = loader.load(`./assets/models/${f}`, undefined, undefined, () => {});
        t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        m.map = t;
        mats.push(m);
      }
      mats.forEach((m, i) => {
        // skin and cloth are dielectric and matte: no metal, no mirror-like sheen
        m.metalness = 0; m.metalnessMap = null;
        m.roughness = 1; m.envMapIntensity = 0.85;
        if (m.map) m.map.anisotropy = 4;
        enhance(m, { key: 'zombie' }); m.userData.variant = i;
      });
      // coarser meshes for the distance: a crowd of sub-pixel triangles is what costs frame time
      this.lods = LOD_CELL.map((cell) => (cell ? decimate(mesh.geometry, cell) : mesh.geometry));
    }
    this.materials = mats;
    this._measureClips(gltf.scene);
    // build the whole pool up front so nothing is cloned or compiled mid-fight
    for (let i = 0; i < this.maxActive; i++) { const z = this._create(); z.root.visible = false; this.pool.push(z); }
  }

  // Ground speed of the locomotion clips: how fast the supporting foot travels
  // backwards under the body. Playing a clip at (speed / clipSpeed) keeps the
  // feet from sliding.
  _measureClips(scene) {
    const bones = {};
    scene.traverse((o) => { if (o.isBone) bones[key(o.name)] = o; });
    const feet = [bones.FootL, bones.FootR];
    if (!feet[0] || !feet[1]) return;
    const mixer = new THREE.AnimationMixer(scene);
    const lim = { Walk: [0.2, 2.4], Run: [1.5, 7] };
    for (const name of ['Walk', 'Run']) {
      const clip = this.clips[name];
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
      this.clipInfo[name] = { duration: T, median, stride: range / 2, stance, strideSpeed: stance > 0.05 ? range / 2 / (stance * T) : 0 };
      // a walk always has a foot down, so the median is right; a run has flight phases, so only planted samples count
      const speed = stance >= 0.4 || planted <= 0 ? median : back / planted;
      this.clipInfo[name].speed = speed;
      if (speed >= lim[name][0] && speed <= lim[name][1]) this.clipSpeed[name] = speed;
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(scene);
    scene.updateMatrixWorld(true);
  }

  buildNav() {
    const c = this.layout.playCenter || [20, -20];
    this.flow = new FlowField(this.col, this.layout, c[0], c[1]);
  }

  _create() {
    const z = { root: new THREE.Group(), bones: {}, actions: {}, mixer: null, pos: new THREE.Vector3(), vel: new THREE.Vector3(), wander: new THREE.Vector3(1, 0, 0), tilt: new THREE.Quaternion(), lod: 0 };
    if (this.template) {
      const model = SkeletonUtils.clone(this.template);
      model.traverse((o) => {
        if (o.isBone) z.bones[key(o.name)] = o;
        if (o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; z.mesh = o; }
      });
      z.root.add(model);
      z.mixer = new THREE.AnimationMixer(model);
      for (const name in this.clips) {
        const a = z.mixer.clipAction(this.clips[name]);
        if (name.startsWith('Death') || name === 'Attack' || name.startsWith('Hit')) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
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

  // frees the oldest corpse when the list is full
  _recycle() {
    let best = -1, bt = -1;
    for (let i = 0; i < this.list.length; i++) { const z = this.list[i]; if (!z.alive && z.stateT > bt) { bt = z.stateT; best = i; } }
    if (best < 0) return false;
    const z = this.list[best];
    z.root.visible = false;
    this.list.splice(best, 1); this.pool.push(z);
    return true;
  }

  place(z, x, zz) {
    const gy = this.col.terrain.heightAt(x, zz);
    z.pos.set(x, this.col.floorAt(x, gy + 1.0, zz, 2.2), zz);
    z.vel.set(0, 0, 0);
    z.floorY = z.pos.y; z.floorT = 0;
    z.probeX = x; z.probeZ = zz; z.probeT = 0; z.stuck = 0; z.avoidT = 0; z.losT = 0; z.direct = false;
    z.root.position.copy(z.pos);
  }

  spawn(x, z, opts = {}) {
    if (this.list.length >= this.maxActive && !this._recycle()) return null;
    const zb = this.pool.pop() || this._create();
    const runner = opts.runner ?? Math.random() < 0.3;
    this.place(zb, x, z);
    zb.yaw = opts.yaw ?? Math.random() * 6.28;
    zb.state = 'idle'; zb.stateT = 0; zb.health = 100; zb.alive = true;
    zb.runner = runner;
    // speeds stay within what the clips can cover without the feet skating
    const cs = this.clipSpeed;
    zb.speed = opts.speed ?? (runner ? clamp(3.5 + Math.random() * 1.0, cs.Run * 0.8, cs.Run * 1.5) : clamp(0.85 + Math.random() * 0.35, cs.Walk * 0.8, cs.Walk * 2.3));
    zb.aware = opts.aware ?? false;
    zb.attackHit = false; zb.attackCd = 0; zb.slow = 0; zb.groan = 2 + Math.random() * 6; zb.fade = 0; zb.corpseT = 22;
    zb.scale = 0.95 + Math.random() * 0.1;
    zb.root.scale.setScalar(zb.scale);
    zb.root.visible = true;
    zb.wander.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    zb.wanderT = 0; zb.wanderGo = false; zb.seed = Math.random() * 100;
    if (zb.mesh && this.materials.length && zb.mesh.isSkinnedMesh) zb.mesh.material = this.materials[opts.variant ?? Math.floor(Math.random() * this.materials.length)];
    if (zb.mixer) { zb.mixer.stopAllAction(); zb.current = null; zb.currentName = ''; this._play(zb, 'Idle', 0); zb.mixer.update(Math.random() * 2); }
    zb.root.rotation.set(0, zb.yaw, 0);
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
    for (const z of this.list) { z.root.visible = false; this.pool.push(z); }
    this.list.length = 0;
  }

  get aliveCount() { let n = 0; for (const z of this.list) if (z.alive) n++; return n; }

  // nearest zombie hit along a ray -> { zombie, part, mult, distance, point } | null
  raycast(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    for (const z of this.list) {
      if (!z.alive) continue;
      // broad phase: sphere around the body
      _a.set(z.pos.x, z.pos.y + 0.95, z.pos.z).sub(origin);
      const t = _a.dot(dir);
      if (t < -1.2 || t > bestT + 1.2) continue;
      if (_a.lengthSq() - t * t > 1.25 * 1.25) continue;
      if (z.mixer) {
        z.root.updateWorldMatrix(true, true);
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
          const hit = rayCapsule(origin, dir, _a, _b, r * z.scale, bestT);
          if (hit >= 0 && hit < bestT) { bestT = hit; best = { zombie: z, part, mult }; }
        }
      } else {
        _a.set(z.pos.x, z.pos.y + 0.3, z.pos.z); _b.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
        const hit = rayCapsule(origin, dir, _a, _b, 0.3, bestT);
        if (hit >= 0 && hit < bestT) { bestT = hit; const head = origin.y + dir.y * hit > z.pos.y + 1.45; best = { zombie: z, part: head ? 'head' : 'torso', mult: head ? 4 : 1 }; }
      }
    }
    if (!best) return null;
    best.distance = bestT;
    best.point = origin.clone().addScaledVector(dir, bestT);
    return best;
  }

  damage(z, amount, part, dir) {
    if (!z.alive) return;
    z.health -= amount;
    z.aware = true;
    if (z.health <= 0) { this._kill(z, dir, part); return; }
    z.slow = 0.5;
    if (z.state !== 'attack' || part === 'head') {
      z.state = 'hit'; z.stateT = 0;
      this._play(z, part === 'head' ? 'HitHead' : 'HitBody', 0.08, 1, true);
    }
    this.audio?.playAt('zombie_hurt', z.pos, { volume: 0.7, pitchVar: 0.1 });
  }

  _kill(z, dir, part) {
    z.alive = false; z.state = 'dead'; z.stateT = 0; z.fade = 0;
    z.vel.set(0, 0, 0);
    // fall away from the shot
    const fx = Math.sin(z.yaw), fz = Math.cos(z.yaw);
    const fromFront = dir ? dir.x * fx + dir.z * fz < 0 : true;
    this._play(z, fromFront ? 'DeathBack' : 'DeathFront', 0.1, 1 + Math.random() * 0.2, true);
    // the body settles onto the slope it dies on
    const T = this.col.terrain, gy = T.heightAt(z.pos.x, z.pos.z);
    z.hasTilt = z.pos.y - gy < 0.2;
    if (z.hasTilt) z.tilt.setFromUnitVectors(UP, T.normalAt(z.pos.x, z.pos.z, _a));
    this.kills++;
    this.audio?.playAt('zombie_death', z.pos, { volume: 0.9, pitchVar: 0.12 });
    if (this.onKill) this.onKill(z, part);
  }

  // both a knee-high and a chest-high line to the player are free of obstacles
  _clear(z, p) {
    _a.set(z.pos.x, z.pos.y + 0.5, z.pos.z); _b.set(p.pos.x, p.pos.y + 0.5, p.pos.z);
    if (!this.col.lineOfSight(_a, _b)) return false;
    _a.y += 0.8; _b.y += 0.8;
    return this.col.lineOfSight(_a, _b);
  }

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
      const z = this.list[i];
      z.stateT += dt;
      const dx = p.pos.x - z.pos.x, dz = p.pos.z - z.pos.z;
      const dist = Math.hypot(dx, dz);
      this._sphere.center.set(z.pos.x, z.pos.y + 0.9, z.pos.z);
      const seen = this.noCull || this._frustum.intersectsSphere(this._sphere);
      z.root.visible = seen;
      const camD = Math.sqrt(z.pos.distanceToSquared(camPos));
      if (this.lods && seen && z.mesh) {
        const d = camD * fovK;
        let l = z.lod;
        if (z.lodLock !== undefined) l = z.lodLock;        // inspection only
        else {
          while (l < 3 && d > LOD_DIST[l] * 1.1) l++;
          while (l > 0 && d < LOD_DIST[l - 1] * 0.92) l--;
        }
        if (l !== z.lod || z.mesh.geometry !== this.lods[l]) { z.lod = l; z.mesh.geometry = this.lods[l]; }
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
        if (z.stateT > z.corpseT) {
          z.fade += dt;
          z.pos.y -= dt * 0.28;
          z.root.position.y = z.pos.y;
          if (z.fade > 3.2) { z.root.visible = false; this.list.splice(i, 1); this.pool.push(z); continue; }
        }
        if (z.mixer && z.stateT < 5) z.mixer.update(dt);
        continue;
      }
      // awareness: sight / hearing radius
      if (!z.aware && hunting && (dist < 30 || (dist < 90 && p.input.fire && p.enabled))) { z.aware = true; if (dist < 60) this.audio?.playAt('zombie_alert', z.pos, { volume: 0.8, pitchVar: 0.12 }); }
      z.groan -= dt;
      if (z.groan <= 0) { z.groan = 4 + Math.random() * 9; if (dist < 70 && !this.passive) this.audio?.playAt('zombie_idle', z.pos, { volume: 0.55, pitchVar: 0.15 }); }
      z.slow = Math.max(0, z.slow - dt);
      z.avoidT -= dt; z.attackCd -= dt;

      let wishX = 0, wishZ = 0, speed = 0;
      if (z.state === 'attack') {
        const dur = this.clips.Attack ? this.clips.Attack.duration : 0.9;
        if (!z.attackHit && z.stateT > dur * 0.45) {
          z.attackHit = true;
          if (dist < 2.1 && p.alive && Math.abs(p.pos.y - z.pos.y) < 1.8) { p.damage(11 + Math.random() * 6, _a.set(dx, 0, dz).normalize()); this.audio?.play('player_hurt', { volume: 0.9 }); }
        }
        if (z.stateT >= dur) { z.state = 'idle'; z.stateT = 0; z.attackCd = 0.45 + Math.random() * 0.45; }
      } else if (z.state === 'hit') {
        if (z.stateT >= 0.38) { z.state = 'idle'; z.stateT = 0; }
      } else if (z.aware && hunting) {
        const reach = dist < 1.55 && Math.abs(p.pos.y - z.pos.y) < 1.6;
        if (reach && z.attackCd <= 0) {
          z.state = 'attack'; z.stateT = 0; z.attackHit = false;
          this._play(z, 'Attack', 0.12, 1, true);
          this.audio?.playAt('zombie_attack', z.pos, { volume: 0.9, pitchVar: 0.1 });
        } else if (reach && dist < 1.25) {
          z.state = 'idle';                     // gathering itself between swings
        } else {
          // walk straight at the player when the way is clear, otherwise follow the flow field
          z.losT -= dt;
          if (z.losT <= 0) {
            z.losT = 0.35 + Math.random() * 0.3;
            z.direct = dist < 2.5 || (dist < 60 && z.avoidT <= 0 && this._clear(z, p));
          }
          if (!z.direct && this.flow && this.flow.dir(z.pos.x, z.pos.z, _a)) { wishX = _a.x; wishZ = _a.z; } else if (dist > 1e-3) { wishX = dx / dist; wishZ = dz / dist; }
          speed = z.speed * (z.slow > 0 ? 0.45 : 1);
          z.state = z.runner ? 'run' : 'walk';
          // progress probe: stop pushing against something, and tell the director if it never clears
          z.probeT += dt;
          if (z.probeT >= 1.5) {
            const moved = Math.hypot(z.pos.x - z.probeX, z.pos.z - z.probeZ);
            if (moved < 0.2 * z.speed * z.probeT) z.stuck += z.probeT; else z.stuck = 0;
            z.probeX = z.pos.x; z.probeZ = z.pos.z; z.probeT = 0;
            if (z.stuck >= 1.5 && z.direct) { z.avoidT = 5; z.direct = false; }
            if (z.stuck >= 7.5) { z.stuck = 0; if (this.onStuck) this.onStuck(z); }
          }
        }
      } else {
        // idle wandering
        z.wanderT -= dt;
        if (z.wanderT <= 0) { z.wanderT = 3 + Math.random() * 6; z.wander.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(); z.wanderGo = Math.random() < 0.6; }
        if (z.wanderGo) { wishX = z.wander.x; wishZ = z.wander.z; speed = this.clipSpeed.Walk * 1.1; z.state = 'walk'; } else z.state = 'idle';
      }

      if (speed > 0) {
        // separation from neighbours
        for (const o of this.list) {
          if (o === z || !o.alive) continue;
          const ox = z.pos.x - o.pos.x, oz = z.pos.z - o.pos.z;
          const d2 = ox * ox + oz * oz;
          if (d2 < 0.81 && d2 > 1e-4) { const d = Math.sqrt(d2); wishX += (ox / d) * (0.9 - d) * 1.6; wishZ += (oz / d) * (0.9 - d) * 1.6; }
        }
        const l = Math.hypot(wishX, wishZ) || 1;
        wishX /= l; wishZ /= l;
        const water = this.col.waterDepth(z.pos.x, z.pos.z) > 0.3 ? 0.55 : 1;
        const k = 1 - Math.exp(-6 * dt);
        z.vel.x += (wishX * speed * water - z.vel.x) * k;
        z.vel.z += (wishZ * speed * water - z.vel.z) * k;
        const want = Math.atan2(wishX, wishZ);
        let dy = want - z.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        z.yaw += dy * Math.min(1, dt * (z.runner ? 7 : 4.5));
      } else {
        z.vel.x *= Math.exp(-8 * dt); z.vel.z *= Math.exp(-8 * dt);
        if ((z.state === 'attack' || z.state === 'idle') && z.aware && hunting && dist > 0.1) {
          let dy = Math.atan2(dx, dz) - z.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          z.yaw += dy * Math.min(1, dt * 6);
        }
      }
      const ox = z.pos.x, oz = z.pos.z;
      z.pos.x += z.vel.x * dt; z.pos.z += z.vel.z * dt;
      // bodies do not overlap the player
      if (dist < 0.72 && dist > 1e-3 && p.alive && p.enabled && Math.abs(p.pos.y - z.pos.y) < 1.5) {
        const push = (0.72 - dist) * 0.5;
        z.pos.x -= (dx / dist) * push; z.pos.z -= (dz / dist) * push;
        p.pos.x += (dx / dist) * push; p.pos.z += (dz / dist) * push;
      }
      const c = this.col.resolveCapsule(z.pos, 0.3, 1.7);
      if (c.lengthSq() > 0) { z.pos.x += c.x; z.pos.z += c.z; }
      z.floorT -= dt;
      if (z.floorT <= 0) { z.floorT = 0.15 + Math.random() * 0.1; z.floorY = this.col.floorAt(z.pos.x, z.pos.y + 0.6, z.pos.z, 2.5); }
      const ty = Math.max(z.floorY, T.heightAt(z.pos.x, z.pos.z));
      z.pos.y += (ty - z.pos.y) * Math.min(1, dt * 12);

      // animation follows the distance actually covered, so feet stay planted
      if (z.state === 'walk' || z.state === 'run' || z.state === 'idle') {
        const v = Math.hypot(z.pos.x - ox, z.pos.z - oz) / Math.max(dt, 1e-4);
        if (v > 0.15) {
          const clip = z.runner && z.aware && z.state === 'run' ? 'Run' : 'Walk';
          this._play(z, clip, 0.25, clamp(v / (this.clipSpeed[clip] || 1) / z.scale, 0.35, 2.6));
        } else if (speed === 0 || z.stateT > 0.4) this._play(z, 'Idle', 0.3);
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
