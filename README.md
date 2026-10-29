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
  seconds. `ncaa-bridge od import --did N` does one sync; `od list` shows what the server holds.
- `worker`: dynasty viewer live at https://ncaa-online.foxbros.workers.dev (hub with members and the current week, teams,
  schedule, standings, rankings, rosters, players, stats, Dynasty Wire, awards, recruiting). Offline-save imports
  (`ncaa-bridge import <USR-DATA>`) still work side by side.
- `packages/tdb` / `packages/ncaa14`: codec + decoders shared by both paths (the online dynasty file is the same EA DB).
- Look: sports-network style (black global bar, scoreboard strip for the current week, white cards on grey, dense tables
  with logos); brand = the NCAA Division I FCS mark + our own wordmark, no third-party network marks.
- Logos: every FCS team and conference (ESPN CDN team logos by ESPN id, two public-domain conference marks from Wikimedia),
  mapped by name in `bridge/data/logos.json`, stored in R2 by `ncaa-bridge logos upload --dir archive/logos`.
- Headshots: the league's own FCS player photos (`ncaa-bridge photos upload` puts them in R2; matched by team + name at
  import) with the game's face art as the fallback. Original-site research and the write-back design: `docs/site-reference.md`.
- Next: write-back (web recruiting/roster edits delivered to the console as the per-team change packages the game asks
  for during an advance), Story Builder, member accounts on the site.

Fan passion project. Not affiliated with, endorsed by, or sponsored by Electronic Arts, EA SPORTS,
the NCAA, or any school or conference. Not monetized. You must own NCAA Football 14 to use any of this.
