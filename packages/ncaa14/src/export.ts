import type { TdbFile } from '@ncaa/tdb';
import { decodeSeason, decodeCalendar, decodeConferences, decodeDivisions, type SeasonInfo, type CalendarWeek, type Conference, type Division } from './decode/league.js';
import { decodeTeams, type Team } from './decode/teams.js';
import { decodeSchedule, isPlayed, type Game } from './decode/schedule.js';
import { decodePlayers, type Player } from './decode/players.js';
import { decodeCoaches, type Coach } from './decode/coaches.js';
import { decodeStories, type Story } from './decode/stories.js';
import { decodeHeisman, decodeAllAmericans, type HeismanCandidate, type AllAmerican } from './decode/awards.js';
import { decodeTeamSeasonStats, decodeTeamHistory, decodePlayerSeasonStats, decodeGameLogs, type Row } from './decode/stats.js';
import { decodeDepthChart, type DepthChartEntry } from './decode/depth.js';
import { decodeRecruits, decodeRecruitInterest, decodeRecruitingBoard, type Recruit, type RecruitInterest, type BoardEntry } from './decode/recruiting.js';

export interface DynastyExport {
  format: 1;
  exportedAt: string;
  tables: { name: string; records: number; max: number; allocType: number }[];
  season: SeasonInfo;
  calendar: CalendarWeek[];
  conferences: Conference[];
  divisions: Division[];
  teams: Team[];
  schedule: Game[];
  players: Player[];
  coaches: Coach[];
  depthChart: DepthChartEntry[];
  stories: Story[];
  heisman: HeismanCandidate[];
  allAmericans: AllAmerican[];
  teamSeasonStats: Row[];
  teamHistory: Row[];
  playerSeasonStats: Record<string, Row[]>;
  gameLogs: Record<string, Row[]>;
  recruits: Recruit[];
  recruitInterest: RecruitInterest[];
  recruitingBoard: BoardEntry[];
}

// Conference records: played games between two teams of the same conference (the TEAM table has no such field).
function applyConferenceRecords(teams: Team[], games: Game[]): void {
  const byId = new Map(teams.map((t) => [t.tgid, t]));
  for (const g of games) {
    if (!isPlayed(g.status)) continue;
    const h = byId.get(g.homeTgid), a = byId.get(g.awayTgid);
    if (!h || !a || h.cgid !== a.cgid) continue;
    const homeWon = g.status === 3;
    (homeWon ? h : a).confWins++;
    (homeWon ? a : h).confLosses++;
  }
}

export function exportDynasty(file: TdbFile): DynastyExport {
  const teams = decodeTeams(file);
  const schedule = decodeSchedule(file);
  applyConferenceRecords(teams, schedule);
  return {
    format: 1,
    exportedAt: new Date().toISOString(),
    tables: file.tables.map((t) => ({ name: t.name, records: t.recordCount, max: t.header.maxRecords, allocType: t.header.allocType })),
    season: decodeSeason(file),
    calendar: decodeCalendar(file),
    conferences: decodeConferences(file),
    divisions: decodeDivisions(file),
    teams,
    schedule,
    players: decodePlayers(file),
    coaches: decodeCoaches(file),
    depthChart: decodeDepthChart(file),
    stories: decodeStories(file),
    heisman: decodeHeisman(file),
    allAmericans: decodeAllAmericans(file),
    teamSeasonStats: decodeTeamSeasonStats(file),
    teamHistory: decodeTeamHistory(file),
    playerSeasonStats: decodePlayerSeasonStats(file),
    gameLogs: decodeGameLogs(file),
    recruits: decodeRecruits(file),
    recruitInterest: decodeRecruitInterest(file),
    recruitingBoard: decodeRecruitingBoard(file),
  };
}
