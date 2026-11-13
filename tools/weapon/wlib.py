# Valle Morta weapon pipeline helpers shared by all view models: atlas UVs, geometry-map bakes, materials,
# preview lighting / rendering, contact sheets and the glTF export.
import bpy, bmesh, sys, os, json, time, subprocess
from math import radians
from mathutils import Vector, Matrix
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
BUILD = os.path.join(HERE, 'build'); PREV = os.path.join(ROOT, 'tools', '_preview', 'weapon'); MODELS = os.path.join(ROOT, 'public', 'assets', 'models')
VENV = os.path.join(ROOT, '.venv', 'Scripts', 'python.exe'); TEX = 2048; S = 0.001; THREADS = 6
for d in (BUILD, PREV, MODELS): os.makedirs(d, exist_ok=True)


def opkw(op, **kw):
    props = op.get_rna_type().properties.keys(); return {k: v for k, v in kw.items() if k in props}


def getcol(me):
    ca = me.color_attributes['pid']; col = np.empty(len(ca.data) * 4, np.float32); ca.data.foreach_get('color', col); return ca, col.reshape(-1, 4)


def tris(me): return sum(len(p.vertices) - 2 for p in me.polygons)


def cycles(sc, spp, denoise=False):
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = spp
    sc.render.threads_mode = 'FIXED'; sc.render.threads = THREADS
    try: sc.cycles.use_adaptive_sampling = False; sc.cycles.use_denoising = denoise
    except Exception as ex: print(ex)


def wnorm(ob):
    m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); m.keep_sharp = True; m.weight = 50
    dg = bpy.context.evaluated_depsgraph_get(); dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    ob.modifiers.clear(); old = ob.data; ob.data = me; bpy.data.meshes.remove(old)


def uv_unwrap(ob, uvs, angle=62, margin=0.0016):
    """smart-project the object; parts carrying a tag (blue channel of 'pid') are temporarily scaled for more / less texel density"""
    me = ob.data; ca, col = getcol(me); vi = np.empty(len(me.loops), np.int32); me.loops.foreach_get('vertex_index', vi)
    tag = np.rint(col[:, 2] * 32).astype(np.int32)
    co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co); co0 = co.copy(); co = co.reshape(-1, 3)
    for t, s in uvs.items(): co[np.unique(vi[tag == t])] *= s
    me.vertices.foreach_set('co', co.ravel()); me.update()
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(**opkw(bpy.ops.uv.smart_project, angle_limit=radians(angle), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False))
    bpy.ops.object.mode_set(mode='OBJECT')
    ob.data.vertices.foreach_set('co', co0); ob.data.update()


def build_atlas(an, groups, G, uvs, angle=62, margin=0.0016):
    """merge all part meshes (metres, 'pid' colour attribute) into the bake target ATLAS_<an>; alpha stores the node index"""
    bm = bmesh.new()
    for gi, g in enumerate(groups):
        for me in G[g]:
            ca, col = getcol(me); col[:, 3] = (gi + 1) / 64.0; ca.data.foreach_set('color', col.ravel()); bm.from_mesh(me)
    me = bpy.data.meshes.new('ATLAS_' + an); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new('ATLAS_' + an, me); bpy.context.scene.collection.objects.link(ob); uv_unwrap(ob, uvs, angle, margin)
    return ob


def split_nodes(ob, groups, origins, parents, root):
    """cut the unwrapped atlas mesh into one object per node, origin at the node pivot (mm), parented under root"""
    me = ob.data; ca, col = getcol(me); ls = np.empty(len(me.polygons), np.int32); me.polygons.foreach_get('loop_start', ls)
    fg = np.rint(col[ls, 3] * 64).astype(np.int32); out = {}
    for gi, g in enumerate(groups):
        b2 = bmesh.new(); b2.from_mesh(me); b2.faces.ensure_lookup_table()
        bmesh.ops.delete(b2, geom=[b2.faces[i] for i in np.nonzero(fg != gi + 1)[0]], context='FACES')
        m2 = bpy.data.meshes.new(g); b2.to_mesh(m2); b2.free(); o2 = bpy.data.objects.new(g, m2); bpy.context.scene.collection.objects.link(o2)
        org = Vector(origins.get(g, (0, 0, 0))) * S; m2.transform(Matrix.Translation(-org)); wnorm(o2); out[g] = (o2, org)
        print('  node %-10s tris %d' % (g, tris(o2.data)))
    for g, (o2, org) in out.items():
        par = parents.get(g)
        if par: o2.parent = out[par][0]; o2.location = org - out[par][1]
        else: o2.parent = root; o2.location = org
    wnorm(ob); print('ATLAS', ob.name, 'tris', tris(ob.data))
    return {g: v[0] for g, v in out.items()}


def bake(an, bevel=0.0016, aodist=0.045, aospp=28):
    """bake part id, position, normal, bevelled normal (curvature) and AO of ATLAS_<an> to .npy maps"""
    sc = bpy.context.scene; cycles(sc, 1); w = bpy.data.worlds.new('B'); sc.world = w; w.light_settings.distance = aodist
    img = bpy.data.images.new('bk', TEX, TEX, alpha=False, float_buffer=True); img.colorspace_settings.name = 'Non-Color'; t0 = time.time()
    for o in bpy.data.objects: o.hide_render = True
    ob = bpy.data.objects['ATLAS_' + an]; ob.hide_render = False
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    co = np.empty(len(ob.data.vertices) * 3, np.float32); ob.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    bmin = co.min(0) - 0.01; bmax = co.max(0) + 0.01
    json.dump(dict(bmin=bmin.tolist(), bmax=bmax.tolist()), open(os.path.join(BUILD, an + '_meta.json'), 'w'))
    m = bpy.data.materials.new('BAKE_' + an); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); em = nt.nodes.new('ShaderNodeEmission'); nt.links.new(em.outputs[0], out.inputs[0])
    geo = nt.nodes.new('ShaderNodeNewGeometry'); bev = nt.nodes.new('ShaderNodeBevel'); bev.samples = 8; bev.inputs[0].default_value = bevel
    att = nt.nodes.new('ShaderNodeAttribute'); att.attribute_name = 'pid'

    def madd(src, mul, add):
        n = nt.nodes.new('ShaderNodeVectorMath'); n.operation = 'MULTIPLY_ADD'; nt.links.new(src, n.inputs[0])
        n.inputs[1].default_value = mul; n.inputs[2].default_value = add; return n.outputs[0]
    inv = 1.0 / (bmax - bmin)
    socks = dict(pid=att.outputs['Color'], pos=madd(geo.outputs['Position'], tuple(inv), tuple(-bmin * inv)),
                 nrm=madd(geo.outputs['Normal'], (.5, .5, .5), (.5, .5, .5)), bev=madd(bev.outputs[0], (.5, .5, .5), (.5, .5, .5)))
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img; nt.nodes.active = tex; tex.select = True
    ob.data.materials.clear(); ob.data.materials.append(m)
    for pas, spp in (('pid', 1), ('pos', 1), ('nrm', 1), ('bev', 12), ('ao', aospp)):
        img.pixels.foreach_set(np.zeros(TEX * TEX * 4, np.float32)); sc.cycles.samples = spp
        if pas != 'ao':
            for l in list(em.inputs[0].links): nt.links.remove(l)
            nt.links.new(socks[pas], em.inputs[0]); bpy.ops.object.bake(type='EMIT', margin=0, use_clear=False)
        else:
            bpy.ops.object.bake(type='AO', margin=0, use_clear=False)
        arr = np.empty(TEX * TEX * 4, np.float32); img.pixels.foreach_get(arr); arr = arr.reshape(TEX, TEX, 4)[:, :, :3]
        np.save(os.path.join(BUILD, an + '_' + pas + '.npy'), arr if pas == 'pos' else arr.astype(np.float16))
        print('baked', an, pas, round(time.time() - t0, 1), 's', 'cover', round(float((arr.sum(2) > 0).mean()), 3), flush=True)


def final_mat(name):
    m = bpy.data.materials.new(name.capitalize()); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); m.use_backface_culling = True
    out = nt.nodes.new('ShaderNodeOutputMaterial'); bs = nt.nodes.new('ShaderNodeBsdfPrincipled'); nt.links.new(bs.outputs[0], out.inputs[0])

    def tex(suf, cs):
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(os.path.join(BUILD, name + '_' + suf + '.png')); n.image.colorspace_settings.name = cs; return n
    tb = tex('base', 'sRGB'); tn = tex('nrm', 'Non-Color'); to = tex('orm', 'Non-Color')
    nt.links.new(tb.outputs[0], bs.inputs['Base Color'])
    nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(tn.outputs[0], nm.inputs['Color']); nt.links.new(nm.outputs[0], bs.inputs['Normal'])
    sep = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(to.outputs[0], sep.inputs[0])
    nt.links.new(sep.outputs[1], bs.inputs['Roughness']); nt.links.new(sep.outputs[2], bs.inputs['Metallic'])
    g = bpy.data.node_groups.get('glTF Material Output')
    if g is None:
        g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        g.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat'); g.nodes.new('NodeGroupInput')
    gn = nt.nodes.new('ShaderNodeGroup'); gn.node_tree = g; nt.links.new(sep.outputs[0], gn.inputs[0])
    return m


def clay(col=(0.55, 0.55, 0.55)):
    m = bpy.data.materials.new('CLAY'); m.use_nodes = True; bs = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bs.inputs['Base Color'].default_value = (*col, 1); bs.inputs['Roughness'].default_value = 0.55
    return m


def mat_for(name):
    return final_mat(name) if os.path.exists(os.path.join(BUILD, name + '_base.png')) else clay()


def setup_light(sc):
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True; nt = w.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld'); bg = nt.nodes.new('ShaderNodeBackground')
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ'); mr = nt.nodes.new('ShaderNodeMapRange'); ramp = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0]); nt.links.new(sep.outputs['Z'], mr.inputs[0])
    mr.inputs[1].default_value = -1.0; mr.inputs[2].default_value = 1.0
    nt.links.new(mr.outputs[0], ramp.inputs[0])
    els = ramp.color_ramp.elements; els[0].position = 0.0; els[0].color = (0.05, 0.047, 0.04, 1); els[1].position = 0.485; els[1].color = (0.13, 0.12, 0.10, 1)
    for p, c in ((0.515, (0.50, 0.52, 0.55, 1)), (0.7, (0.78, 0.80, 0.84, 1)), (1.0, (1.0, 1.0, 1.0, 1))):
        e = els.new(p); e.color = c
    nt.links.new(ramp.outputs[0], bg.inputs[0]); bg.inputs[1].default_value = 1.0; nt.links.new(bg.outputs[0], out.inputs[0])
    l = bpy.data.lights.new('sun', 'SUN'); l.energy = 2.4; l.angle = radians(14); l.color = (1.0, 0.95, 0.88)
    lo = bpy.data.objects.new('sun', l); sc.collection.objects.link(lo); lo.rotation_euler = (radians(48), radians(8), radians(-40))
    cam = bpy.data.cameras.new('cam'); co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    cam.clip_start = 0.004; cam.clip_end = 50; cam.sensor_fit = 'VERTICAL'
    sc.render.image_settings.file_format = 'PNG'; sc.render.resolution_percentage = 100
    return co


def render(sc, cam, loc, look, fov, path, res=(480, 270), spp=24):
    cycles(sc, spp, True); sc.render.resolution_x, sc.render.resolution_y = res
    cam.location = loc; cam.rotation_euler = (Vector(look) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler(); cam.data.angle = radians(fov)
    sc.render.filepath = path; bpy.ops.render.render(write_still=True)


def sheet(out, cols, tw, items):
    spec = os.path.join(BUILD, '_sheet.json'); json.dump(dict(out=out, cols=cols, tw=tw, items=items), open(spec, 'w'))
    subprocess.run([VENV, os.path.join(HERE, 'sheet.py'), spec])


def export_glb(path, objs, anim=True, restpose=False):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.hide_render = False; o.select_set(True)
    bpy.context.scene.frame_set(0)
    kw = dict(filepath=path, export_format='GLB', export_image_format='JPEG', export_jpeg_quality=90, export_image_quality=90, export_yup=True, export_apply=False,
              use_selection=True, export_animations=anim, export_animation_mode='NLA_TRACKS', export_force_sampling=True, export_frame_step=1, export_frame_range=False,
              export_anim_slide_to_zero=True, export_bake_animation=False, export_optimize_animation_size=True, export_optimize_animation_keep_anim_armature=True,
              export_optimize_animation_keep_anim_object=True, export_skins=True, export_def_bones=False, export_rest_position_armature=restpose,
              export_all_influences=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False, export_tangents=False,
              export_normals=True, export_texcoords=True, export_materials='EXPORT', export_vertex_color='NONE', export_attributes=False)
    bpy.ops.export_scene.gltf(**opkw(bpy.ops.export_scene.gltf, **kw))
    print('exported', path, round(os.path.getsize(path) / 1e6, 2), 'MB')
