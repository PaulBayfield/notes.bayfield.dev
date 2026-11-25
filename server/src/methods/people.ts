// People and the workspace: account settings, user administration, groups, the workspace's settings,
// notifications, subscriptions and custom emoji.

import { sql } from "../db.ts";
import { Access } from "../access.ts";
import { publish } from "../events.ts";
import { forbidden, invalid, notFound } from "../http.ts";
import { notify } from "../notify.ts";
import { teamPolicy, userPolicy } from "../policies.ts";
import { DOC_COLUMNS, presentDocuments, presentGroup, presentTeam, presentUser, usersById, type DocumentRow, type GroupRow } from "../presenters.ts";
import { method, type SignedInCall } from "../rpc.ts";
import { createUser, currentTeam, forgetTeam, getUser, type TeamRow, type UserRole, type UserRow } from "../users.ts";
import { page } from "./common.ts";

const ROLES = ["admin", "member", "viewer", "guest"] as const;
const requireAdmin = (call: SignedInCall) => {
  if (call.user.role !== "admin") throw forbidden();
};

// ---------- Users ----------

/** The caller's own account (or, for admins, anyone's): name, avatar, language, preferences. */
method("users.update", async (call) => {
  const p = call.params;
  const id = p.uuid("id") ?? call.user.id;
  if (id !== call.user.id) requireAdmin(call);
  const u = await getUser(id);
  if (!u || u.teamId !== call.user.teamId) throw notFound();
  const name = p.string("name", { max: 255 });
  if (name !== undefined && !name.trim()) throw invalid("name can't be empty");
  const preferences = p.object("preferences");
  const [updated] = await sql<UserRow[]>`
    UPDATE users SET
      name = ${name?.trim() ?? u.name},
      avatar_url = ${p.has("avatarUrl") ? (p.nullableString("avatarUrl", 2000) ?? null) : u.avatarUrl},
      language = ${p.string("language", { max: 20 }) ?? u.language},
      timezone = ${p.has("timezone") ? (p.nullableString("timezone", 100) ?? null) : u.timezone},
      preferences = ${preferences ? sql.json({ ...(u.preferences ?? {}), ...preferences } as never) : u.preferences ? sql.json(u.preferences as never) : null},
      updated_at = now()
    WHERE id = ${id} RETURNING *`;
  publish({ name: "users.update", data: { id }, teamId: u.teamId, userIds: [id], actorId: call.user.id });
  return { data: presentUser(updated, { includeDetails: true }), policies: [userPolicy(call.user, updated)] };
});

async function setNotification(call: SignedInCall, on: boolean) {
  const eventType = call.params.string("eventType", { required: true, max: 100 })!;
  const settings = { ...call.user.notificationSettings, [eventType]: on };
  const [u] = await sql<UserRow[]>`UPDATE users SET notification_settings = ${sql.json(settings as never)}, updated_at = now() WHERE id = ${call.user.id} RETURNING *`;
  return { data: presentUser(u, { includeDetails: true }) };
}
method("users.notificationsSubscribe", (call) => setNotification(call, true));
method("users.notificationsUnsubscribe", (call) => setNotification(call, false));

async function adminTarget(call: SignedInCall) {
  requireAdmin(call);
  const u = await getUser(call.params.uuid("id", { required: true })!);
  if (!u || u.teamId !== call.user.teamId || u.deletedAt) throw notFound();
  return u;
}

method("users.update_role", async (call) => {
  const u = await adminTarget(call);
  if (u.id === call.user.id) throw invalid("You can't change your own role");
  const role = call.params.oneOf("role", ROLES);
  if (!role) throw invalid("role is required");
  const [updated] = await sql<UserRow[]>`UPDATE users SET role = ${role}, updated_at = now() WHERE id = ${u.id} RETURNING *`;
  publish({ name: "users.update", data: { id: u.id }, teamId: u.teamId, userIds: [u.id], actorId: call.user.id });
  return { data: presentUser(updated, { includeDetails: true }), policies: [userPolicy(call.user, updated)] };
});
// Outline's older names for the same thing.
method("users.promote", async (call) => {
  call.params.raw.role = "admin";
  const u = await adminTarget(call);
  const [updated] = await sql<UserRow[]>`UPDATE users SET role = 'admin', updated_at = now() WHERE id = ${u.id} RETURNING *`;
  return { data: presentUser(updated, { includeDetails: true }), policies: [userPolicy(call.user, updated)] };
});

method("users.suspend", async (call) => {
  const u = await adminTarget(call);
  if (u.id === call.user.id) throw invalid("You can't suspend yourself");
  const [updated] = await sql<UserRow[]>`UPDATE users SET suspended_at = now(), suspended_by_id = ${call.user.id}, updated_at = now() WHERE id = ${u.id} RETURNING *`;
  await sql`DELETE FROM sessions WHERE user_id = ${u.id}`;
  return { data: presentUser(updated, { includeDetails: true }), policies: [userPolicy(call.user, updated)] };
});

method("users.activate", async (call) => {
  const u = await adminTarget(call);
  const [updated] = await sql<UserRow[]>`UPDATE users SET suspended_at = NULL, suspended_by_id = NULL, updated_at = now() WHERE id = ${u.id} RETURNING *`;
  return { data: presentUser(updated, { includeDetails: true }), policies: [userPolicy(call.user, updated)] };
});

/** Invites by email: the account exists right away and is claimed at its first sign-in (by email). */
method("users.invite", async (call) => {
  const team = await currentTeam();
  if (call.user.role !== "admin" && !(call.user.role === "member" && !team.inviteRequired)) throw forbidden();
  const invites = call.params.array("invites") ?? [];
  if (!invites.length || invites.length > 20) throw invalid("invites should hold 1 to 20 people");
  const sent: UserRow[] = [];
  for (const raw of invites) {
    const i = raw as { email?: unknown; name?: unknown; role?: unknown };
    const email = typeof i.email === "string" ? i.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid(`“${String(i.email)}” isn't an email address`);
    const [existing] = await sql`SELECT 1 FROM users WHERE team_id = ${team.id} AND lower(email) = ${email} AND deleted_at IS NULL`;
    if (existing) continue;
    const role = (ROLES as readonly unknown[]).includes(i.role) && (call.user.role === "admin" || i.role !== "admin") ? (i.role as UserRole) : team.defaultUserRole;
    sent.push(await createUser({ teamId: team.id, name: typeof i.name === "string" && i.name.trim() ? i.name.trim() : email.split("@")[0], email, avatarUrl: null, role, invitedById: call.user.id }));
  }
  return { data: { sent: sent.map((u) => ({ email: u.email, name: u.name, role: u.role })), users: sent.map((u) => presentUser(u, { includeDetails: true })) } };
});

/** Email isn't set up on this server: the invitation stands, they sign in with the provider. */
method("users.resendInvite", async (call) => {
  await adminTarget(call);
  return { success: true };
});

method("users.delete", async (call) => {
  const id = call.params.uuid("id") ?? call.user.id;
  if (id !== call.user.id) requireAdmin(call);
  const u = await getUser(id);
  if (!u || u.teamId !== call.user.teamId) throw notFound();
  if (u.role === "admin") {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE team_id = ${u.teamId} AND role = 'admin' AND deleted_at IS NULL AND id <> ${u.id}`;
    if (n === 0) throw invalid("The workspace needs another admin first");
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE users SET deleted_at = now(), email = NULL, updated_at = now() WHERE id = ${u.id}`;
    await tx`DELETE FROM sessions WHERE user_id = ${u.id}`;
    await tx`DELETE FROM user_authentications WHERE user_id = ${u.id}`;
  });
  return { success: true };
});

// ---------- The workspace ----------

method("teams.update", async (call) => {
  requireAdmin(call);
  const p = call.params;
  const t = await currentTeam(true);
  const name = p.string("name", { max: 255 });
  if (name !== undefined && !name.trim()) throw invalid("name can't be empty");
  const allowedDomains = p.array("allowedDomains");
  const preferences = p.object("preferences");
  const [updated] = await sql<TeamRow[]>`
    UPDATE teams SET
      name = ${name?.trim() ?? t.name},
      description = ${p.has("description") ? (p.nullableString("description", 1000) ?? null) : t.description},
      avatar_url = ${p.has("avatarUrl") ? (p.nullableString("avatarUrl", 2000) ?? null) : t.avatarUrl},
      sharing = ${p.boolean("sharing") ?? t.sharing},
      member_collection_create = ${p.boolean("memberCollectionCreate") ?? t.memberCollectionCreate},
      member_team_create = ${p.boolean("memberTeamCreate") ?? t.memberTeamCreate},
      default_collection_id = ${p.has("defaultCollectionId") ? (p.nullableUuid("defaultCollectionId") ?? null) : t.defaultCollectionId},
      document_embeds = ${p.boolean("documentEmbeds") ?? t.documentEmbeds},
      guest_signin = ${p.boolean("guestSignin") ?? t.guestSignin},
      invite_required = ${p.boolean("inviteRequired") ?? t.inviteRequired},
      passkeys_enabled = ${p.boolean("passkeysEnabled") ?? t.passkeysEnabled},
      default_user_role = ${p.oneOf("defaultUserRole", ROLES) ?? t.defaultUserRole},
      allowed_domains = ${allowedDomains ? allowedDomains.map(String).map((d) => d.trim().toLowerCase()).filter(Boolean) : t.allowedDomains},
      preferences = ${preferences ? sql.json({ ...(t.preferences ?? {}), ...preferences } as never) : t.preferences ? sql.json(t.preferences as never) : null},
      updated_at = now()
    WHERE id = ${t.id} RETURNING *`;
  forgetTeam();
  publish({ name: "teams.update", data: { id: t.id }, teamId: t.id, actorId: call.user.id });
  return { data: presentTeam(updated), policies: [teamPolicy(call.user, updated)] };
});

// ---------- Groups ----------

const groupColumns = sql`g.*, (SELECT count(*)::int FROM group_users gu WHERE gu.group_id = g.id) AS member_count`;

function groupPolicy(call: SignedInCall, team: TeamRow, g: GroupRow) {
  const manage = call.user.role === "admin" || (call.user.role === "member" && team.memberTeamCreate);
  return { id: g.id, abilities: { read: true, update: manage, delete: manage } };
}

async function groupFor(call: SignedInCall, write = false) {
  const id = call.params.uuid("id", { required: true })!;
  const [g] = await sql<GroupRow[]>`SELECT ${groupColumns} FROM groups g WHERE g.id = ${id} AND g.team_id = ${call.user.teamId} AND g.deleted_at IS NULL`;
  if (!g) throw notFound();
  if (write && !groupPolicy(call, await currentTeam(), g).abilities.update) throw forbidden();
  return g;
}

method("groups.list", async (call) => {
  const p = call.params;
  const { limit, offset } = p.pagination();
  const query = p.string("query");
  const userId = p.uuid("userId");
  const rows = await sql<GroupRow[]>`
    SELECT ${groupColumns} FROM groups g WHERE g.team_id = ${call.user.teamId} AND g.deleted_at IS NULL
      ${query ? sql`AND notes_norm(g.name) LIKE ${"%" + query.toLowerCase() + "%"}` : sql``}
      ${userId ? sql`AND EXISTS (SELECT 1 FROM group_users gu WHERE gu.group_id = g.id AND gu.user_id = ${userId})` : sql``}
    ORDER BY lower(g.name) ${p.direction("ASC") === "ASC" ? sql`ASC` : sql`DESC`} LIMIT ${limit} OFFSET ${offset}`;
  const team = await currentTeam();
  return {
    pagination: page("groups.list", limit, offset),
    data: { groups: rows.map(presentGroup), groupUsers: [] },
    policies: rows.map((g) => groupPolicy(call, team, g)),
  };
});

method("groups.info", async (call) => {
  const g = await groupFor(call);
  return { data: presentGroup(g), policies: [groupPolicy(call, await currentTeam(), g)] };
});

method("groups.create", async (call) => {
  const team = await currentTeam();
  if (!(call.user.role === "admin" || (call.user.role === "member" && team.memberTeamCreate))) throw forbidden();
  const name = call.params.string("name", { required: true, max: 255 })!.trim();
  if (!name) throw invalid("name is required");
  const [g] = await sql<GroupRow[]>`
    INSERT INTO groups (team_id, name, description, icon, color, created_by_id) VALUES (${team.id}, ${name}, ${call.params.nullableString("description", 1000) ?? null},
      ${call.params.nullableString("icon", 50) ?? null}, ${call.params.nullableString("color", 20) ?? null}, ${call.user.id}) RETURNING *, 0 AS member_count`;
  publish({ name: "groups.create", data: { id: g.id }, teamId: team.id, actorId: call.user.id });
  return { data: presentGroup(g), policies: [groupPolicy(call, team, g)] };
});

method("groups.update", async (call) => {
  const g = await groupFor(call, true);
  const p = call.params;
  const [u] = await sql<GroupRow[]>`
    UPDATE groups SET name = ${p.string("name", { max: 255 })?.trim() || g.name},
      description = ${p.has("description") ? (p.nullableString("description", 1000) ?? null) : g.description},
      icon = ${p.has("icon") ? (p.nullableString("icon", 50) ?? null) : g.icon}, color = ${p.has("color") ? (p.nullableString("color", 20) ?? null) : g.color},
      disable_mentions = ${p.boolean("disableMentions") ?? g.disableMentions}, updated_at = now()
    WHERE id = ${g.id} RETURNING *, ${g.memberCount ?? 0}::int AS member_count`;
  publish({ name: "groups.update", data: { id: g.id }, teamId: call.user.teamId, actorId: call.user.id });
  return { data: presentGroup(u), policies: [groupPolicy(call, await currentTeam(), u)] };
});

method("groups.delete", async (call) => {
  const g = await groupFor(call, true);
  await sql.begin(async (tx) => {
    await tx`UPDATE groups SET deleted_at = now() WHERE id = ${g.id}`;
    await tx`DELETE FROM group_memberships WHERE group_id = ${g.id}`;
  });
  publish({ name: "groups.delete", data: { id: g.id }, teamId: call.user.teamId, actorId: call.user.id });
  return { success: true };
});

method("groups.memberships", async (call) => {
  const g = await groupFor(call);
  const { limit, offset } = call.params.pagination();
  const query = call.params.string("query");
  const rows = await sql<{ groupId: string; userId: string; permission: string; createdById: string | null; createdAt: Date }[]>`
    SELECT gu.* FROM group_users gu JOIN users u ON u.id = gu.user_id WHERE gu.group_id = ${g.id} AND u.deleted_at IS NULL
      ${query ? sql`AND notes_norm(u.name) LIKE ${"%" + query.toLowerCase() + "%"}` : sql``}
    ORDER BY lower(u.name) LIMIT ${limit} OFFSET ${offset}`;
  const users = await usersById(rows.map((r) => r.userId));
  return {
    pagination: page("groups.memberships", limit, offset),
    data: {
      groupMemberships: rows.map((r) => ({ id: `${r.userId}-${r.groupId}`, userId: r.userId, groupId: r.groupId, permission: r.permission, createdById: r.createdById, createdAt: r.createdAt.toISOString() })),
      users: [...users.values()].map((u) => presentUser(u)),
    },
  };
});

method("groups.add_user", async (call) => {
  const g = await groupFor(call, true);
  const userId = call.params.uuid("userId", { required: true })!;
  const u = await getUser(userId);
  if (!u || u.teamId !== call.user.teamId) throw notFound();
  const permission = call.params.oneOf("permission", ["admin", "member"] as const) ?? "member";
  const [added] = await sql`
    INSERT INTO group_users (group_id, user_id, permission, created_by_id) VALUES (${g.id}, ${userId}, ${permission}, ${call.user.id})
    ON CONFLICT (group_id, user_id) DO UPDATE SET permission = excluded.permission, updated_at = now() RETURNING (xmax = 0) AS created`;
  publish({ name: "groups.add_user", data: { id: g.id, groupId: g.id, userId }, teamId: call.user.teamId, actorId: call.user.id });
  if (added?.created) await notify(call.user.teamId, [userId], { event: "groups.add_user", actorId: call.user.id, groupId: g.id });
  const [fresh] = await sql<GroupRow[]>`SELECT ${groupColumns} FROM groups g WHERE g.id = ${g.id}`;
  return { data: { users: [presentUser(u)], groupMemberships: [{ id: `${userId}-${g.id}`, userId, groupId: g.id, permission }], groups: [presentGroup(fresh)] } };
});

method("groups.update_user", async (call) => {
  const g = await groupFor(call, true);
  const userId = call.params.uuid("userId", { required: true })!;
  const permission = call.params.oneOf("permission", ["admin", "member"] as const) ?? "member";
  await sql`UPDATE group_users SET permission = ${permission}, updated_at = now() WHERE group_id = ${g.id} AND user_id = ${userId}`;
  return { data: { groupMemberships: [{ id: `${userId}-${g.id}`, userId, groupId: g.id, permission }] } };
});

method("groups.remove_user", async (call) => {
  const g = await groupFor(call, true);
  const userId = call.params.uuid("userId", { required: true })!;
  const [removed] = await sql`DELETE FROM group_users WHERE group_id = ${g.id} AND user_id = ${userId} RETURNING user_id`;
  publish({ name: "groups.remove_user", data: { id: g.id, groupId: g.id, userId }, teamId: call.user.teamId, actorId: call.user.id });
  if (removed) await notify(call.user.teamId, [userId], { event: "groups.remove_user", actorId: call.user.id, groupId: g.id });
  const [fresh] = await sql<GroupRow[]>`SELECT ${groupColumns} FROM groups g WHERE g.id = ${g.id}`;
  return { data: { groups: [presentGroup(fresh)] } };
});

// ---------- Notifications ----------

interface NotificationRow {
  id: string;
  userId: string;
  actorId: string | null;
  event: string;
  documentId: string | null;
  collectionId: string | null;
  commentId: string | null;
  revisionId: string | null;
  fileOperationId: string | null;
  data: Record<string, unknown> | null;
  viewedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}

async function presentNotifications(call: SignedInCall, rows: NotificationRow[]) {
  const a = await Access.for(call.user);
  const users = await usersById(rows.map((n) => n.actorId));
  const docIds = [...new Set(rows.map((n) => n.documentId).filter((x): x is string => !!x))];
  const docs = docIds.length ? await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ANY(${docIds}::uuid[])` : [];
  const readable = docs.filter((d) => a.document(d));
  const presentedDocs = new Map((await presentDocuments(readable)).map((d) => [d.id as string, d]));
  const groupIds = [...new Set(rows.map((n) => n.data?.groupId).filter((x): x is string => typeof x === "string"))];
  const groups = groupIds.length ? new Map((await sql<{ id: string; name: string }[]>`SELECT id, name FROM groups WHERE id = ANY(${groupIds}::uuid[])`).map((g) => [g.id, g])) : new Map();
  return rows.map((n) => {
    const groupId = typeof n.data?.groupId === "string" ? n.data.groupId : null;
    const { groupId: _g, ...data } = n.data ?? {};
    void _g;
    return {
      id: n.id,
      viewedAt: n.viewedAt?.toISOString() ?? null,
      accessRequestId: null,
      archivedAt: n.archivedAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
      event: n.event,
      userId: n.userId,
      actorId: n.actorId,
      actor: n.actorId && users.get(n.actorId) ? presentUser(users.get(n.actorId)!) : null,
      commentId: n.commentId,
      documentId: n.documentId,
      document: n.documentId ? (presentedDocs.get(n.documentId) ?? null) : null,
      revisionId: n.revisionId,
      collectionId: n.collectionId,
      groupId,
      ...(groupId && groups.get(groupId) ? { group: groups.get(groupId) } : {}),
      fileOperationId: n.fileOperationId,
      data: Object.keys(data).length ? data : null,
    };
  });
}

method("notifications.list", async (call) => {
  const p = call.params;
  const { limit, offset } = p.pagination();
  const archived = p.boolean("archived") ?? false;
  const eventType = p.string("eventType");
  const where = sql`user_id = ${call.user.id} AND ${archived ? sql`archived_at IS NOT NULL` : sql`archived_at IS NULL`} ${eventType ? sql`AND event = ${eventType}` : sql``}`;
  const rows = await sql<NotificationRow[]>`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const [{ total, unseen }] = await sql<{ total: number; unseen: number }[]>`
    SELECT count(*)::int AS total, (SELECT count(*)::int FROM notifications WHERE user_id = ${call.user.id} AND viewed_at IS NULL AND archived_at IS NULL) AS unseen
    FROM notifications WHERE ${where}`;
  return { pagination: page("notifications.list", limit, offset, total), data: { notifications: await presentNotifications(call, rows), unseen } };
});

method("notifications.update", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const p = call.params;
  const [n] = await sql<NotificationRow[]>`
    UPDATE notifications SET
      viewed_at = ${p.has("viewedAt") ? (p.raw.viewedAt ? new Date(String(p.raw.viewedAt)) : null) : sql`viewed_at`},
      archived_at = ${p.has("archivedAt") ? (p.raw.archivedAt ? new Date(String(p.raw.archivedAt)) : null) : sql`archived_at`}
    WHERE id = ${id} AND user_id = ${call.user.id} RETURNING *`;
  if (!n) throw notFound();
  publish({ name: "notifications.update", data: { id }, teamId: call.user.teamId, userIds: [call.user.id] });
  return { data: (await presentNotifications(call, [n]))[0] };
});

method("notifications.update_all", async (call) => {
  const p = call.params;
  const viewedAt = p.has("viewedAt") ? (p.raw.viewedAt ? new Date(String(p.raw.viewedAt)) : null) : undefined;
  const archivedAt = p.has("archivedAt") ? (p.raw.archivedAt ? new Date(String(p.raw.archivedAt)) : null) : undefined;
  const rows = await sql`
    UPDATE notifications SET
      viewed_at = ${viewedAt !== undefined ? viewedAt : sql`viewed_at`}, archived_at = ${archivedAt !== undefined ? archivedAt : sql`archived_at`}
    WHERE user_id = ${call.user.id} AND ${viewedAt !== undefined ? sql`viewed_at IS NULL` : sql`archived_at IS NULL`} RETURNING id`;
  publish({ name: "notifications.update", data: {}, teamId: call.user.teamId, userIds: [call.user.id] });
  return { data: { total: rows.length } };
});

// ---------- Subscriptions ----------

interface SubscriptionRow {
  id: string;
  userId: string;
  documentId: string | null;
  collectionId: string | null;
  event: string;
  createdAt: Date;
  updatedAt: Date;
}

const presentSubscription = (s: SubscriptionRow) => ({
  id: s.id,
  userId: s.userId,
  documentId: s.documentId,
  collectionId: s.collectionId,
  event: s.event,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

method("subscriptions.list", async (call) => {
  const { limit, offset } = call.params.pagination();
  const documentId = call.params.uuid("documentId");
  const rows = await sql<SubscriptionRow[]>`
    SELECT * FROM subscriptions WHERE user_id = ${call.user.id} AND deleted_at IS NULL ${documentId ? sql`AND document_id = ${documentId}` : sql``}
    ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  return { pagination: page("subscriptions.list", limit, offset), data: rows.map(presentSubscription) };
});

method("subscriptions.info", async (call) => {
  const documentId = call.params.uuid("documentId");
  const collectionId = call.params.uuid("collectionId");
  const event = call.params.string("event") ?? "documents.update";
  if (!documentId && !collectionId) throw invalid("One of documentId or collectionId is required");
  const [s] = await sql<SubscriptionRow[]>`
    SELECT * FROM subscriptions WHERE user_id = ${call.user.id} AND deleted_at IS NULL AND event = ${event}
      AND ${documentId ? sql`document_id = ${documentId}` : sql`collection_id = ${collectionId!}`}`;
  if (!s) throw notFound();
  return { data: presentSubscription(s), policies: [{ id: s.id, abilities: { read: true, delete: true } }] };
});

method("subscriptions.create", async (call) => {
  const a = await Access.for(call.user);
  const documentId = call.params.uuid("documentId") ?? null;
  const collectionId = call.params.uuid("collectionId") ?? null;
  const event = call.params.string("event") ?? "documents.update";
  if (documentId) {
    const { documentFor } = await import("./common.ts");
    await documentFor(a, documentId);
  } else if (collectionId) {
    if (!a.collection(collectionId)) throw notFound();
  } else throw invalid("One of documentId or collectionId is required");
  const [existing] = await sql<SubscriptionRow[]>`
    SELECT * FROM subscriptions WHERE user_id = ${call.user.id} AND deleted_at IS NULL AND event = ${event}
      AND ${documentId ? sql`document_id = ${documentId}` : sql`collection_id = ${collectionId}`}`;
  const s = existing ?? (await sql<SubscriptionRow[]>`INSERT INTO subscriptions (user_id, document_id, collection_id, event) VALUES (${call.user.id}, ${documentId}, ${collectionId}, ${event}) RETURNING *`)[0];
  return { data: presentSubscription(s), policies: [{ id: s.id, abilities: { read: true, delete: true } }] };
});

method("subscriptions.delete", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const [s] = await sql`UPDATE subscriptions SET deleted_at = now() WHERE id = ${id} AND user_id = ${call.user.id} AND deleted_at IS NULL RETURNING id`;
  if (!s) throw notFound();
  return { success: true };
});

// ---------- Custom emoji ----------

interface EmojiRow {
  id: string;
  name: string;
  attachmentId: string | null;
  createdById: string | null;
  createdAt: Date;
  key?: string | null;
}

async function presentEmojis(rows: EmojiRow[]) {
  const users = await usersById(rows.map((e) => e.createdById));
  return rows.map((e) => ({
    id: e.id,
    name: e.name,
    url: e.key ? `/api/files.get?key=${encodeURIComponent(e.key)}` : null,
    createdBy: e.createdById && users.get(e.createdById) ? presentUser(users.get(e.createdById)!) : null,
    createdAt: e.createdAt.toISOString(),
  }));
}

method("emojis.list", async (call) => {
  const { limit, offset } = call.params.pagination();
  const rows = await sql<EmojiRow[]>`
    SELECT e.*, a.key FROM emojis e LEFT JOIN attachments a ON a.id = e.attachment_id WHERE e.team_id = ${call.user.teamId} ORDER BY e.name LIMIT ${limit} OFFSET ${offset}`;
  return { pagination: page("emojis.list", limit, offset), data: await presentEmojis(rows), policies: rows.map((e) => ({ id: e.id, abilities: { read: true, delete: call.user.role === "admin" || e.createdById === call.user.id } })) };
});

method("emojis.create", async (call) => {
  if (call.user.role === "viewer" || call.user.role === "guest") throw forbidden();
  const name = call.params.string("name", { required: true, max: 50 })!.trim().toLowerCase();
  if (!/^[a-z0-9_+-]{1,50}$/.test(name)) throw invalid("Emoji names use letters, digits, - and _");
  const attachmentId = call.params.uuid("attachmentId", { required: true })!;
  const [att] = await sql<{ key: string }[]>`SELECT key FROM attachments WHERE id = ${attachmentId} AND team_id = ${call.user.teamId}`;
  if (!att) throw notFound();
  const [taken] = await sql`SELECT 1 FROM emojis WHERE team_id = ${call.user.teamId} AND name = ${name}`;
  if (taken) throw invalid("An emoji with this name already exists");
  const [e] = await sql<EmojiRow[]>`INSERT INTO emojis (team_id, name, attachment_id, created_by_id) VALUES (${call.user.teamId}, ${name}, ${attachmentId}, ${call.user.id}) RETURNING *, ${att.key}::text AS key`;
  publish({ name: "emojis.create", data: { id: e.id }, teamId: call.user.teamId, actorId: call.user.id });
  return { data: (await presentEmojis([e]))[0], policies: [{ id: e.id, abilities: { read: true, delete: true } }] };
});

method("emojis.delete", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const [e] = await sql<EmojiRow[]>`SELECT * FROM emojis WHERE id = ${id} AND team_id = ${call.user.teamId}`;
  if (!e) throw notFound();
  if (call.user.role !== "admin" && e.createdById !== call.user.id) throw forbidden();
  await sql`DELETE FROM emojis WHERE id = ${id}`;
  publish({ name: "emojis.delete", data: { id }, teamId: call.user.teamId, actorId: call.user.id });
  return { success: true };
});
