// Mentions in a document's text, as Outline: whoever is newly mentioned in a published document is told
// once (documents.mentioned), and the members of a mentioned group (documents.group_mentioned), when
// they can read it. Hooked on the change bus, so every way of saving (the editor, the API, publishing,
// another instance) counts; the document_mentions table makes it happen once, whichever instance hears it.

import { sql } from "./db.ts";
import { bus, type ChangeEvent } from "./events.ts";
import { Access, type DocLike } from "./access.ts";
import { notify } from "./notify.ts";
import { getUser } from "./users.ts";

interface PMNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
}

/** The people and groups mentioned in a ProseMirror document. */
export function mentionsIn(doc: unknown) {
  const users = new Set<string>();
  const groups = new Set<string>();
  const walk = (n: PMNode | undefined) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "mention" && typeof n.attrs?.modelId === "string") (n.attrs.type === "group" ? groups : users).add(n.attrs.modelId);
    n.content?.forEach(walk);
  };
  walk(doc as PMNode);
  return { users: [...users], groups: [...groups] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function canRead(userId: string, d: DocLike & { teamId: string }) {
  const user = await getUser(userId);
  if (!user || user.teamId !== d.teamId || user.deletedAt || user.suspendedAt) return false;
  return !!(await Access.for(user)).document(d);
}

export async function notifyNewMentions(documentId: string, actorId: string | null) {
  const [d] = await sql<(DocLike & { teamId: string; content: unknown })[]>`
    SELECT id, team_id, collection_id, created_by_id, published_at, archived_at, deleted_at, is_template, content FROM documents WHERE id = ${documentId}`;
  if (!d || !d.publishedAt || d.deletedAt || d.isTemplate) return;
  const m = mentionsIn(d.content);
  const ids = [...m.users, ...m.groups].filter((id) => UUID.test(id));
  if (!ids.length) return;
  // Only the ones nobody was told about yet; the insert decides, so two instances don't both tell.
  const fresh = new Set(
    (await sql<{ modelId: string }[]>`
      INSERT INTO document_mentions (document_id, model_id) SELECT ${d.id}, unnest(${ids}::uuid[])
      ON CONFLICT DO NOTHING RETURNING model_id`).map((r) => r.modelId),
  );
  const base = { actorId, documentId: d.id, collectionId: d.collectionId };
  const users: string[] = [];
  for (const id of m.users) if (fresh.has(id) && id !== actorId && (await canRead(id, d))) users.push(id);
  if (users.length) await notify(d.teamId, users, { event: "documents.mentioned", ...base });
  for (const groupId of m.groups) {
    if (!fresh.has(groupId)) continue;
    const members = (await sql<{ userId: string }[]>`
      SELECT gu.user_id FROM group_users gu JOIN groups g ON g.id = gu.group_id WHERE gu.group_id = ${groupId} AND g.team_id = ${d.teamId} AND g.deleted_at IS NULL`).map((r) => r.userId);
    const readers: string[] = [];
    for (const id of members) if (id !== actorId && !users.includes(id) && (await canRead(id, d))) readers.push(id);
    if (readers.length) await notify(d.teamId, readers, { event: "documents.group_mentioned", ...base, groupId });
  }
}

const SAVES = new Set(["documents.create", "documents.update", "documents.publish", "documents.restore"]);

export function watchMentions() {
  bus.on("change", (e: ChangeEvent) => {
    if (SAVES.has(e.name) && e.documentId) void notifyNewMentions(e.documentId, e.actorId ?? null).catch((err) => console.warn("Mention notifications failed:", err));
  });
}
