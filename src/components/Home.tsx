import { useCallback, useEffect, useRef, useState } from "react";
import type { Node } from "prosemirror-model";
import { can, collectionDetails, listPins, recentlyUpdated, recentlyViewed, updateCollection, type Doc, type NavNode, type RichText, type User } from "../lib/api";
import type { Route } from "../lib/router";
import { useSettings } from "../lib/settings";
import { onRealtime } from "../lib/realtime";
import type { Workspace } from "../lib/workspace";
import { docFrom, StaticEditor } from "../editor/StaticEditor";
import { EntityIcon } from "./EntityIcon";
import { FileText, Pencil, PinIcon, Plus } from "./icons";

function DocRow({ doc, workspace, onOpen }: { doc: Pick<Doc, "id" | "title" | "icon" | "color" | "collectionId" | "updatedAt">; workspace: Workspace; onOpen: () => void }) {
  const { t, f } = useSettings();
  const collection = workspace.collections.find((c) => c.id === doc.collectionId);
  return (
    <button className="doc-row" onClick={onOpen}>
      <span className="doc-row-icon">
        <EntityIcon icon={doc.icon} color={doc.color} size={20} fallback={<FileText size={16} />} />
      </span>
      <span className="doc-row-title">{doc.title || t("untitled")}</span>
      {collection && <span className="doc-row-collection">{collection.name}</span>}
      <span className="doc-row-time">{f.relative(doc.updatedAt)}</span>
    </button>
  );
}

/** Pinned documents, as cards. */
function Pinned({ collectionId, onNavigate, onError }: { collectionId?: string; onNavigate: (r: Route) => void; onError: (e: unknown) => void }) {
  const { t } = useSettings();
  const [docs, setDocs] = useState<Doc[]>([]);
  useEffect(() => {
    const load = () =>
      listPins(collectionId)
        .then(({ pins, documents }) =>
          setDocs(
            pins
              .slice()
              .sort((a, b) => (a.index < b.index ? -1 : 1))
              .map((p) => documents.find((d) => d.id === p.documentId))
              .filter((d): d is Doc => !!d),
          ),
        )
        .catch(onError);
    void load();
    return onRealtime(({ event }) => event.startsWith("pins.") && void load());
  }, [collectionId, onError]);
  if (!docs.length) return null;
  return (
    <section className="home-section">
      <h2>
        <PinIcon size={12} /> {t("pinned")}
      </h2>
      <div className="pin-grid">
        {docs.map((d) => (
          <button key={d.id} className="pin-card" onClick={() => onNavigate({ name: "doc", id: d.id })}>
            <EntityIcon icon={d.icon} color={d.color} size={22} fallback={<FileText size={18} />} />
            <span className="pin-title">{d.title || t("untitled")}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function Home({ workspace, onNavigate, onError }: { workspace: Workspace; onNavigate: (r: Route) => void; onError: (e: unknown) => void }) {
  const { t } = useSettings();
  const [viewed, setViewed] = useState<Doc[] | null>(null);
  const [updated, setUpdated] = useState<Doc[] | null>(null);

  useEffect(() => {
    recentlyViewed(8).then(setViewed).catch(onError);
    recentlyUpdated(15).then(setUpdated).catch(onError);
  }, [onError]);

  const section = (title: string, docs: Doc[] | null) => (
    <section className="home-section">
      <h2>{title}</h2>
      {docs === null ? (
        <div className="skeleton-rows" />
      ) : docs.length === 0 ? (
        <p className="muted">{t("nothingYet")}</p>
      ) : (
        docs.map((d) => <DocRow key={d.id} doc={d} workspace={workspace} onOpen={() => onNavigate({ name: "doc", id: d.id })} />)
      )}
    </section>
  );

  return (
    <div className="doc-scroll">
      <div className="page">
        <Pinned onNavigate={onNavigate} onError={onError} />
        {section(t("recentlyViewed"), viewed)}
        {section(t("recentlyUpdated"), updated)}
      </div>
    </div>
  );
}

export function CollectionView({
  id,
  workspace,
  user,
  onNavigate,
  onNewDoc,
  onEdit,
  onError,
}: {
  id: string;
  workspace: Workspace;
  user: User;
  onNavigate: (r: Route) => void;
  onNewDoc: (collectionId: string) => void;
  onEdit: (collectionId: string) => void;
  onError: (e: unknown) => void;
}) {
  const { t, settings } = useSettings();
  const collection = workspace.collections.find((c) => c.id === id || c.urlId === id);
  const [overview, setOverview] = useState<{ doc: Node; editable: boolean; version: number } | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<RichText | null>(null);
  const collectionId = collection?.id;

  const load = useCallback(async () => {
    if (!collectionId) return;
    try {
      const res = await collectionDetails(collectionId);
      setOverview((prev) => ({ doc: docFrom(res.data.data, res.data.description), editable: can(res, collectionId, "update"), version: (prev?.version ?? 0) + 1 }));
    } catch (e) {
      onError(e);
    }
  }, [collectionId, onError]);

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    const data = pending.current;
    pending.current = null;
    dirty.current = false;
    if (data && collectionId) updateCollection(collectionId, { data }).catch(onError);
  }, [collectionId, onError]);

  useEffect(() => {
    setOverview(null);
    void load();
    // Someone else edited the overview: reload it, unless we're typing in it.
    const stop = onRealtime(({ event, data }) => {
      if (event === "collections.update" && (data as { id?: string })?.id === collectionId && !dirty.current) void load();
    });
    return () => {
      stop();
      flush();
    };
  }, [load, flush, collectionId]);

  if (!collection) return <div className="doc-scroll" />;
  const nodes = workspace.trees[collection.id] ?? [];
  const count = (list: NavNode[]): number => list.reduce((n, x) => n + 1 + count(x.children), 0);
  const total = count(nodes);

  return (
    <div className="doc-scroll">
      <div className={`page collection-page font-${settings.font}`}>
        <header className="collection-header">
          <span className="collection-badge" style={{ background: collection.color ?? "var(--primary)" }}>
            <EntityIcon icon={collection.icon} color="#fff" size={28} fallback={collection.name.charAt(0).toUpperCase()} />
          </span>
          <div>
            <h1>{collection.name}</h1>
            <p className="muted">{total === 1 ? t("oneDocument") : t("documentsCount", { n: total })}</p>
          </div>
          <div className="toolbar-spacer" />
          {overview?.editable && (
            <button className="text-button with-icon" onClick={() => onEdit(collection.id)}>
              <Pencil size={14} /> {t("edit")}
            </button>
          )}
          <button className="primary-button with-icon" onClick={() => onNewDoc(collection.id)}>
            <Plus size={14} /> {t("newDoc")}
          </button>
        </header>
        {overview ? (
          <div className="collection-overview" style={{ fontSize: settings.fontSize }}>
            <StaticEditor
              key={`${collection.id}:${overview.version}`}
              doc={overview.doc}
              editable={overview.editable}
              placeholder={t("addDescription")}
              t={t}
              user={user}
              onOpenDocument={(docId) => onNavigate({ name: "doc", id: docId })}
              onChange={(json) => {
                dirty.current = true;
                pending.current = json;
                clearTimeout(saveTimer.current);
                saveTimer.current = setTimeout(flush, 1000);
              }}
            />
          </div>
        ) : (
          <div className="skeleton-rows" />
        )}
        <Pinned collectionId={collection.id} onNavigate={onNavigate} onError={onError} />
        <section className="home-section">
          <h2>{t("documents")}</h2>
          {nodes.length === 0 ? (
            <p className="muted">{t("emptyCollection")}</p>
          ) : (
            nodes.map((n) => (
              <button key={n.id} className="doc-row" onClick={() => onNavigate({ name: "doc", id: n.id })}>
                <span className="doc-row-icon">
                  <EntityIcon icon={n.icon} color={n.color} size={20} fallback={<FileText size={16} />} />
                </span>
                <span className="doc-row-title">{n.title || t("untitled")}</span>
                {n.children.length > 0 && <span className="doc-row-collection">{count(n.children)}</span>}
              </button>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
