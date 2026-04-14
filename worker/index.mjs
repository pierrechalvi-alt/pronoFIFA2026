const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function json(payload, status = 200){
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function normalizeRoom(value){
  const room = String(value || "global").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
  return room || "global";
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const room = normalizeRoom(url.searchParams.get("room"));
    const stub = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(room));

    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return json({ ok: true, room, service: "prono-fifa-2026", ts: Date.now() });
    }

    if (url.pathname === "/api/snapshot" || url.pathname === "/snapshot") {
      if (request.method === "GET") {
        return stub.fetch(`https://do.internal/snapshot?room=${room}`, { method: "GET" });
      }
      if (request.method === "POST") {
        return stub.fetch(`https://do.internal/snapshot?room=${room}`, {
          method: "POST",
          headers: { "Content-Type": request.headers.get("Content-Type") || "application/json" },
          body: await request.text()
        });
      }
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    if ((url.pathname === "/api/stream" || url.pathname === "/stream") && request.method === "GET") {
      return stub.fetch(`https://do.internal/stream?room=${room}`, { method: "GET" });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }
};

export class SyncRoom {
  constructor(state){
    this.state = state;
    this.clients = new Set();
    this.heartbeat = null;
  }

  async fetch(request){
    const url = new URL(request.url);

    if (url.pathname === "/snapshot" && request.method === "GET") {
      const record = await this.state.storage.get("state");
      return json(record || { updatedAt: 0, snapshot: null });
    }

    if (url.pathname === "/snapshot" && request.method === "POST") {
      const payload = await this.safeJson(request);
      if (!payload?.snapshot) return json({ ok: false, error: "invalid_payload" }, 400);

      const current = (await this.state.storage.get("state")) || { updatedAt: 0, snapshot: null };
      const nextState = {
        updatedAt: Date.now(),
        snapshot: this.mergeSnapshots(current.snapshot || {}, payload.snapshot || {})
      };

      await this.state.storage.put("state", nextState);
      this.broadcast({
        clientId: payload.clientId || null,
        room: normalizeRoom(payload.room || url.searchParams.get("room")),
        updatedAt: nextState.updatedAt,
        snapshot: nextState.snapshot
      });

      return json({ ok: true, updatedAt: nextState.updatedAt });
    }

    if (url.pathname === "/stream" && request.method === "GET") {
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();
      const encoder = new TextEncoder();

      const send = async (line) => {
        try {
          await writer.write(encoder.encode(line));
          return true;
        } catch {
          return false;
        }
      };

      await send("retry: 4000\n\n");
      const existing = (await this.state.storage.get("state")) || { updatedAt: 0, snapshot: null };
      if (existing.snapshot) {
        await send(`data: ${JSON.stringify({ ...existing, room: normalizeRoom(url.searchParams.get("room")) })}\n\n`);
      }

      const client = { send, close: () => writer.close().catch(() => {}) };
      this.clients.add(client);
      this.ensureHeartbeat();

      request.signal?.addEventListener("abort", () => {
        this.clients.delete(client);
        client.close();
        this.stopHeartbeatIfIdle();
      });

      return new Response(stream.readable, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        }
      });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  async safeJson(request){
    try {
      return JSON.parse(await request.text());
    } catch {
      return null;
    }
  }

  mergeSnapshots(baseRaw, incomingRaw){
    const base = this.normalizeDataShape(baseRaw);
    const incoming = this.normalizeDataShape(incomingRaw);

    const users = { ...base.users };
    for (const [key, incomingUser] of Object.entries(incoming.users || {})) {
      const existing = users[key] || {};
      users[key] = {
        ...existing,
        ...incomingUser,
        profile: incomingUser.profile || existing.profile,
        picks: { ...(existing.picks || {}), ...(incomingUser.picks || {}) },
        qualifiers: { ...(existing.qualifiers || {}), ...(incomingUser.qualifiers || {}) }
      };
    }

    const comments = new Map();
    for (const comment of [...(base.thirdHalf?.comments || []), ...(incoming.thirdHalf?.comments || [])]) {
      const existing = comments.get(comment.id) || { replies: [] };
      const replies = new Map([...(existing.replies || []), ...(comment.replies || [])].map((reply) => [reply.id, reply]));
      comments.set(comment.id, {
        ...existing,
        ...comment,
        likes: { ...(existing.likes || {}), ...(comment.likes || {}) },
        replies: [...replies.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      });
    }

    const notifications = new Map();
    for (const item of [...(base.notifications?.feed || []), ...(incoming.notifications?.feed || [])]) {
      notifications.set(item.id, item);
    }

    return this.normalizeDataShape({
      ...base,
      ...incoming,
      users,
      thirdHalf: {
        comments: [...comments.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      },
      notifications: {
        feed: [...notifications.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50),
        lastReadAt: Math.max(Number(base.notifications?.lastReadAt || 0), Number(incoming.notifications?.lastReadAt || 0)),
        delivered: { ...(base.notifications?.delivered || {}), ...(incoming.notifications?.delivered || {}) }
      },
      lastUserKey: incoming.lastUserKey || base.lastUserKey,
      updatedAt: Math.max(Number(base.updatedAt || 0), Number(incoming.updatedAt || 0))
    });
  }

  normalizeDataShape(raw){
    const parsed = raw && typeof raw === "object" ? { ...raw } : {};
    if (!parsed.thirdHalf || !Array.isArray(parsed.thirdHalf.comments)) parsed.thirdHalf = { comments: [] };
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
    if (!parsed.notifications.delivered || typeof parsed.notifications.delivered !== "object") {
      parsed.notifications.delivered = {};
    }
    const lastReadAt = Number(parsed.notifications.lastReadAt || 0);
    parsed.notifications.lastReadAt = Number.isFinite(lastReadAt) ? lastReadAt : 0;
    parsed.notifications.unreadCount = this.computeUnreadCount(parsed.notifications);
    return parsed;
  }

  computeUnreadCount(notifications){
    const feed = Array.isArray(notifications?.feed) ? notifications.feed : [];
    const lastReadAt = Number(notifications?.lastReadAt || 0);
    let unread = 0;
    for (const item of feed) {
      const createdAt = new Date(item?.createdAt || 0).getTime();
      if (Number.isFinite(createdAt) && createdAt > lastReadAt) unread += 1;
    }
    return Math.min(99, unread);
  }

  async broadcast(payload){
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    const dead = [];
    for (const client of this.clients) {
      const ok = await client.send(line);
      if (!ok) dead.push(client);
    }
    for (const client of dead) {
      this.clients.delete(client);
      client.close();
    }
    this.stopHeartbeatIfIdle();
  }

  ensureHeartbeat(){
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.broadcast({ event: "heartbeat", ts: Date.now() }).catch(() => {});
    }, 15000);
  }

  stopHeartbeatIfIdle(){
    if (this.clients.size > 0) return;
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
