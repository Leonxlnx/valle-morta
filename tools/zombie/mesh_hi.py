"""High resolution source mesh for decimation:  python mesh_hi.py [voxel_mm]"""
import sys, os, time
os.environ.setdefault('OMP_NUM_THREADS', '6')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import meshing, model
vox = (float(sys.argv[1]) if len(sys.argv) > 1 else 3.0) * 1e-3
t0 = time.time()
v, f = meshing.mesh_region(model.BOUNDS_LO, model.BOUNDS_HI, vox, min_faces=300)
np.savez(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build', 'hi.npz'), verts=v, faces=f)
print('hi mesh: %d verts %d tris, bbox %s %s, %.0fs' % (len(v), len(f), v.min(0).round(3), v.max(0).round(3), time.time() - t0))
