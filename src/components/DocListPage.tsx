import { useCallback, useEffect, useState } from "react";
import { destroyDocument, emptyTrash, listArchived, listDeleted, listDrafts, restoreDocument, type Doc } from "../lib/api";
import { onRealtime } from "../lib/realtime";
import type { ListPage, Route } from "../lib/router";
import { useSettings } from "../lib/settings";
import type { Workspace } from "../lib/workspace";
import { ConfirmDialog } from "./Dialogs";
import { EntityIcon } from "./EntityIcon";
import { Archive, FileText, Pencil, Restore, Trash } from "./icons";

const LOADERS: Record<ListPage, () => Promise<Doc[]>> = { drafts: listDrafts, archive: listArchived, trash: listDeleted };

/** Drafts, archived or deleted documents. */
export function DocListPage({
  page,
  workspace,
  onNavigate,
  onError,
  flash,
}: {
  page: ListPage;
  workspace: Workspace;
  onNavigate: (r: Route) => void;
  onError: (e: unknown) => void;
  flash: (message: string) => void;
}) {
  const { t, f } = useSettings();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "destroy"; doc: Doc } | { kind: "empty" } | null>(null);

  const load = useCallback(() => {
    LOADERS[page]()
      .then(setDocs)
      .catch((e) => {
        setDocs([]);
        onError(e);
      });
  }, [page, onError]);

  useEffect(() => {
    setDocs(null);
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onRealtime(({ event }) => {
      if (event !== "entities" && !event.startsWith("documents.")) return;
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [load]);

  const restore = (doc: Doc) =>
    restoreDocument(doc.id)
      .then(() => {
        flash(t("restoredDoc"));
        load();
        if (doc.collectionId) void workspace.refreshCollection(doc.collectionId);
      })
      .catch(onError);

  const title = t(page === "drafts" ? "drafts" : page === "archive" ? "archiveTitle" : "trash");
  const empty = t(page === "drafts" ? "noDrafts" : page === "archive" ? "noArchived" : "noDeleted");
  const PageIcon = page === "drafts" ? Pencil : page === "archive" ? Archive : Trash;

  return (
    <div className="doc-scroll">
      <div className="page">
        <header className="collection-header">
          <span className="collection-badge neutral">
            <PageIcon size={22} />
          </span>
          <div>
            <h1>{title}</h1>
            <p className="muted">{t(`${page}Hint` as "draftsHint")}</p>
          </div>
          <div className="toolbar-spacer" />
          {page === "trash" && !!docs?.length && (
            <button className="text-button" onClick={() => setConfirm({ kind: "empty" })}>
              {t("emptyTrash")}
            </button>
          )}
        </header>
        <section className="home-section">
          {docs === null ? (
            <div className="skeleton-rows" />
          ) : docs.length === 0 ? (
            <p className="muted">{empty}</p>
          ) : (
            docs.map((d) => {
              const collection = workspace.collections.find((c) => c.id === d.collectionId);
              const when = page === "trash" ? d.deletedAt : page === "archive" ? d.archivedAt : d.updatedAt;
              return (
                <div key={d.id} className="doc-row list-row">
                  <button className="list-row-main" onClick={() => onNavigate({ name: "doc", id: d.id })}>
                    <span className="doc-row-icon">
                      <EntityIcon icon={d.icon} color={d.color} size={20} fallback={<FileText size={16} />} />
                    </span>
                    <span className="doc-row-title">{d.title || t("untitled")}</span>
                    {collection && <span className="doc-row-collection">{collection.name}</span>}
                    {when && <span className="doc-row-time">{f.relative(when)}</span>}
                  </button>
                  {page !== "drafts" && (
                    <button className="icon-button small" title={t("restore")} onClick={() => void restore(d)}>
                      <Restore size={14} />
                    </button>
                  )}
                  {page === "trash" && (
                    <button className="icon-button small danger" title={t("deleteForever")} onClick={() => setConfirm({ kind: "destroy", doc: d })}>
                      <Trash size={14} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </section>
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "empty" ? t("emptyTrash") : t("deleteForever")}
          message={confirm.kind === "empty" ? t("emptyTrashMessage") : t("deleteForeverMessage", { title: confirm.doc.title || t("untitled") })}
          confirm={t("delete")}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              if (confirm.kind === "empty") await emptyTrash();
              else await destroyDocument(confirm.doc.id);
              load();
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
    </div>
  );
}
