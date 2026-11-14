// Minimap: an aerial picture of the valley, baked once after loading from an orthographic
// render of the real scene (sky hidden, no aerial-perspective pass), tone-mapped on the CPU
// into a 1024 px canvas. Per frame there is one 2D canvas draw: the picture rotated to the
// heading plus a handful of markers. No extra scene render per frame.
import * as THREE from 'three';

const TEX = 1024;          // baked picture, px
const RANGE = 90;          // metres from the centre to the rim
const HEAR = 60;           // infected closer than this are heard and drawn
const FAR = 170;           // beyond HEAR and up to here they only colour the rim
const BINS = 24;
const TAU = Math.PI * 2;
const INK = '236,235,230', RED = '201,101,90', ACC = '212,189,136';
const _d = new THREE.Vector3();

export class Minimap {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.cv = document.createElement('canvas');
    this.el.append(this.cv);
    this.ctx = this.cv.getContext('2d');
    this.map = null; this.size = 0; this.bins = new Float32Array(BINS);
    this.c = [20, -20]; this.half = 400; this.ms = 0;
  }

  // one orthographic render of the world from straight above, read back and graded here
  bake(engine, layout) {
    const t0 = performance.now();
    const r = engine.renderer, scene = engine.scene;
    const c = this.c = layout.playCenter || [20, -20];
    const half = this.half = (layout.playRadius || 330) + 80;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 4000);
    cam.position.set(c[0], 1800, c[1]); cam.up.set(0, 0, -1); cam.lookAt(c[0], 0, c[1]); cam.updateMatrixWorld();
    const rt = new THREE.WebGLRenderTarget(TEX, TEX, { type: THREE.HalfFloatType, depthBuffer: true });
    const dome = engine.sky && engine.sky.dome, domeVis = dome ? dome.visible : false;
    const bg = scene.background, fog = scene.fog, prevRT = r.getRenderTarget();
    const prevCol = r.getClearColor(new THREE.Color()), prevA = r.getClearAlpha();
    const buf = new Uint16Array(TEX * TEX * 4);
    try {
      if (dome) dome.visible = false;
      scene.background = null; scene.fog = null;
      r.setRenderTarget(rt); r.setClearColor(0x20231c, 1); r.clear();
      r.render(scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, TEX, TEX, buf);
    } catch (e) { console.warn('minimap bake failed', e); return; } finally {
      if (dome) dome.visible = domeVis;
      scene.background = bg; scene.fog = fog;
      r.setRenderTarget(prevRT); r.setClearColor(prevCol, prevA);
      rt.dispose();
    }
    // half floats -> linear radiance -> exposure from the log-average -> filmic curve -> sRGB
    const half2f = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) half2f[i] = THREE.DataUtils.fromHalfFloat(i);
    let sum = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4 * 37) {
      const l = 0.2126 * half2f[buf[i]] + 0.7152 * half2f[buf[i + 1]] + 0.0722 * half2f[buf[i + 2]];
      if (l > 1e-5 && Number.isFinite(l)) { sum += Math.log(l); n++; }
    }
    const exp = 0.24 / Math.exp(n ? sum / n : 0);
    const LUT = 2048, lut = new Uint8ClampedArray(LUT + 1);
    for (let i = 0; i <= LUT; i++) {
      const x = (i / LUT) * 8;
      const y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
      lut[i] = 255 * Math.pow(Math.min(1, y), 1 / 2.2);
    }
    // gentle S-curve around the mid-tones, top end held a little under white so markers read
    const curve = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) { const t = i / 255, sm = t * t * (3 - 2 * t); curve[i] = 255 * (0.04 + 0.86 * (t * 0.45 + sm * 0.55)); }
    const img = new ImageData(TEX, TEX), px = img.data;
    const tone = (v) => lut[Math.min(LUT, Math.max(0, (v * exp * LUT) / 8) | 0)];
    for (let y = 0; y < TEX; y++) {
      const src = (TEX - 1 - y) * TEX * 4, dst = y * TEX * 4;     // GL rows run bottom-up
      for (let x = 0; x < TEX * 4; x += 4) {
        let R = tone(half2f[buf[src + x]] || 0), G = tone(half2f[buf[src + x + 1]] || 0), B = tone(half2f[buf[src + x + 2]] || 0);
        const L = 0.3 * R + 0.59 * G + 0.11 * B;               // a touch less saturated than the scene, more local contrast
        px[dst + x] = curve[(L + (R - L) * 0.9) | 0]; px[dst + x + 1] = curve[(L + (G - L) * 0.9) | 0]; px[dst + x + 2] = curve[(L + (B - L) * 0.92) | 0]; px[dst + x + 3] = 255;
      }
    }
    const map = document.createElement('canvas');
    map.width = map.height = TEX;
    map.getContext('2d').putImageData(img, 0, 0);
    this.map = map;
    this.ms = performance.now() - t0;
  }

  _fit() {
    const w = this.el.getBoundingClientRect().width;
    const px = Math.round(w * Math.min(2, window.devicePixelRatio || 1));
    if (px > 0 && px !== this.size) {
      this.cv.width = this.cv.height = this.size = px;
      // the rim shading is the same every frame
      const g = this.ctx.createRadialGradient(0, 0, px * 0.3, 0, 0, px / 2);   // used with the origin at the centre
      g.addColorStop(0, 'rgba(10,11,11,0)'); g.addColorStop(0.82, 'rgba(10,11,11,0.18)'); g.addColorStop(1, 'rgba(10,11,11,0.62)');
      this.rim = g;
    }
  }

  draw(game) {
    this._fit();
    const S = this.size; if (!S) return;
    const ctx = this.ctx, R = S / 2, k = R / RANGE, u = S / 168;  // u: one CSS pixel at the base size
    const cam = game.engine.camera;
    cam.getWorldDirection(_d);
    const yaw = Math.atan2(-_d.x, -_d.z), px = cam.position.x, pz = cam.position.z;
    const rimR = R - 7 * u;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R, 0, TAU); ctx.clip();
    ctx.fillStyle = '#1c1f19'; ctx.fillRect(0, 0, S, S);
    ctx.translate(R, R); ctx.rotate(yaw);
    // the picture: only the texels that can reach the disc
    if (this.map) {
      const mpp = (2 * this.half) / TEX, reach = RANGE * 1.42;
      const u0 = (px - (this.c[0] - this.half)) / mpp, v0 = (pz - (this.c[1] - this.half)) / mpp, sr = reach / mpp;
      ctx.drawImage(this.map, u0 - sr, v0 - sr, sr * 2, sr * 2, -reach * k, -reach * k, reach * 2 * k, reach * 2 * k);
    }
    // hearing range
    ctx.strokeStyle = `rgba(${INK},0.16)`; ctx.lineWidth = u; ctx.setLineDash([2 * u, 4 * u]);
    ctx.beginPath(); ctx.arc(0, 0, HEAR * k, 0, TAU); ctx.stroke(); ctx.setLineDash([]);

    const P = (x, z) => [(x - px) * k, (z - pz) * k];
    const clampRim = (q, inset) => { const d = Math.hypot(q[0], q[1]), m = rimR - inset; if (d > m) { q[0] *= m / d; q[1] *= m / d; return true; } return false; };
    // infected: heard nearby, otherwise only a glow on the rim in their direction
    const bins = this.bins; bins.fill(0);
    const zs = game.zombies ? game.zombies.list : [];
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      if (!z.alive || (z.def && z.def.boss) || (z.root && !z.root.visible)) continue;
      const dx = z.pos.x - px, dz = z.pos.z - pz, d = Math.hypot(dx, dz);
      if (d < HEAR) {
        const a = Math.pow(1 - d / HEAR, 0.6);
        ctx.fillStyle = `rgba(${RED},${(a * 0.22).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(dx * k, dz * k, 5.5 * u, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(${RED},${(0.25 + a * 0.75).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(dx * k, dz * k, 2.4 * u, 0, TAU); ctx.fill();
      } else if (d < FAR) {
        const b = Math.floor(((Math.atan2(dz, dx) + Math.PI) / TAU) * BINS) % BINS;
        bins[b] += 1 - (d - HEAR) / (FAR - HEAR);
      }
    }
    ctx.lineCap = 'round';
    for (let b = 0; b < BINS; b++) {
      const w = bins[b]; if (w < 0.15) continue;
      const a = ((b + 0.5) / BINS) * TAU - Math.PI;
      ctx.strokeStyle = `rgba(${RED},${Math.min(0.75, 0.2 + w * 0.18).toFixed(3)})`; ctx.lineWidth = 3 * u;
      ctx.beginPath(); ctx.arc(0, 0, R - 2.5 * u, a - 0.11, a + 0.11); ctx.stroke();
    }
    // supply crates
    if (game.supply) for (const cr of game.supply.crates) {
      if (cr.opened) continue;
      const q = P(cr.pos.x, cr.pos.z), edge = clampRim(q, 2 * u);
      ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(-yaw);
      ctx.fillStyle = `rgba(${INK},${edge ? 0.7 : 0.95})`; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = u;
      ctx.fillRect(-3.5 * u, -3.5 * u, 7 * u, 7 * u); ctx.strokeRect(-3.5 * u, -3.5 * u, 7 * u, 7 * u);
      ctx.restore();
    }
    // Operation: tanks, the helicopter, the landing zone
    const op = game.mode === 'operation' ? game.operation : null;
    if (op) {
      const tanks = op.kit ? op.kit.tanks : [];
      for (const t of tanks) {
        if (!t || !t.pos) continue;
        const q = P(t.pos.x, t.pos.z); if (clampRim(q, 4 * u)) continue;
        ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(-(t.yaw || 0));
        ctx.strokeStyle = `rgba(${INK},0.95)`; ctx.lineWidth = 1.5 * u; ctx.fillStyle = 'rgba(10,11,11,0.45)';
        ctx.beginPath(); ctx.rect(-3.5 * u, -5.5 * u, 7 * u, 11 * u); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -9 * u); ctx.stroke();
        ctx.restore();
      }
      const ex = op.extraction;
      if (ex && ex.pos) {
        const q = P(ex.pos.x, ex.pos.z), edge = clampRim(q, 3 * u);
        ctx.strokeStyle = `rgb(${ACC})`; ctx.lineWidth = 1.5 * u; ctx.fillStyle = `rgba(${ACC},0.22)`;
        ctx.beginPath(); ctx.arc(q[0], q[1], (edge ? 4 : 6.5) * u, 0, TAU); ctx.fill(); ctx.stroke();
        if (!edge) { ctx.fillStyle = `rgb(${ACC})`; ctx.beginPath(); ctx.arc(q[0], q[1], 1.6 * u, 0, TAU); ctx.fill(); }
      }
      const h = op.heli, hp = h && h.state !== 'gone' ? (h.root || h.group || h.mesh || {}).position : null;
      if (hp) {
        const q = P(hp.x, hp.z);
        if (!clampRim(q, 3 * u)) { ctx.fillStyle = `rgb(${ACC})`; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = u; ctx.beginPath(); ctx.arc(q[0], q[1], 3.5 * u, 0, TAU); ctx.fill(); ctx.stroke(); }
      }
    }
    // the boss is loud: always on the map, pinned to the rim when far
    const boss = game.boss;
    if (boss && boss.pos && boss.health > 0) {
      const q = P(boss.pos.x, boss.pos.z), edge = clampRim(q, 4 * u);
      ctx.fillStyle = `rgba(${RED},0.28)`; ctx.beginPath(); ctx.arc(q[0], q[1], 9 * u, 0, TAU); ctx.fill();
      ctx.strokeStyle = `rgb(${INK})`; ctx.lineWidth = 1.5 * u; ctx.fillStyle = `rgb(${RED})`;
      ctx.beginPath(); ctx.arc(q[0], q[1], (edge ? 4 : 5) * u, 0, TAU); ctx.fill(); ctx.stroke();
    }
    // north tick on the rim
    ctx.strokeStyle = `rgba(${INK},0.95)`; ctx.lineWidth = 2 * u;
    ctx.beginPath(); ctx.moveTo(0, -R + 1 * u); ctx.lineTo(0, -R + 8 * u); ctx.stroke();
    ctx.strokeStyle = `rgba(${INK},0.4)`; ctx.lineWidth = u;
    for (let i = 1; i < 4; i++) { const a = (i * Math.PI) / 2; ctx.beginPath(); ctx.moveTo(Math.sin(a) * (R - u), -Math.cos(a) * (R - u)); ctx.lineTo(Math.sin(a) * (R - 5 * u), -Math.cos(a) * (R - 5 * u)); ctx.stroke(); }
    ctx.rotate(-yaw);
    // rim shade, view cone and the player at the centre, always pointing up
    ctx.fillStyle = this.rim; ctx.fillRect(-R, -R, S, S);
    const fovH = Math.atan(Math.tan((cam.fov * Math.PI) / 360) * cam.aspect);
    const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.7);
    cone.addColorStop(0, `rgba(${INK},0.09)`); cone.addColorStop(1, `rgba(${INK},0)`);
    ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R * 0.7, -Math.PI / 2 - fovH, -Math.PI / 2 + fovH); ctx.closePath(); ctx.fill();
    ctx.fillStyle = `rgb(${INK})`; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1.2 * u; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(0, -7 * u); ctx.lineTo(5 * u, 5.5 * u); ctx.lineTo(0, 3 * u); ctx.lineTo(-5 * u, 5.5 * u); ctx.closePath(); ctx.stroke(); ctx.fill();
    // N, upright, just inside the north tick
    const na = -yaw, nr = R - 16 * u;
    ctx.font = `600 ${10 * u}px "Inter Variable", Inter, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(${INK},0.9)`; ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 3 * u;
    ctx.fillText('N', Math.sin(-na) * nr, -Math.cos(-na) * nr);
    ctx.shadowBlur = 0;
    ctx.restore();
    // hairline frame
    ctx.strokeStyle = `rgba(${INK},0.32)`; ctx.lineWidth = u;
    ctx.beginPath(); ctx.arc(R, R, R - u / 2, 0, TAU); ctx.stroke();
  }
}
