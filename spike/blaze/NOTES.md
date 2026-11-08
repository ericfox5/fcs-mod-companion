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

## 2026-10-31 — in-game Dynasty Wire: Sports World + XMS (Story Center), built, console test pending

- Why the story step failed locally: the Dynasty Wire, game recaps, photo/highlight uploads and site stories all go through
  EA Sports World (EASW REST, `EASW-Version: 2.0.5.0`) + XMS media. SportsWorld connect (0x10b9a6c) first checks
  IsLocaleEnabled (0x10b98ec): config `OSDK_EASW_ALLOWED_LOCALES` = up to four comma-separated 4-char patterns, `*` = any;
  default `----` matches nothing -> connect state 2 (failure) with no network traffic. blaze.mjs now sends `****`.
- Sign-in: `POST <OSDK_EASW_AUTH_URL>/authentication` + `PS3?version=v2&locale=en_US&skuid=<sku>`, body = NP ticket
  (fails if the ticket call returns <= 0). Reply headers parsed by 0x10c1ac8: `EASW-Token` (required, < 1 KB),
  `EASW-Session` (< 68), `EASW-Nucleus-Persona` (int64), `EASW-Userid` (< 24); each ends at CR. `/extension` renews.
  Game config `GET …/sku/<s>/configuration` -> `sku_config` (game_avatar.*, notification@default_poll_interval,
  buffer_accomplishments, media_configuration.config{supported_types.type, guid, max_slots, starting_slot}).
- XMS paths ($u persona, $s sku): upload `POST /personas/$u/sku/$s/media[?maxed_slots=overwrite_oldest|error]`, multipart
  boundary THIS_IS_THE_OSDK_V4_SPORTSWORLD_MIME_MULTIPART_BOUNDARY_TEXT, parts `xml` (`<create_media type slot>` with
  description/name/date/attributes `<attribute value key/>`/tags), `thumb` (thumbnail.jpg), one per binary; reply root
  `media_metadata`. Search `GET …/media_content;full?platform=ps3&include_count=true&<criteria>` -> `<media_list count>`
  of `<media type id>`; mine `/personas/$u/sku/$s/media;full[?type=]`; binary `/media/<id>/binary/<n>`; update
  `/media/<id>;full?http-type=PUT&replaceList=true`; delete `?http-type=DELETE`; `/downloadCount`; `/ns/gps/filter_blacklist`;
  `offensive_content`; `/ns/gps/petitions`. Media XML fields (ParseXml 0x10def00): @id @slot @sku @type, name, description,
  date, server_date (six numbers), download_count, ratings@count, owner, thumbnail@size (text = URL), attributes.attribute
  @key @value, tags.tag@name, binary@type @id @size @uri @name.
- Media factories (type / binary type / binary name): MEDIA_CONTAINER / CONTAINER / container (Story Center),
  SCREENSHOT (group PHOTOS) / PNG_SCREENSHOT screen_png, JPEG_SCREENSHOT screen_jpg; GR_SCREENSHOT (game recap photos),
  VIDEOS / FLV_VIDEO, AVI_VIDEO video_avi; GR_VIDEO; PHOTOFACE; NCAAFBSCHOOLMT (Team Builder schools).
- Story containers (0x30c600-0x310600, Story classes 0x37d000-0x381900; full layout in server/story.mjs): name = 3-hex
  fields (type 0a0 GameRecapStory / 0a1 WeeklyRecapStory / 0a2 UserStory, then team id) + title (UserStory: name+6);
  description = headline; attributes CONTAINER_GROUP = MOIN.MIMI (online dynasty id, "6" for efoxOD1), CONTAINER_GUID,
  CAPTION (81), MEDIA_ID_0..14 / MEDIA_TYPE_0..14 (attached photos/videos), SEARCH_KEY_1 = team id, SEARCH_KEY_2 =
  SEAI.SSYE (season index); binary `container` = `<?xml version='1.0'?><story_data><story_media type="T"><![CDATA[…]]>
  </story_media>…</story_data>`, T 0 = packed game tables (UnpackTables loads them; recaps are generated from them),
  T 1 = text blocks (index 0 = body, 5,120 bytes). The game's own reveal-test UserStory (0x3816c8) is the model:
  "0a2"+team+title, headline, caption, one type-1 body. The Wire searches by CONTAINER_GROUP (+ SEARCH_KEY_1/2 for
  team/season views), type MEDIA_CONTAINER. After upload the console calls StoryCenter `storyUploaded`
  {XMID media id, SUID guid, SNUM/WNUM from the search keys, STYP 0xa0-0xa2, SESS, TOKN} (component id from the wire;
  unknown components get an empty reply).
- Built: server/easw.mjs (EASW + XMS on tcp/17504, store private/xms/, raw request dumps), server/story.mjs (container
  build/parse), server/wire.mjs (site <-> console sync: site stories -> UserStory + SCREENSHOT photo 640 px JPEG;
  console photos -> site captures; console containers -> /api/bridge/console-stories), Worker migration 0012 + bridge
  routes /api/bridge/wire, /api/bridge/console-stories, News Wire "In-game Dynasty Wire" section. `--easw off` restores
  the old behaviour. Offline tests: XMS round trip 15/15, local end-to-end with wrangler dev 10/10.
- Photos: the stale Pic-* texture is most likely RPCS3 not writing render targets back to guest memory; turn on
  GPU > "Write Color Buffers" in config_BLUS31159.yml before testing photo uploads.
- Console test plan: restart the league server; sign in (expect `[easw] … POST …/authentication`); open the Dynasty Wire
  (expect a media_content search with the real criteria format, our site stories listed); take a photo in a replay and
  upload it to the Wire; play a user game and accept the recap story (expect MEDIA_CONTAINER upload + storyUploaded).
- Game recap (the post-game "Recap"): GameRecapStory (0x37fb60) writes its body as the prompt "Tell everyone your side of
  the story.  Write your game recap at dynasty.easports.com." (type-1 block) followed by type-0 packed tables of the game
  (PLAY/PGLA selections etc., GameRecapStory::tableBuffer 0xa400 bytes), name = 0a0 + team + more 3-hex fields. The
  website replaced that text with the coach's write-up. Rebuilt: the News Wire shows console recaps with a "Tell everyone
  your side of the story" form for the team's coach (or commissioner); wire.mjs rewrites only the type-1 block of the
  stored container (story.mjs replaceTextBlock, tables byte-identical) and acks POST /api/bridge/wire/recap/<id>/delivered.
  Local end-to-end with wrangler dev: 12/12.

## 2026-10-31 (evening) — first console test of the Dynasty Wire

- Worked on the console: EASW sign-in (`authenticationPS3?version=v2&locale=en_BR&skuid=NCA14PS3`), sku config, the
  site story on the in-game Wire (photo + text), a played game (Brown 49, Princeton 42) uploading six GR_SCREENSHOT
  photos and then its game recap container in one burst at the end of the game.
- Real Wire search: `media_content;full?platform=ps3&include_count=true&sku_guid=NCA14PS3&types=MEDIA_CONTAINER&
  bookmarked=false&attributes=CONTAINER_GROUP#6*SEARCH_KEY_2#0[*SEARCH_KEY_1#<n>]&order_by=serverDate&sort_asc=false&
  translate_attributes=false&page_size=5&page_num=1` (# and * URL-encoded). easw.mjs ignored `types`/`attributes`
  until now, so every search returned all media; it now applies both, plus page_num (from 1) and sort_asc. Seen
  SEARCH_KEY_1 values: 12 (the current week) and once 151 (not explained; no table value of Brown's matches).
- Game recap header decoded from the real upload `0a0 00c 02c 00b 028 00e 007 00e 00e 000 015 00e 007 000 000 028`:
  field 1 = week (SEAI.SEWN 12), 2 = game number (SCHD.SGNM 44), 3 = home TGID (11 Princeton), 4 = away TGID (40 Brown),
  the rest not decoded. SEARCH_KEY_1 = 12 = field 1, so SEARCH_KEY_1 is the week, not the team: story.mjs now builds
  site stories with the week in field 1 / SEARCH_KEY_1 (wire.mjs LAYOUT 2 republishes stories sent with the old layout
  once), and the recap's team on the site is the uploader's team (it was reading the week, 12 = Drake).
- The recap leaves MEDIA_ID_0..14 empty. Its photos are the GR_SCREENSHOTs uploaded just before it; they carry
  HomeTeamName/ID, AwayTeamName/ID, StadiumName, Current/FinalScore*, Quarter, TimeLeftSeconds, Down, YardsGained,
  DistanceTo1st, description = play text. wire.mjs gives the site recap the first non-blank one of the same game.
- Photos come out white (console JPEG and the in-game recap alike). Not a server problem: the console's own JPEG has
  Y 252-255, flat chroma. The local copy `USRDIR/Pic-<session>_NN` is the same frame: MC02 header 0xB0, then 640x360 x
  4-byte pixels (A8R8G8B8 order assumed). This replaces the DXT1 reading of 2026-10-29, which was stale memory read
  without Write Color Buffers. With WCB on, the frame is there (contrast stretch shows the replay: Brown #5 hurdling a
  tackler), but each channel takes only two values (0xfe/0xff, 0xfd/0xfe) and alpha is a constant 0xfe: the photo
  pass output is about 99.5% white with 0.5% of the frame, i.e. a GPU state difference in RPCS3's handling of the
  capture pass (`tecNoAlpha_PointSampledPhotoSwizzle`, set up next to `TextureCopyFMV` at 0x37f64; render flags
  `doSnapPhoto` / `doSnapPhotoLatch`). Settings to try, one at a time, each checked with a single replay photo
  (decode the newest Pic file): MSAA Disabled + Resolution Scale 100; Strict Rendering Mode; renderer OpenGL;
  Force CPU Blit with Multithreaded RSX off.
- Blank-frame guard: bridge/scripts/to-jpeg.ps1 prints a brightness spread (luma max-min over a 32x18 average;
  `-Check` measures only). The console photos measure 1, real screenshots 100+; wire.mjs keeps photos at <= 6 off the
  site and out of recaps. RPCS3's own F12 screenshots (`ncaa-bridge captures`, captioned from the highlight XML) remain
  the fallback for story photos.
- Calls answered with `<void/>` that did no harm: `personas/1/sku/NCA14PS3;full`, `ns/ondemand/{media_access,
  providers,labels,channels}`, `POST personas/1/sku/NCA14PS3/online_stats`, `comments;full?topic_name=<CONTAINER_GUID>
  &lookup_id=30010` (story comments).
- Tests: XMS round trip 19/19 (adds the console's search format), local end-to-end 12/12, blank photo + recap photo 3/3,
  old-layout republish 2/2.

## 2026-10-31 (night) — console-played games re-simmed after a reload

- Report: Brown 24-31 NDSU (week 14, played on the console) came back from the advance as 10-21 with other stats. The
  dynasty files show more: file 61 (week 14 start) has the Princeton game (week 12, played 49-42) as 42-16, and weeks 1
  and 4 also differ from what was uploaded; weeks 2 and 5 kept their scores. Winners did not change in weeks 12 and 14.
- Cause: a console-played result survived only when the console advanced in the same session. Every re-simmed week had a
  reconnect between UploadGameResults and RequestAdvanceWeek (week 4: new login 17:28; week 12: RPCS3 restarted for GPU
  settings, login 20:20; week 14: league server restarted, login 21:13); weeks 2 and 5 advanced straight after the
  upload. A reloading console rebuilds the dynasty from DFID + its team file, where the game is unplayed, and the advance
  then simulates it. RetrieveGameResults only fills TMWP (display). The stub listed game data in DynastyStatus.GAME for
  Supersim finals only; the console's own UPDT-2 upload was stored as loose rows without a game id.
- Fix (dod.mjs): the UPDT-2 session (14 tables with the column lists as sent, GHID, RTID) and its UploadGameResults are
  collected per dynasty and, on EndDynastyUpdate UPDT 2, saved as game data (private/game-data/<did>/<id>.json, source
  'console', ids shared with Supersim) and listed in d.gameData[week] for the uploader's team. The GH4X GetTableUpdate
  serves them with the stored columns. The load only fetches game data for a game that is still unplayed, so a console
  that advances without reloading does not apply it twice. Offline replay of the real NDSU upload through a scratch copy
  of the server: 24/24 (GAME for TMID 40 and 1023, all 14 tables returned row for row, WQSC answered with UWQS, Supersim
  data unchanged, a repeated upload replaces the entry, UPDT 1 registers nothing). Console check pending: play a game,
  restart the game, advance; the game must stay final with the played score.
- Not repaired: weeks 1, 4, 12 and 14 keep their simulated scores (a rollback would need the console's local save too).
- Photos with MSAA disabled, Resolution Scale 100, Strict Rendering Mode on and Multithreaded RSX off (Vulkan, Write Color
  Buffers on): every Pic file of the NDSU game is one flat colour (all 230400 pixels identical, a different colour per
  photo: bf141b1e, ffa88779, ff79574e), so the photo pass reads a single point of the frame. With Resolution Scale 200 /
  MSAA Auto it was the frame at ~0.5% over white. Still emulator-side; the site keeps such photos out (range 0) since the
  blank guard.

## 2026-11-01 — photo tests, continued

- OpenGL: the game's textures render broken; back to Vulkan.
- Vulkan + Force CPU Blit (rest as in the NDSU test): the Holy Cross photo (`Pic-y s00-efoxod1_11-01 10'15'07_00`) is
  again one flat colour (ffcdd7db, all pixels), and the field textures look wrong in play. CPU blit switched back off.
  This file's pixels start at 0xCC, not 0xB0 (file 921,804 B = 0xCC + 921,600); the first 7 "pixels" at 0xB0 are header.
- RPCS3.log at the moment of the photo (10:17:52, log 0:26:15.267): `{PPU (FGGameSim) [0x0011bbc4]} RSX: Cache miss at
  address 0x30B80800`, and 6 ms later the game writes the Pic file. So the game's read of the photo surface (main
  memory, RSX-mapped) does reach RPCS3, which flushes the GPU copy: the readback works, and the flat colour is what
  RPCS3 rendered into that surface. The fault is in the capture pass itself (`tecNoAlpha_PointSampledPhotoSwizzle`).
- The log also repeats "MSAA is disabled globally but a shader with multi-sampling enabled was submitted for
  compilation": the game draws with MSAA, so MSAA Disabled changes how the frame the capture pass samples is laid out.
- Next test: Strict Rendering Mode off (config set 10:25 at the user's request); then MSAA Auto with Resolution Scale 100.
- Strict Rendering Mode off (MSAA Disabled, Res 100, WCB on, CPU blit off), photo `..._11-01 10'27'05_00`: back to
  the near-white kind. Every channel is 254/255 (alpha 254), and a contrast stretch shows the real replay frame
  (ball carrier by the goal post) at 1 bit per channel: out = 254/255 white + 1/255 frame, the look of a white
  overlay at ~99.6% drawn over the frame. Strict on gives the flat colour, strict off the white; MSAA makes no
  difference to the photo. In play, refs/fans/sideline objects glitched with MSAA Disabled, so MSAA is back to Auto
  and Resolution Scale back to 200 (the settings before the photo tests).
- The user confirms the screen flashes white when a replay photo is taken; the 254/255 photos match that flash at
  full strength over the frame. EBOOT strings: `doSnapPhoto` (0x1795e48) and `doSnapPhotoLatch` (0x1795f48) sit in
  the render-flag name list (enableBloom, enableFXAA, doVideoOverlay, ...); `CameraFlash` (0x17966c0) sits in the
  particle-effect list (PclEffectBreath/Snow/Rain), so it is most likely the crowd's flashbulbs, not the photo flash.
  Photo code names: PhotoManager, PhotoManager::TranscodeBuf, PhotoBuffer, static.photoSource, misc.photoSnapPending,
  SetPhotoPopupActive, PhotoReadyToSave. Where the photo flash is drawn is not found yet.
- Replay photo code path (EBOOT, 2026-11-01). Apt UI native `ReplayAdapterClass.TakeSnapshot` (0x8c6fa4) ->
  adapter object [0x1c794ec] (ctor 0x2cad38, vtable 0x189e6e8) slot 0x1c (0x2cafb4) -> ReplayMgr::TakeSnapshot
  0x228324: clears [[0x1caef20]+0x48]+0xa8 and calls PhotoManager::Request(this, 10) (0x128a90: countdown
  +0x2a4 = 10, busy +4 = 0). PhotoManager::Update 0x129528 (per game frame): countdown-- ; at 0 sets +4 = 1; next
  frame 0x129258 sets data key `misc.photoSnapPending` = 1 and clears +4 (IsSnapshotFinished 0x2283d4 = +4 == 0,
  so it also reads "finished" during the countdown). The renderer side is data-driven (no code reference to
  doSnapPhoto / static.photoSource besides PhotoManager). SavePhoto 0x11bf44 looks up `static.photoSource`, locks it
  and calls the writer 0x11bb5c: file = 0x1c-byte block {"MC02", ...} + 0xb0 header + pixels (so pixels at 0xCC),
  with three checksums (hash 0xf52ca0) that the reader 0x11d904 verifies. The `Photo` / `backbuffer` / `pip` Apt
  images are drawn by the class at 0x37e74/0x38140 (ADAPTFIXEDTEXTURED, tecNoAlpha_PointSampledPhotoSwizzle,
  DiffuseColor 1.0): that is the photo preview, not the capture.
- RPCS3 runs the game at 30 flips/s (sys_rsx_context_attribute 0x101), as on a PS3, so the 10-frame countdown is the
  same 333 ms. The old `Pic-c s01-rtgdb_06-05` photo (2024-06-05) is the stale-memory kind: photos never worked here.
- Test patch: patches/imported_patch.yml "Photo capture delay (test)" (PPU-62e25ebc...): li r4,10 -> li r4,60 at
  0x228348, i.e. capture 2 s after L3. Clean photo = the capture was landing inside the flash.
- Delay test (patch on, MSAA Auto, Res 200, Strict off, WCB on; photo `..._11-01 10'56'42_00`, readback at log
  1:06:53.026 again from 0x30B80800): one flat colour ff1f2427. Delaying the capture 2 s did not bring the frame
  back, so the flash is not the whole story. All seven photos fit one reading: the capture draws the frame almost
  fully transparent (alpha ~0..1/255) over whatever the photo buffer already held: white once (254/255 + frame/255,
  alpha 0xfe = a^2 + 255(1-a)), otherwise a leftover flat colour whose alpha is kept (0xbf in one). On a PS3 the
  frame would be opaque, e.g. an X8R8G8B8 "O8" back buffer reads alpha 0xff from memory while RPCS3's host surface
  keeps whatever the shaders wrote. Unconfirmed; the capture pass itself (render state) is in the data files.
- The user sees the white flash right at L3 even with the 2 s delay, so the flash is its own effect.
- The capture is data-driven: qkl_boot.ast entry #714 = `InGame.pus` ("NCAA PS3 post effects", plain text, zlib).
  `var texture PhotoBufferRam 640 360 1 format ram`; in the main proc after the scene and before the UI bins:
  `if misc photoSnapPending: settarget 0 PhotoBufferRam; transferimage FrameBufferRAM FrameBuffer local2local;
  settexture static texture0 FrameBufferRAM; setshader TransferShader tecNoAlpha; renderquad; settexture static
  texture0 VideoWaterMarkRam; setshader DecalOverlayShader; renderquad; settexture static photoSource
  PhotoBufferRam; setbool misc photoSnapPending false`. VideoWaterMarkRam = `Watermark_512x256_scaled` (also drawn
  on the video-encode path). Suspect: the watermark pass covers the whole photo under RPCS3 (its alpha), which fits
  the faint frame under 254/255 white and the flat colours.
- BGFA TOC correction: the third u32 of a record is usize - csize (entry 714: csize 9532, field 44943, inflates to
  54475); docs/playbooks.md calls it the size.
- tools/photo-watermark-patch.mjs check|apply|restore: blanks the three watermark lines of the photo block (and the
  banner comments, so the stream fits the old slot), rewrites entry #714 in place, updates csize/field. Verified on
  a copy: only entry 714 changes (9532 -> 9495 B), file size unchanged. Backup of the original archive:
  %LOCALAPPDATA%/ncaa-bridge/backups/qkl_boot.ast.orig (sha256 7adf3714...).
- Applied to the live qkl_boot.ast on 2026-11-01 11:12 (game stopped; delay patch unticked). hdcache/ is empty (the game never wrote hdcache.ast), so the disc archive is what loads.
- CONFIRMED 11:17: with the watermark pass removed, the replay photo `..._11-01 11'16'26_00` is a clean frame (Holy
  Cross kickoff, 47,958 colours, A8R8G8B8 order correct). So the photo pipeline works under RPCS3 (Vulkan, Write
  Color Buffers on, which the readback needs) and only the DecalOverlayShader watermark pass broke it. Not done: the
  video-encode block (highlight uploads) draws the same watermark over VEncode; untested whether highlights suffer.
  Re-apply the tool if qkl_boot.ast is ever replaced (FCS mod update, reinstall); each league member's copy needs it.
- Video highlights: the `if presentation doVideoEncoding` block renders each encoded frame into VEncode (512x288,
  aliasing PhotoBufferRam's memory) with BlurColor, then DecalOverlayShader draws for VideoOverLayRam
  (`Pontiac_512x256_scaled_COL`, only when doVideoOverlay) and the watermark. The tool now removes every
  DecalOverlayShader draw (with the doVideoOverlay if/endif) from both blocks: 11 lines, 9478 B stream in the 9532 B
  slot, unused rest of the slot zeroed, so applying to the original or to the photo-only patch gives the same file.
  Applied to the live archive 11:29 by the user (game stopped at 11:29); live file = the tested copy. Highlights
  not yet checked in game.
- 11:50 checks: the highlight `y s00-efoxod1_11-01 11'48'19_01.mjp` (AVI MJPEG, 512x288, 126 frames) shows clean
  game frames, and the photo `..._11'48'19_00` is clean: both overlay removals work.
- Graphics glitches (refs, fans, sideline objects) after the photo tests: against the original game config
  (`config_BLUS31159.yml.bak-offline`, 2026-10-29) the only non-network differences left were Write Color Buffers
  on (needed: the photo readback), Minimum Scalable Dimension 16 (orig 512) and Output Scaling FSR (orig Bilinear).
  With Resolution Scale 200, 16 makes RPCS3 upscale the game's small off-screen targets too, which its own help text
  ties to broken graphics with Write Color Buffers on. Both restored at 11:52; now only WCB differs. If glitches
  remain: try Resolution Scale 100 with WCB on, then WCB off briefly to confirm (photos break while it is off).
- Glitches persist with Minimum Scalable Dimension 512 + Bilinear restored (boot 11:53, settings confirmed in the log).
  Write Color Buffers is the only non-network difference from the original config, and it went on Oct 31 evening for
  the first photo test (the user's "before I changed settings"). Next test 11:58: Resolution Scale 100 with WCB on
  (RPCS3 has to rescale render targets on every write-back when upscaling); if it still glitches, WCB off to confirm.
- Write Color Buffers is the glitch cause: with it off (12:0x boot, config = original except Net) the user reports the
  ref/fan/sideline/field breakage mostly gone. The screenshot with it on showed stretched geometry (spikes/wedges) on
  the referee and stands while players drew fine.
- With WCB off, both capture paths read stale memory: photos `..._12'09'35_00/_03` are the old DXT-like garbage, and the
  saved highlights `..._12'09'35_01/_02.mjp` (MJPEG 512x288) are noise: highlight recording also goes through
  VEncode (= PhotoBufferRam's RAM) and a CPU-side encode. The two garbage photos were uploaded (XMS 1021/1022) and the
  wire mirrored them to the site (they pass the flat-frame guard); the console also uploaded GR_VIDEO 1023 (FLV, 140 KB).
- First real test of the console-game fix: `console game week 17 40@18 25-27 (GQTR 6) kept as game data 900005 for
  team 40` at 12:27:04, then the team push (CID 69) as usual.
- Crash 12:27:14 (log 2:35:37), right after the first ever highlight upload finished: MoviePlayer2 Decode Thread exits
  after playing `/dev_hdd1/video/..._12'09'35_02.mjp`, FGGameRender frees 0x18af0000 (sys_memory_free from 0x0043b2b0)
  and 6 ms later writes 0x19aef9e4 inside that block from 0x009e6c48: `VM: Access violation writing location 0x19aef9e4
  (unmapped memory)`, emulation frozen on the "UPLOAD COMPLETED" dialog. Cause not analysed yet (use-after-free in the
  game's render thread at movie teardown; unknown whether our video-block edit or WCB off play a part).
- 12:32 the user applied `photo-watermark-patch.mjs apply --vram-copy` after stopping the frozen game (stop 12:32:22); live archive = the tested copy. RPCS3 config: WCB off (original config except Net). Next: one replay photo.

## 2026-11-01 (afternoon) — re-sim fix confirmed; coaching carousel crash

- Re-sim fix, real case: after the 12:27 crash the console reloaded (12:36) and fetched all 14 GH4X tables of game data
  900005 ("(console game)"), then advanced twice (FID 71 at 12:37, FID 73 at 12:44). locker/73.bin has week 17
  `40@18 25-27 GSTA 3`: the played Holy Cross result survived the reload and the advance.
- Season end -> Coaching Carousel -> "PROCESSING / Checking for contract data:" crash (12:46:32): MakeContractPick(91)
  {CHID 39, CTID 18, DID 6} (our reply {RSIM 0, SYTY 0, TLID 0}), then GetDynastyStatus {TMID 1023, STAT 12, WEEK 31};
  the stub answered CFID 69 (own team file, as for every non-advance status), the console downloaded CID 69 and froze:
  `FGGameSim 0x00a6a8fc: Access violation reading location 0x11`, the run-32 crash (CFID opened as the ODCN package;
  the binary calls that buffer contractUncompressedOutBuffer). STAT 12 + TMID 1023 appears nowhere else in the captures
  (TMID 1023 with STAT 2/5/7 is routine after loads and from the hub and must keep CFID). Fix: dod.mjs answers CFID 0 for
  TMID 1023 + STAT 12 (the contract check), like d.advancing. Offline replay (scratchpad contract-test.mjs): 10/10, other
  status requests keep CFID 69. Unknown: what the console does next with no contract package (proceed, wait, or loop).
- League server control (server/league.mjs + start-/stop-/restart-league.cmd, league-status.cmd; start-spike.cmd and
  stop-spike.cmd now forward to them, start-spike.ps1 removed). One "NCAA League Server" window (opened with cmd's
  `start` from a detached helper: a detached node has no console, so its services each popped an empty window) runs the
  four services windowless (windowsHide) with their output tagged; a service that exits restarts with backoff; code
  changes restart the services whose import graph contains the file (bridge/src for the sync), Blaze/redirector only
  while no ESTABLISHED connection is on 33152. stop kills the supervisor tree by PID and closes the old -NoExit windows.
  Checked live: one window; dod.mjs touch -> blaze only; killed qos -> back in ~2 s; a held 33152 connection deferred
  the reload until it closed; captures.ts edit -> sync restart; stop closes the window. State: private/league.json.
- bridge captures: "screenshot folder not found" now prints once (it repeated every 30 s for each dynasty).
- With CFID 0 the carousel loads (13:23-13:24: GetDynastyStatus TMID 1023 STAT 12 -> CFID 0, GetTableUpdate CONT and
  CFCH unfiltered). The user is offered North Alabama and declines -> MakeContractPick {CHID 39, CTID 547} three times,
  the same offer each time. CONT (dynasty file 73, 660 rows: CCID TGID CNID SIND CCIE ROCI CCYR COPS VALU CIEX):
  CNID 18 = coach 39 at TGID 40, SIND 1 (the signed Brown contract; the 12:46 pick was "stay", not Holy Cross),
  CNID 547 = coach 39 at TGID 8, SIND 0, 5 years (the offer).
- Client side (EBOOT): MakeContractPick job 0x2f8954, callback 0x2f8abc: error -> 7, else response byte +8 (RSIM)
  ? 21 : 0. "Update Contract Pick" task (UdCP): start 0x33e090 (coach, contract, accept flag +0x29; the accept and
  decline wrappers 0x3425bc / 0x3425e4 differ only in that flag, and the request carries CHID/CTID/DID only, so the
  server cannot tell them apart; +0x29 feeds telemetry "acpt"). onEvent 0x33e358, event 0x27: result 21 -> simd=1 and
  step PfCP 0x33e2d8 (0x313180 with TMID 1023 -> the status/contract-package download, uncompressedContractBuffer at
  0x33e544 merging into ODCN like the advance's step 1); event 0x29: if the team changed -> 0x331a34 (team change),
  then a follow-up job or DynastyNotificationRequest (0x33e1b4), then finish. Result 0 (our reply) -> finish(success)
  at once with nothing changed locally -> the same offer again (the loop). So the real service resolved each pick
  (RSIM) and delivered the outcome as a contract package; we have neither the resolution nor the package format.
- Carousel, approach taken: the accept/decline entry is vtable method 0x27ee18 (vtable 0x189b6c0.., the dynasty action
  interface that also holds the recruiting-points and throttle methods): args coach, contract, ?, accept, forceLocal.
  Online (0x33f9ec) and not forceLocal and 0x47be6c -> the wrappers 0x3425bc/0x3425e4 (server); otherwise the game's
  offline carousel: 0x1eece0() then accept 0x1f0af4(mgr, coach, contract, x) or decline 0x1f0c18(mgr, coach, contract).
  Patch "Online coaching carousel: decide on the console": 0x27ee7c beq 0x27eecc (0x41820050) -> b 0x27eecc
  (0x48000050), so decisions resolve locally and reach the server with the next advance upload. Safe against the
  advance's table pull: GetTableUpdate only returns private/web-edits rows (none). Copy in spike/blaze/rpcs3-patches.yml;
  installed as <rpcs3>/patches/imported_patch.yml (replaced the old photo-delay test entry). Multi-human caveat: two
  consoles could take the same job. Untested in game.
- The local-decision patch made decline work but stalled on "ON THE CLOCK — Matt Mumme" (the next offer, CNID 627,
  coach 236 at TGID 42, a CPU coach): the offline path never runs the CPU decisions, and online the UI waits for them
  (polling the contract check). The real protocol, from the EBOOT:
  * on-clock contract = `select CNID, VALU from CONT where SIND = 0 and CIEX = 0 and CCIE = 0 order by VALU desc, CNID asc`
    (0x4d02e4); per-contract logic 0x4d446c/0x4d3ed8 reads COCH.CFUC for each candidate; batch loop 0x4d4608
    ("Updating Coach Contracts - %d remaining") runs CPU decisions until a human is on the clock.
  * MakeContractPick result 21 (RSIM) -> PfCP -> server-data/contract download -> UdCP.Srvr callback 0x33ec64 ->
    "Simulating contracts" 0x33e750, which reads the task's accept flag +0x29: decline -> 0x4d04e0 then 0x4d4608;
    accept -> 0x4d3778 (sign) then 0x4d4608; then 0x33e544 packs uncompressedContractBuffer into mUploadBuffer and
    uploads "<16 chars>.contract" as task "Contract Data" (task names "Download Contract" / "Upload Contract Data").
  So the server only coordinates: RSIM 1 to the picking console, and every contract check (TMID 1023, STAT 12) gets the
  newest .contract as CFID; the game itself handles accept/decline, CPU coaches and other humans' turns.
- Implemented: dod.mjs case 91 answers RSIM 1 (picks logged in d.contractPicks); case 58's contract check serves
  locker.mjs latestContent({group: DID, suffix '.contract', since: d.fileSavedAt, owners: members}) (confirmed files
  only; a file without an owner group counts if a member made it). Offline test scratchpad carousel-test.mjs 14/14
  (second human member, unconfirmed and stranger files ignored, other status requests keep the team file, advance -> 0,
  packages before the last advance ignored). The local-decision patch was removed (patches/imported_patch.yml now holds
  no patches; spike/blaze/rpcs3-patches.yml deleted). The console's local save is from 12:45 (before the carousel), so a
  restart brings the North Alabama offer back. Untested in game.
- Carousel coordination confirmed in game: the user's decline of North Alabama ran "Simulating contracts" and the carousel
  continued. 49 .contract packages came in (CID 75..123; each superseded one deleted by the console), all EMPTY DBs
  (0 tables): with one human there is nothing for other consoles to merge. The user stayed at Brown and advanced (file 124).

## 2026-11-01 (afternoon) — how the console merges web-edit tables; transfer portal

- GetTableUpdate reply path: callback 0x2f1d88 -> DodBlazeDataMgr::UnpackTableData 0x2f17fc. Empty ROWS -> returns 6
  (no-op; why a reply without edits never touched anything). Otherwise each Z table's descriptor object decides:
  vtable +0x10 = filter type, +0x14 = merge mode. Mode 0: `delete from <t> where <col> = <v>` (type 6: a PLAY-join
  condition for tables without TGID; type 0xa: via COCH CCIDs) then plain bulk insert (0xa56f94); modes 1/3: `use <db>
  delete from <t>` then insert; mode 2: no delete, keyed merge (0xa58bdc/0xa6a44c) on the key from 0x2ed404 (type 4 ->
  PRSI, 5/6 -> PGID, 2 + TRAN/TRAZ -> PGID).
  Descriptors (ctor sites 0x311df0.. 0x3124fc): TRAZ (TransfersChangesTableData) type 2 mode 2; TEMZ 2/2; REBZ 2/0;
  PLSZ 6/0; PLYZ 5/2. So PLYZ and TRAZ merge by PGID (any player of any team, nothing deleted); REBZ/PLSZ replace the
  console's own subset (the board removals of 10-29). Pulls: PLYZ TGID UPDA 1, TRAZ PTID UPDA 1, PLSZ TGID UPDA 0.
- Offseason transfer data (file 124, "Players Leaving"): PLAY.PLFL reason (9 leaving, 10/11 playing time, 14 coach
  leaving, 15 home sick, 16/17 staying, 19-25 draft, 26 graduation, 28 stays), PLAY.PTYP (0 stay, 1 transfer, 3 out;
  PTYP 1 also marks an earlier transfer-in: PGID 7217 has PTYP 1, PLFL 28, no TRAN row); TRAN {PTID dest, PGID, TRYR 0,
  TRAC 1} x70; PLSS {WTLS 70..245, PGID, CSPL 0, CTSP 0} x70. The game's own transfer queries: update PLAY set PTYP,PLFL
  where PGID; delete/insert PLSS; insert TRAN; update TRAN set PTID where PGID; delete from TRAN where PGID.
- Transfer portal, server + bridge side: decoder exports players[].leaveFlag/leaveType and transfers[]; the bridge
  import sends 'transfers' (skipped with a note if the deployed Worker does not know it yet). syncWebEdits now builds
  PLYZ (player edits + transfer flags, edited players only, from the freshest of the console's PLYZ push and the
  dynasty file's PLAY), TRAZ (TRAN rows: new destination, or TRAC 0 to stay), PLSZ (full PLSS set per affected team,
  rows tagged TGID; a team's last row cannot be removed since an empty reply is a no-op). Transfer and player edits are
  acked once a newer dynasty file comes in (the store's week is a placeholder 31 in the offseason). dod.mjs serves
  PLYZ/TRAZ unfiltered (keyed), PLSZ per TGID. Offline: scratchpad transfer-test.mts 21/21. Untested in game: whether
  PTYP 0 + PLFL 28 + TRAC 0 keeps a player home, and whether a CPU player's transfer works without his PLSS row.

## 2026-11-01 (evening) — web-only (Supersim) members + Ready

- Console side, checked: the advance walks every DynastyStatus.GAME pair and the only gate is 0x471008(team) = `select
  GHTG, GATG, GHSC, GASC, GSTA from SCHD where SEWN in range and (GHTG = team or GATG = team)` (unplayed), with no CFUC
  or membership test. So a Supersim result for a team no console controls is applied the same way (game data -> final
  in SCHD -> not simulated).
- supersim.mjs acceptResult: an envelope with webMember: true is accepted when no console member controls
  ownedTeamId (the site vouches for the web member; the poll is bridge-token authenticated); console members as before.
- Site (worker migration 0014): a commissioner adds a web player on /members (name + a team nobody controls); it is an
  od_members row with web_only = 1 and a negative blaze_id (never reused), and an invite is created with it. The
  bridge's member sync now deletes only web_only = 0 rows. Supersim: a web member starts games like anyone (the run's
  envelope carries webMember: true); before a game exists it is refused when the opponent is a console member's team
  (played on the console) or a console member has taken the web member's own team. A game the console member already
  started in Supersim can still be joined from the other sideline. Recruiting is read-only for web members (the CPU
  recruits for that team in the console). Ready: member_ready keyed by (dynasty, blaze_id, dynasties.od_file_id), so
  each advance (a new dynasty file) clears every flag; POST /d/<slug>/ready. The home "Dynasty Members" box shows per
  member this week's game (W/L score + Console or Supersim, live Supersim score + quarter, not played, bye) and a
  Ready pill, "n/m ready" in the title, an "Everyone is ready" line, and the viewer's own I'm ready / Coach your game.
- Tested: worker end to end on wrangler dev (40 checks: add, invite, join, coach to the final, outbox webMember,
  ready/undo, console-opponent and team-clash refusals, recruiting read-only, member sync keeps the row, remove);
  acceptResult on a scratch server copy (webMember accepted; unflagged non-member and console-team envelopes refused).
- Untested in game: the advance applying a web member's game data for a CPU team (coach tables go to that team's CPU
  head coach, the same builder as for console members).

## 2026-11-02 — game-line history and player identity across seasons

- A dynasty file's B* tables (BOFF/BDEF/BKIC/BKPR/BOLN/BTES) hold every game of the season so far (week-6 file: weeks
  0-5) and are emptied in the offseason (week-22 file: 0 lines). The site used to replace the season's game_logs on
  each import, so the first offseason import wiped the season. Now game_logs are week-scoped (an import replaces only
  the weeks it carries) and `ncaa-bridge od backfill-logs --did N` refills weeks from the DYNASTY.dynasty each import
  stored in R2 (production: import #34 restored weeks 0-21, 53,431 lines).
- PGID is a roster slot (TGID * 70 + n; 8694 of 8832 players match). A transfer gets a new PGID on the new team (in
  Players Leaving week the leavers already appear as copies on team 300 with new PGIDs) and the slot is reused later.
  PLAY.POID ("Org. Player ID") stays with the player; POID alone repeats (a copy and the slot's next holder), POID plus
  hometown (RCHD) is unique per person. The bridge stamps uid = "POID:RCHD" on every game line and season-stat row from
  the same file (migration 0016); player pages read history by uid, so it follows a transfer and never passes to the
  slot's next holder (tested locally with a simulated Colgate transfer and a new occupant of the slot).
- Season stats: rows carry SEYR (season offset); the bridge sends only the current season's rows, and
  player_season_stats keeps rows a newer file no longer has (graduates and movers vanish from the file while the season
  label is still the same). To verify at the first rollover: the new season's stat rows carry SEYR = new offset (the
  bridge logs any rows left out because of SEYR).

## 2026-11-02 — new transfers through the dynasty file

- Robert Coleman (PGID 16382, Lamar) was made a transfer to UAPB (42) on the site. In game, Lamar's Players Leaving
  showed "Transfer - (Leaving)" with no destination: PLYZ applied (PTYP 1, PLFL 9), but TRAZ merges by PGID into
  existing TRAN rows only (type 2, mode 2, no insert), and he had no TRAN row. PLSZ only reaches the console's own team.
- DYNASTY.dynasty = zlib(4-byte prefix + EA DB). The prefix is FNV-1 32-bit (offset 0x811c9dc5, prime 0x01000193,
  multiply then xor), big-endian, over the DB's first 0x7e5000 bytes. It matches CID 18 and CID 124. The console checks
  it at 0x335814..0x335858 (a mismatch goes to the error path 0x1ea414, code 0x17), then opens the DB from buffer + 4.
- The console downloads the dynasty file at load only when DynastyStatus.DFID differs from the file it has. So the
  bridge writes pending transfers that need a new TRAN row into a copy of the console's upload:
  web-edits/<did>/DYNASTY.patch.bin + .json {base, key, size, changes}, via bridge/src/dynasty-patch.ts.
  - A transfer gets PLAY PTYP 1 / PLFL reason, a TRAN row (PTID, TRYR 0, TRAC 1) and a PLSS row (WTLS 150). In the
    game's own files TRAN and PLSS are parallel lists, one row each per portal player (70/70 in file 124).
  - A stay gets PLAY PTYP 0 / PLFL 28 and TRAC 0.
  - The file is checked by re-reading it: CRC chain, prefix, and the TRAN rows. Only PLSS, PLAY and TRAN differ from
    the base.
- Publishing: dod.mjs refreshPatch runs at getDynasty and at GetDynastyStatus for the console's team, never during an
  advance. If the patch was built from the console's current upload (d.consoleFileId), it registers the file as a new
  locker content (with the metadata of the file it replaces) and sets d.fileId (DFID) to it. EndDynastyUpdate UPDT 0
  sets fileId = consoleFileId and drops the patch. If the manifest is gone or stale, DFID goes back to the console's
  file. fileSavedAt is unchanged, so the site edits stay pending until the console's next upload. The bridge imports
  the site from consoleFileId, not from the patched copy.
- Tested offline on scratch copies: patch round trip; publish on load; no DFID change mid-session or during an advance;
  republish on the next load after a rebuild; the console's own upload taking over; withdrawal. In-game check
  pending: reload the dynasty, look for "Downloading Dynasty File", then Lamar's Players Leaving should show Coleman as
  "Transfer - UAPB". Backups: %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-01-transfer-patch (store, locker 124, OD save).

## 2026-11-02 — offseason crash at "Generating All-Americans" (FCS mod) and the RPCS3 patch

- First run through a whole offseason. The transfers made through the patched dynasty file all executed (CID 132):
  Coleman to Samford (143) as PGID 10011, Murphy to Harvard, Wagner to NDSU, Taylor to Princeton; the stays held.
- The advance from state 15 (to Custom Conferences, "Generating All-Americans") froze. RPCS3.log shows
  `VM: Access violation reading location 0xd01e3828` at 0x453848. Call stack: 0x453bf8 <- 0x454f8c (return-specialist
  pass, position 16) <- 0x457988 <- 0x4d6130 <- 0x4f8db4 <- 0x505f28.
- 0x453898 picks the preseason All-Conference and All-American players for one position:
  - Cursor: `fetch PGID`. For KR, the candidates come from PSKP (SEYR = season) ordered by PCAP.
  - Conference lookup: `select CGID from TEAM where TGID = PGID/70` (computed as (PGID+1)*0x7507>>21), defaulting to
    31 when no row is found. The result is used as the index into 15 slots of 0xCC bytes on the caller's stack (0..13
    = conferences, 14 = All-Americans) and into a 45-byte counter array.
  - Index 31 runs past the stack top. CGIDs 15..17 would write into the caller frames.
- Why CID 132 has such players: the offseason re-keys the 2,312 departing seniors and draft entrants (TGID 1023,
  PTYP 3) to free PGIDs in unused team slots (0..69 -> "team 0", 8120..8679 -> TGIDs 116..123, which the FCS mod's TEAM
  table does not have), and their season stat rows go with them. Stat rows also exist for PGIDs with no PLAY row.
  Nick Manley was the 70th player in the online team copies (teams 300/400 = copies of Brown); his copy got PGID 65535
  (already the case in the console's own file 124), and his stat rows were keyed to 65535 (PGID/70 = 936). In CID 124
  no stat row pointed at a missing team; in CID 132, 27..41 rows per stat table do. Whether the original game survives
  this depends on leftover stack bytes (the slot counters it reads for index 31).
- Fix: RPCS3 patch "FCS mod: preseason All-Conference crash fix" (PPU-62e25ebc..., copy in private/rpcs3-patches.yml,
  generator scratchpad allconf-patch.py).
  - After the CGID query: `lwz r18; cmplwi r18,13; bgt 0x453900`, so a candidate whose conference is not 0..13 is
    skipped (next row).
  - Room for it: the profiler-hook call at the top of the loop (0x453914) now loads its base with r16 alone, and the
    block 0x45393c..0x45399c moved up one slot (the two `bl 0xa691b0` re-aimed). `extsw r18` (a no-op for 0..13)
    became the moved `li r3,0`.
  - Nothing else branches into the window (whole-EBOOT scan).
  - Installed in <rpcs3>/patches/imported_patch.yml and enabled in config/patch_config.yml. Backups:
    %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-01-allconf-patch (both yml files + the OD save).
- CONFIRMED 2026-11-01 night: with the patch applied ("PAT: Applied patch ... FCS mod: preseason All-Conference crash
  fix"), the advance passed All-Americans and reached the preseason (CID 134: SEYR 1, SEWN 0, state 5); no access
  violation in the new RPCS3.log. First rollover: the PS* stat tables still hold only SEYR 0 rows, so the bridge sends
  no season-stat rows for year 1 and the site keeps last season's. Coleman is at Samford (PGID 10011, PYEA 1).

## 2026-11-02 — last season's results replayed into the new season (fixed)

- After the advance to year 2 week 1 (Brown at Furman again), the hub showed "W 49-14" without the game being played.
  d.games and d.gameData were keyed by week only. At 00:18:12 RetrieveGameResults week 1 returned last season's
  week-1 final (40@35 49-14, uploaded 2026-10-29), and the console wrote it into its hub row (TMWP).
  - Not in the dynasty: CID 139 (uploaded 00:18:04) has Brown's TMWP at GSTA 1, 0-0, and the console's local save
    (00:18:07) predates the reply.
  - The site showed it too: the bridge overlays d.games onto unplayed games with the same week and teams.
  - Last season's game data (weeks 7, 9, 10, 11, 17) would also have been listed in DynastyStatus.GAME for those
    weeks of this season.
- Fix:
  - dod.mjs rollSeason: d.games/d.gameData hold one season (d.gamesYear). When EndDynastyUpdate moves d.year, and once
    at load for stores from before, they move to d.seasons[<year>]. Game-data ids come from d.nextGameDataId, so
    nothing on disk is reused.
  - The bridge uses seasonGames(d) (empty while gamesYear != year) for the overlay, the pushed od_results and the
    fingerprint.
  - Tested on a scratch copy: load archives year 0 (12 weeks of results, 5 of game data); week-1 results -> 0; a new
    upload this season is served; the year-2 rollover archives year 1; a mid-season advance does not.

## 2026-11-02 — transfers sat down by the game; depth charts from the site; real Supersim clocks

- Eric Fox (Brown, PGID 2815) could not be put on the in-game depth chart in year 2: "transfer, must sit a year". File
  139 (SEYR 1 SEWN 1) shows why: PRSD 1 (redshirting) with PTYP 0 / PLFL 28, and his TRAN row from the portal still
  there (TRAC 0, PTID re-rolled 144 -> 66). The only other PRSD 1 player in the whole file is Anthony Bivines (PGID
  2800, POID 203, PLFL 14), a portal arrival at Brown. Every other TRAN player (69, all on CPU teams, 31 of them moved)
  has PRSD 0 or 2. So at the rollover the game redshirts the portal players who end up on a USER team, the one who
  stayed home included, and the depth chart screen then refuses them as transfers. CPU teams' transfers play at once.
- Rule (bridge syncEligibility, every web-edits pass while the store's week is <= 2): a player on a member's team with
  PRSD 1 and a TRAN row gets PRSD 0 through PLYZ (the console pulls it at load) and in the dynasty-file copy. Memo per
  season in the bridge state (pending -> done once a newer file shows PRSD 0), so a redshirt the coach puts back on
  afterwards stays. Not yet seen in game: whether PRSD 0 alone makes the screen accept him; the site's depth chart
  bypasses that screen anyway.
- Depth Chart page (/d/<slug>/depth, menu group "Team"): DCHT is 88 rows per team (slots per position in
  @ncaa/ncaa14 DEPTH_SLOTS: QB 3, HB 4, FB 3, WR 6, TE 3, OL 3 each, LE/RE 3, DT 5, LLB 3, MLB 4, RLB 3, CB 5, FS/SS 3,
  K/P 3, KR/PR 5, KO 3, LS 3), rows not contiguous per team, allocType 6, no index. A save is web_depth_edits
  (migration 0018, one row per team and week, chart_json + subs_json); the bridge writes the chart into
  DYNASTY.patch.bin (patchDynasty: DCHT slots set in place, 0 keeps the console's player) and acks it when a newer
  console file arrives. Supersim lines up from the pending chart immediately; pending player edits (redshirt, position,
  jersey) apply to Supersim too.
- Formation subs: PLSU {PGID 16b, TGID 10b, PFPI 4b, PLFO 10b, PFIO 1b}, max 600, 0 rows in every file so far. The
  site reads it as slot (PFPI 0..10), playbook set id (PLFO; set ids go to 960, formation ids to 14301 so it cannot
  be the formation), offense flag (PFIO). Unverified: the page says so; the decoder exports formationSubs
  (formation_subs table) so a sub set in the game will show the real encoding after the next upload. The bridge
  replaces the team's PLSU rows (TdbTable.removeRecord: last row into the gap, refused on indexed tables).
- patchDynasty(blob, {transfers, depth, eligible}) replaces patchTransfers (PATCH_FORMAT 3); scratch run on file 139:
  622 ms, only DCHT/PLSU/PLAY differ from the base, re-read checks for every written slot.
- Supersim clocks are real against the CPU: state.pc (25 after a stoppage, 40 after an ordinary play by the same
  offense), state.huddle {at, allow, cpuAt}. The browser counts the play clock down from the end of its playback
  (or from when the server's allowance ran out) and runs the game clock with it when it was left running; the snap
  sends elapsed and the server charges max(elapsed, its own reading) up to the play clock. A CPU offense snaps at
  cpuAt, rolled when the huddle starts (the count stops there). At zero on the coach's offense the browser sends
  'delay': engine expirePlayClock runs the game clock through the play clock, then the end of the period or a delay
  of game (5 yards, half the distance inside the 10, replay the down, 25-second clock). Human-vs-human games keep the
  tempo model. Every PlayDetail carries pre/post (the board at the snap and after); the browser shows pre until the
  animation is over (no more down/score/stats running ahead of the play, FGs included). Tested on wrangler dev with
  headless Chrome: hold during the play, count on defense stopping at :11/:14 (cpuAt), count on offense into a delay
  of game at 1st & 10 -> 1st & 15.
- Later the same day: the rings on the field markers used to go on the play's key players at the snap (a tell); now a
  player is ringed when the ball comes within 1.6 yards of him or he reaches the ball carrier, the rest when the play
  is over (coach.js light/unlight; a replay clears them). The chrome around the field (top bar, scoreboard, picker,
  ticker, controls, panel tables, popup card, subs panel, toast) follows the site's base.css look (black bar, white
  cards, red accent, Helvetica); the field, play art, diagrams, celebrations and coin are unchanged. A 'delay' is
  also accepted when the game clock ran out in the huddle before the play clock did.

## 2026-11-02 (evening) — Supersim punts, return touchdowns, the quarter turn; Fang's Recruit Overhaul

First full Supersim game on the new engine (Brown 37, Furman 36, week 1 of 2014, run ac5ba6a1). What the log showed:
- Play 142, "D. Jones punts 36 yards, returned 62 yards by M. Childs for a TOUCHDOWN", put 6 on FURMAN's side (the
  punting team), then Furman kicked the PAT and kicked off. runPlay's bookkeeping tested `if (o.td)` before the
  turnover branches, so any outcome with td + turnover (a punt return, a pick six) was scored as the offense's
  touchdown, type 1 (rush), carrier -1. Fixed: the offense branch is `o.td && !o.turnover`; int/fumble and
  punt/kick branches credit the defense (scoring "FUR punt return touchdown" / "defensive touchdown", ball at 100,
  PAT to the defense). The recorded 37-36 stands on the console (the game played on from the wrong kickoff; a
  re-sim would be a different game).
- "Furman extra point" at the final: the board under a held state is `{...hold, ...detail.post}`, and SnapState had
  no `final`, so the last still detail (FINAL) rendered with phase 'final' but final false -> the scoreboard's
  fallthrough line "FUR POINT AFTER" (patTeam was still Furman from their last PAT). SnapState now carries `final`;
  the client treats post.phase 'final' as final and takes winner/ot from the real state.
- The "2 seconds left" flicker at a quarter's end: the HUD ran the clock to 0:00 and sent 'delay'; while the request
  was out, render() showed the held pre-request state (clock 0:02) until the END OF Qn detail arrived. HUD.last keeps
  the reading the count ended on (snap or expiry) and the scoreboard shows it until the detail takes over.
- A quarter that turns over in the huddle (CPU runoff past the clock, Q1->Q2 / Q3->Q4) used to run the play with
  the old quarter's orientation and clock (flip, pq, clk0 from before the runoff; the client then ticked the clock
  from 12:00 to 0:00). runPlay now takes snapQ/atSnap after timeExpired: flip, pq, pre, the log entry and the scoring
  rows use the quarter at the snap; clk0 = snap when it rolled.
- Punts: fair catches, touchbacks and muffs were decided by dice before anything moved, and those branches animated
  nothing but the punter (so a "fair catch" with nobody near and gunners standing still). simulateReturn now plays
  every punt through the catch: the vices jam the gunners for 0.7-2 s at the snap, the interior protects until the
  kick then covers, gunners run flat out; at the catch the returner fair catches when the nearest free cover man
  will reach him within ~0.75 s (1.4 s when pinned inside the 10; PBCV nudges it; never with nobody inside 12 yd),
  lets a ball coming down in the end zone go (touchback), muffs 1.2% (loose ball, nearest man falls on it, the
  returner can recover and is down there), else returns. A punt call with no 'ret' assignment sends the deepest man
  back for a fair catch. 16 harness games: 63% returned (11.3 yd avg, 2 TDs in 256 punts), 26% fair caught, 9%
  touchbacks, 2 muffs. SimResult gained end 'faircatch' | 'touchback', muffed, nearAtCatch.
- Fang's Recruit Overhaul V6.0 BETA (Downloads/Givee Screenshots/Recruit_Overhaul_V6.0_BETA): a packaged Node exe
  (pkg, madden-file-tools inside) that rewrites RCPT (names by skin tone with Hawaiian names, faces PGHE, builds
  BS**, ratings, POVR/RCOV, stars RCCB, pitch importances IMP1-3: 63 fields) and RCPR (PS01-10, CMTS: 11 fields) of
  the save in its your-save-file/ folder (relative to the cwd; 44 s on file 139; row counts and PRSI order kept;
  checksum chain intact; output verified with @ncaa/tdb). Its base ratings are the RCAT table of game file 4664 in
  qkl_fe2ig.ast (3.5 GB, entry stored uncompressed, 7,966,280 bytes, offset 3,556,361,106); the mod's current entry
  differs from the tool's only in RCAT and the rivalry name tables RVNM/RVLY (24/35 rows in the mod, 127/382 in the
  tool's, so those are mod edits worth keeping). Integration (bridge/src/recruit-overhaul.ts, commands/od.ts
  maybeOverhaul, dynasty-patch.ts recruits): `od overhaul --set-exe <RecruitOverhaul.exe>` copies the tool to
  %LOCALAPPDATA%/ncaa-bridge/overhaul and records overhaulExe in config.json; `od overhaul --install-rcat
  <File04664.DB>` rewrites only the RCAT table inside entry 4664 (entry saved to backups/, `--restore-rcat`, refuses
  while rpcs3.exe runs); `od watch` runs the tool on the first file of a season year at week 0 (the class is
  generated at the preseason: file 134 was 2014 week 0), stores the output as overhaul/<host>-did<N>-<year>.db with
  a memo in od-state.json, and publishes it through DYNASTY.patch.bin (PATCH_FORMAT 4: the changed RCPT fields by
  PRSI onto the current console file, RCPR only while that file is the one the tool ran on; a console file whose
  names already match (>= 90%) ends it as `taken`; a season past week 1 without it is left alone as `stale`).
  Consoles take the class at their next dynasty load, so after advancing into the preseason the commissioner should
  leave the dynasty and re-enter it before preseason recruiting. Scratch run on a copy of file 139: patch applied in
  666 ms, re-read clean, second application a no-op. `--run --did N [--force]` runs it by hand. Not yet seen in game.
- "You currently can be the commissioner of only 1 dynasty": decided on the console, never by the server (no
  createDynasty reached the stub; the console reports its own limit with SetMaxOwnedDynasties MAXD 1). The script
  binding behind Create Online Dynasty (0x2673d4) calls the gate 0x3415d8: allowed iff (hub dynasties whose
  commissioner blaze id at dynasty+0x90 is mine, 0x341538) < GetMaxOwnedDynasties (0x34144c) and the hub list holds
  fewer than 8 dynasties (0x341418). The max is 1, or 5 when the PDLC check 0x52bfac(item 0xf, 0x18 or 0x17: Five
  Online Dynasties / Commissioner Bundle) passes, 3 for item 0xe (Three Online Dynasties); the error text is picked the
  same way. Those packs are PSN DLC (USRDIR/DLC/<id>/ea_packagemeta.xml.edat), not Blaze entitlements (the console's
  listEntitlements asks group NCAAFB14PS3Unlockable, whose only visible tag is NCAA_ADVANCEWEEK_UNLOCK). Fix: RPCS3
  patch "Online Dynasty: commissioner of up to 5 dynasties" = one word, 0x341460 li r31,1 -> li r31,5 (installed in
  patches/imported_patch.yml, enabled in config/patch_config.yml, copy in private/rpcs3-patches.yml; backups
  *.before-commish beside them). The 8-dynasty hub cap stays. CONFIRMED in game: a second online dynasty (DID 7
  "efoxcareer") was created; od watch imported it, ran the overhaul on its 2013 class (2,702 renamed) and the console
  took it at the next load (file 152 carried the names; memo `taken`).
- Start year. The game's calendar year is 2013 + SEAI.SEYR (EBOOT 0x4d9b48 adds 0x7dd before the day-of-week code at
  0x4d9864); SSYE is the year the dynasty began (hub "Year N" = SEYR - SSYE + 1). The NCAA 14 Dynasty Tool's Year
  Changer (Electron app, dist/electron/worker.worker.js "changeYear") sets SEAI SSYE = SEYR = year - 2013, SNPW = 8,
  SEOW = 23 on a freshly created dynasty at its first preseason (its rule: save right when the preseason is reached,
  never later; v2.1.2 fixed an offseason loop with the SNPW/SEOW values). Built into the bridge the same way:
  `od year --default 2025` (config startYear; od watch queues it on the first week-0, SEYR-0 file of a new dynasty)
  and `od year --did N --year Y` for one dynasty at that stage; applied through DYNASTY.patch.bin (dynasty-patch.ts
  applyStartYear, refused past the first preseason), memo `startYear` in od-state.json (taken / stale like the
  overhaul). dod.mjs records d.startYear (NWYR of the first advance into the regular season) so the hub card still
  says "Year 1". Scratch test on file 145: SEAI SSYE/SEYR 0 -> 12, re-read clean; on a week-1 file it is refused. The
  site needs nothing: season_year = 2013 + SEYR already. DID 7 was already at week 1 when this landed, so it stays
  2013; the next new dynasty gets 2025. Not yet seen in game. DID 8 "coach1" (created 18:20) got both queued on its
  first file (145 -> patch: overhaul + 2025); the watcher had missed the year because it read the config at start, so
  od watch now re-reads overhaulExe/startYear every pass (refreshConfig).
- Recruit editor + re-generate button (migration 0019). /d/<slug>/recruit/<prsi> is a prospect card (name, pos, stars,
  rank, size, scouted OVR, interest or commitment) with an editor (first/last name, position QB..P, height 5'0"-7'0",
  weight 160-400 lb, stars 1-5) for the commissioner (any prospect) or the coach of the team he committed to;
  prospect names on the board, the search and the Top 300 link there, with an EDIT tag while a site edit is pending.
  A save is web_recruit_edits (one per prospect and season); the bridge carries it as DynastyPatchSet.recruitEdits
  (RCPT by PRSI: PFNA/PLNA/PPOS/PHGT/PWGT = lb - 160/RCCB; field widths 88/104 bits, 5, 7, 8, 3) into the dynasty-file
  copy, applied after the overhaul so the edit wins, and acks it only when a console file newer than the edit carries
  every value (consoleRecruits caches RCPT per console file). Scratch test on file 163: 321 ms, re-read clean. The
  commissioner's "Recruiting class" box on /recruiting has "Re-generate with Fang's Recruit Overhaul", enabled at week
  0 only: a web_overhaul_requests row the bridge takes from GET web-edits (overhaul[]), runs maybeOverhaul(force) on
  the console's current file inside syncWebEdits (publish = false there, the caller publishes), and reports back with
  POST web-edits/<id>/overhaul {status, message}; the box shows RUNNING / DONE / FAILED with the message. Checked on
  wrangler dev with headless Chrome (edit saved -> PENDING note, API lists it; button disabled at week 2 with the note).
  Production needs `wrangler d1 migrations apply ncaa-online --remote` before the deploy.
  First live press (DID 8, 19:06): the tool ran (second roll, 2,700 renamed, patch rebuilt 19:07) but the site logged
  the request as FAILED with an empty message: the result POST is gzip JSON like every bridge body and the route read
  it with req.json() (fixed: readJson). And the site kept showing the vanilla names: its recruits come from the
  console's uploads, which cannot carry the class before a console has loaded the copy and uploaded again. Added a
  preview: PUT /api/bridge/recruits-preview?od=N (recruits + recruit_interest rows in the import's shape, INSERT OR
  REPLACE under the current snapshot), pushed by the bridge after a run, after every import while the class is still
  pending (the import puts the vanilla names back), and by hand with `od overhaul --preview --did N`. The console's
  own upload replaces it once it carries the class. Request #1's row stays "failed" (a production UPDATE from here
  was refused by the tool policy); cosmetic.
- Lost recruiting points (DID 8, 19:40-19:48): the console restarts the dynasty from the server's file whenever a
  getDynasty shows a DFID other than the one it loaded (the restart check), and it calls getDynasty after every team
  upload, not only on entry; everything it did since its last upload goes with the restart. Two republishes hit the
  coach mid-session: (1) the console had taken the 2025 start year, the next import read the class as 2025 while the
  memo said 2013 -> stale -> week 0 -> the tool ran a THIRD time on file 172 and a new copy (175) went out; (2) a
  minute later the start-year memo was marked taken, the set lost startYear, the key changed, another copy (178).
  Fixes: dod.mjs refreshPatch replaces a copy already published for the same base only when the console comes back
  through the hub (d.hubAt from getContinueDynastyInfoForUser >= d.loadedAt from getDynasty) and keeps a copy nothing
  needs any more until the base changes (the console is on it); the bridge moves the overhaul memo to the new year
  when the start year is taken (maybeStartYear runs before maybeOverhaul now) instead of treating the class as a new
  one. Points live only in the console's RECB until its own upload; the server never touches them. The advance at
  19:47 carried what survived the last restart (250 on one prospect).
- Face edits (migration 0020, web_recruit_edits.head_id): RCPT.PGHE is a 9-bit id, 1..246 in the files (218 distinct
  in a class, 239 in PLAY); the EA DB Editor config (Xan) lists them with skin-tone labels "Light 1-95", "Medium",
  "Dark" (worker/src/pages/faces.ts, generated from the config; 100-104, 125 and 197 have no art in the league's
  face set). The prospect editor has a grouped picker with the art beside it (site.js swaps /img/faces/<id>.png on
  change); the bridge writes PGHE with the other recruit fields and the ack checks it. Headless check: 246 options,
  preview follows the pick, save -> "face 201 (Dark 24) -> 227 (Dark 26)".
- 2026-11-02 16:00 Holy Cross vs Wagner (DID 8, week 2) "hangs loading": not a hang, a crash. RPCS3.log: `VM: Access
  violation reading location 0x0` in FGGameCore at 0x0062fee0 (`bl 0x382770` returned null; stack string
  "compositorReadSceneAwayProp") right after the loader looked for `FBSGEN_JERSEY_2022_WHITE_big.AST`,
  `FBSGEN_HELMET_2022_BLUE_big.AST` and `FBSGEN_PANTSX_2022_WHITE_big.AST` in USRDIR and on the disc (ENOENT).
  Wagner's TEAM.CSAT is `D1AANW`, one of the five built-in generic FCS slots (D1AAEX/WX/NW/MW/SE; the mod puts
  Mercyhurst, West Florida, Wagner, Tuskegee and Delta State on them). The mod's qkl_fe2ig.ast carries a rewritten
  uniform XML for that slot (entry #3271, zlib, 808 B) whose Home/Away parts point at an "FBSGEN 2022" generic set
  that exists nowhere (not in any archive, nested bigfile, DLC folder or loose file; the 0.0.32 install has the same
  archive). The original 2007 art for the slot is still in the archive (D1AANW_JERSEY_2007_GREEN/WHITE/RED with
  NAME/NAME_DECAL/NUMS_DECAL, PANTSX_2007_GREEN/WHITE/RED, HELMET_2007_GREEN/RED; asset table entry #973).
  Fix without touching the archive: the game scans every DLC/FCS_DLC_* folder for `<CSAT>_Pack<n>_MixAndMatch.XML`
  before falling back to the archive's XML (it opened UCFXXX_Pack0 from FCS_DLC_PATRIOT for Holy Cross), and a DLC
  XML may name archive-resident bigfiles (VANDER_Pack0 in FCS_DLC_BIGSKY does). Wrote
  `spike/blaze/tools/uniforms/D1AANW_Pack0_MixAndMatch.XML` (green helmet, green home / white away jersey, white
  pants, vanilla-style like entry #3269) and copied it to `USRDIR/DLC/FCS_DLC_NEC/`. Every member's install needs
  the same file (like the watermark patch). Not yet tested in game.
- The `sys_net: Error recvfrom on P2P socket: 54 / ECONNRESET` lines (every 0.5 s from RPCN login onward) are
  unrelated: RPCS3 sends UDP keepalives from its P2P port 3658 to the RPCN server's UDP port 31313 to learn its
  external address, and the private RPCN runs in WSL2 with localhostForwarding, which relays TCP only; Windows
  answers the UDP sends with port-unreachable (verified with a UdpClient probe: ConnectionReset). Harmless for
  Online Dynasty (no peer-to-peer game), only log noise; mirrored WSL networking would silence it.
- Same check for the other four generic slots (scratchpad ast/scan_fast.py: the inner TOC of every nested bigfile
  carries names, so a 256 KB inflated prefix per entry lists all art in 8 s): D1AAEX, D1AASE and D1AAWX XMLs are the
  vanilla 2007 ones and their art is present; D1AAMW (Tuskegee, entry #3270) is rewritten and its Home/Away pants
  `FCSMWX_PANTSX_2021_GOLD_big` and away jersey `D1AAMW_JERSEY_2021_WHITE_big` exist nowhere either, so Tuskegee
  would crash the same way. Added `D1AAMW_Pack0_MixAndMatch.XML` (gold helmet, blue/white 2007 jerseys, gold pants)
  to tools/uniforms and FCS_DLC_NEC. Both XMLs zlib to ~600 B, so rewriting the archive entries (808 / 2292 B slots)
  in place stays available as a fallback if the DLC-folder override turns out not to apply to TTYP 1 teams.
- 17:10 follow-up: the DLC XML loads (no crash) but Wagner showed a West Virginia helmet and an NDSU-looking jersey.
  Cause found by resolving the names: the archive TOC keys entries by FNV-1a 64 of the UPPER-CASED bigfile name
  with `_BIG` (e.g. `D1AANW_HELMET_2007_GREEN_BIG` -> entry #1637), and several generic-slot entries in the mod's
  qkl_fe2ig.ast no longer hold their vanilla art: #1637 "NW green helmet" = WVU gold/navy Flying-WV helmet,
  #1094 "NW green jersey" = plain dark green, D1AAMW jerseys BLUE/GREEN/WHITE = red / maroon / black, D1AAMW gold
  helmet = navy, D1AAWX black helmet = Texas "150" white helmet, D1AAEX white pants = purple. The vanilla "FCS
  Northwest" set survived under the RED-named entries (#1638 gold "NW" helmet, #1095 green "NORTHWEST" jersey)
  plus #1096 white "NORTHWEST" jersey and #2005 white pants; MW gray helmet (#1636) and the SE white jersey/pants
  (#1098/#2008) are vanilla too. Textures: 'p3R' containers, FourCC at 0x54 (DXT1/DXT5), pixel data at 0x80
  (not the 0x7c header-size word); decoded with scratchpad ast/dxt.py + pieces.py (pure Python, PNG previews).
  XMLs now: D1AANW = the vanilla Northwest set; D1AAMW = gray MW helmet, red jersey (#1091), SE white jersey and
  pants. Both are placeholders: FloridaMan's intended files (`FBSGEN_{HELMET_2022_BLUE,JERSEY_2022_BLUE,
  JERSEY_2022_WHITE,PANTSX_2022_WHITE}_big.ast` for the placeholder set; `FCSMWX_PANTSX_2021_GOLD_big.ast` +
  `D1AAMW_jersey_2021_white_big.ast` for Tuskegee) are on no drive of this PC (nothing named WAGN/MERCY/TUSK/DELTA/
  WFL either). Once obtained: drop them in a DLC folder and point the XML at them (or delete the XML and put the
  FBSGEN files loose in USRDIR, where the archive XML looks).
- 2026-11-02 17:50 FCS Uniform Studio: spike/blaze/tools/uniforms/uniform-studio.html (built from src/ by
  src/build.mjs) loads, edits and creates uniform assets in the browser: DLC folder scan (File System Access API,
  works on file://), bigfile entries with previews, DXT1/DXT5 decode/encode with full mip chains (pure JS,
  ~0.2 s per 1024x2048 texture), DDS export/import for Paint.NET, a paint/recolor/stamp editor, donor-based new
  sets (same-length slot/year/colour renames + rehash + scene-path patch, generated MixAndMatch XML), an XML
  editor, and archive extraction by name hash. Format facts learned for it: DLC bigfiles = BGFA 1.05 with 64-byte
  header (n+1, n, tocOff 64, tocSize, widths 0x04080100/0x404, prefix words 0x78baf565/0x6c233354[/0x8fe5b6d9],
  name width 64), records {u16 flags (0x11 scene, 0x111/0x211 textures), u64 FNV-1a of the upper-case name, u32
  off, u32 csize, u32 usize-csize, name[64]}, zlib entries; the game's archives use the same layout with 0-width
  names; some vanilla bigfiles use 3-byte offset/size fields (widths 0x03080100/0x303). Texture 'p3R': HEIGHT @12,
  WIDTH @16 (DDS order; corrected 2026-11-05, the studio had them swapped), top-mip bytes @20, mip count @28, FourCC
  @0x54 (DXT1/DXT5, 3 DXT3), blocks from 0x80, little-endian DXT. Scene (RSF)
  files reference textures by length-prefixed Maya paths with the slot code in lower case, so renames must keep
  lengths. src/test-codec.mjs passes on helmet/jersey/pants files (byte-identical rebuild, PSNR 42-91 dB,
  DDS round trip, rename). Checked in headless Chrome and the extension: open/edit/encode/XML flows work; file://
  is a secure context with showDirectoryPicker available.
- 18:30 Uniform Studio reworked team-first after feedback ("load my DLC folder automatically, edit what's attached
  to each team, edit DDS directly and repackage"): tools/uniforms/serve.mjs (node, 127.0.0.1:8781, RPCS3 root from
  ~/.ncaa-bridge/config.json; `uniform-studio.cmd` opens it) serves the page and exposes the DLC folder
  (/api/files, /api/file/<folder>/<name> GET/PUT with a backup per write under %LOCALAPPDATA%/ncaa-bridge/uniforms/
  backup), the archive (/api/archive/<NAME>[?probe=1], entries by FNV-1a of the upper-cased name; per-slot
  built-in uniform XMLs are the entries `<SLOT>_MIXANDMATCH`), and a DDS hand-off (/api/dds/open writes the texture
  as DDS into .../uniforms/work and launches the default DDS app; a 1 s watcher repackages the bigfile when the DDS
  changes: exact blocks copied when format/size match, mips regenerated when the DDS has fewer, re-encoded from
  32-bit otherwise; /api/events feeds the page). Page: team list -> uniform rows (Home/Away/alts) with part
  thumbnails and dropdowns (autosave), parts table (where: folder / other folder / archive / MISSING, used-by,
  Textures with Edit DDS / Import / Quick edit, Pull into folder, Remove, Add existing part, Clone from another
  team), Copy-to-DLC-folder for teams on the built-in definition. Verified in headless Chrome against a scratch
  DLC tree + the real archive: autosave, copy-to-folder (creates FCS_DLC_IVY), DDS open -> modify -> auto
  repackage (copied blocks, backup kept). Correction: bigfiles resolve from ANY FCS_DLC_* folder (Ivy teams with
  archive XMLs use art in FCS_DLC_IVY), so the earlier "XML's own folder first" note was too narrow.
- Supersim missing for the Wagner game: the home/game pages only render the Supersim link for a signed-in site
  account (`ctx.account`; accounts are per dynasty, migration 0008 UNIQUE(dynasty_id, blaze_id)) and allowedGame
  needs the member's current-week game; coach1 (DID 8) has no account for efox yet, unlike efoxod1. Fix: an invite
  for DID 8 (`ncaa-bridge invite --did 8 --persona efox`) and join/sign in on that dynasty's page.
- 18:35 Supersim vs Wagner refused with "Depth chart missing": the five generic-slot teams (TTYP 1) have NO rows in
  PLAY or DCHT in the dynasty file (the game generates their players at game time; 126 teams carry the 88-row
  charts), so the site had neither a roster nor a chart. Fix (worker/src/supersim/generic.ts): a team with no
  players gets a deterministic 54-man placeholder roster (ids >= 900000, low-60s starters, generated names and
  faces) and autoDepthChart() builds the 88-slot chart from any roster (best overall by position, then the engine's
  related-position fallback, then anyone); TeamInput.synthetic marks the side and result.ts sends the console team
  totals only for it (no B* player rows, no PG* lines, detail.teams[].players = [], synthetic: true), which matches
  the game keeping no rows for such players. Test added (6 pass). Needs a Worker deploy; the console's acceptance
  of a game-data set with one roster-less side is untested until the next coach1 advance.
- 19:45 Recruit locks (`ncaa-bridge od lock --did N --prsi P --tgid T`, `--clear`, no args lists): a commissioner's
  "make him commit here". The game caps points at 500 per prospect per week (CPU rows reach 600-700 with bonuses,
  RECB.PPSC is 15 bits) and TEAM.TRPA is the weekly budget (5000 for Holy Cross, 5000-6500 league-wide), so "5000
  on two prospects" cannot be allocated; instead the lock rides the dynasty-file patch as a recruit edit with
  lockTgid (dynasty-patch.ts lockInterest): RCPR row by PRSI, the team's PT slot gets PS = max(CMTS, leader) + 600
  (added at slot 10 if the team is not on the list), slots re-sorted by points. Stored in od-state locks[] and
  re-applied on every copy until the console's file shows PTCM = team (then dropped; dropped with a warning when
  he commits elsewhere). First use: DID 8 Destin Fox (1348) and Dewey Fox (958) -> Holy Cross; patch on base 204
  carries 6040 / 6282. Whether the game commits on "points >= CMTS" at the weekly update is the assumption to
  watch at the next advance. Also learned: dynasty-tables/<did> is a stale decode (DID 8's showed the vanilla
  class); the live truth is the newest locker DYNASTY.dynasty for group.id = DID (204 at week index 4).
- FCS playoff feasibility (asked 19:30): the game's postseason rows in SCHD: week 16 (3 bowls), 18 (4), 19 (10),
  20 (19), 21 (1, the championship), teams 1023 until the game's own bowl selection after the regular season;
  rows carry SGNM/SEWT (16, 30, 31, 32, 40), GATG/GHTG, SGID (stadium); BOWL table rows {SGID, BIDX, SEWN, SGNM}
  (45, names BNME / logos BLGO in the Dynasty Tool's view). The NCAA 14 Dynasty Tool's "PLAYOFF MODULE" (renderer
  + worker.worker.js: setupPlayoffs / continuePlayoffs / finishPlayoffs) is the modders' manual way: 4/8/12/14-team
  formats seeded by poll rank (+ confchamps), it rewrites chosen bowl rows' GATG/GHTG/SGID by SGNM+SEWT round by
  round between weeks, renames those bowls (BNME/BLGO), sets SGIN.SGNM=127 for edited games, and parks unknown
  slots on TGID 162 renamed "TBD" (162 is Wagner in this mod, so we would use 1023). It never moves rows between
  weeks, which caps a native bracket at 8 teams (QF in week 18's 4 rows, SF in 19, final in 21); 16 or 24 teams
  need bowl rows re-weeked (SEWN/SEWT + BOWL.SEWN), untested for bowl rows. Plan if wanted: bridge selects the
  field at the end of week 14 (auto-bids + poll at-large, FCS seeding, higher seed hosts), writes each round into
  the copy after the previous round's upload, final into the week-21 row so the game crowns the champion; site
  Bracket page = projected (polls/conference leaders) then live (postseason rows). Gate: an offline RPCS3 test of
  re-weeked bowl rows from a week-15 save.
- 20:05 FCS playoff built (24 teams, the user's pick). Shared logic packages/ncaa14/src/playoff.ts: powerOrder (coaches
  poll 1-25, then record, media poll, overall), conferenceChampion (conference record, conf pct, overall, polls),
  selectPlayoffField (auto bids for every real conference with 4+ playing teams: CAA, BS-OVC, MVFC, UAC, SoCon, Ivy,
  Patriot, Big Sky, SWAC, Southland; Independents/Generic excluded; override by name), bracket24 (R1 pairs 9-24,
  16-17, 12-21, 13-20, 11-22, 14-19, 10-23, 15-18 so R2 is 8/1/5/4/6/3/7/2 vs those winners), resolveBracket (higher
  seed hosts; final neutral). bridge/src/playoff.ts owns the file: ROUND_ROWS = the 23 postseason SCHD rows per round
  (R1 sgnm 0-2 + 23-27 -> week 16, R2 3-6 + 19-22 -> week 18, QF 7-10 (wk 19), SF 17-18 (wk 20), F 36 (wk 21)),
  re-weeked via SEWN/SEWT (16/30/31/32/40) + BOWL.SEWN/BNME/BMON/BDAY ("FCS Playoffs First Round" ...); games written
  as GATG/GHTG/SGID (host's stadium) with SGIN rows of edited games detached (SGNM 127, as the Dynasty Tool does);
  the 14 other bowl rows get playoff teams swapped out for the best remaining teams; playoff rows of rounds not yet
  known go back to 1023 vs 1023. od.ts pendingPlayoff runs each pass: memo in od-state (year, enabled, autoBidConfs,
  seeds, games, champion), weeks patch from the start of the season (already published for DIDs 5-8 at 19:59),
  selection when the game has filled the bowls and R1 is unplayed, next round when the previous round's rows are
  final, state PUT to /api/bridge/playoff (worker migration 0021 playoff_state; pages/bracket.ts = projected from
  polls/standings until the state exists, then live; nav "Bracket"). CLI: od playoff --did N [--preview] [--on|--off]
  [--autobids "A,B"|default] [--reset]. Offline run on a copy of file 204 (scratchpad playoff-sim.mts): re-week,
  fake selection, 23 games through a faked final, every patch verified on re-read. UNTESTED on the console: whether
  the game honours re-weeked bowl rows and TBD rows in future weeks; RULE for the postseason: after every advance
  from week 15 on, go back to the Dynasty hub once (the console downloads the copy with the next round) before
  advancing again, otherwise a TBD game could reach the sim.
- 21:30 **The playoff did not run on the console (DID 8, 2025 postseason).** What the files and the server log show:
  (1) the console never loaded either playoff copy: 224 (R1 written on file 222) was published 20 s before the
  console's next advance and 227 (on file 225) 21 s before the last one; the console only downloads the dynasty file
  at a fresh load from the hub (last hub visit 20:27), and the getDynasty it makes *inside* an advance (after
  RequestAdvanceWeek) reports the new DFID but never fetches it. (2) The game fills every bowl row itself at the
  advance into week 16 (file 222, all 37 rows with teams = its projection) and AGAIN at the advance into week 18
  (file 225: rows 23/24/27 re-picked and played in the same advance, the title row re-picked from URI's CCG win), so
  anything written into bowl rows before week 18 is overwritten. Rows 0-2 of week 16 (SEWT 16) are the mod's three
  conference championship games (BOWL tie-ins SWAC#1 v SWAC#1, CAA, Big Sky; names still "SEC/ACC/Pac-12
  Championship"); our first layout had taken them for the first round and renamed them. (3) The console plays the
  entire bowl season in one advance: at week 18 SGIN listed all 28 remaining CPU games (weeks 18, 19, 20 and the title
  game; the user's bowl game excluded) and RequestAdvanceWeek went 18 -> 23 (NWWK 23, file 228) in 37 s; the EBOOT
  strings name the stops "Advancing to Conference Championships", "Advancing to Bowl Season", "Advancing through
  Bowl Season", "Advancing to National Championship Week", "Advancing to End of Season". The regular season also
  jumped 5 -> 10 and 12 -> 16 in single advances (RequestAdvanceWeek carries no target; the console decides).
  So a console-played bracket is impossible: there is no advance between rounds.
- 22:00 **Redesign: the bracket is played on the site.** bridge/src/playoff.ts: the field is selected from the
  console's week-18 file (SEAI.SEWN >= 18, bowls filled, no bracket row played); the bracket games are Supersim games
  on the postseason rows (R1 rows 3-6+19-22 week 18, R2 rows 7-14 week 19, QF 17/18/23/24 and SF 25/26 week 20, final
  row 36 week 21; layout shared with the site in packages/ncaa14/src/playoff.ts BRACKET_ROWS/BRACKET_WEEKS; rows 0-2
  never touched, their names and rows 23-27's week restored (ORIGINAL_ROWS)); the watcher reads the site's results
  (GET /api/bridge/playoff), adds each next round, and when the champion is known builds the copy with all 23 games
  (teams, GSTA/scores/GFOT, host stadiums, SGIN detached), the other 11 bowls fixed, manifest requireLoad. Phases in
  the memo: pending -> live -> final -> delivered (the console's upload shows the rows played; matched/total logged)
  or skipped. The import lays the bracket over the postseason rows (overlayPlayoff: teams, site results, TBD for
  unknown rounds, records bumped while the console has not played the rows). dod.mjs: CheckAdvanceWeekStatus answers
  ALLW 0 + THTM/UTM text while web-edits/<did>/ADVANCE.hold.json exists (phase live at week 18) or a requireLoad copy
  is published that the console has not downloaded (locker download hook -> d.consoleLoadedCid). Worker:
  playoff-state.ts (merge of bridge state over site results, next rounds resolved on the site too, bracket games
  written into `games` as source 'playoff', TBD rows for unknown rounds), GET/PUT /api/bridge/playoff, bracket page
  with phases and Coach/Watch/Sim links. CLI: od playoff --skip "note", --hold "text" / --release (gate test).
  Offline rehearsal (scratchpad playoff-sim2.mts) on file 222 + layout: selection, five rounds of fake site
  results, final copy built and read back 23/23, no team twice, CCG rows untouched, names restored. Local Worker:
  PUT live/skipped/pending states render, site results survive a result-less bridge PUT.
  UNTESTED on the console: (a) what the console shows for ALLW 0 (od playoff --did N --hold "text" to try it on a
  test dynasty), (b) whether the bowl-season advance keeps pre-written finals (GSTA 2/3 + scores in SCHD, SGIN rows
  detached) or simulates those rows again; the watcher logs matched/total after the advance either way, and the
  site's results stand as the FCS playoff. DID 8's 2025 state: mark skipped (od playoff --did 8 --skip) once the
  Worker is deployed. The league server must be restarted (restart-league.cmd) for dod.mjs/locker.mjs/supersim.mjs.
- 22:10 Supersim spectating + member-vs-member check (subagent): `/d/<slug>/supersim/<week>/<game_no>` coaches a named
  game (yours) or watches it; `/supersim/watch/<week>/<game_no>` always watches; `?game=W:G[&watch=1]` on the data
  endpoint; payload gains watch/controls/coaches/recent (ring of the last 6 PlayDetails in supersim_live.state_json,
  ~+35 KB per game)/liveGames; a member with no eligible game gets 200 {noGame, liveGames}. Client watch mode polls
  every 2.5 s and animates the plays it missed. PvP verified by worker/test/supersim-pvp.test.ts on an in-memory D1
  fake (worker/test/fake-d1.ts): both members join one live row, each snap resolves on the second call, pending calls
  survive tempo/timeout bumps, one official row. League server: a member-vs-member Supersim final is now game data
  for BOTH member teams (supersim.mjs acceptResult), so either console applies it. Bracket games ride the same
  routes (worker/src/supersim/playoff-games.ts): a member whose team is in an open bracket game coaches it, a game
  between two CPU teams is "driven" by any member (start/auto/abandon only; public/js/bracket.js runs it from the
  Bracket page, 12 snaps per request) and its final goes to playoff_state + the schedule row, never to the console
  outbox. Local check: a CPU-vs-CPU first-round game simmed from the bracket page by the real engine (UC Davis at
  Lehigh 14-44), the state and the games row updated, the page reloaded with the final.

## 2026-11-03 — playoff rollout: server restarted, DID 8 marked skipped, hold test armed
- 07:10 restart-league (the console was dropped: it had sat idle at DID 8 for ten hours after its week-23 result
  pull); all four services back, sync running again (it had stopped after four quick crashes during the half-applied
  bridge edits). `od playoff --did 8 --skip` -> phase skipped, pushed to the site (the production Worker already took
  the PUT; the page shows the skipped banner only after the next deploy, which the user runs: `npx wrangler deploy`
  is refused to the assistant; `d1 migrations list --remote`: nothing to apply, 0021_playoffs is in place).
  Hold semantics fixed first: the watcher's playoff pass used to `setHold(dir, null)` whenever the playoff was not
  live, which would have wiped a hand-set hold within one cycle. ADVANCE.hold.json now carries `manual: true` for
  `--hold`; the watcher only writes or clears its own (non-manual) hold; `--release` clears either. Verified: the
  watcher's first pass after the restart left `web-edits/6/ADVANCE.hold.json` ("League hold test") in place.
  Waiting on the console: Advance Week on efoxOD1 (DID 6) should be refused with that text (CheckAdvanceWeekStatus
  ALLW 0); then `od playoff --did 6 --release`.
- 07:20 Worker deployed by the user (version ade3a398). The first skip PUT had gone to the old Worker, which stored
  the state without the phase (the site still read "live"), so `od playoff --did 8 --skip` was re-run after the
  deploy: site phase skipped, the Bracket page shows "No playoff was played this season". Lesson: pushedKey marks a
  state as sent even when an older Worker accepted it; re-run --skip/--reset after a deploy that changes the format.
- 18:30 Real PS3 (CFW 4.90, webMAN MOD 1.47.45) cabled to the PC. Windows Internet Connection Sharing gives the Ethernet
  port 192.168.137.1 and the PS3 192.168.137.2 (manual settings; its DNS is the PC). Proton VPN blocked every LAN
  connection ("forbidden by its access permissions") until disconnected. Found on the console: the game as a HDD folder
  with the five STOCK disc archives, the 1.02 data with a partial older FCS build (4 of 12 FCS_DLC folders, a smaller
  qkl_patch.ast) plus a CFBR custom DLC folder, no dynasty saves. Mirroring the RPCS3 build over FTP (scratchpad
  ps3-sync.sh): stock archives renamed *.stock, old DLC pieces moved to DLC_backup_2026-11-03, then the four modded
  archives (5.9 GB), qkl_patch.ast and the 12 FCS_DLC folders (951 files) uploaded at ~17 MB/s. First attempt at the
  archives failed with curl "bad range in URL": the brackets in the RPCS3 disc path are URL globbing; -g fixes it.
  league.mjs gained --lan <ip> (redirector --blaze-host, blaze --qos-addr/--http-host; telemetry/ticker ADRS follow
  HTTP_HOST); the league now runs with --lan 192.168.137.1. The console's DNS goes through the sharing resolver,
  which honours the PC's hosts file: gosredirector.ea.com and reports.tools.gos.ea.com -> 192.168.137.1 (the only
  two names RPCS3's DnsHook ever saw). Saves: PS3 saves carry PARAM.PFD, RPCS3's do not, so the FCS roster save
  cannot simply be copied. Open: PSN sign-in/ticket on hardware, the All-Conference crash patch as an EBOOT patch.
- 18:45 Mirror complete: qkl_patch.ast + 951 DLC files (sizes all match), the four archives (boot 6 s, fe2ig 193 s,
  interface 23 s, stream 111 s; ~18 MB/s). Lesson: never edit a bash script while it runs (bash reads the file as it
  goes; the first run died with "unexpected EOF" at its verification step after an edit). The PS3 keeps 6.6 GB of
  replaced files (*.stock in the game folder, DLC_backup_2026-11-03 next to DLC) until someone deletes them. Hosts
  entries on the PC still pending (gosredirector.ea.com resolved to EA at 18:45). Not changed on the console: the
  stock EBOOT.BIN (disc 1.00 in the folder, 1.02 in the game data), the CFBR custom DLC folder, the saves.
- 19:05 PS3 roster: real-console saves are AES-encrypted protected files (USR-DATA had no DB header, HED-DATA 32 bytes
  of ciphertext) with hashes in PARAM.PFD, so a plain RPCS3 USR-DATA cannot just be dropped in. Used pfdtool 0.2.3
  (installed with Bruteforce Save Data 4.4.2 and again inside the NCAA 14 Dynasty Tool; games.conf has BLUS31159
  secure_file_id 0F..0F): `pfdtool -g BLUS31159 -d <dir> USR-DATA HED-DATA` (decrypt; proved the key: DB header
  appears), copy STABLEV1's USR-DATA + its own 28-byte HED-DATA (the header's last u32 differs per roster), `-e` to
  encrypt and update the PFD, `-c` all OK, then USR-DATA/HED-DATA/PARAM.PFD uploaded over the console's
  BLUS31159-ROSTER-I (user 00000006); round-trip hashes match. The original save is backed up in
  %LOCALAPPDATA%/ncaa-bridge/backups/2026-11-03-ps3-roster-I. Not yet loaded in the game.

## 2026-11-04 — FloridaMan's current FCS build installed on RPCS3 0.0.29 and the PS3 (our patches kept)
- Source: `Desktop/FCS/FCS` (BLUS31159 game data + `BLUS31159-[NCAA Football 14]` disc folder), left untouched.
  Compared against the 0.0.29 install (and the 0.0.32 copy, which is the previous build unpatched): qkl_interface,
  qkl_misc, qkl_stream, qkl_patch.ast and both EBOOTs are byte-identical; the drop's qkl_boot.ast hashes equal to our
  `backups/qkl_boot.ast.orig` (7adf3714...), so the mod did not change it and our watermark/--vram-copy patched copy
  stays live (`photo-watermark-patch.mjs check`: all three blocks patched). The real update is (a) a new DLC folder
  `FCS_DLC_PIONEER` (34 bigfiles: Butler, Dayton, Marist, Morehead State, San Diego, Stetson, Valparaiso 2024 sets),
  (b) `FCS_DLC_MEAC/BOWLGR_Pack0_MixAndMatch.XML` (2778 -> 2832 B) and (c) qkl_fe2ig.ast 3,572,993,720 B (ours was
  3,572,993,056): scratchpad astdiff.py (entry-by-entry TOC + sha256) found exactly 7 differing entries, #3247 #3268
  #3281 #3323 #3344 #3371 #3381 = the seven Pioneer teams' `_MIXANDMATCH` XMLs (placeholder FCSXXX 2042 / MOSTAT sets
  before), every other entry identical, entry 4664 (RCAT) unchanged. Our own archive differed from the old build in
  entry 4664 only.
- RPCS3 0.0.29 (game not running; the emulator window was idle): staged a copy of the new archive, re-applied the
  Recruit Overhaul RCAT with installRcat (scratchpad install-rcat.mts calling bridge/src/recruit-overhaul.ts, since
  `od overhaul --install-rcat` refuses while rpcs3.exe exists; second call a no-op), entry 4664 sha after =
  811a52a0... = the live archive's entry; swapped it in; astdiff live vs drop: only entry 4664 differs. Live
  qkl_fe2ig.ast sha256 5499ae6d94cf4a5dcf66515a8196f6ea4a15b3a95e2377424ebb45a838235edd. The 4664 backup in
  `backups/qkl_fe2ig.ast.4664.orig` is still valid (the entry is the same bytes in both builds). FCS_DLC_PIONEER copied
  (34/34 hashes verified), MEAC XML replaced (old one in `backups/2026-11-04-pre-pioneer/`), our two
  `FCS_DLC_NEC/D1AA*_Pack0_MixAndMatch.XML` kept. RPCS3 patches (patches/imported_patch.yml, patch_config.yml) and
  saves untouched. The superseded archive is still beside it as `qkl_fe2ig.ast.prev` (3.57 GB; C: went from 5.2 GB free
  to ~2.1, and deleting it was refused to the assistant by the auto-mode classifier, so the user deletes it);
  rollback = that file, the PS3's `qkl_fe2ig.ast.pre-pioneer` (identical) or the 0.0.32 copy + installRcat.
  0.0.32 / 0.0.43 installs (parked) were not updated.
- PS3 (webMAN FTP; the game was running at first, so the archive went up as `qkl_fe2ig.ast.new` and the swap waited
  for the XMB; hdcache/ on the console is empty too): FCS_DLC_PIONEER uploaded (34/34 sizes), archive 3.57 GB in
  4 min, verified by size + sha256 of the first/last 8 MB and of the RCAT entry range read back; then RNFR/RNTO
  current -> `qkl_fe2ig.ast.pre-pioneer`, `.new` -> live; MEAC XML replaced. Nothing else on the console changed:
  the experimental no-PSN EBOOT (12,973,728 B, `EBOOT.BIN.before-np-test` beside it) and PARAM.SFO state from
  2026-11-03 are as they were, the CFBR custom DLC folder and the `*.stock` archives remain. Finishing script:
  scratchpad ps3-finish.sh (refuses while webMAN shows a game process, re-runnable).
- Not yet seen in game: a Pioneer team's uniforms on either machine.

## 2026-11-05 — new online dynasty invisible on the site (empty slug in od-state)
- Eric created "efoxOD4" (DID 10, file 320, team 64) on RPCS3; the site never showed it. `od import --did 10` by hand:
  `POST /api/bridge/dynasties -> 400 slug required`. Cause: the watcher's playoff pass (and `od lock`) create the
  od-state entry `{ fingerprint: '', slug: '', importId: 0 }` before the first import, and odImportOne used
  `state.slug ?? odSlug(d)`, which keeps the empty string. Fixed with `||` (bridge/src/commands/od.ts). DID 9
  "test26" (created 09:40, no members) had failed the same way; the watcher imports it after the supervisor reloads
  the bridge code (it waits for the console to disconnect — do not restart-league while someone plays).
- After the fix the import committed to /d/efoxod4 (786 schedule rows, 2710 recruits), queued start year 2025 and
  ran the Recruit Overhaul (2701 renamed) into DYNASTY.patch.bin; dod.mjs publishes it at the console's next hub
  visit / dynasty load as usual (never mid-session).

## 2026-11-05 — 2026 roster photos, start year 2026 by default, "Nth season" counted from the dynasty's start year
- Photos: the 2026 roster scrape (`Desktop/FCS/Rosters/2026`: photos/player_photos_manifest.csv + 13,057 raw downloads,
  normalized/players.csv with tgid + game_first/game_last, assign/assignments.csv with the roster row = tgid + pgid)
  is packed by the new `tools/photo-pack.py` into `%LOCALAPPDATA%/ncaa-bridge/photos/2026` (160 px JPEGs
  `2026__<Team>__<Name>.jpg`, 87.5 MB, 33 s; manifest columns + tgid, game_first, game_last, pgid). The bridge now
  takes several photo sets (config `photosDirs` beside `photosDir`; bridge/src/photos.ts loadPhotoIndex merges them,
  later sets win) and matches by the game's team id + in-game name first (`byTgid`), team name + name second
  (`byTeam`); `photos upload` sends every set with the right content type. efoxOD4 (DID 10, on the 2026 roster)
  re-imported: 8,473 of 8,694 players have a photo (8,411 from the 2026 set, 62 from the old one; the old set alone
  gave 6,662 on the 2025 roster). Upload of the 13,057 new objects to R2 started 10:39 (~400 files / 35 s).
- Start year: `od year --default 2026` (config startYear 2026); DID 10 and DID 9 re-queued with `od year --did N
  --year 2026` (patch rebuilt: SEAI SSYE/SEYR 13) before any console took the 2025 one.
- "14th season": worker/src/pages/common.ts seasonLabel counted from 2013. Now SeasonInfo carries startYear (SEAI.SSYE
  + 2013, packages/ncaa14 decode/league.ts), both import paths post `startYear`, the Worker stores
  `dynasties.start_year` (migration 0022) and seasonLabel counts from it (player and transfer pages pass it along).
  Needs, in this order: `npx wrangler d1 migrations apply ncaa-online --remote`, `npx wrangler deploy` (both refused to
  the assistant), then `npx tsx bridge/src/cli.ts od import --force` so every dynasty's start_year is recorded (until
  then the label still reads from 2013). vitest 19/19, tsc clean (packages/ncaa14 dist rebuilt for the bridge's tsc).
- 11:05 Upload complete: players/2026__* = 13,057 objects in R2 (one batch per run hit a Cloudflare edge 500 HTML page;
  photosUpload now retries a batch up to 4 times). The bridge's "already stored" list was short on the second run
  because /api/bridge/photos listed at most 20 pages and R2 pages came back with ~680 keys, not 1000; the Worker now
  reads up to 100 pages (needs the deploy). The old set is intact (sample old key served). Roster pages of /d/efoxod4
  reference the 2026 files.
- 11:15 Correction: SEAI.SSYE is NOT the start year (it moves with SEYR at every rollover: files 124/311 of DID 6 read
  0/0 then 1/1, DID 8's 163/172/297 read 0, 12, 13 for both). The decoder change was reverted; the bridge now derives
  the start year itself (commands/od.ts odStartYear): the year queued by `od year` once a console file carries it,
  else the year of the dynasty's earliest DYNASTY.dynasty in the locker (trash included; od.ts lockerIndexAll /
  readLockerBlobAny), cached in od-state as firstYear. After migration 0022 + the user's deploy (version 1bb4f3c3) and
  `od import --force`: coach1 2026/start 2025 "2nd season", efoxod1 2014/2013 "2nd season", the rest "1st season".
- Landing page (fcs-mod.online): FloridaMan thank-you banner in a 14 px-radius card under the header
  (public/img/home/floridaman-thanks.jpg, 1600 px JPEG from the 2172x724 PNG) and the two roster download buttons
  (download-2025-roster.png / download-2026-roster.png, cropped to the artwork at 1000 px, transparent surround), a
  2-column grid that stacks (2025 first) under 720 px. Downloads: new route /downloads/<file> (worker/src/api/downloads.ts)
  streams R2 `downloads/<file>` as an attachment; uploaded with `wrangler r2 object put ncaa-online-saves/downloads/...`:
  FCS-2025-Roster-STABLEV1.zip (save folder BLUS31159-ROSTER-STABLEV1, identical in the 0.0.29 and 0.0.32 installs)
  and FCS-2026-Roster.zip (BLUS31159-ROSTER-FCS2026 = Rosters/2026/out, USR-DATA 6acd554d...). These are RPCS3 save
  folders; a real PS3 needs them resigned (pfdtool, see 2026-11-03). Previewed on `wrangler dev --local --port 8798`;
  needs `npx wrangler deploy`.
- Evening: site-wide accounts (migrations 0023-0026, split on 2026-11-06, see there). Eric had to make a separate account per dynasty ("eric" in efoxod1 and
  coach1, both blaze 1) because accounts and sessions carried a dynasty_id. Now `accounts` is one username + password
  for the site owning at most one league-server persona (`blaze_id` = the RPCN user id the Blaze stub assigns at
  ps3Login, stable per RPCN account), `account_members` links it to the member it acts as per dynasty, and sessions
  have no dynasty. The Worker's member sync (api/bridge.ts upsertOnlineDynasty) links every console member whose
  persona owns an account and drops links of members who left, so a dynasty created or joined on the console is
  recognised on the site at the first import with the session already in the browser; session.ts also links lazily.
  Invites remain for people without any account; the bridge call and "Create invite" link a known persona instead
  (`{linked:true}`), and /join offers "Join as <username>" to a signed-in browser (web players anywhere, console
  personas only for an account owning none). Migration: newest row per persona keeps its password, clashing usernames
  get -<blaze id> / -<dynasty id>, personas linked to every dynasty they are in, sessions dropped (sign in once more).
  Checked with a sqlite simulation of the production rows plus clash cases, tsc clean, vitest 19/19, and the flows on
  `wrangler dev --local --port 8799`. Needs `cd worker && npx wrangler d1 migrations apply ncaa-online --remote` then
  `npx wrangler deploy`; the bridge (invite.ts) only changed its message.
- Uniform Studio textures looked "low-quality and distorted": codec.cjs read the p3R header as width @12 / height @16
  but it is HEIGHT @12 / WIDTH @16 (DDS order), so a 1024x2048 jersey decoded as 2048x1024: two squashed copies side
  by side, and the DDS hand-off carried the same swap into Paint.NET. Only square helmets looked right. Fixed in
  parseTexture (test-codec still passes, the jersey decodes as one 1024x2048 image, the number decal as 0-9 stacked
  256x4096); the editor canvas now smooths when zoomed out (pixelated only at >= 100 %) and bigfile thumbnails no
  longer use nearest-neighbour. uniform-studio.html rebuilt. DDS files exported before the fix have the dimensions
  swapped: re-export them from the fixed studio before editing.

## 2026-11-06 — the site-accounts migration refused by D1's remote API (7403), split into 0023-0026

- `npx wrangler d1 migrations apply ncaa-online --remote` failed on 0023 with "The given account is not valid or is
  not authorized to access this service [code: 7403]" from `/d1/database/<id>/query`. Not a token problem: `wrangler
  whoami` shows `d1 (write)`, `migrations list --remote` and `d1 execute --remote --command "SELECT ..."` work.
- Probes with harmless statements against a table that does not exist (`UPDATE zz SET a = 1`, `DELETE FROM zz`,
  `INSERT INTO zz ... SELECT`, `DROP TABLE zz`, `ALTER TABLE zz ADD COLUMN` / `RENAME TO`) all get the same 403, while
  `DROP TABLE IF EXISTS zz`, any SELECT (CTEs, correlated subqueries, stacked `SELECT; SELECT`), comment lines and the
  whole migration text inside a string literal pass. Earlier migrations all passed, including ones that create a table
  and an index on it in one file. So the query API resolves the target table of every INSERT/UPDATE/DELETE/DROP/ALTER
  against the schema as it stood when the request began and answers 7403 when it is missing; CREATE TABLE / CREATE
  INDEX are exempt. 0023 was our first migration that created tables and wrote to them in the same file (and dropped
  `sessions` / `accounts` and recreated or renamed onto them). The local D1 (miniflare) does not check this, which is
  why last night's local apply and the e2e run were fine.
- Fix: the same change as four files, each touching only tables that exist before it runs: 0023 creates `accounts_v2`,
  `account_members` (+ index), `acct_map`; 0024 fills them from the old rows, re-points `invites`, then `DROP TABLE IF
  EXISTS sessions / acct_map / accounts`; 0025 creates the final `accounts` and `sessions` (+ index); 0026 copies the
  rows (same ids) from `accounts_v2` into `accounts` and drops the staging table. No RENAME and no CTE, so nothing
  depends on how that API parses them. The sqlite simulation (migtest2: production rows plus clash cases and a
  persona whose newest row changed username) passes, a fresh local D1 applies 0001-0026 cleanly, and its
  `accounts` / `sessions` / `account_members` schema is identical to the one the single-file version produced.
  The shared local dev DB already had the single-file 0023, so 0024-0026 were recorded there as applied by hand.
- Rule for future migrations: never create-then-write, drop-then-recreate or drop-then-rename-onto a table in one file.
  If a file cannot be split, `wrangler d1 execute ncaa-online --remote --file <sql>` goes through D1's transactional
  import endpoint (file upload, no such check) and the file is then recorded in `d1_migrations` by hand.
- Still needs, from `worker/`: `npx wrangler d1 migrations apply ncaa-online --remote` (lists 0023-0026) then
  `npx wrangler deploy`; sign in once as eric afterwards (sessions are dropped).
- Applied and deployed (migrations 0023-0026 on the remote D1, then `wrangler deploy`): 2 accounts (eric owning blaze
  1, Dylan), eric linked to efoxod1, efoxcareer and coach1 (the dynasties blaze 1 is a synced member of), 0 sessions.
  test26 (DID 9) and efoxOD4 (DID 10) have no members on the league server because Eric retired them on the console, so
  there was nothing to link. Follow-up: `listDynasties` (the landing page's "Browse Dynasties") now hides a league-server
  dynasty with no members (`od_id` set and no `od_members` rows); offline-save imports (no member list) stay listed and
  the hidden dynasty's pages stay reachable by URL. Checked on `wrangler dev --port 8802` against a seeded local D1.

## 2026-11-06 — jersey #0 crash (player editor / game load) and the RPCS3 patch "FCS mod: jersey #0"

- Symptom: a player set to #0 on the site (the editor allows 0..99 and PLYZ carries PJEN 0) shows fine on the roster
  screens, but opening him in the in-game player editor (player model) or loading a game crashes. Eric's log:
  `F {PPU[0x1000015] Thread (FGGameSim) [0x001791c4]} VM: Access violation reading location 0x6b700019`.
- 0x1791c4 is the return address of `strcmp` (0x69d6e4) inside `FindStringIndex(array, count, needle)` at 0x179188
  (RPCS3 reports the caller's PC for faults inside the leaf). The garbage pointer is an entry past the end of the
  player editor's "Jersey Number Name" list:
  - taken-number mask for a team, 0x483b1c (cursor over PLAY, fetch PJEN): sets bit n only for 1 <= n <= 99
    (`cmplwi r3,1; blt` at 0x483bb8), so a player with 0 never marks bit 0;
  - list count, 0x17a3b4 (count dispatcher 0x17a738): kind 5 (CAP) = 99; otherwise loop n = 1..99 (`li r5,1` at
    0x17a3fc) counting free numbers, then +1 for the player's own number (always for kind 1, else when own's bit is set);
  - list builder, 0x177c84 (fill dispatcher 0x1784c4): kind 5 = "1".."99"; otherwise loop n = 1..99 (`mr r24,r30` at
    0x177d80) adding n when free or equal to own;
  - lookup of the current value, 0x1791f0 jersey case 0x179538-0x1795a8: `sprintf("%d", own)` then FindStringIndex.
  With own = 0 the builder never reaches 0, the list is one entry shorter than the count, and the search runs off the
  end. The jersey number lives at byte +0x78 of the global edit-player record ([0x1c72064]).
- Rendering: the character manager keeps the number at +0x33c of the player-art object (set at 0x5f07c8 from the
  "jerseyNumber" descriptor). Readers: 0x5e2678 and 0x5e4fcc test `n == 0 || n >= 10` (crorc at 0x5e2688 / 0x5e5064)
  and send 0 down the two-digit placement path ("00", numberSpacingAdj0/1 lookups, digit split at 0x5e27fc-0x5e2860),
  while 0x5f143c (helmetCenterNumOffset*, n <= 9) and 0x5f651c (front/backUVOffsetScale, n < 10) set 0 up as one
  digit; the placement function 0x5e4ec0 dereferences the parameter blocks at +0x2ec/+0x2f8 without null checks.
  The number sheet (`<slot>_NUMS_DECAL`, 256x4096) is 16 cells of 256 px with digits 0..9 in cells 0..9, so "0" is
  drawable like any digit. No `.pus` script in qkl_boot.ast touches numbers; this is CPU code.
- Patch (five one-word swaps, generator `tools/jersey-zero-patch.py`, bake option `ps3-eboot.mjs --jersey-zero`):
  0x483bb8 `cmplwi r3,1` -> `cmplwi r3,0` (0x28030000); 0x17a3fc `li r5,1` -> `li r5,0` (0x38a00000); 0x177d80
  `mr r24,r30` -> `li r24,0` (0x3b000000; r30 stays 1 for the bit shift and the CAP default); 0x5e2688 and 0x5e5064
  `crorc` -> `crnor cr0eq,cr0lt,cr0lt` (0x4c400042), i.e. the two-digit path only for n >= 10. Count and list now agree
  for every own value (0 is listed as free when nobody wears it and as the player's own number when he does), the mask
  keeps teammates from picking a taken 0, and CAP (kind 5, array sized 99, indexed n-1) is unchanged. The Flash list
  builder 0x240f68 (loop from 1) and the spinner clamps 0xe5c4d0 / 0x101a940 still offer 1..99 in-game.
- Installed in <rpcs3>/patches/imported_patch.yml + config/patch_config.yml (copy in private/rpcs3-patches.yml, 44 words
  in all), backups in %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-06-jersey0. PS3 ELF
  `private/BLUS31159-1.02-allconf-five-dynasties-jersey0.elf` (sha256 c98b9e45...62f7, 44 writes; still needs the
  signing route from docs/ps3-no-psn-research.md). Not yet tested in game: open the #0 player in the player editor and
  load a game; if the game load still dies, the next suspects are the helmet/shoulder/sleeve number textures
  (`HelmetNumberTexture`, `ShoulderNumberTexture`, `SleevesNumberTexture`) — grab the new access-violation PC.
- Roster-cap research done the same day (PGID = TGID*70 + slot in the executable: 8 `mulli 0x7507` divisions, 101
  `mulhwu 0xD41D41D5` divisions, up to 301 shift-add multiplies, the league package PLAY max 70 at 0x8ae38, roster-save
  size 0x15e000 at 0x3b46a0, dynasty buffer 0x7e5000) is written up in docs/roster-stride-inventory.md.
- CONFIRMED 2026-11-06 (Eric): with "FCS mod: jersey #0" applied, a #0 player opens in the player editor and plays in
  a game; the number renders. Stage 2 of the roster-cap work (the executable patch) starts from the inventory.

## 2026-11-06 — roster cap Stage 2: the "FCS mod: 100-player rosters" patch (built, not yet run in game)

- Generator `tools/roster-stride-patch.py` (report `docs/roster-stride-report.md`, words `private/roster-stride-words.json`,
  yml entry appended to <rpcs3>/patches/imported_patch.yml and private/rpcs3-patches.yml, **Enabled: false** in
  patch_config.yml until a stride-100 dynasty exists; backups in %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-06-roster100).
  778 words: 8 `mulli 0x7507` divisions -> `0x51EB` (exact for TGID <= 403; the one inside the All-Conference window is
  emitted at its moved address 0x453968 and needs that patch listed first), 101 `mulhwu 0xD41D41D5` divisions ->
  `0x47AE147B` (the subf/srwi 1/add/srwi 6 tail stays: x/100 exact for all 32-bit x), 113 shift-add x70 chains ->
  `mulli R,X,100` + nops (chains found by tracking coefficients of X; a chain that turns X into 35X computes R at its
  first instruction instead), the league package PLAY rows (0x8ae38: 100) and the roster save buffer (0x3b4690/0x3b46a0:
  0x15e000 -> 0x1c0000).
- Left at 70 on purpose (documented in the report): the engine's 70-per-side layout (0xa23c84, 0xa2a3e8: row base of
  the away team in PLGA/DCGA and the 140-entry arrays; the +70 at 0xa94bd4 / 0xa94c54), frontend/other-region chains
  that index 70-entry per-team arrays (0x64d38, 0x110baa4, 0x110c3f4, 0xdf2f0 ...), 0x48b168 (a 70 % scale), and every
  `li 70` / `cmp 69|70` limit. Forced in: the slot computations 0xa94bb4, 0xa94c24 and the depth-chart slot 0xa31228.
  So with the patch on, ids are stride 100 but every team must still hold <= 70 players (slots 0..69) until the arrays
  and limits are grown (checkpoint 2).
- Delivery: `ncaa-bridge od stride --did N --stride 100` queues a StrideMemo in od-state; syncWebEdits adds `stride` to
  the DynastyPatchSet (applied last; PLYZ/TRAZ/PLSZ change tables are held empty while it is pending), the watcher
  publishes the re-keyed copy (patchDynasty: detectStride, rekeyStride, PLAY 9100 -> 13000) and the memo is marked
  taken when a console upload reads back at stride 100 (maybeStrideTaken). `od stride` alone prints the status.
- Checkpoint 1 procedure: `od stride --did <test> --stride 100` with the watcher running -> enable the patch in RPCS3
  -> load that dynasty from the hub ("Downloading Dynasty File") -> rosters, depth chart, a game, an advance -> watch
  RPCS3.log for access violations and the server log for the upload (PLAY max should stay 13000). Do not load a
  stride-70 dynasty or a roster save while the patch is on. PS3 ELF with everything:
  private/BLUS31159-1.02-allconf-five-dynasties-jersey0-roster100.elf (sha256 e2c82d78...0346, 822 writes).
- The console's dynasty file (unlike the offline saves) carries index definitions: PLAY {PGID, TGID}, TEAM {TGID},
  PLGA {IXPG}, DCGA {IXDG}, 16 bytes each ({4CC, 0x0101, field number, 1}), no per-row data, so growTable keeps them
  and the game rebuilds its lookups at load. The in-game copies PLGA (max 140 = 2 x 70, alloc 14) and DCGA (182 =
  2 x 91) live in the dynasty file too: checkpoint 2 has to grow PLGA to 200 along with the engine's +70 offsets.

- Checkpoint 1 (Eric, same evening): coach1 at stride 100 loaded, rosters and depth chart fine, but the game vs
  Abilene Christian started with no players on either side and died at the kickoff play call (0x163e28, NULL player).
  Cause: two engine chains I had filed as "70-per-side layout" are PGID bases: 0xa2392c creates the player objects
  from base = GINF.GHTG/GATG * 70 + i (chain 0xa23c84, loop `cmpwi cr1,r17,0x46`), and 0xa2a3a0 rebuilds PGID =
  TGID * 70 + packed slot from the in-game depth chart (chain 0xa2a3e8); both now forced to x100 (788 words,
  yml entry replaced in both files, ELF re-baked sha256 9bd74fca...5bcf, 832 writes). The copies PLAY->PLGA
  (0x43f990) and DCHT->DCGA (0x466b34) select `PGID >= TGID*100 and < +70` through the patched chains, so they were
  fine; `(x+1)*0x51EB>>21` and the 0x47AE147B tail were checked numerically (exact below 40,400 / for all 32-bit x).
  Retest pending.
- CHECKPOINT 1 PASSED (Eric, 2026-11-06 13:13): with the stride-100 copy published (file 297 -> re-keyed copy) and the
  patch on, coach1 loaded, played a full game vs Abilene Christian and advanced to week 6. The console's upload (file
  326) is keyed at stride 100 (8,582 of 8,694 PLAY rows match /100) and keeps PLAY max 13000, so the console preserves
  the grown table across its own saves; the bridge marked the stride taken. The `.team` package (file 324) still has
  PLAY max 70 (and CUTP 70, PINP 840): the 0x8ae38 'LEAG' creation is a different package, the .team builder is still
  to be found. The earlier failed attempt was the console loading its stride-70 file 297 with the patch on (the stride
  had not been queued), not the patch itself.

## 2026-11-06 — roster cap checkpoint 2: dynasty capacity 100, games dress 70 (built, not yet run in game)

- Why "dress 70": the in-game side is 2 x 70 by layout, not by constant: PLGA/DCGA (140/182 rows, alloc 14), the
  engine's player pool (`0xa5daf0(.., 140)` at 0xa23c1c, sized by the PLGA row count byte), objects with 140-entry
  arrays at fixed offsets (0xded90: +0x50/+0x280/+0x4b8, the 0xdea2c position array), a 140 x 12-byte stack array in
  0x4e4bf8, loops over 140 (0xdf2e0, 0xdebb8), the away offset +70 (0xa94bd4/0xa94c54), the in-game DB tables 'MULT'
  (140 rows at 0xa2a8f0) and the 70-entry per-team u16 lists in the recruiting UI global (0x537a28). Growing those
  means relaying out compiled objects. So the dynasty roster (PLAY) goes to 100 and a game dresses slots 0..69 (the
  PLAY->PLGA / DCHT->DCGA copies keep `base .. base+70`). Slots 70..99 are reserves; a depth-chart entry pointing at a
  reserve is dropped by the DCGA copy (behaviour at game time still to be seen).
- Patch "FCS mod: 100-player rosters (capacity)" (roster-stride-patch.py --capacity, 99 words, Enabled: false, needs the
  stride entry): 81 `base + 70` range ends fed by the patched x100 chains -> +100 (19 kept at 70 because their functions
  touch the in-game ..GA tables, as 4CC immediates or inside SQL strings: 0x43fabc, 0x466c60, 0x46d924/0x46d9c4,
  0x46dfe0 [game setup], 0x47302c, 0x47ccf4, 0x49dcc8, 0x49de88, 0x4e41ec, 0x4e43a4, 0x4e5f50, 0x4e92bc, 0x51402c,
  0x5140e4, 0x514358, 0x514410, 0x5148b4, 0x51496c); 6 roster-size checks (0x17eda0 room < 70, 0x1849d4 add < 70,
  0x1f1360 over 70, 0x2529ec full >= 69 -> 99, 0x5045b8 offseason cut > 70, 0x50217c free-slot loop) -> 100; the
  "COMMON TEAM MANAGEMENT MODULE" (0x46e34c) six per-player arrays (12/14/27/4/2/2 B x 70, allocation = +8 header,
  init length) -> x100. Not patched (known limits): the .team package PLAY max 70 (creation site still unknown; the
  member's own team must stay <= 70 until found), CUTP 70 / PINP 840 in the package, the 70-cap on player heads
  (0x1107ca4, 0x188-byte entries), 0x4848dc (byte field vs 70, unclear), the recruiting UI 70-slot lists.
  ELF ...-roster100.elf re-baked with both entries: sha256 2b6ec50b...5134, 931 writes.
- Test vehicle: `ncaa-bridge od players --did 8 --team "Abilene Christian" --fill 100` queues 31 generated reserves
  (copies of the team's own players by position, ratings 40, free jersey numbers from 0, PYEA cycling) as
  DynastyPatchSet.createPlayers (PlayersMemo in od-state, published by the watcher, cleared when the console's upload
  carries them by team + last name). A stride-100 team fills 99 slots (one-slot margin as
  with 69 of 70); the fill is bounded by the team's free slots (a transfer keeps his old team's PGID). Queued for DID 8:
  Abilene Christian 65 -> 99 (34 reserves, PLAY 8725/13000).
  Procedure: enable BOTH roster entries in RPCS3 first (the team-management arrays overflow otherwise), then queue the
  fill, hub -> load coach1 -> ACU roster shows 100 -> play vs ACU (70 dress) -> advance.

## 2026-11-06 — cut week to 90 (Eric: 90 in season, up to 100 in the offseason, Cut Players trims to 90)

- The capacity entry is regenerated with `--cut 90` (101 words, installed in both patch files, Enabled in RPCS3;
  ELF ...-roster100.elf re-baked: sha256 e894bce8...66d4, 933 writes; 8 node tests pass). Words: 0x5045b8 cut-stage
  trigger `cmplwi r3,70 -> 90`; 0x5031ac auto-cut keep `li r22,70 -> 90`; 0x266710 GetMaxTeamRosterSize stub
  `li r3,70 -> 90`; 0x1f1360 roster-management cut state -> 90; 0x17eda0 / 0x1849d4 / 0x2529ec roster-editor
  room / add / full -> 90 / 90 / 89; 0x50217c free-slot loop stays 100.
- How the cut week works (0x5047c8 -> 0x5041e4, strings "Holding Team Tryouts", "Evaluating Players", "Cutting
  Players - 0%"): CLST (cut list, a permanent dynasty table: 0/13230 in file 326) is filled per team type; per team the
  CLST rows in the PGID range (or MCTP = team) are counted; > 70 -> 0x502cf8: per position group (0..16) the quota from
  the coach-style tables (r14/r15 styles x 17 groups, two tables at r16/r17) is kept best-MIOP-first (rows deleted from
  the list), then the remaining list ordered by MIOP desc is kept until r22 = 70 - (K/P keeps) players stay; whatever
  is still listed is cut by 0x502a30 ("delete from CLST"). <= 70 -> 0x502bd4 just clears the team's list. User teams go
  through the same loop (no user check in it); the online cut UI goes through DoD 127 checkCutPlayer / 128 cutPlayer,
  which the stub answers generically.
- Script bindings (registered by `0x56d39c(class, name, "AdapterExtObject")` wrappers at 0x87xxxx-0x8dxxxx; the thunk
  after each wrapper calls a vtable slot on a global adapter object; adapters are created by 0x2db0d8): TeamAdapter
  (ctor 0x265774, vtable 0x189ee48, global 0x1c793f4): +0x3c GetMaxTeamRosterSize = 0x266710 `li r3,70; blr`.
  RostersAdapter (ctor 0x2cb194, vtable 0x189e740): +0x8 GameCutPlayer 0x2cb2ec, +0xc GameCheckRosterCutState
  0x2cb334 (dynasty: 0x48fefc position minimums; otherwise 0x1f132c POCH count > 70). DynastyAdapter (ctor 0x2494a0,
  vtable 0x189a750): +0x230 CanAdvanceToOffseason 0x250ad8, +0x174 CutPlayers_SaveChanges 0x24f2a8, +0x190
  AdvanceToPreseasonRecruiting 0x24f454. DynastyRecruitingAdapter (ctor 0x279f20, vtable 0x189b4b8): +0x8
  GetNumScholarshipsRemaining 0x27a1a4 -> 0x4b972c = 0x4b7ebc(team) - count(RCPR where MCTP = team);
  0x4b7ebc = {25,15,10,5,0}[TEAM.SDUR] (0x474fd4; SNCT/SDUR are sanction fields set by 0x47bf8c/0x47c190/0x4f84c0)
  minus the year's TRAN rows in the team's range (dynasty only). So recruiting is 25 per class, not roster-bound.
- Not found: the `.team` package builder's per-table allotments (0x338c9c "Uploading Team Data for %s": a 50,000-byte
  DB filled via a virtual on the object looked up into 0x1c88d7c; PLAY 70, DCHT 91, CUTP 70, PINP 840, CAMW 200, PLSU
  50, TRAN/PLSS 23, PINT 65, RECB/RECV 35, RCPR/RCPT 25, USDT 16 appear nowhere as literals or descriptors; 0xa39768
  with "140 rows" was the Ultimate Team command constructor, not a table creator). Next test: a member team above 70.
- Tooling: scratchpad roster/cut-info.py (strings, fn, raw, callers) and cut-info2.py (after, bind = strings incl.
  SQL placeholder bytes with code refs and binding tables, tiny, vt, adapter, resolve, ctorvt, vslot, vslot2, opdrefs,
  impl). Binding wrappers use `addic` (opcode 12) for string addresses, so string-ref scans must accept 12 and 14.

## 2026-11-06 — checkpoint 2 re-pointed to Georgetown; Duquesne stop-gap uniforms

- Eric had already played Abilene Christian (checkpoint 1) and Duquesne (next opponent) crashes the game loader, so
  the generated reserves moved to Georgetown: `od players --did 8 --clear`, then `--team Georgetown --fill 100`
  (29 reserves, 70 -> 99, PGIDs 8370..; patch base = console file 326, the console's current file; files 327/328 are
  the earlier ACU copies, 328 was downloaded once). dod.mjs holds a new copy for the same base until the console comes
  back through the hub, so the Georgetown copy is taken at the next hub load.
- Duquesne (TGID 10) sits on TEAM.CSAT `BALLST`; the mod's archive XML for that slot (entry #3256) is a one-row
  "Coming Soon" placeholder (FCSXXX_HELMET_2042_BLUEX / JERSEY_2042_TEA / PANTSX_2042_GREEN from FCS_DLC_CAA, all
  present and well-formed; generic socks/shoes in the archive) with no Home/Away rows, which is what crashes. Same
  shape for 10 other slots (Central Connecticut NILLIN, Davidson WYOMIN, Drake BOISES, Long Island TOLEDO, Merrimack
  EMICHI, Presbyterian HAWAII, Richmond NMEXST, Sacred Heart CMICHI, Saint Francis WMICHI, St. Thomas UNLVXX). The
  slot report (scratchpad roster/all-slots.mjs over teams-dump.mts: XML source, rows, unresolved bigfiles by DLC name
  or archive FNV-1a hash) also lists sets with missing gloves/socks (Cal Poly, FAMU, Maine, Mercer, Penn, Wofford,
  Western Carolina, Nicholls, UND, NDSU, SEMO, Illinois State, Incarnate Word, Montana, SDSU, UNI, The Citadel) —
  not known to crash, but worth a look if one does.
- Fix applied: `spike/blaze/tools/uniforms/make-stopgap-xml.mjs BALLST` wrote `BALLST_Pack0_MixAndMatch.XML` (a copy
  of the Wagner stop-gap: D1AANW 2007 art, Home/Away rows) into FCS_DLC_NEC and beside the Wagner/Tuskegee XMLs.
  Not yet seen in game. The PS3 and every member's install need the same file.
- CHECKPOINT 2 IN-GAME PASSED (Eric, 2026-11-06 evening): with both roster entries on, the console loaded copy 330
  (file 326 + 37 Duquesne and 29 Georgetown reserves), showed Duquesne at 99, and Eric played and completed the
  Duquesne game with no issues (70 dressed from a 99-man roster; the BALLST stop-gap XML loaded too). The advance
  and the upload after it are the remaining half (do the reserves survive the console's own save?).
- CHECKPOINT 2 PASSED IN FULL (2026-11-06 17:02): the advance after the Duquesne game went through and the console's
  upload (file 333, week 8, stride 100) carries Duquesne 99 and Georgetown 99 players, PLAY 8760/13000 (8694 + 66
  reserves, max kept). 331 = the own-team package (PLAY 69/70, unchanged shape), 332 = a 3.8 KB non-zlib upload.
  So: dynasty capacity 100 (99 slots), 70 dressed, console round trip intact. Open: the own-team package above 70,
  the Cut Players week at 90 (needs an offseason), the site/bridge 90-limit for portal moves.
- CHECKPOINT 3 PASSED (Eric, 2026-11-06 ~17:30): Holy Cross (his own team, TGID 18) filled 69 -> 90 through copy 335;
  he played Georgetown and advanced with no issues. Upload 338 (week 9) keeps Holy Cross 90 / Duquesne 99 /
  Georgetown 99, PLAY 8781/13000. The own-team package (336) came out PLAY 70/70: the builder fills its 70-row table
  and drops the rest without failing the upload, so a member above 70 costs nothing (the dropped rows are the
  undressed slots; see package-play.mts in the scratchpad for which ones). The 90-in-season model is therefore
  usable now; the Cut Players week at 90 is the last untested piece (needs an offseason).
- CORRECTION (2026-11-06 17:45): checkpoint 3 did NOT pass cleanly. The upload after the Georgetown game (file 338)
  shows Holy Cross at 90 rows, but 20 of the original players are GONE (1800-1802, 1805-1807, 1809-1810, 1851, 1853,
  1854-1863; Swanson the starting QB among them) and 20 exact copies of the reserves at slots 70-89 (Res02..Res21)
  appeared under ids allocated in other teams' free ranges (8762-8780 = Eastern Washington 62-80, 269 = Howard 69).
  24 depth-chart rows pointed at the missing players. Duquesne and Georgetown (CPU, 99) were untouched, so it is a
  user-team path. The own-team package 336 (uploaded 22:22:11 UTC right after the game) already holds exactly the 70
  survivors (all 21 reserves, 49 originals); the console's PLYZ push at the same second still carried 1800-1889 intact.
  Working theory: the package builder's 70-row PLAY table wraps/overwrites when fed 90 rows, and the advance's "Checking
  for team data" step reconciles the dynasty roster to the own team file it downloads back (rows missing from the
  package deleted, rows at slots >= 70 re-created under new ids). Repair: `od repair --did 8 --tgid 18 --from 333`
  (new: tdb removeRecord on indexed tables, addPlayer with an explicit pgid, DynastyPatchSet.removePlayers, RepairMemo)
  published a copy of 338 with the 20 rows restored under their ids (every PLAY field from 333) and all 41 reserve rows
  removed: Holy Cross 69, DCHT 0 dangling, Duquesne/Georgetown untouched. RULE until fixed: no user team above 70.
- ROOT CAUSE CONFIRMED + SERVER FIX (2026-11-06 18:10): the capture shows the sequence: 22:22:10 locker upload of
  the own .team package (336, 70 rows: the first 20 rows of the 90-row roster in file order were overwritten by rows
  70-89 — a 70-slot table filled modulo 70), 22:22:11 PLYZ push with all 90 rows intact, EndDynastyUpdate UPDT 1 FID
  336, 22:22:27 RequestAdvanceWeek, 22:22:28 the console DOWNLOADS 336 back ("Checking for team data"), 22:23:08 the
  dynasty upload with the 20 rows gone and the 20 beyond slot 69 re-created under new ids. So the advance reconciles
  the dynasty to the downloaded own package. Fix in the stub: spike/blaze/server/team-package.mjs
  (completeTeamPackage: unwrap the .team blob = zlib of a 50,000-byte DB with no prefix, grow PLAY to 100, append the
  rows the roster push names but the package lacks from the dynasty file the console is on, serialize padded to
  50,000, re-deflate; packages/tdb/dist imported directly), hooked in dod.mjs EndDynastyUpdate UPDT 1 (fixTeamPackage:
  d.rosterPush[team] = the PLYZ push's PGIDs captured in applyTableUpdate; fallback = every row of the team in the
  dynasty file), blob replaced in place (locker.mjs readContentBlob/replaceContentBlob). Budget: 45,220 + 30 x 116 =
  48,700 < 50,000. node --test spike/blaze/server/team-package.test.mjs replays 336 + 335 + the push: 70 -> 90 of 100,
  ids = the push exactly. NEEDS a league-server restart (restart-league.cmd) while the console is out of the dynasty,
  then a re-test with a small overage (fill 73, play, advance) with `od repair` ready.
- CHECKPOINT 3 PASSED WITH THE SERVER FIX (Eric, 2026-11-06 18:50): league server restarted with team-package.mjs,
  Holy Cross filled 69 -> 73 on top of the repair (copy 341), game vs Fordham played (first attempt died with a Vulkan
  VK_ERROR_DEVICE_LOST in the RSX thread while the game loaded; the retry played through — treated as the driver) and
  the advance went through. Log: package 342 uploaded with 70 rows, PLYZ push 73 rows, "team package 342 (team 18)
  completed from dynasty file 341 and the 73-row roster push: PLAY 70 -> 73 of 100", the console downloaded the
  completed 15,112-byte package at 23:49:37, upload 344 (week 10) keeps Holy Cross 73 (lost 0, gained 0, none outside
  the range, DCHT 0 dangling) and the package carries exactly the upload's 73 ids. Bridge: the repair memo is one
  batch (cleared once the console's file lacks any removed id; ids reused by later fills no longer count as "still
  there"). Open: a user team at 90 for a full week (73 is the only data point), the Cut Players week at 90 (offseason),
  the other members' installs (both patch entries, the stop-gap XMLs, the server fix is central).
- MEMBER TEAM AT 90 PASSED (Eric, 2026-11-06 19:21): Holy Cross 73 -> 90 (copy 346), game vs Colgate (144@18 27-31)
  played, advance to week 11. Log: package 347 uploaded with 70 rows, PLYZ push 90, "team package 347 (team 18)
  completed from dynasty file 346 and the 90-row roster push: PLAY 70 -> 90 of 100", the console downloaded the
  completed 16,245-byte package, upload 349 keeps Holy Cross 90. The in-season model (90 on a member team, 99 on CPU
  teams, 70 dressed) is now exercised end to end; the Cut Players week at 90 (offseason) is the last untested piece.

## 2026-11-06 — FCS2026 roster save rebuilt at up to 90 per team

- FCS/Rosters tools grew: `grow-control` (STABLEV1 -> 2026/control/USR-DATA: stride 100, teams padded to
  min(90, scraped) with "Open Slot" copies of their own rows, rows re-sorted so each team is contiguous, padded to
  0x1c0000), env overrides ROSTER_CONTROL_USR / _FILE_LENGTH / _DB_SIZE / _ROWS_PER_TEAM / _PGID_STRIDE /
  _CONTROL_CSV_DIR (control.ts, validate.ts, ratings.py, body.py, faces_common.py), per-team row counts <= 90, the
  match-rate gate over the rows that had a 2025 player. rekeyStride now re-keys PLAY.POID too (106c629).
- Result: 126 teams assigned (the same ten low-match allowances as the 69-man build), 11,288 rows with a 2026 player,
  123 teams at 90 (Miss Valley State 78, UTRGV? no: TGID 34 at 89, Saint Francis 69), 18 untouched 2025 rows, no
  "Open Slot" left, no staff names (the 83 names flagged as coach leaks are real players scraped twice), ratings for
  11,216 rows, 4,272 faces, 3,701 body rewrites, verify ok (11 warnings). Installed over the RPCS3 FCS2026 save
  (69-man copy backed up in %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-06-roster70); 69-man plans in 2026/_prev-70.
  UNTESTED in game: Rosters -> Load Roster -> ROSTER-FCS2026 with the patches on, then a throwaway dynasty + advance
  (the roster-save path at stride 100 / 0x1c0000 is the one remaining untested piece of the roster project).

## 2026-11-06 — FCS-online.exe (installer/)

- Node SEA single executable (91 MB: node.exe + a 2.5 MB bundle + the payload): `node installer/build.mjs --roster
  <save folder>` -> installer/dist/FCS-online.exe (copy at Desktop\FCS\FCS-online.exe). Modes: join / roster / host /
  status, flags --rpcs3 --server --rpcn --project --yes. The payload (patch entries from private/rpcs3-patches.yml,
  the three stop-gap XMLs, the FCS2026 save) is generated at build time into installer/generated (gitignored).
- Member setup it performs: patch entries merged by name into patches/imported_patch.yml and enabled in
  config/patch_config.yml (CRLF preserved, backups *.bak-<stamp>), XMLs into USRDIR\DLC\FCS_DLC_NEC, custom config
  Net = Connected / RPCN / IP swap "gosredirector.ea.com=<server>&&*.ea.com=<server>", rpcn.yml Host. It cannot create
  the RPCN account (RPCS3 GUI) or run the league server without a checkout (host mode starts league.mjs from one).
- Tests: a copy of the real config tree (entries "already current", no duplicate blocks, CRLF kept, RPCN host set),
  an empty fake install (files created, DLC/custom-config warnings), the real install read-only (all enabled).

## 2026-11-07 — Rosters screen drops players past row 9,100: the mode databases' PLAY template, and the fix

- Symptom: the 90-man ROSTER-FCS2026 save loads, but every team whose rows sit past physical PLAY row 9,100 (Abilene
  Christian 9347.., Colgate, Wofford, Central Arkansas, Chattanooga, ...) shows an empty roster; Holy Cross (rows
  1518..1607) is fine. The file is correct (11,306 rows, PLAY max 13,000, all ids in range).
- Mechanism (static RE of the EBOOT): a roster file is opened as the 'LEAG' database with its own table sizes
  (0x21be68: 0xa5da0c image load, 0xa59230 register). Each game mode builds its own database from templates in the
  standard-data database 'STDA': 0x44768c walks STDA's table list and 0x447320 runs "use 'ADTS' select into
  <db>.<table> * from <table>" per table, so ROST (Rosters screens, 0x4f3ff0 / 0x4f4540), DYND (dynasty, 0x4f5d40 /
  0x4f7fa0) and EXHI (Play Now, 0x4f0818 / 0x4f0a64 / 0x4f1248) all get the template's capacity; PLAY's is 9,100
  (130 x 70; every game-written save shows PLAY max 9100). The mode database is then filled from LEAG team by team
  (0x4f3d88 -> 0x4e9984 -> 0x44a6f0, record copies through 0xa58bdc / 0xa58c44 / 0xa593b0 per the table map at
  0x1c867bc) and the copy silently stops once the mode PLAY table is full. The roster save buffer (0x1c0000) was not
  the limit: the stride entry already set it and the 1,835,008-byte file loaded.
- Table struct (DB library, 0xa4f000-0xa6b000): +0 name (4CC as in SQL text, PLAY = 0x59414c50 'YALP'), +4 max records
  (u16), +6 field count, +8 owning DB (DB +0x1c byte 1 = read-only / asset DB), +0xc record length, +0x10 next table,
  +0x24 record storage, +0x30 flags, +0x4c grown maximum, +0x4e/+0x50/+0x52 counts. 0xa51750(db, name) finds a table,
  0xa56dbc(table, rows) resizes it: refuses read-only DBs (0x1f), malloc when max == 0 else realloc(rows x length),
  stores rows at +4 and +0x4c, returns 0 / 2 (allocation failed). The game itself uses it before bulk copies
  (0x3046e4: grow destination to src+dst rows, then "insert into X * select * from Y").
- Fix = third entry **"FCS mod: 100-player rosters (player table)"** (roster-table-patch.py, 23 words): 0x4473bc's
  `bl 0xa694c4` (clear the copied table's read-only flag) now calls a 22-word routine that performs that call, then,
  when the table's name is 'YALP', calls 0xa56dbc(table, 13000). So every template-built PLAY table (ROST, DYND, EXHI,
  anything else built through 0x447320) holds 13,000 rows; other tables are untouched. The routine sits in two runs of
  inter-function padding of .text: 15 x "b ." at 0x13b4b40 (between a blr and the next prologue) and 7 of 11 nops at
  0x16367a4; the generator proves both are padding (filler words only, no branch / data pointer / lis-addi reference
  into the run, a function end before, a prologue after). A first attempt used a zero-filled stretch of the segment's
  read-only data (0x171f940): the ELF does have section headers and that stretch is in a non-executable section, so
  RPCS3's analyser might not have compiled it; .text padding is safe on both platforms. Indexes are created after
  the copy (0x4f237c), so they size to 13,000. Memory: +437 KB per mode database.
- Installed and enabled in RPCS3 (backups in %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-07-player-table),
  private/rpcs3-patches.yml then 956 words in six entries, ps3-eboot.mjs `--roster-table` (test 9/9), ELF
  `private/BLUS31159-1.02-allconf-commissioner-jersey0-roster100-table.elf` (956 writes; sha in its manifest).
- Why dynasties were never affected: the online dynasty file is loaded as an image (its tables keep their own sizes),
  so a re-keyed 13,000-row file survives; only databases *built from the templates and filled by copy* were capped,
  which is exactly the Rosters screens and a dynasty *created* from a roster.
- UNTESTED in game (next): Rosters -> Load ROSTER-FCS2026 -> late teams (Weber State, Marist, ACU, Chattanooga) at
  90; save the roster to a new slot and read it back with the bridge (PLAY 13000 / 11,306 rows); start an offline
  dynasty from it and check a late team; then a new online dynasty from the 90-man file.

- 2026-11-07 (later): v1 did NOTHING in game. RPCS3.log shows the entry applied (23 words) and the FCS2026 USR-DATA
  read in full (bufSize = fileSize = 1,835,008), yet Weber State and later stayed empty; Portland State (rows
  9077..9166) is the expected 23-player straddler. The insert path checks the same field the resize sets (0xa56f94:
  reuse a free-list slot, else +0x4e < +4, else 0x13 "full"), so a resize that runs does lift the cap: PLAY of ROST
  therefore does not come through the template copier 0x447320 (it must come with the ROST database's own game data).
  v2 (same entry name, Patch Version 2.0, 35 words) grows PLAY in the finished database instead, right before its
  indexes are built and the roster is copied in, wherever the table came from:
  `0x4f417c bl 0x4f237c` (Rosters builder: create ROST indexes) and `0x4f5e9c bl 0x4f4e44` (new-dynasty builder: PLAY
  index prep before the DYND indexes) now call 5-word stubs (r3 = 'ROST'/'DYND', r11 = original callee) that enter a
  shared routine: FindTable 0xa57d68(db, 'YALP'), skip if missing or already >= 13,000, else TableResize 0xa56dbc(t,
  13000), then restore the frame and tail-call the original callee through CTR (both callees load their own r3). Code
  sits in the only four provably unused padding runs of .text (0x13b4b40 x15, 0x16367a4 x11, 0x1678cec x5, 0x69a9fc
  x5; `padscan` criteria in the generator). Play Now (EXHI, 0x4f0a64 -> 0x4e9984 with all teams) fills the same way
  and is NOT covered: no padding left for a third stub. Installed (968 words in six entries), ELF re-baked, tests 9/9.

## 2026-11-07 — player-table v2 PASSED in the Rosters screens; offline dynasty from the 90-man file crashes

- v2 confirmed by Eric: every late team (Portland State, Weber State, Marist, ACU, Chattanooga) shows its full roster.
  Saving to a new slot (TEST90MAN1) wrote all 11,306 rows (PLAY 11306/13000); the game also re-saved the FCS2026 slot
  with identical bytes (sha 29bbd955…), so the original build lives only in FCS/Rosters/2026/out now.
- New offline dynasty (Portland State) from TEST90MAN1 froze at "generating recruits":
  `F {PPU[0x1000030] Thread () [0x00f68920]} VM: Access violation reading location 0x265db9ec`. Stack: 0x691c0c <-
  0x1fae94 <- 0x1f4f68 <- 0x44c4d0 <- 0x505b54 <- 0x50554c <- 0x5050e0 (offseason "Rating Teams - %s" stage 0x505010)
  <- 0x4b685c (RecruitPrefMan::RecruitPrefManUpdatePlayTimePitchValues 0x4b6328) <- 0x47d39c/0x47d278 (destroy the
  play-time containers, first free = the node pool) <- 0x14635a4 <- 0x4345c8/0x434168 (heap: which sub-heap owns the
  pointer) <- 0x1465a08 -> 0xf68918 (sub-heap object +0x8fc holds garbage). So the heap was overwritten earlier.
- Play-time containers (0x47e6f4 -> 0x47e468(obj, 126 teams, 17 position groups, 70 | 35)): obj+0x10 = 126 team
  pointers, +0x14 = 126 x 17 list heads, +0x18 = node pool of 126 x 70 = 8,820 eight-byte nodes, +0x1c = used. The
  insert 0x50de60 is bounded (used < a x c), so players past 8,820 are silently skipped, not overflowed; list heads
  are written unchecked at team x 17 + group (group from a virtual position mapper on the object at 0x1c88d90, not
  resolvable statically). The four recruit-module divisions the stride entry changed (0x47cf84, 0x47e224, 0x47ee58,
  0x47ef00) only turn a PGID into a TGID (no remainder), and the roster-needs pass 0x4810a0 bounds its per-player
  writes (0x481488). Not found statically.
- Data: PPOS 24 (long snapper) exists in every FCS roster (STABLEV1 19, 69-man FCS2026 68, 90-man 144); PYEA 0..3,
  PRSD 0/2 as stock.
- Bisect control installed: slot ROSTER-TEST69 = the 69-man FCS2026 build re-keyed to stride 100 (`roster grow
  --stride 100 --allow-oversize`, 8,694 rows, PLAY max 13000, padded to 0x1c0000; scratchpad make-save.py clones a
  slot's PARAM.SFO / HED-DATA / ICON0). A dynasty from it separates "dynasty creation under the patches" from "90-man
  teams / more than 8,820-9,100 players".
- TEST69 result (Eric): dynasty created, recruits generated, advanced to week 1, no crash. So dynasty creation under
  the stride + capacity + player-table patches is fine; the crash needs bigger rosters. The crashing worker thread
  (id 0x1000030, created 0.35 s before the fault by FGGameSim) runs 0x505a7c: 0x4af390 (recruiting indexes only),
  then 0x505484 -> 0x505010 "Rating Teams" -> Play Time (0x4b6328) -> crash in the first free. RPCS3's dump shows the
  heap-set object (r30 in 0x4340f4) starting with 0x00002274 = 8,820 = the play-time node-pool count word, i.e. the
  heap's own bookkeeping already overlapped a block the pass allocated: corruption before or inside this pass.
- With <= 70 per team, 126 teams can never exceed 8,820 = 126 x 70 players, so a vanilla buffer sized 126 x 70 is
  always big enough; 90-man rosters break that. 8,820-row sizes found so far (all hazards for 90-man leagues):
  play-time node pool (0x47e7d8 li r6,70; bounded insert, extra players skipped), RCTN table max 8,820 filled by
  "Training Players" 0x4934c8 (`insert into RCTN * select * from PLAY` at 0x493544, offseason), graduation
  0x4835a8 sizes table 'ELMT'/TMLE to 8,820 rows via 0xa57ce0 at 0x48368c (offseason).
- Next control installed: slot ROSTER-TEST5X90 = TEST69 plus slots 69..89 of Holy Cross, Portland State, Weber State,
  Abilene Christian, Chattanooga copied from the 90-man file (all PLAY fields), rows re-sorted by PGID: five 90-man
  teams, 8,799 players (< 8,820). Crash -> a per-team > 70 overflow; no crash -> a total > 8,820 overflow.
- TEST5X90 result (Eric): dynasty created and advanced to week 1, no crash. So per-team size above 70 is fine; the
  crash needs a league total above 8,799 (the 90-man file has 11,306). Ruled out statically since: the play-time
  containers (both use the bounded insert 0x50de60; the second holds recruit-board entries), the TEAM DATA
  MANAGEMENT MODULE id lists (0x44968c, sized from the live table maximum), the 0x47cf84/0x47e224/0x47ee58/0x47ef00
  divisions (PGID -> TGID only). Index inserts (0xa53a7c) take nodes from a virtual pool and fail with 2 when it is
  empty; whether that pool is sized at index creation is not established.
- Threshold slots installed (TEST69 + slots 69..89 copied from the 90-man file, rows sorted): ROSTER-T8841 (7 teams at
  90, 8,841 players, just over 126 x 70 = 8,820), ROSTER-T9039 (17 teams, 9,039, over 128 x 70 = 8,960 and 9,000,
  under 130 x 70 = 9,100), ROSTER-T9207 (25 teams, 9,207, over 9,100). Order: T9039 first; crash -> T8841; pass ->
  T9207.
- T9039 and T9207 PASSED (Eric): the limit is above 9,207 players, or the cause is in data the mixes did not carry.
  Field-range comparison of the 90-man file against TEST69: only stray single ratings and 76 jersey-#0 extras (T9207
  passed with 32 of them). The real 90-man file differs from "TEST69 + every team's extras" only in PLAY (other
  players in slots 0..68: the 90-man build re-assigned them) and TEAM (team ratings TROV/TROF/TRQB/... that the game
  recomputes on save); DCHT and every other table are identical.
- Next slots: ROSTER-T11306 (TEST69 + slots 69..89 of all 126 teams = 11,306 players, same total as the crash) and
  ROSTER-T10256 (75 teams, 10,256). T11306 crash -> a count limit between 9,207 and 11,306 (then T10256); T11306 pass
  -> something in the 90-man build's own slot 0..68 players.
- T11306 PASSED (Eric): 11,306 players, every team at 90 except the three short ones, no crash. So neither the total
  nor per-team size is the trigger. T11306 and the crashing TEST90MAN1 are structurally identical (header, table
  order and headers, PLAY sorted by PGID, POID == PGID, no duplicate ids); they differ only in which players fill
  slots 0..68 and in TEAM ratings the game recomputes on save; per team/position counts match within a player or two.
- The crash session differed in procedure, not data: Eric browsed late 90-man teams in the Rosters screen and SAVED
  the roster (the game wrote FCS2026 and TEST90MAN1, 1,835,008 bytes each) before creating the dynasty; the test runs
  only loaded a slot and created a dynasty. Next: (A) load T11306, view Portland State / Weber State rosters in the
  Rosters screen, no save, create a dynasty; (B) load T11306, save to a new slot, create a dynasty.
- Procedure ruled out (Eric): T11306 + viewing 90-man rosters, and T11306 + saving, both PASSED; TEST90MAN1 CRASHED
  again at the identical point (same thread entry, fault reading 0x265db9ec, same registers): deterministic and tied
  to the 90-man build's own players in slots 0..68. Long snappers (PPOS 24) appear on the low teams in both files.
- Team bisect, round 1: ROSTER-HQ1..HQ4 = T11306 with TEST90MAN1's rows (by PGID) for TGID index ranges 0-31 (TGID
  1..32), 32-63 (33..64), 64-94 (65..95), 95-125 (96..235). Scratchpad hybrid.mts builds them.
- Round 1 result (Eric): HQ3 (TGID 65..95) CRASHED at the identical address; HQ1, HQ2, HQ4 passed. Same players
  (names, positions, years) sit at the same PGIDs in both files; the 90-man build re-rated them, so the trigger is a
  rating difference. Values in TGID 65..95 never seen in any passing data: 7514 Jake East SS PTHA 2, 7765 Stephon Hicks
  LOLB PBTK 13, 9149 Diwonne Williams LOLB PBTK 13, 7952 Kauna'oa Kamakawiwoole QB PJMP 34.
- Round 2 slots: H3A (TGID 65..72), H3B (73..80), H3C (81..88), H3D (89..95), and H3X = HQ3 with only those four
  values set back to T11306's.
- Round 2 (Eric): H3X CRASHED (the four rating outliers are not it); H3A (TGID 65..72) CRASHED; H3B..H3D not needed.
  In 65..72 the two builds differ beyond ratings: 48 slots hold a different player (PFNA/PLNA, PPOS 37, PYEA 39,
  PJEN 49, PHGT/PWGT, PRSD 9, body BS* fields). DCHT is the 69-man build's in both files; out-of-position depth rows
  per team are similar in both files (20-27), and K/P/QB/LS counts are normal, so no obvious data anomaly.
- Round 3 slots: ROSTER-T65 .. ROSTER-T72 = T11306 with one team each from TEST90MAN1 (Mercer, Central Connecticut,
  Youngstown State, Robert Morris, Delaware State, Northern Iowa, Columbia, Harvard).
- Round 3 (Eric): T65, T66 passed; T67 (Youngstown State) CRASHED at the identical address. In TGID 67 only one slot
  holds a different person: PGID 6734 = Nate Boozer, LS (PPOS 24), senior, POVR 75, #44 in the crash file (WR Aidan
  Stephens in T11306); the rest are re-ratings. Boozer is the league's highest-rated long snapper (75); every passing
  file topped out at 74 (T11306: 640 John Blankenship 74).
- Round 4 slots: V67OVR (T67 with Boozer POVR 75 -> 70), V67TE (T67 with Boozer PPOS 24 -> 4 TE), V640LS75 (T11306
  with Blankenship's POVR 74 -> 75, a different team). Expect V67OVR/V67TE pass and V640LS75 crash if "an LS rated
  75+" is the trigger.
- Round 4 (Eric): V67OVR (Boozer stored POVR 70) CRASHED, V67TE (Boozer as TE) PASSED. ROOT CAUSE found in the dump:
  the allocator pointer the free path followed (0x132f3a28) holds "00 01 13 c1 1a 4e 4b 03" = a play-time list node
  for PGID 0x1a4e = 6734, OVR 0x4b = 75, year 3, and its index in the node pool ((0x132f3a28 - 0x132e7fe0) / 8 =
  5961) is Boozer's physical row. The list insert 0x50de60 writes heads[team][group] without checking the group, and
  the virtual PPOS -> group mapper (object at 0x1c88d90, slot +0x14) returns something outside 0..16 for PPOS 24 (the
  FCS mod's long snapper, absent from stock rosters). Every LS among the first 8,820 players makes one stray pointer
  write; most land on harmless memory, Youngstown State's lands on the heap record. Not a 90-man bug: any FCS roster
  with LS players carries the same latent corruption in Play Time, roster needs (0x4810a0), 0x4c3e38 and 0x500348.
- Fix = new entry "FCS mod: long snapper recruiting fix" (spike/blaze/tools/ls-group-patch.py, 23 words): the
  24-word leaf 0x50de60 rewritten in place (cmplwi r5,17; bgelr up front; pool check kept; redundant clrldi dropped;
  heads table loaded once). Both callers (0x50e030, 0x50e264) build 17-group containers (li r5,0x11 at 0x47e7d4 /
  0x47e89c) and ignore the result; readers already skip groups >= obj+8. Installed + enabled in RPCS3 (backups
  2026-11-07-ls-fix), mirror 991 words in seven entries, `ps3-eboot.mjs --ls-group` (10 tests), ELF
  private/BLUS31159-1.02-allconf-commissioner-jersey0-roster100-table-ls.elf (991 writes).
- Long snapper fix CONFIRMED (Eric): TEST90MAN1 and FCS2026 both create an offline dynasty, generate recruits and
  advance to week 1. 90-man rosters now work in the Rosters screens and new dynasties.

## 2026-11-07 — 8,820-player limits in the offseason: entry "FCS mod: 100-player rosters (offseason)"

- 126 teams x 70 caps a stock league at 8,820 players, so passes sized for that never fail in stock play; a 90-man
  league holds ~11,300. Fixed in spike/blaze/tools/roster-offseason-patch.py (10 words, no overlap with the other
  entries, installed + enabled 2026-11-07, mirror 1001 words in eight entries, `ps3-eboot.mjs --roster-offseason`,
  11 tests, full ELF private/BLUS31159-1.02-full-roster100.elf):
  1. Training Players (0x4934c8): `insert into RCTN * select * from PLAY where PTYP != 3` into an 8,820-row RCTN (the
     size is in every dynasty file); on failure 0x493828 skips training and zeroes the progression fields, i.e. no
     player would progress. 0x49353c..0x493558 now call the game's grow-then-copy helper 0x3046e4(dest 'NTCR', src
     'YALP') (count both, 0xa56dbc dest to the sum, insert all, current database = the dynasty; 0xa517f4(0) returns
     the top of the use stack) and `cmpw r3,r3` replaces the error check. RCTN is read back only by PGID for the old
     overall (0x2239d8, 0x223f24); no PTYP 3 players exist in the dynasty files seen, so dropping the filter is harmless.
  2. Graduation (0x4835a8): temporary one-column table TMLE (PLAY.PGID descriptor via 0xa692e4) created with 8,820
     rows by 0xa57ce0 -> 0xa5790c at 0x48368c; now 13,000.
  3. Recruiting player lists (0x47e7d8): 126 x 70 -> 126 x 100 nodes (bounded insert; the pool is sized from these).
- Still not covered: Play Now (EXHI) copies all teams into a 9,100-row player table (no code space left for a third
  hook in the player-table entry). Untested in game: an offseason with 90-man teams (training, graduation, signing
  day, Cut Players to 90).
- Offseason PASSED (Eric): the FCS2026 offline dynasty (DEFAULT5, William & Mary) went through the offseason into
  year 1 with no issue. File check against the pre-offseason snapshot: 8,481 returning players (same name + team),
  7,841 improved, mean +2.63 OVR, 8,479 advanced a class year or redshirted; 2,943 of 3,283 seniors gone; 3,105
  freshmen; departed players parked on TGID 1023 (667). RCTN max is now 8,595 (= PLAY rows at training time), proof
  the grow-then-copy helper ran (only it resizes RCTN). Team sizes after: 71..92; 13 CPU teams at 91-92. Their
  newest slots are freshmen and every one of them took 2-3 portal transfers from other teams, which land after the
  Cut Players stage (the cut routines 0x502cf8 / 0x5041e4 / 0x503540 have every 70 constant patched and share the
  patched PGID range). Same mechanism exists at 70 in stock play; not enforced further.

## 2026-11-07 — dynasty player editor crash (Marist, slot 85)

- Eric: new offline Marist dynasty from FCS2026, edit the lowest-rated player (Blake Landry, LOLB, PGID 10485, slot 85)
  -> `F {PPU[0x1000015] Thread (FGGameSim) [0x00f6cdb0]} VM: Access violation reading location 0x38300030`.
- Stack: script binding 0x87c918/0x87c99c -> 0x250cbc (dynasty adapter: "Create A Player Manager", ctor 0x173e70)
  -> vtable +0xc = 0x17d5b8 (for each of 35 attribute ids at 0x1c72c24: count via vtable +0x64 (dispatcher 0x17a498),
  malloc count x 4, fill via vtable +0x54 (dispatcher 0x178284)) -> 0x177648 ("Year Name" list, attribute 13, the
  11th built) -> malloc 0x3f1974 -> heap internals (0x43c6c4 / 0x43b7cc / 0x437ef0 / 0x433f6c) -> fault. 0x38300030 is
  ASCII "80\0" "0" used as a pointer: a string pointer landed on heap metadata, i.e. one of the lists built before
  "Year Name" wrote past its array (ids 59, 2, 3, 4, 5, 7, 6, 8, 10, 9 in that order).
- Checked consistent count vs builder: 6 jersey (0x17a3b4 / 0x177c84, mask 0x483b1c by TGID, all 90 players),
  4 position list ("None" + 9 offense / + 3 other; count 10 / 4 / 1 locked), 2 primary position (loop bounded by
  count 21 / 12 / 1), 3, 5, 7 (bounded), 9 hometown (bounded; strcpy into malloc(31) per name and the player's own
  hometown at obj+0x1a, RCHT is game data). Not yet checked: 59 "Cas Uni Preset Name" (0x17654c; count = preset
  vector size via 0x1ed0b4/0x1ed9b4: team uniform data), 8 handedness (inline), 10 (0x177700). Side finding: with a
  locked position, attribute 2 looks up the name of the player's own PPOS (0xca768c), which for a long snapper (24)
  may index past a 21-entry name table.
- Landry's only out-of-stock value is PIMP 53 (stock 55..99). Next: in-game edits of Marist slot < 70 players
  (Sonny Mannino QB slot 29, Lawson Koch TE slot 52) to separate team-wide (uniform presets) from slot-dependent.
- ROOT CAUSE (not the 90-man rosters): a bug in my "FCS mod: jersey #0" 1.0. In the jersey-list count 0x17a3b4 the
  loop start `li r5,1` (0x17a3fc) is copied into r4 by `ori r4,r5,0` (0x17a404) and r4 is the 1 in `1 << bit` for both
  the free-number test and the own-number test. Patching the loop to start at 0 made that constant 0: every number
  tested as taken, the count was always 1, 0x17d5b8 allocated a one-entry jersey list and the builder 0x177c84 (which
  takes its constant from r30, untouched) wrote every free number into it -> heap overflow on EVERY in-game player edit
  since 2026-11-06; the editor also displayed (and on save stored) list[0], the team's lowest free number. Seen as:
  Landry freeze, Koch shown #17 then a crash on exit (0x68f574, a DataSourceFilter rebuild reading a string as a
  pointer), Mannino silently #12 -> #17. Eric's Mannino edit "worked" only by heap luck.
- Fix: jersey #0 1.1 adds 0x17a404 `ori r4,r5,0` -> `li r4,1` (0x38800001). jersey-zero-patch.py + ps3-eboot.mjs
  JERSEY_ZERO_WORDS (6 words), tests updated (base entries 45 words, base+jersey output sha 4c359d83…), RPCS3 entry
  replaced (backups 2026-11-07-jersey0-fix), 1002 words, full ELF re-baked (sha 6d3d1d29…). Checked while there: the
  locked-position name lookup 0xca768c indexes a 6-byte abbreviation table that includes LS (24) and 3DRB (25), fine.
- Consequence to tell members: any player edited in the in-game editor since the jersey #0 entry was installed may
  have had his number replaced by his team's lowest free number when the edit was confirmed.

## 2026-11-07 (evening): QA'd FCS2026 roster shipped

- The 90-man FCS2026 save got a QA pass in the roster builder (outside the repo; Rosters/2026/control/README.md):
  61 staff cards removed, #0 parsed, refreshed and position-assigned jersey numbers, every added player's skin tone
  checked by eye, and a name + team prior (Rosters/tools/src/faces/name_prior.py) for faces the photo cannot decide.
  USR-DATA sha 93a7e59d…, 11,305 PLAY rows.
- FCS-online.exe rebuilt with it (`npm run build:installer -- --roster <Rosters/2026/out/BLUS31159-ROSTER-FCS2026>`,
  8 entries / 1002 words, exe sha 5245be53…; copy at Desktop\FCS\FCS-online.exe, previous one .bak-2026-11-07).
- Site download replaced in place: R2 `ncaa-online-saves/downloads/FCS-2026-Roster.zip` (`wrangler r2 object put …
  --content-type application/zip --remote`; wrangler 4 writes locally without `--remote`). Same layout as before
  (save folder at the zip root) plus a README.txt saying the save needs the FCS-online.exe patches. No code deploy:
  the landing-page link is unchanged. The 69-man zip it replaced (USR-DATA 6acd554d…) is in
  %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-07-roster-download.

## 2026-11-07 — Coming Soon slots: Teambuilder placeholder sets

- FCS_Team_Library (Sooner Fan Sports Sim Network, 2022, 128 Teambuilder teams by old conference): each
  BLUS31159-TEAM-### USR-DATA is two DXT3 logos as DDS (256x256 wordmark, 128x128 helmet logo; Merrimack's 128 is a
  Nike swoosh) followed by an EA DB (TEAM, TUNI x2, COCH, CSKL, CAMD, STAD, SZIP, CITY, PLPS, PLAY, DCHT). TEAM.CSAT is
  CASXXX; no uniform art anywhere. TUNI is the recipe: colours as (tag << 24) | RGB (tag 1 primary, 2 secondary,
  0 custom, 0 = unused), CJOB/CJTB home/away jersey body, JOFP/JOFT and JTFP/JTFT number fill/trim, JONG/JTNG name,
  CHOF helmet shell (best guess), CPAC/CPAB pants; plus stripe/font numbers and chest text. The CAS templates the game
  draws them with are not under any name guessed in qkl_fe2ig.ast. Davidson and Drake (Pioneer folder) are still
  encrypted (only HED-DATA decrypted); St. Thomas and LIU (Sharks) are not in the library.
- `spike/blaze/tools/uniforms/make-coming-soon-sets.mjs` (installed today): CCSU NILLIN, Duquesne BALLST (replaces its
  Wagner stop-gap), Merrimack EMICHI, Sacred Heart CMICHI, Saint Francis WMICHI, Presbyterian HAWAII get
  SLOT_{HELMET,JERSEY,PANTSX}_2026_* sets cloned from FCSXXX_*_2042_* (scenes byte-identical to Hampton's apart from
  names), recoloured to TUNI with the logo on both helmet sides. Richmond NMEXST and LIU TOLEDO already had mod art in
  the DLC folders (RICHMO_* in PATRIOT, LIUXXX_* in NEC) with no XML; they get XMLs only. LIUXXX_HELMET_2020_BLUEX is a
  jersey (TENNES scene); copied as LIUXXX_JERSEY_2020_BLUEX. Davidson WYOMIN, Drake BOISES, St. Thomas UNLVXX: Wagner
  stop-gap in FCS_DLC_PIONEER. All bigfiles parse, hashes match, scene references resolve. Not yet seen in game. The
  distribution copy is `tools/uniforms/dist/coming-soon` (23 MB); every member and the PS3 need it.
- Same day, second pass: Robert Morris (TGID 68) sits on NOTDAM, whose archive XML is part types only (no parts, no
  officials); it gets a Teambuilder set (FCS Independents TEAM-003, navy/white/red). Davidson WYOMIN, Drake BOISES and
  St. Thomas UNLVXX now get the same placeholder set from school colours (sampled from the logos) and their ESPN logos
  (archive/logos/teams 2166/2181/2900), replacing the Wagner stop-gaps. All 12 slots' XMLs have Home and Away rows whose
  bigfiles exist. A scan of all 131 mapped teams found every Home/Away part resolvable once the `.ast.edat` DLC files
  (MVFC: SDSU, UNI, the Madden-named RUSH parts) and qkl_misc/qkl_patch are counted; four mod XMLs have no Home/Away
  rows at all: ETSU GEORST, Prairie View AUBURN, Yale TEXASX (no officials) and UAlbany BOSTON ("Black/Yellow").
  Not known to crash; untouched.
- Third pass: Stonehill (TGID 21) is on CLEMSO, Delaware's old slot; the archive CLEMSO_MIXANDMATCH still dresses it
  in Delaware's art (archive CLEMSO_* bigfiles, Home/Away/Blackout). A DLC CLEMSO XML now points at a Stonehill
  placeholder set (purple #372d7d / black, ESPN logo 284 with the ® speck dropped). Every placeholder jersey carries the
  school or nickname where COMING SOON sat (centre 511,1603 of the 1024x2048 body; the front, below the collar), set
  in the jersey's own NAME_DECAL font: its kerning table is "40 / 2 / ABC…Z0-9#-  " then x/width pairs, cells 64x128,
  letters on rows 14..107. Villanova (DUKEXX, archive XML) gets a DLC XML = the archive one plus a non-official helmet
  part DUKEXX_HELMET_2026_NAVYBL: the white helmet (archive DUKEXX_helmet_2013_Black1, flat 255 shell) with everything
  outside the V (largest ink piece plus what it encloses), the light silhouette and the hardware strip painted #002463,
  the V's own navy (the silhouette's edges recoloured by projection, the seam dots under each V gone). Installed; a manifest (dist/coming-soon/installed.json) now keeps studio edits from being overwritten.
- FCS-online.exe now ships the uniform sets: build.mjs packs every file under tools/uniforms/dist/coming-soon/FCS_DLC_*
  (bytes from the live DLC folder when present, so studio touch-ups ship) into generated/uniform-pack.bin, a SEA asset
  (71 files, 31 MB; payload.uniformSets indexes folder/name/offset/size/sha1) and drops stop-gap XMLs whose slot has a
  set (BALLST). `join` writes them into their FCS_DLC_* folders, backs replaced DLC files up to
  %LOCALAPPDATA%\ncaa-bridge\uniforms\backup and moves a same-named slot XML out of any other FCS_DLC folder; `status`
  counts current/different/missing. Tested: bundle and exe on fake installs (stale BALLST stop-gap replaced, a duplicate
  WYOMIN XML in NEC moved aside, second run all current, files byte-identical to the live DLC) and exe status on the real
  install (71/71 current). 122 MB, sha256 7f65c7d7…; copy at Desktop\FCS\FCS-online.exe (previous one
  .bak-2026-11-07-pre-uniforms).
- Generic opponents (TGID 160-164, TEAM.TTYP 1, CGID 17, SGID 1023, no PLAY or DCHT rows in FCS2026 nor in a dynasty):
  make-coming-soon-sets.mjs now builds sets for D1AAEX Mercyhurst, D1AAWX West Florida, D1AAMW Tuskegee, D1AASE Delta
  State (the mod's TEAM colours, lettermark helmets M / UWF / T / DSU set in the jersey name font with an outline) and
  D1AANW Wagner (Teambuilder save NEC TEAM-009). They replace the D1AANW / D1AAMW stop-gaps (backed up), so the exe now
  ships no stop-gap XMLs: 101 files, 44.6 MB, exe 135 MB; copy at Desktop\FCS\FCS-online.exe (.bak-2026-11-07-pre-generic).
- Generic-roster test (CFBR swap feasibility; Bowersrd's NCAA 14 Dynasty Tool v2.2.1 Team Swapper only rewrites TEAM +
  STAD rows, never PLAY, from a built-in list of CFBR v21 FCS schools): two roster saves from FCS2026 installed in RPCS3
  savedata, BLUS31159-ROSTER-GENTEST1 (Montana State's 70 best, depth-chart players first, cloned onto TGID 162 as
  PGIDs 16200-16269 with last name "Gentest", their 88 DCHT rows re-pointed) and GENTEST2 (the same plus TTYP 1 -> 0 and
  OCAP/TPIO 16200, DCAP 16201). Result pending: Rosters screen and a Play Now game vs Wagner.
- Found on the way: FCS2026's TEAM.DCAP / OCAP / TPIO still hold stride-70 PGIDs (Duquesne DCAP 719 = team 10 slot 19
  at 70, but team 7's slot 19 at stride 100); rekeyStride only re-keys PGID/POID columns. Not fixed yet.
- GENTEST1 result (Eric): generic teams are only playable in dynasty; a dynasty from GENTEST1 crashed advancing to week
  1 at "rating playing time": `F {PPU[0x1000023]} [0x0050e00c] VM: Access violation reading location 0xc562000` (an
  earlier run: 0x1b). Cause, statically: the Play Time containers are built for a fixed 126 teams (`li r4,0x7e` at
  0x47e7d0 and 0x47e898 into 0x47e468: 126 team pointers, 126 x 17 list heads, 126 x 70 / 35 nodes). The pass maps a
  player's TGID to an index through the full team list (0x1c86918, count 0x1c86920, 12-byte entries) that includes the
  generic teams after the 126, so team 162's players insert at index >= 126 through 0x50de60 (group-bounded since the
  LS fix, team-unbounded), writing past the heads array; the next virtual call through the corrupted mapper object at
  0x50e008 faults. TTYP plays no part, so GENTEST2 would fail the same way (not run). Real players on generic teams need
  an EBOOT patch (at least those two sizes to 131, likely more 126-team passes); swaps stay cosmetic until then.
- Player-id columns besides PGID/POID (value / stride = the row's TGID in real saves): TEAM.OCAP/DCAP (captains, no
  stored field predicts them), TPIO/TSI1 (best / second offensive player by POVR), TMPI/TSI2 (same on defense),
  SSUM.SSFI/SSPI/SSTI. packages/ncaa14 PGID_ALIASES makes rekeyStride re-key them; setTeamPlayerRefs + `ncaa-bridge roster
  stars` set the TEAM six from each team's players (stars by rating, captains = best senior per side; player-less teams
  keep an id in their own range). FCS2026 out/USR-DATA fixed (831 cells; sha dc591741…, backup in
  %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-07-team-player-refs), Rosters rebuild-90.sh gained a team-refs step and
  validate.ts allows those six fields to change to own-team ids (verify: all hard gates pass). Exe rebuilt (sha 9751d48e…,
  Desktop copy; .bak-2026-11-07-pre-teamrefs).
- Live league (locker 349.bin): the console recomputes TPIO/TMPI/TSI1/TSI2 and SSUM weekly (already stride 100) but not
  the captains: OCAP/DCAP are stride-70 on all 131 teams (as-is: 1 own-team, ~84 another team's player, ~41 nobody).
  Re-keyed by arithmetic, all 126 teams get their original captain back (players keep slots in a dynasty re-key).
  Publishing that copy is pending Eric's go.
- GENTEST1/2 roster saves removed from RPCS3 savedata (2026-11-07).
- Generic rosters are not generated: they are the PLST table (970 rows) and its depth chart DCST (973 rows: PGID TGID
  PPOS ddep) in the game's standard-data DB, archive entry b57b5e0ae8e74714 in both qkl_boot.ast and qkl_fe2ig.ast
  (stored uncompressed, 7,966,280 bytes, 111 tables; the two copies differ only in RCAT). PLST rows: TGID 160-164 (55,
  62, 57, 55, 59 players named by position + jersey, "WR #24", POVR median ~66) and 610-619 (68 each, Road to Glory
  style teams; 610 has real names). No roster, dynasty or other archive DB holds generic players (175 DBs scanned; the
  default roster in qkl_boot has 8,694 players on 126 teams). Code: 0x232cd8 takes a player id, maps it to a team with
  0x44098c, reads that team's TTYP (0x447da4) and pulls the player from PLST when TTYP == 1, else from PLAY; 0x9ed14
  runs "insert into 'YALP' * select * from 'TSLP' where <cond>" and the DCHT <- DCST twin (condition built from 610).
  Within the standard-data DB only PLST.PGID, PLST.POID and DCST.PGID hold these ids.
- LATENT 90-MAN BUG: 0x44098c (PGID -> TGID) divides by 100 under the stride patch (magic 0x47ae147b; stock 0xd41d41d5 =
  /70), but PLST/DCST are still keyed at 70 (generic 11200..11538, 610s 42700..43397). So a generic player resolves to
  team 112..115 (TTYP 0) and is read from PLAY at that id: a real player of another team, or nothing. Fix: re-key the
  three columns to stride 100 (16000..16499, 61000..61967; PGID is 16 bits), same size, written in place in both
  archives. Not done yet.
- Generic -> FBS swap (CFBR) is then a data edit in the same entry: overwrite one generic team's PLST rows (keep its
  count) with the FBS team's best players and its DCST rows, plus the TEAM row identity and uniforms as before; no code
  patch, nothing in the dynasty passes (generic players never enter the dynasty PLAY).
- Generic rosters re-keyed for the 100-player patch (built 2026-11-07, two agents in parallel, merged by hand):
  packages/ncaa14 stda.ts `rewriteStandardData` re-keys PLST.PGID/POID and DCST.PGID of the standard-data DB (entry
  b57b5e0ae8e74714: qkl_boot.ast entry 826 at 78241374, qkl_fe2ig.ast entry 4664 at 3556361770, both stored, 7,966,280
  bytes) from TGID x 70 + slot to TGID x 100 + slot: 2,913 cells, teams 160-164 and 610-619. serializeTdb round-trips
  that 111-table DB byte for byte (extra-data tables THBT LGML HEAD RCFN RCLN included), so the rewrite is parse, edit,
  serialize, verify, and it refuses any byte change outside PLST/DCST data and the priorCrc words covering them (DCSB,
  PTMP). An optional `edit` runs on the re-keyed DB under the same checks. bridge/src/stda.ts + `ncaa-bridge stda
  status|rekey|restore [--rpcs3 DIR | --archive FILE]` write only the changed ranges after backing up the entry, its TOC
  record and a manifest to %LOCALAPPDATA%\ncaa-bridge\backups\<stamp>-stda\, read back, and refuse while that install's
  RPCS3 runs. FCS-online.exe `join` step 3 does the same; `status` prints each copy's stride. DLC/qkl_patch.ast does
  not carry the entry. `od overhaul --restore-rcat` puts back an older copy of entry 4664 (undoes the re-key): run
  `stda rekey` after it. Exe rebuilt (sha 2e7d3766…, 135 MB; Desktop copy, .bak-2026-11-07-pre-stda); tested on a fake
  install (join re-keys, second join "already at stride 100", status stride 100). NOT yet applied to the real install:
  RPCS3 was running.
- Generic -> real team swap: packages/ncaa14 generic-swap.ts `swapGenericTeam` overwrites a generic team's PLST rows in
  place (count kept, 57 for 162) with the donor's best by the generic team's own position quota (shortfalls: a depth
  specialist the quota lacks such as LS, then nearest stand-ins, then best left), copies every PLST field by name from
  the donor PLAY row (all 131 shared, same widths), PGID/POID = TGID x stride + slot, and re-points its DCST rows (donor
  depth order at the position first, then the donor's other players there, the rest of its depth, stand-ins).
  `copyTeamIdentity` puts the donor's names/colours into the generic TEAM row of a roster/dynasty file.
  `ncaa-bridge generic extract|swap|team|install`; `install` re-keys and swaps every archive copy in place through the
  stda writer (same backups; `stda restore` undoes). Test on a scratch qkl_boot.ast: Montana State (106) into 162, OVR
  top/mean 78/65 -> 95/80, PLST/DCST byte-identical to the independent artifact (scratchpad agent2/stda-s100-msu162.bin,
  sha 807c541c…), 10,576 bytes changed inside the entry and 0 outside, restore returns the exact original archive.
  The generic teams carry no long snapper although their depth chart has an LS spot.
- Step 1 APPLIED to the real install (RPCS3 closed): `ncaa-bridge stda rekey` re-keyed both copies (2,913 ids each;
  qkl_boot.ast entry sha now 583683d0…, qkl_fe2ig.ast 6d4da52c… = the agent's independent scratch re-key); backup
  %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-08T01-05-16-stda. Read-back: 0 verify problems, every PLST/DCST id at
  /100, every other table byte-identical to the backup. In-game check pending (a dynasty game vs a generic team).
- Step 1 CONFIRMED IN GAME (Eric, offline dynasty DEFAULT): played Tuskegee (163) and advanced. The QBs #12 / #10 and FBs
  #47 / #45 he saw are PLST 163's rows (PGIDs 16334 / 16335 / 16311 / 16312 after the re-key, OVR 73 / 66 / 68 / 62).
  PLST names are placeholders ("QB #12", empty first name); the game names generic players at run time (James White,
  Napoleon Williams, Shawn McDowell, Tavares Harrington exist in no roster or dynasty PLAY). The dynasty's box score /
  season stat tables (BOFF BDEF BKIC BKPR BOLN PRST SDEF BSCS.SS*I) now hold ids 16300-16399, a range only generic 163
  has at stride 100. Open for the swap: whether run-time naming also replaces real names in PLST (the Montana State
  test into 162 answers it).
- 2026-11-07 evening, published:
  - Live league captains: `ncaa-bridge od captains --did 8` (new: DynastyPatchSet.captains, applyCaptains re-keys
    TEAM.OCAP/DCAP that belong to their team at 70 but not at the file's stride, PATCH_FORMAT 6, memo retired by
    maybeCaptainsTaken once a console upload has none left). DID 8 coach1, console file 349: 260 cells; dry run 252/252
    real-team captains back on their own team, no other cell or table changed. web-edits/8/DYNASTY.patch.bin built at
    20:26 (2,682,794 bytes); the console takes it at its next hub load. Other dynasties (stride 70) have none.
    bridge/test/captains.test.ts covers it on the DYNASTY-2 fixture.
  - Site download: R2 ncaa-online-saves/downloads/FCS-2026-Roster.zip replaced (same layout and README, USR-DATA
    dc591741… with the TEAM player refs fixed; zip sha 364a6b86…, read back identical). Previous zip (USR-DATA
    93a7e59d…) in %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-07-roster-download-teamrefs.
  - Montana State test swap installed into generic 162 (Wagner's slot) on the real install: `ncaa-bridge generic
    install --donor FCS2026 --donor-tgid 106 --tgid 162`; qkl_boot.ast entry 583683d0 -> aa665e48, qkl_fe2ig.ast
    6d4da52c -> 807c541c (= the agent's independent artifact). Backup 2026-11-08T01-27-59-stda (restore returns to the
    stride-100 fix). Pending: in game, does Wagner show Montana State's real names or run-time generic names.
- Swap CONFIRMED IN GAME (Eric): Wagner (generic 162) fields Montana State's players with their real names: Justin
  Lamson #8 at QB, 96 OVR in game (POVR 95 stored; the game recomputes the overall). So run-time naming only replaces
  placeholder names ("QB #12"); a generic slot carries real players, ratings and jerseys through PLST with no dynasty
  side effects. Still installed (backup 2026-11-08T01-27-59-stda restores the stock generic Wagner).
- Generic teams get their REAL 2026 rosters by default (identity only, stock generic positions / ratings / faces kept):
  - Plan: Rosters/tools/src/generics.ts (outside git) scrapes the five schools' Sidearm roster pages (hurstathletics,
    goargos, wagnerathletics, goldentigersports, gostatesmen) with the actor's extractor + normalizeRows, and fills
    each team's stock PLST rows strongest first by position fit (compatRank, then extendedRank; K/P rows only take
    K/P). 290 of 290 rows filled; only 12 rows off-position (TE -> FB). Fields: PFNA PLNA PJEN PYEA PRSD PHGT PWGT.
    Plan -> Desktop\FCS\Rosters\2026\generics\plan.json. Each plan row also records the stock row's PPOS / POVR.
  - `ncaa-bridge generic fill --plan <plan.json>` (fillGenericRows; staleGenericRows refuses rows whose PLST row no
    longer has the plan's team / position / rating, i.e. after a swap). APPLIED to the real install after restoring
    the Montana State test (2026-11-08T01-27-59-stda): both copies 290 rows named, positions and ratings unchanged,
    no other cell or table changed, 0 verify problems. qkl_boot.ast entry sha 13789f38…, qkl_fe2ig.ast 05e0ef78…;
    backup 2026-11-08T01-55-37-stda (= the stock stride-100 entries).
  - FCS-online.exe: build.mjs embeds the plan (--generics FILE, default ..\FCS\Rosters\2026\generics\plan.json) as
    payload.genericRosters; join step 3 re-keys and fills in one rewrite per copy, skips (and names) any team whose
    rows a swap changed, and is a no-op on a re-run; status shows "real names on N of 290 rows". Tested on a scratch
    tree from the stock stride-70 qkl_boot.ast: the result is byte-identical to the CLI's (13789f38…). Desktop\FCS\
    FCS-online.exe sha cbcadfb0… (previous kept as .bak-2026-11-07-pre-genericnames).
  - Samples for an in-game check: Wagner QB1 #17 Trip Maxwell, Tuskegee QB1 #3 Kahlib Johnson, Delta State QB1 #15
    Reed Miller, West Florida MLB #3 Travell Wright, Mercyhurst FS #2 Anez Jordan.
  - Eric: generic rosters look good in testing.
- 2026-11-07 night: Robert Morris "KENNESAW" in yellow on the scoreboard (logo right). Leftovers from the slot's earlier
  owners that the mod never touched:
  - No caps "KENNESAW" exists anywhere (every entry of every archive inflated, nested bigfiles too, ASCII/UTF-16):
    the only Kennesaw strings are STAD row 67 SCIT "Kennesaw" (Joe Walton Stadium, STAA NOTDAM; also the game's
    default-roster DB = qkl_boot entry 355 and the qkl_misc DB = entry 145, hash 90790d429152c000, 175 tables incl.
    STAD/CITY/TEAM(1)), CITY row 188 (real GA city, recruiting) and RCHT/RBKS text. Interface art (qkl_interface, 412
    DDS >= 64 px rendered) has no per-team score-bug plates: the bug is generic art tinted at run time.
  - TEAM.TFOR/TFOG/TFOB (16-bit fields): a third team colour. Robert Morris (255,216,30) = the yellow. Over the 131
    real teams only 10 match their own primary/secondary, 36 are the default silver (200,210,210), 71 still carry
    the FBS slot's accent (UC Davis/ARIZON red, Prairie View/AUBURN orange, Alabama State/FLORID orange, Montana/
    OREGON yellow, Texas Southern/LSU gold, Elon/MIAMFL green, Montana State/VANDER black, ...). Best candidate for
    both the score-bug colour and the "team colour" player accessories (Eric: accessory colours look pre-reskin).
  - Other STAD leftovers (SCIT): Stonehill "Newark" (Delaware's; W.B. Mason Stadium is in Easton), VMI
    "Jacksonville" (Lexington), UTRGV "Huntsville" (Edinburg), Valparaiso "Springfield" (Valparaiso), New Hampshire
    has Dartmouth's "Memorial Field / Hanover" (Wildcat Stadium, Durham). Norfolk State SNAM is stored CSV-escaped
    `"William ""Dick"" Price Stadium"`. SLAT/SLON/SCAP are the FBS stadium's everywhere (weather/capacity).
    TEAM.TDNA typos: "Prarie View A&M", "Valporaiso", "Mcneese State", "Gardner Webb".
  - Robert Morris plays in the stock Notre Dame Stadium art (qkl_fe2ig #636 NOTDAM_LOGOS_TRAN = ND monogram,
    "Monogram Club Notre Dame", the Leprechaun; SCOREBOARDFONT_* LED textures). Art, not data.
  - GEAR (STDA, 154 rows, TOID/TGSH/TGGL/TGSO/TMSP): per-team default shoe/glove/sock choices, also the slot's.
  - Test slot ROSTER-RMUTEST (installed, RPCS3 closed) = Rosters/2026/out FCS2026 with exactly four cells changed:
    TEAM 68 TFO -> (166,25,46) (RMU red, distinct from the navy primary), STAD 67 SCIT -> "Moon Township". Play Now
    with it: red / "MOON TOWNSHIP" on the scoreboard and red "team colour" accessories confirm TFO and SCIT.
  - The installed savedata BLUS31159-ROSTER-FCS2026 is the 10:38 build (11,306 PLAY rows, pre captain/team-ref
    fix), not Rosters/2026/out (19:29, = the exe and the site zip).
  - RMUTEST RESULT (Eric, dynasty RMUU from it; both edits confirmed in the dynasty file): scorebug still "KENNESAW"
    on yellow, accessories navy (= TBC* primary). So neither STAD.SCIT nor TEAM.TFO* feeds the scorebug; accessories
    use the primary. (The SCIT / typo / TFO leftovers above are still real data cleanup, just not this bug.)
- FOUND: the scorebug is the CFBR Apt movie in the DLC folder's qkl_patch.ast: outer #5 (719,558 B, stored) ->
  nested bigfile #13 (56,323 B, stored) -> #64 "Apt1" const (14,344 B) + #65 "Apt Data" (91,772 B, zlib 20,905 B)
  (Eric's pointer: a CFBR scorebug tutorial). Why every search missed it: these nested bigfiles use a BGFA variant
  the codec misreads: flags width = ((w8 >> 8) & 255) + 1 (outer #5 has w8 0x04080000 -> 1-byte flags, 21-byte
  records, TOC at the END, @403,576); #13 is the usual 2-byte layout. scratchpad bug/bgfa.cjs reads both.
  - Class ncaa.art.linelook.screen.GameClock.GenericGameClock, `teamInfo`: 126 blocks of 56 bytes, one per stock
    FBS slot in the scorebug's own (alphabetical-by-stock-school) order, NOT TGID order:
    `03 17 b9 08 b6 00 NN 49 12 9d 00x6 29 b7 <u32 c1> 87 00x5 04 17 b7 <u32 c2> 87 00x4 05 17 a1 00 00 <u32 BE
    pointer to the short name> 87 00x6`. c1 = the scorebug team colour (c2 mostly equal). Names are 4-byte aligned,
    zero padded, each referenced exactly once (by its block); nothing in the const file points at them.
  - Leftovers (all others match their team): block 19 "Delaware" #006df9 (CLEMSO = Stonehill), block 68 "Kennesaw"
    #fdbb30 (NOTDAM = Robert Morris), block 117 "Missouri St" #5e0009 (WISCON = Valparaiso). Howard is #6a808c gray.
  - APPLIED (RPCS3 closed): "Stonehill" #2e2975, "RMU" #15234b, "VALPO" #f6b815 (names per Eric), each in its own
    slot, c1 = c2. zlib -9 gave 21,684+ B (> the 20,905 B slot; the original encoder was stronger), zopfli 17,951 B
    -> written into the slot (zero padded) + #13's TOC record csize/delta; nothing else moves. Read back through a
    fresh extraction. qkl_patch.ast sha256 f489832a… -> 00f008d6…; backup (slot + record + manifest)
    %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-08T04-03-08-scorebug. Script: scratchpad bug/scorebug.cjs. Members
    need the same patch (payload: the 17,951 B stream + a guard on the original slot).
  - Also in the archives (not the scorebug): qkl_misc #1001-1133 = 123 1024x256 team banners (NDSU, etc.; several
    still stock FBS: AIR FORCE, BALL STATE, NOTRE DAME, TOLEDO, WYOMING, ...).
- CFBR V21 pkg (Desktop\CFBR_PC_DISC_XB_EASY_INSTALLER_V21.pkg, 7.8 GB, NOT installed): a debug-type PS3 pkg
  (revision 0, content id CUSTOM-INSTALLER, 2,452 items; SHA-1 keystream from the header digest), read with
  scratchpad cfbr-tools/pkg.py (list / get, confined to its output folder). Installing it would overwrite the disc
  archives (qkl_fe2ig 3.6 GB, stream, interface, misc, boot), the game's DLC folder (CFBR_DLC_CUSTOM/V17-V19,
  UNIF001-016, qkl_patch.ast.edat) and add ROSTER-CFBR22V21 / CFBR23V21 (extracted to scratchpad cfbr/x only).
  Pitt in its DLC: only PITTSB_HELMET_big.ast.edat (CUSTOM and V19). C: has 13 GB free: extract selectively.
- 2026-11-07 late:
  - Test saves deleted (Eric): ROSTER-RMUTEST, DYNASTY-RMUU and the bisect slots T65-T72, T8841/T9039/T9207/T10256/
    T11306, H3A-D/H3X, HQ1-4, TEST5X90/TEST69/TEST90MAN1-3, V640LS75/V67OVR/V67TE, FCS26QA/QB (34 folders).
  - Score bug in the repo: bridge/src/scorebug.ts (BGFA reader for both layouts, SCOREBUG_PATH by hash, team table
    decode, writeScorebug in place with backup + read-back, restoreScorebug), `ncaa-bridge scorebug status [--teams] |
    export --out | restore`, bridge/test/scorebug.test.ts (synthetic nested archive). The slot is the room up to the
    next entry (20,912 B), not the TOC csize, so later fixes may grow back to it. FCS_MOD_SCOREBUG_SHA = the mod's
    original Apt (1085804280c9…); join only replaces that one.
  - FCS-online.exe: build.mjs runs `scorebug export` against this PC's qkl_patch.ast and ships the stream when it is
    not the original (payload.scorebug); join step 3 "Score bug" (later steps renumbered 4-7), status line. Tested on
    a scratch copy reverted to the original: written, re-run "already current", result byte-identical to this
    install (qkl_patch.ast 00f008d6…). Desktop\FCS\FCS-online.exe sha 986e2793… (previous .bak-2026-11-07-pre-scorebug).
  - Pitt test (CFBR -> generic 162): donor = CFBR23V21 roster (Pitt TGID 77, 69 PLAY, 88 DCHT, QB Kedon Slovis 84;
    CFBR22V21 has the same Pitt). `generic install --donor ... --donor-tgid 77 --tgid 162`: both STDA copies (boot
    13789f38 -> ed9b9f0a, fe2ig 05e0ef78 -> 358c834e), 57 PLST / 63 DCST rows, verify clean, copies identical; backup
    2026-11-08T04-19-02-stda (restores the real-roster Wagner). Identity: `generic team` on the 19:29 FCS2026 ->
    ROSTER-PITTTEST (TEAM 162 = Pittsburgh / Panthers / Pitt, #003594 / #ffb81c; nothing else changed). Uniforms
    are still Wagner's placeholder set (Pitt's are in CFBR's archives / the PITTSB helmet .edat).
  - Eric: Pitt test looks right; wants uniform + logo swap ability. FBS player source from now on: the PHOENIX26
    roster (Desktop\BLUS31159-ROSTER-PHOENIX26\BLUS31159-ROSTER-PHOENIX26, Pitt = TGID 77, QB Mason Heintschel 86).
- Generic home/away (agent, verified in both ELFs): the Dynasty Custom Schedules editor works on temp table SCHT and
  keys on the opponent's conference, not TTYP: add-game 0x4a0f18 swaps so the user hosts when the opponent's CONF.LGID
  is 1 (Generic, CGID 17); replace-opponent 0x4a10dc swaps when the home team is CGID 17; the toggle 0x4a0c0c is
  refused because 0x4a0a78 returns 3 when the away team is CGID 17. Entry "FCS mod: generic opponents host":
  0x4a0bfc li r31,3 -> 3be00000, 0x4a102c ori -> 4800000c (b 0x4a1038), 0x4a1310 bne -> 48000010 (b 0x4a1320).
  Appended to private/rpcs3-patches.yml and installed + enabled in RPCS3 (imported_patch.yml / patch_config.yml,
  .bak-<stamp> beside both). Untested. Caveat: generic TEAM.SGID is 1023, so a generic-hosted game keeps its old
  SCHD.SGID (0 = Jayne Stadium for a new game); fix in data (give 160-164 stadiums). Agent's notes:
  scratchpad homeaway/.
- CFBR assets are fully readable without installing: pkg (cfbr-tools/pkgfs.cjs, random access), its EDATs
  (cfbr-tools/edat.cjs: NPD v3, licence 3, flags 0x0c; klicensee = what the game passes to sceNpDrmIsAvailable,
  logged by RPCS3 as `KLIC=0x...` in RPCS3.log (kept out of the repo; cfbr.ts dlcKlic reads it from there); EDAT_KEY_0 unwrap; per-block AES-CBC with the NPD digest as IV;
  EdatFile reads blocks on demand, incl. CFBR's 524 MB qkl_patch.ast.edat). CFBR recycles part names: Pitt's helmet
  is DLC "calxxx_jersey_2014_white_big" (V18 and UNIF001), Alt gloves are "GEORGA_HELMET_big" (a Georgia decal
  helmet's entry names inside), socks "BEA_SOCKS_1960_ORAINDSTR_big"; jerseys/pants are PITTSB_* in its fe2ig.
- LOGOS: qkl_interface.ast outer 094ba24caa97c28d (#141) = 1,024-entry logo bigfile (1-byte flags variant), entry
  hash 954ed745_0000XXXX = index; entry TLGL = menu/UI logo, entry 340 + TLGL = score bug logo; 512x512 DXT5 DDS,
  zlib, packed tight (generics TLGL 120-124 have their own logos). CFBR has the same layout (Pitt 77 / 417).
- Pitt -> Wagner slot (162 / D1AANW / TLGL 122), APPLIED for testing:
  - players re-done from PHOENIX26 (`generic install`; backup 2026-11-08T04-40-38-stda; K2 and RT3 rows improvised
    from LBs: Pitt has 1 K / 2 RT); ROSTER-PITTTEST rebuilt from PHOENIX26's TEAM 77 (TSNA "PITT").
  - uniforms (cfbr-tools/uniswap.cjs): Home / Away / Alt #3 (Alt #1/#2 left out: their gloves carry GEORGA decal
    names that would collide with Alcorn's slot). 6 parts renamed to D1AANW_*_2019_* (same length, entry names,
    hashes and scene paths), 5 reused because this install has them byte-identical (generic shoes/socks, both
    glove sets); new D1AANW_Pack0_MixAndMatch.XML in FCS_DLC_NEC; undo manifest
    %LOCALAPPDATA%\ncaa-bridge\uniforms\swaps\2026-11-08T04-41-18-PITTSB-D1AANW. (Running the exe's join again
    would put the Wagner placeholder XML back.)
  - logos (cfbr-tools/logoswap.cjs): CFBR 77/417 streams appended to the logo bigfile, records 122/462 repointed;
    the grown bigfile (18,886,200 B) appended to qkl_interface.ast (390,458,186 -> 409,344,386 B) and its TOC record
    repointed. Backup 2026-11-08T04-41-20-logos (record + original size; restore = record back + truncate).
- 2026-11-08 ~00:15 local: swap tool in the repo (bridge/src/swap/: pkg.ts debug pkg + EDAT readers, cfbr.ts CFBR
  source, bigfile.ts rename/rebuild/DXT/PNG, boost.ts 97-99 via ovr-formulas.ts (Xan's config), uniforms.ts, logos.ts,
  install.ts, swap.ts orchestrator + state in %LOCALAPPDATA%\ncaa-bridge\swaps, server.ts UI API, cli.ts
  `ncaa-bridge swap list|preview|apply|restore|status|stadiums|ui`). Donors = PHOENIX26 (126 FBS teams; TGID, CSAT and
  TLGL identical to CFBR's), assets = CFBR pkg. Identity + home stadium go into the FCS2026 roster save and the
  default roster (qkl_boot entry 092f677e439a5110), players into both STDA copies, uniforms into the slot's DLC folder,
  logos appended to qkl_interface's logo bigfile.
  - Incident: the prototype undo (scratch scripts without an RPCS3 guard; my tasklist check printed a blank first line
    that I misread) ran while Eric had RPCS3 open; the tool's own guard refused the STDA part. Eric asked me to close
    RPCS3 (closed normally), then the slot was reset (STDA backup 04-19-02 --force; uniform + logo prototype undone;
    ROSTER-PITTTEST deleted). All writes now go through code with rpcs3RunningOver.
  - Round trip verified: apply Pitt -> 162 (57 rows 97-99, formula >= POVR 57/57, both copies; TEAM/STAD in roster
    save + default roster; 5 officials, 7 files written + 6 reused; logos 122/462) then restore: STDA back to
    13789f38/05e0ef78, roster save and default-roster entry byte-identical, uniforms and logo records original.
  - Applied for Eric's test: `swap stadiums` (generic slots' real stadiums on HS rows 261/262/265/266/268, STAA GNRIC1,
    plain HS fields HSSTAD/HSMODX/HSTRAD/HSSEMD/HSSWSM; TEAM.SGID set, was 1023), then `swap apply --slot 162
    --donor 77` (Acrisure Stadium). Existing dynasties keep their own TEAM rows (name not swapped there yet).
- 2026-11-08 ~00:30: swap tool finished for the commissioner and members.
  - CFBR uniform XMLs LAYER: archive <SLOT>_MIXANDMATCH, then every DLC <SLOT>_Pack<N>_MixAndMatch by pack number (EA's
    UNIF001-016 = the official uniform DLC; UNIF001's Pack0 files are empty stubs; CFBR_DLC_* last within a pack);
    per official the last XML listing it wins (cfbr.xmls + uniforms.ts layer()). Some XMLs write `<officialType
    name="Home" />` with a space (Ole Miss): every tag pattern takes \s*\/>. Result: dry run of all 126 FBS teams in
    memory (uniform build + rename, both logos, player swap + boost on a copy of the STDA): 0 failures, 98 s; officials
    5 for 94 teams, 4 for 12, 3 for 3, 2 (Home/Away only) for 17; uniform files 0-7.9 MB (median 0.9).
  - UI: installer/src/swap-ui.html (agent-built, matches worker/public/css base + coach: black bar, #cc0000, Barlow
    Condensed, score-bug slot cards, trade-machine preview with top 3 OVR -> boosted). Checked against the real server
    in headless Chrome (scratchpad swapui-mock/shoot-real.mjs, MOCK=<url>): no overflow, no console errors.
  - FCS-online.exe: `swap` mode / menu 5 (finds the CFBR pkg + PHOENIX26 on the Desktop / Downloads; PHOENIX26 also
    embedded as payload.swapDonors) serves the page on 127.0.0.1; join step 7 "Generic teams: home stadiums and FBS
    swaps" applies payload.swapPack + SEA asset swap-pack.bin (`ncaa-bridge swap export`: all five slots' TEAM identity +
    SGID and stadium rows, and per swapped slot its PLST/DCST rows, uniform files + XML, logo streams), after the roster
    step; idempotent; the uniform step skips XMLs a swap owns, and build.mjs ships the script's original for them.
    Member test (scratch tree from the pre-swap backups: qkl_boot + qkl_interface + roster save + DLC): join applied it,
    a second join was "already current" throughout, and STDA entry, default roster, roster save, the 13 D1AANW files and
    the logos are byte-identical to this install. Desktop\FCS\FCS-online.exe sha badb00b3… (previous
    .bak-2026-11-08-pre-swap); it also carries the untested "generic opponents host" patch.
  - Not done: online-league dynasty identity (DynastyPatchSet has no TEAM/STAD edits; the league dynasty's generic rows
    still say Wagner etc.); existing offline dynasties likewise.
- 2026-11-08 ~08:20: score bug name / colour for swapped slots, conference logos on the placeholder jerseys.
  - The score bug's team table is GetTeamNameAndColor(teamInfo, isHome) in the Apt (const file #64 = "Apt1" constant
    pool: 0xe5 teamName, 0xd4 teamColor, 0xe1 teamLogoId, 0x1fd GetTeamNameAndColor). It starts from the game's values
    (r3 = teamInfo.teamName, r4 = r5 = teamInfo.teamColor, r8 = teamLogoId) and runs an if-chain keyed by NN = TEAM.TLGL
    (not alphabetical order as such: 0-118 and 133-139 are the stock slots' TLGLs). The generic slots (TLGL 120-124) have
    no entry, so they always showed the game's name / colour. Opcodes: b9 push reg, b6 push u16, b7 push u32, 49 Equals2,
    12 Not, 9d If, 99 Jump, 87 StoreRegister, 17 Pop, a1 push string; 9d/99/87/a1 operands 4-aligned to the Apt offset.
    The function body is 7,172 B (DefineFunction2 size); a jump to its end returns.
  - bridge/src/scorebug.ts: scorebugChain (both layouts), setScorebugTeams re-encodes the 7,056-byte table in place
    (compact: test, push c1/c2/name, jump STORE; a shared STORE; Pop filler), back to CFBR's exact bytes when the teams
    fit its layout; new names go in an 'FCSNAMES' area appended to the Apt. Checked with a VM over TLGL 0-1023 (real
    Apt, +1 / +5 teams, re-swap, removal = original bytes). zlib -9 gives ~21.9 KB > the 20,912 B slot, so writeScorebug
    now appends when a stream does not fit: stream -> end of bigfile #13, #13 -> end of outer #5, #5 -> end of
    qkl_patch.ast (in place once it is last), records repointed; backup = outer record + replaced tail.
  - Swap tool: step "Score bug name and colour" = CFBR's own entry for the donor's TLGL (Cfbr.scorebugTeams, from
    CFBR's qkl_patch); restore removes it; state.scorebug snapshots the outer record before the first write and the
    last restore returns to it. Real install round trip (Pitt -> 162, entry 122 "Pittsburgh" #003b9d/#ffb81c, archive
    +798 KB; restore): qkl_patch.ast, roster save, qkl_boot, qkl_fe2ig byte-identical (qkl_patch 00f008d6…). The swap
    page shows the bar (name on primary, secondary tab). `scorebug export` now lists every sha in the backup manifests
    as replaceable, so members on an earlier build's score bug get the new one at join step 3.
  - Eric had restored slot 162 himself at 07:41 (state.json empty); the install stays unswapped.
  - Conference logos (fork agent): make-coming-soon-sets.mjs mirrors the UA logo across the jersey centre (x ~510.5,
    same height); ESPN conference art from archive/logos/conf (NEC 25.png, Pioneer 28.png, CAA 48.png, FCS Ind 32.png,
    UAC uac.png; flat logos tinted the UA colour), conference per archive/logos/espn-fcs.json (Saint Francis -> NEC);
    Tuskegee (SIAC) and Delta State (Gulf South) have no art, left blank. 28 jersey files installed in FCS_DLC_NEC /
    FCS_DLC_PIONEER (backups %LOCALAPPDATA%\ncaa-bridge\uniforms\backup 2026-11-08T13-13); not yet seen in game.
  - Desktop\FCS\FCS-online.exe sha f26ae3e6… (previous .bak-2026-11-08-pre-swap-scorebug); no swaps in its pack.
  - Merrimack (EMICHI, fork agent, ~08:35): conference `Independent` = a drawn US flag (1.9:1, 13 stripes, 50 stars,
    ~52x27 px, canton top-left) in the conference-logo spot on both jerseys; home jersey chest word and number fill in
    the UA logo's gold (251,235,41) via `lettering: { dark: 'ua' }`. Number colour lives in each jersey's own
    _NUMS_DECAL texture (front, back and shoulder numbers; home and away have their own), not the XML or TEAM fields.
    Only EMICHI_JERSEY_2026_NAV / _WHI changed (99 files byte-identical). NOTE: the agent's install ran while RPCS3 was
    open (its check printed true but exited 0); the two jerseys were written mid-session, backups
    %LOCALAPPDATA%\ncaa-bridge\uniforms\backup\FCS_DLC_NEC__EMICHI_JERSEY_2026_{NAV,WHI}_big.ast.2026-11-08T13-37-*.bak.
    Desktop\FCS\FCS-online.exe sha 6f6cfbbf… (previous .bak-2026-11-08-pre-merrimack).
- 2026-11-08 ~09:25: team-selection names. "Stonehill Stonehill" = TEAM.TMNC (the nickname the menus show) "Stonehill";
  fixed with the others a TMNC != TMNA scan found: Stonehill TMNC Skyhawks + TSNA SHU -> STO (ESPN; SHU is Sacred
  Heart's), Austin Peay TMNC "Govenors" -> Governors, Duquesne TMNA "Duke" -> Dukes. Written (rewriteDb, same length)
  to Rosters/2026/control/USR-DATA (rebuild source) + control/TEAM.csv, Rosters/2026/out save (shipped by the exe),
  the installed ROSTER-FCS2026 and the qkl_boot default roster; backups
  %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-08T14-25-58-teamnames. Left: Delta State (generic 164) shares TSNA DSU
  with Delaware State. Existing dynasties keep their own TEAM rows; the site's roster zip was not updated.
- 2026-11-08 ~10:40: placeholder redesigns (fork agent, make-coming-soon-sets.mjs; previews under
  spike/blaze/tools/uniforms/dist/coming-soon/previews):
  - St. Thomas (UNLVXX): silver metallic helmet (shell finish values from the mod's Montana helmet), thin purple
    stripe, logo 75%; "ST. THOMAS" (period drawn by the script); Nike; silver (Home/Away) + purple (alt) pants.
  - Presbyterian (HAWAII): white helmet, blue 32 | red 16 | blue 32 stripe, ESPN 2506 logo at 75%; new black Home
    jersey (Ball State shoulder stripe measured from CFBR BALLST_jersey_2013_Black, blue gradient numbers with white
    outline), blue jersey as Alt #1; adidas bars everywhere.
  - Robert Morris (NOTDAM): red UA logo moved to the collar row, "ROBERT MORRIS" with a 1 px red outline, red-outlined
    numbers, white helmet with a navy stripe edged red.
  - Sacred Heart (CMICHI): white helmet, red stripe, red SHU (ESPN 2529); no chest word, SHU at the collar; adidas;
    home numbers white with a dark grey outline.
  - Stonehill (CLEMSO): bigger, lower chest word with a black outline, black home number outlines, adidas, black
    facemask (helmet scene facemask_mat baseColor 0,0,0; the mod's black-mask helmets do the same).
  - Helmet stripe centre line = the outer edge of each half's arc (y ~63 at the apex; EA's Nebraska / Penn State and
    the mod's Indiana State template agree); the first build used Abilene's dome edge and was off by ~40 px.
  - Brand art: Wikimedia Commons Logo_NIKE.svg / Adidas_Logo.svg renders in archive/logos/brands (gitignored).
  - Installed with the RPCS3 guard (backups %LOCALAPPDATA%\ncaa-bridge\uniforms\backup); live DLC = dist for all 102
    files. Desktop\FCS\FCS-online.exe sha d786152d… (previous .bak-2026-11-08-pre-redesigns), also ships the
    team-name roster fixes.
  - ~11:00: Eric preferred the first helmet stripes in game: the centre-line fix was reverted (script back to the
    Abilene-dome painter; Presbyterian red 8 + blue 44 per side). The four helmets rebuild byte-identical to the
    15-10 backups (993a955e / e90f9f83 / a0066902 / 689cc7ab), installed with the guard, live = dist for all 102.
    The centre-line script is kept in the scratchpad (conflogo/script-centreline.mjs).
- 2026-11-08 ~11:45: site download R2 ncaa-online-saves/downloads/FCS-2026-Roster.zip replaced with the team-name
  fixes (only diff vs the previous zip: TEAM TMNA Duquesne Dukes, Stonehill TMNC Skyhawks / TSNA STO, Austin Peay TMNC
  Governors; USR-DATA dc591741 -> 542ba295; same layout and README; zip sha eb15eba3…, read back from R2 and from
  fcs-mod.online identical). Previous zip in %LOCALAPPDATA%\ncaa-bridge\backups\2026-11-08-roster-download-teamnames.
- 2026-11-08 ~12:30: GitHub Releases. FCS-online.exe gets a menu option 1 "Install or update" (everything join does
  except the network settings and the site step; join is now option 2, roster-only stays as the `roster` word). Both
  wait for RPCS3 to be closed before writing, install the roster save once per shipped roster (state in
  %LOCALAPPDATA%\ncaa-bridge\roster-installed.json, so later runs keep the player's edits and the generic-team rows;
  a new roster replaces it, the old folder moved to %LOCALAPPDATA%\ncaa-bridge\backups\roster-saves instead of a .bak
  folder in savedata), and keep the console open at the end when double-clicked. `npm run release`
  (installer/release.mjs): needs a clean, pushed commit; builds the exe, tags v<yyyy.mm.dd>[-n] on that commit and
  `gh release create`s it with installer/RELEASE.md (player guide) as notes. Eric chose to publish the exe as it is
  (patches, uniform pack, score bug, roster, PHOENIX26 included) on the public repo; the site's download is unchanged.
  README: Download badge (latest release), Install section, Join points at the release.
