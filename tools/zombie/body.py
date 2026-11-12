"""Zombie anatomy: skeleton landmarks + skin / eye / teeth signed distance layers."""
import numpy as np
from sdf import *

mm = 1e-3

# ----------------------------------------------------------------------------- skeleton (rest, A-pose)
HEAD_O = v3(0, 0.0, 1.650)          # head-local origin: ear-canal level, mid-sagittal


def hp(x, y, z):
    """head-local millimetres -> world metres"""
    return HEAD_O + v3(x, y, z) * mm


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


SH = v3(0.180, 0.022, 1.432)                           # gleno-humeral joint (left)
EL = SH + 0.295 * unit((0.72, -0.06, -0.69))            # elbow
WR = EL + 0.255 * unit((0.70, -0.20, -0.685))           # wrist
ARM_DIR = unit(WR - EL)
HIPJ = v3(0.092, 0.012, 0.925)
KNEE = v3(0.098, -0.008, 0.500)
ANK = v3(0.104, 0.022, 0.092)
TOE_OUT = 9.0                                           # degrees toe-out

J = {
    'Hips': v3(0, 0.014, 0.975), 'Spine': v3(0, 0.018, 1.085), 'Chest': v3(0, 0.024, 1.225),
    'Neck': v3(0, 0.028, 1.468), 'Head': v3(0, 0.014, 1.568), 'HeadTop': v3(0, 0.0, 1.78),
    'Jaw': v3(0, -0.012, 1.612), 'JawTip': v3(0, -0.088, 1.563),
    'Shoulder.L': v3(0.035, 0.014, 1.445), 'UpperArm.L': SH, 'LowerArm.L': EL, 'Hand.L': WR,
    'HandTip.L': WR + 0.105 * ARM_DIR,
    'UpperLeg.L': HIPJ, 'LowerLeg.L': KNEE, 'Foot.L': ANK,
    'Toe.L': v3(0.114, -0.118, 0.028), 'ToeTip.L': v3(0.126, -0.200, 0.028),
}
for _k in list(J):
    if _k.endswith('.L'):
        J[_k[:-2] + '.R'] = J[_k] * v3(-1, 1, 1)


def mx(p, s):
    p = np.asarray(p, float)
    return p * v3(s, 1, 1)


class Xf:
    """Local frame: world = o + M @ local (columns of M are the local axes)."""
    def __init__(s, o, M):
        s.o = np.asarray(o, float); s.M = np.asarray(M, float)

    def p(s, *l):
        return s.o + s.M @ np.asarray(l, float)

    def R(s, Rl=None):
        return s.M if Rl is None else s.M @ Rl

    def mirror(s):
        Mx = np.diag([-1.0, 1.0, 1.0])
        return Xf(Mx @ s.o, Mx @ s.M)


# ----------------------------------------------------------------------------- head
EYE_C = {s: hp(s * 32.0, -71.5, 20.5) for s in (1, -1)}
EYE_R = 12.8 * mm
EAR_PIVOT = {s: hp(s * 71.5, -3, 0) for s in (1, -1)}
EAR_R = {s: rotm(-12, 0, -24 * s) for s in (1, -1)}


def _E(c, r, R=None):
    return Ellipsoid(hp(*c), np.array(r, float) * mm, R)


def _T(pts, rad, n=4):
    return STube([hp(*p) for p in pts], np.array(rad, float) * mm, n)


def _S(c, r):
    return Sphere(hp(*c), r * mm)


class LidCut(Prim):
    """Almond shaped eye opening: removes lid material in front of the eyeball between two lid curves."""
    def __init__(s, ec, side, xin=-15.5, xout=13.5, zin=-2.2, zout=1.4, hu=6.4, hl=5.4):
        s.ec = np.asarray(ec, F); s.side = F(side)
        s.p = [F(v * mm) for v in (xin, xout, zin, zout, hu, hl)]
        s.lo = s.ec - F(0.019); s.hi = s.ec + F(0.019)

    def curves(s, xl):
        xin, xout, zin, zout, hu, hl = s.p
        t = np.clip((xl - xin) / (xout - xin), 0.0, 1.0)
        base = zin + (zout - zin) * t
        tu = np.clip(t * 1.08, 0, 1); tl = np.clip(t * 0.96 + 0.04, 0, 1)
        up = base + hu * (4 * tu * (1 - tu)) ** 0.62
        lo = base - hl * (4 * tl * (1 - tl)) ** 0.75
        return t, up, lo

    def __call__(s, P):
        q = P - s.ec
        xl = q[:, 0] * s.side; yl = q[:, 1]; zl = q[:, 2]
        xin, xout = s.p[0], s.p[1]
        t, up, lo = s.curves(xl)
        d = np.maximum(zl - up, lo - zl) * F(0.8)
        d = np.maximum(d, np.maximum(xin - xl, xl - xout))
        r = np.sqrt((q * q).sum(1))
        d = np.maximum(d, (EYE_R - F(0.0004)) - r)          # never cut into the eyeball volume
        d = np.maximum(d, yl + F(0.005))                    # front half only
        return d


def build_head():
    L = Layer()
    # --- cranium
    L.u(_E((0, 6, 46), (77, 98, 85)))
    L.u(_E((0, 50, 20), (62, 54, 60)), 20 * mm)                  # occiput
    L.u(_E((0, -42, 52), (62, 49, 46)), 22 * mm)                 # frontal bone
    # --- facial mass
    L.u(_E((0, -46, -16), (52, 52, 60)), 20 * mm)
    L.u(_E((0, -78, -38), (29, 22, 22)), 12 * mm)                # muzzle
    L.u(_E((0, -84, -58), (21, 13, 10)), 8 * mm)                 # lower lip support
    for s in (1, -1):
        L.u(_T([(s * 50, -79, 36), (s * 54, -74, 18), (s * 53, -76, 2)], [6.5, 6.5, 7]), 8 * mm)   # lateral orbital rim
        L.u(_E((s * 50, -72, -5), (16, 17, 11), rotm(0, s * 10, s * -20)), 9 * mm)                # cheek bone
        L.u(_T([(s * 56, -62, -3), (s * 64, -34, 0), (s * 66, -14, 1)], [4, 3.2, 2.2]), 14 * mm)    # zygomatic arch
        L.u(_T([(s * 7, -95, 35), (s * 26, -96.5, 39), (s * 44, -90, 37.5), (s * 53, -80, 33)],
               [5, 5.5, 5, 4]), 8 * mm)                                                          # brow ridge
        L.u(_T([(s * 53, -10, -10), (s * 49, -11, -40), (s * 46, -14, -57)], [7, 7, 8]), 10 * mm)  # ramus
        L.u(_E((s * 51, -32, -27), (8, 17, 26)), 14 * mm)                                         # masseter
        L.u(_T([(s * 46, -14, -57), (s * 36, -50, -73), (s * 16, -78, -81.5), (0, -84, -82.5)],
               [6, 5.5, 6, 7]), 12 * mm)                                                       # mandible body
    L.u(_E((0, -50, -50), (45, 44, 33)), 16 * mm)                # lower face wedge
    L.u(_E((0, -86, -78), (15, 11, 13)), 8 * mm)                 # chin
    L.u(_E((0, -48, -78), (30, 36, 12)), 14 * mm)                # floor of mouth
    L.u(_S((0, -92, 35), 7.5), 8 * mm)                           # glabella
    # --- nose
    L.u(_T([(0, -90, 29), (0, -101.5, 8), (0, -114.5, -9)], [4.8, 5.5, 6.8]), 6 * mm)
    L.u(_E((0, -94, -3), (12, 12, 21)), 10 * mm)
    L.u(_S((0, -116.5, -13.5), 7.4), 5 * mm)
    L.u(_E((0, -105, -18), (15.5, 10, 8.5)), 6 * mm)             # lobule
    L.u(_T([(0, -112, -19.5), (0, -102.5, -25)], [3.8, 3.8]), 3 * mm)
    for s in (1, -1):
        L.u(_E((s * 12.5, -101.5, -20), (5, 7.5, 5.5), rotm(0, 0, s * 20)), 4 * mm)             # alae
    # --- hollows (gaunt)
    for s in (1, -1):
        L.sub(_E((s * 45, -70, -36), (11, 16, 17)), 14 * mm)                                      # cheeks
        L.sub(_T([(s * 15, -103, -13), (s * 18.5, -100, -19), (s * 17, -97.5, -25)], [1.3, 1.5, 1.3]), 2.5 * mm)
        L.sub(_E((s * 6.5, -106, -25.5), (3.6, 5.8, 3.5), rotm(0, 0, s * 20)), 1.5 * mm)          # nostrils
    # --- eye sockets, lids
    for s in (1, -1):
        ec = EYE_C[s]
        L.sub(_E((s * 32, -91, 21), (19, 15, 13.5)), 7 * mm)
        L.u(Sphere(ec, 14.3 * mm), 5 * mm)
        L.u(_T([(s * 20, -85, 9), (s * 32, -87, 6.5), (s * 45, -81, 9)], [3.2, 3.6, 3]), 5 * mm)      # eye bag
        L.sub(LidCut(ec, s), 0.7 * mm)                                                               # lid opening
        L.sub(_T([(s * 17.5, -84.5, 24), (s * 30, -87.5, 30.5), (s * 45, -82, 27)], [0.9, 1.1, 0.9]), 2 * mm)  # lid crease
        L.sub(_T([(s * 20, -98, -21), (s * 29, -90, -43), (s * 27.5, -86, -55)], [1.6, 2.0, 1.0]), 5 * mm)  # nasolabial fold
    # --- lips, mouth
    L.sub(_T([(0, -103.5, -28), (0, -106.5, -39)], [2.6, 3]), 3 * mm)                                # philtrum
    L.u(_T([(-25, -84.5, -47.5), (-13, -96.5, -44.5), (-4, -100.5, -43.2), (0, -100.5, -44),
            (4, -100.5, -43.2), (13, -96.5, -44.5), (25, -84.5, -47.5)],
           [2.2, 4.2, 4.6, 4.4, 4.6, 4.2, 2.2]), 3 * mm)
    L.u(_T([(-25, -84.5, -49.5), (-13, -93.5, -55.5), (0, -96.9, -57), (13, -93.5, -55.5), (25, -84.5, -49.5)],
           [2.2, 5, 5.6, 5, 2.2]), 4 * mm)
    L.sub(_E((0, -97, -50.3), (24.5, 14, 3.4)), 1.5 * mm)                                            # lip slit
    L.sub(_E((0, -72, -53), (22, 24, 12)), 2 * mm)                                                   # oral cavity
    L.u(_E((0, -70, -61), (16, 22, 5.5)), 2 * mm)                                                    # tongue
    # torn cheek, character's left
    L.sub(_E((27, -66, -52), (8, 20, 10)), 2 * mm)                                                   # buccal space (torn side)
    L.sub(Noisy(Capsule(hp(28, -84, -50), hp(41, -57, -47.5), 10 * mm, 8.5 * mm), 3.5 * mm, 110, seed=11, octaves=3), 1.5 * mm)
    # --- ears
    for s in (1, -1):
        X = Xf(EAR_PIVOT[s], EAR_R[s])
        o = s  # outward sign along local x
        L.u(Ellipsoid(X.p(o * 2.5 * mm, 15 * mm, -1 * mm), np.array([3.4, 15.5, 31]) * mm, X.R()), 3 * mm)
        ang = np.radians(np.linspace(-50, 235, 14))
        rim = [X.p(o * 4.0 * mm, (15 + 15 * np.cos(a)) * mm, (-1 + 30.5 * np.sin(a)) * mm) for a in ang]
        L.u(Tube(rim, 2.9 * mm), 2 * mm)                                                              # helix
        L.u(STube([X.p(o * 4.5 * mm, 19 * mm, 17 * mm), X.p(o * 5 * mm, 22 * mm, 3 * mm),
                   X.p(o * 5 * mm, 17 * mm, -12 * mm)], np.array([2.2, 2.6, 2.4]) * mm), 2 * mm)      # antihelix
        L.sub(Ellipsoid(X.p(o * 5.5 * mm, 10 * mm, -4 * mm), np.array([4.5, 7, 10]) * mm, X.R()), 2.5 * mm)  # concha
        L.u(Ellipsoid(X.p(o * 2.5 * mm, 5 * mm, -27 * mm), np.array([3.2, 7.5, 8.5]) * mm, X.R()), 3 * mm)   # lobe
        L.u(Ellipsoid(X.p(o * 3.0 * mm, 1 * mm, -3 * mm), np.array([3.5, 3.5, 6]) * mm, X.R()), 2.5 * mm)   # tragus
    return L


def build_eyes():
    L = Layer()
    for s in (1, -1):
        L.u(Sphere(EYE_C[s], EYE_R))
    return L


def _arch(a, b, yc, z, widths, th, hh, lean=0.0):
    """Teeth as rounded boxes along a parabolic-ish dental arch (head-local mm)."""
    out = []
    # arc-length parametrisation of x = a sin(phi), y = yc - b cos(phi)
    ph = np.linspace(0, np.pi / 2 * 1.02, 400)
    x = a * np.sin(ph); y = yc - b * np.cos(ph)
    sl = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    pos = 0.0
    for i, w in enumerate(widths):
        cen = pos + w / 2; pos += w
        p = np.interp(cen, sl, ph)
        cx, cy = a * np.sin(p), yc - b * np.cos(p)
        tang = np.degrees(np.arctan2(b * np.sin(p), a * np.cos(p)))       # tangent angle in xy
        for s in (1, -1):
            jit = ((i * 7 + (s > 0) * 3) % 5 - 2) * 0.35
            R = rotm(lean, 0, s * tang + jit * 3)
            out.append(Box(hp(s * cx, cy, z + jit * 0.5), np.array([w / 2 - 0.25, th[i], hh[i]]) * mm, 1.3 * mm, R))
    return out


TEETH_W = [8.6, 6.8, 7.8, 7.0, 6.8, 10.0, 9.5]


def build_teeth():
    L = Layer()
    up = _arch(24.5, 33, -62, -45.0, TEETH_W, [1.9, 1.8, 2.6, 3.4, 3.6, 4.6, 4.6], [5.4, 4.9, 5.6, 4.4, 4.2, 4.0, 3.8])
    lo = _arch(22.5, 30.5, -61.5, -58.5, [5.6, 6.0, 7.0, 7.0, 7.0, 10.5, 10.0],
               [1.7, 1.8, 2.5, 3.3, 3.5, 4.6, 4.6], [4.6, 4.7, 5.2, 4.2, 4.0, 3.8, 3.6])
    for i, t in enumerate(up + lo):
        if i in (9,):       # a missing tooth (upper right premolar)
            continue
        L.u(t)
    return L


def head_warp(P):
    """Cheap smooth asymmetry warp applied to the head region (returns warped copy)."""
    z = P[:, 2] - F(HEAD_O[2]); x = P[:, 0]; y = P[:, 1]
    w = sstep(-0.16, -0.10, z)                                    # fade out below the neck
    Q = P.copy()
    Q[:, 0] += w * F(0.0016) * np.sin(31.0 * z + 17.0 * y + 1.3)
    Q[:, 1] += w * F(0.0014) * np.sin(27.0 * x + 19.0 * z + 0.4)
    Q[:, 2] += w * (F(0.0013) * np.sin(23.0 * x + 0.7) + F(0.022) * x * sstep(0.06, -0.06, z))
    return Q


# ----------------------------------------------------------------------------- torso / limbs (skin)
def build_torso():
    L = Layer()
    L.u(Ellipsoid((0, 0.024, 1.275), (0.148, 0.105, 0.185)))
    L.u(Ellipsoid((0, 0.022, 1.385), (0.165, 0.088, 0.085)), 0.05)
    L.u(Ellipsoid((0, 0.010, 1.09), (0.132, 0.088, 0.13)), 0.06)
    L.u(Ellipsoid((0, 0.022, 0.97), (0.158, 0.098, 0.11)), 0.05)
    L.u(Capsule((0, 0.030, 1.44), (0, 0.012, 1.60), 0.051, 0.047), 0.025)                       # neck
    for s in (1, -1):
        L.u(Capsule((s * 0.045, 0.04, 1.505), (s * 0.165, 0.03, 1.455), 0.030, 0.020), 0.03)    # trapezius
        L.u(Sphere((s * 0.183, 0.022, 1.43), 0.052), 0.03)                                      # deltoid
        L.u(STube([(s * 0.018, -0.055, 1.437), (s * 0.09, -0.048, 1.452), (s * 0.172, -0.008, 1.47)],
                  0.0095), 0.012)                                                               # clavicle
        L.u(Capsule(hp(s * 58, 22, -22), (s * 0.016, -0.05, 1.445), 0.011, 0.009), 0.012)       # sternocleidomastoid
    L.u(Ellipsoid((0, -0.030, 1.512), (0.012, 0.012, 0.016)), 0.012)                            # thyroid cartilage
    for s in (1, -1):
        L.sub(Ellipsoid((s * 0.075, -0.012, 1.478), (0.045, 0.022, 0.02)), 0.02)                # supraclavicular
    L.sub(Sphere((0, -0.052, 1.452), 0.014), 0.012)                                             # sternal notch
    return L


def build_arm(s):
    L = Layer()
    S, E, W = mx(SH, s), mx(EL, s), mx(WR, s)
    L.u(Capsule(S, E, 0.045, 0.036))
    L.u(Capsule(E, W, 0.038, 0.027), 0.012)
    fa = unit(W - E)
    out = unit(np.cross(fa, v3(0, -1, 0)) * s)          # roughly "up/outer" side of the forearm
    L.u(Ellipsoid(E + 0.075 * fa + 0.010 * out, (0.062, 0.021, 0.024), frame(fa, out)), 0.015)   # extensor mass
    L.u(Sphere(E + v3(0, 0.022, 0.0) - 0.004 * fa, 0.017), 0.012)                               # olecranon
    return L


HAND_TIPS = {1: [], -1: []}       # (tip, dir, back_normal, radius) for the painter


def build_hand(s):
    L = Layer()
    u = mx(ARM_DIR, 1); v = unit(v3(0, -1, 0) - u * (v3(0, -1, 0) @ u)); wv = np.cross(v, u)   # left: back of hand normal
    X = Xf(WR, np.stack([u, v, wv], 1))
    if s < 0:
        X = X.mirror()
    P = X.p
    L.u(Ellipsoid(P(-0.004, 0, 0), (0.034, 0.029, 0.0195), X.R()))
    L.u(Box(P(0.055, 0.0, 0.0), (0.050, 0.041, 0.0135), 0.011, X.R()), 0.012)
    L.u(Ellipsoid(P(0.040, 0.027, -0.010), (0.032, 0.017, 0.013), X.R(rotm(0, 0, 25))), 0.008)   # thenar
    L.u(Ellipsoid(P(0.050, -0.030, -0.008), (0.036, 0.011, 0.012), X.R()), 0.008)               # hypothenar
    fingers = [((0.100, 0.029, 0.001), 10, (0.031, 0.023, 0.020), 0.0088, (22, 48, 30)),
               ((0.105, 0.009, 0.003), 1, (0.035, 0.026, 0.021), 0.0090, (15, 40, 28)),
               ((0.100, -0.011, 0.001), -9, (0.032, 0.024, 0.020), 0.0085, (26, 52, 32)),
               ((0.089, -0.029, -0.002), -20, (0.025, 0.018, 0.017), 0.0074, (30, 46, 30))]
    tips = []
    for mcp, spread, lens, r, curl in fingers:
        pts = [np.array(mcp)]; a = 0.0; sp = np.radians(spread)
        for ln, c in zip(lens, curl):
            a += np.radians(c)
            d = np.array([np.cos(a) * np.cos(sp), np.cos(a) * np.sin(sp), -np.sin(a)])
            pts.append(pts[-1] + ln * d)
        L.u(Tube([P(*p) for p in pts], [r, r * 0.93, r * 0.86, r * 0.74]), 0.0045)
        L.u(Sphere(P(*(pts[0] + [0, 0, 0.0045])), r * 1.02), 0.004)
        L.u(Sphere(P(*pts[1]), r * 0.98), 0.002)
        L.u(Sphere(P(*pts[2]), r * 0.88), 0.002)
        L.u(Capsule(P(0.012, mcp[1] * 0.45, 0.0125), P(mcp[0], mcp[1], mcp[2] + 0.0075), 0.0032), 0.004)   # tendon
        bn = np.array([np.sin(a) * np.cos(sp), np.sin(a) * np.sin(sp), np.cos(a)])
        tips.append((P(*pts[-1]), X.M @ d, X.M @ bn, r * 0.74))
    # thumb
    t0 = np.array([0.022, 0.030, -0.006])
    t1 = t0 + 0.046 * unit((0.62, 0.72, -0.30))
    t2 = t1 + 0.034 * unit((0.80, 0.50, -0.33))
    t3 = t2 + 0.029 * unit((0.86, 0.25, -0.44))
    L.u(Tube([P(*t0), P(*t1), P(*t2), P(*t3)], [0.0125, 0.0105, 0.0095, 0.0080]), 0.006)
    L.u(Sphere(P(*t1), 0.0112), 0.003)
    L.u(Sphere(P(*t2), 0.0098), 0.002)
    d = unit(t3 - t2); bn = unit(np.cross(np.cross(d, (0.3, 0.6, 0.74)), d))
    tips.append((P(*t3), X.M @ d, X.M @ bn, 0.0080))
    HAND_TIPS[s] = tips
    return L


def build_legs():
    L = Layer()
    for s in (1, -1):
        H, K, A = mx(HIPJ, s), mx(KNEE, s), mx(ANK, s)
        L.u(Capsule(H, K, 0.078, 0.052), 0.02)
        L.u(Capsule(K, A + v3(0, 0, 0.03), 0.050, 0.036), 0.015)
        L.u(Sphere(K + v3(0, -0.028, 0.0), 0.030), 0.015)                                   # patella
        L.u(Ellipsoid(K + v3(0, 0.03, -0.14), (0.045, 0.045, 0.10)), 0.03)                   # calf
    return L


HEAD = build_head()
EYES = build_eyes()
TEETH = build_teeth()
TORSO = build_torso()
ARMS = {s: build_arm(s) for s in (1, -1)}
HANDS = {s: build_hand(s) for s in (1, -1)}
LEGS = build_legs()

HEAD_LO = hp(-100, -135, -110); HEAD_HI = hp(100, 115, 140)


def skin_parts(P, margin=0.02):
    """Returns dict of skin sub-fields: head, torso, arms (min of both), hands, legs."""
    n = len(P)
    plo, phi = P.min(0), P.max(0)
    out = {}
    if (phi > HEAD_LO - margin - 0.03).all() and (plo < HEAD_HI + margin + 0.03).all():
        Pw = head_warp(P)
        out['head'] = HEAD.eval(Pw, margin + 0.026)
        out['eye'] = EYES.eval(Pw, margin)
        out['teeth'] = TEETH.eval(Pw, margin)
    else:
        out['head'] = np.full(n, BIG, F); out['eye'] = out['head']; out['teeth'] = out['head']
    mg = margin + 0.04           # must cover 1.3 x the blend radii used in skin_union
    out['torso'] = TORSO.eval(P, mg)
    out['arms'] = np.minimum(ARMS[1].eval(P, mg), ARMS[-1].eval(P, mg))
    out['hands'] = np.minimum(HANDS[1].eval(P, mg), HANDS[-1].eval(P, mg))
    out['legs'] = LEGS.eval(P, mg)
    return out


def skin_union(sp):
    d = smin(sp['head'], sp['torso'], 0.018)
    d = smin(d, sp['arms'], 0.02)
    d = smin(d, sp['hands'], 0.012)
    d = smin(d, sp['legs'], 0.03)
    return d


# ----------------------------------------------------------------------------- wounds, hair, detail
RIB_C = v3(-0.1015, -0.0413, 1.205)        # on the skin, right lower ribs
_RC = (0.0, 0.024, 1.275); _RR = (0.148, 0.105, 0.185)


def _rib_paths():
    out = []
    for i in (-1, 0, 1):
        pts = []
        for th in np.linspace(192, 252, 9):
            z = 1.205 + i * 0.031 + 0.0006 * (222 - th)
            sc = np.sqrt(max(1 - ((z - _RC[2]) / _RR[2]) ** 2, 0.05)) * 0.945
            a = np.radians(th)
            pts.append((_RR[0] * sc * np.cos(a), _RC[1] + _RR[1] * sc * np.sin(a), z))
        out.append(pts)
    return out


RIBS = Layer()
for _p in _rib_paths():
    RIBS.u(STube(_p, 0.0052, 3))

W_RIB = Noisy(Ellipsoid(RIB_C, (0.034, 0.021, 0.056), rotm(0, 0, 132)), 0.004, 80.0, seed=13)
W_NECK = Noisy(Sphere((0.057, -0.004, 1.532), 0.021), 0.0035, 95.0, seed=14)
_FA = mx(EL + 0.50 * (WR - EL), -1)
_FA_OUT = unit(np.cross(unit(mx(WR, -1) - mx(EL, -1)), v3(0, -1, 0)) * -1)
W_ARM = Noisy(Ellipsoid(_FA + 0.036 * _FA_OUT, (0.030, 0.014, 0.014), frame(unit(mx(WR, -1) - mx(EL, -1)), _FA_OUT)), 0.003, 110.0, seed=15)
W_HEAD = Noisy(Capsule(hp(-40, -84, 60), hp(-14, -96, 80), 2.6 * mm, 1.6 * mm), 0.0012, 200.0, seed=16)
W_MOUTH = Ellipsoid(hp(0, -72, -53), (0.0235, 0.0255, 0.0135))
W_CHEEK = Capsule(hp(28, -84, -50), hp(41, -57, -47.5), 11.5 * mm, 10 * mm)
WOUNDS = Layer()
WOUNDS.sub(W_RIB, 0.003).sub(W_NECK, 0.003).sub(W_ARM, 0.002).sub(W_HEAD, 0.001)


def skin_detail(P, sp):
    """Micro / meso displacement of the skin (positive = outward). Bake only."""
    d = 0.00045 * gnoise(P, 55.0, 61) + 0.00022 * gnoise(P, 140.0, 62) + 0.00009 * gnoise(P, 620.0, 63)
    f1, f2 = worley(P, 230.0, 64)
    d -= 0.00020 * sstep(0.09, 0.0, f2 - f1)                                   # fine crease network
    zl = P[:, 2] - F(HEAD_O[2]); y = P[:, 1]; x = P[:, 0]
    wob = 0.9 * gnoise(P, 28.0, 65)
    fore = sstep(0.040, 0.050, zl) * sstep(0.092, 0.080, zl) * sstep(-0.070, -0.082, y)
    d -= 0.00055 * fore * sstep(0.30, 0.0, np.abs(np.sin(zl * (np.pi / 0.0078) + wob)))
    neck = sstep(-0.19, -0.17, zl) * sstep(-0.085, -0.10, zl)
    d -= 0.00050 * neck * sstep(0.25, 0.0, np.abs(np.sin(zl * (np.pi / 0.011) + wob * 1.3 + 2.0 * x * 10)))
    crow = sstep(0.045, 0.052, np.abs(x)) * sstep(0.070, 0.062, np.abs(x)) * sstep(0.004, 0.012, zl) * sstep(0.036, 0.028, zl)
    d -= 0.00040 * crow * sstep(0.3, 0.0, np.abs(np.sin((zl + 0.5 * np.abs(x)) * (np.pi / 0.0042))))
    limb = np.minimum(sp['arms'], sp['hands']) < 0.004
    if limb.any():
        v = sstep(0.075, 0.0, np.abs(gnoise(P[limb], 36.0, 66))) * sstep(-0.1, 0.25, gnoise(P[limb], 9.0, 67))
        d[limb] += 0.00065 * v
    return d


def skin_post(P, d, sp, margin, detail):
    d = WOUNDS.eval(P, margin, d=d)
    d = smin(d, RIBS.eval(P, margin + 0.004), 0.002)
    if detail:
        m = d < 0.006
        if m.any():
            spm = {k: v[m] for k, v in sp.items()}
            d[m] = d[m] - skin_detail(P[m], spm)
    return d


def flesh_mask(P, sp):
    n = len(P)
    f = np.zeros(n, F)
    for w in (W_RIB, W_NECK, W_ARM, W_HEAD, W_CHEEK):
        lo, hi = w.lo - 0.004, w.hi + 0.004
        m = ((P >= lo) & (P <= hi)).all(1)
        if m.any():
            f[m] = np.maximum(f[m], (w(P[m]) < 0.0012).astype(F))
    m = ((P >= W_MOUTH.lo) & (P <= W_MOUTH.hi)).all(1)
    if m.any():
        f[m] = np.maximum(f[m], (W_MOUTH(P[m]) < 0.0).astype(F))
    return f


def rib_dist(P):
    return RIBS.eval(P, 0.02)


def scalp_mask(P):
    """Soft 0..1 mask of where hair grows (receding, with a bare crown)."""
    q = (P - HEAD_O.astype(F)) / F(mm)
    x, y, z = q[:, 0], q[:, 1], q[:, 2]
    line = np.interp(y, [-95, -78, -40, -5, 20, 45, 80, 110], [96, 86, 58, 40, 34, -8, -44, -50]).astype(F)
    line = line + 14.0 * sstep(40.0, 62.0, np.abs(x)) * sstep(-20.0, -60.0, y)        # receding temples
    m = sstep(0.0, 9.0, z - line)
    crown = np.sqrt(x * x + (y - 28.0) ** 2)
    m = m * (1.0 - 0.9 * sstep(52.0, 26.0, crown) * sstep(95.0, 112.0, z))            # balding crown
    ear = np.sqrt((np.abs(x) - 74.0) ** 2 + (y - 10.0) ** 2 + (z - 2.0) ** 2)
    return m * sstep(20.0, 34.0, ear)


def hair_cover(P):
    """Patchy coverage 0..1 (matted thin hair with bald patches)."""
    n = gnoise(P, 21.0, 71) + 0.5 * gnoise(P, 55.0, 72)
    return scalp_mask(P) * sstep(-0.42, 0.05, n)


def hair_field(P, sp, margin, detail):
    d = np.full(len(P), BIG, F)
    m = sp['head'] < 0.02
    if not m.any():
        return d
    Pm = P[m]
    cov = hair_cover(Pm)
    th = 0.0042 * cov
    if detail:
        q = (Pm - HEAD_O.astype(F))
        phi = np.arctan2(q[:, 0], q[:, 1] - 0.028)
        rad = np.sqrt(q[:, 0] ** 2 + (q[:, 1] - 0.028) ** 2 + (q[:, 2] - 0.13) ** 2)
        Q = np.stack([phi * 46.0, rad * 26.0, q[:, 2] * 12.0], 1).astype(F)
        strand = gnoise(Q, 1.0, 73) + 0.6 * gnoise(Q * F(2.3), 1.0, 74)
        th = th + cov * 0.0009 * strand
    d[m] = sp['head'][m] - th + 0.0004
    return d
