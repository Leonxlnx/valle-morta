# Sniper check renders without arms: full side view, close-ups and the view from ScopeEye down the tube (hollow, centred, straight?).
#   blender -b -t 6 --python tools/weapon/sniper_views.py -- [clay]   -> tools/_preview/weapon/final_sniper_beauty.png
import bpy, sys, os
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import wlib as W

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
bpy.ops.wm.open_mainfile(filepath=os.path.join(W.BUILD, 'sniper.blend')); sc = bpy.context.scene
at = bpy.data.objects.get('ATLAS_sniper')
if at: bpy.data.objects.remove(at)
mat = W.mat_for('sniper')
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.data.materials.clear(); o.data.materials.append(mat)
        if o.name == 'Casing': o.hide_render = True
cam = W.setup_light(sc); cam.data.clip_start = 0.001; files = []
for n, loc, look, fov in (('right', (0.92, 0.226, 0.06), (0, 0.226, 0.0), 40), ('action right', (0.25, 0.00, 0.12), (0, 0.06, 0.05), 34),
                          ('scope left rear', (-0.26, -0.22, 0.24), (0, 0.05, 0.09), 36), ('muzzle and bipod', (0.24, 0.98, -0.03), (0, 0.62, 0.0), 34),
                          ('stock left', (-0.34, -0.40, 0.06), (0, -0.22, -0.01), 40), ('bolt knob', (0.15, -0.13, 0.085), (0.045, -0.025, 0.035), 30),
                          ('below', (0.16, 0.20, -0.42), (0, 0.16, -0.01), 40), ('from ScopeEye', (0, -0.0925, 0.108), (0, 1.0, 0.108), 22)):
    f = os.path.join(W.BUILD, 'tiles', 'sniper_view_%s.png' % n.replace(' ', '_')); os.makedirs(os.path.dirname(f), exist_ok=True)
    W.render(sc, cam, loc, look, fov, f, (450, 253), 40); files.append([f, n])
W.sheet(os.path.join(W.PREV, 'final_sniper_beauty.png'), 2, 450, files); print('sniper views done')
