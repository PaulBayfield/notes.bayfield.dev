// Notion's block handle: hovering a block shows "+" (add a block below) and a grip. Drag the grip
// to move the block; click it, or press Ctrl+/, for the block menu (turn into, duplicate, move,
// copy link, delete).

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { NodeSelection, TextSelection, type Command, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { StringKey, Translate } from "../lib/i18n";
import { webUrl } from "../lib/api";
import {
  BLOCK_MENU_EVENT,
  currentBlock,
  deleteBlockAt,
  duplicateBlockAt,
  headingAnchor,
  moveBlock,
  selectionIn,
  turnInto,
  type Block,
  type TurnInto,
} from "./editing";
import { blockAt, startBlockDrag } from "./blockDrag";
import { schema } from "./schema";

const { nodes } = schema;

/** Screen position for the handle: left of the block, level with its first line. */
function anchorFor(view: EditorView, block: Block): { left: number; top: number } | null {
  const dom = view.nodeDOM(block.pos);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  let lineTop = rect.top;
  let lineHeight = Math.min(rect.height, 28);
  const first = TextSelection.findFrom(view.state.doc.resolve(block.pos + 1), 1, true);
  if (first && first.from < block.pos + block.node.nodeSize) {
    const coords = view.coordsAtPos(first.from);
    lineTop = coords.top;
    lineHeight = coords.bottom - coords.top;
  }
  const inList = block.node.type === nodes.list_item || block.node.type === nodes.checkbox_item;
  return { left: rect.left - (inList ? 70 : 50), top: lineTop + lineHeight / 2 - 12 };
}

interface MenuItem {
  key: string;
  label: string;
  hint?: string;
  icon: string;
  keywords?: string;
  section?: string;
  run: () => void;
}

const TURN_INTO: { kind: TurnInto; label: StringKey; icon: string; keywords: string }[] = [
  { kind: "text", label: "blockText", icon: "¶", keywords: "text paragraph texte" },
  { kind: "h1", label: "blockH1", icon: "H1", keywords: "heading h1 titre" },
  { kind: "h2", label: "blockH2", icon: "H2", keywords: "heading h2 titre" },
  { kind: "h3", label: "blockH3", icon: "H3", keywords: "heading h3 titre" },
  { kind: "bullet", label: "blockBullet", icon: "•", keywords: "bullet list liste" },
  { kind: "ordered", label: "blockOrdered", icon: "1.", keywords: "numbered ordered list liste" },
  { kind: "todo", label: "blockTodo", icon: "☐", keywords: "todo checkbox task tache" },
  { kind: "quote", label: "blockQuote", icon: "❝", keywords: "quote citation" },
  { kind: "code", label: "blockCode", icon: "</>", keywords: "code" },
  { kind: "toggle", label: "blockToggle", icon: "▸", keywords: "toggle depliable" },
];

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

interface Props {
  view: EditorView;
  state: EditorState;
  t: Translate;
  /** The document's path ("/doc/…"), for copying links to headings. */
  docUrl?: string;
}

export function BlockHandle({ view, state, t, docUrl }: Props) {
  const [hover, setHover] = useState<Block | null>(null);
  const [menu, setMenu] = useState<Block | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const handleRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const editable = view.editable;

  // Follow the pointer over the editor and the gutter to its left.
  useEffect(() => {
    if (!editable) return;
    let frame = 0;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (view.isDestroyed || draggingRef.current) return;
        if (e.target instanceof Node && handleRef.current?.contains(e.target)) return;
        // A dialog or the mobile sidebar is open over the page: nothing underneath can be dragged.
        if (e.target instanceof Element && e.target.closest(".dialog-backdrop, .drawer-backdrop")) return setHover(null);
        const box = view.dom.getBoundingClientRect();
        const near = e.clientX > box.left - 90 && e.clientX < box.right + 24 && e.clientY > box.top - 4 && e.clientY < box.bottom + 4;
        setHover(near ? blockAt(view, e.clientX, e.clientY) : null);
      });
    };
    const onScroll = () => setHover(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [view, editable]);

  // Ctrl+/ opens the menu for the block at the cursor.
  useEffect(() => {
    const open = () => {
      if (!view.hasFocus()) return;
      const block = currentBlock(view.state);
      if (block) openMenu(block);
    };
    window.addEventListener(BLOCK_MENU_EVENT, open);
    return () => window.removeEventListener(BLOCK_MENU_EVENT, open);
  });

  // A block that changed under the handle is looked up again on the next move.
  const hovered = hover && hover.pos + hover.node.nodeSize <= state.doc.content.size && state.doc.nodeAt(hover.pos) === hover.node ? hover : null;
  const anchor = hovered && !menu ? anchorFor(view, hovered) : null;

  const openMenu = (block: Block) => {
    const at = anchorFor(view, block);
    setMenu(block);
    setQuery("");
    setActive(0);
    setMenuPos(at ? { left: Math.max(8, at.left), top: at.top + 28 } : null);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, block.pos)));
  };
  const closeMenu = () => {
    setMenu(null);
    view.focus();
  };

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menuPos) return;
    const r = el.getBoundingClientRect();
    const top = Math.max(8, window.innerHeight - r.height - 8);
    // Only once: setting the same position again would loop.
    if (r.bottom > window.innerHeight - 8 && top < menuPos.top) setMenuPos({ left: menuPos.left, top });
  }, [menu, menuPos]);

  /** Runs a command with the cursor in the block (`inside`) or the block selected. */
  const runOn = (block: Block, cmd: Command, inside: boolean) => () => {
    const s = view.state;
    const live = s.doc.nodeAt(block.pos) === block.node ? block : currentBlock(s);
    if (!live) return closeMenu();
    const sel = inside ? selectionIn(s, live) : NodeSelection.create(s.doc, live.pos);
    view.dispatch(s.tr.setSelection(sel));
    cmd(view.state, view.dispatch, view);
    closeMenu();
  };

  const items: MenuItem[] = [];
  if (menu) {
    const textual = !menu.node.isAtom;
    if (textual)
      TURN_INTO.forEach((b, i) =>
        items.push({
          key: b.kind,
          label: t(b.label),
          icon: b.icon,
          keywords: b.keywords,
          section: i === 0 ? t("turnInto") : undefined,
          run: runOn(menu, turnInto(b.kind), true),
        }),
      );
    items.push(
      { key: "duplicate", label: t("duplicate"), hint: "Ctrl+D", icon: "⧉", section: t("actions"), run: runOn(menu, duplicateBlockAt(menu), false) },
      { key: "up", label: t("moveUp"), hint: "Ctrl+Shift+↑", icon: "↑", run: runOn(menu, moveBlock(-1), false) },
      { key: "down", label: t("moveDown"), hint: "Ctrl+Shift+↓", icon: "↓", run: runOn(menu, moveBlock(1), false) },
    );
    if (menu.node.type === nodes.heading && docUrl)
      items.push({
        key: "link",
        label: t("copyLink"),
        icon: "🔗",
        run: () => {
          void navigator.clipboard.writeText(webUrl(`${docUrl}#${headingAnchor(view.state.doc, menu.pos)}`));
          closeMenu();
        },
      });
    items.push({ key: "delete", label: t("delete"), hint: "Del", icon: "🗑", run: runOn(menu, deleteBlockAt(menu), false) });
  }
  const q = normalize(query.trim());
  const shown = q ? items.filter((i) => normalize(`${i.label} ${i.keywords ?? ""}`).includes(q)).map((i) => ({ ...i, section: undefined })) : items;

  useEffect(() => {
    menuRef.current?.querySelector("button.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Close when clicking elsewhere.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);

  const addBelow = (block: Block) => {
    const s = view.state;
    if (s.doc.nodeAt(block.pos) !== block.node) return;
    const { node, pos } = block;
    // An empty line is used as it is.
    if (node.type === nodes.paragraph && node.content.size === 0) {
      view.dispatch(s.tr.setSelection(TextSelection.create(s.doc, pos + 1)).insertText("/"));
    } else {
      const item = node.type === nodes.checkbox_item ? nodes.checkbox_item.create({ checked: false }, nodes.paragraph.create()) : node.type === nodes.list_item ? nodes.list_item.create(null, nodes.paragraph.create()) : nodes.paragraph.create();
      const after = pos + node.nodeSize;
      const tr = s.tr.insert(after, item);
      const inside = TextSelection.findFrom(tr.doc.resolve(after + 1), 1, true);
      if (inside) tr.setSelection(inside);
      view.dispatch(tr.insertText("/").scrollIntoView());
    }
    view.focus();
  };

  /** A press on the grip: a drag once the pointer moves, else a click that opens the menu. */
  const onGripDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !hovered) return;
    e.preventDefault();
    const block = hovered;
    startBlockDrag(view, block, e.nativeEvent, {
      onClick: () => openMenu(block),
      onStart: () => {
        draggingRef.current = true;
        setHover(null);
      },
      onEnd: () => {
        draggingRef.current = false;
      },
    });
  };

  return (
    <>
      {anchor && hovered && (
        <div ref={handleRef} className="block-handle" style={{ left: anchor.left, top: anchor.top }} onMouseDown={(e) => e.preventDefault()}>
          <button title={t("addBlockBelow")} onClick={() => addBelow(hovered)}>
            +
          </button>
          <button className="grip" title={t("dragOrClick")} onPointerDown={onGripDown}>
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
              {[2, 7, 12].flatMap((y) => [2, 8].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.4" />))}
            </svg>
          </button>
        </div>
      )}
      {menu && (
        <div
          ref={menuRef}
          className="editor-menu suggest-menu block-menu"
          style={menuPos ?? { left: 8, top: 8 }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((i) => (i + 1) % Math.max(1, shown.length));
            else if (e.key === "ArrowUp") setActive((i) => (i - 1 + shown.length) % Math.max(1, shown.length));
            else if (e.key === "Enter") shown[active]?.run();
            else if (e.key === "Escape") closeMenu();
            else return;
            e.preventDefault();
          }}
        >
          <input
            autoFocus
            className="block-menu-search"
            placeholder={t("blockMenuSearch")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          {shown.map((item, i) => (
            <div key={item.key} className="block-menu-row">
              {item.section && <div className="menu-section">{item.section}</div>}
              <button className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={item.run}>
                <span className="menu-icon">{item.icon}</span>
                <span className="menu-text">{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
              </button>
            </div>
          ))}
          {!shown.length && <div className="menu-section">{t("noResults")}</div>}
        </div>
      )}
    </>
  );
}
