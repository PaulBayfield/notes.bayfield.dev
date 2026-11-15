// The editors on screen, so app-wide features (the right-click menu) can act on the one under
// the pointer.

import type { EditorView } from "prosemirror-view";

export interface RegisteredEditor {
  view: EditorView;
  /** Starts a comment on the selection; only documents (not overviews or templates) have them. */
  comment?: () => void;
}

const editors = new Set<RegisteredEditor>();

/** Registers an editor; returns the function that unregisters it. */
export function registerEditor(entry: RegisteredEditor): () => void {
  editors.add(entry);
  return () => editors.delete(entry);
}

/** The editor that contains this element, if any. */
export function editorAt(target: Element): RegisteredEditor | null {
  for (const e of editors) if (!e.view.isDestroyed && e.view.dom.contains(target)) return e;
  return null;
}
