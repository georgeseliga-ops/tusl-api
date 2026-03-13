// routes/dashboard.js
// T.U.S.L. master dashboard endpoint
// Returns a unified snapshot of all four sports in one call
// Perfect for a "today in T.U.S.L." homepage widget

const express = require("express");
const router = express.Router();
const espn = require("../utils/espn");
const { getOrFetch } = require("../utils/cache");

const TUSL_SPORTS = ["mlb", "nfl", "nba", "nhl"];

// ─── GET /api/dashboard ───────────────────────────────────────────────────────
// Multi-sport snapshot: today's live games across all four T.U.S.L. leagues
router.get("/", async (req, res) => {
  try {
    const results = await Promise.allSettled(
      TUSL_SPORTS.map((sport) =>
        getOrFetch("live", `scoreboard_${sport}`, () => espn.getScoreboard(sport))
      )
    );

    const snapshot = {};
    let liveGameCount = 0;

    TUSL_SPORTS.forEach((sport, i) => {
      const result = results[i];
      if (result.status === "fulfilled") {
        const { data } = result.value;
        const liveGames = data.games.filter((g) => g.isLive);
        liveGameCount += liveGames.length;

        snapshot[sport] = {
          totalGames: data.games.length,
          liveGames: liveGames.length,
          games: data.games.map((g) => ({
            id: g.id,
            shortName: g.shortName,
            status: g.status,
            isLive: g.isLive,
            score: g.competitors.map((c) => `${c.team} ${c.score}`).join(" - "),
            broadcast: g.broadcast,
          })),
        };
      } else {
        snapshot[sport] = { error: result.reason?.message || "Failed to fetch" };
      }
    });

    res.json({
      title: "T.U.S.L. Live Dashboard",
      lastUpdated: new Date().toISOString(),
      totalLiveGames: liveGameCount,
      sports: snapshot,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/dashboard/standings ────────────────────────────────────────────
// All four leagues' standings in one call
router.get("/standings", async (req, res) => {
  try {
    const results = await Promise.allSettled(
      TUSL_SPORTS.map((sport) =>
        getOrFetch("standings", `standings_${sport}`, () => espn.getStandings(sport))
      )
    );

    const allStandings = {};
    TUSL_SPORTS.forEach((sport, i) => {
      const result = results[i];
      allStandings[sport] =
        result.status === "fulfilled"
          ? result.value.data
          : { error: result.reason?.message };
    });

    res.json({
      title: "T.U.S.L. All Standings",
      lastUpdated: new Date().toISOString(),
      standings: allStandings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
