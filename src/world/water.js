// River water: a ribbon following layout.river at waterLevel(s). Clear, fast
// alpine water — depth-based transparency over the pebble bed, flow-aligned
// animated normals, white water in the shallows / around boulders / below the
// broken bridge, sky reflection from the cloud panorama, sun glints.
import * as THREE from 'three';
import { GLSL_COMMON, bindShared } from '../engine/shared.js';

function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// arclength range of the river inside the detailed local terrain
export function riverLocalRange(river) {
  let a = -1, b = -1;
  for (let s = 0; s <= river.length; s += 4) {
    const p = river.at(s);
    if (Math.abs(p[0]) < 522 && Math.abs(p[1]) < 522) { if (a < 0) a = s; b = s; }
  }
  return [Math.max(0, a), b];
}

function smoothTangent(river, s) {
  const a = river.at(s - 3), b = river.at(s + 3);
  let tx = b[0] - a[0], tz = b[1] - a[1];
  const l = Math.hypot(tx, tz) || 1;
  return [tx / l, tz / l];
}

// Deterministic list of boulders in and along the stream. Shared with
// vegetation.js (which renders them) so the foam map knows where they are.
let _rocks = null;
export function getRiverRocks(ctx) {
  if (_rocks) return _rocks;
  const { layout, terrain } = ctx;
  const river = layout.river;
  const rnd = rng32(9917);
  const rocks = [];
  const [s0, s1] = riverLocalRange(river);
  const add = (s, lat, r) => {
    const p = river.at(s);
    const [tx, tz] = smoothTangent(river, s);
    const x = p[0] - tz * lat, z = p[1] + tx * lat;
    const sy = 0.75 + rnd() * 0.4, rot = rnd() * 6.2832, tint = rnd();
    if (Math.abs(x) > 500 || Math.abs(z) > 500) return;
    const far = Math.hypot(x - 20, z + 20) > 380;
    if (far && r < 0.8) return;
    const wl = layout.waterLevel(s);
    const gh = terrain.heightAt(x, z);
    const depth = wl - gh;
    const inStream = depth > 0.03;
    let rr = r;
    let lift = 0.2;
    if (inStream) {
      const need = (depth + 0.12 + rnd() * 0.3) / (0.95 * sy);
      if (need > 2.0) return;
      rr = Math.max(rr, need);
      lift = 0.42;
    }
    rocks.push({ x, z, y: gh + lift * rr * sy, r: rr, sy, rot, tint, tx, tz, inStream, s, lat });
  };
  for (let s = s0 + 3; s < s1 - 3; s += 6.5) {
    const hw = layout.riverHalfWidth(s);
    const nearBridge = Math.exp(-Math.pow((s - layout.sBridge - 9) / 26, 2));
    const cluster = 0.5 + 0.5 * Math.sin(s * 0.047 + 1.3);
    const n = (rnd() < 0.6 + 0.35 * cluster ? 1 : 0) + (rnd() < 0.55 * cluster ? 2 : 0) + (rnd() < nearBridge ? 3 : 0);
    for (let k = 0; k < n; k++) add(s + rnd() * 6, (rnd() * 2 - 1) * hw * 1.02, 0.28 + Math.pow(rnd(), 2.2) * 1.0);
    for (const side of [-1, 1]) {
      if (rnd() < 0.5) add(s + rnd() * 6, side * (hw - 1.2 + rnd() * 6.5), 0.22 + Math.pow(rnd(), 2.0) * 0.95);
    }
  }
  _rocks = rocks;
  return rocks;
}

// tiling gradient (normal) map of a choppy height field: RG = slope, B = height
function makeWaterNormals(size = 256) {
  const rnd = rng32(31337);
  const h = new Float32Array(size * size);
  let amp = 1;
  for (let o = 0; o < 5; o++) {
    const n = 6 << o;
    if (n > size / 2) break;
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const step = size / n;
    for (let y = 0; y < size; y++) {
      const fy = y / step, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x / step, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const a = g[(y0 % n) * n + (x0 % n)], b = g[(y0 % n) * n + ((x0 + 1) % n)];
        const c = g[((y0 + 1) % n) * n + (x0 % n)], d = g[((y0 + 1) % n) * n + ((x0 + 1) % n)];
        const v = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
        // ridged octaves give sharper wavelets
        h[y * size + x] += amp * (o < 2 ? v : 1 - Math.abs(2 * v - 1));
      }
    }
    amp *= 0.55;
  }
  const data = new Uint8Array(size * size * 4);
  let mx = 1e-6;
  const gx = new Float32Array(size * size), gy = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    gx[i] = h[y * size + ((x + 1) % size)] - h[y * size + ((x + size - 1) % size)];
    gy[i] = h[((y + 1) % size) * size + x] - h[((y + size - 1) % size) * size + x];
    mx = Math.max(mx, Math.abs(gx[i]), Math.abs(gy[i]));
  }
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round((gx[i] / mx * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((gy[i] / mx * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round(Math.min(1, h[i] / 2.2) * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// top-down map of white water sources: boulder wakes, bridge rubble
function makeFoamMap(ctx, rocks) {
  const N = 2048;
  const data = new Uint8Array(N * N);
  const splat = (cx, cz, tx, tz, len, wid, amp) => {
    const R = len + wid * 2 + 1;
    const i0 = Math.max(0, Math.floor((cx - R + 512) * 2)), i1 = Math.min(N - 1, Math.ceil((cx + R + 512) * 2));
    const j0 = Math.max(0, Math.floor((cz - R + 512) * 2)), j1 = Math.min(N - 1, Math.ceil((cz + R + 512) * 2));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = -512 + (i + 0.5) * 0.5 - cx, z = -512 + (j + 0.5) * 0.5 - cz;
      const al = x * tx + z * tz, la = -x * tz + z * tx;
      let f;
      const spread = wid * (1 + Math.max(al, 0) / len * 0.9);
      const lk = Math.exp(-(la * la) / (spread * spread));
      const e = (Math.abs(la) - 0.62 * spread) / (0.3 * spread);
      if (al < 0) f = Math.exp(-(al * al) / (wid * wid * 0.8)) * lk;
      else f = Math.pow(Math.max(0, 1 - al / len), 1.4) * (0.4 * lk + 0.75 * Math.exp(-e * e));
      const v = Math.min(255, Math.round(f * amp * 255));
      const k = j * N + i;
      if (v > data[k]) data[k] = v;
    }
  };
  for (const r of rocks) {
    if (!r.inStream) continue;
    const w = 0.75 * r.r + 0.25;
    splat(r.x + r.tx * r.r * 0.2, r.z + r.tz * r.r * 0.2, r.tx, r.tz, 1.6 + 3.2 * r.r, w, 0.85);
  }
  // collapsed span of the bridge: the rubble dam churns the whole channel
  const { layout } = ctx;
  const rnd = rng32(771);
  const sB = layout.sBridge;
  for (let k = 0; k < 16; k++) {
    const s = sB - 3 + rnd() * 9;
    const p = layout.river.at(s);
    const [tx, tz] = smoothTangent(layout.river, s);
    const lat = (rnd() * 2 - 1) * layout.riverHalfWidth(s) * 0.8;
    splat(p[0] - tz * lat, p[1] + tx * lat, tx, tz, 9 + rnd() * 16, 0.9 + rnd() * 1.3, 0.75 + rnd() * 0.25);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const WATER_VS = /* glsl */`
attribute vec4 aFlow;
attribute float aHw;
varying vec3 vWorld;
varying vec4 vFlow;
varying float vHw;
void main() {
  vWorld = position;
  vFlow = aFlow;
  vHw = aHw;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const WATER_FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D uHeightTex;
uniform sampler2D uWaterN;
uniform sampler2D uFoamMap;
uniform sampler2D uPanoA;
uniform sampler2D uPanoB;
uniform float uBlend;
uniform vec3 uBodyCol;
varying vec3 vWorld;
varying vec4 vFlow;
varying float vHw;
const float WPI = 3.14159265;
const float EL0 = -0.0524, EL1 = 1.5708;
vec3 skyRefl(vec3 d) {
  float az = atan(d.z, d.x);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float s = clamp((el - EL0) / (EL1 - EL0), 0.0, 1.0);
  float v = -0.5 + sqrt(0.25 + 2.0 * s);
  vec2 uv = vec2(az / (2.0 * WPI) + 0.5, v);
  return mix(textureLod(uPanoA, uv, 0.0).rgb, textureLod(uPanoB, uv, 0.0).rgb, uBlend);
}
void main() {
  vec2 xz = vWorld.xz;
  if (max(abs(xz.x), abs(xz.y)) > 511.5) discard;
  float bedH = texture2D(uHeightTex, ((xz + 512.0) * 2.0 + 0.5) / 2049.0).r;
  float depth = vWorld.y - bedH;
  if (depth <= 0.0) discard;
  float edge = smoothstep(0.0, 0.05, depth);

  vec2 T = normalize(vFlow.xy);
  vec2 Bn = vec2(-T.y, T.x);
  float l = vFlow.z, s = vFlow.w;
  float lat = abs(l) / vHw;
  float latK = 1.0 - 0.55 * smoothstep(0.35, 1.0, lat);
  float riffle = texture2D(uNoiseTex, vec2(s / 97.0, 0.37)).r;
  float shallow = 1.0 - smoothstep(0.06, 0.5, depth);
  float rockF = texture2D(uFoamMap, (xz + 512.0) / 1024.0).r;
  float rif = smoothstep(0.42, 0.72, riffle);
  float turb = clamp(shallow * 0.7 + rockF * 1.3 + rif * 0.45, 0.0, 1.0);
  float speed = 1.9 * latK * (0.7 + 0.55 * turb);

  vec3 Vv = cameraPosition - vWorld;
  float dist = length(Vv);
  vec3 V = Vv / dist;

  // two-phase flow advection in river coordinates (lateral, along)
  float cyc = 0.45;
  float pn = texture2D(uNoiseTex, vec2(l, s) / 23.0).a;
  float ph = uTime * cyc + pn;
  float p1 = fract(ph), p2 = fract(ph + 0.5);
  float w1 = 1.0 - abs(2.0 * p1 - 1.0), w2 = 1.0 - w1;
  vec2 base = vec2(l, s);
  vec2 adv = vec2(0.0, speed / cyc);
  vec2 q1 = base - adv * (p1 - 0.5);
  vec2 q2 = base - adv * (p2 - 0.5) + vec2(3.7, 11.3);

  vec2 gA = (texture2D(uWaterN, q1 * vec2(0.36, 0.2)).xy - 0.5) * w1 + (texture2D(uWaterN, q2 * vec2(0.36, 0.2)).xy - 0.5) * w2;
  vec2 gB = (texture2D(uWaterN, q1 * vec2(1.35, 0.85) + 0.4).xy - 0.5) * w1 + (texture2D(uWaterN, q2 * vec2(1.35, 0.85) + 0.4).xy - 0.5) * w2;
  // standing waves over the uneven bed do not travel with the flow
  vec2 gS = texture2D(uWaterN, base * vec2(0.52, 0.33) + 0.17).xy - 0.5;
  vec2 g = (gA * 1.5 + gB * 1.1) * mix(0.4, 1.5, turb) + gS * (0.75 + 1.4 * turb);
  g /= 1.0 + dist * 0.008;
  vec2 gw = g.x * Bn + g.y * T;
  vec3 N = normalize(vec3(gw.x, 1.0, gw.y));

  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.97 + 0.03;
  R = normalize(R);
  vec3 sky = skyRefl(R);
  float sunVis = vmCloudShadow(vWorld);
  vec3 amb = vmAmbient(vec3(0.0, 1.0, 0.0));
  // mountains and trees stand all around the valley: low reflection angles are dark
  vec3 hill = amb * 0.2 + uFogColor * 0.1;
  float hk = smoothstep(0.06, 0.3, R.y + (pn - 0.5) * 0.1);
  float bank = smoothstep(0.6, 1.1, lat);
  vec3 refl = mix(hill, sky, hk * (1.0 - 0.65 * bank)) * (1.0 - 0.3 * turb);

  vec3 Hh = normalize(V + uSunDir);
  float nh = max(dot(N, Hh), 0.0);
  float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(V, Hh), 0.0), 5.0);
  vec3 glint = uSunColor * sunVis * Fh * (22.0 * pow(nh, 520.0) + 1.2 * pow(nh, 64.0)) * max(dot(N, uSunDir), 0.0);

  // water body: clear, slightly green; the bed shows through in the shallows
  float path = depth / max(NdV * 0.7 + 0.3, 0.3);
  float tr = exp(-path * 0.58);
  vec3 lightIn = amb + uSunColor * sunVis * max(uSunDir.y, 0.0) / WPI;
  vec3 body = uBodyCol * lightIn * (1.0 - tr);

  // white water
  float stand = texture2D(uNoiseTex, base * vec2(0.11, 0.07) + 0.3).b;
  float fAmt = shallow * 0.5 * latK + rockF * 1.15 + shallow * rif * 0.5 + rif * 0.14
    + smoothstep(0.44, 0.74, stand) * (0.3 + 0.36 * rif) * latK;
  fAmt *= 0.7 + 0.6 * texture2D(uNoiseTex, vec2(l / 6.0, s / 31.0)).g;
  float f1 = texture2D(uNoiseTex, q1 * vec2(0.19, 0.055)).r * w1 + texture2D(uNoiseTex, q2 * vec2(0.19, 0.055)).r * w2;
  float f2 = texture2D(uNoiseTex, q1 * vec2(0.83, 0.27) + 0.5).g * w1 + texture2D(uNoiseTex, q2 * vec2(0.83, 0.27) + 0.5).g * w2;
  float f3 = texture2D(uNoiseTex, q1 * vec2(2.3, 0.71) + 0.2).b * w1 + texture2D(uNoiseTex, q2 * vec2(2.3, 0.71) + 0.2).b * w2;
  float fn = f1 * 0.3 + f2 * 0.36 + f3 * 0.34;
  fAmt = min(fAmt, 0.92);
  float foam = smoothstep(0.80 - fAmt * 0.47, 0.95 - fAmt * 0.42, fn) * clamp(fAmt * 3.0, 0.0, 1.0);
  vec3 foamCol = vec3(0.80, 0.83, 0.84) * lightIn * (0.7 + 0.6 * f2);

  vec3 col = refl * F + glint + body * (1.0 - F);
  float alpha = 1.0 - tr * (1.0 - F);
  col = mix(col, foamCol, foam);
  alpha = mix(alpha, 1.0, foam * 0.94);
  col *= edge; alpha *= edge;

  float Tf = vmFogTransmittance(cameraPosition, vWorld);
  vec3 fogC = vmFogColor(-V);
  gl_FragColor = vec4(col * Tf + fogC * (1.0 - Tf) * alpha, alpha);
}`;

export async function build(ctx) {
  const { layout, terrain, engine, scene } = ctx;
  const river = layout.river;
  const [s0, s1] = riverLocalRange(river);
  const step = 2.0, NL = 14, ext = 6.5;
  const rows = Math.ceil((s1 - s0) / step) + 1;
  const pos = new Float32Array(rows * (NL + 1) * 3);
  const flow = new Float32Array(rows * (NL + 1) * 4);
  const hwA = new Float32Array(rows * (NL + 1));
  let p = 0, f = 0, hk = 0;
  for (let i = 0; i < rows; i++) {
    const s = Math.min(s1, s0 + i * step);
    const c = river.at(s);
    const [tx, tz] = smoothTangent(river, s);
    const hw = layout.riverHalfWidth(s);
    const y = layout.waterLevel(s);
    for (let j = 0; j <= NL; j++) {
      const lat = (j / NL * 2 - 1) * (hw + ext);
      pos[p++] = c[0] - tz * lat; pos[p++] = y; pos[p++] = c[1] + tx * lat;
      flow[f++] = tx; flow[f++] = tz; flow[f++] = lat; flow[f++] = s;
      hwA[hk++] = hw;
    }
  }
  const idx = new Uint32Array((rows - 1) * NL * 6);
  let k = 0;
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < NL; j++) {
    const a = i * (NL + 1) + j, b = a + 1, c = a + NL + 1, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 4));
  geo.setAttribute('aHw', new THREE.BufferAttribute(hwA, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const rocks = getRiverRocks(ctx);
  const dome = engine.sky.domeUniforms;
  const uniforms = bindShared({
    uHeightTex: terrain.uniforms.uHeightTex,
    uWaterN: { value: makeWaterNormals(256) },
    uFoamMap: { value: makeFoamMap(ctx, rocks) },
    uPanoA: dome.uPanoA, uPanoB: dome.uPanoB, uBlend: dome.uBlend,
    uBodyCol: { value: new THREE.Vector3(0.07, 0.21, 0.165) },
  });
  const mat = new THREE.ShaderMaterial({
    vertexShader: WATER_VS, fragmentShader: WATER_FS, uniforms,
    transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = -5;
  mesh.name = 'river-water';
  scene.add(mesh);
  return { mesh, uniforms, rocks };
}
