<#
.SYNOPSIS
  Runs the Europe import and re-runs it automatically after an interruption (Docker Desktop VM restart, dropped
  connection, crash) until it completes - or stops when it makes no progress.

.DESCRIPTION
  The ingestion tool is resumable by design: running the same command again continues where it stopped (Range download,
  osmium skipped if its sections are complete, finished sections skipped, confirmed rows skipped). This wrapper only
  automates "run it again". Nothing here changes what is imported.

  Each attempt: wait for the Docker engine, make sure the (empty-at-start) Europe node is up and healthy, run the runner
  container in the foreground, append its output to <DataDir>\import.log. Exit code 0 = finished. Otherwise it waits and
  retries; after -MaxNoProgress consecutive attempts that changed nothing (no more downloaded bytes, no more progress
  lines, no new section) it stops, because that is not a transient interruption.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ingestion\deploy\europe-node\run-europe.ps1 `
    -DataDir E:\tn-europe-import\data -IdxDir D:\tn-europe-idx `
    -NodeEnv E:\tn-europe-import\secrets\europe-node.env -ClientEnv E:\tn-europe-import\secrets\europe-client.env
#>
param(
  [Parameter(Mandatory)][string]$DataDir,
  [Parameter(Mandatory)][string]$IdxDir,
  [Parameter(Mandatory)][string]$NodeEnv,
  [Parameter(Mandatory)][string]$ClientEnv,
  [string]$Project = "tn-europe",
  [string]$Image = "trafficnetwork-ingest:europe",
  [string]$Region = "europe",
  [string]$Memory = "5g",
  [int]$MaxNoProgress = 3,
  [int]$RetryDelaySeconds = 45
)

$ErrorActionPreference = "Continue"
$compose = Join-Path $PSScriptRoot "docker-compose.yml"
$log = Join-Path $DataDir "import.log"
$stateDir = Join-Path $DataDir "state"
New-Item -ItemType Directory -Force -Path $DataDir, $IdxDir | Out-Null

function Say($message) { $line = "{0} [run-europe] {1}" -f (Get-Date -Format s), $message; Write-Host $line; Add-Content -Path $log -Value $line }

function Wait-Docker {
  for ($i = 0; $i -lt 120; $i++) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    Start-Sleep -Seconds 5
  }
  return $false
}

function Progress-Token {
  # Anything that moves when the run makes headway: downloaded bytes, progress lines, finished sections, osmium output.
  $size = 0
  foreach ($p in @("downloads\$Region.osm.pbf.part", "downloads\$Region.osm.pbf")) {
    $f = Join-Path $DataDir $p
    if (Test-Path $f) { $size += (Get-Item $f).Length }
  }
  $progress = Join-Path $stateDir "$Region\osm\progress.ndjson"
  if (Test-Path $progress) { $size += (Get-Item $progress).Length }
  $sections = Join-Path $stateDir "$Region\osm\sections"
  $count = 0
  if (Test-Path $sections) { $count = (Get-ChildItem $sections -File).Count }
  $work = Join-Path $DataDir "downloads\$Region-osmium-work"
  $work_files = 0
  if (Test-Path $work) { $work_files = (Get-ChildItem $work -Recurse -File -ErrorAction SilentlyContinue).Count }
  return "$size/$count/$work_files"
}

$noProgress = 0
$attempt = 0
$lastToken = Progress-Token
while ($true) {
  $attempt++
  if (-not (Wait-Docker)) { Say "Docker engine did not come back within 10 minutes - giving up"; exit 2 }

  docker compose -p $Project --env-file $NodeEnv -f $compose up -d *> $null
  $healthy = $false
  for ($i = 0; $i -lt 90; $i++) {
    $h = docker inspect -f "{{.State.Health.Status}}" "$Project-server-1" 2>$null
    if ($h -eq "healthy") { $healthy = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $healthy) { Say "server of project $Project is not healthy - will retry"; Start-Sleep -Seconds $RetryDelaySeconds; continue }

  Say "attempt ${attempt}: starting the import container"
  docker rm -f "$Project-import" *> $null
  docker run --rm --name "$Project-import" --memory=$Memory --network "${Project}_default" `
    -v "${DataDir}:/data" -v "${IdxDir}:/idx" --env-file $ClientEnv `
    -e SERVER_URL=http://server:3000 -e OSMIUM_INDEX_DIR=/idx `
    $Image --region $Region *>> $log
  $code = $LASTEXITCODE
  Say "attempt ${attempt}: container exited with code $code"
  if ($code -eq 0) { Say "import finished"; exit 0 }

  $token = Progress-Token
  if ($token -eq $lastToken) { $noProgress++ } else { $noProgress = 0 }
  $lastToken = $token
  if ($noProgress -ge $MaxNoProgress) {
    Say "$noProgress attempts in a row made no progress - this is not a transient interruption. Read the end of $log and quarantine.ndjson before running again."
    exit 1
  }
  Say "waiting $RetryDelaySeconds s, then resuming (no-progress attempts so far: $noProgress)"
  Start-Sleep -Seconds $RetryDelaySeconds
}
