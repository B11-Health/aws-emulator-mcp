@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0demo.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%CI%"=="1" pause
exit /b %RC%
