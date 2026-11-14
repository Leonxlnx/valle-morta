# Rifle check renders without arms: both sides, top-rear quarter, below, receiver close-up, the rear as the shooter sees it.
#   blender -b -t 6 --python tools/weapon/rifle_views.py -- [id]   -> tools/_preview/weapon/final_<id>_beauty.png
import bpy, sys, os
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import wlib as W

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []; wid = args[0] if args else 'rifle'
bpy.ops.wm.open_mainfile(filepath=os.path.join(W.BUILD, wid + '.blend')); sc = bpy.context.scene
at = bpy.data.objects.get('ATLAS_' + wid)
if at: bpy.data.objects.remove(at)
mat = W.mat_for(wid)
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.data.materials.clear(); o.data.materials.append(mat)
        if o.name == 'Casing': o.hide_render = True
cam = W.setup_light(sc); cam.data.clip_start = 0.001; files = []
for n, loc, look, fov in (('right', (0.78, 0.142, 0.03), (0, 0.142, -0.01), 40), ('left', (-0.78, 0.142, 0.03), (0, 0.142, -0.01), 40),
                          ('top rear quarter', (-0.33, -0.42, 0.33), (0, 0.10, 0.0), 40), ('below front', (0.30, 0.55, -0.45), (0, 0.14, -0.02), 40),
                          ('receiver right close', (0.24, 0.07, 0.07), (0, 0.06, 0.02), 34), ('rear as the shooter sees it', (-0.07, -0.22, 0.115), (0, 0.0, 0.05), 36)):
    f = os.path.join(W.BUILD, 'tiles', '%s_view_%s.png' % (wid, n.replace(' ', '_'))); os.makedirs(os.path.dirname(f), exist_ok=True)
    W.render(sc, cam, loc, look, fov, f, (450, 253), 32); files.append([f, n])
W.sheet(os.path.join(W.PREV, 'final_%s_beauty.png' % wid), 2, 450, files); print('rifle views done')
