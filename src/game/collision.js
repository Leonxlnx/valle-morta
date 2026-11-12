// Static world collision: a single BVH over every collider mesh the world
// modules registered, plus the terrain height field.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export const SURFACE = ['stone', 'wood', 'metal', 'dirt', 'grass', 'gravel', 'water', 'flesh'];

const _box = new THREE.Box3();
const _seg = new THREE.Line3();
const _triPoint = new THREE.Vector3();
const _capPoint = new THREE.Vector3();
const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _mask = {};

export class Collision {
  constructor(terrain, layout) {
    this.terrain = terrain;
    this.layout = layout;
    this.bvh = null;
    this.surf = null;
    this.q = {};
  }

  // colliders: THREE.Mesh[] (userData.surface = 'stone' | 'wood' | 'metal')
  build(colliders) {
    const chunks = [];
    const surf = [];
    let total = 0;
    for (const m of colliders) {
      if (!m || !m.geometry || !m.geometry.attributes.position) continue;
      m.updateMatrixWorld(true);
      let g = m.geometry;
      const pos = g.attributes.position;
      const idx = g.index;
      const n = idx ? idx.count : pos.count;
      const out = new Float32Array(n * 3);
      const s = Math.max(0, SURFACE.indexOf(m.userData.surface || 'stone'));
      for (let i = 0; i < n; i++) {
        const k = idx ? idx.getX(i) : i;
        _v.fromBufferAttribute(pos, k).applyMatrix4(m.matrixWorld);
        out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
      }
      chunks.push(out);
      for (let i = 0; i < n / 3; i++) surf.push(s);
      total += n * 3;
    }
    if (!total) { this.bvh = null; return; }
    const all = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
    this.geometry = geo;
    this.surf = new Uint8Array(surf);
    this.bvh = new MeshBVH(geo, { indirect: true, targetLeafSize: 12 });
    this.triangles = total / 9;
  }

  groundSurface(x, z) {
    const m = this.terrain.maskAt(x, z, _mask);
    const q = this.layout.river.query(x, z, this.q);
    const wl = this.layout.waterLevel(q.s);
    if (q.d < this.layout.riverHalfWidth(q.s) + 2 && this.terrain.heightAt(x, z) < wl - 0.05) return 'water';
    if (m.wet > 0.55) return 'water';
    if (m.cobble > 0.5 || m.rubble > 0.55) return 'stone';
    if (m.road > 0.5 || m.bed > 0.4) return 'gravel';
    if (m.mud > 0.5) return 'dirt';
    return 'grass';
  }

  // depth of river water above the bed at a position (<= 0 when dry)
  waterDepth(x, z) {
    const q = this.layout.river.query(x, z, this.q);
    if (q.d > this.layout.riverHalfWidth(q.s) + 6) return 0;
    return this.layout.waterLevel(q.s) - this.terrain.heightAt(x, z);
  }

  // Nearest hit along a ray. Returns null or { point, normal, distance, surface }.
  raycast(origin, dir, maxDist = 600, out = {}) {
    let best = maxDist, hit = false;
    out.point = out.point || new THREE.Vector3();
    out.normal = out.normal || new THREE.Vector3();
    if (this.bvh) {
      _ray.origin.copy(origin); _ray.direction.copy(dir);
      const h = this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxDist);
      if (h && h.distance < best) {
        best = h.distance; hit = true;
        out.point.copy(h.point);
        out.normal.copy(h.face.normal);
        if (out.normal.dot(dir) > 0) out.normal.negate();
        out.surface = SURFACE[this.surf[h.faceIndex]] || 'stone';
      }
    }
    // terrain: march, then bisect
    const T = this.terrain;
    let t = 0, prev = 0;
    const lim = Math.min(best, maxDist);
    let h0 = origin.y - T.heightAt(origin.x, origin.z);
    if (h0 > -0.2) {
      while (t < lim) {
        const step = Math.max(0.35, t * 0.03, Math.min(h0 * 0.5, 8));
        prev = t; t = Math.min(lim, t + step);
        const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
        const h = y - T.heightAt(x, z);
        if (h < 0) {
          let a = prev, b = t;
          for (let i = 0; i < 8; i++) {
            const m = (a + b) * 0.5;
            if (origin.y + dir.y * m - T.heightAt(origin.x + dir.x * m, origin.z + dir.z * m) < 0) b = m; else a = m;
          }
          const d = (a + b) * 0.5;
          if (d < best) {
            best = d; hit = true;
            out.point.copy(origin).addScaledVector(dir, d);
            T.normalAt(out.point.x, out.point.z, out.normal);
            out.surface = this.groundSurface(out.point.x, out.point.z);
          }
          break;
        }
        h0 = h;
        if (t >= lim) break;
      }
    }
    if (!hit) return null;
    // anything struck below the river surface is a hit on the water
    if (dir.y < -1e-4) {
      const wd = this.waterDepth(out.point.x, out.point.z);
      if (wd > 0.03) {
        const wl = T.heightAt(out.point.x, out.point.z) + wd;
        if (out.point.y < wl - 0.02 && origin.y > wl) {
          best = (wl - origin.y) / dir.y;
          out.point.copy(origin).addScaledVector(dir, best);
          out.normal.set(0, 1, 0);
          out.surface = 'water';
        }
      }
    }
    out.distance = best;
    return out;
  }

  // Pushes a vertical capsule (feet at pos) out of the static meshes.
  // Returns the correction vector (shared instance).
  resolveCapsule(pos, radius, height, out = _n) {
    out.set(0, 0, 0);
    if (!this.bvh) return out;
    _seg.start.set(pos.x, pos.y + radius, pos.z);
    _seg.end.set(pos.x, pos.y + Math.max(height - radius, radius + 0.01), pos.z);
    _box.makeEmpty();
    _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
    _box.min.addScalar(-radius); _box.max.addScalar(radius);
    let touched = false;
    this.bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        const d = tri.closestPointToSegment(_seg, _triPoint, _capPoint);
        if (d < radius) {
          touched = true;
          const depth = radius - d;
          const dir = _capPoint.sub(_triPoint);
          if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0); else dir.normalize();
          _seg.start.addScaledVector(dir, depth);
          _seg.end.addScaledVector(dir, depth);
        }
      },
    });
    // without a contact the result is exactly zero (no floating-point residue posing as a floor or ceiling)
    if (touched) out.set(_seg.start.x - pos.x, _seg.start.y - radius - pos.y, _seg.start.z - pos.z);
    return out;
  }

  // Height of the highest walkable surface below a point (terrain or mesh).
  floorAt(x, y, z, reach = 3) {
    let f = this.terrain.heightAt(x, z);
    if (this.bvh) {
      _ray.origin.set(x, y + 0.6, z); _ray.direction.set(0, -1, 0);
      const h = this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, reach + 0.6);
      if (h && h.point.y > f) f = h.point.y;
    }
    return f;
  }

  // true if the straight segment between two points is unobstructed by meshes
  lineOfSight(a, b) {
    if (!this.bvh) return true;
    _v.subVectors(b, a);
    const d = _v.length();
    if (d < 1e-4) return true;
    _ray.origin.copy(a); _ray.direction.copy(_v).multiplyScalar(1 / d);
    return !this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, d);
  }
}
