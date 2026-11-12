# Procedural PBR surfacing for the rifle / hands atlases from baked geometry maps
# (position, normal, bevel-normal curvature, AO, part id). numpy/scipy/PIL only.
import numpy as np, json, sys, os, time
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

f4 = np.float32
D = sys.argv[1]; T0 = time.time()
STEEL, MAGS, BOLT, WOOD, GRIPW, FABRIC, LEATHER, PAD, SLEEVE, CUFF, BRASS, FABRIC2, HEM, VENT = range(1, 15)


def ss(a, b, x): t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
def mix(a, b, t): return a + (b - a) * t
def mixc(a, b, t): return a + (np.asarray(b, f4) - a) * t[:, None]


def hash3(i, seed):
    x = i[:, 0].astype(np.uint32); y = i[:, 1].astype(np.uint32); z = i[:, 2].astype(np.uint32)
    h = x * np.uint32(0x8da6b343) + y * np.uint32(0xd8163841) + z * np.uint32(0xcb1ab31f) + np.uint32((seed * 0x9e3779b9) & 0xffffffff)
    h ^= h >> np.uint32(15); h *= np.uint32(0x2c1b3c6d); h ^= h >> np.uint32(12); h *= np.uint32(0x297a2d39); h ^= h >> np.uint32(15)
    return (h >> np.uint32(8)).astype(f4) * f4(1.0 / 16777216.0)


def vnoise(p, seed):
    i = np.floor(p).astype(np.int64); f = (p - i).astype(f4); f = f * f * (3 - 2 * f); out = np.zeros(len(p), f4)
    for dx in (0, 1):
        wx = f[:, 0] if dx else 1 - f[:, 0]
        for dy in (0, 1):
            wy = wx * (f[:, 1] if dy else 1 - f[:, 1])
            for dz in (0, 1):
                out += wy * (f[:, 2] if dz else 1 - f[:, 2]) * hash3(i + np.array([dx, dy, dz]), seed)
    return out


def fbm(p, freq, octs=4, seed=0, gain=0.5):
    q = p * np.asarray(freq, f4); a = 1.0; s = 0.0; out = np.zeros(len(p), f4)
    for o in range(octs):
        out += a * vnoise(q, seed + o * 17); s += a; a *= gain; q = q * 2.03
    return out / s


def tri(p, n, fn):
    w = np.abs(n) ** 4 + 1e-6; w /= w.sum(1, keepdims=True)
    return w[:, 0] * fn(p[:, 1], p[:, 2]) + w[:, 1] * fn(p[:, 0], p[:, 2]) + w[:, 2] * fn(p[:, 0], p[:, 1])


def plain(per): return lambda a, b: 0.5 + 0.5 * np.sin(2 * np.pi * a / per) * np.sin(2 * np.pi * b / per)
def twill(per): return lambda a, b: 0.5 + 0.5 * np.sin(2 * np.pi * (a + b) / per) * (0.6 + 0.4 * np.sin(2 * np.pi * (a - b) / (per * 0.5)))


# ------------------------------------------------------------------ materials
def m_steel(p, n, e, a, g, tag, scr, xw, kind):
    lf = fbm(p, 1 / 40., 3, 1); mf = fbm(p, 1 / 7., 4, 2); hf = fbm(p, 1 / 0.8, 2, 3); pt = fbm(p, 1 / 16., 4, 4)
    cav = np.clip(1 - a, 0, 1); M = len(p)
    c = np.tile(np.array([0.185, 0.19, 0.21], f4), (M, 1))
    c = mixc(c, (0.26, 0.225, 0.21), ss(0.45, 0.75, lf) * 0.6); c *= (0.80 + 0.40 * mf)[:, None]; c *= (0.88 + 0.24 * g)[:, None]
    r = 0.47 + 0.24 * (mf - 0.5) + 0.12 * (lf - 0.5) - 0.15 * ss(0.56, 0.72, pt)
    mt = np.full(M, 0.85, f4)
    wk = 1.6 if kind == 'mag' else 1.0
    wf = ss(0.32, 0.72, fbm(p, 1 / 24., 3, 12))
    w = ss(0.14, 0.42, e * (0.2 + 1.2 * mf) * (0.3 + 1.1 * wf)) * ss(0.45, 0.8, a) + wk * 0.7 * ss(0.66, 0.82, pt + 0.1 * (wk - 1)) * ss(0.3, 0.7, hf + 0.4 * mf - 0.2) * wf
    thin = np.clip(ss(0.03, 0.25, e) * (0.25 + 0.5 * wf) + ss(0.5, 0.75, pt) * 0.35, 0, 1)      # thinned finish, grey halo
    c = mixc(c, (0.30, 0.30, 0.315), thin * 0.6)
    sc2 = scr * ss(0.45, 0.7, fbm(p, 1 / 25., 2, 6))
    w = np.clip(w + xw + sc2 * 0.55, 0, 1)
    c = mixc(c, np.array([0.50, 0.495, 0.49], f4) * (0.8 + 0.35 * hf)[:, None], w)
    r = mix(r, 0.28 + 0.14 * hf, w); mt = mix(mt, 1.0, w)
    ru = np.clip(ss(0.64, 0.80, fbm(p, 1 / 4.5, 4, 9)) * ss(0.48, 0.72, fbm(p, 1 / 35., 3, 10)) * (0.35 + 0.9 * cav + 0.6 * w), 0, 1)
    c = mixc(c, np.array([0.30, 0.165, 0.09], f4) * (0.7 + 0.6 * hf)[:, None], ru); r = mix(r, 0.82, ru); mt = mix(mt, 0.15, ru)
    du = np.clip(ss(0.18, 0.6, cav) * (0.4 + 0.7 * mf) + 0.12 * ss(0.6, 0.95, n[:, 2]) * lf, 0, 0.85)
    c = mixc(c, (0.31, 0.28, 0.23), du); r = mix(r, 0.88, du); mt = mt * (1 - du)
    h = 0.012 * (hf - 0.5) + 0.01 * (mf - 0.5) - 0.012 * w + 0.015 * ru - 0.012 * sc2
    return c, r, mt, h


def m_bolt(p, n, e, a, g, tag, scr, xw):
    mf = fbm(p, 1 / 7., 3, 2); st = fbm(p, (1 / 0.6, 1 / 60., 1 / 0.6), 3, 31); cav = np.clip(1 - a, 0, 1)
    c = np.array([0.55, 0.55, 0.54], f4) * (0.78 + 0.25 * mf + 0.22 * st)[:, None]
    r = 0.33 + 0.16 * (st - 0.5) + 0.1 * (mf - 0.5); mt = np.ones(len(p), f4)
    gr = np.clip(ss(0.5, 0.75, fbm(p, 1 / 9., 4, 32)) * (0.45 + cav) + 0.6 * ss(0.3, 0.7, cav), 0, 1)
    c = mixc(c, (0.06, 0.055, 0.05), gr * 0.9); r = mix(r, 0.7, gr); mt = mix(mt, 0.3, gr)
    return c, r, mt, 0.012 * (st - 0.5) - 0.015 * scr


def m_brass(p, n, e, a):
    mf = fbm(p, 1 / 5., 3, 61)
    c = np.array([0.78, 0.58, 0.28], f4) * (0.72 + 0.45 * mf)[:, None]
    return c, 0.3 + 0.25 * mf, np.ones(len(p), f4), np.zeros(len(p), f4)


def m_wood(p, n, e, a, tag, grip):
    q = p.copy(); M = len(p)
    if grip:
        y = q[:, 1] * -0.342 + q[:, 2] * -0.940; z = q[:, 1] * 0.940 + q[:, 2] * -0.342; q[:, 1] = y; q[:, 2] = z
    warp = fbm(q, (1 / 28., 1 / 170., 1 / 28.), 3, 21)
    ply = (q[:, 0] + (warp - 0.5) * 7.0 + 0.5 * fbm(q, (1 / 5., 1 / 50., 1 / 5.), 2, 22)) / 1.5
    pi_ = np.floor(ply); pf = ply - pi_
    tone = np.abs(np.modf(np.sin(pi_ * 12.9898) * 43758.5453)[0]).astype(f4)
    glue = 1 - ss(0.0, 0.14, pf) * ss(0.0, 0.14, 1 - pf)
    grain = fbm(q, (1 / 1.1, 1 / 50., 1 / 1.1), 4, 23); streak = fbm(q, (1 / 4., 1 / 140., 1 / 4.), 3, 24)
    t = np.clip(0.2 + 0.45 * tone + 0.5 * (streak - 0.5) + 0.35 * (grain - 0.5), 0, 1)
    c = mixc(np.tile(np.array([0.36, 0.155, 0.065], f4), (M, 1)), (0.66, 0.37, 0.17), t)
    c *= (1 - 0.5 * glue)[:, None]
    pores = ss(0.66, 0.78, fbm(q, (1 / 0.6, 1 / 9., 1 / 0.6), 2, 25)); c *= (1 - 0.3 * pores)[:, None]
    hw = np.full(M, 0.7 if grip else 0.35, f4)
    hw = np.where(tag == 5, 0.25 + 0.5 * ss(25, 42, p[:, 2]) + 0.5 * ss(-250, -292, p[:, 1]), hw)
    hw = np.where(tag == 6, 0.6, hw)
    wn = fbm(q, 1 / 26., 4, 26)
    wear = np.clip(ss(0.08, 0.30, e * (0.5 + 1.0 * grain)) + ss(0.66 - 0.25 * hw, 0.88 - 0.25 * hw, wn + 0.15 * (grain - 0.5)), 0, 1)
    raw = c * 0.5 + np.array([0.50, 0.40, 0.29], f4) * 0.52
    c = mixc(c, raw, wear * 0.85)
    r = mix(0.30 + 0.12 * (streak - 0.5) + 0.08 * pores, 0.66 + 0.1 * (grain - 0.5), wear)
    cav = np.clip(1 - a, 0, 1)
    dirt = np.clip(ss(0.15, 0.55, cav) * 0.8 + 0.5 * hw * ss(0.55, 0.8, fbm(q, 1 / 9., 3, 27)) * wear, 0, 0.9)
    c = mixc(c, (0.10, 0.075, 0.055), dirt); r = mix(r, 0.8, dirt)
    dent = ss(0.80, 0.90, fbm(q, 1 / 3.5, 3, 28)) * ss(0.45, 0.6, fbm(q, 1 / 30., 2, 29)); c *= (1 - 0.25 * dent)[:, None]
    h = 0.025 * (grain - 0.5) - 0.03 * pores - 0.14 * dent - 0.02 * glue * wear
    return c, r, np.zeros(M, f4), h


def stitches(c, r, h, p, sm):
    dash = (np.sin(2 * np.pi * (p[:, 0] + p[:, 1] + p[:, 2]) / 2.6) > -0.3).astype(f4)
    st = ss(0.52, 0.62, sm) * (1 - ss(0.76, 0.86, sm)) * dash; gro = ss(0.9, 1.0, sm)
    c = mixc(c, (0.40, 0.38, 0.28), st * 0.9); c = c * (1 - 0.55 * gro)[:, None]
    return c, r, np.zeros(len(p), f4), h + 0.12 * st - 0.16 * gro


def m_cloth(p, n, e, a, sm, base, per, rg, kind):
    wv = tri(p, n, twill(per) if kind == 'sleeve' else plain(per))
    lf = fbm(p, 1 / 35., 3, 41); mf = fbm(p, 1 / 6., 3, 42); hf = fbm(p, 1 / 0.8, 2, 43); cav = np.clip(1 - a, 0, 1)
    c = np.asarray(base, f4) * (0.74 + 0.34 * wv + 0.3 * (lf - 0.5) + 0.22 * (hf - 0.5))[:, None]
    stain = ss(0.55, 0.75, fbm(p, 1 / 22., 4, 44)); c = c * (1 - 0.3 * stain)[:, None]
    dust = np.clip(0.35 * ss(0.5, 0.9, n[:, 2]) * mf + 0.25 * ss(0.2, 0.6, cav), 0, 1); c = mixc(c, (0.42, 0.39, 0.33), dust * 0.6)
    wm = ss(0.12, 0.35, e * (0.6 + 0.8 * mf)); c = mixc(c, c * 1.35 + 0.03, wm * 0.6)
    return stitches(c, rg + 0.08 * (hf - 0.5), 0.09 * (wv - 0.5) + 0.03 * (hf - 0.5), p, sm)


def m_leather(p, n, e, a, sm):
    cr = fbm(p, 1 / 2.2, 3, 51); rid = 1 - np.abs(2 * cr - 1); lf = fbm(p, 1 / 30., 3, 52); hf = fbm(p, 1 / 0.6, 2, 53)
    c = np.array([0.215, 0.155, 0.105], f4) * (0.75 + 0.5 * lf + 0.2 * (hf - 0.5))[:, None]
    crease = ss(0.86, 0.97, rid); c = c * (1 - 0.35 * crease)[:, None]
    wm = np.clip(ss(0.12, 0.35, e * (0.6 + 0.8 * cr)) + ss(0.6, 0.8, fbm(p, 1 / 12., 3, 54)) * 0.6, 0, 1); c = mixc(c, (0.42, 0.33, 0.24), wm * 0.55)
    dirt = ss(0.2, 0.6, 1 - a); c = mixc(c, (0.07, 0.06, 0.05), dirt * 0.6)
    return stitches(c, 0.6 + 0.14 * (hf - 0.5) - 0.12 * wm, -0.07 * crease + 0.02 * (hf - 0.5), p, sm)


def m_pad(p, n, e, a, sm, strap):
    hf = fbm(p, 1 / 0.8, 2, 71); mf = fbm(p, 1 / 6., 3, 72); wv = tri(p, n, plain(1.1 if strap else 2.4))
    c = np.array([0.075, 0.075, 0.07] if strap else [0.062, 0.062, 0.068], f4) * (0.8 + 0.4 * hf + (0.3 * wv if strap else 0))[:, None]
    wm = ss(0.1, 0.32, e * (0.6 + 0.8 * mf)); c = mixc(c, (0.2, 0.2, 0.2), wm * 0.7)
    dust = ss(0.25, 0.65, 1 - a) * 0.5 + 0.2 * ss(0.5, 0.9, n[:, 2]) * mf; c = mixc(c, (0.36, 0.33, 0.28), dust * 0.6)
    return c, (0.78 if strap else 0.5) + 0.1 * (mf - 0.5), np.zeros(len(p), f4), 0.05 * (wv - 0.5)


# ------------------------------------------------------------------ helpers for stamped decals
def stamp_text(u, v, box, items, res=0.08):
    u0, u1, v0, v1 = box; W = int((u1 - u0) / res); H = int((v1 - v0) / res)
    im = Image.new('L', (W, H), 0); d = ImageDraw.Draw(im)
    for txt, tu, tv, hm in items:
        px = int(hm / res * 1.35)
        try: font = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', px)
        except Exception: font = ImageFont.load_default()
        if txt == '^':
            x = (tu - u0) / res; y = (v1 - tv) / res; s = hm / res
            d.polygon([(x, y), (x + s, y), (x + s / 2, y - s)], outline=255, width=max(2, int(s / 7))); d.line([(x + s / 2, y - s * 0.15), (x + s / 2, y - s * 0.7)], fill=255, width=max(2, int(s / 7)))
        else:
            d.text(((tu - u0) / res, (v1 - tv) / res - px), txt, font=font, fill=255)
    A = ndi.gaussian_filter(np.asarray(im, f4) / 255.0, 0.9)
    ix = ((u - u0) / res).astype(np.int64); iy = ((v1 - v) / res).astype(np.int64)
    ok = (ix >= 0) & (ix < W) & (iy >= 0) & (iy < H); out = np.zeros(len(u), f4); out[ok] = A[iy[ok], ix[ok]]
    return out


def sd_rbox(y, z, cy, cz, hy, hz, r):
    qy = np.abs(y - cy) - (hy - r); qz = np.abs(z - cz) - (hz - r)
    return np.sqrt(np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2) + np.minimum(np.maximum(qy, qz), 0) - r


def scratch_image(H, W, seed, count):
    im = Image.new('L', (W, H), 0); d = ImageDraw.Draw(im); rs = np.random.RandomState(seed)
    for i in range(count):
        x = rs.rand() * W; y = rs.rand() * H; L = rs.gamma(2.0, 20.0) + 5; th = rs.rand() * np.pi
        d.line((x, y, x + L * np.cos(th), y + L * np.sin(th)), fill=int(50 + 205 * rs.rand() ** 2), width=1)
    a = np.asarray(im, f4) / 255.0
    return np.maximum(a, ndi.gaussian_filter(a, 0.6) * 1.2).clip(0, 1)


# ------------------------------------------------------------------ atlas
def run(an):
    meta = json.load(open(os.path.join(D, an + '_meta.json'))); bmin = np.array(meta['bmin'], f4); bmax = np.array(meta['bmax'], f4)
    L = lambda s: np.load(os.path.join(D, an + '_' + s + '.npy')).astype(f4)
    pidi = L('pid'); H, W = pidi.shape[:2]; valid = pidi[..., 0] > 0.4 / 32
    iy, ix = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    P = (bmin + L('pos')[iy, ix] * (bmax - bmin)) * 1000.0
    N = L('nrm')[iy, ix] * 2 - 1; N /= np.maximum(np.linalg.norm(N, axis=2, keepdims=True), 1e-4)
    BV = L('bev')[iy, ix] * 2 - 1; BV /= np.maximum(np.linalg.norm(BV, axis=2, keepdims=True), 1e-4)
    edge = np.linalg.norm(BV - N, axis=2).astype(f4)
    vf = valid.astype(f4); nrmz = np.maximum(ndi.gaussian_filter(vf, 1.0), 1e-3)
    ao = ndi.gaussian_filter(L('ao')[..., 0] * vf, 1.0) / nrmz; edge = ndi.gaussian_filter(edge * vf, 0.8) / np.maximum(ndi.gaussian_filter(vf, 0.8), 1e-3)
    vi = np.nonzero(valid); M = len(vi[0])
    p = P[vi]; n = N[vi]; e = edge[vi]; a = np.clip(ao[vi], 0, 1)
    pid = np.rint(pidi[..., 0][vi] * 32).astype(np.int32); g = pidi[..., 1][vi]; tag = np.rint(pidi[..., 2][vi] * 32).astype(np.int32)
    print(an, 'texels', M, 'cover %.2f' % (M / (H * W)), 'edge pct', np.percentile(e, [50, 90, 97, 99.5]).round(3), 'ao pct', np.percentile(a, [5, 50, 95]).round(2), flush=True)
    col = np.zeros((M, 3), f4); rough = np.full(M, 0.5, f4); metal = np.zeros(M, f4); hgt = np.zeros(M, f4)
    scr = scratch_image(H, W, 5, 1400)[vi]; xw = np.zeros(M, f4); stamp = np.zeros(M, f4)
    x, y, z = p[:, 0], p[:, 1], p[:, 2]

    def put(m, res):
        c, r, mt, h = res; col[m] = c; rough[m] = r; metal[m] = mt; hgt[m] = h

    if an == 'rifle':
        Ls = (tag == 1) & (n[:, 0] < -0.8); Rs = (tag == 1) & (n[:, 0] > 0.8)
        stamp[Ls] = stamp_text(-y[Ls], z[Ls], (-186, -140, 6, 44), [('^', -183, 33, 5.0), ('1976', -176, 33.5, 3.4), ('КН 4831', -183, 26, 3.4)])
        stamp[Rs] = stamp_text(y[Rs], z[Rs], (72, 92, 0, 34), [('АВ', 75, 19, 3.6), ('ОД', 75, 3.5, 3.6)])
        dim = np.zeros(M, f4)
        for m in (Ls, Rs):   # magazine-well dimples
            sd = sd_rbox(y[m], z[m], 108, 22, 19, 6.5, 6.0); dim[m] = 0
            xw[m] += 0.5 * np.exp(-(sd / 0.7) ** 2)
        rr = np.hypot(y + 28, z - 30); ang = np.degrees(np.arctan2(z - 30, y + 28))
        arc = Rs & (ang > -34) & (ang < 6)
        xw[arc] += np.exp(-((rr[arc] - 97.5) / 1.0) ** 2) * (0.5 + 0.8 * fbm(p[arc], 1 / 3., 2, 77))
        leaf = (tag == 2) & (n[:, 2] > 0.6)
        tick = np.zeros(M, f4)
        for k in range(9): tick[leaf] = np.maximum(tick[leaf], np.exp(-((y[leaf] - (164 + 5.6 * k)) / 0.22) ** 2) * (np.abs(x[leaf]) > 1.2))
        stamp = np.maximum(stamp, tick)
        xw[tag == 4] += 0.35 * ss(-90, -5, z[tag == 4]) * ss(0.4, 0.7, fbm(p[tag == 4], (1 / 1.2, 1 / 30., 1 / 30.), 3, 78))
        for pidv, kind in ((STEEL, 'steel'), (MAGS, 'mag')):
            m = pid == pidv
            if m.any(): put(m, m_steel(p[m], n[m], e[m], a[m], g[m], tag[m], scr[m], xw[m], kind))
        m = pid == BOLT
        if m.any(): put(m, m_bolt(p[m], n[m], e[m], a[m], g[m], tag[m], scr[m], xw[m]))
        m = pid == BRASS
        if m.any(): put(m, m_brass(p[m], n[m], e[m], a[m]))
        for pidv, grip in ((WOOD, False), (GRIPW, True)):
            m = pid == pidv
            if m.any(): put(m, m_wood(p[m], n[m], e[m], a[m], tag[m], grip))
        m = pid == VENT
        if m.any():
            hf = fbm(p[m], 1 / 1.0, 2, 80); put(m, (np.array([0.07, 0.05, 0.035], f4) * (0.6 + 0.8 * hf)[:, None], 0.85 + 0 * hf, 0 * hf, 0.03 * hf))
        hgt += dim - 0.16 * stamp
        col *= (1 - 0.5 * stamp)[:, None]; rough = mix(rough, 0.8, stamp * 0.7); metal *= (1 - 0.5 * stamp)
        inner = tag == 21; col[inner & (pid == STEEL)] *= 0.6
    else:
        sm = g
        m = (pid == FABRIC) | (pid == FABRIC2)
        if m.any(): put(m, m_cloth(p[m], n[m], e[m], a[m], sm[m], (0.27, 0.28, 0.22), 1.3, 0.88, 'glove'))
        m = (pid == SLEEVE) | (pid == HEM)
        if m.any(): put(m, m_cloth(p[m], n[m], e[m], a[m], sm[m], (0.31, 0.33, 0.21), 1.7, 0.92, 'sleeve'))
        m = pid == LEATHER
        if m.any(): put(m, m_leather(p[m], n[m], e[m], a[m], sm[m]))
        for pidv, strap in ((PAD, False), (CUFF, True)):
            m = pid == pidv
            if m.any(): put(m, m_pad(p[m], n[m], e[m], a[m], sm[m], strap))
    col *= (0.68 + 0.32 * a ** 0.8)[:, None]
    # ---- images
    def img(vals, ch):
        o = np.zeros((H, W, ch), f4) if ch > 1 else np.zeros((H, W), f4); o[vi] = vals; return o[iy, ix]
    hgt *= 3.0 if an == 'rifle' else 1.6
    Hh = ndi.gaussian_filter(img(hgt, 1), 0.55)
    du = np.linalg.norm(np.roll(P, -1, 1) - np.roll(P, 1, 1), axis=2) / 2; dv = np.linalg.norm(np.roll(P, -1, 0) - np.roll(P, 1, 0), axis=2) / 2
    med = float(np.median(du[valid])); du = np.clip(du, 0.6 * med, 3 * med); dv = np.clip(dv, 0.6 * med, 3 * med)
    gx = np.clip((np.roll(Hh, -1, 1) - np.roll(Hh, 1, 1)) / 2 / du, -1.2, 1.2); gy = np.clip((np.roll(Hh, -1, 0) - np.roll(Hh, 1, 0)) / 2 / dv, -1.2, 1.2)
    nz = 1 / np.sqrt(1 + gx * gx + gy * gy); nm = np.stack([-gx * nz, -gy * nz, nz], 2) * 0.5 + 0.5
    orm = np.stack([np.clip(img(a, 1), 0.12, 1), np.clip(img(rough, 1), 0.08, 1), np.clip(img(metal, 1), 0, 1)], 2)
    def save(arr, suf):
        Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)[::-1]).save(os.path.join(D, an + '_' + suf + '.png'))
    save(img(col, 3), 'base'); save(nm, 'nrm'); save(orm, 'orm')
    print(an, 'done, mm/texel %.3f' % med, 'mean col', col.mean(0).round(3), round(time.time() - T0, 1), 's', flush=True)


for an in (sys.argv[2:] or ['rifle', 'hands']): run(an)
