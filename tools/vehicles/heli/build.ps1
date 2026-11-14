# Rebuilds public/assets/models/heli.glb from code: Blender bake stage, texture synthesis, Blender export stage.
#   powershell -NoProfile -File tools\vehicles\heli\build.ps1                 # everything (about 10 min on the laptop)
#   powershell -NoProfile -File tools\vehicles\heli\build.ps1 -Stages tex,export   # after texture-only changes
param([string[]]$Stages = @('bake', 'tex', 'export'))
$ErrorActionPreference = 'Continue'   # Blender and Python write to stderr; that is not a failure
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$here = $PSScriptRoot; $work = Join-Path $here '_work'
New-Item -ItemType Directory -Force $work | Out-Null
$blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
$py = Join-Path $root '.venv\Scripts\python.exe'
Push-Location $root
try {
  foreach ($s in $Stages) {
    $logf = Join-Path $work "log_$s.txt"
    Write-Host "== $s (log: $logf)"
    if ($s -eq 'tex') { & $py (Join-Path $here 'tex.py') *> $logf }
    else { & $blender -b -t 4 --python (Join-Path $here 'build_heli.py') -- $s *> $logf }
    Get-Content $logf | Select-String -Pattern '^\[(heli|tex)|Error|Traceback' | Select-Object -Last 30 | ForEach-Object { $_.Line }
  }
} finally { Pop-Location }
