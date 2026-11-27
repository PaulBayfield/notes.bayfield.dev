// Images are inline nodes (as in Outline's schema), but a full-size one shows as a block of its own.
// The cursor could still sit right before or after it inside its paragraph: a line in between, as tall
// as the image, without a block handle, where typed text joined the image's paragraph. This keeps such
// images alone in their paragraph:
//  - clicking under (or over) one puts the cursor in the paragraph after (or before) it, made if needed;
//  - text typed next to one goes into its own paragraph.

import { Plugin, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { ySyncPluginKey } from "y-prosemirror";

/** A full-size image (small ones stay inline in text). */
export function isBlockImage(node: Node | null | undefined): boolean {
  if (!node || node.type.name !== "image") return false;
  const width = Number(node.attrs.width) || 0;
  return node.attrs.layoutClass !== "inline" && !(width > 0 && width <= 40);
}

const imageOnly = (p: Node) => p.type.name === "paragraph" && p.childCount === 1 && isBlockImage(p.firstChild);

/** Splits the paragraph around the cursor so its full-size images stand alone. */
function separate(state: EditorState): Transaction | null {
  const { $head } = state.selection;
  let depth = $head.depth;
  while (depth > 0 && $head.node(depth).type.name !== "paragraph") depth--;
  if (depth === 0) return null;
  const para = $head.node(depth);
  if (para.childCount < 2) return null;
  const start = $head.start(depth);
  // Where to cut, and which side the cursor stays on when it's right at the cut (the text's).
  const cuts = new Map<number, -1 | 1>();
  para.forEach((child, offset, index) => {
    if (!isBlockImage(child)) return;
    if (index > 0) cuts.set(start + offset, -1);
    if (index < para.childCount - 1) cuts.set(start + offset + child.nodeSize, 1);
  });
  if (!cuts.size) return null;
  const head = state.selection.head;
  const tr = state.tr;
  for (const pos of [...cuts.keys()].sort((a, b) => b - a)) tr.split(pos);
  if (!tr.docChanged) return null;
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(head, cuts.get(head) ?? 1)));
  return tr;
}

export function imageBlocksPlugin() {
  return new Plugin({
    appendTransaction(trs, _old, state) {
      // Only what was typed here: collaborators' changes arrive already shaped.
      if (!trs.some((tr) => tr.docChanged && !tr.getMeta(ySyncPluginKey))) return null;
      return separate(state);
    },
    props: {
      handleClick(view, pos, event) {
        const $pos = view.state.doc.resolve(pos);
        const para = $pos.parent;
        if (!imageOnly(para)) return false;
        const imagePos = $pos.start();
        const dom = view.nodeDOM(imagePos);
        if (!(dom instanceof HTMLElement)) return false;
        const rect = dom.getBoundingClientRect();
        const after = event.clientY > rect.bottom - 2;
        const before = event.clientY < rect.top + 2;
        if (!after && !before) return false;
        const { state } = view;
        const depth = $pos.depth;
        const index = $pos.index(depth - 1);
        const parent = $pos.node(depth - 1);
        const neighbour = parent.maybeChild(after ? index + 1 : index - 1);
        const tr = state.tr;
        let target: number;
        if (neighbour && neighbour.type.name === "paragraph" && !imageOnly(neighbour)) {
          // The text block next to it: its start (after) or its end (before).
          target = after ? $pos.after(depth) + 1 : $pos.before(depth) - 1;
        } else {
          const at = after ? $pos.after(depth) : $pos.before(depth);
          tr.insert(at, state.schema.nodes.paragraph.create());
          target = at + 1;
        }
        tr.setSelection(TextSelection.create(tr.doc, target)).scrollIntoView();
        view.dispatch(tr);
        view.focus();
        return true;
      },
    },
  });
}
