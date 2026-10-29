@echo off
rem Removes the firewall rule created by add-firewall-rule.bat. Run as administrator.
net session >nul 2>nul
if errorlevel 1 (
  echo This needs administrator rights. Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="PhoneTouch Receiver"
pause
