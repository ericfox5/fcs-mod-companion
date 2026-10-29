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
