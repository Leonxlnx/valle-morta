"""Blender preview renderer.  blender -b -t 6 --python bl_render.py -- job.json

job = {"mesh": npz (verts, faces[, col | uv + textures]), "glb": path (alternative to mesh),
       "views": [{"name","loc","tgt","lens"}], "res": [w,h], "samples": n, "out": prefix,
       "ground": z or null, "tex": {"albedo","normal","orm"}, "pose": {...}}
"""
import bpy, sys, json, math
import numpy as np
from mathutils import Vector, Quaternion, Matrix

job = json.load(open(sys.argv[sys.argv.index('--') + 1]))
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
scn.render.engine = 'CYCLES'
scn.cycles.device = 'CPU'
scn.cycles.samples = job.get('samples', 32)
scn.cycles.use_adaptive_sampling = False
scn.cycles.use_denoising = True
scn.cycles.max_bounces = 4
scn.render.threads_mode = 'FIXED'
scn.render.threads = 6
scn.render.resolution_x, scn.render.resolution_y = job.get('res', [512, 640])
scn.render.resolution_percentage = 100
scn.render.image_settings.file_format = 'PNG'
scn.view_settings.view_transform = 'Standard'
scn.view_settings.look = 'None'
scn.view_settings.exposure = job.get('exposure', 0.0)

# world: overcast sky + weak sun
w = bpy.data.worlds.new('w'); scn.world = w; w.use_nodes = True
bg = w.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.72, 0.78, 0.86, 1); bg.inputs[1].default_value = job.get('sky', 0.5)
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = job.get('sun', 1.5); sun.data.angle = math.radians(25)
sun.rotation_euler = Vector(job.get('sun_dir', (0.45, 0.8, -0.85))).to_track_quat('-Z', 'Y').to_euler()
scn.collection.objects.link(sun)


def make_material(name, tex=None, use_col=False):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = 0.62
    b.inputs['Base Color'].default_value = (0.55, 0.53, 0.5, 1)
    if use_col:
        a = nt.nodes.new('ShaderNodeAttribute'); a.attribute_name = 'Col'
        nt.links.new(a.outputs['Color'], b.inputs['Base Color'])
    if tex:
        def img(path, cs):
            n = nt.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(path)
            n.image.colorspace_settings.name = cs; return n
        if tex.get('albedo'):
            n = img(tex['albedo'], 'sRGB')
            if tex.get('orm') and tex.get('use_ao', True):
                o = img(tex['orm'], 'Non-Color'); sep = nt.nodes.new('ShaderNodeSeparateColor')
                nt.links.new(o.outputs['Color'], sep.inputs['Color'])
                mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
                mix.inputs['Factor'].default_value = 1.0
                nt.links.new(n.outputs['Color'], mix.inputs['A']); nt.links.new(sep.outputs['Red'], mix.inputs['B'])
                nt.links.new(mix.outputs['Result'], b.inputs['Base Color'])
                nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
            else:
                nt.links.new(n.outputs['Color'], b.inputs['Base Color'])
        if tex.get('normal'):
            n = img(tex['normal'], 'Non-Color'); nm = nt.nodes.new('ShaderNodeNormalMap')
            nt.links.new(n.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return m


objs = []
if job.get('glb'):
    bpy.ops.import_scene.gltf(filepath=job['glb'])
    scn.render.fps = 30
    objs = [o for o in scn.objects if o.type == 'MESH']
    arm = next((o for o in scn.objects if o.type == 'ARMATURE'), None)
    if job.get('tex'):
        mat = make_material('m', job['tex'])
        for o in objs:
            o.data.materials.clear(); o.data.materials.append(mat)
elif job.get('blend'):
    bpy.ops.wm.append(directory=job['blend'] + '/Object/', files=[{'name': n} for n in job['objects']])
    objs = [o for o in scn.objects if o.type == 'MESH']
    arm = next((o for o in scn.objects if o.type == 'ARMATURE'), None)
    mat = make_material('m', job.get('tex'))
    for o in objs:
        o.data.materials.clear(); o.data.materials.append(mat)
else:
    d = np.load(job['mesh'])
    me = bpy.data.meshes.new('m')
    me.from_pydata(d['verts'].tolist(), [], d['faces'].tolist())
    me.update()
    me.shade_smooth()
    if 'col' in d:
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        c = np.concatenate([d['col'], np.ones((len(d['col']), 1))], 1).astype(np.float32)
        ca.data.foreach_set('color', c.ravel())
    if 'uv' in d:
        uvl = me.uv_layers.new(name='UVMap'); uvl.data.foreach_set('uv', d['uv'].astype(np.float32).ravel())
    ob = bpy.data.objects.new('m', me); scn.collection.objects.link(ob)
    me.materials.append(make_material('m', job.get('tex'), 'col' in d))
    objs = [ob]; arm = None

def set_clip(arm, clip, t, dur):
    """Pose the imported rig at time t (seconds) of a named clip."""
    ad = arm.animation_data or arm.animation_data_create()
    for tr in list(ad.nla_tracks):
        ad.nla_tracks.remove(tr)
    act = next((a for a in bpy.data.actions if a.name == clip), None) or next(a for a in bpy.data.actions if a.name.startswith(clip))
    ad.action = act
    try:
        if ad.action_slot is None and len(act.slots):
            ad.action_slot = act.slots[0]
    except Exception:
        pass
    f0, f1 = act.frame_range
    f = f0 + (f1 - f0) * (t / dur)
    scn.frame_set(int(f), subframe=float(f - int(f)))


if job.get('ground') is not None:
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, job['ground']))
    g = bpy.context.object; gm = bpy.data.materials.new('g'); gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.23, 0.22, 0.2, 1)
    gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    g.data.materials.append(gm)

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scn.collection.objects.link(cam); scn.camera = cam
cam.data.clip_start = 0.01
for v in job['views']:
    if v.get('res'):
        scn.render.resolution_x, scn.render.resolution_y = v['res']
    if arm is not None and v.get('clip'):
        set_clip(arm, v['clip'], v['t'], v['dur'])
    loc = Vector(v['loc']); tgt = Vector(v['tgt'])
    cam.location = loc
    cam.rotation_euler = (tgt - loc).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = v.get('lens', 70)
    scn.render.filepath = job['out'] + v['name'] + '.png'
    bpy.ops.render.render(write_still=True)
print('RENDER_DONE')
