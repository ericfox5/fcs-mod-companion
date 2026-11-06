// Make an isolated server/store for physical tests. Does not start or stop services.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { validateRegistry } from '../server/league-auth.mjs';
const [registryFile,destination,host]=process.argv.slice(2);
if (!registryFile || !destination || net.isIP(host)!==4) throw new Error('Usage: node prepare-np-test-league.mjs REGISTRY NEW_DIRECTORY CONSOLE_REACHABLE_IPV4');
if (fs.existsSync(destination)) throw new Error('Refusing existing destination');
const registry=validateRegistry(JSON.parse(fs.readFileSync(registryFile,'utf8')));
fs.mkdirSync(path.join(destination,'server/certs'),{recursive:true});
fs.mkdirSync(path.join(destination,'private'));
for (const f of fs.readdirSync(new URL('../server/',import.meta.url)).filter(f=>f.endsWith('.mjs')))
  fs.copyFileSync(new URL('../server/'+f,import.meta.url),path.join(destination,'server',f));
for (const f of ['gosredirector_mod.crt','gosredirector.key.pem'])
  fs.copyFileSync(new URL('../server/certs/'+f,import.meta.url),path.join(destination,'server/certs',f));
fs.writeFileSync(path.join(destination,'private/registry.json'),JSON.stringify(registry,null,2),{flag:'wx'});
fs.writeFileSync(path.join(destination,'RUN.txt'),`Isolated physical PS3 test league. No production stores copied.
Do not run alongside the normal league on this host: listeners use the same ports.
After the normal league is stopped, open three terminals in this folder and run:

node server/redirector.mjs --blaze-host ${host} --blaze-port 33152
node server/qos.mjs
node server/blaze.mjs --ticket-registry private/registry.json --easw off --sync off --http-host ${host} --qos-addr ${host}

Point the console's existing DNS redirection for gosredirector.ea.com at ${host}.
Logs and throwaway dynasty/Locker state stay under this folder's private directory.
Never copy these test stores over the production stores. Ctrl+C stops each listener.
Restore the original update EBOOT after testing; restart the normal league using its existing launcher.
`);
console.log('Prepared (not started): '+path.resolve(destination));
