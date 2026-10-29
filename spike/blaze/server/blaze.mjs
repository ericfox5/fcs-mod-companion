// Plaintext Blaze 3 stub for the NCAA 14 spike: logs every packet (decoded TDF) and answers the Util / Authentication /
// UserSessions calls the client makes while logging in, so we can watch what it asks for next (the dynasty component).
//   node blaze.mjs [--port 33152] [--service ncaa-2014-ps3] [--unknown empty|error] [--http-port 17503] [--settings minimal|full]
// The same process serves the Locker file endpoint (HTTP) that Online Dynasty uploads its .team/.dynasty files to.
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PacketStream, encodePacket, describe, MSG } from './packet.mjs';
import { decode, Writer, T } from './tdf.mjs';
import { parseXi5 } from './xi5.mjs';
import { log, captureFile } from './log.mjs';
import { DOD, handleDod } from './dod.mjs';
import { LOCKER, handleLocker, startLockerHttp } from './locker.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const PORT = Number(arg('--port', 33152));
const SERVICE = arg('--service', 'ncaa-2014-ps3');
const UNKNOWN = arg('--unknown', 'empty');
const QOS_ADDR = arg('--qos-addr', '127.0.0.1');
const QOS_PORT = Number(arg('--qos-port', 17502));
const QOS_PROBES = Number(arg('--qos-probes', 10));
const HTTP_PORT = Number(arg('--http-port', 17503)); // Locker upload/download endpoint (served by this process)
const HTTP_HOST = arg('--http-host', '127.0.0.1'); // host the client is told to use in UURL/GURL
const SETTINGS_MODE = arg('--settings', 'minimal'); // minimal (Zamboni's proven set) | full (every O_* setting found in the EBOOT)
const AUTH = 1, PLAYGROUPS = 6, UTIL = 9, STATS = 7, CENSUS = 10, MESSAGING = 15, ROOMS = 21, USERSESSIONS = 0x7802;
// EA OSDK components (ids from ZamboniCommonComponents, class names confirmed in the NCAA 14 EBOOT strings)
const OSDK_SETTINGS = 2249, OSDK_DYNMSG = 2250, OSDK_WEBOFFER = 2251, OSDK_SEASONAL = 2257, OSDK_TICKER2 = 2262, OSDK_ONLINEPASS = 2268;
const LOCALE_EN_US = 1701729619;

const send = (sock, pkt, note) => { sock.write(pkt); log('blaze', note, pkt.subarray(0, 200).toString('hex')); };
const reply = (sock, p, build, note = '') => {
  const w = new Writer(); if (build) build(w);
  send(sock, encodePacket({ component: p.component, command: p.command, type: MSG.RESPONSE, id: p.id, payload: w.bytes() }), `-> response ${describe(p)} ${note}`);
};
const replyError = (sock, p, code = 0x4000) => send(sock, encodePacket({ component: p.component, command: p.command, type: MSG.ERROR, error: code, id: p.id }), `-> ERROR 0x${code.toString(16)} for ${describe(p)}`);
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
    q.struct('BWPS', (b) => { b.str('PSA', QOS_ADDR); b.int('PSP', QOS_PORT); b.str('SNA', 'rs-prod-ps3'); });
    q.int('LNP', QOS_PROBES);
    q.map('LTPS', T.STRING, T.STRUCT, [['rs-prod-ps3', null]], (x, k) => x.string(k), (x) => { x.str('PSA', QOS_ADDR); x.int('PSP', QOS_PORT); x.str('SNA', 'rs-prod-ps3'); x.push(0); });
    q.int('SVID', 1337);
  });
  w.str('REGI', '302123');
  w.str('SVRN', 'Blaze 3.19.03.0 (CL# 0)');
  w.int('UAGE', 0);
}
const telemetry = (w) => { w.str('ADRS', '127.0.0.1'); w.int('ANON', 0); w.str('DISA', ''); w.str('FILT', '-UION/****'); w.int('LOC', LOCALE_EN_US); w.str('NOOK', 'US,CA,MX'); w.int('PORT', 9988); w.int('SDLY', 15000); w.str('SESS', 'spike'); w.str('SKEY', ''); w.int('SPCT', 75); w.str('STIM', ''); };
function postAuth(w) {
  w.struct('PSS', (s) => { s.str('ADRS', ''); s.blob('CSIG', Buffer.alloc(0)); s.str('PJID', '0'); s.int('PORT', 0); s.int('RPRT', 0); s.int('TIID', 0); });
  w.struct('TELE', telemetry);
  w.struct('TICK', (s) => { s.str('ADRS', '127.0.0.1'); s.int('PORT', 8999); s.str('SKEY', ''); });
  w.struct('UROP', (s) => { s.int('TMOP', 1); s.int('UID', 1); });
}

// Config sections the client fetches before login. Keys are the OSDK_* identifiers found in the game binary; values
// disable the Online Pass / Season Ticket gate (tollbooth) and point EA Sports World at our HTTP listener so any attempt shows up.
const QOS_HTTP = `http://${QOS_ADDR}:${QOS_PORT}`;
const COMMON_CONFIG = {
  OSDK_TOLLBOOTH_ONLINE_PASS_ENABLED: '0', OSDK_TOLLBOOTH_SEASON_TICKET_ENABLE: '0', OSDK_TOLLBOOTH_DDP_COMMERCE_ENABLED: '0',
  OSDK_TOLLBOOTH_DDR_ONLINE_PASS_ENABLED: '0', OSDK_TOLLBOOTH_EXPIRATION_TEST_MODE_ENABLED: '0', OSDK_TOLLBOOTH_DIME_TIMEOUT_SECS: '2',
  OSDK_DDP_UPGRADE_TO_DDR_ENABLED: '0', OSDK_ONLINEPASS_RETRIEVE_TIMEOUT: '2', OSDK_SUBSCRIPTION_RETRIEVE_TIMEOUT: '2',
  OSDK_SUBSCRIPTION_WEB_RETRIEVE_TIMEOUT: '2', OSDK_MATCHUP_TIMEOUT: '30', OSDK_REMATCH_ACCEPT_TIMEOUT: '30', OSDK_MAX_PER_OTP_SIDE: '6',
  OSDK_EASW_AUTH_URL: `${QOS_HTTP}/easw/authentication`, OSDK_EASW_EVENT_URL: `${QOS_HTTP}/easw/event`, OSDK_EASW_GF_FILE_URL: `${QOS_HTTP}/easw/gameface`,
  OSDK_EASW_MEDIA_URL: `${QOS_HTTP}/easw/media`, OSDK_EASW_REQ_URL: `${QOS_HTTP}/easw/req`, OSDK_NO_MEDIA_URL: `${QOS_HTTP}/easw/nomedia.jpg`,
  OSDK_ONDEMAND_DEFAULT_BACKGROUND_URL: `${QOS_HTTP}/easw/bg.jpg`, OSDK_ONDEMAND_DEFAULT_THUMBNAIL_URL: `${QOS_HTTP}/easw/thumb.jpg`,
  OSDK_ONLINEPASS_DOWNLOAD_URL: `${QOS_HTTP}/easw/onlinepass`, OSDK_ONLINEPASS_TRIAL_URL: `${QOS_HTTP}/easw/onlinepass`,
};
// Extra keys per config id, named after the OSDK_* strings the EBOOT reads for that section. Ticker count 0 = no ticker polling.
const CONFIG_EXTRA = {
  OSDK_TICKER: { OSDK_TICKER_COUNT: '0', OSDK_TICKER_POLLING_DELAY: '600000', OSDK_TICKER_NEWS_HEADER: 'NEWS', OSDK_SPORTS_SCORES: '0', TICKER_RACING_HEADER: 'RACING' },
  OSDK_ABUSE_REPORTING: { OSDK_ABUSE_NUM_TYPES: '0' },
};
const clientConfig = (cfid) => ({ ...COMMON_CONFIG, ...(CONFIG_EXTRA[cfid] ?? {}) });

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
const STORE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private', 'usersettings.json');
const loadStore = () => { try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return {}; } };
const userStore = loadStore();
const userKey = (session) => String(session?.userId ?? 'anonymous');
const getSetting = (session, key) => userStore[userKey(session)]?.[key] ?? '';
const putSetting = (session, key, value) => { (userStore[userKey(session)] ??= {})[key] = value; try { fs.writeFileSync(STORE_FILE, JSON.stringify(userStore, null, 2)); } catch (e) { log('blaze', `store write failed: ${e.message}`); } };

// Per-connection session (set by ps3Login)
const sessions = new WeakMap();
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
  try { t = parseXi5(ticket); } catch (e) { log('blaze', `ticket parse failed: ${e.message}`); }
  const session = { userId: t.userId ?? 1000, personaId: t.userId ?? 1000, onlineId: t.onlineId ?? 'Player', key: crypto.randomBytes(16).toString('hex'), loginAt: Math.floor(Date.now() / 1000) };
  sessions.set(sock, session);
  log('blaze', `ps3Login for ${session.onlineId} (user ${session.userId}, service ${t.serviceId ?? '?'})`);
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

function handle(sock, p, body) {
  if (p.type !== MSG.REQUEST) return;
  const session = sessions.get(sock);
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
      case 70: sessions.delete(sock); return reply(sock, p, undefined, '(logout)');
      default: return reply(sock, p, undefined, '(generic empty)');
    }
  }
  if (p.component === USERSESSIONS) {
    reply(sock, p, undefined, '(empty)');
    if (p.command === 20 && session) notify(sock, USERSESSIONS, 1, (w) => { extendedData(w, session); w.int('USID', session.personaId); }, 'UserSessionExtendedDataUpdate (after updateNetworkInfo)');
    return;
  }
  if (p.component === PLAYGROUPS) return handlePlaygroups(sock, p, body, session);
  if (p.component === LOCKER) return handleLocker({ p, body, session, reply: (build, note) => reply(sock, p, build, note), replyError: (code, note) => { log('blaze', note ?? ''); replyError(sock, p, code); } });
  if (p.component === DOD) return handleDod({ p, body, session, reply: (_, build, note) => reply(sock, p, build, note) });
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
startLockerHttp({ port: HTTP_PORT, host: HTTP_HOST });
net.createServer((sock) => {
  log('blaze', `connection from ${sock.remoteAddress}:${sock.remotePort}`);
  const stream = new PacketStream();
  sock.on('data', (chunk) => {
    for (const p of stream.feed(chunk)) {
      let body;
      try { body = decode(p.payload); } catch (e) { body = { $decodeError: e.message, hex: p.payload.toString('hex') }; }
      log('blaze', describe(p), body);
      try { handle(sock, p, body); } catch (e) { log('blaze', `handler error ${e.stack ?? e.message}`); }
    }
  });
  sock.on('error', (e) => log('blaze', `socket error ${e.message}`));
  sock.on('close', () => log('blaze', 'connection closed'));
}).listen(PORT, '0.0.0.0', () => log('blaze', `blaze stub listening on 0.0.0.0:${PORT} (plaintext), unknown commands -> ${UNKNOWN}`));
