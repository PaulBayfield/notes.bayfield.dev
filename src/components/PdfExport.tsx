// Exporting a page — or only part of it — as a PDF. The chosen content is drawn by a read-only
// editor (so math, diagrams and highlighted code look as they do on screen) into a container
// that only shows when printing, then the system print dialog opens with "Save as PDF".

import { useMemo, useState } from "react";
import { EditorState, type Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Fragment, type Node } from "prosemirror-model";
import { CellSelection, columnResizing } from "prosemirror-tables";
import { mathPlugin } from "@benrbray/prosemirror-math";
import { headingPrefixPlugin, type HeadingPrefixStyle } from "../editor/headingPrefix";
import { highlightPlugin } from "../editor/highlight";
import { nodeViews } from "../editor/nodeviews";
import { schema } from "../editor/schema";
import { NotesTableView } from "../editor/tables";
import { useSettings } from "../lib/settings";
import { Dialog } from "./Dialogs";

type Scope = "page" | "selection" | "sections";

interface Section {
  /** Index of the heading among the document's top-level blocks. */
  index: number;
  /** Index of the first top-level block after the section (the next heading at its level or above). */
  end: number;
  level: number;
  text: string;
}

/** Each top-level heading and how far its content reaches. */
function sectionsOf(doc: Node): Section[] {
  const blocks: Node[] = [];
  doc.forEach((n) => blocks.push(n));
  const sections: Section[] = [];
  blocks.forEach((node, index) => {
    if (node.type !== schema.nodes.heading) return;
    const level = node.attrs.level as number;
    let end = index + 1;
    while (end < blocks.length && !(blocks[end].type === schema.nodes.heading && blocks[end].attrs.level <= level)) end++;
    sections.push({ index, end, level, text: node.textContent.trim() });
  });
  return sections;
}

/** The chosen sections, in document order; a section inside another chosen one isn't repeated. */
function docFromSections(doc: Node, sections: Section[], chosen: Set<number>): Node | null {
  const keep = new Set<number>();
  for (const s of sections) if (chosen.has(s.index)) for (let i = s.index; i < s.end; i++) keep.add(i);
  const nodes: Node[] = [];
  doc.forEach((n, _offset, i) => keep.has(i) && nodes.push(n));
  return nodes.length ? schema.nodes.doc.create(null, nodes) : null;
}

/** What's selected, as a document of its own; `null` when nothing is. */
function docFromSelection(doc: Node, sel: Selection): Node | null {
  if (sel.empty) return null;
  if (sel instanceof CellSelection) {
    // Selected cells: the same table, with only those rows and cells.
    const table = sel.$anchorCell.node(-1);
    const rows = sel.content().content;
    const candidate = schema.nodes.doc.create(null, table.type.create(table.attrs, rows));
    try {
      candidate.check();
      return candidate;
    } catch {
      // Fall through to the whole blocks below.
    }
  }
  // A slice from the document's root keeps its structure (lists, quotes…), cut at the edges.
  const slice = doc.slice(sel.from, sel.to);
  try {
    const candidate = schema.nodes.doc.create(null, slice.content);
    candidate.check();
    if (candidate.textContent.trim() || candidate.content.size > 2) return candidate;
  } catch {
    // Not valid on its own (e.g. a few cells of a table): take the whole blocks it touches.
  }
  const nodes: Node[] = [];
  doc.forEach((n, offset) => {
    if (offset < sel.to && offset + n.nodeSize > sel.from) nodes.push(n);
  });
  return nodes.length ? schema.nodes.doc.create(null, Fragment.fromArray(nodes)) : null;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves once `test` is true, or after `timeout` whatever happens. */
async function until(test: () => boolean, timeout: number) {
  const start = Date.now();
  while (!test() && Date.now() - start < timeout) await wait(100);
}

/** Draws `doc` into a print-only container, opens the print dialog, and cleans up afterwards. */
export async function printDocument(doc: Node, opts: { title: string; includeTitle: boolean; headingPrefix: HeadingPrefixStyle }) {
  document.querySelector(".print-root")?.remove();
  const root = document.createElement("div");
  root.className = "print-root";
  if (opts.includeTitle && opts.title) {
    const h = document.createElement("h1");
    h.className = "print-title";
    h.textContent = opts.title;
    root.append(h);
  }
  const mount = document.createElement("div");
  mount.className = "editor";
  root.append(mount);
  document.body.append(root);

  const view = new EditorView(mount, {
    state: EditorState.create({
      doc,
      plugins: [mathPlugin, columnResizing({ cellMinWidth: 60, View: NotesTableView }), highlightPlugin(), headingPrefixPlugin(opts.headingPrefix)],
    }),
    editable: () => false,
    // Toggles print open: their content is part of the page.
    nodeViews: nodeViews({ openLink: () => {}, openDocument: () => {}, foldedToggles: new Set(), embeds: false }),
    attributes: { class: "doc-content" },
  });

  const cleanup = () => {
    view.destroy();
    root.remove();
  };

  try {
    // Pictures load lazily, which never happens off screen: load them now and wait for them.
    root.querySelectorAll("img").forEach((img) => (img.loading = "eager"));
    await until(() => [...root.querySelectorAll("img")].every((img) => !img.getAttribute("src") || img.complete), 10000);
    // Diagrams are drawn in the background.
    await until(() => [...root.querySelectorAll(".mermaid-diagram")].every((d) => d.querySelector("svg") || d.classList.contains("error") || d.querySelector(".mermaid-empty")), 10000);
    await document.fonts?.ready;
    await wait(50);
  } catch (e) {
    cleanup();
    throw e;
  }

  // Browsers name the PDF after the page title.
  const previousTitle = document.title;
  document.title = opts.title;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    document.title = previousTitle;
    window.removeEventListener("afterprint", finish);
    cleanup();
  };
  window.addEventListener("afterprint", finish);
  window.print();
  // Most engines block in print(); those that don't still fire "afterprint". Safety net:
  setTimeout(() => {
    if (!done && !window.matchMedia("print").matches) finish();
  }, 60000);
}

export function PdfExportDialog({
  title,
  doc,
  selection,
  headingPrefix,
  onClose,
  onError,
}: {
  title: string;
  doc: Node;
  /** The editor's selection when the dialog was opened. */
  selection: Selection;
  headingPrefix: HeadingPrefixStyle;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useSettings();
  const selected = useMemo(() => docFromSelection(doc, selection), [doc, selection]);
  const sections = useMemo(() => sectionsOf(doc), [doc]);
  const [scope, setScope] = useState<Scope>(selected ? "selection" : "page");
  const [chosen, setChosen] = useState<Set<number>>(() => new Set());
  const [includeTitle, setIncludeTitle] = useState(true);
  const [busy, setBusy] = useState(false);
  const minLevel = Math.min(...sections.map((s) => s.level));

  const content = scope === "page" ? doc : scope === "selection" ? selected : docFromSections(doc, sections, chosen);

  const toggle = (s: Section) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(s.index)) next.delete(s.index);
      else next.add(s.index);
      return next;
    });

  const option = (value: Scope, label: string, hint: string, disabled = false) => (
    <label className={`export-format${scope === value ? " active" : ""}${disabled ? " disabled" : ""}`}>
      <input type="radio" name="pdf-scope" checked={scope === value} disabled={disabled} onChange={() => setScope(value)} />
      <span className="export-format-text">
        <span className="export-format-title">{label}</span>
        <span className="settings-hint">{hint}</span>
      </span>
    </label>
  );

  return (
    <Dialog title={t("exportPdfTitle")} onClose={onClose}>
      <form
        className="export-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!content) return;
          setBusy(true);
          try {
            await printDocument(content, { title: title || t("untitled"), includeTitle, headingPrefix });
            onClose();
          } catch (err) {
            onError(err);
            setBusy(false);
          }
        }}
      >
        <div className="export-formats" role="radiogroup">
          {option("page", t("pdfWholePage"), t("pdfWholePageHint"))}
          {option("selection", t("pdfSelection"), t(selected ? "pdfSelectionHint" : "pdfSelectionEmpty"), !selected)}
          {option("sections", t("pdfSections"), t(sections.length ? "pdfSectionsHint" : "pdfNoHeadings"), !sections.length)}
        </div>
        {scope === "sections" && (
          <div className="pdf-sections">
            <div className="pdf-sections-actions">
              <button type="button" className="text-button" onClick={() => setChosen(new Set(sections.map((s) => s.index)))}>
                {t("selectAll")}
              </button>
              <button type="button" className="text-button" onClick={() => setChosen(new Set())}>
                {t("selectNone")}
              </button>
            </div>
            {sections.map((s) => {
              // Inside a chosen section: included anyway.
              const covered = sections.some((o) => o.index < s.index && s.index < o.end && chosen.has(o.index));
              return (
                <label key={s.index} className="export-option pdf-section" style={{ paddingLeft: 10 + (s.level - minLevel) * 18 }}>
                  <input type="checkbox" checked={chosen.has(s.index) || covered} disabled={covered} onChange={() => toggle(s)} />
                  <span>{s.text || t("untitled")}</span>
                </label>
              );
            })}
          </div>
        )}
        <label className="export-option">
          <input type="checkbox" checked={includeTitle} onChange={(e) => setIncludeTitle(e.target.checked)} />
          <span className="export-format-text">
            <span>{t("pdfIncludeTitle")}</span>
          </span>
        </label>
        <p className="settings-hint">{t("pdfSaveHint")}</p>
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={busy || !content}>
            {busy ? t("exporting") : t("export")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
