# Shared arm / hand dimensions and skin-weight fields (pure numpy, used by Blender and by the texture stage).
# Units: millimetres. Right-hand frame: origin = wrist joint, +X ulnar (little finger), +Y distal, +Z dorsal (back of hand).
# The left arm is the X mirror image. Bind pose: both arms straight along +Y, palms down, wrists at x = +-OFFX.
import numpy as np

MM = 0.001
L1, L2 = 300.0, 268.0            # upper arm, forearm
OFFX = 200.0
FN = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']
BONES = ['UpperArm', 'Forearm', 'Hand'] + [f + str(k) for f in FN for k in (1, 2, 3)]
# finger: knuckle (MCP) position, fan angle in degrees (+ = towards little finger), phalanx lengths, radii at the 3 joints + tip
FING = {'Index': ((-29., 92., 1.), -7., (44., 26., 23.), (10.4, 9.5, 8.6, 7.7)),
        'Middle': ((-8., 96., 1.5), -1.5, (48., 30., 24.), (10.6, 9.7, 8.8, 7.9)),
        'Ring': ((12., 92., 1.), 5., (44., 28., 23.), (10.1, 9.2, 8.4, 7.5)),
        'Pinky': ((30., 82., 0.), 13., (35., 21., 21.), (9.1, 8.3, 7.6, 6.9))}
TH = dict(cmc=(-24., 20., -8.), d=[(-0.60, 0.74, -0.30), (-0.40, 0.89, -0.21), (-0.33, 0.93, -0.17)], L=(46., 35., 29.),
          R=(15.5, 12.2, 10.8, 9.4), nail=(-0.55, 0.05, 0.83))
# palm collision proxies (x, y, z, radius)
PALMS = [(x, y, 0.0, 13.0 if y < 60 else 12.0) for y in (28., 48., 68., 86.) for x in (-27., -9., 9., 27.)]


def unit(v):
    v = np.asarray(v, float); return v / np.linalg.norm(v)


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)


def chain(name):
    """joints (4,3) incl. tip, radii (4), segment directions (3,3), dorsal vectors (3,3)"""
    if name == 'Thumb':
        D = np.array([unit(d) for d in TH['d']]); J = [np.array(TH['cmc'])]
        for d, l in zip(D, TH['L']): J.append(J[-1] + d * l)
        nl = np.array(TH['nail']); bk = np.array([unit(nl - d * np.dot(nl, d)) for d in D])
        return np.array(J), np.array(TH['R']), D, bk
    mcp, ang, L, R = FING[name]; a = np.radians(ang); d = np.array([np.sin(a), np.cos(a), 0.0]); J = [np.array(mcp)]
    for l in L: J.append(J[-1] + d * l)
    return np.array(J), np.array(R), np.tile(d, (3, 1)), np.tile([0., 0., 1.], (3, 1))


def cumlen(J):
    return np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(J, axis=0), axis=1))])


def project(P, J):
    """closest point on the joint polyline: arclength (negative before the first joint) and distance"""
    cum = 0.0; bt = np.zeros(len(P)); bd = np.full(len(P), 1e9)
    for k in range(3):
        d = J[k + 1] - J[k]; L = np.linalg.norm(d); d = d / L
        u = np.clip((P - J[k]) @ d, -40.0 if k == 0 else 0.0, L)
        dist = np.linalg.norm(P - (J[k] + u[:, None] * d), axis=1)
        m = dist < bd; bd[m] = dist[m]; bt[m] = cum + u[m]; cum += L
    return bt, bd


def fields(P):
    """per finger chain: arclength, distance / radius, dorsal height; plus the owning chain (-1 = palm)"""
    N = len(P); T = np.zeros((5, N)); Sc = np.full((5, N), 9e9); Zb = np.zeros((5, N))
    for ci, name in enumerate(FN):
        J, R, D, BK = chain(name); t, d = project(P, J)
        T[ci] = t; Sc[ci] = d / np.interp(t, cumlen(J), R); Zb[ci] = (P - J[0]) @ BK[0]
    ok = np.zeros((5, N), bool); ok[0] = (T[0] > 6) & (Sc[0] < 1.55); ok[1:] = (T[1:] > -16) & (Sc[1:] < 1.9)
    sc = np.where(ok, Sc, 9e9); idx = np.argmin(sc, 0); idx[sc[idx, np.arange(N)] > 9e8] = -1
    return T, Sc, Zb, idx


def glove_weights(P):
    """P: (N,3) right-hand mm -> (N,18) weights in BONES order"""
    N = len(P); Wt = np.zeros((N, 18)); T, Sc, Zb, idx = fields(P)
    for ci, name in enumerate(FN):
        m = idx == ci
        if not m.any(): continue
        L = np.diff(cumlen(chain(name)[0])); t = T[ci][m]; s = Sc[ci][m]; z = Zb[ci][m]
        if ci == 0: w = sstep(4, 30, t) * sstep(1.55, 1.05, s)
        else: w = sstep(-10, 10, t - (7 * sstep(-3, 5, z) - 5 * sstep(3, -5, z))) * sstep(1.9, 1.45, s)
        w2 = sstep(L[0] - 7, L[0] + 7, t); w3 = sstep(L[0] + L[1] - 6, L[0] + L[1] + 6, t)
        Wt[m, 3 + 3 * ci] = w * (1 - w2); Wt[m, 4 + 3 * ci] = w * w2 * (1 - w3); Wt[m, 5 + 3 * ci] = w * w2 * w3
    rest = 1 - Wt.sum(1); wf = sstep(8, -30, P[:, 1]); Wt[:, 2] = rest * (1 - wf); Wt[:, 1] = rest * wf
    return Wt


def sleeve_weights(P):
    Wt = np.zeros((len(P), 18)); wu = sstep(L2 - 45, L2 + 45, -P[:, 1]); Wt[:, 0] = wu; Wt[:, 1] = 1 - wu
    return Wt
