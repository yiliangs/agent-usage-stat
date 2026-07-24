@echo off
setlocal
title Agent Usage Stat - Usage Portal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :node_missing
where npm >nul 2>nul
if errorlevel 1 goto :node_missing
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto :node_old

for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":4179 "') do goto :already_running

echo.
echo Starting Agent Usage Stat at http://127.0.0.1:4179...
echo Keep this window open while using the fallback server.
echo.
call node "..\bin\agent-usage-stat.js" portal --port 4179
if errorlevel 1 goto :failed
exit /b 0

:already_running
echo.
echo Agent Usage Stat is already running at http://127.0.0.1:4179.
start "" "http://127.0.0.1:4179"
exit /b 0

:node_missing
echo.
echo Node.js 20 or newer is required. Install it from https://nodejs.org and try again.
goto :failed

:node_old
echo.
echo Your Node.js version is too old. Install Node.js 20 or newer and try again.
goto :failed

:failed
echo.
echo Agent Usage Stat did not start. Review the message above.
pause
exit /b 1
