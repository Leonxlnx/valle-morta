# Unattended final render of the film, one command:
#   powershell -NoProfile -ExecutionPolicy Bypass -File cinematic\render-film.ps1
# Needs the dev server on http://127.0.0.1:5183. Keeps the machine awake, renders the
# 3840x2160 film shot by shot, two masters from the same frames: HDR10 (seg_XX.mkv) and native SDR
# through the game's own tone curve with the film's soft highlight knee (sseg_XX.mkv); 6 to 16 sub-frames over a
# 180 degree shutter (more in frames with fast screen motion, camera and weapon interpolated between the 12
# simulation steps per frame), about 7 s per frame on the 780M, about 2.6 h (cinematic/capture.mjs --final, resumable: a re-run
# keeps the finished shots of the same film version), then mixes and muxes the
# soundtrack (cinematic/finish.mjs --final: HDR with copied video, 4K SDR copied from the native SDR master,
# 1080p SDR scaled from it), and
# writes ffprobe output and a contact sheet to cinematic/out/.
# Segments and films left from an older version of the film (another film.js,
# capture.mjs or fx.js) are moved to cinematic/out/old-<date>/ first, so they are
# never stitched into the new film.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.Power]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no idle sleep
$out = 'cinematic\out'
$film = 'cinematic\valle-morta-4k-hdr.mp4'
$log = "$out\render.log"
New-Item -ItemType Directory -Force $out | Out-Null
function Say($s) { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $s" | Tee-Object -FilePath $log -Append }
try {
  # ---- the film version: a hash of the files that decide what is rendered
  $src = @('src\cinematic\film.js', 'cinematic\capture.mjs', 'src\game\fx.js', 'src\engine\post.js', 'src\engine\engine.js')
  $stamp = ($src | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash }) -join ''
  $stampFile = "$out\seg_stamp.txt"
  $old = if (Test-Path $stampFile) { (Get-Content $stampFile -Raw).Trim() } else { '' }
  $stale = @(Get-ChildItem $out -File | Where-Object { $_.Name -match '^s?seg_\d+\.(mkv|tape\.json|part\.mkv)$' -or $_.Name -in @('film_events.json', 'sdr_video.mp4') })
  $stale += @(Get-ChildItem 'cinematic' -File | Where-Object { $_.Name -match '^valle-morta-(4k-hdr|4k-sdr|1080p-sdr)\.mp4$' })
  if ($old -ne $stamp -and $stale.Count -gt 0) {
    $arch = "$out\old-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    New-Item -ItemType Directory -Force $arch | Out-Null
    foreach ($f in $stale) { Move-Item -LiteralPath $f.FullName -Destination $arch -Force }
    Say "moved $($stale.Count) files of an older film version to $arch"
  } else {
    # same version: keep the finished shots, drop half-written ones and an unfinished film
    Get-ChildItem $out -File -Filter '*seg_*.part.mkv' | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  Set-Content $stampFile $stamp
  Remove-Item "$out\status.txt" -ErrorAction SilentlyContinue

  # ---- frames: resume until every shot is done and the film is stitched
  $ok = $false
  for ($try = 1; $try -le 6 -and -not $ok; $try++) {
    Say "capture attempt $try"
    node cinematic/capture.mjs --final *>> $log
    $ok = ($LASTEXITCODE -eq 0) -and (Test-Path $film) -and (Test-Path "$out\film_events.json") -and (Test-Path "$out\sdr_video.mp4")
    if (-not $ok) { Say "capture exit $LASTEXITCODE, retrying in 60 s"; Start-Sleep -Seconds 60 }
  }
  if (-not $ok) { Say 'capture did not finish'; "FAILED $(Get-Date -Format o) capture" | Set-Content "$out\status.txt"; exit 1 }

  # ---- sound: mix, master and mux (also writes valle-morta-4k-sdr.mp4 and valle-morta-1080p-sdr.mp4)
  Say 'finish.mjs --final'
  node cinematic/finish.mjs --final *>> $log
  $mixed = $LASTEXITCODE -eq 0

  # ---- checks: ffprobe of every output and a contact sheet of the native SDR film
  $probe = "$out\probe.txt"
  Remove-Item $probe -ErrorAction SilentlyContinue
  foreach ($f in @($film, "$out\sdr_video.mp4", 'cinematic\valle-morta-4k-sdr.mp4', 'cinematic\valle-morta-1080p-sdr.mp4')) {
    if (Test-Path $f) {
      "== $f" | Add-Content $probe
      ffprobe -v error -show_entries "stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,color_transfer,color_primaries,color_space,nb_frames,sample_rate,channels:format=duration,size,bit_rate" -of default=nw=1 $f *>> $probe
    }
  }
  $sel = "select='eq(n\,70)+eq(n\,220)+eq(n\,400)+eq(n\,560)+eq(n\,750)+eq(n\,900)+eq(n\,1080)+eq(n\,1150)+eq(n\,1300)'"
  $sheetSrc = if (Test-Path 'cinematic\valle-morta-4k-sdr.mp4') { 'cinematic\valle-morta-4k-sdr.mp4' } else { "$out\sdr_video.mp4" }
  ffmpeg -hide_banner -loglevel error -y -i $sheetSrc -vf "$sel,scale=640:-2:in_range=tv:out_range=pc,tile=3x3" -fps_mode passthrough -frames:v 1 -q:v 3 "$out\film_sheet.jpg" *>> $probe
  Say "done: film=$(Test-Path $film) sound=$mixed sheet=$(Test-Path "$out\film_sheet.jpg")"
  "DONE $(Get-Date -Format o) film=$(Test-Path $film) sound=$mixed" | Set-Content "$out\status.txt"
} finally {
  [Win32.Power]::SetThreadExecutionState([uint32]"0x80000000") | Out-Null
}
