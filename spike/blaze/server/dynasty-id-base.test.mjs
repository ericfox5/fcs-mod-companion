// New dynasties are numbered from NCAA_DYNASTY_ID_BASE, so a PC league and the cloud league never share an id on the site.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function nextId(env, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaa-idbase-'));
  const priv = path.join(dir, 'private'); fs.mkdirSync(priv, { recursive: true });
  if (seed) fs.writeFileSync(path.join(priv, 'dynasties.json'), JSON.stringify(seed));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NCAA_/i.test(k)));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const d = await import('./dod.mjs'); console.log('NEXT=' + d.nextDynastyId()); process.exit(0);"],
    { cwd: HERE, env: { ...clean, HOME: dir, USERPROFILE: dir, NCAA_PRIVATE: priv, ...env }, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, next: Number((/NEXT=(\d+)/.exec(r.stdout) ?? [])[1]), text: r.stdout + r.stderr };
}

test('a PC league numbers dynasties from 1', () => {
  assert.equal(nextId({}).next, 1);
});
test('the cloud league numbers new dynasties from 1000 by default', () => {
  assert.equal(nextId({ NCAA_CLOUD: '1' }).next, 1000);
});
test('NCAA_DYNASTY_ID_BASE sets the first number, and never moves an existing counter down', () => {
  assert.equal(nextId({ NCAA_DYNASTY_ID_BASE: '5000' }).next, 5000);
  assert.equal(nextId({ NCAA_DYNASTY_ID_BASE: '1000' }, { nextId: 1042, dynasties: {} }).next, 1042);
  assert.equal(nextId({ NCAA_DYNASTY_ID_BASE: '1000' }, { nextId: 7, dynasties: {} }).next, 1000);
});
test('a bad NCAA_DYNASTY_ID_BASE stops the start with one clear line', () => {
  const r = nextId({ NCAA_DYNASTY_ID_BASE: '1000 # cloud' });
  assert.equal(r.code, 78); assert.match(r.text, /NCAA_DYNASTY_ID_BASE must be a whole number/);
});
