"""Preview / final renders of the finished GLB.   python shots.py body|detail|animA|animB [--final] [--samples N]"""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from prev import run_blender, sheet, BUILD, PREV
GLB = os.path.abspath(os.path.join(HERE, '..', '..', 'public', 'assets', 'models', 'zombie.glb'))
IDLE = dict(clip='Idle', t=0.0, dur=3.0)
DUR = dict(Idle=3.0, Walk=1.5, Run=0.7, Attack=0.9, HitBody=0.4, HitHead=0.4, DeathBack=2.2, DeathFront=2.4)
HZ = 1.60


def cam(name, loc, tgt, lens, **kw):
    d = dict(name=name, loc=loc, tgt=tgt, lens=lens); d.update(kw); return d


SETS = {
    'body': dict(res=[300, 600], cols=3, views=[
        cam('front', (0.25, -4.6, 1.15), (0, 0, 0.90), 78, **IDLE), cam('q3', (2.9, -3.6, 1.3), (0, 0, 0.90), 78, **IDLE),
        cam('backq', (-2.6, 3.9, 1.3), (0, 0, 0.90), 78, **IDLE)]),
    'detail': dict(res=[440, 420], cols=2, views=[
        cam('face', (0.10, -1.25, HZ + 0.02), (0.02, -0.05, HZ - 0.01), 150, **IDLE), cam('faceq', (0.80, -0.95, HZ + 0.05), (0.02, -0.05, HZ - 0.01), 150, **IDLE),
        cam('torso', (-0.9, -1.9, 1.35), (-0.03, -0.05, 1.20), 70, **IDLE), cam('hand', (-0.95, -1.15, 1.05), (-0.36, -0.12, 0.83), 120, **IDLE)]),
    'animA': dict(res=[220, 220], cols=4, views=[
        cam('%s%d' % (c, i), (3.6, -3.4, 1.25), (0, -0.05, 0.92), 60, clip=c, t=DUR[c] * f, dur=DUR[c])
        for c in ('Idle', 'Walk', 'Run', 'Attack') for i, f in enumerate((0.1, 0.35, 0.6, 0.85))]),
    'animB': dict(res=[220, 220], cols=4, views=[
        cam('%s%d' % (c, i), (3.9, -3.9, 1.5), (0, 0.0, 0.75), 55, clip=c, t=DUR[c] * f, dur=DUR[c])
        for c, fr in (('HitBody', (0.15, 0.3, 0.55, 0.8)), ('HitHead', (0.15, 0.3, 0.55, 0.8)), ('DeathBack', (0.15, 0.3, 0.45, 1.0)), ('DeathFront', (0.2, 0.4, 0.58, 1.0)))
        for i, f in enumerate(fr)]),
}

if __name__ == '__main__':
    name = sys.argv[1]; final = '--final' in sys.argv
    S = SETS[name]
    samples = int(sys.argv[sys.argv.index('--samples') + 1]) if '--samples' in sys.argv else (64 if final else 28)
    out = os.path.join(BUILD, 'shot_%s_' % name)
    job = dict(tag='shot_' + name, glb=GLB, views=S['views'], res=S['res'], samples=samples, out=out, ground=0.0, sky=0.55, sun=1.3)
    run_blender(job)
    dst = os.path.join(PREV, ('final_%s.png' if final else 'look_%s.png') % name)
    sheet([out + v['name'] + '.png' for v in S['views']], S['cols'], dst, maxw=900)
    print('sheet', dst)
