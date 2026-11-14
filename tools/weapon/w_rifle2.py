# Valle Morta - AKM-pattern rifle view model: clean-sheet geometry (rifle_geo.py), grips and animation clips.
import os, math, numpy as np
from math import radians, sin, cos, pi
from mathutils import Vector, Matrix
import geo, rig as RG, rifle_geo as RGEO

ID = 'rifle2'; OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build', 'rifle.glb')   # temporary build; copied to public/assets/models once verified
PIVOT = (0, 0, 0); EYE = (-0.085, -0.24, 0.115)
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
def geometry(): return RGEO.build(GROUPS)


# ------------------------------------------------------------------ grips
def setup(st):
    from anim import Anchor
    rg = st.rig; F = RG.frame; A = st.A = {}
    g = st.grip('fire', 'R', 'Weapon', F((0.09, 0.99, -0.10), (0.99, -0.09, 0.03)), (0.026, -0.011, -0.040), (-8, 96, 1.5), (-0.99, 0.09, -0.03),
                fingers=('Middle', 'Ring', 'Pinky'), thumb=dict(aim=(0.05, 0.58, -0.81)), reach={'Index': (0.002, 0.0145, -0.015)}, back=0.03, retreat=(0, 0, 0))
    Hm = g.M; tp = Matrix.Translation((0, 0.013, 0.008)) @ Matrix.Rotation(radians(-12), 4, 'X') @ Matrix.Translation((0, -0.013, -0.008)) @ Vector((0.002, 0.0145, -0.015))
    ap, e = rg.reach('R', Hm, g.a, 'Index', tp); print('GRIP trigger pulled residual %.1f mm' % (e * 1000))
    A['grip'] = g; A['pull'] = Anchor('Weapon', Hm, rg.pose(ap), g.pose, g.retreat, ap); A['safe'] = g.variant(rg, Index=[10, 8, 5, 0]); st.IDX = g.variant(rg, Index=[-12, 55, 28, -4]).pose
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
    RR, RP = (30, 30, 16), (-0.05, -0.05, 0.05)                  # reload "workspace": muzzle up-left, magazine well rolled towards the support hand

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
    c.hand['L'].clear().hold(0, 0.06, A['hg'], open=0.06).hold(0.44, 1.88, A['mag'], close=0.10, open=0.07, lift=(-0.03, 0.0, -0.025)).hold(2.27, 2.4, A['hg'], close=0.09)
    c.hand['R'].clear().hold(0, 0.02, A['grip']).hold(0.16, 2.18, A['safe'], mid=st.IDX).hold(2.33, 2.4, A['grip'], mid=st.IDX)
    # ---- ReloadEmpty: magazine swap, then the support hand racks the charging handle over the top
    c = Clip(st, 'ReloadEmpty', 3.0); T = mag_change(c, 0.93); KP, KR = (-0.03, -0.04, -0.02), (24, -58, 8)
    c.ps['MagRounds'] = Tr(1, [0.001]).k(0.93, [0.001]).k(0.96, [1.0], ease='lin')
    c.wr.k(1.66, RR).k(2.06, KR).k(2.46, (23, -57, 8)).k(2.82, (-1.0, 2.0, -0.4), 'c').k(3.0, (0, 0, 0))
    c.wp.k(1.66, RP).k(2.06, KP).k(2.46, KP).k(2.82, (0.001, 0.002, -0.004), 'c').k(3.0, (0, 0, 0))
    c.pp['Bolt'].k(2.20, (0, 0, 0)).k(2.34, (0, -0.096, 0), ease='io').k(2.385, (0, -0.096, 0)).k(2.44, (0, 0, 0), ease='in')
    c.wp.add(kick(2.21, (0, -0.011, 0), 0.12, 0.05)).add(spring(2.44, (0, 0.004, -0.002), 7, 12)); c.wr.add(spring(2.44, (-1.2, 1.5, 0.4), 7, 12))
    c.pl['L'].k(2.08, (0, 0, 0)); c.pl['R'].k(1.70, (0, 0, 0)).k(2.06, (0.9, 0, 0.5)).k(2.46, (0.9, 0, 0.5)).k(2.85, (0, 0, 0))
    c.hand['L'].clear().hold(0, 0.06, A['hg'], open=0.06).hold(T(0.44), T(1.86), A['mag'], close=0.10, open=0.07, lift=(-0.03, 0.0, -0.025)).hold(2.10, 2.34, A['hook'], close=0.08, open=0.02, lift=(-0.02, 0.0, 0.04))
    c.hand['L'].hold(2.40, 2.43, A['rel'], mid='direct').hold(2.85, 3.0, A['hg'], close=0.09, lift=(-0.09, -0.02, 0.0))
    c.hand['R'].clear().hold(0, 0.02, A['grip']).hold(0.16, 2.78, A['safe'], mid=st.IDX).hold(2.93, 3.0, A['grip'], mid=st.IDX)
    c.ev(2.34, 'bolt_back').ev(2.44, 'bolt_forward')
