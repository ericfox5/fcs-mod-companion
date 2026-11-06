// Who may coach or start a bracket game (worker/src/supersim/playoff-games.ts).
import { describe, it, expect } from 'vitest';
import { bracketControls, type BracketGame } from '../src/supersim/playoff-games.js';
import { normalize, fillNextRounds } from '../src/playoff-state.js';
import type { MemberRow } from '../src/db/queries.js';

const seeds = Array.from({ length: 24 }, (_, i) => ({ seed: i + 1, tgid: 100 + i + 1, autoBid: null }));
const state = fillNextRounds(normalize({ phase: 'live', seeds, games: [] }, 2025));
const game = state.games[0]!; // 24 at 9: tgids 124 at 109
const member = (tgid: number): MemberRow => ({ blaze_id: tgid, persona: `p${tgid}`, ncid: 0, tgid, ccid: 0, commissioner: 0, team_file_id: 0 });
const b: BracketGame = { state, game, open: true };

describe('bracket game controls', () => {
  it('lets the members whose teams play coach their sides', () => {
    const members = [member(109), member(124)];
    expect(bracketControls(b, members[0]!, members)).toMatchObject({ sides: [1], mayStart: true, humans: [true, true] });
    expect(bracketControls(b, members[1]!, members)).toMatchObject({ sides: [0], mayStart: true });
    expect(bracketControls(b, member(55), members)).toMatchObject({ sides: [], mayStart: false });
  });
  it('lets any member start a game between two CPU teams, and nobody a closed one', () => {
    expect(bracketControls(b, member(55), [member(55)])).toMatchObject({ sides: [], mayStart: true, humans: [false, false] });
    expect(bracketControls({ ...b, open: false }, member(55), [member(55)]).mayStart).toBe(false);
    expect(bracketControls(b, null, []).mayStart).toBe(false);
  });
});
