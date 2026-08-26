@echo off
rem ============================================
rem  QQ Agent Backup Stop
rem  Stop monitor (optional: also SnowLuma)
rem  Primary stop: press q/Q in the monitor window
rem ============================================
title QQ Agent Stop
cd /d "%~dp0"
set DIR=%~dp0

echo [1/2] Stopping monitor ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*monitor.mjs*' -or $_.CommandLine -like '*listener.mjs*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Remove-Item '%DIR%agent\listener.pid' -ErrorAction SilentlyContinue" >nul 2>&1
echo       Monitor stopped

choice /c YN /m "Also stop SnowLuma backend (Y/N)"
if errorlevel 2 goto done
echo [2/2] Stopping SnowLuma (port 3000) ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 .*LISTENING"') do taskkill /PID %%a /F >nul 2>&1
echo       SnowLuma stopped

:done
echo ================================================
echo   Stopped. Use start.bat to start again.
echo ================================================
pause
