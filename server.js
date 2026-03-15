require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "tusl-secret-change-in-production";

app.use(cors());
// Ensure CORS headers are always present, even on errors
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  next();
});
app.use(express.json());

// ── Database ──────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        team_id INTEGER UNIQUE NOT NULL,
        team_name VARCHAR(100) NOT NULL,
        owner_name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        faab_balance INTEGER DEFAULT 400,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rosters (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL,
        sport VARCHAR(10) NOT NULL,
        player_name VARCHAR(100) NOT NULL,
        player_espn_id VARCHAR(20),
        position VARCHAR(10) NOT NULL,
        slot VARCHAR(20) NOT NULL DEFAULT 'active',
        auction_price INTEGER DEFAULT 0,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, sport, player_name)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL,
        type VARCHAR(20) NOT NULL,
        sport VARCHAR(10) NOT NULL,
        player_in VARCHAR(100),
        player_out VARCHAR(100),
        slot_change VARCHAR(50),
        faab_spent INTEGER DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS waiver_bids (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL,
        sport VARCHAR(10) NOT NULL,
        player_name VARCHAR(100) NOT NULL,
        bid_amount INTEGER NOT NULL,
        drop_player VARCHAR(100),
        status VARCHAR(20) DEFAULT 'pending',
        processed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stat_snapshots (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL,
        sport VARCHAR(10) NOT NULL,
        player_name VARCHAR(100) NOT NULL,
        player_espn_id VARCHAR(20),
        snapshot_stats JSONB NOT NULL DEFAULT '{}',
        acquired_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, sport, player_name)
      );
    `);
    console.log("✓ Database schema initialized");
  } catch(err) {
    console.error("DB init error:", err.message);
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────
const caches = {
  live:      new NodeCache({ stdTTL: 20 }),
  standings: new NodeCache({ stdTTL: 300 }),
  teams:     new NodeCache({ stdTTL: 86400 }),
  stats:     new NodeCache({ stdTTL: 60 }),
  search:    new NodeCache({ stdTTL: 604800 }),
  freeagents:new NodeCache({ stdTTL: 3600 }), // Cache FA lists for 1 hour
};

async function getOrFetch(type, key, fetchFn) {
  const cache = caches[type];
  const cached = cache.get(key);
  if (cached !== undefined) return { data: cached, fromCache: true };
  const fresh = await fetchFn();
  cache.set(key, fresh);
  return { data: fresh, fromCache: false };
}

// ── ESPN Client ───────────────────────────────────────────────────────────
const espnClient = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.espn.com",
    "Referer": "https://www.espn.com/",
  },
});

const ESPN    = "https://site.api.espn.com/apis/site/v2/sports";
const CORE    = "https://site.api.espn.com/apis/v2/sports";
const COREAPI = "https://sports.core.api.espn.com/v2/sports";

const SPORTS = {
  mlb: { sport:"baseball",   league:"mlb" },
  nfl: { sport:"football",   league:"nfl" },
  nba: { sport:"basketball", league:"nba" },
  nhl: { sport:"hockey",     league:"nhl" },
};

// ── Auth Middleware ───────────────────────────────────────────────────────
function authRequired(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Login required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── ESPN Helpers ──────────────────────────────────────────────────────────
function fmtGame(e) {
  const c = e.competitions?.[0], s = c?.status;
  return {
    id:e.id, shortName:e.shortName, date:e.date,
    status:{ state:s?.type?.state, detail:s?.type?.detail, clock:s?.displayClock, period:s?.period },
    competitors:(c?.competitors||[]).map(t=>({ team:t.team?.abbreviation, score:t.score||"0", homeAway:t.homeAway, record:t.records?.[0]?.summary||null })),
    venue:c?.venue?.fullName||null, broadcast:c?.broadcasts?.[0]?.names?.[0]||null,
    isLive:s?.type?.state==="in"
  };
}

async function getScoreboard(sport) {
  const {sport:s,league:l}=SPORTS[sport];
  const {data}=await espnClient.get(`${ESPN}/${s}/${l}/scoreboard`);
  return { sport:sport.toUpperCase(), lastUpdated:new Date().toISOString(), games:(data.events||[]).map(fmtGame) };
}

async function getStandings(sport) {
  const {sport:s,league:l}=SPORTS[sport];
  const {data}=await espnClient.get(`${CORE}/${s}/${l}/standings`);
  return { sport:sport.toUpperCase(), lastUpdated:new Date().toISOString(),
    standings:(data.children||[data]).map(g=>({ division:g.name||"Standings",
      teams:(g.standings?.entries||[]).map(e=>{ const st={}; (e.stats||[]).forEach(x=>st[x.name]=x.displayValue||x.value); return {team:e.team?.displayName,abbreviation:e.team?.abbreviation,stats:st}; })
    }))
  };
}

async function getTeams(sport) {
  const {sport:s,league:l}=SPORTS[sport];
  const {data}=await espnClient.get(`${ESPN}/${s}/${l}/teams`);
  return { sport:sport.toUpperCase(), teams:(data.sports?.[0]?.leagues?.[0]?.teams||[]).map(t=>({ id:t.team.id, name:t.team.displayName, abbreviation:t.team.abbreviation, logo:t.team.logos?.[0]?.href||null })) };
}

async function searchAthlete(sport, name) {
  const {sport:s,league:l}=SPORTS[sport];
  const nameLower=name.toLowerCase().replace(/[.']/g,"").trim();
  const nameParts=nameLower.split(/\s+/);
  try {
    const teamsData=await getTeams(sport);
    for(const team of teamsData.teams){
      try{
        const {data}=await espnClient.get(`${ESPN}/${s}/${l}/teams/${team.id}/roster`);
        const allPlayers=(data.athletes||[]).flatMap(g=>(g.items||g.athletes||[g])).filter(p=>p?.id);
        const player=allPlayers.find(p=>{
          const full=(p.fullName||p.displayName||"").toLowerCase().replace(/[.']/g,"").trim();
          const fullParts=full.split(/\s+/);
          return full===nameLower||full.includes(nameLower)||(nameParts.length>=2&&fullParts[fullParts.length-1]===nameParts[nameParts.length-1]&&fullParts[0][0]===nameParts[0][0]);
        });
        if(player?.id&&player.id.toString()!=="1") return{id:player.id.toString(),name:player.fullName||player.displayName||name,found:true,team:team.abbreviation,position:player.position?.abbreviation};
      } catch(e){}
    }
  } catch(e){}
  return{found:false,query:name};
}

async function getAthleteStats(sport, athleteId) {
  const {sport:s,league:l}=SPORTS[sport];
  const years=["2026","2025"];
  let data=null;
  for(const yr of years){
    try{
      const resp=await espnClient.get(`${COREAPI}/${s}/leagues/${l}/seasons/${yr}/types/2/athletes/${athleteId}/statistics`);
      if(resp.data&&resp.data.splits){data=resp.data;break;}
    }catch(e){continue;}
  }
  if(!data) return{athleteId,stats:{},error:"no data"};
  const flat={};
  (data.splits?.categories||[]).forEach(cat=>{
    (cat.stats||[]).forEach(stat=>{
      if(stat.name) flat[stat.name]=parseFloat(stat.value)||0;
      if(stat.abbreviation) flat[stat.abbreviation]=parseFloat(stat.value)||0;
    });
  });
  return{athleteId,name:data.athlete?.displayName||null,stats:flat};
}

// ── Free Agent Search ─────────────────────────────────────────────────────
// Fetches ALL team rosters in PARALLEL — fast!
async function getFreeAgents(sport, position) {
  const {sport:s,league:l}=SPORTS[sport];
  const teamsData = await getTeams(sport);
  const allPlayers = [];

  // Fire all team roster requests simultaneously instead of one-by-one
  const results = await Promise.allSettled(
    teamsData.teams.map(team =>
      espnClient.get(`${ESPN}/${s}/${l}/teams/${team.id}/roster`)
        .then(({ data }) => ({ team, data }))
    )
  );

  results.forEach(result => {
    if (result.status !== 'fulfilled') return;
    const { team, data } = result.value;
    const players = (data.athletes||[]).flatMap(g=>(g.items||g.athletes||[g])).filter(p=>p?.id);
    players.forEach(p => {
      const pos = p.position?.abbreviation || "";
      if (!position || pos === position || pos.includes(position)) {
        allPlayers.push({
          id: p.id,
          name: p.fullName || p.displayName,
          position: pos,
          team: team.abbreviation,
          teamName: team.name,
        });
      }
    });
  });

  return allPlayers;
}

// ── Auth Routes ───────────────────────────────────────────────────────────

app.post("/api/auth/register", async (req, res) => {
  const { teamId, teamName, ownerName, email, password } = req.body;
  if (!teamId || !email || !password || !ownerName) {
    return res.status(400).json({ error: "teamId, ownerName, email and password required" });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (team_id, team_name, owner_name, email, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, team_id, team_name, owner_name, email, faab_balance`,
      [teamId, teamName, ownerName, email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, teamId: user.team_id, teamName: user.team_name }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, teamId: user.team_id, teamName: user.team_name, ownerName: user.owner_name, email: user.email, faabBalance: user.faab_balance } });
  } catch(err) {
    if (err.code === "23505") return res.status(400).json({ error: "Email or team already registered" });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });
    const token = jwt.sign({ userId: user.id, teamId: user.team_id, teamName: user.team_name }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, teamId: user.team_id, teamName: user.team_name, ownerName: user.owner_name, email: user.email, faabBalance: user.faab_balance } });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auth/me", authRequired, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, team_id, team_name, owner_name, email, faab_balance FROM users WHERE id = $1", [req.user.userId]);
    res.json(result.rows[0] || {});
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Roster Routes ─────────────────────────────────────────────────────────

app.get("/api/roster/:teamId", authRequired, async (req, res) => {
  const { teamId } = req.params;
  if (parseInt(teamId) !== req.user.teamId) return res.status(403).json({ error: "Can only view your own roster" });
  try {
    const result = await pool.query(
      "SELECT * FROM rosters WHERE team_id = $1 ORDER BY sport, slot, added_at",
      [teamId]
    );
    res.json({ teamId: parseInt(teamId), roster: result.rows });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/roster/ir-move", authRequired, async (req, res) => {
  const { playerName, sport, direction } = req.body;
  if (!playerName || !sport || !direction) return res.status(400).json({ error: "playerName, sport, direction required" });
  try {
    const newSlot = direction === "to-ir" ? "ir" : "active";
    await pool.query(
      "UPDATE rosters SET slot = $1 WHERE team_id = $2 AND sport = $3 AND player_name = $4",
      [newSlot, req.user.teamId, sport, playerName]
    );
    await pool.query(
      "INSERT INTO transactions (team_id, type, sport, player_in, slot_change) VALUES ($1, $2, $3, $4, $5)",
      [req.user.teamId, "ir-move", sport, playerName, `${direction === "to-ir" ? "Active→IR" : "IR→Active"}`]
    );
    res.json({ success: true, player: playerName, slot: newSlot });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/roster/drop", authRequired, async (req, res) => {
  const { playerName, sport } = req.body;
  if (!playerName || !sport) return res.status(400).json({ error: "playerName and sport required" });
  try {
    await pool.query(
      "DELETE FROM rosters WHERE team_id = $1 AND sport = $2 AND player_name = $3",
      [req.user.teamId, sport, playerName]
    );
    await pool.query(
      "INSERT INTO transactions (team_id, type, sport, player_out) VALUES ($1, $2, $3, $4)",
      [req.user.teamId, "drop", sport, playerName]
    );
    res.json({ success: true, dropped: playerName });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Waiver / Free Agent Routes ─────────────────────────────────────────────

app.get("/api/freeagents/:sport", async (req, res) => {
  const { sport } = req.params;
  const { position, search } = req.query;
  if (!SPORTS[sport]) return res.status(400).json({ error: "Invalid sport" });
  try {
    // Check cache first (1 hour TTL)
    const cacheKey = `fa_${sport}_${position||'all'}`;
    const cached = caches.freeagents.get(cacheKey);
    if (cached && !search) {
      // Apply search filter on cached results if needed
      return res.json(cached);
    }

    const rostered = await pool.query("SELECT player_name FROM rosters WHERE sport = $1", [sport]);
    const rosteredNames = new Set(rostered.rows.map(r => r.player_name.toLowerCase()));

    const allPlayers = await getFreeAgents(sport, position);

    let freeAgents = allPlayers.filter(p => {
      const name = (p.name||"").toLowerCase();
      if (rosteredNames.has(name)) return false;
      if (search && !name.includes(search.toLowerCase())) return false;
      return true;
    });

    // Shuffle so results aren't always alphabetically team-biased
    for (let i = freeAgents.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [freeAgents[i], freeAgents[j]] = [freeAgents[j], freeAgents[i]];
    }

    const result = { sport, freeAgents: freeAgents.slice(0, 200), total: freeAgents.length };

    // Cache if no search filter applied
    if (!search) caches.freeagents.set(cacheKey, result);

    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/waivers/bid", authRequired, async (req, res) => {
  const { playerName, sport, bidAmount, dropPlayer } = req.body;
  if (!playerName || !sport || bidAmount === undefined) {
    return res.status(400).json({ error: "playerName, sport, bidAmount required" });
  }
  try {
    const userResult = await pool.query("SELECT faab_balance FROM users WHERE id = $1", [req.user.userId]);
    const balance = userResult.rows[0]?.faab_balance || 0;
    if (bidAmount > balance) return res.status(400).json({ error: `Insufficient FAAB. Balance: $${balance}` });
    if (bidAmount < 0) return res.status(400).json({ error: "Bid must be $0 or more" });

    await pool.query(
      `INSERT INTO waiver_bids (team_id, sport, player_name, bid_amount, drop_player)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [req.user.teamId, sport, playerName, bidAmount, dropPlayer || null]
    );
    res.json({ success: true, message: `$${bidAmount} bid placed on ${playerName}`, remainingBalance: balance });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Instant claim — add player immediately, optionally drop one, deduct FAAB
app.post("/api/waivers/claim", authRequired, async (req, res) => {
  const { playerName, sport, position, bidAmount, dropPlayer, espnId } = req.body;
  if (!playerName || !sport || bidAmount === undefined) {
    return res.status(400).json({ error: "playerName, sport, bidAmount required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check FAAB balance
    const userResult = await client.query("SELECT faab_balance FROM users WHERE id = $1 FOR UPDATE", [req.user.userId]);
    const balance = userResult.rows[0]?.faab_balance ?? 0;
    if (bidAmount > balance) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Insufficient FAAB. Balance: $${balance}` });
    }
    if (bidAmount < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Bid must be $0 or more" });
    }

    // Drop player if specified
    if (dropPlayer) {
      await client.query(
        "DELETE FROM rosters WHERE team_id = $1 AND sport = $2 AND player_name = $3",
        [req.user.teamId, sport, dropPlayer]
      );
      await client.query(
        "INSERT INTO transactions (team_id, type, sport, player_out, faab_spent) VALUES ($1, $2, $3, $4, $5)",
        [req.user.teamId, "drop", sport, dropPlayer, 0]
      );
    }

    // Add player to roster
    await client.query(
      `INSERT INTO rosters (team_id, sport, player_name, player_espn_id, position, slot, auction_price)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT (team_id, sport, player_name) DO UPDATE SET slot = 'active'`,
      [req.user.teamId, sport, playerName, espnId || null, position || 'UTIL', bidAmount]
    );

    // Capture stat snapshot at acquisition time (so only post-add stats count)
    let snapshotStats = {};
    if (espnId) {
      try {
        const statsResult = await getAthleteStats(sport, espnId);
        snapshotStats = statsResult.stats || {};
      } catch(e) { /* snapshot failure is non-fatal */ }
    }
    await client.query(
      `INSERT INTO stat_snapshots (team_id, sport, player_name, player_espn_id, snapshot_stats)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_id, sport, player_name) DO UPDATE SET snapshot_stats = $5, acquired_at = NOW()`,
      [req.user.teamId, sport, playerName, espnId || null, JSON.stringify(snapshotStats)]
    );

    // Deduct FAAB
    await client.query(
      "UPDATE users SET faab_balance = faab_balance - $1 WHERE id = $2",
      [bidAmount, req.user.userId]
    );

    // Log transaction
    await client.query(
      "INSERT INTO transactions (team_id, type, sport, player_in, player_out, faab_spent) VALUES ($1, $2, $3, $4, $5, $6)",
      [req.user.teamId, "claim", sport, playerName, dropPlayer || null, bidAmount]
    );

    // Mark any pending bid on this player as processed
    await client.query(
      "UPDATE waiver_bids SET status = 'processed', processed_at = NOW() WHERE team_id = $1 AND sport = $2 AND player_name = $3 AND status = 'pending'",
      [req.user.teamId, sport, playerName]
    );

    await client.query("COMMIT");

    const updatedUser = await pool.query("SELECT faab_balance FROM users WHERE id = $1", [req.user.userId]);
    res.json({
      success: true,
      message: `${playerName} added to your roster!`,
      newFaabBalance: updatedUser.rows[0].faab_balance
    });
  } catch(err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return res.status(400).json({ error: `${playerName} is already on your roster` });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Backfill snapshots for already-claimed players (one-time use per player)
app.post("/api/snapshots/backfill", authRequired, async (req, res) => {
  try {
    const roster = await pool.query(
      "SELECT player_name, player_espn_id, sport FROM rosters WHERE team_id = $1",
      [req.user.teamId]
    );
    const existing = await pool.query(
      "SELECT player_name, sport FROM stat_snapshots WHERE team_id = $1",
      [req.user.teamId]
    );
    const existingKeys = new Set(existing.rows.map(r => `${r.sport}_${r.player_name}`));
    const missing = roster.rows.filter(r => !existingKeys.has(`${r.sport}_${r.player_name}`));
    
    let filled = 0;
    for (const p of missing) {
      if (!p.player_espn_id) continue;
      try {
        const statsResult = await getAthleteStats(p.sport, p.player_espn_id);
        await pool.query(
          `INSERT INTO stat_snapshots (team_id, sport, player_name, player_espn_id, snapshot_stats)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [req.user.teamId, p.sport, p.player_name, p.player_espn_id, JSON.stringify(statsResult.stats || {})]
        );
        filled++;
      } catch(e) {}
    }
    res.json({ success: true, filled, message: `Backfilled ${filled} player snapshots` });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Get stat snapshots for a team (for post-acquisition stat calculation)
app.get("/api/snapshots/:teamId", authRequired, async (req, res) => {
  const { teamId } = req.params;
  if (parseInt(teamId) !== req.user.teamId) return res.status(403).json({ error: "Can only view your own snapshots" });
  try {
    const result = await pool.query(
      "SELECT sport, player_name, player_espn_id, snapshot_stats, acquired_at FROM stat_snapshots WHERE team_id = $1",
      [teamId]
    );
    // Return as a lookup map: { 'nhl_Lane Hutson': { stats: {...}, acquiredAt: '...' } }
    const snapshots = {};
    result.rows.forEach(row => {
      snapshots[`${row.sport}_${row.player_name}`] = {
        stats: row.snapshot_stats,
        espnId: row.player_espn_id,
        acquiredAt: row.acquired_at
      };
    });
    res.json({ snapshots });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/waivers/my-bids", authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM waiver_bids WHERE team_id = $1 AND status = 'pending' ORDER BY created_at DESC",
      [req.user.teamId]
    );
    res.json({ bids: result.rows });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/waivers/bid/:bidId", authRequired, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM waiver_bids WHERE id = $1 AND team_id = $2 AND status = 'pending'",
      [req.params.bidId, req.user.teamId]
    );
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/transactions/:teamId", authRequired, async (req, res) => {
  const { teamId } = req.params;
  if (parseInt(teamId) !== req.user.teamId) return res.status(403).json({ error: "Can only view your own transactions" });
  try {
    const result = await pool.query(
      "SELECT * FROM transactions WHERE team_id = $1 ORDER BY created_at DESC LIMIT 50",
      [teamId]
    );
    res.json({ transactions: result.rows });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Existing ESPN routes ───────────────────────────────────────────────────
app.get("/",(req,res)=>res.json({name:"T.U.S.L. API v5 — with Auth & DB",sports:["mlb","nfl","nba","nhl"]}));
app.get("/health",(req,res)=>res.json({status:"ok",uptime:`${Math.floor(process.uptime())}s`,db:"connected"}));

app.get("/api/dashboard",async(req,res)=>{
  try{
    const results=await Promise.allSettled(["mlb","nfl","nba","nhl"].map(sport=>getOrFetch("live",`sb_${sport}`,()=>getScoreboard(sport))));
    const sports={};
    ["mlb","nfl","nba","nhl"].forEach((sport,i)=>{
      const r=results[i];
      if(r.status==="fulfilled"){const games=r.value.data.games||[];sports[sport]={totalGames:games.length,liveGames:games.filter(g=>g.isLive).length,games:games.map(g=>({id:g.id,shortName:g.shortName,status:g.status,isLive:g.isLive,score:g.competitors.map(c=>`${c.team} ${c.score}`).join(" - "),broadcast:g.broadcast}))};}
      else{sports[sport]={error:r.reason?.message};}
    });
    res.json({lastUpdated:new Date().toISOString(),sports});
  }catch(err){res.status(500).json({error:err.message});}
});

app.get("/api/sports/:sport/scoreboard",async(req,res)=>{
  const{sport}=req.params;
  if(!SPORTS[sport]) return res.status(400).json({error:"Invalid sport"});
  try{if(req.query.refresh==="true")caches.live.del(`sb_${sport}`);const{data,fromCache}=await getOrFetch("live",`sb_${sport}`,()=>getScoreboard(sport));res.json({...data,fromCache});}
  catch(err){res.status(500).json({error:err.message});}
});

app.get("/api/sports/:sport/standings",async(req,res)=>{
  const{sport}=req.params;
  if(!SPORTS[sport]) return res.status(400).json({error:"Invalid sport"});
  try{const{data,fromCache}=await getOrFetch("standings",`st_${sport}`,()=>getStandings(sport));res.json({...data,fromCache});}
  catch(err){res.status(500).json({error:err.message});}
});

app.get("/api/sports/:sport/teams",async(req,res)=>{
  const{sport}=req.params;
  if(!SPORTS[sport]) return res.status(400).json({error:"Invalid sport"});
  try{const{data,fromCache}=await getOrFetch("teams",`tm_${sport}`,()=>getTeams(sport));res.json({...data,fromCache});}
  catch(err){res.status(500).json({error:err.message});}
});

app.get("/api/sports/:sport/athletes/search",async(req,res)=>{
  const{sport}=req.params;const{name}=req.query;
  if(!SPORTS[sport]) return res.status(400).json({error:"Invalid sport"});
  if(!name) return res.status(400).json({error:"?name= required"});
  try{const cacheKey=`search_${sport}_${name.toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"")}`;const{data}=await getOrFetch("search",cacheKey,()=>searchAthlete(sport,name));res.json(data);}
  catch(err){res.status(500).json({error:err.message});}
});

app.get("/api/sports/:sport/athletes/:id/stats",async(req,res)=>{
  const{sport,id}=req.params;
  if(!SPORTS[sport]) return res.status(400).json({error:"Invalid sport"});
  const empty={athleteId:id,stats:{},fromCache:false};
  try{
    const cacheKey=`stats_${sport}_${id}`;
    const cached=caches.stats.get(cacheKey);
    if(cached!==undefined) return res.json({...cached,fromCache:true});
    let result=empty;
    try{result=await getAthleteStats(sport,id);if(result&&Object.keys(result.stats||{}).length>0)caches.stats.set(cacheKey,result);}
    catch(e){console.error("stats error",sport,id,e.message);}
    res.json({...result,fromCache:false});
  }catch(err){console.error("stats route error",err.message);res.json(empty);}
});

app.get("/api/findplayer/:sport/:name",async(req,res)=>{
  const{sport,name}=req.params;
  if(!SPORTS[sport]) return res.status(400).json({error:"Invalid sport"});
  try{const result=await searchAthlete(sport,decodeURIComponent(name));res.json(result);}
  catch(err){res.json({error:err.message});}
});

app.get("/api/debug/:sport/:id",async(req,res)=>{
  const{sport,id}=req.params;
  if(!SPORTS[sport]) return res.status(400).json({error:"Invalid sport"});
  const{sport:s,league:l}=SPORTS[sport];
  const years=["2026","2025"];
  for(const yr of years){
    try{
      const url=`${COREAPI}/${s}/leagues/${l}/seasons/${yr}/types/2/athletes/${id}/statistics`;
      const{data}=await espnClient.get(url);
      if(data&&data.splits){
        const allStats={};
        (data.splits.categories||[]).forEach(cat=>{(cat.stats||[]).forEach(stat=>{allStats[stat.name]={abbr:stat.abbreviation,value:stat.value,cat:cat.name};});});
        return res.json({url,year:yr,totalStats:Object.keys(allStats).length,allStats});
      }
    }catch(e){continue;}
  }
  res.json({error:"both years failed",sport,id});
});

app.use((req,res)=>res.status(404).json({error:"Not found"}));

async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`\n🏆 T.U.S.L. API v5 running on port ${PORT}\n`));
}
start();
