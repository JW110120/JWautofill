@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0uninstall.ps1"
if errorlevel 1 pause
