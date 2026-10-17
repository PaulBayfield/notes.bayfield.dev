import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DOMSerializer, Node } from "prosemirror-model";
import { listRevisions, listViews, resolveUrl, restoreRevision, revisionInfo, type Revision, type View } from "../lib/api";
import { useSettings } from "../lib/settings";
import { onRealtime } from "../lib/realtime";
import { schema } from "../editor/schema";
import { Avatar } from "./Avatar";
import { Dialog } from "./Dialogs";

/** Read-only rendering of stored document content. */
export function RenderedDoc({ data }: { data: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      const node = Node.fromJSON(schema, data);
      el.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(node.content));
      el.querySelectorAll("img").forEach((img) => img.setAttribute("src", resolveUrl(img.getAttribute("src"))));
    } catch {
      el.textContent = "";
    }
  }, [data]);
  return <div ref={ref} className="doc-content rendered-doc" />;
}

function RevisionDialog({ id, onRestore, onClose }: { id: string; onRestore: () => Promise<void>; onClose: () => void }) {
  const { t, f } = useSettings();
  const [revision, setRevision] = useState<Revision | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void revisionInfo(id).then(setRevision);
  }, [id]);
  return (
    <Dialog title={revision ? f.dateTime(revision.createdAt) : t("history")} onClose={onClose} wide>
      {revision ? (
        <div className="revision-preview doc">
          <h1 className="revision-title">{revision.title || t("untitled")}</h1>
          <RenderedDoc data={revision.data} />
        </div>
      ) : (
        <div className="skeleton-rows" />
      )}
      <div className="dialog-actions">
        <button className="text-button" onClick={onClose}>
          {t("close")}
        </button>
        <button
          className="primary-button"
          disabled={!revision || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRestore();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("restoreVersion")}
        </button>
      </div>
    </Dialog>
  );
}

/** The document's saved versions; one can be previewed and restored. */
export function History({ documentId, canUpdate, onRestored, onError }: { documentId: string; canUpdate: boolean; onRestored: () => void; onError: (e: unknown) => void }) {
  const { t, f } = useSettings();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const load = () => listRevisions(documentId).then(setRevisions).catch(onError);
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onRealtime(({ event }) => {
      if (event !== "entities" && !event.startsWith("documents.")) return;
      clearTimeout(timer);
      timer = setTimeout(load, 2000);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [documentId, onError]);

  if (!revisions) return <div className="skeleton-rows" />;
  if (!revisions.length) return <p className="panel-note">{t("noHistory")}</p>;
  return (
    <div className="history">
      {revisions.map((r, i) => (
        <button key={r.id} className="history-row" onClick={() => setOpen(r.id)}>
          <Avatar user={r.createdBy} size={22} />
          <span className="history-text">
            <span className="history-when" title={f.dateTime(r.createdAt)}>
              {i === 0 ? t("currentVersion") : f.relative(r.createdAt)}
            </span>
            <span className="history-who">{r.name || (r.collaborators?.length ? r.collaborators.map((c) => c.name).join(", ") : r.createdBy.name)}</span>
          </span>
        </button>
      ))}
      {open && (
        <RevisionDialog
          id={open}
          onClose={() => setOpen(null)}
          onRestore={async () => {
            if (!canUpdate) return;
            try {
              await restoreRevision(documentId, open);
              onRestored();
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
    </div>
  );
}

/** Who viewed the document, and how often. */
export function Insights({ documentId, onError }: { documentId: string; onError: (e: unknown) => void }) {
  const { t, f } = useSettings();
  const [views, setViews] = useState<View[] | null>(null);
  useEffect(() => {
    listViews(documentId)
      .then((v) => setViews(v.sort((a, b) => (b.lastViewedAt ?? "").localeCompare(a.lastViewedAt ?? ""))))
      .catch(onError);
  }, [documentId, onError]);
  if (!views) return <div className="skeleton-rows" />;
  const total = views.reduce((n, v) => n + v.count, 0);
  return (
    <div className="history">
      <div className="insight-summary">
        <div>
          <strong>{views.length}</strong>
          <span>{t("viewers")}</span>
        </div>
        <div>
          <strong>{total}</strong>
          <span>{t("views")}</span>
        </div>
      </div>
      {views.map((v) => (
        <div key={v.id} className="history-row static">
          <Avatar user={v.user} size={22} />
          <span className="history-text">
            <span className="history-who">{v.user.name}</span>
            <span className="history-when">{t("viewedTimes", { n: v.count, time: v.lastViewedAt ? f.relative(v.lastViewedAt) : "" })}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
