import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { can, ApiError, documentInfo, updateDocument, type Doc, type NavNode, type User } from "../lib/api";
import { useSettings } from "../lib/settings";
import { documentIdsOf, onRealtime } from "../lib/realtime";
import { EntityIcon } from "./EntityIcon";
import { Dialog } from "./Dialogs";
import { COLORS, IconPicker } from "./IconPicker";
import { FileText, Shapes, X } from "./icons";
import { FindBar } from "./FindBar";
import { TocNav } from "./Panel";
import { embedsEnabled } from "../lib/docPrefs";
import type { HeadingPrefixStyle } from "../editor/headingPrefix";
import { Editor, type EditorStatus, type Heading } from "../editor/Editor";
import type { PresenceUser } from "../editor/collab";

export interface DocMeta {
  doc: Doc;
  canUpdate: boolean;
  canInvite: boolean;
  canShare: boolean;
  /** Archived documents can be deleted without being editable. */
  canDelete: boolean;
}

interface Props {
  id: string;
  /** In split view, the side with the focus (the contents panel follows its scrolling). */
  focused: boolean;
  server: string;
  token: string;
  user: User;
  /** Focus the title right away (new documents). */
  autoFocusTitle: boolean;
  /** The document's children in the sidebar tree, listed under it when that's turned on. */
  subPages: NavNode[];
  refreshToken: () => Promise<string | undefined>;
  onLoaded: (meta: DocMeta | null) => void;
  onTitleChange: (id: string, title: string) => void;
  onOpenDocument: (id: string, newTab?: boolean) => void;
  onStatus: (status: EditorStatus) => void;
  onPresence: (users: PresenceUser[]) => void;
  onHeadings: (headings: Heading[]) => void;
  onError: (e: unknown) => void;
  onStartComment: (id: string) => void;
  onCommentClick: (id: string) => void;
  viewRef: RefObject<EditorView | null>;
  /** Bumped by document actions (settings changed, revision restored…) to reload. */
  reloadKey: number;
  findOpen: boolean;
  onCloseFind: () => void;
  /** The workspace puts the table of contents beside the document (and the window is wide enough). */
  tocBeside: boolean;
}

/**
 * Page details from earlier visits (by route id and canonical id): a page opens with them at once
 * while the server is asked for fresh ones.
 */
const metaCache = new Map<string, DocMeta>();
const cacheMeta = (key: string, meta: DocMeta) => {
  metaCache.set(key, meta);
  metaCache.set(meta.doc.id, meta);
};

export function DocumentView(p: Props) {
  const { t, f, settings } = useSettings();
  // The headings, for the table of contents beside the document.
  const [headings, setHeadings] = useState<Heading[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [meta, setMetaState] = useState<DocMeta | null>(() => metaCache.get(p.id) ?? null);
  const setMeta = (next: DocMeta | null) => {
    if (next) cacheMeta(p.id, next);
    setMetaState(next);
  };
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState(() => metaCache.get(p.id)?.doc.title ?? "");
  const [status, setStatus] = useState<EditorStatus>("loading");
  const [iconOpen, setIconOpen] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const editingTitle = useRef(false);
  const pRef = useRef(p);
  pRef.current = p;
  /** Canonical id: the route may use the short url id. */
  const loadedId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await documentInfo(p.id);
      const next = {
        doc: res.data,
        canUpdate: can(res, res.data.id, "update"),
        canInvite: can(res, res.data.id, "manageUsers"),
        canShare: can(res, res.data.id, "share"),
        canDelete: can(res, res.data.id, "delete"),
      };
      cacheMeta(p.id, next);
      setMetaState(next);
      loadedId.current = res.data.id;
      if (!editingTitle.current) setTitle(res.data.title);
      pRef.current.onLoaded(next);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 400)) {
        metaCache.delete(p.id);
        setMissing(true);
        pRef.current.onLoaded(null);
      } else pRef.current.onError(e);
    }
  }, [p.id]);

  useEffect(() => {
    // From the last visit, if there was one; the server's answer replaces it.
    const cached = metaCache.get(p.id) ?? null;
    setMetaState(cached);
    if (cached) {
      loadedId.current = cached.doc.id;
      pRef.current.onLoaded(cached);
    }
    setMissing(false);
    editingTitle.current = false;
    void load();
    // Pick up renames made elsewhere: live, and when coming back to the window.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const stop = onRealtime(({ event, data }) => {
      if ((event === "entities" || event.startsWith("documents.")) && documentIdsOf(data).some((id) => id === p.id || id === loadedId.current)) void load();
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      stop();
    };
  }, [load, p.id]);

  useEffect(() => {
    if (p.reloadKey) void load();
  }, [p.reloadKey, load]);

  // Title: saved through the API (it isn't part of the collaborative document).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<{ id: string; title: string } | null>(null);
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    const next = pending.current;
    pending.current = null;
    editingTitle.current = false;
    if (next) updateDocument(next.id, { title: next.title }).catch((e) => pRef.current.onError(e));
  }, []);
  useEffect(() => flush, [p.id, flush]);

  const onTitle = (value: string) => {
    const clean = value.replace(/\n/g, "");
    setTitle(clean);
    if (!meta) return;
    editingTitle.current = true;
    pending.current = { id: meta.doc.id, title: clean };
    p.onTitleChange(meta.doc.id, clean);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 500);
  };

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [title, meta, settings.fontSize]);

  // Once: the document reloads whenever the window regains focus (e.g. after the Windows emoji
  // panel), and that mustn't pull the cursor out of the text into the title.
  const titleFocused = useRef(false);
  useEffect(() => {
    if (!meta || !p.autoFocusTitle || titleFocused.current) return;
    titleFocused.current = true;
    titleRef.current?.focus();
  }, [meta, p.autoFocusTitle]);

  const focusEditorStart = () => {
    const view = p.viewRef.current;
    if (!view) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    view.focus();
  };

  /** Applies an icon / colour change right away, then saves it. */
  const setDocIcon = (patch: { icon: string | null; color: string }) => {
    if (!meta) return;
    const next = { ...meta, doc: { ...meta.doc, ...patch } };
    setMeta(next);
    p.onLoaded(next);
    updateDocument(meta.doc.id, patch).catch((e) => {
      p.onError(e);
      void load();
    });
  };

  if (missing) return <div className="empty-state">{t("notFound")}</div>;
  if (!meta) return <div className="doc-scroll" />;

  const { doc } = meta;
  const editable = meta.canUpdate && !doc.archivedAt && status !== "outdated" && status !== "denied" && status !== "unsupported";
  const by = doc.updatedBy?.id === p.user.id ? null : doc.updatedBy?.name;
  const embeds = embedsEnabled(doc.id);
  const headingPrefix = (doc.preferences?.headingPrefix ?? "none") as HeadingPrefixStyle;
  // Hovering "Edited …" gives the exact times and who.
  const metaTip = [
    `${t("updated")} · ${f.dateTime(doc.updatedAt)}${doc.updatedBy ? ` · ${t("by", { name: doc.updatedBy.name })}` : ""}`,
    `${t("created")} · ${f.dateTime(doc.createdAt)}${doc.createdBy ? ` · ${t("by", { name: doc.createdBy.name })}` : ""}`,
  ].join("\n");

  return (
    <div className={`doc-scroll${p.tocBeside && headings.length ? " toc-beside" : ""}`} id={p.focused ? "doc-scroll" : undefined} ref={scrollRef}>
      {p.findOpen && <FindBar viewRef={p.viewRef} editable={editable} onClose={p.onCloseFind} />}
      {p.tocBeside && headings.length > 0 && (
        <aside className="doc-toc-beside" aria-label={t("contents")}>
          <div className="doc-toc-title">{t("contents")}</div>
          <TocNav headings={headings} viewRef={p.viewRef} scroller={() => scrollRef.current} active />
        </aside>
      )}
      <article className={`doc${settings.fullWidth || doc.fullWidth ? " full-width" : ""} font-${settings.font}`} style={{ fontSize: settings.fontSize }}>
        {doc.icon && editable ? (
          <button className="doc-icon editable" title={t("pageIcon")} onClick={() => setIconOpen(true)}>
            <EntityIcon icon={doc.icon} color={doc.color} size={44} fallback={null} />
          </button>
        ) : doc.icon ? (
          <div className="doc-icon">
            <EntityIcon icon={doc.icon} color={doc.color} size={44} fallback={null} />
          </div>
        ) : (
          editable && (
            <button className="doc-add-icon" onClick={() => setIconOpen(true)}>
              <Shapes size={14} />
              {t("addIcon")}
            </button>
          )
        )}
        {iconOpen && (
          <Dialog title={t("pageIcon")} onClose={() => setIconOpen(false)}>
            <div className="collection-form">
              <IconPicker
                icon={doc.icon}
                color={doc.color ?? COLORS[0]}
                noneLabel={t("noIcon")}
                none={<X size={16} />}
                onIcon={(icon) => setDocIcon({ icon, color: doc.color ?? COLORS[0] })}
                onColor={(color) => setDocIcon({ icon: doc.icon, color })}
              />
            </div>
          </Dialog>
        )}
        <textarea
          ref={titleRef}
          className="doc-title"
          rows={1}
          value={title}
          placeholder={t("titlePlaceholder")}
          readOnly={!editable}
          spellCheck={settings.spellcheck}
          onChange={(e) => onTitle(e.target.value)}
          onBlur={flush}
          onKeyDown={(e) => {
            if (e.key === "Enter" || (e.key === "ArrowDown" && e.currentTarget.selectionStart === title.length)) {
              e.preventDefault();
              focusEditorStart();
            }
          }}
        />
        <div className="doc-meta">
          {!doc.publishedAt && <span className="badge">{t("draft")}</span>}
          {!editable && meta.canUpdate === false && <span className="badge">{t("readOnly")}</span>}
          <span title={metaTip}>{by ? t("editedBy", { name: by, time: f.relative(doc.updatedAt) }) : t("edited", { time: f.relative(doc.updatedAt) })}</span>
        </div>
        <Editor
          key={`${doc.id}:${embeds}`}
          embeds={embeds}
          headingPrefix={headingPrefix}
          docId={doc.id}
          docUrl={doc.url}
          server={p.server}
          token={p.token}
          user={p.user}
          editable={editable}
          spellcheck={settings.spellcheck}
          t={t}
          refreshToken={p.refreshToken}
          onOpenDocument={p.onOpenDocument}
          onStatus={(s) => {
            setStatus(s);
            p.onStatus(s);
          }}
          onPresence={p.onPresence}
          onHeadings={(h) => {
            setHeadings(h);
            p.onHeadings(h);
          }}
          onError={p.onError}
          onStartComment={p.onStartComment}
          onCommentClick={p.onCommentClick}
          viewRef={p.viewRef}
        />
        {settings.subPages && p.subPages.length > 0 && (
          <section className="sub-pages">
            <h2 className="sub-pages-title">{t("subPages")}</h2>
            {p.subPages.map((n) => (
              <button
                key={n.id}
                className="doc-row"
                onClick={(e) => p.onOpenDocument(n.id, e.ctrlKey || e.metaKey)}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => e.button === 1 && p.onOpenDocument(n.id, true)}
              >
                <span className="doc-row-icon">
                  <EntityIcon icon={n.icon} color={n.color} size={20} fallback={<FileText size={16} />} />
                </span>
                <span className="doc-row-title">{n.title || t("untitled")}</span>
                {n.children.length > 0 && <span className="doc-row-collection">{n.children.length}</span>}
              </button>
            ))}
          </section>
        )}
      </article>
    </div>
  );
}
