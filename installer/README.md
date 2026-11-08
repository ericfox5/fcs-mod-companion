# FCS-online.exe

One executable for the FCS mod online league. A member runs it on the PC that has RPCS3 and the FCS mod; it is a
console wizard (no browser, no admin rights) and every step can be driven by flags instead.

| mode | what it does |
|---|---|
| `join` | finds RPCS3 (or asks), installs and enables the FCS mod patch entries in `patches/imported_patch.yml` + `config/patch_config.yml`, installs the uniform sets (placeholder uniforms for the Coming Soon teams, Robert Morris and Stonehill, XMLs for Richmond's and LIU's own art, Villanova's navy helmet) into their `USRDIR\DLC\FCS_DLC_*` folders plus the remaining stop-gap XMLs, re-keys the generic opponents' stored rosters inside the game archives for the 100-player patch (in place, original backed up; `ncaa-bridge stda restore` undoes it), points the game's custom config at the league server (Network Connected, PSN RPCN, EA hosts swapped to the server address) and `config/rpcn.yml` at the private PSN server, optionally installs the roster save, and opens the companion site for the account |
| `roster` | installs the roster save the build carries (FCS2026, up to 90 players per team; needs the patches) |
| `host` | from a project checkout: checks Node, runs `npm install` once, starts the league server (`league.mjs start`) |
| `status` | shows what is installed on this PC |

Every file it changes is backed up next to the original (`*.bak-<timestamp>`), except DLC files, which go to
`%LOCALAPPDATA%\ncaa-bridge\uniforms\backup` like the uniform studio's (a slot XML of the same name in another FCS_DLC
folder is moved there too, so no team is defined twice). Nothing is uploaded anywhere.

```
FCS-online.exe
FCS-online.exe join --rpcs3 "C:\Games\rpcs3" --server 203.0.113.7 --rpcn 203.0.113.7:31313 --yes
FCS-online.exe status --rpcs3 "C:\Games\rpcs3"
FCS-online.exe host --project C:\src\football-sim-project
```

What it cannot do: create the member's RPCN account (that is done in RPCS3 > Configuration > RPCN > Create Account
against the league's private PSN server) and run the league server without a checkout (the server, the site sync and
the private PSN server stay on the host's PC). A real PS3 needs the baked EBOOT instead of the patch entries
(`docs/ps3-no-psn-research.md`).

## Build

```
node installer/build.mjs [--roster "C:\...\FCS\Rosters\2026\out\BLUS31159-ROSTER-FCS2026"] [--rpcs3 DIR]
```

`build.mjs` writes `installer/generated/payload.json` from `spike/blaze/private/rpcs3-patches.yml` (so the exe
carries the patch words; `generated/` and `dist/` stay out of git), the stop-gap XMLs in `spike/blaze/tools/uniforms`
and, with `--roster`, the save folder; bundles `src/main.ts` with esbuild; then makes a Node single executable
application: copies the running `node.exe`, injects the bundle with postject. The result is `installer/dist/FCS-online.exe`
(about the size of node.exe plus the payload). Rebuild after any patch regeneration.

The uniform sets come from `spike/blaze/tools/uniforms/make-coming-soon-sets.mjs` (run it first; its output in
`spike/blaze/tools/uniforms/dist/coming-soon` is not in git): that folder gives the file list, and each file's bytes are
read from this PC's RPCS3 DLC folders when present (`--rpcs3`, else `rpcs3Root` in `~/.ncaa-bridge/config.json`), so
touch-ups made in the uniform studio ship. They go into the exe as one SEA asset (`generated/uniform-pack.bin`, about
31 MB). A stop-gap XML whose slot has a set (Duquesne's BALLST) is left out. Rebuild after touching a set up.
