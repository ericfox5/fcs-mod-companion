# NCAA 14 online protocol notes (spike M0a)

Source: identifiers harvested from the decrypted BLUS31159 1.02 EBOOT (kept private; not committed) plus
the game's `USRDIR/mcache` version block. Nothing here contacts EA; the servers are gone (2025-03-13).

## Stack
- Blaze SDK 3.19.3 (`BLAZVERS 03_19_03_00`), EA Tiburon OSDK 6.4.0, DirtySock 8.18.5, build Aug 7 2013.
- Client identifiers seen: `NCAA2014_PS3`, `NCAAFB14PS3`, `BLUS31159-DYNASTY` (save prefix).
- Redirector hosts: `gosredirector.ea.com` (prod), `gosredirector.online.ea.com`, `gosredirector.scert.ea.com`,
  `gosredirector.stest.ea.com`; HTTPS fallback `https://gosca.ea.com:44125/redirector`.
- Other hosts: `peach.online.ea.com`, `demangler.ea.com`, bugsentry (`reports.tools.gos.ea.com`,
  `elephant.online.ea.com`), QoS HTTP endpoints `/qos/qos`, `/qos/firewall`, `/qos/firetype`,
  `/getPeerAddress`, an `easw.easports.com` event XML namespace (EA Sports World media uploads),
  and `dynasty.easports.com` referenced in UI copy ("advance the week from dynasty.easports.com").

## Blaze components referenced (namespaces in TDF class names)
Mut (Ultimate Team, 242 names), GameManager, **DynastyOnDemand (88)**, Authentication, Rooms, Stats, Locker,
Playgroups, Util, GameReporting (OSDKGameReportBase), ScoreProcessor, Commerce, Seasons, Redirector,
OsdkTicker2, OSDKSettings, OsdkOnlinePass, Messaging, OsdkDynamicMessaging, LiveBannerAd, GridironClub,
OSDKDigitalDownloadPreview, LoginFlow, DynamicInetFilter, CensusData, Schedule, Mail,
GpsContentController, StoryCenter. Component ids/command ids are not strings; they come from the wire.

## DynastyOnDemand RPC surface (TDF request/response class names)
Create/Get/Join/FindDynasties, DeleteGameResult, GetDynastyStatus, GetExtraDynastySettings /
SetExtraDynastySettings, GetInvitations / SendInvitation / ProcessInvitation, RemoveMember,
TransferCommishStatus, SetAutopilot, SetReadyToAdvance, RequestAdvanceWeek, CheckAdvanceWeekStatus,
CancelAdvanceWeek, SetAdvanceWeekQueueClientStatus, SetReadyToUploadAdvanceWeekData,
StartDynastyUpdate / EndDynastyUpdate, GetSyncTables / GetTableUpdate / DodTableUpdate / DodRowUpdate /
DodTableFilter / TableSchema, UploadGameResults / RetrieveGameResults / GameResultsData,
DownloadViewDetailsData, UploadTransientSettings / DownloadTransientSettings, DynastyFileInfo,
ChangeUserTeam, MakeContractPick, OfferScholarship, ScheduleRecruitVisitConsole, VerifyProspectScout,
OptimizeProspectInfo, ProspectExtraBlazeData, TeamExtraBlazeData, ConsoleRecruitingState,
IncrementGamesStarted, SetMaxOwnedDynasties, SetOfflinePassword, CheckDynastyPassword,
DynastyNotification(s), DynastyUserInfo, MemberInfo/MemberStats, SchoolGuid, TeamRecord, DetailsTeamInfo.
Throttle keys: UPLOAD_DATA_AFTER_ADVANCE, UPLOAD_TEAM_DATA, DOWNLOAD_DYNASTY_DATA, DOWNLOAD_TEAM_DATA,
UPLOAD_GAME_RESULTS, RETRIEVE_GAME_RESULTS, UPDATE_PROSPECT_BLAZE_CACHE, VALIDATE_PROSPECT_PHONE_CALL,
TOGGLE_READY_TO_ADVANCE, TOGGLE_AUTOPILOT, SEND_SVS_SCORE_REPORT, LEADERBOARDS.

**Reading:** the dynasty lives server-side as *tables* (GetSyncTables / TableSchema / DodTableUpdate with
row updates), the console uploads game results and "data after advance", and the web app's Advance Week
Anywhere is a queued server job (AdvanceWeekQueueStatus). So a console still performs the advance and
uploads; the server is a table store + membership/queue state machine, not a simulation engine.
That is far more tractable than feared, but every TDF member tag of those 88 classes is still unknown
until the client sends them.

## Spike log
- 2026-10-28 (run 1, `--peek`): with the custom config the game resolved gosredirector.ea.com through the DNS hook and
  connected to 127.0.0.1:42127 three times (one per retry). ClientHello = **SSLv3** record (0x0300), no extensions,
  cipher suites RC4-SHA (0x0005), RC4-MD5 (0x0004), AES128-SHA (0x002f), AES256-SHA (0x0035). Node/OpenSSL 3 has
  SSLv3 compiled out, so `server/sslv3-server.mjs` implements the handshake itself (RSA key exchange + RC4 with
  SHA-1/MD5 MAC, RFC 6101). Self-test with a matching client: pass. Next gate: does ProtoSSL accept the forged cert?

## Spike setup (what was prepared)
- `server/gen-cert.mjs` – forged gosredirector.ea.com cert (MD5-signed, outer sigalg OID patched to rsaEncryption).
- `server/redirector.mjs` – SSLv3 redirector built on `sslv3-server.mjs` (`--peek` prints the raw ClientHello only).
- `server/blaze.mjs` – plaintext Blaze stub: logs every packet, answers Util preAuth/ping/config/postAuth.
- RPCS3 v0.0.32 custom config `config/custom_configs/config_BLUS31159.yml`: Internet Connected, PSN RPCN,
  `IP swap list: gosredirector.ea.com=127.0.0.1&&*.ea.com=127.0.0.1`, trace logging for sys_net,
  sys_net_dump, DnsHook, rpcn.
- Captures land in `spike/blaze/private/capture-*.jsonl` (gitignored).
- 2026-10-28 (run 3): ps3Login answered with ConsoleLoginResponse + UserSessions notifications; the client then
  stayed silent for 30 s, pinged, and logged out. Nothing else reached the Blaze socket, so it was waiting on
  something external: most likely the QoS ping site (PSA 127.0.0.1:17502 from preAuth). The EBOOT contains the
  DirtySock QosApi HTTP request `http://%s:%u/qos/qos?vers=%d&qtyp=&prpt=&inip=&inpt=&rqsc=` and XML paths
  `.requestid .reqsecret .qosport .numprobes .probesize .firetype .numinterfaces .ips.ips .ports.ports`.
  `server/qos.mjs` now listens on 17502 (HTTP placeholder XML + UDP echo) to capture the real exchange.
- 2026-10-28 (run 4): with LTPS populated the client sent ten 20-byte UDP ping probes to 127.0.0.1:17502 nine
  seconds after login (`00000003 00000001 00000000 00000000 <ms tick>`), then still logged out at +30 s: a plain
  echo is not a valid reply. DirtySock QosApi layout (from Skateboard3Server.Qos): ping reply = 20 echoed bytes +
  client external IPv4 + port + 4 zero bytes (30 bytes); bandwidth reply 1200 bytes; firewall probe 8-byte echo.
  RPCS3 DnsHook showed only two lookups (reports.tools.gos.ea.com, gosredirector.ea.com), both redirected.
  qos.mjs rewritten accordingly; start-spike.cmd / stop-spike.cmd launch and stop the three listeners.
- 2026-10-28 (run 5): full QoS HTTP+UDP sequence observed: /qos/qos (ping) -> 10 probes -> /qos/qos again -> 2 probes ->
  /qos/qos (bandwidth, qtyp=2) -> 10x1200-byte probes answered -> /qos/firewall?vers=1&nint=2 -> client closed its QoS
  sockets without probing: firewall XML rejected. The client parses `.ips.ips` / `.ports.ports`, so the lists must be
  nested (<ips><ips>..</ips></ips>); reference uses two firewall ports (17500/17501) with 8-byte echo. Fixed in qos.mjs.
  The 132-byte UDP packets were SSDP (UPnP discovery), unrelated.
- 2026-10-29 (runs 6-7): QoS now completes (ping, bandwidth, firewall probes on 17500/17501 all answered) and ps3Login
  is answered, but the client idled, pinged twice and logged out after ~75 s. Blaze 3 clients only move to the
  "authenticated" state on the UserSessions `UserAuthenticated` notification (30722/8), which the stub did not send.
- 2026-10-29 (run 8, two attempts, capture-2026-10-29T03-00-44-223Z): with 30722/8 sent after ConsoleLoginResponse the
  login state machine completed and the client fired its post-login burst in <0.5 s: Util postAuth, UserSessions
  updateNetworkInfo (ADDR union EXIP/INIP, NLMP {rs-prod-ps3:1}, NQOS), Util getTelemetryServer, Util userSettingsLoad
  KEY "AchievementCache", OsdkDynamicMessaging(2250) getConfig, UserSessions updateHardwareFlags, Authentication
  getAccount(30), comp 2054 cmd 1 {CHIN{CTYP 1, VERS 27}} + cmds 2/3/4 (Tiburon custom component, not identified),
  Rooms(21) selectViewUpdates, Messaging(15) fetchMessages x2 (TYPE "rmsg"/"anvt" magic), CensusData(10) subscribe,
  fetchClientConfig OSDK_TICKER / OSDK_ABUSE_REPORTING / OSDK_NETRADIO, OSDKSettings(2249) fetchSettings +
  fetchSettingsGroups, Stats(7) getKeyScopesMap. Every one of those got an empty reply, and RPCS3 then logged
  `VM: Access violation reading location 0x0` in thread FGGameSim at 0x010cb710 (emulation froze; the socket reset
  90 s later was the user terminating it, not a timeout). Disassembly of 0x010cb6c4 (TickerFacadeConcrete init):
  ServiceLocator->Get("stgm") (SettingManager), then GetGroup(table[0] = "O_SG_TCKR") -> NULL -> `lwz r4,0(r3)`
  crash; it then looks up setting "O_TKfilter". Zamboni's NHL server returns exactly O_TKfilter (string) inside group
  O_SG_TCKR, which confirms the cause. Also found in the EBOOT: setting groups O_SG_USER/O_SG_QMSG/O_SG_SYSS/O_SG_NRAD,
  settings O_TKsport/O_TKfriend/O_TF_* (ticker filters), O_SPAMEA/O_SPAMPART/O_FWD_EMAIL/O_EGstat/O_MYPT/O_OPPT,
  O_TELEMETRY, O_WO_NEWS, O_NetRadio; 70 SettingManager lookup sites in total (matchmaking groups MM*/SLVL etc. are
  only touched in head-to-head flows).
- Prepared for run 9 (blaze.mjs): OSDKSettings fetchSettings (LSIN 9 integer settings with MPVL Off/On, LSST 3 string
  settings) and fetchSettingsGroups (5 groups, LVWS empty like Zamboni); getAccount -> AccountInfo; Stats
  getKeyScopesMap -> empty KSIT map; Messaging fetchMessages -> MCNT 0; Rooms/CensusData -> empty; DynamicMessaging
  getConfig/getMessages; Ticker2 registerArgs/getMessages/updateFilters; OnlinePass fetchGates -> empty LIST;
  OSDK_TICKER config gets OSDK_TICKER_COUNT 0 (no ticker polling). Replayed the burst with a local client: every reply
  decodes. Component names in packet.mjs corrected (10 CensusData, 11 Clubs, 15 Messaging, 21 Rooms, OSDK ids).
- 2026-10-29 (run 9, two attempts, capture-2026-10-29T03-19-33-657Z): same request sequence as run 8; the ticker crash
  is gone but the game now faults 1 ms after the fetchSettingsGroups reply arrives: `Access violation writing location
  0x800004` (second attempt 0x400004) in FGGameSim at 0x00febde8 (smart-pointer Release). Call stack: CreateServerGroups
  (0x1022150) -> SettingGroupConcrete add-setting (0x107dd04) -> SettingGroupManagerConcrete::TriggerSettingGroupEvent
  (0x104ea20) -> SettingManager event handler (0x101ee50). Disassembly of the handler: it looks up setting
  "O_FWD_EMAIL" (global 0x1cb25c0) and, when present, allocates a new object and releases the previous one held at
  this+0x64, which was never initialised (garbage pointer into the text segment). So the full O_* set is harmful; the
  ticker code only needs group O_SG_TCKR + setting O_TKfilter (0x10cb6c4: group->GetView()->GetSetting("O_TKfilter")
  unguarded; the O_TKsport lookup at 0x10cb5c0 tolerates NULL). blaze.mjs now defaults to that minimal set
  (`--settings full` keeps the experiment list). RPCS3 trace for the timing: `sys_net_dump recvfrom ... 08 C9 00 02`
  (OSDKSettings cmd 2 response) is the last packet before the fault.
- 2026-10-29 (run 10, capture-2026-10-29T03-25-59-874Z, 143 requests): **login completes and the online menus work.**
  After the settings fetch the client went on to: Util userSettingsLoadAll, Stats getStatGroupList(3), Ticker2
  registerArgs {FILT, IDEN, LANG en, PLAT ps3, REGN BR, TITL NCAA, USER} then getMessages every 600 ms (it reads
  OSDK_TICKER_POLLING_DELAY as milliseconds; now 600000), OnlinePass fetchGates, userSettingsLoad "FirstTimeFlag" ->
  EA-account welcome/opt-in screens (localizeStrings SDB_EA_ACCT_*), Authentication hasEntitlement(33)
  {ETAG ONLINE_ACCESS, PJID 134279}, getLegalDocsInfo(242) {CTRY BR, PTFM 2}, updateAccount(20), userSettingsSave
  FirstTimeFlag=0, comp 2360 cmd 2 {CMID 2360}, fetchClientConfig OSDK_ROSTER, listEntitlements(32)
  {GNLS [NCAAFB14PS3Unlockable]}, comp 2151 cmd 1 {GTAG, LCAL enUS, MODE MAINMENU, NUID, PLAT ps3, TITL TIGER2010}
  (LiveBannerAd shape), DynamicMessaging getMessages {TOKN UltimateTeamEntry}, comp 2050 cmd 504 {CHIN{CTYP 1, VERS 238}}.
  Choosing Online Dynasty: localizeStrings for 30 SDB_DOD_* error strings, then **component 2148** cmd 13, cmd 70,
  cmd 93 (no body) and cmd 9 {DID 0, INVT 0} = DynastyOnDemand (getContinueDynastyInfoForUser / getInvitations /
  getDynasty style calls; all answered empty and accepted). "Create Online Dynasty" -> name entry -> Util
  filterForProfanity(20) {TLST [{DIRT 2, UTXT "RPCS38XLoBG4fU2OD1"}]} -> empty reply -> crash 1 ms later
  (0x0108c07c callback reads the TLST list without a NULL check). Fix: echo TLST with DIRT 0 (FILTER_RESULT_PASSED).
  Also added a persisted user-settings store (private/usersettings.json) so FirstTimeFlag survives restarts.
  EBOOT strings for the dynasty RPC names: createDynasty, deleteDynasty, FindDynasties, getContinueDynastyInfoForUser,
  getDynasty, GetDynastyBackups, GetDynastyHubNotifications, GetDynastyLockerFileMetaData, GetDynastyNotifications,
  GetDynastyStatus, GetDynastyUserInfo, getInvitations, GetSyncTables, GetTableUpdate, joinDynasty, processInvitation,
  removeMember, sendInvitation, UploadGameResults, AdvanceWeekQueueNotification (command ids still unknown).
  TDF metadata tables with raw tags exist in rodata (e.g. 0x17c0208 holds INVT/DID for the cmd-9 request); mining
  them should give every DynastyOnDemand response shape without trial and error.

## DynastyOnDemand protocol recovered from the EBOOT (2026-10-29)
- Component **2148**. Command ids from the client's getCommandName switch (0x771914..0x772900), e.g. 1 poke, 2 createDynasty,
  3 deleteDynasty, 5 getDynasty, 6 joinDynasty, 8 sendInvitation, 9 getInvitations, 10 processInvitation, 12 sendTableUpdate,
  13 getContinueDynastyInfoForUser, 14 removeMember, 20 SetActiveDynasty, 21 GetActiveDynastyInfo, 22 FindDynasties,
  23 GetTableUpdate, 24 UploadGameResults, 25 RetrieveGameResults, 26 GetDynastyUserInfo, 45 changeUserTeam,
  46/47 Upload/DownloadTransientSettings, 56 StartDynastyUpdate, 57 EndDynastyUpdate, 58 GetDynastyStatus,
  64 DownloadViewDetailsData, 70 GetDynastyHubNotifications, 71/72 Get/SetExtraDynastySettings, 83 CheckAdvanceWeekStatus,
  88 RequestAdvanceWeek, 89 CancelAdvanceWeek, 90 SetReadyToUploadAdvanceWeekData, 93 GetSyncTables, 100 CheckDynastyPassword,
  103 SetAdvanceWeekQueueClientStatus, 107..134 web-dynasty helpers (recruiting, awards, offseason). Full list in server/dod.mjs.
- TDF shapes: every class's member table lives in rodata and is reachable from the class vtable (slot 10); records are
  {tag, type:8 flags:8 offset:16, default} with 8-byte defaults for strings/enums/int64/flag 0x10. `tools/tdfextract.py`
  dumps all 832 classes to private/tdf-classes.json; the 88 DynastyOnDemand ones are in private/tdf-dod.txt.
  Examples: CreateDynastyRequest {ABBR, CALG map, CBID, DESC, DNF, DSKL, FATG, HFAE, ICTK, INJU, MHUM, NAME, OSKL, PASS,
  PDLC, PLCL, QTQB, QTR, SSOW, USKL, WTHR} -> CreateDynastyResponse {DID}; Dynasty (39 members incl. CMSH DynastyUser,
  C2B/T2B maps); GetSyncTablesResponse {TLST list<TableSchema{TLID,SYTY}>}; DodTableUpdate {BINC, DYID, FILT, FLTY, GHID,
  INTC, PACK, ROWS list<DodRowUpdate{BINY,INTV,SINT,STRV,TINT}>, RTID, SINT, STRC, TABL, TINT, TYPE}; generic
  DynastyOnDemandResponse {ENUM}; errors DynastyOnDemandError {ERRD, NCID map}.
- server/dod.mjs answers the whole surface with correctly shaped (mostly empty) replies and keeps created dynasties in
  private/dynasties.json. Not yet known: list element types for a few lists, enum values, and which tables the console
  uploads after creation (next capture will show sendTableUpdate bodies).

## Run 11 and the EA Locker file store (2026-10-29)
- 2026-10-29 (run 11, capture-2026-10-29T11-50-03-711Z, 92 requests): **no crashes; dynasty creation reaches the coaching
  tree.** createDynasty body: {ABBR "RPCS38", CBID 0, DESC "Enter Dynasty Description", DNF 0, DSKL 3, FATG 1, HFAE 0, ICTK 0,
  INJU 1, MHUM 12, NAME "RPCS38XLoBG4fU2OD1", OSKL 3, PASS "", PDLC 0, PLCL 1, QTQB 1, QTR 8, SSOW 1, USKL 3, WTHR 0}
  (the client omits empty lists/maps, e.g. CALG). Leaving the coaching tree ("Uploading team data"): DynastyOnDemand
  GetDynastyStatus(58) {DFON 0, DYID 1, STAT 5, TMID 40, WEEK 31, YEAR 0} then **Locker(20) createContent(1)**
  {CCAT "LeagueStorage", COID 0, DESC "1000", EDAT 0, NAME "RPCS3_8XLoBG4fU2;40;5;0;0.team", PERM 0}. Our empty reply ->
  "Online Dynasty is unavailable" (the user retried 4x, same pair each time). The team file travels through EA Locker +
  HTTP, not through the dynasty component.
- Locker protocol from the EBOOT. Command switch (getCommandName at 0x795860): 1 createContent, 2 createSubContent,
  3 confirmUpload, 4 updateContentInfo, 5 deleteContent, 6 copyContentReference, 7 bookmarkContentReference,
  8 getContentInfo, 9 ListContent, 10 getTopN, 11 getLeaderboardView, 12 updateRating, 13 incrementUseCount,
  14 setOwnerGroup, 15 removeOwnerGroup, 16 listContentForUsers, 17 WipeContent, 18 getCategoryList, 19 getLeaderboardList,
  20 ListContentForTag. Shapes (private/tdf-classes.json, tables at 0x1c97574..0x1c97b00 and 0x17d01c4..0x17d0400):
  CreateContentInfoRequest {ATTR, CCAT, COID, DESC, EDAT, NAME, PERM, SUBL, TAGS} -> {INFO ContentInfo};
  ContentInfo {ATTR list<Attribute{NAME,VALU}>, BOID objid, CCAT, CDAT, CID int64, COID, DESC, DFMT, EDAT, EID, ENAM, GPID objid,
  GURL, HIDE, NAME, PERM enum, RATE, RCNT, SIZE, STTS enum, SUBL map<string,SubContentInfo{GURL,STTS,UURL,XID}>, TAGS list<Tag>,
  UCNT, UDAT, URAT, UURL, XID}; ConfirmationRequest {INFO, STST} -> {INFO}; GetContentInfoRequest {CCAT, CID, CVSF} -> {INFO};
  ListContentRequest {ATTR, CCAT, CVSF, EID, GPID, MXRC, OFRC, PEND, PERM, REFF, TAGS} -> {LKRS list<ContentInfo>, MSIZ, TCNT};
  DeleteContentRequest {CCAT, CIDS list<int64>}; IncrementUseCountRequest {CCAT, CID}.
- Client flow (OSDK EALocker strategies, code 0x10a4000..0x10ae800): ContentUploadStrategy filters the name
  (Util filterForProfanity), ContentCreateStrategy = createContent, then `IssueRequest POST <UURL>&pers=<persona>`
  (0x10a8834; downloads use GET on GURL) with the file as the body, then ConfirmUploadStrategy = confirmUpload {INFO, STST}.
  The HTTP reply is parsed at 0x10a89d0 with DirtySock XmlFind: element "LOCKER" with attribute errorCode != 0 -> "LFU error";
  element "error" with children component/errorCode/errorName -> "Blaze component error"; an empty body or anything else
  -> success (code 0) unless the strategy expected a TDF reply. Download: getContentInfo -> GET GURL -> incrementUseCount.
  Header error codes are 16-bit; the client builds (code << 16) | component (its switch knows LOCKER codes 2,3,5,6,9,10,22).
- Implemented in server/locker.mjs (imported by blaze.mjs, HTTP endpoint on `--http-port` 17503 inside the same process):
  createContent answers a full ContentInfo with UURL http://127.0.0.1:17503/locker/upload?cid=N and GURL
  .../locker/download?cid=N, the POST stores the bytes under private/locker/<cid>.bin (index.json keeps the metadata),
  replies `<LOCKER error="" errorCode="0"></LOCKER>`, confirmUpload/getContentInfo/listContent/deleteContent/incrementUseCount
  work; unknown ids answer error 14 (assumed LOCKER_ERR_CONTENT_NOT_FOUND from the string-table order). Verified by replay
  (scratch smoke5.mjs): create -> POST 1000 bytes -> confirm -> getContentInfo -> GET returns identical bytes.
- tools/tdfextract.py fix: member types 0x0b/0x0c (object type/id) carry no default words, 0x0e (bool8) and 0x1b (64-bit id)
  one word; 26 classes (Locker, Stats, GameManager, Seasons, ...) were truncated before. Caveat: two tables laid out
  back to back with increasing tags merge (ContentReferenceRequest/IncrementUseCountRequest show GetContentInfoResponse's
  members; GetContentInfoResponse is just {INFO}, ListContentResponse {LKRS, MSIZ, TCNT}).
- Still open: what the ".team" file contains (DESC "1000" may be a size or schema version), which Locker/dynasty calls follow
  the upload (expect confirmUpload, then DynastyOnDemand sendTableUpdate/GetSyncTables or a ".dynasty" upload), and
  getContinueDynastyInfoForUser(13) still returns an empty list so the hub will not show DID 1 yet.

## Run 12: files and tables arrive (2026-10-29)
- capture-2026-10-29T12-14-53-438Z, 196 requests, no crashes. After the coaching tree the console did exactly the
  predicted Locker sequence and it worked: createContent -> `POST /locker/upload?cid=1` (14,346 bytes, user agent
  "ProtoHttp 1.3/DS 8.18.5.0 (PlayStation3)", no "&pers=" on this path) -> confirmUpload {INFO echoed back, STST 1} ->
  **setOwnerGroup(14)** {CCAT, CID, GPID objid (2148, 1, <DID>)} ties the file to the dynasty. Three files were stored
  (private/locker/): `<persona>;<team>;5;0;0.team` (zlib; inflates to a 50,000-byte EA DB with 21 tables: CAMW CPRF CREP
  CSKL COCH CUTP DCHT DYNI PLSU PLAY PLSS PINP PINT RADV RECB RCPR RCPT RECV TEAM TRAN USDT), `<persona>;<DID>;0;0.userdepth`
  (plain XML `<OnlineDynastyDepthChart><team id><player id position depth/>`), and `DYNASTY.dynasty` with DESC
  "<DID>;<unix time>" (1.5 MB zlib; inflates to a 4-byte prefix + the full 8 MB EA DB, i.e. the same format as the
  offline USR-DATA save, so packages/tdb applies to it unchanged).
- Table push protocol: StartDynastyUpdate {DYID, UPDT} then sendTableUpdate(12) per table (PACK = chunk index, up to 9 for
  PLAY) then EndDynastyUpdate {DYID, FID, NWST, NWWK, NWYR, TMID, UPDT}. UPDT 1 = the user's team subset (FILT {COLM, VALU}
  e.g. TGID=40 / CCID=39, 15 tables, FID = the .team locker id); UPDT 0 = the whole dynasty after "save online dynasty"
  (70 tables incl. PLAY 8694 rows, RCPT/RCPR/RCPU 2710, TPDA 7938, SCHD 786, TEAM 131, COCH 393, CITY, STAD, CONF, DIVI,
  BOWL, HEIS, AAPL, GOPT, SEAI; FID = the .dynasty locker id, TMID 1023). TABL and the column lists SINT/TINT/INTC/STRC/BINC
  are 4-char EA DB names packed byte-reversed into int32 ("TGID" = 0x44494754); rows carry SINT/TINT/INTV/STRV/BINY in the
  same order. Then optimizeProspectInfo(80) {PRED list<{PRID, SQUT}> for all 2710 prospects, TMED list<{BCSP, TMID}>}.
  server/dod.mjs now stores every table as private/dynasty-tables/<DID>/<TABLE>.json ({columns, rows, meta}); run 12
  replayed through the handler (scratch smoke6.mjs) gives 70 tables / 13 MB for DID 2 and TEAM shows all 196 columns.
- "The commissioner has made changes to the Dynasty that require you to restart." (string 0x173e06c, shown from the RtGm
  event handler at 0x33d1c4 case 0x19): the client keeps the dynasty file id it last reported (global+0x37c, set from
  EndDynastyUpdate's FID) and compares it with DynastyStatus.DFID; 0x334c78 does the same comparison on resume and
  downloads the dynasty file ("Downloading Dynasty File: ") when they differ. Our DFID was 0 -> dialog -> main menu.
  Fix: EndDynastyUpdate records FID (UPDT 0 -> dynasty fileId, UPDT 1 -> member teamFileId) and DynastyStatus returns
  {CFID = caller's team file id, DFID = dynasty file id, T2B, TEAM list<DynastyFileInfo{DFID, TMID}>}. getDynasty's FID too.
- The hub was empty because getContinueDynastyInfoForUser returned no entries; it now returns a ContinueDynastyInfo per
  dynasty the user belongs to (DYNA Dynasty, MUSR MemberInfo, GAMR/OREC/UREC zeroed, OPPO empty DynastyUser, SEAS text).
  The orphan DID 1 from run 11 (no file) was removed from private/dynasties.json so only DID 2 is listed.
- Story error ("retry / cancel story" right after the team push): no Blaze call, no HTTP request and no DNS lookup happened,
  so it fails locally. Strings point at the EA Sports World story pipeline (StoryHub, GameRecapStory/UserStory containers,
  ContainerXmsUploader with "story_data"/"story_media", StoryCenter component, "Write your game recap at
  dynasty.easports.com"). Parked: "Cancel story" is harmless.
- Still open: GetSyncTables/GetTableUpdate semantics (web -> console sync), what resuming a dynasty asks for (expect
  getContentInfo + GET of the .dynasty file), the ContinueDynastyInfo enum values, and the XMS story service.

## Run 13: resuming a dynasty (2026-10-29)
- capture-2026-10-29T12-35-26-976Z. The hub listed the dynasty (card showed the wrong logo: LOGO was 0). Choosing it:
  Locker getContentInfo(8) {CCAT LeagueStorage, CID 3, CVSF 0} -> `GET /locker/download?cid=3&pers=483665` (1.5 MB served) ->
  GetTableUpdate(23) x4 {DYNI, FILT{0,0}, TABL, UPDA}: FTCX (UPDA 1), COCH, CSKL, CONT (UPDA 0) = the console pulling
  web-side coach changes; empty DodTableUpdate accepted -> getDynasty(5) -> GetDynastyStatus(58) {TMID 1023} ->
  "save and overwrite?" prompt -> GetDynastyStatus again -> "commissioner has made changes" -> hub. No upload happened.
- Client internals (for the record): the status reply is copied into a flat struct owned by "DodVersionMgr"
  (ctor 0x312688, stored at global+0x314): two ids at +8/+0xc, then three 12-entry arrays (max 12 members): B2N pairs,
  TEAM {TMID, DFID} pairs, T2B {team u32, blazeId u64} pairs with the count at +0x198. The status request is job id 0x19
  (ctor 0x2f684c; request fields DYID, TMID, STAT from the current state, WEEK default 31, YEAR, DFON). The RtGm event-0x19
  handler (0x33d1c4) then: (1) compares the first id with global+0x37c = the dynasty file id the client loaded or uploaded
  (set at 0x3359a0 after a load from the requested id, at 0x3366a0 after "Upload Dynasty" from the new id) -> mismatch =
  restart dialog; (2) looks up the caller's team in the T2B pairs (0x3132ac) and compares it with
  `select 'DIGT' into ... from 'DIED'` on the loaded DB (DEID.TGID; the uploaded file says CCID 39, TGID 40) -> mismatch =
  the same dialog; (3) 0x33d084 checks every member's team against the in-memory ODYN/DYUS tables and fires RtGm.TmChg.
  The 'DNYD' (DYND) in-memory table holds per-column versions that the version manager refreshes (0x312d08 ..).
- Run 13 sent DFID 3 / CFID 1 and still looped, so the first id is not DFID as assumed; dod.mjs now puts the dynasty file
  id in both CFID and DFID (team file ids stay in the TEAM list). The hub card now takes TMNM (TDNA), LOGO (TLGL) and
  CONF (CGID) from the stored TEAM row of the member's team (Brown: TGID 40, CSAT KANSST, TLGL 41, CGID 7).
- Uploaded .dynasty blob = 4-byte prefix + EA DB (3,744,444 bytes, 175 tables incl. DEID, GINF, USDT, UOPT; no ODYN/DYUS,
  those are built in memory). Dumped with packages/tdb via tsx (scratch dumpblob.mjs).
- Run 14 (capture-2026-10-29T13-04-01-687Z): identical sequence with CFID = DFID = 3; the hub card showed Brown, the
  restart dialog still appeared (its button read "0" instead of OK). So check (1) passes and check (2) fails: the team
  lookup reads the B2N map, not T2B. 0x2f6aa8 copies a map<blazeId u64, team u16> (Blaze 3 TdfMap = vector of pairs,
  {u64 @0, u16 @8}, stride 0x10) into the {team, blazeId} pairs that 0x3132ac searches by blaze id; an empty B2N returns
  1023 != DEID.TGID 40. dod.mjs now sends B2N = {blazeId -> team} for every member with a team (T2B unchanged).
- Run 15 (capture-2026-10-29T13-11-56-255Z): same loop with B2N filled. The status job's response handler is the member
  function at 0x2f6bc8 (OPD 0x1be2280, reached through the RpcJob functor thunk 0x1441310): memset(dest, 0, 0x198);
  dest+0 = DFID, dest+4 = CFID; TEAM list -> dest+8 (count +0x68); GAME list -> dest+0x6c (count +0xcc); T2B map ->
  dest+0xd0 as {team, blazeId} pairs (count +0x190) via 0x2f6aa8, which reads each source pair as {u64 @0, u16 @8} =
  Blaze 3 TdfMap<uint64 blazeId, uint16 team>; B2N is iterated as {u64, u32} pairs and handed to a service call per entry.
  So the first check is DFID (correct since run 14) and the team lookup is T2B keyed by BLAZE ID; sending {team -> blaze}
  put garbage in the pairs and the lookup returned 1023. dod.mjs now sends T2B = {blazeId -> team} (and Dynasty's C2B/T2B
  the same way), CFID back to the caller's team file id, B2N empty.
- Run 16 (capture-2026-10-29T13-20-17-040Z): T2B keyed by blaze id, still the loop after the "save and overwrite" prompt.
  Both the local copy (BLUS31159-OD-<name>, header tail holds file id 3, dynasty DB at offset 102400 with DEID {39, 40})
  and the uploaded file agree with the status reply, so the two traced comparisons should pass. The prompt itself is the
  anomaly: it is the save flow ("UpDy" handler at 0x3365a4, reached through function pointers) starting right after the
  load, which only happens if the client believes something changed. The only load-time replies that could say so are the
  four GetTableUpdate answers (FTCX/COCH/CSKL/CONT); they now return an empty payload instead of an empty table named TABL.
  DynastyOnDemand error codes recovered (name switch): 51 USER_TEAM_CHANGED, 52 DYNASTY_WEEK_ADVANCED,
  63 DYNASTY_DATA_IS_LOCKED, 79 LOCKER_FILE_NOT_FOUND (full list printed by the scratch script; no "no update" code exists).
- Run 17 (capture-2026-10-29T13-36-27-893Z): empty GetTableUpdate payloads changed nothing. Data defect found instead:
  the member record carried coach 0 while the console's own push says the user-controlled coach of team 40 is CCID 39
  (COCH row with CFUC 1; the UPDT 1 push was filtered on CCID = 39). dod.mjs now derives COCH/C2B from the pushed COCH
  table. If the loop survives this, the next step is reading the two compared values at runtime (RPCS3 memory viewer:
  pointer at 0x1c7fb68 -> +0x37c local file id, -> +0x314 -> +8 server file id) instead of more static tracing.
- Run 18 + live memory read (RPCS3 memory viewer, dialog on screen): global object at [0x1c7fb68] = 0x13c75680;
  +0x37c (loaded file id) = 3; +0x314 -> 0x13ab4230 (status copy): DFID 3, CFID 1, pairs {team 40, blaze 483665}, count 1.
  So both status checks pass; the member check fails because the in-memory DYUS table is empty (the local save's header
  DB has DYUS with 0 rows). DYUS is filled by 0x2f4278 from the Dynasty record: it walks C2B pairs, strcmp's (0x69d6e4)
  the pair's string value against CMSH.PERS (DynastyUser.PERS@0x10) and the T2B pair strings, and inserts
  `use ODYN insert into DYUS set PSun=%s, UIXU=%s, CCID=%d, TGID=%d, TDNA=%s, TROV/TROF/TRDE/TRST, ODIC` per member.
  Therefore Dynasty.C2B = map<coach id, persona> and Dynasty.T2B = map<team id, persona> with STRING values, unlike
  DynastyStatus.T2B (blaze id -> team). dod.mjs now writes both as int -> string maps.
- Run 19: with the persona maps the local save's DYUS has the member row {Brown, ODIC 1, CCID 39, TGID 40, ratings,
  PSun persona}; still the loop. The member loop (0x33d084) then calls 0x447f2c(team): it selects TEAM.NCID for the team
  and asks the user service (vtable+0x38, the same method the status handler feeds with every B2N pair) for the blaze id
  behind that NCID, then compares the status team. B2N is therefore map<blazeId, NCID>. All NCIDs we issued were 0 and the
  uploaded file carries TEAM.NCID 0 for team 40 (uint 32 bits), so run 20 sends B2N {483665 -> 0}. The .dynasty prefix
  (0x5ca092be) matches none of crc32/crc32be/tdbChecksum over the DB, so the file is not edited. If 0 is rejected as an
  NCID, the fallback is nonzero NCIDs from the first contact and a freshly created dynasty.
- Run 20: B2N {483665 -> 0} still loops, so NCID 0 is not accepted. dod.mjs now issues NCIDs from 1 on first contact
  (store.users / store.nextNcid; persona 483665 -> 1) and returns them in GetContinueDynastyInfoResponse.NCID,
  DynastyUser.NCID and B2N. The dynasty whose file carries TEAM.NCID 0 (DID 2) was removed from private/dynasties.json
  (backup private/dynasties-did2-backup.json; its tables and locker files stay) so the next test is a fresh creation.
- Run 21 (capture-2026-10-29T14-06-16-852Z): **inside the dynasty for the first time** (fresh DID 3, NCID 1; team file CID 4,
  dynasty file CID 6, DFID 6). After the save: GetDynastyStatus, then Playgroups(6) createPlaygroup {JOIN 1, PGRP
  {NAME/UKEY "DYN3", MLIM 12, ...}} (answered empty -> "unable to connect to EA server"), then GetDynastyUserInfo(26)
  {BZID 0, DYID}, RetrieveGameResults(25) {DYID, WKID 0}, DownloadTransientSettings(47) twice (retry). Edit Player then
  crashed in thread ResStorageManager at 0x41f258 = the game's MemoryFailure handler (resource allocation failed), no
  network activity for 7 s before it; probably memory/asset related, to be checked against an offline dynasty.
  Stub: Playgroups component added to blaze.mjs (createPlaygroup -> {INFO PlaygroupInfo, MLST [member]} plus
  NotifyJoinPlaygroup 51; lookupPlaygroupInfo -> empty list), GetDynastyUserInfo now lists the members as
  DynastyUserInfo {AUTO, BZID, LDCL, LLOG, NCID, OFFP, PERS}, DownloadTransientSettings sends TSID as int -> string.
- Run 22 (capture-2026-10-29T14-17-30-806Z): resume works (yes to overwrite), landed inside. Load-in sequence: 19 team/coach
  filtered GetTableUpdate calls, GetDynastyUserInfo {BZID me}, GetDynastyNotifications(69), SetMaxOwnedDynasties(67)
  -> "unable to connect" dialog (one of those three), then Locker listContent {GPID dynasty objid, PEND 1, REFF 8} (our
  EID-0 filter wrongly returned nothing), GetDynastyStatus, createPlaygroup + finalizePlaygroupCreation(9), 26/25/47.
  Advance from preseason: GetTableUpdate x23 again, ReportConsoleRecruitingState STAT 1 then 0, 26/25/47, then
  "Collect User Data": listContent {EID me, PEND 1} -> deleteContent of everything returned -> createContent
  "<persona>.cussced" (5,884 bytes, custom schedule) -> confirm -> setOwnerGroup -> strings SDB_DOD_UTPE/DTSD/UTPM/DTSM
  -> file transfer error dialog ("Retry now / Exit dynasty"). Because the stub answered the pending-only listing with all
  six confirmed files, the console deleted CIDs 1-6 (both dynasties' team, depth chart and dynasty files). locker.mjs now
  filters EID (0 = any), GPID (owner group recorded by setOwnerGroup) and PEND 1 = unconfirmed only, and deleteContent
  moves blobs to private/locker/trash/ instead of unlinking. Index records for CIDs 4-6 were rebuilt from the run-21
  capture; the blobs themselves must come back from OneDrive's recycle bin or a new dynasty must be created.
- Runs 23-24 (capture-2026-10-29T14-32-56-348Z): fresh DID 4 (team file CID 8, depth 9, dynasty 10). Resume and load fine;
  advance from preseason: CheckAdvanceWeekStatus(83) -> RequestAdvanceWeek(88) -> SetAdvanceWeekQueueClientStatus(103) ->
  GetDynastyStatus -> Locker getContentInfo(own .team) -> "Step 1 of 5: Downloading Coach Weekly Goal Changes Data" =
  17 GetTableUpdate calls (COCZ, CREZ, PLYZ, PRIZ, RADZ, REBZ, RPRZ, REVZ, TEMZ, PPMC, PINZ, PLSZ, TRAZ, CSCH, CACH, CPFC,
  CAWC filtered on coach 39 / team 40) -> getContentInfo + GET of the own .team file -> crash at 84% in FGGameSim at
  0xa6a8fc (DB helper 0xa6a874 used by the ODTM/ODGM/ODCN/DYNI merge routines 0x43ebdc..0x440370, null table + 0x11).
  GetTableUpdate goes back to the structured no-rows DodTableUpdate (TABL echoed).
- Run 25: same crash with the structured table replies, so they are not the cause. Register dump at the fault (RPCS3
  debugger): r27 = 0 (query result), r4 = 2, r5/r7 = 0x15 = 21 (count), r29 -> {0x13aabc40, 0x11}; the callers of the
  DB helper 0xa6a874 that pass 21 are 0x43ebdc and 0x43f4d0, the routines merging a downloaded team file's COCH/DYNI/TEAM
  data into the in-memory ODTM/ODGM/ODCN tables. The file merged was the client's own .team upload, taken from
  DynastyStatus.TEAM {DFID 8, TMID 40}; the real service lists other coaches' weekly change files there. The own team is
  now excluded from TEAM (CFID still carries the own file id).
- Run 26: with the own team removed from DynastyStatus.TEAM the resume check loops again, so TEAM must list it (the load
  path looks the own team file up there via 0x31321c). Reverted. The "%s Data" step names in the binary (Coach Reputation,
  Coach Performance Changes, Player Promises, Scouting, Advisor, Recruiting Board, Recruit Preferences, Prospect,
  Transfers, Coach Contracts, Cut Players, Coach Goal Changes, Coach Skills Changes, Coach Weekly Goal Changes) are the
  web-side change categories; the advance steps also include "Downloading Team Data file for", "Downloading Game Data
  for", "Downloading Custom Schedules", "Advancing to Week %d" (console-side sim) and "Uploading Dynasty File".
- Run 27: stack frame read at the freeze: return address 0x43fe94 -> caller 0x43fe68 (sole caller 0x33ad30, the download
  completion that decompresses a buffer, "contractUncompressedOutBuffer", opens it as a DB and validates table ODCN).
  No stored file has an ODCN table, so DynastyStatus.TEAM[].DFID is the id of a server-built per-team change package
  ("Checking for team data" in the Dyn.SvrData task), not the team file; CFID is the own team file. TEAM now lists every
  member's team with DFID 0 (no package) until the stub produces such packages from web changes.
- Runs 26-27: TEAM empty or DFID 0 -> at load the client skips the team-data download and the 19 GetTableUpdate calls and
  loops on the restart check; so at load TEAM[own].DFID must be the team file. The load asks GetDynastyStatus with
  TMID = own team, the advance step with TMID 1023 (seen in every capture). Rule now: TMID 1023 -> TEAM empty (no change
  packages), otherwise TEAM lists the members' team files. The .cussced upload (run 22) is not a DB: 4-byte size + zlib of
  a raw SCHD record export (columns GSTA GASC GHSC SGID GTOD GUTE GATG GHTG SESI CPCK HPCK SGNM SEWN SEYR GDAT GFOT SEWT
  GFFU GFHU GMFX). COCH column subsets used by the ODTM/ODCN merges: CPID CDID COTR CDTR COTA CDTA COTS CDTS COIN COPM COPK
  CFSC CFBL CFRC COST CDST CQBI CHBI CFBI CWRI COLI CDEM CDTI CLBI CCBI CSFI CQBT CHBT CFBT CWRT COLT CDET CDTT CLBT CCBX
  CSFT PDLC (37) and CPID COST CDID CFBL CFSC CFRC CFBL COTR COTA COTS CDTR CDTA CDTS (13).
- Run 28: still looping, and no overwrite prompt (local copy kept). Since run 27 the console reports STAT 2 in
  GetDynastyStatus (it was 5 before the crashed advance); the stub kept STTE 5 in the Dynasty record. STTE now follows the
  last reported STAT (2 = advance in progress, 5 = regular).
- Run 29: fresh dynasty "test2" (DID 5) resumes into the loop with the TMID rule, so the post-load TMID-1023 status also
  needs the team files in TEAM. Reverted to run-22 behaviour. Open question for the advance step: the console-side
  "Collect User Data" step (seen only in run 22, after recruiting: ReportConsoleRecruitingState 1 -> 0) uploads
  .cussced and presumably a team data package; the step-1 download expects such a package (ODCN) rather than the
  coaching-tree team file.
- Run 30: resume fine (TEAM = team files), advance froze again at step 1 after downloading the own team file twice; no
  Collect User Data step occurred. The ODTM/ODGM/ODCN names are DATABASE names ("use 'MTDO' ... from 'MAET'", i.e. the
  team file opened as ODTM at load; ODGM holds GINF/WQSC = a game data file; ODCN = the step-1 "team data" package).
  Stub: TEAM is empty while an advance is in progress (flag set by RequestAdvanceWeek, cleared by getDynasty or
  EndDynastyUpdate), team files otherwise.
- Run 31: resume of test2 after the crashed advance loops although the local copy is consistent (HED file id 13, DYNI,
  DYUS row, DEID 40 all match). The only server-side difference from run 30 was STTE echoing the console's STAT 2; STTE
  is back to the NWST-derived state (5). The mid-advance local save folder BLUS31159-OD-TEST2 was renamed to
  BLUS31159-OD-TEST2.bak-run31 so the console re-downloads dynasty file 13 (pre-advance) on the next resume.
- Run 32: resume with no local copy worked (file re-downloaded, no prompt). Advance: 83 -> 88 -> 103 -> 58 (TEAM empty)
  -> getContentInfo(CID 11 = CFID, the own team file) -> GET -> same crash (0xa6a8fc, ODCN open). So during an advance the
  client takes CFID as its own change package; CFID is now 0 while an advance is in progress. Local copy set aside again
  (BLUS31159-OD-TEST2.bak-run32).
- Run 33: **the console advanced the week locally.** Flow: CheckAdvanceWeekStatus -> RequestAdvanceWeek -> SetAdvanceWeek
  QueueClientStatus {STUS 0} -> GetDynastyStatus (TEAM/CFID empty) -> GetTableUpdate x4 (FTCX/COCH/CSKL/CONT) ->
  getDynasty -> GetTableUpdate x17 (team/coach filtered) -> local sim ("Advancing to Week 1") -> DownloadTransientSettings
  -> SetReadyToUploadAdvanceWeekData(90) -> our AQST {BGUP 0} -> "WAITING TO BEGIN UPLOAD / heavy traffic, next in line"
  forever (DisplayAdvanceWeekQueueHeavyTrafficMessage). The console never polls again; it waits for BGUP 1 (or an
  AdvanceWeekQueueNotification carrying AdvanceWeekQueueStatus). The reply now says BGUP 1. Next expected: the upload
  (team files, dynasty file, table pushes with UPDT) and EndDynastyUpdate with the new week.
- Run 34 (capture-2026-10-29T15-42-51-764Z): **first complete online week advance (preseason -> week 1).** After
  BGUP 1: createContent DYNASTY.dynasty (DESC "<DID>;<time>", 1.8 MB) -> upload -> confirm -> setOwnerGroup ->
  createContent "<DID>;0;0.depth" (7,597 bytes) -> upload -> confirm -> setOwnerGroup -> SetMaxOwnedDynasties ->
  StartDynastyUpdate UPDT 0 -> 67 sendTableUpdate -> EndDynastyUpdate {FID 14, NWST 7, NWWK 0, NWYR 0, TMID 1023} ->
  optimizeProspectInfo -> Messaging sendMessage(1) {ATTR {65282: ""}, FLAG 2, TAG ...} (dynasty wire post?) ->
  Locker deleteContent [13] (the previous dynasty file only; the listing filters hold) -> GetDynastyNotifications ->
  listContent by group -> 26/25/47. Stub record: state 7 (regular season), week 0 (= week 1), fileId 14, tables refreshed.
  The console simulates the week; the service is storage + queue + change distribution, which this stub now covers.
- Run 34b: re-entering after the completed advance looped. Cause: case 58 copied the status request's WEEK (always the
  placeholder 31) into the record, overwriting NWWK 0 from EndDynastyUpdate, so the Dynasty reply said week 31 while the
  console was at week 1. The status request no longer updates week/year. Note: after the advance the console reports
  STAT 2 while EndDynastyUpdate said NWST 7; STAT (console state) and NWST/STTE (dynasty stage) are different enums.
- Run 35: resume after the completed advance still loops with week fixed. The advance uploaded DYNASTY.dynasty (14) and
  "5;0;0.depth" (15) but no refreshed team file, so the load merged the preseason team file (11) into the week-1 dynasty.
  Rewound the stub to the pre-advance state (file 13 restored from trash, state 5, week 31), set the local copy aside,
  and changed the advance-time status: TEAM lists the team files again, CFID alone is 0 during an advance.
- Run 36-37: playing a game (and Play Now, with the untouched offline per-game config) crashes RPCS3 0.0.32-16709 on the
  _gcm_intr_thread at 0x00f667b8 (bad pointer, no RSX warnings). The per-game settings are identical to the 0.0.29 install
  that plays fine, so it is the build. 0.0.29 cannot host the online route: with PSN "Simulated" the game dies with
  "RPCN is required to use PSN online features". Plan: a newer RPCS3 build for the online install (copy
  config/custom_configs/config_BLUS31159.yml, config/rpcn.yml, config/games.yml and dev_hdd0/home/00000001/savedata).
- Match loading: Play Now crashes on 0.0.32-16709 and 0.0.43-20506 at the same gcm interrupt site, with disc image,
  installed data/caches, firmware (4.91), GPU and renderer options proven identical to the 0.0.29-15767 install that
  plays fine (also with MT RSX / async texture streaming off, and with the stray disc-side DLC folder set aside).
  0.0.29 cannot go online: RPCN server protocol 34 vs client 19. Open: find the emulator-side cause for current builds.
- Run 38 (capture-2026-10-29T17-42-29-820Z, RPCS3 0.0.29 + private RPCN protocol 19 in WSL, persona "efox" NCID 2,
  DID 6): **create, advance twice, play a game: all working.** Post-game protocol: IncrementGamesStarted(43) before the
  match; afterwards StartDynastyUpdate {UPDT 2} -> 14 sendTableUpdate with FLTY 2 and GHID = game id (IGAM, PGOF, PGOL,
  PGDE, PGKP, PGKI, GINF, TSGA, PGNG, UWQS, SCOS, CSGM/CACG/CASG filtered on CCID) -> UploadGameResults(24) {quarter
  scores AQ1S..HQ4S, ATID/HTID, ATSC/HTSC, CRCT, GMWK, OTFL, STCT, TMID, FLID 0} -> EndDynastyUpdate {FID 0, UPDT 2} ->
  GetDynastyStatus -> new team file "<persona>;<team>;7;1;0.team" + ".userdepth" (UPDT 1 push) -> deleteContent of the
  old team file -> ReportConsoleRecruitingState -> 26/25/47. Two stub bugs: FID 0 of the UPDT-2 report was taken as the
  dynasty file (resume then asked the locker for content 0 -> "Unable to continue the Online Dynasty"), and
  RetrieveGameResults returned nothing (game shown as unplayed, "play this game" -> restart dialog). Now: UPDT 0 only
  sets the dynasty file; results are stored per week and returned by RetrieveGameResults {GRLI list<GameResultsData>,
  TIDL [teams]} and in DynastyStatus.GAME; UPDT-2 pushes replace rows of the same GHID instead of wiping the table.

## 2026-10-29 — site sync (after run 38)

- The stub is now the league's dynasty server; the companion site mirrors it. `bridge/src/od.ts` reads
  `private/dynasties.json` + `private/locker/<cid>.bin`; the DYNASTY.dynasty blob is one zlib stream whose payload is
  4 unknown bytes + a full EA DB (174 tables, same set as an offline save), so `exportDynasty` decodes it unchanged.
- `ncaa-bridge od import|list|watch` (bridge/src/commands/od.ts): members (persona, team, NCID, coach CCID, team file),
  the dynasty's settings (the createDynasty request), uploaded results (`d.games`, laid over SCHD rows that are still
  GSTA 1, bumping W-L/streak/conference records) and the files (DYNASTY.dynasty + team files) go to the Worker; a
  fingerprint of (fileId, fileSavedAt, week, members, results) decides when `watch` re-imports (8 s of quiet after a
  change). Sync state lives in `~/.ncaa-bridge/od-state.json`, keyed by site URL. `start-spike.ps1` opens the watcher
  as a fourth window; `stop-spike.cmd` stops it too.
- Worker: migration 0002 (dynasties.od_id/abbr/description/state/week_type/od_file_*, od_members, od_results,
  snapshots.week_type); `POST /api/bridge/dynasties` with an `od` object upserts by DID (the slug stays stable); games
  rows carry `source` ('online' for overlaid results). Home page: members box, current-week user games, scores of the
  latest played week, status line (year/week/file id/sync time). Week label = SEWN + 1; SEWT 151 = preseason.
- Week numbering check: a fresh save has SEAI {SEWN 0, SEWT 151}; after three advances the online file has {SEWN 3,
  SEWT 3} and the user's played games sit at SEWN 1 and 2 (GMWK = SEWN); the SEWN 0 games were simmed on the first advance.
- Hub card fix for the unchecked "Play Game" item: ContinueDynastyInfo.GAMR now carries the member's uploaded result for
  the current week (GPLD 1, USCR/OSCR, OVTF); UREC/OREC come from TEAM.TSWI/TSLO, ONME is this week's opponent from
  SCHD. Replayed through handleDod (week 3 = bye: GAMR zeros, UREC 3-0); not yet seen on the console.

## 2026-10-29 — write-back channel + experiment W1 (armed, not yet run)

- During step 1 of an advance the console calls GetTableUpdate for its per-user Z tables, filtered by its ids: COCZ
  (CCID), CREZ (CCID), PLYZ/PRIZ/RADZ/REBZ/REVZ/TEMZ/PPMC/PINZ/PLSZ (TGID), REPZ/RPRZ (PTCM = team), plus CSCH/CACH
  (CCID), CPFC/CAWC (TGID) and FTCX/COCH/CSKL/CONT unfiltered. UPDA is 1 for the tables it pushed itself (COCZ, PLYZ,
  REPZ, RPRZ, TEMZ, FTCX). Until now every reply was an empty DodTableUpdate. These are the rows the original web site
  sent back (recruiting board/points/visits, roster edits), so this is the site -> console channel.
- dod.mjs now answers GetTableUpdate from `private/web-edits/<did>/<TABLE>.json` (columns + rows, same shape as the
  stored pushes), filtered like the request, encoded as a DodTableUpdate with one row struct per row (only the
  non-empty lists, the way the console sends them). No file = empty reply as before.
- W1 = `tools/seed-web-edit.mjs 6`: PLYZ for team 40 seeded from the console's own push (69 players, deduped by PGID)
  with one change, Pearson Hill (PGID 2861) jersey 16 -> 97. Expected on the next advance: no crash in step 1, and the
  jersey shows 97 in-game afterwards. If step 1 crashes or loops, delete `private/web-edits/6/PLYZ.json`. The Z-table
  layouts for REBZ/REVZ are still unknown (the console pushed them empty); RECB/RECV layouts are the first guess.
- Listeners must be restarted (stop-spike / start-spike) to pick up today's dod.mjs changes (GAMR hub result, web edits).

## 2026-10-29 — W1 PASSED: web edits reach the console

- Run with the seeded PLYZ (Pearson Hill jersey 16 -> 97): step 1 pulled PLYZ twice (GetTableUpdate TGID=40, UPDA 1),
  the advance completed (EndDynastyUpdate NWWK 4, FID 37), and the console then pushed PLYZ back with the player at 97;
  the user confirmed 97 in-game. So rows served through GetTableUpdate for the per-user Z tables are merged into the
  console's data at the advance. Next: REBZ/REVZ (recruiting board/visits) with the RECB/RECV layouts (W2), then
  PLYZ position/redshirt changes.
- The hub card fix (GAMR etc.) also passed: the "Play Game" checklist item ticks after the game.
- In-game "photo" snapshots land in USRDIR as `Pic-<name>_NN` (raw frames, see the XML next to them) plus
  `Highlight Directory.mlist`; candidate source for Dynasty Wire story images.

## 2026-10-29 — in-game photo format (partial) and W2 armed

- Photos taken from the in-game replay land in USRDIR as `Pic-<session>_NN` next to `<session>.xml` (Type="Photo":
  teams, score, play description, quarter/time, weather, events per play) and `Highlight Directory.mlist`.
  Container: magic `MC02`, u32 file size, u32 header size (0xB0), u32 payload size (0xE1000 = 921,600), then metadata
  (0x280 x 0x168 = 640x360 display size, scores, bowl id, the play text at +0x34). Payload = 57,600 blocks of 16 bytes:
  `00000000 | c0 c1 (565, little-endian) | 4 index bytes (little-endian) | ffff0000`, i.e. a DXT1-style colour block with
  an opaque alpha block split around it, for a 1280x720 texture; the block order is tiled in 256-px columns with a
  further interleave that is not resolved yet (rendered output is recognisable but striped). The sample shows a
  broadcast player-card graphic, so the capture may be a composited frame. Parked: RPCS3's own F12 screenshots are
  plain PNGs and serve the Dynasty Wire just as well; the XML next to the photo is still useful as an auto-caption.
- W2 armed: `tools/seed-rebz.mjs 6 40` wrote private/web-edits/6/REBZ.json = Brown's 35 RECB rows (RECB column layout,
  which is a guess for REBZ) with the highest board slot that had 0 points this week given 250, next to the 500 the user already put on Stan Burgess in-game. Expected after the next advance:
  the console's RECB push shows the points spent (PPSL) and the prospect's interest in Brown moves. PLYZ seed removed
  (delivered; the console pushed jersey 97 back).

## 2026-10-29 — W2 PASSED, recruiting editor shipped

- W2: the 250 points seeded on Brandon Cooper (REBZ in the RECB column layout) showed in-game after the advance. So
  REBZ accepts RECB-shaped rows {PSCP, PPSC, PPSL, TGID, PRSI | USEL, PROR, PEPV}; TEMZ.TRPA is the weekly budget
  (Brown 5,500) and TRCP the points left.
- Site: /d/<slug>/recruiting is an editor for the member's own team (persona from the od_member cookie, set by the
  "You" select in the top bar; a single-member dynasty needs no cookie). Points per prospect (0-500, tens), scouting
  points (experimental), order, remove (experimental), add from a name search (35 slots), budget enforced. Saves go to
  D1 web_boards (one desired board per team+week, full rows).
- Bridge: `od watch` pulls pending boards every third tick (`od edits` does it once) into
  private/web-edits/<did>/REBZ.json (all teams in one file; the stub filters by TGID) and acks a board once the store's
  week has moved past it (GET/POST /api/bridge/web-edits). The sync window must be restarted to run this code.
- Open: whether the console deletes a board row that is missing from REBZ (remove) and what it does with PSCP (scout);
  both are exposed in the UI as experimental until an advance proves them. Visits (RECV/REVZ) not exposed yet.

## 2026-10-29 (evening) — player editor, News Wire, performance pass

- Player editing: /d/<slug>/player/<pgid> has an Edit card for the owner (or commissioner): jersey (proven), position,
  redshirt, names (experimental). Stored in web_player_edits; the bridge builds web-edits/<did>/PLYZ.json from the
  console's last PLYZ push (deduped by PGID) with the edits applied, acked once the week moves on (?kind=player).
- News Wire (renamed from Dynasty Wire): member stories with an image (R2 stories/<dyn>/...), newest first, hero on the
  home page; game headlines below. Routes /stories/new, /stories/<id>/edit, /stories/<id>/delete.
- Recruiting desktop rows: full columns (pos, stars, rank, ht, wt, scouted OVR = RCPT.RCOV, interest, last wk, points,
  scout, PT, controls), sortable headings + pos/stars filters (client side); mobile keeps the compact rows. Top 300
  shows 100 rows by default (?all=1 for all).
- Performance: logos served as 64/160 px variants (logos/teams64, teams160, conf64; made with System.Drawing from the
  500 px originals: 7.2 MB -> 0.55 MB for the small set), ticker moved from requestAnimationFrame to a CSS animation,
  content-visibility on long lists, async image decoding with explicit sizes.

## 2026-10-29 — everything delivered through GetTableUpdate is live on LOAD, not just at the advance

- User report: position, redshirt, name, board removal and scouting edits all applied, and they appeared as soon as the
  dynasty was refreshed/resumed on the console (the load path calls GetTableUpdate for the same Z tables as the advance).
- Consequence: a pending web board was re-served on every load until the week changed, so a later in-game change to the
  same board could be overwritten. The bridge now also acks a board when the console's RECB push is newer than the save
  and matches it (points + order per prospect), and a player edit when the PLYZ push is newer and carries the edited
  values. Week-based acks remain as the fallback. Site copy changed from "at the next advance" to "when the dynasty next
  loads"; the experimental labels came off.

## 2026-10-29 (late) — visits, captures, and the photo format closed out

- Photo format, final: `Pic-*` payload = 16-byte blocks `[0000 0000][c0 c1 565 LE][4 index bytes LE][ffff 0000]`
  (DXT1 colour block with an opaque alpha block split around it), laid out as a 1024-pixel-wide texture (256 blocks
  per row) starting 96 blocks (1536 bytes) into the payload, main level 1024x576 followed by its mip chain. BUT both
  photos from the session carry byte-identical payloads showing a stale "player card" texture (a Lafayette LB), so
  under RPCS3 the game never gets the replay frame into that buffer. Decoder kept in the notes only; the News Wire
  capture path uses RPCS3's own screenshots (F12 -> <rpcs3>/screenshots), converted to JPEG by bridge/scripts/to-jpeg.ps1
  and captioned from the game's highlight XML (one <AP: Type="Photo"> block per in-game photo: local time, teams, score,
  quarter/clock, play text) when an entry is within 5 minutes of the screenshot.
- Visits: RECV = {VMVP, TGID, PRSI, OFGP | RCWK, NFGZ, NFGM}; RCWK = week of the home game, OFGP = expected value set at
  scheduling (350/450 typical), VMVP/NFGZ/NFGM filled after the visit (500-1000 / 3-4 / 2-4 on the completed week-5
  visits). The site schedules visits per prospect on remaining home-game weeks; delivered as REVZ (RECV layout) and
  acked when a newer RECV push lists the same prospect/week pairs. First real test pending (W4).
- Captures: `PUT /api/bridge/captures` stores stories/<dyn>/cap-<name>.jpg (served by the story image route) + a
  `captures` row; `od watch` scans the screenshot folder every sixth tick; the story form offers the last 24 captures as
  a picker and copies the object into the story.
- Accounts shipped (migration 0008): invite codes, PBKDF2 passwords, HttpOnly sessions; the first invite comes from the
  bridge (`od invite`), later ones from a signed-in commissioner on /members. Until the commissioner joins, the dynasty
  stays in persona-cookie mode. `od captures` added to the CLI; `od watch` runs it every sixth tick.

## 2026-10-29 (night) — Supersim integrated

- Package: FCS-Supersim-Claude-Handoff-v2 (engine 1.1.0, 25 tests pass). Integrated as worker/src/supersim (routes,
  access, engine, result), worker/public/js/supersim + css/supersim.css, migration 0010 (supersim_games ledger + the
  supersim_schedule / supersim_game_logs views that overlay official results; getGames/getGame/getGameLogs read the
  views). Identity: the site's own session (acting member) instead of the package's HMAC cookie. Quarter length from
  the dynasty's QTR setting (8 min -> 480 s). Routes: GET /d/<slug>/supersim (page), GET/POST /d/<slug>/supersim/data
  (start = server-seeded simulation, one durable result per game, retry returns the same run), bridge outbox
  GET /api/bridge/supersim?od=N + POST .../<run>/receipt.
- Console side: spike/blaze/server/supersim.mjs runs inside blaze.mjs (reads workerUrl+token from ~/.ncaa-bridge/
  config.json), polls the outbox every 5 s, validates (week, ownership, schedule row still unplayed, no console
  result) and registers the GameResultsData-shaped result in d.games[week] (CRCT 0, STCT 0) -> receipt accepted;
  synced once the console's SCHD push shows the final with the same score; conflict if the console uploads its own.
  dod.mjs case 24 flags a console override of a Supersim result. Unproven: whether the console treats a results-store
  entry with CRCT 0 as a played game at load/advance and how season stats are credited (the package deliberately did
  not fabricate the stat-table merge). First real test = the user's next Brown game.
- Local dry run on the dev DB: Brown 35-7 at Duquesne, 80 plays, 0.3 s; retry idempotent; game page shows the box score
  via the views; adapter accepted the envelope on a copy of the real store and rejected a stale week.

## 2026-10-29 (late) — Supersim revamped into coaching mode

- Playbooks: decoded the BGFA 1.05 `.ast` container and the playbook EA DBs (qkl_misc #7 master, qkl_boot #356 PLAB
  list, #360 shared base). `tools/playbooks-extract.mts` writes one JSON per book to worker/public/data/playbooks
  (143 books, 16 MB, gitignored). TEAM.TOPB/TDPB are PLAB indexes (Brown: Pro Style / 4-2-5). Details: docs/playbooks.md.
- Engine v2 (`worker/src/supersim/coach/`): one snap per request, server-authoritative, RNG at call time; CPU
  play-caller from the AI usage tables; animation script from play art; result/envelope shape unchanged (supersim_games
  outbox, stub poller untouched). supersim_live (migration 0011) holds the game with a version guard; two-member games
  wait for both calls. Offline harness: `npx tsx tools/supersim-sim.mts 12` (≈24 pts, 55% completions, 4.5 yds/carry).
- Old v1 client (app.js/presentation.js/stadium.js/palette.js/forecast-worker.js, engine.js) removed; access.js kept.

## 2026-10-30 — first Supersim result on the console: TIDL fix

- Run 1 (capture-2026-10-30T15-53-21-939Z): the poller accepted run 314235b2 (week 6, Brown 24 at Duquesne 21) and the
  console fetched it (RetrieveGameResults week 6: 1 result) at load, but the game still showed as unplayed.
- Cause: RetrieveGameResults' GRLI and TIDL are parallel lists. The response handler 0x2fa48c walks both; for GRLI[i] it
  calls 0x3301c8, which (if the week matches) runs `update 'PWMT' set OGID, GHTG, THOA, GASC, GHSC, GSTA, GFOT, DSGE=1,
  CRCC=CRCT, ODSC=STCT where TGID = TIDL[i]` (query @0x173c5b4; TMWP = per-member-team weekly row; GSTA here is 2 when
  home score <= away score, 3 when home wins, 0x3ff when either score is 0). The stub sent TIDL = the game's two team ids,
  so the away team's result went to the home team's row (Duquesne, no row). Console-played home games worked by luck.
  dod.mjs now sends one GRLI/TIDL pair per member team in each game.
- CRCT is only stored (TMWP.CRCC) and compared between the two rows of a head-to-head game (0x330858 -> 0x33012c, sets
  XCSD on mismatch); single-human games do not check it. Brute force over the four console samples (crc32 variants,
  FNV, adler over field permutations) found no formula, so it likely covers the uploaded stat tables. Supersim sends 0.
- Run 2 (capture-2026-10-30T16-01-04-433Z): with the TIDL fix the hub showed 24-21, but the advance simulated the game
  anyway (Brown lost 31-41) and the uploaded file kept our numbers only in TMWP. RetrieveGameResults/TMWP is display only.

## 2026-10-30 — game data for web-played games (how the advance keeps a result)

- DynastyStatus.GAME is list<DynastyFileInfo {DFID, TMID}>, not GameResultsData: 0x2f6bc8 copies it with 0x2f6b18 (the
  TEAM copier) into status+0x6c (count +0xcc); 0x313264 looks a team up there. On event 0x19 the load (0x335200..) stores
  TEAM -> 0x174 ("Checking for team data") and GAME -> 0x178 ("Checking for game data", 0x334d78); the advance loop
  0x33b2a8 walks every GAME pair ("Downloading Game Data for <team>"). Both are gated by 0x471008(team) == 1 (the team's
  game is still to be played).
- The game data is not a locker file: dbmgr ([[0x1c7fb68]+0x1fc], vtable 0x18a0160, slot 0x14 = 0x2effb0 = the
  GetTableUpdate job) fetches 14 table descriptors (0x3138c4..0x31401c: CASG, CACG, CSGM, SCOS, UWQS->WQSC, PGNG, TSGA,
  GINF, PGKI, PGKP, PGDE, PGOL, PGOF, IGAM; the console's own post-game UPDT-2 upload set) with GetTableUpdate {TABL,
  FILT {COLM 0x47483458 'GH4X' (0x2ed194 picks it for game tables), VALU = GAME.DFID}, UPDA}. Rows go into ODGM.
- 0x43fd8c(ODGM) merges per table: "use DYND delete from T" then "use ODGM insert into DYND.T * select * from T" (DYNI
  skipped, WQSC appended without the delete). 0x46cd14 -> 0x46c9e0 then needs GINF.GQTR == 6, reads GINF {SGNM, GHTG,
  GATG, GHSC, GASC, GFSI, GFOT} and SEAI {SEYR, SEWN, SEWT}, sets GSTA (3 home win, 2 away win, 4 tie unless GFSI 2/3),
  GUTE (a CFUC coach on either team) and runs "update SCHD set SEYR, GHSC, GASC, GSTA, GFOT, GUTE where SEWN and SGNM"
  (@0x176c0d4); 0x46c550 then credits the stats and clears SPGA/DCGA/PLGA. A game final in SCHD is not simulated.
- Stub: supersim.mjs builds the 14 tables from the Supersim envelope (v3 `detail`: per-player PStat + snaps + starter,
  team totals, quarters) on accept (gamedata.mjs, private/game-data/<did>/<id>.json, ids from 900001), lists
  {DFID id, TMID team} in DynastyStatus.GAME for that week, and answers the GH4X GetTableUpdate with the console's own
  upload column layouts (FLTY 2, GHID id, RTID team). SCOS, IGAM, PGOL and the coach tables go out empty. Offline e2e
  (CPU game in Brown's week-7 slot -> accept -> status + table replies decoded) passes; first console run pending.
- Pre-test backup: %LOCALAPPDATA%\ncaa-bridge\backups\2026-10-30-pre-gamedata (BLUS31159-OD-EFOXOD1 + private store).
- Known gap: rows the console uploads with UPDT 2 are stored without their GHID, so the stub cannot yet serve another
  member's console-played game the same way (multi-member leagues).
- CONFIRMED 2026-10-30 (capture-2026-10-30T16-38-29-519Z): Supersim week 7, Harvard 13 at Brown 9. At load the console
  fetched all 14 game tables (GetTableUpdate GH4X 900001: PGOF 14, PGDE 19, PGKP 2, PGKI 3, GINF 1, TSGA 2, PGNG 76,
  UWQS 5, rest 0), the advance did not re-sim the game, the uploaded dynasty (file 49) has SCHD wk7 GSTA 2 9-13 GUTE 1,
  Brown 5-2, and season PSOF moved by exactly the Supersim lines (PGID 2866 +12 att +114 yds, 5052 +15 att +148 yds);
  receipt synced. Still empty: SCOS (scoring summary), IGAM, PGOL, coach tables (CSGM/CACG/CASG).

## 2026-10-30 — full game data: detail stats, scoring summary, line stats, coach XP

- Column names: Xan's NCAA 14 Dynasty Config.xml labels the season tables; per-game PG* codes are the same with g for s
  (gcyc YAC, guyh yards after contact, gubt broken tackles, gu2y 20+ runs, gcdr drops, gasa sacked; gdht assisted /
  gdta solo tackles, glff/glfr forced/recovered fumbles, glsa safeties, glbl blocked kicks, gslR long INT return;
  gkab..gkae / gkmb..gkme FG att/made 17-29, 30-39, 40-49, 50+, gknk kickoffs, gktb KO touchbacks, gppt inside 20, gptb
  punt touchbacks, gpny net punting, gplN long punt, gpbl punts blocked, gkeb/gkfb XP/FG blocked; grkL/grpL long returns;
  gosa/gopa line sacks allowed/pancakes; TSGA tsrt/tsPt rush/pass TDs, tsoz/tsot/tsof red zone att/TD/FG (tsdr/tsdt/tsdf
  defense), tsga/tsta give/take-aways, tsDi def INTs, tsfr fumble rec, tssk def sacks, tsty ST yards, ts2a/ts2c 2-pt).
- SCOS (scoring summary), from the 4 uploaded games + CPU-simmed rows + the format strings at 0x173xxxx: SSOR order,
  GQTR, GTIM seconds left, TGID, SSTY 0 pass TD / 1 run / 2 fumble return / 3 fumble recovered in end zone / 4 INT return /
  5 FG / 6 KO return / 7 punt return, SSPY yards, SSPT 14 XP good / 11 XP missed / 15 2-pt good / 12 2-pt failed / 16 none,
  SSTI scorer, SSFI passer, SSPI kicker or 2-pt player, SSPF 2-pt passer, SSSC drive start (negative = own side), SSDE
  drive seconds, SSDP drive plays. Writer 0x4e3ebc (CPU sim) / 0x4e3b50 (played). No type for safeties (left out).
- Coach XP: kickoff copies CSKL -> CSGM and CACP -> CACG for the 6 coaches (0x176c164, 0x176c1ec); goals completed in the
  game add CASG {CCID, GOID, CTIE = tiers gained}; in-game XP = sum CAPX.CAXP x tiers (exact for all 4 games: 830, 725,
  430, 1130; only the head coach earns in-game). Level = floor(sqrt(CEXP / 160)) for every coach seen; level-ups add CSKU.
  Goals identified: 2458418 +1 tier per TD (25), 14160977 win (50), 6845616 wins (100), per game 9764714 10 first downs,
  2520713 4 third-down conversions, 7575895 100 rush yds, 3760712 350 total yds, 16616478 250 pass yds, 12287251 50%
  completions (counter = pct), 7344421 30 points (counter = points), 12973307 starter QB 4 pass TDs (200); season
  counters 3235631 rush yds, 6108278 total yds, 13954122 pass yds, 12531902 TDs, 15141/852174 starter QB pass TDs,
  11124162/15329580 starter QB pass yds. The model reproduces 780/830, 405/725, 380/430, 630/1130 with no wrong goal;
  the rest are streak/situational goals (2359213, 8076757, 7461051, 9361158, 8074054, 11740286, 15235101, 7199112, ...).
- Stub: tdb-read.mjs reads the dynasty file (locker/<fileId>.bin) for CSKL/CACP/CAPX/COCH; gamedata.mjs sends the head
  coach's CSGM row (CEXP + XP, level/CSKU), all 195 CACG rows with updated counters/tiers and CASG; SCOS from the engine's
  scoring rows; PGOL from line stats. Engine: two-point tries no longer count as touchdowns/yards in the box score.
