"""rust_metal - heavily rusted armour steel with remnants of flaking
olive-drab paint (25-40 % coverage). Also writes rust_metal_mask.jpg
(white = paint remaining)."""
import numpy as np
from .core import *  # noqa: F401,F403


def build(c):
    n, T = c.n, c.tile
    k = n / 2048.0
    grain = c.noise("grain", 0.004, None, H=-0.3)
    n_l = c.noise("nl", 1.2, 0.05, H=0.8)
    n_m = c.noise("nm", 0.08, 0.006, H=0.5)
    n_f = c.noise("nf", 0.012, 0.002, H=0.2)
    # --- paint mask: big islands with chipped, angular edges, rust spots erupting through
    g = int(T / 0.012)
    fp = jitter_points(g, g, 1.0, c.rng("chipcells"))
    Vc = c.voronoi(fp, k=2)
    cell = c.rng("chipcells2").normal(0, 1, len(fp)).astype(F)[Vc.id]
    scr = crack_map(n, c.rng("scratch"), 34, length=(0.05, 0.4), step=0.006, wander=0.05, kink=0.0, branch=0.0,
                    width=(1.0 * k, 3.5 * k), taper=False)
    erupt = smoothstep(1.5, 2.3, c.noise("erupt", 0.03, 0.006, H=0.2) + 0.5 * c.noise("erupta", 0.5, 0.08))
    f = (c.noise("pf", 1.0, 0.012, H=0.85) + 0.10 * cell + 0.06 * c.noise("pf2", 0.02, 0.004, H=0.3)
         - 0.9 * erupt - 1.2 * blur(scr, 1.0 * k))
    t0 = thresh_for_coverage(f, 0.33)
    paint = smoothstep(0.0, 0.03, f - t0)
    near = smoothstep(0.30, 0.0, f - t0) * paint                      # paint close to its edge
    lip = sat(blur(paint, 2.0 * k) * (1 - blur(paint, 5.0 * k)) * 6.0) * paint
    # --- rust relief (metres; sub-millimetre scale)
    pp = jitter_points(int(T / 0.006), int(T / 0.006), 1.0, c.rng("pits"))
    Vp = c.voronoi(pp, k=2)
    pr = c.rng("pits2").random((len(pp), 2)).astype(F)
    prad = (0.0008 + 0.0022 * pr[Vp.id, 0]) / T
    pit = smoothstep(prad, prad * 0.3, Vp.f1) * (pr[Vp.id, 1] < 0.45)
    lam = c.noise("lam", 0.12, 0.008, H=0.6)
    scale = np.floor(lam * 2.2) / 2.2 + 0.25 * smoothstep(0.0, 0.25, lam * 2.2 - np.floor(lam * 2.2))   # layered flaking scale
    blister = smoothstep(0.6, 1.8, c.noise("blis", 0.018, 0.005, H=0.0))
    rust_h = scale * 0.00035 + n_m * 0.00022 + n_f * 0.00012 + blister * 0.00025 - pit * 0.0005 + grain * 0.00005
    plate = c.noise("plate", 1.5, 0.3, H=1.0) * 0.0006
    orange = c.noise("opeel", 0.01, 0.003, H=0.0)
    paint_h = (0.00042 + plate * 0.0 + orange * 0.00003 + near * blister * 0.00045 + lip * 0.00022
               + blur(rust_h, 4.0 * k) * 0.6)
    h = plate + lerp(rust_h, paint_h, paint)
    # dents / gouges from impacts
    r = c.rng("dents")
    ND = 9
    dent = np.zeros((n, n), F)
    fn = blob_fn(r.random(ND) * TAU, r.uniform(1.0, 2.5, ND), np.ones(ND), r.uniform(0, 0.1, (ND, 4)), r.random((ND, 4)) * TAU,
                 p=2.0, q=1.5, size=0.9)
    stamp(dent, r.random(ND), r.random(ND), r.uniform(0.02, 0.06, ND) / T, fn)
    h -= dent * 0.0022
    h = blur(h, 0.5)

    # --- albedo
    tr = sat(0.45 + 0.13 * n_l + 0.15 * n_m + 0.10 * n_f + 0.15 * (scale - 0.2) - 0.3 * pit)
    rust = ramp(tr, [(0, (46, 34, 30)), (0.25, (72, 46, 35)), (0.5, (102, 62, 42)), (0.75, (132, 82, 50)), (1, (162, 110, 66))])
    dark = smoothstep(0.5, 1.7, c.noise("dark", 0.6, 0.02, H=0.6))
    rust = mix(rust, rgb(58, 44, 40), dark * 0.6)                      # dark magnetite patches
    ochre = smoothstep(1.4, 2.3, c.noise("ochre", 0.25, 0.01, H=0.4))
    rust = mix(rust, rgb(170, 122, 68), ochre * 0.45)                  # powdery yellow-orange bloom
    rust = rust * (1.0 + 0.05 * grain)[..., None]
    # vertical rust wash (rain) inside the rust itself
    wash = c.noise("wash", 0.25, 0.01, H=0.4, sy=10.0)
    rust = rust * (1.0 + 0.07 * wash)[..., None]
    pcol = np.empty((n, n, 3), F)
    pcol[:] = rgb(78, 82, 58)
    fade = smoothstep(-0.8, 1.4, c.noise("fade", 0.9, 0.03, H=0.6))
    pcol = mix(pcol, rgb(104, 106, 84), fade * 0.55)                    # chalked / sun-faded
    pcol = pcol * (1.0 + 0.04 * c.noise("pv", 0.3, 0.01, H=0.5) + 0.02 * orange)[..., None]
    grime = smoothstep(0.2, 1.6, c.noise("grime", 0.7, 0.02, H=0.6, sy=3.0))
    pcol = mix(pcol, pcol * np.array([0.70, 0.68, 0.64], F), grime * 0.5)
    # rust bleeding and running down over the paint
    stain_src = (1.0 - paint) * (0.6 + 0.4 * sat(0.5 + 0.5 * n_m))
    run = streak_down(stain_src, 0.06 * c.ppm) * 0.9 + streak_down(stain_src * (wash > 0.3), 0.22 * c.ppm) * 0.8
    run = sat(run) * (0.6 + 0.4 * sat(0.5 + 0.5 * wash))
    pcol = mix(pcol, rgb(134, 80, 46), sat(run * 0.75 + near * 0.35 + near * blister * 0.5))
    primer = sat(near * 2.0 - 1.2 + 0.4 * n_f) * (cell > 0.3)
    pcol = mix(pcol, rgb(122, 64, 50), primer * 0.7)                   # red-oxide primer at chipped edges
    col = mix(rust, pcol, paint)
    col = mix(col, col * 0.75, pit * (1 - paint) * 0.7)

    rough = lerp(0.90 + 0.04 * n_f - 0.06 * dark, 0.56 + 0.12 * fade + 0.2 * sat(run), paint)
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), mask=paint.astype(F),
                opts=dict(nstrength=3.0, ao_radius=0.004, ao_gain=1.6))
