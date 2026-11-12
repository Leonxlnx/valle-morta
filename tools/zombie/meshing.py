"""Grid evaluation + chunked marching cubes (keeps peak memory small)."""
import numpy as np
from skimage.measure import marching_cubes
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from sdf import F, BIG
import model


def grid_eval(lo, hi, voxel, block=48, **kw):
    lo = np.asarray(lo, float); hi = np.asarray(hi, float)
    n = np.ceil((hi - lo) / voxel).astype(int) + 1
    ax = [lo[i] + voxel * np.arange(n[i]) for i in range(3)]
    vol = np.full(tuple(n), BIG, F)
    for bx in range(0, n[0], block):
        for by in range(0, n[1], block):
            for bz in range(0, n[2], block):
                X, Y, Z = np.meshgrid(ax[0][bx:bx + block], ax[1][by:by + block], ax[2][bz:bz + block], indexing='ij')
                P = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1).astype(F)
                d, _ = model.eval_model(P, margin=voxel * 2, want_mat=False, **kw)
                vol[bx:bx + block, by:by + block, bz:bz + block] = d.reshape(X.shape)
    return vol, ax


def fill_cavities(vol):
    """Voxels that are 'outside' but not connected to the exterior become solid."""
    lab, _ = ndimage.label(vol > 0)
    outside = lab[0, 0, -1]
    bad = (vol > 0) & (lab != outside)
    vol[bad] = -1e-3
    return int(bad.sum())


def extract(vol, lo, voxel, slab=128):
    """Marching cubes in z-slabs, welded."""
    V = []; Fc = []; off = 0
    nz = vol.shape[2]
    for z0 in range(0, nz - 1, slab):
        z1 = min(z0 + slab + 1, nz)
        sub = vol[:, :, z0:z1]
        if not ((sub.min() < 0) and (sub.max() > 0)):
            continue
        v, f, _, _ = marching_cubes(sub, level=0.0, spacing=(voxel,) * 3, gradient_direction='ascent',
                                    allow_degenerate=False)
        v[:, 2] += z0 * voxel
        V.append(v); Fc.append(f + off); off += len(v)
    v = np.concatenate(V) + np.asarray(lo, float)
    f = np.concatenate(Fc)
    key = np.round((v - np.asarray(lo, float)) / (voxel * 1e-3)).astype(np.int64)
    key = key[:, 0] * 4000003 * 4000037 + key[:, 1] * 4000037 + key[:, 2]
    _, first, inv = np.unique(key, return_index=True, return_inverse=True)
    v = v[first]; f = inv[f]
    f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
    return v.astype(np.float32), f.astype(np.int32)


def drop_small(v, f, min_faces=400):
    n = len(v)
    g = coo_matrix((np.ones(len(f) * 2), (np.r_[f[:, 0], f[:, 1]], np.r_[f[:, 1], f[:, 2]])), shape=(n, n))
    nc, lab = connected_components(g, directed=False)
    cnt = np.bincount(lab[f[:, 0]], minlength=nc)
    keep = cnt[lab[f[:, 0]]] >= min_faces
    f = f[keep]
    used = np.zeros(n, bool); used[f.ravel()] = True
    remap = np.cumsum(used) - 1
    return v[used], remap[f].astype(np.int32)


def mesh_region(lo, hi, voxel, fill=True, min_faces=400, **kw):
    vol, ax = grid_eval(lo, hi, voxel, **kw)
    if fill:
        fill_cavities(vol)
    v, f = extract(vol, [a[0] for a in ax], voxel)
    del vol
    v, f = drop_small(v, f, min_faces)
    # make sure the winding is outward (positive signed volume)
    a_, b_, c_ = v[f[:, 0]].astype(np.float64), v[f[:, 1]].astype(np.float64), v[f[:, 2]].astype(np.float64)
    if (a_ * np.cross(b_, c_)).sum() < 0:
        f = np.ascontiguousarray(f[:, ::-1])
    return v, f
