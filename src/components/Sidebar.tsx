import { useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import fractionalIndex from "fractional-index";
import type { Collection, Doc, NavNode, Star as StarRecord } from "../lib/api";
import type { Route } from "../lib/router";
import { useSettings } from "../lib/settings";
import type { Workspace } from "../lib/workspace";
import { EntityIcon } from "./EntityIcon";
import { mod } from "../lib/platform";
import { Archive, ChevronRight, Compose, FileText, Home, PanelLeft, Pencil, Plus, Search, Star, Trash } from "./icons";

export interface DocTarget {
  id: string;
  title: string;
  url: string;
  collectionId: string;
}

/** Where a dragged document would land. */
export type DropTarget = { kind: "doc"; id: string; zone: "before" | "after" | "inside" } | { kind: "collection"; id: string };

/** Where a dragged collection would land, among the other collections. */
type CollectionDrop = { kind: "collection-order"; id: string; zone: "before" | "after" };

interface Dragged {
  kind: "doc" | "collection";
  id: string;
}

interface DragState {
  drag: Dragged | null;
  drop: DropTarget | CollectionDrop | null;
  start: (item: Dragged, e: DragEvent) => void;
  over: (target: DropTarget | CollectionDrop, e: DragEvent) => void;
  end: () => void;
  finish: (e: DragEvent) => void;
}

interface Props {
  workspace: Workspace;
  /** The signed-in user. */
  meId: string;
  route: Route;
  /** Canonical id of the open document, once loaded. */
  activeDocId?: string;
  onNavigate: (route: Route) => void;
  onNewDoc: (collectionId?: string, parentDocumentId?: string) => void;
  onSearch: () => void;
  onClose: () => void;
  onContextMenu: (target: DocTarget, e: MouseEvent) => void;
  onMove: (id: string, target: DropTarget) => void;
  onMoveCollection: (id: string, index: string) => void;
  onNewCollection: () => void;
  onCollectionMenu: (collection: Collection, e: MouseEvent) => void;
}

type StarredItem = { kind: "doc"; star: StarRecord; doc: Doc } | { kind: "collection"; star: StarRecord; collection: Collection };

/** Top quarter: before, bottom quarter: after, middle: inside. */
function zoneOf(e: DragEvent): "before" | "after" | "inside" {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - rect.top) / rect.height;
  return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
}

export function Sidebar(p: Props) {
  const { t, settings, update } = useSettings();
  const { workspace } = p;
  const folded = new Set(settings.folded);
  const toggleFold = (key: string) =>
    update((s) => ({ folded: s.folded.includes(key) ? s.folded.filter((k) => k !== key) : [...s.folded, key] }));
  const isActive = (id: string) => p.activeDocId === id || (p.route.name === "doc" && p.route.id === id);

  const [drag, setDrag] = useState<Dragged | null>(null);
  const [drop, setDrop] = useState<DropTarget | CollectionDrop | null>(null);
  const allowed = (target: DropTarget | CollectionDrop) => {
    if (!drag) return false;
    // Collections only reorder among collections; documents never land between them.
    if (drag.kind === "collection") return target.kind === "collection-order" && target.id !== drag.id;
    if (target.kind === "collection-order") return false;
    if (target.kind === "collection") return true;
    // A document can't go into itself or one of its own children.
    if (target.id === drag.id) return false;
    return !workspace.locate(target.id)?.path.some((n) => n.id === drag.id);
  };
  /** A fractional index between the neighbours where the collection was dropped (as Outline does). */
  const collectionIndex = (target: CollectionDrop, draggedId: string): string => {
    const list = workspace.collections.filter((c) => c.id !== draggedId);
    const at = list.findIndex((c) => c.id === target.id);
    const before = target.zone === "before" ? list[at - 1] : list[at];
    const after = target.zone === "before" ? list[at] : list[at + 1];
    return fractionalIndex(before?.index ?? null, after?.index ?? null);
  };
  const dnd: DragState = {
    drag,
    drop,
    start: (item, e) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.id);
      setDrag(item);
    },
    over: (target, e) => {
      if (!allowed(target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (JSON.stringify(target) !== JSON.stringify(drop)) setDrop(target);
    },
    end: () => {
      setDrag(null);
      setDrop(null);
    },
    finish: (e) => {
      e.preventDefault();
      if (drag && drop && allowed(drop)) {
        if (drop.kind === "collection-order") p.onMoveCollection(drag.id, collectionIndex(drop, drag.id));
        else p.onMove(drag.id, drop);
      }
      setDrag(null);
      setDrop(null);
    },
  };

  // Starred documents and collections, in the order they were starred (or rearranged in Outline).
  const starred = workspace.stars.stars
    .slice()
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
    .flatMap((star): StarredItem[] => {
      const doc = star.documentId && workspace.stars.documents.find((d) => d.id === star.documentId);
      if (doc) return [{ kind: "doc", star, doc }];
      const collection = star.collectionId && workspace.collections.find((c) => c.id === star.collectionId);
      return collection ? [{ kind: "collection", star, collection }] : [];
    });

  const shared = workspace.shared.filter((d) => d.createdBy?.id !== p.meId);

  return (
    <aside className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region>
        <button className="icon-button" title={`${t("toggleSidebar")} (${mod}+B)`} onClick={p.onClose}>
          <PanelLeft />
        </button>
        <div className="toolbar-spacer" data-tauri-drag-region />
        <button className="icon-button" title={`${t("search")} (${mod}+K)`} onClick={p.onSearch}>
          <Search />
        </button>
        <button className="icon-button" title={`${t("newDoc")} (${mod}+N)`} onClick={() => p.onNewDoc()}>
          <Compose />
        </button>
      </div>
      <nav className="sidebar-nav">
        <button className={`sidebar-row${p.route.name === "home" ? " active" : ""}`} onClick={() => p.onNavigate({ name: "home" })}>
          <Home />
          <span>{t("home")}</span>
        </button>
      </nav>
      <div className="sidebar-scroll">
        {shared.length > 0 && (
          <section className="tree-group">
            <button className="tree-group-title" onClick={() => toggleFold("shared")}>
              <span>{t("sharedWithMe")}</span>
              <span className={`fold-chevron${folded.has("shared") ? "" : " open"}`}>
                <ChevronRight size={12} />
              </span>
            </button>
            {!folded.has("shared") &&
              shared.map((doc) => (
                <button
                  key={doc.id}
                  className={`tree-row${isActive(doc.id) ? " active" : ""}`}
                  style={{ "--depth": 0 } as CSSProperties}
                  onClick={() => p.onNavigate({ name: "doc", id: doc.id })}
                  onContextMenu={(e) => doc.collectionId && p.onContextMenu({ id: doc.id, title: doc.title, url: doc.url, collectionId: doc.collectionId }, e)}
                >
                  <span className="tree-chevron-space" />
                  <DocIcon icon={doc.icon} color={doc.color} />
                  <span className="tree-title">{doc.title || t("untitled")}</span>
                </button>
              ))}
          </section>
        )}
        {starred.length > 0 && (
          <section className="tree-group">
            <button className="tree-group-title" onClick={() => toggleFold("starred")}>
              <span>{t("starred")}</span>
              <span className={`fold-chevron${folded.has("starred") ? "" : " open"}`}>
                <ChevronRight size={12} />
              </span>
            </button>
            {!folded.has("starred") &&
              starred.map((s) =>
                s.kind === "collection" ? (
                  <button
                    key={s.star.id}
                    className={`tree-row${p.route.name === "collection" && p.route.id === s.collection.id ? " active" : ""}`}
                    style={{ "--depth": 0, "--c": s.collection.color ?? "var(--primary)" } as CSSProperties}
                    onClick={() => p.onNavigate({ name: "collection", id: s.collection.id })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      p.onCollectionMenu(s.collection, e);
                    }}
                  >
                    <span className="tree-chevron-space" />
                    <span className="tree-icon">
                      <EntityIcon icon={s.collection.icon} color={s.collection.color} size={18} fallback={<span className="collection-dot" />} />
                    </span>
                    <span className="tree-title">{s.collection.name}</span>
                  </button>
                ) : (
                  <button
                    key={s.star.id}
                    className={`tree-row${isActive(s.doc.id) ? " active" : ""}`}
                    style={{ "--depth": 0 } as CSSProperties}
                    onClick={() => p.onNavigate({ name: "doc", id: s.doc.id })}
                    onContextMenu={(e) => s.doc.collectionId && p.onContextMenu({ id: s.doc.id, title: s.doc.title, url: s.doc.url, collectionId: s.doc.collectionId }, e)}
                  >
                    <span className="tree-chevron-space" />
                    <DocIcon icon={s.doc.icon} color={s.doc.color} starred />
                    <span className="tree-title">{s.doc.title || t("untitled")}</span>
                  </button>
                ),
              )}
          </section>
        )}
        <section className="tree-group">
          <div className="tree-group-title static">
            <span>{t("collections")}</span>
            <button className="tree-group-add" title={t("newCollection")} onClick={p.onNewCollection}>
              <Plus size={13} />
            </button>
          </div>
          {workspace.collections.map((c) => (
            <CollectionBlock key={c.id} collection={c} {...p} folded={folded.has(c.id)} onToggleFold={() => toggleFold(c.id)} isActive={isActive} dnd={dnd} />
          ))}
        </section>
      </div>
      <nav className="sidebar-footer">
        {(
          [
            ["drafts", "drafts", <Pencil key="d" size={15} />],
            ["archive", "archiveTitle", <Archive key="a" size={15} />],
            ["trash", "trash", <Trash key="t" size={15} />],
          ] as const
        ).map(([name, label, icon]) => (
          <button key={name} className={`sidebar-row${p.route.name === name ? " active" : ""}`} onClick={() => p.onNavigate({ name })}>
            {icon}
            <span>{t(label)}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function DocIcon({ icon, color, starred }: { icon?: string | null; color?: string | null; starred?: boolean }) {
  return (
    <span className="tree-icon">
      <EntityIcon icon={icon} color={color} size={18} fallback={starred ? <Star size={14} /> : <FileText size={14} />} />
    </span>
  );
}

interface BlockProps extends Props {
  collection: Collection;
  folded: boolean;
  onToggleFold: () => void;
  isActive: (id: string) => boolean;
  dnd: DragState;
}

function CollectionBlock(p: BlockProps) {
  const { t, settings, update } = useSettings();
  const { collection } = p;
  const nodes = p.workspace.trees[collection.id] ?? [];
  const expanded = new Set(settings.expanded);
  const toggle = (id: string) =>
    update((s) => ({ expanded: s.expanded.includes(id) ? s.expanded.filter((k) => k !== id) : [...s.expanded, id] }));
  const active = p.route.name === "collection" && p.route.id === collection.id;
  const dropClass = (id: string) => {
    const d = p.dnd.drop;
    return d?.kind === "doc" && d.id === id ? ` drop-${d.zone}` : "";
  };
  const d = p.dnd.drop;
  const collectionDrop =
    d?.kind === "collection" && d.id === collection.id ? " drop-inside" : d?.kind === "collection-order" && d.id === collection.id ? ` drop-${d.zone}` : "";

  const renderNodes = (list: NavNode[], depth: number) =>
    list.map((node) => {
      const open = expanded.has(node.id);
      return (
        <div key={node.id} role="treeitem" aria-expanded={node.children.length ? open : undefined}>
          <div
            className={`tree-row${p.isActive(node.id) ? " active" : ""}${dropClass(node.id)}${p.dnd.drag?.id === node.id ? " dragging" : ""}`}
            style={{ "--depth": depth } as CSSProperties}
            role="button"
            tabIndex={0}
            draggable
            onDragStart={(e) => p.dnd.start({ kind: "doc", id: node.id }, e)}
            onDragOver={(e) => p.dnd.over({ kind: "doc", id: node.id, zone: zoneOf(e) }, e)}
            onDrop={p.dnd.finish}
            onDragEnd={p.dnd.end}
            onClick={() => p.onNavigate({ name: "doc", id: node.id })}
            onKeyDown={(e) => e.key === "Enter" && p.onNavigate({ name: "doc", id: node.id })}
            onContextMenu={(e) => p.onContextMenu({ id: node.id, title: node.title, url: node.url, collectionId: collection.id }, e)}
          >
            {node.children.length ? (
              <button
                className={`tree-chevron${open ? " open" : ""}`}
                aria-label={open ? "Collapse" : "Expand"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(node.id);
                }}
              >
                <ChevronRight size={12} />
              </button>
            ) : (
              <span className="tree-chevron-space" />
            )}
            <DocIcon icon={node.icon} color={node.color} />
            <span className="tree-title">{node.title || t("untitled")}</span>
            <button
              className="tree-add"
              title={t("newChild")}
              onClick={(e) => {
                e.stopPropagation();
                if (!open) toggle(node.id);
                p.onNewDoc(collection.id, node.id);
              }}
            >
              <Plus size={14} />
            </button>
          </div>
          {open && node.children.length > 0 && <div role="group">{renderNodes(node.children, depth + 1)}</div>}
        </div>
      );
    });

  return (
    <div className="collection-block">
      <div
        className={`tree-row collection-row${active ? " active" : ""}${collectionDrop}${p.dnd.drag?.id === collection.id ? " dragging" : ""}`}
        style={{ "--depth": 0, "--c": collection.color ?? "var(--primary)" } as CSSProperties}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => p.dnd.start({ kind: "collection", id: collection.id }, e)}
        onDragOver={(e) => {
          if (p.dnd.drag?.kind === "collection") {
            const rect = e.currentTarget.getBoundingClientRect();
            p.dnd.over({ kind: "collection-order", id: collection.id, zone: e.clientY < rect.top + rect.height / 2 ? "before" : "after" }, e);
          } else p.dnd.over({ kind: "collection", id: collection.id }, e);
        }}
        onDrop={p.dnd.finish}
        onDragEnd={p.dnd.end}
        onContextMenu={(e) => {
          e.preventDefault();
          p.onCollectionMenu(collection, e);
        }}
        onClick={() => p.onNavigate({ name: "collection", id: collection.id })}
        onKeyDown={(e) => e.key === "Enter" && p.onNavigate({ name: "collection", id: collection.id })}
      >
        <button
          className={`tree-chevron${p.folded ? "" : " open"}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onToggleFold();
          }}
        >
          <ChevronRight size={12} />
        </button>
        <span className="tree-icon">
          <EntityIcon icon={collection.icon} color={collection.color} size={18} fallback={<span className="collection-dot" />} />
        </span>
        <span className="tree-title">{collection.name}</span>
        <button
          className="tree-add"
          title={t("newDocIn", { name: collection.name })}
          onClick={(e) => {
            e.stopPropagation();
            p.onNewDoc(collection.id);
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {!p.folded && <div role="tree">{renderNodes(nodes, 1)}</div>}
    </div>
  );
}
