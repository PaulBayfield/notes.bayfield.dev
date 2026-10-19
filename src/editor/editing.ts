// Editing commands borrowed from Outline: code block indentation, table rows, moving blocks
// and lettered lists.

import type { Node, NodeType } from "prosemirror-model";
import { NodeSelection, Selection, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { selectParentNode, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { findParent, toggleList } from "./commands";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { addRow, isInTable, selectedRect, TableMap } from "prosemirror-tables";
import { schema } from "./schema";

const { nodes, marks } = schema;

// ---------- Code blocks ----------

/** The code block holding the whole selection, if any. */
function codeAround(state: EditorState) {
  const { $from, $to } = state.selection;
  if (!$from.parent.type.spec.code || !$from.sameParent($to) || !$from.parent.isTextblock) return null;
  return $from;
}

/** Four spaces for languages where that's the norm, else two. */
const FOUR_SPACES = new Set(["python", "java", "kotlin", "rust", "php", "csharp", "swift", "scala"]);
const indentOf = (code: Node) => " ".repeat(FOUR_SPACES.has(code.attrs.language) ? 4 : 2);

/** Positions where the lines touched by the selection start, last first. */
function lineStarts(state: EditorState): number[] {
  const { $from, to } = state.selection;
  const start = $from.start();
  const text = $from.parent.textContent;
  const out: number[] = [];
  let line = text.lastIndexOf("\n", $from.parentOffset - 1) + 1;
  while (start + line <= to) {
    out.unshift(start + line);
    const next = text.indexOf("\n", line);
    if (next < 0) break;
    line = next + 1;
  }
  return out;
}

export const indentInCode: Command = (state, dispatch) => {
  const $from = codeAround(state);
  if (!$from) return false;
  const spaces = indentOf($from.parent);
  if (!dispatch) return true;
  const tr = state.tr;
  if (state.selection.empty) tr.insertText(spaces);
  else for (const pos of lineStarts(state)) tr.insertText(spaces, pos);
  dispatch(tr.scrollIntoView());
  return true;
};

export const outdentInCode: Command = (state, dispatch) => {
  const $from = codeAround(state);
  if (!$from) return false;
  const size = indentOf($from.parent).length;
  if (!dispatch) return true;
  const tr = state.tr;
  for (const pos of lineStarts(state)) {
    const leading = state.doc.textBetween(pos, Math.min(pos + size, $from.end())).match(/^ */)![0].length;
    if (leading) tr.delete(pos, pos + leading);
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/** A new line keeping the current line's indentation. */
export const newlineInCode: Command = (state, dispatch) => {
  const $from = codeAround(state);
  if (!$from) return false;
  const text = $from.parent.textContent.slice(0, $from.parentOffset);
  const line = text.slice(text.lastIndexOf("\n") + 1);
  dispatch?.(state.tr.insertText(`\n${line.match(/^\s*/)![0]}`).scrollIntoView());
  return true;
};

/** Enter in code: a new line, or leaves the block from an empty last line. */
export const enterInCode: Command = (state, dispatch) => {
  const $from = codeAround(state);
  if (!$from) return false;
  const { parent } = $from;
  const atEnd = state.selection.empty && $from.parentOffset === parent.content.size;
  if (atEnd && parent.textContent.endsWith("\n")) {
    if (dispatch) {
      const after = $from.after();
      const tr = state.tr.delete($from.pos - 1, $from.pos);
      tr.insert(after - 1, nodes.paragraph.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, after)).scrollIntoView());
    }
    return true;
  }
  return newlineInCode(state, dispatch);
};

/** Ctrl+A in code selects the code only; pressed again, the whole document. */
export const selectAllInCode: Command = (state, dispatch) => {
  const $from = codeAround(state);
  if (!$from) return false;
  const { from, to } = state.selection;
  if (from === $from.start() && to === $from.end()) return false;
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, $from.start(), $from.end())));
  return true;
};

/** Moves to the start or end of the line in code (Ctrl+A / Ctrl+E on a Mac). */
export const lineEdgeInCode =
  (dir: -1 | 1): Command =>
  (state, dispatch) => {
    const $from = codeAround(state);
    if (!$from) return false;
    const text = $from.parent.textContent;
    const offset = dir < 0 ? text.lastIndexOf("\n", $from.parentOffset - 1) + 1 : (text.indexOf("\n", $from.parentOffset) + 1 || text.length + 1) - 1;
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, $from.start() + offset)).scrollIntoView());
    return true;
  };

/**
 * Backspace at the start of a heading or code block turns it into a paragraph. Lines of code
 * become line breaks.
 */
export const backspaceToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const { parent } = $from;
  if (!empty || $from.parentOffset > 0 || parent.type === nodes.paragraph) return false;
  if (parent.type !== nodes.heading && !parent.type.spec.code) return false;
  if (dispatch) dispatch(toParagraph(state).scrollIntoView());
  return true;
};

/** Turns the heading or code block at the cursor into a paragraph, keeping the cursor's place. */
function toParagraph(state: EditorState) {
  const { $from } = state.selection;
  const { parent } = $from;
  if (parent.type === nodes.heading) return state.tr.setBlockType($from.pos, $from.pos, nodes.paragraph);
  const from = $from.before();
  const inline: Node[] = [];
  parent.textContent.split("\n").forEach((line, i) => {
    if (i) inline.push(nodes.br.create());
    if (line) inline.push(schema.text(line));
  });
  // A line break takes one position, like the newline it replaces.
  const tr = state.tr.replaceWith(from, $from.after(), nodes.paragraph.create(null, inline));
  return tr.setSelection(TextSelection.create(tr.doc, $from.pos));
}

/** Ctrl+Shift+C: inline code over a selection, else turns the line into a code block (or back). */
export const toggleCode: Command = (state, dispatch) => {
  const { selection } = state;
  if (!selection.empty && selection.$from.sameParent(selection.$to) && !selection.$from.parent.type.spec.code)
    return toggleMark(marks.code_inline)(state, dispatch);
  return toggleCodeBlock(state, dispatch);
};

/** Ctrl+Shift+\: the line becomes a code block, or the code block becomes text again. */
export const toggleCodeBlock: Command = (state, dispatch) => {
  if (!codeAround(state)) return setBlockType(nodes.code_fence, { language: "none" })(state, dispatch);
  if (dispatch) dispatch(toParagraph(state).scrollIntoView());
  return true;
};

// ---------- Tables ----------

/**
 * Adds a row below the current one and moves into it (Ctrl+Enter, or Tab in the last cell). At
 * the very start of a row it adds the row above instead, as in Outline.
 */
export const addRowAndMove: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (!dispatch) return true;
  const rect = selectedRect(state);
  const { $from, empty } = state.selection;
  const above = empty && rect.left === 0 && $from.parentOffset === 0 && $from.index($from.depth - 1) === 0;
  const index = above ? rect.top : rect.bottom;
  const tr = addRow(state.tr, rect, index);
  // Adding above keeps the cursor in its row, which moves down.
  if (above) {
    dispatch(tr.scrollIntoView());
    return true;
  }
  const table = tr.doc.nodeAt(rect.tableStart - 1)!;
  const cell = rect.tableStart + TableMap.get(table).positionAt(index, 0, table);
  dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(cell + 1))).scrollIntoView());
  return true;
};

/**
 * Arrow up in the first row / down in the last row leaves the table. When there's nothing to
 * type in on that side, a paragraph is added there.
 */
export const moveOutOfTable =
  (dir: -1 | 1): Command =>
  (state, dispatch, view) => {
    if (!isInTable(state) || !state.selection.empty) return false;
    const rect = selectedRect(state);
    if (dir < 0 ? rect.top !== 0 : rect.bottom !== rect.map.height) return false;
    if (view && !view.endOfTextblock(dir < 0 ? "up" : "down")) return false;
    const pos = dir < 0 ? rect.tableStart - 1 : rect.tableStart - 1 + rect.table.nodeSize;
    const $pos = state.doc.resolve(pos);
    const next = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
    if (next?.isTextblock) return false;
    if (dispatch) {
      const tr = state.tr.insert(pos, nodes.paragraph.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView());
    }
    return true;
  };

// ---------- Moving blocks ----------

/**
 * Ctrl+Alt+Up / Down: swaps the block at the cursor with the one before or after it. In a list,
 * that's the list item; on a line of its own, the line.
 */
export const moveBlock =
  (dir: -1 | 1): Command =>
  (state, dispatch) => {
    const { selection } = state;
    if (selection instanceof NodeSelection && selection.node.isBlock) {
      const $pos = state.doc.resolve(selection.from);
      const index = $pos.index() + dir;
      if (index < 0 || index >= $pos.parent.childCount) return false;
      const sibling = $pos.parent.child(index);
      if (!dispatch) return true;
      const from = dir < 0 ? selection.from - sibling.nodeSize : selection.from;
      const to = dir < 0 ? selection.to : selection.to + sibling.nodeSize;
      const tr = state.tr.replaceWith(from, to, dir < 0 ? [selection.node, sibling] : [sibling, selection.node]);
      dispatch(tr.setSelection(NodeSelection.create(tr.doc, dir < 0 ? from : from + sibling.nodeSize)).scrollIntoView());
      return true;
    }
    const { $anchor, $head } = selection;
    for (let d = $head.depth; d > 0; d--) {
      const node = $head.node(d);
      // Rows and cells stay where they are; the table itself can move.
      if (!node.isBlock || ["row", "cell", "header_cell"].includes(node.type.spec.tableRole)) continue;
      const parent = $head.node(d - 1);
      const index = $head.index(d - 1);
      const sibling = dir < 0 ? index > 0 && parent.child(index - 1) : index < parent.childCount - 1 && parent.child(index + 1);
      if (!sibling) continue;
      const before = $head.before(d);
      const after = $head.after(d);
      // The whole selection has to move with the block.
      if ($anchor.pos < before || $anchor.pos > after) return false;
      if (!dispatch) return true;
      const from = dir < 0 ? before - sibling.nodeSize : before;
      const to = dir < 0 ? after : after + sibling.nodeSize;
      const shift = dir < 0 ? -sibling.nodeSize : sibling.nodeSize;
      const tr = state.tr.replaceWith(from, to, dir < 0 ? [node, sibling] : [sibling, node]);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, $anchor.pos + shift, $head.pos + shift)).scrollIntoView());
      return true;
    }
    return false;
  };

// ---------- Blocks, as in Notion ----------

export interface Block {
  node: Node;
  pos: number;
}

/** The block that block actions apply to: a selected block, the list item around the cursor, or the line. */
export function currentBlock(state: EditorState): Block | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) return selection.node.isBlock ? { node: selection.node, pos: selection.from } : null;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;
  let d = $from.depth;
  const parent = $from.node(d - 1);
  if ((parent.type === nodes.list_item || parent.type === nodes.checkbox_item) && $from.index(d - 1) === 0) d--;
  else if (parent.type.spec.tableRole) return null;
  return { node: $from.node(d), pos: $from.before(d) };
}

/** A copy with new ids for toggles and mentions, which must stay unique. */
function withFreshIds(node: Node): Node {
  if (node.isText) return node;
  const content: Node[] = [];
  node.forEach((child) => content.push(withFreshIds(child)));
  const fresh = node.type === nodes.container_toggle || node.type === nodes.mention;
  return node.type.create(fresh ? { ...node.attrs, id: crypto.randomUUID() } : node.attrs, content, node.marks);
}

/** Inserts a copy of the block below it, keeping the cursor at the same place in the copy. */
export function duplicateBlockAt(block: Block): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const after = block.pos + block.node.nodeSize;
    const tr = state.tr.insert(after, withFreshIds(block.node));
    const { selection } = state;
    if (selection instanceof NodeSelection || selection.from < block.pos || selection.to > after) tr.setSelection(NodeSelection.create(tr.doc, after));
    else tr.setSelection(TextSelection.create(tr.doc, selection.anchor + block.node.nodeSize, selection.head + block.node.nodeSize));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const duplicateBlock: Command = (state, dispatch) => {
  const block = currentBlock(state);
  return !!block && duplicateBlockAt(block)(state, dispatch);
};

/** Removes the block; a last item takes its list with it, and an emptied document keeps a line. */
export function deleteBlockAt(block: Block): Command {
  return (state, dispatch) => {
    let $pos = state.doc.resolve(block.pos);
    let from = block.pos;
    let to = block.pos + block.node.nodeSize;
    while ($pos.depth > 0 && $pos.parent.childCount === 1) {
      from = $pos.before();
      to = $pos.after();
      $pos = state.doc.resolve(from);
    }
    if (!dispatch) return true;
    const tr = $pos.depth === 0 && $pos.parent.childCount === 1 ? state.tr.replaceWith(from, to, nodes.paragraph.create()) : state.tr.delete(from, to);
    dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)))).scrollIntoView());
    return true;
  };
}

/** Escape selects the block around the cursor; again, the block around that. */
export const selectBlock: Command = (state, dispatch) => {
  if (state.selection instanceof NodeSelection) return selectParentNode(state, dispatch);
  const block = currentBlock(state);
  if (!block) return selectParentNode(state, dispatch);
  dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, block.pos)));
  return true;
};

/**
 * With a block selected, the arrows select the block above or below; with Shift, the selection
 * grows to take it in.
 */
export const arrowFromBlock =
  (dir: -1 | 1, extend = false): Command =>
  (state, dispatch) => {
    const { selection } = state;
    if (!(selection instanceof NodeSelection) || !selection.node.isBlock) return false;
    const $pos = state.doc.resolve(selection.from);
    const index = $pos.index() + dir;
    if (index < 0 || index >= $pos.parent.childCount) return true;
    const sibling = $pos.parent.child(index);
    const at = dir < 0 ? selection.from - sibling.nodeSize : selection.to;
    if (!dispatch) return true;
    if (!extend) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)).scrollIntoView());
    else {
      const [from, to] = dir < 0 ? [selection.to, at] : [selection.from, at + sibling.nodeSize];
      dispatch(state.tr.setSelection(TextSelection.between(state.doc.resolve(from), state.doc.resolve(to))).scrollIntoView());
    }
    return true;
  };

/** Enter on a selected block goes back to typing, at the end of its text. */
export const editSelectedBlock: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || !selection.node.isBlock || selection.node.isAtom) return false;
  const end = Selection.findFrom(state.doc.resolve(selection.to), -1, true);
  if (!end) return false;
  dispatch?.(state.tr.setSelection(end).scrollIntoView());
  return true;
};

export type TurnInto = "text" | "h1" | "h2" | "h3" | "bullet" | "ordered" | "todo" | "quote" | "code" | "toggle";

/** Changes the block at the cursor into another kind; nothing happens when it's that kind already. */
export const turnInto =
  (kind: TurnInto): Command =>
  (state, dispatch) => {
    const { $from } = state.selection;
    const inList = (type: NodeType) => !!findParent(state, type);
    switch (kind) {
      case "text":
        for (const [list, item] of [
          [nodes.bullet_list, nodes.list_item],
          [nodes.ordered_list, nodes.list_item],
          [nodes.checkbox_list, nodes.checkbox_item],
        ] as const)
          if (inList(list)) return liftListItem(item)(state, dispatch);
        if ($from.parent.type.spec.code) return toggleCodeBlock(state, dispatch);
        return setBlockType(nodes.paragraph)(state, dispatch);
      case "h1":
      case "h2":
      case "h3":
        return setBlockType(nodes.heading, { level: +kind[1] })(state, dispatch);
      case "bullet":
        return inList(nodes.bullet_list) || toggleList(nodes.bullet_list, nodes.list_item)(state, dispatch);
      case "ordered":
        return inList(nodes.ordered_list) || toggleList(nodes.ordered_list, nodes.list_item)(state, dispatch);
      case "todo":
        return inList(nodes.checkbox_list) || toggleList(nodes.checkbox_list, nodes.checkbox_item)(state, dispatch);
      case "quote":
        return inList(nodes.blockquote) || wrapIn(nodes.blockquote)(state, dispatch);
      case "code":
        return $from.parent.type.spec.code ? true : setBlockType(nodes.code_fence, { language: "none" })(state, dispatch);
      case "toggle":
        return inList(nodes.container_toggle) || wrapIn(nodes.container_toggle, { id: crypto.randomUUID() })(state, dispatch);
    }
  };

/** Puts the cursor at the start of the block's text, so commands for "the current line" act on it. */
export function selectionIn(state: EditorState, block: Block): Selection {
  return Selection.findFrom(state.doc.resolve(block.pos + 1), 1, true) ?? NodeSelection.create(state.doc, block.pos);
}

// ---------- Highlight colours ----------

/** Outline's highlight colours. */
export const HIGHLIGHT_COLORS = [
  { hex: "#FDEA9B", name: "Coral" },
  { hex: "#FED46A", name: "Apricot" },
  { hex: "#FA551E", name: "Sunset" },
  { hex: "#B4DC19", name: "Smoothie" },
  { hex: "#C8AFF0", name: "Bubblegum" },
  { hex: "#3CBEFC", name: "Neon" },
];

const LAST_HIGHLIGHT = "notes.lastHighlight";

/** The colour last picked; null is the theme's own highlight. */
export function lastHighlight(): string | null {
  try {
    return localStorage.getItem(LAST_HIGHLIGHT) || null;
  } catch {
    return null;
  }
}

/** Highlights the selection in a colour (null: the theme's), replacing any other highlight. */
export const setHighlight =
  (color: string | null): Command =>
  (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    try {
      localStorage.setItem(LAST_HIGHLIGHT, color ?? "");
    } catch {
      // Not remembered; nothing else changes.
    }
    dispatch?.(state.tr.removeMark(from, to, marks.highlight).addMark(from, to, marks.highlight.create({ color })));
    return true;
  };

export const removeHighlight: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  dispatch?.(state.tr.removeMark(from, to, marks.highlight));
  return true;
};

/** Ctrl+Shift+H: removes the highlight, or highlights in the last colour picked. */
export const toggleHighlight: Command = (state, dispatch) =>
  state.doc.rangeHasMark(state.selection.from, state.selection.to, marks.highlight)
    ? removeHighlight(state, dispatch)
    : state.selection.empty
      ? toggleMark(marks.highlight, { color: lastHighlight() })(state, dispatch)
      : setHighlight(lastHighlight())(state, dispatch);

// ---------- Heading links ----------

/** Outline's anchor for a heading ("h-my-heading", then "-1", "-2" for repeats). */
export function headingAnchor(doc: Node, pos: number): string {
  const slug = (text: string) =>
    "h-" +
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[!"#$%&'.()*+,/:;<=>?@[\]\\^_`{|}~]/g, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");
  const target = slug(doc.nodeAt(pos)!.textContent);
  let index = 0;
  doc.descendants((node, at) => {
    if (at >= pos) return false;
    if (node.type === nodes.heading && slug(node.textContent) === target) index++;
    return !node.isTextblock;
  });
  return index ? `${target}-${index}` : target;
}

// ---------- Lettered lists ----------

function listAround(state: EditorState) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.spec.group?.split(" ").includes("list")) return { node, pos: $from.before(d) };
  }
  return null;
}

/** Ctrl+Shift+5 / 6: a lettered list (A. B. C. / a. b. c.), or back to text. */
export const toggleListStyle =
  (listStyle: string): Command =>
  (state, dispatch) => {
    const list = listAround(state);
    if (list?.node.type === nodes.ordered_list) {
      if (list.node.attrs.listStyle === listStyle) return liftListItem(nodes.list_item)(state, dispatch);
      dispatch?.(state.tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, listStyle }));
      return true;
    }
    if (list?.node.type === nodes.bullet_list) {
      dispatch?.(state.tr.setNodeMarkup(list.pos, nodes.ordered_list, { order: 1, listStyle }));
      return true;
    }
    if (list) return liftListItem(nodes.checkbox_item)(state, dispatch);
    return wrapInList(nodes.ordered_list, { listStyle })(state, dispatch);
  };


/** Ctrl+/ asks the block handle to open its menu for the block at the cursor. */
export const BLOCK_MENU_EVENT = "notes:block-menu";
