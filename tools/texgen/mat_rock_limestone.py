"""rock_limestone - pale grey Dolomite limestone: fractured blocks, bedding
strata, joints, solution pitting, weathering stains, lichen."""
import numpy as np
from .core import *  # noqa: F401,F403


def _facets(c, tag, cell_m, slope, off, warp_m=0.0, k=2):
    T = c.tile
    g = max(2, int(round(T / cell_m)))
    pts = jitter_points(g, g, 1.0, c.rng(tag))
    wx = wy = None
    if warp_m:
        wx = c.noise(tag + "wx", cell_m * 2.5, cell_m * 0.3) * (warp_m / T)
        wy = c.noise(tag + "wy", cell_m * 2.5, cell_m * 0.3) * (warp_m / T)
    V = c.voronoi(pts, k=k, wx=wx, wy=wy)
    rr = c.rng(tag + "a").normal(0, 1, (len(pts), 4)).astype(F)
    hgt = (V.dx * rr[V.id, 0] + V.dy * rr[V.id, 1]) * T * slope + rr[V.id, 2] * off
    return hgt.astype(F), V, rr


def build(c):
    n, T = c.n, c.tile
    k = n / 2048.0
    # --- bedding strata of random thickness, broken into blocks by a joint set
    r = c.rng("strata")
    th = r.uniform(0.14, 0.55, 60)
    th = th[: np.searchsorted(np.cumsum(th), T) + 1]
    edges = np.concatenate([[0.0], np.cumsum(th)])
    edges = edges / edges[-1]
    NL = len(th)
    wy = c.y + c.noise("sw", 3.0, 0.4, H=1.0) * (0.06 / T) + c.noise("sw2", 0.3, 0.03) * (0.005 / T)         + np.sin(c.x * TAU + 1.0) * 0.010
    wy = wy % 1.0
    li = np.clip(np.searchsorted(edges, wy.ravel()) - 1, 0, NL - 1).reshape(n, n)
    thick = (edges[li + 1] - edges[li]).astype(F) * T
    fr = ((wy - edges[li]) / (edges[li + 1] - edges[li])).astype(F)       # 0 top .. 1 bottom of layer
    wx = c.x + c.noise("jw", 0.6, 0.05, H=0.9) * (0.035 / T)
    bid = np.zeros((n, n), np.int32)
    dxj = np.zeros((n, n), F)
    for l in range(NL):
        sp = r.uniform(0.25, 1.3, 40)
        jp = np.cumsum(sp)
        jp = jp[jp < T] / T
        if len(jp) < 2:
            jp = np.array([0.3, 0.8])
        jp = np.sort((jp + r.random()) % 1.0)
        m = li == l
        xx = (wx[m] + (fr[m] - 0.5) * r.normal(0, 0.012)) % 1.0
        j = np.searchsorted(jp, xx) % len(jp)
        right = jp[j]
        left = jp[j - 1]
        dr_ = (right - xx) % 1.0
        dl_ = (xx - left) % 1.0
        dxj[m] = np.minimum(dr_, dl_) * T
        bid[m] = l * 64 + j
    NB = NL * 64
    rb = c.rng("blocks").normal(0, 1, (NB, 6)).astype(F)
    dyb = np.minimum(fr, 1.0 - fr) * thick
    jn = c.noise("jn", 0.15, 0.015, H=0.6) * 0.004
    edge_d = np.minimum(dxj, dyb) + jn
    jv = 0.15 + 0.85 * smoothstep(-0.6, 0.7, c.noise("jv", 1.4, 0.15, H=0.8) + rb[bid, 4] * 0.5)   # tight vs open joints
    joint = smoothstep(0.007, 0.001, edge_d) * jv
    joint_soft = smoothstep(0.05, 0.0, edge_d) * jv
    bev = smoothstep(0.0, 0.035, edge_d)
    bed = smoothstep(0.03, 0.0, dyb + jn) * jv
    blk = rb[bid, 0] * 0.022 * (0.4 + 0.6 * jv) + (fr - 0.5) * thick * rb[bid, 1] * 0.10 + rb[bid, 2] * dxj * 0.06 - (1 - bev) * 0.018 * jv
    hm, Vm, rm = _facets(c, "med", 0.30, 0.20, 0.006, warp_m=0.04)
    hs, Vs, rs = _facets(c, "small", 0.075, 0.26, 0.0012, warp_m=0.010)
    chipm = smoothstep(-0.5, 0.9, c.noise("chipm", 1.5, 0.2))             # where the face is freshly broken
    n1 = c.noise("n1", 2.5, 0.03, H=0.8)
    n2 = c.noise("n2", 0.05, None, H=0.35)
    h = blk + hm * (0.25 + 0.75 * chipm) + hs * (0.25 + 0.75 * chipm) + n1 * 0.016 + n2 * 0.0010
    h -= joint * 0.05 + joint_soft * 0.010
    lr = c.rng("layers").normal(0, 1, (NL, 4)).astype(F)
    strata_w = 1.0
    # fractures cutting across the beds
    crk = crack_map(n, c.rng("crk"), 14, length=(0.08, 0.4), step=0.004, wander=0.22, kink=0.14,
                    branch=0.10, width=(1.0 * k, 2.4 * k), heading=np.pi / 2, spread=0.7)
    crk_s = blur(crk, 2.0 * k)
    h -= crk * 0.012 + crk_s * 0.005
    # solution pitting (karst)
    pp = jitter_points(int(T / 0.028), int(T / 0.028), 1.0, c.rng("pits"))
    Vp = c.voronoi(pp, k=2)
    pr = c.rng("pits2").random((len(pp), 2)).astype(F)
    parea = smoothstep(0.0, 1.3, c.noise("parea", 1.2, 0.15))
    prad = (0.003 + 0.010 * pr[Vp.id, 0]) / T
    pit = smoothstep(prad, prad * 0.3, Vp.f1) * (pr[Vp.id, 1] < 0.5 * parea)
    h -= pit * (0.0035 + 0.006 * pr[Vp.id, 0])
    h = blur(h, 0.5)

    # --- albedo
    col = np.empty((n, n, 3), F)
    col[:] = rgb(174, 172, 166)
    tone = 1.0 + 0.04 * rb[bid, 3] + 0.04 * lr[li, 2] + 0.03 * rm[Vm.id, 3]
    col = col * tone[..., None]
    warm = sat(0.5 + 0.35 * c.noise("warm", 2.0, 0.1, H=0.8) + 0.25 * lr[li, 3] * strata_w)
    col = mix(col, col * np.array([1.07, 1.0, 0.90], F), warm * 0.7)       # beige beds
    col = col * (1.0 + 0.035 * c.noise("mott", 0.3, 0.01, H=0.4) + 0.02 * n2)[..., None]
    # grey weather patina vs fresh pale breaks
    pat = smoothstep(-0.6, 1.2, c.noise("pat", 1.2, 0.015, H=0.45) - chipm * 0.8)
    col = mix(col, col * np.array([0.78, 0.785, 0.79], F), pat * 0.7)
    fresh = smoothstep(0.8, 1.6, rs[Vs.id, 3] + chipm * 1.2 - 0.6)
    col = mix(col, rgb(208, 203, 192), fresh * 0.5)
    cv = c.curv(h, 0.012)
    col = mix(col, col * 1.1 + 0.015, sat(cv / 0.004) * 0.45)
    # dark rain streaks below ledges / joints
    src = sat(bed * 0.7 + joint * 0.4) * smoothstep(0.3, 1.5, c.noise("ssrc", 0.5, 0.04, H=0.5, sx=2.0))
    stk = streak_down(src, 0.5 * c.ppm)
    stk = sat(stk / (np.percentile(stk[::4, ::4], 99.5) + 1e-6))
    stk *= 0.55 + 0.45 * sat(0.5 + 0.5 * c.noise("fib", 0.08, 0.008, H=0.3, sy=10.0))
    col = mix(col, rgb(88, 88, 90), stk * 0.5)
    # iron staining near fractures
    rust = sat(crk_s * 2.0 + joint_soft * 0.5) * smoothstep(0.3, 1.6, c.noise("rust", 0.6, 0.04, H=0.6))
    col = mix(col, rgb(176, 140, 98), rust * 0.42)
    # cavity dirt, dark joints
    cav = sat(-c.curv(h, 0.03) / 0.012)
    col = mix(col, col * np.array([0.6, 0.58, 0.55], F), sat(cav * 0.6 + bed * 0.5) * 0.7)
    col = mix(col, rgb(70, 66, 60), sat(crk * 1.1 + joint) * 0.6)
    col = mix(col, col * 0.72, pit * 0.6)
    # lichen
    lp = jitter_points(int(T / 0.07), int(T / 0.07), 1.0, c.rng("lich"))
    Vl = c.voronoi(lp, k=2)
    lq = c.rng("lich2").random((len(lp), 3)).astype(F)
    larea = smoothstep(-0.3, 1.3, c.noise("larea", 2.0, 0.3))
    rad = (0.006 + 0.03 * lq[Vl.id, 0] ** 2) / T
    lnz = c.noise("lichn", 0.02, 0.004, H=0.2) * (0.003 / T)
    spot = smoothstep(rad, rad * 0.7, Vl.f1 + lnz) * (lq[Vl.id, 1] < 0.4 * larea + 0.03) * (1 - joint)
    kind = lq[Vl.id, 2]
    lcol = np.where((kind < 0.14)[..., None], rgb(198, 150, 52),
                    np.where((kind < 0.38)[..., None], rgb(74, 74, 72), rgb(204, 205, 196)))
    col = mix(col, lcol, spot * 0.75)
    moss = sat(cav * 1.3 + joint_soft - 0.2) * smoothstep(0.9, 1.7, c.noise("moss", 1.5, 0.05, H=0.5))
    col = mix(col, rgb(86, 92, 52), moss * 0.6)

    rough = 0.88 + 0.04 * pat - 0.05 * fresh + 0.02 * n2
    rough = lerp(rough, 0.95, sat(spot + moss))
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.12, ao_gain=1.0))
