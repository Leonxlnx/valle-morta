"""wood_beam - old hewn timber, grain along U: wavy growth rings, knots,
adze scallops, long checks, dark aged brown."""
import numpy as np
from .core import *  # noqa: F401,F403


def grain_x(c, tag, ringw=0.0045, nknots=9):
    """Growth-ring field for timber with the grain running along U (periodic)."""
    n, T = c.n, c.tile
    kr = c.rng(tag)
    nr = int(round(T / ringw))
    ya = c.y * T + c.noise(tag + "w", 0.9, 0.08, H=1.0, sx=5.0) * 0.022 + c.noise(tag + "w2", 0.12, 0.02, H=0.6, sx=8.0) * 0.0025
    rho = ya / (T / nr)
    knot = np.zeros((n, n), F)
    for _ in range(nknots):
        xk, yk, rk = kr.random(), kr.random(), kr.uniform(0.008, 0.022)
        dx = wrapd(c.x - xk) * T
        dy = wrapd(c.y - yk) * T
        q = (dy / (2.4 * rk)) ** 2 + (dx / (4.5 * rk)) ** 2
        rho = rho + kr.uniform(3.0, 6.0) * np.exp(-q) * np.sign(dy + 1e-6)
        dk = np.hypot(dy, dx * 0.85)
        inner = smoothstep(rk * 1.1, rk * 0.8, dk)
        rho = lerp(rho, dk / (ringw * 0.4) + 3.0, inner)
        knot = np.maximum(knot, inner)
    ph = rho + 0.2 * c.noise(tag + "rn", 0.04, 0.008, H=0.5, sx=8.0)
    fr = ph - np.floor(ph)
    lw = smoothstep(0.35, 0.9, fr) * smoothstep(1.0, 0.93, fr)
    return lw.astype(F), knot


def build(c):
    n, T = c.n, c.tile
    k = n / 1024.0
    lw, knot = grain_x(c, "grain")
    fib = c.noise("fib", 0.005, None, H=0.0, sx=30.0)
    fib2 = c.noise("fib2", 0.025, 0.004, H=0.4, sx=16.0)
    # adze scallops
    pts = jitter_points(int(T / 0.11), int(T / 0.065), 0.9, c.rng("adze"), stagger=0.5)
    V = c.voronoi(pts, k=2, sy=1.5, wx=c.noise("awx", 0.4, 0.08) * (0.01 / T))
    ar = c.rng("adze2").normal(0, 1, (len(pts), 3)).astype(F)
    scoop = (V.f1 * T) ** 2 * 0.9                      # continuous concave bowls meeting in soft ridges
    scoop = blur(scoop.astype(F), 1.5 * k)
    und = c.noise("und", 1.2, 0.2, H=1.0) * 0.002
    chk = crack_map(n, c.rng("chk"), 22, length=(0.12, 0.7), step=0.004, wander=0.10, kink=0.02, branch=0.05,
                    width=(1.4 * k, 3.6 * k), heading=0.0, spread=0.04, revert=0.08, branch_angle=(0.03, 0.12))
    chk_s = blur(chk, 1.5 * k)
    fine = smoothstep(1.8, 2.5, c.noise("fchk", 0.014, 0.003, H=0.3, sx=40.0) + 0.5 * c.noise("fchka", 0.6, 0.1))
    worm = smoothstep(2.6, 3.2, c.noise("worm", 0.006, 0.0025, H=0.0) + 1.1 * smoothstep(0.5, 1.8, c.noise("worma", 0.5, 0.08)))
    h = (scoop + und + lw * 0.00045 + fib * 0.0002 + fib2 * 0.0004 - chk * 0.004 - chk_s * 0.0012
         - fine * 0.0009 - worm * 0.0012 - knot * 0.0005)
    h = blur(h, 0.5)

    col = ramp(sat(lw * 0.85 + 0.1 * fib2 + 0.06 * fib), [(0, (118, 94, 70)), (0.5, (92, 72, 54)), (1, (60, 46, 35))])
    age = smoothstep(-1.0, 1.4, c.noise("age", 0.9, 0.04, H=0.6, sx=2.0))
    col = mix(col, col * np.array([0.70, 0.66, 0.62], F), age * 0.75)             # darkened patina
    cv = c.curv(h, 0.01)
    col = mix(col, col * 1.18 + 0.02, sat(cv / 0.0012) * 0.4)                     # rubbed ridges of the scallops
    col = mix(col, col * np.array([0.5, 0.45, 0.4], F), knot * 0.75)
    col = mix(col, rgb(32, 26, 22), sat(chk * 1.3 + fine * 0.7 + worm) * 0.85)
    dust = smoothstep(0.6, 1.8, c.noise("dust", 0.7, 0.03, H=0.5))
    col = mix(col, rgb(134, 124, 110), dust * 0.22)
    col = col * (1.0 + 0.05 * c.noise("val", 0.6, 0.05, H=0.6))[..., None]
    rough = 0.78 + 0.08 * age + 0.06 * dust + 0.03 * fib - 0.05 * sat(cv / 0.0012)
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F),
                opts=dict(nstrength=1.3, ao_radius=0.02, ao_gain=1.0))
