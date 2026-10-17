// Mermaid diagrams: code blocks in the "mermaid" language (Outline's older "mermaidjs" too) are
// drawn as diagrams. Mermaid is big, so it's only loaded when a document contains one.

import type { Mermaid } from "mermaid";
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export const isMermaid = (language: string | null | undefined) => language === "mermaid" || language === "mermaidjs";

let loading: Promise<Mermaid> | null = null;
let configuredFor = "";
let counter = 0;

/** Diagram colours follow the app's theme (CSS variables), so Rosé Pine looks like Rosé Pine. */
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: css.colorScheme === "dark",
    background: v("--bg"),
    primaryColor: v("--bg-elevated"),
    primaryTextColor: v("--text"),
    primaryBorderColor: v("--border-strong"),
    secondaryColor: v("--hover"),
    tertiaryColor: v("--bg-sidebar"),
    lineColor: v("--text-muted"),
    textColor: v("--text"),
    mainBkg: v("--bg-elevated"),
    nodeBorder: v("--primary"),
    clusterBkg: v("--bg-sidebar"),
    clusterBorder: v("--border-strong"),
    noteBkgColor: v("--hover"),
    noteTextColor: v("--text"),
    noteBorderColor: v("--border-strong"),
    edgeLabelBackground: v("--bg"),
    fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
    fontSize: "14px",
  };
}

async function mermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  const instance = await loading;
  const theme = document.documentElement.dataset.theme ?? "";
  if (configuredFor !== theme) {
    instance.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: themeVariables() });
    configuredFor = theme;
  }
  return instance;
}

/** Renders diagram source to SVG; throws with Mermaid's message on a syntax error. */
export async function renderMermaid(source: string): Promise<string> {
  const m = await mermaid();
  const id = `mermaid-${++counter}`;
  try {
    const { svg } = await m.render(id, source);
    return svg;
  } finally {
    // Mermaid leaves a temporary element behind when rendering fails.
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Views to redraw when the theme changes. */
const views = new Set<() => void>();
let observer: MutationObserver | null = null;
export function onThemeChange(redraw: () => void): () => void {
  views.add(redraw);
  observer ??= (() => {
    const o = new MutationObserver(() => views.forEach((r) => r()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return o;
  })();
  return () => views.delete(redraw);
}

/**
 * Marks the diagram block holding the cursor as being edited, which shows its source.
 * Elsewhere only the diagram shows.
 */
export function mermaidEditingPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.spec.code && isMermaid(node.attrs.language)) {
            const pos = $from.before(d);
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: "editing" })]);
          }
        }
        return null;
      },
    },
  });
}
