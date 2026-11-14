# Texture synthesis for the helicopter (project venv: numpy, scipy, Pillow).
# Reads the bakes in _work/ (position, normal, part id, edge, AO per texel) and writes
# heli_<group>_{base,nrm,orm}.png plus the rotor blur heli_disc.png. Every colour here is sRGB.
import os, sys, time
import numpy as np
from PIL import Image
from scipy import ndimage as nd

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
WORK = os.path.join(HERE, '_work')
import heli_geo as H
T0 = time.time()


def log(*a): print('[tex %5.1fs]' % (time.time() - T0), *a, flush=True)


def hash3(i, j, k, seed):
    h = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791) ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177; h = h ^ (h >> 16)
    return (h & 0xffffff).astype(np.float32) / 16777215.0


def vnoise(p, seed=0):
    f = np.floor(p); t = (p - f).astype(np.float32); i = f.astype(np.int64); t = t * t * (3 - 2 * t)
    acc = np.zeros(len(p), np.float32)
    for dx in (0, 1):
        wx = t[:, 0] if dx else 1 - t[:, 0]
        for dy in (0, 1):
            wy = t[:, 1] if dy else 1 - t[:, 1]
            for dz in (0, 1):
                wz = t[:, 2] if dz else 1 - t[:, 2]
                acc += wx * wy * wz * hash3(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return acc


def fbm(p, oct=4, seed=0):
    s = np.zeros(len(p), np.float32); a = 0.5; tot = 0
    for o in range(oct): s += a * vnoise(p * (2.0 ** o), seed + o * 7); tot += a; a *= 0.5
    return s / tot


def sstep(a, b, x): x = np.clip((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x)


def per(v, p, off=0.0): return np.abs(((v - off) / p + 0.5) % 1 - 0.5) * p


def mix(a, b, t): t = np.asarray(t, np.float32)[..., None] if np.ndim(t) == 1 else t; return a + (b - a) * t


C = lambda *v: np.array(v, np.float32)
# id: (sRGB colour, roughness, metalness)
TAB = {
    H.HULL: (C(.305, .322, .225), .66, 0), H.WALK: (C(.17, .18, .15), .85, 0), H.SEAL: (C(.035, .035, .035), .8, 0),
    H.EXH: (C(.28, .25, .22), .55, .7), H.INTAKE: (C(.05, .05, .05), .7, .3), H.LOUVRE: (C(.18, .19, .14), .7, 0),
    H.RAIL: (C(.36, .36, .34), .45, .8), H.SOOT: (C(.02, .02, .02), .9, 0), H.GEARP: (C(.29, .31, .22), .62, 0),
    H.LINING: (C(.64, .63, .55), .9, 0), H.INTP: (C(.52, .55, .47), .6, 0), H.FLOOR: (C(.27, .28, .25), .75, 0),
    H.CANVAS: (C(.44, .16, .11), .9, 0), H.ALUT: (C(.64, .64, .62), .38, 1), H.WEB: (C(.30, .30, .20), .85, 0),
    H.BUCKLE: (C(.62, .62, .60), .3, 1), H.PANEL: (C(.13, .13, .13), .6, 0), H.DIAL: (C(.025, .025, .025), .35, 0),
    H.WHITE: (C(.88, .88, .84), .5, 0), H.CABLE: (C(.07, .07, .07), .7, 0), H.SEATA: (C(.40, .42, .33), .55, 0),
    H.CUSH: (C(.31, .31, .29), .9, 0), H.RED: (C(.55, .08, .06), .4, 0), H.TIEDOWN: (C(.55, .55, .53), .4, 1),
    H.SWITCH: (C(.75, .75, .73), .3, 1), H.SCREEN: (C(.03, .05, .04), .12, 0),
    H.STEEL: (C(.56, .56, .55), .36, 1), H.DARK: (C(.09, .09, .085), .48, .2), H.RUBBER: (C(.04, .04, .04), .8, 0),
    H.BLADE: (C(.15, .16, .15), .5, 0), H.TIP: (C(.62, .50, .16), .5, 0), H.ALU: (C(.62, .62, .60), .45, 1),
    H.ANT: (C(.07, .07, .07), .55, 0), H.LE: (C(.62, .62, .62), .3, 1),
    H.SUIT: (C(.36, .38, .29), .9, 0), H.VEST: (C(.27, .26, .19), .85, 0), H.HELMET: (C(.31, .33, .27), .45, 0),
    H.VISOR: (C(.03, .03, .035), .06, .6), H.SKIN: (C(.60, .44, .35), .55, 0), H.GLOVE: (C(.11, .10, .09), .75, 0),
    H.BOOT: (C(.10, .08, .06), .7, 0), H.BLACK: (C(.04, .04, .04), .7, 0), H.GLASS: (C(.20, .23, .23), .05, 0),
}
PAINTED = [H.HULL, H.GEARP, H.INTP, H.SEATA, H.WALK, H.LOUVRE, H.TIP, H.BLADE, H.DARK, H.HELMET]


def seams(P, Nn, tw):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    side = np.abs(Nn[:, 2]) < 0.72
    boom = y < -4.3
    pe = np.where(boom, 0.62, 0.55)
    dfr = per(y, pe, 0.1)                                  # every frame carries a rivet row
    dsy = per(y, pe * 2, 0.1)                              # every second frame is a skin joint
    dz = np.min(np.abs(z[:, None] - np.array([1.06, 1.97, 2.37])[None, :]), 1)
    dx = np.abs(np.abs(x) - 0.42)
    dl = np.where(boom, per(np.arctan2(z - H.boom_cz(y), x) * 0.3, 0.45), np.where(side, dz, dx))
    w = 0.0035 + tw * 0.7
    groove = np.clip(1 - np.minimum(dsy, dl) / w, 0, 1)
    along = np.where(side, z, x)
    r1 = np.hypot(dfr, per(along, 0.042))
    r2 = np.hypot(np.abs(dl - 0.02), per(y, 0.042))
    rv = np.exp(-(np.minimum(r1, r2) / (0.003 + tw * 0.35)) ** 2)
    pid = np.floor((y - 0.1) / (pe * 2)) * 7 + np.floor(np.where(side, z / 0.91, x / 0.84 + 9)) * 3 + (x > 0)
    tone = hash3(pid.astype(np.int64), np.zeros_like(pid, np.int64), np.zeros_like(pid, np.int64), 5)
    return groove, rv, tone


HATCH = [(3.52, 4.12, 1.02, 1.40), (-3.12, -2.48, 0.98, 1.34), (-4.12, -3.52, 1.55, 2.08), (1.35, 1.80, 0.95, 1.18)]


def hatches(P, Nn, sel, base, h, tw):
    """access panels on both flanks: a groove round each, quarter-turn latches as dimples, a slight tone change"""
    I = np.nonzero(sel)[0]
    I = I[np.abs(Nn[I, 0]) > 0.45]
    if not len(I): return
    y, z = P[I, 1], P[I, 2]
    for y0, y1, z0, z1 in HATCH:
        sd = np.maximum(np.maximum(y0 - y, y - y1), np.maximum(z0 - z, z - z1))
        g = np.clip(1 - np.abs(sd) / (0.003 + tw * 0.7), 0, 1)
        base[I] = mix(base[I], C(.07, .07, .05), 0.75 * g); h[I] += -0.0018 * g
        base[I[sd < 0]] *= 0.96
        for ly in (y0 + 0.07, y1 - 0.07):
            for lz in (z1 - 0.045, z0 + 0.045):
                r = np.hypot(y - ly, z - lz); d = np.exp(-(r / 0.011) ** 2); ring = np.exp(-((r - 0.013) / 0.0035) ** 2)
                base[I] = mix(base[I], C(.16, .16, .13), 0.8 * d); h[I] += -0.0006 * d + 0.0004 * ring


def _txt(s, px=56):
    from PIL import ImageFont, ImageDraw
    try: f = ImageFont.load_default(size=px)
    except Exception: f = ImageFont.load_default()
    l, t_, r, b = f.getbbox(s); im = Image.new('L', (r - l + 4, b - t_ + 4), 0)
    ImageDraw.Draw(im).text((2 - l, 2 - t_), s, fill=255, font=f)
    return np.asarray(im, np.float32) / 255


def decal(P, Nn, sel, c, n, u, hgt, s):
    c, n, u = (np.asarray(a, np.float32) for a in (c, n, u)); v = np.cross(n, u)
    img = _txt(s); Hh, W = img.shape
    q = P - c; lu, lv, ln = q @ u, q @ v, q @ n
    px = (lu / (hgt * W / Hh) + 0.5) * W; py = (0.5 - lv / hgt) * Hh
    ok = sel & (np.abs(ln) < 0.1) & (Nn @ n > 0.35) & (px >= 0) & (px < W - 1) & (py >= 0) & (py < Hh - 1)
    out = np.zeros(len(P), np.float32)
    if ok.any(): out[ok] = nd.map_coordinates(img, [py[ok], px[ok]], order=1)
    return out


def side_pt(y, z, sx):
    p = H.S(y, H.side_angle(y, z)); return np.array([sx * p[0], y, z], np.float32)


def stencils(P, Nn, sel, base, h):
    """small generic stencils, no insignia: step / no step, fuel, rotor warning, door handle"""
    BLK, BUF = C(.05, .05, .045), C(.60, .58, .47)
    items = []
    for sx in (-1, 1):
        n = (sx, 0, 0); u = (0, sx, 0)
        items += [(side_pt(2.62, 1.06, sx), n, u, 0.045, 'STEP', BLK), (side_pt(2.32, 1.10, sx), n, u, 0.024, 'PUSH TO OPEN', BLK),
                  (side_pt(1.58, 1.62, sx), n, u, 0.03, 'STEP', BLK), (side_pt(-3.0, 1.22, sx), n, u, 0.024, 'GROUND HERE', BLK),
                  (side_pt(-3.82, 1.86, sx), n, u, 0.03, 'BAGGAGE  MAX 180 KG', BLK)]
        y = -8.25; items.append(((sx * float(H.boom_r(y)), y, float(H.boom_cz(y)) - 0.02), n, u, 0.075, 'KEEP CLEAR', BUF))
        y = -8.35; items.append(((sx * float(H.boom_r(y)), y, float(H.boom_cz(y)) - 0.11), n, u, 0.045, 'TAIL ROTOR', BUF))
        items += [((sx * 1.0, -7.56, 2.45), (0, 0, 1), (sx, 0, 0), 0.06, 'NO STEP', BUF),
                  ((sx * 0.62, -1.4, 3.17), (0, 0, 1), (0, 1, 0), 0.06, 'NO STEP', BUF)]
    items += [(side_pt(-2.7, 1.80, 1), (1, 0, 0), (0, 1, 0), 0.045, 'FUEL', BLK), (side_pt(-2.7, 1.73, 1), (1, 0, 0), (0, 1, 0), 0.026, 'JP-8  F-34', BLK),
              (side_pt(-2.7, 1.32, 1), (1, 0, 0), (0, 1, 0), 0.024, 'PRESSURE REFUEL >', BLK)]
    for c, n, u, hgt, s, col in items:
        a = decal(P, Nn, sel, c, n, u, hgt, s)
        if a.any():
            base[:] = mix(base, col, 0.85 * a); h[:] += 0.00002 * a


def group(k, size):
    pid = np.load(os.path.join(WORK, f'{k}_pid.npy')); mask = pid[..., 0] > 0.5 / 64
    pos = np.load(os.path.join(WORK, f'{k}_pos.npy'))[..., :3]
    nrm_ = np.load(os.path.join(WORK, f'{k}_nrm.npy')).astype(np.float32)[..., :3]
    have = os.path.exists(os.path.join(WORK, f'{k}_ao.npy'))
    ao = np.load(os.path.join(WORK, f'{k}_ao.npy')).astype(np.float32)[..., 0] if have else np.ones(mask.shape, np.float32)
    edge = np.load(os.path.join(WORK, f'{k}_edge.npy')).astype(np.float32)[..., 0] if have else np.ones(mask.shape, np.float32)
    if have:   # the AO bake is noisy at 20 samples: a light blur inside the islands
        w = nd.gaussian_filter(mask.astype(np.float32), 1.2); ao = np.where(mask, nd.gaussian_filter(ao * mask, 1.2) / np.maximum(w, 1e-3), 1)
    idx = np.nonzero(mask); P = pos[idx].astype(np.float32); Nn = nrm_[idx]; N = len(P)
    P[:, 2] -= H.DZ      # back to the design heights (the body was lowered by DZ); all the rules below use them
    mid = np.rint(pid[idx][:, 0] * 64).astype(int); prand = pid[idx][:, 1]; A = np.clip(ao[idx], 0, 1)
    E = np.clip((1 - edge[idx]) * 7, 0, 1)
    d = np.linalg.norm(np.diff(pos, axis=1), axis=-1); ok = mask[:, 1:] & mask[:, :-1] & (d < 0.05) & (d > 1e-5); tw = float(np.median(d[ok]))
    log(k, N, 'texels, texel', round(tw * 1000, 2), 'mm')
    base = np.zeros((N, 3), np.float32); rough = np.zeros(N, np.float32); metal = np.zeros(N, np.float32); h = np.zeros(N, np.float32)
    for i, (c, r, m) in TAB.items():
        s = mid == i; base[s] = c; rough[s] = r; metal[s] = m
    base *= (0.94 + 0.12 * prand)[:, None]
    n1 = fbm(P * 1.3, 4, 1); n2 = fbm(P * 9.0, 4, 2); n3 = fbm(P * 38.0, 3, 3)
    up = np.clip(Nn[:, 2], 0, 1); side = 1 - np.abs(Nn[:, 2])
    paint = np.isin(mid, PAINTED)
    # --- painted olive skin: panels, rivets, fading, streaks, soot, chips
    hullm = (mid == H.HULL) | (mid == H.GEARP)
    if hullm.any():
        g, rv, tone = seams(P[hullm], Nn[hullm], tw)
        b = base[hullm]
        b *= (0.93 + 0.12 * tone + 0.10 * (n1[hullm] - 0.5))[:, None]
        b = mix(b, C(.42, .43, .36), 0.22 * up[hullm] * sstep(0.35, 0.75, n1[hullm]))          # sun-faded tops
        b = mix(b, C(.09, .09, .06), 0.7 * g)                                              # dirt in the joints
        b = mix(b, C(.40, .41, .33), 0.25 * rv)                                             # worn rivet heads
        h[hullm] += -0.0018 * g + 0.0005 * rv
        base[hullm] = b
        hatches(P, Nn, hullm, base, h, tw)
    # rain / oil streaks running down the sides, dust low on the body
    st = fbm(np.stack([P[:, 0] * 16, P[:, 1] * 16, P[:, 2] * 0.8], 1), 3, 21)
    streak = sstep(0.52, 0.8, st) * side * paint
    base = mix(base, C(.14, .13, .10), 0.32 * streak); rough += 0.08 * streak
    dust = sstep(1.4, 0.75, P[:, 2]) * sstep(0.35, 0.7, n2) * paint
    base = mix(base, C(.44, .40, .32), 0.35 * dust)
    # exhaust soot along the cowl and the boom
    for sx in (-1, 1):
        o = np.array([sx * 0.64, -3.30, 3.38], np.float32); dv = np.array([sx * 0.18, -1.0, -0.22], np.float32); dv /= np.linalg.norm(dv)
        q = P - o; t = q @ dv; rr = np.linalg.norm(q - t[:, None] * dv, axis=1)
        soot = np.exp(-(rr / (0.22 + 0.10 * np.clip(t, 0, 8))) ** 2) * np.exp(-np.clip(t, 0, None) / 2.6) * (t > -0.5) * (0.5 + 0.7 * n2) * (0.7 + 0.5 * st)
        base = mix(base, C(.035, .033, .03), np.clip(soot, 0, 0.85) * (mid != H.SOOT)); rough += 0.15 * soot
    # chipped paint: primer ring, bare aluminium inside
    wear = E * 0.9 + (n2 - 0.5) * 0.9 + 0.25 * (n3 - 0.5)
    wear += 0.35 * ((mid == H.GEARP) & (P[:, 2] < 0.12)) + 0.25 * (mid == H.WALK)
    wear += 0.3 * ((np.abs(P[:, 1]) < 1.15) & (P[:, 2] < 1.0) & (np.abs(P[:, 0]) > 0.85))                # door sills
    spots = sstep(0.80, 0.86, fbm(P * 26.0, 2, 9)) * 0.6
    chip = np.clip((wear + spots - 0.62) * 14, 0, 1) * paint
    primer = np.clip((wear + spots - 0.52) * 14, 0, 1) * paint - chip
    bare = C(.60, .60, .58) if True else None
    base = mix(base, C(.46, .47, .33), 0.7 * primer)
    base = mix(base, bare, chip); metal = metal + (0.9 - metal) * chip; rough = rough + (0.38 - rough) * chip
    h += -0.00009 * np.clip(chip + primer, 0, 1) * paint
    # cabin lining quilt, floor, fabrics
    s = mid == H.LINING
    if s.any():
        u = P[s, 1]; v = np.where(np.abs(Nn[s, 2]) > 0.6, P[s, 0], P[s, 2])
        st_ = np.minimum(per(u + v, 0.17), per(u - v, 0.17))
        h[s] += 0.004 * sstep(0.0, 0.035, st_); base[s] *= (0.75 + 0.25 * sstep(0.0, 0.02, st_))[:, None]
    s = mid == H.FLOOR
    if s.any():
        g = np.minimum(per(P[s, 1], 0.9, 0.3), per(P[s, 0], 0.8, 0.0)); gl = np.clip(1 - g / (0.002 + tw * 0.5), 0, 1)
        scr = np.exp(-(np.hypot(np.minimum(per(P[s, 1], 0.9, 0.3), per(P[s, 0], 0.8)), per(P[s, 1] + P[s, 0], 0.15)) / 0.006) ** 2)
        walk = sstep(0.7, 0.2, np.abs(P[s, 0] - 0.4)) * 0.5 + sstep(0.85, 0.5, np.abs(P[s, 0])) * 0.3
        base[s] = mix(base[s], C(.33, .33, .30), np.clip(walk * (0.5 + n2[s]), 0, 1) * 0.6)
        base[s] = mix(base[s], C(.05, .05, .05), 0.6 * gl); h[s] += -0.0008 * gl + 0.0004 * scr + 0.0002 * n3[s]
        rough[s] -= 0.15 * walk
    for i, amp in ((H.CANVAS, 0.0004), (H.WEB, 0.0003), (H.SUIT, 0.0006), (H.VEST, 0.0005), (H.CUSH, 0.0004)):
        s = mid == i
        if s.any():
            h[s] += amp * (n3[s] - 0.5) * 2; base[s] *= (0.85 + 0.3 * n2[s])[:, None]
    s = mid == H.SUIT
    if s.any(): h[s] += 0.002 * sstep(0.45, 0.65, fbm(P[s] * 14, 2, 31))
    # metal: grime in the recesses, oil sheen
    s = np.isin(mid, [H.STEEL, H.ALU, H.ALUT, H.RAIL, H.LE, H.TIEDOWN, H.EXH])
    base[s] = mix(base[s], C(.12, .11, .09), np.clip((1 - A[s]) * 1.4 + 0.25 * (n2[s] - 0.5), 0, 0.8))
    rough[s] += 0.12 * (n2[s] - 0.5)
    s = mid == H.EXH
    if s.any(): base[s] = mix(base[s], C(.22, .17, .12), 0.6 * n1[s])
    s = mid == H.GLASS
    if s.any():
        dirt = sstep(0.45, 0.85, fbm(P[s] * 4, 4, 41)) * 0.6 + 0.3 * streak[s]
        base[s] = mix(base[s], C(.45, .42, .34), dirt); rough[s] = 0.04 + 0.5 * dirt
    # cavity darkening from AO, general grime
    base *= ((0.84 + 0.16 * A) if k in ('cabin', 'crew') else (0.62 + 0.38 * A))[:, None]
    base = mix(base, C(.13, .12, .09), 0.35 * (1 - A) * paint)
    h += (0.00003 * (n3 - 0.5) + 0.00004 * (fbm(P * 90.0, 2, 77) - 0.5)) * paint      # orange-peel micro relief
    if k in ('paint', 'top'): stencils(P, Nn, mid == H.HULL, base, h)
    rough = np.clip(rough + 0.05 * (n2 - 0.5), 0.04, 1); metal = np.clip(metal, 0, 1)
    # back to images, fill the gutters with the nearest texel
    def img(vals, ch):
        out = np.zeros(mask.shape + (ch,), np.float32); out[idx] = vals.reshape(N, ch); return out
    _, (iy, ix) = nd.distance_transform_edt(~mask, return_indices=True)
    fill = lambda a: a[iy, ix]
    Bimg = fill(img(base, 3)); R = fill(img(rough, 1))[..., 0]; M = fill(img(metal, 1))[..., 0]; Hh = fill(img(h, 1))[..., 0]
    Aimg = fill(img(A, 1))[..., 0]
    gy, gx = np.gradient(Hh / tw)
    nn = np.stack([-gx * 1.0, -gy * 1.0, np.ones_like(gx)], -1); nn /= np.linalg.norm(nn, axis=-1, keepdims=True)
    save = lambda a, n: Image.fromarray(np.flipud(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8))).save(os.path.join(WORK, f'heli_{k}_{n}.png'))
    save(np.clip(Bimg, 0, 1), 'base'); save(nn * 0.5 + 0.5, 'nrm'); save(np.stack([Aimg, R, M], -1), 'orm')
    log(k, 'written')


def disc_tex(size=1024):
    """the turning rotor seen as a disc: luminance = opacity (the game uses it as an alpha map).
    Soft and streaky like a photographed rotor: densest at the roots, thinning to almost nothing at the tips, no tip ring."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32); u = (x + 0.5) / size * 2 - 1; v = (y + 0.5) / size * 2 - 1
    r = np.hypot(u, v); a = np.arctan2(v, u)
    r0 = 0.55 / H.ROTOR_R; rn = np.clip((r - r0) / (1 - r0), 0, 1)
    sm = np.zeros_like(r)
    for k in range(4):        # each blade with a long trailing smear
        d = (a - k * np.pi / 2) % (2 * np.pi); sm += np.exp(-d / 1.1)
    sm = sm / sm.max()
    z0 = np.zeros(r.size, np.float32)
    rings = vnoise(np.stack([r.ravel() * 140, z0, z0], 1).astype(np.float32), 3).reshape(r.shape)
    rings2 = vnoise(np.stack([r.ravel() * 45, z0, z0], 1).astype(np.float32), 8).reshape(r.shape)
    dens = 0.36 * (1 - 0.82 * rn ** 0.6) + 0.03
    alpha = dens * (0.6 + 0.4 * sm) * (0.65 + 0.45 * rings) * (0.8 + 0.35 * rings2)
    alpha += 0.10 * np.exp(-((rn - 0.06) / 0.05) ** 2)       # blade roots and grips
    alpha *= sstep(r0, r0 + 0.04, r) * sstep(1.0, 0.94, r)
    Image.fromarray(np.clip(alpha * 255, 0, 255).astype(np.uint8)).convert('RGB').save(os.path.join(WORK, 'heli_disc.png'))


if __name__ == '__main__':
    only = sys.argv[1:]
    for k, s in (('paint', 2048), ('top', 2048), ('cabin', 2048), ('mech', 2048), ('crew', 1024)):
        if not only or k in only: group(k, s)
    disc_tex(); log('disc written')
