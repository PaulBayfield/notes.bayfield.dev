// Heading numbering (Outline's per-document "heading prefix" preference): 1. / 1.1, 1.a.i, I.A.1…

import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";

export type HeadingPrefixStyle = "none" | "numeric" | "alphanumeric" | "outline";

const key = new PluginKey<{ style: HeadingPrefixStyle; decorations: DecorationSet }>("heading-prefix");

const toAlpha = (num: number) => {
  let n = num;
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
};

const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];
const toRoman = (num: number) => {
  let n = num;
  let out = "";
  for (const [value, symbol] of ROMAN)
    while (n >= value) {
      out += symbol;
      n -= value;
    }
  return out;
};

/** Same rules as Outline's shared/utils/counters.ts. */
function counter(count: number, depth: number, style: HeadingPrefixStyle): string {
  if (style === "alphanumeric") return depth % 3 === 1 ? toAlpha(count) : depth % 3 === 2 ? toRoman(count) : String(count);
  if (style === "outline") {
    switch (depth % 5) {
      case 0:
        return toRoman(count).toUpperCase();
      case 1:
        return toAlpha(count).toUpperCase();
      case 2:
        return String(count);
      case 3:
        return toAlpha(count);
      default:
        return toRoman(count);
    }
  }
  return String(count);
}

/** Labels for a sequence of heading levels (same algorithm as Outline's HeadingPrefixHelper). */
export function headingLabels(levels: number[], style: HeadingPrefixStyle): string[] {
  const labels: string[] = [];
  const stack: { level: number; count: number }[] = [];
  for (const level of levels) {
    let closed: { level: number; count: number } | undefined;
    while (stack.length && stack[stack.length - 1].level > level) closed = stack.pop();
    const top = stack[stack.length - 1];
    if (top && top.level === level) top.count += 1;
    else stack.push({ level, count: (closed?.count ?? 0) + 1 });
    const counters = stack.map((s) => s.count);
    const label = counters.map((c, depth) => counter(c, depth, style)).join(".");
    labels.push(counters.length === 1 ? `${label}.` : label);
  }
  return labels;
}

function decorate(doc: Node, style: HeadingPrefixStyle): DecorationSet {
  if (style === "none") return DecorationSet.empty;
  const headings: { pos: number; level: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "table") return false;
    if (node.type.name === "heading") headings.push({ pos, level: node.attrs.level });
    return true;
  });
  const labels = headingLabels(
    headings.map((h) => h.level),
    style,
  );
  return DecorationSet.create(
    doc,
    headings.map((h, i) =>
      Decoration.widget(
        h.pos + 1,
        () => {
          const span = document.createElement("span");
          span.className = "heading-prefix";
          span.textContent = `${labels[i]} `;
          span.contentEditable = "false";
          return span;
        },
        { side: -1, key: `${labels[i]}` },
      ),
    ),
  );
}

export function headingPrefixPlugin(initial: HeadingPrefixStyle): Plugin {
  return new Plugin({
    key,
    state: {
      init: (_, state) => ({ style: initial, decorations: decorate(state.doc, initial) }),
      apply(tr, prev, _old, state) {
        const style = (tr.getMeta(key) as HeadingPrefixStyle | undefined) ?? prev.style;
        if (style !== prev.style || tr.docChanged) return { style, decorations: decorate(state.doc, style) };
        return prev;
      },
    },
    props: { decorations: (state) => key.getState(state)?.decorations },
  });
}

export function setHeadingPrefix(view: EditorView, style: HeadingPrefixStyle) {
  view.dispatch(view.state.tr.setMeta(key, style));
}
