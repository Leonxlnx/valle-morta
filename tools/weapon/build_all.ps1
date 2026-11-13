# Rebuild the first-person view models (shared arms rig, then every weapon that has a tools/weapon/w_<id>.py).
#   powershell -NoProfile -File tools\weapon\build_all.ps1                         # everything
#   powershell -NoProfile -File tools\weapon\build_all.ps1 -Only rifle -Stages anim
# Outputs: public/assets/models/<id>.glb + <id>.anim.json, contact sheets tools/_preview/weapon/final_<id>_*.png,
# logs tools/weapon/build/log_<target>.txt. CPU only, 6 Blender threads, one job at a time. See README.md.
param([string[]]$Only = @('arms', 'rifle', 'pistol', 'sniper'), [string[]]$Stages = @())
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot 'build') | Out-Null
& powershell -NoProfile -File (Join-Path $root 'tools\sysmon.ps1')
foreach ($t in $Only) {
  if ($t -ne 'arms' -and -not (Test-Path (Join-Path $PSScriptRoot "w_$t.py"))) { Write-Host "skip ${t}: tools/weapon/w_$t.py does not exist yet"; continue }
  $a = @('-b', '-t', '6', '--python', (Join-Path $PSScriptRoot 'build.py'), '--', $t) + $Stages
  if ($t -ne 'arms' -and $Stages.Count -eq 0) { $a += @('geo', 'bake', 'tex', 'anim', 'look', 'sheets=Reload:12,ReloadEmpty:12,misc') }
  $log = Join-Path $PSScriptRoot "build\log_$t.txt"
  Write-Host "== $t $($a[7..($a.Count - 1)] -join ' ')"
  & $blender @a 2>&1 | Out-File -FilePath $log -Encoding utf8
  Select-String -Path $log -Pattern 'STAGE|TOTAL|GRIP|CLIP|VERIFY|Traceback|Error' | ForEach-Object { $_.Line }
}
$glbs = @(@('rifle', 'pistol', 'sniper') | ForEach-Object { Join-Path $root "public\assets\models\$_.glb" } | Where-Object { Test-Path $_ })
if ($glbs.Count) { & (Join-Path $root '.venv\Scripts\python.exe') (Join-Path $PSScriptRoot 'verify_glb.py') @glbs }
