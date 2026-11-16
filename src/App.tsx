import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { EditorView } from "prosemirror-view";
import { AuthError, createDocument, type Team, moveCollection, moveDocument, publishDocument, usersByIds, type Doc, type User } from "./lib/api";
import { refreshCollaborationToken, restoreSession, signOut, type Session } from "./lib/auth";
import { isMac, isTauri, isWindows, openExternal } from "./lib/platform";
import { canInstallUpdates, installStatus, useInstallUpdate, useUpdateCheck } from "./lib/updates";
import { parseRoute, parseTabPath, routePath, tabPath, useTabs, type Route } from "./lib/router";
import { SettingsProvider, forServer, useSettings } from "./lib/settings";
import { rememberAccount } from "./lib/accounts";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { clearTray, useDesktopSync, useTrayRecents } from "./lib/desktop";
import { MOBILE_QUERY, useMediaQuery } from "./lib/useMediaQuery";
import { useWorkspace } from "./lib/workspace";
import type { EditorStatus, Heading } from "./editor/Editor";
import type { PresenceUser } from "./editor/collab";
import { OPEN_COLLECTION_EVENT } from "./editor/nodeviews";
import { closeAll as closeAllCollab } from "./editor/collab";
import { Sidebar, type DocTarget, type DropTarget } from "./components/Sidebar";
import { DropdownMenu, PublishButton, Toolbar, type Crumb } from "./components/Toolbar";
import { useDocumentActions } from "./components/DocumentActions";
import { menu as tidyMenu, type MenuEntry } from "./components/Menu";
import { editorAt } from "./editor/registry";
import { DocumentView, type DocMeta } from "./components/DocumentView";
import { CollectionView, Home } from "./components/Home";
import { SearchDialog } from "./components/SearchDialog";
import { SettingsDialog, type SettingsPage } from "./components/SettingsDialog";
import { Panel, type PanelTab } from "./components/Panel";
import { contextMenuFor } from "./components/appContextMenu";
import { Tooltips } from "./components/Tooltips";
import { ErrorStack, useErrors } from "./components/Errors";
import { ContextMenu } from "./components/ContextMenu";
import { SignIn } from "./components/SignIn";
import { DocListPage } from "./components/DocListPage";
import { ShareButton } from "./components/ShareButton";
import { DatePickerHost } from "./components/DatePicker";
import { MediaHost } from "./components/MediaHost";
import { TabBar, type TabInfo } from "./components/TabBar";
import { Pane } from "./components/Pane";
import { EntityIcon } from "./components/EntityIcon";
import { Archive, FileText, Home as HomeIcon, Pencil, Trash } from "./components/icons";
import { NotificationsButton, type BadgeStyle } from "./components/NotificationsButton";
import { setSmartText } from "./editor/rules";

/** Desktop on Windows: WebView2's spelling suggestions are added to the editor's right-click menu. */
const NATIVE_SPELLING = isTauri && isWindows;

export default function App() {
  return (
    <SettingsProvider>
      <Root />
    </SettingsProvider>
  );
}

type Status = "loading" | "signedOut" | "ready" | "unreachable";

function Root() {
  const { t, update } = useSettings();
  const [status, setStatus] = useState<Status>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Signing in to another workspace while staying signed in to this one. */
  const [adding, setAdding] = useState<{ server?: string } | null>(null);

  const restore = useCallback(() => {
    setStatus("loading");
    restoreSession()
      .then((s) => {
        // Same render as the app's first: it opens on this server's last page.
        if (s) update((prev) => forServer(prev, s.server));
        setSession(s);
        setStatus(s ? "ready" : "signedOut");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("unreachable");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(restore, [restore]);
  // The workspace list shows each one's current name, logo and account.
  useEffect(() => {
    if (session) rememberAccount(session);
  }, [session?.server, session?.team.name, session?.team.avatarUrl, session?.user.name, session?.user.email]);
  // Stable, so updating the user doesn't re-run everything that depends on these.
  const onUserChange = useCallback((patch: Partial<User>) => setSession((s) => s && { ...s, user: { ...s.user, ...patch } }), []);
  const onTeamChange = useCallback((team: Team) => setSession((s) => s && { ...s, team }), []);
  const onSignedOut = useCallback(() => {
    setSession(null);
    setStatus("signedOut");
  }, []);
  const onAddWorkspace = useCallback((server?: string) => setAdding({ server }), []);
  // The editor follows the user's smart text preference, kept in Outline.
  const userPreferences = session?.user.preferences;
  useEffect(() => setSmartText(userPreferences), [userPreferences]);

  if (status === "loading") return <div className="splash" data-tauri-drag-region />;
  if (status === "unreachable")
    return (
      <div className="signin" data-tauri-drag-region>
        <div className="signin-card">
          <p className="error-text">{error}</p>
          <button className="primary-button" onClick={restore}>
            {t("retry")}
          </button>
          {/* The server may be gone for good: other workspaces are still reachable. */}
          {isTauri && (
            <button className="link-button" onClick={() => setStatus("signedOut")}>
              {t("switchWorkspace")}
            </button>
          )}
        </div>
      </div>
    );
  if (status === "signedOut" || !session) return <SignIn error={error} onSignedIn={restore} />;
  return (
    <>
      <NotesApp session={session} onUserChange={onUserChange} onTeamChange={onTeamChange} onSignedOut={onSignedOut} onAddWorkspace={onAddWorkspace} />
      {/* Over the app, so cancelling leaves it as it was. Once signed in, start over on the new
          workspace so nothing from this one carries over. */}
      {adding && (
        <div className="signin-overlay">
          <SignIn error={null} current={session.server} start={adding.server} onSignedIn={() => location.reload()} onCancel={() => setAdding(null)} />
        </div>
      )}
    </>
  );
}


function NotesApp({
  session,
  onSignedOut,
  onUserChange,
  onTeamChange,
  onAddWorkspace,
}: {
  session: Session;
  onSignedOut: () => void;
  onUserChange: (patch: Partial<User>) => void;
  onTeamChange: (team: Team) => void;
  onAddWorkspace: (server?: string) => void;
}) {
  const { t, settings, update } = useSettings();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const wide = useMediaQuery("(min-width: 1100px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const errors = useErrors();
  const [toast, setToast] = useState<{ message: string; undo?: () => void; label?: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  /** The open settings page, if any. */
  const [settingsOpen, setSettingsOpen] = useState<SettingsPage | true | false>(false);
  /** The open right-click menu. `onDismiss` runs when it closes, whatever closed it. */
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[]; onDismiss?: () => void } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [docStatus, setDocStatus] = useState<EditorStatus | undefined>();
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [collaborators, setCollaborators] = useState<User[]>([]);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [token, setToken] = useState(session.collaborationToken ?? "");
  const [freshDocId, setFreshDocId] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("contents");
  const [draftComment, setDraftComment] = useState<string | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [docTick, setDocTick] = useState(0);
  /** Each pane's editor (split view has two); `viewRef` is the focused one's. */
  const paneViews = useRef<RefObject<EditorView | null>[]>([{ current: null }, { current: null }]).current;
  const focusRef = useRef(0);
  const viewRef = useMemo<RefObject<EditorView | null>>(
    () => ({
      get current() {
        return paneViews[focusRef.current].current;
      },
      set current(v) {
        paneViews[focusRef.current].current = v;
      },
    }),
    [paneViews],
  );
  /** A comment to show once its page opens (from a notification). */
  const pendingComment = useRef<string | null>(null);

  const onError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) {
        void signOut().finally(onSignedOut);
        return;
      }
      errors.push(e instanceof Error ? e.message : String(e));
    },
    [onSignedOut, errors.push],
  );

  const workspace = useWorkspace(onError);
  const updates = useUpdateCheck();
  const installer = useInstallUpdate();
  const newRelease = updates.state.status === "available" && updates.state.release.version !== settings.skippedUpdate ? updates.state.release : null;
  useDesktopSync(settings.closeToTray, settings.startMinimized, t);
  // Reopens the tabs that were open (or, before tabs, the last page visited).
  const router = useTabs(
    settings.tabs.length ? settings.tabs.map(parseTabPath) : [[settings.lastPath ? parseRoute(settings.lastPath) : { name: "home" }]],
    settings.activeTab,
  );
  const { route, navigate } = router;
  focusRef.current = router.tab.focus;
  const split = router.tab.panes.length > 1;
  /** The page reopened on launch, until it loads: if it's gone, go home instead. */
  const reopened = useRef(route.name === "doc" ? route.id : null);

  const { openTab } = router;
  /** Opens a page here, or in a new tab behind this one (`newTab`: Ctrl+click, middle click). */
  const go = useCallback(
    (r: Route, newTab = false) => {
      if (newTab) openTab(r, false);
      else navigate(r);
      if (mobile) setDrawerOpen(false);
    },
    [navigate, openTab, mobile],
  );

  // People who have edited the open page, for the header (hidden when insights are off, as in Outline).
  const collaboratorKey = meta && meta.doc.insightsEnabled !== false ? (meta.doc.collaboratorIds ?? []).join(",") : "";
  useEffect(() => {
    if (!collaboratorKey) return setCollaborators([]);
    let cancelled = false;
    usersByIds(collaboratorKey.split(","))
      .then((users) => !cancelled && setCollaborators(users))
      .catch(() => !cancelled && setCollaborators([]));
    return () => {
      cancelled = true;
    };
  }, [collaboratorKey]);

  // Remember the open tabs for next time.
  const tabPaths = JSON.stringify(router.tabs.map(tabPath));
  useEffect(() => {
    update({ tabs: JSON.parse(tabPaths) as string[], activeTab: router.active });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabPaths, router.active]);

  // Split view: what each pane's document reported, so the toolbar and panel can follow the
  // focus from one side to the other without reloading anything.
  const paneState = useRef(new Map<string, { meta?: DocMeta | null; headings?: Heading[]; status?: EditorStatus; presence?: PresenceUser[] }>());
  const paneKey = (pane: number) => `${router.tab.id}:${pane}`;
  const focusKey = paneKey(router.tab.focus);
  useEffect(() => {
    const st = paneState.current.get(focusKey);
    const m = st?.meta && route.name === "doc" && (st.meta.doc.id === route.id || st.meta.doc.urlId === route.id) ? st.meta : null;
    setMeta(m);
    setHeadings(m ? (st?.headings ?? []) : []);
    setDocStatus(m ? st?.status : undefined);
    setPresence(m ? (st?.presence ?? []) : []);
    setDocTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // Remember where we were, and reset per-document state when leaving a document.
  useEffect(() => {
    update({ lastPath: routePath(route) });
    if (route.name !== "doc") {
      setMeta(null);
      setDocStatus(undefined);
      setPresence([]);
      setHeadings([]);
    }
    setDraftComment(null);
    setActiveComment(pendingComment.current);
    if (pendingComment.current) {
      setPanelTab("comments");
      update({ panel: true });
    }
    pendingComment.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  const openComment = (documentId: string, commentId: string) => {
    if (route.name === "doc" && meta?.doc.id === documentId) {
      setActiveComment(commentId);
      setPanelTab("comments");
      update({ panel: true });
      return;
    }
    pendingComment.current = commentId;
    go({ name: "doc", id: documentId });
  };

  const refreshToken = useCallback(async () => {
    const next = await refreshCollaborationToken();
    if (next) setToken(next);
    return next;
  }, []);

  // Open the tree down to the current document.
  const located = meta ? workspace.locate(meta.doc.id) : undefined;
  useEffect(() => {
    if (!located) return;
    const ids = located.path.map((n) => n.id);
    if (ids.some((id) => !settings.expanded.includes(id)) || settings.folded.includes(located.collection.id))
      update((s) => ({
        expanded: [...new Set([...s.expanded, ...ids])],
        folded: s.folded.filter((k) => k !== located.collection.id),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [located?.node.id]);

  // The tray lists recently viewed pages; picking one opens it.
  useTrayRecents(meta?.doc.id, t("untitled"), (id) => go({ name: "doc", id }));

  // Window title follows the document.
  const docTitle = meta ? meta.doc.title || t("untitled") : null;
  useEffect(() => {
    const title = docTitle ? `${docTitle} · Notes` : "Notes";
    document.title = title;
    if (isTauri) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(() => {});
  }, [docTitle]);

  useEffect(() => {
    // Undo toasts are closed by their action; other actions (e.g. a download) stay a while.
    if (!toast || (toast.undo && !toast.label)) return;
    const id = setTimeout(() => setToast(null), toast.undo ? 15000 : 2500);
    return () => clearTimeout(id);
  }, [toast]);

  // ---------- Document actions ----------

  const newDoc = useCallback(
    async (collectionId?: string, parentDocumentId?: string) => {
      const target = collectionId ?? meta?.doc.collectionId ?? (route.name === "collection" ? route.id : undefined) ?? workspace.collections[0]?.id;
      if (!target) return;
      try {
        const doc = await createDocument({ collectionId: target, parentDocumentId: parentDocumentId ?? null });
        setFreshDocId(doc.id);
        go({ name: "doc", id: doc.id });
        void workspace.refreshCollection(doc.collectionId ?? target);
      } catch (e) {
        onError(e);
      }
    },
    [meta, route, workspace, go, onError],
  );

  /** A short message, optionally with a button (`undo`, labelled `label` or "Undo"). */
  const flash = useCallback((message: string, undo?: () => void, label?: string) => {
    if (!message) return setToast(null);
    setToast({
      message,
      label,
      undo: undo
        ? () => {
            setToast(null);
            undo();
          }
        : undefined,
    });
  }, []);

  const openPanel = (tab: PanelTab) => {
    setPanelTab(tab);
    update({ panel: true });
  };

  const actions = useDocumentActions({
    workspace,
    me: session.user,
    meta,
    viewRef,
    go,
    openSplit: router.openSplit,
    newDoc,
    onError,
    flash,
    openPanel,
    reloadDoc: () => setReloadKey((n) => n + 1),
  });

  /** Sidebar drag and drop: works out the new parent and position, then asks Outline to move it. */
  const moveDoc = async (id: string, target: DropTarget) => {
    const from = workspace.locate(id);
    let collectionId: string;
    let parentId: string | null;
    let index: number | undefined;
    if (target.kind === "collection") {
      collectionId = target.id;
      parentId = null;
    } else {
      const to = workspace.locate(target.id);
      if (!to) return;
      collectionId = to.collection.id;
      if (target.zone === "inside") {
        parentId = to.node.id;
        // Show where it went.
        if (!settings.expanded.includes(to.node.id)) update((s) => ({ expanded: [...s.expanded, to.node.id] }));
      } else {
        parentId = to.path[to.path.length - 1]?.id ?? null;
        // `index` counts the siblings as they are now, the moved document included: when it moves
        // down under the same parent, Outline subtracts one itself after taking it out.
        const siblings = parentId ? to.path[to.path.length - 1].children : workspace.trees[collectionId] ?? [];
        const at = siblings.findIndex((n) => n.id === target.id);
        index = at + (target.zone === "after" ? 1 : 0);
      }
    }
    try {
      await moveDocument(id, collectionId, parentId, index);
    } catch (e) {
      onError(e);
    }
    void workspace.refreshCollection(collectionId);
    if (from && from.collection.id !== collectionId) void workspace.refreshCollection(from.collection.id);
  };

  const openContextMenu = (target: DocTarget, e: MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: actions.treeMenu(target) });
  };

  /** Sidebar drag and drop of a collection: Outline orders them by a fractional index. */
  const reorderCollection = async (id: string, index: string) => {
    try {
      await moveCollection(id, index);
    } catch (e) {
      onError(e);
    }
    void workspace.refresh();
  };

  // ---------- Keyboard ----------

  const toggleSidebar = () => (mobile ? setDrawerOpen((o) => !o) : update({ sidebar: !settings.sidebar }));
  const panelVisible = settings.panel;
  const togglePanel = () => update({ panel: !settings.panel });

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    // The editor handles its own shortcuts first (e.g. Ctrl+K with a selection makes a link).
    if (e.defaultPrevented || e.isComposing) return;
    // Only Cmd on a Mac: on Windows `metaKey` is the Windows key, and Win+. (the emoji panel)
    // must reach the editor instead of toggling the panel.
    const ctrl = isMac ? e.metaKey : e.ctrlKey;
    if (!isMac && e.metaKey) return;
    const k = e.key.toLowerCase();
    const typing = e.target instanceof HTMLElement && !!e.target.closest("input, textarea, select, [contenteditable='true']");
    if (ctrl && !e.altKey && (k === "k" || k === "p")) setSearchOpen(true);
    else if (ctrl && !e.altKey && !e.shiftKey && k === "f" && meta) actions.setFindOpen(true);
    else if (ctrl && e.altKey && k === "p" && meta) actions.present();
    else if (ctrl && e.shiftKey && k === "i" && meta) openPanel("insights");
    else if (ctrl && !e.altKey && k === "n") void newDoc();
    else if (ctrl && !e.altKey && !e.shiftKey && (k === "b" || k === "\\")) toggleSidebar();
    else if ((ctrl && k === ".") || (!ctrl && !e.altKey && k === "." && !typing)) togglePanel();
    else if (!ctrl && !e.altKey && k === "\\" && !typing) toggleSidebar();
    else if (ctrl && k === ",") setSettingsOpen(true);
    // Tabs, as in a browser.
    else if (ctrl && !e.altKey && !e.shiftKey && k === "t") router.openTab();
    else if (ctrl && !e.altKey && e.shiftKey && k === "t") router.reopenClosedTab();
    // In split view it closes the focused side first.
    else if (ctrl && !e.altKey && !e.shiftKey && k === "w" && split) router.closePane(router.tab.focus);
    else if (ctrl && !e.altKey && !e.shiftKey && k === "w" && router.tabs.length > 1) router.closeTab();
    else if (e.ctrlKey && !e.altKey && (e.key === "Tab" || e.key === "PageDown" || e.key === "PageUp")) {
      const dir = e.key === "PageUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
      router.selectTab((router.active + dir + router.tabs.length) % router.tabs.length);
    } else if (ctrl && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key) && router.tabs.length > 1)
      router.selectTab(e.key === "9" ? router.tabs.length - 1 : Math.min(Number(e.key) - 1, router.tabs.length - 1));
    else if (e.altKey && !ctrl && e.key === "ArrowLeft") router.back();
    else if (e.altKey && !ctrl && e.key === "ArrowRight") router.forward();
    else return;
    e.preventDefault();
  };
  const openSplitDoc = (id: string) => router.openSplit({ name: "doc", id });
  const contextRef = useRef({ t, openDocument: (id: string, newTab?: boolean) => go({ name: "doc", id }, newTab), openSplit: openSplitDoc });
  contextRef.current = { t, openDocument: (id: string, newTab?: boolean) => go({ name: "doc", id }, newTab), openSplit: openSplitDoc };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    // Mouse back/forward buttons.
    const onMouse = (e: globalThis.MouseEvent) => {
      if (e.button === 3) router.back();
      else if (e.button === 4) router.forward();
      else return;
      e.preventDefault();
    };
    // Our own right-click menu, unless something more specific (the sidebar) already showed one.
    // Shift + right-click opens the native menu.
    const onContext = (e: globalThis.MouseEvent) => {
      if (e.defaultPrevented || e.shiftKey || !(e.target instanceof Element)) return;
      const items = contextMenuFor(e.target, e.clientX, e.clientY, { ...contextRef.current, back: router.back, forward: router.forward });
      if (!items?.length) return;
      // In the editor the native menu is let through: the desktop app catches it before it
      // opens and hands over its spelling suggestions, which go at the top of ours.
      if (NATIVE_SPELLING && editorAt(e.target)?.view.editable) {
        spellingMenu.current = { x: e.clientX, y: e.clientY, items };
        return;
      }
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, items });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContext);
    if (isTauri) window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [router]);

  // The spelling suggestions for a right-click in the editor (see `onContext`).
  const spellingMenu = useRef<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  useEffect(() => {
    if (!NATIVE_SPELLING) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const [{ listen }, { invoke }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")]);
      const pick = (id: number | null) => void invoke("context_menu_pick", { id }).catch(() => {});
      const unlisten = await listen<{ id: number; label: string }[]>("spelling-menu", ({ payload }) => {
        const pending = spellingMenu.current;
        spellingMenu.current = null;
        if (!pending) return pick(null);
        let chosen: number | null = null;
        const suggestions: MenuEntry[] = payload.map((s) => ({ label: s.label, onClick: () => (chosen = s.id) }));
        setMenu({
          x: pending.x,
          y: pending.y,
          items: tidyMenu([...suggestions, { kind: "separator" }, ...pending.items]),
          // A menu item runs after the menu closes: answer once it has.
          onDismiss: () => setTimeout(() => pick(chosen), 0),
        });
      });
      if (cancelled) unlisten();
      else stop = unlisten;
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // Collection mentions in documents open the collection here.
  useEffect(() => {
    const open = (e: Event) => go({ name: "collection", id: String((e as CustomEvent).detail) });
    window.addEventListener(OPEN_COLLECTION_EVENT, open);
    return () => window.removeEventListener(OPEN_COLLECTION_EVENT, open);
  }, [go]);

  // ---------- Layout ----------

  const routeCollection = route.name === "collection" ? workspace.collections.find((x) => x.id === route.id || x.urlId === route.id) : undefined;

  const crumbs: Crumb[] = useMemo(() => {
    if (route.name === "home") return [{ label: t("home") }];
    if (route.name === "drafts") return [{ label: t("drafts") }];
    if (route.name === "archive") return [{ label: t("archiveTitle") }];
    if (route.name === "trash") return [{ label: t("trash") }];
    if (route.name === "collection") {
      const c = workspace.collections.find((x) => x.id === route.id || x.urlId === route.id);
      return [{ label: c?.name ?? "…" }];
    }
    if (!meta) return [{ label: "…" }];
    const out: Crumb[] = [];
    const collection = located?.collection ?? workspace.collections.find((c) => c.id === meta.doc.collectionId);
    if (collection) out.push({ label: collection.name, onClick: () => go({ name: "collection", id: collection.id }) });
    for (const node of located?.path ?? []) out.push({ label: node.title || t("untitled"), onClick: () => go({ name: "doc", id: node.id }) });
    // On narrow windows only the last two fit.
    return [...(wide ? out : out.slice(-1)), { label: meta.doc.title || t("untitled") }];
  }, [route, meta, located, workspace.collections, t, go, wide]);

  // ---------- Tabs ----------

  /** Titles of pages opened before, for tabs whose page isn't in the sidebar (drafts, shared…). */
  const knownTitles = useRef(new Map<string, string>());
  /** The open page's details, once they're for page `id` (they lag a moment behind a switch). */
  const metaFor = (id: string) => (meta && (meta.doc.id === id || meta.doc.urlId === id) ? meta.doc : null);
  if (route.name === "doc" && metaFor(route.id)) {
    knownTitles.current.set(route.id, meta!.doc.title);
    knownTitles.current.set(meta!.doc.id, meta!.doc.title);
  }
  const tabInfo = (r: Route): Omit<TabInfo, "id"> => {
    switch (r.name) {
      case "home":
        return { title: t("home"), icon: <HomeIcon size={14} /> };
      case "drafts":
        return { title: t("drafts"), icon: <Pencil size={14} /> };
      case "archive":
        return { title: t("archiveTitle"), icon: <Archive size={14} /> };
      case "trash":
        return { title: t("trash"), icon: <Trash size={14} /> };
      case "collection": {
        const c = workspace.collections.find((x) => x.id === r.id || x.urlId === r.id);
        return { title: c?.name ?? "…", icon: <EntityIcon icon={c?.icon} color={c?.color} size={15} fallback={<span className="collection-dot" />} /> };
      }
      case "doc": {
        const open = metaFor(r.id);
        const node = workspace.locate(r.id)?.node;
        const title = open?.title ?? node?.title ?? knownTitles.current.get(r.id);
        return {
          title: title === undefined ? "…" : title || t("untitled"),
          icon: <EntityIcon icon={open?.icon ?? node?.icon} color={open?.color ?? node?.color} size={15} fallback={<FileText size={14} />} />,
        };
      }
    }
  };
  // A split tab is named after both its pages, the focused one first.
  const tabs: TabInfo[] = router.tabs.map((tab) => {
    const main = tabInfo(router.currentRoute(tab));
    const other = tab.panes.length > 1 ? tabInfo(router.paneRoute(tab.panes[1 - tab.focus])) : null;
    return { id: tab.id, ...main, title: other ? `${main.title} | ${other.title}` : main.title };
  });
  const tabMenu = (index: number, e: MouseEvent) =>
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t("newTab"), kbd: `${isMac ? "⌘" : "Ctrl"}+T`, onClick: () => router.openTab() },
        { label: t("duplicateTab"), onClick: () => router.duplicateTab(index) },
        { kind: "separator" },
        { label: t("closeTab"), kbd: `${isMac ? "⌘" : "Ctrl"}+W`, onClick: () => router.closeTab(index) },
        {
          label: t("closeOtherTabs"),
          disabled: router.tabs.length < 2,
          onClick: () => {
            for (let i = router.tabs.length - 1; i >= 0; i--) if (i !== index) router.closeTab(i);
          },
        },
        {
          label: t("closeTabsToRight"),
          disabled: index >= router.tabs.length - 1,
          onClick: () => {
            for (let i = router.tabs.length - 1; i > index; i--) router.closeTab(i);
          },
        },
        { kind: "separator" },
        { label: t("reopenClosedTab"), kbd: `${isMac ? "⌘" : "Ctrl"}+Shift+T`, onClick: router.reopenClosedTab },
      ],
    });

  // ---------- Pages (split view) ----------

  /** A page in pane `pane`; only the focused one drives the toolbar, the panel and the title. */
  const renderPage = (r: Route, pane: number, focused: boolean) => {
    const key = paneKey(pane);
    const isFocused = () => focusRef.current === pane;
    const remember = (patch: { meta?: DocMeta | null; headings?: Heading[]; status?: EditorStatus; presence?: PresenceUser[] }) =>
      paneState.current.set(key, { ...paneState.current.get(key), ...patch });
    if (r.name === "doc")
      return (
        <DocumentView
          key={r.id}
          id={r.id}
          focused={focused}
          server={session.server}
          token={token}
          user={session.user}
          autoFocusTitle={freshDocId === r.id}
          subPages={workspace.locate(r.id)?.node.children ?? []}
          refreshToken={refreshToken}
          onLoaded={(m) => {
            remember({ meta: m });
            if (m) {
              knownTitles.current.set(r.id, m.doc.title);
              knownTitles.current.set(m.doc.id, m.doc.title);
            }
            if (!isFocused()) return;
            if (!m && reopened.current === r.id) navigate({ name: "home" }, true);
            reopened.current = null;
            setMeta(m);
          }}
          onTitleChange={(id, title) => {
            workspace.renameLocal(id, title);
            const st = paneState.current.get(key)?.meta;
            if (st && st.doc.id === id) remember({ meta: { ...st, doc: { ...st.doc, title } } });
            if (isFocused()) setMeta((m) => (m && m.doc.id === id ? { ...m, doc: { ...m.doc, title } } : m));
          }}
          onOpenDocument={(id, newTab) => go({ name: "doc", id }, newTab)}
          onStatus={(st) => {
            remember({ status: st });
            if (isFocused()) setDocStatus(st);
          }}
          onPresence={(users) => {
            remember({ presence: users });
            if (isFocused()) setPresence(users);
          }}
          onHeadings={(h) => {
            remember({ headings: h });
            if (!isFocused()) return;
            setHeadings(h);
            setDocTick((n) => n + 1);
          }}
          onError={onError}
          onStartComment={(id) => {
            setDraftComment(id);
            setPanelTab("comments");
            update({ panel: true });
          }}
          onCommentClick={(id) => {
            setActiveComment(id);
            setPanelTab("comments");
            update({ panel: true });
          }}
          viewRef={paneViews[pane]}
          reloadKey={reloadKey}
          findOpen={focused && actions.findOpen}
          onCloseFind={() => {
            actions.setFindOpen(false);
            paneViews[pane].current?.focus();
          }}
        />
      );
    if (r.name === "drafts" || r.name === "archive" || r.name === "trash")
      return <DocListPage page={r.name} workspace={workspace} onNavigate={go} onError={onError} flash={(m) => flash(m)} />;
    if (r.name === "collection")
      return (
        <CollectionView
          id={r.id}
          workspace={workspace}
          user={session.user}
          onNavigate={go}
          onNewDoc={(c) => void newDoc(c)}
          onEdit={actions.editCollection}
          onError={onError}
        />
      );
    return <Home workspace={workspace} onNavigate={go} onError={onError} />;
  };

  /** Dragging the line between the two sides of a split view. */
  const panesRef = useRef<HTMLDivElement>(null);
  const startSplitResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = panesRef.current?.getBoundingClientRect();
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const onMove = (m: PointerEvent) => update({ splitRatio: Math.min(0.8, Math.max(0.2, (m.clientX - box.left) / box.width)) });
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing-split");
    };
    document.body.classList.add("resizing-split");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const doSignOut = () => {
    clearTray();
    closeAllCollab();
    void signOut().finally(onSignedOut);
  };

  return (
    <div className="app">
      {mobile && drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      {(mobile ? drawerOpen : settings.sidebar) && (
        <Sidebar
          workspace={workspace}
          meId={session.user.id}
          route={route}
          activeDocId={meta?.doc.id}
          onNavigate={go}
          onNewDoc={(c, parent) => void newDoc(c, parent)}
          onSearch={() => setSearchOpen(true)}
          onClose={() => (mobile ? setDrawerOpen(false) : update({ sidebar: false }))}
          onContextMenu={openContextMenu}
          onMove={(id, target) => void moveDoc(id, target)}
          onMoveCollection={(id, index) => void reorderCollection(id, index)}
          onNewCollection={actions.newCollection}
          team={session.team}
          onOpenWorkspace={() => setWorkspacesOpen(true)}
          onCollectionMenu={(c, e) => setMenu({ x: e.clientX, y: e.clientY, items: actions.collectionMenu(c) })}
        />
      )}
      <main className="main">
        <Toolbar
          crumbs={crumbs}
          showSidebarToggle={mobile || !settings.sidebar}
          onToggleSidebar={toggleSidebar}
          canBack={router.canBack}
          canForward={router.canForward}
          onBack={router.back}
          onForward={router.forward}
          status={route.name === "doc" ? docStatus : undefined}
          presence={presence}
          collaborators={route.name === "doc" ? collaborators : []}
          documentId={route.name === "doc" ? meta?.doc.id : undefined}
          starred={meta ? !!actions.isStarred(meta.doc.id) : routeCollection ? !!actions.isCollectionStarred(routeCollection.id) : undefined}
          onToggleStar={meta ? () => actions.toggleStar(meta.doc.id) : routeCollection ? () => actions.toggleCollectionStar(routeCollection.id) : undefined}
          docMenu={meta?.doc.collectionId ? <DropdownMenu title={t("more")} items={actions.docMenu()} /> : undefined}
          share={
            meta ? (
              <ShareButton
                key={meta.doc.id}
                documentId={meta.doc.id}
                collection={workspace.collections.find((c) => c.id === meta.doc.collectionId)}
                me={session.user}
                canInvite={meta.canInvite}
                canShare={meta.canShare}
                onError={onError}
                flash={(m) => flash(m)}
              />
            ) : undefined
          }
          publish={
            meta && !meta.doc.publishedAt && meta.canUpdate ? (
              <PublishButton
                collections={workspace.collections}
                collectionId={meta.doc.collectionId}
                onPublish={async (collectionId) => {
                  try {
                    await publishDocument(meta.doc.id, collectionId);
                    void workspace.refreshCollection(collectionId);
                    setReloadKey((n) => n + 1);
                    flash(t("published"));
                  } catch (e) {
                    onError(e);
                  }
                }}
              />
            ) : undefined
          }
          user={session.user}
          panelVisible={panelVisible}
          onTogglePanel={togglePanel}
          split={split}
          onToggleSplit={() => (split ? router.closePane(router.tab.focus) : router.openSplit())}
          onOpenSettings={() => setSettingsOpen(true)}
          notifications={
            <NotificationsButton
              badge={(session.user.preferences?.notificationBadge as BadgeStyle | undefined) ?? "count"}
              collectionName={(id) => workspace.collections.find((c) => c.id === id)?.name}
              onNavigate={go}
              onOpenComment={openComment}
              onError={onError}
            />
          }
          onSignOut={doSignOut}
        />
        {tabs.length > 1 && (
          <TabBar
            tabs={tabs}
            active={router.active}
            onSelect={router.selectTab}
            onClose={router.closeTab}
            onNew={() => router.openTab()}
            onMove={router.moveTab}
            onContextMenu={tabMenu}
          />
        )}
        {newRelease && (
          <div className="banner update-banner" role="status">
            <span>{installStatus(t, installer.state) ?? t("updateAvailable", { version: newRelease.version })}</span>
            <span className="banner-actions">
              {canInstallUpdates && installer.state.status !== "error" ? (
                <button className="link-button" disabled={installer.state.status !== "idle"} onClick={() => void installer.install()}>
                  {t("installUpdate")}
                </button>
              ) : (
                <button className="link-button" onClick={() => void openExternal(newRelease.installer ?? newRelease.url)}>
                  {t("download")}
                </button>
              )}
              <button className="link-button" onClick={() => void openExternal(newRelease.url)}>
                {t("whatsNew")}
              </button>
              <button className="link-button" onClick={() => update({ skippedUpdate: newRelease.version })}>
                {t("later")}
              </button>
            </span>
          </div>
        )}
        <div className={`panes${split ? " split" : ""}`} ref={panesRef}>
          {router.tab.panes.map((pane, i) => (
            <Fragment key={`${router.tab.id}:${i}`}>
              {i > 0 && <div className="pane-divider" role="separator" aria-orientation="vertical" onPointerDown={startSplitResize} onDoubleClick={() => update({ splitRatio: 0.5 })} />}
              <Pane
                scrollKey={`${router.tab.id}:${i}:${pane.index}:${routePath(router.paneRoute(pane))}`}
                focused={i === router.tab.focus}
                split={split}
                onFocus={() => router.focusPane(i)}
                onClose={() => router.closePane(i)}
                style={split ? { flexBasis: `${(i === 0 ? settings.splitRatio : 1 - settings.splitRatio) * 100}%` } : undefined}
              >
                {renderPage(router.paneRoute(pane), i, i === router.tab.focus)}
              </Pane>
            </Fragment>
          ))}
        </div>
      </main>
      {panelVisible && (
        <Panel
          meta={route.name === "doc" ? meta : null}
          headings={headings}
          presence={presence}
          viewRef={viewRef}
          tab={panelTab}
          onTab={setPanelTab}
          user={session.user}
          docTick={docTick}
          draftComment={draftComment}
          onDraftDone={() => setDraftComment(null)}
          activeComment={activeComment}
          onActivateComment={setActiveComment}
          onError={onError}
          onRestored={() => {
            setReloadKey((n) => n + 1);
            flash(t("restored"));
          }}
        />
      )}
      {activeComment && <style>{`.doc-content .comment-marker[data-comment-id="${CSS.escape(activeComment)}"] { background: color-mix(in srgb, var(--warning) 35%, transparent); }`}</style>}
      {searchOpen && (
        <SearchDialog
          workspace={workspace}
          onPick={(doc: Doc) => {
            setSearchOpen(false);
            go({ name: "doc", id: doc.id });
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {workspacesOpen && (
        <WorkspaceDialog
          session={session}
          onClose={() => setWorkspacesOpen(false)}
          onOpenSettings={() => {
            setWorkspacesOpen(false);
            setSettingsOpen("details");
          }}
          onAdd={(server) => {
            setWorkspacesOpen(false);
            onAddWorkspace(server);
          }}
          onSignOut={() => {
            setWorkspacesOpen(false);
            doSignOut();
          }}
          onError={onError}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          user={session.user}
          server={session.server}
          workspace={workspace}
          onClose={closeSettings}
          onSignOut={doSignOut}
          page={settingsOpen === true ? undefined : settingsOpen}
          onUserChange={onUserChange}
          onTeamChange={onTeamChange}
          onNavigate={go}
          flash={flash}
          onError={onError}
        />
      )}
      <DatePickerHost />
      <MediaHost onError={onError} />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => {
            menu.onDismiss?.();
            setMenu(null);
          }}
        />
      )}
      <ErrorStack errors={errors.errors} onDismiss={errors.dismiss} />
      <Tooltips />
      {actions.overlay}
      {toast && (
        <div className="toast">
          <span>{toast.message}</span>
          {toast.undo && (
            <button className="link-button" onClick={toast.undo}>
              {toast.label ?? t("undo")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
