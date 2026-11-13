# Valle Morta - shared first-person arms rig: glove + sleeve geometry, armature, skin weights and the posing library
# (analytic two-bone IK, finger poses, contact-driven grips, reach solver). Everything in metres at the API level.
import bpy, bmesh, math, numpy as np
from math import radians, degrees, sin, cos, pi
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree
import geo, rigdef as RD
from rigdef import FN, MM
from geo import V, lerp

GLOVE, SLEEVE, HEM = 21, 9, 13
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
PALM = [(-50, 30.5, 21.0, 0, 0, 0), (-30, 30.5, 21.0, 0, 0, 0), (-10, 30.0, 20.0, 0, 0, 0), (4, 31.0, 19.0, 0, 0, 0), (20, 34.5, 18.0, -.5, -.5, 0),
        (38, 38.5, 17.0, -1, -1, 0), (56, 41.5, 15.8, -.5, -1, 0), (72, 43.0, 14.5, 0, -.5, -3), (84, 42.5, 13.3, .5, 0, -7), (91, 40.5, 12.2, .5, .5, -10)]
# finger angle sets in degrees: Thumb = [palmar elevation, swing towards the index, pronation, curl2, curl3], fingers = [curl1, curl2, curl3, spread]
A_OPEN = dict(Thumb=[14, 0, 0, 5, 5], Index=[3, 6, 4, 0], Middle=[3, 6, 4, 0], Ring=[4, 7, 4, 0], Pinky=[5, 8, 5, 0])
A_RELAX = dict(Thumb=[26, 8, -15, 14, 16], Index=[18, 28, 16, 0], Middle=[22, 34, 18, 0], Ring=[26, 38, 20, 0], Pinky=[30, 40, 22, 0])
A_SPREAD = dict(Thumb=[32, -14, -20, 8, 8], Index=[8, 16, 9, 4], Middle=[9, 17, 9, 0], Ring=[10, 18, 10, -3], Pinky=[12, 20, 10, -7])
A_HOOKED = dict(Thumb=[17, 0, 0, 5, 5], Index=[0, 50, 28, 0], Middle=[0, 50, 28, 0], Ring=[0, 50, 28, 0], Pinky=[0, 50, 28, 0])
A_FIST = dict(Thumb=[50, 30, -60, 35, 55], Index=[80, 100, 60, 0], Middle=[84, 102, 62, 0], Ring=[86, 104, 62, 0], Pinky=[88, 104, 60, 0])


def ablend(a, b, t): return {k: [lerp(x, y, t) for x, y in zip(a[k], b[k])] for k in a}
def qx(deg): return Quaternion((1, 0, 0), radians(deg))


def pblend(p, q, t):
    """normalised lerp between two pose arrays (15,4)"""
    s = np.where((p * q).sum(1, keepdims=True) < 0, -1.0, 1.0); r = p * (1 - t) + q * s * t
    return r / np.linalg.norm(r, axis=1, keepdims=True)


def frame(y, z):
    """3x3 hand rotation from the finger direction y and the (approximate) dorsal direction z"""
    y = Vector(y).normalized(); z = Vector(z); z = (z - y * z.dot(y)).normalized(); x = y.cross(z)
    return Matrix((x, y, z)).transposed()


def set_pid(me, pid, tag=0, g=0.5):
    ca = me.color_attributes.get('pid') or me.color_attributes.new('pid', 'FLOAT_COLOR', 'CORNER')
    ca.data.foreach_set('color', np.tile(np.array([pid / 32.0, g, tag / 32.0, 1.0], np.float32), len(me.loops)))


# ------------------------------------------------------------------ geometry
def build_glove(tris=7000, voxel=0.0011):
    OX = RD.OFFX; O = Vector((OX, 0, 0)); b = geo.B(GLOVE)
    geo.sweep(b, [(V(OX + cx, y, cz), V(cos(radians(tl)), sin(radians(tl)), 0), Z, hw, hh) for y, hw, hh, cx, cz, tl in PALM], 30, 2.7, True, True)
    for name in FN:
        J, R, D, BK = RD.chain(name); cum = RD.cumlen(J); end = cum[3] - R[3] * 0.8
        ts = [float(t) for t in np.arange(-2.0 if name == 'Thumb' else -5.0, end - 1.5, 4.5)] + [end]; st = []
        for t in ts:
            k = 0 if t < cum[1] else (1 if t < cum[2] else 2)
            r = float(np.interp(t, cum, R)) * (1 + 0.05 * math.exp(-((t - cum[1]) / 5.0) ** 2) + 0.045 * math.exp(-((t - cum[2]) / 4.5) ** 2))
            q = max(0.0, (t - (cum[3] - 12)) / 12.0); r *= 1 - 0.12 * q * q
            d = Vector(D[k]); bk = Vector(BK[k]); st.append((Vector(J[k]) + d * (t - cum[k]) + O, d.cross(bk), bk, r * 1.05, r * 0.95))
        geo.sweep(b, st, 16, 2.15, True, True)

    def blob(pts, rs, n=14):
        P = [Vector(p) + O for p in pts]; st = []
        for i, p in enumerate(P):
            u, v = geo.perp(P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]); st.append((p, u, v, rs[i], rs[i]))
        geo.sweep(b, st, n, 2.0, True, True)
    blob([(-18, 6, -9), (-24, 22, -12), (-29, 40, -14), (-33, 56, -13), (-35, 68, -10)], [11, 14.5, 16, 14, 9.5])    # thenar
    blob([(-30, 46, -6), (-40, 62, -8), (-39, 78, -4), (-33, 90, -1)], [10, 9, 8.5, 8])                              # web
    blob([(24, 8, -8), (27, 28, -9), (28, 50, -7.5), (27, 70, -4.5)], [9, 11.5, 11, 8])                              # hypothenar
    st = []                                                                                                         # knuckle guard
    for x in (-36, -24, -12, 0, 12, 24, 34):
        st.append((V(OX + x, float(np.interp(x, [-29, -8, 12, 30], [92, 96, 92, 82])) - 8, 13.6 - 0.0012 * x * x), Y, Z, 11.5, 3.6))
    geo.sweep(b, st, 12, 3.0, True, True)
    geo.sweep(b, [(V(OX, y, 0), X, Z, 31.9, 22.1) for y in (-23, -17, -10, -4)], 30, 2.7, False, False)              # wrist strap
    geo.sweep(b, [(V(OX + x, -13.5, 22.8 - 0.002 * x * x), Y, Z, 8.5, 1.7) for x in (-15, -5, 6, 19)], 10, 4.0, True, True)
    geo.GROUPS.pop('Glove', None); geo.finish(b, 'Glove'); me = geo.GROUPS['Glove'][0]
    ob = bpy.data.objects.new('tmpglove', me); bpy.context.scene.collection.objects.link(ob)
    m = ob.modifiers.new('r', 'REMESH'); m.mode = 'VOXEL'; m.voxel_size = voxel; m.adaptivity = 0.0; m.use_smooth_shade = True
    s = ob.modifiers.new('s', 'SMOOTH'); s.factor = 0.6; s.iterations = 5
    dg = bpy.context.evaluated_depsgraph_get(); dg.update(); n = len(ob.evaluated_get(dg).data.polygons) * 2
    d = ob.modifiers.new('d', 'DECIMATE'); d.ratio = min(1.0, tris / max(n, 1))
    dg = bpy.context.evaluated_depsgraph_get(); dg.update()
    out = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg); bpy.data.objects.remove(ob)
    for p in out.polygons: p.use_smooth = True
    set_pid(out, GLOVE, 1); print('glove remesh', n, '->', sum(len(p.vertices) - 2 for p in out.polygons), 'tris')
    return out


def build_sleeve():
    b = geo.B(SLEEVE, 2); OX = RD.OFFX; L2 = RD.L2

    def dims(d):
        k = min(1.0, max(0.0, (d - 26) / 230.0)); hw = lerp(38.0, 49.0, k); hh = lerp(31.0, 44.0, k)
        if d > L2: q = min(1.0, (d - L2) / 120.0); hw = lerp(hw, 54.0, q); hh = lerp(hh, 51.0, q)
        return hw, hh

    def fold(d, a):
        A = 0.05 * (1 + 0.8 * math.exp(-(d - 34) / 60.0)) * (1 + 0.6 * math.exp(-((d - L2) / 45.0) ** 2))
        return 1 + A * (0.6 * sin(2 * pi * d / 23.0 + 1.9 * sin(a + 0.6) + 0.9 * sin(2 * a + 1.1)) + 0.4 * sin(2 * pi * d / 10.5 + 2.6 * sin(1.5 * a)))
    ds = [26.0, 27.5, 31, 36, 42, 49, 57, 66, 76, 87, 99, 112, 126, 141, 157, 174, 192, 210, 226, 240, 252, 263, 274, 286, 300, 318, 340, 368, 400, 440]
    st = [(V(OX, -40, 0), X, Z, 27.5, 18.5), (V(OX, -31, 0), X, Z, 33.0, 25.5)]; kinds = [HEM, HEM]
    for d in ds:
        hw, hh = dims(d); k = 0.97 if d < 27 else (1.035 if d < 37 else 1.0)
        st.append((V(OX, -d, 0), X, Z, hw * k, hh * k)); kinds.append(HEM if d < 37 else SLEEVE)
    geo.sweep(b, st, 26, 2.0, False, False, lambda i, j: kinds[min(i, len(kinds) - 1)], lambda i, a: fold(ds[i - 2], a) if i >= 4 else 1.0)
    geo.GROUPS.pop('Sleeve', None); geo.finish(b, 'Sleeve'); return geo.GROUPS['Sleeve'][0]


def build_right_arm():
    bm = bmesh.new(); bm.from_mesh(build_glove()); bm.from_mesh(build_sleeve())
    me = bpy.data.meshes.new('ATLAS_arms'); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    return me


def build_armature():
    arm = bpy.data.armatures.new('Arms'); ob = bpy.data.objects.new('Arms', arm); bpy.context.scene.collection.objects.link(ob)
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT'); L1, L2 = RD.L1, RD.L2
    for side, sx in (('R', 1), ('L', -1)):
        def P(v): return Vector((sx * (v[0] + RD.OFFX), v[1], v[2])) * MM

        def bone(name, h, t, zax, parent=None, connect=False):
            eb = arm.edit_bones.new(name + '_' + side); eb.head = P(h); eb.tail = P(t); eb.align_roll(Vector((sx * zax[0], zax[1], zax[2])))
            if parent: eb.parent = arm.edit_bones[parent + '_' + side]; eb.use_connect = connect
        bone('UpperArm', (0, -L2 - L1, 0), (0, -L2, 0), (0, 0, 1)); bone('Forearm', (0, -L2, 0), (0, 0, 0), (0, 0, 1), 'UpperArm', True)
        bone('Hand', (0, 0, 0), (0, 55, 0), (0, 0, 1), 'Forearm')
        for f in FN:
            J, R, D, BK = RD.chain(f); par = 'Hand'
            for k in range(3): bone(f + str(k + 1), J[k], J[k + 1], BK[k], par, k > 0); par = f + str(k + 1)
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in ob.pose.bones: pb.rotation_mode = 'QUATERNION'
    return ob


def build_skinned(right, arm_ob):
    """mirror the right arm, join both and skin them to the armature"""
    left = right.copy(); left.transform(Matrix.Scale(-1, 4, (1, 0, 0))); left.flip_normals()
    bm = bmesh.new(); bm.from_mesh(right); bm.from_mesh(left); me = bpy.data.meshes.new('ArmsMesh'); bm.to_mesh(me); bm.free(); bpy.data.meshes.remove(left)
    for p in me.polygons: p.use_smooth = True
    n = len(right.vertices); co = np.empty(n * 3, np.float32); right.vertices.foreach_get('co', co); P = co.reshape(-1, 3).astype(float) / MM; P[:, 0] -= RD.OFFX
    col = np.empty(len(right.loops) * 4, np.float32); right.color_attributes['pid'].data.foreach_get('color', col)
    vi = np.empty(len(right.loops), np.int32); right.loops.foreach_get('vertex_index', vi); vp = np.zeros(n); vp[vi] = np.rint(col.reshape(-1, 4)[:, 0] * 32)
    g = vp == GLOVE; Wt = np.zeros((n, 18)); Wt[g] = RD.glove_weights(P[g]); Wt[~g] = RD.sleeve_weights(P[~g])
    ob = bpy.data.objects.new('ArmsMesh', me); bpy.context.scene.collection.objects.link(ob)
    for bi, bn in enumerate(RD.BONES):
        idx = np.nonzero(Wt[:, bi] > 0.004)[0]
        for side, off in (('R', 0), ('L', n)):
            vg = ob.vertex_groups.new(name=bn + '_' + side)
            for i in idx: vg.add([int(i) + off], float(Wt[i, bi]), 'REPLACE')
    for ca in list(me.color_attributes): me.color_attributes.remove(ca)
    ob.parent = arm_ob; md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = arm_ob
    print('ArmsMesh tris', sum(len(p.vertices) - 2 for p in me.polygons), 'verts', len(me.vertices))
    return ob


# ------------------------------------------------------------------ posing library
class Rig:
    def __init__(s, ob):
        s.ob = ob; B = ob.data.bones
        s.rest = {b.name: b.matrix_local.copy() for b in B}; s.par = {b.name: (b.parent.name if b.parent else None) for b in B}
        s.loc = {n: (s.rest[s.par[n]].inverted() @ s.rest[n] if s.par[n] else s.rest[n].copy()) for n in s.rest}
        s.locq = {n: m.to_quaternion() for n, m in s.loc.items()}; s.blen = {b.name: b.length for b in B}
        s.RELAX = s.pose(A_RELAX); s.OPEN = s.pose(A_OPEN); s.SPREAD = s.pose(A_SPREAD); s.FIST = s.pose(A_FIST)

    # ---- finger poses
    def pose(s, a):
        """angle set (degrees, right-hand semantics) -> (15,4) quaternion array"""
        out = np.zeros((15, 4)); th = a['Thumb']; qr = s.locq['Thumb1_R']
        qh = (qr @ Vector((0, 1, 0))).rotation_difference(s.thumb_dir(th[0], th[1]))
        tw = Quaternion((0, 1, 0), radians(th[2] * 0.5))           # pronation split between the metacarpal and the first phalanx
        out[0] = qr.inverted() @ qh @ qr @ tw; out[1] = tw @ qx(-th[3]); out[2] = qx(-th[4])
        for i, f in enumerate(FN[1:], 1):
            c = a[f]; out[3 * i] = Quaternion((0, 0, 1), radians(c[3])) @ qx(-c[0]); out[3 * i + 1] = qx(-c[1]); out[3 * i + 2] = qx(-c[2])
        return out

    def pre(s, a, k=0.5): return ablend(a, A_SPREAD, k)

    def quats(s, side, pose):
        m = 1.0 if side == 'R' else -1.0
        return [Quaternion((p[0], p[1], m * p[2], m * p[3])) for p in pose]

    def fk(s, side, Hm, pose):
        q = s.quats(side, pose); out = []
        for fi, f in enumerate(FN):
            M = Hm
            for k in range(3):
                M = M @ s.loc['%s%d_%s' % (f, k + 1, side)] @ q[3 * fi + k].to_matrix().to_4x4(); out.append(M)
        return out

    def samples(s, side, mats, only=None):
        """collision spheres along the finger bones: (point, radius, finger index, bone index)"""
        out = []
        for fi, f in enumerate(FN):
            if only is not None and fi != only: continue
            R = RD.chain(f)[1]
            for k in range(3):
                M = mats[3 * fi + k]; L = s.blen['%s%d_%s' % (f, k + 1, side)]
                for u in ((0.25, 0.5, 0.78, 1.0) if k == 0 else ((0.3, 0.65, 1.0) if k == 1 else (0.3, 0.6, 0.85))):
                    out.append((M @ Vector((0, L * u, 0)), float(R[k] + (R[k + 1] - R[k]) * u) * MM * 0.9, fi, k))
        return out

    def palm_pts(s, side, Hm):
        sx = 1 if side == 'R' else -1
        return [(Hm @ Vector((sx * x * MM, y * MM, z * MM)), r * MM, -1, 0) for x, y, z, r in RD.PALMS]

    @staticmethod
    def collide(bvh, pts, tol=0.0012):
        for q in pts:
            loc, nrm, idx, d = bvh.find_nearest(q[0], q[1] + 0.01)
            if loc is not None and d < q[1] - tol: return True
        return False

    @staticmethod
    def depth(bvh, pts):
        """deepest penetration of the spheres into the surface (metres, <= 0 means clear)"""
        worst = -1.0
        for q in pts:
            loc, nrm, idx, d = bvh.find_nearest(q[0], q[1] + 0.02)
            if loc is not None: worst = max(worst, q[1] - d)
        return worst

    def seat(s, bvh, side, R, p, g=(0, 62, 0), approach=(0, 0, 1), back=0.05, extra=0.03, tol=0.0005):
        """place the hand with rotation R so that hand point g (mm) starts at p, then push along approach until the palm touches"""
        sx = 1 if side == 'R' else -1; gl = Vector((sx * g[0], g[1], g[2])) * MM; Hm = R.to_4x4(); base = Vector(p) - R @ gl; ap = Vector(approach).normalized()
        Hm.translation = base - ap * back; skip = {j for j, q in enumerate(s.palm_pts(side, Hm)) if s.collide(bvh, [q], tol)}   # already touching something else
        for i in range(int((back + extra) / 0.001) + 1):
            Hm.translation = base + ap * (i * 0.001 - back)
            if s.collide(bvh, [q for j, q in enumerate(s.palm_pts(side, Hm)) if j not in skip], tol):
                Hm.translation = base + ap * ((i - 1) * 0.001 - back); return Hm, i
        Hm.translation = base; return Hm, -1

    def close(s, bvh, side, Hm, a0, fingers=('Index', 'Middle', 'Ring', 'Pinky'), thumb=70, maxc=(88, 110, 70), step=2.0, tol=0.0012):
        """curl every joint from the start angles until its finger segment touches the surface"""
        a = {k: list(v) for k, v in a0.items()}

        def hit(f, kmin):
            fi = FN.index(f); mats = s.fk(side, Hm, s.pose(a))
            return s.collide(bvh, [q for q in s.samples(side, mats, fi) if q[3] >= kmin], tol)
        for f in fingers:
            for k in range(3):
                if hit(f, k): continue
                while a[f][k] < maxc[k]:
                    old = list(a[f]); a[f][k] += step
                    if k == 1: a[f][2] = max(a[f][2], 0.55 * a[f][1])
                    if hit(f, k): a[f] = old; break
        if thumb:
            # opposed wrap: aim the thumb metacarpal across the object (nearest free direction), pronate it, then curl both phalanges until they touch
            th = thumb if isinstance(thumb, dict) else {}; flex = th.get('flex', (0.2, 1.0, 0.0)); base = s.thumb_aim(th.get('aim', (-0.1, 0.6, -0.79)), flex)
            for i, j in sorted(((i, j) for i in (0, 10, -10, 20, -20, 30) for j in (0, 10, -10, 20, -20, 30, -30)), key=lambda v: v[0] ** 2 + v[1] ** 2):
                a['Thumb'] = [base[0] + i, base[1] + j, s.thumb_twist(s.thumb_dir(base[0] + i, base[1] + j), flex), 3, 3]
                if not hit('Thumb', 1): break
            else: a['Thumb'] = base + [3, 3]
            for k, mx, kb in ((3, 62, 1), (4, 78, 2)):
                if hit('Thumb', kb): continue
                while a['Thumb'][k] < mx:
                    a['Thumb'][k] += step
                    if hit('Thumb', kb): a['Thumb'][k] -= step; break
        return a

    @staticmethod
    def thumb_dir(abd, add):
        """thumb metacarpal direction in hand space: abd = elevation towards the palm, add = swing towards the index finger (degrees)"""
        el = radians(abd); az = radians(39.0 - add); return Vector((-cos(el) * sin(az), cos(el) * cos(az), -sin(el)))

    def thumb_twist(s, d, flex):
        """pronation that makes the thumb flex towards `flex` when it points along d (hand space)"""
        qr = s.locq['Thumb1_R']; x = (qr @ Vector((0, 1, 0))).rotation_difference(d) @ (qr @ Vector((1, 0, 0)))
        u = Vector(flex) - d * Vector(flex).dot(d); u.normalize(); xd = u.cross(d)
        return degrees(math.atan2(x.cross(xd).dot(d), x.dot(xd)))

    def thumb_aim(s, aim, flex=(0.2, 1.0, 0.0)):
        aim = Vector(aim).normalized(); return [degrees(math.asin(-aim.z)), 39.0 - degrees(math.atan2(-aim.x, aim.y)), s.thumb_twist(aim, flex)]

    def pad(s, side, Hm, a, f):
        """world position of the finger pad (palmar side of the last phalanx)"""
        fi = FN.index(f); M = s.fk(side, Hm, s.pose(a))[3 * fi + 2]; L = s.blen['%s3_%s' % (f, side)]
        return M @ Vector((0, L * 0.55, -RD.chain(f)[1][3] * MM * 0.95))

    def reach(s, side, Hm, a0, f, target, tw=None):
        """angles that put the pad of finger f on the target point (coarse grid + refinement); returns (angles, residual)"""
        a = {k: list(v) for k, v in a0.items()}; target = Vector(target)
        if f == 'Thumb':
            grid = [(ab, ad, c2) for ab in range(0, 81, 10) for ad in range(-30, 41, 10) for c2 in range(0, 61, 15)]
            def put(v): a[f][0], a[f][1], a[f][3], a[f][4] = v[0], v[1], v[2], v[2] * 1.1
            lo, hi = (-5, -35, 0), (85, 45, 65)
        else:
            grid = [(c1, c2, sp) for c1 in range(-10, 86, 6) for c2 in range(0, 106, 7) for sp in (-12, -6, 0, 6, 12)]
            def put(v): a[f][0], a[f][1], a[f][2], a[f][3] = v[0], v[1], v[1] * 0.5, v[2]
            lo, hi = (-12, 0, -16), (88, 110, 16)

        def err(v): put(v); return (s.pad(side, Hm, a, f) - target).length
        best = min(grid, key=err); e = err(best); stp = 4.0
        while stp > 0.3:
            imp = False
            for i in range(3):
                for dlt in (-stp, stp):
                    v = list(best); v[i] = min(hi[i], max(lo[i], v[i] + dlt)); e2 = err(v)
                    if e2 < e - 1e-6: best, e, imp = v, e2, True
            if not imp: stp *= 0.5
        put(best); return a, e

    def proxy(s, side, Hm, pose):
        """low-poly collision hull of a posed hand (finger prisms + palm box) -> verts, polys"""
        vs = []; ps = []; mats = s.fk(side, Hm, pose)
        for fi, f in enumerate(FN):
            R = RD.chain(f)[1]
            for k in range(3):
                M = mats[3 * fi + k]; L = s.blen['%s%d_%s' % (f, k + 1, side)]; b0 = len(vs)
                for y, r in ((0.0, R[k] * MM), (L, R[k + 1] * MM)):
                    vs += [M @ Vector((r * cos(i * pi / 4), y, r * sin(i * pi / 4))) for i in range(8)]
                ps += [[b0 + i, b0 + (i + 1) % 8, b0 + 8 + (i + 1) % 8, b0 + 8 + i] for i in range(8)]
        b0 = len(vs); vs += [Hm @ Vector((x * MM, y * MM, z * MM)) for x in (-42, 42) for y in (-10, 100) for z in (-13, 13)]
        ps += [[b0 + i for i in q] for q in ((0, 1, 3, 2), (4, 5, 7, 6), (0, 1, 5, 4), (2, 3, 7, 6), (0, 2, 6, 4), (1, 3, 7, 5))]
        return vs, ps

    # ---- arm IK
    def solve(s, side, S, Hm, pole):
        """two-bone IK shoulder S -> wrist of Hm; the forearm carries the full twist of the hand. Returns upper arm, forearm matrices and the (possibly moved) shoulder."""
        l1 = RD.L1 * MM; l2 = RD.L2 * MM; Wp = Hm.to_translation(); d = Wp - S; L = d.length; lmax = (l1 + l2) * 0.985; lmin = abs(l1 - l2) + 0.05; moved = False
        if L > lmax: S = Wp - d * (lmax / L); L = lmax; moved = True
        elif L < lmin: S = Wp - d * (lmin / L); L = lmin; moved = True
        d = (Wp - S) / L; a = (l1 * l1 - l2 * l2 + L * L) / (2 * L); h = math.sqrt(max(l1 * l1 - a * a, 0.0))
        p = Vector(pole) - d * Vector(pole).dot(d); p.normalize(); E = S + d * a + p * h
        yu = (E - S).normalized(); yf = (Wp - E).normalized(); hx = Hm.col[0].xyz
        xf = (hx - yf * hx.dot(yf)).normalized(); xu = (xf - yu * xf.dot(yu)).normalized()

        def M(x, y, o):
            m = Matrix((x, y, x.cross(y))).transposed().to_4x4(); m.translation = o; return m
        return M(xu, yu, S), M(xf, yf, E), moved

    def channels(s, side, Mu, Mf, Hm, pose):
        """pose-bone channel values (location or None, quaternion) for one arm"""
        n = lambda b: b + '_' + side; out = {}
        bu = s.rest[n('UpperArm')].inverted() @ Mu; out[n('UpperArm')] = (bu.to_translation(), bu.to_quaternion())
        out[n('Forearm')] = (None, (s.loc[n('Forearm')].inverted() @ (Mu.inverted() @ Mf)).to_quaternion())
        out[n('Hand')] = (None, (s.loc[n('Hand')].inverted() @ (Mf.inverted() @ Hm)).to_quaternion())
        for i, q in enumerate(s.quats(side, pose)): out[n(FN[i // 3] + str(i % 3 + 1))] = (None, q)
        return out

    def apply(s, ch):
        for name, (loc, q) in ch.items():
            pb = s.ob.pose.bones[name]; pb.rotation_quaternion = q
            if loc is not None: pb.location = loc


def bvh_of(objs, space=None, extra=None):
    """BVH of mesh objects in world space (or in the local space of matrix `space`), plus optional (verts, polys)"""
    vs = []; ps = []; inv = space.inverted() if space is not None else Matrix.Identity(4)
    for o in objs:
        mw = inv @ o.matrix_world; b0 = len(vs)
        vs += [mw @ v.co for v in o.data.vertices]; ps += [[b0 + i for i in p.vertices] for p in o.data.polygons]
    if extra: b0 = len(vs); vs += list(extra[0]); ps += [[b0 + i for i in p] for p in extra[1]]
    return BVHTree.FromPolygons(vs, ps)
