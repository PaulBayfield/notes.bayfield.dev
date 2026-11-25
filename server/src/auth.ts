// Who's calling, and signing in: the same cookies, headers and paths as Outline, so the web app,
// the desktop app and the identity provider's settings don't change.
//
//  - Web: the `accessToken` cookie (httpOnly) plus Outline's double-submit CSRF check on writes: the
//    `csrfToken` cookie (`__Host-csrfToken` over HTTPS) must come back in the `x-csrf-token` header.
//  - Desktop and API keys: `Authorization: Bearer <token>` (no CSRF: no cookie involved).
//  - Sign-in: OIDC (authorization code + PKCE) at /auth/oidc, back at /auth/oidc.callback. With
//    `?client=desktop`, the callback hands the app a one-time token at /desktop-redirect, which the app
//    swaps for a session at /auth/redirect (the `accessToken` cookie it reads from the answer).
//
// Session tokens and API keys are random; only their SHA-256 is stored.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DEV_LOGIN_USER, PUBLIC_URL, SECRET_KEY, SECURE_COOKIES, SESSION_IDLE_DAYS, oidc } from "./config.ts";
import { sql } from "./db.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { ApiError, clientIp, unauthenticated } from "./http.ts";
import { createUser, currentTeam, getUser, type UserRow } from "./users.ts";

export interface Caller {
  user: UserRow;
  /** How the request authenticated: the session cookie, a bearer session token, or an API key. */
  via: "cookie" | "bearer" | "apiKey";
  sessionId: string | null;
}

export type AppEnv = { Variables: { caller: Caller | null } };

const ACCESS_COOKIE = "accessToken";
export const CSRF_COOKIE = SECURE_COOKIES ? "__Host-csrfToken" : "csrfToken";
const DAY = 24 * 60 * 60_000;

// ---------- Sessions ----------

async function startSession(c: Context, user: UserRow, client: "web" | "desktop"): Promise<string> {
  const token = randomToken();
  await sql`
    INSERT INTO sessions (id, user_id, client, user_agent, ip, expires_at)
    VALUES (${sha256(token)}, ${user.id}, ${client}, ${(c.req.header("User-Agent") ?? "").slice(0, 300)}, ${clientIp(c)},
            ${new Date(Date.now() + SESSION_IDLE_DAYS * DAY)})`;
  await sql`UPDATE users SET last_signed_in_at = now(), last_active_at = now() WHERE id = ${user.id}`;
  setCookie(c, ACCESS_COOKIE, token, { httpOnly: true, secure: SECURE_COOKIES, sameSite: "Lax", path: "/", maxAge: 400 * 24 * 60 * 60 });
  return token;
}

async function sessionUser(token: string, c: Context): Promise<{ user: UserRow; sessionId: string } | null> {
  const [s] = await sql<{ id: string; userId: string; expiresAt: Date; lastSeenAt: Date }[]>`
    SELECT id, user_id, expires_at, last_seen_at FROM sessions WHERE id = ${sha256(token)}`;
  if (!s || s.expiresAt < new Date()) return null;
  const user = await getUser(s.userId);
  if (!user || user.deletedAt || user.suspendedAt) return null;
  // Slide the idle expiry and the user's last activity, at most once a minute.
  if (Date.now() - s.lastSeenAt.getTime() > 60_000) {
    await sql`UPDATE sessions SET last_seen_at = now(), expires_at = ${new Date(Date.now() + SESSION_IDLE_DAYS * DAY)}, ip = ${clientIp(c)} WHERE id = ${s.id}`;
    await sql`UPDATE users SET last_active_at = now(), last_active_ip = ${clientIp(c)} WHERE id = ${user.id}`;
  }
  return { user, sessionId: s.id };
}

async function apiKeyUser(token: string): Promise<UserRow | null> {
  const [k] = await sql<{ id: string; userId: string; expiresAt: Date | null; lastActiveAt: Date | null }[]>`
    SELECT id, user_id, expires_at, last_active_at FROM api_keys WHERE hash = ${sha256(token)} AND deleted_at IS NULL`;
  if (!k || (k.expiresAt && k.expiresAt < new Date())) return null;
  const user = await getUser(k.userId);
  if (!user || user.deletedAt || user.suspendedAt) return null;
  if (!k.lastActiveAt || Date.now() - k.lastActiveAt.getTime() > 5 * 60_000) await sql`UPDATE api_keys SET last_active_at = now() WHERE id = ${k.id}`;
  return user;
}

/** The user behind a raw Cookie header's accessToken (the realtime socket's upgrade request). */
export async function userFromCookieHeader(header: string | undefined): Promise<UserRow | null> {
  const token = header
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${ACCESS_COOKIE}=`))
    ?.slice(ACCESS_COOKIE.length + 1);
  if (!token) return null;
  const [s] = await sql<{ userId: string; expiresAt: Date }[]>`SELECT user_id, expires_at FROM sessions WHERE id = ${sha256(decodeURIComponent(token))}`;
  if (!s || s.expiresAt < new Date()) return null;
  const user = await getUser(s.userId);
  return user && !user.deletedAt && !user.suspendedAt ? user : null;
}

/** Who's calling (or null), from the bearer token or the session cookie. */
export async function identify(c: Context): Promise<Caller | null> {
  const header = c.req.header("Authorization");
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) {
    if (bearer.startsWith("ol_api_")) {
      const user = await apiKeyUser(bearer);
      if (!user) throw unauthenticated("Invalid API key");
      return { user, via: "apiKey", sessionId: null };
    }
    const s = await sessionUser(bearer, c);
    if (!s) throw unauthenticated();
    return { user: s.user, via: "bearer", sessionId: s.sessionId };
  }
  const cookie = getCookie(c, ACCESS_COOKIE);
  if (!cookie) return null;
  const s = await sessionUser(cookie, c);
  return s ? { user: s.user, via: "cookie", sessionId: s.sessionId } : null;
}

// ---------- CSRF (cookie-authenticated writes only) ----------

/** Gives a browser its CSRF cookie on page loads (any GET), as Outline does. */
export async function csrfCookie(c: Context, next: Next) {
  await next();
  if (c.req.method === "GET" && !getCookie(c, CSRF_COOKIE)) {
    setCookie(c, CSRF_COOKIE, randomToken(24), { secure: SECURE_COOKIES, sameSite: "Lax", path: "/", maxAge: 400 * 24 * 60 * 60 });
  }
}

/** The x-csrf-token header must repeat the cookie on a cookie-authenticated write. */
export function checkCsrf(c: Context, caller: Caller | null) {
  if (!caller || caller.via !== "cookie") return;
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header("x-csrf-token");
  if (!cookie || !header || cookie.length !== header.length || !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
    throw new ApiError("csrf_error", "CSRF token missing or invalid");
  }
}

// ---------- Signed tokens (collaboration) ----------

const sign = (payload: string) => createHmac("sha256", SECRET_KEY).update(payload).digest("base64url");

/** A token the collaboration server accepts for 24 hours (auth.info's collaborationToken). */
export function collaborationToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, t: "collaboration", exp: Date.now() + DAY })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The user a collaboration token belongs to, or null when it's forged or expired. */
export function verifyCollaborationToken(token: string): string | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u: string; t: string; exp: number };
    return p.t === "collaboration" && p.exp > Date.now() ? p.u : null;
  } catch {
    return null;
  }
}

// ---------- OIDC ----------

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  issuer: string;
}
let discovery: Promise<Discovery> | null = null;
function discover(): Promise<Discovery> {
  if (!oidc) throw new ApiError("not_found", "Single sign-on isn't configured");
  const url = `${oidc.issuer}/.well-known/openid-configuration`;
  discovery ??= fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed (${r.status} from ${url}): check OIDC_ISSUER`);
      return r.json() as Promise<Discovery>;
    })
    .catch((e) => {
      discovery = null;
      throw e;
    });
  return discovery;
}

const challenge = (verifier: string) => createHash("sha256").update(verifier).digest().toString("base64url");

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Malformed ID token");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

interface Claims {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  groups?: string[];
  [claim: string]: unknown;
}

/**
 * The user behind a provider identity: by the identity itself, then (an account imported from Outline,
 * or invited) by email. A new identity gets an account in the workspace.
 */
async function oidcUser(claims: Claims): Promise<UserRow> {
  const cfg = oidc!;
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  if (cfg.allowedGroups.length && !groups.some((g) => cfg.allowedGroups.includes(g))) throw new Error("Your account isn't allowed to use this workspace.");

  const [linked] = await sql<{ userId: string }[]>`SELECT user_id FROM user_authentications WHERE provider = 'oidc' AND provider_id = ${claims.sub}`;
  if (linked) {
    await sql`UPDATE user_authentications SET last_validated_at = now() WHERE provider = 'oidc' AND provider_id = ${claims.sub}`;
    const user = await getUser(linked.userId);
    if (user && !user.deletedAt) {
      if (user.suspendedAt) throw new Error("Your account has been suspended.");
      return user;
    }
  }

  const team = await currentTeam();
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  if (email) {
    const [byEmail] = await sql<{ id: string }[]>`SELECT id FROM users WHERE team_id = ${team.id} AND lower(email) = ${email} AND deleted_at IS NULL`;
    if (byEmail) {
      await sql`INSERT INTO user_authentications (user_id, provider, provider_id, last_validated_at) VALUES (${byEmail.id}, 'oidc', ${claims.sub}, now()) ON CONFLICT DO NOTHING`;
      const user = (await getUser(byEmail.id))!;
      if (user.suspendedAt) throw new Error("Your account has been suspended.");
      return user;
    }
  }

  if (team.inviteRequired) throw new Error("You need an invitation to join this workspace.");
  if (email && team.allowedDomains.length && !team.allowedDomains.includes(email.split("@")[1])) throw new Error("Your email domain isn't allowed in this workspace.");
  const fallbackName = typeof claims[cfg.usernameClaim] === "string" ? (claims[cfg.usernameClaim] as string) : email?.split("@")[0];
  const user = await createUser({ teamId: team.id, name: claims.name || fallbackName || "User", email, avatarUrl: typeof claims.picture === "string" ? claims.picture : null });
  await sql`INSERT INTO user_authentications (user_id, provider, provider_id, last_validated_at) VALUES (${user.id}, 'oidc', ${claims.sub}, now())`;
  return user;
}

// ---------- Routes (/auth/…, outside the API like Outline's) ----------

export const authRoutes = new Hono<AppEnv>();

/** Where a failed sign-in lands: the app's sign-in page shows the message. */
const fail = (c: Context, message: string) => c.redirect(`/?notice=${encodeURIComponent(message)}`);

authRoutes.get("/oidc", async (c) => {
  const d = await discover();
  const state = randomToken(24);
  const verifier = randomToken(48);
  const nonce = randomToken(16);
  const client = c.req.query("client") === "desktop" ? "desktop" : "web";
  await sql`DELETE FROM oidc_states WHERE expires_at < now()`;
  await sql`INSERT INTO oidc_states (state, verifier, nonce, client, expires_at) VALUES (${state}, ${verifier}, ${nonce}, ${client}, ${new Date(Date.now() + 10 * 60_000)})`;
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: oidc!.clientId,
    redirect_uri: oidc!.redirectUri,
    scope: oidc!.scopes,
    state,
    nonce,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(url.toString());
});

authRoutes.get("/oidc.callback", async (c) => {
  const { code, state, error, error_description } = c.req.query();
  if (error) return fail(c, error_description || error);
  if (!code || !state) return fail(c, "The sign-in response was incomplete.");
  const [saved] = await sql<{ verifier: string; nonce: string; client: string }[]>`
    DELETE FROM oidc_states WHERE state = ${state} AND expires_at > now() RETURNING verifier, nonce, client`;
  if (!saved) return fail(c, "This sign-in link has expired. Try again.");
  try {
    const d = await discover();
    const tokenRes = await fetch(d.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: oidc!.redirectUri,
        client_id: oidc!.clientId,
        client_secret: oidc!.clientSecret,
        code_verifier: saved.verifier,
      }),
    });
    const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; id_token?: string; error_description?: string };
    if (!tokenRes.ok || !token.access_token || !token.id_token) throw new Error(token.error_description ?? `Token exchange failed (${tokenRes.status})`);
    // Straight from the token endpoint over TLS: checking the claims is enough (OIDC Core 3.1.3.7).
    const id = decodeJwt(token.id_token);
    const aud = Array.isArray(id.aud) ? id.aud : [id.aud];
    if (id.iss !== d.issuer || !aud.includes(oidc!.clientId) || id.nonce !== saved.nonce) throw new Error("The ID token doesn't match this app");
    const infoRes = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${token.access_token}` } });
    const info = (await infoRes.json().catch(() => ({}))) as Claims;
    if (!infoRes.ok || info.sub !== id.sub) throw new Error("Couldn't read your profile from the provider");
    const user = await oidcUser({ ...info, groups: info.groups ?? (id.groups as string[] | undefined) });

    if (saved.client === "desktop") {
      const transfer = randomToken();
      await sql`INSERT INTO transfer_tokens (id, user_id, expires_at) VALUES (${sha256(transfer)}, ${user.id}, ${new Date(Date.now() + 5 * 60_000)})`;
      return c.redirect(`/desktop-redirect?token=${encodeURIComponent(transfer)}`);
    }
    await startSession(c, user, "web");
    return c.redirect("/");
  } catch (e) {
    console.warn("OIDC sign-in failed:", e);
    return fail(c, e instanceof Error ? e.message : "Sign-in failed");
  }
});

/** Desktop: swaps the one-time token for a session, answered as the accessToken cookie. */
authRoutes.get("/redirect", async (c) => {
  const token = c.req.query("token");
  if (!token) return fail(c, "The sign-in link is incomplete.");
  const [t] = await sql<{ userId: string }[]>`DELETE FROM transfer_tokens WHERE id = ${sha256(token)} AND expires_at > now() RETURNING user_id`;
  const user = t && (await getUser(t.userId));
  if (!user || user.deletedAt || user.suspendedAt) return fail(c, "This sign-in link has expired. Try again.");
  await startSession(c, user, "desktop");
  return c.redirect("/");
});

/** Local development only (see DEV_LOGIN_USER): signs in without the identity provider. */
authRoutes.get("/dev", async (c) => {
  if (!DEV_LOGIN_USER) throw new ApiError("not_found", "Resource not found");
  const team = await currentTeam();
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM users WHERE team_id = ${team.id} AND lower(email) = ${`${DEV_LOGIN_USER}@localhost`.toLowerCase()}`;
  const user = existing ? (await getUser(existing.id))! : await createUser({ teamId: team.id, name: DEV_LOGIN_USER, email: `${DEV_LOGIN_USER}@localhost`, avatarUrl: null });
  await startSession(c, user, "web");
  return c.redirect("/");
});

/** The page the desktop app's sign-in window lands on: the app reads the token from its address. */
export function desktopRedirectPage(token: string): string {
  const host = new URL(PUBLIC_URL).host;
  const link = `outline://${host}/auth/redirect?token=${encodeURIComponent(token)}`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed in</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#333}a{color:#0366d6}</style></head>
<body><p>Signed in. <a href="${esc(link)}">Return to the app</a>.</p><script>location.href=${JSON.stringify(link)}</script></body></html>`;
}

/** Signs this session out (auth.delete): Outline signs the user out of every session. */
export async function signOutEverywhere(c: Context, userId: string) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  deleteCookie(c, ACCESS_COOKIE, { path: "/", secure: SECURE_COOKIES });
}

/** Expired sessions, sign-in attempts and transfer tokens, cleaned up hourly. */
export function cleanUpAuth() {
  void sql`DELETE FROM sessions WHERE expires_at < now()`.catch(() => {});
  void sql`DELETE FROM oidc_states WHERE expires_at < now()`.catch(() => {});
  void sql`DELETE FROM transfer_tokens WHERE expires_at < now()`.catch(() => {});
}
