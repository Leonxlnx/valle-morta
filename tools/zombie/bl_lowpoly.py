"""Game mesh: decimate the marching-cubes mesh (denser on head / hands), re-project onto the field,
UV unwrap with extra texel density on head / hands.   blender -b -t 6 --python bl_lowpoly.py
Outputs build/low.blend and build/low.npz
"""
import bpy, bmesh, sys, os, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
BUILD = os.path.join(HERE, 'build')
import model

TARGET = 14800
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
d = np.load(os.path.join(BUILD, 'hi.npz'))
V, Fc = d['verts'], d['faces']
me = bpy.data.meshes.new('Zombie')
me.from_pydata(V.tolist(), [], Fc.tolist()); me.update()
ob = bpy.data.objects.new('Zombie', me); bpy.context.scene.collection.objects.link(ob)
bpy.context.view_layer.objects.active = ob; ob.select_set(True)


def region_weight(P):
    """1 = keep dense (head, hands), 0 = body."""
    z = P[:, 2]; ax = np.abs(P[:, 0])
    head = np.clip((z - 1.50) / 0.04, 0, 1)
    face = head * np.clip((-P[:, 1] - 0.02) / 0.04, 0.35, 1.0)
    hand = np.clip((ax - 0.545) / 0.03, 0, 1)
    return np.maximum(face, hand * 0.8)


def decimate(factor):
    m2 = me.copy(); o2 = bpy.data.objects.new('tmp', m2); bpy.context.scene.collection.objects.link(o2)
    vg = o2.vertex_groups.new(name='dense')
    w = region_weight(V) * 0.9          # never 1: an inverted weight of 0 freezes the vertex
    for val in np.unique(np.round(w, 2)):
        idx = np.nonzero(np.round(w, 2) == val)[0]
        if val > 0:
            vg.add(idx.tolist(), float(val), 'REPLACE')
    mod = o2.modifiers.new('dec', 'DECIMATE')
    mod.ratio = TARGET / len(Fc); mod.use_collapse_triangulate = True
    mod.vertex_group = 'dense'; mod.invert_vertex_group = True; mod.vertex_group_factor = factor
    dg = bpy.context.evaluated_depsgraph_get()
    res = bpy.data.meshes.new_from_object(o2.evaluated_get(dg))
    bpy.data.objects.remove(o2); bpy.data.meshes.remove(m2)
    n = len(res.vertices); co = np.empty(n * 3, np.float32); res.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    share = float((region_weight(co) > 0.3).mean())
    return res, share


# the modifier's vertex-group factor is a strong lever: search for ~40 % of the vertices on head + hands
best = None
for fac in (3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 0.1):
    r_, sh_ = decimate(fac)
    print('decimate factor %.5f: tris %d dense share %.2f' % (fac, len(r_.polygons), sh_))
    if best is None or abs(sh_ - 0.40) < abs(best[1] - 0.40):
        best = (r_, sh_, fac)
res, share, fac = best
print('decimate chosen factor %.2f share %.2f' % (fac, share))
ob.data = res; me = res

# clean up + triangulate
bm = bmesh.new(); bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-5)
bmesh.ops.triangulate(bm, faces=bm.faces)
loose = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose, context='VERTS')
bm.to_mesh(me); bm.free(); me.update()

# re-project vertices onto the field (two damped Newton steps, <= 3 mm)
n = len(me.vertices); co = np.empty(n * 3, np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
order = np.lexsort((co[:, 1] // 0.08, co[:, 0] // 0.08, co[:, 2] // 0.08))
P = co[order].copy()
e = 0.0015
K = np.array([[1, -1, -1], [-1, -1, 1], [-1, 1, -1], [1, 1, 1]], np.float32)
for it in range(2):
    g = np.zeros_like(P); dsum = np.zeros(len(P), np.float32)
    for k in K:
        dk, _ = model.eval_chunked(P + e * k, margin=0.01, want_mat=False)
        g += dk[:, None] * k; dsum += dk
    d0 = dsum / 4.0
    gn = np.linalg.norm(g, axis=1, keepdims=True); g = g / np.maximum(gn, 1e-9)
    P -= g * np.clip(d0, -0.003, 0.003)[:, None] * 0.9
co2 = np.empty_like(co); co2[order] = P
me.vertices.foreach_set('co', co2.ravel()); me.update()
me.shade_smooth()
print('game mesh: %d verts %d tris' % (len(me.vertices), len(me.polygons)))

# ---------------------------------------------------------------- UVs
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=np.radians(80), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.uv.average_islands_scale()
bpy.ops.object.mode_set(mode='OBJECT')

nl = len(me.loops)
uv = np.empty(nl * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
lv = np.empty(nl, np.int32); me.loops.foreach_get('vertex_index', lv)
co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
# islands by union-find over (vertex, uv) corners
key = lv.astype(np.int64) * 1000003 + np.round(uv[:, 0] * 20000).astype(np.int64) * 40009 + np.round(uv[:, 1] * 20000).astype(np.int64)
_, cid = np.unique(key, return_inverse=True)
parent = np.arange(cid.max() + 1)


def find(a):
    while parent[a] != a:
        parent[a] = parent[parent[a]]; a = parent[a]
    return a


tri = cid.reshape(-1, 3)
for a, b, c in tri:
    ra, rb, rc = find(a), find(b), find(c)
    parent[rb] = ra; parent[find(c)] = ra
root = np.array([find(a) for a in tri[:, 0]])
w = region_weight(co)[lv].reshape(-1, 3).mean(1)
isl, inv = np.unique(root, return_inverse=True)
for i in range(len(isl)):
    f = np.nonzero(inv == i)[0]
    li = (f[:, None] * 3 + np.arange(3)).ravel()
    s = 1.0 + 0.95 * float(w[f].mean())                 # up to ~1.95x linear texel density
    c = uv[li].mean(0)
    uv[li] = c + (uv[li] - c) * s
me.uv_layers.active.data.foreach_set('uv', uv.ravel())
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.select_all(action='SELECT')
bpy.ops.uv.pack_islands(rotate=True, margin=0.0022)
bpy.ops.object.mode_set(mode='OBJECT')
print('uv islands:', len(isl))

# ---------------------------------------------------------------- export arrays (per corner)
me.calc_tangents(uvmap=me.uv_layers.active.name)
uv = np.empty(nl * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv)
tan = np.empty(nl * 3, np.float32); me.loops.foreach_get('tangent', tan)
sgn = np.empty(nl, np.float32); me.loops.foreach_get('bitangent_sign', sgn)
nrm = np.empty(nl * 3, np.float32); me.corner_normals.foreach_get('vector', nrm)
np.savez(os.path.join(BUILD, 'low.npz'), pos=co, lv=lv.reshape(-1, 3), uv=uv.reshape(-1, 3, 2), nrm=nrm.reshape(-1, 3, 3),
         tan=tan.reshape(-1, 3, 3), sign=sgn.reshape(-1, 3))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, 'low.blend'))
print('LOWPOLY_DONE %.1fs' % (time.time() - t0))
