// events.list: the workspace's history, as Outline's. Everyone sees what happened to the documents and
// collections they can read (and their own actions); admins ask for the whole audit log (auditLog), with
// where each action came from (address, client, how it signed in).
//
// Events keep ids; the names (document titles, collection and group names, people) are looked up here,
// so they're current, and still there for events recorded before names were kept.

import { sql } from "../db.ts";
import { Access } from "../access.ts";
import { collectionUrl, documentUrl } from "../content.ts";
import { forbidden, invalid } from "../http.ts";
import { presentUser, usersById } from "../presenters.ts";
import { method } from "../rpc.ts";
import { page } from "./common.ts";

interface EventRow {
  id: string;
  name: string;
  actorId: string | null;
  userId: string | null;
  modelId: string | null;
  collectionId: string | null;
  documentId: string | null;
  data: Record<string, unknown> | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  ip: string | null;
  userAgent: string | null;
  via: string | null;
  createdAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
/** Changed fields that hold a collection or a document, to name them. */
const COLLECTION_FIELDS = new Set(["collectionId", "defaultCollectionId"]);
const DOCUMENT_FIELDS = new Set(["parentDocumentId"]);

/** "Firefox on Windows", "Notes desktop app on macOS"… from a User-Agent. */
function describeClient(ua: string | null): string | null {
  if (!ua) return null;
  const os = /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh|macos/i.test(ua) ? "macOS" : /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Linux/i.test(ua) ? "Linux" : null;
  const app = /Tauri|notes-desktop/i.test(ua)
    ? "Notes desktop"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /claude|anthropic/i.test(ua)
              ? "Claude"
              : /curl|python|node|axios|go-http/i.test(ua)
                ? "Script"
                : null;
  return [app, os].filter(Boolean).join(" · ") || ua.slice(0, 60);
}

const dateParam = (v: string | undefined, name: string) => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(`${name} must be a date`);
  return d;
};

method("events.list", async ({ params, user }) => {
  const { limit, offset } = params.pagination();
  const audit = params.boolean("auditLog") ?? false;
  if (audit && user.role !== "admin") throw forbidden("Only admins can read the audit log");
  const name = params.string("name", { max: 100 });
  const events = params.array("events")?.map(String);
  const actorId = params.uuid("actorId");
  const documentId = params.uuid("documentId");
  const collectionId = params.uuid("collectionId");
  const since = dateParam(params.string("since"), "since");
  const until = dateParam(params.string("until"), "until");
  const direction = params.direction("DESC");

  let visible = sql`true`;
  if (!audit) {
    const a = await Access.for(user);
    visible = sql`(e.actor_id = ${user.id} OR (e.collection_id = ANY(${a.readableCollections()}::uuid[])
      AND (e.document_id IS NULL OR EXISTS (SELECT 1 FROM documents d WHERE d.id = e.document_id AND ${a.readableFilter()}))))`;
  }
  const rows = await sql<EventRow[]>`
    SELECT e.* FROM events e
    WHERE e.team_id = ${user.teamId} AND ${visible}
      ${name ? sql`AND e.name = ${name}` : sql``}
      ${events?.length ? sql`AND e.name = ANY(${events})` : sql``}
      ${actorId ? sql`AND e.actor_id = ${actorId}` : sql``}
      ${documentId ? sql`AND e.document_id = ${documentId}` : sql``}
      ${collectionId ? sql`AND e.collection_id = ${collectionId}` : sql``}
      ${since ? sql`AND e.created_at >= ${since}` : sql``}
      ${until ? sql`AND e.created_at < ${until}` : sql``}
    ORDER BY e.created_at ${direction === "ASC" ? sql`ASC` : sql`DESC`}
    LIMIT ${limit} OFFSET ${offset}`;

  // Everything the events point at, looked up at once.
  const docIds = new Set<string>();
  const colIds = new Set<string>();
  const groupIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of rows) {
    if (r.actorId) userIds.add(r.actorId);
    if (r.userId) userIds.add(r.userId);
    if (r.documentId) docIds.add(r.documentId);
    if (r.collectionId) colIds.add(r.collectionId);
    if (r.name.startsWith("groups.") && r.modelId) groupIds.add(r.modelId);
    if (isId(r.data?.groupId)) groupIds.add(r.data.groupId);
    for (const [field, c] of Object.entries(r.changes ?? {}))
      for (const v of [c.from, c.to]) {
        if (!isId(v)) continue;
        if (COLLECTION_FIELDS.has(field)) colIds.add(v);
        if (DOCUMENT_FIELDS.has(field)) docIds.add(v);
      }
  }
  const [docs, cols, groups, users] = await Promise.all([
    docIds.size
      ? sql<{ id: string; title: string; urlId: string; deletedAt: Date | null }[]>`SELECT id, title, url_id, deleted_at FROM documents WHERE id = ANY(${[...docIds]}::uuid[])`
      : [],
    colIds.size ? sql<{ id: string; name: string; urlId: string; deletedAt: Date | null }[]>`SELECT id, name, url_id, deleted_at FROM collections WHERE id = ANY(${[...colIds]}::uuid[])` : [],
    groupIds.size ? sql<{ id: string; name: string }[]>`SELECT id, name FROM groups WHERE id = ANY(${[...groupIds]}::uuid[])` : [],
    usersById([...userIds]),
  ]);
  const docById = new Map(docs.map((d) => [d.id, d]));
  const colById = new Map(cols.map((c) => [c.id, c]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const docRef = (id: string | null) => {
    const d = id ? docById.get(id) : undefined;
    return d ? { id: d.id, title: d.title, url: documentUrl(d), deleted: !!d.deletedAt } : null;
  };
  const colRef = (id: string | null) => {
    const c = id ? colById.get(id) : undefined;
    return c ? { id: c.id, name: c.name, url: collectionUrl(c), deleted: !!c.deletedAt } : null;
  };
  /** A changed value's name, when it's a collection or a document. */
  const label = (field: string, v: unknown) =>
    !isId(v) ? undefined : COLLECTION_FIELDS.has(field) ? colById.get(v)?.name : DOCUMENT_FIELDS.has(field) ? docById.get(v)?.title : undefined;

  return {
    data: rows.map((r) => {
      const actor = r.actorId ? users.get(r.actorId) : undefined;
      const target = r.userId ? users.get(r.userId) : undefined;
      const groupId = r.name.startsWith("groups.") ? r.modelId : isId(r.data?.groupId) ? r.data.groupId : null;
      const group = groupId ? groupById.get(groupId) : undefined;
      const changes = r.changes
        ? Object.fromEntries(Object.entries(r.changes).map(([field, c]) => [field, { ...c, fromLabel: label(field, c.from), toLabel: label(field, c.to) }]))
        : null;
      return {
        id: r.id,
        name: r.name,
        modelId: r.modelId,
        actorId: r.actorId,
        actor: actor ? presentUser(actor) : null,
        userId: r.userId,
        user: target ? presentUser(target) : null,
        collectionId: r.collectionId,
        collection: colRef(r.collectionId),
        documentId: r.documentId,
        document: docRef(r.documentId),
        group: group ? { id: group.id, name: group.name } : null,
        data: r.data,
        changes,
        ...(audit ? { actorIpAddress: r.ip, client: describeClient(r.userAgent), userAgent: r.userAgent, via: r.via } : {}),
        createdAt: r.createdAt,
      };
    }),
    pagination: page("events.list", limit, offset),
  };
});
