// Workspaces (teams) and their people.
//
// A server holds any number of workspaces, each at its own address, as Outline's cloud does: the main
// address (PUBLIC_URL) for the first one, "<subdomain>.<WORKSPACE_DOMAIN>" or a custom domain for the
// others. A client connects to each like to any Outline server. A person has an account per workspace.

import { DEFAULT_LANGUAGE, PUBLIC_URL, WORKSPACE_DOMAIN } from "./config.ts";
import { sql } from "./db.ts";

export type UserRole = "admin" | "member" | "viewer" | "guest";

export interface UserRow {
  id: string;
  teamId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  color: string;
  role: UserRole;
  language: string | null;
  timezone: string | null;
  preferences: Record<string, unknown> | null;
  notificationSettings: Record<string, unknown>;
  flags: Record<string, unknown> | null;
  invitedById: string | null;
  suspendedAt: Date | null;
  lastActiveAt: Date | null;
  lastSignedInAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  subdomain: string | null;
  domain: string | null;
  sharing: boolean;
  defaultCollectionId: string | null;
  defaultUserRole: UserRole;
  memberCollectionCreate: boolean;
  memberTeamCreate: boolean;
  documentEmbeds: boolean;
  inviteRequired: boolean;
  allowedDomains: string[];
  guestSignin: boolean;
  passkeysEnabled: boolean;
  preferences: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function getUser(id: string): Promise<UserRow | null> {
  const [u] = await sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
  return u ?? null;
}

// ---------- Workspaces ----------

const CACHE_MS = 30_000;
const teams = new Map<string, { team: TeamRow; until: number }>();
let defaultTeamId: string | null = null;

export async function teamById(id: string): Promise<TeamRow> {
  const hit = teams.get(id);
  if (hit && hit.until > Date.now()) return hit.team;
  const [t] = await sql<TeamRow[]>`SELECT * FROM teams WHERE id = ${id}`;
  if (!t) throw new Error(`Unknown workspace ${id}`);
  teams.set(id, { team: t, until: Date.now() + CACHE_MS });
  return t;
}

/** Forgets cached workspaces (a change made here or on another instance). */
export function forgetTeam(id?: string) {
  if (id) teams.delete(id);
  else teams.clear();
  hostCache.clear();
}

/** The main address's workspace: the first one, created on first start (an import brings Outline's). */
export async function defaultTeam(): Promise<TeamRow> {
  if (defaultTeamId) return teamById(defaultTeamId);
  let [t] = await sql<TeamRow[]>`SELECT * FROM teams ORDER BY created_at LIMIT 1`;
  if (!t) [t] = await sql<TeamRow[]>`INSERT INTO teams (name) VALUES (${process.env.TEAM_NAME?.trim() || "Notes"}) RETURNING *`;
  defaultTeamId = t.id;
  teams.set(t.id, { team: t, until: Date.now() + CACHE_MS });
  return t;
}

const MAIN_HOST = new URL(PUBLIC_URL).host.toLowerCase();
const PROTOCOL = new URL(PUBLIC_URL).protocol;
const hostCache = new Map<string, { teamId: string | null; until: number }>();

/** The workspace an address serves (null: none). */
export async function teamForHost(rawHost: string | undefined): Promise<TeamRow | null> {
  const host = (rawHost ?? "").toLowerCase().replace(/\.$/, "");
  if (!host || host === MAIN_HOST) return defaultTeam();
  const hit = hostCache.get(host);
  if (hit && hit.until > Date.now()) return hit.teamId ? teamById(hit.teamId) : null;
  const bare = host.replace(/:\d+$/, "");
  let [t] = await sql<TeamRow[]>`SELECT * FROM teams WHERE lower(domain) = ${bare} OR lower(domain) = ${host} LIMIT 1`;
  if (!t && WORKSPACE_DOMAIN && host.endsWith(`.${WORKSPACE_DOMAIN}`)) {
    const sub = host.slice(0, -WORKSPACE_DOMAIN.length - 1);
    [t] = await sql<TeamRow[]>`SELECT * FROM teams WHERE lower(subdomain) = ${sub} LIMIT 1`;
  }
  hostCache.set(host, { teamId: t?.id ?? null, until: Date.now() + CACHE_MS });
  if (t) teams.set(t.id, { team: t, until: Date.now() + CACHE_MS });
  return t ?? null;
}

/** A workspace's address: its custom domain, its subdomain, or the main address for the first one. */
export function teamUrl(t: Pick<TeamRow, "id" | "domain" | "subdomain">): string {
  if (t.domain) return `${PROTOCOL}//${t.domain}`;
  if (t.subdomain && WORKSPACE_DOMAIN && t.id !== defaultTeamId) return `${PROTOCOL}//${t.subdomain}.${WORKSPACE_DOMAIN}`;
  return PUBLIC_URL;
}

// ---------- People ----------

/** Outline's avatar colours, picked from the user's email (or name) so everyone keeps theirs. */
const COLORS = ["#FF5C80", "#FF5C00", "#FFBA00", "#20C997", "#10B981", "#0EA5E9", "#3B82F6", "#6366F1", "#8B5CF6", "#A855F7", "#EC4899", "#F43F5E"];
const colorFor = (seed: string) => COLORS[[...seed].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLORS.length];

export async function createUser(input: { teamId: string; name: string; email: string | null; avatarUrl: string | null; role?: UserRole; invitedById?: string }): Promise<UserRow> {
  const t = await teamById(input.teamId);
  // The first account runs the workspace.
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM users WHERE team_id = ${input.teamId} AND deleted_at IS NULL`;
  const role = input.role ?? (count === 0 ? "admin" : t.defaultUserRole);
  const [u] = await sql<UserRow[]>`
    INSERT INTO users (team_id, name, email, avatar_url, role, language, invited_by_id, color)
    VALUES (${input.teamId}, ${input.name.slice(0, 255)}, ${input.email}, ${input.avatarUrl}, ${role}, ${DEFAULT_LANGUAGE}, ${input.invitedById ?? null},
            ${colorFor(input.email ?? input.name)})
    RETURNING *`;
  return u;
}

/** The other workspaces this person has an account in (same identity at the provider, or same email). */
export async function otherWorkspaces(user: UserRow): Promise<TeamRow[]> {
  return sql<TeamRow[]>`
    SELECT DISTINCT t.* FROM teams t JOIN users u ON u.team_id = t.id
    WHERE u.deleted_at IS NULL AND u.suspended_at IS NULL AND t.id <> ${user.teamId} AND (
      (${user.email}::text IS NOT NULL AND lower(u.email) = lower(${user.email}::text))
      OR EXISTS (SELECT 1 FROM user_authentications mine JOIN user_authentications theirs
                 ON theirs.provider = mine.provider AND theirs.provider_id = mine.provider_id
                 WHERE mine.user_id = ${user.id} AND theirs.user_id = u.id))
    ORDER BY t.created_at`;
}
