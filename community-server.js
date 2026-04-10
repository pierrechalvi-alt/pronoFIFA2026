const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.COMMUNITY_PORT || process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const DB_FILE = process.env.COMMUNITY_DB_FILE || path.join(__dirname, "data", "community-sync.json");
const WEB_ROOT = process.env.COMMUNITY_WEB_ROOT || __dirname;
const FIFA_SOURCE_URL = process.env.FIFA_SOURCE_URL
  || "https://www.fifa.com/fr/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures?country=&wtw-filter=ALL";
const FIFA_CACHE_TTL_MS = Number(process.env.FIFA_CACHE_TTL_MS || 60000);

let roomsState = { global: { updatedAt: 0, snapshot: null } };
const streamClients = new Map();
let heartbeatInterval = null;
let fifaCache = { fetchedAt: 0, payload: { source: FIFA_SOURCE_URL, matches: [] } };

boot();

function boot(){
  roomsState = loadSnapshotStore();
  const server = http.createServer(async (req, res) => {
    setCors(res);
    const requestUrl = parseRequestUrl(req.url);
    const pathname = requestUrl.pathname;
    const room = resolveRoom(requestUrl.searchParams.get("room"));
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (isPath(pathname, ["/api/health", "/health"]) && req.method === "GET") {
      const state = getRoomState(room);
      return sendJson(res, 200, { ok: true, room, updatedAt: state.updatedAt, rooms: Object.keys(roomsState).length });
    }

    if (isPath(pathname, ["/api/snapshot", "/snapshot"]) && req.method === "GET") {
      return sendJson(res, 200, getRoomState(room));
    }

    if (isPath(pathname, ["/api/snapshot", "/snapshot"]) && req.method === "POST") {
      const body = await readBody(req);
      const parsed = safeJsonParse(body);
      if (!parsed || typeof parsed !== "object" || !parsed.snapshot) {
        return sendJson(res, 400, { ok: false, error: "invalid_payload" });
      }
      const currentState = getRoomState(resolveRoom(parsed.room || room));
      const mergedSnapshot = mergeSnapshots(currentState.snapshot || {}, parsed.snapshot || {});
      const nextState = {
        updatedAt: Date.now(),
        snapshot: mergedSnapshot
      };
      const targetRoom = resolveRoom(parsed.room || room);
      roomsState[targetRoom] = nextState;
      persistSnapshotStore(roomsState);
      broadcastToRoom(targetRoom, {
        clientId: parsed.clientId || null,
        room: targetRoom,
        updatedAt: nextState.updatedAt,
        snapshot: nextState.snapshot
      });
      return sendJson(res, 200, { ok: true, room: targetRoom, updatedAt: nextState.updatedAt });
    }

    if (isPath(pathname, ["/api/stream", "/stream"]) && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write("retry: 4000\n\n");
      const roomClients = streamClients.get(room) || new Set();
      roomClients.add(res);
      streamClients.set(room, roomClients);
      ensureHeartbeat();
      const state = getRoomState(room);
      if (state.snapshot) {
        res.write(`data: ${JSON.stringify({ ...state, room })}\n\n`);
      }
      req.on("close", () => {
        roomClients.delete(res);
        if (roomClients.size === 0) streamClients.delete(room);
        stopHeartbeatIfIdle();
      });
      return;
    }

    if (isPath(pathname, ["/api/fifa/live", "/fifa/live"]) && req.method === "GET") {
      try {
        const payload = await getFifaLivePayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: "fifa_unavailable", detail: err?.message || String(err) });
      }
    }

    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res);
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Community sync server running on http://${HOST}:${PORT}`);
    console.log(`Snapshot file: ${DB_FILE}`);
    console.log(`Web root: ${WEB_ROOT}`);
  });
}

function getPathname(urlValue){
  return parseRequestUrl(urlValue).pathname;
}

function parseRequestUrl(urlValue){
  try {
    return new URL(urlValue || "/", "http://localhost");
  } catch {
    return new URL("/", "http://localhost");
  }
}

function resolveRoom(rawRoom){
  const candidate = String(rawRoom || "global").trim().toLowerCase();
  return candidate.replace(/[^a-z0-9_-]/g, "").slice(0, 64) || "global";
}

function getRoomState(room){
  if (!roomsState[room]) {
    roomsState[room] = { updatedAt: 0, snapshot: null };
  }
  return roomsState[room];
}

function isPath(pathname, candidates){
  return candidates.includes(pathname) || candidates.includes(pathname.endsWith("/") ? pathname.slice(0, -1) : pathname);
}

function setCors(res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(res, status, payload){
  const raw = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(raw);
}

function readBody(req){
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) req.destroy();
    });
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(""));
  });
}

function safeJsonParse(raw){
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function loadSnapshotStore(){
  try {
    if (!fs.existsSync(DB_FILE)) return { global: { updatedAt: 0, snapshot: null } };
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { global: { updatedAt: 0, snapshot: null } };
    if (parsed.rooms && typeof parsed.rooms === "object") {
      return Object.entries(parsed.rooms).reduce((acc, [room, value]) => {
        acc[resolveRoom(room)] = {
          updatedAt: Number(value?.updatedAt || 0),
          snapshot: value?.snapshot || null
        };
        return acc;
      }, { global: { updatedAt: 0, snapshot: null } });
    }
    return {
      global: {
        updatedAt: Number(parsed.updatedAt || 0),
        snapshot: parsed.snapshot || null
      }
    };
  } catch {
    return { global: { updatedAt: 0, snapshot: null } };
  }
}

function normalizeDataShape(raw){
  const parsed = raw && typeof raw === "object" ? { ...raw } : {};
  if (!parsed.thirdHalf || !Array.isArray(parsed.thirdHalf.comments)) {
    parsed.thirdHalf = { comments: [] };
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
  for (const item of feed) {
    const createdAt = new Date(item?.createdAt || 0).getTime();
    if (Number.isFinite(createdAt) && createdAt > lastReadAt) unread += 1;
  }
  return Math.min(99, unread);
}

function mergeSnapshots(baseRaw, incomingRaw){
  const base = normalizeDataShape(baseRaw);
  const incoming = normalizeDataShape(incomingRaw);
  const mergedUsers = { ...base.users };

  for (const [key, incomingUser] of Object.entries(incoming.users || {})) {
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
      qualifiers: { ...(existingUser.qualifiers || {}), ...(incomingUser.qualifiers || {}) }
    };
  }

  const commentMap = new Map();
  for (const comment of [...(base.thirdHalf?.comments || []), ...(incoming.thirdHalf?.comments || [])]) {
    const existing = commentMap.get(comment.id);
    if (!existing) {
      commentMap.set(comment.id, { ...comment, replies: Array.isArray(comment.replies) ? comment.replies : [] });
      continue;
    }
    const repliesMap = new Map();
    for (const reply of [...(existing.replies || []), ...((comment.replies || []))]) {
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
  for (const notification of [...(base.notifications?.feed || []), ...(incoming.notifications?.feed || [])]) {
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
    lastUserKey: incoming.lastUserKey || base.lastUserKey,
    updatedAt: Math.max(Number(base.updatedAt || 0), Number(incoming.updatedAt || 0))
  });
}

function persistSnapshotStore(payload){
  try {
    const dir = path.dirname(DB_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify({ rooms: payload }), "utf8");
  } catch (err) {
    console.error("Failed to persist community snapshot:", err?.message || err);
  }
}

function broadcastToRoom(room, payload){
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  const clients = streamClients.get(room) || new Set();
  for (const client of clients) {
    try {
      client.write(line);
    } catch {
      clients.delete(client);
    }
  }
  if (clients.size === 0) streamClients.delete(room);
}

function ensureHeartbeat(){
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    const beat = `event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`;
    for (const [room, clients] of streamClients.entries()) {
      for (const client of clients) {
        try {
          client.write(beat);
        } catch {
          clients.delete(client);
        }
      }
      if (clients.size === 0) streamClients.delete(room);
    }
    stopHeartbeatIfIdle();
  }, 15000);
}

function stopHeartbeatIfIdle(){
  if (streamClients.size > 0) return;
  if (!heartbeatInterval) return;
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

function serveStatic(req, res){
  const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(normalizedPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const absolutePath = path.join(WEB_ROOT, safePath);

  if (!absolutePath.startsWith(path.normalize(WEB_ROOT + path.sep))) {
    return sendJson(res, 403, { ok: false, error: "forbidden" });
  }
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
    return sendJson(res, 404, { ok: false, error: "not_found" });
  }
  const mime = getMimeType(absolutePath);
  res.writeHead(200, { "Content-Type": mime });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(absolutePath).pipe(res);
}

function getMimeType(filePath){
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webmanifest": return "application/manifest+json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function getFifaLivePayload(){
  const now = Date.now();
  if (now - fifaCache.fetchedAt < FIFA_CACHE_TTL_MS) return fifaCache.payload;
  const html = await fetchTextWithTimeout(FIFA_SOURCE_URL, 12000);
  const matches = extractFifaMatches(html);
  const payload = {
    source: FIFA_SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    matches
  };
  fifaCache = { fetchedAt: now, payload };
  return payload;
}

async function fetchTextWithTimeout(url, timeoutMs){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (community-sync-bridge)" }
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractFifaMatches(html){
  const candidates = [];
  const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch?.[1]) candidates.push(safeJsonParse(nextDataMatch[1]));
  const ldJsonMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldJsonMatches) candidates.push(safeJsonParse(m[1]));

  const extracted = [];
  for (const candidate of candidates.filter(Boolean)) {
    extracted.push(...collectMatchObjects(candidate));
  }
  return normalizeFifaMatches(extracted);
}

function collectMatchObjects(node, bag = []){
  if (!node || typeof node !== "object") return bag;
  if (Array.isArray(node)) {
    for (const entry of node) collectMatchObjects(entry, bag);
    return bag;
  }
  const hasTeams = node.homeTeam || node.awayTeam || node.home || node.away || node.participants;
  const hasScore = node.score || node.homeScore || node.awayScore || node.result || node.status;
  if (hasTeams && hasScore) bag.push(node);
  for (const value of Object.values(node)) collectMatchObjects(value, bag);
  return bag;
}

function normalizeFifaMatches(entries){
  const normalized = [];
  for (const item of entries) {
    const idRaw = item.id ?? item.matchId ?? item.fixtureId ?? item.code;
    const id = Number(idRaw);
    if (!Number.isFinite(id)) continue;
    const homeName = extractTeamName(item.homeTeam || item.home || item.participants?.[0] || item.teams?.[0]);
    const awayName = extractTeamName(item.awayTeam || item.away || item.participants?.[1] || item.teams?.[1]);
    const scoreHome = extractScore(item, "home");
    const scoreAway = extractScore(item, "away");
    normalized.push({
      id,
      home: homeName || null,
      away: awayName || null,
      scoreHome: Number.isFinite(scoreHome) ? scoreHome : null,
      scoreAway: Number.isFinite(scoreAway) ? scoreAway : null,
      status: item.status || item.matchStatus || item.stage || null,
      date: item.utcDate || item.date || item.startDate || null
    });
  }
  const dedup = new Map();
  for (const match of normalized) dedup.set(match.id, match);
  return [...dedup.values()].sort((a, b) => a.id - b.id);
}

function extractTeamName(teamNode){
  if (!teamNode) return "";
  if (typeof teamNode === "string") return teamNode;
  return String(teamNode.name || teamNode.shortName || teamNode.teamName || teamNode.displayName || "").trim();
}

function extractScore(item, side){
  const sideKey = side === "home" ? "home" : "away";
  const direct = Number(item?.[`${sideKey}Score`] ?? item?.score?.[sideKey] ?? item?.result?.[sideKey]);
  if (Number.isFinite(direct)) return direct;
  const teams = Array.isArray(item?.score?.teams) ? item.score.teams : Array.isArray(item?.result?.teams) ? item.result.teams : null;
  if (teams?.length >= 2) {
    const index = side === "home" ? 0 : 1;
    const value = Number(teams[index]?.score ?? teams[index]?.goals);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
