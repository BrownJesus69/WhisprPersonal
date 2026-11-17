# Windows PowerShell 5.1 compatible. Read-only: checks that the phone can reach this laptop's
# server from outside home over Tailscale, and prints the Tailscale address plus its QR.
# Changes nothing. Never reads .env or prints the server key.
param([int]$Port = 0)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if ($Port -le 0) { $Port = if ($env:WHISPRPERSONAL_PORT) { [int]$env:WHISPRPERSONAL_PORT } else { 8000 } }

$problems = 0
function Ok([string]$text) { Write-Host "[ OK ] $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "[WARN] $text" -ForegroundColor Yellow }
function Fail([string]$text) { Write-Host "[FAIL] $text" -ForegroundColor Red; $script:problems++ }

# 1. Tailscale installed and signed in on this laptop.
$tailscaleUrl = $null
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscale) {
    # Not on PATH (e.g. installed to another drive): find it next to the Tailscale service.
    $service = Get-CimInstance Win32_Service -Filter "Name='Tailscale'" -ErrorAction SilentlyContinue
    if ($service -and $service.PathName -match '^"?(.+\\)tailscaled\.exe') {
        $candidate = Join-Path $Matches[1] 'tailscale.exe'
        if (Test-Path -LiteralPath $candidate) { $tailscale = Get-Item -LiteralPath $candidate }
    }
}
if (-not $tailscale) {
    Fail 'Tailscale is not installed. Get it from https://tailscale.com/download and sign in.'
} else {
    $exe = if ($tailscale.Source) { $tailscale.Source } else { $tailscale.FullName }
    $json = & cmd.exe /d /c "`"$exe`" status --json 2>nul"
    $status = $null
    if ($LASTEXITCODE -eq 0 -and $json) { $status = ($json -join "`n") | ConvertFrom-Json }
    if ($null -eq $status -or $status.BackendState -ne 'Running') {
        $state = if ($status) { $status.BackendState } else { 'unknown' }
        Fail "Tailscale is installed but not connected (state: $state). Open Tailscale and sign in."
    } else {
        $ip = @($status.Self.TailscaleIPs | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0]
        $dns = ([string]$status.Self.DNSName).TrimEnd('.')
        $tailscaleUrl = "http://${ip}:$Port"
        Ok "Tailscale connected: $tailscaleUrl"
        if ($dns) { Ok "Same laptop by name (MagicDNS): http://${dns}:$Port" }
        $phones = @($status.Peer.PSObject.Properties | ForEach-Object { $_.Value } |
            Where-Object { $_.OS -eq 'android' })
        if ($phones.Count -eq 0) {
            Fail 'No Android phone in your tailnet. Install Tailscale on the phone and sign in with the same account.'
        } else {
            foreach ($phone in $phones) {
                $name = ([string]$phone.HostName)
                if ($phone.Online) { Ok "Phone in tailnet and online: $name" }
                else { Warn "Phone in tailnet but offline right now: $name (open Tailscale on the phone)" }
            }
        }
    }
}

# 2. Server answers on the Tailscale address (proves the server and port binding, not the phone's path).
if ($tailscaleUrl) {
    try {
        $health = (Invoke-WebRequest -UseBasicParsing -Uri "$tailscaleUrl/health" -TimeoutSec 5).Content | ConvertFrom-Json
        Ok "Server answers on the Tailscale address (status: $($health.status), model: $($health.model.status))."
    } catch {
        Fail "Server does not answer on $tailscaleUrl. Start it with start.bat."
    }
}

# 3. Server comes back by itself after a reboot.
$nativeTask = Get-ScheduledTask -TaskName 'WhisprPersonal server' -ErrorAction SilentlyContinue
if ($nativeTask) {
    # Native GPU mode (switch-to-gpu.bat): a sign-in task starts the server; Docker is not used.
    if ($nativeTask.State -ne 'Disabled') { Ok 'Server starts on the GPU when you sign in to Windows (task "WhisprPersonal server").' }
    else { Fail 'The "WhisprPersonal server" sign-in task is disabled: enable it in Task Scheduler.' }
} else {
    $dockerSettings = Join-Path $env:APPDATA 'Docker\settings-store.json'
    if (Test-Path -LiteralPath $dockerSettings) {
        $autoStart = (Get-Content -LiteralPath $dockerSettings -Raw | ConvertFrom-Json).AutoStart
        if ($autoStart -eq $true) { Ok 'Docker Desktop starts when you sign in to Windows.' }
        else { Fail 'Docker Desktop does not start at sign-in: Docker Desktop > Settings > General > "Start Docker Desktop when you sign in".' }
    } else {
        Warn 'Could not read Docker Desktop settings; make sure it starts when you sign in.'
    }
    & cmd.exe /d /c "docker inspect -f {{.HostConfig.RestartPolicy.Name}} server-server-1 >nul 2>&1"
    if ($LASTEXITCODE -eq 0) {
        $policy = (& docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' server-server-1).Trim()
        if ($policy -in @('unless-stopped', 'always')) { Ok "Server container restarts automatically ($policy)." }
        else { Fail "Server container restart policy is '$policy'; expected unless-stopped." }
    }
}

# 4. Laptop stays awake while you are out.
$sleepAc = (& powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String 'Current AC Power Setting Index: (0x[0-9a-f]+)').Matches
if ($sleepAc.Count -gt 0) {
    $seconds = [Convert]::ToInt32($sleepAc[0].Groups[1].Value, 16)
    if ($seconds -eq 0) { Ok 'Plugged in, the laptop never sleeps on its own.' }
    else { Fail "Plugged in, the laptop sleeps after $([int]($seconds / 60)) min: Settings > System > Power > set sleep to Never when plugged in." }
} else {
    Warn 'Could not read the sleep setting; set sleep to Never when plugged in.'
}
Warn 'Leave the laptop plugged in with the lid open, or set "When I close the lid" to "Do nothing" when plugged in.'

if ($tailscaleUrl) {
    Write-Host ''
    Write-Host "Use this address in the app (works at home and outside): $tailscaleUrl"
    if ($nativeTask) { & (Join-Path (Get-Location) '.venv\Scripts\python.exe') -m app.cli qr $tailscaleUrl }
    else { & docker compose -f docker-compose.yml exec -T server python -m app.cli qr $tailscaleUrl }
}
Write-Host ''
if ($problems -eq 0) { Write-Host 'Remote access ready. Final check: on mobile data, tap Test connection in the app.' }
else { Write-Host "$problems problem(s) to fix (see FAIL lines above)." }
exit [int]($problems -gt 0)
