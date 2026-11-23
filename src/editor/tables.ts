// Table commands beyond prosemirror-tables' own, after Outline's table menus: selecting rows,
// columns and the whole table, column alignment, sorting, moving rows and columns, the
// full-width layout and evenly spread columns.

import type { Node } from "prosemirror-model";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { CellSelection, deleteTable, findTable, isInTable, moveTableColumn, moveTableRow, selectedRect, TableMap, TableView } from "prosemirror-tables";

export interface TableAt {
  node: Node;
  /** Position before the table. */
  pos: number;
  /** Position of its first row. */
  start: number;
  map: TableMap;
}

/** The table around the selection. */
export function tableAround(state: EditorState): TableAt | null {
  const found = findTable(state.selection.$from);
  if (!found) return null;
  return { node: found.node, pos: found.pos, start: found.start, map: TableMap.get(found.node) };
}

/** The table at `pos` (the position before it), if it's still there. */
function tableAtPos(state: EditorState, pos: number): TableAt | null {
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.spec.tableRole !== "table") return null;
  return { node, pos, start: pos + 1, map: TableMap.get(node) };
}

const cellAt = (state: EditorState, table: TableAt, row: number, col: number) =>
  state.doc.resolve(table.start + table.map.map[row * table.map.width + col]);

/** The cell selection the command acts on, when it's in this table. */
function cellSelectionIn(state: EditorState, table: TableAt): CellSelection | null {
  const sel = state.selection;
  return sel instanceof CellSelection && sel.$anchorCell.start(-1) === table.start ? sel : null;
}

/** Selects column `col` of the table at `tablePos`; with `extend`, from the selected column(s) to it. */
export const selectColumn =
  (tablePos: number, col: number, extend = false): Command =>
  (state, dispatch) => {
    const table = tableAtPos(state, tablePos);
    if (!table || col >= table.map.width) return false;
    const $cell = cellAt(state, table, 0, col);
    const sel = cellSelectionIn(state, table);
    const $anchor = extend && sel?.isColSelection() ? sel.$anchorCell : $cell;
    dispatch?.(state.tr.setSelection(CellSelection.colSelection($anchor, $cell)));
    return true;
  };

/** Selects row `row` of the table at `tablePos`; with `extend`, from the selected row(s) to it. */
export const selectRow =
  (tablePos: number, row: number, extend = false): Command =>
  (state, dispatch) => {
    const table = tableAtPos(state, tablePos);
    if (!table || row >= table.map.height) return false;
    const $cell = cellAt(state, table, row, 0);
    const sel = cellSelectionIn(state, table);
    const $anchor = extend && sel?.isRowSelection() ? sel.$anchorCell : $cell;
    dispatch?.(state.tr.setSelection(CellSelection.rowSelection($anchor, $cell)));
    return true;
  };

/** Selects every cell of the table at `tablePos`. */
export const selectTable =
  (tablePos: number): Command =>
  (state, dispatch) => {
    const table = tableAtPos(state, tablePos);
    if (!table) return false;
    const { map } = table;
    const last = map.map[map.map.length - 1];
    dispatch?.(state.tr.setSelection(new CellSelection(state.doc.resolve(table.start + map.map[0]), state.doc.resolve(table.start + last))));
    return true;
  };

export type Alignment = "left" | "center" | "right";

/** The alignment of the column the selection starts in (left when none is set). */
export function columnAlignment(state: EditorState): Alignment {
  if (!isInTable(state)) return "left";
  const rect = selectedRect(state);
  const cell = rect.table.nodeAt(rect.map.map[rect.left]);
  return (cell?.attrs.alignment as Alignment | null) ?? "left";
}

/** Aligns the text of the selected columns, every row of them, as Outline does. */
export const setColumnAlignment =
  (alignment: Alignment): Command =>
  (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return true;
    const rect = selectedRect(state);
    const cells = rect.map.cellsInRect({ left: rect.left, right: rect.right, top: 0, bottom: rect.map.height });
    const tr = state.tr;
    // Left is the default: stored as none, like a table typed in Markdown.
    const value = alignment === "left" ? null : alignment;
    for (const pos of cells) {
      const cell = rect.table.nodeAt(pos)!;
      if (cell.attrs.alignment !== value) tr.setNodeMarkup(rect.tableStart + pos, undefined, { ...cell.attrs, alignment: value });
    }
    dispatch(tr);
    return true;
  };

/** True when a cell spans several rows or columns (rows can't be reordered then). */
function hasMergedCells(table: Node): boolean {
  let merged = false;
  table.forEach((row) => row.forEach((cell) => void (merged ||= cell.attrs.colspan > 1 || cell.attrs.rowspan > 1)));
  return merged;
}

/** A first row of header cells stays on top when sorting. */
const headerRows = (table: Node) => {
  const first = table.firstChild;
  let header = !!first && first.childCount > 0;
  first?.forEach((cell) => void (header &&= cell.type.spec.tableRole === "header_cell"));
  return header ? 1 : 0;
};

/**
 * Sorts the rows by the selected column (numbers by value, text alphabetically, empty cells
 * last). The header row stays where it is. Not possible with merged cells.
 */
export const sortByColumn =
  (direction: 1 | -1): Command =>
  (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const { table, tableStart, map } = rect;
    if (hasMergedCells(table)) return false;
    if (!dispatch) return true;
    const rows: Node[] = [];
    table.forEach((row) => rows.push(row));
    const header = headerRows(table);
    const body = rows.slice(header);
    const col = rect.left;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const key = (row: Node) => (col < row.childCount ? row.child(col).textContent.trim() : "");
    const sorted = [...body].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (!x || !y) return x ? -1 : y ? 1 : 0;
      return direction * collator.compare(x, y);
    });
    const tr = state.tr.replaceWith(tableStart, tableStart + table.content.size, [...rows.slice(0, header), ...sorted]);
    // The column stays selected, to sort again the other way.
    const $cell = tr.doc.resolve(tableStart + map.map[col]);
    dispatch(tr.setSelection(CellSelection.colSelection($cell)));
    return true;
  };

/**
 * Moves the selected rows up or down past the next one (Ctrl+Alt+↑/↓ with rows selected), or
 * the selected columns left or right.
 */
export const moveSelectedLines =
  (axis: "row" | "column", dir: -1 | 1): Command =>
  (state, dispatch) => {
    const sel = state.selection;
    if (!(sel instanceof CellSelection) || !(axis === "row" ? sel.isRowSelection() : sel.isColSelection())) return false;
    const rect = selectedRect(state);
    const [first, end, size] = axis === "row" ? [rect.top, rect.bottom, rect.map.height] : [rect.left, rect.right, rect.map.width];
    // The whole table is selected along that axis: nothing to move past.
    if (first === 0 && end === size) return false;
    if (dir < 0 ? first === 0 : end === size) return false;
    // The line next to the selection goes to its other side.
    const from = dir < 0 ? first - 1 : end;
    const to = dir < 0 ? end - 1 : first;
    const out: { tr?: Transaction } = {};
    const move = axis === "row" ? moveTableRow({ from, to, select: false, pos: rect.tableStart }) : moveTableColumn({ from, to, select: false, pos: rect.tableStart });
    if (!move(state, (moved) => (out.tr = moved))) return false;
    if (!dispatch || !out.tr) return true;
    const { tr } = out;
    const table = tr.doc.nodeAt(rect.tableStart - 1)!;
    const map = TableMap.get(table);
    const at = (row: number, col: number) => tr.doc.resolve(rect.tableStart + map.map[row * map.width + col]);
    const sel2 = axis === "row" ? CellSelection.rowSelection(at(first + dir, 0), at(end - 1 + dir, 0)) : CellSelection.colSelection(at(0, first + dir), at(0, end - 1 + dir));
    dispatch(tr.setSelection(sel2).scrollIntoView());
    return true;
  };

/** Moves row or column `from` of the table at `tablePos` to `to`, and selects it there. */
export const moveLine =
  (tablePos: number, axis: "row" | "column", from: number, to: number): Command =>
  (state, dispatch) => {
    if (from === to || !tableAtPos(state, tablePos)) return false;
    const options = { from, to, select: true, pos: tablePos + 1 };
    return (axis === "row" ? moveTableRow(options) : moveTableColumn(options))(state, dispatch);
  };

export const isFullWidth = (state: EditorState) => tableAround(state)?.node.attrs.layout === "full-width";

/** Lets the table use the page's whole width, or brings it back to the text's width. */
export const toggleFullWidth: Command = (state, dispatch) => {
  const table = tableAround(state);
  if (!table) return false;
  dispatch?.(state.tr.setNodeMarkup(table.pos, undefined, { ...table.node.attrs, layout: table.node.attrs.layout === "full-width" ? null : "full-width" }));
  return true;
};

/** Forgets the widths columns were dragged to, so they share the width evenly. */
export const distributeColumns: Command = (state, dispatch) => {
  const table = tableAround(state);
  if (!table) return false;
  const cells: { pos: number; node: Node }[] = [];
  table.node.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") {
      if (node.attrs.colwidth) cells.push({ pos: table.start + pos, node });
      return false;
    }
    return true;
  });
  if (!cells.length) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const { pos, node } of cells) tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: null });
    dispatch(tr);
  }
  return true;
};

/** Backspace or Delete with the whole table selected removes it, rather than only emptying it. */
export const deleteSelectedTable: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof CellSelection) || !sel.isRowSelection() || !sel.isColSelection()) return false;
  return deleteTable(state, dispatch);
};

/** prosemirror-tables' view (column widths), with Outline's full-width layout as a class. */
export class NotesTableView extends TableView {
  constructor(node: Node, cellMinWidth: number) {
    super(node, cellMinWidth);
    this.applyLayout(node);
  }

  update(node: Node): boolean {
    if (!super.update(node)) return false;
    this.applyLayout(node);
    return true;
  }

  private applyLayout(node: Node) {
    this.dom.classList.toggle("table-full-width", node.attrs.layout === "full-width");
  }
}
