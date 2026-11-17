# FCS-online.exe

One executable for the FCS mod online league. A member runs it on the PC that has RPCS3 and the FCS mod; it is a
console wizard (no browser, no admin rights) and every step can be driven by flags instead.

| mode | what it does |
|---|---|
| `install` | finds RPCS3 (or asks), installs and enables the FCS mod patch entries in `patches/imported_patch.yml` + `config/patch_config.yml`, installs the uniform sets (placeholder uniforms for the Coming Soon teams, Robert Morris and Stonehill, XMLs for Richmond's and LIU's own art, Villanova's navy helmet) into their `USRDIR\DLC\FCS_DLC_*` folders plus the remaining stop-gap XMLs, re-keys the generic opponents' stored rosters inside the game archives for the 100-player patch (in place, original backed up; `ncaa-bridge stda restore` undoes it), optionally installs the roster save |
| `join` | everything in `install`, plus the online league: takes the member's join code or `fcs-online-profile.json` from the companion site, writes their personal sign-in patch entry (no PSN, no RPCN account), points the game's custom config at the league server (Internet Connected, PSN Disconnected, EA hosts swapped to the server's address), saves the profile for this Windows account only, and checks that the server answers. Details and the in-game test: `docs/online-member-setup.md` |
| `check` | the connection check alone: TCP 42127, 33152, 17503, 17502, UDP 17502 (and 17504, optional), then "YOU'RE READY" or the one thing to fix. It also compares the address the server's name leads to now with the address in the game's settings, and says "the league server has moved" with the command that fixes it (`FCS-online.exe join`) |
| `signout` | removes the personal sign-in entry (from the patch file and from every copy of it in `patches\`) and the saved profile |
| `help` | the modes and flags, and how to hand over a join code safely (`--help` does the same) |
| `join-lan` | the earlier setup for a league on a host's PC: the game's custom config at the host's address with PSN RPCN, and `config/rpcn.yml` at the private PSN server (`join --rpcn HOST:PORT` does the same) |
| `roster` | installs the roster save the build carries (FCS2026, up to 90 players per team; needs the patches) |
| `host` | from a project checkout: checks Node, runs `npm install` once, starts the league server (`league.mjs start`) |
| `status` | shows what is installed on this PC, whether a profile is saved and the sign-in entry is installed (never the credential), whether the league server is reachable, and whether it has moved since join ran (exit code 2 then, with the command that fixes it) |

Every file it changes is backed up next to the original (`*.bak-<timestamp>`), except DLC files, which go to
`%LOCALAPPDATA%\ncaa-bridge\uniforms\backup` like the uniform studio's (a slot XML of the same name in another FCS_DLC
folder is moved there too, so no team is defined twice). A backup copy of `imported_patch.yml` never contains the
personal sign-in entry. Nothing is uploaded anywhere.

```
FCS-online.exe
FCS-online.exe join --rpcs3 "C:\Games\rpcs3"                                   (asks for the join code; the paste is hidden)
FCS-online.exe join --rpcs3 "C:\Games\rpcs3" --profile fcs-online-profile.json --yes [--skip-check] [--check-timeout 8000]
Get-Content code.txt | .\FCS-online.exe join --rpcs3 "C:\Games\rpcs3" --code - --yes     (the join code on standard input)
FCS-online.exe check [--rpcs3 "C:\Games\rpcs3"]
FCS-online.exe help
FCS-online.exe status --rpcs3 "C:\Games\rpcs3" [--no-check]
FCS-online.exe signout --rpcs3 "C:\Games\rpcs3" --yes
FCS-online.exe join-lan --rpcs3 "C:\Games\rpcs3" --server 203.0.113.7 --rpcn 203.0.113.7:31313 --yes
FCS-online.exe host --project C:\src\football-sim-project
```

`join` exits with 0 when the PC is ready to play online, 2 when something still needs fixing and 1 on an error
(including a question nobody answered because the input ended). Other `join` flags: `--server HOST` (use this address
instead of the profile's), `--trust-server` (accept a profile whose server is not the league's), `--psn simulated`
(troubleshooting: PSN status Simulated instead of Disconnected).

### Handing over the join code

The join code is the member's password. Ways to give it to `join`, safest first:

1. **No flag.** `join` asks for it and what is pasted is not shown.
2. **`--profile FILE`**: the `fcs-online-profile.json` downloaded from the account page. Delete the file afterwards
   (`join` offers to).
3. **`--code -`**: the code is read from the first line of standard input, for scripts
   (`Get-Content code.txt | .\FCS-online.exe join --code - --yes`). In a console window it is a hidden prompt.
4. **`--code FCS1-...`** still works, for existing automation, but **avoid it**: every program running on the PC can
   read another program's command line for as long as the wizard runs (Task Manager shows it), and the shell keeps the
   line in its history. `join` prints a note when it is used. Anyone who used it on a shared PC should get a new join
   code on the site.

Nothing the wizard prints, and no error message, contains the join code or the key inside it. Text that may be a join
code typed in the wrong place (`--profile FCS1-...`, a join code as the mode) is not repeated either.

### Whose code it is

Before anything is installed, `join` says whose sign-in it is about to install: the in-game name and the member
number (`TestUser1 (member number 700101)`), never the key. It tells the member to use only a code from their own
account page (with a code somebody sent them they would be playing as the sender) and, in a console, asks them to
confirm. If this PC already has another member's profile, it says that the saved profile will be replaced, names both,
and the question defaults to No. With `--yes` the same lines are printed and the install goes ahead.

### The server

A profile's `server` must be the league's: `fcs-mod.online` or a name under it. Any other address is refused with an
explanation; the member can accept it by name in the console, or with `--trust-server` when `--yes` is used. The
comparison is made in lower case, and these are never the league's server: a name with a non-English letter (look-alike
letters), a name with a punycode `xn--` part, a name that ends with a dot, a name with a user name, password, port or
path in it, an address in numbers. `--server` is held to the same form rules.

RPCS3 stores the server's address as numbers, looked up when `join` runs. If the server moves, `check` and `status`
say `NOT READY: the league server has moved ...` and name the one command that fixes it: `FCS-online.exe join`.

### What is kept where

- The member's profile: `%LOCALAPPDATA%\ncaa-bridge\online\fcs-online-profile.json`, readable by that Windows
  account only. Next to it `last-join.json` (which RPCS3 folder, which server name and address; no key).
- The sign-in key is also in the personal patch entry in `patches\imported_patch.yml` (RPCS3 only reads patches from
  there). `join` limits that file to the member's Windows account as well, because an RPCS3 folder outside the user's
  own folders is readable by every account on the PC; `signout` puts the folder's normal access back. The file must
  not be shared once a member has joined.
- Backup copies of the patch file never contain the entry; `join` and `signout` also take it out of any other copy of
  `imported_patch*` they find in `patches\`.

### Programs the wizard starts

`icacls` (file access), `tasklist` and `powershell` (is RPCS3 running), `rundll32` (open the browser), and for `host`
Node. All of them go through `src/online/system.ts`: Windows' own tools are started by full path under
`%SystemRoot%\System32` (`C:\Windows` when the variable is missing or wrong), the file is checked to exist, no shell is
used, and they run with the system folder as the working folder. A bare name that is not on that list is refused, so a
file named `icacls.exe` or `cmd.exe` in the folder the wizard was started from (usually Downloads) is never run. Node
is looked up on `PATH` by the wizard itself (full folders only) and npm is run as Node's own `npm-cli.js`. The build
points every `node:child_process` import in the bundle, including the bridge code the exe carries, at that module and
fails if one is left.

What it cannot do: run the league server without a checkout, and set up a real PS3 (that needs a personalized signed
EBOOT and DNS redirection; `docs/online-member-setup.md` says what exists and what is missing).

## Build

```
node installer/build.mjs [--roster "C:\...\FCS\Rosters\2026\out\BLUS31159-ROSTER-FCS2026"] [--rpcs3 DIR] [--elf EBOOT.elf] [--no-exe]
```

`build.mjs` writes `installer/generated/payload.json` from `spike/blaze/private/rpcs3-patches.yml` (so the exe
carries the patch words; `generated/` and `dist/` stay out of git), the stop-gap XMLs in `spike/blaze/tools/uniforms`
and, with `--roster`, the save folder; bundles `src/main.ts` with esbuild; then makes a Node single executable
application: copies the running `node.exe`, injects the bundle with postject. The result is `installer/dist/FCS-online.exe`
(about the size of node.exe plus the payload). Rebuild after any patch regeneration.

The exe is not code-signed. Every exe build writes its SHA-256 next to it, `installer/dist/FCS-online.exe.sha256`
(one line, `<hash> *FCS-online.exe`); `npm run release` publishes that file with the exe and puts the same hash in the
release notes, so the site can show it (`installer/RELEASE.md`). `node installer/checksum.mjs --verify` compares the
two; `node installer/checksum.mjs [file]` writes the checksum for a file again.

For the online sign-in the payload also carries the adapter template: the addresses `spike/blaze/tools/np-adapter-rpcs3.mjs`
reads from the stock decrypted 1.02 executable (`spike/blaze/private/EBOOT.elf`, or `--elf`). No game bytes and no
credential go into the exe; `join` assembles the member's entry on their PC. The build stops if a mod patch entry writes
an address the sign-in uses. Without the ELF the build still works, and its `join` says it cannot set up the online league.

The uniform sets come from `spike/blaze/tools/uniforms/make-coming-soon-sets.mjs` (run it first; its output in
`spike/blaze/tools/uniforms/dist/coming-soon` is not in git): that folder gives the file list, and each file's bytes are
read from this PC's RPCS3 DLC folders when present (`--rpcs3`, else `rpcs3Root` in `~/.ncaa-bridge/config.json`), so
touch-ups made in the uniform studio ship. They go into the exe as one SEA asset (`generated/uniform-pack.bin`, about
31 MB). A stop-gap XML whose slot has a set (Duquesne's BALLST) is left out. Rebuild after touching a set up.

## Tests

```
node --import tsx --test installer/test/online.test.ts
node --test spike/blaze/tools/np-adapter-rpcs3.test.mjs spike/blaze/tools/ps3-eboot.test.mjs
```

The first covers join codes, profile checks, whose profile it is and what replacing one says, the server-name rules
(look-alike letters, punycode, dots, credentials, ports), the personal patch entry, the rewriting of RPCS3's patch and
config files on samples, the connection check against ports it opens itself, the moved-server message, how programs
are started (a planted `icacls` in the current folder is not what runs), and the checksum file. Its last test runs the
whole wizard (`installer/dist/fcs-online.cjs`, so run `node installer/build.mjs --no-exe` first; it is skipped when the
bundle is missing or older than the sources) on a throwaway RPCS3 folder with made-up profiles and the user folders
redirected. The second checks the adapter words; with the
private stock ELF and Python present it also proves they equal the personalized ELF `ps3-np-adapter.py` builds.
