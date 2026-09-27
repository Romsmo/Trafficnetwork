# Starts Docker Desktop on this Windows PC and waits until the engine answers.
# Works around the Docker Desktop 4.88-4.91 startup crash where stale AF_UNIX
# socket files (Docker\run\sailor-ingest.sock, docker-secrets-engine\engine.sock)
# cannot be renamed after an unclean shutdown (docker/desktop-feedback#679).
# The stuck files cannot be deleted, so their parent folders are renamed aside.
#
# Included here (not just kept locally) because this exact bug already cost two
# separate sessions working on this repo real time on the same Windows+Docker
# Desktop combination — worth a minute for the next Windows contributor instead
# of rediscovering it, even though it's a one-machine workaround, not project code.
#
# Usage: powershell -ExecutionPolicy Bypass -File tools\start-docker-desktop.ps1

$ErrorActionPreference = "Continue"
$dockerExe = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"
$dockerBin = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin"
$env:Path += ";$dockerBin"

function Test-Engine {
    $job = Start-Job { & docker info --format "{{.ServerVersion}}" 2>$null }
    if (Wait-Job $job -Timeout 15) { $out = Receive-Job $job } else { $out = $null }
    Remove-Job $job -Force
    return [bool]$out
}

if (Test-Engine) { Write-Host "Docker engine already running."; exit 0 }

Write-Host "Stopping leftover Docker Desktop processes..."
Get-Process -Name "Docker Desktop", "com.docker.backend", "com.docker.build", "docker-agent" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
wsl --shutdown
Start-Sleep -Seconds 2

$stamp = Get-Date -Format yyyyMMddHHmmss
foreach ($dir in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
    if (Test-Path $dir) {
        Rename-Item $dir ((Split-Path $dir -Leaf) + "_stale_$stamp") -ErrorAction SilentlyContinue
    }
}

Write-Host "Starting Docker Desktop..."
Start-Process $dockerExe

$deadline = (Get-Date).AddMinutes(4)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (Test-Engine) { Write-Host "Docker engine is up."; exit 0 }
}
Write-Error "Docker engine did not come up within 4 minutes - check %LOCALAPPDATA%\Docker\log\host\monitor.log"
exit 1
