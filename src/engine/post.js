// Post-processing chain: ambient occlusion, volumetric sun shafts, bloom,
// filmic tone mapping + grade, FXAA / sharpening. All passes are hand written
// to stay light on an integrated GPU.
import * as THREE from 'three';
import { Pass } from './pass.js';
import { G, GLSL_COMMON } from './shared.js';

const DEPTH_LIB = /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
const float WEAPON_DEPTH = 0.02;
vec3 viewPosAt(vec2 uv, float d) {
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

const AO_FS = /* glsl */`
${DEPTH_LIB}
uniform vec2 uRes;       // resolution of the depth texture
uniform float uRadius;
uniform float uIntensity;
uniform float uProjScale;
uniform vec3 uSunView;   // sun direction in view space
uniform mat4 uProj;
uniform float uContact;
out vec4 outColor;
void main() {
  float d = texture(tDepth, vUv).r;
  if (d >= 1.0 || d < WEAPON_DEPTH) { outColor = vec4(1.0, 1.0, 0.0, 1.0); return; }
  vec3 P = viewPosAt(vUv, d);
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
#ifdef HQ
  // surfaces seen edge-on (leaf cards, grass blades) give unreliable normals at full resolution:
  // no occlusion there instead of dark streaks
  if (abs(dot(N, normalize(P))) < 0.18) { outColor = vec4(1.0, -P.z / 300.0, 0.0, 1.0); return; }
#endif
  float rPx = clamp(uRadius * uProjScale / -P.z, 3.0, 90.0);
  float rWorld = rPx * -P.z / uProjScale;
  float phi = ign(gl_FragCoord.xy) * 6.2831853;
#ifndef NS
#define NS 10
#endif
  float sum = 0.0, behind = 0.0;
  for (int i = 0; i < NS; i++) {
    float a = (float(i) + 0.5) / float(NS);
    float ang = a * 6.2831853 * 2.6 + phi;
    // HQ: every other sample probes a small radius for the fine detail (stones, steps, window frames)
    float rp = rPx, rw = rWorld;
#ifdef HQ
    if ((i & 1) == 1) { rp = max(2.0, rPx * 0.28); rw = rp * -P.z / uProjScale; }
#endif
    vec2 o = vec2(cos(ang), sin(ang)) * rp * sqrt(a) / uRes;
    vec2 uv = vUv + o;
    float dq = texture(tDepth, uv).r;
    if (dq < WEAPON_DEPTH) continue;
    vec3 Q = viewPosAt(uv, dq);
    vec3 v = Q - P;
    float vv = dot(v, v);
    float vn = dot(v, N);
    float f = max(rw * rw - vv, 0.0);
    behind += step(vn, -0.25 * rw);
    float r3 = rw * rw * rw;
    sum += f * f * f / (r3 * r3) * max((vn - 0.012 * -P.z * 0.1 - 0.01) / (vv + 0.001), 0.0);
  }
  float ao = max(0.0, 1.0 - sum * uIntensity * 5.0 / float(NS));
  // foliage: in a crown of alpha-cut leaf sprays many samples land on leaves well BEHIND this
  // pixel's plane, which solid surfaces (creases, ground, walls) almost never produce. The leaves
  // in front of it are only centimetres away and read as deep creases: dark streaks along every
  // card overlap, worst with the fine full-resolution samples on ultra. Soften AO there.
  float leafy = smoothstep(0.12, 0.35, behind / float(NS));
  ao = mix(ao, 1.0, leafy * 0.8);
  // fade AO out with distance (the far field uses baked lighting)
  ao = mix(ao, 1.0, smoothstep(140.0, 260.0, -P.z));
#ifdef CONTACT
  // contact shadows: a short screen-space march towards the sun catches the small occluders the
  // shadow map is too coarse for (grass, kerbs, door frames, debris). Folded into the AO term on
  // sun-facing surfaces only, so ambient-only areas are left alone.
  float ndl = dot(N, uSunView);
  // only on up-facing surfaces (ground, steps, ledges): inside tree crowns it draws streaks
  float upW = (mat3(uCamWorld) * N).y;
  if (ndl > 0.04 && -P.z < 48.0 && upW > 0.45 && leafy < 0.5) {
    float len = 0.6 + 0.03 * -P.z;
    float jit = ign(gl_FragCoord.xy + 23.0);
    float occ = 0.0;
    vec3 S0 = P + N * (0.004 * -P.z + 0.01);
    for (int i = 0; i < 10; i++) {
      float t = (float(i) + jit) / 10.0;
      vec3 S = S0 + uSunView * len * t;
      vec4 cp = uProj * vec4(S, 1.0);
      vec2 suv = cp.xy / cp.w * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) break;
      float sd = texture(tDepth, suv).r;
      if (sd < WEAPON_DEPTH) continue;
      float diff = viewPosAt(suv, sd).z - S.z;   // > 0: the scene is in front of the ray sample
      if (diff > 0.015 + 0.002 * -P.z && diff < 0.5 + 0.02 * -P.z) { occ = 1.0 - t * 0.5; break; }
    }
    float k = occ * smoothstep(48.0, 26.0, -P.z) * smoothstep(0.04, 0.3, ndl);
    ao *= 1.0 - uContact * k;
  }
#endif
  outColor = vec4(ao, -P.z / 300.0, 0.0, 1.0);
}`;

const AO_BLUR_FS = /* glsl */`
uniform sampler2D tAO;
uniform vec2 uTexel;
uniform vec2 uDir;
out vec4 outColor;
void main() {
  vec2 c = texture(tAO, vUv).rg;
  float sum = c.r * 0.3, w = 0.3;
  for (int i = 1; i <= 3; i++) {
    float k = (4.0 - float(i)) / 6.0 * 0.5;
    for (int s = -1; s <= 1; s += 2) {
      vec2 q = texture(tAO, vUv + uDir * uTexel * float(i * s) * 1.4).rg;
      float ww = k * max(0.0, 1.0 - abs(q.g - c.g) * 60.0 / max(c.g, 0.002));
      sum += q.r * ww; w += ww;
    }
  }
  outColor = vec4(sum / w, c.g, 0.0, 1.0);
}`;

const VOL_FS = /* glsl */`
${GLSL_COMMON}
${DEPTH_LIB}
uniform vec3 uCamPos;
uniform float uFrame;
uniform float uStrength;
uniform int uSteps;
uniform vec4 uSmoke;      // xyz centre of the village smoke haze, w density
uniform vec3 uSunUV;      // sun on screen: xy uv, z weight (0 when it is behind the camera / far off screen)
uniform int uRaySteps;
uniform float uRayStrength;
uniform float uAspect;
out vec4 outColor;
// screen-space light shafts: march from the pixel towards the sun and count the sky that shows
// (everything with geometry depth occludes: crowns, roof edges, the church tower)
float vmRays(float jitter) {
  vec2 dv = uSunUV.xy - vUv;
  float len = length(dv * vec2(uAspect, 1.0));
  float n = float(uRaySteps);
  vec2 st = dv / n;
  vec2 uv = vUv + st * jitter;
  float sum = 0.0, wsum = 0.0, w = 1.0;
  for (int i = 0; i < 64; i++) {
    if (i >= uRaySteps) break;
    float sky = 0.0;
    if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) sky = step(0.99999, texture(tDepth, uv).r);
    else sky = 0.6;   // off screen: assume mostly open sky
    sum += sky * w; wsum += w;
    w *= 0.985;
    uv += st;
  }
  float vis = sum / max(wsum, 1e-4);
  // brightest near the sun, a long tail across the frame
  return vis * (exp(-len * 2.6) * 0.8 + exp(-len * 0.7) * 0.25);
}
float hgp(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }
void main() {
  float d = texture(tDepth, vUv).r;
  vec3 vp = viewPosAt(vUv, d < WEAPON_DEPTH ? 1.0 : d);
  vec3 wp = (uCamWorld * vec4(vp, 1.0)).xyz;
  vec3 rd = wp - uCamPos;
  float dist = length(rd);
  rd /= dist;
  const float FAR_T = 11000.0;
  float maxT = (d >= 1.0 || d < WEAPON_DEPTH) ? FAR_T : min(dist, FAR_T);
  float jitter = ign(gl_FragCoord.xy + uFrame * vec2(5.3, 3.7));
  float T = 1.0, L = 0.0, La = 0.0, prev = 0.0;
  float n = float(uSteps);
  float texel = uCloudRect.z / float(textureSize(uCloudMap, 0).x);
  for (int i = 0; i < uSteps; i++) {
    float f = (float(i) + jitter) / n;
    float t = maxT * pow(f, 1.7);
    float dt = t - prev;
    vec3 p = uCamPos + rd * (prev + 0.5 * dt);
    prev = t;
    float haze = uHaze.x * exp(-uHaze.y * (p.y - uHaze.z));
    // drifting, patchy ground mist (prefiltered to the step length)
    vec2 mu = p.xz * 0.0031 + uWind.xy * uTime * 0.004;
    float nl = clamp(log2(dt * 0.8), 0.0, 6.0);
    float mn = textureLod(uNoiseTex, mu, nl).r * 0.65 + textureLod(uNoiseTex, mu * 3.1 + 0.37, nl + 1.6).g * 0.35;
    float mistB = uMist.x * exp(-uMist.y * max(p.y - uMist.z, -4.0));
    float mist = mistB * (0.35 + 1.5 * mn * mn);
    vec3 sd = p - uSmoke.xyz;
    float smoke = uSmoke.w * exp(-dot(sd.xz, sd.xz) / 15000.0 - max(sd.y, 0.0) / 40.0) * (0.35 + 1.3 * mn);
    float dens = haze + mist + smoke;
    // prefiltered cloud shadow: long steps read a coarser mip instead of aliasing
    float vis = vmCloudShadowLod(p, clamp(log2(dt / texel) - 1.5, 0.0, 5.0));
    float sc = dens * dt;
    // the thin upper air carries the shafts in front of the mountain flanks,
    // the air near the ground stays clear
    float hb = mix(0.5, 5.0, smoothstep(60.0, 520.0, p.y));
    L += T * (haze * hb + mist * 0.3 + smoke) * dt * vis;
    // mist banks and smoke also glow in the diffuse light of the sky
    La += T * (max(mist - mistB * 0.8, 0.0) + smoke) * dt;
    T *= exp(-sc);
  }
  float m = dot(rd, uSunDir);
  // a softened forward lobe: looking into the sun must not wash the valley out
  float phase = 0.2 * hgp(m, 0.6) + 0.38 * hgp(m, 0.18) + 0.25 * hgp(m, -0.25) + 0.04;
  // air scatters the short wavelengths: the lit haze is cooler than the sun itself
  vec3 col = uSunColor * vec3(0.82, 0.93, 1.1) * (L * phase * uStrength);
  col /= 1.0 + dot(col, vec3(0.3, 0.6, 0.1)) * 1.5;   // soft knee: shafts never burn out
  col += uFogColor * La;
  if (uSunUV.z > 0.001 && uRaySteps > 0) {
    // geometry in front of the sky gets the shafts only through the air in front of it
    float air = (d >= 1.0 || d < WEAPON_DEPTH) ? 1.0 : smoothstep(2.0, 40.0, dist);
    col += uSunColor * vec3(1.0, 0.86, 0.66) * (vmRays(jitter) * uSunUV.z * uRayStrength * air);
  }
  outColor = vec4(col, -vp.z / 300.0);
}`;

// scene colour with AO and the volumetrics applied (inlined in the tone pass)
const COMPOSITE_LIB = /* glsl */`
${DEPTH_LIB}
uniform sampler2D tColor;
uniform sampler2D tAO;
uniform sampler2D tVol;
uniform vec2 uVolTexel;
uniform float uAOAmount;
vec3 vmComposite() {
  vec4 c = texture(tColor, vUv);
  float d = texture(tDepth, vUv).r;
  float z = d < WEAPON_DEPTH ? 0.0 : -viewPosAt(vUv, d).z / 300.0;
  float ao = texture(tAO, vUv).r;
  // depth aware upsample of the low-res volumetrics
  vec4 acc = vec4(0.0); float w = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 uv = vUv + (vec2(float(i), float(j)) - 0.5) * uVolTexel;
    vec4 v = texture(tVol, uv);
    float ww = 1.0 / (0.002 + abs(v.a - z) / max(z, 0.002));
    acc += v * ww; w += ww;
  }
  vec3 vol = acc.rgb / w;
  if (d < WEAPON_DEPTH) { vol *= 0.0; ao = 1.0; }
  return c.rgb * mix(1.0, ao, uAOAmount) + vol;
}`;

const DOWN_FS = /* glsl */`
uniform sampler2D tSrc;
uniform sampler2D tAO;
uniform sampler2D tVol;
uniform float uAOAmount;
uniform vec2 uTexel;
uniform float uFirst;
out vec4 outColor;
void main() {
  vec3 a = texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 c = texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 d = texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  if (uFirst > 0.5) {
    // Karis average against fireflies on the first downsample
    float wa = 1.0 / (1.0 + max(a.r, max(a.g, a.b))), wb = 1.0 / (1.0 + max(b.r, max(b.g, b.b)));
    float wc = 1.0 / (1.0 + max(c.r, max(c.g, c.b))), wd = 1.0 / (1.0 + max(d.r, max(d.g, d.b)));
    vec3 s = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
    outColor = vec4(s * mix(1.0, texture(tAO, vUv).r, uAOAmount) + texture(tVol, vUv).rgb, 1.0);
  } else {
    outColor = vec4((a + b + c + d) * 0.25, 1.0);
  }
}`;

const UP_FS = /* glsl */`
uniform sampler2D tSrc;   // lower mip (blurred)
uniform sampler2D tBase;  // this mip
uniform vec2 uTexel;
uniform float uSpread;
out vec4 outColor;
void main() {
  vec3 s = vec3(0.0);
  s += texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  s += 2.0 * texture(tSrc, vUv + uTexel * vec2(0.0, 1.4)).rgb;
  s += 2.0 * texture(tSrc, vUv + uTexel * vec2(0.0, -1.4)).rgb;
  s += 2.0 * texture(tSrc, vUv + uTexel * vec2(1.4, 0.0)).rgb;
  s += 2.0 * texture(tSrc, vUv + uTexel * vec2(-1.4, 0.0)).rgb;
  s /= 12.0;
  outColor = vec4(mix(texture(tBase, vUv).rgb, s, uSpread), 1.0);
}`;

// Scene-referred -> display. Mode 0: SDR sRGB. Mode 1/2: HDR10 (PQ, Rec.2020)
// written as the high / low byte of a 16-bit code value for the film encoder.
const TONE_FS = /* glsl */`
${COMPOSITE_LIB}
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;
uniform sampler2D tWide;    // wide blur of the scene (a coarse level of the bloom pyramid)
uniform float uClarity;
uniform float uVibrance;
uniform float uPeak;        // display peak relative to diffuse white (1 = SDR)
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uFade;
uniform int uMode;
uniform float uPaperWhite;
uniform vec2 uRes;
out vec4 outColor;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// Uchimura "GT" tone curve with adjustable peak
vec3 gt(vec3 x, float P) {
  const float a = 1.0, m = 0.22, l = 0.4, c = 1.33, b = 0.0;
  float l0 = ((P - m) * l) / a;
  float S0 = m + l0, S1 = m + a * l0;
  float C2 = (a * P) / (P - S1);
  float CP = -C2 / P;
  vec3 w0 = 1.0 - smoothstep(0.0, m, x);
  vec3 w2 = step(m + l0, x);
  vec3 w1 = 1.0 - w0 - w2;
  vec3 T = m * pow(x / m, vec3(c)) + b;
  vec3 S = P - (P - S1) * exp(CP * (x - S0));
  vec3 L = m + a * (x - m);
  return T * w0 + L * w1 + S * w2;
}
vec3 srgbOETF(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 pqOETF(vec3 nits) {
  vec3 y = clamp(nits / 10000.0, 0.0, 1.0);
  const float m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  vec3 p = pow(y, vec3(m1));
  return pow((c1 + c2 * p) / (1.0 + c3 * p), vec3(m2));
}
// film renderer only: stage 1 stops at the scene-referred colour (for accumulating sub-frames in
// linear light), stage 2 takes such an accumulated picture from tScene and does the display part
uniform int uStage;
uniform sampler2D tScene;
uniform float uGrainScale;
uniform float uSoftClip;
void main() {
  vec3 col;
  if (uStage == 2) {
    col = texture(tScene, vUv).rgb;
  } else {
  vec3 hdr = vmComposite();
  vec3 bloom = texture(tBloom, vUv).rgb;
  col = mix(hdr, bloom, uBloom) * uExposure;
  // local contrast: each pixel is pushed away from the brightness of its wider surroundings
  if (uClarity > 0.0) {
    float lw = dot(texture(tWide, vUv).rgb, vec3(0.2126, 0.7152, 0.0722)) * uExposure;
    float lc = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= pow(clamp((lc + 0.03) / (lw + 0.03), 0.5, 2.0), uClarity);
  }
  // vignette in scene-referred space
  vec2 q = vUv - 0.5;
  float vig = 1.0 - uVignette * smoothstep(0.25, 0.95, dot(q, q) * 2.2);
  col *= vig;
  if (uStage == 1) { outColor = vec4(col, 1.0); return; }
  }
  // AgX-style inset so that bright saturated colours desaturate gracefully
  const mat3 inset = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                          0.0784335999999992, 0.878468636469772, 0.0784336,
                          0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 outset = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                           -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                           -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  col = inset * max(col, 0.0);
  col = gt(col, uPeak);
  col = outset * col;
  col = max(col, 0.0);
  // grade (display-linear)
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // vibrance: muted colours gain more than the ones that are already saturated
  float cmx = max(col.r, max(col.g, col.b)), cmn = min(col.r, min(col.g, col.b));
  col = mix(vec3(luma), col, uSaturation + uVibrance * (1.0 - (cmx - cmn) / max(cmx, 1e-3)));
  // contrast around mid grey; the gain is taken back out of the highlights so that plaster, snow
  // and clouds keep their detail instead of clipping
  vec3 cc = pow(col, vec3(uContrast)) * pow(0.18, 1.0 - uContrast);
  col = mix(cc, col, uContrast > 1.0 ? smoothstep(0.5, 1.0, luma) : 0.0);
  float sh = 1.0 - smoothstep(0.0, 0.35, luma);
  float hi = smoothstep(0.35, 1.0, luma);
  col *= mix(vec3(1.0), uShadowTint, sh) * mix(vec3(1.0), uHighlightTint, hi);
  col = col * uGain + uLift * (1.0 - col);
  // film renderer, SDR master only: a soft knee on the largest channel (hue kept), so sunlit plaster and
  // clouds roll off towards white with their texture instead of clipping (0 = off, the game's own look)
  if (uSoftClip > 0.0 && uMode == 0) {
    float mx = max(col.r, max(col.g, col.b)), kn = 1.0 - uSoftClip;
    if (mx > kn) col *= (kn + uSoftClip * (1.0 - exp(-(mx - kn) / uSoftClip))) / mx;
  }
  col = max(col, 0.0) * uFade;
  // film grain, stronger in the mid-tones
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 173.0) - 0.5;
  float gm = uGrain * uGrainScale * (0.35 + 0.65 * (1.0 - abs(luma * 2.0 - 1.0)));
  if (uMode == 0) {
    vec3 s = srgbOETF(clamp(col, 0.0, 1.0));
    s += g * gm;
    s += (hash12(gl_FragCoord.xy * 1.7 + 11.0) - 0.5) / 255.0;
    outColor = vec4(s, dot(s, vec3(0.299, 0.587, 0.114)));
  } else {
    // Rec.709 -> Rec.2020, absolute luminance, PQ
    const mat3 toBT2020 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0114, 0.8956);
    vec3 nits = toBT2020 * col * uPaperWhite;
    vec3 pq = pqOETF(nits);
    pq += g * gm * 0.6;
    vec3 code = floor(clamp(pq, 0.0, 1.0) * 65535.0 + 0.5);
    vec3 hiB = floor(code / 256.0);
    vec3 loB = code - hiB * 256.0;
    // mode 3: PQ signal as floats (the film renderer reads the target back directly)
    outColor = uMode == 3 ? vec4(clamp(pq, 0.0, 1.0), 1.0) : vec4((uMode == 1 ? hiB : loB) / 255.0, 1.0);
  }
}`;

const FINAL_FS = /* glsl */`
uniform sampler2D tLDR;
uniform vec2 uTexel;     // texel of the LDR source
uniform float uSharpen;
uniform float uFXAA;
out vec4 outColor;
vec3 fxaa(vec2 uv) {
  vec4 M4 = texture(tLDR, uv);
  float lM = M4.a;
  float lN = texture(tLDR, uv + vec2(0.0, -1.0) * uTexel).a;
  float lS = texture(tLDR, uv + vec2(0.0, 1.0) * uTexel).a;
  float lW = texture(tLDR, uv + vec2(-1.0, 0.0) * uTexel).a;
  float lE = texture(tLDR, uv + vec2(1.0, 0.0) * uTexel).a;
  float lMin = min(lM, min(min(lN, lS), min(lW, lE)));
  float lMax = max(lM, max(max(lN, lS), max(lW, lE)));
  float range = lMax - lMin;
  // only real edges are filtered: texture detail and grass keep their sharpness (MSAA covers geometry)
  if (range < max(0.05, lMax * 0.2)) return M4.rgb;
  float lNW = texture(tLDR, uv + vec2(-1.0, -1.0) * uTexel).a;
  float lNE = texture(tLDR, uv + vec2(1.0, -1.0) * uTexel).a;
  float lSW = texture(tLDR, uv + vec2(-1.0, 1.0) * uTexel).a;
  float lSE = texture(tLDR, uv + vec2(1.0, 1.0) * uTexel).a;
  vec2 dir;
  dir.x = -((lNW + lNE) - (lSW + lSE));
  dir.y = ((lNW + lSW) - (lNE + lSE));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcp, vec2(-6.0), vec2(6.0)) * uTexel;
  vec3 A = 0.5 * (texture(tLDR, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(tLDR, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 B = A * 0.5 + 0.25 * (texture(tLDR, uv + dir * -0.5).rgb + texture(tLDR, uv + dir * 0.5).rgb);
  float lB = dot(B, vec3(0.299, 0.587, 0.114));
  return (lB < lMin || lB > lMax) ? A : B;
}
void main() {
  vec3 c = uFXAA > 0.5 ? fxaa(vUv) : texture(tLDR, vUv).rgb;
  if (uSharpen > 0.0) {
    // contrast adaptive sharpening
    vec3 n = texture(tLDR, vUv + vec2(0.0, -1.0) * uTexel).rgb;
    vec3 s = texture(tLDR, vUv + vec2(0.0, 1.0) * uTexel).rgb;
    vec3 w = texture(tLDR, vUv + vec2(-1.0, 0.0) * uTexel).rgb;
    vec3 e = texture(tLDR, vUv + vec2(1.0, 0.0) * uTexel).rgb;
    vec3 mn = min(c, min(min(n, s), min(w, e)));
    vec3 mx = max(c, max(max(n, s), max(w, e)));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
    vec3 wgt = -amp * (0.125 + 0.075 * uSharpen) * uSharpen;
    c = clamp((c + (n + s + w + e) * wgt) / (1.0 + 4.0 * wgt), 0.0, 1.0);
  }
  // luma in alpha: the upscaler steers its kernel by it
  outColor = vec4(c, dot(c, vec3(0.299, 0.587, 0.114)));
}`;

// Edge-adaptive spatial upscale (the idea of FSR 1 "EASU", written from scratch): 12 source texels
// around the output position, a local gradient gives the edge direction and how strongly it is an
// edge; a windowed lanczos-like kernel is stretched along the edge and narrowed across it, and the
// result is clamped to the 2x2 neighbourhood so the negative lobes cannot ring.
const EASU_FS = /* glsl */`
uniform sampler2D tSrc;      // LDR, luma in alpha
uniform vec2 uSrcSize;
out vec4 outColor;
ivec2 gMax;
vec4 tap(ivec2 p) { return texelFetch(tSrc, clamp(p, ivec2(0), gMax), 0); }
void dirOf(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  // lA up, lB left, lC centre, lD right, lE down
  float dc = lD - lB, cb = lC - lB, dc2 = lD - lC;
  float lx = clamp(abs(dc) / max(max(abs(cb), abs(dc2)), 1e-5), 0.0, 1.0);
  float ec = lE - lA, ca = lC - lA, ec2 = lE - lC;
  float ly = clamp(abs(ec) / max(max(abs(ca), abs(ec2)), 1e-5), 0.0, 1.0);
  dir += vec2(dc, ec) * w;
  len += (lx * lx + ly * ly) * w;
}
void acc(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, -off.x * dir.y + off.y * dir.x) * len2;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0, wA = lob * d2 - 1.0;
  wB *= wB; wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aC += c * w; aW += w;
}
void main() {
  gMax = ivec2(uSrcSize) - 1;
  vec2 p = vUv * uSrcSize - 0.5;
  vec2 fp = floor(p), f = p - fp;
  ivec2 i0 = ivec2(fp);
  //      b c
  //    e f g h
  //    i j k l
  //      n o
  vec4 b = tap(i0 + ivec2(0, -1)), c = tap(i0 + ivec2(1, -1));
  vec4 e = tap(i0 + ivec2(-1, 0)), F = tap(i0), g = tap(i0 + ivec2(1, 0)), h = tap(i0 + ivec2(2, 0));
  vec4 i = tap(i0 + ivec2(-1, 1)), j = tap(i0 + ivec2(0, 1)), k = tap(i0 + ivec2(1, 1)), l = tap(i0 + ivec2(2, 1));
  vec4 n = tap(i0 + ivec2(0, 2)), o = tap(i0 + ivec2(1, 2));
  vec2 dir = vec2(0.0); float len = 0.0;
  dirOf(dir, len, (1.0 - f.x) * (1.0 - f.y), b.a, e.a, F.a, g.a, j.a);
  dirOf(dir, len, f.x * (1.0 - f.y), c.a, F.a, g.a, h.a, k.a);
  dirOf(dir, len, (1.0 - f.x) * f.y, F.a, i.a, j.a, k.a, n.a);
  dirOf(dir, len, f.x * f.y, g.a, j.a, k.a, l.a, o.a);
  float d2 = dot(dir, dir);
  bool flat_ = d2 < 1.0 / 32768.0;
  dir = flat_ ? vec2(1.0, 0.0) : dir * inversesqrt(d2);
  len = len * 0.5; len *= len;
  // stretch along the edge: 1 on the axes, sqrt(2) on diagonals
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 - 0.29 * len;
  float clp = 1.0 / lob;
  vec3 aC = vec3(0.0); float aW = 0.0;
  acc(aC, aW, vec2(0.0, -1.0) - f, dir, len2, lob, clp, b.rgb);
  acc(aC, aW, vec2(1.0, -1.0) - f, dir, len2, lob, clp, c.rgb);
  acc(aC, aW, vec2(-1.0, 0.0) - f, dir, len2, lob, clp, e.rgb);
  acc(aC, aW, vec2(0.0, 0.0) - f, dir, len2, lob, clp, F.rgb);
  acc(aC, aW, vec2(1.0, 0.0) - f, dir, len2, lob, clp, g.rgb);
  acc(aC, aW, vec2(2.0, 0.0) - f, dir, len2, lob, clp, h.rgb);
  acc(aC, aW, vec2(-1.0, 1.0) - f, dir, len2, lob, clp, i.rgb);
  acc(aC, aW, vec2(0.0, 1.0) - f, dir, len2, lob, clp, j.rgb);
  acc(aC, aW, vec2(1.0, 1.0) - f, dir, len2, lob, clp, k.rgb);
  acc(aC, aW, vec2(2.0, 1.0) - f, dir, len2, lob, clp, l.rgb);
  acc(aC, aW, vec2(0.0, 2.0) - f, dir, len2, lob, clp, n.rgb);
  acc(aC, aW, vec2(1.0, 2.0) - f, dir, len2, lob, clp, o.rgb);
  vec3 mn = min(min(F.rgb, g.rgb), min(j.rgb, k.rgb)), mx = max(max(F.rgb, g.rgb), max(j.rgb, k.rgb));
  outColor = vec4(clamp(aC / max(aW, 1e-5), mn, mx), 1.0);
}`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.settings = {
      ao: true, aoRadius: 1.0, aoIntensity: 1.4, aoAmount: 0.92,
      volumetric: true, volSteps: 22, volStrength: 0.7, volScale: 3, raySteps: 24, rayStrength: 0.05, aoFull: false,
      bloom: 0.045, exposure: 1.0, contrast: 1.14, saturation: 1.04, vibrance: 0.25, clarity: 0.22,
      vignette: 0.22, grain: 0.012, sharpen: 0.8, fxaa: true, fade: 1,
      peak: 1.0, paperWhite: 203, mode: 0,
    };
    this.frame = 0;
    const depthU = { tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() } };
    this.depthU = depthU;
    const aoU = { ...depthU, uRes: { value: new THREE.Vector2() }, uRadius: { value: 0.7 }, uIntensity: { value: 1 }, uProjScale: { value: 500 }, uSunView: { value: new THREE.Vector3(0, 1, 0) }, uProj: { value: new THREE.Matrix4() }, uContact: { value: 0.75 } };
    this.aoBase = new Pass(AO_FS, aoU);
    this.aoHQ = new Pass('#define NS 16\n#define HQ\n#define CONTACT\n' + AO_FS, aoU);   // ultra: fine + wide AO, contact shadows
    this.ao = this.aoBase;
    this.easu = new Pass(EASU_FS, { tSrc: { value: null }, uSrcSize: { value: new THREE.Vector2() } });
    this.aoBlur = new Pass(AO_BLUR_FS, { tAO: { value: null }, uTexel: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2() } });
    this.vol = new Pass(VOL_FS, { ...G, ...depthU, uCamPos: { value: new THREE.Vector3() }, uFrame: { value: 0 }, uStrength: { value: 1 }, uSteps: { value: 22 }, uSmoke: { value: new THREE.Vector4(35, 12, -80, 0.0003) }, uSunUV: { value: new THREE.Vector3() }, uRaySteps: { value: 0 }, uRayStrength: { value: 0.05 }, uAspect: { value: 1.6 } });
    this._sv = new THREE.Vector3(); this._cf = new THREE.Vector3();
    const compU = { tAO: { value: null }, tVol: { value: null }, uVolTexel: { value: new THREE.Vector2() }, uAOAmount: { value: 1 } };
    this.down = new Pass(DOWN_FS, { tSrc: { value: null }, tAO: compU.tAO, tVol: compU.tVol, uAOAmount: compU.uAOAmount, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.up = new Pass(UP_FS, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uSpread: { value: 0.6 } });
    this.tone = new Pass(TONE_FS, {
      ...depthU, ...compU, tColor: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uBloom: { value: 0.04 }, uPeak: { value: 1 },
      tWide: { value: null }, uClarity: { value: 0 }, uVibrance: { value: 0 },
      uContrast: { value: 1 }, uSaturation: { value: 1 }, uLift: { value: new THREE.Vector3(0, 0, 0) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uShadowTint: { value: new THREE.Vector3(0.93, 0.99, 1.08) }, uHighlightTint: { value: new THREE.Vector3(1.05, 1.0, 0.93) },
      uVignette: { value: 0.3 }, uGrain: { value: 0.01 }, uTime: { value: 0 }, uFade: { value: 1 }, uMode: { value: 0 }, uPaperWhite: { value: 203 }, uRes: { value: new THREE.Vector2() },
      uStage: { value: 0 }, tScene: { value: null }, uGrainScale: { value: 1 }, uSoftClip: { value: 0 },
    });
    this.final = new Pass(FINAL_FS, { tLDR: { value: null }, uTexel: { value: new THREE.Vector2() }, uSharpen: { value: 0.4 }, uFXAA: { value: 1 } });
    this.targets = null;
  }

  // Target sets are cached per size (the dynamic resolution moves between a few fixed sizes and
  // must not reallocate on every step); the three most recently used sets are kept.
  setSize(w, h) {
    this._cache = this._cache || new Map();
    const st = this.settings;
    const key = `${w}x${h}x${st.volScale}x${st.aoFull ? 1 : 0}x${st.ao ? 1 : 0}${st.volumetric ? 1 : 0}x${st.bloomLevels ?? 6}`;
    let t = this._cache.get(key);
    if (t) this._cache.delete(key); else t = this._makeTargets(w, h);
    this._cache.set(key, t);
    while (this._cache.size > 3) {
      const [k0, old] = this._cache.entries().next().value;
      this._cache.delete(k0); this._disposeSet(old);
    }
    this.targets = t; this.w = w; this.h = h;
  }

  _makeTargets(w, h) {
    const hf = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    const hw = Math.max(2, Math.ceil(w / 2)), hh = Math.max(2, Math.ceil(h / 2));
    const vs = this.settings.volScale;
    // ultra: AO and contact shadows at the full render size (small objects sit on the ground)
    // (AO or volumetrics switched off, as on the phone tiers: a token 4x4 target the tone pass reads)
    const ao = this.settings.ao, vol = this.settings.volumetric;
    const aw = !ao ? 4 : this.settings.aoFull ? w : hw, ah = !ao ? 4 : this.settings.aoFull ? h : hh;
    const t = {
      ao: new THREE.WebGLRenderTarget(aw, ah, { ...hf }),
      aoB: new THREE.WebGLRenderTarget(aw, ah, { ...hf }),
      vol: new THREE.WebGLRenderTarget(vol ? Math.ceil(w / vs) : 4, vol ? Math.ceil(h / vs) : 4, { ...hf }),
      ldr: new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
      mips: [],
    };
    // the bloom pyramid starts at quarter resolution
    let mw = Math.max(2, Math.ceil(w / 4)), mh = Math.max(2, Math.ceil(h / 4));
    const levels = this.settings.bloomLevels ?? 6;   // (fewer on the phone tiers: a tighter glow, fewer passes)
    for (let i = 0; i < levels && mw > 8 && mh > 8; i++) {
      t.mips.push(new THREE.WebGLRenderTarget(mw, mh, { ...hf }));
      mw = Math.ceil(mw / 2); mh = Math.ceil(mh / 2);
    }
    return t;
  }

  _disposeSet(t) {
    [t.ao, t.aoB, t.vol, t.ldr, t.aa, ...t.mips, ...(t.ups || [])].forEach((r) => r && r.dispose());
  }

  // drops every cached target set (quality change)
  dispose() {
    if (this._cache) { for (const t of this._cache.values()) this._disposeSet(t); this._cache.clear(); }
    else if (this.targets) this._disposeSet(this.targets);
    this.targets = null;
  }

  // sceneRT: HDR colour + depth. output: null (screen) or a render target.
  render(sceneRT, camera, time, output = null, outW = 0, outH = 0) {
    const r = this.renderer, s = this.settings, t = this.targets;
    this.frame++;
    const du = this.depthU;
    du.tDepth.value = sceneRT.depthTexture;
    du.uProjInv.value.copy(camera.projectionMatrixInverse);
    du.uCamWorld.value.copy(camera.matrixWorld);

    if (s.ao) {
      this.ao = s.aoHQ ? this.aoHQ : this.aoBase;
      const u = this.ao.uniforms;
      u.uRes.value.set(t.ao.width, t.ao.height);
      u.uRadius.value = s.aoRadius; u.uIntensity.value = s.aoIntensity;
      if (s.aoHQ) {
        u.uSunView.value.copy(G.uSunDir.value).transformDirection(camera.matrixWorldInverse);
        u.uProj.value.copy(camera.projectionMatrix);
        u.uContact.value = s.contact ?? 0.75;
      }
      u.uProjScale.value = t.ao.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      this.ao.render(r, t.ao);
      const b = this.aoBlur.uniforms;
      b.uTexel.value.set(1 / t.ao.width, 1 / t.ao.height);
      b.tAO.value = t.ao.texture; b.uDir.value.set(1, 0); this.aoBlur.render(r, t.aoB);
      b.tAO.value = t.aoB.texture; b.uDir.value.set(0, 1); this.aoBlur.render(r, t.ao);
    }
    if (s.volumetric) {
      const u = this.vol.uniforms;
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.uFrame.value = this.frame % 64; u.uStrength.value = s.volStrength; u.uSteps.value = s.volSteps;
      // sun on screen for the light shafts
      const sv = this._sv.copy(G.uSunDir.value).multiplyScalar(5000).add(u.uCamPos.value).project(camera);
      camera.getWorldDirection(this._cf);
      const facing = this._cf.dot(G.uSunDir.value);
      const off = Math.max(Math.abs(sv.x), Math.abs(sv.y));
      u.uSunUV.value.set(sv.x * 0.5 + 0.5, sv.y * 0.5 + 0.5, facing > 0 ? THREE.MathUtils.smoothstep(facing, 0.05, 0.45) * (1 - THREE.MathUtils.smoothstep(off, 1.1, 2.2)) : 0);
      u.uRaySteps.value = s.raySteps ?? 0; u.uRayStrength.value = s.rayStrength ?? 0.05; u.uAspect.value = camera.aspect;
      this.vol.render(r, t.vol);
    } else {
      r.setRenderTarget(t.vol); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    }
    {
      const u = this.tone.uniforms;
      u.tColor.value = sceneRT.texture; u.tAO.value = t.ao.texture; u.tVol.value = t.vol.texture;
      u.uVolTexel.value.set(1 / t.vol.width, 1 / t.vol.height);
      u.uAOAmount.value = s.ao ? s.aoAmount : 0;
    }
    // bloom pyramid
    {
      const d = this.down.uniforms;
      let src = sceneRT;
      for (let i = 0; i < t.mips.length; i++) {
        d.tSrc.value = src.texture; d.uTexel.value.set(1 / src.width, 1 / src.height); d.uFirst.value = i === 0 ? 1 : 0;
        this.down.render(r, t.mips[i]);
        src = t.mips[i];
      }
      const u = this.up.uniforms;
      for (let i = t.mips.length - 1; i > 0; i--) {
        // blend mip i into mip i-1 (ping through comp is avoided: read both, write to i-1 via ldr-sized temp not needed)
        u.tSrc.value = t.mips[i].texture; u.tBase.value = t.mips[i - 1].texture;
        u.uTexel.value.set(1 / t.mips[i].width, 1 / t.mips[i].height);
        // WebGL forbids sampling the target being written, so bounce through aoB-sized? use a copy chain instead:
        this._bloomUp(i);
      }
    }
    {
      const u = this.tone.uniforms;
      u.tBloom.value = this._bloomResult.texture;
      u.uExposure.value = s.exposure; u.uBloom.value = s.bloom; u.uPeak.value = s.peak;
      u.uContrast.value = s.contrast; u.uSaturation.value = s.saturation;
      u.uVibrance.value = s.vibrance ?? 0; u.uClarity.value = s.clarity ?? 0;
      u.tWide.value = t.mips[Math.min(2, t.mips.length - 1)].texture;
      u.uVignette.value = s.vignette; u.uGrain.value = s.grain; u.uTime.value = time; u.uFade.value = s.fade;
      u.uMode.value = s.mode; u.uPaperWhite.value = s.paperWhite; u.uRes.value.set(this.w, this.h);
    }
    if (s.mode !== 0) {
      // HDR capture path: the caller reads the two byte planes itself
      this.tone.render(r, output);
      return;
    }
    this.tone.render(r, t.ldr);
    const f = this.final.uniforms;
    f.tLDR.value = t.ldr.texture; f.uTexel.value.set(1 / t.ldr.width, 1 / t.ldr.height);
    f.uFXAA.value = s.fxaa ? 1 : 0;
    const ow = output ? output.width : outW, oh = output ? output.height : outH;
    const upscale = ow > 0 && (ow !== this.w || oh !== this.h);
    if (!upscale) {
      f.uSharpen.value = s.sharpen;
      r.setRenderTarget(output);
      if (!output && outW) r.setViewport(0, 0, outW, outH);
      this.final.render(r, output);
      return;
    }
    // below display size: anti-alias + contrast-adaptive sharpening at the render size (a little
    // stronger the further the scale is down), then the edge-adaptive upscale to the display
    if (!t.aa) t.aa = new THREE.WebGLRenderTarget(this.w, this.h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const down = Math.min(1, Math.max(0, 1 - this.w / ow));
    f.uSharpen.value = Math.min(1.0, s.sharpen + down * 0.9);   // (the CAS weight is only stable up to 1)
    this.final.render(r, t.aa);
    const e = this.easu.uniforms;
    e.tSrc.value = t.aa.texture; e.uSrcSize.value.set(this.w, this.h);
    r.setRenderTarget(output);
    if (!output) r.setViewport(0, 0, outW, outH);
    this.easu.render(r, output);
  }

  _bloomUp(i) {
    // lazily create the upsample chain targets (same sizes as mips[0..n-2])
    const t = this.targets;
    if (!t.ups) {
      t.ups = t.mips.slice(0, -1).map((m) => new THREE.WebGLRenderTarget(m.width, m.height, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    }
    const u = this.up.uniforms;
    const lower = i === t.mips.length - 1 ? t.mips[i] : t.ups[i];
    u.tSrc.value = lower.texture; u.tBase.value = t.mips[i - 1].texture;
    u.uTexel.value.set(1 / lower.width, 1 / lower.height);
    this.up.render(this.renderer, t.ups[i - 1]);
    this._bloomResult = t.ups[0];
  }
}
