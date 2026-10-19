// An editor for content saved through the API rather than shared live, like a collection's
// overview page. Same schema, blocks, menus and Markdown shortcuts as documents.

import { useEffect, useRef, useState } from "react";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Node } from "prosemirror-model";
import { history } from "prosemirror-history";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { tableEditing } from "prosemirror-tables";
import { mathPlugin } from "@benrbray/prosemirror-math";
import type { RichText, User } from "../lib/api";
import { docIdFromHref, webUrl } from "../lib/api";
import type { Translate } from "../lib/i18n";
import { openExternal } from "../lib/platform";
import { placeholderPlugin } from "./Editor";
import { highlightPlugin } from "./highlight";
import { mermaidEditingPlugin } from "./mermaid";
import { looksLikeMarkdown, markdownToSlice } from "./markdown";
import { BubbleMenu, PasteMenu, SuggestMenu } from "./menus";
import { pasteMenuPlugin, pasteUrl } from "./paste";
import { BlockHandle } from "./blockHandle";
import { nodeViews } from "./nodeviews";
import { editorKeymaps } from "./rules";
import { schema } from "./schema";
import { suggestPlugin } from "./suggest";

/** A document from stored JSON, or from Markdown (older collections only have a description). */
export function docFrom(data: RichText | null | undefined, markdown?: string | null): Node {
  if (data?.type === "doc" && data.content?.length) {
    try {
      const node = Node.fromJSON(schema, data);
      node.check();
      return node;
    } catch {
      // Fall back to the Markdown below.
    }
  }
  const slice = markdown ? markdownToSlice(markdown) : null;
  if (slice) return schema.nodes.doc.create(null, slice.content);
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create());
}

interface Props {
  doc: Node;
  editable: boolean;
  placeholder: string;
  t: Translate;
  user: User;
  onChange: (json: RichText, doc: Node) => void;
  onOpenDocument: (id: string) => void;
}

export function StaticEditor(props: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!mount.current) return;
    const p = () => propsRef.current;
    const openLink = (href: string) => {
      const id = docIdFromHref(href);
      if (id) p().onOpenDocument(id);
      else void openExternal(href.startsWith("/") ? webUrl(href) : href);
    };
    const v = new EditorView(mount.current, {
      state: EditorState.create({
        doc: p().doc,
        plugins: [
          suggestPlugin(),
          pasteMenuPlugin(),
          history(),
          ...editorKeymaps(false),
          mathPlugin,
          tableEditing(),
          highlightPlugin(),
          mermaidEditingPlugin(),
          dropCursor({ color: "var(--primary)", width: 2 }),
          gapCursor(),
          placeholderPlugin(p().placeholder),
        ],
      }),
      editable: () => p().editable,
      nodeViews: nodeViews({ openLink, openDocument: (id) => p().onOpenDocument(id), foldedToggles: new Set(), embeds: true }),
      attributes: { class: "doc-content" },
      dispatchTransaction(this: EditorView, tr) {
        const next = this.state.apply(tr);
        this.updateState(next);
        setState(next);
        if (tr.docChanged) p().onChange(next.doc.toJSON() as RichText, next.doc);
      },
      handleDOMEvents: {
        click(v, event) {
          const a = (event.target as HTMLElement).closest?.("a[href]");
          if (!a || !v.dom.contains(a)) return false;
          event.preventDefault();
          if (event.ctrlKey || event.metaKey || !v.editable) openLink(a.getAttribute("href")!);
          return true;
        },
      },
      handlePaste(v, event) {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const html = event.clipboardData?.getData("text/html") ?? "";
        if (text && !v.state.selection.$from.parent.type.spec.code && pasteUrl(v, text, p().user.id)) return true;
        if (!text || html || v.state.selection.$from.parent.type.spec.code || !looksLikeMarkdown(text)) return false;
        const slice = markdownToSlice(text);
        if (!slice) return false;
        v.dispatch(v.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
    });
    setView(v);
    setState(v.state);
    return () => {
      v.destroy();
      setView(null);
    };
    // The document is only read on mount; the parent remounts with a key to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view?.setProps({});
  }, [view, props.editable]);

  return (
    <>
      <div ref={mount} className="editor" />
      {view && state && (
        <>
          <SuggestMenu view={view} state={state} t={props.t} self={props.user} pickFile={() => {}} uploads={false} />
          <PasteMenu view={view} state={state} t={props.t} />
          <BlockHandle view={view} state={state} t={props.t} />
          <BubbleMenu view={view} state={state} t={props.t} openLink={(href) => (docIdFromHref(href) ? props.onOpenDocument(docIdFromHref(href)!) : void openExternal(href))} />
        </>
      )}
    </>
  );
}
