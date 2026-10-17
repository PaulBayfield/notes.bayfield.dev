import type { EditorView } from "prosemirror-view";
import type { RefObject } from "react";
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
import { BarChart, HistoryIcon, ListTree, MessageSquare } from "./icons";

export type PanelTab = "contents" | "comments" | "history" | "insights";

const TABS = [
  ["contents", "contents", ListTree],
  ["comments", "comments", MessageSquare],
  ["history", "history", HistoryIcon],
  ["insights", "insights", BarChart],
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
  const { t, f } = useSettings();
  const { meta, headings } = p;
  const minLevel = Math.min(...headings.map((h) => h.level), 4);

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
          <Insights documentId={meta.doc.id} onError={p.onError} />
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
                {headings.map((h) => (
                  <button key={h.pos} className="toc-item" style={{ paddingLeft: 8 + (h.level - minLevel) * 14 }} onClick={() => scrollTo(h.pos)}>
                    {h.text}
                  </button>
                ))}
              </nav>
            ) : (
              <p className="panel-note">{t("noHeadings")}</p>
            )}
            <div className="panel-section details">
              <div className="panel-subtitle">{t("details")}</div>
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
              {p.presence.length > 0 && (
                <div className="detail-row">
                  <span>{t("collaborators")}</span>
                  <span>{p.presence.map((u) => u.name).join(", ")}</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
