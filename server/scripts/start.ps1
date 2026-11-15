# Windows PowerShell 5.1 compatible. Run manually; never edits an existing .env.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Docker Desktop is not running. Start it and re-run start.bat.'
    exit 1
}
# Use cmd for redirection: in PS 5.1, redirecting a native command's stderr under
# ErrorActionPreference=Stop raises NativeCommandError instead of setting $LASTEXITCODE.
& cmd.exe /d /c "docker info >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Docker Desktop is not running. Start it and re-run start.bat.'
    exit 1
}

$envPath = Join-Path (Get-Location) '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    $text = [IO.File]::ReadAllText((Join-Path (Get-Location) '.env.example'))
    $randomBytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
    $generatedSecret = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $text = $text -replace '(?m)^SERVER_SHARED_SECRET=.*$', "SERVER_SHARED_SECRET=$generatedSecret"
    $credentialFiles = @(Get-ChildItem -LiteralPath '..\secrets' -Filter '*.json' -File -ErrorAction SilentlyContinue)
    if ($credentialFiles.Count -eq 1) {
        $credentialName = $credentialFiles[0].Name
        # Only use filenames safe for dotenv values. Never read a credential file.
        if ($credentialName -match '^[A-Za-z0-9_.-]+\.json$') {
            $text = $text -replace '(?m)^FIREBASE_CREDENTIALS_PATH=.*$', "FIREBASE_CREDENTIALS_PATH=/run/secrets/whisprpersonal/$credentialName"
        }
    }
    [IO.File]::WriteAllText($envPath, $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "Server key: $generatedSecret"
    Write-Host "Enter this in the app's Settings; it is NOT in the QR code. Store it privately."
    $generatedSecret = $null
}

New-Item -ItemType Directory -Force -Path 'models', 'data' | Out-Null
$composeFiles = @('-f', 'docker-compose.yml')
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    & cmd.exe /d /c "nvidia-smi >nul 2>&1"
    if ($LASTEXITCODE -eq 0) { $composeFiles += @('-f', 'docker-compose.gpu.yml') }
}
& docker compose @composeFiles up -d --build
if ($LASTEXITCODE -ne 0) { exit 1 }

$port = 8000
if ($env:WHISPRPERSONAL_PORT) { $port = [int]$env:WHISPRPERSONAL_PORT }
# Keep the port consistent with Compose's .env interpolation without changing the file.
elseif (Test-Path -LiteralPath $envPath) {
    foreach ($line in [IO.File]::ReadAllLines($envPath)) {
        if ($line -match '^WHISPRPERSONAL_PORT=(\d+)\s*$') { $port = [int]$Matches[1] }
    }
}
$health = $null
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
        $health = $response.Content | ConvertFrom-Json
        break
    } catch { Start-Sleep -Seconds 2 }
}
if ($null -eq $health) {
    Write-Host 'Health check timed out. Recent server logs:'
    & docker compose @composeFiles logs --tail 50 server
    exit 1
}
$deadline = (Get-Date).AddMinutes(20)
while ($health.model.status -ne 'ready' -and (Get-Date) -lt $deadline) {
    if ($health.model.status -eq 'error') {
        Write-Host "Model error: $($health.model.error). Recent server logs:"
        & docker compose @composeFiles logs --tail 50 server
        exit 1
    }
    Write-Host 'Model loading...'
    Start-Sleep -Seconds 10
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
        $health = $response.Content | ConvertFrom-Json
    } catch { Write-Host 'Waiting for health...' }
}
if ($health.model.status -ne 'ready') {
    Write-Host 'Model readiness timed out. Recent server logs:'
    & docker compose @composeFiles logs --tail 50 server
    exit 1
}
& docker compose @composeFiles exec -T server python -m app.cli selftest
if ($LASTEXITCODE -ne 0) { exit 1 }

$addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and
    $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|Loopback|Tailscale'
} | Sort-Object @{ Expression = { $_.PrefixOrigin -ne 'Dhcp' } }, InterfaceIndex)
foreach ($address in $addresses) {
    Write-Host "LAN URL: http://$($address.IPAddress):$port"
}
if ($addresses.Count -gt 0) {
    $lanUrl = "http://$($addresses[0].IPAddress):$port"
    & docker compose @composeFiles exec -T server python -m app.cli qr $lanUrl
}
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
    $tailscaleIp = & cmd.exe /d /c "tailscale ip -4 2>nul"
    if ($LASTEXITCODE -eq 0 -and $tailscaleIp) {
        Write-Host "Tailscale URL: http://$($tailscaleIp.Trim()):$port"
    }
}
Write-Host "Model: $($health.model.status); queue: $($health.queue.status)."
Start-Process "http://localhost:$port/docs"
