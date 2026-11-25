// shares.*: public links to documents, and the public pages they open (/s/<id>), rendered here as plain
// read-only HTML since Outline's own web app is gone. With includeChildDocuments, the page has a sidebar
// of the document's children, each at /s/<id>/doc/<slug-urlId>. Files in a shared document are served
// through the share (/s/<id>/files/<attachment>), only when the shared documents link to them.

import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import { sql } from "../db.ts";
import { Access } from "../access.ts";
import { collectionUrl, documentUrl, slugify, type NavNode } from "../content.ts";
import { esc, headingId, headingsOf, page as htmlPage, toHtml } from "../html.ts";
import { forbidden, invalid, notFound } from "../http.ts";
import type { PMNode } from "../markdown.ts";
import { collectionPolicy, documentPolicy } from "../policies.ts";
import { DOC_COLUMNS, presentUser, usersById, type DocumentRow } from "../presenters.ts";
import { method } from "../rpc.ts";
import { disposition, exists, open } from "../storage.ts";
import { teamById, teamUrl, type TeamRow } from "../users.ts";
import { collectionFor, documentFor, page } from "./common.ts";

interface ShareRow {
  id: string;
  teamId: string;
  userId: string | null;
  documentId: string | null;
  collectionId: string | null;
  urlId: string | null;
  published: boolean;
  includeChildDocuments: boolean;
  allowIndexing: boolean;
  allowSubscriptions: boolean;
  showLastUpdated: boolean;
  showToc: boolean;
  domain: string | null;
  title: string | null;
  iconUrl: string | null;
  expiresAt: Date | null;
  views: number;
  lastAccessedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const shareUrl = (s: ShareRow, team: TeamRow) => `${teamUrl(team)}/s/${s.urlId ?? s.id}`;

async function present(rows: ShareRow[]) {
  const team = rows.length ? await teamById(rows[0].teamId) : null;
  const users = await usersById(rows.map((s) => s.userId));
  const docIds = rows.map((s) => s.documentId).filter((x): x is string => !!x);
  const docs = docIds.length ? await sql<{ id: string; title: string; urlId: string }[]>`SELECT id, title, url_id FROM documents WHERE id = ANY(${docIds}::uuid[])` : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  const colIds = rows.filter((s) => !s.documentId && s.collectionId).map((s) => s.collectionId!);
  const cols = colIds.length ? await sql<{ id: string; name: string; urlId: string }[]>`SELECT id, name, url_id FROM collections WHERE id = ANY(${colIds}::uuid[])` : [];
  const colById = new Map(cols.map((c) => [c.id, c]));
  return rows.map((s) => {
    const d = s.documentId ? byId.get(s.documentId) : undefined;
    const col = !s.documentId && s.collectionId ? colById.get(s.collectionId) : undefined;
    return {
      id: s.id,
      documentId: s.documentId,
      documentTitle: d?.title ?? null,
      documentUrl: d ? documentUrl(d) : null,
      sourceTitle: d?.title ?? col?.name ?? null,
      sourcePath: d ? documentUrl(d) : col ? collectionUrl(col) : null,
      collectionId: s.collectionId,
      urlId: s.urlId,
      url: shareUrl(s, team!),
      domain: s.domain,
      title: s.title,
      iconUrl: s.iconUrl,
      published: s.published,
      includeChildDocuments: s.includeChildDocuments,
      allowSubscriptions: s.allowSubscriptions,
      allowIndexing: s.allowIndexing,
      showLastUpdated: s.showLastUpdated,
      showTOC: s.showToc,
      expiresAt: iso(s.expiresAt),
      views: s.views,
      createdAt: iso(s.createdAt),
      createdBy: s.userId && users.get(s.userId) ? presentUser(users.get(s.userId)!) : null,
      updatedAt: iso(s.updatedAt),
      lastAccessedAt: iso(s.lastAccessedAt),
    };
  });
}

const atLeastAdmin = (a: Access, collectionId: string) => a.isAdmin || a.collection(collectionId) === "admin";

const sharePolicy = (s: ShareRow, canEdit: boolean) => ({ id: s.id, abilities: { read: true, update: canEdit, revoke: canEdit } });

/** The document's own share, and an ancestor's that covers it (includeChildDocuments). */
method("shares.info", async (call) => {
  const a = await Access.for(call.user);
  const id = call.params.uuid("id");
  if (id) {
    const [s] = await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${id} AND team_id = ${call.user.teamId} AND revoked_at IS NULL`;
    if (!s) throw notFound();
    if (s.documentId) await documentFor(a, s.documentId);
    return { data: { shares: await present([s]) }, policies: [sharePolicy(s, true)] };
  }
  const collectionId = call.params.uuid("collectionId");
  if (collectionId && !call.params.uuid("documentId")) {
    const col = await collectionFor(a, collectionId);
    const rows = await sql<ShareRow[]>`SELECT * FROM shares WHERE collection_id = ${col.id} AND document_id IS NULL AND revoked_at IS NULL`;
    const canEdit = !!collectionPolicy(a, col, await teamById(call.user.teamId)).abilities.share && atLeastAdmin(a, col.id);
    return { data: { shares: await present(rows) }, policies: rows.map((s) => sharePolicy(s, canEdit)) };
  }
  const d = await documentFor(a, call.params.uuid("documentId", { required: true }));
  const rows = await sql<ShareRow[]>`
    WITH RECURSIVE up AS (SELECT id, parent_document_id, 0 AS depth FROM documents WHERE id = ${d.id}
      UNION ALL SELECT p.id, p.parent_document_id, up.depth + 1 FROM documents p JOIN up ON p.id = up.parent_document_id)
    SELECT s.* FROM shares s JOIN up ON up.id = s.document_id
    WHERE s.revoked_at IS NULL AND (up.depth = 0 OR s.include_child_documents) ORDER BY up.depth`;
  const canEdit = !!documentPolicy(a, d, await teamById(call.user.teamId)).abilities.share;
  return { data: { shares: await present(rows) }, policies: rows.map((s) => sharePolicy(s, canEdit)) };
});

method("shares.create", async (call) => {
  const team = await teamById(call.user.teamId);
  if (!team.sharing) throw forbidden("Public sharing is turned off for this workspace");
  const a = await Access.for(call.user);
  const collectionId = call.params.uuid("collectionId");
  if (collectionId && !call.params.uuid("documentId")) {
    // A whole collection: its managers share it, with every published document in it.
    const col = await collectionFor(a, collectionId);
    if (!collectionPolicy(a, col, team).abilities.share || !atLeastAdmin(a, col.id)) throw forbidden();
    let [s] = await sql<ShareRow[]>`SELECT * FROM shares WHERE collection_id = ${col.id} AND document_id IS NULL AND revoked_at IS NULL LIMIT 1`;
    const published = call.params.boolean("published");
    if (!s) {
      [s] = await sql<ShareRow[]>`
        INSERT INTO shares (team_id, user_id, collection_id, published, include_child_documents)
        VALUES (${team.id}, ${call.user.id}, ${col.id}, ${published ?? false}, true) RETURNING *`;
    } else if (published !== undefined && published !== s.published) {
      [s] = await sql<ShareRow[]>`UPDATE shares SET published = ${published}, updated_at = now() WHERE id = ${s.id} RETURNING *`;
    }
    return { data: (await present([s]))[0], policies: [sharePolicy(s, true)] };
  }
  const d = await documentFor(a, call.params.uuid("documentId", { required: true }));
  if (!documentPolicy(a, d, team).abilities.share) throw forbidden();
  const [existing] = await sql<ShareRow[]>`SELECT * FROM shares WHERE document_id = ${d.id} AND revoked_at IS NULL LIMIT 1`;
  const published = call.params.boolean("published");
  let s = existing;
  if (!s) {
    [s] = await sql<ShareRow[]>`
      INSERT INTO shares (team_id, user_id, document_id, collection_id, published, include_child_documents)
      VALUES (${team.id}, ${call.user.id}, ${d.id}, ${d.collectionId}, ${published ?? false}, ${call.params.boolean("includeChildDocuments") ?? false}) RETURNING *`;
  } else if (published !== undefined && published !== s.published) {
    [s] = await sql<ShareRow[]>`UPDATE shares SET published = ${published}, updated_at = now() WHERE id = ${s.id} RETURNING *`;
  }
  return { data: (await present([s]))[0], policies: [sharePolicy(s, true)] };
});

method("shares.update", async (call) => {
  const a = await Access.for(call.user);
  const p = call.params;
  const [s] = await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${p.uuid("id", { required: true })!} AND team_id = ${call.user.teamId} AND revoked_at IS NULL`;
  if (!s) throw notFound();
  if (s.documentId) await documentFor(a, s.documentId);
  else if (s.collectionId && !atLeastAdmin(a, s.collectionId)) throw forbidden();
  const urlId = p.has("urlId") ? (p.nullableString("urlId", 100) ?? null) : s.urlId;
  if (urlId && !/^[a-zA-Z0-9-]{1,100}$/.test(urlId)) throw invalid("The link name can only use letters, digits and dashes");
  if (urlId && urlId !== s.urlId) {
    const [taken] = await sql`SELECT 1 FROM shares WHERE url_id = ${urlId} AND id <> ${s.id}`;
    if (taken) throw invalid("This link name is taken");
  }
  const [u] = await sql<ShareRow[]>`
    UPDATE shares SET published = ${p.boolean("published") ?? s.published}, include_child_documents = ${p.boolean("includeChildDocuments") ?? s.includeChildDocuments},
      allow_indexing = ${p.boolean("allowIndexing") ?? s.allowIndexing}, show_last_updated = ${p.boolean("showLastUpdated") ?? s.showLastUpdated},
      show_toc = ${p.boolean("showTOC") ?? s.showToc}, allow_subscriptions = ${p.boolean("allowSubscriptions") ?? s.allowSubscriptions}, url_id = ${urlId},
      title = ${p.has("title") ? (p.nullableString("title", 255) ?? null) : s.title},
      expires_at = ${p.has("expiresAt") ? (p.raw.expiresAt ? new Date(String(p.raw.expiresAt)) : null) : s.expiresAt}, updated_at = now()
    WHERE id = ${s.id} RETURNING *`;
  return { data: (await present([u]))[0], policies: [sharePolicy(u, true)] };
});

method("shares.revoke", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const [s] = await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${id} AND team_id = ${call.user.teamId} AND revoked_at IS NULL`;
  if (!s) throw notFound();
  if (s.userId !== call.user.id && call.user.role !== "admin") {
    const a = await Access.for(call.user);
    if (s.documentId) await documentFor(a, s.documentId, "read_write");
    else if (!s.collectionId || !atLeastAdmin(a, s.collectionId)) throw forbidden();
  }
  await sql`UPDATE shares SET revoked_at = now(), revoked_by_id = ${call.user.id} WHERE id = ${s.id}`;
  return { success: true };
});

method("shares.list", async (call) => {
  const { limit, offset } = call.params.pagination();
  const query = call.params.string("query");
  const rows = await sql<ShareRow[]>`
    SELECT s.* FROM shares s LEFT JOIN documents d ON d.id = s.document_id LEFT JOIN collections c ON c.id = s.collection_id AND s.document_id IS NULL
    WHERE s.team_id = ${call.user.teamId} AND s.revoked_at IS NULL AND s.published AND (d.id IS NULL OR d.deleted_at IS NULL)
      AND ${call.user.role === "admin" ? sql`true` : sql`s.user_id = ${call.user.id}`}
      ${query ? sql`AND notes_norm(coalesce(d.title, c.name)) LIKE ${"%" + query.toLowerCase() + "%"}` : sql``}
    ORDER BY s.updated_at ${call.params.direction("DESC") === "ASC" ? sql`ASC` : sql`DESC`} LIMIT ${limit} OFFSET ${offset}`;
  return { pagination: page("shares.list", limit, offset), data: await present(rows), policies: rows.map((s) => sharePolicy(s, true)) };
});

// ---------- The public pages ----------

interface Live {
  s: ShareRow;
  /** The shared document; null for a whole collection. */
  root: DocumentRow | null;
  collection: { id: string; name: string; content: unknown; documentStructure: NavNode[] | null } | null;
  /** Every document the link opens (the root and its children, or the collection's). */
  docs: DocumentRow[];
}

/** A live, published share and what it opens, or null (revoked, expired, sharing off, gone). */
async function liveShare(id: string, team: TeamRow): Promise<Live | null> {
  if (!team.sharing) return null;
  const isUuid = /^[0-9a-f-]{36}$/i.test(id);
  const [s] = await sql<ShareRow[]>`SELECT * FROM shares WHERE team_id = ${team.id} AND ${isUuid ? sql`id = ${id}` : sql`url_id = ${id}`} AND revoked_at IS NULL AND published`;
  if (!s || (s.expiresAt && s.expiresAt < new Date())) return null;
  if (s.documentId) {
    const [root] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${s.documentId} AND d.deleted_at IS NULL AND d.published_at IS NOT NULL`;
    if (!root) return null;
    return { s, root, collection: null, docs: [root, ...(s.includeChildDocuments ? await childrenOf(root) : [])] };
  }
  if (!s.collectionId) return null;
  const [collection] = await sql<NonNullable<Live["collection"]>[]>`
    SELECT id, name, content, document_structure FROM collections WHERE id = ${s.collectionId} AND deleted_at IS NULL AND archived_at IS NULL AND sharing`;
  if (!collection) return null;
  const docs = await sql<DocumentRow[]>`
    SELECT ${DOC_COLUMNS} FROM documents d WHERE d.collection_id = ${collection.id} AND d.deleted_at IS NULL AND d.archived_at IS NULL AND d.published_at IS NOT NULL AND NOT d.is_template`;
  return { s, root: null, collection, docs };
}

/** The shared document's published children (includeChildDocuments). */
async function childrenOf(root: DocumentRow) {
  return sql<DocumentRow[]>`
    WITH RECURSIVE t AS (
      SELECT id FROM documents WHERE parent_document_id = ${root.id} AND deleted_at IS NULL AND archived_at IS NULL AND published_at IS NOT NULL
      UNION ALL SELECT d.id FROM documents d JOIN t ON d.parent_document_id = t.id WHERE d.deleted_at IS NULL AND d.archived_at IS NULL AND d.published_at IS NOT NULL)
    SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id IN (SELECT id FROM t) ORDER BY d.title`;
}

const sharedPath = (shareId: string, d: { id: string; title: string; urlId: string }, rootId: string | null) =>
  d.id === rootId ? `/s/${shareId}` : `/s/${shareId}/doc/${slugify(d.title)}-${d.urlId}`;

function nav(shareId: string, live: Live, current: string | null) {
  const visible = new Map(live.docs.map((d) => [d.id, d]));
  const link = (d: { id: string; title: string; urlId: string }) =>
    `<a href="${esc(sharedPath(shareId, d, live.root?.id ?? null))}"${d.id === current ? ' class="current"' : ""}>${esc(d.title || "Untitled")}</a>`;
  if (live.collection) {
    // The collection's own order.
    const level = (nodes: NavNode[]): string => {
      const shown = nodes.map((n) => [n, visible.get(n.id)] as const).filter(([, d]) => d);
      return shown.length ? `<ul>${shown.map(([n, d]) => `<li>${link(d!)}${level(n.children ?? [])}</li>`).join("")}</ul>` : "";
    };
    const home = `<ul><li><a href="/s/${esc(shareId)}"${current === null ? ' class="current"' : ""}><strong>${esc(live.collection.name)}</strong></a></li></ul>`;
    return home + level(live.collection.documentStructure ?? []);
  }
  const root = live.root!;
  const level = (parentId: string): string => {
    const kids = live.docs.filter((d) => d.parentDocumentId === parentId);
    return kids.length ? `<ul>${kids.map((d) => `<li>${link(d)}${level(d.id)}</li>`).join("")}</ul>` : "";
  };
  return `<ul><li>${link(root)}${level(root.id)}</li></ul>`;
}

/** Outline's "show table of contents": the headings, linked to their anchors. */
function toc(content: unknown) {
  const hs = headingsOf(content as PMNode).filter((h) => h.text.trim());
  if (hs.length < 2) return "";
  const min = Math.min(...hs.map((h) => h.level));
  const items = hs.map((h) => `<li style="margin-left:${(h.level - min) * 16}px"><a href="#${esc(headingId(h.text))}">${esc(h.text)}</a></li>`).join("");
  return `<details class="toc" open><summary>Contents</summary><ul>${items}</ul></details>
<style>.toc{border:1px solid var(--line);border-radius:6px;padding:8px 14px;margin:0 0 1.5em;font-size:14px}.toc ul{list-style:none;padding:0;margin:6px 0 0}</style>`;
}

export const shareRoutes = new Hono<AppEnv>();

async function render(shareId: string, docRef: string | null, team: TeamRow) {
  const live = await liveShare(shareId, team);
  if (!live) return null;
  const { s } = live;
  const urlId = docRef?.match(/([a-zA-Z0-9]{10})$/)?.[1];
  const doc = docRef ? live.docs.find((d) => d.urlId === urlId && d.id !== live.root?.id) : live.root;
  if (docRef && !doc) return null;
  await sql`UPDATE shares SET views = views + 1, last_accessed_at = now() WHERE id = ${s.id}`;
  const files = (url: string) => url.replace(/^\/api\/attachments\.redirect\?id=([0-9a-f-]{36})$/i, `/s/${shareId}/files/$1`);
  // Links between shared documents stay inside the shared pages.
  const links = (url: string) => {
    const m = url.match(/^\/doc\/(?:[^/]*-)?([a-zA-Z0-9]{10})(#.*)?$/);
    const target = m ? live.docs.find((d) => d.urlId === m[1]) : undefined;
    return target ? sharedPath(shareId, target, live.root?.id ?? null) + (m?.[2] ?? "") : files(url);
  };
  const lang = team.preferences && typeof team.preferences.language === "string" ? team.preferences.language : undefined;
  const brand = { name: team.name, logo: team.avatarUrl, home: `/s/${shareId}` };
  if (!doc) {
    // A collection's landing page: its description, and its documents in the sidebar.
    const c = live.collection!;
    const body = (c.content ? toHtml(c.content as PMNode, links) : "") || `<p>${live.docs.length} documents</p>`;
    return htmlPage(s.title || c.name, body, { nav: nav(shareId, live, null), noindex: !s.allowIndexing, lang, brand });
  }
  const updated = s.showLastUpdated ? `<p class="updated">Updated ${esc(doc.updatedAt.toISOString().slice(0, 10))}</p>` : "";
  return htmlPage(doc.title || "Untitled", (s.showToc ? toc(doc.content) : "") + toHtml(doc.content as PMNode, links) + updated, {
    nav: live.collection || live.docs.length > 1 ? nav(shareId, live, doc.id) : undefined,
    noindex: !s.allowIndexing,
    lang,
    brand,
  });
}

const notFoundPage = (_c?: unknown) =>
  new Response(htmlPage("Not found", "<p>This link doesn't exist, or isn't shared any more.</p>"), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });

shareRoutes.get("/:shareId", async (c) => {
  const html = await render(c.req.param("shareId"), null, c.get("team"));
  return html ? c.html(html) : notFoundPage(c);
});

shareRoutes.get("/:shareId/doc/:doc", async (c) => {
  const html = await render(c.req.param("shareId"), c.req.param("doc"), c.get("team"));
  return html ? c.html(html) : notFoundPage(c);
});

shareRoutes.get("/:shareId/files/:id", async (c) => {
  const live = await liveShare(c.req.param("shareId"), c.get("team"));
  const id = c.req.param("id").toLowerCase();
  if (!live || !/^[0-9a-f-]{36}$/.test(id)) return notFoundPage(c);
  // Only files the shared pages actually link to.
  const needle = `attachments.redirect?id=${id}`;
  const description = live.collection?.content ? JSON.stringify(live.collection.content).toLowerCase() : "";
  if (!description.includes(needle) && !live.docs.some((d) => d.text.toLowerCase().includes(needle))) return notFoundPage(c);
  const [a] = await sql<{ key: string; name: string; contentType: string }[]>`SELECT key, name, content_type FROM attachments WHERE id = ${id} AND team_id = ${live.s.teamId}`;
  if (!a || (await exists(a.key)) === null) return notFoundPage(c);
  return new Response(open(a.key), {
    headers: { "Content-Type": a.contentType, "Content-Disposition": disposition(a.name, a.contentType), "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
  });
});
