# Prints a one-line snapshot of CPU, RAM and GPU load. Used to make sure heavy
# jobs (bakes, renders, captures) never push the machine into the red.
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
$freeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$totGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$gpuUtil = 0; $gpuDed = 0; $gpuShared = 0
try {
  $s = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction Stop).CounterSamples
  $gpuUtil = [math]::Round(($s | Measure-Object -Property CookedValue -Sum).Sum, 0)
  $m = (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage','\GPU Adapter Memory(*)\Shared Usage' -ErrorAction Stop).CounterSamples
  $gpuDed = [math]::Round((($m | Where-Object Path -like '*dedicated*') | Measure-Object -Property CookedValue -Sum).Sum / 1GB, 2)
  $gpuShared = [math]::Round((($m | Where-Object Path -like '*shared*') | Measure-Object -Property CookedValue -Sum).Sum / 1GB, 2)
} catch {}
"CPU {0}% | RAM free {1}/{2} GB | GPU 3D {3}% | GPU mem dedicated {4} GB shared {5} GB" -f $cpu, $freeGb, $totGb, $gpuUtil, $gpuDed, $gpuShared
