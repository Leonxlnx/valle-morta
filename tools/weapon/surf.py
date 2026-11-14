# Procedural PBR surfacing of the view-model atlases from baked geometry maps (part id, position, normal,
# bevel curvature, AO):  python surf.py <build dir> <atlas> [...]     atlases: arms rifle pistol sniper
import numpy as np, json, sys, os, time
from PIL import Image
from scipy import ndimage as ndi
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import textures as T, rigdef as RD
from textures import ss, mix, mixc, fbm, tri, plain, f4

D = sys.argv[1]; T0 = time.time()
STEEL, MAGS, BOLT, WOOD, GRIPW, FABRIC, LEATHER, PAD, SLEEVE, CUFF, BRASS, FABRIC2, HEM, VENT = range(1, 15)
POLY, RUBBER, GLASS, BLUED, ALU, COPPER, GLOVE, WHITE, DARK, PARK, RED, OLIVE = range(15, 27)


class Ctx:
    def put(c, m, res):
        if m.any(): c.col[m], c.rough[m], c.metal[m], c.hgt[m] = res


def load(an):
    c = Ctx(); meta = json.load(open(os.path.join(D, an + '_meta.json'))); bmin = np.array(meta['bmin'], f4); bmax = np.array(meta['bmax'], f4)
    L = lambda s: np.load(os.path.join(D, an + '_' + s + '.npy')).astype(f4)
    pidi = L('pid'); c.H, c.W = pidi.shape[:2]; c.valid = pidi[..., 0] > 0.4 / 32
    c.iy, c.ix = ndi.distance_transform_edt(~c.valid, return_distances=False, return_indices=True)
    c.P = (bmin + L('pos')[c.iy, c.ix] * (bmax - bmin)) * 1000.0
    N = L('nrm')[c.iy, c.ix] * 2 - 1; N /= np.maximum(np.linalg.norm(N, axis=2, keepdims=True), 1e-4)
    BV = L('bev')[c.iy, c.ix] * 2 - 1; BV /= np.maximum(np.linalg.norm(BV, axis=2, keepdims=True), 1e-4)
    edge = np.linalg.norm(BV - N, axis=2).astype(f4); vf = c.valid.astype(f4)
    ao = ndi.gaussian_filter(L('ao')[..., 0] * vf, 1.0) / np.maximum(ndi.gaussian_filter(vf, 1.0), 1e-3)
    edge = ndi.gaussian_filter(edge * vf, 0.8) / np.maximum(ndi.gaussian_filter(vf, 0.8), 1e-3)
    c.vi = np.nonzero(c.valid); c.M = M = len(c.vi[0])
    c.p = c.P[c.vi]; c.n = N[c.vi]; c.e = edge[c.vi]; c.a = np.clip(ao[c.vi], 0, 1)
    c.pid = np.rint(pidi[..., 0][c.vi] * 32).astype(np.int32); c.g = pidi[..., 1][c.vi]; c.tag = np.rint(pidi[..., 2][c.vi] * 32).astype(np.int32)
    c.col = np.zeros((M, 3), f4); c.rough = np.full(M, 0.5, f4); c.metal = np.zeros(M, f4); c.hgt = np.zeros(M, f4)
    c.scr = T.scratch_image(c.H, c.W, 5, 500)[c.vi]; c.xw = np.zeros(M, f4); c.stamp = np.zeros(M, f4); c.hadd = np.zeros(M, f4)
    print(an, 'texels', M, 'cover %.2f' % (M / (c.H * c.W)), 'edge pct', np.percentile(c.e, [50, 90, 97, 99.5]).round(3), 'ao pct', np.percentile(c.a, [5, 50, 95]).round(2), flush=True)
    return c


def finish(c, an, hscale, aofloor=0.68):
    c.col *= (aofloor + (1 - aofloor) * c.a ** 0.8)[:, None]

    def img(vals, ch):
        o = np.zeros((c.H, c.W, ch), f4) if ch > 1 else np.zeros((c.H, c.W), f4); o[c.vi] = vals; return o[c.iy, c.ix]
    Hh = ndi.gaussian_filter(img(c.hgt * hscale, 1), 0.55); P = c.P
    du = np.linalg.norm(np.roll(P, -1, 1) - np.roll(P, 1, 1), axis=2) / 2; dv = np.linalg.norm(np.roll(P, -1, 0) - np.roll(P, 1, 0), axis=2) / 2
    med = float(np.median(du[c.valid])); du = np.clip(du, 0.6 * med, 3 * med); dv = np.clip(dv, 0.6 * med, 3 * med)
    gx = np.clip((np.roll(Hh, -1, 1) - np.roll(Hh, 1, 1)) / 2 / du, -1.2, 1.2); gy = np.clip((np.roll(Hh, -1, 0) - np.roll(Hh, 1, 0)) / 2 / dv, -1.2, 1.2)
    nz = 1 / np.sqrt(1 + gx * gx + gy * gy); nm = np.stack([-gx * nz, -gy * nz, nz], 2) * 0.5 + 0.5
    orm = np.stack([np.clip(img(c.a, 1), 0.12, 1), np.clip(img(c.rough, 1), 0.06, 1), np.clip(img(c.metal, 1), 0, 1)], 2)

    def save(arr, suf): Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)[::-1]).save(os.path.join(D, an + '_' + suf + '.png'))
    save(img(c.col, 3), 'base'); save(nm, 'nrm'); save(orm, 'orm')
    print(an, 'done, mm/texel %.3f' % med, 'mean col', c.col.mean(0).round(3), round(time.time() - T0, 1), 's', flush=True)


# ------------------------------------------------------------------ generic materials
def m_metal(c, m, base, bare=(0.52, 0.52, 0.51), rough=0.42, wear=1.0, rust=0.25, sheen=0.12, scratch=0.3, dirt=1.0):
    p, n, e, a, g = c.p[m], c.n[m], c.e[m], c.a[m], c.g[m]; M = len(p); base = np.asarray(base, f4)
    lf = fbm(p, 1 / 40., 3, 1); mf = fbm(p, 1 / 7., 4, 2); hf = fbm(p, 1 / 0.8, 2, 3); pt = fbm(p, 1 / 16., 4, 4); cav = np.clip(1 - a, 0, 1)
    col = np.tile(base, (M, 1)) * (0.82 + 0.36 * mf)[:, None] * (0.9 + 0.2 * g)[:, None]
    col = mixc(col, base * np.array([1.25, 1.05, 0.95], f4), ss(0.5, 0.78, lf) * 0.5)
    r = rough + 0.2 * (mf - 0.5) + 0.1 * (lf - 0.5) - sheen * ss(0.55, 0.75, pt); mt = np.full(M, 0.9, f4)
    wf = ss(0.3, 0.72, fbm(p, 1 / 24., 3, 12))
    w = wear * (ss(0.14, 0.42, e * (0.25 + 1.2 * mf) * (0.3 + 1.1 * wf)) * ss(0.4, 0.8, a) + 0.5 * ss(0.68, 0.84, pt) * ss(0.3, 0.7, hf + 0.4 * mf - 0.2) * wf)
    thin = np.clip(ss(0.03, 0.25, e) * (0.25 + 0.5 * wf), 0, 1) * min(wear, 1.5); col = mixc(col, base * 1.9 + 0.05, thin * 0.5)
    sc2 = scratch * c.scr[m] * ss(0.45, 0.7, fbm(p, 1 / 25., 2, 6)); w = np.clip(w + c.xw[m] + sc2, 0, 1)
    col = mixc(col, np.asarray(bare, f4) * (0.8 + 0.35 * hf)[:, None], w); r = mix(r, 0.26 + 0.14 * hf, w); mt = mix(mt, 1.0, w)
    ru = np.clip(3.0 * rust * ss(0.64, 0.8, fbm(p, 1 / 4.5, 4, 9)) * ss(0.48, 0.72, fbm(p, 1 / 35., 3, 10)) * (0.35 + 0.9 * cav + 0.6 * w), 0, 1)
    col = mixc(col, np.array([0.30, 0.165, 0.09], f4) * (0.7 + 0.6 * hf)[:, None], ru); r = mix(r, 0.82, ru); mt = mix(mt, 0.15, ru)
    du = np.clip(dirt * (ss(0.18, 0.6, cav) * (0.4 + 0.7 * mf) + 0.1 * ss(0.6, 0.95, n[:, 2]) * lf), 0, 0.85)
    col = mixc(col, (0.25, 0.225, 0.19), du); r = mix(r, 0.88, du); mt = mt * (1 - du)
    return col, r, mt, 0.01 * (hf - 0.5) + 0.008 * (mf - 0.5) - 0.012 * w + 0.015 * ru - 0.01 * sc2


def m_metal2(c, m, base, bare=(0.76, 0.75, 0.73), rough=0.44, wear=1.0, rust=0.08, oil=1.0, scratch=0.5, dirt=0.6, coat=0.6):
    """service steel, look 2. Base colours are sRGB-encoded (the PNG is written as is), so a coated steel belongs at 0.2-0.35 and bare steel near 0.75;
    every edge carries a lighter line, exposed corners wear to bare metal (c.xw adds holster wear), fine scratches, oil film as tint / roughness variation"""
    p, n, e, a, g = c.p[m], c.n[m], c.e[m], c.a[m], c.g[m]; M = len(p); base = np.asarray(base, f4); bare = np.asarray(bare, f4)
    lf = fbm(p, 1 / 40., 3, 1); mf = fbm(p, 1 / 7., 4, 2); hf = fbm(p, 1 / 0.8, 2, 3); pt = fbm(p, 1 / 16., 4, 4); cav = np.clip(1 - a, 0, 1); ex = ss(0.45, 0.85, a)
    col = np.tile(base, (M, 1)) * (0.9 + 0.2 * mf)[:, None] * (0.95 + 0.1 * g)[:, None]
    col = mixc(col, base * np.array([1.16, 1.05, 0.95], f4), ss(0.5, 0.8, lf) * 0.4)
    ol = oil * ss(0.48, 0.7, fbm(p, (1 / 14., 1 / 45., 1 / 14.), 3, 21)) * (0.5 + 0.5 * pt)
    col = col * (1 - 0.16 * ol)[:, None] + np.array([0.0, 0.004, 0.012], f4) * ol[:, None]
    r = rough + 0.14 * (mf - 0.5) + 0.08 * (lf - 0.5) - 0.2 * ol; mt = np.full(M, coat, f4)
    hi = ss(0.02, 0.16, e) * ex; col = mixc(col, base * 1.7 + 0.1, hi * 0.6); r = r - 0.08 * hi; mt = mix(mt, 0.9, hi * 0.6)
    wf = ss(0.3, 0.7, fbm(p, 1 / 24., 3, 12))
    w = wear * (ss(0.12, 0.36, e * (0.45 + 1.0 * mf) * (0.45 + 1.0 * wf)) * ex + 0.35 * ss(0.66, 0.82, pt) * ss(0.35, 0.7, hf + 0.4 * mf - 0.2) * wf * ex)
    sc2 = scratch * c.scr[m] * (0.3 + 0.7 * ss(0.4, 0.7, fbm(p, 1 / 25., 2, 6))); w = np.clip(w + c.xw[m] * (0.35 + 0.9 * mf) + sc2, 0, 1)
    col = mixc(col, bare * (0.82 + 0.3 * hf)[:, None], w); r = mix(r, 0.27 + 0.12 * hf, w); mt = mix(mt, 1.0, w)
    ru = np.clip(3.0 * rust * ss(0.64, 0.8, fbm(p, 1 / 4.5, 4, 9)) * ss(0.5, 0.72, fbm(p, 1 / 35., 3, 10)) * (0.3 + 0.9 * cav + 0.5 * w), 0, 1)
    col = mixc(col, np.array([0.36, 0.2, 0.11], f4) * (0.7 + 0.6 * hf)[:, None], ru); r = mix(r, 0.8, ru); mt = mix(mt, 0.2, ru)
    du = np.clip(dirt * ss(0.25, 0.7, cav) * (0.4 + 0.6 * mf), 0, 0.6); col = mixc(col, (0.2, 0.185, 0.165), du); r = mix(r, 0.85, du); mt = mt * (1 - 0.7 * du)
    return col, np.clip(r, 0.12, 1), mt, 0.01 * (hf - 0.5) + 0.006 * (mf - 0.5) - 0.014 * w + 0.012 * ru - 0.012 * sc2


# look 2 presets per part id (sRGB): pass look=2 to common(); a hook may copy and change entries before the call
LOOK2 = {STEEL: dict(base=(0.33, 0.335, 0.355), rough=0.42), MAGS: dict(base=(0.33, 0.33, 0.335), rough=0.5, wear=1.3, rust=0.2),
         BLUED: dict(base=(0.17, 0.175, 0.20), rough=0.33, wear=0.9, rust=0.04, oil=1.3), PARK: dict(base=(0.25, 0.255, 0.25), rough=0.6, wear=0.8, rust=0.1, oil=0.5),
         ALU: dict(base=(0.20, 0.20, 0.21), bare=(0.80, 0.80, 0.82), rough=0.5, wear=0.7, rust=0.0, scratch=0.35)}


def m_poly(c, m, base, rough=0.62, grain=1.0):
    p, n, e, a = c.p[m], c.n[m], c.e[m], c.a[m]; hf = fbm(p, 1 / 0.45, 2, 91); mf = fbm(p, 1 / 8., 3, 92); lf = fbm(p, 1 / 45., 3, 93)
    col = np.asarray(base, f4) * (0.85 + 0.3 * mf + 0.12 * (hf - 0.5))[:, None]
    wm = np.clip(ss(0.1, 0.36, e * (0.5 + mf)) + 0.5 * ss(0.62, 0.8, fbm(p, 1 / 14., 3, 94)), 0, 1); col = mixc(col, col * 1.7 + 0.035, wm * 0.5)
    du = np.clip(ss(0.2, 0.62, 1 - a) * (0.5 + 0.6 * mf) + 0.1 * ss(0.6, 0.95, n[:, 2]) * lf, 0, 0.8); col = mixc(col, (0.27, 0.245, 0.2), du * 0.7)
    return col, rough + 0.1 * (mf - 0.5) - 0.18 * wm + 0.2 * du, np.zeros(len(p), f4), grain * 0.03 * (hf - 0.5)


def m_glass(c, m, axis_c):
    """multi-coated lens: colour drifts from violet in the centre to green at the rim"""
    p = c.p[m]; rr = np.hypot(p[:, 0] - axis_c[0], p[:, 2] - axis_c[1]); k = np.clip(rr / max(rr.max(), 1e-3), 0, 1)[:, None]
    col = (1 - k) * np.array([0.20, 0.05, 0.42], f4) + k * np.array([0.05, 0.30, 0.22], f4)
    return col * 0.8, np.full(len(p), 0.07, f4), np.ones(len(p), f4), np.zeros(len(p), f4)


def flat(c, m, col, rough, metal=0.0, noise=0.2):
    hf = fbm(c.p[m], 1 / 1.2, 2, 80)
    return np.asarray(col, f4) * (1 - noise / 2 + noise * hf)[:, None], np.full(int(m.sum()), rough, f4), np.full(int(m.sum()), metal, f4), 0.02 * (hf - 0.5)


def common(c, steel=(0.125, 0.13, 0.145), look=1):
    """default material per part id; hooks override or extend. look=2: metals through m_metal2 with the LOOK2 presets (steel is ignored), lighter polymer"""
    pid = c.pid
    for pv, kw in ((STEEL, dict(base=steel, rough=0.46)), (MAGS, dict(base=(0.15, 0.15, 0.155), rough=0.5, wear=1.5, rust=0.4)),
                   (BLUED, dict(base=(0.055, 0.06, 0.075), rough=0.33, wear=0.8, rust=0.08, sheen=0.14)), (PARK, dict(base=(0.17, 0.175, 0.17), rough=0.62, wear=0.7, rust=0.15, sheen=0.05)),
                   (ALU, dict(base=(0.045, 0.047, 0.052), bare=(0.72, 0.73, 0.75), rough=0.45, wear=0.7, rust=0.0, sheen=0.08, scratch=0.2))):
        m = pid == pv
        if m.any(): c.put(m, m_metal2(c, m, **LOOK2[pv]) if look == 2 else m_metal(c, m, **kw))
    m = pid == BOLT
    if m.any(): c.put(m, T.m_bolt(c.p[m], c.n[m], c.e[m], c.a[m], c.g[m], c.tag[m], c.scr[m] * 0.4, c.xw[m]))
    for pv in (BRASS, COPPER):
        m = pid == pv
        if m.any():
            col, r, mt, h = T.m_brass(c.p[m], c.n[m], c.e[m], c.a[m])
            if pv == COPPER: col = col * np.array([0.95, 0.62, 0.5], f4)
            c.put(m, (col, r, mt, h))
    for pv, grip in ((WOOD, False), (GRIPW, True)):
        m = pid == pv
        if m.any(): c.put(m, T.m_wood(c.p[m], c.n[m], c.e[m], c.a[m], c.tag[m], grip))
    for pv, col, r, mt in ((VENT, (0.06, 0.045, 0.035), 0.85, 0.0), (DARK, (0.02, 0.02, 0.022), 0.8, 0.0), (WHITE, (0.82, 0.82, 0.78), 0.55, 0.0), (RED, (0.55, 0.06, 0.04), 0.5, 0.0)):
        m = pid == pv
        if m.any(): c.put(m, flat(c, m, col, r, mt))
    m = pid == POLY
    if m.any(): c.put(m, m_poly(c, m, (0.115, 0.115, 0.12) if look == 2 else (0.045, 0.047, 0.045)))
    m = pid == OLIVE
    if m.any(): c.put(m, m_poly(c, m, (0.17, 0.185, 0.115), 0.7, 2.2))
    m = pid == RUBBER
    if m.any(): c.put(m, m_poly(c, m, (0.03, 0.03, 0.032), 0.8, 1.5))


def engrave(c):
    c.hgt += c.hadd - 0.16 * c.stamp; c.col *= (1 - 0.5 * c.stamp)[:, None]; c.rough[:] = mix(c.rough, 0.8, c.stamp * 0.7); c.metal *= (1 - 0.5 * c.stamp)


# ------------------------------------------------------------------ arms
def hook_arms(c):
    q = c.p.copy(); q[:, 0] -= RD.OFFX; x, y, z = q[:, 0], q[:, 1], q[:, 2]; n = c.n; M = c.M
    glove = c.pid == GLOVE; sl = ~glove; sm = np.zeros(M, f4); d = -y
    sm[sl & ((np.abs(d - 34.5) < 0.8) | (np.abs(d - 30.5) < 0.8))] = 0.7
    under = sl & (z < 0) & (d > 38); sm[under & (np.abs(np.abs(x) - 3.4) < 0.7)] = 0.7; sm[under & (np.abs(x) < 0.7)] = 1.0
    c.put(sl, T.m_cloth(c.p[sl], n[sl], c.e[sl], c.a[sl], sm[sl], (0.27, 0.29, 0.165), 1.7, 0.92, 'sleeve'))
    gi = np.nonzero(glove)[0]; xg, yg, zg = x[gi], y[gi], z[gi]; ng = n[gi]; G = len(gi)
    Tt, Sc, Zb, idx = RD.fields(q[gi].astype(np.float64)); ar = np.arange(G)
    nd = ng[:, 2].copy(); th = idx == 0; nd[th] = ng[th] @ RD.chain('Thumb')[3][1].astype(f4)
    t = np.where(idx >= 0, Tt[np.maximum(idx, 0), ar], 0.0); tot = np.array([RD.cumlen(RD.chain(f)[0])[3] for f in RD.FN])[np.maximum(idx, 0)]
    l0 = np.array([RD.cumlen(RD.chain(f)[0])[1] for f in RD.FN])[np.maximum(idx, 0)]
    cuff = yg < -3; strap = cuff & (yg > -24.5); tab = strap & (zg > 21.4) & (np.abs(xg - 2) < 18.5) & (np.abs(yg + 13.5) < 9)
    ptop = 14.2 * (1 - np.clip(np.abs(xg) / 43.0, 0, 0.999) ** 2.7) ** (1 / 2.7); ky = np.interp(xg, [-29, -8, 12, 30], [92, 96, 92, 82]) - 8
    guard = (~cuff) & (zg > ptop + 0.9) & (np.abs(yg - ky) < 12.8) & (np.abs(xg) < 41) & (zg > 9)
    back = (~cuff) & (~guard) & (nd > 0.28); palm = (~cuff) & (~guard) & (nd < -0.30); side = (~cuff) & (~guard) & (~back) & (~palm)
    s = np.zeros(G, f4)
    s[(~cuff) & ((np.abs(nd - 0.28) < 0.05) | (np.abs(nd + 0.30) < 0.05)) & (yg > 6)] = 0.7
    s[np.abs(yg + 3) < 0.7] = 1.0; s[cuff & (np.abs(np.abs(yg + 14.2) - 9.2) < 0.55)] = 0.7
    sd = T.sd_rbox(xg, yg, 10, 36, 24, 24, 9); patch = palm & (sd < 0) & (idx < 0); s[palm & (idx < 0) & (np.abs(sd + 2.0) < 0.55)] = 0.7
    tip = palm & (idx >= 0) & (idx <= 2) & (t > tot - 26); s[palm & (idx >= 0) & (idx <= 2) & (np.abs(t - (tot - 26)) < 0.6)] = 0.7
    s[guard & (zg < ptop + 1.6)] = 1.0
    P_, N_, E_, A_ = c.p[gi], ng, c.e[gi], c.a[gi]

    def sub(m, res): c.put(gi_mask(m), res)

    def gi_mask(m):
        o = np.zeros(M, bool); o[gi[m]] = True; return o
    for m, fn in ((back, lambda m: T.m_cloth(P_[m], N_[m], E_[m], A_[m], s[m], (0.30, 0.275, 0.185), 1.3, 0.88, 'glove')),
                  (side, lambda m: T.m_cloth(P_[m], N_[m], E_[m], A_[m], s[m], (0.085, 0.087, 0.08), 1.1, 0.9, 'glove')),
                  (palm, lambda m: T.m_leather(P_[m], N_[m], E_[m], A_[m], s[m])),
                  (guard, lambda m: T.m_pad(P_[m], N_[m], E_[m], A_[m], s[m], False)),
                  (cuff, lambda m: T.m_pad(P_[m], N_[m], E_[m], A_[m], s[m], True))):
        if m.any():
            col, r, mt, h = fn(m)
            if m is palm:
                col = col * np.where(patch[m] | tip[m], 0.62, 1.0)[:, None] * np.array([0.85, 0.9, 1.0], f4); h = h + np.where(patch[m] | tip[m], 0.05, 0.0)
                dots = tip[m] * (np.sin(P_[m][:, 0] * 2.1) * np.sin(P_[m][:, 1] * 2.1) * np.sin(P_[m][:, 2] * 2.1) > 0.3); h = h + 0.07 * dots; r = r - 0.12 * dots
            if m is guard: h = h + 0.07 * np.cos(2 * np.pi * xg[m] / 5.5) * (zg[m] > ptop[m] + 2.6)
            if m is cuff:
                st = strap[m] & ~tab[m]; col = np.where(st[:, None], col * 1.25 + 0.012, col); h = h + 0.05 * np.cos(2 * np.pi * yg[m] / 1.6) * (~strap[m])
                col = np.where(tab[m][:, None], np.array([0.11, 0.11, 0.105], f4) * (0.8 + 0.4 * fbm(P_[m], 1 / 0.7, 2, 5))[:, None], col)
            if m is back:
                rib = (idx[m] >= 1) & (np.abs(t[m] - l0[m]) < 8.5); h = h + 0.09 * np.cos(2 * np.pi * (t[m] - l0[m]) / 4.2) * rib; col = col * np.where(rib, 0.8, 1.0)[:, None]
            sub(m, (col, r, mt, h))


# ------------------------------------------------------------------ rifle
def hook_rifle(c):
    p, n, tag, M = c.p, c.n, c.tag, c.M; x, y, z = p[:, 0], p[:, 1], p[:, 2]
    Ls = (tag == 1) & (n[:, 0] < -0.8); Rs = (tag == 1) & (n[:, 0] > 0.8)
    c.stamp[Ls] = T.stamp_text(-y[Ls], z[Ls], (-186, -140, 6, 44), [('^', -183, 33, 5.0), ('1976', -176, 33.5, 3.4), ('КН 4831', -183, 26, 3.4)])
    c.stamp[Rs] = T.stamp_text(y[Rs], z[Rs], (72, 92, 0, 34), [('АВ', 75, 19, 3.6), ('ОД', 75, 3.5, 3.6)])
    for m in (Ls, Rs):
        sd = T.sd_rbox(y[m], z[m], 108, 22, 19, 6.5, 6.0); c.xw[m] += 0.4 * np.exp(-(sd / 0.7) ** 2); c.hadd[m] += -0.35 * ss(1.2, -1.2, sd)
    rr = np.hypot(y + 28, z - 30); ang = np.degrees(np.arctan2(z - 30, y + 28)); arc = Rs & (ang > -34) & (ang < 6)
    c.xw[arc] += np.exp(-((rr[arc] - 97.5) / 1.0) ** 2) * (0.5 + 0.8 * fbm(p[arc], 1 / 3., 2, 77))
    leaf = (tag == 2) & (n[:, 2] > 0.6); tick = np.zeros(M, f4)
    for k in range(9): tick[leaf] = np.maximum(tick[leaf], np.exp(-((y[leaf] - (164 + 5.6 * k)) / 0.22) ** 2) * (np.abs(x[leaf]) > 1.2))
    c.stamp = np.maximum(c.stamp, tick)
    mg = tag == 4; c.xw[mg] += 0.3 * ss(-90, -5, z[mg]) * ss(0.4, 0.7, fbm(p[mg], (1 / 1.2, 1 / 30., 1 / 30.), 3, 78))
    top = (c.pid == MAGS) & (z > -6); c.a[top] = np.maximum(c.a[top], 0.7)
    common(c, look=2); engrave(c)
    inner = (tag == 21) & (c.pid == STEEL); c.col[inner] *= 0.6


def hook_pistol(c):
    p, n, tag, pid, M = c.p, c.n, c.tag, c.pid, c.M; x, y, z = p[:, 0], p[:, 1], p[:, 2]; ax = np.abs(n[:, 0]); wave = lambda t: np.abs((t % 1.0) - 0.5) * 2
    mv = (tag == 4) | (tag == 20) | (tag == 3); c.a[mv] = 0.7 + 0.3 * c.a[mv]        # magazine, rounds, barrel: baked inside the weapon, seen outside it
    sl = (tag == 1) & (pid == STEEL); side = sl & (ax > 0.75) & (z > 32.5) & (z < 49.8)
    rl = side & (np.abs(z - 34.2) < 0.9); c.hadd[rl] -= 0.2 * ss(0.9, 0.3, np.abs(z[rl] - 34.2)); c.xw[rl] += 0.2      # rail relief line along the slide
    ser = side & (((y > -56) & (y < -27)) | ((y > 86) & (y < 110)))                                       # rear and front cocking serrations, slanted
    gr = np.zeros(M, f4); gr[ser] = ss(0.5, 0.25, wave((y[ser] + 0.3 * (z[ser] - 40)) / 2.6))
    c.hadd -= 0.26 * gr; c.xw[ser] += 0.3 * (1 - gr[ser]) * ss(0.4, 0.75, fbm(p[ser], 1 / 6., 2, 41))
    top = sl & (n[:, 2] > 0.9) & (np.abs(x) < 5.2) & (y > -43) & (y < 104) & ~((y > 5) & (y < 43)); c.hadd[top] -= 0.1 * ss(0.5, 0.25, wave(x[top] / 1.1))   # anti-glare rib
    rp = sl & (n[:, 1] < -0.9); c.hadd[rp] -= 0.25 * np.exp(-(T.sd_rbox(x[rp], z[rp], 0, 42, 7.5, 9.5, 2.0) / 0.3) ** 2)                               # rear plate outline
    mg = (tag == 4) & (pid == MAGS) & (ax > 0.8); ms = -(y + 1.04) * 0.2691 - (z - 25) * 0.9631; mu = (y + 1.04) * 0.9631 - (z - 25) * 0.2691
    for sg, u0 in ((1, -5.5), (-1, -3.5)):                                                                # round-count numbers beside the witness holes
        k = mg & (n[:, 0] * sg > 0); c.stamp[k] = T.stamp_text(sg * mu[k], -ms[k], (-7, 7, -92, -30), [(t, u0, -s0 - 1.4, 3.0) for t, s0 in (('5', 38), ('10', 62), ('15', 86))])
    Ls = sl & (n[:, 0] < -0.8) & (z < 49); Rs = sl & (n[:, 0] > 0.8) & (z < 49)
    c.stamp[Ls] = T.stamp_text(-y[Ls], z[Ls], (-82, -2, 35, 48), [('VM9', -78, 38.6, 5.4), ('9mm PARA', -52, 39.6, 3.2)])
    c.stamp[Rs] = T.stamp_text(y[Rs], z[Rs], (46, 84, 35, 46), [('VM 204817', 48, 38.6, 3.0)])
    Fr = (tag == 2) & (n[:, 0] > 0.8) & (z > 18) & (y > 60); c.stamp[Fr] = T.stamp_text(y[Fr], z[Fr], (66, 114, 18.5, 29), [('VM204817', 72, 21.5, 2.8)])
    for m, y0 in ((sl, 92.0), ((tag == 2) & (pid == PARK), 96.0)):                                        # holster wear towards the muzzle
        c.xw[m] += 0.5 * ss(y0, y0 + 30, y[m]) * ss(0.42, 0.7, fbm(p[m], 1 / 10., 3, 42)) * ss(0.5, 0.9, c.a[m])
    fsb = (tag == 2) & (pid == PARK) & (z < -6) & (z > -72) & (np.abs(n[:, 1]) > 0.75) & (y < 14)         # front and back strap grooves, palm wear
    g2 = np.zeros(M, f4); g2[fsb] = ss(0.5, 0.25, wave(z[fsb] / 2.4)); c.hadd -= 0.2 * g2; c.xw[fsb] += 0.25 * ss(0.45, 0.7, fbm(p[fsb], 1 / 12., 3, 43))
    ctl = (tag == 6) & (n[:, 2] > 0.55) & (ax < 0.5); g3 = np.zeros(M, f4); g3[ctl] = ss(0.5, 0.25, wave(y[ctl] / 1.5)); c.hadd -= 0.14 * g3   # lever pads, hammer spur, sight tops
    gp = (tag == 5) & (ax > 0.8)                                                                          # chequered grip panels with a plain border
    inn = gp & (y < 4.2 + 0.2794 * z) & (y > -33.0 + 0.2794 * z) & (z < -5) & (z > -64) & (np.hypot(y + 16, z + 12) > 5.5) & (np.hypot(y + 36.5, z + 56) > 5.5)
    pyr = np.zeros(M, f4); pyr[inn] = 1 - np.maximum(wave((0.82 * y[inn] + 0.57 * z[inn]) / 1.8), wave((0.82 * y[inn] - 0.57 * z[inn]) / 1.8))
    c.hadd += 0.2 * pyr - 0.07 * inn
    common(c, look=2)
    m = pid == BOLT                                                                                       # barrel: bright steel, hood polished by the slide
    if m.any(): c.put(m, m_metal2(c, m, (0.56, 0.56, 0.55), rough=0.3, wear=0.6, rust=0.03, oil=0.6, coat=1.0, dirt=0.4))
    c.col[inn] *= (0.8 + 0.4 * pyr[inn])[:, None]; c.col *= (1 - 0.4 * np.maximum(gr, np.maximum(g2, g3)))[:, None]; c.rough[inn] = np.clip(c.rough[inn] + 0.1, 0, 1); c.rough[top] = np.clip(c.rough[top] + 0.12, 0, 1)
    engrave(c)
def m_web(c, m):
    """synthetic stock: OD green with a tan / black marbled web (moulded-in colour), slightly worn on the edges"""
    p = c.p[m]; col, r, mt, h = m_poly(c, m, (0.20, 0.215, 0.15), 0.72, 1.6)
    v1 = 1 - ss(0.0, 0.035, np.abs(fbm(p, 1 / 26., 4, 71) - 0.5)); v2 = 1 - ss(0.0, 0.022, np.abs(fbm(p, 1 / 15., 4, 72) - 0.5)); cl = ss(0.55, 0.7, fbm(p, 1 / 40., 3, 73))
    col = mixc(col, col * np.array([1.55, 1.42, 1.25], f4), np.clip(v1 * 0.75 + cl * 0.25, 0, 1)); col = mixc(col, col * 0.45, v2 * 0.6)
    return col, r, mt, h


def hook_sniper(c):
    p, n, tag, pid, M = c.p, c.n, c.tag, c.pid, c.M; x, y, z = p[:, 0], p[:, 1], p[:, 2]; wave = lambda t: np.abs((t % 1.0) - 0.5) * 2
    BZ, SZ, YT = 48.0, 108.0, 70.0
    mv = (tag == 3) | (tag == 4) | (tag == 20); c.a[mv] = 0.7 + 0.3 * c.a[mv]        # bolt, magazine, rounds: baked inside the weapon, seen outside it
    rc = (tag == 1) & (pid == STEEL); Ls = rc & (n[:, 0] < -0.6) & (np.abs(z - BZ) < 13)
    c.stamp[Ls] = T.stamp_text(-y[Ls], z[Ls], (-176, -10, 39, 58), [('VALLE MORTA ARMS', -170, 50.0, 3.4), ('VM-12 LR   7.62x51 NATO', -170, 43.0, 2.7)])
    Rs = rc & (n[:, 0] > 0.6) & (y > 176) & (np.abs(z - BZ) < 10); c.stamp[Rs] = T.stamp_text(y[Rs], z[Rs], (176, 199, 38, 58), [('VM 0417', 178, 44.0, 2.6)])
    bl = (tag == 2) & (pid == STEEL) & (n[:, 0] < -0.6) & (y < 320); c.stamp[bl] = T.stamp_text(-y[bl], z[bl], (-320, -212, 40, 56), [('.308 WIN  1:10  STAINLESS', -312, 46.0, 2.6)])
    tick = np.zeros(M, bool)                                                    # turret graduations (white fill): elevation on top, windage on the right
    for ax, band, u, v in ((z - SZ, (24.6, 31.0), x, y - YT), (x, (24.6, 26.2), z - SZ, y - YT)):
        m = (tag == 7) & (ax > band[0]) & (ax < band[1]) & (np.hypot(u, v) > 14.4) & (np.hypot(u, v) < 17.0); i = np.nonzero(m)[0]
        ang = np.degrees(np.arctan2(u[i], v[i])); d = np.abs(((ang + 4.5) % 9) - 4.5); maj = np.abs(((ang + 22.5) % 45) - 22.5) < 1.6
        tick[i[(d < 1.1) & ((ax[i] > band[0] + 0.55 * (band[1] - band[0])) | maj)]] = True
    c.hadd[tick] -= 0.12
    st5 = (tag == 5) & (pid == OLIVE)                                            # stippled grip and fore-end panels
    stip = st5 & (((z < 4) & (y > -90) & (y < 30)) | ((np.abs(x) > 26) & (y > 200) & (y < 400) & (z > 12) & (z < 38)))
    c.hadd[stip] += 0.14 * ss(0.42, 0.62, fbm(p[stip], 1 / 0.55, 2, 61))
    pad = (pid == RUBBER) & (tag == 5) & (np.abs(n[:, 1]) > 0.6); c.hadd[pad] -= 0.25 * ss(0.55, 0.2, wave(z[pad] / 3.2))
    knob = (tag == 3) & (pid == BLUED); c.xw[knob] += 0.15
    rl = (tag == 8) & (pid == PARK); c.xw[rl] += 0.25 * ss(0.5, 0.75, fbm(p[rl], 1 / 9., 3, 62)) * (n[rl, 2] > 0.5)
    common(c, look=2)
    if st5.any(): c.put(st5, m_web(c, st5))
    m = pid == BOLT                                                              # bolt body and handle: bare machined steel
    if m.any(): c.put(m, m_metal2(c, m, (0.6, 0.6, 0.59), rough=0.28, wear=0.5, rust=0.02, oil=0.9, coat=1.0, dirt=0.35))
    m = pid == GLASS
    if m.any(): c.put(m, m_glass(c, m, (0.0, SZ)))
    c.col[stip] *= 0.9; c.col[tick] = np.array([0.82, 0.82, 0.78], f4); c.rough[tick] = 0.6; c.metal[tick] = 0.0
    engrave(c)


def hook_rifle2(c):
    """AKM clean-sheet rifle (rifle_geo.py): worn dark-grey steel with bright edges, handling polish, pitting and old oil; dark varnished laminate worn pale"""
    p, n, tag, pid, M = c.p, c.n, c.tag, c.pid, c.M; x, y, z = p[:, 0], p[:, 1], p[:, 2]
    mv = np.isin(tag, (4, 11, 13, 20, 21)); c.a[mv] = 0.72 + 0.28 * c.a[mv]        # magazine, bolt, trigger, rounds, casing: baked inside, seen outside
    rc = (tag == 1) & (pid == STEEL); Ls = rc & (n[:, 0] < -0.8); Rs = rc & (n[:, 0] > 0.8)
    m = Ls & (y < -18) & (y > -70); c.stamp[m] = T.stamp_text(-y[m], z[m], (18, 70, 4, 44), [('^', 22, 32, 5.0), ('1978', 29, 32.5, 3.4), ('ЛТ 2417', 22, 22, 3.4)])
    m = Rs & (y > 70) & (y < 95); c.stamp[m] = T.stamp_text(y[m], z[m], (70, 95, 2, 34), [('АВ', 75, 25, 3.6), ('ОД', 75, 10.5, 3.6)])
    cv = (tag == 3) & (pid == STEEL); m = cv & (n[:, 2] > 0.75) & (y < -38) & (y > -62)
    c.stamp[m] = np.maximum(c.stamp[m], T.stamp_text(x[m], y[m], (-13, 13, -62, -38), [('ЛТ 2417', -9.5, -54, 3.0)]))
    leaf = (tag == 10) & (n[:, 2] > 0.6) & (y > 160) & (y < 214); tick = np.zeros(M, f4)
    for k in range(9): tick[leaf] = np.maximum(tick[leaf], np.exp(-((y[leaf] - (164 + 5.6 * k)) / 0.22) ** 2) * (np.abs(x[leaf]) > 1.6))
    c.stamp = np.maximum(c.stamp, tick)
    fl = rc & (np.abs(n[:, 0]) > 0.8) & (z > 6) & (z < 42); c.xw[fl] += 0.25 * ss(0.4, 0.75, fbm(p[fl], (1 / 60., 1 / 12., 1 / 12.), 3, 81))
    rib = np.zeros(M, bool)
    for y0 in (-48, -20, 8, 64, 100): rib |= cv & (np.abs(y - y0 - 2.25) < 2.7) & (n[:, 2] > 0.25)
    c.xw[rib] += 0.25; c.xw[cv & ~rib] += 0.15 * ss(0.5, 0.8, fbm(p[cv & ~rib], 1 / 25., 3, 82))
    sel = (tag == 1) & (x > 17) & (y > 50) & (y < 76) & (z < 20); c.xw[sel] += 0.4
    mg = tag == 4; c.xw[mg] += 0.3 * ss(-90, -5, z[mg]) * ss(0.4, 0.7, fbm(p[mg], (1 / 1.2, 1 / 30., 1 / 30.), 3, 78))
    common(c, look=2)
    st = pid == STEEL
    if st.any(): c.put(st, m_metal2(c, st, (0.20, 0.205, 0.22), rough=0.46, wear=1.35, rust=0.25, oil=1.3, scratch=0.7, dirt=0.75, coat=0.55))
    stm = st | (pid == MAGS); cav = np.clip(1 - c.a, 0, 1)
    pits = ss(0.74, 0.84, fbm(p, 1 / 0.45, 2, 83)) * ss(0.25, 0.55, fbm(p, 1 / 14., 2, 84)) * (0.4 + cav)
    oil = ss(0.12, 0.5, cav) * ss(0.35, 0.65, fbm(p, 1 / 6., 3, 85))
    c.hadd[stm] -= 0.10 * pits[stm]; c.col[stm] *= (1 - 0.3 * pits[stm] - 0.3 * oil[stm])[:, None]; c.col[stm] += np.array([0.02, 0.012, 0.0], f4) * oil[stm][:, None]
    c.rough[stm] = mix(c.rough[stm], 0.24, 0.6 * oil[stm])
    c.col[(tag == 12) & st] *= 0.6
    w = (pid == WOOD) | (pid == GRIPW)                                              # dark varnish worn pale where hands and slings rub, dents and gouges
    if w.any():
        pw, tw = p[w], tag[w]; hand = np.where(tw == 7, 0.45, np.where(tw == 6, 0.32, np.where(tw == 8, 0.12, 0.0)))
        t = np.clip(ss(0.55, 0.8, 0.5 * fbm(pw, 1 / 16., 3, 71) + 0.25 + hand) + ss(0.08, 0.3, c.e[w]) * 0.8, 0, 1)
        gg = ss(0.88, 0.93, fbm(pw, (1 / 0.7, 1 / 24., 1 / 0.7), 2, 72)) * ss(0.72, 0.82, fbm(pw, 1 / 40., 2, 73))
        cw = c.col[w]; dark = cw * np.array([0.5, 0.36, 0.30], f4); pale = cw * 0.55 + np.array([0.62, 0.50, 0.36], f4) * 0.45
        c.col[w] = dark * (1 - t)[:, None] + pale * t[:, None]; c.col[w] = c.col[w] * (1 - gg)[:, None] + np.array([0.58, 0.45, 0.30], f4) * gg[:, None]
        c.rough[w] = 0.3 * (1 - t) + 0.62 * t; c.hadd[w] -= 0.3 * gg
    f = pid == FABRIC
    if f.any():
        pf = p[f]; wv = 0.5 + 0.5 * np.sin(2 * np.pi * pf[:, 1] / 1.1) * np.sin(2 * np.pi * (pf[:, 0] + pf[:, 2]) / 1.1); hf = fbm(pf, 1 / 6., 3, 74)
        col = np.array([0.31, 0.29, 0.19], f4) * (0.75 + 0.3 * hf + 0.12 * wv)[:, None] * (0.6 + 0.4 * c.a[f])[:, None]
        c.put(f, (col, np.full(int(f.sum()), 0.9, f4), np.zeros(int(f.sum()), f4), 0.05 * wv))
    engrave(c)


HOOKS = dict(arms=(hook_arms, 1.6), rifle=(hook_rifle, 3.0), rifle2=(hook_rifle2, 3.0), pistol=(hook_pistol, 3.0), sniper=(hook_sniper, 3.0))
if __name__ == '__main__':
    for an in sys.argv[2:]:
        c = load(an); HOOKS[an][0](c); finish(c, an, HOOKS[an][1])
