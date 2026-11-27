// Formulas (KaTeX), mentions and emoji are drawn in non-editable boxes, which browsers leave out of
// the selection's highlight: selecting across them looked like they weren't selected. This marks the
// ones a text selection covers, so they're tinted like the text around them.

import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

const BOXED = new Set(["math_inline", "math_block", "mention", "emoji"]);

export const selectionBoxesKey = new PluginKey("selectionBoxes");

export function selectionBoxesPlugin() {
  return new Plugin({
    key: selectionBoxesKey,
    props: {
      decorations(state) {
        const { selection } = state;
        if (selection.empty || !(selection instanceof TextSelection)) return null;
        const marks: Decoration[] = [];
        state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
          if (!BOXED.has(node.type.name)) return true;
          // Only when it's wholly inside the selection.
          if (pos >= selection.from && pos + node.nodeSize <= selection.to) marks.push(Decoration.node(pos, pos + node.nodeSize, { class: "in-selection" }));
          return false;
        });
        return marks.length ? DecorationSet.create(state.doc, marks) : null;
      },
    },
  });
}
