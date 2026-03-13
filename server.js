
// server.js
// T.U.S.L. Live Sports Data API
// The Ultimate Sports League — MLB | NFL | NBA | NHL

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { getCacheStats } = require("./utils/cache");

const sportsRoutes = require("./routes/sports");
const dashboardRoutes = require("./routes/dashboard");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Request logger
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.originalUrl}`);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/sports", sportsRoutes);
app.use("/api/dashboard", dashboardRoutes);

// ─── Root ─────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    name: "T.U.S.L. Live Sports API",
    description: "The Ultimate Sports League — Multi-sport data for MLB, NFL, NBA, NHL",
    version: "1.0.0",
    endpoints: {
      dashboard: {
        "GET /api/dashboard": "Live snapshot of all 4 sports today",
        "GET /api/dashboard/standings": "All 4 leagues' standings",
      },
      sports: {
        "GET /api/sports": "List all supported sports + roto categories",
        "GET /api/sports/:sport/scoreboard": "Today's scores (sport: mlb | nfl | nba | nhl)",
        "GET /api/sports/:sport/standings": "Current standings",
        "GET /api/sports/:sport/teams": "All teams (id, name, abbreviation, logo)",
        "GET /api/sports/:sport/teams/:teamId/roster": "Team roster",
        "GET /api/sports/:sport/athletes/:athleteId/stats": "Player season stats",
        "GET /api/sports/:sport/games/:gameId": "Box score + leaders for a game",
      },
      utility: {
        "GET /health": "API health check + cache stats",
      },
    },
    queryParams: {
      "?refresh=true": "Force bypass cache on scoreboard endpoints",
    },
    tusLeagues: ["MLB", "NFL", "NBA", "NHL"],
  });
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: new Date().toISOString(),
    cache: getCacheStats(),
  });
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    hint: "Visit GET / for the full endpoint list",
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏆 T.U.S.L. API running on http://localhost:${PORT}`);
  console.log(`   MLB | NFL | NBA | NHL\n`);
});
