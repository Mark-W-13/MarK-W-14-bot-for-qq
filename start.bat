@echo off
rem ============================================
rem  QQ Agent One-Click Start
rem  1. Start SnowLuma (OneBot backend, port 3000/3001)
rem     - NEVER start a second instance: if port 5099 (WebUI) is up,
rem       another SnowLuma is already booting, so we only wait.
rem       Two concurrent SnowLuma processes fight over the QQ hook
rem       pipe; the older one silently exits (flashes away).
rem     - QQ must be logged in (hook loaded) for the bridge to start;
rem       cold QQ login can take ~40s, so we wait up to 60s.
rem  2. Open monitor console (agent\monitor.mjs)
rem     - listens @mentions, replies Shiji-style
rem     - press q to quit, Q to quit + stop SnowLuma
rem  3. Check QQ login status
rem ============================================
title QQ Agent Start
cd /d "%~dp0"
set DIR=%~dp0

echo ================================================
echo   QQ Agent One-Click Start
echo ================================================

rem ---- 1. SnowLuma backend ----
echo [1/3] Checking SnowLuma ...
netstat -ano -p tcp | findstr /c:":3000 " | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 goto snowluma_ok
rem OneBot down but WebUI up = SnowLuma is still booting:
rem never spawn a second instance (the older one will exit).
netstat -ano -p tcp | findstr /c:":5099 " | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 goto wait_snowluma
echo       Starting SnowLuma ...
rem NO auto-inject: only the bot QQ window (3757588606) may hold the hook;
rem it is loaded once via WebUI, then SnowLuma adopts the pipe on start
start "SnowLuma" /min cmd /c "cd /d %DIR%tools\snowluma && node ./index.mjs"
:wait_snowluma
set /a tries=0
:wait_loop
ping -n 1 127.0.0.1 >nul
netstat -ano -p tcp | findstr /c:":3000 " | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 goto snowluma_ok
set /a tries+=1
if %tries% equ 20 echo       ... still waiting (cold QQ login can take ~40s)
if %tries% lss 60 goto wait_loop
echo       [WARN] SnowLuma not ready after ~60s
echo             Check tools\snowluma\logs and make sure QQ is logged in first
goto monitor_check
:snowluma_ok
echo       SnowLuma running (port 3000/3001)

:monitor_check
rem ---- 2. monitor console ----
echo [2/3] Checking monitor ...
rem check by process commandline, not window title (tasklist /v title is unreliable)
rem wmic removed on Win11 24H2+, use PowerShell Get-CimInstance (exit 0 = found)
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*monitor.mjs*' }) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo       monitor already running
) else (
  echo       Opening monitor console ...
  start "QQ Agent Monitor" cmd /k "chcp 65001 >nul && cd /d %DIR%agent && node monitor.mjs"
  echo       Monitor console opened (window: QQ Agent Monitor)
)

rem ---- 3. login status ----
echo [3/3] Checking QQ login status ...
rem for /f strips trailing CR, %%b is the plain token value
for /f "usebackq tokens=1,* delims==" %%a in ("%DIR%agent\.env") do if "%%a"=="API_TOKEN" set TOKEN=%%b
if not defined TOKEN goto no_token
curl -s --max-time 2 -H "Authorization: Bearer %TOKEN%" http://127.0.0.1:3000/get_login_info
echo.
goto login_done
:no_token
echo       [skip] agent\.env missing API_TOKEN, skip login check
:login_done

echo ================================================
echo   Started. Bot replies with Shiji-style summary
echo   when @mentioned in group.
echo   Monitor window keys:  q = quit
echo                         Q = quit + stop SnowLuma
echo ================================================
pause
