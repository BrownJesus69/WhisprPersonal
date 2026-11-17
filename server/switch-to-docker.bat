@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\switch-to-docker.ps1" %*
pause
