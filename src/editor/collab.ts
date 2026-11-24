// Live collaboration with Outline's Hocuspocus server (protocol v1, same as Outline's web app).

import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import type { Schema } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { absolutePositionToRelativePosition, prosemirrorJSONToYXmlFragment, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import { EDITOR_VERSION, schema } from "./schema";
import { demoContent, isDemo } from "../lib/demo";

export type CollabStatus = "connecting" | "connected" | "offline" | "outdated" | "denied";

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  /** Their cursor is in the document (rather than just reading). */
  editing: boolean;
  /** Where they are in the document is known, so you can go there. */
  located: boolean;
}

/** Close codes Outline's collaboration server uses (shared/collaboration/CloseEvents.ts). */
export const CLOSE = {
  authenticationFailed: 4401,
  authorizationFailed: 4403,
  tooManyConnections: 4503,
  editorUpdate: 4999,
};

export interface Collab {
  ydoc: Y.Doc;
  fragment: Y.XmlFragment;
  provider: HocuspocusProvider;
  local: IndexeddbPersistence;
  /** Resolves once there's content to show: the server's, or the local copy when offline. */
  ready: Promise<"remote" | "local">;
  destroy: () => void;
}

interface Options {
  server: string;
  documentId: string;
  token: string;
  onStatus: (status: CollabStatus) => void;
  /** Called when the server refuses the token; return a fresh one to retry. */
  refreshToken: () => Promise<string | undefined>;
  /** How long to wait for the server before showing the local copy. */
  offlineAfterMs?: number;
}

export function connect(opts: Options): Collab {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("default");
  // Separate name from Outline's own cache, which lives on the same origin in the web build.
  const local = new IndexeddbPersistence(`notes:${isDemo ? "demo" : "document"}.${opts.documentId}`, ydoc);
  if (isDemo) void local.whenSynced.then(() => fragment.length === 0 && prosemirrorJSONToYXmlFragment(schema, demoContent(opts.documentId), fragment));
  let retries = 0;

  const provider = new HocuspocusProvider({
    url: `${opts.server.replace(/^http/, "ws")}/collaboration`,
    name: `document.${opts.documentId}`,
    document: ydoc,
    token: opts.token,
    parameters: { editorVersion: EDITOR_VERSION },
    // No cross-tab broadcasting: one window per document is all we have.
    broadcast: false,
    connect: !isDemo,
    quiet: true,
    onStatus: ({ status }) => {
      if (status === WebSocketStatus.Connected) opts.onStatus("connected");
      else if (status === WebSocketStatus.Connecting) opts.onStatus("connecting");
      else opts.onStatus("offline");
    },
    onClose: ({ event }) => {
      if (event.code === CLOSE.editorUpdate) {
        provider.shouldConnect = false;
        opts.onStatus("outdated");
      } else if (event.code === CLOSE.authorizationFailed) {
        provider.shouldConnect = false;
        opts.onStatus("denied");
      }
    },
    onAuthenticationFailed: () => {
      provider.shouldConnect = false;
      retries++;
      if (retries > 3) return opts.onStatus("denied");
      setTimeout(async () => {
        try {
          const token = await opts.refreshToken();
          if (!token) return opts.onStatus("denied");
          provider.setConfiguration({ token });
          provider.shouldConnect = true;
          await provider.connect();
        } catch {
          opts.onStatus("offline");
        }
      }, retries * 1000);
    },
    onSynced: () => {
      retries = 0;
    },
  });

  const ready = new Promise<"remote" | "local">((resolve) => {
    if (provider.isSynced) resolve("remote");
    provider.on("synced", () => resolve("remote"));
    void local.whenSynced.then(() => {
      // A copy from an earlier visit shows right away; the server's changes merge into it live
      // as they arrive. With nothing saved here, wait for the server (or, offline, give up on
      // it after a while).
      if (fragment.length > 0) return resolve("local");
      setTimeout(() => fragment.length > 0 && resolve("local"), isDemo ? 0 : (opts.offlineAfterMs ?? 2500));
    });
  });

  // Demo: a pretend collaborator, so presence can be tried without a server.
  if (isDemo)
    setTimeout(() => {
      provider.awareness.states.set(999_999, { user: { id: "u2", name: "Lisa", color: "#d7827e" } });
      (provider as unknown as { emit: (event: string, data: unknown) => void }).emit("awarenessChange", { states: [] });
    }, 800);

  return {
    ydoc,
    fragment,
    provider,
    local,
    ready,
    destroy: () => {
      provider.destroy();
      void local.destroy();
      ydoc.destroy();
    },
  };
}

// ---------- Keeping documents connected ----------
//
// Leaving a document (switching tabs, say) doesn't close its connection straight away: it stays
// in sync in the background for a while, so coming back shows it at once and up to date.

interface Entry {
  collab: Collab;
  /** Editors showing it right now (split view can show a document twice). */
  users: number;
  status: CollabStatus | null;
  listeners: Set<(status: CollabStatus) => void>;
  refreshToken: () => Promise<string | undefined>;
  /** When nobody shows it: when that started, and the timer that closes it. */
  idleSince: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, Entry>();
/** How long a document no one is looking at stays connected. */
const IDLE_MS = 10 * 60 * 1000;
/** At most this many of those (the least recently left go first). */
const MAX_IDLE = 6;

const unusable = (e: Entry) => e.status === "outdated" || e.status === "denied";

function close(key: string) {
  const e = pool.get(key);
  if (!e) return;
  clearTimeout(e.idleTimer);
  pool.delete(key);
  e.collab.destroy();
}

export interface Lease {
  collab: Collab;
  /** Done with it; `discard` closes it now instead of keeping it in the background. */
  release: (discard?: boolean) => void;
}

/**
 * The connection to a document, reused if it's still open from earlier. `userId` keeps one
 * account's connections from serving another.
 */
export function acquire(opts: Options & { userId: string }): Lease {
  const key = `${opts.server}|${opts.userId}|${opts.documentId}`;
  let e = pool.get(key);
  if (e && unusable(e)) {
    close(key);
    e = undefined;
  }
  if (!e) {
    const entry: Entry = { collab: null as unknown as Collab, users: 0, status: null, listeners: new Set(), refreshToken: opts.refreshToken, idleSince: 0 };
    entry.collab = connect({
      ...opts,
      onStatus: (status) => {
        entry.status = status;
        entry.listeners.forEach((l) => l(status));
      },
      refreshToken: () => entry.refreshToken(),
    });
    pool.set(key, entry);
    e = entry;
  } else {
    clearTimeout(e.idleTimer);
    e.refreshToken = opts.refreshToken;
  }
  const entry = e;
  entry.users++;
  entry.listeners.add(opts.onStatus);
  if (entry.status) opts.onStatus(entry.status);

  let released = false;
  return {
    collab: entry.collab,
    release: (discard = false) => {
      if (released) return;
      released = true;
      entry.listeners.delete(opts.onStatus);
      entry.users--;
      if (entry.users > 0) return;
      if (discard || unusable(entry)) return close(key);
      // Out of sight: others shouldn't see us in it any more.
      entry.collab.provider.setAwarenessField("user", null);
      entry.collab.provider.setAwarenessField("cursor", null);
      entry.idleSince = Date.now();
      entry.idleTimer = setTimeout(() => close(key), IDLE_MS);
      const idle = [...pool.entries()].filter(([, x]) => x.users === 0).sort((a, b) => a[1].idleSince - b[1].idleSince);
      for (const [k] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) close(k);
    },
  };
}

/** Closes every connection (signing out, switching account). */
export function closeAll() {
  for (const key of [...pool.keys()]) close(key);
}

/**
 * Node and mark names in the shared document that our schema doesn't know. y-prosemirror would
 * delete those from the shared document, so the editor refuses to open it instead.
 */
export function unknownTypes(fragment: Y.XmlFragment, schema: Schema): string[] {
  const unknown = new Set<string>();
  const visit = (item: Y.XmlElement | Y.XmlText | Y.XmlHook) => {
    if (item instanceof Y.XmlElement) {
      if (!schema.nodes[item.nodeName]) unknown.add(item.nodeName);
      item.toArray().forEach((child) => visit(child as Y.XmlElement | Y.XmlText));
    } else if (item instanceof Y.XmlText) {
      for (const op of item.toDelta() as { attributes?: Record<string, unknown> }[]) {
        for (const name of Object.keys(op.attributes ?? {})) {
          // y-prosemirror suffixes marks that can overlap (e.g. comment--abc123).
          const base = name.split("--")[0];
          if (!schema.marks[base]) unknown.add(base);
        }
      }
    }
  };
  fragment.toArray().forEach((child) => visit(child as Y.XmlElement | Y.XmlText));
  return [...unknown];
}

/** Other people currently in the document, one entry per user. */
export function presence(provider: HocuspocusProvider, selfId: string): PresenceUser[] {
  const users = new Map<string, PresenceUser>();
  provider.awareness.getStates().forEach((state, clientId) => {
    const user = state.user as Omit<PresenceUser, "editing" | "located"> | undefined;
    if (!user?.id || clientId === provider.awareness.clientID || user.id === selfId) return;
    // y-prosemirror publishes a cursor while their editor has focus.
    const editing = !!state.cursor || !!users.get(user.id)?.editing;
    const located = !!state.cursor?.head || !!state[LAST_CURSOR] || !!users.get(user.id)?.located;
    users.set(user.id, { id: user.id, name: user.name, color: user.color, editing, located });
  });
  return [...users.values()];
}

/**
 * Awareness field: where your cursor last was. y-prosemirror's `cursor` is cleared when the editor
 * loses focus; this one stays, so others can still go to where you are.
 */
const LAST_CURSOR = "lastCursor";

/** Asks the editor showing `documentId` to go to where `userId` is (`{ userId, documentId }`). */
export const GOTO_USER_EVENT = "notes:goto-user";

/** Shares where your cursor is now (as a Yjs position, which follows edits). */
export function shareLastCursor(view: EditorView, provider: HocuspocusProvider) {
  const y = ySyncPluginKey.getState(view.state);
  if (!y?.binding) return;
  provider.setAwarenessField(LAST_CURSOR, absolutePositionToRelativePosition(view.state.selection.head, y.type, y.binding.mapping));
}

/** Where someone is in the document: their cursor, or where it last was. */
export function userPosition(view: EditorView, provider: HocuspocusProvider, userId: string): number | null {
  const y = ySyncPluginKey.getState(view.state);
  if (!y?.binding) return null;
  let rel: unknown = null;
  provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId === provider.awareness.clientID || (state.user as { id?: string } | undefined)?.id !== userId) return;
    // A live cursor wins over a remembered one (they may have the page open twice).
    if (state.cursor?.head) rel = state.cursor.head;
    else if (!rel && state[LAST_CURSOR]) rel = state[LAST_CURSOR];
  });
  if (!rel) return null;
  const pos = relativePositionToAbsolutePosition(y.doc, y.type, Y.createRelativePositionFromJSON(rel), y.binding.mapping);
  return pos === null ? null : Math.max(0, Math.min(pos, view.state.doc.content.size));
}
