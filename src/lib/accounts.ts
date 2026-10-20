// Workspaces used on this device, for the workspace switcher and the sign-in page.
//  - What's shown (name, logo, who's signed in) is kept here, in local storage.
//  - Which ones are still signed in is up to the desktop side, which holds a session per server.

import { invoke } from "@tauri-apps/api/core";
import type { Session } from "./auth";
import { isTauri } from "./platform";

export interface Account {
  /** Origin, e.g. https://notes.example.com. */
  server: string;
  name: string;
  /** Absolute URL (it may not load while another server is in use). */
  logo: string | null;
  userName?: string;
  userEmail?: string;
  /** ISO date of the last time it was used, for ordering. */
  usedAt: string;
}

const STORAGE_KEY = "notes.accounts";

export function listAccounts(): Account[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Account[];
    return Array.isArray(list) ? list.sort((a, b) => b.usedAt.localeCompare(a.usedAt)) : [];
  } catch {
    return [];
  }
}

function saveAccounts(list: Account[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Not critical: the list only saves typing.
  }
}

/** Records (or refreshes) the workspace a session is for. */
export function rememberAccount(session: Session) {
  const logo = session.team.avatarUrl ? (session.team.avatarUrl.startsWith("/") ? `${session.server}${session.team.avatarUrl}` : session.team.avatarUrl) : null;
  const account: Account = {
    server: session.server,
    name: session.team.name,
    logo,
    userName: session.user.name,
    userEmail: session.user.email,
    usedAt: new Date().toISOString(),
  };
  saveAccounts([account, ...listAccounts().filter((a) => a.server !== session.server)]);
}

/** Servers the desktop app still has a session for. */
export async function savedSessions(): Promise<Set<string>> {
  if (!isTauri) return new Set();
  return new Set(await invoke<string[]>("saved_sessions").catch(() => [] as string[]));
}

/** Uses another workspace's saved session, then reloads the app on it. */
export async function switchWorkspace(server: string): Promise<void> {
  await invoke("switch_session", { server });
  location.reload();
}

/** Signs out of a workspace on this device and drops it from the list. */
export async function forgetWorkspace(server: string): Promise<void> {
  if (isTauri) await invoke("forget_session", { server });
  saveAccounts(listAccounts().filter((a) => a.server !== server));
}

/** "https://notes.example.com" → "notes.example.com" */
export const host = (server: string) => server.replace(/^https?:\/\//, "");
