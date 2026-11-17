# Online league: how a member's game signs in, and what the wizard does

Status (2026-11-15): **designed, built into `FCS-online.exe join`, tested without the game.** The one thing nobody has
done yet is boot the game in RPCS3 with the personal patch entry; the checklist at the end is that test.

## What a member does

1. Signs up on the companion site and copies their **join code** (or downloads `fcs-online-profile.json`).
2. Runs `FCS-online.exe`, picks **2. Join the online league**, confirms the RPCS3 folder, pastes the code.
3. Starts the game and chooses Online Dynasty.

No RPCN account, no PSN, no address to type. The wizard ends with "YOU'RE READY" or one specific thing to fix.

## The mechanism: the NP adapter as a personal RPCS3 patch entry

The game-local NP adapter (`spike/blaze/tools/ps3-np-adapter.py`, `docs/ps3-no-psn-research.md`) replaces the game's
direct `sceNpManager*` calls with code that says "signed in, this name, this ticket", where the ticket is the member's
72-byte league credential. It was built as a personalized ELF for the PS3 and ran there. For RPCS3 the wizard writes
the same code as an ordinary patch entry in `patches/imported_patch.yml`:

- `spike/blaze/tools/np-adapter-rpcs3.mjs` is the Python builder ported to JavaScript in two halves. `extractTemplate`
  runs on the build PC against the stock decrypted 1.02 executable and keeps only addresses (50 call sites, 13 import
  stubs, the two cellRtc stubs, where code and state go). `adapterWords(template, profile)` runs on the member's PC and
  assembles the adapter for their profile. The exe carries the template; the member's PC never needs the executable.
- The entry is 1,004 `be32` words for a typical profile: 50 redirected calls, one NOP at `0x719560`, the code at
  `0x1bc26f0`. It is named `FCS online: league sign-in (personal, do not share)`.

### Why RPCS3 can load it without a modified file

The ELF builder had to extend the RX and RW segment sizes, because the code sits in the gap after the RX segment
(`0x1bc26f0`, the segment ends at `0x1bc26e8`) and its 128 bytes of state sit after `.bss` (`0x1d61150`, the RW segment
ends at `0x1d61148`). RPCS3 needs neither extension. Read in the RPCS3 source at tag `v0.0.29` (the version members
run) and at `master`; the code is the same in both:

| Question | Answer in the source |
|---|---|
| Is the memory there? | `vm.cpp` `block_t::falloc` rounds every allocation in the main block up to 64 KB pages. The RX segment (`0x10000`, size `0x1bb26e8`) is mapped through `0x1bcffff`, the RW segment (`0x1bd0000`, size `0x191148`) through `0x1d6ffff`. Both tails are fresh zero pages. |
| Will the patch engine write there? | The executable's patches are applied through `ppu_module::get_ptr` (`PPUAnalyser.h`), which accepts `addr <= align(seg_addr + seg_size, 0x10000) - size`: the 64 KB tail is explicitly allowed. `PPUModule.cpp` `ppu_load_exec` calls `patch_engine::apply` with no file-size limit for the main executable. |
| Is it executable? | `PPUThread.cpp` `ppu_register_range` aligns the executable segment to 64 KB, marks the pages executable and fills the function table with the interpreter fallback. |
| How does compiled code reach it? | `PPUTranslator.cpp` `CallFunction`: a `bl` whose target is outside the first segment's size is compiled as a lookup in the function table. The table entry is `ppu_recompiler_fallback`, which interprets instruction by instruction until it reaches an address that has compiled code (the return address region). The analyser logs `Invalid branch at ... -> 0x1bc2...` for each of the 50 calls and carries on (`PPUAnalyser.cpp`); that warning is expected. |
| Does the state need a patch word? | No. It is zero-filled and only addressed by the code; the entry never writes it. |

So no `alloc` / code-cave patch type is needed and the addresses are the ones already proven on the console. The hooks
are short and run a few times per sign-in, so interpreting them costs nothing noticeable.

The words are **identical** to the PS3 build: `np-adapter-rpcs3.test.mjs` builds a personalized ELF with the Python
tool from the private stock ELF and checks that every word the patch entry writes is the word in that ELF, and that the
ELF differs from the mod baseline nowhere else except the three program-header sizes RPCS3 does not need.

### Options that were not chosen

- **A personalized executable for RPCS3.** Works in principle (RPCS3 boots a decrypted `EBOOT.elf`), but the member's
  PC would need the decrypted executable, the PPU hash changes so every mod patch entry would have to be baked in too,
  and the wizard would be modifying a game file. More moving parts for the same result.
- **Keeping RPCN and verifying ticket signatures.** RPCN signs tickets (ECDSA), so the server could verify them, but the
  league would have to run a public RPCN server, every member would still create an RPCN account by hand, the site
  account would have to be tied to the RPCN account, and RPCS3 0.0.29 speaks an old RPCN protocol. It fails the
  "no manual account, no RPCN server" goal.

## What the wizard does (`FCS-online.exe join`)

1. Finds RPCS3 (or `--rpcs3 DIR`).
2. Gets the profile: `--profile FILE` / `--code -` (the join code on standard input) / `--code FCS1-...`, else the
   profile already saved on this PC, else a `fcs-online-profile.json` in Downloads or on the Desktop, else a pasted join
   code (the paste is not shown on screen) or a typed file path. A bad profile gets a specific message: not a join code,
   cut off (with the number of characters that arrived), wrong version, expired (with the date), damaged key, bad
   server name.
3. Says whose sign-in this is, by in-game name and member number (never the key), and that a member must only use a
   code from their own account page: with a code somebody sent them, they would be playing as the sender. In a console
   it asks for a yes. If another member's profile is saved on this PC, it says that profile will be replaced, names
   both, and the question defaults to No. With `--yes` the lines are printed and the install goes ahead.
4. Refuses a profile whose server is not `fcs-mod.online` or a name under it, with the reason, unless the member accepts
   that address by name (`--trust-server` when non-interactive). Compared in lower case; never official: a name with
   non-English (look-alike) letters, a punycode `xn--` part, a trailing dot, a user name, password, port or path, or an
   address in numbers. Of these, only a punycode name and an ordinary IPv4 address are accepted in a profile at all
   (as "not the league's server").
5. Installs the mod patch entries as before, plus the personal sign-in entry, and ticks them in
   `config/patch_config.yml`. Only this game's section of either file is rewritten. `patches/imported_patch.yml` now
   holds the key, so its access is limited to the member's Windows account (`signout` puts the folder's normal access
   back).
6. Uniforms, score bug, generic rosters, roster save, swaps, playbooks: unchanged.
7. Network, in the game's custom configuration: `Internet enabled: Connected`, `PSN status: Disconnected`,
   `IP swap list: "gosredirector.ea.com=<IPv4>&&*.ea.com=<IPv4>"`. A missing custom configuration is created as a copy
   of the global `config.yml`, like RPCS3's own "Create Custom Configuration". `rpcn.yml` is left alone.
8. Saves the profile to `%LOCALAPPDATA%\ncaa-bridge\online\fcs-online-profile.json` with access for this Windows
   account only (`icacls /grant:r`, then `/inheritance:r`; icacls is started by its full path under
   `%SystemRoot%\System32`, like every Windows tool the wizard uses, never by bare name). Next to it, `last-join.json`
   records which RPCS3 folder was set up, the server name and the address written (no key).
9. Checks TCP 42127, 33152, 17503, 17502, UDP 17502 (a QoS ping) and TCP 17504 (optional: off when the server runs
   `--easw off`) and prints the verdict. Exit code 0 when ready, 2 when not.

**The swap list needs an address, not a name.** RPCS3 reads the right-hand side with `inet_pton`
(`Emu/NP/np_dnshook.cpp`); a host name is logged as invalid and dropped. The wizard resolves the profile's `server`
when join runs and writes the IPv4 address. The cost: if the server's address changes, members' games point at the old
one until they run join again. `check` and `status` look the name up again, compare it with the address in the game's
settings, and say so first: `NOT READY: the league server has moved. <name> is now at <new>, but the game on this PC
is still set to the old address <old>.` followed by the one command that fixes it, `FCS-online.exe join` (exit code
2). The server should keep one static IPv4 address, and its DNS record must be a plain A record (not proxied).

Other modes and flags: `check [--server HOST] [--rpcs3 DIR]` (the connection check and the moved-server comparison),
`signout` (removes the personal entry, from the patch file and from every copy of it in `patches\`, and the saved
profile), `help` / `--help`, `status [--no-check]` (says whether a profile is saved, whether the sign-in entry is installed,
enabled and matches the saved profile, the network settings, whether the server answers; never the credential),
`join-lan` or `join --rpcn HOST:PORT` (the earlier setup against a private RPCN server), `--psn simulated`
(troubleshooting: PSN status Simulated instead of Disconnected), `--skip-check`, `--check-timeout MS`, `--yes`.

### Where the credential lives

- In the saved profile (user-only access). It is written under a random temporary name inside the already restricted
  folder and moved into place; a temporary file left by an interrupted run is removed on the next save.
- In `patches/imported_patch.yml`, inside the personal entry, as the adapter's instructions. RPCS3 reads patches only
  from that folder, so this cannot be avoided. The wizard limits the file to the member's Windows account (RPCS3 may
  write the file again from its patch manager, which can bring the folder's access back; the next `join` limits it
  again). Members must not share that file or a screenshot of the entry.
- Nowhere else: backup copies the wizard makes of the patch file have the personal entry removed, and `join` and
  `signout` take it out of any other `imported_patch*` copy in that folder. Nothing prints or logs the credential or
  the join code, and error messages never quote the input; text that may be a join code typed in the wrong place (as a
  file name, as the mode) is not repeated. `status` shows only the first 8 hex digits of the credential's SHA-256 (the
  value the site keeps), which cannot be used to sign in.
- `--code FCS1-...` on a command line is visible to every program on the PC while the wizard runs and stays in the
  shell history. It is kept for existing scripts and prints a note; scripts should pipe the code in with `--code -`
  or use `--profile FILE`, and people should use the hidden prompt.
- The downloaded `fcs-online-profile.json` (Downloads) is a copy of the credential the wizard does not control: `join`
  offers to delete it. A Downloads folder synced to a cloud drive keeps its own copy.

## What the server has to accept

- Registry mode: `blaze.mjs --ticket-registry FILE --easw off`. `ps3Login`'s `TCKT` is the 72 bytes `FCSNP001` + 64
  random bytes; the registry holds `{ userId, onlineId, ticketSha256, joinDynasties }`. `ticketSha256` is the SHA-256
  of the 72 raw bytes of the profile's `ticketHex`, the hash the site keeps. (`np-adapter-rpcs3.test.mjs` checks the
  bytes the game presents against `league-auth.mjs` `authenticate`.)
- `userId` 1..2^31-1 and stable; `onlineId` 3..16 of `A-Z a-z 0-9 _ -`, unique without regard to case.
- The redirector, Locker and QoS addresses the server advertises must be its public address.
- Reachable from the internet: TCP 42127, 33152, 17503, 17502 and UDP 17502. The QoS firewall probes also use UDP
  17500 and 17501. TCP 17504 only when EASW is on.
- UDP 17502 must answer a 20-byte probe (request id 1, secret 0) by echoing those 20 bytes first, as `qos.mjs` does.
- The profile's `server` must resolve to an IPv4 address.
- The game checks the profile's `expiresMs` against the PC clock and fails the ticket after that date. The server does
  not see the expiry; revocation is the registry's `disabled` flag.

The Blaze connection on 33152 is not encrypted, so the credential crosses the internet in the clear at sign-in, as an
RPCN ticket did. Whoever can read a member's traffic can copy it. Reissuing a member's credential on the site (new
hash in the registry) is the remedy.

## Real PS3 members (design only, nothing built in the wizard)

What the wizard would have to produce for a console:

1. **A personalized, signed `EBOOT.BIN`.** Built today, by hand, on the project PC: `ps3-np-adapter.py` (stock ELF +
   profile -> adapter ELF), `ps3-eboot-onto.mjs` (the mod's patch words onto the adapter ELF),
   `package-np-self.py` (scetool under WSL -> signed SELF, decrypt-back and signature verified). A dynasty was created
   from the console with such a build. The update's `PARAM.SFO` must say `APP_VER 01.02`.
2. **Name redirection.** A console has no swap list. Today the PC shares its connection and answers DNS. For the
   cloud server the console needs either a DNS server that answers `gosredirector.ea.com` and the other `*.ea.com`
   names with the league server's address (a league-run resolver, set by hand in the console's network settings), or
   an executable whose host-name strings are changed (`play.fcs-mod.online` is one character shorter than
   `gosredirector.ea.com`, so it fits). The second removes the DNS step but is untested: the redirector's
   certificate check and the other EA names would have to be worked through.

Missing before the wizard can do it for a member:

- The stock decrypted executable on the member's side. The wizard cannot ship it. It would have to decrypt the
  member's own update `EBOOT.BIN`, which means a Windows-native SELF decrypt/sign step in the exe (scetool is a WSL
  build today, and its key and curve files are private inputs).
- Getting the file onto the console (FTP to webMAN), checking `PARAM.SFO`, keeping a rollback copy.
- The DNS answer above, as a service on the cloud server or as the host-name variant.
- `np-adapter-rpcs3.mjs` already gives the per-member words from addresses alone, so the personalization itself needs
  no new work; signing and delivery do.

## In-game proof (Eric, about ten minutes)

Needs: the league server (or an isolated copy) in registry mode with a test identity enrolled, and that identity's
profile with `server` set to the machine the server runs on. For a local run: `node spike/blaze/tools/league-enroll.mjs
REGISTRY.json PROFILE.json 700010 FCSTestRpcs3`, add `"server": "127.0.0.1"` to the profile file, start the isolated
server as in `docs/ps3-no-psn-test.md`.

1. Close RPCS3. Run `FCS-online.exe join --profile PROFILE.json --trust-server` on a **copy** of the RPCS3 0.0.29
   folder. Expect step 1 to say `installed/updated: your league sign-in as FCSTestRpcs3 (about 1000 words)` and the
   last line of the check to say `YOU'RE READY`.
2. Start RPCS3. Manage > Game Patches > NCAA Football 14: the entry `FCS online: league sign-in (personal, do not
   share)` is listed and ticked.
3. Boot the game. In `RPCS3.log`: a line `Applied patch (hash='PPU-62e25ebc...', description='FCS online: league
   sign-in ...', ...) (<- N)`. **N must equal the word count join printed in step 1.** RPCS3 skips a word it cannot
   place without saying so, so a smaller N means the code after the segment was not written. `Invalid branch at ...
   -> 0x1bc2...` warnings are expected.
4. The game reaches the main menu with no PSN or RPCN prompt.
5. Choose Online Dynasty. Expect the EA terms / hub, not "you must be signed in to PlayStation Network".
6. Server log: `ps3Login for FCSTestRpcs3 (user 700010, ...)` and no `league authentication rejected`.
7. Create a throwaway dynasty (or open one this identity belongs to), save, quit to the menu and enter again.

If step 4 or 5 fails with a PSN message, run `FCS-online.exe join --psn simulated` (same profile) and repeat from 2,
and note which mode worked. If step 3 shows no such line or a smaller N, keep `RPCS3.log`: that is the case where the
code needs another home (RPCS3's `alloc` patch type), and the log says which.

## In-game result (2026-11-16, RPCS3 0.0.29, local test server)

Passed: the sign-in entry applied in full (1020 of 1020 words), the game went online with `PSN status: Disconnected`,
the server logged `ps3Login for FCSTestRpcs3 (user 700010)`, a dynasty was created, saved and re-entered, and the
authenticated Sports World accepted the member's sign-in.

Two things the run found:

- The adapter reported ticket issuer 1. The game maps issuer 1 to EA's TEST environment (VA `0x71aaa8`: 1 = test,
  8 = cert, anything else production), looked up `gosredirector.stest.ea.com`, and dropped the redirector handshake
  right after the certificate ("EA servers are not available at this time"). Both generators now report `0x100`.
  `--psn simulated` made no difference and is not needed.
- With Sports World off (`--easw off`) the game shows "You have lost your connection to EA servers" when it posts a
  story and while saving. Sports World is now on by default, in cloud mode too.

Still open: the same run against the cloud VM with a site-issued join code, a second member in one dynasty, and the
built `.exe` (the bundle was run with Node).

## Not verified

- Anything in the game: that RPCS3 applies the entry, that the hooks run through the interpreter fallback as read in
  the source, that the game goes online with `PSN status: Disconnected` (unpatched NP Basic / Lookup calls behave like
  a signed-out console on RPCS3), that the server accepts the login from RPCS3.
- RPCS3 builds other than the two read (`v0.0.29`, `master` as of 2026-11-15).
- The hidden paste in a real console window, including the hidden `--code -` prompt (tested with piped input only),
  and the built `.exe` (the bundle was run with Node).
- Opening the browser through `rundll32 url.dll,FileProtocolHandler` (the address check and the arguments are tested;
  a browser was not opened in a test).
- The unsigned exe loading a DLL planted beside it in Downloads: that happens before any of the wizard's code runs, so
  nothing here addresses it. The published SHA-256 only tells a member that the file is the one that was released.
- A custom configuration created by the wizard from `config.yml` (file contents tested; RPCS3 loading it is not).
- The connection check against the real server and through real firewalls (tested against local ports).
