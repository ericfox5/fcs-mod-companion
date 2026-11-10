// Supersim coaching mode: shared types for the playbook data (tools/playbooks-extract.mts output), the live game
// state kept in D1 (supersim_live.state_json) and the per-play detail sent to the browser.

// ---- playbook JSON (worker/public/data/playbooks/<id>.json): one definition, in @ncaa/ncaa14 (packages/ncaa14/src/playbook/types.ts) ----
export type { Book, Formation, SetDef, Slot, Play, Assign, BookIndex } from '@ncaa/ncaa14';

// ---- game input (rosters) ----
export interface PlayerInput { id: number; name: string; number: number; pos: number; overall: number; ratings: Record<string, number>; photoUrl?: string }
// fsubs: formation subs from the site's depth chart page, "<side>:<set id>:<slot>" -> pgid (a player for one slot of one set)
// synthetic: the game keeps no roster for this team (generic FCS slot); the players are generated placeholders and
// nothing about them goes back to the console (team totals only)
export interface TeamInput { id: number; name: string; abbr: string; logo: string; color?: string; offBook: number; defBook: number; players: PlayerInput[]; depthChart: { pos: number; depth: number; pgid: number }[]; fsubs?: Record<string, number>; synthetic?: boolean }
export interface GameInput {
  dynasty: string; dynastyId: number; season: number; week: number; gameNo: number; gameId: string; snapshot: number | null; ownedTeamId: number;
  quarterSeconds: number; teams: [TeamInput, TeamInput]; backUrl: string; home: number; away: number;
}

// ---- live state ----
export type Side = 0 | 1; // 0 away, 1 home
export type Phase = 'toss' | 'kickoff' | 'snap' | 'pat' | 'final';
export type TossChoice = 'receive' | 'kick' | 'defer';
// coin toss: the away team calls it; the winner receives, kicks, or defers (receives the second half)
export interface Toss { caller: Side; call?: 'heads' | 'tails'; result?: 'heads' | 'tails'; winner?: Side; choice?: TossChoice }
export interface PStat {
  pa: number; pc: number; py: number; ptd: number; pi: number; // passing
  ra: number; ry: number; rtd: number; fum: number; // rushing / fumbles lost
  rec: number; rey: number; retd: number; tgt: number; // receiving
  tk: number; sk: number; int: number; iry: number; dtd: number; tfl: number; pd: number; // defense
  fga: number; fgm: number; fgl: number; xpa: number; xpm: number; pt: number; pty: number; // kicking
  kr: number; kry: number; pr: number; pry: number; krtd: number; // returns
  lp: number; lr: number; lc: number; // longest pass / rush / catch
  // detail for the console's per-game tables (PGOF/PGDE/PGKI/PGKP/PGOL): YAC, yards after contact, broken tackles, 20+ runs,
  // drops, times sacked; forced/recovered fumbles, safeties, blocked kicks, assisted tackles, long INT return; line sacks
  // allowed and pancakes; FG attempts/makes by distance (17-29, 30-39, 40-49, 50+), blocked FG/XP, kickoffs, touchbacks,
  // punts inside the 20, punt touchbacks, net punt yards, long punt, punts blocked; long KR/PR, PR TDs; two-point
  // conversions as passer / rusher / receiver.
  yac: number; yco: number; bt: number; r20: number; drp: number; sacked: number;
  ff: number; fr: number; sfty: number; blk: number; ast: number; lir: number; sa: number; pk: number;
  fa29: number; fm29: number; fa39: number; fm39: number; fa49: number; fm49: number; fa50: number; fm50: number; fgb: number; xpb: number;
  ko: number; kotb: number; p20: number; ptb: number; pnet: number; plong: number; pbl: number; krl: number; prl: number; prtd: number;
  tp2: number; tr2: number; tc2: number;
}
export interface TStat { fd: number; yds: number; py: number; ry: number; pa: number; pc: number; ra: number; t3a: number; t3c: number; t4a: number; t4c: number; to: number; pen: number; peny: number; top: number; plays: number; rz: number; rztd: number; sk: number; rzfg: number; ptd: number; rtd: number; tp2a: number; tp2c: number }
export interface Drive { off: Side; q: number; start: number; plays: number; yds: number; time: number; result: string; end?: number; rz?: boolean }
// one scoring play for the console's scoring summary (SCOS): type 0 pass TD, 1 run, 2 fumble return, 3 fumble recovered in
// the end zone, 4 interception return, 5 field goal, 6 kickoff return, 7 punt return; pt = PAT result (14 kick good, 11 kick
// missed, 15 two-point good, 12 two-point failed, 16 none); sc/de/dp = drive start (negative = own side), seconds, plays.
export interface ScoreEv { side: Side; q: number; clk: number; type: number; y: number; ti: number; fi: number; pi: number; pf: number; pt: number; sc: number; de: number; dp: number }
export interface LogEntry { n: number; q: number; clk: number; off: Side; ball: number; d: number; tg: number; op: number; dp: number; k: string; y: number; s: [number, number]; t: string; p?: number[] }
export interface OtState { period: number; first: Side; possessions: number }
export interface GameState {
  v: 2; id: string; seed: number; n: number; q: number; clock: number; qs: number; score: [number, number]; off: Side; ball: number; down: number; toGo: number;
  phase: Phase; kicking?: Side; running: boolean; to: [number, number]; drives: Drive[]; log: LogEntry[]; stats: [Record<string, PStat>, Record<string, PStat>]; team: [TStat, TStat];
  usage: Record<string, number>; opened: Side; ot: OtState | null; last?: PlayDetail; winner: Side | null; final: boolean; patTeam?: Side; freeKick?: boolean; tempo: 'normal' | 'hurry' | 'chew';
  sc?: ScoreEv[];
  toss?: Toss; h2?: Side; // h2: the team receiving the second-half kickoff
  subs?: [Record<string, number[]>, Record<string, number[]>]; // per side: depth-chart position -> player order (substitutions)
  // the play clock before the next snap: 40 after a play by the same offense, 25 after a stoppage (score, change of
  // possession, penalty, timeout, kick, new quarter). huddle: when it started on the server (ms epoch), the seconds the
  // browser needs to play the previous plays back before it starts counting, and for a CPU offense the reading it snaps at.
  pc?: number; huddle?: { at: number; allow: number; cpuAt: number | null };
}
// the game as it stood at the snap / after the play, for the scoreboard while a play is animated
export interface SnapState { phase: Phase; off: Side; kicking?: Side; ball: number; down: number; toGo: number; q: number; clock: number; score: [number, number]; to: [number, number]; running: boolean; patTeam?: Side; freeKick?: boolean; pc?: number; final?: boolean }

// ---- play detail (returned to the browser; the last one is also kept in the state for reloads) ----
export interface Actor { s: 'o' | 'd'; i: number; id: number; num: number; pos: number; k: string; path: number[][] } // path: [t, x (yards downfield from the LOS), y (yards right)]
// field goal / extra point flight for the client: kick and end-line times, result, lateral offset at the end line
// (offense-relative, + = the kicker's right), height crossing it in yards, and for a short kick how far short it lands
export interface KickFlight { t0: number; t1: number; res: 'good' | 'wide' | 'short' | 'post' | 'blocked'; y: number; h: number; good: boolean; land?: number }
export interface Anim { dur: number; los: number; fd: number; off: Side; dir: 1 | -1; actors: Actor[]; ball: number[][]; events: { t: number; k: string }[]; end: number[]; kick?: KickFlight }
export interface PlayDetail {
  n: number; headline: string; text: string; kind: string; yards: number; off: Side; offPlay: { id: number; n: string; set: string; form: string }; defPlay: { id: number; n: string; set: string; form: string };
  anim: Anim; score: [number, number]; q: number; clock: number; drive?: Drive; scoring?: string; people: { id: number; side: Side; role: string }[]; penalty?: string;
  // clocks: game clock before the between-play runoff, at the snap, play clock left at the snap (of pcLen seconds); the
  // quarter of the snap and whether the field ends were flipped for it (Q2/Q4 and even overtimes)
  clk0?: number; snap?: number; pc?: number; pcLen?: number; pq?: number; flip?: boolean;
  // the board before the snap and after the play: the browser shows pre while the play runs and post once it is over
  pre?: SnapState; post?: SnapState;
}
