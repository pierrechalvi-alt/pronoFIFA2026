const APP = document.getElementById("app");
const USERBOX = document.getElementById("userBox");

const LS_KEY = "fwc26_pronos_v1";

const state = {
  me: null,
  onboardingStep: "welcome", // welcome | profile | app
  view: "groups", // groups | qualifs | ko | recap
  teams: null,
  matches: null,
  filterText: "",
  showUnpickedOnly: false,
  data: loadAll(),
};

init();

async function init(){
  const [teams, matches] = await Promise.all([
    fetch("./data/teams.json").then(r=>r.json()),
    fetch("./data/matches.json").then(r=>r.json())
  ]);
  state.teams = teams;
  state.matches = normalizeMatches(matches);

  if (state.data?.lastUserKey) {
    const u = state.data.users?.[state.data.lastUserKey];
    if (u?.profile) {
      state.me = u.profile;
      state.onboardingStep = "app";
    }
  }
  render();
}

function normalizeMatches(m){
  const groupStage = Array.isArray(m.groupStage) ? m.groupStage : [];
  const knockout = Array.isArray(m.knockout) ? m.knockout : [];
  return { groupStage, knockout };
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
  state.data.lastUserKey = null;
  saveAll();
  render();
}

function pick(matchId, val){
  const u = currentUser();
  if (u.finalSubmittedAt) return;
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

        <div class="row" style="margin-top:12px">
          <button class="btn" id="exportBtn">Exporter mes pronos (JSON)</button>
          <button class="btn" id="importBtn">Importer un JSON</button>
          <input type="file" id="importFile" accept="application/json" hidden />
        </div>
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
        <small>
          Astuce : l’export JSON te permet de m’envoyer tes pronos sur le groupe WhatsApp/Discord.
        </small>
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
  document.getElementById("exportBtn").onclick = () => exportJSON();
  document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
  document.getElementById("importFile").onchange = (e) => importJSON(e.target.files?.[0]);
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
}

function renderGroups(){
  const groups = state.teams.groups;
  const gs = state.matches.groupStage;
  let html = `<p>Pronostique les matchs de poule (1 / N / 2). Le site fonctionne même si tu complètes progressivement la liste.</p>`;

  for (const g of groups){
    const matches = filterMatches(gs.filter(m => m.group === g));
    html += `<div class="hr"></div><h2>Groupe ${g}</h2>`;

    if (!matches.length){
      html += `<p><small>${state.filterText || state.showUnpickedOnly ? "Aucun match ne correspond aux filtres." : "Aucun match listé pour ce groupe (à compléter dans data/matches.json)."}</small></p>`;
      continue;
    }
    for (const m of matches) html += matchRow(m);
  }

  html += `<div class="hr"></div><small>Source calendrier : PDF FIFA officiel. (Les heures sont indiquées ET dans le PDF.)</small>`;
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

  let html = `<p>Version B1 : libellés simples (ex : <b>Vainqueur Match 89</b>). Aucun code cryptique.</p>`;

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
      <button class="btn primary" id="exportBtn2">Exporter mes pronos (JSON)</button>
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

  const homeLabel = m.stage === "KO" ? (m.homeLabel || "À définir") : (m.home || "À définir");
  const awayLabel = m.stage === "KO" ? (m.awayLabel || "À définir") : (m.away || "À définir");

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
        <button class="pick ${v==="D"?"active":""}" data-pick="D" title="Match nul" ${locked ? "disabled" : ""}>N</button>
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

  const exp2 = document.getElementById("exportBtn2");
  if (exp2) exp2.onclick = () => exportJSON();
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

function exportJSON(){
  const u = currentUser();
  const payload = {
    profile: u.profile,
    picks: u.picks,
    qualifiers: u.qualifiers,
    bonusGoals: u.bonusGoals,
    finalSubmittedAt: u.finalSubmittedAt,
    tieBreakerSubmittedAt: u.tieBreakerSubmittedAt,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pronos_fwc26_${userKey(u.profile)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importJSON(file){
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload?.profile?.firstName || !payload?.profile?.lastName) {
      alert("Le fichier JSON est invalide (profil manquant).");
      return;
    }
    setUser(payload.profile);
    const u = currentUser();
    u.picks = payload.picks && typeof payload.picks === "object" ? payload.picks : {};
    u.qualifiers = payload.qualifiers && typeof payload.qualifiers === "object" ? payload.qualifiers : {};
    u.bonusGoals = Number.isFinite(Number(payload.bonusGoals)) ? Number(payload.bonusGoals) : null;
    u.finalSubmittedAt = payload.finalSubmittedAt || null;
    u.tieBreakerSubmittedAt = payload.tieBreakerSubmittedAt || null;
    saveAll();
    alert("Import réussi ✅");
    render();
  } catch {
    alert("Impossible d'importer ce fichier (JSON invalide).");
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
  saveAll();
  alert("Merci ! Ton profil joueur est complet 🎉");
  state.view = "recap";
  render();
}

function renderPlayerHub(){
  const rankings = computeLeaderboard();
  return `
    <div class="hr"></div>
    <h2>Merci pour ta participation 🙌</h2>
    <p>Ton profil est créé. Tu peux revoir ta grille, suivre les résultats en direct et le classement des inscrits.</p>
    <div class="grid two" style="margin-top:10px">
      <section class="card" style="padding:12px">
        <h2>Résultats en direct</h2>
        <p style="margin-top:0">Les résultats apparaissent ici dès qu'ils sont renseignés dans le calendrier.</p>
        <small>Astuce : ajoute <code>scoreHome</code> et <code>scoreAway</code> dans <code>data/matches.json</code> pour alimenter ce flux.</small>
      </section>
      <section class="card" style="padding:12px">
        <h2>Classement des joueurs</h2>
        ${rankings.map((r, idx) => `
          <div class="row" style="justify-content:space-between; border-bottom:1px solid var(--line); padding:6px 0">
            <b>#${idx + 1} ${escapeHtml(r.label)}</b>
            <span class="badge">${r.done}/${r.total} pronos</span>
          </div>
        `).join("")}
      </section>
    </div>
  `;
}

function computeLeaderboard(){
  const users = Object.values(state.data.users || {});
  const total = countTotalMatches();
  return users
    .filter(u => u?.profile)
    .map((u) => ({
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
