// Rows as the API answers them: Outline's JSON shapes, field for field.

import { PUBLIC_URL } from "./config.ts";
import { sql } from "./db.ts";
import { collectionUrl, documentUrl, tasksOf } from "./content.ts";
import type { TeamRow, UserRow } from "./users.ts";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * A person. Their email, preferences and notification settings only go to themselves and admins
 * (Outline's `includeDetails`).
 */
export function presentUser(u: UserRow, opts: { includeDetails?: boolean } = {}) {
  const out: Record<string, unknown> = {
    id: u.id,
    name: u.name,
    avatarUrl: u.avatarUrl,
    color: u.color,
    role: u.role,
    isSuspended: !!u.suspendedAt,
    createdAt: iso(u.createdAt),
    updatedAt: iso(u.updatedAt),
    deletedAt: iso(u.deletedAt),
    lastActiveAt: iso(u.lastActiveAt),
    timezone: u.timezone,
  };
  if (opts.includeDetails) {
    out.email = u.email;
    out.language = u.language;
    out.preferences = u.preferences;
    out.notificationSettings = u.notificationSettings;
  }
  return out;
}

export function presentTeam(t: TeamRow) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    avatarUrl: t.avatarUrl,
    sharing: t.sharing,
    memberCollectionCreate: t.memberCollectionCreate,
    memberTeamCreate: t.memberTeamCreate,
    defaultCollectionId: t.defaultCollectionId,
    documentEmbeds: t.documentEmbeds,
    guestSignin: t.guestSignin,
    subdomain: t.subdomain,
    domain: t.domain,
    url: PUBLIC_URL,
    defaultUserRole: t.defaultUserRole,
    inviteRequired: t.inviteRequired,
    allowedDomains: t.allowedDomains,
    preferences: t.preferences,
    passkeysEnabled: t.passkeysEnabled,
  };
}

// ---------- Content ----------

export interface CollectionRow {
  id: string;
  urlId: string;
  teamId: string;
  name: string;
  description: string | null;
  content: unknown;
  icon: string | null;
  color: string | null;
  index: string | null;
  permission: "read" | "read_write" | null;
  sharing: boolean;
  commenting: boolean | null;
  sort: { field: string; direction: string };
  templateManagement: string | null;
  documentStructure: unknown;
  createdById: string | null;
  archivedAt: Date | null;
  archivedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * A collection. API version 3 (x-api-version: 3) answers the overview as ProseMirror JSON (`data`);
 * earlier versions as Markdown (`description`), as Outline does.
 */
export function presentCollection(c: CollectionRow, apiVersion = 0, archivedBy?: UserRow | null) {
  const out: Record<string, unknown> = { id: c.id, url: collectionUrl(c), urlId: c.urlId, name: c.name };
  if (apiVersion >= 3) out.data = c.content ?? { type: "doc", content: [{ type: "paragraph" }] };
  else out.description = c.description ?? "";
  Object.assign(out, {
    sort: c.sort,
    icon: c.icon,
    color: c.color,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
    ...(archivedBy !== undefined ? { archivedBy: archivedBy ? presentUser(archivedBy) : null } : {}),
    index: c.index,
    sharing: c.sharing,
    commenting: c.commenting,
    templateManagement: c.templateManagement ?? "admin",
    permission: c.permission,
    ownerId: null,
    deletedAt: iso(c.deletedAt),
    archivedAt: iso(c.archivedAt),
    deprecatedReason: null,
  });
  return out;
}

export interface DocumentRow {
  id: string;
  urlId: string;
  teamId: string;
  collectionId: string | null;
  parentDocumentId: string | null;
  title: string;
  icon: string | null;
  color: string | null;
  text: string;
  content: unknown;
  fullWidth: boolean;
  insightsEnabled: boolean;
  preferences: Record<string, unknown> | null;
  isTemplate: boolean;
  templateId: string | null;
  sourceMetadata: Record<string, unknown> | null;
  createdById: string | null;
  lastModifiedById: string | null;
  collaboratorIds: string[];
  revisionCount: number;
  publishedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  deletedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** documents.viewed only. */
  lastViewedAt?: Date | null;
  /** Joined: when the collection was deleted. */
  collectionDeletedAt?: Date | null;
}

/** The document columns read back (everything but the Yjs state and the search vector). */
export const DOC_COLUMNS = sql`d.id, d.url_id, d.team_id, d.collection_id, d.parent_document_id, d.title, d.icon, d.color, d.text, d.content,
  d.full_width, d.insights_enabled, d.preferences, d.is_template, d.template_id, d.source_metadata, d.created_by_id, d.last_modified_by_id,
  d.collaborator_ids, d.revision_count, d.published_at, d.archived_at, d.deleted_at, d.deleted_by_id, d.created_at, d.updated_at,
  (SELECT c.deleted_at FROM collections c WHERE c.id = d.collection_id) AS collection_deleted_at`;

/** The users these rows mention, in one query. */
export async function usersById(ids: (string | null | undefined)[]): Promise<Map<string, UserRow>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await sql<UserRow[]>`SELECT * FROM users WHERE id = ANY(${unique}::uuid[])`;
  return new Map(rows.map((u) => [u.id, u]));
}

/** Documents as the API answers them (Outline's Document), their authors loaded in one go. */
export async function presentDocuments(rows: DocumentRow[], opts: { includeData?: boolean } = {}) {
  const users = await usersById(rows.flatMap((d) => [d.createdById, d.lastModifiedById, d.deletedById]));
  return rows.map((d) => presentDocument(d, users, opts));
}

export function presentDocument(d: DocumentRow, users: Map<string, UserRow>, opts: { includeData?: boolean } = {}) {
  const person = (id: string | null) => {
    const u = id ? users.get(id) : undefined;
    return u ? presentUser(u) : null;
  };
  const url = documentUrl(d);
  const out: Record<string, unknown> = { id: d.id, url, path: url, urlId: d.urlId, title: d.title, text: d.text };
  if (opts.includeData) out.data = d.content ?? { type: "doc", content: [{ type: "paragraph" }] };
  Object.assign(out, {
    icon: d.icon,
    color: d.color,
    tasks: tasksOf(d.content),
    language: null,
    createdAt: iso(d.createdAt),
    createdBy: person(d.createdById),
    updatedAt: iso(d.updatedAt),
    updatedBy: person(d.lastModifiedById ?? d.createdById),
    publishedAt: iso(d.publishedAt),
    archivedAt: iso(d.archivedAt),
    deprecatedReason: null,
    deletedAt: iso(d.deletedAt),
    ...(d.deletedAt ? { deletedBy: person(d.deletedById) } : {}),
    collaboratorIds: d.collaboratorIds,
    revision: d.revisionCount,
    fullWidth: d.fullWidth,
    preferences: d.preferences,
    collectionId: d.collectionId,
    parentDocumentId: d.parentDocumentId,
    ...(d.lastViewedAt !== undefined ? { lastViewedAt: iso(d.lastViewedAt) } : {}),
    isCollectionDeleted: !!d.collectionDeletedAt,
    ownerId: null,
    templateId: d.templateId,
    insightsEnabled: d.insightsEnabled,
    popularityScore: 0,
    ...(d.sourceMetadata ? { sourceMetadata: d.sourceMetadata } : {}),
  });
  if (d.isTemplate) out.template = true;
  return out;
}

export function presentStar(s: { id: string; documentId: string | null; collectionId: string | null; index: string | null; createdAt: Date; updatedAt: Date }) {
  return { id: s.id, documentId: s.documentId, collectionId: s.collectionId, index: s.index, createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt) };
}

export function presentPin(p: { id: string; documentId: string; collectionId: string | null; index: string | null; createdAt: Date; updatedAt: Date }) {
  return { id: p.id, documentId: p.documentId, collectionId: p.collectionId, index: p.index, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) };
}

export interface MembershipRow {
  id: string;
  userId?: string;
  groupId?: string;
  collectionId: string | null;
  documentId: string | null;
  permission: string;
  sourceId: string | null;
  index?: string | null;
  createdById: string | null;
  createdAt: Date;
}

export function presentMembership(m: MembershipRow) {
  return { id: m.id, userId: m.userId, documentId: m.documentId, collectionId: m.collectionId, permission: m.permission, createdById: m.createdById, sourceId: m.sourceId, index: m.index ?? null };
}

export function presentGroupMembership(m: MembershipRow) {
  return { id: m.id, groupId: m.groupId, documentId: m.documentId, collectionId: m.collectionId, permission: m.permission, sourceId: m.sourceId };
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  externalId: string | null;
  disableMentions: boolean;
  memberCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export function presentGroup(g: GroupRow) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    icon: g.icon,
    color: g.color,
    externalId: g.externalId,
    memberCount: g.memberCount ?? 0,
    disableMentions: g.disableMentions,
    createdAt: iso(g.createdAt),
    updatedAt: iso(g.updatedAt),
  };
}

export function presentRevision(r: { id: string; documentId: string; title: string; name: string | null; icon: string | null; color: string | null; collaboratorIds: string[]; sourceMetadata: unknown; userId: string | null; createdAt: Date; deletedAt: Date | null; content?: unknown; text?: string }, users: Map<string, UserRow>, opts: { includeData?: boolean } = {}) {
  const creator = r.userId ? users.get(r.userId) : undefined;
  return {
    id: r.id,
    documentId: r.documentId,
    title: r.title,
    name: r.name,
    icon: r.icon,
    color: r.color,
    ...(opts.includeData ? { data: r.content ?? { type: "doc", content: [] }, text: r.text ?? "" } : {}),
    collaborators: r.collaboratorIds.map((id) => users.get(id)).filter((u): u is UserRow => !!u).map((u) => presentUser(u)),
    sourceMetadata: r.sourceMetadata ?? null,
    createdAt: iso(r.createdAt),
    createdBy: creator ? presentUser(creator) : null,
    createdById: r.userId,
    deletedAt: iso(r.deletedAt),
  };
}
