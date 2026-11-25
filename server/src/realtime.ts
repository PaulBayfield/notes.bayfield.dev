// Live updates at /realtime/: Outline's socket.io endpoint, websocket transport only (Engine.IO v4,
// socket.io v5), which is all the web and desktop apps speak: open, connect to "/", ping/pong, events.
//
// Authenticated by the accessToken cookie. Every change announced on the bus goes to the people who can
// see it, as two events like Outline's: the named one ("documents.update", {…}) and "entities"
// ({ event, documentIds, collectionIds }), which clients use to refetch what changed.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { sql } from "./db.ts";
import { Access } from "./access.ts";
import { userFromCookieHeader } from "./auth.ts";
import { bus, type ChangeEvent } from "./events.ts";
import type { UserRow } from "./users.ts";

const PING_MS = 25_000;
const ACCESS_TTL_MS = 15_000;

interface Client {
  ws: WebSocket;
  user: UserRow;
  connected: boolean;
  access?: { value: Access; at: number };
  alive: boolean;
}

const clients = new Set<Client>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
const sid = () => randomBytes(15).toString("base64url");

async function accessOf(c: Client): Promise<Access> {
  if (!c.access || Date.now() - c.access.at > ACCESS_TTL_MS) c.access = { value: await Access.for(c.user), at: Date.now() };
  return c.access.value;
}

function send(c: Client, event: string, data: unknown) {
  if (c.connected && c.ws.readyState === c.ws.OPEN) c.ws.send(`42${JSON.stringify([event, data])}`);
}

/** Takes /realtime/ upgrades; returns false for anything else. */
export function handleRealtimeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/realtime")) return false;
  void userFromCookieHeader(req.headers.cookie).then((user) => {
    if (!user || url.searchParams.get("transport") !== "websocket") {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, user, connected: false, alive: true };
      clients.add(client);
      ws.send(`0${JSON.stringify({ sid: sid(), upgrades: [], pingInterval: PING_MS, pingTimeout: 20_000, maxPayload: 1_000_000 })}`);
      ws.on("message", (raw) => {
        const text = raw.toString();
        client.alive = true;
        if (text === "3") return;
        if (text.startsWith("40")) {
          client.connected = true;
          ws.send(`40${JSON.stringify({ sid: sid() })}`);
        } else if (text === "41") ws.close();
      });
      ws.on("close", () => clients.delete(client));
      ws.on("error", () => clients.delete(client));
    });
  });
  return true;
}

// Pings (the client answers "3"); a client silent for a whole round is gone.
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) {
      c.ws.terminate();
      clients.delete(c);
      continue;
    }
    c.alive = false;
    if (c.ws.readyState === c.ws.OPEN) c.ws.send("2");
  }
}, PING_MS).unref();

// Changes, to whoever can see them.
bus.on("change", async (e: ChangeEvent) => {
  if (!clients.size || e.name === "documents.content") return;
  // Membership changes alter what people can see: refresh their access first.
  if (/add_user|remove_user|add_group|remove_group|groups\./.test(e.name)) for (const c of clients) c.access = undefined;
  const doc = e.documentId
    ? (await sql<{ id: string; collectionId: string | null; createdById: string | null; publishedAt: Date | null; archivedAt: Date | null; deletedAt: Date | null; isTemplate: boolean; updatedAt: Date }[]>`
        SELECT id, collection_id, created_by_id, published_at, archived_at, deleted_at, is_template, updated_at FROM documents WHERE id = ${e.documentId}`)[0]
    : undefined;
  const entities = {
    event: e.name,
    documentIds: e.documentId ? [{ id: e.documentId, updatedAt: (doc?.updatedAt ?? new Date()).toISOString() }] : [],
    collectionIds: e.collectionId ? [{ id: e.collectionId, updatedAt: new Date().toISOString() }] : [],
  };
  for (const c of clients) {
    if (c.user.teamId !== e.teamId || !c.connected) continue;
    let visible: boolean;
    if (e.userIds?.length) visible = e.userIds.includes(c.user.id);
    else if (e.documentId) {
      const a = await accessOf(c);
      // A document that was just removed for good can't be checked any more: its collection decides.
      visible = doc ? !!a.document(doc) : e.collectionId ? !!a.collection(e.collectionId) : true;
    } else if (e.collectionId) visible = !!(await accessOf(c)).collection(e.collectionId) || e.name === "collections.delete";
    else visible = true;
    if (!visible) continue;
    send(c, e.name, e.data);
    if (e.documentId || e.collectionId) send(c, "entities", entities);
  }
});

export const realtimeClients = () => clients.size;
