# Valle Morta tank: a generic T-54/55 style medium tank, generated entirely by code.
#   blender -b --factory-startup -t 4 --python tools/vehicles/tank/build_tank.py -- intact|wreck [fast]
# Geometry (bmesh primitives, metres), UV atlases (smart project), CPU Cycles bakes of id / position /
# normal / bevel-edge / AO, numpy texture synthesis (paint, dust, mud, chips / rust, soot, burnt paint),
# glTF export to public/assets/models/tank.glb or tank_wreck.glb. See README.md.
import bpy, bmesh, math, os, sys, time
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
BUILD = os.path.join(HERE, 'build'); os.makedirs(BUILD, exist_ok=True)
OUT = BUILD     # copied into public/assets/models by tools/vehicles/install.mjs (under the GPU lock: writing into public/ reloads every open page)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
VAR = ARGS[0] if ARGS else 'intact'
WRECK = VAR == 'wreck'
FAST = 'fast' in ARGS
T0 = time.time()
PI, TAU = math.pi, 2 * math.pi
cos, sin, rad = math.cos, math.sin, math.radians


def log(*a):
    print('[tank %6.1fs]' % (time.time() - T0), *a, flush=True)


# material ids (face level, become texture regions)
PAINT, CAST, STEEL, RUBBER, GLASS, CANVAS, WOOD, DARK, TRACK, LENS, GUNM = range(1, 12)
NID = 12
rs = np.random.default_rng(11 if WRECK else 7)
jit = lambda a: float(rs.uniform(-a, a))

# ---------------------------------------------------------------- layout (Blender: +X forward, +Y left, +Z up, ground z = 0)
WX = [1.80, 0.88, 0.05, -0.78, -1.61]       # road wheel centres (the T-54 gap between the first two)
WZ, WR = 0.493, 0.418
SPR = (-2.55, 0.56, 0.33)                   # rear drive sprocket (pitch radius)
IDL = (2.62, 0.55, 0.305)                   # front idler
TY = 1.35                                   # track centre line
LK_OFF = 0.028                              # wheel surface -> link centre
TUR = Vector((0.70, 0.0, 1.42))             # turret ring centre on the roof
GUNP = Vector((0.85, 0.0, 0.40))            # trunnions, turret local
TURRET_YAW = 21.0 if WRECK else 0.0
GUN_DROOP = 5.5 if WRECK else 0.0
ROLL = math.degrees(math.asin(0.075 / (2 * TY))) if WRECK else 0.0   # thrown right track: the hull sits down on its right wheels


def T(x=0.0, y=0.0, z=0.0):
    return Matrix.Translation((x, y, z))


def R(ax, deg):
    return Matrix.Rotation(rad(deg), 4, ax)


def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1.0))


def basis(X, Y, Z, p):
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2], m[i][3] = X[i], Y[i], Z[i], p[i]
    return m


Z2X = R('Y', 90)    # lathe axis Z -> +X
Z2Y = R('X', -90)   # lathe axis Z -> +Y


# ---------------------------------------------------------------- mesh builder
class Part:
    def __init__(self, name, origin=(0, 0, 0)):
        self.name, self.v, self.f, self.m = name, [], [], []
        self.inv = T(*origin).inverted(); self.origin = Vector(origin)

    def add(self, bm, M=None, mat=None):
        M = self.inv @ (M if M is not None else Matrix.Identity(4))
        flip = M.to_3x3().determinant() < 0
        bm.verts.index_update(); base = len(self.v)
        self.v.extend([tuple(M @ v.co) for v in bm.verts])
        for f in bm.faces:
            ids = [base + v.index for v in f.verts]
            if flip: ids.reverse()
            self.f.append(ids); self.m.append(mat if mat is not None else f.material_index)
        bm.free()

    def tris(self):
        return sum(len(f) - 2 for f in self.f)


def bm_from(verts, faces, mats=None, recalc=True):
    bm = bmesh.new(); vs = [bm.verts.new(p) for p in verts]
    for i, fc in enumerate(faces):
        try:
            f = bm.faces.new([vs[j] for j in fc])
        except ValueError:
            continue
        if mats: f.material_index = mats[i]
    if recalc: bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def bevel(bm, w, seg=1, ang=30):
    es = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > rad(ang)]
    if es and w > 0:
        bmesh.ops.bevel(bm, geom=es, offset=w, offset_type='OFFSET', segments=seg, profile=0.5, affect='EDGES', clamp_overlap=True)
    return bm


def box(sx, sy, sz, bev=0.0, seg=1):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    return bevel(bm, bev, seg) if bev else bm


def prism(prof, y0, y1, bev=0.0, seg=1):
    n = len(prof); V = [(x, y0, z) for x, z in prof] + [(x, y1, z) for x, z in prof]
    F = [list(range(n)), list(range(2 * n - 1, n - 1, -1))] + [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    bm = bm_from(V, F)
    return bevel(bm, bev, seg) if bev else bm


def lathe(prof, segs, mats=None, closed=False, rfun=None):
    bm = bmesh.new(); rings = []
    A = [TAU * i / segs for i in range(segs)]
    for k, (r, h) in enumerate(prof):
        if r < 1e-6: rings.append([bm.verts.new((0, 0, h))])
        else:
            rings.append([bm.verts.new((r * (rfun(a, k) if rfun else 1) * cos(a), r * (rfun(a, k) if rfun else 1) * sin(a), h)) for a in A])
    n = len(prof)
    for k in range(n if closed else n - 1):
        a, b = rings[k], rings[(k + 1) % n]; mi = mats[k] if mats else 0
        for i in range(segs):
            j = (i + 1) % segs
            if len(a) == 1 and len(b) == 1: continue
            if len(a) == 1: q = [a[0], b[j], b[i]]
            elif len(b) == 1: q = [a[i], a[j], b[0]]
            else: q = [a[i], a[j], b[j], b[i]]
            try: bm.faces.new(q).material_index = mi
            except ValueError: pass
    return bm


def cyl(r, h, segs=12, mat=0):
    return lathe([(0, 0), (r, 0), (r, h), (0, h)], segs, [mat] * 3)


def tube(pts, rad_, sides=6, closed=False):
    P = [Vector(p) for p in pts]; n = len(P)
    rr = rad_ if isinstance(rad_, (list, tuple)) else [rad_] * n
    Tn = []
    for i in range(n):
        if closed: d = P[(i + 1) % n] - P[(i - 1) % n]
        else: d = P[min(i + 1, n - 1)] - P[max(i - 1, 0)]
        Tn.append(d.normalized())
    up = Vector((0, 0, 1)) if abs(Tn[0].z) < 0.9 else Vector((1, 0, 0))
    N = Tn[0].cross(up).normalized(); bm = bmesh.new(); rings = []
    for i in range(n):
        if i: N = (N - Tn[i] * N.dot(Tn[i])).normalized()
        B = Tn[i].cross(N)
        rings.append([bm.verts.new(P[i] + (N * cos(TAU * k / sides) + B * sin(TAU * k / sides)) * rr[i]) for k in range(sides)])
    for i in range(n if closed else n - 1):
        a, b = rings[i], rings[(i + 1) % n]
        for k in range(sides):
            bm.faces.new([a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]])
    if not closed:
        bm.faces.new(rings[0]); bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def ring_pts(c, r, n, plane='XZ', a0=0.0):
    out = []
    for k in range(n):
        a = a0 + TAU * k / n
        out.append((c[0] + r * cos(a), c[1], c[2] + r * sin(a)) if plane == 'XZ' else (c[0] + r * cos(a), c[1] + r * sin(a), c[2]))
    return out


def weld(part, a, b, r=0.009):
    a, b = Vector(a), Vector(b); n = max(2, int((b - a).length / 0.06))
    pts = [a.lerp(b, i / n) + Vector((jit(0.002), jit(0.002), jit(0.002))) for i in range(n + 1)]
    part.add(tube(pts, [r * (0.8 + 0.4 * rs.random()) for _ in pts], 5), None, PAINT)


def bolt(part, M, r=0.014, mat=PAINT):
    part.add(lathe([(0, 0), (r, 0), (r, 0.008), (r * 0.7, 0.013), (0, 0.013)], 6, [mat] * 4), M)


def eye_ring(part, c, axis='X', r=0.045, t=0.012):
    pts = ring_pts((0, 0, 0), r, 10)
    M = T(*c) @ (Matrix.Identity(4) if axis == 'X' else R('Z', 90))
    part.add(tube([(p[0], p[1], p[2] + r) for p in pts], t, 5, closed=True), M, STEEL)


# ---------------------------------------------------------------- hull
def glacis_frame(d, y, h=0.0):
    X = Vector((0.853, 0, -0.521)); Z = Vector((0.521, 0, 0.853))
    return basis(X, Vector((0, 1, 0)), Z, Vector((2.10, y, 1.42)) + X * d + Z * h)


def build_hull(H, drv):
    LP = [(-2.86, 0.43), (2.55, 0.43), (3.02, 0.858), (2.85, 0.962), (2.14, 1.396), (-2.62, 1.396), (-2.97, 1.33), (-3.02, 0.95), (-2.95, 0.62)]
    H.add(prism(LP, -1.04, 1.04, 0.012), None, PAINT)
    UP = [(-3.0, 1.01), (2.771, 1.01), (2.10, 1.42), (-2.60, 1.42), (-2.98, 1.35)]
    H.add(prism(UP, -1.40, 1.40, 0.014), None, PAINT)
    # welds along the plate joints
    for s in (-1, 1):
        weld(H, (2.10, s * 1.40, 1.42), (-2.60, s * 1.40, 1.42)); weld(H, (2.771, s * 1.40, 1.01), (2.10, s * 1.40, 1.42))
        weld(H, (3.02, s * 1.04, 0.858), (2.771, s * 1.04, 1.01)); weld(H, (-2.60, s * 1.40, 1.42), (-2.98, s * 1.40, 1.35))
    weld(H, (2.10, -1.39, 1.42), (2.10, 1.39, 1.42)); weld(H, (3.02, -1.03, 0.858), (3.02, 1.03, 0.858)); weld(H, (-2.60, -1.39, 1.42), (-2.60, 1.39, 1.42))
    # turret ring guard
    H.add(lathe([(1.05, 0), (1.20, 0), (1.20, 0.035), (1.17, 0.05), (1.05, 0.05)], 72, [PAINT] * 5, closed=True), T(*TUR))
    # splash board, driver's periscopes, lifting eyes on the glacis
    for s in (-1, 1):
        H.add(box(0.012, 0.95, 0.085, 0.003), glacis_frame(0.34, s * 0.47, 0.042) @ R('Z', s * 14), PAINT)
        H.add(box(0.05, 0.08, 0.05, 0.006), glacis_frame(0.62, s * 1.15, 0.025), PAINT)
        eye_ring(H, glacis_frame(0.62, s * 1.15, 0.05).to_translation(), 'X', 0.035, 0.011)
    for y in (0.50, 0.74):
        H.add(box(0.07, 0.13, 0.07, 0.006), glacis_frame(0.06, y, 0.03), PAINT)
        H.add(box(0.012, 0.11, 0.045), glacis_frame(0.025, y, 0.03) @ R('Y', -30), GLASS)
    # front tow hooks on the lower glacis, rear hooks
    for s in (-1, 1):
        for xs, x0, z0 in ((1, 2.78, 0.62), (-1, -3.0, 0.76)):
            H.add(box(0.12, 0.16, 0.16, 0.012), T(x0, s * 0.74, z0), PAINT)
            b = Vector((x0 + xs * 0.04, s * 0.74, z0))
            H.add(tube([b, b + Vector((xs * 0.10, 0, 0)), b + Vector((xs * 0.16, 0, 0.04)), b + Vector((xs * 0.16, 0, 0.12)), b + Vector((xs * 0.11, 0, 0.15))], 0.028, 8), None, STEEL)
    # headlights with guards (two on the left, one on the right)
    for y in (1.12, 1.30, -1.18):
        gz = 1.01 + (2.771 - 2.50) * 0.611
        c = Vector((2.50, y, gz + 0.12))
        H.add(box(0.06, 0.05, 0.1, 0.006), T(c.x - 0.02, y, gz + 0.05), PAINT)
        big = abs(y - 1.30) < 0.01
        rr = 0.095 if big else 0.08
        H.add(lathe([(0, -0.09), (rr * 0.7, -0.09), (rr, -0.04), (rr, 0.05), (rr + 0.006, 0.06), (rr * 0.85, 0.066), (0, 0.068)], 18, [PAINT, PAINT, PAINT, PAINT, PAINT, DARK if big else LENS]), T(*c) @ Z2X)
        g = [c + Vector((-0.04, -0.12, -0.07)), c + Vector((0.12, -0.12, -0.05))]
        for k in range(1, 8):
            a = PI * k / 8; g.append(c + Vector((0.16, -0.12 * cos(a), 0.12 * sin(a) - 0.01)))
        g += [c + Vector((0.12, 0.12, -0.05)), c + Vector((-0.04, 0.12, -0.07))]
        H.add(tube(g, 0.008, 5), None, STEEL)
    # driver's hatch ring (the hatch itself is its own node)
    H.add(lathe([(0.22, 0), (0.30, 0), (0.30, 0.025), (0.27, 0.035), (0.22, 0.035)], 28, [PAINT] * 5, closed=True), T(drv.x, drv.y, 1.42))
    # fenders: thin plate over the track, flanged edge, bent front, brackets, rear mud flaps
    for s in (-1, 1):
        y0, y1 = s * 1.40, s * 1.645
        segs = [[(-3.02, 1.03), (2.0, 1.03)], [(2.0, 1.03), (2.86, 1.03), (3.22, 0.86)]]
        for i, top in enumerate(segs):
            M = Matrix.Identity(4)
            if WRECK and s < 0 and i == 1: M = T(2.0, 0, 1.03) @ R('Y', 13) @ R('X', 4) @ T(-2.0, 0, -1.03)
            poly = top + [(x, z - 0.006) for x, z in reversed(top)]
            H.add(prism(poly, min(y0, y1), max(y0, y1)), M, PAINT)
            lip = top + [(x, z - 0.045) for x, z in reversed(top)]
            H.add(prism(lip, y1 - s * 0.006 if s > 0 else y1, y1 if s > 0 else y1 + 0.006), M, PAINT)
        for x in (-2.4, -1.2, 0.0, 1.2):
            H.add(prism([(0, 0), (0.2, 0), (0, -0.13)], -0.003, 0.003) if False else bm_from([(x, s * 1.40, 1.024), (x, s * 1.62, 1.024), (x, s * 1.40, 0.90), (x + 0.006, s * 1.40, 1.024), (x + 0.006, s * 1.62, 1.024), (x + 0.006, s * 1.40, 0.90)],
                                                                                         [[0, 1, 2], [5, 4, 3], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]]), None, PAINT)
        H.add(box(0.006, 0.24, 0.20, 0.0), T(-3.03, s * 1.52, 0.93), RUBBER)
    # stowage boxes (left fender), fuel cells and a box (right fender)
    for i, x in enumerate((-1.35, -0.45, 1.65)):
        if WRECK and i == 2: continue
        c = Vector((x, 1.525, 1.03 + 0.15))
        H.add(box(0.80, 0.215, 0.30, 0.012), T(*c), PAINT)
        lid = T(x, 1.525 - 0.11, 1.33 + 0.02)
        if WRECK and i == 0: lid = lid @ R('X', 105)
        H.add(box(0.82, 0.235, 0.035, 0.008), lid @ T(0, 0.11, 0), PAINT)
        for dx in (-0.25, 0.25): H.add(cyl(0.016, 0.07, 8, STEEL), T(x + dx - 0.035, 1.415, 1.335) @ R('Y', 90))
        H.add(box(0.06, 0.02, 0.07, 0.004), T(x, 1.637, 1.27), STEEL)
    cells = (-2.25, -1.30, -0.35)
    for i, x in enumerate(cells):
        if WRECK and i == 1: continue
        fuel_cell(H, T(x, -1.525, 1.03 + 0.19))
    H.add(tube([(-2.55, -1.43, 1.38), (-1.30, -1.43, 1.38), (-0.35, -1.43, 1.38), (0.12, -1.43, 1.38), (0.2, -1.40, 1.30)] if not WRECK else [(-2.55, -1.43, 1.38), (-1.74, -1.43, 1.38)], 0.018, 6), None, STEEL)
    H.add(box(0.80, 0.215, 0.30, 0.012), T(1.65, -1.525, 1.18), PAINT)
    H.add(box(0.82, 0.235, 0.035, 0.008), T(1.65, -1.525, 1.35), PAINT)
    # exhaust outlet on the left fender
    H.add(box(0.46, 0.20, 0.17, 0.012), T(-2.30, 1.53, 1.115), PAINT)
    H.add(box(0.38, 0.012, 0.10), T(-2.30, 1.632, 1.115), DARK)
    for k in range(4): H.add(box(0.36, 0.03, 0.008), T(-2.30, 1.628, 1.08 + k * 0.025) @ R('X', 30), PAINT)
    # tow cables along the deck edges, with eyes and clamps
    for s in (-1, 1):
        y = s * 1.335; pts = [(2.0, y, 1.44)]
        for k in range(1, 10):
            x = 2.0 - 4.55 * k / 9; pts.append((x, y + jit(0.004), 1.438 + 0.006 * sin(k * 1.7)))
        H.add(tube(pts, 0.016, 7), None, STEEL)
        for x in (2.06, -2.61):
            H.add(tube([(x + 0.06 * cos(TAU * k / 10) * (1 if x > 0 else -1), y + 0.06 * sin(TAU * k / 10), 1.44) for k in range(10)], 0.013, 5, closed=True), T(0.06 if x > 0 else -0.06, 0, 0), STEEL)
        for x in (1.2, 0.0, -1.3): H.add(box(0.05, 0.06, 0.03, 0.005), T(x, y, 1.445), PAINT)
    # engine deck: centre access plate with bolts, side intake grilles, rear louvres
    H.add(box(1.05, 1.10, 0.022, 0.006), T(-1.22, 0, 1.431), PAINT)
    for k in range(34):
        u = k / 34 * 4.3
        if u < 1.0: p = (-1.72 + u, -0.52)
        elif u < 2.15: p = (-0.72, -0.52 + (u - 1.0))
        elif u < 3.15: p = (-0.72 - (u - 2.15), 0.52)
        else: p = (-1.72, 0.52 - (u - 3.15))
        bolt(H, T(p[0], p[1], 1.442))
    for s in (-1, 1):
        cx, cy = -1.12, s * 1.0
        H.add(box(0.84, 0.50, 0.006), T(cx, cy, 1.423), DARK)
        for dx, dy, sx, sy in ((0, 0.27, 0.9, 0.04), (0, -0.27, 0.9, 0.04), (0.44, 0, 0.04, 0.58), (-0.44, 0, 0.04, 0.58)):
            H.add(box(sx, sy, 0.04, 0.006), T(cx + dx, cy + dy, 1.44), PAINT)
        for k in range(11): H.add(box(0.012, 0.50, 0.012), T(cx - 0.39 + k * 0.078, cy, 1.44), STEEL)
        for k in range(4): H.add(box(0.84, 0.010, 0.010), T(cx, cy - 0.18 + k * 0.12, 1.448), STEEL)
    H.add(box(0.62, 2.46, 0.006), T(-2.23, 0, 1.424), DARK)
    for dx, dy, sx, sy in ((0.33, 0, 0.04, 2.5), (-0.33, 0, 0.04, 2.5), (0, 1.25, 0.7, 0.04), (0, -1.25, 0.7, 0.04), (0, 0, 0.7, 0.04)):
        H.add(box(sx, sy, 0.045, 0.006), T(-2.23 + dx, dy, 1.442), PAINT)
    for k in range(9): H.add(box(0.075, 2.42, 0.007), T(-2.48 + k * 0.064, 0, 1.445) @ R('Y', -35), PAINT)
    for x, y in ((-0.62, 1.25), (-0.62, -1.25), (-2.62, 1.2), (-2.62, -1.2)): eye_ring(H, (x, y, 1.42), 'X', 0.04, 0.011)
    # rear: fuel drums on brackets, unditching beam, tail lights
    for y in (-0.62, 0.62):
        H.add(lathe([(0, -0.43), (0.27, -0.43), (0.29, -0.415), (0.29, -0.15), (0.302, -0.14), (0.302, -0.13), (0.29, -0.12), (0.29, 0.12), (0.302, 0.13), (0.302, 0.14),
                     (0.29, 0.15), (0.29, 0.415), (0.27, 0.43), (0, 0.43)], 24, [PAINT] * 13), T(-3.32, y, 0.98) @ Z2Y)
        H.add(cyl(0.03, 0.02, 8, PAINT), T(-3.32, y + 0.432, 1.12) @ Z2Y)
        for dy in (-0.27, 0.27):
            pts = [(-3.0, y + dy, 1.26)] + [(-3.32 + 0.305 * cos(a), y + dy, 0.98 + 0.305 * sin(a)) for a in np.radians(np.arange(40, -215, -18))]
            H.add(tube(pts, 0.012, 5), None, STEEL)
        H.add(box(0.30, 0.06, 0.06, 0.006), T(-3.12, y, 0.68), PAINT)
    beam = lathe([(0, -1.45), (0.10, -1.45), (0.112, -1.42)] + [(0.112 + 0.004 * sin(k * 2.1), -1.2 + 2.4 * k / 6) for k in range(7)] + [(0.112, 1.42), (0.10, 1.45), (0, 1.45)], 10, [WOOD] * 12)
    H.add(beam, T(-3.14, 0, 1.47) @ Z2Y)
    for y in (-1.0, 1.0):
        H.add(tube([(-3.14 + 0.123 * cos(a), y, 1.47 + 0.123 * sin(a)) for a in np.radians(np.arange(0, 360, 36))], 0.008, 4, closed=True), None, STEEL)
        H.add(box(0.20, 0.05, 0.16, 0.006), T(-3.04, y * 0.95, 1.38), PAINT)
    for y in (-1.25, 1.25): H.add(box(0.03, 0.12, 0.07, 0.005), T(-2.995, y, 1.26), PAINT); H.add(box(0.006, 0.09, 0.045), T(-3.012, y, 1.26), LENS)
    # running-gear mounts: hubs, torsion arms, bump stops, final drives, idler cranks
    for s in (-1, 1):
        for x in WX:
            H.add(cyl(0.09, 0.10, 12, PAINT), T(x, s * 1.03, WZ) @ R('X', -90 * s))
            H.add(box(0.36, 0.05, 0.10, 0.01), T(x + 0.16, s * 1.07, WZ - 0.05) @ R('Y', 16), PAINT)
            H.add(box(0.10, 0.10, 0.05, 0.008), T(x - 0.24, s * 1.12, 0.985), PAINT)
        H.add(lathe([(0, 0), (0.25, 0), (0.25, 0.06), (0.20, 0.10), (0, 0.10)], 20, [PAINT] * 4), T(SPR[0], s * 1.03, SPR[1]) @ R('X', -90 * s))
        H.add(box(0.34, 0.06, 0.12, 0.01), T(2.47, s * 1.07, 0.60) @ R('Y', 30), PAINT)
        H.add(cyl(0.07, 0.10, 12, PAINT), T(IDL[0], s * 1.03, IDL[1]) @ R('X', -90 * s))
    return H


def fuel_cell(P, M):
    P.add(box(0.88, 0.215, 0.38, 0.035, 3), M, PAINT)
    P.add(lathe([(0, 0), (0.045, 0), (0.045, 0.03), (0.03, 0.04), (0, 0.04)], 10, [STEEL] * 4), M @ T(0.25, 0, 0.19))
    for dx in (-0.28, 0.28):
        P.add(box(0.04, 0.235, 0.012, 0.003), M @ T(dx, 0, 0.196), STEEL)
        P.add(box(0.04, 0.012, 0.36, 0.003), M @ T(dx, 0.113 * (-1 if M.to_translation().y < -0.5 or M.to_translation().y > 0 and False else 1), 0), STEEL)


def build_driver_hatch(P):
    P.add(lathe([(0, 0), (0.255, 0), (0.255, 0.03), (0.23, 0.045), (0, 0.05)], 24, [PAINT] * 4), T(1.90, 0.62, 1.445))
    P.add(tube([(1.80, 0.62, 1.49), (1.80, 0.62, 1.53), (2.0, 0.62, 1.53), (2.0, 0.62, 1.49)], 0.01, 5), None, STEEL)
    P.add(box(0.12, 0.08, 0.05, 0.008), T(1.90, 0.62 + 0.27, 1.46), PAINT)


# ---------------------------------------------------------------- turret (local: origin on the ring, +X forward)
TA, TB, HT = 0.78, 0.62, 0.86


def RT(th):
    return 1.165 - 0.035 * cos(th) + 0.02 * cos(2 * th)


def dome_z(x, y):
    th = math.atan2(y, x); d = math.hypot(x, y); c = min(1.0, (d / RT(th)) ** (1 / TA))
    return HT * math.sin(math.acos(c)) ** TB


def dome_r(th, z):
    s = min(1.0, max(0.0, z / HT)) ** (1 / TB)
    return RT(th) * math.cos(math.asin(s)) ** TA


CUP = (-0.22, 0.46); LDR = (-0.15, -0.47)


def build_turret(P):
    NT = 80; phis = [0, 0.03, 0.07, 0.12, 0.18, 0.25, 0.33, 0.42, 0.52, 0.63, 0.75, 0.88, 1.01, 1.15, 1.28, 1.40, 1.49]
    V, F = [], []
    for i in range(NT):
        th = TAU * i / NT; Rb = RT(th)
        V.append((Rb * 0.985 * cos(th), Rb * 0.985 * sin(th), -0.03))
        for j, ph in enumerate(phis):
            w = 1 + 0.005 * sin(3 * th + 1.3) * sin(4 * ph + 0.5) + 0.003 * sin(7 * th + 2 * ph)
            r = Rb * math.cos(ph) ** TA * w; z = HT * math.sin(ph) ** TB
            V.append((r * cos(th), r * sin(th), z))
    m = len(phis) + 1; top = len(V); V.append((0, 0, HT)); bot = len(V); V.append((0, 0, -0.03))
    for i in range(NT):
        a, b = i * m, ((i + 1) % NT) * m
        for j in range(m - 1): F.append([a + j, b + j, b + j + 1, a + j + 1])
        F.append([a + m - 1, b + m - 1, top]); F.append([b, a, bot])
    P.add(bm_from(V, F), None, CAST)
    # canvas boot round the gun, cast lifting eyes, penetration in the wreck
    boot = lathe([(0.39, 0.0), (0.37, 0.07), (0.33, 0.15), (0.31, 0.22)], 28, [CANVAS] * 3, rfun=lambda a, k: 1 + 0.035 * sin(7 * a + k) * (0 < k < 3))
    P.add(boot, T(*GUNP) @ T(0.13, 0, 0) @ Z2X)
    for th in (rad(60), rad(-60), rad(180)):
        z = 0.62; r = dome_r(th, z)
        eye_ring(P, (r * cos(th) * 0.97, r * sin(th) * 0.97, z + 0.02), 'X', 0.04, 0.012)
    if WRECK:
        th, z = rad(-58), 0.36; r = dome_r(th, z); c = Vector((r * cos(th), r * sin(th), z))
        M = basis(Vector((-sin(th), cos(th), 0)), Vector((0, 0, 1)), Vector((cos(th), sin(th), 0)), c)
        P.add(lathe([(0, -0.02), (0.05, -0.02), (0.065, 0.004), (0.075, 0.012), (0.09, 0.004), (0.1, -0.01)], 14, [DARK, DARK, CAST, CAST, CAST]), M)
    # commander's cupola with vision blocks and searchlight
    cx, cy = CUP; z0 = dome_z(cx, cy) - 0.03
    P.add(lathe([(0, z0 - 0.05), (0.37, z0 - 0.05), (0.37, z0 + 0.06), (0.345, z0 + 0.16), (0.30, z0 + 0.175), (0.28, z0 + 0.14), (0, z0 + 0.14)], 32, [CAST, CAST, CAST, CAST, CAST, DARK]), T(cx, cy, 0))
    for a in (-75, -40, 0, 40, 75):
        M = T(cx, cy, z0 + 0.09) @ R('Z', a) @ T(0.36, 0, 0)
        P.add(box(0.07, 0.12, 0.07, 0.008), M, CAST); P.add(box(0.01, 0.10, 0.045), M @ T(0.036, 0, 0), GLASS)
    sl = T(cx + 0.18, cy + 0.33, z0 + 0.24)
    P.add(lathe([(0, -0.09), (0.05, -0.09), (0.085, -0.03), (0.085, 0.08), (0.09, 0.09), (0, 0.092)], 16, [PAINT, PAINT, PAINT, PAINT, LENS]), sl @ Z2X)
    P.add(box(0.05, 0.05, 0.16, 0.006), sl @ T(0, 0, -0.12), PAINT)
    # gunner's sight hood, ventilator, loader's hatch ring, AA machine gun
    gx, gy = 0.55, 0.40; gz = dome_z(gx, gy) - 0.02
    P.add(prism([(-0.12, 0), (0.12, 0), (0.07, 0.13), (-0.12, 0.13)], -0.09, 0.09, 0.01), T(gx, gy, gz), CAST)
    P.add(box(0.012, 0.14, 0.08), T(gx + 0.095, gy, gz + 0.065) @ R('Y', -21), GLASS)
    vx, vy = 0.42, -0.22
    P.add(lathe([(0, 0), (0.14, 0), (0.14, 0.04), (0.11, 0.08), (0.05, 0.1), (0, 0.1)], 18, [CAST] * 5), T(vx, vy, dome_z(vx, vy) - 0.03))
    lx, ly = LDR; z1 = dome_z(lx, ly) - 0.03
    P.add(lathe([(0, z1 - 0.04), (0.35, z1 - 0.04), (0.35, z1 + 0.04), (0.31, z1 + 0.05), (0.29, z1 + 0.03), (0, z1 + 0.03)], 32, [CAST, CAST, CAST, CAST, DARK]), T(lx, ly, 0))
    pin = Vector((lx - 0.37, ly, z1 + 0.04))
    P.add(cyl(0.035, 0.34, 10, GUNM), T(*pin))
    MG = T(pin.x, pin.y, pin.z + 0.38) @ (R('Z', 40) @ R('Y', 18) if WRECK else R('Z', 8) @ R('Y', -9))
    P.add(box(0.46, 0.09, 0.13, 0.008), MG @ T(0.05, 0, 0), GUNM)
    P.add(box(0.26, 0.10, 0.03, 0.005), MG @ T(0.08, 0, 0.075), GUNM)
    P.add(lathe([(0, 0), (0.024, 0), (0.024, 0.86), (0.035, 0.87), (0.035, 0.96), (0.012, 0.97), (0, 0.97)], 10, [GUNM] * 6), MG @ T(0.28, 0, 0.0) @ Z2X)
    for k in range(5): P.add(cyl(0.036, 0.022, 10, GUNM), MG @ T(0.36 + k * 0.05, 0, 0) @ Z2X)
    P.add(box(0.22, 0.13, 0.20, 0.01), MG @ T(0.05, 0.13, -0.04), PAINT)
    P.add(tube([(-0.18, 0.07, 0.0), (-0.28, 0.07, 0.0), (-0.28, -0.07, 0.0), (-0.18, -0.07, 0.0)], 0.014, 6), MG, GUNM)
    P.add(box(0.03, 0.01, 0.06), MG @ T(0.6, 0, 0.06), GUNM)
    # grab rails, antenna, snorkel tube on the rear
    def rail(t0, t1, z, n=9):
        pts = []
        for k in range(n):
            th = rad(t0 + (t1 - t0) * k / (n - 1)); r = dome_r(th, z) + (0.0 if k in (0, n - 1) else 0.065)
            pts.append((r * cos(th), r * sin(th), z))
        P.add(tube(pts, 0.014, 6), None, STEEL)
    rail(68, 118, 0.42); rail(-118, -68, 0.42); rail(150, 210, 0.66)
    th = rad(145); r = dome_r(th, 0.55) - 0.02; ab = Vector((r * cos(th), r * sin(th), 0.55))
    P.add(lathe([(0, 0), (0.05, 0), (0.05, 0.05), (0.03, 0.12), (0, 0.13)], 12, [GUNM] * 4), T(*ab))
    L = 0.45 if WRECK else 2.35
    P.add(tube([ab + Vector((-0.02 * (k / 5) ** 2 * L, 0, 0.12 + L * k / 5)) for k in range(6)], [0.007 - 0.004 * k / 5 for k in range(6)], 4), None, GUNM)
    sx = -dome_r(PI, 0.30) - 0.16
    P.add(lathe([(0, -0.78), (0.15, -0.78), (0.16, -0.75), (0.16, 0.75), (0.15, 0.78), (0, 0.78)], 18, [PAINT] * 5), T(sx, 0, 0.30) @ Z2Y)
    for y in (-0.45, 0.45):
        P.add(tube([(sx + 0.17 * cos(a), y, 0.30 + 0.17 * sin(a)) for a in np.radians(np.arange(0, 360, 36))], 0.01, 4, closed=True), None, STEEL)
        P.add(box(0.16, 0.05, 0.05, 0.006), T(sx + 0.13, y, 0.30), PAINT)


def build_cmd_hatch(P):
    cx, cy = CUP; z0 = dome_z(cx, cy) - 0.03
    # armour lid 7-9 cm thick: domed top, square rim, an inner face with a seal ring, locking handle and hinge arms
    P.add(lathe([(0, -0.045), (0.21, -0.045), (0.235, -0.03), (0.27, -0.03), (0.27, 0.0), (0.31, 0.0), (0.31, 0.045), (0.25, 0.075), (0.10, 0.09), (0, 0.093)], 28,
                [STEEL, STEEL, RUBBER, CAST, CAST, CAST, CAST, CAST, CAST]), T(cx, cy, z0 + 0.175))
    P.add(cyl(0.04, 0.24, 12, STEEL), T(cx - 0.33, cy - 0.12, z0 + 0.19) @ Z2Y)
    for dy in (-0.075, 0.075):
        P.add(box(0.16, 0.045, 0.045, 0.006), T(cx - 0.27, cy + dy, z0 + 0.20), CAST)
    P.add(box(0.10, 0.10, 0.03, 0.006), T(cx - 0.25, cy, z0 + 0.25), CAST)
    P.add(tube([(cx + 0.05, cy - 0.08, z0 + 0.25), (cx + 0.05, cy - 0.08, z0 + 0.29), (cx + 0.05, cy + 0.08, z0 + 0.29), (cx + 0.05, cy + 0.08, z0 + 0.25)], 0.012, 5), None, STEEL)
    P.add(tube([(cx + 0.02, cy - 0.1, z0 + 0.13), (cx + 0.02, cy - 0.1, z0 + 0.09), (cx + 0.02, cy + 0.1, z0 + 0.09), (cx + 0.02, cy + 0.1, z0 + 0.13)], 0.013, 5), None, STEEL)
    P.add(box(0.05, 0.22, 0.025, 0.004), T(cx + 0.14, cy, z0 + 0.12), STEEL)


def build_ldr_hatch(P):
    lx, ly = LDR; z1 = dome_z(lx, ly) - 0.03
    P.add(lathe([(0, -0.04), (0.20, -0.04), (0.225, -0.025), (0.26, -0.025), (0.26, 0.0), (0.30, 0.0), (0.30, 0.045), (0.26, 0.065), (0, 0.07)], 28,
                [STEEL, STEEL, RUBBER, CAST, CAST, CAST, CAST, CAST]), T(lx, ly, z1 + 0.04))
    P.add(cyl(0.04, 0.26, 12, STEEL), T(lx + 0.32, ly - 0.13, z1 + 0.06) @ Z2Y)
    for dy in (-0.08, 0.08):
        P.add(box(0.15, 0.045, 0.045, 0.006), T(lx + 0.26, ly + dy, z1 + 0.075), CAST)
    P.add(tube([(lx - 0.1, ly - 0.08, z1 + 0.11), (lx - 0.1, ly - 0.08, z1 + 0.15), (lx - 0.1, ly + 0.08, z1 + 0.15), (lx - 0.1, ly + 0.08, z1 + 0.11)], 0.012, 5), None, STEEL)
    P.add(tube([(lx - 0.02, ly - 0.1, z1 + 0.0), (lx - 0.02, ly - 0.1, z1 - 0.04), (lx - 0.02, ly + 0.1, z1 - 0.04), (lx - 0.02, ly + 0.1, z1 + 0.0)], 0.013, 5), None, STEEL)


# ---------------------------------------------------------------- gun (local: trunnions, barrel along +X)
def build_gun(P):
    P.add(lathe([(0, 0.10), (0.31, 0.10), (0.31, 0.30), (0.28, 0.46), (0.21, 0.57), (0.16, 0.60), (0, 0.60)], 36, [CAST] * 6), Z2X)
    P.add(lathe([(0, 0), (0.03, 0), (0.03, 0.10), (0.018, 0.10), (0.018, 0.04), (0, 0.04)], 10, [GUNM, GUNM, GUNM, DARK, DARK]), T(0.40, -0.19, 0.02) @ Z2X)
    P.add(box(0.12, 0.06, 0.08, 0.008), T(0.38, 0.24, 0.13), CAST)
    sl = T(0.38, -0.40, 0.30)
    P.add(lathe([(0, -0.02), (0.11, -0.02), (0.165, 0.05), (0.17, 0.27), (0.18, 0.29), (0.16, 0.30), (0, 0.302)], 22, [PAINT, PAINT, PAINT, PAINT, PAINT, GLASS]), sl @ Z2X)
    P.add(box(0.08, 0.30, 0.04, 0.008), T(0.48, -0.25, 0.14), PAINT)
    P.add(box(0.06, 0.05, 0.16, 0.006), T(0.48, -0.40, 0.17), PAINT)
    P.add(tube([(0.22, -0.40, 0.48), (0.22, -0.40, 0.52), (0.42, -0.40, 0.52), (0.42, -0.40, 0.48)], 0.012, 5), None, STEEL)


def build_barrel(P):
    prof = [(0, 0.55), (0.105, 0.55), (0.105, 0.62), (0.097, 0.70), (0.091, 1.3), (0.086, 2.1), (0.082, 3.04), (0.118, 3.13), (0.125, 3.22), (0.125, 3.50),
            (0.118, 3.57), (0.081, 3.66), (0.079, 4.16), (0.087, 4.19), (0.087, 4.28), (0.083, 4.30), (0.05, 4.30), (0.05, 4.0), (0, 4.0)]
    P.add(lathe(prof, 32, [PAINT] * 15 + [DARK] * 3), Z2X)
    for x in (3.14, 3.55): P.add(lathe([(0.123, -0.012), (0.131, -0.012), (0.131, 0.012), (0.123, 0.012)], 32, [PAINT] * 4, closed=True), T(x, 0, 0) @ Z2X)


# ---------------------------------------------------------------- running gear (local: hub, axle along Y, outer face +Y)
def build_wheel(P):
    prof = [(0, 0.075), (0.10, 0.075), (0.30, 0.06), (0.335, 0.05), (0.36, 0.045), (0.398, 0.045), (0.413, 0.06), (0.418, 0.10), (0.418, 0.185), (0.413, 0.215), (0.398, 0.23),
            (0.36, 0.23), (0.34, 0.222), (0.325, 0.21), (0.29, 0.20), (0.14, 0.225), (0.10, 0.24), (0.085, 0.25), (0.08, 0.275), (0.06, 0.285), (0, 0.29)]
    mats = [PAINT] * 3 + [RUBBER] * 8 + [PAINT] * 9
    P.add(lathe(prof, 26, mats), Z2Y)
    inner = [(0, -0.26), (0.09, -0.26), (0.12, -0.225), (0.30, -0.20), (0.34, -0.222), (0.36, -0.23), (0.40, -0.23), (0.418, -0.20), (0.418, -0.075), (0.40, -0.045), (0.36, -0.045), (0.30, -0.06), (0.10, -0.075), (0, -0.075)]
    P.add(lathe(inner, 26, [PAINT] * 5 + [RUBBER] * 5 + [PAINT] * 3), Z2Y)
    for k in range(6):
        a = 360 * k / 6 + 15
        P.add(box(0.16, 0.032, 0.026, 0.006), Z2Y @ R('Z', a) @ T(0.215, 0, 0.222) @ R('Y', 7), PAINT)
    for k in range(6):
        a = TAU * k / 6
        bolt(P, Z2Y @ T(0.052 * cos(a), 0.052 * sin(a), 0.283), 0.011)


def build_sprocket(P):
    P.add(lathe([(0, -0.20), (0.10, -0.20), (0.14, -0.16), (0.26, -0.14), (0.29, -0.10), (0.29, 0.10), (0.26, 0.14), (0.14, 0.16), (0.10, 0.22), (0.06, 0.25), (0, 0.25)], 30, [PAINT] * 10), Z2Y)
    n = 13; outer, inner = [], []
    for j in range(n):
        a0 = TAU * j / n; al = TAU / n
        for f, r in ((0.0, 0.30), (0.26, 0.30), (0.40, 0.375), (0.60, 0.375), (0.74, 0.30)):
            outer.append((r * cos(a0 + f * al), r * sin(a0 + f * al)))
    for (x, y) in outer:
        a = math.atan2(y, x); inner.append((0.235 * cos(a), 0.235 * sin(a)))
    for h0, h1 in ((0.07, 0.125), (-0.125, -0.07)):
        m = len(outer); V = [(x, y, h0) for x, y in outer] + [(x, y, h1) for x, y in outer] + [(x, y, h0) for x, y in inner] + [(x, y, h1) for x, y in inner]
        F = []
        for i in range(m):
            k = (i + 1) % m
            F += [[i, k, m + k, m + i], [2 * m + k, 2 * m + i, 3 * m + i, 3 * m + k], [m + i, m + k, 3 * m + k, 3 * m + i], [k, i, 2 * m + i, 2 * m + k]]
        P.add(bm_from(V, F), Z2Y, PAINT)
    for k in range(10):
        a = TAU * k / 10
        bolt(P, Z2Y @ T(0.19 * cos(a), 0.19 * sin(a), 0.155), 0.012)


def build_idler(P):
    prof = [(0, -0.24), (0.08, -0.24), (0.12, -0.20), (0.27, -0.19), (0.30, -0.21), (0.305, -0.20), (0.305, -0.05), (0.29, -0.045), (0.26, -0.06), (0.26, 0.06), (0.29, 0.045),
            (0.305, 0.05), (0.305, 0.20), (0.30, 0.21), (0.27, 0.19), (0.12, 0.20), (0.08, 0.24), (0, 0.24)]
    P.add(lathe(prof, 28, [PAINT] * 17), Z2Y)
    for k in range(6):
        a = 360 * k / 6
        P.add(box(0.13, 0.03, 0.022, 0.005), Z2Y @ R('Z', a) @ T(0.19, 0, 0.198), PAINT)


def build_link(P):
    P.add(box(0.122, 0.58, 0.05, 0.008), None, TRACK)
    P.add(box(0.034, 0.50, 0.022), T(0.02, 0, 0.036), TRACK)
    for x, ys in ((0.062, ((-0.29, -0.13), (0.13, 0.29))), (-0.062, ((-0.12, 0.12),))):
        for a, b in ys: P.add(cyl(0.024, b - a, 6, TRACK), T(x, a, 0) @ R('X', -90))
    P.add(prism([(-0.05, -0.02), (0.05, -0.02), (0.022, -0.13), (-0.022, -0.13)], -0.03, 0.03), None, TRACK)


# ---------------------------------------------------------------- track path
def hull2d(pts):
    pts = sorted(set(pts))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]          # counter-clockwise


def track_path():
    C = [(IDL[0], IDL[1], IDL[2] + LK_OFF)] + [(x, WZ, WR + LK_OFF) for x in WX] + [(SPR[0], SPR[1], SPR[2] + LK_OFF)]
    pts = [(round(cx + r * cos(TAU * k / 720), 5), round(cz + r * sin(TAU * k / 720), 5)) for cx, cz, r in C for k in range(720)]
    h = hull2d(pts)[::-1]                                              # clockwise: bottom run goes rearwards
    xs, xi = SPR[0], IDL[0]
    keep = [p for p in h if not (xs < p[0] < xi and p[1] > 0.6)]
    gap = max(range(len(keep)), key=lambda i: abs(keep[(i + 1) % len(keep)][0] - keep[i][0]))
    keep = keep[gap + 1:] + keep[:gap + 1]                             # idler top ... sprocket top
    sup = [(xs, SPR[1] + SPR[2] + LK_OFF)] + sorted([(x, WZ + WR + LK_OFF) for x in WX]) + [(xi, IDL[1] + IDL[2] + LK_OFF)]
    top = []
    for x in np.arange(xs + 0.01, xi - 0.005, 0.01):
        for (a, za), (b, zb) in zip(sup, sup[1:]):
            if a <= x <= b:
                t = (x - a) / (b - a); z = za + (zb - za) * t - (0.012 + 0.016 * (b - a)) * sin(PI * t); break
        for cx, cz, r in C:
            if abs(x - cx) < r: z = max(z, cz + math.sqrt(r * r - (x - cx) ** 2))
        top.append((x, z))
    loop = np.array(keep + top, float)
    seg = np.linalg.norm(np.roll(loop, -1, 0) - loop, axis=1); s = np.concatenate([[0], np.cumsum(seg)]); L = s[-1]
    M = int(round(L / 0.01)); ss = np.arange(M) * L / M
    lp = np.vstack([loop, loop[:1]])
    P = np.stack([np.interp(ss, s, lp[:, 0]), np.interp(ss, s, lp[:, 1])], 1)
    i0 = int(np.argmax(P[:, 0] - 10 * np.abs(P[:, 1] - P[:, 1].min()) * (P[:, 1] > 0.3)))   # start at the front of the bottom run
    i0 = int(np.argmin(np.abs(P[:, 0] - IDL[0]) + 10 * (P[:, 1] > 0.3)))
    P = np.roll(P, -i0, 0)
    return P, L


def path_at(P, L, a):
    M = len(P); f = (a % L) / L * M; i = int(f) % M; t = f - int(f)
    return P[i] * (1 - t) + P[(i + 1) % M] * t


def link_mats(P, L, y):
    N = int(round(L / 0.137)); p = L / N; out = []
    for k in range(N):
        a = path_at(P, L, k * p); b = path_at(P, L, k * p + p); c = (a + b) / 2; t = (b - a) / np.linalg.norm(b - a)
        X = Vector((t[0], 0, t[1])); Z = Vector((-t[1], 0, t[0]))
        out.append(basis(X, Vector((0, 1, 0)), Z, Vector((c[0], y, c[1]))))
    return out, N, p


def thrown_mats():
    out = []; p = 0.137; x = -2.85
    pos = lambda x: Vector((x, -1.40 - 0.75 * (lambda t: t * t * (3 - 2 * t))(min(1, max(0, (x + 2.0) / 5.6))) - 0.08 * sin(1.3 * x), 0.045))
    k = 0
    while x < 3.45:
        a, b = pos(x), pos(x + p); t = (b - a).normalized(); c = (a + b) / 2
        c.z += 0.006 * sin(k * 2.3); X = t; Z = Vector((0, 0, -1)); Y = Z.cross(X)
        out.append(basis(X, Y, Z, c) @ R('Z', jit(2.5)) @ R('X', jit(1.5))); x += p * (b - a).length / p * 1.0 if False else p; k += 1
    # the broken end curls up and back over itself
    c = out[-1].to_translation(); t = (pos(3.45) - pos(3.3)).normalized(); up = Vector((0, 0, 1)); prev = c
    for j in range(1, 6):
        ph = rad(28 * j); tj = t * cos(ph) + up * sin(ph); nj = t * sin(ph) - up * cos(ph)
        cj = prev + (t * cos(rad(28 * j - 14)) + up * sin(rad(28 * j - 14))) * p
        out.append(basis(tj, nj.cross(tj), nj, cj)); prev = cj
    for x, y, yaw in ((4.05, -2.55, 47), (4.35, -2.2, -18)):
        out.append(T(x, y, 0.045) @ R('Z', yaw) @ R('X', 180) @ R('X', 0))
    return out


# ---------------------------------------------------------------- scene objects
def make_obj(part, parent=None, mesh=None):
    if mesh is None:
        mesh = bpy.data.meshes.new(part.name); mesh.from_pydata(part.v, [], part.f)
        set_mid(mesh, part.m)
    ob = bpy.data.objects.new(part.name, mesh); bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    ob.location = part.origin - (parent_world_origin(parent))
    return ob


def set_mid(me, m):
    m = np.asarray(m, np.int32); a = me.attributes.get('mid') or me.attributes.new('mid', 'INT', 'FACE')
    a.data.foreach_set('value', m); me.polygons.foreach_set('material_index', m); me.update()


def get_mid(me):
    a = me.attributes['mid']; m = np.empty(len(me.polygons), np.int32); a.data.foreach_get('value', m); return m


def parent_world_origin(p):
    return Vector(p['origin']) if p is not None and 'origin' in p else Vector((0, 0, 0))


def empty(name, loc, parent=None):
    ob = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent; ob.location = Vector(loc) - parent_world_origin(parent); ob['origin'] = tuple(loc)
    ob.empty_display_size = 0.2
    return ob


def shade(ob, ang=50):
    me = ob.data
    if me.get('shaded'): pass
    else:
        me.shade_smooth()
        try: me.set_sharp_from_angle(angle=rad(ang))
        except Exception as e: log('sharp-from-angle unavailable', e)
        me['shaded'] = 1
    m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); m.keep_sharp = True; m.weight = 50


def mesh_from_mats(name, src, mats):
    sv = np.array([v.co[:] for v in src.vertices], float); nv = len(sv)
    faces = [list(p.vertices) for p in src.polygons]; fm = get_mid(src).tolist()
    V, F, FM = [], [], []
    for i, M in enumerate(mats):
        A = np.array(M); V.append(sv @ A[:3, :3].T + A[:3, 3]); F += [[j + i * nv for j in f] for f in faces]; FM += fm
    me = bpy.data.meshes.new(name); me.from_pydata(np.vstack(V).tolist(), [], F)
    set_mid(me, FM)
    uv0 = np.empty(len(src.loops) * 2, np.float32); src.uv_layers.active.data.foreach_get('uv', uv0)
    me.uv_layers.new(name='UVMap'); me.uv_layers.active.data.foreach_set('uv', np.tile(uv0, len(mats))); me.update()
    return me


def mirror_mesh(me, name):
    m2 = me.copy(); m2.name = name; bm = bmesh.new(); bm.from_mesh(m2)
    for v in bm.verts: v.co.y = -v.co.y
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:]); bm.to_mesh(m2); bm.free(); m2.update()
    return m2


def opkw(op, **kw):
    try: names = set(op.get_rna_type().properties.keys())
    except Exception: return kw
    return {k: v for k, v in kw.items() if k in names}


def select(objs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def smart_uv(objs, margin=0.003):
    select(objs); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(**opkw(bpy.ops.uv.smart_project, angle_limit=rad(62), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False, margin_method='SCALED'))
    bpy.ops.object.mode_set(mode='OBJECT')


def uv_quadrant(me, ox, oy, s=0.5):
    uv = np.empty(len(me.loops) * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2); uv = uv * s + np.array([ox, oy], np.float32); me.uv_layers.active.data.foreach_set('uv', uv.ravel())


# ---------------------------------------------------------------- bakes
def id_materials():
    mats = []
    for i in range(NID):
        m = bpy.data.materials.new('id_%d' % i)
        try: m.use_nodes = True
        except Exception: pass
        mats.append(m)
    return mats


def set_pass(mats, kind, img):
    for i, m in enumerate(mats):
        nt = m.node_tree; nt.nodes.clear(); N = nt.nodes.new; L = nt.links.new
        out = N('ShaderNodeOutputMaterial'); em = N('ShaderNodeEmission'); L(em.outputs[0], out.inputs['Surface'])
        tex = N('ShaderNodeTexImage'); tex.image = img; nt.nodes.active = tex; tex.select = True
        geo = N('ShaderNodeNewGeometry')
        if kind == 'ID': em.inputs['Color'].default_value = (i / 16.0, 0, 0, 1)
        elif kind in ('POS', 'NRM'):
            vm = N('ShaderNodeVectorMath'); vm.operation = 'MULTIPLY_ADD'
            vm.inputs[1].default_value = (0.1, 0.1, 0.1) if kind == 'POS' else (0.5, 0.5, 0.5); vm.inputs[2].default_value = (0.5, 0.5, 0.5)
            L(geo.outputs['Position' if kind == 'POS' else 'True Normal'], vm.inputs[0]); L(vm.outputs[0], em.inputs['Color'])
        elif kind == 'EDGE':
            bv = N('ShaderNodeBevel'); bv.inputs['Radius'].default_value = 0.02; bv.samples = 8
            dt = N('ShaderNodeVectorMath'); dt.operation = 'DOT_PRODUCT'
            L(bv.outputs['Normal'], dt.inputs[0]); L(geo.outputs['True Normal'], dt.inputs[1]); L(dt.outputs['Value'], em.inputs['Color'])


def bake(mats, objs, kind, size, samples):
    img = bpy.data.images.new('bake_%s_%d' % (kind, size), size, size, float_buffer=True, alpha=True)
    set_pass(mats, kind, img); sc = bpy.context.scene
    sc.cycles.samples = samples; sc.render.bake.margin = 6; sc.render.bake.use_clear = True
    try: sc.render.bake.margin_type = 'EXTEND'
    except Exception: pass
    select(objs); t = time.time()
    bpy.ops.object.bake(type='AO' if kind == 'AO' else 'EMIT')
    px = np.empty(size * size * 4, np.float32); img.pixels.foreach_get(px)
    log('baked %-4s %4d px %5.1fs  max %.3f alpha>0 %.3f' % (kind, size, time.time() - t, px.reshape(-1, 4)[:, :3].max(), (px.reshape(-1, 4)[:, 3] > 0).mean()))
    return px.reshape(size, size, 4)


# ---------------------------------------------------------------- texture synthesis (numpy)
def _hash(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 1274126177 + seed * 2246822519) & 0xffffffff
    h = ((h ^ (h >> 13)) * 3266489917) & 0xffffffff
    return ((h ^ (h >> 16)) & 0xffff).astype(np.float32) / 65535.0


def vnoise(p, seed):
    i = np.floor(p); t = (p - i).astype(np.float32); i = i.astype(np.int64); u = t * t * (3 - 2 * t)
    x0, y0, z0 = i[:, 0], i[:, 1], i[:, 2]; x1, y1, z1 = x0 + 1, y0 + 1, z0 + 1
    l = lambda a, b, w: a + (b - a) * w
    a = l(_hash(x0, y0, z0, seed), _hash(x1, y0, z0, seed), u[:, 0]); b = l(_hash(x0, y1, z0, seed), _hash(x1, y1, z0, seed), u[:, 0])
    c = l(_hash(x0, y0, z1, seed), _hash(x1, y0, z1, seed), u[:, 0]); d = l(_hash(x0, y1, z1, seed), _hash(x1, y1, z1, seed), u[:, 0])
    return l(l(a, b, u[:, 1]), l(c, d, u[:, 1]), u[:, 2])


def fbm(p, f, octv=4, seed=0, scale=(1, 1, 1)):
    q = p * np.array(scale, np.float32) * f; s = np.zeros(len(p), np.float32); a = 0.5; tot = 0
    for o in range(octv):
        s += a * vnoise(q + o * 17.31, seed * 31 + o); tot += a; a *= 0.5; q = q * 2.03
    return s / tot


def lin(*c):
    return np.array(c, np.float32) ** 2.2


def cl(x, a=0.0, b=1.0):
    return np.clip(x, a, b)


def mix(a, b, t):
    t = t[:, None] if np.ndim(t) == 1 else t
    return a + (b - a) * t


def compose(mid, P, Nw, E, AO, gear):
    n = len(mid); up = cl(Nw[:, 2]); z = P[:, 2]
    nlo, nmd, nhi = fbm(P, 0.55, 3, 1), fbm(P, 2.6, 4, 2), fbm(P, 16, 3, 3)
    nch = fbm(P, 8, 4, 4); stk = fbm(P, 1.0, 3, 5, (7, 7, 0.55))
    col = np.zeros((n, 3), np.float32); rough = np.full(n, 0.7, np.float32); metal = np.zeros(n, np.float32); hgt = np.zeros(n, np.float32)
    isp = (mid == PAINT) | (mid == CAST)
    if not WRECK:
        base = lin(0.215, 0.228, 0.15) * (0.84 + 0.32 * nlo)[:, None] * (0.93 + 0.14 * nmd)[:, None]
        base = mix(base, lin(0.24, 0.23, 0.155), cl((nlo - 0.45) * 2) * 0.5)
        base = mix(base, lin(0.33, 0.33, 0.27), 0.3 * up * nlo)
        base *= (1 - 0.22 * (1 - up) * cl((stk - 0.56) * 3))[:, None]
        col[:] = base; rough[:] = 0.6 + 0.14 * nmd
        hgt += 0.15 * fbm(P, 70, 2, 6)
        cast = mid == CAST
        hgt[cast] += 0.22 * fbm(P[cast], 24, 3, 7) + 0.1 * fbm(P[cast], 60, 2, 8)
        chip = cl((E * 1.5 + (nch - 0.5) * 1.2 - 0.62) * 5) + cl((nhi - 0.83) * 8) * 0.5 * (1 - up)
        chip = cl(chip) * isp
        col = mix(col, lin(0.17, 0.16, 0.15) * (0.8 + 0.4 * nhi)[:, None], chip); metal = np.maximum(metal, chip * 0.85); rough = rough + (0.38 - rough) * chip; hgt -= 0.35 * chip
        st = mid == STEEL
        sc = lin(0.2, 0.19, 0.18) * (0.8 + 0.4 * nmd[st])[:, None]; ru = cl((nmd[st] - 0.55) * 3)
        col[st] = mix(sc, lin(0.30, 0.16, 0.08), ru); metal[st] = 0.85 * (1 - ru); rough[st] = 0.48 + 0.35 * ru
        gm = mid == GUNM
        col[gm] = mix(np.tile(lin(0.075, 0.075, 0.08), (gm.sum(), 1)), lin(0.32, 0.32, 0.33), cl(E[gm] * 1.5)); metal[gm] = 0.75; rough[gm] = 0.42
        rb = mid == RUBBER
        col[rb] = lin(0.05, 0.05, 0.05) * (0.85 + 0.3 * nhi[rb])[:, None]; col[rb] = mix(col[rb], lin(0.13, 0.13, 0.12), cl(E[rb] * 1.3) * 0.7); rough[rb] = 0.9; metal[rb] = 0
        hgt[rb] += 0.4 * fbm(P[rb], 40, 2, 9)
        tr = mid == TRACK
        tc = lin(0.13, 0.11, 0.095) * (0.8 + 0.4 * nmd[tr])[:, None]; tc = mix(tc, lin(0.27, 0.14, 0.075), cl((nmd[tr] - 0.5) * 2.5) * 0.8)
        worn = cl(cl((Nw[tr, 2] - 0.6) * 4) * (0.6 + 0.4 * nhi[tr]) + cl(E[tr] * 1.3 - 0.2) + 0.5 * cl((-Nw[tr, 2] - 0.6) * 4) * nhi[tr])
        col[tr] = mix(tc, lin(0.44, 0.43, 0.41) * (0.85 + 0.3 * nhi[tr])[:, None], worn); metal[tr] = 0.4 + 0.6 * worn; rough[tr] = 0.8 - 0.45 * worn
        hgt[tr] += 0.5 * fbm(P[tr], 50, 2, 10)
    else:
        # burnt-out armour: mostly dark brown-red oxide and soot, grey-white ash, heat-greyed patches where the paint
        # burnt off, a little blistered paint left low down, orange only in fresh runs. Varied at large and small scale.
        nvl = fbm(P, 0.7, 3, 23); nsp = fbm(P, 9.0, 3, 24)
        rust = mix(lin(0.040, 0.024, 0.017), lin(0.080, 0.042, 0.025), nmd)
        rust = mix(rust, lin(0.026, 0.020, 0.017), cl((nvl - 0.45) * 3) * 0.75)                  # large dark zones
        rust = mix(rust, lin(0.11, 0.055, 0.030), cl((nsp - 0.62) * 4) * 0.5)                     # small rust blooms
        rust = rust * (0.75 + 0.5 * nhi)[:, None]
        soot = cl(nlo * 1.4 - 0.25 + up * 0.32 + cl((z - 1.25) * 0.8) * 0.45 + (1 - AO) * 0.3 + cl((-P[:, 0] - 0.4) * 0.3) * 0.25)
        pr = cl((fbm(P, 1.6, 4, 9) - 0.56 + (1 - up) * 0.12 + cl(1.1 - z) * 0.14 - soot * 0.3) * 5)
        pcol = mix(lin(0.075, 0.075, 0.055), lin(0.13, 0.115, 0.085), nlo) * (0.75 + 0.5 * nhi)[:, None]
        burnt = cl((fbm(P, 1.1, 3, 25) - 0.55) * 4) * (1 - pr)
        ash = cl((nmd - 0.5) * 3.5) * up * cl(1.1 - AO * 0.5) * (0.6 + 0.6 * nsp)
        col[:] = rust; col = mix(col, lin(0.13, 0.12, 0.11) * (0.8 + 0.4 * nsp)[:, None], burnt * 0.7)
        col = mix(col, pcol, pr); col = mix(col, lin(0.022, 0.02, 0.019) * (0.8 + 0.4 * nhi)[:, None], soot * (1 - pr * 0.5))
        col = mix(col, lin(0.36, 0.35, 0.33) * (0.85 + 0.3 * nhi)[:, None], ash * 0.85)
        rsk = (1 - up) * cl((stk - 0.64) * 4) * cl((nsp - 0.3) * 3); col = mix(col, lin(0.20, 0.075, 0.028), rsk * 0.55 * (1 - soot))
        bare = cl((E * 1.6 - 0.55) * 3) * cl((nhi - 0.3) * 3)
        col = mix(col, lin(0.12, 0.11, 0.10), bare * 0.7)
        rough[:] = 0.84 + 0.1 * nhi - 0.1 * pr; rough = np.maximum(rough, ash); metal[:] = 0.18 * (1 - soot) * (1 - pr) + 0.4 * bare
        hgt += 0.35 * fbm(P, 42, 3, 11) + 0.3 * pr - 0.2 * bare
        cast = mid == CAST; hgt[cast] += 0.15 * fbm(P[cast], 24, 3, 7)
        rb = mid == RUBBER
        ck = 1 - np.abs(2 * fbm(P[rb], 22, 3, 12) - 1)
        col[rb] = mix(np.tile(lin(0.05, 0.045, 0.04), (rb.sum(), 1)), lin(0.27, 0.26, 0.24), cl((nhi[rb] - 0.55) * 3)); col[rb] *= (0.5 + 0.5 * cl((1 - ck) * 4))[:, None]
        rough[rb] = 0.95; metal[rb] = 0; hgt[rb] = ck * 0.8
        tr = mid == TRACK
        col[tr] = mix(lin(0.22, 0.115, 0.07), lin(0.33, 0.18, 0.09), nmd[tr]); col[tr] = mix(col[tr], lin(0.06, 0.05, 0.045), soot[tr] * 0.5)
        rough[tr] = 0.9; metal[tr] = 0.25; hgt[tr] += 0.5 * fbm(P[tr], 50, 2, 10)
    for idv, c, r, m in ((GLASS, (0.03, 0.045, 0.045) if not WRECK else (0.02, 0.02, 0.02), 0.07 if not WRECK else 0.5, 0.0),
                         (LENS, (0.55, 0.55, 0.5) if not WRECK else (0.05, 0.05, 0.05), 0.1 if not WRECK else 0.6, 0.2),
                         (DARK, (0.025, 0.025, 0.025), 0.85, 0.0)):
        k = mid == idv; col[k] = lin(*c); rough[k] = r; metal[k] = m; hgt[k] = 0
    cv = mid == CANVAS
    col[cv] = (lin(0.30, 0.29, 0.19) if not WRECK else lin(0.06, 0.05, 0.045)) * (0.8 + 0.35 * nmd[cv])[:, None]; rough[cv] = 0.97; metal[cv] = 0
    hgt[cv] = 0.6 * fbm(P[cv], 90, 2, 13) + 0.5 * fbm(P[cv], 9, 2, 14)
    wd = mid == WOOD
    gr = fbm(P[wd], 1.0, 3, 15, (30, 1.2, 30))
    col[wd] = (lin(0.33, 0.24, 0.15) if not WRECK else lin(0.045, 0.04, 0.035)) * (0.65 + 0.6 * gr)[:, None]; rough[wd] = 0.85; metal[wd] = 0; hgt[wd] = gr * 0.9
    # dust and mud: on up-facing surfaces, in corners and low on the hull, heavy on the running gear
    low = cl((0.75 - z) * 1.3) if not gear else np.full(n, 0.55, np.float32)
    if gear: low = np.where(mid == TRACK, 0.35 * (1 - AO) + 0.25, cl((0.75 - z) * 1.3))
    dk = (0.75 if not WRECK else 0.35)
    dust = cl(up * 0.9 * nmd * 1.2 + (1 - AO) * 0.45 * nmd + low * 0.7 - 0.38) * dk
    dust *= ~np.isin(mid, (GLASS, LENS, DARK))
    col = mix(col, lin(0.50, 0.44, 0.34) * (0.88 + 0.24 * nhi)[:, None], dust); rough = rough + (0.95 - rough) * dust; metal *= 1 - dust
    mud = cl((low - 0.25) * 1.6 + (nmd - 0.5) * 1.6) * cl((nhi - 0.28) * 4) * ~np.isin(mid, (GLASS, LENS, DARK))
    col = mix(col, lin(0.24, 0.19, 0.135) * (0.85 + 0.3 * nlo)[:, None], mud * 0.9); rough = rough + (0.93 - rough) * mud; metal *= 1 - mud; hgt += 0.35 * mud
    col *= (0.55 + 0.45 * AO)[:, None]
    return cl(col), cl(rough, 0.04, 1), cl(metal), hgt


def synth(maps, gear):
    idm, pos, nrm, edge, ao = maps; size = idm.shape[0]
    mid = np.rint(idm[:, :, 0] * 16).astype(np.int32); valid = mid > 0; ix = np.nonzero(valid.ravel())[0]
    P = ((pos[:, :, :3].reshape(-1, 3)[ix] - 0.5) * 10).astype(np.float32); Nw = ((nrm[:, :, :3].reshape(-1, 3)[ix] - 0.5) * 2).astype(np.float32)
    E = cl((1 - edge[:, :, 0].ravel()[ix]) * 5).astype(np.float32); AO = ao[:, :, 0].ravel()[ix].astype(np.float32)
    col, rough, metal, hgt = compose(mid.ravel()[ix], P, Nw, E, AO, gear)
    def full(v, ch, fill):
        a = np.empty((size * size, ch), np.float32); a[:] = fill; a[ix] = v.reshape(len(ix), ch); return a.reshape(size, size, ch)
    srgb = np.where(col <= 0.0031308, col * 12.92, 1.055 * np.power(col, 1 / 2.4) - 0.055)
    base = full(srgb, 3, srgb.mean(0)); orm = full(np.stack([AO, rough, metal], 1), 3, (1.0, 0.8, 0.0))
    H = full(hgt, 1, 0.0)[:, :, 0]; V = valid
    k = 1.3 * size / 2048
    dx = (np.roll(H, -1, 1) - np.roll(H, 1, 1)) * (np.roll(V, -1, 1) & np.roll(V, 1, 1))
    dy = (np.roll(H, -1, 0) - np.roll(H, 1, 0)) * (np.roll(V, -1, 0) & np.roll(V, 1, 0))
    nm = np.stack([-dx * k, -dy * k, np.ones_like(H)], 2); nm /= np.linalg.norm(nm, axis=2, keepdims=True)
    return base, orm, nm * 0.5 + 0.5


def save_img(name, arr, srgb):
    h, w = arr.shape[:2]; img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    rgba = np.ones((h, w, 4), np.float32); rgba[:, :, :3] = np.clip(arr, 0, 1); img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = os.path.join(BUILD, name + '.png'); img.file_format = 'PNG'; img.save()
    return img


def final_mat(name, base, orm, nrm):
    m = bpy.data.materials.new(name)
    try: m.use_nodes = True
    except Exception: pass
    nt = m.node_tree; nt.nodes.clear(); N = nt.nodes.new; L = nt.links.new
    out = N('ShaderNodeOutputMaterial'); bs = N('ShaderNodeBsdfPrincipled'); L(bs.outputs[0], out.inputs['Surface'])
    tb = N('ShaderNodeTexImage'); tb.image = base; L(tb.outputs['Color'], bs.inputs['Base Color'])
    to = N('ShaderNodeTexImage'); to.image = orm; sp = N('ShaderNodeSeparateColor'); L(to.outputs['Color'], sp.inputs[0])
    L(sp.outputs['Green'], bs.inputs['Roughness']); L(sp.outputs['Blue'], bs.inputs['Metallic'])
    tn = N('ShaderNodeTexImage'); tn.image = nrm; nmn = N('ShaderNodeNormalMap'); L(tn.outputs['Color'], nmn.inputs['Color']); L(nmn.outputs['Normal'], bs.inputs['Normal'])
    g = bpy.data.node_groups.get('glTF Material Output')
    if g is None:
        g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        g.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    gn = N('ShaderNodeGroup'); gn.node_tree = g; L(sp.outputs['Red'], gn.inputs['Occlusion'])
    return m


# ---------------------------------------------------------------- main
def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene; sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
    try: sc.cycles.use_denoising = False
    except Exception: pass
    if sc.world is None: sc.world = bpy.data.worlds.new('w')
    sc.world.light_settings.distance = 0.9
    drv = Vector((1.90, 0.62))
    rootname = 'TankWreck' if WRECK else 'Tank'
    root = empty(rootname, (0, 0, 0))

    parts = {}
    H = build_hull(Part('Hull'), drv); parts['Hull'] = H
    Tu = Part('Turret', TUR); build_turret(PartView(Tu, TUR)); parts['Turret'] = Tu
    Gn = Part('Gun', TUR + GUNP); build_gun(PartView(Gn, TUR + GUNP)); parts['Gun'] = Gn
    Br = Part('Barrel', TUR + GUNP); build_barrel(PartView(Br, TUR + GUNP)); parts['Barrel'] = Br
    cx, cy = CUP; z0 = dome_z(cx, cy) - 0.03
    piv_c = TUR + Vector((cx - 0.31, cy, z0 + 0.19))
    Ch = Part('CommanderHatch', piv_c); build_cmd_hatch(PartView(Ch, TUR, base=True)); parts['CommanderHatch'] = Ch
    lx, ly = LDR; z1 = dome_z(lx, ly) - 0.03
    piv_l = TUR + Vector((lx + 0.30, ly, z1 + 0.06))
    Lh = Part('LoaderHatch', piv_l); build_ldr_hatch(PartView(Lh, TUR, base=True)); parts['LoaderHatch'] = Lh
    piv_d = Vector((drv.x, drv.y + 0.27, 1.46))
    Dh = Part('DriverHatch', piv_d); build_driver_hatch(Dh); parts['DriverHatch'] = Dh
    for nm, fn in (('wheel', build_wheel), ('sprocket', build_sprocket), ('idler', build_idler), ('link', build_link)):
        p = Part(nm); fn(p); parts[nm] = p
    if WRECK:
        fc = Part('FuelCellFallen', (-1.1, -2.25, 0.1125)); fuel_cell(fc, T(-1.1, -2.25, 0.1125) @ R('Z', 28) @ R('X', 90)); parts['FuelCellFallen'] = fc
    log('geometry', {k: v.tris() for k, v in parts.items()})

    # objects and hierarchy (locations relative to the parent's origin)
    hull = make_obj(H, root); hull['origin'] = (0, 0, 0)
    tur = make_obj(Tu, hull); tur['origin'] = tuple(TUR)
    gun = make_obj(Gn, tur); gun['origin'] = tuple(TUR + GUNP)
    bar = make_obj(Br, gun); bar['origin'] = tuple(TUR + GUNP)
    ch = make_obj(Ch, tur); lh = make_obj(Lh, tur); dh = make_obj(Dh, hull)
    for o, p in ((ch, piv_c), (lh, piv_l), (dh, piv_d)): o['origin'] = tuple(p)
    muz = empty('Muzzle', TUR + GUNP + Vector((4.30, 0, 0)), bar)
    eye = empty('Eye', TUR + Vector((cx + 0.06, cy, z0 + 0.62)), tur)
    exh = empty('Exhaust', (-2.30, 1.70, 1.11), hull)
    wheel_me = bpy.data.meshes.new('wheel_L'); spr_me = bpy.data.meshes.new('sprocket_L'); idl_me = bpy.data.meshes.new('idler_L'); link_me = bpy.data.meshes.new('link')
    for me, key in ((wheel_me, 'wheel'), (spr_me, 'sprocket'), (idl_me, 'idler'), (link_me, 'link')):
        p = parts[key]; me.from_pydata(p.v, [], p.f); set_mid(me, p.m)
    link = bpy.data.objects.new('TrackLink', link_me); sc.collection.objects.link(link); link.parent = root
    body = [hull, tur, gun, bar, ch, lh, dh]
    if WRECK:
        debris = empty('Debris', (0, 0, 0), root)
        fco = make_obj(parts['FuelCellFallen'], debris); fco['origin'] = tuple(parts['FuelCellFallen'].origin); body.append(fco)

    # UVs: one body atlas, a gear atlas in quadrants (wheel, sprocket, idler, link)
    tmp = []
    for me, q in ((wheel_me, (0, 0.5)), (spr_me, (0.5, 0.5)), (idl_me, (0, 0)), (link_me, (0.5, 0))):
        o = bpy.data.objects.new('uv_' + me.name, me); sc.collection.objects.link(o); smart_uv([o], 0.006); uv_quadrant(me, *q); tmp.append(o)
    for o in tmp: bpy.data.objects.remove(o)
    smart_uv(body, 0.0025)
    log('uv done')
    wheel_R, spr_R, idl_R = mirror_mesh(wheel_me, 'wheel_R'), mirror_mesh(spr_me, 'sprocket_R'), mirror_mesh(idl_me, 'idler_R')

    gear = []
    def gear_obj(name, me, loc, rr):
        ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob); ob.parent = hull; ob.location = loc; ob['radius'] = rr; gear.append(ob); return ob
    for s, side in ((1, 'L'), (-1, 'R')):
        for i, x in enumerate(WX):
            if WRECK and side == 'R' and i == 1: continue
            gear_obj('Wheel%s%d' % (side, i + 1), wheel_me if s > 0 else wheel_R, (x, s * TY, WZ), WR)
        gear_obj('Sprocket' + side, spr_me if s > 0 else spr_R, (SPR[0], s * TY, SPR[1]), SPR[2])
        gear_obj('Idler' + side, idl_me if s > 0 else idl_R, (IDL[0], s * TY, IDL[1]), IDL[2])
    Pp, L = track_path()
    mL, N, pitch = link_mats(Pp, L, TY)
    trL = bpy.data.objects.new('TrackL', mesh_from_mats('TrackL', link_me, mL)); sc.collection.objects.link(trL); trL.parent = hull
    tracks = [trL]
    if WRECK:
        trT = bpy.data.objects.new('TrackThrown', mesh_from_mats('TrackThrown', link_me, thrown_mats())); sc.collection.objects.link(trT); trT.parent = debris; tracks.append(trT)
    else:
        mR, _, _ = link_mats(Pp, L, -TY)
        trR = bpy.data.objects.new('TrackR', mesh_from_mats('TrackR', link_me, mR)); sc.collection.objects.link(trR); trR.parent = hull; tracks.append(trR)
    log('track: %.3f m, %d links, pitch %.4f' % (L, N, pitch))
    for o in body + gear + tracks + [link]: shade(o)

    # pose: turret, gun, hatches; the wreck sits down on its right side
    tur.rotation_euler = (0, 0, rad(TURRET_YAW)); gun.rotation_euler = (0, rad(GUN_DROOP), 0)
    ch.rotation_euler = (0, rad(-108 if WRECK else -100), 0)
    if WRECK:
        lh.rotation_euler = (rad(6), rad(163), 0); dh.rotation_euler = (rad(4), 0, rad(95))
        hull.matrix_world = T(0, TY, 0) @ R('X', ROLL) @ T(0, -TY, 0)
    link.location = (0, 0, -30)
    bpy.context.view_layer.update()

    # bakes
    mats = id_materials()
    for o in body + gear + tracks + [link]:
        o.data.materials.clear()
        for m in mats: o.data.materials.append(m)
        o.data.polygons.foreach_set('material_index', get_mid(o.data)); o.data.update()
    bs, gs = (1024, 512) if FAST else (2048, 1024)
    gear_bake = [o for o in gear if o.name in ('WheelL1', 'SprocketL', 'IdlerL')] + [link]
    tex = {}
    for tag, objs, size in (('body', body, bs), ('gear', gear_bake, gs)):
        maps = [bake(mats, objs, k, size, s) for k, s in (('ID', 1, ), ('POS', 1), ('NRM', 1), ('EDGE', 6 if FAST else 10), ('AO', 12 if FAST else 28))]
        t = time.time(); base, orm, nrm = synth(maps, tag == 'gear'); log('synth %s %.1fs' % (tag, time.time() - t))
        pre = 'tank_wreck_' if WRECK else 'tank_'
        tex[tag] = final_mat(('TankWreck' if WRECK else 'Tank') + tag.capitalize(), save_img(pre + tag + '_base', base, True), save_img(pre + tag + '_orm', orm, False), save_img(pre + tag + '_nrm', nrm, False))
    for o, m in [(o, tex['body']) for o in body] + [(o, tex['gear']) for o in gear + tracks + [link]]:
        me = o.data
        if me.get('final'): continue
        me.materials.clear(); me.materials.append(m); me.polygons.foreach_set('material_index', np.zeros(len(me.polygons), np.int32)); me['final'] = 1; me.update()
    link.location = (0, 0, 0)

    # data for the game: track path (glTF x, y = Blender x, z), link count, wheel radii
    root['track_path'] = [round(float(v), 4) for v in Pp.ravel()]; root['track_links'] = N; root['track_z'] = TY; root['track_len'] = round(float(L), 5)
    exp = [root, hull, tur, gun, bar, ch, lh, dh, muz, eye, exh] + gear + tracks
    if WRECK: exp += [debris, fco]
    else: exp.append(link)
    tris = 0
    dg = bpy.context.evaluated_depsgraph_get()
    for o in exp:
        if o.type == 'MESH':
            e = o.evaluated_get(dg); me = e.to_mesh(); me.calc_loop_triangles(); tris += len(me.loop_triangles); e.to_mesh_clear()
    log('triangles (incl. TrackLink template)', tris)
    path = os.path.join(OUT, 'tank_wreck.glb' if WRECK else 'tank.glb')
    select(exp, root)
    bpy.ops.export_scene.gltf(**opkw(bpy.ops.export_scene.gltf, filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_extras=True, export_yup=True,
                                     export_image_format='JPEG', export_jpeg_quality=88, export_image_quality=88, export_animations=False, export_cameras=False, export_lights=False,
                                     export_materials='EXPORT', export_normals=True, export_texcoords=True, export_tangents=False, export_vertex_color='NONE', export_attributes=False,
                                     export_morph=False, export_skins=False))
    log('exported', path, '%.2f MB' % (os.path.getsize(path) / 1e6))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, VAR + '.blend'))
    log('done')


class PartView:
    """Builds into a Part using coordinates relative to `frame` (turret / gun local), the Part keeps its own origin."""
    def __init__(self, part, frame, base=False):
        self.p = part; self.M = T(*frame)

    def add(self, bm, M=None, mat=None):
        self.p.add(bm, self.M @ (M if M is not None else Matrix.Identity(4)), mat)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback; traceback.print_exc(); sys.exit(1)
