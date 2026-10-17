// Sessions.
//  - Desktop: the Rust side holds the session token (see src-tauri/src/lib.rs). Signing in
//    opens the browser on the server's own login page and comes back through an outline:// link.
//  - Web: the app is served on Outline's origin and uses the browser's Outline session.

import { invoke } from "@tauri-apps/api/core";
import { AuthError, authInfo, ensureCsrfCookie, setServer, type AuthInfo } from "./api";
import { isTauri } from "./platform";

export interface Session extends AuthInfo {
  server: string;
}

export interface Provider {
  id: string;
  name: string;
  authUrl: string;
}

export interface ServerConfig {
  server: string;
  name: string;
  logo?: string;
  providers: Provider[];
}

/** The session from a previous run, or null if signed out. Throws when the server can't be reached. */
export async function restoreSession(): Promise<Session | null> {
  let server = location.origin;
  if (isTauri) {
    const info = await invoke<{ server: string } | null>("session_info");
    if (!info) return null;
    server = info.server;
    setServer(server);
  } else {
    await ensureCsrfCookie();
  }
  try {
    const { data } = await authInfo();
    return { ...data, server };
  } catch (e) {
    if (e instanceof AuthError) {
      if (isTauri) await invoke("sign_out").catch(() => {});
      return null;
    }
    throw e;
  }
}

/** A fresh collaboration token (they last 24h). */
export async function refreshCollaborationToken(): Promise<string | undefined> {
  return (await authInfo()).data.collaborationToken;
}

/** Desktop: what a server offers for signing in. */
export async function serverConfig(server: string): Promise<ServerConfig> {
  const res = await invoke<{ server: string; config: { name?: string; logo?: string; providers?: Provider[] } }>("auth_config", { server });
  const logo = res.config.logo ? (res.config.logo.startsWith("/") ? `${res.server}${res.config.logo}` : res.config.logo) : undefined;
  return {
    server: res.server,
    name: res.config.name ?? res.server,
    logo,
    // Email links and passkeys can't hand the session back to the app; OAuth/OIDC providers can.
    providers: (res.config.providers ?? []).filter((p) => p.id !== "email" && p.id !== "passkeys"),
  };
}

/**
 * Desktop: opens the provider's login page (in a window of the app, or the system browser) and
 * resolves once Outline hands the session back.
 */
export async function signIn(server: string, provider: Provider, viaBrowser = false): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  const done = new Promise<void>((resolve, reject) => {
    const unlisten: (() => void)[] = [];
    const finish = () => unlisten.forEach((u) => u());
    void listen("signed-in", () => {
      finish();
      resolve();
    }).then((u) => unlisten.push(u));
    void listen<string>("sign-in-failed", (e) => {
      finish();
      reject(new Error(e.payload));
    }).then((u) => unlisten.push(u));
  });
  await invoke(viaBrowser ? "sign_in_with_browser" : "sign_in", { server, authPath: provider.authUrl });
  await done;
}

export async function signOut(): Promise<void> {
  if (isTauri) await invoke("sign_out");
  else location.href = "/";
}
