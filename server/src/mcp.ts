// The Model Context Protocol server at /mcp (Streamable HTTP, stateless, JSON responses), with the
// same tools, names and arguments as Outline's: an assistant set up for one workspace works with the other.
// Clients sign in with OAuth (oauth.ts; discovered from the 401's WWW-Authenticate header) or an API key.
// Every tool runs the matching API method as the caller, so permissions and scopes are the API's.

import { Hono, type Context } from "hono";
import { APP_VERSION } from "./config.ts";
import { identify, type AppEnv, type Caller } from "./auth.ts";
import { ApiError, rateLimit } from "./http.ts";
import { invokeMethod } from "./rpc.ts";
import { teamUrl } from "./users.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** A mistake the assistant can fix: reported as a tool error, not a protocol one. */
class ToolError extends Error {}

type Args = Record<string, unknown>;
interface Ctx {
  c: Context<AppEnv>;
  caller: Caller;
  base: string;
}
interface Tool {
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  run: (args: Args, ctx: Ctx) => Promise<unknown>;
}

/** Runs an API method; its errors become tool errors the assistant can read. */
async function call(ctx: Ctx, name: string, params: Args = {}) {
  try {
    return await invokeMethod(name, params, ctx.caller, ctx.c);
  } catch (e) {
    if (e instanceof ApiError) throw new ToolError(e.message);
    throw e;
  }
}
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const dataOf = async (ctx: Ctx, name: string, params: Args = {}) => (await call(ctx, name, params) as { data: Data }).data;

const str = (a: Args, k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
const num = (a: Args, k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
const bool = (a: Args, k: string) => (typeof a[k] === "boolean" ? (a[k] as boolean) : undefined);
function need(a: Args, k: string) {
  const v = str(a, k);
  if (!v) throw new ToolError(`${k} is required`);
  return v;
}
/** An id, or a link to it ("https://…/doc/title-abc123XYZ0" → "title-abc123XYZ0"). */
function idOf(v: string) {
  try {
    const u = new URL(v);
    return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? v);
  } catch {
    return v;
  }
}
function collectionArg(v: string | undefined) {
  if (v === "personal") throw new ToolError("This workspace has no personal collections: pick a collection with list_collections");
  return v;
}

const absolute = (ctx: Ctx, url: unknown) => (typeof url === "string" && url.startsWith("/") ? `${ctx.base}${url}` : url);
const docSummary = (ctx: Ctx, d: Data) => ({
  id: d.id,
  title: d.title,
  url: absolute(ctx, d.url),
  collectionId: d.collectionId,
  parentDocumentId: d.parentDocumentId,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy?.name,
  publishedAt: d.publishedAt,
  archivedAt: d.archivedAt ?? undefined,
});
const docFull = (ctx: Ctx, d: Data) => ({ ...docSummary(ctx, d), icon: d.icon, color: d.color, createdAt: d.createdAt, createdBy: d.createdBy?.name, text: d.text });
const collectionSummary = (ctx: Ctx, c: Data) => ({ id: c.id, name: c.name, description: c.description ?? undefined, url: absolute(ctx, c.url), icon: c.icon, color: c.color, permission: c.permission, archivedAt: c.archivedAt ?? undefined });
const userSummary = (u: Data) => ({ id: u.id, name: u.name, email: u.email ?? undefined, role: u.role, avatarUrl: u.avatarUrl ?? undefined, lastActiveAt: u.lastActiveAt });
const commentSummary = (c: Data) => ({ id: c.id, documentId: c.documentId, parentCommentId: c.parentCommentId, text: c.text, createdAt: c.createdAt, createdBy: c.createdBy?.name, resolvedAt: c.resolvedAt ?? undefined, anchorText: c.anchorText ?? undefined });
const pageArgs = (a: Args) => ({ limit: Math.min(100, Math.max(1, num(a, "limit") ?? 25)), offset: Math.max(0, num(a, "offset") ?? 0) });

const limitProps = {
  limit: { type: "integer", minimum: 1, maximum: 100, description: "The maximum number of results to return. Defaults to 25, max 100." },
  offset: { type: "integer", minimum: 0, description: "The pagination offset. Defaults to 0." },
};

/** A line diff (LCS), as a unified diff without hunks: enough for an assistant to see what changed. */
function diff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) return `- (${a.length} lines)\n+ (${b.length} lines)\n(too long to compare line by line)`;
  const m = a.length;
  const n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j < n && (i === m || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+${b[j++]}`);
    else out.push(`-${a[i++]}`);
  }
  // Only the changes, with two lines of context around each.
  const keep = new Set<number>();
  out.forEach((l, k) => {
    if (l[0] !== " ") for (let d = -2; d <= 2; d++) keep.add(k + d);
  });
  if (!keep.size) return "(no changes)";
  const lines: string[] = [];
  let last = -1;
  out.forEach((l, k) => {
    if (!keep.has(k)) return;
    if (last !== -1 && k !== last + 1) lines.push("@@");
    lines.push(l);
    last = k;
  });
  return lines.join("\n");
}

const TOOLS: Record<string, Tool> = {
  list_documents: {
    description:
      "Searches documents the user has access to. Performs full-text search across document content when a query is provided, or lists recent documents when no query is given. Archived documents are excluded unless includeArchived is set. Optionally filter by collection. To retrieve the full contents or hierarchy of a specific collection, use list_collection_documents instead.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A search query to find documents by content or title. When omitted, returns recent documents." },
        collectionId: { type: "string", description: "A collection ID to filter documents by." },
        includeArchived: { type: "boolean", description: "Whether to include archived documents in the results. Defaults to false." },
        ...limitProps,
      },
    },
    readOnly: true,
    run: async (a, ctx) => {
      const statusFilter = bool(a, "includeArchived") ? ["published", "archived"] : undefined;
      const query = str(a, "query");
      if (query) {
        const results = (await dataOf(ctx, "documents.search", { query, collectionId: str(a, "collectionId"), statusFilter, ...pageArgs(a) })) as Data[];
        return results.map((r) => ({ ...docSummary(ctx, r.document), context: r.context }));
      }
      const docs = (await dataOf(ctx, "documents.list", { collectionId: str(a, "collectionId"), statusFilter, sort: "updatedAt", direction: "DESC", ...pageArgs(a) })) as Data[];
      return docs.map((d) => docSummary(ctx, d));
    },
  },

  list_collections: {
    description: "Lists all collections the authenticated user has access to. Returns a summary of each collection.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "An optional search query to filter collections by name." }, ...limitProps } },
    readOnly: true,
    run: async (a, ctx) => {
      const query = str(a, "query")?.toLowerCase();
      const cols = (await dataOf(ctx, "collections.list", query ? { limit: 100 } : pageArgs(a))) as Data[];
      return cols.filter((c) => !query || String(c.name).toLowerCase().includes(query)).map((c) => collectionSummary(ctx, c));
    },
  },

  list_collection_documents: {
    description:
      "Returns the complete hierarchical tree of published documents in a collection, including nested sub-documents. Use this to enumerate every document in a collection or to understand parent/child relationships. Drafts and archived documents are not included.",
    inputSchema: { type: "object", properties: { collectionId: { type: "string", description: "The ID of the collection whose document tree to return." } }, required: ["collectionId"] },
    readOnly: true,
    run: async (a, ctx) => {
      const tree = (await dataOf(ctx, "collections.documents", { id: idOf(need(a, "collectionId")) })) as Data[];
      const walk = (nodes: Data[]): Data[] => nodes.map((n) => ({ id: n.id, title: n.title, url: absolute(ctx, n.url), children: walk(n.children ?? []) }));
      return walk(tree);
    },
  },

  fetch: {
    description:
      'Fetches a document, collection, user, attachment, or template by type and ID. When fetching a collection the response includes the full hierarchical document tree. For users, "current_user" can be used as the ID to get the authenticated user. For attachments, the response includes a URL to download the file. For templates, the response includes the template body as markdown.',
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: ["document", "collection", "user", "attachment", "template"], description: "The resource to fetch." },
        id: { type: "string", description: 'The unique identifier or URL. For users, "current_user" returns the authenticated user.' },
      },
      required: ["resource", "id"],
    },
    readOnly: true,
    run: async (a, ctx) => {
      const id = idOf(need(a, "id"));
      switch (str(a, "resource")) {
        case "document":
          return docFull(ctx, await dataOf(ctx, "documents.info", { id }));
        case "collection": {
          const col = await dataOf(ctx, "collections.info", { id });
          const tree = (await dataOf(ctx, "collections.documents", { id: col.id })) as Data[];
          const walk = (nodes: Data[]): Data[] => nodes.map((n) => ({ id: n.id, title: n.title, url: absolute(ctx, n.url), children: walk(n.children ?? []) }));
          return { ...collectionSummary(ctx, col), documents: walk(tree) };
        }
        case "user":
          return userSummary(await dataOf(ctx, "users.info", id === "current_user" ? {} : { id }));
        case "attachment": {
          const attachmentId = id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
          if (!attachmentId) throw new ToolError("Give the attachment's id or its /api/attachments.redirect?id=… link");
          return { id: attachmentId, url: `${ctx.base}/api/attachments.redirect?id=${attachmentId}`, note: "Download it with the same Authorization header." };
        }
        case "template": {
          const t = await dataOf(ctx, "templates.info", { id });
          return { id: t.id, title: t.title, icon: t.icon, color: t.color, collectionId: t.collectionId, text: t.text };
        }
        default:
          throw new ToolError("resource must be one of document, collection, user, attachment, template");
      }
    },
  },

  list_templates: {
    description: "Lists the templates the user can use, with each template's body as markdown, to pass as templateId to create_document.",
    inputSchema: { type: "object", properties: { collectionId: { type: "string", description: "Only the templates of this collection." }, ...limitProps } },
    readOnly: true,
    run: async (a, ctx) => {
      const ts = (await dataOf(ctx, "templates.list", { collectionId: str(a, "collectionId"), ...pageArgs(a) })) as Data[];
      return ts.map((t) => ({ id: t.id, title: t.title, collectionId: t.collectionId, text: t.text }));
    },
  },

  list_users: {
    description: "Lists the people in the workspace, to find their IDs for mentions (@[Name](mention://user/userId)).",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Filter by name or email." }, ...limitProps } },
    readOnly: true,
    run: async (a, ctx) => ((await dataOf(ctx, "users.list", { query: str(a, "query"), ...pageArgs(a) })) as Data[]).map(userSummary),
  },

  create_document: {
    description:
      "Creates a new document from markdown. Requires a collectionId to place the document in a collection, or parentDocumentId to nest it under an existing document. Pass a templateId (from list_templates) to pre-fill the document from a template; the template's content is used unless text is also provided.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title of the document. Defaults to the template's title when a templateId is provided." },
        text: { type: "string", description: "The content of the document, as markdown. Don't start it with the title as a heading." },
        format: { type: "string", enum: ["markdown"], description: 'The format of the text content: "markdown".' },
        collectionId: { type: "string", description: "The collection to place the document in." },
        parentDocumentId: { type: "string", description: "The parent document ID to nest this document under." },
        templateId: { type: "string", description: "The ID of a template to pre-fill the new document from." },
        publish: { type: "boolean", description: "Whether to publish the document. Defaults to true. Set to false to create as a draft." },
        icon: { type: "string", description: "An emoji for the document." },
        color: { type: "string", description: "The hex color for the document icon, e.g. #FF0000." },
        fullWidth: { type: "boolean", description: "Whether the document should occupy full width of the screen. Defaults to false." },
      },
    },
    run: async (a, ctx) => {
      if (a.format === "html") throw new ToolError("Send the content as markdown (format: markdown)");
      const parent = str(a, "parentDocumentId");
      const collectionId = collectionArg(str(a, "collectionId"));
      if (!parent && !collectionId) throw new ToolError("collectionId or parentDocumentId is required");
      const d = await dataOf(ctx, "documents.create", {
        title: str(a, "title"),
        text: typeof a.text === "string" ? a.text : undefined,
        collectionId: collectionId && idOf(collectionId),
        parentDocumentId: parent && idOf(parent),
        templateId: str(a, "templateId"),
        publish: bool(a, "publish") ?? true,
        icon: str(a, "icon"),
        color: str(a, "color"),
        fullWidth: bool(a, "fullWidth"),
      });
      return docFull(ctx, d);
    },
  },

  update_document: {
    description:
      'Updates an existing document by its ID. Only the fields provided will be updated. When editing an existing document\'s content, prefer editMode "patch" with findText and text: it replaces only the matched section and keeps the rest of the document as it is.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The unique identifier of the document to update." },
        title: { type: "string", description: "The new title for the document." },
        text: { type: "string", description: 'The markdown content to apply. In "patch" mode, the replacement for findText.' },
        editMode: { type: "string", enum: ["replace", "append", "prepend", "patch"], description: '"replace" (default) replaces the whole content, "append"/"prepend" add to the end/beginning, "patch" replaces the first occurrence of findText.' },
        findText: { type: "string", description: 'Required when editMode is "patch": the exact markdown to find, copied from the document.' },
        publish: { type: "boolean", description: "Set to true to publish a draft document." },
        collectionId: { type: "string", description: "The collection to publish a draft to, when it has none." },
        icon: { type: ["string", "null"], description: "An emoji for the document. Set to null to remove." },
        color: { type: ["string", "null"], description: "The hex color for the document icon. Set to null to remove." },
        fullWidth: { type: "boolean", description: "Whether the document should occupy full width of the screen." },
      },
      required: ["id"],
    },
    run: async (a, ctx) => {
      const id = idOf(need(a, "id"));
      const params: Args = { id, title: str(a, "title"), publish: bool(a, "publish"), collectionId: collectionArg(str(a, "collectionId")), fullWidth: bool(a, "fullWidth") };
      if (a.icon !== undefined) params.icon = a.icon;
      if (a.color !== undefined) params.color = a.color;
      if (typeof a.text === "string") {
        const mode = str(a, "editMode") ?? "replace";
        if (mode === "replace") params.text = a.text;
        else if (mode === "append") Object.assign(params, { text: a.text, append: true });
        else {
          const current = String((await dataOf(ctx, "documents.info", { id })).text ?? "");
          if (mode === "prepend") params.text = `${a.text}\n\n${current}`;
          else if (mode === "patch") {
            const find = typeof a.findText === "string" ? a.findText : "";
            if (!find) throw new ToolError('findText is required when editMode is "patch"');
            const at = current.indexOf(find);
            if (at === -1) throw new ToolError("findText wasn't found in the document: fetch it again and copy the markdown exactly");
            params.text = current.slice(0, at) + a.text + current.slice(at + find.length);
          } else throw new ToolError("editMode must be replace, append, prepend or patch");
        }
      }
      return docFull(ctx, await dataOf(ctx, "documents.update", params));
    },
  },

  move_document: {
    description:
      "Moves a document to a different location or reorders it within its current parent. Provide a collectionId to move to the root of a collection, a parentDocumentId to nest under another document, and/or an index to control position among siblings.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The unique identifier of the document to move." },
        collectionId: { type: "string", description: "The destination collection ID. Required if parentDocumentId is not provided." },
        parentDocumentId: { type: "string", description: "The ID of the document to nest this document under." },
        index: { type: "integer", minimum: 0, description: "The zero-based position among its siblings. Omit to place at the end." },
      },
      required: ["id"],
    },
    run: async (a, ctx) => {
      const id = idOf(need(a, "id"));
      const parent = str(a, "parentDocumentId");
      let collectionId = collectionArg(str(a, "collectionId"));
      if (parent && !collectionId) collectionId = (await dataOf(ctx, "documents.info", { id: idOf(parent) })).collectionId;
      if (!collectionId) collectionId = (await dataOf(ctx, "documents.info", { id })).collectionId;
      await call(ctx, "documents.move", { id, collectionId, parentDocumentId: parent ? idOf(parent) : null, index: num(a, "index") });
      return docSummary(ctx, await dataOf(ctx, "documents.info", { id }));
    },
  },

  delete_document: {
    description: "Moves a document to the trash, where it can be restored with restore_document for 30 days.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The unique identifier of the document to delete." } }, required: ["id"] },
    destructive: true,
    run: async (a, ctx) => {
      await call(ctx, "documents.delete", { id: idOf(need(a, "id")) });
      return { success: true, note: "The document is in the trash." };
    },
  },

  restore_document: {
    description: "Restores a deleted (trashed) or archived document.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The unique identifier of the document to restore." }, collectionId: { type: "string", description: "The collection to restore it to, if its own is gone." } },
      required: ["id"],
    },
    run: async (a, ctx) => docSummary(ctx, await dataOf(ctx, "documents.restore", { id: idOf(need(a, "id")), collectionId: str(a, "collectionId") })),
  },

  get_document_changes: {
    description:
      'Shows what changed in a document between two points in its history, and who changed it. Returns the revisions in the range with their authors, followed by a diff of the document markdown. Lines starting with "-" were removed and lines starting with "+" were added.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The unique identifier of the document." },
        from: { type: "string", description: 'Where the changes start: a revision ID, an ISO 8601 date or timestamp, or "my_last_edit".' },
        to: { type: "string", description: "A revision ID where the changes end. Defaults to the current document." },
      },
      required: ["id", "from"],
    },
    readOnly: true,
    run: async (a, ctx) => {
      const doc = await dataOf(ctx, "documents.info", { id: idOf(need(a, "id")) });
      const revisions = (await dataOf(ctx, "revisions.list", { documentId: doc.id, limit: 100, direction: "DESC" })) as Data[];
      const from = need(a, "from");
      let start: Data | undefined;
      if (/^[0-9a-f-]{36}$/i.test(from)) start = revisions.find((r) => r.id === from);
      else if (from === "my_last_edit") start = revisions.find((r) => r.createdById === ctx.caller.user.id || r.collaborators?.some((u: Data) => u.id === ctx.caller.user.id));
      else {
        const when = new Date(from);
        if (Number.isNaN(when.getTime())) throw new ToolError('from must be a revision ID, a date or "my_last_edit"');
        start = revisions.find((r) => new Date(r.createdAt) <= when);
      }
      const to = str(a, "to");
      const endText = to ? String((await dataOf(ctx, "revisions.info", { id: to })).text ?? "") : String(doc.text ?? "");
      const startText = start ? String((await dataOf(ctx, "revisions.info", { id: start.id })).text ?? "") : "";
      const startAt = start ? new Date(start.createdAt).getTime() : 0;
      const endAt = to ? new Date(revisions.find((r) => r.id === to)?.createdAt ?? Date.now()).getTime() : Date.now();
      const between = revisions.filter((r) => new Date(r.createdAt).getTime() > startAt && new Date(r.createdAt).getTime() <= endAt);
      return {
        from: start ? { revisionId: start.id, createdAt: start.createdAt } : { note: "No revision that early: compared with an empty document" },
        to: to ? { revisionId: to } : { current: true, updatedAt: doc.updatedAt },
        revisions: between.map((r) => ({ id: r.id, createdAt: r.createdAt, by: (r.collaborators as Data[] | undefined)?.map((u) => u.name) ?? [r.createdBy?.name] })),
        diff: diff(startText, endText),
      };
    },
  },

  create_collection: {
    description: "Creates a new collection.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the collection." },
        description: { type: "string", description: "A markdown description." },
        icon: { type: "string", description: "An emoji or icon name." },
        color: { type: "string", description: "The hex color of the icon." },
        permission: { type: ["string", "null"], enum: ["read", "read_write", null], description: "What everyone in the workspace may do; null for only members." },
      },
      required: ["name"],
    },
    run: async (a, ctx) =>
      collectionSummary(ctx, await dataOf(ctx, "collections.create", { name: need(a, "name"), description: str(a, "description"), icon: str(a, "icon"), color: str(a, "color"), permission: a.permission })),
  },

  update_collection: {
    description: "Updates a collection's name, description, icon, color or workspace-wide permission.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The collection's ID." },
        name: { type: "string" },
        description: { type: "string", description: "A markdown description." },
        icon: { type: ["string", "null"] },
        color: { type: ["string", "null"] },
        permission: { type: ["string", "null"], enum: ["read", "read_write", null] },
      },
      required: ["id"],
    },
    run: async (a, ctx) => {
      const params: Args = { id: idOf(need(a, "id")), name: str(a, "name"), description: typeof a.description === "string" ? a.description : undefined };
      for (const k of ["icon", "color", "permission"]) if (a[k] !== undefined) params[k] = a[k];
      return collectionSummary(ctx, await dataOf(ctx, "collections.update", params));
    },
  },

  delete_collection: {
    description: "Deletes a collection and moves its documents to the trash.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The collection's ID." } }, required: ["id"] },
    destructive: true,
    run: async (a, ctx) => {
      await call(ctx, "collections.delete", { id: idOf(need(a, "id")) });
      return { success: true };
    },
  },

  list_comments: {
    description: "Lists comments the user has access to. Requires at least one of documentId or collectionId. Optionally filter by parent comment or resolution status.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID to list comments for." },
        collectionId: { type: "string", description: "The collection ID to list comments for." },
        parentCommentId: { type: "string", description: "A parent comment ID to list only the replies in that thread." },
        statusFilter: { type: "array", items: { type: "string", enum: ["resolved", "unresolved"] }, description: "Filter by resolution status." },
        ...limitProps,
      },
    },
    readOnly: true,
    run: async (a, ctx) => {
      const documentId = str(a, "documentId");
      const collectionId = str(a, "collectionId");
      if (!documentId && !collectionId) throw new ToolError("documentId or collectionId is required");
      const comments = (await dataOf(ctx, "comments.list", {
        documentId: documentId && idOf(documentId),
        collectionId,
        parentCommentId: str(a, "parentCommentId"),
        statusFilter: Array.isArray(a.statusFilter) ? a.statusFilter : undefined,
        ...pageArgs(a),
      })) as Data[];
      return comments.map(commentSummary);
    },
  },

  create_comment: {
    description: "Creates a new comment on a document, as markdown. Optionally a reply under an existing top-level comment.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID to comment on." },
        text: { type: "string", description: "The markdown text content of the comment." },
        parentCommentId: { type: "string", description: "The ID of a top-level comment to reply to." },
        anchorText: { type: "string", description: "Not supported here: the comment is added to the whole document." },
      },
      required: ["documentId", "text"],
    },
    run: async (a, ctx) => {
      const c = await dataOf(ctx, "comments.create", { documentId: idOf(need(a, "documentId")), text: need(a, "text"), parentCommentId: str(a, "parentCommentId") });
      return { ...commentSummary(c), ...(str(a, "anchorText") ? { note: "Added as a comment on the whole document (inline anchors aren't supported by this server)." } : {}) };
    },
  },

  update_comment: {
    description: "Changes a comment's text, or resolves or reopens a thread.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string", description: "The new markdown text." }, resolved: { type: "boolean", description: "true resolves the thread, false reopens it." } },
      required: ["id"],
    },
    run: async (a, ctx) => {
      const id = need(a, "id");
      let c: Data | undefined;
      if (str(a, "text")) c = await dataOf(ctx, "comments.update", { id, text: str(a, "text") });
      const resolved = bool(a, "resolved");
      if (resolved !== undefined) c = await dataOf(ctx, resolved ? "comments.resolve" : "comments.unresolve", { id });
      return commentSummary(c ?? (await dataOf(ctx, "comments.info", { id })));
    },
  },

  delete_comment: {
    description: "Deletes a comment (and its replies, for a top-level comment).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    destructive: true,
    run: async (a, ctx) => {
      await call(ctx, "comments.delete", { id: need(a, "id") });
      return { success: true };
    },
  },
};

const INSTRUCTIONS =
  "This is a knowledge base (Outline-compatible). Find documents with list_documents (search) and list_collections, read them with fetch, and edit with update_document in patch mode. Document content is markdown; don't start a document's text with its title. Mention people with @[Name](mention://user/userId) (list_users for ids). Link documents with their url.";

// ---------- The protocol (JSON-RPC 2.0 over Streamable HTTP, stateless) ----------

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function handle(req: RpcRequest, ctx: Ctx): Promise<unknown> {
  const params = req.params ?? {};
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "outline", title: ctx.c.get("team").name, version: APP_VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
        })),
      };
    case "tools/call": {
      const name = String(params.name);
      const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
      if (!tool) throw new RpcError(-32602, `Unknown tool ${name}`);
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Args) : {};
      try {
        const result = await tool.run(args, ctx);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
        throw e;
      }
    }
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new RpcError(-32601, `Method not found: ${req.method}`);
  }
}

async function answer(msg: unknown, ctx: Ctx) {
  const req = msg as RpcRequest;
  const isRequest = !!req && typeof req === "object" && req.id !== undefined && req.id !== null;
  if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return { jsonrpc: "2.0", id: isRequest ? req.id : null, error: { code: -32600, message: "Invalid request" } };
  }
  if (!isRequest) return null;
  try {
    return { jsonrpc: "2.0", id: req.id, result: await handle(req, ctx) };
  } catch (e) {
    if (e instanceof RpcError) return { jsonrpc: "2.0", id: req.id, error: { code: e.code, message: e.message } };
    console.error("MCP:", e);
    return { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "Internal error" } };
  }
}

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.post("/", async (c) => {
  rateLimit(c, "mcp", 3000, 60 * 60_000);
  const team = c.get("team");
  const base = teamUrl(team);
  if ((team.preferences as Record<string, unknown> | null)?.mcp === false) return c.json({ ok: false, error: "authorization_error", message: "MCP is switched off for this workspace" }, 403);
  const challenge = () => {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    return c.json({ ok: false, error: "authentication_required", status: 401, message: "Connect with OAuth, or send an API key as Authorization: Bearer ol_api_…" }, 401);
  };
  // Bearer only: a cookie session would need the CSRF check, and no MCP client has one.
  if (!c.req.header("Authorization")) return challenge();
  const caller = await identify(c).catch(() => null);
  if (!caller) return challenge();

  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const ctx: Ctx = { c, caller, base };
  const responses = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => answer(m, ctx)))).filter((r) => r !== null);
  if (!responses.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? responses : responses[0]);
});
// No server-initiated streams in this stateless server.
mcpRoutes.get("/", (c) => c.body(null, 405, { Allow: "POST" }));
mcpRoutes.delete("/", (c) => c.body(null, 405, { Allow: "POST" }));
