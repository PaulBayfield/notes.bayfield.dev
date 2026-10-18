import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { TextSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { setBlockType, toggleMark } from "prosemirror-commands";
import { addColumnAfter, addRowAfter, CellSelection, deleteColumn, deleteRow, deleteTable, isInTable } from "prosemirror-tables";
import { listCollections, listGroups, listUsers, recentlyViewed, searchTitles, type Collection, type Group, type User } from "../lib/api";
import { EntityIcon } from "../components/EntityIcon";
import { CalendarIcon, Users as UsersIcon } from "../components/icons";
import { dateLabel, dateLong, datesFor } from "./dates";
import type { StringKey, Translate } from "../lib/i18n";
import { blocks, findParent, insertBlock, isBlockActive, isMarkActive, toggleHeading, toggleList, toggleWrap } from "./commands";
import { searchEmoji } from "./emoji";
import { schema } from "./schema";
import { suggestKey, suggestKeys, type SuggestState } from "./suggest";

const { nodes, marks } = schema;

interface Item {
  key: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  /** A heading shown above the first item of each section. */
  section?: string;
  run: (view: EditorView) => void;
}

/** Collections change rarely: fetched once a minute at most for mentions. */
let collectionCache: { at: number; list: Promise<Collection[]> } | null = null;
function mentionableCollections(): Promise<Collection[]> {
  if (!collectionCache || Date.now() - collectionCache.at > 60_000) {
    const list = listCollections().catch(() => [] as Collection[]);
    collectionCache = { at: Date.now(), list };
  }
  return collectionCache.list;
}

const MENTION_LIMIT = 5;

/** Removes the "/query" text, then runs the block command on the now-empty paragraph. */
function replaceTrigger(view: EditorView, s: SuggestState) {
  view.dispatch(view.state.tr.delete(s.from, s.to));
}

interface BlockDef {
  key: string;
  label: StringKey;
  keywords: string;
  icon: string;
  run: (view: EditorView) => void;
}

function blockDefs(pickFile: (images: boolean) => void): BlockDef[] {
  const cmd = (c: (s: EditorState, d?: EditorView["dispatch"]) => boolean) => (view: EditorView) => c(view.state, view.dispatch);
  return [
    { key: "p", label: "blockText", keywords: "text paragraph texte", icon: "¶", run: cmd(setBlockType(nodes.paragraph)) },
    { key: "h1", label: "blockH1", keywords: "heading title h1 titre", icon: "H1", run: cmd(toggleHeading(1)) },
    { key: "h2", label: "blockH2", keywords: "heading subtitle h2 titre", icon: "H2", run: cmd(toggleHeading(2)) },
    { key: "h3", label: "blockH3", keywords: "heading h3 titre", icon: "H3", run: cmd(toggleHeading(3)) },
    { key: "todo", label: "blockTodo", keywords: "todo checkbox task checklist tache", icon: "☐", run: cmd(toggleList(nodes.checkbox_list, nodes.checkbox_item)) },
    { key: "ul", label: "blockBullet", keywords: "bullet list unordered liste puces", icon: "•", run: cmd(toggleList(nodes.bullet_list, nodes.list_item)) },
    { key: "ol", label: "blockOrdered", keywords: "numbered ordered list liste numerotee", icon: "1.", run: cmd(toggleList(nodes.ordered_list, nodes.list_item)) },
    { key: "quote", label: "blockQuote", keywords: "quote blockquote citation", icon: "❝", run: cmd(toggleWrap(nodes.blockquote)) },
    { key: "code", label: "blockCode", keywords: "code snippet pre", icon: "</>", run: cmd(insertBlock(blocks.codeFence())) },
    { key: "mermaid", label: "blockMermaid", keywords: "mermaid diagram flowchart chart sequence graph diagramme", icon: "◇", run: cmd(insertBlock(blocks.codeFence("mermaid"))) },
    { key: "table", label: "blockTable", keywords: "table grid tableau", icon: "⊞", run: cmd(insertBlock(blocks.table())) },
    { key: "toggle", label: "blockToggle", keywords: "toggle collapse details fold depliable", icon: "▸", run: cmd(insertBlock(blocks.toggle())) },
    { key: "info", label: "blockInfo", keywords: "notice info callout note", icon: "ℹ", run: cmd(insertBlock(blocks.notice("info"))) },
    { key: "warning", label: "blockWarning", keywords: "notice warning callout alert attention", icon: "⚠", run: cmd(insertBlock(blocks.notice("warning"))) },
    { key: "tip", label: "blockTip", keywords: "notice tip callout astuce", icon: "★", run: cmd(insertBlock(blocks.notice("tip"))) },
    { key: "success", label: "blockSuccess", keywords: "notice success callout done", icon: "✓", run: cmd(insertBlock(blocks.notice("success"))) },
    { key: "hr", label: "blockDivider", keywords: "divider rule hr separator separateur", icon: "—", run: cmd(insertBlock(blocks.hr())) },
    { key: "math", label: "blockMath", keywords: "math latex katex formula equation formule", icon: "∑", run: cmd(insertBlock(blocks.mathBlock())) },
    { key: "image", label: "blockImage", keywords: "image picture photo upload", icon: "🖼", run: () => pickFile(true) },
    { key: "file", label: "blockFile", keywords: "file attachment upload fichier piece jointe", icon: "📎", run: () => pickFile(false) },
  ];
}

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

interface SuggestProps {
  view: EditorView;
  state: EditorState;
  t: Translate;
  self: User;
  pickFile: (images: boolean) => void;
  /** Whether the image / file blocks are offered (they need a document to attach to). */
  uploads?: boolean;
}

export function SuggestMenu({ view, state, t, self, pickFile, uploads = true }: SuggestProps) {
  const s = suggestKey.getState(state);
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const trigger = s?.trigger;
  const query = s?.query ?? "";

  useEffect(() => {
    if (!trigger) return setItems([]);
    let cancelled = false;
    const done = (next: Item[]) => {
      if (cancelled) return;
      setItems(next);
      setActive(0);
    };
    if (trigger === "/") {
      const q = normalize(query);
      done(
        blockDefs(pickFile)
          .filter((b) => uploads || (b.key !== "image" && b.key !== "file"))
          .filter((b) => !q || normalize(`${t(b.label)} ${b.keywords}`).includes(q))
          .map((b) => ({
            key: b.key,
            label: t(b.label),
            icon: b.icon,
            run: (v) => {
              const current = suggestKey.getState(v.state);
              if (current) replaceTrigger(v, current);
              b.run(v);
              v.focus();
            },
          })),
      );
    } else if (trigger === ":") {
      void searchEmoji(query).then((found) =>
        done(
          found.map((e) => ({
            key: e.name,
            label: `:${e.name}:`,
            icon: e.emoji,
            run: (v) => {
              const current = suggestKey.getState(v.state);
              if (!current) return;
              v.dispatch(v.state.tr.replaceWith(current.from, current.to, nodes.emoji.create({ "data-name": e.name })).scrollIntoView());
              v.focus();
            },
          })),
        ),
      );
    } else {
      // Mentions: dates (when the query reads as one), then people, documents, groups and
      // collections, as in Outline. Debounced, these hit the server.
      const timer = setTimeout(async () => {
        const q = normalize(query);
        const [users, docs, groups, collections] = await Promise.all([
          listUsers(query, MENTION_LIMIT).catch(() => [] as User[]),
          (query ? searchTitles(query, MENTION_LIMIT) : recentlyViewed(MENTION_LIMIT)).catch(() => []),
          listGroups(query, 3).catch(() => [] as Group[]),
          mentionableCollections().then((list) => list.filter((c) => !q || normalize(c.name).includes(q)).slice(0, 3)),
        ]);
        const mention = (attrs: Record<string, unknown>) => (v: EditorView) => {
          const current = suggestKey.getState(v.state);
          if (!current) return;
          const node = nodes.mention.create({ ...attrs, actorId: self.id, id: crypto.randomUUID() });
          const tr = v.state.tr.replaceWith(current.from, current.to, [node, schema.text(" ")]);
          v.dispatch(tr.scrollIntoView());
          v.focus();
        };
        const lang = document.documentElement.lang;
        done([
          ...datesFor(query).map((iso, i) => ({
            key: `t${iso}`,
            label: dateLabel(iso, lang),
            hint: dateLong(iso, lang),
            section: i === 0 ? t("mentionDates") : undefined,
            icon: <CalendarIcon size={15} />,
            // Outline stores the day in both: the label is worked out when shown.
            run: mention({ type: "date", label: iso, modelId: iso }),
          })),
          ...users.map((u, i) => ({
            key: `u${u.id}`,
            label: u.name,
            section: i === 0 ? t("mentionPeople") : undefined,
            icon: <span className="menu-avatar" style={{ background: u.color }}>{u.name.charAt(0).toUpperCase()}</span>,
            run: mention({ type: "user", label: u.name, modelId: u.id }),
          })),
          ...docs.map((d, i) => ({
            key: `d${d.id}`,
            label: d.title || t("untitled"),
            section: i === 0 ? t("documents") : undefined,
            icon: <EntityIcon icon={d.icon} color={d.color} size={16} fallback="📄" />,
            run: mention({ type: "document", label: d.title || t("untitled"), modelId: d.id }),
          })),
          ...groups.map((g, i) => ({
            key: `g${g.id}`,
            label: g.name,
            hint: g.memberCount === 1 ? t("groupMember") : t("groupMembers", { count: g.memberCount }),
            section: i === 0 ? t("groups") : undefined,
            icon: <UsersIcon size={15} />,
            run: mention({ type: "group", label: g.name, modelId: g.id }),
          })),
          ...collections.map((c, i) => ({
            key: `c${c.id}`,
            label: c.name,
            section: i === 0 ? t("collections") : undefined,
            icon: <EntityIcon icon={c.icon} color={c.color} size={16} fallback={<span className="collection-dot" style={{ ["--c" as string]: c.color ?? "var(--primary)" }} />} />,
            run: mention({ type: "collection", label: c.name, modelId: c.id }),
          })),
        ]);
      }, 150);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    return () => {
      cancelled = true;
    };
    // pickFile/self are stable for the editor's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, query, t]);

  // While open, the menu gets first pick of the navigation keys.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!trigger) return;
    suggestKeys.current = (e) => {
      const list = itemsRef.current;
      if (!list.length) return false;
      if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) setActive((i) => (i + 1) % list.length);
      else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) setActive((i) => (i - 1 + list.length) % list.length);
      else if (e.key === "Enter" || e.key === "Tab") list[activeRef.current]?.run(view);
      else return false;
      return true;
    };
    return () => {
      suggestKeys.current = null;
    };
  }, [trigger, view]);

  useEffect(() => {
    listRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!s || !items.length) return null;
  const coords = view.coordsAtPos(s.from);
  const below = coords.bottom + 320 < window.innerHeight;
  return (
    <div
      className="editor-menu suggest-menu"
      ref={listRef}
      style={{
        left: Math.min(coords.left, window.innerWidth - 280),
        ...(below ? { top: coords.bottom + 6 } : { bottom: window.innerHeight - coords.top + 6 }),
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {item.section && <div className="menu-section">{item.section}</div>}
          <button className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => item.run(view)}>
            <span className="menu-icon">{item.icon}</span>
            <span className="menu-text">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

// ---------- Selection toolbar ----------

function linkAt(state: EditorState): { href: string; from: number; to: number } | null {
  const { $from, empty } = state.selection;
  const mark = marks.link.isInSet(empty ? $from.marks() : state.doc.resolve(state.selection.from + 1).marks());
  if (!mark) return null;
  // Expand to the whole link.
  const parent = $from.parent;
  const start = $from.start();
  let from = -1;
  let to = -1;
  parent.forEach((child, offset) => {
    const pos = start + offset;
    const has = child.marks.some((m) => m.eq(mark));
    if (has && from < 0 && pos <= $from.pos) from = pos;
    if (!has && from >= 0 && pos < $from.pos) from = -1;
    if (has && from >= 0 && (to < 0 || to === pos)) to = pos + child.nodeSize;
  });
  return from >= 0 ? { href: mark.attrs.href, from, to } : null;
}

interface BubbleProps {
  view: EditorView;
  state: EditorState;
  t: Translate;
  openLink: (href: string) => void;
  /** Absent where comments aren't possible (collection overviews). */
  onComment?: () => void;
}

export function BubbleMenu({ view, state, t, openLink, onComment }: BubbleProps) {
  const [editingLink, setEditingLink] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { selection } = state;
  const inCode = selection.$from.parent.type.spec.code;
  const textSelected = !selection.empty && (selection instanceof TextSelection || selection instanceof CellSelection);
  const link = linkAt(state);
  // While editing a link, focus is in the link field rather than the editor.
  const show = view.editable && !inCode && (editingLink !== null || ((textSelected || !!link) && view.hasFocus()));
  const inTable = isInTable(state);

  useEffect(() => setEditingLink(null), [selection.from, selection.to]);
  const linkHref = link?.href ?? "";
  useEffect(() => {
    // Synchronously, so the field has focus before the next keystroke arrives.
    const onEdit = () => flushSync(() => setEditingLink(linkHref));
    window.addEventListener(LINK_EVENT, onEdit);
    return () => window.removeEventListener(LINK_EVENT, onEdit);
  }, [linkHref]);

  useLayoutEffect(() => {
    if (!show) return setPos(null);
    const start = view.coordsAtPos(selection.from);
    const end = view.coordsAtPos(selection.to);
    const width = ref.current?.offsetWidth ?? 300;
    const center = (start.left + end.right) / 2;
    const top = start.top - 44 < 8 ? end.bottom + 8 : start.top - 44;
    setPos({ left: Math.max(8, Math.min(center - width / 2, window.innerWidth - width - 8)), top });
  }, [show, selection.from, selection.to, view, editingLink, state]);

  if (!show) return null;

  const run = (cmd: (s: EditorState, d?: EditorView["dispatch"]) => boolean) => () => {
    cmd(view.state, view.dispatch);
    view.focus();
  };
  const markButton = (label: string, title: string, type: (typeof marks)[keyof typeof marks]) => (
    <button className={isMarkActive(state, type) ? "active" : ""} title={title} onClick={run(toggleMark(type))}>
      {label}
    </button>
  );

  const applyLink = (href: string) => {
    const { from, to } = link && selection.empty ? link : view.state.selection;
    let tr = view.state.tr.removeMark(from, to, marks.link);
    if (href.trim()) {
      const value = /^([a-z]+:|\/|#)/i.test(href.trim()) ? href.trim() : `https://${href.trim()}`;
      tr = tr.addMark(from, to, marks.link.create({ href: value }));
    }
    view.dispatch(tr);
    setEditingLink(null);
    view.focus();
  };

  return (
    <div className="editor-menu bubble-menu" ref={ref} style={pos ?? { visibility: "hidden" }} onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      {editingLink !== null ? (
        <input
          autoFocus
          className="link-input"
          placeholder={t("linkPlaceholder")}
          defaultValue={editingLink}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyLink(e.currentTarget.value);
            } else if (e.key === "Escape") {
              setEditingLink(null);
              view.focus();
            }
          }}
        />
      ) : !textSelected && link ? (
        <>
          <span className="link-preview" title={link.href}>
            {link.href}
          </span>
          <button title={t("openLink")} onClick={() => openLink(link.href)}>
            ↗
          </button>
          <button title={t("editLink")} onClick={() => setEditingLink(link.href)}>
            ✎
          </button>
          <button title={t("removeLink")} onClick={() => applyLink("")}>
            ✕
          </button>
        </>
      ) : (
        <>
          {markButton("B", `${t("bold")} (Ctrl+B)`, marks.strong)}
          {markButton("I", `${t("italic")} (Ctrl+I)`, marks.em)}
          {markButton("U", `${t("underline")} (Ctrl+U)`, marks.underline)}
          {markButton("S", `${t("strikethrough")} (Ctrl+D)`, marks.strikethrough)}
          {markButton("</>", `${t("inlineCode")} (Ctrl+E)`, marks.code_inline)}
          {markButton("H", `${t("highlight")} (Ctrl+Shift+H)`, marks.highlight)}
          <button className={link ? "active" : ""} title={`${t("link")} (Ctrl+K)`} onClick={() => setEditingLink(link?.href ?? "")}>
            🔗
          </button>
          {textSelected && onComment && (
            <button title={`${t("comment")} (Ctrl+Alt+M)`} onClick={onComment}>
              💬
            </button>
          )}
          <span className="menu-sep" />
          {inTable ? (
            <>
              <button title={t("addRow")} onClick={run(addRowAfter)}>
                +▭
              </button>
              <button title={t("addColumn")} onClick={run(addColumnAfter)}>
                +▯
              </button>
              <button title={t("deleteRow")} onClick={run(deleteRow)}>
                −▭
              </button>
              <button title={t("deleteColumn")} onClick={run(deleteColumn)}>
                −▯
              </button>
              <button title={t("deleteTable")} onClick={run(deleteTable)}>
                ✕⊞
              </button>
            </>
          ) : (
            <>
              <button className={isBlockActive(state, nodes.heading, { level: 1 }) ? "active" : ""} title={t("blockH1")} onClick={run(toggleHeading(1))}>
                H1
              </button>
              <button className={isBlockActive(state, nodes.heading, { level: 2 }) ? "active" : ""} title={t("blockH2")} onClick={run(toggleHeading(2))}>
                H2
              </button>
              <button className={findParent(state, nodes.blockquote) ? "active" : ""} title={t("blockQuote")} onClick={run(toggleWrap(nodes.blockquote))}>
                ❝
              </button>
              <button className={findParent(state, nodes.checkbox_list) ? "active" : ""} title={t("blockTodo")} onClick={run(toggleList(nodes.checkbox_list, nodes.checkbox_item))}>
                ☐
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Ctrl+K with a selection opens the link editor; exported so the editor can bind it. */
export const LINK_EVENT = "notes:edit-link";
