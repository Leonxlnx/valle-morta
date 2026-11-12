// Uniforms and GLSL shared by every material in the game: atmosphere/fog,
// cloud shadows and wind. Materials reference the same uniform objects, so
// updating a value here updates the whole scene.
import * as THREE from 'three';

export const G = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.3).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.93, 0.82) },
  // xyz = ambient in-scatter colour, sun-ward in-scatter colour
  uFogColor: { value: new THREE.Color(0.37, 0.42, 0.49) },
  uFogSunColor: { value: new THREE.Color(0.95, 0.86, 0.72) },
  // haze: x = density at y0, y = 1/scaleHeight, z = y0 ; mist: same
  uHaze: { value: new THREE.Vector3(0.000085, 1 / 1100, 0) },
  uMist: { value: new THREE.Vector3(0.00028, 1 / 34, -2) },
  // cloud gobo: xy = centre (world xz), z = world size, w = cloud base height
  uCloudMap: { value: null },
  uCloudRect: { value: new THREE.Vector4(0, 0, 24000, 3300) },
  uCloudShadowMin: { value: 0.05 },
  uCloudRot: { value: 0 },
  // wind: xy = direction, z = strength, w = gustiness
  uWind: { value: new THREE.Vector4(0.8, 0.6, 1.0, 0.5) },
  uNoiseTex: { value: null },
  // average sky / ground-bounce radiance for cheap custom-shaded materials
  // (grass, water, particles) that do not use the PMREM environment
  uAmbSky: { value: new THREE.Color(0.2, 0.22, 0.25) },
  uAmbGround: { value: new THREE.Color(0.05, 0.055, 0.04) },
};

export const GLSL_COMMON = /* glsl */`
#ifndef VM_COMMON
#define VM_COMMON
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform vec3 uHaze;
uniform vec3 uMist;
uniform sampler2D uCloudMap;
uniform vec4 uCloudRect;
uniform float uCloudShadowMin;
uniform float uCloudRot;
uniform vec4 uWind;
uniform sampler2D uNoiseTex;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
// hemispherical ambient radiance for a world-space normal
vec3 vmAmbient(vec3 n) { return mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5); }

float vmFogIntegral(vec3 layer, float camY, float dy, float dist) {
  float b = layer.y;
  float t = b * dy;
  float f = abs(t) > 1e-3 ? (1.0 - exp(-t)) / t : 1.0 - 0.5 * t;
  return layer.x * exp(-b * (camY - layer.z)) * dist * f;
}
// transmittance of the atmosphere between the camera and a world position
float vmFogTransmittance(vec3 camPos, vec3 worldPos) {
  vec3 v = worldPos - camPos;
  float dist = length(v);
  float od = vmFogIntegral(uHaze, camPos.y, v.y, dist) + vmFogIntegral(uMist, camPos.y, v.y, dist);
  return exp(-od);
}
vec3 vmFogColor(vec3 viewDir) {
  float s = max(dot(viewDir, uSunDir), 0.0);
  float fwd = 0.55 * pow(s, 6.0) + 0.45 * pow(s, 48.0);
  // slightly darker / bluer towards the ground, brighter towards the zenith
  float up = clamp(viewDir.y * 2.0 + 0.5, 0.0, 1.0);
  return mix(uFogColor * (0.82 + 0.18 * up), uFogSunColor, fwd * 0.35);
}
vec3 vmApplyFog(vec3 color, vec3 camPos, vec3 worldPos) {
  float T = vmFogTransmittance(camPos, worldPos);
  return color * T + vmFogColor(normalize(worldPos - camPos)) * (1.0 - T);
}
// sun visibility through the cloud layer at a world position (0..1)
float vmCloudShadow(vec3 worldPos) {
  vec2 p = worldPos.xz + uSunDir.xz / max(uSunDir.y, 0.05) * (uCloudRect.w - worldPos.y);
  float c = cos(uCloudRot), s = sin(uCloudRot);
  p = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  vec2 uv = (p - uCloudRect.xy) / uCloudRect.z + 0.5;
  float t = texture2D(uCloudMap, uv).r;
  return mix(uCloudShadowMin, 1.0, t);
}
// same with an explicit mip level: a prefiltered shadow for coarse ray-march steps
float vmCloudShadowLod(vec3 worldPos, float lod) {
  vec2 p = worldPos.xz + uSunDir.xz / max(uSunDir.y, 0.05) * (uCloudRect.w - worldPos.y);
  float c = cos(uCloudRot), s = sin(uCloudRot);
  p = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  vec2 uv = (p - uCloudRect.xy) / uCloudRect.z + 0.5;
  return mix(uCloudShadowMin, 1.0, textureLod(uCloudMap, uv, lod).r);
}
#endif
`;

export function bindShared(uniforms) {
  for (const k in G) uniforms[k] = G[k];
  return uniforms;
}
