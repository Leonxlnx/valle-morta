#!/bin/bash
# build.sh [intact|wreck|all] [fast]  - builds public/assets/models/tank.glb and/or tank_wreck.glb
# Blender 5.2 headless, 4 threads, CPU Cycles bakes only; waits while another Blender is running.
cd "$(dirname "$0")/../../.."
B="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
mkdir -p tools/vehicles/tank/build
which="${1:-all}"; [ "$which" = all ] && which="intact wreck"
for v in $which; do
  while tasklist 2>/dev/null | grep -qi "^blender.exe"; do echo "waiting for another Blender..."; sleep 15; done
  "$B" -b --factory-startup -t 4 --python tools/vehicles/tank/build_tank.py -- $v $2 > tools/vehicles/tank/build/$v.log 2>&1
  grep -E "^\[tank|Error|Traceback|File \"" tools/vehicles/tank/build/$v.log | tail -${TAILN:-25}
done
.venv/Scripts/python.exe tools/vehicles/tank/verify_tank.py public/assets/models/tank.glb public/assets/models/tank_wreck.glb
