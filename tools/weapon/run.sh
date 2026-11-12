#!/bin/bash
# run.sh <logname> <stages...>  - waits for a quiet machine, runs the Blender pipeline, prints a summary
cd /e/fable/shootinggame
log=tools/weapon/build/$1.txt; shift
for i in 1 2 3 4 5 6 7 8 9 10; do
  s=$(powershell -NoProfile -File tools/sysmon.ps1); cpu=$(echo "$s" | sed -E 's/CPU ([0-9]+)%.*/\1/')
  if [ "${cpu:-0}" -le 85 ]; then break; fi; echo "busy: $s"; sleep 30
done
echo "$s"
"/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b -t 4 --python tools/weapon/build_rifle.py -- "$@" > $log 2>&1
grep -nE "STAGE|ATLAS|node |boolean|fail|Error|Traceback|rendered|sheet|baked|texels|done|exported|textures rc|File \"|^[A-Za-z]*Error" $log | grep -v Deprecation | tail -70
