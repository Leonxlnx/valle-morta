"""concrete_old - weathered grey board-formed concrete: formwork lines and
grain imprint, bug holes, exposed-aggregate patches, cracks, stains, tie holes."""
import numpy as np
from .core import *  # noqa: F401,F403


def build(c):
    n, T = c.n, c.tile
    k = n / 1024.0
    r = c.rng("conc")
    NB = 13                                       # form boards ~15.4 cm
    Yb = c.y * NB + c.noise("bw", 1.5, 0.3) * 0.02
    bi = np.floor(Yb).astype(np.int32) % NB
    fb = (Yb - np.floor(Yb)).astype(F)
    br = r.random((NB, 5)).astype(F)
    edge = np.minimum(fb, 1.0 - fb) * (T / NB)
    fin = smoothstep(0.004, 0.0008, edge) * (0.4 + 0.6 * smoothstep(-0.5, 0.8, c.noise("finm", 0.5, 0.06, sx=3.0)))
    grainimp = c.noise("gimp", 0.012, 0.002, H=0.3, sx=25.0)
    und = c.noise("und", 1.2, 0.15, H=1.0)
    mid = c.noise("mid", 0.08, 0.01, H=0.6)
    grain = c.noise("grain", 0.005, None, H=-0.3)
    h = (br[bi, 0] - 0.5) * 0.0022 + (fb - 0.5) * (br[bi, 1] - 0.5) * 0.0016 + fin * 0.0009 \
        + grainimp * 0.00016 + und * 0.0012 + mid * 0.0003 + grain * 0.00012
    # bug holes (air voids)
    bp = jitter_points(int(T / 0.018), int(T / 0.018), 1.0, c.rng("bug"))
    Vb = c.voronoi(bp, k=2)
    bq = c.rng("bug2").random((len(bp), 2)).astype(F)
    barea = smoothstep(-0.5, 1.2, c.noise("barea", 0.8, 0.1))
    brad = (0.0008 + 0.0042 * bq[Vb.id, 0] ** 2.5) / T
    bug = smoothstep(brad, brad * 0.55, Vb.f1) * (bq[Vb.id, 1] < 0.25 + 0.4 * barea)
    h -= bug * (0.0012 + 0.003 * bq[Vb.id, 0])
    # exposed aggregate where the paste has weathered away
    af = c.noise("agg", 0.9, 0.02, H=0.8) + 0.1 * c.noise("agg2", 0.03, 0.006, H=0.3)
    expo = smoothstep(0.0, 0.25, af - thresh_for_coverage(af, 0.16))
    ap = jitter_points(int(T / 0.017), int(T / 0.017), 1.0, c.rng("aggp"))
    Va = c.voronoi(ap, k=2)
    aq = c.rng("aggp2").random((len(ap), 3)).astype(F)
    arad = (0.0035 + 0.0055 * aq[Va.id, 0]) / T
    peb = np.sqrt(sat(1.0 - (Va.f1 / arad) ** 2)) * (aq[Va.id, 1] < 0.8)
    h = h - expo * 0.0022 + expo * peb * (0.0018 + 0.0015 * aq[Va.id, 0]) + expo * mid * 0.0005
    # hairline cracks
    crk = crack_map(n, c.rng("crk"), 7, length=(0.15, 0.6), step=0.004, wander=0.35, kink=0.06, branch=0.08,
                    width=(0.8 * k, 1.8 * k))
    h -= crk * 0.0018
    # formwork tie holes on a regular grid
    tie = np.zeros((n, n), F)
    tpos = []
    for ty in (0.25, 0.75):
        for tx in (0.125, 0.375, 0.625, 0.875):
            dd = np.hypot(wrapd(c.x - tx), wrapd(c.y - ty)) * T
            tie = np.maximum(tie, smoothstep(0.012, 0.009, dd))
            tpos.append((tx, ty))
    h -= tie * 0.007
    h = blur(h, 0.5)

    col = np.empty((n, n, 3), F)
    col[:] = rgb(150, 148, 142)
    col = col * (1.0 + 0.07 * (br[bi, 2] - 0.5) + 0.035 * c.noise("mott", 0.5, 0.02, H=0.5) + 0.02 * grainimp
                 + 0.02 * grain)[..., None]
    col = mix(col, col * np.array([1.04, 1.0, 0.94], F), smoothstep(-0.5, 1.5, c.noise("warm", 1.0, 0.1)) * 0.6)
    pour = smoothstep(0.035, 0.0, np.abs(wrapd(c.y - 0.46 + c.noise("pourw", 0.8, 0.1) * 0.006)) * T)
    col = mix(col, col * 0.86, pour * 0.6)                                # cold joint band
    # aggregate colours
    acol = np.where((aq[Va.id, 2] < 0.3)[..., None], rgb(120, 112, 100),
                    np.where((aq[Va.id, 2] < 0.65)[..., None], rgb(176, 172, 162), rgb(140, 132, 118)))
    matrix = col * np.array([0.84, 0.83, 0.80], F)
    col = mix(col, np.where((peb > 0.05)[..., None], acol, matrix), expo)
    # stains: dark rain streaks, rust from ties, pale efflorescence, algae
    src = smoothstep(1.6, 2.3, c.noise("ssrc", 0.4, 0.02, H=0.3, sx=2.0)) + fin * 0.25
    stk = streak_down(src, 0.35 * c.ppm)
    stk = sat(stk / (np.percentile(stk[::4, ::4], 99.5) + 1e-6))
    fibv = 0.5 + 0.5 * sat(0.5 + 0.5 * c.noise("fib", 0.05, 0.006, H=0.3, sy=12.0))
    col = mix(col, rgb(82, 80, 76), stk * fibv * 0.5)
    rrun = sat(blur(streak_down(tie, 0.16 * c.ppm), 2.0 * k) * 2.5) * fibv
    col = mix(col, rgb(134, 92, 60), rrun * 0.5)
    eff = smoothstep(1.7, 2.4, c.noise("eff", 0.3, 0.02, H=0.4))
    es = streak_down(eff, 0.2 * c.ppm)
    es = sat(es / (np.percentile(es[::4, ::4], 99.7) + 1e-6))
    col = mix(col, rgb(196, 196, 190), sat(es + crk * 0.5) * 0.4)
    alg = smoothstep(0.8, 1.9, c.noise("alg", 1.0, 0.04, H=0.6))
    col = mix(col, rgb(108, 116, 90), alg * 0.3)
    col = mix(col, col * 0.6, bug * 0.8)
    col = mix(col, rgb(60, 58, 56), sat(crk * 1.2) * 0.8)
    col = mix(col, rgb(48, 42, 38), tie * 0.85)
    rough = 0.88 + 0.03 * grain + 0.05 * expo - 0.05 * stk
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F),
                opts=dict(nstrength=1.5, ao_radius=0.01, ao_gain=1.0))
