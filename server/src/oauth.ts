// OAuth 2.1 provider, as Outline's: how MCP clients (Claude, Cursor, …) and other apps get access to a
// workspace on someone's behalf, without an API key pasted around.
//
//  - Discovery: /.well-known/oauth-authorization-server (RFC 8414) and
//    /.well-known/oauth-protected-resource[/mcp] (RFC 9728), per workspace address.
//  - Clients register themselves (/oauth/register, RFC 7591) or an admin adds them (oauthClients.*).
//  - /oauth/authorize: the person signs in if needed, then allows or denies; authorization code + PKCE (S256).
//  - /oauth/token: codes and refresh tokens (rotated on every use) for an access token ("ol_at_…", 1 hour).
//  - /oauth/revoke (RFC 7009). People see and revoke their grants with oauthAuthentications.*.
// Codes and tokens are random; only their SHA-256 is stored.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { DEV_LOGIN_USER, oidc } from "./config.ts";
import { sql } from "./db.ts";
import { sha256 } from "./crypto.ts";
import { CSRF_COOKIE, identify, setOAuthTokenCheck, type AppEnv } from "./auth.ts";
import { esc, page } from "./html.ts";
import { ApiError, forbidden, invalid, notFound, rateLimit } from "./http.ts";
import { method } from "./rpc.ts";
import { getUser, teamUrl, type TeamRow, type UserRow } from "./users.ts";
import { page as pagination } from "./methods/common.ts";

const ACCESS_TTL = 60 * 60_000;
const REFRESH_TTL = 30 * 24 * 60 * 60_000;
const CODE_TTL = 10 * 60_000;
const SCOPES = ["read", "write"];

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const token = (prefix: string, length = 38) => `${prefix}${[...randomBytes(length)].map((b) => ALPHABET[b % ALPHABET.length]).join("")}`;

interface ClientRow {
  id: string;
  teamId: string;
  clientId: string;
  clientSecretHash: string | null;
  name: string;
  description: string | null;
  developerName: string | null;
  developerUrl: string | null;
  avatarUrl: string | null;
  redirectUris: string[];
  registeredDynamically: boolean;
  published: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** MCP and OAuth apps can be switched off per workspace (Outline's "mcp" preference). */
const oauthEnabled = (team: TeamRow) => (team.preferences as Record<string, unknown> | null)?.mcp !== false;

/** https anywhere, http on this machine only, or an app's own scheme; never javascript:, data: and the like. */
function validRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(u.protocol);
}

/** Loopback redirects may use any port (RFC 8252 7.3). */
function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return false;
    return registered.some((r) => {
      const v = new URL(r);
      return v.protocol === u.protocol && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
    });
  } catch {
    return false;
  }
}

function parseScope(raw: string | undefined | null): string[] | null {
  const scope = (raw ?? "").split(/[\s+]+/).filter(Boolean);
  if (!scope.length) return SCOPES;
  return scope.every((s) => SCOPES.includes(s) || /^[a-zA-Z]+\.(\*|[a-zA-Z_]+)$/.test(s)) ? [...new Set(scope)] : null;
}

const findClient = async (team: TeamRow, clientId: string | undefined) =>
  clientId ? ((await sql<ClientRow[]>`SELECT * FROM oauth_clients WHERE client_id = ${clientId} AND team_id = ${team.id} AND deleted_at IS NULL`)[0] ?? null) : null;

// ---------- Access tokens (checked by auth.ts for "Bearer ol_at_…") ----------

setOAuthTokenCheck(async (t) => {
  const [a] = await sql<{ id: string; userId: string; scope: string[]; lastActiveAt: Date | null }[]>`
    SELECT a.id, a.user_id, a.scope, a.last_active_at FROM oauth_authentications a JOIN oauth_clients c ON c.id = a.client_id
    WHERE a.access_token_hash = ${sha256(t)} AND a.access_token_expires_at > now() AND c.deleted_at IS NULL`;
  if (!a) return null;
  const user = await getUser(a.userId);
  if (!user || user.deletedAt || user.suspendedAt) return null;
  if (!a.lastActiveAt || Date.now() - a.lastActiveAt.getTime() > 5 * 60_000) await sql`UPDATE oauth_authentications SET last_active_at = now() WHERE id = ${a.id}`;
  return { user, scope: a.scope.length ? a.scope : null };
});

async function grant(clientId: string, userId: string, scope: string[], replace?: string) {
  const access = token("ol_at_");
  const refresh = token("ol_rt_");
  const values = {
    access_token_hash: sha256(access),
    access_token_expires_at: new Date(Date.now() + ACCESS_TTL),
    refresh_token_hash: sha256(refresh),
    refresh_token_expires_at: new Date(Date.now() + REFRESH_TTL),
  };
  if (replace) await sql`UPDATE oauth_authentications SET ${sql(values)}, updated_at = now() WHERE id = ${replace}`;
  else await sql`INSERT INTO oauth_authentications ${sql({ ...values, client_id: clientId, user_id: userId, scope })}`;
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: scope.join(" ") };
}

// ---------- Routes ----------

export const oauthRoutes = new Hono<AppEnv>();

const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status, { "Cache-Control": "no-store" });

oauthRoutes.get("/.well-known/oauth-authorization-server", (c) => {
  const base = teamUrl(c.get("team"));
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: SCOPES,
  });
});
// Also asked for as /.well-known/openid-configuration by some clients: the same document.
oauthRoutes.get("/.well-known/openid-configuration", (c) => c.redirect("/.well-known/oauth-authorization-server"));

const protectedResource = (c: Context<AppEnv>) => {
  const base = teamUrl(c.get("team"));
  return c.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: SCOPES, bearer_methods_supported: ["header"], resource_name: c.get("team").name });
};
oauthRoutes.get("/.well-known/oauth-protected-resource", protectedResource);
oauthRoutes.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

/** Dynamic client registration (RFC 7591): public clients, which prove themselves with PKCE. */
oauthRoutes.post("/oauth/register", async (c) => {
  rateLimit(c, "oauth-register", 20, 60 * 60_000);
  const team = c.get("team");
  if (!oauthEnabled(team)) return oauthError(c, "access_denied", "This workspace doesn't allow apps to connect");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return oauthError(c, "invalid_client_metadata", "Send the client's metadata as JSON");
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) return oauthError(c, "invalid_redirect_uri", "redirect_uris must be https, loopback http or an app's own scheme");
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "MCP client";
  const clientUri = typeof body.client_uri === "string" && /^https:\/\//.test(body.client_uri) ? body.client_uri.slice(0, 500) : null;
  const logoUri = typeof body.logo_uri === "string" && /^https:\/\//.test(body.logo_uri) ? body.logo_uri.slice(0, 500) : null;
  const clientId = token("", 32);
  const [client] = await sql<ClientRow[]>`
    INSERT INTO oauth_clients (team_id, client_id, name, developer_url, avatar_url, redirect_uris, registered_dynamically)
    VALUES (${team.id}, ${clientId}, ${name}, ${clientUri}, ${logoUri}, ${uris}, true) RETURNING *`;
  return c.json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES.join(" "),
    },
    201,
  );
});

interface AuthorizeRequest {
  client: ClientRow;
  redirectUri: string;
  challenge: string;
  state: string | undefined;
  scope: string[];
}

/** Checks an authorization request. Before the redirect URI is known to be the client's, errors show here. */
async function authorizeRequest(c: Context<AppEnv>, q: Record<string, string | undefined>): Promise<AuthorizeRequest | Response> {
  const team = c.get("team");
  const errorPage = (message: string) => c.html(brandedPage(c, "Can't connect", `<p>${esc(message)}</p>`), 400);
  if (!oauthEnabled(team)) return errorPage("This workspace doesn't allow apps to connect.");
  const client = await findClient(team, q.client_id);
  if (!client) return errorPage("This app isn't registered with this workspace. Try connecting it again.");
  const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
  if (!redirectMatches(client.redirectUris, redirectUri)) return errorPage("This app asked to come back to an address it didn't register.");
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (q.state) u.searchParams.set("state", q.state);
    return c.redirect(u.toString());
  };
  if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
  if (!q.code_challenge || (q.code_challenge_method ?? "plain") !== "S256") return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
  const scope = parseScope(q.scope);
  if (!scope) return back("invalid_scope", "Unknown scope");
  return { client, redirectUri, challenge: q.code_challenge, state: q.state, scope };
}

const describeScope = (scope: string[]) =>
  scope.includes("write") ? "Read and change everything you can, as you" : scope.includes("read") ? "Read everything you can see" : `Use ${scope.join(", ")}`;

oauthRoutes.get("/oauth/authorize", async (c) => {
  const q = c.req.query();
  const req = await authorizeRequest(c, q);
  if (req instanceof Response) return req;
  const team = c.get("team");
  const caller = await identify(c).catch(() => null);
  const here = c.req.path + new URL(c.req.url).search;

  if (!caller) {
    const next = encodeURIComponent(here);
    const buttons = [
      ...(oidc ? [`<a class="button" href="/auth/oidc?next=${next}">Sign in with ${esc(oidc.name)}</a>`] : []),
      ...(DEV_LOGIN_USER ? [`<a class="button" href="/auth/dev?next=${next}">Development (${esc(DEV_LOGIN_USER)})</a>`] : []),
    ];
    return c.html(brandedPage(c, `Connect ${req.client.name}`, `${STYLE}<p>Sign in to ${esc(team.name)} to connect <strong>${esc(req.client.name)}</strong>.</p><p>${buttons.join(" ")}</p>`));
  }

  const csrf = getCookie(c, CSRF_COOKIE) ?? "";
  const hidden = Object.entries({ ...q, csrf })
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v ?? "")}">`)
    .join("");
  const developer = req.client.developerUrl ? ` <span class="muted">(${esc(new URL(req.client.developerUrl).host)})</span>` : "";
  return c.html(
    brandedPage(c, 
      `Connect ${req.client.name}`,
      `${STYLE}<p><strong>${esc(req.client.name)}</strong>${developer} wants to access <strong>${esc(team.name)}</strong> as ${esc(caller.user.name)}.</p>
<ul><li>${esc(describeScope(req.scope))}</li></ul>
<p class="muted">It will come back to ${esc(new URL(req.redirectUri).origin === "null" ? req.redirectUri : new URL(req.redirectUri).origin)}. You can disconnect it at any time in your settings.</p>
<form method="post" action="/oauth/authorize">${hidden}<button class="button" name="decision" value="allow">Allow</button> <button class="button secondary" name="decision" value="deny">Cancel</button></form>`,
    ),
  );
});

/** The workspace's name and logo around the consent pages, as on its shared pages. */
const brandedPage = (c: Context<AppEnv>, title: string, body: string) => {
  const team = c.get("team");
  return page(title, body, { brand: { name: team.name, logo: team.avatarUrl, home: "/" } });
};

const STYLE = `<style>.button{display:inline-block;padding:8px 16px;border-radius:6px;border:1px solid var(--line);background:var(--accent);color:#fff;text-decoration:none;font:inherit;cursor:pointer}.button.secondary{background:transparent;color:var(--fg)}.muted{color:var(--muted);font-size:14px}</style>`;

oauthRoutes.post("/oauth/authorize", async (c) => {
  const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
  const req = await authorizeRequest(c, form);
  if (req instanceof Response) return req;
  const caller = await identify(c).catch(() => null);
  const csrf = getCookie(c, CSRF_COOKIE);
  if (!caller || caller.via !== "cookie" || !csrf || !form.csrf || csrf.length !== form.csrf.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(form.csrf))) {
    return c.html(brandedPage(c, "Can't connect", "<p>This page expired. Go back to the app and connect it again.</p>"), 403);
  }
  const back = new URL(req.redirectUri);
  if (req.state) back.searchParams.set("state", req.state);
  back.searchParams.set("iss", teamUrl(c.get("team")));
  if (form.decision !== "allow") {
    back.searchParams.set("error", "access_denied");
    return c.redirect(back.toString());
  }
  const code = token("", 40);
  await sql`DELETE FROM oauth_codes WHERE expires_at < now()`;
  await sql`
    INSERT INTO oauth_codes (id, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
    VALUES (${sha256(code)}, ${req.client.id}, ${caller.user.id}, ${req.redirectUri}, ${req.challenge}, ${req.scope}, ${new Date(Date.now() + CODE_TTL)})`;
  back.searchParams.set("code", code);
  return c.redirect(back.toString());
});

/** The client making a token request: its id, and its secret when it has one. */
async function tokenClient(c: Context<AppEnv>, body: Record<string, string | undefined>): Promise<ClientRow | null> {
  let id = body.client_id;
  let secret = body.client_secret;
  const basic = c.req.header("Authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const [u, p] = Buffer.from(basic, "base64").toString("utf8").split(":");
    id = decodeURIComponent(u ?? "");
    secret = decodeURIComponent(p ?? "");
  }
  const client = await findClient(c.get("team"), id);
  if (!client) return null;
  if (client.clientSecretHash) {
    if (!secret) return null;
    const a = Buffer.from(sha256(secret));
    const b = Buffer.from(client.clientSecretHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  }
  return client;
}

async function formBody(c: Context): Promise<Record<string, string | undefined>> {
  if (c.req.header("content-type")?.includes("application/json")) {
    const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
  }
  return Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
}

oauthRoutes.post("/oauth/token", async (c) => {
  rateLimit(c, "oauth-token", 300, 60 * 60_000);
  const body = await formBody(c);
  const client = await tokenClient(c, body);
  if (!client) return oauthError(c, "invalid_client", "Unknown client or wrong secret", 401);

  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier) return oauthError(c, "invalid_request", "code and code_verifier are required");
    const [code] = await sql<{ clientId: string; userId: string; redirectUri: string; codeChallenge: string; scope: string[] }[]>`
      DELETE FROM oauth_codes WHERE id = ${sha256(body.code)} AND expires_at > now() RETURNING client_id, user_id, redirect_uri, code_challenge, scope`;
    if (!code || code.clientId !== client.id) return oauthError(c, "invalid_grant", "This code is invalid or expired");
    if (body.redirect_uri && body.redirect_uri !== code.redirectUri) return oauthError(c, "invalid_grant", "redirect_uri doesn't match");
    const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
    if (challenge !== code.codeChallenge) return oauthError(c, "invalid_grant", "code_verifier doesn't match");
    const user = await getUser(code.userId);
    if (!user || user.deletedAt || user.suspendedAt) return oauthError(c, "invalid_grant", "This account can't be used");
    return c.json(await grant(client.id, user.id, code.scope), 200, { "Cache-Control": "no-store" });
  }

  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) return oauthError(c, "invalid_request", "refresh_token is required");
    const [a] = await sql<{ id: string; clientId: string; userId: string; scope: string[] }[]>`
      SELECT id, client_id, user_id, scope FROM oauth_authentications WHERE refresh_token_hash = ${sha256(body.refresh_token)} AND refresh_token_expires_at > now()`;
    if (!a || a.clientId !== client.id) return oauthError(c, "invalid_grant", "This refresh token is invalid or expired");
    // A narrower scope may be asked for, never a wider one.
    const asked = body.scope ? parseScope(body.scope) : a.scope;
    if (!asked || !asked.every((s) => a.scope.includes(s) || a.scope.includes("write"))) return oauthError(c, "invalid_scope", "The scope can't grow on refresh");
    return c.json(await grant(client.id, a.userId, asked, a.id), 200, { "Cache-Control": "no-store" });
  }

  return oauthError(c, "unsupported_grant_type", "Use authorization_code or refresh_token");
});

oauthRoutes.post("/oauth/revoke", async (c) => {
  const body = await formBody(c);
  const client = await tokenClient(c, body);
  if (!client) return oauthError(c, "invalid_client", "Unknown client or wrong secret", 401);
  if (body.token) {
    const h = sha256(body.token);
    await sql`DELETE FROM oauth_authentications WHERE client_id = ${client.id} AND (access_token_hash = ${h} OR refresh_token_hash = ${h})`;
  }
  return c.body(null, 200);
});

// ---------- API: oauthClients.* (admins), oauthAuthentications.* (everyone's own grants) ----------

const presentClient = (k: ClientRow, secret?: string) => ({
  id: k.id,
  name: k.name,
  description: k.description,
  developerName: k.developerName,
  developerUrl: k.developerUrl,
  avatarUrl: k.avatarUrl,
  clientId: k.clientId,
  ...(secret ? { clientSecret: secret } : {}),
  clientType: k.clientSecretHash ? "confidential" : "public",
  redirectUris: k.redirectUris,
  published: k.published,
  createdById: k.createdById,
  createdAt: k.createdAt,
  updatedAt: k.updatedAt,
});
const clientPolicy = (user: UserRow, k: ClientRow) => {
  const admin = user.role === "admin";
  return { id: k.id, abilities: { read: true, update: admin, delete: admin, rotateSecret: admin } };
};

function adminOnly(user: UserRow) {
  if (user.role !== "admin") throw forbidden("Only admins manage OAuth apps");
}

async function ownClient(user: UserRow, id: string | undefined) {
  if (!id) throw invalid("id is required");
  const [k] = await sql<ClientRow[]>`SELECT * FROM oauth_clients WHERE id = ${id} AND team_id = ${user.teamId} AND deleted_at IS NULL`;
  if (!k) throw notFound();
  return k;
}

function redirectUris(raw: unknown[] | undefined, required: boolean): string[] | undefined {
  if (raw === undefined) {
    if (required) throw invalid("redirectUris is required");
    return undefined;
  }
  const uris = raw.filter((u): u is string => typeof u === "string");
  if (!uris.length || uris.length !== raw.length || uris.length > 10 || !uris.every(validRedirect)) {
    throw invalid("redirectUris must be https, loopback http or an app's own scheme");
  }
  return uris;
}

method("oauthClients.list", async ({ params, user }) => {
  adminOnly(user);
  const { limit, offset } = params.pagination();
  const rows = await sql<ClientRow[]>`
    SELECT * FROM oauth_clients WHERE team_id = ${user.teamId} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  return { data: rows.map((k) => presentClient(k)), policies: rows.map((k) => clientPolicy(user, k)), pagination: pagination("oauthClients.list", limit, offset) };
});

method("oauthClients.info", async ({ params, user }) => {
  const id = params.uuid("id");
  const clientId = params.string("clientId");
  const [k] = id
    ? await sql<ClientRow[]>`SELECT * FROM oauth_clients WHERE id = ${id} AND team_id = ${user.teamId} AND deleted_at IS NULL`
    : await sql<ClientRow[]>`SELECT * FROM oauth_clients WHERE client_id = ${clientId ?? ""} AND team_id = ${user.teamId} AND deleted_at IS NULL`;
  if (!k) throw notFound();
  return { data: presentClient(k), policies: [clientPolicy(user, k)] };
});

method("oauthClients.create", async ({ params, user }) => {
  adminOnly(user);
  const name = params.string("name", { required: true, max: 100 })!.trim();
  if (!name) throw invalid("name is required");
  const uris = redirectUris(params.array("redirectUris"), true)!;
  const confidential = (params.string("clientType") ?? "confidential") === "confidential";
  const secret = confidential ? token("ol_sk_") : undefined;
  const [k] = await sql<ClientRow[]>`
    INSERT INTO oauth_clients (team_id, client_id, client_secret_hash, name, description, developer_name, developer_url, avatar_url, redirect_uris, published, created_by_id)
    VALUES (${user.teamId}, ${token("", 32)}, ${secret ? sha256(secret) : null}, ${name}, ${params.nullableString("description", 1000) ?? null},
            ${params.nullableString("developerName", 255) ?? null}, ${params.nullableString("developerUrl", 500) ?? null}, ${params.nullableString("avatarUrl", 500) ?? null},
            ${uris}, ${params.boolean("published") ?? false}, ${user.id})
    RETURNING *`;
  return { data: presentClient(k, secret), policies: [clientPolicy(user, k)] };
});

method("oauthClients.update", async ({ params, user }) => {
  adminOnly(user);
  const k = await ownClient(user, params.uuid("id", { required: true }));
  const set: Record<string, unknown> = {};
  const name = params.string("name", { max: 100 });
  if (name !== undefined) {
    if (!name.trim()) throw invalid("name can't be empty");
    set.name = name.trim();
  }
  for (const [param, column, max] of [
    ["description", "description", 1000],
    ["developerName", "developer_name", 255],
    ["developerUrl", "developer_url", 500],
    ["avatarUrl", "avatar_url", 500],
  ] as const) {
    const v = params.nullableString(param, max);
    if (v !== undefined) set[column] = v;
  }
  const uris = redirectUris(params.array("redirectUris"), false);
  if (uris) set.redirect_uris = uris;
  const published = params.boolean("published");
  if (published !== undefined) set.published = published;
  if (!Object.keys(set).length) return { data: presentClient(k), policies: [clientPolicy(user, k)] };
  const [u] = await sql<ClientRow[]>`UPDATE oauth_clients SET ${sql(set)}, updated_at = now() WHERE id = ${k.id} RETURNING *`;
  return { data: presentClient(u), policies: [clientPolicy(user, u)] };
});

method("oauthClients.rotate_secret", async ({ params, user }) => {
  adminOnly(user);
  const k = await ownClient(user, params.uuid("id", { required: true }));
  const secret = token("ol_sk_");
  const [u] = await sql<ClientRow[]>`UPDATE oauth_clients SET client_secret_hash = ${sha256(secret)}, updated_at = now() WHERE id = ${k.id} RETURNING *`;
  return { data: presentClient(u, secret), policies: [clientPolicy(user, u)] };
});

method("oauthClients.delete", async ({ params, user }) => {
  adminOnly(user);
  const k = await ownClient(user, params.uuid("id", { required: true }));
  await sql`UPDATE oauth_clients SET deleted_at = now() WHERE id = ${k.id}`;
  await sql`DELETE FROM oauth_authentications WHERE client_id = ${k.id}`;
  return { success: true };
});

/** The apps the caller has connected, one entry per app. */
method("oauthAuthentications.list", async ({ params, user }) => {
  const { limit, offset } = params.pagination();
  const rows = await sql<(ClientRow & { authId: string; scope: string[]; lastActiveAt: Date | null; grantedAt: Date })[]>`
    SELECT DISTINCT ON (c.id) c.*, a.id AS auth_id, a.scope, a.last_active_at, a.created_at AS granted_at
    FROM oauth_authentications a JOIN oauth_clients c ON c.id = a.client_id
    WHERE a.user_id = ${user.id} AND c.deleted_at IS NULL
    ORDER BY c.id, a.last_active_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}`;
  return {
    data: rows.map((r) => ({
      id: r.authId,
      userId: user.id,
      scope: r.scope,
      lastActiveAt: r.lastActiveAt,
      createdAt: r.grantedAt,
      oauthClientId: r.id,
      oauthClient: { id: r.id, name: r.name, clientId: r.clientId, avatarUrl: r.avatarUrl, developerName: r.developerName, developerUrl: r.developerUrl },
    })),
    pagination: pagination("oauthAuthentications.list", limit, offset),
  };
});

/** Disconnects an app: every grant the caller gave it (oauthClientId), or one grant (id). */
method("oauthAuthentications.delete", async ({ params, user }) => {
  const id = params.uuid("id");
  const clientId = params.uuid("oauthClientId");
  if (!id && !clientId) throw new ApiError("validation_error", "id or oauthClientId is required");
  if (clientId) await sql`DELETE FROM oauth_authentications WHERE user_id = ${user.id} AND client_id = ${clientId}`;
  else await sql`DELETE FROM oauth_authentications WHERE user_id = ${user.id} AND id = ${id!}`;
  return { success: true };
});
