"""wood_planks - weathered vertical boards, EXACTLY 12 across U: silver-grey
to brown, growth-ring grain with cathedrals, knots, checks and splits, nail
heads with rust runs, dark gaps between boards."""
import numpy as np
from .core import *  # noqa: F401,F403

NBD = 12


def build(c):
    n, T = c.n, c.tile
    k = n / 2048.0
    r = c.rng("planks")
    bw = T / NBD
    X = c.x * NBD
    bi = np.floor(X).astype(np.int32) % NBD
    a = (X - np.floor(X)).astype(F)
    ym = c.y * T
    br = r.random((NBD, 12)).astype(F)
    gw = c.noise("gw", 0.7, 0.06, H=0.9, sy=5.0) * 0.004
    gd = c.noise("gd", 1.6, 0.3, H=1.0, sy=3.0) * 0.010
    ringn = c.noise("ringn", 0.04, 0.008, H=0.5, sy=8.0)
    rho = np.zeros((n, n), F)
    knot = np.zeros((n, n), F)
    kr = c.rng("knots")
    cw = n // NBD
    for b in range(NBD):
        sl = np.s_[:, b * cw:(b + 1) * cw]
        xa = (a[sl] - 0.5) * bw + gw[sl] + (br[b, 1] - 0.5) * 0.06
        depth = 0.006 + 0.06 * br[b, 2] ** 1.5 + (0.008 + 0.03 * br[b, 3]) * np.sin(TAU * (c.y[sl] + br[b, 4])) + gd[sl]
        ringw = 0.0022 + 0.0026 * br[b, 5]
        rb = np.sqrt(xa * xa + depth * depth) / ringw
        kb = np.zeros_like(rb)
        for _ in range(kr.integers(0, 4)):
            ak, yk, rk = kr.uniform(0.18, 0.82), kr.random(), kr.uniform(0.006, 0.017)
            dx = (a[sl] - ak) * bw
            dy = wrapd(c.y[sl] - yk) * T
            q = (dx / (2.4 * rk)) ** 2 + (dy / (4.5 * rk)) ** 2
            rb = rb + kr.uniform(3.0, 6.0) * np.exp(-q) * np.sign(dx + 1e-6) * np.sign(xa + 1e-6)
            dk = np.hypot(dx, dy * 0.85)
            inner = smoothstep(rk * 1.1, rk * 0.8, dk)
            rb = lerp(rb, dk / (ringw * 0.45) + 7.0, inner)
            kb = np.maximum(kb, inner)
        rho[sl] = rb
        knot[sl] = kb
    ph = rho + 0.18 * ringn
    fr = ph - np.floor(ph)
    lw = smoothstep(0.35, 0.9, fr) * smoothstep(1.0, 0.93, fr)

    edge = np.minimum(a, 1.0 - a) * bw
    gapw = 0.0012 + 0.0022 * np.maximum(br[bi, 6], br[(bi + (a > 0.5) * 2 - 1) % NBD, 6]) \
        + 0.0005 * c.noise("gapn", 0.5, 0.06, sy=4.0)
    d = edge - gapw
    board = smoothstep(-0.0004, 0.0006, d)
    wth = sat(0.25 + 0.75 * br[bi, 7] + 0.28 * c.noise("wth", 1.3, 0.08, H=0.8, sy=2.5))
    fib = c.noise("fib", 0.004, None, H=0.0, sy=30.0)
    fib2 = c.noise("fib2", 0.02, 0.003, H=0.4, sy=18.0)
    chk = smoothstep(1.7, 2.4, c.noise("chk", 0.012, 0.0025, H=0.3, sy=45.0) + 0.6 * c.noise("chka", 0.6, 0.1))
    split = crack_map(n, c.rng("split"), 18, length=(0.08, 0.45), step=0.004, wander=0.10, kink=0.02, branch=0.03,
                      width=(1.2 * k, 3.2 * k), heading=np.pi / 2, spread=0.04, revert=0.08, branch_angle=(0.03, 0.12))
    h = (lw * (0.00025 + 0.00055 * wth) + fib * 0.00022 + fib2 * 0.00035 - chk * 0.0011 - split * 0.0035
         + (a - 0.5) ** 2 * 4.0 * (br[bi, 8] - 0.4) * 0.0022 + (br[bi, 9] - 0.5) * 0.0035
         - (1.0 - sat(d / 0.003)) ** 2 * 0.0018 - knot * 0.0006)
    h = lerp(-0.014 + fib2 * 0.0006, h, board)
    # nails: two rows (battens), two per board
    nr = c.rng("nails")
    nail = np.zeros((n, n), F)
    dimple = np.zeros((n, n), F)
    for yrow in (0.13, 0.63):
        for b in range(NBD):
            for an in (0.2, 0.8):
                nx = (b + an + nr.normal(0, 0.03)) / NBD
                ny = yrow + nr.normal(0, 0.004)
                dd = np.hypot(wrapd(c.x - nx), wrapd(c.y - ny)) * T
                nail = np.maximum(nail, smoothstep(0.0036, 0.0028, dd))
                dimple = np.maximum(dimple, np.exp(-(dd / 0.006) ** 2))
    h = h - dimple * 0.0008 + nail * 0.0007
    h = blur(h, 0.5)

    # --- albedo
    brown = ramp(sat(lw * 0.9 + 0.08 * fib2), [(0, (140, 116, 90)), (0.5, (114, 90, 68)), (1, (84, 64, 48))])
    brown = brown * (0.86 + 0.28 * br[bi, 10])[..., None]
    grey = ramp(sat(0.55 - 0.4 * lw + 0.12 * fib + 0.14 * fib2), [(0, (104, 100, 95)), (0.5, (146, 142, 134)), (1, (182, 178, 168))])
    grey = grey * (0.9 + 0.2 * br[bi, 11])[..., None]
    col = mix(brown, grey, smoothstep(0.25, 0.8, wth))
    col = col * (1.0 + 0.05 * c.noise("val", 0.5, 0.03, H=0.6, sy=3.0))[..., None]
    col = mix(col, col * np.array([0.52, 0.47, 0.42], F), knot * 0.75)
    col = mix(col, col * 0.55, sat(chk + split * 1.4) * 0.8)
    # grime towards board edges, mould specks, faint algae film
    col = mix(col, col * 0.78, sat(1.0 - d / 0.012) * 0.6)
    mould = smoothstep(2.0, 2.6, c.noise("mould", 0.006, 0.002, H=0.0) + 0.7 * smoothstep(0, 1.5, c.noise("moulda", 0.7, 0.1)))
    col = mix(col, rgb(52, 50, 48), mould * 0.6)
    alg = smoothstep(0.7, 1.9, c.noise("alg", 1.0, 0.06, H=0.7))
    col = mix(col, rgb(118, 126, 98), alg * 0.25)
    # nails and rust runs
    run = streak_down(nail, 0.075 * c.ppm) + 0.5 * streak_down(nail, 0.2 * c.ppm)
    run = sat(blur(run, 1.5 * k) * 2.2) * (0.6 + 0.4 * sat(0.5 + 0.5 * fib2))
    col = mix(col, rgb(128, 82, 52), run * 0.55 * board)
    col = mix(col, rgb(74, 52, 42), sat(blur(nail, 1.0 * k) * 1.5) * 0.9)
    col = mix(col, rgb(34, 30, 28), 1.0 - board)

    rough = 0.80 + 0.10 * wth + 0.03 * fib - 0.04 * lw
    rough = lerp(rough, 0.62, nail)
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F),
                opts=dict(nstrength=1.4, ao_radius=0.012, ao_gain=1.0))
