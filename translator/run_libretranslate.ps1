$ErrorActionPreference = 'Stop'
$env:XDG_DATA_HOME = 'E:/whispr-models/argos/share'
$env:XDG_CONFIG_HOME = 'E:/whispr-models/argos/config'
$env:XDG_CACHE_HOME = 'E:/whispr-models/argos/cache'
Push-Location $PSScriptRoot
try {
    & "$PSScriptRoot/libretranslate/.venv/Scripts/libretranslate.exe" --host 127.0.0.1 --port 5000 --load-only en,hi --disable-web-ui
} finally { Pop-Location }
