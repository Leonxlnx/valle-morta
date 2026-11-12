"""bark_conifer - spruce bark: thin scaly plates, grey-brown with reddish
under-bark where scales have flaked; tiles around the trunk in U."""
import numpy as np
from .core import *  # noqa: F401,F403


def build(c):
    n, T = c.n, c.tile
    wx = c.noise("wx", 0.25, 0.03, H=0.9) * (0.006 / T)
    wy = c.noise("wy", 0.25, 0.03, H=0.9) * (0.008 / T)
    pts = jitter_points(int(T / 0.026), int(T / 0.034), 1.0, c.rng("scales"), stagger=0.5)
    V = c.voronoi(pts, k=4, sy=0.8, wx=wx, wy=wy)
    sr = c.rng("scales2").random((len(pts), 6)).astype(F)
    e = V.edge * T
    gap = 0.0003 + 0.0008 * sr[V.id, 0]
    t = sat((e - gap) / 0.0022)
    plate = 1.0 - (1.0 - t) ** 2
    # each scale is a thin plate tilted so one edge lifts (peeling)
    tilt = (V.dx * (sr[V.id, 1] - 0.5) + V.dy * (sr[V.id, 2] - 0.2)) * T * 0.42
    flaked = (sr[V.id, 3] < 0.14).astype(F)
    lvl = (0.0024 + 0.0030 * sr[V.id, 4]) * (1.0 - 0.75 * flaked)
    rid = c.fbm("rid", 0.22, octaves=3, gain=0.5, mode="ridged")
    und = c.noise("und", 0.5, 0.08, H=1.0)
    fine = c.noise("fine", 0.012, None, H=0.1)
    fl = c.noise("fl", 0.03, 0.004, H=0.4)
    h = und * 0.004 + rid * 0.003 + plate * (lvl + tilt) + fl * 0.0005 + fine * 0.00022
    h -= (1.0 - plate) * 0.0013
    h = blur(h, 0.5)

    tone = sat(0.5 + 0.3 * (sr[V.id, 5] - 0.5) + 0.12 * fl + 0.08 * fine + 0.1 * und)
    col = ramp(tone, [(0, (88, 78, 70)), (0.5, (116, 106, 96)), (1, (146, 138, 128))])
    red = ramp(tone, [(0, (86, 56, 42)), (0.5, (122, 82, 60)), (1, (150, 106, 78))])
    col = mix(col, red, flaked * 0.85 * plate)
    # greyer, slightly bleached raised edges; dark fissures
    cv = c.curv(h, 0.004)
    col = mix(col, col * 1.12 + 0.02, sat(cv / 0.0008) * 0.4)
    col = mix(col, rgb(66, 56, 48), (1.0 - plate) * 0.3)
    lich = smoothstep(0.6, 1.7, c.noise("lich", 0.5, 0.01, H=0.45))
    col = mix(col, rgb(146, 152, 134), lich * 0.4 * plate)
    alg = smoothstep(0.5, 1.8, c.noise("alg", 1.0, 0.1, H=0.8))
    col = mix(col, rgb(96, 106, 72), alg * 0.3)
    resin = smoothstep(2.4, 3.0, c.noise("resin", 0.02, 0.005, H=0.0))
    col = mix(col, rgb(170, 150, 110), resin * 0.5)
    col = col * (1.0 + 0.04 * c.noise("val", 0.4, 0.03, H=0.6))[..., None]
    rough = 0.88 + 0.04 * fine + 0.05 * lich - 0.15 * resin
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.01, ao_gain=0.75))
