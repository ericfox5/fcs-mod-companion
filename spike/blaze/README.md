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

## Run (two terminals, from `spike/blaze/server`)
```
node redirector.mjs             # SSLv3 redirector (forged cert) -> answers getServerInstance with 127.0.0.1:33152
node blaze.mjs                  # plaintext Blaze stub on 33152 (second terminal)
node qos.mjs                    # QoS ping site on 17502 udp+tcp (third terminal); the client probes it right after login
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
