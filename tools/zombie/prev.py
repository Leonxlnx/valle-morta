"""Sculpt preview: mesh a region of the SDF at fine resolution, clay-render it with Blender, build a contact sheet.

  python prev.py head [--voxel 1.25] [--tag name] [--naked]
"""
import sys, os, json, subprocess, time, argparse
import numpy as np
os.environ.setdefault('OMP_NUM_THREADS', '6')
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from PIL import Image

BLENDER = r'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
BUILD = os.path.join(HERE, 'build'); PREV = os.path.join(HERE, '..', '_preview', 'zombie')

COLS = np.array([[0.60, 0.55, 0.50], [0.82, 0.82, 0.78], [0.78, 0.72, 0.55], [0.30, 0.09, 0.07], [0.13, 0.11, 0.09],
                 [0.42, 0.47, 0.52], [0.20, 0.20, 0.22], [0.11, 0.085, 0.07], [0.22, 0.13, 0.07]], np.float32)

HZ = 1.655
REGIONS = {
    'head': dict(lo=(-0.105, -0.14, 1.485), hi=(0.105, 0.115, 1.79), voxel=1.25, res=[400, 400], cols=2, views=[
        dict(name='front', loc=(0, -1.6, HZ), tgt=(0, 0, HZ), lens=235),
        dict(name='q3', loc=(1.0, -1.25, HZ + 0.05), tgt=(0, -0.01, HZ), lens=235),
        dict(name='side', loc=(1.6, 0, HZ), tgt=(0, -0.01, HZ), lens=235),
        dict(name='q3r', loc=(-0.9, -1.3, HZ - 0.25), tgt=(0, -0.01, HZ), lens=235)]),
    'face': dict(lo=(-0.075, -0.14, 1.54), hi=(0.075, -0.02, 1.72), voxel=0.8, res=[400, 480], cols=2, views=[
        dict(name='front', loc=(0, -1.2, HZ - 0.01), tgt=(0, 0, HZ - 0.022), lens=235),
        dict(name='q3', loc=(0.75, -0.95, HZ), tgt=(0, -0.05, HZ - 0.022), lens=235)]),
    'hand': dict(lo=(0.52, -0.16, 0.90), hi=(0.74, 0.02, 1.09), voxel=1.0, res=[400, 400], cols=2, views=[
        dict(name='back', loc=(1.35, -0.45, 1.75), tgt=(0.63, -0.065, 0.99), lens=110),
        dict(name='palm', loc=(-0.05, -0.55, 0.35), tgt=(0.63, -0.065, 0.99), lens=110)]),
    'body': dict(lo=(-0.76, -0.27, -0.005), hi=(0.76, 0.21, 1.80), voxel=3.0, res=[400, 620], cols=2, ground=0.0, views=[
        dict(name='front', loc=(0, -5.2, 1.05), tgt=(0, 0, 0.92), lens=80),
        dict(name='q3', loc=(3.2, -4.1, 1.3), tgt=(0, 0, 0.92), lens=80),
        dict(name='side', loc=(5.2, 0, 1.05), tgt=(0, 0, 0.92), lens=80),
        dict(name='back', loc=(-1.8, 4.9, 1.2), tgt=(0, 0, 0.92), lens=80)]),
    'torso': dict(lo=(-0.30, -0.22, 0.80), hi=(0.30, 0.20, 1.56), voxel=2.0, res=[400, 480], cols=2, views=[
        dict(name='front', loc=(0, -2.6, 1.25), tgt=(0, 0, 1.18), lens=75),
        dict(name='q3', loc=(-1.7, -2.0, 1.35), tgt=(0, 0, 1.18), lens=75)]),
    'legs': dict(lo=(-0.30, -0.27, -0.005), hi=(0.30, 0.20, 1.10), voxel=2.5, res=[400, 560], cols=2, ground=0.0, views=[
        dict(name='front', loc=(0, -3.6, 0.6), tgt=(0, 0, 0.52), lens=75),
        dict(name='q3', loc=(2.3, -2.7, 0.75), tgt=(0, 0, 0.52), lens=75)]),
}


def sheet(paths, cols, out, maxw=800):
    ims = [Image.open(p).convert('RGB') for p in paths]
    w, h = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    S = Image.new('RGB', (w * cols, h * rows), (20, 20, 20))
    for i, im in enumerate(ims):
        S.paste(im, ((i % cols) * w, (i // cols) * h))
    if S.width > maxw:
        S = S.resize((maxw, int(S.height * maxw / S.width)), Image.LANCZOS)
    S.save(out)


def run_blender(job, script='bl_render.py'):
    jp = os.path.join(BUILD, 'job_%s.json' % job.get('tag', 'x'))
    json.dump(job, open(jp, 'w'))
    r = subprocess.run([BLENDER, '-b', '-t', '6', '--python', os.path.join(HERE, script), '--', jp],
                       capture_output=True, text=True)
    if 'RENDER_DONE' not in r.stdout:
        print(r.stdout[-3000:]); print(r.stderr[-3000:]); raise SystemExit('blender failed')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('region'); ap.add_argument('--voxel', type=float); ap.add_argument('--tag')
    ap.add_argument('--naked', action='store_true'); ap.add_argument('--views'); ap.add_argument('--samples', type=int, default=32)
    a = ap.parse_args()
    import meshing, model
    R = REGIONS[a.region]; tag = a.tag or a.region
    vox = (a.voxel or R['voxel']) * 1e-3
    t0 = time.time()
    v, f = meshing.mesh_region(R['lo'], R['hi'], vox, naked=a.naked)
    _, mat = model.eval_chunked(v, margin=0.004, naked=a.naked)
    npz = os.path.join(BUILD, 'prev_%s.npz' % tag)
    np.savez(npz, verts=v, faces=f, col=COLS[mat])
    print('mesh %d verts %d tris  %.1fs' % (len(v), len(f), time.time() - t0))
    views = R['views']
    if a.views:
        views = [x for x in views if x['name'] in a.views.split(',')]
    out = os.path.join(BUILD, 'pv_%s_' % tag)
    run_blender(dict(tag=tag, mesh=npz, views=views, res=R['res'], samples=a.samples, out=out, ground=R.get('ground')))
    sp = os.path.join(PREV, 'sculpt_%s.png' % tag)
    sheet([out + x['name'] + '.png' for x in views], R['cols'], sp)
    print('sheet', sp, '%.1fs' % (time.time() - t0))
