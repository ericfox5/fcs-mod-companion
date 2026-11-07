// Teams the game keeps no roster for (the five generic FCS slots, TEAM.TTYP 1: the FCS mod's Mercyhurst, West
// Florida, Wagner, Tuskegee and Delta State) get a placeholder roster so Supersim can play them: 54 low-rated players
// generated deterministically per dynasty/season/team, with ids above SYNTHETIC_PGID_BASE so nothing about them is
// ever sent to the console (result.ts drops their lines). autoDepthChart also covers real rosters whose DCHT rows are
// missing: best available by overall, then related positions, the same fallback order the engine uses.
import { DEPTH_SLOTS } from '@ncaa/ncaa14';
import { GROUP } from './coach/engine.js';
import { headshotUrl } from '../pages/common.js';
import type { PlayerInput } from './coach/types.js';

export const SYNTHETIC_PGID_BASE = 900000;
// slots per synthetic team above the base; a site-only layout, independent of the game's PGID_STRIDE (packages/ncaa14 roster.ts)
export const SYNTHETIC_TEAM_STRIDE = 100;
export const isSynthetic = (pgid: number) => pgid >= SYNTHETIC_PGID_BASE;

export function autoDepthChart(players: PlayerInput[]): { pos: number; depth: number; pgid: number }[] {
  const out: { pos: number; depth: number; pgid: number }[] = [];
  const byOverall = (a: PlayerInput, b: PlayerInput) => b.overall - a.overall;
  for (const [posS, slots] of Object.entries(DEPTH_SLOTS)) {
    const pos = Number(posS); const used = new Set<number>();
    const order = [pos, ...(GROUP[pos] ?? [])].filter((p, i, a) => a.indexOf(p) === i);
    const cands = [...order.flatMap((p) => players.filter((x) => x.pos === p).sort(byOverall)), ...players.slice().sort(byOverall)]; // last resort: anyone, like the engine
    for (let depth = 0; depth < slots; depth++) {
      const pick = cands.find((p) => !used.has(p.id)); if (!pick) break;
      used.add(pick.id); out.push({ pos, depth, pgid: pick.id });
    }
  }
  return out;
}

const FIRST = ['Marcus', 'Devin', 'Tyler', 'Jalen', 'Caleb', 'Isaiah', 'Brandon', 'Logan', 'Darius', 'Trevor', 'Malik', 'Austin', 'Jordan', 'Cameron', 'Elijah', 'Nathan', 'Dominic', 'Xavier', 'Kyle', 'Andre', 'Connor', 'Jamal', 'Ryan', 'Terrell', 'Evan', 'Micah', 'Shane', 'Donovan', 'Luis', 'Grant', 'Tariq', 'Owen', 'Deshawn', 'Colin', 'Rashad', 'Jake', 'Keenan', 'Wyatt', 'Darnell', 'Chase'];
const LAST = ['Johnson', 'Williams', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin', 'Thompson', 'Robinson', 'Clark', 'Lewis', 'Walker', 'Hall', 'Allen', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson', 'Carter', 'Mitchell', 'Perez', 'Roberts', 'Turner', 'Phillips', 'Campbell', 'Parker', 'Evans', 'Edwards', 'Collins', 'Stewart', 'Morris', 'Murphy', 'Cook', 'Rogers', 'Reed', 'Bell', 'Cooper', 'Richardson', 'Cox', 'Howard', 'Ward', 'Brooks', 'Bennett', 'Gray', 'James', 'Hughes', 'Price', 'Sanders', 'Myers'];
// 54 players: depth-chart needs plus a little cover at every position
const TEMPLATE: [number, number][] = [[0, 3], [1, 4], [2, 2], [3, 6], [4, 3], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 4], [13, 2], [14, 3], [15, 2], [16, 5], [17, 2], [18, 2], [19, 1], [20, 1]];
const KEYS = ['PSPD', 'PACC', 'PAGI', 'PSTR', 'PAWR', 'PCTH', 'PCAR', 'PBTK', 'PTRK', 'PJMP', 'PTHA', 'PTHP', 'PRBK', 'PPBK', 'PRBS', 'PPBS', 'PIBL', 'PPBF', 'PPMV', 'PFMV', 'PBSH', 'PPRS', 'PTAK', 'PHIT', 'PPRC', 'PZCV', 'PMCV', 'PBCV', 'PRTR', 'PESV', 'PJMV', 'PSMV', 'PKPR', 'PKAC', 'PSTA', 'PINJ', 'PKRT', 'PBFW', 'PSAR', 'PYRS'];
// what each position is good at (added to the base); everything else sits at the base
const EMPHASIS: Record<number, string[]> = { 0: ['PTHA', 'PTHP', 'PAWR', 'PPBF'], 1: ['PSPD', 'PACC', 'PAGI', 'PBTK', 'PCAR', 'PESV', 'PJMV'], 2: ['PSTR', 'PRBK', 'PIBL', 'PTRK', 'PCAR'], 3: ['PSPD', 'PACC', 'PCTH', 'PRTR', 'PJMP', 'PAGI'], 4: ['PCTH', 'PRBK', 'PSTR', 'PRTR'],
  5: ['PSTR', 'PPBK', 'PRBK', 'PPBS', 'PRBS', 'PIBL', 'PPBF'], 6: ['PSTR', 'PRBK', 'PPBK', 'PRBS', 'PPBS', 'PIBL'], 7: ['PSTR', 'PRBK', 'PPBK', 'PAWR', 'PIBL'], 8: ['PSTR', 'PRBK', 'PPBK', 'PRBS', 'PPBS', 'PIBL'], 9: ['PSTR', 'PPBK', 'PRBK', 'PPBS', 'PRBS', 'PPBF'],
  10: ['PSTR', 'PPMV', 'PFMV', 'PBSH', 'PPRS', 'PTAK'], 11: ['PSTR', 'PPMV', 'PFMV', 'PBSH', 'PPRS', 'PTAK'], 12: ['PSTR', 'PBSH', 'PPMV', 'PTAK', 'PHIT'], 13: ['PTAK', 'PHIT', 'PPRC', 'PBSH', 'PZCV'], 14: ['PTAK', 'PHIT', 'PPRC', 'PAWR', 'PBSH'], 15: ['PTAK', 'PHIT', 'PPRC', 'PBSH', 'PZCV'],
  16: ['PSPD', 'PACC', 'PAGI', 'PMCV', 'PZCV', 'PPRC', 'PJMP'], 17: ['PZCV', 'PPRC', 'PSPD', 'PTAK', 'PHIT'], 18: ['PHIT', 'PTAK', 'PZCV', 'PPRC', 'PSTR'], 19: ['PKPR', 'PKAC'], 20: ['PKPR', 'PKAC'] };
const NUMBERS: Record<number, [number, number]> = { 0: [1, 19], 1: [20, 39], 2: [30, 49], 3: [80, 89], 4: [80, 89], 5: [60, 79], 6: [60, 79], 7: [50, 69], 8: [60, 79], 9: [60, 79], 10: [90, 99], 11: [90, 99], 12: [90, 99], 13: [40, 59], 14: [40, 59], 15: [40, 59], 16: [20, 39], 17: [20, 39], 18: [20, 39], 19: [1, 19], 20: [1, 19] };
const MISSING_FACES = new Set([100, 101, 102, 103, 104, 125, 197]);

function hash32(s: string): number { let h = 0x811c9dc5; for (const c of new TextEncoder().encode(s)) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function rngFrom(seed: string): () => number { let s = hash32(seed); return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// A low-attribute placeholder roster, like the game's own generic opponents: starters around the low 60s, backups in the 50s.
export function syntheticRoster(tgid: number, seed: string): PlayerInput[] {
  const rng = rngFrom(`${seed}:${tgid}`); const out: PlayerInput[] = []; const numbers = new Set<number>();
  const clamp = (v: number) => Math.max(25, Math.min(80, Math.round(v)));
  let i = 0;
  for (const [pos, count] of TEMPLATE) {
    for (let depth = 0; depth < count; depth++, i++) {
      const base = (depth === 0 ? 61 : depth === 1 ? 55 : 50) + (rng() - 0.5) * 8;
      const ratings: Record<string, number> = {};
      for (const k of KEYS) ratings[k] = clamp(base + (EMPHASIS[pos]?.includes(k) ? 10 + rng() * 8 : (rng() - 0.5) * 10));
      ratings.POVR = clamp(base);
      let number = 0; const [lo, hi] = NUMBERS[pos] ?? [1, 99];
      for (let tries = 0; tries < 50 && (number === 0 || numbers.has(number)); tries++) number = lo + Math.floor(rng() * (hi - lo + 1));
      numbers.add(number);
      let head = 1 + Math.floor(rng() * 246); if (MISSING_FACES.has(head)) head = 1;
      out.push({ id: SYNTHETIC_PGID_BASE + tgid * SYNTHETIC_TEAM_STRIDE + i, name: `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`, number, pos, overall: ratings.POVR, ratings, photoUrl: headshotUrl({ head_id: head }) });
    }
  }
  return out;
}
