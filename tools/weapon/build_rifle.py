# Valle Morta first-person rifle builder.
#   blender -b -t 4 --python tools/weapon/build_rifle.py -- [geo clay bake tex export render]
# (no stage list = everything except the clay preview)
import bpy, bmesh, sys, os, json, time, subprocess, traceback
from math import radians
from mathutils import Vector, Matrix
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))
BUILD = os.path.join(HERE, 'build'); PREV = os.path.join(ROOT, 'tools', '_preview', 'weapon')
OUT = os.path.join(ROOT, 'public', 'assets', 'models', 'rifle.glb')
VENV = os.path.join(ROOT, '.venv', 'Scripts', 'python.exe')
BLEND = os.path.join(BUILD, 'weapon.blend'); FINAL = os.path.join(BUILD, 'weapon_final.blend')
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
stages = [a for a in argv if not a.startswith('-')] or ['geo', 'bake', 'tex', 'export', 'render']
TEX = 2048; S = 0.001
ATL = {'rifle': ['RifleBody', 'Bolt', 'Magazine', 'Trigger'], 'hands': ['HandR', 'HandL']}
UVS = {1: 1.15, 2: 1.4, 3: 1.2, 20: 0.35, 21: 0.5}
for d in (BUILD, PREV, os.path.dirname(OUT)): os.makedirs(d, exist_ok=True)


def opkw(op, **kw):
    props = op.get_rna_type().properties.keys(); return {k: v for k, v in kw.items() if k in props}


def getcol(me):
    ca = me.color_attributes['pid']; col = np.empty(len(ca.data) * 4, np.float32); ca.data.foreach_get('color', col); return ca, col.reshape(-1, 4)


def tris(me): return sum(len(p.vertices) - 2 for p in me.polygons)


def cycles(sc, spp, denoise=False):
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = spp
    sc.render.threads_mode = 'FIXED'; sc.render.threads = 4
    try: sc.cycles.use_adaptive_sampling = False; sc.cycles.use_denoising = denoise
    except Exception as ex: print(ex)


def wnorm(ob):
    m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); m.keep_sharp = True; m.weight = 50
    dg = bpy.context.evaluated_depsgraph_get(); dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    ob.modifiers.clear(); old = ob.data; ob.data = me; bpy.data.meshes.remove(old)


# ------------------------------------------------------------------ geometry
def st_geo():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import geo
    info = geo.build_all(); sc = bpy.context.scene
    root = bpy.data.objects.new('Rifle', None); root.empty_display_size = 0.02; sc.collection.objects.link(root)
    for an, groups in ATL.items():
        bm = bmesh.new()
        for gi, g in enumerate(groups):
            for me in geo.GROUPS[g]:
                ca, col = getcol(me); col[:, 3] = (gi + 1) / 8.0; ca.data.foreach_set('color', col.ravel()); bm.from_mesh(me)
        me = bpy.data.meshes.new('ATLAS_' + an); bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new('ATLAS_' + an, me); sc.collection.objects.link(ob)
        ca, col = getcol(me); nl = len(col)
        vi = np.empty(nl, np.int32); me.loops.foreach_get('vertex_index', vi)
        pid = np.rint(col[:, 0] * 32).astype(np.int32); tag = np.rint(col[:, 2] * 32).astype(np.int32)
        if an == 'hands':   # seam mask on vertices shared by two materials -> G
            nv = len(me.vertices); lo = np.full(nv, 99, np.int32); hi = np.zeros(nv, np.int32)
            np.minimum.at(lo, vi, pid); np.maximum.at(hi, vi, pid)
            col[:, 1] = (lo != hi)[vi]; ca.data.foreach_set('color', col.ravel())
        # UV: temporarily scale tagged parts so smart-project gives them more / less texel density
        co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co); co0 = co.copy(); co = co.reshape(-1, 3)
        for t, s in UVS.items():
            vs = np.unique(vi[tag == t]); co[vs] *= s
        me.vertices.foreach_set('co', co.ravel()); me.update()
        bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(**opkw(bpy.ops.uv.smart_project, angle_limit=radians(62), island_margin=0.0016, area_weight=0.0, correct_aspect=True, scale_to_bounds=False))
        bpy.ops.object.mode_set(mode='OBJECT')
        me = ob.data; me.vertices.foreach_set('co', co0); me.update()
        # split into node objects
        ca, col = getcol(me); np_ = len(me.polygons)
        ls = np.empty(np_, np.int32); me.polygons.foreach_get('loop_start', ls); fg = np.rint(col[ls, 3] * 8).astype(np.int32)
        print('ATLAS', an, 'tris', tris(me), 'pids', np.unique(np.rint(col[ls, 0] * 32), return_counts=True))
        for gi, g in enumerate(groups):
            b2 = bmesh.new(); b2.from_mesh(me); b2.faces.ensure_lookup_table()
            bmesh.ops.delete(b2, geom=[b2.faces[i] for i in np.nonzero(fg != gi + 1)[0]], context='FACES')
            m2 = bpy.data.meshes.new(g); b2.to_mesh(m2); b2.free()
            o2 = bpy.data.objects.new(g, m2); sc.collection.objects.link(o2)
            org = Vector(info['origins'].get(g, (0, 0, 0))) * S
            m2.transform(Matrix.Translation(-org)); o2.location = org; o2.parent = root
            if an == 'rifle': wnorm(o2)
            print('  node', g, 'tris', tris(o2.data))
        if an == 'rifle': wnorm(ob)
        ob.hide_render = True
    for name, p in info['empties'].items():
        e = bpy.data.objects.new(name, None); e.empty_display_size = 0.01; e.location = Vector(p) * S; e.parent = root; sc.collection.objects.link(e)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, check_existing=False)


# ------------------------------------------------------------------ preview rendering
VIEWS = {
    'fp': dict(loc=(-0.082, -0.235, 0.118), look=(-0.082, 1.0, 0.118), fov=52),
    'ads': dict(loc=(0.0, 0.0745, 0.085), look=(0.0, 1.0, 0.085), fov=40),
    'beauty': dict(loc=(0.72, -0.30, 0.26), look=(0.0, 0.15, -0.03), fov=31),
    'closeR': dict(loc=(0.33, -0.10, 0.10), look=(0.0, 0.03, -0.01), fov=36),
    'closeL': dict(loc=(-0.30, 0.02, 0.17), look=(0.0, 0.22, 0.02), fov=36),
    'top': dict(loc=(-0.10, -0.33, 0.16), look=(0.0, 0.10, 0.03), fov=30),
}


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
    l = bpy.data.lights.new('sun', 'SUN'); l.energy = 2.2; l.angle = radians(14); l.color = (1.0, 0.95, 0.88)
    lo = bpy.data.objects.new('sun', l); sc.collection.objects.link(lo); lo.rotation_euler = (radians(48), radians(8), radians(-40))
    cam = bpy.data.cameras.new('cam'); co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    cam.clip_start = 0.004; cam.clip_end = 50; cam.sensor_fit = 'VERTICAL'
    return co


def render_views(sc, prefix, names, res=(800, 450), spp=32):
    co = setup_light(sc); cycles(sc, spp, True)
    sc.render.resolution_x, sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    files = []
    for nme in names:
        v = VIEWS[nme]; co.location = v['loc']; d = Vector(v['look']) - Vector(v['loc'])
        co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler(); co.data.angle = radians(v['fov'])
        f = os.path.join(PREV, prefix + '_' + nme + '.png'); sc.render.filepath = f; t = time.time()
        bpy.ops.render.render(write_still=True); files.append(f); print('rendered', nme, round(time.time() - t, 1), 's')
    subprocess.run([VENV, os.path.join(HERE, 'sheet.py'), os.path.join(PREV, prefix + '_sheet.png'), '2', '500'] + files)


def st_clay():
    bpy.ops.wm.open_mainfile(filepath=BLEND); sc = bpy.context.scene
    m = bpy.data.materials.new('CLAY'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); bs = nt.nodes.new('ShaderNodeBsdfPrincipled'); nt.links.new(bs.outputs[0], out.inputs[0])
    at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'pid'; sp = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(at.outputs['Color'], sp.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.interpolation = 'CONSTANT'; els = ramp.color_ramp.elements
    cols = {1: (.14, .14, .15), 2: (.2, .2, .22), 3: (.5, .5, .5), 4: (.45, .2, .08), 5: (.4, .17, .07), 6: (.12, .13, .1), 7: (.25, .16, .1), 8: (.04, .04, .04),
            9: (.2, .22, .1), 10: (.05, .05, .05), 11: (.7, .5, .2), 12: (.16, .17, .13), 13: (.17, .19, .09), 14: (.1, .05, .03)}
    els[0].position = 0; els[0].color = (0, 0, 0, 1); els.remove(els[1])
    for pid, c in cols.items():
        e = els.new((pid - 0.5) / 32.0); e.color = (*c, 1)
    nt.links.new(sp.outputs[0], ramp.inputs[0]); nt.links.new(ramp.outputs[0], bs.inputs['Base Color']); bs.inputs['Roughness'].default_value = 0.5
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and not ob.name.startswith('ATLAS'): ob.data.materials.clear(); ob.data.materials.append(m)
    render_views(sc, 'clay', ['fp', 'ads', 'beauty', 'closeR', 'closeL', 'top'], (640, 360), 20)


# ------------------------------------------------------------------ bake
def st_bake():
    bpy.ops.wm.open_mainfile(filepath=BLEND); sc = bpy.context.scene; cycles(sc, 1)
    w = bpy.data.worlds.new('B'); sc.world = w; w.light_settings.distance = 0.045
    img = bpy.data.images.new('bk', TEX, TEX, alpha=False, float_buffer=True); img.colorspace_settings.name = 'Non-Color'
    for an in ATL:
        t0 = time.time()
        for o in bpy.data.objects: o.hide_render = True
        ob = bpy.data.objects['ATLAS_' + an]; ob.hide_render = False
        bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
        co = np.empty(len(ob.data.vertices) * 3, np.float32); ob.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        bmin = co.min(0) - 0.01; bmax = co.max(0) + 0.01
        json.dump(dict(bmin=bmin.tolist(), bmax=bmax.tolist()), open(os.path.join(BUILD, an + '_meta.json'), 'w'))
        m = bpy.data.materials.new('BAKE_' + an); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial'); em = nt.nodes.new('ShaderNodeEmission'); nt.links.new(em.outputs[0], out.inputs[0])
        geo = nt.nodes.new('ShaderNodeNewGeometry'); bev = nt.nodes.new('ShaderNodeBevel'); bev.samples = 8; bev.inputs[0].default_value = 0.0016
        att = nt.nodes.new('ShaderNodeAttribute'); att.attribute_name = 'pid'
        def madd(src, mul, add):
            n = nt.nodes.new('ShaderNodeVectorMath'); n.operation = 'MULTIPLY_ADD'; nt.links.new(src, n.inputs[0])
            n.inputs[1].default_value = mul; n.inputs[2].default_value = add; return n.outputs[0]
        inv = 1.0 / (bmax - bmin)
        socks = dict(pid=att.outputs['Color'], pos=madd(geo.outputs['Position'], tuple(inv), tuple(-bmin * inv)),
                     nrm=madd(geo.outputs['Normal'], (.5, .5, .5), (.5, .5, .5)), bev=madd(bev.outputs[0], (.5, .5, .5), (.5, .5, .5)))
        tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img; nt.nodes.active = tex; tex.select = True
        ob.data.materials.clear(); ob.data.materials.append(m)
        for pas, spp in (('pid', 1), ('pos', 1), ('nrm', 1), ('bev', 12), ('ao', 28)):
            img.pixels.foreach_set(np.zeros(TEX * TEX * 4, np.float32)); sc.cycles.samples = spp
            if pas != 'ao':
                for l in list(em.inputs[0].links): nt.links.remove(l)
                nt.links.new(socks[pas], em.inputs[0]); bpy.ops.object.bake(type='EMIT', margin=0, use_clear=False)
            else:
                bpy.ops.object.bake(type='AO', margin=0, use_clear=False)
            arr = np.empty(TEX * TEX * 4, np.float32); img.pixels.foreach_get(arr); arr = arr.reshape(TEX, TEX, 4)[:, :, :3]
            np.save(os.path.join(BUILD, an + '_' + pas + '.npy'), arr if pas == 'pos' else arr.astype(np.float16))
            print('baked', an, pas, round(time.time() - t0, 1), 's', 'cover', float((arr.sum(2) > 0).mean()))


def st_tex():
    r = subprocess.run([VENV, os.path.join(HERE, 'textures.py'), BUILD]); print('textures rc', r.returncode)


# ------------------------------------------------------------------ materials + export
def final_mat(name):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); m.use_backface_culling = True
    out = nt.nodes.new('ShaderNodeOutputMaterial'); bs = nt.nodes.new('ShaderNodeBsdfPrincipled'); nt.links.new(bs.outputs[0], out.inputs[0])
    def tex(suf, cs):
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(os.path.join(BUILD, name.lower() + '_' + suf + '.png')); n.image.colorspace_settings.name = cs; return n
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


def st_export():
    bpy.ops.wm.open_mainfile(filepath=BLEND); sc = bpy.context.scene
    for an in ATL: bpy.data.objects.remove(bpy.data.objects['ATLAS_' + an])
    for an, groups in ATL.items():
        m = final_mat(an.capitalize())
        for g in groups:
            me = bpy.data.objects[g].data; me.materials.clear(); me.materials.append(m)
            for ca in list(me.color_attributes): me.color_attributes.remove(ca)
    bpy.ops.wm.save_as_mainfile(filepath=FINAL, check_existing=False)
    bpy.ops.export_scene.gltf(**opkw(bpy.ops.export_scene.gltf, filepath=OUT, export_format='GLB', export_image_format='JPEG', export_jpeg_quality=94, export_image_quality=94,
                                     export_yup=True, export_apply=False, export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False,
                                     export_extras=False, export_tangents=False, export_normals=True, export_texcoords=True, export_materials='EXPORT', export_vertex_color='NONE',
                                     export_attributes=False, use_selection=False))
    print('exported', OUT, round(os.path.getsize(OUT) / 1e6, 2), 'MB')


def st_render():
    bpy.ops.wm.open_mainfile(filepath=FINAL); sc = bpy.context.scene
    names = [a[2:] for a in argv if a.startswith('--') and a[2:] in VIEWS] or ['fp', 'ads', 'beauty', 'closeR', 'closeL', 'top']
    pre = next((a.split('=')[1] for a in argv if a.startswith('-prefix=')), 'tex')
    res = (1000, 562) if any(a == '-big' for a in argv) else (800, 450)
    render_views(sc, pre, names, res, 40)


for s in stages:
    t = time.time()
    try:
        {'geo': st_geo, 'clay': st_clay, 'bake': st_bake, 'tex': st_tex, 'export': st_export, 'render': st_render}[s]()
        print('STAGE', s, 'ok', round(time.time() - t, 1), 's')
    except Exception:
        traceback.print_exc(); print('STAGE', s, 'FAILED'); break
