// Synthetic rosters with position-shaped ratings for the Supersim calibration tools.
import { POS } from '../worker/src/supersim/coach/engine.ts';
import type { PlayerInput, TeamInput } from '../worker/src/supersim/coach/types.ts';
const KEYS = ['PPBS', 'PPBF', 'PRBS', 'PBFW', 'PIBL', 'PTRK', 'PESV', 'PJMV', 'PSMV', 'PSAR', 'RELS', 'TRAF', 'SPCT', 'PPRC', 'PPRS', 'PJMP', 'PYRS', 'PSPD', 'PACC', 'PAGI', 'PSTR', 'PAWR', 'PCTH', 'PCAR', 'PBTK', 'PTHA', 'PTHP', 'PPBK', 'PRBK', 'PTAK', 'PBSH', 'PPMV', 'PFMV', 'PMCV', 'PZCV', 'PYRS', 'PRTR', 'PKAC', 'PKPR', 'PBCV', 'PHIT', 'PJMV', 'PSMV', 'PSAR', 'PTRK', 'PESV', 'RELS', 'TRAF', 'SPCT', 'PPRC', 'PPRS', 'PJMP', 'PPBS', 'PPBF', 'PRBS', 'PBFW', 'PIBL'];
// position templates: realistic rating shapes per position around an overall
// offsets from the overall, measured on the league's likely starters (dynasty file 139, 2026-11-02)
const SHAPE: Record<number, Record<string, number>> = {
  0: { PSPD: -7, PACC: -8, PAGI: -8, PSTR: -13, PAWR: -5, PTHP: -2, PTHA: 2, PBTK: -14, PESV: -8, PJMV: -10, PSMV: -10, PSAR: -17, PBCV: -14, PCAR: -17, PTAK: -43, PBSH: -40, PPBK: -40, PRBK: -38, PMCV: -42, PZCV: -42, PCTH: -42, PPRC: -39, PPRS: -26, PJMP: -12 },
  1: { PSPD: 6, PACC: -3, PAGI: -5, PSTR: -13, PAWR: -7, PBTK: 1, PTRK: -9, PESV: -7, PJMV: -6, PSMV: -6, PSAR: -7, PBCV: -3, PCAR: -2, PCTH: -17, TRAF: -19, SPCT: -19, PRTR: -18, RELS: -18, PTAK: -44, PPBK: -29, PRBK: -29, PMCV: -37, PZCV: -37, PPRC: -38, PJMP: -7 },
  2: { PSPD: -12, PSTR: -3, PRBK: -6, PIBL: -2, PPBK: -8, PBTK: -6, PTRK: 0, PCTH: -18, PTAK: -38, PMCV: -40, PZCV: -40 },
  3: { PSPD: 11, PACC: 1, PAGI: -1, PSTR: -12, PAWR: -4, PCTH: 2, TRAF: -2, SPCT: -3, PRTR: -1, RELS: -2, PBTK: -5, PTRK: -7, PESV: -7, PJMV: -6, PSMV: -7, PSAR: -8, PBCV: -4, PCAR: -9, PTAK: -26, PPBK: -30, PRBK: -24, PMCV: -31, PZCV: -31, PPRC: -33, PJMP: -4 },
  4: { PSPD: -3, PSTR: -2, PAWR: -2, PPBK: -1, PPBS: -17, PPBF: -20, PRBK: -11, PRBS: -18, PBFW: -18, PIBL: -6, PCTH: 0, TRAF: -2, SPCT: -4, PRTR: -1, RELS: -3, PBTK: -3, PTAK: -26, PMCV: -35, PZCV: -35 },
  5: { PSPD: -7, PACC: -3, PAGI: -6, PSTR: 5, PAWR: 0, PPBK: 4, PPBS: 1, PPBF: 1, PRBK: 4, PRBS: 1, PBFW: -11, PIBL: 2, PCTH: -33, PTAK: -38, PMCV: -41, PZCV: -40, PPMV: -27, PFMV: -30, PBSH: -20, PBTK: -29 },
  10: { PSPD: -5, PACC: -3, PAGI: -6, PSTR: 1, PAWR: -4, PPMV: -2, PFMV: 0, PBSH: 1, PTAK: -1, PHIT: -1, PPRC: -3, PPRS: -2, PMCV: -31, PZCV: -31, PCTH: -26, PPBK: -26, PRBK: -26 },
  13: { PSPD: -2, PACC: -2, PAGI: -5, PSTR: -2, PAWR: -5, PPMV: -4, PFMV: -3, PBSH: -1, PTAK: 3, PHIT: 1, PPRC: 0, PPRS: 0, PMCV: -8, PZCV: -5, PYRS: -9, PCTH: -17, PPBK: -30, PRBK: -28 },
  16: { PSPD: 21, PACC: 1, PAGI: -1, PSTR: -16, PAWR: -4, PMCV: 11, PZCV: 3, PYRS: -2, PTAK: -7, PHIT: -8, PBSH: -11, PPRC: -1, PPRS: 0, PCTH: -11, SPCT: -8, PJMP: -3, PPBK: -32, PRBK: -27 },
  17: { PSPD: 4, PACC: 0, PAGI: -1, PSTR: -13, PAWR: -3, PMCV: 0, PZCV: 1, PYRS: -2, PTAK: -2, PHIT: -3, PBSH: -6, PPRC: -1, PPRS: -1, PCTH: -13, SPCT: -8, PPBK: -33, PRBK: -29 },
  19: { PKPR: 10, PKAC: 10, PTAK: -45, PSPD: -20 },
};
const shapeOf = (pos: number) => SHAPE[pos] ?? SHAPE[pos >= 5 && pos <= 9 ? 5 : pos === 11 ? 10 : pos === 14 || pos === 15 ? 13 : pos === 18 ? 17 : pos === 20 ? 19 : 4]!;
export function roster(tgid: number, quality: number, offBook: number, defBook: number, rng: () => number): TeamInput {
  const counts: Record<number, number> = { 0: 3, 1: 4, 2: 2, 3: 6, 4: 3, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 4, 13: 2, 14: 3, 15: 2, 16: 5, 17: 2, 18: 2, 19: 1, 20: 1 };
  const players: PlayerInput[] = []; let id = tgid * 1000; const depth: TeamInput['depthChart'] = [];
  for (const [pos, n] of Object.entries(counts)) for (let d = 0; d < n; d++) {
    const ovr = Math.round(quality - d * 5 + (rng() - 0.5) * 8); const sh = shapeOf(Number(pos)); const ratings: Record<string, number> = {};
    for (const k of KEYS) ratings[k] = Math.max(25, Math.min(99, Math.round(ovr + (sh[k] ?? -6) + (rng() - 0.5) * 12)));
    players.push({ id: ++id, name: `${POS[Number(pos)]}${d + 1}`, number: 1 + Math.floor(rng() * 98), pos: Number(pos), overall: ovr, ratings }); depth.push({ pos: Number(pos), depth: d, pgid: id });
  }
  const fastest = players.filter((p) => p.pos === 3).sort((a, b) => b.ratings['PSPD']! - a.ratings['PSPD']!)[0]!; depth.push({ pos: 21, depth: 0, pgid: fastest.id }, { pos: 22, depth: 0, pgid: fastest.id }, { pos: 23, depth: 0, pgid: players.find((p) => p.pos === 19)!.id }, { pos: 24, depth: 0, pgid: players.find((p) => p.pos === 7)!.id });
  return { id: tgid, name: `Team ${tgid}`, abbr: `T${tgid}`, logo: '', offBook, defBook, players, depthChart: depth };
}
