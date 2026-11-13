# Valle Morta - 9 mm service pistol view model: grips and animation clips (geometry in pistol_geo.py, texture detail in surf.hook_pistol).
import math, numpy as np
from math import radians, sin, cos, pi
from mathutils import Vector, Matrix
import rig as RG, pistol_geo as PG

ID = 'pistol'; PIVOT = (0, -0.075, -0.02); EYE = (-0.05, -0.28, 0.08)        # weapon rotations pivot about the wrists
GROUPS = ['PistolBody', 'Slide', 'Barrel', 'Magazine', 'MagRounds', 'Trigger', 'Hammer', 'SlideStop', 'Casing']
PARTS = ['Slide', 'Barrel', 'Magazine', 'Trigger', 'Hammer', 'SlideStop']
SHOULDER = {'R': (0.10, -0.62, -0.07), 'L': (-0.22, -0.57, -0.07)}; POLE = {'R': (0.6, 0, -1), 'L': (-0.8, 0, -0.7)}
VIEWS = [('first person', EYE, (EYE[0], 1.0, EYE[2]), 52), ('right', (0.36, 0.03, 0.02), (0.0, 0.03, 0.0), 30), ('left', (-0.36, 0.03, 0.04), (0.0, 0.03, 0.0), 30),
         ('behind', (-0.07, -0.30, 0.13), (0.0, 0.0, 0.01), 32), ('below front', (-0.14, 0.27, -0.17), (0.0, 0.0, -0.02), 34), ('top', (0.02, -0.02, 0.36), (0.0, 0.03, 0.0), 34)]
MISC = [('Idle', 1), ('Fire', '0-1-2-3-4-6-9'), ('Draw', 5), ('Holster', 4), ('Sprint', 3)]
CAMS = {'Fire': ((0.30, 0.0, 0.06), (0.0, 0.0, 0.02), 30)}
LOCK = PG.LOCK * 0.001; TP = Vector(PG.TPAD) * 0.001
META = dict(eye=list(EYE), fov=52, slide_lock_m=LOCK, hammer_over_deg=PG.HOVER - PG.HCOCK, barrel_tilt_deg=2.0,
            note='preview camera of the contact sheets: eye position relative to the model origin (Blender axes x right, y forward, z up). Rest pose = hammer cocked, '
                 'finger on the trigger. Slide locked back = node Slide moved slide_lock_m towards the shooter (glTF +Z), Hammer rotated hammer_over_deg further back, '
                 'Barrel tilted barrel_tilt_deg and 3 mm back, SlideStop raised 3 deg; ReloadEmpty goes there within its first 2 frames. MagRounds (child of Magazine) '
                 'is scaled away for the empty magazine in ReloadEmpty. Sprint is a seamless loop in a compressed high-ready pose (muzzle up, close to the chest) (cross-fade into it).')


def geometry(): return PG.build(GROUPS)


# ------------------------------------------------------------------ grips
def setup(st):
    import bpy
    from anim import Anchor
    rg = st.rig; F = RG.frame; A = st.A = {}; mm = 0.001
    g = st.grip('fire', 'R', 'Weapon', F((0.06, 0.99, -0.10), (0.99, -0.06, 0.02)), (0.026, 0.0155, -0.025), (-8, 96, 1.5), (-0.99, 0.06, -0.02),
                fingers=('Middle', 'Ring', 'Pinky'), thumb=dict(aim=(-0.19, 0.18, -0.95), flex=(0, 1, 0)), reach={'Index': TP}, back=0.03, retreat=(0, 0, 0))     # zero retreat: finger-only transitions must not move the wrist
    Hm = g.M; piv = Vector((0, PG.TRIG[0] * mm, PG.TRIG[1] * mm))
    tp = Matrix.Translation(piv) @ Matrix.Rotation(radians(-11), 4, 'X') @ Matrix.Translation(-piv) @ TP
    ap, e = rg.reach('R', Hm, g.a, 'Index', tp); print('GRIP trigger pulled residual %.1f mm' % (e * 1000))
    A['grip'] = g; A['pull'] = Anchor('Weapon', Hm, rg.pose(ap), g.pose, g.retreat, ap)
    A['safe'] = g.variant(rg, Index=[4, 6, 4, 10]); st.IDX = g.variant(rg, Index=[2, 46, 24, 9]).pose          # straight along the frame / in-between pose
    th = g.a['Thumb']; A['rel'] = A['safe'].variant(rg, Thumb=[th[0], th[1], th[2], th[3] + 1.5, th[4] + 2.5])   # thumb presses the magazine release
    bv = RG.bvh_of(st.meshes, extra=rg.proxy('R', Hm, g.pose))                                                 # support hand wraps the firing hand
    s = st.grip('support', 'L', 'Weapon', F((0.2, 0.90, -0.40), (-1, 0.1, 0)), (-0.030, 0.037, -0.047), (-8, 96, 1.5), (1, 0, 0), bvh=bv,
                thumb=dict(aim=(-0.63, 0.77, -0.25), flex=(0, 0.3, -1)), back=0.05, retreat=(-0.05, -0.01, -0.03))
    A['sup'] = s; th = s.a['Thumb']; A['sup0'] = Anchor('Weapon', s.M, s.pose, s.pre, (0, 0, 0), s.a); A['supth'] = A['sup0'].variant(rg, Thumb=[th[0], th[1], th[2], max(th[3] - 16, 0), max(th[4] - 16, 0)])
    mb = RG.bvh_of([bpy.data.objects['Magazine'], bpy.data.objects['MagRounds']])
    A['magh'] = st.grip('mag', 'L', 'Magazine', F(tuple(PG.FD), (-1, 0, 0)), tuple(PG.mq(90, 26.5, -25) * mm), (-8, 96, 1.5), (1, 0, 0), bvh=mb,
                        thumb=dict(aim=(-0.55, 0.0, -0.83), flex=(0, 1, 0)), back=0.04, retreat=(-0.05, 0.0, -0.02))
    pa = rg.pre(A['magh'].a); pa['Thumb'][0] = A['magh'].a['Thumb'][0] + 6; pa['Thumb'][1] = A['magh'].a['Thumb'][1]
    pa.update({f: [A['magh'].a[f][0] - 38, A['magh'].a[f][1] * 0.8, A['magh'].a[f][2] * 0.8, A['magh'].a[f][3]] for f in ('Index', 'Middle', 'Ring', 'Pinky')})   # fingers open at the knuckle, hooks stay
    A['magh'].pre = rg.pose(pa)   # open without dropping the thumb into the magazine
    yh = Vector((0.6, 0, 0)) + PG.FD * 0.8                                                                     # palm under the base plate, pushing up the well axis
    A['palm'] = st.grip('palm', 'L', 'Magazine', F(tuple(yh), tuple(PG.AD)), tuple(PG.mq(PG.ML + 6.2, 1.2, 0) * mm), (0, 40, -13.5), None, a0=RG.A_SPREAD,
                        fingers=(), thumb=False, retreat=tuple(PG.AD * 0.04))
    # open hand slid off the lower end of the magazine (the grip encircles it, so it cannot leave sideways): the change from the magazine grip to the palm turns the hand by about 100 deg, which must happen clear of magazine and frame
    A['magoff'] = Anchor('Magazine', Matrix.Translation(PG.AD * 0.06 + Vector((-0.012, 0, 0))) @ A['magh'].M, rg.OPEN, rg.OPEN, (0, 0, 0))
    st.base = {'R': A['grip'], 'L': A['sup']}


# ------------------------------------------------------------------ clips
def clips(st):
    from anim import Clip, Tr, Anchor, spring, kick
    A = st.A; rg = st.rig; v3 = lambda *a: np.array(a, float); f = 1 / 60.0; AD = np.array(PG.AD); dH = PG.HOVER - PG.HCOCK; ax = lambda d: tuple(AD * d)
    lk, bt, Z = (0, -LOCK, 0), (0, -0.003, 0), (0, 0, 0)
    # ---- Idle: breathing
    c = Clip(st, 'Idle', 4.0, True); w = 2 * pi / 4.0
    c.wp.add(lambda t: v3(0.0006 * sin(2 * w * t), 0.0, 0.0014 * sin(w * t)))
    c.wr.add(lambda t: v3(0.3 * sin(w * t), 0.2 * sin(2 * w * t), 0.14 * sin(w * t + 0.6) - 0.14 * sin(0.6)))
    for sd in 'RL': c.sh[sd].add(lambda t: v3(0.0, 0.0, 0.003 * sin(w * t)))
    # ---- Fire: slide fully back at 17 ms, home at 67 ms; barrel unlocks and tilts, the slide rides over the hammer, wrists snap
    c = Clip(st, 'Fire', 0.3); c.ev(0.017, 'shell')
    c.pp['Slide'].k(f, lk, ease='lin').k(2 * f, (0, -0.034, 0), ease='lin').k(3 * f, (0, -0.016, 0), ease='lin').k(4 * f, Z, ease='lin')
    c.pp['Barrel'].k(f, bt, ease='lin').k(3 * f, bt).k(4 * f, Z, ease='lin'); c.pr['Barrel'].k(f, (2.0, 0, 0), ease='lin').k(3 * f, (2.0, 0, 0)).k(4 * f, Z, ease='lin')
    c.pr['Hammer'].k(f, (dH, 0, 0), ease='lin').k(3 * f, (dH, 0, 0)).k(4 * f, Z, ease='lin')
    c.pr['Trigger'].k(f, (-11, 0, 0), ease='lin').k(0.10, (-11, 0, 0)).k(0.18, Z, ease='io')
    c.wp.add(kick(0, (0, -0.011, 0.0015), 0.02, 0.07)); c.wr.add(spring(0, (5.0, 0.8, 0.6), 9, 16)).add(kick(0, (1.6, 0, 0), 0.03, 0.12))
    for sd, k in (('R', 1.0), ('L', 0.7)): c.sh[sd].add(kick(0, (0, -0.006 * k, 0.002 * k), 0.03, 0.09))
    c.hand['R'].clear().hold(0, 0.18, A['pull'], close=f, open=0.07).hold(0.18, 0.3, A['grip'])
    # ---- Draw / Holster: one-handed from the holster side, the support hand joins late / leaves first
    low_p, low_r = (0.08, -0.12, -0.22), (-36, -8, -6)
    wait = Anchor('World', Matrix.Translation((-0.02, -0.05, -0.10)) @ A['sup'].M, rg.RELAX, rg.RELAX, (0, 0, 0))
    c = Clip(st, 'Draw', 0.3); c.wp.k(0, low_p).k(0.21, (0, 0.006, 0.008), 'c').k(0.3, Z); c.wr.k(0, low_r).k(0.21, (3.0, 1.5, 0.6), 'c').k(0.3, Z)
    c.hand['L'].clear().hold(0, 0.08, wait).hold(0.25, 0.3, A['sup'], close=0.05)
    c.hand['R'].clear().hold(0, 0.17, A['safe']).hold(0.29, 0.3, A['grip'], mid=st.IDX)
    c = Clip(st, 'Holster', 0.3); c.wp.k(0.05, (0, 0.003, 0.005), 'c').k(0.3, low_p, ease='in'); c.wr.k(0.05, (1.5, 0, 0), 'c').k(0.3, low_r, ease='in')
    c.hand['L'].clear().hold(0, 0.03, A['sup'], open=0.03).hold(0.22, 0.3, wait)
    c.hand['R'].clear().hold(0, 0.01, A['grip']).hold(0.12, 0.3, A['safe'], mid=st.IDX)
    # ---- Sprint: compressed high ready (muzzle up, close to the chest), two-step bob
    c = Clip(st, 'Sprint', 0.7, True); w2 = 2 * pi / 0.7; bp, br = (-0.03, -0.10, -0.075), (42, 0, 8)
    c.wp.k(0, bp).k(0.7, bp).add(lambda t: v3(0.010 * sin(w2 * t), 0.004 * sin(2 * w2 * t + 1.0) - 0.004 * sin(1.0), 0.012 * sin(2 * w2 * t)))
    c.wr.k(0, br).k(0.7, br).add(lambda t: v3(2.5 * sin(2 * w2 * t + 0.7) - 2.5 * sin(0.7), 2.5 * sin(w2 * t), 1.5 * sin(w2 * t + 0.5) - 1.5 * sin(0.5)))
    c.hand['R'].clear().hold(0, 0.7, A['safe'])
    for sd in 'RL': c.sh[sd].add(lambda t: v3(0.0, 0.0, 0.006 * sin(2 * w2 * t)))
    RR, RP = (30, 35, 4), (-0.04, -0.03, 0.062)                    # reload workspace: muzzle up, magazine well rolled towards the support hand, pistol pulled in

    def swap(c, k, rend):
        """shared magazine change, times scaled by k: release with the firing thumb, the magazine drops free, a fresh one comes up from the belt, is guided
        into the well and seated with the palm; rend = time the trigger finger starts back to the trigger"""
        T = lambda x: x * k; mr, mq = c.pr['Magazine'], c.pp['Magazine']
        c.wr.k(T(0.04), (0.5, 0.5, 0), 'c').k(T(0.30), RR).k(T(1.02), (31, 36, 4.5), 'c').k(T(1.24), (29.5, 34.5, 4)).k(T(1.42), RR)
        c.wp.k(T(0.04), (0, -0.001, 0), 'c').k(T(0.30), RP).k(T(1.02), (-0.041, -0.03, 0.060), 'c').k(T(1.24), (-0.04, -0.03, 0.064)).k(T(1.42), RP)
        Wm = c.env(T(0.66))[0]['Weapon']; BELT = tuple(Wm.inverted() @ Vector((-0.17, -0.27, -0.36)) - st.org['Magazine']); BR = (25, 10, -35)
        mq.k(T(0.30), Z).k(T(0.62), ax(0.52), ease='in').k(T(0.64), BELT, ease='lin').k(T(0.72), BELT).k(T(0.97), tuple(AD * 0.130 + v3(-0.012, 0.004, 0)), 'c')
        mq.k(T(1.06), ax(0.112)).k(T(1.10), ax(0.086), ease='out').k(T(1.25), ax(0.086)).k(T(1.34), Z, ease='in')
        mr.k(T(0.30), Z).k(T(0.45), Z).k(T(0.62), (14, 0, 5), ease='in').k(T(0.64), BR, ease='lin').k(T(0.72), BR).k(T(0.97), (7, -5, -12), 'c').k(T(1.06), Z).k(T(1.34), Z)
        c.wr.add(spring(T(0.30), (-0.8, 0.5, 0.2), 6, 11)).add(spring(T(1.14), (0.5, -0.3, 0), 7, 13)).add(spring(T(1.34), (1.9, -0.9, 0.3), 6, 11))
        c.wp.add(spring(T(0.30), (0, 0.001, 0.002), 6, 11)).add(spring(T(1.34), (0, 0.002, 0.006), 6, 11))
        belt = Anchor('World', A['magh'].world(c.env(T(0.66))[0]), A['magh'].pre, A['magh'].pre, (0, 0, 0))
        c.hand['L'].clear().hold(0, T(0.05), A['sup'], open=0.05).hold(T(0.50), T(0.64), belt, lift=(-0.07, -0.03, 0.0)).hold(T(0.68), T(1.10), A['magh'], close=0.04, open=0.04, mid='direct').hold(T(1.16), T(1.17), A['magoff'], mid='direct')
        c.hand['L'].hold(T(1.25), T(1.37), A['palm'], mid='direct', lift=(-0.02, -0.01, -0.03))
        c.hand['R'].clear().hold(0, 0.02, A['grip']).hold(T(0.14), T(0.20), A['safe'], mid=st.IDX).hold(T(0.26), T(0.35), A['rel'], mid='direct')
        c.hand['R'].hold(T(0.46), rend, A['safe'], mid='direct')
        c.ev(T(0.30), 'mag_out').ev(T(1.34), 'mag_in').ev(T(1.34), 'ammo')
        return T
    # ---- Reload (round in the chamber)
    c = Clip(st, 'Reload', 1.7); T = swap(c, 1.0, 1.52)
    c.wr.k(1.63, (-1.2, -1.0, -0.4), 'c').k(1.7, Z); c.wp.k(1.63, (0.001, 0.002, -0.003), 'c').k(1.7, Z)
    c.hand['L'].hold(1.60, 1.7, A['sup'], close=0.08); c.hand['R'].hold(1.66, 1.7, A['grip'], mid=st.IDX)
    # ---- ReloadEmpty: slide locked back from frame 2, same change, then the support thumb drops the slide stop
    c = Clip(st, 'ReloadEmpty', 2.1); T = swap(c, 1.1, 1.92); tr = 1.86
    c.pp['Slide'].k(2 * f, lk, ease='out').k(tr, lk).k(tr + 2 * f, Z, ease='in')
    c.pp['Barrel'].k(2 * f, bt, ease='out').k(tr, bt).k(tr + 2 * f, Z, ease='in'); c.pr['Barrel'].k(2 * f, (2.0, 0, 0), ease='out').k(tr, (2.0, 0, 0)).k(tr + 2 * f, Z, ease='in')
    c.pr['Hammer'].k(2 * f, (dH, 0, 0), ease='out').k(tr, (dH, 0, 0)).k(tr + 2 * f, Z, ease='in')
    c.pr['SlideStop'].k(2 * f, (-3, 0, 0), ease='out').k(tr - 0.03, (-3, 0, 0)).k(tr, Z, ease='in')
    c.ps['MagRounds'] = Tr(1, [0.001]).k(T(0.62), [0.001]).k(T(0.64), [1.0], ease='lin')
    c.wr.k(1.80, (1.5, 0.8, 0.3), 'c').k(2.02, (-0.4, 0, 0), 'c').k(2.1, Z); c.wp.k(1.80, (0, 0.001, 0.002), 'c').k(2.1, Z)
    c.wr.add(spring(tr + 2 * f, (-1.7, 0.5, 0.2), 8, 13)); c.wp.add(spring(tr + 2 * f, (0, 0.003, -0.001), 8, 13))
    c.hand['L'].hold(1.74, 1.80, A['supth'], close=0.06, lift=(-0.03, 0, -0.02)).hold(tr, 2.1, A['sup0'], mid='direct'); c.hand['R'].hold(2.06, 2.1, A['grip'], mid=st.IDX)
    c.ev(tr, 'slide_release')
