// documents.*: reading, writing, publishing, moving, archiving, deleting and sharing documents.
//
// A published document sits in its collection's tree (documentStructure); every change that moves it
// in or out of the tree (publish, unpublish, move, archive, delete, restore) updates the tree in the
// same transaction, as Outline does.

import { randomUUID } from "node:crypto";
import { sql, type Tx } from "../db.ts";
import { Access, atLeast } from "../access.ts";
import {
  addToTree,
  contentFrom,
  contentFromMarkdown,
  descendants,
  navNode,
  newUrlId,
  parseData,
  removeFromTree,
  subtree,
  updateInTree,
  type ContentFields,
  type DocJSON,
} from "../content.ts";
import { publish } from "../events.ts";
import { notify, subscribers } from "../notify.ts";
import { forbidden, invalid, notFound } from "../http.ts";
import { documentPolicy, userPolicy } from "../policies.ts";
import { DOC_COLUMNS, presentDocuments, presentGroup, presentGroupMembership, presentMembership, presentUser, usersById, type DocumentRow, type GroupRow, type MembershipRow } from "../presenters.ts";
import { method, type SignedInCall } from "../rpc.ts";
import { getUser, teamById, type UserRow } from "../users.ts";
import { collectionFor, documentFor, page } from "./common.ts";

const PERMISSIONS = ["read", "read_write", "admin"] as const;

/** A piece of SQL to nest (postgres.js types fragments by their rows, which don't matter here). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fragment = any;

/** The documents with published children, among these (for the unpublish ability). */
async function withChildren(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await sql<{ parentDocumentId: string }[]>`
    SELECT DISTINCT parent_document_id FROM documents WHERE parent_document_id = ANY(${ids}::uuid[]) AND published_at IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL`;
  return new Set(rows.map((r) => r.parentDocumentId));
}

/** Documents with their policies, as most methods answer. */
export async function presentWithPolicies(a: Access, rows: DocumentRow[], opts: { includeData?: boolean } = {}) {
  const team = await teamById(a.user.teamId);
  const parents = await withChildren(rows.map((d) => d.id));
  return { data: await presentDocuments(rows, opts), policies: rows.map((d) => documentPolicy(a, d, team, { hasChildren: parents.has(d.id) })) };
}

async function one(a: Access, d: DocumentRow, opts: { includeData?: boolean } = {}) {
  const r = await presentWithPolicies(a, [d], opts);
  return { data: r.data[0], policies: r.policies };
}

const reload = async (id: string) => (await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${id}`)[0];

const SORTS: Record<string, string> = { updatedAt: "d.updated_at", createdAt: "d.created_at", publishedAt: "d.published_at", title: "lower(d.title)", index: "d.updated_at", archivedAt: "d.archived_at", deletedAt: "d.deleted_at" };
function orderBy(call: SignedInCall, fallback = "updatedAt") {
  const column = SORTS[call.params.string("sort") ?? fallback] ?? SORTS[fallback];
  return sql.unsafe(`${column} ${call.params.direction("DESC")} NULLS LAST, d.id`);
}

/** A list of documents: filtered, sorted, paginated, with policies. */
async function listOf(call: SignedInCall, a: Access, method: string, where: Fragment, opts: { order?: Fragment; total?: boolean; select?: Fragment; join?: Fragment } = {}) {
  const { limit, offset } = call.params.pagination();
  const rows = await sql<DocumentRow[]>`
    SELECT ${DOC_COLUMNS} ${opts.select ?? sql``} FROM documents d ${opts.join ?? sql``}
    WHERE d.team_id = ${a.user.teamId} AND ${a.readableFilter()} AND ${where}
    ORDER BY ${opts.order ?? orderBy(call)} LIMIT ${limit} OFFSET ${offset}`;
  const total = opts.total ? (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM documents d ${opts.join ?? sql``} WHERE d.team_id = ${a.user.teamId} AND ${a.readableFilter()} AND ${where}`)[0].n : undefined;
  return { pagination: page(method, limit, offset, total), ...(await presentWithPolicies(a, rows)) };
}

// ---------- Reading ----------

method("documents.info", async (call) => {
  const a = await Access.for(call.user);
  const id = call.params.string("id");
  if (!id && !call.params.string("shareId")) throw invalid("one of id or shareId is required");
  if (!id) throw notFound();
  const d = await documentFor(a, id);
  // Opening a document counts as viewing it (recently viewed, insights).
  await sql`
    INSERT INTO views (user_id, document_id) VALUES (${call.user.id}, ${d.id})
    ON CONFLICT (user_id, document_id) DO UPDATE SET count = views.count + 1, last_viewed_at = now()`;
  return one(a, d, { includeData: call.apiVersion >= 2 });
});

method("documents.list", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  const template = p.boolean("template") ?? false;
  const collectionId = p.uuid("collectionId");
  const parent = p.has("parentDocumentId") ? (p.nullableUuid("parentDocumentId") ?? null) : undefined;
  const userId = p.uuid("userId");
  const status = p.array("statusFilter")?.map(String);
  const states = status?.length
    ? sql`(${status.includes("published") ? sql`(d.published_at IS NOT NULL AND d.archived_at IS NULL)` : sql`false`}
        OR ${status.includes("draft") ? sql`d.published_at IS NULL` : sql`false`} OR ${status.includes("archived") ? sql`d.archived_at IS NOT NULL` : sql`false`})`
    : sql`d.published_at IS NOT NULL AND d.archived_at IS NULL`;
  const where = sql`d.deleted_at IS NULL AND d.is_template = ${template} AND ${template ? sql`true` : states}
    ${collectionId ? sql`AND d.collection_id = ${collectionId}` : sql``}
    ${parent !== undefined ? (parent ? sql`AND d.parent_document_id = ${parent}` : sql`AND d.parent_document_id IS NULL`) : sql``}
    ${userId ? sql`AND d.created_by_id = ${userId}` : sql``}`;
  return listOf(call, a, "documents.list", where, { total: true });
});

method("documents.viewed", async (call) => {
  const a = await Access.for(call.user);
  return listOf(call, a, "documents.viewed", sql`d.deleted_at IS NULL`, {
    join: sql`JOIN views v ON v.document_id = d.id AND v.user_id = ${call.user.id}`,
    select: sql`, v.last_viewed_at`,
    order: sql`v.last_viewed_at DESC`,
  });
});

method("documents.drafts", async (call) => {
  const a = await Access.for(call.user);
  const collectionId = call.params.uuid("collectionId");
  return listOf(call, a, "documents.drafts", sql`d.published_at IS NULL AND d.deleted_at IS NULL AND NOT d.is_template AND d.created_by_id = ${call.user.id}
    ${collectionId ? sql`AND d.collection_id = ${collectionId}` : sql``}`);
});

method("documents.archived", async (call) => {
  const a = await Access.for(call.user);
  const collectionId = call.params.uuid("collectionId");
  return listOf(call, a, "documents.archived", sql`d.archived_at IS NOT NULL AND d.deleted_at IS NULL ${collectionId ? sql`AND d.collection_id = ${collectionId}` : sql``}`);
});

method("documents.deleted", async (call) => {
  const a = await Access.for(call.user);
  const { limit, offset } = call.params.pagination();
  const rows = await sql<DocumentRow[]>`
    SELECT ${DOC_COLUMNS} FROM documents d WHERE d.team_id = ${a.user.teamId} AND d.deleted_at IS NOT NULL AND ${a.readableFilter()}
    ORDER BY ${orderBy(call, "deletedAt")} LIMIT ${limit} OFFSET ${offset}`;
  // Deleted documents are their author's, an admin's, or editors' of the collection.
  const visible = rows.filter((d) => a.document(d));
  return { pagination: page("documents.deleted", limit, offset), ...(await presentWithPolicies(a, visible)) };
});

// ---------- Search ----------

/** Words for a tsquery (accents off, letters and digits only); the last one as a prefix. */
function tsquery(query: string): string | null {
  const words = query
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!words?.length) return null;
  return words.slice(0, 20).map((w, i, all) => (i === all.length - 1 ? `${w}:*` : w)).join(" & ");
}

method("documents.search_titles", async (call) => {
  const a = await Access.for(call.user);
  const query = call.params.string("query", { required: true, max: 1000 })!;
  const collectionId = call.params.uuid("collectionId");
  const like = `%${query.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()}%`;
  return listOf(call, a, "documents.search_titles", sql`d.deleted_at IS NULL AND NOT d.is_template AND d.archived_at IS NULL AND notes_norm(d.title) LIKE ${like}
    ${collectionId ? sql`AND d.collection_id = ${collectionId}` : sql``}`, { order: sql`similarity(notes_norm(d.title), ${query.toLowerCase()}) DESC, d.updated_at DESC` });
});

method("documents.search", async (call) => {
  const a = await Access.for(call.user);
  const query = call.params.string("query", { required: true, max: 1000 })!;
  const q = tsquery(query);
  const { limit, offset } = call.params.pagination();
  if (!q) return { pagination: page("documents.search", limit, offset, 0), data: [], policies: [] };
  const collectionId = call.params.uuid("collectionId");
  const userId = call.params.uuid("userId");
  const statuses = call.params.array("statusFilter")?.map(String) ?? [];
  const status = statuses.length
    ? sql`(${statuses.includes("published") ? sql`(d.published_at IS NOT NULL AND d.archived_at IS NULL)` : sql`false`} OR ${statuses.includes("draft") ? sql`d.published_at IS NULL` : sql`false`} OR ${statuses.includes("archived") ? sql`d.archived_at IS NOT NULL` : sql`false`})`
    : sql`d.archived_at IS NULL`;
  const where = sql`d.team_id = ${a.user.teamId} AND d.deleted_at IS NULL AND NOT d.is_template AND ${status} AND ${a.readableFilter()} AND d.search @@ to_tsquery('simple', ${q})
    ${collectionId ? sql`AND d.collection_id = ${collectionId}` : sql``} ${userId ? sql`AND d.created_by_id = ${userId}` : sql``}`;
  const rows = await sql<(DocumentRow & { ranking: number; context: string })[]>`
    SELECT ${DOC_COLUMNS}, ts_rank(d.search, to_tsquery('simple', ${q})) AS ranking,
      ts_headline('simple', notes_norm(d.text), to_tsquery('simple', ${q}), 'StartSel=<b>, StopSel=</b>, MaxFragments=1, MinWords=10, MaxWords=30') AS context
    FROM documents d WHERE ${where} ORDER BY ranking DESC, d.updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const [{ total }] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM documents d WHERE ${where}`;
  const presented = await presentWithPolicies(a, rows);
  return {
    pagination: page("documents.search", limit, offset, total),
    data: rows.map((r, i) => ({ ranking: r.ranking, context: r.context, document: presented.data[i] })),
    policies: presented.policies,
  };
});

// ---------- Writing ----------

/** The new content from `data` (JSON) or `text` (Markdown); undefined when the call doesn't change it. */
function contentOf(call: SignedInCall, current?: DocumentRow): ContentFields | undefined {
  const data = call.params.object("data");
  if (data) return contentFrom(parseData(data));
  const text = call.params.string("text", { max: 10_000_000 });
  if (text === undefined) return undefined;
  if (call.params.boolean("append") && current) return contentFromMarkdown(`${current.text}\n\n${text}`);
  return contentFromMarkdown(text);
}

method("documents.create", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  if (call.user.role === "viewer") throw forbidden();
  let collectionId = p.uuid("collectionId") ?? null;
  const parentId = p.uuid("parentDocumentId") ?? null;
  if (parentId) {
    const parent = await documentFor(a, parentId, "read_write");
    collectionId = parent.collectionId;
  }
  const doPublish = p.boolean("publish") ?? false;
  if (collectionId) await collectionFor(a, collectionId, "read_write");
  if (doPublish && !collectionId) throw invalid("collectionId is required to publish");

  const templateId = p.uuid("templateId") ?? null;
  const template = templateId ? await documentFor(a, templateId) : null;
  const content = contentOf(call) ?? (template ? contentFrom((template.content ?? { type: "doc", content: [{ type: "paragraph" }] }) as DocJSON) : contentFromMarkdown(""));
  const title = p.string("title", { max: 255 }) ?? (template ? template.title : "");
  const id = p.uuid("id") ?? randomUUID();

  let d!: DocumentRow;
  await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO documents (id, url_id, team_id, collection_id, parent_document_id, title, icon, color, text, content, state, full_width,
                             template_id, created_by_id, last_modified_by_id, collaborator_ids, published_at)
      VALUES (${id}, ${newUrlId()}, ${a.user.teamId}, ${collectionId}, ${parentId}, ${title}, ${p.nullableString("icon", 50) ?? template?.icon ?? null},
              ${p.nullableString("color", 20) ?? template?.color ?? null}, ${content.text}, ${tx.json(content.content as never)}, ${content.state},
              ${p.boolean("fullWidth") ?? template?.fullWidth ?? false}, ${templateId}, ${call.user.id}, ${call.user.id}, ${[call.user.id]}::uuid[],
              ${doPublish ? new Date() : null})
      RETURNING id`;
    d = (await tx<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${row.id}`)[0];
    if (doPublish && collectionId) await addToTree(tx, collectionId, navNode(d), parentId, p.number("index"));
  });
  publish({ name: "documents.create", data: { id: d.id, collectionId }, teamId: d.teamId, collectionId, documentId: d.id, actorId: call.user.id });
  return one(a, d);
});

/** Publishes a draft into a collection (under a parent, at an index). */
async function publishDraft(tx: Tx, d: DocumentRow, collectionId: string, parentId: string | null, index?: number) {
  await tx`UPDATE documents SET published_at = now(), collection_id = ${collectionId}, parent_document_id = ${parentId} WHERE id = ${d.id}`;
  await addToTree(tx, collectionId, navNode(d), parentId, index);
}

method("documents.update", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  const current = await documentFor(a, p.string("id", { required: true }));
  const perm = a.document(current);
  const own = current.createdById === call.user.id;
  const publishing = p.boolean("publish") && !current.publishedAt;
  if (!(atLeast(perm, "read_write") || (publishing && own)) || call.user.role === "viewer" || current.deletedAt) throw forbidden();

  const content = contentOf(call, current);
  const title = p.string("title", { max: 255 });
  let collectionId = current.collectionId;
  if (publishing) {
    collectionId = p.uuid("collectionId") ?? current.collectionId;
    if (!collectionId) throw invalid("collectionId is required to publish");
    await collectionFor(a, collectionId, "read_write");
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE documents SET
        title = ${title ?? current.title},
        icon = ${p.has("icon") ? (p.nullableString("icon", 50) ?? null) : current.icon},
        color = ${p.has("color") ? (p.nullableString("color", 20) ?? null) : current.color},
        full_width = ${p.boolean("fullWidth") ?? current.fullWidth},
        insights_enabled = ${p.boolean("insightsEnabled") ?? current.insightsEnabled},
        preferences = ${p.has("preferences") ? (p.object("preferences") ? tx.json(p.object("preferences") as never) : null) : current.preferences ? tx.json(current.preferences as never) : null},
        template_id = ${p.has("templateId") ? (p.nullableUuid("templateId") ?? null) : current.templateId},
        ${content ? tx`text = ${content.text}, content = ${tx.json(content.content as never)}, state = ${content.state},` : tx``}
        last_modified_by_id = ${call.user.id},
        collaborator_ids = CASE WHEN ${call.user.id}::uuid = ANY(collaborator_ids) THEN collaborator_ids ELSE array_append(collaborator_ids, ${call.user.id}::uuid) END,
        revision_count = revision_count + ${content ? 1 : 0},
        updated_at = now()
      WHERE id = ${current.id}`;
    const fresh = (await tx<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${current.id}`)[0];
    if (publishing && collectionId) await publishDraft(tx, fresh, collectionId, fresh.collectionId === collectionId ? fresh.parentDocumentId : null);
    else if (fresh.publishedAt && fresh.collectionId && !fresh.archivedAt && (title !== undefined || p.has("icon") || p.has("color"))) await updateInTree(tx, fresh.collectionId, fresh);
  });
  const d = await reload(current.id);
  publish({ name: "documents.update", data: { id: d.id, collectionId: d.collectionId, updatedAt: d.updatedAt }, teamId: d.teamId, collectionId: d.collectionId, documentId: d.id, actorId: call.user.id });
  if (content) publish({ name: "documents.content", data: { id: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
  if (publishing) {
    publish({ name: "documents.publish", data: { id: d.id, collectionId: d.collectionId }, teamId: d.teamId, collectionId: d.collectionId, documentId: d.id, actorId: call.user.id });
    await notify(d.teamId, await subscribers(d.id, d.collectionId, "documents.publish"), { event: "documents.publish", actorId: call.user.id, documentId: d.id, collectionId: d.collectionId });
  }
  return one(a, d);
});

/** A draft into its collection (Outline's documents.publish, also documents.update with publish). */
method("documents.publish", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }));
  if (d.publishedAt) return one(a, d);
  if (d.createdById !== call.user.id && !atLeast(a.document(d), "read_write")) throw forbidden();
  const collectionId = call.params.uuid("collectionId") ?? d.collectionId;
  if (!collectionId) throw invalid("collectionId is required to publish");
  await collectionFor(a, collectionId, "read_write");
  const parentId = call.params.has("parentDocumentId") ? (call.params.nullableUuid("parentDocumentId") ?? null) : d.collectionId === collectionId ? d.parentDocumentId : null;
  await sql.begin((tx) => publishDraft(tx, d, collectionId, parentId, call.params.number("index")));
  const fresh = await reload(d.id);
  publish({ name: "documents.publish", data: { id: d.id, collectionId }, teamId: d.teamId, collectionId, documentId: d.id, actorId: call.user.id });
  await notify(d.teamId, await subscribers(d.id, collectionId, "documents.publish"), { event: "documents.publish", actorId: call.user.id, documentId: d.id, collectionId });
  return one(a, fresh);
});

method("documents.unpublish", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }), "read_write");
  if (!d.publishedAt) throw invalid("Document is not published");
  if ((await withChildren([d.id])).has(d.id)) throw invalid("Can't unpublish a document with child documents");
  await sql.begin(async (tx) => {
    await tx`UPDATE documents SET published_at = NULL, updated_at = now() WHERE id = ${d.id}`;
    if (d.collectionId) await removeFromTree(tx, d.collectionId, d.id);
  });
  publish({ name: "documents.unpublish", data: { id: d.id, collectionId: d.collectionId }, teamId: d.teamId, collectionId: d.collectionId, documentId: d.id, actorId: call.user.id });
  return one(a, await reload(d.id));
});

method("documents.move", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  const d = await documentFor(a, p.string("id", { required: true }), "read_write");
  const parentId = p.nullableUuid("parentDocumentId") ?? null;
  let collectionId = p.uuid("collectionId") ?? d.collectionId;
  if (parentId) {
    if (parentId === d.id || (await descendants(sql, d.id)).includes(parentId)) throw invalid("Can't move a document inside itself");
    const parent = await documentFor(a, parentId, "read_write");
    collectionId = parent.collectionId;
  }
  if (!collectionId) throw invalid("collectionId is required");
  await collectionFor(a, collectionId, "read_write");
  const index = p.number("index", { min: 0 });

  await sql.begin(async (tx) => {
    const node = (d.collectionId && d.publishedAt ? await removeFromTree(tx, d.collectionId, d.id) : null) ?? (d.publishedAt ? await subtree(tx, d) : null);
    const moved = [d.id, ...(await descendants(tx, d.id))];
    await tx`UPDATE documents SET collection_id = ${collectionId} WHERE id = ANY(${moved}::uuid[])`;
    await tx`UPDATE documents SET parent_document_id = ${parentId}, updated_at = now() WHERE id = ${d.id}`;
    if (node && d.publishedAt && !d.archivedAt) await addToTree(tx, collectionId!, node, parentId, index);
  });
  const fresh = await reload(d.id);
  publish({ name: "documents.move", data: { id: d.id, collectionId, collectionIds: [...new Set([d.collectionId, collectionId].filter(Boolean))] }, teamId: d.teamId, collectionId, documentId: d.id, actorId: call.user.id });
  const presented = await presentWithPolicies(a, [fresh]);
  const { presentCollection } = await import("../presenters.ts");
  const collections = await sql`SELECT * FROM collections WHERE id = ANY(${[...new Set([d.collectionId, collectionId].filter(Boolean))] as string[]}::uuid[])`;
  return { data: { documents: presented.data, collections: collections.map((c) => presentCollection(c as never, call.apiVersion)) }, policies: presented.policies };
});

method("documents.archive", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }), "read_write");
  if (d.archivedAt) return one(a, d);
  await sql.begin(async (tx) => {
    const ids = [d.id, ...(await descendants(tx, d.id))];
    await tx`UPDATE documents SET archived_at = now(), updated_at = now() WHERE id = ANY(${ids}::uuid[]) AND archived_at IS NULL`;
    if (d.collectionId && d.publishedAt) await removeFromTree(tx, d.collectionId, d.id);
  });
  publish({ name: "documents.archive", data: { id: d.id, collectionId: d.collectionId }, teamId: d.teamId, collectionId: d.collectionId, documentId: d.id, actorId: call.user.id });
  return one(a, await reload(d.id));
});

method("documents.restore", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  const d = await documentFor(a, p.string("id", { required: true }));
  const revisionId = p.uuid("revisionId");
  if (revisionId) {
    if (!atLeast(a.document(d), "read_write")) throw forbidden();
    const [rev] = await sql<{ title: string; content: unknown; text: string }[]>`SELECT title, content, text FROM revisions WHERE id = ${revisionId} AND document_id = ${d.id}`;
    if (!rev) throw notFound();
    const content = rev.content ? contentFrom(rev.content as DocJSON) : contentFromMarkdown(rev.text);
    await sql`UPDATE documents SET title = ${rev.title}, text = ${content.text}, content = ${sql.json(content.content as never)}, state = ${content.state},
      last_modified_by_id = ${call.user.id}, revision_count = revision_count + 1, updated_at = now() WHERE id = ${d.id}`;
    if (d.publishedAt && d.collectionId) await sql.begin(async (tx) => updateInTree(tx, d.collectionId!, { ...d, title: rev.title }));
    publish({ name: "documents.content", data: { id: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
    publish({ name: "documents.update", data: { id: d.id, collectionId: d.collectionId }, teamId: d.teamId, collectionId: d.collectionId, documentId: d.id, actorId: call.user.id });
    return one(a, await reload(d.id));
  }
  if (!d.deletedAt && !d.archivedAt) return one(a, d);
  const own = d.createdById === call.user.id;
  if (!own && !atLeast(a.document(d), "read_write")) throw forbidden();

  // Back where it was, or in the collection asked for when that one is gone.
  let collectionId = p.uuid("collectionId") ?? d.collectionId;
  if (collectionId) {
    const [c] = await sql<{ deletedAt: Date | null; archivedAt: Date | null }[]>`SELECT deleted_at, archived_at FROM collections WHERE id = ${collectionId}`;
    if (!c || c.deletedAt) {
      if (p.uuid("collectionId")) throw notFound();
      collectionId = null;
    }
  }
  if (d.publishedAt && !collectionId) throw invalid("The collection is gone: give a collectionId to restore into");
  if (collectionId) await collectionFor(a, collectionId, "read_write");

  await sql.begin(async (tx) => {
    const ids = [d.id, ...(await descendants(tx, d.id))];
    if (d.deletedAt) await tx`UPDATE documents SET deleted_at = NULL, deleted_by_id = NULL WHERE id = ANY(${ids}::uuid[]) AND deleted_at >= ${new Date(d.deletedAt.getTime() - 60_000)}`;
    if (d.archivedAt) await tx`UPDATE documents SET archived_at = NULL WHERE id = ANY(${ids}::uuid[])`;
    // The parent may be gone (deleted, archived, elsewhere): then at the top.
    let parentId = d.parentDocumentId;
    if (parentId) {
      const [parent] = await tx<{ collectionId: string; deletedAt: Date | null; archivedAt: Date | null; publishedAt: Date | null }[]>`SELECT collection_id, deleted_at, archived_at, published_at FROM documents WHERE id = ${parentId}`;
      if (!parent || parent.deletedAt || parent.archivedAt || !parent.publishedAt || parent.collectionId !== collectionId) parentId = null;
    }
    await tx`UPDATE documents SET collection_id = ${collectionId}, parent_document_id = ${parentId}, updated_at = now() WHERE id = ${d.id}`;
    if (collectionId && collectionId !== d.collectionId) await tx`UPDATE documents SET collection_id = ${collectionId} WHERE id = ANY(${ids}::uuid[])`;
    if (d.publishedAt && collectionId) await addToTree(tx, collectionId, await subtree(tx, d), parentId);
  });
  publish({ name: "documents.restore", data: { id: d.id, collectionId }, teamId: d.teamId, collectionId, documentId: d.id, actorId: call.user.id });
  return one(a, await reload(d.id));
});

method("documents.delete", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }));
  const own = d.createdById === call.user.id;
  if (call.params.boolean("permanent")) {
    if (!d.deletedAt) throw invalid("Only documents in the trash can be deleted permanently");
    if (!own && !a.isAdmin) throw forbidden();
    const ids = [d.id, ...(await descendants(sql, d.id))];
    await sql`DELETE FROM documents WHERE id = ANY(${ids}::uuid[])`;
    publish({ name: "documents.permanent_delete", data: { id: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
    return { success: true };
  }
  if (!own && !atLeast(a.document(d), "read_write")) throw forbidden();
  if (d.deletedAt) return { success: true };
  await sql.begin(async (tx) => {
    const ids = [d.id, ...(await descendants(tx, d.id))];
    await tx`UPDATE documents SET deleted_at = now(), deleted_by_id = ${call.user.id} WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL`;
    if (d.collectionId && d.publishedAt && !d.archivedAt) await removeFromTree(tx, d.collectionId, d.id);
  });
  publish({ name: "documents.delete", data: { id: d.id, collectionId: d.collectionId }, teamId: d.teamId, collectionId: d.collectionId, documentId: d.id, actorId: call.user.id });
  return { success: true };
});

method("documents.empty_trash", async (call) => {
  const mine = call.user.role === "admin" ? sql`` : sql`AND created_by_id = ${call.user.id}`;
  await sql`DELETE FROM documents WHERE team_id = ${call.user.teamId} AND deleted_at IS NOT NULL ${mine}`;
  return { success: true };
});

/** A copy of a document (and its children with `recursive`), as a draft or published next to it. */
method("documents.duplicate", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  const source = await documentFor(a, p.string("id", { required: true }));
  const collectionId = p.uuid("collectionId") ?? source.collectionId;
  if (collectionId) await collectionFor(a, collectionId, "read_write");
  const doPublish = p.boolean("publish") ?? !!source.publishedAt;
  const recursive = p.boolean("recursive") ?? false;
  const parentId = p.has("parentDocumentId") ? (p.nullableUuid("parentDocumentId") ?? null) : source.parentDocumentId;
  const created: DocumentRow[] = [];
  await sql.begin(async (tx) => {
    const copy = async (src: DocumentRow, parent: string | null, title: string): Promise<DocumentRow> => {
      const [{ state }] = await tx<{ state: Buffer | null }[]>`SELECT state FROM documents WHERE id = ${src.id}`;
      const content = src.content ? contentFrom(src.content as DocJSON) : contentFromMarkdown(src.text);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO documents (url_id, team_id, collection_id, parent_document_id, title, icon, color, text, content, state, full_width, created_by_id, last_modified_by_id, collaborator_ids, published_at)
        VALUES (${newUrlId()}, ${src.teamId}, ${collectionId}, ${parent}, ${title}, ${src.icon}, ${src.color}, ${content.text}, ${tx.json(content.content as never)}, ${state ?? content.state},
                ${src.fullWidth}, ${call.user.id}, ${call.user.id}, ${[call.user.id]}::uuid[], ${doPublish ? new Date() : null})
        RETURNING id`;
      const d = (await tx<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${row.id}`)[0];
      created.push(d);
      if (recursive) {
        const children = await tx<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.parent_document_id = ${src.id} AND d.deleted_at IS NULL AND d.archived_at IS NULL`;
        for (const child of children) await copy(child, d.id, child.title);
      }
      return d;
    };
    const top = await copy(source, parentId, p.string("title", { max: 255 }) ?? source.title);
    if (doPublish && collectionId) await addToTree(tx, collectionId, await subtree(tx, top), parentId);
  });
  for (const d of created) publish({ name: "documents.create", data: { id: d.id, collectionId }, teamId: d.teamId, collectionId, documentId: d.id, actorId: call.user.id });
  const presented = await presentWithPolicies(a, created);
  return { data: { documents: presented.data }, policies: presented.policies };
});

/** A template from a document (templates live with documents, flagged). */
method("documents.templatize", async (call) => {
  const a = await Access.for(call.user);
  const source = await documentFor(a, call.params.string("id", { required: true }));
  const collectionId = call.params.has("collectionId") ? (call.params.nullableUuid("collectionId") ?? null) : source.collectionId;
  if (collectionId) await collectionFor(a, collectionId, "read_write");
  const content = source.content ? contentFrom(source.content as DocJSON) : contentFromMarkdown(source.text);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO documents (url_id, team_id, collection_id, title, icon, color, text, content, state, full_width, is_template, created_by_id, last_modified_by_id, collaborator_ids, published_at)
    VALUES (${newUrlId()}, ${source.teamId}, ${collectionId}, ${source.title}, ${source.icon}, ${source.color}, ${content.text}, ${sql.json(content.content as never)}, ${content.state},
            ${source.fullWidth}, true, ${call.user.id}, ${call.user.id}, ${[call.user.id]}::uuid[], ${(call.params.boolean("publish") ?? true) ? new Date() : null})
    RETURNING id`;
  publish({ name: "documents.create", data: { id: row.id, collectionId }, teamId: source.teamId, collectionId, documentId: row.id, actorId: call.user.id });
  return one(a, await reload(row.id), { includeData: true });
});

// ---------- Access: people and groups ----------

/** People who can open a document (mentions, sharing): its collection's readers and its members. */
method("documents.users", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }));
  const { limit, offset } = call.params.pagination();
  const query = call.params.string("query");
  const userId = call.params.uuid("userId");
  const [c] = d.collectionId ? await sql<{ permission: string | null }[]>`SELECT permission FROM collections WHERE id = ${d.collectionId}` : [];
  const everyone = !!c?.permission;
  const rows = await sql<UserRow[]>`
    SELECT u.* FROM users u WHERE u.team_id = ${d.teamId} AND u.deleted_at IS NULL AND u.suspended_at IS NULL
      AND (
        ${everyone ? sql`u.role <> 'guest'` : sql`false`}
        OR u.role = 'admin'
        OR EXISTS (SELECT 1 FROM user_memberships m WHERE m.user_id = u.id AND (m.collection_id = ${d.collectionId} OR m.document_id = ${d.id}))
        OR EXISTS (SELECT 1 FROM group_memberships gm JOIN group_users gu ON gu.group_id = gm.group_id WHERE gu.user_id = u.id AND (gm.collection_id = ${d.collectionId} OR gm.document_id = ${d.id}))
      )
      ${query ? sql`AND notes_norm(u.name) LIKE ${"%" + query.toLowerCase() + "%"}` : sql``}
      ${userId ? sql`AND u.id = ${userId}` : sql``}
    ORDER BY u.name LIMIT ${limit} OFFSET ${offset}`;
  return { pagination: page("documents.users", limit, offset, rows.length), data: rows.map((u) => presentUser(u)), policies: rows.map((u) => userPolicy(call.user, u)) };
});

method("documents.memberships", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }));
  const { limit, offset } = call.params.pagination();
  const rows = await sql<MembershipRow[]>`SELECT * FROM user_memberships WHERE document_id = ${d.id} ORDER BY created_at LIMIT ${limit} OFFSET ${offset}`;
  const users = await usersById(rows.map((m) => m.userId));
  return { pagination: page("documents.memberships", limit, offset, rows.length), data: { memberships: rows.map(presentMembership), users: [...users.values()].map((u) => presentUser(u)) } };
});

method("documents.add_user", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }), "read_write");
  const userId = call.params.uuid("userId", { required: true })!;
  const user = await getUser(userId);
  if (!user || user.teamId !== d.teamId) throw notFound();
  const permission = call.params.oneOf("permission", PERMISSIONS) ?? "read_write";
  const [m] = await sql<MembershipRow[]>`
    INSERT INTO user_memberships (user_id, document_id, permission, created_by_id) VALUES (${userId}, ${d.id}, ${permission}, ${call.user.id})
    ON CONFLICT (user_id, document_id) WHERE document_id IS NOT NULL DO UPDATE SET permission = excluded.permission, updated_at = now()
    RETURNING *`;
  publish({ name: "documents.add_user", data: { userId, documentId: d.id, id: m.id }, teamId: d.teamId, documentId: d.id, userIds: [userId], actorId: call.user.id });
  await notify(d.teamId, [userId], { event: "documents.add_user", actorId: call.user.id, documentId: d.id, collectionId: d.collectionId });
  return { data: { users: [presentUser(user)], memberships: [presentMembership(m)] } };
});

method("documents.remove_user", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }));
  const userId = call.params.uuid("userId", { required: true })!;
  if (userId !== call.user.id && !atLeast(a.document(d), "read_write")) throw forbidden();
  await sql`DELETE FROM user_memberships WHERE user_id = ${userId} AND document_id = ${d.id}`;
  publish({ name: "documents.remove_user", data: { userId, documentId: d.id }, teamId: d.teamId, documentId: d.id, userIds: [userId], actorId: call.user.id });
  return { success: true };
});

method("documents.group_memberships", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }));
  const { limit, offset } = call.params.pagination();
  const rows = await sql<MembershipRow[]>`SELECT * FROM group_memberships WHERE document_id = ${d.id} ORDER BY created_at LIMIT ${limit} OFFSET ${offset}`;
  const groups = await sql<GroupRow[]>`
    SELECT g.*, (SELECT count(*)::int FROM group_users gu WHERE gu.group_id = g.id) AS member_count FROM groups g WHERE g.id = ANY(${rows.map((r) => r.groupId!)}::uuid[])`;
  return { pagination: page("documents.group_memberships", limit, offset, rows.length), data: { groups: groups.map(presentGroup), groupMemberships: rows.map(presentGroupMembership) } };
});

method("documents.add_group", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }), "read_write");
  const groupId = call.params.uuid("groupId", { required: true })!;
  const [group] = await sql<GroupRow[]>`SELECT * FROM groups WHERE id = ${groupId} AND team_id = ${d.teamId} AND deleted_at IS NULL`;
  if (!group) throw notFound();
  const permission = call.params.oneOf("permission", PERMISSIONS) ?? "read_write";
  const [m] = await sql<MembershipRow[]>`
    INSERT INTO group_memberships (group_id, document_id, permission, created_by_id) VALUES (${groupId}, ${d.id}, ${permission}, ${call.user.id})
    ON CONFLICT (group_id, document_id) WHERE document_id IS NOT NULL DO UPDATE SET permission = excluded.permission, updated_at = now()
    RETURNING *`;
  publish({ name: "documents.add_group", data: { groupId, documentId: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
  return { data: { groups: [presentGroup(group)], groupMemberships: [presentGroupMembership(m)] } };
});

method("documents.remove_group", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }), "read_write");
  const groupId = call.params.uuid("groupId", { required: true })!;
  await sql`DELETE FROM group_memberships WHERE group_id = ${groupId} AND document_id = ${d.id}`;
  publish({ name: "documents.remove_group", data: { groupId, documentId: d.id }, teamId: d.teamId, documentId: d.id, actorId: call.user.id });
  return { success: true };
});
