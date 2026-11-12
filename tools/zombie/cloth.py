"""Clothing as solid shells in the same field: torn work shirt, trousers, belt, boots."""
import numpy as np
from sdf import *
import body
from body import SH, EL, WR, HIPJ, KNEE, ANK, TOE_OUT, mx, unit, Xf

mm = 1e-3
TH = 0.0028          # visible cloth thickness at edges
EDGE = 0.011         # depth of the hollow pocket behind a cloth edge
LAST = {}            # last evaluated cut fields (used by the texture painter)

# ----------------------------------------------------------------------------- shirt
SHIRT_LO = np.array([-0.66, -0.20, 0.84]); SHIRT_HI = np.array([0.66, 0.20, 1.57])
LF = float(np.linalg.norm(WR - EL)); LU = float(np.linalg.norm(EL - SH))
RIB_C = body.RIB_C

SHIRT = Layer()
SHIRT.u(Ellipsoid((0, 0.022, 1.29), (0.172, 0.122, 0.20)))
SHIRT.u(Ellipsoid((0, 0.025, 1.42), (0.200, 0.095, 0.075)), 0.04)
SHIRT.u(Ellipsoid((0, 0.012, 1.05), (0.172, 0.122, 0.22)), 0.06)
for _s in (1, -1):
    SHIRT.u(Sphere(mx(SH, _s) + v3(0, 0, 0.004), 0.064), 0.03)
    SHIRT.u(Capsule(mx(SH, _s), mx(EL, _s), 0.060, 0.051), 0.03)
    SHIRT.u(Capsule(mx(EL, _s), mx(WR, _s), 0.050, 0.040), 0.014)
    SHIRT.u(Capsule(mx(EL + 0.86 * (WR - EL), _s), mx(EL + 0.97 * (WR - EL), _s), 0.0405, 0.0395), 0.004)   # cuff band

_NECK_C = v3(0, 0.014, 1.500); _NECK_R = rotm(20, 0, 0); _NECK_RAD = v3(0.066, 0.074, 0.05)


def billow(P, Q, amp, seed, octaves=2):
    n = fbm(Q, 1.0, octaves, seed=seed)
    return amp * (2.0 * np.abs(n) - 0.55)


def limb_folds(P, a, b, ref, f_t, f_r, seed, twist=0.0):
    """Ring-like compression folds around a limb axis (returns unit pattern + coords)."""
    t, th, r = limb_coords(P, a, b, ref)
    Q = np.stack([t * f_t + twist * th, np.cos(th) * r * f_r, np.sin(th) * r * f_r], 1).astype(F)
    n = fbm(Q, 1.0, 2, seed=seed)
    return (2.0 * np.abs(n) - 0.55), t, th, r


def shirt_field(P, sp, margin, detail, under=None):
    n = len(P)
    plo, phi = P.min(0), P.max(0)
    if (phi < SHIRT_LO).any() or (plo > SHIRT_HI).any():
        return np.full(n, BIG, F)
    S = SHIRT.eval(P, margin + 0.03)
    upper = np.minimum(sp['torso'], sp['arms'])
    S = smin(S, upper - 0.004, 0.012)
    if under is not None:                       # always stay outside trousers / belt
        S = smin(S, under - 0.005, 0.008)
    near = np.abs(S) < 0.03
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    disp = np.zeros(n, F)
    if near.any():
        Pn = P[near]; xn, yn, zn = Pn[:, 0], Pn[:, 1], Pn[:, 2]
        d = np.zeros(len(Pn), F)
        # torso: hanging drape folds, stronger toward the hem, plus diagonal drag folds
        wt = sstep(0.19, 0.13, np.abs(xn)) * sstep(1.47, 1.40, zn)
        Q = np.stack([xn * 21.0, yn * 21.0, zn * 5.0], 1).astype(F)
        a_d = 0.0015 + 0.0065 * sstep(1.30, 0.95, zn)
        d += wt * billow(Pn, Q, a_d, 31)
        Q2 = np.stack([(xn * 0.8 + zn * 0.6) * 16.0, yn * 9.0, (zn * 0.8 - xn * 0.6) * 4.5], 1).astype(F)
        d += wt * billow(Pn, Q2, 0.0035 * sstep(1.42, 1.25, zn), 37)
        # sleeves
        for s in (1, -1):
            S_, E_, W_ = mx(SH, s), mx(EL, s), mx(WR, s)
            pat, t, th, r = limb_folds(Pn, S_, E_, v3(0, -1, 0), 34.0, 9.0, 41 + s, twist=0.035 * s)
            w = sstep(0.11, 0.075, r) * sstep(-0.03, 0.03, t) * sstep(LU + 0.03, LU - 0.02, t)
            amp = 0.0022 + 0.0045 * sstep(LU - 0.13, LU - 0.02, t) + 0.004 * sstep(0.10, 0.0, t)
            d += w * amp * pat
            pat, t, th, r = limb_folds(Pn, E_, W_, v3(0, -1, 0), 38.0, 10.0, 51 + s, twist=-0.03 * s)
            w = sstep(0.09, 0.06, r) * sstep(-0.02, 0.02, t)
            amp = 0.0022 + 0.0045 * sstep(0.10, 0.0, t) + 0.0035 * sstep(LF - 0.11, LF - 0.03, t)
            d += w * amp * pat
        if detail:
            d += cloth_micro(Pn, 0.00022, 430.0, 3)
            # button placket + buttons
            pl = sstep(0.0175, 0.0145, np.abs(xn + 0.004)) * (yn < 0) * sstep(1.365, 1.35, zn)
            d += 0.0011 * pl
            bz = (zn - 1.02) / 0.085
            bd = np.sqrt((xn + 0.004) ** 2 + ((bz - np.round(bz)) * 0.085) ** 2)
            d += 0.0018 * sstep(0.0062, 0.0048, bd) * (yn < 0) * (zn < 1.36)
            # yoke / shoulder seam and side seams
            d -= 0.0007 * np.exp(-((zn - 1.395 - 0.08 * np.abs(xn)) / 0.0022) ** 2) * (yn > 0.03) * (np.abs(xn) < 0.19)
            d -= 0.0006 * np.exp(-((yn - 0.03) / 0.002) ** 2) * (np.abs(xn) > 0.12) * (np.abs(xn) < 0.2) * (zn < 1.33)
        disp[near] = d
    S = S - disp
    # ---- cutters (positive = removed)
    th_ = np.arctan2(x, -(y - 0.015))
    hem = 0.905 + 0.022 * np.sin(2.0 * th_ + 1.0) + 0.012 * np.sin(5.0 * th_ + 0.3) + 0.010 * gnoise(P, 16.0, 5)
    C = hem - z
    # front opening below the last button (shows belt buckle)
    cx = -0.012 - (1.105 - z) * 0.16
    C = np.maximum(C, np.minimum(np.minimum((1.105 - z) * 0.36 + 0.004 * gnoise(P, 40.0, 6) - np.abs(x - cx), -y - 0.02), 1.105 - z))
    # neck opening + V
    q = (P - _NECK_C.astype(F)) @ _NECK_R.astype(F)
    en = np.sqrt(((q / _NECK_RAD.astype(F)) ** 2).sum(1))
    rn = np.sqrt((q[:, 0] / _NECK_RAD[0]) ** 2 + (q[:, 1] / _NECK_RAD[1]) ** 2)
    C = np.maximum(C, (1.0 - en) * 0.05)
    C = np.maximum(C, np.minimum(q[:, 2] - 0.012, (1.3 - rn) * 0.06))     # everything above the collar plane
    vz = z - 1.345
    CV = np.minimum(np.minimum(0.010 + vz * 0.42 - np.abs(x - 0.004), vz), -y - 0.03)
    C = np.maximum(C, CV)
    # sleeve ends: left = cuff at wrist, right = torn off below the elbow
    for s in (1, -1):
        E_, W_ = mx(EL, s), mx(WR, s)
        t, th2, r = limb_coords(P, E_, W_, v3(0, -1, 0))
        if s > 0:
            tc = LF - 0.008
        else:
            tc = 0.055 + 0.022 * np.sin(3.0 * th2 + 0.8) + 0.016 * gnoise(P, 22.0, 9) + 0.006 * gnoise(P, 70.0, 10)
        C = np.maximum(C, np.minimum(t - tc, 0.085 - r))
    # rib tear (right side)
    rt = Noisy(Ellipsoid(RIB_C + v3(-0.008, -0.008, 0.0), (0.052, 0.04, 0.078), rotm(0, 0, 132)), 0.007, 55.0, seed=12, octaves=3)
    C = np.maximum(C, -rt(P))
    # small extra tears
    for c_, r_, sd in (((0.105, -0.085, 1.07), (0.016, 0.03, 0.035), 14), ((0.03, 0.125, 1.33), (0.035, 0.02, 0.014), 15),
                       ((0.30, -0.02, 1.33), (0.02, 0.03, 0.022), 16)):
        C = np.maximum(C, -Noisy(Ellipsoid(c_, r_), 0.004, 80.0, seed=sd)(P))
    LAST['shirt_cut'] = C
    d = np.maximum(np.maximum(S, C), np.minimum(-(S + TH), C + EDGE))
    # collar: a doubled band of cloth hugging the shirt around the neck opening, longer points in front
    wide = 1.24 + 0.30 * sstep(0.0, -0.05, y) * sstep(0.0, 0.03, np.abs(x))
    col = np.maximum(np.abs(S - 0.0030) - 0.0042, np.maximum((1.03 - rn) * 0.05, (rn - wide) * 0.05))
    col = np.maximum(col, np.maximum(CV + 0.002, np.maximum(q[:, 2] - 0.03, -0.045 - q[:, 2]))) - 0.0012
    return np.minimum(d, col)


def cloth_micro(P, amp, freq, seed):
    """Small scale woven / worn surface break-up (bake only)."""
    return amp * (gnoise(P, freq, seed) + 0.6 * gnoise(P, freq * 2.3, seed + 1))


# ----------------------------------------------------------------------------- trousers + belt
TR_LO = np.array([-0.30, -0.19, 0.05]); TR_HI = np.array([0.30, 0.20, 1.09])
BELT_Z = 1.043
TR = Layer()
TR.u(Ellipsoid((0, 0.022, 0.99), (0.162, 0.112, 0.20)))
TR.u(Ellipsoid((0, 0.016, 0.845), (0.075, 0.088, 0.075)), 0.02)
for _s in (1, -1):
    TR.u(Ellipsoid((_s * 0.075, 0.068, 0.925), (0.085, 0.07, 0.09)), 0.03)
    TR.u(Capsule(mx(HIPJ, _s) + v3(0, 0, -0.03), mx(KNEE, _s), 0.098, 0.077), 0.025)
    TR.u(Capsule(mx(KNEE, _s), mx(ANK, _s) + v3(0, 0, 0.0), 0.077, 0.071), 0.02)
KNEE_TEAR = Noisy(Ellipsoid(KNEE + v3(0.004, -0.075, 0.005), (0.04, 0.03, 0.048)), 0.006, 60.0, seed=21, octaves=3)


def trouser_form(P, sp, margin, detail):
    S = TR.eval(P, margin + 0.03)
    S = smin(S, sp['legs'] - 0.004, 0.012)
    near = np.abs(S) < 0.03
    disp = np.zeros(len(P), F)
    if near.any():
        Pn = P[near]; d = np.zeros(len(Pn), F)
        for s in (1, -1):
            H_, K_, A_ = mx(HIPJ, s), mx(KNEE, s), mx(ANK, s)
            LT = float(np.linalg.norm(K_ - H_)); LS = float(np.linalg.norm(A_ - K_))
            # thigh: crotch whiskers (diagonal) + knee bunching
            pat, t, th, r = limb_folds(Pn, H_, K_, v3(0, -1, 0), 26.0, 8.0, 61 + s, twist=0.06 * s)
            w = sstep(0.125, 0.09, r) * sstep(-0.08, 0.02, t) * sstep(LT + 0.03, LT - 0.03, t) * (Pn[:, 0] * s > -0.004)
            amp = 0.0020 + 0.0055 * sstep(0.20, 0.02, t) + 0.0050 * sstep(LT - 0.14, LT - 0.02, t)
            d += w * amp * pat
            # shin: knee folds + stacking over the boot
            pat, t, th, r = limb_folds(Pn, K_, A_, v3(0, -1, 0), 30.0, 8.0, 71 + s, twist=-0.04 * s)
            w = sstep(0.11, 0.08, r) * sstep(-0.03, 0.03, t)
            amp = 0.0018 + 0.0045 * sstep(0.12, 0.0, t) + 0.0075 * sstep(LS - 0.17, LS - 0.04, t)
            d += w * amp * pat
        # seat / hips: gentle horizontal folds
        zn = Pn[:, 2]
        Q = np.stack([Pn[:, 0] * 7.0, Pn[:, 1] * 7.0, zn * 24.0], 1).astype(F)
        d += sstep(0.80, 0.86, zn) * billow(Pn, Q, 0.0028, 81)
        if detail:
            d += cloth_micro(Pn, 0.00028, 380.0, 23)
            xn, yn = Pn[:, 0], Pn[:, 1]
            d -= 0.0008 * np.exp(-((np.abs(xn) - 0.165 + 0.25 * (yn - 0.02) ** 2) / 0.002) ** 2) * (zn > 0.2) * (np.abs(yn - 0.02) < 0.05)  # side seam
            d += 0.0010 * sstep(0.004, 0.002, np.abs(xn - 0.012)) * (yn < 0) * (zn > 0.86) * (zn < 1.03)               # fly
            d += 0.0010 * (zn > 1.022)                                                                                 # waistband
        disp[near] = d
    return S - disp


def trouser_belt(P, sp, margin, detail):
    n = len(P)
    plo, phi = P.min(0), P.max(0)
    if (phi < TR_LO).any() or (plo > TR_HI).any():
        b = np.full(n, BIG, F)
        return b, b
    S = trouser_form(P, sp, margin, detail)
    z = P[:, 2]
    C = z - 1.066
    for s in (1, -1):
        hem = (0.118 if s > 0 else 0.100) + 0.008 * gnoise(P, 30.0, 25 + s)
        C = np.maximum(C, np.minimum(hem - z, P[:, 0] * s))
    C = np.maximum(C, -KNEE_TEAR(P))
    LAST['tr_cut'] = C
    d = np.maximum(np.maximum(S, C), np.minimum(-(S + TH), np.minimum(C + EDGE, 0.5 - z)))
    # belt: a leather band riding on the trouser surface + buckle
    bd = np.maximum(np.abs(S - 0.0022) - 0.0026, np.abs(z - BELT_Z) - 0.0185) - 0.0008
    buckle = Box((-0.004, -0.0945, BELT_Z), (0.025, 0.0045, 0.0225), 0.003)(P)
    bd = np.minimum(bd, buckle)
    if detail:
        bd = bd + 0.00025 * gnoise(P, 260.0, 27)
    return d, bd


# ----------------------------------------------------------------------------- boots
def build_boot(s):
    L = Layer()
    X = Xf(v3(ANK[0], ANK[1], 0.0), rotm(0, 0, TOE_OUT))
    if s < 0:
        X = X.mirror()
    P = X.p; R = X.R
    L.u(Ellipsoid(P(0.004, -0.112, 0.0), (0.054, 0.108, 0.025), R()))                     # sole, forefoot
    L.u(Ellipsoid(P(0.0, 0.040, 0.0), (0.044, 0.058, 0.031), R()), 0.012)                 # heel
    L.u(Capsule(P(0.0, 0.02, 0.008), P(0.003, -0.09, 0.006), 0.036, 0.044), 0.01)         # shank
    L.u(Ellipsoid(P(0.003, -0.138, 0.046), (0.047, 0.070, 0.037), R()), 0.012)            # toe cap
    L.u(Capsule(P(0.002, -0.105, 0.052), P(0.0, -0.005, 0.112), 0.044, 0.049), 0.016)     # vamp / instep
    L.u(Ellipsoid(P(0.0, 0.034, 0.068), (0.042, 0.050, 0.062), R()), 0.014)               # heel counter
    L.u(Capsule(P(0.0, 0.010, 0.10), P(0.0, 0.016, 0.255), 0.053, 0.057), 0.014)          # shaft
    L.isect(Plane((0, 0, 0), (0, 0, -1)), 0.004)
    return L, X


BOOTS = {s: build_boot(s) for s in (1, -1)}
BOOT_HI = 0.34


def boots_field(P, margin, detail):
    n = len(P)
    if P[:, 2].min() > BOOT_HI:
        return np.full(n, BIG, F)
    d = np.full(n, BIG, F)
    for s in (1, -1):
        L, X = BOOTS[s]
        ds = L.eval(P, margin + 0.02)
        m = np.abs(ds) < 0.02
        if m.any():
            q = ((P[m] - X.o.astype(F)) @ X.M.astype(F))          # boot-local coords
            dd = np.zeros(int(m.sum()), F)
            xl, yl, zl = q[:, 0] * s, q[:, 1], q[:, 2]
            dd -= 0.0018 * np.exp(-((zl - 0.024 - 0.006 * sstep(-0.02, 0.06, yl)) / 0.0028) ** 2)     # welt groove
            dd += 0.0030 * sstep(0.03, 0.0, np.abs(zl - 0.085 + 0.25 * (yl + 0.05))) * billow(P[m], (P[m] * F(60.0)), 0.6, 33)  # ankle creases
            if detail:
                # sole edge ribs, toe-cap seam, laces
                dd += 0.0006 * np.sin(yl * 520.0) * (zl < 0.02)
                dd -= 0.0008 * np.exp(-((yl + 0.105 - 0.4 * xl ** 2 * 60) / 0.002) ** 2) * (zl > 0.03)
                lace = (np.abs(xl) < 0.020) * (yl > -0.10) * (yl < 0.0) * (zl > 0.05)
                lz = (yl * 0.75 - zl * 0.66)
                dd += 0.0018 * lace * sstep(0.35, 0.5, np.abs(((lz / 0.016) % 1.0) - 0.5)) * 1.0
                dd += 0.0004 * gnoise(P[m], 300.0, 35)
            ds[m] = ds[m] - dd
        d = np.minimum(d, ds)
    return d


# ----------------------------------------------------------------------------- all clothing
def eval_cloth(P, sp, d_skin, margin, detail):
    tr, belt = trouser_belt(P, sp, margin, detail)
    under = np.minimum(tr, belt)
    return [('shirt', shirt_field(P, sp, margin, detail, under)), ('trousers', tr), ('belt', belt),
            ('boots', boots_field(P, margin, detail))]
