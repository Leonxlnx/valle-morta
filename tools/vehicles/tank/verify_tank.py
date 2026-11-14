# Check the tank GLBs: size, nodes, triangles, materials, texture sizes.   python verify_tank.py <glb> [...]
import json, struct, sys, os

NEED = {'tank': ['Tank', 'Hull', 'Turret', 'Gun', 'Barrel', 'Muzzle', 'Eye', 'Exhaust', 'DriverHatch', 'CommanderHatch', 'LoaderHatch', 'TrackL', 'TrackR', 'TrackLink',
                 'SprocketL', 'SprocketR', 'IdlerL', 'IdlerR'] + ['Wheel%s%d' % (s, i) for s in 'LR' for i in range(1, 6)],
        'tank_wreck': ['TankWreck', 'Hull', 'Turret', 'Gun', 'Barrel', 'TrackL', 'TrackThrown', 'FuelCellFallen']}


def check(path):
    data = open(path, 'rb').read(); clen = struct.unpack('<I', data[12:16])[0]; js = json.loads(data[20:20 + clen])
    nodes, acc, wid = js['nodes'], js['accessors'], os.path.basename(path).split('.')[0]
    names = [n.get('name') for n in nodes]; miss = [n for n in NEED.get(wid, []) if n not in names]
    tris = {}
    for n in nodes:
        if 'mesh' in n: tris[n['name']] = sum(acc[p['indices']]['count'] // 3 for p in js['meshes'][n['mesh']]['primitives'])
    tot = sum(v for k, v in tris.items() if k != 'TrackLink')
    print('%s: %.2f MB, %d nodes, missing %s, triangles %d (+%d link template)' % (wid, len(data) / 1e6, len(nodes), miss or 'none', tot, tris.get('TrackLink', 0)))
    top = sorted(tris.items(), key=lambda kv: -kv[1])[:6]; print('  biggest:', ', '.join('%s %d' % kv for kv in top))
    for m in js.get('materials', []):
        p = m.get('pbrMetallicRoughness', {})
        print('  material %s: base %s orm %s normal %s occlusion %s' % (m['name'], 'baseColorTexture' in p, 'metallicRoughnessTexture' in p, 'normalTexture' in m, 'occlusionTexture' in m))
    for im in js.get('images', []):
        bv = js['bufferViews'][im['bufferView']]; off = 20 + clen + 8 + bv.get('byteOffset', 0); b = data[off:off + bv['byteLength']]; w = h = 0
        if im['mimeType'] == 'image/png': w, h = struct.unpack('>II', b[16:24])
        else:
            j = 2
            while j < len(b):
                mk, ln = struct.unpack('>HH', b[j:j + 4])
                if mk in (0xFFC0, 0xFFC2): h, w = struct.unpack('>HH', b[j + 5:j + 9]); break
                j += 2 + ln
        print('  image %-28s %dx%d %.2f MB' % (im.get('name'), w, h, len(b) / 1e6))
    ex = nodes[names.index(NEED[wid][0])].get('extras', {}) if wid in NEED and NEED[wid][0] in names else {}
    if ex: print('  extras: links %s, path points %d, track_z %s, len %s' % (ex.get('track_links'), len(ex.get('track_path', [])) // 2, ex.get('track_z'), ex.get('track_len')))
    return not miss


ok = all([check(p) for p in sys.argv[1:] if os.path.exists(p)])
print('VERIFY', 'OK' if ok else 'FAILED')
