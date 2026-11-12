// Terrain: the detailed valley (geometry clipmap displaced from a height
// texture, splatted PBR ground materials) and the surrounding mountain range
// (adaptive baked mesh, procedural rock / forest / snow shading).
import * as THREE from 'three';
import { enhance } from '../engine/materials.js';
import { G } from '../engine/shared.js';
import { loadImageData, loadMaterialArrays, loadTexture } from '../engine/textures.js';

export const GROUND_LAYERS = ['grass_ground', 'dirt_mud', 'gravel_road', 'forest_floor', 'rock_limestone', 'riverbed_pebbles', 'rubble', 'cobblestone'];

const LAYER_LIB = /* glsl */`
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
void vmBlend(inout VmLayer A, VmLayer B, float w, float sharp) {
  float ha = A.h + (1.0 - w) * 1.2, hb = B.h + w * 1.2;
  float m = max(ha, hb) - sharp;
  float ka = max(ha - m, 0.0), kb = max(hb - m, 0.0);
  float k = kb / (ka + kb + 1e-5);
  k = mix(k, w, 0.15);
  A.col = mix(A.col, B.col, k); A.n = mix(A.n, B.n, k);
  A.ao = mix(A.ao, B.ao, k); A.rough = mix(A.rough, B.rough, k); A.h = mix(A.h, B.h, k);
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
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float macro = texture2D(uNoiseTex, wxz / 230.0).r;
  float macro2 = texture2D(uNoiseTex, wxz / 53.0 + 0.31).g;
  float fine = texture2D(uNoiseTex, wxz / 9.0 + 0.7).b;

  // meadow
  VmLayer L = vmSample(0.0, uv, dx, dy);
  float farK = smoothstep(22.0, 120.0, dist);
  if (farK > 0.01) {
    // rotated, larger scale copy hides the tiling in the distance
    vec2 uv2 = mat2(0.819, -0.574, 0.574, 0.819) * uv * 0.23;
    VmLayer Lf = vmSample(0.0, uv2, dx * 0.23, dy * 0.23);
    L.col = mix(L.col, Lf.col, farK * 0.75); L.n = mix(L.n, Lf.n, farK * 0.6);
    L.rough = mix(L.rough, Lf.rough, farK * 0.6); L.h = mix(L.h, Lf.h, farK * 0.5);
  }
  // lush / dry / mossy variation across the meadow
  vec3 tint = mix(vec3(0.86, 0.94, 0.70), vec3(1.18, 1.08, 0.80), smoothstep(0.3, 0.75, macro));
  tint = mix(tint, vec3(0.92, 0.98, 0.78), smoothstep(0.55, 0.8, macro2) * 0.6);
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
  if (wF > 0.004) vmBlend(L, vmSample(3.0, uv, dx, dy), wF, 0.3);
  // bedrock where the ground is steep
  float wR = smoothstep(0.24, 0.42, slope + (macro2 - 0.5) * 0.16 + (fine - 0.5) * 0.08);
  if (wR > 0.004) { vec2 ru = wxz / 6.0; vmBlend(L, vmSample(4.0, ru, dx * 0.667, dy * 0.667), wR, 0.2); }
  // bare earth, mud
  // churned earth is half regrown: soil only shows where the grass stands thin (same noise as the blades)
  float thin = smoothstep(0.62, 0.3, texture2D(uNoiseTex, wxz / 17.0 + 0.13).b);
  float wM = smoothstep(0.25, 0.8, mA.g * (0.75 + 0.6 * macro2)) * mix(1.0, thin, 0.85);
  if (wM > 0.004) vmBlend(L, vmSample(1.0, uv, dx, dy), wM, 0.22);
  // dirt road
  float wRoad = mA.r;
  if (wRoad > 0.004) vmBlend(L, vmSample(2.0, uv, dx, dy), wRoad, 0.18);
  // cobbled streets
  float wC = mB.g;
  if (wC > 0.004) vmBlend(L, vmSample(7.0, uv, dx, dy), wC, 0.14);
  // rubble aprons around ruined buildings
  float wRb = mA.b;
  if (wRb > 0.004) vmBlend(L, vmSample(6.0, uv, dx, dy), wRb, 0.25);
  // river bed
  float wBed = mB.r;
  if (wBed > 0.004) vmBlend(L, vmSample(5.0, uv, dx, dy), wBed, 0.2);

  // rain-soaked ground and standing water
  float wet = mB.b;
  float damp = clamp(uWetness * (0.55 + 0.6 * (1.0 - L.h)) + wet * 0.8 + wBed * 0.8, 0.0, 1.0);
  float puddle = smoothstep(0.42, 0.62, wet * 1.15 - L.h * 0.35);
  L.col *= mix(1.0, 0.52, damp * (1.0 - 0.3 * wC));
  L.rough = mix(L.rough, L.rough * 0.55, damp);
  L.rough = mix(L.rough, 0.035, puddle);
  L.col = mix(L.col, L.col * 0.55, puddle);
  L.n *= 1.0 - puddle;

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
      uMeadow: { value: new THREE.Vector3(0.064, 0.084, 0.030) },   // linear albedo shared by the sward and the grass blades
      uMeadowAvg: { value: meadowAvg },
    };
    t.uniforms = shared;

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
    t.group = new THREE.Group();
    t.levels = [];
    const LEVELS = 6;
    for (let l = 0; l < LEVELS; l++) {
      const cell = 0.5 * 2 ** l;
      const u = { uLevel: { value: new THREE.Vector4(0, 0, cell, half) }, uInner: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) } };
      const mat = enhance(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }), {
        key: 'terrain-local',
        uniforms: { ...shared, ...u },
        vertexPars: LOCAL_VERT_PARS,
        vertexNormal: 'objectNormal = vec3(0.0, 1.0, 0.0);',
        vertexBegin: LOCAL_VERT_BEGIN,
        fragmentPars: LOCAL_FRAG_PARS,
        surface: LOCAL_SURFACE,
        ao: 'vmTerrainAO',
        patch: (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace('void main() {', `void main() {
  if (vmWorldPos.x > uInner.x && vmWorldPos.x < uInner.z && vmWorldPos.z > uInner.y && vmWorldPos.z < uInner.w) discard;
  if (max(abs(vmWorldPos.x), abs(vmWorldPos.z)) > 511.9) discard;`);
          shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', SPEC_CHUNK);
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      t.group.add(mesh);
      t.levels.push({ mesh, cell, u, half });
    }

    // ---- far range
    const buf = await (await fetch(`${base}far_mesh.bin`)).arrayBuffer();
    const head = new Uint32Array(buf, 0, 2);
    const vc = head[0], tc = head[1];
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 8, vc * 3), 3));
    fgeo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, 8 + vc * 12, tc * 3), 1));
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
    t.farMesh.receiveShadow = false;
    t.farMesh.matrixAutoUpdate = false;
    t.farTris = tc;
    t.group.add(t.farMesh);
    onProgress(1);
    return t;
  }

  update(camera) {
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
