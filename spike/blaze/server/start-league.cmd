@echo off
rem Starts the league server in its own window (league.mjs). Double-click or run from anywhere.
node "%~dp0league.mjs" start %*
if errorlevel 1 pause
