// Comment anchors are `comment` marks in the shared document (id + author), like in Outline.
// A new comment starts as a draft mark; it becomes a real one when the comment is posted.

import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { schema } from "./schema";

const commentMark = schema.marks.comment;

export interface Range {
  from: number;
  to: number;
}

/** Where a comment's mark is in the document (it can be split into several ranges). */
export function commentRanges(doc: Node, id: string): Range[] {
  const ranges: Range[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    if (node.marks.some((m) => m.type === commentMark && m.attrs.id === id)) {
      const last = ranges[ranges.length - 1];
      if (last && last.to === pos) last.to = pos + node.nodeSize;
      else ranges.push({ from: pos, to: pos + node.nodeSize });
    }
    return false;
  });
  return ranges;
}

/** The commented text, for showing above a thread. */
export function commentQuote(doc: Node, id: string): string {
  return commentRanges(doc, id)
    .map((r) => doc.textBetween(r.from, r.to, " ", " "))
    .join(" … ");
}

/** Comment ids in document order, to sort threads the way they appear. */
export function commentOrder(doc: Node): Map<string, number> {
  const order = new Map<string, number>();
  doc.descendants((node, pos) => {
    for (const m of node.marks) if (m.type === commentMark && !order.has(m.attrs.id)) order.set(m.attrs.id, pos);
    return true;
  });
  return order;
}

/** Adds a draft comment mark over the selection; returns its id. */
export function startComment(view: EditorView, userId: string): string | null {
  const { from, to, empty } = view.state.selection;
  if (empty) return null;
  const id = crypto.randomUUID();
  view.dispatch(view.state.tr.addMark(from, to, commentMark.create({ id, userId, draft: true })));
  return id;
}

/** Changes the attributes of a comment's marks (draft → posted, resolved…). */
export function updateCommentMark(view: EditorView, id: string, attrs: { draft?: boolean; resolved?: boolean }) {
  const tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const mark = node.marks.find((m) => m.type === commentMark && m.attrs.id === id);
    if (mark) {
      tr.removeMark(pos, pos + node.nodeSize, mark);
      tr.addMark(pos, pos + node.nodeSize, commentMark.create({ ...mark.attrs, ...attrs }));
    }
    return false;
  });
  if (tr.docChanged) view.dispatch(tr);
}

export function removeCommentMark(view: EditorView, id: string) {
  const tr = view.state.tr;
  for (const r of commentRanges(view.state.doc, id)) {
    view.state.doc.nodesBetween(r.from, r.to, (node, pos) => {
      const mark = node.marks.find((m) => m.type === commentMark && m.attrs.id === id);
      if (mark) tr.removeMark(pos, pos + node.nodeSize, mark);
    });
  }
  if (tr.docChanged) view.dispatch(tr);
}

export function scrollToComment(view: EditorView, id: string) {
  const first = commentRanges(view.state.doc, id)[0];
  if (!first) return;
  const { node } = view.domAtPos(first.from + 1);
  const el = node instanceof HTMLElement ? node : node.parentElement;
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
}
