"""rubble - dense debris bed: broken stone, mortar chunks, plaster flakes,
terracotta shards, a few timber splinters, dust (pieces 2-30 cm)."""
import numpy as np
from .core import *  # noqa: F401,F403

STONE, MORTAR, PLASTER, TERRA, WOOD = 0, 1, 2, 3, 4


def build(c):
    n, T = c.n, c.tile
    r = c.rng("rubble")
    grain = c.noise("grain", 0.01, None, H=-0.2)
    mid = c.noise("mid", 0.12, 0.012, H=0.6)
    grit0 = smoothstep(0.6, 1.8, c.noise("grit", 0.016, 0.006, H=0.0))
    base = c.noise("und", 2.5, 0.3, H=1.0) * 0.018 + mid * 0.003 + grit0 * 0.003 + grain * 0.0006
    H = base.copy()
    ID = np.full((n, n), -1, np.int32)

    # --- pieces, large first so smaller debris lies on and between them
    NB, NS = 460, 4300
    radb = power_radii(r, NB, 0.05, 0.16, 1.7)
    xb, yb, ok = pack_discs(r, radb / T, overlap=0.80, tries=30)
    radb, xb, yb = radb[ok], xb[ok], yb[ok]
    rads = power_radii(r, NS, 0.012, 0.05, 2.2)
    xs, ys = r.random(NS), r.random(NS)
    rad = np.concatenate([radb, rads])
    x = np.concatenate([xb, xs])
    y = np.concatenate([yb, ys])
    N = len(rad)
    big = rad > 0.05
    kind = r.choice(5, N, p=[0.44, 0.17, 0.15, 0.20, 0.04])
    kind[big & (kind == WOOD)] = STONE
    kind[big & (r.random(N) < 0.35)] = STONE
    squash = np.where(kind == WOOD, r.uniform(0.12, 0.22, N), r.uniform(0.5, 1.0, N))
    squash[kind == TERRA] = r.uniform(0.45, 0.9, (kind == TERRA).sum())
    ang = r.random(N) * TAU
    nrm, dist = shape_polys(r, N, 4, 7, 0.4, squash=squash, angle=ang)
    thick = rad * r.uniform(0.35, 0.75, N)
    thick[kind == MORTAR] *= 0.9
    thick[kind == PLASTER] = r.uniform(0.008, 0.022, (kind == PLASTER).sum())
    thick[kind == TERRA] = r.uniform(0.012, 0.02, (kind == TERRA).sum())
    thick[kind == WOOD] = r.uniform(0.01, 0.025, (kind == WOOD).sum())
    bevel = np.where((kind == PLASTER) | (kind == TERRA) | (kind == WOOD), r.uniform(0.04, 0.09, N), r.uniform(0.10, 0.30, N))
    tilt = r.normal(0, 1, (N, 2)) * np.where(kind <= MORTAR, 0.28, 0.45)[:, None]
    fn = poly_fn(nrm, dist, thick, bevel, tilt=tilt, dome=0.10)
    nb = len(radb)
    half = rad / 0.78 / T

    stamp(H, x[:nb], y[:nb], half[:nb], fn, ID=ID, mode="drop", drop_q=0.5)
    # small debris mostly falls between the big blocks
    onbig = ID[(y[nb:] * n).astype(int) % n, (x[nb:] * n).astype(int) % n] >= 0
    keep = np.nonzero(~onbig | (r.random(len(onbig)) < 0.2))[0] + nb
    ID2 = np.full((n, n), -1, np.int32)
    order_small = keep
    xs2, ys2, hs2 = x[order_small], y[order_small], half[order_small]
    fn_small = poly_fn(nrm[order_small], dist[order_small], thick[order_small], bevel[order_small], tilt=tilt[order_small], dome=0.10)
    stamp(H, xs2, ys2, hs2, fn_small, ID=ID2, mode="drop", drop_q=0.3)
    won = ID2 >= 0
    ID[won] = order_small[ID2[won]]

    valid = ID >= 0
    pid = np.clip(ID, 0, N - 1)
    kd = np.where(valid, kind[pid], -1)
    prn = r.random((N, 4)).astype(F)
    # per-type surface detail
    fac = c.noise("fac", 0.035, 0.004, H=0.5)
    det = np.where(kd == STONE, fac * 0.0016 + mid * 0.001,
                   np.where(kd == MORTAR, fac * 0.0012 + grain * 0.0012,
                            np.where(kd == TERRA, c.noise("tstri", 0.02, 0.003, H=0.3, sy=6.0) * 0.0003 + grain * 0.0002,
                                     np.where(kd == WOOD, c.noise("wgr", 0.01, 0.002, H=0.2, sx=8.0) * 0.0006, grain * 0.00025))))
    H += det * valid
    # --- dust and grit settle in the gaps
    H0 = H
    H, dustm = sediment(H, 0.035 * c.ppm, -0.028, 0.005)
    # coloured grit crumbs on the dust
    g = int(T / 0.013)
    gp = jitter_points(g, g, 1.0, c.rng("crumbs"))
    Vg = c.voronoi(gp, k=2)
    gr = c.rng("crumbs2").random((len(gp), 4)).astype(F)
    crad = (0.002 + 0.0045 * gr[Vg.id, 0]) / T
    crumb = smoothstep(crad, crad * 0.5, Vg.f1) * (gr[Vg.id, 1] < 0.55)
    H += crumb * (0.0015 + 0.003 * gr[Vg.id, 0]) * (0.35 + 0.65 * dustm) + dustm * grain * 0.0005
    H = blur(H, 0.55)

    # --- albedo
    spal = [(166, 159, 145), (180, 170, 152), (192, 184, 165), (154, 150, 140), (134, 127, 114), (172, 156, 131)]
    tpal = [(170, 108, 80), (150, 92, 70), (182, 134, 104), (160, 102, 76), (126, 86, 68)]
    r2 = c.rng("pal")
    sc_, _ = palette_pick(r2, N, spal, [5, 5, 3, 3, 1.5, 1.2], jitter=0.035)
    tc_, _ = palette_pick(r2, N, tpal, [5, 4, 2, 4, 1.5], jitter=0.045)
    base_c = sc_.copy()
    base_c[kind == MORTAR] = rgb(198, 190, 172) * (1 + r2.normal(0, 0.04, ((kind == MORTAR).sum(), 1)))
    base_c[kind == PLASTER] = rgb(222, 216, 201) * (1 + r2.normal(0, 0.03, ((kind == PLASTER).sum(), 1)))
    base_c[kind == TERRA] = tc_[kind == TERRA]
    wsel = kind == WOOD
    base_c[wsel] = np.where(r2.random((wsel.sum(), 1)) < 0.5, rgb(52, 46, 42), rgb(108, 88, 66))
    col = base_c[pid].astype(F)
    mott = c.noise("mott", 0.2, 0.012, H=0.5)
    col = col * (1.0 + 0.05 * mott + 0.03 * fac * (kd <= MORTAR) + 0.02 * grain)[..., None]
    # stones: grey patina on some faces; plaster flakes: sandy backs showing on some
    pat = smoothstep(0.0, 1.2, c.noise("pat", 0.4, 0.02, H=0.4) + (prn[pid, 0] - 0.5) * 2.0) * (kd == STONE)
    col = mix(col, col * np.array([0.80, 0.79, 0.77], F), pat * 0.5)
    back = (prn[pid, 1] < 0.3) & (kd == PLASTER)
    col = mix(col, rgb(170, 156, 134) * (1.0 + 0.06 * grain)[..., None], back * 0.85)
    soot = (prn[pid, 2] < 0.08) & (kd != WOOD) & valid
    col = mix(col, col * 0.5, soot * smoothstep(-0.5, 1.0, mott) * 0.7)
    cv = c.curv(H0, 0.006)
    col = mix(col, col * 1.1 + 0.02, sat(cv / 0.003) * valid * 0.4)            # bright fresh arrises
    # dust bed + crumbs
    dcol = ramp(sat(0.5 + 0.18 * mid + 0.14 * grain + 0.12 * c.noise("dc", 0.8, 0.05)),
                [(0, (128, 118, 102)), (0.5, (168, 158, 140)), (1, (198, 190, 174))])
    ccol = np.where((gr[Vg.id, 2] < 0.12)[..., None], rgb(160, 106, 82),
                    np.where((gr[Vg.id, 2] < 0.5)[..., None], rgb(214, 208, 194), rgb(150, 144, 132)))
    ccol = ccol * (0.85 + 0.3 * gr[Vg.id, 3])[..., None]
    col = np.where(valid[..., None], col, dcol)
    col = mix(col, dcol, dustm * 0.92)
    col = mix(col, ccol, crumb * (0.25 + 0.7 * sat(dustm + (~valid))))
    # dust film over everything (thicker on flat upward faces and low areas)
    film = smoothstep(-1.0, 1.5, c.noise("film", 0.35, 0.015, H=0.45)) * (0.22 + 0.25 * (kd != TERRA))
    col = mix(col, rgb(190, 182, 166), film * (1 - dustm))
    cav = sat(-c.curv(H, 0.02) / 0.012)
    col = mix(col, col * np.array([0.6, 0.58, 0.55], F), cav * 0.5)

    rough = np.where(kd == TERRA, 0.8, np.where(kd == WOOD, 0.82, 0.88)).astype(F)
    rough = lerp(rough, 0.95, sat(dustm + film)) + 0.02 * grain
    return dict(h=H.astype(F), col=col.astype(F), rough=rough.astype(F), opts=dict(ao_radius=0.10, ao_gain=1.0))
