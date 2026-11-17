# Windows PowerShell 5.1 compatible. Moves transcription from Docker (CPU) to Windows (GPU):
#   1. stops the Docker server (so two servers never share the database),
#   2. registers a "WhisprPersonal server" task that starts the GPU server when you sign in,
#   3. starts the GPU server on 127.0.0.1:8001 and waits until speech recognition is ready,
#   4. starts a small Docker relay on port 8000 (the address the phone already uses).
# Nothing needs approving on the laptop: the GPU server only listens on loopback, and Docker is
# already allowed through Windows Firewall. switch-to-docker.ps1 undoes all of this.
$ErrorActionPreference = 'Stop'
$server = Split-Path $PSScriptRoot -Parent
Set-Location $server

function Wait-Health([string]$url, [int]$minutes) {
    $deadline = (Get-Date).AddMinutes($minutes)
    while ((Get-Date) -lt $deadline) {
        try {
            $h = (Invoke-WebRequest -UseBasicParsing -Uri "$url/health" -TimeoutSec 3).Content | ConvertFrom-Json
            if ($h.model.status -in @('ready', 'error')) { return $h }
        } catch { }
        Start-Sleep -Seconds 3
    }
    return $null
}

& cmd.exe /d /c "docker inspect -f {{.State.Running}} server-server-1 >nul 2>&1"
if ($LASTEXITCODE -eq 0) {
    Write-Host 'Stopping the Docker server...'
    & docker compose -f docker-compose.yml stop
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the Docker server.' }
}

$startScript = Join-Path $PSScriptRoot 'start-native.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`"" -WorkingDirectory $server
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'WhisprPersonal server' -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Starts the WhisprPersonal server on the GPU when you sign in.' -Force | Out-Null
Write-Host 'Auto-start at sign-in: on ("WhisprPersonal server" in Task Scheduler).'

Start-ScheduledTask -TaskName 'WhisprPersonal server'
$native = Wait-Health 'http://127.0.0.1:8001' 5
if ($null -eq $native -or $native.model.status -ne 'ready') {
    Write-Host 'The GPU server did not become ready. See server\data\logs\server-native.log, or run switch-to-docker.bat.'
    exit 1
}
Write-Host "GPU server ready: $($native.model.name) on $($native.model.device_resolved) ($($native.model.compute_type))."

& docker compose -p whisprpersonal-relay -f docker-compose.relay.yml up -d
if ($LASTEXITCODE -ne 0) { throw 'Could not start the relay on port 8000.' }
$relay = Wait-Health 'http://127.0.0.1:8000' 1
if ($null -eq $relay -or $relay.model.device_resolved -ne $native.model.device_resolved) {
    Write-Host 'The relay on port 8000 is not answering. Run switch-to-docker.bat to go back.'
    exit 1
}
Write-Host 'Phone address unchanged: port 8000 now reaches the GPU server.'
Write-Host ''
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'remote-check.ps1')
