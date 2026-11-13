// Sky: raymarched volumetric stratocumulus baked progressively into a warped
// panorama, a matching top-down cloud-shadow map ("gobo") that drives sun
// patches and light shafts, the sky dome, and the image-based-lighting probe.
import * as THREE from 'three';
import { Pass } from './pass.js';
import { G, GLSL_COMMON } from './shared.js';

const NOISE_FS = /* glsl */`
uniform float uLayer;
uniform float uMode;
out vec4 outColor;
vec3 hash33(vec3 p) {
  uvec3 q = uvec3(ivec3(p)) * uvec3(1597334673U, 3812015801U, 2798796415U);
  q = (q.x ^ q.y ^ q.z) * uvec3(1597334673U, 3812015801U, 2798796415U);
  return -1.0 + 2.0 * vec3(q) * (1.0 / float(0xffffffffU));
}
float remap(float x, float a, float b, float c, float d) { return (((x - a) / (b - a)) * (d - c)) + c; }
float gradientNoise(vec3 x, float freq) {
  vec3 p = floor(x); vec3 w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 ga = hash33(mod(p + vec3(0, 0, 0), freq)); vec3 gb = hash33(mod(p + vec3(1, 0, 0), freq));
  vec3 gc = hash33(mod(p + vec3(0, 1, 0), freq)); vec3 gd = hash33(mod(p + vec3(1, 1, 0), freq));
  vec3 ge = hash33(mod(p + vec3(0, 0, 1), freq)); vec3 gf = hash33(mod(p + vec3(1, 0, 1), freq));
  vec3 gg = hash33(mod(p + vec3(0, 1, 1), freq)); vec3 gh = hash33(mod(p + vec3(1, 1, 1), freq));
  float va = dot(ga, w - vec3(0, 0, 0)); float vb = dot(gb, w - vec3(1, 0, 0));
  float vc = dot(gc, w - vec3(0, 1, 0)); float vd = dot(gd, w - vec3(1, 1, 0));
  float ve = dot(ge, w - vec3(0, 0, 1)); float vf = dot(gf, w - vec3(1, 0, 1));
  float vg = dot(gg, w - vec3(0, 1, 1)); float vh = dot(gh, w - vec3(1, 1, 1));
  return va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va) + u.x * u.y * (va - vb - vc + vd) + u.y * u.z * (va - vc - ve + vg) + u.z * u.x * (va - vb - ve + vf) + u.x * u.y * u.z * (-va + vb + vc - vd + ve - vf - vg + vh);
}
float worleyNoise(vec3 uv, float freq) {
  vec3 id = floor(uv); vec3 p = fract(uv);
  float minDist = 10000.0;
  for (float x = -1.0; x <= 1.0; ++x) for (float y = -1.0; y <= 1.0; ++y) for (float z = -1.0; z <= 1.0; ++z) {
    vec3 offset = vec3(x, y, z);
    vec3 h = hash33(mod(id + offset, vec3(freq))) * 0.5 + 0.5;
    h += offset;
    vec3 d = p - h;
    minDist = min(minDist, dot(d, d));
  }
  return 1.0 - minDist;
}
float perlinfbm(vec3 p, float freq, int octaves) {
  float G = exp2(-0.85); float amp = 1.0; float noise = 0.0;
  for (int i = 0; i < octaves; ++i) { noise += amp * gradientNoise(p * freq, freq); freq *= 2.0; amp *= G; }
  return noise;
}
float worleyFbm(vec3 p, float freq) {
  return worleyNoise(p * freq, freq) * 0.625 + worleyNoise(p * freq * 2.0, freq * 2.0) * 0.25 + worleyNoise(p * freq * 4.0, freq * 4.0) * 0.125;
}
void main() {
  vec3 uvw = vec3(vUv, uLayer);
  if (uMode < 0.5) {
    float freq = 4.0;
    float pfbm = mix(1.0, perlinfbm(uvw, 4.0, 7), 0.5);
    pfbm = abs(pfbm * 2.0 - 1.0);
    float g = worleyFbm(uvw, freq);
    float b = worleyFbm(uvw, freq * 2.0);
    float a = worleyFbm(uvw, freq * 4.0);
    float r = remap(pfbm, 0.0, 1.0, g, 1.0);
    outColor = vec4(r, g, b, a);
  } else {
    outColor = vec4(worleyFbm(uvw, 3.0), worleyFbm(uvw, 6.0), worleyFbm(uvw, 12.0), perlinfbm(uvw, 4.0, 5) * 0.5 + 0.5);
  }
}`;

// Shared cloud model. Positions are metres in the cloud frame; altitude is
// measured above the valley floor on a curved earth.
const CLOUD_LIB = /* glsl */`
uniform sampler3D uNoiseA;
uniform sampler3D uNoiseB;
uniform vec4 uCloud;      // x base, y top, z coverage, w extinction
uniform vec4 uCloudOff;   // xy wind offset (m), z evolution, w weather bias
uniform vec4 uCloudShape; // x cell scale (m), y detail scale (m), z erosion, w weather contrast
uniform vec4 uCloudGap[3]; // openings: xy centre in the cloud frame (m), z radius, w coverage drop
uniform vec3 uSunDirC;
uniform vec3 uSunE;       // sun irradiance scale for clouds
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
const float PI = 3.14159265;
const float EARTH_R = 6360000.0;
float remap(float x, float a, float b, float c, float d) { return (((x - a) / (b - a)) * (d - c)) + c; }
float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }

float weatherAt(vec2 xz) {
  float a = texture(uNoiseA, vec3(xz / 67000.0, 0.137)).r;
  float b = texture(uNoiseA, vec3(xz / 26000.0 + 0.37, 0.61)).g;
  return a * 0.6 + b * 0.4;
}
uniform float uCloudEdge;
// x = cover of the layer above a point (weather field minus the openings), y = weather.
// Both hardly change along a sun ray, so the light march reuses them.
vec2 cloudCover(vec3 q, float py) {
  float wth = weatherAt(q.xz);
  // Openings where the sun breaks through. Each one follows the sun rays up through the layer
  // (gq = where the ray through this point meets the ground), so a thick layer still leaves a
  // clean patch of sunlight on the ground it is aimed at. The rim is lobed, not a circle.
  vec2 gq = q.xz - uSunDirC.xz / max(uSunDirC.y, 0.08) * py;
  float gap = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 gd = gq - uCloudGap[i].xy;
    float gl = length(gd);
    vec2 gn = gd / max(gl, 1.0);
    float lobe = 1.0 + 0.2 * gn.x * (gn.x * gn.x - 3.0 * gn.y * gn.y) + 0.26 * gn.x * gn.y;
    gap = max(gap, uCloudGap[i].w * (1.0 - smoothstep(uCloudGap[i].z * 0.45, uCloudGap[i].z, gl / lobe)));
  }
  // 0.75 is the mean of the weather field: the coverage parameter is the cover of an average patch of sky
  return vec2(clamp(uCloud.z + (wth - 0.75) * uCloudShape.w + uCloudOff.w - gap, 0.0, 1.0), wth);
}
// density of the cloud body without the fine erosion: 0 outside, towards 1 in the core
float cloudShape(vec3 q, float h, vec2 cw) {
  vec4 n = texture(uNoiseA, vec3(q.x, q.y + uCloudOff.z, q.z) / uCloudShape.x);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float base = remap(n.r, fbm - 1.0, 1.0, 0.0, 1.0);
  // cumulus: a flat base, a rounded top whose height follows the weather, and less cover with
  // height so that the cells narrow into domes
  float topH = 0.45 + 0.55 * smoothstep(0.38, 0.72, cw.y);
  float hc = clamp(h, 0.0, 1.0);
  base *= smoothstep(0.0, 0.07, hc) * (1.0 - smoothstep(topH * 0.5, topH, hc));
  float cov = cw.x * (1.0 - 0.45 * hc);
  // 0 at the rim of a cell whatever the coverage, then quickly up to full density: defined edges
  float d = clamp((base - (1.0 - cov)) / max(cov, 1e-3), 0.0, 1.0);
  return 1.0 - exp(-uCloudEdge * d);
}
float cloudDensity(vec3 p, float h, float detail) {
  vec3 q = p; q.xz += uCloudOff.xy;
  vec2 cw = cloudCover(q, p.y);
  if (cw.x < 0.015) return 0.0;
  float d = cloudShape(q, h, cw);
  if (d <= 0.0) return 0.0;
  if (detail > 0.5) {
    vec4 dn = texture(uNoiseB, vec3(q.x, q.y + uCloudOff.z * 0.4, q.z) / uCloudShape.y);
    float hf = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    float m = mix(hf, 1.0 - hf, clamp(h * 5.0, 0.0, 1.0));
    d = remap(d, m * uCloudShape.z, 1.0, 0.0, 1.0);
  }
  return max(d, 0.0);
}
// distance along a ray (origin altitude y0, direction rd) to altitude H on a curved earth
float shellDist(float y0, vec3 rd, float H) {
  float k = (1.0 - rd.y * rd.y) / (2.0 * EARTH_R);
  float dh = H - y0;
  float disc = rd.y * rd.y + 4.0 * k * dh;
  return 2.0 * dh / (rd.y + sqrt(max(disc, 0.0)) + 1e-9);
}
float altitudeAt(float y0, vec3 rd, float t) {
  return y0 + rd.y * t + (1.0 - rd.y * rd.y) * t * t / (2.0 * EARTH_R);
}
vec3 skyBackground(vec3 rd) {
  float e = clamp(rd.y, 0.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(e, 0.42));
  // brighter, paler air around the sun
  float ms = max(dot(rd, uSunDirC), 0.0);
  return c + uSkyHorizon * (0.3 * pow(ms, 8.0) + 0.5 * pow(ms, 64.0));
}
// q is in the cloud frame (wind offset applied); cw = cloudCover at the start of the ray
float sunOpticalDepth(vec3 q, float alt, vec2 cw) {
  float od = 0.0;
  float t = 0.0;
  float step = 55.0;
  for (int i = 0; i < 6; i++) {
    t += step;
    float a = alt + uSunDirC.y * t;
    float h = (a - uCloud.x) / (uCloud.y - uCloud.x);
    if (h > 1.0) break;
    od += cloudShape(q + uSunDirC * t, h, cw) * step;
    step *= 1.75;
  }
  return od * uCloud.w;
}
// returns rgb = in-scattered radiance, a = transmittance
vec4 marchClouds(float y0, vec3 rd, float jitter, int steps) {
  float t0 = shellDist(y0, rd, uCloud.x);
  float t1 = shellDist(y0, rd, uCloud.y);
  if (t0 < 0.0 || t0 > 400000.0) return vec4(0.0, 0.0, 0.0, 1.0);
  t1 = min(t1, t0 + 20000.0);
  float dt = (t1 - t0) / float(steps);
  float t = t0 + dt * jitter;
  float mu = dot(rd, uSunDirC);
  float T = 1.0;
  vec3 L = vec3(0.0);
  for (int i = 0; i < steps; i++) {
    vec3 p = vec3(rd.x * t, 0.0, rd.z * t);
    float alt = altitudeAt(y0, rd, t);
    p.y = alt;
    float h = (alt - uCloud.x) / (uCloud.y - uCloud.x);
    vec3 q = p; q.xz += uCloudOff.xy;
    vec2 cw = cloudCover(q, alt);
    float d = cw.x < 0.015 ? 0.0 : cloudShape(q, h, cw);
    if (d > 0.0) {
      vec4 dn = texture(uNoiseB, vec3(q.x, q.y + uCloudOff.z * 0.4, q.z) / uCloudShape.y);
      float hf = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
      d = max(remap(d, mix(hf, 1.0 - hf, clamp(h * 5.0, 0.0, 1.0)) * uCloudShape.z, 1.0, 0.0, 1.0), 0.0);
    }
    if (d > 0.0005) {
      float od = sunOpticalDepth(q, alt, cw);
      // multiple-scattering octaves
      vec3 E = vec3(0.0);
      float a = 1.0, b = 1.0, c = 1.0;
      for (int k = 0; k < 4; k++) {
        float ph = mix(hg(mu, 0.82 * c), hg(mu, -0.28 * c), 0.28);
        E += a * exp(-od * b) * ph;
        a *= 0.56; b *= 0.42; c *= 0.55;
      }
      // skylight entering from above, attenuated by the cloud between here and the top
      vec3 amb = uAmbBot + uAmbTop * (0.3 * exp(-od * 0.07) + 0.7 * exp(-od * 0.42)) * mix(0.4, 1.0, clamp(h, 0.0, 1.0));
      vec3 S = uSunE * E + amb;
      float sigma = d * uCloud.w;
      float Ti = exp(-sigma * dt);
      L += T * S * (1.0 - Ti);
      T *= Ti;
      if (T < 0.006) { T = 0.0; break; }
    }
    t += dt;
  }
  return vec4(L, T);
}
`;

const PANO_FS = /* glsl */`
${GLSL_COMMON}
${CLOUD_LIB}
uniform vec2 uPanoSize;
uniform float uCamAlt;
uniform int uSteps;
out vec4 outColor;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
const float EL0 = -0.0524, EL1 = 1.5708;
void main() {
  float az = (vUv.x - 0.5) * 2.0 * PI;
  float el = EL0 + (EL1 - EL0) * (0.5 * vUv.y + 0.5 * vUv.y * vUv.y);
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec4 c = marchClouds(uCamAlt, rd, ign(gl_FragCoord.xy), uSteps);
  vec3 col = c.rgb + c.a * skyBackground(rd);
  // aerial perspective up to the cloud layer
  float t0 = clamp(shellDist(uCamAlt, rd, uCloud.x), 0.0, 400000.0);
  float od = vmFogIntegral(uHaze, uCamAlt, rd.y * t0, t0) + vmFogIntegral(uMist, uCamAlt, rd.y * t0, t0);
  float Tf = exp(-od);
  col = col * Tf + vmFogColor(rd) * (1.0 - Tf);
  outColor = vec4(col, c.a * Tf);
}`;

const GOBO_FS = /* glsl */`
${CLOUD_LIB}
uniform vec4 uRect;
out vec4 outColor;
void main() {
  vec2 xz = uRect.xy + (vUv - 0.5) * uRect.z;
  float od = 0.0;
  const int N = 10;
  float thick = uCloud.y - uCloud.x;
  for (int i = 0; i < N; i++) {
    float h = (float(i) + 0.5) / float(N);
    float y = uCloud.x + h * thick;
    vec3 p = vec3(xz.x + uSunDirC.x / uSunDirC.y * (y - uCloud.x), y, xz.y + uSunDirC.z / uSunDirC.y * (y - uCloud.x));
    od += cloudDensity(p, h, 0.0);
  }
  od *= thick / float(N) / max(uSunDirC.y, 0.08) * uCloud.w;
  // direct beam plus a little forward-scattered light that survives thin cloud
  float T = exp(-od) + 0.06 * exp(-od * 0.12);
  outColor = vec4(clamp(T, 0.0, 1.0));
}`;

const DOME_VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(position * 1000.0 + cameraPosition, 1.0);
  gl_Position = p.xyww;
}`;
const DOME_FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D uPanoA;
uniform sampler2D uPanoB;
uniform float uBlend;
uniform vec3 uSunDisc;
uniform float uSkyDisplay;
varying vec3 vDir;
const float PI = 3.14159265;
const float EL0 = -0.0524, EL1 = 1.5708;
vec4 pano(vec3 d) {
  float az = atan(d.z, d.x);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float s = clamp((el - EL0) / (EL1 - EL0), 0.0, 1.0);
  float v = -0.5 + sqrt(0.25 + 2.0 * s);
  vec2 uv = vec2(az / (2.0 * PI) + 0.5, v);
  // explicit gradients avoid the seam at the atan discontinuity
  vec4 a = textureLod(uPanoA, uv, 0.0);
  vec4 b = textureLod(uPanoB, uv, 0.0);
  return mix(a, b, uBlend);
}
void main() {
  vec3 d = normalize(vDir);
  vec4 c = pano(d);
  vec3 col = c.rgb;
  float mu = dot(d, uSunDir);
  float disc = smoothstep(0.99990, 0.99997, mu);
  float glow = pow(max(mu, 0.0), 900.0) * 0.25 + pow(max(mu, 0.0), 90.0) * 0.02 + pow(max(mu, 0.0), 14.0) * 0.0015;
  col += uSunDisc * c.a * (disc * 14.0 + glow);
  // display-only balance between sky and land (the horizon stays matched to the fog)
  col *= mix(1.0, uSkyDisplay, smoothstep(0.03, 0.3, d.y));
  float below = smoothstep(-0.02, -0.06, d.y);
  col = mix(col, vmFogColor(d) * 0.9, below);
  gl_FragColor = vec4(col, 1.0);
}`;

const ENV_FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D uPanoA;
uniform vec3 uGround;
out vec4 outColor;
const float PI = 3.14159265;
const float EL0 = -0.0524, EL1 = 1.5708;
void main() {
  float phi = (vUv.x - 0.5) * 2.0 * PI;
  float lat = (vUv.y - 0.5) * PI;
  vec3 d = vec3(cos(lat) * cos(phi), sin(lat), cos(lat) * sin(phi));
  float s = clamp((lat - EL0) / (EL1 - EL0), 0.0, 1.0);
  vec2 uv = vec2(vUv.x, -0.5 + sqrt(0.25 + 2.0 * s));
  vec3 sky = textureLod(uPanoA, uv, 0.0).rgb;
  vec3 ground = mix(uGround, vmFogColor(d) * 0.55, smoothstep(-0.6, 0.0, d.y));
  outColor = vec4(mix(ground, sky, smoothstep(-0.03, 0.02, d.y)), 1.0);
}`;

export class Sky {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.period = opts.period ?? 16;          // seconds between baked cloud states
    this.panoSize = opts.panoSize ?? [2048, 512];
    this.steps = opts.steps ?? 56;
    this.goboSize = opts.goboSize ?? 768;
    this.wind = new THREE.Vector2(2.2, 1.2);  // m/s drift of the cloud field
    this.evolve = 0.9;                        // vertical scroll (m/s) = shape evolution
    this.camAlt = 1.7;

    this.params = {
      base: 2900, top: 3900, coverage: 0.19, extinction: 0.036, weatherBias: 0.0,
      // cell size of the cloud field, detail erosion, contrast of the large weather systems
      scale: 4000, detailScale: 700, erosion: 0.62, weather: 1.0, edge: 2.5,
      offset: new THREE.Vector2(0, 0),      // shifts the whole field (m): places the gaps / sun patches
      display: 1.0,                         // display-only brightness of the sky dome
      // openings in the deck at t = 0: world xz of the point where the sun ray to the lit
      // ground crosses the middle of the deck, radius, coverage drop. The first puts the
      // village and the meadow in sun, the others send shafts down in front of the peaks.
      // (gaps: xy = world xz of the patch of GROUND the sun reaches through the opening, whatever the
      // sun direction; z = radius, w = coverage drop. An anchored opening stays over its patch
      // while the field drifts through it, the others drift with the clouds.)
      gaps: [new THREE.Vector4(10, 20, 720, 0.6), new THREE.Vector4(377, -1680, 520, 0.35), new THREE.Vector4(1327, -2280, 460, 0.35)],
      gapAnchor: [1, 0, 0],
      sunE: new THREE.Vector3(13, 11.8, 10.3),
      ambTop: new THREE.Vector3(0.30, 0.38, 0.52),
      ambBot: new THREE.Vector3(0.12, 0.14, 0.18),
      // what shows through the gaps: a bright veil of high cloud rather than deep blue
      skyZenith: new THREE.Vector3(0.07, 0.20, 0.62),
      skyHorizon: new THREE.Vector3(0.42, 0.58, 0.86),
    };

    this._makeNoise();

    const cloudUniforms = () => ({
      uNoiseA: { value: this.noiseA.texture },
      uNoiseB: { value: this.noiseB.texture },
      uCloud: { value: new THREE.Vector4() },
      uCloudOff: { value: new THREE.Vector4() },
      uCloudShape: { value: new THREE.Vector4() },
      uCloudEdge: { value: 2.5 },
      uCloudGap: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uSunDirC: G.uSunDir,
      uSunE: { value: this.params.sunE },
      uAmbTop: { value: this.params.ambTop },
      uAmbBot: { value: this.params.ambBot },
      uSkyZenith: { value: this.params.skyZenith },
      uSkyHorizon: { value: this.params.skyHorizon },
    });

    this.panoPass = new Pass(PANO_FS, {
      ...cloudUniforms(), ...G,
      uPanoSize: { value: new THREE.Vector2(...this.panoSize) },
      uCamAlt: { value: this.camAlt },
      uSteps: { value: this.steps },
    });
    this.goboPass = new Pass(GOBO_FS, { ...cloudUniforms(), uRect: G.uCloudRect });

    const mkPano = () => {
      const rt = new THREE.WebGLRenderTarget(this.panoSize[0], this.panoSize[1], {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      rt.texture.wrapS = THREE.RepeatWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      return rt;
    };
    this.panos = [mkPano(), mkPano(), mkPano()];
    this.slots = new Map();   // state index k -> { rt, done, nextTile }
    this.gobo = new THREE.WebGLRenderTarget(this.goboSize, this.goboSize, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    });
    G.uCloudMap.value = this.gobo.texture;
    G.uCloudRect.value.w = this.params.base;

    this.domeUniforms = {
      ...G,
      uPanoA: { value: this.panos[0].texture },
      uPanoB: { value: this.panos[1].texture },
      uBlend: { value: 0 },
      uSunDisc: { value: new THREE.Vector3(60, 55, 46) },
      uSkyDisplay: { value: 1 },
    };
    this.dome = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 4),
      new THREE.ShaderMaterial({ vertexShader: DOME_VS, fragmentShader: DOME_FS, uniforms: this.domeUniforms, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 900;

    this.envRT = new THREE.WebGLRenderTarget(512, 256, { type: THREE.HalfFloatType, depthBuffer: false });
    this.envRT.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.envPass = new Pass(ENV_FS, { ...G, uPanoA: { value: null }, uGround: { value: new THREE.Vector3(0.05, 0.06, 0.045) } });
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = null;
    // the panorama is refreshed a few pixel columns per frame and the cloud shadow map one band per
    // frame: an even load instead of a spike every few frames
    this.goboBands = 6;
    this.time = 0;
  }

  _makeNoise() {
    const mk = (size) => {
      const rt = new THREE.WebGL3DRenderTarget(size, size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false });
      rt.texture.minFilter = THREE.LinearFilter; rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.RepeatWrapping;
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.noiseA = mk(128);
    this.noiseB = mk(32);
    const u = { uLayer: { value: 0 }, uMode: { value: 0 } };
    const pass = new Pass(NOISE_FS, u);
    for (const [rt, mode] of [[this.noiseA, 0], [this.noiseB, 1]]) {
      const n = rt.depth;
      u.uMode.value = mode;
      for (let i = 0; i < n; i++) {
        u.uLayer.value = (i + 0.5) / n;
        pass.render(this.renderer, rt, i);
      }
    }
    pass.dispose();
    this.renderer.setRenderTarget(null);
  }

  _setCloudUniforms(u, t) {
    const p = this.params;
    u.uCloud.value.set(p.base, p.top, p.coverage, p.extinction);
    u.uCloudOff.value.set(this.wind.x * t + p.offset.x, this.wind.y * t + p.offset.y, this.evolve * t, p.weatherBias);
    u.uCloudShape.value.set(p.scale, p.detailScale, p.erosion, p.weather);
    u.uCloudEdge.value = p.edge ?? 2.5;
    p.gaps.forEach((g, i) => {
      const a = p.gapAnchor && p.gapAnchor[i] ? t : 0;
      u.uCloudGap.value[i].set(g.x + p.offset.x + this.wind.x * a, g.y + p.offset.y + this.wind.y * a, g.z, g.w);
    });
  }

  // Render (part of) the panorama for state k: up to maxCols pixel columns, in strips of at most
  // 1/16 of the width (one GPU job each). Returns true once complete.
  _renderSlot(k, maxCols) {
    let s = this.slots.get(k);
    if (!s) {
      // recycle a target that is no longer needed
      const used = new Set([...this.slots.values()].map((v) => v.rt));
      const rt = this.panos.find((r) => !used.has(r));
      s = { rt, done: false, next: 0 };
      this.slots.set(k, s);
    }
    if (s.done) return true;
    const u = this.panoPass.uniforms;
    this._setCloudUniforms(u, k * this.period);
    u.uCamAlt.value = this.camAlt;
    u.uSteps.value = this.steps;
    const [W, H] = this.panoSize;
    const strip = Math.ceil(W / 16);
    const gl = this.renderer.getContext();
    let left = Math.min(Math.ceil(maxCols), W - s.next);
    s.rt.scissorTest = true;
    while (left > 0) {
      const n = Math.min(left, strip);
      s.rt.scissor.set(s.next, 0, n, H);
      this.panoPass.render(this.renderer, s.rt);
      gl.flush();
      s.next += n; left -= n;
    }
    s.rt.scissorTest = false;
    this.renderer.setRenderTarget(null);
    if (s.next >= W) s.done = true;
    return s.done;
  }

  // band >= 0 refreshes one horizontal slice only
  renderGobo(t, band = -1) {
    this._setCloudUniforms(this.goboPass.uniforms, t);
    G.uCloudRect.value.w = this.params.base;
    const rt = this.gobo;
    if (band >= 0) {
      const bh = Math.ceil(rt.height / this.goboBands);
      rt.scissorTest = true;
      rt.scissor.set(0, band * bh, rt.width, bh);
    }
    this.goboPass.render(this.renderer, rt);
    rt.scissorTest = false;
    this.renderer.setRenderTarget(null);
  }

  updateEnvironment(scene) {
    const k = Math.floor(this.time / this.period);
    const s = this.slots.get(k);
    if (!s || !s.done) return;
    this.envPass.uniforms.uPanoA.value = s.rt.texture;
    this.envPass.render(this.renderer, this.envRT);
    this._measureAmbient(scene);
    this.renderer.setRenderTarget(null);
    const old = this.envMap;
    this.envMap = this.pmrem.fromEquirectangular(this.envRT.texture);
    scene.environment = this.envMap.texture;
    if (old) old.dispose();
  }

  // Cosine-weighted mean radiance of the sky and ground hemispheres. Normalises the
  // image-based ambient to ambTarget (so the look of the clouds and the brightness of
  // the land can be tuned independently) and feeds the cheap hemispherical ambient of
  // grass, water and particles, which therefore always agree with the PBR materials.
  _measureAmbient(scene) {
    try {
      const W = 96, H = 48;
      if (!this.probeRT) this.probeRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false });
      this.envPass.render(this.renderer, this.probeRT);
      const buf = new Float32Array(W * H * 4);
      this.renderer.readRenderTargetPixels(this.probeRT, 0, 0, W, H, buf);
      const up = [0, 0, 0], dn = [0, 0, 0];
      let wu = 0, wd = 0;
      for (let j = 0; j < H; j++) {
        const lat = ((j + 0.5) / H - 0.5) * Math.PI;
        const w = Math.cos(lat) * Math.abs(Math.sin(lat));
        const t = lat > 0 ? up : dn;
        for (let i = 0; i < W; i++) { const k = (j * W + i) * 4; t[0] += buf[k] * w; t[1] += buf[k + 1] * w; t[2] += buf[k + 2] * w; }
        if (lat > 0) wu += w * W; else wd += w * W;
      }
      const lum = (up[0] * 0.2126 + up[1] * 0.7152 + up[2] * 0.0722) / wu;
      if (!(lum > 1e-4) || !Number.isFinite(lum)) return;
      const k = this.ambTarget > 0 ? this.ambTarget / lum : scene.environmentIntensity;
      scene.environmentIntensity = k;
      G.uAmbSky.value.setRGB(up[0] / wu * k, up[1] / wu * k, up[2] / wu * k);
      G.uAmbGround.value.setRGB(dn[0] / wd * k, dn[1] / wd * k, dn[2] / wd * k);
      this.ambLum = lum;
    } catch (e) { console.warn('[sky] ambient probe failed', e); }
  }

  // Blocking initialisation, split into small GPU jobs. `tick` is awaited
  // between jobs so the browser stays responsive.
  async init(time, tick) {
    this.time = time;
    const k = Math.floor(time / this.period);
    for (const kk of [k, k + 1]) {
      while (!this._renderSlot(kk, this.panoSize[0] / 8)) await tick();
    }
    this.renderGobo(time);
    this._bind(k, time);
  }

  _bind(k, time) {
    const a = this.slots.get(k), b = this.slots.get(k + 1);
    if (a) this.domeUniforms.uPanoA.value = a.rt.texture;
    if (b && b.done) this.domeUniforms.uPanoB.value = b.rt.texture;
    this.domeUniforms.uBlend.value = b && b.done ? (time / this.period - k) : 0;
    this.domeUniforms.uSkyDisplay.value = this.params.display;
  }

  // sync = true renders everything needed immediately (used by the film renderer)
  update(time, sync = false) {
    this.time = time;
    const k = Math.floor(time / this.period);
    for (const key of [...this.slots.keys()]) if (key < k || key > k + 2) this.slots.delete(key);
    const W = this.panoSize[0];
    if (sync) {
      this._renderSlot(k, W); this._renderSlot(k + 1, W);
    } else {
      if (!this._renderSlot(k, W / 16)) { /* catching up */ } else if (!this._renderSlot(k + 1, W / 32)) { /* catching up */ } else {
        // spread the next state evenly over the current period: a few pixel columns every frame
        const s = this.slots.get(k + 2);
        const phase = time / this.period - k;
        const want = Math.min(W, Math.ceil(phase * 1.25 * W));
        const have = s ? s.next : 0;
        if (have < want) this._renderSlot(k + 2, Math.min(want - have, W / 96));
      }
    }
    // the cloud field drifts a few centimetres per frame: its shadow map is refreshed one band every
    // other frame, a small even load instead of one larger job every few frames
    this._goboTick = (this._goboTick || 0) + 1;
    if (sync) this.renderGobo(time); else if (this._goboTick % 2 === 0) this.renderGobo(time, (this._goboTick >> 1) % this.goboBands);
    this._bind(k, time);
  }
}
