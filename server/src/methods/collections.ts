// collections.*: the sidebar's collections, their overview, tree, access and order.

import fractionalIndex from "fractional-index";
import { sql } from "../db.ts";
import { Access } from "../access.ts";
import { checkDoc, markdownToDoc, newUrlId } from "../content.ts";
import { diff, publish } from "../events.ts";
import { notify } from "../notify.ts";
import { forbidden, invalid, notFound } from "../http.ts";
import { toMarkdown, type PMNode } from "../markdown.ts";
import { collectionPolicy, userPolicy } from "../policies.ts";
import { presentCollection, presentGroup, presentGroupMembership, presentMembership, presentUser, usersById, type CollectionRow, type GroupRow, type MembershipRow } from "../presenters.ts";
import { method, type SignedInCall } from "../rpc.ts";
import { teamById, getUser, type UserRow } from "../users.ts";
import { collectionFor, page } from "./common.ts";

const PERMISSIONS = ["read", "read_write"] as const;
const MEMBER_PERMISSIONS = ["read", "read_write", "admin"] as const;

/** The overview from whichever form the client sent: Markdown (description) or JSON (data). */
function overview(call: SignedInCall): { description: string; content: unknown } | undefined {
  const data = call.params.object("data");
  if (data) {
    const doc = checkDoc(data);
    return { description: toMarkdown(doc as PMNode), content: doc };
  }
  const description = call.params.nullableString("description", 100_000);
  if (description === undefined) return undefined;
  return { description: description ?? "", content: markdownToDoc(description ?? "") };
}

async function present(call: SignedInCall, c: CollectionRow, a: Access) {
  const team = await teamById(call.user.teamId);
  const archivedBy = c.archivedById ? await getUser(c.archivedById) : null;
  return { data: presentCollection(c, call.apiVersion, archivedBy), policies: [collectionPolicy(a, c, team)] };
}

method("collections.list", async (call) => {
  const a = await Access.for(call.user);
  const { limit, offset } = call.params.pagination();
  const archived = call.params.string("statusFilter")?.includes("archived") ?? false;
  const query = call.params.string("query");
  const ids = a.readableCollections();
  const where = sql`c.id = ANY(${ids}::uuid[]) AND c.deleted_at IS NULL AND ${archived ? sql`c.archived_at IS NOT NULL` : sql`c.archived_at IS NULL`}
    ${query ? sql`AND notes_norm(c.name) LIKE ${"%" + query.toLowerCase() + "%"}` : sql``}`;
  const [rows, [{ total }]] = await Promise.all([
    sql<CollectionRow[]>`SELECT c.* FROM collections c WHERE ${where} ORDER BY c.index COLLATE "C" NULLS LAST, c.created_at LIMIT ${limit} OFFSET ${offset}`,
    sql<{ total: number }[]>`SELECT count(*)::int AS total FROM collections c WHERE ${where}`,
  ]);
  const team = await teamById(call.user.teamId);
  return {
    pagination: page("collections.list", limit, offset, total),
    data: rows.map((c) => presentCollection(c, call.apiVersion)),
    policies: rows.map((c) => collectionPolicy(a, c, team)),
  };
});

method("collections.info", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.string("id", { required: true }), "read", { includeDeleted: true });
  return present(call, c, a);
});

method("collections.documents", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.string("id", { required: true }));
  return { data: c.documentStructure ?? [] };
});

method("collections.create", async (call) => {
  const team = await teamById(call.user.teamId);
  const admin = call.user.role === "admin";
  if (!admin && !(call.user.role === "member" && team.memberCollectionCreate)) throw forbidden();
  const name = call.params.string("name", { required: true, max: 100 })!.trim();
  if (!name) throw invalid("name is required");
  const o = overview(call) ?? { description: "", content: null };
  let index = call.params.string("index");
  if (!index) {
    const [last] = await sql<{ index: string | null }[]>`SELECT index FROM collections WHERE team_id = ${team.id} AND deleted_at IS NULL ORDER BY index COLLATE "C" DESC NULLS LAST LIMIT 1`;
    index = fractionalIndex(last?.index ?? null, null);
  }
  const permission = call.params.raw.permission === null ? null : (call.params.oneOf("permission", PERMISSIONS) ?? null);
  const sort = call.params.object("sort") ?? { field: "index", direction: "asc" };
  const at = index;
  let c!: CollectionRow;
  await sql.begin(async (tx) => {
    [c] = await tx<CollectionRow[]>`
      INSERT INTO collections (url_id, team_id, name, description, content, icon, color, index, permission, sharing, commenting, sort, created_by_id)
      VALUES (${newUrlId()}, ${team.id}, ${name}, ${o.description}, ${o.content ? tx.json(o.content as never) : null}, ${call.params.nullableString("icon", 50) ?? null},
              ${call.params.nullableString("color", 20) ?? null}, ${at}, ${permission}, ${call.params.boolean("sharing") ?? true}, ${call.params.boolean("commenting") ?? null},
              ${tx.json(sort as never)}, ${call.user.id})
      RETURNING *`;
    // The creator manages it (and is how a private collection has anyone at all).
    await tx`INSERT INTO user_memberships (user_id, collection_id, permission, created_by_id) VALUES (${call.user.id}, ${c.id}, 'admin', ${call.user.id})`;
  });
  publish({ name: "collections.create", data: { id: c.id }, teamId: team.id, collectionId: c.id, actorId: call.user.id });
  return present(call, c, await Access.for(call.user));
});

method("collections.update", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.string("id", { required: true }), "admin");
  const p = call.params;
  const o = overview(call);
  const name = p.string("name", { max: 100 });
  if (name !== undefined && !name.trim()) throw invalid("name can't be empty");
  const permission = p.has("permission") ? (p.raw.permission === null || p.raw.permission === "" ? null : p.oneOf("permission", PERMISSIONS)!) : undefined;
  const [updated] = await sql<CollectionRow[]>`
    UPDATE collections SET
      name = ${name?.trim() ?? c.name},
      description = ${o ? o.description : c.description},
      content = ${o ? sql.json(o.content as never) : c.content === null ? null : sql.json(c.content as never)},
      icon = ${p.has("icon") ? (p.nullableString("icon", 50) ?? null) : c.icon},
      color = ${p.has("color") ? (p.nullableString("color", 20) ?? null) : c.color},
      permission = ${permission !== undefined ? permission : c.permission},
      sharing = ${p.boolean("sharing") ?? c.sharing},
      commenting = ${p.has("commenting") ? (p.boolean("commenting") ?? null) : c.commenting},
      sort = ${sql.json((p.object("sort") ?? c.sort) as never)},
      template_management = ${p.string("templateManagement") ?? c.templateManagement},
      updated_at = now()
    WHERE id = ${c.id} RETURNING *`;
  const changes = diff(c, updated, ["name", "icon", "color", "permission", "sharing", "commenting"]);
  publish({ name: "collections.update", data: { id: c.id, name: updated.name }, teamId: c.teamId, collectionId: c.id, actorId: call.user.id, changes });
  return present(call, updated, await Access.for(call.user));
});

method("collections.move", async (call) => {
  if (call.user.role !== "admin") throw forbidden();
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }));
  const index = call.params.string("index", { required: true, max: 100 })!;
  await sql`UPDATE collections SET index = ${index}, updated_at = now() WHERE id = ${c.id}`;
  publish({ name: "collections.move", data: { collectionId: c.id, index }, teamId: c.teamId, collectionId: c.id, actorId: call.user.id });
  return { data: { index } };
});

method("collections.delete", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }), "admin");
  await sql.begin(async (tx) => {
    await tx`UPDATE collections SET deleted_at = now() WHERE id = ${c.id}`;
    await tx`UPDATE documents SET deleted_at = now(), deleted_by_id = ${call.user.id} WHERE collection_id = ${c.id} AND deleted_at IS NULL`;
  });
  publish({ name: "collections.delete", data: { id: c.id }, teamId: c.teamId, collectionId: c.id, actorId: call.user.id });
  return { success: true };
});

method("collections.archive", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }), "admin");
  const [updated] = await sql<CollectionRow[]>`UPDATE collections SET archived_at = now(), archived_by_id = ${call.user.id} WHERE id = ${c.id} RETURNING *`;
  publish({ name: "collections.archive", data: { id: c.id }, teamId: c.teamId, collectionId: c.id, actorId: call.user.id });
  return present(call, updated, a);
});

method("collections.restore", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }), "admin");
  const [updated] = await sql<CollectionRow[]>`UPDATE collections SET archived_at = NULL, archived_by_id = NULL WHERE id = ${c.id} RETURNING *`;
  publish({ name: "collections.restore", data: { id: c.id }, teamId: c.teamId, collectionId: c.id, actorId: call.user.id });
  return present(call, updated, a);
});

// ---------- Access: people and groups ----------

method("collections.add_user", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }), "admin");
  const userId = call.params.uuid("userId", { required: true })!;
  const user = await getUser(userId);
  if (!user || user.teamId !== c.teamId) throw notFound();
  const permission = call.params.oneOf("permission", MEMBER_PERMISSIONS) ?? "read_write";
  const [m] = await sql<MembershipRow[]>`
    INSERT INTO user_memberships (user_id, collection_id, permission, created_by_id) VALUES (${userId}, ${c.id}, ${permission}, ${call.user.id})
    ON CONFLICT (user_id, collection_id) WHERE collection_id IS NOT NULL DO UPDATE SET permission = excluded.permission, updated_at = now()
    RETURNING *`;
  publish({ name: "collections.add_user", data: { userId, collectionId: c.id, permission }, teamId: c.teamId, collectionId: c.id, userIds: [userId], actorId: call.user.id });
  await notify(c.teamId, [userId], { event: "collections.add_user", actorId: call.user.id, collectionId: c.id });
  return { data: { users: [presentUser(user)], memberships: [presentMembership(m)] } };
});

method("collections.remove_user", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }), "admin");
  const userId = call.params.uuid("userId", { required: true })!;
  await sql`DELETE FROM user_memberships WHERE user_id = ${userId} AND collection_id = ${c.id}`;
  publish({ name: "collections.remove_user", data: { userId, collectionId: c.id }, teamId: c.teamId, collectionId: c.id, userIds: [userId], actorId: call.user.id });
  return { success: true };
});

method("collections.memberships", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }));
  const { limit, offset } = call.params.pagination();
  const query = call.params.string("query");
  const permission = call.params.oneOf("permission", MEMBER_PERMISSIONS);
  const rows = await sql<(MembershipRow & { userName: string })[]>`
    SELECT m.*, u.name AS user_name FROM user_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.collection_id = ${c.id} AND u.deleted_at IS NULL
      ${permission ? sql`AND m.permission = ${permission}` : sql``}
      ${query ? sql`AND notes_norm(u.name) LIKE ${"%" + query.toLowerCase() + "%"}` : sql``}
    ORDER BY u.name LIMIT ${limit} OFFSET ${offset}`;
  const users = await usersById(rows.map((m) => m.userId));
  return {
    pagination: page("collections.memberships", limit, offset),
    data: { users: [...users.values()].map((u) => presentUser(u)), memberships: rows.map(presentMembership) },
    policies: [...users.values()].map((u: UserRow) => userPolicy(call.user, u)),
  };
});

method("collections.add_group", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }), "admin");
  const groupId = call.params.uuid("groupId", { required: true })!;
  const [group] = await sql<GroupRow[]>`SELECT * FROM groups WHERE id = ${groupId} AND team_id = ${c.teamId} AND deleted_at IS NULL`;
  if (!group) throw notFound();
  const permission = call.params.oneOf("permission", MEMBER_PERMISSIONS) ?? "read_write";
  const [m] = await sql<MembershipRow[]>`
    INSERT INTO group_memberships (group_id, collection_id, permission, created_by_id) VALUES (${groupId}, ${c.id}, ${permission}, ${call.user.id})
    ON CONFLICT (group_id, collection_id) WHERE collection_id IS NOT NULL DO UPDATE SET permission = excluded.permission, updated_at = now()
    RETURNING *`;
  publish({ name: "collections.add_group", data: { groupId, collectionId: c.id, permission }, teamId: c.teamId, collectionId: c.id, actorId: call.user.id });
  return { data: { groups: [presentGroup(group)], groupMemberships: [presentGroupMembership(m)] } };
});

method("collections.remove_group", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }), "admin");
  const groupId = call.params.uuid("groupId", { required: true })!;
  await sql`DELETE FROM group_memberships WHERE group_id = ${groupId} AND collection_id = ${c.id}`;
  publish({ name: "collections.remove_group", data: { groupId, collectionId: c.id }, teamId: c.teamId, collectionId: c.id, actorId: call.user.id });
  return { success: true };
});

method("collections.group_memberships", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }));
  const { limit, offset } = call.params.pagination();
  const rows = await sql<(MembershipRow & GroupRow & { membershipId: string; gName: string })[]>`
    SELECT gm.id, gm.group_id, gm.collection_id, gm.document_id, gm.permission, gm.source_id, gm.created_by_id, gm.created_at FROM group_memberships gm
    JOIN groups g ON g.id = gm.group_id WHERE gm.collection_id = ${c.id} AND g.deleted_at IS NULL ORDER BY g.name LIMIT ${limit} OFFSET ${offset}`;
  const groups = await sql<GroupRow[]>`
    SELECT g.*, (SELECT count(*)::int FROM group_users gu WHERE gu.group_id = g.id) AS member_count FROM groups g WHERE g.id = ANY(${rows.map((r) => r.groupId!)}::uuid[])`;
  return { pagination: page("collections.group_memberships", limit, offset), data: { groups: groups.map(presentGroup), groupMemberships: rows.map(presentGroupMembership) } };
});
