"""grass_ground - meadow turf from above (sits under real 3D blades): short
dense grass, matted dry straw, clover / small leaves, bits of soil."""
import numpy as np
from .core import *  # noqa: F401,F403


def _at(a, x, y):
    n = a.shape[0]
    return a[(y * n).astype(np.int64) % n, (x * n).astype(np.int64) % n]


def blades(c, tag, count, length, width, spread, flow, accept, curl=0.5, nseg=4):
    """Generate curved blades. Returns per-segment arrays (x0,y0,x1,y1,w,t,blade)."""
    r = c.rng(tag)
    T = c.tile
    x = r.random(count * 2)
    y = r.random(count * 2)
    keep = r.random(count * 2) < _at(accept, x, y)
    x, y = x[keep][:count], y[keep][:count]
    N = len(x)
    th = _at(flow, x, y) + r.normal(0, spread, N)
    L = r.uniform(length[0], length[1], N) / T
    kap = r.normal(0, curl, N)
    w = r.uniform(width[0], width[1], N) / T
    ts = np.linspace(0, 1, nseg + 1)
    dx, dy = np.cos(th), np.sin(th)
    px = x[:, None] + L[:, None] * (ts[None, :] * dx[:, None] - kap[:, None] * ts[None, :] ** 2 * dy[:, None])
    py = y[:, None] + L[:, None] * (ts[None, :] * dy[:, None] + kap[:, None] * ts[None, :] ** 2 * dx[:, None])
    tm = (ts[:-1] + ts[1:]) * 0.5
    seg = dict(x0=px[:, :-1].ravel(), y0=py[:, :-1].ravel(), x1=px[:, 1:].ravel(), y1=py[:, 1:].ravel(),
               w=(w[:, None] * (1.0 - 0.55 * tm[None, :] ** 1.5)).ravel(),
               t=np.broadcast_to(tm[None, :], (N, nseg)).ravel().astype(F),
               blade=np.repeat(np.arange(N), nseg), n=N, rnd=r.random((N, 4)).astype(F))
    return seg


def build(c):
    n, T = c.n, c.tile
    grain = c.noise("grain", 0.01, None, H=-0.2)
    soil_h = c.noise("und", 2.0, 0.25, H=1.0) * 0.008 + c.noise("clod", 0.07, 0.01, H=0.6) * 0.0028 + grain * 0.0005
    dens = sat(0.62 + 0.3 * c.noise("dens", 0.9, 0.12, H=0.7))
    bare = smoothstep(1.6, 2.5, c.noise("bare", 1.0, 0.2, H=0.9))
    acc = sat(dens * (1.0 - 0.85 * bare))
    flow = np.arctan2(c.noise("fl1", 1.2, 0.3), c.noise("fl2", 1.2, 0.3)).astype(F)
    drym = sat(0.5 + 0.45 * c.noise("drym", 1.5, 0.2))          # where dead thatch dominates

    G = blades(c, "green", 120000, (0.035, 0.11), (0.0024, 0.0048), 1.3, flow, acc, curl=0.45)
    S = blades(c, "straw", 64000, (0.07, 0.24), (0.0016, 0.0032), 0.55, flow, sat(acc * (0.3 + 1.0 * drym)), curl=0.3)
    D = blades(c, "dead", 14000, (0.04, 0.12), (0.002, 0.004), 1.2, flow, acc, curl=0.5)
    r = c.rng("attr")

    def seg_attr(B, z0, rise, ramp_stops, tipdry=0.0):
        nb = B["n"]
        zb = r.uniform(z0[0], z0[1], nb)
        rs = r.uniform(rise[0], rise[1], nb)
        z = zb[B["blade"]] + rs[B["blade"]] * B["t"] ** 0.8
        tone = sat(B["rnd"][B["blade"], 0] * 0.8 + 0.2 * B["t"] + r.normal(0, 0.05, len(z)))
        colr = ramp(tone, ramp_stops)
        colr *= (0.80 + 0.20 * B["t"])[:, None]
        if tipdry:
            dry = sat((B["t"] - 0.55) * 2.5) * (B["rnd"][B["blade"], 1] < tipdry)
            colr = colr + (rgb(150, 132, 84) - colr) * dry[:, None] * 0.8
        return z.astype(F), colr.astype(F)

    gz, gc = seg_attr(G, (0.002, 0.012), (0.004, 0.022),
                      [(0, (50, 64, 32)), (0.35, (70, 88, 42)), (0.7, (94, 108, 52)), (1, (120, 126, 66))], tipdry=0.25)
    sz, sc = seg_attr(S, (0.002, 0.022), (0.0, 0.008),
                      [(0, (124, 106, 68)), (0.5, (164, 146, 100)), (1, (196, 180, 134))])
    dz, dc = seg_attr(D, (0.001, 0.008), (0.0, 0.01),
                      [(0, (66, 54, 36)), (0.5, (92, 76, 50)), (1, (116, 98, 62))])
    X0 = np.concatenate([G["x0"], S["x0"], D["x0"]])
    Y0 = np.concatenate([G["y0"], S["y0"], D["y0"]])
    X1 = np.concatenate([G["x1"], S["x1"], D["x1"]])
    Y1 = np.concatenate([G["y1"], S["y1"], D["y1"]])
    W = np.concatenate([G["w"], S["w"], D["w"]])
    Z = np.concatenate([gz, sz, dz])
    C = np.concatenate([gc, sc, dc])
    RG = np.concatenate([np.full(len(gz), 0.66, F), np.full(len(sz), 0.84, F), np.full(len(dz), 0.86, F)])
    order = np.argsort(Z, kind="stable")
    X0, Y0, X1, Y1, W, Z, C, RG = X0[order], Y0[order], X1[order], Y1[order], W[order], Z[order], C[order], RG[order]
    ns = len(Z)
    # clover + small broad leaves, drawn between the lower and the upper blades
    split = int(ns * 0.62)
    zsplit = float(Z[split])
    R = Raster(n, 2)
    ids = np.arange(1, ns + 1)
    R.lines(X0[:split], Y0[:split], X1[:split], Y1[:split], W[:split], ids[:split])
    ex_z, ex_c, ex_r = [], [], []
    nid = ns + 1
    rc = c.rng("clover")
    ncl = 2600
    cx, cy = rc.random(ncl * 2), rc.random(ncl * 2)
    cm = smoothstep(0.0, 1.2, c.noise("clov", 1.0, 0.2))
    keep = rc.random(ncl * 2) < _at(cm * acc, cx, cy)
    cx, cy = cx[keep][:ncl], cy[keep][:ncl]
    for i in range(len(cx)):
        a0 = rc.random() * TAU
        rl = rc.uniform(0.0045, 0.0085) / T
        tone = rc.random()
        colc = lerp(rgb(52, 84, 38), rgb(92, 122, 58), tone)
        for j in range(3):
            a = a0 + j * TAU / 3
            R.ellipse(cx[i] + np.cos(a) * rl * 0.95, cy[i] + np.sin(a) * rl * 0.95, rl, rl, nid)
            ex_z.append(zsplit + 0.001 + 0.002 * tone)
            ex_c.append(colc * rc.uniform(0.9, 1.1))
            ex_r.append(0.6)
            nid += 1
    nlf = 420
    lx, ly = rc.random(nlf), rc.random(nlf)
    for i in range(nlf):
        if rc.random() > _at(acc, lx[i:i + 1], ly[i:i + 1])[0]:
            continue
        a = rc.random() * TAU
        L = rc.uniform(0.02, 0.055) / T
        wl = L * rc.uniform(0.22, 0.4)
        t = np.linspace(0, 1, 9)
        prof = np.sin(np.pi * t) ** 0.8 * wl
        ax, ay = np.cos(a), np.sin(a)
        pts = np.concatenate([np.stack([lx[i] + t * L * ax - prof * ay, ly[i] + t * L * ay + prof * ax], 1),
                              np.stack([lx[i] + t * L * ax + prof * ay, ly[i] + t * L * ay - prof * ax], 1)[::-1]])
        R.polygon(pts, nid)
        dead = rc.random() < 0.3
        ex_z.append(zsplit + 0.0015)
        ex_c.append((rgb(120, 98, 60) if dead else lerp(rgb(58, 86, 36), rgb(96, 118, 50), rc.random())) * rc.uniform(0.9, 1.1))
        ex_r.append(0.8 if dead else 0.62)
        nid += 1
    R.lines(X0[split:], Y0[split:], X1[split:], Y1[split:], W[split:], ids[split:])
    Zt = np.concatenate([[0.0], Z, np.array(ex_z, F)]).astype(F)
    Ct = np.concatenate([np.zeros((1, 3), F), C, np.array(ex_c, F).reshape(-1, 3)]).astype(F)
    Rt = np.concatenate([[0.0], RG, np.array(ex_r, F)]).astype(F)
    Mt = np.ones(len(Zt), F)
    Mt[0] = 0.0
    idm = R.ids()
    cover = R.resolve(Mt, idm)
    zb = R.resolve(Zt, idm)
    cb = R.resolve(Ct, idm)
    rb = R.resolve(Rt, idm)
    del R, idm

    h = soil_h + zb
    h = blur(h, 0.6)
    zn = sat(zb / (cover + 1e-4) / 0.022)
    # soil colour
    scol = ramp(sat(0.5 + 0.22 * c.noise("sc", 0.4, 0.02, H=0.5) + 0.12 * grain),
                [(0, (40, 32, 26)), (0.5, (62, 50, 39)), (1, (90, 74, 56))])
    col = cb / (cover[..., None] + 1e-4)
    col = col * (0.80 + 0.20 * zn)[..., None]                       # lower blades a touch darker
    hue = c.noise("hue", 1.4, 0.2, H=0.8)
    col = col * (1.0 + np.array([0.035, 0.0, -0.03], F) * hue[..., None])
    col = col * (1.0 + 0.04 * c.noise("val", 0.6, 0.05, H=0.6) + 0.03 * grain)[..., None]
    col = scol * (1 - cover)[..., None] + col * cover[..., None]
    rough = lerp(0.93, rb / (cover + 1e-4), cover) + 0.02 * grain
    return dict(h=h.astype(F), col=col.astype(F), rough=rough.astype(F),
                opts=dict(nstrength=0.8, ao_radius=0.02, ao_gain=0.9))
