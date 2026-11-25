// Files: uploads (attachments.create, then the file to /api/files.create, as Outline's local storage),
// downloads (attachments.redirect, files.get), a document's export (Markdown, HTML, TextBundle) and
// collection/workspace exports built in the background (fileOperations.*).

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { strToU8, zipSync, type Zippable } from "fflate";
import { UPLOAD_MAX_SIZE } from "../config.ts";
import { sql } from "../db.ts";
import { Access } from "../access.ts";
import { checkCsrf, identify, type AppEnv } from "../auth.ts";
import { publish } from "../events.ts";
import { esc, page as htmlPage, toHtml } from "../html.ts";
import { ApiError, forbidden, invalid, notFound, unauthenticated } from "../http.ts";
import { toMarkdown, type PMNode } from "../markdown.ts";
import { notify } from "../notify.ts";
import { DOC_COLUMNS, presentUser, usersById, type CollectionRow, type DocumentRow } from "../presenters.ts";
import { method, type SignedInCall } from "../rpc.ts";
import { disposition, exists, open, pathOf, remove, safeName, save } from "../storage.ts";
import type { UserRow } from "../users.ts";
import { collectionFor, documentFor, page } from "./common.ts";

interface AttachmentRow {
  id: string;
  teamId: string;
  userId: string | null;
  documentId: string | null;
  key: string;
  name: string;
  contentType: string;
  size: number;
  acl: string;
  uploadedAt: Date | null;
  createdAt: Date;
}

/** Avatars, emoji, logos: public (served to anyone, like Outline's public-read files). */
const PUBLIC_PRESETS = new Set(["avatar", "emoji", "teamLogo"]);

export const attachmentUrl = (a: Pick<AttachmentRow, "id" | "key" | "acl">) =>
  a.acl === "public-read" ? `/api/files.get?key=${encodeURIComponent(a.key)}` : `/api/attachments.redirect?id=${a.id}`;

const presentAttachment = (a: AttachmentRow) => ({
  id: a.id,
  documentId: a.documentId,
  contentType: a.contentType,
  name: a.name,
  size: Number(a.size),
  url: attachmentUrl(a),
  userId: a.userId,
  createdAt: a.createdAt.toISOString(),
});

// ---------- Uploads ----------

method("attachments.create", async (call) => {
  const p = call.params;
  const name = safeName(p.string("name", { required: true, max: 255 })!);
  const contentType = p.string("contentType", { max: 255 }) ?? "application/octet-stream";
  const size = p.number("size", { min: 0 }) ?? 0;
  if (size > UPLOAD_MAX_SIZE) throw new ApiError("payload_too_large", `The file is too large (at most ${Math.floor(UPLOAD_MAX_SIZE / 1024 / 1024)} MB)`);
  const preset = p.string("preset") ?? "documentAttachment";
  const documentId = p.uuid("documentId") ?? null;
  if (documentId) {
    const a = await Access.for(call.user);
    await documentFor(a, documentId, "read_write");
  } else if (preset === "documentAttachment") throw invalid("documentId is required");
  if (preset === "teamLogo" && call.user.role !== "admin") throw forbidden();
  const id = randomUUID();
  const isPublic = PUBLIC_PRESETS.has(preset);
  const key = isPublic ? `public/${call.user.teamId}/${id}/${name}` : `uploads/${call.user.id}/${id}/${name}`;
  const [row] = await sql<AttachmentRow[]>`
    INSERT INTO attachments (id, team_id, user_id, document_id, key, name, content_type, size, acl)
    VALUES (${id}, ${call.user.teamId}, ${call.user.id}, ${documentId}, ${key}, ${name}, ${contentType}, ${size}, ${isPublic ? "public-read" : "private"})
    RETURNING *`;
  return {
    data: {
      uploadUrl: "/api/files.create",
      form: { "Cache-Control": "max-age=31557600", "Content-Type": contentType, key },
      attachment: presentAttachment(row),
    },
  };
});

/** The upload itself (multipart: the key attachments.create gave, then the file). */
export async function filesCreate(c: Context<AppEnv>) {
  const caller = await identify(c);
  if (!caller) throw unauthenticated();
  checkCsrf(c, caller);
  const form = await c.req.parseBody();
  const key = typeof form.key === "string" ? form.key : "";
  const file = form.file;
  if (!key || !(file instanceof File)) throw invalid("key and file are required");
  const [a] = await sql<AttachmentRow[]>`SELECT * FROM attachments WHERE key = ${key}`;
  if (!a || a.userId !== caller.user.id) throw forbidden();
  if (a.uploadedAt) throw invalid("This file was uploaded already");
  if (file.size > UPLOAD_MAX_SIZE) throw new ApiError("payload_too_large", "The file is too large");
  const size = await save(key, file.stream());
  await sql`UPDATE attachments SET size = ${size}, uploaded_at = now(), updated_at = now() WHERE id = ${a.id}`;
  return c.json({ ok: true, status: 200, data: presentAttachment({ ...a, size }) });
}

// ---------- Downloads ----------

function fileResponse(a: { key: string; name: string; contentType: string; size?: number }, opts: { download?: boolean; publicCache?: boolean } = {}) {
  return new Response(open(a.key), {
    headers: {
      "Content-Type": a.contentType || "application/octet-stream",
      "Content-Disposition": disposition(a.name, a.contentType, opts.download),
      "Cache-Control": opts.publicCache ? "public, max-age=31536000, immutable" : "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      // Uploaded HTML or SVG can't run scripts on this origin.
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      ...(a.size ? { "Content-Length": String(a.size) } : {}),
    },
  });
}

/** May this user open this attachment? Its document's readers, its uploader, and admins. */
async function canRead(user: UserRow, a: AttachmentRow): Promise<boolean> {
  if (a.teamId !== user.teamId) return false;
  if (a.acl === "public-read" || a.userId === user.id || user.role === "admin") return true;
  if (!a.documentId) return false;
  const access = await Access.for(user);
  const [d] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${a.documentId}`;
  return !!d && !!access.document(d);
}

/** attachments.redirect: GET (an <img> in a document) or POST (a download). */
export async function attachmentRedirect(c: Context<AppEnv>, id: string | undefined) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const caller = await identify(c);
  const [a] = await sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${id}`;
  if (!a || !(await exists(a.key))) throw notFound();
  if (a.acl !== "public-read") {
    if (!caller) throw unauthenticated();
    if (!(await canRead(caller.user, a))) throw notFound();
  }
  void sql`UPDATE attachments SET last_accessed_at = now() WHERE id = ${a.id}`.catch(() => {});
  return fileResponse(a, { download: c.req.method === "POST" });
}

method("attachments.redirect", (call) => attachmentRedirect(call.c, call.params.uuid("id", { required: true })));

/** files.get?key=…: public files to anyone; others to whoever can read them. */
export async function filesGet(c: Context<AppEnv>) {
  const key = c.req.query("key") ?? "";
  pathOf(key);
  const [a] = await sql<AttachmentRow[]>`SELECT * FROM attachments WHERE key = ${key}`;
  const size = await exists(key);
  if (size === null) throw notFound();
  if (!a) {
    // A file with no attachment row (an Outline import's avatar, say): public paths only.
    if (!key.startsWith("public/")) throw notFound();
    const name = key.split("/").at(-1) ?? "file";
    return fileResponse({ key, name, contentType: guessType(name), size }, { publicCache: true });
  }
  if (a.acl !== "public-read") {
    const caller = await identify(c);
    if (!caller) throw unauthenticated();
    if (!(await canRead(caller.user, a))) throw notFound();
  }
  return fileResponse(a, { publicCache: a.acl === "public-read" });
}

function guessType(name: string) {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

method("attachments.delete", async (call) => {
  const id = call.params.uuid("id", { required: true })!;
  const [a] = await sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${id} AND team_id = ${call.user.teamId}`;
  if (!a) throw notFound();
  if (a.userId !== call.user.id && call.user.role !== "admin") throw forbidden();
  await sql`DELETE FROM attachments WHERE id = ${a.id}`;
  await remove(a.key);
  return { success: true };
});

method("attachments.list", async (call) => {
  const { limit, offset } = call.params.pagination();
  const documentId = call.params.uuid("documentId");
  const rows = await sql<AttachmentRow[]>`
    SELECT * FROM attachments WHERE team_id = ${call.user.teamId} AND uploaded_at IS NOT NULL
      AND ${call.user.role === "admin" ? sql`true` : sql`user_id = ${call.user.id}`} ${documentId ? sql`AND document_id = ${documentId}` : sql``}
    ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  return { pagination: page("attachments.list", limit, offset), data: rows.map(presentAttachment) };
});

// ---------- A document's export ----------

const ATTACHMENT_URL = /\/api\/attachments\.redirect\?id=([0-9a-f-]{36})/gi;

/** The attachments a document links to, by id. */
async function linkedAttachments(user: UserRow, text: string): Promise<AttachmentRow[]> {
  const ids = [...new Set([...text.matchAll(ATTACHMENT_URL)].map((m) => m[1].toLowerCase()))];
  if (!ids.length) return [];
  const rows = await sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ANY(${ids}::uuid[]) AND team_id = ${user.teamId}`;
  const out: AttachmentRow[] = [];
  for (const a of rows) if ((await exists(a.key)) !== null && (await canRead(user, a))) out.push(a);
  return out;
}

const readFile = async (key: string) => new Uint8Array(await new Response(open(key)).arrayBuffer());

method("documents.export", async (call) => {
  const a = await Access.for(call.user);
  const d = await documentFor(a, call.params.string("id", { required: true }));
  const accept = call.c.req.header("accept") ?? "";
  const markdown = `# ${d.title}\n\n${d.text}`;
  const name = safeName(d.title || "Untitled");
  if (accept.includes("text/html")) {
    const html = htmlPage(d.title || "Untitled", toHtml(d.content as PMNode), { lang: call.user.language?.slice(0, 2) });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": disposition(`${name}.html`, "text/html", true) } });
  }
  if (accept.includes("application/x-textbundle")) {
    // A TextBundle: the Markdown with its images and files in assets/.
    const files: Zippable = {};
    let text = markdown;
    for (const att of await linkedAttachments(call.user, markdown)) {
      const path = `assets/${att.id.slice(0, 8)}-${att.name}`;
      files[`${name}.textbundle/${path}`] = await readFile(att.key);
      text = text.replaceAll(new RegExp(`/api/attachments\\.redirect\\?id=${att.id}`, "gi"), path);
    }
    files[`${name}.textbundle/text.md`] = strToU8(text);
    files[`${name}.textbundle/info.json`] = strToU8(JSON.stringify({ version: 2, type: "net.daringfireball.markdown", transient: false }));
    return new Response(zipSync(files), { headers: { "Content-Type": "application/zip", "Content-Disposition": disposition(`${name}.textpack`, "application/zip", true) } });
  }
  if (accept.includes("text/markdown")) return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": disposition(`${name}.md`, "text/markdown", true) } });
  return { data: markdown };
});

// ---------- Collection and workspace exports (fileOperations) ----------

interface FileOperationRow {
  id: string;
  teamId: string;
  userId: string | null;
  collectionId: string | null;
  documentId: string | null;
  type: string;
  format: string;
  name: string;
  state: string;
  error: string | null;
  key: string | null;
  size: number;
  includeAttachments: boolean;
  createdAt: Date;
  updatedAt: Date;
}

async function presentOperations(rows: FileOperationRow[]) {
  const users = await usersById(rows.map((r) => r.userId));
  return rows.map((o) => ({
    id: o.id,
    type: o.type,
    format: o.format,
    name: o.name,
    state: o.state,
    error: o.error,
    size: Number(o.size),
    collectionId: o.collectionId,
    documentId: o.documentId,
    user: o.userId && users.get(o.userId) ? presentUser(users.get(o.userId)!) : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  }));
}

const FORMATS = ["outline-markdown", "markdown", "html", "json", "okf", "textbundle"] as const;

async function startExport(call: SignedInCall, collections: CollectionRow[], name: string, collectionId: string | null) {
  const format = call.params.oneOf("format", FORMATS) ?? "outline-markdown";
  const includeAttachments = call.params.boolean("includeAttachments") ?? true;
  const [op] = await sql<FileOperationRow[]>`
    INSERT INTO file_operations (team_id, user_id, collection_id, type, format, name, state, include_attachments)
    VALUES (${call.user.teamId}, ${call.user.id}, ${collectionId}, 'export', ${format}, ${name}, 'creating', ${includeAttachments}) RETURNING *`;
  setImmediate(() => void buildExport(op, call.user, collections).catch((e) => console.warn("Export failed:", e)));
  return { data: { fileOperation: (await presentOperations([op]))[0] } };
}

method("collections.export", async (call) => {
  const a = await Access.for(call.user);
  const c = await collectionFor(a, call.params.uuid("id", { required: true }));
  return startExport(call, [c], c.name, c.id);
});

method("collections.export_all", async (call) => {
  if (call.user.role !== "admin") throw forbidden();
  const a = await Access.for(call.user);
  const includePrivate = call.params.boolean("includePrivate") ?? true;
  const rows = await sql<CollectionRow[]>`SELECT * FROM collections WHERE team_id = ${call.user.teamId} AND deleted_at IS NULL AND id = ANY(${a.readableCollections()}::uuid[]) ORDER BY index COLLATE "C"`;
  const collections = includePrivate ? rows : rows.filter((c) => c.permission);
  return startExport(call, collections, "Workspace export", null);
});

/** Builds the zip: a folder per collection, a file per document, children in a folder named after their parent. */
async function buildExport(op: FileOperationRow, user: UserRow, collections: CollectionRow[]) {
  const access = await Access.for(user);
  const files: Zippable = {};
  const used = new Set<string>();
  const unique = (path: string) => {
    let p = path;
    for (let i = 2; used.has(p.toLowerCase()); i++) p = path.replace(/(\.[a-z]+)$/, ` (${i})$1`);
    used.add(p.toLowerCase());
    return p;
  };
  const ext = op.format === "html" ? "html" : op.format === "json" ? "json" : "md";
  const attachments = new Map<string, AttachmentRow>();
  try {
    await sql`UPDATE file_operations SET state = 'uploading', updated_at = now() WHERE id = ${op.id}`;
    for (const c of collections) {
      const folder = safeName(c.name);
      const docs = await sql<DocumentRow[]>`
        SELECT ${DOC_COLUMNS} FROM documents d WHERE d.collection_id = ${c.id} AND d.deleted_at IS NULL AND d.published_at IS NOT NULL AND NOT d.is_template`;
      const readable = docs.filter((d) => access.document(d));
      if (op.format === "json") {
        files[unique(`${folder}.json`)] = strToU8(
          JSON.stringify({ collection: { id: c.id, urlId: c.urlId, name: c.name, data: c.content, description: c.description, icon: c.icon, color: c.color, documentStructure: c.documentStructure }, documents: Object.fromEntries(readable.map((d) => [d.id, { id: d.id, urlId: d.urlId, title: d.title, icon: d.icon, color: d.color, data: d.content, createdAt: d.createdAt, updatedAt: d.updatedAt, publishedAt: d.publishedAt, parentDocumentId: d.parentDocumentId }])) }, null, 2),
        );
      } else {
        const byParent = new Map<string | null, DocumentRow[]>();
        for (const d of readable) {
          const parent = readable.some((p) => p.id === d.parentDocumentId) ? d.parentDocumentId : null;
          byParent.set(parent, [...(byParent.get(parent) ?? []), d]);
        }
        const write = (parent: string | null, dir: string) => {
          for (const d of byParent.get(parent) ?? []) {
            const base = safeName(d.title || "Untitled");
            const depth = dir.split("/").length;
            const up = "../".repeat(depth);
            const rewrite = (url: string) =>
              op.includeAttachments ? url.replace(ATTACHMENT_URL, (_m, id: string) => `${up}uploads/${id.toLowerCase()}`) : url;
            for (const m of d.text.matchAll(ATTACHMENT_URL)) attachments.set(m[1].toLowerCase(), undefined as never);
            const body = ext === "html" ? htmlPage(d.title || "Untitled", toHtml(d.content as PMNode, rewrite)) : `# ${d.title}\n\n${rewrite(d.text)}`;
            files[unique(`${dir}/${base}.${ext}`)] = strToU8(body);
            write(d.id, `${dir}/${base}`);
          }
        };
        write(null, folder);
      }
    }
    if (op.includeAttachments && attachments.size) {
      const rows = await sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ANY(${[...attachments.keys()]}::uuid[]) AND team_id = ${op.teamId}`;
      for (const a of rows) if ((await exists(a.key)) !== null) files[`uploads/${a.id}`] = await readFile(a.key);
    }
    if (!Object.keys(files).length) files["README.md"] = strToU8("Nothing to export.\n");
    const key = `exports/${op.teamId}/${op.id}.zip`;
    const size = await save(key, zipSync(files));
    await sql`UPDATE file_operations SET state = 'complete', key = ${key}, size = ${size}, updated_at = now() WHERE id = ${op.id}`;
    await notify(op.teamId, [op.userId], { event: "emails.export_completed", fileOperationId: op.id });
  } catch (e) {
    await sql`UPDATE file_operations SET state = 'error', error = ${e instanceof Error ? e.message : String(e)}, updated_at = now() WHERE id = ${op.id}`;
    throw e;
  } finally {
    publish({ name: "fileOperations.update", data: { id: op.id }, teamId: op.teamId, userIds: op.userId ? [op.userId] : [] });
  }
}

async function operationFor(call: SignedInCall) {
  const id = call.params.uuid("id", { required: true })!;
  const [op] = await sql<FileOperationRow[]>`SELECT * FROM file_operations WHERE id = ${id} AND team_id = ${call.user.teamId} AND deleted_at IS NULL`;
  if (!op || (op.userId !== call.user.id && call.user.role !== "admin")) throw notFound();
  return op;
}

method("fileOperations.list", async (call) => {
  const { limit, offset } = call.params.pagination();
  const type = call.params.oneOf("type", ["export", "import"] as const);
  const rows = await sql<FileOperationRow[]>`
    SELECT * FROM file_operations WHERE team_id = ${call.user.teamId} AND deleted_at IS NULL ${type ? sql`AND type = ${type}` : sql``}
      AND ${call.user.role === "admin" ? sql`true` : sql`user_id = ${call.user.id}`}
    ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  return { pagination: page("fileOperations.list", limit, offset), data: await presentOperations(rows) };
});

method("fileOperations.info", async (call) => ({ data: (await presentOperations([await operationFor(call)]))[0] }));

method("fileOperations.delete", async (call) => {
  const op = await operationFor(call);
  await sql`UPDATE file_operations SET deleted_at = now() WHERE id = ${op.id}`;
  if (op.key) await remove(op.key);
  return { success: true };
});

method("fileOperations.redirect", async (call) => {
  const op = await operationFor(call);
  if (op.state !== "complete" || !op.key) throw invalid("The export isn't ready");
  return fileResponse({ key: op.key, name: `${safeName(op.name)}.zip`, contentType: "application/zip", size: Number(op.size) }, { download: true });
});

void esc;
