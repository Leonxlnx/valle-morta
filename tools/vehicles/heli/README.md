# Helicopter (Operation mode, film) - generated model

`public/assets/models/heli.glb` is built entirely by code: geometry in numpy, atlas UVs and geometry bakes in Blender (headless, CPU, 4 threads), PBR textures in numpy. No downloaded models, textures or HDRIs.

```
powershell -NoProfile -File tools\vehicles\heli\build.ps1                      # bake -> tex -> export (about 10 min)
powershell -NoProfile -File tools\vehicles\heli\build.ps1 -Stages tex,export   # texture changes only
```

| file | role |
|---|---|
| `heli_geo.py` | the model as numpy meshes (metres, Blender axes, origin on the ground under the mast, nose +Y): fuselage as an analytic superellipse loft `S(y, a)` with openings / glazing cut on its grid, sliding doors, cowling and two engine nacelles, boom, fin, stabiliser, skids, rotor head (mast, swashplates, servos, elastomeric hub, grips, pitch horns and links, dampers), four twisted drooping blades, tail rotor, cabin and cockpit interior, two seated pilots. Each face has a material id (constants at the top) and a node index (`NODES`). `python heli_geo.py` prints triangle counts per group. |
| `build_heli.py` | Blender: `bake` solidifies the skin (inner shell -> cabin lining), smart-UV atlases per texture group (paint = cabin and nose skin 2048, top = roof housing, boom and tail surfaces 2048, cabin 2048, mech 2048, crew 1024; the glass is an untextured material), bakes part id / position / normal / bevel-edge / AO to `_work/*.npy`; `export` builds the final materials, splits nodes with their pivots, adds the blurred rotor discs, emissive lights and a decimated far LOD, writes `_work/heli.glb`. Install it with `node tools/vehicles/install.mjs heli` (copies it into public/assets/models under the GPU lock). |
| `tex.py` | numpy texture synthesis from the bakes: olive paint with panel joints and rivet rows (from the 3D position, so they run across UV seams), per-panel tone, sun fade, rain streaks, dust, exhaust soot, chipped edges with primer and bare aluminium; quilted cabin lining, worn floor, canvas, webbing, metals with grime, glass dirt; `heli_disc.png` (rotor blur, luminance = opacity). |

Nodes in the GLB (glTF +Y up, nose -Z): `Heli` > meshes of the body, `DoorR` / `DoorL` (modelled open, slid 2.2 m aft), `MainRotor` (pivot on the mast at y 3.8, turns about Y) > `Blades`, `RotorDisc`; `TailRotor` (pivot at the port-side tail hub, turns about X) > `TailBlades`, `TailDisc`; `HeliLOD`. Materials: `HeliPaint`, `HeliCabin`, `HeliMech`, `HeliCrew`, `HeliGlass`, `RotorDisc`, `LightRed`, `LightGreen`, `LightWhite`, `Beacon`. The game (`Helicopter` in `src/game/operation.js`) shows `RotorDisc` instead of the blades above a rotor speed, swaps to `HeliLOD` beyond 140 m and flashes `Beacon`.

Dimensions: fuselage 15.6 m nose to fin, rotor 14 m, hub 3.8 m above the skids, cabin floor 0.86 m, cabin door opening 2.1 m.

Second pass (2026-11-14): boxy cabin with flat sides and floor, sloped two-piece windscreen with centre post, chin, overhead, cockpit-door and cabin windows; separate tapering boom; flat-sided roof housing with intakes, flank grilles and two exhaust stacks; body lowered by `DZ` (0.14 m) onto thicker gear; hatches, latches and generic stencils in `tex.py`; bucket seats; emissive dial faces and screens (`DialFace`, `Screen`); streaky rotor blur without a tip ring; the LOD is cleaned and validated. Review views: `tools/vehicles/heli/shots.js` (see its first comment).
