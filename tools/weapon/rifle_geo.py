# Valle Morta - AKM-pattern rifle (7.62x39), clean-sheet geometry. Millimetres, Blender axes (+X right, +Y muzzle, +Z up), origin at the top of the pistol grip.
# Layout constants are the ones the rifle clips were authored against (grip, magazine curve, bolt, trigger pivot); shared with w_rifle.py and surf.hook_rifle.
# Overall 885 mm (butt plate -299.6 .. brake lip 585), barrel 415 mm (bolt face 151 .. muzzle 566).
import bmesh
from math import radians, sin, cos, pi, asin, degrees, exp
from mathutils import Vector
from geo import B, V, box, prism, loft, lathe, cyl, dome, rrect, thick, smooth2, tube, sweep, arcp, boolean_diff, STEEL, MAGS, BOLT, BRASS, WOOD, GRIPW, FABRIC
from sniper_geo import finish, rev, ridges, dens, sring, DARK, PARK, BLUED

HWR, RH, BZ, GZ, SZ = 16.5, 46.0, 34.0, 58.0, 85.0      # receiver half width / wall top, bore, gas tube axis, sight line
MC, MR = (355.5, 34.8), 250.0                           # magazine curve centre (y, z) and mean radius
SEL = (-28.0, 30.0, -13.0)                              # selector pivot (y, z), lever angle (fire position)
R = 'RifleBody'
ORIG = dict(Magazine=(0, 139, 5), MagRounds=(0, 139, 5), Trigger=(0, 13, 8), Bolt=(0, 90, 55), Selector=(HWR, SEL[0], SEL[1]), Casing=(0, 172, BZ))
STK = [(-75.0, 46.0, 9.5, 15.4, 5.5, 6.0), (-80.0, 46.0, 7.5, 15.8, 6.5, 7.0), (-92.0, 45.3, 2.5, 16.0, 7.5, 8.0), (-110, 44.0, -5.5, 16.2, 8, 9),
       (-140, 41.5, -18.5, 17.0, 8.5, 9.5), (-175, 38.0, -34.0, 18.2, 9, 10), (-215, 33.5, -53.0, 19.3, 9.5, 10), (-250, 29.5, -70.0, 20.0, 10, 10.5),
       (-275, 26.0, -83.0, 20.4, 10, 10.5), (-290, 24.0, -91.0, 20.5, 9.5, 10), (-294.5, 23.4, -92.8, 20.2, 9, 9.5)]   # y, comb, belly, half width, top / bottom radius


def mp(phi, off, x):
    a = radians(phi); r = MR + off
    return V(x, MC[0] + r * cos(a), MC[1] + r * sin(a))


def er(phi): return V(0, cos(radians(phi)), sin(radians(phi)))
def et(phi): return V(0, -sin(radians(phi)), cos(radians(phi)))
def stk_at(y, i):
    for a, b in zip(STK, STK[1:]):
        if b[0] <= y <= a[0]: t = (a[0] - y) / (a[0] - b[0]); return a[i] + (b[i] - a[i]) * t
    return STK[-1][i]


def arch(hw, zs, zt, rise, cut=False, n=26):
    p = [(-hw, zs)] + [(hw * cos(pi - pi * i / n), zt + rise * sin(pi * i / n)) for i in range(n + 1)]
    return p if cut else p + [(hw, zs)]


def shell(hw, zs, zt, rise, th, cut=False): return arch(hw, zs, zt, rise, cut) + arch(hw - th, zs, zt, rise - th, cut)[::-1]


def rsec(z0, r=3.6):
    o = [(-HWR, RH)] + [(-HWR + r + r * cos(radians(a)), z0 + r + r * sin(radians(a))) for a in (180, 202.5, 225, 247.5, 270)]
    o += [(HWR - r + r * cos(radians(a)), z0 + r + r * sin(radians(a))) for a in (270, 292.5, 315, 337.5, 360)]
    o += [(HWR, RH), (HWR - 3.8, RH), (HWR - 3.8, RH - 1.5), (HWR - 1.5, RH - 1.5), (HWR - 1.5, z0 + 4.0), (HWR - 4.0, z0 + 1.5),
          (-HWR + 4.0, z0 + 1.5), (-HWR + 1.5, z0 + 4.0), (-HWR + 1.5, RH - 1.5), (-HWR + 3.8, RH - 1.5), (-HWR + 3.8, RH)]
    return o


# ------------------------------------------------------------------ stamped receiver, trunnions, rivets, controls (tag 1)
def receiver():
    b = B(STEEL, 1); loft(b, [[V(x, y, z) for x, z in rsec(z0)] for y, z0 in ((-75, 10), (-66, 0), (185, 0))])
    c = B(STEEL)
    box(c, -13.9, 13.9, 71.5, 143.5, -3, 3.5)                                      # magazine well
    box(c, HWR - 2.5, HWR + 2, 96, 147, 37.5, RH + 1)                              # ejection port
    for sx in (-1, 1): prism(c, rrect(19, 6.2, 5.5, 3, 108, 23), *sorted((sx * (HWR - 0.55), sx * (HWR + 3))), 'yz')   # magazine guide dimples
    boolean_diff(b, c); finish(b, R, 0.35)
    b = B(STEEL, 12)                                                               # trunnions inside the channel
    box(b, -HWR + 1.5, HWR - 1.5, 150, 185, 1.5, RH - 1.6); box(b, -HWR + 1.5, HWR - 1.5, -72, -52, 8, 30); finish(b, R, 0.5)
    b = B(STEEL, 1)                                                                # rivet heads: front / rear trunnion, centre support; trigger, hammer, auto-sear pins
    for sx in (-1, 1):
        for y, z in ((158, 37), (177, 37), (177, 12), (-60, 37), (-60, 14), (-69, 26), (66, 31), (66, 9)):
            dome(b, (sx * HWR, y, z), (sx, 0, 0), 2.5, 1.0, 12)
        for y, z in ((22, 11), (55, 18), (40, 37)):
            cyl(b, (sx * (HWR - 0.3), y, z), (sx * (HWR + 0.6), y, z), 2.7, 14); dome(b, (sx * (HWR + 0.6), y, z), (sx, 0, 0), 1.9, 0.4, 12)
    for x, y in ((-6, 60), (6, 60), (-6, 47), (6, 47)): dome(b, (x, y, 0.2), (0, 0, -1), 2.2, 0.8, 12)
    py, pz, ang = SEL[0], SEL[1], radians(SEL[2])
    for a in (SEL[2], SEL[2] + 13.5):                                              # selector stop dimples (fire / auto positions)
        aa = radians(a); dome(b, (HWR, py + 93 * cos(aa) + 10 * sin(aa), pz + 93 * sin(aa) - 10 * cos(aa)), (1, 0, 0), 2.0, 0.7, 12)
    finish(b, R, 0.0)
    b = B(STEEL, 1)                                                                # trigger guard and its rivets
    path = smooth2([(-9, -1), (-8.5, -20), (-3, -28), (8, -30.5), (48, -30.5), (58, -28), (63.5, -20), (64.5, -1)], 4)
    prism(b, thick(path, 1.7), -8.2, 8.2, 'yz'); finish(b, R, 0.6)
    b = B(STEEL, 1)
    for y in (-6.5, 61.5): dome(b, (0, y, -1.4), (0, 0, -1), 2.0, 0.6, 12)
    prism(b, [(64, -2), (76, -2), (76.5, -12), (74, -17), (69, -24), (64, -28), (61.5, -26.5), (66, -21), (69, -15), (68, -9), (64, -8)], -5.5, 5.5, 'yz')   # magazine catch
    cyl(b, (-6.4, 66, -6), (6.4, 66, -6), 1.7, 12)
    box(b, -10.5, 10.5, -50, -4, -1.6, 0.4)                                        # grip mounting tang
    finish(b, R, 0.45)


def selector():
    b = B(STEEL, 1); py, pz, ang = SEL[0], SEL[1], radians(SEL[2])
    def rot(u, v): return (py + u * cos(ang) - v * sin(ang), pz + u * sin(ang) + v * cos(ang))
    poly = [(7 * cos(radians(a)), 7 * sin(radians(a))) for a in (90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270)]
    poly += [(20, -4.5), (68, -4.5), (76, -7), (100, -7), (102, -5), (102, 4), (100, 6), (76, 6), (68, 4.5), (20, 4.5)]
    prism(b, [rot(u, v) for u, v in poly], HWR + 0.9, HWR + 2.4, 'yz')
    prism(b, [rot(u, v) for u, v in ((86, -10.2), (101, -10.2), (101, -6.4), (86, -6.4))], HWR + 0.9, HWR + 9.0, 'yz')
    finish(b, 'Selector', 0.5)
    b = B(STEEL, 1); cyl(b, (HWR, py, pz), (HWR + 2.6, py, pz), 4.6, 20); dome(b, (HWR + 2.6, py, pz), (1, 0, 0), 3.4, 1.2, 16); finish(b, 'Selector', 0.3)


# ------------------------------------------------------------------ dust cover with ribs and guide button (tag 3)
def cover():
    b = B(STEEL, 3)
    prism(b, shell(15.6, 46.6, 58, 16, 1.0), -60, 22, 'xz'); prism(b, shell(15.6, 46.6, 58, 16, 1.0, True), 22, 146, 'xz'); finish(b, R, 0.35)
    b = B(STEEL, 3)                                                                # swaged rear end with the slot for the guide button
    loft(b, [[V(x, y, z) for x, z in arch(*a)] for y, a in ((-60, (15.6, 46.6, 58, 16)), (-71.6, (15.6, 46.6, 58, 16)), (-73.3, (15.0, 46.6, 58, 15.3)), (-74.3, (13.4, 46.6, 57.6, 13.6)))])
    c = B(DARK); box(c, -4.4, 4.4, -80, -66, 54.6, 64.8); boolean_diff(b, c); finish(b, R, 0.5)
    b = B(STEEL, 3)
    for y0, cut in ((-48, False), (-20, False), (8, False), (64, True), (100, True)): prism(b, shell(16.2, 48.5, 58, 16.6, 1.0, cut), y0, y0 + 4.5, 'xz')
    finish(b, R, 0.38)
    b = B(STEEL, 3)                                                                # recoil-spring guide: button with grip ridges
    prism(b, rrect(3.9, 4.6, 1.2, 2, 0, 59.7), -77.2, -64, 'xz')
    for zz in (57.4, 59.7, 62.0): box(b, -3.3, 3.3, -77.9, -77.0, zz - 0.45, zz + 0.45)
    finish(b, R, 0.25)


# ------------------------------------------------------------------ bolt carrier group (node Bolt, tag 11)
def bolt():
    b = B(BOLT, 11)
    prism(b, [(-13, 47.2), (13.4, 47.2), (14.4, 48.6), (14.4, 57.5), (12.8, 65), (8, 70.5), (-8, 70.5), (-12.8, 65)], 30, 147, 'xz')
    box(b, -9, 9, 30, 112, 38, 48.5); finish(b, 'Bolt', 0.6)
    b = B(BOLT, 11)                                                                # rotating bolt with lugs and extractor, piston with rings
    rev(b, (0, 0, BZ), (0, 1, 0), [(94, 0.05), (94, 7.6), (95, 8.3), (144, 8.3), (144.5, 7.6), (149, 7.6), (149, 0.05)], 28, closed=False)
    for sx in (-1, 1): box(b, sx * 6.5, sx * 10.8, 144.5, 148.8, BZ - 2.8, BZ + 2.8)
    box(b, 6.0, 9.6, 120, 149.5, BZ + 3.0, BZ + 5.6)
    pp = [(146, 0.05), (146, 6.3), (204, 6.3)]
    for k in range(3): y0 = 205 + 3 * k; pp += [(y0, 6.3), (y0 + 0.4, 5.6), (y0 + 1.4, 5.6), (y0 + 1.8, 6.3)]
    pp += [(214, 6.3), (214.5, 5.6), (214.5, 0.05)]
    rev(b, (0, 0, GZ), (0, 1, 0), pp, 24, closed=False); finish(b, 'Bolt', 0.0)
    b = B(BOLT, 11)                                                                # charging handle: stem and rounded knob
    tube(b, [(12, 130, 52.5), (22, 130, 52.5), (30, 130.8, 51.8), (37, 132.5, 50.2)], [4.6, 4.2, 4.0, 4.4], 14, 4)
    rev(b, (36.0, 132.4, 50.4), Vector((0.97, 0.18, -0.16)).normalized(), [(-1.5, 0.05), (-1.5, 4.3), (0.5, 5.6), (3.5, 6.0), (6.0, 5.3), (7.4, 3.6), (8.0, 0.05)], 24, closed=False)
    finish(b, 'Bolt', 0.0)


# ------------------------------------------------------------------ rear sight (tag 2 block, tag 10 leaf)
def rear_sight():
    b = B(STEEL, 2)
    prism(b, [(-14, 46), (14, 46), (14, 63), (11.5, 70.5), (6.5, 70.5), (6.5, 67), (-6.5, 67), (-6.5, 70.5), (-11.5, 70.5), (-14, 63)], 150, 204, 'xz')
    rev(b, (0, 0, BZ), (0, 1, 0), [(185, 9.4), (185, 12.4), (186, 13.2), (225, 13.2), (226, 12.4), (226, 9.4)], 40)
    rev(b, (0, 0, GZ), (0, 1, 0), [(196, 0.05), (196, 10.8), (227, 10.8), (228, 9.8), (228, 0.05)], 36, closed=False)
    box(b, -9, 9, 188, 225, BZ + 4, GZ); finish(b, R, 0.38)
    b = B(STEEL, 2)                                                                # gas tube lock lever (right)
    prism(b, [(203, 51), (217, 51), (221, 54), (219, 58.5), (203, 57)], 12.5, 15.4, 'yz'); cyl(b, (12.5, 218, 54.5), (16.6, 218, 54.5), 3.6, 16)
    cyl(b, (-8.2, 218, 69.5), (8.2, 218, 69.5), 2.4, 14); finish(b, R, 0.4)
    b = B(STEEL, 10)                                                               # leaf with the notch plate
    prism(b, [(220, 67.8), (220, 71.2), (156, 79), (156, 76)], -5.5, 5.5, 'yz')
    nt = [(-5.5, 75.5), (5.5, 75.5), (5.5, 86.0), (4.6, 86.9), (1.0, 86.9), (0.9, 85.7), (0.6, 85.15), (0.0, 85.0), (-0.6, 85.15), (-0.9, 85.7), (-1.0, 86.9), (-4.6, 86.9), (-5.5, 86.0)]
    prism(b, nt, 153, 156.4, 'xz'); finish(b, R, 0.2)
    b = B(STEEL, 10)                                                               # slider with knurled catch buttons
    prism(b, [(-8.5, 70.8), (8.5, 70.8), (8.5, 77.4), (7.4, 78.4), (-7.4, 78.4), (-8.5, 77.4)], 176, 185, 'xz'); finish(b, R, 0.4)
    b = B(STEEL, 10)
    for sx in (-1, 1):
        rev(b, (sx * 8.0, 180.5, 74.6), (sx, 0, 0), [(0, 0.05), (0, 3.0), (2.8, 3.0), (3.5, 2.4), (3.5, 0.05)], 24, fn=ridges(0.2, 2.9, 12, 0.35, 2.7), closed=False)
    finish(b, R, 0.0)


# ------------------------------------------------------------------ barrel, gas system, front sight, brake, cleaning rod (tag 2)
def barrel():
    b = B(STEEL, 2)
    rev(b, (0, 0, BZ), (0, 1, 0), [(186, 9.6), (229, 9.6), (231.5, 8.6), (380, 8.15), (512, 7.6), (549, 7.6), (549.5, 6.9), (566, 6.9), (566, 3.9), (540, 3.9), (540, 0.05)],
        40, [STEEL] * 7 + [DARK] * 3, closed=False)
    finish(b, R, 0.0)
    b = B(STEEL, 2)                                                                # gas tube with vent holes (front, exposed part)
    rev(b, (0, 0, GZ), (0, 1, 0), [(224, 0.05), (224, 7.6), (378, 7.6), (379, 8.6), (384, 8.6), (384, 0.05)], 32, closed=False)
    c = B(DARK)
    for yy in (359, 366.5, 374): cyl(c, (-12, yy, GZ), (12, yy, GZ), 2.1, 14)
    boolean_diff(b, c); finish(b, R, 0.0)
    b = B(STEEL, 2)                                                                # gas block, gas cylinder, bayonet lug
    rev(b, (0, 0, BZ), (0, 1, 0), [(381, 8.3), (381, 10.8), (382, 11.6), (412, 11.6), (413, 10.8), (413, 8.0)], 40)
    rev(b, (0, 0, GZ), (0, 1, 0), [(380, 0.05), (380, 8.4), (381, 9.2), (405, 9.2), (409.5, 8.4), (412.5, 5.8), (413.2, 0.05)], 32, closed=False)
    prism(b, [(384, 42), (411, 42), (408, 52), (386, 52)], -7.0, 7.0, 'yz')
    prism(b, [(390, 24.5), (412, 24.5), (419, 22), (419, 16), (414, 13.5), (390, 13.5)], -4.6, 4.6, 'yz'); finish(b, R, 0.38)
    b = B(STEEL, 2)                                                                # front sight base, tower, ears, drum
    rev(b, (0, 0, BZ), (0, 1, 0), [(511, 7.4), (511, 10.0), (512.5, 10.8), (545, 10.8), (546.5, 10.0), (546.5, 7.4)], 40)
    prism(b, [(516, 43.5), (544, 43.5), (541, 61), (519, 61)], -5.2, 5.2, 'yz'); box(b, -8.5, 8.5, 521, 539, 59.5, 70.5); box(b, -4.2, 4.2, 512, 546, 16, 25.5)
    for sx in (-1, 1): prism(b, [(sx * x, z) for x, z in arcp(0, 79.5, 11.6, -62, 62, 12) + arcp(0, 79.5, 9.3, 62, -62, 12)], 523, 537, 'xz')
    finish(b, R, 0.5)
    b = B(STEEL, 2)
    rev(b, (-10.8, 530, 64), (1, 0, 0), [(0, 0.05), (0, 3.4), (0.5, 3.8), (21.1, 3.8), (21.6, 3.4), (21.6, 0.05)], 24, fn=ridges(0.6, 21, 14, 0.35, 3.6), closed=False)
    thr = lambda t, a, r: r - 0.28 * (0.5 + 0.5 * cos(2 * pi * t / 0.9)) if (0.4 < t < 5.6 and r > 2.5) else r
    rev(b, (0, 530, 69.8), (0, 0, 1), dens([(0, 0.05), (0, 2.9), (6, 2.9), (6.6, 1.7), (14.6, 1.3), (15.2, 0.9), (15.2, 0.05)], 0.4, 5.6, 0.22), 20, fn=thr, closed=False)
    cyl(b, (-6.5, 545, BZ - 10.5), (-6.5, 551.5, BZ - 10.5), 1.5, 10); finish(b, R, 0.0)
    b = B(STEEL, 2); n = 36; lip = Vector((-0.42, 0, -0.91)).normalized()         # slant compensator: long lip lower left, gas thrown up and right
    def mring(r, yf): return [V(r * cos(2 * pi * j / n), yf(r * cos(2 * pi * j / n), r * sin(2 * pi * j / n)), BZ + r * sin(2 * pi * j / n)) for j in range(n)]
    sl = lambda d: (lambda dx, dz: 579.4 + d + 0.52 * (dx * lip.x + dz * lip.z))
    loft(b, [mring(10.2, lambda dx, dz: 549.0), mring(10.9, lambda dx, dz: 549.9), mring(10.9, sl(-0.6)), mring(10.3, sl(0)), mring(7.9, sl(0)), mring(7.5, sl(-0.5)),
             mring(7.5, lambda dx, dz: 566.0)], True, False, lambda i, j: DARK if i >= 4 else STEEL)
    finish(b, R, 0.0)
    b = B(STEEL, 2); cyl(b, (0, 368, 20.3), (0, 543, 20.3), 2.3, 12)
    rev(b, (0, 543, 20.3), (0, 1, 0), [(0, 0.05), (0, 2.3), (0.8, 3.3), (6.2, 3.3), (7, 2.6), (7, 0.05)], 16, closed=False); finish(b, R, 0.0)


# ------------------------------------------------------------------ wood: handguards (tag 6 lower, 8 upper), grip (7), stock (5)
def lh_ring(y, grow=0.0):
    s = exp(-((y - 282) / 52.0) ** 2); hw = 19.2 + 3.3 * s + grow; ht = 17.0 + 0.8 * s + grow; zb = 10.8 - 1.4 * s - grow; zt = 44.2 + 0.5 * grow; rb = 8.5; rc = 12.6 - grow
    pts = [(ht - 1.0, zt), (ht, zt - 1.2), (ht + 0.6 * (hw - ht), 37), (hw - 0.2, 30)]
    pts += [(hw - rb + rb * cos(radians(a)), zb + rb + rb * sin(radians(a))) for a in (0, -22.5, -45, -67.5, -90)]
    pts += [(-hw + rb + rb * cos(radians(a)), zb + rb + rb * sin(radians(a))) for a in (-90, -112.5, -135, -157.5, -180)]
    pts += [(-hw + 0.2, 30), (-(ht + 0.6 * (hw - ht)), 37), (-ht, zt - 1.2), (-ht + 1.0, zt)]
    a0 = degrees(asin(min(0.99, (zt - BZ) / rc)))
    pts += [(rc * cos(radians(a)), BZ + rc * sin(radians(a))) for a in [180 - a0 + (180 + 2 * a0) * i / 16 for i in range(17)]]
    return pts


def uh_ring(r):
    pts = [(r * cos(radians(a)), GZ + r * sin(radians(a))) for a in [208 - 236 * i / 26 for i in range(27)]]
    return pts + [(r * cos(radians(-28)) - 1.0, 46.6), (-(r * cos(radians(-28)) - 1.0), 46.6)]


def furniture():
    b = B(WOOD, 6)                                                                 # lower handguard with palm swells
    loft(b, [[V(x, y, z) for x, z in lh_ring(y, g)] for y, g in [(189, -1.0), (190.5, -0.2)] + [(yy, 0.0) for yy in range(196, 352, 6)] + [(354.5, -0.2), (357, -1.0)]])
    finish(b, R, 0.0)
    b = B(STEEL, 2)                                                                # rear ferrule and front retainer band with lever and sling loop
    loft(b, [[V(x, y, z) for x, z in lh_ring(y, g)] for y, g in ((184.5, 0.4), (185.3, 1.0), (191.5, 1.0), (192.2, 0.5))])
    loft(b, [[V(x, y, z) for x, z in lh_ring(y, g)] for y, g in ((350.2, 0.5), (351, 1.1), (366, 1.1), (367.5, 0.2))])
    prism(b, [(352, 16), (368, 16), (371.5, 19), (368, 22), (352, 22)], 19.6, 22.2, 'yz'); finish(b, R, 0.4)
    b = B(STEEL, 2); tube(b, [(-19.8, 361, 19), (-27.5, 361, 19), (-30.5, 361, 22), (-30.5, 361, 33), (-27.5, 361, 36), (-19.8, 361, 36)], 1.7, 10, 3); finish(b, R, 0.0)
    b = B(WOOD, 8)                                                                 # upper handguard on the gas tube, steel collars
    loft(b, [[V(x, y, z) for x, z in uh_ring(r)] for y, r in ((229, 14.6), (232, 15.2), (235, 15.5), (290, 15.7), (343, 15.5), (346, 15.0), (348.5, 14.4))])
    finish(b, R, 0.0)
    b = B(STEEL, 2)
    for y0, y1 in ((225.5, 233), (346, 353.5)): prism(b, uh_ring(16.4), y0, y1, 'xz')
    finish(b, R, 0.5)
    b = B(GRIPW, 7)                                                                # pistol grip, 20 deg rake
    loft(b, [[V(x, -27 + 0.364 * z + yl, z) for x, yl in rrect(hw, hd, 6.8, 5)] for z, hd, hw in
             ((1, 20.5, 13.5), (-6, 20.2, 13.6), (-20, 19.6, 13.8), (-40, 19.0, 14.1), (-60, 19.0, 14.4), (-78, 19.4, 14.7), (-90, 19.9, 14.8), (-95.5, 19.6, 14.4),
              (-98.5, 18.4, 13.2), (-100.0, 16.4, 11.4))])
    finish(b, R, 0.0)
    yc = -27 + 0.364 * -100; b = B(STEEL, 7)                                       # grip screw with washer
    cyl(b, (0, yc, -99.4), (0, yc, -100.5), 5.4, 24); rev(b, (0, yc, -100.4), (0, 0, -1), [(0, 0.05), (0, 4.0), (0.6, 3.8), (1.3, 2.6), (1.5, 0.05)], 20, closed=False)
    c = B(DARK); box(c, -0.6, 0.6, yc - 5, yc + 5, -103, -101.0); boolean_diff(b, c); finish(b, R, 0.0)
    b = B(WOOD, 5); loft(b, [sring(y, hw, zb, zt, rb, rt, 5) for y, zt, zb, hw, rt, rb in STK]); finish(b, R, 0.0)
    b = B(STEEL, 5)                                                                # stock tang strap with screw
    loft(b, [[V(x, y, stk_at(y, 1) + z) for x, z in rrect(7.0, 0.75, 0.6, 2, 0, -0.15)] for y in (-73.5, -85, -100, -114)]); dome(b, (0, -101, stk_at(-101, 1) + 0.55), (0, 0, 1), 3.0, 0.8, 16)
    finish(b, R, 0.3)
    e = STK[-1]; zc = (e[1] + e[2]) / 2; b = B(STEEL, 14)                          # butt plate with trapdoor, hinge, latch, screws
    loft(b, [sring(y, e[3] + g, e[2] - g, e[1] + g, e[5] + g, e[4] + g, 5) for y, g in ((-294.2, 0.3), (-297.6, 0.3), (-299.0, -0.9))])
    prism(b, rrect(12.5, 17, 6, 3, 0, zc + 10), -299.6, -298.4, 'xz'); cyl(b, (-9, -299.3, zc + 28.6), (9, -299.3, zc + 28.6), 1.7, 12)
    dome(b, (0, -299.4, zc - 8.5), (0, -1, 0), 2.6, 1.0, 14)
    for zz in (e[1] - 9, e[2] + 12): dome(b, (0, -299.0, zz), (0, -1, 0), 3.2, 0.9, 14)
    finish(b, R, 0.35)
    hw = stk_at(-215, 3); b = B(STEEL, 5)                                          # rear sling swivel on the left side of the stock
    box(b, -hw - 1.3, -hw + 0.5, -232, -198, -13, -1)
    for yy in (-228, -202): cyl(b, (-hw - 1.0, yy, -7), (-hw - 4.8, yy, -7), 1.6, 10)
    tube(b, [(-hw - 5.2, -228, -7), (-hw - 5.2, -228, -15), (-hw - 5.2, -224, -19), (-hw - 5.2, -206, -19), (-hw - 5.2, -202, -15), (-hw - 5.2, -202, -7)], 1.6, 10, 3)
    finish(b, R, 0.3)
    b = B(FABRIC, 9); xo, xi, zc2 = -hw - 7.6, -hw - 2.8, -19.0                    # canvas sling stub folded round the lower bar
    path = [(xi, -62.0), (xi, -40), (xi, -24)] + [(-hw - 5.2 + 2.4 * cos(radians(a)), zc2 + 2.4 * sin(radians(a))) for a in (0, 45, 90, 135, 180)] + [(xo, -24), (xo - 0.6, -45), (xo - 1.6, -66.0)]
    rings = []
    for i, (px, pz) in enumerate(path):
        a, c2 = path[max(0, i - 1)], path[min(len(path) - 1, i + 1)]; tx, tz = c2[0] - a[0], c2[1] - a[1]; L = (tx * tx + tz * tz) ** 0.5; nx, nz = -tz / L, tx / L
        rings.append([V(px + nx * u, -215 + w, pz + nz * u) for w, u in ((-9, -0.8), (9, -0.8), (9, 0.8), (-9, 0.8))])
    loft(b, rings); box(b, xo - 3.0, xi + 0.6, -224.5, -205.5, -60, -55); finish(b, R, 0.3)


# ------------------------------------------------------------------ magazine (node Magazine, tag 4), rounds (MagRounds, tag 20), trigger, casing
def magazine():
    G = 'Magazine'; b = B(MAGS, 4)
    rings = [[mp(183.9 + (233.8 - 183.9) * i / 26, -v, x) for x, v in rrect(13, 32, 3.2, 4)] for i in range(27)]
    rings += [[mp(ph, -v, x) for x, v in rrect(hw, hl, r, 4)] for ph, hw, hl, r in ((233.8, 13.9, 32.9, 3.6), (234.4, 13.9, 32.9, 3.6), (234.6, 12.9, 31.9, 3.2))]
    loft(b, rings); box(b, -5, 5, 72, 77.5, -8, -2); p = mp(185.4, -33.2, 0); box(b, -6.5, 6.5, p.y - 1.5, p.y + 4.5, p.z - 4.5, p.z + 3.0)
    finish(b, G, 0.3)
    b = B(MAGS, 4)                                                                 # long side ribs, spines, cross ribs, feed lips, floor plate
    for sx in (-1, 1):
        for off in (-15, 0, 15): sweep(b, [(mp(ph, -off, sx * 13.05), V(sx, 0, 0), er(ph), 1.0, 2.3) for ph in range(197, 231, 2)], 8, 2.5, True, True)
        for ph in (188.6, 192.2): sweep(b, [(mp(ph, -off, sx * 13.05), V(sx, 0, 0), et(ph), 0.9, 1.7) for off in range(-24, 25, 6)], 8, 2.5, True, True)
        up = -et(183.9)
        loft(b, [[mp(183.9, -off, sx * 13.0), mp(183.9, -off, sx * 7.2), mp(183.9, -off, sx * 7.2) + up * 1.3, mp(183.9, -off, sx * 13.0) + up * 1.3] for off in (-24, -8, 10, 27)])
    sweep(b, [(mp(ph, 32.2, 0), V(1, 0, 0), er(ph), 3.2, 1.0) for ph in range(191, 233, 2)], 8, 2.5, True, True)
    sweep(b, [(mp(ph, -32.2, 0), V(1, 0, 0), er(ph), 2.2, 0.9) for ph in range(191, 233, 2)], 8, 2.5, True, True)
    finish(b, G, 0.0); b = B(MAGS, 4)
    loft(b, [[mp(ph, -v, x) for x, v in rrect(14.7, 33.7, 3.8, 3)] for ph in (234.5, 235.25)]); cyl(b, mp(235.25, 8, 0), mp(235.7, 8, 0), 3.4, 14)
    finish(b, G, 0.3)
    a = radians(183.9); fw = V(0, -cos(a), -sin(a)); up = -et(183.9)
    for x0, dph, du in ((-5.0, 0.0, 0.5),):
        b = B(BRASS, 20); lathe(b, mp(183.9 + dph, 27, x0) + up * du, fw, [(0, 5.2), (1, 5.65), (30, 5.0), (33, 4.3), (38.5, 4.3), (38.6, 3.95), (46, 3.6), (52, 2.2), (55.5, 0.7)], 16)
        finish(b, 'MagRounds')


def small():
    b = B(STEEL, 13)
    prism(b, [(17, 2), (14.5, -5), (13.2, -12), (13.8, -18), (16, -23.5), (13, -24), (9.5, -19), (8.5, -12), (9.5, -5), (11, 2)], -3.3, 3.3, 'yz'); finish(b, 'Trigger', 0.8)
    b = B(BRASS, 21)
    lathe(b, (0, 152.7, BZ), (0, 1, 0), [(0, 4.9), (0.9, 5.65), (1.6, 5.65), (1.9, 4.9), (2.7, 4.9), (3.2, 5.65), (27, 5.1), (31, 4.35), (38.6, 4.3), (38.6, 3.8), (30, 3.8)], 14)
    finish(b, 'Casing')


def build(groups):
    receiver(); selector(); cover(); bolt(); rear_sight(); barrel(); furniture(); magazine(); small()
    return dict(groups=groups, uvs={1: 1.2, 2: 1.3, 3: 1.25, 4: 1.0, 5: 0.7, 6: 0.9, 7: 1.0, 8: 0.9, 9: 0.8, 10: 1.6, 11: 1.0, 12: 0.5, 13: 1.0, 14: 0.8, 20: 0.4, 21: 0.4},
                parents=dict(MagRounds='Magazine'), origins=ORIG,
                empties=dict(Muzzle=(0, 579.4, BZ), Eject=(17.5, 122, 42), SightRear=(0, 154.5, SZ), SightFront=(0, 530, SZ)))
