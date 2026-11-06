# FCS Uniform Studio

Edit what each FCS mod team wears in NCAA 14: the uniform rows (Home, Away, alternates), the parts behind them,
and the textures inside those parts. Everything runs on your PC; nothing is uploaded.

## Start

Double-click `uniform-studio.cmd` (or run `node serve.mjs --open`). It reads your RPCS3 path from
`~/.ncaa-bridge/config.json`, starts a server on `127.0.0.1:8781`, opens the page, and connects it to
`USRDIR\DLC` (every `FCS_DLC_*` folder) and to `qkl_fe2ig.ast`. Close the window to stop it. Every file the
studio writes is backed up first under `%LOCALAPPDATA%\ncaa-bridge\uniforms\backup`.

Opening `uniform-studio.html` on its own also works (Chrome/Edge): you pick the DLC folder once, and the archive
only if you open it on the Archive tab.

## Teams tab (the normal workflow)

1. Pick a team. The header says where its definition comes from: its own `SLOT_Pack0_MixAndMatch.XML` in a DLC
   folder, or the built-in definition inside the game archive. Built-in ones are read-only until you press
   **Copy to DLC folder**, which writes the XML into the team's conference folder.
2. **Uniforms**: one card per official row (row 0 = home, row 1 = away). Each shows the helmet, jersey, pants,
   socks and shoes in use with a thumbnail; change any of them with the dropdown. Changes save at once.
3. **Parts**: every part the team defines, where its bigfile lives (this folder, another `FCS_DLC_*` folder, the
   game archive, or MISSING, which crashes the game), and which rows use it.
   - **Textures** lists the entries in the bigfile. **Edit DDS** writes the texture as a `.dds` with the exact
     original blocks and opens it in your DDS editor (Paint.NET with its DDS plugin is installed); save it there and
     the bigfile is repackaged within a second or two, with the log confirming it. **Import** takes a DDS or PNG you
     already have (same size; BC1/DXT1, BC3/DXT5 or 32-bit). **Quick edit** opens the in-page editor (brush, fill,
     recolor, image placement) and **Apply & save** writes the bigfile.
   - **Pull into folder** copies an archive-resident bigfile into the folder so it can be edited.
   - **Add an existing part** references any bigfile already in a DLC folder. **Clone a part from another team**
     copies a donor bigfile under this team's slot (same-length rename, hashes recomputed, scene paths patched) and
     adds it to the XML.
4. **New set** (nav) builds a complete set for a team from donor bigfiles and writes its XML.

The Advanced tabs (Files, Bigfile, XML, Archive) expose the raw pieces: entries and flags of a bigfile, the XML
as text, and name lookups in the archive.

## How the files fit together

Every team sits on a six-letter asset slot (`TEAM.CSAT`). At game load the game looks in every `FCS_DLC_*` folder
for `SLOT_Pack0_MixAndMatch.XML`; without one it uses the archive entry `SLOT_MIXANDMATCH`. The XML lists parts,
each naming a bigfile and the scene inside it, and says which official rows use it (`TEAM.TUHO`/`TUAW` pick the
home and away rows). Bigfiles are found by name in any DLC folder, then in the archive by FNV-1a 64 of the
upper-cased name, then loose in `USRDIR`. A bigfile is a small BGFA 1.05 container (scene, baked colour texture,
normal map, and for jerseys the number/name decals and kerning table); textures are `p3R` headers over DXT1/DXT5
blocks with a full mip chain. The studio keeps a texture's size, format and mip count and regenerates the chain.

## Source

`src/codec.cjs` (container, textures, DDS, renaming, XML), `src/app.js` (UI), `src/template.html`,
`src/fcs-mapping.json` (team → slot → folder, from the league's TEAM table), `serve.mjs` (local server, DDS
hand-off and repackaging). `node src/build.mjs` inlines them into `uniform-studio.html`;
`node src/test-codec.mjs <DLC folder> [bigfile]` checks the codec against real files (byte-identical rebuilds,
decode/encode PSNR, DDS round trip, renames).

## Uniform files for the generic FCS slots

NCAA 14 ships five generic FCS opponents on the asset slots `D1AAEX`, `D1AAWX`, `D1AANW`, `D1AAMW` and `D1AASE`.
The FCS mod puts real programs on them (Mercyhurst, West Florida, Wagner, Tuskegee, Delta State). The mod's
`qkl_fe2ig.ast` carries rewritten uniform XMLs for some of those slots that name art the mod does not ship, and the
game crashes while loading a game with such a team (`VM: Access violation reading location 0x0` in `FGGameCore`
right after it fails to open `FBSGEN_*_2022_*_big.AST`).

The XMLs here are stop-gaps built on art that is still in the archive; copy them into
`<rpcs3>\dev_hdd0\game\BLUS31159\USRDIR\DLC\FCS_DLC_NEC\` on every install (the studio shows them under Wagner
and Tuskegee):

| File | Slot | Team (FCS mod) | Art used |
| --- | --- | --- | --- |
| `D1AANW_Pack0_MixAndMatch.XML` | D1AANW | Wagner | the game's "FCS Northwest" set: gold NW helmet, green / white NORTHWEST jerseys, white pants |
| `D1AAMW_Pack0_MixAndMatch.XML` | D1AAMW | Tuskegee | gray Midwest helmet, plain red home jersey, white Southeast away jersey, white pants |

Caveat: the mod's archive no longer holds the vanilla art under every generic-slot name (the "NW green helmet"
entry is a West Virginia helmet, the Midwest jerseys are red/maroon/black, and so on); the Archive tab lists what
each name really contains. The mod's own definitions want files that are not in this install: the placeholder set
`FBSGEN_HELMET_2022_BLUE_big.ast`, `FBSGEN_JERSEY_2022_BLUE_big.ast`, `FBSGEN_JERSEY_2022_WHITE_big.ast`,
`FBSGEN_PANTSX_2022_WHITE_big.ast` (Wagner's slot) and `FCSMWX_PANTSX_2021_GOLD_big.ast` +
`D1AAMW_jersey_2021_white_big.ast` (Tuskegee's slot). With those files in hand, drop them into a DLC folder and
point the team's parts at them in the studio, or delete the XMLs so the archive definitions apply again.
