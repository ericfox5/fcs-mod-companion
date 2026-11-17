// Blaze 3 stub (plaintext; SSLv3 with --blaze-tls on) for the NCAA 14 spike: logs every packet (decoded TDF) and answers the Util / Authentication /
// UserSessions calls the client makes while logging in, so we can watch what it asks for next (the dynasty component).
//   node blaze.mjs [--port 33152] [--service ncaa-2014-ps3] [--unknown empty|error] [--http-port 17503] [--settings minimal|full]
//                  [--easw on|off] [--easw-port 17504] [--ticket-registry FILE] [--sync on|off] [--blaze-tls on|off]
// Every setting can also come from the environment (cloud-config.mjs; a flag wins). NCAA_CLOUD=1 is the public-server
// profile: it refuses to start without a player registry, advertises NCAA_PUBLIC_HOST, syncs the registry from the
// site (registry-sync.mjs) and turns on connection limits and quiet logging. See deploy/league-server/.
// The same process serves the Locker file endpoint (HTTP) that Online Dynasty uploads its .team/.dynasty files to.
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PacketStream, encodePacket, describe, MSG } from './packet.mjs';
import { decode, Writer, T } from './tdf.mjs';
import { parseXi5 } from './xi5.mjs';
import { MAGIC, authorizeDod, mayPreviewDynasty } from './league-auth.mjs';
import { log, captureFile, logBodies } from './log.mjs';
import { cloudSettings, createAdvertiser, fixedAdvertiser, fatalConfig, flag, switchOpt, bindSettings, port, privateDir, certDir, blazeTls } from './cloud-config.mjs';
import { Sslv3ServerSocket } from './sslv3-server.mjs';
import { pemToDer } from './sslv3-crypto.mjs';
import { RegistryStore, startRegistrySync } from './registry-sync.mjs';
import { createConnectionGuard, createRateLimiter, createLogLimiter, hardenSocket, installProcessGuards, exitOnListenError, clientIp } from './net-guard.mjs';
import { DOD, handleDod, configureDodLimits, releaseSessionLocks, dynastiesCreatedBy, store as dodStore, save as dodSave, loadTable as dodLoadTable } from './dod.mjs';
import { saveJsonState, loadJsonState } from './state-file.mjs';
import { stateBudget } from './storage-budget.mjs';
import { startSupersimPoller } from './supersim.mjs';
import { LOCKER, handleLocker, startLockerHttp, configureLockerAuth, getContent, revokeSessionCapabilities } from './locker.mjs';
import { startEaswHttp, setLoginIdentity, configureEaswAuth } from './easw.mjs';
import { startWireSync } from './wire.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
let cfg, PORT, QOS_PORT, HTTP_PORT, EASW_PORT, advQos, advHttp, BIND, LAN, EASW_ON, SUPERSIM_ON, BLAZE_TLS;
try {
  cfg = cloudSettings();
  // Where to listen. Without the member list the default is this PC only (127.0.0.1); another address needs --lan
  // (league.mjs --lan), and anything else is refused (cloud-config.mjs bindSettings).
  ({ bind: BIND, lan: LAN } = bindSettings({ cloud: cfg.cloud, registry: !!cfg.registryFile, advertised: [flag('--qos-addr'), flag('--http-host')] }));
  // off: the console keeps Sports World disabled (OSDK_EASW_ALLOWED_LOCALES "----"), but the game then shows "You have
  // lost your connection to EA servers" when it tries to post a story, so it is on by default everywhere. The
  // authenticated path (easw.mjs configureEaswAuth) was proven with the game on RPCS3 on 2026-11-16.
  // on/off only: any other value is a configuration error (firewall.sh opens the port for exactly "on").
  EASW_ON = switchOpt('--easw', 'NCAA_EASW', true);
  SUPERSIM_ON = switchOpt('--sync', 'NCAA_SUPERSIM', true);
  // on: this port speaks the game's SSLv3 (sslv3-server.mjs, the redirector's certificate) and nothing else. The
  // redirector reads the same setting and tells the game to encrypt (SECU 1). Off by default: not yet tried with the game.
  BLAZE_TLS = blazeTls();
  PORT = port('--port', 'NCAA_BLAZE_PORT', 33152);
  QOS_PORT = port('--qos-port', 'NCAA_QOS_PORT', 17502);
  HTTP_PORT = port('--http-port', 'NCAA_LOCKER_PORT', 17503); // Locker upload/download endpoint (served by this process)
  EASW_PORT = port('--easw-port', 'NCAA_EASW_PORT', 17504); // EA Sports World + XMS (in-game Dynasty Wire), served by this process
  // The address consoles are told to use. Local: --qos-addr / --http-host (league.mjs --lan), default 127.0.0.1.
  // Cloud: NCAA_PUBLIC_HOST, resolved to IPv4 (see createAdvertiser); a flag still wins.
  const pub = cfg.cloud ? await createAdvertiser(cfg.publicHost, cfg.advertise, { onChange: (x, y) => log('blaze', `public address changed ${x} -> ${y}`) }) : null;
  advQos = flag('--qos-addr') !== undefined || !pub ? fixedAdvertiser(arg('--qos-addr', '127.0.0.1')) : pub;
  advHttp = flag('--http-host') !== undefined || !pub ? fixedAdvertiser(arg('--http-host', '127.0.0.1')) : pub; // host the client is told to use in UURL/GURL
} catch (e) { fatalConfig('blaze', e); }
const CLOUD = cfg.cloud, HARD = cfg.hardened, L = cfg.limits;
const SERVICE = arg('--service', 'ncaa-2014-ps3');
const UNKNOWN = arg('--unknown', 'empty');
const QOS_PROBES = Number(arg('--qos-probes', 10));
// Registry mode: the login ticket must be a league credential whose hash is in the registry. --ticket-registry FILE
// (or NCAA_REGISTRY_FILE) is a static, operator-edited file, re-read when it changes; cloud mode normally syncs the
// registry from the site into that file instead. Without a registry the stub trusts an unsigned RPCN ticket (local
// play only): cloud mode never gets here without one.
const REGISTRY_PATH = cfg.registryFile;
const REGISTRY = !!REGISTRY_PATH;
if (CLOUD && !REGISTRY) fatalConfig('blaze', new Error('cloud mode without a registry'));
const registry = REGISTRY ? new RegistryStore({ file: REGISTRY_PATH, watch: !cfg.registrySync, log: (m) => log('registry', m) }) : null;
installProcessGuards((m) => log('blaze', m));
// Encrypted game port: the same certificate and key the redirector serves, read once at start.
let tlsOptions = null;
if (BLAZE_TLS) {
  const certs = certDir();
  try { tlsOptions = { certDer: pemToDer(fs.readFileSync(path.join(certs, 'gosredirector_mod.crt'))), privateKeyPem: fs.readFileSync(path.join(certs, 'gosredirector.key.pem')) }; }
  catch (e) { console.error(`[blaze] cannot start: NCAA_BLAZE_TLS is on but the certificate files are not readable in ${certs} (${e.code ?? e.message}): this service must be able to read gosredirector_mod.crt and gosredirector.key.pem there (NCAA_CERT_DIR), or set NCAA_BLAZE_TLS=off`); process.exit(78); }
}
// Storage limits (per table, per dynasty, per member, and one budget for all league data): on with the other limits
// (cloud mode or NCAA_HARDEN=1), off on a local PC, where nothing is measured and nothing is refused.
if (HARD) {
  configureDodLimits(L);
  stateBudget.configure({ root: privateDir(), maxBytes: L.stateBudgetBytes, log: (m) => log('storage', m) });
}
if (REGISTRY) {
  if (cfg.registrySync) {
    // cached copy first, then one pull now (bounded by its timeout) so a revocation made while the server was down is
    // in place before the first console is let in; then every interval
    const sync = startRegistrySync({ ...cfg.registrySync, store: registry, file: REGISTRY_PATH, log: (m) => log('registry', m) });
    await sync.ready;
  } else {
    if (!registry.loadFile()) fatalConfig('blaze', new Error(`registry file ${REGISTRY_PATH} is missing or invalid`));
    const t = setInterval(() => registry.refresh(), 5000); t.unref?.(); // an edit reaches idle connections too
  }
  configureLockerAuth({ dynasties: dodStore.dynasties, isActive: (s) => s.active && registry.isActive(s) });
  // Sports World signs in with the same league credential and is tied to that player (no last-login identity)
  configureEaswAuth({
    authenticate: (ticket) => registry.authenticate(ticket), isActive: (t) => registry.isActive(t), dynasties: dodStore.dynasties, limits: L,
    // media of a dynasty with a password is for its members (a Sports World sign-in cannot give the password)
    canSee: (d, userId) => mayPreviewDynasty(d, { leagueAuthenticated: true, joinDynasties: registry.find(userId)?.joinDynasties ?? [] }, userId),
  });
}
const SETTINGS_MODE = arg('--settings', 'minimal'); // minimal (Zamboni's proven set) | full (every O_* setting found in the EBOOT)
const AUTH = 1, PLAYGROUPS = 6, UTIL = 9, STATS = 7, CENSUS = 10, MESSAGING = 15, ROOMS = 21, USERSESSIONS = 0x7802;
// EA OSDK components (ids from ZamboniCommonComponents, class names confirmed in the NCAA 14 EBOOT strings)
const OSDK_SETTINGS = 2249, OSDK_DYNMSG = 2250, OSDK_WEBOFFER = 2251, OSDK_SEASONAL = 2257, OSDK_TICKER2 = 2262, OSDK_ONLINEPASS = 2268;
const LOCALE_EN_US = 1701729619;

// A client that sends requests but never reads the answers would make the server buffer them without end.
const MAX_UNREAD = 32 * 1024 * 1024;
const send = (sock, pkt, note, always = false) => {
  if (sock.destroyed) return;
  if (sock.writableLength > MAX_UNREAD) { log('blaze', `dropping ${clientIp(sock.remoteAddress)}: not reading its replies`); sock.destroy(); return; }
  sock.write(pkt);
  if (logBodies || always) log('blaze', note, REGISTRY ? undefined : pkt.subarray(0, 200).toString('hex'));
};
const reply = (sock, p, build, note = '') => {
  const w = new Writer(); if (build) build(w);
  send(sock, encodePacket({ component: p.component, command: p.command, type: MSG.RESPONSE, id: p.id, payload: w.bytes() }), `-> response ${describe(p)} ${note}`);
};
// quiet: the caller writes its own (rate-limited) log line; used for everything a stranger can trigger before sign-in
const replyError = (sock, p, code = 0x4000, { quiet = false } = {}) => send(sock, encodePacket({ component: p.component, command: p.command, type: MSG.ERROR, error: code, id: p.id }), `-> ERROR 0x${code.toString(16)} for ${describe(p)}`, !quiet);
// Log lines an outsider can cause (refused packets and sign-ins, refused or dropped connections): with limits on, at
// most ten a minute per address, and the next line for that address says how many were left out. Without limits
// (a local PC) every line is written, as before.
const noisy = createLogLimiter((m) => log('blaze', m), { perWindow: HARD ? 10 : Number.MAX_SAFE_INTEGER, windowMs: 60000 });
const notify = (sock, component, command, build, note) => {
  const w = new Writer(); build(w);
  send(sock, encodePacket({ component, command, type: MSG.NOTIFY, id: 0, payload: w.bytes() }), `-> NOTIFY ${component}/${command} ${note}`);
};

function preAuth(w) {
  w.int('ANON', 0);
  w.str('ASRC', '300294');
  // Advertise every plausible component id: core Blaze plus the whole OSDK/sports range (2048-2300), so the client
  // never considers a component unavailable before trying it. Unknown ones get empty replies and are logged.
  w.intList('CIDS', [...[1, 4, 5, 7, 9, 10, 11, 12, 13, 15, 20, 21, 23, 25, 28, 30], ...Array.from({ length: 253 }, (_, i) => 2048 + i), 30722]);
  w.struct('CONF', (c) => c.stringMap('CONF', {
    associationListSkipInitialSet: '1', blazeServerClientId: 'GOS-BlazeServer-NCAA-PS3', connIdleTimeout: '90s',
    defaultRequestTimeout: '60s', pingPeriod: '30s', userManagerMaxCachedUsers: '0', voipHeadsetUpdateRate: '1000', xlspConnectionIdleTimeout: '300',
  }));
  w.str('INST', SERVICE);
  w.str('LDOC', ''); w.str('PCON', ''); w.str('PCTG', '');
  w.str('PERS', 'cem_ea_id');
  w.str('PLAT', 'ps3');
  w.struct('QOSS', (q) => {
    q.struct('BWPS', (b) => { b.str('PSA', advQos.host()); b.int('PSP', QOS_PORT); b.str('SNA', 'rs-prod-ps3'); });
    q.int('LNP', QOS_PROBES);
    q.map('LTPS', T.STRING, T.STRUCT, [['rs-prod-ps3', null]], (x, k) => x.string(k), (x) => { x.str('PSA', advQos.host()); x.int('PSP', QOS_PORT); x.str('SNA', 'rs-prod-ps3'); x.push(0); });
    q.int('SVID', 1337);
  });
  w.str('REGI', '302123');
  w.str('SVRN', 'Blaze 3.19.03.0 (CL# 0)');
  w.int('UAGE', 0);
}
const telemetry = (w) => { w.str('ADRS', advHttp.host()); w.int('ANON', 0); w.str('DISA', ''); w.str('FILT', '-UION/****'); w.int('LOC', LOCALE_EN_US); w.str('NOOK', 'US,CA,MX'); w.int('PORT', 9988); w.int('SDLY', 15000); w.str('SESS', 'spike'); w.str('SKEY', ''); w.int('SPCT', 75); w.str('STIM', ''); };
function postAuth(w) {
  w.struct('PSS', (s) => { s.str('ADRS', ''); s.blob('CSIG', Buffer.alloc(0)); s.str('PJID', '0'); s.int('PORT', 0); s.int('RPRT', 0); s.int('TIID', 0); });
  w.struct('TELE', telemetry);
  w.struct('TICK', (s) => { s.str('ADRS', advHttp.host()); s.int('PORT', 8999); s.str('SKEY', ''); });
  w.struct('UROP', (s) => { s.int('TMOP', 1); s.int('UID', 1); });
}

// Config sections the client fetches before login. Keys are the OSDK_* identifiers found in the game binary; values
// disable the Online Pass / Season Ticket gate (tollbooth) and point EA Sports World at our HTTP listener so any attempt shows up.
// Built per request: the advertised address can follow a DNS change in cloud mode.
const commonConfig = () => { const QOS_HTTP = `http://${advQos.host()}:${QOS_PORT}`, EASW_HTTP = `http://${advHttp.host()}:${EASW_PORT}`; return {
  OSDK_TOLLBOOTH_ONLINE_PASS_ENABLED: '0', OSDK_TOLLBOOTH_SEASON_TICKET_ENABLE: '0', OSDK_TOLLBOOTH_DDP_COMMERCE_ENABLED: '0',
  OSDK_TOLLBOOTH_DDR_ONLINE_PASS_ENABLED: '0', OSDK_TOLLBOOTH_EXPIRATION_TEST_MODE_ENABLED: '0', OSDK_TOLLBOOTH_DIME_TIMEOUT_SECS: '2',
  OSDK_DDP_UPGRADE_TO_DDR_ENABLED: '0', OSDK_ONLINEPASS_RETRIEVE_TIMEOUT: '2', OSDK_SUBSCRIPTION_RETRIEVE_TIMEOUT: '2',
  OSDK_SUBSCRIPTION_WEB_RETRIEVE_TIMEOUT: '2', OSDK_MATCHUP_TIMEOUT: '30', OSDK_REMATCH_ACCEPT_TIMEOUT: '30', OSDK_MAX_PER_OTP_SIDE: '6',
  // Sports World is gated by locale: the client enables it only when its 4-char locale matches one of these patterns
  // (IsLocaleEnabled 0x10b98ec; '*' matches any character). It carries the in-game Dynasty Wire (easw.mjs).
  OSDK_EASW_ALLOWED_LOCALES: EASW_ON ? '****' : '----',
  OSDK_EASW_AUTH_URL: `${EASW_HTTP}/easw`, OSDK_EASW_EVENT_URL: `${EASW_HTTP}/easw/event`, OSDK_EASW_GF_FILE_URL: `${EASW_HTTP}/easw/gameface`,
  OSDK_EASW_MEDIA_URL: `${EASW_HTTP}/easw`, OSDK_EASW_REQ_URL: `${EASW_HTTP}/easw`, OSDK_NO_MEDIA_URL: `${EASW_HTTP}/easw/nomedia.jpg`,
  OSDK_ONDEMAND_DEFAULT_BACKGROUND_URL: `${EASW_HTTP}/easw/bg.jpg`, OSDK_ONDEMAND_DEFAULT_THUMBNAIL_URL: `${EASW_HTTP}/easw/thumb.jpg`,
  OSDK_ONLINEPASS_DOWNLOAD_URL: `${QOS_HTTP}/easw/onlinepass`, OSDK_ONLINEPASS_TRIAL_URL: `${QOS_HTTP}/easw/onlinepass`,
}; };
// Extra keys per config id, named after the OSDK_* strings the EBOOT reads for that section. Ticker count 0 = no ticker polling.
const CONFIG_EXTRA = {
  OSDK_TICKER: { OSDK_TICKER_COUNT: '0', OSDK_TICKER_POLLING_DELAY: '600000', OSDK_TICKER_NEWS_HEADER: 'NEWS', OSDK_SPORTS_SCORES: '0', TICKER_RACING_HEADER: 'RACING' },
  OSDK_ABUSE_REPORTING: { OSDK_ABUSE_NUM_TYPES: '0' },
};
const clientConfig = (cfid) => ({ ...commonConfig(), ...(CONFIG_EXTRA[cfid] ?? {}) });

// OSDKSettings: the client's SettingManager looks groups/settings up by name right after fetching them and dereferences
// the result without a NULL check (run 8 crashed in TickerFacade init: group "O_SG_TCKR" -> setting "O_TKfilter").
// Run 9 showed the opposite hazard: shipping "O_FWD_EMAIL" makes SettingManager's group-event handler release an
// uninitialised smart pointer (write to 0x800004). So the default is Zamboni's proven minimal set; `--settings full`
// serves every O_* name found in the EBOOT for experiments.
const FULL = SETTINGS_MODE === 'full';
const STRING_SETTINGS = !FULL ? [{ id: 'O_TKfilter', label: 'Ticker Filter', def: '' }] : [
  { id: 'O_TKfilter', label: 'Ticker Filter', def: '' }, { id: 'O_TKsport', label: 'Ticker Sport', def: '' }, { id: 'O_TKfriend', label: 'Ticker Friends', def: '' },
];
const ON_OFF = [[0, 'Off'], [1, 'On']];
const INT_SETTINGS = !FULL ? [] : [
  { id: 'O_SPAMEA', label: 'EA Email', def: 0 }, { id: 'O_SPAMPART', label: 'Partner Email', def: 0 }, { id: 'O_FWD_EMAIL', label: 'Forward Email', def: 0 },
  { id: 'O_EGstat', label: 'Share Stats', def: 1 }, { id: 'O_MYPT', label: 'My Playtime', def: 1 }, { id: 'O_OPPT', label: 'Opponent Playtime', def: 1 },
  { id: 'O_TELEMETRY', label: 'Telemetry', def: 0 }, { id: 'O_WO_NEWS', label: 'News', def: 0 }, { id: 'O_NetRadio', label: 'NetRadio', def: 0 },
];
const SETTING_GROUPS = !FULL ? [{ id: 'O_SG_TCKR', settings: ['O_TKfilter'] }] : [
  { id: 'O_SG_TCKR', settings: ['O_TKsport', 'O_TKfriend', 'O_TKfilter'] },
  { id: 'O_SG_USER', settings: ['O_SPAMEA', 'O_SPAMPART', 'O_FWD_EMAIL', 'O_EGstat', 'O_MYPT', 'O_OPPT'] },
  { id: 'O_SG_SYSS', settings: ['O_TELEMETRY'] },
  { id: 'O_SG_QMSG', settings: [] },
  { id: 'O_SG_NRAD', settings: ['O_NetRadio'] },
];
function fetchSettings(w) {
  // TDF members must be written in tag order: DEF < HLAB < ID < LABL < LOCF < MPVL < TOGG
  w.list('LSIN', T.STRUCT, INT_SETTINGS, (x, s) => { x.int('DEF', s.def); x.str('HLAB', ''); x.str('ID', s.id); x.str('LABL', s.label); x.int('LOCF', 0); x.map('MPVL', T.INT, T.STRING, ON_OFF, (m, k) => m.varint(k), (m, v) => m.string(v)); x.int('TOGG', 0); x.push(0); });
  w.list('LSST', T.STRUCT, STRING_SETTINGS, (x, s) => { x.str('DEF', s.def); x.str('HLAB', ''); x.str('ID', s.id); x.str('LABL', s.label); x.int('LOCF', 0); x.int('TOGG', 0); x.push(0); });
}
function fetchSettingsGroups(w) {
  w.list('LGRP', T.STRUCT, SETTING_GROUPS, (x, g) => { x.str('ID', g.id); x.stringList('LSET', g.settings); x.list('LVWS', T.STRUCT, [], () => {}); x.push(0); });
}
// Authentication::getAccount -> AccountInfo (BlazeSDK 3 layout)
function accountInfo(w, session) {
  w.int('AMU', 0); w.str('ASRC', '300294'); w.str('CO', 'US'); w.str('DOB', ''); w.str('DTCR', ''); w.int('GOPT', 0); w.str('LATH', ''); w.str('LN', 'en');
  w.str('MAIL', session ? `${session.onlineId.toLowerCase()}@rpcn.local` : ''); w.str('PML', ''); w.int('RC', 0); w.int('STAS', 2); w.int('STAT', 0); w.str('TOSV', ''); w.int('TPOT', 0); w.int('UDU', 0); w.int('UID', session?.userId ?? 0);
}

// Util userSettingsLoad/Save/LoadAll: small per-user key/value store persisted under spike/blaze/private/ (gitignored).
// The client writes KEY "FirstTimeFlag" = "0" after the EA-account welcome/opt-in screens; loading it back skips them.
const STORE_FILE = path.join(privateDir(), 'usersettings.json');
// Written in one step with the replaced copy kept as usersettings.json.bak; a damaged file falls back to that copy.
const settingsLog = (m) => log('blaze', m);
const userStore = loadJsonState(STORE_FILE, { validate: (v) => !!v && typeof v === 'object' && !Array.isArray(v), log: settingsLog, what: 'the user settings (usersettings.json)' }).value ?? {};
const userKey = (session) => String(session?.userId ?? 'anonymous');
const getSetting = (session, key) => userStore[userKey(session)]?.[key] ?? '';
// bounded: a handful of short flags per user, never an arbitrary blob store
const putSetting = (session, key, value) => {
  const mine = (userStore[userKey(session)] ??= {});
  if (key.length > 64 || value.length > 4096 || (!Object.hasOwn(mine, key) && Object.keys(mine).length >= 64) || ['__proto__', 'constructor', 'prototype'].includes(key)) { log('blaze', 'user setting refused (too large or too many)'); return; }
  mine[key] = value; try { saveJsonState(STORE_FILE, userStore, { pretty: 2, backup: true, log: settingsLog }); } catch (e) { log('blaze', `store write failed: ${e.message}`); } };

// Per-connection session (set by ps3Login)
const sessions = new WeakMap();
const liveSockets = new Set();
// A session ends (logout, disconnect, revoked, a new sign-in on the same connection): its file links stop working
// and a dynasty update it started but did not finish is released, so it cannot block the dynasty.
const endSession = (sock) => { const s = sessions.get(sock); if (s) { s.active = false; revokeSessionCapabilities(s); releaseSessionLocks(s); } sessions.delete(sock); };
// Failed logins per address (cloud mode): after the limit the address is refused without looking at the credential.
const loginLimiter = createRateLimiter({ limit: L.loginAttemptsPerMinute, windowMs: 60000 });
// createDynasty attempts per player per hour (ids and disk churn), on top of the limit on dynasties that exist
const createLimiter = createRateLimiter({ limit: Math.max(20, 2 * L.maxDynastiesPerUser), windowMs: 3600000 });
// The registry changed (site sync or an edited file): connections of players who were disabled, removed or re-issued
// are closed now, not at their next request.
function dropRevoked() {
  for (const sock of liveSockets) {
    const s = sessions.get(sock);
    if (s && !registry.isActive(s)) { log('blaze', `closing the session of user ${s.userId}: no longer in the registry (disabled, removed or credential replaced)`); endSession(sock); sock.destroy(); }
  }
}
registry?.on('update', dropRevoked);
function extendedData(w, session) {
  w.struct('DATA', (d) => {
    d.unionUnset('ADDR');
    d.str('BPS', 'rs-prod-ps3');
    d.intMap('CMAP', []);
    d.str('CTY', '');
    d.emptyVariable('CVAR');
    d.intMap('DMAP', []);
    d.int('HWFG', 0);
    d.intList('PSLM', []);
    d.struct('QDAT', (q) => { q.int('DBPS', 0); q.int('NATT', 4); q.int('UBPS', 0); });
    d.int('UATT', 0);
    d.list('ULST', T.OBJID, [session.personaId], (x, id) => { x.varint(USERSESSIONS); x.varint(2); x.varint(id); });
  });
}
function consoleLogin(sock, p, body) {
  const ticket = Buffer.from(String(body.TCKT ?? '0x').replace(/^0x/, ''), 'hex');
  let t = { userId: 1000, onlineId: 'Player' };
  endSession(sock);
  if (REGISTRY || ticket.subarray(0,8).equals(MAGIC)) {
    const ip = clientIp(sock.remoteAddress);
    if (HARD && loginLimiter.blocked(ip)) { noisy.write(ip, `login refused for ${ip}: too many failed attempts`); replyError(sock,p,0x4000,{ quiet: true }); sock.end(); return; }
    // The member list has not been confirmed with the site for longer than allowed (NCAA_REGISTRY_MAX_AGE_HOURS):
    // no new sign-ins until the site answers again. Players who are already signed in are not touched.
    if (REGISTRY && !registry.signInsOpen()) { noisy.write(ip, `sign-in refused for ${ip}: the member list is too old (the site has not been reachable); see the [registry] WARNING lines`); return replyError(sock,p,0x4000,{ quiet: true }); }
    try { if (!REGISTRY) throw new Error('Local NP registry not configured'); t = registry.authenticate(ticket); }
    catch { if (HARD) loginLimiter.hit(ip); noisy.write(ip, `league authentication rejected (${ip})`); return replyError(sock,p,0x4000,{ quiet: true }); }
  } else {
    try { t = parseXi5(ticket); } catch (e) { log('blaze', `ticket parse failed: ${e.message}`); }
  }
  const session = { ...t, active: true, userId: t.userId ?? 1000, personaId: t.userId ?? 1000, onlineId: t.onlineId ?? 'Player', key: crypto.randomBytes(16).toString('hex'), loginAt: Math.floor(Date.now() / 1000) };
  sessions.set(sock, session);
  if (!REGISTRY) setLoginIdentity(session); // legacy Sports World identity; registry mode authenticates each sign-in itself
  log('blaze', `ps3Login for ${session.onlineId} (user ${session.userId}, service ${t.serviceId ?? '?'})${sock.encrypted ? ` over an encrypted connection (SSLv3 ${sock.encrypted})` : ''}`);
  reply(sock, p, (w) => {
    w.int('AGUP', 0); w.str('LDHT', ''); w.int('NTOS', 0); w.str('PRIV', '');
    w.struct('SESS', (s) => {
      s.int('BUID', session.userId); s.int('FRST', 0); s.str('KEY', session.key); s.int('LLOG', session.loginAt); s.str('MAIL', `${session.onlineId.toLowerCase()}@rpcn.local`);
      s.struct('PDTL', (d) => { d.str('DSNM', session.onlineId); d.int('LAST', session.loginAt); d.int('PID', session.personaId); d.int('STAS', 2); d.int('XREF', session.userId); d.int('XTYP', 2); });
      s.int('UID', session.userId);
    });
    w.int('SPAM', 0); w.str('THST', ''); w.str('TSUI', ''); w.str('TURI', '');
  }, '(ConsoleLoginResponse)');
  // Blaze 3 (2013) clients move to the "authenticated" state on this UserSessions notification (id 8), as in the BF4 reference.
  notify(sock, USERSESSIONS, 8, (w) => {
    w.int('ALOC', LOCALE_EN_US); w.int('BUID', session.userId); w.objid('CGID', USERSESSIONS, 2, session.personaId); w.str('DSNM', session.onlineId);
    w.int('FRSC', 0); w.int('FRST', 0); w.str('KEY', session.key); w.int('LAST', session.loginAt); w.int('LLOG', session.loginAt);
    w.str('MAIL', `${session.onlineId.toLowerCase()}@rpcn.local`); w.int('PID', session.personaId); w.int('PLAT', 2); w.int('UID', session.userId);
    w.int('USTP', 0); w.int('XREF', session.userId);
  }, 'UserAuthenticated');
  notify(sock, USERSESSIONS, 1, (w) => { extendedData(w, session); w.int('USID', session.personaId); }, 'UserSessionExtendedDataUpdate');
  notify(sock, USERSESSIONS, 2, (w) => { extendedData(w, session); w.struct('USER', (u) => { u.int('AID', session.userId); u.int('ALOC', LOCALE_EN_US); u.blob('EXBB', Buffer.alloc(0)); u.int('EXID', session.userId); u.int('ID', session.personaId); u.str('NAME', session.onlineId); }); }, 'UserAdded');
  notify(sock, USERSESSIONS, 5, (w) => { w.int('FLGS', 3); w.int('ID', session.personaId); }, 'UserUpdated');
}

// Playgroups (component 6): once inside a dynasty the client creates a playgroup named DYN<id> (createPlaygroup {JOIN, PGRP}).
// Blaze 3 ids: 1 createPlaygroup, 2 destroyPlaygroup, 3 joinPlaygroup, 4 leavePlaygroup, 5 setPlaygroupAttributes,
// 6 setMemberAttributes, 7 kickPlaygroupMember, 8 setPlaygroupJoinControls, 9 finalizePlaygroupCreation, 10 lookupPlaygroupInfo;
// notifications 50 destroy, 51 NotifyJoinPlaygroup, 52 member joined, 53 member removed (class order in the EBOOT matches).
let nextPlaygroupId = 1;
function playgroupInfo(w, g, session) {
  w.stringMap('ATTR', {}); w.int('ENBV', g.ENBV ?? 0); w.unionUnset('HNET'); w.int('HSID', 0); w.int('JOIN', g.JOIN ?? 0); w.int('MLIM', g.MLIM ?? 12);
  w.str('NAME', String(g.NAME ?? '')); w.int('NTOP', g.NTOP ?? 0); w.int('OWNR', session?.userId ?? 0); w.int('PGID', g.pgid); w.int('PRES', g.PRES ?? 0);
  w.str('UKEY', String(g.UKEY ?? '')); w.int('UPRS', g.UPRS ?? 0); w.str('UUID', String(g.UUID ?? '')); w.int('VOIP', g.VOIP ?? 0); w.blob('XNNC', Buffer.alloc(0)); w.blob('XSES', Buffer.alloc(0));
}
function playgroupMember(w, session) {
  w.stringMap('ATTR', {}); w.int('JTIM', Math.floor(Date.now() / 1000));
  w.struct('USER', (u) => { u.int('AID', session?.userId ?? 0); u.int('ALOC', LOCALE_EN_US); u.blob('EXBB', Buffer.alloc(0)); u.int('EXID', session?.userId ?? 0); u.int('ID', session?.personaId ?? 0); u.str('NAME', session?.onlineId ?? 'Player'); });
}
function handlePlaygroups(sock, p, body, session) {
  switch (p.command) {
    case 1: { // createPlaygroup {JOIN, PGRP} -> {INFO, MLST} + NotifyJoinPlaygroup
      const g = { ...(body.PGRP ?? {}), pgid: nextPlaygroupId++ };
      reply(sock, p, (w) => { w.struct('INFO', (x) => playgroupInfo(x, g, session)); w.list('MLST', T.STRUCT, [1], (x) => { playgroupMember(x, session); x.push(0); }); }, `(createPlaygroup ${g.NAME} -> PGID ${g.pgid})`);
      notify(sock, PLAYGROUPS, 51, (w) => { w.struct('INFO', (x) => playgroupInfo(x, g, session)); w.list('MLST', T.STRUCT, [1], (x) => { playgroupMember(x, session); x.push(0); }); w.int('USER', session?.userId ?? 0); }, 'NotifyJoinPlaygroup');
      return;
    }
    case 10: return reply(sock, p, (w) => w.list('PGPS', T.STRUCT, [], () => {}), '(lookupPlaygroupInfo: none)');
    default: return reply(sock, p, undefined, `(Playgroups cmd ${p.command}: empty)`);
  }
}

// ---- what a connection may send, and how much of it is read ----
// With the member list on, a connection that has not signed in may send only what a console sends before its
// sign-in, in packets of a few KB, and only the four of those commands that carry something the server reads are
// decoded at all. After sign-in each command has its own size limit: megabytes only for the two that upload rows.
// STRICT (limits or the member list on) also caps what one message may decode into (tdf.mjs): items per list, and
// values in total. On a local PC with neither, one generous packet limit applies and everything is decoded, as before.
const STRICT = HARD || REGISTRY;
const LOCAL_MAX_PACKET = 16 * 1024 * 1024;
const MAX_EARLY_PACKETS = 200; // packets one connection may send before it signs in (a console sends about twenty)
const allowedBeforeSignIn = (p) => p.component === AUTH || (p.component === UTIL && [1, 2, 4, 5, 7, 20].includes(p.command)) || (p.component === USERSESSIONS && p.command === 35);
// sign-in (the credential), client config (its id), localized strings (ids), profanity filter (texts)
const decodedBeforeSignIn = (p) => (p.component === AUTH && p.command === 200) || (p.component === UTIL && [1, 4, 20].includes(p.command));
const ROW_UPLOAD = (h) => h.component === DOD && h.command === 12; // sendTableUpdate: largest real packet 191 KB
const LIST_UPLOAD = (h) => h.component === DOD && h.command === 80; // optimizeProspectInfo: largest real packet 37 KB
function packetLimit(sock, head) {
  if (!STRICT) return LOCAL_MAX_PACKET;
  if (!sessions.get(sock)) return L.preauthPacketBytes;
  if (ROW_UPLOAD(head)) return L.maxPacketBytes;
  if (LIST_UPLOAD(head)) return Math.min(L.maxPacketBytes, 1024 * 1024);
  return L.commandPacketBytes;
}
const DECODE_EARLY = { maxElements: 256, maxNodes: 1024 };
const DECODE_COMMAND = { maxElements: 4096, maxNodes: 20000 };
const DECODE_LIST_UPLOAD = { maxElements: 25000, maxNodes: 200000 };
const DECODE_ROW_UPLOAD = { maxElements: 65536, maxNodes: 2000000 };
const decodeLimits = (p, session) => (!STRICT ? undefined : !session ? DECODE_EARLY : ROW_UPLOAD(p) ? DECODE_ROW_UPLOAD : LIST_UPLOAD(p) ? DECODE_LIST_UPLOAD : DECODE_COMMAND);

function handle(sock, p, body) {
  if (p.type !== MSG.REQUEST) return;
  const session = sessions.get(sock);
  if (REGISTRY && session) {
    const account = registry.find(session.userId);
    if (!account || account.disabled || account.ticketSha256 !== session.credentialSha256) {
      endSession(sock); return replyError(sock,p,0x4000);
    }
    session.joinDynasties = [...account.joinDynasties];
  }
  if (REGISTRY && !session && p.component !== AUTH && !(p.component === UTIL && [1,2,4,5,7,20].includes(p.command))
      && !(p.component === USERSESSIONS && p.command === 35))
    return replyError(sock,p,0x4000);
  if (p.component === UTIL) {
    switch (p.command) {
      case 1: return reply(sock, p, (w) => w.stringMap('CONF', clientConfig(String(body.CFID ?? ''))), `(${body.CFID}: ${Object.keys(clientConfig(String(body.CFID ?? ''))).length} keys)`);
      case 2: return reply(sock, p, (w) => w.int('STIM', Math.floor(Date.now() / 1000)));
      case 4: { const ids = body.LSID?.items ?? []; return reply(sock, p, (w) => w.stringMap('SMAP', Object.fromEntries(ids.map((id) => [id, id]))), `(${ids.length} strings)`); }
      case 5: return reply(sock, p, telemetry);
      case 7: return reply(sock, p, preAuth, '(preAuth)');
      case 8: return reply(sock, p, postAuth, '(postAuth)');
      case 10: { const key = String(body.KEY ?? ''); const data = getSetting(session, key); return reply(sock, p, (w) => { w.str('DATA', data); w.str('KEY', key); }, `(userSettingsLoad ${key} = ${JSON.stringify(data)})`); }
      case 11: putSetting(session, String(body.KEY ?? ''), String(body.DATA ?? '')); return reply(sock, p, undefined, `(userSettingsSave ${body.KEY} = ${JSON.stringify(body.DATA)})`);
      case 12: return reply(sock, p, (w) => w.stringMap('SMAP', { ...(userStore[userKey(session)] ?? {}) }), '(userSettingsLoadAll)');
      // filterForProfanity: echo every text back as FILTER_RESULT_PASSED (DIRT 0). Run 10 crashed on an empty reply here.
      case 20: { const items = (body.TLST?.items ?? []).map((t) => String(t.UTXT ?? '')); return reply(sock, p, (w) => w.list('TLST', T.STRUCT, items, (x, txt) => { x.int('DIRT', 0); x.str('UTXT', txt); x.push(0); }), `(profanity filter passed: ${JSON.stringify(items)})`); }
      default: return reply(sock, p);
    }
  }
  if (p.component === AUTH) {
    switch (p.command) {
      case 200: return consoleLogin(sock, p, body);
      case 30: return reply(sock, p, (w) => accountInfo(w, session), '(AccountInfo)');
      case 36: return reply(sock, p, (w) => w.str('AUTH', `AUTH_${session?.key ?? 'none'}`));
      case 29: case 32: return reply(sock, p, (w) => w.list('NLST', T.STRUCT, [], () => {}), '(no entitlements)');
      case 42: return reply(sock, p, (w) => { w.int('EAMC', 0); w.str('LHST', ''); w.int('PMC', 0); w.str('PRIV', ''); w.str('THST', ''); w.str('TSUI', ''); w.str('TURI', ''); });
      case 70: endSession(sock); return reply(sock, p, undefined, '(logout)');
      default: return reply(sock, p, undefined, '(generic empty)');
    }
  }
  if (p.component === USERSESSIONS) {
    // 35 = resumeSession {SKEY}. Sessions are not kept across a reconnect, so the client must log in again.
    // 0x16 is USER_ERR_RESUMABLE_SESSION_NOT_FOUND (full code 0x00167802). 0x4000 is ERR_SYSTEM and drops the socket.
    if (p.command === 35) return replyError(sock, p, 0x16);
    reply(sock, p, undefined, '(empty)');
    if (p.command === 20 && session) notify(sock, USERSESSIONS, 1, (w) => { extendedData(w, session); w.int('USID', session.personaId); }, 'UserSessionExtendedDataUpdate (after updateNetworkInfo)');
    return;
  }
  if (p.component === PLAYGROUPS) return handlePlaygroups(sock, p, body, session);
  if (p.component === LOCKER) return handleLocker({ p, body, session, reply: (build, note) => reply(sock, p, build, note), replyError: (code, note) => { log('blaze', note ?? ''); replyError(sock, p, code); } });
  if (p.component === DOD) {
    if (REGISTRY && !authorizeDod(p.command,body,session,dodStore,getContent)) return replyError(sock,p,0x4000);
    // createDynasty: a bounded number per player, so one account cannot fill the disk. Counted by who CREATED each
    // dynasty that still exists (handing one to a friend and leaving does not free a slot), plus a cap per hour.
    if (HARD && p.command === 2) {
      const mine = dynastiesCreatedBy(session?.userId ?? 0);
      if (mine >= L.maxDynastiesPerUser) { log('blaze', `createDynasty refused for user ${session?.userId}: ${mine} dynasties they created still exist; the limit is ${L.maxDynastiesPerUser} (NCAA_MAX_DYNASTIES_PER_USER)`); return replyError(sock,p,0x4000); }
      if (!createLimiter.hit(session?.userId ?? 0)) { log('blaze', `createDynasty refused for user ${session?.userId}: too many created in the last hour`); return replyError(sock,p,0x4000); }
    }
    return handleDod({ p, body, session, reply: (_, build, note) => reply(sock, p, build, note), replyError: (code) => replyError(sock, p, code) });
  }
  if (p.component === STATS && p.command === 15) return reply(sock, p, (w) => w.map('KSIT', T.STRING, T.STRUCT, [], () => {}, () => {}), '(KeyScopes: empty map)');
  if (p.component === MESSAGING && p.command === 2) return reply(sock, p, (w) => w.int('MCNT', 0), '(fetchMessages: 0 messages)');
  if (p.component === ROOMS || p.component === CENSUS) return reply(sock, p, undefined, '(empty)');
  if (p.component === OSDK_SETTINGS) {
    if (p.command === 1) return reply(sock, p, fetchSettings, `(fetchSettings: ${INT_SETTINGS.length} int + ${STRING_SETTINGS.length} string settings)`);
    if (p.command === 2) return reply(sock, p, fetchSettingsGroups, `(fetchSettingsGroups: ${SETTING_GROUPS.length} groups)`);
  }
  if (p.component === OSDK_DYNMSG) {
    if (p.command === 1) return reply(sock, p, (w) => { w.int('ENUM', 0); w.list('MSGS', T.STRUCT, [], () => {}); }, '(DynamicMessaging getMessages: none)');
    if (p.command === 2) return reply(sock, p, (w) => { w.int('CDRD', 100); w.int('CERD', 100); w.int('CMDI', 10); w.int('CMMC', 10); }, '(DynamicMessaging getConfig)');
  }
  if (p.component === OSDK_TICKER2) {
    if (p.command === 2) return reply(sock, p, (w) => w.int('MSGS', 0), '(Ticker2 registerArgs)');
    if (p.command === 3) return reply(sock, p, (w) => w.list('DATA', T.STRUCT, [], () => {}), '(Ticker2 getMessages: none)');
    if (p.command === 4) return reply(sock, p, (w) => { w.int('BOT_', body.FILT?.BOT_ ?? 0); w.int('TOP_', body.FILT?.TOP_ ?? 0); }, '(Ticker2 updateFilters)');
  }
  if (p.component === OSDK_ONLINEPASS && p.command === 3) return reply(sock, p, (w) => w.list('LIST', T.STRUCT, [], () => {}), '(OnlinePass fetchGates: none)');
  if (UNKNOWN === 'empty' || p.component >= 0x800) return reply(sock, p, undefined, '(unknown: empty response)');
  replyError(sock, p);
}

log('blaze', `capture file: ${captureFile} (settings mode: ${SETTINGS_MODE})`);
// One line that says which profile is running (deploy/league-server/check.sh looks for it).
log('blaze', CLOUD ? 'mode: cloud (member list required, limits on)' : `mode: local (${REGISTRY ? 'member list from a file' : 'no member list: anyone who can connect can sign in'}${HARD ? ', limits on' : ''}${LAN ? ', home network (--lan)' : ''})`);
if (CLOUD) log('blaze', `cloud mode: consoles are sent to ${advHttp.host()} (${cfg.publicHost}, advertising ${cfg.advertise}); registry ${cfg.registrySync ? `synced from ${new URL(cfg.registrySync.url).origin} every ${cfg.registrySync.intervalMs / 1000}s` : `file ${REGISTRY_PATH}`} (${registry.current().players.length} player(s))`);
const httpOptions = { host: () => advHttp.host(), bind: BIND, limits: HARD ? L : null, hardened: HARD };
startLockerHttp({ port: HTTP_PORT, ...httpOptions });
if (SUPERSIM_ON) startSupersimPoller({ store: dodStore, save: dodSave, loadTable: dodLoadTable });
if (EASW_ON) { startEaswHttp({ port: EASW_PORT, ...httpOptions }); startWireSync({ store: dodStore, loadTable: dodLoadTable }); }
else log('blaze', 'Sports World disabled (--easw off): no in-game Dynasty Wire');
const guard = HARD ? createConnectionGuard({ maxTotal: L.maxConns, maxPerIp: L.maxConnsPerIp, perMinutePerIp: L.connsPerMinutePerIp }) : null;
// One connection. `raw` is the TCP socket: the connection cap, the timeouts and 'close' are always on it. `sock` is
// what the packet handling above writes to and keys the session on: the TCP socket itself (plaintext), or with
// NCAA_BLAZE_TLS on a small stand-in that sends through the SSLv3 wrapper. Either way the same limits apply.
const server = net.createServer((raw) => {
  const ip = clientIp(raw.remoteAddress);
  raw.on('error', (e) => noisy.write(ip, `socket error ${e.message}`));
  if (guard && !guard.admit(raw)) { noisy.write(ip, `refused ${ip} (connection limit)`); raw.destroy(); return; }
  noisy.write(ip, `connection from ${raw.remoteAddress}:${raw.remotePort}`);
  let ssl = null, sock = raw, handshake = null;
  if (tlsOptions) {
    // strict: bytes that are not SSLv3 (a plaintext Blaze packet, a port scan), a failed check value or a broken
    // handshake close this connection, and only this one (sslv3-server.mjs destroys the socket; nothing is thrown)
    ssl = new Sslv3ServerSocket(raw, { ...tlsOptions, strict: true, log: (t, m) => { if (t !== 'alert' && (!CLOUD || t === 'error' || t === 'warn')) noisy.write(ip, `ssl ${t} (${ip}): ${m}`); } });
    ssl.on('error', () => {}); // the socket error is already logged above
    // what the game says when it will not go on: 42 / 48 mean it did not accept the certificate for this address
    ssl.on('alert', (level, desc) => noisy.write(ip, `ssl alert from ${ip}: level ${level} description ${desc}${desc === 42 ? ' (bad_certificate)' : desc === 48 ? ' (unknown_ca)' : desc === 40 ? ' (handshake_failure)' : desc === 0 ? ' (close_notify)' : ''}`));
    sock = {
      write: (pkt) => ssl.write(pkt), end: () => ssl.end(), destroy: () => raw.destroy(),
      get destroyed() { return raw.destroyed; }, get writableLength() { return raw.writableLength; },
      remoteAddress: raw.remoteAddress, remotePort: raw.remotePort, encrypted: '',
    };
    // a connection that does not finish the handshake is not a console (with or without the other limits)
    handshake = setTimeout(() => { if (!ssl.secure) { noisy.write(ip, `closing ${ip}: no SSL handshake within ${L.tlsHandshakeSeconds}s`); raw.destroy(); } }, L.tlsHandshakeSeconds * 1000);
    ssl.on('secure', (suite) => { clearTimeout(handshake); sock.encrypted = suite; noisy.write(ip, `encrypted connection from ${ip} (SSLv3 ${suite})`); });
  }
  liveSockets.add(sock);
  let preauth = null, windowStart = Date.now(), inWindow = 0, early = 0;
  if (HARD) {
    hardenSocket(raw, { idleMs: L.idleSeconds * 1000 }); // the console pings every 30 s; silence this long is a dead peer
    // a connection that never logs in is not a console
    preauth = setTimeout(() => { if (!sessions.get(sock)) { noisy.write(ip, `closing ${ip}: no login within ${L.preauthSeconds}s`); sock.destroy(); } }, L.preauthSeconds * 1000);
  }
  // a signed-in player's connection being dropped is always logged, with who it was; a stranger's is rate-limited
  const drop = (why) => { const who = sessions.get(sock); if (who) log('blaze', `dropping ${ip} (user ${who.userId}): ${why}`); else noisy.write(ip, `dropping ${ip}: ${why}`); sock.destroy(); };
  // the size limit is asked per packet, when its header arrives: a few KB until this connection has signed in
  const stream = new PacketStream({ limitFor: (head) => packetLimit(sock, head) });
  (ssl ?? raw).on('data', (chunk) => { // plaintext: bytes off the wire. Encrypted: the decrypted bytes of one record
    stream.push(chunk);
    for (;;) {
      if (sock.destroyed) return;
      let p;
      try { p = stream.next(); } catch (e) { return drop(`${e.message}${STRICT && !sessions.get(sock) ? ' before sign-in' : e.head ? ` for ${e.head.component}/${e.head.command}` : ''}`); }
      if (!p) return;
      if (HARD) {
        const t = Date.now(); if (t - windowStart >= 10000) { windowStart = t; inWindow = 0; }
        if (++inWindow > L.packetsPer10s) return drop('packet flood');
      }
      if (STRICT && p.type !== MSG.REQUEST) continue; // a server takes requests only; nothing else is even decoded
      const session = sessions.get(sock);
      let body = {};
      if (STRICT && !session) {
        if (++early > MAX_EARLY_PACKETS) return drop(`more than ${MAX_EARLY_PACKETS} packets without signing in`);
        if (REGISTRY && !allowedBeforeSignIn(p)) { // refused unread: not decoded, one short error, a rate-limited log line
          noisy.write(ip, `refused ${describe(p)} from ${ip}: not signed in`); replyError(sock, p, 0x4000, { quiet: true }); continue;
        }
      }
      if (!(REGISTRY && !session) || decodedBeforeSignIn(p)) {
        try { body = decode(p.payload, decodeLimits(p, session)); }
        catch (e) {
          if (STRICT) { (session ? (m) => log('blaze', m) : (m) => noisy.write(ip, m))(`refused ${describe(p)} from ${session ? `user ${session.userId}` : ip}: ${e.message}`); replyError(sock, p, 0x4000, { quiet: true }); continue; }
          body = { $decodeError: e.message, hex: p.payload.subarray(0, 4096).toString('hex') };
        }
      }
      if (logBodies) log('blaze', describe(p), body.TCKT === undefined ? body : { ...body, TCKT: '[redacted]' });
      try { handle(sock, p, body); } catch (e) { log('blaze', `handler error ${e.stack ?? e.message}`); }
    }
  });
  raw.on('close', () => { clearTimeout(preauth); clearTimeout(handshake); endSession(sock); liveSockets.delete(sock); noisy.write(ip, 'connection closed'); });
});
exitOnListenError(server, (m) => log('blaze', m), `listen on ${BIND}:${PORT}`);
server.listen(PORT, BIND, () => log('blaze', `blaze stub listening on ${BIND}:${server.address().port} (${BLAZE_TLS ? 'encrypted: SSLv3, NCAA_BLAZE_TLS on' : 'plaintext'}), unknown commands -> ${UNKNOWN}${REGISTRY ? '; registry mode' : ''}${CLOUD ? '; cloud mode' : ''}`));
