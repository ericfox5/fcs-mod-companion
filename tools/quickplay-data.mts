// Quickplay data: the FCS2026 roster as static files the site can play a Supersim game from with no dynasty.
//
//   npx tsx tools/quickplay-data.mts [save]
//
// Reads the roster save (default: the roster builder's output, or SUPERSIM_SAVE) and writes, under
// worker/public/data/quickplay/:
//   index.json   every team: name, colours, logo key, conference, playbooks, the odds model's unit grades and its best
//                player (for the figures on the matchup board)
//   <tgid>.json  the team as engine input: players with ratings, the save's depth chart
// Run again after each roster rebuild. The output is git-ignored (it is derived from the roster save).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdb } from '@ncaa/tdb';
import { decodeDepthChart, decodePlayers, decodeTeams, positionName, teamUnits } from '@ncaa/ncaa14';
import * as N from '@ncaa/ncaa14';
import { openDynastyFile } from '../bridge/src/od.ts';
import { loadLogoMap, normLogoName } from '../bridge/src/logos.ts';
import { keyRatings } from '../worker/src/pages/player-keys.ts';
import { UNIFORMS } from '../worker/src/pages/uniforms.generated.ts';
import type { BookIndex, TeamInput } from '../worker/src/supersim/coach/types.ts';
import { DEFAULT_SAVE } from './supersim-real.mts';

const save = process.argv[2] ?? DEFAULT_SAVE;
const BOOK_DIR = 'worker/public/data/playbooks', OUT = 'worker/public/data/quickplay';
if (!existsSync(save)) throw new Error(`no save at ${save}`);
if (!existsSync(join(BOOK_DIR, 'index.json'))) throw new Error('playbooks missing: run npx tsx tools/playbooks-extract.mts first');
const bytes = new Uint8Array(readFileSync(save));
const file = bytes[0] === 0x44 && bytes[1] === 0x42 ? parseTdb(bytes) : openDynastyFile(bytes).file;
const index = JSON.parse(readFileSync(join(BOOK_DIR, 'index.json'), 'utf8')) as BookIndex;
const logos = loadLogoMap();
const players = decodePlayers(file), chart = decodeDepthChart(file);
const confs = new Map<number, string>(); try { for (const c of (N as unknown as { decodeConferences: (f: unknown) => { cgid: number; name: string }[] }).decodeConferences(file)) confs.set(c.cgid, c.name); } catch { /* labels only */ }
const hex = (r: Record<string, unknown>, keys: string[]) => { const c = keys.map((k) => Number(r[k])); return c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}` : null; };

if (existsSync(OUT)) for (const f of readdirSync(OUT)) rmSync(join(OUT, f)); else mkdirSync(OUT, { recursive: true });
const out: unknown[] = []; let bytesOut = 0;
for (const t of decodeTeams(file)) {
  const ps = players.filter((p) => p.tgid === t.tgid && p.redshirt !== 1);
  if (ps.length < 40) continue;
  const topb = Number(t.raw['TOPB']), tdpb = Number(t.raw['TDPB']);
  const off = index.books.find((b) => b.side === 'off' && b.bgid === topb) ?? index.books.find((b) => b.side === 'off' && b.name === 'Multiple') ?? index.books.find((b) => b.side === 'off')!;
  const def = index.books.find((b) => b.side === 'def' && b.bgid === tdpb) ?? index.books.find((b) => b.side === 'def' && b.name === '4-3') ?? index.books.find((b) => b.side === 'def')!;
  const ids = new Set(ps.map((p) => p.pgid));
  const depthChart = chart.filter((d) => d.tgid === t.tgid && ids.has(d.pgid)).map((d) => ({ pos: d.pos, depth: d.depth, pgid: d.pgid }));
  const logoKey = (logos.teams[normLogoName(t.name)] ?? logos.teams[normLogoName(t.longName)] ?? logos.teams[normLogoName(`${t.name} ${t.mascot}`)])?.key ?? null;
  const primary = hex(t.raw, ['TBCR', 'TBCG', 'TBCB']) ?? '#1d1d1d', secondary = hex(t.raw, ['TB2R', 'TB2G', 'TB2B']) ?? '#ffffff';
  // kits: both of the team's uniform sets; the browser picks Home or Away for the game (client/quickplay.mjs)
  const team: TeamInput & { kits?: unknown } = {
    id: t.tgid, name: t.name, abbr: t.abbr, logo: logoKey ? `/img/logos/${logoKey.replace(/^teams[/]/, 'teams160/')}` : '', color: primary, ...(UNIFORMS[t.tgid] ? { kits: UNIFORMS[t.tgid] } : {}), offBook: off.id, defBook: def.id,
    players: ps.map((p) => ({ id: p.pgid, name: `${p.firstName} ${p.lastName}`, number: p.jersey, pos: p.pos, overall: p.overall, ratings: p.ratings, photoUrl: p.headId ? `/img/faces/${p.headId}.png` : '/img/faces/0.png' })),
    depthChart,
  };
  const json = JSON.stringify(team); writeFileSync(join(OUT, `${t.tgid}.json`), json); bytesOut += json.length;
  const best = ps.slice().sort((a, b) => b.overall - a.overall)[0]!; const top = keyRatings(best.pos, JSON.stringify(best.ratings)).sort((a, b) => b.value - a.value)[0];
  out.push({
    id: t.tgid, name: t.name, abbr: t.abbr, mascot: t.mascot, conf: confs.get(t.cgid) ?? t.conferenceLabel ?? '', primary, secondary, logoKey, offBook: off.id, defBook: def.id,
    overall: Math.round(ps.map((p) => p.overall).sort((a, b) => b - a).slice(0, 22).reduce((a, b) => a + b, 0) / 22),
    units: teamUnits(ps.map((p) => ({ id: p.pgid, pos: p.pos, overall: p.overall, ratings: p.ratings })), depthChart),
    star: { pgid: best.pgid, name: `${best.firstName} ${best.lastName}`, pos: positionName(best.pos), number: best.jersey, headId: best.headId ?? 0, stat: top ? `${top.value} ${top.long}` : `${best.overall} overall` },
  });
}
(out as { name: string }[]).sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(OUT, 'index.json'), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), roster: 'FCS 2026', teams: out }));
console.log(`${out.length} teams -> ${OUT} (${(bytesOut / 1024 / out.length).toFixed(0)} KB per team, ${(bytesOut / 1048576).toFixed(1)} MB in all)`);
console.log(`no logo: ${(out as { name: string; logoKey: string | null }[]).filter((t) => !t.logoKey).map((t) => t.name).join(', ') || 'none'}`);
