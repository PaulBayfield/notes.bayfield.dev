// apiKeys.*: personal API keys, as Outline's ("ol_api_…" tokens; only their SHA-256 is stored, the
// value is shown once, on creation). A key acts as its owner, optionally limited by a scope
// ("read", "write", methods or namespaces: see scopeAllows) and an expiry.

import { randomBytes } from "node:crypto";
import { sql } from "../db.ts";
import { sha256 } from "../crypto.ts";
import { forbidden, invalid, notFound } from "../http.ts";
import { method } from "../rpc.ts";
import { publish } from "../events.ts";
import { getUser } from "../users.ts";
import { page } from "./common.ts";

interface ApiKeyRow {
  id: string;
  userId: string;
  name: string;
  last4: string;
  scope: string[] | null;
  expiresAt: Date | null;
  lastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Outline's format: "ol_api_" and 38 letters or digits. */
function newKey(): string {
  const bytes = randomBytes(38);
  return `ol_api_${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}

const present = (k: ApiKeyRow, value?: string) => ({
  id: k.id,
  userId: k.userId,
  name: k.name,
  scope: k.scope,
  ...(value ? { value } : {}),
  last4: k.last4,
  expiresAt: k.expiresAt,
  lastActiveAt: k.lastActiveAt,
  createdAt: k.createdAt,
  updatedAt: k.updatedAt,
});

const policy = (k: ApiKeyRow) => ({ id: k.id, abilities: { read: true, update: true, delete: true } });

method("apiKeys.create", async ({ params, user, caller }) => {
  // A key can't make keys with more power than itself: only a session creates them.
  if (caller.via === "apiKey" || caller.via === "oauth") throw forbidden("API keys are created from a signed-in session");
  if (user.role === "guest" || user.role === "viewer") throw forbidden("Viewers and guests can't create API keys");
  const name = params.string("name", { required: true, max: 255 })!.trim();
  if (!name) throw invalid("name is required");
  const scope = params.array("scope")?.map((s) => {
    if (typeof s !== "string" || !s.trim() || s.length > 100) throw invalid("scope must be a list of strings");
    return s.trim();
  });
  const expires = params.nullableString("expiresAt");
  const expiresAt = expires ? new Date(expires) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date())) throw invalid("expiresAt must be a date in the future");
  const value = newKey();
  const [k] = await sql<ApiKeyRow[]>`
    INSERT INTO api_keys (user_id, name, hash, last4, scope, expires_at)
    VALUES (${user.id}, ${name}, ${sha256(value)}, ${value.slice(-4)}, ${scope?.length ? scope : null}, ${expiresAt})
    RETURNING *`;
  publish({ name: "apiKeys.create", data: { id: k.id, userId: user.id, name: k.name }, teamId: user.teamId, userIds: [user.id], actorId: user.id });
  return { data: present(k, value), policies: [policy(k)] };
});

/** The caller's keys; an admin may list anyone's in the workspace (userId), or everyone's. */
method("apiKeys.list", async ({ params, user }) => {
  const { limit, offset } = params.pagination();
  const userId = params.uuid("userId");
  const admin = user.role === "admin";
  if (userId && userId !== user.id) {
    const other = await getUser(userId);
    if (!admin || !other || other.teamId !== user.teamId) throw forbidden();
  }
  const whose = userId ? sql`k.user_id = ${userId}` : admin && params.boolean("all") ? sql`u.team_id = ${user.teamId}` : sql`k.user_id = ${user.id}`;
  const rows = await sql<ApiKeyRow[]>`
    SELECT k.* FROM api_keys k JOIN users u ON u.id = k.user_id
    WHERE ${whose} AND k.deleted_at IS NULL
    ORDER BY k.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  return { data: rows.map((k) => present(k)), policies: rows.map(policy), pagination: page("apiKeys.list", limit, offset) };
});

/** Revokes a key: its owner, or an admin of the workspace. */
method("apiKeys.delete", async ({ params, user }) => {
  const id = params.uuid("id", { required: true })!;
  const [k] = await sql<(ApiKeyRow & { teamId: string })[]>`
    SELECT k.*, u.team_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = ${id} AND k.deleted_at IS NULL`;
  if (!k || k.teamId !== user.teamId) throw notFound();
  if (k.userId !== user.id && user.role !== "admin") throw forbidden();
  await sql`UPDATE api_keys SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  publish({ name: "apiKeys.delete", data: { id, userId: k.userId, name: k.name }, teamId: user.teamId, userIds: [k.userId], actorId: user.id });
  return { success: true };
});
