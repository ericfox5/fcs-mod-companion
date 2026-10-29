# Opens one PowerShell window per listener (redirector 42127, blaze 33152 + locker HTTP 17503, qos 17502) plus the
# site sync (`ncaa-bridge od watch`: mirrors every advance and uploaded result to the companion site). Run from any folder.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $dir '..\..\..')).Path
foreach ($svc in @('redirector.mjs', 'blaze.mjs', 'qos.mjs')) {
  Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', "Set-Location -LiteralPath '$dir'; `$host.UI.RawUI.WindowTitle = '$svc'; node $svc"
}
Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', "Set-Location -LiteralPath '$root'; `$host.UI.RawUI.WindowTitle = 'site sync (ncaa-bridge od watch)'; npx tsx bridge/src/cli.ts od watch"
Write-Host "Started redirector, blaze, qos and the site sync in four windows. Close them (or Ctrl+C) to stop."
