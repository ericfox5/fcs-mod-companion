# NCAA Online Dynasty 14 revival

Companion website (Cloudflare Worker) + local RPCS3 save bridge for NCAA Football 14 dynasties.

- `packages/tdb` – EA "DB"/TDB save-database codec (read, verify, write with full CRC chain)
- `packages/ncaa14` – NCAA 14 table/field semantics, decode/encode of dynasty data
- `packages/sim` – deterministic play-by-play SuperSim engine
- `worker` – the website and API (Cloudflare Worker + D1 + R2)
- `bridge` – CLI on the PC that hosts RPCS3: mirrors the league server to the site and delivers site edits back
- `tools` – archive fetcher, schema generator, save diff
- `spike/blaze` – the league server (Blaze redirector, login, locker, DynastyOnDemand) and its research log; `private/` (saves, captures, binary-derived data) is never committed
- `docs` – table notes, experiment logs, runbook

## Status (2026-10-29)
- **The game plays Online Dynasty against our own server.** `spike/blaze/server` (Node) answers the console the way
  EA's Blaze service did: redirector + SSLv3, login, Locker file store, DynastyOnDemand (create, resume, advance week,
  play a game, upload results). Proven on RPCS3 0.0.29 with a private protocol-19 RPCN server (`spike/blaze/NOTES.md`).
- **The site mirrors it.** `ncaa-bridge od watch` (opened by `start-spike.cmd`) decodes the dynasty file the console
  uploads at every advance, lays the uploaded game results over it, and pushes members + tables to the Worker within
  seconds. `ncaa-bridge od import --did N` does one sync; `od list` shows what the server holds. A dynasty everyone
  has left on the console (no members on the league server) is retired: the landing page stops listing it, its pages
  stay reachable by URL, and it is back as soon as someone is in it again.
- **Recruiting classes can be reshaped by Fang's Recruit Overhaul** (a community tool, not included): `ncaa-bridge od
  overhaul --set-exe <RecruitOverhaul.exe>` once, `--install-rcat <File04664.DB>` once per RPCS3 install (game
  closed), and the watcher runs the tool on every new class at the preseason and sends the result to the consoles.
- **Teams on the game's five generic FCS slots need a uniform file.** The FCS mod's archive points the `D1AANW` (Wagner) and
  `D1AAMW` (Tuskegee) slots at uniform sets that are not shipped, and the game crashes loading any game with those
  teams. Copy
  `spike/blaze/tools/uniforms/*_MixAndMatch.XML` into `dev_hdd0/game/BLUS31159/USRDIR/DLC/FCS_DLC_NEC/` on every
  RPCS3 install (see `spike/blaze/tools/uniforms/README.md`). `spike/blaze/tools/uniforms/uniform-studio.cmd` starts the
  FCS Uniform Studio, a local editor for what each team wears (uniform rows, parts, DDS textures with automatic
  repackaging, new sets); see `spike/blaze/tools/uniforms/README.md`.
- **The postseason is a 24-team FCS playoff played on the site.** NCAA 14 fills every bowl row itself (at the advance
  into the conference-championship week 16 and again at the advance into "Bowl Season", week 18) and then simulates
  the whole bowl season in one advance, so the console cannot play a bracket round by round. Instead the watcher
  picks the field from the console's week-18 file (conference champions get automatic bids, the rest by the polls),
  the bracket is played on the site while the console sits at Bowl Season (members coach their own games in Supersim,
  the other games are simulated there, anyone signed in can watch live), and the finished bracket goes back to the
  console in one copy of its dynasty file: 23 bowl rows renamed, re-weeked and filled with the matchups and results,
  the championship in the game's title-game row, the other 11 bowls kept free of playoff teams. The league server
  refuses the console's Advance Week (CheckAdvanceWeekStatus ALLW 0) while the bracket is open and until the console
  has loaded that copy from the Dynasty hub. The site's **Bracket** page projects the field during the season and
  runs the bracket in the postseason. `ncaa-bridge od playoff --did N --preview` shows the projected field;
  `--autobids "CAA,MVFC,…"` changes the automatic bids; `--off` turns it off; `--hold "text"` / `--release` test the
  advance hold on the console (a hand-set hold stays until `--release`; the watcher only manages its own playoff hold).
- **New dynasties can start in a later year** (`ncaa-bridge od year --default 2025`): the watcher sets the start year
  on a new dynasty's first preseason file, the way the NCAA 14 Dynasty Tool's Year Changer does, and the consoles
  take it at their next load. Only a brand-new dynasty at its first preseason can be changed.
- **Prospects can be edited on the site** (name, position, height, weight, stars, from any prospect's page) by the
  commissioner or the coach he committed to, and the commissioner can re-generate the whole class with Fang's overhaul
  from the Recruiting page during the preseason; both reach the consoles at their next dynasty load.
- **Game patches** (RPCS3 `patches/imported_patch.yml`, the same words baked into a PS3 ELF by
  `spike/blaze/tools/ps3-eboot.mjs`): the preseason All-Conference crash fix, the five-dynasty commissioner limit, and
  **jersey #0** (the player editor's number list and the decal placement treat 0 like 1..9; generator
  `spike/blaze/tools/jersey-zero-patch.py`, mechanism in `spike/blaze/NOTES.md` 2026-11-06).
- **100-player rosters, in progress** (`docs/roster-stride-inventory.md`): the game keys players as `TGID * 70 + slot`.
  The patch "FCS mod: 100-player rosters" (generated by `spike/blaze/tools/roster-stride-patch.py`) moves the
  executable to stride 100 (confirmed in game: a re-keyed dynasty plays and advances); `ncaa-bridge od stride --did N
  --stride 100` re-keys a dynasty's file for the console, `ncaa-bridge roster grow <in> <out> --stride 100` re-keys a
  save, `roster add` creates a player in a free slot, and `packages/ncaa14` exports `PGID_STRIDE` / `rekeyStride` /
  `addPlayer`. The second entry "FCS mod: 100-player rosters (capacity)" lets a dynasty team carry up to 100 players
  in the offseason, trims every team to 90 at the Cut Players week (the auto-cut, the cut screens and the roster
  editor all read 90) and games dress the first 70 slots (the in-game engine is 2 x 70 by object layout); `ncaa-bridge od players --did N
  --team "Name" --fill 100` fills a team with generated reserves for testing, `od repair --did N --tgid T --from CID`
  puts a roster back from an earlier file. The league server rebuilds every uploaded team package so a member team
  above 70 survives the advance (spike/blaze/server/team-package.mjs). Tested in game at 99 (CPU) and 73 (member).
- `worker`: dynasty viewer live at https://ncaa-online.foxbros.workers.dev (hub with members and the current week, teams,
  schedule, standings, rankings, rosters, depth chart, players, stats, Dynasty Wire, awards, recruiting, transfer portal).
  Offline-save imports
  (`ncaa-bridge import <USR-DATA>`) still work side by side.
- `packages/tdb` / `packages/ncaa14`: codec + decoders shared by both paths (the online dynasty file is the same EA DB).
- Look: sports-network style (black global bar, scoreboard strip for the current week, white cards on grey, dense tables
  with logos); brand = the NCAA Division I FCS mark + our own wordmark, no third-party network marks.
- Logos: every FCS team and conference (ESPN CDN team logos by ESPN id, two public-domain conference marks from Wikimedia),
  mapped by name in `bridge/data/logos.json`, stored in R2 by `ncaa-bridge logos upload --dir archive/logos`.
- Headshots: the league's own FCS player photos (`ncaa-bridge photos upload` puts every photo set of the config in R2:
  `photosDir` plus `photosDirs`; matched at import by the game's team id + in-game name when a set carries them, else
  by team + name) with the game's face art as the fallback. A roster year's scrape becomes a photo set with
  `python -I tools/photo-pack.py --scrape FCS/Rosters/<year> --out <set dir> --prefix <year>__`. Original-site research and the write-back design: `docs/site-reference.md`.
- Member accounts: one site-wide username + password per person, tied to their league-server persona; whoever creates
  or joins an online dynasty on the console is recognised on the site at once (the bridge's member sync links the
  persona). New people get in through invite codes: the first invite comes from the league server (`ncaa-bridge od
  invite --did N --persona NAME`), later ones from a signed-in commissioner on `/d/<slug>/members`. Once a dynasty has
  a linked account only signed-in members edit (`docs/site-reference.md`, "Member accounts").
- Supersim coaching mode: a member calls every play of their own game from the team's real NCAA 14 playbook (formation,
  set, play; the books are extracted from the game's `.ast` archives by `tools/playbooks-extract.mts`, see
  `docs/playbooks.md`), the server rolls each snap when it is called and animates all 22 players from the play art, and
  the final goes to the league server as an official result. `/d/<slug>/supersim`, signed-in members only.
  Two members on opposite sidelines both call their plays (the snap resolves when the second call lands); any
  signed-in member can watch any Supersim game live (`/d/<slug>/supersim/watch/<week>/<game>`, listed on the Supersim
  start screen, the hub and game pages), and the FCS playoff games are Supersim games on the Bracket page.
- Next: write-back (web recruiting/roster edits delivered to the console as the per-team change packages the game asks
  for during an advance), Story Builder, password reset for member accounts.

Fan passion project. Not affiliated with, endorsed by, or sponsored by Electronic Arts, EA SPORTS,
the NCAA, or any school or conference. Not monetized. You must own NCAA Football 14 to use any of this.
