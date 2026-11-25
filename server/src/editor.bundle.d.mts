// Types for editor.bundle.mjs, built from editor/entry.ts (npm run build:editor at the repository root).

export type DocJSON = { type: "doc"; content?: unknown[] };

export const EDITOR_VERSION: string;
export function markdownToDoc(markdown: string): DocJSON;
export function checkDoc(json: unknown): DocJSON;
export function docToState(json: DocJSON): Uint8Array;
export function stateToDoc(state: Uint8Array): DocJSON;

export function replaceContent(ydoc: import("yjs").Doc, json: DocJSON): void;
export function ydocToDoc(ydoc: import("yjs").Doc): DocJSON;

/** Yjs, the same copy the conversions use (the collaboration server shares it). */
export const Y: typeof import("yjs");
