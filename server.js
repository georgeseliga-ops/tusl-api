<script>
(()=>{let o="https://YOUR-TUSL-API.up.railway.app/api",n=[{slug:"mlb",emoji:"⚾",label:"MLB",color:"#f5c842"},{slug:"nfl",emoji:"🏈",label:"NFL",color:"#4a9eff"},{slug:"nba",emoji:"🏀",label:"NBA",color:"#ff6b35"},{slug:"nhl",emoji:"🏒",label:"NHL",color:"#7ee8a2"}],r={};async function s(){var e=document.getElementById("tusl-ticker-inner");if(e)try{var t,a=await(await fetch(o+"/dashboard")).json();let s=[];for(let t of n){var l=a.sports?.[t.slug];l&&!l.error&&l.games?.length&&l.games.forEach(e=>{s.push({sport:t,game:e})})}s.length?(t=s.map(({sport:e,game:t})=>{var s=t.isLive,a=t.score||t.shortName;return`
          <div class="tusl-tick-item ${s?"tusl-live":""}">
            ${s?'<span class="tusl-live-pip"></span>':`<span class="tusl-sport-dot" style="background:${e.color}"></span>`}
            <span style="color:${e.color};font-size:10px;letter-spacing:0.1em">${e.label}</span>
            <span class="tusl-teams">${t.shortName}</span>
            ${"pre"!==t.status?.state?`<span class="tusl-score">${a.split(" ").slice(-3).join(" ")}</span>`:""}
            <span style="color:#444;font-size:10px">${t.status?.detail||""}</span>
          </div>`}).join(""),e.innerHTML=`
        <div class="tusl-tick-label">
          <span style="width:5px;height:5px;border-radius:50%;background:#f5c842;display:inline-block"></span>
          T.U.S.L. LIVE
        </div>
        `+t+t):e.innerHTML=`<div class="tusl-tick-label">T.U.S.L. LIVE</div>
          <span class="tusl-tick-item" style="color:#444">NO GAMES TODAY — CHECK BACK SOON</span>`}catch{e.innerHTML=`<div class="tusl-tick-label">T.U.S.L.</div>
        <span class="tusl-tick-item" style="color:#333">SCORES UNAVAILABLE — API OFFLINE</span>`}}let a="mlb";function l(){var e=document.getElementById("tusl-games-area");e&&(e.innerHTML=`
      <div class="tusl-skel-grid">
        ${Array(6).fill(0).map(()=>`
          <div class="tusl-skel-card">
            <div class="tusl-skel-line" style="width:55%;height:10px"></div>
            <div class="tusl-skel-line" style="width:100%;height:20px;margin-top:6px"></div>
            <div class="tusl-skel-line" style="width:100%;height:20px"></div>
            <div class="tusl-skel-line" style="width:40%;height:9px;margin-top:4px"></div>
          </div>`).join("")}
      </div>`)}function p(t){var e=document.getElementById("tusl-games-area");if(e){var s=r[t];if(s){s=s.games||[];if(s.length){let u=n.find(e=>e.slug===t)?.color||"#f5c842";e.innerHTML=`<div class="tusl-games-grid">${s.map((e,t)=>{var s=u,{competitors:e=[],status:a={},venue:l,broadcast:i,isLive:o}=e,n=e.find(e=>"away"===e.homeAway)||e[0]||{},e=e.find(e=>"home"===e.homeAway)||e[1]||{},r=parseInt(n.score||0),p=parseInt(e.score||0),c="pre"!==a.state,d=o?"live":"post"===a.state?"final":"",a=o?(`${a.clock||""} `+(a.period?"· P"+a.period:"")).trim()||"LIVE":(a.detail||"UPCOMING").toUpperCase();return`
      <div class="tusl-game-card ${o?"tusl-is-live":""}"
           style="--tusl-card-color:${s};animation-delay:${.04*t}s">
        <div class="tusl-card-head">
          <span class="tusl-status ${d}">
            ${o?'<span class="tusl-live-pip"></span>':""}
            ${a}
          </span>
          ${i?`<span class="tusl-broadcast">${i}</span>`:""}
        </div>
        <div class="tusl-team-row ${c&&p<r?"tusl-winning":""}">
          <div class="tusl-team-left">
            <span class="tusl-team-abbr">${n.team||"—"}</span>
            ${n.record?`<span class="tusl-team-record">${n.record}</span>`:""}
          </div>
          ${c?`<span class="tusl-team-score">${n.score||0}</span>`:""}
        </div>
        <div class="tusl-team-row ${c&&r<p?"tusl-winning":""}">
          <div class="tusl-team-left">
            <span class="tusl-team-abbr">${e.team||"—"}</span>
            ${e.record?`<span class="tusl-team-record">${e.record}</span>`:""}
          </div>
          ${c?`<span class="tusl-team-score">${e.score||0}</span>`:""}
        </div>
        ${l?`<div class="tusl-card-venue">📍 ${l}</div>`:""}
      </div>`}).join("")}</div>`}else e.innerHTML='<div class="tusl-state">🏟 NO GAMES SCHEDULED TODAY</div>'}else l()}}async function i(){let i=0;await Promise.allSettled(n.map(async e=>{try{var t=await(await fetch(`${o}/sports/${e.slug}/scoreboard`)).json(),s=(r[e.slug]=t).games||[],a=s.filter(e=>e.isLive).length,l=(i+=a,document.getElementById("tusl-tab-"+e.slug));l&&(l.textContent=0<a?a+" LIVE":s.length,l.className="tusl-tab-count"+(0<a?" has-live":""))}catch{t=document.getElementById("tusl-tab-"+e.slug);t&&(t.textContent="—")}}));var e=document.getElementById("tusl-live-count"),t=document.getElementById("tusl-live-num");0<i&&e&&t&&(t.textContent=i,e.style.display="flex"),p(a)}function e(){var e=document.createElement("style"),e=(e.textContent=`
    /* ── Ticker bar ──────────────────────────────────────────────── */
    #tusl-ticker {
      position: sticky;
      top: 0;
      z-index: 1000;
      background: #0d0d14;
      border-bottom: 1px solid #1e1e30;
      overflow: hidden;
      height: 36px;
      display: flex;
      align-items: center;
      font-family: 'DM Mono', 'Courier New', monospace;
    }

    #tusl-ticker-inner {
      display: flex;
      align-items: center;
      gap: 0;
      white-space: nowrap;
      animation: tusl-scroll 40s linear infinite;
      padding-right: 80px;
    }

    #tusl-ticker:hover #tusl-ticker-inner {
      animation-play-state: paused;
    }

    @keyframes tusl-scroll {
      0%   { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }

    .tusl-tick-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 20px;
      font-size: 11px;
      letter-spacing: 0.08em;
      color: #888;
      border-right: 1px solid #1e1e30;
    }

    .tusl-tick-item .tusl-sport-dot {
      width: 5px; height: 5px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .tusl-tick-item .tusl-teams {
      color: #ccc;
      font-weight: 500;
    }

    .tusl-tick-item .tusl-score {
      color: #fff;
      font-weight: 700;
    }

    .tusl-tick-item.tusl-live .tusl-teams {
      color: #fff;
    }

    .tusl-tick-item .tusl-live-pip {
      width: 5px; height: 5px;
      border-radius: 50%;
      background: #ff4455;
      animation: tusl-pip 1.2s ease-in-out infinite;
    }

    @keyframes tusl-pip {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.2; }
    }

    .tusl-tick-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 16px;
      font-size: 10px;
      letter-spacing: 0.2em;
      color: #f5c842;
      font-weight: 700;
      border-right: 1px solid #2a2a3e;
      flex-shrink: 0;
    }

    /* ── Live Scores Panel ───────────────────────────────────────── */
    #tusl-scores-panel {
      background: #090910;
      border-top: 3px solid #f5c842;
      padding: 40px 0 60px;
    }

    .tusl-panel-header {
      max-width: 1100px;
      margin: 0 auto 28px;
      padding: 0 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
    }

    .tusl-panel-title {
      font-family: 'Bebas Neue', 'Impact', sans-serif;
      font-size: 32px;
      letter-spacing: 0.1em;
      color: #f5c842;
      line-height: 1;
    }

    .tusl-panel-title span {
      color: #fff;
    }

    .tusl-live-count {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: 'DM Mono', 'Courier New', monospace;
      font-size: 11px;
      letter-spacing: 0.15em;
      color: #ff4455;
    }

    .tusl-live-count .tusl-live-pip {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #ff4455;
      animation: tusl-pip 1.2s ease-in-out infinite;
    }

    /* Sport tabs */
    .tusl-sport-tabs {
      max-width: 1100px;
      margin: 0 auto 24px;
      padding: 0 20px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .tusl-sport-tab {
      font-family: 'DM Mono', 'Courier New', monospace;
      font-size: 11px;
      letter-spacing: 0.12em;
      padding: 8px 18px;
      border-radius: 100px;
      border: 1px solid #1e1e30;
      background: #111118;
      color: #555;
      cursor: pointer;
      transition: all 0.18s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tusl-sport-tab:hover {
      border-color: #333;
      color: #999;
    }

    .tusl-sport-tab.active {
      border-color: var(--tusl-tab-color);
      color: var(--tusl-tab-color);
      background: rgba(255,255,255,0.04);
    }

    .tusl-tab-count {
      background: rgba(255,255,255,0.08);
      border-radius: 100px;
      padding: 1px 7px;
      font-size: 10px;
    }

    .tusl-tab-count.has-live {
      background: rgba(255,68,85,0.2);
      color: #ff4455;
    }

    /* Games grid */
    .tusl-games-grid {
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 20px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 12px;
    }

    .tusl-game-card {
      background: #111118;
      border: 1px solid #1e1e30;
      border-radius: 10px;
      padding: 16px 18px;
      position: relative;
      overflow: hidden;
      transition: transform 0.15s, border-color 0.15s;
      animation: tusl-fadein 0.25s ease both;
    }

    @keyframes tusl-fadein {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .tusl-game-card:hover {
      transform: translateY(-2px);
      border-color: rgba(245,200,66,0.2);
    }

    .tusl-game-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: var(--tusl-card-color, #f5c842);
      opacity: 0.5;
    }

    .tusl-game-card.tusl-is-live::before {
      opacity: 1;
      animation: tusl-glow 2s ease-in-out infinite;
    }

    @keyframes tusl-glow {
      0%, 100% { opacity: 0.5; }
      50%       { opacity: 1; }
    }

    /* Card header */
    .tusl-card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }

    .tusl-status {
      font-family: 'DM Mono', 'Courier New', monospace;
      font-size: 10px;
      letter-spacing: 0.1em;
      padding: 3px 8px;
      border-radius: 100px;
      background: rgba(255,255,255,0.05);
      color: #555;
    }

    .tusl-status.live {
      background: rgba(255,68,85,0.15);
      color: #ff4455;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .tusl-status.final {
      background: rgba(126,232,162,0.1);
      color: #7ee8a2;
    }

    .tusl-broadcast {
      font-family: 'DM Mono', 'Courier New', monospace;
      font-size: 10px;
      color: #444;
      letter-spacing: 0.06em;
    }

    /* Teams */
    .tusl-team-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 0;
    }

    .tusl-team-row + .tusl-team-row {
      border-top: 1px solid #1a1a28;
    }

    .tusl-team-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .tusl-team-abbr {
      font-family: 'Bebas Neue', 'Impact', sans-serif;
      font-size: 20px;
      letter-spacing: 0.06em;
      color: #bbb;
      min-width: 48px;
    }

    .tusl-team-record {
      font-family: 'DM Mono', 'Courier New', monospace;
      font-size: 10px;
      color: #444;
    }

    .tusl-team-score {
      font-family: 'Bebas Neue', 'Impact', sans-serif;
      font-size: 26px;
      letter-spacing: 0.04em;
      color: #bbb;
    }

    .tusl-team-row.tusl-winning .tusl-team-abbr,
    .tusl-team-row.tusl-winning .tusl-team-score {
      color: var(--tusl-card-color, #f5c842);
    }

    .tusl-card-venue {
      margin-top: 12px;
      font-family: 'DM Mono', 'Courier New', monospace;
      font-size: 10px;
      color: #333;
      letter-spacing: 0.06em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Empty / loading states */
    .tusl-state {
      max-width: 1100px;
      margin: 0 auto;
      padding: 60px 20px;
      text-align: center;
      font-family: 'DM Mono', 'Courier New', monospace;
      font-size: 12px;
      letter-spacing: 0.12em;
      color: #444;
    }

    .tusl-skel-grid {
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 20px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 12px;
    }

    .tusl-skel-card {
      background: #111118;
      border: 1px solid #1e1e30;
      border-radius: 10px;
      padding: 16px 18px;
      height: 130px;
    }

    .tusl-skel-line {
      border-radius: 3px;
      margin-bottom: 10px;
      background: linear-gradient(90deg, #1a1a28 25%, #222236 50%, #1a1a28 75%);
      background-size: 200% 100%;
      animation: tusl-shimmer 1.4s infinite;
    }

    @keyframes tusl-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  `,document.head.appendChild(e),document.querySelector('link[href*="Bebas+Neue"]')||((e=document.createElement("link")).rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&display=swap",document.head.appendChild(e)),(e=document.createElement("div")).id="tusl-ticker",e.innerHTML=`
      <div id="tusl-ticker-inner">
        <div class="tusl-tick-label">
          <span style="width:5px;height:5px;border-radius:50%;background:#f5c842;display:inline-block"></span>
          T.U.S.L. LIVE
        </div>
        <span class="tusl-tick-item" style="color:#555;font-size:11px;padding:0 24px">
          Loading scores...
        </span>
      </div>`,document.body.insertBefore(e,document.body.firstChild),(()=>{let t=document.createElement("section");return t.id="tusl-scores-panel",t.innerHTML=`
      <div class="tusl-panel-header">
        <div class="tusl-panel-title">TODAY'S <span>GAMES</span></div>
        <div class="tusl-live-count" id="tusl-live-count" style="display:none">
          <span class="tusl-live-pip"></span>
          <span id="tusl-live-num">0</span> LIVE NOW
        </div>
      </div>
      <div class="tusl-sport-tabs">
        ${n.map(e=>`
          <button class="tusl-sport-tab ${"mlb"===e.slug?"active":""}"
            data-sport="${e.slug}"
            style="--tusl-tab-color:${e.color}">
            ${e.emoji} ${e.label}
            <span class="tusl-tab-count" id="tusl-tab-${e.slug}">—</span>
          </button>`).join("")}
      </div>
      <div id="tusl-games-area"></div>`,t.addEventListener("click",e=>{e=e.target.closest(".tusl-sport-tab");e&&(t.querySelectorAll(".tusl-sport-tab").forEach(e=>e.classList.remove("active")),e.classList.add("active"),p(a=e.dataset.sport))}),t})()),t=document.querySelector("section, main, #hero, .hero, header + div");t&&t.parentNode?t.parentNode.insertBefore(e,t.nextSibling):document.body.appendChild(e),l(),i(),s(),setInterval(async()=>{n.some(e=>(r[e.slug]?.games||[]).some(e=>e.isLive))&&(await i(),await s())},3e4)}"loading"===document.readyState?document.addEventListener("DOMContentLoaded",e):e()})();</script>
