// Where the swap tool's inputs usually are: the CFBR installer pkg and the PHOENIX26 FBS roster, on the Desktop or in
// Downloads (newest pkg first).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const roots = () => [join(homedir(), 'OneDrive', 'Desktop'), join(homedir(), 'Desktop'), join(homedir(), 'Downloads')].filter((p) => existsSync(p));
export function findCfbrPkg(): string | undefined {
  const hits = roots().flatMap((r) => readdirSync(r).filter((f) => /^CFBR.*\.pkg$/i.test(f)).map((f) => join(r, f)));
  return hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
export function findDonorRoster(): string | undefined {
  for (const r of roots()) for (const d of readdirSync(r).filter((f) => /^BLUS31159-ROSTER-PHOENIX/i.test(f))) {
    for (const p of [join(r, d, 'USR-DATA'), join(r, d, d, 'USR-DATA')]) if (existsSync(p)) return p;
  }
  return undefined;
}
