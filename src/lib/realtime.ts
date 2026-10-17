// Outline's live updates. Desktop: the Rust side holds the socket (it needs the session cookie)
// and forwards events. Web: we're on Outline's origin, so a plain websocket carries the cookie.

import { isTauri } from "./platform";
import { isDemo } from "./demo";

export interface RealtimeEvent {
  event: string;
  data: unknown;
}

type Handler = (e: RealtimeEvent) => void;
const handlers = new Set<Handler>();
let started = false;

const dispatch = (e: RealtimeEvent) => handlers.forEach((h) => h(e));

/** Minimal Engine.IO v4 / socket.io client, websocket only (same protocol as realtime.rs). */
function connectWeb(delay = 1000) {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/realtime/?EIO=4&transport=websocket`);
  ws.onmessage = (msg) => {
    const text = String(msg.data);
    if (text === "2") return ws.send("3");
    if (text.startsWith("0")) return ws.send("40");
    if (text.startsWith("40")) return dispatch({ event: "connected", data: null });
    if (text.startsWith("42")) {
      try {
        const [event, data] = JSON.parse(text.slice(text.indexOf("[")));
        dispatch({ event, data });
      } catch {
        // Not an event we understand.
      }
    }
  };
  ws.onclose = () => {
    dispatch({ event: "disconnected", data: null });
    setTimeout(() => connectWeb(Math.min(delay * 2, 60_000)), delay);
  };
}

async function start() {
  if (started || isDemo) return;
  started = true;
  if (isTauri) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<RealtimeEvent>("realtime", (e) => dispatch(e.payload));
  } else connectWeb();
}

/** Subscribes to live events; returns the unsubscribe function. */
export function onRealtime(handler: Handler): () => void {
  handlers.add(handler);
  void start();
  return () => handlers.delete(handler);
}

/** Collection ids an event touches, whatever its shape. */
export function collectionIdsOf(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const d = data as { collectionId?: string; collectionIds?: ({ id: string } | string)[] };
  const ids = (d.collectionIds ?? []).map((c) => (typeof c === "string" ? c : c.id));
  if (d.collectionId) ids.push(d.collectionId);
  return ids;
}

/** Document ids an event touches. */
export function documentIdsOf(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const d = data as { id?: string; documentId?: string; modelId?: string; documentIds?: ({ id: string } | string)[] };
  const ids = (d.documentIds ?? []).map((c) => (typeof c === "string" ? c : c.id));
  for (const id of [d.documentId, d.id, d.modelId]) if (id) ids.push(id);
  return ids;
}
