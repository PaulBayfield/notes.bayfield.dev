// Changes announced inside the server: the realtime socket relays them to the people they concern
// (Outline's event names: documents.update, collections.create, …), the collaboration server
// listens for content written through the API, caches forget what changed.
//
// With several instances, every change also goes through Postgres (LISTEN/NOTIFY): each instance hears
// the others' and announces them locally, so a person connected to one instance sees what was done on
// another. Postgres caps a notification at 8000 bytes; a bigger one travels without its data (clients
// refetch from the ids).

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { sql } from "./db.ts";
import { currentRequest } from "./context.ts";

export interface ChangeEvent {
  /** Outline's event name, e.g. "documents.update". */
  name: string;
  /** What the socket sends along (Outline sends the changed models' ids, or the models). */
  data: Record<string, unknown>;
  teamId: string;
  /** Who it concerns: a collection's readers, a document's, or specific users. */
  collectionId?: string | null;
  documentId?: string | null;
  userIds?: string[];
  actorId?: string | null;
  /** For the events log: what changed, field by field (not sent to clients). */
  changes?: Changes | null;
}

export type Changes = Record<string, { from: unknown; to: unknown }>;

/** The fields that differ between two versions of a row, as the events log keeps them; null when none. */
export function diff<T extends object>(before: T, after: T, fields: (keyof T)[]): Changes | null {
  const out: Changes = {};
  for (const f of fields) {
    const [a, b] = [before[f] ?? null, after[f] ?? null];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[String(f)] = { from: a, to: b };
  }
  return Object.keys(out).length ? out : null;
}

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const CHANNEL = "notes_changes";
/** This process, so it doesn't announce its own changes twice. */
const INSTANCE = randomUUID();
const MAX_PAYLOAD = 7900;

/**
 * What goes in the events log (events.list, the audit log): what people did, not every keystroke
 * (documents.update is a save; the revisions keep those) nor personal things (stars, pins, views).
 */
const LOGGED = new Set(
  Object.entries({
    documents: "create publish unpublish archive restore delete permanent_delete move add_user remove_user add_group remove_group",
    collections: "create update delete archive restore move add_user remove_user add_group remove_group",
    comments: "create delete",
    groups: "create update delete add_user remove_user",
    users: "create update_role suspend activate delete invite promote demote",
    shares: "create update revoke",
    teams: "create update",
    apiKeys: "create delete",
    emojis: "create delete",
  }).flatMap(([model, verbs]) => verbs.split(" ").map((v) => `${model}.${v}`)),
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(e: ChangeEvent) {
  if (!LOGGED.has(e.name)) return;
  const modelId = typeof e.data.id === "string" && UUID.test(e.data.id) ? e.data.id : null;
  const userId = typeof e.data.userId === "string" && UUID.test(e.data.userId) ? e.data.userId : null;
  // The request it came from: its address, its client, how it signed in.
  const req = currentRequest();
  void sql`
    INSERT INTO events (team_id, name, actor_id, user_id, model_id, collection_id, document_id, data, changes, ip, user_agent, via)
    VALUES (${e.teamId}, ${e.name}, ${e.actorId ?? null}, ${userId}, ${modelId}, ${e.collectionId ?? null}, ${e.documentId ?? null}, ${sql.json(e.data as never)},
            ${e.changes ? sql.json(e.changes as never) : null}, ${req?.ip ?? null}, ${req?.userAgent ?? null}, ${req?.via ?? null})`.catch((err) => console.warn("Couldn't log an event:", err));
}

/** An entry in the events log only (no live update): people's roles, shared links… */
export function audit(e: ChangeEvent) {
  record(e);
}

export function publish(e: ChangeEvent) {
  bus.emit("change", e);
  record(e);
  let payload = JSON.stringify({ from: INSTANCE, e: { ...e, changes: undefined } });
  if (payload.length > MAX_PAYLOAD) {
    const ids = Object.fromEntries(Object.entries(e.data).filter(([k]) => k === "id" || k.endsWith("Id")));
    payload = JSON.stringify({ from: INSTANCE, e: { ...e, data: ids } });
  }
  void sql.notify(CHANNEL, payload).catch((err) => console.warn("Couldn't announce a change to the other instances:", err));
}

/** Listens for the other instances' changes (once, at startup). */
export async function listenToOtherInstances() {
  await sql.listen(CHANNEL, (payload) => {
    try {
      const { from, e } = JSON.parse(payload) as { from: string; e: ChangeEvent };
      if (from !== INSTANCE) bus.emit("change", e);
    } catch {
      // Not ours.
    }
  });
}
