// ProseMirror JSON → Markdown, in Outline's flavour: what documents.info answers as `text`, what search
// indexes and what exports write. Works on plain JSON, so it needs no schema.
//
// Outline's conventions: an empty paragraph is a lone backslash (so blank lines survive), notices are
// ":::style … :::", task lists "- [ ]" / "- [x]", mentions "@[Name](mention://id/type/modelId)", an
// attachment "[name size](url)", highlights "==text==", math "$…$" and "$$ … $$".

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** Characters that would start Markdown syntax in plain text. */
function escape(text: string): string {
  return text.replace(/([\\`*_~[\]#|<>])/g, "\\$1").replace(/^(\s*)([-+]|\d+\.)(\s)/gm, "$1\\$2$3");
}

function bytes(n: number): string {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[i]}`;
}

const MARK_WRAP: Record<string, [string, string]> = {
  strong: ["**", "**"],
  em: ["*", "*"],
  underline: ["__", "__"],
  strikethrough: ["~~", "~~"],
  highlight: ["==", "=="],
};

/** Inline content: text with its marks, mentions, emoji, images, inline math. */
function inline(nodes: PMNode[] | undefined): string {
  let out = "";
  for (const n of nodes ?? []) {
    switch (n.type) {
      case "text": {
        const marks = n.marks ?? [];
        const code = marks.some((m) => m.type === "code_inline");
        let t = code ? `\`${str(n.text)}\`` : escape(str(n.text));
        for (const m of marks) {
          const wrap = MARK_WRAP[m.type];
          if (wrap) t = `${wrap[0]}${t}${wrap[1]}`;
        }
        const link = marks.find((m) => m.type === "link");
        if (link) t = `[${t}](${str(link.attrs?.href)}${link.attrs?.title ? ` "${str(link.attrs.title)}"` : ""})`;
        out += t;
        break;
      }
      case "br":
        out += "\\\n";
        break;
      case "emoji":
        out += `:${str(n.attrs?.["data-name"])}:`;
        break;
      case "mention":
        out += `@[${str(n.attrs?.label)}](mention://${str(n.attrs?.id)}/${str(n.attrs?.type)}/${str(n.attrs?.modelId)})`;
        break;
      case "math_inline":
        out += `$${plain(n)}$`;
        break;
      case "image": {
        const size = n.attrs?.width && n.attrs?.height ? ` =${n.attrs.width}x${n.attrs.height}` : "";
        const title = n.attrs?.title ? ` "${str(n.attrs.title)}"` : "";
        out += `![${escape(str(n.attrs?.alt))}](${str(n.attrs?.src)}${size}${title})`;
        break;
      }
      default:
        out += inline(n.content);
    }
  }
  return out;
}

/** A node's text, without any syntax. */
export function plain(n: PMNode): string {
  if (n.type === "text") return str(n.text);
  return (n.content ?? []).map(plain).join("");
}

const indent = (text: string, prefix: string, first = prefix) =>
  text
    .split("\n")
    .map((line, i) => (i === 0 ? first : line ? prefix : prefix.trimEnd()) + line)
    .join("\n");

/** Block content, each block separated by a blank line. */
function blocks(nodes: PMNode[] | undefined, tight = false): string {
  return (nodes ?? [])
    .map(block)
    .filter((b) => b !== null)
    .join(tight ? "\n" : "\n\n");
}

function list(n: PMNode, marker: (i: number, item: PMNode) => string): string {
  return (n.content ?? [])
    .map((item, i) => {
      const m = marker(i, item);
      return indent(blocks(item.content, true) || "", " ".repeat(m.length), m);
    })
    .join("\n");
}

function block(n: PMNode): string {
  switch (n.type) {
    case "paragraph": {
      const text = inline(n.content);
      return text.trim() ? text : "\\";
    }
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))))} ${inline(n.content)}`;
    case "blockquote":
      return indent(blocks(n.content), "> ");
    case "code_block":
    case "code_fence": {
      const lang = str(n.attrs?.language);
      return `\`\`\`${lang === "none" ? "" : lang}\n${plain(n)}\n\`\`\``;
    }
    case "hr":
      return str(n.attrs?.markup) || "---";
    case "bullet_list":
      return list(n, () => "- ");
    case "ordered_list": {
      const start = Number(n.attrs?.order ?? 1);
      return list(n, (i) => `${start + i}. `);
    }
    case "checkbox_list":
      return list(n, (_, item) => (item.attrs?.checked ? "- [x] " : "- [ ] "));
    case "container_notice":
      return `:::${str(n.attrs?.style) || "info"}\n${blocks(n.content)}\n:::`;
    case "container_toggle":
      return blocks(n.content);
    case "math_block":
      return `$$\n${plain(n)}\n$$`;
    case "attachment": {
      const size = bytes(Number(n.attrs?.size ?? 0));
      return `[${escape(str(n.attrs?.title))}${size ? ` ${size}` : ""}](${str(n.attrs?.href)})`;
    }
    case "video":
      return `[${escape(str(n.attrs?.title) || str(n.attrs?.src))}](${str(n.attrs?.src)})`;
    case "embed":
      return `[${str(n.attrs?.href)}](${str(n.attrs?.href)})`;
    case "image":
      return inline([n]);
    case "table":
      return table(n);
    default:
      return n.content ? blocks(n.content) : "";
  }
}

function table(n: PMNode): string {
  const rows = (n.content ?? []).map((tr) => (tr.content ?? []).map((cell) => (cell.content ?? []).map((b) => inline(b.content)).join(" ").replace(/\|/g, "\\|").replace(/\n/g, " ")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const align = (n.content?.[0]?.content ?? []).map((cell) => {
    const a = cell.attrs?.alignment;
    return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
  });
  return [line(rows[0]), `| ${Array.from({ length: width }, (_, i) => align[i] ?? "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

/** A document's body as Markdown (the title isn't part of it, as in Outline). */
export function toMarkdown(doc: PMNode | null | undefined): string {
  if (!doc) return "";
  return blocks(doc.content).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Checklist progress: Outline's `tasks` on a document. */
export function countTasks(doc: PMNode | null | undefined): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  const walk = (n: PMNode) => {
    if (n.type === "checkbox_item") {
      total++;
      if (n.attrs?.checked) completed++;
    }
    n.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return { completed, total };
}
