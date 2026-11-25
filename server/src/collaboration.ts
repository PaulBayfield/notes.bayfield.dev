// Live collaboration: a Hocuspocus server (protocol v1, as Outline's) at /collaboration/document.<id>,
// authenticated with auth.info's collaborationToken.
//
// The Yjs state is the source of truth while people edit. Each save (a few seconds after the last
// change) also writes the ProseMirror JSON, the Markdown and the task count, adds the editors to the
// document's collaborators, and records a revision at most every five minutes, as Outline does.
// Content written through the API while the document is open is swapped in live.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Server, type Document } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { sql } from "./db.ts";
import { Access, atLeast } from "./access.ts";
import { verifyCollaborationToken } from "./auth.ts";
import { docToState, EDITOR_VERSION, replaceContent, ydocToDoc, type DocJSON } from "./editor.bundle.mjs";
import { bus, publish, type ChangeEvent } from "./events.ts";
import { toMarkdown, type PMNode } from "./markdown.ts";
import { getUser } from "./users.ts";
import { notify, subscribers } from "./notify.ts";

/** Close codes Outline's clients understand (shared/collaboration/CloseEvents.ts). */
const CLOSE = { authenticationFailed: 4401, authorizationFailed: 4403, editorUpdate: 4999 };
const REVISION_EVERY_MS = 5 * 60_000;
const UUID = /^document\.([0-9a-f-]{36})$/i;

interface Context {
  userId: string;
  documentId: string;
}

/** Who edited each open document since its last save (its collaborators, and the next revision's). */
const editors = new Map<string, Set<string>>();
/** …and since its last revision. */
const revisionEditors = new Map<string, Set<string>>();

const major = (v: string | null | undefined) => Number(String(v ?? "").split(".")[0]) || 0;

const hocuspocus = Server.configure({
  quiet: true,
  debounce: 3000,
  maxDebounce: 10_000,
  timeout: 30_000,

  async onAuthenticate({ token, documentName, connection }) {
    const userId = verifyCollaborationToken(token);
    if (!userId) throw new Error("Authentication required");
    const id = documentName.match(UUID)?.[1];
    const user = await getUser(userId);
    if (!id || !user || user.deletedAt || user.suspendedAt) throw new Error("Authentication required");
    const [doc] = await sql<{ id: string; collectionId: string | null; createdById: string | null; publishedAt: Date | null; archivedAt: Date | null; deletedAt: Date | null; isTemplate: boolean }[]>`
      SELECT id, collection_id, created_by_id, published_at, archived_at, deleted_at, is_template FROM documents WHERE id = ${id} AND team_id = ${user.teamId}`;
    if (!doc) throw new Error("Not found");
    const a = await Access.for(user);
    const perm = a.document(doc);
    if (!perm) throw new Error("Authorization error");
    // Viewers, read-only access, archived and deleted documents: watch, don't edit.
    if (!atLeast(perm, "read_write") || user.role === "viewer" || doc.archivedAt || doc.deletedAt) connection.readOnly = true;
    return { userId, documentId: id } satisfies Context;
  },

  async onLoadDocument({ document, documentName }) {
    const id = documentName.match(UUID)?.[1];
    if (!id) return document;
    const [row] = await sql<{ state: Buffer | null; content: DocJSON | null }[]>`SELECT state, content FROM documents WHERE id = ${id}`;
    if (row?.state?.length) Y.applyUpdate(document, new Uint8Array(row.state));
    else if (row?.content) Y.applyUpdate(document, docToState(row.content));
    return document;
  },

  async connected({ documentName, context }) {
    const id = documentName.match(UUID)?.[1];
    const userId = (context as Context | undefined)?.userId;
    if (!id || !userId) return;
    // Opening a document counts as viewing it.
    await sql`INSERT INTO views (user_id, document_id) VALUES (${userId}, ${id}) ON CONFLICT (user_id, document_id) DO UPDATE SET count = views.count + 1, last_viewed_at = now()`;
  },

  async onChange({ documentName, context }) {
    const userId = (context as Context | undefined)?.userId;
    if (!userId) return;
    for (const map of [editors, revisionEditors]) {
      const set = map.get(documentName) ?? new Set();
      set.add(userId);
      map.set(documentName, set);
    }
  },

  async onStoreDocument({ document, documentName }) {
    await store(documentName, document);
  },
});

async function store(documentName: string, document: Document) {
  const id = documentName.match(UUID)?.[1];
  if (!id) return;
  const changedBy = [...(editors.get(documentName) ?? [])];
  editors.delete(documentName);
  const json = ydocToDoc(document);
  const text = toMarkdown(json as PMNode);
  const state = Buffer.from(Y.encodeStateAsUpdate(document));
  const lastEditor = changedBy.at(-1) ?? null;
  const [row] = await sql<{ teamId: string; collectionId: string | null; title: string; icon: string | null; color: string | null; text: string; updatedAt: Date }[]>`
    UPDATE documents SET state = ${state}, content = ${sql.json(json as never)}, text = ${text},
      ${lastEditor ? sql`last_modified_by_id = ${lastEditor}, updated_at = now(), revision_count = revision_count + 1,
        collaborator_ids = ARRAY(SELECT DISTINCT unnest(collaborator_ids || ${changedBy}::uuid[])),` : sql``}
      id = id
    WHERE id = ${id}
    RETURNING team_id, collection_id, title, icon, color, text, updated_at`;
  if (!row || !lastEditor) return;

  // A revision at most every few minutes, with whoever edited since the last one.
  const [last] = await sql<{ createdAt: Date }[]>`SELECT created_at FROM revisions WHERE document_id = ${id} ORDER BY created_at DESC LIMIT 1`;
  if (!last || Date.now() - last.createdAt.getTime() > REVISION_EVERY_MS) {
    const collaborators = [...(revisionEditors.get(documentName) ?? new Set(changedBy))];
    revisionEditors.delete(documentName);
    const [rev] = await sql<{ id: string }[]>`
      INSERT INTO revisions (document_id, user_id, title, icon, color, text, content, collaborator_ids)
      VALUES (${id}, ${lastEditor}, ${row.title}, ${row.icon}, ${row.color}, ${text}, ${sql.json(json as never)}, ${collaborators}::uuid[])
      RETURNING id`;
    // Subscribers hear about it (not the people who made the change).
    const watchers = (await subscribers(id, row.collectionId)).filter((u) => !collaborators.includes(u));
    await notify(row.teamId, watchers, { event: "documents.update", actorId: lastEditor, documentId: id, collectionId: row.collectionId, revisionId: rev.id });
  }
  publish({ name: "documents.update", data: { id, collectionId: row.collectionId, updatedAt: row.updatedAt.toISOString() }, teamId: row.teamId, collectionId: row.collectionId, documentId: id, actorId: lastEditor });
}

// Content written through the API (documents.update with text, a revision restored…) while the
// document is open: everyone editing it gets it at once.
bus.on("change", async (e: ChangeEvent) => {
  if (!e.documentId) return;
  const name = `document.${e.documentId}`;
  const open = hocuspocus.documents.get(name);
  if (!open) return;
  if (e.name === "documents.content") {
    const [row] = await sql<{ content: DocJSON | null }[]>`SELECT content FROM documents WHERE id = ${e.documentId}`;
    if (row?.content) replaceContent(open, row.content);
  } else if (e.name === "documents.delete" || e.name === "documents.permanent_delete" || e.name === "documents.archive") {
    hocuspocus.closeConnections(name);
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });

/** Takes /collaboration/… upgrades; returns false for anything else. */
export function handleCollaborationUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/collaboration/")) return false;
  const documentName = decodeURIComponent(url.pathname.slice("/collaboration/".length).replace(/\/+$/, ""));
  wss.handleUpgrade(req, socket, head, (ws) => {
    // An editor a major version behind can't open documents safely: Outline asks it to reload.
    if (major(url.searchParams.get("editorVersion")) < major(EDITOR_VERSION)) return ws.close(CLOSE.editorUpdate, "Editor update required");
    hocuspocus.handleConnection(ws as never, req, documentName);
  });
  return true;
}

/** Saves every open document (shutting down). */
export async function flushCollaboration() {
  await Promise.all([...hocuspocus.documents.entries()].map(([name, doc]) => store(name, doc).catch((e) => console.warn("Couldn't save", name, e))));
}

