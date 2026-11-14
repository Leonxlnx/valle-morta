// Page side of tools/audit.mjs (evaluated in the game page; defines runAudit).
async function runAudit(opt) {
  const vm = window.__vm, T = vm.THREE, scene = vm.engine.scene, H = (x, z) => vm.terrain.heightAt(x, z);
  const col = vm.game.collision, BVH = col.bvh.constructor;
  const r2 = (v) => Math.round(v * 100) / 100;
  const L = vm.layout;
  const near = (x, z) => { let best = '', bd = 1e9; for (const b of L.buildings) { const d = Math.hypot(b.x - x, b.z - z) - Math.max(b.w, b.d) / 2; if (d < bd) { bd = d; best = b.id; } } return bd < 4 ? best : ''; };
  const classes = { floating: [], hanging: [], buried: [], instFloat: [], instBuried: [], noCollider: [], invisibleCol: [], cull: [], zfight: [] };
  const notes = [];
  const isStatic = (o) => o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && /^(bld:|bldx:|props-)/.test(o.name) && !/tufts/.test(o.name) && o.geometry.index;
  scene.updateMatrixWorld(true);

  // ---- merge a list of meshes into one world-space geometry; per-triangle source name
  function merge(meshes) {
    let nv = 0, ni = 0;
    for (const m of meshes) { nv += m.geometry.attributes.position.count; ni += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count; }
    const P = new Float32Array(nv * 3), I = new Uint32Array(ni), srcV = new Uint16Array(nv), names = [];
    let vo = 0, io = 0; const v = new T.Vector3();
    meshes.forEach((m, mi) => {
      names.push(m.name);
      const pa = m.geometry.attributes.position, idx = m.geometry.index;
      for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(m.matrixWorld); P[(vo + i) * 3] = v.x; P[(vo + i) * 3 + 1] = v.y; P[(vo + i) * 3 + 2] = v.z; }
      const n = idx ? idx.count : pa.count;
      for (let k = 0; k < n; k++) I[io + k] = vo + (idx ? idx.getX(k) : k);
      srcV.fill(mi, vo, vo + pa.count);
      vo += pa.count; io += n;
    });
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(P, 3)); g.setIndex(new T.BufferAttribute(I, 1));
    return { g, srcV, names, nm: (t) => names[srcV[g.index.array[t * 3]]] };
  }
  // ---- connected parts: union-find over welded (4 mm) vertices; call after the BVH reordered the index
  function parts(g) {
    const P = g.attributes.position.array, I = g.index.array, nv = P.length / 3;
    const weld = new Int32Array(nv), map = new Map();
    for (let i = 0; i < nv; i++) {
      const k = ((Math.round(P[i * 3] * 250) + 65536) * 131072 + (Math.round(P[i * 3 + 1] * 250) + 65536)) * 131072 + (Math.round(P[i * 3 + 2] * 250) + 65536);
      let w = map.get(k); if (w === undefined) { w = i; map.set(k, i); } weld[i] = w;
    }
    const par = new Int32Array(nv); for (let i = 0; i < nv; i++) par[i] = i;
    const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    for (let t = 0; t < I.length; t += 3) { const a = find(weld[I[t]]), b = find(weld[I[t + 1]]), c = find(weld[I[t + 2]]); par[b] = a; par[find(c)] = a; }
    const triComp = new Int32Array(I.length / 3), id = new Map(), comps = [];
    for (let t = 0; t < I.length / 3; t++) {
      const r = find(weld[I[t * 3]]); let c = id.get(r);
      if (c === undefined) { c = comps.length; id.set(r, c); comps.push({ tris: [], box: new T.Box3() }); }
      triComp[t] = c; comps[c].tris.push(t);
      for (let k = 0; k < 3; k++) { const q = I[t * 3 + k]; comps[c].box.expandByPoint(new T.Vector3(P[q * 3], P[q * 3 + 1], P[q * 3 + 2])); }
    }
    return { triComp, comps };
  }
  const touchesOther = (bvh, triComp, c, box) => {
    let hit = false;
    bvh.shapecast({ intersectsBounds: (b) => b.intersectsBox(box), intersectsTriangle: (tri, i) => { if (triComp[i] !== c && tri.intersectsBox(box)) { hit = true; return true; } return false; } });
    return hit;
  };
  const anyIn = (bvh, box) => { let hit = false; bvh.shapecast({ intersectsBounds: (b) => b.intersectsBox(box), intersectsTriangle: (tri) => { if (tri.intersectsBox(box)) { hit = true; return true; } return false; } }); return hit; };

  // ---- render geometry
  const statics = []; scene.traverse((o) => { if (isStatic(o) && (o.visible !== false || o.parent?.isLOD)) statics.push(o); });
  const R = merge(statics);
  const rbvh = new BVH(R.g, { maxLeafTris: 8 });
  const { triComp, comps } = parts(R.g);
  const P = R.g.attributes.position.array, I = R.g.index.array;
  const bs = vm.world.mods.buildings?.stats?.cat; if (bs?.pruned) notes.push(`pruned at build: ${bs.pruned} parts (${bs.prunedAt.join(' ')})`);
  notes.push(`render: ${statics.length} meshes, ${I.length / 3} tris, ${comps.length} parts`);
  const ray = new T.Ray(), down = new T.Vector3(0, -1, 0);
  const firstOtherBelow = (x, y, z, c, far) => { ray.origin.set(x, y, z); ray.direction.copy(down); const hs = rbvh.raycast(ray, T.DoubleSide, 0, far); let best = Infinity; for (const h of hs) if (triComp[h.faceIndex] !== c && h.distance < best) best = h.distance; return best; };
  const cb = new T.Box3(), ctr = new T.Vector3(), sz = new T.Vector3(), a = new T.Vector3(), b = new T.Vector3(), cc = new T.Vector3(), nrm = new T.Vector3();
  const nameOf = (c) => R.nm(comps[c].tris[0]);

  if (opt.only.includes('float') || opt.only.includes('col')) comps.forEach((C, c) => {
    if (/tank/.test(nameOf(c))) return; // owned by another agent; kept only as visible geometry for the collider check
    const box = C.box; box.getCenter(ctr); box.getSize(sz);
    const at = [r2(ctr.x), r2(box.min.y), r2(ctr.z)], tag = `${nameOf(c)}${near(ctr.x, ctr.z) ? '/' + near(ctr.x, ctr.z) : ''}`;
    // bottom vertices, terrain gaps
    const bot = new Map(); let downArea = 0, maxTop = -1e9;
    for (const t of C.tris) {
      let low = 0;
      for (let k = 0; k < 3; k++) { const q = I[t * 3 + k]; const y = P[q * 3 + 1]; if (y < box.min.y + 0.03) { low++; bot.set(q, 1); } }
      if (low === 3) { a.set(P[I[t * 3] * 3], P[I[t * 3] * 3 + 1], P[I[t * 3] * 3 + 2]); b.set(P[I[t * 3 + 1] * 3], P[I[t * 3 + 1] * 3 + 1], P[I[t * 3 + 1] * 3 + 2]); cc.set(P[I[t * 3 + 2] * 3], P[I[t * 3 + 2] * 3 + 1], P[I[t * 3 + 2] * 3 + 2]); nrm.subVectors(b, a).cross(cc.clone().sub(a)); downArea += nrm.length() / 2; }
    }
    let minGap = 1e9, maxGap = -1e9, gapAt = null;
    const bv = [...bot.keys()];
    for (const q of bv) { const g = P[q * 3 + 1] - H(P[q * 3], P[q * 3 + 2]); if (g < minGap) minGap = g; if (g > maxGap) { maxGap = g; gapAt = q; } }
    const stepV = Math.max(1, Math.floor(C.tris.length * 3 / 40));
    for (let k = 0; k < C.tris.length * 3; k += stepV) { const q = I[C.tris[Math.floor(k / 3)] * 3 + (k % 3)]; maxTop = Math.max(maxTop, P[q * 3 + 1] - H(P[q * 3], P[q * 3 + 2])); }
    if (opt.only.includes('float')) {
      if (maxTop < -0.03) classes.buried.push({ what: tag, at, d: r2(maxTop) });
      else if (minGap > 0.06) {
        cb.copy(box).expandByScalar(0.045);
        if (!touchesOther(rbvh, triComp, c, cb)) classes.floating.push({ what: tag, at, d: r2(minGap), size: [r2(sz.x), r2(sz.y), r2(sz.z)] });
      }
      // flat underside near the ground with a corner in the air
      if (downArea > 0.08 && minGap < 0.06) {
        let worst = 0, wq = -1;
        for (const q of bv) {
          const x = P[q * 3], y = P[q * 3 + 1], z = P[q * 3 + 2], g = y - H(x, z);
          if (g < 0.12) continue;
          const d = firstOtherBelow(x, y + 0.02, z, c, g + 0.05);
          const gap = Math.min(g, d - 0.02);
          if (gap > worst) { worst = gap; wq = q; }
        }
        if (worst > 0.12) classes.hanging.push({ what: tag, at: [r2(P[wq * 3]), r2(P[wq * 3 + 1]), r2(P[wq * 3 + 2])], d: r2(worst) });
      }
    }
    if (opt.only.includes('col')) {
      const hc = H(ctr.x, ctr.z);
      const solid = sz.y > 0.45 && Math.max(sz.x, sz.z) > 0.35 && box.min.y < hc + 1.4 && box.max.y > hc + 0.5 && C.tris.length >= 10;
      if (solid) { cb.copy(box).expandByScalar(0.08); if (!anyIn(col.bvh, cb)) classes.noCollider.push({ what: tag, at, size: [r2(sz.x), r2(sz.y), r2(sz.z)] }); }
    }
  });

  // ---- colliders with nothing visible
  if (opt.only.includes('col')) {
    const cm = vm.world.colliders.filter((m) => m.geometry && m.geometry.index);
    const C2 = merge(cm); const cbvh = new BVH(C2.g); const pc = parts(C2.g);
    pc.comps.forEach((C, c) => {
      C.box.getCenter(ctr); C.box.getSize(sz);
      cb.copy(C.box).expandByScalar(0.12);
      if (!anyIn(rbvh, cb)) {
        // instanced debris / terrain may be the visible part: skip if the box is below ground + 0.3
        if (C.box.max.y < H(ctr.x, ctr.z) + 0.3) return;
        classes.invisibleCol.push({ what: C2.nm(C.tris[0]) + (near(ctr.x, ctr.z) ? '/' + near(ctr.x, ctr.z) : ''), at: [r2(ctr.x), r2(C.box.min.y), r2(ctr.z)], size: [r2(sz.x), r2(sz.y), r2(sz.z)] });
      }
    });
    notes.push(`colliders: ${cm.length} meshes, ${pc.comps.length} parts`);
  }

  // ---- instanced pieces (debris stones, roof tiles, rocks, trees near the camera)
  if (opt.only.includes('float')) {
    const m4 = new T.Matrix4(), corners = [];
    scene.traverse((o) => {
      if (!o.isInstancedMesh || !o.count || /grass|impostor|tank/.test(o.name) || !o.visible) return;
      const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox; let nf = 0, nb = 0;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld);
        let miny = 1e9, maxy = -1e9; ctr.set(0, 0, 0);
        for (let k = 0; k < 8; k++) { a.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z).applyMatrix4(m4); miny = Math.min(miny, a.y); maxy = Math.max(maxy, a.y); ctr.add(a); }
        ctr.multiplyScalar(1 / 8);
        const isTree = /tree|wood/.test(o.name);
        const ref = isTree ? new T.Vector3(0, 0, 0).applyMatrix4(m4) : ctr;
        const base = isTree ? ref.y : miny;
        let sup = H(ref.x, ref.z);
        ray.origin.set(ref.x, base + 0.4, ref.z); ray.direction.copy(down);
        const h = rbvh.raycastFirst(ray, T.DoubleSide, 0, 2.0); if (h) sup = Math.max(sup, h.point.y);
        if (base - sup > (isTree ? 0.1 : 0.08)) { nf++; if (classes.instFloat.length < 400) classes.instFloat.push({ what: o.name, at: [r2(ref.x), r2(base), r2(ref.z)], d: r2(base - sup) }); }
        else if (!isTree && maxy < sup - 0.02) { nb++; if (classes.instBuried.length < 400) classes.instBuried.push({ what: o.name, at: [r2(ref.x), r2(maxy), r2(ref.z)], d: r2(maxy - sup) }); }
      }
      notes.push(`inst ${o.name}: ${o.count}, floating ${nf}, buried ${nb}`);
    });
  }

  // ---- coplanar overlaps (z-fighting) between different parts or within one part
  if (opt.only.includes('zf')) {
    const tA = new T.Triangle(), tB = new T.Triangle(), nA = new T.Vector3(), nB = new T.Vector3(), ce = new T.Vector3(), bar = new T.Vector3(), tb = new T.Box3();
    const cells = new Map();
    const get = (t, tri) => { tri.a.fromArray(P, I[t * 3] * 3); tri.b.fromArray(P, I[t * 3 + 1] * 3); tri.c.fromArray(P, I[t * 3 + 2] * 3); return tri; };
    const inside = (tri, p) => { tri.getBarycoord(p, bar); return bar.x > 0.03 && bar.y > 0.03 && bar.z > 0.03; };
    for (let t = 0; t < I.length / 3; t++) {
      get(t, tA); if (tA.getArea() < 0.02) continue;
      tA.getNormal(nA); tA.getMidpoint(ce);
      tb.setFromPoints([tA.a, tA.b, tA.c]).expandByScalar(0.003);
      let found = -1;
      rbvh.shapecast({ intersectsBounds: (bx) => bx.intersectsBox(tb), intersectsTriangle: (tri, j) => {
        if (j <= t) return false;
        tri.getNormal(nB); if (nB.dot(nA) < 0.999) return false;
        if (Math.abs(nA.dot(tri.a) - nA.dot(tA.a)) > 0.003) return false;
        tB.copy(tri); const cB = tB.getMidpoint(new T.Vector3());
        if (inside(tB, ce) || inside(tA, cB)) { found = j; return true; }
        return false;
      } });
      if (found >= 0) {
        const key = `${Math.round(ce.x)},${Math.round(ce.y)},${Math.round(ce.z)}`;
        const e = cells.get(key) || { what: `${R.nm(t)}${near(ce.x, ce.z) ? '/' + near(ce.x, ce.z) : ''}${triComp[t] === triComp[found] ? ' same-part' : ''}`, at: [r2(ce.x), r2(ce.y), r2(ce.z)], d: 0 };
        if (!e.d) {   // diagnostics: normal and the sizes of both triangles (cm) to tell the pieces apart
          const sz = (tri) => { tb.setFromPoints([tri.a, tri.b, tri.c]); const s = tb.getSize(new T.Vector3()); return [Math.round(s.x * 100), Math.round(s.y * 100), Math.round(s.z * 100)]; };
          e.n = [r2(nA.x), r2(nA.y), r2(nA.z)]; e.s1 = sz(tA); e.s2 = sz(get(found, tB)); e.n2 = R.nm(found);
        }
        e.d++; cells.set(key, e);
      }
    }
    classes.zfight = [...cells.values()].sort((p, q) => q.d - p.d);
  }

  // ---- river: visible water surface vs terrain vs collision.waterDepth (wading)
  if (opt.only.includes('water')) {
    classes.waterDry = []; classes.waterGhost = [];
    const wm = []; scene.traverse((o) => { if (o.isMesh && o.name === 'river-water') wm.push(o); });
    const wr = new T.Raycaster(); wr.ray.direction.set(0, -1, 0);
    const q = {}, cells = new Map(), probe = [];
    const spots = [[44.5, 58.9], [42.9, 59.0], [67.7, 82.0], [68.8, 56.4], [92.4, 84.0], [-25.9, 74.8], [-18.9, 71.8]];
    let n = 0;
    const check = (x, z, rep) => {
      wr.ray.origin.set(x, 200, z); wr.far = 400;
      const h = wr.intersectObjects(wm, false)[0];
      const g = H(x, z), wd = col.waterDepth(x, z), rq = L.river.query(x, z, q), hw = L.riverHalfWidth(rq.s);
      if (rep) probe.push(`(${x},${z}) surf ${h ? r2(h.point.y) : '-'} ground ${r2(g)} wl(s) ${r2(L.waterLevel(rq.s))} depth ${r2(wd)} d ${r2(rq.d)} hw+6 ${r2(hw + 6)}`);
      n++;
      if (h && h.point.y > g + 0.04 && wd <= 0.0) {
        const key = `${Math.round(x / 4)},${Math.round(z / 4)}`;
        if (!cells.has(key)) cells.set(key, { what: `surf-ground ${r2(h.point.y - g)} d/hw ${r2(rq.d)}/${r2(hw)}`, at: [r2(x), r2(g), r2(z)], d: r2(wd) });
      }
      if (!h && wd > 0.1 && Math.abs(x) < 480 && Math.abs(z) < 480) classes.waterGhost.push({ what: 'depth without water', at: [r2(x), r2(g), r2(z)], d: r2(wd) });
    };
    for (const [x, z] of spots) check(x, z, true);
    for (let x = -480; x <= 480; x += 2) for (let z = -480; z <= 480; z += 2) { const rq = L.river.query(x, z, q); if (rq.d < L.riverHalfWidth(rq.s) + 14) check(x, z, false); }
    classes.waterDry = [...cells.values()];
    classes.waterGhost = classes.waterGhost.slice(0, 200);
    notes.push(`water: ${n} samples`, ...probe);
  }

  // ---- culling: 360 degrees at a dozen spots, chunk culling on vs off
  if (opt.only.includes('cull')) {
    vm.stop();
    const gl = vm.engine.gl, cv = gl.canvas, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const cullables = []; scene.traverse((o) => { if (o.isMesh && /^(bld:|props-)/.test(o.name)) cullables.push(o); });
    const snap = (on) => { for (const m of cullables) m.frustumCulled = on; for (let i = 0; i < 4; i++) vm.step(0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    const spots = [];
    for (const bd of L.buildings.filter((q) => q.enterable)) spots.push([bd.x, bd.z, bd.id + '-in']);
    const ch = L.buildings.find((q) => q.kind === 'church'); if (ch) spots.push([ch.x + 14, ch.z + 6, 'church']);
    for (const v of ['street', 'square', 'bridge', 'meadow']) if (vm.VIEWS[v]) spots.push([vm.VIEWS[v].pos[0], vm.VIEWS[v].pos[2], v]);
    for (const [x, z, label] of spots) for (let k = 0; k < 8; k++) {
      const ang = k * Math.PI / 4;
      vm.cam(x, 1.7, z, x + Math.sin(ang) * 10, H(x, z) + 1.6, z + Math.cos(ang) * 10, true);
      const A = snap(true), B = snap(false), A2 = snap(true);
      let diff = 0;
      for (let i = 0; i < A.length; i += 4) {
        const dAB = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
        const dAA = Math.abs(A[i] - A2[i]) + Math.abs(A[i + 1] - A2[i + 1]) + Math.abs(A[i + 2] - A2[i + 2]);
        if (dAB > 30 && dAA < 10) diff++;
      }
      if (k === 0 && label === spots[0][2]) { let sum = 0; for (let i = 0; i < A.length; i += 4) sum += A[i]; notes.push(`cull readback mean red ${(sum / (A.length / 4)).toFixed(1)}`); }
      if (diff > 20) classes.cull.push({ what: `${label} yaw${k * 45}`, at: [r2(x), r2(H(x, z) + 1.7), r2(z)], d: diff });
    }
    for (const m of cullables) m.frustumCulled = true;
    notes.push(`cull: ${spots.length} spots x 8 headings at ${w}x${h}`);
    vm.start();
  }
  return { classes, notes };
}
