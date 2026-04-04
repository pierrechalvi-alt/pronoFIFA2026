const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const DB_FILE = process.env.COMMUNITY_DB_FILE || path.join(__dirname, "data", "community-sync.json");

let snapshotState = {
  updatedAt: 0,
  snapshot: null
};
const clients = new Set();

boot();

function boot(){
  snapshotState = loadSnapshot();
  const server = http.createServer(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (req.url === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, updatedAt: snapshotState.updatedAt });
    }

    if (req.url === "/api/snapshot" && req.method === "GET") {
      return sendJson(res, 200, snapshotState);
    }

    if (req.url === "/api/snapshot" && req.method === "POST") {
      const body = await readBody(req);
      const parsed = safeJsonParse(body);
      if (!parsed || typeof parsed !== "object" || !parsed.snapshot) {
        return sendJson(res, 400, { ok: false, error: "invalid_payload" });
      }
      const incomingUpdatedAt = Number(parsed.updatedAt || 0);
      if (incomingUpdatedAt >= Number(snapshotState.updatedAt || 0)) {
        snapshotState = {
          updatedAt: incomingUpdatedAt || Date.now(),
          snapshot: parsed.snapshot
        };
        persistSnapshot(snapshotState);
        broadcast({
          clientId: parsed.clientId || null,
          updatedAt: snapshotState.updatedAt,
          snapshot: snapshotState.snapshot
        });
      }
      return sendJson(res, 200, { ok: true, updatedAt: snapshotState.updatedAt });
    }

    if (req.url === "/api/stream" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write("\n");
      clients.add(res);
      if (snapshotState.snapshot) {
        res.write(`data: ${JSON.stringify(snapshotState)}\n\n`);
      }
      req.on("close", () => clients.delete(res));
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Community sync server running on http://${HOST}:${PORT}`);
    console.log(`Snapshot file: ${DB_FILE}`);
  });
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

function loadSnapshot(){
  try {
    if (!fs.existsSync(DB_FILE)) return { updatedAt: 0, snapshot: null };
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { updatedAt: 0, snapshot: null };
    return {
      updatedAt: Number(parsed.updatedAt || 0),
      snapshot: parsed.snapshot || null
    };
  } catch {
    return { updatedAt: 0, snapshot: null };
  }
}

function persistSnapshot(payload){
  try {
    const dir = path.dirname(DB_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(payload), "utf8");
  } catch (err) {
    console.error("Failed to persist community snapshot:", err?.message || err);
  }
}

function broadcast(payload){
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(line);
    } catch {
      clients.delete(client);
    }
  }
}
