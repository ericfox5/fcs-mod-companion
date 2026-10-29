# What the original web app did (archive evidence) and how we rebuild it

Checked 2026-10-29 against the Wayback Machine. The logged-in tool pages of `easports.com/dynasty` (NCAA 12/13/14)
were never archived: every capture of `/dynasty13/*`, `/dynasty12/*` and `/dynasty/*` behind login is the login wall,
and the CDX index has nothing under `supersim*`, `recruiting*` or `advanceweek*`. What exists:

| Source | What it gives us |
|---|---|
| `www.easports.com/dynasty/home?dyid=506596&platform=360` (2012-05) | NCAA 12 logged-in home: main story widget (hero image, Recap / Scoring / Player Stats / Team Stats tabs, comments), headlines widget, nav Home · Teams · Schedule · Stats · Standings · Rankings · Rosters · Recruiting · SuperSim, header "Advance week" button, Download Data popup, advance-week job status vars |
| `.../dynasty/teams`, `/rankings`, `/dynastybrowse`, `/webtips` (2012-2013) | Team list, poll table (RK/LW/Team/Rec/Pts), dynasty browser, web tips |
| NCAA 13 theme `cdn.www.easports.com/dynasty13/static/1289/` | Full CSS + sprites (buttons, tabs, table, popups, icons, header/footer, advance-week button, progress bar) |
| NCAA 14 bundle `cdn.www.easports.com/dynasty/static/b7934fd/bundles/ncaaonlinedynasty14/` | `base.css`, landing page, icons, avatars, 117 team logos (45px), conference logos, story images |
| Landing-page slides (NCAA 12/13/14) | Real screenshots of every tool, listed below |

## The tools, from the screenshots

- **Home / Dynasty hub** (NCAA 12 and 14 slide): red header band with the dynasty name, week and "ADVANCE WEEK" button;
  hero story with image carousel, Recap and Comments tabs; right column "Create New Story" and a week list
  (PRESEASON, WEEK 1, WEEK 2 ...) with story thumbnails per week.
- **Recruiting board** (NCAA 14 slide 1, NCAA 13 slides 6 and 9): top summary bar with recruiting time left
  ("9 hrs 40 min recruiting time remaining", "3 hrs 50 min scouting time", "35 prospects on board"), tabs
  Recruiting Board · Search · Team Needs · Pipeline States; the board table (rank, name, position, stars, state,
  interest/lead bars, points this week, lock) with a prospect card on the right (photo, ratings, pitches, "scout" and
  "schedule visit" actions). "Scout <name>?" asks how long to spend (10..60 minutes). "Instant Commit!" result screen.
  Pipeline States: a per-state table of your recruits plus a state map and quick-pitch summary.
- **SuperSim** (NCAA 12 slide 3): scoreboard (rank + team, score, clock, quarter), "Choose play now" button, a field
  view with the formation diagram and the last play, current drive summary, and below it the depth chart tabs
  (Offense · Defense · Special teams) with the player table.
- **Awards** (NCAA 13 slide 8): Heisman Watch list (rank, player, position, school, last week, season stats) with the
  candidate card and tabs Heisman Watch · Players of the Week · All-Americans · Award Winners.
- **Coaching carousel** ("ON THE CLOCK": job offers with Accept / Decline / Stay buttons; list of coaching changes).
- **Offseason steps**: Coaching Carousel · Players Leaving · Transfer Requests · Recruiting Week 1-5 · Signing Day ·
  Position Changes · Training Results · Cut Players.
- **Advance Week**: a single red "ADVANCE WEEK" panel; the server ran the simulation and the page polled the job.
- **Alert emails**: weekly results, recruiting news with star ratings.

## How each one maps onto the console-driven architecture

The console runs the simulation; our server (the Blaze stub) is storage, queue and change distribution. Three
channels into the console exist and are already exercised by the game:

1. **Per-user "Z" tables pulled during an advance.** In step 1 the console calls `GetTableUpdate` for COCZ, CREZ,
   PLYZ, PRIZ, RADZ, REBZ, REPZ, RPRZ, REVZ, TEMZ, PPMC, PINZ, PLSZ (filtered by its TGID / CCID / PTCM) plus CSCH,
   CACH, CPFC, CAWC, FTCX, COCH, CSKL, CONT. Web recruiting (board, points, visits, scouting) and web roster edits
   (position changes, redshirts, cuts) go back through these rows. First experiment: serve REBZ rows with the RECB
   column set (PRSI, PPSC, PPSL, PSCP, PROR, PEPV, USEL, TGID) for the member's team and check the in-game board.
2. **Game results.** `UploadGameResults` / `RetrieveGameResults` (week-keyed) is how other consoles' finals reach the
   advancing console. A web SuperSim writes its final into the same store; the console treats it as a played game.
   Box-score stat tables (IGAM, PGOF, PGDE ...) can follow through the UPDT 2 table path once scores work.
3. **Advance week.** Only a console can advance (the sim lives there). The site shows readiness and the queue state
   and can post a dynasty message/notification; the commissioner presses advance on the console.

Dynasty Wire stories and comments live on the site (D1); the console's own story feature (EA Sports World) stays off.

## Assets

- Player photos: the league's own set (7,160 FCS player headshots from school roster pages, `player_photos_manifest.csv`)
  matched by team + name at import (6,662 of 8,694 players in the current dynasty); fallback is the game's face art
  by head id (PGHE, 239 images); then a silhouette. Served from R2 under `/img/players/` and `/img/faces/`.
- Team logos: not in the archive (EA's FBS logos only). Needs the league's FCS logo pack (PNG per team) or an
  extraction from the mod's `.ast` texture archives.
