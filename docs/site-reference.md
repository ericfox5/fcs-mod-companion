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

- Player photos: the league's own sets (`photosDir` + `photosDirs` in the bridge config, each a folder with
  `player_photos/` + `player_photos_manifest.csv`): the original 7,160 FCS headshots from school roster pages (matched by
  team + name at import, 6,662 of 8,694 players in the first dynasty) and, since 2026-11-05, the 2026 roster's 13,057
  photos packed by `tools/photo-pack.py` from the scrape in `FCS/Rosters/2026` (160 px JPEGs named `2026__<Team>__<Name>.jpg`;
  the manifest carries the game's team id and in-game name, so a 2026-roster dynasty matches its players exactly; a later
  set wins a key both hold). Fallback is the game's face art by head id (PGHE, 239 images); then a silhouette. Served from
  R2 under `/img/players/` and `/img/faces/`.
- Team logos: not in the archive (EA's FBS logos only). Needs the league's FCS logo pack (PNG per team) or an
  extraction from the mod's `.ast` texture archives.

## Member accounts (migrations 0008, 0023-0026)

The console decides who is in the league (`od_members`, mirrored by the bridge); the site only adds a login. An account
is site-wide: one username + password (`accounts`: username unique site-wide, PBKDF2-SHA256 100k-iteration hash +
16-byte salt) that owns at most one league-server persona (`accounts.blaze_id` > 0, the RPCN user the console signs in
with). `account_members` links the account to the member it acts as in each dynasty. Other tables: `invites` (code per
member, `used_at` once it was taken), `sessions` (SHA-256 of the cookie token, 30-day sliding expiry, renewed when under
7 days remain; one session serves every linked dynasty). Cookie `od_session` is HttpOnly, Secure, SameSite=Lax, Path=/.

- **Console identity.** Whenever the bridge syncs a dynasty's member list (`POST /api/bridge/dynasties`), every console
  member whose persona owns an account is linked to the dynasty (`linkPersonaStatements`), and links of members who
  left are dropped. So the person who creates or joins an online dynasty on the console is its commissioner / member
  on the site at once, with the session they already have; no new account, no second sign-in. `currentMember` also
  links lazily when it finds the signed-in account's persona among the members. One persona per account.
- **Lock.** A dynasty with no linked account behaves as before: the `od_member` persona cookie picks who you are and a
  single-member dynasty auto-selects. As soon as it has one it is *locked*: the persona cookie is ignored, visitors
  without a session are nobody (`member = null`), and only signed-in members edit boards, players and stories. A
  signed-in account that is not a member of an unlocked dynasty is treated like any visitor there.
- **Bootstrap.** The first invite comes from the league server (`ncaa-bridge od invite --did N --persona NAME`, which
  calls `POST /api/bridge/invites` with the bridge token), so making the first account proves control of the server.
  After that a signed-in commissioner creates and revokes invites on `/d/<slug>/members`. Both the bridge call and
  "Create invite" link a console persona that already owns an account instead of inviting it (`{ linked: true }`).
- **Routes** under `/d/<slug>`: `login` (GET form, POST username + password; generic failure message with a 400 ms
  pause), `logout` (POST), `join?code=...` (GET shows the persona the code is for; POST creates the account, marks the
  invite used and signs in, or with `link=1` takes the invite with the account the browser is already signed in with:
  any account for a web player, an account owning no persona yet for a console member), `members` (everyone:
  persona, team, commissioner tag, account; commissioner: invite controls), `members/invite` and
  `members/invite/<code>/revoke` (POST, commissioner only). Usernames are 3-24 characters `[A-Za-z0-9_.-]`, passwords
  at least 8. Bridge API: `POST /api/bridge/invites {od, blazeId, note?}` and `GET /api/bridge/invites?od=N`.
- **Web players** (migration 0014) have negative, per-dynasty blaze ids; their accounts own no persona and are linked
  to that dynasty only (another dynasty's invite can be taken with the same account). Removing a web player drops the
  link, and the account too when nothing else uses it.
- **Migrations 0023-0026** turned the per-dynasty rows into site-wide ones: one account per console persona (its
  newest row's username and password; a username an earlier persona already used gets `-<blaze id>`), one per web
  player (`-<dynasty id>` on a clash), console personas linked to every dynasty they are in, all sessions dropped. It
  is four files (create staging tables; fill them and drop the old tables; create the final `accounts` + `sessions`;
  move the rows and drop the staging table) because D1's remote query API, which `wrangler d1 migrations apply
  --remote` posts each file to, refuses as "not authorized [code: 7403]" any INSERT/UPDATE/DELETE/DROP/ALTER whose
  table did not exist when the request began. A migration file may create tables, but only a later file can write to
  or drop them; the local D1 does not enforce this, so it only shows at the remote apply.
- **Code**: `worker/src/session.ts` (hashing, sessions, `currentMember` returning `member/members/account/locked`,
  `sessionAccount`), `worker/src/pages/{login,join,members}.ts`, `worker/src/api/auth.ts`, `bridge/src/commands/invite.ts`.
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
- In-game Dynasty Wire (2026-10-31): the console's Story Center runs over EA Sports World + XMS, which the league server
  now serves (spike/blaze/server/easw.mjs, enabled by OSDK_EASW_ALLOWED_LOCALES "****"). Member stories are delivered as
  in-game user stories with their photo (wire.mjs, /api/bridge/wire, migration 0012 `web_stories.wire_*`); photos and
  recap/user stories the console uploads come back as captures and `console_stories` (News Wire "In-game Dynasty Wire").
  Stories are filed by week (SEARCH_KEY_1), recaps get the game's own photos, and blank console photos (RPCS3's
  photo pass comes out white for now) stay off the site. Formats in spike/blaze/NOTES.md (2026-10-31, both entries)
  and server/story.mjs.

### 2026-11-02 additions

- Depth Chart page (`/d/<slug>/depth`, menu group "Team", was "Players"): every slot of the game's depth chart (DCHT,
  88 per team) as a select, "Fill by ratings", a pending tag, and a formation-subs table per playbook set (PLSU,
  experimental). A save is `web_depth_edits` (migration 0018); the bridge writes it into the dynasty-file copy the
  console downloads at its next load (no change table exists for DCHT/PLSU), so a player the in-game screen refuses
  (a portal player the game redshirted) still starts. Supersim uses the pending chart, subs and player edits at once.
- Supersim clocks run in real time against the CPU: the play clock (40, or 25 after a stoppage) counts down while the
  coach picks the play and the game clock runs with it when it was left running; the server charges what was shown
  (at least its own reading). A CPU offense snaps at a point rolled in the huddle (the count stops there on defense).
  At zero the server flags a delay of game (or ends the period). The board shows the pre-snap down, distance, score
  and stats until the animation is over (`detail.pre` / `detail.post`). Human-vs-human games keep the tempo model.
- Transfer eligibility: the game redshirts portal players who land on (or stay on) a member's team at the rollover;
  the bridge clears that redshirt in the first weeks of the season (PLYZ + the dynasty-file copy). See
  spike/blaze/NOTES.md 2026-11-02.
- Supersim fixes after the first full game (evening): a return touchdown or a pick six is the defense's score (it was
  credited to the offense as a rush); the final no longer shows the last PAT line; the quarter-end clock flicker is
  gone; a quarter that turns over in the huddle plays the snap in the new quarter. Every punt is now played out through
  the coverage (gunners jammed at the line, then running their lanes); the returner fair catches only when a cover man
  is about to reach him, lets end-zone balls go, and muffs one in eighty.
- Fang's Recruit Overhaul runs automatically (`ncaa-bridge od overhaul --set-exe …` once, `--install-rcat …` once per
  RPCS3 install): on the first dynasty file of a season (the preseason, week 0) the bridge runs the tool on the class
  the game generated and publishes the reshaped class as the dynasty file; consoles take it at their next load. Memo
  per season in `~/.ncaa-bridge/od-state.json`; details in spike/blaze/NOTES.md (2026-11-02 evening).
- Generic FCS slots (TEAM.CSAT `D1AAEX/WX/NW/MW/SE`, used by Mercyhurst, West Florida, Wagner, Tuskegee and Delta
  State in the FCS mod): the mod's archive XML for `D1AANW` names an "FBSGEN 2022" uniform set that does not exist,
  so a game with Wagner crashed at load (RPCS3 `VM: Access violation` in FGGameCore after ENOENT on
  `FBSGEN_*_2022_*_big.AST`). The game prefers a `<CSAT>_Pack0_MixAndMatch.XML` found in any `DLC/FCS_DLC_*` folder
  and lets it name archive-resident art, so `spike/blaze/tools/uniforms/` holds drop-in XMLs built on the game's own
  2007 generic art; they go into `USRDIR/DLC/FCS_DLC_NEC/` of every install. Details in spike/blaze/NOTES.md
  (2026-11-02 16:00).
- FCS playoff (2026-11-02, redesigned the same night): `/d/<slug>/bracket` shows a 24-team bracket, projected from the
  coaches poll, records and conference standings until the bridge sets the field from the console's week-18 file, then
  live from `playoff_state` (migration 0021; the bridge PUTs seeds/rounds and GETs the site's results through
  `/api/bridge/playoff?od=N`; worker/src/playoff-state.ts merges them and writes the bracket games into `games` as
  source 'playoff'). The bracket is played on the site in Supersim while the console sits at Bowl Season (the game
  simulates weeks 18-21 in one advance, so it cannot play rounds); when the champion is known the bridge writes all 23
  games with results into the console's dynasty-file copy (bridge/src/playoff.ts; layout shared in
  packages/ncaa14/src/playoff.ts BRACKET_ROWS/BRACKET_WEEKS) and the league server holds the console's advance
  (CheckAdvanceWeekStatus ALLW 0) until that copy is loaded.
- New dynasties start in the year set by `ncaa-bridge od year --default 2025` (the Dynasty Tool's Year Changer, applied
  to a new dynasty's first preseason file; `od year --did N --year Y` for one dynasty at that stage).
- Prospect pages (`/d/<slug>/recruit/<prsi>`, linked from every prospect name on the recruiting pages) carry a recruit
  editor (name, position, height, weight, stars) for the commissioner or the coach he committed to; edits reach the
  console through the dynasty-file copy and show an EDIT tag until a console file carries them. The commissioner's
  "Recruiting class" box on /recruiting re-generates the class with Fang's overhaul during the preseason (week 0) and
  reports the bridge's result (migration 0019).

### 2026-11-10 additions: engine 4.0.0 and simulated odds

**Engine 4.0.0** (`worker/src/supersim/coach/`). Measured on real rosters with `npx tsx tools/supersim-calibrate.mts`
(games between teams of the FCS roster save, compared with this season's NCAA.com team averages in
`tools/fcs-benchmarks.json`; rebuild that file with `npx tsx tools/fcs-benchmarks.mts`). `tools/supersim-probe.mts`
breaks single snaps down when a game-level number is off.

- Blocking: blockers cut off the rusher's path to the ball instead of chasing where he is; the line slides to an
  overload; a blitzer on a run goes to the nearest free blocker. The CPU defense rushes four as its base call.
- Fatigue: every snap costs the 22 on the field (`GameState.energy`), tired players play below their physical
  ratings, and backs, receivers, tight ends, the defensive front and the secondary rotate when gassed. Players can be
  hurt on a tackle or a sack (`GameState.inj`): a few snaps, the quarter, or the game. Multi-week injuries are recorded
  (`Injury.weeks`) and written to the console (see the 2026-11-11 additions).
- Fouls: before the snap they come from the players lined up (discipline, awareness, the road team, hurry-up, a hard
  count); during the play they are called where the contact happens (holding, pass interference, defensive holding,
  facemask, roughing). A CPU sideline takes the better of the play and the penalty; a coach is asked (2026-11-11 additions).
- Kicks: a place kick's flight comes from the kicker's accuracy (angle off the aim) and leg (carry); blocks come from
  the rush against the protection and are credited to a rusher; punters take distance off to pin and can put it out
  of bounds; the returner decides on a kickoff in the end zone; onside recoveries depend on the players involved;
  a defender alone with a loose ball can scoop it and run.
- Rules: a missed field goal goes over at the previous spot (the 20 when snapped inside it); a defensive foul that
  reaches the line to gain is a first down, with half-the-distance near a goal line; an untimed down after a defensive
  foul at 0:00; overtime possessions alternate correctly after a defensive score, a two-point try is required from the
  second overtime, and from the third each possession is one two-point try; touchdowns count as first downs; out of
  bounds only stops the clock in the last two minutes of a half.
- CPU: timeouts late in a half, a fourth-down chart by field position and score, the head coach's run/pass lean
  (`TeamInput.runPass` from `coaches.sim_rp_off`).

**Simulated odds** (`/d/<slug>/odds`, `worker/src/odds.ts`, `packages/ncaa14/src/odds.ts`, migration 0028). Each
team's depth chart and ratings are reduced to nine unit grades; a matchup sets offense against defense to get expected
points, then the spread, total, win probability and moneylines. The grades are cached per snapshot in `odds_cache`
(one row per dynasty; without the table the page still works, uncached). Lines also show on unplayed rows of the
schedule and in a box on the game preview. Refit the scale with `npx tsx tools/odds-calibrate.mts` after engine
changes and copy the numbers into `ODDS_PARAMS`. Entertainment only: nothing can be wagered.

## 2026-11-11 additions

**Quickplay** (`/quickplay`, `worker/src/pages/quickplay.ts`). Any two 2026 FCS teams in Supersim with no dynasty and
no account. The picker shows the same odds box as a game preview and swaps it when a team changes
(`/quickplay/preview`, `public/js/quickplay-pick.js`). The game itself runs in the browser:
`worker/client/quickplay.mjs` (built to `public/js/supersim/quickplay.js` with `npm run build:quickplay -w worker`)
bundles the engine and answers `coach.js` in place of the dynasty data endpoint (`data-endpoint="local"`). Nothing is
stored on the server; the state sits in `sessionStorage`. The rosters are static files under
`public/data/quickplay/` (git-ignored): rebuild them with `npx tsx tools/quickplay-data.mts` after every roster rebuild.

**One play loop** (`worker/src/supersim/coach/session.ts`). The toss, substitutions, tempo, timeouts, a called play,
an expired play clock, a penalty decision and "let the CPU call it" live in `act()`. `routes.ts` loads and stores the
state around it; Quickplay calls the same function in the browser.

**Penalty decisions.** A foul the offended team may accept or decline (offensive holding, pass interference, defensive
holding, roughing on a play that failed) is settled the usual way for a CPU sideline. For a coached sideline
`runPlay` plays out both answers from the same roll, shows the usual call and keeps the other in
`GameState.decision`; the coach answers with the `decide` action inside 12 seconds (`decisionCard` in `coach.js`),
after which the usual call stands. A coach who is simming ahead is not asked. Holding is now flagged whatever the play
did, and fouls by both teams offset.

**Injuries on the console.** An injury that costs games gets a named type (`Injury.type`, `Injury.name`). The result
and the envelope carry `injuries`, the game page lists them, and the league server writes them to the console's IGAM
table (`spike/blaze/server/gamedata.mjs`), in the form the console uploads itself. Not yet seen on a console.

**Closing lines** (`game_lines`, migration 0029, `recordLines` in `worker/src/odds.ts`). The lines of this week's and
next week's unplayed games are rewritten at every import commit and at a Supersim kickoff. A played game shows the line
it closed at, whether the favourite covered and whether it went over (game page and the Odds page, where the last two
played weeks stay in the week nav). Games played before the table existed have none.

**Replayable seeds.** Each action's randomness comes from the game's seed, the play number and the stored version
(`actionSeed` in `routes.ts`); the seed is not sent to the browser while the game is live.

**Engine 4.1.0.** A sack is a rushing attempt for the lost yards (college scoring) and only a tackle for loss when
yards were lost; a back met behind the line on a run slips the first man a little more often and falls forward. All 27
benchmarked stats are inside the FCS range (`npx tsx tools/supersim-calibrate.mts 60`).

**Odds box.** The 3D figures wear the main colours of the team's real Home or Away set, read from the game's uniform
art, and take the skin colour of the player's in-game head; both tables are generated by
`node tools/uniform-colours.mjs` (`worker/src/pages/uniforms.generated.ts`, `face-skin.generated.ts`; needs the RPCS3
folder and the faces folder from `~/.ncaa-bridge/config.json`). Ten teams whose art is encrypted fall back to the
team's two colours. The win probability is one bar in the two teams' colours; Spread, Total and Moneyline use a heavy
condensed italic numeral face (`/fonts/barlow-condensed-800-italic.woff2` when present, condensed system faces
otherwise). The SuperSim and QuickPlay badges are `public/img/supersim-button.webp` and `quickplay-button.webp`.

**Supersim field (2026-11-11, engine 4.2.0).** The field is one projected 3D scene drawn in SVG
(`worker/public/js/supersim/scene.js`): a full-size college field (10-yard end zones, hash marks, numbers read from
their sideline, six-foot border, pylons), goalposts on the end lines, a main grandstand with a press box on the home
sideline, visitors' bleachers, a scoreboard that carries the score, a field house, light towers and trees. Everything
is placed in field yards and heights through one perspective (`coord(x, y, z)`), so players, the ball's height and its
shadow agree with the paint. The camera stays behind the near end zone, so when the teams change ends each quarter the
home stand and the midfield logo swap sides. Players are standing figures in the team's real uniform colours for that
game (`TeamInput.kit`: the home side's Home set, the visitors' Away set), drawn in depth order with shadows. In the
engine nobody leaves the stadium floor any more: every player stops at the end lines, only the ball carrier can cross a
sideline, the quarterback leads a receiver to a spot inside the end zone and a pass that comes down past the end line
is incomplete.
