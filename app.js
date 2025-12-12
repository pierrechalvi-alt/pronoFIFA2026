const APP = document.getElementById("app");
const USERBOX = document.getElementById("userBox");

const LS_KEY = "fwc26_pronos_v1";

const state = {
  me: null,
  view: "groups", // groups | qualifs | ko | recap
  teams: null,
  matches: null,
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
    if (u?.profile) state.me = u.profile;
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
      bonusGoals: null
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
  u.picks[String(matchId)] = val;
  saveAll();
  render();
}

function setBonusGoals(val){
  const u = currentUser();
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
    ? `<span class="badge a1">👤 ${escapeHtml(state.me.firstName)} ${escapeHtml(state.me.lastName)}</span>
       <button class="btn" id="logoutBtn" style="margin-left:10px">Déconnexion</button>`
    : `<span class="badge">Non connecté</span>`;

  if (state.me) {
    queueMicrotask(()=>{
      const b = document.getElementById("logoutBtn");
      if (b) b.onclick = logout;
    });
  }

  if (!state.me) return renderLogin();
  return renderApp();
}

function renderLogin(){
  APP.innerHTML = `
    <div class="grid two">
      <section class="card">
        <h1>Connexion</h1>
        <p>Entre ton identité officielle (celle qui assumera les pronos douteux).</p>

        <div class="row">
          <div class="field" style="flex:1; min-width:220px">
            <label>Prénom</label>
            <input id="firstName" placeholder="Ex: Karim" autocomplete="given-name" />
          </div>
          <div class="field" style="flex:1; min-width:220px">
            <label>Nom</label>
            <input id="lastName" placeholder="Ex: Benzema" autocomplete="family-name" />
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="goBtn">Let’s go</button>
          <small>Pas de compte, pas de mail, pas de larmes : stockage local.</small>
        </div>
      </section>

      <aside class="card">
        <h2>Règles (version courte)</h2>
        <p>
          Tu pronostiques <b>uniquement le résultat</b> (1/N/2). Puis tu vas jusqu’au vainqueur.
          En cas d’égalité : <b>question subsidiaire</b> → total de buts sur <b>104 matchs</b>.
        </p>

        <div class="hr"></div>
        <p style="margin-bottom:0"><b>Barème</b></p>
        <p style="margin-top:6px">
          Poules : <b>1</b> pt / match.<br/>
          Équipe trouvée en : 16e <b>2</b>, 8e <b>4</b>, quart <b>8</b>, demi <b>16</b>, finale <b>32</b>.
        </p>
      </aside>
    </div>
  `;

  document.getElementById("goBtn").onclick = () => {
    const firstName = document.getElementById("firstName").value.trim();
    const lastName  = document.getElementById("lastName").value.trim();
    if (!firstName || !lastName) return alert("Il manque soit le prénom, soit le nom. (On évite le pseudo ‘Zizou’.)");
    setUser({ firstName, lastName });
  };
}

function renderApp(){
  const u = currentUser();
  const total = countTotalMatches();
  const done = countPicks(u);

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

        <h2>Question subsidiaire</h2>
        <p>Total de buts sur <b>104 matchs</b> (en cas d’égalité entre vous).</p>

        <div class="field" style="margin-top:12px">
          <label>Total de buts</label>
          <input id="bonusGoals" type="number" min="0" step="1" placeholder="Ex: 312"
                 value="${u.bonusGoals ?? ""}"/>
        </div>

        <div class="row" style="margin-top:12px">
          <button class="btn" id="exportBtn">Exporter mes pronos (JSON)</button>
        </div>
      </section>

      <aside class="card">
        <h2>Progression</h2>
        <p><b>${done}/${total}</b> matchs pronostiqués.</p>
        <small>
          Astuce : l’export JSON te permet de m’envoyer tes pronos sur le groupe WhatsApp/Discord.
        </small>
      </aside>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="tabs">
        <div class="tab ${state.view==="groups"?"active":""}" data-view="groups">Phase de groupes</div>
        <div class="tab ${state.view==="qualifs"?"active":""}" data-view="qualifs">Qualifiés</div>
        <div class="tab ${state.view==="ko"?"active":""}" data-view="ko">Phase finale</div>
        <div class="tab ${state.view==="recap"?"active":""}" data-view="recap">Récap</div>
      </div>
      <div id="panel"></div>
    </div>
  `;

  document.getElementById("bonusGoals").oninput = (e) => setBonusGoals(e.target.value);
  document.getElementById("exportBtn").onclick = () => exportJSON();

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
    const matches = gs.filter(m => m.group === g);
    html += `<div class="hr"></div><h2>Groupe ${g}</h2>`;

    if (!matches.length){
      html += `<p><small>Aucun match listé pour ce groupe (à compléter dans <code>data/matches.json</code>).</small></p>`;
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
    const ms = ko.filter(m => m.round === r.key);
    if (!ms.length) continue;
    html += `<div class="hr"></div><h2>${r.title}</h2>`;
    for (const m of ms) html += matchRow(m);
  }
  return html;
}

function renderRecap(){
  const u = currentUser();
  const total = countTotalMatches();
  const done = countPicks(u);

  return `
    <p>Récapitulatif (preuve officielle en cas de “j’avais dit ça”).</p>
    <div class="hr"></div>
    <p><b>${done}/${total}</b> matchs pronostiqués.</p>
    <p>Question subsidiaire : <b>${u.bonusGoals ?? "—"}</b></p>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" id="exportBtn2">Exporter mes pronos (JSON)</button>
      <button class="btn danger" id="resetBtn">Tout effacer (panique)</button>
    </div>
  `;
}

/* ---------- UI helpers ---------- */

function matchRow(m){
  const u = currentUser();
  const v = u.picks[String(m.id)] || "";

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
        <button class="pick ${v==="H"?"active":""}" data-pick="H" title="Victoire équipe gauche">1</button>
        <button class="pick ${v==="D"?"active":""}" data-pick="D" title="Match nul">N</button>
        <button class="pick ${v==="A"?"active":""}" data-pick="A" title="Victoire équipe droite">2</button>
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

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[c]));
}
function escapeAttr(s){ return escapeHtml(s).replace(/"/g, "&quot;"); }
