// Experiment W1 (web -> console write-back): seeds private/web-edits/<did>/PLYZ.json from the console's own PLYZ push
// (the user's team players) with ONE visible change, a jersey number, so the next advance shows whether rows served
// through GetTableUpdate reach the game. Usage: node seed-web-edit.mjs <did> [pgid] [newJersey]   (delete the file to undo)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PRIVATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private');
const [did = '6', pgidArg, jerseyArg] = process.argv.slice(2);
const src = JSON.parse(fs.readFileSync(path.join(PRIVATE, 'dynasty-tables', did, 'PLYZ.json'), 'utf8'));
const byId = new Map();
for (const r of src.rows) byId.set(r.PGID, r); // the console pushed the roster more than once; the last row per player wins
const rows = [...byId.values()];
const team = rows[0]?.TGID;
const pick = pgidArg ? byId.get(Number(pgidArg)) : [...rows].sort((a, b) => a.POVR - b.POVR)[0]; // lowest-rated player by default
if (!pick) throw new Error('no such player in PLYZ');
const before = pick.PJEN;
const used = new Set(rows.map((r) => r.PJEN));
let jersey = jerseyArg ? Number(jerseyArg) : 99;
while (used.has(jersey) && !jerseyArg) jersey--;
pick.PJEN = jersey;
const out = { table: 'PLYZ', columns: src.columns, rows, meta: { type: src.meta?.type ?? 1, flty: src.meta?.flty ?? 1, seededAt: Math.floor(Date.now() / 1000), note: `W1: PGID ${pick.PGID} ${pick.PFNA} ${pick.PLNA} jersey ${before} -> ${jersey}` } };
const dir = path.join(PRIVATE, 'web-edits', did);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'PLYZ.json'), JSON.stringify(out));
console.log(`team ${team}: ${rows.length} players; ${out.meta.note} (POVR ${pick.POVR}, POS ${pick.PPOS}) -> ${path.join(dir, 'PLYZ.json')}`);
