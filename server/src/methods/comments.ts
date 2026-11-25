// comments.* and reactions: threads on a document, resolving them, reactions, and the notifications they
// send (a new comment to the thread, the author and subscribers; a mention to whoever is mentioned).

import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { Access, atLeast } from "../access.ts";
import { markdownToDoc, parseData } from "../content.ts";
import { publish } from "../events.ts";
import { forbidden, invalid, notFound } from "../http.ts";
import { notify, subscribers } from "../notify.ts";
import type { PMNode } from "../markdown.ts";
import { presentUser, usersById } from "../presenters.ts";
import { method, type SignedInCall } from "../rpc.ts";
import type { UserRow } from "../users.ts";
import { documentFor, page } from "./common.ts";

interface CommentRow {
  id: string;
  documentId: string;
  parentCommentId: string | null;
  createdById: string | null;
  data: unknown;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function present(rows: CommentRow[]) {
  const users = await usersById(rows.flatMap((c) => [c.createdById, c.resolvedById]));
  const reactions = rows.length
    ? await sql<{ commentId: string; emoji: string; userIds: string[] }[]>`
        SELECT comment_id, emoji, array_agg(user_id ORDER BY created_at) AS user_ids FROM reactions
        WHERE comment_id = ANY(${rows.map((c) => c.id)}::uuid[]) GROUP BY comment_id, emoji ORDER BY min(created_at)`
    : [];
  const person = (id: string | null) => (id && users.get(id) ? presentUser(users.get(id) as UserRow) : null);
  return rows.map((c) => ({
    id: c.id,
    data: c.data,
    documentId: c.documentId,
    parentCommentId: c.parentCommentId,
    createdAt: iso(c.createdAt),
    createdBy: person(c.createdById),
    createdById: c.createdById,
    updatedAt: iso(c.updatedAt),
    resolvedAt: iso(c.resolvedAt),
    resolvedBy: person(c.resolvedById),
    resolvedById: c.resolvedById,
    reactions: reactions.filter((r) => r.commentId === c.id).map((r) => ({ emoji: r.emoji, userIds: r.userIds })),
  }));
}

function policy(a: Access, c: CommentRow, docPerm: ReturnType<Access["document"]>) {
  const own = c.createdById === a.user.id;
  const write = atLeast(docPerm, "read_write");
  return {
    id: c.id,
    abilities: {
      read: true,
      update: own,
      delete: own || write || a.isAdmin,
      resolve: !c.parentCommentId && !c.resolvedAt && (write || own),
      unresolve: !c.parentCommentId && !!c.resolvedAt && (write || own),
      addReaction: true,
      removeReaction: true,
    },
  };
}

/** The comment's text, from `data` (JSON) or `text` (Markdown, which the apps send). */
function bodyOf(call: SignedInCall) {
  const data = call.params.object("data");
  if (data) return parseData(data);
  const text = call.params.string("text", { max: 100_000 });
  if (text === undefined || !text.trim()) throw invalid("One of text or data is required");
  return markdownToDoc(text);
}

/** People mentioned in a comment, and groups. */
function mentions(doc: unknown) {
  const users = new Set<string>();
  const groups = new Set<string>();
  const walk = (n: PMNode) => {
    if (n.type === "mention" && typeof n.attrs?.modelId === "string") (n.attrs.type === "group" ? groups : users).add(n.attrs.modelId);
    n.content?.forEach(walk);
  };
  walk(doc as PMNode);
  return { users: [...users], groups: [...groups] };
}

async function commentFor(a: Access, id: string | undefined) {
  if (!id) throw notFound();
  const [c] = await sql<CommentRow[]>`SELECT * FROM comments WHERE id = ${id} AND deleted_at IS NULL`;
  if (!c) throw notFound();
  const d = await documentFor(a, c.documentId);
  return { c, d, perm: a.document(d) };
}

method("comments.list", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  const { limit, offset } = p.pagination();
  const documentId = p.uuid("documentId");
  const d = documentId ? await documentFor(a, documentId) : null;
  const parent = p.uuid("parentCommentId");
  const status = p.array("statusFilter")?.map(String) ?? [];
  const docs = d ? [d.id] : (await sql<{ id: string }[]>`SELECT d.id FROM documents d WHERE d.team_id = ${call.user.teamId} AND d.deleted_at IS NULL AND ${a.readableFilter()}`).map((r) => r.id);
  const rows = await sql<CommentRow[]>`
    SELECT * FROM comments WHERE deleted_at IS NULL AND document_id = ANY(${docs}::uuid[])
      ${parent ? sql`AND parent_comment_id = ${parent}` : sql``}
      ${status.includes("resolved") && !status.includes("unresolved") ? sql`AND resolved_at IS NOT NULL` : sql``}
      ${status.includes("unresolved") && !status.includes("resolved") ? sql`AND resolved_at IS NULL` : sql``}
    ORDER BY created_at ${p.direction("ASC") === "ASC" ? sql`ASC` : sql`DESC`} LIMIT ${limit} OFFSET ${offset}`;
  const perm = d ? a.document(d) : null;
  return { pagination: page("comments.list", limit, offset), data: await present(rows), policies: rows.map((c) => policy(a, c, perm)) };
});

method("comments.info", async (call) => {
  const a = await Access.for(call.user);
  const { c, perm } = await commentFor(a, call.params.uuid("id", { required: true }));
  return { data: (await present([c]))[0], policies: [policy(a, c, perm)] };
});

method("comments.create", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.uuid("documentId", { required: true }));
  if (d.deletedAt) throw forbidden();
  const parentId = call.params.uuid("parentCommentId") ?? null;
  if (parentId) {
    const [parent] = await sql<{ documentId: string }[]>`SELECT document_id FROM comments WHERE id = ${parentId} AND deleted_at IS NULL`;
    if (!parent || parent.documentId !== d.id) throw notFound();
  }
  const data = bodyOf(call);
  const id = call.params.uuid("id") ?? randomUUID();
  const [c] = await sql<CommentRow[]>`
    INSERT INTO comments (id, document_id, parent_comment_id, created_by_id, data) VALUES (${id}, ${d.id}, ${parentId}, ${call.user.id}, ${sql.json(data as never)})
    RETURNING *`;
  publish({ name: "comments.create", data: { id: c.id, documentId: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });

  // Notifications: the thread, the document's author and subscribers; mentions on top.
  const m = mentions(data);
  const thread = parentId ? (await sql<{ createdById: string }[]>`SELECT DISTINCT created_by_id FROM comments WHERE (id = ${parentId} OR parent_comment_id = ${parentId}) AND deleted_at IS NULL`).map((r) => r.createdById) : [];
  const watchers = [...thread, d.createdById, ...(await subscribers(d.id, d.collectionId))].filter((u) => !m.users.includes(u ?? ""));
  await notify(d.teamId, watchers, { event: "comments.create", actorId: call.user.id, documentId: d.id, collectionId: d.collectionId, commentId: c.id });
  await notify(d.teamId, m.users, { event: "comments.mentioned", actorId: call.user.id, documentId: d.id, collectionId: d.collectionId, commentId: c.id });
  for (const groupId of m.groups) {
    const members = (await sql<{ userId: string }[]>`SELECT user_id FROM group_users WHERE group_id = ${groupId}`).map((r) => r.userId);
    await notify(d.teamId, members, { event: "comments.group_mentioned", actorId: call.user.id, documentId: d.id, collectionId: d.collectionId, commentId: c.id, groupId });
  }
  return { data: (await present([c]))[0], policies: [policy(a, c, a.document(d))] };
});

method("comments.update", async (call) => {
  const a = await Access.for(call.user);
  const { c, d, perm } = await commentFor(a, call.params.uuid("id", { required: true }));
  if (c.createdById !== call.user.id) throw forbidden();
  const data = bodyOf(call);
  const [u] = await sql<CommentRow[]>`UPDATE comments SET data = ${sql.json(data as never)}, updated_at = now() WHERE id = ${c.id} RETURNING *`;
  publish({ name: "comments.update", data: { id: c.id, documentId: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
  return { data: (await present([u]))[0], policies: [policy(a, u, perm)] };
});

method("comments.delete", async (call) => {
  const a = await Access.for(call.user);
  const { c, d, perm } = await commentFor(a, call.params.uuid("id", { required: true }));
  if (!policy(a, c, perm).abilities.delete) throw forbidden();
  await sql`UPDATE comments SET deleted_at = now() WHERE id = ${c.id} OR parent_comment_id = ${c.id}`;
  publish({ name: "comments.delete", data: { id: c.id, documentId: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
  return { success: true };
});

async function resolve(call: SignedInCall, resolved: boolean) {
  const a = await Access.for(call.user);
  const { c, d, perm } = await commentFor(a, call.params.uuid("id", { required: true }));
  const abilities = policy(a, c, perm).abilities;
  if (!(resolved ? abilities.resolve : abilities.unresolve)) throw forbidden();
  const [u] = await sql<CommentRow[]>`
    UPDATE comments SET resolved_at = ${resolved ? new Date() : null}, resolved_by_id = ${resolved ? call.user.id : null}, updated_at = now() WHERE id = ${c.id} RETURNING *`;
  const name = resolved ? "comments.resolve" : "comments.unresolve";
  publish({ name, data: { id: c.id, documentId: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
  if (resolved) await notify(d.teamId, [c.createdById], { event: "comments.resolve", actorId: call.user.id, documentId: d.id, collectionId: d.collectionId, commentId: c.id });
  return { data: (await present([u]))[0], policies: [policy(a, u, perm)] };
}

method("comments.resolve", (call) => resolve(call, true));
method("comments.unresolve", (call) => resolve(call, false));

// ---------- Reactions ----------

method("comments.add_reaction", async (call) => {
  const a = await Access.for(call.user);
  const { c, d } = await commentFor(a, call.params.uuid("id", { required: true }));
  const emoji = call.params.string("emoji", { required: true, max: 64 })!;
  const [r] = await sql`INSERT INTO reactions (emoji, comment_id, user_id) VALUES (${emoji}, ${c.id}, ${call.user.id}) ON CONFLICT DO NOTHING RETURNING id`;
  publish({ name: "comments.add_reaction", data: { id: c.id, documentId: d.id, emoji }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
  if (r) await notify(d.teamId, [c.createdById], { event: "reactions.create", actorId: call.user.id, documentId: d.id, collectionId: d.collectionId, commentId: c.id, data: { emoji } });
  return { success: true };
});

method("comments.remove_reaction", async (call) => {
  const a = await Access.for(call.user);
  const { c, d } = await commentFor(a, call.params.uuid("id", { required: true }));
  const emoji = call.params.string("emoji", { required: true, max: 64 })!;
  await sql`DELETE FROM reactions WHERE comment_id = ${c.id} AND user_id = ${call.user.id} AND emoji = ${emoji}`;
  publish({ name: "comments.remove_reaction", data: { id: c.id, documentId: d.id, emoji }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
  return { success: true };
});

method("reactions.list", async (call) => {
  const a = await Access.for(call.user);
  const { c } = await commentFor(a, call.params.uuid("commentId", { required: true }));
  const { limit, offset } = call.params.pagination();
  const rows = await sql<{ id: string; emoji: string; commentId: string; userId: string; createdAt: Date; updatedAt: Date }[]>`
    SELECT * FROM reactions WHERE comment_id = ${c.id} ORDER BY created_at LIMIT ${limit} OFFSET ${offset}`;
  const users = await usersById(rows.map((r) => r.userId));
  return {
    pagination: page("reactions.list", limit, offset),
    data: rows.map((r) => ({ id: r.id, emoji: r.emoji, commentId: r.commentId, userId: r.userId, user: users.get(r.userId) ? presentUser(users.get(r.userId)!) : null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() })),
  };
});
