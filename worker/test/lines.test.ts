// Closing lines against the final score, the console injury rows built from a Supersim final, and replayable action seeds.
import { describe, it, expect } from 'vitest';
import { closingResult } from '../src/pages/odds.js';
import { actionSeed } from '../src/supersim/routes.js';
import type { TeamRow } from '../src/db/queries.js';
import type { LineRow } from '../src/odds.js';
// @ts-expect-error plain module of the league server
import { buildGameTables, injuryLength } from '../../spike/blaze/server/gamedata.mjs';

const team = (abbr: string, name: string) => ({ abbr, name }) as unknown as TeamRow;
const line = (spread: number, total: number): LineRow => ({ week: 3, game_no: 1, spread, total, home_win: 0.6, home_money: -150, away_money: 130 });

describe('closing line', () => {
  const away = team('NDSU', 'North Dakota State'), home = team('MONT', 'Montana');
  it('names the favourite and says whether he covered', () => {
    // Montana -6.5 at home
    expect(closingResult(away, home, { home_score: 31, away_score: 21 }, line(-6.5, 51.5))).toEqual({ line: 'MONT −6.5', cover: 'Montana covered', total: 'Over' });
    expect(closingResult(away, home, { home_score: 24, away_score: 21 }, line(-6.5, 51.5))).toEqual({ line: 'MONT −6.5', cover: 'Montana won but did not cover', total: 'Under' });
    expect(closingResult(away, home, { home_score: 17, away_score: 20 }, line(-6.5, 51.5)).cover).toBe('North Dakota State won outright');
    // the visitors favoured by 3: a three-point road win is a push
    expect(closingResult(away, home, { home_score: 21, away_score: 24 }, line(3, 45))).toEqual({ line: 'NDSU −3.0', cover: 'Push', total: 'Push on the total' });
    expect(closingResult(away, home, { home_score: 10, away_score: 24 }, line(3, 45)).cover).toBe('North Dakota State covered');
    expect(closingResult(away, home, { home_score: 14, away_score: 10 }, line(0, 40)).line).toBe('Pick’em');
  });
});

describe('Supersim injuries on the console', () => {
  it('writes one IGAM row per player out for games, in the form the console uploads', () => {
    const env = { gameResult: { HTID: 2, ATID: 1, HTSC: 7, ATSC: 3 }, detail: { teams: [{ tgid: 1, stats: {}, players: [] }, { tgid: 2, stats: {}, players: [] }], scoring: [], injuries: [{ pgid: 1805, tgid: 1, weeks: 1, type: 127, name: 'Sprained Ankle' }, { pgid: 1900, tgid: 2, weeks: 6, type: 180, name: 'Torn Hamstring' }] } };
    const t = buildGameTables(env, { SGID: 1, SGNM: 1, SEWN: 1 });
    // one week sits in the console's 24-43 band; six weeks (134) and type 180 go out as signed bytes
    expect(t.IGAM).toEqual([{ PGID: 1805, INJL: 34, IIIG: 1, INJT: 127, INJR: 1, INIR: 0 }, { PGID: 1900, INJL: 134 - 256, IIIG: 1, INJT: 180 - 256, INJR: 1, INIR: 0 }]);
    expect([1, 2, 12].map(injuryLength)).toEqual([34, 54, 254]);
    expect(buildGameTables({ ...env, detail: { ...env.detail, injuries: undefined } }, {}).IGAM).toEqual([]);
  });
});

describe('action seeds', () => {
  it('are fixed by the game seed, the play number and the stored version, and differ between actions', () => {
    expect(actionSeed(123456, 10, 4)).toBe(actionSeed(123456, 10, 4));
    const seen = new Set<number>(); for (let n = 0; n < 200; n++) for (let v = 0; v < 5; v++) seen.add(actionSeed(987654321, n, v));
    expect(seen.size).toBe(1000);
    expect(actionSeed(1, 0, 0)).not.toBe(actionSeed(2, 0, 0));
  });
});
