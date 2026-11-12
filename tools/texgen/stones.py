"""Shared helper: packed scatter of individual stones (pebbles, gravel, cobbles)."""
import numpy as np
from .core import *  # noqa: F401,F403


def scatter_stones(c, tag, H, count, rmin, rmax, alpha=2.7, overlap=0.85, aspect=(1.0, 1.7),
                   flat=(0.45, 0.8), embed=(0.15, 0.45), lump=0.07, p=(2.0, 3.0), q=(0.5, 0.75),
                   accept=None, mode="max", drop_q=0.0, ID=None, id_offset=0, tries=12):
    """Pack `count` stones with power-law radii (metres) and composite them
    into the height map H (metres). Returns a dict describing the stones."""
    T = c.tile
    r = c.rng(tag)
    rad = power_radii(r, count, rmin, rmax, alpha)
    asp0 = r.uniform(aspect[0], aspect[1], count)
    x, y, ok = pack_discs(r, rad / np.sqrt(asp0) / T, res=1024, overlap=overlap, tries=tries, accept=accept)
    x, y, rad, asp = x[ok], y[ok], rad[ok], asp0[ok]
    N = len(rad)
    ang = r.random(N) * TAU
    hgt = rad * r.uniform(flat[0], flat[1], N) / np.sqrt(asp)
    zoff = -hgt * r.uniform(embed[0], embed[1], N)
    fn = blob_fn(ang, asp, hgt, r.uniform(0, lump, (N, 4)), r.random((N, 4)) * TAU,
                 p=r.uniform(p[0], p[1], N), q=r.uniform(q[0], q[1], N), size=0.9)
    if ID is None:
        ID = np.full(H.shape, -1, np.int32)
    stamp(H, x, y, rad / 0.9 / T, with_offset(fn, zoff), ID=ID, mode=mode, drop_q=drop_q, id_offset=id_offset)
    return dict(ID=ID, x=x, y=y, rad=rad, N=N, hgt=hgt, ang=ang, asp=asp, rnd=r.random((N, 8)).astype(F))


def stone_coords(c, S, off=0):
    """Local coordinates (in stone radii) for every pixel covered by a stone."""
    sid = S["ID"] - off
    valid = (sid >= 0) & (sid < S["N"])
    sc = np.clip(sid, 0, S["N"] - 1)
    du = (wrapd(c.x - S["x"][sc].astype(F)) * c.tile / S["rad"][sc].astype(F)).astype(F)
    dv = (wrapd(c.y - S["y"][sc].astype(F)) * c.tile / S["rad"][sc].astype(F)).astype(F)
    return valid, sc, du, dv
