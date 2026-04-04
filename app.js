const APP = document.getElementById("app");
const USERBOX = document.getElementById("userBox");

const LS_KEY = "fwc26_pronos_v1";
const DB_NAME = "fwc26_pronos_db";
const DB_STORE = "snapshots";
const DB_RECORD_ID = "latest";

const state = {
  me: null,
  onboardingStep: "welcome", // welcome | app
  view: "picks",
  selectedGroup: "A",
  hubTab: "leaderboard", // leaderboard | myPicks | stats | matches
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

  await hydrateDataStore();
  requestPersistentStorage();

  if (state.data?.lastUserKey) {
    const u = state.data.users?.[state.data.lastUserKey];
    if (u?.profile) {
      state.me = u.profile;
      state.onboardingStep = "app";
    }
  }
  state.selectedGroup = state.teams?.groups?.[0] || "A";
  render();
}

function normalizeMatches(m, teams){
  const providedGroup = Array.isArray(m.groupStage) ? [...m.groupStage] : [];
  const groupStage = buildGroupStageMatches(teams, providedGroup);
  const knockout = Array.isArray(m.knockout)
    ? m.knockout.map((match) => ({
      ...match,
      homeLabel: match.homeLabel ?? match.home ?? null,
      awayLabel: match.awayLabel ?? match.away ?? null
    }))
    : [];
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
      const home = resolveGroupTeamLabel(provided?.home, generatedHome, teamList);
      const away = resolveGroupTeamLabel(provided?.away, generatedAway, teamList);

      groupStage.push({
        id,
        stage: "GROUP",
        group,
        home,
        away,
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

function resolveGroupTeamLabel(providedTeam, generatedTeam, groupTeams){
  if (isPlaceholderTeam(providedTeam)) return generatedTeam;
  if (!isTeamInGroup(providedTeam, groupTeams)) return generatedTeam;
  return providedTeam;
}

function isTeamInGroup(teamName, groupTeams){
  const provided = normalizeName(teamName);
  if (!provided) return false;
  return groupTeams.some((team) => normalizeName(team) === provided);
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
  const fallback = { users:{}, lastUserKey:null, thirdHalf:{ comments:[] }, updatedAt:0 };
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY)) || fallback;
    return normalizeDataShape(parsed);
  }
  catch { return fallback; }
}
function normalizeDataShape(raw){
  const parsed = raw && typeof raw === "object" ? raw : {};
  if (!parsed.thirdHalf || !Array.isArray(parsed.thirdHalf.comments)) {
    parsed.thirdHalf = { comments:[] };
  }
  if (!parsed.users || typeof parsed.users !== "object") parsed.users = {};
  if (!Number.isFinite(Number(parsed.updatedAt))) parsed.updatedAt = 0;
  return parsed;
}

async function hydrateDataStore(){
  const localData = normalizeDataShape(state.data);
  const indexedData = await loadAllFromIndexedDB();
  if (!indexedData) {
    state.data = localData;
    return;
  }
  const pickIndexed = Number(indexedData.updatedAt || 0) > Number(localData.updatedAt || 0);
  state.data = pickIndexed ? indexedData : localData;
  if (pickIndexed) saveAll();
}

function saveAll(){
  state.data.updatedAt = Date.now();
  localStorage.setItem(LS_KEY, JSON.stringify(state.data));
  saveAllToIndexedDB(state.data);
}

function openPronosDb(){
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return resolve(null);
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadAllFromIndexedDB(){
  try {
    const db = await openPronosDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);
      const req = store.get(DB_RECORD_ID);
      req.onsuccess = () => resolve(normalizeDataShape(req.result?.payload || null));
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveAllToIndexedDB(payload){
  try {
    const db = await openPronosDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put({ id: DB_RECORD_ID, payload });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {}
}

function requestPersistentStorage(){
  if (!navigator?.storage?.persist) return;
  navigator.storage.persist().catch(() => {});
}

function ensureUser(){
  const key = userKey(state.me);
  if (!state.data.users[key]) {
    state.data.users[key] = {
      profile: state.me,
      picks: {},          // matchId -> "H" | "D" | "A"
      qualifiers: {},     // group -> { first, second } (optionnel)
      bonusGoals: null,
      groupSubmittedAt: null,
      qualifiersSubmittedAt: null,
      koSubmittedAt: null,
      finalSubmittedAt: null,
      tieBreakerSubmittedAt: null,
      flashLockedAt: null
    };
  }
  sanitizeUserPicks(state.data.users[key]);
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

async function sendPasswordReminder(password, userLabel){
  const message = password
    ? `Mot de passe enregistré pour ${userLabel} : ${password}`
    : `Aucun mot de passe enregistré pour ${userLabel}.`;
  if (typeof Notification !== "undefined") {
    try {
      if (Notification.permission === "granted") {
        new Notification("Rappel mot de passe", { body: message });
      } else if (Notification.permission !== "denied") {
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
          new Notification("Rappel mot de passe", { body: message });
        }
      }
    } catch {}
  }
  alert(message);
}

function pick(matchId, val){
  const u = currentUser();
  const match = getMatchById(matchId);
  if (!match) return;
  if (isFlashLocked(u)) {
    alert("Ta grille flash est verrouillée : relance un flash pour regénérer automatiquement.");
    return;
  }
  if (match.stage === "GROUP" && u.groupSubmittedAt) return;
  if (match.stage === "KO" && u.koSubmittedAt) return;
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
    ? `<button class="profile-trigger" id="profileTrigger" title="Cliquer pour ajouter une photo">
         ${renderAvatar(state.me.profilePhoto, `${state.me.firstName} ${state.me.lastName}`)}
         <span class="user-name">${escapeHtml(state.me.firstName)} ${escapeHtml(state.me.lastName)}${state.me.nickname ? ` (${escapeHtml(state.me.nickname)})` : ""}</span>
         <span class="badge">${escapeHtml(state.me.firstName)} ${escapeHtml(state.me.lastName)}${state.me.nickname ? ` (${escapeHtml(state.me.nickname)})` : ""}</span>
       </button>
       <input id="avatarInput" type="file" accept="image/*" style="display:none" />
       <button class="btn" id="logoutBtn" style="margin-left:10px">Déconnexion</button>`
    : `<div style="display:flex; justify-content:center; width:100%"><span class="badge">Non connecté</span></div>`;

  if (state.me) {
    queueMicrotask(()=>{
      const b = document.getElementById("logoutBtn");
      if (b) b.onclick = logout;
      const trigger = document.getElementById("profileTrigger");
      const avatarInput = document.getElementById("avatarInput");
      if (trigger && avatarInput) {
        trigger.onclick = () => avatarInput.click();
        avatarInput.onchange = (e) => handleAvatarUpload(e.target.files?.[0]);
      }
    });
  }

  if (!state.me && state.onboardingStep === "welcome") return renderWelcome();
  return renderApp();
}

function renderWelcome(){
  APP.innerHTML = `
    <section class="grid two">
      <article class="card auth-card">
        <h1>Première connexion</h1>
        <p>Entre ton nom, prénom et un mot de passe pour créer ton compte.</p>
        <div class="row">
          <div class="field">
            <label>Prénom</label>
            <input id="signupFirstName" placeholder="Ex: Karim" autocomplete="given-name" />
          </div>
          <div class="field">
            <label>Nom</label>
            <input id="signupLastName" placeholder="Ex: Benzema" autocomplete="family-name" />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Mot de passe</label>
            <input id="signupPassword" type="password" placeholder="••••••••" autocomplete="new-password" />
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="signupBtn">Entrer dans le tournoi</button>
        </div>
      </article>
      <article class="card auth-card">
        <h1>Ah mais t'es là toi</h1>
        <p>Reconnecte-toi avec ton nom, prénom et mot de passe.</p>
        <div class="row">
          <div class="field">
            <label>Prénom</label>
            <input id="loginFirstName" placeholder="Ex: Karim" autocomplete="given-name" />
          </div>
          <div class="field">
            <label>Nom</label>
            <input id="loginLastName" placeholder="Ex: Benzema" autocomplete="family-name" />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Mot de passe</label>
            <input id="loginPassword" type="password" placeholder="••••••••" autocomplete="current-password" />
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="loginBtn">J'y retourne</button>
          <button class="btn alt" id="forgotPwdBtn" type="button">Mot de passe oublié ?</button>
        </div>
      </article>
    </section>
    <small>Les comptes sont uniques : même prénom + nom = même compte.</small>
  `;

  document.getElementById("signupBtn").onclick = () => {
    const firstName = document.getElementById("signupFirstName").value.trim();
    const lastName  = document.getElementById("signupLastName").value.trim();
    const password = document.getElementById("signupPassword").value;
    if (!firstName || !lastName || !password) return alert("Merci de compléter prénom, nom et mot de passe.");
    const profile = { firstName, lastName, nickname: "" };
    const key = userKey(profile);
    const existing = state.data.users?.[key];
    if (existing) return alert("Ce compte existe déjà. Utilise “J'y retourne” pour te reconnecter.");
    setUser(profile);
    state.data.users[key].password = password;
    saveAll();
    render();
  };

  document.getElementById("loginBtn").onclick = () => {
    const firstName = document.getElementById("loginFirstName").value.trim();
    const lastName  = document.getElementById("loginLastName").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (!firstName || !lastName || !password) return alert("Merci de compléter prénom, nom et mot de passe.");
    const key = userKey({ firstName, lastName });
    const existing = state.data.users?.[key];
    if (!existing) return alert("Nom/prénom inconnu. Vérifie la saisie (majuscules/minuscules ignorées).");
    if ((existing.password || "") !== password) return alert("Mot de passe incorrect.");
    state.me = existing.profile;
    state.onboardingStep = "app";
    state.data.lastUserKey = key;
    saveAll();
    render();
  };

  document.getElementById("forgotPwdBtn").onclick = () => {
    const firstName = document.getElementById("loginFirstName").value.trim();
    const lastName  = document.getElementById("loginLastName").value.trim();
    if (!firstName || !lastName) return alert("Indique d'abord prénom + nom pour retrouver ton mot de passe.");
    const key = userKey({ firstName, lastName });
    const existing = state.data.users?.[key];
    if (!existing) return alert("Nom/prénom inconnu. Impossible de retrouver le mot de passe.");
    sendPasswordReminder(existing.password || "", `${firstName} ${lastName}`);
  };
}

function renderApp(){
  const u = currentUser();
  const isContestMode = Boolean(u.tieBreakerSubmittedAt);
  APP.innerHTML = isContestMode ? renderTournamentHub() : renderPredictionJourney();
  wireMatchButtons();
  wireHubControls();
}

function renderPredictionJourney(){
  const u = currentUser();
  const total = countTotalMatches();
  const done = countPicks(u);
  const groupTotal = state.matches.groupStage.length;
  const groupDone = countPicksByStage(u, "GROUP");
  const koTotal = state.matches.knockout.length;
  const koDone = countPicksByStage(u, "KO");
  const flashLocked = isFlashLocked(u);

  return `
    <section class="card">
      <h1>Fais tes pronostics Coupe du Monde 2026</h1>
      <p><b>Barème rapide :</b> Poules bon résultat = 1 pt, 32e = 2 pts, 16e = 4 pts, 8e = 8 pts, 1/4 = 16 pts, 1/2 = 32 pts, Finale vainqueur = 64 pts.</p>
      <div class="progress"><div class="progress-bar" style="width:${Math.round((done / total) * 100)}%"></div></div>
      <small>${done}/${total} matchs complétés.</small>
    </section>
    <section class="card" style="margin-top:12px">
      <div class="tabs">
        <div class="tab ${state.view==="picks"?"active":""}" data-view="picks">Saisie des matchs</div>
        <div class="tab ${state.view==="overview"?"active":""}" data-view="overview">Récap poules & tableau</div>
      </div>
      ${state.view === "overview" ? renderOverview() : `
        <h2>1) Phase de groupes</h2>
        <p>Pronostique d'abord les poules, groupe par groupe, puis continue vers les phases finales.</p>
        <div class="row" style="margin-top:12px">
          <button class="btn alt" id="flashGridBtn">${flashLocked ? "⚡ Relancer une grille flash" : "⚡ J’ai la flemme, je lance une grille flash"}</button>
        </div>
        ${flashLocked ? `<small>Grille flash active : les choix manuels sont verrouillés. Tu peux relancer un flash autant de fois que tu veux avant validation.</small>` : ""}
        <div class="hr"></div>
        ${renderGroups()}
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="submitGroupsBtn" ${groupDone === groupTotal && !u.groupSubmittedAt ? "" : "disabled"}>Continuer vers les phases finales</button>
        </div>
        <div class="group-progress">
          <div class="progress"><div class="progress-bar" style="width:${Math.round((groupDone / Math.max(1, groupTotal)) * 100)}%"></div></div>
          <small>Progression poules : ${groupDone}/${groupTotal}</small>
        </div>
        <div class="hr"></div>
        <h2>2) Phases finales</h2>
        ${u.groupSubmittedAt ? renderKO() : `<p><small>Valide d'abord les matchs de poules (${groupDone}/${groupTotal}).</small></p>`}
        <div class="row" style="margin-top:12px">
          <button class="btn danger" id="submitKOBtn" ${u.groupSubmittedAt && koDone === koTotal && !u.koSubmittedAt ? "" : "disabled"}>Je valide définitivement</button>
        </div>
        <small>Après ce clic, aucun retour arrière possible.</small>
      `}
    </section>
    <section class="card" style="margin-top:12px">
      <h2>3) Question subsidiaire</h2>
      ${u.koSubmittedAt ? `
        <p>Combien de buts seront marqués sur toute la compétition ?</p>
        <div class="row">
          <div class="field" style="max-width:220px">
            <input id="bonusGoals" type="number" min="0" value="${Number.isFinite(u.bonusGoals) ? u.bonusGoals : ""}" />
          </div>
          <button class="btn primary" id="submitBonusBtn" ${u.tieBreakerSubmittedAt ? "disabled" : ""}>Valider la question subsidiaire</button>
        </div>
        ${u.tieBreakerSubmittedAt ? `<p><b>✅ Ton prono a bien été enregistré.</b></p>` : ""}
      ` : `<p><small>Disponible après “Je valide définitivement”.</small></p>`}
    </section>
  `;
}

function renderTournamentHub(){
  return `
    <section class="card">
      <h1>Tournoi en direct — Coupe du Monde FIFA 2026</h1>
      <p>Retrouve ici le classement des joueurs, les tendances statistiques et les matchs sur un onglet dédié.</p>
    </section>
    <section class="card" style="margin-top:12px">
      <div class="tabs">
        <div class="tab ${state.hubTab==="matches"?"active":""}" data-hubtab="matches">Matchs</div>
        <div class="tab ${state.hubTab==="leaderboard"?"active":""}" data-hubtab="leaderboard">Classement</div>
        <div class="tab ${state.hubTab==="stats"?"active":""}" data-hubtab="stats">Statistiques</div>
        <div class="tab ${state.hubTab==="myPicks"?"active":""}" data-hubtab="myPicks">Ma grille</div>
        <div class="tab ${state.hubTab==="thirdHalf"?"active":""}" data-hubtab="thirdHalf">3ème mi-temps</div>
      </div>
      ${state.hubTab === "matches" ? renderTournamentMatchesCenter() : ""}
      ${state.hubTab === "matches" ? `<div class="hr"></div>` : ""}
      ${state.hubTab === "leaderboard" ? renderLeaderboardView() : ""}
      ${state.hubTab === "stats" ? renderStatsView() : ""}
      ${state.hubTab === "myPicks" ? renderPicksTable(currentUser(), "Moi") : ""}
      ${state.hubTab === "thirdHalf" ? renderThirdHalfView() : ""}
    </section>
  `;
}

function renderOverview(){
  const groups = state.teams.groups;
  const u = currentUser();
  const standings = computeGroupStandingsFromPicks(u);
  const teamRows = groups.map((g) => {
    const rows = (standings[g] || []).slice(0, 4);
    return `
      <article class="group-card">
        <h3>Groupe ${escapeHtml(g)}</h3>
        <div class="group-team-list">
          ${rows.map((r, idx) => `
            <div class="group-team-row">
              <span class="group-team-rank">${idx + 1}</span>
              <span class="flag">${getTeamFlag(r.team)}</span>
              <span class="group-team-name">${escapeHtml(r.team)}</span>
              <span class="group-team-points">${r.pts} pts</span>
            </div>
          `).join("")}
        </div>
      </article>
    `;
  }).join("");
  return `
    <div class="grid" style="gap:14px">
      <section>
        <h2>Récapitulatif des poules</h2>
        <div class="groups-visual-grid">${teamRows}</div>
      </section>
      <section>
        <h2>Structure des phases finales</h2>
        ${renderBracketColumns(u)}
      </section>
    </div>
  `;
}

function renderGroups(){
  const groups = state.teams.groups;
  const gs = state.matches.groupStage;
  const selectedGroup = groups.includes(state.selectedGroup) ? state.selectedGroup : groups[0];
  const matches = filterMatches(gs.filter((m) => m.group === selectedGroup));
  let html = "";

  html += `<div class="tabs compact-tabs">${groups.map((g) => `<div class="tab ${selectedGroup===g?"active":""}" data-group="${g}">Groupe ${g}</div>`).join("")}</div>`;
  html += `<h2>Groupe ${selectedGroup}</h2>`;

  if (!matches.length){
    html += `<p><small>${state.filterText || state.showUnpickedOnly ? "Aucun match ne correspond aux filtres." : "Aucun match listé pour ce groupe (à compléter dans data/matches.json)."}</small></p>`;
  } else {
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
  return `
    <p>Tableau final face-à-face (entonnoir). Choisis le qualifié de chaque duel.</p>
    ${renderBracketFunnel(currentUser(), true)}
  `;
}

function renderBracketFunnel(userData, allowEditing){
  const rounds = ["R32", "R16", "QF", "SF", "BRONZE", "FINAL"];
  const labels = {
    R32: "Seizièmes",
    R16: "Huitièmes",
    QF: "Quarts",
    SF: "Demi-finales",
    BRONZE: "Petite finale",
    FINAL: "Finale"
  };
  const globalLocked = isFlashLocked(userData) || userData.finalSubmittedAt;
  const ko = (state.matches.knockout || []).slice().sort((a, b) => a.id - b.id);
  if (!ko.length) return `<p><small>Aucun match KO listé.</small></p>`;

  return `
    <div class="bracket-funnel">
      ${rounds.map((round) => {
        const matches = ko.filter((m) => m.round === round);
        if (!matches.length) return "";
        return `
          <section class="funnel-round">
            <h3>${labels[round] || round}</h3>
            ${matches.map((m) => {
              const pickValue = userData.picks?.[String(m.id)] || "";
              const teams = getMatchDisplayTeams(userData, m);
              const disablePicks = !allowEditing || globalLocked;
              return `
                <article class="funnel-match" data-matchid="${m.id}">
                  <div class="meta" style="text-align:center"><b>${escapeHtml(roundLabel(m.round) || round)} • Match ${m.id}</b> • ${escapeHtml([m.date, m.time, m.city].filter(Boolean).join(" • ") || "Date à confirmer")}</div>
                  <div class="match-duel">
                    <span class="team-chip">${getTeamFlag(teams.homeLabel)} ${escapeHtml(teams.homeLabel)}</span>
                    <span class="vs-chip">VS</span>
                    <span class="team-chip">${getTeamFlag(teams.awayLabel)} ${escapeHtml(teams.awayLabel)}</span>
                  </div>
                  <div class="picks picks-labels">
                    <button class="pick pick-label ${pickValue==="H"?"active":""}" data-pick="H" ${disablePicks ? "disabled" : ""}>${getTeamFlag(teams.homeLabel)} ${escapeHtml(teams.homeLabel)}</button>
                    <button class="pick pick-label ${pickValue==="A"?"active":""}" data-pick="A" ${disablePicks ? "disabled" : ""}>${getTeamFlag(teams.awayLabel)} ${escapeHtml(teams.awayLabel)}</button>
                  </div>
                </article>
              `;
            }).join("")}
          </section>
        `;
      }).join("")}
    </div>
  `;
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

function renderLeaderboardView(){
  const rankings = computeLeaderboard();
  const selectedUser = getSelectedLeaderboardUser();
  if (!rankings.length) return `<p>Aucun joueur enregistré pour le moment.</p>`;
  return `
    <div class="leaderboard-card">
      <table class="leaderboard-table">
        <thead>
          <tr><th>Position</th><th>Joueur</th><th>Points</th><th>Équipe favorite</th></tr>
        </thead>
        <tbody>
          ${rankings.map((r, idx) => `
            <tr class="${state.selectedLeaderboardUserKey === r.key ? "active" : ""}" data-playerkey="${escapeAttr(r.key)}">
              <td class="leaderboard-rank">${idx + 1}</td>
              <td><span class="player-inline">${renderAvatar(r.profilePhoto, r.label)} ${escapeHtml(r.label)}</span></td>
              <td><b>${r.points}</b> pts</td>
              <td title="${escapeAttr(r.favoriteTeam || "Non défini")}">${r.favoriteFlag} ${escapeHtml(r.favoriteTeam || "—")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${selectedUser ? `
      <div class="hr"></div>
      ${renderPicksTable(selectedUser, `${selectedUser.profile.firstName} ${selectedUser.profile.lastName}`, { title: `Les pronos de ${selectedUser.profile.firstName} ${selectedUser.profile.lastName}` })}
    ` : ""}
  `;
}

function renderStatsView(){
  const todayStats = computeTodayMatchStats();
  const roundStats = computeRoundWinnerStats();
  if (!todayStats.length && !roundStats.length) return `<p>Aucune statistique disponible pour le moment.</p>`;
  return `
    <h2>Matchs du jour</h2>
    ${todayStats.length ? todayStats.map((item) => `
      <div class="row" style="justify-content:space-between; border-bottom:1px solid var(--line); padding:8px 0">
        <span>${escapeHtml(item.match)}</span>
        <span class="badge a2">${escapeHtml(item.breakdown)}</span>
      </div>
    `).join("") : `<small>Aucun match daté aujourd'hui.</small>`}
    <div class="hr"></div>
    <h2>Tendances par phase finale</h2>
    ${roundStats.map((item) => `
      <div style="margin-bottom:10px">
        <div class="round-title">${escapeHtml(item.round)}</div>
        ${item.teams.map((team) => `
          <div class="row" style="justify-content:space-between; border-bottom:1px solid var(--line); padding:6px 0">
            <span>${getTeamFlag(team.name)} ${escapeHtml(team.name)}</span>
            <span class="badge">${team.rate}%</span>
          </div>
        `).join("")}
      </div>
    `).join("")}
  `;
}

function renderThirdHalfView(){
  const comments = getThirdHalfComments();
  return `
    <h2>3ème mi-temps</h2>
    <p>Laisse un commentaire, ajoute une photo et réagis aux posts des autres 🔥</p>
    <div class="card" style="padding:12px; margin-bottom:12px">
      <div class="field">
        <label>Ton commentaire</label>
        <textarea id="thirdHalfText" rows="3" placeholder="Ex: Je le sentais ce but à la 89e 😎"></textarea>
      </div>
      <div class="row" style="margin-top:10px">
        <input id="thirdHalfPhoto" type="file" accept="image/*" />
        <button class="btn primary" id="thirdHalfPostBtn">Publier</button>
      </div>
      <small>Les messages restent enregistrés à chaque reconnexion.</small>
    </div>
    ${comments.length ? comments.map((comment) => renderThirdHalfComment(comment)).join("") : `<small>Aucun commentaire pour l'instant.</small>`}
  `;
}

function renderThirdHalfComment(comment){
  const me = state.me ? userKey(state.me) : "";
  const likes = Object.keys(comment.likes || {}).length;
  const liked = Boolean(comment.likes?.[me]);
  const date = new Date(comment.createdAt);
  const displayDate = Number.isNaN(date.getTime()) ? "Date inconnue" : date.toLocaleString("fr-FR");
  return `
    <article class="card" style="padding:12px; margin-bottom:10px">
      <div class="row" style="justify-content:space-between">
        <b>${escapeHtml(comment.authorLabel)}</b>
        <span class="meta">${escapeHtml(displayDate)}</span>
      </div>
      <p style="margin-top:6px">${escapeHtml(comment.text)}</p>
      ${comment.photoDataUrl ? `<img src="${escapeAttr(comment.photoDataUrl)}" alt="Photo commentaire" style="max-width:220px; border-radius:10px; border:1px solid var(--line);" />` : ""}
      <div class="row" style="margin-top:8px">
        <button class="btn alt" data-like-comment="${escapeAttr(comment.id)}">${liked ? "💙 Je n'aime plus" : "👍 J'aime"}</button>
        <span class="badge">${likes} like${likes > 1 ? "s" : ""}</span>
      </div>
    </article>
  `;
}

function renderTournamentMatchesCenter(){
  const all = [...state.matches.groupStage, ...state.matches.knockout].sort((a, b) => a.id - b.id);
  const past = all.filter((m) => Number.isFinite(m.scoreHome) && Number.isFinite(m.scoreAway)).slice(-8).reverse();
  const upcoming = all.filter((m) => !Number.isFinite(m.scoreHome) || !Number.isFinite(m.scoreAway)).slice(0, 8);
  const renderList = (list, withScore) => list.length ? list.map((m) => {
    const info = getMatchDisplayTeams(currentUser(), m);
    const schedule = [m.date, m.time].filter(Boolean).join(" • ");
    return `
      <div>
        <div class="match-card">
          <span class="team-col">${getTeamFlag(info.homeLabel)} ${escapeHtml(info.homeLabel)}</span>
          <b class="vs-col">${withScore ? `${m.scoreHome} - ${m.scoreAway}` : "vs"}</b>
          <span class="team-col">${getTeamFlag(info.awayLabel)} ${escapeHtml(info.awayLabel)}</span>
        </div>
        ${!withScore ? `<div class="meta">${escapeHtml(schedule || "Date/heure à confirmer")}</div>` : ""}
      <div class="match-card">
        <span class="team-col">${getTeamFlag(info.homeLabel)} ${escapeHtml(info.homeLabel)}</span>
        <b class="vs-col">${withScore ? `${m.scoreHome} - ${m.scoreAway}` : "vs"}</b>
        <span class="team-col">${getTeamFlag(info.awayLabel)} ${escapeHtml(info.awayLabel)}</span>
      </div>
    `;
  }).join("") : `<small>Aucun match pour le moment.</small>`;

  return `
    <div class="grid two" style="margin-top:10px">
      <div>
        <h2>Matchs passés</h2>
        ${renderList(past, true)}
      </div>
      <div>
        <h2>Matchs à venir / en direct</h2>
        ${renderList(upcoming, false)}
      </div>
    </div>
  `;
}

function handleAvatarUpload(file){
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    alert("Merci de choisir un fichier image.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const u = currentUser();
    if (!u) return;
    const dataUrl = String(reader.result || "");
    u.profilePhoto = dataUrl;
    if (u.profile) u.profile.profilePhoto = dataUrl;
    if (state.me) state.me.profilePhoto = dataUrl;
    saveAll();
    render();
  };
  reader.readAsDataURL(file);
}

function renderAvatar(photoDataUrl, alt){
  if (photoDataUrl) {
    return `<img class="avatar-bubble" src="${escapeAttr(photoDataUrl)}" alt="${escapeAttr(alt || "Photo profil")}" />`;
  }
  return `<span class="avatar-bubble avatar-fallback">${escapeHtml(String(alt || "?").slice(0, 1).toUpperCase())}</span>`;
}

/* ---------- UI helpers ---------- */

function matchRow(m){
  const u = currentUser();
  const v = u.picks[String(m.id)] || "";
  const locked = Boolean(u.finalSubmittedAt || isFlashLocked(u));
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
      <div class="meta">${escapeHtml(meta)}</div>
      <div class="match-duel">
        <span class="team-chip">${getTeamFlag(homeLabel)} ${escapeHtml(homeLabel)}</span>
        <span class="vs-chip">VS</span>
        <span class="team-chip">${getTeamFlag(awayLabel)} ${escapeHtml(awayLabel)}</span>
      </div>
      <div class="picks picks-labels">
        <button class="pick pick-label ${v==="H"?"active":""}" data-pick="H" title="Victoire ${escapeAttr(homeLabel)}" ${locked ? "disabled" : ""}>${getTeamFlag(homeLabel)} ${escapeHtml(homeLabel)}</button>
        ${isKO ? "" : `<button class="pick pick-label ${v==="D"?"active":""}" data-pick="D" title="Match nul" ${locked ? "disabled" : ""}>🤝 Nul</button>`}
        <button class="pick pick-label ${v==="A"?"active":""}" data-pick="A" title="Victoire ${escapeAttr(awayLabel)}" ${locked ? "disabled" : ""}>${getTeamFlag(awayLabel)} ${escapeHtml(awayLabel)}</button>
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
  for (const el of document.querySelectorAll(".funnel-match")){
    const id = Number(el.dataset.matchid);
    for (const b of el.querySelectorAll(".pick")){
      b.onclick = () => pick(id, b.dataset.pick);
    }
  }

  const finalBtn = document.getElementById("finalBtn");
  if (finalBtn) finalBtn.onclick = () => submitFinalPicks();
  const submitGroupsBtn = document.getElementById("submitGroupsBtn");
  if (submitGroupsBtn) submitGroupsBtn.onclick = () => submitGroupStage();
  const flashGridBtn = document.getElementById("flashGridBtn");
  if (flashGridBtn) flashGridBtn.onclick = () => generateFlashGrid();
  const submitQualifiersBtn = document.getElementById("submitQualifiersBtn");
  if (submitQualifiersBtn) submitQualifiersBtn.onclick = () => submitQualifiersStage();
  const submitKOBtn = document.getElementById("submitKOBtn");
  if (submitKOBtn) submitKOBtn.onclick = () => submitKOStage();
  const submitBonusBtn = document.getElementById("submitBonusBtn");
  if (submitBonusBtn) submitBonusBtn.onclick = () => submitTieBreaker();
  const bonusInput = document.getElementById("bonusGoals");
  if (bonusInput) bonusInput.oninput = (e) => setBonusGoals(e.target.value);
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

function submitGroupStage(){
  const u = currentUser();
  const total = state.matches.groupStage.length;
  const done = countPicksByStage(u, "GROUP");
  if (done !== total) {
    const missingIds = state.matches.groupStage
      .filter((m) => !u.picks?.[String(m.id)])
      .map((m) => m.id);
    return alert(`Il manque ${total - done} match(s) de poules. Matchs à pronostiquer : ${missingIds.join(", ")}.`);
  }
  u.groupSubmittedAt = new Date().toISOString();
  saveAll();
  render();
}

function submitQualifiersStage(){
  const u = currentUser();
  for (const group of state.teams.groups || []){
    const q = u.qualifiers[group];
    if (!q?.first || !q?.second) return alert(`Complète les qualifiés du groupe ${group}.`);
    if (q.first === q.second) return alert(`Le groupe ${group} doit avoir 2 équipes différentes.`);
  }
  u.qualifiersSubmittedAt = new Date().toISOString();
  saveAll();
  render();
}

function submitKOStage(){
  const u = currentUser();
  const total = state.matches.knockout.length;
  const done = countPicksByStage(u, "KO");
  if (done !== total) {
    const missingIds = state.matches.knockout
      .filter((m) => {
        const p = u.picks?.[String(m.id)];
        return p !== "H" && p !== "A";
      })
      .map((m) => m.id);
    return alert(`Il manque ${total - done} match(s) en phase finale. Matchs à pronostiquer : ${missingIds.join(", ")}.`);
  }
  const now = new Date().toISOString();
  u.koSubmittedAt = now;
  u.finalSubmittedAt = now;
  alert("Ta grille est validée ✅ Tu peux maintenant répondre à la question subsidiaire pour finaliser ton enregistrement.");
  saveAll();
  render();
}

function submitTieBreaker(){
  const u = currentUser();
  if (!u.koSubmittedAt) return;
  if (!Number.isFinite(u.bonusGoals)) {
    alert("Entre un nombre valide pour la question subsidiaire.");
    return;
  }
  u.tieBreakerSubmittedAt = new Date().toISOString();
  state.selectedLeaderboardUserKey = userKey(u.profile);
  state.hubTab = "matches";
  alert("Ton prono a bien été enregistré ✅");
  saveAll();
  window.scrollTo({ top: 0, behavior: "smooth" });
  render();
}

function getThirdHalfComments(){
  return (state.data.thirdHalf?.comments || [])
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function submitThirdHalfComment(){
  const input = document.getElementById("thirdHalfText");
  const fileInput = document.getElementById("thirdHalfPhoto");
  const text = (input?.value || "").trim();
  const file = fileInput?.files?.[0];
  if (!text) {
    alert("Écris un commentaire avant de publier.");
    return;
  }
  const publish = (photoDataUrl = "") => {
    const me = currentUser();
    if (!me?.profile) return;
    const key = userKey(me.profile);
    if (!state.data.thirdHalf) state.data.thirdHalf = { comments:[] };
    state.data.thirdHalf.comments.push({
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userKey: key,
      authorLabel: `${me.profile.firstName} ${me.profile.lastName}`,
      text,
      photoDataUrl,
      createdAt: new Date().toISOString(),
      likes: {}
    });
    saveAll();
    render();
  };
  if (!file) return publish();
  if (!file.type.startsWith("image/")) {
    alert("Merci de sélectionner une image valide.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => publish(String(reader.result || ""));
  reader.readAsDataURL(file);
}

function toggleCommentLike(commentId){
  const me = currentUser();
  if (!me?.profile || !commentId) return;
  const comments = state.data.thirdHalf?.comments;
  if (!comments) return;
  const key = userKey(me.profile);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return;
  if (!comment.likes) comment.likes = {};
  if (comment.likes[key]) delete comment.likes[key];
  else comment.likes[key] = true;
  saveAll();
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
            ${renderPicksTable(selectedUser, selectedUserLabel, { title: `Les pronos de ${selectedUserLabel}` })}
          ` : ""}
        ` : ""}
        ${state.hubTab === "myPicks" ? `
          ${renderPicksTable(currentUser(), "moi", { title: "Mes pronos" })}
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

function renderPicksTable(userData, label, options = {}){
  const title = options.title || `Les pronos de ${label}`;
function renderPicksTable(userData, label){
  const groupMatches = (state.matches.groupStage || []).slice().sort((a, b) => a.id - b.id);
  const groupedByLetter = new Map();
  for (const m of groupMatches){
    if (!groupedByLetter.has(m.group)) groupedByLetter.set(m.group, []);
    groupedByLetter.get(m.group).push(m);
  }

  const groupBlocks = [...groupedByLetter.entries()].map(([group, matches]) => `
    <article class="group-card pick-group-card">
    <article class="group-card">
      <h3>Groupe ${escapeHtml(group)}</h3>
      <div class="group-team-list">
        ${matches.map((m) => {
          const teams = getMatchDisplayTeams(userData, m);
          const pickValue = userData.picks?.[String(m.id)] || "-";
          const homeWinnerClass = pickValue === "H" ? "predicted-winner" : "";
          const awayWinnerClass = pickValue === "A" ? "predicted-winner" : "";
          const drawClass = pickValue === "D" ? "predicted-draw" : "";
          return `
            <div class="group-team-row pick-duel-row">
              <span class="group-team-name pick-team-name ${homeWinnerClass}">${getTeamFlag(teams.homeLabel)} ${escapeHtml(teams.homeLabel)}</span>
              <span class="vs-chip ${drawClass}">${pickValue === "D" ? "Nul" : "vs"}</span>
              <span class="group-team-name pick-team-name ${awayWinnerClass}">${getTeamFlag(teams.awayLabel)} ${escapeHtml(teams.awayLabel)}</span>
          const pickLabel = pickValue === "H" ? "1" : pickValue === "A" ? "2" : pickValue === "D" ? "N" : "-";
          return `
            <div class="group-team-row">
              <span class="group-team-name">${getTeamFlag(teams.homeLabel)} ${escapeHtml(teams.homeLabel)}</span>
              <span class="vs-chip">vs</span>
              <span class="group-team-name">${getTeamFlag(teams.awayLabel)} ${escapeHtml(teams.awayLabel)}</span>
              <span class="badge">${pickLabel}</span>
            </div>
          `;
        }).join("")}
      </div>
    </article>
  `).join("");

  return `
    <section>
      <h2>${escapeHtml(title)}</h2>
      <div class="groups-visual-grid picks-groups-grid">${groupBlocks}</div>
      <h2>Vue d'ensemble de la grille — ${escapeHtml(label)}</h2>
      <div class="groups-visual-grid">${groupBlocks}</div>
    </section>
    <div class="hr"></div>
    <section>
      <h2>Tableau final en entonnoir</h2>
      ${renderBracketFunnel(userData, false)}
    </section>
  `;
}

function getSelectedLeaderboardUser(){
  const users = state.data.users || {};
  const rankingKeys = computeLeaderboard().map((r) => r.key);
  if (!state.selectedLeaderboardUserKey || !rankingKeys.includes(state.selectedLeaderboardUserKey)) {
    const firstKey = rankingKeys[0] || null;
    state.selectedLeaderboardUserKey = firstKey;
  }
  return state.selectedLeaderboardUserKey ? users[state.selectedLeaderboardUserKey] : null;
}

function computeCommunityStats(){
  const users = Object.values(state.data.users || {}).filter((u) => u?.picks);
  const total = users.length;
  if (!total) return [];
  const finalMatch = getMatchById(104);
  if (!finalMatch) return [];
  const winnerCounts = new Map();
  for (const u of users){
    const predicted = u.picks?.["104"];
    const teams = getMatchDisplayTeams(u, finalMatch);
    const winner = predicted === "H" ? teams.homeLabel : predicted === "A" ? teams.awayLabel : null;
    if (!winner) continue;
    winnerCounts.set(winner, (winnerCounts.get(winner) || 0) + 1);
  }
  const topWinners = [...winnerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([team, count]) => ({
      label: `Voient ${team} vainqueur de la Coupe du Monde`,
      count, total, rate: Math.round((count / total) * 100)
    }));

  const fullyCompleted = users.filter((u) => countPicks(u) === countTotalMatches()).length;
  topWinners.push({
    label: "Joueurs ayant rempli toute leur grille",
    count: fullyCompleted,
    total,
    rate: Math.round((fullyCompleted / total) * 100)
  });
  return topWinners;
}

function normalizeName(value){
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getTeamFlag(teamName){
  const key = normalizeName(teamName);
  const flags = {
    mexique: "🇲🇽",
    "afrique du sud": "🇿🇦",
    "republique de coree": "🇰🇷",
    "tchequie": "🇨🇿",
    "bosnie-et-herzegovine": "🇧🇦",
    suisse: "🇨🇭",
    bresil: "🇧🇷",
    haiti: "🇭🇹",
    ecosse: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
    "etats-unis": "🇺🇸",
    turquie: "🇹🇷",
    allemagne: "🇩🇪",
    "cote d'ivoire": "🇨🇮",
    equateur: "🇪🇨",
    "pays-bas": "🇳🇱",
    japon: "🇯🇵",
    suede: "🇸🇪",
    egypte: "🇪🇬",
    "nouvelle-zelande": "🇳🇿",
    espagne: "🇪🇸",
    "cap-vert": "🇨🇻",
    "arabie saoudite": "🇸🇦",
    senegal: "🇸🇳",
    irak: "🇮🇶",
    tunisie: "🇹🇳",
    norvege: "🇳🇴",
    argentine: "🇦🇷",
    algerie: "🇩🇿",
    australie: "🇦🇺",
    autriche: "🇦🇹",
    belgique: "🇧🇪",
    colombie: "🇨🇴",
    croatie: "🇭🇷",
    jordanie: "🇯🇴",
    maroc: "🇲🇦",
    "rd congo": "🇨🇩",
    ouzbekistan: "🇺🇿",
    angleterre: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
    panama: "🇵🇦",
    mexico: "🇲🇽",
    "south africa": "🇿🇦",
    "korea republic": "🇰🇷",
    canada: "🇨🇦",
    qatar: "🇶🇦",
    switzerland: "🇨🇭",
    brazil: "🇧🇷",
    morocco: "🇲🇦",
    haiti: "🇭🇹",
    scotland: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
    usa: "🇺🇸",
    paraguay: "🇵🇾",
    australia: "🇦🇺",
    germany: "🇩🇪",
    curacao: "🇨🇼",
    "cote d’ivoire": "🇨🇮",
    "cote d'ivoire": "🇨🇮",
    ecuador: "🇪🇨",
    netherlands: "🇳🇱",
    japan: "🇯🇵",
    tunisia: "🇹🇳",
    belgium: "🇧🇪",
    egypt: "🇪🇬",
    iran: "🇮🇷",
    "new zealand": "🇳🇿",
    spain: "🇪🇸",
    "cabo verde": "🇨🇻",
    "saudi arabia": "🇸🇦",
    uruguay: "🇺🇾",
    france: "🇫🇷",
    senegal: "🇸🇳",
    norway: "🇳🇴",
    argentina: "🇦🇷",
    algeria: "🇩🇿",
    austria: "🇦🇹",
    jordan: "🇯🇴",
    portugal: "🇵🇹",
    uzbekistan: "🇺🇿",
    colombia: "🇨🇴",
    england: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
    croatia: "🇭🇷",
    ghana: "🇬🇭",
    panama: "🇵🇦"
  };
  if (flags[key]) return flags[key];
  if (key.startsWith("winner play-off")) return "🟦";
  return "⚽";
}

function getMatchById(id){
  return [...(state.matches?.groupStage || []), ...(state.matches?.knockout || [])]
    .find((m) => Number(m.id) === Number(id));
}

function sanitizeUserPicks(userData){
  if (!userData?.picks || !state.matches) return;
  const validIds = new Set([
    ...(state.matches.groupStage || []).map((m) => String(m.id)),
    ...(state.matches.knockout || []).map((m) => String(m.id))
  ]);
  for (const [matchId, value] of Object.entries(userData.picks)){
    const match = getMatchById(matchId);
    const isValidPick = value === "H" || value === "A" || (!match || match.stage === "GROUP") && value === "D";
    if (!validIds.has(String(matchId)) || !isValidPick) {
      delete userData.picks[matchId];
    }
  }
}


function renderBracketColumns(userData){
  const ko = (state.matches.knockout || []).slice().sort((a, b) => a.id - b.id);
  const rounds = [
    { key: "R32", label: "Seizièmes" },
    { key: "R16", label: "Huitièmes" },
    { key: "QF", label: "Quarts de finale" },
    { key: "SF", label: "Demi-finales" },
    { key: "FINAL", label: "Finale" },
    { key: "BRONZE", label: "3e place" }
  ];

  const columns = rounds.map((round) => {
    const items = ko.filter((m) => m.round === round.key);
    return `
      <section class="bracket-column">
        <h3>${round.label}</h3>
        <div class="bracket-column-matches">
          ${items.map((m) => {
            const teams = getMatchDisplayTeams(userData, m);
            return `
              <article class="bracket-slot">
                <div class="slot-team">${getTeamFlag(teams.homeLabel)} ${escapeHtml(teams.homeLabel)}</div>
                <div class="slot-team">${getTeamFlag(teams.awayLabel)} ${escapeHtml(teams.awayLabel)}</div>
              </article>
            `;
          }).join("") || `<small>Aucun match</small>`}
        </div>
      </section>
    `;
  }).join("");

  return `<div class="bracket-columns">${columns}</div>`;
}

function renderBracketTable(userData){
  const ko = (state.matches.knockout || []).slice().sort((a, b) => a.id - b.id);
  return `
    <div class="table-wrap">
      <table class="picks-table">
        <thead><tr><th>Match</th><th>Tour</th><th>Affiche</th><th>Date / Heure</th><th>Lieu</th></tr></thead>
        <tbody>
          ${ko.map((m) => {
            const info = getMatchDisplayTeams(userData, m);
            return `
              <tr>
                <td>${m.id}</td>
                <td>${escapeHtml(roundLabel(m.round) || "-")}</td>
                <td>${escapeHtml(info.homeLabel)} vs ${escapeHtml(info.awayLabel)}</td>
                <td>${escapeHtml([m.date, m.time].filter(Boolean).join(" • ") || "À confirmer")}</td>
                <td>${escapeHtml([m.city, m.stadium].filter(Boolean).join(" • ") || "À confirmer")}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function computeGroupStandingsFromPicks(userData){
  const standingsByGroup = {};
  for (const g of state.teams.groups || []){
    const teams = state.teams.teamsByGroup[g] || [];
    const table = new Map(teams.map((team) => [team, { team, pts: 0, gd: 0, played: 0 }]));
    const matches = (state.matches.groupStage || []).filter((m) => m.group === g);
    for (const m of matches){
      const pick = userData.picks?.[String(m.id)];
      if (!pick) continue;
      const home = table.get(m.home);
      const away = table.get(m.away);
      if (!home || !away) continue;
      home.played += 1;
      away.played += 1;
      if (pick === "H") { home.pts += 3; home.gd += 1; away.gd -= 1; }
      if (pick === "A") { away.pts += 3; away.gd += 1; home.gd -= 1; }
      if (pick === "D") { home.pts += 1; away.pts += 1; }
    }
    standingsByGroup[g] = [...table.values()].sort((a, b) => (
      b.pts - a.pts || b.gd - a.gd || a.team.localeCompare(b.team)
    ));
  }
  return standingsByGroup;
}

function computeAutoQualifiers(userData){
  const standings = computeGroupStandingsFromPicks(userData);
  const qualifiers = {};
  const thirds = [];
  for (const g of state.teams.groups || []){
    const rows = standings[g] || [];
    qualifiers[`${g}1`] = rows[0]?.team || `${g}1 à définir`;
    qualifiers[`${g}2`] = rows[1]?.team || `${g}2 à définir`;
    if (rows[2]) thirds.push({ slot: `${g}3`, ...rows[2] });
  }
  thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || a.team.localeCompare(b.team));
  for (let i = 0; i < 8; i += 1){
    qualifiers[`BT${i + 1}`] = thirds[i]?.team || `Meilleur 3e #${i + 1}`;
  }
  const qualifiedCount = Object.values(qualifiers).filter((v) => !String(v).includes("à définir")).length;
  return { qualifiers, standings, qualifiedCount };
}

function getR32TeamsForMatch(matchId, userData){
  const slots = [
    "A1","B2","C1","D2","E1","F2","G1","H2",
    "I1","J2","K1","L2","A2","B1","C2","D1",
    "E2","F1","G2","H1","I2","J1","K2","L1",
    "BT1","BT8","BT2","BT7","BT3","BT6","BT4","BT5"
  ];
  const index = (Number(matchId) - 73) * 2;
  if (index < 0 || index >= slots.length) return null;
  const auto = computeAutoQualifiers(userData).qualifiers;
  return {
    homeLabel: auto[slots[index]] || slots[index],
    awayLabel: auto[slots[index + 1]] || slots[index + 1]
  };
}

function getMatchDisplayTeams(userData, match){
  if (!match) return { homeLabel: "À définir", awayLabel: "À définir" };
  if (match.stage !== "KO") {
    return { homeLabel: match.home || "À définir", awayLabel: match.away || "À définir" };
  }
  if (match.round === "R32") {
    const isGeneric = String(match.homeLabel || "").toLowerCase().includes("qualifié")
      || String(match.awayLabel || "").toLowerCase().includes("qualifié");
    if (isGeneric) {
      const fromGroups = getR32TeamsForMatch(match.id, userData);
      if (fromGroups) return fromGroups;
    }
  }
  return {
    homeLabel: resolveKnockoutSlot(match.homeLabel, userData),
    awayLabel: resolveKnockoutSlot(match.awayLabel, userData)
  };
}

function resolveKnockoutSlot(label, userData){
  const fallback = label || "À définir";
  const raw = String(label || "");
  const fromGroupRanking = resolveGroupPlacementLabel(raw, userData);
  if (fromGroupRanking) return fromGroupRanking;
  const winnerMatchRef = raw.match(/Vainqueur(?:\s+du)?\s+match\s*(\d+)/i);
  if (winnerMatchRef) {
    return pickWinnerName(Number(winnerMatchRef[1]), userData) || fallback;
  }
  const loserSemiRef = raw.match(/Perdant(?:\s+du)?\s+match\s*(\d+)/i) || raw.match(/Perdant Demi\s*(\d+)/i);
  if (loserSemiRef) {
    return pickLoserName(Number(loserSemiRef[1]), userData) || fallback;
  }
  return fallback;
}

function resolveGroupPlacementLabel(rawLabel, userData){
  const label = String(rawLabel || "");
  const standings = computeGroupStandingsFromPicks(userData || { picks:{} });
  const normalized = normalizeName(label).replace(/\s+/g, " ");

  const directSlot = normalized.match(/^([a-l])\s*([123])$/i);
  if (directSlot) {
    const group = directSlot[1].toUpperCase();
    const rankIndex = Number(directSlot[2]) - 1;
    return standings[group]?.[rankIndex]?.team || null;
  }

  const rankGroupMatch = normalized.match(/(premier|1er|deuxieme|2e|troisieme|3e)\s+du\s+groupe\s+([a-l])/i);
  if (rankGroupMatch) {
    const rankWord = rankGroupMatch[1].toLowerCase();
    const group = rankGroupMatch[2].toUpperCase();
    const rankIndex = rankWord.startsWith("premier") || rankWord === "1er"
      ? 0
      : (rankWord.startsWith("deux") || rankWord === "2e" ? 1 : 2);
    return standings[group]?.[rankIndex]?.team || null;
  }

  const thirdOfGroups = normalized.match(/troisieme\s+du\s+groupe\s+([a-l](?:\/[a-l])*)/i);
  if (thirdOfGroups) {
    const allowedGroups = thirdOfGroups[1]
      .split("/")
      .map((group) => group.trim().toUpperCase())
      .filter(Boolean);
    const candidates = allowedGroups
      .map((group) => standings[group]?.[2])
      .filter(Boolean)
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || a.team.localeCompare(b.team));
    return candidates[0]?.team || null;
  }
  return null;
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
  for (const el of document.querySelectorAll("[data-view]")){
    el.onclick = () => {
      state.view = el.dataset.view;
      render();
    };
  }
  for (const el of document.querySelectorAll("[data-hubtab]")){
    el.onclick = () => {
      state.hubTab = el.dataset.hubtab;
      render();
    };
  }
  for (const el of document.querySelectorAll("[data-group]")){
    el.onclick = () => {
      state.selectedGroup = el.dataset.group;
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
  const postBtn = document.getElementById("thirdHalfPostBtn");
  if (postBtn) postBtn.onclick = () => submitThirdHalfComment();
  for (const btn of document.querySelectorAll("[data-like-comment]")){
    btn.onclick = () => toggleCommentLike(btn.dataset.likeComment);
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
    .filter(([, u]) => u?.profile && countPicks(u) === total && u.koSubmittedAt)
    .map(([key, u]) => ({
      key,
      label: `${u.profile.firstName} ${u.profile.lastName}${u.profile.nickname ? ` (${u.profile.nickname})` : ""}`,
      favoriteTeam: inferPredictedWinner(u),
      favoriteFlag: getTeamFlag(inferPredictedWinner(u)),
      profilePhoto: u.profilePhoto || u.profile?.profilePhoto || "",
      points: computeUserPoints(u)
    }))
    .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label));
}

function getPointsWeight(match){
  if (match.stage === "GROUP") return 1;
  const weights = { R32: 2, R16: 4, QF: 16, SF: 32, BRONZE: 16, FINAL: 64 };
  return weights[match.round] || 0;
}

function getMatchOutcome(match){
  if (!Number.isFinite(match?.scoreHome) || !Number.isFinite(match?.scoreAway)) return null;
  if (match.scoreHome > match.scoreAway) return "H";
  if (match.scoreHome < match.scoreAway) return "A";
  return "D";
}

function computeUserPoints(userData){
  const allMatches = [...(state.matches?.groupStage || []), ...(state.matches?.knockout || [])];
  return allMatches.reduce((sum, match) => {
    const outcome = getMatchOutcome(match);
    if (!outcome) return sum;
    const pickValue = userData.picks?.[String(match.id)];
    return pickValue === outcome ? sum + getPointsWeight(match) : sum;
  }, 0);
}

function inferPredictedWinner(userData){
  const final = getMatchById(104);
  if (!final) return "";
  const teams = getMatchDisplayTeams(userData, final);
  const pick = userData.picks?.["104"];
  if (pick === "H") return teams.homeLabel;
  if (pick === "A") return teams.awayLabel;
  return "";
}

function randomPick(options){
  return options[Math.floor(Math.random() * options.length)];
}

function generateFlashGrid(){
  const u = currentUser();
  const allMatches = [...(state.matches?.groupStage || []), ...(state.matches?.knockout || [])];
  if (!allMatches.length) {
    alert("Aucun match disponible pour générer une grille flash.");
    return;
  }
  for (const match of allMatches){
    const options = match.stage === "GROUP" ? ["H", "D", "A"] : ["H", "A"];
    u.picks[String(match.id)] = randomPick(options);
  }
  u.flashLockedAt = new Date().toISOString();
  saveAll();
  render();
}

function isFlashLocked(userData){
  return Boolean(userData?.flashLockedAt && !userData?.finalSubmittedAt);
}

function computeTodayMatchStats(){
  const today = getLocalDateKey(new Date());
  const users = Object.values(state.data.users || {});
  const all = [...state.matches.groupStage, ...state.matches.knockout];
  const todayMatches = all.filter((m) => normalizeMatchDateKey(m.date) === today);
  return todayMatches.map((m) => {
    const counts = { H: 0, D: 0, A: 0 };
    let total = 0;
    for (const u of users){
      const p = u.picks?.[String(m.id)];
      if (!p || !["H", "D", "A"].includes(p)) continue;
      if (m.stage === "KO" && p === "D") continue;
      counts[p] += 1;
      total += 1;
    }
    const teams = getMatchDisplayTeams(currentUser(), m);
    const labels = { H: teams.homeLabel, D: "Nul", A: teams.awayLabel };
    const options = m.stage === "KO" ? ["H", "A"] : ["H", "D", "A"];
    const breakdown = options
      .filter((option) => counts[option] > 0)
      .sort((a, b) => counts[b] - counts[a])
      .map((option) => `${Math.round((counts[option] / Math.max(1, total)) * 100)}% ${labels[option]}`)
      .join(" • ");
    return { match: `${teams.homeLabel} vs ${teams.awayLabel}`, breakdown: breakdown || "Aucun prono" };
  });
}

function getLocalDateKey(date){
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeMatchDateKey(value){
  const raw = String(value || "").trim();
  if (!raw) return "";
  const explicitDay = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (explicitDay) return explicitDay[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return getLocalDateKey(parsed);
}

function computeRoundWinnerStats(){
  const users = Object.values(state.data.users || {});
  const rounds = ["R32", "R16", "QF", "SF", "FINAL"];
  return rounds.map((round) => {
    const matches = state.matches.knockout.filter((m) => m.round === round);
    const counts = new Map();
    let total = 0;
    for (const match of matches){
      for (const u of users){
        const p = u.picks?.[String(match.id)];
        if (!p) continue;
        const teams = getMatchDisplayTeams(u, match);
        const winner = p === "H" ? teams.homeLabel : p === "A" ? teams.awayLabel : null;
        if (!winner) continue;
        counts.set(winner, (counts.get(winner) || 0) + 1);
        total += 1;
      }
    }
    return {
      round: roundLabel(round),
      teams: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, rate: Math.round((count / Math.max(1, total)) * 100) }))
    };
  }).filter((entry) => entry.teams.length);
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
function countPicks(u){
  const allMatches = [...(state.matches?.groupStage || []), ...(state.matches?.knockout || [])];
  return allMatches.filter((m) => {
    const pickValue = u.picks?.[String(m.id)];
    return pickValue === "H" || pickValue === "A" || (m.stage === "GROUP" && pickValue === "D");
  }).length;
}
function countPicksByStage(u, stage){
  const source = stage === "KO" ? state.matches.knockout : state.matches.groupStage;
  return source.filter((m) => {
    const pickValue = u.picks?.[String(m.id)];
    return pickValue === "H" || pickValue === "A" || (stage !== "KO" && pickValue === "D");
  }).length;
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
