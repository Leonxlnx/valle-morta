"""Per-type configuration of the infected pipeline.  Select the type with the environment variable
ZVARIANT = walker | runner | brute | boss  (default walker).

Sculpt, bake and skinning always happen in the walker's canonical space, so every landmark the pipeline
relies on stays valid.  A type differs by
  1. sculpt switches and additions (extras.py: sleeveless shirt, apron, rope, growths ...),
  2. a per-bone scale table: the skinned game mesh and the skeleton are warped by a linear blend of
     scaled bones (the usual body-morph trick), which gives the proportions,
  3. paint colours / blood pattern,
  4. the animation style (anim.py).
Only numpy is used here: the module is also imported inside Blender.
"""
import os
import numpy as np

NAME = os.environ.get('ZVARIANT', 'walker')
assert NAME in ('walker', 'runner', 'brute', 'boss'), NAME
HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, 'build' if NAME == 'walker' else 'build_' + NAME)
os.makedirs(BUILD, exist_ok=True)
OUT = 'zombie' if NAME == 'walker' else NAME            # public/assets/models/<OUT>.glb
TARGET_TRIS = 21000 if NAME == 'boss' else 14800

# bone -> s (uniform) | (sx, sy, sz) in character axes (x left, y back, z up) | ('ax', length, girth)
# A name without side applies to both sides; an exact name wins.
_SCALES = {
    'walker': {},
    'runner': {
        'Hips': (0.90, 0.88, 0.98), 'Spine': (0.85, 0.83, 1.02), 'Chest': (0.93, 0.86, 1.03), 'Neck': ('ax', 1.10, 0.88),
        'Head': 0.97, 'Jaw': 0.97, 'Shoulder': ('ax', 0.95, 0.90), 'UpperArm': ('ax', 1.06, 0.78), 'LowerArm': ('ax', 1.09, 0.78),
        'Hand': 1.0, 'UpperLeg': ('ax', 1.03, 0.80), 'LowerLeg': ('ax', 1.06, 0.78), 'Foot': 0.90, 'Toe': 0.90,
    },
    'brute': {
        'Hips': (1.42, 1.50, 1.15), 'Spine': (1.56, 1.78, 1.18), 'Chest': (1.52, 1.62, 1.25), 'Neck': ('ax', 1.08, 1.70),
        'Head': 1.10, 'Jaw': 1.10, 'Shoulder': ('ax', 1.56, 1.55), 'UpperArm': ('ax', 1.16, 1.60), 'LowerArm': ('ax', 1.16, 1.85),
        'Hand': 1.38, 'UpperLeg': ('ax', 1.18, 1.45), 'LowerLeg': ('ax', 1.18, 1.42), 'Foot': 1.25, 'Toe': 1.25,
    },
    'boss': {
        'Hips': (1.62, 1.68, 1.36), 'Spine': (1.74, 1.85, 1.40), 'Chest': (1.90, 1.96, 1.52), 'Neck': ('ax', 1.15, 2.05),
        'Head': 1.22, 'Jaw': 1.22, 'Shoulder': ('ax', 1.92, 2.20), 'Shoulder.R': ('ax', 2.04, 2.45),
        'UpperArm': ('ax', 1.50, 2.00), 'LowerArm': ('ax', 1.50, 2.05), 'Hand': 1.62,
        'UpperArm.R': ('ax', 1.62, 2.50), 'LowerArm.R': ('ax', 1.70, 2.85), 'Hand.R': 2.10,
        'UpperLeg': ('ax', 1.42, 1.78), 'LowerLeg': ('ax', 1.42, 1.72), 'Foot': 1.50, 'Toe': 1.50,
    },
}
SCALES = _SCALES[NAME]

# sRGB 0..255; converted by bake.py.  'a' is embedded in the GLB, 'b' is written as <OUT>_col_b.jpg.
_COLORS = {
    'walker': None,                                        # bake.py's own three villager variants
    'runner': {'a': dict(seed=120, shirt=(152, 130, 76), trousers=(57, 62, 49), boots=(132, 122, 104)),
               'b': dict(seed=160, shirt=(98, 114, 101), trousers=(76, 60, 47), boots=(94, 88, 80))},
    'brute': {'a': dict(seed=200, shirt=(74, 68, 61), trousers=(45, 45, 47), boots=(35, 29, 25), apron=(72, 51, 35)),
              'b': dict(seed=240, shirt=(92, 84, 64), trousers=(58, 50, 41), boots=(40, 34, 30), apron=(54, 48, 44))},
    'boss': {'a': dict(seed=280, shirt=(120, 112, 99), trousers=(41, 39, 39), boots=(31, 27, 25), rope=(134, 114, 82)),
             'b': dict(seed=320, shirt=(84, 80, 70), trousers=(52, 44, 38), boots=(36, 30, 26), rope=(112, 100, 78))},
}
COLORS = _COLORS[NAME]
SKIN_TINT = {'walker': None, 'runner': (0.93, 0.98, 0.97), 'brute': (0.90, 0.90, 0.89), 'boss': (0.80, 0.75, 0.77)}[NAME]


def _unit(v):
    v = np.asarray(v, float); return v / np.linalg.norm(v)


def spec(b):
    return SCALES.get(b, SCALES.get(b[:-2] if b.endswith(('.L', '.R')) else b, 1.0))


def bone_matrix(b, J, TAIL):
    s = spec(b)
    if np.isscalar(s):
        return np.eye(3) * float(s)
    if s[0] == 'ax':
        a = _unit(J[TAIL[b]] - J[b]); l, g = float(s[1]), float(s[2])
        return g * np.eye(3) + (l - g) * np.outer(a, a)
    return np.diag(np.asarray(s, float))


def girth(b):
    """Scale across the bone (ground-contact radii in the animation)."""
    s = spec(b)
    return float(s) if np.isscalar(s) else (float(s[2]) if s[0] == 'ax' else float(s[1]))


def warp_joints(J, BONES, PARENT, TAIL):
    """Scaled skeleton: every joint is carried by its parent's scale, soles stay on z = 0."""
    S = {b: bone_matrix(b, J, TAIL) for b in BONES}
    Jn = {}
    for i, b in enumerate(BONES):
        Jn[b] = np.array(J[b], float) if PARENT[i] < 0 else Jn[BONES[PARENT[i]]] + S[BONES[PARENT[i]]] @ (J[b] - J[BONES[PARENT[i]]])
    dz = S['Foot.L'][2, 2] * J['Foot.L'][2] - Jn['Foot.L'][2]
    for b in BONES:
        Jn[b][2] += dz
    for b in BONES:
        if TAIL[b] not in Jn:
            Jn[TAIL[b]] = Jn[b] + S[b] @ (J[TAIL[b]] - J[b])
    return Jn, S


def warp_points(V, idx, w, J, BONES, PARENT, TAIL):
    """Canonical vertices -> this type's proportions (idx, w: 4 skin influences per vertex)."""
    Jn, S = warp_joints(J, BONES, PARENT, TAIL)
    V = np.asarray(V, float); out = np.zeros_like(V)
    for k in range(idx.shape[1]):
        for bi, b in enumerate(BONES):
            m = (idx[:, k] == bi) & (w[:, k] > 0)
            if m.any():
                out[m] += w[m, k:k + 1] * (Jn[b] + (V[m] - J[b]) @ S[b].T)
    return out
