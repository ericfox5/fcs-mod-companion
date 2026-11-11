// One coach's action on a live Supersim game, with no storage and no HTTP: the toss, substitutions, tempo, timeouts, a
// called play, an expired play clock, a pending penalty decision and "let the CPU call it" all change the state in place
// and return the plays that were resolved. Dynasty games run it on the server (routes.ts loads and stores the state around
// it); Quickplay runs the same code in the browser (worker/client/quickplay.mjs).
import { runPlay, decide, coinToss, tossChoice, cpuTossChoice, expirePlayClock, rollPlayClock, PLAY_CLOCK, PLAY_CLOCK_SHORT, type Rng } from './engine.js';
import { cpuOffense, cpuDefense } from './cpu.js';
import type { Book, GameInput, GameState, PlayDetail, Side, TossChoice } from './types.js';

// auto: the call was the CPU's, made for a coach who is simming ahead (he is not asked about penalties on that snap)
export interface Pending { side: Side; play: number; tempo: GameState['tempo']; by: number; auto?: boolean }
// recent: the last plays in order (a ring the watching browser animates from; st.last stays for reloads)
export type LiveState = GameState & { pending?: Pending | null; recent?: PlayDetail[] };
export const RECENT_PLAYS = 6;
export const pushRecent = (st: LiveState, d: PlayDetail) => { const r = (st.recent ??= []); r.push(d); if (r.length > RECENT_PLAYS) r.splice(0, r.length - RECENT_PLAYS); };

export interface ActionBody { action?: string; version?: number; play?: number; tempo?: GameState['tempo']; plays?: number; snapshot?: number | null; call?: string; choice?: string; pos?: number; depth?: number; pgid?: number; elapsed?: number }
// stale: the caller should answer with the current payload as well (the browser's view is behind)
export type ActionError = Error & { status: number; stale?: boolean };
const fail = (msg: string, status: number, stale = false): ActionError => Object.assign(new Error(msg), { status, stale });
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

// the side that must choose next on each sideline: on kickoffs the kicking team "has the ball"
export const actingOff = (st: GameState): Side => (st.phase === 'kickoff' ? st.kicking! : st.off);
// the CPU offense hurries when trailing late in a half and bleeds the clock when protecting a fourth-quarter lead
export const cpuTempo = (st: GameState, side: Side): GameState['tempo'] => { const lead = st.score[side] - st.score[1 - side as Side]; if (st.ot) return 'normal'; if (lead < 0 && (st.q === 2 || st.q >= 4) && st.clock < 150) return 'hurry'; if (lead > 0 && st.q >= 4 && st.clock < 360) return 'chew'; return 'normal'; };
// seconds the play clock has really been running: since the huddle began, less the playback allowance
export const huddleElapsed = (st: GameState, now = Date.now()) => (st.huddle ? (now - st.huddle.at) / 1000 - st.huddle.allow : 0);

export interface SessionCtx {
  input: GameInput; st: LiveState;
  you: Side;              // the acting coach's sideline (a driver of a CPU-vs-CPU game stands on 0)
  humanOther: boolean;    // the other sideline is coached by a person too (calls wait for both)
  by: number;             // who is acting (stored with a pending call)
  rng: Rng;
  books: (st: GameState) => Promise<{ off: Book; def: Book }>; // the books the next snap is played from
  now?: () => number;
}
export interface ActionResult { details: PlayDetail[]; waiting: boolean }
// how long a coach has to accept or decline a penalty before the usual call stands (the browser counts it down)
export const DECISION_SECONDS = 12;

/** Apply one action. Throws an ActionError (status, message) when the action is not allowed right now. */
export async function act(ctx: SessionCtx, body: ActionBody): Promise<ActionResult> {
  const { input, st, you, humanOther, rng } = ctx; const now = ctx.now ?? Date.now;
  const details: PlayDetail[] = []; const otherSide = (1 - you) as Side;
  // pcLeft: the play-clock reading at the snap when the clock was real (a coached snap against the CPU), else rolled
  const resolve = async (mine: { side: Side; play: number; tempo: GameState['tempo'] } | null, cpuMine = false, pcLeft?: number) => {
    const off = actingOff(st); const books = await ctx.books(st);
    const callFor = (side: Side): number => (side === off ? cpuOffense(books.off, st, input, side, rng) : cpuDefense(books.def, st, input, side, rng));
    const myCall = mine && !cpuMine ? mine.play : callFor(you);
    if (mine && !cpuMine) { /* validate the coach's play belongs to the book they are calling from */ const book = you === off ? books.off : books.def; if (!book.plays[String(mine.play)]) throw fail('That play is not in your playbook for this situation.', 400); }
    let theirCall: number | null = null; let theirAuto = false;
    if (humanOther) {
      if (st.pending && st.pending.side === otherSide) { theirCall = st.pending.play; theirAuto = !!st.pending.auto; }
      else { st.pending = { side: you, play: myCall, tempo: mine?.tempo ?? st.tempo, by: ctx.by, auto: cpuMine }; return false; }
    } else theirCall = callFor(otherSide);
    const calls = you === off ? { off: myCall, def: theirCall! } : { off: theirCall!, def: myCall };
    const tempo = off === you ? (mine?.tempo ?? st.tempo) : humanOther ? (st.pending?.tempo ?? st.tempo) : cpuTempo(st, off);
    const cpu: [boolean, boolean] = [false, false]; cpu[you] = cpuMine; cpu[otherSide] = humanOther ? theirAuto : true;
    const detail = runPlay(st, input, books, calls, rng, tempo, { pcLeft, cpu }); details.push(detail); st.pending = null; return true;
  };
  // the huddle after this action's plays: when it began, the playback the browser gets before its clock starts
  // (the animations, the clock runoff and a celebration), and the CPU offense's snap point on the play clock
  const setHuddle = () => {
    if (st.final || st.phase === 'toss') { st.huddle = undefined; return; }
    const off = actingOff(st); const cpuOff = !humanOther && off !== you;
    const allow = details.reduce((a, d) => a + (d.anim?.dur ?? 0) + 2.6 + (d.scoring ? 3.8 : 0), 0);
    st.huddle = { at: now(), allow: Math.round(allow * 10) / 10, cpuAt: cpuOff && st.phase === 'snap' ? rollPlayClock(rng, cpuTempo(st, off), st.pc ?? PLAY_CLOCK) : null };
  };
  // coin toss: the away team calls it (the CPU calls for a CPU side); a human winner then picks receive / kick / defer
  const humanSide = (side: Side) => side === you || (humanOther && side === otherSide);
  const settleToss = (call: 'heads' | 'tails' | null, choice: TossChoice | null) => {
    const t = st.toss!; if (!t.result) coinToss(st, rng, call ?? (rng() < 0.5 ? 'heads' : 'tails'));
    const w = st.toss!.winner!; if (!humanSide(w)) tossChoice(st, input, cpuTossChoice(rng)); else if (choice) tossChoice(st, input, choice);
  };
  // a penalty waiting for an answer: the coach it belongs to accepts or declines; any other action lets the usual call
  // stand (it is already in the state). The other coach of a two-coach game waits a moment for the answer first.
  if (st.decision) {
    const d = st.decision;
    if (body.action === 'decide') {
      if (d.side !== you) throw fail('The other coach has this decision.', 409);
      decide(st, body.choice === 'accept' ? 'accept' : body.choice === 'decline' ? 'decline' : d.def);
      st.pending = null; const r = (st.recent ??= []); if (st.last) { if (r.length && r[r.length - 1]!.n === st.last.n) r[r.length - 1] = st.last; else pushRecent(st, st.last); }
      setHuddle(); return { details: [], waiting: false };
    }
    if (d.side !== you && humanOther && now() - (d.at ?? 0) < (DECISION_SECONDS + 8) * 1000) throw fail('The other coach is deciding on the penalty.', 409, true);
    decide(st, d.def);
  } else if (body.action === 'decide') throw fail('There is no penalty to decide.', 409, true);
  if (body.action === 'toss') {
    if (st.phase !== 'toss' || !st.toss) throw fail('The coin toss is over.', 409);
    const call = body.call === 'heads' || body.call === 'tails' ? body.call : null; const choice = ['receive', 'kick', 'defer'].includes(String(body.choice)) ? (body.choice as TossChoice) : null;
    if (!st.toss.result) {
      if (humanSide(st.toss.caller) && st.toss.caller !== you) throw fail('Waiting for the other coach to call the toss.', 409);
      if (st.toss.caller === you && !call) throw fail('Call heads or tails.', 400);
      settleToss(call, null);
    } else {
      if (st.toss.winner !== you) throw fail('The other coach won the toss and is choosing.', 409);
      if (!choice) throw fail('Choose to receive, kick or defer.', 400);
      settleToss(null, choice);
    }
  } else if (body.action === 'sub' || body.action === 'subreset') {
    // substitutions: put a player at a depth-chart slot of a position for the rest of this game (your team only)
    const team = input.teams[you]; const subs = (st.subs ??= [{}, {}]);
    if (body.action === 'subreset') subs[you] = {};
    else {
      const posN = Number(body.pos), depth = Math.max(0, Math.min(9, Number(body.depth) || 0)), pgid = Number(body.pgid);
      if (!Number.isInteger(posN) || posN < 0 || posN > 24) throw fail('Unknown position.', 400);
      if (!team.players.some((p) => p.id === pgid)) throw fail('That player is not on your roster.', 400);
      const current = subs[you][String(posN)] ?? team.depthChart.filter((d) => d.pos === posN).sort((a, b) => a.depth - b.depth).map((d) => d.pgid);
      const order = current.filter((id) => id !== pgid); order.splice(Math.min(depth, order.length), 0, pgid);
      subs[you][String(posN)] = order.slice(0, 12);
    }
  } else if (body.action === 'tempo') { if (['normal', 'hurry', 'chew'].includes(String(body.tempo))) st.tempo = body.tempo!; }
  else if (body.action === 'timeout') {
    if (st.phase === 'snap' && st.to[you] > 0 && st.running && !st.final) { st.to[you] -= 1; st.running = false; st.pc = PLAY_CLOCK_SHORT; setHuddle(); } else throw fail('No timeout available right now.', 400);
  } else if (body.action === 'play') {
    if (st.final) throw fail('The game is over.', 409);
    if (!Number.isInteger(body.play)) throw fail('Choose a play.', 400);
    if (st.pending && st.pending.side === you) throw fail('Your call is in; waiting for the other sideline.', 409);
    let pcLeft: number | undefined;
    if (!humanOther && st.phase === 'snap') {
      if (actingOff(st) === you) { // the coach snapped: charge what the browser showed, or more if more time really passed
        const pc = st.pc ?? PLAY_CLOCK; const el = Number(body.elapsed);
        pcLeft = pc - clamp(Math.max(Number.isFinite(el) ? el : 0, huddleElapsed(st, now())), 0, pc);
      } else pcLeft = st.huddle?.cpuAt ?? undefined; // the CPU snapped where the browser counted down to
    }
    await resolve({ side: you, play: body.play!, tempo: ['normal', 'hurry', 'chew'].includes(String(body.tempo)) ? body.tempo! : st.tempo }, false, pcLeft);
    setHuddle();
  } else if (body.action === 'delay') {
    // the browser's play clock ran out on the coach's own offense: that much time must really have passed
    if (humanOther || st.final || st.phase !== 'snap' || actingOff(st) !== you) throw fail('No play clock is running on you.', 400);
    // either the play clock ran out, or the game clock did first while it was running
    const gone = huddleElapsed(st, now()); const clockOut = st.running && gone >= st.clock - 1;
    if (gone < (st.pc ?? PLAY_CLOCK) - 3 && !clockOut) throw fail('The play clock has not run out yet.', 409, true);
    details.push(expirePlayClock(st, input)); setHuddle();
  } else if (body.action === 'auto') {
    // the CPU calls the coach's plays too (skip ahead); bounded per request to keep each call short
    const n = Math.min(12, Math.max(1, Number(body.plays) || 1)); // each snap is a full field simulation (~3 ms CPU)
    if (st.phase === 'toss') settleToss(null, 'defer'); // simming from the start: the toss is called and a human winner defers
    for (let i = 0; i < n && !st.final; i++) { const ok = await resolve(null, true); if (!ok) break; }
    setHuddle();
  } else throw fail('Unknown action.', 400);
  if (body.action === 'toss') setHuddle();
  // a penalty decision stops the clocks until it is answered (the huddle starts then)
  if (st.decision) { st.decision.at = now(); st.huddle = undefined; }
  for (const d of details) pushRecent(st, d); // every resolved play, expired play clock and kick: the spectators' ring
  return { details, waiting: !!st.pending };
}
