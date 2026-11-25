// What the server needs from the web app's editor, bundled into src/editor.bundle.mjs (npm run
// build:editor, from the repository root): the same ProseMirror schema as the app (so the documents
// it writes are ones the app's and Outline's editors can open), its Markdown parser, and the Yjs
// conversions. Shared, not copied: a change to the editor reaches the server at the next build.

import { Fragment, Node } from "prosemirror-model";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc, prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { EDITOR_VERSION, schema } from "../../src/editor/schema";
import { markdownToSlice } from "../../src/editor/markdown";

export { EDITOR_VERSION, schema };

export type DocJSON = { type: "doc"; content?: unknown[] };

/** Markdown (Outline's flavour) → a ProseMirror document, as JSON. */
export function markdownToDoc(markdown: string): DocJSON {
  const slice = markdown.trim() ? markdownToSlice(markdown) : null;
  const doc = slice ? schema.topNodeType.create(null, slice.content) : schema.topNodeType.create(null, Fragment.from(schema.nodes.paragraph.create()));
  // Outline writes an empty line as a lone backslash: back to an empty paragraph.
  const json = doc.toJSON() as DocJSON;
  const empty = (n: { type: string; content?: { type: string; text?: string }[] }) =>
    n.type === "paragraph" && n.content?.length === 1 && n.content[0].type === "text" && /^\\\s*$/.test(n.content[0].text ?? "");
  const walk = (n: { type: string; content?: unknown[] }): void => {
    if (!n.content) return;
    n.content = n.content.map((c) => (empty(c as never) ? { type: "paragraph" } : c));
    n.content.forEach((c) => walk(c as never));
  };
  walk(json);
  return json;
}

/** Checks a document against the schema; throws when it doesn't fit (a client sent something odd). */
export function checkDoc(json: unknown): DocJSON {
  const node = Node.fromJSON(schema, json as Record<string, unknown>);
  node.check();
  return node.toJSON() as DocJSON;
}

/** ProseMirror JSON → a Yjs update holding it (the "default" XML fragment, as Outline's editor uses). */
export function docToState(json: DocJSON): Uint8Array {
  const ydoc = prosemirrorJSONToYDoc(schema, json, "default");
  return Y.encodeStateAsUpdate(ydoc);
}

/** A Yjs state → ProseMirror JSON. */
export function stateToDoc(state: Uint8Array): DocJSON {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  return yDocToProsemirrorJSON(ydoc, "default") as DocJSON;
}

/** Replaces a live Yjs document's content (an edit made through the API while people have it open). */
export function replaceContent(ydoc: Y.Doc, json: DocJSON) {
  const fragment = ydoc.getXmlFragment("default");
  ydoc.transact(() => {
    fragment.delete(0, fragment.length);
    prosemirrorJSONToYXmlFragment(schema, checkDoc(json), fragment);
  }, "api");
}

/** A Yjs document's content as ProseMirror JSON. */
export const ydocToDoc = (ydoc: Y.Doc) => yDocToProsemirrorJSON(ydoc, "default") as DocJSON;

export { Y };
