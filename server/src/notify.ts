// In-app notifications (notifications.list), as Outline sends them: a row per person, pushed live on
// the socket ("notifications.create"), unless that person turned the event off in their settings.

import { sql } from "./db.ts";
import { publish } from "./events.ts";

/** Whether each event is on for someone who never chose (Outline's defaults). */
const DEFAULTS: Record<string, boolean> = {
  "documents.publish": false,
  "documents.update": true,
  "comments.create": true,
  "comments.mentioned": true,
  "documents.mentioned": true,
  "documents.group_mentioned": true,
  "comments.group_mentioned": true,
  "comments.resolve": true,
  "reactions.create": true,
  "collections.create": false,
  "emails.invite_accepted": true,
  "documents.add_user": true,
  "collections.add_user": true,
  "groups.add_user": true,
  "groups.remove_user": true,
  "emails.export_completed": true,
};

export interface NotificationInput {
  event: string;
  actorId?: string | null;
  documentId?: string | null;
  collectionId?: string | null;
  commentId?: string | null;
  revisionId?: string | null;
  fileOperationId?: string | null;
  groupId?: string | null;
  data?: Record<string, unknown> | null;
}

/** Notifies these people (the actor never notifies themselves), each per their settings. */
export async function notify(teamId: string, userIds: (string | null | undefined)[], n: NotificationInput) {
  const ids = [...new Set(userIds.filter((u): u is string => !!u && u !== n.actorId))];
  if (!ids.length) return;
  const people = await sql<{ id: string; notificationSettings: Record<string, unknown> }[]>`
    SELECT id, notification_settings FROM users WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL AND suspended_at IS NULL`;
  const wanted = people.filter((p) => {
    const v = p.notificationSettings?.[n.event];
    return typeof v === "boolean" ? v : (DEFAULTS[n.event] ?? true);
  });
  if (!wanted.length) return;
  const data = { ...(n.data ?? {}), ...(n.groupId ? { groupId: n.groupId } : {}) };
  await sql`
    INSERT INTO notifications ${sql(
      wanted.map((p) => ({
        teamId,
        userId: p.id,
        actorId: n.actorId ?? null,
        event: n.event,
        documentId: n.documentId ?? null,
        collectionId: n.collectionId ?? null,
        commentId: n.commentId ?? null,
        revisionId: n.revisionId ?? null,
        fileOperationId: n.fileOperationId ?? null,
        data: Object.keys(data).length ? sql.json(data as never) : null,
      })) as never,
      "teamId", "userId", "actorId", "event", "documentId", "collectionId", "commentId", "revisionId", "fileOperationId", "data",
    )}`;
  publish({ name: "notifications.create", data: { event: n.event }, teamId, userIds: wanted.map((p) => p.id) });
}

/** People subscribed to a document (or its collection) for an event. */
export async function subscribers(documentId: string, collectionId: string | null, event = "documents.update"): Promise<string[]> {
  const rows = await sql<{ userId: string }[]>`
    SELECT DISTINCT user_id FROM subscriptions
    WHERE deleted_at IS NULL AND event = ${event} AND (document_id = ${documentId} ${collectionId ? sql`OR collection_id = ${collectionId}` : sql``})`;
  return rows.map((r) => r.userId);
}
