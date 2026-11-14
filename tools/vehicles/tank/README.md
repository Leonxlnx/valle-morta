# Tank pipeline (T-54/55 style medium tank, all by code)

One script builds both game models from nothing: geometry, UVs, bakes, textures, export.

```
bash tools/vehicles/tank/build.sh            # both: tank.glb, then tank_wreck.glb (about 3 to 4 min each), then verify
bash tools/vehicles/tank/build.sh wreck      # one variant
bash tools/vehicles/tank/build.sh intact fast   # half-size bakes and textures, about 35 s, for iteration
.venv\Scripts\python.exe tools\vehicles\tank\verify_tank.py public\assets\models\tank.glb public\assets\models\tank_wreck.glb
```

`build.sh` runs Blender 5.2 headless with `-t 4`, CPU Cycles only (bakes), waits while another Blender is running, and keeps the log in `build/<variant>.log` (`build/` also holds the PNG textures and a `.blend` of the result).

## What `build_tank.py` does

1. **Geometry** (bmesh primitives in metres: bevelled boxes, prisms, lathes, swept tubes; Blender +X forward, +Y left, +Z up, ground at z = 0): hull 6.04 x 3.29 m with sloped glacis, splash board, welded plate joints, driver's hatch and periscopes, fenders with flanges and brackets, stowage boxes, three external fuel cells and pipe, exhaust outlet, engine deck with access plate, bolts, intake grilles and rear louvres, rear drums on straps, unditching beam, tow hooks and cables, lifting eyes, headlights with guards, torsion arms, bump stops, final drives. Cast turret from a superellipsoid with cast irregularity, canvas gun boot, mantlet collar, 100 mm-class gun with bore evacuator, coaxial port, IR searchlight, commander's cupola with vision blocks and searchlight, loader's hatch with AA machine gun on a pintle, sight hood, ventilator, grab rails, antenna, snorkel tube. Running gear: five dual road wheels per side (rubber tyres, starfish ribs, hub bolts), toothed rear sprocket, front idler, and 92 individual links per side (pad, grouser, hinge knuckles, guide horn) laid along the track path: convex hull of the wheels, then a top run that rests on the road-wheel tops and sags between them (no return rollers, as on the real vehicle).
2. **Variant** `wreck`: right track thrown and lying beside the hull (curled end, loose links), second right road wheel missing, the hull rolled down onto its right wheels, hatches open, turret turned 21 deg, gun drooped 5.5 deg, middle fuel cell fallen to the ground, one stowage box gone and one lid open, bent front fender, snapped antenna, a penetration in the turret side.
3. **UVs**: one body atlas (smart project over hull, turret, gun, hatches) and a gear atlas in quadrants (wheel, sprocket, idler, link). All wheels share one mesh (right side mirrored), all links share the link's UVs.
4. **Bakes** (Cycles CPU): material id, position, normal, bevel edge mask, ambient occlusion per atlas (body 2048, gear 1024).
5. **Textures** (`compose()`, numpy value-noise fbm in object space): intact = layered olive drab with sun fade, streaks, edge chips to bare steel, dust on up-facing surfaces and corners, mud low down and on the running gear, worn bright track pads; wreck = rust layers, soot, scorched paint remains, ash, rust runs, charred tyres and beam. Outputs base colour (sRGB), ORM (occlusion, roughness, metalness) and a normal map from a height field.
6. **Export** glTF binary with occlusion, normal and ORM textures (JPEG), custom properties as extras.

## Contract with the game

`tank.glb` (src/game/abilities.js, tank ability): nodes `Tank` (extras `track_path` = x, y pairs of the link centre line in glTF space, `track_links`, `track_len`, `track_z`), `Hull`, `Turret` (yaw about +Y), `Gun` (pitch about +Z), `Barrel` (recoil along -X), `Muzzle`, `Eye` (commander standing in the open cupola), `Exhaust`, `DriverHatch`, `CommanderHatch`, `LoaderHatch`, `WheelL1..5`, `WheelR1..5`, `SprocketL/R`, `IdlerL/R` (spin about +Z, extras `radius`), `TrackL`, `TrackR` (static) and `TrackLink` (one link; the game hides the static tracks and instances this link along `track_path`). glTF frame: nose +X, up +Y, right +Z, ground y = 0.

`tank_wreck.glb` (src/world/props.js): static; `TankWreck` > `Hull` ..., `Debris` > `TrackThrown`, `FuelCellFallen`. The left track and the right road wheels stand on y = 0; props.js fits the wreck to the terrain, drapes the thrown track and merges everything per material.
