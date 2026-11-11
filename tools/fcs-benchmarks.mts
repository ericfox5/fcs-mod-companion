// Real FCS per-team-per-game averages for the Supersim realism check, from the NCAA.com team tables the roster
// pipeline downloads (<Rosters>/2026/stats/team/*.csv, refreshed by tools/src/stats.ts there).
//   npx tsx tools/fcs-benchmarks.mts [stats dir]   -> tools/fcs-benchmarks.json
// Each stat: the mean over teams and the 10th / 90th percentile team (the range a simulated league average should sit in
// is far narrower than that, but a sim average outside it is certainly wrong).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] ?? 'C:/Users/efoxo/OneDrive/Desktop/FCS/Rosters/2026/stats';
function csv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean); const head = lines[0]!.split(',');
  return lines.slice(1).map((l) => { const cells: string[] = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { cells.push(cur); cur = ''; } else cur += ch; } cells.push(cur); return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ''])); });
}
const team = (name: string) => csv(join(DIR, 'team', `${name}.csv`));
const num = (v: string | undefined) => Number(v ?? 0) || 0;
const stat = (vals: number[]) => { const s = vals.filter(Number.isFinite).sort((a, b) => a - b); const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!; return { mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), lo: +at(0.1).toFixed(3), hi: +at(0.9).toFixed(3), teams: s.length }; };
const perGame = (rows: Record<string, string>[], col: string) => rows.map((r) => num(r[col]) / Math.max(1, num(r['games'])));

const total = team('total_offense'), rush = team('rushing_offense'), pass = team('passing_offense'), score = team('scoring_offense');
const sacks = team('team_sacks'), tfl = team('team_tackles_for_loss'), to = team('turnovers_lost'), pen = team('fewest_penalties_per_game'), penY = team('fewest_penalty_yards_per_game');
const third = team('3rd_down_conversion_pct'), fourth = team('4th_down_conversion_pct'), punt = team('net_punting'), fd = team('first_downs_offense'), rz = team('red_zone_offense');
const stats: Record<string, ReturnType<typeof stat>> = {
  points: stat(score.map((r) => num(r['ppg']))),
  plays: stat(perGame(total, 'plays')), yards: stat(total.map((r) => num(r['ypg']))), yards_per_play: stat(total.map((r) => num(r['yds_play']))),
  rush_att: stat(perGame(rush, 'rush')), rush_yds: stat(rush.map((r) => num(r['ypg']))), yards_per_carry: stat(rush.map((r) => num(r['yds_rush']))),
  pass_att: stat(perGame(pass, 'pass_att')), completion_pct: stat(pass.map((r) => 100 * num(r['pass_com']) / Math.max(1, num(r['pass_att'])))), pass_yds: stat(pass.map((r) => num(r['ypg']))), yards_per_att: stat(pass.map((r) => num(r['yds_att']))),
  sacks: stat(sacks.map((r) => num(r['avg']))), tfl: stat(tfl.map((r) => num(r['tflpg']))),
  interceptions: stat(perGame(to, 'int')), fumbles_lost: stat(perGame(to, 'fum_lost')), turnovers: stat(perGame(to, 'turn_lost')),
  penalties: stat(pen.map((r) => num(r['penpergame']))), penalty_yds: stat(penY.map((r) => num(r['ypg']))),
  first_downs: stat(perGame(fd, 'fd')), third_down_pct: stat(third.map((r) => 100 * num(r['pct']))), fourth_down_pct: stat(fourth.map((r) => 100 * num(r['pct']))),
  punts: stat(perGame(punt, 'punts')), punt_avg: stat(punt.map((r) => num(r['punt_yds']) / Math.max(1, num(r['punts'])))), punt_net: stat(punt.map((r) => num(r['net_yds']))),
  red_zone_score_pct: stat(rz.map((r) => 100 * num(r['pct']))),
};
// kickers: league field-goal percentage and attempts from the individual leaderboard (qualified kickers)
const fgPath = join(DIR, 'individual', 'field_goal_percentage.csv');
if (existsSync(fgPath)) { const k = csv(fgPath); stats['fg_pct'] = stat(k.map((r) => 100 * num(r['pct']))); stats['fg_att'] = stat(k.map((r) => num(r['fga']) / Math.max(1, num(r['games'])))); }
const index = csv(join(DIR, 'stats_index.csv'));
const out = { source: 'NCAA.com FCS team statistics', through_games: index.find((r) => r['category'] === 'total_offense')?.['through_games'] ?? '', built: new Date().toISOString().slice(0, 10), stats };
writeFileSync('tools/fcs-benchmarks.json', JSON.stringify(out, null, 1) + '\n');
console.log(`tools/fcs-benchmarks.json: ${Object.keys(stats).length} stats, through games ${out.through_games}`);
for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(20)} ${String(v.mean).padStart(8)}   ${v.lo} - ${v.hi}`);
