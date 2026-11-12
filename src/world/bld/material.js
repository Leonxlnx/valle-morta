// The one material shared by every wall, roof, beam, stone and rubble heap of
// the village: array textures, layer index + masks in vertex attributes.
import * as THREE from 'three';
import { enhance } from '../../engine/materials.js';
import { loadMaterialArrays } from '../../engine/textures.js';
import { LAYERS } from './mb.js';

// rough albedo used while a texture file has not been generated yet
const FALLBACK = {
  plaster_old: [0.60, 0.56, 0.48], plaster_damaged: [0.47, 0.44, 0.38], stone_masonry: [0.34, 0.32, 0.29], stone_blocks: [0.40, 0.38, 0.34],
  roof_tiles: [0.42, 0.19, 0.11], wood_planks: [0.27, 0.21, 0.15], wood_beam: [0.20, 0.145, 0.09], wood_charred: [0.025, 0.024, 0.023],
  rubble: [0.33, 0.30, 0.26], slate_dark: [0.065, 0.07, 0.08], cobblestone: [0.29, 0.28, 0.26],
};

const VERT_PARS = /* glsl */`
attribute vec4 aMat;
attribute vec4 aTint;
varying vec2 vmUv;
varying vec4 vmMat;
varying vec4 vmTint;
`;
const VERT_BEGIN = /* glsl */`
vmUv = uv; vmMat = aMat; vmTint = aTint;
`;

const FRAG_PARS = /* glsl */`
uniform sampler2DArray uBCol;
uniform sampler2DArray uBNrm;
uniform sampler2DArray uBArh;
uniform vec4 uBFb[${LAYERS.length}];
varying vec2 vmUv;
varying vec4 vmMat;
varying vec4 vmTint;
struct VmLayer { vec3 col; vec2 n; float ao; float rough; float h; };
VmLayer vmSample(float idx, vec2 uv, vec2 dx, vec2 dy) {
  VmLayer L;
  L.col = textureGrad(uBCol, vec3(uv, idx), dx, dy).rgb;
  L.n = textureGrad(uBNrm, vec3(uv, idx), dx, dy).xy * 2.0 - 1.0;
  L.n.y = -L.n.y; // array layers are stored top row first
  vec3 a = textureGrad(uBArh, vec3(uv, idx), dx, dy).rgb;
  L.ao = a.r; L.rough = a.g; L.h = a.b;
  vec4 fb = uBFb[int(idx + 0.5)];
  if (fb.a > 0.5) {
    float n = texture2D(uNoiseTex, uv * 2.3).r;
    L.col = fb.rgb * (0.8 + 0.4 * n); L.h = n; L.rough = 0.9;
  }
  return L;
}
void vmBlend(inout VmLayer A, VmLayer B, float w, float sharp) {
  float ha = A.h + (1.0 - w) * 1.2, hb = B.h + w * 1.2;
  float m = max(ha, hb) - sharp;
  float ka = max(ha - m, 0.0), kb = max(hb - m, 0.0);
  float k = kb / (ka + kb + 1e-5);
  k = mix(k, w, 0.15);
  A.col = mix(A.col, B.col, k); A.n = mix(A.n, B.n, k);
  A.ao = mix(A.ao, B.ao, k); A.rough = mix(A.rough, B.rough, k); A.h = mix(A.h, B.h, k);
}
// tangent frame from screen-space derivatives
vec3 vmPerturb(vec3 N, vec2 nxy, vec2 uv) {
  vec3 p = -vViewPosition;
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * du1.x + dp1perp * du2.x;
  vec3 B = dp2perp * du1.y + dp1perp * du2.y;
  float inv = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  return normalize(T * (nxy.x * inv) + B * (nxy.y * inv) + N);
}
float vmBAO = 1.0;
`;

const SURFACE = /* glsl */`
{
  float layer = floor(vmMat.x * 255.0 + 0.5);
  vec2 uv = vmUv;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float dist = length(vmWorldPos - cameraPosition);
  float nA = texture2D(uNoiseTex, uv * 0.31 + 0.13).r;
  vec4 nq = texture2D(uNoiseTex, uv * 1.7 + 0.37);
  float nB = nq.g;
  float nC = nq.a;
  vec3 tint = vmTint.rgb * 1.992;
  float clean = step(10.5, layer);
  if (clean > 0.5) layer = 0.0;
  VmLayer L = vmSample(layer, uv, dx, dy);
  float aoV = vmMat.z;
  if (layer < 0.5) {
    // plastered wall: weathered at the base and in patches, flaked to the
    // rubble core around war damage (vertex mask)
    float hAb = vmTint.a * 18.0 - 2.0;
    float wear = mix(1.0, 0.3, clean);
    float base = smoothstep(1.5, 0.1, hAb + (nB - 0.5) * 1.8) * 0.66;
    float patches = smoothstep(0.5, 0.78, nA * 0.7 + nB * 0.3) * 0.62 * wear;
    float f = max(vmMat.y, max(base, patches));
    float m = f + (nB - 0.5) * 0.55 + (nC - 0.5) * 0.3;
    float w1 = smoothstep(0.22, 0.5, m);
    float w2 = smoothstep(0.58, 0.82, m);
    L.col *= tint * (0.86 + 0.24 * nA);
    if (w1 > 0.004) { VmLayer D = vmSample(1.0, uv, dx, dy); D.col *= mix(vec3(1.0), tint, 0.5); vmBlend(L, D, w1, 0.25); }
    if (w2 > 0.004) { VmLayer M = vmSample(2.0, uv, dx, dy); vmBlend(L, M, w2, 0.18); }
    float damp = smoothstep(0.9, -0.1, hAb + (nB - 0.5) * 0.7);
    L.col *= mix(vec3(1.0), vec3(0.72, 0.71, 0.68), damp);
    aoV *= mix(0.72, 1.0, smoothstep(-0.1, 1.0, hAb));
  } else {
    L.col *= tint;
    if (abs(layer - 4.0) < 0.5) L.col *= mix(vec3(0.72, 0.75, 0.72), vec3(1.1, 1.04, 1.0), smoothstep(0.25, 0.75, nA * 0.6 + nB * 0.4));
  }
  float soot = clamp(vmMat.w * (0.55 + 0.6 * nB), 0.0, 0.95);
  L.col = mix(L.col, L.col * vec3(0.10, 0.095, 0.09), soot);
  L.rough = mix(L.rough, 0.96, soot * 0.6);
  // interiors lie outside the shadow cascade when seen from far away
  L.col *= mix(1.0, 0.45 + 0.55 * smoothstep(0.35, 0.95, vmMat.z), smoothstep(45.0, 80.0, dist));
  vec3 N = normalize(normal);
  float ns = mix(1.25, 0.6, smoothstep(30.0, 220.0, dist));
  normal = vmPerturb(N, L.n * ns, uv);
  diffuseColor.rgb = L.col;
  roughnessFactor = clamp(L.rough, 0.05, 1.0);
  metalnessFactor = 0.0;
  vmBAO = aoV * mix(1.0, L.ao, 0.8);
}`;

export async function makeStructureMaterial(ctx) {
  const q = ctx.quality, base = './assets/tex/';
  const [arr, missing] = await Promise.all([
    loadMaterialArrays(LAYERS, q.texSize, q.aniso),
    Promise.all(LAYERS.map((n) => fetch(`${base}${n}_col.jpg`, { method: 'HEAD' })
      .then((r) => !(r.ok && (r.headers.get('content-type') || '').startsWith('image')))
      .catch(() => true))),
  ]);
  arr.nrm.anisotropy = Math.min(4, q.aniso); arr.arh.anisotropy = Math.min(2, q.aniso);
  const fb = LAYERS.map((n, i) => new THREE.Vector4(...FALLBACK[n], missing[i] ? 1 : 0));
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.shadowSide = THREE.DoubleSide;
  enhance(mat, {
    key: 'vm-structure',
    uniforms: { uBCol: { value: arr.col }, uBNrm: { value: arr.nrm }, uBArh: { value: arr.arh }, uBFb: { value: fb } },
    vertexPars: VERT_PARS,
    vertexBegin: VERT_BEGIN,
    fragmentPars: FRAG_PARS,
    surface: SURFACE,
    ao: 'vmBAO',
  });
  mat.userData.missing = LAYERS.filter((n, i) => missing[i]);
  return mat;
}
