import type { EditorView } from "prosemirror-view";
import { useEffect, useRef, useState, type RefObject } from "react";
import { backlinks, type Doc, type User } from "../lib/api";
import type { Heading } from "../editor/Editor";
import type { PresenceUser } from "../editor/collab";
import type { DocMeta } from "./DocumentView";
import { isTauri } from "../lib/platform";
import { useSettings } from "../lib/settings";
import { ShortcutList } from "./SettingsDialog";
import { WindowControls } from "./Toolbar";
import { Comments } from "./Comments";
import { History, Insights } from "./History";
import { Crosshair, FileText, HistoryIcon, Info, ListTree, MessageSquare, X } from "./icons";
import { EntityIcon } from "./EntityIcon";
import { MOBILE_QUERY } from "../lib/useMediaQuery";

export type PanelTab = "contents" | "comments" | "history" | "insights";

const TABS = [
  ["contents", "contents", ListTree],
  ["comments", "comments", MessageSquare],
  ["history", "history", HistoryIcon],
  ["insights", "details", Info],
] as const;

interface Props {
  meta: DocMeta | null;
  headings: Heading[];
  presence: PresenceUser[];
  viewRef: RefObject<EditorView | null>;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  user: User;
  docTick: number;
  draftComment: string | null;
  onDraftDone: () => void;
  activeComment: string | null;
  onActivateComment: (id: string | null) => void;
  onError: (e: unknown) => void;
  /** A revision was restored: reload the document. */
  onRestored: () => void;
  /** Opens another document (a backlink). */
  onOpenDoc: (id: string, newTab: boolean) => void;
  /** Focus mode: just the table of contents, without the other tabs. */
  contentsOnly?: boolean;
  /** The table of contents is beside the document (the workspace's "left" setting): no Contents tab. */
  tocBeside?: boolean;
  /** Set when the panel slides over the page (narrow windows): it gets its own close button. */
  onClose?: () => void;
}

/** Right panel: contents, details and comments of the open document, or the shortcuts. */
export function Panel(p: Props) {
  const { t, settings, update } = useSettings();
  const { meta, headings } = p;
  const tabs = p.tocBeside ? TABS.filter(([id]) => id !== "contents") : TABS;
  const tab: PanelTab = p.contentsOnly ? "contents" : p.tocBeside && p.tab === "contents" ? "comments" : p.tab;
  const sync = settings.tocSync;

  return (
    <aside className={`panel${p.onClose ? " overlay" : ""}`}>
      <div className="panel-header" data-tauri-drag-region>
        {meta && !p.contentsOnly ? (
          <div className="panel-tabs" role="tablist">
            {tabs.map(([id, label, Icon]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} title={t(label)} aria-label={t(label)} onClick={() => p.onTab(id)}>
                <Icon size={16} />
              </button>
            ))}
          </div>
        ) : (
          <span className="panel-label" data-tauri-drag-region>
            {t(meta ? "contents" : "shortcuts")}
          </span>
        )}
        <div className="toolbar-spacer" data-tauri-drag-region />
        {p.onClose && (
          <button className="icon-button panel-close" title={`${t("close")} (Esc)`} aria-label={t("close")} onClick={p.onClose}>
            <X size={16} />
          </button>
        )}
        {isTauri && <WindowControls />}
      </div>
      <div className="panel-body">
        {meta && (!p.contentsOnly || tab === "contents") && (
          <div className="panel-tab-title">
            {!p.contentsOnly && t(TABS.find(([id]) => id === tab)![1])}
            {tab === "contents" && headings.length > 0 && (
              <button
                className={`icon-button small toc-sync${sync ? " active" : ""}`}
                aria-pressed={sync}
                title={sync ? t("tocSyncOn") : t("tocSyncOff")}
                aria-label={t("tocSync")}
                onClick={() => update({ tocSync: !sync })}
              >
                <Crosshair size={14} />
              </button>
            )}
          </div>
        )}
        {!meta ? (
          <ShortcutList />
        ) : tab === "history" ? (
          <History documentId={meta.doc.id} canUpdate={meta.canUpdate} onRestored={p.onRestored} onError={p.onError} />
        ) : tab === "insights" ? (
          <>
            <Details meta={meta} presence={p.presence} />
            <Backlinks documentId={meta.doc.id} docTick={p.docTick} onOpen={p.onOpenDoc} />
            <Insights documentId={meta.doc.id} onError={p.onError} />
          </>
        ) : tab === "comments" ? (
          <Comments
            documentId={meta.doc.id}
            user={p.user}
            viewRef={p.viewRef}
            docTick={p.docTick}
            draftId={p.draftComment}
            onDraftDone={p.onDraftDone}
            activeId={p.activeComment}
            onActivate={p.onActivateComment}
            onError={p.onError}
          />
        ) : (
          <TocNav
            headings={headings}
            viewRef={p.viewRef}
            scroller={() => document.getElementById("doc-scroll")}
            active={tab === "contents" && !!meta}
            onPicked={() => p.onClose && matchMedia(MOBILE_QUERY).matches && p.onClose()}
          />
        )}
      </div>
    </aside>
  );
}

/** When the document was written and by whom, and who's in it now. */
function Details({ meta, presence }: { meta: DocMeta; presence: PresenceUser[] }) {
  const { t, f } = useSettings();
  return (
    <div className="panel-section details">
      <div className="detail-row">
        <span>{t("updated")}</span>
        <span title={f.dateTime(meta.doc.updatedAt)}>
          {f.relative(meta.doc.updatedAt)}
          {meta.doc.updatedBy && <span className="muted"> · {t("by", { name: meta.doc.updatedBy.name })}</span>}
        </span>
      </div>
      <div className="detail-row">
        <span>{t("created")}</span>
        <span title={f.dateTime(meta.doc.createdAt)}>
          {f.relative(meta.doc.createdAt)}
          {meta.doc.createdBy && <span className="muted"> · {t("by", { name: meta.doc.createdBy.name })}</span>}
        </span>
      </div>
      {presence.length > 0 && (
        <div className="detail-row">
          <span>{t("collaborators")}</span>
          <span>{presence.map((u) => u.name).join(", ")}</span>
        </div>
      )}
    </div>
  );
}

/** The documents that link to this one. */
function Backlinks({ documentId, docTick, onOpen }: { documentId: string; docTick: number; onOpen: (id: string, newTab: boolean) => void }) {
  const { t } = useSettings();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    backlinks(documentId)
      .then((d) => !cancelled && setDocs(d))
      .catch(() => !cancelled && setDocs([]));
    return () => {
      cancelled = true;
    };
  }, [documentId, docTick]);
  if (!docs?.length) return null;
  return (
    <div className="panel-section backlinks">
      <div className="panel-subtitle">{t("referencedBy")}</div>
      {docs.map((d) => (
        <button key={d.id} className="backlink" title={d.title} onClick={(e) => onOpen(d.id, e.ctrlKey || e.metaKey)} onAuxClick={(e) => e.button === 1 && onOpen(d.id, true)}>
          <EntityIcon icon={d.icon} color={d.color} size={16} fallback={<FileText size={14} />} />
          <span>{d.title || t("untitled")}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A document's table of contents: its headings, the one being read highlighted (when following is on),
 * a click scrolls there. In the panel, or beside the document.
 */
export function TocNav({
  headings,
  viewRef,
  scroller,
  active,
  onPicked,
}: {
  headings: Heading[];
  viewRef: RefObject<EditorView | null>;
  /** The element the document scrolls in. */
  scroller: () => HTMLElement | null;
  /** Shown: only then does it follow the reading position. */
  active: boolean;
  onPicked?: () => void;
}) {
  const { t, settings } = useSettings();
  const sync = settings.tocSync;
  const minLevel = Math.min(...headings.map((h) => h.level), 4);
  const current = useCurrentHeading(viewRef, headings, active && sync, scroller);
  // In a long table of contents, the heading being read stays in view.
  const tocRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!sync || current < 0) return;
    tocRef.current?.querySelector<HTMLElement>(".toc-item.active")?.scrollIntoView({ block: "nearest" });
  }, [current, sync]);

  const scrollTo = (pos: number) => {
    const dom = viewRef.current?.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: "smooth", block: "start" });
    onPicked?.();
  };

  if (!headings.length) return <p className="panel-note">{t("noHeadings")}</p>;
  return (
    <nav className="toc" ref={tocRef}>
      {headings.map((h, i) => (
        <button
          key={h.pos}
          className={`toc-item${sync && i === current ? " active" : ""}${h.level === minLevel ? " top" : ""}`}
          style={{ ["--indent" as string]: h.level - minLevel }}
          title={h.text}
          onClick={() => scrollTo(h.pos)}
        >
          {h.text || t("untitled")}
        </button>
      ))}
    </nav>
  );
}

/** The heading the reader is at: the last one scrolled past the top third of the page. */
function useCurrentHeading(viewRef: RefObject<EditorView | null>, headings: Heading[], active: boolean, getScroller: () => HTMLElement | null): number {
  const [current, setCurrent] = useState(-1);
  useEffect(() => {
    const scroller = getScroller();
    if (!active || !scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const view = viewRef.current;
      if (!view) return;
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let found = -1;
      headings.forEach((h, i) => {
        const dom = view.nodeDOM(h.pos);
        if (dom instanceof HTMLElement && dom.getBoundingClientRect().top <= line) found = i;
      });
      setCurrent(found);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(measure));
    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRef, headings, active]);
  return current;
}
