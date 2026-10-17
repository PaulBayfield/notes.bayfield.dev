// Everything in the document "…" menu, the sidebar's right-click menus, and the dialogs they open.

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { EditorView } from "prosemirror-view";
import {
  archiveCollection,
  archiveDocument,
  deleteCollection,
  deleteDocument,
  documentSubscription,
  duplicateDocument,
  exportMarkdown,
  importDocument,
  listPins,
  moveDocument,
  pin,
  restoreDocument,
  star,
  starCollection,
  subscribe,
  templatizeDocument,
  unpin,
  unpublishDocument,
  unstar,
  unsubscribe,
  updateDocumentSettings,
  webUrl,
  type Collection,
  type Pin,
  type Subscription,
} from "../lib/api";
import { embedsEnabled, setEmbedsEnabled } from "../lib/docPrefs";
import { mod, openExternal, saveTextFile } from "../lib/platform";
import type { Route } from "../lib/router";
import { useSettings } from "../lib/settings";
import type { Workspace } from "../lib/workspace";
import type { HeadingPrefixStyle } from "../editor/headingPrefix";
import { CollectionDialog } from "./CollectionDialog";
import { ConfirmDialog, MoveDialog } from "./Dialogs";
import type { DocMeta } from "./DocumentView";
import type { PanelTab } from "./Panel";
import { Presentation } from "./Presentation";
import type { DocTarget } from "./Sidebar";
import { menu, type MenuEntry } from "./Menu";
import {
  Archive,
  BarChart,
  BellIcon,
  Copy,
  CopyPlus,
  Download,
  External,
  FileMinus,
  FilePlus,
  HistoryIcon,
  LinkIcon,
  ListOrdered,
  Lock,
  MessageSquare,
  MoveIcon,
  Pencil,
  PinIcon,
  Play,
  Search,
  Shapes,
  Star,
  Trash,
  Upload,
} from "./icons";

interface Params {
  workspace: Workspace;
  meta: DocMeta | null;
  viewRef: RefObject<EditorView | null>;
  go: (r: Route) => void;
  newDoc: (collectionId?: string, parentDocumentId?: string) => Promise<void>;
  onError: (e: unknown) => void;
  flash: (message: string, undo?: () => void) => void;
  openPanel: (tab: PanelTab) => void;
  /** Reload the open document (its settings changed). */
  reloadDoc: () => void;
}

type Dialog =
  | { kind: "move"; target: DocTarget }
  | { kind: "delete"; target: DocTarget }
  | { kind: "collection"; collection?: Collection }
  | { kind: "deleteCollection"; collection: Collection }
  | { kind: "present" }
  | null;

const UNDO_MS = 6000;

export function useDocumentActions(p: Params) {
  const { t } = useSettings();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [pins, setPins] = useState<{ home: Pin | null; collection: Pin | null }>({ home: null, collection: null });
  const importInput = useRef<HTMLInputElement>(null);
  const importTarget = useRef<DocTarget | null>(null);
  const { workspace, meta, onError, flash, go } = p;
  const docId = meta?.doc.id;
  const collectionId = meta?.doc.collectionId ?? null;

  // What the menu needs to know about the open document: subscribed? pinned where?
  const refreshDocState = useCallback(async () => {
    if (!docId) return;
    const [sub, home, inCollection] = await Promise.all([
      documentSubscription(docId),
      listPins().catch(() => null),
      collectionId ? listPins(collectionId).catch(() => null) : Promise.resolve(null),
    ]);
    setSubscription(sub);
    setPins({
      home: home?.pins.find((x) => x.documentId === docId && !x.collectionId) ?? null,
      collection: inCollection?.pins.find((x) => x.documentId === docId) ?? null,
    });
  }, [docId, collectionId]);
  useEffect(() => {
    setSubscription(null);
    setPins({ home: null, collection: null });
    setFindOpen(false);
    void refreshDocState();
  }, [refreshDocState]);

  const run = (fn: () => Promise<unknown>, done?: string) => () =>
    void fn()
      .then(() => done && flash(done))
      .catch(onError);

  // ---------- Shared actions ----------

  const isStarred = (id: string) => workspace.stars.stars.find((s) => s.documentId === id);
  const isCollectionStarred = (id: string) => workspace.stars.stars.find((s) => s.collectionId === id);
  const toggleCollectionStar = (id: string) =>
    run(async () => {
      const existing = isCollectionStarred(id);
      await (existing ? unstar(existing.id) : starCollection(id));
      await workspace.refreshStars();
    });
  const toggleStar = (id: string) =>
    run(async () => {
      const existing = isStarred(id);
      if (existing) await unstar(existing.id);
      else await star(id);
      await workspace.refreshStars();
    });

  const copyText = (text: string, message = t("copied")) => void navigator.clipboard?.writeText(text).then(() => flash(message));

  const remove = async (target: DocTarget, kind: "delete" | "archive") => {
    await (kind === "delete" ? deleteDocument(target.id) : archiveDocument(target.id));
    if (meta?.doc.id === target.id) go({ name: "collection", id: target.collectionId });
    void workspace.refreshCollection(target.collectionId);
    void workspace.refreshStars();
    const timer = setTimeout(() => flash(""), UNDO_MS);
    flash(t(kind === "delete" ? "deleted" : "archived"), () => {
      clearTimeout(timer);
      restoreDocument(target.id)
        .then(() => workspace.refreshCollection(target.collectionId))
        .catch(onError);
    });
  };

  const duplicate = (target: DocTarget) =>
    run(async () => {
      const r = await duplicateDocument(target.id);
      void workspace.refreshCollection(target.collectionId);
      const copy = r.data.documents[0];
      if (copy) go({ name: "doc", id: copy.id });
    });

  const startImport = (target: DocTarget) => {
    importTarget.current = target;
    importInput.current?.click();
  };

  const collectionName = (id: string) => workspace.collections.find((c) => c.id === id)?.name ?? "";

  // ---------- Menus ----------

  /** The sidebar's right-click menu for a document. */
  const treeMenu = (target: DocTarget): MenuEntry[] =>
    menu([
      { label: t("newChild"), icon: <FilePlus size={15} />, onClick: () => void p.newDoc(target.collectionId, target.id) },
      { label: t(isStarred(target.id) ? "unstar" : "star"), icon: <Star size={15} filled={!!isStarred(target.id)} />, onClick: toggleStar(target.id) },
      { kind: "separator" },
      { label: t("duplicate"), icon: <CopyPlus size={15} />, onClick: duplicate(target) },
      { label: t("move"), icon: <MoveIcon size={15} />, onClick: () => setDialog({ kind: "move", target }) },
      { label: t("copyLink"), icon: <LinkIcon size={15} />, onClick: () => copyText(webUrl(target.url), t("linkCopied")) },
      { label: t("openInBrowser"), icon: <External size={15} />, onClick: () => void openExternal(webUrl(target.url)) },
      { kind: "separator" },
      { label: t("archive"), icon: <Archive size={15} />, onClick: () => void remove(target, "archive").catch(onError) },
      { label: t("delete"), icon: <Trash size={15} />, danger: true, onClick: () => setDialog({ kind: "delete", target }) },
    ]);

  /** The open document's full "…" menu (same items as Outline's). */
  const docMenu = (): MenuEntry[] => {
    if (!meta?.doc.collectionId) return [];
    const { doc, canUpdate } = meta;
    const target: DocTarget = { id: doc.id, title: doc.title, url: doc.url, collectionId: doc.collectionId! };
    const view = p.viewRef.current;
    const prefix = (doc.preferences?.headingPrefix ?? "none") as HeadingPrefixStyle;
    const setPrefix = (style: HeadingPrefixStyle) =>
      run(async () => {
        await updateDocumentSettings(doc.id, { preferences: { headingPrefix: style } });
        p.reloadDoc();
      });
    const name = collectionName(target.collectionId);
    return menu([
      { label: t(isStarred(doc.id) ? "unstar" : "star"), icon: <Star size={15} filled={!!isStarred(doc.id)} />, onClick: toggleStar(doc.id) },
      {
        label: t(subscription ? "unsubscribe" : "subscribe"),
        icon: <BellIcon size={15} />,
        onClick: run(async () => {
          if (subscription) {
            await unsubscribe(subscription.id);
            setSubscription(null);
            flash(t("unsubscribed"));
          } else {
            setSubscription(await subscribe(doc.id));
            flash(t("subscribed"));
          }
        }),
      },
      { kind: "separator" },
      { label: t("permissions"), icon: <Lock size={15} />, onClick: () => void openExternal(webUrl(doc.url)) },
      canUpdate && { label: t("templatize"), icon: <Shapes size={15} />, onClick: run(() => templatizeDocument(doc.id), t("templateCreated")) },
      { label: t("duplicate"), icon: <CopyPlus size={15} />, onClick: duplicate(target) },
      canUpdate &&
        !!doc.publishedAt && {
          label: t("unpublish"),
          icon: <FileMinus size={15} />,
          onClick: run(async () => {
            await unpublishDocument(doc.id);
            void workspace.refreshCollection(target.collectionId);
            p.reloadDoc();
          }, t("unpublished")),
        },
      canUpdate && { label: t("archive"), icon: <Archive size={15} />, onClick: () => void remove(target, "archive").catch(onError) },
      canUpdate && { label: t("move"), icon: <MoveIcon size={15} />, onClick: () => setDialog({ kind: "move", target }) },
      canUpdate && { label: t("importDocuments"), icon: <Download size={15} />, onClick: () => startImport(target) },
      {
        kind: "submenu",
        label: t("newDocMenu"),
        icon: <FilePlus size={15} />,
        items: [
          { label: t("newNested"), onClick: () => void p.newDoc(target.collectionId, doc.id) },
          { label: t("newSibling"), onClick: () => void p.newDoc(target.collectionId, doc.parentDocumentId ?? undefined) },
          { label: t("newDocIn", { name }), onClick: () => void p.newDoc(target.collectionId) },
        ],
      },
      {
        kind: "submenu",
        label: t("pin"),
        icon: <PinIcon size={15} />,
        items: [
          pins.collection
            ? { label: t("unpinFrom", { name }), onClick: run(async () => (await unpin(pins.collection!.id), refreshDocState()), t("unpinnedToast")) }
            : { label: t("pinToCollection", { name }), onClick: run(async () => (await pin(doc.id, target.collectionId), refreshDocState()), t("pinnedToast")) },
          pins.home
            ? { label: t("unpinFromHome"), onClick: run(async () => (await unpin(pins.home!.id), refreshDocState()), t("unpinnedToast")) }
            : { label: t("pinToHome"), onClick: run(async () => (await pin(doc.id, null), refreshDocState()), t("pinnedToast")) },
        ],
      },
      { kind: "separator" },
      { label: t("comments"), icon: <MessageSquare size={15} />, onClick: () => p.openPanel("comments") },
      { label: t("history"), icon: <HistoryIcon size={15} />, onClick: () => p.openPanel("history") },
      { label: t("insights"), icon: <BarChart size={15} />, kbd: `${mod}+Shift+I`, onClick: () => p.openPanel("insights") },
      { label: t("present"), icon: <Play size={15} />, kbd: `${mod}+Alt+P`, onClick: () => setDialog({ kind: "present" }) },
      {
        kind: "submenu",
        label: t("export"),
        icon: <Upload size={15} />,
        items: [
          {
            label: t("exportMarkdown"),
            onClick: run(async () => {
              const md = await exportMarkdown(doc.id);
              const name = `${(doc.title || "untitled").replace(/[\\/:*?"<>|]+/g, "-").trim()}.md`;
              if (await saveTextFile(name, md)) flash(t("exported"));
            }),
          },
        ],
      },
      {
        kind: "submenu",
        label: t("copy"),
        icon: <Copy size={15} />,
        items: [
          { label: t("copyLink"), onClick: () => copyText(webUrl(doc.url), t("linkCopied")) },
          { label: t("copyMarkdown"), onClick: run(async () => copyText(await exportMarkdown(doc.id))) },
          { label: t("copyText"), onClick: () => view && copyText(view.state.doc.textBetween(0, view.state.doc.content.size, "\n\n", " ")) },
        ],
      },
      { label: t("searchInDocument"), icon: <Search size={15} />, kbd: `${mod}+F`, onClick: () => setFindOpen(true) },
      { kind: "separator" },
      canUpdate && { label: t("delete"), icon: <Trash size={15} />, danger: true, onClick: () => setDialog({ kind: "delete", target }) },
      { kind: "separator" },
      canUpdate && {
        kind: "submenu",
        label: t("headingNumbering"),
        icon: <ListOrdered size={15} />,
        items: (
          [
            ["none", "numberingNone"],
            ["numeric", "numberingDecimal"],
            ["alphanumeric", "numberingAlpha"],
            ["outline", "numberingHarvard"],
          ] as const
        ).map(([style, label]) => ({ label: t(label), checked: prefix === style, onClick: setPrefix(style) })),
      },
      canUpdate && {
        kind: "toggle",
        label: t("viewerInsights"),
        checked: !!doc.insightsEnabled,
        onChange: (on) => void updateDocumentSettings(doc.id, { insightsEnabled: on }).then(p.reloadDoc).catch(onError),
      },
      {
        kind: "toggle",
        label: t("enableEmbeds"),
        checked: embedsEnabled(doc.id),
        onChange: (on) => {
          setEmbedsEnabled(doc.id, on);
          p.reloadDoc();
        },
      },
      canUpdate && {
        kind: "toggle",
        label: t("fullWidthToggle"),
        checked: !!doc.fullWidth,
        onChange: (on) => void updateDocumentSettings(doc.id, { fullWidth: on }).then(p.reloadDoc).catch(onError),
      },
    ]);
  };

  /** The sidebar's right-click menu for a collection. */
  const collectionMenu = (c: Collection): MenuEntry[] =>
    menu([
      { label: t("newDoc"), icon: <FilePlus size={15} />, onClick: () => void p.newDoc(c.id) },
      { label: t("editCollection"), icon: <Pencil size={15} />, onClick: () => setDialog({ kind: "collection", collection: c }) },
      {
        label: t(isCollectionStarred(c.id) ? "unstar" : "star"),
        icon: <Star size={15} filled={!!isCollectionStarred(c.id)} />,
        onClick: toggleCollectionStar(c.id),
      },
      { kind: "separator" },
      { label: t("copyLink"), icon: <LinkIcon size={15} />, onClick: () => copyText(webUrl(`/collection/${c.urlId}`), t("linkCopied")) },
      { label: t("openInBrowser"), icon: <External size={15} />, onClick: () => void openExternal(webUrl(`/collection/${c.urlId}`)) },
      { kind: "separator" },
      {
        label: t("archiveCollection"),
        icon: <Archive size={15} />,
        onClick: run(async () => {
          await archiveCollection(c.id);
          await workspace.refresh();
          go({ name: "home" });
        }, t("collectionArchived")),
      },
      { label: t("deleteCollection"), icon: <Trash size={15} />, danger: true, onClick: () => setDialog({ kind: "deleteCollection", collection: c }) },
    ]);

  // ---------- Dialogs ----------

  const close = () => setDialog(null);
  let overlay: ReactNode = null;
  if (dialog?.kind === "move")
    overlay = (
      <MoveDialog
        workspace={workspace}
        docId={dialog.target.id}
        title={dialog.target.title}
        onClose={close}
        onMove={async (toCollection, parentId) => {
          try {
            await moveDocument(dialog.target.id, toCollection, parentId);
            void workspace.refreshCollection(toCollection);
            if (toCollection !== dialog.target.collectionId) void workspace.refreshCollection(dialog.target.collectionId);
            flash(t("moved"));
          } catch (e) {
            onError(e);
          }
        }}
      />
    );
  else if (dialog?.kind === "delete")
    overlay = (
      <ConfirmDialog
        title={t("deleteDocTitle")}
        message={t("deleteDocMessage", { title: dialog.target.title || t("untitled") })}
        confirm={t("delete")}
        danger
        onClose={close}
        onConfirm={() => remove(dialog.target, "delete").catch(onError)}
      />
    );
  else if (dialog?.kind === "collection")
    overlay = (
      <CollectionDialog
        collection={dialog.collection}
        onClose={close}
        onError={onError}
        onDone={(c) => {
          void workspace.refresh();
          if (!dialog.collection) {
            flash(t("collectionCreated"));
            go({ name: "collection", id: c.id });
          }
        }}
      />
    );
  else if (dialog?.kind === "deleteCollection")
    overlay = (
      <ConfirmDialog
        title={t("deleteCollection")}
        message={t("deleteCollectionMessage", { name: dialog.collection.name })}
        confirm={t("delete")}
        danger
        onClose={close}
        onConfirm={async () => {
          try {
            await deleteCollection(dialog.collection.id);
            await workspace.refresh();
            go({ name: "home" });
          } catch (e) {
            onError(e);
          }
        }}
      />
    );
  else if (dialog?.kind === "present" && meta && p.viewRef.current)
    overlay = <Presentation title={meta.doc.title} icon={meta.doc.icon} color={meta.doc.color} doc={p.viewRef.current.state.doc} onClose={close} />;

  overlay = (
    <>
      {overlay}
      <input
        ref={importInput}
        type="file"
        hidden
        accept=".md,.markdown,.txt,.html,.htm,.docx,.csv,.json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          const target = importTarget.current;
          if (!file || !target) return;
          importDocument(file, target.collectionId, target.id)
            .then((doc) => {
              void workspace.refreshCollection(target.collectionId);
              flash(t("imported"));
              go({ name: "doc", id: doc.id });
            })
            .catch(onError);
        }}
      />
    </>
  );

  return {
    docMenu,
    treeMenu,
    collectionMenu,
    overlay,
    findOpen,
    setFindOpen,
    present: () => setDialog({ kind: "present" }),
    newCollection: () => setDialog({ kind: "collection" }),
    editCollection: (id: string) => {
      const c = workspace.collections.find((x) => x.id === id);
      if (c) setDialog({ kind: "collection", collection: c });
    },
    isStarred,
    toggleStar: (id: string) => toggleStar(id)(),
    isCollectionStarred,
    toggleCollectionStar: (id: string) => toggleCollectionStar(id)(),
  };
}
