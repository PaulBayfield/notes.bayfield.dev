// Pasting Markdown: turns it into document nodes (headings, lists, to-dos, tables, code, links…).

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
// @ts-expect-error no types published for this small plugin
import markPlugin from "markdown-it-mark";
import { Fragment, Slice, type Mark, type Node } from "prosemirror-model";
import { schema } from "./schema";
import { languageId } from "./codeLanguages";

const { nodes, marks } = schema;

type BlockState = Parameters<Parameters<MarkdownIt["block"]["ruler"]["push"]>[1]>[0];
type InlineState = Parameters<Parameters<MarkdownIt["inline"]["ruler"]["push"]>[1]>[0];

/** Inline math: "$…$", "$$…$$" and "\(…\)". A "$" only opens before a non-space and only closes after
 * a non-space when no digit follows, so prices like "$5 and $10" stay text. */
function mathInline(state: InlineState, silent: boolean): boolean {
  const { src, pos } = state;
  const [open, close] = src.startsWith("\\(", pos) ? ["\\(", "\\)"] : src.startsWith("$$", pos) ? ["$$", "$$"] : src[pos] === "$" ? ["$", "$"] : [];
  if (!open || !close) return false;
  const from = pos + open.length;
  if (open === "$" && (!src[from] || /\s/.test(src[from]))) return false;
  let end = from;
  for (;;) {
    end = src.indexOf(close, end);
    if (end === -1 || end >= state.posMax) return false;
    const escaped = open !== "\\(" && src[end - 1] === "\\";
    const loose = open === "$" && (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? ""));
    if (!escaped && !loose) break;
    end++;
  }
  const content = src.slice(from, end).trim();
  if (!content) return false;
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = content;
    token.markup = open;
  }
  state.pos = end + close.length;
  return true;
}

/** Block math: "$$" … "$$" (on one line or several) and "\[" … "\]" each alone on its line. */
function mathBlock(state: BlockState, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const lineAt = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  const first = lineAt(startLine).trimEnd();
  const dollars = first.startsWith("$$");
  // "\[" is also an escaped bracket, so only a lone "\[" line opens a formula.
  if (!dollars && first !== "\\[") return false;
  const close = dollars ? "$$" : "\\]";
  const rest = first.slice(2);
  const body: string[] = [];
  let last = startLine;
  if (rest.includes(close)) {
    // All on one line: only when the line is just the formula; otherwise it's inline math in a paragraph.
    if (!rest.endsWith(close) || rest.indexOf(close) !== rest.length - close.length) return false;
    body.push(rest.slice(0, -close.length));
  } else {
    if (rest.trim()) body.push(rest);
    for (last = startLine + 1; ; last++) {
      if (last >= endLine) return false;
      const line = lineAt(last).trimEnd();
      if (dollars ? line.endsWith(close) : line === close) {
        body.push(line.slice(0, -close.length));
        break;
      }
      body.push(line);
    }
  }
  const content = body.join("\n").trim();
  if (!content) return false;
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = content;
  token.markup = dollars ? "$$" : "\\[";
  token.map = [startLine, last + 1];
  state.line = last + 1;
  return true;
}

const md = new MarkdownIt("commonmark", { html: false, linkify: true, breaks: true }).enable(["table", "strikethrough", "linkify"]).use(markPlugin);
md.inline.ruler.before("escape", "math_inline", mathInline);
md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });

/** Does this plain text look like Markdown (rather than ordinary prose)? */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|\|.*\|\s*$|[-*+]\s\[[ xX]\]|:::)/m.test(text) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|~~[^~\n]+~~|==[^=\n]+==/.test(text)
  );
}

const NOTICE = /^:::(info|success|tip|warning)?\s*$/;

/** Outline's ":::info … :::" notices aren't Markdown; they're cut out and parsed separately. */
function splitNotices(text: string): { style: string | null; body: string }[] {
  const parts: { style: string | null; body: string }[] = [];
  let current: { style: string | null; lines: string[] } = { style: null, lines: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(NOTICE);
    if (m && current.style === null) {
      parts.push({ style: null, body: current.lines.join("\n") });
      current = { style: m[1] || "info", lines: [] };
    } else if (line.trim() === ":::" && current.style !== null) {
      parts.push({ style: current.style, body: current.lines.join("\n") });
      current = { style: null, lines: [] };
    } else current.lines.push(line);
  }
  parts.push({ style: current.style, body: current.lines.join("\n") });
  return parts.filter((p) => p.body.trim() || p.style);
}

function inline(tokens: Token[] = []): Node[] {
  const out: Node[] = [];
  let active: readonly Mark[] = [];
  const add = (m: Mark) => (active = m.addToSet(active));
  const remove = (type: (typeof marks)[string]) => (active = type.removeFromSet(active));
  // Inside "@[Label](mention://id/type/modelId)": the label's text, then a mention node.
  let mention: { id: string; type: string; modelId: string; label: string } | null = null;
  for (const t of tokens) {
    if (mention && t.type !== "link_close") {
      if (t.type === "text" || t.type === "code_inline") mention.label += t.content;
      continue;
    }
    switch (t.type) {
      case "text":
        if (t.content) out.push(schema.text(t.content, active));
        break;
      case "softbreak":
      case "hardbreak":
        out.push(nodes.br.create());
        break;
      case "code_inline":
        if (t.content) out.push(schema.text(t.content, [...active.filter((m) => m.type !== marks.highlight), marks.code_inline.create()]));
        break;
      case "strong_open":
        add(marks.strong.create());
        break;
      case "strong_close":
        remove(marks.strong);
        break;
      case "em_open":
        add(marks.em.create());
        break;
      case "em_close":
        remove(marks.em);
        break;
      case "s_open":
        add(marks.strikethrough.create());
        break;
      case "s_close":
        remove(marks.strikethrough);
        break;
      case "mark_open":
        add(marks.highlight.create());
        break;
      case "mark_close":
        remove(marks.highlight);
        break;
      case "link_open": {
        const href = t.attrGet("href") ?? "";
        const m = /^mention:\/\/([^/]*)\/([a-z_]+)\/([^/?#]+)$/i.exec(href);
        const before = out[out.length - 1];
        if (m && before?.isText && before.text!.endsWith("@")) {
          // The "@" belongs to the mention.
          out.pop();
          if (before.text!.length > 1) out.push(schema.text(before.text!.slice(0, -1), before.marks));
          mention = { id: decodeURIComponent(m[1]), type: m[2], modelId: decodeURIComponent(m[3]), label: "" };
        } else add(marks.link.create({ href }));
        break;
      }
      case "link_close":
        if (mention) {
          out.push(nodes.mention.create({ id: mention.id || undefined, type: mention.type, modelId: mention.modelId, label: mention.label }));
          mention = null;
        } else remove(marks.link);
        break;
      case "image":
        out.push(nodes.image.create({ src: t.attrGet("src") ?? "", alt: t.content || null }));
        break;
      case "math_inline":
        out.push(nodes.math_inline.create(null, schema.text(t.content)));
        break;
    }
  }
  return out;
}

const paragraph = (content: Node[]) => nodes.paragraph.create(null, content.length ? content : undefined);

/** Parses block tokens from `i` until the matching close token; returns the nodes and next index. */
function blocks(tokens: Token[], i: number, close?: string): [Node[], number] {
  const out: Node[] = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (close && t.type === close) return [out, i + 1];
    switch (t.type) {
      case "paragraph_open": {
        // Outline writes an empty paragraph as a lone backslash.
        const content = tokens[i + 1].content === "\\" ? [] : inline(tokens[i + 1].children ?? []);
        out.push(paragraph(content));
        i += 3;
        continue;
      }
      case "heading_open": {
        const level = Math.min(4, Number(t.tag.slice(1)));
        out.push(nodes.heading.create({ level }, inline(tokens[i + 1].children ?? [])));
        i += 3;
        continue;
      }
      case "fence":
      case "code_block": {
        const text = t.content.replace(/\n$/, "");
        const language = languageId(t.info.trim().split(/\s+/)[0] ?? "");
        out.push(
          language === "math" || language === "latex"
            ? nodes.math_block.create(null, text ? schema.text(text) : undefined)
            : nodes.code_fence.create({ language }, text ? schema.text(text) : undefined),
        );
        break;
      }
      case "math_block":
        out.push(nodes.math_block.create(null, schema.text(t.content)));
        break;
      case "hr":
        out.push(nodes.hr.create({ markup: t.markup === "***" ? "***" : "---" }));
        break;
      case "blockquote_open": {
        const [inner, next] = blocks(tokens, i + 1, "blockquote_close");
        out.push(nodes.blockquote.create(null, inner.length ? inner : paragraph([])));
        i = next;
        continue;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const ordered = t.type === "ordered_list_open";
        const closeType = ordered ? "ordered_list_close" : "bullet_list_close";
        const items: Node[][] = [];
        let j = i + 1;
        while (tokens[j].type === "list_item_open") {
          const [inner, next] = blocks(tokens, j + 1, "list_item_close");
          items.push(inner.length ? inner : [paragraph([])]);
          j = next;
        }
        out.push(list(items, ordered, Number(t.attrGet("start") ?? 1)));
        i = j + 1; // skip the list close
        void closeType;
        continue;
      }
      case "table_open": {
        const rows: Node[] = [];
        let j = i + 1;
        for (; tokens[j].type !== "table_close"; j++) {
          if (tokens[j].type !== "tr_open") continue;
          const cells: Node[] = [];
          for (j++; tokens[j].type !== "tr_close"; j++) {
            const cell = tokens[j];
            if (cell.type !== "th_open" && cell.type !== "td_open") continue;
            const style = cell.attrGet("style") ?? "";
            const alignment = style.match(/text-align:(left|center|right)/)?.[1] ?? null;
            const type = cell.type === "th_open" ? nodes.th : nodes.td;
            cells.push(type.create({ alignment }, paragraph(inline(tokens[j + 1].children ?? []))));
            j += 2;
          }
          if (cells.length) rows.push(nodes.tr.create(null, cells));
        }
        if (rows.length) out.push(nodes.table.create(null, rows));
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return [out, i];
}

const TASK = /^\[([ xX])\]\s+/;

/** A list; if every item starts with "[ ]" or "[x]", a to-do list. */
function list(items: Node[][], ordered: boolean, order: number): Node {
  const firstText = (item: Node[]) => (item[0]?.type === nodes.paragraph ? item[0].textContent : "");
  const isTasks = !ordered && items.every((item) => TASK.test(firstText(item)));
  if (isTasks) {
    return nodes.checkbox_list.create(
      null,
      items.map((item) => {
        const checked = /x/i.test(firstText(item).match(TASK)![1]);
        const prefix = firstText(item).match(TASK)![0].length;
        const first = item[0];
        const stripped = nodes.paragraph.create(null, first.content.cut(prefix));
        return nodes.checkbox_item.create({ checked }, [stripped, ...item.slice(1)]);
      }),
    );
  }
  const listItems = items.map((item) => nodes.list_item.create(null, item));
  return ordered ? nodes.ordered_list.create({ order }, listItems) : nodes.bullet_list.create(null, listItems);
}

/** Markdown → a slice to paste, or null when there's nothing to paste. */
export function markdownToSlice(text: string): Slice | null {
  const content: Node[] = [];
  for (const part of splitNotices(text)) {
    const [parsed] = blocks(md.parse(part.body, {}), 0);
    if (part.style) {
      // Notices only allow some blocks; others are flattened to their text.
      const allowed = parsed.map((n) => (nodes.container_notice.contentMatch.matchType(n.type) ? n : paragraph(n.textContent ? [schema.text(n.textContent)] : [])));
      content.push(nodes.container_notice.create({ style: part.style }, allowed.length ? allowed : paragraph([])));
    } else content.push(...parsed);
  }
  if (!content.length) return null;
  try {
    const doc = nodes.doc.create(null, Fragment.from(content));
    doc.check();
    return Slice.maxOpen(doc.content);
  } catch {
    return null;
  }
}
