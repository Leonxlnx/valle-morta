# Beauty sheet of a weapon without the arms (textured if build/<id>_base.png exists, clay otherwise):
#   blender -b -t 6 --python tools/weapon/beauty.py -- <id> [distance scale]      -> tools/_preview/weapon/final_<id>_beauty.png
import bpy, sys, os
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import wlib as W

args = sys.argv[sys.argv.index('--') + 1:]; wid = args[0]; k = float(args[1]) if len(args) > 1 else 1.0
bpy.ops.wm.open_mainfile(filepath=os.path.join(W.BUILD, wid + '.blend')); sc = bpy.context.scene
at = bpy.data.objects.get('ATLAS_' + wid)
if at: bpy.data.objects.remove(at)
mat = W.mat_for(wid)
for o in bpy.data.objects:
    if o.type == 'MESH': o.data.materials.clear(); o.data.materials.append(mat)
cam = W.setup_light(sc); files = []
for n, loc, look in (('right', (0.30, 0.16, 0.10), (0, 0.03, 0.0)), ('left', (-0.28, 0.20, 0.08), (0, 0.03, 0.0)),
                     ('rear top', (-0.10, -0.24, 0.20), (0, 0.0, 0.03)), ('below', (0.16, -0.12, -0.26), (0, 0.02, -0.02))):
    f = os.path.join(W.BUILD, 'tiles', '%s_beauty_%s.png' % (wid, n.replace(' ', '_'))); os.makedirs(os.path.dirname(f), exist_ok=True)
    W.render(sc, cam, tuple(v * k for v in loc), tuple(v * k for v in look), 30, f, (450, 300), 40); files.append([f, n])
W.sheet(os.path.join(W.PREV, 'final_%s_beauty.png' % wid), 2, 450, files); print('beauty sheet done')
