@echo off
rem Stops the league server window (and any leftover start-spike windows).
node "%~dp0league.mjs" stop
if errorlevel 1 pause
