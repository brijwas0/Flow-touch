@echo off
rem Allows the PhoneTouch receiver through Windows Firewall for PRIVATE networks only,
rem and only from devices on your local subnet. Run as administrator ^(right-click, "Run as administrator"^).
rem The firewall stays ON; this adds one narrow rule.
setlocal
net session >nul 2>nul
if errorlevel 1 (
  echo This needs administrator rights. Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
set PORT=47820
if not "%~1"=="" set PORT=%~1
for /f "delims=" %%i in ('where node 2^>nul') do (
  set NODEPATH=%%i
  goto found
)
echo Node.js was not found. Install it first from https://nodejs.org/
pause
exit /b 1
:found
netsh advfirewall firewall delete rule name="PhoneTouch Receiver" >nul 2>nul
netsh advfirewall firewall add rule name="PhoneTouch Receiver" dir=in action=allow protocol=TCP localport=%PORT% profile=private remoteip=LocalSubnet program="%NODEPATH%" enable=yes
if errorlevel 1 (
  echo Could not add the rule.
  pause
  exit /b 1
)
echo.
echo Rule added: inbound TCP %PORT%, Private networks only, local subnet only, program %NODEPATH%
echo Remove it any time with scripts\remove-firewall-rule.bat
pause
