// Patches three.js built-in materials so that everything in the world shares
// the same atmosphere (height fog + haze), cloud shadows on the sun, and
// optional custom vertex / surface code.
import * as THREE from 'three';
import { G, GLSL_COMMON, bindShared } from './shared.js';

const LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= vmCloudShadow( vmWorldPos );',
);

const WORLD_POS_VERTEX = /* glsl */`
{
  vec4 vmwp = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    vmwp = batchingMatrix * vmwp;
  #endif
  #ifdef USE_INSTANCING
    vmwp = instanceMatrix * vmwp;
  #endif
  vmWorldPos = ( modelMatrix * vmwp ).xyz;
}`;

let keyCounter = 0;

/**
 * opts:
 *   uniforms        extra uniforms { name: {value} }
 *   vertexPars      GLSL added before main() of the vertex shader
 *   vertexBegin     GLSL run right after <begin_vertex> (may modify `transformed`)
 *   vertexNormal    GLSL run right after <beginnormal_vertex> (may modify `objectNormal`)
 *   fragmentPars    GLSL added before main() of the fragment shader
 *   surface         GLSL run after the maps were sampled; may modify diffuseColor,
 *                   roughnessFactor, metalnessFactor, normal
 *   ao              GLSL expression multiplied into ambient light
 *   emissive        GLSL adding to totalEmissiveRadiance
 *   noFog           skip atmosphere
 *   patch(shader)   last-chance hook
 */
export function enhance(material, opts = {}) {
  const key = opts.key || `vm${keyCounter++}`;
  material.onBeforeCompile = (shader) => {
    bindShared(shader.uniforms);
    if (opts.uniforms) Object.assign(shader.uniforms, opts.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\nvarying vec3 vmWorldPos;\n${opts.vertexPars || ''}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${opts.vertexNormal || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertexBegin || ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_POS_VERTEX}`);
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\nvarying vec3 vmWorldPos;\n${opts.fragmentPars || ''}`)
      .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN);
    if (opts.surface) {
      // run after normal maps so the hook can override everything
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${opts.surface}`);
    }
    if (opts.ao) {
      fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>\n{ float vmAO = ${opts.ao}; reflectedLight.indirectDiffuse *= vmAO; reflectedLight.indirectSpecular *= vmAO; }`);
    }
    if (opts.emissive) {
      fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${opts.emissive}`);
    }
    if (!opts.noFog) {
      fs = fs.replace('#include <fog_fragment>', 'gl_FragColor.rgb = vmApplyFog( gl_FragColor.rgb, cameraPosition, vmWorldPos );');
    }
    shader.fragmentShader = fs;
    if (opts.patch) opts.patch(shader);
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}

// Depth material sharing a vertex deformation (for shadow casting of
// displaced / wind-animated geometry).
export function makeDepthMaterial(opts = {}) {
  const m = new THREE.MeshDepthMaterial({ alphaTest: opts.alphaTest ?? 0, map: opts.map ?? null });
  const key = opts.key || `vmd${keyCounter++}`;
  m.onBeforeCompile = (shader) => {
    bindShared(shader.uniforms);
    if (opts.uniforms) Object.assign(shader.uniforms, opts.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\n${opts.vertexPars || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertexBegin || ''}`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

export { G };
