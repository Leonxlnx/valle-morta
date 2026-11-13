"""Type-specific sculpt and paint additions, all in the walker's canonical space (see variant.py).

runner : sleeves torn off, extra tears          brute : leather work apron (bib, skirt, neck strap, waist tie)
boss   : shirt reduced to waist rags, over-developed muscle masses, growths, bell rope wound round the torso
"""
import numpy as np
from sdf import *
import body, variant
from body import SH, EL, WR, mx

V = variant.NAME
ROPE_R = 0.0125
GROWTHS = [((-0.150, 0.075, 1.500), 0.046), ((-0.205, 0.055, 1.455), 0.036), ((-0.100, 0.115, 1.420), 0.040), ((-0.045, 0.128, 1.335), 0.030),
           ((0.110, 0.100, 1.230), 0.034), ((-0.290, 0.030, 1.372), 0.031), ((-0.455, -0.020, 1.190), 0.027), ((0.060, -0.080, 1.215), 0.022)]


# ----------------------------------------------------------------------------- shirt
def shirt_cut(P, C):
    """Extra cut field for the shirt (positive = removed)."""
    if V not in ('runner', 'boss'):
        return C
    z = P[:, 2]
    for s in (1, -1):
        t, th, r = limb_coords(P, mx(SH, s), mx(EL, s), v3(0, -1, 0))
        tc = 0.012 + 0.016 * np.sin(3.0 * th + 1.3 * s) + 0.014 * gnoise(P, 24.0, 61) + 0.005 * gnoise(P, 75.0, 62)
        C = np.maximum(C, np.minimum(t - tc, 0.086 - r))                       # sleeve torn off at the shoulder seam
    if V == 'runner':
        for c_, r_, sd in (((-0.06, -0.10, 1.16), (0.05, 0.03, 0.07), 64), ((0.05, 0.13, 1.25), (0.06, 0.03, 0.09), 65)):
            C = np.maximum(C, -Noisy(Ellipsoid(c_, r_), 0.006, 60.0, seed=sd, octaves=3)(P))
    else:
        C = np.maximum(C, z - (1.13 + 0.05 * gnoise(P, 7.0, 63) + 0.018 * gnoise(P, 30.0, 66)))     # only rags round the waist
    return C


# ----------------------------------------------------------------------------- boss anatomy
BOSS = None
if V == 'boss':
    BOSS = Layer()
    for _s in (1, -1):
        BOSS.u(Ellipsoid((_s * 0.078, -0.047, 1.332), (0.078, 0.034, 0.058)), 0.022)             # pectoral
        BOSS.u(Sphere(mx(SH, _s) + v3(0.012 * _s, 0.0, 0.012), 0.068), 0.03)                      # deltoid
        BOSS.u(Capsule((_s * 0.04, 0.05, 1.52), (_s * 0.17, 0.035, 1.47), 0.042, 0.034), 0.03)   # trapezius
        BOSS.u(Ellipsoid((_s * 0.105, 0.075, 1.30), (0.06, 0.04, 0.11)), 0.03)                    # back
    BOSS.u(Ellipsoid((0, 0.085, 1.43), (0.12, 0.05, 0.07)), 0.04)                                 # hump
    for _i, (_c, _r) in enumerate(GROWTHS):
        BOSS.u(Noisy(Sphere(_c, _r), 0.006, 45.0, seed=80 + _i, octaves=2), 0.018)


def skin_extra(P, d, margin):
    if BOSS is None:
        return d
    return BOSS.eval(P, margin + 0.03, d=d)


# ----------------------------------------------------------------------------- polyline helpers
def _poly_dist(Q, pts):
    best = np.full(len(Q), 1e9)
    for a, b in zip(pts[:-1], pts[1:]):
        ab = b - a; h = np.clip(((Q - a) @ ab) / (ab @ ab), 0, 1)
        q = Q - a - h[:, None] * ab
        best = np.minimum(best, np.sqrt((q * q).sum(1)))
    return best


# ----------------------------------------------------------------------------- brute: apron
_STRAP = np.array([(0.108, -0.105, 1.365), (0.10, -0.082, 1.43), (0.092, -0.04, 1.492), (0.082, 0.03, 1.522), (0.055, 0.08, 1.502), (0.0, 0.098, 1.487)])
_FILL = Ellipsoid((0, 0.02, 0.86), (0.205, 0.120, 0.24))


def apron_field(P, env, detail):
    n = len(P); d = np.full(n, BIG, F)
    z = P[:, 2]
    if z.max() < 0.70 or z.min() > 1.56:
        return d
    es = smin(env, _FILL(P).astype(F), 0.03)                     # the skirt hangs from the belly, it does not wrap each thigh
    m = (np.abs(es) < 0.05) & (z > 0.70) & (z < 1.56) & (np.abs(P[:, 0]) < 0.27)
    if not m.any():
        return d
    Q = P[m]; e = env[m].astype(np.float64); e2 = es[m].astype(np.float64); xq, yq, zq = Q[:, 0], Q[:, 1], Q[:, 2]; ax = np.abs(xq)
    w = 0.118 + 0.092 * sstep(1.34, 1.06, zq)
    hem = 0.765 + 0.03 * gnoise(Q, 9.0, 51) + 0.01 * gnoise(Q, 38.0, 52) + 0.15 * sstep(0.06, 0.20, xq)      # lower left corner torn away
    reg = np.maximum(np.maximum(ax - w, zq - 1.372), np.maximum(hem - zq, yq + 0.012))
    th = 0.0115 + (0.0012 * fbm(Q, 30.0, 3, seed=53) if detail else 0.0)
    a = np.maximum(e2 - th, reg)
    tie = np.maximum(np.maximum(e - 0.0085, np.abs(zq - 1.108) - 0.0105), ax - 0.25)
    Qd = Q.astype(np.float64)
    sd_ = np.minimum(_poly_dist(Qd, _STRAP), _poly_dist(Qd, _STRAP * np.array([-1.0, 1.0, 1.0]))) - 0.021
    strap = np.maximum(e - 0.0085, sd_)
    d[m] = np.minimum(np.minimum(a, tie), strap).astype(F)
    return d


# ----------------------------------------------------------------------------- boss: bell rope
_ROPE = dict(busy=False, A=None)


def _build_rope():
    import model
    _ROPE['busy'] = True
    loops = [((0.02, 0.024, 1.285), (-0.42, 0, 0.90)), ((0, 0.024, 1.215), (1, 0, 0.10)), ((0, 0.02, 1.128), (1, 0, -0.13))]
    N = 64; rho = np.arange(0.02, 0.46, 0.004)
    A, B, Nn, Bn, S0 = [], [], [], [], []
    for c, e2 in loops:
        c = v3(*c).astype(np.float64); e1 = np.array([0.0, 1.0, 0.0]); e2 = np.asarray(e2, float); e2 /= np.linalg.norm(e2)
        ang = 2 * np.pi * np.arange(N) / N
        dirs = np.cos(ang)[:, None] * e1 + np.sin(ang)[:, None] * e2
        Pq = (c + dirs[:, None, :] * rho[None, :, None]).reshape(-1, 3).astype(F)
        dd, _ = model.eval_model(Pq, margin=0.5, want_mat=False)
        dd = dd.reshape(N, len(rho)).astype(np.float64)
        k = np.maximum(np.argmax(dd > 0.0, 1), 1); ii = np.arange(N)
        d0, d1 = dd[ii, k - 1], dd[ii, k]
        r = rho[k - 1] + 0.004 * np.clip(-d0 / np.maximum(d1 - d0, 1e-6), 0, 1)
        for _ in range(2):
            r = 0.25 * np.roll(r, 1) + 0.5 * r + 0.25 * np.roll(r, -1)
        pts = c + dirs * (r + 0.45 * ROPE_R)[:, None]
        s = 0.0
        for i in range(N):
            a, b = pts[i], pts[(i + 1) % N]; t = (b - a) / np.linalg.norm(b - a)
            nn = dirs[i] - t * (dirs[i] @ t); nn /= np.linalg.norm(nn)
            A.append(a); B.append(b); Nn.append(nn); Bn.append(np.cross(t, nn)); S0.append(s); s += np.linalg.norm(b - a)
        if len(A) == 2 * N:                                         # knot + frayed end on the chest loop, in front
            pk = pts[N // 2] + np.array([0.02, -0.004, 0.0])
            kn = Layer()
            kn.u(Noisy(Sphere(pk, 0.025), 0.004, 60.0, seed=71, octaves=2))
            kn.u(Capsule(pk + v3(0.010, -0.004, -0.012), pk + v3(0.026, -0.010, -0.10), ROPE_R, ROPE_R), 0.006)
            kn.u(Noisy(Sphere(pk + v3(0.027, -0.010, -0.108), 0.017), 0.005, 90.0, seed=72, octaves=2), 0.004)
            _ROPE['knot'] = kn
    A = np.array(A); B = np.array(B)
    _ROPE.update(A=A, B=B, Nn=np.array(Nn), Bn=np.array(Bn), S0=np.array(S0), lo=np.minimum(A, B).min(0) - 0.14, hi=np.maximum(A, B).max(0) + 0.05, busy=False)


def rope_field(P, margin, detail):
    n = len(P); d = np.full(n, BIG, F)
    if _ROPE['busy']:
        return d
    if _ROPE['A'] is None:
        _build_rope()
    R = _ROPE
    m = ((P > R['lo'] - 0.03) & (P < R['hi'] + 0.03)).all(1)
    if not m.any():
        return d
    Q = P[m].astype(np.float64); best = np.full(len(Q), 1e9); bs = np.zeros(len(Q)); ba = np.zeros(len(Q))
    for i in range(len(R['A'])):
        a = R['A'][i]; ab = R['B'][i] - a; l2 = ab @ ab
        h = np.clip(((Q - a) @ ab) / l2, 0, 1)
        q = Q - a - h[:, None] * ab
        di = np.sqrt((q * q).sum(1))
        up = di < best
        if up.any():
            best[up] = di[up]
            if detail:
                bs[up] = R['S0'][i] + h[up] * np.sqrt(l2); ba[up] = np.arctan2(q[up] @ R['Bn'][i], q[up] @ R['Nn'][i])
    dd = best - ROPE_R
    if detail:
        dd -= 0.0017 * np.cos(3.0 * ba + 2 * np.pi * bs / 0.036) * (best < 0.03)       # three twisted strands
    dd = np.minimum(dd, R['knot'].eval(P[m], margin + 0.02).astype(np.float64))
    d[m] = dd.astype(F)
    return d


# ----------------------------------------------------------------------------- clothing hook (called by cloth.eval_cloth)
def cloth_extra(P, d_skin, fields, margin, detail):
    if V == 'brute':
        env = d_skin
        for nm, f in fields:
            if nm != 'boots':
                env = np.minimum(env, f)
        return [('apron', apron_field(P, env, detail))]
    if V == 'boss':
        return [('rope', rope_field(P, margin, detail))]
    return []


# ----------------------------------------------------------------------------- paint hook (called by bake.paint_pass)
def _mix(a, b, t):
    t = np.asarray(t, F)[:, None]
    return a * (1 - t) + b * t


_HANDS = [(mx(WR + 0.06 * body.ARM_DIR, s), 0.17) for s in (1, -1)]
SPLATS = {
    'runner': [((0, -0.085, 1.50), 0.14, 1.0), (_HANDS[0][0], 0.15, 0.9), (_HANDS[1][0], 0.20, 1.0), ((0.07, -0.10, 1.30), 0.09, 0.7)],
    'brute': [((0.03, -0.13, 1.14), 0.19, 0.85), ((-0.07, -0.12, 0.92), 0.13, 0.8), (_HANDS[0][0], 0.16, 0.85), (_HANDS[1][0], 0.16, 0.9),
              ((0, -0.085, 1.52), 0.07, 0.6)],
    'boss': [(_HANDS[0][0], 0.20, 1.0), (_HANDS[1][0], 0.24, 1.0), ((0.06, -0.09, 1.33), 0.15, 0.75), ((0, -0.085, 1.52), 0.09, 0.8),
             ((-0.12, 0.09, 1.44), 0.12, 0.6)],
}


def paint_extra(c, r, me, P, no, ao, cav, mat, sd, Vc, H):
    from model import MAT
    if V == 'walker':
        return c, r, me
    blood_layer = H['blood_layer']; srgb = H['srgb']
    sk = mat == MAT['skin']
    if variant.SKIN_TINT is not None and sk.any():
        c[sk] = c[sk] * np.asarray(variant.SKIN_TINT, F)
    if V == 'boss' and sk.any():
        Ps = P[sk]; t = np.zeros(len(Ps), F)
        for cc, rr in GROWTHS:
            t = np.maximum(t, sstep(1.9 * rr, 0.6 * rr, np.linalg.norm(Ps - np.asarray(cc, F), axis=1)))
        vein = sstep(0.62, 0.86, fbm(Ps, 24.0, 3, seed=91, ridged=True)) * (0.25 + 0.75 * t)
        cs = c[sk] * (1 - 0.42 * t[:, None] * (1 - np.array([0.95, 0.52, 0.62], F)) / 0.48)
        c[sk] = _mix(cs, cs * np.array([0.45, 0.30, 0.42], F), 0.55 * vein)
        r[sk] = r[sk] - 0.10 * t
    m = mat == MAT['apron']
    if m.any():
        Pm = P[m]; k = int(m.sum())
        cm = np.broadcast_to(np.asarray(Vc['apron'], F), (k, 3)).copy(); rm = np.full(k, 0.60, F)
        cm = cm * (1.0 + 0.10 * gnoise(Pm, 420.0, 301) + 0.12 * fbm(Pm, 28.0, 3, seed=302))[:, None]
        scuff = sstep(0.05, 0.6, fbm(Pm, 14.0, 3, seed=303 + sd))
        cm = _mix(cm, cm * 1.55 + 0.025, 0.35 * scuff); rm = rm + 0.2 * scuff
        cm = _mix(cm, cm * 0.45, 0.6 * (1 - cav[m]))
        cm = _mix(cm, srgb(78, 66, 48) * 0.8, 0.5 * sstep(0.95, 0.76, Pm[:, 2]) * (0.5 + 0.5 * fbm(Pm, 17.0, 3, seed=304)))
        drip = fbm(np.stack([Pm[:, 0] * 46.0, Pm[:, 1] * 46.0, Pm[:, 2] * 5.0], 1).astype(F), 1.0, 3, seed=305 + sd)
        amt = 0.75 * sstep(-0.05, 0.35, fbm(Pm, 5.5, 3, seed=306 + sd)) * sstep(0.74, 0.95, Pm[:, 2]) + 0.55 * sstep(0.15, 0.5, drip) * sstep(1.3, 1.0, Pm[:, 2])
        cm, rm = blood_layer(cm, rm, Pm, amt.astype(F), 307 + sd, 0.7)
        c[m] = cm; r[m] = rm
    m = mat == MAT['rope']
    if m.any():
        Pm = P[m]; k = int(m.sum())
        cm = np.broadcast_to(np.asarray(Vc['rope'], F), (k, 3)).copy(); rm = np.full(k, 0.93, F)
        cm = cm * (1.0 + 0.16 * gnoise(Pm, 520.0, 311) + 0.12 * gnoise(Pm, 150.0, 312) + 0.10 * fbm(Pm, 22.0, 3, seed=313))[:, None]
        cm = _mix(cm, cm * 0.35, 0.75 * (1 - cav[m]))
        cm = _mix(cm, srgb(60, 52, 40), 0.45 * sstep(0.0, 0.5, fbm(Pm, 9.0, 3, seed=314 + sd)))
        cm, rm = blood_layer(cm, rm, Pm, (0.8 * sstep(0.1, 0.5, fbm(Pm, 6.0, 3, seed=315 + sd))).astype(F), 316 + sd, 0.7)
        c[m] = cm; r[m] = rm
    ok = ~np.isin(mat, [MAT['eye'], MAT['teeth']])
    for i, (cc, rad, st) in enumerate(SPLATS.get(V, [])):
        dist = np.linalg.norm(P - np.asarray(cc, F), axis=1)
        mm_ = ok & (dist < rad)
        if mm_.any():
            amt = st * sstep(rad, 0.25 * rad, dist[mm_]) * (0.55 + 0.45 * sstep(-0.3, 0.3, fbm(P[mm_], 16.0, 3, seed=330 + i + sd)))
            c[mm_], r[mm_] = blood_layer(c[mm_], r[mm_], P[mm_], amt.astype(F), 340 + i + sd, 0.6)
    return c, r, me
