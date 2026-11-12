"""plaster_damaged - the old plaster after shelling: bullet pocks with spall
rings, shrapnel gouges, big patches flaked off down to the scored base coat
and to the rubble masonry core (the very same stone_masonry texture), soot."""
import numpy as np
from .core import *  # noqa: F401,F403
from .registry import MATERIALS
from . import mat_stone_masonry, mat_plaster_old


def build(c):
    n, T = c.n, c.tile
    k = n / 2048.0
    r = c.rng("dmg")
    # ---- bullet impacts (a couple of bursts + strays)
    bx, by = [], []
    for _ in range(5):
        x0, y0, a = r.random(), r.random(), r.uniform(-0.5, 0.5)
        m = r.integers(4, 8)
        tt = np.cumsum(r.uniform(0.03, 0.09, m))
        bx += list(x0 + tt * np.cos(a) + r.normal(0, 0.012, m))
        by += list(y0 + tt * np.sin(a) + r.normal(0, 0.02, m))
    ns = 30
    bx = np.array(bx + list(r.random(ns))) % 1.0
    by = np.array(by + list(r.random(ns))) % 1.0
    NB = len(bx)
    brad = r.uniform(0.022, 0.052, NB) * (1 + (r.random(NB) < 0.12) * 0.6)
    crat = np.zeros((n, n), F)
    fn = blob_fn(r.random(NB) * TAU, r.uniform(1.0, 1.35, NB), np.ones(NB), r.uniform(0.05, 0.2, (NB, 5)),
                 r.random((NB, 5)) * TAU, p=1.0, q=1.0, size=0.9)
    stamp(crat, bx, by, brad / T * 1.15, fn)
    # ---- shrapnel gouges
    NG = 11
    gx, gy = r.random(NG), r.random(NG)
    gouge = np.zeros((n, n), F)
    gfn = blob_fn(r.random(NG) * TAU, r.uniform(2.4, 5.0, NG), np.ones(NG), r.uniform(0.08, 0.22, (NG, 5)),
                  r.random((NG, 5)) * TAU, p=1.0, q=1.0, size=0.9)
    stamp(gouge, gx, gy, r.uniform(0.05, 0.13, NG) / T, gfn)
    chunk = c.noise("chunk", 0.03, 0.004, H=0.3)
    crat_c = sat(crat + chunk * 0.10 * (crat > 0))
    gouge_c = sat(gouge + chunk * 0.16 * (gouge > 0))

    starts = np.stack([bx, by], 1)
    P = mat_plaster_old.plaster(c, dirty=0.55, crack_starts=starts, chip_cov=0.014)
    mt, mres, mseed = MATERIALS["stone_masonry"]
    M = mat_stone_masonry.layers(Ctx("stone_masonry", n, mt, mseed))

    # ---- where the plaster has fallen off
    infl = blur(np.maximum(crat, gouge * 0.8), 0.05 * c.ppm)
    infl = infl / (infl.max() + 1e-6)
    fpts = jitter_points(int(T / 0.06), int(T / 0.06), 1.0, c.rng("lfacet"))
    Vf = c.voronoi(fpts, k=2)
    fcell = c.rng("lfacet2").normal(0, 1, len(fpts)).astype(F)[Vf.id]
    f = (c.noise("loss", 2.4, 0.07, H=1.1) + 0.045 * c.noise("loss2", 0.06, 0.008, H=0.5) + 0.10 * fcell
         + 1.1 * infl + 0.4 * sat(blur(P["crack"], 10.0 * k) * 5.0))
    t0 = thresh_for_coverage(f, 0.23)
    hole = smoothstep(0.0, 0.035, f - t0)                               # masonry exposed
    f2 = f + 0.26 + 0.30 * c.noise("band", 0.6, 0.06, H=1.0) + 0.08 * fcell
    fin_lost = np.maximum(smoothstep(0.0, 0.035, f2 - t0), hole)        # finish coat lost
    fin_lost = np.maximum(fin_lost, smoothstep(0.25, 0.4, gouge_c))

    und = P["und"]
    # scored, sandy base coat
    sc_n = c.noise("scn", 0.05, 0.004, H=0.3)
    score = np.sin((c.y * T / 0.028 + c.noise("scw", 0.5, 0.08) * 0.35) * TAU)
    score = smoothstep(0.55, 0.95, score) * smoothstep(-0.5, 0.8, c.noise("scm", 0.4, 0.05))
    scratch_h = -0.007 + und * 0.0016 + sc_n * 0.0011 - score * 0.0016
    mas_h = M["h"] - 0.034
    # old plaster still packs the joints of the exposed core in places
    pack = smoothstep(-0.2, 1.2, c.noise("pack", 0.5, 0.04, H=0.6))
    pack_h = -0.030 + c.noise("packn", 0.04, 0.004, H=0.4) * 0.0025
    packed = (pack_h > mas_h) * pack
    mas_h = lerp(mas_h, np.maximum(mas_h, pack_h), pack)

    h = lerp(P["h"], scratch_h, fin_lost)
    h = lerp(h, mas_h, hole)
    spall = smoothstep(0.0, 0.10, crat_c)
    pit = smoothstep(0.42, 0.9, crat_c)
    onplaster = 1.0 - hole * 0.6
    h -= (0.004 * spall + 0.005 * smoothstep(0.0, 0.5, crat_c) + 0.016 * pit) * onplaster
    gd = smoothstep(0.0, 0.5, gouge_c)
    h -= (0.004 * gd + 0.008 * smoothstep(0.5, 1.0, gouge_c)) * onplaster

    # ---- albedo
    col = P["col"]
    sub = ramp(sat(0.5 + 0.2 * sc_n + 0.12 * c.noise("subg", 0.01, None, H=-0.3)),
               [(0, (126, 114, 96)), (0.5, (170, 158, 138)), (1, (198, 188, 168))])
    sub = mix(sub, sub * 0.8, score * 0.6)
    col = mix(col, sub, fin_lost)
    mcol = M["col"]
    dust = smoothstep(-0.8, 1.6, c.noise("dust", 0.3, 0.02, H=0.5))
    mcol = mix(mcol, rgb(204, 196, 180), dust * 0.28)
    mcol = mix(mcol, sub * 1.04, packed * 0.85)
    col = mix(col, mcol, hole)
    # fresh fracture rim of the broken plaster edges
    edge = sat(blur(fin_lost, 1.5 * k) * (1 - fin_lost) * 4.0)
    col = mix(col, rgb(232, 229, 220), edge * 0.55)
    # craters: bright fresh spall dish, dark pit
    ring = sat(1.0 - np.abs(crat_c - 0.12) / 0.12) * (crat_c > 0)
    col = mix(col, sub * 1.06, spall * (1 - pit) * onplaster * 0.92)
    col = mix(col, rgb(231, 227, 216), ring * onplaster * (1 - fin_lost) * 0.75)
    col = mix(col, rgb(84, 76, 66), pit * 0.85)
    col = mix(col, sub * 1.05, gd * (1 - hole) * 0.8)
    # soot smears (rising)
    sx_, sy_ = r.random(2), r.random(2)
    s0 = np.zeros((n, n), F)
    for i in range(2):
        rr = np.hypot(wrapd(c.x - sx_[i]) / (0.15 - 0.06 * i), wrapd(c.y - sy_[i]) / (0.12 - 0.05 * i))
        s0 = np.maximum(s0, np.exp(-rr * rr))
    sn = c.noise("sootn", 0.6, 0.02, H=0.8)
    core_ = smoothstep(0.08, 0.95, s0 + 0.22 * sn * sat(s0 * 3))
    up = streak_down((s0 * (0.6 + 0.4 * sat(0.5 + 0.5 * sn)))[::-1], 0.40 * c.ppm)[::-1]
    up = blur(up, 6.0 * k)
    soot = sat(core_ * 0.72 + sat(up * 2.0) * 0.45)
    soot = soot * (0.8 + 0.2 * sat(0.5 + 0.5 * c.noise("sootf", 0.08, 0.008, H=0.3, sy=4.0)))
    soot = soot * (1 - 0.6 * spall)                                     # impacts knock the soot off
    col = mix(col, rgb(52, 48, 45), sat(soot * 1.1) * 0.72)

    rough = lerp(P["rough"], 0.96, fin_lost)
    rough = lerp(rough, M["rough"], hole)
    rough = lerp(rough, 0.97, sat(soot))
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F),
                opts=dict(nstrength=1.2, ao_radius=0.05, ao_gain=1.0))
