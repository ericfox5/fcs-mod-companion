<!--
For whoever publishes (this comment is not shown on the release page):
FCS-online.exe is not code-signed, so every release publishes its SHA-256 checksum, three ways, all written by
installer/release.mjs from the same bytes:
  1. the asset FCS-online.exe.sha256 next to the exe (one line: "<hash> *FCS-online.exe"); installer/build.mjs writes
     it as installer/dist/FCS-online.exe.sha256 on every exe build, and the newest one is always at
     https://github.com/<owner>/<repo>/releases/latest/download/FCS-online.exe.sha256
  2. the "Check your download" section and the last line of these notes ({{SHA256}} is filled in)
  3. the line "SHA-256 to show on the site's download page" that release.mjs prints
The site's download page should show that hash next to the download button (fetch the asset in 1, or paste the line in
3), so a member can compare the file they got with what was published. `node installer/checksum.mjs --verify` checks a
local exe against its .sha256 file. There is no code signing.
-->
**One file does everything: download `FCS-online.exe` from Assets below and run it.**

## Before you start

You need a Windows PC with:

- **RPCS3 version 0.0.29 (build 15767).** Newer versions crash when a game starts loading.
- **NCAA Football 14** (PS3, BLUS31159) in RPCS3, with **TheFloridaMan's FCS mod** installed.

## Install

1. Close RPCS3.
2. Download **FCS-online.exe** (under Assets, below) and double-click it. If Windows says "Windows protected your PC",
   click **More info**, then **Run anyway**. The file isn't signed with a paid certificate, that's all.
3. Press **Enter** to choose **1. Install or update**. When it asks "RPCS3 found at ... Use it?", press **Enter** again.
   If it can't find RPCS3, paste the path of the folder that has `rpcs3.exe` in it.
4. When it says **Done**, press **Enter** to close the window.
5. Start RPCS3 and the game. In the game, load the roster **ROSTER-FCS2026**.

## Updating

Download the newest FCS-online.exe and run it the same way. It only changes what's new. Everything it replaces is
backed up first, in `%LOCALAPPDATA%\ncaa-bridge`.

## Playing in an online league?

1. Sign up at [fcs-mod.online](https://fcs-mod.online) and copy your **join code** from your account page. It is
   personal, like a password: don't post it or show it on a stream. Only ever use a code from your own account page:
   with a code somebody sent you, you would be playing as them.
2. Close RPCS3, run FCS-online.exe and choose **2. Join the online league** instead of 1.
3. When it asks, paste the join code (right-click pastes; it stays hidden) and press **Enter**. It shows the name and
   member number the code belongs to: check that it is you before you answer.
4. Wait for **YOU'RE READY**. If it says NOT READY, it also says what to fix; run it again afterwards.
5. Start the game and choose Online Dynasty. There is no PSN or RPCN account to make.

It does everything "Install or update" does, too. Run it again whenever you get a new join code, and whenever it or
"6. Check the connection" says the league server has moved.

## Check your download (optional)

FCS-online.exe isn't signed, so this release publishes its SHA-256 checksum instead: the line at the bottom of this
page, and the file `FCS-online.exe.sha256` under Assets. To compare, open PowerShell in the folder you downloaded to
and run `Get-FileHash FCS-online.exe -Algorithm SHA256` (or, in Command Prompt, `certutil -hashfile FCS-online.exe
SHA256`). The letters and digits it prints should be the same as the published ones (capital or small letters don't
matter). If they differ, don't run the file: download it again from this page.

## What it installs

- **Game patches** (RPCS3 → Manage → Game Patches):
  - 90-man rosters
  - jersey #0
  - a fix for the crash at "Generating All-Americans" when a season rolls over
  - a fix for the freeze at "generating recruits"
  - up to 5 online dynasties per commissioner
  - home or away against the generic teams in Custom Schedules
- **Uniforms** for the teams the FCS mod marks "Coming Soon", with their conference logos.
- **Score bug** team names and colours that match the FCS teams.
- **The 2026 FCS roster**, with up to 90 real players per team, plus real 2026 rosters and home stadiums for the five
  generic teams.
- **Playbooks the league's coaches shaped on the site** (their own formations, sets, play order and drawn plays), as
  private playbooks their teams use in game. Every member installs the same release before a game that uses one.

<sub>{{VERSION}} · built {{BUILT}} · {{SIZE}} MB · SHA-256 `{{SHA256}}`</sub>
