// routes/sports.js
// All T.U.S.L. sport data routes

const express = require("express");
const router = express.Router();
const espn = require("../utils/espn");
const { getOrFetch, invalidate } = require("../utils/cache");

// ─── GET /api/sports ─────────────────────────────────────────────────────────
// List all supported T.U.S.L. sports with their ESPN mappings
router.get("/", (req, res) => {
  res.json({
    sports: Object.entries(espn.SPORT_MAP).map(([slug, map]) => ({
      slug,
      espnSport: map.sport,
      espnLeague: map.league,
      rotoCategories: espn.ROTO_STATS[slug],
    })),
  });
});

// ─── GET /api/sports/:sport/scoreboard ───────────────────────────────────────
// Live/today's scoreboard for a sport
// ?refresh=true to force bypass cache
router.get("/:sport/scoreboard", async (req, res) => {
  const { sport } = req.params;
  const { refresh } = req.query;

  try {
    if (refresh === "true") invalidate("live", `scoreboard_${sport}`);

    const { data, fromCache } = await getOrFetch(
      "live",
      `scoreboard_${sport}`,
      () => espn.getScoreboard(sport)
    );

    res.json({ ...data, fromCache });
  } catch (err) {
    res.status(err.message.includes("Invalid sport") ? 400 : 500).json({
      error: err.message,
    });
  }
});

// ─── GET /api/sports/:sport/standings ────────────────────────────────────────
// Current season standings
router.get("/:sport/standings", async (req, res) => {
  const { sport } = req.params;

  try {
    const { data, fromCache } = await getOrFetch(
      "standings",
      `standings_${sport}`,
      () => espn.getStandings(sport)
    );

    res.json({ ...data, fromCache });
  } catch (err) {
    res.status(err.message.includes("Invalid sport") ? 400 : 500).json({
      error: err.message,
    });
  }
});

// ─── GET /api/sports/:sport/teams ─────────────────────────────────────────────
// All teams for a sport (id, name, abbreviation, logo, color)
router.get("/:sport/teams", async (req, res) => {
  const { sport } = req.params;

  try {
    const { data, fromCache } = await getOrFetch(
      "teams",
      `teams_${sport}`,
      () => espn.getTeams(sport)
    );

    res.json({ ...data, fromCache });
  } catch (err) {
    res.status(err.message.includes("Invalid sport") ? 400 : 500).json({
      error: err.message,
    });
  }
});

// ─── GET /api/sports/:sport/teams/:teamId/roster ──────────────────────────────
// Team roster with player IDs (use those IDs to fetch individual stats)
router.get("/:sport/teams/:teamId/roster", async (req, res) => {
  const { sport, teamId } = req.params;

  try {
    const { data, fromCache } = await getOrFetch(
      "roster",
      `roster_${sport}_${teamId}`,
      () => espn.getRoster(sport, teamId)
    );

    res.json({ ...data, fromCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sports/:sport/athletes/:athleteId/stats ─────────────────────────
// Player's current season stats — filtered to T.U.S.L. roto categories
router.get("/:sport/athletes/:athleteId/stats", async (req, res) => {
  const { sport, athleteId } = req.params;

  try {
    const { data, fromCache } = await getOrFetch(
      "stats",
      `stats_${sport}_${athleteId}`,
      () => espn.getPlayerStats(sport, athleteId)
    );

    res.json({ ...data, fromCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sports/:sport/games/:gameId ────────────────────────────────────
// Box score + leaders for a specific game (get gameId from scoreboard)
router.get("/:sport/games/:gameId", async (req, res) => {
  const { sport, gameId } = req.params;

  try {
    const { data, fromCache } = await getOrFetch(
      "game",
      `game_${sport}_${gameId}`,
      () => espn.getGameDetail(sport, gameId)
    );

    res.json({ ...data, fromCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
