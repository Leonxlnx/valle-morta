# Valle Morta - AK-pattern rifle view model: geometry (base build in geo.py + detail pass), grips and animation clips.
import math, numpy as np
from math import radians, sin, cos, pi
from mathutils import Vector, Matrix
import geo, rig as RG
from geo import B, V, box, prism, loft, lathe, cyl, dome, tube, sweep, rrect, finish, STEEL, MAGS, BOLT, BRASS

ID = 'rifle'; PIVOT = (0, 0, 0); EYE = (-0.085, -0.24, 0.115)
GROUPS = ['RifleBody', 'Bolt', 'Magazine', 'MagRounds', 'Trigger', 'Selector', 'Casing']
PARTS = ['Bolt', 'Magazine', 'Trigger']
SHOULDER = {'R': (0.137, -0.617, 0.039), 'L': (-0.20, -0.20, -0.14)}; POLE = {'R': (-0.25, 0, -1), 'L': (-1.0, 0, -0.3)}
VIEWS = [('first person', EYE, (EYE[0], 1.0, EYE[2]), 52), ('right', (0.55, 0.12, 0.10), (0.0, 0.14, 0.0), 30), ('left close', (-0.36, 0.0, 0.14), (0.0, 0.14, 0.02), 32),
         ('firing grip', (0.30, -0.16, 0.02), (0.0, 0.0, -0.03), 30), ('grip from behind', (-0.16, -0.30, 0.10), (0.0, -0.02, -0.02), 30), ('support hand', (-0.22, 0.34, -0.24), (0, 0.22, 0.0), 34)]
MISC = [('Idle', 1), ('Fire', 6), ('Draw', 5), ('Holster', 4), ('Sprint', 4)]
CAMS = {'Fire': ((0.34, -0.02, 0.07), (0.0, 0.05, 0.012), 30)}
META = dict(eye=list(EYE), fov=52, note='preview camera of the contact sheets: eye position relative to the model origin (Blender axes x right, y forward, z up); '
            'Sprint is a seamless loop in the sprint carry pose (cross-fade into it); MagRounds (child of Magazine) is scaled away for the empty magazine in ReloadEmpty')


# ------------------------------------------------------------------ geometry
def geometry():
    info = geo.build_rifle(); G = geo.GROUPS; R = 'RifleBody'; HWR, BZ, SZ, mp = geo.HWR, geo.BZ, geo.SZ, geo.mp
    G['Selector'] = [G[R].pop(3)]; G['MagRounds'] = [G['Magazine'].pop(2)]
    b = B(STEEL)                                                   # extra rivets, spot welds, axis-pin retaining wire
    for sx in (-1, 1):
        for y, z in ((-68, 26), (168, 24), (150, 14), (88, 6), (128, 6), (20, 39), (-22, 40), (100, 40)):
            dome(b, (sx * HWR, y, z), (sx, 0, 0), 1.9, 0.8)
    tube(b, [(-HWR - 0.8, 22, 11), (-HWR - 0.8, 38, 7.5), (-HWR - 0.8, 55, 18), (-HWR - 0.8, 49, 30), (-HWR - 0.8, 40, 37)], 0.7, 6, 3)
    finish(b, R, 0.15, 1)
    b = B(STEEL, 3)                                                # lengthwise dust-cover ribs
    for th in (-36, 0, 36):
        a = radians(th); cx = 15.6 * sin(a); cz = 58 + 16 * cos(a) - 0.35
        prism(b, [(cx + u * cos(a) + v * sin(a), cz - u * sin(a) + v * cos(a)) for u, v in rrect(2.4, 1.0, 0.9, 2)], -60, 30, 'xz')
    finish(b, R, 0.25, 1)
    b = B(STEEL)                                                   # handguard retainer lever, muzzle detent, collar, catch pin, tang screws
    prism(b, [(352, 14), (370, 14), (372.5, 17), (370, 20), (352, 20)], 20.5, 23.4, 'yz')
    cyl(b, (0, 547, BZ - 13), (0, 552.5, BZ - 13), 1.6, 8)
    lathe(b, (0, 543.5, BZ), (0, 1, 0), [(0, 9.0), (1.2, 10.0), (4.2, 10.0), (5.4, 9.0)], 20, False, False)
    cyl(b, (-9.2, 66, -6), (9.2, 66, -6), 1.7, 10)
    for y in (-88, -100): dome(b, (0, y, 46.4), (0, 0, 1), 2.4, 0.6)
    for sx in (-1, 1): dome(b, (sx * 20.4, -150, 12), (sx, 0, 0), 3.0, 0.8)
    finish(b, R, 0.3, 1)
    # ---- magazine detail: floor plate, lugs, cross ribs, feed lips, second round
    Gm = 'Magazine'; b = B(MAGS, 4)
    def et(phi): return V(0, -sin(radians(phi)), cos(radians(phi)))
    loft(b, [[mp(ph, -v, x) for x, v in rrect(14.7, 33.7, 3.8, 3)] for ph in (234.5, 235.25)])
    cyl(b, mp(235.25, 8, 0), mp(235.7, 8, 0), 3.4, 12)
    p = mp(185.4, -33.2, 0); box(b, -6.5, 6.5, p.y - 1.5, p.y + 4.5, p.z - 4.5, p.z + 3.0)
    for sx in (-1, 1):
        for ph in (188.6, 192.2):
            sweep(b, [(mp(ph, -off, sx * 13.05), V(sx, 0, 0), et(ph), 0.9, 1.7) for off in range(-24, 25, 6)], 8, 2.5, True, True)
        up = -et(183.9)
        loft(b, [[mp(183.9, -off, sx * 13.0), mp(183.9, -off, sx * 7.2), mp(183.9, -off, sx * 7.2) + up * 1.3, mp(183.9, -off, sx * 13.0) + up * 1.3] for off in (-24, -8, 10, 27)])
    finish(b, Gm, 0.25, 1)
    b = B(BRASS, 21); a = radians(183.9); fw = V(0, -cos(a), -sin(a))
    lathe(b, mp(183.9, 27, -5.0) + V(0, 0, 0.5), fw, [(0, 5.2), (1, 5.65), (30, 5.0), (33, 4.3), (38.5, 4.3), (38.6, 3.95), (46, 3.6), (52, 2.2), (55.5, 0.7)], 10)
    finish(b, 'MagRounds')
    b = B(BRASS, 21)                                               # spent case template, parked inside the trunnion
    lathe(b, (0, 152.7, BZ), (0, 1, 0), [(0, 4.9), (0.9, 5.65), (1.6, 5.65), (1.9, 4.9), (2.7, 4.9), (3.2, 5.65), (27, 5.1), (31, 4.35), (38.6, 4.3), (38.6, 3.8), (30, 3.8)], 10)
    finish(b, 'Casing')
    return dict(groups=GROUPS, uvs={1: 1.15, 2: 1.4, 3: 1.25, 20: 0.35, 21: 0.5}, parents=dict(MagRounds='Magazine'),
                origins=dict(Magazine=(0, 139, 5), MagRounds=(0, 139, 5), Trigger=(0, 13, 8), Bolt=(0, 90, 55), Selector=(16.5, -28, 30), Casing=(0, 172, BZ)),
                empties=dict(Muzzle=(0, 579.4, BZ), Eject=(17.5, 120, 52), SightRear=(0, 154.5, SZ), SightFront=(0, 530, SZ)))


# ------------------------------------------------------------------ grips
def setup(st):
    from anim import Anchor
    rg = st.rig; F = RG.frame; A = st.A = {}
    g = st.grip('fire', 'R', 'Weapon', F((0.09, 0.99, -0.10), (0.99, -0.09, 0.03)), (0.026, -0.011, -0.040), (-8, 96, 1.5), (-0.99, 0.09, -0.03),
                fingers=('Middle', 'Ring', 'Pinky'), thumb=dict(aim=(0.05, 0.58, -0.81)), reach={'Index': (0.002, 0.0145, -0.015)}, back=0.03)
    Hm = g.M; tp = Matrix.Translation((0, 0.013, 0.008)) @ Matrix.Rotation(radians(-12), 4, 'X') @ Matrix.Translation((0, -0.013, -0.008)) @ Vector((0.002, 0.0145, -0.015))
    ap, e = rg.reach('R', Hm, g.a, 'Index', tp); print('GRIP trigger pulled residual %.1f mm' % (e * 1000))
    A['grip'] = g; A['pull'] = Anchor('Weapon', Hm, rg.pose(ap), g.pose, g.retreat, ap); A['safe'] = g.variant(rg, Index=[10, 8, 5, 0])
    A['hg'] = st.grip('handguard', 'L', 'Weapon', F((0.77, 0.64, 0.10), (0.1, 0, -1)), (0.008, 0.262, -0.004), (0, 62, 0), (0, 0, 1),
                      thumb=dict(aim=(-0.34, 0.59, -0.75)), retreat=(-0.025, -0.01, -0.06))
    A['mag'] = st.grip('magazine', 'L', 'Magazine', F((0.15, 0.80, 0.58), (-1, 0, 0)), (-0.024, 0.167, -0.060), (-8, 96, 1.5), (1, 0, 0),
                       thumb=dict(aim=(-0.55, 0.0, -0.83), flex=(0, 1, 0)), back=0.04, retreat=(-0.06, -0.03, -0.03))
    h = st.grip('charge', 'L', 'Bolt', F((0.92, 0, -0.38), (0.38, 0, 0.92)), (0.004, 0.147, 0.098), (-29, 92, 1), (0, 0, -1), a0=RG.A_OPEN,
                thumb=dict(aim=(-0.35, 0.82, -0.43), flex=(0, 1, 0)), retreat=(-0.03, 0.0, 0.06))
    A['hook'] = h
    A['rel'] = Anchor('Weapon', Matrix.Translation((0.012, -0.116, 0.035)) @ st.rest['Bolt'] @ h.M, h.pre, h.pre, (-0.03, 0, 0.05), h.a)
    st.base = {'R': A['grip'], 'L': A['hg']}


# ------------------------------------------------------------------ clips
def clips(st):
    from anim import Clip, Tr, spring, kick
    A = st.A; v3 = lambda *a: np.array(a, float)
    # ---- Idle: breathing
    c = Clip(st, 'Idle', 4.0, True); w = 2 * pi / 4.0
    c.wp.add(lambda t: v3(0.0005 * sin(2 * w * t), 0.0, 0.0013 * sin(w * t))); c.wr.add(lambda t: v3(0.22 * sin(w * t), 0.25 * sin(2 * w * t), 0.12 * sin(w * t)))
    for sd in 'RL': c.sh[sd].add(lambda t: v3(0.0, 0.0, 0.0025 * sin(w * t)))
    # ---- Fire: one shot
    c = Clip(st, 'Fire', 0.3); f = 1 / 60.0; c.ev(0.033, 'shell')
    c.pp['Bolt'].k(f, (0, -0.086, 0), ease='lin').k(2 * f, (0, -0.097, 0), ease='lin').k(3 * f, (0, -0.07, 0), ease='lin').k(4 * f, (0, -0.028, 0), ease='lin').k(5 * f, (0, 0, 0), ease='lin')
    c.pr['Trigger'].k(f, (-12, 0, 0), ease='lin').k(0.09, (-12, 0, 0)).k(0.17, (0, 0, 0), ease='io')
    c.wp.add(kick(0, (0, -0.0085, 0.001), 0.022, 0.05)); c.wr.add(spring(0, (1.5, 0.45, 0.35), 7.5, 13))
    c.sh['R'].add(kick(0, (0, -0.004, 0), 0.03, 0.06)); c.sh['L'].add(kick(0, (0, -0.002, 0), 0.03, 0.06))
    c.hand['R'].clear().hold(0, 0.17, A['pull'], close=f, open=0.08).hold(0.17, 0.3, A['grip'])
    # ---- Draw / Holster
    low_p, low_r = (0.05, -0.12, -0.27), (-52, 28, -14)
    c = Clip(st, 'Draw', 0.45); c.wp.k(0, low_p).k(0.30, (0, 0.004, 0.006), 'c').k(0.45, (0, 0, 0)); c.wr.k(0, low_r).k(0.30, (2.5, -1.5, 0.8), 'c').k(0.45, (0, 0, 0))
    c = Clip(st, 'Holster', 0.3); c.wp.k(0.06, (0, 0.002, 0.004), 'c').k(0.3, low_p, ease='in'); c.wr.k(0.06, (1.2, 0, 0), 'c').k(0.3, low_r, ease='in')
    # ---- Sprint: carry pose with a two-step bob
    c = Clip(st, 'Sprint', 0.7, True); w2 = 2 * pi / 0.7; bp, br = (-0.06, -0.05, -0.035), (20, 14, 36)
    c.wp.k(0, bp).k(0.7, bp).add(lambda t: v3(0.012 * sin(w2 * t), 0.004 * sin(2 * w2 * t + 1.0) - 0.004 * sin(1.0), 0.014 * sin(2 * w2 * t)))
    c.wr.k(0, br).k(0.7, br).add(lambda t: v3(2.2 * sin(2 * w2 * t + 0.7) - 2.2 * sin(0.7), 3.0 * sin(w2 * t), 1.6 * sin(w2 * t + 0.5) - 1.6 * sin(0.5)))
    c.hand['R'].clear().hold(0, 0.7, A['safe'])
    for sd in 'RL': c.sh[sd].add(lambda t: v3(0.0, 0.0, 0.006 * sin(2 * w2 * t)))
    RR, RP = (28, 30, 15), (-0.06, -0.03, -0.026)                  # reload "workspace": muzzle up-left, magazine well rolled towards the support hand

    def mag_change(c, k):
        """shared magazine swap, times scaled by k; returns the time the fresh magazine locks"""
        T = lambda x: x * k; mr, mq = c.pr['Magazine'], c.pp['Magazine']
        mr.k(T(0.54), (0, 0, 0)).k(T(0.64), (22, 0, 0), ease='in').k(T(0.76), (24, 0, 0), 'c').k(T(1.0), (58, 18, -28)).k(T(1.18), (55, 14, -24)).k(T(1.50), (25, 0, 0), 'c')
        mr.k(T(1.62), (22, 0, 0), ease='out').k(T(1.72), (0, 0, 0), ease='in')
        mq.k(T(0.64), (0, 0, 0)).k(T(0.76), (0, 0.031, -0.062), 'c').k(T(1.0), (-0.14, -0.20, -0.36)).k(T(1.18), (-0.15, -0.19, -0.35)).k(T(1.50), (0, 0.036, -0.072), 'c').k(T(1.62), (0, 0, 0), ease='out')
        c.wr.k(T(0.10), (2, 2, 1), 'c').k(T(0.46), RR).k(T(1.50), (27, 31, 14.5), 'c').k(T(1.72), RR)
        c.wp.k(T(0.10), (-0.003, -0.002, 0.0), 'c').k(T(0.46), RP).k(T(1.50), (-0.058, -0.032, -0.027), 'c').k(T(1.72), RP)
        c.wr.add(spring(T(0.61), (-1.1, 0.7, 0.2), 5, 10)).add(spring(T(1.60), (0.5, -0.3, 0), 6, 12)).add(spring(T(1.72), (1.7, -1.1, 0.3), 6, 11)).add(kick(T(1.80), (-0.9, 0.3, 0), 0.05, 0.08))
        c.wp.add(spring(T(0.61), (0, 0.002, -0.003), 5, 10)).add(spring(T(1.72), (0, -0.002, 0.005), 6, 11)).add(kick(T(1.80), (0, 0, -0.003), 0.05, 0.08))
        c.pl['L'].k(T(0.10), (0, 0, 0)).k(T(0.44), (1.0, -0.6, -0.7)).k(T(1.76), (1.0, -0.6, -0.7))
        c.ev(T(0.62), 'mag_out').ev(T(1.72), 'mag_in').ev(T(1.72), 'ammo')
        return T
    # ---- Reload (rounds left in the rifle)
    c = Clip(st, 'Reload', 2.4); T = mag_change(c, 1.0)
    c.wr.k(1.92, RR).k(2.24, (-1.5, -2, -0.8), 'c').k(2.4, (0, 0, 0)); c.wp.k(1.92, RP).k(2.24, (0.001, 0.002, -0.004), 'c').k(2.4, (0, 0, 0))
    c.pl['L'].k(2.28, (0, 0, 0))
    c.hand['L'].clear().hold(0, 0.06, A['hg'], open=0.06).hold(0.44, 1.88, A['mag'], close=0.10, open=0.07).hold(2.27, 2.4, A['hg'], close=0.09)
    c.hand['R'].clear().hold(0, 0.02, A['grip']).hold(0.14, 2.20, A['safe'], mid='direct').hold(2.32, 2.4, A['grip'], mid='direct')
    # ---- ReloadEmpty: magazine swap, then the support hand racks the charging handle over the top
    c = Clip(st, 'ReloadEmpty', 3.0); T = mag_change(c, 0.93); KP, KR = (-0.03, -0.03, -0.02), (24, -58, 8)
    c.ps['MagRounds'] = Tr(1, [0.001]).k(0.93, [0.001]).k(0.96, [1.0], ease='lin')
    c.wr.k(1.66, RR).k(2.06, KR).k(2.46, (23, -57, 8)).k(2.82, (-1.0, 2.0, -0.4), 'c').k(3.0, (0, 0, 0))
    c.wp.k(1.66, RP).k(2.06, KP).k(2.46, KP).k(2.82, (0.001, 0.002, -0.004), 'c').k(3.0, (0, 0, 0))
    c.pp['Bolt'].k(2.20, (0, 0, 0)).k(2.34, (0, -0.096, 0), ease='io').k(2.385, (0, -0.096, 0)).k(2.44, (0, 0, 0), ease='in')
    c.wp.add(kick(2.21, (0, -0.011, 0), 0.12, 0.05)).add(spring(2.44, (0, 0.004, -0.002), 7, 12)); c.wr.add(spring(2.44, (-1.2, 1.5, 0.4), 7, 12))
    c.pl['L'].k(2.08, (0, 0, 0)); c.pl['R'].k(1.70, (0, 0, 0)).k(2.06, (0.9, 0, 0.5)).k(2.46, (0.9, 0, 0.5)).k(2.85, (0, 0, 0))
    c.hand['L'].clear().hold(0, 0.06, A['hg'], open=0.06).hold(T(0.44), T(1.86), A['mag'], close=0.10, open=0.07).hold(2.10, 2.34, A['hook'], close=0.08, open=0.02)
    c.hand['L'].hold(2.40, 2.43, A['rel'], mid='direct').hold(2.85, 3.0, A['hg'], close=0.09)
    c.hand['R'].clear().hold(0, 0.02, A['grip']).hold(0.14, 2.80, A['safe'], mid='direct').hold(2.92, 3.0, A['grip'], mid='direct')
    c.ev(2.34, 'bolt_back').ev(2.44, 'bolt_forward')
