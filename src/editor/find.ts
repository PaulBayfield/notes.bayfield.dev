// Search in document (Ctrl+F): highlights matches, steps through them, replaces.

import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

interface FindState {
  query: string;
  caseSensitive: boolean;
  matches: { from: number; to: number }[];
  current: number;
  decorations: DecorationSet;
}

export const findKey = new PluginKey<FindState>("find");

function search(state: EditorState, query: string, caseSensitive: boolean) {
  const matches: { from: number; to: number }[] = [];
  if (!query) return matches;
  const needle = caseSensitive ? query : query.toLowerCase();
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Text of the block with each character's document position.
    let text = "";
    const positions: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) positions.push(pos + 1 + offset + i);
        text += child.text;
      } else {
        positions.push(-1);
        text += "￼";
      }
    });
    const hay = caseSensitive ? text : text.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
      const from = positions[i];
      const to = positions[i + needle.length - 1] + 1;
      if (from >= 0 && to > 0) matches.push({ from, to });
    }
    return false;
  });
  return matches;
}

function build(state: EditorState, query: string, caseSensitive: boolean, current: number): FindState {
  const matches = search(state, query, caseSensitive);
  const index = matches.length ? Math.min(Math.max(current, 0), matches.length - 1) : -1;
  const decorations = DecorationSet.create(
    state.doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? "find-match current" : "find-match" })),
  );
  return { query, caseSensitive, matches, current: index, decorations };
}

export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: (_, state) => build(state, "", false, 0),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(findKey) as Partial<Pick<FindState, "query" | "caseSensitive" | "current">> | undefined;
        if (meta) return build(state, meta.query ?? prev.query, meta.caseSensitive ?? prev.caseSensitive, meta.current ?? prev.current);
        if (tr.docChanged && prev.query) return build(state, prev.query, prev.caseSensitive, prev.current);
        return prev;
      },
    },
    props: {
      decorations: (state) => findKey.getState(state)?.decorations,
    },
  });
}

export function setFind(view: EditorView, patch: { query?: string; caseSensitive?: boolean; current?: number }) {
  view.dispatch(view.state.tr.setMeta(findKey, patch));
}

/** Moves to the next (1) or previous (-1) match and scrolls it into view. */
export function stepFind(view: EditorView, delta: 1 | -1) {
  const s = findKey.getState(view.state);
  if (!s?.matches.length) return;
  const current = (s.current + delta + s.matches.length) % s.matches.length;
  revealMatch(view, view.state.tr.setMeta(findKey, { current }), s.matches[current]);
}

function revealMatch(view: EditorView, tr: Transaction, match: { from: number; to: number }) {
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView());
}

export function replaceCurrent(view: EditorView, replacement: string) {
  const s = findKey.getState(view.state);
  if (!s?.matches.length || !view.editable) return;
  const m = s.matches[s.current];
  const tr = view.state.tr.insertText(replacement, m.from, m.to);
  view.dispatch(tr.setMeta(findKey, { current: s.current }));
}

export function replaceAll(view: EditorView, replacement: string) {
  const s = findKey.getState(view.state);
  if (!s?.matches.length || !view.editable) return;
  const tr = view.state.tr;
  // Last to first, so earlier positions stay valid.
  for (const m of [...s.matches].reverse()) tr.insertText(replacement, m.from, m.to);
  view.dispatch(tr.setMeta(findKey, { current: 0 }));
}
