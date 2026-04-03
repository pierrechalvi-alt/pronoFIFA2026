const APP = document.getElementById("app");
const USERBOX = document.getElementById("userBox");
const ASSET_BASE_URL = new URL("./", import.meta.url);

const LS_KEY = "fwc26_pronos_v1";

const state = {
  me: null,
  onboardingStep: "welcome", // welcome | profile | app
  view: "groups", // groups | qualifs | ko | recap
  hubTab: "leaderboard", // leaderboard | myPicks | stats
  selectedLeaderboardUserKey: null,
  teams: null,
  matches: null,
  filterText: "",
  showUnpickedOnly: false,
  data: loadAll(),
};

init();

async function init(){
  try {
    const [teams, matches] = await Promise.all([
      fetch("./data/teams.json").then(r=>r.json()),
      fetch("./data/matches.json").then(r=>r.json())
    ]);
    state.teams = teams;
    state.matches = normalizeMatches(matches, teams);
  } catch (err) {
    APP.innerHTML = `
      <section class="card">
        <h1>Impossible de charger l'application</h1>
        <p>Vérifie que les fichiers <code>data/teams.json</code> et <code>data/matches.json</code> sont bien accessibles.</p>
        <small>Détail technique : ${escapeHtml(err?.message || "erreur inconnue")}</small>
      </section>
    `;
    return;
  }

  if (state.data?.lastUserKey) {
    const u = state.data.users?.[state.data.lastUserKey];
    if (u?.profile) {
      state.me = u.profile;
      state.onboardingStep = "app";
    }
  }
  render();
}

function normalizeMatches(m, teams){
  const providedGroup = Array.isArray(m.groupStage) ? [...m.groupStage] : [];
  const groupStage = buildGroupStageMatches(teams, providedGroup);
  const knockout = Array.isArray(m.knockout) ? [...m.knockout] : [];
  const existing = new Set([...groupStage, ...knockout].map(match => Number(match.id)));

  for (let id = 1; id <= 104; id += 1){
    if (existing.has(id)) continue;
    if (id > 72) {
      knockout.push({
        id,
        stage: "KO",
        round: inferRoundFromId(id),
        homeLabel: `Équipe à définir (${id}A)`,
        awayLabel: `Équipe à définir (${id}B)`,
        date: null,
        time: null,
        city: null,
        stadium: null
      });
    }
  }

  groupStage.sort((a, b) => a.id - b.id);
  knockout.sort((a, b) => a.id - b.id);
  return { groupStage, knockout };
}

function buildGroupStageMatches(teams, providedGroup){
  const groups = teams?.groups || [];
  const teamsByGroup = teams?.teamsByGroup || {};
  const providedById = new Map(
    providedGroup
      .filter((m) => Number.isFinite(Number(m.id)) && Number(m.id) >= 1 && Number(m.id) <= 72)
      .map((m) => [Number(m.id), m])
  );
  const pairings = [[0, 1], [2, 3], [0, 2], [3, 1], [0, 3], [1, 2]];
  const groupStage = [];

  for (let gIndex = 0; gIndex < groups.length; gIndex += 1){
    const group = groups[gIndex];
    const teamList = [...(teamsByGroup[group] || [])];
    while (teamList.length < 4) teamList.push(`Équipe à définir (${group}${teamList.length + 1})`);

    for (let i = 0; i < pairings.length; i += 1){
      const id = gIndex * 6 + i + 1;
      const [homeIdx, awayIdx] = pairings[i];
      const provided = providedById.get(id);
      const generatedHome = teamList[homeIdx];
      const generatedAway = teamList[awayIdx];

      groupStage.push({
        id,
        stage: "GROUP",
        group,
        home: isPlaceholderTeam(provided?.home) ? generatedHome : provided.home,
        away: isPlaceholderTeam(provided?.away) ? generatedAway : provided.away,
        date: provided?.date ?? null,
        time: provided?.time ?? null,
        city: provided?.city ?? null,
        stadium: provided?.stadium ?? null,
        scoreHome: provided?.scoreHome,
        scoreAway: provided?.scoreAway
      });
    }
  }
  return groupStage;
}

function isPlaceholderTeam(name){
  if (!name) return true;
  const normalized = String(name).trim().toLowerCase();
  return normalized === "à compléter"
    || normalized.startsWith("équipe ")
    || normalized.startsWith("equipe ");
}

function inferRoundFromId(id){
  if (id >= 73 && id <= 88) return "R32";
  if (id >= 89 && id <= 96) return "R16";
  if (id >= 97 && id <= 100) return "QF";
  if (id >= 101 && id <= 102) return "SF";
  if (id === 103) return "BRONZE";
  return "FINAL";
}

function userKey(profile){
  return `${profile.lastName.trim().toLowerCase()}_${profile.firstName.trim().toLowerCase()}`.replace(/\s+/g,"-");
}

function loadAll(){
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || { users:{}, lastUserKey:null }; }
  catch { return { users:{}, lastUserKey:null }; }
}
function saveAll(){ localStorage.setItem(LS_KEY, JSON.stringify(state.data)); }

function ensureUser(){
  const key = userKey(state.me);
  if (!state.data.users[key]) {
    state.data.users[key] = {
      profile: state.me,
      picks: {},          // matchId -> "H" | "D" | "A"
      qualifiers: {},     // group -> { first, second } (optionnel)
      bonusGoals: null,
      finalSubmittedAt: null,
      tieBreakerSubmittedAt: null
    };
  }
  state.data.lastUserKey = key;
  saveAll();
  return state.data.users[key];
}
function currentUser(){
  if (!state.me) return null;
  return ensureUser();
}

function setUser(profile){
  state.me = profile;
  state.onboardingStep = "app";
  ensureUser();
  render();
}
function logout(){
  state.me = null;
  state.onboardingStep = "welcome";
  state.data.lastUserKey = null;
  saveAll();
  render();
}

function pick(matchId, val){
  const u = currentUser();
  if (u.finalSubmittedAt) return;
  const match = getMatchById(matchId);
  if (match?.stage === "KO" && val === "D") {
    alert("À partir des seizièmes, le match nul n'est pas autorisé. Choisis le qualifié (1 ou 2).");
    return;
  }
  u.picks[String(matchId)] = val;
  saveAll();
  render();
}

function setBonusGoals(val){
  const u = currentUser();
  if (!u.finalSubmittedAt || u.tieBreakerSubmittedAt) return;
  u.bonusGoals = val === "" ? null : Number(val);
  saveAll();
}

function setQualifier(group, which, team){
  const u = currentUser();
  if (!u.qualifiers[group]) u.qualifiers[group] = { first:null, second:null };
  u.qualifiers[group][which] = team || null;
  saveAll();
}

/* ---------- Render ---------- */

function render(){
  USERBOX.innerHTML = state.me
    ? `<span class="badge a1">👤 ${escapeHtml(state.me.firstName)} ${escapeHtml(state.me.lastName)}${state.me.nickname ? ` (${escapeHtml(state.me.nickname)})` : ""}</span>
       <button class="btn" id="logoutBtn" style="margin-left:10px">Déconnexion</button>`
    : `<span class="badge">Non connecté</span>`;

  if (state.me) {
    queueMicrotask(()=>{
      const b = document.getElementById("logoutBtn");
      if (b) b.onclick = logout;
    });
  }

  if (!state.me && state.onboardingStep === "welcome") return renderWelcome();
  if (!state.me && state.onboardingStep === "profile") return renderProfileSetup();
  return renderApp();
}

function renderWelcome(){
  APP.innerHTML = `
    <div class="grid two">
      <section class="card">
        <h1>Bienvenue dans l’arène des pronos ⚽</h1>
        <p>On n’est pas là pour se prendre la tête : on pronostique tout le mondial avant le premier match… oui, même les <b>104</b>.</p>
        <p><b>Petit mantra :</b> “Confiance absolue, mauvaise foi autorisée.” 😄</p>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="startBtn">Je fonce !</button>
        </div>
      </section>

      <aside class="card">
        <h2>Règles express</h2>
        <p>
          Tu pronostiques <b>uniquement le résultat</b> (1/N/2) pour tous les matchs, jusqu’au vainqueur final.
          Ensuite seulement, question subsidiaire sur le total de buts.
        </p>
        <small>Pas de compte email : ton profil est enregistré localement.</small>
      </aside>
    </div>
  `;
  document.getElementById("startBtn").onclick = () => {
    state.onboardingStep = "profile";
    render();
  };
}

function renderProfileSetup(){
  APP.innerHTML = `
    <div class="grid two">
      <section class="card">
        <h1>Présentez-vous !</h1>
        <p>Qui je suis !? Deux infos sérieuses et un surnom pour la gloire.</p>
        <div class="row">
          <div class="field" style="flex:1; min-width:220px">
            <label>Prénom</label>
            <input id="firstName" placeholder="Ex: Karim" autocomplete="given-name" />
          </div>
          <div class="field" style="flex:1; min-width:220px">
            <label>Nom</label>
            <input id="lastName" placeholder="Ex: Benzema" autocomplete="family-name" />
          </div>
          <div class="field" style="flex:1; min-width:220px">
            <label>Surnom</label>
            <input id="nickname" placeholder="Ex: Madame Oracle" />
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="nextBtn">Suivant</button>
        </div>
      </section>
    </div>
  `;
  document.getElementById("nextBtn").onclick = () => {
    const firstName = document.getElementById("firstName").value.trim();
    const lastName  = document.getElementById("lastName").value.trim();
    const nickname  = document.getElementById("nickname").value.trim();
    if (!firstName || !lastName || !nickname) return alert("Merci de compléter prénom, nom et surnom.");
    setUser({ firstName, lastName, nickname });
  };
}

function renderApp(){
  const u = currentUser();
  const total = countTotalMatches();
  const done = countPicks(u);
  const groupTotal = state.matches.groupStage.length;
  const groupDone = countPicksByStage(u, "GROUP");
  const koTotal = state.matches.knockout.length;
  const koDone = countPicksByStage(u, "KO");
  const percent = total ? Math.round((done / total) * 100) : 0;

  APP.innerHTML = `
    <div class="grid two">
      <section class="card">
        <h1>Pronos Coupe du Monde 2026</h1>
        <p>
          Objectif : être le plus proche possible… et prétendre que c’était “évident”.
          (Pronostics : <b>vainqueur / nul</b> seulement.)
        </p>
        <div class="row" style="margin-top:8px">
          <span class="badge a2">1) Infos perso ✅</span>
          <span class="badge ${u.finalSubmittedAt ? "a2" : ""}">2) Pronostics ${u.finalSubmittedAt ? "✅" : "en cours"}</span>
          <span class="badge ${u.tieBreakerSubmittedAt ? "a1" : ""}">3) Subsidiaire ${u.tieBreakerSubmittedAt ? "✅" : "à faire"}</span>
        </div>

        <div class="hr"></div>

        <div class="row">
          <span class="badge a2">Poules</span><span class="badge">1 pt / match</span>
          <span class="badge a3">Finale</span><span class="badge">32 pts</span>
        </div>

        <div class="hr"></div>

        <h2>Statut de validation</h2>
        <p>
          ${u.finalSubmittedAt
            ? `Pronostics verrouillés le <b>${new Date(u.finalSubmittedAt).toLocaleString("fr-FR")}</b>.`
            : `Tu peux modifier librement tes pronos tant que l’envoi définitif n’est pas fait.`}
        </p>

        ${u.finalSubmittedAt ? `
          <div class="field" style="margin-top:12px">
            <label>Question subsidiaire (total de buts sur 104 matchs)</label>
            <input id="bonusGoals" type="number" min="0" step="1" placeholder="Ex: 312"
                   value="${u.bonusGoals ?? ""}" ${u.tieBreakerSubmittedAt ? "disabled" : ""}/>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="tieBtn" ${u.tieBreakerSubmittedAt ? "disabled" : ""}>Envoyer la réponse subsidiaire</button>
          </div>
        ` : ""}

      </section>

      <aside class="card">
        <h2>Progression</h2>
        <p><b>${done}/${total}</b> matchs pronostiqués.</p>
        <div class="progress">
          <div class="progress-bar" style="width:${percent}%"></div>
        </div>
        <div class="row" style="margin-top:10px">
          <span class="badge a2">Poules: ${groupDone}/${groupTotal}</span>
          <span class="badge a4">Phase finale: ${koDone}/${koTotal}</span>
        </div>
        <small>Ton avancée est sauvegardée automatiquement dans ce navigateur.</small>
      </aside>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="row" style="margin-bottom:10px">
        <div class="field" style="flex:1; min-width:220px">
          <label>Recherche rapide (équipe / ville / stade)</label>
          <input id="filterText" placeholder="Ex: France, New York, Azteca..." value="${escapeAttr(state.filterText)}"/>
        </div>
        <label class="toggle-wrap">
          <input id="unpickedOnly" type="checkbox" ${state.showUnpickedOnly ? "checked" : ""}/>
          Afficher uniquement les matchs non pronostiqués
        </label>
      </div>
      <div class="tabs">
        <div class="tab ${state.view==="groups"?"active":""}" data-view="groups">Phase de groupes</div>
        <div class="tab ${state.view==="qualifs"?"active":""}" data-view="qualifs">Qualifiés</div>
        <div class="tab ${state.view==="ko"?"active":""}" data-view="ko">Phase finale</div>
        <div class="tab ${state.view==="recap"?"active":""}" data-view="recap">Récap</div>
      </div>
      <div id="panel"></div>
    </div>
  `;

  const bonus = document.getElementById("bonusGoals");
  if (bonus) bonus.oninput = (e) => setBonusGoals(e.target.value);
  const tieBtn = document.getElementById("tieBtn");
  if (tieBtn) tieBtn.onclick = () => submitTieBreaker();
  document.getElementById("filterText").oninput = (e) => {
    state.filterText = e.target.value;
    render();
  };
  document.getElementById("unpickedOnly").onchange = (e) => {
    state.showUnpickedOnly = Boolean(e.target.checked);
    render();
  };

  for (const el of document.querySelectorAll(".tab")){
    el.onclick = () => { state.view = el.dataset.view; render(); };
  }

  const panel = document.getElementById("panel");
  if (state.view === "groups") panel.innerHTML = renderGroups();
  if (state.view === "qualifs") panel.innerHTML = renderQualifs();
  if (state.view === "ko") panel.innerHTML = renderKO();
  if (state.view === "recap") panel.innerHTML = renderRecap();

  wireMatchButtons();
  wireQualifs();
  wireHubControls();
}

function renderGroups(){
  const groups = state.teams.groups;
  const gs = state.matches.groupStage;
  let html = `<p>Pronostique les matchs de poule (1 / N / 2). Objectif obligatoire : <b>72/72</b> en phase de groupes.</p>`;

  for (const g of groups){
    const matches = filterMatches(gs.filter(m => m.group === g));
    html += `<div class="hr"></div><h2>Groupe ${g}</h2>`;

    if (!matches.length){
      html += `<p><small>${state.filterText || state.showUnpickedOnly ? "Aucun match ne correspond aux filtres." : "Aucun match listé pour ce groupe (à compléter dans data/matches.json)."}</small></p>`;
      continue;
    }
    for (const m of matches) html += matchRow(m);
  }

  html += `<div class="hr"></div><small>Objectif global : valider <b>104/104</b> avant l’envoi définitif.</small>`;
  return html;
}

function renderQualifs(){
  const u = currentUser();
  const groups = state.teams.groups;

  let html = `<p>Optionnel : choisis 1er/2e de chaque groupe (utile si vous voulez ensuite construire une phase finale “réaliste”).</p>`;

  for (const g of groups){
    const teams = state.teams.teamsByGroup[g] || [];
    const q = u.qualifiers[g] || { first:null, second:null };

    html += `
      <div class="hr"></div>
      <h2>Groupe ${g}</h2>
      <div class="row">
        <div class="field" style="flex:1; min-width:220px">
          <label>1er</label>
          <select data-qgroup="${g}" data-qwhich="first">
            <option value="">—</option>
            ${teams.map(t => `<option ${q.first===t?"selected":""} value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("")}
          </select>
        </div>
        <div class="field" style="flex:1; min-width:220px">
          <label>2e</label>
          <select data-qgroup="${g}" data-qwhich="second">
            <option value="">—</option>
            ${teams.map(t => `<option ${q.second===t?"selected":""} value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("")}
          </select>
        </div>
      </div>
      <small>Tu peux laisser vide si tu veux juste pronostiquer “match par match”.</small>
    `;
  }
  return html;
}

function renderKO(){
  const ko = state.matches.knockout || [];
  if (!ko.length) return `<p><small>Aucun match KO listé.</small></p>`;

  const rounds = [
    { key:"R32", title:"Seizièmes de finale (Round of 32)" },
    { key:"R16", title:"Huitièmes de finale" },
    { key:"QF",  title:"Quarts de finale" },
    { key:"SF",  title:"Demi-finales" },
    { key:"BRONZE", title:"Finale de bronze" },
    { key:"FINAL", title:"Finale" }
  ];

  let html = `<p>Pronostique toute la phase finale jusqu’au vainqueur : <b>32/32</b> matchs. À partir des seizièmes, le nul n'est plus disponible (il faut choisir le qualifié).</p>`;

  for (const r of rounds){
    const ms = filterMatches(ko.filter(m => m.round === r.key));
    if (!ms.length) continue;
    html += `<div class="hr"></div><h2>${r.title}</h2>`;
    for (const m of ms) html += matchRow(m);
  }
  if (!html.includes("<h2>")) {
    return `<p><small>Aucun match KO ne correspond aux filtres en cours.</small></p>`;
  }
  return html;
}

function renderRecap(){
  const u = currentUser();
  const total = countTotalMatches();
  const done = countPicks(u);
  const canFinalize = done === total && !u.finalSubmittedAt;

  return `
    <p>Récapitulatif (preuve officielle en cas de “j’avais dit ça”).</p>
    <div class="hr"></div>
    <p><b>${done}/${total}</b> matchs pronostiqués.</p>
    <p>Question subsidiaire : <b>${u.tieBreakerSubmittedAt ? u.bonusGoals : "pas encore envoyée"}</b></p>
    ${!u.finalSubmittedAt ? `
      <button class="btn primary" id="finalBtn" ${canFinalize ? "" : "disabled"}>
        Envoie définitif de mes pronos
      </button>
      <small>${canFinalize ? "Attention : après validation, plus de marche arrière." : `Tu dois d'abord pronostiquer les ${total} matchs.`}</small>
    ` : `
      <p><b>✅ Envoi définitif effectué.</b> ${u.tieBreakerSubmittedAt ? "Merci, ton dossier est complet !" : "Il te reste la réponse subsidiaire à envoyer en haut de page."}</p>
    `}
    <div class="row" style="margin-top:10px">
      <button class="btn danger" id="resetBtn">Tout effacer (panique)</button>
    </div>
    ${u.tieBreakerSubmittedAt ? renderPlayerHub() : ""}
  `;
}

/* ---------- UI helpers ---------- */

function matchRow(m){
  const u = currentUser();
  const v = u.picks[String(m.id)] || "";
  const locked = Boolean(u.finalSubmittedAt);
  const { homeLabel, awayLabel } = getMatchDisplayTeams(u, m);
  const isKO = m.stage === "KO";

  const meta = [
    `Match ${m.id}`,
    m.group ? `Groupe ${m.group}` : null,
    roundLabel(m.round),
    m.city,
    m.stadium,
    m.date,
    m.time
  ].filter(Boolean).join(" • ");

  return `
    <div class="match" data-matchid="${m.id}">
      <div>
        <div class="team">${escapeHtml(homeLabel)}</div>
        <div class="meta">${escapeHtml(meta)}</div>
      </div>

      <div class="meta" style="text-align:center">vs</div>

      <div style="text-align:right">
        <div class="team">${escapeHtml(awayLabel)}</div>
        <div class="meta">&nbsp;</div>
      </div>

      <div class="picks">
        <button class="pick ${v==="H"?"active":""}" data-pick="H" title="Victoire équipe gauche" ${locked ? "disabled" : ""}>1</button>
        ${isKO ? "" : `<button class="pick ${v==="D"?"active":""}" data-pick="D" title="Match nul" ${locked ? "disabled" : ""}>N</button>`}
        <button class="pick ${v==="A"?"active":""}" data-pick="A" title="Victoire équipe droite" ${locked ? "disabled" : ""}>2</button>
      </div>
    </div>
  `;
}

function wireMatchButtons(){
  for (const el of document.querySelectorAll(".match")){
    const id = Number(el.dataset.matchid);
    for (const b of el.querySelectorAll(".pick")){
      b.onclick = () => pick(id, b.dataset.pick);
    }
  }

  const finalBtn = document.getElementById("finalBtn");
  if (finalBtn) finalBtn.onclick = () => submitFinalPicks();

  const reset = document.getElementById("resetBtn");
  if (reset) reset.onclick = () => {
    if (!confirm("Tout effacer pour cet utilisateur ?")) return;
    const key = userKey(state.me);
    delete state.data.users[key];
    state.me = null;
    state.data.lastUserKey = null;
    saveAll();
    render();
  };
}

function wireQualifs(){
  for (const sel of document.querySelectorAll("select[data-qgroup]")){
    sel.onchange = (e) => {
      const g = e.target.dataset.qgroup;
      const which = e.target.dataset.qwhich;
      setQualifier(g, which, e.target.value || null);
    };
  }
}

function submitFinalPicks(){
  const u = currentUser();
  const total = countTotalMatches();
  const done = countPicks(u);
  if (done !== total) {
    alert(`Il manque encore ${total - done} match(s) avant l'envoi définitif.`);
    return;
  }
  if (!confirm("Confirmer l'envoi définitif ? Après ça, les pronos sont verrouillés.")) return;
  u.finalSubmittedAt = new Date().toISOString();
  saveAll();
  render();
}

function submitTieBreaker(){
  const u = currentUser();
  if (!u.finalSubmittedAt) return;
  if (!Number.isFinite(u.bonusGoals)) {
    alert("Entre un nombre valide pour la question subsidiaire.");
    return;
  }
  u.tieBreakerSubmittedAt = new Date().toISOString();
  state.selectedLeaderboardUserKey = userKey(u.profile);
  state.hubTab = "leaderboard";
  saveAll();
  alert("Merci ! Ton profil joueur est complet 🎉");
  state.view = "recap";
  render();
}

function renderPlayerHub(){
  const rankings = computeLeaderboard();
  const liveRows = listLiveResults();
  const stats = computeCommunityStats();
  const selectedUser = getSelectedLeaderboardUser();
  const selectedUserLabel = selectedUser?.profile
    ? `${selectedUser.profile.firstName} ${selectedUser.profile.lastName}`
    : "Joueur";
  const myKey = userKey(currentUser().profile);
  return `
    <div class="hr"></div>
    <h2>Merci pour ta participation 🙌</h2>
    <p>Ton profil est créé. À gauche : résultats + calendrier. À droite : classement interactif, ton tableau de pronos, et statistiques de la communauté.</p>
    <div class="hub-layout" style="margin-top:10px">
      <section class="card" style="padding:12px">
        <h2>Résultats & calendrier</h2>
        ${liveRows || `<p style="margin-top:0">Aucun score publié pour le moment. Les résultats s’afficheront automatiquement dès qu’ils seront ajoutés.</p>`}
        ${renderCalendar()}
      </section>
      <section class="card" style="padding:12px">
        <div class="tabs" style="margin-top:0">
          <div class="tab ${state.hubTab==="leaderboard"?"active":""}" data-hubtab="leaderboard">Classement</div>
          <div class="tab ${state.hubTab==="myPicks"?"active":""}" data-hubtab="myPicks">Mes pronos</div>
          <div class="tab ${state.hubTab==="stats"?"active":""}" data-hubtab="stats">Statistiques</div>
        </div>
        ${state.hubTab === "leaderboard" ? `
          <h2>Classement des joueurs</h2>
          ${rankings.map((r, idx) => `
            <button class="player-row ${state.selectedLeaderboardUserKey === r.key ? "active" : ""}" data-playerkey="${escapeAttr(r.key)}">
              <span><b>#${idx + 1} ${escapeHtml(r.label)}</b></span>
              <span class="badge">${r.done}/${r.total} pronos</span>
            </button>
          `).join("")}
          ${selectedUser ? `
            <div class="hr"></div>
            <h2>Grille de ${escapeHtml(selectedUserLabel)}</h2>
            ${renderPicksTable(selectedUser, selectedUser.profile.firstName)}
          ` : ""}
        ` : ""}
        ${state.hubTab === "myPicks" ? `
          <h2>Ma grille de pronostics</h2>
          ${renderPicksTable(currentUser(), "Moi")}
        ` : ""}
        ${state.hubTab === "stats" ? `
          <h2>Statistiques utiles</h2>
          ${stats.length ? stats.map((item) => `
            <div class="row" style="justify-content:space-between; border-bottom:1px solid var(--line); padding:6px 0">
              <span>${escapeHtml(item.label)}</span>
              <span class="badge">${item.rate}% (${item.count}/${item.total})</span>
            </div>
          `).join("") : `<p>Aucune statistique disponible pour le moment.</p>`}
          <small>Exemples : % de joueurs voyant la France en quart, le Brésil en finale, etc.</small>
        ` : ""}
        ${state.hubTab === "leaderboard" && state.selectedLeaderboardUserKey === myKey ? `
          <small>Astuce : clique sur un autre joueur pour comparer sa grille.</small>
        ` : ""}
      </section>
    </div>
  `;
}

function renderCalendar(){
  const list = [...state.matches.groupStage, ...state.matches.knockout]
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, 24);
  return `
    <div class="hr"></div>
    <h2>Calendrier (prochains matchs)</h2>
    ${list.map((m) => {
      const info = getMatchDisplayTeams(currentUser(), m);
      return `
        <div class="row" style="justify-content:space-between; border-bottom:1px solid var(--line); padding:6px 0">
          <span>M${m.id} • ${escapeHtml(info.homeLabel)} vs ${escapeHtml(info.awayLabel)}</span>
          <span class="meta">${escapeHtml([m.date, m.time, m.city].filter(Boolean).join(" • ") || "Date à confirmer")}</span>
        </div>
      `;
    }).join("")}
  `;
}

function renderPicksTable(userData, label){
  const allMatches = [...state.matches.groupStage, ...state.matches.knockout].sort((a, b) => a.id - b.id);
  const rows = allMatches.map((m) => {
    const { homeLabel, awayLabel } = getMatchDisplayTeams(userData, m);
    const pickValue = userData.picks?.[String(m.id)] || "-";
    const pickLabel = pickValue === "H" ? "1" : pickValue === "A" ? "2" : pickValue === "D" ? "N" : "-";
    return `
      <tr>
        <td>${m.id}</td>
        <td>${escapeHtml(roundLabel(m.round) || `Groupe ${m.group || "-"}`)}</td>
        <td>${escapeHtml(homeLabel)}</td>
        <td>${escapeHtml(awayLabel)}</td>
        <td><b>${pickLabel}</b></td>
      </tr>
    `;
  }).join("");
  return `
    <div class="table-wrap">
      <table class="picks-table">
        <thead>
          <tr><th>#</th><th>Tour</th><th>Équipe 1</th><th>Équipe 2</th><th>Prono ${escapeHtml(label)}</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function getSelectedLeaderboardUser(){
  const users = state.data.users || {};
  if (!state.selectedLeaderboardUserKey || !users[state.selectedLeaderboardUserKey]) {
    const firstKey = Object.keys(users)[0] || null;
    state.selectedLeaderboardUserKey = firstKey;
  }
  return state.selectedLeaderboardUserKey ? users[state.selectedLeaderboardUserKey] : null;
}

function computeCommunityStats(){
  const users = Object.values(state.data.users || {}).filter((u) => u?.picks && u.tieBreakerSubmittedAt);
  const total = users.length;
  if (!total) return [];

  const targets = [
    { matchId: 97, team: "France", label: "Voient la France en quart (QF 97)" },
    { matchId: 104, team: "Brésil", label: "Voient le Brésil en finale (match 104)" },
    { matchId: 104, team: "France", label: "Voient la France en finale (match 104)" }
  ];
  return targets.map((target) => {
    const count = users.filter((u) => {
      const match = getMatchById(target.matchId);
      if (!match) return false;
      const { homeLabel, awayLabel } = getMatchDisplayTeams(u, match);
      return normalizeName(homeLabel) === normalizeName(target.team) || normalizeName(awayLabel) === normalizeName(target.team);
    }).length;
    return { label: target.label, count, total, rate: Math.round((count / total) * 100) };
  });
}

function normalizeName(value){
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getMatchById(id){
  return [...(state.matches?.groupStage || []), ...(state.matches?.knockout || [])]
    .find((m) => Number(m.id) === Number(id));
}

function getMatchDisplayTeams(userData, match){
  if (!match) return { homeLabel: "À définir", awayLabel: "À définir" };
  if (match.stage !== "KO") {
    return { homeLabel: match.home || "À définir", awayLabel: match.away || "À définir" };
  }
  return {
    homeLabel: resolveKnockoutSlot(match.homeLabel, userData),
    awayLabel: resolveKnockoutSlot(match.awayLabel, userData)
  };
}

function resolveKnockoutSlot(label, userData){
  const fallback = label || "À définir";
  const raw = String(label || "");
  const winnerMatchRef = raw.match(/Vainqueur Match\s*(\d+)/i);
  if (winnerMatchRef) {
    return pickWinnerName(Number(winnerMatchRef[1]), userData) || fallback;
  }
  const loserSemiRef = raw.match(/Perdant Demi\s*(\d+)/i);
  if (loserSemiRef) {
    return pickLoserName(Number(loserSemiRef[1]), userData) || fallback;
  }
  return fallback;
}

function pickWinnerName(matchId, userData){
  const match = getMatchById(matchId);
  if (!match) return null;
  const teams = getMatchDisplayTeams(userData, match);
  const predicted = userData.picks?.[String(matchId)];
  if (predicted === "H") return teams.homeLabel;
  if (predicted === "A") return teams.awayLabel;
  return null;
}

function pickLoserName(matchId, userData){
  const match = getMatchById(matchId);
  if (!match) return null;
  const teams = getMatchDisplayTeams(userData, match);
  const predicted = userData.picks?.[String(matchId)];
  if (predicted === "H") return teams.awayLabel;
  if (predicted === "A") return teams.homeLabel;
  return null;
}

function wireHubControls(){
  for (const el of document.querySelectorAll("[data-hubtab]")){
    el.onclick = () => {
      state.hubTab = el.dataset.hubtab;
      render();
    };
  }
  for (const row of document.querySelectorAll("[data-playerkey]")){
    row.onclick = () => {
      state.selectedLeaderboardUserKey = row.dataset.playerkey;
      state.hubTab = "leaderboard";
      render();
    };
  }
}

function listLiveResults(){
  const all = [...state.matches.groupStage, ...state.matches.knockout]
    .filter(m => Number.isFinite(m.scoreHome) && Number.isFinite(m.scoreAway))
    .slice(0, 12);
  if (!all.length) return "";
  return all.map((m) => {
    const info = getMatchDisplayTeams(currentUser(), m);
    return `
      <div class="row" style="justify-content:space-between; border-bottom:1px solid var(--line); padding:6px 0">
        <span>${escapeHtml(info.homeLabel)} vs ${escapeHtml(info.awayLabel)}</span>
        <b>${m.scoreHome} - ${m.scoreAway}</b>
      </div>
    `;
  }).join("");
}

function computeLeaderboard(){
  const users = Object.entries(state.data.users || {});
  const total = countTotalMatches();
  return users
    .filter(([, u]) => u?.profile)
    .map(([key, u]) => ({
      key,
      label: `${u.profile.firstName} ${u.profile.lastName}${u.profile.nickname ? ` (${u.profile.nickname})` : ""}`,
      done: Object.keys(u.picks || {}).length,
      total
    }))
    .sort((a, b) => b.done - a.done);
}

function roundLabel(r){
  if (!r) return null;
  const map = { R32:"Seizièmes", R16:"Huitièmes", QF:"Quarts", SF:"Demies", BRONZE:"Bronze", FINAL:"Finale" };
  return map[r] || r;
}

/* ---------- Counters & escaping ---------- */

function countTotalMatches(){
  const gs = state.matches?.groupStage?.length || 0;
  const ko = state.matches?.knockout?.length || 0;
  return gs + ko;
}
function countPicks(u){ return Object.keys(u.picks || {}).length; }
function countPicksByStage(u, stage){
  const source = stage === "KO" ? state.matches.knockout : state.matches.groupStage;
  return source.filter(m => u.picks[String(m.id)]).length;
}

function filterMatches(matches){
  const u = currentUser();
  const query = state.filterText.trim().toLowerCase();
  return matches.filter((m) => {
    const isUnpickedOk = !state.showUnpickedOnly || !u.picks[String(m.id)];
    if (!query) return isUnpickedOk;
    const haystack = [
      m.home, m.away, m.homeLabel, m.awayLabel, m.city, m.stadium, m.date, m.group, roundLabel(m.round)
    ].filter(Boolean).join(" ").toLowerCase();
    return isUnpickedOk && haystack.includes(query);
  });
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[c]));
}
function escapeAttr(s){ return escapeHtml(s).replace(/"/g, "&quot;"); }
