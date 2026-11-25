// Changes announced inside the server: the realtime socket relays them to the people they concern
// (Outline's event names: documents.update, collections.create, …), the collaboration server
// listens for content written through the API.

import { EventEmitter } from "node:events";

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
  actorId?: string;
}

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(e: ChangeEvent) {
  bus.emit("change", e);
}
