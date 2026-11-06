// FCS playoff games in Supersim (worker/src/playoff-state.ts): a bracket game is a postseason schedule row the bridge
// laid the bracket over (source 'playoff'). While the bracket is open the members whose teams are in it coach it,
// a game between two CPU teams can be started and auto-played by any signed-in member, and the final goes to the
// playoff state (never to the console outbox: the bridge carries the finished bracket to the console itself).
import type { Dynasty, GameRow, MemberRow } from '../db/queries.js';
import { loadPlayoff, playoffGameAt, playoffGameOpen, recordPlayoffResult, type PlayoffState, type StateGame } from '../playoff-state.js';
import type { GameInput, GameState, Side } from './coach/types.js';

export interface BracketGame { state: PlayoffState; game: StateGame; open: boolean }
// the bracket game on this schedule row, if the row is one
export async function bracketGameFor(db: D1Database, dyn: Dynasty, game: GameRow): Promise<BracketGame | null> {
  if (game.week < 16 || game.season_year !== dyn.season_year) return null;
  const state = await loadPlayoff(db, dyn); const g = playoffGameAt(state, game.week, game.game_no);
  if (!state || !g) return null;
  return { state, game: g, open: playoffGameOpen(state, g) };
}
// who may coach / drive a bracket game: a member whose team plays coaches that side; with no member on either side
// any signed-in member may start it and let the CPU play it out (sides: [] = watch or auto only)
export function bracketControls(b: BracketGame, member: MemberRow | null, members: MemberRow[]): { sides: Side[]; mayStart: boolean; humans: [boolean, boolean] } {
  const humans: [boolean, boolean] = [members.some((m) => m.tgid === b.game.away), members.some((m) => m.tgid === b.game.home)];
  const sides: Side[] = []; if (member && member.tgid === b.game.away) sides.push(0); if (member && member.tgid === b.game.home) sides.push(1);
  const mayStart = b.open && !!member && (sides.length > 0 || (!humans[0] && !humans[1]));
  return { sides, mayStart, humans };
}
// a bracket game's final: into the playoff state (and the schedule row); returns the updated state or null when the
// game was no longer open (the bracket moved on, or the result is a tie)
export async function finishBracketGame(db: D1Database, dyn: Dynasty, game: GameRow, st: GameState, input: GameInput, runId: string): Promise<PlayoffState | null> {
  const home = input.teams[1].id === game.home_tgid ? 1 : 0; const away = (1 - home) as Side;
  return recordPlayoffResult(db, dyn, game.week, game.game_no, { homeScore: st.score[home], awayScore: st.score[away], ot: !!st.ot, runId });
}
