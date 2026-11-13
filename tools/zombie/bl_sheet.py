"""Contact sheets rendered from a finished GLB (CPU Cycles, low samples) - checks the deliverable itself.

  blender -b -t 4 --python bl_sheet.py -- <file.glb> model <out.png>                 front / side / three-quarter / face
  blender -b -t 4 --python bl_sheet.py -- <file.glb> clips <out_prefix> Walk Run ...  per clip: 8 evenly spaced frames from the side
                                                                                      (2 rows of 4, time runs left to right, dark band = ground)
  A clip argument may be 'A+B': first row = 4 frames of A, second row = 4 frames of B.
"""
import bpy, sys, os, math
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
glb, mode, out = os.path.abspath(argv[0]), argv[1], os.path.abspath(argv[2]); clips = argv[3:]
tmp = os.path.join(os.path.dirname(out), '_tile')
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene; sc.render.fps = 60
bpy.ops.import_scene.gltf(filepath=glb)
arm = next(o for o in sc.objects if o.type == 'ARMATURE'); ob = next(o for o in sc.objects if o.type == 'MESH')

sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 20
try:
    sc.cycles.use_denoising = True
except Exception:
    pass
sc.render.threads_mode = 'FIXED'; sc.render.threads = 4
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'; sc.render.resolution_percentage = 100
try:
    sc.view_settings.view_transform = 'Standard'
except Exception:
    pass
w = bpy.data.worlds.new('w'); sc.world = w
try:
    w.use_nodes = True
except Exception:
    pass
bg = w.node_tree.nodes.get('Background')
if bg:
    bg.inputs[0].default_value = (0.62, 0.68, 0.76, 1); bg.inputs[1].default_value = 0.9
ld = bpy.data.lights.new('sun', 'SUN'); ld.energy = 3.2; ld.angle = math.radians(6)
sun = bpy.data.objects.new('sun', ld); sc.collection.objects.link(sun)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -1)); slab = bpy.context.active_object; slab.scale = (60, 60, 2)
gm = bpy.data.materials.new('ground')
try:
    gm.use_nodes = True
except Exception:
    pass
bs = gm.node_tree.nodes.get('Principled BSDF')
if bs:
    bs.inputs['Base Color'].default_value = (0.09, 0.085, 0.08, 1); bs.inputs['Roughness'].default_value = 0.9
slab.data.materials.append(gm)
cd = bpy.data.cameras.new('cam'); cd.type = 'ORTHO'; cd.clip_start = 0.1; cd.clip_end = 100
cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam


def look(pos, target):
    pos, target = Vector(pos), Vector(target)
    cam.location = pos; cam.rotation_euler = (target - pos).to_track_quat('-Z', 'Y').to_euler()


def set_clip(name, u):
    act = next((a for a in bpy.data.actions if a.name == name), None) or next(a for a in bpy.data.actions if a.name.startswith(name))
    ad = arm.animation_data or arm.animation_data_create()
    for tr in ad.nla_tracks:
        tr.mute = True
    if ad.action != act:
        ad.action = act
        try:
            if len(act.slots):
                ad.action_slot = act.slots[0]
        except Exception as e:
            print('slot:', e)
    f0, f1 = act.frame_range; f = f0 + u * (f1 - f0)
    sc.frame_set(int(math.floor(f)), subframe=f - math.floor(f))
    bpy.context.view_layer.update()


def render(path, rx, ry):
    sc.render.resolution_x = rx; sc.render.resolution_y = ry; sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(path); a = np.empty(rx * ry * 4, np.float32); im.pixels.foreach_get(a); bpy.data.images.remove(im)
    return a.reshape(ry, rx, 4)


def save(arr, path):
    h, wd = arr.shape[:2]; im = bpy.data.images.new('sheet', wd, h, alpha=False)
    im.pixels.foreach_set(np.ascontiguousarray(arr, np.float32).ravel()); im.filepath_raw = path; im.file_format = 'PNG'; im.save()
    bpy.data.images.remove(im); print('SHEET', path, wd, h)


def extent():
    dg = bpy.context.evaluated_depsgraph_get(); eo = ob.evaluated_get(dg); me = eo.to_mesh()
    co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co); eo.to_mesh_clear()
    M = np.array(eo.matrix_world); co = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    return co.min(0), co.max(0)


set_clip('Idle', 0.0)
lo, hi = extent(); H = float(hi[2])
print('MODEL height %.3f m, width %.3f m, depth %.3f m (idle pose), min z %.3f' % (H, hi[0] - lo[0], hi[1] - lo[1], lo[2]))

if mode == 'model':
    sun.rotation_euler = (math.radians(52), 0, math.radians(-28))
    tiles = []; cz = 0.5 * H; cd.ortho_scale = 1.1 * H
    for d in ((0, -1, 0), (-1, 0, 0), (-0.62, -0.78, 0)):
        look((10 * d[0], 10 * d[1], cz), (0, 0, cz)); tiles.append(render(tmp + '.png', 225, 405))
    hb = arm.matrix_world @ arm.pose.bones['Head'].head; hs = max(0.42, 0.42 * H / 1.8 * 0.8)
    cd.ortho_scale = hs; look((hb.x - 3.5, hb.y - 9, hb.z + 0.07 * hs / 0.42), (hb.x, hb.y - 0.03, hb.z + 0.07 * hs / 0.42)); tiles.append(render(tmp + '.png', 225, 405))
    save(np.concatenate(tiles, 1), out)
else:
    sun.rotation_euler = (math.radians(38), math.radians(-30), 0)
    ob.hide_render = True
    sp = 0.76 * H; rx = 900; ry = int(round(900 * 1.2 * H / (4 * sp)))
    cd.ortho_scale = 4 * sp
    for spec in clips:
        names = spec.split('+'); rows = []; snaps = []
        for r in range(2):
            nm = names[r % len(names)]; loop = nm in ('Idle', 'Walk', 'Run', 'Sprint')
            for k in range(4):
                i = k + (4 * r if len(names) == 1 else 0); n = 8 if len(names) == 1 else 4
                set_clip(nm, i / n if loop else i / (n - 1))
                dg = bpy.context.evaluated_depsgraph_get(); eo = ob.evaluated_get(dg)
                me = bpy.data.meshes.new_from_object(eo, preserve_all_data_layers=True, depsgraph=dg)
                o2 = bpy.data.objects.new('snap', me); sc.collection.objects.link(o2)
                o2.matrix_world = Matrix.Translation((0, -(k - 1.5) * sp, -40.0 * r)) @ eo.matrix_world; snaps.append(o2)
        for r in range(2):                       # second row lives 40 m lower with its own ground
            slab.location = (0, 0, -1 - 40.0 * r)
            look((-20, 0, 0.52 * H - 40.0 * r), (0, 0, 0.52 * H - 40.0 * r)); rows.append(render(tmp + '.png', rx, ry))
        save(np.concatenate([rows[1], np.zeros((4, rx, 4), np.float32) + 1, rows[0]], 0), '%s_%s.png' % (out, spec.replace('+', '_')))
        for o2 in snaps:
            me = o2.data; bpy.data.objects.remove(o2); bpy.data.meshes.remove(me)
if os.path.exists(tmp + '.png'):
    os.remove(tmp + '.png')
