"""riverbed_pebbles - rounded river cobbles and pebbles (2-25 cm) bedded in sand."""
import numpy as np
from .core import *  # noqa: F401,F403
from .stones import scatter_stones, stone_coords


def build(c):
    n, T = c.n, c.tile
    grain = c.noise("grain", 0.012, None, H=-0.3)
    sand_h = c.noise("sandu", 1.6, 0.10, H=0.9) * 0.006 + c.noise("sandm", 0.06, 0.008, H=0.4) * 0.0012 + grain * 0.0007
    H = sand_h.copy()
    S = scatter_stones(c, "stones", H, 6500, 0.011, 0.13, alpha=2.15, overlap=0.78,
                       aspect=(1.0, 1.8), flat=(0.5, 0.85), embed=(0.12, 0.4), lump=0.06, tries=14)
    valid, sc, du, dv = stone_coords(c, S)
    st = valid.astype(F)
    rnd = S["rnd"]
    # stone surface: faint lumps, pits, grain scaled per stone
    lumps = c.noise("lumps", 0.05, 0.008, H=0.7)
    pit = smoothstep(2.6, 3.4, c.noise("pit", 0.01, 0.003, H=0.0))
    rk = (0.3 + 1.4 * rnd[sc, 0] ** 2)
    H += st * (lumps * 0.0007 * rk + grain * 0.00010 * rk - pit * 0.0005 * rk)
    H = blur(H, 0.6)

    # --- albedo
    pal = [(176, 174, 168), (142, 142, 138), (204, 199, 187), (170, 151, 124), (98, 100, 101),
           (142, 96, 78), (128, 136, 124), (178, 148, 104), (118, 108, 98)]
    base, kind = palette_pick(c.rng("pal"), S["N"], pal, [30, 22, 14, 12, 8, 4, 2.5, 2, 7], jitter=0.03)
    base = lum(base)[:, None] + (base - lum(base)[:, None]) * 0.85
    col = base[sc]
    pa = rnd[sc, 1] * TAU
    along = du * np.cos(pa) + dv * np.sin(pa)
    across = -du * np.sin(pa) + dv * np.cos(pa)
    wob = c.noise("wob", 0.08, 0.01, H=0.8)
    # banding
    bands = np.sin(along * (5.0 + 14.0 * rnd[sc, 2]) + rnd[sc, 3] * TAU + wob * 1.3)
    col = col * (1.0 + 0.085 * bands * (rnd[sc, 4] < 0.3))[..., None]
    # speckle (granite / porphyry like for some)
    sp = c.noise("speck", 0.012, 0.003, H=0.0)
    spk = np.where(rnd[sc, 5] < 0.28, 0.11, 0.03)
    col = col * (1.0 + spk * sp + 0.03 * lumps)[..., None]
    # calcite veins
    vv = np.abs(along - (rnd[sc, 6] - 0.5) * 0.9 + wob * 0.06 + 0.1 * np.sin(across * 4.0))
    vein = smoothstep(0.05, 0.02, vv) * (rnd[sc, 7] < 0.12)
    vein2 = smoothstep(0.03, 0.012, np.abs(across - (rnd[sc, 3] - 0.5) * 0.7 + wob * 0.05)) * (rnd[sc, 7] < 0.05)
    col = mix(col, rgb(222, 219, 210), sat(vein + vein2) * 0.8)
    # weathering rind: tops slightly paler / silty, flanks darker
    hn = sat((H - sand_h) / (S["hgt"][sc].astype(F) * 0.8 + 1e-4))
    col = mix(col, col * 0.84, (1 - hn) * 0.55)
    silt = smoothstep(0.2, 1.6, c.noise("silt", 0.3, 0.02, H=0.6)) * hn
    col = mix(col, rgb(170, 160, 140), silt * 0.22)
    alg = smoothstep(0.7, 1.9, c.noise("alg", 0.5, 0.03, H=0.6)) * hn
    col = mix(col, rgb(104, 106, 78), alg * 0.25)
    # sand
    sg = c.noise("sgrain", 0.008, None, H=-0.6)
    scol = ramp(sat(0.5 + 0.2 * sg + 0.1 * c.noise("sandc", 0.5, 0.03)),
                [(0, (86, 80, 70)), (0.3, (132, 122, 104)), (0.6, (160, 149, 128)), (1, (206, 198, 180))])
    col = np.where(valid[..., None], col, scol)
    cav = sat(-c.curv(H, 0.02) / 0.01)
    col = mix(col, col * np.array([0.6, 0.57, 0.53], F), cav * 0.5)

    rough = np.where(valid, 0.50 + 0.25 * rnd[sc, 0] + 0.05 * sp, 0.92).astype(F)
    rough = lerp(rough, 0.85, silt * 0.6)
    return dict(h=H, col=col.astype(F), rough=rough, opts=dict(ao_radius=0.08, ao_gain=1.0))
