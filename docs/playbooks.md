# NCAA Football 14 playbooks: where they live and how Supersim uses them

Decoded 2026-10-29 from the PS3 disc (BLUS31159) archives. Everything here is read from the user's own game files
by `tools/playbooks-extract.mts`; the generated JSON (`worker/public/data/playbooks/`, ~16 MB, 143 books) is EA data
and stays out of git. Regenerate with:

```
npx tsx tools/playbooks-extract.mts            # paths from ~/.ncaa-bridge/config.json (rpcs3Root)
npx tsx tools/playbooks-extract.mts --usrdir "<…>/PS3_GAME/USRDIR" --out worker/public/data/playbooks
```

## The archives (BGFA 1.05, `qkl_*.ast`)

Header `BGFA1.05`; u32 entry count at 0x08; u32 TOC offset at 0x10 (0x40); u32 TOC size at 0x18; u32 prefix words at
0x28; u32 name width at 0x2C (0 on the disc archives, 64 in the FCS DLC archives). The TOC is `prefixWords*4` bytes
followed by records `{u16 flags, u64 hash, u32 offset, u32 compressedSize, u32 size, char name[nameWidth]}`. Entries
are zlib streams (`78 da`). Several entries are EA DB files (the same format as the saves, parsed by `@ncaa/tdb`),
sometimes wrapped: the extractor looks for the `DB\0\x08` magic in the first 4 KB.

| Archive / entry | Tables | Role |
|---|---|---|
| `qkl_boot.ast` #356 | PLAB (143 rows) | Playbook list: `BGID` is the index stored in `TEAM.TOPB` / `TEAM.TDPB`, `BOFF` 1 offense / 0 defense, `PBGI` the book id (BOKL) used everywhere else, `BNAM` the display name (the FCS mod renamed some: "James Madison" = EA's FIU book). Brown: TOPB 122 = "Pro Style" (236), TDPB 3 = "4-2-5" (109). |
| `qkl_boot.ast` #360 | 19 tables | Shared base: PSAL (3,101 assignment programs), FORM (13 formation names), the base sets/plays also present in the master DB |
| `qkl_misc.ast` #7 | 30 tables, 3 MB | The master playbook DB (below) |
| `qkl_boot.ast` #355 | TEAM, PLAY, COCH, DCHT… | The mod's default roster (TOPB/TDPB per team) |

## Master playbook DB (qkl_misc #7)

- `PGFM` book → formations (`BOKL`, `PBFM`); `PBFM` formation names + `FTYP` (1 offense, 2 kickoff, 3 safety punt,
  11 defense, 12 kick return, 13 safety kick return); `STID` book → sets (`SETL`) per formation; `PGPL` book → plays
  (`BOKL`, `SETL`, `PLYL`, `PLYT`, `ord_`), 52,571 rows; `PBPL` play info (5,912: `name`, `PLYT` type, `SITT`, `PLF_`
  flags, `vpos`, `risk`); `SETL` set names (305).
- `SETP` set slots (`SETL`, `poso` 0..10, `EPos` = position code 0 QB … 24 LS, `DPos` = depth 1-based) and `SETG`
  slot coordinates per sub-formation (`SGF_`, default from `SGFF.dflt`): `x___`/`y___` are float yards, x to the
  offense's right, y toward the defense (offense negative: QB −6 in shotgun, OL −0.6..−1.5; defense positive: DL 1.6,
  LBs 4.8, CBs 8, safeties 13).
- `PLYS` per-slot assignment (`PLYL`, `poso`, `PSAL` program, `PLRR` role, `ARTL` art). Programs are step lists
  (`PSLO` offense, `PSLD` defense, `PSAL` in boot): `code(val1,val2,val3)`.
  - Offense codes: 1 carry the ball, 3 move, 5 fake carry-out, 7 throw, 8 route segment (val2 = feet), 9 cut,
    10 route end, 11/12 read-option mesh, 13 run to the hole, 14 pass block, 15 run block, 18 stalk block, 26 pre-snap
    path, 27 kickoff kick, 28 place kick, 29 punt, 31 kneel, 32 toss catch, 36/37 screen catch, 38/39 handoff, 48 align.
  - Defense codes: 41 pass rush (val3 gap), 19 man coverage (val1 = receiver number 1-5), 23 deep zone (val1 zone
    id), 21/20 underneath zone, 24 delay, 47/48 alignment shifts.
  - Roles worth knowing: 40 QB pass, 41 QB play-action, 43 QB option, 111/113 QB handoff, 38 kneel, 45 spike,
    24 FG kicker (the K slot), 37 holder, 26/27 kickoff kicker, 29 punter, 105 kick-return unit, 107 punt returner,
    106/138 kickoff coverage, 127 punt coverage, 139 onside hands team, 5 DL, 133-137 man-cover #1-#5, 9/10 deep halves.
- `ARTO` / `ARTD` play art (offense / defense): up to 12 segments `sp, ls, at, ct, lt, au, av, ax, ay`. Units are
  feet with screen-down positive. `at = 0`: a line from the previous end to `(ax, ay)`; `at = 1`: a detached piece
  from `(ax, ay)` to `(au, av)`. `ct`: 1 block "T", 2 arrow, 3/4/5 zone bubbles. Field = `(x / 3, −y / 3)` yards.
- `PLPD` progression (`per1..5` %, `rcv1..5` slot), `PLRD` run hole, `PBA1..PBA4` AI weights (`BOKL`, `PLYL`,
  `AIGR` situation group, `prct`), split by book ranges; `BSMO` special sets shared by every book (Field Goal, QB
  Kneel, Stop Clock, Punt Max Protect, FG Block, Punt Return, Kick Return, Onside) with their plays in `DPSF`.
- Play types (`PLYT`): passes 1 flea flicker, 3, 4 play action, 5 screens, 6 RPO/alerts, 7 rollouts, 20 statue,
  100 quick screens, 101 quick game, 102/103 drop-back, 104 Hail Mary, 105/106 fake kicks, 157/159 trick/choice;
  runs 11 QB run, 13 counter, 14 draw, 15 toss, 17 load option, 19 sneak, 151 inside, 152 off tackle, 153 FB dive,
  154/155 fake kicks, 162-172 options; 21 kicks/punts; 37 kneel; 38 spike. Defense: 33 cover 1, 34 2-man, 35
  returns/blocks, 36 max zone, 42 cover 2, 43 cover 3/6, 45 cover 4/prevent, 46 man blitz, 47 zone blitz, 49-51 FG.

## Generated JSON (one file per book)

```
{ id, bgid, side: 'off'|'def', name,
  formations: [{ id, n, t, sets: [{ id, n, slots: [{ i, pos, depth, x, y }], plays: [playId…] }] }],
  plays: { "<id>": { id, n, t, sit, f, v, h?, prog?: [[slot, pct]…], a: [11 indexes into asg] } },
  asg: [{ r, k, p?: [[x right, y downfield]…] (yards), c?: cap, t?: receiver #, z?: zone id }],
  ai: { "<AIGR>": [[playId, weight]…] } }
```
Assignment kinds (`k`) drive the engine and the diagrams: offense `qb qbpa qbopt handoff carry route screen block
pblock kick hold punt kneel spike cover move`; defense `rush man under deep ret block recover`. Sets every book
shares (field goal, kneel, spike, kick/punt returns, FG block, onside) are appended to a "Special Teams" formation.

## How Supersim uses it (`worker/src/supersim/coach/`)

- `books.ts` loads a book from the Worker's assets once per isolate; `teamBooks()` maps a team's `TOPB`/`TDPB`.
- `engine.ts` resolves one snap: lineup from the depth chart by slot (`EPos`/`DPos`), play family from `PLYT` and
  kinds, pass protection vs rush, man matchups by proximity, zone density by route depth, run box count vs blockers,
  special teams, penalties, clock, overtime; it also writes the animation script (22 paths + ball) from the art.
- `cpu.ts` picks the other sideline's play: situational run/pass/kick mix, weighted by the `ai` usage tables.
- `routes.ts` is the HTTP API; `supersim_live` holds the game; the final goes to `supersim_games` unchanged for the
  league server poller (`spike/blaze/server/supersim.mjs`).
