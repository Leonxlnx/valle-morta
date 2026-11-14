// Engine: WebGL renderer, HDR scene target, sun + shadow rig, sky and the
// post chain. The world camera and the first-person weapon camera share one
// depth buffer (the weapon is squeezed into the first 2% of the depth range).
import * as THREE from 'three';
import { G } from './shared.js';
import { Sky } from './sky.js';
import { PostFX } from './post.js';

// Each preset is one deliberate bundle (integrated Radeon 780M, 1920x1200). The tiers were moved up
// one step in iteration 2: low is the former medium, medium the former high, high the former ultra.
//   low     0.75 scale, 2048 shadows over 70 m, half the grass
//   medium  native scale, FXAA, 2048 shadows over 95 m
//   high    native scale + MSAA 4, 4096 shadows over 130 m, 4K sky, full grass
//   ultra   high plus: 6144 shadows over 150 m (sharper and further), contact shadows, wide + fine
//           AO with 16 samples, 5K sky with more cloud steps, denser light shafts, longer grass reach
// Every preset runs under the dynamic resolution governor (see govern()), which keeps 40 fps.
// Keys read elsewhere: texSize, aniso (terrain), grass (vegetation); grassRange is offered to the
// vegetation for a longer grass reach on ultra (1 = default), clutter (ground debris density, 0 = none).
// rays: steps of the screen-space light shafts; reflect: planar river reflection at this fraction
// of the render size (0 = sky panorama only); aoFull: AO + contact shadows at full resolution;
// cloudFine: a second cloud erosion octave; clarity / vibrance / contrast: a more intense grade.
export const QUALITY = {
  low:    { scale: 0.75, msaa: 0, shadow: 2048, shadowRange: 70,  pano: [2048, 512],  cloudSteps: 44, ao: true,  vol: true, volSteps: 16, volScale: 4, texSize: 1024, grass: 0.55, aniso: 4,  far: 1,   sharpen: 0.9, rays: 16, rayStrength: 0.08 },
  medium: { scale: 1.0,  msaa: 0, shadow: 2048, shadowRange: 95,  pano: [2048, 512],  cloudSteps: 48, ao: true,  vol: true, volSteps: 18, volScale: 3, texSize: 1024, grass: 0.8,  aniso: 8,  far: 1,   sharpen: 0.95, rays: 20, rayStrength: 0.08 },
  high:   { scale: 1.0,  msaa: 4, shadow: 4096, shadowRange: 130, pano: [4096, 1024], cloudSteps: 72, ao: true,  vol: true, volSteps: 30, volScale: 2, texSize: 2048, grass: 1.0,  aniso: 16, far: 1,   sharpen: 0.8, rays: 32, rayStrength: 0.1, reflect: 0.34, clutter: 0.5 },
  ultra:  { scale: 1.0,  msaa: 4, shadow: 6144, shadowRange: 150, pano: [5120, 1280], cloudSteps: 96, ao: true,  aoHQ: true, aoRadius: 1.6, aoIntensity: 2.1, aoAmount: 1.0, contact: 1.0, shadowSoft: 1.2, vol: true, volSteps: 44, volScale: 2, texSize: 2048, grass: 1.0, grassRange: 1.5, aniso: 16, far: 1.5, sharpen: 1.0,
            rays: 40, rayStrength: 0.13, volStrength: 0.85, reflect: 0.5, aoFull: true, cloudFine: 1, clutter: 1, clarity: 0.3, vibrance: 0.32, contrast: 1.17 },
};
// dynamic resolution: floor of the governor (ms per frame, 40 fps) and the steps of the render scale
const DYN_FLOOR_MS = 25, DYN_UP_MS = 20.5, DYN_STEP = 0.08, DYN_MIN = 0.5;

// Shadows fade out over the rim of the shadow volume instead of ending in a hard line (the volume
// is a square centred on the viewer, so the rim is far away in every direction).
{
  const C = THREE.ShaderChunk, src = C.shadowmap_pars_fragment, cut = src.indexOf('getPointShadow');
  const head = cut > 0 ? src.slice(0, cut) : src;
  C.shadowmap_pars_fragment = head.replaceAll('return mix( 1.0, shadow, shadowIntensity );',
    'return mix( 1.0, shadow, shadowIntensity * ( 1.0 - smoothstep( 0.86, 0.985, max( abs( shadowCoord.x * 2.0 - 1.0 ), abs( shadowCoord.y * 2.0 - 1.0 ) ) ) ) );') + (cut > 0 ? src.slice(cut) : '');
}

const PREPASS_LAYER = 4;

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

    this.sky = new Sky(renderer, { panoSize: this.q.pano, steps: this.q.cloudSteps, fine: this.q.cloudFine ?? 0 });
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
    this.sky.steps = this.q.cloudSteps; this.sky.fine = this.q.cloudFine ?? 0;
    this.sky.setPanoSize(this.q.pano);   // re-rendered in the background, old sky shown until then
    this._flushTargets();
    this.resize(this.outW, this.outH);
  }

  _flushTargets() {
    for (const rt of (this._rts || new Map()).values()) { rt.depthTexture.dispose(); rt.dispose(); }
    this._rts = new Map();
    this.post.dispose();
  }

  // An explicit resize (window, quality, render scale, film) restarts the governor at the top step.
  resize(outW, outH) {
    this.outW = outW; this.outH = outH;
    this.renderer.setSize(outW, outH, false);
    const s = this.post.settings, q = this.q;
    s.ao = q.ao; s.aoHQ = !!q.aoHQ; s.aoRadius = q.aoRadius ?? 1.0; s.aoIntensity = q.aoIntensity ?? 1.4; s.aoAmount = q.aoAmount ?? 0.92; s.contact = q.contact ?? 0;
    this.sun.shadow.radius = q.shadowSoft ?? 1.7;
    s.volumetric = q.vol; s.volSteps = q.volSteps; s.volScale = q.volScale; s.aoFull = !!q.aoFull;
    s.raySteps = q.rays ?? 0; s.rayStrength = q.rayStrength ?? 0.05; s.volStrength = q.volStrength ?? 0.7;
    s.clarity = q.clarity ?? 0.22; s.vibrance = q.vibrance ?? 0.25; s.contrast = q.contrast ?? 1.14;
    if (q.sharpen !== undefined) s.sharpen = q.sharpen;
    // the steps of the governor: the set render scale, then down in 0.08 steps to 0.5
    // With MSAA the first step down drops the multisampling at the same scale (it costs about as
    // much as the rest of the frame on the 780M; FXAA then covers the edges).
    const top = this.renderScale, lv = [{ s: top, msaa: q.msaa }];
    if (q.msaa) lv.push({ s: top, msaa: 0 });
    for (let x = top - DYN_STEP; x >= DYN_MIN - 1e-6; x -= DYN_STEP) lv.push({ s: +x.toFixed(3), msaa: 0 });
    for (const l of lv) l.cost = l.s * l.s * (l.msaa ? 1.8 : 1);
    this.levels = lv;
    this._gov = { k: 0, ema: 0, t: 0, over: 0, under: 0, upWait: 2000, lastUp: -1e9, clock: 0 };
    this._setLevel(0);
    this.camera.aspect = outW / outH; this.camera.updateProjectionMatrix();
    this.weaponCamera.aspect = outW / outH; this.weaponCamera.updateProjectionMatrix();
  }

  // Switches the internal render size to governor step k. Targets are cached per size (the three
  // most recent), so moving between steps does not reallocate once each size has been visited.
  _setLevel(k) {
    const L = this.levels[k], sc = L.s, samples = Math.min(L.msaa, this.q.msaa), outW = this.outW, outH = this.outH;
    const w = Math.max(64, Math.round(outW * sc / 2) * 2);
    const h = Math.max(64, Math.round(outH * sc / 2) * 2);
    this._rts = this._rts || new Map();
    const key = `${w}x${h}x${samples}`;
    let rt = this._rts.get(key);
    if (rt) this._rts.delete(key);
    else {
      const depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
      rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples, depthTexture,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
    }
    this._rts.set(key, rt);
    while (this._rts.size > 3) {
      const [k0, old] = this._rts.entries().next().value;
      this._rts.delete(k0); old.depthTexture.dispose(); old.dispose();
    }
    this.sceneRT = rt;
    this.post.setSize(w, h);
    this.rw = w; this.rh = h;
    this.dynScale = sc;
    if (this._gov) this._gov.k = k;
  }

  // Dynamic resolution governor, fed once per displayed frame with the frame interval (ms).
  // Smoothed frame time above 25 ms (below 40 fps) for 0.4 s: one step down (two when below 30 fps).
  // Up only when the frame predicted for the next step up (cost taken as proportional to the
  // pixels, a pessimistic guess) stays under 20.5 ms for a while; an up step that has to be taken
  // back soon doubles that wait, so the image does not pump between two steps.
  govern(ms) {
    const g = this._gov;
    if (!g || !this.dynamicRes || this._filming || this.levels.length < 2) return;
    if (!(ms > 0) || ms > 250) return;   // stalls, hidden tab
    g.clock += ms;
    g.ema = g.ema ? g.ema + (ms - g.ema) * 0.1 : ms;
    g.t += ms;
    if (g.t < 500) return;   // let the timing settle after a change
    const last = this.levels.length - 1, cost = this.levels[g.k].cost;
    if (g.ema > DYN_FLOOR_MS) {
      g.under = 0; g.over += ms;
      if (g.over > 400 && g.k < last) {
        if (g.clock - g.lastUp < 5000) g.upWait = Math.min(30000, g.upWait * 2);
        this._step(Math.min(last, g.k + (g.ema > 33.3 ? 2 : 1)));
      }
      return;
    }
    g.over = 0;
    // a long calm spell halves the extra wait again
    if (g.upWait > 2000 && g.clock - g.lastUp > 20000) { g.upWait = Math.max(2000, g.upWait / 2); g.lastUp = g.clock - 10000; }
    if (g.k === 0) return;
    // (about three quarters of the frame taken to scale with the pixels)
    if (g.ema * (0.25 + 0.75 * this.levels[g.k - 1].cost / cost) < DYN_UP_MS) {
      g.under += ms;
      if (g.under > g.upWait) { g.lastUp = g.clock; this._step(g.k - 1); }
    } else g.under = 0;
  }

  _step(k) {
    const g = this._gov;
    this._setLevel(k);
    g.ema = 0; g.t = 0; g.over = 0; g.under = 0;
  }

  async init(tick) {
    await this.sky.init(this.time, tick);
    this.sky.ambTarget = this.ambient;
    this.sky.updateEnvironment(this.scene);
  }

  // marks the meshes of the town chunks for the depth pre-pass (once, after the world is built)
  _initPrepass() {
    // one pass per face culling mode, so the depth matches what the real material draws
    const mat = [new THREE.MeshBasicMaterial({ colorWrite: false }), new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide })];
    const count = [0, 0];
    for (const o of this.scene.children) {
      if (o.name !== 'buildings') continue;
      o.traverse((m) => {
        const mt = m.material;
        if (!m.isMesh || !mt || Array.isArray(mt) || mt.alphaTest > 0 || mt.transparent || mt.side === THREE.BackSide || mt.alphaMap || mt.colorWrite === false) return;
        const k = mt.side === THREE.DoubleSide ? 1 : 0;
        m.layers.enable(PREPASS_LAYER + k); count[k]++;
      });
    }
    this._pre = { mat, count: count[0] + count[1] ? count : 0 };
    if (!this._pre.count) this._pre.count = 0;
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

  // Planar reflection of the river (high / ultra). The mirror plane is the water level at the point
  // of the river nearest the camera; only rendered when the river can be in view. Grass, small
  // stones, clutter and the water itself are left out of the mirror image.
  _renderReflection() {
    const w = this.water, k = this.q.reflect || 0;
    if (!w) return;
    const cam = this.camera, pr = w.probe(cam.position.x, cam.position.z);
    if (!k || !pr || pr.d > 260 || cam.position.y < pr.y + 0.05 || !this._waterInView(w)) { w.uniforms.uReflOn.value = 0; return; }
    const r = this.renderer, h = pr.y;
    const rw = Math.max(64, Math.round(this.rw * k)), rh = Math.max(64, Math.round(this.rh * k));
    if (!this.reflRT || this.reflRT.width !== rw || this.reflRT.height !== rh) {
      if (this.reflRT) this.reflRT.dispose();
      this.reflRT = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
      this.reflCam = new THREE.PerspectiveCamera();
      this._rf = { v: new THREE.Vector3(), t: new THREE.Vector3(), plane: new THREE.Plane(), clip: new THREE.Vector4(), q: new THREE.Vector4(), hide: null, tries: 0 };
    }
    const f = this._rf, vc = this.reflCam;
    if (!f.hide || (f.hide.length < 3 && ++f.tries % 120 === 0)) {
      f.hide = [];
      this.scene.traverse((o) => { if (/^(grass-|clutter|stones|river-water|shrubs|dead-wood)/.test(o.name)) f.hide.push(o); });
    }
    // mirrored camera
    vc.fov = cam.fov; vc.aspect = cam.aspect; vc.near = cam.near; vc.far = 20000; vc.updateProjectionMatrix();
    vc.position.copy(cam.position); vc.position.y = 2 * h - vc.position.y;
    cam.getWorldDirection(f.t); f.t.y = -f.t.y;
    vc.up.set(0, 1, 0).applyQuaternion(cam.quaternion); vc.up.y = -vc.up.y;
    vc.lookAt(f.v.copy(vc.position).add(f.t));
    vc.updateMatrixWorld();
    // texture matrix (before the oblique near plane)
    const tm = w.uniforms.uReflMat.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    // oblique near plane at the water surface: nothing below it is drawn
    f.plane.setFromNormalAndCoplanarPoint(f.v.set(0, 1, 0), f.t.set(0, h - 0.03, 0)).applyMatrix4(vc.matrixWorldInverse);
    const P = vc.projectionMatrix.elements, c = f.clip.set(f.plane.normal.x, f.plane.normal.y, f.plane.normal.z, f.plane.constant);
    f.q.set((Math.sign(c.x) + P[8]) / P[0], (Math.sign(c.y) + P[9]) / P[5], -1, (1 + P[10]) / P[14]);
    c.multiplyScalar(2 / c.dot(f.q));
    P[2] = c.x; P[6] = c.y; P[10] = c.z + 1; P[14] = c.w;
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();
    const vis = f.hide.map((o) => o.visible);
    for (const o of f.hide) o.visible = false;
    w.mesh.visible = false;
    r.setRenderTarget(this.reflRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(this.scene, vc);
    f.hide.forEach((o, i) => { o.visible = vis[i]; });
    w.mesh.visible = true;
    w.uniforms.uRefl.value = this.reflRT.texture;
    w.uniforms.uReflOn.value = 1;
    r.setRenderTarget(this.sceneRT);
  }

  // any stretch of river within 300 m inside the view frustum
  _waterInView(w) {
    const f = this._wf || (this._wf = { fr: new THREE.Frustum(), m: new THREE.Matrix4(), sp: new THREE.Sphere() });
    const cam = this.camera;
    cam.updateMatrixWorld();
    f.fr.setFromProjectionMatrix(f.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const P = w.pts, cx = cam.position.x, cz = cam.position.z;
    for (let i = 0; i < P.length; i += 4) {
      const dx = P[i] - cx, dz = P[i + 2] - cz;
      if (dx * dx + dz * dz > 90000) continue;
      f.sp.center.set(P[i], P[i + 1], P[i + 2]); f.sp.radius = P[i + 3];
      if (f.fr.intersectsSphere(f.sp)) return true;
    }
    return false;
  }

  // Renders one frame. `output` may be a render target (film capture).
  render(dt, output = null) {
    const r = this.renderer;
    // film capture renders at the fixed (top) scale and pauses the governor
    this._filming = !!output;
    if (output && this._gov && this._gov.k !== 0) this._step(0);
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
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    r.autoClear = false;
    // Depth pre-pass of the houses (merged town chunks, no alpha test): their expensive material
    // then shades every pixel once, and what stands behind them is rejected by depth. Not with
    // MSAA, where every render call ends in a full resolve of the multisampled target.
    // Opt-in (engine.prepass = true): measured on the 780M it costs as much as it saves.
    if (this.prepass === true && !this.q.msaa) {
      // (retried once a second until the town exists)
      if (!this._pre || (!this._pre.count && (this._preTry = (this._preTry || 0) + 1) % 60 === 0)) this._initPrepass();
      const sc = this.scene, auto = sc.matrixWorldAutoUpdate;
      sc.matrixWorldAutoUpdate = false;
      for (let k = 0; k < 2; k++) {
        if (!this._pre.count[k]) continue;
        sc.overrideMaterial = this._pre.mat[k];
        this.camera.layers.set(PREPASS_LAYER + k);
        r.render(sc, this.camera);
      }
      sc.overrideMaterial = null; sc.matrixWorldAutoUpdate = auto;
    }
    r.shadowMap.needsUpdate = true;
    this.camera.layers.set(0);
    // planar river reflection (renders the shadow map for this frame on the way)
    this._renderReflection();
    // With MSAA three resolves the multisampled target at the end of every render call. The world
    // pass skips its resolve when the weapon pass follows (that one resolves both): a marker drawn
    // in the world pass, after the shadow map, sets the target to single-sample for the rest of it.
    const msaa = this.sceneRT.samples;
    this._skipResolve = msaa > 0 && this.weaponVisible;
    if (this._skipResolve && !this._resolveMarker) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
      m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; m.name = 'resolve-marker';
      m.onBeforeRender = () => { if (this._skipResolve) this.sceneRT.samples = 0; };
      this.scene.add(m);
      this._resolveMarker = m;
    }
    r.render(this.scene, this.camera);
    this.sceneRT.samples = msaa;
    if (this.weaponVisible) {
      this.gl.depthRange(0.0, 0.02);
      r.render(this.scene, this.weaponCamera);
      this.gl.depthRange(0.0, 1.0);
    }
    this._skipResolve = false;
    r.autoClear = true;
    this.post.render(this.sceneRT, this.camera, this.time, output, this.outW, this.outH);
    r.setRenderTarget(null);
  }
}
