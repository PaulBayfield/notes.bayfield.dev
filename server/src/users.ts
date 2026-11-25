// The workspace (one team per server, as a self-hosted Outline) and its people.

import { DEFAULT_LANGUAGE } from "./config.ts";
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

let team: TeamRow | null = null;

/** The workspace, created on first start (an import brings Outline's instead). */
export async function currentTeam(fresh = false): Promise<TeamRow> {
  if (team && !fresh) return team;
  let [t] = await sql<TeamRow[]>`SELECT * FROM teams ORDER BY created_at LIMIT 1`;
  if (!t) [t] = await sql<TeamRow[]>`INSERT INTO teams (name) VALUES (${process.env.TEAM_NAME?.trim() || "Notes"}) RETURNING *`;
  team = t;
  return t;
}

export const forgetTeam = () => {
  team = null;
};

/** Outline's avatar colours, picked from the user's id so everyone keeps theirs. */
const COLORS = ["#FF5C80", "#FF5C00", "#FFBA00", "#20C997", "#10B981", "#0EA5E9", "#3B82F6", "#6366F1", "#8B5CF6", "#A855F7", "#EC4899", "#F43F5E"];
const colorFor = (seed: string) => COLORS[[...seed].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLORS.length];

export async function createUser(input: { teamId: string; name: string; email: string | null; avatarUrl: string | null; role?: UserRole; invitedById?: string }): Promise<UserRow> {
  const t = await currentTeam();
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
