import { Fragment, type MarkType, type Node, type NodeType } from "prosemirror-model";
import { NodeSelection, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { setBlockType, toggleMark, wrapIn, lift } from "prosemirror-commands";
import { wrapInList, liftListItem } from "prosemirror-schema-list";
import { schema } from "./schema";

const { nodes, marks } = schema;

export function isMarkActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** The innermost ancestor of the selection with this type. */
export function findParent(state: EditorState, type: NodeType): { node: Node; pos: number; depth: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === type) return { node, pos: $from.before(d), depth: d };
  }
  return null;
}

export function isBlockActive(state: EditorState, type: NodeType, attrs?: Record<string, unknown>): boolean {
  const { $from } = state.selection;
  const parent = $from.parent;
  if (parent.type !== type) return false;
  return !attrs || Object.entries(attrs).every(([k, v]) => parent.attrs[k] === v);
}

export const toggleHeading =
  (level: number): Command =>
  (state, dispatch) =>
    isBlockActive(state, nodes.heading, { level })
      ? setBlockType(nodes.paragraph)(state, dispatch)
      : setBlockType(nodes.heading, { level })(state, dispatch);

/** Turns the current list into another kind, or wraps/unwraps. */
export const toggleList =
  (listType: NodeType, itemType: NodeType): Command =>
  (state, dispatch) => {
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to);
    if (!range) return false;
    const parentList = findListAround(state);
    if (parentList && parentList.node.type === listType) return liftListItem(itemType)(state, dispatch);
    if (parentList && parentList.node.type !== listType) {
      // Switching between bullet / ordered is a type change; checklists need their own items.
      const sameItems = itemType === listItemTypeOf(parentList.node.type);
      if (sameItems) {
        if (dispatch) dispatch(state.tr.setNodeMarkup(parentList.pos, listType));
        return true;
      }
      const lifted = liftListItem(listItemTypeOf(parentList.node.type))(state, dispatch && ((tr) => dispatch(tr)));
      return lifted;
    }
    return wrapInList(listType)(state, dispatch);
  };

const listItemTypeOf = (listType: NodeType) => (listType === nodes.checkbox_list ? nodes.checkbox_item : nodes.list_item);

function findListAround(state: EditorState) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === nodes.bullet_list || node.type === nodes.ordered_list || node.type === nodes.checkbox_list)
      return { node, pos: $from.before(d) };
  }
  return null;
}

export const toggleWrap =
  (type: NodeType, attrs?: Record<string, unknown>): Command =>
  (state, dispatch) =>
    findParent(state, type) ? lift(state, dispatch) : wrapIn(type, attrs)(state, dispatch);

export const toggleMarkCmd = (type: MarkType, attrs?: Record<string, unknown>) => toggleMark(type, attrs);

/** Replaces the current (empty) paragraph with a block node, or inserts it after the current block. */
export function insertBlock(node: Node, selectInside = true): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const parent = $from.parent;
    let tr = state.tr;
    let pos: number;
    if (parent.type === nodes.paragraph && parent.content.size === 0 && $from.depth > 0) {
      pos = $from.before();
      tr = tr.replaceWith(pos, $from.after(), node);
    } else {
      pos = $from.depth > 0 ? $from.after() : state.selection.to;
      tr = tr.insert(pos, node);
    }
    if (!dispatch) return true;
    const after = pos + node.nodeSize;
    if (selectInside && node.isTextblock) tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    else if (selectInside && !node.isAtom) {
      // Put the cursor in the first textblock inside the new node.
      let target = -1;
      tr.doc.nodesBetween(pos, after, (n, p) => {
        if (target < 0 && n.isTextblock) target = p + 1;
        return target < 0;
      });
      if (target > 0) tr = tr.setSelection(TextSelection.create(tr.doc, target));
    } else {
      // Atoms (rules, embeds): continue in a paragraph after them.
      const next = tr.doc.resolve(Math.min(after, tr.doc.content.size));
      if (!next.nodeAfter || !next.nodeAfter.isTextblock) tr = tr.insert(after, nodes.paragraph.create());
      tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const paragraph = (text?: string) => nodes.paragraph.create(null, text ? schema.text(text) : undefined);

export function createTable(rows = 3, cols = 3): Node {
  const cell = (header: boolean) => (header ? nodes.th : nodes.td).create(null, paragraph());
  const row = (header: boolean) => nodes.tr.create(null, Fragment.from(Array.from({ length: cols }, () => cell(header))));
  return nodes.table.create(null, Fragment.from(Array.from({ length: rows }, (_, i) => row(i === 0))));
}

export const blocks = {
  codeFence: (language = "none") => nodes.code_fence.create({ language }),
  notice: (style: string) => nodes.container_notice.create({ style }, paragraph()),
  toggle: () => nodes.container_toggle.create({ id: crypto.randomUUID() }, [paragraph(), paragraph()]),
  hr: (markup = "---") => nodes.hr.create({ markup }),
  mathBlock: () => nodes.math_block.create(),
  table: () => createTable(3, 3),
  quote: () => nodes.blockquote.create(null, paragraph()),
};

/** Leaves a code block / notice / quote when pressing Mod-Enter, adding a paragraph after it. */
export const exitBlock: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === nodes.code_fence || node.type === nodes.code_block || node.type === nodes.container_notice || node.type === nodes.blockquote) {
      if (dispatch) {
        const after = $from.after(d);
        const tr = state.tr.insert(after, nodes.paragraph.create());
        dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
      }
      return true;
    }
  }
  return false;
};

/** Toggles a checklist item's checkbox at the cursor (Mod-Enter in a checklist). */
export const toggleCheckbox: Command = (state, dispatch) => {
  const item = findParent(state, nodes.checkbox_item);
  if (!item) return false;
  if (dispatch) dispatch(state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: !item.node.attrs.checked }));
  return true;
};

export function selectedNode(state: EditorState): Node | null {
  return state.selection instanceof NodeSelection ? state.selection.node : null;
}

export { marks, nodes };
