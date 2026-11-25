// events.list: the workspace's history, as Outline's. Everyone sees what happened to the documents and
// collections they can read (and their own actions); admins ask for the whole audit log (auditLog).

import { sql } from "../db.ts";
import { Access } from "../access.ts";
import { forbidden } from "../http.ts";
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
  data: unknown;
  changes: unknown;
  ip: string | null;
  createdAt: Date;
}

method("events.list", async ({ params, user }) => {
  const { limit, offset } = params.pagination();
  const audit = params.boolean("auditLog") ?? false;
  if (audit && user.role !== "admin") throw forbidden("Only admins can read the audit log");
  const name = params.string("name", { max: 100 });
  const events = params.array("events")?.map(String);
  const actorId = params.uuid("actorId");
  const documentId = params.uuid("documentId");
  const collectionId = params.uuid("collectionId");
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
    ORDER BY e.created_at ${direction === "ASC" ? sql`ASC` : sql`DESC`}
    LIMIT ${limit} OFFSET ${offset}`;
  const users = await usersById(rows.flatMap((r) => [r.actorId, r.userId]).filter((id): id is string => !!id));
  return {
    data: rows.map((r) => {
      const actor = r.actorId ? users.get(r.actorId) : undefined;
      return {
        id: r.id,
        name: r.name,
        modelId: r.modelId,
        actorId: r.actorId,
        actor: actor ? presentUser(actor) : null,
        userId: r.userId,
        collectionId: r.collectionId,
        documentId: r.documentId,
        data: r.data,
        changes: r.changes,
        ...(audit ? { actorIpAddress: r.ip } : {}),
        createdAt: r.createdAt,
      };
    }),
    pagination: page("events.list", limit, offset),
  };
});
