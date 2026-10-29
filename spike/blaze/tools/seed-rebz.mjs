// Experiment W2 (recruiting write-back): seeds private/web-edits/<did>/REBZ.json with the member team's current board
// (the console's last RECB push) in the RECB column layout, with ONE change: extra recruiting points on one prospect.
// Usage: node seed-rebz.mjs <did> <tgid> [prsi] [points]      (delete the file to undo)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PRIVATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private');
const [did = '6', tgidArg = '40', prsiArg, pointsArg] = process.argv.slice(2);
const tgid = Number(tgidArg);
const recb = JSON.parse(fs.readFileSync(path.join(PRIVATE, 'dynasty-tables', did, 'RECB.json'), 'utf8'));
const rcpt = JSON.parse(fs.readFileSync(path.join(PRIVATE, 'dynasty-tables', did, 'RCPT.json'), 'utf8'));
const names = new Map(rcpt.rows.map((r) => [r.PRSI, `${r.PFNA} ${r.PLNA} (${r.RCCB}* rank ${r.RCRK})`]));
const board = recb.rows.filter((r) => r.TGID === tgid);
if (!board.length) throw new Error(`no RECB rows for team ${tgid}`);
const pick = prsiArg ? board.find((r) => r.PRSI === Number(prsiArg)) : [...board].sort((a, b) => a.PROR - b.PROR).find((r) => r.PPSC === 0); // highest board slot with no points this week, so the effect is clearly ours
if (!pick) throw new Error('prospect not on the board');
const before = pick.PPSC;
pick.PPSC = Number(pointsArg ?? 250);
const out = { table: 'REBZ', columns: { SINT: ['PSCP', 'PPSC', 'PPSL', 'TGID', 'PRSI'], TINT: ['USEL', 'PROR', 'PEPV'] }, rows: board, meta: { type: 0, flty: 1, seededAt: Math.floor(Date.now() / 1000), note: `W2: PRSI ${pick.PRSI} ${names.get(pick.PRSI) ?? ''} PPSC ${before} -> ${pick.PPSC}` } };
const dir = path.join(PRIVATE, 'web-edits', did);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'REBZ.json'), JSON.stringify(out));
console.log(`team ${tgid}: ${board.length} board rows; ${out.meta.note} -> ${path.join(dir, 'REBZ.json')}`);
