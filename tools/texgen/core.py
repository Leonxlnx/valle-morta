"""texgen.core - periodic (seamlessly tileable) procedural texture toolkit.

Everything here works on square float32 arrays indexed [row(y, down), col(x)].
All generators are periodic by construction, so results tile without seams.
Only numpy / scipy / pillow are used.
"""
import os
import zlib
import numpy as np
import scipy.fft as sfft
import scipy.ndimage as ndi
from scipy.spatial import cKDTree
from PIL import Image, ImageDraw, ImageFile

ImageFile.MAXBLOCK = 1 << 26      # optimize=True needs a large encoder buffer for noisy 2k maps

F = np.float32
WORKERS = int(os.environ.get("TEXGEN_THREADS", "5"))
TAU = 2.0 * np.pi


# ----------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------
def seed_of(*parts):
    return zlib.crc32("/".join(str(p) for p in parts).encode()) & 0x7FFFFFFF


def sat(x):
    return np.clip(x, 0.0, 1.0)


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(F)


def linstep(e0, e1, x):
    return np.clip((x - e0) / (e1 - e0), 0.0, 1.0).astype(F)


def norm01(a, lo=0.5, hi=99.5):
    """Robust normalisation to 0..1 using percentiles (subsampled)."""
    s = a[::4, ::4]
    p0, p1 = np.percentile(s, [lo, hi])
    return sat((a - p0) / max(p1 - p0, 1e-9)).astype(F)


def thresh_for_coverage(a, cov):
    """Threshold t such that mean(a > t) ~= cov."""
    return float(np.quantile(a[::3, ::3], 1.0 - cov))


def wrapd(d):
    """Minimal-image wrap of a uv difference to [-0.5, 0.5)."""
    return (d + 0.5) % 1.0 - 0.5


# ----------------------------------------------------------------------------
# spectral (FFT) gaussian noise - isotropic, periodic, resolution independent
# ----------------------------------------------------------------------------
_L0 = 256
_freq_cache = {}


def _freqs(n):
    if n not in _freq_cache:
        fy = sfft.fftfreq(n, d=1.0 / n).astype(F)[:, None]
        fx = sfft.rfftfreq(n, d=1.0 / n).astype(F)[None, :]
        _freq_cache[n] = (fx, fy)
    return _freq_cache[n]


def _white_spectrum(n, seed):
    """Unit-variance complex gaussian spectrum in rfft2 layout. The low
    frequency coefficients are identical for every power-of-two resolution,
    so a texture developed at 1024 keeps its large forms at 2048."""
    m = _L0
    lvl = 0
    S = None
    top = max(n, _L0)
    while True:
        w = np.random.default_rng([seed, lvl]).standard_normal((m, m), dtype=F)
        W = sfft.rfft2(w, workers=WORKERS) / m
        if S is not None:
            pm = m // 2
            h = pm // 2
            W[:h, :h] = S[:h, :h]
            W[m - h + 1:, :h] = S[pm - h + 1:, :h]
        S = W
        if m >= top:
            break
        m *= 2
        lvl += 1
    if n < _L0:  # crop
        h = n // 2
        C = np.zeros((n, h + 1), dtype=S.dtype)
        C[:h, :h] = S[:h, :h]
        C[n - h + 1:, :h] = S[_L0 - h + 1:, :h]
        S = C
    return S


def spectral(n, seed, f_lo=1.0, f_hi=None, H=1.0, sx=1.0, sy=1.0):
    """Periodic gaussian noise, zero mean / ~unit std.
    Amplitude spectrum ~ f^-(1+H) between f_lo and f_hi (cycles per tile).
    H=1 smooth fBm (gain .5), H=0 equal energy per octave, H=-1 white band.
    sx/sy > 1 stretch the features along x / y."""
    S = _white_spectrum(n, seed)
    fx, fy = _freqs(n)
    f = np.sqrt((fx * sx) ** 2 + (fy * sy) ** 2)
    f[0, 0] = 1.0
    amp = f ** (-(1.0 + H))
    f_lo = max(float(f_lo), 1e-3)
    amp *= np.minimum(1.0, (f / f_lo) ** 3)
    if f_hi is not None:
        amp *= np.exp(-np.maximum(f / f_hi - 1.0, 0.0) ** 2 * 6.0)
    amp[0, 0] = 0.0
    C = S * amp
    P = (C.real ** 2 + C.imag ** 2)
    ref = f <= 120.0
    v_all = 2.0 * P.sum() - P[:, 0].sum()
    Pr = P * ref
    v_ref = 2.0 * Pr.sum() - Pr[:, 0].sum()
    var = v_ref if v_ref > 0.25 * v_all else v_all
    out = sfft.irfft2(C, s=(n, n), norm="forward", workers=WORKERS)
    return (out / np.sqrt(max(var, 1e-20))).astype(F)


# ----------------------------------------------------------------------------
# lattice noises (value / perlin / simplex-like rotated fBm / ridged)
# ----------------------------------------------------------------------------
def grid(n):
    a = (np.arange(n, dtype=F) + 0.5) / n
    return np.meshgrid(a, a)


def _fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def value_noise(x, y, fx, fy, seed):
    """Periodic value noise in [-1,1]; x,y uv coordinate arrays; fx,fy int periods."""
    tab = np.random.default_rng(seed).random((fy, fx), dtype=F) * 2 - 1
    X = x * fx
    Y = y * fy
    xi = np.floor(X).astype(np.int32)
    yi = np.floor(Y).astype(np.int32)
    tx = _fade(X - xi)
    ty = _fade(Y - yi)
    x0 = xi % fx
    x1 = (xi + 1) % fx
    y0 = yi % fy
    y1 = (yi + 1) % fy
    a = lerp(tab[y0, x0], tab[y0, x1], tx)
    b = lerp(tab[y1, x0], tab[y1, x1], tx)
    return lerp(a, b, ty).astype(F)


def perlin(x, y, fx, fy, seed):
    """Periodic gradient (Perlin) noise ~[-1,1]; fx,fy integer lattice periods."""
    ang = np.random.default_rng(seed).random((fy, fx), dtype=F) * TAU
    gx = np.cos(ang)
    gy = np.sin(ang)
    X = x * fx
    Y = y * fy
    xi = np.floor(X).astype(np.int32)
    yi = np.floor(Y).astype(np.int32)
    xf = (X - xi).astype(F)
    yf = (Y - yi).astype(F)
    x0 = xi % fx
    x1 = (xi + 1) % fx
    y0 = yi % fy
    y1 = (yi + 1) % fy
    n00 = gx[y0, x0] * xf + gy[y0, x0] * yf
    n10 = gx[y0, x1] * (xf - 1) + gy[y0, x1] * yf
    n01 = gx[y1, x0] * xf + gy[y1, x0] * (yf - 1)
    n11 = gx[y1, x1] * (xf - 1) + gy[y1, x1] * (yf - 1)
    tx = _fade(xf)
    ty = _fade(yf)
    return (lerp(lerp(n00, n10, tx), lerp(n01, n11, tx), ty) * 1.5).astype(F)


_ROT = [(1, 0), (1, 1), (2, 1), (1, 2), (3, 1), (1, 3), (3, 2), (2, 3)]


def fbm(x, y, freq, octaves=5, lac=2.0, gain=0.5, seed=0, mode="fbm", rotate=True):
    """Simplex-like isotropic fBm: every octave samples a Perlin lattice that
    is rotated by an integer matrix (keeps periodicity, removes axis bias).
    mode: 'fbm', 'billow' (|n|), 'ridged' ((1-|n|)^2)."""
    out = np.zeros(np.shape(x), dtype=F)
    amp = 1.0
    tot = 0.0
    f = float(freq)
    prev = None
    for o in range(octaves):
        a, b = _ROT[(o + seed) % len(_ROT)] if rotate else (1, 0)
        k = max(1, int(round(f / np.hypot(a, b))))
        xr = a * x + b * y
        yr = -b * x + a * y
        v = perlin(xr, yr, k, k, seed_of(seed, o))
        if mode == "billow":
            v = np.abs(v) * 2 - 1
        elif mode == "ridged":
            v = (1 - np.abs(v)) ** 2
            if prev is not None:
                v = v * sat(prev * 1.6)
            prev = v
            v = v * 2 - 1
        out += amp * v
        tot += amp
        amp *= gain
        f *= lac
    return (out / tot).astype(F)


def ridged(x, y, freq, octaves=5, lac=2.0, gain=0.5, seed=0):
    return fbm(x, y, freq, octaves, lac, gain, seed, mode="ridged")


# ----------------------------------------------------------------------------
# filters
# ----------------------------------------------------------------------------
def blur(a, sx, sy=None):
    """Periodic gaussian blur; sigma in pixels (sx along x, sy along y)."""
    if sy is None:
        sy = sx
    if sx <= 0 and sy <= 0:
        return a
    if max(sx, sy) < 5.0:
        return ndi.gaussian_filter(a, (sy, sx), mode="wrap", truncate=3.0)
    n0, n1 = a.shape
    fy = sfft.fftfreq(n0).astype(F)[:, None]
    fx = sfft.rfftfreq(n1).astype(F)[None, :]
    A = sfft.rfft2(a, workers=WORKERS)
    A *= np.exp(-2.0 * np.pi ** 2 * ((sx * fx) ** 2 + (sy * fy) ** 2))
    return sfft.irfft2(A, s=a.shape, workers=WORKERS).astype(F)


def warp(a, dx, dy, order=1):
    """Domain warp: sample a at (x+dx, y+dy); displacements in pixels, periodic."""
    n0, n1 = a.shape[:2]
    yy, xx = np.meshgrid(np.arange(n0, dtype=F), np.arange(n1, dtype=F), indexing="ij")
    co = [yy + dy, xx + dx]
    if a.ndim == 2:
        return ndi.map_coordinates(a, co, order=order, mode="grid-wrap").astype(F)
    return np.stack([ndi.map_coordinates(a[..., i], co, order=order, mode="grid-wrap")
                     for i in range(a.shape[2])], -1).astype(F)


def slope_blur(a, slope, amount, steps=8):
    """Directional blur of `a` along the gradient of `slope` (downhill).
    amount = total displacement in pixels for a unit-normalised gradient."""
    gy = (np.roll(slope, -1, 0) - np.roll(slope, 1, 0)) * 0.5
    gx = (np.roll(slope, -1, 1) - np.roll(slope, 1, 1)) * 0.5
    s = np.percentile(np.hypot(gx, gy)[::4, ::4], 95) + 1e-9
    gx = gx / s * (amount / steps)
    gy = gy / s * (amount / steps)
    acc = a.astype(F).copy()
    cur = a
    for _ in range(steps):
        cur = warp(cur, -gx, -gy)
        acc += cur
    return acc / (steps + 1)


def thermal(h, iters=12, talus=0.0, rate=0.5):
    """Thermal erosion: material slides to lower 4-neighbours when the height
    difference exceeds `talus` (same unit as h, per pixel)."""
    h = h.astype(F).copy()
    for _ in range(iters):
        delta = np.zeros_like(h)
        for ax, sh in ((0, 1), (0, -1), (1, 1), (1, -1)):
            m = np.maximum(h - np.roll(h, sh, ax) - talus, 0.0) * (rate * 0.25)
            delta -= m
            delta += np.roll(m, -sh, ax)
        h += delta
    return h


def flow_accum(h, iters=48, res=512):
    """Hydraulic-ish helper: multi-direction flow accumulation on a reduced
    grid (periodic). Returns log-scaled accumulation 0..1 at the size of h."""
    n = h.shape[0]
    k = max(1, n // res)
    hs = h.reshape(n // k, k, n // k, k).mean((1, 3)) if k > 1 else h
    dirs = [(0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)]
    ws = []
    for dy, dx in dirs:
        d = (hs - np.roll(hs, (-dy, -dx), (0, 1))) / np.hypot(dx, dy)
        ws.append(np.maximum(d, 0.0) ** 1.5)
    tot = sum(ws) + 1e-12
    ws = [w / tot for w in ws]
    water = np.ones_like(hs)
    acc = np.ones_like(hs)
    for _ in range(iters):
        nw = np.zeros_like(hs)
        for (dy, dx), w in zip(dirs, ws):
            nw += np.roll(water * w, (dy, dx), (0, 1))
        water = nw
        acc += water
    acc = np.log1p(acc)
    acc = norm01(acc, 1, 99.8)
    if k > 1:
        acc = ndi.zoom(acc, k, order=1, mode="grid-wrap")
        acc = blur(acc.astype(F), k * 0.5)
    return acc.astype(F)


def sediment(h, sigma_px, level, soft):
    """Fill cavities: returns (new_h, fill_mask). Dirt surface = blurred
    height + level; cavities below it are filled (soft transition)."""
    surf = blur(h, sigma_px) + level
    m = smoothstep(-soft, soft, surf - h)
    return lerp(h, np.maximum(h, surf), m).astype(F), m


def streak_down(src, length_px, wobble=None):
    """Smear a mask downwards (+y) with an exponential tail - gravity stains.
    Periodic. length_px = e-folding length."""
    from scipy.signal import lfilter
    a = float(np.exp(-1.0 / max(length_px, 1e-3)))
    t = np.concatenate([src, src], 0).astype(np.float64)
    o = lfilter([1 - a], [1, -a], t, axis=0)[src.shape[0]:]
    return o.astype(F)


def inner_distance(mask, maxd):
    """Periodic euclidean distance (px) from True pixels to nearest False pixel,
    clipped to maxd."""
    pad = int(maxd) + 2
    m = np.pad(mask, pad, mode="wrap")
    d = ndi.distance_transform_edt(m).astype(F)
    return np.minimum(d[pad:-pad, pad:-pad], maxd)


def round_corners(mask, r):
    """Morphological opening by a disc of radius r px (periodic)."""
    core = inner_distance(mask, r + 2) > r
    return inner_distance(~core, r + 2) <= r


# ----------------------------------------------------------------------------
# height -> normal / AO / curvature
# ----------------------------------------------------------------------------
def normal_map(h, px, strength=1.0):
    """Tangent-space normal (OpenGL, +Y up) from height. h and px in the same
    length unit. Returns float32 (n,n,3) in -1..1."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * (0.5 / px)
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * (0.5 / px)
    nx = -dx * strength
    ny = dy * strength          # image y is down, v is up
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + 1.0)
    return np.stack([nx * inv, ny * inv, inv], -1).astype(F)


def ao_horizon(h, px, radius, ndir=8, nstep=7):
    """Horizon-based ambient occlusion of a periodic height field.
    h, px, radius share one length unit."""
    rmax = max(2.0, radius / px)
    steps = np.unique(np.round(np.geomspace(1, rmax, nstep)).astype(int))
    lv = {}

    def src(s):
        key = 0 if s <= 2 else (1 if s <= 6 else (3 if s <= 16 else max(4, int(s / 5))))
        if key not in lv:
            lv[key] = h if key == 0 else blur(h, float(key))
        return lv[key]

    occ = np.zeros_like(h)
    for i in range(ndir):
        ang = (i + 0.5) * TAU / ndir
        dx, dy = np.cos(ang), np.sin(ang)
        t = np.zeros_like(h)
        for s in steps:
            ox, oy = int(round(dx * s)), int(round(dy * s))
            if ox == 0 and oy == 0:
                continue
            d = (np.roll(src(s), (-oy, -ox), (0, 1)) - h) * (1.0 / (np.hypot(ox, oy) * px))
            np.maximum(t, d, out=t)
        t *= t
        occ += t / (1.0 + t)
    return (1.0 - occ / ndir).astype(F)


def curvature(h, sigma_px):
    """h - blur(h): >0 convex (edges, peaks), <0 concave (cavities)."""
    return (h - blur(h, sigma_px)).astype(F)


# ----------------------------------------------------------------------------
# Worley / Voronoi
# ----------------------------------------------------------------------------
class Vor:
    pass


def jitter_points(nx, ny, jitter, r, stagger=0.0):
    """nx*ny grid points in [0,1) with random jitter (fraction of a cell);
    stagger shifts odd rows by that fraction of a cell (brick layouts)."""
    gx, gy = np.meshgrid(np.arange(nx), np.arange(ny))
    px = (gx + 0.5 + (r.random((ny, nx)) - 0.5) * jitter + (gy % 2) * stagger) / nx
    py = (gy + 0.5 + (r.random((ny, nx)) - 0.5) * jitter) / ny
    return np.stack([px.ravel() % 1.0, py.ravel() % 1.0], 1)


def voronoi(pts, x, y, k=3, p=2.0, sx=1.0, sy=1.0):
    """Periodic Voronoi. pts (N,2) uv in [0,1); x,y uv coordinate arrays
    (may be domain-warped). Distances are measured after scaling by (sx,sy).
    Returns Vor with id, f1, f2, edge (distance to cell border), dx, dy
    (uv offset from the site, minimal image)."""
    box = np.array([sx, sy], dtype=np.float64)
    P = np.mod(np.asarray(pts, np.float64) * box, box)
    P[P >= box] = 0.0
    tree = cKDTree(P, boxsize=box)
    q = np.stack([np.mod(x.astype(np.float64) * sx, sx), np.mod(y.astype(np.float64) * sy, sy)], -1).reshape(-1, 2)
    q[q >= box] = 0.0
    d, i = tree.query(q, k=k, p=p, workers=WORKERS)
    shp = x.shape
    V = Vor()
    V.id = i[:, 0].astype(np.int32).reshape(shp)
    V.f1 = d[:, 0].astype(F).reshape(shp)
    V.f2 = d[:, 1].astype(F).reshape(shp)
    if p == 2.0:
        e = None
        a = P[i[:, 0]]
        for j in range(1, k):
            b = P[i[:, j]]
            dd = a - b
            dd -= np.round(dd / box) * box
            sep = np.sqrt((dd ** 2).sum(1)) + 1e-12
            ej = (d[:, j] ** 2 - d[:, 0] ** 2) / (2 * sep)
            e = ej if e is None else np.minimum(e, ej)
        V.edge = e.astype(F).reshape(shp)
    else:
        V.edge = ((d[:, 1] - d[:, 0]) * 0.5).astype(F).reshape(shp)
    pu = np.asarray(pts, np.float64)
    V.dx = wrapd(x - pu[V.id, 0].astype(F)).astype(F)
    V.dy = wrapd(y - pu[V.id, 1].astype(F)).astype(F)
    V.n = len(pts)
    return V


def relax(pts, iters=2, sx=1.0, sy=1.0, res=256):
    """Lloyd relaxation (periodic) - evens out cell sizes."""
    x, y = grid(res)
    pts = np.asarray(pts, np.float64).copy()
    for _ in range(iters):
        V = voronoi(pts, x, y, k=2, sx=sx, sy=sy)
        cnt = np.bincount(V.id.ravel(), minlength=len(pts)) + 1e-9
        mx = np.bincount(V.id.ravel(), V.dx.ravel(), minlength=len(pts)) / cnt
        my = np.bincount(V.id.ravel(), V.dy.ravel(), minlength=len(pts)) / cnt
        pts[:, 0] = (pts[:, 0] + mx) % 1.0
        pts[:, 1] = (pts[:, 1] + my) % 1.0
    return pts


def poisson_points(count, r, relax_iters=1):
    """~count blue-noise-ish points: jittered grid + Lloyd relaxation."""
    g = max(1, int(round(np.sqrt(count))))
    pts = jitter_points(g, g, 1.0, r)
    return relax(pts, relax_iters) if relax_iters else pts


# ----------------------------------------------------------------------------
# scatter / stamping of analytic shapes with periodic wrap
# ----------------------------------------------------------------------------
def stamp(H, cx, cy, half, shape_fn, ID=None, mode="max", chunk=48, drop_q=0.0, id_offset=0):
    """Composite analytic shapes into the periodic height map H (in place).

    cx, cy : centres (uv). half : half size of each square patch (uv).
    shape_fn(u, v, idx) -> (h, mask) with u (B,1,S), v (B,S,1) local coords in
    patch units [-1,1], idx (B,) instance indices; returns h (B,S,S) and bool
    mask (B,S,S).
    mode 'max'  : H = max(H, h) inside mask.
    mode 'drop' : shape rests on the existing surface (base = mean + drop_q*std
                  of H under its footprint), then max-composited. Sequential.
    mode 'add'  : H += h inside mask (dents, footprints).
    ID (optional int32 map) receives idx+id_offset where the shape wins.
    Returns per-instance base heights (zeros for 'max')."""
    n = H.shape[0]
    cx = np.asarray(cx, np.float64)
    cy = np.asarray(cy, np.float64)
    half = np.asarray(half, np.float64)
    N = len(cx)
    hp = np.ceil(half * n).astype(np.int64) + 1
    lad = np.unique(np.ceil(3 * 1.18 ** np.arange(60)).astype(np.int64))
    hp = lad[np.searchsorted(lad, hp)]
    base = np.zeros(N, F)
    i = 0
    while i < N:
        j = i + 1
        while j < N and j - i < chunk and hp[j] == hp[i]:
            j += 1
        idx = np.arange(i, j)
        P = int(hp[i])
        S = 2 * P + 1
        ar = np.arange(S)
        ix0 = np.floor(cx[idx] * n).astype(np.int64) - P
        iy0 = np.floor(cy[idx] * n).astype(np.int64) - P
        u = (((ix0[:, None] + ar[None, :] + 0.5) / n - cx[idx, None]) / half[idx, None]).astype(F)
        v = (((iy0[:, None] + ar[None, :] + 0.5) / n - cy[idx, None]) / half[idx, None]).astype(F)
        hh, mm = shape_fn(u[:, None, :], v[:, :, None], idx)
        for b in range(j - i):
            x0, y0 = int(ix0[b]), int(iy0[b])
            h = hh[b]
            m = mm[b]
            inside = x0 >= 0 and y0 >= 0 and x0 + S <= n and y0 + S <= n
            if inside:
                tgt = H[y0:y0 + S, x0:x0 + S]
            else:
                rows = (y0 + ar) % n
                cols = (x0 + ar) % n
                sel = np.ix_(rows, cols)
                tgt = H[sel]
            if mode == "add":
                tgt += h * m
                if not inside:
                    H[sel] = tgt
                continue
            if mode == "drop":
                vals = tgt[m]
                if vals.size == 0:
                    continue
                bz = float(vals.mean()) + drop_q * float(vals.std())
                base[idx[b]] = bz
                h = h + bz
            w = m & (h > tgt)
            tgt[w] = h[w]
            if not inside:
                H[sel] = tgt
            if ID is not None:
                if inside:
                    ID[y0:y0 + S, x0:x0 + S][w] = idx[b] + id_offset
                else:
                    t2 = ID[sel]
                    t2[w] = idx[b] + id_offset
                    ID[sel] = t2
        i = j
    return base


def blob_fn(angle, aspect, height, lump_amp, lump_ph, p=2.0, q=0.5, tilt=None, size=0.82):
    """Shape function for lumpy rounded stones (superellipsoid domes).
    angle, aspect(>=1), height: (N,). lump_amp/lump_ph: (N,K) angular
    harmonics 2..K+1 of the outline radius. tilt: optional (N,2) slope."""
    def fn(u, v, idx):
        ca = np.cos(angle[idx]).astype(F)[:, None, None]
        sa = np.sin(angle[idx]).astype(F)[:, None, None]
        a = u * ca + v * sa
        b = (-u * sa + v * ca) * aspect[idx].astype(F)[:, None, None]
        r = np.sqrt(a * a + b * b)
        th = np.arctan2(b, a)
        R = np.ones_like(r)
        for k in range(lump_amp.shape[1]):
            R += lump_amp[idx, k].astype(F)[:, None, None] * np.cos((k + 2) * th + lump_ph[idx, k].astype(F)[:, None, None])
        s = r / (R * size)
        m = s < 1.0
        pp = p[idx].astype(F)[:, None, None] if np.ndim(p) else p
        qq = q[idx].astype(F)[:, None, None] if np.ndim(q) else q
        h = height[idx].astype(F)[:, None, None] * (1.0 - np.minimum(s, 1.0) ** pp) ** qq
        if tilt is not None:
            h = h * (1.0 + tilt[idx, 0].astype(F)[:, None, None] * a + tilt[idx, 1].astype(F)[:, None, None] * b)
        return h.astype(F), m
    return fn


def with_offset(fn, zoff):
    """Wrap a shape function so each instance is shifted vertically by zoff[i]
    (e.g. negative = partially buried when max-composited)."""
    def f(u, v, idx):
        h, m = fn(u, v, idx)
        return h + zoff[idx].astype(F)[:, None, None], m
    return f


def pack_discs(r, radii, res=1024, overlap=0.85, tries=10, accept=None):
    """Dart-throwing disc packing on a periodic occupancy raster. radii (uv),
    ideally sorted descending. accept: optional (res,res) probability map.
    Returns x, y, ok (placed)."""
    N = len(radii)
    occ = np.zeros((res, res), bool)
    xs = np.zeros(N)
    ys = np.zeros(N)
    ok = np.zeros(N, bool)
    rnd = r.random((N, tries, 3))
    ang = np.linspace(0, TAU, 7)[:-1]
    ca, sa = np.cos(ang), np.sin(ang)
    for i in range(N):
        rp = radii[i] * res * overlap
        for t in range(tries):
            x, y = rnd[i, t, 0], rnd[i, t, 1]
            px, py = int(x * res), int(y * res)
            if occ[py, px]:
                continue
            if accept is not None and rnd[i, t, 2] > accept[py, px]:
                continue
            if rp >= 1.0:
                qx = (px + (ca * rp).astype(int)) % res
                qy = (py + (sa * rp).astype(int)) % res
                if occ[qy, qx].any():
                    continue
            xs[i], ys[i], ok[i] = x, y, True
            ir = int(rp)
            if ir < 1:
                occ[py, px] = True
            else:
                a = np.arange(-ir, ir + 1)
                disc = (a[:, None] ** 2 + a[None, :] ** 2) <= rp * rp
                sel = np.ix_((py + a) % res, (px + a) % res)
                occ[sel] |= disc
            break
    return xs, ys, ok


def power_radii(r, count, rmin, rmax, alpha=2.7):
    """Radii with pdf ~ r^-alpha between rmin and rmax, sorted descending."""
    u = r.random(count)
    a = 1.0 - alpha
    x = (rmin ** a + u * (rmax ** a - rmin ** a)) ** (1.0 / a)
    return np.sort(x)[::-1]


def course_layout(c, r, row_h, stone_w, wx=None, wy=None, min_shift=0.08):
    """Rows (courses) of random height, each split into stones of random
    width; vertical joints of adjacent rows are kept apart. row_h, stone_w:
    (min, max) in metres. Returns dict(id, n, ex, ey [m to nearest vertical /
    bed joint centre], u, v [0..1 inside stone], w, hgt [stone size m], row)."""
    n, T = c.n, c.tile
    hs = []
    while sum(hs) < T:
        hs.append(r.uniform(*row_h))
    hs = np.array(hs)
    hs *= T / hs.sum()
    ye = np.concatenate([[0.0], np.cumsum(hs)]) / T
    NR = len(hs)
    x = (c.x if wx is None else c.x + wx) % 1.0
    y = (c.y if wy is None else c.y + wy) % 1.0
    row = np.clip(np.searchsorted(ye, y.ravel()) - 1, 0, NR - 1).reshape(n, n)
    v = ((y - ye[row]) / (ye[row + 1] - ye[row])).astype(F)
    hgt = ((ye[row + 1] - ye[row]) * T).astype(F)
    sid = np.zeros((n, n), np.int32)
    u = np.zeros((n, n), F)
    w = np.zeros((n, n), F)
    prev = None
    base = 0
    for l in range(NR):
        for attempt in range(40):
            ws = []
            while sum(ws) < T:
                ws.append(r.uniform(*stone_w))
            ws = np.array(ws)
            ws *= T / ws.sum()
            jp = np.sort((np.cumsum(ws) / T + r.random()) % 1.0)
            if prev is None:
                break
            dmin = np.abs(wrapd(jp[:, None] - prev[None, :])).min() * T
            if dmin > min_shift:
                break
        prev = jp
        m = row == l
        xx = x[m]
        j = np.searchsorted(jp, xx) % len(jp)
        right = jp[j]
        left = jp[j - 1]
        wid = (right - left) % 1.0
        wid = np.where(wid == 0, 1.0, wid)
        u[m] = ((xx - left) % 1.0) / wid
        w[m] = wid * T
        sid[m] = base + j
        base += len(jp)
    ex = np.minimum(u, 1.0 - u) * w
    ey = np.minimum(v, 1.0 - v) * hgt
    return dict(id=sid, n=base, ex=ex.astype(F), ey=ey.astype(F), u=u, v=v, w=w, hgt=hgt, row=row, nrows=NR)


def poly_fn(nrm, dist, height, bevel, tilt=None, dome=0.0):
    """Shape function for angular fragments: convex polygon = intersection of
    K half-planes. nrm (N,K,2) unit normals, dist (N,K) plane offsets (patch
    units, <1). height (N,), bevel (N,) edge bevel width (patch units),
    tilt (N,2) top-face slope, dome extra bulge."""
    K = nrm.shape[1]

    def fn(u, v, idx):
        e = None
        for k in range(K):
            ek = dist[idx, k].astype(F)[:, None, None] - (u * nrm[idx, k, 0].astype(F)[:, None, None]
                                                           + v * nrm[idx, k, 1].astype(F)[:, None, None])
            e = ek if e is None else np.minimum(e, ek)
        m = e > 0
        bv = bevel[idx].astype(F)[:, None, None]
        prof = np.sqrt(np.clip(e / bv, 0, 1))
        h = height[idx].astype(F)[:, None, None] * prof
        if tilt is not None:
            h = h * (1.0 + tilt[idx, 0].astype(F)[:, None, None] * u + tilt[idx, 1].astype(F)[:, None, None] * v)
        if dome:
            h = h * (1.0 + dome * np.clip(e, 0, 1))
        return h.astype(F), m
    return fn


def random_polys(r, N, kmin=4, kmax=7, irregular=0.35):
    """Random convex polygons as half-plane sets -> (nrm (N,K,2), dist (N,K))."""
    K = kmax
    base = (np.arange(K)[None, :] + r.random((N, K)) * 0.8) / K * TAU + r.random((N, 1)) * TAU
    kk = r.integers(kmin, kmax + 1, N)
    nrm = np.stack([np.cos(base), np.sin(base)], -1)
    dist = 0.78 * (1.0 - irregular * r.random((N, K)))
    for i in range(N):  # unused planes pushed far away
        if kk[i] < K:
            # spread the used planes evenly again
            a = (np.arange(kk[i]) + r.random(kk[i]) * 0.8) / kk[i] * TAU + r.random() * TAU
            nrm[i, :kk[i], 0] = np.cos(a)
            nrm[i, :kk[i], 1] = np.sin(a)
            dist[i, kk[i]:] = 9.0
    return nrm.astype(F), dist.astype(F)


def shape_polys(r, N, kmin=4, kmax=7, irregular=0.35, squash=None, angle=None):
    """Random convex polygons, optionally squashed (0..1, 1 = isotropic) along
    one axis and rotated by `angle`. Returns (nrm (N,K,2), dist (N,K))."""
    nrm, dist = random_polys(r, N, kmin, kmax, irregular)
    if squash is not None:
        s = np.asarray(squash, F)[:, None]
        nx = nrm[..., 0]
        ny = nrm[..., 1] / s
        ln = np.sqrt(nx * nx + ny * ny)
        nrm = np.stack([nx / ln, ny / ln], -1)
        dist = np.where(dist < 5, dist / ln, dist)
    if angle is not None:
        ca = np.cos(angle).astype(F)[:, None]
        sa = np.sin(angle).astype(F)[:, None]
        nx = nrm[..., 0] * ca - nrm[..., 1] * sa
        ny = nrm[..., 0] * sa + nrm[..., 1] * ca
        nrm = np.stack([nx, ny], -1)
    return nrm.astype(F), dist.astype(F)


def rrect_dist(a, b, rc):
    """Inside distance of a rounded rectangle given the distances a, b to its
    two nearest sides and a corner radius rc (all same unit)."""
    corner = (a < rc) & (b < rc)
    d = np.minimum(a, b)
    dc = rc - np.hypot(np.maximum(rc - a, 0), np.maximum(rc - b, 0))
    return np.where(corner, dc, d).astype(F)


# ----------------------------------------------------------------------------
# PIL id-buffer rasteriser (lines / polygons) with periodic wrap + supersampling
# ----------------------------------------------------------------------------
class Raster:
    """Draw primitives carrying an integer id; later draws overwrite earlier
    ones (painter's algorithm). resolve() looks up per-id attributes and box
    filters the supersampled buffer down to n."""

    def __init__(self, n, ss=2):
        self.n, self.ss, self.N = n, ss, n * ss
        self.im = Image.new("I", (self.N, self.N), 0)
        self.d = ImageDraw.Draw(self.im)

    def _offsets(self, x0, x1, y0, y1):
        N = self.N
        out = []
        for ox in (0, N, -N):
            if x1 + ox < 0 or x0 + ox >= N:
                continue
            for oy in (0, N, -N):
                if y1 + oy < 0 or y0 + oy >= N:
                    continue
                out.append((ox, oy))
        return out

    def polyline(self, pts, width, val):
        """pts (K,2) uv, width uv."""
        P = np.asarray(pts, np.float64) * self.N
        w = max(1, int(round(width * self.N)))
        for ox, oy in self._offsets(P[:, 0].min() - w, P[:, 0].max() + w, P[:, 1].min() - w, P[:, 1].max() + w):
            self.d.line([(float(a + ox), float(b + oy)) for a, b in P], fill=int(val), width=w)

    def lines(self, x0, y0, x1, y1, width, vals):
        """Many straight segments. coords uv arrays, width uv (array or scalar)."""
        N = self.N
        X0 = np.asarray(x0, np.float64) * N
        Y0 = np.asarray(y0, np.float64) * N
        X1 = np.asarray(x1, np.float64) * N
        Y1 = np.asarray(y1, np.float64) * N
        W = np.maximum(1, np.round(np.broadcast_to(np.asarray(width, np.float64), X0.shape) * N)).astype(int)
        vals = np.asarray(vals).astype(int)
        mnx = np.minimum(X0, X1) - W
        mxx = np.maximum(X0, X1) + W
        mny = np.minimum(Y0, Y1) - W
        mxy = np.maximum(Y0, Y1) + W
        line = self.d.line
        for ox in (0, N, -N):
            for oy in (0, N, -N):
                sel = np.nonzero((mxx + ox >= 0) & (mnx + ox < N) & (mxy + oy >= 0) & (mny + oy < N))[0]
                if ox == 0 and oy == 0:
                    sel = np.arange(len(X0))
                a0 = (X0[sel] + ox).tolist()
                b0 = (Y0[sel] + oy).tolist()
                a1 = (X1[sel] + ox).tolist()
                b1 = (Y1[sel] + oy).tolist()
                ww = W[sel].tolist()
                vv = vals[sel].tolist()
                for k in range(len(sel)):
                    line((a0[k], b0[k], a1[k], b1[k]), fill=vv[k], width=ww[k])

    def polygon(self, pts, val):
        P = np.asarray(pts, np.float64) * self.N
        for ox, oy in self._offsets(P[:, 0].min(), P[:, 0].max(), P[:, 1].min(), P[:, 1].max()):
            self.d.polygon([(float(a + ox), float(b + oy)) for a, b in P], fill=int(val))

    def ellipse(self, cx, cy, rx, ry, val):
        N = self.N
        x0, x1, y0, y1 = (cx - rx) * N, (cx + rx) * N, (cy - ry) * N, (cy + ry) * N
        for ox, oy in self._offsets(x0, x1, y0, y1):
            self.d.ellipse((x0 + ox, y0 + oy, x1 + ox, y1 + oy), fill=int(val))

    def ids(self):
        return np.asarray(self.im, dtype=np.int32)

    def resolve(self, table, ids=None):
        """table (count,) or (count,k) float -> (n,n[,k]) box-filtered."""
        ids = self.ids() if ids is None else ids
        t = np.asarray(table, F)
        a = t[ids]
        n, ss = self.n, self.ss
        if a.ndim == 2:
            return a.reshape(n, ss, n, ss).mean((1, 3)).astype(F)
        return a.reshape(n, ss, n, ss, -1).mean((1, 3)).astype(F)


def crack_map(n, r, count, length=(0.08, 0.35), step=0.004, wander=0.5, kink=0.06,
              branch=0.12, width=(0.6, 1.6), heading=None, spread=np.pi, ss=3, taper=True, starts=None,
              revert=0.0, branch_angle=(0.5, 1.3)):
    """Random-walk crack network rasterised with AA. Returns 0..1 coverage map.
    length uv range; width in output pixels (root width range); heading/spread
    constrain the initial direction (radians)."""
    N = n * ss
    im = Image.new("L", (N, N), 0)
    d = ImageDraw.Draw(im)
    todo = []
    for _ in range(count):
        th = (r.random() * TAU) if heading is None else heading + (r.random() - 0.5) * 2 * spread + (np.pi if r.random() < 0.5 else 0)
        if starts is not None:
            k = r.integers(len(starts))
            sx0, sy0 = float(starts[k][0]), float(starts[k][1])
        else:
            sx0, sy0 = r.random(), r.random()
        todo.append((sx0, sy0, th, r.uniform(*length), r.uniform(*width), 0))
    while todo:
        x, y, th, L, w, depth = todo.pop()
        ns = max(2, int(L / step))
        dth = r.standard_normal(ns) * wander * np.sqrt(step / 0.004) * 0.25
        kk = r.random(ns) < kink
        dth[kk] += r.standard_normal(kk.sum()) * 0.7
        if revert > 0:
            from scipy.signal import lfilter
            ths = th + lfilter([1.0], [1.0, -(1.0 - revert)], dth)
        else:
            ths = th + np.cumsum(dth)
        xs = x + np.cumsum(np.cos(ths)) * step
        ys = y + np.cumsum(np.sin(ths)) * step
        for sgm in range(0, ns - 1, 6):
            t = sgm / ns
            ww = w * ((1 - t) ** 0.7 if taper else 1.0)
            wpx = max(1, int(round(ww * ss)))
            val = int(255 * min(1.0, ww * ss / wpx))
            seg = np.stack([xs[sgm:sgm + 7], ys[sgm:sgm + 7]], 1) * N
            for ox in (0, N, -N):
                if seg[:, 0].max() + ox < 0 or seg[:, 0].min() + ox >= N:
                    continue
                for oy in (0, N, -N):
                    if seg[:, 1].max() + oy < 0 or seg[:, 1].min() + oy >= N:
                        continue
                    d.line([(float(a + ox), float(b + oy)) for a, b in seg], fill=val, width=wpx)
        if depth < 3:
            nb = r.poisson(branch * ns * step / 0.05)
            for _ in range(nb):
                k = r.integers(1, ns - 1)
                todo.append((xs[k], ys[k], (th if revert > 0 else ths[k]) + r.choice([-1, 1]) * r.uniform(*branch_angle),
                             L * r.uniform(0.25, 0.6), w * r.uniform(0.5, 0.8), depth + 1))
    a = np.asarray(im, dtype=F) / 255.0
    return a.reshape(n, ss, n, ss).mean((1, 3)).astype(F)


# ----------------------------------------------------------------------------
# colour helpers (albedo is authored directly in sRGB 0..1)
# ----------------------------------------------------------------------------
def rgb(r, g=None, b=None):
    if isinstance(r, str):
        s = r.lstrip("#")
        r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    return np.array([r, g, b], F) / 255.0


def ramp(t, stops):
    """Piecewise-linear colour ramp. stops: [(pos, (r,g,b) 0..255), ...]."""
    pos = np.array([s[0] for s in stops], np.float64)
    cols = np.array([s[1] for s in stops], np.float64) / 255.0
    out = np.empty(t.shape + (3,), F)
    for i in range(3):
        out[..., i] = np.interp(t, pos, cols[:, i])
    return out


def mix(a, b, t):
    """Blend colour a towards colour b by mask t (n,n)."""
    t = np.asarray(t, F)[..., None]
    return (a + (np.asarray(b, F) - a) * t).astype(F)


def lum(c):
    return (c[..., 0] * 0.3 + c[..., 1] * 0.59 + c[..., 2] * 0.11).astype(F)


def adjust(c, sat_mul=1.0, val_mul=1.0):
    """Per-pixel (arrays allowed) saturation / value multiply."""
    L = lum(c)[..., None]
    s = np.asarray(sat_mul, F)
    v = np.asarray(val_mul, F)
    if s.ndim == 2:
        s = s[..., None]
    if v.ndim == 2:
        v = v[..., None]
    return ((L + (c - L) * s) * v).astype(F)


def palette_pick(r, count, colors, weights, jitter=0.04):
    """Per-element base colours picked from a weighted palette with jitter."""
    colors = np.array(colors, F) / 255.0
    w = np.array(weights, np.float64)
    k = r.choice(len(colors), size=count, p=w / w.sum())
    col = colors[k] * (1.0 + r.standard_normal((count, 1)).astype(F) * jitter * 1.5)
    warm = r.standard_normal((count, 1)).astype(F) * jitter * 0.45      # warm <-> cool axis only
    col = col * (1.0 + warm * np.array([1.0, 0.2, -1.0], F))
    col += r.standard_normal((count, 3)).astype(F) * jitter * 0.05
    return np.clip(col, 0.02, 1.0).astype(F), k


# ----------------------------------------------------------------------------
# context: physical units + named deterministic seeds
# ----------------------------------------------------------------------------
class Ctx:
    def __init__(self, name, n, tile_m, seed=1):
        self.name, self.n, self.tile, self.seed = name, int(n), float(tile_m), seed
        self.ppm = self.n / self.tile       # pixels per metre
        self.px = self.tile / self.n        # metres per pixel
        self.x, self.y = grid(self.n)

    def sd(self, tag):
        return seed_of(self.name, self.seed, tag)

    def rng(self, tag):
        return np.random.default_rng(self.sd(tag))

    def noise(self, tag, lmax, lmin=None, H=1.0, sx=1.0, sy=1.0):
        """Gaussian noise (std 1) with wavelengths lmin..lmax in metres."""
        f_hi = None if lmin is None else self.tile / lmin
        return spectral(self.n, self.sd(tag), self.tile / lmax, f_hi, H, sx, sy)

    def blur(self, a, sig_m, sig_y_m=None):
        return blur(a, sig_m * self.ppm, None if sig_y_m is None else sig_y_m * self.ppm)

    def warp_m(self, a, dx_m, dy_m):
        return warp(a, dx_m * self.ppm, dy_m * self.ppm)

    def fbm(self, tag, lmax, octaves=5, gain=0.5, mode="fbm", x=None, y=None):
        return fbm(self.x if x is None else x, self.y if y is None else y,
                   self.tile / lmax, octaves, 2.0, gain, self.sd(tag), mode)

    def voronoi(self, pts, k=3, p=2.0, sx=1.0, sy=1.0, wx=None, wy=None):
        x = self.x if wx is None else self.x + wx
        y = self.y if wy is None else self.y + wy
        return voronoi(pts, x, y, k, p, sx, sy)

    def curv(self, h, sig_m):
        return curvature(h, sig_m * self.ppm)


# ----------------------------------------------------------------------------
# output
# ----------------------------------------------------------------------------
def _to8(a, r):
    a = np.clip(a, 0.0, 1.0) * 255.0 + (r.random(a.shape, dtype=F) - 0.5) * 0.9
    return np.clip(np.rint(a), 0, 255).astype(np.uint8)


def finalize(c, out, out_dir, nstrength=1.0, ao_radius=None, ao_gain=1.0, ao_floor=0.0):
    """out: dict(h=[metres], col=[n,n,3 sRGB 0..1], rough=[n,n]) (+ optional
    'mask', 'ao_mul'). Derives normal + AO from the height and writes
    <name>_col.jpg, _nrm.jpg, _arh.jpg. Returns metadata dict."""
    os.makedirs(out_dir, exist_ok=True)
    h = out["h"].astype(F)
    hmin, hmax = float(h.min()), float(h.max())
    relief = max(hmax - hmin, 1e-6)
    h01 = (h - hmin) / relief
    nrm = normal_map(h, c.px, nstrength)
    rad = ao_radius if ao_radius is not None else max(relief * 1.5, 6 * c.px)
    ao = ao_horizon(h, c.px, rad)
    ao = sat(1.0 - (1.0 - ao) * ao_gain)
    if "ao_mul" in out:
        ao = ao * out["ao_mul"]
    ao = np.maximum(ao, ao_floor)
    r = np.random.default_rng(seed_of(c.name, "dither"))
    col = np.clip(out["col"], 25.0 / 255.0, 235.0 / 255.0)
    Image.fromarray(_to8(col, r)).save(os.path.join(out_dir, c.name + "_col.jpg"), quality=92, optimize=True)
    Image.fromarray(_to8(nrm * 0.5 + 0.5, r)).save(os.path.join(out_dir, c.name + "_nrm.jpg"),
                                                   quality=95, subsampling=0, optimize=True)
    arh = np.stack([ao, sat(out["rough"]), h01], -1)
    Image.fromarray(_to8(arh, r)).save(os.path.join(out_dir, c.name + "_arh.jpg"),
                                       quality=92, subsampling=0, optimize=True)
    if "mask" in out:
        Image.fromarray(_to8(out["mask"], r)).save(os.path.join(out_dir, c.name + "_mask.jpg"),
                                                   quality=92, optimize=True)
    return {"tile_m": c.tile, "size": c.n, "relief_m": round(relief, 5)}
