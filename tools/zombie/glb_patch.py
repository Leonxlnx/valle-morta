"""Final assembly: embed textures + material + the 8 animation clips into the skinned GLB, then verify it.

  python glb_patch.py           build/zombie_raw.glb + build/tex + build/anim.npz -> public/assets/models/zombie.glb
  python glb_patch.py --verify  only parse and report the final file
"""
import os, sys, json, struct, shutil
import numpy as np
from scipy.spatial.transform import Rotation as Rot
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
BUILD = os.path.join(HERE, 'build'); TEX = os.path.join(BUILD, 'tex')
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', '..', 'public', 'assets', 'models'))
OUT = os.path.join(OUT_DIR, 'zombie.glb')
REQ_BONES = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'Jaw', 'Shoulder.L', 'UpperArm.L', 'LowerArm.L', 'Hand.L', 'Shoulder.R', 'UpperArm.R',
             'LowerArm.R', 'Hand.R', 'UpperLeg.L', 'LowerLeg.L', 'Foot.L', 'Toe.L', 'UpperLeg.R', 'LowerLeg.R', 'Foot.R', 'Toe.R']
REQ_CLIPS = ['Idle', 'Walk', 'Run', 'Attack', 'HitBody', 'HitHead', 'DeathBack', 'DeathFront']


def read_glb(path):
    d = open(path, 'rb').read()
    assert d[:4] == b'glTF'
    jl = struct.unpack_from('<I', d, 12)[0]
    js = json.loads(d[20:20 + jl].decode('utf8'))
    o = 20 + jl
    bl = struct.unpack_from('<I', d, o)[0]
    return js, bytearray(d[o + 8:o + 8 + bl])


def write_glb(path, js, bn):
    j = json.dumps(js, separators=(',', ':')).encode('utf8'); j += b' ' * ((4 - len(j) % 4) % 4)
    bn = bytes(bn) + b'\0' * ((4 - len(bn) % 4) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(j) + 8 + len(bn)))
        f.write(struct.pack('<I4s', len(j), b'JSON')); f.write(j)
        f.write(struct.pack('<I4s', len(bn), b'BIN\0')); f.write(bn)


def add_view(js, bn, data):
    while len(bn) % 4:
        bn.append(0)
    js['bufferViews'].append({'buffer': 0, 'byteOffset': len(bn), 'byteLength': len(data)})
    bn.extend(data)
    return len(js['bufferViews']) - 1


def add_acc(js, bn, arr, typ, minmax=False):
    arr = np.ascontiguousarray(arr, np.float32)
    a = {'bufferView': add_view(js, bn, arr.tobytes()), 'componentType': 5126, 'count': len(arr), 'type': typ}
    if minmax:
        a['min'] = [float(arr.min())]; a['max'] = [float(arr.max())]
    js['accessors'].append(a)
    return len(js['accessors']) - 1


def patch():
    js, bn = read_glb(os.path.join(BUILD, 'zombie_raw.glb'))
    names = {nd.get('name'): i for i, nd in enumerate(js['nodes'])}
    # ---- textures / material
    npng = os.path.join(TEX, 'normal.png'); njpg = os.path.join(TEX, 'normal.jpg')
    nfile, nmime = (npng, 'image/png') if os.path.getsize(npng) < 4.5e6 else (njpg, 'image/jpeg')
    js['images'] = []; js['textures'] = []
    js['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    for nm, fp, mime in (('zombie_albedo', os.path.join(TEX, 'albedo_a.jpg'), 'image/jpeg'), ('zombie_normal', nfile, nmime),
                         ('zombie_orm', os.path.join(TEX, 'orm.jpg'), 'image/jpeg')):
        js['images'].append({'name': nm, 'mimeType': mime, 'bufferView': add_view(js, bn, open(fp, 'rb').read())})
        js['textures'].append({'sampler': 0, 'source': len(js['images']) - 1})
    js['materials'] = [{'name': 'Zombie', 'doubleSided': False,
                        'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicRoughnessTexture': {'index': 2},
                                                 'metallicFactor': 1.0, 'roughnessFactor': 1.0},
                        'normalTexture': {'index': 1, 'scale': 1.0}, 'occlusionTexture': {'index': 2, 'strength': 1.0}}]
    for m in js['meshes']:
        for p in m['primitives']:
            p['material'] = 0
    # ---- animations
    an = np.load(os.path.join(BUILD, 'anim.npz'))
    bones = [str(b) for b in an['bones']]
    blender_axes = abs(js['nodes'][names['Hips']].get('translation', [0, 0, 0])[2]) > 0.5      # exporter kept z-up?
    def conv_v(v):
        v = np.asarray(v, float)
        return v if blender_axes else np.stack([v[..., 0], v[..., 2], -v[..., 1]], -1)
    def conv_q(q):
        q = np.asarray(q, float)
        return q if blender_axes else np.stack([q[..., 0], q[..., 2], -q[..., 1], q[..., 3]], -1)
    parent = {}
    for i, nd in enumerate(js['nodes']):
        for c in nd.get('children', []):
            parent[c] = i
    rest_q = {b: Rot.from_quat(js['nodes'][names[b]].get('rotation', [0, 0, 0, 1])) for b in bones}
    Bw = {}
    for b in bones:                                   # armature-space rest orientation
        pn = js['nodes'][parent[names[b]]].get('name')
        Bw[b] = (Bw[pn] * rest_q[b]) if pn in Bw else rest_q[b]
    js['animations'] = []
    for cname, dur in zip(an['names'], an['durations']):
        cname = str(cname); pos = an[cname + '_pos']; rot = an[cname + '_rot']; nf = len(pos)
        ti = add_acc(js, bn, np.arange(nf) / 30.0, 'SCALAR', True)
        A = {'name': cname, 'samplers': [], 'channels': []}
        A['samplers'].append({'input': ti, 'output': add_acc(js, bn, conv_v(pos), 'VEC3'), 'interpolation': 'LINEAR'})
        A['channels'].append({'sampler': 0, 'target': {'node': names['Hips'], 'path': 'translation'}})
        for bi, b in enumerate(bones):
            rc = Rot.from_quat(conv_q(rot[:, bi]))
            q = (rest_q[b] * (Bw[b].inv() * rc * Bw[b])).as_quat()
            for f in range(1, nf):
                if (q[f] * q[f - 1]).sum() < 0:
                    q[f] *= -1
            A['samplers'].append({'input': ti, 'output': add_acc(js, bn, q, 'VEC4'), 'interpolation': 'LINEAR'})
            A['channels'].append({'sampler': len(A['samplers']) - 1, 'target': {'node': names[b], 'path': 'rotation'}})
        js['animations'].append(A)
    js['buffers'] = [{'byteLength': len(bn) + (4 - len(bn) % 4) % 4}]
    js['asset']['generator'] = 'Valle Morta zombie pipeline (tools/zombie)'
    os.makedirs(OUT_DIR, exist_ok=True)
    write_glb(OUT, js, bn)
    shutil.copyfile(os.path.join(TEX, 'albedo_b.jpg'), os.path.join(OUT_DIR, 'zombie_col_b.jpg'))
    shutil.copyfile(os.path.join(TEX, 'albedo_c.jpg'), os.path.join(OUT_DIR, 'zombie_col_c.jpg'))


def acc_data(js, bn, i):
    a = js['accessors'][i]; bv = js['bufferViews'][a['bufferView']]
    comp = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[a['componentType']]
    k = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return np.frombuffer(bytes(bn[off:off + a['count'] * k * np.dtype(comp).itemsize]), comp).reshape(a['count'], k)


def verify():
    js, bn = read_glb(OUT)
    ok = True
    prims = [p for m in js['meshes'] for p in m['primitives']]
    tris = sum(js['accessors'][p['indices']]['count'] // 3 for p in prims)
    pa = js['accessors'][prims[0]['attributes']['POSITION']]
    joints = [js['nodes'][j]['name'] for j in js['skins'][0]['joints']]
    print('file: %s  %.2f MB' % (OUT, os.path.getsize(OUT) / 1e6))
    print('meshes %d, primitives %d, triangles %d, vertices %d, attributes %s' % (len(js['meshes']), len(prims), tris, pa['count'], sorted(prims[0]['attributes'])))
    print('bbox min %s max %s (Y-up, metres)' % (np.round(pa['min'], 3).tolist(), np.round(pa['max'], 3).tolist()))
    print('bones (%d): %s' % (len(joints), ', '.join(joints)))
    miss = [b for b in REQ_BONES if b not in joints]; extra = [b for b in joints if b not in REQ_BONES]
    print('missing bones:', miss, 'extra:', extra); ok &= not miss
    w = acc_data(js, bn, prims[0]['attributes']['WEIGHTS_0'])
    print('max influences per vertex: %d' % int((w > 0).sum(1).max()))
    for a in js.get('animations', []):
        t = acc_data(js, bn, a['samplers'][0]['input'])
        print('clip %-10s %.3f s  %d frames  %d channels' % (a['name'], float(t.max()), len(t), len(a['channels'])))
    cl = [a['name'] for a in js.get('animations', [])]
    ok &= cl == REQ_CLIPS
    print('images:', [(im['name'], im['mimeType'], js['bufferViews'][im['bufferView']]['byteLength'] // 1024) for im in js.get('images', [])], 'kB')
    print('material:', json.dumps(js['materials'][0])[:300])
    # numeric FK check of the exported clips against the authoring rig
    import anim as A
    names = {nd.get('name'): i for i, nd in enumerate(js['nodes'])}
    parent = {c: i for i, nd in enumerate(js['nodes']) for c in nd.get('children', [])}
    worst = 0.0
    for a in js['animations']:
        ch = {(js['nodes'][c['target']['node']]['name'], c['target']['path']): acc_data(js, bn, a['samplers'][c['sampler']]['output']) for c in a['channels']}
        fn = dict((c[0], c[1]) for c in A.CLIPS)[a['name']]
        nf = len(ch[('Hips', 'translation')])
        for f in sorted(set([0, nf // 3, nf // 2, nf - 2])):
            Pw = {}; Rw = {}
            for b in joints:
                pn = js['nodes'][parent[names[b]]].get('name')
                r = Rot.from_quat(ch[(b, 'rotation')][f]); tr = np.array(ch[(b, 'translation')][f] if (b, 'translation') in ch else js['nodes'][names[b]].get('translation', [0, 0, 0]), float)
                if pn in Rw:
                    Pw[b] = Pw[pn] + Rw[pn].apply(tr); Rw[b] = Rw[pn] * r
                else:
                    Pw[b] = tr; Rw[b] = r
            pos, L = fn(f / 30.0); P, _ = A.fk(pos, L)
            for i, b in enumerate(A.BONES):
                ref = np.array([P[i][0], P[i][2], -P[i][1]])
                worst = max(worst, float(np.linalg.norm(Pw[b] - ref)))
    print('animation FK check: worst joint position error %.5f m' % worst); ok &= worst < 2e-3
    print('VERIFY', 'OK' if ok else 'FAILED')


if __name__ == '__main__':
    if '--verify' not in sys.argv:
        patch()
    verify()
