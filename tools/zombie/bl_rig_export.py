"""Rig the game mesh and export the rest-pose skinned GLB.
blender -b -t 6 build/low.blend --python bl_rig_export.py   -> build/zombie_raw.glb, build/rigged.blend
"""
import bpy, sys, os
import numpy as np
from mathutils import Vector
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import variant
BUILD = variant.BUILD
from skeleton import J, J0, BONES, PARENT, TAIL

ob = bpy.data.objects['Zombie']; me = ob.data
wz = np.load(os.path.join(BUILD, 'weights.npz'))
assert len(me.vertices) == len(wz['idx']), 'weights do not match the mesh, re-run rig.py'

arm_data = bpy.data.armatures.new('ZombieRig'); arm = bpy.data.objects.new('ZombieRig', arm_data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
ebs = {}
for b, pa in zip(BONES, PARENT):
    eb = arm_data.edit_bones.new(b)
    eb.head = Vector(J[b]); eb.tail = Vector(J[TAIL[b]])
    if pa >= 0:
        eb.parent = ebs[BONES[pa]]; eb.use_connect = False
    ebs[b] = eb
bpy.ops.object.mode_set(mode='OBJECT')

for g in list(ob.vertex_groups):
    ob.vertex_groups.remove(g)
groups = [ob.vertex_groups.new(name=b) for b in BONES]
idx, w = wz['idx'], wz['w']
for v in range(len(idx)):
    for k in range(4):
        if w[v, k] > 0:
            groups[idx[v, k]].add([v], float(w[v, k]), 'REPLACE')
if variant.NAME != 'walker':                         # canonical mesh -> this type's proportions
    co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co)
    co = variant.warp_points(co.reshape(-1, 3), idx, w, J0, BONES, PARENT, TAIL)
    me.vertices.foreach_set('co', co.astype(np.float32).ravel()); me.update()
ob.parent = arm
mod = ob.modifiers.new('Armature', 'ARMATURE'); mod.object = arm

mat = bpy.data.materials.new('Zombie'); mat.use_nodes = True
me.materials.clear(); me.materials.append(mat)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, 'rigged.blend'))

kw = dict(filepath=os.path.join(BUILD, 'zombie_raw.glb'), export_format='GLB', use_selection=False, export_yup=True, export_apply=False,
          export_texcoords=True, export_normals=True, export_tangents=True, export_materials='EXPORT', export_skins=True,
          export_all_influences=False, export_influence_nb=4, export_animations=False, export_morph=False, export_cameras=False,
          export_lights=False, export_extras=False, export_def_bones=False)
props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
kw = {k: v for k, v in kw.items() if k in props}
bpy.ops.export_scene.gltf(**kw)
print('RIG_EXPORT_DONE')
