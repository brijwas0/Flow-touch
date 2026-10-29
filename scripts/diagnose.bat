@echo off
rem Prints the information needed to fix connection problems. Changes nothing.
setlocal
cd /d "%~dp0..\windows"
set PORT=47820
if not "%~1"=="" set PORT=%~1

echo ============ PhoneTouch diagnostics ============
echo.
echo [1] Node.js
where node >nul 2>nul && (node -v) || echo   Node.js NOT FOUND - install the LTS from https://nodejs.org/
echo.
echo [2] This PC's IPv4 addresses ^(the phone must be on the same network as one of these^)
ipconfig | findstr /i /c:"IPv4" /c:"adapter"
echo.
echo [3] Network profile ^(must be "Private" for the firewall rule below to apply^)
powershell -NoProfile -Command "Get-NetConnectionProfile | Format-Table Name,InterfaceAlias,NetworkCategory -AutoSize" 2>nul
echo.
echo [4] Anything already listening on port %PORT%?
netstat -ano -p tcp | findstr /c:":%PORT% " || echo   Nothing is listening on port %PORT% ^(the receiver is not running, or uses another port^).
echo.
echo [5] Firewall rule
netsh advfirewall firewall show rule name="PhoneTouch Receiver" | findstr /i /c:"Rule Name" /c:"Enabled" /c:"Profiles" /c:"LocalPort" /c:"RemoteIP" /c:"Action" || echo   No "PhoneTouch Receiver" rule. If the phone cannot connect, run scripts\add-firewall-rule.bat as administrator.
echo.
echo [6] Receiver health check on this PC
node scripts\health.js %PORT%
echo.
echo Hints:
echo  - "Not reachable" in step 6 means the receiver is not running: start scripts\start-receiver.bat
echo  - Receiver healthy here but the phone times out: firewall, a "Public" network profile, or Wi-Fi
echo    client/AP isolation ^(guest networks, some routers, hotel/campus Wi-Fi^).
echo  - Phone and PC must be on the same Wi-Fi/subnet; mobile data does not work.
echo.
pause
