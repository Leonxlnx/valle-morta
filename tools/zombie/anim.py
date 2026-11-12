"""Procedural animation clips (numpy FK / IK) -> build/anim.npz   |   python anim.py [--sheet]

Rotations are stored per bone as local rotations expressed in character-space axes
(rest pose = identity for every bone): x = left, y = back, z = up.
"""
import os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from skeleton import J, BONES, PARENT

FPS = 30
IDX = {b: i for i, b in enumerate(BONES)}
REST = np.array([J[b] for b in BONES])
pi = np.pi


def unit(v):
    v = np.asarray(v, float); return v / np.linalg.norm(v)


def Rx(d):
    c, s = np.cos(np.radians(d)), np.sin(np.radians(d)); return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def Ry(d):
    c, s = np.cos(np.radians(d)), np.sin(np.radians(d)); return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def Rz(d):
    c, s = np.cos(np.radians(d)), np.sin(np.radians(d)); return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def E(x=0, y=0, z=0):
    return Rz(z) @ Ry(y) @ Rx(x)


def aa(axis, d):
    a = unit(axis); t = np.radians(d)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(t) * K + (1 - np.cos(t)) * K @ K


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)


ARMDIR = {s: unit(J['LowerArm.' + s] - J['UpperArm.' + s]) for s in 'LR'}
ELBOW = {s: unit(np.cross(unit(J['Hand.' + s] - J['LowerArm.' + s]), [0, -1, 0])) for s in 'LR'}
SD = {'L': 1.0, 'R': -1.0}


def base():
    """The zombie's neutral slump. Every clip starts from / returns to this."""
    return dict(root=[0, 0, 0], hipofs=[0, 0, -0.03], spine=[5, 0, 0], chest=[8, 0, 0], neck=[14, 0, 0], head=[-8, 9, -5], jaw=[6],
                shL=[-5, 4], shR=[3, 6], armL=[38, 6, 0, 16, 10, 0], armR=[30, 12, 0, 28, 14, 0],
                footL=[0, 0, 0, 0, 0], footR=[0, 0, 0, 0, 8],            # dx, dy, lift, pitch(+ = heel up), yaw-in
                legL=[0, 0, 0, 0, 0, 0, 0], legR=[0, 0, 0, 0, 0, 0, 0], fk=[0.0])   # FK legs: thigh xyz, knee, foot x z, toe


def upper_locals(p):
    L = {b: np.eye(3) for b in BONES}
    L['Hips'] = E(*p['root']); L['Spine'] = E(*p['spine']); L['Chest'] = E(*p['chest'])
    L['Neck'] = E(*p['neck']); L['Head'] = E(*p['head']); L['Jaw'] = Rx(p['jaw'][0])
    for s in 'LR':
        sd = SD[s]; up, fw = p['sh' + s]
        L['Shoulder.' + s] = Ry(-sd * up) @ Rz(-sd * fw)
        down, fwd, tw, elb, wr, hz = p['arm' + s]
        L['UpperArm.' + s] = Rx(-fwd) @ Rz(sd * hz) @ Ry(sd * down) @ aa(ARMDIR[s], tw * sd)
        L['LowerArm.' + s] = aa(ELBOW[s], elb)
        L['Hand.' + s] = aa(ELBOW[s], wr)
    return L


def fk(hips_pos, L):
    W = [None] * len(BONES); P = np.zeros((len(BONES), 3))
    for i, b in enumerate(BONES):
        pa = PARENT[i]
        if pa < 0:
            W[i] = L[b]; P[i] = hips_pos
        else:
            W[i] = W[pa] @ L[b]; P[i] = P[pa] + W[pa] @ (REST[i] - REST[pa])
    return P, W


def frame(d, f):
    d = unit(d); f = np.asarray(f, float); f = unit(f - d * (f @ d))
    return np.stack([d, f, np.cross(d, f)], 1)


def foot_target(s, dx, dy, lift, pitch):
    a0 = J['Foot.' + s]; b0 = J['Toe.' + s]; h0 = a0 * [1, 1, 0] + [0, 0.07, 0.008]
    piv = b0 if pitch >= 0 else h0
    return piv + Rx(pitch) @ (a0 - piv) + np.array([dx * SD[s], dy, lift])


def leg_ik(L, s, hips_pos, target, pitch, yaw_in, pole=(0, -1, 0.0)):
    W_h = L['Hips']
    iu, il, ift = IDX['UpperLeg.' + s], IDX['LowerLeg.' + s], IDX['Foot.' + s]
    hip = hips_pos + W_h @ (REST[iu] - REST[0])
    t1 = REST[il] - REST[iu]; t2 = REST[ift] - REST[il]
    L1, L2 = np.linalg.norm(t1), np.linalg.norm(t2)
    v = target - hip; dist = min(max(np.linalg.norm(v), 0.12), L1 + L2 - 1e-4); vd = unit(v)
    pole = np.asarray(pole, float) + np.array([0.12 * SD[s], 0, 0]); pole = unit(pole - vd * (pole @ vd))
    ch = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist); sh = np.sqrt(max(1 - ch * ch, 0))
    td = vd * ch + pole * sh
    knee = hip + td * L1
    sdir = unit(hip + vd * dist - knee)
    Wt = frame(td, pole) @ frame(t1, [0, -1, 0]).T
    Ws = frame(sdir, pole) @ frame(t2, [0, -1, 0]).T
    Wf = Rz(-SD[s] * yaw_in) @ Rx(pitch)
    L['UpperLeg.' + s] = W_h.T @ Wt; L['LowerLeg.' + s] = Wt.T @ Ws; L['Foot.' + s] = Ws.T @ Wf
    L['Toe.' + s] = Rx(-max(pitch, 0) * 0.9)


def solve_ik(p):
    L = upper_locals(p)
    hp_ = REST[0] + np.asarray(p['hipofs'], float)
    for s in 'LR':
        dx, dy, lift, pitch, yaw = p['foot' + s]
        leg_ik(L, s, hp_, foot_target(s, dx, dy, lift, pitch), pitch, yaw)
    return hp_, L


def blend(A, B, w):
    """Geodesic blend of rotation matrices."""
    from scipy.spatial.transform import Rotation as Rot
    return A @ Rot.from_rotvec(Rot.from_matrix(A.T @ B).as_rotvec() * w).as_matrix()


_BASE_IK = solve_ik(base())


def solve_fk(p):
    """Upper body + FK legs (blended from the base stance by p['fk']); hips at origin, caller places the body."""
    L = upper_locals(p); w = float(p['fk'][0])
    for s in 'LR':
        tx, ty, tz, kn, fx, fz, toe = p['leg' + s]; sd = SD[s]
        tgt = {'UpperLeg.' + s: E(tx, sd * ty, sd * tz), 'LowerLeg.' + s: Rx(kn), 'Foot.' + s: E(fx, 0, sd * fz), 'Toe.' + s: Rx(toe)}
        for b, m in tgt.items():
            L[b] = blend(_BASE_IK[1][b], m, w)
    return L


CLAMP = [('Hips', (0, 0, 0), 0.115), ('Chest', (0, 0, 0.12), 0.118), ('Head', (0, -0.01, 0.09), 0.095),
         ('LowerLeg.L', (0, 0, 0), 0.055), ('LowerLeg.R', (0, 0, 0), 0.055), ('Foot.L', (0, 0, 0), 0.092), ('Foot.R', (0, 0, 0), 0.092),
         ('Toe.L', (0, 0, 0), 0.028), ('Toe.R', (0, 0, 0), 0.028)]


def ground_shift(P, W):
    return -min((P[IDX[b]] + W[IDX[b]] @ np.array(o))[2] - r for b, o, r in CLAMP)


# ----------------------------------------------------------------------------- keyframe tracks
def track(keys):
    """keys: [(t, {param: value-list})] -> f(t) -> full param dict (Catmull-Rom, missing params carry forward)."""
    cur = base(); ts = []; full = []
    for t, d in keys:
        cur = {k: list(v) for k, v in cur.items()}
        for k, v in d.items():
            cur[k] = list(v) if isinstance(v, (list, tuple)) else [v]
        ts.append(t); full.append(cur)
    ts = np.array(ts, float)

    def f(t):
        t = float(np.clip(t, ts[0], ts[-1])); i = int(np.clip(np.searchsorted(ts, t, 'right') - 1, 0, len(ts) - 2))
        u = (t - ts[i]) / (ts[i + 1] - ts[i]); out = {}
        for k in full[0]:
            p1 = np.array(full[i][k], float); p2 = np.array(full[i + 1][k], float)
            m1 = (p2 - np.array(full[i - 1][k], float)) / (ts[i + 1] - ts[i - 1]) * (ts[i + 1] - ts[i]) if i > 0 else np.zeros_like(p1)
            m2 = (np.array(full[i + 2][k], float) - p1) / (ts[i + 2] - ts[i]) * (ts[i + 1] - ts[i]) if i + 2 < len(ts) else np.zeros_like(p1)
            h00 = 2 * u ** 3 - 3 * u ** 2 + 1; h10 = u ** 3 - 2 * u ** 2 + u; h01 = -2 * u ** 3 + 3 * u ** 2; h11 = u ** 3 - u ** 2
            out[k] = list(h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2)
        return out
    return f


def add(p, k, v):
    p[k] = [a + b for a, b in zip(p[k], v)]


# ----------------------------------------------------------------------------- clips
def twitch(t, t0, T, tau=0.05):
    u = (t - t0) % T
    return (u / tau) * np.exp(1 - u / tau)


def idle(t, T=3.0):
    p = base(); w = 2 * pi * t / T; s1, s2, s3 = np.sin(w), np.sin(2 * w), np.sin(3 * w); c1 = 1 - np.cos(w); c2 = 1 - np.cos(2 * w)
    tw1 = twitch(t, 0.8, T); tw2 = twitch(t, 1.9, T, 0.06); tw3 = twitch(t, 2.35, T, 0.04)
    p['hipofs'] = [0.017 * s1, 0.006 * s2, -0.03 - 0.003 * c2]
    p['root'] = [0.8 * s2, 1.8 * s1, 1.2 * s1 + 0.5 * s3]
    add(p, 'spine', [1.2 * s2, -1.2 * s1, 1.0 * s1]); add(p, 'chest', [1.4 * c2 + 0.8 * s1, -1.0 * s1, 1.6 * s3 + 2.5 * tw2])
    add(p, 'neck', [2.0 * s2 - 1.5 * c1, 1.5 * s1, 2.0 * s3 + 3 * tw1])
    add(p, 'head', [2.5 * s3 - 4 * tw2 + 3 * tw3, 2.5 * c1 - 5 * tw1 + 4 * tw3, 3 * s2 + 9 * tw1 - 7 * tw2])
    add(p, 'jaw', [2.5 * c1 + 5 * tw2 + 2 * tw1])
    add(p, 'shL', [1.0 * c2 + 4 * tw2, 0]); add(p, 'shR', [0.8 * c2 + 6 * tw2, 0])
    add(p, 'armL', [1.5 * s1, 3 * s2, 0, 2 * c1 + 3 * tw2, 2 * s3, 0]); add(p, 'armR', [-1.5 * s1, 3.5 * s3, 0, 3 * c2 + 5 * tw2, -2 * s2, 0])
    return solve_ik(p)


def gait_foot(ph, ph0, D, y_front, stride, lift_h, drag):
    u = (ph - ph0) % 1.0
    if u < D:
        y = y_front + stride * u; lift = 0.0
        pitch = (30.0 if drag else 26.0) * sstep(0.62 * D, D, u) - (0 if drag else 9.0 * sstep(0.12 * D, 0.0, u))
    else:
        s = (u - D) / (1 - D); e = s * s * (3 - 2 * s)
        y = (y_front + stride * D) * (1 - e) + y_front * e
        if drag:
            lift = 0.012 * np.sin(pi * s); pitch = 30.0 - 22.0 * sstep(0.55, 1.0, s)
        else:
            lift = lift_h * np.sin(pi * s) ** 0.9; pitch = 26.0 * (1 - sstep(0.0, 0.45, s)) - 9.0 * sstep(0.55, 1.0, s)
    return y, lift, pitch


WALK_SPEED = 0.42; RUN_SPEED = 2.8


def walk(t, T=1.5):
    p = base(); ph = t / T; stride = WALK_SPEED * T; c = lambda o, k=1: np.cos(2 * pi * (k * ph - o)); s = lambda o, k=1: np.sin(2 * pi * (k * ph - o))
    yl, ll, pl = gait_foot(ph, 0.0, 0.60, -0.19, stride, 0.065, False)
    yr, lr, pr = gait_foot(ph, 0.5, 0.72, -0.11, stride, 0.0, True)
    drag = sstep(0.60, 0.80, ((ph - 0.5) % 1.0))
    p['footL'] = [0.0, yl, ll, pl, 0]; p['footR'] = [-0.015, yr, lr, pr, 12 + 12 * drag]
    p['hipofs'] = [0.030 * c(0.30), -0.012, -0.050 + 0.011 * c(0.07, 2) - 0.012 * c(0.60)]
    p['root'] = [9 + 3.5 * s(0.42), 3.2 * c(0.30) - 1.5, 6.5 * s(0.05)]
    p['spine'] = [6 + 1.5 * s(0.5), -1.8 * c(0.33), -3.0 * s(0.08)]
    p['chest'] = [12 + 5 * s(0.50), -2.2 * c(0.36), -5.5 * s(0.10)]
    p['neck'] = [15 + 3 * s(0.60), 2 * c(0.45), 2.5 * s(0.2)]
    p['head'] = [-9 + 4.5 * s(0.68), 10 + 3.5 * c(0.5), -5 + 4 * s(0.25)]
    p['jaw'] = [9 + 4 * s(0.75)]
    p['shL'] = [-6 + 1.5 * s(0.55), 4]; p['shR'] = [4 + 2 * s(0.05), 9]
    p['armL'] = [36 + 2 * c(0.3), 4 + 10 * s(0.57), 0, 15 + 7 * s(0.68), 12 + 5 * s(0.8), 0]
    p['armR'] = [22 + 2 * c(0.8), 40 + 6 * s(0.18), 0, 44 + 8 * s(0.32), -16 + 6 * s(0.45), 0]
    return solve_ik(p)


def run(t, T=0.7):
    p = base(); ph = t / T; stride = RUN_SPEED * T; c = lambda o, k=1: np.cos(2 * pi * (k * ph - o)); s = lambda o, k=1: np.sin(2 * pi * (k * ph - o))
    for sd_, ph0, nm, yf in (('L', 0.0, 'footL', -0.30), ('R', 0.5, 'footR', -0.28)):
        u = (ph - ph0) % 1.0; D = 0.36
        if u < D:
            y = yf + stride * u; lift = 0.0; pitch = -8 * sstep(0.15 * D, 0, u) + 36 * sstep(0.45 * D, D, u)
        else:
            q = (u - D) / (1 - D); e = q * q * (3 - 2 * q)
            y = (yf + stride * D) * (1 - e) + yf * e
            lift = 0.21 * np.sin(pi * q) ** 0.8 + 0.05 * np.sin(pi * min(q * 2.2, 1.0))
            pitch = 36 + 22 * np.sin(pi * min(q * 1.6, 1.0)) - 66 * sstep(0.5, 1.0, q)
        p[nm] = [0.0 if sd_ == 'L' else -0.01, y, lift, pitch, 0 if sd_ == 'L' else 9]
    p['hipofs'] = [0.012 * c(0.18), -0.03, -0.060 + 0.028 * c(0.43 * 2, 2)]
    p['root'] = [20 + 3 * c(0.4, 2), 4.0 * c(0.18), 9 * s(-0.05)]
    p['spine'] = [8, -2.5 * c(0.2), -4 * s(-0.03)]
    p['chest'] = [14 + 4 * s(0.1, 2), -3 * c(0.22) + 2, -8 * s(0.0) + 3]
    p['neck'] = [-6 + 3 * s(0.3, 2), 2, 2 * s(0.1)]
    p['head'] = [-20 + 5 * s(0.42, 2), 7 + 3 * s(0.3), -4 + 6 * s(0.3)]
    p['jaw'] = [17 + 6 * s(0.5, 2)]
    p['shL'] = [4 + 3 * s(0.5), 10]; p['shR'] = [8 + 3 * s(0.0), 14]
    p['armL'] = [30 + 3 * s(0.2), 62 + 15 * s(0.5), 0, 30 + 13 * s(0.62), -18 + 8 * s(0.75), 0]
    p['armR'] = [26 + 3 * s(0.7), 84 + 12 * s(0.0), 0, 38 + 12 * s(0.12), -22 + 8 * s(0.25), 0]
    return solve_ik(p)


_ATT = track([
    (0.00, {}),
    (0.20, dict(hipofs=[0.0, 0.03, -0.04], root=[-6, 0, 4], spine=[2, 0, 2], chest=[-6, 0, 9], neck=[6, 0, 0], head=[-17, 6, -9], jaw=[16],
                shL=[6, -4], shR=[10, -6], armL=[26, 58, 0, 62, -12, 0], armR=[8, 98, 0, 78, -18, 0], footR=[0, 0.02, 0, 0, 8])),
    (0.42, dict(hipofs=[0.0, -0.13, -0.075], root=[24, 0, -5], spine=[10, 0, -3], chest=[19, 0, -10], neck=[9, 0, 0], head=[-24, 3, 7], jaw=[31],
                shL=[2, 14], shR=[4, 16], armL=[36, 72, 0, 20, 22, 0], armR=[30, 64, 0, 16, 26, 0], footR=[0, 0.05, 0, 28, 8], footL=[0, -0.02, 0, 0, 0])),
    (0.53, dict(hipofs=[0.0, -0.135, -0.08], root=[26, 0, -3], chest=[23, 0, -5], neck=[13, 0, 0], head=[-13, 4, 12], jaw=[1],
                armL=[42, 46, 0, 32, 26, 0], armR=[38, 38, 0, 28, 28, 0])),
    (0.68, dict(hipofs=[0.0, -0.07, -0.05], root=[14, 0, -1], spine=[7, 0, 0], chest=[14, 0, -1], neck=[14, 0, 0], head=[-9, 8, 2], jaw=[9],
                shL=[-3, 6], shR=[3, 8], armL=[40, 22, 0, 22, 14, 0], armR=[33, 24, 0, 30, 16, 0], footR=[0, 0.02, 0, 10, 8], footL=[0, 0, 0, 0, 0])),
    (0.90, {k: v for k, v in base().items()}),
])


def attack(t):
    return solve_ik(_ATT(t))


def hit_env(t, T, k=0.45):
    return np.sin(pi * np.clip(t / T, 0, 1) ** k) if t > 0 else 0.0


def hit_body(t, T=0.4):
    p = base(); e = hit_env(t, T); el = hit_env(t - 0.035, T - 0.035) if t > 0.035 else 0.0
    p['hipofs'] = [-0.012 * e, 0.045 * e, -0.03 - 0.012 * e]
    add(p, 'root', [-5 * e, -2 * e, -6 * e]); add(p, 'spine', [-5 * e, 0, -6 * e]); add(p, 'chest', [-13 * e, -3 * e, -15 * e])
    add(p, 'neck', [9 * e - 4 * el, 0, 4 * el]); add(p, 'head', [14 * e - 10 * el, 3 * el, 8 * el]); add(p, 'jaw', [10 * el])
    add(p, 'shR', [6 * e, -16 * e]); add(p, 'shL', [3 * e, 6 * e])
    add(p, 'armR', [-10 * el, -14 * el, 0, 16 * el, 0, 0]); add(p, 'armL', [-6 * el, 16 * el, 0, 10 * el, 0, 0])
    p['footR'] = [0, 0.03 * e, 0, 0, 8]
    return solve_ik(p)


def hit_head(t, T=0.4):
    p = base(); e = hit_env(t, T, 0.4); el = hit_env(t - 0.04, T - 0.04) if t > 0.04 else 0.0
    p['hipofs'] = [0.0, 0.02 * el, -0.03 - 0.006 * el]
    add(p, 'neck', [-22 * e, 3 * e, -5 * e]); add(p, 'head', [-30 * e, -6 * e, 12 * e]); add(p, 'jaw', [14 * e])
    add(p, 'chest', [-8 * el, 0, 4 * el]); add(p, 'spine', [-4 * el, 0, 0]); add(p, 'root', [-2 * el, 0, 0])
    add(p, 'shL', [5 * el, 0]); add(p, 'shR', [5 * el, 0])
    add(p, 'armL', [-8 * el, 10 * el, 0, 14 * el, 0, 0]); add(p, 'armR', [-10 * el, 6 * el, 0, 12 * el, 0, 0])
    return solve_ik(p)


_DB = track([
    (0.00, {}),
    (0.12, dict(fk=[1], root=[-6, 0, 4], spine=[-2, 0, 0], chest=[-12, 0, 10], neck=[10, 0, 0], head=[8, 6, 0], jaw=[12],
                armL=[40, 25, 0, 30, 0, 0], armR=[20, 40, 0, 45, 0, 0], legL=[-14, 0, 0, 26, 0, 0, 0], legR=[-7, 0, 0, 17, 0, 0, 0])),
    (0.45, dict(root=[-34, 2, 8], spine=[-4, 0, 0], chest=[-8, 0, 4], neck=[16, 0, 0], head=[14, 4, 0], jaw=[18],
                armL=[10, 60, 0, 35, 0, 0], armR=[0, 75, 0, 40, 0, 0], legL=[-38, 0, 4, 64, -10, 0, 0], legR=[-48, 0, 4, 80, -10, 0, 0])),
    (0.72, dict(root=[-74, 3, 10], spine=[2, 0, 0], chest=[4, 0, 2], neck=[12, 0, 0], head=[12, 4, 0],
                armL=[-10, 40, 0, 30, 0, 4], armR=[-25, 46, 0, 25, 0, 4], legL=[-62, 0, 6, 70, 0, 0, 0], legR=[-70, 0, 6, 88, 0, 0, 0])),
    (0.92, dict(root=[-93, 2, 10], spine=[-3, 0, 0], chest=[-4, 0, 0], neck=[-6, 0, 0], head=[-12, 6, 10], jaw=[20],
                armL=[-20, 6, 0, 20, 0, 6], armR=[-40, 8, 0, 22, 0, 6], legL=[-30, 0, 10, 40, 10, 8, 0], legR=[-46, 0, 8, 62, 10, 6, 0])),
    (1.06, dict(root=[-87.5, 2, 10], spine=[-1, 0, 0], chest=[-1, 0, 0], neck=[2, 0, 0], head=[0, 5, 16], jaw=[12],
                armL=[-18, -3, -60, 30, 8, 18], armR=[-46, 0, -60, 36, 8, 17], legL=[-14, 0, 12, 20, 22, 18, 0], legR=[-26, 0, 10, 40, 20, 14, 0])),
    (1.32, dict(root=[-90, 2, 10], spine=[-2, 0, 0], chest=[-2, 0, 0], neck=[-4, 0, 0], head=[-6, 4, 22], jaw=[16],
                armL=[-18, -4, -85, 38, 10, 22], armR=[-48, 0, -80, 45, 10, 21], legL=[-5, 0, 12, 10, 28, 22, 0], legR=[-14, 0, 10, 26, 24, 20, 0])),
    (2.20, {}),
])
_DF = track([
    (0.00, {}),
    (0.15, dict(fk=[1], root=[4, 0, -3], chest=[14, 0, 0], neck=[18, 0, 0], head=[8, 8, -4], jaw=[14],
                armL=[40, 4, 0, 10, 0, 0], armR=[38, 6, 0, 14, 0, 0], legL=[-22, 0, 0, 46, -12, 0, 0], legR=[-18, 0, 0, 40, -10, 0, 0])),
    (0.50, dict(root=[10, 0, -4], spine=[8, 0, 0], chest=[16, 0, 0], neck=[22, 0, 0], head=[16, 8, -4],
                armL=[42, -2, 0, 8, 0, 0], armR=[40, 0, 0, 10, 0, 0], legL=[-12, 0, 2, 98, 40, 0, 0], legR=[-8, 0, 3, 94, 45, 0, 0])),
    (0.95, dict(root=[6, -3, -6], spine=[12, 0, 0], chest=[22, 0, 0], neck=[30, 0, 0], head=[22, 10, -8], jaw=[20],
                armL=[42, -4, 0, 8, 0, 0], armR=[41, -3, 0, 9, 0, 0], legL=[-8, 0, 2, 98, 40, 0, 0], legR=[-4, 0, 3, 96, 45, 0, 0])),
    (1.30, dict(root=[48, -2, -8], spine=[6, 0, 0], chest=[10, 0, 0], neck=[10, 0, 0], head=[-10, 8, -10],
                armL=[36, 20, 0, 20, 0, 0], armR=[30, 30, 0, 25, 0, 0], legL=[2, 0, 2, 42, 45, 0, 0], legR=[4, 0, 3, 40, 50, 0, 0])),
    (1.52, dict(root=[91, -2, -10], spine=[2, 0, 0], chest=[2, 0, 0], neck=[-4, 0, 0], head=[-8, 4, 40], jaw=[10],
                armL=[40, 5, -40, 20, 0, 0], armR=[-60, 0, -40, 30, 0, 0], legL=[0, 0, 4, 4, 55, 10, 0], legR=[0, 0, 5, 8, 55, 12, 0])),
    (1.64, dict(root=[87.5, -2, -10], chest=[0, 0, 0], head=[-4, 4, 44], armL=[40, 3, -80, 35, 0, 0], armR=[-100, -3, -80, 48, 0, 0])),
    (1.85, dict(root=[90, -2, -10], spine=[2, 0, 0], chest=[2, 0, 0], neck=[-4, 0, 0], head=[-6, 4, 46], jaw=[12],
                armL=[40, 3, -80, 35, 0, 0], armR=[-105, -3, -80, 50, 0, 0], legL=[0, 0, 4, 4, 55, 10, 0], legR=[0, 0, 5, 8, 55, 12, 0])),
    (2.40, {}),
])


def death(trk, pinB, t_sw, T):
    """FK body with ground contact: pinned at the ankles first, then at pinB joints (frozen where they land)."""
    def mid(P, names):
        return np.mean([P[IDX[n]] for n in names], 0)
    A = ['Foot.L', 'Foot.R']; tgtA = mid(REST, A)

    def place(t, tgtB=None):
        L = solve_fk(trk(t)); P, W = fk(np.zeros(3), L)
        offA = tgtA - mid(P, A)
        w = sstep(t_sw[0], t_sw[1], t) if tgtB is not None else 0.0
        off = offA if tgtB is None else (1 - w) * offA + w * (tgtB - mid(P, pinB))
        off[2] = 0.0
        P, W = fk(off, L)
        off[2] = ground_shift(P, W)
        return off, L
    o, L = place(t_sw[0]); P, W = fk(o, L); tgtB = mid(P, pinB)
    return lambda t: place(t, tgtB)


death_back = death(_DB, ['Hips'], (0.62, 0.84), 2.2)
death_front = death(_DF, ['LowerLeg.L', 'LowerLeg.R'], (0.40, 0.55), 2.4)

CLIPS = [('Idle', idle, 3.0, True), ('Walk', walk, 1.5, True), ('Run', run, 0.7, True), ('Attack', attack, 0.9, False),
         ('HitBody', hit_body, 0.4, False), ('HitHead', hit_head, 0.4, False), ('DeathBack', death_back, 2.2, False), ('DeathFront', death_front, 2.4, False)]


def bake():
    from scipy.spatial.transform import Rotation as Rot
    out = {}
    for name, fn, T, loop in CLIPS:
        n = int(round(T * FPS)) + 1
        hp_ = np.zeros((n, 3)); q = np.zeros((n, len(BONES), 4))
        for f in range(n):
            t = f / FPS
            pos, L = fn(0.0 if (loop and f == n - 1) else t)
            hp_[f] = pos; q[f] = Rot.from_matrix(np.stack([L[b] for b in BONES])).as_quat()
            if f:
                flip = (q[f] * q[f - 1]).sum(1) < 0; q[f][flip] *= -1
        out[name + '_pos'] = hp_.astype(np.float32); out[name + '_rot'] = q.astype(np.float32)
    out['names'] = np.array([c[0] for c in CLIPS]); out['durations'] = np.array([c[2] for c in CLIPS]); out['bones'] = np.array(BONES)
    np.savez(os.path.join(HERE, 'build', 'anim.npz'), **out)
    return out


def sheet(path, per=9):
    from PIL import Image, ImageDraw
    cw, chh, sc = 96, 120, 58.0
    im = Image.new('RGB', (cw * per + 70, chh * len(CLIPS)), (24, 24, 26)); dr = ImageDraw.Draw(im)
    for r, (name, fn, T, loop) in enumerate(CLIPS):
        dr.text((4, r * chh + 4), name, fill=(230, 230, 230))
        for k in range(per):
            t = T * k / (per - (0 if loop else 1))
            pos, L = fn(t); P, W = fk(pos, L)
            ox = 70 + k * cw + cw * 0.5; oy = r * chh + chh - 8
            dr.line([(ox - cw * 0.5, oy), (ox + cw * 0.5, oy)], fill=(70, 70, 70))
            for i, b in enumerate(BONES):
                pa = PARENT[i]
                if pa < 0:
                    continue
                col = (235, 235, 235) if not b.endswith(('.L', '.R')) else ((255, 150, 60) if b.endswith('.L') else (90, 170, 255))
                a, c_ = P[pa], P[i]
                dr.line([(ox - a[1] * sc, oy - a[2] * sc), (ox - c_[1] * sc, oy - c_[2] * sc)], fill=col, width=2)
            hd = P[IDX['Head']] + W[IDX['Head']] @ np.array([0, -0.01, 0.10])
            dr.ellipse([ox - hd[1] * sc - 6, oy - hd[2] * sc - 6, ox - hd[1] * sc + 6, oy - hd[2] * sc + 6], outline=(235, 235, 235))
            for s in 'LR':
                tp = P[IDX['Toe.' + s]] + W[IDX['Toe.' + s]] @ (J['ToeTip.' + s] - J['Toe.' + s])
                a = P[IDX['Toe.' + s]]
                dr.line([(ox - a[1] * sc, oy - a[2] * sc), (ox - tp[1] * sc, oy - tp[2] * sc)], fill=(255, 150, 60) if s == 'L' else (90, 170, 255), width=2)
    im.save(path)


if __name__ == '__main__':
    o = bake()
    for name, fn, T, loop in CLIPS:
        print('%-10s %.2fs %d frames  hips z %.2f..%.2f' % (name, T, len(o[name + '_pos']), o[name + '_pos'][:, 2].min(), o[name + '_pos'][:, 2].max()))
    # foot-slide check for the gaits: stance ankle speed vs nominal ground speed
    for name, fn, T, v in (('Walk', walk, 1.5, WALK_SPEED), ('Run', run, 0.7, RUN_SPEED)):
        sp = []
        for f in range(200):
            t = T * f / 200; dt = 1e-3
            for s in 'LR':
                P0, _ = fk(*fn(t)); P1, _ = fk(*fn(t + dt))
                i = IDX['Toe.' + s]
                if P0[i][2] < 0.033:
                    sp.append((P1[i][1] - P0[i][1]) / dt)
        print('%s: grounded toe speed mean %.3f m/s (std %.3f), nominal %.2f' % (name, np.mean(sp), np.std(sp), v))
    if '--sheet' in sys.argv:
        sheet(os.path.join(HERE, '..', '_preview', 'zombie', 'anim_sticks.png'))
