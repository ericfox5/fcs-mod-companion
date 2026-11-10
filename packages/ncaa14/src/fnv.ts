// Names of entries in the game's BGFA archives (qkl_*.ast) are stored as FNV-1a 64 hashes of the upper-cased name, no
// extension ("PLAYDESIGNER" is the ASDF/PATY DB of qkl_misc.ast; a bigfile is "<NAME>_BIG"; a team's compiled playbook
// is "PLAYBOOK_<PLAB.PBAN>", e.g. PLAYBOOK_NCAA_Spread, in qkl_fe2ig.ast).
export const fnv1a64 = (name: string): bigint => {
  let h = 0xcbf29ce484222325n; const s = name.toUpperCase();
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i) & 0xff); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } // latin1 bytes
  return h;
};
// the qkl_fe2ig.ast entry that holds a playbook's compiled DB (the data the game plays from), by its PLAB.PBAN
export const playbookEntryName = (pban: string): string => `PLAYBOOK_${pban}`;
export const playbookEntryHash = (pban: string): bigint => fnv1a64(playbookEntryName(pban));
