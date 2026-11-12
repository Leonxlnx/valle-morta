"""Regenerate the whole Valle Morta texture library (deterministic).

    python tools/texgen/build_all.py                 # everything, full res
    python tools/texgen/build_all.py --only moss,roof_tiles
    python tools/texgen/build_all.py --only moss --scale 0.5 --out tools/_preview/tex/dev --preview
"""
import os
import sys
import json
import time
import argparse
import importlib

os.environ.setdefault("OMP_NUM_THREADS", "5")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "5")
os.environ.setdefault("MKL_NUM_THREADS", "5")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.dirname(HERE))

from texgen import core  # noqa: E402

from texgen.registry import MATERIALS  # noqa: E402


def build_one(name, out_dir, scale=1.0):
    tile, res, seed = MATERIALS[name]
    n = int(res * scale)
    mod = importlib.import_module("texgen.mat_" + name)
    c = core.Ctx(name, n, tile, seed)
    out = mod.build(c)
    opts = out.get("opts", {})
    meta = core.finalize(c, out, out_dir, **opts)
    meta["full_size"] = res
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--scale", type=float, default=1.0, help="resolution scale for fast iteration (0.5)")
    ap.add_argument("--out", default=os.path.join(ROOT, "public", "assets", "tex"))
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args()
    names = [s for s in a.only.split(",") if s] or list(MATERIALS)
    out_dir = os.path.abspath(a.out)
    os.makedirs(out_dir, exist_ok=True)
    mp = os.path.join(out_dir, "materials.json")
    meta = json.load(open(mp)) if os.path.exists(mp) else {}
    for nm in names:
        if nm not in MATERIALS:
            print("unknown material", nm)
            continue
        t = time.time()
        meta[nm] = build_one(nm, out_dir, a.scale)
        json.dump(meta, open(mp, "w"), indent=1, sort_keys=True)
        msg = "%-18s %5d px  relief %.1f mm  %.1fs" % (nm, meta[nm]["size"], meta[nm]["relief_m"] * 1000, time.time() - t)
        if a.preview:
            from texgen import preview
            preview.render(nm, out_dir)
        print(msg, flush=True)


if __name__ == "__main__":
    main()
