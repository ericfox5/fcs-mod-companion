// ncaa-bridge swap list | preview <tgid> | apply --slot N --donor N | restore --slot N | status | stadiums | ui [--port N]
//   [--rpcs3 DIR] [--cfbr <CFBR ...EASY_INSTALLER...pkg>] [--donors <PHOENIX26 USR-DATA>]
// Defaults: rpcs3Root from ~/.ncaa-bridge/config.json; the CFBR pkg and the PHOENIX26 roster are looked for on the
// Desktop and in Downloads.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { rpcs3RootFromConfig } from '../stda.js';
import { SwapTool, type Step } from './swap.js';
import { startSwapServer } from './server.js';
import { findCfbrPkg, findDonorRoster } from './find.js';
import { exportSwapPack, swapPackSummary } from './pack.js';

const show = (steps: Step[]) => { for (const s of steps) console.log(`${s.status === 'done' ? 'OK  ' : s.status === 'skipped' ? 'skip' : 'FAIL'} ${s.label}: ${s.note}`); if (steps.some((s) => s.status === 'error')) process.exitCode = 1; };

export async function swapCli(sub: string | undefined, args: string[], flags: Map<string, string>): Promise<void> {
  const rpcs3 = flags.get('rpcs3') ?? process.env.NCAA_RPCS3 ?? rpcs3RootFromConfig(); if (!rpcs3) throw new Error('no RPCS3 folder: pass --rpcs3 DIR');
  const donorRoster = flags.get('donors') ?? findDonorRoster(); if (!donorRoster) throw new Error('no donor roster: pass --donors <PHOENIX26 USR-DATA>');
  const tool = new SwapTool({ rpcs3, cfbrPkg: flags.get('cfbr') ?? findCfbrPkg(), donorRoster });
  try {
    if (sub === 'list') for (const d of tool.donors()) console.log(`${String(d.tgid).padStart(3)} ${d.name.padEnd(22)} ${d.abbr.padEnd(6)} ${d.slot} ${d.conference}`);
    else if (sub === 'status' || sub === undefined) {
      const c = tool.cfbrStatus(); console.log(`RPCS3 ${rpcs3}; CFBR ${c.ok ? c.pkg : `not usable: ${c.error}`}; donors ${donorRoster}`);
      for (const s of tool.slots()) console.log(`${s.tgid} ${s.slot} ${s.name.padEnd(20)} ${s.stadium.padEnd(32)} ${s.swapped ? `swapped: ${s.swapped.donorName} (was ${s.swapped.original}, ${s.swapped.at})` : ''}`);
    } else if (sub === 'preview' && args[0]) console.log(JSON.stringify(tool.donor(Number(args[0])), null, 1));
    else if (sub === 'apply' && flags.has('slot') && flags.has('donor')) show(tool.apply(Number(flags.get('slot')), Number(flags.get('donor'))));
    else if (sub === 'restore' && flags.has('slot')) show(tool.restore(Number(flags.get('slot'))));
    else if (sub === 'stadiums') show(tool.stadiums());
    else if (sub === 'export' && flags.has('out') && flags.has('blob')) {
      const { manifest, blob } = exportSwapPack(rpcs3, tool.state()); writeFileSync(flags.get('out')!, JSON.stringify(manifest)); writeFileSync(flags.get('blob')!, blob);
      console.log(`swap pack: ${swapPackSummary(manifest)}; ${(blob.length / 1048576).toFixed(1)} MB of files`);
    }
    else if (sub === 'ui') {
      const page = flags.get('page') ?? join(import.meta.dirname, '..', '..', '..', 'installer', 'src', 'swap-ui.html');
      const s = await startSwapServer(tool, existsSync(page) ? readFileSync(page, 'utf8') : '<h1>swap-ui.html not found</h1>', Number(flags.get('port') ?? 0));
      console.log(`swap UI on ${s.url} (Ctrl+C to stop)`); if (!flags.has('no-open')) spawn('cmd', ['/c', 'start', '', s.url], { detached: true, stdio: 'ignore' }).unref();
      await new Promise(() => { /* until Ctrl+C */ });
    } else console.log('usage: ncaa-bridge swap list | preview <tgid> | apply --slot 160-164 --donor <tgid> | restore --slot N | status | stadiums | export --out M.json --blob P.bin | ui [--port N]   [--rpcs3 DIR] [--cfbr PKG] [--donors USR-DATA]');
  } finally { if (sub !== 'ui') tool.close(); }
}
