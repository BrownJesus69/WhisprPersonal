# Builds the WhisprPersonal release APK with every cache and temp file on E:.
$ErrorActionPreference = 'Continue'
$cache = 'E:\whispr-build-cache'
$env:ANDROID_HOME = "$cache\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = "$cache\android-user"
$env:GRADLE_USER_HOME = "$cache\gradle"
$env:TEMP = "$cache\tmp"; $env:TMP = $env:TEMP; $env:TMPDIR = $env:TEMP
$env:npm_config_cache = "$cache\npm-cache"
$env:WHISPR_NINJA_JOBS = '6'
$env:NODE_ENV = 'production'
New-Item -ItemType Directory -Force $env:ANDROID_USER_HOME, $env:TEMP, $env:npm_config_cache | Out-Null
Set-Location E:\Whispr\android
Write-Output "prebuild start $(Get-Date -Format o)"
cmd.exe /d /c "npx expo prebuild --platform android --no-install"
if ($LASTEXITCODE -ne 0) { throw "prebuild failed: $LASTEXITCODE" }
$proj = 'E:\Whispr\android\android'
Set-Location $proj; [Environment]::CurrentDirectory = $proj
Write-Output "gradle start $(Get-Date -Format o)"
cmd.exe /d /c "cd /d $proj && $proj\gradlew.bat -p $proj assembleRelease --max-workers=2 --no-parallel -PreactNativeArchitectures=arm64-v8a"
$code = $LASTEXITCODE
cmd.exe /d /c "cd /d $proj && $proj\gradlew.bat -p $proj --stop"
Write-Output "gradle end $(Get-Date -Format o) exit $code"
exit $code
