// Lookups shared by the methods: a collection or a document by any of the ids Outline accepts, with
// the caller's access checked.

import { sql } from "../db.ts";
import { Access, atLeast, type Perm } from "../access.ts";
import { forbidden, isUuid, notFound } from "../http.ts";
import { DOC_COLUMNS, type CollectionRow, type DocumentRow } from "../presenters.ts";

/** "abc123XYZ0", "some-title-abc123XYZ0" or a UUID: Outline accepts all three as `id`. */
export function urlIdOf(id: string): string | null {
  const m = id.match(/([a-zA-Z0-9]{10})$/);
  return m ? m[1] : null;
}

export async function findCollection(id: string, teamId: string): Promise<CollectionRow | null> {
  if (isUuid(id)) {
    const [c] = await sql<CollectionRow[]>`SELECT * FROM collections WHERE id = ${id} AND team_id = ${teamId}`;
    return c ?? null;
  }
  const urlId = urlIdOf(id);
  if (!urlId) return null;
  const [c] = await sql<CollectionRow[]>`SELECT * FROM collections WHERE url_id = ${urlId} AND team_id = ${teamId}`;
  return c ?? null;
}

/** A collection the caller can at least read (`min` for more), or not_found / authorization_error. */
export async function collectionFor(a: Access, id: string | undefined, min: Perm = "read", opts: { includeDeleted?: boolean } = {}) {
  if (!id) throw notFound();
  const c = await findCollection(id, a.user.teamId);
  if (!c || (c.deletedAt && !opts.includeDeleted)) throw notFound();
  const p = a.collection(c.id);
  if (!p) throw notFound();
  if (!atLeast(p, min)) throw forbidden();
  return c;
}

export async function findDocument(id: string, teamId: string): Promise<DocumentRow | null> {
  if (isUuid(id)) {
    const [d] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = ${id} AND d.team_id = ${teamId}`;
    return d ?? null;
  }
  const urlId = urlIdOf(id);
  if (!urlId) return null;
  const [d] = await sql<DocumentRow[]>`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.url_id = ${urlId} AND d.team_id = ${teamId}`;
  return d ?? null;
}

/** A document the caller can at least read (`min` for more). */
export async function documentFor(a: Access, id: string | undefined, min: Perm = "read") {
  if (!id) throw notFound();
  const d = await findDocument(id, a.user.teamId);
  if (!d) throw notFound();
  const p = a.document(d);
  if (!p) throw notFound();
  if (!atLeast(p, min) || (min !== "read" && a.user.role === "viewer")) throw forbidden();
  return d;
}

/** Outline's pagination block, with the next page's path. */
export function page(method: string, limit: number, offset: number, total?: number) {
  return { limit, offset, nextPath: `/api/${method}?limit=${limit}&offset=${offset + limit}`, ...(total !== undefined ? { total } : {}) };
}
