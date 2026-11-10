# Blaze spike (time-boxed: 2 days)

Question: how far does the unmodified NCAA 14 client get against a stub server, and what does it ask for?
Deliverable: a findings log, not a working server. See NOTES.md for what the EBOOT already told us.

## One-time setup (you)
1. In RPCS3 **v0.0.32** (`...\rpcs3-v0.0.32-16709-953af758_win64\rpcs3.exe`): Configuration > RPCN >
   "Create Account" (email + token). This writes `config/rpcn.yml`. Then "Test" to confirm login works.
2. The custom config for NCAA 14 is already written (`config/custom_configs/config_BLUS31159.yml`).
   Check it in the GUI: right-click the game > Change Custom Configuration > Network tab should show
   Network Status = Connected, PSN Status = RPCN, IP/Hosts switches = `gosredirector.ea.com=127.0.0.1&&*.ea.com=127.0.0.1`.
3. Certificates are generated (`server/certs/`). Re-run `node server/gen-cert.mjs` if the folder is empty.

## Run the league server
Double-click `server/start-league.cmd` (or run `node server/league.mjs start`). One "NCAA League Server" window runs
the redirector (42127), the Blaze stub (33152, with the Locker 17503 and the in-game Dynasty Wire 17504), the QoS site
(17502) and the site sync (`ncaa-bridge od watch`), each line tagged with its service. A service that exits restarts by
itself, and code changes reload by themselves: a service restarts when a file it imports changes, but the Blaze stub and
the redirector wait until no console is connected (quit the game), so a game in progress is never cut off.
- `stop-league.cmd` (or closing the window) stops everything; it also closes windows left by the old start-spike.
- `restart-league.cmd` reloads everything now, even with a console connected.
- `league-status.cmd` lists the services, their ports, whether a console is connected and whether RPCN answers.
- The private RPCN server (WSL) is separate and must be running before the game starts.

### A real PS3 on the PC's Ethernet port
The console is plugged straight into the PC with Windows Internet Connection Sharing on (Wi-Fi shared to Ethernet):
the port becomes 192.168.137.1, the PS3 takes 192.168.137.x from it, and its DNS goes through the PC's resolver.
- Start the league with the address the consoles must use: `start-league.cmd --lan 192.168.137.1` (the services
  still listen on every interface; RPCS3 on the same PC also reaches that address while sharing is on).
- The PC's hosts file (`C:\Windows\System32\drivers\etc\hosts`, admin) sends the game to the league server; the sharing
  resolver honours it, so the PS3 needs no DNS settings of its own:
  ```
  192.168.137.1 gosredirector.ea.com
  192.168.137.1 reports.tools.gos.ea.com
  ```
- webMAN MOD serves the console's file system over FTP (port 21) and its web page (port 80); the game lives in
  `dev_hdd0/GAMES/BLUS31159-[NCAA Football 14]/PS3_GAME/USRDIR` and the 1.02 data + DLC in `dev_hdd0/game/BLUS31159/USRDIR`.
  Mirror the FCS build from the RPCS3 install (5 disc archives: boot, fe2ig, interface, misc, stream; qkl_patch.ast; the FCS_DLC folders). With curl,
  pass `-g`: the brackets in the RPCS3 disc path are read as a URL pattern otherwise.
- **Every DLC folder on a real PS3 needs one licensed `.edat` file.** When the game scans `USRDIR/DLC`, it runs
  sceNpDrmIsAvailable on the files of each folder and skips the whole folder unless one of them is a licensed EDAT.
  RPCS3 passes plain files ("Assuming npdrm file is unencrypted"), so the FCS mod's folders work there. On the PS3,
  folders with only plain files are ignored: their teams show the archive's uniforms or crash for missing parts. Fix:
  copy `FCS_DLC_BIGSKY/EWUXXX_GLOVES_2022_BLACK_BIG.ast.edat` (the mod's own, NPD v3, free licence, 32 KB) into every
  `FCS_DLC_*` folder under the same name; an EDAT is bound to its file name, so never rename it.
- A VPN that blocks LAN traffic (Proton VPN without "Allow LAN connections") makes every local address unreachable
  with "forbidden by its access permissions"; disconnect it or allow LAN.
- Experimental physical-console adapter: see [implementation, builds and validation](../../docs/ps3-no-psn-research.md).
  Personalized ELFs and signed experimental APP SELF test builds now include game-local NP behavior and the offseason fix.
  QEMU, isolated server, decrypt-back and signature checks pass; full-game signed-out and HEN loader tests remain pending. The new server mode requires
  `--ticket-registry <private-registry.json> --easw off`; legacy arbitrary-ticket login is not secure authentication.

Single listeners, for debugging (from `spike/blaze/server`):
```
node redirector.mjs             # SSLv3 redirector (forged cert) -> answers getServerInstance with 127.0.0.1:33152
node blaze.mjs                  # plaintext Blaze stub on 33152
node qos.mjs                    # QoS ping site on 17502 udp+tcp; the client probes it right after login
node redirector.mjs --peek      # diagnostic only: prints the raw ClientHello and closes (done: SSLv3, RC4-SHA first)
node sslv3-selftest.mjs         # proves the SSLv3 implementation against a matching client
```
Then boot NCAA 14, go to the online menu (EA SPORTS Online / Online Dynasty) and watch the console output.
RPCS3's own log (`RPCS3.log`) has `DnsHook: DNS query for ...` lines showing every hostname the game resolves.

## What to record (in docs/experiments.md and spike/blaze/private/capture-*.jsonl)
- Does `DnsHook` log a query for gosredirector.ea.com? (If not: config not applied / game never tried.)
- ClientHello: SSLv3 or TLS 1.x? Which cipher suites? (TLS 1.0+ with AES/3DES/RC4 => Node can serve it;
  SSLv3-only => we need a custom SSLv3 implementation before going further.)
- Does the handshake complete with the forged certificate? (Alert/RST right after the certificate =>
  this ProtoSSL build is patched; stop here and note it.)
- The redirector request body: `NAME` (service name), `CLNT`, `BSDK`, `PLAT` tags.
- Every `(component, command)` the client sends to the Blaze stub after preAuth, and the first one we fail.

Hard stop after two days of effort. Keep the ELF, strings dumps and captures private.
