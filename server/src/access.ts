// Who may read and edit what, worked out once per request (as Outline's policies do):
//
//  - a collection: workspace admins manage every collection; others get the collection's own access
//    for everyone (`permission`, not for guests), their membership, or a group's membership: the best;
//  - a document: its collection's access, or a membership on the document (given to its children too);
//    a draft is its author's (and whoever it was shared with); viewers only ever read.
//
// Permissions rank read < read_write < admin.

import { sql } from "./db.ts";
import type { UserRow } from "./users.ts";

export type Perm = "read" | "read_write" | "admin";
const RANK: Record<Perm, number> = { read: 1, read_write: 2, admin: 3 };
export const atLeast = (p: Perm | null | undefined, min: Perm) => !!p && RANK[p] >= RANK[min];
const best = (...ps: (Perm | null | undefined)[]): Perm | null => ps.reduce<Perm | null>((a, p) => (p && (!a || RANK[p] > RANK[a]) ? p : a), null);

export interface DocLike {
  id: string;
  collectionId: string | null;
  createdById: string | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  isTemplate: boolean;
}

export class Access {
  readonly user: UserRow;
  private collections = new Map<string, Perm>();
  private documents = new Map<string, Perm>();
  private constructor(user: UserRow) {
    this.user = user;
  }

  static async for(user: UserRow): Promise<Access> {
    const a = new Access(user);
    const admin = user.role === "admin";
    const guest = user.role === "guest";
    const rows = await sql<{ id: string; permission: Perm | null; userPerm: Perm | null; groupPerm: Perm | null }[]>`
      SELECT c.id, c.permission,
        (SELECT um.permission FROM user_memberships um WHERE um.collection_id = c.id AND um.user_id = ${user.id}) AS user_perm,
        (SELECT gm.permission FROM group_memberships gm JOIN group_users gu ON gu.group_id = gm.group_id
          WHERE gm.collection_id = c.id AND gu.user_id = ${user.id}
          ORDER BY CASE gm.permission WHEN 'admin' THEN 3 WHEN 'read_write' THEN 2 ELSE 1 END DESC LIMIT 1) AS group_perm
      FROM collections c WHERE c.team_id = ${user.teamId} AND c.deleted_at IS NULL`;
    for (const r of rows) {
      const p = admin ? "admin" : best(guest ? null : r.permission, r.userPerm, r.groupPerm);
      if (p) a.collections.set(r.id, a.cap(p));
    }
    // Memberships on documents reach the documents under them.
    const docs = await sql<{ id: string; permission: Perm }[]>`
      WITH RECURSIVE direct AS (
        SELECT document_id AS id, permission FROM user_memberships WHERE user_id = ${user.id} AND document_id IS NOT NULL
        UNION ALL
        SELECT gm.document_id, gm.permission FROM group_memberships gm JOIN group_users gu ON gu.group_id = gm.group_id
        WHERE gu.user_id = ${user.id} AND gm.document_id IS NOT NULL
      ), tree AS (
        SELECT id, permission FROM direct
        UNION SELECT d.id, t.permission FROM documents d JOIN tree t ON d.parent_document_id = t.id
      )
      SELECT id, permission FROM tree`;
    for (const d of docs) a.documents.set(d.id, a.cap(best(a.documents.get(d.id), d.permission)!));
    return a;
  }

  /** Viewers read, whatever they were given. */
  private cap(p: Perm): Perm {
    return this.user.role === "viewer" ? "read" : p;
  }

  get isAdmin() {
    return this.user.role === "admin";
  }

  collection(id: string | null | undefined): Perm | null {
    return id ? (this.collections.get(id) ?? null) : null;
  }

  /** The collections the user can see. */
  readableCollections(): string[] {
    return [...this.collections.keys()];
  }

  /** Documents shared with the user directly (by membership, theirs or a group's). */
  sharedDocuments(): string[] {
    return [...this.documents.keys()];
  }

  /** The user's permission on a document (null: no access). */
  document(d: DocLike): Perm | null {
    const own = d.createdById === this.user.id;
    const membership = this.documents.get(d.id) ?? null;
    if (!d.publishedAt && !d.isTemplate) {
      // A draft: its author's, and whoever it was shared with.
      return own ? this.cap("admin") : membership;
    }
    const p = best(this.collection(d.collectionId), membership);
    if (d.deletedAt) return own || this.isAdmin || atLeast(p, "read_write") ? this.cap(p ?? "read_write") : null;
    return p;
  }

  /** SQL condition (on documents aliased `d`) for the documents the user may read. */
  readableFilter() {
    const cols = this.readableCollections();
    const shared = this.sharedDocuments();
    return sql`(
      (d.published_at IS NOT NULL OR d.is_template) AND (d.collection_id = ANY(${cols}::uuid[]) OR d.id = ANY(${shared}::uuid[]))
      OR (d.published_at IS NULL AND NOT d.is_template AND (d.created_by_id = ${this.user.id} OR d.id = ANY(${shared}::uuid[])))
    )`;
  }
}
