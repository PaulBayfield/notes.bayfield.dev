// PostgreSQL connection and schema migrations.
//
// Columns are snake_case in the database and camelCase in JS (postgres.camel transform). The schema
// follows Outline's models (same names, same meaning) so the API's answers are a straight read and the
// import from an Outline database is a column-for-column copy: ids and urlIds are kept, so links,
// bookmarks and shares keep working.

import postgres from "postgres";
import { DATABASE_URL } from "./config.ts";

export const sql = postgres(DATABASE_URL, {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idle_timeout: 60,
  onnotice: () => {},
  transform: postgres.camel,
  // jsonb columns come back parsed, timestamps as Date.
});

export type Sql = typeof sql;
export type Tx = postgres.TransactionSql<Record<string, never>>;

const MIGRATIONS: string[] = [
  /* 1: the whole schema */ `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS unaccent;

  -- unaccent() isn't IMMUTABLE (its dictionary could change), so it can't go in an index or a
  -- generated column as is; this wrapper pins the dictionary.
  CREATE FUNCTION notes_norm(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    RETURN lower(public.unaccent('public.unaccent'::regdictionary, $1));

  -- ---------- The workspace and its people ----------

  CREATE TABLE teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text,
    avatar_url text,
    subdomain text,
    domain text,
    sharing boolean NOT NULL DEFAULT true,
    default_collection_id uuid,
    default_user_role text NOT NULL DEFAULT 'member' CHECK (default_user_role IN ('admin', 'member', 'viewer', 'guest')),
    member_collection_create boolean NOT NULL DEFAULT true,
    member_team_create boolean NOT NULL DEFAULT true,
    document_embeds boolean NOT NULL DEFAULT true,
    invite_required boolean NOT NULL DEFAULT false,
    allowed_domains text[] NOT NULL DEFAULT '{}',
    guest_signin boolean NOT NULL DEFAULT false,
    passkeys_enabled boolean NOT NULL DEFAULT false,
    preferences jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name text NOT NULL,
    email text,
    avatar_url text,
    color text NOT NULL DEFAULT '#0366d6',
    role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer', 'guest')),
    language text,
    timezone text,
    preferences jsonb,
    notification_settings jsonb NOT NULL DEFAULT '{}',
    flags jsonb,
    invited_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    suspended_at timestamptz,
    suspended_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    last_active_at timestamptz,
    last_active_ip text,
    last_signed_in_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE UNIQUE INDEX users_email ON users (team_id, lower(email)) WHERE deleted_at IS NULL;

  -- An identity at the provider (the OIDC subject) that signs in as a user.
  CREATE TABLE user_authentications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_id text NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}',
    last_validated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
  );

  -- A signed-in browser or desktop app: the accessToken cookie (or bearer token) holds a random
  -- token, only its SHA-256 is stored here.
  CREATE TABLE sessions (
    id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client text NOT NULL DEFAULT 'web',
    user_agent text NOT NULL DEFAULT '',
    ip text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  -- A sign-in in progress at the provider.
  CREATE TABLE oidc_states (
    state text PRIMARY KEY,
    verifier text NOT NULL,
    nonce text NOT NULL,
    client text NOT NULL DEFAULT 'web',
    expires_at timestamptz NOT NULL
  );

  -- Desktop sign-in: a one-time token the app swaps for a session at /auth/redirect.
  CREATE TABLE transfer_tokens (
    id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
  );

  -- API keys ("ol_api_…" in Outline): only the SHA-256 is kept.
  CREATE TABLE api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    hash text NOT NULL UNIQUE,
    last4 text NOT NULL,
    scope text[],
    expires_at timestamptz,
    last_active_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );

  CREATE TABLE groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    icon text,
    color text,
    external_id text,
    disable_mentions boolean NOT NULL DEFAULT false,
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );

  CREATE TABLE group_users (
    group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission text NOT NULL DEFAULT 'member' CHECK (permission IN ('admin', 'member')),
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
  );

  -- ---------- Content ----------

  CREATE TABLE collections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    url_id text NOT NULL UNIQUE,
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name text NOT NULL,
    -- The overview: Markdown (API v1/v2 "description") and ProseMirror JSON (v3 "data").
    description text,
    content jsonb,
    icon text,
    color text,
    -- Fractional index (Outline's fractional-index strings), the sidebar's order.
    index text,
    -- The access everyone in the workspace has: 'read', 'read_write', or none (private).
    permission text CHECK (permission IN ('read', 'read_write')),
    sharing boolean NOT NULL DEFAULT true,
    commenting boolean,
    sort jsonb NOT NULL DEFAULT '{"field": "index", "direction": "asc"}',
    template_management text,
    -- The published documents' tree, as collections.documents answers it (kept in sync on every change).
    document_structure jsonb NOT NULL DEFAULT '[]',
    source_metadata jsonb,
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    archived_at timestamptz,
    archived_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );

  CREATE TABLE documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    url_id text NOT NULL UNIQUE,
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
    parent_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
    title text NOT NULL DEFAULT '',
    icon text,
    color text,
    -- Markdown, derived from the content (exports, search, the API's "text").
    text text NOT NULL DEFAULT '',
    -- ProseMirror JSON, derived from the Yjs state.
    content jsonb,
    -- The Yjs document: the source of truth while people edit.
    state bytea,
    full_width boolean NOT NULL DEFAULT false,
    insights_enabled boolean NOT NULL DEFAULT true,
    preferences jsonb,
    -- A template (templates.*) rather than a document.
    is_template boolean NOT NULL DEFAULT false,
    template_id uuid REFERENCES documents(id) ON DELETE SET NULL,
    source_metadata jsonb,
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    last_modified_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    collaborator_ids uuid[] NOT NULL DEFAULT '{}',
    revision_count integer NOT NULL DEFAULT 0,
    published_at timestamptz,
    archived_at timestamptz,
    deleted_at timestamptz,
    deleted_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Full-text search: the title first, then the body; accents off, any language.
    search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', notes_norm(coalesce(title, ''))), 'A') ||
      setweight(to_tsvector('simple', notes_norm(coalesce(text, ''))), 'B')
    ) STORED
  );
  CREATE INDEX documents_collection ON documents (collection_id) WHERE deleted_at IS NULL;
  CREATE INDEX documents_parent ON documents (parent_document_id);
  CREATE INDEX documents_updated ON documents (team_id, updated_at DESC);
  CREATE INDEX documents_search ON documents USING gin (search);
  CREATE INDEX documents_title_trgm ON documents USING gin (notes_norm(title) gin_trgm_ops);

  CREATE TABLE revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    title text NOT NULL DEFAULT '',
    name text,
    icon text,
    color text,
    text text NOT NULL DEFAULT '',
    content jsonb,
    collaborator_ids uuid[] NOT NULL DEFAULT '{}',
    source_metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE INDEX revisions_document ON revisions (document_id, created_at DESC);

  -- Access given to one person, on a collection or a document.
  CREATE TABLE user_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,
    document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
    permission text NOT NULL CHECK (permission IN ('read', 'read_write', 'admin')),
    -- The membership this one comes from (a document's access given to its children).
    source_id uuid REFERENCES user_memberships(id) ON DELETE CASCADE,
    -- "Shared with me": the user's own order.
    index text,
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((collection_id IS NULL) <> (document_id IS NULL))
  );
  CREATE INDEX user_memberships_user ON user_memberships (user_id);
  CREATE UNIQUE INDEX user_memberships_collection ON user_memberships (user_id, collection_id) WHERE collection_id IS NOT NULL;
  CREATE UNIQUE INDEX user_memberships_document ON user_memberships (user_id, document_id) WHERE document_id IS NOT NULL;

  -- Access given to a group, on a collection or a document.
  CREATE TABLE group_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,
    document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
    permission text NOT NULL CHECK (permission IN ('read', 'read_write', 'admin')),
    source_id uuid REFERENCES group_memberships(id) ON DELETE CASCADE,
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((collection_id IS NULL) <> (document_id IS NULL))
  );
  CREATE UNIQUE INDEX group_memberships_collection ON group_memberships (group_id, collection_id) WHERE collection_id IS NOT NULL;
  CREATE UNIQUE INDEX group_memberships_document ON group_memberships (group_id, document_id) WHERE document_id IS NOT NULL;

  CREATE TABLE stars (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
    collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,
    index text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX stars_user ON stars (user_id);

  CREATE TABLE pins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    -- Pinned to a collection's overview; null: to the home page.
    collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,
    index text,
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE shares (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
    collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,
    url_id text UNIQUE,
    published boolean NOT NULL DEFAULT false,
    include_child_documents boolean NOT NULL DEFAULT false,
    allow_indexing boolean NOT NULL DEFAULT false,
    allow_subscriptions boolean NOT NULL DEFAULT false,
    show_last_updated boolean NOT NULL DEFAULT false,
    show_toc boolean NOT NULL DEFAULT false,
    domain text,
    title text,
    icon_url text,
    expires_at timestamptz,
    views integer NOT NULL DEFAULT 0,
    last_accessed_at timestamptz,
    revoked_at timestamptz,
    revoked_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    count integer NOT NULL DEFAULT 1,
    first_viewed_at timestamptz NOT NULL DEFAULT now(),
    last_viewed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, document_id)
  );

  CREATE TABLE comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    -- ProseMirror JSON.
    data jsonb NOT NULL,
    resolved_at timestamptz,
    resolved_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE INDEX comments_document ON comments (document_id);

  CREATE TABLE reactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    emoji text NOT NULL,
    comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (comment_id, user_id, emoji)
  );

  CREATE TABLE subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
    collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,
    event text NOT NULL DEFAULT 'documents.update',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE INDEX subscriptions_user ON subscriptions (user_id);

  CREATE TABLE attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
    -- Where the file is in the storage folder ("uploads/<user>/<id>/<name>", "public/…" for avatars).
    key text NOT NULL UNIQUE,
    name text NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL DEFAULT 0,
    acl text NOT NULL DEFAULT 'private',
    -- Uploaded: the file is in storage (attachments.create first reserves the row).
    uploaded_at timestamptz,
    last_accessed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE file_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
    document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
    type text NOT NULL CHECK (type IN ('export', 'import')),
    format text NOT NULL,
    name text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'uploading', 'complete', 'error', 'expired')),
    error text,
    key text,
    size bigint NOT NULL DEFAULT 0,
    include_attachments boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );

  CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    event text NOT NULL,
    document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
    collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,
    comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
    revision_id uuid REFERENCES revisions(id) ON DELETE CASCADE,
    file_operation_id uuid REFERENCES file_operations(id) ON DELETE CASCADE,
    membership_id uuid,
    data jsonb,
    viewed_at timestamptz,
    archived_at timestamptz,
    emailed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

  CREATE TABLE emojis (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name text NOT NULL,
    attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL,
    created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (team_id, name)
  );

  -- The audit trail (events.list, document insights).
  CREATE TABLE events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name text NOT NULL,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    model_id uuid,
    collection_id uuid,
    document_id uuid,
    data jsonb,
    changes jsonb,
    ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX events_document ON events (document_id, created_at DESC);
  `,
  /* 2: several workspaces: an identity has an account per workspace; sign-ins remember theirs */ `
  ALTER TABLE user_authentications ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE CASCADE;
  UPDATE user_authentications ua SET team_id = u.team_id FROM users u WHERE u.id = ua.user_id;
  ALTER TABLE user_authentications ALTER COLUMN team_id SET NOT NULL;
  ALTER TABLE user_authentications DROP CONSTRAINT user_authentications_provider_provider_id_key;
  CREATE UNIQUE INDEX user_authentications_identity ON user_authentications (team_id, provider, provider_id);
  ALTER TABLE oidc_states ADD COLUMN team_id uuid;
  ALTER TABLE transfer_tokens ADD COLUMN team_id uuid;
  CREATE UNIQUE INDEX teams_subdomain ON teams (lower(subdomain)) WHERE subdomain IS NOT NULL;
  CREATE UNIQUE INDEX teams_domain ON teams (lower(domain)) WHERE domain IS NOT NULL;
  `,
];

export async function migrate() {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4242040)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const [{ v }] = await tx<{ v: number }[]>`SELECT coalesce(max(version), 0)::int AS v FROM schema_migrations`;
    for (let i = v; i < MIGRATIONS.length; i++) {
      await tx.unsafe(MIGRATIONS[i]);
      await tx`INSERT INTO schema_migrations (version) VALUES (${i + 1})`;
      console.log(`Database migrated to version ${i + 1}`);
    }
  });
}
