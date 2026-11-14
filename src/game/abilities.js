// Operation abilities: the effects behind the five catalogue entries.
//   tank        a beacon is thrown, a light tank comes down under cargo chutes and the player drives it
//   mortar      the point under the crosshair is marked, shells whistle in and land around it
//   sentry      a tripod machine gun is set down, unfolds, covers the player and folds away
//   adrenaline  the world slows while the player keeps nearly full speed
//   jump        a boosted leap with a short burn
// Everything here is built in code, pooled where it repeats and taken out of view before it goes.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { enhance } from '../engine/materials.js';

const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0), ZAX = new THREE.Vector3(0, 0, 1);
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _v = new THREE.Vector3(), _n = new THREE.Vector3();
const _cp = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _cq = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(1, 1, 1);

// ---------------------------------------------------------------- geometry helpers
const B = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => { const g = new THREE.BoxGeometry(w, h, d); if (rx || ry || rz) g.applyQuaternion(_q.setFromEuler(_e.set(rx, ry, rz))); return g.translate(x, y, z); };
const CX = (r, len, x, y, z, seg = 16, r2 = r) => new THREE.CylinderGeometry(r, r2, len, seg).rotateZ(Math.PI / 2).translate(x, y, z);
const CY = (r, h, x, y, z, seg = 16, r2 = r) => new THREE.CylinderGeometry(r, r2, h, seg).translate(x, y, z);
const CZ = (r, len, x, y, z, seg = 16, r2 = r) => new THREE.CylinderGeometry(r, r2, len, seg).rotateX(Math.PI / 2).translate(x, y, z);
const TB = (ax, ay, az, bx, by, bz, r, seg = 6) => {
  const d = _a.set(bx - ax, by - ay, bz - az), len = d.length();
  return new THREE.CylinderGeometry(r, r, len, seg).applyQuaternion(_q.setFromUnitVectors(UP, d.normalize())).translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
};
// planar UVs from the dominant normal axis, so painted textures keep one scale over every part
function projUV(g, s) {
  const p = g.attributes.position, n = g.attributes.normal, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); } else if (ax >= az) { u = p.getZ(i); v = p.getY(i); } else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u * s; uv[i * 2 + 1] = v * s;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
function merged(list, s = 0.32) {
  const gs = list.map((g) => { g = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; });
  return projUV(mergeGeometries(gs), s);
}
// hull profile in (z, y), extruded across the width
const sideProfile = (pts, w) => new THREE.ExtrudeGeometry(new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1]))), { depth: w, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 1 }).rotateY(-Math.PI / 2).translate(w / 2, 0, 0);
// plan shape in (x, z), extruded upwards
const planProfile = (pts, h) => new THREE.ExtrudeGeometry(new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1]))), { depth: h, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.035, bevelSegments: 1 }).rotateX(Math.PI / 2).translate(0, h, 0);

function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------------------------------------------------------------- shared resources (built on first use)
function buildResources() {
  const mk = (o, key) => enhance(new THREE.MeshStandardMaterial(o), { key });
  const camo = canvasTex(256, 256, (g) => {
    const r = rng(911);
    g.fillStyle = '#596043'; g.fillRect(0, 0, 256, 256);
    const blob = (col, n, r0, r1) => { g.fillStyle = col; for (let i = 0; i < n; i++) { const x = r() * 256, y = r() * 256, rx = r0 + r() * (r1 - r0), ry = rx * (0.45 + r() * 0.4), a = r() * 3; for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) { g.beginPath(); g.ellipse(x + dx, y + dy, rx, ry, a, 0, TAU); g.fill(); } } };
    blob('#3e4530', 8, 34, 70); blob('#6a5c41', 6, 24, 48);
    for (let i = 0; i < 700; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '28,28,18' : '160,150,118'},${0.03 + r() * 0.06})`; g.fillRect(r() * 256, r() * 256, 2 + r() * 20, 1 + r() * 4); }
    g.fillStyle = 'rgba(18,20,12,0.4)'; for (const v of [0, 128]) { g.fillRect(v, 0, 1, 256); g.fillRect(0, v, 256, 1); }
  });
  const gores = canvasTex(256, 64, (g) => { for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#6d6a4d' : '#5c5a40'; g.fillRect(i * 16, 0, 16, 64); } g.fillStyle = 'rgba(30,28,20,0.35)'; for (let i = 0; i < 16; i++) g.fillRect(i * 16, 0, 1, 64); g.fillRect(0, 60, 256, 4); });
  const M = {
    paint: mk({ map: camo, roughness: 0.78, metalness: 0.22 }, 'abl-paint'),
    steel: mk({ color: 0x2c2d2a, roughness: 0.55, metalness: 0.75 }, 'abl-steel'),
    rubber: mk({ color: 0x1b1b1a, roughness: 0.92, metalness: 0 }, 'abl-rubber'),
    track: mk({ color: 0x37342f, roughness: 0.72, metalness: 0.6 }, 'abl-track'),
    cloth: mk({ color: 0x6d6448, roughness: 0.96, metalness: 0 }, 'abl-cloth'),
    glass: mk({ color: 0x0b1316, roughness: 0.08, metalness: 0.85 }, 'abl-glass'),
    chute: mk({ map: gores, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }, 'abl-chute'),
    lines: new THREE.LineBasicMaterial({ color: 0x3a382e }),
  };
  const G = {};
  // ---- tank: origin on the ground at the middle of the footprint, nose along -Z, +X to the right
  const hullPaint = [
    sideProfile([[-2.95, 0.42], [-3.4, 0.86], [-2.15, 1.32], [3.15, 1.32], [3.3, 0.98], [3.05, 0.42]], 1.95),
    sideProfile([[-2.75, 0.98], [-2.2, 1.3], [3.15, 1.3], [3.25, 0.98]], 2.94),
  ];
  for (const s of [-1, 1]) {
    hullPaint.push(B(0.05, 0.46, 5.75, s * 1.5, 0.74, 0.02), B(0.05, 0.32, 0.6, s * 1.5, 0.84, -3.0, 0.5, 0, 0));      // skirts and the angled front panel
    hullPaint.push(B(0.4, 0.22, 1.1, s * 1.18, 1.43, 1.2), B(0.3, 0.12, 0.5, s * 1.2, 1.38, -1.05));                     // stowage bins on the sponsons
    hullPaint.push(B(0.18, 0.34, 0.22, s * 0.85, 0.85, 3.32), B(0.18, 0.34, 0.22, s * 0.6, 0.85, 3.32));                 // jerry cans on the rear plate
  }
  hullPaint.push(B(0.7, 0.06, 0.5, -0.55, 1.34, -1.85));                                                                   // driver's hatch ring
  G.hull = merged(hullPaint);
  const hullSteel = [B(1.5, 0.05, 1.3, 0, 1.345, 2.3), B(0.3, 0.16, 0.5, 0.9, 1.4, 2.95)];                                  // engine grille, exhaust box
  for (let i = 0; i < 9; i++) hullSteel.push(B(1.46, 0.025, 0.04, 0, 1.38, 1.75 + i * 0.13));
  for (const s of [-1, 1]) {
    hullSteel.push(TB(s * 0.6, 0.62, -3.25, s * 0.6, 0.62, -3.5, 0.045), TB(s * 0.6, 0.62, 3.2, s * 0.6, 0.62, 3.45, 0.045));  // tow hooks
    hullSteel.push(TB(s * 1.05, 1.0, -3.0, s * 1.05, 1.24, -2.86, 0.015), TB(s * 1.05, 1.0, -3.0, s * 1.05, 1.0, -3.18, 0.015));  // light guards
    hullSteel.push(B(1.0, 0.025, 0.1, s * 0.0 + s * 0.6, 1.36, 0.6));                                                       // shovel and pick
  }
  hullSteel.push(CY(0.27, 0.05, -0.55, 1.38, -1.85, 18));
  G.hullSteel = merged(hullSteel, 0.5);
  G.hullGlass = merged([B(0.18, 0.06, 0.04, -0.62, 1.42, -2.12, -0.4), B(0.18, 0.06, 0.04, -0.4, 1.42, -2.08, -0.4), CZ(0.07, 0.04, -1.05, 1.08, -3.08, 12), CZ(0.07, 0.04, 1.05, 1.08, -3.08, 12)]);
  // running gear: the rubber tyres are round and need not turn, the painted discs and hubs do
  const rub = [];
  const wheelZ = [-2.35, -1.41, -0.47, 0.47, 1.41, 2.35];
  for (const s of [-1, 1]) for (const z of wheelZ) for (const o of [-0.11, 0.11]) rub.push(CX(0.33, 0.13, s * 1.25 + o, 0.38, z, 24));
  G.tyres = merged(rub);
  const disc = [CX(0.3, 0.3, 0, 0, 0, 20), CX(0.12, 0.38, 0, 0, 0, 12)];
  for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; disc.push(CX(0.025, 0.4, 0, Math.cos(a) * 0.075, Math.sin(a) * 0.075, 6), B(0.32, 0.05, 0.12, 0, Math.cos(a) * 0.2, Math.sin(a) * 0.2, a)); }
  G.wheel = merged(disc);
  const spr = [CX(0.3, 0.34, 0, 0, 0, 14), CX(0.1, 0.42, 0, 0, 0, 10)];
  for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; spr.push(B(0.3, 0.07, 0.09, 0, Math.cos(a) * 0.32, Math.sin(a) * 0.32, a)); }
  G.sprocket = merged(spr);
  G.shoe = merged([B(0.45, 0.045, 0.13, 0, 0, 0), B(0.45, 0.03, 0.035, 0, -0.035, 0.02), B(0.06, 0.07, 0.05, 0, 0.055, 0)], 1);
  // turret (origin on the turret ring)
  const turretPaint = [
    planProfile([[-0.55, -1.62], [0.55, -1.62], [1.15, -0.85], [1.2, 1.05], [0.95, 1.55], [-0.95, 1.55], [-1.2, 1.05], [-1.15, -0.85]], 0.6),
    CY(0.36, 0.16, 0.5, 0.68, 0.45, 20), B(0.26, 0.2, 0.3, -0.58, 0.7, -0.9),                                         // cupola, gunner's sight
  ];
  for (const s of [-1, 1]) for (let k = 0; k < 4; k++) turretPaint.push(TB(s * 1.12, 0.36, -0.62 + k * 0.13, s * 1.34, 0.5, -0.66 + k * 0.13, 0.04, 8));   // smoke dischargers
  turretPaint.push(B(0.42, 0.28, 0.42, -0.6, 0.29, 1.82), B(0.5, 0.22, 0.38, 0.45, 0.25, 1.84));                          // boxes in the bustle basket
  G.turret = merged(turretPaint);
  const turretSteel = [CY(0.3, 0.04, -0.5, 0.62, 0.55, 18)];                                                              // loader's hatch (shut)
  for (const s of [-1, 1]) { turretSteel.push(TB(s * 1.0, 0.15, 1.55, s * 1.0, 0.15, 2.12, 0.02), TB(s * 1.0, 0.55, 1.55, s * 1.0, 0.55, 2.12, 0.02), TB(s * 1.0, 0.15, 2.12, s * 1.0, 0.55, 2.12, 0.02)); }
  turretSteel.push(TB(-1.0, 0.15, 2.12, 1.0, 0.15, 2.12, 0.02), TB(-1.0, 0.55, 2.12, 1.0, 0.55, 2.12, 0.02), B(2.0, 0.02, 0.56, 0, 0.14, 1.84));   // basket
  turretSteel.push(TB(-0.8, 0.62, 1.25, -0.8, 2.9, 1.3, 0.008, 4), TB(0.8, 0.62, 1.25, 0.8, 2.5, 1.32, 0.008, 4), CY(0.05, 0.1, -0.8, 0.66, 1.25, 8), CY(0.05, 0.1, 0.8, 0.66, 1.25, 8));   // antennas
  // the commander's hatch stands open behind the cupola
  turretSteel.push(CY(0.33, 0.05, 0, 0, 0, 18).rotateX(-1.45).translate(0.5, 1.07, 0.84), B(0.12, 0.02, 0.1, 0.5, 0.78, 0.8));
  turretSteel.push(TB(0.25, 0.85, 0.2, 0.25, 1.0, -0.15, 0.012), TB(0.25, 1.0, -0.15, 0.25, 1.0, -0.55, 0.01), B(0.07, 0.08, 0.5, 0.25, 0.94, -0.35));   // pintle machine gun
  G.turretSteel = merged(turretSteel, 0.5);
  const tg = [];
  for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; tg.push(B(0.11, 0.07, 0.03, 0.5 + Math.sin(a) * 0.33, 0.73, 0.45 - Math.cos(a) * 0.33, 0, a)); }
  tg.push(B(0.2, 0.12, 0.02, -0.58, 0.72, -1.06));
  G.turretGlass = merged(tg);
  G.tarp = merged([CX(0.18, 1.5, 0, 0.62, 1.95, 14)]);
  // gun: pivot at the trunnions, the tube slides back on recoil
  G.mantlet = merged([B(0.78, 0.5, 0.36, 0, 0, -0.08), CZ(0.11, 0.25, 0, 0, -0.38, 16)]);
  G.tube = merged([CZ(0.088, 1.9, 0, 0, -1.4, 16), CZ(0.125, 0.55, 0, 0, -2.6, 18, 0.11), CZ(0.07, 2.0, 0, 0, -3.85, 14, 0.074)]);
  G.brake = merged([B(0.3, 0.17, 0.08, 0, 0, -4.48), B(0.3, 0.17, 0.08, 0, 0, -4.7), B(0.2, 0.035, 0.3, 0, 0.068, -4.59), B(0.2, 0.035, 0.3, 0, -0.068, -4.59), CZ(0.085, 0.06, 0, 0, -4.38, 14)], 1);
  // ---- chutes
  G.canopy = new THREE.SphereGeometry(1, 22, 7, 0, TAU, 0, 1.2).scale(1, 0.72, 1);
  // ---- beacon
  G.beacon = merged([CY(0.035, 0.2, 0, 0.1, 0, 10), CY(0.045, 0.04, 0, 0.21, 0, 10)]);
  // ---- sentry
  G.leg = merged([CY(0.016, 0.8, 0, -0.4, 0, 6), B(0.06, 0.02, 0.08, 0, -0.8, -0.02), CY(0.024, 0.18, 0, -0.18, 0, 8)], 1);
  G.sHead = merged([CY(0.055, 0.1, 0, 0.02, 0, 14), CY(0.032, 0.12, 0, 0.1, 0, 10), B(0.02, 0.12, 0.08, 0.075, 0.15, 0), B(0.02, 0.12, 0.08, -0.075, 0.15, 0), B(0.17, 0.02, 0.08, 0, 0.1, 0)], 1);
  G.sGun = merged([B(0.085, 0.11, 0.5, 0, 0.02, -0.02), B(0.09, 0.03, 0.22, 0, 0.09, -0.05), B(0.11, 0.15, 0.24, -0.11, -0.01, 0), B(0.08, 0.06, 0.13, 0, 0.135, -0.12), B(0.44, 0.3, 0.012, 0, 0.04, -0.32), B(0.44, 0.012, 0.08, 0, 0.19, -0.28, 0.6)], 1.5);
  G.sSteel = merged([CZ(0.013, 0.72, 0, 0.03, -0.63, 8), CZ(0.022, 0.26, 0, 0.03, -0.41, 10), CZ(0.02, 0.07, 0, 0.03, -1.0, 8), CZ(0.03, 0.12, 0, 0.02, 0.29, 10), CX(0.024, 0.17, 0, 0, 0, 8), TB(0, 0.08, 0.12, 0, 0.13, -0.05, 0.008, 4)], 2);
  G.sGlass = merged([CZ(0.022, 0.012, 0, 0.135, -0.19, 12)]);
  // ---- ground marks: scorch, tread, shock ring
  const scorch = canvasTex(256, 256, (g) => {
    const r = rng(77);
    const grd = g.createRadialGradient(128, 128, 4, 128, 128, 124);
    grd.addColorStop(0, 'rgba(10,9,8,0.95)'); grd.addColorStop(0.35, 'rgba(20,17,14,0.85)'); grd.addColorStop(0.7, 'rgba(38,32,26,0.4)'); grd.addColorStop(1, 'rgba(40,34,28,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 40; i++) { const a = r() * TAU, d = 50 + r() * 60, w = 4 + r() * 14; g.fillStyle = `rgba(16,13,10,${0.2 + r() * 0.4})`; g.beginPath(); g.ellipse(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, w * 2.2, w, a, 0, TAU); g.fill(); }
    g.globalCompositeOperation = 'destination-in'; const m = g.createRadialGradient(128, 128, 90, 128, 128, 127); m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = m; g.fillRect(0, 0, 256, 256);
  }, false);
  const tread = canvasTex(64, 64, (g) => {
    for (let y = 0; y < 64; y += 8) { g.fillStyle = 'rgba(42,34,25,0.62)'; g.fillRect(3, y + 1, 58, 4); g.fillStyle = 'rgba(42,34,25,0.25)'; g.fillRect(1, y, 62, 7); }
    g.globalCompositeOperation = 'destination-in'; const m = g.createLinearGradient(0, 0, 64, 0); m.addColorStop(0, 'rgba(0,0,0,0)'); m.addColorStop(0.12, 'rgba(0,0,0,1)'); m.addColorStop(0.88, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = m; g.fillRect(0, 0, 64, 64);
  }, false);
  const ring = canvasTex(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 20, 64, 64, 63);
    grd.addColorStop(0, 'rgba(200,190,165,0)'); grd.addColorStop(0.72, 'rgba(200,190,165,0.15)'); grd.addColorStop(0.9, 'rgba(214,204,180,0.85)'); grd.addColorStop(1, 'rgba(214,204,180,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  }, false);
  const decalMat = (map, key) => enhance(new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), { key });
  M.scorch = decalMat(scorch, 'abl-scorch'); M.tread = decalMat(tread, 'abl-tread');
  M.ring = new THREE.MeshBasicMaterial({ map: ring, transparent: true, depthWrite: false, opacity: 0, fog: true });
  return { M, G, wheelZ };
}

// ---------------------------------------------------------------- tank
const TK = { half: 1.5, track: 1.25, cy: 0.38, R: 0.36, ends: 2.97, eye: new THREE.Vector3(0.48, 1.52, 0.72), muzzle: 4.78, dropH: 70, beaconT: 0.6, fallT: 1.8 };
const TRACK_D = TK.ends * 2, TRACK_L = 2 * TRACK_D + TAU * TK.R, SHOES = Math.round(TRACK_L / 0.153), SHOE_SP = TRACK_L / SHOES;

class Tank {
  constructor(kit, x, z, yaw, P) {
    const g = this.g = kit.game, { M, G, wheelZ } = kit.res();
    this.kit = kit; this.P = P;
    this.pos = new THREE.Vector3(x, g.terrain.heightAt(x, z), z);
    this.ground = this.pos.y;
    this.yaw = yaw; this.v = 0; this.w = 0; this.accel = 0;
    this.pitch = 0; this.roll = 0; this.pv = 0; this.rv = 0; this.yOff = 0; this.yov = 0; this.bump = 0;
    this.tYaw = 0; this.gPitch = 0; this.reload = 0.6; this.recoil = 0;
    this.tOff = [0, 0]; this.wAng = [0, 0]; this.mAcc = [0, 0];
    this.state = 'drop'; this.t = 0; this.t2 = 0; this.parkT = 0; this.leaveT = 0; this.stuckT = 0; this.turnT = 0; this.dirSign = 0;
    this.kills = 0; this.shots = 0; this.box = null; this.cells = null; this.noMount = false; this.smokeT = 0;
    const add = (parent, geo, mat, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m; };
    const root = this.root = new THREE.Group();
    add(root, G.hull, M.paint); add(root, G.hullSteel, M.steel); add(root, G.hullGlass, M.glass, false); add(root, G.tyres, M.rubber);
    this.wheels = [];
    for (const s of [-1, 1]) {
      for (const wz of wheelZ) { const m = add(root, G.wheel, M.paint); m.position.set(s * 1.25, TK.cy, wz); this.wheels.push({ m, i: s < 0 ? 0 : 1 }); }
      for (const ez of [-TK.ends, TK.ends]) { const m = add(root, G.sprocket, M.steel); m.position.set(s * 1.25, TK.cy, ez); this.wheels.push({ m, i: s < 0 ? 0 : 1 }); }
    }
    this.tracks = new THREE.InstancedMesh(G.shoe, M.track, SHOES * 2);
    this.tracks.castShadow = true; this.tracks.receiveShadow = true; this.tracks.frustumCulled = false;
    root.add(this.tracks);
    this.turret = new THREE.Group(); this.turret.position.set(0, 1.32, -0.25); root.add(this.turret);
    add(this.turret, G.turret, M.paint); add(this.turret, G.turretSteel, M.steel); add(this.turret, G.turretGlass, M.glass, false); add(this.turret, G.tarp, M.cloth);
    this.gun = new THREE.Group(); this.gun.position.set(0, 0.33, -1.6); this.turret.add(this.gun);
    add(this.gun, G.mantlet, M.paint);
    this.tube = new THREE.Group(); this.gun.add(this.tube);
    add(this.tube, G.tube, M.paint); add(this.tube, G.brake, M.steel);
    // cargo chutes: three mains and the drogue, rigged to a confluence above the hull
    const chutes = this.chutes = new THREE.Group();
    const lines = [], C = [0, 7.5, 0];
    for (let k = 0; k < 4; k++) {
      const drogue = k === 3, R = drogue ? 1.7 : 5.2, a = (k / 3) * TAU + 0.5;
      const m = add(chutes, G.canopy, M.chute, false);
      if (drogue) m.position.set(0, 27, 0); else { m.position.set(Math.cos(a) * 4.7, 16.5, Math.sin(a) * 4.7); m.rotation.set(Math.sin(a) * 0.22, 0, -Math.cos(a) * 0.22); }
      m.scale.setScalar(R); m.userData.R = R;
      m.updateMatrix();
      for (let j = 0; j < 10; j++) {
        const b = (j / 10) * TAU;
        _a.set(Math.cos(b) * Math.sin(1.2), Math.cos(1.2) * 0.72, Math.sin(b) * Math.sin(1.2)).applyMatrix4(m.matrix);
        lines.push(_a.x, _a.y, _a.z, ...(drogue ? [0, 19, 0] : C));
      }
    }
    lines.push(0, 19, 0, ...C);
    for (const [sx, sz] of [[-1.1, -2.3], [1.1, -2.3], [-1.1, 2.3], [1.1, 2.3]]) lines.push(...C, sx, 1.36, sz);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.lines = new THREE.LineSegments(lg, M.lines); this.lines.frustumCulled = false; chutes.add(this.lines);
    root.add(chutes);
    this.chuteT = -1;
    // the beacon flies from the player's hand to the drop point
    this.beacon = add(g.engine.scene, G.beacon, M.steel);
    this.bFrom = g.player.eye.clone().addScaledVector(g.player.forward(_a), 0.5); this.bFrom.y -= 0.35;
    this.beacon.position.copy(this.bFrom);
    this.bPos = new THREE.Vector3(x - Math.cos(yaw) * 4.3, 0, z + Math.sin(yaw) * 4.3);
    this.bPos.y = g.terrain.heightAt(this.bPos.x, this.bPos.z) + 0.04;
    kit.litter.push(this.beacon); this.sigT = 0; this.aimT = 0; this.aimP = new THREE.Vector3();
    root.visible = false;
    this._hit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
    g.engine.scene.add(root);
    this.pose();
  }

  get fwdX() { return -Math.sin(this.yaw); }
  get fwdZ() { return -Math.cos(this.yaw); }

  // ---- the drop
  _drop(dt) {
    const g = this.g, T = g.terrain;
    if (this.t < TK.beaconT) {
      const u = this.t / TK.beaconT;
      this.beacon.position.lerpVectors(this.bFrom, this.bPos, u);
      this.beacon.position.y += Math.sin(Math.PI * u) * 2.2;
      this.beacon.rotation.set(u * 9, u * 3, 0);
      return;
    }
    if (!this.landed) { this.landed = true; this.beacon.rotation.set(0, 0, 1.45); this.beacon.position.copy(this.bPos); g.audio.playAt('shell_drop', this.beacon.position, { volume: 0.8, rate: 0.6 }); }
    this.root.visible = true;
    const u = clamp((this.t - TK.beaconT) / TK.fallT, 0, 1), o = 1 - u;
    this.pos.y = this.ground + 56.7 * o * o * o + 13.3 * o;
    this.pitch = Math.sin(this.t * 2.1) * 0.05 * o; this.roll = Math.sin(this.t * 1.7 + 1) * 0.06 * o;
    const f = u < 0.22 ? 0.18 + 3.7 * u : 1 + Math.sin((u - 0.22) * 16) * 0.07 * o;
    for (const m of this.chutes.children) if (m.userData.R) m.scale.set(m.userData.R * f, m.userData.R * (m.userData.R > 3 ? f * f : 1), m.userData.R * f);
    if (u >= 1) this._slam();
  }

  _slam() {
    const g = this.g, kit = this.kit;
    this.state = 'settle'; this.t2 = 0;
    this.pos.y = this.ground; this.yov = -2.6; this.pv = (Math.random() - 0.5) * 0.5; this.rv = (Math.random() - 0.5) * 0.6;
    kit.slam(this);
    // the chutes are cut away: they sag behind the hull and settle on the grass
    this.chutes.updateMatrixWorld(true);
    this.chutes.matrixWorld.decompose(this.chutes.position, this.chutes.quaternion, this.chutes.scale);
    g.engine.scene.add(this.chutes);
    this.chuteFrom = this.chutes.position.clone();
    const dx = -this.fwdX * 10 + (Math.random() - 0.5) * 3, dz = -this.fwdZ * 10 + (Math.random() - 0.5) * 3;
    this.chuteTo = new THREE.Vector3(this.pos.x + dx, g.terrain.heightAt(this.pos.x + dx, this.pos.z + dz) + 0.15, this.pos.z + dz);
    this.chuteT = 0;
  }

  _chutes(dt) {
    if (this.chuteT < 0 || this.chuteT > 3) return;
    this.chuteT += dt;
    const k = smooth(this.chuteT / 3), c = this.chutes;
    c.position.lerpVectors(this.chuteFrom, this.chuteTo, k);
    c.scale.set(1 + 0.15 * k, lerp(1, 0.012, Math.pow(k, 0.7)), 1 + 0.15 * k);
  }

  // ---- physics: throttle and steering in [-1, 1]
  step(dt, thr, steer) {
    const g = this.g, T = g.terrain, col = g.collision, P = this.P;
    const vmax = P.speed, target = thr > 0 ? thr * vmax : thr * 3.6, v0 = this.v;
    const braking = Math.abs(target) < Math.abs(this.v) - 0.05 || target * this.v < 0;
    const acc = braking ? (thr ? 7 : 2.2) : 2.9 * (1 - 0.45 * Math.abs(this.v) / vmax);
    this.v += clamp(target - this.v, -acc * dt, acc * dt);
    const sp = Math.abs(this.v) / vmax;
    this.w += (-steer * lerp(0.95, 0.5, sp) - this.w) * (1 - Math.exp(-3.2 * dt));
    this.yaw += this.w * dt;
    const fx = this.fwdX, fz = this.fwdZ, ox = this.pos.x, oz = this.pos.z;
    this.pos.x += fx * this.v * dt; this.pos.z += fz * this.v * dt;
    // the hull against walls, trunks and props: three capsules along its length, clear of the ground
    let hit = 0;
    for (const k of [-2.05, 0, 2.05]) {
      const cx = this.pos.x + fx * k, cz = this.pos.z + fz * k;
      const c = col.resolveCapsule(_c.set(cx, T.heightAt(cx, cz) + 0.5, cz), 1.45, 1.9);
      if (c.lengthSq() > 1e-8) { const hx = c.x, hz = c.z; this.pos.x += hx; this.pos.z += hz; hit += Math.max(0, -(hx * fx + hz * fz) * Math.sign(this.v)); }
    }
    const ahead = Math.sign(this.v) || 1;
    if (col.waterDepth(this.pos.x + fx * 3.2 * ahead, this.pos.z + fz * 3.2 * ahead) > 1.1) { this.pos.x = ox; this.pos.z = oz; hit = 1; }
    const lay = g.layout, cx0 = lay.playCenter ? lay.playCenter[0] : 20, cz0 = lay.playCenter ? lay.playCenter[1] : -20, lim = (lay.playRadius || 330) - 4;
    const rr = Math.hypot(this.pos.x - cx0, this.pos.z - cz0);
    if (rr > lim) { this.pos.x = cx0 + (this.pos.x - cx0) * lim / rr; this.pos.z = cz0 + (this.pos.z - cz0) * lim / rr; hit = Math.max(hit, 0.01); }
    if (hit > 0.004) { const imp = Math.abs(this.v); this.v *= 0.15; if (imp > 2.5) { this.bump = Math.min(1, imp / 8); this.pv -= 0.25 * ahead * imp / 8; g.audio.playAt('impact_metal', this.pos, { volume: 0.8, rate: 0.6 }); } }
    this.accel = (this.v - v0) / Math.max(dt, 1e-4);
    this._fit(dt);
    this._crush();
    this._tracks(dt);
  }

  // the hull follows the slope on its suspension: pitching over bumps, squatting under power
  _fit(dt) {
    const T = this.g.terrain, fx = this.fwdX, fz = this.fwdZ, rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const h = (a, b) => T.heightAt(this.pos.x + fx * a + rx * b, this.pos.z + fz * a + rz * b);
    const fl = h(2.4, -1.25), fr = h(2.4, 1.25), bl = h(-2.4, -1.25), br = h(-2.4, 1.25);
    const yT = Math.max((fl + fr + bl + br) / 4, T.heightAt(this.pos.x, this.pos.z) - 0.05);
    const pT = Math.atan2(fl + fr - bl - br, 9.6) + clamp(this.accel * 0.0065, -0.035, 0.035);
    const rT = Math.atan2(fr + br - fl - bl, 5) - clamp(this.w * this.v * 0.006, -0.03, 0.03);
    this.pv += ((pT - this.pitch) * 70 - this.pv * 10) * dt; this.pitch += this.pv * dt;
    this.rv += ((rT - this.roll) * 80 - this.rv * 11) * dt; this.roll += this.rv * dt;
    this.pos.y += (yT - this.pos.y) * (1 - Math.exp(-14 * dt));
    if (this.pos.y < yT - 0.06) this.pos.y = yT - 0.06;
  }

  _crush() {
    const Z = this.g.zombies, fx = this.fwdX, fz = this.fwdZ, rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw), half = this.P.crush;
    const moving = Math.abs(this.v) > 0.9 || Math.abs(this.w) > 0.35;
    for (const z of Z.list) {
      if (!z.alive) continue;
      const dx = z.pos.x - this.pos.x, dz = z.pos.z - this.pos.z;
      if (dx * dx + dz * dz > 30 || Math.abs(z.pos.y - this.pos.y) > 1.6) continue;
      const lz = dx * fx + dz * fz, lx = dx * rx + dz * rz;
      if (Math.abs(lx) > half || Math.abs(lz) > 3.45) continue;
      if (moving && this.kit.crush(z, this)) continue;
      const s = Math.sign(lx) || 1, push = half - Math.abs(lx) + 0.02;
      z.pos.x += rx * s * push; z.pos.z += rz * s * push;
    }
  }

  _tracks(dt) {
    const s = [this.v - this.w * TK.track, this.v + this.w * TK.track];
    for (let i = 0; i < 2; i++) {
      this.tOff[i] = ((this.tOff[i] + s[i] * dt) % TRACK_L + TRACK_L) % TRACK_L;
      this.wAng[i] -= (s[i] / 0.33) * dt;
      this.mAcc[i] += Math.abs(s[i]) * dt;
      if (this.mAcc[i] > 0.5) {
        this.mAcc[i] = 0;
        const side = i ? 1 : -1, rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        this.kit.treadMark(this.pos.x + rx * side * TK.track - this.fwdX * 2.75, this.pos.z + rz * side * TK.track - this.fwdZ * 2.75, this.yaw);
      }
    }
  }

  aim(dt, p, cam) {
    this.aimT -= dt;
    if (this.aimT <= 0) {
      this.aimT = 0.1;
      const d = p.forward(_d), h = this.g.collision.raycast(cam.position, d, 400, this._hit);
      const zh = this.g.zombies.raycast(cam.position, d, h ? h.distance : 400);          // the sight lays on a body before the ground behind it
      if (zh) this.aimP.copy(zh.point); else if (h) this.aimP.copy(h.point); else this.aimP.copy(cam.position).addScaledVector(d, 400);
    }
    const o = this.gun.getWorldPosition(_b), ax = this.aimP.x - o.x, ay = this.aimP.y - o.y, az = this.aimP.z - o.z;
    const yawW = Math.atan2(-ax, -az), pitchW = Math.atan2(ay, Math.hypot(ax, az));
    const err = wrap(wrap(yawW - this.yaw) - this.tYaw);
    this.tYaw = wrap(this.tYaw + clamp(err, -1.4 * dt, 1.4 * dt));
    const gT = clamp(pitchW - this.pitch * Math.cos(this.tYaw), -0.12, 0.33);
    this.gPitch += clamp(gT - this.gPitch, -0.7 * dt, 0.7 * dt);
    this.laid = Math.abs(wrap(wrap(yawW - this.yaw) - this.tYaw)) < 0.025 && Math.abs(gT - this.gPitch) < 0.025;
  }

  fire() {
    const g = this.g, kit = this.kit, Z = g.zombies, col = g.collision;
    this.reload = 2.5; this.recoil = 1; this.shots++;
    this.root.updateMatrixWorld(true);
    const m = this.tube.localToWorld(_b.set(0, 0, -TK.muzzle)).clone();
    const d = _d.set(0, 0, -1).transformDirection(this.tube.matrixWorld).clone();
    const side = _a.set(1, 0, 0).transformDirection(this.tube.matrixWorld).clone();
    kit.muzzleBlast(m, d, side);
    const wh = col.raycast(m, d, 450, this._hit);
    const zh = Z.raycast(m, d, wh ? wh.distance : 450);
    let at = null, n = null;
    if (zh) { Z.damage(zh.zombie, 2500, 'body', d); at = zh.point.clone(); }
    else if (wh) { at = wh.point.clone().addScaledVector(d, -0.25); n = wh.normal.clone(); }
    if (at) kit.explode(at, { radius: 5.5, damage: 700, k: 1.15, player: 0.1, normal: n, from: 'tank' });
    this.pv += 0.6 * Math.cos(this.tYaw); this.rv -= 0.6 * Math.sin(this.tYaw);
    this.v -= 0.5 * Math.cos(this.tYaw);
    g.player.shake = Math.min(1.4, g.player.shake + 0.45);
  }

  // the commander's eye: up in the cupola hatch, riding every pitch and roll of the hull
  eyePose(pos, quat, p) {
    this.root.updateMatrixWorld(true);
    pos.copy(TK.eye).applyMatrix4(this.turret.matrixWorld);
    _q.setFromAxisAngle(UP, this.yaw).invert();
    _cq.copy(this.root.quaternion).multiply(_q);                    // the tilt of the hull without its heading
    const t = p.time, sh = p.shake + this.bump, vib = 0.0012 + Math.abs(this.v) * 0.00045;
    _e.set(p.pitch + this.recoil * 0.035 + Math.sin(t * 37) * sh * 0.014 + Math.sin(t * 61) * vib, p.yaw + Math.cos(t * 29) * sh * 0.014 + Math.cos(t * 53) * vib * 0.6, Math.sin(t * 23) * sh * 0.01, 'YXZ');
    quat.copy(_cq).multiply(_q2.setFromEuler(_e));
  }

  // called from the player's update while mounted: input, physics, camera
  drive(dt, p) {
    const i = p.input, cam = this.g.engine.camera;
    if (this.state === 'mount') { this.t2 += dt; if (this.t2 >= 0.7) this.state = 'drive'; }
    p.pitch = clamp(p.pitch, -0.42, 0.5);
    if (this.state === 'drive') {
      this.step(dt, clamp(i.fwd, -1, 1), clamp(i.strafe, -1, 1));
      this.aim(dt, p, cam);
      this.reload = Math.max(0, this.reload - dt);
      // a pull of the trigger is held until the gun is laid on the crosshair
      if (i.fire) this.wantFire = 0.8; else this.wantFire = (this.wantFire || 0) - dt;
      if (this.wantFire > 0 && this.reload <= 0 && this.laid) { this.wantFire = 0; this.fire(); }
    } else this._fit(dt);
    i.fire = false; i.ads = false; i.reload = false; i.bandage = false; i.roll = false; i.jump = false;
    p.shake *= Math.exp(-dt * 5.5); this.bump *= Math.exp(-dt * 6);
    this.recoil = Math.max(0, this.recoil - dt * 2.4);
    this.pose();
    p.pos.copy(this.pos); p.vel.set(this.fwdX * this.v, 0, this.fwdZ * this.v); p.onGround = true; p.fallTop = p.pos.y; p.speed = Math.abs(this.v); p.moving = false; p.sprinting = false;
    this.eyePose(_cp, _cq2, p);
    if (this.state === 'mount') {
      const k = smooth(this.t2 / 0.7), f = this.kit.camFrom;
      cam.position.lerpVectors(f.pos, _cp, k); cam.quaternion.slerpQuaternions(f.quat, _cq2, k);
    } else { cam.position.copy(_cp); cam.quaternion.copy(_cq2); }
    cam.rotation.setFromQuaternion(cam.quaternion, 'YXZ');
    p.eye.copy(cam.position);
    if (Math.abs(cam.fov - p.fov) > 0.01) { cam.fov = p.fov; cam.updateProjectionMatrix(); }
  }

  pose() {
    const r = this.root;
    r.position.set(this.pos.x, this.pos.y + this.yOff, this.pos.z);
    r.quaternion.setFromEuler(_e.set(this.pitch, this.yaw, this.roll, 'YXZ'));
    this.turret.rotation.y = this.tYaw;
    this.gun.rotation.x = this.gPitch;
    this.tube.position.z = Math.pow(this.recoil, 2.5) * 0.42;
    for (const w of this.wheels) w.m.rotation.x = this.wAng[w.i];
    for (let i = 0; i < 2; i++) {
      const x = i ? TK.track : -TK.track;
      for (let k = 0; k < SHOES; k++) {
        let s = (k * SHOE_SP + this.tOff[i]) % TRACK_L, z, y, rot;
        const E = TK.ends, R = TK.R;
        if (s < TRACK_D) { z = -E + s; y = TK.cy - R; rot = 0; }
        else if ((s -= TRACK_D) < Math.PI * R) { const a = s / R; z = E + R * Math.sin(a); y = TK.cy - R * Math.cos(a); rot = a; }
        else if ((s -= Math.PI * R) < TRACK_D) { z = E - s; y = TK.cy + R; rot = Math.PI; }
        else { const a = (s - TRACK_D) / R; z = -E - R * Math.sin(a); y = TK.cy + R * Math.cos(a); rot = Math.PI + a; }
        _m.compose(_v.set(x, y, z), _q.setFromAxisAngle(_a.set(1, 0, 0), -rot), _s.set(1, 1, 1));
        this.tracks.setMatrixAt(i * SHOES + k, _m);
      }
    }
    this.tracks.instanceMatrix.needsUpdate = true;
  }

  // ---- after the drive: cover for a while, then the crew takes it away
  park() {
    const g = this.g, f = g.zombies.flow;
    this.state = 'park'; this.parkT = 18; this.v = 0; this.w = 0;
    this.box = g.collision.addBox({ x: this.pos.x, y: this.pos.y - 0.05, z: this.pos.z, hx: TK.half, hz: 3.35, h: 2.3, yaw: this.yaw, surface: 'metal' });
    this.cells = [];
    if (f) {
      const fx = this.fwdX, fz = this.fwdZ, rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      for (let a = -3.2; a <= 3.2; a += f.cell * 0.5) for (let b = -1.4; b <= 1.4; b += f.cell * 0.5) {
        const c = f.cellOf(this.pos.x + fx * a + rx * b, this.pos.z + fz * a + rz * b);
        if (c >= 0 && f.walk[c] && !this.cells.some((e) => e[0] === c)) { this.cells.push([c, f.walk[c]]); f.walk[c] = 0; }
      }
    }
  }

  _unpark() {
    const g = this.g, f = g.zombies.flow;
    if (this.box) { g.collision.removeBox(this.box); this.box = null; }
    if (this.cells && f) for (const [c, w] of this.cells) f.walk[c] = w;
    this.cells = null;
  }

  _leave(dt) {
    const g = this.g, col = g.collision;
    this.leaveT += dt;
    if (!this.dirSign) {
      const free = (s) => { const h = col.raycast(_a.set(this.pos.x, this.pos.y + 1.2, this.pos.z), _b.set(this.fwdX * s, 0, this.fwdZ * s), 45, this._hit); return h ? h.distance : 45; };
      this.dirSign = free(1) >= free(-1) ? 1 : -1;
    }
    let steer = 0;
    if (this.turnT > 0) { this.turnT -= dt; steer = 1; } else if (Math.abs(this.v) < 0.4 && this.leaveT > 2) { this.stuckT += dt; if (this.stuckT > 1.2) { this.turnT = 1.6; this.stuckT = 0; } } else this.stuckT = 0;
    this.step(dt, this.turnT > 0 ? 0 : 0.6 * this.dirSign, steer);
  }

  update(dt) {
    const g = this.g, p = g.player;
    this.t += dt;
    if (this.state === 'drop') this._drop(dt);
    else if (this.state === 'settle') {
      this.t2 += dt; this._fit(dt);
      if (this.t2 > 0.45) { if (this.noMount || !p.alive || p.vehicle) this.park(); else this.kit.mount(this); }
    } else if (this.state === 'park') {
      this._fit(dt);
      this.parkT -= dt;
      if (this.parkT <= 0 && Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) > 6) { this._unpark(); this.state = 'leave'; this.leaveT = 0; }
    } else if (this.state === 'leave') {
      this._leave(dt);
      const d = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
      const seen = g._visible(this.pos.x, this.pos.y + 1.4, this.pos.z) || g._visible(this.pos.x, this.pos.y + 0.4, this.pos.z);
      if ((d > 22 && !seen) || d > 110) return false;
    }
    // suspension after the slam
    this.yov += (-this.yOff * 130 - this.yov * 9) * dt; this.yOff += this.yov * dt;
    if (this.yOff < -0.13) { this.yOff = -0.13; this.yov = Math.max(0, this.yov); }
    this._chutes(dt);
    // signal smoke from the beacon until the hull covers it, exhaust smoke under load
    if (this.landed && this.t < TK.beaconT + TK.fallT + 4) {
      this.sigT -= dt;
      while (this.sigT < 0) { this.sigT += 0.05; const r = Math.random; g.fx.spawn({ x: this.bPos.x, y: this.bPos.y + 0.15, z: this.bPos.z, vx: (r() - 0.5) * 0.6, vy: 1.4 + r() * 0.8, vz: (r() - 0.5) * 0.6, size: 0.22, grow: 1.2, life: 2 + r(), drag: 0.9, grav: -0.2, r: 0.72, g: 0.3, b: 0.24, a: 0.28 }); }
    }
    if (this.state === 'drive' || this.state === 'leave' || this.state === 'park') {
      const load = this.state === 'park' ? 0.15 : 0.3 + Math.abs(this.accel) * 0.25 + Math.abs(this.v) * 0.04;
      this.smokeT -= dt * load * 8;
      if (this.smokeT < 0) {
        this.smokeT = 1;
        this.root.updateMatrixWorld(true);
        const e = _a.set(0.9, 1.5, 3.2).applyMatrix4(this.root.matrixWorld), r = Math.random;
        g.fx.spawn({ x: e.x, y: e.y, z: e.z, vx: -this.fwdX * 0.6 + (r() - 0.5) * 0.4, vy: 0.8 + r() * 0.5, vz: -this.fwdZ * 0.6 + (r() - 0.5) * 0.4, size: 0.2, grow: 0.9, life: 1.6 + r(), drag: 1.2, grav: -0.2, r: 0.2, g: 0.2, b: 0.19, a: 0.22 });
      }
    }
    if (this.state !== 'drive' && this.state !== 'mount') this.pose();
    return true;
  }

  dispose() {
    const g = this.g;
    this._unpark();
    g.engine.scene.remove(this.root); g.engine.scene.remove(this.chutes);
    this.tracks.dispose(); this.lines.geometry.dispose();
  }
}
const _cq2 = new THREE.Quaternion();

// ---------------------------------------------------------------- sentry
class Sentry {
  constructor(kit, pos, yaw, P, from) {
    const g = this.g = kit.game, { M, G } = kit.res();
    this.kit = kit; this.P = P; this.pos = pos.clone(); this.yaw0 = yaw; this.from = from.clone();
    this.state = 'place'; this.t = 0; this.k = 0; this.aYaw = 0; this.aPitch = 0; this.yv = 0; this.pv = 0;
    this.target = null; this.scanT = 0; this.fireT = 0; this.burst = 0; this.pauseT = 0; this.kick = 0;
    this.shots = 0; this.kills = 0; this.blockedShots = 0;
    const add = (parent, geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
    const root = this.root = new THREE.Group();
    this.legs = [];
    for (const a of [Math.PI, Math.PI / 3, -Math.PI / 3]) { const o = new THREE.Group(), i = new THREE.Group(); o.rotation.y = a; o.add(i); add(i, G.leg, M.steel); root.add(o); this.legs.push({ o, i }); }
    this.head = new THREE.Group(); root.add(this.head); add(this.head, G.sHead, M.steel);
    this.cradle = new THREE.Group(); this.cradle.position.y = 0.15; this.head.add(this.cradle);
    add(this.cradle, G.sGun, M.paint); add(this.cradle, G.sSteel, M.steel); add(this.cradle, G.sGlass, M.glass);
    this._hit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
    g.engine.scene.add(root);
    this.pose();
  }

  get hubY() { return 0.8 * Math.cos(lerp(0.08, 0.62, this.k)) + 0.02; }

  pose() {
    const splay = lerp(0.08, 0.62, this.k), hy = this.hubY, r = this.root;
    if (this.state === 'place') {
      const u = smooth(this.t / 0.35);
      r.position.lerpVectors(this.from, this.pos, u); r.position.y += Math.sin(Math.PI * u) * 0.25;
    } else r.position.copy(this.pos);
    r.rotation.y = this.yaw0;
    for (const l of this.legs) { l.o.position.y = hy; l.i.rotation.x = splay; }
    this.head.position.y = hy; this.head.rotation.y = this.aYaw;
    this.cradle.rotation.x = this.aPitch + (1 - this.k) * 1.3;
    this.cradle.position.z = this.kick * 0.02;
  }

  _pivot(out) { return out.set(this.pos.x, this.pos.y + this.hubY + 0.18, this.pos.z); }
  _chest(z, out) { const b = z.bones && z.bones.Chest; if (b) { z.root.updateWorldMatrix(true, true); return b.getWorldPosition(out); } return out.set(z.pos.x, z.pos.y + 1.2 * (z.scale || 1), z.pos.z); }

  // nearest infected in range that the gun can see (no shooting through walls, roofs or hills)
  _pick() {
    const g = this.g, col = g.collision, o = this._pivot(_a), R = this.P.range;
    let best = null, bd = R;
    for (const z of g.zombies.list) {
      if (!z.alive) continue;
      const d0 = Math.hypot(z.pos.x - o.x, z.pos.z - o.z);
      if (d0 > bd) continue;
      const c = this._chest(z, _b), d = c.distanceTo(o);
      if (d > bd || d < 0.5) continue;
      if (col.raycast(o, _d.subVectors(c, o).multiplyScalar(1 / d), d - 0.35, this._hit)) continue;
      best = z; bd = d;
    }
    return best;
  }

  _think(dt) {
    const g = this.g;
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 0.12; this.target = this._pick(); }
    const z = this.target && this.target.alive ? this.target : null;
    let dY, dP;
    if (z) {
      const o = this._pivot(_a), c = this._chest(z, _b);
      dY = Math.atan2(-(c.x - o.x), -(c.z - o.z)) - this.yaw0; dP = Math.atan2(c.y - o.y, Math.hypot(c.x - o.x, c.z - o.z));
    } else { dY = Math.sin(this.t * 0.45) * 0.7; dP = 0; }
    const eY = wrap(dY - this.aYaw), eP = dP - this.aPitch;
    this.yv += (clamp(eY * 7, -2.6, 2.6) - this.yv) * (1 - Math.exp(-12 * dt));
    this.pv += (clamp(eP * 7, -1.5, 1.5) - this.pv) * (1 - Math.exp(-12 * dt));
    this.aYaw = wrap(this.aYaw + this.yv * dt); this.aPitch = clamp(this.aPitch + this.pv * dt, -0.6, 0.8);
    this.pauseT -= dt; this.fireT -= dt;
    if (z && Math.abs(eY) < 0.05 && Math.abs(eP) < 0.06) {
      if (this.burst <= 0 && this.pauseT <= 0) this.burst = 5 + Math.floor(Math.random() * 4);
      if (this.burst > 0 && this.fireT <= 0) { this.fireT = 1 / this.P.rate; this.burst--; this._shoot(); if (this.burst <= 0) this.pauseT = 0.35; }
    } else if (!z) this.burst = 0;
  }

  _shoot() {
    const g = this.g, fx = g.fx, Z = g.zombies, col = g.collision, P = this.P, r = Math.random;
    this.root.updateMatrixWorld(true);
    const m = this.cradle.localToWorld(_a.set(0, 0.03, -1.04)).clone();
    const d = _d.set(0, 0, -1).transformDirection(this.cradle.matrixWorld);
    d.x += (r() - 0.5) * 0.018; d.y += (r() - 0.5) * 0.018; d.z += (r() - 0.5) * 0.018; d.normalize();
    const dir = d.clone();
    const zh = Z.raycast(m, dir, P.range + 4);
    const wh = col.raycast(m, dir, zh ? zh.distance : P.range + 40, this._hit);
    let end;
    if (zh && (!wh || zh.distance < wh.distance)) {
      const z = zh.zombie, was = z.alive;
      Z.damage(z, P.damage * (zh.part === 'head' ? 3 : zh.mult), zh.part, dir);
      if (was && !z.alive) this.kills++;
      fx.blood(zh.point, dir, 0.8);
      g.audio.playAt('impact_flesh', zh.point, { volume: 0.5, pitchVar: 0.1, ref: 5 });
      end = zh.point;
    } else if (wh) { fx.impact(wh.point, wh.normal, wh.surface, dir, 0.75); end = wh.point.clone(); if (zh) this.blockedShots++; }
    else end = m.clone().addScaledVector(dir, 90);
    fx.tracer(m, end);
    for (let i = 0; i < 2; i++) fx.spawn({ x: m.x + dir.x * 0.06 * i, y: m.y + dir.y * 0.06 * i, z: m.z + dir.z * 0.06 * i, vx: dir.x * 3, vy: dir.y * 3, vz: dir.z * 3, size: 0.2 + r() * 0.14, life: 0.045, r: 7, g: 4.2, b: 1.6, a: 1, add: true, fadeIn: 0.001 });
    if (this.shots % 3 === 0) fx.muzzleSmoke(m, dir, 0.55);
    this.kit.flash(m, 70, 30);
    const ej = this.cradle.localToWorld(_b.set(0.06, 0.03, -0.05));
    const side = _c.set(1, 0, 0).transformDirection(this.cradle.matrixWorld);
    fx.casing(ej, _v.set(side.x * 2.2 + (r() - 0.5) * 0.6, 1.6 + r(), side.z * 2.2 + (r() - 0.5) * 0.6), { scale: [1.05, 1.35] });
    g.audio.playAt('sentry_fire', m, { volume: 0.85, pitchVar: 0.05, ref: 7 });
    this.kick = 1; this.shots++;
  }

  update(dt) {
    const g = this.g, p = g.player;
    this.t += dt;
    this.kick = Math.max(0, this.kick - dt * 14);
    if (this.state === 'place') { if (this.t >= 0.35) { this.state = 'unfold'; this.t = 0; g.audio.playAt('mag_in', this.pos, { volume: 0.7, rate: 0.7 }); } }
    else if (this.state === 'unfold') { this.k = smooth(this.t / 0.9); if (this.t >= 0.9) { this.state = 'active'; this.t = 0; this.k = 1; g.audio.playAt('bolt_rack', this.pos, { volume: 0.8 }); } }
    else if (this.state === 'active') this._think(dt);
    else if (this.state === 'fold') {
      this.aYaw *= Math.exp(-dt * 6); this.aPitch *= Math.exp(-dt * 6);
      this.k = 1 - smooth(this.t / 0.9);
      if (this.t >= 0.9) { this.state = 'packed'; this.t = 0; this.k = 0; }
    } else if (this.state === 'packed') {
      const d = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
      if ((d > 8 && !g._visible(this.pos.x, this.pos.y + 0.5, this.pos.z)) || d > 60) return false;
    }
    this.pose();
    return true;
  }

  fold() { if (this.state === 'packed' || this.state === 'fold') return; this.state = 'fold'; this.t = 0; this.g.audio.playAt('mag_out', this.pos, { volume: 0.7, rate: 0.8 }); }
  dispose() { this.g.engine.scene.remove(this.root); }
}

// ---------------------------------------------------------------- the kit
export class Abilities {
  constructor(op) {
    this.op = op; const g = this.game = op.game;
    this._res = null;
    this.tanks = []; this.sentries = []; this.litter = []; this.shells = []; this.marks = []; this.jet = null; this.camBlend = null;
    this.ts = 1; this.tsTarget = 1; this.post0 = null; this.time = 0; this.lastWhistle = -9;
    this.camFrom = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.stats = { crushed: 0, blastKills: 0, blastHits: 0, lastBlast: null, jump: null };
    this._hit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
    // one shared flash light for blasts, muzzles and the jump pack (added once: no shader rebuilds later)
    this.light = new THREE.PointLight(0xffb072, 0, 45, 2); this.light.castShadow = false;
    this.lightI = 0; this.lightK = 10;
    g.engine.scene.add(this.light);
    const { M } = this.res();
    this.rings = [];
    for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), M.ring.clone()); m.visible = false; m.renderOrder = 12; m.frustumCulled = false; g.engine.scene.add(m); this.rings.push({ m, t: 1, life: 0.5, R: 1 }); }
    const decals = (mat, n) => { const d = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, n); d.count = 0; d.frustumCulled = false; d.receiveShadow = true; d.renderOrder = 10; g.engine.scene.add(d); return d; };
    this.scorches = decals(M.scorch, 24); this.scorchI = 0;
    this.treads = decals(M.tread, 600); this.treadI = 0;
    g.audio.preload(['explosion', 'mortar_whistle', 'sentry_fire', 'tank_engine', 'tank_tracks', 'heartbeat', 'impact_metal', 'land_hard']);
    const reg = (id, o) => op.registerAbility(id, o);
    reg('tank', { start: (ab) => this.tankStart(ab), update: (ab, dt) => this.tankUpdate(ab, dt), end: (ab) => this.tankEnd(ab) });
    reg('mortar', { start: (ab) => this.mortarStart(ab) });
    reg('sentry', { start: (ab) => this.sentryStart(ab), end: (ab) => { if (ab.sentry) ab.sentry.fold(); ab.sentry = null; } });
    reg('adrenaline', { start: (ab) => { this.tsTarget = ab.params.timeScale; this.game.audio.playFirst('adrenaline', 'bandage', { volume: 0.5 }, { rate: 1.4 }); return true; }, end: () => { this.tsTarget = 1; } });
    reg('jump', { start: (ab) => this.jumpStart(ab) });
  }

  res() { return this._res || (this._res = buildResources()); }

  refuse(ab, text) { const g = this.game; g.audio.play('ui_error', { volume: 0.3 }); if (text) g.ui?.toast(ab.name, text); return false; }

  flash(pos, I, k = 10) {
    if (I < this.lightI * 0.5) return;
    this.light.position.copy(pos); this.lightI = Math.max(I, this.lightI); this.lightK = k;
  }

  // ---------------------------------------------------------------- tank
  // open, dry, level ground about a dozen metres ahead with room for the hull and nothing overhead
  _dropSpot() {
    const g = this.game, p = g.player, T = g.terrain, col = g.collision, f = g.zombies.flow;
    for (const d of [12, 10, 14, 9, 16, 7.5]) for (const off of [0, 0.3, -0.3, 0.6, -0.6]) {
      const yaw = p.yaw + off, fx = -Math.sin(yaw), fz = -Math.cos(yaw), x = p.pos.x + fx * d, z = p.pos.z + fz * d;
      if (f && !f.walkable(x, z)) continue;
      if (col.waterDepth(x, z) > 0.3 || T.normalAt(x, z, _n).y < 0.9) continue;
      let ok = true;
      for (const k of [-2.6, 0, 2.6]) {
        const cx = x + fx * k, cz = z + fz * k, y = T.heightAt(cx, cz);
        if ((f && !f.walkable(cx, cz)) || col.resolveCapsule(_c.set(cx, y + 0.45, cz), 1.5, 1.9).lengthSq() > 1e-6) { ok = false; break; }
        if (col.raycastMesh(_a.set(cx, y + 60, cz), DOWN, 57, this._hit)) { ok = false; break; }
      }
      if (ok) return { x, z, yaw };
    }
    return null;
  }

  tankStart(ab) {
    const g = this.game, p = g.player;
    if (p.vehicle || !p.alive) return this.refuse(ab);
    if (this.tanks.length >= 2) { const old = this.tanks.find((t) => t.state === 'leave' || t.state === 'park'); if (old) { old.dispose(); this.tanks.splice(this.tanks.indexOf(old), 1); } }
    const s = this._dropSpot();
    if (!s) return this.refuse(ab, 'No open ground for the drop ahead');
    ab.tank = new Tank(this, s.x, s.z, s.yaw, ab.params);
    this.tanks.push(ab.tank);
    g.audio.playFirst('throw', 'roll', { volume: 0.6 }, { rate: 1.4, volume: 0.4 });
    return true;
  }

  // the drive time starts once the crew hands over
  tankUpdate(ab, dt) { const t = ab.tank; if (t && (t.state === 'drop' || t.state === 'settle' || t.state === 'mount')) ab.active = Math.min(ab.duration, ab.active + dt); }

  tankEnd(ab) {
    const t = ab.tank; ab.tank = null;
    if (!t) return;
    if (t.state === 'drive' || t.state === 'mount') this.dismount(t);
    else t.noMount = true;
  }

  mount(t) {
    const g = this.game, p = g.player, cam = g.engine.camera;
    this.camFrom.pos.copy(cam.position); this.camFrom.quat.copy(cam.quaternion);
    t.state = 'mount'; t.t2 = 0;
    p.vehicle = t; p.vel.set(0, 0, 0); p.rollT = 0; p.bandageT = 0;
    g.weapon.visible = false;
    p.pitch = clamp(p.pitch, -0.3, 0.3);
    g.audio.playAt('land_hard', t.pos, { volume: 0.5, rate: 1.2 });
  }

  // the player climbs down beside the hull, on whichever side has room
  dismount(t) {
    const g = this.game, p = g.player, col = g.collision, T = g.terrain, f = g.zombies.flow, cam = g.engine.camera;
    if (p.vehicle !== t) return;
    this.camBlend = { pos: cam.position.clone(), quat: cam.quaternion.clone(), t: 0 };
    const fx = t.fwdX, fz = t.fwdZ, rx = Math.cos(t.yaw), rz = -Math.sin(t.yaw);
    let spot = null;
    for (const [a, b] of [[0.6, -2.35], [0.6, 2.35], [-1.6, -2.35], [-1.6, 2.35], [-4.4, 0], [4.6, 0], [2, -2.6], [2, 2.6]]) {
      const x = t.pos.x + fx * a + rx * b, z = t.pos.z + fz * a + rz * b;
      if ((f && !f.walkable(x, z)) || col.waterDepth(x, z) > 0.5) continue;
      if (col.resolveCapsule(_c.set(x, T.heightAt(x, z) + 0.05, z), 0.42, 1.8).lengthSq() > 1e-6) continue;
      spot = [x, z]; break;
    }
    if (!spot) spot = [t.pos.x + rx * -2.4, t.pos.z + rz * -2.4];
    p.vehicle = null;
    p.pos.set(spot[0], T.heightAt(spot[0], spot[1]), spot[1]);
    p.pos.y = col.floorAt(spot[0], p.pos.y + 1, spot[1], 2);
    p.vel.set(0, 0, 0); p.onGround = true; p.fallTop = p.pos.y; p.fallPend = 0;
    g.weapon.visible = true;
    t.park();
  }

  // the hull comes down: turf and dust thrown out from under it, anything beneath it is gone
  slam(t) {
    const g = this.game, fx = g.fx, p = g.player, r = Math.random, x = t.pos.x, y = t.pos.y, z = t.pos.z;
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * TAU + r() * 0.15, c = Math.cos(a), s = Math.sin(a), v = 7 + r() * 5;
      fx.spawn({ x: x + c * 2.2, y: y + 0.25, z: z + s * 3, vx: c * v, vy: 0.6 + r() * 1.4, vz: s * v, size: 0.6 + r() * 0.5, grow: 2.2, life: 1.6 + r() * 1.2, drag: 2.2, grav: -0.1, r: 0.46, g: 0.41, b: 0.33, a: 0.34 });
    }
    for (let i = 0; i < 30; i++) {
      const a = r() * TAU, v = 2 + r() * 5;
      fx.spawn({ x: x + Math.cos(a) * 1.8, y: y + 0.2, z: z + Math.sin(a) * 3, vx: Math.cos(a) * v, vy: 3 + r() * 5, vz: Math.sin(a) * v, size: 0.05 + r() * 0.1, life: 1 + r() * 0.8, grav: 13, drag: 0.3, r: 0.2, g: 0.17, b: 0.12, a: 1, fadeIn: 0.001, ground: true, spin: 14 });
    }
    this.ring(x, g.terrain.heightAt(x, z), z, 4.2);
    g.audio.playAt('land_hard', t.pos, { volume: 1, rate: 0.5, ref: 12 });
    g.audio.playAt('explosion', t.pos, { volume: 0.55, rate: 0.6, ref: 10 });
    const d = g.engine.camera.position.distanceTo(t.pos);
    p.shake = Math.min(1.4, p.shake + 6 / (d + 4));
    // nothing survives under twelve tonnes
    const fwX = t.fwdX, fwZ = t.fwdZ, rx = Math.cos(t.yaw), rz = -Math.sin(t.yaw);
    for (const zb of g.zombies.list) {
      if (!zb.alive) continue;
      const dx = zb.pos.x - x, dz = zb.pos.z - z;
      if (Math.abs(dx * rx + dz * rz) < 1.6 && Math.abs(dx * fwX + dz * fwZ) < 3.5) this.crush(zb, t, true);
    }
    const dx = p.pos.x - x, dz = p.pos.z - z, lx = dx * rx + dz * rz, lz = dx * fwX + dz * fwZ;
    if (Math.abs(lx) < 2 && Math.abs(lz) < 3.9) { const s = Math.sign(lx) || 1, push = 2.1 - Math.abs(lx); p.pos.x += rx * s * push; p.pos.z += rz * s * push; p.knock(rx * s, rz * s, 3, 2); }
  }

  crush(z, t, drop = false) {
    const g = this.game, fx = g.fx, Z = g.zombies, s = Math.sign(t.v) || 1;
    const dir = _d.set(t.fwdX * s, -0.3, t.fwdZ * s).normalize().clone();
    if (z.def.boss && !drop) { Z.damage(z, 1400, 'body', dir); return false; }
    Z.damage(z, z.health * 20 + 5000, 'body', dir);
    if (z.alive) return false;
    this.stats.crushed++; t.kills++;
    const pt = _a.set(z.pos.x, z.pos.y + 0.7, z.pos.z);
    fx.blood(pt, dir, 2.6); fx.blood(pt, UP, 1.6);
    const gy = g.terrain.heightAt(z.pos.x, z.pos.z), n = g.terrain.normalAt(z.pos.x, z.pos.z, _n);
    if (z.pos.y - gy < 0.3) {
      fx.bloodSplat(_b.set(z.pos.x, gy, z.pos.z), n, 1.4 + Math.random() * 0.5);
      fx.bloodSplat(_b.set(z.pos.x + dir.x * 1.2, g.terrain.heightAt(z.pos.x + dir.x * 1.2, z.pos.z + dir.z * 1.2), z.pos.z + dir.z * 1.2), n, 0.9);
      fx.bloodPool(_b.set(z.pos.x, gy, z.pos.z), n, 0.75);
    }
    g.audio.playAt('impact_flesh', pt, { volume: 1, rate: 0.7, ref: 6 });
    g.audio.playAt('blood_splat', pt, { volume: 0.6, ref: 4 });
    if (g.player.vehicle === t) g.ui?.hitMarker(true, false);
    return true;
  }

  treadMark(x, z, yaw) {
    const g = this.game, T = g.terrain;
    if (g.collision.waterDepth(x, z) > 0) return;
    const n = T.normalAt(x, z, _n);
    _q.setFromUnitVectors(UP, n).multiply(_q2.setFromAxisAngle(UP, yaw)).multiply(_cq.setFromAxisAngle(_a.set(1, 0, 0), -Math.PI / 2));
    _m.compose(_v.set(x, T.heightAt(x, z) + 0.015, z), _q, _s.set(0.46, 0.52, 1));
    this.treads.setMatrixAt(this.treadI % 600, _m);
    this.treadI++; this.treads.count = Math.min(this.treadI, 600); this.treads.instanceMatrix.needsUpdate = true;
  }

  // the main gun: the flash, the side jets from the muzzle brake, the dust the blast lifts off the ground
  muzzleBlast(m, d, side) {
    const g = this.game, fx = g.fx, r = Math.random;
    for (let i = 0; i < 6; i++) { const k = i * 0.35; fx.spawn({ x: m.x + d.x * k, y: m.y + d.y * k, z: m.z + d.z * k, vx: d.x * 6, vy: d.y * 6, vz: d.z * 6, size: 1.5 - i * 0.16 + r() * 0.3, grow: 3, life: 0.07 + r() * 0.04, r: 9, g: 5, b: 1.8, a: 1, add: true, fadeIn: 0.001 }); }
    for (const s of [-1, 1]) for (let i = 0; i < 7; i++) {
      const v = 9 + r() * 12, ox = side.x * s, oz = side.z * s;
      fx.spawn({ x: m.x + d.x * 0.15, y: m.y, z: m.z + d.z * 0.15, vx: ox * v + d.x * 2, vy: (r() - 0.4) * 2, vz: oz * v + d.z * 2, size: 0.25 + r() * 0.3, grow: 3.5, life: i < 2 ? 0.08 : 0.9 + r() * 1.2, drag: 3.2, grav: -0.3, r: i < 2 ? 6 : 0.6, g: i < 2 ? 3 : 0.58, b: i < 2 ? 1 : 0.55, a: i < 2 ? 1 : 0.3, add: i < 2, fadeIn: 0.001 });
    }
    for (let i = 0; i < 14; i++) { const v = 4 + r() * 16; fx.spawn({ x: m.x, y: m.y, z: m.z, vx: d.x * v + (r() - 0.5) * 2, vy: d.y * v + 0.4 + r() * 0.8, vz: d.z * v + (r() - 0.5) * 2, size: 0.5 + r() * 0.4, grow: 2.4, life: 1.8 + r() * 2, drag: 1.7, grav: -0.25, r: 0.62, g: 0.6, b: 0.57, a: 0.3, fadeIn: 0.05 }); }
    const gy = g.terrain.heightAt(m.x, m.z);
    if (m.y - gy < 3.5) for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU, c = Math.cos(a), s = Math.sin(a), v = 5 + r() * 4;
      fx.spawn({ x: m.x + c * 0.5, y: gy + 0.3, z: m.z + s * 0.5, vx: c * v + d.x * 3, vy: 0.5 + r(), vz: s * v + d.z * 3, size: 0.5 + r() * 0.4, grow: 2.2, life: 1.3 + r(), drag: 2.4, grav: -0.1, r: 0.5, g: 0.45, b: 0.36, a: 0.3 });
    }
    this.flash(m, 1600, 14);
    g.audio.playAt('explosion', m, { volume: 1, rate: 1.25, ref: 16 });
    g.audio.playAt('sniper_shot', m, { volume: 1, rate: 0.55, ref: 16 });
  }

  // flash, fireball, a fountain of dirt, a smoke column, a shock ring in the grass, a scorch, the shake and the damage
  explode(pos, o) {
    const g = this.game, fx = g.fx, p = g.player, T = g.terrain, r = Math.random, R = o.radius, k = o.k ?? 1;
    const gy = T.heightAt(pos.x, pos.z), onGround = pos.y - gy < 0.8;
    const n = o.normal || (onGround ? T.normalAt(pos.x, pos.z, new THREE.Vector3()) : UP);
    const x = pos.x + n.x * 0.15, y = pos.y + n.y * 0.15, z = pos.z + n.z * 0.15;
    for (let i = 0; i < 4; i++) fx.spawn({ x, y: y + 0.5, z, vx: (r() - 0.5) * 2, vy: 1 + r() * 2, vz: (r() - 0.5) * 2, size: (1.8 + r() * 1.6) * k, grow: 5 * k, life: 0.09 + r() * 0.07, r: 9, g: 5.5, b: 2.2, a: 1, add: true, fadeIn: 0.001 });
    for (let i = 0; i < 7; i++) { const a = r() * TAU, s = 2 + r() * 5; fx.spawn({ x, y: y + 0.3, z, vx: Math.cos(a) * s, vy: 2 + r() * 5, vz: Math.sin(a) * s, size: (0.7 + r() * 0.8) * k, grow: 2.4 * k, life: 0.25 + r() * 0.25, drag: 3, grav: -1, r: 4.2, g: 1.7, b: 0.45, a: 0.9, add: true, fadeIn: 0.01 }); }
    for (let i = 0; i < 26; i++) {
      const a = r() * TAU, s = (1 + r() * 4.5) * k, up = (7 + r() * 11) * k;
      fx.spawn({ x, y, z, vx: Math.cos(a) * s + n.x * up * 0.4, vy: up * Math.max(0.3, n.y), vz: Math.sin(a) * s + n.z * up * 0.4, size: 0.05 + r() * 0.12, life: 1 + r(), grav: 13, drag: 0.35, r: 0.19, g: 0.15, b: 0.11, a: 1, fadeIn: 0.001, ground: true, spin: 16 });
    }
    for (let i = 0; i < 10; i++) { const a = r() * TAU, s = 1 + r() * 3; fx.spawn({ x, y: y + 0.3, z, vx: Math.cos(a) * s, vy: (3 + r() * 7) * k, vz: Math.sin(a) * s, size: (0.9 + r() * 0.8) * k, grow: 2.4 * k, life: 2.6 + r() * 1.8, drag: 1.4, grav: 0.4, r: 0.4, g: 0.34, b: 0.26, a: 0.42 }); }
    for (let i = 0; i < 7; i++) fx.spawn({ x: x + (r() - 0.5) * 1.2, y: y + 0.8 + i * 0.55, z: z + (r() - 0.5) * 1.2, vx: (r() - 0.5) * 0.6, vy: 2.2 + r() * 2.5, vz: (r() - 0.5) * 0.6, size: (1.1 + r() * 0.6) * k, grow: 1.5 * k, life: 4.5 + r() * 2.5, drag: 0.7, grav: -0.25, r: 0.17, g: 0.165, b: 0.16, a: 0.5, fadeIn: 0.25 });
    if (onGround) {
      for (let i = 0; i < 22; i++) { const a = (i / 22) * TAU + r() * 0.2, c = Math.cos(a), s = Math.sin(a), v = R * (2.2 + r() * 0.8); fx.spawn({ x: x + c * 0.6, y: gy + 0.3, z: z + s * 0.6, vx: c * v, vy: 0.4 + r() * 0.8, vz: s * v, size: 0.45 + r() * 0.3, grow: 1.6, life: 0.9 + r() * 0.6, drag: 2.6, grav: -0.1, r: 0.52, g: 0.47, b: 0.38, a: 0.28 }); }
      this.ring(x, gy, z, R);
    }
    this.scorch(pos, n, R * 0.7);
    this.flash(_v.set(x, y + 1.2, z), 1100 * k, 9);
    g.audio.playAt('explosion', pos, { volume: 1, pitchVar: 0.1, ref: 14, rolloff: 0.9 });
    const d = g.engine.camera.position.distanceTo(pos);
    p.shake = Math.min(1.6, p.shake + (7 * k) / (d + 5));
    if (d < 22 && !p.vehicle) p.landKick = Math.min(1, p.landKick + (22 - d) / 44);
    this._blast(pos, R, o.damage, o.player || 0);
  }

  _blast(pos, R, dmg, playerK) {
    const g = this.game, Z = g.zombies, col = g.collision, p = g.player;
    const o = _c.set(pos.x, pos.y + 0.5, pos.z), out = { hits: 0, kills: 0, player: 0, at: [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)] };
    for (const z of Z.list) {
      if (!z.alive) continue;
      const dx = z.pos.x - pos.x, dy = z.pos.y + 0.9 - pos.y, dz = z.pos.z - pos.z, d = Math.hypot(dx, dy, dz);
      if (d > R) continue;
      let f = 1 - 0.75 * (d / R);
      if (!col.lineOfSight(o, _b.set(z.pos.x, z.pos.y + 0.9, z.pos.z))) f *= 0.25;
      const dir = _d.set(dx, Math.max(0.3, dy), dz).normalize();
      Z.damage(z, dmg * f, 'body', dir); out.hits++;
      if (!z.alive) out.kills++;
      if (f > 0.4) g.fx.blood(_b, dir, 1.2);
    }
    const pd = Math.hypot(p.pos.x - pos.x, p.pos.y + 0.9 - pos.y, p.pos.z - pos.z);
    if (playerK > 0 && pd < R && p.alive && !p.vehicle) {
      out.player = dmg * playerK * (1 - 0.75 * pd / R);
      p.damage(out.player, _d.set(p.pos.x - pos.x, 0, p.pos.z - pos.z).normalize(), 'blast');
    }
    this.stats.blastHits += out.hits; this.stats.blastKills += out.kills; this.stats.lastBlast = out;
  }

  ring(x, y, z, R) {
    const rg = this.rings.find((e) => e.t >= e.life) || this.rings[0];
    rg.t = 0; rg.R = R; rg.life = 0.5;
    rg.m.position.set(x, y + 0.2, z); rg.m.visible = true;
    rg.m.quaternion.setFromUnitVectors(UP, this.game.terrain.normalAt(x, z, _n));
  }

  scorch(pos, n, size) {
    _q.setFromUnitVectors(ZAX, n).multiply(_q2.setFromAxisAngle(ZAX, Math.random() * TAU));
    _m.compose(_v.copy(pos).addScaledVector(n, 0.03), _q, _s.set(size * 2, size * 2, 1));
    this.scorches.setMatrixAt(this.scorchI % 24, _m);
    this.scorchI++; this.scorches.count = Math.min(this.scorchI, 24); this.scorches.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- mortar
  mortarStart(ab) {
    const g = this.game, p = g.player, P = ab.params, col = g.collision;
    const h = col.raycast(p.eye, p.forward(_d), P.range, this._hit);
    if (!h) return this.refuse(ab, `Mark the ground within ${P.range} m`);
    const mark = h.point.clone();
    this.marks.push({ pos: mark, t: 0, life: P.delay + 4.5, puff: 0 });
    const n = P.shells, span = 2.4 + n * 0.12;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, rr = P.spread * 0.5 * Math.sqrt(Math.random()), x = mark.x + Math.cos(a) * rr, z = mark.z + Math.sin(a) * rr;
      const s = col.raycast(_a.set(x, mark.y + 40, z), DOWN, 90, this._hit);
      const pos = s ? s.point.clone() : new THREE.Vector3(x, g.terrain.heightAt(x, z), z);
      const normal = s ? s.normal.clone() : UP.clone();
      this.shells.push({ t: P.delay + (n > 1 ? i / (n - 1) : 0) * span + (Math.random() - 0.5) * 0.25, pos, normal, whistled: false, radius: P.radius, damage: P.damage });
    }
    g.audio.playFirst('radio', 'ui_click', { volume: 0.6 }, { volume: 0.4 });
    return true;
  }

  // ---------------------------------------------------------------- sentry
  sentryStart(ab) {
    const g = this.game, p = g.player, col = g.collision, T = g.terrain;
    if (p.vehicle || !p.alive) return this.refuse(ab);
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    for (const d of [1.7, 1.3, 2.2]) for (const o of [0, 0.5, -0.5]) {
      const x = p.pos.x + fx * d + rx * o, z = p.pos.z + fz * d + rz * o;
      if (col.waterDepth(x, z) > 0.2) continue;
      const y = col.floorAt(x, p.pos.y + 0.6, z, 1.6);
      if (Math.abs(y - p.pos.y) > 0.7) continue;
      if (col.resolveCapsule(_c.set(x, y + 0.1, z), 0.38, 1.1).lengthSq() > 1e-6) continue;
      const from = p.eye.clone().addScaledVector(p.forward(_a), 0.45); from.y -= 0.6;
      ab.sentry = new Sentry(this, new THREE.Vector3(x, y, z), p.yaw, ab.params, from);
      this.sentries.push(ab.sentry);
      return true;
    }
    return this.refuse(ab, 'No room to set the gun down');
  }

  // ---------------------------------------------------------------- jump pack
  jumpStart(ab) {
    const g = this.game, p = g.player, i = p.input, P = ab.params;
    if (!p.alive || p.vehicle || p.swimming || !p.onGround || p.rolling || p.prone > 0.5) return this.refuse(ab);
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    let wx = fx * i.fwd + rx * i.strafe, wz = fz * i.fwd + rz * i.strafe, l = Math.hypot(wx, wz);
    if (l < 0.2) { wx = fx; wz = fz; l = 1; }
    wx /= l; wz /= l;
    p.vel.set(wx * P.forward, P.up, wz * P.forward);
    p.onGround = false; p.pos.y += 0.06; p.boost = true; p.fallTop = p.pos.y; p.knockT = 0; p.fallPend = 0;
    p.fovKick += 7; p.shake = Math.min(1, p.shake + 0.22);
    this.jet = { t: 0, burn: 0.38, puff: 0 };
    this.stats.jump = { y0: p.pos.y, apex: p.pos.y, x0: p.pos.x, z0: p.pos.z, health: p.health, landed: false, dist: 0 };
    g.fx.slam(p.pos, 2.6);
    this.flash(_v.set(p.pos.x, p.pos.y + 0.6, p.pos.z), 120, 6);
    g.audio.playAt('explosion', p.pos, { volume: 0.35, rate: 1.9, ref: 6 });
    g.audio.playFirst('roll', 'step_grass', { volume: 0.6 }, { volume: 0.6 });
    return true;
  }

  _jet(dt) {
    const g = this.game, p = g.player, fx = g.fx, r = Math.random, j = this.jet, st = this.stats.jump;
    if (st && !st.landed) {
      st.apex = Math.max(st.apex, p.pos.y);
      if (p.onGround && j === null) { st.landed = true; st.dist = Math.hypot(p.pos.x - st.x0, p.pos.z - st.z0); st.healthAfter = p.health; }
    }
    if (!j) return;
    j.t += dt;
    if (j.t > j.burn) { this.jet = null; return; }
    const k = 1 - j.t / j.burn, bx = Math.sin(p.yaw) * 0.28, bz = Math.cos(p.yaw) * 0.28, rx = Math.cos(p.yaw) * 0.16, rz = -Math.sin(p.yaw) * 0.16;
    for (const s of [-1, 1]) {
      const x = p.pos.x + bx + rx * s, y = p.pos.y + 0.95, z = p.pos.z + bz + rz * s;
      for (let i = 0; i < 2; i++) fx.spawn({ x, y, z, vx: p.vel.x * 0.4 + (r() - 0.5), vy: -9 - r() * 4, vz: p.vel.z * 0.4 + (r() - 0.5), size: (0.12 + r() * 0.1) * (0.6 + k), grow: 0.6, life: 0.1 + r() * 0.05, drag: 2, r: 6, g: 2.8, b: 0.9, a: 1, add: true, fadeIn: 0.001 });
      fx.spawn({ x, y: y - 0.3, z, vx: (r() - 0.5) * 0.8, vy: -3 - r() * 2, vz: (r() - 0.5) * 0.8, size: 0.18, grow: 1.4, life: 0.7 + r() * 0.4, drag: 2.4, grav: -0.3, r: 0.55, g: 0.53, b: 0.5, a: 0.2 });
    }
    this.flash(_v.set(p.pos.x + bx, p.pos.y + 0.7, p.pos.z + bz), 140 * k, 4);
  }

  // ---------------------------------------------------------------- every frame (real dt; the world runs at the time scale)
  update(dt) {
    const g = this.game, wdt = dt * this.ts, p = g.player, cam = g.engine.camera;
    this.time += wdt;
    // adrenaline: in and out over a fifth of a second, the picture drains a little and closes in
    this.ts += (this.tsTarget - this.ts) * (1 - Math.exp(-5 * dt));
    if (this.tsTarget === 1 && this.ts > 0.998) this.ts = 1;
    g.timeScale = this.ts;
    const ak = clamp((1 - this.ts) / 0.6, 0, 1), post = g.engine.post && g.engine.post.settings;
    if (post) {
      if (ak > 0 && !this.post0) this.post0 = { saturation: post.saturation, vignette: post.vignette, contrast: post.contrast };
      if (this.post0) {
        post.saturation = this.post0.saturation * (1 - 0.42 * ak); post.vignette = this.post0.vignette + 0.42 * ak; post.contrast = this.post0.contrast * (1 + 0.06 * ak);
        if (ak === 0) { Object.assign(post, this.post0); this.post0 = null; }
      }
    }
    g.pulse = ak * 0.85;
    // the flash light
    this.lightI *= Math.exp(-this.lightK * wdt);
    if (this.lightI < 0.5) this.lightI = 0;
    this.light.intensity = this.lightI;
    // tanks, and the sound of the nearest one
    let near = null, nd = 1e9;
    for (let i = this.tanks.length - 1; i >= 0; i--) {
      const t = this.tanks[i];
      if (!t.update(wdt)) { if (p.vehicle === t) p.vehicle = null; t.dispose(); this.tanks.splice(i, 1); continue; }
      if (t.state === 'drop') continue;
      const d = p.vehicle === t ? 0 : cam.position.distanceTo(t.pos);
      if (d < nd) { nd = d; near = t; }
    }
    const A = g.audio;
    if (near) {
      const sp = Math.abs(near.v) / near.P.speed, att = 1 / (1 + Math.pow(nd / 16, 2)), tr = Math.min(1, (Math.abs(near.v) + Math.abs(near.w) * 1.4) / 3.5);
      if (!A.want.has('tank_engine')) { A.loop('tank_engine', 0.0001, 0.5); A.loop('tank_tracks', 0.0001, 0.5); }
      A.setLoopVolume('tank_engine', (0.45 + 0.4 * sp + Math.min(0.2, Math.abs(near.accel) * 0.05)) * att, 0.2);
      A.setLoopVolume('tank_tracks', 0.9 * tr * att, 0.15);
      const rate = (name, v) => { const h = A.loops.get(name); if (h && A.ctx) h.src.playbackRate.setTargetAtTime(v, A.ctx.currentTime, 0.25); };
      rate('tank_engine', 0.8 + 0.45 * sp); rate('tank_tracks', 0.75 + 0.45 * sp);
    } else if (A.want.has('tank_engine')) { A.stopLoop('tank_engine', 1); A.stopLoop('tank_tracks', 0.6); }
    // mortar: marker smoke, the whistle, the landings
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mk = this.marks[i];
      mk.t += wdt; mk.puff -= wdt;
      if (mk.t > mk.life) { this.marks.splice(i, 1); continue; }
      while (mk.puff < 0) { mk.puff += 0.06; const r = Math.random; g.fx.spawn({ x: mk.pos.x, y: mk.pos.y + 0.15, z: mk.pos.z, vx: (r() - 0.5) * 0.5, vy: 1.6 + r() * 0.9, vz: (r() - 0.5) * 0.5, size: 0.3, grow: 1.5, life: 2.6 + r(), drag: 0.9, grav: -0.2, r: 0.46, g: 0.3, b: 0.44, a: 0.4 }); }
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.t -= wdt;
      if (!s.whistled && s.t < 1.3) { s.whistled = true; if (this.time - this.lastWhistle > 0.35) { this.lastWhistle = this.time; g.audio.playAt('mortar_whistle', s.pos, { volume: 0.8, pitchVar: 0.06, ref: 25, height: 14 }); } }
      if (s.t <= 0) { this.shells.splice(i, 1); this.explode(s.pos, { radius: s.radius, damage: s.damage, normal: s.normal, player: 0.08 }); }
    }
    for (let i = this.sentries.length - 1; i >= 0; i--) if (!this.sentries[i].update(wdt)) { this.sentries[i].dispose(); this.sentries.splice(i, 1); }
    this._jet(wdt);
    for (const rg of this.rings) {
      if (rg.t >= rg.life) continue;
      rg.t += wdt;
      const u = Math.min(1, rg.t / rg.life), s = rg.R * 2.3 * (1 - Math.pow(1 - u, 3));
      rg.m.scale.set(s, 1, s); rg.m.material.opacity = 0.55 * Math.pow(1 - u, 1.5);
      if (u >= 1) rg.m.visible = false;
    }
    // climbing down: the view moves from the hatch to the player's eye
    if (this.camBlend) {
      const b = this.camBlend; b.t += dt;
      const k = smooth(b.t / 0.45);
      cam.position.lerpVectors(b.pos, cam.position, k); cam.quaternion.slerpQuaternions(b.quat, cam.quaternion, k);
      if (b.t >= 0.45) this.camBlend = null;
    }
  }

  // the run is over (death, extraction): no slow motion or engine noise behind the debrief
  settle() {
    const g = this.game;
    this.tsTarget = 1; this.ts = 1; g.timeScale = 1; g.pulse = 0;
    if (this.post0 && g.engine.post) { Object.assign(g.engine.post.settings, this.post0); this.post0 = null; }
    g.audio.stopLoop('tank_engine', 1); g.audio.stopLoop('tank_tracks', 0.6);
    this.jet = null; this.camBlend = null;
  }

  // nothing of a run stays in the world
  clear() {
    const g = this.game;
    this.settle();
    if (g.player.vehicle) g.player.vehicle = null;
    for (const t of this.tanks) t.dispose();
    for (const s of this.sentries) s.dispose();
    for (const m of this.litter) g.engine.scene.remove(m);
    this.litter.length = 0; this.tanks.length = 0; this.sentries.length = 0; this.shells.length = 0; this.marks.length = 0;
    this.lightI = 0; this.light.intensity = 0;
    for (const rg of this.rings) { rg.t = rg.life; rg.m.visible = false; }
    this.scorches.count = 0; this.scorchI = 0; this.treads.count = 0; this.treadI = 0;
  }
}
