"""Numpy preview renderer for generated materials.

Shades the material on a flat plane (low-angle sun + sky ambient + GGX
specular + height-field shadows, filmic tonemap) and writes a ~900 px PNG:
  top-left  : lit 2x2 tiling (checks seams / repetition / distance read)
  top-right : raw albedo of one tile (checks for baked lighting, value range)
  bottom    : lit 1:1 crop
Usage: python -m texgen.preview name [--src dir] [--channels]
"""
import os
import sys
import json
import argparse
import numpy as np
from PIL import Image

F = np.float32
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
TEX_DIR = os.path.join(ROOT, "public", "assets", "tex")
PREV_DIR = os.path.join(ROOT, "tools", "_preview", "tex")


def _load(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=F) / 255.0


def _tonemap(x):
    x = x * 0.6
    y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)
    return np.clip(y, 0, 1) ** (1 / 2.2)


def shade(col, nrm, ao, rough, h01, relief_m, px_m, sun_elev=32.0, sun_az=135.0):
    alb = col ** 2.2
    N = nrm * 2.0 - 1.0
    N /= np.linalg.norm(N, axis=-1, keepdims=True) + 1e-6
    el = np.radians(sun_elev)
    az = np.radians(sun_az)          # 135 deg = light from the upper-left
    L = np.array([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)], F)
    V = np.array([0.0, -0.45, 0.89], F)
    V /= np.linalg.norm(V)
    Hh = (L + V) / np.linalg.norm(L + V)
    ndl = np.clip(N @ L, 0, 1)
    ndv = np.clip(N @ V, 1e-3, 1)
    ndh = np.clip(N @ Hh, 0, 1)
    # height-field shadow march towards the light
    h = h01 * relief_m
    dx, dy = L[0], -L[1]            # image space (y down)
    nh = np.hypot(dx, dy)
    dx, dy = dx / nh, dy / nh
    tan_e = np.tan(el)
    smax = max(2.0, relief_m / tan_e / px_m)
    steps = np.unique(np.round(np.geomspace(1, smax, 14)).astype(int))
    occ = np.zeros_like(h)
    for s in steps:
        ox, oy = int(round(dx * s)), int(round(dy * s))
        d = np.roll(h, (-oy, -ox), (0, 1)) - h - np.hypot(ox, oy) * px_m * tan_e
        np.maximum(occ, d, out=occ)
    shadow = 1.0 - np.clip(occ / (relief_m * 0.03 + 1e-6), 0, 1) * 0.9
    a = np.clip(rough, 0.05, 1.0) ** 2
    a2 = a * a
    D = a2 / (np.pi * ((ndh * ndh) * (a2 - 1) + 1) ** 2)
    k = (rough + 1) ** 2 / 8
    G = (ndl / (ndl * (1 - k) + k)) * (ndv / (ndv * (1 - k) + k))
    spec = 0.04 * D * G / (4 * ndv * np.maximum(ndl, 1e-3))
    sun = np.array([1.0, 0.93, 0.82], F) * 3.0
    sky = np.array([0.55, 0.62, 0.72], F) * 0.75
    hemi = 0.65 + 0.35 * N[..., 2]
    direct = (ndl * shadow)[..., None] * sun
    amb = (ao * hemi)[..., None] * sky
    lit = alb * (direct / np.pi * 2.2 + amb) + (spec * ndl * shadow)[..., None] * sun
    lit += (0.04 * (1 - rough) ** 2 * ao)[..., None] * sky * 0.6
    return _tonemap(lit)


def render(name, src=TEX_DIR, out=None, channels=False):
    meta = {}
    mp = os.path.join(src, "materials.json")
    if os.path.exists(mp):
        meta = json.load(open(mp)).get(name, {})
    col = _load(os.path.join(src, name + "_col.jpg"))
    nrm = _load(os.path.join(src, name + "_nrm.jpg"))
    arh = _load(os.path.join(src, name + "_arh.jpg"))
    n = col.shape[0]
    tile_m = meta.get("tile_m", 4.0)
    relief = meta.get("relief_m", 0.03)
    lit = shade(col, nrm, arh[..., 0], arh[..., 1], arh[..., 2], relief, tile_m / n)
    lit8 = (lit * 255 + 0.5).astype(np.uint8)
    W = 900
    half = W // 2
    canvas = Image.new("RGB", (W, W), (0, 0, 0))
    t2 = np.tile(lit8, (2, 2, 1))
    canvas.paste(Image.fromarray(t2).resize((half, half), Image.LANCZOS), (0, 0))
    canvas.paste(Image.fromarray((col * 255 + 0.5).astype(np.uint8)).resize((half, half), Image.LANCZOS), (half, 0))
    reps = int(np.ceil(W / n)) + 1
    big = np.tile(lit8, (reps, reps, 1))
    o = n // 3
    canvas.paste(Image.fromarray(big[o:o + half, o:o + W]), (0, half))
    out = out or os.path.join(PREV_DIR, name + ".png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    canvas.save(out)
    if channels:
        q = W // 4
        ch = Image.new("RGB", (W, q), (0, 0, 0))
        for i, a in enumerate([nrm, arh[..., 0], arh[..., 1], arh[..., 2]]):
            a8 = (np.clip(a, 0, 1) * 255).astype(np.uint8)
            ch.paste(Image.fromarray(a8).convert("RGB").resize((q, q), Image.LANCZOS), (i * q, 0))
        ch.save(out.replace(".png", "_ch.png"))
    return out


def sheet(names, src=TEX_DIR, out=None, reuse=False):
    """Contact sheet: up to 4 materials in a 900x900 image. Each cell shows a
    2x2 tiling thumb, the raw albedo, a far (4x4 tiling) thumb and a 1:1 crop."""
    canvas = Image.new("RGB", (900, 900), (0, 0, 0))
    for i, nm in enumerate(names[:4]):
        p = os.path.join(PREV_DIR, nm + ".png")
        if not (reuse and os.path.exists(p)):
            p = render(nm, src, p)
        im = Image.open(p)
        ox, oy = (i % 2) * 450, (i // 2) * 450
        canvas.paste(im.crop((0, 0, 450, 450)).resize((150, 150), Image.LANCZOS), (ox, oy))
        canvas.paste(im.crop((450, 0, 900, 450)).resize((150, 150), Image.LANCZOS), (ox + 150, oy))
        t = im.crop((0, 0, 450, 450)).resize((75, 75), Image.LANCZOS)
        far = Image.new("RGB", (150, 150))
        for a in range(2):
            for b in range(2):
                far.paste(t, (a * 75, b * 75))
        canvas.paste(far, (ox + 300, oy))
        canvas.paste(im.crop((0, 450, 450, 750)), (ox, oy + 150))
    out = out or os.path.join(PREV_DIR, "_sheet.png")
    canvas.save(out)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("names")
    ap.add_argument("--src", default=TEX_DIR)
    ap.add_argument("--channels", action="store_true")
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--reuse", action="store_true", help="sheet: reuse existing preview PNGs")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    if a.sheet:
        print(sheet(a.names.split(","), a.src, a.out, a.reuse))
        sys.exit(0)
    for nm in a.names.split(","):
        print(render(nm, a.src, channels=a.channels))
