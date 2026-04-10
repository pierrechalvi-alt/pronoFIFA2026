const APP = document.getElementById("app");
const USERBOX = document.getElementById("userBox");

const LS_KEY = "fwc26_pronos_v1";
const SESSION_USER_KEY = "fwc26_last_user_key_v2";
const DB_NAME = "fwc26_pronos_db";
const DB_STORE = "snapshots";
const DB_RECORD_ID = "latest";
const memoryStorage = { value: null };
let matchLifecycleInterval = null;
const CLIENT_ID = `client_${Math.random().toString(36).slice(2, 9)}`;
const SYNC_CHANNEL_NAME = "fwc26_sync";
let syncChannel = null;
let communityStream = null;
let communitySyncTimer = null;
let communityPullInterval = null;
const CANONICAL_APP_ORIGIN = resolveCanonicalAppOrigin();
const CANONICAL_REDIRECT_DISABLED = isCanonicalRedirectDisabled();
const COMMUNITY_API_BASE = resolveCommunityApiBase();
const COMMUNITY_ROOM = resolveCommunityRoom();
const LIVE_MATCHES_API = resolveLiveScoresApi();

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

registerServiceWorker();
init();

function registerServiceWorker(){
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

async function init(){
  if (enforceCanonicalAppOrigin()) {
    markBootReady();
    return;
  }
  if (!APP || !USERBOX) {
    console.error("Impossible d'initialiser l'application : éléments racine introuvables.");
    const host = document.getElementById("app") || document.body;
    if (host) {
      host.innerHTML = `
        <section class="card">
          <h1>Initialisation impossible</h1>
          <p>Les éléments racine <code>#app</code> ou <code>#userBox</code> sont introuvables dans <code>index.html</code>.</p>
        </section>
      `;
    }
    markBootReady();
    return;
  }
  try {
    const [teams, matches] = await Promise.all([
      fetchJson("./data/teams.json"),
      fetchJson("./data/matches.json")
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
    markBootReady();
    return;
  }

  await hydrateDataStore();
  await hydrateCommunitySnapshot();
  requestPersistentStorage();
  setupRealtimeSync();
  setupCommunityRealtimeSync();
  setupCommunityPolling();
  startMatchLifecycleMonitor();
  setupLiveScoresSync();

  const localUserKey = readStorageItem(SESSION_USER_KEY);
  if (localUserKey) {
    const u = state.data.users?.[localUserKey];
    if (u?.profile) {
      state.me = u.profile;
      state.onboardingStep = "app";
    }
  }
  state.selectedGroup = state.teams?.groups?.[0] || "A";
  render();
  markBootReady();
}

function markBootReady(){
  if (typeof window !== "undefined" && window.__FWC26_BOOT_STATUS__) {
    window.__FWC26_BOOT_STATUS__.ready = true;
  }
}

function resolveCanonicalAppOrigin(){
  const explicitMeta = document.querySelector('meta[name="fwc26-canonical-origin"]')?.content;
  const explicitGlobal = typeof window !== "undefined" ? window.__FWC26_CANONICAL_ORIGIN__ : null;
  const raw = String(explicitMeta || explicitGlobal || "").trim();
  if (!raw) return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function enforceCanonicalAppOrigin(){
  if (CANONICAL_REDIRECT_DISABLED) return false;
  if (!CANONICAL_APP_ORIGIN || !window?.location?.origin) return false;
  if (window.location.origin === CANONICAL_APP_ORIGIN) return false;
  const redirectUrl = `${CANONICAL_APP_ORIGIN}${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(redirectUrl);
  return true;
}

function isCanonicalRedirectDisabled(){
  if (window?.location?.hostname?.endsWith(".trycloudflare.com")) return true;
  const explicitMeta = document.querySelector('meta[name="fwc26-disable-canonical-redirect"]')?.content;
  const explicitGlobal = typeof window !== "undefined" ? window.__FWC26_DISABLE_CANONICAL_REDIRECT__ : null;
  const raw = String(explicitMeta || explicitGlobal || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

async function fetchJson(url){
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Erreur HTTP ${response.status} sur ${url}`);
  }
  return response.json();
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
  const fallback = { users:{}, thirdHalf:{ comments:[] }, updatedAt:0 };
  try {
    const raw = readStorageItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : fallback;
    return normalizeDataShape(parsed);
  }
  catch { return fallback; }
}
function normalizeDataShape(raw){
  const parsed = raw && typeof raw === "object" ? raw : {};
  if (!parsed.thirdHalf || !Array.isArray(parsed.thirdHalf.comments)) {
    parsed.thirdHalf = { comments:[] };
  }
  parsed.thirdHalf.comments = parsed.thirdHalf.comments.map((comment) => ({
    ...comment,
    replies: Array.isArray(comment.replies) ? comment.replies : []
  }));
  if (!parsed.users || typeof parsed.users !== "object") parsed.users = {};
  if (!Number.isFinite(Number(parsed.updatedAt))) parsed.updatedAt = 0;
  if (!parsed.notifications || typeof parsed.notifications !== "object") {
    parsed.notifications = { feed: [], unreadCount: 0, delivered: {} };
  }
  if (!Array.isArray(parsed.notifications.feed)) parsed.notifications.feed = [];
  if (!Number.isFinite(Number(parsed.notifications.unreadCount))) parsed.notifications.unreadCount = 0;
  if (!parsed.notifications.delivered || typeof parsed.notifications.delivered !== "object") {
    parsed.notifications.delivered = {};
  }
  const lastReadAt = Number(parsed.notifications.lastReadAt || 0);
  parsed.notifications.lastReadAt = Number.isFinite(lastReadAt) ? lastReadAt : 0;
  parsed.notifications.unreadCount = computeUnreadCount(parsed.notifications);
  return parsed;
}

function computeUnreadCount(notifications){
  const feed = Array.isArray(notifications?.feed) ? notifications.feed : [];
  const lastReadAt = Number(notifications?.lastReadAt || 0);
  let unread = 0;
  for (const item of feed){
    const createdAt = new Date(item?.createdAt || 0).getTime();
    if (Number.isFinite(createdAt) && createdAt > lastReadAt) unread += 1;
  }
  return Math.min(99, unread);
}

async function hydrateDataStore(){
  const localData = normalizeDataShape(state.data);
  const indexedData = await loadAllFromIndexedDB();
  state.data = mergeSnapshots(localData, indexedData || {});
  persistSnapshot(false);
}

function saveAll(){
  state.data.updatedAt = Date.now();
  persistSnapshot(true);
}

function persistSnapshot(announce){
  writeStorageItem(LS_KEY, JSON.stringify(state.data));
  saveAllToIndexedDB(state.data);
  if (announce) {
    broadcastSnapshot();
    queueCommunitySnapshotPush();
  }
}

function readStorageItem(key){
  try {
    return localStorage.getItem(key);
  } catch {
    return memoryStorage.value;
  }
}

function writeStorageItem(key, value){
  memoryStorage.value = value;
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function setupRealtimeSync(){
  window.addEventListener("storage", (event) => {
    if (event.key !== LS_KEY || !event.newValue) return;
    try {
      integrateIncomingData(JSON.parse(event.newValue), "storage");
    } catch {}
  });
  if ("BroadcastChannel" in window) {
    syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    syncChannel.onmessage = (event) => {
      const payload = event.data;
      if (!payload || payload.clientId === CLIENT_ID) return;
      integrateIncomingData(payload.snapshot, "broadcast");
    };
  }
  setInterval(async () => {
    const indexed = await loadAllFromIndexedDB();
    if (indexed) integrateIncomingData(indexed, "indexeddb");
  }, 12000);
}

function resolveCommunityApiBase(){
  const explicitQuery = new URLSearchParams(window?.location?.search || "").get("fwc26Api");
  const explicitMeta = document.querySelector('meta[name="fwc26-community-api"]')?.content;
  const explicitGlobal = typeof window !== "undefined" ? window.__FWC26_COMMUNITY_API__ : null;
  const explicitLocalStorage = readStorageItem("fwc26_community_api");
  const raw = String(explicitQuery || explicitMeta || explicitGlobal || explicitLocalStorage || CANONICAL_APP_ORIGIN || "").trim();
  if (!raw) {
    if (window?.location?.protocol === "http:" || window?.location?.protocol === "https:") {
      return window.location.origin;
    }
    return "";
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function resolveCommunityRoom(){
  const explicitQuery = new URLSearchParams(window?.location?.search || "").get("fwc26Room");
  const explicitMeta = document.querySelector('meta[name="fwc26-community-room"]')?.content;
  const explicitGlobal = typeof window !== "undefined" ? window.__FWC26_COMMUNITY_ROOM__ : null;
  const explicitLocalStorage = readStorageItem("fwc26_community_room");
  const raw = String(explicitQuery || explicitMeta || explicitGlobal || explicitLocalStorage || "global").trim().toLowerCase();
  return raw.replace(/[^a-z0-9_-]/g, "").slice(0, 64) || "global";
}

function resolveLiveScoresApi(){
  const explicitQuery = new URLSearchParams(window?.location?.search || "").get("fwc26LiveApi");
  const explicitMeta = document.querySelector('meta[name="fwc26-live-api"]')?.content;
  const explicitGlobal = typeof window !== "undefined" ? window.__FWC26_LIVE_MATCHES_API__ : null;
  const raw = String(explicitQuery || explicitMeta || explicitGlobal || "").trim();
  if (!raw) return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function withCommunityRoom(url){
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}room=${encodeURIComponent(COMMUNITY_ROOM)}`;
}

async function hydrateCommunitySnapshot(){
  if (!COMMUNITY_API_BASE) return;
  try {
    await pullCommunitySnapshot("community-hydrate");
  } catch (err) {
    console.warn("Synchronisation communauté indisponible :", err?.message || err);
  }
}

function setupCommunityRealtimeSync(){
  if (!COMMUNITY_API_BASE || typeof EventSource === "undefined") return;
  try {
    communityStream = new EventSource(withCommunityRoom(`${COMMUNITY_API_BASE}/api/stream`));
    communityStream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload?.snapshot || payload.clientId === CLIENT_ID) return;
        integrateIncomingData(payload.snapshot, "community-stream");
      } catch {}
    };
    communityStream.onerror = () => {
      if (communityStream) communityStream.close();
      communityStream = null;
      setTimeout(setupCommunityRealtimeSync, 4000);
    };
  } catch (err) {
    console.warn("Impossible d'ouvrir le flux communauté :", err?.message || err);
  }
}

function setupCommunityPolling(){
  if (!COMMUNITY_API_BASE) return;
  if (communityPullInterval) clearInterval(communityPullInterval);
  communityPullInterval = setInterval(() => {
    pullCommunitySnapshot("community-poll").catch(() => {});
  }, 12000);
}

function setupLiveScoresSync(){
  if (!LIVE_MATCHES_API) return;
  pullLiveScores().catch(() => {});
  setInterval(() => {
    pullLiveScores().catch(() => {});
  }, 45000);
}

async function pullLiveScores(){
  const response = await fetch(LIVE_MATCHES_API, { cache: "no-store" });
  if (!response.ok) return;
  const payload = await response.json();
  const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.matches) ? payload.matches : [];
  if (!entries.length) return;
  let changed = false;
  for (const item of entries){
    const match = getMatchById(item.id);
    if (!match) continue;
    if (Number.isFinite(Number(item.scoreHome)) && Number.isFinite(Number(item.scoreAway))) {
      const nextHome = Number(item.scoreHome);
      const nextAway = Number(item.scoreAway);
      if (match.scoreHome !== nextHome || match.scoreAway !== nextAway) {
        match.scoreHome = nextHome;
        match.scoreAway = nextAway;
        changed = true;
      }
    }
  }
  if (changed) render();
}

async function pullCommunitySnapshot(source){
  const response = await fetch(withCommunityRoom(`${COMMUNITY_API_BASE}/api/snapshot`), { cache: "no-store" });
  if (!response.ok) return;
  const payload = await response.json();
  if (!payload?.snapshot) return;
  integrateIncomingData(payload.snapshot, source);
}

function queueCommunitySnapshotPush(){
  if (!COMMUNITY_API_BASE) return;
  if (communitySyncTimer) clearTimeout(communitySyncTimer);
  communitySyncTimer = setTimeout(() => {
    pushCommunitySnapshot().finally(() => {
      communitySyncTimer = null;
    });
  }, 350);
}

async function pushCommunitySnapshot(){
  if (!COMMUNITY_API_BASE) return;
  try {
    await fetch(withCommunityRoom(`${COMMUNITY_API_BASE}/api/snapshot`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: CLIENT_ID,
        room: COMMUNITY_ROOM,
        updatedAt: Number(state.data?.updatedAt || Date.now()),
        snapshot: state.data
      })
    });
  } catch (err) {
    console.warn("Échec d'envoi vers la communauté :", err?.message || err);
  }
}

function broadcastSnapshot(){
  if (!syncChannel) return;
  syncChannel.postMessage({
    clientId: CLIENT_ID,
    updatedAt: Date.now(),
    snapshot: state.data
  });
}

function integrateIncomingData(incomingRaw, source){
  const incoming = normalizeDataShape(incomingRaw);
  const previousFeed = Array.isArray(state.data?.notifications?.feed) ? state.data.notifications.feed : [];
  const previousCommentIds = new Set((state.data?.thirdHalf?.comments || []).map((item) => item.id));
  const merged = mergeSnapshots(state.data, incoming);
  if (JSON.stringify(merged) === JSON.stringify(state.data)) return;
  const incomingNotifications = (merged.notifications?.feed || []).filter((item) => !previousFeed.some((existing) => existing.id === item.id));
  const incomingComments = (merged.thirdHalf?.comments || []).filter((item) => !previousCommentIds.has(item.id));
  state.data = merged;
  persistSnapshot(false);
  if (source !== "storage" && source !== "indexeddb") {
    for (const item of incomingNotifications.slice(0, 2)) {
      if (item?.title || item?.body) showToast(`${item.title || "Notification"} — ${item.body || ""}`.trim());
    }
    for (const comment of incomingComments.slice(0, 2)) {
      if (comment?.authorLabel && comment?.text) {
        showToast(`💬 ${comment.authorLabel} : ${comment.text.slice(0, 60)}${comment.text.length > 60 ? "…" : ""}`);
      }
    }
  }
  if (state.me) render();
}

function mergeSnapshots(baseRaw, incomingRaw){
  const base = normalizeDataShape(baseRaw);
  const incoming = normalizeDataShape(incomingRaw);
  const mergedUsers = { ...base.users };

  for (const [key, incomingUser] of Object.entries(incoming.users || {})){
    const existingUser = mergedUsers[key];
    if (!existingUser) {
      mergedUsers[key] = incomingUser;
      continue;
    }
    mergedUsers[key] = {
      ...existingUser,
      ...incomingUser,
      profile: incomingUser.profile || existingUser.profile,
      picks: { ...(existingUser.picks || {}), ...(incomingUser.picks || {}) },
      qualifiers: { ...(existingUser.qualifiers || {}), ...(incomingUser.qualifiers || {}) },
      r32Slots: { ...(existingUser.r32Slots || {}), ...(incomingUser.r32Slots || {}) }
    };
  }

  const commentMap = new Map();
  for (const comment of [...(base.thirdHalf?.comments || []), ...(incoming.thirdHalf?.comments || [])]){
    const existing = commentMap.get(comment.id);
    if (!existing) {
      commentMap.set(comment.id, { ...comment, replies: Array.isArray(comment.replies) ? comment.replies : [] });
      continue;
    }
    const repliesMap = new Map();
    for (const reply of [...(existing.replies || []), ...((comment.replies || []))]){
      repliesMap.set(reply.id, reply);
    }
    commentMap.set(comment.id, {
      ...existing,
      ...comment,
      likes: { ...(existing.likes || {}), ...(comment.likes || {}) },
      replies: [...repliesMap.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    });
  }

  const notifMap = new Map();
  for (const notification of [...(base.notifications?.feed || []), ...(incoming.notifications?.feed || [])]){
    notifMap.set(notification.id, notification);
  }

  return normalizeDataShape({
    ...base,
    ...incoming,
    users: mergedUsers,
    thirdHalf: {
      comments: [...commentMap.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    },
    notifications: {
      feed: [...notifMap.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50),
      lastReadAt: Math.max(Number(base.notifications?.lastReadAt || 0), Number(incoming.notifications?.lastReadAt || 0)),
      delivered: { ...(base.notifications?.delivered || {}), ...(incoming.notifications?.delivered || {}) }
    },
    updatedAt: Math.max(Number(base.updatedAt || 0), Number(incoming.updatedAt || 0))
  });
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
  let shouldPersist = false;
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
    shouldPersist = true;
  }
  const picksBeforeSanitize = JSON.stringify(state.data.users[key].picks || {});
  sanitizeUserPicks(state.data.users[key]);
  if (picksBeforeSanitize !== JSON.stringify(state.data.users[key].picks || {})) shouldPersist = true;
  if (readStorageItem(SESSION_USER_KEY) !== key) writeStorageItem(SESSION_USER_KEY, key);
  if (shouldPersist) saveAll();
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
  writeStorageItem(SESSION_USER_KEY, "");
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
  if (!u) return;
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
  if (!u) return;
  if (!u.finalSubmittedAt || u.tieBreakerSubmittedAt) return;
  u.bonusGoals = val === "" ? null : Number(val);
  saveAll();
}

function setQualifier(group, which, team){
  const u = currentUser();
  if (!u) return;
  if (!u.qualifiers[group]) u.qualifiers[group] = { first:null, second:null };
  u.qualifiers[group][which] = team || null;
  saveAll();
}

function setR32SlotTeam(matchId, side, team){
  const u = currentUser();
  if (!u) return;
  if (!u.r32Slots || typeof u.r32Slots !== "object") u.r32Slots = {};
  const key = `${Number(matchId)}_${side}`;
  if (!team) delete u.r32Slots[key];
  else u.r32Slots[key] = team;
  saveAll();
}

/* ---------- Render ---------- */

function render(){
  USERBOX.innerHTML = state.me
    ? `<button class="profile-trigger" id="profileTrigger" title="Cliquer pour ajouter une photo">
         ${renderAvatar(state.me.profilePhoto, `${state.me.firstName} ${state.me.lastName}`)}
         <span class="user-name">${escapeHtml(state.me.firstName)} ${escapeHtml(state.me.lastName)}${state.me.nickname ? ` (${escapeHtml(state.me.nickname)})` : ""}</span>
       </button>
       <button class="btn alt notification-btn" id="notificationBtn" title="Notifications">
         🔔 ${state.data.notifications?.unreadCount ? `<span class="notif-dot">${state.data.notifications.unreadCount}</span>` : ""}
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
      const notificationBtn = document.getElementById("notificationBtn");
      if (trigger && avatarInput) {
        trigger.onclick = () => avatarInput.click();
        avatarInput.onchange = (e) => handleAvatarUpload(e.target.files?.[0]);
      }
      if (notificationBtn) notificationBtn.onclick = () => openNotificationsCenter();
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
    pushAppNotification({
      type: "player_signup",
      title: "Nouveau joueur inscrit",
      body: `${firstName} ${lastName} a rejoint les pronostics.`
    });
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
    writeStorageItem(SESSION_USER_KEY, key);
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
      <p><b>Barème rapide :</b> Poules bon résultat = 1 pt, 16e = 2 pts, 8e = 4 pts, Quarts = 8 pts, Demies = 16 pts, Finale vainqueur = 32 pts.</p>
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
        <div class="tab ${state.hubTab==="thirdHalf"?"active":""}" data-hubtab="thirdHalf">Le Bistro</div>
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
    ${renderR32QualifierConfigurator(currentUser())}
    ${renderBracketFunnel(currentUser(), true)}
  `;
}

function renderR32QualifierConfigurator(userData){
  const r32Rules = R32_SLOT_RULES.filter((rule) => getMatchById(rule.id));
  if (!r32Rules.length) return "";
  const slots = userData?.r32Slots || {};
  return `
    <section class="card" style="padding:12px; margin:10px 0">
      <h3>Configuration des affiches des 16es</h3>
      <small>Tu peux imposer les qualifiés (1ers, 2es et meilleurs 3es) pour construire ton tableau.</small>
      <div class="grid" style="margin-top:10px">
        ${r32Rules.map((rule) => {
          const homeOptions = resolveR32RuleOptions(rule.home, userData);
          const awayOptions = resolveR32RuleOptions(rule.away, userData);
          const homeValue = slots[`${rule.id}_home`] || resolveR32RuleAutoTeam(rule.home, userData) || "";
          const awayValue = slots[`${rule.id}_away`] || resolveR32RuleAutoTeam(rule.away, userData) || "";
          return `
            <article class="group-card" style="padding:10px">
              <b>Match ${rule.id}</b>
              <div class="field" style="margin-top:6px">
                <label>${escapeHtml(rule.home.label)}</label>
                <select data-r32-match="${rule.id}" data-r32-side="home">
                  <option value="">Auto (${escapeHtml(resolveR32RuleAutoTeam(rule.home, userData) || "À définir")})</option>
                  ${homeOptions.map((team) => `<option value="${escapeAttr(team)}" ${team === homeValue ? "selected" : ""}>${escapeHtml(team)}</option>`).join("")}
                </select>
              </div>
              <div class="field" style="margin-top:6px">
                <label>${escapeHtml(rule.away.label)}</label>
                <select data-r32-match="${rule.id}" data-r32-side="away">
                  <option value="">Auto (${escapeHtml(resolveR32RuleAutoTeam(rule.away, userData) || "À définir")})</option>
                  ${awayOptions.map((team) => `<option value="${escapeAttr(team)}" ${team === awayValue ? "selected" : ""}>${escapeHtml(team)}</option>`).join("")}
                </select>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </section>
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
    <h2>Le Bistro</h2>
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
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
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
      <div style="margin-top:10px; border-top:1px solid var(--line); padding-top:8px">
        <div class="meta" style="text-align:left">Commentaires (${replies.length})</div>
        ${replies.length ? replies.map((reply) => `
          <div class="reply-item">
            <b>${escapeHtml(reply.authorLabel || "Invité")}</b>
            <span class="meta">${escapeHtml(formatDate(reply.createdAt))}</span>
            <div>${escapeHtml(reply.text || "")}</div>
          </div>
        `).join("") : `<small>Aucun commentaire pour ce post.</small>`}
        <div class="row" style="margin-top:8px">
          <input type="text" data-reply-input="${escapeAttr(comment.id)}" placeholder="Répondre à ce post…" />
          <button class="btn alt" data-reply-comment="${escapeAttr(comment.id)}">Commenter</button>
        </div>
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
  readImageAsDataUrl(file, { maxWidth: 512, quality: 0.85 })
    .then((dataUrl) => {
      const u = currentUser();
      if (!u) return;
      u.profilePhoto = dataUrl;
      if (u.profile) u.profile.profilePhoto = dataUrl;
      if (state.me) state.me.profilePhoto = dataUrl;
      saveAll();
      render();
    })
    .catch(() => {
      alert("Impossible de traiter la photo de profil.");
    });
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
      likes: {},
      replies: []
    });
    pushAppNotification({
      type: "bistro_post",
      title: "Nouveau message au Bistro",
      body: `${me.profile.firstName} a publié : ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`
    });
    saveAll();
    render();
  };
  if (!file) return publish();
  if (!file.type.startsWith("image/")) {
    alert("Merci de sélectionner une image valide.");
    return;
  }
  readImageAsDataUrl(file, { maxWidth: 1200, quality: 0.82 })
    .then((photo) => publish(photo))
    .catch(() => alert("Impossible de lire cette image. Essaie un autre fichier."));
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

function submitThirdHalfReply(commentId){
  const me = currentUser();
  if (!me?.profile || !commentId) return;
  const input = document.querySelector(`[data-reply-input="${commentId}"]`);
  const text = String(input?.value || "").trim();
  if (!text) {
    alert("Écris un commentaire avant de répondre.");
    return;
  }
  const comments = state.data.thirdHalf?.comments;
  const comment = comments?.find((entry) => entry.id === commentId);
  if (!comment) return;
  if (!Array.isArray(comment.replies)) comment.replies = [];
  comment.replies.push({
    id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userKey: userKey(me.profile),
    authorLabel: `${me.profile.firstName} ${me.profile.lastName}`,
    text,
    createdAt: new Date().toISOString()
  });
  pushAppNotification({
    type: "bistro_reply",
    title: "Nouvelle réponse au Bistro",
    body: `${me.profile.firstName} a répondu : ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`
  });
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
  const groupMatches = (state.matches.groupStage || []).slice().sort((a, b) => a.id - b.id);
  const groupedByLetter = new Map();
  for (const m of groupMatches){
    if (!groupedByLetter.has(m.group)) groupedByLetter.set(m.group, []);
    groupedByLetter.get(m.group).push(m);
  }

  const groupBlocks = [...groupedByLetter.entries()].map(([group, matches]) => `
    <article class="group-card pick-group-card">
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
              <span class="group-team-name pick-team-name ${homeWinnerClass}" title="${escapeAttr(teams.homeLabel)}">${getTeamFlag(teams.homeLabel)} ${escapeHtml(teams.homeLabel)}</span>
              <span class="vs-chip ${drawClass}">${pickValue === "D" ? "Nul" : "vs"}</span>
              <span class="group-team-name pick-team-name ${awayWinnerClass}" title="${escapeAttr(teams.awayLabel)}">${getTeamFlag(teams.awayLabel)} ${escapeHtml(teams.awayLabel)}</span>
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

function formatTeamShortName(teamName){
  const raw = String(teamName || "").trim();
  if (!raw) return "À définir";
  const normalized = normalizeName(raw);
  const dictionary = {
    "etats-unis": "USA",
    "republique de coree": "Corée",
    "bosnie-et-herzegovine": "Bosnie",
    "arabie saoudite": "Arabie",
    "cote d'ivoire": "Côte d'Ivoire",
    "nouvelle-zelande": "N.-Zélande",
    "rd congo": "RD Congo",
    "angleterre": "England"
  };
  if (dictionary[normalized]) return dictionary[normalized];
  if (raw.length <= 16) return raw;
  const compact = raw
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-zÀ-ÿ'-]/g, ""))
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase())
    .join("");
  return compact.length >= 2 ? compact : raw.slice(0, 14);
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
  const rule = R32_SLOT_RULES.find((item) => item.id === Number(matchId));
  if (!rule) return null;
  const selected = userData?.r32Slots || {};
  const homeAuto = resolveR32RuleAutoTeam(rule.home, userData);
  const awayAuto = resolveR32RuleAutoTeam(rule.away, userData);
  return {
    homeLabel: selected[`${rule.id}_home`] || homeAuto || rule.home.label,
    awayLabel: selected[`${rule.id}_away`] || awayAuto || rule.away.label
  };
}

const R32_SLOT_RULES = [
  { id: 73, home: { type: "rank", group: "C", rank: 1, label: "1er Groupe C" }, away: { type: "rank", group: "F", rank: 2, label: "2e Groupe F" } },
  { id: 74, home: { type: "rank", group: "E", rank: 1, label: "1er Groupe E" }, away: { type: "thirdPool", groups: ["A", "B", "C", "D", "F"], label: "Meilleur 3e (A/B/C/D/F)" } },
  { id: 75, home: { type: "rank", group: "F", rank: 1, label: "1er Groupe F" }, away: { type: "rank", group: "C", rank: 2, label: "2e Groupe C" } },
  { id: 76, home: { type: "rank", group: "E", rank: 2, label: "2e Groupe E" }, away: { type: "rank", group: "I", rank: 2, label: "2e Groupe I" } },
  { id: 77, home: { type: "rank", group: "I", rank: 1, label: "1er Groupe I" }, away: { type: "thirdPool", groups: ["C", "D", "E", "F", "G", "H"], label: "Meilleur 3e (C/D/E/F/G/H)" } },
  { id: 78, home: { type: "rank", group: "A", rank: 1, label: "1er Groupe A" }, away: { type: "thirdPool", groups: ["C", "E", "F", "H", "J"], label: "Meilleur 3e (C/E/F/H/J)" } },
  { id: 79, home: { type: "rank", group: "L", rank: 1, label: "1er Groupe L" }, away: { type: "thirdPool", groups: ["E", "H", "I", "J", "K"], label: "Meilleur 3e (E/H/I/J/K)" } },
  { id: 80, home: { type: "rank", group: "G", rank: 1, label: "1er Groupe G" }, away: { type: "thirdPool", groups: ["B", "E", "F", "I", "J"], label: "Meilleur 3e (B/E/F/I/J)" } },
  { id: 81, home: { type: "rank", group: "H", rank: 1, label: "1er Groupe H" }, away: { type: "rank", group: "J", rank: 2, label: "2e Groupe J" } },
  { id: 82, home: { type: "rank", group: "K", rank: 1, label: "1er Groupe K" }, away: { type: "thirdPool", groups: ["E", "F", "G", "I", "J"], label: "Meilleur 3e (E/F/G/I/J)" } },
  { id: 83, home: { type: "rank", group: "D", rank: 2, label: "2e Groupe D" }, away: { type: "rank", group: "G", rank: 2, label: "2e Groupe G" } },
  { id: 84, home: { type: "rank", group: "J", rank: 1, label: "1er Groupe J" }, away: { type: "rank", group: "H", rank: 2, label: "2e Groupe H" } },
  { id: 85, home: { type: "rank", group: "K", rank: 1, label: "1er Groupe K" }, away: { type: "thirdPool", groups: ["D", "E", "I", "J", "L"], label: "Meilleur 3e (D/E/I/J/L)" } },
  { id: 86, home: { type: "rank", group: "B", rank: 1, label: "1er Groupe B" }, away: { type: "rank", group: "A", rank: 2, label: "2e Groupe A" } },
  { id: 87, home: { type: "rank", group: "D", rank: 1, label: "1er Groupe D" }, away: { type: "rank", group: "L", rank: 2, label: "2e Groupe L" } },
  { id: 88, home: { type: "rank", group: "I", rank: 2, label: "2e Groupe I" }, away: { type: "rank", group: "B", rank: 2, label: "2e Groupe B" } }
];

function resolveR32RuleAutoTeam(rule, userData){
  const standings = computeGroupStandingsFromPicks(userData);
  if (rule.type === "rank") {
    const rankIndex = Math.max(0, Number(rule.rank || 1) - 1);
    return standings[rule.group]?.[rankIndex]?.team || null;
  }
  const candidates = resolveR32RuleOptions(rule, userData);
  if (!candidates.length) return null;
  return candidates[0];
}

function resolveR32RuleOptions(rule, userData){
  const standings = computeGroupStandingsFromPicks(userData);
  if (rule.type === "rank") {
    return (state.teams?.teamsByGroup?.[rule.group] || []).slice();
  }
  if (rule.type === "thirdPool") {
    return (rule.groups || [])
      .map((group) => standings[group]?.[2])
      .filter(Boolean)
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || a.team.localeCompare(b.team))
      .map((entry) => entry.team);
  }
  return [];
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
  for (const btn of document.querySelectorAll("[data-reply-comment]")){
    btn.onclick = () => submitThirdHalfReply(btn.dataset.replyComment);
  }
  for (const sel of document.querySelectorAll("select[data-r32-match]")){
    sel.onchange = (e) => {
      setR32SlotTeam(e.target.dataset.r32Match, e.target.dataset.r32Side, e.target.value || null);
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
  const weights = { R32: 2, R16: 4, QF: 8, SF: 16, BRONZE: 8, FINAL: 32 };
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
  u.r32Slots = {};
  for (const rule of R32_SLOT_RULES){
    const homeOptions = resolveR32RuleOptions(rule.home, u);
    const awayOptions = resolveR32RuleOptions(rule.away, u);
    const autoHome = resolveR32RuleAutoTeam(rule.home, u);
    const autoAway = resolveR32RuleAutoTeam(rule.away, u);
    u.r32Slots[`${rule.id}_home`] = homeOptions.length ? randomPick(homeOptions) : (autoHome || "");
    u.r32Slots[`${rule.id}_away`] = awayOptions.length ? randomPick(awayOptions) : (autoAway || "");
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
  const statsByRound = rounds.map((round) => {
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

  const finalMatches = state.matches.knockout.filter((m) => m.round === "FINAL");
  const winnerCounts = new Map();
  let winnerTotal = 0;
  for (const match of finalMatches){
    for (const u of users){
      const p = u.picks?.[String(match.id)];
      if (!p) continue;
      const teams = getMatchDisplayTeams(u, match);
      const winner = p === "H" ? teams.homeLabel : p === "A" ? teams.awayLabel : null;
      if (!winner) continue;
      winnerCounts.set(winner, (winnerCounts.get(winner) || 0) + 1);
      winnerTotal += 1;
    }
  }

  if (winnerCounts.size){
    statsByRound.push({
      round: "Vainqueur",
      teams: [...winnerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, rate: Math.round((count / Math.max(1, winnerTotal)) * 100) }))
    });
  }

  return statsByRound;
}

function roundLabel(r){
  if (!r) return null;
  const map = { R32:"Seizièmes", R16:"Huitièmes", QF:"Quarts", SF:"Demies", BRONZE:"Bronze", FINAL:"Finale" };
  return map[r] || r;
}

function formatDate(value){
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date inconnue" : date.toLocaleString("fr-FR");
}

async function readImageAsDataUrl(file, options = {}){
  const rawDataUrl = await fileToDataUrl(file);
  const maxWidth = Number(options.maxWidth || 0);
  if (!maxWidth || typeof document === "undefined") return rawDataUrl;
  return resizeDataUrl(rawDataUrl, maxWidth, Number(options.quality || 0.85));
}

function fileToDataUrl(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Lecture impossible"));
    reader.readAsDataURL(file);
  });
}

function resizeDataUrl(dataUrl, maxWidth, quality){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (!img.width || img.width <= maxWidth) return resolve(dataUrl);
      const ratio = maxWidth / img.width;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", Math.min(Math.max(quality || 0.85, 0.5), 0.95)));
    };
    img.onerror = () => reject(new Error("Image invalide"));
    img.src = dataUrl;
  });
}

function pushAppNotification({ type, title, body, uniqueKey }){
  if (!state.data.notifications) {
    state.data.notifications = { feed: [], unreadCount: 0, delivered: {} };
  }
  if (uniqueKey) {
    if (state.data.notifications.delivered[uniqueKey]) return false;
    state.data.notifications.delivered[uniqueKey] = new Date().toISOString();
  }
  state.data.notifications.feed.unshift({
    id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: type || "generic",
    title: title || "Notification",
    body: body || "",
    createdAt: new Date().toISOString()
  });
  state.data.notifications.feed = state.data.notifications.feed.slice(0, 50);
  state.data.notifications.unreadCount = computeUnreadCount(state.data.notifications);
  showToast(`${title || "Notification"} — ${body || ""}`.trim());
  sendBrowserNotification(title || "Notification", body || "");
  return true;
}

function showToast(message){
  const existing = document.getElementById("appToast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "appToast";
  toast.className = "app-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 250);
  }, 4200);
}

function sendBrowserNotification(title, body){
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
      return;
    }
    if (Notification.permission === "default") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") new Notification(title, { body });
      }).catch(() => {});
    }
  } catch {}
}

function openNotificationsCenter(){
  const feed = state.data.notifications?.feed || [];
  if (!feed.length) {
    alert("Aucune notification pour le moment.");
  } else {
    const preview = feed.slice(0, 12)
      .map((item) => `• ${item.title} — ${item.body} (${formatDate(item.createdAt)})`)
      .join("\n");
    alert(`Notifications récentes:\n\n${preview}`);
  }
  if (state.data.notifications) state.data.notifications.lastReadAt = Date.now();
  if (state.data.notifications) state.data.notifications.unreadCount = computeUnreadCount(state.data.notifications);
  saveAll();
  render();
}

function startMatchLifecycleMonitor(){
  if (matchLifecycleInterval) clearInterval(matchLifecycleInterval);
  checkMatchLifecycleNotifications();
  matchLifecycleInterval = setInterval(checkMatchLifecycleNotifications, 60000);
}

function checkMatchLifecycleNotifications(){
  const allMatches = [...(state.matches?.groupStage || []), ...(state.matches?.knockout || [])];
  let changed = false;
  for (const match of allMatches){
    const kickoff = getMatchKickoffDate(match);
    const labels = getMatchDisplayTeams(currentUser() || { picks:{} }, match);
    if (kickoff && new Date() >= kickoff){
      changed = pushAppNotification({
        type: "match_start",
        title: "Début de match",
        body: `${labels.homeLabel} vs ${labels.awayLabel} commence maintenant.`,
        uniqueKey: `match_start_${match.id}`
      }) || changed;
    }
    if (Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)){
      changed = pushAppNotification({
        type: "match_end",
        title: "Fin de match",
        body: `${labels.homeLabel} ${match.scoreHome}-${match.scoreAway} ${labels.awayLabel}.`,
        uniqueKey: `match_end_${match.id}_${match.scoreHome}_${match.scoreAway}`
      }) || changed;
    }
  }
  if (changed) {
    saveAll();
    render();
  }
}

function getMatchKickoffDate(match){
  if (!match?.date) return null;
  const raw = `${match.date}T${match.time || "00:00"}:00`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
