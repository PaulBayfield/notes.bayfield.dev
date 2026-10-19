import { useEffect, useRef, useState, type RefObject } from "react";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing } from "prosemirror-tables";
import { mathPlugin } from "@benrbray/prosemirror-math";
import { ySyncPlugin, yCursorPlugin, yUndoPlugin } from "y-prosemirror";
import { docIdFromHref, uploadAttachment, uploadAttachmentFromPath, webUrl, type Attachment, type User } from "../lib/api";
import type { Translate } from "../lib/i18n";
import { isTauri, openExternal, pickFiles } from "../lib/platform";
import { connect, presence, unknownTypes, type CollabStatus, type PresenceUser } from "./collab";
import { BubbleMenu, LINK_EVENT, PasteMenu, SuggestMenu } from "./menus";
import { pasteMenuPlugin, pasteUrl } from "./paste";
import { BlockHandle } from "./blockHandle";
import { nodeViews } from "./nodeviews";
import { editorKeymaps } from "./rules";
import { schema } from "./schema";
import { suggestPlugin } from "./suggest";
import { highlightPlugin } from "./highlight";
import { startComment } from "./comments";
import { findPlugin } from "./find";
import { mermaidEditingPlugin } from "./mermaid";
import { headingPrefixPlugin, setHeadingPrefix, type HeadingPrefixStyle } from "./headingPrefix";
import { looksLikeMarkdown, markdownToSlice } from "./markdown";
import "katex/dist/katex.min.css";
import "@benrbray/prosemirror-math/dist/prosemirror-math.css";

export interface Heading {
  level: number;
  text: string;
  pos: number;
}

export type EditorStatus = CollabStatus | "loading" | "unsupported";

interface Props {
  docId: string;
  /** The document's path ("/doc/…"), for links to its headings. */
  docUrl?: string;
  server: string;
  token: string;
  user: User;
  editable: boolean;
  spellcheck: boolean;
  /** Show embeds inline (read when the editor is created). */
  embeds: boolean;
  headingPrefix: HeadingPrefixStyle;
  t: Translate;
  refreshToken: () => Promise<string | undefined>;
  onOpenDocument: (id: string) => void;
  onStatus: (status: EditorStatus, detail?: string) => void;
  onPresence: (users: PresenceUser[]) => void;
  onHeadings: (headings: Heading[]) => void;
  onError: (e: unknown) => void;
  /** A draft comment was added over the selection. */
  onStartComment: (id: string) => void;
  /** Commented text was clicked. */
  onCommentClick: (id: string) => void;
  viewRef: RefObject<EditorView | null>;
}

export function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { doc, selection } = state;
        const decos: Decoration[] = [];
        const onlyEmpty = doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0;
        const $from = selection.$from;
        if (onlyEmpty) decos.push(Decoration.node(0, doc.firstChild!.nodeSize, { class: "is-empty", "data-placeholder": text }));
        else if (selection.empty && $from.parent.type === schema.nodes.paragraph && $from.parent.content.size === 0 && $from.depth > 0) {
          const pos = $from.before();
          decos.push(Decoration.node(pos, pos + $from.parent.nodeSize, { class: "is-empty", "data-placeholder": text }));
        }
        return DecorationSet.create(doc, decos);
      },
    },
  });
}

function headingsOf(state: EditorState): Heading[] {
  const out: Heading[] = [];
  state.doc.forEach((node, pos) => {
    if (node.type === schema.nodes.heading && node.textContent.trim()) out.push({ level: node.attrs.level, text: node.textContent, pos });
  });
  return out;
}

/** A file to attach: pasted or dropped (a File), or picked on desktop (a path). */
type Upload = () => Promise<Attachment>;

/** Positions kept up to date through every transaction (local or remote), for async inserts. */
interface Tracked {
  pos: number;
}

export function Editor(props: Props) {
  const { docId, viewRef } = props;
  const mountRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<(files: Upload[]) => void>(() => {});

  useEffect(() => {
    let destroyed = false;
    let editorView: EditorView | null = null;
    const tracked = new Set<Tracked>();
    const p = () => propsRef.current;
    p().onStatus("loading");

    const collab = connect({
      server: p().server,
      documentId: docId,
      token: p().token,
      refreshToken: () => p().refreshToken(),
      onStatus: (s) => !destroyed && p().onStatus(s),
    });
    const { provider, fragment } = collab;
    provider.setAwarenessField("user", { id: p().user.id, name: p().user.name, color: p().user.color });
    const onAwareness = () => !destroyed && p().onPresence(presence(provider, p().user.id));
    provider.on("awarenessChange", onAwareness);

    const openLink = (href: string) => {
      const id = docIdFromHref(href);
      if (id) p().onOpenDocument(id);
      else if (href.startsWith("/")) void openExternal(webUrl(href));
      else if (!href.startsWith("#")) void openExternal(href);
    };

    const fromFiles = (files: File[]): Upload[] => files.map((file) => () => uploadAttachment(docId, file));
    const upload = (files: Upload[], at: number) => {
      const spot: Tracked = { pos: at };
      tracked.add(spot);
      void (async () => {
        for (const send of files) {
          try {
            const att = await send();
            const v = editorView;
            if (!v || destroyed) return;
            const node = att.contentType.startsWith("image/")
              ? schema.nodes.image.create({ src: att.url, alt: null })
              : schema.nodes.attachment.create({ id: att.id, href: att.url, title: att.name, size: att.size, contentType: att.contentType || null });
            const tr = v.state.tr.insert(Math.min(spot.pos, v.state.doc.content.size), node);
            v.dispatch(tr);
            spot.pos = tr.mapping.map(spot.pos);
          } catch (e) {
            p().onError(e);
          }
        }
        tracked.delete(spot);
      })();
    };
    uploadRef.current = (files) => editorView && upload(files, editorView.state.selection.from);

    let headingTimer: ReturnType<typeof setTimeout> | undefined;
    const reportHeadings = (s: EditorState) => {
      clearTimeout(headingTimer);
      headingTimer = setTimeout(() => !destroyed && p().onHeadings(headingsOf(s)), 250);
    };

    void collab.ready.then(() => {
      if (destroyed || !mountRef.current) return;
      const unknown = unknownTypes(fragment, schema);
      if (unknown.length) {
        setBlocked(unknown);
        p().onStatus("unsupported", unknown.join(", "));
        provider.disconnect();
        return;
      }
      const t = p().t;
      const comment = (_s: EditorState, _d: unknown, v?: EditorView) => {
        const id = v && startComment(v, p().user.id);
        if (id) p().onStartComment(id);
        return !!id;
      };
      const editorState = EditorState.create({
        schema,
        plugins: [
          suggestPlugin(),
          ySyncPlugin(fragment),
          yCursorPlugin(provider.awareness),
          yUndoPlugin(),
          keymap({
            "Mod-Alt-m": comment,
            "Mod-Shift-m": comment,
            "Mod-k": (s) => {
              if (s.selection.empty) return false;
              window.dispatchEvent(new Event(LINK_EVENT));
              return true;
            },
            // In a link: opens it.
            "Mod-Enter": (s) => {
              const link = s.selection.empty && schema.marks.link.isInSet(s.selection.$from.marks());
              if (!link) return false;
              openLink(link.attrs.href);
              return true;
            },
          }),
          pasteMenuPlugin(),
          ...editorKeymaps(),
          mathPlugin,
          tableEditing(),
          highlightPlugin(),
          findPlugin(),
          mermaidEditingPlugin(),
          headingPrefixPlugin(p().headingPrefix),
          dropCursor({ color: "var(--primary)", width: 2 }),
          gapCursor(),
          placeholderPlugin(t("editorPlaceholder")),
        ],
      });
      editorView = new EditorView(mountRef.current, {
        state: editorState,
        editable: () => p().editable,
        nodeViews: nodeViews({ openLink, openDocument: (id) => p().onOpenDocument(id), foldedToggles: new Set(), embeds: p().embeds }),
        attributes: { class: "doc-content", spellcheck: String(p().spellcheck) },
        // `this`, not `editorView`: y-prosemirror dispatches while the view is still being constructed.
        dispatchTransaction(this: EditorView, tr) {
          const v = this;
          // Yjs can still deliver an update just after the editor was closed.
          if (v.isDestroyed) return;
          const next = v.state.apply(tr);
          v.updateState(next);
          for (const spot of tracked) spot.pos = tr.mapping.map(spot.pos);
          setState(next);
          if (tr.docChanged) reportHeadings(next);
        },
        handleDOMEvents: {
          click(v, event) {
            const marker = (event.target as HTMLElement).closest?.(".comment-marker:not(.draft)");
            if (marker && v.dom.contains(marker)) p().onCommentClick(marker.getAttribute("data-comment-id")!);
            const a = (event.target as HTMLElement).closest?.("a[href]");
            if (!a || !v.dom.contains(a)) return false;
            // Never let the webview navigate. Ctrl+click (or any click when read-only) opens it.
            event.preventDefault();
            if (event.ctrlKey || event.metaKey || !v.editable) openLink(a.getAttribute("href")!);
            return true;
          },
        },
        handlePaste(v, event) {
          if (!v.editable) return false;
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length) {
            upload(fromFiles(files), v.state.selection.from);
            return true;
          }
          const text = event.clipboardData?.getData("text/plain") ?? "";
          const html = event.clipboardData?.getData("text/html") ?? "";
          const { selection } = v.state;
          if (!text || selection.$from.parent.type.spec.code) return false;
          // A single URL: a link, a mention or an embed.
          if (pasteUrl(v, text, p().user.id)) return true;
          // Markdown, unless the clipboard also has rich content (a web page, another editor).
          // Code editors put their plain text in HTML too; that still counts as Markdown.
          const fromCodeEditor = /white-space:\s*pre/.test(html) && !html.includes("data-pm-slice");
          if ((!html || fromCodeEditor) && looksLikeMarkdown(text)) {
            const slice = markdownToSlice(text);
            if (slice) {
              v.dispatch(v.state.tr.replaceSelection(slice).scrollIntoView());
              return true;
            }
          }
          return false;
        },
        handleDrop(v, event) {
          const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
          if (!files.length || !v.editable) return false;
          const at = v.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos ?? v.state.selection.from;
          upload(fromFiles(files), at);
          return true;
        },
      });
      viewRef.current = editorView;
      if (import.meta.env.DEV) (window as unknown as { __view: EditorView }).__view = editorView;
      setView(editorView);
      setState(editorView.state);
      // y-prosemirror fills the document right after the view is created.
      setTimeout(() => editorView && !destroyed && p().onHeadings(headingsOf(editorView.state)), 50);
    });

    return () => {
      destroyed = true;
      clearTimeout(headingTimer);
      provider.off("awarenessChange", onAwareness);
      editorView?.destroy();
      viewRef.current = null;
      setView(null);
      setState(null);
      setBlocked(null);
      collab.destroy();
    };
  }, [docId, viewRef]);

  useEffect(() => {
    if (view) setHeadingPrefix(view, props.headingPrefix);
  }, [view, props.headingPrefix]);

  // Editable and spellcheck can change without recreating the editor.
  useEffect(() => {
    if (!view) return;
    view.setProps({ attributes: { class: "doc-content", spellcheck: String(props.spellcheck) } });
  }, [view, props.spellcheck, props.editable]);

  /** Clicking the empty space under the document puts the cursor at its end. */
  const onTailClick = () => {
    if (!view || !view.editable) return;
    const { doc } = view.state;
    const last = doc.lastChild;
    let tr = view.state.tr;
    if (!last || last.type !== schema.nodes.paragraph || last.content.size > 0) tr = tr.insert(doc.content.size, schema.nodes.paragraph.create());
    view.dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView());
    view.focus();
  };

  if (blocked)
    return (
      <div className="editor-blocked">
        <p>{props.t("unsupportedContent", { types: blocked.join(", ") })}</p>
        <button className="text-button" onClick={() => void openExternal(webUrl(`/doc/${docId}`))}>
          {props.t("openInBrowser")}
        </button>
      </div>
    );

  return (
    <>
      <div ref={mountRef} className={`editor${view ? "" : " loading"}`} />
      {view && <div className="editor-tail" onMouseDown={(e) => (e.preventDefault(), onTailClick())} />}
      {view && state && (
        <>
          <SuggestMenu
            view={view}
            state={state}
            t={props.t}
            self={props.user}
            pickFile={(images) => {
              if (isTauri) {
                // The system dialog: the webview's own picker can open out of sight on desktop.
                pickFiles(images)
                  .then((paths) => uploadRef.current(paths.map((path) => () => uploadAttachmentFromPath(docId, path))))
                  .catch(props.onError);
              } else if (fileInput.current) {
                fileInput.current.accept = images ? "image/*" : "";
                fileInput.current.click();
              }
            }}
          />
          <PasteMenu view={view} state={state} t={props.t} />
          <BlockHandle view={view} state={state} t={props.t} docUrl={props.docUrl} />
          <BubbleMenu
            view={view}
            state={state}
            t={props.t}
            onComment={() => {
              const id = startComment(view, props.user.id);
              if (id) props.onStartComment(id);
            }}
            openLink={(href) => {
              const id = docIdFromHref(href);
              if (id) props.onOpenDocument(id);
              else void openExternal(href.startsWith("/") ? webUrl(href) : href);
            }}
          />
        </>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) uploadRef.current(files.map((file) => () => uploadAttachment(docId, file)));
        }}
      />
    </>
  );
}
