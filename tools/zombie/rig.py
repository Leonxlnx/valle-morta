"""Skin weights for the game mesh, computed analytically from the known anatomy.  python rig.py -> build/weights.npz"""
import os, sys
os.environ.setdefault('OMP_NUM_THREADS', '6')
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import model, body
from model import MAT
from skeleton import J0 as J, BONES
import variant
from body import HEAD_O, ANK, TOE_OUT, mm

IDX = {b: i for i, b in enumerate(BONES)}


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)


def seg_dist(P, a, b):
    ab = b - a; h = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(P - a - h[:, None] * ab, axis=1)


low = np.load(os.path.join(variant.BUILD, 'low.npz'))
V = low['pos'].astype(np.float64); n = len(V)
_, mat = model.eval_chunked(V.astype(np.float32), chunk=4000, margin=0.006)
x, y, z = V[:, 0], V[:, 1], V[:, 2]; ax = np.abs(x)
W = np.zeros((n, len(BONES)))
lower = np.isin(mat, [MAT['trousers'], MAT['boots'], MAT['belt']]) | ((mat == MAT['skin']) & (z < 0.75) & (ax < 0.3)) | ((mat == MAT['flesh']) & (z < 0.75))

# ---- arms
arm_total = np.zeros(n)
for s, sd in (('L', 1.0), ('R', -1.0)):
    S_, E_, W_, T_ = J['UpperArm.' + s], J['LowerArm.' + s], J['Hand.' + s], J['HandTip.' + s]
    d1 = (E_ - S_) / np.linalg.norm(E_ - S_); d2 = (W_ - E_) / np.linalg.norm(W_ - E_)
    LU = np.linalg.norm(E_ - S_); LF = np.linalg.norm(W_ - E_)
    u1 = (V - S_) @ d1; u2 = (V - E_) @ d2
    dp = np.minimum(np.minimum(seg_dist(V, S_, E_), seg_dist(V, E_, W_)), seg_dist(V, W_, T_ + 0.09 * d2) - 0.05)
    armness = sstep(-0.05, 0.045, u1) * sstep(0.115, 0.08, dp) * (x * sd > 0.08) * (~lower)
    b = sstep(LU - 0.04, LU + 0.04, u1); h = sstep(LF - 0.03, LF + 0.015, u2)
    W[:, IDX['UpperArm.' + s]] = armness * (1 - b)
    W[:, IDX['LowerArm.' + s]] = armness * b * (1 - h)
    W[:, IDX['Hand.' + s]] = armness * b * h
    sh = sstep(0.055, 0.15, x * sd) * sstep(1.33, 1.41, z) * (~lower)
    W[:, IDX['Shoulder.' + s]] = (1 - armness) * sh * 0.75 + armness * (1 - b) * 0.0
    arm_total += armness + W[:, IDX['Shoulder.' + s]]

# ---- legs (trousers, boots, exposed leg skin)
leg_total = np.zeros(n)
for s, sd in (('L', 1.0), ('R', -1.0)):
    side = np.where(z > 0.80, sstep(-0.012, 0.03, x * sd), (x * sd > 0).astype(float))
    lw = sstep(0.99, 0.86, z) * side * lower
    lw = np.where(mat == MAT['apron'], 0.75 * sstep(0.95, 0.80, z) * sstep(-0.11, 0.11, x * sd), lw)      # apron skirt follows both thighs
    k = sstep(0.545, 0.455, z)
    f = sstep(0.19, 0.10, z) * (mat == MAT['boots'])
    c, sn = np.cos(np.radians(TOE_OUT * sd)), np.sin(np.radians(TOE_OUT * sd))
    rx_, ry_ = x - ANK[0] * sd, y - ANK[1]
    yl = -rx_ * sn + ry_ * c                                     # boot-local "back" axis
    t = sstep(-0.085, -0.125, yl) * f
    W[:, IDX['UpperLeg.' + s]] = lw * (1 - k)
    W[:, IDX['LowerLeg.' + s]] = lw * k * (1 - f)
    W[:, IDX['Foot.' + s]] = lw * k * f * (1 - t / np.maximum(f, 1e-6) * (f > 0))
    W[:, IDX['Toe.' + s]] = lw * k * t
    leg_total += lw

# ---- spine chain gets the remainder
rest = np.clip(1.0 - arm_total - leg_total, 0, 1)
b1 = np.where(lower, 0.0, sstep(1.00, 1.10, z)); b2 = sstep(1.16, 1.27, z)
b3 = sstep(1.455, 1.51, z) * np.maximum(sstep(0.105, 0.06, ax), sstep(1.56, 1.62, z))        # ears belong to the head, not the chest
zb = 1.572 + np.where(y < 0, 0.45, 0.25) * y
b4 = sstep(zb - 0.03, zb + 0.012, z)
W[:, IDX['Hips']] = rest * (1 - b1); W[:, IDX['Spine']] = rest * b1 * (1 - b2); W[:, IDX['Chest']] = rest * b2 * (1 - b3)
W[:, IDX['Neck']] = rest * b3 * (1 - b4)
q = (V - HEAD_O) / mm
jaw = sstep(-48.5, -53.5, q[:, 2]) * sstep(-8.0, -28.0, q[:, 1]) * sstep(-116.0, -101.0, q[:, 2])
teeth = mat == MAT['teeth']
jaw = np.where(teeth, (q[:, 2] < -51.5).astype(float), jaw)
headw = rest * b3 * b4
W[:, IDX['Head']] = headw * (1 - jaw); W[:, IDX['Jaw']] = headw * jaw

# ---- smooth over the mesh graph (keeps teeth rigid), keep 4 influences
tri = low['lv']
E = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]]); E = np.concatenate([E, E[:, ::-1]])
deg = np.bincount(E[:, 0], minlength=n).astype(float)
W0 = W.copy()
for it in range(2):
    acc = np.zeros_like(W); np.add.at(acc, E[:, 0], W[E[:, 1]])
    W = 0.5 * W + 0.5 * acc / np.maximum(deg, 1)[:, None]
W[teeth] = W0[teeth]
W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
idx = np.argsort(-W, 1)[:, :4]; w4 = np.take_along_axis(W, idx, 1)
w4[w4 < 0.02] = 0; w4 /= w4.sum(1, keepdims=True)
np.savez(os.path.join(variant.BUILD, 'weights.npz'), idx=idx.astype(np.int32), w=w4.astype(np.float32), mat=mat)
print('weights: %d verts; per-bone vertex counts:' % n)
print(' '.join('%s=%d' % (b, int((W[:, i] > 0.5).sum())) for i, b in enumerate(BONES)))
