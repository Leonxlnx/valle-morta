# Unattended film render: keeps the system awake while it runs, resumes the
# shot-by-shot capture until the film exists, then verifies it, writes a
# contact sheet and a 1080p SDR preview. Needs the dev server on :5173.
#   powershell -NoProfile -File cinematic\render-film.ps1
Set-Location (Split-Path $PSScriptRoot -Parent)
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.Power]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null   # no idle sleep while rendering
$out = 'cinematic\out'
New-Item -ItemType Directory -Force $out | Out-Null
Remove-Item "$out\status.txt", "$out\render.log", "$out\*.part.mkv" -ErrorAction SilentlyContinue
$film = 'cinematic\valle-morta-4k-hdr.mp4'
for ($try = 1; $try -le 4; $try++) {
  node cinematic/capture.mjs *>> "$out\render.log"
  if (Test-Path $film) { break }
  Start-Sleep -Seconds 60
}
if (Test-Path $film) {
  ffprobe -v error -select_streams v:0 -show_entries "stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,color_transfer,color_primaries,color_space,nb_frames:format=duration,size,bit_rate" -of default=nw=1 $film *> "$out\probe.txt"
  $sel = "select='eq(n\,70)+eq(n\,190)+eq(n\,290)+eq(n\,385)+eq(n\,480)+eq(n\,650)+eq(n\,735)+eq(n\,880)+eq(n\,1010)'"
  $tm = 'zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=pc,format=yuv420p'
  ffmpeg -hide_banner -loglevel error -y -i $film -vf "$sel,$tm,scale=640:-2,tile=3x3" -fps_mode passthrough -frames:v 1 -q:v 3 "$out\film_sheet.jpg" *>> "$out\probe.txt"
  if (-not (Test-Path "$out\film_sheet.jpg")) { ffmpeg -hide_banner -loglevel error -y -i $film -vf "$sel,scale=640:-2,tile=3x3" -fps_mode passthrough -frames:v 1 -q:v 3 "$out\film_sheet.jpg" *>> "$out\probe.txt" }
  ffmpeg -hide_banner -loglevel error -y -i $film -vf "$tm,scale=1920:-2" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -threads 8 -movflags +faststart cinematic\valle-morta-1080p-sdr.mp4 *>> "$out\probe.txt"
}
"DONE $(Get-Date -Format o) film=$(Test-Path $film)" | Set-Content "$out\status.txt"
[Win32.Power]::SetThreadExecutionState([uint32]"0x80000000") | Out-Null
