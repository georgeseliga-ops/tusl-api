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
  live: new NodeCache({ stdTTL: 20 }),
  standings: new NodeCache({ stdTTL: 300 }),
  teams: new NodeCache({ stdTTL: 86400 }),
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
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": "https://www.espn.com",
    "Referer": "https://www.espn.com/",
  },
});
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
const CORE = "https://site.api.espn.com/apis/v2/sports";
const SPORTS = { mlb:{sport:"baseball",league:"mlb"}, nfl:{sport:"football",league:"nfl"}, nba:{sport:"basketball",league:"nba"}, nhl:{sport:"hockey",league:"nhl"} };
function fmtGame(e) {
  const c = e.competitions?.[0], s = c?.status;
  return {
    id: e.id, shortName: e.shortName, date: e.date,
    status: { state: s?.type?.state, detail: s?.type?.detail, clock: s?.displayClock, period: s?.period },
    competitors: (c?.competitors||[]).map(t=>({ team:t.team?.abbreviation, score:t.score||"0", homeAway:t.homeAway, record:t.records?.[0]?.summary||null })),
    venue: c?.venue?.fullName||null, broadcast: c?.broadcasts?.[0]?.names?.[0]||null,
    isLive: s?.type?.state==="in"
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
app.get("/", (req,res) => res.json({ name:"T.U.S.L. API", sports:["mlb","nfl","nba","nhl"] }));
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
      } else { sports[sport] = { error:r.reason?.message }; }
    });
    res.json({ lastUpdated:new Date().toISOString(), sports });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get("/api/sports/:sport/scoreboard", async (req,res) => {
  const {sport} = req.params;
  if (!SPORTS[sport]) return res.status(400).json({ error:`Invalid sport. Use: mlb, nfl, nba, nhl` });
  try {
    if (req.query.refresh==="true") caches.live.del(`sb_${sport}`);
    const {data,fromCache} = await getOrFetch("live",`sb_${sport}`,()=>getScoreboard(sport));
    res.json({...data,fromCache});
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get("/api/sports/:sport/standings", async (req,res) => {
  const {sport} = req.params;
  if (!SPORTS[sport]) return res.status(400).json({ error:`Invalid sport` });
  try {
    const {data,fromCache} = await getOrFetch("standings",`st_${sport}`,()=>getStandings(sport));
    res.json({...data,fromCache});
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get("/api/sports/:sport/teams", async (req,res) => {
  const {sport} = req.params;
  if (!SPORTS[sport]) return res.status(400).json({ error:`Invalid sport` });
  try {
    const {data,fromCache} = await getOrFetch("teams",`tm_${sport}`,()=>getTeams(sport));
    res.json({...data,fromCache});
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.use((req,res) => res.status(404).json({ error:"Not found" }));
app.listen(PORT, () => console.log(`T.U.S.L. API running on port ${PORT}`));
