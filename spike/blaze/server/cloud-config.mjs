// Settings shared by blaze.mjs, redirector.mjs and qos.mjs. Precedence: command-line flag > environment variable >
// default, so the local Windows workflow (league.mjs, --lan, --ticket-registry) keeps working unchanged and a Linux
// service is configured with one environment file (deploy/league-server/league.env.example documents every name).
//
// Cloud mode (NCAA_CLOUD=1) is the public-internet profile:
//   - refuses to start without an authenticated player registry (synced from the site, or a static file),
//   - advertises NCAA_PUBLIC_HOST to consoles instead of 127.0.0.1,
//   - turns on connection limits, timeouts and quiet logging (no packet bodies, no capture file).
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export class ConfigError extends Error {}

const MB = 1024 * 1024;
const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';
// An on/off setting. Unset or empty = the default. on: 1 true on yes. off: 0 false off no. ANYTHING else is a
// configuration error, never a silent "off": a systemd environment file does not strip a trailing comment, so
// "NCAA_CLOUD=1 # public" used to mean "not cloud" and started the open local server on a public address.
export function parseSwitch(name, raw, dflt) {
  if (!present(raw)) return dflt;
  const v = String(raw).trim().toLowerCase();
  if (/^(1|true|on|yes)$/.test(v)) return true;
  if (/^(0|false|off|no)$/.test(v)) return false;
  throw new ConfigError(`${name} must be on or off (1/0, true/false, yes/no), got "${String(raw).trim().slice(0, 60)}". Nothing may follow the value on the line, not even a comment`);
}
// The same, read from the environment. With the real process environment a bad value stops the process at once
// (exit 78, one line): these are read while modules load, before anything could catch an error.
export function envSwitch(name, dflt, env = process.env) {
  try { return parseSwitch(name, env[name], dflt); }
  catch (e) { if (env === process.env) fatalConfig('config', e); throw e; }
}
// An on/off setting with a command-line flag that wins (--easw on|off, --sync on|off).
export function switchOpt(flagName, envName, dflt, { env = process.env, argv = process.argv } = {}) {
  const f = flagName ? flag(flagName, argv) : undefined;
  if (f !== undefined) return parseSwitch(flagName, f, dflt);
  return parseSwitch(envName, env[envName], dflt);
}
export const flag = (name, argv = process.argv) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
export const opt = (flagName, envName, dflt, { env = process.env, argv = process.argv } = {}) => {
  const f = flagName ? flag(flagName, argv) : undefined;
  if (f !== undefined) return f;
  return envName && present(env[envName]) ? String(env[envName]).trim() : dflt;
};
// Encrypt the game port (Blaze) with the game's own SSLv3, the way the redirector already is. Off by default. Read by
// blaze.mjs (which then takes connections through sslv3-server.mjs) AND redirector.mjs (which then tells the game to
// encrypt, SECU 1): both must see the same value, so it belongs in the environment both are started with.
// --blaze-tls on|off wins over NCAA_BLAZE_TLS.
export const blazeTls = (ctx) => switchOpt('--blaze-tls', 'NCAA_BLAZE_TLS', false, ctx);
export const isCloud = (env = process.env) => envSwitch('NCAA_CLOUD', false, env);
// Limits and timeouts apply in cloud mode, or anywhere with NCAA_HARDEN=1.
export const isHardened = (env = process.env) => { const hard = envSwitch('NCAA_HARDEN', false, env); return isCloud(env) || hard; };
export const privateDir = (env = process.env) => (present(env.NCAA_PRIVATE) ? path.resolve(env.NCAA_PRIVATE) : path.join(HERE, '..', 'private'));
export const certDir = (env = process.env) => (present(env.NCAA_CERT_DIR) ? path.resolve(env.NCAA_CERT_DIR) : path.join(HERE, 'certs'));

function int(name, value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got "${value}"`);
  return n;
}
export const port = (flagName, envName, dflt, ctx) => int(envName, opt(flagName, envName, dflt, ctx), 0, 65535);

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export const isIPv4 = (s) => net.isIPv4(String(s));

// The website and the bridge token. Same names as the bridge CLI (NCAA_WORKER_URL, NCAA_BRIDGE_TOKEN); NCAA_SITE_URL
// is accepted as the clearer name. The token only ever travels over https (plain http is allowed for localhost dev).
export function siteSettings(env = process.env) {
  const raw = present(env.NCAA_SITE_URL) ? env.NCAA_SITE_URL : env.NCAA_WORKER_URL;
  if (!present(raw) || !present(env.NCAA_BRIDGE_TOKEN)) return null;
  let u; try { u = new URL(String(raw).trim()); } catch { throw new ConfigError('NCAA_SITE_URL is not a valid URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new ConfigError('NCAA_SITE_URL must be https (the bridge token is sent to it)');
  return { siteUrl: u.origin + u.pathname.replace(/\/+$/, ''), token: String(env.NCAA_BRIDGE_TOKEN).trim() };
}

// The member list can be pulled with a narrower secret: NCAA_REGISTRY_TOKEN, which the site accepts on
// GET /api/bridge/league-registry only (the Worker's REGISTRY_TOKEN). The network-facing game process then never
// holds the full bridge token, which can also write to the site. Unset = NCAA_BRIDGE_TOKEN, as before.
export function registrySite(env = process.env) {
  const raw = present(env.NCAA_SITE_URL) ? env.NCAA_SITE_URL : env.NCAA_WORKER_URL;
  const narrow = present(env.NCAA_REGISTRY_TOKEN);
  if (!present(raw) || (!narrow && !present(env.NCAA_BRIDGE_TOKEN))) return null;
  let u; try { u = new URL(String(raw).trim()); } catch { throw new ConfigError('NCAA_SITE_URL is not a valid URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new ConfigError('NCAA_SITE_URL must be https (a token is sent to it)');
  return { siteUrl: u.origin + u.pathname.replace(/\/+$/, ''), token: String(narrow ? env.NCAA_REGISTRY_TOKEN : env.NCAA_BRIDGE_TOKEN).trim(), narrow };
}

// How long a dynasty's update lock (StartDynastyUpdate without EndDynastyUpdate) may sit idle before it is dropped.
export const updateLockSeconds = (env = process.env) => int('NCAA_UPDATE_LOCK_SECONDS', present(env.NCAA_UPDATE_LOCK_SECONDS) ? env.NCAA_UPDATE_LOCK_SECONDS : 300, 30, 86400);

// Limits used by every listener. Generous for a real console, tight for a flood.
export function limits(env = process.env) {
  const g = (name, dflt, min, max) => int(name, present(env[name]) ? env[name] : dflt, min, max);
  return {
    maxConns: g('NCAA_MAX_CONNS', 2000, 1, 100000),
    maxConnsPerIp: g('NCAA_MAX_CONNS_PER_IP', 16, 1, 10000),
    connsPerMinutePerIp: g('NCAA_CONNS_PER_MIN_PER_IP', 120, 1, 100000),
    loginAttemptsPerMinute: g('NCAA_LOGIN_ATTEMPTS_PER_MIN', 10, 1, 10000),
    preauthSeconds: g('NCAA_PREAUTH_SECONDS', 120, 5, 3600),
    idleSeconds: g('NCAA_IDLE_SECONDS', 300, 30, 86400),
    // encrypted game port (NCAA_BLAZE_TLS=on): how long a connection may take to finish the SSL handshake
    tlsHandshakeSeconds: g('NCAA_BLAZE_TLS_HANDSHAKE_SECONDS', 30, 1, 3600),
    packetsPer10s: g('NCAA_PACKETS_PER_10S', 5000, 50, 1000000),
    // Packet sizes on the game port. Before sign-in: a few KB (the largest real one is 546 bytes). After sign-in: a
    // limit per command; megabytes only for the commands that upload table rows (largest real one: 191 KB).
    preauthPacketBytes: g('NCAA_PREAUTH_PACKET_KB', 4, 1, 64) * 1024,
    commandPacketBytes: g('NCAA_COMMAND_PACKET_KB', 64, 4, 1024) * 1024,
    maxPacketBytes: g('NCAA_MAX_PACKET_MB', 4, 1, 256) * 1024 * 1024,
    maxUploadBytes: g('NCAA_MAX_UPLOAD_MB', 32, 1, 1024) * 1024 * 1024,
    lockerQuotaBytes: g('NCAA_LOCKER_QUOTA_MB', 512, 1, 1024 * 1024) * 1024 * 1024,
    lockerMaxItems: g('NCAA_LOCKER_MAX_ITEMS', 500, 1, 1000000),
    maxDynastiesPerUser: g('NCAA_MAX_DYNASTIES_PER_USER', 10, 1, 100000),
    // Storage (dod.mjs, storage-budget.mjs). For scale: one real dynasty is about 85 tables and 19 MB, its largest
    // table 11,300 rows and 9.5 MB, its entry in dynasties.json 45 KB, one uploaded game 40 KB.
    tableMaxRows: g('NCAA_TABLE_MAX_ROWS', 60000, 100, 10000000), // rows in one table
    tableMaxBytes: g('NCAA_TABLE_MAX_MB', 32, 1, 1024) * MB, // one table file
    dynastyMaxTables: g('NCAA_DYNASTY_MAX_TABLES', 200, 10, 10000), // table files of one dynasty
    dynastyTablesBytes: g('NCAA_DYNASTY_TABLES_MB', 128, 1, 1024 * 1024) * MB, // all tables of one dynasty
    memberMaxTables: g('NCAA_MEMBER_MAX_TABLES', 100, 10, 10000), // a member's own table files in one dynasty
    memberTablesBytes: g('NCAA_MEMBER_TABLES_MB', 64, 1, 1024 * 1024) * MB, // a member's own tables, all dynasties together
    dynastyRecordBytes: g('NCAA_DYNASTY_RECORD_KB', 4096, 64, 1024 * 1024) * 1024, // one dynasty's entry in dynasties.json
    gameDataMaxBytes: g('NCAA_GAME_DATA_MAX_KB', 2048, 16, 1024 * 1024) * 1024, // one uploaded game
    dynastyMaxGameFiles: g('NCAA_DYNASTY_MAX_GAME_FILES', 1000, 10, 1000000), // uploaded games kept for one dynasty
    stateBudgetBytes: g('NCAA_STATE_BUDGET_MB', 2048, 16, 16 * 1024 * 1024) * MB, // everything under NCAA_PRIVATE
  };
}

// Everything cloud mode needs, checked before any port is opened. Throws ConfigError with a plain message.
export function cloudSettings({ env = process.env, argv = process.argv, needRegistry = true } = {}) {
  const cloud = isCloud(env);
  const publicHost = present(env.NCAA_PUBLIC_HOST) ? String(env.NCAA_PUBLIC_HOST).trim() : '';
  const advertise = String(env.NCAA_ADVERTISE ?? 'ip').trim().toLowerCase() || 'ip';
  const site = siteSettings(env), regSite = registrySite(env);
  const staticFlag = flag('--ticket-registry', argv);
  const syncWanted = parseSwitch('NCAA_REGISTRY_SYNC', env.NCAA_REGISTRY_SYNC, true) && staticFlag === undefined;
  parseSwitch('NCAA_LAN', env.NCAA_LAN, false); // a bad value is an error for every service, used or not
  parseSwitch('NCAA_BLAZE_TLS', env.NCAA_BLAZE_TLS, false);
  const out = {
    cloud, hardened: isHardened(env), publicHost, advertise, site,
    registryFile: staticFlag ?? (present(env.NCAA_REGISTRY_FILE) ? path.resolve(env.NCAA_REGISTRY_FILE) : (cloud ? path.join(privateDir(env), 'league-registry.json') : '')),
    registrySync: null,
    limits: limits(env),
  };
  if (!cloud) return out;
  if (!publicHost) throw new ConfigError('cloud mode needs NCAA_PUBLIC_HOST (the public hostname or IPv4 address consoles connect to)');
  if (!isIPv4(publicHost) && !HOSTNAME.test(publicHost)) throw new ConfigError(`NCAA_PUBLIC_HOST "${publicHost}" is not a hostname or an IPv4 address`);
  if (!['ip', 'host'].includes(advertise)) throw new ConfigError('NCAA_ADVERTISE must be "ip" or "host"');
  if (needRegistry) {
    if (syncWanted && regSite) {
      const hours = (name, dflt) => int(name, present(env[name]) ? env[name] : dflt, 0, 24 * 365);
      const warnHours = hours('NCAA_REGISTRY_WARN_HOURS', 6), maxHours = hours('NCAA_REGISTRY_MAX_AGE_HOURS', 72);
      if (maxHours && warnHours > maxHours) throw new ConfigError('NCAA_REGISTRY_WARN_HOURS must not be larger than NCAA_REGISTRY_MAX_AGE_HOURS');
      out.registrySync = {
        url: `${regSite.siteUrl}/api/bridge/league-registry`, token: regSite.token, narrowToken: regSite.narrow,
        // the member list is older than this (the site has not answered): warn / stop taking new sign-ins. 0 = never.
        warnAfterMs: warnHours * 3600 * 1000, maxAgeMs: maxHours * 3600 * 1000,
        intervalMs: int('NCAA_REGISTRY_INTERVAL', present(env.NCAA_REGISTRY_INTERVAL) ? env.NCAA_REGISTRY_INTERVAL : 60, 1, 86400) * 1000,
        minUserId: int('NCAA_REGISTRY_MIN_USER_ID', present(env.NCAA_REGISTRY_MIN_USER_ID) ? env.NCAA_REGISTRY_MIN_USER_ID : 800000, 1, 0x7fffffff),
      };
    } else if (syncWanted) {
      throw new ConfigError('cloud mode refuses to start without a player registry: set NCAA_SITE_URL and NCAA_REGISTRY_TOKEN (registry sync; NCAA_BRIDGE_TOKEN also works), or NCAA_REGISTRY_SYNC=off with NCAA_REGISTRY_FILE pointing at a registry file');
    } else if (staticFlag === undefined && !present(env.NCAA_REGISTRY_FILE)) {
      throw new ConfigError('cloud mode refuses to start without a player registry: NCAA_REGISTRY_SYNC=off needs NCAA_REGISTRY_FILE');
    }
  }
  return out;
}

// The address a service listens on, and the rule that an open server is never reachable from outside by accident.
// Without the member list (no cloud mode, no registry) anyone who can reach the port can sign in as anyone, so:
//   - the default is 127.0.0.1 (the same PC: RPCS3), no longer every interface;
//   - another address needs an explicit "this is my home network": --lan on the service, NCAA_LAN=on, or an
//     address consoles are sent that is not this PC (--qos-addr / --http-host / --blaze-host, what league.mjs --lan
//     passes). With one of those the default is 0.0.0.0, as it always was for --lan;
//   - anything else is a configuration error (exit 78), not a silent open listener.
// With the member list (cloud mode or a registry) the default stays 0.0.0.0.
export const isLoopback = (addr) => /^127\./.test(String(addr)) || ['::1', 'localhost'].includes(String(addr).toLowerCase());
export function bindSettings({ env = process.env, argv = process.argv, cloud = false, registry = false, advertised = [] } = {}) {
  const lan = argv.includes('--lan') || parseSwitch('NCAA_LAN', env.NCAA_LAN, false) || advertised.some((a) => present(a) && !isLoopback(a));
  const explicit = present(env.NCAA_BIND) ? String(env.NCAA_BIND).trim() : '';
  if (explicit && !net.isIP(explicit)) throw new ConfigError(`NCAA_BIND must be an IP address (for example 0.0.0.0 or 127.0.0.1), got "${explicit.slice(0, 60)}"`);
  const guarded = cloud || registry;
  const bind = explicit || (guarded || lan ? '0.0.0.0' : '127.0.0.1');
  if (!isLoopback(bind) && !guarded && !lan) throw new ConfigError(`refusing to listen on ${bind} without the member list: anyone who can reach that address could sign in as any player. Turn on cloud mode (NCAA_CLOUD=1), or give a registry, or state that this is a trusted home network with --lan (NCAA_LAN=on)`);
  return { bind, lan, open: !guarded };
}

// What consoles are told to connect to. The game has only been proven with IPv4 literals, so that is the default
// ("ip"): a hostname in NCAA_PUBLIC_HOST is resolved here, on the server, and re-resolved every few minutes so a DNS
// change is picked up without a restart. "host" sends the hostname itself wherever the protocol carries a string (the
// redirector's HOST member, the QoS site name, every HTTP URL) and the resolved IPv4 wherever it carries a number.
export async function createAdvertiser(publicHost, mode = 'ip', { lookup = (h) => dns.promises.lookup(h, { family: 4 }), refreshMs = 5 * 60 * 1000, onChange = () => {} } = {}) {
  let ip = publicHost;
  const literal = isIPv4(publicHost);
  const resolve = async () => { const r = await lookup(publicHost); const a = typeof r === 'string' ? r : r?.address; if (!isIPv4(a)) throw new Error(`no IPv4 address for ${publicHost}`); return a; };
  if (!literal) {
    try { ip = await resolve(); } catch (e) { throw new ConfigError(`cannot resolve NCAA_PUBLIC_HOST "${publicHost}" to an IPv4 address: ${e.message}`); }
  }
  let timer = null;
  if (!literal && refreshMs > 0) {
    timer = setInterval(async () => { try { const next = await resolve(); if (next !== ip) { onChange(ip, next); ip = next; } } catch { /* keep the last good address */ } }, refreshMs);
    timer.unref?.();
  }
  return {
    ip: () => ip, // always an IPv4 literal
    host: () => (mode === 'host' ? publicHost : ip), // the string consoles are sent
    stop: () => clearInterval(timer),
  };
}
// A fixed address (local mode: --lan / --qos-addr / --http-host / --blaze-host).
export const fixedAdvertiser = (addr) => ({ ip: () => addr, host: () => addr, stop: () => {} });

// A configuration mistake: one line saying what is wrong, then exit with EX_CONFIG (78). The systemd units try again
// after a pause that grows to a minute, so a mistake costs one log line a minute and a fixed file is picked up.
export function fatalConfig(tag, e) {
  const reason = e instanceof ConfigError ? e.message : String(e?.stack ?? e);
  console.error(`[${tag}] cannot start: ${reason.replace(/[\r\n]+/g, ' | ')}`);
  process.exit(78);
}
