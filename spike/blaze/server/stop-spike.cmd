@echo off
rem Stops only the spike listeners and the site sync (matches their script names), not other node processes.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'redirector\.mjs|blaze\.mjs|qos\.mjs|cli\.ts od watch' } | ForEach-Object { Write-Host ('stopping ' + $_.ProcessId + ': ' + $_.CommandLine); Stop-Process -Id $_.ProcessId -Force }"
