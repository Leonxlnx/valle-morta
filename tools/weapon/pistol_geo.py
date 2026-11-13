# Valle Morta - 9 mm service pistol, clean-sheet geometry. Millimetres, Blender axes (+X right, +Y muzzle, +Z up), origin inside the top of the grip.
# Layout constants are shared with w_pistol.py (grips / clips) and surf.hook_pistol (texture detail).
import math, bmesh
from math import radians, sin, cos, pi
from mathutils import Vector, Matrix
from geo import B, V, box, prism, loft, lathe, cyl, dome, rrect, thick, smooth2, perp, finish, boolean_diff, tube, STEEL, MAGS, BOLT, BRASS

POLY, BLUED, COPPER, WHITE, DARK, PARK = 15, 18, 20, 22, 23, 24
BZ, SZ, ZB, ZT, HW, YR, YF = 45.5, 61.2, 30.5, 55.0, 13.6, -60.0, 124.0        # bore axis, sight line, slide bottom / top / half width / rear / front
GA = math.atan(0.2794); AD = V(0, -sin(GA), -cos(GA)); FD = V(0, cos(GA), -sin(GA))   # grip rake 15.6 deg: magazine axis (pointing down) and its forward normal
MT = V(0, -1.04, 25.0); ML = 105.0; UF, UB = 19.7, -32.0                        # magazine top centre, body length, front / back strap offsets from the axis
HPIV = (-50.0, 22.0); HCOCK, HOVER = 44.0, 56.0                                 # hammer pivot (y, z); cocked (rest pose) and slide-over angles from the fired position
HAMP = [(-53, 20), (-60.4, 31), (-60.4, 48), (-61.5, 51), (-66, 52.2), (-71, 52.2), (-71.5, 50), (-66.5, 48.6), (-64.6, 45), (-64.8, 34), (-60, 24), (-55, 18)]
LOCK = 45.0; TRIG = (31.0, 16.0); TPAD = (1.5, 30.0, 2.0)                       # slide travel to the stop, trigger pivot (y, z), finger pad point on the trigger face
ORIG = dict(Slide=(0, 0, ZB), Barrel=(0, 100, BZ), Magazine=tuple(MT), MagRounds=tuple(MT), Trigger=(0, TRIG[0], TRIG[1]), Hammer=(0, HPIV[0], HPIV[1]),
            SlideStop=(-13, 18, 27), Casing=(0, 22, BZ))
CASE = [(0, 4.6), (0.4, 4.97), (1.1, 4.97), (1.3, 4.4), (2.2, 4.4), (2.6, 4.93), (19.15, 4.83)]


def mq(s, u, x=0.0): return MT + AD * s + FD * u + V(x, 0, 0)                    # point in magazine coordinates: s down the axis, u forward, x right
def mz(z, u, x=0.0): return mq((MT.z - z - u * sin(GA)) / cos(GA), u, x)        # same, on the horizontal plane at height z


def rpoly(pts, r, k=4):
    """polygon with filleted corners"""
    out = []; n = len(pts)
    for i in range(n):
        p = Vector(pts[i]); a = (Vector(pts[i - 1]) - p).normalized(); c = (Vector(pts[(i + 1) % n]) - p).normalized()
        h = math.acos(max(-1.0, min(1.0, a.dot(c)))) / 2; d = r / math.tan(h); ctr = p + (a + c).normalized() * (r / sin(h)); p0 = p + a * d; p1 = p + c * d
        for j in range(k + 1):
            q = p0.lerp(p1, j / k); out.append(tuple(ctr + (q - ctr).normalized() * r))
    return out


def lathe2(b, o, ax, prof, n=20, pids=None):
    """lathe with a part id per band (band i lies between profile points i and i + 1)"""
    o = Vector(o); ax = Vector(ax).normalized(); u, v = perp(ax)
    rings = [[o + ax * t + (u * cos(2 * pi * j / n) + v * sin(2 * pi * j / n)) * r for j in range(n)] for t, r in prof]
    return loft(b, rings, True, True, (lambda i, j: pids[i]) if pids else None)


def cutter(fn, *a, pid=STEEL):
    c = B(pid); fn(c, *a); return c


def slide(G):
    b = B(STEEL, 1)
    def ring(y, hw, zt, zb=ZB): return [V(x, y, z) for x, z in rrect(hw, (zt - zb) / 2, (0, 0, 5.0, 5.0), 3, 0, (zt + zb) / 2)]
    loft(b, [ring(YR, HW, ZT), ring(96, HW, ZT), ring(116, HW - 0.7, ZT - 0.3), ring(YF, HW - 1.6, ZT - 1.0, ZB + 1.2)])
    for c in (cutter(box, -8.4, 8.4, 8.0, 114.0, ZB - 2, 53.0),                 # barrel channel, open below
              cutter(box, -6.5, 20.0, 8.0, 40.0, 45.2, 60.0),                   # ejection port: over the top and down the right side
              cutter(cyl, (0, 108, BZ), (0, 130, BZ), 8.0, 16),                 # muzzle bore of the slide
              cutter(cyl, (0, 108, 34.8), (0, 130, 34.8), 3.4, 10),             # guide-rod hole
              cutter(box, -15.0, -11.6, 52.0, 59.0, ZB - 1, 33.6), cutter(box, -15.0, -11.6, 36.0, 42.0, ZB - 1, 33.0)):   # slide-stop and take-down notches
        boolean_diff(b, c)
    finish(b, G, 0.45)
    b = B(BLUED, 6)                                                             # sights, extractor, firing-pin retainer
    prism(b, [(-57.5, 54.6), (-44.5, 54.6), (-46, 57.6), (-57.5, 57.6)], -9.2, 9.2, 'yz')
    for sx in (-1, 1): prism(b, [(-57.5, 57.4), (-46.5, 57.4), (-49.5, SZ), (-57.5, SZ)], sx * 2.1, sx * 9.2, 'yz')
    prism(b, [(105, 54.2), (117, 54.2), (113, SZ), (106.2, SZ)], -1.9, 1.9, 'yz')
    prism(b, [(-21, 44.0), (7.0, 44.0), (8.6, 45.0), (8.6, 46.4), (7.0, 47.4), (-21, 47.4)], 13.2, 14.5, 'yz')
    box(b, -1.7, 1.7, -8.0, 5.0, 54.6, 55.7)                                    # loaded-chamber indicator
    finish(b, G, 0.35)
    b = B(BLUED, 6); dome(b, (14.4, -8, 45.7), (1, 0, 0), 1.1, 0.5, 8); cyl(b, (0, -60.4, BZ), (0, -59.5, BZ), 2.4, 10)
    for sx in (-1, 1): cyl(b, (sx * 13.5, -40, 37), (sx * 13.85, -40, 37), 1.5, 8)
    finish(b, G, 0.0)
    b = B(WHITE)                                                                # three dots
    for sx in (-1, 1): cyl(b, (sx * 5.6, -57.8, 59.4), (sx * 5.6, -57.3, 59.4), 1.15, 8)
    cyl(b, (0, 105.55, 59.2), (0, 106.3, 59.2), 1.05, 8); finish(b, G, 0.0)


def barrel(G):
    b = B(BOLT, 3)
    prism(b, [(x, z) for x, z in rrect(8.0, 8.55, (0, 0, 3.2, 3.2), 2, 0, 46.05)], 8.5, 39.6, 'xz'); box(b, -5, 5, 14, 34, 31, 38.2)
    finish(b, G, 0.4)
    b = B(BOLT, 3)
    lathe2(b, (0, 39, BZ), (0, 1, 0), [(0, 7.0), (84.9, 7.0), (86.5, 6.3), (86.5, 5.0), (85.2, 4.55), (62, 4.5), (61, 0.4)], 26, [BOLT, BOLT, BOLT, DARK, DARK, DARK])
    finish(b, G, 0.0)


def frame(G):
    cut = B(DARK); loft(cut, [[mq(s, v, x) for x, v in rrect(10.8, 16.9, 3.2, 2)] for s in (-12.0, 125.0)])          # magazine well
    b = B(PARK, 2)
    prism(b, [(-70, 26.5), (-62, 30.3), (118, 30.3), (119.5, 26.5), (118, 16.5), (61, 16.5), (57, 13.5), (16.5, 13.5), (15, 5), (-41, 5), (-47, 15), (-57, 21), (-70, 23.5)],
          -13.1, 13.1, 'yz')                                                   # a little wider than the grip core: no coplanar faces where they overlap
    boolean_diff(b, cut); finish(b, G, 0.8)
    b = B(PARK, 2)                                                              # grip: rounded sections along the rake, slight swell on the back strap
    def ub(s): return UB - 1.6 * sin(pi * min(1.0, max(0.0, (s - 30) / 75.0)))
    loft(b, [[mq(s, (UF + ub(s)) / 2 + v, x) for x, v in rrect(12.8 + (0.7 if s > 101 else 0.0), (UF - ub(s)) / 2, 6.0, 3)] for s in (12, 24, 38, 52, 66, 80, 92, 100, 104.9)])
    boolean_diff(b, cut); finish(b, G, 0.7)
    b = B(PARK, 2)                                                              # trigger guard, accessory rail
    prism(b, thick(smooth2([(58.5, 19), (59.6, 3), (58.5, -8), (53, -13.2), (39, -14.5), (27, -13), (19, -9), (14.5, -3), (13, 3)], 3), 4.6), -6.3, 6.3, 'yz')
    finish(b, G, 1.1)
    b = B(PARK, 2); sec = [(-7.6, 17.2), (-10.6, 14.4), (-10.6, 13.3), (-8.2, 10.9), (8.2, 10.9), (10.6, 13.3), (10.6, 14.4), (7.6, 17.2)]
    for y0, y1 in ((64, 72.6), (77.8, 87.8), (93, 103), (108.2, 116)): prism(b, sec, y0, y1, 'xz')
    box(b, -7.6, 7.6, 64, 116, 12.4, 17.2); finish(b, G, 0.5)
    b = B(BLUED, 6)                                                             # controls on the left side: take-down lever, decocker, magazine release
    prism(b, [(41.8, 23), (46.2, 23), (45.6, 13.8), (42.6, 13.8)], -14.6, -12.6, 'yz'); cyl(b, (-12.6, 44, 23.5), (-15.0, 44, 23.5), 3.4, 10)
    prism(b, [(1, 22.5), (9.5, 23.2), (10.5, 18), (7, 10.5), (3.5, 10.5), (3.2, 17)], -15.2, -12.6, 'yz')
    cyl(b, (-12.4, 9.5, 6.3), (-16.8, 9.5, 6.3), 3.3, 10)
    finish(b, G, 0.4)
    b = B(BLUED, 6)                                                             # pins, grip screws, guide rod
    for sx in (-1, 1):
        for y, z, r in ((TRIG[0], TRIG[1], 1.7), (HPIV[0], HPIV[1], 1.8), (-30, 12, 1.4)): dome(b, (sx * 12.8, y, z), (sx, 0, 0), r, 0.5, 8)
        for y, z in ((-16, -12), (-36.5, -56)): dome(b, (sx * 16.3, y, z), (sx, 0, 0), 2.7, 0.8, 10)
    dome(b, (12.8, 18, 27), (1, 0, 0), 2.0, 0.6, 8); dome(b, (12.8, 9.5, 6.3), (1, 0, 0), 2.6, 0.5, 8)
    lathe(b, (0, 44, 34.8), (0, 1, 0), [(0, 2.8), (79, 2.8), (80.6, 2.2)], 8)
    tube(b, [(-4, -58.5, -59), (-4.3, -63.5, -62), (0, -66, -64.5), (4.3, -63.5, -62), (4, -58.5, -59)], 1.3, 8, 4)      # lanyard loop
    finish(b, G, 0.0)
    for sx in (-1, 1):                                                          # grip panels
        b = B(POLY, 5); prism(b, rpoly([(9.2, 0), (-10.1, -69), (-57.3, -69), (-38.0, 0)], 5.0), sx * 12.4, sx * 16.4, 'yz'); finish(b, G, 1.3)


def magazine():
    b = B(MAGS, 4)
    top = [[mz(z, v, x) for x, v in rrect(hw, 16.3, 3.0, 2)] for z, hw in ((25.0, 6.6), (22.5, 7.6), (16.0, 10.2))]
    loft(b, top + [[mq(ML, v, x) for x, v in rrect(10.2, 16.3, 3.0, 2)]]); finish(b, 'Magazine', 0.35)
    b = B(POLY, 4)                                                              # base plate with a toe
    loft(b, [[mq(s, 1.2 + v, x) for x, v in rrect(hw, hh, 3.6, 2)] for s, hw, hh in ((ML, 11.5, 17.6), (ML + 1.4, 11.9, 18.1), (ML + 5.2, 11.9, 18.1), (ML + 6.2, 11.2, 17.4))])
    finish(b, 'Magazine', 0.5)
    b = B(DARK, 4)                                                              # witness holes
    for s in (38, 62, 86):
        for sx in (-1, 1): cyl(b, mq(s, -9, sx * 10.05), mq(s, -9, sx * 10.4), 1.5, 6)
    finish(b, 'Magazine', 0.0)
    b = B(BRASS, 20); ax = V(0, cos(radians(4)), sin(radians(4)))               # top round
    lathe2(b, (0, -16.5, 24.2), ax, CASE + [(19.15, 4.5), (22, 4.35), (26, 3.3), (28.6, 1.8), (29.7, 0.5)], 16, [BRASS] * 7 + [COPPER] * 4)
    finish(b, 'MagRounds', 0.0)


def small_parts():
    b = B(BLUED, 6); prism(b, thick(smooth2([(31.5, 19), (30, 10), (28, 3), (27.6, -3), (29.4, -8)], 3), 4.2), -3.5, 3.5, 'yz'); finish(b, 'Trigger', 0.9)
    b = B(BLUED, 6); prism(b, HAMP, -4.0, 4.0, 'yz')
    bmesh.ops.rotate(b.bm, cent=V(0, HPIV[0], HPIV[1]), matrix=Matrix.Rotation(radians(HCOCK), 3, 'X'), verts=b.bm.verts[:]); finish(b, 'Hammer', 0.7)
    b = B(BLUED, 6)
    prism(b, [(-33, 25), (-31.5, 29.8), (-19, 29.8), (-15, 28.6), (17, 28.6), (19.8, 27), (17, 25.4), (-15, 25.4), (-19, 24.4), (-31, 24.4)], -15.0, -12.7, 'yz')
    box(b, -17.0, -15.0, -32, -20, 27.2, 29.8); finish(b, 'SlideStop', 0.4)
    b = B(BLUED, 6); dome(b, (-15.0, 18, 27), (-1, 0, 0), 2.0, 0.6, 8); finish(b, 'SlideStop', 0.0)
    b = B(BRASS, 20); lathe(b, (0, 12.5, BZ), (0, 1, 0), CASE + [(19.15, 4.4), (4.0, 4.35)], 10); finish(b, 'Casing', 0.0)


def build(groups):
    G = groups[0]; frame(G); slide('Slide'); barrel('Barrel'); magazine(); small_parts()
    return dict(groups=groups, uvs={4: 0.75, 20: 0.6}, parents=dict(MagRounds='Magazine'), origins=ORIG,
                empties=dict(Muzzle=(0, 125.5, BZ), Eject=(15, 24, 49), SightRear=(0, -52, SZ), SightFront=(0, 110, SZ)))
