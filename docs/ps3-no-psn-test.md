# Signed-out Online Dynasty: physical test handoff

Target confirmed by the user: **CEX 4.90, PS3HEN 3.2.2, webMAN MOD 1.47.45**.
These are experimental builds with the NP adapter, All-Conference offseason fix and five-dynasty patch.
They passed local PPC64, server, ELF round-trip and signature checks. They have **not** booted on this console.

## Deployment completed (2026-11-03, about 22:21 EST)

At the user's request, Player A was installed on `192.168.137.2` while webMAN reported XMB. The console's original EBOOT matched the supported original SELF hash; the installed executable was downloaded again and matched the Player A hash below. Original EBOOT and all existing savedata files across five user directories (45 backup files total, including title metadata) are under `spike/blaze/private/console-backup-2026-11-03-np-test-complete`, with hashes in `backup.json`. A first incomplete download is retained separately and is **not** the complete backup.

The console also retains `/dev_hdd0/game/BLUS31159/USRDIR/EBOOT.BIN.before-np-test`. The normal league supervisor and its sync were stopped. The three isolated listeners are running hidden; their PIDs and logs are in `physical-np-test/private/test-processes.json` and `*.stdout.log` / `*.stderr.log`. DNS was initially missing; after backing up the PC hosts file and the user's Windows administrator approval, both `gosredirector.ea.com` and `reports.tools.gos.ea.com` were confirmed through a direct DNS query to `192.168.137.1` to return that address. No game boot was triggered. **Next user action: launch the game signed out and select Online Dynasty.** Do not repeat the installation steps below unless restoring/retesting.

## Prepared files

All paths below are relative to the project root; files are private/gitignored.

| Player | Signed test EBOOT | Registry identity |
|---|---|---|
| A | `spike/blaze/private/BLUS31159-no-psn-probe-a-EXPERIMENTAL.BIN` | 700001 / FCSProbeA |
| B | `spike/blaze/private/BLUS31159-no-psn-probe-b-EXPERIMENTAL.BIN` | 700002 / FCSProbeB |

The binaries contain different bearer credentials. Do not give A's executable to B or use either to claim production ownership.
The isolated server is prepared at `spike/blaze/private/physical-np-test`; its `RUN.txt` contains the three launch commands.
Its advertised address is **192.168.137.1**, matching the project's documented Windows ICS setup. Confirm that address is still reachable from the console.

## First test: boot and entry

**First hardware attempt diagnosis:** User relaunched and still received the PSN sign-in dialog. Installed EBOOT read-back still matched Player A. Read-only webMAN process inspection found the live ELF header matched disc 1.00 (entry `0x1bc0e48`), and all 64 bytes at VA `0x719b80` exactly matched the decrypted original disc ELF, not update 1.02. No requests reached the test redirector/Blaze. This was a disc-build run, not evidence that the adapter executed.

Console update PARAM.SFO contained only CATEGORY/PARENTAL_LEVEL/TITLE/TITLE_ID/VERSION, missing APP_VER, ATTRIBUTE and PS3_SYSTEM_VER. After the user closed the game to XMB, restored the known 1.02 PARAM.SFO (APP_VER 01.02, ATTRIBUTE 0, PS3_SYSTEM_VER 04.2000; existing fields unchanged), verified read-back SHA-256 `6920b30b9e1a80847b273c851002afdf676a62ef1d419d7d9be3dfd3f6cc1c69`. Original metadata remains in the PC backup and remotely as `/dev_hdd0/game/BLUS31159/PARAM.SFO.before-np-test`. Next launch must be checked in live memory to establish the adapter actually loaded. The metadata repair is a supported hypothesis for update selection, not yet proof of a successful no-PSN run. Rollback now includes restoring both EBOOT and PARAM.SFO.

1. Quit the game. Back up the console's **update** `/dev_hdd0/game/BLUS31159/USRDIR/EBOOT.BIN` to a separate PC file. Preserve any existing save data. Verify the title/update is BLUS31159 01.02; the build input came from update SELF SHA-256 `0fe9530fc77c7980e54a4d3c942c59d3b9130a1e80e27a6929b9e3a6f6b74e5a`. If the console's executable differs, retain it for comparison and do not assume it is the same baseline.
2. During a test window, stop the normal league listeners using the existing project launcher. Start the three listeners from the isolated folder's `RUN.txt`. They use the usual ports; do not run both leagues concurrently. No production store was copied. Existing DNS redirection must send `gosredirector.ea.com` to the PC; RPCS3 host switches do not configure the console.
3. Copy player A's signed `.BIN` to that **update** path as `EBOOT.BIN`. Do not replace the disc executable or any DLC/assets. Verify the copied hash against `105e30d78a91c6e9aa3d1589cde8fcaf4972b0a4bb01a3584fb4e049908ce325`.
4. Enable HEN and remain signed out of PSN. Boot the game and select Online Dynasty. Record whether boot succeeds, the first exact warning/error or stalled screen, and its timestamp. Check the isolated `private/capture-*.jsonl` for redirector connection, authentication as **700001**, UserAuthenticated, and DOD traffic. A removed warning alone is not success.

The first useful feedback is **boot result + first failing screen/error + corresponding isolated capture file**. Do not post private profiles or raw network captures publicly; they can contain bearer credentials. Server ticket logging is redacted.

## Functional tests after entry works

- Create a throwaway dynasty as A, load/save it, quit/re-enter and reconnect after a network interruption. Check numeric ownership and saved file IDs in the isolated store.
- Add its DID to B's `joinDynasties` in the isolated `private/registry.json`. On a second console use B's executable (or switch builds sequentially for an initial identity test). Search/join/load/save as B. Confirm B cannot advance the league or overwrite A's file. Two simultaneous consoles are needed to validate concurrency on hardware.
- Advance a normal week as commissioner A. Later cross the All-Americans/offseason crash point into preseason, reload and verify week/year/rosters. B's noncommissioner contract/carousel permissions are still an explicit runtime investigation item; report denied commands rather than weakening the ACL globally.
- Disable one registry entry and confirm its access fails while the other identity still reconnects. No account may fall back to 1000/Player.
- Capture console-IP traffic at the PC/router across boot, entry and idle if validating destinations. Removing the game's known NP paths does not prove the entire console never contacts Sony.

## Rollback

Quit the game, restore the exact backed-up update EBOOT, stop the three isolated listeners, and restart the normal league with its existing launcher. Keep test logs and isolated stores for diagnosis; never copy them over production data. No console-wide sign-in setting or firmware component is changed by these builds.

Implementation evidence, hashes, limitations and test distinctions: [research note](ps3-no-psn-research.md).
