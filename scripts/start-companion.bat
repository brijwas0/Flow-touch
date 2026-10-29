@echo off
rem Starts the PhoneTouch Windows companion app and receiver.
rem Opens the modern companion window and keeps the receiver running in background.
setlocal
cd /d "%~dp0..\windows"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install the LTS version from https://nodejs.org/ , then close and reopen this window.
  pause
  exit /b 1
)

set NODEMAJOR=0
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
if %NODEMAJOR% LSS 22 (
  echo Your Node.js is too old: found version %NODEMAJOR%, need 22 or newer.
  echo Install the current LTS from https://nodejs.org/
  pause
  exit /b 1
)

echo Starting PhoneTouch Companion App...
node server.js %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo The receiver stopped with an error (code %RC%).
  pause
)
exit /b %RC%
