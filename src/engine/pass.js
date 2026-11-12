// Tiny fullscreen-pass helper (GLSL ES 3.0, one big triangle).
import * as THREE from 'three';

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

const VS = /* glsl */`
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FS_HEAD = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
precision highp sampler2DArray;
#define texture2D texture
in vec2 vUv;
`;

const cam = new THREE.Camera();

export class Pass {
  constructor(fragment, uniforms = {}, opts = {}) {
    this.uniforms = uniforms;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VS,
      fragmentShader: FS_HEAD + fragment,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      transparent: opts.blending !== undefined,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }

  render(renderer, target = null, layer = 0) {
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target, layer);
    renderer.render(this.scene, cam);
    renderer.autoClear = prevAuto;
  }

  dispose() { this.material.dispose(); }
}

export const fullscreenGeometry = geo;
