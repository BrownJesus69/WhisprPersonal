# Windows PowerShell 5.1 compatible. Undoes switch-to-gpu.ps1: removes the sign-in task, stops the
# native server, and starts the Docker server again (CPU).
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-native.ps1')
if (Get-ScheduledTask -TaskName 'WhisprPersonal server' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'WhisprPersonal server' -Confirm:$false
    Write-Host 'Auto-start at sign-in: removed.'
}
& docker compose -f docker-compose.yml up -d
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker could not start the server. Is Docker Desktop running?'; exit 1 }
Write-Host 'Docker server started (CPU).'
