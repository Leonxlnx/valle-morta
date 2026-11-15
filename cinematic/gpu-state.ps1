# Prints "<other> <own> <shared>": the peak 3D load (percent, over three one-second samples) of all programs that are
# NOT in the process tree of -Root, the same for that tree, and the shared GPU memory in use on the machine (GB).
# cinematic/capture.mjs uses it to stay out of the way of other programs on this laptop's integrated GPU.
param([int]$Root = 0)
$mine = New-Object 'System.Collections.Generic.HashSet[int]'
if ($Root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  [void]$mine.Add($Root)
  do {
    $n = $mine.Count
    foreach ($p in $all) { if ($mine.Contains([int]$p.ParentProcessId)) { [void]$mine.Add([int]$p.ProcessId) } }
  } while ($mine.Count -ne $n)
}
$other = 0.0; $own = 0.0
foreach ($set in (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -SampleInterval 1 -MaxSamples 3)) {
  $o = 0.0; $m = 0.0
  foreach ($s in $set.CounterSamples) {
    if ($s.InstanceName -match 'pid_(\d+)') { if ($mine.Contains([int]$matches[1])) { $m += $s.CookedValue } else { $o += $s.CookedValue } }
  }
  if ($o -gt $other) { $other = $o }
  if ($m -gt $own) { $own = $m }
}
$shared = ((Get-Counter '\GPU Adapter Memory(*)\Shared Usage').CounterSamples | Measure-Object CookedValue -Sum).Sum / 1GB
[string]::Format([cultureinfo]::InvariantCulture, '{0:F0} {1:F0} {2:F1}', $other, $own, $shared)
