# Valle Morta view-model animation: keyframe tracks, hand choreography (anchors, curved transitions, finger
# open / close), per-frame IK solve, contact-sheet rendering, Blender actions + NLA tracks and the glTF export.
import bpy, os, sys, json, math, time, subprocess, numpy as np
from math import radians, degrees, sin, cos, pi
from mathutils import Vector, Matrix, Quaternion, Euler
import wlib as W, rig as RG, rigdef as RD

FPS = 60
EASE = {'lin': lambda u: u, 'io': lambda u: u * u * (3 - 2 * u), 'in': lambda u: u * u, 'out': lambda u: 1 - (1 - u) ** 2, 'in3': lambda u: u ** 3,
        'out3': lambda u: 1 - (1 - u) ** 3, 'back': lambda u: 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2}


def smooth(u): u = min(1.0, max(0.0, u)); return u * u * (3 - 2 * u)


def spring(t0, amp, freq=6.0, damp=9.0):
    """damped oscillation starting at t0 (zero before, rises first)"""
    amp = np.array(amp, float)
    return lambda t: amp * (math.exp(-damp * (t - t0)) * math.sin(2 * pi * freq * (t - t0)) if t > t0 else 0.0)


def kick(t0, amp, rise=0.03, fall=0.1):
    """fast rise, exponential settle"""
    amp = np.array(amp, float)

    def f(t):
        u = t - t0
        if u <= 0: return amp * 0.0
        return amp * (1 - (1 - u / rise) ** 2) if u < rise else amp * math.exp(-(u - rise) / fall)
    return f


class Tr:
    """keyframed track: spline through the keys (tan 'c' = flowing, 's' = stop) or an eased segment (ease of the segment ending at a key) + additive functions"""
    def __init__(s, dim=3, v0=None, dur=None):
        s.dim = dim; s.v0 = np.zeros(dim) if v0 is None else np.array(v0, float).reshape(dim); s.keys = [(0.0, s.v0.copy(), 's', None)]; s.fn = []; s.dur = dur

    def k(s, t, v, tan='s', ease=None):
        v = np.array(v, float).reshape(s.dim); s.keys = [q for q in s.keys if abs(q[0] - t) > 1e-6] + [(float(t), v, tan, ease)]; s.keys.sort(key=lambda q: q[0]); return s

    def add(s, f): s.fn.append(f); return s

    def _tan(s, i):
        K = s.keys
        if K[i][2] == 's' or i == 0 or i == len(K) - 1: return np.zeros(s.dim)
        return (K[i + 1][1] - K[i - 1][1]) / (K[i + 1][0] - K[i - 1][0])

    def at(s, t):
        K = s.keys
        if t <= K[0][0]: v = K[0][1].copy()
        elif t >= K[-1][0]: v = K[-1][1].copy()
        else:
            i = max(j for j in range(len(K)) if K[j][0] <= t); a, b = K[i], K[i + 1]; h = b[0] - a[0]; u = (t - a[0]) / h
            if b[3]: v = a[1] + (b[1] - a[1]) * EASE[b[3]](u)
            else:
                u2 = u * u; u3 = u2 * u
                v = (2 * u3 - 3 * u2 + 1) * a[1] + (u3 - 2 * u2 + u) * h * s._tan(i) + (-2 * u3 + 3 * u2) * b[1] + (u3 - u2) * h * s._tan(i + 1)
        if s.fn:
            w = 1.0 if s.dur is None else 1 - smooth((t - (s.dur - 0.1)) / 0.1)
            for f in s.fn: v = v + f(t) * w
        return v


class Anchor:
    """a hand grip: wrist matrix M relative to a parent node, closed finger pose, opened pose and the direction the hand retreats along"""
    def __init__(s, parent, M, pose, pre=None, retreat=(0, 0, 0), a=None, pivot=None, rotpar=None, follow=0.0):
        s.parent = parent; s.M = M.copy(); s.pose = pose; s.pre = pose if pre is None else pre; s.retreat = Vector(retreat); s.a = a
        s.pivot = pivot; s.rotpar = rotpar; s.follow = follow

    def world(s, env):
        Hw = env[s.parent] @ s.M
        if s.rotpar is None: return Hw
        Pw = env[s.parent] @ s.pivot; g = s.M.inverted() @ s.pivot      # orientation mostly from rotpar, wrist swings about the pivot
        R = (env[s.rotpar] @ s.M).to_quaternion().slerp(Hw.to_quaternion(), s.follow).to_matrix(); out = R.to_4x4(); out.translation = Pw - R @ g
        return out

    def rw(s, env): return env[s.parent].to_3x3() @ s.retreat

    def variant(s, rg, **fingers):
        a = {k: list(v) for k, v in s.a.items()}; a.update({k: list(v) for k, v in fingers.items()})
        return Anchor(s.parent, s.M, rg.pose(a), s.pre, s.retreat, a, s.pivot, s.rotpar, s.follow)


class HandTrack:
    def __init__(s, st, side): s.st = st; s.side = side; s.h = []
    def clear(s): s.h = []; return s

    def hold(s, t0, t1, a, close=0.0, open=0.0, mid=None, lift=(0, 0, 0)):
        s.h.append(dict(t0=t0, t1=t1, a=a, close=close, open=open, mid=mid, lift=Vector(lift))); return s

    def eval(s, t, env):
        H = s.h
        for i, h in enumerate(H):
            if t <= h['t1'] or i == len(H) - 1:
                if t >= h['t0'] or i == 0:
                    a = h['a']; p = a.pose
                    if h['close'] > 0 and t < h['t0'] + h['close']: p = RG.pblend(a.pre, a.pose, smooth((t - h['t0']) / h['close']))
                    elif h['open'] > 0 and t > h['t1'] - h['open']: p = RG.pblend(a.pose, a.pre, smooth((t - (h['t1'] - h['open'])) / h['open']))
                    return a.world(env), p
                g = H[i - 1]; u = (t - g['t1']) / (h['t0'] - g['t1']); e = u * u * u * (u * (6 * u - 15) + 10)
                A = g['a'].world(env); B = h['a'].world(env); pa = A.to_translation(); pb = B.to_translation()
                c1 = pa + g['a'].rw(env) + h['lift']; c2 = pb + h['a'].rw(env) + h['lift']
                pos = (1 - e) ** 3 * pa + 3 * (1 - e) ** 2 * e * c1 + 3 * (1 - e) * e * e * c2 + e ** 3 * pb
                Hm = A.to_quaternion().slerp(B.to_quaternion(), e).to_matrix().to_4x4(); Hm.translation = pos
                p0 = g['a'].pre if g['open'] > 0 else g['a'].pose; p1 = h['a'].pre if h['close'] > 0 else h['a'].pose
                mid = h['mid'] if h['mid'] is not None else s.st.rig.RELAX
                if isinstance(mid, str): p = RG.pblend(p0, p1, e)          # 'direct': same grip, only the fingers change
                else: p = RG.pblend(p0, mid, smooth(e / 0.45)) if e < 0.5 else RG.pblend(mid, p1, smooth((e - 0.55) / 0.45))
                return Hm, p


class Clip:
    def __init__(s, st, name, dur, loop=False):
        s.st = st; s.name = name; s.dur = dur; s.loop = loop; s.N = int(round(dur * FPS)); s.events = []; s.rows = None
        s.wp = s.tr(); s.wr = s.tr(); s.pp = {n: s.tr() for n in st.parts}; s.pr = {n: s.tr() for n in st.parts}; s.ps = {}
        s.hand = {sd: HandTrack(st, sd).hold(0, dur, st.base[sd]) for sd in 'RL'}; s.sh = {sd: s.tr() for sd in 'RL'}; s.pl = {sd: s.tr() for sd in 'RL'}
        st.clips[name] = s

    def tr(s, dim=3, v0=None): return Tr(dim, v0, None if s.loop else s.dur)
    def ev(s, t, name): s.events.append({'t': round(float(t), 3), 'name': name}); return s

    def env(s, t):
        st = s.st; p = s.wp.at(t); r = s.wr.at(t); piv = Vector(st.pivot)
        Q = (Matrix.Rotation(radians(r[2]), 4, 'Z') @ Matrix.Rotation(radians(r[0]), 4, 'X') @ Matrix.Rotation(radians(r[1]), 4, 'Y'))
        Wm = Matrix.Translation(Vector(p) + piv) @ Q @ Matrix.Translation(-piv)
        loc = {'Weapon': (Wm.to_translation(), Wm.to_quaternion())}; env = {'Weapon': Wm, 'World': Matrix.Identity(4)}
        for n in st.parts:
            e = s.pr[n].at(t); T_ = st.org[n] + Vector(s.pp[n].at(t)); Q_ = Euler((radians(e[0]), radians(e[1]), radians(e[2])), 'XYZ').to_quaternion()
            loc[n] = (T_, Q_); env[n] = env[st.parent[n]] @ (Matrix.Translation(T_) @ Q_.to_matrix().to_4x4())
        return env, loc


class Stage:
    """one weapon scene: animated nodes, the arms rig, collision trees, grips and clips"""
    def __init__(s, mod, rg, objs):
        s.mod = mod; s.rig = rg; s.obj = objs; s.parts = list(mod.PARTS); s.pivot = mod.PIVOT; s.clips = {}; s.base = {}; s.only = getattr(mod, 'ONLY', {})
        s.parent = {n: objs[n].parent.name for n in s.parts}; s.org = {n: objs[n].location.copy() for n in s.parts}
        for o in objs.values(): o.rotation_mode = 'QUATERNION'
        s.rest = {'Weapon': Matrix.Identity(4), 'World': Matrix.Identity(4)}
        for n in s.parts: s.rest[n] = s.rest[s.parent[n]] @ Matrix.Translation(s.org[n])
        s.S = {k: Vector(v) for k, v in mod.SHOULDER.items()}; s.pole = {k: Vector(v) for k, v in mod.POLE.items()}
        meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name not in ('ArmsMesh', 'Casing') and not o.name.startswith('ATLAS')]
        def fam(o, name):
            while o is not None:
                if o.name == name: return True
                o = o.parent
            return False
        movers = getattr(mod, 'MOVERS', ['Magazine']); s.cols = {}
        body = [o for o in meshes if not any(fam(o, m) for m in movers)]
        s.cols['body'] = (RG.bvh_of(body), 'Weapon')
        for m in movers: s.cols[m] = (RG.bvh_of([o for o in meshes if fam(o, m)], s.rest[m]), m)
        s.bvh = RG.bvh_of(meshes); s.meshes = meshes

    def grip(s, name, side, parent, R, p, g=(0, 62, 0), approach=None, a0=RG.A_HOOKED, fingers=('Index', 'Middle', 'Ring', 'Pinky'), thumb=True, reach=None,
             bvh=None, back=0.05, retreat=None, prek=0.5, maxc=(88, 110, 70)):
        """contact-driven grip: seat the palm along `approach`, curl the fingers until they touch, optional reach targets per finger"""
        rg = s.rig; bvh = bvh or s.bvh
        if approach is not None: Hm, i = rg.seat(bvh, side, R, p, g, approach, back)
        else:
            sx = 1 if side == 'R' else -1; Hm = R.to_4x4(); Hm.translation = Vector(p) - R @ (Vector((sx * g[0], g[1], g[2])) * RD.MM); i = 0
        a = rg.close(bvh, side, Hm, a0, fingers, thumb, maxc); res = {}
        for f, tgt in (reach or {}).items(): a, e = rg.reach(side, Hm, a, f, tgt); res[f] = round(e * 1000, 1)
        pose = rg.pose(a); dep = rg.depth(bvh, rg.samples(side, rg.fk(side, Hm, pose)))
        print('GRIP %-8s %s seat %d wrist (%.3f %.3f %.3f) depth %.1f mm reach %s | %s' % (name, side, i, *Hm.to_translation(), dep * 1000, res,
              ' '.join('%s[%s]' % (k[:2], ','.join('%d' % round(x) for x in v)) for k, v in a.items())), flush=True)
        ret = Vector(retreat) if retreat is not None else (-Vector(approach).normalized() * 0.05 if approach is not None else Vector((0, 0, 0)))
        return Anchor(parent, s.rest[parent].inverted() @ Hm, pose, rg.pose(rg.pre(a, prek)), ret, a)

    # ---- solve
    def bake(s, clip):
        rg = s.rig; rows = []; bend = {'R': 0.0, 'L': 0.0}; moved = {'R': 0, 'L': 0}; pen = {}
        for i in range(clip.N + 1):
            t = i / FPS; env, loc = clip.env(t); fr = {'o': loc, 'b': {}, 's': {n: float(tr.at(t)[0]) for n, tr in clip.ps.items()}}
            for sd in 'RL':
                Hm, pose = clip.hand[sd].eval(t, env)
                Mu, Mf, mv = rg.solve(sd, s.S[sd] + Vector(clip.sh[sd].at(t)), Hm, s.pole[sd] + Vector(clip.pl[sd].at(t)))
                fr['b'].update(rg.channels(sd, Mu, Mf, Hm, pose)); moved[sd] += mv
                bend[sd] = max(bend[sd], degrees(Mf.col[1].xyz.angle(Hm.col[1].xyz)))
                pts = rg.samples(sd, rg.fk(sd, Hm, pose)) + rg.palm_pts(sd, Hm)
                for cn, (bvh, par) in s.cols.items():
                    inv = env[par].inverted(); d = rg.depth(bvh, [(inv @ q[0], q[1]) for q in pts])
                    if d > pen.get((sd, cn), (0.0045, 0))[0]: pen[(sd, cn)] = (d, t)
            rows.append(fr)
        clip.rows = rows
        print('CLIP %-12s %.2fs %3d fr | wrist bend R %2.0f L %2.0f deg | shoulder slid R %d L %d | deepest contact %s' % (clip.name, clip.dur, clip.N, bend['R'], bend['L'],
              moved['R'], moved['L'], ' '.join('%s-%s %.0fmm@%.2fs' % (k[0], k[1], v[0] * 1000, v[1]) for k, v in pen.items()) or 'none >4.5mm'), flush=True)

    def deviation(s, clip, ref, i=0, j=0):
        """largest difference between frame i of clip and frame j of ref (mm / degrees)"""
        a = clip.rows[i]; b = ref.rows[j]; dm = 0.0; da = 0.0
        for grp in ('o', 'b'):
            for n, (T_, Q_) in a[grp].items():
                T2, Q2 = b[grp][n]
                if T_ is not None: dm = max(dm, (Vector(T_) - Vector(T2)).length * 1000)
                da = max(da, degrees(Q_.rotation_difference(Q2).angle))
        return dm, min(da, 360 - da)

    def apply(s, clip, i):
        fr = clip.rows[i]
        for n, (T_, Q_) in fr['o'].items(): o = s.obj[n]; o.location = T_; o.rotation_quaternion = Q_
        for n, sc in fr['s'].items(): bpy.data.objects[n].scale = (sc, sc, sc)
        s.rig.apply(fr['b'])

    # ---- Blender actions
    def actions(s, order):
        arm = s.rig.ob

        def action(name, idb, curves, N):
            act = bpy.data.actions.new(name); fr = np.arange(N + 1, dtype=np.float64)
            if hasattr(act, 'slots'):
                slot = act.slots.new(id_type='OBJECT', name=idb.name); strip = act.layers.new('L').strips.new(type='KEYFRAME'); fcs = strip.channelbag(slot, ensure=True).fcurves
            else: slot = None; fcs = act.fcurves
            for path, vals in curves:
                vals = np.asarray(vals, np.float64)
                for ci in range(vals.shape[1]):
                    fc = fcs.new(path, index=ci); fc.keyframe_points.add(N + 1); co = np.empty(2 * (N + 1)); co[0::2] = fr; co[1::2] = vals[:, ci]
                    fc.keyframe_points.foreach_set('co', co)
                    for kp in fc.keyframe_points: kp.interpolation = 'LINEAR'
                    fc.update()
            ad = idb.animation_data or idb.animation_data_create(); tr = ad.nla_tracks.new(); tr.name = name.split('|')[0]
            stp = tr.strips.new(tr.name, 0, act)
            if slot is not None:
                try: stp.action_slot = slot
                except Exception as ex: print('WARN slot', ex)
            return act

        def unwrap(q):
            q = np.array(q, float)
            for i in range(1, len(q)):
                if np.dot(q[i], q[i - 1]) < 0: q[i] = -q[i]
            return q
        for cn in order:
            clip = s.clips[cn]; R = clip.rows; N = clip.N
            for n in ['Weapon'] + s.parts:
                if n in s.only and cn not in s.only[n]: continue
                action(cn + '|' + n, s.obj[n], [('location', [list(r['o'][n][0]) for r in R]), ('rotation_quaternion', unwrap([list(r['o'][n][1]) for r in R]))], N)
            for n in clip.ps:
                action(cn + '|' + n, bpy.data.objects[n], [('scale', [[r['s'][n]] * 3 for r in R])], N)
            curves = []
            for bn in R[0]['b']:
                if R[0]['b'][bn][0] is not None: curves.append(('pose.bones["%s"].location' % bn, [list(r['b'][bn][0]) for r in R]))
                curves.append(('pose.bones["%s"].rotation_quaternion' % bn, unwrap([list(r['b'][bn][1]) for r in R])))
            action(cn + '|Arms', arm, curves, N)


def run(mod, opts):
    wid = mod.ID; bpy.ops.wm.open_mainfile(filepath=os.path.join(W.BUILD, wid + '.blend')); sc = bpy.context.scene
    sc.render.fps = FPS; sc.frame_start = 0; sc.frame_set(0)
    bpy.data.objects.remove(bpy.data.objects['ATLAS_' + wid]); mat = W.mat_for(wid)
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.materials.clear(); o.data.materials.append(mat)
            for ca in list(o.data.color_attributes): o.data.color_attributes.remove(ca)
    with bpy.data.libraries.load(os.path.join(W.BUILD, 'arms.blend')) as (src, dst): dst.objects = ['Arms', 'ArmsMesh']
    for o in dst.objects: sc.collection.objects.link(o)
    arm = bpy.data.objects['Arms']; am = bpy.data.objects['ArmsMesh']; am.data.materials.clear(); am.data.materials.append(W.mat_for('arms'))
    for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
    bpy.context.view_layer.update()
    objs = {n: bpy.data.objects[n] for n in ['Weapon'] + list(mod.PARTS)}; st = Stage(mod, RG.Rig(arm), objs)
    t0 = time.time(); mod.setup(st); mod.clips(st)
    for c in st.clips.values(): st.bake(c)
    idle = st.clips['Idle']
    for c in st.clips.values():
        d0 = st.deviation(c, idle, 0, 0); d1 = st.deviation(c, idle, c.N, 0)
        if (d0[0] > 0.05 or d0[1] > 0.05 or d1[0] > 0.05 or d1[1] > 0.05): print('CLIP %-12s differs from Idle pose: start %.1f mm %.1f deg, end %.1f mm %.1f deg' % (c.name, *d0, *d1))
    print('solved', len(st.clips), 'clips', round(time.time() - t0, 1), 's', flush=True)
    side = dict(clips={n: dict(duration=round(c.N / FPS, 4), loop=c.loop, events=sorted(c.events, key=lambda e: e['t'])) for n, c in st.clips.items()}, meta=getattr(mod, 'META', {}))
    # ---- previews
    cam = None
    def view(name, loc, look, fov, res, spp=24):
        f = os.path.join(W.BUILD, 'tiles', name + '.png'); os.makedirs(os.path.dirname(f), exist_ok=True); W.render(sc, cam, loc, look, fov, f, res, spp); return f
    eye = Vector(mod.EYE); fp = (eye, eye + Vector((0, 1, 0)), 52)
    for o in opts:
        if cam is None: cam = W.setup_light(sc)
        if o == 'look':
            st.apply(idle, 0); bpy.context.view_layer.update(); files = [[view('%s_look_%s' % (wid, n), loc, look, fov, (500, 281), 32), n] for n, loc, look, fov in mod.VIEWS]
            W.sheet(os.path.join(W.PREV, 'final_%s_model.png' % wid), 2, 500, files)
        elif o.startswith('sheets='):
            for item in o[7:].split(','):
                lst = mod.MISC if item == 'misc' else [(item.split(':')[0], int(item.split(':')[1]) if ':' in item else 12)]
                cols = 5 if item == 'misc' else (4 if lst[0][1] <= 8 else 3); tw = 1000 // cols; files = []
                for cn, k in lst:
                    c = st.clips[cn]; loc, look, fov = getattr(mod, 'CAMS', {}).get(cn, fp)
                    for i in sorted(set(int(round(x)) for x in np.linspace(0, c.N, k))):
                        st.apply(c, i); bpy.context.view_layer.update()
                        files.append([view('%s_%s_%03d' % (wid, cn, i), loc, look, fov, (tw, int(tw * 9 / 16))), '%s %.2fs' % (cn, i / FPS)])
                W.sheet(os.path.join(W.PREV, 'final_%s_%s.png' % (wid, lst[0][0] if item != 'misc' else 'misc')), cols, tw, files)
    if 'noexport' in opts: return
    # ---- actions, export
    for n in ('sun', 'cam'):
        if n in bpy.data.objects: bpy.data.objects.remove(bpy.data.objects[n])
    st.apply(idle, 0); order = [n for n in st.clips if n != 'Idle'] + ['Idle']; st.actions(order)
    bpy.context.view_layer.update(); out = os.path.join(W.MODELS, wid + '.glb')
    exp = [o for o in bpy.data.objects if o.type in ('MESH', 'EMPTY', 'ARMATURE')]
    W.export_glb(out, exp)
    json.dump(side, open(os.path.join(W.MODELS, wid + '.anim.json'), 'w'), indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(W.BUILD, wid + '_final.blend'), check_existing=False)
    r = subprocess.run([W.VENV, os.path.join(W.HERE, 'verify_glb.py'), out], capture_output=True, text=True)
    print('\n'.join('VERIFY ' + l for l in (r.stdout + r.stderr).splitlines()), flush=True)
