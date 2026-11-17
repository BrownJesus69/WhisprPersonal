@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\switch-to-gpu.ps1" %*
pause
