// Imports an Outline workspace into this server's database, once, before switching servers.
//
//   SOURCE_DATABASE_URL=postgres://…/outline SOURCE_FILES_DIR=/path/to/outline/data \
//     node --env-file-if-exists=.env scripts/import-outline.ts [--replace]
//
// Reads Outline's database (it's never written to) and copies its files folder (Outline's local
// storage) into FILE_STORAGE_DIR. Every id and urlId is kept: links between documents, bookmarks,
// share links and attachment URLs keep working. Outline's columns have changed names over the years
// (emoji → icon, isAdmin → role, user_permissions → user_memberships…), so each column is looked up
// among the names it has had, and the source's actual columns decide.
//
// Afterwards each document's ProseMirror JSON and Markdown are worked out again from its Yjs state, so
// what search and exports see is exactly what the editor shows.
//
// Refuses to run into a database that already has documents, unless --replace (which empties it).

import { cp, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { FILE_STORAGE_DIR } from "../src/config.ts";
import { migrate, sql } from "../src/db.ts";
import { contentFromState, contentFrom, contentFromMarkdown, type DocJSON } from "../src/content.ts";

const SOURCE = process.env.SOURCE_DATABASE_URL;
const FILES = process.env.SOURCE_FILES_DIR;
if (!SOURCE) throw new Error("Set SOURCE_DATABASE_URL to Outline's database (read only)");
const replace = process.argv.includes("--replace");

const src = postgres(SOURCE, { max: 4, onnotice: () => {} });
type Row = Record<string, unknown>;

/** Columns a source table has (empty when the table doesn't exist). */
const columnsCache = new Map<string, Set<string>>();
async function columns(table: string): Promise<Set<string>> {
  if (!columnsCache.has(table)) {
    const rows = await src<{ columnName: string }[]>`SELECT column_name AS "columnName" FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`;
    columnsCache.set(table, new Set(rows.map((r) => r.columnName)));
  }
  return columnsCache.get(table)!;
}

/** The first of these source tables that exists. */
async function firstTable(...names: string[]): Promise<string | null> {
  for (const n of names) if ((await columns(n)).size) return n;
  return null;
}

/** A value from the first of these columns the row has. */
const pick = (row: Row, ...names: string[]) => {
  for (const n of names) if (n in row && row[n] !== undefined) return row[n];
  return null;
};

type Mapping = Record<string, (row: Row) => unknown>;
const col = (...names: string[]) => (row: Row) => pick(row, ...names);
const json = (...names: string[]) => (row: Row) => {
  const v = pick(row, ...names);
  return v === null ? null : sql.json(v as never);
};

const BATCH = 500;

/** Copies a source table into ours, in batches, keyset-paginated on id (or a key column). */
async function copy(target: string, sourceNames: string[], mapping: Mapping, opts: { where?: string; key?: string; batch?: number; transform?: (row: Row) => Row | null } = {}) {
  const table = await firstTable(...sourceNames);
  if (!table) {
    console.log(`  ${target}: no ${sourceNames.join(" / ")} table in the source, skipped`);
    return { source: 0, copied: 0 };
  }
  const key = opts.key ?? "id";
  const batch = opts.batch ?? BATCH;
  const where = opts.where ? `AND (${opts.where})` : "";
  const [{ n }] = await src.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE true ${where}`);
  let copied = 0;
  let after: unknown = null;
  for (;;) {
    const rows = (await src.unsafe(
      `SELECT * FROM "${table}" WHERE true ${where} ${after !== null ? `AND "${key}" > $1` : ""} ORDER BY "${key}" LIMIT ${batch}`,
      after !== null ? [after as string] : [],
    )) as Row[];
    if (!rows.length) break;
    after = rows[rows.length - 1][key];
    const out = rows
      .map((r) => (opts.transform ? opts.transform(r) : r))
      .filter((r): r is Row => !!r)
      .map((r) => Object.fromEntries(Object.entries(mapping).map(([column, f]) => [column, f(r)])));
    if (out.length) {
      await sql`INSERT INTO ${sql(target)} ${sql(out as never, Object.keys(mapping) as never)} ON CONFLICT DO NOTHING`;
      copied += out.length;
    }
    process.stdout.write(`\r  ${target}: ${copied}/${n}`);
  }
  process.stdout.write(`\r  ${target}: ${copied}/${n} (from ${table})\n`);
  return { source: n, copied };
}

// ---------- Run ----------

await migrate();
const [{ documents }] = await sql<{ documents: number }[]>`SELECT count(*)::int AS documents FROM documents`;
if (documents > 0 && !replace) throw new Error(`This database already has ${documents} documents. Run with --replace to empty it first.`);

console.log("Importing from Outline…");
await sql.begin(async (tx) => {
  // Foreign keys are checked once everything is in (documents point at each other, users at users).
  await tx`SET LOCAL session_replication_role = replica`;
  if (replace) {
    await tx.unsafe(`TRUNCATE teams, users, user_authentications, sessions, transfer_tokens, oidc_states, api_keys, groups, group_users, collections, documents, revisions,
      user_memberships, group_memberships, stars, pins, shares, views, comments, reactions, subscriptions, attachments, file_operations, notifications, emojis, events CASCADE`);
  }
});

// Inserts run with foreign key triggers off (the order would otherwise matter, and documents point at each other).
await sql`SET session_replication_role = replica`.catch(() => {
  throw new Error("The import needs a superuser connection to this server's database (to load rows in any order)");
});

const teamCols = await columns("teams");
const [team] = await src.unsafe<Row[]>(`SELECT * FROM teams ${teamCols.has("deletedAt") ? `WHERE "deletedAt" IS NULL` : ""} ORDER BY "createdAt" LIMIT 1`);
if (!team) throw new Error("No workspace in the source database");
const teamId = team.id as string;
const domains = (await columns("team_domains")).size ? (await src`SELECT name FROM team_domains WHERE "teamId" = ${teamId}`).map((r) => r.name as string) : [];
const onlyTeam = `"teamId" = '${teamId}'`;

const results: Record<string, { source: number; copied: number }> = {};

results.teams = await copy("teams", ["teams"], {
  id: col("id"),
  name: col("name"),
  description: col("description"),
  avatar_url: col("avatarUrl"),
  subdomain: col("subdomain"),
  domain: col("domain"),
  sharing: (r) => pick(r, "sharing") ?? true,
  default_collection_id: col("defaultCollectionId"),
  default_user_role: (r) => pick(r, "defaultUserRole") ?? "member",
  member_collection_create: (r) => pick(r, "memberCollectionCreate") ?? true,
  member_team_create: (r) => pick(r, "memberTeamCreate") ?? true,
  document_embeds: (r) => pick(r, "documentEmbeds") ?? true,
  invite_required: (r) => pick(r, "inviteRequired") ?? false,
  allowed_domains: () => domains,
  guest_signin: (r) => pick(r, "guestSignin") ?? false,
  passkeys_enabled: (r) => pick(r, "passkeysEnabled") ?? false,
  preferences: json("preferences"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
}, { where: `id = '${teamId}'` });

const userCols = await columns("users");
results.users = await copy("users", ["users"], {
  id: col("id"),
  team_id: col("teamId"),
  name: (r) => pick(r, "name") ?? "User",
  email: col("email"),
  avatar_url: col("avatarUrl"),
  color: (r) => pick(r, "color") ?? "#0366d6",
  // Newer Outline: a role; older: isAdmin / isViewer flags.
  role: (r) => (userCols.has("role") ? pick(r, "role") : r.isAdmin ? "admin" : r.isViewer ? "viewer" : "member") ?? "member",
  language: col("language"),
  timezone: col("timezone"),
  preferences: json("preferences"),
  notification_settings: (r) => sql.json((pick(r, "notificationSettings") ?? {}) as never),
  flags: json("flags"),
  invited_by_id: col("invitedById"),
  suspended_at: col("suspendedAt"),
  suspended_by_id: col("suspendedById"),
  last_active_at: col("lastActiveAt"),
  last_active_ip: col("lastActiveIp"),
  last_signed_in_at: col("lastSignedInAt"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
  deleted_at: col("deletedAt"),
}, { where: onlyTeam });

// Sign-in identities: Outline links them to an authentication provider (its name: "oidc").
const providers = (await columns("authentication_providers")).size
  ? new Map((await src`SELECT id, name FROM authentication_providers WHERE "teamId" = ${teamId}`).map((p) => [p.id as string, p.name as string]))
  : new Map<string, string>();
results.user_authentications = await copy("user_authentications", ["user_authentications"], {
  id: col("id"),
  user_id: col("userId"),
  provider: (r) => providers.get(r.authenticationProviderId as string) ?? "oidc",
  provider_id: col("providerId"),
  scopes: (r) => pick(r, "scopes") ?? [],
  last_validated_at: col("lastValidatedAt"),
  created_at: col("createdAt"),
});

const keyCols = await columns("apiKeys");
results.api_keys = await copy("api_keys", ["apiKeys", "api_keys"], {
  id: col("id"),
  user_id: col("userId"),
  name: (r) => pick(r, "name") ?? "API key",
  // Newer Outline keeps a hash; older kept the secret itself.
  hash: (r) => (keyCols.has("hash") && r.hash ? r.hash : createHash("sha256").update(String(pick(r, "secret") ?? r.id)).digest("hex")),
  last4: (r) => pick(r, "last4") ?? String(pick(r, "secret") ?? "").slice(-4),
  scope: col("scope"),
  expires_at: col("expiresAt"),
  last_active_at: col("lastActiveAt"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
  deleted_at: col("deletedAt"),
});

results.groups = await copy("groups", ["groups"], {
  id: col("id"),
  team_id: col("teamId"),
  name: col("name"),
  description: col("description"),
  icon: col("icon"),
  color: col("color"),
  external_id: col("externalId"),
  disable_mentions: (r) => pick(r, "disableMentions") ?? false,
  created_by_id: col("createdById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
  deleted_at: col("deletedAt"),
}, { where: onlyTeam });

results.group_users = await copy("group_users", ["group_users"], {
  group_id: col("groupId"),
  user_id: col("userId"),
  permission: (r) => pick(r, "permission") ?? "member",
  created_by_id: col("createdById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
}, { key: "createdAt", transform: (r) => (r.deletedAt ? null : r) });

results.collections = await copy("collections", ["collections"], {
  id: col("id"),
  url_id: col("urlId"),
  team_id: col("teamId"),
  name: col("name"),
  description: col("description"),
  content: json("content"),
  icon: col("icon"),
  color: col("color"),
  index: col("index"),
  permission: col("permission"),
  sharing: (r) => pick(r, "sharing") ?? true,
  commenting: col("commenting"),
  sort: (r) => sql.json((pick(r, "sort") ?? { field: "index", direction: "asc" }) as never),
  template_management: col("templateManagement"),
  document_structure: (r) => sql.json((pick(r, "documentStructure") ?? []) as never),
  source_metadata: json("sourceMetadata"),
  created_by_id: col("createdById"),
  archived_at: col("archivedAt"),
  archived_by_id: col("archivedById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
  deleted_at: col("deletedAt"),
}, { where: onlyTeam });

results.documents = await copy("documents", ["documents"], {
  id: col("id"),
  url_id: col("urlId"),
  team_id: col("teamId"),
  collection_id: col("collectionId"),
  parent_document_id: col("parentDocumentId"),
  title: (r) => pick(r, "title") ?? "",
  icon: col("icon", "emoji"),
  color: col("color"),
  text: (r) => pick(r, "text") ?? "",
  content: json("content"),
  state: col("state"),
  full_width: (r) => pick(r, "fullWidth") ?? false,
  insights_enabled: (r) => pick(r, "insightsEnabled") ?? true,
  preferences: json("preferences"),
  is_template: (r) => pick(r, "template", "isTemplate") ?? false,
  template_id: col("templateId"),
  source_metadata: json("sourceMetadata"),
  created_by_id: col("createdById"),
  last_modified_by_id: col("lastModifiedById", "updatedById"),
  collaborator_ids: (r) => pick(r, "collaboratorIds") ?? [],
  revision_count: (r) => pick(r, "revisionCount") ?? 0,
  published_at: col("publishedAt"),
  archived_at: col("archivedAt"),
  deleted_at: col("deletedAt"),
  deleted_by_id: col("deletedById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
}, { where: onlyTeam, batch: 100 });

results.revisions = await copy("revisions", ["revisions"], {
  id: col("id"),
  document_id: col("documentId"),
  user_id: col("userId"),
  title: (r) => pick(r, "title") ?? "",
  name: col("name"),
  icon: col("icon", "emoji"),
  color: col("color"),
  text: (r) => pick(r, "text") ?? "",
  content: json("content"),
  collaborator_ids: (r) => pick(r, "collaboratorIds") ?? (r.userId ? [r.userId] : []),
  source_metadata: json("sourceMetadata"),
  created_at: col("createdAt"),
  deleted_at: col("deletedAt"),
}, { batch: 100 });

const membership = (kind: "user" | "group"): Mapping => ({
  id: col("id"),
  [`${kind}_id`]: col(`${kind}Id`),
  collection_id: col("collectionId"),
  document_id: col("documentId"),
  permission: (r) => pick(r, "permission") ?? "read_write",
  source_id: col("sourceId"),
  ...(kind === "user" ? { index: col("index") } : {}),
  created_by_id: col("createdById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
});
results.user_memberships = await copy("user_memberships", ["user_memberships", "user_permissions"], membership("user"));
results.group_memberships = await copy("group_memberships", ["group_memberships", "group_permissions"], membership("group"));

results.stars = await copy("stars", ["stars"], {
  id: col("id"),
  user_id: col("userId"),
  document_id: col("documentId"),
  collection_id: col("collectionId"),
  index: col("index"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
});

results.pins = await copy("pins", ["pins"], {
  id: col("id"),
  team_id: col("teamId"),
  document_id: col("documentId"),
  collection_id: col("collectionId"),
  index: col("index"),
  created_by_id: col("createdById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
}, { where: onlyTeam });

results.shares = await copy("shares", ["shares"], {
  id: col("id"),
  team_id: col("teamId"),
  user_id: col("userId"),
  document_id: col("documentId"),
  collection_id: col("collectionId"),
  url_id: col("urlId"),
  published: (r) => pick(r, "published") ?? false,
  include_child_documents: (r) => pick(r, "includeChildDocuments") ?? false,
  allow_indexing: (r) => pick(r, "allowIndexing") ?? false,
  allow_subscriptions: (r) => pick(r, "allowSubscriptions") ?? false,
  show_last_updated: (r) => pick(r, "showLastUpdated") ?? false,
  show_toc: (r) => pick(r, "showTOC", "showToc") ?? false,
  domain: col("domain"),
  title: col("title"),
  icon_url: col("iconUrl"),
  expires_at: col("expiresAt"),
  views: (r) => pick(r, "views") ?? 0,
  last_accessed_at: col("lastAccessedAt"),
  revoked_at: col("revokedAt"),
  revoked_by_id: col("revokedById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
}, { where: onlyTeam });

results.views = await copy("views", ["views"], {
  id: col("id"),
  user_id: col("userId"),
  document_id: col("documentId"),
  count: (r) => pick(r, "count") ?? 1,
  first_viewed_at: col("createdAt"),
  last_viewed_at: col("updatedAt", "createdAt"),
});

results.comments = await copy("comments", ["comments"], {
  id: col("id"),
  document_id: col("documentId"),
  parent_comment_id: col("parentCommentId"),
  created_by_id: col("createdById"),
  data: (r) => sql.json((pick(r, "data") ?? { type: "doc", content: [] }) as never),
  resolved_at: col("resolvedAt"),
  resolved_by_id: col("resolvedById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
  deleted_at: col("deletedAt"),
});

results.reactions = await copy("reactions", ["reactions"], {
  id: col("id"),
  emoji: col("emoji"),
  comment_id: col("commentId"),
  user_id: col("userId"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
});

results.subscriptions = await copy("subscriptions", ["subscriptions"], {
  id: col("id"),
  user_id: col("userId"),
  document_id: col("documentId"),
  collection_id: col("collectionId"),
  event: (r) => pick(r, "event") ?? "documents.update",
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
  deleted_at: col("deletedAt"),
});

results.attachments = await copy("attachments", ["attachments"], {
  id: col("id"),
  team_id: col("teamId"),
  user_id: col("userId"),
  document_id: col("documentId"),
  key: col("key"),
  name: (r) => pick(r, "name") ?? String(r.key ?? "file").split("/").at(-1),
  content_type: (r) => pick(r, "contentType") ?? "application/octet-stream",
  size: (r) => pick(r, "size") ?? 0,
  acl: (r) => pick(r, "acl") ?? "private",
  uploaded_at: col("createdAt"),
  last_accessed_at: col("lastAccessedAt"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
}, { where: onlyTeam });

results.emojis = await copy("emojis", ["emojis"], {
  id: col("id"),
  team_id: col("teamId"),
  name: col("name"),
  attachment_id: col("attachmentId"),
  created_by_id: col("createdById"),
  created_at: col("createdAt"),
  updated_at: col("updatedAt"),
}, { where: onlyTeam });

results.notifications = await copy("notifications", ["notifications"], {
  id: col("id"),
  team_id: col("teamId"),
  user_id: col("userId"),
  actor_id: col("actorId"),
  event: col("event"),
  document_id: col("documentId"),
  collection_id: col("collectionId"),
  comment_id: col("commentId"),
  revision_id: col("revisionId"),
  membership_id: col("membershipId"),
  data: json("data"),
  viewed_at: col("viewedAt"),
  archived_at: col("archivedAt"),
  emailed_at: col("emailedAt"),
  created_at: col("createdAt"),
}, { where: onlyTeam });

await sql`SET session_replication_role = DEFAULT`;

// ---------- Content: worked out again from the Yjs state ----------

console.log("Rebuilding content from the editor state…");
let fixed = 0;
let failed = 0;
for (let after = "00000000-0000-0000-0000-000000000000"; ; ) {
  const rows = await sql<{ id: string; state: Buffer | null; content: DocJSON | null; text: string }[]>`
    SELECT id, state, content, text FROM documents WHERE id > ${after} ORDER BY id LIMIT 100`;
  if (!rows.length) break;
  after = rows[rows.length - 1].id;
  for (const d of rows) {
    try {
      const c = d.state?.length ? contentFromState(new Uint8Array(d.state)) : d.content ? contentFrom(d.content) : contentFromMarkdown(d.text);
      await sql`UPDATE documents SET content = ${sql.json(c.content as never)}, text = ${c.text}, state = ${c.state} WHERE id = ${d.id}`;
      fixed++;
    } catch (e) {
      failed++;
      console.warn(`\n  ${d.id}: kept as imported (${e instanceof Error ? e.message : e})`);
    }
  }
  process.stdout.write(`\r  ${fixed} documents`);
}
console.log(`\r  ${fixed} documents rebuilt${failed ? `, ${failed} kept as imported` : ""}`);

// ---------- Files ----------

if (FILES) {
  console.log(`Copying files from ${FILES}…`);
  await stat(FILES);
  await cp(FILES, FILE_STORAGE_DIR, { recursive: true, force: false, errorOnExist: false });
  console.log(`  copied into ${FILE_STORAGE_DIR}`);
} else console.log("SOURCE_FILES_DIR not set: attachments' files weren't copied");

// ---------- Report ----------

console.log("\nSource → imported:");
for (const [table, r] of Object.entries(results)) console.log(`  ${table.padEnd(22)} ${String(r.source).padStart(7)} → ${String(r.copied).padStart(7)}${r.copied < r.source ? "  (some skipped: already there, or another workspace's)" : ""}`);
await src.end();
await sql.end();
