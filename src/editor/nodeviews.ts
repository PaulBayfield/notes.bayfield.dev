// Interactive renderings of nodes: checkboxes, images through the API proxy, code blocks with a
// language picker, toggles, mentions, embeds, attachments.

import type { Node } from "prosemirror-model";
import type { EditorView, NodeView, NodeViewConstructor } from "prosemirror-view";
import { createMathView } from "@benrbray/prosemirror-math";
import { resolveUrl } from "../lib/api";
import { emojiFor, emojiLoaded, loadEmoji } from "./emoji";
import { CODE_LANGUAGES } from "./codeLanguages";
import { dateLabel, dateLong, PICK_DATE_EVENT, withDay, type PickDateRequest } from "./dates";
import { pickableLanguages } from "./highlight";
import { isMermaid, onThemeChange, renderMermaid } from "./mermaid";
import { TextSelection } from "prosemirror-state";

export interface NodeViewHooks {
  /** Opens a link: internal documents in the app, the rest in the browser. */
  openLink: (href: string) => void;
  openDocument: (id: string) => void;
  /** Toggle state survives re-renders (it's local, not stored in the document). */
  foldedToggles: Set<string>;
  /** Show embeds (videos, designs…) inline rather than as link cards. */
  embeds: boolean;
}

/** Iframe URL for links from well-known services, like Outline's embeds. */
export function embedUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;
  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = url.searchParams.get("v") ?? path.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1];
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === "youtu.be") return `https://www.youtube-nocookie.com/embed${path}`;
  if (host === "vimeo.com") {
    const id = path.match(/^\/(\d+)/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  if (host === "loom.com") {
    const id = path.match(/^\/(?:share|embed)\/([\w]+)/)?.[1];
    return id ? `https://www.loom.com/embed/${id}` : null;
  }
  if (host === "figma.com") return `https://www.figma.com/embed?embed_host=notes&url=${encodeURIComponent(href)}`;
  if (host === "docs.google.com" && /^\/(document|spreadsheets|presentation)\//.test(path)) return href.replace(/\/(edit|view)([?#].*)?$/, "/preview");
  if (host === "open.spotify.com") return `https://open.spotify.com/embed${path}`;
  if (host === "codepen.io") return href.replace("/pen/", "/embed/");
  if (host === "miro.com" && path.startsWith("/app/board/")) return `https://miro.com/app/live-embed/${path.split("/")[3]}/`;
  return null;
}

type GetPos = () => number | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | HTMLElement)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(typeof c === "string" ? c : (c as HTMLElement));
  return e;
}


class CodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private select: HTMLSelectElement;
  /** Mermaid blocks: the drawn diagram, shown instead of the source unless it's being edited. */
  private diagram: HTMLElement | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private rendered = "";
  private stopTheme: (() => void) | null = null;
  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: GetPos,
  ) {
    this.select = el("select", { class: "code-language", "aria-label": "Language" });
    this.select.contentEditable = "false";
    this.fillLanguages(node.attrs.language);
    this.select.addEventListener("change", () => {
      const pos = this.getPos();
      if (pos === undefined) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language: this.select.value }));
    });
    this.select.disabled = !view.editable;
    const code = el("code", { spellcheck: "false" });
    this.contentDOM = code;
    const header = el("div", { class: "code-header", contenteditable: "false" }, this.select);
    this.dom = el("div", { class: "code-block" }, header, el("pre", {}, code));
    this.sync(node);
  }

  /** Draws (or redraws) the diagram, shortly after typing pauses. */
  private scheduleDiagram(immediate = false) {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.drawDiagram(), immediate ? 0 : 400);
  }

  private async drawDiagram() {
    const diagram = this.diagram;
    if (!diagram) return;
    const source = this.node.textContent;
    if (!source.trim()) {
      diagram.replaceChildren(el("span", { class: "mermaid-empty" }, "Mermaid"));
      return;
    }
    try {
      const svg = await renderMermaid(source);
      if (this.diagram !== diagram) return;
      diagram.innerHTML = svg;
      diagram.classList.remove("error");
      this.rendered = source;
    } catch (e) {
      if (this.diagram !== diagram) return;
      diagram.classList.add("error");
      diagram.replaceChildren(el("span", { class: "mermaid-error" }, String((e as Error)?.message ?? e).split("\n").slice(0, 4).join("\n")));
    }
  }

  private syncDiagram(node: Node) {
    const mermaid = isMermaid(node.attrs.language);
    this.dom.classList.toggle("mermaid-block", mermaid);
    if (mermaid && !this.diagram) {
      this.diagram = el("div", { class: "mermaid-diagram", contenteditable: "false" });
      // Clicking the diagram edits its source.
      this.diagram.addEventListener("mousedown", (e) => {
        const pos = this.getPos();
        if (pos === undefined || !this.view.editable) return;
        e.preventDefault();
        this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1 + this.node.content.size)));
        this.view.focus();
      });
      this.dom.append(this.diagram);
      this.stopTheme = onThemeChange(() => this.scheduleDiagram(true));
      this.scheduleDiagram(true);
    } else if (!mermaid && this.diagram) {
      this.diagram.remove();
      this.diagram = null;
      this.stopTheme?.();
      this.stopTheme = null;
    } else if (mermaid && node.textContent !== this.rendered) this.scheduleDiagram();
  }

  destroy() {
    clearTimeout(this.renderTimer);
    this.stopTheme?.();
  }
  private fillLanguages(current: string | null) {
    this.select.replaceChildren();
    const value = current || "none";
    const known = pickableLanguages.some((l) => l.id === value) || !!CODE_LANGUAGES[value];
    const options = known ? pickableLanguages : [...pickableLanguages, { id: value, label: value }];
    for (const { id, label } of options) this.select.append(el("option", { value: id }, label));
    // An alias (e.g. "mermaidjs") shows as its visible twin.
    if (!pickableLanguages.some((l) => l.id === value) && CODE_LANGUAGES[value]) this.select.append(el("option", { value }, CODE_LANGUAGES[value].label));
    this.select.value = value;
  }
  private sync(node: Node) {
    this.dom.classList.toggle("wrap", !!node.attrs.wrap);
    this.dom.dataset.language = node.attrs.language ?? "";
    if (this.select.value !== (node.attrs.language || "none")) this.fillLanguages(node.attrs.language);
    this.syncDiagram(node);
  }
  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync(node);
    return true;
  }
  stopEvent(e: Event) {
    return e.target === this.select || (!!this.diagram && this.diagram.contains(e.target as globalThis.Node) && e.type !== "mousedown");
  }
  ignoreMutation(m: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    return m.type !== "selection" && !this.contentDOM.contains(m.target);
  }
}

class CheckboxView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private box: HTMLElement;
  constructor(
    private node: Node,
    view: EditorView,
    getPos: GetPos,
  ) {
    this.box = el("span", { class: "checkbox", role: "checkbox", contenteditable: "false", tabindex: "-1" });
    this.box.addEventListener("mousedown", (e) => e.preventDefault());
    this.box.addEventListener("click", () => {
      const pos = getPos();
      if (pos === undefined || !view.editable) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, checked: !this.node.attrs.checked }));
    });
    this.contentDOM = el("div", { class: "checkbox-content" });
    this.dom = el("li", { "data-type": "checkbox_item" }, this.box, this.contentDOM);
    this.sync();
  }
  private sync() {
    const checked = !!this.node.attrs.checked;
    this.dom.classList.toggle("checked", checked);
    this.box.setAttribute("aria-checked", String(checked));
  }
  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }
  ignoreMutation(m: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    return m.type !== "selection" && !this.contentDOM.contains(m.target);
  }
}

class ToggleView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  constructor(
    private node: Node,
    private hooks: NodeViewHooks,
  ) {
    const button = el("button", { class: "toggle-button", contenteditable: "false", "aria-label": "Toggle", tabindex: "-1" });
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      const id = this.key();
      if (this.hooks.foldedToggles.has(id)) this.hooks.foldedToggles.delete(id);
      else this.hooks.foldedToggles.add(id);
      this.sync();
    });
    this.contentDOM = el("div", { class: "toggle-content" });
    this.dom = el("div", { class: "toggle-block" }, button, this.contentDOM);
    this.sync();
  }
  private key() {
    return String(this.node.attrs.id ?? "");
  }
  private sync() {
    this.dom.classList.toggle("folded", this.hooks.foldedToggles.has(this.key()));
  }
  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }
  ignoreMutation(m: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    return m.type !== "selection" && !this.contentDOM.contains(m.target);
  }
}

function imageView(node: Node): NodeView {
  const img = el("img", { src: resolveUrl(node.attrs.src), alt: node.attrs.alt ?? "", draggable: "false", loading: "lazy" });
  const layout = node.attrs.layoutClass as string | null;
  const width = Number(node.attrs.width) || 0;
  // Small inline images (icons) sit in the text; the rest are blocks with an optional caption.
  const inline = layout === "inline" || (width > 0 && width <= 40);
  if (width && !inline) img.style.width = `${width}px`;
  if (width && inline) img.style.height = "1.2em";
  const dom = el("span", { class: `image${inline ? " inline" : ""}${layout ? ` image-${layout}` : ""}`, contenteditable: "false" }, img);
  if (node.attrs.alt && !inline) dom.append(el("span", { class: "image-caption" }, node.attrs.alt));
  return { dom, ignoreMutation: () => true };
}

function emojiView(node: Node): NodeView {
  const dom = el("span", { class: "emoji", "data-name": node.attrs["data-name"] }, emojiFor(node.attrs["data-name"]));
  if (!emojiLoaded()) void loadEmoji().then(() => (dom.textContent = emojiFor(node.attrs["data-name"])));
  return { dom, ignoreMutation: () => true };
}

function formatSize(bytes: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function attachmentView(node: Node, hooks: NodeViewHooks): NodeView {
  const dom = el(
    "div",
    { class: "attachment-card", contenteditable: "false" },
    el("span", { class: "attachment-icon" }, "📎"),
    el("span", { class: "attachment-title" }, String(node.attrs.title ?? "File")),
    el("span", { class: "attachment-size" }, formatSize(Number(node.attrs.size))),
  );
  dom.addEventListener("dblclick", () => node.attrs.href && hooks.openLink(node.attrs.href));
  dom.title = "Double-click to open";
  return { dom, ignoreMutation: () => true };
}

function embedView(node: Node, hooks: NodeViewHooks): NodeView {
  const href = String(node.attrs.href ?? "");
  const src = hooks.embeds ? embedUrl(href) : null;
  if (src) {
    const iframe = el("iframe", { src, allowfullscreen: "true", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", loading: "lazy", referrerpolicy: "strict-origin-when-cross-origin" });
    if (node.attrs.height) iframe.style.height = `${node.attrs.height}px`;
    return { dom: el("div", { class: "embed-frame", contenteditable: "false" }, iframe), ignoreMutation: () => true };
  }
  let host = href;
  try {
    host = new URL(href).hostname.replace(/^www\./, "");
  } catch {
    // Not a URL; show as is.
  }
  const dom = el(
    "div",
    { class: "embed-card", contenteditable: "false" },
    el("span", { class: "embed-host" }, host),
    el("span", { class: "embed-href" }, href),
  );
  dom.addEventListener("dblclick", () => hooks.openLink(href));
  dom.title = "Double-click to open";
  return { dom, ignoreMutation: () => true };
}

function videoView(node: Node): NodeView {
  const video = el("video", { src: resolveUrl(node.attrs.src), controls: "", preload: "metadata" });
  if (node.attrs.width) video.style.maxWidth = `${node.attrs.width}px`;
  return { dom: el("div", { class: "video", contenteditable: "false" }, video), ignoreMutation: () => true };
}

/** Asks the app to open a collection (mentions of collections link to it). */
export const OPEN_COLLECTION_EVENT = "notes:open-collection";

const SVG_NS = "http://www.w3.org/2000/svg";

function calendarIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "aria-hidden": "true" }))
    svg.setAttribute(k, v);
  svg.innerHTML = '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>';
  return svg;
}

/**
 * A date mention: a badge reading "Today", "Tomorrow", "Fri 23 Oct"… Clicking it opens a date
 * picker (the browser's own, anchored to the badge) to change the day.
 */
function dateMentionView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
  const iso = String(node.attrs.modelId ?? "");
  const lang = document.documentElement.lang;
  const dom = el("span", { class: "mention mention-date", contenteditable: "false", title: dateLong(iso, lang) }, calendarIcon() as Element as HTMLElement, el("span", {}, dateLabel(iso, lang)));
  dom.addEventListener("mousedown", (e) => {
    if (!view.editable) return;
    e.preventDefault();
    dom.classList.add("open");
    const request: PickDateRequest = {
      anchor: dom,
      value: iso.slice(0, 10),
      onPick: (day) => {
        const pos = getPos();
        const next = withDay(iso, day);
        if (pos !== undefined && next !== iso) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, modelId: next, label: next }));
        view.focus();
      },
      onClose: () => dom.classList.remove("open"),
    };
    window.dispatchEvent(new CustomEvent(PICK_DATE_EVENT, { detail: request }));
  });
  return { dom, ignoreMutation: () => true };
}

function mentionView(node: Node, view: EditorView, getPos: () => number | undefined, hooks: NodeViewHooks): NodeView {
  const type = node.attrs.type as string;
  if (type === "date") return dateMentionView(node, view, getPos);
  const label = type === "user" ? `@${node.attrs.label}` : String(node.attrs.label ?? "");
  const dom = el("span", { class: `mention mention-${type}`, contenteditable: "false" }, label);
  if (type === "document") {
    dom.addEventListener("click", () => hooks.openDocument(node.attrs.modelId));
  } else if (type === "collection") {
    dom.addEventListener("click", () => window.dispatchEvent(new CustomEvent(OPEN_COLLECTION_EVENT, { detail: node.attrs.modelId })));
  } else if (node.attrs.href) {
    dom.addEventListener("click", () => hooks.openLink(node.attrs.href));
  }
  return { dom, ignoreMutation: () => true };
}

export function nodeViews(hooks: NodeViewHooks): Record<string, NodeViewConstructor> {
  return {
    code_fence: (node, view, getPos) => new CodeView(node, view, getPos),
    code_block: (node, view, getPos) => new CodeView(node, view, getPos),
    checkbox_item: (node, view, getPos) => new CheckboxView(node, view, getPos),
    container_toggle: (node) => new ToggleView(node, hooks),
    image: (node) => imageView(node),
    emoji: (node) => emojiView(node),
    attachment: (node) => attachmentView(node, hooks),
    embed: (node) => embedView(node, hooks),
    video: (node) => videoView(node),
    mention: (node, view, getPos) => mentionView(node, view, getPos, hooks),
    math_inline: (node, view, getPos) => createMathView(false)(node, view, getPos as () => number) as unknown as NodeView,
    math_block: (node, view, getPos) => createMathView(true)(node, view, getPos as () => number) as unknown as NodeView,
  };
}
