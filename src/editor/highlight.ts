// Syntax colours in code blocks, as decorations (the document itself is untouched).

import type { Node } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { refractor } from "refractor/core";
import type { Root, RootContent } from "hast";
import { CODE_LANGUAGES } from "./codeLanguages";

const key = new PluginKey<DecorationSet>("highlight");

interface Span {
  from: number;
  to: number;
  className: string;
}

/** Highlighted spans per code node; nodes are immutable, so unchanged blocks are never redone. */
const cache = new WeakMap<Node, Span[]>();
const loading = new Map<string, Promise<void>>();

function grammarFor(node: Node): string | null {
  const language = CODE_LANGUAGES[node.attrs.language ?? "none"];
  return language?.lang || null;
}

/** Loads a grammar once; resolves when it can be used. */
function load(language: string): Promise<void> {
  const def = CODE_LANGUAGES[language];
  if (!def?.load) return Promise.resolve();
  let pending = loading.get(def.lang);
  if (!pending) {
    pending = def
      .load()
      .then((mod) => refractor.register(mod.default))
      .catch(() => {});
    loading.set(def.lang, pending);
  }
  return pending;
}

function spans(node: Node, grammar: string): Span[] {
  const cached = cache.get(node);
  if (cached) return cached;
  const out: Span[] = [];
  let offset = 0;
  const walk = (children: RootContent[], classes: string[]) => {
    for (const child of children) {
      if (child.type === "text") {
        const end = offset + child.value.length;
        if (classes.length) out.push({ from: offset, to: end, className: classes.join(" ") });
        offset = end;
      } else if (child.type === "element") {
        const own = (child.properties?.className as string[] | undefined) ?? [];
        walk(child.children, [...classes, ...own]);
      }
    }
  };
  const tree: Root = refractor.highlight(node.textContent, grammar);
  walk(tree.children, []);
  cache.set(node, out);
  return out;
}

function decorate(doc: Node, view: EditorView | null): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.type.spec.code || !node.isTextblock) return true;
    const grammar = grammarFor(node);
    if (!grammar) return false;
    if (!refractor.registered(grammar)) {
      // Highlight once the grammar arrives.
      void load(node.attrs.language).then(() => view && !view.isDestroyed && view.dispatch(view.state.tr.setMeta(key, true)));
      return false;
    }
    for (const span of spans(node, grammar)) decos.push(Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, { class: span.className }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export function highlightPlugin(): Plugin {
  let view: EditorView | null = null;
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => decorate(state.doc, null),
      apply: (tr, old, _oldState, newState) => (tr.docChanged || tr.getMeta(key) ? decorate(newState.doc, view) : old),
    },
    view(v) {
      view = v;
      // The first pass ran before there was a view to notify; redo it now that there is.
      setTimeout(() => !v.isDestroyed && v.dispatch(v.state.tr.setMeta(key, true)));
      return { destroy: () => (view = null) };
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}

/** Languages offered in the picker. */
export const pickableLanguages = Object.entries(CODE_LANGUAGES)
  .filter(([, l]) => !l.alias)
  .map(([id, l]) => ({ id, label: l.label }));
