"""roof_tiles - terracotta barrel tiles (coppi). EXACTLY 16 columns across U
and 10 rows along V. Image top (v=1) is the ridge side, bottom the eave side:
each tile's exposed lower edge points down the image."""
import numpy as np
from .core import *  # noqa: F401,F403

NC, NR = 16, 10
BIG = -1.0e3


def _course(X, Y, P, concave):
    """Max-composite the three tiles of one column that can cover a pixel.
    X: column coordinate, Y: row coordinate (down). Returns z, tile id, e, q."""
    ci = np.floor(X).astype(np.int32)
    s = (X - ci - 0.5).astype(F)
    ci %= NC
    r0 = np.floor(Y).astype(np.int32)
    bz = np.full(X.shape, BIG, F)
    bid = np.zeros(X.shape, np.int32)
    be = np.zeros(X.shape, F)
    bq = np.zeros(X.shape, F)
    for dr in (1, 0, -1):
        rr = r0 + dr
        tid = ci * NR + (rr % NR)
        e = (rr + 1 + P["delta"][tid]) - Y                 # rows up from the lower edge
        s2 = s - P["shift"][tid] - P["skew"][tid] * (e - 0.5)
        e_eff = e - P["irr"] - P["notch"] * P["chipf"][tid]
        w = P["w"][tid] - P["taper"] * e
        q = s2 / w
        ok = (e_eff > P["cut"][tid]) & (e < P["len"]) & (np.abs(q) < 1.0)
        arch = np.sqrt(np.maximum(1.0 - q * q, 0.0))
        if concave:
            z = P["zb"][tid] + P["step"] * (1.0 - e) + P["H"] * (1.0 - arch)
        else:
            z = P["zb"][tid] + P["step"] * (1.0 - e) + P["H"] * (w / P["w"][tid]) * arch
            z = z + P["tilt"][tid] * q * 0.004
        z = np.where(ok, z, BIG).astype(F)
        up = z > bz
        bz = np.where(up, z, bz)
        bid = np.where(up, tid, bid)
        be = np.where(up, e_eff, be)
        bq = np.where(up, q, bq)
    return bz, bid, be, bq


def build(c):
    n, T = c.n, c.tile
    k = n / 2048.0
    r = c.rng("tiles")
    NT = NC * NR
    X = c.x * NC + c.noise("wx", 1.6, 0.4) * 0.012
    Y = c.y * NR + c.noise("wy", 1.6, 0.4) * 0.012
    irr = c.noise("edge", 0.07, 0.012, H=0.6) * 0.010
    notch = smoothstep(1.3, 2.3, c.noise("notch", 0.06, 0.015, H=0.8)) * 0.10

    # --- cover tiles (convex)
    delta = r.uniform(-0.035, 0.05, NT)
    slip = r.choice(NT, 5, replace=False)
    delta[slip] = r.uniform(0.14, 0.26, 5)
    cut = np.zeros(NT)
    broken = r.choice(NT, 3, replace=False)
    cut[broken] = r.uniform(0.3, 0.55, 3)
    PC = dict(delta=delta.astype(F), shift=r.normal(0, 0.014, NT).astype(F), skew=r.normal(0, 0.022, NT).astype(F),
              irr=irr, notch=notch, chipf=(r.random(NT) < 0.3).astype(F), cut=cut.astype(F),
              w=r.uniform(0.355, 0.40, NT).astype(F), taper=0.045, len=1.45,
              zb=(0.016 + r.normal(0, 0.0022, NT)).astype(F), step=0.019, H=0.068,
              tilt=r.normal(0, 1, NT).astype(F))
    zc, idc, ec, qc = _course(X, Y, PC, False)
    # --- channel tiles (concave), centred on the column boundaries, laps staggered per column
    off = np.repeat(r.uniform(0.25, 0.75, NC), NR)
    Xh = X + 0.5
    cih = (np.floor(Xh).astype(np.int32) % NC)
    Yh = Y + off[cih * NR].astype(F)
    PH = dict(delta=r.uniform(-0.04, 0.04, NT).astype(F), shift=r.normal(0, 0.012, NT).astype(F),
              skew=r.normal(0, 0.015, NT).astype(F), irr=irr * 0.7, notch=notch * 0.5,
              chipf=(r.random(NT) < 0.2).astype(F), cut=np.zeros(NT, F),
              w=np.full(NT, 0.56, F), taper=0.0, len=1.6,
              zb=(0.0 + r.normal(0, 0.0015, NT)).astype(F), step=0.017, H=0.075,
              tilt=np.zeros(NT, F))
    zh, idh, eh, qh = _course(Xh, Yh, PH, True)
    zh = np.maximum(zh, -0.01)

    is_cov = zc > zh
    h = np.where(is_cov, zc, zh).astype(F)
    tid = np.where(is_cov, idc, idh + NT)
    e = np.where(is_cov, ec, eh)
    q = np.where(is_cov, qc, qh)
    cov = is_cov.astype(F)

    # --- surface detail
    stri = c.noise("stri", 0.02, 0.003, H=0.3, sy=9.0)
    grain = c.noise("grain", 0.008, None, H=-0.3)
    bump = c.noise("bump", 0.14, 0.02, H=0.8)
    pit = smoothstep(2.9, 3.7, c.noise("pit", 0.009, 0.003, H=0.0))
    h += stri * 0.00028 + grain * 0.00010 + bump * 0.0009 - pit * 0.0004
    # cracked tiles
    tr = c.rng("tile_attr").random((2 * NT, 8)).astype(F)
    crk_flag = (tr[tid, 0] < 0.09).astype(F)
    line = e - (0.3 + 0.45 * tr[tid, 1]) - 0.06 * np.sin(q * 3.0 + tr[tid, 2] * TAU) - irr * 2.0
    crack = smoothstep(0.016, 0.004, np.abs(line)) * crk_flag
    h -= crack * 0.007 + crk_flag * (line < 0) * 0.0025

    # --- debris, moss in the valleys and at the laps
    chan_c = (1.0 - cov) * sat(1.0 - np.abs(q) / 0.36)
    dn = c.noise("dirt", 0.5, 0.03, H=0.6)
    dirt = chan_c * smoothstep(-0.7, 0.9, dn)
    fine = c.noise("dfine", 0.02, 0.004, H=0.2)
    h += dirt * (0.004 + 0.0018 * fine)
    mossf = c.noise("moss", 0.35, 0.015, H=0.45) + 0.9 * c.noise("mossarea", 2.0, 0.6)
    lap = cov * smoothstep(0.86, 1.0, e) + (1 - cov) * smoothstep(0.9, 1.0, e) * 0.6
    side = cov * smoothstep(0.86, 0.99, np.abs(q))
    moss = sat(chan_c * smoothstep(0.75, 1.25, mossf) + (lap + side * 0.6) * smoothstep(0.55, 1.2, mossf + 0.25))
    mb = np.abs(c.noise("mossb", 0.03, 0.005, H=0.3))
    h += moss * (0.0035 + 0.004 * mb)
    h = blur(h, 0.55)

    # --- albedo
    pal = [(176, 106, 76), (152, 88, 66), (188, 134, 102), (190, 156, 124), (120, 80, 64), (142, 114, 98), (164, 98, 70)]
    base, _ = palette_pick(c.rng("pal"), 2 * NT, pal, [6, 4.5, 2.2, 0.8, 1.8, 2.5, 4.5], jitter=0.045)
    base = lum(base)[:, None] + (base - lum(base)[:, None]) * 0.86
    base[NT:] *= 0.88                                      # channel tiles sit dirtier / darker
    col = base[tid]
    mott = c.noise("mott", 0.22, 0.02, H=0.6)
    fire = smoothstep(0.4, 1.9, c.noise("fire", 0.45, 0.05, H=0.8) + (tr[tid, 3] - 0.5) * 1.2)
    col = col * (1.0 + 0.06 * mott + 0.025 * stri + 0.02 * grain)[..., None]
    col = mix(col, col * np.array([0.80, 0.72, 0.70], F), fire * 0.55)
    ridge = cov * np.maximum(1.0 - q * q, 0.0) ** 2
    col = mix(col, col * 1.07 + 0.03, ridge * 0.4 * smoothstep(-1.0, 1.0, mott))
    # pale lime/efflorescence bloom on some tiles
    eff = smoothstep(0.6, 1.8, c.noise("eff", 0.3, 0.02, H=0.5) + (tr[tid, 4] - 0.6) * 2.0)
    col = mix(col, rgb(206, 188, 168), eff * 0.4)
    # grey-brown soiling crust (stronger towards each lower end and on old tiles)
    soil_f = c.noise("soil", 0.6, 0.008, H=0.4) + (tr[tid, 5] - 0.5) * 2.2 + (0.5 - sat(e)) * 0.8
    soil = smoothstep(0.1, 1.5, soil_f)
    col = mix(col, rgb(98, 88, 78), soil * 0.62)
    # lichen spots
    lp = jitter_points(int(T / 0.045), int(T / 0.045), 1.0, c.rng("lich"))
    Vl = c.voronoi(lp, k=2)
    lr = c.rng("lich2").random((len(lp), 3)).astype(F)
    larea = smoothstep(-0.2, 1.4, c.noise("licharea", 1.2, 0.25) + (tr[tid, 6] - 0.5) * 1.5)
    rad = (0.004 + 0.016 * lr[Vl.id, 0] ** 2) / T
    ln = c.noise("lichn", 0.012, 0.003, H=0.2) * (0.0018 / T)
    spot = smoothstep(rad, rad * 0.75, Vl.f1 + ln) * (lr[Vl.id, 1] < 0.45 * larea + 0.05)
    spot = spot * (0.55 + 0.45 * cov)
    isy = (lr[Vl.id, 2] < 0.16)
    lcol = np.where(isy[..., None], rgb(196, 160, 66), rgb(192, 192, 174))
    col = mix(col, lcol, spot * 0.8)
    h += spot * 0.0005
    # valley dirt, moss
    col = mix(col, rgb(62, 53, 44), dirt * (0.55 + 0.25 * sat(0.5 + 0.5 * fine)))
    mcol = ramp(sat(0.25 + 0.9 * mb + 0.12 * fine), [(0, (38, 46, 26)), (0.5, (64, 74, 40)), (1, (96, 100, 58))])
    col = mix(col, mcol, moss * 0.92)
    col = mix(col, rgb(52, 44, 38), crack * 0.8)
    # exposed lower edge faces a little darker, dirt against laps
    lowedge = smoothstep(0.022, 0.004, e) * cov
    col = mix(col, col * 0.80, lowedge * 0.6)
    cav = sat(-c.curv(h, 0.02) / 0.012)
    col = mix(col, col * np.array([0.62, 0.58, 0.55], F), cav * 0.5 * (1 - moss))

    rough = 0.82 + 0.05 * soil + 0.03 * grain - 0.04 * ridge
    rough = lerp(rough, 0.95, sat(spot + moss + dirt))
    return dict(h=h, col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.09, ao_gain=1.0))
