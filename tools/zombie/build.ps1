# Rebuilds public/assets/models/zombie.glb (+ zombie_col_b.jpg / zombie_col_c.jpg) from code only.
# Usage:  powershell -NoProfile -File tools\zombie\build.ps1 [-From hi|low|bake|paint|rig]
param([string]$From = 'hi')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root '..\..\.venv\Scripts\python.exe'
$blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
$env:OMP_NUM_THREADS = '6'; $env:OPENBLAS_NUM_THREADS = '6'
$stages = @('hi', 'low', 'bake', 'paint', 'rig'); $start = [array]::IndexOf($stages, $From)
function Wait-Idle { while ($true) { $s = powershell -NoProfile -File (Join-Path $root '..\sysmon.ps1'); Write-Host $s
    if ($s -match 'CPU (\d+)% \| RAM free ([\d,\.]+)/') { if ([int]$Matches[1] -le 75 -and [double]($Matches[2] -replace ',', '.') -ge 10) { return } }; Start-Sleep 60 } }
Push-Location $root
New-Item -ItemType Directory -Force build | Out-Null
if ($start -le 0) { Wait-Idle; & $py mesh_hi.py 3.0 }                                             # SDF -> marching cubes (3 mm)
if ($start -le 1) { Wait-Idle; & $blender -b -t 6 --python bl_lowpoly.py | Select-String 'decimate chosen|game mesh|uv islands|LOWPOLY_DONE' }
if ($start -le 2) { Wait-Idle; & $py bake.py geo }                                                 # normals / AO / material ids from the field
if ($start -le 3) { & $py bake.py paint }                                                          # albedo A/B/C, ORM, normal
if ($start -le 4) {
    & $py rig.py                                                                                   # skin weights
    & $py anim.py                                                                                  # 8 clips @ 30 fps
    & $blender -b -t 6 build\low.blend --python bl_rig_export.py | Select-String 'RIG_EXPORT_DONE|Error'
    & $py glb_patch.py                                                                             # textures + clips -> public/assets/models/zombie.glb, then verify
}
Pop-Location
