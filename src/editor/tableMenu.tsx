// The table part of the formatting toolbar, after Outline's: what it offers depends on what's
// selected (with the grips, see tableGrips.tsx): columns, rows, the whole table, or a few cells.

import type { ReactNode } from "react";
import type { Command, EditorState } from "prosemirror-state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  CellSelection,
  columnIsHeader,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeCells,
  rowIsHeader,
  selectedRect,
  splitCell,
  toggleHeaderColumn,
  toggleHeaderRow,
} from "prosemirror-tables";
import type { StringKey, Translate } from "../lib/i18n";
import { columnAlignment, distributeColumns, isFullWidth, setColumnAlignment, sortByColumn, toggleFullWidth } from "./tables";

const PATHS = {
  alignLeft: "M2 3h12M2 6.5h8M2 10h12M2 13.5h8",
  alignCenter: "M2 3h12M4 6.5h8M2 10h12M4 13.5h8",
  alignRight: "M2 3h12M6 6.5h8M2 10h12M6 13.5h8",
  sortAsc: "M4 2.5v11M1.5 11 4 13.5 6.5 11M9 3.5h3M9 8h4M9 12.5h5",
  sortDesc: "M4 2.5v11M1.5 11 4 13.5 6.5 11M9 3.5h5M9 8h4M9 12.5h3",
  columnBefore: "M8.5 2.5h5v11h-5zM4 5.5v5M1.5 8h5",
  columnAfter: "M2.5 2.5h5v11h-5zM12 5.5v5M9.5 8h5",
  rowBefore: "M2.5 8.5h11v5h-11zM8 1.5v5M5.5 4h5",
  rowAfter: "M2.5 2.5h11v5h-11zM8 9.5v5M5.5 12h5",
  deleteColumn: "M5 2.5h6v11H5zM6.5 6.5l3 3M9.5 6.5l-3 3",
  deleteRow: "M2.5 5h11v6h-11zM6.5 6.5l3 3M9.5 6.5l-3 3",
  merge: "M2.5 2.5v11M13.5 2.5v11M4.5 8h2.5M5.5 6.5 7 8 5.5 9.5M11.5 8H9M10.5 6.5 9 8l1.5 1.5",
  split: "M2.5 2.5h11v11h-11zM8 2.5v11",
  headerRow: "M2.5 2.5h11v11h-11zM2.5 6.5h11",
  headerColumn: "M2.5 2.5h11v11h-11zM6.5 2.5v11",
  fullWidth: "M1.5 8h13M4 5.5 1.5 8 4 10.5M12 5.5l2.5 2.5-2.5 2.5",
  distribute: "M2.5 2.5h11v11h-11zM6.2 2.5v11M9.8 2.5v11",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9",
} as const;

/** The filled part of the header icons. */
const FILLS: Partial<Record<keyof typeof PATHS, string>> = {
  headerRow: "M2.5 2.5h11v4h-11z",
  headerColumn: "M2.5 2.5h4v11h-4z",
};

function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {FILLS[name] && <path d={FILLS[name]} fill="currentColor" stroke="none" opacity="0.35" />}
      <path d={PATHS[name]} />
    </svg>
  );
}

const sep = (key: string) => <span key={key} className="menu-sep" />;

/**
 * Buttons for the table selection, or null when there's nothing table-specific to offer (text
 * selected inside a single cell).
 */
export function tableActions(state: EditorState, run: (cmd: Command) => () => void, t: Translate): ReactNode[] | null {
  const sel = state.selection instanceof CellSelection ? state.selection : null;
  const rect = selectedRect(state);
  const button = (icon: keyof typeof PATHS, title: StringKey, cmd: Command, active = false) => (
    <button key={icon} className={active ? "active" : ""} title={t(title)} disabled={!cmd(state)} onClick={run(cmd)}>
      <Icon name={icon} />
    </button>
  );
  const align = columnAlignment(state);
  const alignment = [
    button("alignLeft", "alignLeft", setColumnAlignment("left"), align === "left"),
    button("alignCenter", "alignCenter", setColumnAlignment("center"), align === "center"),
    button("alignRight", "alignRight", setColumnAlignment("right"), align === "right"),
  ];
  const headerRow = () => button("headerRow", "headerRow", toggleHeaderRow, rowIsHeader(rect.map, rect.table, 0));
  const headerColumn = () => button("headerColumn", "headerColumn", toggleHeaderColumn, columnIsHeader(rect.map, rect.table, 0));

  if (sel?.isColSelection() && sel.isRowSelection())
    return [
      headerRow(),
      headerColumn(),
      sep("s1"),
      button("fullWidth", "tableFullWidth", toggleFullWidth, isFullWidth(state)),
      button("distribute", "distributeColumns", distributeColumns),
      sep("s2"),
      button("trash", "deleteTable", deleteTable),
    ];
  if (sel?.isColSelection())
    return [
      ...alignment,
      sep("s1"),
      button("sortAsc", "sortAscending", sortByColumn(1)),
      button("sortDesc", "sortDescending", sortByColumn(-1)),
      sep("s2"),
      button("columnBefore", "insertColumnBefore", addColumnBefore),
      button("columnAfter", "insertColumnAfter", addColumnAfter),
      ...(rect.left === 0 ? [headerColumn()] : []),
      button("deleteColumn", "deleteColumn", deleteColumn),
    ];
  if (sel?.isRowSelection())
    return [
      button("rowBefore", "insertRowBefore", addRowBefore),
      button("rowAfter", "insertRowAfter", addRowAfter),
      ...(rect.top === 0 ? [headerRow()] : []),
      button("deleteRow", "deleteRow", deleteRow),
    ];
  if (sel) return [...alignment, sep("s1"), button("merge", "mergeCells", mergeCells), button("split", "splitCell", splitCell)];
  // Text inside a cell: only splitting a merged cell is about the table.
  return splitCell(state) ? [button("split", "splitCell", splitCell)] : null;
}
