// The rest of the reading list: stars, pins, views, "shared with me", revisions, templates and people.

import fractionalIndex from "fractional-index";
import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { Access, atLeast } from "../access.ts";
import { contentFrom, contentFromMarkdown, newUrlId, parseData } from "../content.ts";
import { publish } from "../events.ts";
import { forbidden, notFound } from "../http.ts";
import { documentPolicy, starPolicy, userPolicy } from "../policies.ts";
import {
  DOC_COLUMNS,
  presentDocuments,
  presentGroup,
  presentGroupMembership,
  presentMembership,
  presentPin,
  presentRevision,
  presentStar,
  presentUser,
  usersById,
  type DocumentRow,
  type GroupRow,
  type MembershipRow,
} from "../presenters.ts";
import { method } from "../rpc.ts";
import { currentTeam, type UserRow } from "../users.ts";
import { collectionFor, documentFor, page } from "./common.ts";
import { presentWithPolicies } from "./documents.ts";

interface StarRow {
  id: string;
  userId: string;
  documentId: string | null;
  collectionId: string | null;
  index: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------- Stars ----------

method("stars.list", async (call) => {
  const a = await Access.for(call.user);
  const { limit, offset } = call.params.pagination();
  const stars = await sql<StarRow[]>`SELECT * FROM stars WHERE user_id = ${call.user.id} ORDER BY index COLLATE "C" NULLS LAST, created_at LIMIT ${limit} OFFSET ${offset}`;
  const docIds = stars.map((s) => s.documentId).filter((x): x is string => !!x);
  const docs = docIds.length ? await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ANY(${docIds}::uuid[]) AND d.deleted_at IS NULL` : [];
  const readable = docs.filter((d) => a.document(d));
  const presented = await presentWithPolicies(a, readable);
  return {
    pagination: page("stars.list", limit, offset),
    data: { stars: stars.map(presentStar), documents: presented.data },
    policies: [...stars.map((s) => starPolicy(s.id)), ...presented.policies],
  };
});

method("stars.create", async (call) => {
  const a = await Access.for(call.user);
  const documentId = call.params.uuid("documentId");
  const collectionId = call.params.uuid("collectionId");
  if (documentId) await documentFor(a, documentId);
  else if (collectionId) await collectionFor(a, collectionId);
  else throw notFound();
  const [existing] = await sql<StarRow[]>`SELECT * FROM stars WHERE user_id = ${call.user.id} AND ${documentId ? sql`document_id = ${documentId}` : sql`collection_id = ${collectionId!}`}`;
  if (existing) return { data: presentStar(existing), policies: [starPolicy(existing.id)] };
  let index = call.params.string("index");
  if (!index) {
    const [first] = await sql<{ index: string | null }[]>`SELECT index FROM stars WHERE user_id = ${call.user.id} ORDER BY index COLLATE "C" NULLS LAST LIMIT 1`;
    index = fractionalIndex(null, first?.index ?? null);
  }
  const [s] = await sql<StarRow[]>`INSERT INTO stars (user_id, document_id, collection_id, index) VALUES (${call.user.id}, ${documentId ?? null}, ${collectionId ?? null}, ${index}) RETURNING *`;
  publish({ name: "stars.create", data: presentStar(s), teamId: call.user.teamId, userIds: [call.user.id], actorId: call.user.id });
  return { data: presentStar(s), policies: [starPolicy(s.id)] };
});

method("stars.update", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const index = call.params.string("index", { required: true, max: 100 })!;
  const [s] = await sql<StarRow[]>`UPDATE stars SET index = ${index}, updated_at = now() WHERE id = ${id} AND user_id = ${call.user.id} RETURNING *`;
  if (!s) throw notFound();
  publish({ name: "stars.update", data: presentStar(s), teamId: call.user.teamId, userIds: [call.user.id], actorId: call.user.id });
  return { data: presentStar(s), policies: [starPolicy(s.id)] };
});

method("stars.delete", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const [s] = await sql<StarRow[]>`DELETE FROM stars WHERE id = ${id} AND user_id = ${call.user.id} RETURNING *`;
  if (!s) throw notFound();
  publish({ name: "stars.delete", data: presentStar(s), teamId: call.user.teamId, userIds: [call.user.id], actorId: call.user.id });
  return { success: true };
});

// ---------- Pins ----------

interface PinRow {
  id: string;
  teamId: string;
  documentId: string;
  collectionId: string | null;
  index: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

method("pins.list", async (call) => {
  const a = await Access.for(call.user);
  const { limit, offset } = call.params.pagination();
  const collectionId = call.params.nullableUuid("collectionId") ?? null;
  if (collectionId) await collectionFor(a, collectionId);
  const pins = await sql<PinRow[]>`
    SELECT * FROM pins WHERE team_id = ${call.user.teamId} AND ${collectionId ? sql`collection_id = ${collectionId}` : sql`collection_id IS NULL`}
    ORDER BY index COLLATE "C" NULLS LAST, created_at LIMIT ${limit} OFFSET ${offset}`;
  const docs = pins.length ? await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ANY(${pins.map((p) => p.documentId)}::uuid[]) AND d.deleted_at IS NULL AND d.archived_at IS NULL` : [];
  const readable = docs.filter((d) => a.document(d));
  const visible = pins.filter((p) => readable.some((d) => d.id === p.documentId));
  const presented = await presentWithPolicies(a, readable);
  return {
    pagination: page("pins.list", limit, offset),
    data: { pins: visible.map(presentPin), documents: presented.data },
    policies: [...visible.map((p) => ({ id: p.id, abilities: { read: true, update: true, delete: true } })), ...presented.policies],
  };
});

method("pins.create", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.uuid("documentId", { required: true }), "read_write");
  const collectionId = call.params.nullableUuid("collectionId") ?? null;
  if (!collectionId && !a.isAdmin) throw forbidden();
  const [last] = await sql<{ index: string | null }[]>`
    SELECT index FROM pins WHERE team_id = ${d.teamId} AND ${collectionId ? sql`collection_id = ${collectionId}` : sql`collection_id IS NULL`} ORDER BY index COLLATE "C" DESC NULLS LAST LIMIT 1`;
  const index = call.params.string("index") ?? fractionalIndex(last?.index ?? null, null);
  const [pin] = await sql<PinRow[]>`INSERT INTO pins (team_id, document_id, collection_id, index, created_by_id) VALUES (${d.teamId}, ${d.id}, ${collectionId}, ${index}, ${call.user.id}) RETURNING *`;
  publish({ name: "pins.create", data: presentPin(pin), teamId: d.teamId, collectionId, actorId: call.user.id });
  return { data: presentPin(pin), policies: [{ id: pin.id, abilities: { read: true, update: true, delete: true } }] };
});

method("pins.update", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const index = call.params.string("index", { required: true, max: 100 })!;
  const [pin] = await sql<PinRow[]>`UPDATE pins SET index = ${index}, updated_at = now() WHERE id = ${id} AND team_id = ${call.user.teamId} RETURNING *`;
  if (!pin) throw notFound();
  publish({ name: "pins.update", data: presentPin(pin), teamId: pin.teamId, collectionId: pin.collectionId, actorId: call.user.id });
  return { data: presentPin(pin), policies: [{ id: pin.id, abilities: { read: true, update: true, delete: true } }] };
});

method("pins.delete", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const [pin] = await sql<PinRow[]>`DELETE FROM pins WHERE id = ${id} AND team_id = ${call.user.teamId} RETURNING *`;
  if (!pin) throw notFound();
  publish({ name: "pins.delete", data: presentPin(pin), teamId: pin.teamId, collectionId: pin.collectionId, actorId: call.user.id });
  return { success: true };
});

// ---------- Views ----------

method("views.list", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.uuid("documentId", { required: true }));
  const views = await sql<{ id: string; userId: string; documentId: string; count: number; firstViewedAt: Date; lastViewedAt: Date }[]>`
    SELECT * FROM views WHERE document_id = ${d.id} ORDER BY last_viewed_at DESC LIMIT 100`;
  const users = await usersById(views.map((v) => v.userId));
  return {
    pagination: page("views.list", 100, 0),
    data: views
      .filter((v) => users.has(v.userId))
      .map((v) => ({ id: v.id, documentId: v.documentId, firstViewedAt: v.firstViewedAt.toISOString(), lastViewedAt: v.lastViewedAt.toISOString(), count: v.count, userId: v.userId, user: presentUser(users.get(v.userId)!) })),
  };
});

method("views.create", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.uuid("documentId", { required: true }));
  await sql`INSERT INTO views (user_id, document_id) VALUES (${call.user.id}, ${d.id}) ON CONFLICT (user_id, document_id) DO UPDATE SET count = views.count + 1, last_viewed_at = now()`;
  return { success: true };
});

// ---------- Shared with me ----------

method("userMemberships.list", async (call) => {
  const a = await Access.for(call.user);
  const { limit, offset } = call.params.pagination();
  const rows = await sql<MembershipRow[]>`
    SELECT * FROM user_memberships WHERE user_id = ${call.user.id} AND document_id IS NOT NULL AND source_id IS NULL
    ORDER BY index COLLATE "C" NULLS LAST, created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const docs = rows.length ? await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ANY(${rows.map((m) => m.documentId!)}::uuid[]) AND d.deleted_at IS NULL` : [];
  const presented = await presentWithPolicies(a, docs.filter((d) => a.document(d)));
  return {
    pagination: page("userMemberships.list", limit, offset),
    data: { memberships: rows.map(presentMembership), documents: presented.data },
    policies: [...rows.map((m) => ({ id: m.id, abilities: { read: true, update: true, delete: true } })), ...presented.policies],
  };
});

method("userMemberships.update", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const index = call.params.string("index", { required: true, max: 100 })!;
  const [m] = await sql<MembershipRow[]>`UPDATE user_memberships SET index = ${index}, updated_at = now() WHERE id = ${id} AND user_id = ${call.user.id} RETURNING *`;
  if (!m) throw notFound();
  return { data: presentMembership(m), policies: [{ id: m.id, abilities: { read: true, update: true, delete: true } }] };
});

method("groupMemberships.list", async (call) => {
  const a = await Access.for(call.user);
  const { limit, offset } = call.params.pagination();
  const rows = await sql<MembershipRow[]>`
    SELECT gm.* FROM group_memberships gm JOIN group_users gu ON gu.group_id = gm.group_id
    WHERE gu.user_id = ${call.user.id} AND gm.document_id IS NOT NULL AND gm.source_id IS NULL ORDER BY gm.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const groups = rows.length ? await sql<GroupRow[]>`SELECT g.*, (SELECT count(*)::int FROM group_users gu WHERE gu.group_id = g.id) AS member_count FROM groups g WHERE g.id = ANY(${rows.map((r) => r.groupId!)}::uuid[])` : [];
  const docs = rows.length ? await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ANY(${rows.map((m) => m.documentId!)}::uuid[]) AND d.deleted_at IS NULL` : [];
  const presented = await presentWithPolicies(a, docs.filter((d) => a.document(d)));
  return {
    pagination: page("groupMemberships.list", limit, offset, rows.length),
    data: { groups: groups.map(presentGroup), groupMemberships: rows.map(presentGroupMembership), documents: presented.data },
    policies: presented.policies,
  };
});

// ---------- Revisions ----------

interface RevisionRow {
  id: string;
  documentId: string;
  userId: string | null;
  title: string;
  name: string | null;
  icon: string | null;
  color: string | null;
  text: string;
  content: unknown;
  collaboratorIds: string[];
  sourceMetadata: unknown;
  createdAt: Date;
  deletedAt: Date | null;
}

method("revisions.list", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.uuid("documentId", { required: true }));
  const { limit, offset } = call.params.pagination();
  const rows = await sql<RevisionRow[]>`
    SELECT id, document_id, user_id, title, name, icon, color, collaborator_ids, source_metadata, created_at, deleted_at FROM revisions
    WHERE document_id = ${d.id} AND deleted_at IS NULL ORDER BY created_at ${call.params.direction("DESC") === "ASC" ? sql`ASC` : sql`DESC`} LIMIT ${limit} OFFSET ${offset}`;
  const users = await usersById(rows.flatMap((r) => [r.userId, ...r.collaboratorIds]));
  const write = atLeast(a.document(d), "read_write");
  return {
    pagination: page("revisions.list", limit, offset),
    data: rows.map((r) => presentRevision(r, users)),
    policies: rows.map((r) => ({ id: r.id, abilities: { update: write, delete: write } })),
  };
});

method("revisions.info", async (call) => {
  const a = await Access.for(call.user);
  const id = call.params.uuid("id", { required: true })!;
  const [r] = await sql<RevisionRow[]>`SELECT * FROM revisions WHERE id = ${id}`;
  if (!r) throw notFound();
  const d = await documentFor(a, r.documentId);
  const users = await usersById([r.userId, ...r.collaboratorIds]);
  const write = atLeast(a.document(d), "read_write");
  return { data: presentRevision(r, users, { includeData: true }), policies: [{ id: r.id, abilities: { update: write, delete: write } }] };
});

/** A named version (revisions.update renames one). */
method("revisions.update", async (call) => {
  const a = await Access.for(call.user);
  const id = call.params.uuid("id", { required: true })!;
  const [r] = await sql<RevisionRow[]>`SELECT * FROM revisions WHERE id = ${id}`;
  if (!r) throw notFound();
  await documentFor(a, r.documentId, "read_write");
  const [u] = await sql<RevisionRow[]>`UPDATE revisions SET name = ${call.params.nullableString("name", 255) ?? null} WHERE id = ${id} RETURNING *`;
  const users = await usersById([u.userId, ...u.collaboratorIds]);
  return { data: presentRevision(u, users), policies: [{ id: u.id, abilities: { update: true, delete: true } }] };
});

// ---------- Templates (documents flagged as templates) ----------

async function templateFor(a: Access, id: string | undefined, write = false) {
  const d = await documentFor(a, id, write ? "read_write" : "read");
  if (!d.isTemplate) throw notFound();
  return d;
}

method("templates.list", async (call) => {
  const a = await Access.for(call.user);
  const { limit, offset } = call.params.pagination();
  const collectionId = call.params.uuid("collectionId");
  const rows = await sql<DocumentRow[]>`
    SELECT ${DOC_COLUMNS} FROM documents d WHERE d.team_id = ${call.user.teamId} AND d.is_template AND d.deleted_at IS NULL
      AND (d.collection_id IS NULL OR d.collection_id = ANY(${a.readableCollections()}::uuid[]))
      ${collectionId ? sql`AND d.collection_id = ${collectionId}` : sql``}
    ORDER BY d.updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const team = await currentTeam();
  return { pagination: page("templates.list", limit, offset), data: await presentDocuments(rows, { includeData: true }), policies: rows.map((d) => documentPolicy(a, d, team)) };
});

method("templates.info", async (call) => {
  const a = await Access.for(call.user);
  const d = await templateFor(a, call.params.string("id", { required: true }));
  const team = await currentTeam();
  return { data: (await presentDocuments([d], { includeData: true }))[0], policies: [documentPolicy(a, d, team)] };
});

method("templates.create", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  if (call.user.role === "viewer" || call.user.role === "guest") throw forbidden();
  const collectionId = p.nullableUuid("collectionId") ?? null;
  if (collectionId) await collectionFor(a, collectionId, "read_write");
  const data = p.object("data");
  const content = data ? contentFrom(parseData(data)) : contentFromMarkdown(p.string("text") ?? "");
  const id = randomUUID();
  await sql`
    INSERT INTO documents (id, url_id, team_id, collection_id, title, icon, color, text, content, state, full_width, is_template, created_by_id, last_modified_by_id, collaborator_ids, published_at)
    VALUES (${id}, ${newUrlId()}, ${call.user.teamId}, ${collectionId}, ${p.string("title", { max: 255 }) ?? ""}, ${p.nullableString("icon", 50) ?? null}, ${p.nullableString("color", 20) ?? null},
            ${content.text}, ${sql.json(content.content as never)}, ${content.state}, ${p.boolean("fullWidth") ?? false}, true, ${call.user.id}, ${call.user.id}, ${[call.user.id]}::uuid[], now())`;
  const [d] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${id}`;
  const team = await currentTeam();
  return { data: (await presentDocuments([d], { includeData: true }))[0], policies: [documentPolicy(await Access.for(call.user), d, team)] };
});

method("templates.update", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  const t = await templateFor(a, p.string("id", { required: true }), true);
  const data = p.object("data");
  const content = data ? contentFrom(parseData(data)) : undefined;
  const collectionId = p.has("collectionId") ? (p.nullableUuid("collectionId") ?? null) : t.collectionId;
  if (collectionId && collectionId !== t.collectionId) await collectionFor(a, collectionId, "read_write");
  await sql`
    UPDATE documents SET title = ${p.string("title", { max: 255 }) ?? t.title}, icon = ${p.has("icon") ? (p.nullableString("icon", 50) ?? null) : t.icon},
      color = ${p.has("color") ? (p.nullableString("color", 20) ?? null) : t.color}, full_width = ${p.boolean("fullWidth") ?? t.fullWidth}, collection_id = ${collectionId},
      ${content ? sql`text = ${content.text}, content = ${sql.json(content.content as never)}, state = ${content.state},` : sql``}
      last_modified_by_id = ${call.user.id}, updated_at = now()
    WHERE id = ${t.id}`;
  const [d] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${t.id}`;
  const team = await currentTeam();
  return { data: (await presentDocuments([d], { includeData: true }))[0], policies: [documentPolicy(a, d, team)] };
});

method("templates.delete", async (call) => {
  const a = await Access.for(call.user);
  const t = await templateFor(a, call.params.string("id", { required: true }), true);
  await sql`UPDATE documents SET deleted_at = now(), deleted_by_id = ${call.user.id} WHERE id = ${t.id}`;
  return { success: true };
});

method("templates.restore", async (call) => {
  const a = await Access.for(call.user);
  const t = await templateFor(a, call.params.string("id", { required: true }), true);
  await sql`UPDATE documents SET deleted_at = NULL, deleted_by_id = NULL WHERE id = ${t.id}`;
  const [d] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${t.id}`;
  const team = await currentTeam();
  return { data: (await presentDocuments([d], { includeData: true }))[0], policies: [documentPolicy(a, d, team)] };
});

method("templates.duplicate", async (call) => {
  const a = await Access.for(call.user);
  const t = await templateFor(a, call.params.string("id", { required: true }));
  const content = t.content ? contentFrom(t.content as never) : contentFromMarkdown(t.text);
  const id = randomUUID();
  await sql`
    INSERT INTO documents (id, url_id, team_id, collection_id, title, icon, color, text, content, state, full_width, is_template, created_by_id, last_modified_by_id, collaborator_ids, published_at)
    VALUES (${id}, ${newUrlId()}, ${t.teamId}, ${t.collectionId}, ${call.params.string("title", { max: 255 }) ?? t.title}, ${t.icon}, ${t.color}, ${content.text},
            ${sql.json(content.content as never)}, ${content.state}, ${t.fullWidth}, true, ${call.user.id}, ${call.user.id}, ${[call.user.id]}::uuid[], now())`;
  const [d] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${id}`;
  const team = await currentTeam();
  return { data: (await presentDocuments([d], { includeData: true }))[0], policies: [documentPolicy(a, d, team)] };
});

// ---------- People ----------

method("users.list", async (call) => {
  const p = call.params;
  const { limit, offset } = p.pagination();
  const query = p.string("query");
  const ids = p.array("ids")?.filter((x): x is string => typeof x === "string");
  const filter = p.string("filter") ?? "active";
  const admin = call.user.role === "admin";
  const status = {
    active: sql`u.suspended_at IS NULL`,
    all: sql`true`,
    suspended: admin ? sql`u.suspended_at IS NOT NULL` : sql`false`,
    invited: sql`u.last_signed_in_at IS NULL AND u.suspended_at IS NULL`,
    admins: sql`u.role = 'admin' AND u.suspended_at IS NULL`,
    members: sql`u.role = 'member' AND u.suspended_at IS NULL`,
    viewers: sql`u.role = 'viewer' AND u.suspended_at IS NULL`,
    guests: sql`u.role = 'guest' AND u.suspended_at IS NULL`,
  }[filter] ?? sql`u.suspended_at IS NULL`;
  const sort = { name: sql`lower(u.name)`, email: sql`lower(u.email)`, createdAt: sql`u.created_at`, updatedAt: sql`u.updated_at`, lastActiveAt: sql`u.last_active_at` }[p.string("sort") ?? "name"] ?? sql`lower(u.name)`;
  const where = sql`u.team_id = ${call.user.teamId} AND u.deleted_at IS NULL AND ${status}
    ${query ? sql`AND (notes_norm(u.name) LIKE ${"%" + query.toLowerCase() + "%"} ${admin ? sql`OR lower(u.email) LIKE ${"%" + query.toLowerCase() + "%"}` : sql``})` : sql``}
    ${ids?.length ? sql`AND u.id = ANY(${ids}::uuid[])` : sql``}`;
  const rows = await sql<UserRow[]>`SELECT u.* FROM users u WHERE ${where} ORDER BY ${sort} ${p.direction("ASC") === "ASC" ? sql`ASC` : sql`DESC`} NULLS LAST, u.id LIMIT ${limit} OFFSET ${offset}`;
  const [{ total }] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM users u WHERE ${where}`;
  return {
    pagination: page("users.list", limit, offset, total),
    data: rows.map((u) => presentUser(u, { includeDetails: admin || u.id === call.user.id })),
    policies: rows.map((u) => userPolicy(call.user, u)),
  };
});
