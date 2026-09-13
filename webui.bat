@echo off
rem ============================================
rem  Bot Ops WebUI One-Click Start (Windows 本地)
rem
rem  线上机器人的两个 WebUI 都只绑服务器的 127.0.0.1,
rem  本机要看得先开 SSH 隧道。本脚本只开运维 WebUI:
rem
rem    本机 127.0.0.1:8090 --SSH隧道--> 服务器 127.0.0.1:8090 (opsweb)
rem
rem  看状态 / 切搬屎·框神语录 / 重启服务 / 更新卡库 / 看 QQ 截图 / 看日志
rem  (SnowLuma 自己的 WebUI 在 5099,要用就手动:ssh -N -L 5099:127.0.0.1:5099)
rem
rem  用法:
rem    双击          开隧道 + 开浏览器(已在跑则直接开浏览器)
rem    webui.bat /stop   只关隧道
rem
rem  免密登录靠本机 ~/.ssh/id_ed25519 的公钥已装到服务器 w-13 的
rem  authorized_keys(2026-09-12 装好,存档见 服务器凭据(勿外传).txt)。
rem  换机器/公钥失效时,隧道窗口里会直接报 Permission denied。
rem
rem  登录口令:opsweb 自己的令牌,在服务器 ~/mc_agent/agent/.env 的
rem  OPSWEB_TOKEN(本机副本没有这一项)。
rem ============================================
title Bot Ops WebUI
cd /d "%~dp0"
set DIR=%~dp0
set PORT=8090
set SRV=w-13@192.144.153.94
set KEY=%USERPROFILE%\.ssh\id_ed25519
set URL=http://127.0.0.1:8090

echo ================================================
echo   Bot Ops WebUI  (SSH tunnel -^> %SRV%:%PORT%)
echo ================================================

if /i "%~1"=="/stop" goto stop
if /i "%~1"=="-stop" goto stop

rem ---- 1. tunnel ----
echo [1/3] Checking tunnel ...
netstat -ano -p tcp | findstr /c:":8090 " | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 goto tunnel_ok

if not exist "%KEY%" goto no_key
echo       Opening SSH tunnel ...
rem ExitOnForwardFailure: 远端端口被占时立刻退出,不静默挂一个坏隧道
rem -N 不开远端 shell  -x 不要 X11  -o BatchMode 绝不弹口令
start "OpsWeb Tunnel" /min cmd /c "ssh -i "%KEY%" -N -x -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L %PORT%:127.0.0.1:%PORT% %SRV%"

:tunnel_ok
rem ---- 2. wait for service ----
echo [2/3] Waiting for WebUI ...
set /a tries=0
:wait_loop
netstat -ano -p tcp | findstr /c:":8090 " | findstr /c:"LISTENING" >nul 2>&1
if errorlevel 1 goto wait_next
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',8090);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto web_ok
:wait_next
set /a tries+=1
if %tries% equ 8 echo       ... 服务器无响应,检查隧道窗口(可能公钥失效或服务器 down)
if %tries% geq 25 goto web_timeout
ping -n 2 127.0.0.1 >nul
goto wait_loop

:web_ok
echo       WebUI responding on %URL%

rem ---- 3. browser ----
echo [3/3] Opening browser ...
start "" "%URL%"
echo.
echo ================================================
echo   已就绪:%URL%
echo   首次访问要输 opsweb 令牌(服务器 ~/mc_agent/agent/.env
echo   的 OPSWEB_TOKEN),浏览器可记住。
echo.
echo   隧道是那个最小化的 "OpsWeb Tunnel" 窗口,
echo   关掉它就断了;或跑 webui.bat /stop
echo ================================================
ping -n 13 127.0.0.1 >nul
exit /b 0

:web_timeout
echo       [WARN] 隧道起了但 WebUI 无响应
echo              看 "OpsWeb Tunnel" 窗口的报错;服务器上查:
echo              systemctl --user status opsweb
echo.
pause
exit /b 1

:no_key
echo       [ERROR] 找不到 %KEY%
echo               本机免密登录靠这个私钥。没配过就先:
echo               1) ssh-keygen -t ed25519 生成
echo               2) 把 .pub 内容追加到服务器 ~/.ssh/authorized_keys
echo               或参考 服务器凭据(勿外传).txt 用手动隧道:
echo               ssh -N -L 8090:127.0.0.1:8090 %SRV%
echo.
pause
exit /b 1

:stop
echo [stop] Closing tunnel ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*8090:127.0.0.1:8090*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
echo        Tunnel closed
ping -n 4 127.0.0.1 >nul
exit /b 0
