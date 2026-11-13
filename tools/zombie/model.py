"""Full character field: combines skin / eyes / teeth / hair / clothing into (distance, material id)."""
import numpy as np
from sdf import *
import body, extras

try:
    import cloth
except ImportError:           # sculpt-only previews before clothing exists
    cloth = None

MATS = ['skin', 'eye', 'teeth', 'flesh', 'hair', 'shirt', 'trousers', 'boots', 'belt', 'apron', 'rope']
MAT = {n: i for i, n in enumerate(MATS)}

BOUNDS_LO = np.array([-0.76, -0.27, -0.005]); BOUNDS_HI = np.array([0.76, 0.21, 1.80])


def eval_model(P, margin=0.01, detail=False, want_mat=True, naked=False):
    """P (N,3) float32 -> (d, mat).  detail=True adds micro displacement (for baking only)."""
    P = np.ascontiguousarray(P, F)
    sp = body.skin_parts(P, margin)
    d_skin = extras.skin_extra(P, body.skin_union(sp), margin)
    if hasattr(body, 'skin_post'):
        d_skin = body.skin_post(P, d_skin, sp, margin, detail)
    stack = [d_skin, sp['eye'], sp['teeth']]
    ids = [MAT['skin'], MAT['eye'], MAT['teeth']]
    if hasattr(body, 'hair_field'):
        stack.append(body.hair_field(P, sp, margin, detail)); ids.append(MAT['hair'])
    if cloth is not None and not naked:
        for name, dd in cloth.eval_cloth(P, sp, d_skin, margin, detail):
            stack.append(dd); ids.append(MAT[name])
    S = np.stack(stack, 0)
    d = S.min(0)
    if not want_mat:
        return d, None
    mat = np.asarray(ids, np.uint8)[S.argmin(0)]
    if hasattr(body, 'flesh_mask'):
        fm = body.flesh_mask(P, sp)
        mat = np.where((mat == MAT['skin']) & (fm > 0.5), MAT['flesh'], mat).astype(np.uint8)
    return d, mat


def eval_chunked(P, chunk=60000, **kw):
    """Evaluate on an arbitrary point cloud in spatially coherent chunks (P should be roughly sorted)."""
    d = np.empty(len(P), F); m = np.empty(len(P), np.uint8)
    for i in range(0, len(P), chunk):
        dd, mm_ = eval_model(P[i:i + chunk], **kw)
        d[i:i + chunk] = dd
        if mm_ is not None:
            m[i:i + chunk] = mm_
    return d, m
