// Live collaboration with Outline's Hocuspocus server (protocol v1, same as Outline's web app).

import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import type { Schema } from "prosemirror-model";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import { EDITOR_VERSION, schema } from "./schema";
import { demoContent, isDemo } from "../lib/demo";

export type CollabStatus = "connecting" | "connected" | "offline" | "outdated" | "denied";

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  /** Their cursor is in the document (rather than just reading). */
  editing: boolean;
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
    void local.whenSynced.then(() =>
      setTimeout(() => {
        // Only fall back to the cache if it actually has something.
        if (fragment.length > 0) resolve("local");
      }, isDemo ? 0 : (opts.offlineAfterMs ?? 2500)),
    );
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
    const user = state.user as Omit<PresenceUser, "editing"> | undefined;
    if (!user?.id || clientId === provider.awareness.clientID || user.id === selfId) return;
    // y-prosemirror publishes a cursor while their editor has focus.
    const editing = !!state.cursor || !!users.get(user.id)?.editing;
    users.set(user.id, { id: user.id, name: user.name, color: user.color, editing });
  });
  return [...users.values()];
}
