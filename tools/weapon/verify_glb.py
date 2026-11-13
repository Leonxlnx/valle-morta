# Verify a view-model GLB against the asset contract (docs/DESIGN.md):  python verify_glb.py <path.glb> [...]
import json, struct, sys, os

NEED = {'rifle': ['Bolt', 'Magazine', 'Trigger', 'Selector'], 'pistol': ['Slide', 'Magazine', 'Trigger', 'Hammer'],
        'sniper': ['BoltHandle', 'Magazine', 'Trigger', 'BipodL', 'BipodR', 'Scope', 'ScopeEye']}
COMMON = ['Weapon', 'Arms', 'ArmsMesh', 'Muzzle', 'Eject', 'SightRear', 'SightFront', 'Casing']
CLIPS = {'rifle': dict(Idle=None, Fire=None, Reload=2.4, ReloadEmpty=3.0, Draw=0.45, Holster=0.3, Sprint=None),
         'pistol': dict(Idle=None, Fire=None, Reload=1.7, ReloadEmpty=2.1, Draw=0.3, Holster=0.3, Sprint=None),
         'sniper': dict(Idle=None, Fire=None, Reload=3.2, ReloadEmpty=None, Draw=0.45, Holster=0.3, Sprint=None, BoltCycle=1.1, BipodDeploy=None)}


def check(path):
    wid = os.path.basename(path).split('.')[0]; data = open(path, 'rb').read(); ok = True
    magic, ver, total = struct.unpack('<4sII', data[:12]); assert magic == b'glTF'
    clen, ctype = struct.unpack('<II', data[12:20]); js = json.loads(data[20:20 + clen]); nodes = js['nodes']; acc = js['accessors']
    names = [n.get('name') for n in nodes]; miss = [n for n in COMMON + NEED.get(wid, []) if n not in names]
    print('%s: %.2f MB (limit 12), %d nodes, missing nodes: %s' % (wid, len(data) / 1e6, len(nodes), miss or 'none')); ok &= not miss and len(data) < 12e6
    skinned = {i for i, n in enumerate(nodes) if 'skin' in n}; tw = ta = 0
    for i, n in enumerate(nodes):
        if 'mesh' in n:
            t = sum(acc[p['indices']]['count'] // 3 for p in js['meshes'][n['mesh']]['primitives'])
            if i in skinned: ta += t
            else: tw += t
    print('  triangles: weapon %d (limit 60000), arms %d (limit 20000)' % (tw, ta)); ok &= tw <= 60000 and ta <= 20000
    for s in js.get('skins', []): print('  skin: %d joints, e.g. %s' % (len(s['joints']), [nodes[j]['name'] for j in s['joints'][:4]]))
    par = {}
    for i, n in enumerate(nodes):
        for ch in n.get('children', []): par[ch] = i
    kids = lambda nm: sorted(nodes[c].get('name') for c in nodes[names.index(nm)].get('children', [])) if nm in names else []
    print('  Weapon children:', kids('Weapon'))
    for nm in ('Muzzle', 'SightRear', 'SightFront', 'Eject', 'ScopeEye'):
        if nm in names: print('  %-10s t=%s' % (nm, [round(v, 4) for v in nodes[names.index(nm)].get('translation', [0, 0, 0])]))
    if 'Hand_R' in names:
        def world(i):
            p = [0.0, 0.0, 0.0]
            while i is not None:
                n = nodes[i]; t = n.get('translation', [0, 0, 0]); q = n.get('rotation', [0, 0, 0, 1]); x, y, z, w = q
                v = p; u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]]; uu = [y * u[2] - z * u[1], z * u[0] - x * u[2], x * u[1] - y * u[0]]
                p = [v[k] + 2 * (w * u[k] + uu[k]) + t[k] for k in range(3)]; i = par.get(i)
            return [round(v, 3) for v in p]
        print('  default pose: Hand_R at', world(names.index('Hand_R')), 'Hand_L at', world(names.index('Hand_L')), '(glTF axes, should sit on the weapon)')
    want = CLIPS.get(wid, {}); got = {}
    for a in js.get('animations', []):
        dur = max(acc[s['input']]['max'][0] for s in a['samplers']); t0 = min(acc[s['input']]['min'][0] for s in a['samplers'])
        tg = {nodes[c['target']['node']]['name'] for c in a['channels']}; got[a['name']] = dur
        bad = want.get(a['name']) is not None and abs(dur - want[a['name']]) > 0.011
        print('  clip %-12s %.3f s (start %.3f) %4d channels, %2d nodes: weapon parts %s%s' % (a['name'], dur, t0, len(a['channels']), len(tg),
              sorted(t for t in tg if '_R' not in t and '_L' not in t), '  <-- LENGTH MISMATCH' if bad else '')); ok &= not bad
    mc = [c for c in want if c not in got]; print('  missing clips:', mc or 'none'); ok &= not mc
    for m in js.get('materials', []):
        pbr = m.get('pbrMetallicRoughness', {})
        print('  material', m['name'], 'base', 'baseColorTexture' in pbr, 'orm', 'metallicRoughnessTexture' in pbr, 'normal', 'normalTexture' in m, 'occlusion', 'occlusionTexture' in m)
    for i, im in enumerate(js.get('images', [])):
        bv = js['bufferViews'][im['bufferView']]; off = 20 + clen + 8 + bv.get('byteOffset', 0); blob = data[off:off + bv['byteLength']]; w = h = 0
        if im['mimeType'] == 'image/png': w, h = struct.unpack('>II', blob[16:24])
        else:
            j = 2
            while j < len(blob):
                mk, ln = struct.unpack('>HH', blob[j:j + 4])
                if mk in (0xFFC0, 0xFFC2): h, w = struct.unpack('>HH', blob[j + 5:j + 9]); break
                j += 2 + ln
        print('  image %d %-12s %s %dx%d %.2f MB' % (i, im.get('name'), im['mimeType'], w, h, bv['byteLength'] / 1e6)); ok &= max(w, h) <= 2048
    print('  RESULT', 'OK' if ok else 'PROBLEMS')
    return ok


if __name__ == '__main__':
    res = [check(p) for p in sys.argv[1:]]; sys.exit(0 if all(res) else 1)
