// Engine: WebGL renderer, HDR scene target, sun + shadow rig, sky and the
// post chain. The world camera and the first-person weapon camera share one
// depth buffer (the weapon is squeezed into the first 2% of the depth range).
import * as THREE from 'three';
import { G } from './shared.js';
import { Sky } from './sky.js';
import { PostFX } from './post.js';

// Each preset is one deliberate bundle (measured on the integrated Radeon 780M, street view):
//   low     1280x720 laptops on battery: 0.6 scale, small shadow map, no AO
//   medium  1920x1080 at 60 fps: 0.75 scale, 2048 shadows over 70 m, half the grass
//   high    1280x720 at 60 fps (14 ms): native scale, FXAA instead of MSAA, 2048 shadows over 95 m
//   ultra   the film and fast GPUs: MSAA 4, 4096 shadows over 130 m, 4K sky, full grass
// shadowFade: the outer part of the shadow volume (as a fraction of its half width) fades out
export const QUALITY = {
  low:    { scale: 0.6,  msaa: 0, shadow: 1024, shadowRange: 55,  pano: [1024, 256],  cloudSteps: 36, ao: false, vol: true, volSteps: 12, volScale: 4, texSize: 512,  grass: 0.35, aniso: 2,  far: 0.5, sharpen: 0.8 },
  medium: { scale: 0.75, msaa: 0, shadow: 2048, shadowRange: 70,  pano: [2048, 512],  cloudSteps: 44, ao: true,  vol: true, volSteps: 16, volScale: 4, texSize: 1024, grass: 0.55, aniso: 4,  far: 1,   sharpen: 0.9 },
  high:   { scale: 1.0,  msaa: 0, shadow: 2048, shadowRange: 95,  pano: [2048, 512],  cloudSteps: 48, ao: true,  vol: true, volSteps: 18, volScale: 3, texSize: 1024, grass: 0.8,  aniso: 8,  far: 1,   sharpen: 0.95 },
  ultra:  { scale: 1.0,  msaa: 4, shadow: 4096, shadowRange: 130, pano: [4096, 1024], cloudSteps: 72, ao: true,  vol: true, volSteps: 30, volScale: 2, texSize: 2048, grass: 1.0,  aniso: 16, far: 1,   sharpen: 0.8 },
};

// Shadows fade out over the rim of the shadow volume instead of ending in a hard line (the volume
// is a square centred on the viewer, so the rim is far away in every direction).
{
  const C = THREE.ShaderChunk, src = C.shadowmap_pars_fragment, cut = src.indexOf('getPointShadow');
  const head = cut > 0 ? src.slice(0, cut) : src;
  C.shadowmap_pars_fragment = head.replaceAll('return mix( 1.0, shadow, shadowIntensity );',
    'return mix( 1.0, shadow, shadowIntensity * ( 1.0 - smoothstep( 0.86, 0.985, max( abs( shadowCoord.x * 2.0 - 1.0 ), abs( shadowCoord.y * 2.0 - 1.0 ) ) ) ) );') + (cut > 0 ? src.slice(cut) : '');
}

export class Engine {
  constructor(canvas, qualityName = 'high') {
    this.canvas = canvas;
    this.qualityName = qualityName;
    this.q = { ...QUALITY[qualityName] };
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = false;
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.2, 60000);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.weaponCamera = new THREE.PerspectiveCamera(52, 16 / 9, 0.02, 40);
    this.weaponCamera.layers.set(1);
    this.weaponCamera.matrixAutoUpdate = false;

    // sun
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.layers.enableAll();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.05;
    this.sun.shadow.radius = 1.7;
    this.scene.add(this.sun, this.sun.target);
    // due west, 33 deg up: side light with long shadows for the views up the valley, and the
    // west and south-west faces of the village in full sun
    this.sunDir = new THREE.Vector3(-0.84, 0.54, 0.04).normalize();
    this.sunIntensity = 8.5;
    this.sunTint = new THREE.Color(1.0, 0.89, 0.72);
    // sky irradiance / pi on level ground; the image-based light is normalised to it.
    // Sunlit level ground is about 4.5 times as bright as the shade next to it.
    this.ambient = 0.42;

    this.sky = new Sky(renderer, { panoSize: this.q.pano, steps: this.q.cloudSteps });
    this.scene.add(this.sky.dome);
    this.sky.ambTarget = this.ambient;
    this.post = new PostFX(renderer);
    this.time = 0;
    this.renderScale = this.q.scale;
    this.sceneRT = null;
    this.outW = 0; this.outH = 0;
    this._v = new THREE.Vector3();
    this._sb = { up: new THREE.Vector3(), right: new THREE.Vector3(), upL: new THREE.Vector3(), c: new THREE.Vector3() };
    this._applySun();
  }

  _applySun() {
    G.uSunDir.value.copy(this.sunDir);
    this.sun.color.copy(this.sunTint);
    this.sun.intensity = this.sunIntensity;
    G.uSunColor.value.copy(this.sunTint).multiplyScalar(this.sunIntensity);
  }

  setSun(dir, intensity) {
    if (dir) this.sunDir.copy(dir).normalize();
    if (intensity !== undefined) this.sunIntensity = intensity;
    this._applySun();
  }

  setQuality(name) {
    this.qualityName = name;
    this.q = { ...QUALITY[name] };
    this.renderScale = this.q.scale;
    this.sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.resize(this.outW, this.outH);
  }

  resize(outW, outH) {
    this.outW = outW; this.outH = outH;
    this.renderer.setSize(outW, outH, false);
    const w = Math.max(64, Math.round(outW * this.renderScale / 2) * 2);
    const h = Math.max(64, Math.round(outH * this.renderScale / 2) * 2);
    if (this.sceneRT) { this.sceneRT.depthTexture.dispose(); this.sceneRT.dispose(); }
    const depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples: this.q.msaa, depthTexture,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    const s = this.post.settings;
    s.ao = this.q.ao; s.volumetric = this.q.vol; s.volSteps = this.q.volSteps; s.volScale = this.q.volScale;
    if (this.q.sharpen !== undefined) s.sharpen = this.q.sharpen;
    this.post.setSize(w, h);
    this.camera.aspect = outW / outH; this.camera.updateProjectionMatrix();
    this.weaponCamera.aspect = outW / outH; this.weaponCamera.updateProjectionMatrix();
    this.rw = w; this.rh = h;
  }

  async init(tick) {
    await this.sky.init(this.time, tick);
    this.sky.ambTarget = this.ambient;
    this.sky.updateEnvironment(this.scene);
  }

  _updateShadowRig() {
    const range = this.q.shadowRange;
    const cam = this.sun.shadow.camera;
    cam.left = -range; cam.right = range; cam.top = range; cam.bottom = -range;
    cam.near = 1; cam.far = 700;
    cam.updateProjectionMatrix();
    // The shadow volume is centred on the viewer and snapped to shadow texels. It must not follow
    // the view direction: a volume pushed ahead of the camera drops and regains the shadows at its
    // rim while the player turns.
    const cx = this.camera.position.x, cz = this.camera.position.z;
    const cy = this.camera.position.y;
    const texel = (2 * range) / this.q.shadow;
    // light basis
    const { up, right, upL, c } = this._sb;   // no per-frame allocations
    if (Math.abs(this.sunDir.y) > 0.99) up.set(1, 0, 0); else up.set(0, 1, 0);
    right.crossVectors(up, this.sunDir).normalize();
    upL.crossVectors(this.sunDir, right).normalize();
    c.set(cx, cy, cz);
    const sx = Math.round(c.dot(right) / texel) * texel;
    const sy = Math.round(c.dot(upL) / texel) * texel;
    const sz = c.dot(this.sunDir);
    c.copy(right).multiplyScalar(sx).addScaledVector(upL, sy).addScaledVector(this.sunDir, sz);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(this.sunDir, 350);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  // Renders one frame. `output` may be a render target (film capture).
  render(dt, output = null) {
    const r = this.renderer;
    this.time += dt;
    G.uTime.value = this.time;
    this.sky.camAlt = Math.max(1, this.camera.position.y + 2);
    this.sky.update(this.time, this.syncSky === true);
    this._updateShadowRig();
    r.info.reset();

    this.camera.updateMatrixWorld();
    this.weaponCamera.matrixWorld.copy(this.camera.matrixWorld);
    this.weaponCamera.matrixWorldInverse.copy(this.camera.matrixWorldInverse);

    // compile every program in the scene once, before the first frame, rather than on first sight
    if (!this._precompiled) { this._precompiled = true; try { r.compile(this.scene, this.camera); } catch (e) { /* compiled lazily */ } }
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.autoClear = true;
    this.camera.layers.set(0);
    r.render(this.scene, this.camera);
    if (this.weaponVisible) {
      r.autoClear = false;
      this.gl.depthRange(0.0, 0.02);
      r.render(this.scene, this.weaponCamera);
      this.gl.depthRange(0.0, 1.0);
      r.autoClear = true;
    }
    this.post.render(this.sceneRT, this.camera, this.time, output, this.outW, this.outH);
    r.setRenderTarget(null);
  }
}
