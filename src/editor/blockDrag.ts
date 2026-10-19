// Dragging a block by its handle, as in Notion. The block lifts and follows the pointer. Among
// the blocks at its own level, the others slide out of the way as it passes, so the new order
// shows while dragging. Moved right over a list or a toggle it goes inside, moved left it comes
// out; a line then shows where it will land. On release it settles into place. Done with pointer
// events and CSS transforms; the document only changes on release.

import type { Node, NodeType } from "prosemirror-model";
import { Selection, type Transaction } from "prosemirror-state";
import { canJoin } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import type { Block } from "./editing";
import { schema } from "./schema";

const { nodes } = schema;

const isItem = (type: NodeType) => type === nodes.list_item || type === nodes.checkbox_item;
const isList = (type: NodeType) => type === nodes.bullet_list || type === nodes.ordered_list || type === nodes.checkbox_list;

/**
 * Blocks that can be dragged on their own, innermost first: list items, the lines inside a
 * toggle (but not its title, which stands for the toggle), and top-level blocks.
 */
function unitsAt(view: EditorView, x: number, y: number): Block[] {
  const box = view.dom.getBoundingClientRect();
  const found = view.posAtCoords({ left: Math.min(Math.max(x, box.left + 2), box.right - 2), top: y });
  if (!found) return [];
  const { doc } = view.state;
  const pos = found.inside >= 0 ? found.inside : found.pos;
  const $pos = doc.resolve(pos);
  const units: Block[] = [];
  const add = (node: Node, at: number, parent: Node, index: number) => {
    if (isItem(node.type)) units.push({ node, pos: at });
    else if (parent.type === nodes.doc) units.push({ node, pos: at });
    else if (parent.type === nodes.container_toggle && index > 0) units.push({ node, pos: at });
  };
  // The node right at the pointer (an image, a rule…) when it isn't inside a textblock.
  const atNode = doc.nodeAt(pos);
  if (atNode?.isBlock && found.inside === pos) add(atNode, pos, $pos.parent, $pos.index());
  for (let d = $pos.depth; d > 0; d--) add($pos.node(d), $pos.before(d), $pos.node(d - 1), $pos.index(d - 1));
  if (!units.length && $pos.nodeAfter?.isBlock) units.push({ node: $pos.nodeAfter, pos });
  return units;
}

/** The block under the pointer that the handle is for: the innermost one that can be dragged. */
export function blockAt(view: EditorView, x: number, y: number): Block | null {
  return unitsAt(view, x, y)[0] ?? null;
}

/** The element that scrolls the document. */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/**
 * Changes the editor's DOM for looks only. ProseMirror reads changes to its DOM as edits, so its
 * observer is paused meanwhile, as it does for its own updates.
 */
function quietly(view: EditorView, change: () => void) {
  const observer = (view as unknown as { domObserver?: { stop(): void; start(): void } }).domObserver;
  observer?.stop();
  try {
    change();
  } finally {
    observer?.start();
  }
}

/**
 * The block as it should be inserted under `parent`: a list item becomes the right kind of item
 * in another list, or its own one-item list outside of lists; anything else becomes an item when
 * dropped into a list.
 */
function fitFor(node: Node, parent: Node, fromList: Node | null): Node {
  if (isList(parent.type)) {
    const itemType = parent.type === nodes.checkbox_list ? nodes.checkbox_item : nodes.list_item;
    if (node.type === itemType) return node;
    const attrs = itemType === nodes.checkbox_item ? { checked: !!node.attrs.checked } : null;
    return itemType.create(attrs, isItem(node.type) ? node.content : node);
  }
  if (isItem(node.type)) {
    const listType = fromList?.type ?? (node.type === nodes.checkbox_item ? nodes.checkbox_list : nodes.bullet_list);
    const attrs = listType === nodes.ordered_list ? { ...fromList?.attrs, order: 1 } : null;
    return listType.create(attrs, node);
  }
  return node;
}

/** Joins the lists on either side of `pos` when they're the same kind. */
function joinLists(tr: Transaction, pos: number) {
  const $pos = tr.doc.resolve(pos);
  const { nodeBefore, nodeAfter } = $pos;
  if (nodeBefore && nodeAfter && isList(nodeBefore.type) && nodeBefore.type === nodeAfter.type && canJoin(tr.doc, pos)) tr.join(pos);
}

/** Moves the block to `pos` and returns where it landed, or null when nothing moved. */
function moveTo(view: EditorView, block: Block, pos: number): number | null {
  const { state } = view;
  if (state.doc.nodeAt(block.pos) !== block.node) return null;
  // A list's only item takes the (then empty) list with it.
  let from = block.pos;
  let to = from + block.node.nodeSize;
  let $from = state.doc.resolve(from);
  const fromList = isItem(block.node.type) ? $from.parent : null;
  while ($from.depth > 0 && $from.parent.childCount === 1 && isList($from.parent.type)) {
    from = $from.before();
    to = $from.after();
    $from = state.doc.resolve(from);
  }
  if (pos >= from && pos <= to) return null;
  try {
    const tr = state.tr.delete(from, to);
    // Lists the block was between become one.
    joinLists(tr, from);
    const at = tr.mapping.map(pos);
    const node = fitFor(block.node, tr.doc.resolve(at).parent, fromList);
    tr.insert(at, node);
    // A list item moved out next to a list of its kind joins it.
    joinLists(tr, at + node.nodeSize);
    let landed = at;
    const before = tr.doc.resolve(at).nodeBefore;
    if (before && isList(before.type) && before.type === node.type && canJoin(tr.doc, at)) {
      tr.join(at);
      landed = at - 1;
    }
    tr.doc.check();
    const inside = Selection.findFrom(tr.doc.resolve(Math.min(landed + 1, tr.doc.content.size)), 1, true);
    if (inside) tr.setSelection(inside);
    view.dispatch(tr);
    view.focus();
    return landed;
  } catch {
    // That spot can't hold this block (the title of a toggle, say): leave it where it was.
    return null;
  }
}

interface Sibling {
  pos: number;
  dom: HTMLElement;
  top: number;
  height: number;
  /** From this block's top to the next one's, margins included. */
  step: number;
}

interface DragOptions {
  /** Released without moving: a click on the handle. */
  onClick: () => void;
  onStart: () => void;
  onEnd: () => void;
}

const SETTLE_MS = 180;

/** Follows the pointer from a press on the handle until it's released. */
export function startBlockDrag(view: EditorView, block: Block, down: PointerEvent, opts: DragOptions) {
  const $pos = view.state.doc.resolve(block.pos);
  const parent = $pos.parent;
  const parentStart = $pos.start();
  const parentEnd = $pos.end();
  const siblings: Sibling[] = [];
  parent.forEach((_child, offset) => {
    const dom = view.nodeDOM(parentStart + offset);
    if (dom instanceof HTMLElement) siblings.push({ pos: parentStart + offset, dom, top: 0, height: 0, step: 0 });
  });
  const index = siblings.findIndex((s) => s.pos === block.pos);
  // Something without its own element (rare): nothing to drag, so it's a click.
  if (index < 0 || siblings.length !== parent.childCount) {
    const onUp = () => {
      window.removeEventListener("pointerup", onUp);
      opts.onClick();
    };
    window.addEventListener("pointerup", onUp);
    return;
  }
  const source = siblings[index];
  const sourceLeft = source.dom.getBoundingClientRect().left;
  const scroller = scrollParent(view.dom);
  const scrollTop = () => (scroller === document.scrollingElement ? window.scrollY : scroller.scrollTop);
  const startScroll = scrollTop();
  let dragging = false;
  let last = { x: down.clientX, y: down.clientY };
  /** Among its siblings: the index it would take. */
  let target = index;
  /** Elsewhere (into or out of a list or toggle): the position it would go to. */
  let elsewhere: number | null = null;
  let line: HTMLElement | null = null;
  let scrollTimer = 0;

  const measure = () => {
    for (const s of siblings) {
      const r = s.dom.getBoundingClientRect();
      s.top = r.top;
      s.height = r.height;
    }
    const gap = siblings.length > 1 ? Math.max(0, siblings[1].top - siblings[0].top - siblings[0].height) : 0;
    siblings.forEach((s, i) => {
      const next = siblings[i + 1];
      s.step = next ? next.top - s.top : s.height + gap;
    });
  };

  const begin = () => {
    dragging = true;
    measure();
    opts.onStart();
    quietly(view, () => {
      source.dom.classList.add("drag-lifted");
      for (const s of siblings) if (s !== source) s.dom.classList.add("drag-shifting");
    });
    line = document.createElement("div");
    line.className = "block-drop-line";
    document.body.append(line);
    document.body.classList.add("block-dragging");
    scrollTimer = window.setInterval(autoScroll, 16);
  };

  /**
   * Where the block would land elsewhere: the innermost block under the pointer whose left edge
   * the dragged block has reached (so moving right goes into lists and toggles), unless that's at
   * its own level, which the siblings handle.
   */
  const findElsewhere = (blockLeft: number): { pos: number; rect: DOMRect; before: boolean } | null => {
    // Looked up just inside the dragged block's left edge, wherever the pointer holds it.
    const units = unitsAt(view, blockLeft + 20, last.y);
    for (const unit of units) {
      // The dragged block or something inside it.
      if (unit.pos >= block.pos && unit.pos < block.pos + block.node.nodeSize) return null;
      const dom = view.nodeDOM(unit.pos);
      if (!(dom instanceof HTMLElement)) continue;
      const rect = dom.getBoundingClientRect();
      if (rect.left > blockLeft + 16) continue;
      if (view.state.doc.resolve(unit.pos).parent === parent) return null;
      const before = last.y < rect.top + rect.height / 2;
      return { pos: before ? unit.pos : unit.pos + unit.node.nodeSize, rect, before };
    }
    return null;
  };

  /** Moves the block with the pointer, and shows where it would land. */
  const update = () => {
    const scrolled = scrollTop() - startScroll;
    const dx = last.x - down.clientX;
    const dy = last.y - down.clientY + scrolled;
    const spot = findElsewhere(sourceLeft + dx);
    elsewhere = spot?.pos ?? null;
    const others = siblings.filter((s) => s !== source);
    const offsets = new Map<Sibling, number>();
    if (!spot) {
      // Among its siblings: the others make room where it would go.
      const center = source.top + source.height / 2 + dy;
      target = others.filter((s) => s.top + s.height / 2 < center).length;
      const order = [...others];
      order.splice(target, 0, source);
      let y = siblings[0].top;
      for (const s of order) {
        offsets.set(s, y - s.top);
        y += s.step;
      }
    } else target = index;
    quietly(view, () => {
      source.dom.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      for (const s of others) s.dom.style.transform = offsets.get(s) ? `translate3d(0, ${offsets.get(s)}px, 0)` : "";
    });
    if (line) {
      line.style.opacity = spot ? "1" : "0";
      if (spot) {
        const box = view.dom.getBoundingClientRect();
        line.style.transform = `translate(${spot.rect.left}px, ${spot.before ? spot.rect.top - 2 : spot.rect.bottom + 1}px)`;
        line.style.width = `${box.right - spot.rect.left}px`;
      }
    }
  };

  // Near the top or bottom of the window, scroll; faster closer to the edge.
  const autoScroll = () => {
    const edge = 60;
    const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
    const top = Math.max(0, box.top);
    const bottom = Math.min(window.innerHeight, box.bottom);
    let speed = 0;
    if (last.y < top + edge) speed = -Math.ceil((top + edge - last.y) / 4);
    else if (last.y > bottom - edge) speed = Math.ceil((last.y - (bottom - edge)) / 4);
    if (!speed) return;
    scroller.scrollBy(0, speed);
    update();
  };

  const onMove = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY };
    if (!dragging && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 4) begin();
    if (dragging) {
      e.preventDefault();
      update();
    }
  };

  /** Slides an element from where it was drawn to where it now is. */
  const settle = (dom: HTMLElement, from: DOMRect) => {
    const now = dom.getBoundingClientRect();
    const dx = from.left - now.left;
    const dy = from.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    quietly(view, () => {
      dom.style.transition = "none";
      dom.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    });
    void dom.offsetHeight;
    quietly(view, () => {
      dom.style.transition = `transform ${SETTLE_MS}ms ease-out`;
      dom.style.transform = "";
    });
    setTimeout(() => quietly(view, () => (dom.style.transition = "")), SETTLE_MS + 20);
  };

  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey, true);
    clearInterval(scrollTimer);
    line?.remove();
    document.body.classList.remove("block-dragging");
    const drawn = source.dom.getBoundingClientRect();
    quietly(view, () => {
      for (const s of siblings) {
        s.dom.classList.remove("drag-lifted", "drag-shifting");
        s.dom.style.transform = "";
      }
    });
    let landed: number | null = null;
    if (drop && elsewhere !== null) landed = moveTo(view, block, elsewhere);
    else if (drop && target !== index) {
      const others = siblings.filter((s) => s !== source);
      landed = moveTo(view, block, target < others.length ? others[target].pos : parentEnd);
    }
    // The block glides from under the pointer into its place.
    const dom = view.nodeDOM(landed ?? block.pos);
    if (dom instanceof HTMLElement) settle(dom, drawn);
    opts.onEnd();
  };

  const onUp = () => {
    if (dragging) finish(true);
    else {
      finish(false);
      opts.onClick();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !dragging) return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey, true);
}
