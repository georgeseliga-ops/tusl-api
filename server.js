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
  live:     new NodeCache({ stdTTL: 20 }),
  standings:new NodeCache({ stdTTL: 300 }),
  teams:    new NodeCache({ stdTTL: 86400 }),
  stats:    new NodeCache({ stdTTL: 60 }),
  search:   new NodeCache({ stdTTL: 604800 }),
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

const ESPN    = "https://site.api.espn.com/apis/site/v2/sports";
const CORE    = "https://site.api.espn.com/apis/v2/sports";
const COREAPI = "https://sports.core.api.espn.com/v2/sports";

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
    const {data}=await espnClient.get("https://ac.espn.com/v2/ac",{params:{query:name,types:"athletes",limit:5,lang:"en",section:"espn"}});
    for(const item of(data?.items||data?.athletes||[])){
      const uid=(item.uid||item.id||"").toString();
      const match=uid.match(/a:(\d+)/);
      const id=match?match[1]:uid.replace(/\D/g,"");
      if(id&&id.length>3&&id!=="1") return{id,name:item.displayName||item.name||name,found:true,method:"autocomplete"};
    }
  } catch(e){}
  try {
    const {data}=await espnClient.get("https://site.api.espn.com/apis/common/v3/search",{params:{query:name,sport:s,league:l,limit:5,type:"athlete"}});
    const allItems=[...(data?.results||[]).flatMap(r=>[...(r.contents||[]),...(r.athletes||[])]),...(data?.athletes||[])];
    for(const item of allItems){
      const id=(item?.id||"").toString();
      if(id&&id.length>3&&id!=="1") return{id,name:item.displayName||item.fullName||name,found:true,method:"common-search"};
    }
  } catch(e){}
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
        if(player?.id&&player.id.toString()!=="1") return{id:player.id.toString(),name:player.fullName||player.displayName||name,found:true,method:"roster-scan",team:team.abbreviation};
      } catch(e){}
    }
  } catch(e){}
  return{found:false,query:name};
}

async function getAthleteStats(sport, athleteId) {
  const {sport:s,league:l}=SPORTS[sport];

  // Use team roster stats which always has current season data
  // First get the player's current team, then pull from team stats
  // Primary: core API with season filter
  // For NBA/NHL current season = 2025, seasontype=2 (regular season)
  const currentYear = "2025";
  
  const urlsToTry=[
    // Current season regular season stats
    `${COREAPI}/${s}/leagues/${l}/athletes/${athleteId}/statistics/0?season=${currentYear}&seasontype=2`,
    `${COREAPI}/${s}/leagues/${l}/athletes/${athleteId}/statistics?season=${currentYear}&seasontype=2`,
    // Site API current season
    `${ESPN}/${s}/${l}/athletes/${athleteId}/statistics?season=${currentYear}&seasontype=2`,
    `${ESPN}/${s}/${l}/athletes/${athleteId}/statistics?seasontype=2`,
    // Fallback no params
    `${COREAPI}/${s}/leagues/${l}/athletes/${athleteId}/statistics/0`,
    `${ESPN}/${s}/${l}/athletes/${athleteId}/statistics`,
  ];

  let data=null, usedUrl=null;
  for(const url of urlsToTry){
    try{
      const resp=await espnClient.get(url);
      if(resp.data&&Object.keys(resp.data).length>1){
        data=resp.data;
        usedUrl=url;
        break;
      }
    }catch(e){continue;}
  }
  if(!data) return{athleteId,stats:{},rawGroups:[],error:"No ESPN endpoint returned data"};

  let flat={};

  // Core API format: splits.categories[].stats[]
  // IMPORTANT: filter to current season splits only (not career)
  try{
    const cats=data.splits?.categories||[];
    // Look for "Regular Season" split, not "Career"  
    cats.forEach(cat=>{
      // Skip career categories
      if(/career/i.test(cat.name||"")) return;
      (cat.stats||[]).forEach(stat=>{
        if(stat.name)         flat[stat.name]         = parseFloat(stat.value)||0;
        if(stat.abbreviation) flat[stat.abbreviation] = parseFloat(stat.value)||0;
      });
    });
  }catch(e){}

  // Site API format: statistics[].names + stats
  try{
    const statGroups=data.statistics||[];
    // Prefer regular season, avoid career/playoff
    const regGroup=statGroups.find(g=>/regular\s*season/i.test(g.name||""))
      || statGroups.find(g=>/^(?!.*career)(?!.*playoff)(?!.*post)/i.test(g.name||""))
      || statGroups[0];
    if(regGroup){
      const names=regGroup.names||regGroup.labels||[];
      const stats=regGroup.stats||regGroup.values||[];
      names.forEach((n,i)=>{if(n)flat[n]=parseFloat(stats[i])||0;});
    }
  }catch(e){}

  // splitCategories format
  try{
    (data.splitCategories||[]).forEach(cat=>{
      (cat.splits||[]).forEach(split=>{
        if(/total|season|regular/i.test(split.abbreviation||split.displayName||"")){
          const names=cat.names||cat.abbreviations||[];
          (split.stats||[]).forEach((val,i)=>{const n=names[i];if(n&&flat[n]===undefined)flat[n]=parseFloat(val)||0;});
        }
      });
    });
  }catch(e){}

  const athlete=data.athlete||data.person||{};
  return{
    athleteId, usedUrl,
    name:athlete.fullName||athlete.displayName||null,
    stats:flat,
    statCount:Object.keys(flat).length,
    rawGroups:(data.statistics||[]).slice(0,2).map(g=>({
      name:g.name||"",
      names:(g.names||g.labels||[]).slice(0,15),
      stats:(g.stats||g.values||[]).slice(0,15)
    }))
  };
}

app.get("/",(req,res)=>res.json({name:"T.U.S.L. API v4",sports:["mlb","nfl","nba","nhl"]}));
app.get("/health",(req,res)=>res.json({status:"ok",uptime:`${Math.floor(process.uptime())}s`}));

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
  const empty={athleteId:id,stats:{},rawGroups:[],fromCache:false};
  try{
    const cacheKey=`stats_${sport}_${id}`;
    const cached=caches.stats.get(cacheKey);
    if(cached!==undefined) return res.json({...cached,fromCache:true});
    let result=empty;
    try{result=await getAthleteStats(sport,id);if(result&&Object.keys(result.stats||{}).length>0)caches.stats.set(cacheKey,result);}
    catch(e){console.error("Stats error",sport,id,e.message);}
    res.json({...result,fromCache:false});
  }catch(err){console.error("Stats route error:",err.message);res.json(empty);}
});

// Debug endpoint
app.get("/api/debug/:sport/:id",async(req,res)=>{
  const{sport,id}=req.params;
  if(!SPORTS[sport]) return res.status(400).json({error:"Invalid sport"});
  const{sport:s,league:l}=SPORTS[sport];
  // Try ESPN's event log and gamelog endpoints which have current season stats
  const urlsToTry=[
    `${COREAPI}/${s}/leagues/${l}/seasons/2025/types/2/athletes/${id}/statistics`,
    `${ESPN}/${s}/${l}/athletes/${id}/gamelog`,
    `${ESPN}/${s}/${l}/athletes/${id}/overview`,
    `https://site.web.api.espn.com/apis/common/v3/sports/${s}/${l}/athletes/${id}/stats`,
    `https://site.web.api.espn.com/apis/common/v3/sports/${s}/${l}/athletes/${id}/stats?region=us&lang=en&contentorigin=espn&season=2025&seasontype=2`,
    `${COREAPI}/${s}/leagues/${l}/athletes/${id}/eventlog?season=2025&seasontype=2&limit=1`,
  ];
  const results=[];
  for(const url of urlsToTry){
    try{
      const{data}=await espnClient.get(url);
      const keys=Object.keys(data).slice(0,12);
      const cats=(data.splits?.categories||data.categories||[]).map(c=>({name:c.name,first3:(c.stats||[]).slice(0,3).map(x=>({n:x.name,a:x.abbreviation,v:x.value}))}));
      const statGroups=(data.statistics||[]).map(g=>({name:g.name,firstNames:(g.names||[]).slice(0,5),firstStats:(g.stats||[]).slice(0,5)}));
      results.push({url,status:"OK",topKeys:keys,splitCats:cats.slice(0,4),statGroups:statGroups.slice(0,3),
        hasFilters:!!(data.filters),filtersInfo:(data.filters||[]).slice(0,3).map(f=>({n:f.name,v:f.value}))
      });
    }catch(e){results.push({url,status:"ERROR",msg:e.message});}
  }
  res.json({athleteId:id,sport,results});
});

app.use((req,res)=>res.status(404).json({error:"Not found"}));
app.listen(PORT,()=>console.log(`\n🏆 T.U.S.L. API v4 running on port ${PORT}\n`));
