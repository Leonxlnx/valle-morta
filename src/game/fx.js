// Effects: a pooled particle system (smoke, dust, blood mist, sparks, debris,
// water spray), bullet-hole decals, blood splats and pools, ejected shell
// casings and the sniper's bullet trace. Everything is pooled and capped.
import * as THREE from 'three';
import { G, GLSL_COMMON, bindShared } from '../engine/shared.js';
import { enhance } from '../engine/materials.js';

const MAX = 900;
const UP = new THREE.Vector3(0, 1, 0);

const P_VS = /* glsl */`
${GLSL_COMMON}
attribute vec3 iPos;
attribute vec4 iMisc;   // size, rotation, seed, additive
attribute vec4 iColor;  // rgb, alpha
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vWorld;
varying vec2 vMisc;
void main() {
  vUv = position.xy;
  float c = cos(iMisc.y), s = sin(iMisc.y);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iMisc.x;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = iPos + right * q.x + up * q.y;
  vWorld = wp;
  vColor = iColor;
  vMisc = iMisc.zw;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const P_FS = /* glsl */`
${GLSL_COMMON}
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vWorld;
varying vec2 vMisc;
void main() {
  float r = length(vUv) * 2.0;
  if (r > 1.0) discard;
  // wispy, noise-eroded puff
  vec2 nuv = vUv * 0.55 + vec2(vMisc.x * 7.31, vMisc.x * 3.17);
  float n = texture2D(uNoiseTex, nuv).r * 0.6 + texture2D(uNoiseTex, nuv * 2.7).g * 0.4;
  float soft = smoothstep(1.0, 0.25, r);
  float a = vColor.a * soft * mix(smoothstep(0.25, 0.75, n + (1.0 - r) * 0.55), 1.0, vMisc.y);
  if (a < 0.004) discard;
  vec3 lit = vColor.rgb * (vmAmbient(vec3(0.0, 1.0, 0.0)) * 1.2 + uSunColor * vmCloudShadow(vWorld) * 0.22);
  vec3 col = mix(lit, vColor.rgb, vMisc.y);
  col = vmApplyFog(col, cameraPosition, vWorld);
  // premultiplied: additive particles write no alpha
  gl_FragColor = vec4(col * a, a * (1.0 - vMisc.y));
}`;

// a thin screen-space line between two world points (the sniper's bullet trace)
const T_VS = /* glsl */`
uniform vec3 uA; uniform vec3 uB; uniform float uWidth; uniform float uAspect;
varying vec2 vT;
void main() {
  vec4 a = projectionMatrix * viewMatrix * vec4(uA, 1.0);
  vec4 b = projectionMatrix * viewMatrix * vec4(uB, 1.0);
  vec2 sa = a.xy / max(a.w, 1e-3), sb = b.xy / max(b.w, 1e-3);
  vec2 d = (sb - sa) * vec2(uAspect, 1.0);
  d = length(d) > 1e-6 ? normalize(d) : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x) / vec2(uAspect, 1.0);
  vec4 p = mix(a, b, position.x);
  p.xy += n * position.y * uWidth * p.w;
  vT = position.xy;
  gl_Position = p;
}`;
const T_FS = /* glsl */`
uniform float uAlpha; uniform float uTail;
varying vec2 vT;
void main() {
  float a = uAlpha * (1.0 - abs(vT.y)) * smoothstep(uTail, uTail + 0.12, vT.x) * mix(0.3, 1.0, vT.x);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.7, 1.5, 1.2) * a, 1.0);
}`;

export class FX {
  constructor(engine, collision) {
    this.engine = engine;
    this.col = collision;
    this.n = 0;
    this.p = new Float32Array(MAX * 3); this.v = new Float32Array(MAX * 3);
    this.misc = new Float32Array(MAX * 4); this.color = new Float32Array(MAX * 4);
    this.life = new Float32Array(MAX); this.maxLife = new Float32Array(MAX);
    this.grav = new Float32Array(MAX); this.drag = new Float32Array(MAX); this.grow = new Float32Array(MAX);
    this.spin = new Float32Array(MAX); this.alpha0 = new Float32Array(MAX); this.fadeIn = new Float32Array(MAX);
    this.ground = new Uint8Array(MAX);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage);
    this.aMisc = new THREE.InstancedBufferAttribute(this.misc, 4).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iMisc', this.aMisc); geo.setAttribute('iColor', this.aColor);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: P_VS, fragmentShader: P_FS, uniforms: bindShared({}),
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Mesh(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 50;
    engine.scene.add(this.points);

    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._z = new THREE.Vector3(0, 0, 1); this._pp = new THREE.Vector3();
    this._hit = {}; this._d = new THREE.Vector3(); this._nrm = new THREE.Vector3();
    this.rnd = Math.random;
    this._initDecals();
    this._initBlood();
    this._initCasings();
    this._initTracers();
  }

  spawn(o) {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.p[i * 3] = o.x; this.p[i * 3 + 1] = o.y; this.p[i * 3 + 2] = o.z;
    this.v[i * 3] = o.vx || 0; this.v[i * 3 + 1] = o.vy || 0; this.v[i * 3 + 2] = o.vz || 0;
    this.misc[i * 4] = o.size || 0.2; this.misc[i * 4 + 1] = this.rnd() * 6.28; this.misc[i * 4 + 2] = this.rnd(); this.misc[i * 4 + 3] = o.add ? 1 : 0;
    this.color[i * 4] = o.r ?? 1; this.color[i * 4 + 1] = o.g ?? 1; this.color[i * 4 + 2] = o.b ?? 1; this.color[i * 4 + 3] = 0;
    this.alpha0[i] = o.a ?? 0.5; this.life[i] = 0; this.maxLife[i] = o.life || 1;
    this.grav[i] = o.grav ?? 0; this.drag[i] = o.drag ?? 1; this.grow[i] = o.grow ?? 0; this.spin[i] = (this.rnd() - 0.5) * (o.spin ?? 1);
    this.fadeIn[i] = o.fadeIn ?? 0.06; this.ground[i] = o.ground ? 1 : 0;
  }

  update(dt) {
    let i = 0;
    const wind = G.uWind.value;
    while (i < this.n) {
      this.life[i] += dt;
      const t = this.life[i] / this.maxLife[i];
      if (t >= 1) {
        // swap-remove
        const l = --this.n;
        if (l !== i) {
          for (let k = 0; k < 3; k++) { this.p[i * 3 + k] = this.p[l * 3 + k]; this.v[i * 3 + k] = this.v[l * 3 + k]; }
          for (let k = 0; k < 4; k++) { this.misc[i * 4 + k] = this.misc[l * 4 + k]; this.color[i * 4 + k] = this.color[l * 4 + k]; }
          this.life[i] = this.life[l]; this.maxLife[i] = this.maxLife[l]; this.grav[i] = this.grav[l]; this.drag[i] = this.drag[l];
          this.grow[i] = this.grow[l]; this.spin[i] = this.spin[l]; this.alpha0[i] = this.alpha0[l]; this.fadeIn[i] = this.fadeIn[l]; this.ground[i] = this.ground[l];
        }
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      const light = this.grav[i] < 2 ? 1 : 0; // light particles drift with the wind
      this.v[i * 3] = this.v[i * 3] * d + wind.x * wind.z * 0.6 * light * dt;
      this.v[i * 3 + 1] = this.v[i * 3 + 1] * d - this.grav[i] * dt;
      this.v[i * 3 + 2] = this.v[i * 3 + 2] * d + wind.y * wind.z * 0.6 * light * dt;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      if (this.ground[i]) {
        const gy = this.col.terrain.heightAt(this.p[i * 3], this.p[i * 3 + 2]) + 0.01;
        if (this.p[i * 3 + 1] < gy) { this.p[i * 3 + 1] = gy; this.v[i * 3] *= 0.3; this.v[i * 3 + 1] *= -0.25; this.v[i * 3 + 2] *= 0.3; }
      }
      this.misc[i * 4] += this.grow[i] * dt;
      this.misc[i * 4 + 1] += this.spin[i] * dt;
      const fin = Math.min(1, this.life[i] / this.fadeIn[i]);
      this.color[i * 4 + 3] = this.alpha0[i] * fin * (1 - t) * (1 - t * t * 0.5);
      i++;
    }
    this.points.geometry.instanceCount = this.n;
    this.aPos.needsUpdate = this.aMisc.needsUpdate = this.aColor.needsUpdate = true;
    this._updateCasings(dt);
    this._updatePools(dt);
    this._updateTracers(dt);
  }

  // ------------------------------------------------------------ recipes
  // `k` scales the effect with the calibre (pistol < rifle < sniper)
  impact(point, normal, surface, dirIn, k = 1) {
    const r = this.rnd;
    const px = point.x + normal.x * 0.03, py = point.y + normal.y * 0.03, pz = point.z + normal.z * 0.03;
    if (surface === 'flesh') { this.blood(point, dirIn, k); return; }
    const sk = Math.sqrt(k);
    if (surface === 'water') {
      for (let i = 0; i < Math.round(9 * k); i++) this.spawn({ x: px, y: py, z: pz, vx: (r() - 0.5) * 1.6 * sk, vy: (2 + r() * 3.5) * sk, vz: (r() - 0.5) * 1.6 * sk, size: (0.08 + r() * 0.12) * sk, grow: 0.5, life: 0.45 + r() * 0.3, grav: 9, drag: 0.6, r: 0.85, g: 0.9, b: 0.95, a: 0.5 });
      this.spawn({ x: px, y: py + 0.05, z: pz, vy: 0.3, size: 0.35 * sk, grow: 1.6, life: 0.7, drag: 2, r: 0.8, g: 0.86, b: 0.9, a: 0.3 });
      return;
    }
    const pal = {
      stone: [0.5, 0.48, 0.45], wood: [0.42, 0.34, 0.26], metal: [0.35, 0.33, 0.31], dirt: [0.3, 0.24, 0.18], grass: [0.3, 0.27, 0.18], gravel: [0.5, 0.47, 0.42],
    }[surface] || [0.5, 0.5, 0.5];
    const soft = surface === 'dirt' || surface === 'grass' || surface === 'gravel';
    // dust burst along the normal
    for (let i = 0; i < Math.round((soft ? 5 : 3) * k); i++) {
      const s = (0.8 + r() * 1.8) * sk;
      this.spawn({ x: px, y: py, z: pz, vx: normal.x * s + (r() - 0.5) * 0.9, vy: normal.y * s + r() * 0.9, vz: normal.z * s + (r() - 0.5) * 0.9, size: (0.1 + r() * 0.12) * sk, grow: (0.7 + r() * 0.6) * sk, life: (0.7 + r() * 0.8) * sk, drag: 2.6, grav: -0.15, r: pal[0], g: pal[1], b: pal[2], a: soft ? 0.26 : 0.16 });
    }
    // chips / clods
    for (let i = 0; i < Math.round((soft ? 7 : 6) * k); i++) {
      const s = (2 + r() * 4) * sk;
      this.spawn({ x: px, y: py, z: pz, vx: normal.x * s + (r() - 0.5) * 3, vy: normal.y * s + r() * 2.5, vz: normal.z * s + (r() - 0.5) * 3, size: (0.018 + r() * 0.035) * sk, life: 0.6 + r() * 0.7, grav: 11, drag: 0.3, r: pal[0] * 0.7, g: pal[1] * 0.7, b: pal[2] * 0.7, a: 1, add: false, fadeIn: 0.001, ground: true, spin: 20 });
    }
    if (surface === 'metal' || (surface === 'stone' && r() < 0.5 * k)) {
      for (let i = 0; i < Math.round((surface === 'metal' ? 8 : 3) * k); i++) {
        const s = 3 + r() * 7;
        this.spawn({ x: px, y: py, z: pz, vx: normal.x * s + (r() - 0.5) * 5, vy: normal.y * s + (r() - 0.3) * 4, vz: normal.z * s + (r() - 0.5) * 5, size: 0.012 + r() * 0.014, life: 0.12 + r() * 0.22, grav: 6, drag: 1, r: 14, g: 8, b: 2.5, a: 1, add: true, fadeIn: 0.001 });
      }
    }
    if (!soft) this.decal(point, normal, surface, sk);
  }

  blood(point, dirIn, k = 1) {
    const r = this.rnd;
    const dx = dirIn ? dirIn.x : 0, dy = dirIn ? dirIn.y : 0, dz = dirIn ? dirIn.z : 0;
    const sk = Math.sqrt(k);
    for (let i = 0; i < Math.round(5 * k); i++) {
      const back = r() < 0.4 ? -0.6 : 1;
      const s = (0.6 + r() * 1.6) * back * sk;
      this.spawn({ x: point.x, y: point.y, z: point.z, vx: dx * s + (r() - 0.5) * 0.8, vy: dy * s + r() * 0.6, vz: dz * s + (r() - 0.5) * 0.8, size: (0.1 + r() * 0.1) * sk, grow: 0.7, life: 0.35 + r() * 0.35, drag: 3, grav: 1.5, r: 0.16, g: 0.012, b: 0.01, a: 0.75 });
    }
    for (let i = 0; i < Math.round(9 * k); i++) {
      const s = (1.5 + r() * 4.5) * sk;
      this.spawn({ x: point.x, y: point.y, z: point.z, vx: dx * s + (r() - 0.5) * 2.2, vy: dy * s + r() * 2.2, vz: dz * s + (r() - 0.5) * 2.2, size: 0.016 + r() * 0.028, life: 0.5 + r() * 0.6, grav: 10, drag: 0.4, r: 0.1, g: 0.006, b: 0.005, a: 1, fadeIn: 0.001, ground: true });
    }
  }

  // a short burst at the muzzle that the wind takes; `k` scales with the charge
  muzzleSmoke(pos, dir, k = 1) {
    const r = this.rnd;
    for (let i = 0; i < 3; i++) {
      const s = (1.2 + r() * 2.6) * k;
      this.spawn({ x: pos.x + dir.x * 0.1, y: pos.y + dir.y * 0.1, z: pos.z + dir.z * 0.1, vx: dir.x * s + (r() - 0.5) * 0.5, vy: dir.y * s + 0.25 + r() * 0.4, vz: dir.z * s + (r() - 0.5) * 0.5, size: (0.06 + r() * 0.05) * k, grow: 0.75 * k, life: 0.6 + r() * 0.7, drag: 3.2, grav: -0.35, r: 0.62, g: 0.62, b: 0.62, a: 0.17 });
    }
  }

  // a thin thread of smoke curling up from a hot barrel
  wisp(pos) {
    const r = this.rnd;
    this.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: (r() - 0.5) * 0.12, vy: 0.32 + r() * 0.2, vz: (r() - 0.5) * 0.12, size: 0.018 + r() * 0.012, grow: 0.09, life: 0.9 + r() * 0.7, drag: 0.8, grav: -0.12, r: 0.7, g: 0.7, b: 0.7, a: 0.14, fadeIn: 0.12, spin: 2 });
  }

  footDust(x, y, z) {
    const r = this.rnd;
    this.spawn({ x, y: y + 0.05, z, vx: (r() - 0.5) * 0.4, vy: 0.25, vz: (r() - 0.5) * 0.4, size: 0.18, grow: 0.5, life: 0.8, drag: 2, r: 0.45, g: 0.4, b: 0.33, a: 0.1 });
  }

  // ground slam: a ring of dust racing outwards and clods thrown up
  slam(pos, radius) {
    const r = this.rnd, y = pos.y + 0.15;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * 6.283 + r() * 0.2, c = Math.cos(a), s = Math.sin(a), v = radius * (1.1 + r() * 0.5);
      this.spawn({ x: pos.x + c * 0.8, y, z: pos.z + s * 0.8, vx: c * v, vy: 0.5 + r() * 0.9, vz: s * v, size: 0.4 + r() * 0.3, grow: 1.4, life: 1.1 + r() * 0.7, drag: 2.4, grav: -0.1, r: 0.42, g: 0.38, b: 0.32, a: 0.28 });
    }
    for (let i = 0; i < 22; i++) {
      const a = r() * 6.283, v = 2 + r() * 5;
      this.spawn({ x: pos.x + Math.cos(a) * 0.6, y, z: pos.z + Math.sin(a) * 0.6, vx: Math.cos(a) * v, vy: 3 + r() * 5, vz: Math.sin(a) * v, size: 0.03 + r() * 0.05, life: 0.9 + r() * 0.8, grav: 12, drag: 0.3, r: 0.22, g: 0.18, b: 0.14, a: 1, fadeIn: 0.001, ground: true, spin: 14 });
    }
  }

  // ------------------------------------------------------------ decals
  _initDecals() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 2, 64, 64, 60);
    grd.addColorStop(0, 'rgba(8,7,6,1)'); grd.addColorStop(0.16, 'rgba(14,12,10,0.98)'); grd.addColorStop(0.3, 'rgba(60,54,48,0.75)');
    grd.addColorStop(0.55, 'rgba(120,112,100,0.28)'); grd.addColorStop(1, 'rgba(120,112,100,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    // irregular chipped rim
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 46; i++) {
      const a = rnd() * 6.283, d = 14 + rnd() * 26, w = 2 + rnd() * 7;
      g.fillStyle = `rgba(${150 + rnd() * 60 | 0},${145 + rnd() * 55 | 0},${130 + rnd() * 50 | 0},${0.12 + rnd() * 0.3})`;
      g.beginPath(); g.ellipse(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, w, w * (0.4 + rnd() * 0.6), a, 0, 6.283); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = enhance(new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), { key: 'decal' });
    this.decalMax = 160; this.decalI = 0;
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, this.decalMax);
    this.decals.count = 0; this.decals.frustumCulled = false; this.decals.receiveShadow = true; this.decals.renderOrder = 10;
    this.engine.scene.add(this.decals);
  }

  decal(point, normal, surface, k = 1) {
    const size = (surface === 'metal' ? 0.07 : 0.13) * (0.8 + this.rnd() * 0.6) * k;
    this._q.setFromUnitVectors(this._z, normal);
    this._q.multiply(this._q2.setFromAxisAngle(this._z, this.rnd() * 6.283));
    this._pp.copy(point).addScaledVector(normal, 0.012);
    this._m.compose(this._pp, this._q, this._s.set(size, size, size));
    const i = this.decalI % this.decalMax;
    this.decals.setMatrixAt(i, this._m);
    this.decalI++;
    this.decals.count = Math.min(this.decalI, this.decalMax);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ blood on surfaces
  _initBlood() {
    let s = 4711;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const canvas = (draw) => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); draw(g); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
    // spatter: a ragged core, thrown droplets and a few streaks
    const splat = canvas((g) => {
      g.fillStyle = 'rgba(128,9,7,0.96)';
      for (let i = 0; i < 16; i++) { const a = rnd() * 6.283, d = rnd() * 26; g.beginPath(); g.ellipse(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 14 + rnd() * 22, 10 + rnd() * 18, rnd() * 3, 0, 6.283); g.fill(); }
      for (let i = 0; i < 70; i++) {
        const a = rnd() * 6.283, d = 34 + Math.pow(rnd(), 1.6) * 88, w = 1.2 + rnd() * 5 * (1 - d / 130);
        g.fillStyle = `rgba(${112 + rnd() * 30 | 0},8,6,${0.55 + rnd() * 0.4})`;
        g.beginPath(); g.ellipse(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, w * (1.4 + rnd() * 2.2), w, a, 0, 6.283); g.fill();
      }
      g.lineCap = 'round';
      for (let i = 0; i < 9; i++) { const a = rnd() * 6.283, d0 = 20 + rnd() * 20, d1 = d0 + 30 + rnd() * 60; g.strokeStyle = 'rgba(120,8,6,0.8)'; g.lineWidth = 1.5 + rnd() * 3; g.beginPath(); g.moveTo(128 + Math.cos(a) * d0, 128 + Math.sin(a) * d0); g.lineTo(128 + Math.cos(a) * d1, 128 + Math.sin(a) * d1); g.stroke(); }
    });
    // pool: one smooth-edged lobed shape
    const pool = canvas((g) => {
      g.filter = 'blur(3px)';
      g.fillStyle = 'rgba(98,6,5,0.97)';
      g.beginPath();
      for (let i = 0; i <= 48; i++) { const a = (i / 48) * 6.283, rr = 92 + Math.sin(a * 3 + 1.3) * 12 + Math.sin(a * 5 + 0.4) * 7 + Math.sin(a * 2 + 2.2) * 9; const x = 128 + Math.cos(a) * rr, y = 128 + Math.sin(a) * rr; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.closePath(); g.fill();
    });
    const mk = (tex, rough, key, max) => {
      const m = enhance(new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: rough, metalness: 0, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }), { key });
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), m, max);
      mesh.count = 0; mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.renderOrder = 11;
      this.engine.scene.add(mesh);
      return mesh;
    };
    this.splatMax = 96; this.splatI = 0; this.splats = mk(splat, 0.42, 'blood-splat', this.splatMax);
    this.poolMax = 20; this.poolI = 0; this.poolMesh = mk(pool, 0.16, 'blood-pool', this.poolMax);
    this.pools = [];
  }

  // spatter on a wall or the ground
  bloodSplat(point, normal, size) {
    this._q.setFromUnitVectors(this._z, normal);
    this._q.multiply(this._q2.setFromAxisAngle(this._z, this.rnd() * 6.283));
    this._pp.copy(point).addScaledVector(normal, 0.014);
    this._m.compose(this._pp, this._q, this._s.set(size * (0.8 + this.rnd() * 0.5), size, 1));
    this.splats.setMatrixAt(this.splatI % this.splatMax, this._m);
    this.splatI++;
    this.splats.count = Math.min(this.splatI, this.splatMax);
    this.splats.instanceMatrix.needsUpdate = true;
  }

  // a pool that spreads to `radius` over a few seconds; returns its record
  bloodPool(point, normal, radius) {
    const i = this.poolI++ % this.poolMax;
    const p = this.pools[i] || (this.pools[i] = { p: new THREE.Vector3(), q: new THREE.Quaternion(), r: 0, max: 0, done: true });
    p.p.copy(point).addScaledVector(normal, 0.016);
    p.q.setFromUnitVectors(this._z, normal).multiply(this._q2.setFromAxisAngle(this._z, this.rnd() * 6.283));
    p.r = 0.08; p.max = radius; p.done = false; p.i = i;
    this.poolMesh.count = Math.min(this.poolI, this.poolMax);
    return p;
  }

  _updatePools(dt) {
    let dirty = false;
    for (const p of this.pools) {
      if (!p || p.done) continue;
      p.r += (p.max - p.r) * (1 - Math.exp(-dt * 0.45));
      if (p.r > p.max * 0.97) p.done = true;
      this._m.compose(p.p, p.q, this._s.set(p.r * 2, p.r * 2, 1));
      this.poolMesh.setMatrixAt(p.i, this._m);
      dirty = true;
    }
    if (dirty) this.poolMesh.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ casings
  _initCasings() {
    const geo = new THREE.CylinderGeometry(0.0056, 0.0058, 0.039, 8);
    geo.rotateX(Math.PI / 2);
    const mat = enhance(new THREE.MeshStandardMaterial({ color: 0x9a7b3c, roughness: 0.38, metalness: 0.95 }), { key: 'casing' });
    this.caseMax = 48; this.caseI = 0;
    this.casings = new THREE.InstancedMesh(geo, mat, this.caseMax);
    this.casings.count = 0; this.casings.frustumCulled = false; this.casings.castShadow = false;
    this.engine.scene.add(this.casings);
    this.cs = [];
    this.onCasingLand = null;
  }

  // world-space ejection (the view-model shows its own first frames).
  // opts: scale [radius, length] relative to a 7.62x39 case, spin (rad/s)
  casing(pos, vel, opts = {}) {
    const i = this.caseI++ % this.caseMax;
    const c = this.cs[i] || (this.cs[i] = { p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: new THREE.Vector3() });
    const sc = opts.scale || [1, 1], sp = opts.spin ?? 40;
    c.p.copy(pos); c.v.copy(vel); c.q.random();
    c.w.set((this.rnd() - 0.5) * sp, (this.rnd() - 0.5) * sp * 0.5, (this.rnd() - 0.5) * sp);
    c.s.set(sc[0], sc[0], sc[1]); c.r = 0.0058 * sc[0];
    c.rest = false; c.bounces = 0; c.life = 0; c.peak = pos.y; c.i = i;
    this.casings.count = Math.min(this.caseI, this.caseMax);
    return c;
  }

  _updateCasings(dt) {
    let dirty = false;
    const dq = this._q2, ax = this._d, n = this._nrm, T = this.col.terrain;
    for (let i = 0; i < this.cs.length; i++) {
      const c = this.cs[i];
      if (!c || c.rest) continue;
      dirty = true;
      c.life += dt;
      c.v.y -= 9.81 * dt;
      c.v.multiplyScalar(1 - Math.min(0.5, 0.35 * dt));       // tumbling brass loses a little to the air
      const sp = c.v.length();
      // walls and props in the way of this step
      if (sp > 0.6 && c.life > 0.04) {
        ax.copy(c.v).multiplyScalar(1 / sp);
        const h = this.col.raycastMesh(c.p, ax, sp * dt + c.r, this._hit);
        if (h && Math.abs(h.normal.y) < 0.7) {
          const vn = c.v.dot(h.normal);
          c.v.addScaledVector(h.normal, -(1.35 + this.rnd() * 0.15) * vn).multiplyScalar(0.7);
          c.w.multiplyScalar(-0.6);
          if (c.bounces++ === 0 && this.onCasingLand) this.onCasingLand(c.p);
        }
      }
      c.p.addScaledVector(c.v, dt);
      c.peak = Math.max(c.peak, c.p.y);
      const wl = c.w.length();
      if (wl > 0.01) { ax.copy(c.w).multiplyScalar(1 / wl); dq.setFromAxisAngle(ax, wl * dt); c.q.premultiply(dq); }
      const th = T.heightAt(c.p.x, c.p.z);
      const fy = this.col.floorAt(c.p.x, c.p.y, c.p.z, 1) + c.r;
      if (c.p.y < fy) {
        c.p.y = fy;
        if (fy - c.r - th < 0.02) T.normalAt(c.p.x, c.p.z, n); else n.set(0, 1, 0);
        const vn = c.v.dot(n);
        if (vn < 0) {
          // bounce: lose most of the normal speed, scrub the tangential, pick up a new tumble
          const e = 0.28 + this.rnd() * 0.2;
          c.v.addScaledVector(n, -(1 + e) * vn);
          c.v.x *= 0.62; c.v.z *= 0.62;
          const k = Math.min(60, -vn * 22);
          c.w.set((this.rnd() - 0.5) * k, (this.rnd() - 0.5) * k * 0.4, (this.rnd() - 0.5) * k);
          if (c.bounces++ === 0 && this.onCasingLand) this.onCasingLand(c.p);
        }
        if (c.v.lengthSq() < 0.2 || c.bounces > 5) {
          // at rest it lies on its side along the ground
          c.rest = true; c.v.set(0, 0, 0);
          c.q.setFromUnitVectors(UP, n).multiply(dq.setFromAxisAngle(UP, this.rnd() * 6.283));
        }
      }
      this._m.compose(c.p, c.q, c.s);
      this.casings.setMatrixAt(i, this._m);
    }
    if (dirty) this.casings.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ bullet trace
  _initTracers() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.tracers = [];
    this.tracerN = 0;
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: T_VS, fragmentShader: T_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uWidth: { value: 0.0028 }, uAspect: { value: 16 / 9 }, uAlpha: { value: 0 }, uTail: { value: 0 } },
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false; m.visible = false; m.renderOrder = 55;
      this.engine.scene.add(m);
      this.tracers.push({ mesh: m, t: 1, life: 0.24 });
    }
  }

  // a faint streak along the bullet's path that fades from the muzzle forwards
  tracer(from, to) {
    const tr = this.tracers[this.tracerN++ % this.tracers.length];
    const u = tr.mesh.material.uniforms;
    u.uA.value.copy(from); u.uB.value.copy(to);
    tr.t = 0; tr.mesh.visible = true;
  }

  _updateTracers(dt) {
    for (const tr of this.tracers) {
      if (!tr.mesh.visible) continue;
      tr.t += dt;
      const k = tr.t / tr.life, u = tr.mesh.material.uniforms;
      if (k >= 1) { tr.mesh.visible = false; continue; }
      u.uAlpha.value = 0.42 * (1 - k) * (1 - k);
      u.uTail.value = k * 0.7;
      u.uAspect.value = this.engine.camera.aspect;
    }
  }
}
