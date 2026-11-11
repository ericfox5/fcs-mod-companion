# The 3D player on the odds board

`worker/public/data/models/player.glb` (1.5 MB) is built from the royalty-free Sketchfab model
`american_football_player.glb` (27 MB, kept outside the repo). The viewer is `worker/client/hero3d.mjs`, bundled with
three.js into `worker/public/js/hero3d.js` by `npm run build:hero -w worker`.

Rebuild the model (in any scratch folder with `npm i @gltf-transform/cli@4`):

1. Strip the jersey and pants colour textures. They carry a manufacturer logo and a school wordmark, which must not
   ship; the viewer paints its own jersey. With the glTF-Transform API: for the materials `shirt_0` and `pants`,
   `setBaseColorTexture(null)` and `setBaseColorFactor([1,1,1,1])`, then `prune()`.
2. `npx gltf-transform optimize stripped.glb player.glb --compress meshopt --texture-compress webp --texture-size 1024 --simplify-ratio 0.12 --simplify-error 0.003 --palette false`
   (`--palette false` keeps the helmet, pants and trim as separate materials so they can take team colours).

What the viewer recolours, by material name: `shirt_0` (painted canvas: team colour, sleeve bands, number front and
back), `Mat.3` (helmet shell), `pants`, `Mat.2_2mat` and `Mat.8_1` (trim), `frosted_glass` (visor), `Bodymat` (skin).

Animation: the model ships one Mixamo clip, a standing idle. The rig is a standard Mixamo skeleton, so any Mixamo
clip (downloaded as FBX "without skin") can be added to the GLB and played by name.
