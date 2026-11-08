// "Boss mode" for swapped-in FBS teams: every player ends up 97-99. The game recomputes a player's overall from his
// ratings, so POVR alone would not stick: each row's position formula (ovr-formulas.ts) is raised on its heaviest
// fields (capped at 99) until floor(OVR) reaches the target, then POVR / PIMP are set to it. Targets keep the donor's
// order: the team's top third by original overall gets 99, the middle third 98, the rest 97.
import { OVR_FORMULAS, type OvrFormula } from './ovr-formulas.js';

const formulaFor = (ppos: number): OvrFormula | undefined => OVR_FORMULAS[ppos === 24 ? 4 : ppos]; // LS: TE formula
export function ovrOf(row: Record<string, unknown>, ppos: number): number | null {
  const f = formulaFor(ppos); if (!f) return null;
  return f.vars.reduce((s, [k, w]) => s + Number(row[k] ?? 0) * w, 0) + f.adjustment;
}
// targets by original overall rank within the team: [97, 99]
export function boostTargets(rows: { key: number; ovr: number }[]): Map<number, number> {
  const sorted = [...rows].sort((a, b) => b.ovr - a.ovr || a.key - b.key), out = new Map<number, number>();
  sorted.forEach((r, i) => out.set(r.key, i < sorted.length / 3 ? 99 : i < (2 * sorted.length) / 3 ? 98 : 97));
  return out;
}
// the field changes that bring a row to `target` (fields the formula uses only; nothing above 99 or below its value).
// The formula approximates the game's (PHOENIX26's stored overalls match it within 2 on about two thirds of the rows),
// so the ratings aim one point above the target and POVR is set to the target.
export function boostRow(row: Record<string, unknown>, ppos: number, target: number): Record<string, number> {
  const f = formulaFor(ppos), out: Record<string, number> = {}; if (!f) return { POVR: target };
  const aim = target + 1;
  const cur: Record<string, number> = {}; for (const [k] of f.vars) cur[k] = Number(row[k] ?? 0);
  const score = () => f.vars.reduce((s, [k, w]) => s + cur[k]! * w, 0) + f.adjustment;
  for (const [k, w] of [...f.vars].sort((a, b) => b[1] - a[1])) {
    const need = aim - score(); if (need <= 0) break;
    const add = Math.min(99 - cur[k]!, Math.ceil(need / w)); if (add > 0) cur[k] = cur[k]! + add;
  }
  // a little over is fine (floor must reach the target); settle any field that can come back down without dropping below
  for (const [k, w] of [...f.vars].sort((a, b) => a[1] - b[1])) { while (cur[k]! > Number(row[k] ?? 0) && score() - w >= aim) cur[k] = cur[k]! - 1; }
  for (const [k] of f.vars) if (cur[k] !== Number(row[k] ?? 0)) out[k] = cur[k]!;
  const reached = Math.min(99, Math.floor(score() + 1e-9));
  out.POVR = Math.max(Number(row.POVR ?? 0), Math.min(target, reached)); if ('PIMP' in row) out.PIMP = out.POVR;
  return out;
}
