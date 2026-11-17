# Windows PowerShell 5.1 compatible. Stops the native (Windows) server started by start-native.ps1:
# first its restart loop, then the uvicorn process tree. Only processes started from
# server\.venv are touched (the translator also runs "uvicorn app.main:app", from its own venv).
$ErrorActionPreference = 'Stop'
$venv = Join-Path (Split-Path $PSScriptRoot -Parent) '.venv'
$task = Get-ScheduledTask -TaskName 'WhisprPersonal server' -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName 'WhisprPersonal server' }
$all = @(Get-CimInstance Win32_Process)
$loops = @($all | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'start-native\.ps1' })
# The venv python.exe is a launcher; it starts the base interpreter as its child, which serves.
$launchers = @($all | Where-Object {
    $_.Name -eq 'python.exe' -and $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($venv, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -match 'uvicorn app\.main:app'
})
$launcherIds = @($launchers | ForEach-Object { $_.ProcessId })
$children = @($all | Where-Object { $launcherIds -contains $_.ParentProcessId })
$targets = @($loops) + @($children) + @($launchers)
foreach ($process in $targets) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Stopped $($targets.Count) native server process(es)."
