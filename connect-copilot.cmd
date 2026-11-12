@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\connect_copilot.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%CI%"=="1" pause
exit /b %RC%
