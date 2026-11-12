"""moss - deep green cushion moss, fine fuzzy shoots with yellow-green tips."""
import numpy as np
from .core import *  # noqa: F401,F403


def build(c):
    n, T = c.n, c.tile
    cush = c.fbm("cush", 0.34, octaves=3, gain=0.5, mode="billow")
    cush2 = c.fbm("cush2", 0.09, octaves=2, gain=0.5, mode="billow")
    und = c.noise("und", 1.6, 0.25, H=1.0)
    g = int(T / 0.0075)
    pts = jitter_points(g, g, 1.0, c.rng("shoots"))
    V = c.voronoi(pts, k=2)
    rr = c.rng("shoots2").random((len(pts), 3)).astype(F)
    shoot = (1.0 - sat(V.f1 / (0.0052 / T))) ** 1.4
    star = 0.75 + 0.25 * np.cos(np.arctan2(V.dy, V.dx) * 5.0 + rr[V.id, 2] * TAU) * sat(V.f1 / (0.003 / T))
    shoot = shoot * star
    fuzz = c.noise("fuzz", 0.007, None, H=-0.5)
    fine = c.noise("fine", 0.03, 0.005, H=0.3)
    h = und * 0.014 + cush * 0.022 + cush2 * 0.006 + shoot * (0.0035 + 0.003 * rr[V.id, 0]) + fuzz * 0.0006 + fine * 0.001
    dead = smoothstep(1.0, 2.0, c.noise("dead", 0.7, 0.05, H=0.7))
    hi = sat(0.5 + 0.5 * cush + 0.25 * cush2)
    t = sat(0.08 + 0.52 * shoot + 0.22 * hi + 0.16 * rr[V.id, 1] + 0.05 * fuzz + 0.08 * c.noise("tone", 0.6, 0.06))
    col = ramp(t, [(0, (22, 33, 13)), (0.35, (46, 68, 24)), (0.65, (78, 100, 34)), (0.85, (112, 126, 46)), (1, (146, 150, 66))])
    col = mix(col, ramp(t, [(0, (48, 38, 22)), (0.5, (98, 84, 46)), (1, (146, 128, 72))]), dead * 0.7)
    # tiny sporophyte stalks / litter
    r = c.rng("litter")
    NL = 2600
    x, y, a = r.random(NL), r.random(NL), r.random(NL) * TAU
    L = r.uniform(0.006, 0.02, NL) / T
    R = Raster(n, 2)
    R.lines(x, y, x + np.cos(a) * L, y + np.sin(a) * L, 0.0009 / T, np.arange(1, NL + 1))
    lc = np.concatenate([np.zeros((1, 3), F), ramp(r.random(NL), [(0, (96, 58, 34)), (1, (168, 128, 78))])])
    lm = np.ones(NL + 1, F)
    lm[0] = 0
    idm = R.ids()
    cov = R.resolve(lm, idm)
    lcol = R.resolve(lc, idm)
    col = col * (1 - cov)[..., None] + lcol
    h = h + cov * 0.0012
    rough = 0.95 - 0.04 * shoot + 0.02 * fuzz
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.03, ao_gain=1.0))
