# Physical PS3 / no-PSN research

Status (2026-11-03): **game-local NP adapter and authenticated server mode implemented; two personalized experimental ELFs and signed APP SELF test builds generated.** Both pass 33 PPC64 scenarios in QEMU; both SELF files decrypt back exactly and their signatures independently verify. Real isolated server TCP/HTTP integration checks pass. No new full-game RPCS3 or physical-console validation. Original binaries, production stores, and running configuration preserved. Existing source edits were retained; server changes are gated by the new registry option except minor transaction bookkeeping.

## Baseline (2026-11-03 investigation)

- No AGENTS.md found in this repository or its ancestors. Read `spike/blaze/README.md`, `NOTES.md`, tools README, and Claude's project memory under `.claude/projects/C--Users-efoxo-OneDrive-Desktop-football-sim-project/memory/`.
- Repository was already heavily dirty, including `blaze.mjs`, `dod.mjs`, and several untracked server modules. Preserve that work. The supervisor reloads changed server imports, so server edits can affect the live league.
- Local PARAM.SFO: NCAA Football 14, **BLUS31159 (US)**. Disc APP_VER 01.00, CATEGORY DG; installed update APP_VER **01.02**, CATEGORY GD. VERSION is 01.00 in both and is not the update version. Update PS3_SYSTEM_VER 04.2000; disc 04.4100.
- Original encrypted disc EBOOT SHA-256: `27fb330ac0134ed94ae3a7eb4f0096fc398e8752ed6d23ee41b32aa3cefe117a`.
- Original encrypted update EBOOT SHA-256: `0fe9530fc77c7980e54a4d3c942c59d3b9130a1e80e27a6929b9e3a6f6b74e5a`.
- Decrypted update `spike/blaze/private/EBOOT.elf`, 30,077,256 bytes, SHA-256 **`144dee9040da9cb1e8337844fbb685a0f06e560b8fee8d9ba1eac87b9e300c1c`**. Identical to the ELF beside the update EBOOT in the RPCS3 0.0.32 installation. Claude's transcript records RPCS3 `--headless --decrypt` as the decryptor.
- Sources reside in `Desktop/desktop2/Desktop1/rpcs3-v0.0.32-16709-953af758_win64/dev_hdd0/{game/BLUS31159,disc/BLUS31159-[NCAA Football 14]/PS3_GAME}`. The working emulator is reportedly 0.0.29 with private RPCN; its custom config directly confirms `PSN status: RPCN` and EA IP swaps to loopback.
- RPCS3 PPU patch key: `62e25ebc1957382b34f2778554943e40d6d84e3c`. This is an emulator patch identifier, **not** the SHA-256 input guard.
- Python/Capstone exists at `C:/Users/efoxo/AppData/Local/Programs/Python/Python312/python.exe`, Capstone 5.0.7. It requires sandbox escalation here. Neither Python on PATH nor WSL Python has Capstone. Existing tools: `ppcdis.py`, `coderef.py`, TDF/vtable/cmd-map helpers. Original All-Conference generator found in Claude's temp scratchpad.
- Target subsequently confirmed by the user from its status page: **CEX 4.90, PS3HEN 3.2.2, webMAN MOD 1.47.45**. The older CFW wording was inaccurate for this target.
- Initially no configured resigner was found and the user confirmed none known. scetool has since been built, public format data obtained, and original decryption / experimental signing verified; see Packaging below.

## Existing patches and output

The two current patches in `private/rpcs3-patches.yml` are **not login patches**:

1. All-Conference fix: 38 be32 writes, predominantly VA `0x453914..0x4539a4`, plus `0x4539b4`. The preseason selector at `0x453898` uses TEAM.CGID to index stack arrays. Missing teams default to conference 31; valid conference indices are 0..13 (14 is the All-American slot). The fix skips invalid candidates. It compacts the profiler/query block and relocates two calls to `0xa691b0`.
2. Optional five-dynasty commissioner limit: VA `0x341460`, `3be00001 -> 3be00005` (`li r31,1 -> li r31,5`).

`NOTES.md` records the offseason patch passing rollover to preseason, CID 134, in RPCS3. Neither patch depends on an emulator API; RPCS3 merely writes the PPC instructions into memory. Baking the same words into this exact ELF is supported by static analysis. The prior carousel patch was removed; do not restore it. The YAML's 01.00/01.02 labels do not authorize using a different executable hash.

Builder: `node spike/blaze/tools/ps3-eboot.mjs ORIGINAL.elf NEW.elf [--commissioner]`.
It refuses changed/unsupported input, in-place writes and existing output, maps VAs through PT_LOAD, writes big-endian words, validates expected instructions and branch reach, and emits a manifest containing every VA, file offset, before/after word and hashes. No ABI, segment layout, or function descriptors are changed by these baseline patches.

Generated private outputs:

| ELF | SHA-256 |
|---|---|
| `BLUS31159-1.02-allconf-only.elf` | `6dd5d6e9acc74aef13ac9cd887bd691195f34a15efcc256415138683a0c827e1` |
| `BLUS31159-1.02-allconf-five-dynasties.elf` | `046e5546f89ec7819d3cb8af05bad5a8167c7b78b30112e8f082d2f8f42639c5` |

These **still require PSN/RPCN** and are not installable EBOOTs. Five local tests pass: all 39 existing YAML words match; all other bytes stay unchanged; changed/already-patched hashes are rejected; branch reach/alignment and mapping reject invalid inputs; no external immediate branch enters the relocated query window. Hardware status: untested. Emulator status of these newly generated ELF files: untested.

## Authentication and ownership: original legacy behavior

`blaze.mjs:consoleLogin`, Authentication component 1 / command 200, decodes `TCKT` as hex and calls `xi5.mjs:parseXi5`. It does **not** verify a signature, issuer, service, expiry, password, website session, or proof of possession. The first u64 type-2 TLV becomes userId; the first type-4 string becomes onlineId. `userId == personaId`; the random session key is generated **after** trusting those values.

An exception or absent field falls back to ID 1000 / `Player`. Empty input throws and is caught. Eight zero bytes parse with null fields and also fall back. Offline synthetic parser probes confirmed unsigned tickets can independently choose 700001/ProbeA, 700002/ProbeB, or 700001/ProbeB. No login was sent to the running server for these tests.

Dynasty ownership is numeric, not display-name based: `createDynasty` sets creator/commissioner from session.userId; `getContinueDynastyInfoForUser` filters membership by blazeId. NCID is a separate persisted small integer keyed by blazeId. Existing identities must be deliberately mapped by an operator; never infer an account migration from an online/display name.

However, the protocol is a permissive stub, **not an authenticated multi-user boundary**:

- `handleDod` accepts an absent session as user 0. `getDynasty`, `StartDynastyUpdate`, `sendTableUpdate`, `RequestAdvanceWeek` do not consistently require membership/commissioner authority.
- `EndDynastyUpdate` can select a member by supplied TMID if `me` is absent.
- `joinDynasty` currently returns COCH 0 without adding membership. Find/invitation replies are empty; this is not validated console joining.
- Locker uses session identity for creation but its HTTP/upload/download and content mutation authorization need a separate audit before untrusted clients.
- `easw.mjs:setLoginIdentity` sets one global **last-login identity**. `authReply` ignores the requesting player's ticket and returns that global persona. Two overlapping clients can therefore receive the wrong identity.
- Website invites/accounts and bridge tokens are separate (`worker/src/api/auth.ts`, site session handling); they do not authenticate Blaze TCP clients.

These findings describe the legacy mode. The new `--ticket-registry` mode described below replaces this trust model for local NP credentials; it does not make arbitrary RPCN tickets authenticated.

## Static NP connection trace

Reproduce import discovery with `python np-imports.py EBOOT.elf [rpcs3-sceNp.cpp]`. It hashes public API names to NIDs, finds import tables and immediate branch callers. Full local report: `private/np-imports.json`. This is a direct-call inventory, not proof that no function-pointer or dynamically loaded paths exist. The optional public RPCS3 source adds NP Basic/Lookup names. `RequestTicket` and `GetOnlineName` were not found; **RequestTicket2 and GetSigninId were**.

| Operation | Import stub VA | Important callsites / obligations |
|---|---|---|
| GetStatus | `0x16d6cb0` | 13 direct calls; `0x719b88`, `0x71aca4`, `0x71ae10`, `0xffe888`, `0x10246e0`. Must write status 3 AND return success. |
| GetNpId | `0x16d6ff8` | 10 calls, including `0x71ae68`; 36-byte NPID output; same identity as ticket. |
| GetOnlineId | `0x16d92f8` | `0x1024710`; caller allocates/zeros 20 bytes, copies up to 16 chars plus NUL into its display buffer. |
| GetSigninId | `0x16d8878` | `0x71ae70`; result gates transition to state 5. RPCS3 implements a zeroed 64-byte output; physical behavior must not be assumed identical. |
| RegisterCallback | `0x16d6ee0` | `0x719ae0`, descriptor `0x1c02880`, callback code `0x71a9d4`, argument = NetConn state. |
| UnregisterCallback | `0x16d6af0` | `0x7199a0`; lifecycle must match registration. |
| RequestTicket2 | `0x16d6c78` | Sole direct call `0x71954c` in wrapper `0x719490`. Asynchronous completion required. |
| GetTicket | `0x16d6930` | `0x71ab40` queries length with null buffer; `0x71ab90` copies allocated ticket; other callers include `0x1106144`. |
| GetTicketParam | `0x16d6b28` | Eight calls: issuer 1, issued 2, expiry 3, account ID 4, region 6, service ID 8 observed. Returns output data, not just success. |
| GetAccountRegion | `0x16d6d58` | `0x71a1dc`, `0x105ea88`, `0x1206e6c`; country and language outputs. |
| GetNetworkTime | `0x16d6dc8` | `0x71af44`, `0x1204a08`; time output feeds expiry/re-request decisions. |
| GetContentRatingFlag | `0x16d6bd0` | `0x7c7bec`, `0x102b140`; two outputs, restriction and age. Errors go to OSDK_LIMIT_MEMB. |
| GetChatRestrictionFlag | `0x16d6f50` | `0x71a154`; another output-bearing getter. |

Flow recovered (not yet a complete UI call graph):

1. Platform status helper `0xffe868` returns game status 2 only if NP getter succeeds and writes ONLINE (3). NetConn at `0x719b98` also compares status to 3; offline path enters system sign-in/dialog-related calls. Bypassing one warning does not satisfy later checks.
2. NetConn state 4 polls GetStatus, retrieves NPID into state+0x4c, then SigninId into +0x70. On success it advances to state 5; otherwise writes `-npo`. More repeated offline checks exist outside this path.
3. Wrapper `0x719490` stores a game completion descriptor at state+0xb8 and callback argument at +0xbc, acquires its mutex at state+0x18, checks pending flag +0xe5, and calls RequestTicket2 with NPID/version/service/cookie/entitlement arguments. A successful request clears ready +0xed and sets pending +0xe5 to 0.
4. Manager callback `0x71a9d4` handles event **0xff**: under the same mutex it sets state+0xe5=1 and stores the result at +0xe0. Event -1 records a status-change flag/result at +0xe4/+0xdc.
5. Poller `0x71ac14` checks +0xe5==1, invokes the stored completion descriptor with result and argument, normalizes positive result to ready=1 at +0xed, then restores +0xe5=-1. **A synchronous callback inside RequestTicket2 would be overwritten by the caller's subsequent pending write; it can also re-enter the held mutex.** Preserve deferred completion.
6. Completion `0x71aa80` requires positive result. It reads issuer, u64 account ID, queries ticket size, allocates, copies ticket, reads expiry, and saves data/length/expiry in state+0xc0/+0xc4/+0xc8. Failure frees/discards it. Network time is later converted and compared to expiry; errors lead to `-tkt`.
7. Identity updater `0x1024760` waits for NetConn `+onl`, then positive `tick`, then reads online ID, account ID, and region. `0x102b140` separately checks parental-rating outputs. Other ticket consumers compare requested service ID with TicketParam 8 and can request again.
8. Blaze ps3Login accepts TCKT; server replies ConsoleLoginResponse and **UserAuthenticated (30722/8)** plus related notifications. Prior captures show QoS and settings responses are also needed; early experiments without UserAuthenticated stalled. Successful login proceeds to DynastyOnDemand and Locker, not directly from NP success to dynasty loading.

RPCS3 provides virtual NP status/identity/ticket APIs while RPCN supplies its ticket flow. Its [NP implementation](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Emu/Cell/Modules/sceNp.cpp) and [structures](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Emu/Cell/Modules/sceNp.h) are comparative references, not proof of physical firmware behavior. Public current source was downloaded privately; the running emulator is an older version. The game's own callsites above establish the consumed outputs.

## Implemented adapter

Prefer a **game-local NP adapter at verified callsites**, retaining the game's deferred ticket-completion and Blaze login state machines. A warning bypass or blanket success-return patch is insufficient. Import stubs can be loader-owned; do not assume overwriting them survives physical SELF loading. Any injected PPC code needs verified storage, mapping, relative branch reach, r2/TOC and LR preservation, nonvolatile-register preservation, and function-descriptor conventions. Baseline patches do not settle these issues.

`spike/blaze/tools/ps3-np-adapter.py` now implements this direction. It requires the original SHA-256 above, rejects overwrite/conflicts, applies both baseline patches through `ps3-eboot.mjs`, and checks the expected direct-call counts before redirecting branches. It writes big-endian PPC instructions and checks signed branch reach. Original import stubs remain intact for the loader.

- Code occupies the verified zero gap at VA `0x1bc26f0`, file offset `0x1bb26f0`, length 3812. RX PT_LOAD sizes extend over it. State occupies 128 added BSS bytes at VA `0x1d61150`; RW PT_LOAD memory size extends accordingly. File-backed ELF sections are checked for overlap. Manifest records callsite VAs separately from file offsets, expected/replacement words, program-header writes, input/output hashes, identity and credential hash.
- Status writes ONLINE (3). NPID/online/signin identity buffers are populated and padded; account, country/language, restriction/age and ticket parameter outputs are initialized. Null/invalid arguments fail rather than return success with undefined output.
- Ticket is a 72-byte **league bearer credential**, `FCSNP001` plus 64 random bytes, not a Sony ticket. Size query, undersized buffers, all-byte copy, readiness and 256-byte ticket-parameter outputs are implemented. Numeric account ID and name come from the personalized profile; service ID is copied from each request, bounded to 63 characters.
- Registration records the existing NetConn context. Request queues positive completion in `context+0xe0/+0xe5` under the caller's existing mutex. VA `0x719560` becomes NOP so the caller does not erase completion. The original poller performs deferred completion once and sets ready at `+0xed`; unregister cancels queued work. No synchronous callback or Sony ticket request occurs through these patched direct paths.
- Network time uses existing local `cellRtcGetCurrentClock` and `cellRtcGetTick` imports, not NP network time. Leaf hooks preserve stack/r2/nonvolatile registers; the RTC wrapper saves/restores LR and stack and uses the existing import thunks.

Private outputs (never distribute one player's profile/ELF to another player):

| Player / ELF suffix | SHA-256 |
|---|---|
| 700001 / `no-psn-UNSIGNED-probe-a.elf` | `c146e332dc074f74f09e2b98fd13fcafc6030bb3fb76b0f77e1acf1cabca0eeb` |
| 700002 / `no-psn-UNSIGNED-probe-b.elf` | `bc1a19b12e41c0fe48ec3a26eacf11ff3165ca6a253167cfe45e911d1ec371a4` |

Both filenames start `BLUS31159-1.02-` under `spike/blaze/private`. These contain the adapter AND offseason fix; the earlier allconf-only artifacts still require PSN/RPCN. Output bytes are reproducible for the same original and profile (credentials and issuance dates intentionally differ between players). Disable equivalent runtime RPCS3 patches when testing baked ELFs; their original PPU hash may no longer match.

## Implemented authenticated server mode

`server/league-auth.mjs` validates the exact credential against operator-provisioned SHA-256 records, with server-owned numeric user/persona IDs. Unknown, revoked, malformed or legacy arbitrary tickets fail in registry mode; no fallback to 1000/Player. Local adapter tickets are also rejected in legacy mode. Display names never authenticate or select ownership.

Registry mode enforces numeric DOD membership, explicit join grants, commissioner operations, transaction ownership, own-team/file checks, and fail-closed unreviewed commands. FindDynasties now returns only granted/member leagues. Static schema proof: response constructor `0x776144` initializes a 0x128-byte element vector; element constructor `0x14ef5d8` calls Dynasty constructor `0x775b74`, which installs Dynasty vtable `0x18c1460`.

Locker uses session-scoped random upload/download capabilities (30-minute expiry), validated against current registry and numeric ownership/membership on each HTTP request. Raw CID/persona URLs do not grant access. Sessions revoke on disconnect/logout, and registry revocation affects existing connections/capabilities. Noncommissioner table uploads are retained under `private/dynasty-member-tables/<DID>/<UID>` rather than overwriting shared league tables; their own `.team` file remains the normal canonical save. Bridge/site merging of those separate snapshots is not implemented.

EASW's global last-login identity remains legacy code: authenticated mode **requires `--easw off`**, advertising that optional service disabled. This deliberately excludes in-game Dynasty Wire/media from the initial connection goal. Registry mode has not been enabled on the live league. Backups of the pre-change dirty server files are in `private/before-np-adapter`.

Enrollment rejects duplicate game online IDs because the game's C2B/T2B converter compares persona strings; choose distinct 3–16-character ASCII names. Server negative tests deliberately use duplicate names to prove they cannot select another numeric account, but those test names are unsuitable for a real two-player game. Bearer credentials are extractable from personalized executables: possession grants that account. Keep them private, revoke compromised credentials, and use a trusted network/tunnel for the replacement protocol; this work does not add transport encryption or website-account authentication.

## Reproduce and validate

From the repository root (Python on this host is the installed Python312 executable):

```text
node spike/blaze/tools/league-enroll.mjs REGISTRY.json NEW-PRIVATE-PROFILE.json NUMERIC_ID DISTINCT_ONLINE_ID
python spike/blaze/tools/ps3-np-adapter.py spike/blaze/private/EBOOT.elf NEW-PRIVATE-PROFILE.json NEW-UNSIGNED.elf
node --test spike/blaze/tools/ps3-eboot.test.mjs spike/blaze/server/league-auth.test.mjs
node spike/blaze/tools/test-league-auth-flow.mjs
```

Choose numeric IDs by explicitly mapping existing dynasty owners; do not infer mappings from display names. For a new member, add the intended DID to that registry entry's `joinDynasties`; the authenticated search/join flow then adds numeric membership. Never enroll the synthetic probe IDs as owners of the production league.

Start an isolated copy of the server/store with `node server/blaze.mjs --ticket-registry /path/to/REGISTRY.json --easw off --sync off`, plus the existing redirector/QoS services. Their advertised IP must be reachable from the console. The existing README's ICS/DNS setup redirects `gosredirector.ea.com`; RPCS3 IP/Hosts switches do not apply on hardware. No endpoint or console-wide NP settings were patched by the adapter.

`tools/test-np-qemu.py NEW-UNSIGNED.elf PROFILE.json` runs under WSL using the private extracted `qemu-user` and `binutils-powerpc64-linux-gnu` tools. Packages tested: QEMU 10.2.1 and binutils 2.46; no system package installation was needed. The Linux harness includes private game bytes and must stay private. It executes the injected PPC64 hooks, original request-return words and original deferred poll block. Only the two local RTC imports are mocked; a test tail return bounds the poll block. Each profile passed **33 scenarios** covering ticket bytes/bounds, invalid arguments, parameters, ABI, RTC failure, cancellation, and completion once. Linux-harness RWX linker warnings do not describe the PS3 ELF's separate RX/RW segments. Initial Unicorn 2.1.4 PPC64 attempts failed on standard instructions/MSR behavior and were discarded, not counted as validation.

The **9 Node tests pass**. The isolated real TCP/HTTP test passes invalid/preauth rejection, two identities, creation, authorized search/join, denied advancement, owner/member Locker access, isolated save transactions/table snapshots, commissioner/member saves, reconnect and revocation. It copies server modules to an OS temporary directory and never uses production data.

RPCS3 is installed and an existing user session was running. An additional `--help` invocation hung without usable output and only that newly started process was terminated. No patched full-game boot/menu test was completed. For the next emulator run use network Connected with **PSN Disconnected, RPCN disabled**, a separate game/save/config copy, and registry mode. RPCN/virtual NP identity, Basic/Lookup stubs, callback scheduling, system dialogs, RTC, permissive ELF loading and ignored SELF signatures can conceal hardware gaps; a successful RPCN run is not a signed-out test.

## Packaging and exact remaining blockers

Built [naehrwert/scetool](https://github.com/naehrwert/scetool) commit `d78d8986c9ab831f084516f21ecdf87080ac7b78` under WSL with `make LDFLAGS=-l:libz.so.1` (runtime zlib exists; development `-lz` symlink did not). `tools/scetool-app-keys.py` converts the public [RPCS3 APP key records](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Crypto/key_vault.cpp) into a private scetool file. Input source SHA-256: `a2947ff6b681258c198552ec6344e16685e2df649018206daa3f41a0a1aadbd7`. Original decryption through this tool matches `144dee...00c1c` exactly.

The template is **APP**, key revision `0004`, curve `0x14`, retail game/update Auth-ID, normal Vendor-ID, app version 01.00. Original control flags begin `40` and end `02`; capability flags are `0x7b`. Full decoded metadata is private in `original-self-decoded-info.txt`. There is no NPDRM block or content ID to invent. RPCS3 supplies a nonzero APP-04 private-key record, but not the loader-curve file required by scetool's signing path.

`tools/package-np-self.py` checks the original SELF and adapter hashes, preserves template metadata, includes all program headers, refuses overwrite, and requires decrypt-back equality for every loadable segment and program header. It records tool/data/output hashes. The initially missing 7744-byte `ldr_curves` was obtained from the [ManaGunZ project's own repository](https://github.com/Zarh/ManaGunZ/blob/master/pkgfiles/USRDIR/sys/data/ldr_curves), SHA-256 `2e4c829a6d798acd2b4de476eba0f36462ac1a06d05321a68ff5eb6aed74a66d`. `vsh_curves` remains absent but is not used for APP curve 0x14.

`tools/verify-self-signature.py` independently decrypts header metadata with OpenSSL AES, checks the curve/public-key points and verifies ECDSA using Python integer arithmetic. It passes against the untouched original AND both rebuilt files. The packager now requires that verification too. Probe B was packaged before adding that mandatory check; its original manifest retains `false`, but the subsequent independent check passed for the exact hash below. Signing randomness means SELF bytes can differ across reruns; the script records each result and requires the same intended ELF load bytes.

| Signed experimental APP SELF (private directory) | SHA-256 |
|---|---|
| `BLUS31159-no-psn-probe-a-EXPERIMENTAL.BIN` | `105e30d78a91c6e9aa3d1589cde8fcaf4972b0a4bb01a3584fb4e049908ce325` |
| `BLUS31159-no-psn-probe-b-EXPERIMENTAL.BIN` | `0afb286bc6a7afb263191b6f8c1486116af867c5fec25bf52a4df2b5fe7024d5` |

Both are real signed/encrypted SELF containers, not renamed ELFs or fSELFs. Both round trips reproduced the complete input ELF byte-for-byte. They preserve APP revision 0004 from the original; compatibility with this console's HEN loader remains **unverified**, not implied by valid cryptography. No console credentials, Sony contact, system-wide sign-in modification, or invented NPDRM identity was used.

Repackage under WSL: `python3 spike/blaze/tools/package-np-self.py SCETOOL DATA_DIR ORIGINAL_EBOOT ADAPTER_ELF NEW_EBOOT`. Here SCETOOL is `spike/blaze/third_party/scetool/scetool`, DATA_DIR is `spike/blaze/private/scetool-data`; use absolute WSL paths. Packaging no longer requires an input from the user. HEN/firmware is now confirmed above; the missing evidence is a physical boot/menu test. An isolated server copy is prepared under `private/physical-np-test` by `tools/prepare-np-test-league.mjs`, with no production stores or sync. [Install, first-test and rollback instructions](ps3-no-psn-test.md) identify the exact artifacts and next physical action. No test listeners were started or console files installed.

Remaining knowledge/runtime gates: complete UI join/connection flow with NP disabled; any indirect/unpatched NP Basic/Lookup paths; physical RX/BSS extension and RTC behavior; legitimate noncommissioner offseason carousel/contract operations under the new ACL. Some unreviewed DOD commands intentionally fail closed; a real client trace is needed to extend permissions based on the fields it actually sends. Head-to-head play remains separate. Code for the adapter and the tested server paths is written; full-game/hardware evidence is the current blocker, not an unwritten status/ticket stub or missing signing tool.

NP Basic handler registration, friend/message APIs and Lookup imports are present. Dynasty management demonstrated in RPCS3 uses Blaze/DOD/Locker/QoS, but absence of additional PSN dependencies on hardware is unproven. Real console head-to-head matchmaking, NAT traversal, invitations, presence and peer sessions are a separate scope; existing Playgroups replies do not prove those work.

## Physical tests and current results

2026-11-04 follow-up: after correcting update metadata, the user reports no PSN prompts but a title-server-shutdown message. Live process inspection at 12:52 UTC confirmed patched call word `494a8b69` at VA `0x719b88`, adapter context `0x18830a40`, ticketAvailable=1, ticketSize=72, completionResult=72, pending=-1, ready=1. This is physical evidence of the status/ticket/deferred-completion path executing, **not successful server authentication**. `tools/ps3-np-state.mjs` performs these read-only checks without reading the credential payload.

The normal supervisor had restarted with default non-test settings since the earlier session; it was stopped and the isolated registry/LAN-configured services restored. Those listeners still recorded no game connections during the retry. Two PktMon captures contained zero packets; the second also missed known successful webMAN control requests, so the capture is not validated and cannot establish absence of console traffic. Subsequently HTTP and FTP to `192.168.137.2` timed out and the PC neighbor entry was Unreachable despite Ethernet being Up at `192.168.137.1`. User confirmed the console remained powered on and cabled. Requested exit to XMB to distinguish game-correlated network loss from the underlying LAN problem; result pending. No further executable or console-network changes were made in this follow-up.

Deployment update, 2026-11-03 ~22:21 EST: user authorized console backup/install and test server switch. Complete PC backup saved under `private/console-backup-2026-11-03-np-test-complete`; physical original hash matches the original template. Player A SELF installed and read-back hash verified; remote rollback copy retained. Isolated listeners started, normal league/sync stopped, and DNS repaired with user-approved Windows elevation then verified against the ICS resolver. Console reported XMB. Actual game boot/OD tests below remain pending; see the [test handoff](ps3-no-psn-test.md).

Use an isolated test league/store, two provisioned identities, and a backed-up **update** EBOOT. Confirm the console actually launches that update, not disc 1.00. Keep original SELF and rollback instructions. Re-sign only after the adapter is ready; inspect metadata and decrypt the result back to compare the intended ELF/loadable bytes before deployment.

1. With HEN enabled and PSN signed out, boot and select Online Dynasty. Record exact screen, errors, timestamps and selected executable hash. Repeat after full reboot, not only a warm reconnect.
2. Confirm replacement redirector/Blaze/QoS/Locker traffic, expected numeric user/persona and distinct NCID. No fallback 1000/Player. Assert UserAuthenticated arrives and login completes.
3. Create a throwaway dynasty, grant/search/join as second user, load, save, exit/re-enter, disconnect/reconnect. Verify membership and commissioner ownership on server and website. Protocol join is implemented/tested; the console UI path remains untested.
4. Attempt unknown/malformed credentials, duplicate display names, wrong player ID, unauthorized DID/FID/TMID, non-member updates and non-commissioner advance. All must fail without changing another player's state.
5. Advance a normal week, complete a season, cross the recorded Generating All-Americans crash point into preseason, reload, verify uploaded file/week/year and intended rosters.
6. Overlap two logins and media/Locker requests; verify no last-login EASW identity bleed, no shared update transaction or cross-player team file changes. Revoke one credential and confirm the other still reconnects.
7. Capture traffic at the PC/router for the console IP, including DNS and destinations throughout boot/login/play/idle. Distinguish game traffic from XMB/system services. Removing this game's PSN dependency does **not** prove the console never contacts Sony.

The historical hardware notes describe FTP asset/roster transfer, not successful signed-out Online Dynasty. No new full-game emulator validation, console run or packet capture was completed for these changes. SELF signing, synthetic TCP/HTTP and QEMU execution results above must not be confused with those missing tests.
