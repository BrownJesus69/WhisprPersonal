# Windows PowerShell 5.1 compatible. Runs the server directly on Windows so Whisper uses the GPU.
# By default it listens on 127.0.0.1:8001 only; the Docker relay (docker-compose.relay.yml) keeps
# serving the phone on port 8000, so Windows Firewall never has to be asked about Python.
# Inside Docker Desktop (WSL2) every CUDA inference dies with SIGBUS (see docker-compose.yml).
# Uses the same .env, ./data and ./models as Docker. Never prints or edits .env or secrets.
# Restarts the server if it exits, like Docker's restart policy, unless -NoRestart is given.
param(
    [int]$Port = 8001,
    [string]$BindHost = '127.0.0.1',
    [string]$DataDir = '',
    [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$python = Join-Path (Get-Location) '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'server\.venv is missing. Create it as described in server\README.md.' }

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) { Write-Host "Port $Port is already in use (is the Docker server still running?)."; exit 1 }

# The .env holds the Docker path for the Firebase key; point at the same file on Windows.
# Only the file name is used; the key itself is never read here.
$credentialFiles = @(Get-ChildItem -LiteralPath '..\secrets' -Filter '*.json' -File -ErrorAction SilentlyContinue)
if ($credentialFiles.Count -eq 1 -and $credentialFiles[0].Name -match '^[A-Za-z0-9_.-]+\.json$') {
    $env:FIREBASE_CREDENTIALS_PATH = $credentialFiles[0].FullName
}
if ($DataDir) { $env:DATA_DIR = $DataDir }
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
$env:PYTHONUTF8 = '1'

$logDir = if ($DataDir) { Join-Path $DataDir 'logs' } else { Join-Path (Get-Location) 'data\logs' }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'server-native.log'
# Logging must never stop the server: if another program holds the log open, use a fallback file.
function Test-Writable([string]$path) {
    try { $stream = [IO.File]::Open($path, 'Append', 'Write', 'ReadWrite'); $stream.Close(); return $true } catch { return $false }
}
if (-not (Test-Writable $log)) { $log = Join-Path $logDir ("server-native-{0}.log" -f $PID) }
function Write-Log([string]$text) {
    try { Add-Content -LiteralPath $log -Encoding utf8 -Value ("{0} {1}" -f (Get-Date -Format o), $text) -ErrorAction Stop } catch { }
}

do {
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 20MB) {
        try { Move-Item -Force -LiteralPath $log -Destination "$log.1" -ErrorAction Stop } catch { }
    }
    Write-Log "starting server on ${BindHost}:$Port"
    # cmd handles the redirection so native stderr never becomes a PowerShell error record.
    & cmd.exe /d /c "`"$python`" -m uvicorn app.main:app --host $BindHost --port $Port --workers 1 --no-server-header --no-proxy-headers >> `"$log`" 2>&1"
    $code = $LASTEXITCODE
    Write-Log "server exited with code $code"
    if (-not $NoRestart) { Start-Sleep -Seconds 5 }
} while (-not $NoRestart)
exit $code
