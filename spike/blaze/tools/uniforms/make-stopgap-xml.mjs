// Stop-gap uniform XML for a team whose slot has no playable set ("Coming Soon" placeholder teams crash when a game
// loads): writes <SLOT>_Pack0_MixAndMatch.XML with the vanilla FCS Northwest art (the same parts as the Wagner
// stop-gap, D1AANW_Pack0_MixAndMatch.XML: NW helmet, red home / white away jerseys, white pants, generic socks and
// shoes, all archive-resident) into a DLC folder and keeps a copy beside this script.
//   node spike/blaze/tools/uniforms/make-stopgap-xml.mjs BALLST [SLOT ...] [--folder FCS_DLC_NEC]
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const args = process.argv.slice(2); const fi = args.indexOf('--folder'); const folder = fi >= 0 ? args[fi + 1] : 'FCS_DLC_NEC';
const slots = args.filter((a, i) => !a.startsWith('--') && !(fi >= 0 && i === fi + 1)).map((s) => s.toUpperCase());
if (!slots.length) { console.log('usage: make-stopgap-xml.mjs SLOT [SLOT ...] [--folder FCS_DLC_NEC]'); process.exit(1); }
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const template = fs.readFileSync(path.join(here, 'D1AANW_Pack0_MixAndMatch.XML'), 'latin1');
let rpcs3 = process.env.NCAA_RPCS3;
try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ncaa-bridge', 'config.json'), 'utf8')); rpcs3 ??= c.rpcs3Root ?? c.rpcs3; } catch {}
const dlc = rpcs3 ? path.join(rpcs3, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR', 'DLC', folder) : null;
for (const slot of slots) {
  if (!/^[A-Z0-9]{6}$/.test(slot)) throw new Error(`${slot}: a slot is six letters or digits (TEAM.CSAT)`);
  const name = `${slot}_Pack0_MixAndMatch.XML`;
  fs.writeFileSync(path.join(here, name), template, 'latin1'); console.log(`wrote ${path.join(here, name)}`);
  if (dlc && fs.existsSync(dlc)) { fs.writeFileSync(path.join(dlc, name), template, 'latin1'); console.log(`wrote ${path.join(dlc, name)}`); }
  else console.log(`RPCS3 DLC folder not found (${dlc ?? 'no rpcs3 path in ~/.ncaa-bridge/config.json'}); copy ${name} into USRDIR\\DLC\\${folder} yourself`);
}
