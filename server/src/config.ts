// Server configuration, read once from the environment (see server/.env.example).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name} (see server/.env.example)`);
  return value;
}

const flag = (name: string, fallback: boolean) => {
  const v = process.env[name]?.trim().toLowerCase();
  return v ? v === "true" || v === "1" || v === "yes" : fallback;
};

const list = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Where the workspace is reachable, e.g. https://notes.bayfield.dev (the team's `url`, OIDC redirects). */
export const PUBLIC_URL = required("PUBLIC_URL").replace(/\/+$/, "");
export const PORT = Number(process.env.PORT ?? 8792);
export const DATABASE_URL = required("DATABASE_URL");
export const DIST_DIR = resolve(process.env.DIST_DIR ?? resolve(import.meta.dirname, "../../dist"));
export const SECURE_COOKIES = PUBLIC_URL.startsWith("https://");

/**
 * Signs collaboration tokens and other short-lived tokens. At least 32 characters; changing it
 * signs every editor out of live collaboration (they reconnect with a new token).
 */
export const SECRET_KEY = (() => {
  const v = required("SECRET_KEY");
  if (v.length < 32) throw new Error("SECRET_KEY should be at least 32 characters (openssl rand -hex 32)");
  return v;
})();

/** Uploaded files (attachments, avatars, exports): a folder on a volume, as Outline's local storage. */
export const FILE_STORAGE_DIR = resolve(process.env.FILE_STORAGE_DIR ?? resolve(import.meta.dirname, "../data/files"));
/** The largest upload accepted, in bytes (Outline's FILE_STORAGE_UPLOAD_MAX_SIZE). */
export const UPLOAD_MAX_SIZE = Number(process.env.FILE_STORAGE_UPLOAD_MAX_SIZE ?? 262_144_000);

/** Set by the Docker build; when running from a checkout, the root package.json's version. */
export const APP_VERSION = (() => {
  const env = process.env.APP_VERSION?.trim();
  if (env && env !== "dev") return env;
  try {
    return (JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as { version?: string }).version ?? "dev";
  } catch {
    return "dev";
  }
})();

/** The workspace language for new accounts (Outline's DEFAULT_LANGUAGE, e.g. fr_FR). */
export const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE?.trim() || "en_US";

/**
 * Local development only: signs straight in as this user, without the identity provider.
 * Ignored unless PUBLIC_URL is localhost, so it can't be switched on in production by mistake.
 */
export const DEV_LOGIN_USER = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(PUBLIC_URL) ? process.env.DEV_LOGIN_USER?.trim() || null : null;

if (!process.env.OIDC_ISSUER && !DEV_LOGIN_USER) {
  throw new Error("Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET: Notes signs in through your identity provider (see server/.env.example)");
}

/** Sign in with Authentik (or any OIDC provider), as Outline's OIDC integration does. */
export const oidc = process.env.OIDC_ISSUER
  ? {
      issuer: process.env.OIDC_ISSUER.trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\/+$/, ""),
      clientId: required("OIDC_CLIENT_ID"),
      clientSecret: required("OIDC_CLIENT_SECRET"),
      /** Shown on the sign-in button (Outline's OIDC_DISPLAY_NAME). */
      name: process.env.OIDC_DISPLAY_NAME?.trim() || "OpenID Connect",
      /** Outline's callback path, so the provider's settings don't change when switching servers. */
      redirectUri: `${PUBLIC_URL}/auth/oidc.callback`,
      scopes: process.env.OIDC_SCOPES?.trim() || "openid profile email",
      /** The claim new accounts take their name from when there's no `name` (Outline's OIDC_USERNAME_CLAIM). */
      usernameClaim: process.env.OIDC_USERNAME_CLAIM?.trim() || "preferred_username",
      /** Where signing out of the provider happens (Outline's OIDC_LOGOUT_URI), if anywhere. */
      logoutUri: process.env.OIDC_LOGOUT_URI?.trim() || null,
      /** If set, only members of one of these groups (the `groups` claim) may sign in. */
      allowedGroups: list("OIDC_ALLOWED_GROUPS"),
    }
  : null;

/**
 * Other workspaces live at "<subdomain>.<WORKSPACE_DOMAIN>" (a wildcard DNS record and certificate
 * pointing here), or at custom domains. Unset: only custom domains (and the main address).
 */
export const WORKSPACE_DOMAIN = process.env.WORKSPACE_DOMAIN?.trim().toLowerCase().replace(/^\.+|\/+$/g, "") || null;

/** Who may create workspaces (teams.create): "admins" of any workspace (default), or "none". */
export const WORKSPACE_CREATION = process.env.WORKSPACE_CREATION?.trim().toLowerCase() === "none" ? "none" : "admins";

/**
 * Redis, for several instances: a document open on two of them stays in sync through it (Outline's
 * REDIS_URL). Unset: one instance (everything else is shared through Postgres).
 */
export const REDIS_URL = process.env.REDIS_URL?.trim() || null;

/** Header your reverse proxy puts the visitor IP in (e.g. cf-connecting-ip). Unset: the TCP peer. */
export const CLIENT_IP_HEADER = process.env.CLIENT_IP_HEADER?.toLowerCase();

/** How long a session lasts without being used. */
export const SESSION_IDLE_DAYS = Number(process.env.SESSION_IDLE_DAYS ?? 90);

/** Look on GitHub for a newer release. */
export const UPDATE_CHECK = flag("UPDATE_CHECK", true);
