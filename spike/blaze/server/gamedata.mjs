// Supersim -> console game data: the per-game tables a load or an advance downloads for a member's game that was not
// played on that console (RE 2026-10-30, spike/blaze/NOTES.md). DynastyStatus.GAME is list<DynastyFileInfo {DFID, TMID}>
// (copied like TEAM by 0x2f6b18). For a member team listed there, the load (0x334d78) and the advance (0x33b2a8,
// "Downloading Game Data for") queue 14 table descriptors (0x3138c4..0x31401c) and fetch each one with GetTableUpdate
// {TABL, FILT {COLM 'GH4X' = 0x47483458, VALU = DFID}} (0x2effb0; 0x2ed194 picks that filter for game tables). The rows
// fill the ODGM database; 0x43fd8c merges it into the dynasty (per table: delete all, insert; WQSC is appended and fetched
// as UWQS), 0x46c9e0 reads GINF (needs GQTR 6) and writes SCHD {GHSC, GASC, GSTA 2 away win / 3 home win, GFOT, GUTE}
// for its SEWN/SGNM, and 0x46c550 credits the stats. A game that is final in SCHD is not simulated by the advance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows as dbRows } from './tdb-read.mjs';

export const GAME_FILTER = 0x47483458;
// Column layouts exactly as the console uploads them after a played game (UPDT 2 sendTableUpdate, FLTY 2, TYPE 0).
export const LAYOUTS = {
  CASG: {SINT: ["CCID","CTIE"],INTC: ["GOID"]},
  CACG: {SINT: ["CCID","CTIE"],TINT: ["RPTB","CAPY"],INTC: ["CAMC","GOID"]},
  CSGM: {SINT: ["CCID"],TINT: ["PASR","CSRI","TAKR","RUNR","CSGP","CATR","AWRR","CSRM","CSRO","CSGU","STHR","CSRR","BSER","CLUR","CSRS","CSHO","CSGA","RSTR","RUBR","CSGB","PABR","CLVL","BLCS","CSRV","TODR","PARR","MNCR","SARR","BIGR","CSRB","CSRC","PLPR","NLVL","TOOR","CSKU","PFRR","CSGK","ZNCR","TACR","CSHD"],INTC: ["CEXP"]},
  SCOS: {SINT: ["SSTI","SSDE","TGID","SSPI","SSFI","SSPF"],TINT: ["SSPY","SSPT","SSDS","SSSC","SSOR","GQTR","SSTY","SSDP"],INTC: ["GTIM"]},
  UWQS: {TINT: ["GASC","SEWN","GQTR","GHSC","SGNM"]},
  PGNG: {SINT: ["PGID"],TINT: ["ggmP","ggmS","ggdp"]},
  TSGA: {SINT: ["tspc","tspa","tsoy","ts1y","tsTy","tsor","ts1r","tsop","ts1p","tsra","ts1l","TGID","ts1d","tsoa","tsqs","ts3d","ts3c","tsPy","tsnh","tskr","tshr","tspt","tssg","tssf","tsPd"],TINT: ["tspi","tsbz","tspe","tspd","ts2c","ts2a","tsrt","ts4r","tsoz","ts4p","t34y","tsot","ts4f","t31y","ts4d","ts4c","tsDi","tsdt","tsdr","tsof","tsga","t34c","tsdf","tsdd","t31c","ts3r","t33y","ts3p","tsfu","tsta","tsqk","tsfr","tsqh","tsfm","tsfl","tsPt","tsst","tsfa","t33c","tssk","tspu","tsPi","tsps","ts2r","tspo","ts2p"],INTC: ["tsty","tspr"]},
  GINF: {SINT: ["GHTG","GATG","SGID"],TINT: ["GFOT","GHSC","GQTR","GASC","GFSI","SGNM"]},
  PGKI: {SINT: ["PGID","gpny","gpya"],TINT: ["gkmd","gkme","gppt","gkfa","gkfb","gkfL","gkem","gkab","gpat","gkac","gpbl","gkad","gkae","gktb","gknk","gkfm","gkea","gptb","gkeb","gplN","gkmb","gkmc"]},
  PGKP: {SINT: ["grky","grpy","PGID"],TINT: ["grka","grpa","grkL","grpL","grkt","grpt"]},
  PGDE: {SINT: ["PGID","gdht","glfy","gsiy"],TINT: ["gslR","glsk","glff","glhs","glfr","glsa","glft","gsin","gdtl","glbl","gsit","gdpd","gdta","gsdt"]},
  PGOL: {SINT: ["PGID"],TINT: ["gosa","gopa"]},
  PGOF: {SINT: ["gaya","guyh","PGID","gcya","guya","gcyc"],TINT: ["gacm","gctd","gulN","gutd","galN","gatd","gcrL","gc2p","gu2p","gain","gcca","gufu","guat","gcdr","gaat","gacc","gasa","gu2y","gubt"]},
  IGAM: {SINT: ["PGID"],TINT: ["INJL","IIIG","INJT","INJR","INIR"]},
};
LAYOUTS.WQSC = LAYOUTS.UWQS;

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private', 'game-data');
const file = (did, id) => path.join(DIR, String(did), String(id) + '.json');
export const saveGameData = (did, id, data) => { fs.mkdirSync(path.dirname(file(did, id)), { recursive: true }); fs.writeFileSync(file(did, id), JSON.stringify(data)); };
export const loadGameData = (did, id) => { try { return JSON.parse(fs.readFileSync(file(did, id), 'utf8')); } catch { return null; } };

const n = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const total = (players, k) => players.reduce((a, p) => a + n(p[k]), 0);
const top = (players, k) => players.reduce((best, p) => (n(p[k]) > n(best?.[k]) ? p : best), null);
const OL = (p) => n(p.pos) >= 5 && n(p.pos) <= 9;

// The 14 game tables for one Supersim final, built from the envelope's detail block and the game's SCHD row. Stat columns
// follow the box-score codes (docs/tables.md; names from the EA DB Editor config): BOFF ga*/gu*/gc*, BDEF gd*/gl*/gs*,
// BKIC gk*/gp*, BKPR grk*/grp*, BOLN go*, BTES ts*. UWQS holds points per quarter (GQTR 1-4, 5 = OT). SCOS is the
// scoring summary (see ScoreEv in worker/src/supersim/coach/types.ts). The coach tables need the dynasty file the console
// loads (opts.db, tdb-read.mjs); without it they go out empty and the coach gets no in-game XP. IGAM (injuries) stays
// empty: the engine has no injuries.
export function buildGameTables(env, sched, opts = {}) {
  const g = env.gameResult, det = env.detail;
  if (!det || !Array.isArray(det.teams)) throw new Error('envelope has no game detail (site Supersim older than envelope v3)');
  const t = Object.fromEntries(Object.keys(LAYOUTS).filter((k) => k !== 'WQSC').map((k) => [k, []]));
  t.GINF.push({ GHTG: n(g.HTID), GATG: n(g.ATID), SGID: n(sched.SGID), GFOT: g.OTFL ? 1 : 0, GHSC: n(g.HTSC), GQTR: 6, GASC: n(g.ATSC), GFSI: 0, SGNM: n(sched.SGNM) });
  for (let q = 1; q <= 5; q++) t.UWQS.push({ GASC: n(q < 5 ? g[`AQ${q}S`] : g.AOTS), SEWN: n(sched.SEWN), GQTR: q, GHSC: n(q < 5 ? g[`HQ${q}S`] : g.HOTS), SGNM: n(sched.SGNM) });
  det.teams.forEach((team, side) => {
    const s = team.stats ?? {}, ps = team.players ?? [], o = det.teams[1 - side] ?? {}, os = o.stats ?? {}, ops = o.players ?? [];
    const kry = total(ps, 'kry'), pry = total(ps, 'pry'), fum = total(ps, 'fum'), ints = total(ps, 'pi');
    t.TSGA.push({
      TGID: n(team.tgid), ts1d: n(s.fd), tsoy: n(s.yds), tsop: n(s.py), tsor: n(s.ry), tspa: n(s.pa), tspc: n(s.pc), tsra: n(s.ra), ts3d: n(s.t3a), ts3c: n(s.t3c), ts4d: n(s.t4a), ts4c: n(s.t4c),
      tspe: n(s.pen), tsPy: n(s.peny), tspt: n(s.top), tspi: ints, tsfu: fum, tsfl: fum, tskr: kry, tspr: pry, tsty: kry + pry, tsTy: n(s.yds) + kry + pry, tspu: total(ps, 'pt'), tsPd: total(ps, 'pty'),
      tsrt: n(s.rtd), tsPt: n(s.ptd), tsoz: n(s.rz), tsot: n(s.rztd), tsof: n(s.rzfg), tsdr: n(os.rz), tsdt: n(os.rztd), tsdf: n(os.rzfg), ts2a: n(s.tp2a), ts2c: n(s.tp2c),
      tsga: ints + fum, tsta: total(ops, 'pi') + total(ops, 'fum'), tsDi: total(ops, 'pi'), tsfr: total(ops, 'fum'), tssk: n(s.sk),
    });
    for (const p of ps) {
      const PGID = n(p.pgid); if (!PGID) continue;
      if (n(p.pa) || n(p.ra) || n(p.rec) || n(p.drp)) t.PGOF.push({ PGID, gaat: n(p.pa), gacm: n(p.pc), gaya: n(p.py), gatd: n(p.ptd), gain: n(p.pi), galN: Math.max(0, n(p.lp)), gasa: n(p.sacked), gacc: n(p.tp2),
        guat: n(p.ra), guya: n(p.ry), gutd: n(p.rtd), gulN: Math.max(0, n(p.lr)), gufu: n(p.fum), guyh: n(p.yco), gubt: n(p.bt), gu2y: n(p.r20), gu2p: n(p.tr2),
        gcca: n(p.rec), gcya: n(p.rey), gctd: n(p.retd), gcrL: Math.max(0, n(p.lc)), gcyc: n(p.yac), gcdr: n(p.drp), gc2p: n(p.tc2) });
      if (['tk', 'sk', 'int', 'tfl', 'pd', 'ff', 'fr', 'sfty', 'blk', 'ast'].some((k) => n(p[k]))) t.PGDE.push({ PGID, gdta: n(p.tk), gdht: n(p.ast), gdtl: n(p.tfl), glsk: n(p.sk), glff: n(p.ff), glfr: n(p.fr), glsa: n(p.sfty), glbl: n(p.blk),
        gsin: n(p.int), gsiy: n(p.iry), gslR: Math.max(0, n(p.lir)), gsit: n(p.dtd), gdpd: n(p.pd) });
      if (n(p.fga) || n(p.xpa) || n(p.pt) || n(p.ko)) t.PGKI.push({ PGID, gkfa: n(p.fga), gkfm: n(p.fgm), gkfL: n(p.fgl), gkfb: n(p.fgb), gkea: n(p.xpa), gkem: n(p.xpm), gkeb: n(p.xpb),
        gkab: n(p.fa29), gkmb: n(p.fm29), gkac: n(p.fa39), gkmc: n(p.fm39), gkad: n(p.fa49), gkmd: n(p.fm49), gkae: n(p.fa50), gkme: n(p.fm50), gknk: n(p.ko), gktb: n(p.kotb),
        gpat: n(p.pt), gpya: n(p.pty), gpny: n(p.pt) ? n(p.pnet) : 0, gplN: n(p.plong), gppt: n(p.p20), gptb: n(p.ptb), gpbl: n(p.pbl) });
      if (n(p.kr) || n(p.pr)) t.PGKP.push({ PGID, grka: n(p.kr), grky: n(p.kry), grkL: n(p.krl), grkt: n(p.krtd), grpa: n(p.pr), grpy: n(p.pry), grpL: n(p.prl), grpt: n(p.prtd) });
      if (OL(p) && (n(p.snaps) > 0 || n(p.sa) || n(p.pk))) t.PGOL.push({ PGID, gosa: n(p.sa), gopa: n(p.pk) });
      if (n(p.snaps) > 0 || ['pa', 'ra', 'rec', 'tk', 'sk', 'int', 'fga', 'xpa', 'pt', 'kr', 'pr', 'ko'].some((k) => n(p[k]))) t.PGNG.push({ PGID, ggmP: 1, ggmS: p.starter ? 1 : 0, ggdp: n(p.snaps) });
    }
  });
  (det.scoring ?? []).forEach((e, i) => t.SCOS.push({ SSOR: i + 1, GQTR: n(e.q), GTIM: n(e.clk), TGID: n(e.tgid), SSTY: n(e.type), SSPY: n(e.y), SSPT: n(e.pt), SSTI: n(e.ti), SSFI: n(e.fi), SSPI: n(e.pi), SSPF: n(e.pf), SSSC: n(e.sc), SSDE: n(e.de), SSDP: n(e.dp), SSDS: 0 }));
  if (opts.db) { const ct = coachTables(opts.db, env); t.CSGM = ct.CSGM; t.CACG = ct.CACG; t.CASG = ct.CASG; opts.coachXp = ct.xp ?? 0; }
  return t;
}

// ---- coach XP (CSGM / CACG / CASG) ------------------------------------------------------------------------------------
// At kickoff the console copies the six coaches' CSKL rows into CSGM and their goal progress CACP into CACG; goals that
// complete during the game add CASG {CCID, GOID, CTIE = tiers gained} and CEXP += CAPX.CAXP x tiers (exact for all four
// console-played games of efoxOD1: +830, +725, +430, +1130). The merged tables are written back after the game. Only the
// head coach earns in-game XP, so only his rows go out. Goals identified from those games (camc = the goal's counter):
// per-game thresholds (counter set for the game, +1 tier when reached), the TD goal (+1 tier per touchdown), the win goals,
// and season counters (counter += the game's value; their tiers are left to the console).
const GOALS_PER_GAME = [ // [GOID, counter(team stats, starter QB, players, points), threshold or null, counter capped at the threshold]
  [9764714, (s) => n(s.fd), 10, true], [2520713, (s) => n(s.t3c), 4, true], [7575895, (s) => n(s.ry), 100, true], [3760712, (s) => n(s.yds), 350, true], [16616478, (s) => n(s.py), 250, true],
  [12287251, (s) => (n(s.pa) >= 10 ? Math.round((100 * n(s.pc)) / n(s.pa)) : 0), 50, false], [7344421, (s, qb, ps, pts) => pts, 30, false], [12973307, (s, qb) => n(qb?.ptd), 4, false],
  [5524034, (s, qb, ps, pts) => pts, null], [1145467, (s) => n(s.sk), null], [8994726, (s) => n(s.py), null], [13966395, (s) => n(s.yds), null],
  [5703097, (s, qb) => n(qb?.py), null], [6463678, (s, qb, ps) => n(top(ps, 'rey')?.rey), null],
];
const GOALS_SEASON = [[3235631, (s) => n(s.ry)], [6108278, (s) => n(s.yds)], [13954122, (s) => n(s.py)], [12531902, (s, qb, ps, tds) => tds], [15141, (s, qb) => n(qb?.ptd)], [852174, (s, qb) => n(qb?.ptd)], [11124162, (s, qb) => n(qb?.py)], [15329580, (s, qb) => n(qb?.py)]];
const TD_GOAL = 2458418, WIN_GOALS = [14160977, 6845616];
export function coachTables(db, env) {
  const out = { CSGM: [], CACG: [], CASG: [] };
  const tgid = n(env.ownedTeamId); const coaches = dbRows(db, 'COCH').filter((r) => r.TGID === tgid);
  const hc = coaches.find((r) => r.CFUC === 1 && r.COPS === 0) ?? coaches.find((r) => r.COPS === 0); if (!hc) return out;
  const ccid = hc.CCID; const skill = dbRows(db, 'CSKL').find((r) => r.CCID === ccid); const prog = dbRows(db, 'CACP').filter((r) => r.CCID === ccid);
  if (!skill || !prog.length) return out;
  const xpOf = new Map(dbRows(db, 'CAPX').map((r) => [r.GOID, n(r.CAXP)]));
  const team = env.detail.teams.find((x) => n(x.tgid) === tgid); if (!team) return out;
  const s = team.stats ?? {}, ps = team.players ?? [], qb = top(ps, 'pa');
  const g = env.gameResult, mine = g.HTID === tgid ? n(g.HTSC) : n(g.ATSC), theirs = g.HTID === tgid ? n(g.ATSC) : n(g.HTSC);
  const tds = (env.detail.scoring ?? []).filter((e) => n(e.tgid) === tgid && n(e.type) !== 5).length;
  const byGoal = new Map(prog.map((r) => [r.GOID, { ...r }])); const gained = new Map();
  const tier = (goid, k = 1) => { const r = byGoal.get(goid); if (!r || k <= 0) return; r.CTIE = n(r.CTIE) + k; gained.set(goid, (gained.get(goid) ?? 0) + k); };
  for (const [goid, f, thr, cap] of GOALS_PER_GAME) { const r = byGoal.get(goid); if (!r) continue; const v = f(s, qb, ps, mine); r.CAMC = cap ? Math.min(v, thr) : v; if (thr && v >= thr) tier(goid); }
  for (const [goid, f] of GOALS_SEASON) { const r = byGoal.get(goid); if (r) r.CAMC = n(r.CAMC) + f(s, qb, ps, tds); }
  tier(TD_GOAL, tds);
  if (mine > theirs) for (const goid of WIN_GOALS) tier(goid);
  let xp = 0; for (const [goid, k] of gained) xp += (xpOf.get(goid) ?? 0) * k;
  const cexp = n(skill.CEXP) + xp; const level = Math.max(n(skill.CLVL), Math.floor(Math.sqrt(cexp / 160)));
  out.CSGM.push({ ...skill, CEXP: cexp, CLVL: level, CSKU: n(skill.CSKU) + (level - n(skill.CLVL)) });
  out.CACG = [...byGoal.values()].map((r) => ({ CCID: ccid, CTIE: n(r.CTIE), RPTB: n(r.RPTB), CAPY: n(r.CAPY), CAMC: n(r.CAMC), GOID: n(r.GOID) }));
  out.CASG = [...gained].map(([goid, k]) => ({ CCID: ccid, CTIE: k, GOID: goid }));
  out.xp = xp;
  return out;
}

// Rows for one GetTableUpdate of a game table (UWQS and WQSC name the same rows); values go out as the console sends them
// (it puts signed values such as SSSC in TINT columns too).
export function gameTableRows(data, table) {
  const key = table === 'WQSC' ? 'UWQS' : table;
  return (data?.tables?.[key] ?? []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n(v)])));
}
