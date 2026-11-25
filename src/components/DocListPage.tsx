import { useCallback, useEffect, useState } from "react";
import { deleteDocument, destroyDocument, emptyTrash, listArchived, listArchivedCollections, listDeleted, listDrafts, restoreCollection, restoreDocument, type Collection, type Doc } from "../lib/api";
import { onRealtime } from "../lib/realtime";
import type { ListPage, Route } from "../lib/router";
import { useSettings } from "../lib/settings";
import type { Workspace } from "../lib/workspace";
import { ConfirmDialog } from "./Dialogs";
import { EntityIcon } from "./EntityIcon";
import { Archive, FileText, Pencil, Restore, Trash } from "./icons";

const LOADERS: Record<ListPage, () => Promise<Doc[]>> = { drafts: listDrafts, archive: listArchived, trash: listDeleted };
/** Documents in the trash are deleted for good after this many days (the server's housekeeping). */
const TRASH_DAYS = 30;

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
  const [collections, setCollections] = useState<Collection[]>([]);
  const [confirm, setConfirm] = useState<{ kind: "destroy" | "trash"; doc: Doc } | { kind: "empty" } | null>(null);

  const load = useCallback(() => {
    if (page === "archive")
      listArchivedCollections()
        .then(setCollections)
        .catch(() => setCollections([]));
    else setCollections([]);
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

  const restoreCol = (c: Collection) =>
    restoreCollection(c.id)
      .then(() => {
        flash(t("restoredCollection", { name: c.name }));
        load();
        void workspace.refresh();
      })
      .catch(onError);
  const daysLeft = (deletedAt: string) => Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - new Date(deletedAt).getTime()) / 86_400_000));

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
        {collections.length > 0 && (
          <section className="home-section">
            <h2>{t("collections")}</h2>
            {collections.map((c) => (
              <div key={c.id} className="doc-row list-row">
                <span className="list-row-main static">
                  <span className="doc-row-icon">
                    <EntityIcon icon={c.icon} color={c.color} size={20} fallback={<Archive size={16} />} />
                  </span>
                  <span className="doc-row-title">{c.name}</span>
                </span>
                <button className="icon-button small" title={t("restore")} onClick={() => void restoreCol(c)}>
                  <Restore size={14} />
                </button>
              </div>
            ))}
          </section>
        )}
        <section className="home-section">
          {collections.length > 0 && <h2>{t("documents")}</h2>}
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
                    {page === "trash" && d.deletedAt ? (
                      <span className="doc-row-time" title={f.dateTime(d.deletedAt)}>
                        {t("deletedInDays", { n: daysLeft(d.deletedAt) })}
                      </span>
                    ) : (
                      when && <span className="doc-row-time" title={f.dateTime(when)}>{f.relative(when)}</span>
                    )}
                  </button>
                  {page !== "drafts" && (
                    <button className="icon-button small" title={t("restore")} onClick={() => void restore(d)}>
                      <Restore size={14} />
                    </button>
                  )}
                  {page === "archive" && (
                    <button className="icon-button small danger" title={t("delete")} onClick={() => setConfirm({ kind: "trash", doc: d })}>
                      <Trash size={14} />
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
          title={confirm.kind === "empty" ? t("emptyTrash") : confirm.kind === "trash" ? t("deleteDocTitle") : t("deleteForever")}
          message={
            confirm.kind === "empty"
              ? t("emptyTrashMessage")
              : t(confirm.kind === "trash" ? "deleteDocMessage" : "deleteForeverMessage", { title: confirm.doc.title || t("untitled") })
          }
          confirm={t("delete")}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              if (confirm.kind === "empty") await emptyTrash();
              else if (confirm.kind === "trash") {
                // Archived documents go to the trash first, as in Outline.
                await deleteDocument(confirm.doc.id);
                flash(t("deleted"));
              } else await destroyDocument(confirm.doc.id);
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
