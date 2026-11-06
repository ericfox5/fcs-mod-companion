@echo off
rem Starts the FCS Uniform Studio server and opens it in the default browser. Close this window to stop it.
cd /d "%~dp0"
node serve.mjs --open %*
pause
