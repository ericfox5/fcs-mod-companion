// Quick sanity check of the decoded export: node tools/check-export.ts <USR-DATA> [tgid]
import { readFileSync } from 'node:fs';
import { parseTdb } from '@ncaa/tdb';
import { exportDynasty, isPlayed } from '@ncaa/ncaa14';
const [, , path = 'fixtures/real/BLUS31159-DYNASTY-2/USR-DATA', tgidArg = '18'] = process.argv;
const ex = exportDynasty(parseTdb(new Uint8Array(readFileSync(path))));
const t = ex.teams.find((x) => x.tgid === Number(tgidArg))!;
console.log(`${t.name}: ${t.wins}-${t.losses} overall, ${t.confWins}-${t.confLosses} conference, ${t.allTimeWins}-${t.allTimeLosses} all-time, BCS #${t.rankBcs}`);
console.log('conference:', ex.teams.filter((x) => x.cgid === t.cgid).sort((a, b) => b.confWins - a.confWins).map((x) => `${x.abbr} ${x.confWins}-${x.confLosses}`).join(', '));
console.log('played games:', ex.schedule.filter((g) => isPlayed(g.status)).length, 'of', ex.schedule.length);
