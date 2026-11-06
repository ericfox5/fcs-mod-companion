// The site's half of the FCS playoff (worker/src/playoff-state.ts): the bridge's state merged over the site's own
// results, the next round resolved from them, the champion from the final.
import { describe, it, expect } from 'vitest';
import { normalize, mergeFromBridge, fillNextRounds, playoffGameOpen, playoffGameAt, type PlayoffState } from '../src/playoff-state.js';
import { BRACKET_ROWS, BRACKET_WEEKS } from '@ncaa/ncaa14';

const seeds = Array.from({ length: 24 }, (_, i) => ({ seed: i + 1, tgid: 100 + i + 1, autoBid: i < 10 ? i : null }));
const r1 = () => fillNextRounds(normalize({ phase: 'live', seeds, games: [] }, 2025));

describe('playoff state', () => {
  it('resolves the first round from the seeds and nothing more', () => {
    const s = r1();
    expect(s.games.length).toBe(8);
    expect(s.games.every((g) => g.round === 1 && g.week === BRACKET_WEEKS[1] && BRACKET_ROWS[1]!.includes(g.sgnm))).toBe(true);
    expect(s.games[0]).toMatchObject({ idx: 0, home: 109, away: 124, status: 1 }); // 9 hosts 24
    expect(playoffGameOpen(s, playoffGameAt(s, 18, 3))).toBe(true);
    expect(playoffGameAt(s, 19, 7)).toBeNull();
  });
  it('adds the second round once every first-round game is final and keeps the site results over a bridge push', () => {
    const s = r1();
    for (const g of s.games) { g.status = 3; g.homeScore = 28; g.awayScore = 14; g.runId = `run-${g.idx}`; }
    fillNextRounds(s);
    expect(s.games.filter((g) => g.round === 2).length).toBe(8);
    const r2 = s.games.find((g) => g.round === 2 && g.idx === 1)!; // 1 seed vs the winner of game 1 (16 beat 17)
    expect(r2).toMatchObject({ home: 101, away: 116, week: BRACKET_WEEKS[2], sgnm: BRACKET_ROWS[2]![1] });
    // the bridge re-sends the bracket without the results it has not read yet
    const fromBridge: Partial<PlayoffState> = { phase: 'live', seeds, games: s.games.filter((g) => g.round === 1).map((g) => ({ ...g, status: 1, homeScore: 0, awayScore: 0, runId: undefined })), champion: null };
    const merged = mergeFromBridge(s, fromBridge, 2025);
    expect(merged.games.filter((g) => g.round === 1 && g.status === 3 && g.homeScore === 28 && g.runId).length).toBe(8);
    expect(merged.games.filter((g) => g.round === 2).length).toBe(8);
    expect(merged.phase).toBe('live');
  });
  it('crowns the champion from the final and marks the phase final', () => {
    const s = r1();
    for (let round = 1; round <= 5; round++) { for (const g of s.games.filter((x) => x.round === round)) { g.status = 2; g.homeScore = 10; g.awayScore = 20; } fillNextRounds(s); }
    expect(s.games.length).toBe(23);
    expect(s.champion).not.toBeNull();
    expect(s.phase).toBe('final');
    const final = s.games.find((g) => g.round === 5)!; expect(final.week).toBe(21); expect(final.sgnm).toBe(36); expect(s.champion).toBe(final.away);
    expect(playoffGameOpen(s, final)).toBe(false);
  });
  it('keeps a skipped season skipped and a pending one without games', () => {
    expect(normalize({ phase: 'skipped', seeds: [], games: [], note: 'x' }, 2025)).toMatchObject({ phase: 'skipped', note: 'x', games: [] });
    expect(fillNextRounds(normalize({ seeds: [], games: [] }, 2025)).games.length).toBe(0);
    expect(normalize({ seeds, games: [] }, 2025).phase).toBe('live');
  });
});
