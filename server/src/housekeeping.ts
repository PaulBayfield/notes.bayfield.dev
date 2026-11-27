// Housekeeping, as Outline's background tasks: the trash empties itself after 30 days, exports expire,
// and leftovers (abandoned uploads, expired codes, unused self-registered apps) go away. Each job runs on
// one instance at a time (jobs.ts).

import { sql } from "./db.ts";
import { schedule } from "./jobs.ts";
import { remove } from "./storage.ts";
import { publish } from "./events.ts";

const DAY = 24 * 60 * 60_000;
export const TRASH_DAYS = 30;
const EXPORT_DAYS = 7;

/** Deletes documents for good, with the files attached to them. */
export async function purgeDocuments(ids: string[]) {
  if (!ids.length) return;
  const files = await sql<{ id: string; key: string }[]>`SELECT id, key FROM attachments WHERE document_id = ANY(${ids}::uuid[])`;
  await sql`DELETE FROM documents WHERE id = ANY(${ids}::uuid[])`;
  if (files.length) await sql`DELETE FROM attachments WHERE id = ANY(${files.map((f) => f.id)}::uuid[])`;
  for (const f of files) await remove(f.key).catch(() => {});
}

export function scheduleHousekeeping() {
  schedule("trash", 60 * 60_000, async () => {
    const old = await sql<{ id: string; teamId: string }[]>`
      SELECT id, team_id FROM documents WHERE deleted_at < ${new Date(Date.now() - TRASH_DAYS * DAY)} LIMIT 500`;
    await purgeDocuments(old.map((d) => d.id));
    for (const d of old) publish({ name: "documents.permanent_delete", data: { id: d.id }, teamId: d.teamId, documentId: d.id });
  });

  schedule("exports", 6 * 60 * 60_000, async () => {
    const expired = await sql<{ id: string; key: string | null }[]>`
      UPDATE file_operations SET state = 'expired', updated_at = now()
      WHERE type = 'export' AND state = 'complete' AND created_at < ${new Date(Date.now() - EXPORT_DAYS * DAY)}
      RETURNING id, key`;
    for (const f of expired) if (f.key) await remove(f.key).catch(() => {});
  });

  // The events log, as long as each workspace keeps it (preferences.auditRetentionDays; unset: forever).
  schedule("events", 24 * 60 * 60_000, async () => {
    await sql`
      DELETE FROM events e USING teams t
      WHERE e.team_id = t.id AND (t.preferences->>'auditRetentionDays') ~ '^[0-9]+$' AND (t.preferences->>'auditRetentionDays')::int > 0
        AND e.created_at < now() - make_interval(days => (t.preferences->>'auditRetentionDays')::int)`;
  });

  schedule("leftovers", 6 * 60 * 60_000, async () => {
    // Uploads reserved and never sent.
    const abandoned = await sql<{ key: string }[]>`DELETE FROM attachments WHERE uploaded_at IS NULL AND created_at < ${new Date(Date.now() - DAY)} RETURNING key`;
    for (const f of abandoned) await remove(f.key).catch(() => {});
    await sql`DELETE FROM oauth_codes WHERE expires_at < now()`;
    await sql`DELETE FROM oauth_authentications WHERE refresh_token_expires_at < now()`;
    // Apps that registered themselves and were never (or no longer) allowed by anyone.
    await sql`
      DELETE FROM oauth_clients c WHERE c.registered_dynamically AND c.created_at < ${new Date(Date.now() - 7 * DAY)}
        AND NOT EXISTS (SELECT 1 FROM oauth_authentications a WHERE a.client_id = c.id)`;
    await sql`DELETE FROM api_keys WHERE deleted_at < ${new Date(Date.now() - 30 * DAY)}`;
  });
}
