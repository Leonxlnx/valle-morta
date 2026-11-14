# Valle Morta - bolt-action precision rifle view model: grips and animation clips (geometry in sniper_geo.py, texture detail in surf.hook_sniper).
import math, numpy as np
from math import radians, sin, cos, pi
from mathutils import Vector, Matrix
import rig as RG, sniper_geo as SG

ID = 'sniper'; PIVOT = (0, -0.12, 0.02); EYE = (-0.12, -0.30, 0.15)       # weapon rotations pivot between the wrists and the shoulder pocket
GROUPS = ['SniperBody', 'Scope', 'BoltHandle', 'Striker', 'Magazine', 'MagRounds', 'Trigger', 'BipodL', 'BipodR', 'Casing']
PARTS = ['BoltHandle', 'Striker', 'Magazine', 'Trigger', 'BipodL', 'BipodR']
MOVERS = ['Magazine', 'BoltHandle', 'BipodL', 'BipodR']
ONLY = {'BipodL': ['BipodDeploy'], 'BipodR': ['BipodDeploy']}
SHOULDER = {'R': (0.10, -0.62, -0.12), 'L': (-0.17, -0.16, -0.10)}; POLE = {'R': (0.7, 0, -0.7), 'L': (-0.8, 0, -0.6)}
VIEWS = [('first person', EYE, (EYE[0], 1.0, EYE[2]), 52), ('right', (0.92, 0.22, 0.06), (0.0, 0.22, 0.0), 40), ('left', (-0.92, 0.22, 0.10), (0.0, 0.22, 0.0), 40),
         ('behind', (-0.16, -0.62, 0.26), (0.0, 0.05, 0.04), 40), ('below front', (-0.35, 0.75, -0.40), (0.0, 0.15, -0.02), 40), ('top', (0.04, 0.22, 1.05), (0.0, 0.22, 0.0), 45)]
MISC = [('Idle', 1), ('Fire', '0-1-2-4-8-14'), ('Draw', 4), ('Holster', 3), ('Sprint', 3)]
TRV = SG.TRAV * 0.001; LF = SG.LIFT; TP = Vector(SG.TPAD) * 0.001
META = dict(eye=list(EYE), fov=52, bolt_travel_m=TRV, bolt_lift_deg=LF, striker_fall_m=0.005, scope_eye=[0, -0.092, 0.108],
            note='preview camera of the contact sheets: eye position relative to the model origin (Blender axes x right, y forward, z up). Rest pose = bolt closed and cocked '
                 '(red indicator on the cocking piece visible), finger on the trigger. Bolt open = BoltHandle rotated bolt_lift_deg about the bore (handle up) and moved '
                 'bolt_travel_m towards the shooter. Striker (child of BoltHandle) falls striker_fall_m in Fire and is quietly re-cocked in the last 3 frames so that Fire '
                 'ends in the Idle pose. BipodL / BipodR are keyed only in BipodDeploy, which ends with the legs down and locked (play it clamped). ReloadEmpty opens the bolt, '
                 'changes the magazine (MagRounds hidden until the fresh one) and chambers. The scope tube is open at the ocular (no eye lens) so the engine can render '
                 'its own sight picture; the objective lens closes the front.')


def geometry(): return SG.build(GROUPS)


# ------------------------------------------------------------------ grips
def setup(st):
    import bpy
    from anim import Anchor
    rg = st.rig; F = RG.frame; A = st.A = {}; mm = 0.001
    # firing hand: knuckles diagonally outside the front strap, index pad on the trigger face
    g = st.grip('fire', 'R', 'Weapon', F((0.06, 0.99, -0.10), (0.99, -0.06, 0.02)), tuple(SG.gq(32, SG.UF + 9.5, SG.GW + 13) * mm), (-8, 96, 1.5), (-0.99, 0.06, -0.02),
                fingers=('Middle', 'Ring', 'Pinky'), thumb=dict(aim=(-0.19, 0.18, -0.95), flex=(0, 1, 0)), reach={'Index': TP}, back=0.03, retreat=(0, 0, 0))
    Hm = g.M; piv = Vector((0, SG.TRIG[0] * mm, SG.TRIG[1] * mm))
    tp = Matrix.Translation(piv) @ Matrix.Rotation(radians(-11), 4, 'X') @ Matrix.Translation(-piv) @ TP
    ap, e = rg.reach('R', Hm, g.a, 'Index', tp); print('GRIP trigger pulled residual %.1f mm' % (e * 1000))
    A['grip'] = g; A['pull'] = Anchor('Weapon', Hm, rg.pose(ap), g.pose, g.retreat, ap)
    A['safe'] = g.variant(rg, Index=[4, 6, 4, 10]); st.IDX = g.variant(rg, Index=[2, 46, 24, 9]).pose
    # support hand under the fore-end, palm up, fingers up the right side
    A['sup'] = st.grip('support', 'L', 'Weapon', F((0.55, 0.80, 0.22), (0.12, -0.2, -0.97)), (0.0, 0.262, -0.004), (0, 45, -14), (0, 0, 1), back=0.04, retreat=(-0.04, -0.03, -0.05))
    # bolt knob: palm over the knob, fingers round its front; the hand follows the knob but turns only 30 % with the handle
    kn = Vector(SG.KNOB) * mm
    b = st.grip('bolt', 'R', 'BoltHandle', F((-0.25, 0.9, -0.35), (0.55, 0.1, 0.83)), tuple(kn + Vector((0.003, -0.004, 0.012))), (-5, 86, -12), (-0.5, 0, -0.85), a0=RG.A_OPEN, fingers=('Index', 'Middle', 'Ring'),
                back=0.04, retreat=(0.02, -0.03, 0.04))
    A['bolt'] = Anchor('BoltHandle', b.M, b.pose, b.pre, b.retreat, b.a, pivot=kn - Vector(SG.ORIG['BoltHandle']) * mm, rotpar='Weapon', follow=0.3)
    # magazine: palm under the base plate, fingers over the front face, thumb up the back to the release paddle
    mb = RG.bvh_of([bpy.data.objects['Magazine'], bpy.data.objects['MagRounds']])
    A['magh'] = st.grip('mag', 'L', 'Magazine', F((0.1, 0.95, 0.3), (0, 0.3, -0.95)), (0.0, SG.MAGY * mm, (SG.MAGB - 7) * mm), (0, 45, -14), (0, 0, 1), bvh=mb, back=0.04,
                        retreat=(-0.03, -0.02, -0.05))
    # bipod: both folded legs gathered in the support hand from below
    lb = RG.bvh_of([bpy.data.objects['BipodL'], bpy.data.objects['BipodR']])
    A['bip'] = st.grip('bipod', 'L', 'BipodL', F((0.6, 0.75, 0.25), (0.1, -0.2, -0.97)), (0.0, 0.545, -0.021), (0, 45, -14), (0, 0, 1), bvh=lb, back=0.04, retreat=(-0.03, -0.04, -0.05))
    st.base = {'R': A['grip'], 'L': A['sup']}


# ------------------------------------------------------------------ clips
def clips(st):
    from anim import Clip, Tr, Anchor, spring, kick
    A = st.A; rg = st.rig; v3 = lambda *a: np.array(a, float); f = 1 / 60.0; Z = (0, 0, 0); up = (0, -LF, 0); bk = (0, -TRV, 0)
    # ---- Idle: breathing
    c = Clip(st, 'Idle', 4.0, True); w = 2 * pi / 4.0
    c.wp.add(lambda t: v3(0.0008 * sin(2 * w * t), 0.0, 0.0018 * sin(w * t)))
    c.wr.add(lambda t: v3(0.35 * sin(w * t), 0.25 * sin(2 * w * t), 0.18 * sin(w * t + 0.6) - 0.18 * sin(0.6)))
    for sd in 'RL': c.sh[sd].add(lambda t: v3(0.0, 0.0, 0.003 * sin(w * t)))
    # ---- Fire: striker falls on frame 1, trigger breaks, heavy recoil through both hands; no bolt movement
    c = Clip(st, 'Fire', 0.3)
    c.pp['Striker'].k(f, (0, 0.005, 0), ease='lin').k(0.25, (0, 0.005, 0)).k(0.3, Z, ease='io')
    c.pr['Trigger'].k(f, (-11, 0, 0), ease='lin').k(0.12, (-11, 0, 0)).k(0.2, Z, ease='io')
    c.wp.add(kick(0, (0, -0.028, 0.004), 0.025, 0.14)); c.wr.add(spring(0, (6.5, 1.2, -0.8), 5.5, 9)).add(kick(0, (2.5, 0, 0), 0.03, 0.16))
    for sd, k in (('R', 1.0), ('L', 0.8)): c.sh[sd].add(kick(0, (0, -0.02 * k, 0.004 * k), 0.03, 0.14))
    c.hand['R'].clear().hold(0, 0.16, A['pull'], close=f, open=0.06).hold(0.16, 0.3, A['grip'])

    def leave(c, t):          # firing hand: trigger finger out of the guard, then towards the knob
        c.hand['R'].clear().hold(0, t + 0.02, A['grip']).hold(t + 0.06, t + 0.07, A['safe'], mid=st.IDX)

    def back_to_grip(c, t, end):
        c.hand['R'].hold(t, t + 0.04, A['safe'], lift=(0.04, -0.02, 0.04)).hold(end - 0.02, end, A['grip'], mid=st.IDX)
    # ---- BoltCycle: lift, pull (case out), push, lock, back to the grip
    c = Clip(st, 'BoltCycle', 1.1); bh, bp_ = c.pr['BoltHandle'], c.pp['BoltHandle']
    bh.k(0.19, Z).k(0.29, up, ease='io').k(0.69, up).k(0.79, Z, ease='in')
    bp_.k(0.30, Z).k(0.46, bk, ease='in').k(0.52, bk).k(0.67, Z, ease='in')
    c.ev(0.44, 'shell').ev(0.46, 'bolt_back').ev(0.67, 'bolt_forward')
    leave(c, 0.0); c.hand['R'].hold(0.17, 0.80, A['bolt'], close=0.04, open=0.04, lift=(0.02, -0.02, 0.03)); back_to_grip(c, 0.96, 1.1)
    c.wr.k(0.12, (-0.5, -2.5, 0.5), 'c').k(0.30, (-1.0, -5.0, 1.0), 'c').k(0.46, (-1.5, -4.0, 1.5), 'c').k(0.67, (-0.8, -4.5, 0.8), 'c').k(0.86, (0.0, -2.0, 0.3), 'c').k(1.1, Z)
    c.wp.k(0.30, (0, -0.002, 0.006), 'c').k(0.46, (0, -0.006, 0.008), 'c').k(0.67, (0, 0.002, 0.006), 'c').k(1.1, Z)
    c.wp.add(spring(0.46, (0, -0.003, 0), 9, 14)).add(spring(0.67, (0, 0.004, 0.0), 9, 14))
    c.wr.add(spring(0.46, (0.8, 0, 0), 8, 13)).add(spring(0.67, (-0.6, 0.6, 0), 8, 13)).add(spring(0.79, (0.3, -0.8, 0), 9, 14))
    c.sh['R'].k(0.02, Z, 'c').k(0.20, (0, 0.04, 0.05), 'c').k(0.46, (0, 0.0, 0.04), 'c').k(0.80, (0, 0.04, 0.05), 'c').k(1.1, Z)
    # ---- Draw / Holster: the rifle comes up from low right, the support hand joins late / leaves first
    low_p, low_r = (0.10, -0.10, -0.26), (-38, -20, -15)
    wait = Anchor('World', Matrix.Translation((-0.03, -0.12, -0.10)) @ A['sup'].M, rg.RELAX, rg.RELAX, (0, 0, 0))
    c = Clip(st, 'Draw', 0.45); c.wp.k(0, low_p).k(0.32, (0, 0.008, 0.01), 'c').k(0.45, Z); c.wr.k(0, low_r).k(0.32, (3.0, 1.5, 0.8), 'c').k(0.45, Z)
    c.hand['L'].clear().hold(0, 0.14, wait).hold(0.36, 0.45, A['sup'], close=0.07)
    c.hand['R'].clear().hold(0, 0.25, A['safe']).hold(0.42, 0.45, A['grip'], mid=st.IDX)
    c = Clip(st, 'Holster', 0.3); c.wp.k(0.06, (0, 0.004, 0.006), 'c').k(0.3, low_p, ease='in'); c.wr.k(0.06, (1.5, 0, 0), 'c').k(0.3, low_r, ease='in')
    c.hand['L'].clear().hold(0, 0.03, A['sup'], open=0.03).hold(0.2, 0.3, wait)
    c.hand['R'].clear().hold(0, 0.01, A['grip']).hold(0.12, 0.3, A['safe'], mid=st.IDX)
    # ---- Sprint: muzzle swung down-left across the body, two-step bob
    c = Clip(st, 'Sprint', 0.8, True); w2 = 2 * pi / 0.8; sp, sr = (-0.02, -0.08, -0.06), (-14, -28, 38)
    c.wp.k(0, sp).k(0.8, sp).add(lambda t: v3(0.012 * sin(w2 * t), 0.005 * sin(2 * w2 * t + 1.0) - 0.005 * sin(1.0), 0.014 * sin(2 * w2 * t)))
    c.wr.k(0, sr).k(0.8, sr).add(lambda t: v3(2.5 * sin(2 * w2 * t + 0.7) - 2.5 * sin(0.7), 3.0 * sin(w2 * t), 2.0 * sin(w2 * t + 0.5) - 2.0 * sin(0.5)))
    c.hand['R'].clear().hold(0, 0.8, A['safe'])
    for sd in 'RL': c.sh[sd].add(lambda t: v3(0.0, 0.0, 0.006 * sin(2 * w2 * t)))
    # ---- BipodDeploy: the support hand gathers both legs, swings them down until they lock, returns to the fore-end
    c = Clip(st, 'BipodDeploy', 0.8)
    c.pr['BipodL'].k(0.27, Z).k(0.50, (-90, 8, 0), ease='in'); c.pr['BipodR'].k(0.28, Z).k(0.51, (-90, -8, 0), ease='in')
    c.hand['L'].clear().hold(0, 0.03, A['sup'], open=0.03).hold(0.22, 0.52, A['bip'], close=0.05, open=0.03, lift=(-0.02, 0, -0.04)).hold(0.72, 0.8, A['sup'], close=0.07)
    c.wr.k(0.22, (8, 32, 10), 'c').k(0.52, (9, 34, 11), 'c').k(0.8, Z); c.wr.add(spring(0.50, (-0.8, 0.5, 0), 9, 14))
    c.wp.k(0.22, (-0.06, 0.03, 0.05), 'c').k(0.52, (-0.06, 0.03, 0.05), 'c').k(0.8, Z)
    c.sh['R'].k(0.02, Z, 'c').k(0.25, (-0.03, 0.12, 0.09), 'c').k(0.52, (-0.03, 0.12, 0.09), 'c').k(0.8, Z)
    RR, RP = (10, 38, 14), (-0.07, 0.03, 0.06)                     # reload workspace: rifle raised, rolled so the magazine comes towards the support hand

    def swap(c, t0, empty):
        """magazine change from t0: the hand cups the base plate, thumb on the paddle, pulls it straight down the well, stows it at the belt and brings a fresh one,
        aligns it under the well and pushes it home; ends with the hand still on the magazine at t0 + 2.30"""
        T = lambda x: t0 + x; mq, mr = c.pp['Magazine'], c.pr['Magazine']
        c.wr.k(T(0.05), (0.3, 0.4, 0), 'c').k(T(0.40), RR).k(T(0.75), (RR[0] - 1.5, RR[1] + 2, RR[2]), 'c').k(T(1.6), RR, 'c').k(T(2.12), (RR[0] + 0.5, RR[1] - 1, RR[2]))
        c.wr.k(T(2.22), (RR[0] - 1.5, RR[1] + 1.5, RR[2]), ease='in')
        c.wp.k(T(0.05), (0, -0.001, 0), 'c').k(T(0.40), RP).k(T(1.6), (RP[0], RP[1], RP[2] - 0.004), 'c').k(T(2.12), RP).k(T(2.22), (RP[0], RP[1] + 0.002, RP[2] + 0.004), ease='in')
        Wm = c.env(T(1.0))[0]['Weapon']; BELT = tuple(Wm.inverted() @ Vector((-0.20, -0.22, -0.40)) - st.org['Magazine']); BR = (30, 15, -40)
        mq.k(T(0.55), Z).k(T(0.75), (0, 0, -0.085), ease='io').k(T(1.05), BELT, ease='in').k(T(1.35), BELT).k(T(1.80), (0.012, 0.004, -0.12), 'c')
        mq.k(T(1.95), (0, 0, -0.07), ease='out').k(T(2.12), (0, 0, -0.012), ease='io').k(T(2.22), Z, ease='in')
        mr.k(T(0.75), Z).k(T(1.05), BR, ease='in').k(T(1.35), BR).k(T(1.80), (6, -4, 8), 'c').k(T(1.95), Z)
        c.wr.add(spring(T(0.55), (-0.8, 0.4, 0), 6, 11)).add(spring(T(2.22), (1.6, -0.7, 0.3), 7, 12)); c.wp.add(spring(T(2.22), (0, 0.002, 0.005), 7, 12))
        c.sh['R'].k(T(0.40), (-0.03, 0.12, 0.09), 'c').k(T(2.22), (-0.03, 0.12, 0.09), 'c')
        if empty: c.ps['MagRounds'] = Tr(1, [0.001]).k(T(1.05), [0.001]).k(T(1.07), [1.0], ease='lin')
        c.hand['L'].clear().hold(0, T(0.04), A['sup'], open=0.04).hold(T(0.40), T(2.30), A['magh'], close=0.08, open=0.06, lift=(-0.03, -0.02, -0.06))
        c.ev(T(0.55), 'mag_out').ev(T(2.22), 'mag_in').ev(T(2.22), 'ammo')
    # ---- Reload (round in the chamber, bolt stays closed)
    c = Clip(st, 'Reload', 3.2); c.sh['R'].k(0.02, Z, 'c'); swap(c, 0.0, False); c.sh['R'].k(2.62, (0, 0.025, 0.025), 'c').k(3.2, Z)
    c.wr.k(2.62, (RR[0] * 0.5, RR[1] * 0.5, RR[2] * 0.5), 'c').k(2.98, (-0.6, -0.8, 0), 'c').k(3.2, Z); c.wp.k(2.62, (RP[0] * 0.5, 0, RP[2] * 0.5), 'c').k(3.2, Z)
    c.hand['L'].hold(2.75, 3.2, A['sup'], close=0.1, lift=(-0.02, -0.02, -0.04))
    c.hand['R'].clear().hold(0, 0.02, A['grip']).hold(0.08, 2.95, A['safe'], mid=st.IDX).hold(3.15, 3.2, A['grip'], mid=st.IDX)
    # ---- ReloadEmpty: bolt open first (the spent case flies), magazine change, then the bolt chambers the top round and locks
    c = Clip(st, 'ReloadEmpty', 3.7); bh, bp_ = c.pr['BoltHandle'], c.pp['BoltHandle']; t0 = 0.5
    bh.k(0.19, Z).k(0.29, up, ease='io').k(2.94, up).k(3.04, Z, ease='in')
    bp_.k(0.30, Z).k(0.46, bk, ease='in').k(2.76, bk).k(2.92, Z, ease='in')
    c.ev(0.44, 'shell').ev(0.46, 'bolt_back').ev(2.92, 'bolt_forward')
    c.wr.k(0.12, (-0.5, -2.5, 0.5), 'c').k(0.30, (-1.0, -5.0, 1.0), 'c'); c.wp.k(0.30, (0, -0.002, 0.006), 'c')
    c.sh['R'].k(0.02, Z, 'c').k(0.20, (0, 0.04, 0.05), 'c'); swap(c, t0, True); c.sh['R'].k(2.92, (0, 0.04, 0.05), 'c').k(3.7, Z)
    c.wr.k(2.92, (RR[0] * 0.4, RR[1] * 0.2, RR[2] * 0.4), 'c').k(3.3, (-0.5, -2.0, 0.3), 'c').k(3.7, Z); c.wp.k(2.92, (RP[0] * 0.4, 0, RP[2] * 0.4), 'c').k(3.7, Z)
    c.wr.add(spring(0.46, (0.8, 0, 0), 8, 13)).add(spring(2.92, (-0.6, 0.6, 0), 8, 13)).add(spring(3.04, (0.3, -0.8, 0), 9, 14))
    c.hand['L'].hold(3.22, 3.7, A['sup'], close=0.1, lift=(-0.02, -0.02, -0.04))
    leave(c, 0.0); c.hand['R'].hold(0.17, 0.50, A['bolt'], close=0.04, open=0.04, lift=(0.02, -0.02, 0.03)).hold(0.68, 2.55, A['safe'], lift=(0.02, -0.02, 0.0))
    c.hand['R'].hold(2.72, 3.06, A['bolt'], close=0.04, open=0.04, lift=(0.02, -0.02, 0.03)); back_to_grip(c, 3.24, 3.7)
