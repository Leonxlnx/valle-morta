"""stone_blocks - coursed dressed ashlar (~60x30 cm, staggered, thin joints),
weathered, with lichen and dark streaks."""
import numpy as np
from .core import *  # noqa: F401,F403


def build(c):
    n, T = c.n, c.tile
    k = n / 2048.0
    r = c.rng("ashlar")
    wy = c.noise("wy", 2.0, 0.4) * (0.004 / T)
    Lr = course_layout(c, r, (0.27, 0.335), (0.44, 0.80), wy=wy, min_shift=0.10)
    sid, NS = Lr["id"], Lr["n"]
    sr = r.random((NS, 10)).astype(F)
    jn = c.noise("jn", 0.10, 0.01, H=0.6) * 0.0016
    mid = c.noise("mid", 0.15, 0.012, H=0.75)
    # spalled corners / arrises: chips eat into the block outline
    chipn = c.noise("chip", 0.09, 0.012, H=0.9)
    chipa = smoothstep(0.3, 1.5, c.noise("chipa", 0.9, 0.12) + (sr[sid, 0] - 0.5) * 1.6)
    chip = smoothstep(0.6, 1.6, chipn) * chipa
    g = 0.0035 + 0.003 * sr[sid, 1]
    a = Lr["ex"] - g + jn - chip * 0.03
    b = Lr["ey"] - g + jn - chip * 0.03
    d = rrect_dist(a, b, 0.007 + 0.012 * sr[sid, 2])
    inside = d > 0
    bevel = 0.004 + 0.008 * sr[sid, 3]
    t = sat(d / bevel)
    prof = 1.0 - (1.0 - t) ** 2.0
    grain = c.noise("grain", 0.008, None, H=-0.2)
    # chisel tooling: fine parallel grooves, direction per block, worn away in places
    ang = (sr[sid, 4] - 0.5) * 1.2 + np.where(sr[sid, 5] < 0.5, 0.6, -0.6)
    um = Lr["u"] * Lr["w"]
    vm = Lr["v"] * Lr["hgt"]
    ph = (um * np.cos(ang) + vm * np.sin(ang)) / 0.0075 + c.noise("toolw", 0.2, 0.03) * 0.8
    tool = (0.5 + 0.5 * np.sin(ph * TAU)) ** 2
    toolm = smoothstep(-0.6, 0.8, c.noise("toolm", 0.5, 0.05, H=0.6) + (sr[sid, 6] - 0.5) * 1.5)
    pit = smoothstep(1.9, 2.9, c.noise("pit", 0.014, 0.004, H=0.0)) * smoothstep(-0.2, 1.2, c.noise("pita", 0.6, 0.08))
    ero = smoothstep(0.4, 1.8, c.noise("ero", 0.5, 0.02, H=0.6))            # weathered, granular loss
    face = ((sr[sid, 7] - 0.5) * 0.005
            + ((Lr["u"] - 0.5) * (sr[sid, 8] - 0.5) + (Lr["v"] - 0.5) * (sr[sid, 9] - 0.5)) * 0.006
            + 0.0025 * np.sqrt(sat(d / 0.08)) + mid * 0.0010 - tool * toolm * 0.0006
            - pit * 0.002 - ero * (0.0016 + 0.0012 * c.noise("erod", 0.03, 0.004, H=0.3)) + grain * 0.00025
            - chip * 0.006)
    crk = crack_map(n, c.rng("crk"), 9, length=(0.05, 0.16), step=0.004, wander=0.4, kink=0.1, branch=0.08,
                    width=(0.8 * k, 1.8 * k), heading=np.pi / 2, spread=0.5)
    face -= crk * 0.003
    stone_h = face - (1.0 - prof) * 0.03
    openj = smoothstep(0.5, 1.5, c.noise("openj", 0.8, 0.08, H=0.8))
    mn = c.noise("mn", 0.03, 0.005, H=0.4)
    mortar_h = -0.006 - 0.014 * openj + mn * 0.0012 + grain * 0.0006
    h = np.maximum(stone_h, mortar_h)
    isj = smoothstep(-0.0004, 0.0008, mortar_h - stone_h)
    h = blur(h, 0.5)

    # --- albedo
    pal = [(178, 170, 152), (190, 182, 164), (166, 160, 146), (184, 170, 144), (154, 150, 142), (196, 190, 176)]
    base, _ = palette_pick(c.rng("pal"), NS, pal, [5, 4, 4, 2.5, 2.5, 2], jitter=0.03)
    col = base[sid]
    mott = c.noise("mott", 0.3, 0.015, H=0.5)
    bedl = c.noise("bed", 0.06, 0.008, H=0.4, sx=6.0)
    col = col * (1.0 + 0.045 * mott + 0.018 * bedl + 0.02 * grain)[..., None]
    pat = smoothstep(-0.4, 1.3, c.noise("pat", 1.0, 0.02, H=0.45))
    col = mix(col, col * np.array([0.80, 0.80, 0.79], F), pat * 0.55)
    col = mix(col, col * 1.10 + 0.015, sat(chip * 1.3 + ero * 0.5) * 0.45)          # fresher stone where spalled
    col = mix(col, col * 0.93, tool * toolm * 0.35)
    # dark rain streaks hanging from the bed joints
    bedj = sat(1.0 - Lr["ey"] / 0.012) * (Lr["v"] < 0.5)
    src = bedj * smoothstep(0.6, 1.7, c.noise("ssrc", 0.4, 0.03, H=0.5, sx=2.0))
    stk = streak_down(src, 0.22 * c.ppm)
    stk = sat(stk / (np.percentile(stk[::4, ::4], 99.5) + 1e-6))
    stk *= 0.5 + 0.5 * sat(0.5 + 0.5 * c.noise("fib", 0.06, 0.006, H=0.3, sy=10.0))
    col = mix(col, rgb(84, 82, 80), stk * 0.5 * (1 - isj))
    # black crust / soot in sheltered zones
    crust = smoothstep(1.0, 2.1, c.noise("crust", 1.4, 0.03, H=0.6))
    col = mix(col, rgb(78, 76, 74), crust * 0.5)
    # lichen
    lp = jitter_points(int(T / 0.06), int(T / 0.06), 1.0, c.rng("lich"))
    Vl = c.voronoi(lp, k=2)
    lq = c.rng("lich2").random((len(lp), 3)).astype(F)
    larea = smoothstep(-0.2, 1.3, c.noise("larea", 1.5, 0.3))
    rad = (0.006 + 0.03 * lq[Vl.id, 0] ** 2) / T
    lnz = c.noise("lichn", 0.02, 0.004, H=0.2) * (0.003 / T)
    spot = smoothstep(rad, rad * 0.7, Vl.f1 + lnz) * (lq[Vl.id, 1] < 0.42 * larea + 0.04)
    lcol = np.where((lq[Vl.id, 2] < 0.2)[..., None], rgb(196, 156, 60),
                    np.where((lq[Vl.id, 2] < 0.4)[..., None], rgb(96, 98, 92), rgb(204, 204, 192)))
    col = mix(col, lcol, spot * 0.72 * (1 - isj * 0.5))
    # joints: lime mortar, dark where open, mossy in places
    mcol = ramp(sat(0.5 + 0.25 * mn + 0.15 * grain), [(0, (150, 140, 122)), (0.5, (196, 188, 170)), (1, (218, 212, 198))])
    mcol = mix(mcol, rgb(70, 62, 54), openj * 0.85)
    col = mix(col, mcol, isj)
    grime = sat(1.0 - d / 0.012) * inside
    col = mix(col, col * np.array([0.7, 0.68, 0.65], F), grime * 0.5)
    moss = isj * smoothstep(0.8, 1.6, c.noise("moss", 1.2, 0.05, H=0.6))
    col = mix(col, rgb(84, 96, 52), moss * 0.7)
    col = mix(col, rgb(70, 64, 58), crk * 0.7)

    rough = 0.84 + 0.05 * pat + 0.03 * grain - 0.04 * sat(chip)
    rough = lerp(rough, 0.95, sat(isj + spot))
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F),
                opts=dict(nstrength=1.3, ao_radius=0.03, ao_gain=1.0))
