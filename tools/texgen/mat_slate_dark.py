"""slate_dark - dark grey-black slate spire cladding in small overlapping
round-ended scales (12 columns x 16 staggered rows), slight sheen, pale streaks.
Image bottom is the downhill / eave side."""
import numpy as np
from .core import *  # noqa: F401,F403

NC, NR = 12, 16


def build(c):
    n, T = c.n, c.tile
    r = c.rng("slate")
    NT = NC * NR
    X = c.x * NC
    Y = c.y * NR
    irr = c.noise("edge", 0.05, 0.008, H=0.6) * 0.012
    notch = smoothstep(1.4, 2.3, c.noise("notch", 0.04, 0.012, H=0.8)) * 0.07
    delta = r.uniform(-0.03, 0.03, NT).astype(F)
    shift = r.normal(0, 0.012, NT).astype(F)
    zb = r.normal(0, 0.0006, NT).astype(F)
    tl = r.normal(0, 1, (NT, 2)).astype(F)
    chipf = (r.random(NT) < 0.25).astype(F)
    rr_ = 0.68                                   # round end radius in rows (tile is 16.7 cm wide, 12.5 cm exposed)
    r0 = np.floor(Y).astype(np.int32)
    bz = np.full((n, n), -1.0, F)
    bid = np.zeros((n, n), np.int32)
    be = np.zeros((n, n), F)
    bs = np.zeros((n, n), F)
    for dr in (2, 1, 0, -1):
        rw = r0 + dr
        Xs = X + 0.5 * (rw % 2)
        ci = np.floor(Xs).astype(np.int32)
        s = (Xs - ci - 0.5).astype(F)
        tid = (ci % NC) * NR + (rw % NR)
        s2 = s - shift[tid]
        e = (rw + 1 + delta[tid]) - Y            # rows up from the scale's lowest tip
        lower = rr_ * (1.0 - np.sqrt(np.maximum(1.0 - (s2 / 0.5) ** 2, 0.0)))
        e_in = e - lower - irr - notch * chipf[tid]
        ok = (e_in > 0) & (e < 2.6) & (np.abs(s2) < 0.492)
        z = zb[tid] + 0.0048 * (3.0 - e) + (tl[tid, 0] * s2 + tl[tid, 1] * (e - 1.0) * 0.3) * 0.0012
        z = np.where(ok, z, -1.0).astype(F)
        up = z > bz
        bz = np.where(up, z, bz)
        bid = np.where(up, tid, bid)
        be = np.where(up, e_in, be)
        bs = np.where(up, s2, bs)
    h = np.maximum(bz, 0.0)
    # riven slate surface: fine cleavage terraces + grain
    cl = c.noise("cleave", 0.25, 0.01, H=0.7, sx=2.5) + c.rng("clo").random(NT).astype(F)[bid] * 3.0
    terr = np.floor(cl * 3.0) / 3.0 + 0.2 * smoothstep(0.0, 0.15, cl * 3.0 - np.floor(cl * 3.0))
    grain = c.noise("grain", 0.006, None, H=-0.2)
    fine = c.noise("fine", 0.03, 0.004, H=0.4)
    h += terr * 0.0005 + fine * 0.00012 + grain * 0.00006
    h = blur(h, 0.5)

    sr = c.rng("attr").random((NT, 6)).astype(F)
    tone = sat(0.45 + 0.5 * (sr[bid, 0] - 0.5) + 0.12 * fine + 0.1 * (terr - cl) + 0.05 * grain)
    col = ramp(tone, [(0, (38, 40, 44)), (0.5, (58, 60, 66)), (1, (84, 86, 92))])
    tint = sr[bid, 1]
    col = col * np.where((tint < 0.25)[..., None], np.array([1.04, 0.98, 1.03], F),
                         np.where((tint > 0.8)[..., None], np.array([0.97, 1.0, 1.05], F), np.array([1, 1, 1], F)))
    weath = smoothstep(-0.2, 1.4, c.noise("weath", 0.6, 0.015, H=0.5) + (sr[bid, 2] - 0.5) * 1.4)
    col = mix(col, rgb(98, 100, 102), weath * 0.45)                    # grey weathering bloom
    edgew = smoothstep(0.02, 0.0, be)
    col = mix(col, col * 1.25 + 0.02, edgew * 0.5)                     # worn pale lower edges
    # pale mineral / lime runs down the cladding
    src = smoothstep(2.0, 2.7, c.noise("ssrc", 0.3, 0.02, H=0.3))
    stk = streak_down(src, 0.30 * c.ppm) + 0.6 * streak_down(src * (c.noise("ssel", 0.6, 0.2) > 0.2), 0.8 * c.ppm)
    stk = sat(stk / (np.percentile(stk[::4, ::4], 99.6) + 1e-6))
    stk *= 0.5 + 0.5 * sat(0.5 + 0.5 * c.noise("fib", 0.05, 0.006, H=0.3, sy=12.0))
    col = mix(col, rgb(150, 150, 144), stk * 0.5)
    rust = smoothstep(1.9, 2.6, c.noise("rust", 0.2, 0.02, H=0.5) + (sr[bid, 3] > 0.85) * 1.0)
    col = mix(col, rgb(120, 84, 56), rust * 0.5)
    lich = smoothstep(3.1, 3.7, c.noise("lich", 0.02, 0.005, H=0.0) + smoothstep(0.3, 1.6, c.noise("licha", 0.8, 0.15)))
    col = mix(col, rgb(160, 162, 138), lich * 0.6)
    cav = sat(-c.curv(h, 0.008) / 0.002)
    col = mix(col, col * 0.7, cav * 0.5)
    rough = 0.46 + 0.14 * weath + 0.05 * grain + 0.25 * stk + 0.3 * lich + 0.2 * rust
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F),
                opts=dict(nstrength=1.3, ao_radius=0.012, ao_gain=1.0))
