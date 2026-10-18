// The ProseMirror schema, mirroring Outline's (shared/editor, editor version 17).
//
// Documents are shared with Outline's own editor through Yjs, and y-prosemirror *deletes*
// any node or mark it can't build with this schema. So every node and mark name, every
// required attribute and every content expression below must match Outline's exactly.
// Node and mark order matters too (it decides default types), so it follows Outline's
// `withComments(richExtensions)`. Rendering (toDOM) is ours.

import { Schema, type DOMOutputSpec, type MarkSpec, type Node, type NodeSpec } from "prosemirror-model";
import { mathSchemaSpec } from "@benrbray/prosemirror-math";
import { emojiFor } from "./emoji";
import { dateLong } from "./dates";

/** The editor version sent to Outline; the server refuses clients a major version behind. */
export const EDITOR_VERSION = "17.0.0";

export const NOTICE_STYLES = ["info", "success", "tip", "warning"] as const;
export const LIST_STYLES = ["number", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"];

const safeUrl = (href: unknown): string | undefined => {
  if (typeof href !== "string") return undefined;
  return /^\s*(javascript|vbscript|data):/i.test(href) ? undefined : href;
};

const cellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  alignment: { default: null },
  colwidth: { default: null },
  marks: { default: undefined },
};

function cellToDOM(tag: "td" | "th") {
  return (node: Node): DOMOutputSpec => {
    const attrs: Record<string, string> = {};
    if (node.attrs.colspan !== 1) attrs.colspan = String(node.attrs.colspan);
    if (node.attrs.rowspan !== 1) attrs.rowspan = String(node.attrs.rowspan);
    const style: string[] = [];
    if (node.attrs.alignment) style.push(`text-align: ${node.attrs.alignment}`);
    if (Array.isArray(node.attrs.colwidth) && node.attrs.colwidth[0]) style.push(`min-width: ${node.attrs.colwidth[0]}px`);
    if (style.length) attrs.style = style.join("; ");
    return [tag, attrs, 0];
  };
}

function cellFromDOM(dom: HTMLElement) {
  const widthAttr = dom.getAttribute("data-colwidth");
  const widths = widthAttr && /^\d+(,\d+)*$/.test(widthAttr) ? widthAttr.split(",").map(Number) : null;
  const colspan = Number(dom.getAttribute("colspan") || 1);
  const align = dom.style.textAlign;
  return {
    colspan,
    rowspan: Number(dom.getAttribute("rowspan") || 1),
    colwidth: widths && widths.length === colspan ? widths : null,
    alignment: align === "center" || align === "right" || align === "left" ? align : null,
  };
}

const MENTION_LINK_TYPES = new Set(["document", "collection", "url", "issue", "pull_request", "project"]);

/** A mention as text: "@name" for people, the date written out for dates, else the label. */
function mentionText(node: Node): string {
  if (node.attrs.type === "user") return `@${node.attrs.label}`;
  if (node.attrs.type === "date" && typeof node.attrs.modelId === "string") return dateLong(node.attrs.modelId, document.documentElement.lang);
  return String(node.attrs.label ?? "");
}

const nodes: Record<string, NodeSpec> = {
  mention: {
    attrs: {
      type: { default: "user" },
      label: {},
      modelId: {},
      actorId: { default: undefined },
      id: { default: undefined },
      anchorId: { default: undefined },
      href: { default: undefined },
      unfurl: { default: undefined },
    },
    inline: true,
    marks: "",
    group: "inline",
    atom: true,
    parseDOM: [
      {
        tag: ".mention",
        priority: 100,
        getAttrs: (dom: HTMLElement) => {
          const type = dom.dataset.type;
          const modelId = dom.dataset.id;
          if (!type || !modelId) return false;
          return { type, modelId, label: dom.innerText, id: dom.id || undefined, href: dom.getAttribute("href") ?? undefined };
        },
      },
    ],
    toDOM: (node) => [
      MENTION_LINK_TYPES.has(node.attrs.type) ? "a" : "span",
      { class: `mention mention-${node.attrs.type}`, "data-type": node.attrs.type, "data-id": node.attrs.modelId },
      mentionText(node),
    ],
    leafText: mentionText,
  },

  doc: { content: "block+" },

  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", { dir: "auto" }, 0],
  },

  emoji: {
    attrs: { "data-name": { default: "grey_question" } },
    inline: true,
    content: "text*",
    marks: "",
    group: "inline",
    atom: true,
    selectable: false,
    parseDOM: [
      {
        priority: 100,
        tag: "strong.emoji",
        preserveWhitespace: "full",
        getAttrs: (dom: HTMLElement) => (dom.dataset.name ? { "data-name": dom.dataset.name } : false),
      },
    ],
    toDOM: (node) => ["strong", { class: "emoji", "data-name": node.attrs["data-name"] }, emojiFor(node.attrs["data-name"])],
    leafText: (node) => emojiFor(node.attrs["data-name"]),
  },

  text: { group: "inline" },

  br: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
    leafText: () => "\n",
  },

  image: {
    inline: true,
    attrs: {
      src: { default: "" },
      width: { default: undefined },
      height: { default: undefined },
      alt: { default: null },
      source: { default: null },
      layoutClass: { default: null },
      title: { default: null },
      marks: { default: undefined },
    },
    content: "text*",
    marks: "",
    group: "inline",
    selectable: true,
    draggable: true,
    atom: true,
    parseDOM: [
      {
        tag: "img",
        getAttrs: (dom: HTMLElement) => {
          if (dom.closest(".emoji")) return false;
          const width = dom.getAttribute("width");
          const height = dom.getAttribute("height");
          return {
            src: dom.getAttribute("src"),
            alt: dom.getAttribute("alt"),
            title: dom.getAttribute("title"),
            width: width ? parseInt(width, 10) : undefined,
            height: height ? parseInt(height, 10) : undefined,
          };
        },
      },
    ],
    toDOM: (node) => ["img", { src: safeUrl(node.attrs.src) ?? "", alt: node.attrs.alt ?? "" }],
    leafText: (node) => (node.attrs.alt ? `(image: ${node.attrs.alt})` : "(image)"),
  },

  code_block: codeSpec(),
  code_fence: codeSpec(),

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },

  embed: {
    content: "inline*",
    group: "block",
    atom: true,
    attrs: {
      href: {},
      width: { default: null },
      height: { default: null },
    },
    parseDOM: [{ tag: "a.embed", getAttrs: (dom: HTMLElement) => ({ href: dom.getAttribute("href") }) }],
    toDOM: (node) => ["a", { class: "embed", href: safeUrl(node.attrs.href) ?? "" }, String(node.attrs.href)],
    leafText: (node) => node.attrs.href,
  },

  attachment: {
    attrs: {
      id: { default: null },
      href: { default: null },
      title: {},
      size: { default: 0 },
      preview: { default: false },
      width: { default: null },
      height: { default: null },
      contentType: { default: null },
    },
    group: "block",
    defining: true,
    atom: true,
    parseDOM: [
      {
        priority: 100,
        tag: "a.attachment",
        getAttrs: (dom: HTMLElement) => ({
          id: dom.id || null,
          title: dom.innerText,
          href: dom.getAttribute("href"),
          size: parseInt(dom.dataset.size || "0", 10),
        }),
      },
    ],
    toDOM: (node) => ["a", { class: "attachment", href: safeUrl(node.attrs.href) ?? "" }, String(node.attrs.title)],
    leafText: (node) => node.attrs.title,
  },

  video: {
    attrs: {
      id: { default: null },
      src: { default: null },
      width: { default: null },
      height: { default: null },
      title: { default: null },
    },
    group: "block",
    selectable: true,
    draggable: false,
    defining: true,
    atom: true,
    parseDOM: [
      {
        priority: 100,
        tag: "video",
        getAttrs: (dom: HTMLElement) => ({ id: dom.id || null, title: dom.getAttribute("title"), src: dom.getAttribute("src") }),
      },
    ],
    toDOM: (node) => ["div", { class: "video" }, ["video", { src: safeUrl(node.attrs.src) ?? "", controls: "true" }]],
    leafText: (node) => node.attrs.title,
  },

  container_notice: {
    attrs: { style: { default: "info" } },
    content: "(list | blockquote | hr | paragraph | heading | code_block | code_fence | attachment)+",
    group: "block",
    defining: true,
    draggable: false,
    parseDOM: [
      {
        tag: "div.notice-block",
        contentElement: (node: HTMLElement) => node.querySelector("div.content") || node,
        getAttrs: (dom: HTMLElement) => ({
          style: NOTICE_STYLES.find((s) => dom.classList.contains(s)) ?? "info",
        }),
      },
    ],
    toDOM: (node) => ["div", { class: `notice-block ${node.attrs.style}` }, ["div", { class: "content" }, 0]],
  },

  heading: {
    attrs: {
      level: { default: 1 },
      collapsed: { default: undefined },
    },
    content: "inline*",
    group: "block",
    defining: true,
    draggable: false,
    parseDOM: [1, 2, 3, 4].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`, { dir: "auto" }, 0],
  },

  hr: {
    attrs: { markup: { default: "---" } },
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: (node) => ["hr", { class: node.attrs.markup === "***" ? "page-break" : "" }],
  },

  math_inline: mathSchemaSpec.nodes.math_inline as NodeSpec,
  math_block: mathSchemaSpec.nodes.math_display as NodeSpec,

  container_toggle: {
    content: "(paragraph | heading) block*",
    group: "block",
    attrs: { id: { default: undefined } },
    parseDOM: [{ tag: "div[data-type='container_toggle']" }, { tag: "div.toggle-block" }],
    toDOM: () => ["div", { class: "toggle-block", "data-type": "container_toggle" }, ["div", { class: "toggle-content" }, 0]],
  },

  checkbox_list: {
    group: "block list",
    content: "checkbox_item+",
    attrs: { id: { default: null } },
    toDOM: () => ["ul", { class: "checkbox_list" }, 0],
    parseDOM: [{ tag: `[class="checkbox_list"]` }],
  },

  checkbox_item: {
    attrs: { checked: { default: false } },
    content: "block+",
    defining: true,
    draggable: true,
    parseDOM: [
      {
        tag: `li[data-type="checkbox_item"]`,
        getAttrs: (dom: HTMLElement) => ({ checked: dom.className.includes("checked") }),
      },
    ],
    toDOM: (node) => [
      "li",
      { "data-type": "checkbox_item", class: node.attrs.checked ? "checked" : undefined },
      ["span", { contenteditable: "false", class: "checkbox", role: "checkbox", "aria-checked": String(!!node.attrs.checked) }],
      ["div", 0],
    ],
  },

  bullet_list: {
    content: "list_item+",
    group: "block list",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },

  ordered_list: {
    attrs: {
      order: { default: 1 },
      listStyle: { default: "number" },
    },
    content: "list_item+",
    group: "block list",
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom: HTMLElement) => ({
          order: dom.hasAttribute("start") ? parseInt(dom.getAttribute("start") || "1", 10) : 1,
          listStyle: LIST_STYLES.includes(dom.style.listStyleType) ? dom.style.listStyleType : "number",
        }),
      },
    ],
    toDOM: (node) => {
      const attrs: Record<string, string> = {};
      if (node.attrs.order !== 1) attrs.start = String(node.attrs.order);
      if (node.attrs.listStyle !== "number" && LIST_STYLES.includes(node.attrs.listStyle))
        attrs.style = `list-style-type: ${node.attrs.listStyle}`;
      return ["ol", attrs, 0];
    },
  },

  list_item: {
    content: "block+",
    defining: true,
    draggable: true,
    parseDOM: [{ tag: "li" }],
    toDOM: () => ["li", 0],
  },

  td: {
    content: "block+",
    tableRole: "cell",
    group: "cell",
    isolating: true,
    attrs: cellAttrs,
    parseDOM: [{ tag: "td", getAttrs: cellFromDOM }],
    toDOM: cellToDOM("td"),
  },

  th: {
    content: "block+",
    tableRole: "header_cell",
    group: "cell",
    isolating: true,
    attrs: cellAttrs,
    parseDOM: [{ tag: "th", getAttrs: cellFromDOM }],
    toDOM: cellToDOM("th"),
  },

  tr: {
    content: "(th | td)*",
    tableRole: "row",
    parseDOM: [{ tag: "tr" }],
    toDOM: () => ["tr", 0],
  },

  table: {
    content: "tr+",
    tableRole: "table",
    isolating: true,
    group: "block",
    attrs: { layout: { default: null } },
    parseDOM: [{ tag: "table" }],
    toDOM: () => ["div", { class: "table-wrapper" }, ["table", {}, ["tbody", 0]]],
  },
};

function codeSpec(): NodeSpec {
  return {
    attrs: {
      language: { default: "javascript" },
      wrap: { default: false },
    },
    content: "text*",
    marks: "comment",
    group: "block",
    code: true,
    defining: true,
    draggable: false,
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        contentElement: (node: HTMLElement) => node.querySelector("code") || node,
        getAttrs: (dom: HTMLElement) => ({ language: dom.dataset.language ?? dom.closest("[data-language]")?.getAttribute("data-language") ?? "" }),
      },
    ],
    toDOM: (node) => [
      "div",
      { class: `code-block${node.attrs.wrap ? " wrap" : ""}`, "data-language": node.attrs.language ?? "" },
      ["pre", ["code", { spellcheck: "false" }, 0]],
    ],
  };
}

const marks: Record<string, MarkSpec> = {
  comment: {
    excludes: "",
    attrs: {
      id: {},
      userId: {},
      resolved: { default: false },
      draft: { default: false },
    },
    inclusive: false,
    parseDOM: [],
    toDOM: (mark) => [
      "span",
      {
        class: `comment-marker${mark.attrs.resolved ? " resolved" : ""}${mark.attrs.draft ? " draft" : ""}`,
        "data-comment-id": mark.attrs.id,
      },
    ],
  },

  link: {
    attrs: {
      href: { default: "" },
      title: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]:not(.embed):not(.mention):not(.attachment)",
        getAttrs: (dom: HTMLElement) => ({ href: dom.getAttribute("href"), title: dom.getAttribute("title") }),
      },
    ],
    toDOM: (mark) => [
      "a",
      { href: safeUrl(mark.attrs.href) ?? "", title: mark.attrs.title, rel: "noopener noreferrer nofollow" },
      0,
    ],
  },

  code_inline: {
    excludes: "placeholder highlight",
    parseDOM: [{ tag: "code", preserveWhitespace: true }],
    toDOM: () => ["code", { class: "inline", spellcheck: "false" }],
    code: true,
  },

  strong: {
    parseDOM: [
      { tag: "b", getAttrs: (dom: HTMLElement) => (/^(normal|400)$/.test(dom.style.fontWeight) ? false : null) },
      { tag: "strong" },
      { style: "font-weight", getAttrs: (value: string) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
    ],
    toDOM: () => ["strong"],
  },

  em: {
    parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style", getAttrs: (value) => (value === "italic" ? null : false) }],
    toDOM: () => ["em"],
  },

  underline: {
    parseDOM: [{ tag: "u" }],
    toDOM: () => ["u", 0],
  },

  strikethrough: {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
    toDOM: () => ["del", 0],
  },

  highlight: {
    attrs: { color: { default: null } },
    parseDOM: [
      {
        tag: "mark",
        getAttrs: (dom: HTMLElement) => {
          const color = dom.getAttribute("data-color") || "";
          return { color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : null };
        },
      },
    ],
    // Without an explicit colour, the theme picks one (see editor.css).
    toDOM: (mark) => {
      const color = /^#[0-9a-f]{3,8}$/i.test(mark.attrs.color ?? "") ? mark.attrs.color : null;
      return ["mark", color ? { "data-color": color, style: `--highlight: ${color}` } : {}];
    },
  },

  placeholder: {
    parseDOM: [{ tag: "span.template-placeholder" }],
    toDOM: () => ["span", { class: "template-placeholder" }],
  },
};

export const schema = new Schema({ nodes, marks });
