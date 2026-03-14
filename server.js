require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const caches = {
  live:      new NodeCache({ stdTTL: 20 }),
  standings: new NodeCache({ stdTTL: 300 }),
  teams:     new NodeCache({ stdTTL: 86400 }),
  stats:     new NodeCache({ stdTTL: 60 }),  // 60s — keeps stats fresh
  search:    new NodeCache({ stdTTL: 604800 }),
};

async function getOrFetch(type, key, fetchFn) {
  const cache = caches[type];
  const cached = cache.get(key);
  if (cached !== undefined) return { data: cached, fromCache: true };
  const fresh = await fetchFn();
  cache.set(key, fresh);
  return { data: fresh, fromCache: false };
}

const espnClient = axios.create({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.espn.com",
    "Referer": "https://www.espn.com/",
  },
});

const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
const CORE = "https://site.api.espn.com/apis/v2/sports";
const SPORTS = {
  mlb: { sport:"baseball",   league:"mlb" },
  nfl: { sport:"football",   league:"nfl" },
  nba: { sport:"basketball", league:"nba" },
  nhl: { sport:"hockey",     league:"nhl" },
};

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
  const {sport:s,league:l} = SPORTS[sport];
  const {data} = await espnClient.get(`${ESPN}/${s}/${l}/scoreboard`);
  return { sport:sport.toUpperCase(), lastUpdated:new Date().toISOString(), games:(data.events||[]).map(fmtGame) };
}

async function getStandings(sport) {
  const {sport:s,league:l} = SPORTS[sport];
  const {data} = await espnClient.get(`${CORE}/${s}/${l}/standings`);
  return { sport:sport.toUpperCase(), lastUpdated:new Date().toISOString(),
    standings:(data.children||[data]).map(g=>({ division:g.name||"Standings",
      teams:(g.standings?.entries||[]).map(e=>{ const st={}; (e.stats||[]).forEach(x=>st[x.name]=x.displayValue||x.value); return {team:e.team?.displayName,abbreviation:e.team?.abbreviation,stats:st}; })
    }))
  };
}

async function getTeams(sport) {
  const {sport:s,league:l} = SPORTS[sport];
  const {data} = await espnClient.get(`${ESPN}/${s}/${l}/teams`);
  return { sport:sport.toUpperCase(), teams:(data.sports?.[0]?.leagues?.[0]?.teams||[]).map(t=>({ id:t.team.id, name:t.team.displayName, abbreviation:t.team.abbreviation, logo:t.team.logos?.[0]?.href||null })) };
}

// ── Robust athlete search — scans team rosters (most reliable method) ────
async function searchAthlete(sport, name) {
  const {sport:s, league:l} = SPORTS[sport];
  const nameLower = name.toLowerCase().replace(/[.']/g,"").trim();
  const nameParts = nameLower.split(/\s+/);

  // Strategy 1: ESPN autocomplete
  try {
    const {data} = await espnClient.get("https://ac.espn.com/v2/ac", {
      params: { query:name, types:"athletes", limit:5, lang:"en", section:"espn" }
    });
    const items = (data?.items || data?.athletes || []);
    for (const item of items) {
      const uid = (item.uid||item.id||"").toString();
      const match = uid.match(/a:(\d+)/);
      const id = match ? match[1] : uid.replace(/\D/g,"");
      if (id && id.length > 3 && id !== "1") {
        return { id, name:item.displayName||item.name||name, found:true, method:"autocomplete" };
      }
    }
  } catch(e) {}

  // Strategy 2: ESPN common search
  try {
    const {data} = await espnClient.get("https://site.api.espn.com/apis/common/v3/search", {
      params: { query:name, sport:s, league:l, limit:5, type:"athlete" }
    });
    const allItems = [
      ...(data?.results||[]).flatMap(r=>[...(r.contents||[]),...(r.athletes||[])]),
      ...(data?.athletes||[])
    ];
    for (const item of allItems) {
      const id = (item?.id||"").toString();
      if (id && id.length > 3 && id !== "1") {
        return { id, name:item.displayName||item.fullName||name, found:true, method:"common-search" };
      }
    }
  } catch(e) {}

  // Strategy 3: Full roster scan (most reliable — scans all 30 team rosters)
  try {
    const teamsData = await getTeams(sport);
    for (const team of teamsData.teams) {
      try {
        const {data} = await espnClient.get(`${ESPN}/${s}/${l}/teams/${team.id}/roster`);
        const allPlayers = (data.athletes||[]).flatMap(g=>(g.items||g.athletes||[g])).filter(p=>p?.id);
        const player = allPlayers.find(p => {
          const full = (p.fullName||p.displayName||"").toLowerCase().replace(/[.']/g,"").trim();
          const fullParts = full.split(/\s+/);
          // Match on last name + first initial, or full name
          return full === nameLower ||
            full.includes(nameLower) ||
            (nameParts.length >= 2 &&
              fullParts[fullParts.length-1] === nameParts[nameParts.length-1] &&
              fullParts[0][0] === nameParts[0][0]);
        });
        if (player?.id && player.id.toString() !== "1") {
          return { id:player.id.toString(), name:player.fullName||player.displayName||name, found:true, method:"roster-scan", team:team.abbreviation };
        }
      } catch(e) {}
    }
  } catch(e) {}

  return { found:false, query:name };
}

// ── Athlete stats ──────────────────────────────────────────────────────────
async function getAthleteStats(sport, athleteId) {
  const {sport:s,league:l} = SPORTS[sport];
  // seasontype=2 = regular season, no year = ESPN picks current active season
  const urls = [
    `${ESPN}/${s}/${l}/athletes/${athleteId}/statistics?seasontype=2`,
    `${ESPN}/${s}/${l}/athletes/${athleteId}/statistics`,
  ];

  let data = null;
  for (const url of urls) {
    try {
      const resp = await espnClient.get(url);
      data = resp.data;
      if (data && (data.statistics || data.athlete)) break; // got valid data
    } catch(e) {
      // 404 or ESPN error — try next URL
      continue;
    }
  }

  // If we couldn't get anything, return empty gracefully
  if (!data) {
    return { athleteId, stats: {}, rawGroups: [], error: "ESPN stats unavailable" };
  }

  const athlete = data.athlete || {};
  let flat = {};

  // Parse statistics array — prefer Regular Season group
  const statGroups = data.statistics || [];
  
  // First pass: look for explicit regular season group
  const regGroup = statGroups.find(g => /regular\s*season/i.test(g.name || ""));
  if (regGroup) {
    const names = regGroup.names || regGroup.labels || [];
    const stats = regGroup.stats || regGroup.values || [];
    names.forEach((n, i) => { if (n) flat[n] = parseFloat(stats[i]) || 0; });
  } else {
    // Second pass: use all non-playoff groups
    statGroups.forEach(group => {
      if (/(playoff|post)/i.test(group.name || "")) return;
      const names = group.names || group.labels || [];
      const stats = group.stats || group.values || [];
      names.forEach((n, i) => { if (n && flat[n] === undefined) flat[n] = parseFloat(stats[i]) || 0; });
    });
  }

  // Also try splitCategories format
  try {
    (data.splitCategories || []).forEach(cat => {
      (cat.splits || []).forEach(split => {
        if (/total|season|regular/i.test(split.abbreviation || split.displayName || "")) {
          const names = cat.names || cat.abbreviations || [];
          (split.stats || []).forEach((val, i) => {
            const n = names[i];
            if (n && flat[n] === undefined) flat[n] = parseFloat(val) || 0;
          });
        }
      });
    });
  } catch(e) {}

  return {
    athleteId,
    name: athlete.fullName || athlete.displayName || null,
    position: athlete.position?.abbreviation || null,
    team: athlete.team?.abbreviation || null,
    stats: flat,
    rawGroups: statGroups.map(g => ({
      name: g.name || "",
      names: (g.names || g.labels || []).slice(0, 30),
      stats: (g.stats || g.values || []).slice(0, 30)
    }))
  };
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get("/", (req,res) => res.json({ name:"T.U.S.L. API v3", sports:["mlb","nfl","nba","nhl"] }));
app.get("/health", (req,res) => res.json({ status:"ok", uptime:`${Math.floor(process.uptime())}s` }));

app.get("/api/dashboard", async (req,res) => {
  try {
    const results = await Promise.allSettled(["mlb","nfl","nba","nhl"].map(sport=>getOrFetch("live",`sb_${sport}`,()=>getScoreboard(sport))));
    const sports = {};
    ["mlb","nfl","nba","nhl"].forEach((sport,i) => {
      const r = results[i];
      if (r.status==="fulfilled") {
        const games = r.value.data.games||[];
        sports[sport] = { totalGames:games.length, liveGames:games.filter(g=>g.isLive).length,
          games:games.map(g=>({ id:g.id, shortName:g.shortName, status:g.status, isLive:g.isLive, score:g.competitors.map(c=>`${c.team} ${c.score}`).join(" - "), broadcast:g.broadcast })) };
      } else { sports[sport]={ error:r.reason?.message }; }
    });
    res.json({ lastUpdated:new Date().toISOString(), sports });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/sports/:sport/scoreboard", async (req,res) => {
  const {sport}=req.params;
  if (!SPORTS[sport]) return res.status(400).json({ error:"Invalid sport" });
  try {
    if (req.query.refresh==="true") caches.live.del(`sb_${sport}`);
    const {data,fromCache}=await getOrFetch("live",`sb_${sport}`,()=>getScoreboard(sport));
    res.json({...data,fromCache});
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/sports/:sport/standings", async (req,res) => {
  const {sport}=req.params;
  if (!SPORTS[sport]) return res.status(400).json({ error:"Invalid sport" });
  try {
    const {data,fromCache}=await getOrFetch("standings",`st_${sport}`,()=>getStandings(sport));
    res.json({...data,fromCache});
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/sports/:sport/teams", async (req,res) => {
  const {sport}=req.params;
  if (!SPORTS[sport]) return res.status(400).json({ error:"Invalid sport" });
  try {
    const {data,fromCache}=await getOrFetch("teams",`tm_${sport}`,()=>getTeams(sport));
    res.json({...data,fromCache});
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Search — cached 7 days, ESPN IDs are permanent
app.get("/api/sports/:sport/athletes/search", async (req,res) => {
  const {sport}=req.params;
  const {name}=req.query;
  if (!SPORTS[sport]) return res.status(400).json({ error:"Invalid sport" });
  if (!name) return res.status(400).json({ error:"?name= required" });
  try {
    const cacheKey=`search_${sport}_${name.toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"")}`;
    const {data}=await getOrFetch("search",cacheKey,()=>searchAthlete(sport,name));
    res.json(data);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Stats — NEVER returns 500, always returns usable JSON even if ESPN is down
app.get("/api/sports/:sport/athletes/:id/stats", async (req,res) => {
  const {sport,id}=req.params;
  const {season}=req.query;
  if (!SPORTS[sport]) return res.status(400).json({ error:"Invalid sport" });
  const empty = { athleteId:id, stats:{}, rawGroups:[], fromCache:false };
  try {
    const cacheKey=`stats_${sport}_${id}_${season||"cur"}`;
    const cached = caches.stats.get(cacheKey);
    if (cached !== undefined) return res.json({...cached, fromCache:true});
    let result = empty;
    try {
      result = await getAthleteStats(sport, id);
      if (result && Object.keys(result.stats||{}).length > 0) caches.stats.set(cacheKey, result);
    } catch(e) { console.error("Stats ESPN error "+sport+"/"+id+":", e.message); }
    res.json({...result, fromCache:false});
  } catch(err) {
    console.error("Stats route error:", err.message);
    res.json(empty);
  }
});

app.use((req,res)=>res.status(404).json({ error:"Not found" }));
app.listen(PORT,()=>console.log(`\n🏆 T.U.S.L. API v3 running on port ${PORT}\n`));
