#!/usr/bin/env node
// ncaa-bridge: inspect / verify / diff NCAA 14 save databases (more commands arrive with later milestones).
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { parseTdb, verifyTdb, type TdbFile, type FieldValue } from '@ncaa/tdb';
import { exportDynasty, isPlayed } from '@ncaa/ncaa14';
import { loadConfig } from './config.js';
import { importSave } from './commands/import.js';
import { odImport, odList, odWatch, syncWebEdits, odBackfillLogs, odOverhaul, odYear, odLock, odPlayoff, odStride, odPlayers, odRepair, odCaptains } from './commands/od.js';
import { syncCaptures } from './commands/captures.js';
import { loadOdStore } from './od.js';
import { photosUpload } from './commands/photos.js';
import { odInvite } from './commands/invite.js';
import { logosUpload } from './commands/logos.js';
import { rosterGrow, rosterAdd, rosterStars } from './commands/roster.js';
import { stdaCli } from './stda.js';
import { scorebugCli } from './scorebug.js';
import { swapCli } from './swap/cli.js';
import { genericCli } from './commands/generic.js';
import { depthCli } from './commands/depth.js';
import { playbookCli } from './commands/playbook.js';

const [, , cmd, ...rest] = process.argv;
const flags = new Map<string, string>();
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith('--')) { const v = rest[i + 1]; if (v !== undefined && !v.startsWith('--')) { flags.set(a.slice(2), v); i++; } else flags.set(a.slice(2), 'true'); }
  else args.push(a);
}
const load = (p: string): [Uint8Array, TdbFile] => { const b = new Uint8Array(readFileSync(p)); return [b, parseTdb(b)]; };
const typeName = (t: number) => ({ 0: 'str', 1: 'bin', 2: 'sint', 3: 'uint', 4: 'float', 13: 'vc1', 14: 'vc2' } as Record<number, string>)[t] ?? `t${t}`;

function info(path: string) {
  const [bytes, f] = load(path);
  console.log(`${path}: ${bytes.length} bytes, dbSize ${f.header.dbSize}, ${f.tables.length} tables, endian ${f.header.endian}`);
  const problems = verifyTdb(bytes, f);
  console.log(problems.length === 0 ? 'checksums: OK' : `checksums: ${problems.length} problems`);
  for (const t of f.tables) {
    console.log(`${(t.name || '????').padEnd(4)} alloc=${String(t.header.allocType).padStart(2)} rec=${String(t.header.currentRecords).padStart(5)}/${String(t.header.maxRecords).padEnd(5)} bytes=${String(t.header.lengthBytes).padStart(3)} fields=${String(t.fields.length).padStart(3)} idx=${t.header.indexCount}`);
  }
}

function dump(path: string, tables: string[]) {
  const [, f] = load(path);
  const rows = Number(flags.get('rows') ?? 3);
  const json = flags.has('json');
  for (const name of tables) {
    const t = f.table(name);
    if (!json) {
      console.log(`== ${name}: ${t.recordCount} records (${t.header.maxRecords} max), ${t.header.lengthBytes} bytes/record, alloc ${t.header.allocType}`);
      console.log('fields: ' + t.fields.map((x) => `${x.name}:${typeName(x.type)}${x.bits}`).join(' '));
    }
    const out: Record<string, FieldValue>[] = [];
    for (let i = 0; i < Math.min(rows, t.recordCount); i++) out.push(t.row(i));
    if (json) console.log(JSON.stringify({ table: name, records: t.recordCount, fields: t.fields.map((x) => ({ name: x.name, type: typeName(x.type), bits: x.bits })), rows: out }, null, 1));
    else for (const r of out) console.log(JSON.stringify(r));
  }
}

function verify(path: string) {
  const [bytes, f] = load(path);
  const problems = verifyTdb(bytes, f);
  if (problems.length === 0) { console.log('OK'); return; }
  for (const p of problems) console.log(`${p.where}: expected ${p.expected.toString(16)} got ${p.actual.toString(16)}`);
  process.exitCode = 1;
}

function diff(a: string, b: string) {
  const [, fa] = load(a);
  const [, fb] = load(b);
  const only = flags.get('table');
  let total = 0;
  for (const ta of fa.tables) {
    if (only && ta.name !== only) continue;
    if (!fb.hasTable(ta.name)) { console.log(`${ta.name}: missing in B`); continue; }
    const tb = fb.table(ta.name);
    const changes: string[] = [];
    if (ta.header.allocType !== tb.header.allocType) changes.push(`allocType ${ta.header.allocType}->${tb.header.allocType}`);
    if (ta.recordCount !== tb.recordCount) changes.push(`records ${ta.recordCount}->${tb.recordCount}`);
    const n = Math.min(ta.recordCount, tb.recordCount);
    let cells = 0;
    const samples: string[] = [];
    for (let i = 0; i < n; i++) {
      for (const fd of ta.fields) {
        if (!tb.fieldMap.has(fd.name)) continue;
        const va = ta.get(i, fd.name), vb = tb.get(i, fd.name);
        if (va !== vb) { cells++; if (samples.length < Number(flags.get('samples') ?? 8)) samples.push(`#${i} ${fd.name}: ${va} -> ${vb}`); }
      }
    }
    if (cells) changes.push(`${cells} cells changed`);
    if (changes.length) { total++; console.log(`${ta.name}: ${changes.join(', ')}`); for (const s of samples) console.log('   ' + s); }
  }
  console.log(`${total} tables differ`);
}

function exportCmd(path: string) {
  const [, f] = load(path);
  const t0 = Date.now();
  const ex = exportDynasty(f);
  const played = ex.schedule.filter((g) => isPlayed(g.status)).length;
  const summary = { season: ex.season.year, week: ex.season.week, teams: ex.teams.length, players: ex.players.length, coaches: ex.coaches.length, games: ex.schedule.length, played, stories: ex.stories.length, recruits: ex.recruits.length, board: ex.recruitingBoard.length, ms: Date.now() - t0 };
  const out = flags.get('out');
  if (out) { const json = JSON.stringify(ex); writeFileSync(out, json); console.log(`wrote ${out} (${(json.length / 1048576).toFixed(1)} MB)`); }
  console.log(JSON.stringify(summary));
}

switch (cmd) {
  case 'import': await importSave(loadConfig(flags), args[0]!, { note: flags.get('note'), files: !flags.has('no-files') }); break;
  case 'logos': await logosUpload(loadConfig(flags, { needSlug: false }), flags.get('dir') ?? 'archive/logos', { force: flags.has('force') }); break; // logos upload --dir <folder with teams/ and conf/>
  case 'invite': await odInvite(loadConfig(flags, { needSlug: false }), { did: flags.has('did') ? Number(flags.get('did')) : undefined, persona: flags.get('persona') ?? '' }); break; // alias of: od invite --did N --persona NAME
  case 'photos': await photosUpload(loadConfig(flags, { needSlug: false }), { force: flags.has('force') }); break; // photos upload [--photos-dir D --faces-dir F --force]
  case 'od': { // online dynasties served by the Blaze stub (spike/blaze/server)
    const cfg = loadConfig(flags, { needSlug: false });
    const did = flags.has('did') ? Number(flags.get('did')) : undefined;
    if (args[0] === 'list') odList(cfg);
    else if (args[0] === 'invite') await odInvite(cfg, { did, persona: flags.get('persona') ?? '' }); // od invite --did N --persona NAME -> join link
    else if (args[0] === 'captures') { const store = loadOdStore(cfg.odDir); for (const d of Object.values(store.dynasties)) if ((did === undefined || d.id === did) && d.fileId) await syncCaptures(cfg, d, undefined, { limit: Number(flags.get('limit') ?? 50) }); }
    else if (args[0] === 'edits') { const store = loadOdStore(cfg.odDir); for (const d of Object.values(store.dynasties)) if ((did === undefined || d.id === did) && d.fileId) await syncWebEdits(cfg, d); }
    else if (args[0] === 'import') await odImport(cfg, { did, files: !flags.has('no-files'), note: flags.get('note'), force: flags.has('force') });
    else if (args[0] === 'backfill-logs') await odBackfillLogs(cfg, { did }); // refill game lines from the dynasty files stored by past imports
    else if (args[0] === 'watch') await odWatch(cfg, { did, interval: Number(flags.get('interval') ?? 5), settle: Number(flags.get('settle') ?? 8), files: !flags.has('no-files') });
    // Fang's Recruit Overhaul: --set-exe <RecruitOverhaul.exe> once, --install-rcat <File04664.DB> [--archive <qkl_fe2ig.ast>] once per RPCS3 install, then od watch runs it on every new class; --run [--did N] [--force] runs it by hand
    else if (args[0] === 'overhaul') await odOverhaul(cfg, { did, setExe: flags.get('set-exe'), clearExe: flags.has('clear-exe'), run: flags.has('run'), force: flags.has('force'), installRcat: flags.get('install-rcat'), restoreRcat: flags.has('restore-rcat'), archive: flags.get('archive'), preview: flags.has('preview') });
    // the calendar year new dynasties start in (the Dynasty Tool's Year Changer, applied through the dynasty-file copy): --default 2025 for every new dynasty, --did N --year 2025 for one at its first preseason
    else if (args[0] === 'year') await odYear(cfg, { did, year: flags.has('year') ? Number(flags.get('year')) : undefined, dflt: flags.get('default') });
    // roster stride (100-player rosters): status, or queue a re-keyed dynasty file for one dynasty (docs/roster-stride-inventory.md)
    else if (args[0] === 'stride') await odStride(cfg, { did, stride: flags.has('stride') ? Number(flags.get('stride')) : undefined, off: flags.has('off') });
    // captains a stride re-key left at 70 (TEAM.OCAP/DCAP): status, or queue the fix for one dynasty
    else if (args[0] === 'captains') await odCaptains(cfg, { did, off: flags.has('off') });
    // generated reserve players (100-player roster test): od players --did N --team "Abilene Christian" --fill 100
    else if (args[0] === 'players') await odPlayers(cfg, { did, tgid: flags.has('tgid') ? Number(flags.get('tgid')) : undefined, team: flags.get('team'), fill: flags.has('fill') ? Number(flags.get('fill')) : undefined, prefix: flags.get('prefix'), clear: flags.has('clear') });
    // put a team's roster back from an earlier locker file: od repair --did N --tgid T --from CID [--keep-reserves]
    else if (args[0] === 'repair') await odRepair(cfg, { did, tgid: flags.has('tgid') ? Number(flags.get('tgid')) : undefined, from: flags.has('from') ? Number(flags.get('from')) : undefined, keepReserves: flags.has('keep-reserves') });
    // commissioner recruit lock: keeps a prospect's interest in a team above the commit threshold until he commits there
    else if (args[0] === 'lock') await odLock(cfg, { did, prsi: flags.has('prsi') ? Number(flags.get('prsi')) : undefined, tgid: flags.has('tgid') ? Number(flags.get('tgid')) : undefined, clear: flags.has('clear') });
    // the FCS playoff: status by default; --preview shows the projected field; --on/--off, --autobids "CAA,MVFC" or "default", --reset
    else if (args[0] === 'playoff') await odPlayoff(cfg, { did, on: flags.has('on'), off: flags.has('off'), autobids: flags.get('autobids'), preview: flags.has('preview'), reset: flags.has('reset'), skip: flags.has('skip') ? (flags.get('skip') === 'true' ? '' : flags.get('skip')) : undefined, hold: flags.has('hold') ? (flags.get('hold') === 'true' ? '' : flags.get('hold')) : undefined, release: flags.has('release') });
    else console.log('usage: ncaa-bridge od list | od edits [--did N] | od import [--did N] [--force] [--no-files] [--note N] | od backfill-logs [--did N] | od watch [--did N] [--interval s] [--settle s] | od overhaul [--set-exe EXE | --clear-exe] [--install-rcat DB [--archive AST] | --restore-rcat] [--run [--did N] [--force]] | od year [--default Y|off] [--did N --year Y]   (--od-dir overrides the stub store path)');
    break;
  }
  case 'roster': { // roster files for the 100-player roster project (docs/roster-stride-inventory.md)
    const num = (k: string) => (flags.has(k) ? Number(flags.get(k)) : undefined);
    try {
      if (args[0] === 'grow' && args[2]) rosterGrow(args[1]!, args[2], { stride: num('stride'), from: num('from'), allowOversize: flags.has('allow-oversize') });
      else if (args[0] === 'add' && args[2] && flags.has('tgid')) rosterAdd(args[1]!, args[2], { tgid: Number(flags.get('tgid')), first: flags.get('first') ?? 'New', last: flags.get('last') ?? 'Player', pos: num('pos'), jersey: num('jersey'), template: num('template'), stride: num('stride') });
      else if (args[0] === 'stars' && args[2]) rosterStars(args[1]!, args[2], { allowOversize: flags.has('allow-oversize') });
      else console.log('usage: ncaa-bridge roster grow <in> <out> [--stride 100] [--from 70] [--allow-oversize] | roster add <in> <out> --tgid N --first F --last L [--pos P] [--jersey J] [--template PGID] [--stride S] | roster stars <in> <out> [--allow-oversize]');
    } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
    break;
  }
  case 'stda': try { stdaCli(args[0], flags); } catch (e) { console.error((e as Error).message); process.exitCode = 1; } break; // generic rosters in the game archives: status | rekey | restore
  case 'generic': try { genericCli(args[0], flags); } catch (e) { console.error((e as Error).message); process.exitCode = 1; } break; // generic opponents -> real teams: extract | swap | team | install
  case 'scorebug': try { scorebugCli(args[0], flags); } catch (e) { console.error((e as Error).message); process.exitCode = 1; } break; // the in-game score bug's team names / colours (qkl_patch.ast): status | export | restore
  case 'depth': try { depthCli(args[0], args.slice(1), flags); } catch (e) { console.error((e as Error).message); process.exitCode = 1; } break; // depth charts of any save (RTG, dynasty, roster): show | set
  case 'playbook': try { await playbookCli(args[0], flags, () => loadConfig(flags, { needSlug: false })); } catch (e) { console.error((e as Error).message); process.exitCode = 1; } break; // private playbooks on the console (per-book DBs in qkl_fe2ig.ast): status | add-play | private | sync | export | restore
  case 'swap': try { await swapCli(args[0], args.slice(1), flags); } catch (e) { console.error((e as Error).message); process.exitCode = 1; } break; // FBS team -> generic slot: list | preview | apply | restore | status | stadiums | ui
  case 'export': exportCmd(args[0]!); break;
  case 'info': info(args[0]!); break;
  case 'dump': dump(args[0]!, args.slice(1)); break;
  case 'verify': verify(args[0]!); break;
  case 'diff': diff(args[0]!, args[1]!); break;
  default:
    console.log('usage: ncaa-bridge import <USR-DATA> [--url U --token T --dynasty SLUG --name NAME --note N --no-files] | od list|import|watch [--did N] | roster grow|add ... | depth show|set <save> --team T ... | playbook status|poke|restore ... | info <USR-DATA> | export <USR-DATA> [--out file.json] | dump <USR-DATA> TABLE... [--rows n] [--json] | verify <USR-DATA> | diff <A> <B> [--table T] [--samples n]');
}
