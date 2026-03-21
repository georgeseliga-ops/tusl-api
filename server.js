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

      CREATE TABLE IF NOT EXISTS team_state (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL,
        sport VARCHAR(10) NOT NULL,
        dropped_players JSONB DEFAULT '[]',
        ir_slots JSONB DEFAULT '[null, null]',
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, sport)
      );

      CREATE TABLE IF NOT EXISTS draft_sessions (
        id SERIAL PRIMARY KEY,
        sport VARCHAR(10) NOT NULL,
        status VARCHAR(20) DEFAULT 'waiting',
        commissioner_team_id INTEGER,
        nomination_order JSONB DEFAULT '[]',
        current_nominator_idx INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS draft_nominations (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        nominating_team_id INTEGER NOT NULL,
        player_name VARCHAR(100) NOT NULL,
        player_espn_id VARCHAR(20),
        position VARCHAR(10),
        min_bid INTEGER DEFAULT 1,
        status VARCHAR(20) DEFAULT 'active',
        winning_team_id INTEGER,
        winning_bid INTEGER,
        bid_ends_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS draft_bids (
        id SERIAL PRIMARY KEY,
        nomination_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        team_id INTEGER NOT NULL,
        bid_amount INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS draft_results (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        sport VARCHAR(10) NOT NULL,
        team_id INTEGER NOT NULL,
        player_name VARCHAR(100) NOT NULL,
        player_espn_id VARCHAR(20),
        position VARCHAR(10),
        winning_bid INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
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
    req.isCommissioner = req.user.teamId === 9;
    next();
  } catch(e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Commissioner middleware — only team 9 can use these routes
function commissionerRequired(req, res, next) {
  if (!req.user || req.user.teamId !== 9) return res.status(403).json({ error: "Commissioner access required" });
  next();
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
        if(player?.id&&player.id.toString()!=="1") {
          const headshot = player.headshot?.href || player.headshot || null;
          return{id:player.id.toString(),name:player.fullName||player.displayName||name,found:true,team:team.abbreviation,position:player.position?.abbreviation,headshot};
        }
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

// ── Roster Lock ──────────────────────────────────────────────────────────────
// Returns team abbreviations that currently have a game in progress (locked)
app.get("/api/locked-teams/:sport", async (req, res) => {
  const { sport } = req.params;
  if (!SPORTS[sport]) return res.status(400).json({ error: "Invalid sport" });
  const cacheKey = `locked_${sport}`;
  const cached = caches.live.get(cacheKey);
  if (cached !== undefined) return res.json({ locked: cached });
  try {
    const { sport: s, league: l } = SPORTS[sport];
    const { data } = await espnClient.get(`${ESPN}/${s}/${l}/scoreboard`);
    const locked = new Set();
    (data.events || []).forEach(ev => {
      const status = ev.competitions?.[0]?.status?.type;
      if (status?.inProgress || status?.state === 'in') {
        (ev.competitions?.[0]?.competitors || []).forEach(c => {
          if (c.team?.abbreviation) locked.add(c.team.abbreviation.toUpperCase());
        });
      }
    });
    const lockedArr = [...locked];
    caches.live.set(cacheKey, lockedArr, 60); // 60 second TTL
    res.json({ locked: lockedArr, sport, time: new Date().toISOString() });
  } catch(err) {
    res.json({ locked: [], error: err.message });
  }
});

// Helper: check if player's team is locked
async function getLockedTeams(sport) {
  const cacheKey = `locked_${sport}`;
  const cached = caches.live.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const { sport: s, league: l } = SPORTS[sport];
    const { data } = await espnClient.get(`${ESPN}/${s}/${l}/scoreboard`);
    const locked = [];
    (data.events || []).forEach(ev => {
      const status = ev.competitions?.[0]?.status?.type;
      if (status?.inProgress || status?.state === 'in') {
        (ev.competitions?.[0]?.competitors || []).forEach(c => {
          if (c.team?.abbreviation) locked.push(c.team.abbreviation.toUpperCase());
        });
      }
    });
    caches.live.set(cacheKey, locked, 60);
    return locked;
  } catch(e) { return []; }
}

// Helper: get a player's real team abbreviation from DB roster or ESPN search
async function getPlayerTeamAbbrev(sport, playerName) {
  try {
    const result = await searchAthlete(sport, playerName);
    return result.team?.toUpperCase() || null;
  } catch(e) { return null; }
}

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
  const { playerName, sport, onBehalfOf } = req.body;
  if (!playerName || !sport) return res.status(400).json({ error: "playerName and sport required" });
  const targetTeamId = (req.isCommissioner && onBehalfOf) ? parseInt(onBehalfOf) : req.user.teamId;
  try {
    // Check if player's game is in progress (locked) — commissioners can bypass
    if (!req.isCommissioner) {
      const lockedTeams = await getLockedTeams(sport);
      if (lockedTeams.length > 0) {
        const playerTeam = await getPlayerTeamAbbrev(sport, playerName);
        if (playerTeam && lockedTeams.includes(playerTeam)) {
          return res.status(423).json({
            error: `🔒 ${playerName} is locked — their game is currently in progress. Drops open again tomorrow.`,
            locked: true
          });
        }
      }
    }
    await pool.query(
      "DELETE FROM rosters WHERE team_id = $1 AND sport = $2 AND player_name = $3",
      [targetTeamId, sport, playerName]
    );
    await pool.query(
      "INSERT INTO transactions (team_id, type, sport, player_out, notes) VALUES ($1, $2, $3, $4, $5)",
      [targetTeamId, "drop", sport, playerName, req.isCommissioner && onBehalfOf ? 'Commissioner action' : null]
    );
    caches.freeagents.del(`fa_${sport}_all`);
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
// ── Commissioner Routes ──────────────────────────────────────────────────────

// Add player to any team (commissioner only — used for draft results entry)
app.post("/api/commissioner/roster/add", authRequired, commissionerRequired, async (req, res) => {
  const { teamId, playerName, sport, position, price } = req.body;
  if (!teamId || !playerName || !sport || !position) {
    return res.status(400).json({ error: "teamId, playerName, sport, position required" });
  }
  try {
    await pool.query(
      `INSERT INTO rosters (team_id, sport, player_name, position, slot, auction_price)
       VALUES ($1, $2, $3, $4, 'active', $5)
       ON CONFLICT (team_id, sport, player_name) DO UPDATE SET position=$4, auction_price=$5`,
      [teamId, sport, playerName, position, price || 0]
    );
    await pool.query(
      `INSERT INTO transactions (team_id, type, sport, player_in, faab_spent, notes)
       VALUES ($1, 'draft', $2, $3, $4, 'Commissioner draft entry')`,
      [teamId, sport, playerName, price || 0]
    );
    // Update user FAAB balance
    if (price > 0) {
      await pool.query(
        `UPDATE users SET faab_balance = faab_balance - $1 WHERE team_id = $2`,
        [price, teamId]
      );
    }
    caches.freeagents.del(`fa_${sport}_all`);
    res.json({ success: true, added: playerName, teamId, price });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove player from any team (commissioner only)
app.post("/api/commissioner/roster/remove", authRequired, commissionerRequired, async (req, res) => {
  const { teamId, playerName, sport } = req.body;
  if (!teamId || !playerName || !sport) return res.status(400).json({ error: "teamId, playerName, sport required" });
  try {
    await pool.query(
      "DELETE FROM rosters WHERE team_id=$1 AND sport=$2 AND player_name=$3",
      [teamId, sport, playerName]
    );
    caches.freeagents.del(`fa_${sport}_all`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Set FAAB balance for any team (commissioner only)
app.post("/api/commissioner/faab", authRequired, commissionerRequired, async (req, res) => {
  const { teamId, balance } = req.body;
  if (!teamId || balance === undefined) return res.status(400).json({ error: "teamId and balance required" });
  try {
    await pool.query("UPDATE users SET faab_balance=$1 WHERE team_id=$2", [balance, teamId]);
    res.json({ success: true, teamId, balance });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/waivers/claim", authRequired, async (req, res) => {
  const { playerName, sport, position, bidAmount, dropPlayer, espnId } = req.body;
  if (!playerName || !sport || bidAmount === undefined) {
    return res.status(400).json({ error: "playerName, sport, bidAmount required" });
  }

  // Check roster locks before starting transaction
  const lockedTeams = await getLockedTeams(sport);
  if (lockedTeams.length > 0) {
    // Check player being added
    const addTeam = await getPlayerTeamAbbrev(sport, playerName);
    if (addTeam && lockedTeams.includes(addTeam)) {
      return res.status(423).json({
        error: `🔒 ${playerName} is locked — their game is in progress. Claims open again tomorrow.`,
        locked: true
      });
    }
    // Check player being dropped
    if (dropPlayer) {
      const dropTeam = await getPlayerTeamAbbrev(sport, dropPlayer);
      if (dropTeam && lockedTeams.includes(dropTeam)) {
        return res.status(423).json({
          error: `🔒 ${dropPlayer} is locked — their game is in progress. Drops open again tomorrow.`,
          locked: true
        });
      }
    }
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

    // Bust FA cache for this sport so the claimed player disappears immediately
    caches.freeagents.del(`fa_${sport}_all`);
    ['IF','OF','SP','RP','QB','RB','WR','TE','G','F','C','D','FORWARD'].forEach(pos => {
        caches.freeagents.del(`fa_${sport}_${pos}`);
    });

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
// Team state (drops + IR) — persisted to DB for cross-device sync
app.get("/api/team-state/:teamId", authRequired, async (req, res) => {
  const { teamId } = req.params;
  if (parseInt(teamId) !== req.user.teamId) return res.status(403).json({ error: "Forbidden" });
  try {
    const result = await pool.query(
      "SELECT sport, dropped_players, ir_slots FROM team_state WHERE team_id = $1",
      [teamId]
    );
    const state = {};
    result.rows.forEach(r => {
      state[r.sport] = {
        dropped: r.dropped_players || [],
        irSlots: r.ir_slots || [null, null]
      };
    });
    res.json({ state });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/team-state/:teamId", authRequired, async (req, res) => {
  const { teamId } = req.params;
  if (parseInt(teamId) !== req.user.teamId) return res.status(403).json({ error: "Forbidden" });
  const { sport, dropped, irSlots } = req.body;
  if (!sport) return res.status(400).json({ error: "sport required" });
  try {
    await pool.query(
      `INSERT INTO team_state (team_id, sport, dropped_players, ir_slots, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (team_id, sport) DO UPDATE
       SET dropped_players = $3, ir_slots = $4, updated_at = NOW()`,
      [teamId, sport, JSON.stringify(dropped || []), JSON.stringify(irSlots || [null, null])]
    );
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

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

// League-wide transactions — public, all teams
app.get("/api/transactions", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, u.team_name, u.owner_name
      FROM transactions t
      LEFT JOIN users u ON t.team_id = u.team_id
      ORDER BY t.created_at DESC
      LIMIT 200
    `);
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

// Upcoming games by team abbreviation for a sport
app.get("/api/sports/:sport/upcoming", async (req, res) => {
  const { sport } = req.params;
  if (!SPORTS[sport]) return res.status(400).json({ error: "Invalid sport" });
  const cacheKey = `upcoming_${sport}`;
  const cached = caches.live.get(cacheKey);
  if (cached) return res.json({ games: cached, fromCache: true });
  try {
    const { sport: s, league: l } = SPORTS[sport];
    const fmt = d => d.toISOString().slice(0,10).replace(/-/g,'');
    const teamGames = {};

    // Fetch today + next 7 days one at a time until we have all 30 teams covered
    for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
      if (Object.keys(teamGames).length >= 60) break; // all teams covered (2 per game)
      const day = new Date();
      day.setDate(day.getDate() + daysAhead);
      const url = `${ESPN}/${s}/${l}/scoreboard?dates=${fmt(day)}&limit=50`;
      try {
        const { data } = await espnClient.get(url);
        const events = data.events || [];
        events.forEach(ev => {
          const comps = ev.competitions?.[0];
          if (!comps) return;
          const competitors = comps.competitors || [];
          competitors.forEach(team => {
            const abbrev = team.team?.abbreviation?.toUpperCase();
            if (!abbrev || teamGames[abbrev]) return;
            const opp = competitors.find(c => c.team?.abbreviation !== team.team?.abbreviation);
            const status = comps.status?.type;
            teamGames[abbrev] = {
              opponent: opp?.team?.abbreviation || '?',
              homeAway: team.homeAway === 'home' ? 'vs' : '@',
              date: ev.date,
              inProgress: status?.inProgress || status?.state === 'in' || false
            };
          });
        });
      } catch(e) { continue; }
    }

    caches.live.set(cacheKey, teamGames);
    res.json({ games: teamGames, fromCache: false });
  } catch(err) {
    res.json({ games: {}, error: err.message });
  }
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

// Game log — last N games for a player
app.get("/api/sports/:sport/athletes/:id/gamelog", async (req, res) => {
  const { sport, id } = req.params;
  const limit = parseInt(req.query.limit) || 7;
  if (!SPORTS[sport]) return res.status(400).json({ error: "Invalid sport" });
  const { sport: s, league: l } = SPORTS[sport];

  const cacheKey = `gamelog_${sport}_${id}`;
  const cached = caches.stats.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  // ESPN gamelog stats[] column order by sport (confirmed from API)
  const STAT_COLUMNS = {
    nhl: ['G','A','PTS','+/-','PIM','SOG','SH%','PPG','SHG','GWG','OT','FOW%','TOI','ATOI'],
    nba: ['MIN','FGM','FGA','FG%','3PM','3PA','3P%','FTM','FTA','FT%','OREB','DREB','REB','AST','STL','BLK','TO','PF','PTS'],
    mlb: ['AB','R','H','2B','3B','HR','RBI','BB','HBP','SO','SB','CS','AVG','OBP','SLG','OPS'],
    nfl: ['CMP','ATT','YDS','AVG','TD','INT','SACK','RTG','CAR','RYDS','RAVG','RTD','REC','REYDS','REAVG','RETD','FUM']
  };

  try {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/${s}/${l}/athletes/${id}/gamelog`;
    const { data } = await espnClient.get(url);
    const seasonTypes = data.seasonTypes || [];
    const evMeta = data.events || {};
    const cols = STAT_COLUMNS[sport] || [];

    const allEvents = {};

    seasonTypes.forEach(st => {
      (st.categories || []).forEach(cat => {
        (cat.events || []).forEach(ev => {
          const eid = String(ev.eventId || ev.id || '');
          if (!eid) return;
          if (!allEvents[eid]) allEvents[eid] = { eventId: eid, stats: {} };
          // Map stats array to column names
          (ev.stats || []).forEach((val, i) => {
            if (cols[i] && val !== null && val !== undefined) {
              allEvents[eid].stats[cols[i]] = val;
            }
          });
        });
      });
    });

    // Enrich with event metadata
    Object.values(allEvents).forEach(ev => {
      const meta = evMeta[ev.eventId] || {};
      ev.date = meta.gameDate || '';
      ev.opponent = meta.opponent?.abbreviation || '—';
      ev.homeAway = meta.atVs === 'at' ? 'away' : 'home';
      ev.result = meta.gameResult || meta.score || '';
    });

    const sorted = Object.values(allEvents)
      .filter(ev => ev.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-limit)
      .reverse();

    const result = { games: sorted, columns: cols };
    if (sorted.length > 0) caches.stats.set(cacheKey, result);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error('[Gamelog] error:', err.message);
    res.json({ games: [], error: err.message });
  }
});

// Raw ESPN gamelog passthrough — shows exact structure for debugging
// Headshot proxy — serves ESPN player images through our server to avoid CORS
app.get("/api/headshot/:sport/:id", async (req, res) => {
  const { sport, id } = req.params;
  const sportMap = { mlb:'baseball', nfl:'football', nba:'basketball', nhl:'hockey' };
  const espnSport = sportMap[sport] || sport;
  const https = require('https');
  const url = `https://a.espncdn.com/i/headshots/${espnSport}/players/full/${id}.png`;
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.espn.com/' } }, (imgRes) => {
    if (imgRes.statusCode === 301 || imgRes.statusCode === 302) {
      // Follow redirect
      https.get(imgRes.headers.location, (r2) => {
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        r2.pipe(res);
      }).on('error', () => res.status(404).end());
      return;
    }
    if (imgRes.statusCode !== 200) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    imgRes.pipe(res);
  }).on('error', (e) => {
    console.error('[Headshot]', e.message);
    res.status(500).end();
  });
});

app.get("/api/debug/gamelog/:sport/:id", async (req, res) => {
  const { sport, id } = req.params;
  const { sport: s, league: l } = SPORTS[sport] || {};
  if (!s) return res.status(400).json({ error: 'Invalid sport' });
  try {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/${s}/${l}/athletes/${id}/gamelog`;
    const { data } = await espnClient.get(url);
    const st = data.seasonTypes || [];
    const cat0 = st[0]?.categories?.[0] || {};
    const evKeys = Object.keys(data.events || {});
    res.json({
      seasonTypeCount: st.length,
      seasonType0Name: st[0]?.name,
      cat0Keys: Object.keys(cat0),
      cat0Name: cat0.name,
      cat0Labels: cat0.labels,
      cat0Names: cat0.names,
      cat0Types: cat0.types,
      cat0EventCount: cat0.events?.length,
      cat0Event0: cat0.events?.[0],
      eventsCount: evKeys.length,
      firstEventKey: evKeys[0],
      firstEventValue: data.events?.[evKeys[0]],
      allCategoryNames: st.flatMap(s => (s.categories||[]).map(c => c.name))
    });
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/api/debug/:sport/:id", async (req, res) => {
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

// ── Draft Routes ──────────────────────────────────────────────────────────

const DRAFT_ROSTER_SLOTS = {
  mlb: ['Infielder 1','Infielder 2','Outfielder 1','Outfielder 2','UTIL','Pitcher 1','Pitcher 2','Relief Pitcher'],
  nfl: ['QB','RB 1','RB 2','WR 1','WR 2','TE']
};

// Get or create draft session for a sport
app.get("/api/draft/:sport/session", async (req, res) => {
  const { sport } = req.params;
  try {
    let result = await pool.query(
      "SELECT * FROM draft_sessions WHERE sport = $1 AND status != 'completed' ORDER BY created_at DESC LIMIT 1",
      [sport]
    );
    if (result.rows.length === 0) {
      // Create new session
      const order = [1,2,3,4,5,6,7,8,9,10]; // team IDs 1-10
      result = await pool.query(
        "INSERT INTO draft_sessions (sport, status, nomination_order, commissioner_team_id) VALUES ($1, 'waiting', $2, 9) RETURNING *",
        [sport, JSON.stringify(order)]
      );
    }
    const session = result.rows[0];
    // Get current nomination if active
    let nomination = null;
    if (session.status === 'active') {
      const nomResult = await pool.query(
        "SELECT n.*, u.team_name as nominator_name FROM draft_nominations n JOIN users u ON u.team_id = n.nominating_team_id WHERE n.session_id = $1 AND n.status = 'active' ORDER BY n.created_at DESC LIMIT 1",
        [session.id]
      );
      if (nomResult.rows.length > 0) {
        nomination = nomResult.rows[0];
        // Get all bids for this nomination
        const bidsResult = await pool.query(
          "SELECT b.*, u.team_name FROM draft_bids b JOIN users u ON u.team_id = b.team_id WHERE b.nomination_id = $1 ORDER BY b.bid_amount DESC",
          [nomination.id]
        );
        nomination.bids = bidsResult.rows;
        nomination.top_bid = bidsResult.rows[0] || null;
      }
    }
    // Get draft results so far
    const results = await pool.query(
      "SELECT dr.*, u.team_name FROM draft_results dr JOIN users u ON u.team_id = dr.team_id WHERE dr.session_id = $1 ORDER BY dr.created_at DESC",
      [session.id]
    );
    // Get team budgets spent in this draft
    const budgets = await pool.query(
      "SELECT team_id, SUM(winning_bid) as spent FROM draft_results WHERE session_id = $1 GROUP BY team_id",
      [session.id]
    );
    const budgetMap = {};
    budgets.rows.forEach(b => { budgetMap[b.team_id] = parseInt(b.spent) || 0; });

    // Check if current nomination timer expired — auto-close it
    if (nomination && nomination.bid_ends_at && new Date(nomination.bid_ends_at) < new Date()) {
      nomination.sport = sport;
      await closNomination(session.id, nomination, pool);
      nomination = null;
      const order = typeof session.nomination_order === 'string' ? JSON.parse(session.nomination_order) : session.nomination_order;
      const nextIdx = (session.current_nominator_idx + 1) % order.length;
      await pool.query("UPDATE draft_sessions SET current_nominator_idx = $1 WHERE id = $2", [nextIdx, session.id]);
    }

    res.json({
      session: { ...session, nomination_order: typeof session.nomination_order === 'string' ? JSON.parse(session.nomination_order) : session.nomination_order },
      nomination,
      results: results.rows,
      budgetMap,
      serverTime: new Date().toISOString()
    });
  } catch(err) {
    console.error('[Draft] Session error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Close a nomination and record winner
async function closNomination(sessionId, nomination, poolClient) {
  const client = poolClient || pool;
  const topBid = nomination.top_bid || nomination.bids?.[0];
  if (!topBid) {
    // No bids — mark as no_bid
    await client.query("UPDATE draft_nominations SET status = 'no_bid' WHERE id = $1", [nomination.id]);
    return;
  }
  // Record result
  await client.query(
    "INSERT INTO draft_results (session_id, sport, team_id, player_name, player_espn_id, position, winning_bid) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
    [sessionId, nomination.sport || 'mlb', topBid.team_id, nomination.player_name, nomination.player_espn_id, nomination.position, topBid.bid_amount]
  );
  // Mark nomination closed
  await client.query(
    "UPDATE draft_nominations SET status = 'closed', winning_team_id = $1, winning_bid = $2 WHERE id = $3",
    [topBid.team_id, topBid.bid_amount, nomination.id]
  );
  // Add to rosters table
  await client.query(
    `INSERT INTO rosters (team_id, sport, player_name, player_espn_id, position, slot, auction_price)
     VALUES ($1, $2, $3, $4, $5, 'active', $6) ON CONFLICT (team_id, sport, player_name) DO NOTHING`,
    [topBid.team_id, nomination.sport || 'mlb', nomination.player_name, nomination.player_espn_id, nomination.position || 'UTIL', topBid.bid_amount]
  );
}

// Start draft session (commissioner only)
app.post("/api/draft/:sport/start", authRequired, async (req, res) => {
  const { sport } = req.params;
  try {
    const result = await pool.query(
      "UPDATE draft_sessions SET status = 'active', commissioner_team_id = $1, started_at = NOW() WHERE sport = $2 AND status = 'waiting' RETURNING *",
      [req.user.teamId, sport]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'No waiting session found' });
    res.json({ success: true, session: result.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Pause/resume draft
app.post("/api/draft/:sport/pause", authRequired, async (req, res) => {
  const { sport } = req.params;
  const { action } = req.body; // 'pause' | 'resume'
  try {
    const newStatus = action === 'pause' ? 'paused' : 'active';
    await pool.query(
      "UPDATE draft_sessions SET status = $1 WHERE sport = $2 AND status != 'completed'",
      [newStatus, sport]
    );
    res.json({ success: true, status: newStatus });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Nominate a player
app.post("/api/draft/:sport/nominate", authRequired, async (req, res) => {
  const { sport } = req.params;
  const { playerName, espnId, position, minBid } = req.body;
  if (!playerName) return res.status(400).json({ error: 'playerName required' });
  try {
    const session = await pool.query(
      "SELECT * FROM draft_sessions WHERE sport = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1", [sport]
    );
    if (session.rows.length === 0) return res.status(400).json({ error: 'No active draft session' });
    const s = session.rows[0];
    const order = typeof s.nomination_order === "string" ? JSON.parse(s.nomination_order) : s.nomination_order;
    const currentNominator = order[s.current_nominator_idx];
    if (currentNominator !== req.user.teamId) {
      return res.status(403).json({ error: `It's not your turn to nominate` });
    }
    // Check no active nomination already
    const existing = await pool.query(
      "SELECT id FROM draft_nominations WHERE session_id = $1 AND status = 'active'", [s.id]
    );
    if (existing.rows.length > 0) return res.status(400).json({ error: 'A player is already up for bid' });

    // Check player not already drafted
    const alreadyDrafted = await pool.query(
      "SELECT id FROM draft_results WHERE session_id = $1 AND player_name ILIKE $2", [s.id, playerName]
    );
    if (alreadyDrafted.rows.length > 0) return res.status(400).json({ error: `${playerName} was already drafted` });

    const bidEndsAt = new Date(Date.now() + 30000); // 30 second timer
    const nom = await pool.query(
      "INSERT INTO draft_nominations (session_id, nominating_team_id, player_name, player_espn_id, position, min_bid, bid_ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [s.id, req.user.teamId, playerName, espnId || null, position || 'UTIL', minBid || 1, bidEndsAt]
    );
    // Auto-place min bid from nominator
    await pool.query(
      "INSERT INTO draft_bids (nomination_id, session_id, team_id, bid_amount) VALUES ($1,$2,$3,$4)",
      [nom.rows[0].id, s.id, req.user.teamId, minBid || 1]
    );
    res.json({ success: true, nomination: nom.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Place a bid
app.post("/api/draft/:sport/bid", authRequired, async (req, res) => {
  const { sport } = req.params;
  const { nominationId, bidAmount } = req.body;
  if (!nominationId || bidAmount === undefined) return res.status(400).json({ error: 'nominationId and bidAmount required' });
  try {
    const session = await pool.query(
      "SELECT * FROM draft_sessions WHERE sport = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1", [sport]
    );
    if (session.rows.length === 0) return res.status(400).json({ error: 'No active draft session' });
    const s = session.rows[0];

    const nom = await pool.query("SELECT * FROM draft_nominations WHERE id = $1 AND status = 'active'", [nominationId]);
    if (nom.rows.length === 0) return res.status(400).json({ error: 'Nomination not found or already closed' });
    const nomination = nom.rows[0];
    if (new Date(nomination.bid_ends_at) < new Date()) return res.status(400).json({ error: 'Bidding has ended' });

    // Get current top bid
    const topBid = await pool.query(
      "SELECT MAX(bid_amount) as max_bid FROM draft_bids WHERE nomination_id = $1", [nominationId]
    );
    const currentMax = parseInt(topBid.rows[0].max_bid) || 0;
    if (bidAmount <= currentMax) return res.status(400).json({ error: `Bid must be higher than current bid of $${currentMax}` });

    // Check team budget
    const spent = await pool.query(
      "SELECT COALESCE(SUM(winning_bid),0) as spent FROM draft_results WHERE session_id = $1 AND team_id = $2",
      [s.id, req.user.teamId]
    );
    const totalSpent = parseInt(spent.rows[0].spent) || 0;
    if (totalSpent + bidAmount > 400) return res.status(400).json({ error: `Bid would exceed $400 budget (spent: $${totalSpent})` });

    // Extend timer by 10s if bid in last 10s
    const timeLeft = new Date(nomination.bid_ends_at) - new Date();
    if (timeLeft < 10000) {
      await pool.query("UPDATE draft_nominations SET bid_ends_at = NOW() + INTERVAL '10 seconds' WHERE id = $1", [nominationId]);
    }

    await pool.query(
      "INSERT INTO draft_bids (nomination_id, session_id, team_id, bid_amount) VALUES ($1,$2,$3,$4)",
      [nominationId, s.id, req.user.teamId, bidAmount]
    );
    res.json({ success: true, bid: bidAmount });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Close current nomination manually (commissioner or timer expired)
app.post("/api/draft/:sport/close-nomination", authRequired, async (req, res) => {
  const { sport } = req.params;
  try {
    const session = await pool.query(
      "SELECT * FROM draft_sessions WHERE sport = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1", [sport]
    );
    if (session.rows.length === 0) return res.status(400).json({ error: 'No active session' });
    const s = session.rows[0];

    const nomResult = await pool.query(
      "SELECT n.*, $2 as sport FROM draft_nominations n WHERE n.session_id = $1 AND n.status = 'active' ORDER BY n.created_at DESC LIMIT 1",
      [s.id, sport]
    );
    if (nomResult.rows.length === 0) return res.status(400).json({ error: 'No active nomination' });
    const nomination = nomResult.rows[0];
    const bidsResult = await pool.query(
      "SELECT * FROM draft_bids WHERE nomination_id = $1 ORDER BY bid_amount DESC LIMIT 1", [nomination.id]
    );
    nomination.bids = bidsResult.rows;
    nomination.top_bid = bidsResult.rows[0] || null;
    nomination.sport = sport;

    await closNomination(s.id, nomination, pool);

    // Advance nominator
    const order = typeof s.nomination_order === "string" ? JSON.parse(s.nomination_order) : s.nomination_order;
    const nextIdx = (s.current_nominator_idx + 1) % order.length;
    await pool.query("UPDATE draft_sessions SET current_nominator_idx = $1 WHERE id = $2", [nextIdx, s.id]);

    res.json({ success: true, winner: nomination.top_bid });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Reset draft session
app.post("/api/draft/:sport/reset", authRequired, async (req, res) => {
  const { sport } = req.params;
  try {
    const session = await pool.query(
      "SELECT id FROM draft_sessions WHERE sport = $1 ORDER BY created_at DESC LIMIT 1", [sport]
    );
    if (session.rows.length > 0) {
      const sid = session.rows[0].id;
      await pool.query("DELETE FROM draft_bids WHERE session_id = $1", [sid]);
      await pool.query("DELETE FROM draft_nominations WHERE session_id = $1", [sid]);
      await pool.query("DELETE FROM draft_results WHERE session_id = $1", [sid]);
      await pool.query("DELETE FROM draft_sessions WHERE id = $1", [sid]);
    }
    // Create fresh session
    const order = [1,2,3,4,5,6,7,8,9,10];
    await pool.query(
      "INSERT INTO draft_sessions (sport, status, nomination_order) VALUES ($1, 'waiting', $2)",
      [sport, JSON.stringify(order)]
    );
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.use((req,res)=>res.status(404).json({error:"Not found"}));

async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`\n🏆 T.U.S.L. API v5 running on port ${PORT}\n`));
}
start();
