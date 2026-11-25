import { useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import fractionalIndex from "fractional-index";
import type { Collection, Doc, NavNode, Star as StarRecord, Team } from "../lib/api";
import type { Route } from "../lib/router";
import { useSettings } from "../lib/settings";
import type { Workspace } from "../lib/workspace";
import { Avatar } from "./Avatar";
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
  /** `newTab`: Ctrl+click or a middle click, which open the page in a new tab. */
  onNavigate: (route: Route, newTab?: boolean) => void;
  onNewDoc: (collectionId?: string, parentDocumentId?: string) => void;
  onSearch: () => void;
  onClose: () => void;
  onContextMenu: (target: DocTarget, e: MouseEvent) => void;
  onMove: (id: string, target: DropTarget) => void;
  onMoveCollection: (id: string, index: string) => void;
  /** A starred item was dragged to a new place among the starred ones. */
  onMoveStar: (id: string, index: string) => void;
  onNewCollection: () => void;
  team: Team;
  /** The workspace name was clicked. */
  onOpenWorkspace: () => void;
  onCollectionMenu: (collection: Collection, e: MouseEvent) => void;
}

/** A click opens the page here; Ctrl+click or a middle click opens it in a new tab. */
function navProps(p: Pick<Props, "onNavigate">, route: Route) {
  return {
    onClick: (e: MouseEvent) => p.onNavigate(route, e.ctrlKey || e.metaKey),
    onMouseDown: (e: MouseEvent) => e.button === 1 && e.preventDefault(),
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      p.onNavigate(route, true);
    },
  };
}

type StarredItem = { kind: "doc"; star: StarRecord; doc: Doc } | { kind: "collection"; star: StarRecord; collection: Collection };

/** Prefix for the open/closed state of trees under Starred, kept apart from the collections'. */
const STAR_FOLD = "star:";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 248;

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
  const expanded = new Set(settings.expanded);
  const toggleExpanded = (key: string) =>
    update((s) => ({ expanded: s.expanded.includes(key) ? s.expanded.filter((k) => k !== key) : [...s.expanded, key] }));
  const isActive = (id: string) => p.activeDocId === id || (p.route.name === "doc" && p.route.id === id);

  // Starred items reorder among themselves (Outline's stars.update), apart from the tree's drag and drop.
  const [starDrag, setStarDrag] = useState<string | null>(null);
  const [starDrop, setStarDrop] = useState<{ id: string; zone: "before" | "after" } | null>(null);
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

  // Dragging the right edge resizes; the width is saved once the drag ends.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? settings.sidebarWidth ?? SIDEBAR_DEFAULT;
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    let next = startWidth;
    const move = (ev: globalThis.PointerEvent) => {
      next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setDragWidth(next);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing");
      update({ sidebarWidth: next });
      setDragWidth(null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    document.body.classList.add("resizing");
  };

  return (
    <aside className="sidebar" style={{ "--sidebar-w": `${width}px` } as CSSProperties}>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        title={t("resizeSidebar")}
        onPointerDown={startResize}
        onDoubleClick={() => update({ sidebarWidth: SIDEBAR_DEFAULT })}
      />
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
        <button className="sidebar-row workspace-row" title={p.team.name} onClick={p.onOpenWorkspace}>
          <Avatar user={{ name: p.team.name, color: "var(--primary)", avatarUrl: p.team.avatarUrl }} size={22} className="square" />
          <span>{p.team.name}</span>
        </button>
        <button className={`sidebar-row${p.route.name === "home" ? " active" : ""}`} {...navProps(p, { name: "home" })}>
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
                  {...navProps(p, { name: "doc", id: doc.id })}
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
              starred.map((s) => {
                // Starred items unfold like the collection tree, remembered separately ("star:…").
                const located = s.kind === "doc" ? workspace.locate(s.doc.id) : null;
                const children = s.kind === "doc" ? (located?.node.children ?? []) : (workspace.trees[s.collection.id] ?? []);
                const collectionId = s.kind === "doc" ? (located?.collection.id ?? s.doc.collectionId ?? "") : s.collection.id;
                const id = s.kind === "doc" ? s.doc.id : s.collection.id;
                const open = expanded.has(STAR_FOLD + id) && children.length > 0;
                const chevron = children.length ? (
                  <button
                    className={`tree-chevron${open ? " open" : ""}`}
                    aria-label={open ? "Collapse" : "Expand"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(STAR_FOLD + id);
                    }}
                  >
                    <ChevronRight size={12} />
                  </button>
                ) : (
                  <span className="tree-chevron-space" />
                );
                const dropClass = starDrop?.id === s.star.id && starDrag !== s.star.id ? ` star-drop-${starDrop.zone}` : "";
                return (
                  <div
                    key={s.star.id}
                    role="treeitem"
                    aria-expanded={children.length ? open : undefined}
                    className={`starred-item${dropClass}${starDrag === s.star.id ? " dragging" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", s.star.id);
                      setStarDrag(s.star.id);
                    }}
                    onDragOver={(e) => {
                      if (!starDrag) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const zone = e.clientY < rect.top + Math.min(rect.height, 30) / 2 ? "before" : "after";
                      if (starDrop?.id !== s.star.id || starDrop.zone !== zone) setStarDrop({ id: s.star.id, zone });
                    }}
                    onDrop={(e) => {
                      if (!starDrag || !starDrop) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const list = starred.filter((x) => x.star.id !== starDrag);
                      const at = list.findIndex((x) => x.star.id === starDrop.id);
                      const before = starDrop.zone === "before" ? list[at - 1] : list[at];
                      const after = starDrop.zone === "before" ? list[at] : list[at + 1];
                      if (starDrop.id !== starDrag) p.onMoveStar(starDrag, fractionalIndex(before?.star.index ?? null, after?.star.index ?? null));
                      setStarDrag(null);
                      setStarDrop(null);
                    }}
                    onDragEnd={() => {
                      setStarDrag(null);
                      setStarDrop(null);
                    }}
                  >
                    {s.kind === "collection" ? (
                      <div
                        className={`tree-row${p.route.name === "collection" && p.route.id === s.collection.id ? " active" : ""}`}
                        style={{ "--depth": 0, "--c": s.collection.color ?? "var(--primary)" } as CSSProperties}
                        role="button"
                        tabIndex={0}
                        {...navProps(p, { name: "collection", id: s.collection.id })}
                        onKeyDown={(e) => e.key === "Enter" && p.onNavigate({ name: "collection", id: s.collection.id })}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          p.onCollectionMenu(s.collection, e);
                        }}
                      >
                        {chevron}
                        <span className="tree-icon">
                          <EntityIcon icon={s.collection.icon} color={s.collection.color} size={18} fallback={<span className="collection-dot" />} />
                        </span>
                        <span className="tree-title">{s.collection.name}</span>
                      </div>
                    ) : (
                      <div
                        className={`tree-row${isActive(s.doc.id) ? " active" : ""}`}
                        style={{ "--depth": 0 } as CSSProperties}
                        role="button"
                        tabIndex={0}
                        {...navProps(p, { name: "doc", id: s.doc.id })}
                        onKeyDown={(e) => e.key === "Enter" && p.onNavigate({ name: "doc", id: s.doc.id })}
                        onContextMenu={(e) => s.doc.collectionId && p.onContextMenu({ id: s.doc.id, title: s.doc.title, url: s.doc.url, collectionId: s.doc.collectionId }, e)}
                      >
                        {chevron}
                        <DocIcon icon={s.doc.icon} color={s.doc.color} starred />
                        <span className="tree-title">{s.doc.title || t("untitled")}</span>
                      </div>
                    )}
                    {open && (
                      <div role="group">
                        <DocTree {...p} nodes={children} depth={1} collectionId={collectionId} isActive={isActive} dnd={dnd} foldPrefix={STAR_FOLD} />
                      </div>
                    )}
                  </div>
                );
              })}
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
          <button key={name} className={`sidebar-row${p.route.name === name ? " active" : ""}`} {...navProps(p, { name })}>
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
  const { t } = useSettings();
  const { collection } = p;
  const nodes = p.workspace.trees[collection.id] ?? [];
  const active = p.route.name === "collection" && p.route.id === collection.id;
  const d = p.dnd.drop;
  const collectionDrop =
    d?.kind === "collection" && d.id === collection.id ? " drop-inside" : d?.kind === "collection-order" && d.id === collection.id ? ` drop-${d.zone}` : "";

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
        {...navProps(p, { name: "collection", id: collection.id })}
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
      {!p.folded && (
        <div role="tree">
          <DocTree {...p} nodes={nodes} depth={1} collectionId={collection.id} />
        </div>
      )}
    </div>
  );
}

interface TreeProps extends Props {
  nodes: NavNode[];
  depth: number;
  collectionId: string;
  isActive: (id: string) => boolean;
  dnd: DragState;
  /** Prefixes the remembered open/closed state, so a tree under Starred folds on its own. */
  foldPrefix?: string;
}

/** Documents and, for those that are open, their children. */
function DocTree(p: TreeProps) {
  const { t, settings, update } = useSettings();
  const prefix = p.foldPrefix ?? "";
  const expanded = new Set(settings.expanded);
  const toggle = (id: string) => {
    const key = prefix + id;
    update((s) => ({ expanded: s.expanded.includes(key) ? s.expanded.filter((k) => k !== key) : [...s.expanded, key] }));
  };
  const dropClass = (id: string) => {
    const d = p.dnd.drop;
    return d?.kind === "doc" && d.id === id ? ` drop-${d.zone}` : "";
  };

  return p.nodes.map((node) => {
    const open = expanded.has(prefix + node.id);
    return (
      <div key={node.id} role="treeitem" aria-expanded={node.children.length ? open : undefined}>
        <div
          className={`tree-row${p.isActive(node.id) ? " active" : ""}${dropClass(node.id)}${p.dnd.drag?.id === node.id ? " dragging" : ""}`}
          style={{ "--depth": p.depth } as CSSProperties}
          role="button"
          tabIndex={0}
          draggable
          onDragStart={(e) => p.dnd.start({ kind: "doc", id: node.id }, e)}
          onDragOver={(e) => p.dnd.over({ kind: "doc", id: node.id, zone: zoneOf(e) }, e)}
          onDrop={p.dnd.finish}
          onDragEnd={p.dnd.end}
          {...navProps(p, { name: "doc", id: node.id })}
          onKeyDown={(e) => e.key === "Enter" && p.onNavigate({ name: "doc", id: node.id })}
          onContextMenu={(e) => p.onContextMenu({ id: node.id, title: node.title, url: node.url, collectionId: p.collectionId }, e)}
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
              p.onNewDoc(p.collectionId, node.id);
            }}
          >
            <Plus size={14} />
          </button>
        </div>
        {open && node.children.length > 0 && (
          <div role="group">
            <DocTree {...p} nodes={node.children} depth={p.depth + 1} />
          </div>
        )}
      </div>
    );
  });
}
