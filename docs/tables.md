# NCAA 14 dynasty save: table notes

Verified against the user's saves with `ncaa-bridge dump`. Codes are the 4-char field names inside the
DB; display names from the EA DB Editor configs are in `packages/ncaa14/src/schema.generated.ts`
(treat those as hints: e.g. it labels GSTA "Postseason", which is wrong).

| Table | Rows (DYNASTY-2) | What it is / key fields |
|---|---|---|
| SEAI | 1 | Season info: `SEWN` week (0..22), `SEYR` year offset from 2013, `SEST` stage, `SEWT` week type (150 at season end), `SSYE` |
| SCWE | 25 | Calendar: `SEWN`, `SEST`, `PPRD` |
| CONF | 25 | `CGID`, `CNAM` (e.g. CAA, BS-OVC, MVFC), `LGID` |
| DIVI | 22 | `CGID`, `DGID`, `DNAM` "Big Sky (North)", `SDNM` "North" |
| TEAM | 133 | `TGID`, `TDNA` display name, `TLNA` long, `TMNA` mascot, `TSNA` abbr, `TMCC` conference label text, `CGID/DGID`, `TTYP`, `CSAT` asset slot (FCS mod), `SGID` stadium, `TSWI/TSLO` record, `TCWI/TCLO` conf record, `TSCS` streak (signed), polls `TBRK` BCS / `TCRK` coaches / `TMRK` media, `TPRS` prestige, `TOVR`, `TLGL` logo id |
| SCHD | 823 | One season. `SEWN` week, `SGNM` game in week, `GSTA` 1 scheduled / 2 away team won / 3 home team won (822 played = 439 + 383 in DYNASTY-2), `GHTG/GATG` home/away, `GHSC/GASC` scores, `SGID` stadium, `GTOD` kickoff minutes, `GDAT` day, `SEWT`, `GFOT` OT, `GFHU` user played, `GUTE` user-team game, `CPCK/HPCK` picks (-1..) |
| PLAY | 8832 | `PGID`, `TGID`, `PFNA`/`PLNA` (11/13 bytes), `PPOS`, `PYEA` 0..3, `PRSD` redshirt 0 none/1 current/2 used, `PJEN`, `POVR`, `PHGT` inches, `PWGT`+160 lb, `sgmp` games, 7-bit ratings (`PSPD PSTR PAGI PACC PAWR PBTK PTRK PELU PBCV PSTA PSMV PJMV PCAR PCTH PSPC PCIT PRTE PJMP PTHP PTHA PTAK PHIT PPMV PFMV PBSH PPUR PPRC PMCV PZCV PPRS PRLS PPBK PPBF PPBS PRBK PRBF PRBS PIBL PKPR PKAC PRET PSTM PINJ PTGH` …) |
| COCH | 399 | `CCID`, `TGID`, `CFNM/CLNM`, `COPS` 0 HC/1 OC/2 DC, `CFUC` user-controlled, `CAGE`, `CPRE` prestige, `COPK` playbook, `COTR/CDTR` sim run-pass, `CCWI/CCLO` career, `CSWI/CSLO` season |
| DCHT | 11264 | `TGID`, `PPOS` slot, `ddep` depth, `PGID` |
| MCOV | 1008 | Media stories: `SEWN`, `SGNM`, `MHTX` headline (36 bytes), `MCTX` text (81 bytes), `TGID`, `PGID`, `MLAY` layout, `SWEK` |
| HEIS | 10 | Heisman race: `HPRK` rank, `PGID`, stat snapshots |
| AAPL | | All-Americans |
| TSSE | 126 | Team season stats (`ts*` fields) |
| TSHS | | Team history W-L |
| PSOF/PSDE/PSKI/PSKP/PSOL | 0 at season end? (see export) | Player season stats keyed by `PGID`, `SEYR` |
| BTES/BOFF/BDEF/BKIC/BKPR/BOLN | 0 | Per-game logs; empty even at week 22 (lifecycle unknown; E1 will tell) |
| RCPT | 2710 | Recruits: `PRSI`, names, `PPOS`, `RCCB` stars, `RCRK` rank, `RCCM` committed, `RCOV` pre-scout OVR, `POVR` true OVR, `PSTA` state, `RCHD` hometown, `IMP1..3` pitch importances + `VTP1/2` |
| RCPR | 2710 | Interest board per recruit: `PT01..PT10` team ids (1023 = none), `PS01..PS10` points, `PR01..PR10` previous, `PTCM` committed team, `CMTS` points to commit, `NLKD`, `RPGP` |
| RECB | 4365 | Recruiting boards: `TGID`, `PRSI`, `PPSC` points this week, `PPSL` last week, `PSCP` scouting, `PROR` order, `PEPV` playing time, `USEL` |
| RECV | | Visits |
| PTIP / TPDA / PINT / RCTC | | Pitch strengths / team needs / interested recruits / class ranks |
| BCHH / CCHH | 34 / 10 | Bowl and conference champions history |
| CSKL / CSKT / CSRD | | Coach skills |
| STAD / CITY | | Stadiums, cities |
| INJY / TRAN | | Injuries, transfers |

Allocation types seen: 2/6/10/14 fixed (data = maxRecords × lengthBytes), 26/30 grow-on-demand
(data = currentRecords × lengthBytes). The game sets bit 4 ("written") when it touches a table.

## Rank and box-score semantics (verified 2026-10-29 on the online dynasty file)

- `TEAM.TBRK` (BCS) is 0 for every team in an FCS dynasty; `TCRK` (coaches) and `TMRK` (media) are 1-based full
  orderings 1..N. The site ranks by BCS when present, else by the coaches poll (`rankOf`).
- `HEIS.HPRK` is last week's slot (0-based; 15 = not ranked); the current Heisman order is by points `PCAP` desc.
- Per-game logs are in `BTES` (team: `ts1d` first downs, `tsop` pass yds, `tsor` rush yds, `tsoy` total offense, `tsTy`
  all-purpose incl. `tskr`/`tspr` return yds, `tspc`/`tspa` comp/att, `tsra` rush att, `ts3c`/`ts3d` third downs,
  `tspi` INT thrown, `tsfl` fumbles lost, `tspe`/`tsPy` penalties-yards, `tspu`/`tsPd` punts/punt yds, `tspt` possession
  in seconds), `BOFF` (passing ga*, rushing gu*, receiving gc*), `BDEF` (gd*/gl*/gs*), `BKIC` (gk* kicking, gp* punting),
  `BKPR` (grk*/grp* returns), `BOLN` (gopa pancakes, gosa sacks allowed); keyed by `SEWN` + `SGNM` (+ `PGID`/`TGID`).
  Season equivalents in `TSSE` (`tsga` games) and `PSOF/PSDE/PSKI/PSKP/PSOL` use `s` instead of `g`.
