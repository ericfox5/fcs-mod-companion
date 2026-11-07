# Roster stride patch report (stride 100, scope evidence)

| kind | applied | skipped |
|---|---|---|
| div-mulli | 8 | 0 |
| div-magic | 101 | 0 |
| mul-chain | 115 | 12 |
| package | 1 | 0 |
| save-size | 2 | 0 |
| limit | 0 | 0 |

788 words in all.

## Skipped or flagged sites

- 0x64d38 mul-chain [skipped] frontend fn=0x649b8 dbq=1 near=1 4cc= flags=[] :: X=r3 R=r4 (5 instr, 7 span) use=index
- 0xdf2f0 mul-chain [skipped] frontend fn=0xdf2e0 dbq=0 near=0 4cc= flags=['interleaved read of a chain register'] :: X=r4 R=r26 (5 instr, 8 span) use=base
- 0x22d918 mul-chain [skipped] frontend fn=0x22d88c dbq=0 near=0 4cc= flags=[] :: X=r26 R=r4 (5 instr, 9 span) use=unknown
- 0x48b168 mul-chain [skipped] dynasty fn=0x489eec dbq=0 near=0 4cc= flags=[] :: X=r6 R=r6 (5 instr, 6 span) use=unknown
- 0x110ae94 mul-chain [skipped] other fn=0x110acc4 dbq=6 near=6 4cc= flags=[] :: X=r5 R=r5 (5 instr, 5 span) use=unknown
- 0x110baa4 mul-chain [skipped] other fn=0x110b9b4 dbq=0 near=0 4cc= flags=[] :: X=r28 R=r27 (5 instr, 6 span) use=index
- 0x110c3f4 mul-chain [skipped] other fn=0x110be70 dbq=0 near=0 4cc= flags=[] :: X=r3 R=r3 (5 instr, 9 span) use=index
- 0x110d5d4 mul-chain [skipped] other fn=0x110be70 dbq=0 near=0 4cc= flags=[] :: X=r4 R=r4 (5 instr, 6 span) use=unknown
- 0x11ea060 mul-chain [skipped] other fn=0x11ea044 dbq=0 near=0 4cc= flags=[] :: X=r29 R=r28 (5 instr, 9 span) use=base
- 0x11eadb0 mul-chain [skipped] other fn=0x11ea840 dbq=0 near=0 4cc= flags=[] :: X=r31 R=r3 (5 instr, 11 span) use=unknown
- 0x11eaf64 mul-chain [skipped] other fn=0x11ea840 dbq=0 near=0 4cc= flags=['interleaved read of a chain register'] :: X=r4 R=r28 (6 instr, 9 span) use=unknown
- 0x11eb16c mul-chain [skipped] other fn=0x11ea840 dbq=0 near=0 4cc= flags=['interleaved read of a chain register'] :: X=r3 R=r5 (5 instr, 7 span) use=unknown

## Multiply chains by use

- base: 99 applied, 2 skipped
- index: 0 applied, 3 skipped
- unknown: 16 applied, 7 skipped

## Applied multiply chains with use=unknown (review)

- 0x4291d4 fn=0x428f48 near=0 4cc=PGID :: X=r4 R=r4 (5 instr, 5 span) use=unknown
- 0x429210 fn=0x428f48 near=0 4cc=PGID :: X=r4 R=r4 (5 instr, 5 span) use=unknown
- 0x445b94 fn=0x445aec near=5 4cc= :: X=r5 R=r5 (5 instr, 5 span) use=unknown
- 0x445be0 fn=0x445aec near=5 4cc= :: X=r8 R=r8 (5 instr, 5 span) use=unknown
- 0x445c2c fn=0x445aec near=5 4cc= :: X=r10 R=r10 (5 instr, 5 span) use=unknown
- 0x445c78 fn=0x445aec near=5 4cc= :: X=r9 R=r9 (5 instr, 5 span) use=unknown
- 0x445cc4 fn=0x445aec near=6 4cc= :: X=r7 R=r7 (5 instr, 5 span) use=unknown
- 0x445d10 fn=0x445aec near=7 4cc= :: X=r6 R=r6 (5 instr, 5 span) use=unknown
- 0x450cb4 fn=0x450c4c near=8 4cc=PGID :: X=r26 R=r26 (5 instr, 6 span) use=unknown
- 0x46d3ec fn=0x46d37c near=14 4cc=PGID,PLAY :: X=r31 R=r31 (5 instr, 6 span) use=unknown
- 0x5020e0 fn=0x501bb8 near=1 4cc=PGID,PLAY,POID,TGID :: X=r3 R=r30 (5 instr, 5 span) use=unknown
- 0xa23c84 fn=0xa2392c near=5 4cc= :: X=r23 R=r14 (5 instr, 7 span) use=unknown
- 0xa2a3e8 fn=0xa2a3a0 near=2 4cc=DCHT,PLAY :: X=r31 R=r29 (5 instr, 7 span) use=unknown
- 0xa31228 fn=0xa3117c near=2 4cc=DCHT :: X=r26 R=r26 (5 instr, 8 span) use=unknown
- 0xa94bb4 fn=0xa94b54 near=0 4cc= :: X=r4 R=r4 (5 instr, 5 span) use=unknown
- 0xa94c24 fn=0xa94be4 near=0 4cc= :: X=r4 R=r4 (5 instr, 6 span) use=unknown
