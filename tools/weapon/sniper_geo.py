# Valle Morta - bolt-action precision rifle (7.62x51), clean-sheet geometry. Millimetres, Blender axes (+X right, +Y muzzle, +Z up), origin at the top of the pistol grip.
# Layout constants are shared with w_sniper.py (grips / clips) and surf.hook_sniper (texture detail). Overall length 1147 mm (butt pad -347 .. brake 800).
import math, bmesh
from math import radians, sin, cos, pi, sqrt
from mathutils import Vector, Matrix
from geo import B, V, box, prism, loft, lathe, cyl, dome, rrect, thick, smooth2, perp, boolean_diff, tube, STEEL, MAGS, BOLT, BRASS
import geo as _geo, sys as _sys
from pistol_geo import lathe2

POLY, RUBBER, GLASS, BLUED, ALU, COPPER, WHITE, DARK, PARK, RED, OLIVE = 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26
BZ, SZ = 48.0, 108.0                                   # bore axis / scope axis height
YH, FACE, TRAV, LIFT = -8.0, 176.0, 105.0, 62.0        # bolt node origin (handle root), bolt face closed, bolt travel, handle lift (deg, rotation -LIFT about +Y)
KNOB = (48.0, -26.0, 32.0)                             # bolt knob centre, bolt closed
TRIG = (40.0, 14.0); TPAD = (1.5, 40.5, -2.0)          # trigger pivot (y, z), finger pad point on the trigger face
GT = V(0, -4.0, 10.0); GA = radians(15); AD = V(0, -sin(GA), -cos(GA)); FD = V(0, cos(GA), -sin(GA)); UF, GW = 24.0, 15.5   # grip top, rake, axis, forward normal, front strap, half width
MAGY, MAGL, MAGW, MAGT, MAGB = 135.0, 37.0, 12.8, 36.0, -40.0   # magazine centre y, half length, half width, top, bottom of the body
BIP = (16.0, 430.0, -12.0); YT = 70.0                  # bipod leg pivots (|x|, y, z); turret axis y
ORIG = dict(Scope=(0, 0, SZ), BoltHandle=(0, YH, BZ), Striker=(0, -64, BZ), Magazine=(0, MAGY, MAGT), MagRounds=(0, MAGY, MAGT), Trigger=(0, TRIG[0], TRIG[1]),
            BipodL=(-BIP[0], BIP[1], BIP[2]), BipodR=(BIP[0], BIP[1], BIP[2]), Casing=(0, FACE, BZ))
C308 = [(0, 5.0), (0.6, 5.98), (1.4, 5.98), (1.7, 5.2), (2.7, 5.2), (3.3, 5.95), (39.5, 5.72), (43.6, 4.45), (51.0, 4.38)]
B308 = [(51.0, 3.95), (57.0, 3.92), (63.0, 3.2), (67.5, 2.0), (70.5, 0.6), (71.0, 0.05)]


def finish(b, group, bevel=0.0, **kw):                                     # geo.finish + per-part triangle count in the log (PART lines)
    _geo.finish(b, group, bevel, **kw); me = _geo.GROUPS[group][-1]
    print('PART %-10s %-8s %5d' % (group, _sys._getframe(1).f_code.co_name, sum(len(p.vertices) - 2 for p in me.polygons)))


def gq(s, u, x=0.0): return GT + AD * s + FD * u + V(x, 0, 0)          # grip coordinates: s down the axis, u forward


def rev(b, o, ax, prof, n=48, pids=None, fn=None, closed=True):
    """revolved profile [(t, r)]; closed=True: the profile is a closed loop (hollow / annular solids), else capped ends; fn(t, angle, r) -> r modulates the surface"""
    o = Vector(o); ax = Vector(ax).normalized(); u, v = perp(ax); pr = list(prof) + ([prof[0]] if closed else [])
    rings = [[o + ax * t + (u * cos(2 * pi * j / n) + v * sin(2 * pi * j / n)) * (fn(t, 2 * pi * j / n, r) if fn else r) for j in range(n)] for t, r in pr]
    vr = loft(b, rings, not closed, not closed, (lambda i, j: pids[min(i, len(pids) - 1)]) if pids else None)
    if closed: bmesh.ops.remove_doubles(b.bm, verts=vr[0] + vr[-1], dist=1e-3)
    return vr


def ridges(t0, t1, k, d, rmin):
    """straight grip ridges (k around) between t0 and t1 on surfaces above rmin"""
    return lambda t, a, r: r if (r < rmin or t < t0 or t > t1) else r - d * (0.5 - 0.5 * cos(k * a))


def knurl(t0, t1, k, per, d, rmin):
    """diamond knurl: peaks on a rotated grid (k around, period per along the axis)"""
    def f(t, a, r):
        if r < rmin or t < t0 or t > t1: return r
        e = min(1.0, (t - t0) / 0.8, (t1 - t) / 0.8)
        return r - d * e * (0.5 - 0.5 * cos(k * a) * cos(2 * pi * t / per))
    return f


def dens(prof, t0, t1, step):
    """extra profile rings (linear radius) inside [t0, t1] so that a modulation along the axis has vertices"""
    out = []
    for (ta, ra), (tb, rb) in zip(prof, prof[1:]):
        out.append((ta, ra))
        lo, hi = max(ta, t0), min(tb, t1)
        if hi - lo > step:
            m = int((hi - lo) / step)
            for i in range(1, m + 1):
                t = lo + (hi - lo) * i / m
                if ta < t < tb: out.append((t, ra + (rb - ra) * (t - ta) / (tb - ta)))
    out.append(prof[-1]); return out


def sring(y, hw, zb, zt, rb, rt, k=4): return [V(x, y, z) for x, z in rrect(hw, (zt - zb) / 2, (rb, rb, rt, rt), k, 0, (zt + zb) / 2)]


# ------------------------------------------------------------------ stock (OD synthetic, tag 5)
SEC = [(-321, 20.0, -98, 63.0, 8, 9), (-300, 21.0, -92, 63.5, 9, 10), (-250, 21.5, -78, 63.5, 10, 10), (-215, 21.5, -68, 60.0, 10, 10), (-196, 21.0, -62, 46.0, 10, 9),
       (-178, 20.5, -56, 37.0, 10, 8), (-140, 19.5, -44, 35.0, 10, 8), (-100, 19.0, -30, 34.0, 10, 8), (-75, 19.0, -12, 34.0, 9, 7), (-50, 21.0, 3, 34.0, 7, 6),
       (-28, 25.0, 7, 35.0, 6, 6), (-8, 28.5, 6, 44.0, 5, 8), (30, 29.0, 5, 44.0, 5, 8), (180, 29.0, 5, 44.0, 5, 8), (300, 29.0, 3.5, 44.0, 8, 8), (410, 27.5, 6, 43.5, 9, 8),
       (436, 25.5, 9, 41.5, 9, 7), (446, 22.0, 13, 38.0, 7, 6)]


def stock(G):
    b = B(OLIVE, 5); loft(b, [sring(*s) for s in SEC])
    c = B(DARK); cyl(c, (0, -30, BZ), (0, 462, BZ), 18.5, 30); cyl(c, (0, -192, BZ), (0, -30.5, BZ), 12.2, 20)
    box(c, -13.4, 13.4, 96.5, 173.5, -20, 40); box(c, -4.6, 4.6, 27, 60, -5, 22)
    boolean_diff(b, c); finish(b, G, 1.0)
    b = B(OLIVE, 5)                                                              # pistol grip, palm swell, rounded heel
    gs = [(-14, 14.0, 22.0, -24), (10, 15.0, 24.0, -24), (30, 15.5, 24.5, -25), (55, 16.0, 24.0, -26), (80, 15.5, 23.0, -25), (100, 15.0, 22.5, -24), (110, 14.0, 21.0, -22.5),
          (114, 11.5, 17.5, -18.5), (115.6, 6.5, 12.0, -12.5)]
    loft(b, [[gq(s, (uf + ub) / 2 + v, x) for x, v in rrect(hw, (uf - ub) / 2, 9.0, 3)] for s, hw, uf, ub in gs]); finish(b, G, 0.0)
    b = B(OLIVE, 5)                                                              # adjustable cheek riser
    loft(b, [sring(*s) for s in ((-302, 16.5, 65.0, 79.5, 3, 7), (-299, 19.0, 65.0, 82.0, 3, 9), (-232, 19.0, 65.0, 82.0, 3, 9), (-214, 18.0, 65.0, 78.5, 3, 8), (-206, 14.5, 65.5, 72.0, 3, 6))])
    finish(b, G, 0.6)
    b = B(ALU, 5)                                                                # riser posts, adjustment knob, spacers
    for yy in (-282, -226): cyl(b, (0, yy, 56), (0, yy, 66), 4.6, 14)
    rev(b, (-20.6, -252, 52), (-1, 0, 0), [(0, 0.05), (0, 6.5), (2.5, 8.0), (8.5, 8.0), (9.2, 7.2), (9.2, 0.05)], 72, fn=ridges(2.4, 8.6, 18, 0.9, 7.5), closed=False)
    finish(b, G, 0.0)
    b = B(PARK, 5); loft(b, [sring(-320.5, 20.5, -98.5, 63.5, 8, 9), sring(-325, 20.5, -98.5, 63.5, 8, 9)]); finish(b, G, 0.4)
    b = B(POLY, 5); loft(b, [sring(-324.7, 20.8, -98.8, 63.8, 8, 9), sring(-329, 20.8, -98.8, 63.8, 8, 9)]); finish(b, G, 0.4)
    b = B(RUBBER, 5)                                                             # butt pad
    loft(b, [sring(-328.7, 21.0, -99.2, 64.2, 8, 9), sring(-343, 21.4, -100.5, 65.0, 9, 10), sring(-346, 20.6, -99.5, 64.0, 9, 9.5), sring(-347.2, 18.5, -97.0, 61.5, 8, 8)])
    finish(b, G, 0.0)
    b = B(BLUED, 6)                                                              # sling studs
    for yy, z0, z1 in ((-262, -78.0, -87.5), (382, 6.0, -4.5)):
        cyl(b, (0, yy, z0), (0, yy, z1), 3.4, 10); cyl(b, (0, yy, z1 + 1.2), (0, yy, z1 - 0.6), 5.0, 12)
        cyl(b, (-4.6, yy, z1 + 3.2), (4.6, yy, z1 + 3.2), 1.4, 6)
    finish(b, G, 0.0)


# ------------------------------------------------------------------ action, barrel, brake (tag 1 / 2)
def action(G):
    b = B(STEEL, 1)
    rev(b, (0, 0, BZ), (0, 1, 0), [(-30, 10.0), (-30, 16.5), (-29, 17.5), (199, 17.5), (200, 16.6), (200, 10.0)], 56, [STEEL] * 5 + [PARK])
    c = B(PARK); box(c, 3.0, 26, 80, 172, BZ - 3, BZ + 13)                      # ejection port (right side, under the rail edge)
    box(c, 4.0, 26, -31, 2.0, BZ - 15, BZ + 15)                                  # bolt-handle notch at the rear bridge
    box(c, -10.5, 10.5, 97, 174, 20, BZ - 6)                                    # magazine opening
    boolean_diff(b, c); finish(b, G, 0.35)
    b = B(STEEL, 1)                                                              # barrel nut with wrench notches
    rev(b, (0, 0, BZ), (0, 1, 0), [(199.5, 0.05), (199.5, 17.6), (200.3, 18.6), (211.2, 18.6), (212, 17.4), (212, 0.05)], 64, fn=ridges(199.4, 212.1, 8, 1.6, 17.0), closed=False)
    finish(b, G, 0.0)
    b = B(BLUED, 6)                                                              # bolt release, safety, receiver screws
    prism(b, [(-26, BZ - 4), (-8, BZ - 4), (-5, BZ - 0.5), (-8, BZ + 3), (-26, BZ + 3)], -19.8, -16.4, 'yz')
    prism(b, [(-48, 33.0), (-36, 33.0), (-35, 41), (-47, 41)], 13.8, 17.6, 'yz'); box(b, 15.6, 17.4, -45, -39, 41, 44.5)
    for yy in (-12, 186):
        for sx in (-1, 1): dome(b, (sx * 17.3, yy, BZ - 6), (sx, 0, -0.2), 2.4, 0.6, 10)
    finish(b, G, 0.3)
    b = B(PARK, 6); box(b, -4.4, 4.4, 30, 58, 6, 22); finish(b, G, 0.3)        # trigger housing (seen through the slot)


def barrel(G):
    b = B(STEEL, 2); fl0, fl1 = 330.0, 666.0
    pts = [(195, 0.05), (195, 14.6), (212, 14.6), (214, 15.0), (250, 15.0)]
    ts = [fl0 + d for d in (0, 3, 6, 9, 12, 15)] + list(range(372, 640, 24)) + [fl1 - d for d in (15, 12, 9, 6, 3, 0)]
    pts += [(t, 13.2 - 1.6 * (t - fl0) / (fl1 - fl0)) for t in ts]
    pts += [(690, 11.4), (734, 10.8), (735.5, 9.4), (737, 8.2), (748, 8.0), (748, 3.9), (736, 3.9), (735, 0.05)]

    def flute(t, a, r):
        if t < fl0 or t > fl1 or r < 9: return r
        q = max(0.0, (fl0 + 14 - t), (t - fl1 + 14)) / 14.0; e = sqrt(max(0.0, 1 - q * q))
        return r - 1.7 * e * max(0.0, (cos(6 * a) - 0.12) / 0.88) ** 0.55
    np_ = len(pts); rev(b, (0, 0, BZ), (0, 1, 0), pts, 60, [STEEL] * (np_ - 4) + [STEEL, DARK, DARK], flute, closed=False); finish(b, G, 0.0)
    b = B(PARK, 2)                                                               # muzzle brake: three side ports through, two top vents
    rev(b, (0, 0, BZ), (0, 1, 0), [(733, 5.2), (733, 12.6), (734, 13.4), (798.6, 13.4), (800, 12.2), (800, 5.2)], 48, [PARK] * 5 + [DARK])
    c = B(DARK)
    for y0, y1 in ((744, 753), (759, 769), (775, 786)): box(c, -20, 20, y0, y1, BZ - 5.6, BZ + 5.6)
    for sx in (-1, 1): cyl(c, (sx * 4.2, 792, BZ), (sx * 4.2, 792, BZ + 20), 2.0, 8)
    boolean_diff(b, c); finish(b, G, 0.0)


def rail(G):
    b = B(PARK, 8)
    prism(b, [(-8.5, 61.0), (8.5, 61.0), (10.6, 64.0), (10.6, 66.5), (8.4, 68.6), (10.6, 70.6), (10.6, 71.6), (9.6, 72.5), (-9.6, 72.5), (-10.6, 71.6), (-10.6, 70.6), (-8.4, 68.6),
              (-10.6, 66.5), (-10.6, 64.0)], -28, 176, 'xz')
    c = B(DARK)
    for k in range(20): box(c, -12, 12, -23.6 + 10 * k, -18.4 + 10 * k, 69.0, 74.0)
    boolean_diff(b, c); finish(b, G, 0.0)
    b = B(BLUED, 8)
    for yy in (-14.6 + 10 * k for k in (0, 9, 18)): cyl(b, (0, yy + 0.6, 68.6), (0, yy + 0.6, 69.4), 2.5, 9)
    finish(b, G, 0.0)


def bottom(G):
    b = B(PARK, 6); box(b, -15.5, 15.5, -2, 178, 2.5, 7.0)
    c = B(DARK); box(c, -13.1, 13.1, 96.8, 173.2, 0, 9); box(c, -4.6, 4.6, 27, 60, 0, 9); boolean_diff(b, c); finish(b, G, 0.6)
    b = B(PARK, 6)
    prism(b, thick(smooth2([(76, 4), (77.5, -10), (74, -24), (63, -31.5), (45, -33), (28, -31.5), (16, -27), (9, -24)], 4), 5.0), -6.0, 6.0, 'yz'); finish(b, G, 1.2)
    b = B(BLUED, 6); prism(b, [(81, 3), (86, 3), (89.5, -13), (86.5, -15.5), (83.5, -8)], -6.5, 6.5, 'yz'); finish(b, G, 0.6)   # magazine release paddle
    b = B(ALU, 9)                                                                # bipod mount on its own stud
    box(b, -10, 10, 420, 440, -9, 9.5); cyl(b, (-10.2, BIP[1], BIP[2]), (10.2, BIP[1], BIP[2]), 7.0, 18); finish(b, G, 0.6)


# ------------------------------------------------------------------ scope + mount (static node Scope, tag 7 / 8)
SCP = [(-92, 17.6), (-92, 21.0), (-91.2, 21.9), (-83, 21.9), (-82, 21.2), (-81.5, 21.6), (-52, 21.6), (-50, 21.0), (-42, 18.6), (-36.5, 18.6), (-36, 18.2), (-16.5, 18.2),
       (-16, 18.6), (-13, 18.6), (-11, 15.0), (160, 15.0), (166, 16.2), (194, 28.6), (197, 29.6), (210, 29.6), (211, 29.0), (213, 29.6), (238, 29.6), (240, 28.2), (240.5, 26.2),
       (234, 25.3), (233.5, 24.6), (196, 22.4), (168, 13.3), (-14, 13.3), (-40, 15.0), (-88, 17.0)]


def turret(b, ax, t1, rk, k, n):
    """turret on the saddle: collar, knurled cap (ridges between t0 and t1 - 1), chamfered top with a centre screw"""
    prof = [(16, 0.05), (16, 13.0), (23.5, 13.0), (23.8, rk - 0.6), (24.4, rk), (t1 - 10, rk), (t1 - 9.6, rk + 0.4), (t1 - 1.2, rk + 0.4), (t1 - 0.5, rk - 0.4), (t1, rk - 1.6),
            (t1, 5.0), (t1 - 0.6, 4.4), (t1 - 0.6, 0.05)]
    rev(b, (0, YT, SZ), ax, prof, n, fn=ridges(t1 - 9.7, t1 - 1.1, k, 0.9, rk), closed=False)


def scope(G):
    b = B(ALU, 7); fn = lambda t, a, r: ridges(-36.2, -16.3, 24, 0.75, 17.5)(t, a, ridges(212.9, 238.1, 32, 0.6, 29.0)(t, a, r))
    rev(b, (0, 0, SZ), (0, 1, 0), SCP, 72, [RUBBER] * 4 + [ALU] * 20 + [DARK] * 8, fn); finish(b, G, 0.0)
    b = B(ALU, 7)                                                                # turret saddle, power-ring throw lever
    loft(b, [[V(x, y, z + SZ) for x, z in rrect(hw, hw, rr, 3)] for y, hw, rr in ((49, 15.5, 6), (51.5, 18.5, 7.5), (88.5, 18.5, 7.5), (91, 15.5, 6))])
    prism(b, [(-3, SZ + 17.6), (3, SZ + 17.6), (2.2, SZ + 27), (-2.2, SZ + 27)], -30.5, -22.5, 'xz')
    c = B(DARK); cyl(c, (0, 45, SZ), (0, 95, SZ), 13.3, 30); boolean_diff(b, c)   # keep the erector bore open through the saddle
    finish(b, G, 0.5)
    b = B(ALU, 7)
    turret(b, (0, 0, 1), 41.5, 15.5, 28, 84); turret(b, (1, 0, 0), 36.0, 14.5, 26, 78)
    rev(b, (0, YT, SZ), (-1, 0, 0), [(16, 0.05), (16, 12.5), (21, 12.5), (21.4, 20.0), (29, 20.0), (29.6, 19.2), (29.6, 0.05)], 60, fn=ridges(21.3, 29.1, 20, 0.8, 19.0), closed=False)
    finish(b, G, 0.0)
    b = B(GLASS, 7); cyl(b, (0, 232.8, SZ), (0, 233.6, SZ), 24.7, 40); finish(b, G, 0.0)
    b = B(RED, 7); dome(b, (-29.8, YT, SZ), (-1, 0, 0), 3.0, 0.6, 12); finish(b, G, 0.0)
    for ry in (10.0, 128.0):                                                     # rings, bases, cross bolts, cap screws
        b = B(PARK, 8)
        rev(b, (0, 0, SZ), (0, 1, 0), [(ry - 9, 14.7), (ry - 9, 18.8), (ry - 8.2, 19.6), (ry + 8.2, 19.6), (ry + 9, 18.8), (ry + 9, 14.7)], 44)
        bs = [(-13, 66.0), (13, 66.0), (13, 75.0), (10.5, SZ - 12), (-10.5, SZ - 12), (-13, 75.0)]
        loft(b, [[V(x, ry + dy, z) for x, z in bs] for dy in (-8, 8)])
        for sx in (-1, 1):
            for dy in (-4.8, 4.8): box(b, sx * 18.2, sx * 21.6, ry + dy - 2.6, ry + dy + 2.6, SZ - 2.8, SZ + 2.8)
        finish(b, G, 0.3, seg=1)
        b = B(BLUED, 8)
        cyl(b, (-17.5, ry, 70), (15.5, ry, 70), 3.0, 10); cyl(b, (-13.0, ry, 70), (-18.5, ry, 70), 5.2, 3.75)
        for sx in (-1, 1):
            for dy in (-4.8, 4.8): cyl(b, (sx * 21.5, ry + dy, SZ), (sx * 23.0, ry + dy, SZ), 2.3, 10)
        finish(b, G, 0.0)
        b = B(DARK, 8)
        for sx in (-1, 1):
            for dy in (-4.8, 4.8): cyl(b, (sx * 22.9, ry + dy, SZ), (sx * 23.15, ry + dy, SZ), 1.15, 3.75)
        finish(b, G, 0.0)


# ------------------------------------------------------------------ moving parts
def bolt():
    b = B(BOLT, 3)                                                               # body with spiral flutes, lugs, extractor
    bp = dens([(-22, 0.05), (-22, 9.0), (-21.5, 9.5), (175, 9.5), (176, 8.6), (176, 6.4), (174.5, 6.4), (174.5, 0.05)], 26, 156, 9.0)

    def fl(t, a, r):
        if r < 9.4 or t < 30 or t > 152: return r
        e = sqrt(max(0.0, 1 - (max(0.0, 38 - t, t - 144) / 8.0) ** 2))
        return r - 1.3 * e * max(0.0, (cos(4 * (a + 0.028 * t)) - 0.3) / 0.7) ** 0.6
    rev(b, (0, 0, BZ), (0, 1, 0), bp, 40, [BOLT] * (len(bp) - 4) + [DARK] * 3, fl, closed=False)
    for sx in (-1, 1): box(b, sx * 8.0, sx * 12.4, 160, 174.5, BZ - 3.2, BZ + 3.2)
    box(b, 6.5, 10.0, 164, 177.5, BZ + 3.0, BZ + 6.0); finish(b, 'BoltHandle', 0.3)
    b = B(BLUED, 3)                                                              # shroud
    rev(b, (0, 0, BZ), (0, 1, 0), [(-64, 0.05), (-64, 7.6), (-62, 9.8), (-50, 10.9), (-24, 10.9), (-22.5, 9.6), (-22.5, 0.05)], 40, closed=False); finish(b, 'BoltHandle', 0.0)
    b = B(BOLT, 3)                                                               # handle arm, swept back and down
    kn = Vector(KNOB); tube(b, [(3, YH, BZ - 1.0), (14, YH - 2, BZ - 5), (26, YH - 6, BZ - 9.5), (37, YH - 11.5, BZ - 13), tuple(kn + Vector((-4.5, 3.5, 1.0)))], [6.4, 5.0, 4.2, 3.9, 3.9], 14, 4)
    finish(b, 'BoltHandle', 0.0)
    b = B(BLUED, 3)                                                              # tactical knob with a diamond knurl
    d = (kn - Vector((37, YH - 11.5, BZ - 13))).normalized()
    kp = dens([(-11.5, 0.05), (-11.5, 3.6), (-10, 4.4), (-8.0, 7.6), (-5.5, 9.4), (-2.5, 10.3), (1.0, 10.5), (4.5, 10.1), (7.0, 8.9), (9.0, 6.6), (10.4, 3.8), (11.0, 1.4), (11.1, 0.05)], -6.8, 7.6, 0.75)
    rev(b, kn - d * 1.0, d, kp, 64, fn=knurl(-6.5, 7.3, 12, 3.6, 0.5, 8.0), closed=False); finish(b, 'BoltHandle', 0.0)
    b = B(BLUED, 3)                                                              # cocking piece with the red cocked indicator
    rev(b, (0, 0, BZ), (0, 1, 0), [(-76, 0.05), (-76, 4.6), (-75, 5.4), (-63, 5.4), (-63, 0.05)], 24, closed=False); finish(b, 'Striker', 0.0)
    b = B(RED, 3); rev(b, (0, 0, BZ), (0, 1, 0), [(-71.5, 5.0), (-71.5, 5.6), (-68.5, 5.6), (-68.5, 5.0)], 24); finish(b, 'Striker', 0.0)


def magazine():
    b = B(MAGS, 4)
    secs = [(MAGT, 8.0, 33.0, 2.5), (MAGT - 2, 10.5, 35.0, 3.0), (MAGT - 5, MAGW, MAGL, 3.0), (MAGB, MAGW, MAGL, 3.0)]
    loft(b, [[V(x, MAGY + yy, z) for x, yy in rrect(hw, hl, r, 2)] for z, hw, hl, r in secs])
    for sx in (-1, 1):
        for yy in (-18, 0, 18): box(b, sx * (MAGW - 0.5), sx * (MAGW + 0.7), MAGY + yy - 1.6, MAGY + yy + 1.6, MAGB + 3, MAGT - 9)
    finish(b, 'Magazine', 0.35)
    b = B(POLY, 4)
    loft(b, [[V(x, MAGY + 0.8 + yy, z) for x, yy in rrect(hw, hl, r, 2)] for z, hw, hl, r in ((MAGB + 1.0, 13.4, 38.6, 3.6), (MAGB - 1.0, 14.0, 39.4, 4.0), (MAGB - 5.0, 14.0, 39.4, 4.0),
                                                                                      (MAGB - 6.5, 13.0, 38.4, 3.6))])
    finish(b, 'Magazine', 0.5)
    for x0, z0 in ((2.9, 31.4), (-3.4, 26.2)):                                   # two cartridges in the staggered column
        b = B(BRASS, 20); lathe2(b, (x0, MAGY - 36.0, z0), (0, 1, 0), C308 + B308, 16, [BRASS] * 9 + [COPPER] * 6); finish(b, 'MagRounds', 0.0)


def small():
    b = B(BLUED, 6)
    prism(b, thick(smooth2([(41, 16), (40, 8), (38.6, 0), (38.4, -6), (40, -11), (42.5, -13.5)], 3), 4.4), -3.6, 3.6, 'yz'); finish(b, 'Trigger', 0.9)
    b = B(BRASS, 20); lathe(b, (0, FACE, BZ), (0, 1, 0), C308 + [(51.0, 3.9), (47, 3.9)], 10); finish(b, 'Casing', 0.0)


def bipod():
    for nm, sx in (('BipodL', -1), ('BipodR', 1)):
        px, py, pz = sx * BIP[0], BIP[1], BIP[2]
        b = B(ALU, 9)
        cyl(b, (sx * 10.6, py, pz), (sx * 22.0, py, pz), 6.6, 16)
        loft(b, [[V(px + x, y, pz + z) for x, z in rrect(4.2, 5.4, 2.0, 2)] for y in (py + 2, py + 155)])
        finish(b, nm, 0.3)
        b = B(BLUED, 9)
        cyl(b, (px, py + 153, pz), (px, py + 163, pz), 6.4, 16)
        rev(b, (px + sx * 5.5, py + 158, pz), (sx, 0, 0), [(0, 0.05), (0, 4.6), (5.5, 4.6), (6.0, 3.8), (6.0, 0.05)], 40, fn=ridges(0.3, 5.6, 14, 0.7, 4.0), closed=False)
        finish(b, nm, 0.0)
        b = B(STEEL, 9)                                                         # telescoping inner leg with adjustment grooves
        lp = [(py + 160, 0.05), (py + 160, 3.3)]
        for k in range(5): y0 = py + 166 + 7 * k; lp += [(y0, 3.3), (y0 + 0.5, 2.8), (y0 + 1.7, 2.8), (y0 + 2.2, 3.3)]
        lp += [(py + 212, 3.3), (py + 212, 0.05)]
        rev(b, (px, 0, pz), (0, 1, 0), lp, 24, closed=False); finish(b, nm, 0.0)
        b = B(RUBBER, 9); rev(b, (px, 0, pz), (0, 1, 0), [(py + 209, 0.05), (py + 209, 4.6), (py + 214, 6.4), (py + 221, 6.4), (py + 225, 4.0), (py + 226.5, 0.05)], 24, closed=False)
        finish(b, nm, 0.0)


def build(groups):
    G = groups[0]; stock(G); action(G); barrel(G); rail(G); bottom(G); scope('Scope'); bolt(); magazine(); small(); bipod()
    return dict(groups=groups, uvs={5: 0.6, 2: 0.75, 7: 1.0, 9: 0.8, 4: 0.8, 20: 0.6}, parents=dict(MagRounds='Magazine', Striker='BoltHandle'), origins=ORIG,
                empties=dict(Muzzle=(0, 800.5, BZ), Eject=(20, 125, BZ + 8), ScopeEye=(0, -92, SZ), SightRear=(0, -92, SZ), SightFront=(0, 241, SZ)))
