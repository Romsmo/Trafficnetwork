<#
.SYNOPSIS
  Keeps Docker Desktop's WSL2 VM from hoarding the host's memory during the long Europe import.

.DESCRIPTION
  Measured on the project PC (2026-09-25): the VM's Linux page cache, filled by the 35 GB download and the osmium/import
  file IO, made vmmemWSL grow to 5.4 GB although the containers used ~1 GB; dropping the guest page cache gave 1.8 GB back
  to Windows within seconds (host free commit 1.7 -> 3.9 GB). With the host's commit limit nearly exhausted (small pagefile on a
  nearly full C:), that hoarding is what pushed Windows to kill the VM - every container died and the import had to be resumed.

  This loop looks at the VM's page cache every few seconds and drops it when it exceeds a threshold. Dropping the cache is
  a kernel runtime operation (nothing is changed in any setting or file); the only cost is that the OS re-reads some data
  from disk. It stops when the file given by -StopFile appears.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File keep-vm-memory-low.ps1 -StopFile E:\tn-europe-import\stop-cache-dropper
#>
param(
  [string]$StopFile = "E:\tn-europe-import\stop-cache-dropper",
  [int]$ThresholdMB = 1200,
  [int]$IntervalSeconds = 10,
  [string]$Log = "E:\tn-europe-import\data\cache-dropper.log"
)
$drops = 0
while (-not (Test-Path $StopFile)) {
  $cachedKb = wsl -d docker-desktop -e sh -c "awk '/^Cached:/ {print `$2}' /proc/meminfo" 2>$null
  if ($cachedKb -match '^\d+$' -and [int64]$cachedKb / 1024 -gt $ThresholdMB) {
    wsl -d docker-desktop -e sh -c "sync; echo 1 > /proc/sys/vm/drop_caches" 2>$null
    $drops++
    if ($drops % 20 -eq 1) { Add-Content -Path $Log -Value ("{0} dropped VM page cache (was {1} MB), drops so far: {2}" -f (Get-Date -Format s), [int]([int64]$cachedKb / 1024), $drops) }
  }
  Start-Sleep -Seconds $IntervalSeconds
}
Add-Content -Path $Log -Value ("{0} stopped after {1} drops" -f (Get-Date -Format s), $drops)
