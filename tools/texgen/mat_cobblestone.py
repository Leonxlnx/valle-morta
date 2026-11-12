"""cobblestone - worn village street setts (10-18 cm) with dirt and grass in
the joints and polished tops (lower roughness)."""
import numpy as np
from .core import *  # noqa: F401,F403
from .mat_grass_ground import _at


def build(c):
    n, T = c.n, c.tile
    r = c.rng("cobble")
    wx = c.noise("wx", 0.9, 0.12, H=0.9) * (0.012 / T)
    wy = c.noise("wy", 0.9, 0.12, H=0.9) * (0.012 / T) + np.sin(c.x * TAU * 2) * 0.004
    Lr = course_layout(c, r, (0.105, 0.16), (0.10, 0.185), wx=wx, wy=wy, min_shift=0.025)
    sid, NS = Lr["id"], Lr["n"]
    sr = r.random((NS, 8)).astype(F)
    g = 0.006 + 0.007 * sr[sid, 0]
    jn = c.noise("jn", 0.06, 0.012, H=0.6) * 0.0022
    a = Lr["ex"] - g + jn
    b = Lr["ey"] - g + jn
    rc = 0.014 + 0.022 * sr[sid, 1]
    d = rrect_dist(a, b, rc)
    inside = d > 0
    bevel = 0.012 + 0.016 * sr[sid, 2]
    t = sat(d / bevel)
    prof = 1.0 - (1.0 - t) ** 2.6
    mid = c.noise("mid", 0.08, 0.01, H=0.7)
    grain = c.noise("grain", 0.008, None, H=-0.2)
    pit = smoothstep(1.8, 2.8, c.noise("pit", 0.012, 0.004, H=0.0)) * smoothstep(-0.3, 1.0, c.noise("pita", 0.5, 0.08))
    top = ((sr[sid, 3] - 0.5) * 0.008 + ((Lr["u"] - 0.5) * (sr[sid, 4] - 0.5) + (Lr["v"] - 0.5) * (sr[sid, 5] - 0.5)) * 0.012
           + mid * 0.0009 * (0.5 + sr[sid, 6]) + grain * 0.00018 - pit * 0.0016
           + 0.004 * np.sqrt(sat(d / 0.06)))                      # gentle crown
    stone_h = top - (1.0 - prof) * 0.045
    # joints: packed dirt with grit
    dj = c.noise("dj", 0.05, 0.006, H=0.5)
    dirt_h = -0.017 + c.noise("dl", 1.2, 0.15) * 0.004 + dj * 0.002 + grain * 0.0006
    h = np.maximum(stone_h, dirt_h)
    isj = smoothstep(-0.0005, 0.001, dirt_h - stone_h)
    # moss cushions and grass in the joints
    veg = smoothstep(0.1, 1.2, c.noise("veg", 1.6, 0.25, H=0.8))
    mossf = smoothstep(0.2, 0.9, c.noise("mossn", 0.12, 0.012, H=0.4) + veg * 1.2 - 0.7)
    moss = isj * mossf
    mb = np.abs(c.noise("mossb", 0.03, 0.005, H=0.3))
    h += moss * (0.004 + 0.004 * mb)
    # grass blades rooted in the joints
    rg = c.rng("grass")
    NG = 26000
    x, y = rg.random(NG * 6), rg.random(NG * 6)
    keep = rg.random(NG * 6) < _at(isj * (0.08 + 0.92 * veg), x, y)
    x, y = x[keep][:NG], y[keep][:NG]
    NG = len(x)
    th = rg.random(NG) * TAU
    L = rg.uniform(0.012, 0.05, NG) / T
    R = Raster(n, 2)
    R.lines(x, y, x + np.cos(th) * L, y + np.sin(th) * L, rg.uniform(0.0015, 0.003, NG) / T, np.arange(1, NG + 1))
    tone = rg.random(NG)
    gcol = ramp(tone, [(0, (52, 70, 32)), (0.5, (84, 104, 44)), (0.8, (118, 126, 60)), (1, (160, 146, 96))])
    Ct = np.concatenate([np.zeros((1, 3), F), gcol])
    Mt = np.ones(NG + 1, F)
    Mt[0] = 0
    idm = R.ids()
    gcov = R.resolve(Mt, idm)
    gc = R.resolve(Ct, idm)
    del R, idm
    h += gcov * 0.004
    h = blur(h, 0.55)

    # --- albedo
    pal = [(150, 148, 142), (170, 167, 158), (158, 150, 136), (134, 114, 104), (108, 106, 104), (140, 133, 122), (124, 106, 96)]
    base, _ = palette_pick(c.rng("pal"), NS, pal, [6, 4, 4, 1.6, 2, 4, 1.0], jitter=0.035)
    col = base[sid]
    mott = c.noise("mott", 0.15, 0.012, H=0.5)
    col = col * (1.0 + 0.05 * mott + 0.03 * mid + 0.02 * grain)[..., None]
    wear = sat(prof * 1.3 - 0.35) * (0.6 + 0.4 * smoothstep(-1, 1, c.noise("wear", 0.8, 0.1)))   # polished tops
    col = mix(col, col * 1.08 + 0.02, wear * 0.5)
    grime = sat(1.0 - d / 0.022) * inside
    col = mix(col, col * np.array([0.62, 0.59, 0.55], F), grime * 0.6)
    col = mix(col, col * 0.72, pit * 0.7)
    dcol = ramp(sat(0.5 + 0.25 * dj + 0.15 * grain), [(0, (46, 38, 31)), (0.5, (74, 62, 50)), (1, (112, 98, 80))])
    col = mix(col, dcol, isj)
    mcol = ramp(sat(0.2 + 0.9 * mb + 0.1 * grain), [(0, (36, 48, 22)), (0.5, (70, 88, 36)), (1, (116, 122, 54))])
    col = mix(col, mcol, moss * 0.9)
    # dust / dirt film creeping from joints onto the stones
    film = sat(1.0 - d / 0.05) * smoothstep(-0.2, 1.3, c.noise("film", 0.4, 0.03, H=0.5)) * inside
    col = mix(col, rgb(112, 100, 84), film * 0.35)
    col = col * (1 - gcov)[..., None] + gc

    rough = 0.86 - 0.34 * wear + 0.05 * grain + 0.08 * film
    rough = lerp(rough, 0.95, sat(isj + gcov))
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.04, ao_gain=1.0))
