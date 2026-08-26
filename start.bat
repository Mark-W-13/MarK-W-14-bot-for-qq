@echo off
rem ============================================
rem  QQ Agent One-Click Start
rem  1. Start SnowLuma (OneBot backend, port 3000/3001)
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
netstat -ano | findstr ":3000 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto snowluma_ok
echo       Starting SnowLuma ...
start "SnowLuma" /min cmd /c "cd /d %DIR%tools\snowluma && node ./index.mjs"
set /a tries=0
:wait_snowluma
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":3000 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto snowluma_ok
set /a tries+=1
if %tries% lss 30 goto wait_snowluma
echo       [WARN] SnowLuma not ready in 60s, check tools\snowluma\logs
goto check_listener
:snowluma_ok
echo       SnowLuma running (port 3000/3001)

rem ---- 2. monitor console ----
echo [2/3] Checking monitor ...
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*monitor.mjs*' }) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo       monitor already running
) else (
  echo       Opening monitor console ...
  start "QQ Agent Monitor" cmd /k "chcp 65001 >nul && cd /d %DIR%agent && node monitor.mjs"
  echo       Monitor console opened (window: QQ Agent Monitor)
)

rem ---- 3. login status ----
echo [3/3] Checking QQ login status ...
rem for /f 自动去除行尾 CR,%%b 即为纯 token 值
for /f "usebackq tokens=1,* delims==" %%a in ("%DIR%agent\.env") do if "%%a"=="API_TOKEN" set TOKEN=%%b
if not defined TOKEN goto no_token
curl -s --max-time 3 -H "Authorization: Bearer %TOKEN%" http://127.0.0.1:3000/get_login_info
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
