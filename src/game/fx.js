// Effects: a pooled particle system (smoke, dust, blood mist, sparks, debris,
// water spray), bullet-hole decals and ejected shell casings.
import * as THREE from 'three';
import { G, GLSL_COMMON, bindShared } from '../engine/shared.js';
import { enhance } from '../engine/materials.js';

const MAX = 900;

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

    this._initDecals();
    this._initCasings();
    this.rnd = Math.random;
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
  }

  // ------------------------------------------------------------ recipes
  impact(point, normal, surface, dirIn) {
    const r = this.rnd;
    const px = point.x + normal.x * 0.03, py = point.y + normal.y * 0.03, pz = point.z + normal.z * 0.03;
    if (surface === 'flesh') { this.blood(point, dirIn); return; }
    if (surface === 'water') {
      for (let i = 0; i < 9; i++) this.spawn({ x: px, y: py, z: pz, vx: (r() - 0.5) * 1.6, vy: 2 + r() * 3.5, vz: (r() - 0.5) * 1.6, size: 0.08 + r() * 0.12, grow: 0.5, life: 0.45 + r() * 0.3, grav: 9, drag: 0.6, r: 0.85, g: 0.9, b: 0.95, a: 0.5 });
      this.spawn({ x: px, y: py + 0.05, z: pz, vy: 0.3, size: 0.35, grow: 1.6, life: 0.7, drag: 2, r: 0.8, g: 0.86, b: 0.9, a: 0.3 });
      return;
    }
    const pal = {
      stone: [0.5, 0.48, 0.45], wood: [0.42, 0.34, 0.26], metal: [0.35, 0.33, 0.31], dirt: [0.3, 0.24, 0.18], grass: [0.3, 0.27, 0.18], gravel: [0.5, 0.47, 0.42],
    }[surface] || [0.5, 0.5, 0.5];
    const soft = surface === 'dirt' || surface === 'grass' || surface === 'gravel';
    // dust burst along the normal
    for (let i = 0; i < (soft ? 5 : 3); i++) {
      const s = 0.8 + r() * 1.8;
      this.spawn({ x: px, y: py, z: pz, vx: normal.x * s + (r() - 0.5) * 0.9, vy: normal.y * s + r() * 0.9, vz: normal.z * s + (r() - 0.5) * 0.9, size: 0.1 + r() * 0.12, grow: 0.7 + r() * 0.6, life: 0.7 + r() * 0.8, drag: 2.6, grav: -0.15, r: pal[0], g: pal[1], b: pal[2], a: soft ? 0.26 : 0.16 });
    }
    // chips / clods
    for (let i = 0; i < (soft ? 7 : 6); i++) {
      const s = 2 + r() * 4;
      this.spawn({ x: px, y: py, z: pz, vx: normal.x * s + (r() - 0.5) * 3, vy: normal.y * s + r() * 2.5, vz: normal.z * s + (r() - 0.5) * 3, size: 0.018 + r() * 0.035, life: 0.6 + r() * 0.7, grav: 11, drag: 0.3, r: pal[0] * 0.7, g: pal[1] * 0.7, b: pal[2] * 0.7, a: 1, add: false, fadeIn: 0.001, ground: true, spin: 20 });
    }
    if (surface === 'metal' || (surface === 'stone' && r() < 0.5)) {
      for (let i = 0; i < (surface === 'metal' ? 8 : 3); i++) {
        const s = 3 + r() * 7;
        this.spawn({ x: px, y: py, z: pz, vx: normal.x * s + (r() - 0.5) * 5, vy: normal.y * s + (r() - 0.3) * 4, vz: normal.z * s + (r() - 0.5) * 5, size: 0.012 + r() * 0.014, life: 0.12 + r() * 0.22, grav: 6, drag: 1, r: 14, g: 8, b: 2.5, a: 1, add: true, fadeIn: 0.001 });
      }
    }
    if (!soft) this.decal(point, normal, surface);
  }

  blood(point, dirIn) {
    const r = this.rnd;
    const dx = dirIn ? dirIn.x : 0, dy = dirIn ? dirIn.y : 0, dz = dirIn ? dirIn.z : 0;
    for (let i = 0; i < 5; i++) {
      const back = r() < 0.4 ? -0.6 : 1;
      const s = (0.6 + r() * 1.6) * back;
      this.spawn({ x: point.x, y: point.y, z: point.z, vx: dx * s + (r() - 0.5) * 0.8, vy: dy * s + r() * 0.6, vz: dz * s + (r() - 0.5) * 0.8, size: 0.1 + r() * 0.1, grow: 0.7, life: 0.35 + r() * 0.35, drag: 3, grav: 1.5, r: 0.16, g: 0.012, b: 0.01, a: 0.75 });
    }
    for (let i = 0; i < 9; i++) {
      const s = 1.5 + r() * 4.5;
      this.spawn({ x: point.x, y: point.y, z: point.z, vx: dx * s + (r() - 0.5) * 2.2, vy: dy * s + r() * 2.2, vz: dz * s + (r() - 0.5) * 2.2, size: 0.016 + r() * 0.028, life: 0.5 + r() * 0.6, grav: 10, drag: 0.4, r: 0.1, g: 0.006, b: 0.005, a: 1, fadeIn: 0.001, ground: true });
    }
  }

  muzzleSmoke(pos, dir) {
    const r = this.rnd;
    for (let i = 0; i < 3; i++) {
      const s = 1.2 + r() * 2.6;
      this.spawn({ x: pos.x + dir.x * 0.1, y: pos.y + dir.y * 0.1, z: pos.z + dir.z * 0.1, vx: dir.x * s + (r() - 0.5) * 0.5, vy: dir.y * s + 0.25 + r() * 0.4, vz: dir.z * s + (r() - 0.5) * 0.5, size: 0.07 + r() * 0.06, grow: 0.75, life: 0.7 + r() * 0.8, drag: 3.2, grav: -0.35, r: 0.62, g: 0.62, b: 0.62, a: 0.2 });
    }
  }

  footDust(x, y, z) {
    const r = this.rnd;
    this.spawn({ x, y: y + 0.05, z, vx: (r() - 0.5) * 0.4, vy: 0.25, vz: (r() - 0.5) * 0.4, size: 0.18, grow: 0.5, life: 0.8, drag: 2, r: 0.45, g: 0.4, b: 0.33, a: 0.1 });
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
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._z = new THREE.Vector3(0, 0, 1); this._pp = new THREE.Vector3();
  }

  decal(point, normal, surface) {
    const size = (surface === 'metal' ? 0.07 : 0.13) * (0.8 + this.rnd() * 0.6);
    this._q.setFromUnitVectors(this._z, normal);
    this._q.multiply(new THREE.Quaternion().setFromAxisAngle(this._z, this.rnd() * 6.283));
    this._pp.copy(point).addScaledVector(normal, 0.012);
    this._m.compose(this._pp, this._q, this._s.set(size, size, size));
    const i = this.decalI % this.decalMax;
    this.decals.setMatrixAt(i, this._m);
    this.decalI++;
    this.decals.count = Math.min(this.decalI, this.decalMax);
    this.decals.instanceMatrix.needsUpdate = true;
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

  // world-space ejection (the view-model shows its own first frames)
  casing(pos, vel) {
    const i = this.caseI++ % this.caseMax;
    this.cs[i] = { p: pos.clone(), v: vel.clone(), q: new THREE.Quaternion().random(), w: new THREE.Vector3((this.rnd() - 0.5) * 40, (this.rnd() - 0.5) * 40, (this.rnd() - 0.5) * 40), rest: false, bounces: 0 };
    this.casings.count = Math.min(this.caseI, this.caseMax);
  }

  _updateCasings(dt) {
    let dirty = false;
    const dq = new THREE.Quaternion(), ax = new THREE.Vector3();
    for (let i = 0; i < this.cs.length; i++) {
      const c = this.cs[i];
      if (!c || c.rest) continue;
      dirty = true;
      c.v.y -= 9.8 * dt;
      c.p.addScaledVector(c.v, dt);
      const wl = c.w.length();
      if (wl > 0.01) { ax.copy(c.w).multiplyScalar(1 / wl); dq.setFromAxisAngle(ax, wl * dt); c.q.premultiply(dq); }
      const gy = this.col.floorAt(c.p.x, c.p.y, c.p.z, 1) + 0.006;
      if (c.p.y < gy) {
        c.p.y = gy;
        if (c.bounces === 0 && this.onCasingLand) this.onCasingLand(c.p);
        c.bounces++;
        c.v.y *= -0.32; c.v.x *= 0.45; c.v.z *= 0.45; c.w.multiplyScalar(0.4);
        if (Math.abs(c.v.y) < 0.35 || c.bounces > 3) { c.rest = true; c.q.setFromEuler(new THREE.Euler(0, this.rnd() * 6.28, 0)); }
      }
      this._m.compose(c.p, c.q, this._s.set(1, 1, 1));
      this.casings.setMatrixAt(i, this._m);
    }
    if (dirty) this.casings.instanceMatrix.needsUpdate = true;
  }
}
