"""stone_masonry - irregular rubble-stone wall with recessed crumbling lime mortar."""
import numpy as np
from .core import *  # noqa: F401,F403


def layers(c):
    """Returns dict with h (m), col, rough and the mortar mask. Also reused by
    plaster_damaged as the wall core that shows through fallen plaster."""
    n, T = c.n, c.tile
    r = c.rng("layout")
    # --- stone layout: staggered jittered rows, thinned + extra small stones
    pts = jitter_points(11, 18, 0.9, r, stagger=0.5)
    pts = pts[r.random(len(pts)) > 0.12]
    for k in r.choice(len(pts), 12, replace=False):          # a few big stones: clear their neighbourhood
        dd = np.hypot(wrapd(pts[:, 0] - pts[k, 0]), wrapd(pts[:, 1] - pts[k, 1]) * 1.5)
        keep = (dd > 0.062) | (dd == 0)
        pts = pts[keep] if keep.sum() > 100 else pts
        if k >= len(pts):
            break
    ex = pts[r.choice(len(pts), 34, replace=False)] + r.normal(0, 0.022, (34, 2))
    pts = np.concatenate([pts, ex % 1.0])
    pts = relax(pts, 1, sy=1.5)
    N = len(pts)
    wl = c.noise("warpx", 0.45, 0.05, H=0.9)
    wx = wl * (0.016 / T)
    wy = c.noise("warpy", 0.45, 0.05, H=0.9) * (0.013 / T)
    V = c.voronoi(pts, k=4, sx=1.0, sy=1.5, wx=wx, wy=wy)
    cid = V.id
    cr = r.random((N, 8)).astype(F)

    gap = (0.011 + 0.010 * cr[cid, 0] ** 2 + 0.003 * c.noise("gapn", 0.3, 0.03, H=0.6)) / T
    mask = (V.edge > gap).astype(F)
    mask = c.blur(mask, 0.014) > 0.5                       # round the corners
    maxd = 0.07 * c.ppm
    d = inner_distance(mask, maxd)
    d = blur(d, 1.0) * c.px                                # metres inside the stone

    # sparse conchoidal chips (angular facets knocked off the faces / arrises)
    fpts = jitter_points(int(T / 0.05), int(T / 0.05), 1.0, c.rng("facet"))
    Vf = c.voronoi(fpts, k=2)
    fr = c.rng("facet2").normal(0, 1, (len(fpts), 3)).astype(F)
    chipsel = sat((fr[Vf.id, 2] - 0.9) * 4.0)
    slope = sat(0.5 + (Vf.dx * fr[Vf.id, 0] + Vf.dy * fr[Vf.id, 1]) * T / 0.05)
    chip = blur(chipsel * (0.35 + 0.65 * slope), 0.9)
    n_mid = c.noise("mid", 0.10, 0.012, H=0.8)
    n_fine = c.noise("fine", 0.02, None, H=0.3)
    edge_near = sat(1.0 - d / 0.035)
    d2 = d + n_mid * 0.0018 - chip * edge_near * 0.012

    bevel = (0.006 + 0.016 * cr[cid, 1])
    t = sat(d2 / bevel)
    prof = 1.0 - (1.0 - t) ** 2.0
    rough_k = 0.4 + 1.2 * cr[cid, 2]
    face = ((cr[cid, 3] - 0.5) * 0.016
            + (V.dx * (cr[cid, 4] - 0.5) + V.dy * (cr[cid, 5] - 0.5)) * T * 0.10
            + c.noise("bulge", 0.25, 0.06, H=1.0) * 0.0022
            + rough_k * (n_mid * 0.0011 - chip * 0.0045 + c.noise("split", 0.03, 0.004, H=0.4) * 0.0011)
            + n_fine * 0.0006 + c.noise("crisp", 0.012, 0.003, H=0.2) * 0.0004 * rough_k)
    # pits
    pit = c.noise("pit", 0.012, 0.004, H=0.0)
    pitm = smoothstep(1.9, 3.0, pit) * smoothstep(0.2, 1.2, c.noise("pitarea", 0.4, 0.06))
    face -= pitm * 0.003
    stone_h = face - (1.0 - prof) * 0.06

    # --- mortar
    holes = smoothstep(0.7, 1.7, c.noise("holes", 0.7, 0.07, H=0.8))
    flush = smoothstep(0.6, 1.6, c.noise("flush", 0.9, 0.10, H=0.8))
    m_n = c.noise("mortar_n", 0.06, 0.006, H=0.6)
    grain = c.noise("mgrain", 0.008, None, H=-0.5)
    mortar_h = (-0.017 + 0.008 * flush - 0.022 * holes + m_n * (0.0026 + 0.003 * holes)
                + grain * 0.0011)
    # mortar rises slightly against the stones (meniscus) where not crumbled
    mortar_h += 0.004 * (1 - holes) * sat(1.0 - d / 0.004) * mask
    h = np.maximum(stone_h, mortar_h)
    is_mortar = smoothstep(-0.0006, 0.0012, mortar_h - stone_h)

    # --- albedo
    pal = [(166, 159, 145), (178, 168, 150), (190, 182, 163), (154, 150, 140),
           (134, 127, 114), (172, 156, 131), (160, 150, 134)]
    base, _ = palette_pick(c.rng("pal"), N, pal, [5, 5, 3, 3, 1.5, 1.2, 3], jitter=0.03)
    base = lum(base)[:, None] + (base - lum(base)[:, None]) * 0.9
    col = base[cid]
    mott = c.noise("mott", 0.25, 0.015, H=0.5)
    # per-stone bedding streaks (three orientation classes)
    s1 = c.noise("strk1", 0.05, 0.006, H=0.4, sx=4.0)
    s2 = c.noise("strk2", 0.05, 0.006, H=0.4, sy=4.0)
    ori = cr[cid, 6]
    strk = np.where(ori < 0.35, s1, np.where(ori < 0.5, s2, 0.0)) * (0.3 + cr[cid, 7])
    val = 1.0 + 0.05 * mott + 0.016 * strk + 0.035 * n_fine + 0.03 * c.noise("cspeck", 0.01, 0.003, H=0.0)
    col = col * val[..., None]
    # warm / cool drift inside stones
    drift = c.noise("drift", 0.5, 0.05, H=0.8)
    col = col * (1.0 + np.array([0.008, 0.0, -0.012], F) * drift[..., None])
    # grey weathering patina on exposed faces vs fresh chips
    pat = smoothstep(-0.3, 1.2, c.noise("patina", 0.6, 0.02, H=0.4))
    col = mix(col, col * np.array([0.80, 0.79, 0.77], F), pat * 0.45)
    cv = c.curv(h, 0.006)
    edge_wear = sat(cv / 0.0022) * (1 - is_mortar)
    col = mix(col, col * 1.10 + 0.02, edge_wear * 0.5)
    col = mix(col, col * 1.13 + 0.015, sat(chip * 1.5) * 0.6)      # fresher stone in chips
    # mortar colour
    mcol = ramp(sat(0.5 + 0.22 * m_n + 0.16 * grain), [(0.0, (160, 148, 126)), (0.45, (203, 194, 172)),
                                                        (0.8, (216, 208, 188)), (1.0, (228, 222, 206))])
    agg = smoothstep(1.7, 2.3, c.noise("agg", 0.01, 0.004, H=-0.5))        # dark sand grains
    mcol = mix(mcol, rgb(120, 112, 100), agg * 0.7)
    mcol = mix(mcol, rgb(118, 106, 90), holes * 0.75)
    col = mix(col, mcol, is_mortar)
    # thin mortar smear / lime wash remnants on stone faces next to joints
    smear = sat(1.0 - d / 0.02) * smoothstep(0.2, 1.4, c.noise("smear", 0.2, 0.02, H=0.5)) * (1 - is_mortar)
    col = mix(col, rgb(204, 196, 178), smear * 0.55)
    # dirt in cavities
    cav = sat(-c.curv(h, 0.02) / 0.012)
    deep = sat((-0.026 - h) / 0.02)
    dirt = sat(cav * 0.8 + deep) * (0.6 + 0.4 * smoothstep(-1, 1, c.noise("dirtn", 0.5, 0.03, H=0.5)))
    col = mix(col, col * np.array([0.52, 0.49, 0.45], F), dirt * 0.75)
    # grime band on the stone arrises where they meet the mortar
    rim = sat(1.0 - np.abs(d - 0.006) / 0.008) * (1 - is_mortar) * (0.5 + 0.5 * sat(0.5 + 0.5 * mott))
    col = mix(col, col * np.array([0.72, 0.70, 0.66], F), rim * 0.55)
    # damp algae / moss film in some deep joints
    alg = deep * smoothstep(0.6, 1.8, c.noise("alg", 0.9, 0.08))
    col = mix(col, rgb(104, 102, 80), alg * 0.3)
    # lichen: pale crusts + ochre specks on stone faces
    ln = c.noise("lich", 0.10, 0.008, H=0.2)
    larea = smoothstep(0.5, 1.6, c.noise("licharea", 1.2, 0.2))
    lich = smoothstep(1.0, 1.25, ln + larea * 0.9 - 0.4) * (1 - is_mortar) * sat(prof * 2 - 0.6)
    col = mix(col, rgb(198, 197, 186), lich * 0.45)
    ln2 = c.noise("lich2", 0.035, 0.006, H=0.0)
    lich2 = smoothstep(1.9, 2.2, ln2 + smoothstep(0.8, 1.8, c.noise("lich2a", 0.8, 0.15)) * 1.0) * (1 - is_mortar)
    col = mix(col, rgb(186, 152, 62), lich2 * 0.8)
    # faint downward water staining
    st = c.noise("stain", 0.35, 0.03, H=0.6, sy=6.0)
    col = col * (1.0 - 0.07 * smoothstep(0.3, 2.0, st))[..., None]

    rough = 0.84 + 0.05 * pat - 0.06 * edge_wear + 0.03 * n_fine
    rough = lerp(rough, 0.95, is_mortar)
    rough = lerp(rough, 0.93, np.maximum(lich, lich2))
    h = blur(h + lich * 0.0006, 0.5)          # tame per-pixel sparkle in the normal map
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), mortar=is_mortar, stone_d=d)


def build(c):
    L = layers(c)
    return dict(h=L["h"], col=L["col"], rough=L["rough"], opts=dict(ao_radius=0.05, ao_gain=1.0))
