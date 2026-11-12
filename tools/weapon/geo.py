# Procedural AKM-pattern rifle + gloved first-person hands (all geometry authored in mm,
# Blender axes: +X right, +Y muzzle, +Z up; converted to metres in finish()).
import bpy, bmesh, math, random
from math import sin, cos, pi, radians
from mathutils import Vector
import numpy as np

S = 0.001
GROUPS = {}
_rng = random.Random(11)
STEEL, MAGS, BOLT, WOOD, GRIPW, FABRIC, LEATHER, PAD, SLEEVE, CUFF, BRASS, FABRIC2, HEM, VENT = range(1, 15)


def V(x, y, z): return Vector((x, y, z))
def lerp(a, b, t): return a + (b - a) * t


class B:
    def __init__(self, pid, tag=0):
        self.bm = bmesh.new(); self.lay = self.bm.faces.layers.int.new('pidf'); self.pid = pid; self.tag = tag

    def vert(self, p): return self.bm.verts.new(p)

    def face(self, vs, pid=None):
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        f[self.lay] = pid if pid is not None else self.pid
        return f


def loft(b, rings, cap0=True, cap1=True, pidfn=None):
    vr = [[b.vert(p) for p in r] for r in rings]; n = len(rings[0])
    for i in range(len(vr) - 1):
        for j in range(n):
            k = (j + 1) % n
            b.face([vr[i][j], vr[i][k], vr[i + 1][k], vr[i + 1][j]], pidfn(i, j) if pidfn else None)
    if cap0: b.face(list(reversed(vr[0])))
    if cap1: b.face(vr[-1])
    return vr


def prism(b, poly, a0, a1, plane='yz'):
    def P(u, v, a): return V(a, u, v) if plane == 'yz' else (V(u, a, v) if plane == 'xz' else V(u, v, a))
    return loft(b, [[P(u, v, a0) for u, v in poly], [P(u, v, a1) for u, v in poly]])


def box(b, x0, x1, y0, y1, z0, z1):
    return loft(b, [[V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0)],
                    [V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)]])


def rrect(hw, hh, r=0.0, k=4, cx=0.0, cy=0.0):
    if not isinstance(r, (tuple, list)): r = (r,) * 4
    k = k + 3
    pts = []
    for (x, y, a0), rr in zip(((-hw, -hh, 180), (hw, -hh, 270), (hw, hh, 0), (-hw, hh, 90)), r):
        rr = min(rr, hw, hh)
        if rr < 1e-6: pts.append((cx + x, cy + y)); continue
        ox = x + (rr if x < 0 else -rr); oy = y + (rr if y < 0 else -rr)
        for i in range(k + 1):
            a = radians(a0 + 90.0 * i / k); pts.append((cx + ox + rr * cos(a), cy + oy + rr * sin(a)))
    return pts


def arcp(cx, cy, r, a0, a1, n, ry=None):
    ry = r if ry is None else ry
    return [(cx + r * cos(radians(lerp(a0, a1, i / n))), cy + ry * sin(radians(lerp(a0, a1, i / n)))) for i in range(n + 1)]


def perp(t):
    t = t.normalized(); a = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
    u = a.cross(t).normalized(); return u, t.cross(u).normalized()


def lathe(b, o, ax, prof, n=20, cap0=True, cap1=True):
    n = int(n * 1.6); o = Vector(o); ax = Vector(ax).normalized(); u, v = perp(ax)
    rings = [[o + ax * t + (u * cos(2 * pi * j / n) + v * sin(2 * pi * j / n)) * r for j in range(n)] for t, r in prof]
    return loft(b, rings, cap0, cap1)


def cyl(b, p0, p1, r, n=16, r1=None):
    p0 = Vector(p0); p1 = Vector(p1)
    return lathe(b, p0, p1 - p0, [(0, r), ((p1 - p0).length, r if r1 is None else r1)], n)


def dome(b, c, nrm, r=2.4, h=1.0, n=10):
    lathe(b, Vector(c) - Vector(nrm) * 0.3, nrm, [(0, r), (0.3 + h * 0.45, r * 0.88), (0.3 + h * 0.85, r * 0.55), (0.3 + h, r * 0.2)], n)


def crom(pts, sub, closed=False):
    P = [Vector(p) for p in pts]; n = len(P); out = []
    for i in range(n if closed else n - 1):
        p0 = P[(i - 1) % n] if (closed or i > 0) else P[0] * 2 - P[1]
        p1 = P[i]; p2 = P[(i + 1) % n]
        p3 = P[(i + 2) % n] if (closed or i + 2 < n) else P[-1] * 2 - P[-2]
        for s in range(sub):
            t = s / sub
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t))
    if not closed: out.append(P[-1].copy())
    return out


def smooth2(path, sub=4):
    return [(p.x, p.y) for p in crom([Vector((u, v, 0)) for u, v in path], sub)]


def thick(path, t):
    P = [Vector(p) for p in path]; L = []; R = []
    for i, p in enumerate(P):
        d = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized(); nr = Vector((-d.y, d.x))
        L.append(tuple(p + nr * t / 2)); R.append(tuple(p - nr * t / 2))
    return L + R[::-1]


def tube(b, pts, rad, n=10, sub=4, closed=False):
    P = crom(pts, sub, closed); m = len(P); k = len(pts); rl = isinstance(rad, (list, tuple))
    def r_at(i):
        if not rl: return rad
        u = i / sub; i0 = int(math.floor(u)); f = u - i0
        return lerp(rad[i0 % k], rad[(i0 + 1) % k if closed else min(i0 + 1, k - 1)], f)
    rings = []; prev = None
    for i, p in enumerate(P):
        t = ((P[(i + 1) % m] - P[(i - 1) % m]) if closed else (P[min(i + 1, m - 1)] - P[max(i - 1, 0)])).normalized()
        u = perp(t)[0] if prev is None else (prev - t * prev.dot(t)).normalized()
        prev = u; v = t.cross(u); r = r_at(i)
        rings.append((p, t, u, v, r))
    def ring(p, u, v, r): return [p + (u * cos(2 * pi * j / n) + v * sin(2 * pi * j / n)) * r for j in range(n)]
    out = [ring(p, u, v, r) for p, t, u, v, r in rings]
    if closed:
        loft(b, out + [out[0]], False, False); return
    p, t, u, v, r = rings[0]
    pre = [ring(p - t * (r * sin(radians(a))), u, v, r * cos(radians(a))) for a in (80, 60, 30)]
    p, t, u, v, r = rings[-1]
    post = [ring(p + t * (r * sin(radians(a))), u, v, r * cos(radians(a))) for a in (30, 60, 80)]
    loft(b, pre + out + post)


def sweep(b, st, n=12, expo=2.0, round0=False, round1=True, pidfn=None, mod=None):
    """st: list of (center, side, back, hw, hh) stations; superellipse rings."""
    def ring(c, s, bk, hw, hh, i=0):
        out = []
        for j in range(n):
            a = 2 * pi * j / n; x = cos(a); y = sin(a)
            x = math.copysign(abs(x) ** (2 / expo), x); y = math.copysign(abs(y) ** (2 / expo), y)
            k = mod(i, a) if mod else 1.0
            out.append(c + s * (hw * x * k) + bk * (hh * y * k))
        return out
    rings = [ring(*s, i) for i, s in enumerate(st)]
    def cap(end, nb):
        c, s, bk, hw, hh = st[end]; t = (c - st[nb][0]).normalized(); L = min(hw, hh)
        return [ring(c + t * (L * sin(radians(a))), s, bk, hw * cos(radians(a)), hh * cos(radians(a))) for a in (35, 62, 80)]
    if round0: rings = cap(0, 1)[::-1] + rings
    if round1: rings = rings + cap(-1, -2)
    return loft(b, rings, True, True, pidfn)


def boolean_diff(b, c):
    try:
        for q in (b, c): bmesh.ops.recalc_face_normals(q.bm, faces=q.bm.faces[:])
        m1 = bpy.data.meshes.new('t1'); b.bm.to_mesh(m1); m2 = bpy.data.meshes.new('t2'); c.bm.to_mesh(m2)
        o1 = bpy.data.objects.new('t1', m1); o2 = bpy.data.objects.new('t2', m2)
        col = bpy.context.scene.collection; col.objects.link(o1); col.objects.link(o2)
        md = o1.modifiers.new('b', 'BOOLEAN'); md.operation = 'DIFFERENCE'; md.object = o2
        dg = bpy.context.evaluated_depsgraph_get(); dg.update()
        m3 = bpy.data.meshes.new_from_object(o1.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        ok = len(m3.polygons) > len(m1.polygons) and 'pidf' in m3.attributes
        if ok:
            b.bm.clear(); b.bm.from_mesh(m3); b.lay = b.bm.faces.layers.int.get('pidf')
        bpy.data.objects.remove(o1); bpy.data.objects.remove(o2)
        print('boolean', ok, len(m1.polygons), len(m3.polygons))
    except Exception as ex:
        print('boolean failed', ex)


def finish(b, group, bevel=0.0, seg=2, sharp=50, bev_min=28):
    bm = b.bm
    if bevel >= 0.4 and seg == 2: seg = 3
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if bevel > 0:
        ed = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > radians(bev_min)]
        if ed:
            try:
                bmesh.ops.bevel(bm, geom=ed, offset=bevel, offset_type='OFFSET', segments=seg, profile=0.5, affect='EDGES', clamp_overlap=True)
            except Exception as ex:
                print('bevel fail', group, ex)
    for f in bm.faces:
        f.smooth = True
        if f[b.lay] == 0: f[b.lay] = b.pid
    for e in bm.edges:
        e.smooth = not (len(e.link_faces) == 2 and e.calc_face_angle(0.0) > radians(sharp))
    bmesh.ops.scale(bm, vec=(S, S, S), verts=bm.verts[:])
    me = bpy.data.meshes.new(group + '_p'); bm.to_mesh(me); bm.free()
    n = len(me.polygons)
    pidf = np.zeros(n, dtype=np.int32); me.attributes['pidf'].data.foreach_get('value', pidf)
    lt = np.zeros(n, dtype=np.int32); me.polygons.foreach_get('loop_total', lt)
    pc = np.repeat(pidf, lt).astype(np.float32)
    col = np.zeros((len(pc), 4), dtype=np.float32)
    col[:, 0] = pc / 32.0; col[:, 1] = _rng.random(); col[:, 2] = b.tag / 32.0; col[:, 3] = 1.0
    ca = me.color_attributes.new('pid', 'FLOAT_COLOR', 'CORNER'); ca.data.foreach_set('color', col.ravel())
    me.attributes.remove(me.attributes['pidf'])
    GROUPS.setdefault(group, []).append(me)


# ---------------------------------------------------------------- rifle
HWR = 16.5; RH = 46.0; BZ = 34.0; GZ = 58.0; SZ = 85.0
MC = (355.5, 34.8); MR = 250.0


def mp(phi, off, x):
    a = radians(phi); r = MR + off
    return V(x, MC[0] + r * cos(a), MC[1] + r * sin(a))


def build_rifle():
    R = 'RifleBody'
    # receiver: stamped U channel
    b = B(STEEL, 1)
    def rsec(z0):
        o = [(-HWR, RH)]
        o += [(-HWR + 3.2 + 3.2 * cos(radians(a)), z0 + 3.2 + 3.2 * sin(radians(a))) for a in (180, 202.5, 225, 247.5, 270)]
        o += [(HWR - 3.2 + 3.2 * cos(radians(a)), z0 + 3.2 + 3.2 * sin(radians(a))) for a in (270, 292.5, 315, 337.5, 360)]
        o += [(HWR, RH), (HWR - 1.6, RH), (HWR - 1.6, z0 + 4.4), (HWR - 4.4, z0 + 1.8), (-HWR + 4.4, z0 + 1.8), (-HWR + 1.6, z0 + 4.4), (-HWR + 1.6, RH)]
        return o
    loft(b, [[V(x, y, z) for x, z in rsec(z0)] for y, z0 in ((-75, 10), (-66, 0), (185, 0))])
    c = B(STEEL, 1); st = arcp(95, 22, 6.5, 90, 270, 10) + arcp(121, 22, 6.5, -90, 90, 10)
    prism(c, st, HWR - 0.9, HWR + 3, 'yz'); prism(c, st, -HWR - 3, -HWR + 0.9, 'yz'); boolean_diff(b, c); c.bm.free()
    finish(b, R, 0.35)
    b = B(STEEL, 21)
    box(b, -HWR + 1.6, HWR - 1.6, 150, 185, 1.8, RH); box(b, -HWR + 1.6, HWR - 1.6, -72, -52, 6, RH)
    box(b, -9.5, 9.5, -12, 78, -1.6, 0.2)
    finish(b, R, 0.3)
    # rivets and pins
    b = B(STEEL)
    for sx in (-1, 1):
        for y, z in ((160, 37), (176, 37), (177, 13), (-60, 36), (-58, 14), (66, 31)):
            dome(b, (sx * HWR, y, z), (sx, 0, 0), 2.5, 1.0)
        for y, z in ((22, 11), (55, 18), (40, 37)):
            cyl(b, (sx * HWR, y, z), (sx * (HWR + 0.6), y, z), 2.6, 12)
    for x, y in ((-6, 60), (6, 60), (-6, 47), (6, 47), (0, -4)): dome(b, (x, y, -1.6), (0, 0, -1), 2.2, 0.8)
    finish(b, R, 0.2, 1)
    # selector lever (fire position)
    b = B(STEEL)
    ang = radians(-13); py, pz = -28.0, 30.0
    def rot(u, v): return (py + u * cos(ang) - v * sin(ang), pz + u * sin(ang) + v * cos(ang))
    poly = [(7 * cos(radians(a)), 7 * sin(radians(a))) for a in (90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270)]
    poly += [(20, -4.5), (68, -4.5), (76, -7), (100, -7), (102, -5), (102, 4), (100, 6), (76, 6), (68, 4.5), (20, 4.5)]
    prism(b, [rot(u, v) for u, v in poly], HWR + 0.9, HWR + 2.3, 'yz')
    prism(b, [rot(u, v) for u, v in ((86, -9.8), (101, -9.8), (101, -6.6), (86, -6.6))], HWR + 0.9, HWR + 9.5, 'yz')
    cyl(b, (HWR, py, pz), (HWR + 3.4, py, pz), 4.2, 14)
    finish(b, R, 0.4)
    # trigger guard + mag catch
    b = B(STEEL)
    path = smooth2([(-9, -1), (-8.5, -20), (-3, -28), (8, -30.5), (48, -30.5), (58, -28), (63.5, -20), (64.5, -1)], 4)
    prism(b, thick(path, 1.7), -8.5, 8.5, 'yz')
    finish(b, R, 0.35)
    b = B(STEEL)
    prism(b, [(64, -2), (76, -2), (76.5, -12), (74, -17), (69, -24), (64, -28), (61.5, -26.5), (66, -21), (69, -15), (68, -9), (64, -8)], -5.5, 5.5, 'yz')
    finish(b, R, 0.5)
    # trigger (own node)
    b = B(STEEL)
    prism(b, [(17, 2), (14.5, -5), (13.2, -12), (13.8, -18), (16, -23.5), (13, -24), (9.5, -19), (8.5, -12), (9.5, -5), (11, 2)], -3.5, 3.5, 'yz')
    finish(b, 'Trigger', 0.7)
    # pistol grip
    b = B(GRIPW, 7)
    rings = []
    for z, hd, hw in ((1, 20.5, 13.5), (-10, 19.5, 13.5), (-45, 18.5, 14), (-80, 19, 14.5), (-93, 19.8, 14.5), (-97.5, 18.6, 13.3), (-99.5, 16, 11)):
        rings.append([V(x, -27 + 0.364 * z + yl, z) for x, yl in rrect(hw, hd, 6.5, 4)])
    loft(b, rings); finish(b, R)
    b = B(STEEL); cyl(b, (0, -27 + 0.364 * -99.5, -99.3), (0, -27 + 0.364 * -99.5, -100.4), 4.5, 14); finish(b, R, 0.25, 1)
    # stock
    b = B(WOOD, 5); rings = []
    for y, zt, zb, hw, r in ((-75, 45.5, 10, 15.5, 7), (-95, 45.2, 2.9, 16.3, 7.5), (-140, 44.4, -13.1, 17.5, 8), (-200, 43.2, -34.4, 19, 8.5), (-262, 41.6, -56.4, 20, 9), (-291, 41, -66.7, 20, 9), (-293.2, 40, -65.5, 19, 8.5)):
        rings.append([V(x, y, z) for x, z in rrect(hw, (zt - zb) / 2, r, 4, 0, (zt + zb) / 2)])
    loft(b, rings); finish(b, R)
    b = B(STEEL)
    prism(b, rrect(20.6, 53.9, 9, 4, 0, -12.85), -295, -293, 'xz')
    cyl(b, (0, -295, -8), (0, -295.7, -8), 9.5, 20)
    dome(b, (0, -295, 26), (0, -1, 0), 3.2, 0.8); dome(b, (0, -295, -50), (0, -1, 0), 3.2, 0.8)
    box(b, -7, 7, -106, -75, 44.8, 46.4); dome(b, (0, -96, 46.4), (0, 0, 1), 3.0, 0.7)
    box(b, -20.5, -19.0, -228, -202, -3, 9)
    finish(b, R, 0.45)
    b = B(STEEL)
    tube(b, [(-22.4, -227, -3), (-22.4, -227, -11), (-22.4, -223, -15), (-22.4, -207, -15), (-22.4, -203, -11), (-22.4, -203, -3), (-22.4, -207, 1), (-22.4, -223, 1)], 1.5, 8, 3, True)
    tube(b, [(-20.5, 363, 19), (-28, 363, 19), (-30.5, 363, 22), (-30.5, 363, 33), (-28, 363, 36), (-20.5, 363, 36)], 1.6, 8, 3)
    finish(b, R)
    # dust cover
    def arch(hw, zs, zt, rise, cut=False, n=22):
        p = [(-hw, zs)] + [(hw * cos(pi - pi * i / n), zt + rise * sin(pi * i / n)) for i in range(n + 1)]
        if not cut: p.append((hw, zs))
        return p
    def shell(hw, zs, zt, rise, th, cut=False):
        return arch(hw, zs, zt, rise, cut) + arch(hw - th, zs, zt, rise - th, cut)[::-1]
    b = B(STEEL, 3)
    prism(b, shell(15.6, 46.6, 58, 16, 1.2), -72, 36, 'xz'); prism(b, shell(15.6, 46.6, 58, 16, 1.2, True), 36, 148, 'xz')
    finish(b, R, 0.35)
    b = B(STEEL, 3)
    prism(b, arch(15.6, 46.6, 58, 16), -74.2, -72, 'xz'); box(b, -4, 4, -77, -73, 55, 63)
    finish(b, R, 0.9)
    b = B(STEEL, 3)
    for y0 in (-52, -22, 8): prism(b, shell(16.3, 48.5, 58, 16.7, 0.9), y0, y0 + 5, 'xz')
    for y0 in (66, 102): prism(b, shell(16.3, 48.5, 58, 16.7, 0.9, True), y0, y0 + 5, 'xz')
    finish(b, R, 0.3)
    # bolt carrier group (own node)
    b = B(BOLT)
    prism(b, [(-13, 47.2), (13.4, 47.2), (14.4, 48.6), (14.4, 57.5), (12.8, 65), (8, 70.5), (-8, 70.5), (-12.8, 65)], 30, 147, 'xz')
    box(b, -9, 9, 30, 112, 38, 48); cyl(b, (0, 96, BZ), (0, 149, BZ), 8.3, 16); cyl(b, (0, 147, GZ), (0, 214, GZ), 6.3, 14)
    finish(b, 'Bolt', 0.5)
    b = B(BOLT)
    tube(b, [(12, 130, 52.5), (24, 130, 52.5), (33, 131, 51.5), (40.5, 133.5, 49.5)], [5.4, 4.7, 4.4, 4.9], 12, 4)
    finish(b, 'Bolt')
    # rear sight block
    b = B(STEEL)
    prism(b, [(-14, 46), (14, 46), (14, 63), (11.5, 70.5), (6.5, 70.5), (6.5, 67), (-6.5, 67), (-6.5, 70.5), (-11.5, 70.5), (-14, 63)], 150, 204, 'xz')
    lathe(b, (0, 198, GZ), (0, 1, 0), [(0, 10.8), (28, 10.8)], 20)
    lathe(b, (0, 185.2, BZ), (0, 1, 0), [(0, 13.2), (41, 13.2)], 24)
    box(b, 13.5, 16.3, 203, 221, 52, 57); cyl(b, (13.5, 219, 55), (17.2, 219, 55), 3.6, 12)
    finish(b, R, 0.5)
    b = B(STEEL, 2)
    prism(b, [(219, 68), (219, 71), (156, 79), (156, 76)], -5.5, 5.5, 'yz')
    prism(b, [(-5.5, 75.5), (5.5, 75.5), (5.5, SZ), (0.8, SZ), (0.8, SZ - 1.9), (-0.8, SZ - 1.9), (-0.8, SZ), (-5.5, SZ)], 153, 156, 'xz')
    finish(b, R, 0.22, 1)
    b = B(STEEL)
    box(b, -8.5, 8.5, 176, 185, 70.8, 78.4)
    for sx in (-1, 1): cyl(b, (sx * 8.3, 180.5, 74.6), (sx * 11.6, 180.5, 74.6), 2.8, 12)
    cyl(b, (-8, 218, 69.5), (8, 218, 69.5), 2.4, 10)
    finish(b, R, 0.4)
    # barrel
    b = B(STEEL)
    lathe(b, (0, 0, BZ), (0, 1, 0), [(186, 9.6), (229, 9.6), (231, 8.6), (372, 8.2), (510, 7.5), (566, 7.5), (566, 3.9), (540, 3.9)], 24)
    finish(b, R, 0.35)
    # gas system
    b = B(STEEL)
    lathe(b, (0, 224, GZ), (0, 1, 0), [(0, 7.6), (168, 7.6)], 20)
    lathe(b, (0, 388, BZ), (0, 1, 0), [(0, 11.6), (30, 11.6)], 24)
    prism(b, [(390, 43), (416, 43), (404, 60), (385, 60)], -6.2, 6.2, 'yz')
    lathe(b, (0, 382, GZ), (0, 1, 0), [(0, 9.2), (24, 9.2), (28, 6.8), (29.5, 2.5)], 20)
    box(b, -4.5, 4.5, 393, 412, 15.5, 23.5)
    finish(b, R, 0.5)
    b = B(STEEL)
    for y0, y1 in ((226.5, 233), (348, 354.5)): prism(b, arcp(0, GZ, 16.2, 211, -31, 30), y0, y1, 'xz')
    prism(b, rrect(20.2, 17.7, (9.5, 9.5, 2, 2), 5, 0, 28.3), 359, 369, 'xz'); box(b, 20, 22.4, 350, 369, 29, 34)
    finish(b, R, 0.45)
    b = B(WOOD, 8); prism(b, arcp(0, GZ, 15.5, 211, -31, 30), 233, 348, 'xz'); finish(b, R, 0.6)
    # lower handguard with vents
    b = B(WOOD, 6); rings = []
    for y, hw, zb in ((188, 17.5, 12.5), (191, 19.5, 10.8), (230, 20.6, 9.6), (275, 22.5, 9.0), (320, 21.0, 9.8), (356, 19.6, 11.2), (359.5, 19.0, 12.0)):
        rings.append([V(x, y, z) for x, z in rrect(hw, (44 - zb) / 2, (9, 9, 1.6, 1.6), 5, 0, (44 + zb) / 2)])
    loft(b, rings)
    c = B(VENT)
    for yc in (222, 268, 314):
        st = arcp(yc - 9.75, 30, 3.25, 90, 270, 8) + arcp(yc + 9.75, 30, 3.25, -90, 90, 8)
        prism(c, st, 14.5, 30, 'yz'); prism(c, st, -30, -14.5, 'yz')
    boolean_diff(b, c); c.bm.free()
    finish(b, R, 0.3, 1)
    # cleaning rod, front sight block, muzzle brake
    b = B(STEEL)
    cyl(b, (0, 368, 20.3), (0, 553, 20.3), 2.3, 10); lathe(b, (0, 553, 20.3), (0, 1, 0), [(0, 2.3), (1, 3.3), (6, 3.3), (7, 2.6)], 12)
    finish(b, R, 0.2, 1)
    b = B(STEEL)
    lathe(b, (0, 512, BZ), (0, 1, 0), [(0, 10.8), (34, 10.8)], 24)
    prism(b, [(516, 42), (544, 42), (540, 62), (520, 62)], -5, 5, 'yz')
    box(b, -8.5, 8.5, 521, 539, 60, 70.5); cyl(b, (-10.5, 530, 63.8), (10.5, 530, 63.8), 3.6, 14)
    box(b, -4, 4, 512, 546, 17, 26)
    for sx in (-1, 1):
        prism(b, [(sx * x, z) for x, z in arcp(0, 79.5, 11.6, -62, 62, 10) + arcp(0, 79.5, 9.3, 62, -62, 10)], 523, 537, 'xz')
    finish(b, R, 0.4)
    b = B(STEEL)
    cyl(b, (0, 530, 70), (0, 530, 73.5), 2.3, 10); cyl(b, (0, 530, 73), (0, 530, SZ), 1.3, 10, 1.15)
    finish(b, R, 0.15, 1)
    b = B(STEEL); n = 28; lip = Vector((0.42, 0, -0.91)).normalized()
    def mring(r, yf): return [V(r * cos(2 * pi * j / n), yf(r * cos(2 * pi * j / n), r * sin(2 * pi * j / n)), BZ + r * sin(2 * pi * j / n)) for j in range(n)]
    sl = lambda dx, dz: 579.4 + 0.52 * (dx * lip.x + dz * lip.z)
    loft(b, [mring(10.9, lambda dx, dz: 549.0), mring(10.9, sl), mring(7.5, sl), mring(7.5, lambda dx, dz: 566.0)], True, False)
    finish(b, R, 0.45)
    # magazine (own node)
    G = 'Magazine'
    b = B(MAGS, 4); rings = []
    for i in range(27):
        phi = lerp(183.9, 233.8, i / 26.0); rings.append([mp(phi, -v, x) for x, v in rrect(13, 32, 3.2, 4)])
    rings.append([mp(233.8, -v, x) for x, v in rrect(13.9, 32.9, 3.6, 4)])
    rings.append([mp(234.4, -v, x) for x, v in rrect(13.9, 32.9, 3.6, 4)])
    rings.append([mp(234.6, -v, x) for x, v in rrect(12.9, 31.9, 3.2, 4)])
    loft(b, rings); box(b, -5, 5, 72, 77.5, -8, -2)
    finish(b, G, 0.3, 1)
    b = B(MAGS, 4)
    def er(phi): return V(0, cos(radians(phi)), sin(radians(phi)))
    for sx in (-1, 1):
        for off in (-15, 0, 15):
            sweep(b, [(mp(phi, -off, sx * 13.05), V(sx, 0, 0), er(phi), 1.0, 2.3) for phi in range(197, 231, 2)], 8, 2.5, True, True)
    sweep(b, [(mp(phi, 32.2, 0), V(1, 0, 0), er(phi), 3.2, 1.0) for phi in range(191, 233, 2)], 8, 2.5, True, True)
    sweep(b, [(mp(phi, -32.2, 0), V(1, 0, 0), er(phi), 2.2, 0.9) for phi in range(191, 233, 2)], 8, 2.5, True, True)
    finish(b, G)
    b = B(BRASS, 21)
    a = radians(183.9); up = V(0, -sin(a) * -1, -cos(a)); fw = V(0, -cos(a), -sin(a))
    lathe(b, mp(183.9, 27, 0) + V(0, 0, 6.8), fw, [(0, 5.2), (1, 5.65), (30, 5.0), (33, 4.3), (38.5, 4.3), (38.6, 3.95), (46, 3.6), (52, 2.2), (55.5, 0.7)], 12)
    finish(b, G)
    return dict(
        empties=dict(Muzzle=(0, 579.4, BZ), Eject=(17.5, 120, 52), SightRear=(0, 154.5, SZ), SightFront=(0, 530, SZ),
                     GripL=(0, 264, 9), MagGrip=(0, 205, -195), BoltGrip=(0, 172, -1)),
        origins=dict(Magazine=(0, 108, 0), Trigger=(0, 13, 8), HandR=(0, -35, -30), HandL=(0, 264, 9), Bolt=(0, 90, 55)))


# ---------------------------------------------------------------- hands
def fpid(n, side=True):
    def f(i, j):
        s = sin(2 * pi * (j + 0.5) / n)
        if s > 0.45: return FABRIC
        if s > -0.35: return FABRIC2 if side else FABRIC
        return LEATHER
    return f


def finger(b, J, R, center, n=20, sub=6, pad=None):
    P = crom(J, sub); m = len(P); st = []
    for i, p in enumerate(P):
        t = (P[min(i + 1, m - 1)] - P[max(i - 1, 0)]).normalized()
        bk = p - Vector(center); bk = (bk - t * bk.dot(t)).normalized(); sd = t.cross(bk).normalized()
        u = i / sub; i0 = min(int(u), len(R) - 2); r = lerp(R[i0], R[i0 + 1], u - i0)
        r *= 1 + 0.06 * max(0.0, 1 - abs((u + 0.5) % 1 - 0.5) * 4)
        st.append((p, sd, bk, r * 1.05, r * 0.95))
    sweep(b, st, n, 2.0, True, True, fpid(n))
    if pad is not None:
        p, sd, bk, hw, hh = st[0]; t0 = (P[sub] - P[0]).normalized()
        sweep(pad, [(p + t0 * a + bk * (R[0] * 0.66), sd, bk, 8.2, 4.8) for a in (-9, -3, 4, 11)], 12, 2.6, True, True)


def hand_body(G, Wr, K, sw, sk, bw, bk, n=20):
    b = B(FABRIC); st = []
    for t, hw, hh in ((0, 30, 20), (0.15, 33, 20), (0.35, 38, 18.5), (0.6, 42.5, 16.5), (0.85, 42, 14), (1.0, 40, 12.5)):
        s = sw.lerp(sk, t).normalized(); bb = bw.lerp(bk, t); bb = (bb - s * bb.dot(s)).normalized()
        st.append((Wr.lerp(K, t), s, bb, hw, hh))
    sweep(b, st, n, 2.6, True, True, lambda i, j: LEATHER if sin(2 * pi * (j + .5) / n) < -0.25 else FABRIC)
    finish(b, G)


def arm(G, Wr, side, back, fdir, L=500.0):
    t = Vector(fdir).normalized(); s = (side - t * side.dot(t)).normalized(); bk = t.cross(s)
    if bk.dot(back) < 0: bk = -bk
    b = B(FABRIC)
    sweep(b, [(Wr + t * d, s, bk, hw, hh) for d, hw, hh in ((-10, 29, 19), (0, 30.5, 20.5), (14, 32, 22), (30, 33.5, 23.5), (44, 34.5, 24.5))],
          20, 2.2, True, False, lambda i, j: LEATHER if sin(2 * pi * (j + .5) / 20) < -0.3 else FABRIC)
    finish(b, G)
    b = B(CUFF)
    sweep(b, [(Wr + t * d, s, bk, 30.6 + 0.1 * d + 1.2, 20.6 + 0.1 * d + 1.2) for d in (11, 17, 23, 29)], 20, 2.2, False, False)
    box_c = Wr + t * 20 + bk * (23.8 + 0.5)
    sweep(b, [(box_c + s * a, t, bk, 8.5, 1.6) for a in (-14, -4, 6, 16)], 8, 4.0, True, True)
    finish(b, G, 0.4, 1)
    def dims(d): k = min(1.0, (d - 34) / 250.0); return lerp(39, 47, k), lerp(31, 42, k)
    def fold(d, a):
        A = 0.055 * (1 + 0.7 * math.exp(-(d - 34) / 70.0))
        return 1 + A * (0.6 * sin(2 * pi * d / 23.0 + 1.9 * sin(a + 0.6) + 0.9 * sin(2 * a + 1.1)) + 0.4 * sin(2 * pi * d / 10.5 + 2.6 * sin(1.5 * a)))
    for tag, ds in ((0, [34] + list(range(36, 193, 6))), (20, list(range(192, int(L) + 1, 22)))):
        b = B(SLEEVE, tag); st = []
        for i, d in enumerate(ds):
            hw, hh = dims(d); k = 0.9 if (tag == 0 and i == 0) else (1.03 if d < 50 else 1.0)
            st.append((Wr + t * d, s, bk, hw * k, hh * k))
        sweep(b, st, 28, 2.0, False, False, (lambda i, j, ds=ds: HEM if ds[i] < 50 else SLEEVE), (lambda i, a, ds=ds: fold(ds[i], a)))
        finish(b, G)


G_AX = Vector((0, -0.342, -0.940)); G_F = Vector((0, 0.940, -0.342))
def gl(h, lx, lf): return Vector((0, -27, 0)) + G_AX * h + Vector((lx, 0, 0)) + G_F * lf


def build_hands():
    # ---- right hand on the pistol grip
    G = 'HandR'
    Wr = V(22, -146, -50); K = V(25.5, -50, -29)
    hand_body(G, Wr, K, V(0, -0.174, 0.985), V(0.073, 0.301, 0.951), V(1, 0, 0), V(1, 0, 0))
    b = B(FABRIC); pad = B(PAD)
    finger(b, [V(27, -44, -2), V(25, -5, -9), V(15, 17, -12), V(-2, 24, -13)], [10.5, 9.6, 8.8, 8.0], (2, -6, -10), pad=pad)
    for h, L, Rr in ((24, [(26, -14), (21.5, 25.5), (-7, 29), (-24, 13)], [10.8, 9.8, 9.0, 8.2]),
                     (44, [(25.5, -14), (21, 25), (-6.5, 28.5), (-23, 13)], [10.2, 9.3, 8.6, 7.8]),
                     (63, [(23.5, -13), (20, 23.5), (-5, 27), (-21, 13.5)], [9.2, 8.4, 7.7, 7.0])):
        finger(b, [gl(h + 2 * i, lx, lf) for i, (lx, lf) in enumerate(L)], Rr, gl(h + 3, 0, 0), pad=pad)
    finger(b, [V(18, -110, -24), V(0, -72, -13), V(-23, -44, -11), V(-25.5, -16, -10.5)], [14.5, 11.5, 10.3, 9.0], (0, -38, -32))
    finger(b, [V(2, -73, -14), V(14, -62, -9), V(25, -47, -4)], [11, 10, 10.5], (5, -45, -30))
    finish(b, G); finish(pad, G)
    arm(G, Wr, V(0, -0.174, 0.985), V(1, 0, 0), (0.30, -0.78, -0.55))
    # ---- left hand under the handguard
    G = 'HandL'
    Wl = V(-80, 250, -12); K = V(19, 264, -4.5)
    hand_body(G, Wl, K, V(0, 1, 0), V(0, 1, 0), V(-0.1, 0, -1), V(0.4, 0, -0.92))
    b = B(FABRIC); pad = B(PAD)
    for y, L, Rr in ((293, [(20, -3), (35, 31), (30.5, 51), (23, 62)], [10.5, 9.6, 8.8, 8.0]),
                     (273, [(20, -3.5), (35.5, 32), (30.5, 53), (22.5, 64)], [10.8, 9.8, 9.0, 8.2]),
                     (254, [(20, -3), (35, 31), (30.5, 51.5), (23, 62.5)], [10.2, 9.3, 8.6, 7.8]),
                     (236, [(18.5, -1.5), (32.5, 26), (29, 44), (23.5, 55)], [9.2, 8.4, 7.7, 7.0])):
        finger(b, [V(x, y + i, z) for i, (x, z) in enumerate(L)], Rr, (0, y, 28), pad=pad)
    finger(b, [V(-59, 271, -10), V(-36, 298, 20), V(-31.5, 322, 38), V(-28, 344, 50)], [15, 11.5, 10.3, 9.0], (0, 310, 28))
    finger(b, [V(-36, 297, 18), V(-22, 296, 2), V(-4, 295, -6)], [10.5, 10, 10], (0, 296, 28))
    finish(b, G); finish(pad, G)
    arm(G, Wl, V(0, 1, 0), V(-0.1, 0, -1), (-0.35, -0.75, -0.56))


def build_all():
    info = build_rifle(); build_hands(); return info
