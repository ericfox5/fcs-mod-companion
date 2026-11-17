// Command line for np-adapter-rpcs3.mjs.
//   node np-adapter-rpcs3-cli.mjs template ORIGINAL.elf OUT-template.json
//   node np-adapter-rpcs3-cli.mjs words TEMPLATE.json PROFILE.json OUT-words.json     (private output: holds the credential)
// FCS-online.exe does both by itself (installer/build.mjs embeds the template, join writes the member's patch entry);
// this is for looking at the output by hand. Nothing is printed that carries a credential.
import fs from 'node:fs';
import { adapterWords, extractTemplate } from './np-adapter-rpcs3.mjs';

try {
  const [mode, a, b, out] = process.argv.slice(2);
  if (mode === 'template' && a && b && !out) {
    if (fs.existsSync(b)) throw new Error('Refusing overwrite');
    const t = extractTemplate(fs.readFileSync(a));
    fs.writeFileSync(b, JSON.stringify(t), { flag: 'wx' });
    console.log(`template: code 0x${t.codeVa.toString(16)}, state 0x${t.stateVa.toString(16)}, ${Object.values(t.sites).flat().length} call sites`);
  } else if (mode === 'words' && a && b && out) {
    if (fs.existsSync(out)) throw new Error('Refusing overwrite');
    const words = adapterWords(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(b, 'utf8').replace(/^﻿/, '')));
    fs.writeFileSync(out, JSON.stringify(words.map(([va, w]) => ({ va: `0x${va.toString(16)}`, new: `0x${w.toString(16).padStart(8, '0')}` }))), { flag: 'wx', mode: 0o600 });
    console.log(`${words.length} words written (keep this file private: it carries the credential)`);
  } else throw new Error('Usage: node np-adapter-rpcs3-cli.mjs template ORIGINAL.elf OUT.json | words TEMPLATE.json PROFILE.json OUT.json');
} catch (e) { console.error(e.message); process.exitCode = 1; }
