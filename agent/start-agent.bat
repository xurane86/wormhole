@echo off
rem wormhole agent launcher (Windows)
rem Usage: start-agent.bat [ui-port]
setlocal

cd /d "%~dp0"

set UI_PORT=%1
if "%UI_PORT%"=="" set UI_PORT=7810

set CONFIG=%~dp0agent-config.json

echo ================================================
echo  wormhole agent
echo  UI:     http://127.0.0.1:%UI_PORT%
echo  Config: %CONFIG%
echo ================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Install Node.js 18+ first.
  pause
  exit /b 1
)

if not exist "%~dp0..\node_modules" (
  echo [INFO] Installing dependencies...
  pushd "%~dp0.."
  call npm install --no-audit --no-fund
  popd
)

node "%~dp0index.js" --ui-port %UI_PORT% --config "%CONFIG%"
pause
