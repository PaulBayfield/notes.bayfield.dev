// Grips around the table the cursor is in, as in Outline: a bar above each column and left of
// each row, and a corner for the whole table. Click one to select that column, row or table
// (Shift+click to select several); the formatting toolbar then shows what can be done with it.
// Drag a bar to move its column or row. "+" at the end of a bar inserts one after it.

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { TextSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { addColumnAfter, addRowAfter, CellSelection, TableMap } from "prosemirror-tables";
import type { Translate } from "../lib/i18n";
import { moveLine, selectColumn, selectRow, selectTable, tableAround } from "./tables";

interface Props {
  view: EditorView;
  state: EditorState;
  t: Translate;
}

type Axis = "row" | "column";

interface Line {
  /** Left (columns) or top (rows), on screen. */
  start: number;
  size: number;
}

interface Drag {
  axis: Axis;
  from: number;
  to: number;
}

/** Thickness of a grip bar, and its distance from the table. */
const BAR = 10;
const GAP = 4;

export function TableGrips({ view, state, t }: Props) {
  const [, redraw] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const table = view.editable ? tableAround(state) : null;
  const active = !!table && (view.hasFocus() || drag !== null);

  // Follow scrolling (of the page or of a wide table), resizing, and focus coming and going.
  useEffect(() => {
    if (!table) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => redraw((n) => n + 1));
    };
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    view.dom.addEventListener("focus", update);
    view.dom.addEventListener("blur", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      view.dom.removeEventListener("focus", update);
      view.dom.removeEventListener("blur", update);
    };
  }, [view, !!table]);

  if (!active || !table) return null;
  const wrapper = view.nodeDOM(table.pos);
  const tableEl = wrapper instanceof HTMLElement ? wrapper.querySelector("table") : null;
  if (!(wrapper instanceof HTMLElement) || !tableEl) return null;

  const { map } = table;
  const box = tableEl.getBoundingClientRect();
  const clip = wrapper.getBoundingClientRect();
  const scroller = view.dom.closest(".doc-scroll")?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };

  // Columns: measured on the first row, a merged cell split evenly between its columns.
  const columns: Line[] = [];
  for (let col = 0; col < map.width; col++) {
    const pos = map.map[col];
    const dom = view.nodeDOM(table.start + pos);
    if (!(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect();
    const span = map.findCell(pos);
    const width = rect.width / (span.right - span.left);
    columns.push({ start: rect.left + (col - span.left) * width, size: width });
  }
  const rows: Line[] = [];
  let missing = false;
  table.node.forEach((_row, offset) => {
    const dom = view.nodeDOM(table.start + offset);
    if (!(dom instanceof HTMLElement)) return void (missing = true);
    const rect = dom.getBoundingClientRect();
    rows.push({ start: rect.top, size: rect.height });
  });
  if (missing) return null;

  const sel = state.selection instanceof CellSelection && state.selection.$anchorCell.start(-1) === table.start ? state.selection : null;
  const cellRect = sel ? map.rectBetween(sel.$anchorCell.pos - table.start, sel.$headCell.pos - table.start) : null;
  const colSelected = (i: number) => !!(sel?.isColSelection() && cellRect && i >= cellRect.left && i < cellRect.right);
  const rowSelected = (i: number) => !!(sel?.isRowSelection() && cellRect && i >= cellRect.top && i < cellRect.bottom);
  const allSelected = !!(sel?.isColSelection() && sel.isRowSelection());

  const topBar = box.top - GAP - BAR;
  // Rows: at the left of the box the table scrolls in, when it is wider than the page.
  const leftBar = clip.left - GAP - BAR;
  const showTop = topBar >= scroller.top && topBar <= scroller.bottom - BAR;

  /** A press on a bar: selects its line at once; moving then drags it to another place. */
  const onBarDown = (axis: Axis, index: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const tablePos = table.pos;
    const select = axis === "column" ? selectColumn : selectRow;
    select(tablePos, index, e.shiftKey)(view.state, view.dispatch);
    if (e.shiftKey) return;
    const lines = axis === "column" ? columns : rows;
    const start = { x: e.clientX, y: e.clientY };
    let current: Drag | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      const at = axis === "column" ? ev.clientX : ev.clientY;
      let to = lines.findIndex((l) => at < l.start + l.size);
      if (to < 0) to = lines.length - 1;
      if (at < lines[0].start) to = 0;
      current = { axis, from: index, to };
      setDrag(current);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (current && current.to !== current.from) moveLine(tablePos, axis, current.from, current.to)(view.state, view.dispatch);
      view.focus();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** "+": a new column or row after this one, with the cursor in its first cell. */
  const insertAfter = (axis: Axis, index: number) => {
    const tablePos = table.pos;
    const select = axis === "column" ? selectColumn : selectRow;
    if (!select(tablePos, index)(view.state, view.dispatch)) return;
    (axis === "column" ? addColumnAfter : addRowAfter)(view.state, view.dispatch);
    const node = view.state.doc.nodeAt(tablePos);
    if (node) {
      const m = TableMap.get(node);
      const cell = tablePos + 1 + m.map[axis === "column" ? index + 1 : (index + 1) * m.width];
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(cell + 1))));
    }
    view.focus();
  };

  // Where a dragged line would go: a line on that side of its new place.
  let dropLine: { left: number; top: number; width: number; height: number } | null = null;
  if (drag && drag.to !== drag.from) {
    if (drag.axis === "column") {
      const c = columns[drag.to];
      const x = drag.to > drag.from ? c.start + c.size : c.start;
      dropLine = { left: x - 1, top: box.top, width: 3, height: box.height };
    } else {
      const r = rows[drag.to];
      const y = drag.to > drag.from ? r.start + r.size : r.start;
      dropLine = { left: box.left, top: y - 1, width: box.width, height: 3 };
    }
  }

  return (
    <div className="table-grips" onMouseDown={(e) => e.preventDefault()}>
      {showTop && (
        <button
          className={`table-grip table-grip-corner${allSelected ? " selected" : ""}`}
          style={{ left: leftBar, top: topBar, width: BAR, height: BAR }}
          title={t("selectTable")}
          onClick={() => {
            selectTable(table.pos)(view.state, view.dispatch);
            view.focus();
          }}
        />
      )}
      {showTop &&
        columns.map((c, i) => {
          // Scrolled out of a wide table's view.
          const left = Math.max(c.start, clip.left);
          const right = Math.min(c.start + c.size, clip.right);
          if (right - left < 8) return null;
          return (
            <div key={`c${i}`} className="table-grip-line column" style={{ left, top: topBar, width: right - left, height: BAR }}>
              <button className={`table-grip${colSelected(i) ? " selected" : ""}`} title={t("tableGripHint")} onPointerDown={onBarDown("column", i)} />
              {right === c.start + c.size && (
                <button className="table-grip-add" title={t("addColumn")} onClick={() => insertAfter("column", i)}>
                  +
                </button>
              )}
            </div>
          );
        })}
      {rows.map((r, i) => {
        const top = Math.max(r.start, scroller.top);
        const bottom = Math.min(r.start + r.size, scroller.bottom);
        if (bottom - top < 8) return null;
        return (
          <div key={`r${i}`} className="table-grip-line row" style={{ left: leftBar, top, width: BAR, height: bottom - top }}>
            <button className={`table-grip${rowSelected(i) ? " selected" : ""}`} title={t("tableGripHint")} onPointerDown={onBarDown("row", i)} />
            {bottom === r.start + r.size && (
              <button className="table-grip-add" title={t("addRow")} onClick={() => insertAfter("row", i)}>
                +
              </button>
            )}
          </div>
        );
      })}
      {dropLine && <div className="table-drop-line" style={dropLine} />}
    </div>
  );
}
