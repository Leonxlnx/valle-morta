#!/bin/bash
# run.sh <logname> <target> <stages / options...>  - runs the Blender pipeline with 6 threads and prints the interesting log lines
cd /e/fable/shootinggame
log=tools/weapon/build/$1.txt; shift
"/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b -t 6 --python tools/weapon/build.py -- "$@" > $log 2>&1
grep -nE "STAGE|TOTAL|ATLAS|node |boolean|fail|Error|Traceback|sheet|baked|texels|done|exported|textures rc|File \"|^[A-Za-z]*Error|glove|ArmsMesh|seat|grip|moved|CLIP|GRIP|WARN|VERIFY|bevel" $log | grep -v Deprecation | tail -${TAILN:-90}
