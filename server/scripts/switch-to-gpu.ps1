# Windows PowerShell 5.1 compatible. Moves the server from Docker (CPU) to Windows (GPU):
#   1. stops the Docker container (it stays stopped; switch-to-docker.ps1 undoes all of this),
#   2. registers a "WhisprPersonal server" task that starts the server when you sign in,
#   3. starts it now and waits until speech recognition is ready on the GPU.
# Run it while you are at the laptop: Windows Firewall may ask once whether Python may accept
# connections. Tick "Private networks" (that is where Tailscale is) and click Allow.
$ErrorActionPreference = 'Stop'
$server = Split-Path $PSScriptRoot -Parent
Set-Location $server
$port = 8000

if (Get-Command docker -ErrorAction SilentlyContinue) {
    & cmd.exe /d /c "docker inspect -f {{.State.Running}} server-server-1 >nul 2>&1"
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'Stopping the Docker server...'
        & docker compose -f docker-compose.yml stop
    }
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
Write-Host 'Starting the server on the GPU. If Windows asks about Python, tick Private networks and click Allow.'
$deadline = (Get-Date).AddMinutes(5)
$health = $null
while ((Get-Date) -lt $deadline) {
    try {
        $health = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3).Content | ConvertFrom-Json
        if ($health.model.status -in @('ready', 'error')) { break }
    } catch { }
    Start-Sleep -Seconds 3
}
if ($null -eq $health -or $health.model.status -ne 'ready') {
    Write-Host 'The server did not become ready. See server\data\logs\server-native.log, or run switch-to-docker.bat to go back.'
    exit 1
}
Write-Host "Ready: $($health.model.name) on $($health.model.device_resolved) ($($health.model.compute_type))."
Write-Host ''
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'remote-check.ps1')
