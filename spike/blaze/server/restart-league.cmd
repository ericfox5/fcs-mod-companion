@echo off
rem Restarts the league server now, even with a console connected (code changes otherwise reload by themselves).
node "%~dp0league.mjs" restart %*
if errorlevel 1 pause
