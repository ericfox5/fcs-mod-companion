// Explicit numeric mapping is required. A display name never claims an existing account.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MAGIC, digest, validateRegistry } from '../server/league-auth.mjs';
const [registryPath, profilePath, id, onlineId] = process.argv.slice(2);
try {
  if (!registryPath || !profilePath || !id || !onlineId || fs.existsSync(profilePath))
    throw new Error('Usage: node league-enroll.mjs REGISTRY.json NEW-PRIVATE-PROFILE.json NUMERIC_ID ONLINE_ID');
  const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath)) : { version: 1, players: [] };
  if (registry.players.some(p => p.onlineId.toLowerCase() === onlineId.toLowerCase()))
    throw new Error('Use a distinct game online ID: the client maps some team/persona rows by name');
  const ticket = Buffer.concat([MAGIC, crypto.randomBytes(64)]);
  const player = { userId: Number(id), onlineId, ticketSha256: digest(ticket), joinDynasties: [] };
  registry.players.push(player); validateRegistry(registry);
  const profile = { version: 1, userId: player.userId, onlineId, ticketHex: ticket.toString('hex'),
    issuedMs: Date.now(), expiresMs: Date.now() + 3650 * 86400000 };
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), { flag: 'wx', mode: 0o600 });
  const temp = registryPath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(registry, null, 2), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, registryPath);
  console.log(`Enrolled numeric ID ${id}. Keep the profile and personalized ELF private. Registry stores only its credential hash.`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
