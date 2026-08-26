@echo off
rem 启动 QQ Agent 监听器(需 SnowLuma 已在运行)
cd /d "%~dp0"
node listener.mjs
pause
