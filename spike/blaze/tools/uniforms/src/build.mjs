// Builds ../uniform-studio.html from template.html + codec.cjs + app.js + fcs-mapping.json (everything inlined).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');
let html = read('template.html');
const codec = read('codec.cjs').replace(/<\/script/gi, '<\\/script');
const app = read('app.js').replace(/<\/script/gi, '<\\/script');
const mapping = JSON.stringify(JSON.parse(read('fcs-mapping.json'))).replace(/<\/script/gi, '<\\/script');
html = html.replace('/*__CODEC__*/', () => codec).replace('/*__MAPPING__*/', () => mapping).replace('/*__APP__*/', () => app);
const out = path.join(here, '..', 'uniform-studio.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
