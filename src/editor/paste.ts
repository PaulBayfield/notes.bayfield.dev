// Pasting, as in Outline. A single URL becomes a link; a link to a document or collection on
// this server becomes a mention; a link that can be embedded (a video, a design…) offers to
// embed it through a small menu. A spreadsheet range becomes a table, and code copied from a
// code editor becomes a code block in its language.

import { Plugin, PluginKey } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { collectionIdFromHref, collectionInfo, docIdFromHref, documentInfo } from "../lib/api";
import { insertBlock } from "./commands";
import { embedUrl } from "./nodeviews";
import { schema } from "./schema";
import { CODE_LANGUAGES, languageId } from "./codeLanguages";
import { looksLikeMarkdown } from "./markdown";

const { nodes, marks } = schema;

export interface PasteMenuState {
  href: string;
  /** The pasted link's text. */
  from: number;
  to: number;
}

export const pasteMenuKey = new PluginKey<PasteMenuState | null>("pasteMenu");

/** Set by the menu while it's open; returns true when it handled the key. */
export const pasteMenuKeys: { current: ((e: KeyboardEvent) => boolean) | null } = { current: null };

/** Keeps the menu open while the cursor stays right after the pasted link. */
export function pasteMenuPlugin(): Plugin {
  return new Plugin<PasteMenuState | null>({
    key: pasteMenuKey,
    state: {
      init: () => null,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(pasteMenuKey);
        if (meta !== undefined) return meta;
        if (!prev) return null;
        const from = tr.mapping.map(prev.from, 1);
        const to = tr.mapping.map(prev.to, -1);
        const { selection } = state;
        if (to - from !== prev.to - prev.from || !selection.empty || selection.from !== to) return null;
        return { ...prev, from, to };
      },
    },
    props: {
      handleKeyDown(view, event) {
        if (!pasteMenuKey.getState(view.state)) return false;
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(pasteMenuKey, null));
          return true;
        }
        return pasteMenuKeys.current?.(event) ?? false;
      },
    },
  });
}

/** The pasted link (text and mark both equal to `href`) nearest to `near`. */
function findPastedLink(doc: Node, href: string, near: number): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText || node.text !== href || marks.link.isInSet(node.marks)?.attrs.href !== href) return;
    if (!best || Math.abs(pos - near) < Math.abs(best.from - near)) best = { from: pos, to: pos + node.nodeSize };
  });
  return best;
}

/** Swaps the pasted link for a mention once the document or collection is known. */
function replaceWithMention(view: EditorView, href: string, near: number, attrs: Record<string, unknown>) {
  if (view.isDestroyed) return;
  const link = findPastedLink(view.state.doc, href, near);
  if (!link) return;
  view.dispatch(view.state.tr.replaceWith(link.from, link.to, nodes.mention.create({ ...attrs, id: crypto.randomUUID() })));
}

/**
 * Handles pasting `text` when it's a single URL. Returns false when it isn't one, so the paste
 * goes on as usual.
 */
export function pasteUrl(view: EditorView, text: string, actorId: string): boolean {
  const href = text.trim();
  if (!/^https?:\/\/\S+$/i.test(href)) return false;
  const { state } = view;
  const { selection } = state;
  // Over selected text: links that text.
  if (!selection.empty) {
    view.dispatch(state.tr.addMark(selection.from, selection.to, marks.link.create({ href })));
    return true;
  }
  const from = selection.from;
  const tr = state.tr.replaceSelectionWith(schema.text(href, [marks.link.create({ href })]), false).removeStoredMark(marks.link);
  const to = from + href.length;

  const docId = docIdFromHref(href);
  const collectionId = collectionIdFromHref(href);
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  if (docId) {
    documentInfo(docId)
      .then(({ data: doc }) => replaceWithMention(view, href, from, { type: "document", modelId: doc.id, label: doc.title || "Untitled", actorId, anchorId: hash || undefined }))
      .catch(() => {});
  } else if (collectionId && !hash) {
    collectionInfo(collectionId)
      .then(({ data: c }) => c?.id && replaceWithMention(view, href, from, { type: "collection", modelId: c.id, label: c.name, actorId }))
      .catch(() => {});
  } else if (embedUrl(href)) {
    tr.setMeta(pasteMenuKey, { href, from, to });
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

// ---------- Spreadsheets and code ----------

/**
 * Cells copied from a spreadsheet (Excel, Google Sheets, Numbers) arrive as tab-separated rows:
 * a table, its first row as the header. Null unless every row has the same two or more cells.
 */
export function tableFromTsv(text: string): Node | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return null;
  const rows = lines.map((line) => line.split("\t"));
  const width = rows[0].length;
  if (width < 2 || rows.some((r) => r.length !== width)) return null;
  const cell = (type: typeof nodes.td, text: string) => type.create(null, nodes.paragraph.create(null, text.trim() ? schema.text(text.trim()) : undefined));
  return nodes.table.create(
    null,
    rows.map((cells, i) => nodes.tr.create(null, cells.map((c) => cell(i === 0 ? nodes.th : nodes.td, c)))),
  );
}

/** VS Code's names for languages that Outline calls something else. */
const VSCODE_LANGUAGES: Record<string, string> = {
  typescriptreact: "tsx",
  javascriptreact: "jsx",
  shellscript: "bash",
  "objective-c": "objectivec",
  dockercompose: "yaml",
};

/** The code block language for an editor's language name, or "none". */
function codeLanguage(name: string | undefined): string {
  if (!name) return "none";
  const id = languageId(VSCODE_LANGUAGES[name] ?? name);
  return CODE_LANGUAGES[id] ? id : "none";
}

/**
 * Handles pasting a spreadsheet range (a table) or code from a code editor (a code block in its
 * language; a single line becomes inline code). Returns false for anything else.
 */
export function pasteStructured(view: EditorView, event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  const text = data?.getData("text/plain") ?? "";
  const html = data?.getData("text/html") ?? "";
  const { selection } = view.state;
  if (!text || selection.$from.parent.type.spec.code) return false;

  // Spreadsheets also put an HTML table on the clipboard; the tab-separated text is cleaner.
  const inTable = (() => {
    for (let d = selection.$from.depth; d > 0; d--) if (selection.$from.node(d).type.spec.tableRole === "table") return true;
    return false;
  })();
  if (!inTable && text.includes("\t") && (!html || /<table/i.test(html))) {
    const table = tableFromTsv(text);
    if (table) {
      view.dispatch(view.state.tr.replaceSelectionWith(table).scrollIntoView());
      return true;
    }
  }

  // VS Code says which language it copied; other code editors only keep the text's layout.
  let vscodeMode: string | undefined;
  try {
    vscodeMode = JSON.parse(data?.getData("vscode-editor-data") || "null")?.mode;
  } catch {
    vscodeMode = undefined;
  }
  const fromCodeEditor = vscodeMode !== undefined || (/white-space:\s*pre/.test(html) && !html.includes("data-pm-slice"));
  if (!fromCodeEditor || vscodeMode === "markdown" || (!vscodeMode && looksLikeMarkdown(text))) return false;
  const code = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!code.includes("\n")) {
    // What is typed next is plain text again.
    view.dispatch(view.state.tr.replaceSelectionWith(schema.text(code, [marks.code_inline.create()]), false).setStoredMarks([]).scrollIntoView());
    return true;
  }
  const block = nodes.code_fence.create({ language: codeLanguage(vscodeMode) }, schema.text(code));
  const tr = view.state.tr.replaceSelectionWith(block);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Replaces the pasted link with an embed: in place of the line when it's alone on it. */
export function embedPastedLink(view: EditorView) {
  const s = pasteMenuKey.getState(view.state);
  if (!s) return;
  view.dispatch(view.state.tr.delete(s.from, s.to).setMeta(pasteMenuKey, null));
  // Not "inside": an embed holds inline content, but it has nothing to type in.
  insertBlock(nodes.embed.create({ href: s.href }), false)(view.state, view.dispatch);
}

export function closePasteMenu(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(pasteMenuKey, null));
}
