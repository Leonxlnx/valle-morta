"""gravel_road - compacted dirt track with embedded gravel and loose pebbles,
pale grey-beige, faint wheel ruts running along V."""
import numpy as np
from .core import *  # noqa: F401,F403
from .stones import scatter_stones, stone_coords


def _res(a, res):
    n = a.shape[0]
    if n == res:
        return a
    if n > res:
        return a[:: n // res, :: n // res]
    return np.kron(a, np.ones((res // n, res // n), a.dtype))


def build(c):
    n, T = c.n, c.tile
    xw = c.x + c.noise("rw", 3.0, 0.8) * (0.035 / T)
    rut = np.zeros((n, n), F)
    for x0 in (0.29, 0.71):
        d = wrapd(xw - x0) * T
        rut += np.exp(-(d / 0.24) ** 2)
    rut *= 0.75 + 0.25 * sat(0.5 + 0.5 * c.noise("rutv", 2.0, 0.4))
    grain = c.noise("grain", 0.01, None, H=-0.3)
    mid = c.noise("mid", 0.18, 0.02, H=0.7)
    grit = smoothstep(0.7, 1.7, c.noise("grit", 0.013, 0.005, H=0.0))
    base_h = (-0.014 * rut + c.noise("und", 2.5, 0.25, H=1.0) * 0.006 + mid * 0.0018 * (1 - 0.5 * rut)
              + grain * 0.0005 + grit * 0.0022 * (1 - 0.55 * rut))
    # potholes / washed patches
    wash = smoothstep(1.5, 2.5, c.noise("wash", 1.2, 0.15, H=0.9))
    base_h -= wash * 0.008
    H = base_h.copy()
    acc1 = _res(sat(1.0 - 0.72 * rut - 0.3 * wash), 1024)
    S = scatter_stones(c, "gravel", H, 22000, 0.006, 0.028, alpha=2.7, overlap=0.92, aspect=(1.0, 1.6),
                       flat=(0.5, 0.85), embed=(0.22, 0.6), lump=0.13, p=(2.5, 4.0), q=(0.6, 0.9),
                       accept=acc1, tries=8)
    loose_m = sat(0.5 + 0.3 * c.noise("loose", 0.35, 0.08)) * sat(1.0 - 1.1 * rut)
    S2 = scatter_stones(c, "loose", H, 4200, 0.005, 0.022, alpha=2.6, overlap=1.0, aspect=(1.0, 1.7),
                        flat=(0.5, 0.8), embed=(0.15, 0.4), lump=0.15, p=(2.0, 2.8), q=(0.5, 0.7),
                        accept=_res(loose_m, 1024), mode="drop", drop_q=0.0, ID=S["ID"], id_offset=S["N"], tries=6)
    ID = S["ID"]
    valid = ID >= 0
    N1 = S["N"]
    NT = N1 + S2["N"]
    idc = np.clip(ID, 0, NT - 1)
    is_loose = (ID >= N1).astype(F)
    st = valid.astype(F)
    H += st * (c.noise("sfine", 0.02, 0.003, H=0.3) * 0.0004)
    H = blur(H, 0.55)

    # --- albedo
    mcol = ramp(sat(0.5 + 0.10 * c.noise("mc", 0.8, 0.03, H=0.5) + 0.10 * grain + 0.06 * mid),
                [(0, (118, 107, 90)), (0.4, (152, 140, 120)), (0.7, (170, 159, 139)), (1, (194, 185, 166))])
    mcol = mix(mcol, mcol * np.array([1.07, 1.07, 1.06], F), sat(rut) * 0.8)
    mcol = mix(mcol, mcol * 0.8, grit * 0.25)
    pal = [(186, 183, 176), (170, 166, 158), (192, 180, 156), (204, 200, 190), (126, 124, 120), (150, 138, 122), (160, 128, 100)]
    base, _ = palette_pick(c.rng("pal"), NT, pal, [8, 7, 5, 4, 2.5, 3, 0.8], jitter=0.04)
    scol = base[idc] * (1.0 + 0.05 * c.noise("sp", 0.015, 0.003, H=0.0))[..., None]
    dustn = smoothstep(-1.0, 1.4, c.noise("dust", 0.25, 0.01, H=0.4))
    dust = sat(0.12 + 0.35 * dustn + 0.25 * rut) * (1 - 0.6 * is_loose)
    scol = mix(scol, mcol * 1.03, dust * 0.75)
    col = np.where(valid[..., None], scol, mcol)
    cav = sat(-c.curv(H, 0.012) / 0.005)
    col = mix(col, col * np.array([0.66, 0.63, 0.59], F), cav * 0.5)
    # damp darker fines in the washed hollows
    col = mix(col, col * np.array([0.86, 0.85, 0.83], F), wash * 0.7)

    rough = np.where(valid, 0.78, 0.92).astype(F) + 0.03 * grain
    rough = rough - 0.07 * rut - 0.12 * wash
    return dict(h=H, col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.03, ao_gain=1.0))
