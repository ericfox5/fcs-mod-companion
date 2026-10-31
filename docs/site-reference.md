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

## Member accounts (migration 0008)

The console decides who is in the league (`od_members`, mirrored by the bridge); the site only adds a login to each
persona. Tables: `accounts` (one per member per dynasty: username unique per dynasty, PBKDF2-SHA256 100k-iteration
hash + 16-byte salt), `invites` (code per member, `used_at` once an account was made from it), `sessions` (SHA-256 of
the cookie token, 30-day sliding expiry, renewed when under 7 days remain). Cookie `od_session` is HttpOnly, Secure,
SameSite=Lax, Path=/.

- **Lock.** A dynasty with no accounts behaves as before: the `od_member` persona cookie picks who you are and a
  single-member dynasty auto-selects. As soon as it has one account it is *locked*: the persona cookie is ignored,
  visitors without a session are nobody (`member = null`), and only signed-in members edit boards, players and stories.
- **Bootstrap.** The first invite comes from the league server (`ncaa-bridge od invite --did N --persona NAME`, which
  calls `POST /api/bridge/invites` with the bridge token), so making the first account proves control of the server.
  After that a signed-in commissioner creates and revokes invites on `/d/<slug>/members`.
- **Routes** under `/d/<slug>`: `login` (GET form, POST username + password; generic failure message with a 400 ms
  pause), `logout` (POST), `join?code=...` (GET shows the persona the code is for, POST creates the account, marks the
  invite used and signs in), `members` (everyone: persona, team, commissioner tag, account; commissioner: invite
  controls), `members/invite` and `members/invite/<code>/revoke` (POST, commissioner only). Usernames are 3-24
  characters `[A-Za-z0-9_.-]`, passwords at least 8. Bridge API: `POST /api/bridge/invites {od, blazeId, note?}` and
  `GET /api/bridge/invites?od=N`.
- **Code**: `worker/src/session.ts` (hashing, sessions, `currentMember` returning `member/members/account/locked`),
  `worker/src/pages/{login,join,members}.ts`, `worker/src/api/auth.ts`, `bridge/src/commands/invite.ts`.
- Not done yet: password reset / re-invite for a member who already has an account, rate limiting beyond the pause.

## Supersim coaching mode (2026-10-29 revamp)

The NCAA 12 SuperSim screenshot shows the member choosing plays; the first web version simulated the whole game
in one request, which felt predetermined. The revamp (`worker/src/supersim/coach/`, `worker/public/js/supersim/coach.js`)
is a chess match: the member picks a play from their team's real NCAA 14 playbook (formation → set → play, the data
comes from the game's own `.ast` archives, see `docs/playbooks.md`), the server picks the CPU's counter (or waits for
the other member when both teams are human), rolls the snap with fresh randomness at that moment, updates the live
game (`supersim_live`, migration 0011, optimistic `version`) and returns the result with an animation script: every
player's path built from the play art, the ball, and the tackle point. Kickoffs, PATs (kick or two-point play),
punts, field goals, kneels, spikes, timeouts, tempo, penalties, overtime (NCAA alternating possessions from the 25)
are all live. "Sim" lets the CPU call the member's plays for a stretch (each snap still rolled on request). At the
final the result goes into `supersim_games` exactly as before, so the league server poller and the console path are
unchanged. The page requires a signed-in member who owns one of the two teams; a game can be abandoned (deleted)
by its starter or a commissioner until it is final.

### 2026-10-30 additions

- Supersim: coached games start at a coin toss (the away team calls; the winner receives, kicks off or defers; a CPU
  winner defers 75% of the time; Sim settles the toss with a human winner deferring). Quarters are 12 minutes
  (`SUPERSIM_QUARTER_SECONDS` overrides). A 40-second play clock: with the game clock running, the offense snaps with
  8-16 (normal), 24-30 (hurry) or 0-3 (chew) seconds left; each play detail carries `clk0`, `snap`, `pc`, `pq` and the
  client runs the game clock and play clock through the runoff and the play. Teams change ends every quarter (`flip` on
  the detail; end zones and end labels follow). Substitutions (`action: 'sub' {pos, depth, pgid}`, `subreset`) live in
  the live state (`subs`) for the rest of the game and never touch the console depth chart.
- Teams is now an automated power ranking (win %, capped margin, strength of schedule, last-three form, scoring and
  defense percentiles, quality wins / bad losses, streak, poll); Standings keeps the conference tables.
- Awards: Heisman Watch with three key season stats per player by position, then the game's all-conference first and
  second teams (AAPL rows are per conference: `cgid`, `team_type` 0/1) with a conference picker.
- Recruiting: prospects who committed are read-only on the board (green with a check when they committed to you, grey
  with only Remove when they went elsewhere); the save handler drops their points and visits.
- Home: the sidebar Scores box uses compact two-line tiles (`miniScores`).
- Supersim kicks: yellow goalposts on both end lines (uprights 18'6" apart, crossbar 10 ft, 30 ft tall; far set behind
  the players, near set in front). The engine gives every FG / PAT a flight (`anim.kick`: result good / wide / short /
  post / blocked, lateral offset and height at the end line, + = the kicker's right) with matching text ("wide left",
  "short", "hits the right upright and bounces out"); the client flies the ball on that arc with a shadow and an air
  trace, flashes the posts on a make, shakes them on a doink, and eases a kick camera in on the hold and the posts.
  PAT block odds are now ~0.5% (2% against a block call), FG 1.2% (5%).
