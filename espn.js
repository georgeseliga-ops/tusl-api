// utils/espn.js
// ESPN unofficial API helper for T.U.S.L.
// Covers all four T.U.S.L. sports: MLB, NFL, NBA, NHL

const axios = require("axios");

// ESPN requires browser-like headers to avoid 403s
const ESPN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.espn.com",
  "Referer": "https://www.espn.com/",
};

const espnClient = axios.create({ headers: ESPN_HEADERS });

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const ESPN_CORE = "https://site.api.espn.com/apis/v2/sports";
const ESPN_FANTASY = "https://fantasy.espn.com/apis/v3/games";

// Maps T.U.S.L. sport slugs to ESPN sport/league paths
const SPORT_MAP = {
  mlb: { sport: "baseball", league: "mlb" },
  nfl: { sport: "football", league: "nfl" },
  nba: { sport: "basketball", league: "nba" },
  nhl: { sport: "hockey", league: "nhl" },
};

// Standard roto stat categories per sport — used for filtering player stat responses
const ROTO_STATS = {
  mlb: {
    hitting: ["avg", "homeRuns", "rbi", "runs", "stolenBases", "obp", "ops"],
    pitching: ["wins", "era", "strikeouts", "saves", "whip", "holds"],
  },
  nfl: {
    passing: ["passingYards", "touchdowns", "interceptions", "completions"],
    rushing: ["rushingYards", "rushingTouchdowns", "carries"],
    receiving: ["receivingYards", "receivingTouchdowns", "receptions", "targets"],
    defense: ["sacks", "interceptions", "forcedFumbles", "tackles"],
    kicking: ["fieldGoalsMade", "extraPointsMade", "fieldGoalPct"],
  },
  nba: ["points", "assists", "rebounds", "steals", "blocks", "threePointersMade", "turnovers", "fgPct", "ftPct"],
  nhl: ["goals", "assists", "points", "plusMinus", "powerPlayPoints", "shots", "wins", "goalsAgainstAverage", "savePercentage"],
};

/**
 * Validate that a sport slug is supported by T.U.S.L.
 */
function validateSport(sport) {
  if (!SPORT_MAP[sport]) {
    throw new Error(`Invalid sport "${sport}". Supported sports: ${Object.keys(SPORT_MAP).join(", ")}`);
  }
  return SPORT_MAP[sport];
}

/**
 * Fetch the live/today's scoreboard for a given sport
 */
async function getScoreboard(sport) {
  const { sport: espnSport, league } = validateSport(sport);
  const url = `${ESPN_BASE}/${espnSport}/${league}/scoreboard`;
  const { data } = await espnClient.get(url);

  return {
    sport: sport.toUpperCase(),
    season: data.season,
    lastUpdated: new Date().toISOString(),
    games: (data.events || []).map(formatGame),
  };
}

/**
 * Fetch current standings for a sport
 */
async function getStandings(sport) {
  const { sport: espnSport, league } = validateSport(sport);
  const url = `${ESPN_CORE}/${espnSport}/${league}/standings`;
  const { data } = await espnClient.get(url);

  const groups = data.children || data.standings?.entries ? [data] : (data.children || []);

  return {
    sport: sport.toUpperCase(),
    lastUpdated: new Date().toISOString(),
    standings: groups.map((group) => ({
      division: group.name || "Standings",
      teams: (group.standings?.entries || []).map(formatStanding),
    })),
  };
}

/**
 * Fetch a team's roster with basic stats
 */
async function getRoster(sport, teamId) {
  const { sport: espnSport, league } = validateSport(sport);
  const url = `${ESPN_BASE}/${espnSport}/${league}/teams/${teamId}/roster`;
  const { data } = await espnClient.get(url);

  return {
    sport: sport.toUpperCase(),
    teamId,
    athletes: (data.athletes || []).flatMap((group) =>
      (group.items || []).map((p) => ({
        id: p.id,
        name: p.fullName,
        position: p.position?.abbreviation,
        jersey: p.jersey,
        status: p.status?.type,
      }))
    ),
  };
}

/**
 * Fetch an athlete's current season stats
 */
async function getPlayerStats(sport, athleteId) {
  const { sport: espnSport, league } = validateSport(sport);
  const url = `${ESPN_BASE}/${espnSport}/${league}/athletes/${athleteId}/statistics`;
  const { data } = await espnClient.get(url);

  return {
    sport: sport.toUpperCase(),
    athleteId,
    athlete: data.athlete ? {
      id: data.athlete.id,
      name: data.athlete.fullName,
      position: data.athlete.position?.abbreviation,
      team: data.athlete.team?.abbreviation,
    } : null,
    rotoCategories: ROTO_STATS[sport],
    statistics: (data.statistics || []).map((statGroup) => ({
      name: statGroup.name,
      stats: formatStatNames(statGroup.names, statGroup.stats),
    })),
  };
}

/**
 * Fetch all teams for a sport (useful for building team dropdowns in T.U.S.L.)
 */
async function getTeams(sport) {
  const { sport: espnSport, league } = validateSport(sport);
  const url = `${ESPN_BASE}/${espnSport}/${league}/teams`;
  const { data } = await espnClient.get(url);

  return {
    sport: sport.toUpperCase(),
    teams: (data.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => ({
      id: t.team.id,
      name: t.team.displayName,
      abbreviation: t.team.abbreviation,
      location: t.team.location,
      logo: t.team.logos?.[0]?.href || null,
      color: t.team.color ? `#${t.team.color}` : null,
    })),
  };
}

/**
 * Fetch a single game's box score / play-by-play
 */
async function getGameDetail(sport, gameId) {
  const { sport: espnSport, league } = validateSport(sport);
  const url = `${ESPN_BASE}/${espnSport}/${league}/summary?event=${gameId}`;
  const { data } = await espnClient.get(url);

  return {
    sport: sport.toUpperCase(),
    gameId,
    status: data.header?.competitions?.[0]?.status?.type?.description,
    competitors: (data.header?.competitions?.[0]?.competitors || []).map((c) => ({
      team: c.team?.abbreviation,
      score: c.score,
      record: c.record?.[0]?.summary,
    })),
    leaders: (data.leaders || []).map((cat) => ({
      category: cat.name,
      leaders: (cat.leaders || []).slice(0, 3).map((l) => ({
        athlete: l.athlete?.displayName,
        team: l.team?.abbreviation,
        value: l.value,
        stat: l.displayValue,
      })),
    })),
    boxScore: data.boxScore || null,
  };
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatGame(event) {
  const comp = event.competitions?.[0];
  const status = comp?.status;
  const competitors = (comp?.competitors || []).map((c) => ({
    team: c.team?.abbreviation,
    fullName: c.team?.displayName,
    score: c.score || "0",
    homeAway: c.homeAway,
    record: c.records?.[0]?.summary || null,
    logo: c.team?.logo || null,
  }));

  return {
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    date: event.date,
    status: {
      state: status?.type?.state, // "pre", "in", "post"
      detail: status?.type?.detail || status?.type?.shortDetail,
      clock: status?.displayClock || null,
      period: status?.period || null,
    },
    competitors,
    venue: comp?.venue?.fullName || null,
    broadcast: comp?.broadcasts?.[0]?.names?.[0] || null,
    isLive: status?.type?.state === "in",
  };
}

function formatStanding(entry) {
  const stats = {};
  (entry.stats || []).forEach((s) => {
    stats[s.name] = s.displayValue || s.value;
  });
  return {
    team: entry.team?.displayName,
    abbreviation: entry.team?.abbreviation,
    logo: entry.team?.logos?.[0]?.href || null,
    stats,
  };
}

function formatStatNames(names = [], stats = []) {
  const result = {};
  names.forEach((name, i) => {
    result[name] = stats[i];
  });
  return result;
}

module.exports = {
  getScoreboard,
  getStandings,
  getRoster,
  getPlayerStats,
  getTeams,
  getGameDetail,
  SPORT_MAP,
  ROTO_STATS,
};
