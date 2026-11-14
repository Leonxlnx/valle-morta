# Blender side of the helicopter pipeline (run headless, see README.md).
#   stage "bake":   geometry (heli_geo) -> objects per texture group, solidified skin, atlas UVs,
#                   bakes of position / normal / part id / edge / AO into _work/*.npy, saves _work/heli.blend
#   stage "export": final PBR materials from the textures that tex.py made, node split and pivots,
#                   blurred rotor discs, emissive lights, far LOD, GLB -> public/assets/models/heli.glb
import bpy, bmesh, sys, os, time
import numpy as np
from math import radians
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
WORK = os.path.join(HERE, '_work'); os.makedirs(WORK, exist_ok=True)
OUT = os.path.join(WORK, 'heli.glb')     # copied into public/assets/models by tools/vehicles/install.mjs (under the GPU lock)
import heli_geo as H

GROUPS = {'paint': 2048, 'top': 2048, 'cabin': 2048, 'mech': 2048, 'crew': 1024}     # five texture sets; the glass is untextured
BEVEL = {'paint': 0.02, 'top': 0.02, 'cabin': 0.008, 'mech': 0.006, 'crew': 0.01}
THREADS = 4
T0 = time.time()


def log(*a): print('[heli %5.1fs]' % (time.time() - T0), *a, flush=True)


def opkw(op, **kw):
    props = op.get_rna_type().properties.keys(); return {k: v for k, v in kw.items() if k in props}


def mesh_obj(name, mb):
    V = mb.verts(); me = bpy.data.meshes.new(name); me.from_pydata([tuple(v) for v in V], [], mb.F); me.update()
    col = np.zeros((len(mb.F), 4), np.float32); col[:, 0] = np.array(mb.M) / 64.0; col[:, 1] = mb.R; col[:, 3] = 1
    a = me.attributes.new('pid', 'FLOAT_COLOR', 'FACE'); a.data.foreach_set('color', col.ravel())
    b = me.attributes.new('node', 'INT', 'FACE'); b.data.foreach_set('value', np.array(mb.N, np.int32))
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    return ob


def clean(ob, smooth_angle=38):
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(ob.data); bm.free()
    me = ob.data; me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    try: me.set_sharp_from_angle(angle=radians(smooth_angle))
    except Exception as ex: log('sharp', ex)


def apply_mod(ob):
    dg = bpy.context.evaluated_depsgraph_get(); dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    ob.modifiers.clear(); old = ob.data; ob.data = me; bpy.data.meshes.remove(old)


def extract(ob, keep_fn, name):
    """new object with the faces for which keep_fn(bmface) is true"""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not keep_fn(f)], context='FACES')
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); return o


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join()
    objs[0].name = name; objs[0].data.name = name; return objs[0]


def recalc(ob):
    bm = bmesh.new(); bm.from_mesh(ob.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(ob.data); bm.free()


def select_only(ob):
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob


def unwrap(ob):
    select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(**opkw(bpy.ops.uv.smart_project, angle_limit=radians(55), island_margin=0.003, scale_to_bounds=False, area_weight=0.0))
    try: bpy.ops.uv.average_islands_scale()
    except Exception as ex: log('avg', ex)
    bpy.ops.uv.pack_islands(**opkw(bpy.ops.uv.pack_islands, margin=0.003, rotate=True, shape_method='CONCAVE', margin_method='FRACTION'))
    bpy.ops.object.mode_set(mode='OBJECT')


# ------------------------------------------------------------------------------------------- bake stage
def stage_bake():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o)
    G = H.build()
    hull = mesh_obj('hull', G['hull'])
    hull.data.materials.append(bpy.data.materials.new('outer')); hull.data.materials.append(bpy.data.materials.new('inner'))
    md = hull.modifiers.new('s', 'SOLIDIFY'); md.thickness = 0.035; md.offset = -1; md.use_even_offset = True; md.use_rim = True
    md.material_offset = 1; md.material_offset_rim = 0
    apply_mod(hull)
    outer = extract(hull, lambda f: f.material_index == 0, 'hull_out'); inner = extract(hull, lambda f: f.material_index == 1, 'hull_in')
    bpy.data.objects.remove(hull)
    me = inner.data; ca = me.attributes['pid']; col = np.empty(len(ca.data) * 4, np.float32); ca.data.foreach_get('color', col)
    col = col.reshape(-1, 4); col[:, 0] = H.LINING / 64.0; ca.data.foreach_set('color', col.ravel())
    objs = {k: mesh_obj(k, G[k]) for k in ('paint', 'top', 'cabin', 'mech', 'glass', 'crew', 'light')}
    for k in ('top', 'cabin', 'mech', 'crew', 'light'): clean(objs[k])
    objs['paint'] = join([objs['paint'], outer], 'paint'); objs['cabin'] = join([objs['cabin'], inner], 'cabin')
    for k in ('paint', 'cabin', 'glass'): clean(objs[k])
    for k, o in objs.items():
        o.data.materials.clear()
        log('group', k, sum(len(p.vertices) - 2 for p in o.data.polygons), 'tris')
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.render.threads_mode = 'FIXED'; sc.render.threads = THREADS
    w = bpy.data.worlds.new('W'); sc.world = w; w.light_settings.distance = 0.9
    sc.render.bake.margin = 6
    for k in GROUPS: unwrap(objs[k]); log('uv', k)
    objs['glass'].hide_render = True
    for k, size in GROUPS.items():
        ob = objs[k]; ob.hide_render = False; select_only(ob)
        m = bpy.data.materials.new('BK_' + k); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial'); em = nt.nodes.new('ShaderNodeEmission'); nt.links.new(em.outputs[0], out.inputs[0])
        geo = nt.nodes.new('ShaderNodeNewGeometry'); att = nt.nodes.new('ShaderNodeAttribute'); att.attribute_name = 'pid'
        bev = nt.nodes.new('ShaderNodeBevel'); bev.samples = 8; bev.inputs['Radius'].default_value = BEVEL[k]
        dot = nt.nodes.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
        nt.links.new(bev.outputs['Normal'], dot.inputs[0]); nt.links.new(geo.outputs['Normal'], dot.inputs[1])
        tex = nt.nodes.new('ShaderNodeTexImage'); ob.data.materials.append(m)
        plan = [('pid', att.outputs['Color'], 1), ('pos', geo.outputs['Position'], 1), ('nrm', geo.outputs['Normal'], 1)]
        if k != 'glass': plan += [('edge', dot.outputs['Value'], 6), ('ao', None, 20)]
        for name, sock, spp in plan:
            img = bpy.data.images.new(f'{k}_{name}', size, size, alpha=True, float_buffer=True); img.colorspace_settings.name = 'Non-Color'
            img.generated_color = (0, 0, 0, 0)
            tex.image = img; nt.nodes.active = tex; sc.cycles.samples = spp
            for l in list(em.inputs['Color'].links): nt.links.remove(l)
            if sock is not None: nt.links.new(sock, em.inputs['Color'])
            bpy.ops.object.bake(**opkw(bpy.ops.object.bake, type='AO' if name == 'ao' else 'EMIT', margin=6, use_clear=True))
            buf = np.empty(size * size * 4, np.float32); img.pixels.foreach_get(buf); buf = buf.reshape(size, size, 4)
            np.save(os.path.join(WORK, f'{k}_{name}.npy'), buf if name in ('pos', 'pid') else buf.astype(np.float16))
            bpy.data.images.remove(img)
            log('bake', k, name)
        ob.data.materials.clear()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'heli.blend'))
    log('saved')


# ----------------------------------------------------------------------------------------- export stage
def final_mat(name, k):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); m.use_backface_culling = True
    out = nt.nodes.new('ShaderNodeOutputMaterial'); bs = nt.nodes.new('ShaderNodeBsdfPrincipled'); nt.links.new(bs.outputs[0], out.inputs[0])

    def tex(suf, cs):
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(os.path.join(WORK, f'heli_{k}_{suf}.png')); n.image.colorspace_settings.name = cs; return n
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


def flat_mat(name, rgb, emit=0.0, rough=0.4, img=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; bs = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bs.inputs['Base Color'].default_value = (*rgb, 1); bs.inputs['Roughness'].default_value = rough
    if emit:
        bs.inputs['Emission Color'].default_value = (*rgb, 1); bs.inputs['Emission Strength'].default_value = emit
    if img:
        n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(img); n.image.colorspace_settings.name = 'sRGB'
        m.node_tree.links.new(n.outputs[0], bs.inputs['Base Color'])
    return m


def disc(name, r0, r1, axis, cone):
    """flat ring with planar UVs (u, v = 0.5 + x / 2 r1): the blur texture is radial"""
    n, rings = 72, 6
    rr = np.linspace(r0, r1, rings); A = np.linspace(0, 2 * np.pi, n, endpoint=False)
    V, UV, F = [], [], []
    for i, r in enumerate(rr):
        for a in A:
            u, v = np.cos(a) * r, np.sin(a) * r; h = cone * (r - r0) / (r1 - r0)
            V.append((u, v, h) if axis == 'z' else (-h, u, v)); UV.append((0.5 + u / (2 * r1), 0.5 + v / (2 * r1)))
    for i in range(rings - 1):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n; F.append((a, b, b + n, a + n))
    me = bpy.data.meshes.new(name); me.from_pydata(V, [], F); me.update()
    uv = me.uv_layers.new(name='UVMap')
    loops = np.array([l.vertex_index for l in me.loops]); uv.data.foreach_set('uv', np.array(UV, np.float32)[loops].ravel())
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob); return ob


def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(e); e.location = loc
    if parent: e.parent = parent
    return e


def stage_export():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'heli.blend'))
    sc = bpy.context.scene
    root = empty('Heli', (0, 0, 0))
    rz = H.RZ + H.DZ; trc = Vector(tuple(H.TRC)) + Vector((0, 0, H.DZ))
    piv = {'Body': Vector((0, 0, 0)), 'DoorR': Vector((0, 0, 0)), 'DoorL': Vector((0, 0, 0)), 'MainRotor': Vector((0, 0, rz)), 'Blades': Vector((0, 0, rz)),
           'TailRotor': trc, 'TailBlades': trc}
    E = {'Body': root}
    for nm in ('DoorR', 'DoorL', 'MainRotor', 'TailRotor'): E[nm] = empty(nm, piv[nm], root)
    E['Blades'] = empty('Blades', (0, 0, 0), E['MainRotor']); E['TailBlades'] = empty('TailBlades', (0, 0, 0), E['TailRotor'])
    names = {'paint': 'HeliPaint', 'top': 'HeliPaintTop', 'cabin': 'HeliCabin', 'mech': 'HeliMech', 'crew': 'HeliCrew', 'glass': 'HeliGlass'}
    mats = {k: final_mat(v, k) for k, v in names.items() if k != 'glass'}
    mats['glass'] = flat_mat('HeliGlass', (0.10, 0.12, 0.12), 0, 0.04)
    parts = []; total = 0
    for k in list(names) + ['light']:
        ob = bpy.data.objects[k]; me = ob.data
        node = np.empty(len(me.polygons), np.int32); me.attributes['node'].data.foreach_get('value', node)
        for ni in np.unique(node):
            nm = H.NODES[ni]
            o = extract(ob, lambda f, ni=ni, lay=None: True, f'{nm}_{k}')
            bm = bmesh.new(); bm.from_mesh(o.data); lay = bm.faces.layers.int.get('node')
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[lay] != ni], context='FACES'); bm.to_mesh(o.data); bm.free()
            o.data.transform(Matrix.Translation(-piv[nm])); o.parent = E[nm]; o.location = (0, 0, 0)
            o.data.materials.clear()
            if k == 'light':
                pid = np.empty(len(o.data.polygons) * 4, np.float32); o.data.attributes['pid'].data.foreach_get('color', pid)
                ids = np.rint(pid.reshape(-1, 4)[:, 0] * 64).astype(int)
                L = {H.L_RED: ('LightRed', (1, 0.05, 0.03), 4), H.L_GREEN: ('LightGreen', (0.1, 1, 0.3), 4), H.L_WHITE: ('LightWhite', (1, 1, 0.92), 4), H.L_BEACON: ('Beacon', (1, 0.08, 0.04), 6),
                     H.L_DIAL: ('DialFace', (0.06, 0.07, 0.06), 1.6), H.L_SCREEN: ('Screen', (0.05, 0.17, 0.11), 2.2)}
                order = sorted(set(ids))
                for i in order: o.data.materials.append(bpy.data.materials.get(L[i][0]) or flat_mat(L[i][0], L[i][1], L[i][2], 0.2))
                o.data.polygons.foreach_set('material_index', np.array([order.index(i) for i in ids], np.int32))
            else:
                o.data.materials.append(mats[k])
            for a in ('pid', 'node'):
                if a in o.data.attributes: o.data.attributes.remove(o.data.attributes[a])
            t = sum(len(p.vertices) - 2 for p in o.data.polygons); total += t; parts.append((o.name, t))
        bpy.data.objects.remove(ob)
    # blurred rotor discs
    dm = flat_mat('RotorDisc', (1, 1, 1), 0, 0.7, os.path.join(WORK, 'heli_disc.png'))
    d1 = disc('RotorDisc', 0.55, H.ROTOR_R, 'z', 0.12); d1.parent = E['MainRotor']; d1.data.materials.append(dm)
    d2 = disc('TailDisc', 0.12, H.TAIL_R, 'x', 0.0); d2.parent = E['TailRotor']; d2.location = (-0.0, 0, 0); d2.data.materials.append(dm)
    # far LOD: the outside in one decimated mesh
    src = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.split('_')[-1] in ('paint', 'top', 'mech', 'glass') and o.parent and o.parent.name in ('Heli', 'DoorR', 'DoorL')]
    dup = []
    for o in src:
        c = o.copy(); c.data = o.data.copy(); sc.collection.objects.link(c); c.parent = None; c.matrix_world = o.matrix_world.copy(); dup.append(c)
    lod = join(dup, 'HeliLOD'); select_only(lod); bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    md = lod.modifiers.new('d', 'DECIMATE'); md.ratio = 0.14; apply_mod(lod)
    bm = bmesh.new(); bm.from_mesh(lod.data)          # decimation leaves degenerate and loose bits: clean them, then validate
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-4)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-8], context='FACES')
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context='EDGES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(lod.data); bm.free(); log('lod validate changed:', lod.data.validate(verbose=False)); lod.parent = root
    t = sum(len(p.vertices) - 2 for p in lod.data.polygons); parts.append(('HeliLOD', t))
    for n_, t_ in parts: log('part', n_, t_)
    log('total (without LOD and discs)', total)
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        if o.name in ('paint', 'cabin', 'mech', 'crew', 'glass', 'light'): continue
        o.select_set(True)
    kw = dict(filepath=OUT, export_format='GLB', export_image_format='JPEG', export_jpeg_quality=88, export_image_quality=88, export_yup=True, export_apply=False,
              use_selection=True, export_animations=False, export_cameras=False, export_lights=False, export_extras=False, export_tangents=False,
              export_normals=True, export_texcoords=True, export_materials='EXPORT', export_vertex_color='NONE', export_attributes=False)
    bpy.ops.export_scene.gltf(**opkw(bpy.ops.export_scene.gltf, **kw))
    log('exported', OUT, round(os.path.getsize(OUT) / 1e6, 2), 'MB')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if 'bake' in argv: stage_bake()
    if 'export' in argv: stage_export()
