# Rebuilds one infected model from code only: public/assets/models/<zombie|runner|brute|boss>.glb (+ alternative albedo JPEGs).
# Usage:  powershell -NoProfile -File tools\zombie\build.ps1 [-Type walker|runner|brute|boss] [-From hi|low|bake|paint|rig]
#         -From rig is enough after changing proportions (variant.py), skin weights (rig.py) or clips (anim.py).
param([string]$Type = 'walker', [string]$From = 'hi')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root '..\..\.venv\Scripts\python.exe'
$blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
$env:ZVARIANT = $Type; $bdir = if ($Type -eq 'walker') { 'build' } else { "build_$Type" }
$env:OMP_NUM_THREADS = '6'; $env:OPENBLAS_NUM_THREADS = '6'
$stages = @('hi', 'low', 'bake', 'paint', 'rig'); $start = [array]::IndexOf($stages, $From)
function Wait-Idle { while ($true) { $s = powershell -NoProfile -File (Join-Path $root '..\sysmon.ps1'); Write-Host $s
    if ($s -match 'CPU (\d+)% \| RAM free ([\d,\.]+)/') { if ([int]$Matches[1] -le 80 -and [double]($Matches[2] -replace ',', '.') -ge 9) { return } }; Start-Sleep 60 } }
Push-Location $root
New-Item -ItemType Directory -Force $bdir | Out-Null
if ($start -le 0) { Wait-Idle; & $py mesh_hi.py 3.0 }                                             # SDF -> marching cubes (3 mm)
if ($start -le 1) { Wait-Idle; & $blender -b -t 4 --python bl_lowpoly.py | Select-String 'decimate chosen|game mesh|uv islands|LOWPOLY_DONE' }
if ($start -le 2) { Wait-Idle; & $py bake.py geo }                                                 # normals / AO / material ids from the field
if ($start -le 3) { & $py bake.py paint }                                                          # albedo variants, ORM, normal
if ($start -le 4) {
    & $py rig.py                                                                                   # skin weights (canonical space)
    & $py anim.py                                                                                  # clips @ 60 fps on this type's skeleton
    & $blender -b -t 4 "$bdir\low.blend" --python bl_rig_export.py | Select-String 'RIG_EXPORT_DONE|Error'   # warp to the type's proportions, rig, export
    & $py glb_patch.py                                                                             # textures + clips -> public/assets/models, then verify
}
Pop-Location
