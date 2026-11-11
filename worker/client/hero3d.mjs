// The two players on a game preview's odds board: each side's best player as an animated 3D figure in his team's
// colours and his own number. Source for worker/public/js/hero3d.js (bundled with three.js: `npm run build:hero -w worker`).
//
// The figure is one royalty-free model (worker/public/data/models/player.glb, built by tools/hero-model.md's recipe)
// with its warm-up animation. It is not the game's player model and does not use the game's uniform textures: the
// jersey is painted here on a canvas in the model's own layout (jersey colour, sleeve bands, the number front and back),
// and the helmet, pants and trim are coloured. The colours are the main colours of the team's real Home or Away set,
// read from the game's uniform art (tools/uniform-colours.mjs); a part with no colour falls back to the team's two colours.
//
// Markup (pages/odds.ts): <div class="ob-hero" data-primary="#7a1f2b" data-secondary="#c0c0c0" data-set="home" data-helmet="#b2b3b2"
//   data-jersey="#4a1d29" data-pants="#aba5a5" data-trim="" data-number-color="#f0f1f0" data-number="12" data-skin="#a1816d">
// data-anim="flex": the figure flexes instead of standing easy (the scorer on a Supersim celebration card).
// Exports mountHeroes(root) for pages that add figures later (Quickplay's board, Supersim celebrations).
import { AnimationMixer, CanvasTexture, Clock, Color, DirectionalLight, HemisphereLight, PerspectiveCamera, Quaternion, Scene, SRGBColorSpace, Vector3, WebGLRenderer, Box3, LoopRepeat } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const MODEL = '/data/models/player.glb';
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// the jersey in the model's texture layout (2048 x 1024, drawn at half size): sleeves on the left, the front panel in
// the middle and the back panel on the right, both flipped top to bottom in the image
const far = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) > 0.35;
function jerseyTexture(body, trim, ink, number) {
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 512; const g = cv.getContext('2d');
  g.fillStyle = body; g.fillRect(0, 0, 1024, 512);
  // sleeve cuffs, the collar and the hem in the trim colour
  g.fillStyle = trim; g.fillRect(0, 300, 440, 34);
  g.beginPath(); g.ellipse(852, 512, 62, 84, 0, Math.PI, 0); g.fill(); g.beginPath(); g.ellipse(580, 500, 40, 110, 0, Math.PI, 0); g.fill();
  const edge = far(new Color(trim), new Color(ink)) && far(new Color(trim), new Color(body)) ? trim : lum(new Color(ink)) > 0.5 ? '#111111' : '#ffffff';
  const num = (cx, cy, size) => { g.save(); g.translate(cx, cy); g.scale(1, -1); /* the layout is flipped top to bottom, not turned */ g.font = `900 ${size}px "Arial Black", Impact, Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineWidth = size * 0.09; g.strokeStyle = edge; g.strokeText(number, 0, 0); g.fillStyle = ink; g.fillText(number, 0, 0); g.restore(); };
  num(582, 232, 118); num(857, 240, 132);
  const t = new CanvasTexture(cv); t.flipY = false; t.colorSpace = SRGBColorSpace; t.anisotropy = 4; return t;
}
const HEX = /^#[0-9a-f]{6}$/i; const ok = (v) => (HEX.test(v || '') ? v : null);
// face images are flatly lit, so a sampled skin colour is a little grey: give it some of its warmth back
function skinTone(hex) { const c = new Color(hex); const h = {}; c.getHSL(h); c.setHSL(h.h, Math.min(0.62, h.s * 1.45 + 0.06), h.l * 0.97); return c; }

function dress(root, el) {
  const d = el.dataset; const primary = ok(d.primary) || '#1d1d1d', secondary = ok(d.secondary) || '#ffffff'; const number = (d.number || '').slice(0, 2);
  const p = new Color(primary), s = new Color(secondary); const dark = new Color('#15161a'); const away = d.set === 'away';
  // each part: the real set's colour, else the old rule from the team's two colours (visitors in white)
  const jerseyHex = ok(d.jersey) || (away ? '#f4f4f4' : primary); const j = new Color(jerseyHex);
  const helmet = new Color(ok(d.helmet) || primary); const pants = ok(d.pants) ? new Color(d.pants) : lum(s) > 0.2 && lum(s) < 0.95 && !away ? s : new Color('#f2f2f2');
  const contrast = [primary, secondary, '#ffffff', '#111111'].find((h) => far(new Color(h), j));
  const inkHex = ok(d.numberColor) && far(new Color(d.numberColor), j) ? d.numberColor : contrast; const trimHex = ok(d.trim) && far(new Color(d.trim), j) ? d.trim : contrast;
  const jersey = jerseyTexture(jerseyHex, trimHex, inkHex, number); const skin = ok(d.skin) ? skinTone(d.skin) : null;
  const trim = far(helmet, pants) ? helmet : new Color(trimHex);
  root.traverse((o) => {
    if (!o.isMesh) return; o.frustumCulled = false;
    const m = (o.material = o.material.clone()); const name = m.name;
    if (name === 'shirt_0') { m.map = jersey; m.color.set('#ffffff'); }
    else if (name === 'Mat.3') { m.color.copy(lum(helmet) < 0.02 ? new Color('#1b1c20') : helmet); m.roughness = 0.25; m.metalness = 0.1; } // helmet shell
    else if (name === 'pants') m.color.copy(pants);
    else if (name === 'Mat.2_2mat' || name === 'Mat.8_1') m.color.copy(lum(trim) > 0.75 ? dark : trim); // waistband and pad trim
    else if (name === 'frosted_glass') { m.color.set('#20242c'); m.transparent = true; m.opacity = 0.55; } // visor
    else if (name === 'Bodymat' && skin && !/eye/i.test(o.name)) { m.map = null; m.color.copy(skin); m.roughness = 0.75; m.metalness = 0; m.transparent = false; m.depthWrite = true; }
    else if (name === 'Bodymat') { m.transparent = false; m.depthWrite = true; }
    m.needsUpdate = true;
  });
}

// A celebration laid over the idle clip (data-anim="flex"): a double-biceps flex. The upper arms go out level with the
// shoulders (the rig's rest pose), the forearms bend up past vertical and pump, and he leans back with his chin up.
// Returns the per-frame function.
function flexPose(root) {
  const find = (re) => { let hit = null; root.traverse((o) => { if (!hit && re.test(o.name)) hit = o; }); return hit; };
  const B = { la: find(/^mixamorig_?LeftArm_\d+$/), lf: find(/^mixamorig_?LeftForeArm_\d+$/), ra: find(/^mixamorig_?RightArm_\d+$/), rf: find(/^mixamorig_?RightForeArm_\d+$/), sp: find(/^mixamorig_?Spine1_\d+$/), hd: find(/^mixamorig_?Head_\d+$/) };
  const X = new Vector3(1, 0, 0), Z = new Vector3(0, 0, 1); const q = new Quaternion();
  return (t) => {
    const pump = 0.5 + 0.5 * Math.sin(t * 6.5), bend = 1.7 + 0.32 * pump, lift = 0.1 + 0.08 * pump; // radians
    if (B.la) B.la.quaternion.setFromAxisAngle(Z, lift); if (B.ra) B.ra.quaternion.setFromAxisAngle(Z, -lift);
    if (B.lf) B.lf.quaternion.setFromAxisAngle(X, -bend); if (B.rf) B.rf.quaternion.setFromAxisAngle(X, -bend);
    if (B.sp) B.sp.quaternion.multiply(q.setFromAxisAngle(X, -0.1 - 0.05 * pump)); if (B.hd) B.hd.quaternion.multiply(q.setFromAxisAngle(X, -0.14));
  };
}

let modelP = null;
const loadModel = () => (modelP ??= new Promise((resolve, reject) => { const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder); l.load(MODEL, resolve, undefined, reject); }));

async function mount(el, index) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gltf = await loadModel(); const root = cloneSkinned(gltf.scene); dress(root, el);
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }); renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const scene = new Scene(); scene.add(root);
  scene.add(new HemisphereLight('#ffffff', '#30343c', 1.5)); const key = new DirectionalLight('#ffffff', 2.4); key.position.set(index ? -2 : 2, 4, 5); scene.add(key);
  const rim = new DirectionalLight(el.dataset.primary || '#ffffff', 1.6); rim.position.set(index ? 3 : -3, 3, -4); scene.add(rim);
  // frame the standing figure: the box of the bind pose, a little room for raised arms, turned slightly toward the middle
  const mixer = new AnimationMixer(root); const clip = gltf.animations[0];
  if (clip) { const a = mixer.clipAction(clip); a.setLoop(LoopRepeat, Infinity); a.play(); mixer.setTime((index * clip.duration) / 2); }
  root.updateMatrixWorld(true); const box = new Box3().setFromObject(root); const size = box.getSize(new Vector3()), mid = box.getCenter(new Vector3());
  const cam = new PerspectiveCamera(30, 1, size.y * 0.05, size.y * 40); const dist = (size.y * 1.0) / (2 * Math.tan((cam.fov * Math.PI) / 360));
  cam.position.set(mid.x + (index ? -1 : 1) * dist * 0.28, mid.y + size.y * 0.06, mid.z + dist); cam.lookAt(mid.x, mid.y + size.y * 0.02, mid.z);
  const fit = () => { const w = el.clientWidth || 160, h = el.clientHeight || 220; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
  fit(); const ro = new ResizeObserver(fit); ro.observe(el);
  renderer.domElement.setAttribute('aria-hidden', 'true'); el.appendChild(renderer.domElement); el.classList.add('ready');
  const clock = new Clock(); let visible = true, raf = 0;
  let turn = index * Math.PI; const base = root.rotation.y;
  // the clip is a standing idle (he looks around and shifts his weight); a slow turn from side to side shows the number and the back
  const flex = el.dataset.anim === 'flex' ? flexPose(root) : null; let ft = 0;
  const frame = () => { raf = 0; if (!visible) return; const dt = Math.min(0.1, clock.getDelta()); mixer.update(dt); turn += dt * 0.5; if (flex) { ft += dt; flex(ft); root.rotation.y = base + Math.sin(ft * 1.3) * 0.22; } else root.rotation.y = base + Math.sin(turn) * 0.55; renderer.render(scene, cam); if (!still) raf = requestAnimationFrame(frame); };
  const io = new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting) && !document.hidden; if (visible && !raf) { clock.getDelta(); raf = requestAnimationFrame(frame); } }); io.observe(el);
  const onVis = () => { visible = !document.hidden && el.isConnected; if (visible && !raf) { clock.getDelta(); raf = requestAnimationFrame(frame); } }; document.addEventListener('visibilitychange', onVis);
  frame();
  // released when the element leaves the page (a board swapped out): the browser allows only a handful of WebGL contexts
  live.add({ el, dispose: () => { visible = false; if (raf) cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); document.removeEventListener('visibilitychange', onVis); renderer.dispose(); renderer.forceContextLoss(); } });
}

const live = new Set();
const webgl = (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } })();
// mount every figure under root that is not mounted yet; figures no longer on the page are released first
export function mountHeroes(root = document) {
  for (const h of [...live]) if (!h.el.isConnected) { h.dispose(); live.delete(h); }
  const heroes = [...root.querySelectorAll('.ob-hero:not([data-mounted])')];
  heroes.forEach((el, i) => { el.dataset.mounted = '1'; if (!webgl) { el.classList.add('failed'); return; } mount(el, el.dataset.set === 'home' ? 1 : el.dataset.set === 'away' ? 0 : i).catch((e) => { el.classList.add('failed'); console.warn('hero3d', e); }); });
}
mountHeroes();
window.mountHeroes = mountHeroes;
