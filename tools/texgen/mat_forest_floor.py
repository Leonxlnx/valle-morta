"""forest_floor - conifer needle litter, twigs, small cones, moss patches, dark humus."""
import numpy as np
from .core import *  # noqa: F401,F403
from .mat_grass_ground import _at


def build(c):
    n, T = c.n, c.tile
    r = c.rng("ff")
    grain = c.noise("grain", 0.01, None, H=-0.2)
    lump = c.noise("lump", 0.10, 0.012, H=0.6)
    humus_h = c.noise("und", 2.0, 0.25, H=1.0) * 0.010 + lump * 0.0035 + grain * 0.0006
    mf = c.noise("moss", 1.3, 0.03, H=0.75)
    moss = smoothstep(0.0, 0.45, mf - thresh_for_coverage(mf, 0.26))
    mb = np.abs(c.noise("mossb", 0.035, 0.005, H=0.3))
    mcush = c.fbm("mcush", 0.18, octaves=3, gain=0.55, mode="billow")
    base = humus_h + moss * (0.010 + 0.006 * mcush + 0.003 * mb)

    # --- needles
    NN = 300000
    x = r.random(NN)
    y = r.random(NN)
    dens = sat(0.75 + 0.25 * c.noise("nd", 0.8, 0.1)) * (1.0 - 0.62 * moss)
    keep = r.random(NN) < _at(dens, x, y)
    x, y = x[keep], y[keep]
    NN = len(x)
    flow = np.arctan2(c.noise("fl1", 0.8, 0.2), c.noise("fl2", 0.8, 0.2)).astype(F)
    th = _at(flow, x, y) * 0.5 + r.random(NN) * TAU
    L = r.uniform(0.011, 0.026, NN) / T
    nx1 = x + np.cos(th) * L
    ny1 = y + np.sin(th) * L
    nz = r.uniform(0.0, 0.011, NN).astype(F)
    tone = sat(r.random(NN) * 0.85 + 0.25 * (nz / 0.011) + r.normal(0, 0.05, NN))
    ncol = ramp(tone, [(0, (70, 48, 30)), (0.35, (108, 74, 44)), (0.7, (146, 106, 64)), (1, (176, 140, 92))])
    grey = r.random(NN) < 0.22
    ncol[grey] = ramp(tone[grey], [(0, (72, 64, 56)), (1, (136, 124, 108))])
    fresh = r.random(NN) < 0.035
    ncol[fresh] = ramp(tone[fresh], [(0, (58, 78, 36)), (1, (96, 112, 52))])
    order = np.argsort(nz, kind="stable")
    x, y, nx1, ny1, nz, ncol = x[order], y[order], nx1[order], ny1[order], nz[order], ncol[order]
    split = int(NN * 0.55)
    R = Raster(n, 2)
    ids = np.arange(1, NN + 1)
    wn = 0.0011 / T
    R.lines(x[:split], y[:split], nx1[:split], ny1[:split], wn, ids[:split])
    ez, ec, er = [], [], []
    nid = NN + 1
    # --- bark flakes / dead leaf bits
    for i in range(520):
        px, py = r.random(), r.random()
        k = r.integers(4, 7)
        a = np.sort(r.random(k)) * TAU
        rr = r.uniform(0.006, 0.022) / T * r.uniform(0.6, 1.0, k)
        st = r.uniform(0.5, 1.0)
        pts = np.stack([px + np.cos(a) * rr, py + np.sin(a) * rr * st], 1)
        R.polygon(pts, nid)
        ez.append(0.006 + 0.002 * r.random())
        ec.append(lerp(rgb(74, 56, 40), rgb(128, 98, 66), r.random()))
        er.append(0.88)
        nid += 1
    # --- twigs
    tw_first = nid
    for i in range(240):
        px, py, a = r.random(), r.random(), r.random() * TAU
        Lt = r.uniform(0.06, 0.42) ** 1.0 / T
        wt = r.uniform(0.003, 0.009) * (0.6 + 0.4 * Lt * T / 0.42) / T
        m = 7
        da = np.cumsum(r.normal(0, 0.10, m))
        seg = Lt / m
        qx = px + np.concatenate([[0], np.cumsum(np.cos(a + da) * seg)])
        qy = py + np.concatenate([[0], np.cumsum(np.sin(a + da) * seg)])
        R.polyline(np.stack([qx, qy], 1), wt, nid)
        if r.random() < 0.5:                                   # side branch
            j = r.integers(2, m - 1)
            b = a + da[j] + r.choice([-1, 1]) * r.uniform(0.5, 1.0)
            Lb = Lt * r.uniform(0.2, 0.45)
            R.polyline(np.array([[qx[j], qy[j]], [qx[j] + np.cos(b) * Lb, qy[j] + np.sin(b) * Lb]]), wt * 0.6, nid)
        ez.append(0.008 + wt * T * 0.9 + 0.004 * r.random())
        ec.append(lerp(rgb(70, 58, 48), rgb(124, 108, 92), r.random()))
        er.append(0.86)
        nid += 1
    tw_last = nid
    R.lines(x[split:], y[split:], nx1[split:], ny1[split:], wn, ids[split:])
    Zt = np.concatenate([[0.0], nz, np.array(ez, F)]).astype(F)
    Ct = np.concatenate([np.zeros((1, 3), F), ncol, np.array(ec, F).reshape(-1, 3)]).astype(F)
    Rt = np.concatenate([[0.0], np.full(NN, 0.76, F), np.array(er, F)]).astype(F)
    Mt = np.ones(len(Zt), F)
    Mt[0] = 0
    Tw = np.zeros(len(Zt), F)
    Tw[tw_first:tw_last] = 1.0
    idm = R.ids()
    cover = R.resolve(Mt, idm)
    zb = R.resolve(Zt, idm)
    cb = R.resolve(Ct, idm)
    rb = R.resolve(Rt, idm)
    twig = R.resolve(Tw, idm)
    del R, idm
    h = base + zb
    # twig bark texture
    tb = c.noise("tbark", 0.012, 0.003, H=0.2)
    h += twig * tb * 0.0006
    # --- cones
    NCn = 70
    cx, cy = r.random(NCn), r.random(NCn)
    crad = r.uniform(0.016, 0.03, NCn)
    casp = r.uniform(1.5, 2.2, NCn)
    cang = r.random(NCn) * TAU
    CH = np.full((n, n), -1.0, F)
    CID = np.full((n, n), -1, np.int32)
    fn = blob_fn(cang, casp, crad / casp * 0.9, r.uniform(0, 0.03, (NCn, 4)), r.random((NCn, 4)) * TAU,
                 p=2.2, q=0.55, size=0.9)
    stamp(CH, cx, cy, crad / 0.9 / T, fn, ID=CID)
    cone = CID >= 0
    ci = np.clip(CID, 0, NCn - 1)
    du = wrapd(c.x - cx[ci].astype(F)) * T
    dv = wrapd(c.y - cy[ci].astype(F)) * T
    al = du * np.cos(cang[ci]).astype(F) + dv * np.sin(cang[ci]).astype(F)
    ac = -du * np.sin(cang[ci]).astype(F) + dv * np.cos(cang[ci]).astype(F)
    sc = 0.5 + 0.5 * np.sin((al + ac * 0.6) / 0.0052 * TAU / 2) * np.sin((al - ac * 0.6) / 0.0052 * TAU / 2)
    cone_h = np.where(cone, CH * (0.75 + 0.25 * sc), 0.0)
    hc = base + 0.006 + cone_h
    use = cone & (hc > h)
    h = np.where(use, hc, h)
    h = blur(h, 0.6)

    # --- albedo
    hcol = ramp(sat(0.45 + 0.22 * lump + 0.12 * grain + 0.1 * c.noise("hc", 0.5, 0.05)),
                [(0, (30, 24, 20)), (0.5, (48, 38, 30)), (1, (74, 58, 44))])
    mcol = ramp(sat(0.2 + 0.9 * mb + 0.25 * mcush + 0.1 * grain),
                [(0, (24, 34, 14)), (0.4, (44, 62, 24)), (0.75, (70, 88, 34)), (1, (104, 114, 50))])
    col = mix(hcol, mcol, moss)
    lit = cb / (cover[..., None] + 1e-4)
    zn = sat(zb / (cover + 1e-4) / 0.012)
    lit = lit * (0.82 + 0.18 * zn)[..., None]
    lit = lit * (1.0 + 0.10 * twig * tb)[..., None]
    col = col * (1 - cover)[..., None] + lit * cover[..., None]
    ccol = lerp(rgb(66, 48, 34), rgb(126, 96, 66), sc[..., None]) * (0.9 + 0.2 * c.rng("cc").random(NCn).astype(F)[ci])[..., None]
    col = np.where(use[..., None], ccol, col)
    col = col * (1.0 + 0.05 * c.noise("val", 0.8, 0.06, H=0.6))[..., None]
    cav = sat(-c.curv(h, 0.012) / 0.006)
    col = mix(col, col * 0.72, cav * 0.35)
    rough = lerp(lerp(0.95, 0.96, moss), rb / (cover + 1e-4), cover)
    rough = np.where(use, 0.8, rough) + 0.02 * grain
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F),
                opts=dict(nstrength=0.9, ao_radius=0.03, ao_gain=0.9))
