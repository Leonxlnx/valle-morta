"""Tiny signed-distance-field toolkit (numpy only, so it also runs inside Blender's Python).

Conventions: metres, x = character's left, y = back (character faces -y), z = up.
All primitives are callables  d = prim(P)  with P an (N,3) float32 array, and carry an
axis aligned bounding box (lo, hi) used for culling.
"""
import numpy as np

F = np.float32
BIG = 1e3


def v3(*a):
    return np.array(a, dtype=np.float64)


def rotm(rx=0.0, ry=0.0, rz=0.0):
    """Rotation matrix R = Rz @ Ry @ Rx, angles in degrees."""
    rx, ry, rz = np.radians([rx, ry, rz])
    cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def frame(u, v_hint):
    """Orthonormal frame with columns (u, v, w); u exact, v close to v_hint."""
    u = np.asarray(u, float); u = u / np.linalg.norm(u)
    v = np.asarray(v_hint, float); v = v - u * (v @ u); v = v / np.linalg.norm(v)
    w = np.cross(u, v)
    return np.stack([u, v, w], 1)


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * (k * 0.25)


def smax(a, b, k):
    if k <= 0:
        return np.maximum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.maximum(a, b) + h * h * (k * 0.25)


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# ----------------------------------------------------------------------------- primitives
class Prim:
    lo = None
    hi = None


class Sphere(Prim):
    def __init__(s, c, r):
        s.c = np.asarray(c, F); s.r = F(r)
        s.lo = s.c - r; s.hi = s.c + r

    def __call__(s, P):
        return np.sqrt(((P - s.c) ** 2).sum(1)) - s.r


class Ellipsoid(Prim):
    def __init__(s, c, r, R=None):
        s.c = np.asarray(c, F); s.r = np.asarray(r, F)
        s.R = None if R is None else np.asarray(R, F)
        ext = s.r if R is None else np.abs(s.R) @ s.r
        s.lo = s.c - ext; s.hi = s.c + ext
        s.rmin = F(s.r.min())

    def __call__(s, P):
        q = P - s.c
        if s.R is not None:
            q = q @ s.R
        a = q / s.r
        k0 = np.sqrt((a * a).sum(1))
        b = a / s.r
        k1 = np.sqrt((b * b).sum(1))
        d = k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)
        return np.where(k1 < 1e-6, -s.rmin, d).astype(F)


class Capsule(Prim):
    """Tapered capsule (round cone approximation)."""
    def __init__(s, a, b, ra, rb=None):
        s.a = np.asarray(a, F); s.b = np.asarray(b, F)
        s.ra = F(ra); s.rb = F(ra if rb is None else rb)
        rm = max(s.ra, s.rb)
        s.lo = np.minimum(s.a, s.b) - rm; s.hi = np.maximum(s.a, s.b) + rm
        s.ba = s.b - s.a; s.bb = F(max(float(s.ba @ s.ba), 1e-12))

    def __call__(s, P):
        pa = P - s.a
        h = np.clip((pa @ s.ba) / s.bb, 0.0, 1.0)
        q = pa - h[:, None] * s.ba
        return np.sqrt((q * q).sum(1)) - (s.ra + (s.rb - s.ra) * h)


class Tube(Prim):
    """Poly-line of tapered capsules (hard min between segments)."""
    def __init__(s, pts, radii):
        pts = np.asarray(pts, F); radii = np.broadcast_to(np.asarray(radii, F), (len(pts),))
        s.segs = [Capsule(pts[i], pts[i + 1], radii[i], radii[i + 1]) for i in range(len(pts) - 1)]
        s.lo = np.min([c.lo for c in s.segs], 0); s.hi = np.max([c.hi for c in s.segs], 0)

    def __call__(s, P):
        d = s.segs[0](P)
        for c in s.segs[1:]:
            d = np.minimum(d, c(P))
        return d


def spline(pts, n=4):
    """Catmull-Rom resample of control points -> smoother poly-line (keeps end points)."""
    p = np.asarray(pts, float)
    q = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    out = []
    for i in range(len(p) - 1):
        p0, p1, p2, p3 = q[i], q[i + 1], q[i + 2], q[i + 3]
        for t in np.linspace(0, 1, n, endpoint=False):
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(p[-1])
    return np.array(out)


def STube(pts, radii, n=4):
    """Smooth tube through control points; radii are per control point (linear in between)."""
    pts = np.asarray(pts, float)
    radii = np.broadcast_to(np.asarray(radii, float), (len(pts),))
    sp = spline(pts, n)
    tr = np.linspace(0, len(pts) - 1, len(sp))
    rr = np.interp(tr, np.arange(len(pts)), radii)
    return Tube(sp, rr)


class Box(Prim):
    """Rounded box: half extents (outer), corner radius r, optional rotation."""
    def __init__(s, c, half, r=0.0, R=None):
        s.c = np.asarray(c, F); s.h = np.asarray(half, F); s.r = F(r)
        s.R = None if R is None else np.asarray(R, F)
        ext = s.h if R is None else np.abs(s.R) @ s.h
        s.lo = s.c - ext; s.hi = s.c + ext

    def __call__(s, P):
        q = P - s.c
        if s.R is not None:
            q = q @ s.R
        q = np.abs(q) - (s.h - s.r)
        out = np.sqrt((np.maximum(q, 0.0) ** 2).sum(1))
        return out + np.minimum(q.max(1), 0.0) - s.r


class Torus(Prim):
    """Torus in the local xy-plane (axis = local z)."""
    def __init__(s, c, R_major, r_minor, R=None):
        s.c = np.asarray(c, F); s.R = None if R is None else np.asarray(R, F)
        s.a = F(R_major); s.b = F(r_minor)
        e = float(R_major + r_minor)
        s.lo = s.c - e; s.hi = s.c + e

    def __call__(s, P):
        q = P - s.c
        if s.R is not None:
            q = q @ s.R
        l = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2) - s.a
        return np.sqrt(l * l + q[:, 2] ** 2) - s.b


class Scaled(Prim):
    """Evaluate `prim` (defined in a local frame) under world = c + R @ (scale * local)."""
    def __init__(s, prim, c, R=None, scale=(1, 1, 1)):
        s.p = prim; s.c = np.asarray(c, F)
        s.R = np.eye(3, dtype=F) if R is None else np.asarray(R, F)
        s.s = np.asarray(scale, F); s.smin = F(s.s.min())
        lo, hi = prim.lo * s.s, prim.hi * s.s
        cen = (lo + hi) * 0.5; ext = np.abs(s.R) @ ((hi - lo) * 0.5)
        wc = s.c + s.R @ cen
        s.lo = wc - ext; s.hi = wc + ext

    def __call__(s, P):
        q = ((P - s.c) @ s.R) / s.s
        return s.p(q.astype(F)) * s.smin


class Plane(Prim):
    """Half-space: negative behind the plane (n points to the outside)."""
    def __init__(s, p, n):
        s.n = np.asarray(n, F); s.n = s.n / np.linalg.norm(s.n); s.o = F(np.dot(p, s.n))
        s.lo = np.full(3, -BIG, F); s.hi = np.full(3, BIG, F)

    def __call__(s, P):
        return P @ s.n - s.o


# ----------------------------------------------------------------------------- layers
class Layer:
    """Ordered list of CSG ops with bounding-box culling."""
    def __init__(s):
        s.ops = []

    def u(s, prim, k=0.0):
        s.ops.append((0, prim, k)); return s

    def sub(s, prim, k=0.0):
        s.ops.append((1, prim, k)); return s

    def isect(s, prim, k=0.0):
        s.ops.append((2, prim, k)); return s

    def fn(s, f, lo=None, hi=None):
        """f(P, d) -> d applied to points inside [lo, hi]."""
        lo = np.full(3, -BIG, F) if lo is None else np.asarray(lo, F)
        hi = np.full(3, BIG, F) if hi is None else np.asarray(hi, F)
        s.ops.append((3, (f, lo, hi), 0.0)); return s

    def bounds(s, margin=0.0):
        lo = np.min([op[1].lo for op in s.ops if op[0] == 0], 0) - margin
        hi = np.max([op[1].hi for op in s.ops if op[0] == 0], 0) + margin
        return lo, hi

    def eval(s, P, margin=0.02, d=None):
        n = len(P)
        if d is None:
            d = np.full(n, BIG, F)
        if n == 0:
            return d
        plo = P.min(0); phi = P.max(0)
        if getattr(s, '_kp', None) is None or len(s._kp) != len(s.ops):
            # a primitive must stay accurate out to the largest blend radius of any later op
            ks = [op[2] for op in s.ops]
            s._kp = [1.3 * max(ks[i:]) for i in range(len(ks))]
        for (mode, prim, k), kp in zip(s.ops, s._kp):
            if mode == 3:
                f, lo, hi = prim
            else:
                pad = kp + margin
                lo = prim.lo - pad; hi = prim.hi + pad
            if (phi < lo).any() or (plo > hi).any():
                continue
            if (plo >= lo).all() and (phi <= hi).all():
                m = slice(None)
            else:
                m = ((P >= lo) & (P <= hi)).all(1)
                if not m.any():
                    continue
            if mode == 3:
                d[m] = f(P[m], d[m])
                continue
            dp = prim(P[m])
            if mode == 0:
                d[m] = smin(d[m], dp, k)
            elif mode == 1:
                d[m] = smax(d[m], -dp, k)
            else:
                d[m] = smax(d[m], dp, k)
        return d


# ----------------------------------------------------------------------------- noise
def _hash(ix, iy, iz, seed):
    h = (ix.astype(np.uint32) * np.uint32(0x8da6b343) + iy.astype(np.uint32) * np.uint32(0xd8163841)
         + iz.astype(np.uint32) * np.uint32(0xcb1ab31f) + np.uint32((seed * 0x9e3779b1) & 0xffffffff))
    h ^= h >> np.uint32(15); h *= np.uint32(0x2c1b3c6d)
    h ^= h >> np.uint32(12); h *= np.uint32(0x297a2d39)
    h ^= h >> np.uint32(15)
    return h


def gnoise(P, freq=1.0, seed=0):
    """Perlin-style gradient noise, roughly in [-1, 1]. P (N,3); freq scalar or (3,)."""
    Q = (P * np.asarray(freq, F)).astype(F)
    I = np.floor(Q)
    T = Q - I
    I = I.astype(np.int32)
    W = T * T * T * (T * (T * 6.0 - 15.0) + 10.0)
    out = np.zeros(len(P), F)
    for dx in (0, 1):
        wx = W[:, 0] if dx else 1.0 - W[:, 0]
        for dy in (0, 1):
            wy = W[:, 1] if dy else 1.0 - W[:, 1]
            for dz in (0, 1):
                wz = W[:, 2] if dz else 1.0 - W[:, 2]
                h = _hash(I[:, 0] + dx, I[:, 1] + dy, I[:, 2] + dz, seed)
                gx = (h & np.uint32(1023)).astype(F) * F(1 / 511.5) - 1.0
                gy = ((h >> np.uint32(10)) & np.uint32(1023)).astype(F) * F(1 / 511.5) - 1.0
                gz = ((h >> np.uint32(20)) & np.uint32(1023)).astype(F) * F(1 / 511.5) - 1.0
                dot = gx * (T[:, 0] - dx) + gy * (T[:, 1] - dy) + gz * (T[:, 2] - dz)
                out += wx * wy * wz * dot
    return out * F(1.6)


def fbm(P, freq=1.0, octaves=4, gain=0.5, lac=2.03, seed=0, ridged=False):
    out = np.zeros(len(P), F); a = 1.0; norm = 0.0
    f = np.asarray(freq, F) * 1.0
    for o in range(octaves):
        n = gnoise(P + F(o * 17.31), f, seed + o * 101)
        if ridged:
            n = 1.0 - 2.0 * np.abs(n)
        out += a * n; norm += a
        a *= gain; f = f * lac
    return out / norm


def worley(P, freq=1.0, seed=0, jitter=0.9):
    """Cellular noise: returns (F1, F2) distances in cell units."""
    Q = (P * np.asarray(freq, F)).astype(F)
    I = np.floor(Q).astype(np.int32)
    T = Q - I
    f1 = np.full(len(P), 9.0, F); f2 = np.full(len(P), 9.0, F)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                h = _hash(I[:, 0] + dx, I[:, 1] + dy, I[:, 2] + dz, seed)
                ox = (h & np.uint32(1023)).astype(F) * F(1 / 1023.0)
                oy = ((h >> np.uint32(10)) & np.uint32(1023)).astype(F) * F(1 / 1023.0)
                oz = ((h >> np.uint32(20)) & np.uint32(1023)).astype(F) * F(1 / 1023.0)
                ex = dx + 0.5 + (ox - 0.5) * jitter - T[:, 0]
                ey = dy + 0.5 + (oy - 0.5) * jitter - T[:, 1]
                ez = dz + 0.5 + (oz - 0.5) * jitter - T[:, 2]
                d = np.sqrt(ex * ex + ey * ey + ez * ez)
                f2 = np.where(d < f1, f1, np.minimum(f2, d))
                f1 = np.minimum(f1, d)
    return f1, f2


def limb_coords(P, a, b, ref):
    """Cylindrical coords about axis a->b: t (m along axis), theta (rad, 0 at `ref`), r (m)."""
    a = np.asarray(a, F); ax = np.asarray(b, F) - a
    L = float(np.linalg.norm(ax)); ax = ax / L
    ref = np.asarray(ref, F); e1 = ref - ax * float(ref @ ax); e1 = e1 / np.linalg.norm(e1)
    e2 = np.cross(ax, e1).astype(F)
    q = P - a
    t = q @ ax
    x = q @ e1; y = q @ e2
    return t, np.arctan2(y, x), np.sqrt(x * x + y * y)


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


class Noisy(Prim):
    """Primitive with an fbm-perturbed surface (ragged tears, torn edges)."""
    def __init__(s, prim, amp, freq, seed=0, octaves=2):
        s.p = prim; s.amp = F(amp); s.freq = freq; s.seed = seed; s.oct = octaves
        s.lo = prim.lo - amp; s.hi = prim.hi + amp

    def __call__(s, P):
        return s.p(P) + s.amp * fbm(P, s.freq, s.oct, seed=s.seed)
