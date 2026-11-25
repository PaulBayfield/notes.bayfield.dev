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
}

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const CHANNEL = "notes_changes";
/** This process, so it doesn't announce its own changes twice. */
const INSTANCE = randomUUID();
const MAX_PAYLOAD = 7900;

export function publish(e: ChangeEvent) {
  bus.emit("change", e);
  let payload = JSON.stringify({ from: INSTANCE, e });
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
