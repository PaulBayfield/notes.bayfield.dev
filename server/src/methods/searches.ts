// searches.*: the caller's recent searches (Outline's search history), newest first, one per query.

import { sql } from "../db.ts";
import { invalid } from "../http.ts";
import { method } from "../rpc.ts";
import { page } from "./common.ts";

method("searches.list", async ({ params, user }) => {
  const { limit, offset } = params.pagination();
  const source = params.oneOf("source", ["app", "api"] as const);
  const rows = await sql<{ id: string; query: string; results: number; source: string; createdAt: Date }[]>`
    SELECT * FROM (
      SELECT DISTINCT ON (lower(query)) id, query, results, source, created_at FROM search_queries
      WHERE user_id = ${user.id} ${source ? sql`AND source = ${source}` : sql``}
      ORDER BY lower(query), created_at DESC
    ) q ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  return {
    data: rows.map((r) => ({ id: r.id, query: r.query, results: r.results, source: r.source, createdAt: r.createdAt })),
    pagination: page("searches.list", limit, offset),
  };
});

/** Forgets a search: every time the caller searched for it (by id or query). */
method("searches.delete", async ({ params, user }) => {
  const id = params.uuid("id");
  const query = params.string("query", { max: 255 });
  if (!id && !query) throw invalid("id or query is required");
  const q = query ?? (await sql<{ query: string }[]>`SELECT query FROM search_queries WHERE id = ${id!} AND user_id = ${user.id}`)[0]?.query;
  if (q) await sql`DELETE FROM search_queries WHERE user_id = ${user.id} AND lower(query) = lower(${q})`;
  return { success: true };
});
