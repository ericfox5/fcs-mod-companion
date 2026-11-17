// The member's personal RPCS3 patch entry: the game-local NP adapter (spike/blaze/tools/np-adapter-rpcs3.mjs) assembled
// for their profile. With it enabled the game answers its own PSN questions (signed in, this name, this ticket) and
// presents the 72-byte league credential to the league server; RPCS3 needs no PSN and no RPCN account.
// The entry holds the credential (as the adapter's instructions), so it is personal: one fixed name, replaced on every
// join, removed by signout, and left out of every backup copy the wizard makes of the patch file.
import { adapterWords, assemble, type AdapterTemplate } from '../../../spike/blaze/tools/np-adapter-rpcs3.mjs';
import type { OnlineProfile } from './profile.js';
import type { PatchEntry } from './patch-files.js';

export const CREDENTIAL_PATCH = 'FCS online: league sign-in (personal, do not share)';
const hex8 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

export function credentialPatchEntry(template: AdapterTemplate, profile: OnlineProfile): PatchEntry & { words: number; credentialSha256: string } {
  const words = adapterWords(template, profile), { credentialSha256 } = assemble(template, profile);
  const lines = [
    `  "${CREDENTIAL_PATCH}":`,
    '    Games:',
    '      "NCAA Football 14":',
    '        BLUS31159: [ 01.00, 01.02 ]',
    '    Author: "football-sim-project"',
    `    Notes: "Signs this copy of the game in to the FCS online league as ${profile.onlineId}, without PSN or RPCN (set PSN status to Disconnected). Written by FCS-online.exe from your online profile. It contains your personal sign-in key: do not share this entry, this file or a screenshot of it. FCS-online.exe signout removes it."`,
    '    Patch Version: 1.0',
    '    Patch:',
    ...words.map(([va, w]) => `      - [ be32, ${hex8(va)}, ${hex8(w)} ]`),
  ];
  return { name: CREDENTIAL_PATCH, block: lines.join('\n') + '\n', words: words.length, credentialSha256 };
}
// the addresses an entry block writes (be32 lines), to check that the mod's own entries never overlap the adapter
export function patchAddresses(block: string): number[] {
  return [...block.matchAll(/^\s*- \[ *be32, *(0x[0-9a-fA-F]+),/gm)].map((m) => Number(m[1]));
}
export function adapterConflicts(template: AdapterTemplate, entries: PatchEntry[]): string[] {
  const sites = new Set<number>([...Object.values(template.sites).flat(), 0x719560]), out: string[] = [];
  for (const e of entries) for (const va of patchAddresses(e.block)) if (sites.has(va) || (va >= template.codeVa && va < template.codeLimit) || (va >= template.stateVa && va < template.stateVa + 128)) out.push(`${e.name} @ ${hex8(va)}`);
  return out;
}
