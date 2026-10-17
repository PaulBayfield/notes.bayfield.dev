// Outline API client. Every method is a POST to /api/<method> with a JSON body.
// Desktop calls go through the Rust proxy (see platform.ts); web calls use the browser's
// Outline session cookie plus the CSRF header Outline requires for cookie-authenticated writes.

import { apiBase, isTauri } from "./platform";
import { EDITOR_VERSION } from "../editor/schema";
import { demoCall, isDemo } from "./demo";

export interface User {
  id: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  email?: string;
}

export interface Team {
  id: string;
  name: string;
  avatarUrl: string | null;
  url: string;
}

export interface Collection {
  id: string;
  urlId: string;
  name: string;
  color: string | null;
  icon: string | null;
  index: string;
  permission?: string | null;
  sort?: { field: string; direction: "asc" | "desc" };
}

/** A node of a collection's document tree (`collections.documents`). */
export interface NavNode {
  id: string;
  title: string;
  url: string;
  icon?: string | null;
  color?: string | null;
  children: NavNode[];
}

export interface Doc {
  id: string;
  urlId: string;
  url: string;
  title: string;
  icon: string | null;
  color: string | null;
  collectionId: string | null;
  parentDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  archivedAt: string | null;
  deletedAt?: string | null;
  fullWidth?: boolean;
  insightsEnabled?: boolean;
  preferences?: { headingPrefix?: string } | null;
  createdBy?: User;
  updatedBy?: User;
  revision?: number;
  text?: string;
}

export interface Policy {
  id: string;
  abilities: Record<string, unknown>;
}

export interface Star {
  id: string;
  documentId: string | null;
  collectionId: string | null;
  index: string;
}

export interface SearchHit {
  context: string;
  ranking: number;
  document: Doc;
}

export interface AuthInfo {
  user: User;
  team: Team;
  collaborationToken?: string;
}

export interface Envelope<T> {
  data: T;
  policies?: Policy[];
  pagination?: { limit: number; offset: number; total?: number };
}

export class AuthError extends Error {
  constructor() {
    super("Signed out");
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The server's origin, e.g. https://notes.bayfield.dev. */
let server = isTauri ? "" : location.origin;
export const getServer = () => server;
export const setServer = (url: string) => {
  server = url.replace(/\/+$/, "");
};

function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/**
 * Web only: Outline sets its CSRF cookie on page loads, which never happen when the app is
 * opened directly. Any GET to Outline sets it.
 */
export async function ensureCsrfCookie() {
  if (isTauri || readCookie("__Host-csrfToken") || readCookie("csrfToken")) return;
  await fetch("/robots.txt", { credentials: "same-origin" }).catch(() => {});
}

/** Web only: the header Outline wants on cookie-authenticated writes. */
function csrfHeader(): Record<string, string> {
  const csrf = readCookie("__Host-csrfToken") ?? readCookie("csrfToken");
  return csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {};
}

export async function call<T>(method: string, body: object = {}): Promise<Envelope<T>> {
  if (isDemo) {
    try {
      return (await demoCall(method, body as Record<string, unknown>)) as Envelope<T>;
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : String(e), (e as { status?: number }).status ?? 500);
    }
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "x-editor-version": EDITOR_VERSION,
  };
  if (!isTauri) Object.assign(headers, csrfHeader());
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (res.status === 401) throw new AuthError();
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json?.message || json?.error || `${method} failed (${res.status})`, res.status);
  return json as Envelope<T>;
}

/**
 * Whether a response's `policies` grant an ability on an object. Outline answers either a
 * boolean or, when access comes from memberships (collection, group…), the list of their ids.
 */
export function can(env: Envelope<unknown>, id: string, ability: string): boolean {
  const value = abilities(env, id)[ability];
  return value === true || (Array.isArray(value) && value.length > 0);
}

/** Abilities of one object, from a response's `policies`. */
export function abilities(env: Envelope<unknown>, id: string): Record<string, unknown> {
  return env.policies?.find((p) => p.id === id)?.abilities ?? {};
}

// ---------- Endpoints ----------

export const authInfo = () => call<AuthInfo>("auth.info");

export const listCollections = () => call<Collection[]>("collections.list", { limit: 100 }).then((r) => r.data);

export const collectionTree = (id: string) => call<NavNode[]>("collections.documents", { id }).then((r) => r.data);

export const collectionInfo = (id: string) => call<Collection & { description?: string }>("collections.info", { id });

export const documentInfo = (id: string) => call<Doc>("documents.info", { id });

export const recentlyUpdated = (limit = 25) =>
  call<Doc[]>("documents.list", { sort: "updatedAt", direction: "DESC", limit }).then((r) => r.data);

export const recentlyViewed = (limit = 10) => call<Doc[]>("documents.viewed", { limit }).then((r) => r.data);

export const drafts = (limit = 25) => call<Doc[]>("documents.drafts", { limit }).then((r) => r.data);

export const listStars = () => call<{ stars: Star[]; documents: Doc[] }>("stars.list", { limit: 100 }).then((r) => r.data);

export const star = (documentId: string) => call<Star>("stars.create", { documentId }).then((r) => r.data);

export const unstar = (id: string) => call("stars.delete", { id });

export const searchTitles = (query: string, limit = 8) =>
  call<Doc[]>("documents.search_titles", { query, limit }).then((r) => r.data);

export const search = (query: string, limit = 12) =>
  call<SearchHit[]>("documents.search", { query, limit }).then((r) => r.data);

export const createDocument = (input: { title?: string; collectionId?: string | null; parentDocumentId?: string | null }) =>
  call<Doc>("documents.create", { title: "", publish: true, ...input }).then((r) => r.data);

export const updateDocument = (id: string, patch: { title?: string; icon?: string | null; color?: string | null; fullWidth?: boolean }) =>
  call<Doc>("documents.update", { id, ...patch }).then((r) => r.data);

export const publishDocument = (id: string, collectionId: string) =>
  call<Doc>("documents.update", { id, collectionId, publish: true }).then((r) => r.data);

export const deleteDocument = (id: string) => call("documents.delete", { id });

export const archiveDocument = (id: string) => call("documents.archive", { id });

export const restoreDocument = (id: string) => call("documents.restore", { id });

export const moveDocument = (id: string, collectionId: string, parentDocumentId: string | null, index?: number) =>
  call("documents.move", { id, collectionId, parentDocumentId, index });

export const duplicateDocument = (id: string) => call<{ documents: Doc[] }>("documents.duplicate", { id, publish: true });

export const listUsers = (query: string, limit = 8) =>
  call<User[]>("users.list", { query, limit, filter: "active" }).then((r) => r.data);

export interface Attachment {
  id: string;
  url: string;
  name: string;
  size: number;
  contentType: string;
}

/** Uploads a file as an attachment of a document; returns the URL to put in the document. */
export async function uploadAttachment(documentId: string, file: File): Promise<Attachment> {
  const contentType = file.type || "application/octet-stream";
  if (isTauri) {
    // The desktop app uploads from Rust: WebView2 drops file bodies sent to the notes:// proxy.
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Attachment>("upload_bytes", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-document-id": documentId, "x-file-name": encodeURIComponent(file.name || "file"), "x-content-type": file.type },
    });
  }
  const res = await call<{
    uploadUrl: string;
    form?: Record<string, string>;
    attachment: { id: string; url: string; name: string; size: number };
  }>("attachments.create", {
    documentId,
    name: file.name || "file",
    contentType,
    size: file.size,
    preset: "documentAttachment",
  });
  const data = res.data;
  const form = new FormData();
  for (const [k, v] of Object.entries(data.form ?? {})) form.append(k, v);
  form.append("file", file);
  // Local storage uploads to /api/files.create with the session (and its CSRF token); S3 to its own URL.
  const local = data.uploadUrl.startsWith("/");
  const post = await fetch(data.uploadUrl, {
    method: "POST",
    body: form,
    headers: local ? csrfHeader() : undefined,
    credentials: local ? "same-origin" : "omit",
  }).catch(() => {
    throw new ApiError("Couldn't reach the server. Check your connection.", 0);
  });
  if (!post.ok) {
    const json = await post.json().catch(() => null);
    throw new ApiError(json?.message || `Upload failed (${post.status})`, post.status);
  }
  return { ...data.attachment, contentType };
}

/** Desktop: uploads a file picked with `pickFiles`, by path. */
export async function uploadAttachmentFromPath(documentId: string, path: string): Promise<Attachment> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Attachment>("upload_file", { documentId, path });
}

// ---------- URLs ----------

/** A URL the webview can load for an attachment or other server path. */
export function resolveUrl(src: string | null | undefined): string {
  if (!src) return "";
  if (src.startsWith("/api/")) return `${apiBase}${src}`;
  if (server && src.startsWith(`${server}/api/`)) return `${apiBase}${src.slice(server.length)}`;
  return src;
}

/** The document a link points to, if it's an internal one ("/doc/title-AbCdEf1234"). */
export function docIdFromHref(href: string): string | null {
  let path = href;
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      if (u.origin !== server) return null;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const m = path.match(/^\/doc\/(?:[^/?#]*-)?([a-zA-Z0-9]{10})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

/** Link to a document in Outline's own web app. */
export const webUrl = (path: string) => `${server}${path}`;

// ---------- Comments ----------

/** ProseMirror JSON of a comment's body. */
export interface RichText {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: RichText[];
}

export interface Comment {
  id: string;
  documentId: string;
  parentCommentId: string | null;
  data: RichText;
  createdBy: User;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: User | null;
}

export async function listComments(documentId: string): Promise<Comment[]> {
  const out: Comment[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await call<Comment[]>("comments.list", { documentId, limit: 100, offset, sort: "createdAt", direction: "ASC" });
    out.push(...page.data);
    if (page.data.length < 100) return out;
  }
}

export const createComment = (input: { id: string; documentId: string; text: string; parentCommentId?: string }) =>
  call<Comment>("comments.create", input).then((r) => r.data);

export const updateComment = (id: string, text: string) => call<Comment>("comments.update", { id, text }).then((r) => r.data);

export const deleteComment = (id: string) => call("comments.delete", { id });

export const resolveComment = (id: string) => call<Comment>("comments.resolve", { id }).then((r) => r.data);

export const unresolveComment = (id: string) => call<Comment>("comments.unresolve", { id }).then((r) => r.data);

/** A comment body as plain text (paragraphs on their own lines, mentions as "@name"). */
export function richTextToPlain(node: RichText): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "mention") return node.attrs?.type === "user" ? `@${node.attrs?.label}` : String(node.attrs?.label ?? "");
  if (node.type === "br") return "\n";
  if (node.type === "emoji") return `:${node.attrs?.["data-name"]}:`;
  const inner = (node.content ?? []).map(richTextToPlain);
  return node.type === "doc" || node.type.endsWith("_list") ? inner.join("\n") : inner.join("");
}

// ---------- Collections ----------

export type CollectionPermission = "read_write" | "read" | null;

export interface CollectionDetails extends Collection {
  description?: string | null;
  /** The overview page, as ProseMirror JSON. */
  data?: RichText | null;
}

export const collectionDetails = (id: string) => call<CollectionDetails>("collections.info", { id });

export const createCollection = (input: { name: string; icon?: string | null; color?: string | null; permission?: CollectionPermission }) =>
  call<Collection>("collections.create", { sharing: true, ...input }).then((r) => r.data);

export const updateCollection = (id: string, patch: { name?: string; icon?: string | null; color?: string | null; permission?: CollectionPermission; data?: RichText }) =>
  call<CollectionDetails>("collections.update", { id, ...patch }).then((r) => r.data);

export const moveCollection = (id: string, index: string) => call<Collection>("collections.move", { id, index }).then((r) => r.data);

export const deleteCollection = (id: string) => call("collections.delete", { id });

export const archiveCollection = (id: string) => call("collections.archive", { id });

export const starCollection = (collectionId: string) => call("stars.create", { collectionId });

// ---------- More document actions ----------

export interface Subscription {
  id: string;
}

/** The current user's subscription to a document's changes, if any. */
export const documentSubscription = (documentId: string) =>
  call<Subscription>("subscriptions.info", { documentId, event: "documents.update" })
    .then((r) => r.data)
    .catch(() => null);

export const subscribe = (documentId: string) => call<Subscription>("subscriptions.create", { documentId, event: "documents.update" }).then((r) => r.data);

export const unsubscribe = (id: string) => call("subscriptions.delete", { id });

export const templatizeDocument = (id: string) => call<Doc>("documents.templatize", { id, publish: true }).then((r) => r.data);

export const unpublishDocument = (id: string) => call<Doc>("documents.unpublish", { id }).then((r) => r.data);

/** The document as Markdown. */
export const exportMarkdown = (id: string) => call<string>("documents.export", { id }).then((r) => r.data);

export const updateDocumentSettings = (id: string, patch: { fullWidth?: boolean; insightsEnabled?: boolean; preferences?: { headingPrefix?: string } }) =>
  call<Doc>("documents.update", { id, ...patch }).then((r) => r.data);

export interface Pin {
  id: string;
  documentId: string;
  collectionId: string | null;
  index: string;
}

export const listPins = (collectionId?: string) =>
  call<{ pins: Pin[]; documents: Doc[] }>("pins.list", { collectionId: collectionId ?? null, limit: 50 }).then((r) => r.data);

export const pin = (documentId: string, collectionId?: string | null) => call<Pin>("pins.create", { documentId, collectionId: collectionId ?? null }).then((r) => r.data);

export const unpin = (id: string) => call("pins.delete", { id });

export interface Revision {
  id: string;
  documentId: string;
  title: string;
  data?: RichText;
  createdAt: string;
  createdBy: User;
  collaborators?: User[];
  name?: string | null;
}

export const listRevisions = (documentId: string) => call<Revision[]>("revisions.list", { documentId, limit: 50 }).then((r) => r.data);

export const revisionInfo = (id: string) => call<Revision>("revisions.info", { id }).then((r) => r.data);

export const restoreRevision = (documentId: string, revisionId: string) => call<Doc>("documents.restore", { id: documentId, revisionId }).then((r) => r.data);

export interface View {
  id: string;
  count: number;
  firstViewedAt?: string;
  lastViewedAt?: string;
  user: User;
}

export const listViews = (documentId: string) => call<View[]>("views.list", { documentId }).then((r) => r.data);

export interface UserDetails extends User {
  role?: string;
  timezone?: string | null;
  lastActiveAt?: string | null;
}

const userCache = new Map<string, Promise<UserDetails>>();

/** Profile details (role, timezone…), cached for the session. */
export function userDetails(id: string): Promise<UserDetails> {
  let pending = userCache.get(id);
  if (!pending) {
    pending = call<UserDetails>("users.info", { id }).then((r) => r.data);
    pending.catch(() => userCache.delete(id));
    userCache.set(id, pending);
  }
  return pending;
}

/** Imports a file (Markdown, Word, HTML…) as a new document. */
export async function importDocument(file: File, collectionId: string, parentDocumentId?: string | null): Promise<Doc> {
  const form = new FormData();
  form.append("file", file);
  form.append("collectionId", collectionId);
  if (parentDocumentId) form.append("parentDocumentId", parentDocumentId);
  form.append("publish", "true");
  const headers: Record<string, string> = { accept: "application/json" };
  if (!isTauri) {
    const csrf = readCookie("__Host-csrfToken") ?? readCookie("csrfToken");
    if (csrf) headers["x-csrf-token"] = decodeURIComponent(csrf);
  }
  const res = await fetch(`${apiBase}/api/documents.import`, { method: "POST", body: form, headers, credentials: "same-origin" });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json?.message ?? "Import failed", res.status);
  return json.data as Doc;
}

// ---------- Drafts, archive, trash ----------

export const listDrafts = () => call<Doc[]>("documents.drafts", { limit: 100, sort: "updatedAt", direction: "DESC" }).then((r) => r.data);

// Outline can't sort by archivedAt / deletedAt, so those lists are sorted here.
const newestBy = (key: "archivedAt" | "deletedAt") => (docs: Doc[]) => docs.sort((x, y) => (y[key] ?? "").localeCompare(x[key] ?? ""));

export const listArchived = () => call<Doc[]>("documents.archived", { limit: 100, sort: "updatedAt", direction: "DESC" }).then((r) => newestBy("archivedAt")(r.data));

export const listDeleted = () => call<Doc[]>("documents.deleted", { limit: 100, sort: "updatedAt", direction: "DESC" }).then((r) => newestBy("deletedAt")(r.data));

/** Deletes for good (from the trash). */
export const destroyDocument = (id: string) => call("documents.delete", { id, permanent: true });

/** Deletes everything in the trash (workspace admins only). */
export const emptyTrash = () => call("documents.empty_trash");

// ---------- Sharing ----------

export type DocumentPermission = "read" | "read_write" | "admin";

export interface Membership {
  id: string;
  userId: string;
  documentId: string;
  permission: DocumentPermission;
}

/** People explicitly added to a document. */
export const documentMemberships = (id: string) =>
  call<{ memberships: Membership[]; users: User[] }>("documents.memberships", { id, limit: 100 }).then((r) => r.data);

/** Everyone who can open a document: its own members plus the collection's. */
export const documentUsers = (id: string) => call<User[]>("documents.users", { id, limit: 100 }).then((r) => r.data);

/** Adds someone to a document, or changes their permission. */
export const addDocumentUser = (id: string, userId: string, permission: DocumentPermission) => call("documents.add_user", { id, userId, permission });

export const removeDocumentUser = (id: string, userId: string) => call("documents.remove_user", { id, userId });

export interface Group {
  id: string;
  name: string;
  memberCount: number;
}

export interface GroupMembership {
  id: string;
  groupId: string;
  documentId: string;
  permission: DocumentPermission;
}

export const listGroups = (query: string, limit = 8) =>
  call<{ groups: Group[] }>("groups.list", { query, limit }).then((r) => r.data.groups);

/** Groups explicitly added to a document. */
export const documentGroupMemberships = (id: string) =>
  call<{ groupMemberships: GroupMembership[]; groups: Group[] }>("documents.group_memberships", { id, limit: 100 }).then((r) => r.data);

/** Adds a group to a document, or changes its permission. */
export const addDocumentGroup = (id: string, groupId: string, permission: DocumentPermission) => call("documents.add_group", { id, groupId, permission });

export const removeDocumentGroup = (id: string, groupId: string) => call("documents.remove_group", { id, groupId });

/**
 * Pages shared with me, directly or through one of my groups (Outline's "Shared with me"),
 * in the order Outline keeps them.
 */
export async function listSharedWithMe(): Promise<Doc[]> {
  const [mine, viaGroups] = await Promise.all([
    call<{ memberships: Membership[]; documents: Doc[] }>("userMemberships.list", { limit: 100 }).then((r) => r.data),
    call<{ groupMemberships: GroupMembership[]; documents: Doc[] }>("groupMemberships.list", { limit: 100 })
      .then((r) => r.data)
      .catch(() => ({ groupMemberships: [] as GroupMembership[], documents: [] as Doc[] })),
  ]);
  const ordered = [...mine.memberships.map((m) => m.documentId), ...viaGroups.groupMemberships.map((m) => m.documentId)];
  const docs = new Map([...viaGroups.documents, ...mine.documents].map((d) => [d.id, d]));
  return [...new Set(ordered)].flatMap((id) => docs.get(id) ?? []);
}

export interface Share {
  id: string;
  documentId: string | null;
  collectionId: string | null;
  published: boolean;
  url: string;
  includeChildDocuments: boolean;
  allowIndexing: boolean;
  sourceTitle?: string;
  views?: number;
}

/** The document's share link, and a parent's that also covers it. Null if none. */
export async function shareInfo(documentId: string): Promise<Share[]> {
  const res = await call<{ shares: Share[] } | undefined>("shares.info", { documentId }).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
  // Outline answers 204 with no body when nothing is shared.
  return res?.data?.shares ?? [];
}

export const createShare = (documentId: string) => call<Share>("shares.create", { documentId, published: true }).then((r) => r.data);

export const updateShare = (id: string, patch: { published?: boolean; includeChildDocuments?: boolean; allowIndexing?: boolean }) =>
  call<Share>("shares.update", { id, ...patch }).then((r) => r.data);
