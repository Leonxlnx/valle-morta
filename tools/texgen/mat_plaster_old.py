"""plaster_old - old cream lime plaster: trowel undulation, hairline cracks,
flaking limewash, water streaks, algae, small chips to the base coat."""
import numpy as np
from .core import *  # noqa: F401,F403


def plaster(c, dirty=0.0, crack_starts=None, chip_cov=0.016):
    """Shared plaster layer. Returns dict(h, col, rough, crack, chip)."""
    n, T = c.n, c.tile
    k = n / 2048.0
    # --- height (metres, plaster face ~ 0)
    und = c.noise("und", 0.9, 0.10, H=1.0)
    trow = c.noise("trow", 0.22, 0.03, H=0.6, sx=3.5) * 0.6 + c.noise("trow2", 0.3, 0.04, H=0.6, sy=2.5) * 0.4
    grain = c.noise("grain", 0.012, None, H=-0.3)
    sand = c.noise("sand", 0.03, 0.004, H=0.4)
    h = und * 0.0016 + trow * 0.0008 + sand * 0.00030 + grain * 0.00016
    pin = smoothstep(3.0, 3.8, c.noise("pin", 0.008, 0.003, H=0.0)
                     + 0.5 * smoothstep(0, 1.5, c.noise("pinarea", 0.6, 0.08)))
    h -= pin * 0.0007
    # limewash coats (thin flaking skins)
    lw_f = c.noise("lw", 0.7, 0.008, H=0.55) + 0.35 * c.noise("lw2", 0.06, 0.006, H=0.2)
    coat = smoothstep(0.0, 0.06, lw_f - thresh_for_coverage(lw_f, 0.72))
    coat2 = smoothstep(0.0, 0.06, lw_f - thresh_for_coverage(lw_f, 0.33))
    h += coat * 0.0005 + coat2 * 0.00045
    # hairline cracks
    r = c.rng("cracks")
    crack = crack_map(n, r, 26, length=(0.10, 0.45), step=0.003, wander=0.55, kink=0.05,
                      branch=0.10, width=(0.8 * k, 1.9 * k), starts=crack_starts)
    crack2 = crack_map(n, c.rng("cracks2"), 60, length=(0.02, 0.09), step=0.003, wander=0.8, kink=0.1,
                       branch=0.2, width=(0.5 * k, 1.0 * k))          # fine crazing
    craze_area = smoothstep(0.2, 1.4, c.noise("crazearea", 1.0, 0.15))
    crk = np.maximum(crack, crack2 * craze_area * 0.8)
    crk_soft = blur(crk, 1.2 * k)
    h -= crk * 0.0016 + crk_soft * 0.0006
    # chips of the finish coat (cluster near cracks)
    cf = (c.noise("chip", 0.30, 0.02, H=1.0) + 0.12 * c.noise("chip2", 0.04, 0.008, H=0.4)
          + 1.2 * sat(blur(crack, 9.0 * k) * 5.0) + 1.3 * c.noise("chiparea", 2.0, 0.5))
    chip = smoothstep(0.0, 0.05, cf - thresh_for_coverage(cf, chip_cov))
    chip_h = -0.0035 + c.noise("chipn", 0.02, 0.003, H=0.2) * 0.0007 + grain * 0.0003
    h = lerp(h, chip_h + und * 0.0016, chip)

    # --- albedo
    mott = c.noise("mott", 1.6, 0.05, H=0.7)
    mott2 = c.noise("mott2", 0.25, 0.01, H=0.4)
    col = np.empty((n, n, 3), F)
    col[:] = rgb(220, 213, 196)                                    # aged lime plaster
    col = mix(col, rgb(208, 197, 172), smoothstep(0.2, 1.8, mott) * 0.7)     # yellowed patches
    col = mix(col, rgb(226, 221, 206), coat * 0.75)                # limewash coat 1
    col = mix(col, rgb(232, 229, 219), coat2 * 0.8)                # newest, whitest coat
    col = col * (1.0 + 0.022 * mott2 + 0.012 * sand + 0.010 * grain + 0.012 * trow)[..., None]
    # general grime film (grey-brown), heavier in broad zones
    grime = smoothstep(-0.6, 2.0, c.noise("grime", 1.3, 0.04, H=0.6)) * (0.30 + 0.5 * dirty)
    col = mix(col, col * np.array([0.84, 0.825, 0.80], F), grime)
    # water streaks running down
    src = smoothstep(2.0, 2.6, c.noise("ssrc", 0.5, 0.02, H=0.3, sx=2.0))
    stk = streak_down(src, 0.4 * c.ppm) + 0.7 * streak_down(src * (c.noise("ssel", 0.8, 0.2) > 0.3), 1.1 * c.ppm)
    stk = stk / (np.percentile(stk[::4, ::4], 99.7) + 1e-6)
    fib = 0.6 + 0.4 * sat(0.5 + 0.5 * c.noise("fib", 0.06, 0.006, H=0.3, sy=14.0))
    stk = sat(stk * 1.2) * fib
    col = mix(col, col * np.array([0.70, 0.68, 0.63], F), stk * (0.7 + 0.2 * dirty))
    # pale lime-leach streaks
    src2 = smoothstep(1.9, 2.4, c.noise("ssrc2", 0.4, 0.02, H=0.3))
    stk2 = streak_down(src2, 0.35 * c.ppm)
    stk2 = sat(stk2 / (np.percentile(stk2[::4, ::4], 99.7) + 1e-6)) * fib
    col = mix(col, rgb(234, 232, 224), stk2 * 0.45)
    # grey-green algae in damp zones (follows the streaks and one broad band)
    damp = smoothstep(0.9, 2.2, c.noise("damp", 1.6, 0.25) + 0.9 * blur(stk, 14.0 * k))
    alg_n = smoothstep(-0.4, 1.0, c.noise("algn", 0.12, 0.008, H=0.2))
    alg = damp * alg_n
    col = mix(col, rgb(150, 152, 122), alg * 0.42)
    col = mix(col, rgb(88, 96, 70), alg * smoothstep(1.2, 2.2, c.noise("algd", 0.05, 0.006, H=0.0)) * 0.5)
    # rusty / ochre blooms (few)
    och = smoothstep(1.9, 2.6, c.noise("och", 0.5, 0.03, H=0.7))
    col = mix(col, rgb(190, 160, 118), och * 0.45)
    # dirt in cracks and pinholes
    col = mix(col, rgb(104, 94, 80), sat(crk * 1.1) * 0.85)
    col = mix(col, col * 0.86, sat(crk_soft * 1.5) * 0.5)
    col = mix(col, col * 0.7, pin * 0.6)
    # chips: sandy grey-brown base coat, fresh bright rim
    sub = ramp(sat(0.5 + 0.25 * c.noise("subn", 0.015, None, H=-0.2)),
               [(0, (120, 106, 88)), (0.5, (158, 142, 118)), (1, (188, 174, 150))])
    col = mix(col, sub, chip)
    rim = sat(blur(chip, 1.6 * k) * (1 - chip) * 4.0)
    col = mix(col, rgb(232, 228, 216), rim * 0.5)

    rough = 0.88 + 0.03 * coat + 0.02 * grain - 0.03 * grime + 0.05 * alg
    rough = lerp(rough, 0.96, chip)
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), crack=crk, chip=chip, und=und)


def build(c):
    L = plaster(c)
    return dict(h=L["h"], col=L["col"], rough=L["rough"], opts=dict(nstrength=1.6, ao_radius=0.01, ao_gain=0.9))
