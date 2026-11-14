// Terrain: the detailed valley (geometry clipmap displaced from a height
// texture, splatted PBR ground materials) and the surrounding mountain range
// (adaptive baked mesh, procedural rock / forest / snow shading).
import * as THREE from 'three';
import { enhance } from '../engine/materials.js';
import { G } from '../engine/shared.js';
import { loadImageData, loadMaterialArrays, loadTexture } from '../engine/textures.js';

export const GROUND_LAYERS = ['grass_ground', 'dirt_mud', 'gravel_road', 'forest_floor', 'rock_limestone', 'riverbed_pebbles', 'rubble', 'cobblestone'];

// Large-scale variation of the meadow, shared by the sward (terrain) and the blades standing on it
// (vegetation): rgb = tint of the base green, a = broken sward (bare soil, stones). The noise
// lookups run at unrelated scales and angles, so nothing repeats inside the map.
export const MEADOW_GLSL = /* glsl */`
#ifndef VM_MEADOW
#define VM_MEADOW
vec4 vmMeadowVar(vec2 wxz) {
  vec2 r = mat2(0.819, -0.574, 0.574, 0.819) * wxz;
  float macro = texture2D(uNoiseTex, wxz / 230.0).r * 0.62 + texture2D(uNoiseTex, r / 613.0 + 0.27).g * 0.38;
  float m2 = texture2D(uNoiseTex, wxz / 53.0 + 0.31).g;
  float m3 = texture2D(uNoiseTex, r / 29.0 + 0.63).r;
  float m4 = texture2D(uNoiseTex, r / 131.0 + 0.47).a;
  // lush dark green where it is damp, yellow-green where it is drier
  vec3 t = mix(vec3(0.70, 0.93, 0.60), vec3(1.18, 1.10, 0.68), smoothstep(0.3, 0.72, macro));
  // clover and sedge: darker, bluer green
  t = mix(t, vec3(0.60, 0.90, 0.66), smoothstep(0.56, 0.78, m2 * 0.7 + m4 * 0.3) * 0.75);
  // straw-coloured tufts of last year's growth
  t = mix(t, vec3(1.50, 1.26, 0.72), smoothstep(0.60, 0.84, m3 * 0.55 + (1.0 - m4) * 0.45) * 0.5);
  float bare = smoothstep(0.69, 0.82, texture2D(uNoiseTex, r / 41.0 + 0.11).a * 0.6 + m3 * 0.4) * smoothstep(0.3, 0.6, macro);
  return vec4(t, bare);
}
#endif
`;

const LAYER_LIB = /* glsl */`
#ifndef VM_FULL_D
#define VM_FULL_D 1e9
#endif
uniform sampler2DArray uTCol;
uniform sampler2DArray uTNrm;
uniform sampler2DArray uTArh;
struct VmLayer { vec3 col; vec2 n; float ao; float rough; float h; };
VmLayer vmSample(float idx, vec2 uv, vec2 dx, vec2 dy) {
  VmLayer L;
  L.col = textureGrad(uTCol, vec3(uv, idx), dx, dy).rgb;
  L.n = textureGrad(uTNrm, vec3(uv, idx), dx, dy).xy * 2.0 - 1.0;
  L.n.y = -L.n.y; // array layers are stored top row first
  vec3 a = textureGrad(uTArh, vec3(uv, idx), dx, dy).rgb;
  L.ao = a.r; L.rough = a.g; L.h = a.b;
  return L;
}
// Stochastic variant: two copies of the tile at unrelated offsets (st.xy, st.zw), chosen by a
// low-frequency index field and blended by k, so that no layer shows its 4 m repeat.
VmLayer vmSampleS(float idx, vec2 uv, vec2 dx, vec2 dy, vec4 st, float k) {
  VmLayer L;
  vec2 ua = uv + st.xy, ub = uv + st.zw;
  vec3 ca = textureGrad(uTCol, vec3(ua, idx), dx, dy).rgb;
  vec3 cb = textureGrad(uTCol, vec3(ub, idx), dx, dy).rgb;
  float m = smoothstep(0.2, 0.8, k - 0.35 * ((ca.r + ca.g + ca.b) - (cb.r + cb.g + cb.b)));
  L.col = mix(ca, cb, m);
  L.n = mix(textureGrad(uTNrm, vec3(ua, idx), dx, dy).xy, textureGrad(uTNrm, vec3(ub, idx), dx, dy).xy, m) * 2.0 - 1.0;
  L.n.y = -L.n.y;
  vec3 a = mix(textureGrad(uTArh, vec3(ua, idx), dx, dy).rgb, textureGrad(uTArh, vec3(ub, idx), dx, dy).rgb, m);
  L.ao = a.r; L.rough = a.g; L.h = a.b;
  return L;
}
// Cheaper variant for the sward, which covers most of the screen: only the colour is taken from
// both copies; normal and relief keep the plain tile (their repeat does not read).
VmLayer vmSampleC(float idx, vec2 uv, vec2 dx, vec2 dy, vec4 st, float k) {
  VmLayer L;
  vec3 ca = textureGrad(uTCol, vec3(uv + st.xy, idx), dx, dy).rgb;
  vec3 cb = textureGrad(uTCol, vec3(uv + st.zw, idx), dx, dy).rgb;
  L.col = mix(ca, cb, smoothstep(0.2, 0.8, k - 0.35 * ((ca.r + ca.g + ca.b) - (cb.r + cb.g + cb.b))));
  L.n = textureGrad(uTNrm, vec3(uv, idx), dx, dy).xy * 2.0 - 1.0;
  L.n.y = -L.n.y;
  vec3 a = textureGrad(uTArh, vec3(uv, idx), dx, dy).rgb;
  L.ao = mix(1.0, a.r, 0.5); L.rough = a.g; L.h = a.b;
  return L;
}
// Distance-switched layer sample for the local ground: the full stochastic pair up to 70 m, beyond
// it the colour pair only (normal and relief of one plain tile are far below a pixel there).
VmLayer vmSampleD(float idx, vec2 uv, vec2 dx, vec2 dy, vec4 st, float k, float dist) {
  // one return path: an early return leaves the result "potentially uninitialized" for HLSL (X4000)
  VmLayer L;
  if (dist < VM_FULL_D) {
    L = vmSampleS(idx, uv, dx, dy, st, k);
  } else {
    L = vmSampleC(idx, uv, dx, dy, st, k);
    L.ao = L.ao * 2.0 - 1.0;   // undo the sward's halved occlusion
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
#ifdef VM_BAKE
  vmSwardK *= 1.0 - k;
#endif
}
float vmTerrainAO = 1.0;
float vmSpec = 1.0;       // scales the dielectric specular (a sward or a forest has next to none)
`;

const LOCAL_VERT_PARS = /* glsl */`
uniform sampler2D uHeightTex;
uniform vec4 uLevel;
float vmTerrH(vec2 xz) {
  vec2 uv = ((xz + 512.0) * 2.0 + 0.5) / 2049.0;
  return texture2D(uHeightTex, uv).r;
}`;
const LOCAL_VERT_BEGIN = /* glsl */`
{
  vec2 gp = position.xz;
  float mk = smoothstep(0.76, 0.955, max(abs(gp.x), abs(gp.y)) / uLevel.w);
  vec2 fr = fract(gp * 0.5) * 2.0;
  vec2 wxz = uLevel.xy + (gp - fr * mk) * uLevel.z;
  wxz = clamp(wxz, vec2(-512.0), vec2(512.0));
  transformed = vec3(wxz.x, vmTerrH(wxz), wxz.y);
}`;

const LOCAL_FRAG_PARS = /* glsl */`
${LAYER_LIB}
uniform sampler2D uMaskA;
uniform sampler2D uMaskB;
uniform sampler2D uMaskC;
uniform sampler2D uLocalN;
uniform vec4 uInner;
uniform float uWetness;
uniform vec3 uMeadow;
uniform float uMeadowAvg;
${MEADOW_GLSL}
`;

const LOCAL_SURFACE = /* glsl */`
{
  vec2 wxz = vmWorldPos.xz;
  float dist = length(vmWorldPos - cameraPosition);
  vec2 muv = (wxz + 512.25) / 1024.0;
  vec3 mA = texture2D(uMaskA, muv).rgb;
  vec3 mB = texture2D(uMaskB, muv).rgb;
  vec3 mC = texture2D(uMaskC, muv).rgb;
  vec4 ln = texture2D(uLocalN, (wxz + 512.0) / 1024.0);
  vec3 N0 = vec3(ln.r * 2.0 - 1.0, 0.0, ln.g * 2.0 - 1.0);
  N0.y = sqrt(max(1.0 - dot(N0.xz, N0.xz), 0.0));
  float slope = 1.0 - N0.y;

  vec2 uv = wxz / 4.0;
  // slightly tightened gradients near the eye: a crisper ground at grazing angles (anisotropic
  // filtering does the rest). Further out the true gradients: a finer mip there only costs bandwidth
  // and adds shimmer.
  float gk = mix(0.75, VM_GK_FAR, smoothstep(25.0, 80.0, dist));
  vec2 dx = dFdx(uv) * gk, dy = dFdy(uv) * gk;
  vec4 mv = vmMeadowVar(wxz);
  float macro2 = texture2D(uNoiseTex, wxz / 53.0 + 0.31).g;
  float fine = texture2D(uNoiseTex, wxz / 9.0 + 0.7).b;
  float fine2 = texture2D(uNoiseTex, wxz.yx / 5.3 + 0.21).g;
  // index field of the stochastic tiling: irregular bands a few metres wide, each with its own
  // offset into the tile
  float sk = (texture2D(uNoiseTex, wxz / 61.0 + 0.19).a * 0.65 + texture2D(uNoiseTex, wxz.yx / 23.0 + 0.71).r * 0.35) * 7.0;
  float si = floor(sk), sf = fract(sk);
  vec4 sOff = vec4(fract(sin(vec2(3.0, 7.0) * si) * 43.7), fract(sin(vec2(3.0, 7.0) * (si + 1.0)) * 43.7));

  // meadow: the 4 m tile near the eye, a rotated larger-scale copy carries the distance. Beyond
  // 95 m the 4 m tile is sub-pixel noise and is no longer sampled (its weight runs out smoothly).
  float farK = smoothstep(16.0, 90.0, dist);
  float farOnly = smoothstep(60.0, 95.0, dist) * VM_FAR_ONLY;
  VmLayer L;
  if (farOnly < 0.999) L = vmSampleC(0.0, uv, dx, dy, sOff, sf);
  if (farK > 0.01) {
    vec2 uv2 = mat2(0.819, -0.574, 0.574, 0.819) * uv * 0.23;
    VmLayer Lf = vmSampleC(0.0, uv2, dx * 0.23, dy * 0.23, sOff * 1.7 + 0.37, sf);
    if (farOnly >= 0.999) L = Lf;
    float kc = mix(farK * 0.8, 1.0, farOnly), kn = mix(farK * 0.6, 1.0, farOnly), kh = mix(farK * 0.5, 1.0, farOnly);
    L.col = mix(L.col, Lf.col, kc); L.n = mix(L.n, Lf.n, kn);
    L.rough = mix(L.rough, Lf.rough, kn); L.h = mix(L.h, Lf.h, kh); L.ao = mix(L.ao, Lf.ao, kh);
  }
  // lush / dry / mossy variation across the meadow
  vec3 tint = mv.rgb;
  {
    // the sward takes the exact green of the grass blades standing on it (same uniform,
    // same tint field); the photo texture only contributes its luminance detail
    float tl = clamp(dot(L.col, vec3(0.3, 0.6, 0.1)) / uMeadowAvg, 0.35, 1.9);
    vec3 sward = uMeadow * tint * mix(1.0, tl, 0.6) * (0.92 + 0.16 * fine);
    // seen between the stems close up, as a closed canopy from afar
    sward *= mix(0.86, 1.26, smoothstep(5.0, 70.0, dist));
    // buttercup drifts stay visible beyond the range of the flower sprites
    float drift = smoothstep(0.5, 0.66, texture2D(uNoiseTex, wxz / 43.0 + 0.57).a * 0.75 + fine * 0.25);
    sward = mix(sward, sward * vec3(1.55, 1.38, 0.55), drift * 0.3 * smoothstep(18.0, 40.0, dist));
    L.col = mix(sward, L.col * tint, 0.15);
    L.rough = 1.0;
  }

  // forest floor under the conifers
  float wF = mC.r * smoothstep(0.25, 0.6, macro2 * 0.6 + mC.r * 0.7);
  if (wF > 0.035) vmBlend(L, vmSampleD(3.0, uv, dx, dy, sOff, sf, dist), wF, 0.3);
  // bedrock where the ground is steep
  float wR = smoothstep(0.24, 0.42, slope + (macro2 - 0.5) * 0.16 + (fine - 0.5) * 0.08);
  if (wR > 0.035) {
    vec2 ru = wxz / 6.0; vmBlend(L, vmSample(4.0, ru, dx * 0.667, dy * 0.667), wR, 0.2);
    // moss in patches on the damp rock
    L.col = mix(L.col, uMeadow * vec3(1.15, 1.3, 0.62), wR * smoothstep(0.5, 0.72, macro2 * 0.55 + fine * 0.45) * 0.55);
  }
  // bare earth, mud
  // churned earth is half regrown: soil only shows where the grass stands thin (same noise as the blades)
  float thin = smoothstep(0.62, 0.3, texture2D(uNoiseTex, wxz / 17.0 + 0.13).b);
  float wM = smoothstep(0.25, 0.8, mA.g * (0.75 + 0.6 * macro2)) * mix(1.0, thin, 0.85);
  // noise-placed breaks in the sward: bare soil, and stones lying in some of them
  float bare = mv.a * (1.0 - wF) * (1.0 - wR);
  wM = max(wM, bare * 0.75);
  if (wM > 0.035) vmBlend(L, vmSampleD(1.0, uv, dx, dy, sOff, sf, dist), wM, 0.22);
  float wSt = bare * smoothstep(0.5, 0.68, fine2);
  if (wSt > 0.035) vmBlend(L, vmSampleD(5.0, uv * 1.37, dx * 1.37, dy * 1.37, sOff.yxwz, sf, dist), wSt, 0.3);
  // dirt road
  float wRoad = mA.r;
  if (wRoad > 0.035) vmBlend(L, vmSampleD(2.0, uv, dx, dy, sOff, sf, dist), wRoad, 0.18);
  // cobbled streets
  float wC = mB.g;
  if (wC > 0.035) vmBlend(L, vmSample(7.0, uv, dx, dy), wC, 0.14);
  // rubble aprons around ruined buildings
  float wRb = mA.b;
  if (wRb > 0.035) vmBlend(L, vmSampleD(6.0, uv, dx, dy, sOff, sf, dist), wRb, 0.25);
  // river bed
  float wBed = mB.r;
  if (wBed > 0.035) vmBlend(L, vmSampleD(5.0, uv, dx, dy, sOff, sf, dist), wBed, 0.2);

  // rain-soaked ground and standing water
  float wet = mB.b;
  // the ground is not evenly wet: damp hollows and drier rises across the valley floor
  float wetVar = smoothstep(0.3, 0.75, texture2D(uNoiseTex, wxz / 147.0 + 0.83).b);
  float damp = clamp(uWetness * (0.2 + 1.5 * wetVar) * (0.55 + 0.6 * (1.0 - L.h)) + wet * 0.8 + wBed * 0.8, 0.0, 1.0);
  float puddle = smoothstep(0.42, 0.62, wet * 1.15 - L.h * 0.35);
  L.col *= mix(1.0, 0.52, damp * (1.0 - 0.3 * wC));
  L.rough = mix(L.rough, L.rough * 0.55, damp);
  L.rough = mix(L.rough, 0.035, puddle);
  L.col = mix(L.col, L.col * 0.55, puddle);
  L.n *= 1.0 - puddle;

  // fine grit close to the eye, where the 4 m tiles run out of texels
  float nearK = 1.0 - smoothstep(4.0, 14.0, dist);
  if (nearK > 0.01) {
    vec2 gn = textureGrad(uTNrm, vec3(uv * 7.3, 2.0), dx * 7.3, dy * 7.3).xy * 2.0 - 1.0;
    L.n += vec2(gn.x, -gn.y) * 0.5 * nearK * (1.0 - puddle);
  }
  float nStrength = mix(1.35, 0.55, smoothstep(40.0, 260.0, dist));
  vec3 Nw = normalize(vec3(N0.x - L.n.x * nStrength * N0.y, N0.y, N0.z - L.n.y * nStrength * N0.y));
  normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
  diffuseColor.rgb = L.col;
  roughnessFactor = clamp(L.rough, 0.03, 1.0);
  metalnessFactor = 0.0;
  float cav = smoothstep(0.22, 0.55, ln.b);
  vmTerrainAO = mix(1.0, L.ao, 0.8) * mix(0.55, 1.0, cav);
  vmSpec = clamp(max(max(wM, wRoad), max(max(wC, wRb), max(wBed, wR))) + puddle + wet, 0.12, 1.0);
}`;

const FAR_FRAG_PARS = /* glsl */`
${LAYER_LIB}
uniform sampler2D uFarN;
uniform float uFarSize;
`;

const FAR_SURFACE = /* glsl */`
{
  vec2 wxz = vmWorldPos.xz;
  float h = vmWorldPos.y;
  vec4 fn = texture2D(uFarN, (wxz + uFarSize * 0.5) / uFarSize);
  vec3 N0 = vec3(fn.r * 2.0 - 1.0, 0.0, fn.g * 2.0 - 1.0);
  N0.y = sqrt(max(1.0 - dot(N0.xz, N0.xz), 0.0));
  float slope = 1.0 - N0.y;
  float flow = fn.b;
  float n1 = texture2D(uNoiseTex, wxz / 2300.0).r;
  float n2 = texture2D(uNoiseTex, wxz / 410.0 + 0.2).g;
  float n3 = texture2D(uNoiseTex, wxz / 61.0 + 0.6).b;

  // limestone, true triplanar: the walls never show a stretched, striped projection
  vec2 sw = N0.xz * N0.xz; sw /= max(sw.x + sw.y, 1e-4);
  float sideK = smoothstep(0.2, 0.48, slope);
  vec3 wgt = vec3(sw.x * sideK, 1.0 - sideK, sw.y * sideK);
  vec2 uvT = wxz / 104.0;
  vec2 uvX = vec2(wxz.y, h * 1.1) / 128.0;
  vec2 uvZ = vec2(wxz.x, h * 1.1) / 128.0 + 0.37;
  vec3 rock = texture(uTCol, vec3(uvX, 4.0)).rgb * wgt.x + texture(uTCol, vec3(uvT, 4.0)).rgb * wgt.y + texture(uTCol, vec3(uvZ, 4.0)).rgb * wgt.z;
  float rl = dot(rock, vec3(0.3333));
  // pale dolomite: lifted, slightly desaturated, drifting between cool grey and warm cream
  rock = mix(vec3(rl), rock, 0.7) * 0.58;
  vec2 rw = mat2(0.819, -0.574, 0.574, 0.819) * wxz;
  float c1 = texture2D(uNoiseTex, rw / 97.0 + 0.11).a;
  float can = n3 * 0.5 + c1 * 0.5;
  rock *= mix(vec3(0.94, 0.97, 1.03), vec3(1.07, 1.0, 0.9), smoothstep(0.3, 0.7, n2));
  rock *= 0.8 + 0.4 * smoothstep(0.25, 0.75, texture2D(uNoiseTex, rw / 730.0).g * 0.6 + n2 * 0.4);
  // dark weathering streaks running down the walls (noise stretched along the fall line)
  float st = mix(texture2D(uNoiseTex, vec2(wxz.y / 330.0, h / 1100.0)).r, texture2D(uNoiseTex, vec2(wxz.x / 330.0, h / 1100.0) + 0.43).r, sw.y);
  float streak = smoothstep(0.3, 0.7, st * 0.7 + n2 * 0.3);
  rock *= mix(1.0, 0.76 + 0.24 * streak, sideK);
  rock *= mix(0.84, 1.0, smoothstep(0.0, 0.35, flow + can * 0.3));   // damp gullies

  vec3 scree = vec3(0.37, 0.36, 0.335) * (0.85 + 0.3 * n3);
  vec3 meadow = mix(vec3(0.07, 0.10, 0.034), vec3(0.125, 0.122, 0.052), n2) * (0.8 + 0.4 * n3);
  vec3 forest = mix(vec3(0.016, 0.03, 0.017), vec3(0.03, 0.046, 0.021), n2) * (0.72 + 0.56 * can);
  vec3 snowC = vec3(0.84, 0.87, 0.93);

  float treeline = 1080.0 + 380.0 * (n1 - 0.5) + 120.0 * (n2 - 0.5);
  float rockK = smoothstep(0.24, 0.42, slope + 0.14 * (n2 - 0.5) + 0.05 * (n3 - 0.5));
  float alpine = smoothstep(treeline - 60.0, treeline + 520.0, h);
  vec3 col = mix(meadow, scree, alpine);
  col = mix(col, rock, max(rockK, alpine * 0.5));
  float forestK = smoothstep(treeline + 70.0, treeline - 160.0, h) * smoothstep(0.66, 0.44, slope) * smoothstep(0.16, 0.34, n2 * 0.55 + n3 * 0.45 + 0.12);
  // keep the flat valley floor around the village as open meadow
  forestK *= smoothstep(8.0, 34.0, h + 30.0 * (n3 - 0.5));
  col = mix(col, forest, forestK);
  // snow lies in the gullies and on ledges; the walls themselves stay bare
  float snowline = 1700.0 + 380.0 * (n1 - 0.5);
  float sAlt = smoothstep(snowline - 320.0, snowline + 560.0, h + 380.0 * flow + 180.0 * (n3 - 0.5));
  float hold = smoothstep(0.36, 0.10, slope - 0.24 * flow + 0.4 * (can - 0.5) + 0.22 * (n2 - 0.5) + 0.12 * (1.0 - streak) * sideK);
  float snow = clamp(sAlt * hold * 1.35, 0.0, 1.0) * (1.0 - forestK);
  col = mix(col, snowC, snow);

  float bump = mix(1.15 * (1.0 - forestK), 0.2, snow);
  vec3 Nw = normalize(N0 + vec3(c1 - 0.5, 0.0, n3 - 0.5) * 0.45 * bump);
  // canopy roughness on forested slopes
  Nw = normalize(Nw + forestK * vec3(c1 - 0.5, 0.0, n3 - 0.5) * 0.45);
  normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
  diffuseColor.rgb = col;
  roughnessFactor = mix(0.95, 0.6, snow);
  metalnessFactor = 0.0;
  vmSpec = mix(mix(0.5, 0.12, forestK), 1.0, snow);
  vmTerrainAO = mix(1.0, 0.62, forestK) * mix(0.8, 1.0, smoothstep(0.0, 0.5, flow + 0.35)) * mix(1.0, 0.8 + 0.2 * streak, sideK * (1.0 - snow));
}`;

// physical lighting chunk with a scalable dielectric specular (see vmSpec)
const SPEC_CHUNK = THREE.ShaderChunk.lights_physical_fragment
  .replace('material.specularColor = vec3( 0.04 );', 'material.specularColor = vec3( 0.04 * vmSpec );')
  .replaceAll('material.specularF90 = 1.0;', 'material.specularF90 = vmSpec;');

// ---- ground cache
// The layered ground (8 materials, stochastic tiling, height blends: 20 to 30 texture probes per
// pixel) is rendered into camera-centred square cascades instead of per screen pixel every frame:
//   C0  20.5 m square, follows the camera in 0.64 m steps
//   C1  82 m square, 2.56 m steps
//   C2  328 m square, 10.24 m steps
//   C3  the whole 1024 m valley, baked once; distance terms baked in
// Resolution per preset (CACHE_RES): high/ultra 2048^2 (C0 1 cm texels); medium halves C1..C3,
// low halves all. (C0 at 4096^2 was tried: the bake of a walking step then costs too much.)
// Each cascade is one RGBA8 2D array texture (layers A, B, C), 16x anisotropic.
// Streaming without hitches: a step is baked as a job of slices spread over frames (a pixel budget
// per frame) while the screen keeps sampling the old centre, which only moves once the job is done.
// The used square is one step smaller than the stored one, so the strip being overwritten is never
// on screen. Every mip level is baked directly (the bake shader is prefiltered by its own
// derivatives), so there is no generateMipmap of the whole chain after each step.
// A camera jump (spawn, teleport, film cut) refills synchronously.
// Within 5 m of the eye the full material still runs per pixel (see the near patch below).
// The moving cascades are toroidal (repeat-wrapped): a step re-renders only the strip that came
// into range, and the screen shader takes 3 filtered fetches per cascade (two cascades in the
// blend bands). What depends on the distance to the eye (the sward getting brighter as a closed
// canopy, the buttercup tint, the normal strength) is applied when sampling, from
// the stored sward fraction; the near/far tile mix and the cheap-layer switch are per cascade.
//   target A: sqrt(albedo), sward fraction (C3: ao)    B: normal xy, roughness, specular    C: ao, sward*drift
// [C0, C1, C2, C3] texels per side
const CACHE_RES = { low: [1024, 1024, 1024, 1024], medium: [2048, 1024, 1024, 1024], high: [2048, 2048, 2048, 2048], ultra: [2048, 2048, 2048, 2048] };
// level-0 texels baked per frame while streaming (doubled when the camera nears the used edge)
// Cache on or off (off: the full per-pixel ground everywhere, as before the cache):
// URL ?gcache=0|1 first, then the quality key groundCache, then this per-preset default.
const CACHE_DEFAULT = { low: true, medium: true, high: true, ultra: true };
function cacheEnabled(engine) {
  try { const p = new URLSearchParams(location.search).get('gcache'); if (p === '0' || p === '1') return p === '1'; } catch (e) { /* no location */ }
  if (engine.q && typeof engine.q.groundCache === 'boolean') return engine.q.groundCache;
  return CACHE_DEFAULT[engine.qualityName] ?? true;
}
const CACHE_BUDGET = { low: 1 << 14, medium: 1 << 14, high: 1 << 15, ultra: 1 << 15 };
// bake: [distance for the cheap-layer switch, near/far tile mix, far-only, far constants baked in]
const CASCADES = [
  { size: 20.48, step: 0.64, bake: [5, 0.0, 0.0, 0], band: 2.5, edge: 0.15 },
  { size: 81.92, step: 2.56, bake: [25, 0.12, 0.0, 0], band: 8, edge: 0.5 },
  { size: 327.68, step: 10.24, bake: [60, 0.75, 0.6, 0], band: 24, edge: 2.0 },
];
const swap = (src, pairs) => pairs.reduce((s, [a, b]) => {
  if (!s.includes(a)) throw new Error('terrain cache: shader text not found: ' + a.slice(0, 50));
  return s.replace(a, b);
}, src);
const BAKE_SURFACE = swap(LOCAL_SURFACE.slice(0, LOCAL_SURFACE.indexOf('  // fine grit close to the eye')), [
  ['float dist = length(vmWorldPos - cameraPosition);', 'float dist = uBake.x;'],
  ['float gk = mix(0.75, VM_GK_FAR, smoothstep(25.0, 80.0, dist));', 'float gk = 1.0;'],
  ['float farK = smoothstep(16.0, 90.0, dist);', 'float farK = uBake.y;'],
  ['float farOnly = smoothstep(60.0, 95.0, dist) * VM_FAR_ONLY;', 'float farOnly = uBake.z * VM_FAR_ONLY;'],
  // beyond 70 m (the valley-wide cascade) both are constant and baked in
  ['sward *= mix(0.86, 1.26, smoothstep(5.0, 70.0, dist));', 'sward *= mix(1.0, 1.26, uBake.w);'],
  ['sward = mix(sward, sward * vec3(1.55, 1.38, 0.55), drift * 0.3 * smoothstep(18.0, 40.0, dist));', 'vmDrift = drift; sward = mix(sward, sward * vec3(1.55, 1.38, 0.55), drift * 0.3 * uBake.w);'],
  ['L.col = mix(sward, L.col * tint, 0.15);', 'L.col = mix(sward, L.col * tint, 0.15); vmSwardK = 1.0;'],
]) + /* glsl */`
  // fine grit (C0 only; on screen it fades out between 4 and 14 m)
  if (uBake.x < 10.0) {
    vec2 gn = textureGrad(uTNrm, vec3(uv * 7.3, 2.0), dx * 7.3, dy * 7.3).xy * 2.0 - 1.0;
    L.n += vec2(gn.x, -gn.y) * 0.5 * 0.6 * (1.0 - puddle);
  }
  o0 = vec4(sqrt(max(L.col, 0.0)), uBake.w > 0.5 ? mix(1.0, L.ao, 0.8) : vmSwardK);
  o1 = vec4(clamp(L.n * 0.5 + 0.5, 0.0, 1.0), clamp(L.rough, 0.0, 1.0), clamp(max(max(wM, wRoad), max(max(wC, wRb), max(wBed, wR))) + puddle + wet, 0.12, 1.0));
  o2 = vec4(mix(1.0, L.ao, 0.8), vmSwardK * vmDrift, 0.0, 1.0);
}`;
const BAKE_VERT = /* glsl */`
precision highp float;
in vec3 position;
uniform vec4 uDst;
uniform vec4 uSrc;
out vec2 vW;
void main() {
  vec2 t = position.xy * 0.5 + 0.5;
  vW = mix(uSrc.xy, uSrc.zw, t);
  gl_Position = vec4(mix(uDst.xy, uDst.zw, t), 0.0, 1.0);
}`;
const bakeFrag = (defs) => /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2DArray;
#define texture2D texture
${defs}
uniform sampler2D uNoiseTex;
uniform vec4 uBake;
in vec2 vW;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
float vmDrift = 0.0;
float vmSwardK = 1.0;
${LOCAL_FRAG_PARS}
void main() {
  vec3 vmWorldPos = vec3(vW.x, 0.0, vW.y);
${BAKE_SURFACE}
}`;
const CACHE_FRAG_PARS = /* glsl */`
#ifndef VM_NEAR
uniform sampler2D uLocalN;
#endif
uniform highp sampler2DArray uC0;
#ifndef VM_NEAR
uniform highp sampler2DArray uC1;
uniform highp sampler2DArray uC2;
uniform highp sampler2DArray uC3;
#endif
uniform vec4 uCasc0;     // centre xz, blend band start / end (Chebyshev distance)
uniform vec4 uCasc1;
uniform vec4 uCasc2;
uniform vec4 uCascInv;   // 1 / square size of C0, C1, C2, C3
#ifndef VM_NEAR
float vmTerrainAO = 1.0;
float vmSpec = 1.0;
#endif
void vmFetch(highp sampler2DArray t, vec2 uv, vec2 gx, vec2 gy, float w, inout vec4 A, inout vec4 B, inout vec4 C) {
  A += textureGrad(t, vec3(uv, 0.0), gx, gy) * w;
  B += textureGrad(t, vec3(uv, 1.0), gx, gy) * w;
  C += textureGrad(t, vec3(uv, 2.0), gx, gy) * w;
}`;
const CACHE_SURFACE = /* glsl */`
{
  vec2 wxz = vmWorldPos.xz;
  float dist = length(vmWorldPos - cameraPosition);
  vec4 ln = texture2D(uLocalN, (wxz + 512.0) / 1024.0);
  vec3 N0 = vec3(ln.r * 2.0 - 1.0, 0.0, ln.g * 2.0 - 1.0);
  N0.y = sqrt(max(1.0 - dot(N0.xz, N0.xz), 0.0));
  vec2 gx = dFdx(wxz), gy = dFdy(wxz);
  vec2 d0 = abs(wxz - uCasc0.xy), d1 = abs(wxz - uCasc1.xy), d2 = abs(wxz - uCasc2.xy);
  float w0 = 1.0 - smoothstep(uCasc0.z, uCasc0.w, max(d0.x, d0.y));
  float w1 = (1.0 - w0) * (1.0 - smoothstep(uCasc1.z, uCasc1.w, max(d1.x, d1.y)));
  float w2 = (1.0 - w0 - w1) * (1.0 - smoothstep(uCasc2.z, uCasc2.w, max(d2.x, d2.y)));
  float w3 = 1.0 - w0 - w1 - w2;
  vec4 A = vec4(0.0), B = vec4(0.0), C = vec4(0.0);
  if (w0 > 0.0) vmFetch(uC0, wxz * uCascInv.x, gx * uCascInv.x, gy * uCascInv.x, w0, A, B, C);
#ifdef VM_NEAR
  A /= max(w0, 1e-4); B /= max(w0, 1e-4); C /= max(w0, 1e-4);   // the near patch lies inside C0
#else
  if (w1 > 0.0) vmFetch(uC1, wxz * uCascInv.y, gx * uCascInv.y, gy * uCascInv.y, w1, A, B, C);
  if (w2 > 0.0) vmFetch(uC2, wxz * uCascInv.z, gx * uCascInv.z, gy * uCascInv.z, w2, A, B, C);
  if (w3 > 0.0) {
    // valley-wide cascade: albedo + ao, the distance terms are baked in (sward fraction 0)
    vec2 uv3 = (wxz + 512.0) * uCascInv.w, g3x = gx * uCascInv.w, g3y = gy * uCascInv.w;
    vec4 a3 = textureGrad(uC3, vec3(uv3, 0.0), g3x, g3y);
    A.rgb += a3.rgb * w3; C.r += a3.a * w3;
    B += textureGrad(uC3, vec3(uv3, 1.0), g3x, g3y) * w3;
  }
#endif
  vec3 col = A.rgb * A.rgb;
  // the sward reads as a closed, brighter canopy from afar, with buttercup drifts beyond the flower sprites
  float swD = mix(0.86, 1.26, smoothstep(5.0, 70.0, dist));
  col *= 1.0 + 0.85 * (A.a * (swD - 1.0) + swD * 0.3 * smoothstep(18.0, 40.0, dist) * C.g * vec3(0.55, 0.38, -0.45));
  vec2 Ln = B.xy * 2.0 - 1.0;
  float rough = B.z;
  // (the fine grit is in the near patch and baked into C0)
  float nStrength = mix(1.35, 0.55, smoothstep(40.0, 260.0, dist));
  vec3 Nw = normalize(vec3(N0.x - Ln.x * nStrength * N0.y, N0.y, N0.z - Ln.y * nStrength * N0.y));
  normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
  diffuseColor.rgb = col;
  roughnessFactor = clamp(rough, 0.03, 1.0);
  metalnessFactor = 0.0;
  float cav = smoothstep(0.22, 0.55, ln.b);
  vmTerrainAO = C.r * mix(0.55, 1.0, cav);
  vmSpec = B.w;
}`;

function decode16(img, lo, hi) {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  const k = (hi - lo) / 65535;
  for (let i = 0; i < n; i++) out[i] = lo + (d[i * 4] * 256 + d[i * 4 + 1]) * k;
  return out;
}

export class Terrain {
  static async load(engine, onProgress = () => {}) {
    const t = new Terrain();
    const base = './assets/terrain/';
    const meta = await (await fetch(`${base}terrain.json`)).json();
    t.meta = meta;
    const [lh, fh, ma, mb, mc] = await Promise.all([
      loadImageData(`${base}local_h.png`), loadImageData(`${base}far_h.png`),
      loadImageData(`${base}mask_a.png`), loadImageData(`${base}mask_b.png`), loadImageData(`${base}mask_c.png`),
    ]);
    onProgress(0.3);
    t.local = decode16(lh, meta.local.min, meta.local.max);
    t.far = decode16(fh, meta.far.min, meta.far.max);
    t.maskA = ma.data; t.maskB = mb.data; t.maskC = mc.data; t.maskN = ma.width;
    const aniso = Math.min(engine.q.aniso, engine.maxAniso);
    t.layers = await loadMaterialArrays(GROUND_LAYERS, engine.q.texSize, aniso);
    // The albedo carries the visible sharpness at grazing angles; normals and relief get by with
    // less. (Anisotropic probes on these arrays are the largest single cost of the ground.)
    t.layers.col.anisotropy = Math.min(aniso, 8);
    t.layers.nrm.anisotropy = Math.min(aniso, 4);
    t.layers.arh.anisotropy = Math.min(aniso, 2);
    onProgress(0.7);

    const heightTex = new THREE.DataTexture(t.local, meta.local.n, meta.local.n, THREE.RedFormat, THREE.FloatType);
    heightTex.minFilter = heightTex.magFilter = THREE.LinearFilter;
    heightTex.needsUpdate = true;
    const mk = (img) => {
      const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    };
    // mean luminance of the meadow photo texture: the sward is recoloured, only its detail is kept
    let meadowAvg = 0.1;
    try {
      const img = t.layers.col.image, d = img.data, n = img.width * img.height;
      let s = 0, m = 0;
      for (let i = 0; i < n; i += 7) { s += 0.3 * (d[i * 4] / 255) ** 2.2 + 0.6 * (d[i * 4 + 1] / 255) ** 2.2 + 0.1 * (d[i * 4 + 2] / 255) ** 2.2; m++; }
      if (m && s > 0) meadowAvg = s / m;
    } catch (e) { /* keep the default */ }
    const shared = {
      uTCol: { value: t.layers.col }, uTNrm: { value: t.layers.nrm }, uTArh: { value: t.layers.arh },
      uMaskA: { value: mk(ma) }, uMaskB: { value: mk(mb) }, uMaskC: { value: mk(mc) },
      uLocalN: { value: loadTexture(`${base}local_n.png`, { repeat: false, aniso, flipY: false }) },
      uHeightTex: { value: heightTex },
      uWetness: { value: 0.32 },
      uMeadow: { value: new THREE.Vector3(0.052, 0.075, 0.030) },   // linear albedo shared by the sward and the grass blades
      uMeadowAvg: { value: meadowAvg },
    };
    t.uniforms = shared;
    t.engine = engine;
    const useCache = cacheEnabled(engine);
    t.cache = null;
    if (useCache) t._buildCache(engine, shared);

    // ---- clipmap
    const N = 128, half = N / 2;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    let p = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { pos[p++] = i - half; pos[p++] = 0; pos[p++] = j - half; }
    const idx = new Uint32Array(N * N * 6);
    p = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    // Levels 1+ only show a ring: the middle is always covered by the finer level inside (the inner
    // level's square is half as wide and offset by at most one outer cell), so its quads are not built.
    // Before, every ground pixel near the eye was rasterised by all six levels and discarded by five.
    const hole = half / 2 - 2;
    const ringIdx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const gx = i - half, gz = j - half;
      if (gx >= -hole && gx + 1 <= hole && gz >= -hole && gz + 1 <= hole) continue;
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      ringIdx.push(a, c, b, b, c, d);
    }
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', geo.getAttribute('position'));
    ringGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(ringIdx), 1));
    t.group = new THREE.Group();
    t.levels = [];
    const LEVELS = 6;
    // Within 8 m of the eye the ground keeps the full per-pixel material (the 1 cm cache texels
    // are softer than the screen there: the crop A/B showed softer cobbles at 6 m with a 5 m patch)
    // and fades into the cache between 6.5 and 7.75 m.
    // That patch is cut out of level 0's grid (same vertices, so no seam).
    const NEAR = 16;
    const nearIdx = [], l0Idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const gx = i - half, gz = j - half;
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      (gx >= -NEAR && gx < NEAR && gz >= -NEAR && gz < NEAR ? nearIdx : l0Idx).push(a, c, b, b, c, d);
    }
    const nearGeo = new THREE.BufferGeometry();
    nearGeo.setAttribute('position', geo.getAttribute('position'));
    nearGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(nearIdx), 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(l0Idx), 1));
    const fullDefs = engine.qualityName === 'ultra'
      ? '#define VM_FULL_D 1e9\n#define VM_GK_FAR 0.75\n#define VM_FAR_ONLY 0.0\n'
      : '#define VM_FULL_D 70.0\n#define VM_GK_FAR 1.0\n#define VM_FAR_ONLY 1.0\n';
    const NEAR_BLEND = /* glsl */`
{
  vec2 dn = abs(vmWorldPos.xz - uLevel.xy);
  float wN = smoothstep(6.5, 7.75, max(dn.x, dn.y));
  if (wN > 0.0) {
    vec3 sN = normal, sC = diffuseColor.rgb;
    float sR = roughnessFactor, sA = vmTerrainAO, sS = vmSpec;
${CACHE_SURFACE}
    normal = normalize(mix(sN, normal, wN)); diffuseColor.rgb = mix(sC, diffuseColor.rgb, wN);
    roughnessFactor = mix(sR, roughnessFactor, wN); vmTerrainAO = mix(sA, vmTerrainAO, wN); vmSpec = mix(sS, vmSpec, wN);
  }
}`;
    for (let l of [0, -1, ...Array.from({ length: LEVELS - 1 }, (_, k) => k + 1)]) {
      const near = l < 0;
      const cell = 0.5 * 2 ** Math.max(l, 0);
      const u = near ? t.levels[0].u : { uLevel: { value: new THREE.Vector4(0, 0, cell, half) }, uInner: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) } };
      // cache off: every level and the near patch run the full per-pixel material
      const fo = useCache ? {
        key: near ? 'terrain-near' : 'terrain-local',
        uniforms: { ...shared, ...u, ...t.cache.uniforms },
        fragmentPars: near ? `${fullDefs}#define VM_NEAR
uniform vec4 uLevel;
${LOCAL_FRAG_PARS}
${CACHE_FRAG_PARS}` : CACHE_FRAG_PARS,
        surface: near ? LOCAL_SURFACE + NEAR_BLEND : CACHE_SURFACE,
      } : { key: 'terrain-pp', uniforms: { ...shared, ...u }, fragmentPars: fullDefs + LOCAL_FRAG_PARS, surface: LOCAL_SURFACE };
      const mat = enhance(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }), {
        ...fo,
        vertexPars: LOCAL_VERT_PARS,
        vertexNormal: 'objectNormal = vec3(0.0, 1.0, 0.0);',
        vertexBegin: LOCAL_VERT_BEGIN,
        ao: 'vmTerrainAO',
        patch: (shader) => {
          // No discard here: the ring geometry leaves out what the finer level covers, and the thin
          // band where two levels still overlap is the same surface with the same shading (it only
          // depends on the world position). Without a discard the ground keeps early depth rejection.
          shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', SPEC_CHUNK);
        },
      });
      const mesh = new THREE.Mesh(near ? nearGeo : l === 0 ? geo : ringGeo, mat);
      mesh.frustumCulled = false;
      // after the other opaque geometry: the ground shader is the most expensive one on screen and
      // most of what stands on it (houses, walls, grass, trees) can then reject it by depth
      mesh.renderOrder = 10;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      t.group.add(mesh);
      if (near) t.nearMesh = mesh;
      else t.levels.push({ mesh, cell, u, half });
    }

    // ---- far range
    const buf = await (await fetch(`${base}far_mesh.bin`)).arrayBuffer();
    const head = new Uint32Array(buf, 0, 2);
    const vc = head[0], tc = head[1];
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 8, vc * 3), 3));
    {
      // the far mesh lies under the local clipmap too (its inner part is discarded per pixel):
      // drop the triangles that are entirely inside the local square
      const P = new Float32Array(buf, 8, vc * 3), I = new Uint32Array(buf, 8 + vc * 12, tc * 3);
      const keep = new Uint32Array(tc * 3);
      let n = 0;
      const inside = (v) => Math.max(Math.abs(P[v * 3]), Math.abs(P[v * 3 + 2])) < 506;
      for (let k = 0; k < tc * 3; k += 3) {
        if (inside(I[k]) && inside(I[k + 1]) && inside(I[k + 2])) continue;
        keep[n++] = I[k]; keep[n++] = I[k + 1]; keep[n++] = I[k + 2];
      }
      fgeo.setIndex(new THREE.BufferAttribute(keep.slice(0, n), 1));
    }
    fgeo.computeBoundingSphere();
    const fmat = enhance(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide }), {
      key: 'terrain-far',
      uniforms: { ...shared, uFarN: { value: loadTexture(`${base}far_n.png`, { repeat: false, aniso, flipY: false }) }, uFarSize: { value: meta.far.size } },
      vertexNormal: 'objectNormal = vec3(0.0, 1.0, 0.0);',
      fragmentPars: FAR_FRAG_PARS,
      surface: FAR_SURFACE,
      ao: 'vmTerrainAO',
      patch: (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('void main() {', `void main() {
  if (max(abs(vmWorldPos.x), abs(vmWorldPos.z)) < 508.0) discard;`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', SPEC_CHUNK);
      },
    });
    t.farMesh = new THREE.Mesh(fgeo, fmat);
    t.farMesh.frustumCulled = false;
    t.farMesh.renderOrder = 10;
    t.farMesh.receiveShadow = false;
    t.farMesh.matrixAutoUpdate = false;
    t.farTris = tc;
    t.group.add(t.farMesh);
    onProgress(1);
    return t;
  }

  _buildCache(engine, shared) {
    // ultra (the film) keeps the full stochastic ground at every distance
    const defs = '#define VM_BAKE\n' + (engine.qualityName === 'ultra'
      ? '#define VM_FULL_D 1e9\n#define VM_FAR_ONLY 0.0\n'
      : '#define VM_FULL_D 70.0\n#define VM_FAR_ONLY 1.0\n');
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: BAKE_VERT, fragmentShader: bakeFrag(defs),
      uniforms: { ...shared, uNoiseTex: G.uNoiseTex, uBake: { value: new THREE.Vector4() }, uDst: { value: new THREE.Vector4() }, uSrc: { value: new THREE.Vector4() } },
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    // full anisotropy on every cache texture: at grazing angles the cache must be as crisp as the
    // per-pixel material it replaces
    const aniso = Math.max(1, Math.min(16, engine.maxAniso || 16, Math.max(engine.q.aniso || 1, 8)));
    const qn = CACHE_RES[engine.qualityName] ? engine.qualityName : 'high';
    const res = CACHE_RES[qn];
    const mkRT = (n, wrap, count) => {
      const rt = new THREE.WebGLArrayRenderTarget(n, n, count, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
        wrapS: wrap, wrapT: wrap, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      const tx = rt.texture;
      tx.wrapS = tx.wrapT = wrap; tx.minFilter = THREE.LinearMipmapLinearFilter; tx.magFilter = THREE.LinearFilter; tx.generateMipmaps = false;
      tx.anisotropy = aniso;
      rt.levels = Math.log2(n) + 1;
      return rt;
    };
    const casc = CASCADES.map((c, i) => {
      const n = res[i], texel = c.size / n, stepT = Math.round(c.step / texel);
      // deepest mip level on which a step strip still starts and ends on whole texels
      let align = 0; while (align < 12 && stepT % (2 << align) === 0) align++;
      return { ...c, i, n, texel, align, rt: mkRT(n, THREE.RepeatWrapping, 3), x: 0, z: 0, valid: false, job: null, u: { value: new THREE.Vector4() } };
    });
    const far = { rt: mkRT(res[3], THREE.ClampToEdgeWrapping, 2), bake: [200, 1.0, 1.0, 1.0], n: res[3], align: 99 };
    const uniforms = { uCasc0: casc[0].u, uCasc1: casc[1].u, uCasc2: casc[2].u, uCascInv: { value: new THREE.Vector4(1 / casc[0].size, 1 / casc[1].size, 1 / casc[2].size, 1 / 1024) } };
    [...casc.map((c) => c.rt), far.rt].forEach((rt, k) => { uniforms[`uC${k}`] = { value: rt.texture }; });
    this.cache = { mat, scene, cam: new THREE.Camera(), casc, far, uniforms, farBaked: false, bakes: 0, budget: CACHE_BUDGET[qn], bytes: 0 };
    this.cache.bytes = [...casc, far].reduce((m, c) => m + c.n * c.n * 4 * c.rt.depth * 4 / 3, 0);
  }

  // one framebuffer per mip level with the three (or two) textures of a cascade attached
  _levelFBOs(rt) {
    if (rt.fbos) return rt.fbos;
    const r = this.engine.renderer, gl = r.getContext(), st = r.state;
    r.setRenderTarget(rt);   // lets three allocate level 0
    const h = r.properties.get(rt.texture).__webglTexture;
    st.bindTexture(gl.TEXTURE_2D_ARRAY, h);
    for (let l = 1; l < rt.levels; l++) { const n = Math.max(1, rt.width >> l); gl.texImage3D(gl.TEXTURE_2D_ARRAY, l, gl.RGBA8, n, n, rt.depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, rt.levels - 1);
    st.unbindTexture();
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    rt.fbos = [];
    for (let l = 0; l < rt.levels; l++) {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const att = [];
      for (let j = 0; j < rt.depth; j++) { gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + j, h, l, j); att.push(gl.COLOR_ATTACHMENT0 + j); }
      gl.drawBuffers(att);
      rt.fbos.push(fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    return rt.fbos;
  }

  // Renders world rects [x0, z0, x1, z1] into a cascade on mip levels l0..l1 (each rect at most one
  // square wide, texel aligned on those levels). size 0: the valley-wide clamp-to-edge cascade.
  _bake(c, size, pieces, l0, l1) {
    const C = this.cache, r = this.engine.renderer, gl = r.getContext(), u = C.mat.uniforms, rt = c.rt;
    const fbos = this._levelFBOs(rt);
    const prevAuto = r.autoClear, prevRT = r.getRenderTarget();
    r.autoClear = false;
    u.uBake.value.set(c.bake[0], c.bake[1], c.bake[2], c.bake[3]);
    r.setRenderTarget(rt);   // three's state now holds rt; the level framebuffers are bound underneath it
    const own = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const split = (a0, a1) => {
      if (!size) return [[a0, a1, (a0 + 512) / 1024, (a1 + 512) / 1024]];
      let s0 = Math.round((((a0 / size) % 1 + 1) % 1) * rt.width) / rt.width;
      if (s0 >= 1) s0 = 0;
      const len = (a1 - a0) / size;
      if (s0 + len <= 1 + 1e-6) return [[a0, a1, s0, s0 + len]];
      const cut = a0 + (1 - s0) * size;
      return [[a0, cut, s0, 1], [cut, a1, 0, s0 + len - 1]];
    };
    const parts = [];
    for (const [x0, z0, x1, z1] of pieces) for (const [ax, bx, u0, u1] of split(x0, x1)) for (const [az, bz, v0, v1] of split(z0, z1)) parts.push([ax, az, bx, bz, u0, v0, u1, v1]);
    let px = 0;
    for (let l = l0; l <= l1; l++) {
      const n = Math.max(1, rt.width >> l);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[l]);
      gl.viewport(0, 0, n, n);
      for (const p of parts) {
        u.uSrc.value.set(p[0], p[1], p[2], p[3]);
        u.uDst.value.set(p[4] * 2 - 1, p[5] * 2 - 1, p[6] * 2 - 1, p[7] * 2 - 1);
        r.render(C.scene, C.cam);
        px += (p[6] - p[4]) * (p[7] - p[5]) * n * n;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, own);
    gl.viewport(0, 0, rt.width, rt.height);
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
    C.bakes += parts.length;
    return px;
  }

  // the whole square of a cascade around (x, z), all levels, now
  _bakeFull(c, x, z) {
    const h = c.size / 2;
    c.job = null; c.x = x; c.z = z; c.valid = true;
    this._bake(c, c.size, [[x - h, z - h, x + h, z + h]], 0, c.rt.levels - 1);
    c.u.value.set(x, z, h - c.edge - c.step - c.band, h - c.edge - c.step);
  }

  _updateCache(camera) {
    const C = this.cache;
    // every input of the bake must be on the GPU first (the valley-wide cascade is baked only once)
    if (!C || !G.uNoiseTex.value || this.uniforms.uLocalN.value.version === 0) return;
    if (!C.farBaked) { C.farBaked = true; this._bake(C.far, 0, [[-512, -512, 512, 512]], 0, C.far.rt.levels - 1); }
    const px = camera.position.x, pz = camera.position.z;
    // pacing: no streaming bake on a frame that follows a slow one (only the urgent edge case and
    // jumps still bake there); the frame interval is compared against its own running average
    const now = performance.now(), dt = C.tLast ? now - C.tLast : 0;
    C.tLast = now;
    const calm = !(dt > 0 && C.dtAvg && dt > C.dtAvg * 1.6);
    if (dt > 0 && dt < 250) C.dtAvg = C.dtAvg ? C.dtAvg * 0.95 + dt * 0.05 : dt;
    let budget = calm ? C.budget : 0;
    for (const c of C.casc) {
      const tx = Math.round(px / c.step) * c.step, tz = Math.round(pz / c.step) * c.step;
      const dx = Math.abs(px - c.x), dz = Math.abs(pz - c.z);
      // first use or a jump: refill synchronously (a one-off hitch, never stale ground)
      if (!c.valid || Math.max(dx, dz) > c.step * 3) { this._bakeFull(c, tx, tz); continue; }
      if (!c.job) {
        if (tx === c.x && tz === c.z) continue;
        // one step per axis per job: the overwritten strips stay outside the used square
        const nx = c.x + Math.sign(tx - c.x) * c.step, nz = c.z + Math.sign(tz - c.z) * c.step, h = c.size / 2;
        const rects = [];
        if (nx > c.x) rects.push([c.x + h, nz - h, nx + h, nz + h]); else if (nx < c.x) rects.push([nx - h, nz - h, c.x - h, nz + h]);
        if (nz > c.z) rects.push([nx - h, c.z + h, nx + h, nz + h]); else if (nz < c.z) rects.push([nx - h, nz - h, nx + h, c.z - h]);
        // slices along each strip, whole steps long (keeps every mip level aligned)
        const slices = [];
        const per = Math.max(1, Math.floor(C.budget / ((c.step / c.texel) * (c.step / c.texel) * 4 / 3)));
        for (const [x0, z0, x1, z1] of rects) {
          const alongX = x1 - x0 > z1 - z0, len = alongX ? x1 - x0 : z1 - z0, k = Math.ceil(len / (c.step * per) - 1e-6);
          for (let i = 0; i < k; i++) {
            const a = (alongX ? x0 : z0) + i * c.step * per, b = Math.min(a + c.step * per, alongX ? x1 : z1);
            slices.push(alongX ? [a, z0, b, z1] : [x0, a, x1, b]);
          }
        }
        c.job = { nx, nz, slices };
      }
      // near the used edge: work faster, at the very edge finish now
      const off = Math.max(Math.abs(px - c.x), Math.abs(pz - c.z));
      const urgent = off > c.step * 1.75;
      let local = budget * (1 + 3 * Math.max(0, off / c.step - 0.5));
      while (c.job.slices.length && (urgent || local > 0)) {
        const used = this._bake(c, c.size, [c.job.slices.shift()], 0, Math.min(c.align, c.rt.levels - 1));
        local -= used; budget -= used;
      }
      if (c.job.slices.length) continue;
      // done: the small levels below the aligned one are rebaked whole, then the centre moves
      const { nx, nz } = c.job, h = c.size / 2;
      if (c.align < c.rt.levels - 1) this._bake(c, c.size, [[nx - h, nz - h, nx + h, nz + h]], c.align + 1, c.rt.levels - 1);
      c.job = null; c.x = nx; c.z = nz;
      c.u.value.set(nx, nz, h - c.edge - c.step - c.band, h - c.edge - c.step);
    }
  }

  update(camera) {
    this._updateCache(camera);
    const cx = camera.position.x, cz = camera.position.z;
    let prev = null;
    for (const L of this.levels) {
      const snap = L.cell * 2;
      const x = Math.round(cx / snap) * snap, z = Math.round(cz / snap) * snap;
      L.u.uLevel.value.set(x, z, L.cell, L.half);
      if (prev) {
        const ext = prev.half * prev.cell - L.cell;
        L.u.uInner.value.set(prev.x - ext, prev.z - ext, prev.x + ext, prev.z + ext);
      }
      prev = { x, z, half: L.half, cell: L.cell };
    }
  }

  heightAt(x, z) {
    const m = this.meta;
    if (Math.abs(x) < 511.5 && Math.abs(z) < 511.5) {
      const n = m.local.n;
      const fx = (x + 512) * 2, fz = (z + 512) * 2;
      const ix = Math.floor(fx), iz = Math.floor(fz);
      const tx = fx - ix, tz = fz - iz;
      const d = this.local, k = iz * n + ix;
      return (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - tz) + (d[k + n] * (1 - tx) + d[k + n + 1] * tx) * tz;
    }
    const n = m.far.n, c = m.far.size / (n - 1);
    const fx = Math.min(Math.max((x + m.far.size / 2) / c, 0), n - 1.001), fz = Math.min(Math.max((z + m.far.size / 2) / c, 0), n - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const d = this.far, k = iz * n + ix;
    return (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - tz) + (d[k + n] * (1 - tx) + d[k + n + 1] * tx) * tz;
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 0.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  // surface masks at a world position (0..1 each)
  maskAt(x, z, out = {}) {
    const n = this.maskN;
    const i = Math.min(n - 1, Math.max(0, Math.floor((x + 512) * 2))), j = Math.min(n - 1, Math.max(0, Math.floor((z + 512) * 2)));
    const k = (j * n + i) * 4;
    out.road = this.maskA[k] / 255; out.mud = this.maskA[k + 1] / 255; out.rubble = this.maskA[k + 2] / 255;
    out.bed = this.maskB[k] / 255; out.cobble = this.maskB[k + 1] / 255; out.wet = this.maskB[k + 2] / 255;
    out.forest = this.maskC[k] / 255;
    return out;
  }
}
