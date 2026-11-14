# Valle Morta utility helicopter: the whole model as numpy geometry (no bpy here).
# Metres, Blender axes: +X starboard, +Y forward (nose), +Z up, origin on the ground under the rotor mast.
# The exporter turns this into glTF +Y up with the nose along -Z, the frame the game's Helicopter class uses.
# Every face carries a material id (pid, see the constants) and a node index (NODES).
import numpy as np
from math import radians, pi, sin, cos

NODES = ['Body', 'DoorR', 'DoorL', 'MainRotor', 'Blades', 'TailRotor', 'TailBlades']
BODY, DOORR, DOORL, MROT, BLADES, TROT, TBLADES = range(7)
RZ = 3.80                               # main rotor hub height
TRC = np.array([-0.40, -9.86, 3.70])    # tail rotor hub (port side of the fin)
ROTOR_R, TAIL_R = 7.0, 1.3
# material ids (pid red channel = id / 64)
HULL, WALK, SEAL, EXH, INTAKE, LOUVRE, RAIL, SOOT, GEARP = 1, 2, 3, 4, 5, 6, 7, 8, 9
LINING, INTP, FLOOR, CANVAS, ALUT, WEB, BUCKLE, PANEL, DIAL, WHITE, CABLE, SEATA, CUSH, RED, TIEDOWN, SWITCH, SCREEN = range(10, 27)
STEEL, DARK, RUBBER, BLADE, TIP, ALU, ANT, LE = range(30, 38)
SUIT, VEST, HELMET, VISOR, SKIN, GLOVE, BOOT, BLACK = range(40, 48)
GLASS = 50
L_RED, L_GREEN, L_WHITE, L_BEACON = 60, 61, 62, 63
L_DIAL, L_SCREEN = 56, 57

RNG = np.random.default_rng(11)


def nrm(v):
    v = np.asarray(v, float)
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def rotx(d):
    c, s = cos(radians(d)), sin(radians(d)); return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def roty(d):
    c, s = cos(radians(d)), sin(radians(d)); return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rotz(d):
    c, s = cos(radians(d)), sin(radians(d)); return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


class MB:
    """mesh builder: vertices, faces, per-face material id, part random, node"""
    def __init__(s): s.V, s.F, s.M, s.R, s.N, s.n = [], [], [], [], [], 0

    def add(s, V, F, mid, node=0):
        V = np.asarray(V, float).reshape(-1, 3); o = s.n; s.V.append(V); s.n += len(V); r = float(RNG.random())
        many = isinstance(mid, (list, np.ndarray))
        for k, f in enumerate(F):
            s.F.append([o + i for i in f]); s.M.append(int(mid[k]) if many else int(mid)); s.R.append(r); s.N.append(node)

    def verts(s): return np.concatenate(s.V) if s.V else np.zeros((0, 3))

    def tris(s): return sum(len(f) - 2 for f in s.F)


def grid(mb, P, mid, node=0, wrap=False, keep=None, cap0=False, cap1=False):
    """quads over a (nu, nv, 3) grid; outward = du x dv. cap0/cap1 close the first / last ring."""
    P = np.asarray(P, float); nu, nv = P.shape[:2]; I = np.arange(nu * nv).reshape(nu, nv)
    nj = nv if wrap else nv - 1
    ma = np.broadcast_to(np.asarray(mid), (nu - 1, nj))
    F, M = [], []
    for i in range(nu - 1):
        for j in range(nj):
            if keep is not None and not keep[i, j]: continue
            j1 = (j + 1) % nv
            F.append([I[i, j], I[i + 1, j], I[i + 1, j1], I[i, j1]]); M.append(ma[i, j])
    if cap0: F.append(list(I[0])); M.append(ma[0, 0])
    if cap1: F.append(list(I[-1][::-1])); M.append(ma[-1, 0])
    mb.add(P.reshape(-1, 3), F, M, node)


def tube(mb, pts, r, mid, node=0, sides=10, caps=True, up=None, ell=(1, 1), closed=False):
    P = np.asarray(pts, float); n = len(P); r = np.broadcast_to(np.asarray(r, float), (n,))
    T = nrm(np.gradient(P, axis=0))
    if closed: T[0] = T[-1] = nrm(P[1] - P[-2])
    u = np.asarray(up, float) if up is not None else (np.array([0, 0, 1.]) if abs(T[0, 2]) < 0.95 else np.array([1., 0, 0]))
    N = nrm(u - T[0] * np.dot(u, T[0]))
    ang = np.linspace(0, 2 * pi, sides, endpoint=False); ca, sa = np.cos(ang) * ell[0], np.sin(ang) * ell[1]
    rings = []
    for i in range(n):
        if i: N = nrm(N - T[i] * np.dot(N, T[i]))
        B = np.cross(N, T[i])
        rings.append(P[i] + r[i] * (ca[:, None] * N + sa[:, None] * B))
    grid(mb, np.array(rings), mid, node, wrap=True, cap0=caps and not closed, cap1=caps and not closed)


_S = np.array([[(i & 1) * 2 - 1, ((i >> 1) & 1) * 2 - 1, ((i >> 2) & 1) * 2 - 1] for i in range(8)], float)
_BF = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]]


def box(mb, c, h, mid, node=0, R=None):
    R = np.eye(3) if R is None else np.asarray(R, float)
    mb.add(np.asarray(c, float) + (_S * np.asarray(h, float)) @ R.T, _BF, mid, node)


def frame(e1, up):
    e1 = nrm(e1); e3 = nrm(np.asarray(up, float) - e1 * np.dot(up, e1)); e2 = np.cross(e3, e1)
    return np.stack([e1, e2, e3], 1)


def beam(mb, a, b, w, t, mid, node=0, up=(0, 0, 1)):
    a, b = np.asarray(a, float), np.asarray(b, float)
    box(mb, (a + b) / 2, (np.linalg.norm(b - a) / 2, w, t), mid, node, frame(b - a, np.asarray(up, float)))


def ellipsoid(mb, c, rad, mid, node=0, R=None, nu=9, nv=14):
    R = np.eye(3) if R is None else np.asarray(R, float)
    el = np.linspace(-pi / 2 + 0.2, pi / 2 - 0.2, nu); az = -np.linspace(0, 2 * pi, nv, endpoint=False)
    E, A = np.meshgrid(el, az, indexing='ij')
    L = np.stack([rad[0] * np.cos(E) * np.cos(A), rad[1] * np.cos(E) * np.sin(A), rad[2] * np.sin(E)], -1)
    grid(mb, np.asarray(c, float) + L @ R.T, mid, node, wrap=True, cap0=True, cap1=True)


def foil(n=13, t=0.12):
    x = (1 - np.cos(np.linspace(0, pi, n))) / 2
    yt = 5 * t * (0.2969 * np.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    lower = [(x[i], -yt[i] / t) for i in range(n - 1, 0, -1)]
    upper = [(x[i], yt[i] / t) for i in range(0, n - 1)]
    return np.array(lower + upper)      # thickness normalised to 1 (scaled by t/c per section)


def wing(mb, secs, mid, node=0, n=13):
    """secs: (pitch-axis point, e_c (towards the leading edge), e_n (= e_c x e_r), chord, t/c)"""
    fp = foil(n); rings = []
    for c, ec, en, ch, tc in secs:
        u = (0.25 - fp[:, 0]) * ch; w = fp[:, 1] * ch * tc
        rings.append(np.asarray(c, float) + u[:, None] * np.asarray(ec, float) + w[:, None] * np.asarray(en, float))
    grid(mb, np.array(rings), mid, node, wrap=True, cap0=True, cap1=True)
    return len(fp)


def pitched(ec, en, p):
    p = radians(p); ec, en = np.asarray(ec, float), np.asarray(en, float)
    return ec * cos(p) + en * sin(p), en * cos(p) - ec * sin(p)


# ---------------------------------------------------------------- fuselage surface
DZ = -0.14     # the finished body (all but the skids and the lower cross tubes) sits this much lower than modelled
# Fuselage stations: y, half width, roof z, keel z, waist z (widest line), squareness.
# A boxy cabin with flat sides and floor, a nose whose roof drops along the windscreen to a blunt rounded chin,
# and a short tailcone whose belly sweeps up into the slender boom.
HK = np.array([
    [-5.05, 0.44, 2.56, 1.70, 2.12, 2.6],
    [-4.65, 0.60, 2.52, 1.50, 2.00, 3.2],
    [-4.20, 0.86, 2.50, 1.22, 1.82, 4.2],
    [-3.75, 1.12, 2.50, 0.95, 1.58, 5.0],
    [-3.35, 1.22, 2.50, 0.80, 1.45, 5.6],
    [1.95, 1.22, 2.50, 0.80, 1.45, 5.6],
    [2.70, 1.21, 2.47, 0.80, 1.45, 5.2],
    [3.30, 1.18, 2.31, 0.81, 1.42, 4.6],
    [3.80, 1.10, 2.03, 0.84, 1.38, 3.9],
    [4.25, 0.98, 1.74, 0.88, 1.32, 3.3],
    [4.60, 0.84, 1.50, 0.94, 1.24, 2.8],
    [5.12, 0.70, 1.30, 1.04, 1.18, 2.3]])
FY = np.arange(-5.05, 5.1201, 0.01)
_raw = np.stack([np.interp(FY, HK[:, 0], HK[:, k]) for k in range(1, 6)], 1)
_k = np.exp(-0.5 * (np.arange(-30, 31) / 10.0) ** 2); _k /= _k.sum()
_sm = np.stack([np.convolve(np.pad(_raw[:, k], 30, mode='edge'), _k, mode='valid') for k in range(5)], 1)
SM = np.stack([_sm[:, 0], _sm[:, 1] - _sm[:, 3], _sm[:, 3] - _sm[:, 2], _sm[:, 3], _sm[:, 4]], 1)   # hw, ht, hb, cz, n
# the nose tip: an elliptic round-off ahead of y 4.55, its centre line dropping to the chin
_t = np.clip((FY - 4.55) / 0.57, 0, 1); _f = np.sqrt(np.clip(1 - _t ** 2, 0, 1)); _i = np.searchsorted(FY, 4.55)
for _c in (0, 1, 2): SM[:, _c] = np.where(FY > 4.55, SM[_i, _c] * _f, SM[:, _c])
SM[:, 3] = np.where(FY > 4.55, SM[_i, 3] + (1.16 - SM[_i, 3]) * _t ** 1.5, SM[:, 3])
Y0, Y1 = FY[0], FY[-1]


def hp(y):
    return [np.interp(y, FY, SM[:, k]) for k in range(5)]


def S(y, a, off=0.0):
    """fuselage surface at station y, angle a (radians; 0 starboard, pi/2 top); off: along the outward normal"""
    y, a = np.broadcast_arrays(np.asarray(y, float), np.asarray(a, float))
    hw, ht, hb, cz, n = hp(y); c, s = np.cos(a), np.sin(a); e = 2 / n
    x = np.sign(c) * np.abs(c) ** e * hw * (1 - 0.08 * np.clip(s, 0, 1) ** 1.5)
    z = cz + np.sign(s) * np.abs(s) ** e * np.where(s > 0, ht, hb)
    P = np.stack([x, y, z], -1)
    if off:
        d = 1e-3; yc = np.clip(y, Y0 + d, Y1 - d)
        N = nrm(np.cross(S(yc + d, a) - S(yc - d, a), S(yc, a + d) - S(yc, a - d)))
        P = P + N * off
    return P


def Sd(y, ad, off=0.0): return S(y, np.radians(ad), off)


def side_angle(y, z):
    """starboard angle (radians) where the fuselage surface reaches height z"""
    hw, ht, hb, cz, n = hp(y); d = (z - cz) / np.where(z > cz, ht, hb)
    return np.arcsin(np.clip(np.sign(d) * np.abs(d) ** (n / 2), -1, 1))


# regions on the skin: y0, y1, a0, a1 (degrees), kind (1 opening, 2 glass)
REG = [(-1.0, 1.1, -52, 37, 1), (-1.0, 1.1, 143, 232, 1),
       (2.05, 3.22, -4, 37, 2), (2.05, 3.22, 143, 184, 2),          # glazed cockpit doors
       (2.35, 3.0, -44, -16, 2), (2.35, 3.0, 196, 224, 2),          # lower door windows
       (3.36, 4.55, 30, 86.5, 2), (3.36, 4.55, 93.5, 150, 2),       # two-piece windscreen
       (2.6, 3.3, 58, 86.5, 2), (2.6, 3.3, 93.5, 122, 2),           # overhead windows
       (3.68, 4.74, -66, -20, 2), (3.68, 4.74, 200, 246, 2),        # chin windows
       (-2.6, -1.42, 6, 32, 2), (-2.6, -1.42, 148, 174, 2)]         # cabin windows aft of the doors


def stations(base, bps, tol):
    bps = np.unique(np.asarray(bps, float)); base = np.asarray(base, float)
    keep = [v for v in base if np.min(np.abs(bps - v)) > tol]
    return np.unique(np.concatenate([keep, bps]))


def hull(G):
    ybp = [Y0, Y1, 4.85, 4.95, 5.02, 5.07, 5.10, -3.35, 1.95] + [v for r in REG for v in r[:2]]
    ys = stations(np.concatenate([np.arange(Y0, -3.3, 0.12), np.arange(-3.3, 1.95, 0.3), np.arange(1.95, Y1, 0.09)]), ybp, 0.03)
    abp = sorted({v for r in REG for v in r[2:4]} | {-45, 35, 145, 225})
    As = stations(np.arange(-90, 270, 6.0), abp, 1.6)
    A = np.radians(As)
    P = S(ys[:, None], A[None, :])
    yc = (ys[:-1] + ys[1:]) / 2; an = np.append(As[1:], As[0] + 360); ac = (As + an) / 2
    kind = np.zeros((len(ys) - 1, len(As)), int)
    for y0, y1, a0, a1, k in REG:
        kind[(yc[:, None] > y0) & (yc[:, None] < y1) & (ac[None, :] > a0) & (ac[None, :] < a1)] = k
    grid(G['hull'], P, HULL, BODY, wrap=True, keep=kind == 0, cap0=True, cap1=True)
    Pg = np.nan_to_num(S(ys[:, None], A[None, :], off=-0.014))
    grid(G['glass'], Pg, GLASS, BODY, wrap=True, keep=kind == 2)
    # rubber seals round the glazing, frame bars where two panes meet
    for y0, y1, a0, a1, k in REG:
        if k == 2: outline(G['paint'], y0, y1, a0, a1, 0.006, 0.016, SEAL)
    outline(G['paint'], 1.95, 3.3, -48, 40, 0.004, 0.011, SEAL); outline(G['paint'], 1.95, 3.3, 140, 228, 0.004, 0.011, SEAL)
    # windscreen centre post and the bow frame between overhead and windscreen panes (painted, proud of the skin)
    tube(G['paint'], Sd(np.linspace(2.58, 4.57, 16), 90, 0.006), 0.032, HULL, sides=6, ell=(1, 0.6))
    tube(G['paint'], Sd(3.33, np.linspace(30, 150, 18), 0.006), 0.026, HULL, sides=6, ell=(1, 0.6))
    for y0, y1 in ((-1.0, 1.1),):     # cabin door frames: a lip round the openings
        outline(G['paint'], y0 - 0.02, y1 + 0.02, -53.5, 38.5, 0.008, 0.018, RAIL)
        outline(G['paint'], y0 - 0.02, y1 + 0.02, 141.5, 233.5, 0.008, 0.018, RAIL)


def outline(mb, y0, y1, a0, a1, off, r, mid, node=BODY, sides=5):
    n = 14
    pts = np.concatenate([Sd(np.linspace(y0, y1, n), a0, off), Sd(y1, np.linspace(a0, a1, n), off)[1:],
                          Sd(np.linspace(y1, y0, n), a1, off)[1:], Sd(y0, np.linspace(a1, a0, n), off)[1:]])
    tube(mb, pts, r, mid, node, sides=sides, caps=False, closed=True)


def doors(G):
    """sliding cabin doors, slid aft (open): the skin offset 4.5 cm, shifted 2.2 m back; a window in each"""
    dys = np.linspace(-1.06, 1.16, 13)
    dys = np.unique(np.concatenate([dys, [-0.7, 0.98]]))
    for node, das, wa in ((DOORR, np.unique(np.concatenate([np.linspace(-56, 41, 24), [4, 33]])), (4, 33)),
                          (DOORL, np.unique(np.concatenate([np.linspace(139, 236, 24), [147, 176]])), (147, 176))):
        P = Sd(dys[:, None], das[None, :], 0.045); P[..., 1] -= 2.2
        Pg = Sd(dys[:, None], das[None, :], 0.03); Pg[..., 1] -= 2.2
        yc = (dys[:-1] + dys[1:]) / 2; ac = (das[:-1] + das[1:]) / 2
        win = (yc[:, None] > -0.7) & (yc[:, None] < 0.98) & (ac[None, :] > wa[0]) & (ac[None, :] < wa[1])
        grid(G['hull'], P, HULL, node, keep=~win)
        grid(G['glass'], Pg, GLASS, node, keep=win)
        sy = -2.2
        pts = np.concatenate([Sd(np.linspace(-0.7, 0.98, 10), wa[0], 0.05), Sd(0.98, np.linspace(*wa, 8), 0.05)[1:],
                              Sd(np.linspace(0.98, -0.7, 10), wa[1], 0.05)[1:], Sd(-0.7, np.linspace(wa[1], wa[0], 8), 0.05)[1:]])
        pts[:, 1] += sy
        tube(G['paint'], pts, 0.014, SEAL, node, sides=5, caps=False, closed=True)
        mid = (das[0] + das[-1]) / 2
        h = Sd(0.95, mid - 8 if node == DOORR else mid + 8, 0.06); h[1] += sy        # handle
        box(G['mech'], h, (0.012, 0.09, 0.022), DARK, node)
        for yy in (-1.0, 1.1):                      # rollers in the tracks
            for aa in (das[-1] - 1.5, das[0] + 1.5):
                p = Sd(yy, aa, 0.035); p[1] += sy; box(G['mech'], p, (0.03, 0.04, 0.03), DARK, node)
        for yy in np.linspace(-0.9, 1.0, 5):       # stiffener beads, below the window
            a = np.linspace(das[0] + 2, wa[0] - 3, 10) if node == DOORR else np.linspace(wa[1] + 3, das[-1] - 2, 10)
            p = Sd(yy, a, 0.052); p[:, 1] += sy; tube(G['paint'], p, 0.008, HULL, node, sides=4)
    for a in (40.5, -54.5, 139.5, 234.5):           # tracks
        tube(G['mech'], Sd(np.linspace(-3.32, 1.12, 10), a, 0.02), 0.02, RAIL, BODY, sides=5)


def cowling(G):
    # one flat-sided housing on the roof: transmission fairing forward, the raised engine deck aft of the mast
    m = G['top']
    ys = stations(np.linspace(-3.9, 1.65, 34), [0.0, -2.6], 0.05); A = np.radians(np.linspace(-20, 200, 44))
    hw = np.interp(ys, CK[:, 0], CK[:, 1]); ht = np.interp(ys, CK[:, 0], CK[:, 2]) - 2.40; cz = 2.40; e = 2 / 5.0
    c, s = np.cos(A)[None, :], np.sin(A)[None, :]
    x = np.sign(c) * np.abs(c) ** e * hw[:, None] * (1 - 0.06 * np.clip(s, 0, 1)); z = cz + np.sign(s) * np.abs(s) ** e * np.where(s > 0, ht[:, None], 0.25)
    P = np.stack([x, np.broadcast_to(ys[:, None], x.shape), z], -1)
    grid(m, P, HULL, BODY, cap0=True, cap1=True)
    ellipsoid(m, (0, 0.05, cowl_top(0.05) - 0.02), (0.34, 0.5, 0.13), HULL)          # mast fairing
    for sx in (-1, 1):
        fx = sx * 0.885
        # engine air intakes on the deck top either side of the mast: dark mouths with a screen
        p = np.array([sx * 0.52, -0.42, cowl_top(-0.42) + 0.04])
        box(m, p, (0.2, 0.26, 0.07), HULL); box(m, p + (0, 0.262, 0.0), (0.17, 0.004, 0.052), INTAKE)
        for k in range(5): box(G['mech'], p + (sx * 0, 0.268, -0.04 + 0.02 * k), (0.17, 0.003, 0.002), STEEL)
        # cooling grilles on the flat flanks (louvres), panel hinge line and latches
        for k in range(10):
            box(m, (fx + sx * 0.006, -0.9 - 0.1 * k, 2.82), (0.006, 0.035, 0.14), LOUVRE, R=rotz(sx * 0) @ rotx(0))
        box(m, (fx + sx * 0.002, -1.35, 2.82), (0.004, 0.52, 0.17), WALK)
        tube(m, [(fx * 0.97, 0.3, 3.06), (fx * 0.97, -2.6, 3.06)], 0.012, WALK, sides=4)
        for y in (0.6, 0.1, -0.5, -1.95, -2.4):
            box(G['mech'], (fx + sx * 0.012, y, 2.62), (0.008, 0.035, 0.022), DARK)
            box(G['mech'], (fx + sx * 0.012, y, 2.98), (0.008, 0.035, 0.022), DARK)
        # exhaust stacks, angled up, out and aft, with a sooty bore
        ex = np.array([[sx * 0.40, -2.62, 2.98], [sx * 0.45, -2.85, 3.14], [sx * 0.56, -3.12, 3.30], [sx * 0.64, -3.30, 3.38]])
        tube(m, ex, [0.19, 0.19, 0.185, 0.18], EXH, sides=18)
        d = nrm(ex[-1] - ex[-2]); tube(m, [ex[-1] - d * 0.06, ex[-1] + d * 0.003], 0.155, SOOT, sides=18)
        tube(m, [ex[-1] - d * 0.01, ex[-1] + d * 0.006], 0.192, EXH, sides=18)
    # oil cooler grille on the deck top aft, walkway pads on the transmission fairing
    for k in range(8):
        box(m, (0, -1.75 - k * 0.085, cowl_top(-1.75 - k * 0.085) + 0.005), (0.26, 0.018, 0.012), LOUVRE, R=rotx(-20))
    box(m, (0, -2.05, cowl_top(-2.05) - 0.01), (0.31, 0.38, 0.02), WALK)
    for sx in (-1, 1): box(m, (sx * 0.5, 1.05, cowl_top(1.05) - 0.005), (0.2, 0.3, 0.012), WALK, R=roty(sx * -18))


# roof housing profile: y, half width, top z
CK = np.array([[-3.9, 0.20, 2.58], [-3.55, 0.55, 2.86], [-3.15, 0.84, 3.08], [-2.6, 0.89, 3.16], [-0.1, 0.89, 3.16], [0.25, 0.89, 3.0],
               [0.9, 0.88, 2.96], [1.3, 0.72, 2.84], [1.65, 0.28, 2.54]])


def cowl_top(y): return float(np.interp(y, CK[:, 0], CK[:, 2]))


def boom_cz(y): t = np.clip((-4.5 - y) / 5.4, 0, 1); return 2.13 + 0.33 * t


def boom_r(y): t = np.clip((-4.5 - y) / 5.4, 0, 1); return 0.41 - 0.21 * t ** 0.9


def tail(G):
    m = G['top']
    ys = np.linspace(-4.5, -9.9, 24)
    tube(m, [(0, y, boom_cz(y)) for y in ys], [boom_r(y) for y in ys], HULL, sides=24, up=(1, 0, 0), ell=(1, 1.12))
    for y in np.linspace(-5.0, -9.4, 9):                       # frame bands round the boom
        tube(m, [(0, y + 0.012, boom_cz(y)), (0, y - 0.012, boom_cz(y))], boom_r(y) + 0.004, HULL, sides=24, up=(1, 0, 0), ell=(1, 1.12), caps=False)
    # driveshaft cover with hanger bulges
    ys2 = np.linspace(-3.9, -9.4, 16)
    tube(m, [(0, y, boom_cz(y) + boom_r(y) * 1.1 - 0.02) for y in ys2], 0.075, HULL, sides=10, ell=(1.3, 1))
    for y in np.linspace(-4.6, -9.0, 6): ellipsoid(m, (0, y, boom_cz(y) + boom_r(y) * 1.1 + 0.04), (0.1, 0.16, 0.06), HULL)
    # vertical fin
    secs = []
    for t in np.linspace(0, 1, 7):
        z = 2.30 + 2.0 * t; le = -8.95 - 0.85 * t ** 1.1; ch = 1.40 - 0.80 * t
        secs.append(((0, le - 0.25 * ch, z), (0, 1, 0), (1, 0, 0), ch, 0.15 - 0.05 * t))
    wing(m, secs, HULL)
    # horizontal stabiliser
    secs = [((x, -7.55 - 0.05 * abs(x), 2.40), (0, 1, 0), (0, 0, -1), 0.62 - 0.12 * max(0, abs(x) - 1.2) / 0.35, 0.12) for x in (-1.55, -1.2, 1.2, 1.55)]
    wing(m, secs, HULL)
    for sx in (-1, 1):
        box(m, (sx * 1.56, -7.62, 2.40), (0.012, 0.3, 0.12), HULL)       # endplates
    # tail gearbox fairing, tail skid
    ellipsoid(m, (-0.14, TRC[1], TRC[2]), (0.17, 0.32, 0.21), HULL)
    ellipsoid(m, (0, TRC[1] + 0.25, 2.90), (0.12, 0.45, 0.16), HULL)
    tube(G['mech'], [(0, -8.75, 2.22), (0, -9.25, 1.72), (0, -9.55, 1.50), (0, -9.75, 1.46)], 0.028, GEARP, sides=8)
    # ventral strakes
    beam(m, (0.12, -4.6, 1.78), (0.08, -7.0, 2.06), 0.008, 0.05, HULL, up=(0.6, 0, -1))


def gear(G):
    m = G['mech']
    # built after the body was lowered by DZ: heights that touch the body carry DZ, the skids stay on the ground
    zb = 0.80 + DZ                       # keel
    for yc in (1.45, -1.55):
        th = np.radians(np.linspace(90, 0, 12))
        zt = zb - 0.06; rr = zt - 0.12
        right = np.stack([1.36 - rr + rr * np.sin(th), np.full_like(th, yc), 0.12 + rr * np.cos(th)], 1)
        left = right * [-1, 1, 1]
        mid = np.array([[x, yc, zt] for x in np.linspace(-(1.36 - rr) + 0.02, 1.36 - rr - 0.02, 5)])
        tube(m, np.concatenate([left, mid, right[::-1]]), 0.058, GEARP, sides=14)
        box(m, (0, yc, zb - 0.01), (0.66, 0.13, 0.035), DARK)                             # saddle fairing on the belly
        for sx in (-1, 1):
            for dx in (0.42, 0.62):                                                           # belly clamps
                tube(m, [(sx * dx, yc - 0.075, zt), (sx * dx, yc + 0.075, zt)], 0.072, DARK, sides=12)
            box(m, (sx * 1.36, yc, 0.115), (0.075, 0.11, 0.06), DARK)                       # skid saddle
            for dy in (-0.09, 0.09): tube(m, [(sx * 1.36 - 0.08, yc + dy, 0.06), (sx * 1.36 + 0.08, yc + dy, 0.06)], 0.012, STEEL, sides=6)
    for sx in (-1, 1):
        x = sx * 1.36; ph = np.radians(np.linspace(0, 80, 9))
        pts = [(x, y, 0.062) for y in np.linspace(-2.45, 2.55, 12)] + [(x, 2.55 + 0.42 * sin(p), 0.062 + 0.42 * (1 - cos(p))) for p in ph[1:]]
        tube(m, pts, 0.052, GEARP, sides=14)
        tube(m, [(x, -2.45, 0.062), (x, -2.47, 0.062)], 0.054, DARK, sides=14)              # end cap
        for y0 in (-1.5, 1.3): box(m, (x, y0, 0.008), (0.032, 0.55, 0.008), ALU)            # wear shoes
        for y0 in np.linspace(-2.0, 1.9, 7): box(m, (x, y0, 0.017), (0.036, 0.02, 0.006), STEEL)
        # steps: on the forward cross tube, and the door step on struts
        box(m, (sx * 1.02, 1.45, zb - 0.0), (0.13, 0.12, 0.012), ALU)
        box(m, (sx * 1.08, 0.05, zb - 0.17), (0.11, 0.34, 0.012), ALU)
        for yy in (-0.24, 0.34): beam(m, (sx * 1.1, yy, zb - 0.17), (sx * 0.98, yy, zb + 0.02), 0.025, 0.012, ALU, up=(0, 1, 0))
        # cockpit kick-in step
        p = Sd(2.55, -40 if sx > 0 else 220, 0.0) + (0, 0, DZ); box(m, p, (0.05, 0.08, 0.02), DARK)


def details(G):
    m, p = G['mech'], G['paint']
    # grab handles above the cabin doors, cockpit door handles
    for a in (42.5, 137.5):
        pts = [Sd(0.85, a, -0.01), Sd(0.80, a, 0.06), Sd(-0.6, a, 0.06), Sd(-0.65, a, -0.01)]
        tube(m, pts, 0.014, DARK, sides=6)
    for a in (-10, 190):
        box(m, Sd(2.1, a, 0.012), (0.012, 0.07, 0.02), DARK, R=frame([0, 1., 0], nrm(Sd(2.1, a, 0.1) - Sd(2.1, a))))
    # antennas
    for y in (-5.6, -7.6):
        top = np.array([0, y, boom_cz(y) + boom_r(y) * 1.1 + 0.06])
        box(m, top + (0, -0.06, 0.13), (0.007, 0.11, 0.14), ANT, R=rotx(25))
    for y in (-2.1, 0.4):
        box(m, (0, y, 0.62), (0.007, 0.12, 0.11), ANT, R=rotx(-20))
    zt = boom_cz(-5.3) + boom_r(-5.3) * 1.12
    tube(m, [(0.1, -5.3, zt), (0.1, -5.55, zt + 0.45), (0.1, -5.95, zt + 1.0)], 0.007, ANT, sides=6)
    box(m, (0.1, -5.3, zt), (0.035, 0.05, 0.02), DARK)
    for sx in (-1, 1):                                  # step plates and handholds up the cabin side to the roof
        for y, z in ((1.55, 1.45), (1.55, 1.95)):
            p = Sd(y, side_angle(y, z) if sx > 0 else pi - side_angle(y, z), 0.0)
            if sx > 0: p = p
            box(m, p, (0.02, 0.07, 0.025), DARK)
        tube(m, [Sd(-1.25, 30 if sx > 0 else 150, -0.005), Sd(-1.25, 30 if sx > 0 else 150, 0.05) + (0, 0, 0.0), Sd(-1.55, 30 if sx > 0 else 150, 0.05), Sd(-1.55, 30 if sx > 0 else 150, -0.005)], 0.013, DARK, sides=6)
    # cable cutters on the roof ahead of the transmission fairing and under the chin, with the deflector on the windscreen post
    tube(m, [Sd(3.0, 90, 0.04), Sd(2.6, 90, 0.04) + (0, 0, 0.12)], 0.012, DARK, sides=6)
    box(m, (0, 2.2, 2.55), (0.007, 0.15, 0.12), ANT, R=rotx(-25))
    # wire strike cutters, pitot tubes
    top = Sd(3.1, 90, 0); beam(m, top, (0, 3.6, top[2] + 0.42), 0.008, 0.035, DARK, up=(1, 0, 0))
    bot = Sd(4.45, -90, 0); beam(m, bot, (0, 4.95, 0.55), 0.008, 0.03, DARK, up=(1, 0, 0))
    for a in (62, 118):
        b = Sd(4.72, a, 0)
        tube(m, [b - (0, 0.02, 0.02), b + (0, 0.12, 0.10), b + (0, 0.55, 0.10)], [0.02, 0.016, 0.012], STEEL, sides=8)
    # wipers
    for a in (50, 130):
        tube(m, [Sd(3.42, a, 0.02), Sd(3.95, a + (8 if a < 90 else -8), 0.02)], 0.008, DARK, sides=5)
    # fuel filler, static ports, lifting eyes on the cowl
    box(m, Sd(-2.7, 12, 0.005), (0.004, 0.07, 0.07), DARK, R=frame([0, 0, 1.], [1, 0, 0]))
    for y in (-1.45, 1.15): ellipsoid(m, (0, y, cowl_top(y) + 0.02), (0.03, 0.05, 0.05), STEEL)
    # mirror on the starboard nose
    tube(m, [Sd(4.3, 20, 0), Sd(4.3, 20, 0.25) + (0, 0.1, 0.05)], 0.012, DARK, sides=6)
    ellipsoid(m, Sd(4.3, 20, 0.25) + (0, 0.13, 0.1), (0.08, 0.025, 0.06), DARK)
    # position lights and beacons (Lights group) on dark bases
    L = G['light']
    for a, mid in ((150, L_RED), (30, L_GREEN)):
        b = Sd(1.45, a, 0.0); n_ = nrm(Sd(1.45, a, 0.1) - b)
        box(m, b + n_ * 0.01, (0.05, 0.06, 0.02), DARK, R=frame([0, 1., 0], n_))
        ellipsoid(L, b + n_ * 0.035, (0.035, 0.05, 0.025), mid, R=frame([0, 1., 0], n_))
    ellipsoid(L, (0, -10.47, 2.72), (0.03, 0.04, 0.03), L_WHITE)
    tube(m, [(0, -10.30, 2.72), (0, -10.45, 2.72)], 0.03, DARK, sides=8)
    tube(m, [(0, -3.0, cowl_top(-3.0) - 0.02), (0, -3.0, cowl_top(-3.0) + 0.05)], 0.06, DARK, sides=12); ellipsoid(L, (0, -3.0, cowl_top(-3.0) + 0.08), (0.05, 0.05, 0.05), L_BEACON)
    tube(m, [(0, -2.6, 0.77), (0, -2.6, 0.73)], 0.06, DARK, sides=12); ellipsoid(L, (0, -2.6, 0.70), (0.05, 0.05, 0.045), L_BEACON)


def rotor(G):
    m = G['mech']
    tube(m, [(0, 0, 2.98), (0, 0, RZ + 0.05)], 0.085, STEEL, MROT, sides=16)
    tube(m, [(0, 0, 3.06), (0, 0, 3.17)], 0.14, RUBBER, BODY, sides=16)
    tube(m, [(0, 0, 3.36), (0, 0, 3.41)], 0.27, STEEL, MROT, sides=24)          # rotating swashplate
    tube(m, [(0, 0, 3.295), (0, 0, 3.355)], 0.30, DARK, BODY, sides=24)        # stationary swashplate
    tube(m, [(0, 0, 3.17), (0, 0, 3.30)], 0.12, DARK, BODY, sides=14)          # guide
    for k in range(3):
        a = radians(90 + 120 * k); x, y = 0.26 * cos(a), 0.26 * sin(a)
        tube(m, [(x, y, 2.98), (x, y, 3.13)], 0.045, DARK, BODY, sides=10)
        tube(m, [(x, y, 3.13), (x, y, 3.30)], 0.017, STEEL, BODY, sides=8)
    beam(m, (0.27, 0, 3.39), (0.12, 0, 3.62), 0.018, 0.012, DARK, MROT, up=(0, 1, 0))       # scissors
    beam(m, (0.12, 0, 3.62), (0.07, 0, 3.70), 0.018, 0.012, DARK, MROT, up=(0, 1, 0))
    tube(m, [(0, 0, RZ - 0.14), (0, 0, RZ + 0.13)], 0.15, DARK, MROT, sides=20)
    ellipsoid(m, (0, 0, RZ + 0.15), (0.10, 0.10, 0.07), STEEL, MROT)
    z = np.array([0, 0, 1.]); zc = np.array([0, 0, RZ])
    for b in range(4):
        th = radians(45 + 90 * b); er = np.array([cos(th), sin(th), 0]); ec = np.array([sin(th), -cos(th), 0])
        R = np.stack([er, ec, z], 1)
        for dz in (-0.088, 0.088): box(m, zc + er * 0.25 + z * dz, (0.21, 0.12, 0.02), DARK, MROT, R)
        tube(m, [zc + er * 0.23, zc + er * 0.34], 0.095, RUBBER, MROT, sides=14)
        tube(m, [zc + er * 0.34, zc + er * 0.47, zc + er * 0.68], [0.08, 0.074, 0.064], STEEL, MROT, sides=14)
        for rr in (0.56, 0.63): tube(m, [zc + er * rr - z * 0.085, zc + er * rr + z * 0.085], 0.017, STEEL, MROT, sides=8)
        hb = zc + er * 0.43; tip = zc + er * 0.47 - ec * 0.19 - z * 0.03
        beam(m, hb, tip, 0.03, 0.022, DARK, MROT)
        bot = np.array([*(nrm(tip[:2]) * 0.25), 3.41])
        tube(m, [tip - z * 0.012, bot + z * 0.012], 0.015, STEEL, MROT, sides=8)
        ellipsoid(m, tip - z * 0.01, (0.024, 0.024, 0.024), STEEL, MROT, nu=5, nv=8)
        ellipsoid(m, bot + z * 0.01, (0.024, 0.024, 0.024), STEEL, MROT, nu=5, nv=8)
        a = zc + rotz(30) @ er * 0.16; bb = zc + er * 0.55 + ec * 0.085
        tube(m, [a, bb], [0.034, 0.028], DARK, MROT, sides=10)
        # blade: twist, droop, swept tip, erosion strip on the leading edge
        rs = np.concatenate([[0.62, 0.8, 1.05, 1.4], np.linspace(1.8, 6.6, 13), [6.8, 6.93, 7.0]])
        secs = []
        for r in rs:
            p = 7.0 - 10.0 * (r - 0.62) / 6.38
            ch = np.interp(r, [0.62, 0.8, 1.05, 1.4, 6.6, 6.93, 7.0], [0.13, 0.26, 0.45, 0.53, 0.53, 0.40, 0.26])
            tc = np.interp(r, [0.62, 0.8, 1.05, 1.4], [0.75, 0.32, 0.16, 0.11])
            dz = -0.20 * ((r - 0.62) / 6.38) ** 2
            c = zc + er * r + z * (dz + 0.01) - ec * max(0, r - 6.6) * 0.45
            e1, e2 = pitched(ec, z, p)
            secs.append((c, e1, e2, ch, tc))
        nl = 2 * (13 - 1); mid = np.full((len(rs) - 1, nl), BLADE)
        mid[rs[:-1] >= 6.6, :] = TIP
        mid[(rs[:-1] >= 1.4)[:, None] & np.isin(np.arange(nl), [10, 11, 12, 13])[None, :]] = LE
        mid[rs[:-1] < 1.4, :] = DARK
        wing(m, secs, mid, BLADES)
    # tail rotor: output shaft, hub, two blades
    c = TRC; ax = np.array([-1., 0, 0])
    tube(m, [c + (0.30, 0, 0), c + (0.03, 0, 0)], 0.04, STEEL, TROT, sides=10)
    tube(m, [c + (0.05, 0, 0), c - (0.06, 0, 0)], 0.075, DARK, TROT, sides=14)
    ellipsoid(m, c - (0.07, 0, 0), (0.05, 0.05, 0.05), STEEL, TROT, nu=6, nv=10)
    for b in range(2):
        ph = radians(30 + 180 * b); er = np.array([0, cos(ph), sin(ph)]); ec = np.array([0, -sin(ph), cos(ph)]); en = np.cross(ec, er)
        tube(m, [c + er * 0.05, c + er * 0.2], [0.035, 0.03], STEEL, TROT, sides=10)
        beam(m, c + er * 0.15 + (0.04, 0, 0), c + er * 0.15 + ec * 0.09 + (0.05, 0, 0), 0.012, 0.01, DARK, TROT, up=(1, 0, 0))
        secs = []
        for r in (0.2, 0.3, 0.6, 1.0, 1.22, 1.3):
            e1, e2 = pitched(ec, en, 8 - 6 * (r - 0.2) / 1.1)
            secs.append((c + er * r, e1, e2, 0.2 if r < 1.22 else 0.17, 0.12 if r > 0.25 else 0.3))
        mid = np.full((5, 24), BLADE); mid[4:, :] = TIP
        wing(m, secs, mid, TBLADES)


def cabin(G):
    m = G['cabin']
    # floor (cockpit and cabin), following the inside of the skin
    ys = np.linspace(-2.35, 3.25, 40)
    xm = np.array([S(y, side_angle(y, 0.86))[0] for y in ys]) - 0.04
    P = np.stack([np.stack([xm, ys, np.full_like(ys, 0.86)], 1), np.stack([-xm, ys, np.full_like(ys, 0.86)], 1)], 1)
    grid(m, P, FLOOR)
    # aft bulkhead
    a0 = float(side_angle(-2.35, 0.86)); A = np.linspace(a0, pi - a0, 40)
    ring = S(-2.35, A, -0.03); ring[:, 2] = np.maximum(ring[:, 2], 0.86)
    m.add(ring[::-1], [list(range(len(ring)))], LINING)
    # ribs and stringers inside the cabin
    for y in (-2.2, -1.75, -1.3, 1.35, 1.7):
        a0 = float(side_angle(y, 0.9)); A = np.linspace(a0, pi - a0, 30)
        tube(m, S(y, A, -0.06), 0.028, INTP, sides=4)
    for y in (-0.85, -0.4, 0.05, 0.5, 0.95):
        tube(m, S(y, np.radians(np.linspace(40, 140, 16)), -0.06), 0.028, INTP, sides=4)
    for a in (55, 90, 125):
        tube(m, Sd(np.linspace(-2.33, 1.9, 12), a, -0.065), 0.022, INTP, sides=4)
    # cable runs with clamps, a hydraulic line
    yy = np.linspace(-2.3, 1.9, 43)
    for a, r, mid in ((72, 0.016, CABLE), (79, 0.012, CABLE), (104, 0.018, CABLE), (110, 0.009, ALUT)):
        sag = 0.025 * np.abs(np.sin((yy + 2.3) / 0.6 * pi))
        tube(m, Sd(yy, a, -0.11) - np.stack([0 * yy, 0 * yy, sag], 1), r, mid, sides=6)
    for y in np.arange(-2.3, 1.95, 0.6):
        for a in (75, 107): box(m, Sd(y, a, -0.1), (0.04, 0.015, 0.012), INTP)
    # troop bench along the aft bulkhead, red canvas, belts
    for z0, yb in ((1.28, -1.90), (1.28, -2.31), (1.95, -2.31)):
        tube(m, [(-0.93, yb, z0), (0.93, yb, z0)], 0.016, ALUT, sides=8)
    for x in (-0.92, -0.46, 0, 0.46, 0.92):
        tube(m, [(x, -1.92, 1.28), (x, -1.97, 0.86)], 0.014, ALUT, sides=6)
        tube(m, [(x, -1.92, 1.20), (x, -2.30, 0.95)], 0.010, ALUT, sides=6)
        tube(m, [(x, -2.31, 1.28), (x, -2.31, 1.95)], 0.012, ALUT, sides=6)
    for x in (-0.69, -0.23, 0.23, 0.69):
        box(m, (x, -2.105, 1.285), (0.215, 0.2, 0.012), CANVAS, R=rotx(-3))
        box(m, (x, -2.285, 1.63), (0.215, 0.012, 0.3), CANVAS)
        for sx in (-1, 1):
            beam(m, (x + sx * 0.09, -2.27, 1.93), (x + sx * 0.07, -2.262, 1.36), 0.022, 0.003, WEB, up=(0, 1, 0))
            beam(m, (x + sx * 0.2, -2.15, 1.30), (x + sx * 0.03, -1.99, 1.305), 0.022, 0.003, WEB, up=(0, 0, 1))
        box(m, (x, -1.99, 1.31), (0.035, 0.025, 0.006), BUCKLE)
    # tie-down rings in the floor
    for x in (-0.62, 0.0, 0.62):
        for y in (-1.55, -0.85, -0.15, 0.55, 1.25):
            ellipsoid(m, (x, y, 0.861), (0.035, 0.035, 0.005), TIEDOWN, nu=4, nv=10)
            t = np.linspace(0, 2 * pi, 11)
            tube(m, np.stack([x + 0.03 * np.cos(t), y + 0.022 + 0.03 * np.sin(t), 0.867 + 0 * t], 1), 0.006, TIEDOWN, sides=5, caps=False, closed=True)
    # fire extinguisher, first aid box, intercom box
    tube(m, [(0.80, -2.25, 1.02), (0.80, -2.25, 1.42)], 0.06, RED, sides=12)
    tube(m, [(0.80, -2.25, 1.42), (0.80, -2.25, 1.50)], 0.02, PANEL, sides=8)
    box(m, (-0.8, -2.28, 1.62), (0.14, 0.04, 0.1), INTP)
    box(m, (0.95, 1.45, 1.75), (0.03, 0.08, 0.1), PANEL)
    # door post handles inside
    for a in (-20, 200):
        tube(m, [Sd(1.17, a - 25, -0.08), Sd(1.17, a + 25, -0.08)], 0.014, STEEL, sides=6)


def cockpit(G):
    m = G['cabin']
    for sx in (-0.55, 0.55):
        # armoured bucket seat: a curved shell (back and sides in one), rounded cushions, headrest, harness
        az = np.radians(np.linspace(-80, 80, 15)); hz = np.linspace(0, 0.78, 9)
        Rt = rotx(12)
        def shell(r, rw, off):
            pts = np.zeros((len(hz), len(az), 3))
            for i, h in enumerate(hz):
                w = rw * (1 - 0.18 * (h / 0.78) ** 2)
                loc = np.stack([w * np.sin(az), -r * np.cos(az) + 0.05, np.full_like(az, h)], 1)
                pts[i] = (Rt @ loc.T).T + (sx, 2.24 + off, 1.21)
            return pts
        grid(m, shell(0.20, 0.27, 0.0), SEATA)                    # outer shell (outward = du x dv)
        grid(m, shell(0.18, 0.25, 0.012)[:, ::-1], SEATA)          # inner face
        box(m, (sx, 2.40, 1.235), (0.25, 0.22, 0.035), SEATA)
        ellipsoid(m, (sx, 2.42, 1.30), (0.22, 0.21, 0.045), CUSH, nu=7, nv=16)
        ellipsoid(m, (sx, 2.19, 1.60), (0.20, 0.045, 0.30), CUSH, R=rotx(12), nu=9, nv=16)
        ellipsoid(m, (sx, 2.09, 2.10), (0.12, 0.05, 0.08), CUSH, R=rotx(12), nu=7, nv=12)          # headrest
        box(m, (sx, 2.06, 2.03), (0.03, 0.02, 0.06), SEATA, R=rotx(12))
        for s in (-1, 1):                                          # harness straps from the back over the cushion
            beam(m, (sx + s * 0.08, 2.12, 1.98), (sx + s * 0.06, 2.21, 1.62), 0.024, 0.004, WEB, up=(0, 1, 0))
            beam(m, (sx + s * 0.2, 2.38, 1.33), (sx + s * 0.04, 2.47, 1.335), 0.024, 0.004, WEB, up=(0, 0, 1))
        box(m, (sx, 2.47, 1.34), (0.04, 0.03, 0.008), BUCKLE)
        for s in (-1, 1): beam(m, (sx + s * 0.2, 2.25, 1.2), (sx + s * 0.2, 2.25, 0.86), 0.03, 0.02, INTP, up=(0, 1, 0))
        # cyclic, collective, pedals
        tube(m, [(sx, 2.97, 0.86), (sx, 2.92, 1.1), (sx, 2.86, 1.38)], 0.016, PANEL, sides=8)
        tube(m, [(sx, 2.97, 0.86), (sx, 2.97, 0.96)], [0.06, 0.03], CABLE, sides=10)
        tube(m, [(sx, 2.86, 1.37), (sx + 0.01, 2.85, 1.50)], 0.022, CABLE, sides=8)
        tube(m, [(sx - 0.30, 2.12, 1.02), (sx - 0.31, 2.70, 1.25)], 0.02, PANEL, sides=8)
        box(m, (sx - 0.31, 2.71, 1.255), (0.035, 0.06, 0.035), PANEL, R=rotx(22))
        box(m, (sx - 0.36, 2.2, 0.95), (0.05, 0.25, 0.09), PANEL)
        for s in (-1, 1):
            box(m, (sx + s * 0.13, 3.27, 1.02), (0.05, 0.02, 0.09), ALUT, R=rotx(-30))
            tube(m, [(sx + s * 0.13, 3.29, 0.95), (sx + s * 0.13, 3.42, 0.88)], 0.012, ALUT, sides=6)
    # instrument panel, tilted back 15 degrees, with dials and a glare shield
    R = rotx(-15); c = np.array([0, 3.47, 1.55]); n_ = R @ np.array([0, -1., 0])
    box(m, c, (0.86, 0.03, 0.25), PANEL, R=R)
    box(m, (0, 3.34, 1.82), (0.88, 0.2, 0.022), PANEL)
    box(m, (0, 3.15, 1.805), (0.88, 0.02, 0.04), CABLE)
    rng = np.random.default_rng(3)
    def dial(lx, lz, r):
        p = c + R @ np.array([lx, -0.03, lz])
        tube(m, [p, p + n_ * 0.008], r * 1.18, PANEL, sides=14)
        tube(G['light'], [p, p + n_ * 0.010], r, L_DIAL, sides=14)
        q = p + n_ * 0.0105; ex = R @ np.array([1., 0, 0]); ez = R @ np.array([0, 0, 1.])
        for k in range(12):
            t = 2 * pi * k / 12; d = ex * cos(t) + ez * sin(t)
            box(m, q + d * r * 0.82, (0.0015, 0.0012, 0.007 if k % 3 else 0.010), WHITE, R=frame(d, -n_))
        t = rng.uniform(0, 2 * pi); d = ex * cos(t) + ez * sin(t)
        beam(m, q + n_ * 0.001, q + n_ * 0.001 + d * r * 0.72, 0.0025, 0.0012, WHITE, up=-n_)
    for sx in (-0.5, 0.5):
        for lx in (-0.15, 0, 0.15):
            for lz in (0.1, -0.07): dial(sx + lx, lz, 0.045)
        dial(sx + 0.29 * np.sign(sx), 0.02, 0.03); dial(sx + 0.29 * np.sign(sx), -0.13, 0.03)
    for lx in (-0.12, 0.12):
        p = c + R @ np.array([lx, -0.035, 0.03]); box(m, p, (0.1, 0.008, 0.09), PANEL, R=R)
        box(G['light'], p + n_ * 0.009, (0.085, 0.002, 0.07), L_SCREEN, R=R)
    for lx in np.linspace(-0.2, 0.2, 5): dial(lx, -0.17, 0.022)
    # centre pedestal with radio heads
    box(m, (0, 3.0, 1.06), (0.16, 0.42, 0.2), PANEL)
    for k, y in enumerate(np.linspace(2.68, 3.32, 5)):
        box(m, (0, y, 1.265), (0.14, 0.055, 0.008), PANEL if k % 2 else INTP)
        for x in (-0.09, 0.0, 0.09): tube(m, [(x, y, 1.27), (x, y, 1.29)], 0.012, SWITCH, sides=8)
    # overhead console with switches
    box(m, (0, 2.55, 2.40), (0.26, 0.42, 0.04), PANEL)
    for x in np.linspace(-0.2, 0.2, 5):
        for y in np.linspace(2.2, 2.9, 8): tube(m, [(x, y, 2.36), (x, y, 2.34)], 0.005, SWITCH, sides=5)
    # magnetic compass on the windscreen post
    box(m, Sd(3.45, 90, -0.12), (0.04, 0.04, 0.03), PANEL)


def pilot(G, sx):
    m = G['crew']
    tube(m, [(sx, 2.41, 1.33), (sx, 2.40, 1.45), (sx, 2.38, 1.6), (sx, 2.35, 1.75), (sx, 2.33, 1.85)], [0.15, 0.14, 0.16, 0.18, 0.15], SUIT, sides=14, up=(1, 0, 0), ell=(1, 0.62))
    tube(m, [(sx, 2.395, 1.47), (sx, 2.38, 1.6), (sx, 2.355, 1.75), (sx, 2.335, 1.83)], [0.158, 0.174, 0.194, 0.166], VEST, sides=14, up=(1, 0, 0), ell=(1, 0.66))
    for dx in (-0.075, 0.075):
        box(m, (sx + dx, 2.505, 1.58), (0.05, 0.028, 0.06), VEST)
    box(m, (sx, 2.50, 1.71), (0.07, 0.025, 0.045), VEST)
    for s in (-1, 1):
        beam(m, (sx + s * 0.1, 2.30, 1.84), (sx + s * 0.08, 2.49, 1.50), 0.025, 0.006, BLACK, up=(0, 1, 0))
        ellipsoid(m, (sx + s * 0.18, 2.33, 1.80), (0.065, 0.07, 0.065), SUIT)
    tube(m, [(sx, 2.33, 1.84), (sx, 2.35, 1.97)], 0.055, SKIN, sides=10)
    ellipsoid(m, (sx, 2.36, 2.04), (0.075, 0.095, 0.105), SKIN)
    ellipsoid(m, (sx, 2.325, 2.11), (0.125, 0.14, 0.125), HELMET, nu=11, nv=18)
    # visor: a band of a slightly larger shell in front
    el = np.radians(np.linspace(-35, 12, 6)); az = np.radians(np.linspace(-62, 62, 12))
    E, A = np.meshgrid(el, az, indexing='ij')
    P = np.stack([sx + 0.133 * np.cos(E) * np.sin(A), 2.325 + 0.148 * np.cos(E) * np.cos(A), 2.11 + 0.133 * np.sin(E)], -1)
    grid(m, P, VISOR)
    box(m, (sx, 2.46, 2.20), (0.035, 0.02, 0.02), BLACK, R=rotx(-30))
    for s in (-1, 1): ellipsoid(m, (sx + s * 0.12, 2.33, 2.05), (0.03, 0.06, 0.07), HELMET)
    tube(m, [(sx + 0.13, 2.37, 2.03), (sx + 0.09, 2.45, 1.99), (sx + 0.03, 2.47, 1.985)], 0.006, BLACK, sides=5)
    tube(m, [(sx, 2.20, 2.08), (sx + 0.05, 2.15, 1.9), (sx + 0.15, 2.18, 1.6)], 0.008, BLACK, sides=5)
    # arms: right hand on the cyclic, left hand on the collective
    Rs, Re, Rw, Rh = (sx + 0.19, 2.33, 1.79), (sx + 0.22, 2.50, 1.50), (sx + 0.05, 2.80, 1.46), (sx + 0.015, 2.85, 1.45)
    Ls, Le, Lw, Lh = (sx - 0.19, 2.33, 1.79), (sx - 0.27, 2.42, 1.47), (sx - 0.30, 2.62, 1.29), (sx - 0.31, 2.68, 1.27)
    for s_, e_, w_, h_ in ((Rs, Re, Rw, Rh), (Ls, Le, Lw, Lh)):
        tube(m, [s_, e_], [0.058, 0.048], SUIT, sides=10)
        ellipsoid(m, e_, (0.048, 0.048, 0.048), SUIT, nu=6, nv=10)
        tube(m, [e_, w_], [0.046, 0.036], SUIT, sides=10)
        tube(m, [np.add(w_, 0), h_], [0.04, 0.038], GLOVE, sides=10)
        ellipsoid(m, h_, (0.045, 0.05, 0.055), GLOVE, R=frame(np.subtract(h_, w_), (0, 0, 1)))
    # legs
    for s in (-1, 1):
        hip, kn, an = (sx + s * 0.095, 2.40, 1.36), (sx + s * 0.12, 2.86, 1.43), (sx + s * 0.14, 3.13, 1.03)
        tube(m, [hip, kn], [0.088, 0.062], SUIT, sides=12)
        ellipsoid(m, kn, (0.06, 0.06, 0.06), SUIT, nu=6, nv=10)
        tube(m, [kn, an], [0.058, 0.045], SUIT, sides=10)
        box(m, (sx + s * 0.14, 3.19, 1.0), (0.05, 0.13, 0.05), BOOT, R=rotx(-30))
        box(m, (sx + s * 0.1, 2.62, 1.47), (0.03, 0.08, 0.02), VEST)        # leg pocket


def build():
    G = {k: MB() for k in ('hull', 'paint', 'top', 'cabin', 'mech', 'glass', 'crew', 'light')}
    hull(G); doors(G); cowling(G); tail(G); details(G); rotor(G); cabin(G); cockpit(G)
    pilot(G, 0.55); pilot(G, -0.55)
    for mb in G.values():           # lower the body onto shorter gear; the skids are built afterwards
        for V in mb.V: V[:, 2] += DZ
    gear(G)
    return G


if __name__ == '__main__':
    G = build()
    for k, mb in G.items(): print(k, mb.tris(), 'tris', len(mb.F), 'faces')
