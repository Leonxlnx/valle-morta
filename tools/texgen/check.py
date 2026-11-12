"""Verify the generated library: every expected file exists with the right
dimensions, albedo stays in a plausible range, and the tiles are seamless.

Seam test: the mean absolute difference across the wrap-around line (last vs
first row / column) must not exceed that of the most discontinuous ordinary
row / column line inside the image (ratio <= ~1).
"""
import os
import sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from texgen.registry import MATERIALS  # noqa: E402

TEX = os.path.abspath(os.path.join(HERE, "..", "..", "public", "assets", "tex"))


def seam_ratio(a):
    """Discontinuity of the wrap-around line relative to the most
    discontinuous line inside the image (per axis). <= ~1 means the seam is
    no more visible than ordinary structure (joints, JPEG block edges)."""
    a = a.astype(np.float32)
    if a.ndim == 2:
        a = a[..., None]
    lx = np.abs(a[:, 1:] - a[:, :-1]).mean((0, 2))
    ly = np.abs(a[1:] - a[:-1]).mean((1, 2))
    wrap_x = np.abs(a[:, 0] - a[:, -1]).mean()
    wrap_y = np.abs(a[0] - a[-1]).mean()
    return wrap_x / (lx.max() + 1e-6), wrap_y / (ly.max() + 1e-6)


def main():
    bad = 0
    total = 0
    print("%-18s %5s  %-22s %-14s %s" % ("material", "px", "seam ratio col/nrm/arh", "albedo p1..p99", "MB"))
    for name, (tile, res, seed) in MATERIALS.items():
        files = ["_col.jpg", "_nrm.jpg", "_arh.jpg"] + (["_mask.jpg"] if name == "rust_metal" else [])
        worst = 0.0
        size = 0
        rng = ""
        ok = True
        for suf in files:
            p = os.path.join(TEX, name + suf)
            if not os.path.exists(p):
                print("MISSING", p)
                ok = False
                continue
            size += os.path.getsize(p)
            im = Image.open(p)
            if im.size != (res, res):
                print("BAD SIZE", p, im.size)
                ok = False
            a = np.asarray(im)
            worst = max(worst, *seam_ratio(a))
            if suf == "_col.jpg":
                lo, hi = np.percentile(a[::4, ::4], [1, 99])
                rng = "%3d..%3d" % (lo, hi)
        total += size
        flag = "" if (ok and worst < 1.15) else "  <-- CHECK"
        bad += bool(flag)
        print("%-18s %5d  %-22s %-14s %.1f%s" % (name, res, "%.2f" % worst, rng, size / 1e6, flag))
    print("total %.1f MB, %d problem(s)" % (total / 1e6, bad))
    return bad


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
