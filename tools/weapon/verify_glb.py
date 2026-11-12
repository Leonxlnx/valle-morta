# Verify rifle.glb against the asset contract: python verify_glb.py [path]
import json, struct, sys, os

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'assets', 'models', 'rifle.glb')
data = open(path, 'rb').read()
magic, ver, total = struct.unpack('<4sII', data[:12]); assert magic == b'glTF'
clen, ctype = struct.unpack('<II', data[12:20]); js = json.loads(data[20:20 + clen])
nodes = js['nodes']; names = [n.get('name') for n in nodes]
need = ['Rifle', 'Bolt', 'Magazine', 'Trigger', 'HandR', 'HandL', 'Muzzle', 'Eject', 'SightRear', 'SightFront', 'GripL', 'MagGrip', 'BoltGrip']
print('file %.2f MB, glTF v%d' % (len(data) / 1e6, ver))
print('nodes:', names)
print('missing:', [n for n in need if n not in names])
acc = js['accessors']; tot = 0; lo = [1e9] * 3; hi = [-1e9] * 3
for n in nodes:
    t = n.get('translation', [0, 0, 0]); r = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
    ident = all(abs(a - b) < 1e-5 for a, b in zip(r, [0, 0, 0, 1])) and all(abs(a - 1) < 1e-5 for a in s)
    line = '  %-10s t=(%.4f, %.4f, %.4f)%s' % (n.get('name'), t[0], t[1], t[2], '' if ident else '  NON-IDENTITY rot/scale %s %s' % (r, s))
    if 'mesh' in n:
        tr = 0
        for p in js['meshes'][n['mesh']]['primitives']:
            tr += acc[p['indices']]['count'] // 3; a = acc[p['attributes']['POSITION']]
            for k in range(3): lo[k] = min(lo[k], a['min'][k] + t[k]); hi[k] = max(hi[k], a['max'][k] + t[k])
            line += ' attrs=%s mat=%s' % (sorted(p['attributes']), js['materials'][p['material']]['name'])
        tot += tr; line += ' tris=%d' % tr
    print(line)
print('total triangles', tot)
print('bbox min', [round(v, 4) for v in lo], 'max', [round(v, 4) for v in hi], 'length(z) %.3f m' % (hi[2] - lo[2]))
for m in js['materials']:
    pbr = m.get('pbrMetallicRoughness', {})
    print('material', m['name'], 'base', 'baseColorTexture' in pbr, 'orm', 'metallicRoughnessTexture' in pbr, 'normal', 'normalTexture' in m, 'occlusion', 'occlusionTexture' in m, 'doubleSided', m.get('doubleSided', False))
for i, im in enumerate(js.get('images', [])):
    bv = js['bufferViews'][im['bufferView']]; off = 20 + clen + 8 + bv.get('byteOffset', 0); blob = data[off:off + bv['byteLength']]
    w = h = 0
    if im['mimeType'] == 'image/png': w, h = struct.unpack('>II', blob[16:24])
    else:
        j = 2
        while j < len(blob):
            mk, ln = struct.unpack('>HH', blob[j:j + 4])
            if mk in (0xFFC0, 0xFFC2): h, w = struct.unpack('>HH', blob[j + 5:j + 9]); break
            j += 2 + ln
    print('image', i, im.get('name'), im['mimeType'], '%dx%d' % (w, h), '%.2f MB' % (bv['byteLength'] / 1e6))
sr = next(n for n in nodes if n.get('name') == 'SightRear')['translation']; sf = next(n for n in nodes if n.get('name') == 'SightFront')['translation']
print('sight line dx=%.5f dy=%.5f (must be 0), radius %.3f m' % (sf[0] - sr[0], sf[1] - sr[1], sr[2] - sf[2]))
