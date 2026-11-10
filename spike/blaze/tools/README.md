# EBOOT analysis scripts (Python 3 + capstone)

All scripts take the decrypted `private/EBOOT.elf` as first argument and never modify it. Run them from `spike/blaze/private`.

- `tdfextract.py EBOOT.elf tdf-classes.json [filter...]` – recovers every Blaze TDF class (name, member tags, types, offsets)
  from the class vtables (slot 6 class name, slot 7 full name, slot 10 member-info table). 832 classes in NCAA 14.
  Member records are {tag, type:8 flags:8 offset:16, default words}: 2 words for strings/enums/int64/flag 0x10, none for
  blob/objtype/objid (0x08/0x0b/0x0c), 1 otherwise. Tables laid out back to back can merge; check the raw dump when in doubt.
- `cmdmap.py EBOOT.elf tdf-classes.json 'Blaze::DynastyOnDemand::' out.json` – constructors, nested member classes, callers.
- `apimap.py EBOOT.elf tdf-classes.json dod-cmdmap.json 2ef000 301800 189f0fc 18a31a0` – client API functions: command id
  (the `li` repeated after 92,129), request class and response class (via the RpcJob vtable).
- `cmdtable.py` – lists the RpcJob response factories; `cmdswitch.py` – decodes cmpwi/beq switches (command names).
- `ppcdis.py EBOOT.elf start end [...]` – disassembly with string annotations; `coderef.py` – who references a string/address;
  `vtdump.py` – dump a vtable around a function pointer; `dumptags.py` / `tagfind.py` / `elfstr.py` – raw helpers.
- `jersey-zero-patch.py EBOOT.elf` – checks the five original words of the "FCS mod: jersey #0" patch and prints the
  be32 lines with a before/after disassembly (word by word, so AltiVec opcodes do not stop capstone).
- `ps3-eboot.mjs ORIGINAL.elf NEW.elf [--commissioner] [--jersey-zero]` (Node) – bakes the RPCS3 patch words into the
  decrypted ELF for the real PS3; `node --test ps3-eboot.test.mjs` checks them against `private/rpcs3-patches.yml`.
- `roster-stride-inventory.py EBOOT.elf out.csv out.md` – every executable site that depends on the 70-player stride
  (docs/roster-stride-inventory.md); `roster-stride-patch.py EBOOT.elf --yml --words --json --report` – builds the
  "FCS mod: 100-player rosters" patch (divisions, shift-add multiplies by coefficient tracking, package rows, save size)
  and a report of what it declines; `--capacity --cut 90 --cap-yml --cap-words` adds the second entry "FCS mod: 100-player
  rosters (capacity)" (per-team range ends and the team-management arrays go to 100, the offseason cut stage / auto-cut /
  GetMaxTeamRosterSize / roster-editor checks go to the in-season limit `--cut`; functions that touch the in-game
  `..GA` tables stay at 70); `ps3-eboot.mjs ... --roster-stride [--roster-capacity]` bakes those words
  after the other patches.
- `roster-table-patch.py [--yml OUT --words OUT]` – the third entry "FCS mod: 100-player rosters (player table)": the
  Rosters screens and a new dynasty copy the loaded roster into databases whose PLAY table holds 9,100 rows, so a bigger
  roster file loads only its first 9,100 players. v2 hooks the Rosters builder (`0x4f417c`) and the new-dynasty builder
  (`0x4f5e9c`) right before their indexes are built and resizes PLAY to 13,000 rows with the library's own call
  (`0xa56dbc`); the code sits in the four provably unused .text padding runs, which the generator re-verifies. Play Now
  is not covered. `ps3-eboot.mjs ... --roster-table` bakes it last.
- `ls-group-patch.py [--yml OUT --words OUT]` – "FCS mod: long snapper recruiting fix": the recruiting passes file
  players into 17 position groups, and the mod's long snappers (PPOS 24) map outside them, so the list insert
  (`0x50de60`) wrote a pointer outside its array (heap corruption; a freeze at "generating recruits"). Rewrites that
  insert in place with a group check. Independent of the roster entries; `ps3-eboot.mjs ... --ls-group`.
- `roster-offseason-patch.py [--yml OUT --words OUT]` – "FCS mod: 100-player rosters (offseason)": passes sized for
  126 x 70 = 8,820 players. Training Players' snapshot now goes through the game's grow-then-copy helper (`0x3046e4`;
  before, a full table made training silently skip), graduation's temporary table 8,820 -> 13,000 rows, the recruiting
  player lists 126 x 70 -> 126 x 100. `ps3-eboot.mjs ... --roster-offseason` (after `--roster-table`).
- `ps3-eboot.mjs ... --generic-host` bakes "FCS mod: generic opponents host" (three words); `--extra-words FILE.json`
  (any number of times) bakes a words file kept outside the repo (`{ name, words: [{ va, old, new }] }`), last, each word
  checked against the output as patched so far.
- `ps3-eboot-onto.mjs STOCK.elf ADAPTER.elf NEW.elf --commissioner [other ps3-eboot.mjs options]` (Node) – the same
  words baked into a no-PSN adapter ELF (`ps3-np-adapter.py` output, which already carries the All-Conference fix and
  the five-dynasty limit). Checks that the adapter ELF holds those baseline words, that no new word touches a byte the
  adapter changed (hooks, code cave, program headers), and that the result equals the stock-based build everywhere else.
  Then sign it with `package-np-self.py` (docs/ps3-no-psn-research.md).
