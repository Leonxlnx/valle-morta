// Splits the big merged static meshes (village chunks, props) into square world-space cells, so
// that the main view and the shadow pass can frustum-cull them. A merged mesh that spans the whole
// valley is otherwise drawn in full every frame, in both passes, whatever the camera looks at.
// Each triangle goes to the cell of its centroid; materials, shadow flags, render order, layers and
// custom depth materials are kept. Colliders are separate meshes and are not touched.
import * as THREE from 'three';

const _v = new THREE.Vector3();

function splittable(m) {
  if (!m.isMesh || m.isInstancedMesh || m.isSkinnedMesh || Array.isArray(m.material)) return false;
  const g = m.geometry;
  if (!g || !g.index || g.isInstancedBufferGeometry || g.groups.length > 1 || Object.keys(g.morphAttributes).length) return false;
  for (const a of Object.values(g.attributes)) if (a.isInterleavedBufferAttribute) return false;
  return true;
}

function splitMesh(mesh, cell, minTris) {
  const g = mesh.geometry, idx = g.index.array, pos = g.attributes.position;
  mesh.updateMatrixWorld(true);
  const mw = mesh.matrixWorld;
  const buckets = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    _v.set((pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3).applyMatrix4(mw);
    const key = Math.floor(_v.x / cell) * 4096 + Math.floor(_v.z / cell);
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(a, b, c);
  }
  if (buckets.size < 2) return null;
  // tiny cells are merged into one remainder chunk: not worth a draw call of their own
  const lists = [];
  let rest = [];
  for (const arr of buckets.values()) if (arr.length / 3 < minTris) rest = rest.concat(arr); else lists.push(arr);
  if (rest.length) lists.push(rest);
  if (lists.length < 2) return null;
  const remap = new Int32Array(pos.count).fill(-1);
  const out = [];
  for (const tri of lists) {
    const verts = [];
    const nidx = new (pos.count > 65535 ? Uint32Array : Uint16Array)(tri.length);
    for (let i = 0; i < tri.length; i++) {
      const v = tri[i];
      if (remap[v] < 0) { remap[v] = verts.length; verts.push(v); }
      nidx[i] = remap[v];
    }
    const ng = new THREE.BufferGeometry();
    for (const [name, A] of Object.entries(g.attributes)) {
      const n = A.itemSize, arr = new A.array.constructor(verts.length * n);
      for (let i = 0; i < verts.length; i++) for (let k = 0; k < n; k++) arr[i * n + k] = A.array[verts[i] * n + k];
      ng.setAttribute(name, new THREE.BufferAttribute(arr, n, A.normalized));
    }
    ng.setIndex(new THREE.BufferAttribute(verts.length > 65535 ? Uint32Array.from(nidx) : nidx, 1));
    ng.computeBoundingBox(); ng.computeBoundingSphere();
    for (const v of verts) remap[v] = -1;
    const m = new THREE.Mesh(ng, mesh.material);
    m.name = mesh.name; m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow;
    m.renderOrder = mesh.renderOrder; m.layers.mask = mesh.layers.mask; m.visible = mesh.visible;
    m.userData = { ...mesh.userData, chunkOf: mesh.name };
    m.customDepthMaterial = mesh.customDepthMaterial; m.customDistanceMaterial = mesh.customDistanceMaterial;
    m.onBeforeRender = mesh.onBeforeRender; m.onAfterRender = mesh.onAfterRender;
    m.matrixAutoUpdate = false; m.matrix.copy(mesh.matrix); m.matrixWorld.copy(mesh.matrixWorld);
    m.frustumCulled = true;
    out.push(m);
  }
  return out;
}

// Splits every merged mesh accepted by `filter` that is larger than one cell. Returns stats.
export function splitStatic(root, filter, cell = 48, minTris = 1500) {
  const todo = [];
  root.traverse((o) => {
    if (!splittable(o) || !filter(o)) return;
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (g.boundingSphere.radius > cell * 0.75) todo.push(o);
  });
  let made = 0;
  for (const mesh of todo) {
    const parts = splitMesh(mesh, cell, minTris);
    if (!parts) continue;
    const parent = mesh.parent;
    parent.remove(mesh);
    for (const p of parts) parent.add(p);
    mesh.geometry.dispose();
    made += parts.length;
  }
  return { split: todo.length, chunks: made };
}
