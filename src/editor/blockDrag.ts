// Dragging a block by its handle. The block lifts and follows the pointer while the blocks around
// it slide out of the way, so the new order shows as you drag; on release it settles into its
// place. Blocks move among their siblings: top-level blocks among top-level blocks, list items
// within their list. Done with pointer events and CSS transforms; the document only changes on
// release.

import { Selection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Block } from "./editing";
import { schema } from "./schema";

const { nodes } = schema;

/** The block under the pointer: the list item when in a list, else the top-level block. */
export function blockAt(view: EditorView, x: number, y: number): Block | null {
  const box = view.dom.getBoundingClientRect();
  const found = view.posAtCoords({ left: Math.min(Math.max(x, box.left + 2), box.right - 2), top: y });
  if (!found) return null;
  const { doc } = view.state;
  const pos = found.inside >= 0 ? found.inside : found.pos;
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type === nodes.list_item || node.type === nodes.checkbox_item) return { node, pos: $pos.before(d) };
  }
  if ($pos.depth > 0) return { node: $pos.node(1), pos: $pos.before(1) };
  const node = doc.nodeAt(pos);
  if (node?.isBlock) return { node, pos };
  const after = $pos.nodeAfter;
  return after?.isBlock ? { node: after, pos } : null;
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

/** Moves the block to `pos` and returns where it landed. */
function moveTo(view: EditorView, block: Block, pos: number): number | null {
  const { state } = view;
  if (state.doc.nodeAt(block.pos) !== block.node) return null;
  const from = block.pos;
  const to = from + block.node.nodeSize;
  if (pos >= from && pos <= to) return null;
  const tr = state.tr.delete(from, to);
  const at = tr.mapping.map(pos);
  tr.insert(at, block.node);
  const inside = Selection.findFrom(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size)), 1, true);
  if (inside) tr.setSelection(inside);
  view.dispatch(tr);
  view.focus();
  return at;
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
  const scroller = scrollParent(view.dom);
  const scrollTop = () => (scroller === document.scrollingElement ? window.scrollY : scroller.scrollTop);
  const startScroll = scrollTop();
  let dragging = false;
  let last = { x: down.clientX, y: down.clientY };
  let target = index;
  let scrollTimer = 0;

  const measure = () => {
    for (const s of siblings) {
      const r = s.dom.getBoundingClientRect();
      s.top = r.top;
      s.height = r.height;
    }
    siblings.forEach((s, i) => {
      const next = siblings[i + 1];
      const gap = siblings.length > 1 ? Math.max(0, siblings[1].top - siblings[0].top - siblings[0].height) : 0;
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
    document.body.classList.add("block-dragging");
    scrollTimer = window.setInterval(autoScroll, 16);
  };

  /** Lays the siblings out as if the block were at `target`, and moves the block with the pointer. */
  const update = () => {
    const scrolled = scrollTop() - startScroll;
    const dy = last.y - down.clientY + scrolled;
    const center = source.top + source.height / 2 + dy;
    const others = siblings.filter((s) => s !== source);
    target = others.filter((s) => s.top + s.height / 2 < center).length;
    const order = [...others];
    order.splice(target, 0, source);
    let y = siblings[0].top;
    const offsets = new Map<Sibling, number>();
    for (const s of order) {
      offsets.set(s, y - s.top);
      y += s.step;
    }
    quietly(view, () => {
      source.dom.style.transform = `translate3d(0, ${dy}px, 0)`;
      for (const s of others) s.dom.style.transform = offsets.get(s) ? `translate3d(0, ${offsets.get(s)}px, 0)` : "";
    });
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
  const settle = (dom: HTMLElement, fromTop: number) => {
    const offset = fromTop - dom.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) return;
    quietly(view, () => {
      dom.style.transition = "none";
      dom.style.transform = `translate3d(0, ${offset}px, 0)`;
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
    document.body.classList.remove("block-dragging");
    const drawnAt = source.dom.getBoundingClientRect().top;
    const reset = () =>
      quietly(view, () => {
        for (const s of siblings) {
          s.dom.classList.remove("drag-lifted", "drag-shifting");
          s.dom.style.transform = "";
        }
      });
    let landed: number | null = null;
    if (drop && target !== index) {
      const others = siblings.filter((s) => s !== source);
      const pos = target < others.length ? others[target].pos : parentEnd;
      reset();
      landed = moveTo(view, block, pos);
    } else reset();
    // The block glides from under the pointer into its slot.
    const dom = view.nodeDOM(landed ?? block.pos);
    if (dom instanceof HTMLElement) settle(dom, drawnAt);
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
