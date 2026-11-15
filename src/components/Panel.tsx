import type { EditorView } from "prosemirror-view";
import { useEffect, useState, type RefObject } from "react";
import type { User } from "../lib/api";
import type { Heading } from "../editor/Editor";
import type { PresenceUser } from "../editor/collab";
import type { DocMeta } from "./DocumentView";
import { isTauri } from "../lib/platform";
import { useSettings } from "../lib/settings";
import { ShortcutList } from "./SettingsDialog";
import { WindowControls } from "./Toolbar";
import { Comments } from "./Comments";
import { History, Insights } from "./History";
import { HistoryIcon, Info, ListTree, MessageSquare } from "./icons";

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
}

/** Right panel: contents, details and comments of the open document, or the shortcuts. */
export function Panel(p: Props) {
  const { t } = useSettings();
  const { meta, headings } = p;
  const minLevel = Math.min(...headings.map((h) => h.level), 4);

  const current = useCurrentHeading(p.viewRef, headings, p.tab === "contents" && !!meta);

  const scrollTo = (pos: number) => {
    const view = p.viewRef.current;
    if (!view) return;
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <aside className="panel">
      <div className="panel-header" data-tauri-drag-region>
        {meta ? (
          <div className="panel-tabs" role="tablist">
            {TABS.map(([tab, label, Icon]) => (
              <button key={tab} role="tab" aria-selected={p.tab === tab} className={p.tab === tab ? "active" : ""} title={t(label)} aria-label={t(label)} onClick={() => p.onTab(tab)}>
                <Icon size={16} />
              </button>
            ))}
          </div>
        ) : (
          <span className="panel-label" data-tauri-drag-region>
            {t("shortcuts")}
          </span>
        )}
        <div className="toolbar-spacer" data-tauri-drag-region />
        {isTauri && <WindowControls />}
      </div>
      <div className="panel-body">
        {meta && <div className="panel-tab-title">{t(TABS.find(([tab]) => tab === p.tab)![1])}</div>}
        {!meta ? (
          <ShortcutList />
        ) : p.tab === "history" ? (
          <History documentId={meta.doc.id} canUpdate={meta.canUpdate} onRestored={p.onRestored} onError={p.onError} />
        ) : p.tab === "insights" ? (
          <>
            <Details meta={meta} presence={p.presence} />
            <Insights documentId={meta.doc.id} onError={p.onError} />
          </>
        ) : p.tab === "comments" ? (
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
          <>
            {headings.length ? (
              <nav className="toc">
                {headings.map((h, i) => (
                  <button
                    key={h.pos}
                    className={`toc-item${i === current ? " active" : ""}${h.level === minLevel ? " top" : ""}`}
                    style={{ ["--indent" as string]: h.level - minLevel }}
                    title={h.text}
                    onClick={() => scrollTo(h.pos)}
                  >
                    {h.text || t("untitled")}
                  </button>
                ))}
              </nav>
            ) : (
              <p className="panel-note">{t("noHeadings")}</p>
            )}
          </>
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

/** The heading the reader is at: the last one scrolled past the top third of the page. */
function useCurrentHeading(viewRef: RefObject<EditorView | null>, headings: Heading[], active: boolean): number {
  const [current, setCurrent] = useState(-1);
  useEffect(() => {
    const scroller = document.getElementById("doc-scroll");
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
  }, [viewRef, headings, active]);
  return current;
}
