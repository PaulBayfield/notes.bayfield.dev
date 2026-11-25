// shares.*: public links to documents, and the public pages they open (/s/<id>), rendered here as plain
// read-only HTML since Outline's own web app is gone. With includeChildDocuments, the page has a sidebar
// of the document's children, each at /s/<id>/doc/<slug-urlId>. Files in a shared document are served
// through the share (/s/<id>/files/<attachment>), only when the shared documents link to them.

import { Hono } from "hono";
import { PUBLIC_URL } from "../config.ts";
import { sql } from "../db.ts";
import { Access } from "../access.ts";
import { documentUrl, slugify } from "../content.ts";
import { esc, page as htmlPage, toHtml } from "../html.ts";
import { forbidden, invalid, notFound } from "../http.ts";
import type { PMNode } from "../markdown.ts";
import { documentPolicy } from "../policies.ts";
import { DOC_COLUMNS, presentUser, usersById, type DocumentRow } from "../presenters.ts";
import { method } from "../rpc.ts";
import { disposition, exists, open } from "../storage.ts";
import { currentTeam } from "../users.ts";
import { documentFor, page } from "./common.ts";

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
const shareUrl = (s: ShareRow) => `${PUBLIC_URL}/s/${s.urlId ?? s.id}`;

async function present(rows: ShareRow[]) {
  const users = await usersById(rows.map((s) => s.userId));
  const docIds = rows.map((s) => s.documentId).filter((x): x is string => !!x);
  const docs = docIds.length ? await sql<{ id: string; title: string; urlId: string }[]>`SELECT id, title, url_id FROM documents WHERE id = ANY(${docIds}::uuid[])` : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return rows.map((s) => {
    const d = s.documentId ? byId.get(s.documentId) : undefined;
    return {
      id: s.id,
      documentId: s.documentId,
      documentTitle: d?.title ?? null,
      documentUrl: d ? documentUrl(d) : null,
      sourceTitle: d?.title ?? null,
      sourcePath: d ? documentUrl(d) : null,
      collectionId: s.collectionId,
      urlId: s.urlId,
      url: shareUrl(s),
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
  const d = await documentFor(a, call.params.uuid("documentId", { required: true }));
  const rows = await sql<ShareRow[]>`
    WITH RECURSIVE up AS (SELECT id, parent_document_id, 0 AS depth FROM documents WHERE id = ${d.id}
      UNION ALL SELECT p.id, p.parent_document_id, up.depth + 1 FROM documents p JOIN up ON p.id = up.parent_document_id)
    SELECT s.* FROM shares s JOIN up ON up.id = s.document_id
    WHERE s.revoked_at IS NULL AND (up.depth = 0 OR s.include_child_documents) ORDER BY up.depth`;
  const canEdit = !!documentPolicy(a, d, await currentTeam()).abilities.share;
  return { data: { shares: await present(rows) }, policies: rows.map((s) => sharePolicy(s, canEdit)) };
});

method("shares.create", async (call) => {
  const team = await currentTeam();
  if (!team.sharing) throw forbidden("Public sharing is turned off for this workspace");
  const a = await Access.for(call.user);
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
  if (s.userId !== call.user.id && call.user.role !== "admin" && s.documentId) await documentFor(await Access.for(call.user), s.documentId, "read_write");
  await sql`UPDATE shares SET revoked_at = now(), revoked_by_id = ${call.user.id} WHERE id = ${s.id}`;
  return { success: true };
});

method("shares.list", async (call) => {
  const { limit, offset } = call.params.pagination();
  const query = call.params.string("query");
  const rows = await sql<ShareRow[]>`
    SELECT s.* FROM shares s LEFT JOIN documents d ON d.id = s.document_id
    WHERE s.team_id = ${call.user.teamId} AND s.revoked_at IS NULL AND s.published AND (d.id IS NULL OR d.deleted_at IS NULL)
      AND ${call.user.role === "admin" ? sql`true` : sql`s.user_id = ${call.user.id}`}
      ${query ? sql`AND notes_norm(d.title) LIKE ${"%" + query.toLowerCase() + "%"}` : sql``}
    ORDER BY s.updated_at ${call.params.direction("DESC") === "ASC" ? sql`ASC` : sql`DESC`} LIMIT ${limit} OFFSET ${offset}`;
  return { pagination: page("shares.list", limit, offset), data: await present(rows), policies: rows.map((s) => sharePolicy(s, true)) };
});

// ---------- The public pages ----------

/** A live, published share and its document, or null (revoked, expired, sharing off, document gone). */
async function liveShare(id: string) {
  const team = await currentTeam();
  if (!team.sharing) return null;
  const isUuid = /^[0-9a-f-]{36}$/i.test(id);
  const [s] = await sql<ShareRow[]>`SELECT * FROM shares WHERE ${isUuid ? sql`id = ${id}` : sql`url_id = ${id}`} AND revoked_at IS NULL AND published`;
  if (!s?.documentId || (s.expiresAt && s.expiresAt < new Date())) return null;
  const [d] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${s.documentId} AND d.deleted_at IS NULL AND d.published_at IS NOT NULL`;
  return d ? { s, d } : null;
}

/** The shared document's published children, as a tree (includeChildDocuments). */
async function childrenOf(root: DocumentRow) {
  return sql<DocumentRow[]>`
    WITH RECURSIVE t AS (
      SELECT id FROM documents WHERE parent_document_id = ${root.id} AND deleted_at IS NULL AND archived_at IS NULL AND published_at IS NOT NULL
      UNION ALL SELECT d.id FROM documents d JOIN t ON d.parent_document_id = t.id WHERE d.deleted_at IS NULL AND d.archived_at IS NULL AND d.published_at IS NOT NULL)
    SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id IN (SELECT id FROM t) ORDER BY d.title`;
}

const sharedPath = (shareId: string, d: { id: string; title: string; urlId: string }, root: string) =>
  d.id === root ? `/s/${shareId}` : `/s/${shareId}/doc/${slugify(d.title)}-${d.urlId}`;

function nav(shareId: string, root: DocumentRow, docs: DocumentRow[], current: string) {
  const link = (d: DocumentRow) => `<a href="${esc(sharedPath(shareId, d, root.id))}"${d.id === current ? ' class="current"' : ""}>${esc(d.title || "Untitled")}</a>`;
  const level = (parentId: string): string => {
    const kids = docs.filter((d) => d.parentDocumentId === parentId);
    return kids.length ? `<ul>${kids.map((d) => `<li>${link(d)}${level(d.id)}</li>`).join("")}</ul>` : "";
  };
  return `<ul><li>${link(root)}${level(root.id)}</li></ul>`;
}

export const shareRoutes = new Hono();

async function render(shareId: string, docRef: string | null) {
  const live = await liveShare(shareId);
  if (!live) return null;
  const { s, d: root } = live;
  const children = s.includeChildDocuments ? await childrenOf(root) : [];
  const urlId = docRef?.match(/([a-zA-Z0-9]{10})$/)?.[1];
  const doc = docRef ? children.find((c) => c.urlId === urlId) : root;
  if (!doc) return null;
  await sql`UPDATE shares SET views = views + 1, last_accessed_at = now() WHERE id = ${s.id}`;
  const files = (url: string) => url.replace(/^\/api\/attachments\.redirect\?id=([0-9a-f-]{36})$/i, `/s/${shareId}/files/$1`);
  const team = await currentTeam();
  const updated = s.showLastUpdated ? `<p class="updated">Updated ${esc(doc.updatedAt.toISOString().slice(0, 10))}</p>` : "";
  return htmlPage(doc.title || "Untitled", toHtml(doc.content as PMNode, files) + updated, {
    nav: children.length ? nav(shareId, root, children, doc.id) : undefined,
    noindex: !s.allowIndexing,
    lang: team.preferences && typeof team.preferences.language === "string" ? team.preferences.language : undefined,
  });
}

const notFoundPage = (_c?: unknown) =>
  new Response(htmlPage("Not found", "<p>This link doesn't exist, or isn't shared any more.</p>"), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });

shareRoutes.get("/:shareId", async (c) => {
  const html = await render(c.req.param("shareId"), null);
  return html ? c.html(html) : notFoundPage(c);
});

shareRoutes.get("/:shareId/doc/:doc", async (c) => {
  const html = await render(c.req.param("shareId"), c.req.param("doc"));
  return html ? c.html(html) : notFoundPage(c);
});

shareRoutes.get("/:shareId/files/:id", async (c) => {
  const live = await liveShare(c.req.param("shareId"));
  const id = c.req.param("id").toLowerCase();
  if (!live || !/^[0-9a-f-]{36}$/.test(id)) return notFoundPage(c);
  // Only files the shared documents actually link to.
  const docs = [live.d, ...(live.s.includeChildDocuments ? await childrenOf(live.d) : [])];
  if (!docs.some((d) => d.text.toLowerCase().includes(`attachments.redirect?id=${id}`))) return notFoundPage(c);
  const [a] = await sql<{ key: string; name: string; contentType: string }[]>`SELECT key, name, content_type FROM attachments WHERE id = ${id} AND team_id = ${live.s.teamId}`;
  if (!a || (await exists(a.key)) === null) return notFoundPage(c);
  return new Response(open(a.key), {
    headers: { "Content-Type": a.contentType, "Content-Disposition": disposition(a.name, a.contentType), "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
  });
});
