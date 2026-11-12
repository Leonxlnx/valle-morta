"""dirt_mud - wet dark-brown churned soil: clods, small stones, boot prints,
shallow ruts along V, smooth damp patches / water films (low roughness)."""
import numpy as np
from .core import *  # noqa: F401,F403
from .stones import scatter_stones


def _boot_fn(ang, depth):
    def fn(u, v, idx):
        ca = np.cos(ang[idx]).astype(F)[:, None, None]
        sa = np.sin(ang[idx]).astype(F)[:, None, None]
        a = u * ca + v * sa
        b = -u * sa + v * ca
        wid = 0.34 + 0.05 * a - 0.09 * np.exp(-((a + 0.18) / 0.2) ** 2)
        s = (np.abs(a) / 0.9) ** 2.6 + (np.abs(b) / wid) ** 2.6
        inside = s < 1.0
        edge = sat((1.0 - s) * 3.0)
        tread = 0.5 + 0.5 * np.sin(a * 30.0 + np.abs(b) * 9.0)
        heel = np.exp(-((a + 0.3) / 0.05) ** 2)
        d = depth[idx].astype(F)[:, None, None]
        h = -d * edge ** 0.6 * (0.78 + 0.22 * tread) * (1.0 - 0.5 * heel)
        rim = np.exp(-((np.sqrt(s) - 1.14) / 0.11) ** 2)
        h = np.where(inside, h, d * 0.4 * rim)
        return h.astype(F), s < 2.4
    return fn


def build(c):
    n, T = c.n, c.tile
    r = c.rng("mud")
    und = c.noise("und", 2.5, 0.15, H=0.95)
    lump = c.fbm("lump", 0.30, octaves=4, gain=0.55, mode="billow")
    mid = c.noise("mid", 0.12, 0.012, H=0.6)
    grain = c.noise("grain", 0.01, None, H=-0.2)
    h = und * 0.012 + lump * 0.011 + mid * 0.0022 + grain * 0.0005
    # shallow ruts along V
    xw = c.x + c.noise("rw", 2.5, 0.4) * (0.11 / T)
    rut = np.zeros((n, n), F)
    for x0, w in ((0.27, 0.10), (0.74, 0.12)):
        d = wrapd(xw - x0) * T
        rut += np.exp(-(d / w) ** 2) - 0.45 * np.exp(-((np.abs(d) - 1.9 * w) / (0.8 * w)) ** 2)
    rut *= sat(0.45 + 0.75 * c.noise("rutv", 1.2, 0.25))
    h -= rut * 0.015
    # boot prints: two walking lines
    bx, by, ba = [], [], []
    for _ in range(2):
        x0, y0, a = r.random(), r.random(), r.uniform(0, TAU)
        for kk in range(7):
            side = 1 if kk % 2 else -1
            px = x0 + (kk * 0.36 * np.cos(a) - side * 0.08 * np.sin(a)) / T * (1 + r.normal(0, 0.05))
            py = y0 + (kk * 0.36 * np.sin(a) + side * 0.08 * np.cos(a)) / T * (1 + r.normal(0, 0.05))
            bx.append(px % 1.0)
            by.append(py % 1.0)
            ba.append(a + r.normal(0, 0.12) + side * 0.12)
    nbp = len(bx)
    stamp(h, np.array(bx), np.array(by), np.full(nbp, 0.165 / T), _boot_fn(np.array(ba), r.uniform(0.010, 0.02, nbp)),
          mode="add")
    # clods and stones resting on / pressed into the surface
    S = scatter_stones(c, "clods", h, 2600, 0.008, 0.045, alpha=2.6, overlap=0.9, aspect=(1.0, 1.6),
                       flat=(0.5, 0.9), embed=(0.25, 0.55), lump=0.22, p=(1.6, 2.6), q=(0.55, 0.85),
                       mode="drop", drop_q=0.0, tries=6)
    S2 = scatter_stones(c, "stones", h, 700, 0.005, 0.028, alpha=2.6, overlap=0.9, aspect=(1.0, 1.7),
                        flat=(0.5, 0.9), embed=(0.3, 0.6), lump=0.1, p=(2.2, 3.2), q=(0.55, 0.8),
                        mode="drop", drop_q=0.0, tries=6)
    clod = (S["ID"] >= 0).astype(F)
    stone = (S2["ID"] >= 0)
    h += clod * (mid * 0.0012 + grain * 0.0004)
    h = blur(h, 0.6)
    # water / slurry film in the hollows
    h0 = h
    h, wet = sediment(h, 0.22 * c.ppm, -0.0075, 0.0016)
    wet = wet * (1 - stone * 0.7)
    ripple = c.noise("rip", 0.05, 0.01, H=0.5) * 0.00012
    h = h + wet * ripple

    # --- albedo
    rel = (h0 - c.blur(h0, 0.12)) / 0.010
    dry = sat(0.42 + 0.3 * rel + 0.18 * c.noise("dryn", 0.8, 0.03, H=0.6) + 0.25 * clod - 0.35 * rut)
    col = ramp(dry, [(0, (44, 36, 30)), (0.35, (62, 51, 41)), (0.7, (82, 69, 56)), (1, (106, 92, 76))])
    col = col * (1.0 + 0.06 * grain + 0.05 * mid)[..., None]
    fleck = smoothstep(2.0, 2.6, c.noise("fleck", 0.012, 0.004, H=0.0))
    col = mix(col, rgb(150, 134, 104), fleck * 0.5)                       # bits of straw / roots / grit
    spal = [(128, 124, 116), (150, 144, 132), (104, 100, 96), (140, 122, 100)]
    sb, _ = palette_pick(c.rng("spal"), S2["N"], spal, [4, 3, 2, 2], jitter=0.05)
    scol = sb[np.clip(S2["ID"], 0, S2["N"] - 1)]
    mudcoat = smoothstep(-0.8, 1.2, c.noise("coat", 0.08, 0.008, H=0.4))
    scol = mix(scol, col * 1.1, mudcoat * 0.6)
    col = np.where(stone[..., None], scol, col)
    col = mix(col, rgb(50, 42, 34), wet * 0.85)
    cav = sat(-c.curv(h, 0.015) / 0.006)
    col = mix(col, col * 0.7, cav * 0.4 * (1 - wet))

    damp = sat(1.0 - dry * 1.15)
    rough = lerp(0.92, 0.5, damp) + 0.04 * grain
    rough = lerp(rough, 0.78, stone * 1.0)
    rough = lerp(rough, 0.12, sat(wet * 1.1))
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.05, ao_gain=1.0))
