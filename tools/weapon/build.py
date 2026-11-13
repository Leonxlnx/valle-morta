# Valle Morta view-model builder (run inside Blender):
#   blender -b -t 6 --python tools/weapon/build.py -- arms   [geo bake tex test]
#   blender -b -t 6 --python tools/weapon/build.py -- rifle  [geo bake tex anim] [sheets=Reload,Fire] [look] [noexport]
# (same for pistol / sniper). No stage list = everything. See build_all.ps1 for the full rebuild.
import bpy, bmesh, sys, os, time, traceback, subprocess, importlib
from math import radians
from mathutils import Vector, Matrix
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import wlib as W, rig, geo

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
target = argv[0] if argv else 'arms'; opts = [a for a in argv[1:] if '=' in a or a in ('look', 'noexport', 'clay')]
stages = [a for a in argv[1:] if a not in opts]
ARMS = os.path.join(W.BUILD, 'arms.blend')


def tex_stage(an):
    r = subprocess.run([W.VENV, os.path.join(HERE, 'surf.py'), W.BUILD, an]); print('textures rc', r.returncode)
    if r.returncode: raise RuntimeError('texture stage failed')


# ------------------------------------------------------------------ arms
def arms_geo():
    bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
    ob = bpy.data.objects.new('ATLAS_arms', rig.build_right_arm()); sc.collection.objects.link(ob)
    W.uv_unwrap(ob, {1: 1.25, 2: 1.0}, 66, 0.002)
    arm = rig.build_armature(); rig.build_skinned(ob.data, arm); ob.hide_render = True
    bpy.ops.wm.save_as_mainfile(filepath=ARMS, check_existing=False)


def arms_bake():
    bpy.ops.wm.open_mainfile(filepath=ARMS); W.bake('arms', 0.003, 0.03, 24)


def arms_test():
    bpy.ops.wm.open_mainfile(filepath=ARMS); sc = bpy.context.scene; bpy.data.objects.remove(bpy.data.objects['ATLAS_arms'])
    arm = bpy.data.objects['Arms']; mesh = bpy.data.objects['ArmsMesh']; mesh.data.materials.clear(); mesh.data.materials.append(W.mat_for('arms'))
    rg = rig.Rig(arm); cam = W.setup_light(sc); files = []

    def shot(name, loc, look, fov=36):
        f = os.path.join(W.PREV, 'arms_' + name + '.png'); W.render(sc, cam, loc, look, fov, f, (500, 375), 24); files.append([f, name])
    shot('rest_top', (0.2, 0.045, 0.42), (0.2, 0.05, 0)); shot('rest_palm', (0.2, 0.055, -0.42), (0.2, 0.05, 0)); shot('rest_side', (-0.15, 0.06, 0.05), (0.2, 0.06, 0), 30)
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=28, radius1=0.02, radius2=0.02, depth=0.3, matrix=Matrix.Translation((-0.02, 0.22, 0.0)) @ Matrix.Rotation(radians(90), 4, 'X'))
    me = bpy.data.meshes.new('bar'); bm.to_mesh(me); bm.free(); bar = bpy.data.objects.new('bar', me); sc.collection.objects.link(bar); me.materials.append(W.clay((0.3, 0.2, 0.12)))
    bpy.context.view_layer.update(); bvh = rig.bvh_of([bar])
    HmL, i = rg.seat(bvh, 'L', rig.frame((0.77, 0.64, 0.0), (0, 0, -1)), (-0.02, 0.22, -0.033), (0, 62, 0), (0, 0, 1))
    aL = rg.close(bvh, 'L', HmL, rig.A_OPEN, thumb=75); print('seat step', i, 'left grip', {k: [round(x) for x in v] for k, v in aL.items()})
    HmR = rig.frame((0, 1, 0), (0.3, 0, 1)).to_4x4(); HmR.translation = (0.07, -0.05, -0.08)
    for side, Hm, a, S, pole in (('R', HmR, rig.A_FIST, Vector((0.155, -0.56, -0.03)), (0.6, 0, -0.8)), ('L', HmL, aL, Vector((-0.18, -0.245, -0.025)), (-0.6, 0, -0.8))):
        Mu, Mf, mv = rg.solve(side, S, Hm, pole); rg.apply(rg.channels(side, Mu, Mf, Hm, rg.pose(a))); print(side, 'shoulder moved', mv)
    bpy.context.view_layer.update()
    shot('fp', (-0.085, -0.25, 0.125), (-0.085, 1.0, -0.1), 52); shot('left_grip', (-0.33, 0.12, 0.04), (-0.03, 0.2, -0.02), 30)
    shot('below', (0.08, 0.16, -0.38), (-0.02, 0.2, 0.0), 30); shot('fist', (0.32, -0.16, 0.06), (0.07, 0.0, -0.08), 30); shot('fist_front', (0.0, 0.33, -0.02), (0.07, 0.0, -0.08), 30)
    W.sheet(os.path.join(W.PREV, 'arms_test.png'), 4, 250, files)


# ------------------------------------------------------------------ weapons
def weapon_geo(mod):
    bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene; geo.GROUPS.clear()
    info = mod.geometry(); root = bpy.data.objects.new('Weapon', None); root.empty_display_size = 0.02; sc.collection.objects.link(root)
    at = W.build_atlas(mod.ID, info['groups'], geo.GROUPS, info.get('uvs', {}))
    W.split_nodes(at, info['groups'], info['origins'], info.get('parents', {}), root); at.hide_render = True
    for name, p in info['empties'].items():
        e = bpy.data.objects.new(name, None); e.empty_display_size = 0.01; e.location = Vector(p) * W.S; e.parent = root; sc.collection.objects.link(e)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(W.BUILD, mod.ID + '.blend'), check_existing=False)


def weapon_bake(mod):
    bpy.ops.wm.open_mainfile(filepath=os.path.join(W.BUILD, mod.ID + '.blend')); W.bake(mod.ID)


def weapon_anim(mod):
    import anim
    anim.run(mod, opts)


t00 = time.time()
if target == 'arms':
    table = dict(geo=arms_geo, bake=arms_bake, tex=lambda: tex_stage('arms'), test=arms_test); order = ['geo', 'bake', 'tex', 'test']
else:
    mod = importlib.import_module('w_' + target)
    table = dict(geo=lambda: weapon_geo(mod), bake=lambda: weapon_bake(mod), tex=lambda: tex_stage(target), anim=lambda: weapon_anim(mod)); order = ['geo', 'bake', 'tex', 'anim']
for s in (stages or order):
    t = time.time()
    try:
        table[s](); print('STAGE', target, s, 'ok', round(time.time() - t, 1), 's', flush=True)
    except Exception:
        traceback.print_exc(); print('STAGE', target, s, 'FAILED', flush=True); break
print('TOTAL', round(time.time() - t00, 1), 's')
