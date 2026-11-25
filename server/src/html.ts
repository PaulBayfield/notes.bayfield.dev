// ProseMirror JSON → HTML, for public share pages and HTML exports. Plain JSON in, escaped HTML out:
// every text and attribute goes through esc(), and links only keep http(s), mailto and relative URLs.

import type { PMNode } from "./markdown.ts";

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const safeUrl = (href: unknown) => {
  const s = String(href ?? "").trim();
  return /^(https?:|mailto:|\/|#)/i.test(s) ? s : "#";
};

const MARKS: Record<string, [string, string]> = {
  strong: ["<strong>", "</strong>"],
  em: ["<em>", "</em>"],
  underline: ["<u>", "</u>"],
  strikethrough: ["<s>", "</s>"],
  code_inline: ["<code>", "</code>"],
  highlight: ['<mark>', "</mark>"],
};

function inline(nodes: PMNode[] | undefined, rewrite: (url: string) => string): string {
  let out = "";
  for (const n of nodes ?? []) {
    switch (n.type) {
      case "text": {
        let t = esc(n.text);
        for (const m of n.marks ?? []) {
          const w = MARKS[m.type];
          if (w) t = w[0] + t + w[1];
          else if (m.type === "link") t = `<a href="${esc(rewrite(safeUrl(m.attrs?.href)))}" rel="noopener nofollow">${t}</a>`;
        }
        out += t;
        break;
      }
      case "br":
        out += "<br>";
        break;
      case "emoji":
        out += `<span class="emoji">:${esc(n.attrs?.["data-name"])}:</span>`;
        break;
      case "mention":
        out += `<span class="mention">@${esc(n.attrs?.label)}</span>`;
        break;
      case "math_inline":
        out += `<code class="math">${esc(text(n))}</code>`;
        break;
      case "image": {
        const size = n.attrs?.width ? ` width="${esc(n.attrs.width)}"` : "";
        out += `<img src="${esc(rewrite(safeUrl(n.attrs?.src)))}" alt="${esc(n.attrs?.alt)}"${size} loading="lazy">`;
        break;
      }
      default:
        out += inline(n.content, rewrite);
    }
  }
  return out;
}

const text = (n: PMNode): string => (n.type === "text" ? String(n.text ?? "") : (n.content ?? []).map(text).join(""));

function blocks(nodes: PMNode[] | undefined, rewrite: (url: string) => string): string {
  return (nodes ?? []).map((n) => block(n, rewrite)).join("\n");
}

function block(n: PMNode, rewrite: (url: string) => string): string {
  const kids = () => blocks(n.content, rewrite);
  switch (n.type) {
    case "paragraph":
      return `<p>${inline(n.content, rewrite) || "<br>"}</p>`;
    case "heading": {
      const l = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)));
      return `<h${l}>${inline(n.content, rewrite)}</h${l}>`;
    }
    case "blockquote":
      return `<blockquote>${kids()}</blockquote>`;
    case "code_block":
    case "code_fence":
      return `<pre><code>${esc(text(n))}</code></pre>`;
    case "hr":
      return "<hr>";
    case "bullet_list":
      return `<ul>${kids()}</ul>`;
    case "ordered_list":
      return `<ol start="${Number(n.attrs?.order ?? 1)}">${kids()}</ol>`;
    case "list_item":
      return `<li>${kids()}</li>`;
    case "checkbox_list":
      return `<ul class="tasks">${kids()}</ul>`;
    case "checkbox_item":
      return `<li><input type="checkbox" disabled${n.attrs?.checked ? " checked" : ""}> ${kids()}</li>`;
    case "container_notice":
      return `<div class="notice notice-${esc(n.attrs?.style ?? "info")}">${kids()}</div>`;
    case "container_toggle": {
      const [summary, ...rest] = n.content ?? [];
      return `<details><summary>${summary ? inline(summary.content, rewrite) : ""}</summary>${blocks(rest, rewrite)}</details>`;
    }
    case "math_block":
      return `<pre class="math">${esc(text(n))}</pre>`;
    case "attachment":
      return `<p><a class="attachment" href="${esc(rewrite(safeUrl(n.attrs?.href)))}">${esc(n.attrs?.title)}</a></p>`;
    case "video":
      return `<video controls src="${esc(rewrite(safeUrl(n.attrs?.src)))}"></video>`;
    case "embed":
      return `<p><a href="${esc(safeUrl(n.attrs?.href))}" rel="noopener nofollow">${esc(n.attrs?.href)}</a></p>`;
    case "image":
      return `<p>${inline([n], rewrite)}</p>`;
    case "table":
      return `<table>${kids()}</table>`;
    case "tr":
      return `<tr>${kids()}</tr>`;
    case "th":
      return `<th>${kids()}</th>`;
    case "td":
      return `<td>${kids()}</td>`;
    default:
      return kids();
  }
}

/** A document's body as HTML. `rewrite` changes file URLs (a share page, an export's own folder). */
export function toHtml(doc: PMNode | null | undefined, rewrite: (url: string) => string = (u) => u): string {
  return doc ? blocks(doc.content, rewrite) : "";
}

/** A standalone page around a document's HTML (exports, share pages). */
export function page(title: string, body: string, opts: { nav?: string; lang?: string; noindex?: boolean } = {}): string {
  return `<!doctype html>
<html lang="${esc(opts.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${opts.noindex !== false ? '<meta name="robots" content="noindex">' : ""}<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--muted:#656d76;--bg:#fff;--line:#d0d7de;--code:#f6f8fa;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#8d96a0;--bg:#0d1117;--line:#30363d;--code:#161b22;--accent:#4493f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.layout{display:flex;max-width:1100px;margin:0 auto;gap:32px;padding:32px 20px}
nav{flex:0 0 220px;font-size:14px}nav ul{list-style:none;padding-left:12px;margin:0}nav>ul{padding:0}nav a{color:var(--muted);text-decoration:none;display:block;padding:2px 0}nav a.current{color:var(--fg);font-weight:600}
main{flex:1;min-width:0;max-width:760px}h1.title{font-size:2.1em;margin:0 0 .6em}
a{color:var(--accent)}img,video{max-width:100%;height:auto;border-radius:4px}pre{background:var(--code);padding:12px 14px;border-radius:6px;overflow:auto}
code{background:var(--code);padding:.1em .35em;border-radius:4px;font-size:.92em}pre code{background:none;padding:0}
blockquote{margin:0;padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}table{border-collapse:collapse;display:block;overflow:auto}
th,td{border:1px solid var(--line);padding:6px 10px;vertical-align:top}th{background:var(--code)}ul.tasks{list-style:none;padding-left:4px}
.notice{padding:10px 14px;border-radius:6px;background:var(--code);border-left:4px solid var(--accent);margin:1em 0}.notice-warning{border-color:#d29922}.notice-success,.notice-tip{border-color:#2da44e}
.mention{color:var(--accent);font-weight:500}.updated{color:var(--muted);font-size:14px;margin-top:3em}
@media (max-width:760px){.layout{display:block}nav{margin-bottom:24px}}
</style></head>
<body><div class="layout">${opts.nav ? `<nav>${opts.nav}</nav>` : ""}<main><h1 class="title">${esc(title)}</h1>
${body}</main></div></body></html>`;
}
