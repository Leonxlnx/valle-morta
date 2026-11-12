"""Texture bake straight from the signed distance field (no high-poly ray casting).

  python bake.py geo     -> build/bake_geo.npz  (surface points, normals, AO, material ids per texel)
  python bake.py paint   -> build/tex/*.png|jpg (normal, ORM, albedo A/B/C)
  python bake.py         -> both
"""
import sys, os, time
os.environ.setdefault('OMP_NUM_THREADS', '6')
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from PIL import Image
from scipy import ndimage
from sdf import *
import model, body, cloth
from model import MAT
from body import hp, mm, EYE_C, EYE_R, HEAD_O, WR, EL, SH, ARM_DIR, mx, KNEE

RES = 2048
BUILD = os.path.join(HERE, 'build'); TEX = os.path.join(BUILD, 'tex'); os.makedirs(TEX, exist_ok=True)
GEO = os.path.join(BUILD, 'bake_geo.npz')
T0 = time.time()


def log(*a):
    print('[%5.0fs]' % (time.time() - T0), *a, flush=True)


def nrm(v):
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)


# ----------------------------------------------------------------------------- geometry pass
def rasterize(uv, res):
    tid = np.full((res, res), -1, np.int32); bc = np.zeros((res, res, 2), np.float32)
    px = uv.astype(np.float64) * res
    for expand in (0.0, 1.2):
        for t in range(len(px)):
            a, b, c = px[t]
            x0 = max(int(np.floor(min(a[0], b[0], c[0]) - expand)), 0); x1 = min(int(np.ceil(max(a[0], b[0], c[0]) + expand)), res - 1)
            y0 = max(int(np.floor(min(a[1], b[1], c[1]) - expand)), 0); y1 = min(int(np.ceil(max(a[1], b[1], c[1]) + expand)), res - 1)
            den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if x1 < x0 or y1 < y0 or abs(den) < 1e-9:
                continue
            X, Y = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            w0 = ((b[1] - c[1]) * (X - c[0]) + (c[0] - b[0]) * (Y - c[1])) / den
            w1 = ((c[1] - a[1]) * (X - c[0]) + (a[0] - c[0]) * (Y - c[1])) / den
            w2 = 1.0 - w0 - w1
            if expand:
                e0 = expand * np.hypot(*(b - c)) / abs(den); e1 = expand * np.hypot(*(c - a)) / abs(den); e2 = expand * np.hypot(*(a - b)) / abs(den)
            else:
                e0 = e1 = e2 = 1e-6
            st = tid[y0:y1 + 1, x0:x1 + 1]
            m = (w0 >= -e0) & (w1 >= -e1) & (w2 >= -e2) & (st < 0)
            if m.any():
                st[m] = t
                bc[y0:y1 + 1, x0:x1 + 1][m] = np.stack([w0[m], w1[m]], -1)
    return tid, bc


def ev(P, **kw):
    return model.eval_chunked(P, chunk=50000, **kw)


def geo_pass():
    low = np.load(os.path.join(BUILD, 'low.npz'))
    tid, bc = rasterize(low['uv'], RES)
    iy, ix = np.nonzero(tid >= 0)
    t = tid[iy, ix]; w0 = bc[iy, ix, 0]; w1 = bc[iy, ix, 1]; w2 = 1 - w0 - w1
    W = np.stack([w0, w1, w2], 1)[:, :, None]
    P = (low['pos'][low['lv'][t]] * W).sum(1).astype(F)
    N = nrm((low['nrm'][t] * W).sum(1)).astype(F)
    T = nrm((low['tan'][t] * W).sum(1)).astype(F)
    sg = low['sign'][t, 0]
    n = len(P); log('texels', n, 'coverage %.2f' % (n / RES / RES))
    order = np.lexsort((P[:, 1] // 0.05, P[:, 0] // 0.05, P[:, 2] // 0.05))
    iy, ix, P, N, T, sg = iy[order], ix[order], P[order], N[order], T[order], sg[order]
    # project onto the detailed surface along the interpolated low-poly normal
    tt = np.zeros(n, F)
    for it in range(5):
        d, _ = ev(P + tt[:, None] * N, margin=0.012, detail=(it >= 3), want_mat=False)
        tt = np.clip(tt - 0.9 * d, -0.012, 0.012)
    Ps = P + tt[:, None] * N
    log('projected; mean |offset| %.2f mm' % (np.abs(tt).mean() * 1e3))
    e = 0.00035
    g = np.zeros((n, 3), F)
    for k in np.array([[1, -1, -1], [-1, -1, 1], [-1, 1, -1], [1, 1, 1]], F):
        dk, _ = ev(Ps + e * k, margin=0.004, detail=True, want_mat=False)
        g += dk[:, None] * k
    no = nrm(g).astype(F)
    bad = (no * N).sum(1) < 0.12
    no[bad] = N[bad]
    log('normals; fallback texels %.2f%%' % (bad.mean() * 100))
    # material ids (+ cloth cut fields for frayed edges)
    mat = np.empty(n, np.uint8); cs = np.full(n, -1.0, F); ct = np.full(n, -1.0, F)
    for i in range(0, n, 50000):
        cloth.LAST.clear()
        _, mm_ = model.eval_model(Ps[i:i + 50000] - 0.0002 * no[i:i + 50000], margin=0.004)
        mat[i:i + 50000] = mm_
        if 'shirt_cut' in cloth.LAST:
            cs[i:i + 50000] = cloth.LAST['shirt_cut']
        if 'tr_cut' in cloth.LAST:
            ct[i:i + 50000] = cloth.LAST['tr_cut']
    # fine cavity
    dc, _ = ev(Ps + 0.0025 * no, margin=0.006, detail=True, want_mat=False)
    cav = np.clip(dc / 0.0025, 0.0, 1.0)
    # broad AO on every 2nd texel
    sub = ((ix % 2) == 0) & ((iy % 2) == 0)
    Pq, Nq, Tq = Ps[sub], no[sub], T[sub]
    Bq = nrm(np.cross(Nq, Tq)); Tq = np.cross(Bq, Nq)
    occ = np.zeros(len(Pq), F); wsum = 0.0
    c55, s55 = np.cos(np.radians(55)), np.sin(np.radians(55))
    dirs = [(Nq, 1.0, (0.008, 0.025, 0.06))] + [(nrm(c55 * Nq + s55 * sgn * v), c55, (0.015, 0.045)) for v in (Tq, Bq) for sgn in (1, -1)]
    for D, cth, hs in dirs:
        for h in hs:
            dd, _ = ev(Pq + D * h, margin=0.07, want_mat=False)
            occ += np.clip(1.0 - dd / (h * cth), 0.0, 1.0); wsum += 1.0
    aoq = np.clip(1.0 - 1.25 * occ / wsum, 0.0, 1.0)
    img = np.zeros((RES // 2, RES // 2), F); val = np.zeros((RES // 2, RES // 2), bool)
    img[iy[sub] // 2, ix[sub] // 2] = aoq; val[iy[sub] // 2, ix[sub] // 2] = True
    ind = ndimage.distance_transform_edt(~val, return_distances=False, return_indices=True)
    img = img[ind[0], ind[1]]
    img = ndimage.gaussian_filter(img, 0.7)
    ao = np.repeat(np.repeat(img, 2, 0), 2, 1)[iy, ix]
    log('ao done')
    # tangent space normal exactly the way three.js reconstructs it
    B = nrm(np.cross(N, T)) * sg[:, None]
    M = np.stack([T, B, N], 2).astype(np.float64)
    tn = nrm(np.linalg.solve(M, no.astype(np.float64)[:, :, None])[:, :, 0])
    tn[:, 2] = np.maximum(tn[:, 2], 0.05); tn = nrm(tn).astype(F)
    np.savez(GEO, iy=iy, ix=ix, P=Ps, no=no, tn=tn, mat=mat, ao=ao, cav=cav, cs=cs, ct=ct)
    log('geo saved')


# ----------------------------------------------------------------------------- painting helpers
def srgb(r, g, b):
    c = np.array([r, g, b], np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(F)


def lerp(a, b, t):
    return a + (b - a) * np.clip(t, 0.0, 1.0)[:, None]


BLOOD = srgb(74, 18, 13); BLOOD_D = srgb(34, 8, 7); DIRT = srgb(78, 66, 48); MUD = srgb(112, 97, 72); SOOT = srgb(30, 29, 27)
VARIANTS = {
    'a': dict(seed=0, shirt=srgb(96, 116, 138), trousers=srgb(60, 56, 53), boots=srgb(50, 37, 28)),
    'b': dict(seed=40, shirt=srgb(104, 98, 90), trousers=srgb(72, 62, 44), boots=srgb(38, 34, 31)),
    'c': dict(seed=80, shirt=srgb(172, 163, 140), trousers=srgb(47, 52, 62), boots=srgb(62, 42, 26)),
}


def blood_layer(c, r, P, amount, seed, thick=0.5):
    """Dried blood: dark brown-red, never bright; slightly glossier than the base."""
    n = fbm(P, 38.0, 3, seed=seed)
    a = np.clip(amount * (0.75 + 0.5 * n), 0.0, 1.0)
    a = sstep(0.25, 0.6, a)
    col = lerp(np.broadcast_to(BLOOD, (len(P), 3)), np.broadcast_to(BLOOD_D, (len(P), 3)), sstep(-0.2, 0.5, fbm(P, 90.0, 2, seed=seed + 3)) * thick + a * 0.3)
    c = c * (1 - a[:, None] * 0.93) + col * a[:, None] * 0.93
    r = r * (1 - a) + (0.36 + 0.2 * (1 - a)) * a
    return c, r


def paint_skin(P, no, ao, cav, sd):
    n = len(P)
    base = srgb(152, 150, 128); livor = srgb(104, 88, 100); pale = srgb(178, 170, 138)
    c = np.broadcast_to(base, (n, 3)).copy()
    c = lerp(c, livor, sstep(0.0, 0.5, fbm(P, 13.0, 3, seed=101 + sd)) * 0.8)
    c = lerp(c, pale, sstep(0.05, 0.5, fbm(P, 8.0, 2, seed=102 + sd)) * 0.45)
    c = lerp(c, srgb(118, 122, 96), sstep(0.1, 0.5, fbm(P, 22.0, 2, seed=103)) * 0.35)            # greenish decay
    c *= (1.0 + 0.10 * gnoise(P, 170.0, 104) + 0.07 * gnoise(P, 520.0, 105))[:, None]
    v = sstep(0.075, 0.0, np.abs(gnoise(P, 36.0, 66))) * sstep(-0.1, 0.25, gnoise(P, 9.0, 67))
    v2 = sstep(0.05, 0.0, np.abs(gnoise(P, 60.0, 106))) * sstep(0.0, 0.3, gnoise(P, 11.0, 107)) * 0.6
    c = lerp(c, srgb(52, 66, 72), np.maximum(v, v2) * 0.6)
    q = (P - HEAD_O.astype(F)) / F(mm); x, y, z = q[:, 0], q[:, 1], q[:, 2]
    r = 0.62 + 0.08 * gnoise(P, 90.0, 108)
    head = z > -110
    for s in (1, -1):
        de = np.linalg.norm(P - EYE_C[s].astype(F), axis=1)
        c = lerp(c, srgb(66, 44, 52), sstep(0.031, 0.0135, de) * 0.85 * head)
        c = lerp(c, srgb(120, 60, 60), sstep(0.0155, 0.0132, de) * 0.6 * head)                  # raw lid rims
    # lips, nose tip, ears: dark, necrotic
    lipd = Ellipsoid(hp(0, -96, -50), (0.027, 0.013, 0.009))(P)
    lip = sstep(0.003, -0.002, lipd)
    f1, f2 = worley(P, 420.0, 109)
    c = lerp(c, srgb(84, 58, 62), lip * 0.8); c = lerp(c, srgb(40, 22, 24), lip * sstep(0.12, 0.0, f2 - f1) * 0.8)
    nose = sstep(0.022, 0.008, np.linalg.norm(P - hp(0, -114, -15).astype(F), axis=1))
    ear = sstep(64.0, 76.0, np.abs(x)) * (np.abs(z) < 45) * head
    c = lerp(c, srgb(96, 70, 74), np.maximum(nose * 0.55, ear * 0.5))
    # stubble + brows + thin scalp hair shadow
    beard = head * sstep(-18.0, -30.0, z) * sstep(-10.0, -30.0, y) * (1 - lip) * sstep(-112.0, -100.0, z)
    speck = sstep(0.05, 0.45, gnoise(P, 1100.0, 110))
    c = lerp(c, srgb(48, 44, 44), beard * (0.22 + 0.4 * speck))
    brow = np.zeros(n, F)
    for s in (1, -1):
        bt = STube([hp(s * 9, -98, 33.5), hp(s * 26, -101, 37), hp(s * 43, -94, 36), hp(s * 52, -84, 32)], np.array([4.5, 5.5, 5, 3.5]) * mm, 3)(P)
        brow = np.maximum(brow, sstep(0.004, -0.001, bt))
    bs = gnoise(np.stack([P[:, 0] * 260.0, P[:, 1] * 260.0, P[:, 2] * 1300.0 + np.abs(P[:, 0]) * 2400.0], 1).astype(F), 1.0, 111)
    c = lerp(c, srgb(36, 30, 26), brow * sstep(-0.35, 0.3, bs) * 0.9)
    sc = body.scalp_mask(P) * head
    c = lerp(c, srgb(60, 54, 50), sc * (0.35 + 0.3 * speck))
    # fingertips + nails
    hand = np.abs(P[:, 0]) > 0.55
    if hand.any():
        Ph = P[hand]; ft = np.zeros(len(Ph), F); nail = np.zeros(len(Ph), F); rim = np.zeros(len(Ph), F)
        for s in (1, -1):
            for tip, d_, bn, rr in body.HAND_TIPS[s]:
                rel = Ph - tip.astype(F)
                a = -(rel @ d_.astype(F)); up = rel @ bn.astype(F)
                lat = np.linalg.norm(rel + a[:, None] * d_.astype(F) - up[:, None] * bn.astype(F), axis=1)
                ft = np.maximum(ft, sstep(0.026, 0.004, np.linalg.norm(rel, axis=1)))
                nm = sstep(-0.004, -0.0015, -a) * sstep(0.0125, 0.0105, a) * sstep(rr * 0.80, rr * 0.62, lat) * sstep(rr * 0.25, rr * 0.5, up)
                nail = np.maximum(nail, nm)
                rim = np.maximum(rim, nm * sstep(0.0035, 0.0005, a))
        ch = lerp(c[hand], srgb(72, 54, 56), ft * 0.65)
        ch = lerp(ch, srgb(150, 138, 108), nail * 0.85); ch = lerp(ch, srgb(34, 26, 22), rim * 0.9)
        c[hand] = ch; r[hand] = r[hand] * (1 - nail) + 0.35 * nail
    # grime in creases
    c = lerp(c, srgb(58, 48, 40), (1 - cav) * 0.55 + (1 - ao) * 0.25)
    c = lerp(c, DIRT, sstep(0.1, 0.6, fbm(P, 17.0, 3, seed=112 + sd)) * 0.3)
    # dried blood: mouth and chin, drips down the throat, wounds, hands
    bl = np.zeros(n, F)
    dm = np.linalg.norm((P - hp(0, -92, -56).astype(F)) * np.array([1.0, 0.7, 0.8], F), axis=1)
    bl = np.maximum(bl, sstep(0.050, 0.016, dm) * 1.05 * head)
    Qd = np.stack([P[:, 0] * 75.0, P[:, 1] * 20.0, P[:, 2] * 7.0], 1).astype(F)
    drip = sstep(-0.05, 0.35, gnoise(Qd, 1.0, 113 + sd)) * sstep(0.055, 0.01, np.abs(x * mm - 0.004)) * sstep(-260.0, -60.0, z) * sstep(-40.0, -62.0, z) * (y < 20)
    bl = np.maximum(bl, drip * 0.95)
    for w, rad, amt in ((body.W_CHEEK, 0.016, 1.1), (body.W_NECK, 0.03, 1.0), (body.W_ARM, 0.03, 1.0), (body.W_RIB, 0.04, 1.0), (body.W_HEAD, 0.014, 1.0)):
        m = ((P >= w.lo - rad) & (P <= w.hi + rad)).all(1)
        if m.any():
            bl[m] = np.maximum(bl[m], sstep(rad, 0.0, w(P[m])) * amt)
    hl = np.zeros(n, F)
    for s in (1, -1):
        th = (P - mx(WR, s).astype(F)) @ mx(ARM_DIR, s).astype(F)
        hl = np.maximum(hl, sstep(-0.03, 0.09, th) * (P[:, 0] * s > 0.5))
    bl = np.maximum(bl, hl * (0.55 + 0.5 * fbm(P, 24.0, 2, seed=114 + sd)))
    spl, _ = worley(P, 55.0, 115 + sd)
    bl = np.maximum(bl, sstep(0.26, 0.16, spl) * sstep(0.0, 0.4, fbm(P, 6.0, 2, seed=116 + sd)) * 0.9)
    c, r = blood_layer(c, r, P, bl, 117 + sd)
    return c, r


def paint_flesh(P, no, ao, cav, sd):
    n = len(P)
    c = np.broadcast_to(srgb(104, 28, 24), (n, 3)).copy()
    c = lerp(c, srgb(40, 8, 8), sstep(-0.3, 0.4, fbm(P, 85.0, 3, seed=121)))
    f1, _ = worley(P, 260.0, 122)
    c = lerp(c, srgb(150, 118, 78), sstep(0.32, 0.18, f1) * 0.5 * cav)                           # fatty tissue
    rd = body.rib_dist(P)
    bone = sstep(0.0012, 0.0002, rd)
    c = lerp(c, lerp(np.broadcast_to(srgb(172, 156, 118), (n, 3)), BLOOD, sstep(0.0, 0.5, fbm(P, 60.0, 2, seed=123)) * 0.6), bone)
    inm = body.W_MOUTH(P) < 0.001
    c[inm] = lerp(c[inm], srgb(46, 13, 15), np.full(int(inm.sum()), 0.8, F))
    tong = Ellipsoid(hp(0, -70, -61), (0.017, 0.023, 0.0065))(P) < 0.0005
    c[tong] = lerp(c[tong], srgb(92, 48, 52), np.full(int(tong.sum()), 0.8, F))
    c *= (0.35 + 0.65 * cav)[:, None] * (0.6 + 0.4 * ao)[:, None]
    r = 0.30 + 0.25 * sstep(-0.2, 0.5, fbm(P, 70.0, 2, seed=124)) + 0.25 * bone
    return c, r


def paint_eye(P, no, ao, cav, sd):
    n = len(P)
    c = np.broadcast_to(srgb(176, 170, 152), (n, 3)).copy()
    r = np.full(n, 0.16, F)
    for s in (1, -1):
        rel = P - EYE_C[s].astype(F)
        m = np.linalg.norm(rel, axis=1) < EYE_R * 1.3
        if not m.any():
            continue
        u = nrm(rel[m])
        gaze = unit_v(rotm(2.0 if s > 0 else -3.0, 0, 7.0 * s if s > 0 else -2.0) @ np.array([0, -1, 0.0]))
        ang = np.degrees(np.arccos(np.clip(u @ gaze.astype(F), -1, 1)))
        cc = c[m]
        veins = sstep(0.08, 0.0, np.abs(gnoise(P[m], 420.0, 131))) * sstep(24.0, 50.0, ang)
        cc = lerp(cc, srgb(120, 40, 34), veins * 0.7)
        cc = lerp(cc, srgb(150, 120, 96), sstep(30.0, 60.0, ang) * 0.5)
        iris = sstep(28.5, 25.5, ang)
        fib = 0.5 + 0.5 * gnoise(np.stack([np.arctan2(u[:, 0], u[:, 2]) * 9.0, ang * 0.25, ang * 0.0], 1).astype(F), 1.0, 132)
        ic = lerp(np.broadcast_to(srgb(132, 142, 140), (len(u), 3)), srgb(92, 104, 108), fib * 0.6)
        ic = lerp(ic, srgb(62, 70, 74), sstep(22.0, 27.5, ang) * 0.8)                           # limbal ring
        ic = lerp(ic, srgb(96, 102, 100), sstep(9.5, 7.0, ang))                                 # clouded pupil
        cc = lerp(cc, ic, iris * 0.92)
        cc = lerp(cc, srgb(196, 198, 190), sstep(-0.1, 0.5, fbm(P[m], 150.0, 2, seed=133)) * 0.3 * iris)   # milky film
        c[m] = cc
    c *= (0.55 + 0.45 * ao)[:, None]
    return c, r


def unit_v(v):
    return v / np.linalg.norm(v)


def paint_teeth(P, no, ao, cav, sd):
    n = len(P)
    c = np.broadcast_to(srgb(196, 176, 122), (n, 3)).copy()
    st = np.clip((1 - cav) * 0.9 + 0.5 * sstep(-0.1, 0.5, fbm(P, 260.0, 2, seed=141)), 0, 1)
    c = lerp(c, srgb(104, 74, 40), st * 0.75)
    c = lerp(c, BLOOD, sstep(0.05, 0.5, fbm(P, 120.0, 2, seed=142 + sd)) * 0.5)
    c *= (0.5 + 0.5 * ao)[:, None]
    return c, np.full(n, 0.30, F)


def paint_hair(P, no, ao, cav, sd, skin_c):
    q = (P - HEAD_O.astype(F))
    phi = np.arctan2(q[:, 0], q[:, 1] - 0.028)
    rad = np.sqrt(q[:, 0] ** 2 + (q[:, 1] - 0.028) ** 2 + (q[:, 2] - 0.13) ** 2)
    Q = np.stack([phi * 46.0, rad * 26.0, q[:, 2] * 12.0], 1).astype(F)
    s1 = gnoise(Q, 1.0, 73) + 0.6 * gnoise(Q * F(2.3), 1.0, 74)
    s2 = gnoise(Q * F(5.0), 1.0, 151)
    c = lerp(np.broadcast_to(srgb(34, 29, 25), (len(P), 3)), srgb(92, 84, 72), sstep(-0.2, 0.9, s1) * 0.55 + sstep(0.2, 0.6, s2) * 0.25)
    c = lerp(c, DIRT, sstep(0.1, 0.6, fbm(P, 30.0, 2, seed=152 + sd)) * 0.3)
    cov = body.hair_cover(P)
    c = lerp(skin_c, c, sstep(0.08, 0.45, cov) * (0.75 + 0.25 * sstep(-0.5, 0.2, s2)))
    c *= (0.6 + 0.4 * cav)[:, None]
    return c, np.full(len(P), 0.55, F) + 0.1 * s2


def cloth_common(c, r, P, cav, ao, fray_c, sd, dirt_amt):
    n = len(P)
    c = c * (1.0 + 0.085 * gnoise(P, 760.0, 161) + 0.06 * gnoise(P, 260.0, 162) + 0.05 * gnoise(P, 45.0, 163))[:, None]
    c = lerp(c, c * 1.35 + 0.02, sstep(0.0, 0.6, fbm(P, 6.5, 3, seed=164 + sd)) * 0.4)             # sun fading
    c = lerp(c, DIRT * 0.8, np.clip(dirt_amt, 0, 1) * (0.55 + 0.45 * fbm(P, 19.0, 3, seed=165 + sd)))
    c = lerp(c, SOOT, sstep(0.15, 0.55, fbm(P, 5.0, 3, seed=166 + sd)) * 0.45)
    c = lerp(c, c * 0.45, (1 - cav) * 0.6)                                                       # dirt in folds
    fr = sstep(-0.008, -0.0008, fray_c)
    th = 0.5 + 0.5 * gnoise(P, 1300.0, 167)
    c = lerp(c, c * 0.5 + srgb(150, 144, 128) * 0.6, fr * th * 0.8)
    r = r + 0.05 * fr
    return c, r


def paint_shirt(P, no, ao, cav, sd, V, cs):
    n = len(P); x, y, z = P[:, 0], P[:, 1], P[:, 2]
    c = np.broadcast_to(V['shirt'], (n, 3)).copy(); r = np.full(n, 0.86, F)
    dirt = sstep(1.15, 0.90, z) * 0.75
    for s in (1, -1):
        t = (P - mx(EL, s).astype(F)) @ mx(ARM_DIR, s).astype(F)
        dirt = np.maximum(dirt, sstep(0.10, 0.24, t) * (x * s > 0.3) * 0.8)
        pit = np.linalg.norm(P - np.array([s * 0.165, 0.02, 1.355], F), axis=1)
        c = lerp(c, c * srgb(190, 175, 120), sstep(0.10, 0.03, pit) * 0.55)
    coll = np.linalg.norm((P - np.array([0, 0.015, 1.50], F)) * np.array([1, 1, 1.5], F), axis=1)
    dirt = np.maximum(dirt, sstep(0.12, 0.07, coll) * 0.6)
    c, r = cloth_common(c, r, P, cav, ao, cs, sd, dirt)
    # buttons
    bz = (z - 1.02) / 0.085
    bd = np.sqrt((x + 0.004) ** 2 + ((bz - np.round(bz)) * 0.085) ** 2)
    btn = sstep(0.0058, 0.0046, bd) * (y < 0) * (z < 1.36) * (z > 0.93)
    c = lerp(c, srgb(66, 60, 50), btn); r = r * (1 - btn) + 0.4 * btn
    # blood: bib from the mouth, soak around the rib wound with a gravity trail, splatter
    bl = sstep(1.08, 1.40, z) * sstep(0.13, 0.02, np.abs(x - 0.012 - 0.05 * (1.45 - z))) * (y < 0.02) * 0.95
    Qd = np.stack([x * 62.0, y * 20.0, z * 5.0], 1).astype(F)
    bl = np.maximum(bl, sstep(0.0, 0.4, gnoise(Qd, 1.0, 171 + sd)) * sstep(0.95, 1.2, z) * sstep(0.16, 0.05, np.abs(x)) * (y < 0.0) * 0.85)
    dr = np.linalg.norm((P - body.RIB_C.astype(F)) * np.array([1, 1, 0.75], F), axis=1)
    bl = np.maximum(bl, sstep(0.15, 0.045, dr) * 1.05)
    trail = sstep(0.07, 0.02, np.abs(x - body.RIB_C[0] + 0.02 * gnoise(P, 14.0, 172))) * sstep(0.86, 1.0, z) * (z < body.RIB_C[2]) * (y < 0.03)
    bl = np.maximum(bl, trail * 0.9)
    spl, _ = worley(P, 48.0, 173 + sd)
    bl = np.maximum(bl, sstep(0.27, 0.15, spl) * sstep(-0.1, 0.4, fbm(P, 5.0, 2, seed=174 + sd)) * 0.95)
    bl = np.maximum(bl, sstep(0.05, 0.4, fbm(P, 4.0, 2, seed=175 + sd)) * sstep(0.12, 0.3, np.abs(x)) * 0.55)
    c, r = blood_layer(c, r, P, bl, 176 + sd, thick=0.8)
    r = np.maximum(r, 0.5)
    return c, r


def paint_trousers(P, no, ao, cav, sd, V, ct):
    n = len(P); x, y, z = P[:, 0], P[:, 1], P[:, 2]
    c = np.broadcast_to(V['trousers'], (n, 3)).copy(); r = np.full(n, 0.9, F)
    dirt = sstep(0.62, 0.15, z) * 0.9
    for s in (1, -1):
        dk = np.linalg.norm(P - (mx(KNEE, s) + np.array([0, -0.06, 0.0])).astype(F), axis=1)
        c = lerp(c, c * 1.5 + 0.02, sstep(0.09, 0.03, dk) * 0.5)
        dirt = np.maximum(dirt, sstep(0.10, 0.04, dk) * 0.7)
    c, r = cloth_common(c, r, P, cav, ao, ct, sd, dirt)
    mud = sstep(0.42, 0.10, z) * sstep(-0.25, 0.35, fbm(P, 16.0, 3, seed=181 + sd))
    c = lerp(c, MUD * (0.8 + 0.3 * gnoise(P, 140.0, 182))[:, None], mud * 0.85)
    spl, _ = worley(P, 44.0, 183 + sd)
    bl = sstep(0.26, 0.15, spl) * sstep(-0.05, 0.4, fbm(P, 5.0, 2, seed=184 + sd)) * sstep(0.45, 0.7, z)
    bl = np.maximum(bl, sstep(0.14, 0.03, np.linalg.norm(P - np.array([0.105, -0.07, 0.80], F), axis=1)) * 0.9)
    c, r = blood_layer(c, r, P, bl, 185 + sd, thick=0.8)
    return c, np.maximum(r, 0.5)


def paint_boots(P, no, ao, cav, sd, V):
    n = len(P); z = P[:, 2]
    c = np.broadcast_to(V['boots'], (n, 3)).copy(); r = 0.52 + 0.1 * gnoise(P, 80.0, 191)
    c *= (1.0 + 0.15 * gnoise(P, 300.0, 192) + 0.1 * gnoise(P, 40.0, 193))[:, None]
    scuff = sstep(0.1, 0.55, fbm(P, 55.0, 3, seed=194 + sd)) * (0.35 + 0.65 * cav) * sstep(0.2, 0.0, z)
    c = lerp(c, srgb(128, 104, 76), scuff * 0.7); r = r + 0.25 * scuff
    sole = sstep(0.024, 0.019, z)
    c = lerp(c, srgb(26, 24, 22), sole); r = r * (1 - sole) + 0.8 * sole
    mud = np.clip(sstep(0.11, 0.015, z) * (0.55 + 0.6 * fbm(P, 30.0, 3, seed=195 + sd)) + sstep(0.2, 0.6, fbm(P, 12.0, 2, seed=196 + sd)) * 0.6, 0, 1)
    c = lerp(c, MUD * (0.75 + 0.35 * gnoise(P, 170.0, 197))[:, None], mud * 0.9); r = r * (1 - mud) + 0.95 * mud
    c = lerp(c, c * 0.35, (1 - cav) * 0.7)
    return c, r


def paint_belt(P, no, ao, cav, sd):
    n = len(P)
    c = np.broadcast_to(srgb(64, 40, 25), (n, 3)).copy(); r = np.full(n, 0.55, F); me = np.zeros(n, F)
    f1, f2 = worley(P, 300.0, 201)
    c = lerp(c, srgb(24, 15, 10), sstep(0.1, 0.0, f2 - f1) * 0.7)
    c *= (1.0 + 0.15 * gnoise(P, 200.0, 202))[:, None]
    bk = Box((-0.004, -0.0945, cloth.BELT_Z), (0.025, 0.0045, 0.0225), 0.003)(P) < 0.0008
    rust = sstep(0.0, 0.5, fbm(P, 120.0, 3, seed=203))
    cb = lerp(np.broadcast_to(srgb(128, 122, 110), (n, 3)), srgb(96, 54, 30), rust)
    c[bk] = cb[bk]; r[bk] = 0.42 + 0.35 * rust[bk]; me[bk] = 1.0 - 0.8 * rust[bk]
    c = lerp(c, c * 0.4, (1 - cav) * 0.6)
    return c, r, me


def to_srgb8(c):
    c = np.clip(c, 0, 1)
    s = np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
    return (s * 255.0 + 0.5).astype(np.uint8)


def write_image(iy, ix, vals, path, **kw):
    ch = vals.shape[1]
    img = np.zeros((RES, RES, ch), np.uint8); ok = np.zeros((RES, RES), bool)
    img[iy, ix] = vals; ok[iy, ix] = True
    ind = ndimage.distance_transform_edt(~ok, return_distances=False, return_indices=True)
    img = img[ind[0], ind[1]][::-1]
    Image.fromarray(img if ch > 1 else img[:, :, 0]).save(path, **kw)


def paint_pass(only=None):
    g = np.load(GEO)
    iy, ix, P, no, tn, mat, ao, cav = (g[k] for k in ('iy', 'ix', 'P', 'no', 'tn', 'mat', 'ao', 'cav'))
    cs, ct = g['cs'], g['ct']
    n = len(P)
    if only is None:
        write_image(iy, ix, (np.clip(tn * 0.5 + 0.5, 0, 1) * 255 + 0.5).astype(np.uint8), os.path.join(TEX, 'normal.png'), optimize=True)
        Image.open(os.path.join(TEX, 'normal.png')).save(os.path.join(TEX, 'normal.jpg'), quality=94, subsampling=0)
    aoc = np.clip(ao * (0.55 + 0.45 * cav), 0, 1)
    for vn, V in VARIANTS.items():
        if only and vn not in only:
            continue
        sd = V['seed']
        c = np.zeros((n, 3), F); r = np.full(n, 0.7, F); me = np.zeros(n, F)
        for name, fn in (('skin', paint_skin), ('flesh', paint_flesh), ('eye', paint_eye), ('teeth', paint_teeth)):
            m = mat == MAT[name]
            if m.any():
                c[m], r[m] = fn(P[m], no[m], ao[m], cav[m], sd)
        m = mat == MAT['hair']
        if m.any():
            sc, _ = paint_skin(P[m], no[m], ao[m], cav[m], sd)
            c[m], r[m] = paint_hair(P[m], no[m], ao[m], cav[m], sd, sc)
        m = mat == MAT['shirt']; c[m], r[m] = paint_shirt(P[m], no[m], ao[m], cav[m], sd, V, cs[m])
        m = mat == MAT['trousers']; c[m], r[m] = paint_trousers(P[m], no[m], ao[m], cav[m], sd, V, ct[m])
        m = mat == MAT['boots']; c[m], r[m] = paint_boots(P[m], no[m], ao[m], cav[m], sd, V)
        m = mat == MAT['belt']
        if m.any():
            c[m], r[m], me[m] = paint_belt(P[m], no[m], ao[m], cav[m], sd)
        c *= (0.72 + 0.28 * ao)[:, None]                       # a little baked occlusion keeps crevices grounded
        write_image(iy, ix, to_srgb8(c), os.path.join(TEX, 'albedo_%s.jpg' % vn), quality=90, subsampling=0)
        if vn == 'a':
            orm = np.stack([aoc, np.clip(r, 0.08, 1.0), me], 1)
            write_image(iy, ix, (orm * 255 + 0.5).astype(np.uint8), os.path.join(TEX, 'orm.jpg'), quality=90, subsampling=0)
        log('painted variant', vn)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if mode in ('geo', 'all'):
        geo_pass()
    if mode in ('paint', 'all'):
        paint_pass(sys.argv[2] if len(sys.argv) > 2 else None)
    log('BAKE_DONE')
