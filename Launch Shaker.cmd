@echo off
setlocal
cd /d "%~dp0"
if /i not "%~1"=="--server" (
  wscript.exe //nologo ".\scripts\launch-hidden.vbs"
  exit /b
)
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-localhost.ps1" -Port 80 -OpenBrowser
