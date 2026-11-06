// Key numbers per position for compact player cards (the Transfer Portal's expanded rows): the ratings that matter for
// the position (codes as stored in players.ratings_json, i.e. PLAY fields; NCAA 14 names differ from Madden's, e.g.
// PRTR route running, PYRS press, PPRS pursuit, PESV elusiveness, TRAF catch in traffic) and the season-stat line from
// player_season_stats (PSOF offense, PSDE defense, PSKI kicking/punting, PSKP returns, PSOL blocking; columns as in
// pages/stats.ts).
import { html, type Raw } from '../html.js';

type Group = 'QB' | 'HB' | 'FB' | 'WR' | 'TE' | 'OL' | 'DL' | 'LB' | 'CB' | 'S' | 'K' | 'P';
// position codes: 0 QB 1 HB 2 FB 3 WR 4 TE 5-9 OL 10-12 DL 13-15 LB 16 CB 17-18 S 19 K 20 P
export const posGroup = (pos: number): Group =>
  pos === 0 ? 'QB' : pos === 1 ? 'HB' : pos === 2 ? 'FB' : pos === 3 ? 'WR' : pos === 4 ? 'TE' : pos <= 9 ? 'OL' : pos <= 12 ? 'DL' : pos <= 15 ? 'LB' : pos === 16 ? 'CB' : pos <= 18 ? 'S' : pos === 19 ? 'K' : 'P';

const R: Record<string, [string, string]> = {
  PSPD: ['SPD', 'Speed'], PACC: ['ACC', 'Acceleration'], PAGI: ['AGI', 'Agility'], PSTR: ['STR', 'Strength'], PAWR: ['AWR', 'Awareness'],
  PTHP: ['THP', 'Throw power'], PTHA: ['THA', 'Throw accuracy'], PCAR: ['CAR', 'Carrying'], PBTK: ['BTK', 'Break tackle'], PTRK: ['TRK', 'Trucking'],
  PESV: ['ELU', 'Elusiveness'], PBCV: ['BCV', 'Ball carrier vision'], PCTH: ['CTH', 'Catching'], TRAF: ['CIT', 'Catch in traffic'], SPCT: ['SPC', 'Spectacular catch'],
  PRTR: ['RTE', 'Route running'], RELS: ['RLS', 'Release'], PTAK: ['TAK', 'Tackle'], PHIT: ['POW', 'Hit power'], PPMV: ['PMV', 'Power moves'],
  PFMV: ['FMV', 'Finesse moves'], PBSH: ['BSH', 'Block shedding'], PPRS: ['PUR', 'Pursuit'], PPRC: ['PRC', 'Play recognition'], PMCV: ['MCV', 'Man coverage'],
  PZCV: ['ZCV', 'Zone coverage'], PYRS: ['PRS', 'Press'], PRBK: ['RBK', 'Run blocking'], PPBK: ['PBK', 'Pass blocking'], PIBL: ['IBL', 'Impact blocking'],
  PKPR: ['KPW', 'Kick power'], PKAC: ['KAC', 'Kick accuracy'],
};
const KEY_RATINGS: Record<Group, string[]> = {
  QB: ['PTHP', 'PTHA', 'PAWR', 'PSPD', 'PAGI', 'PBCV'],
  HB: ['PSPD', 'PACC', 'PESV', 'PBTK', 'PCAR', 'PBCV'],
  FB: ['PRBK', 'PIBL', 'PTRK', 'PSTR', 'PCAR', 'PCTH'],
  WR: ['PSPD', 'PCTH', 'PRTR', 'TRAF', 'SPCT', 'RELS'],
  TE: ['PCTH', 'PRBK', 'PSPD', 'PSTR', 'PRTR', 'TRAF'],
  OL: ['PRBK', 'PPBK', 'PSTR', 'PAWR', 'PIBL', 'PAGI'],
  DL: ['PPMV', 'PFMV', 'PBSH', 'PSTR', 'PPRS', 'PTAK'],
  LB: ['PTAK', 'PPRS', 'PPRC', 'PHIT', 'PZCV', 'PSPD'],
  CB: ['PSPD', 'PMCV', 'PZCV', 'PYRS', 'PAGI', 'PPRC'],
  S: ['PSPD', 'PZCV', 'PMCV', 'PPRC', 'PTAK', 'PHIT'],
  K: ['PKPR', 'PKAC', 'PAWR'],
  P: ['PKPR', 'PKAC', 'PAWR'],
};

type Stats = Partial<Record<'PSOF' | 'PSDE' | 'PSKI' | 'PSKP' | 'PSOL', Record<string, number>>>;
type Cell = [label: string, value: string];
const n = (v: number | undefined) => v ?? 0;
const fmt = (v: number) => v.toLocaleString('en-US');
const avg = (yds: number, att: number) => (att ? (yds / att).toFixed(1) : '0.0');
const pct = (m: number, a: number) => (a ? ((m / a) * 100).toFixed(1) : '0.0');
function statCells(g: Group, s: Stats): Cell[] {
  const o = s.PSOF ?? {}, d = s.PSDE ?? {}, k = s.PSKI ?? {}, b = s.PSOL ?? {};
  const rush: Cell[] = [['Rush', fmt(n(o.suat))], ['Rush yds', fmt(n(o.suya))], ['Avg', avg(n(o.suya), n(o.suat))], ['Rush TD', String(n(o.sutd))]];
  const rec: Cell[] = [['Rec', fmt(n(o.scca))], ['Rec yds', fmt(n(o.scya))], ['Avg', avg(n(o.scya), n(o.scca))], ['Rec TD', String(n(o.sctd))]];
  const def: Cell[] = [['Tkl', fmt(n(d.sdta))], ['TFL', String(n(d.sdtl))], ['Sack', String(n(d.slsk))], ['INT', String(n(d.ssin))], ['PD', String(n(d.sdpd))], ['FF', String(n(d.slff))]];
  switch (g) {
    case 'QB': return [['Cmp/Att', `${n(o.sacm)}/${n(o.saat)}`], ['Pct', pct(n(o.sacm), n(o.saat))], ['Pass yds', fmt(n(o.saya))], ['TD', String(n(o.satd))], ['INT', String(n(o.sain))], ['Rush yds', fmt(n(o.suya))]];
    case 'HB': return [...rush, ['Rec', fmt(n(o.scca))], ['Rec yds', fmt(n(o.scya))]];
    case 'FB': return [['Rush', fmt(n(o.suat))], ['Rush yds', fmt(n(o.suya))], ['Rush TD', String(n(o.sutd))], ['Rec', fmt(n(o.scca))], ['Pancakes', String(n(b.sopa))]];
    case 'WR': case 'TE': return [...rec, ['YAC', fmt(n(o.scyc))], ['Drops', String(n(o.scdr))]];
    case 'OL': return [['Pancakes', String(n(b.sopa))], ['Sacks allowed', String(n(b.sosa))]];
    case 'DL': case 'LB': case 'CB': case 'S': return def;
    case 'K': return [['FG', `${n(k.skfm)}/${n(k.skfa)}`], ['FG pct', pct(n(k.skfm), n(k.skfa))], ['Long', String(n(k.skfL))], ['XP', `${n(k.skem)}/${n(k.skea)}`]];
    case 'P': return [['Punts', String(n(k.spat))], ['Avg', avg(n(k.spya), n(k.spat))], ['Long', String(n(k.splN))], ['Yds', fmt(n(k.spya))]];
  }
}

// The season line for a player: games played plus the position's columns, and a return line when he returned kicks.
export function keyStats(pos: number, s: Stats): { games: number; cells: Cell[] } | null {
  const games = Math.max(...Object.values(s).map((x) => n(x?.sgmp)), 0);
  if (!games && !Object.keys(s).length) return null;
  const cells = statCells(posGroup(pos), s);
  const r = s.PSKP;
  if (r && n(r.srka) + n(r.srpa) > 0) cells.push(['Ret yds', fmt(n(r.srky) + n(r.srpy))]);
  return { games, cells };
}
export function keyRatings(pos: number, ratingsJson: string | null): { code: string; short: string; long: string; value: number }[] {
  let r: Record<string, number> = {};
  try { r = JSON.parse(ratingsJson || '{}'); } catch { /* none */ }
  return KEY_RATINGS[posGroup(pos)].filter((c) => typeof r[c] === 'number').map((c) => ({ code: c, short: R[c]![0], long: R[c]![1], value: r[c]! }));
}

// Rating tier for the bar colour (ESPN-ish: 90+ elite, 80s good, 70s average, below that weak).
export const tier = (v: number) => (v >= 90 ? 'a' : v >= 80 ? 'b' : v >= 70 ? 'c' : 'd');
export const ratingBars = (list: { short: string; long: string; value: number }[], cls = ''): Raw => html`<ul class="kr ${cls}">${list.map((x) => html`<li title="${x.long}"><span class="kr-l">${x.short}</span><span class="kr-bar"><i class="t-${tier(x.value)}" style="width:${x.value}%"></i></span><b>${x.value}</b></li>`)}</ul>`;
export const statTiles = (cells: Cell[]): Raw => html`<dl class="ks-tiles">${cells.map(([l, v]) => html`<div><dt>${l}</dt><dd>${v}</dd></div>`)}</dl>`;
