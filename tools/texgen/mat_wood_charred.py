"""wood_charred - burnt timber (grain along U): alligator char blocks, near
black with grey ash in the cracks and on edges, slight sheen on char faces."""
import numpy as np
from .core import *  # noqa: F401,F403


def build(c):
    n, T = c.n, c.tile
    k = n / 1024.0
    wxn = c.noise("wx", 0.5, 0.06, H=0.9) * (0.007 / T)
    wyn = c.noise("wy", 0.5, 0.06, H=0.9) * (0.005 / T)
    # char blocks: boxy cells elongated along the grain
    pts = jitter_points(int(T / 0.055), int(T / 0.034), 0.85, c.rng("char"), stagger=0.5)
    V = c.voronoi(pts, k=2, p=4.0, sy=1.0, wx=wxn, wy=wyn)
    cr = c.rng("char2").random((len(pts), 5)).astype(F)
    # deep primary fissures: coarser cells
    pts2 = jitter_points(int(T / 0.22), int(T / 0.10), 0.9, c.rng("fiss"), stagger=0.5)
    V2 = c.voronoi(pts2, k=2, p=4.0, wx=wxn * 2.0, wy=wyn * 2.0)
    e = V.edge * T
    e2 = V2.edge * T
    gapv = 0.0016 + 0.0022 * cr[V.id, 0]
    t = sat((e - gapv) / (0.006 + 0.006 * cr[V.id, 1]))
    pil = 1.0 - (1.0 - t) ** 2.2
    fiss = smoothstep(0.0045, 0.0012, e2 + c.noise("fn", 0.05, 0.01) * 0.001)
    fib = c.noise("fib", 0.005, None, H=0.0, sx=22.0)
    fib2 = c.noise("fib2", 0.02, 0.004, H=0.4, sx=10.0)
    und = c.noise("und", 0.9, 0.15, H=1.0)
    bh = 0.006 + 0.008 * cr[V.id, 2]
    h = (und * 0.004 + pil * bh + (V.dx * (cr[V.id, 3] - 0.5) + V.dy * (cr[V.id, 4] - 0.5)) * T * 0.18 * pil
         + fib * 0.00018 * pil + fib2 * 0.0004 * pil - fiss * 0.010)
    # some blocks have flaked away
    gone = (cr[V.id, 2] < 0.07) * pil
    h -= gone * bh * 0.8
    h = blur(h, 0.55)

    crack = 1.0 - pil
    ash_a = smoothstep(-0.2, 1.3, c.noise("asha", 0.7, 0.06, H=0.7))
    ash = sat(crack * (0.35 + 0.65 * ash_a) + fiss * 0.6 * ash_a)
    top_ash = smoothstep(1.0, 2.0, c.noise("topash", 0.25, 0.01, H=0.4) + ash_a * 0.8) * pil
    col = ramp(sat(0.35 + 0.25 * fib2 + 0.2 * fib + 0.3 * (cr[V.id, 1] - 0.5)),
               [(0, (27, 26, 26)), (0.5, (38, 37, 37)), (1, (58, 57, 58))])
    blue = smoothstep(0.2, 1.5, c.noise("blue", 0.4, 0.03, H=0.6)) * pil
    col = mix(col, rgb(62, 66, 72), blue * 0.35)                                   # graphite sheen areas
    brown = smoothstep(1.3, 2.2, c.noise("brown", 0.8, 0.05, H=0.8))
    col = mix(col, rgb(84, 62, 46), brown * 0.6)                                   # scorched, not fully charred
    col = mix(col, rgb(26, 25, 25), sat(crack * 0.7 + fiss))
    acol = ramp(sat(0.5 + 0.3 * c.noise("ashn", 0.02, 0.003, H=0.2)), [(0, (104, 100, 96)), (0.5, (146, 143, 138)), (1, (186, 184, 178))])
    col = mix(col, acol, sat(ash * 0.5 + top_ash * 0.22))
    col = mix(col, rgb(40, 36, 34), gone * 0.5)
    rough = 0.42 + 0.10 * cr[V.id, 0] + 0.06 * fib - 0.08 * blue
    rough = lerp(rough, 0.9, sat(crack * 0.8 + fiss))
    rough = lerp(rough, 0.96, sat(ash * 0.7 + top_ash * 0.4))
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.02, ao_gain=1.0))
