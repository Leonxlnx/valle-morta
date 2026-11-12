"""bark_deciduous - furrowed grey bark with interlacing vertical ridges,
cross cracks and lichen patches."""
import numpy as np
from .core import *  # noqa: F401,F403


def build(c):
    n, T = c.n, c.tile
    wx = c.noise("wx", 0.35, 0.04, H=0.9) * (0.010 / T)
    wy = c.noise("wy", 0.35, 0.04, H=0.9) * (0.012 / T)
    pts = jitter_points(int(T / 0.034), int(T / 0.15), 0.95, c.rng("ridges"), stagger=0.5)
    V = c.voronoi(pts, k=4, sx=3.6, sy=1.0, wx=wx, wy=wy)
    rr = c.rng("ridges2").random((len(pts), 5)).astype(F)
    e = V.edge * T / 3.6 * 1.6                                  # ~metres across the ridge
    furw = 0.0025 + 0.004 * rr[V.id, 0]
    t = sat((e - furw * 0.15) / (0.007 + 0.007 * rr[V.id, 1]))
    ridge = 1.0 - (1.0 - t) ** 1.8
    fib = c.noise("fib", 0.006, None, H=0.0, sy=18.0)
    fib2 = c.noise("fib2", 0.03, 0.004, H=0.5, sy=8.0)
    und = c.noise("und", 0.6, 0.1, H=1.0)
    # cross cracks on the ridge plates
    cc = np.sin((c.y * T / (0.022 + 0.0 * e) + c.noise("ccw", 0.08, 0.02, H=0.8) * 0.12 + rr[V.id, 2] * 7.0) * TAU)
    cross = smoothstep(0.86, 0.98, cc) * smoothstep(0.3, 1.0, ridge) * (rr[V.id, 3] < 0.7)
    h = (und * 0.004 + ridge * (0.009 + 0.006 * rr[V.id, 4]) + fib * 0.0002 * ridge + fib2 * 0.0007
         - cross * 0.0016 - (1 - ridge) * fib2 * 0.0006)
    h = blur(h, 0.5)

    tone = sat(0.35 + 0.45 * ridge + 0.12 * fib2 + 0.08 * fib + 0.15 * (rr[V.id, 2] - 0.5))
    col = ramp(tone, [(0, (48, 40, 34)), (0.3, (78, 68, 60)), (0.65, (112, 106, 98)), (1, (146, 142, 134))])
    col = mix(col, col * np.array([1.03, 0.97, 0.9], F), smoothstep(-0.5, 1.5, c.noise("warm", 0.5, 0.05)) * 0.6)
    col = mix(col, rgb(40, 33, 28), cross * 0.7)
    # lichen: pale grey-green crusts on the ridges + a few yellow rosettes
    la = smoothstep(0.1, 1.2, c.noise("la", 0.45, 0.06, H=0.8))
    ln = smoothstep(0.2, 0.7, c.noise("ln", 0.04, 0.004, H=0.3) + la * 1.3 - 0.9)
    lich = ln * smoothstep(0.35, 0.8, ridge)
    col = mix(col, rgb(158, 166, 142), lich * 0.75)
    lp = jitter_points(int(T / 0.05), int(T / 0.05), 1.0, c.rng("ylich"))
    Vl = c.voronoi(lp, k=2)
    lq = c.rng("ylich2").random((len(lp), 2)).astype(F)
    rad = (0.004 + 0.012 * lq[Vl.id, 0]) / T
    yl = smoothstep(rad, rad * 0.6, Vl.f1 + c.noise("yln", 0.015, 0.004) * (0.002 / T)) * (lq[Vl.id, 1] < 0.12)
    col = mix(col, rgb(180, 160, 70), yl * 0.75 * smoothstep(0.2, 0.7, ridge))
    moss = (1 - ridge) * smoothstep(0.7, 1.6, c.noise("moss", 0.6, 0.05, H=0.7))
    col = mix(col, rgb(70, 84, 42), moss * 0.6)
    h = h + lich * 0.0004 + yl * 0.0005
    rough = 0.9 + 0.04 * fib + 0.04 * lich
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.015, ao_gain=1.0))
