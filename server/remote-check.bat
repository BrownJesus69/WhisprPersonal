@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remote-check.ps1" %*
pause
